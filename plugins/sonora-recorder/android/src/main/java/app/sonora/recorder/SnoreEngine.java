package app.sonora.recorder;

import java.util.ArrayList;
import java.util.List;

/**
 * Streaming snore detector on 16 kHz mono audio. Same pipeline and constants as
 * SnoreEngine.swift, web/analyzer.js and nightsound/analysis.py: loudness
 * envelope -> adaptive noise floor -> events -> spectral features -> snore
 * probability. Pure Java (no Android imports) so it can be tested on a desktop
 * JVM. Not thread-safe; feed it from one thread.
 */
public final class SnoreEngine {
    public static final int SAMPLE_RATE = 16000;
    public static final double FRAME_S = 0.05;
    public static final int HOP = 800; // 50 ms

    static final double ABS_FLOOR_DBFS = -55.0;
    static final double NOISE_PCTL = 0.20;
    static final double MIN_EVENT_S = 0.20;
    static final double MERGE_GAP_S = 0.35;
    static final double MAX_EVENT_S = 8.0;
    static final int PREROLL = SAMPLE_RATE / 2; // 0.5 s
    static final int NOISE_WINDOW = (int) Math.round(90.0 / FRAME_S);

    /** One detected sound event; field names match web/analyzer.js. */
    public static final class Event {
        public double startS, endS, durationS, peakDbfs;
        public double centroid, lowRatio, flatness, f0, harmonicity, snoreProb;
        public boolean isSnore;
        public String intensity = "quiet";
        public String clip;
    }

    public static final class Summary {
        public int snoreEvents, episodes, weirdSounds;
        public double snoreTimeS, snorePercent, snoresPerHour, snoreScore;
    }

    public interface Listener {
        /** A finished event and its clip samples (pre-roll + event). */
        void onEvent(Event event, float[] clip);
    }

    public double snoreThreshold = 0.5;
    public double threshOverFloorDb = 9.0;

    private Listener listener;
    private double noiseFloor = -50.0;
    private double lastDb = -120.0;
    private double secondMax = -120.0;
    private int frameIndex = 0;
    private final FloatList envelope = new FloatList();

    private final float[] frame = new float[HOP];
    private int frameFill = 0;

    private final double[] recent = new double[NOISE_WINDOW];
    private int recentCount = 0, recentPos = 0;

    private boolean inEvent = false;
    private int evStartFrame, evLastAbove;
    private double evPeakDb;
    private final FloatList evSamples = new FloatList();
    private float[] evPreroll = new float[0];

    private final float[] preroll = new float[PREROLL];
    private int prerollFill = 0, prerollPos = 0;

    public void setListener(Listener l) { listener = l; }
    public double noiseFloor() { return noiseFloor; }
    public double lastDb() { return lastDb; }
    public double threshold() { return Math.max(noiseFloor + threshOverFloorDb, ABS_FLOOR_DBFS); }
    public double elapsedS() { return frameIndex * FRAME_S; }
    /** Loudest frame of each second so far, dBFS. */
    public float[] envelope() { return envelope.toArray(); }

    public void process(float[] samples, int count) {
        for (int i = 0; i < count; i++) {
            frame[frameFill++] = samples[i];
            if (frameFill == HOP) {
                processFrame();
                frameFill = 0;
            }
        }
    }

    public void flush() {
        if (inEvent) finishEvent(evLastAbove + 1);
    }

    private void processFrame() {
        double sum = 0;
        for (float v : frame) sum += (double) v * v;
        double db = 10.0 * Math.log10(sum / HOP + 1e-20); // == 20*log10(rms)
        lastDb = db;
        updateNoiseFloor(db);

        secondMax = Math.max(secondMax, db);
        if ((frameIndex + 1) % 20 == 0) {
            envelope.add((float) secondMax);
            secondMax = -120;
        }

        if (db >= threshold()) {
            if (!inEvent) {
                inEvent = true;
                evStartFrame = frameIndex;
                evPeakDb = db;
                evSamples.clear();
                evPreroll = prerollSnapshot();
            }
            evLastAbove = frameIndex;
            evPeakDb = Math.max(evPeakDb, db);
            evSamples.addAll(frame, HOP);
            if ((frameIndex + 1 - evStartFrame) * FRAME_S >= MAX_EVENT_S) {
                finishEvent(frameIndex + 1); // split very long runs
            }
        } else if (inEvent) {
            evSamples.addAll(frame, HOP);
            if ((frameIndex - evLastAbove) * FRAME_S > MERGE_GAP_S) {
                finishEvent(evLastAbove + 1);
            }
        }

        for (float v : frame) {
            preroll[prerollPos] = v;
            prerollPos = (prerollPos + 1) % PREROLL;
        }
        prerollFill = Math.min(PREROLL, prerollFill + HOP);
        frameIndex++;
    }

    private float[] prerollSnapshot() {
        float[] out = new float[prerollFill];
        int start = (prerollPos - prerollFill + PREROLL) % PREROLL;
        for (int i = 0; i < prerollFill; i++) out[i] = preroll[(start + i) % PREROLL];
        return out;
    }

    private void updateNoiseFloor(double db) {
        recent[recentPos] = db;
        recentPos = (recentPos + 1) % NOISE_WINDOW;
        recentCount = Math.min(NOISE_WINDOW, recentCount + 1);
        if (recentCount >= 20 && frameIndex % 20 == 0) {
            double[] sorted = java.util.Arrays.copyOf(recent, recentCount);
            java.util.Arrays.sort(sorted);
            noiseFloor = sorted[(int) ((sorted.length - 1) * NOISE_PCTL)];
        }
    }

    private void finishEvent(int endFrame) {
        inEvent = false;
        int frames = endFrame - evStartFrame;
        double durationS = frames * FRAME_S;
        if (durationS < MIN_EVENT_S) return;
        float[] x = evSamples.toArray(Math.min(frames * HOP, evSamples.size()));

        Event ev = new Event();
        ev.startS = evStartFrame * FRAME_S;
        ev.endS = endFrame * FRAME_S;
        ev.durationS = durationS;
        ev.peakDbfs = evPeakDb;
        spectralFeatures(x, ev);
        ev.snoreProb = snoreProbability(ev);
        ev.isSnore = ev.snoreProb >= snoreThreshold;
        ev.intensity = intensity(evPeakDb, noiseFloor);

        if (listener != null) {
            float[] clip = new float[evPreroll.length + x.length];
            System.arraycopy(evPreroll, 0, clip, 0, evPreroll.length);
            System.arraycopy(x, 0, clip, evPreroll.length, x.length);
            listener.onEvent(ev, clip);
        }
    }

    // ------------------------------------------------------------ features

    /** Averaged 512-point Hann power spectrum (50% overlap) + autocorrelation f0. */
    static void spectralFeatures(float[] x, Event ev) {
        final int n = 512, half = 256;
        double[] window = new double[n];
        for (int i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
        double[] power = new double[half];
        double[] re = new double[n], im = new double[n];
        int frames = 0;
        for (int start = 0; start < Math.max(x.length - half, 1); start += half) {
            for (int i = 0; i < n; i++) {
                int j = start + i;
                re[i] = j < x.length ? x[j] * window[i] : 0;
                im[i] = 0;
            }
            fft(re, im);
            for (int k = 0; k < half; k++) power[k] += re[k] * re[k] + im[k] * im[k];
            frames++;
        }

        double band = 1e-12, low = 0, cen = 0, logSum = 0, count = 0;
        for (int k = 0; k < half; k++) {
            double hz = (double) k * SAMPLE_RATE / n;
            if (hz < 30 || hz > 4000) continue;
            double p = power[k] / Math.max(frames, 1);
            band += p;
            cen += hz * p;
            logSum += Math.log(p + 1e-20);
            count++;
            if (hz <= 600) low += p;
        }
        ev.centroid = cen / band;
        ev.lowRatio = low / band;
        ev.flatness = count > 0 ? Math.exp(logSum / count) / (band / count) : 1;

        double[] f0h = estimateF0(x);
        ev.f0 = f0h[0];
        ev.harmonicity = f0h[1];
    }

    /** In-place iterative radix-2 FFT; n must be a power of two. */
    static void fft(double[] re, double[] im) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                double t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
            for (int i = 0; i < n; i += len) {
                double cr = 1, ci = 0;
                for (int k = 0; k < len / 2; k++) {
                    int a = i + k, b = a + len / 2;
                    double xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                    double ncr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = ncr;
                }
            }
        }
    }

    /** {f0 Hz (0 if none), harmonicity 0..1} over 40–400 Hz, at most 1 s of the event. */
    static double[] estimateF0(float[] x) {
        if (x.length < SAMPLE_RATE / 20) return new double[] {0, 0};
        int start = Math.max(0, (x.length - SAMPLE_RATE) / 2);
        int len = Math.min(x.length - start, SAMPLE_RATE);
        double mean = 0;
        for (int i = 0; i < len; i++) mean += x[start + i];
        mean /= len;
        double[] seg = new double[len];
        for (int i = 0; i < len; i++) seg[i] = x[start + i] - mean;

        double ac0 = 0;
        for (double v : seg) ac0 += v * v;
        int lo = SAMPLE_RATE / 400, hi = Math.min(SAMPLE_RATE / 40, len - 1);
        if (ac0 <= 0 || hi <= lo) return new double[] {0, 0};

        double best = Double.NEGATIVE_INFINITY;
        int bestLag = 0;
        for (int lag = lo; lag <= hi; lag++) {
            double s = 0;
            for (int i = 0; i + lag < len; i++) s += seg[i] * seg[i + lag];
            if (s > best) { best = s; bestLag = lag; }
        }
        double h = Math.max(0, Math.min(1, best / ac0));
        double f0 = bestLag > 0 ? (double) SAMPLE_RATE / bestLag : 0;
        return new double[] {h > 0.15 ? f0 : 0, h};
    }

    // ------------------------------------------------------------ scoring (keep in step with analyzer.js)

    static double clamp(double v) { return Math.max(0, Math.min(1, v)); }

    public static double snoreProbability(Event e) {
        double s = 0;
        s += 0.32 * clamp((e.lowRatio - 0.45) / 0.45);
        s += 0.22 * clamp((900 - e.centroid) / 700);
        s += 0.18 * clamp((0.55 - e.flatness) / 0.45);
        s += 0.16 * clamp((e.harmonicity - 0.2) / 0.5);
        double d = e.durationS;
        s += 0.12 * ((d >= 0.3 && d <= 3.0) ? 1 : Math.max(0, 1 - Math.abs(d - 1.5) / 3.0));
        return clamp(s);
    }

    public static String intensity(double peak, double floor) {
        double over = peak - floor;
        if (over < 10) return "quiet";
        if (over < 20) return "light";
        if (over < 30) return "loud";
        return "epic";
    }

    /** A snore candidate outside any rhythmic run needs at least this probability. */
    public static final double LONE_SNORE_MIN = 0.65;

    /** Marks snore candidates in rhythmic runs (>= 3 at breathing rate); returns the run count. */
    static int markEpisodes(List<Event> events, boolean[] inEpisode) {
        int episodes = 0;
        List<Integer> run = new ArrayList<>();
        for (int i = 0; i <= events.size(); i++) {
            boolean end = i == events.size();
            if (!end && !events.get(i).isSnore) continue;
            boolean continues = !end && !run.isEmpty() && inBreathRange(
                    events.get(i).startS - events.get(run.get(run.size() - 1)).startS);
            if (!continues) {
                if (run.size() >= 3) {
                    episodes++;
                    for (int j : run) inEpisode[j] = true;
                }
                run.clear();
            }
            if (!end) run.add(i);
        }
        return episodes;
    }

    private static boolean inBreathRange(double gapS) { return gapS >= 1.5 && gapS <= 6.0; }

    public static Summary summarize(List<Event> events, double durationS) {
        Summary s = new Summary();
        boolean[] inEpisode = new boolean[events.size()];
        s.episodes = markEpisodes(events, inEpisode);
        List<Event> snores = new ArrayList<>();
        for (int i = 0; i < events.size(); i++) {
            Event e = events.get(i);
            boolean confirmed = e.isSnore && (inEpisode[i] || e.snoreProb >= LONE_SNORE_MIN);
            if (confirmed) snores.add(e);
            else if (e.intensity.equals("loud") || e.intensity.equals("epic")) s.weirdSounds++;
        }
        int loud = 0, epic = 0;
        for (Event e : snores) {
            s.snoreTimeS += e.durationS;
            if (e.intensity.equals("loud")) loud++;
            if (e.intensity.equals("epic")) epic++;
        }
        s.snoreEvents = snores.size();
        s.snorePercent = durationS > 0 ? 100 * s.snoreTimeS / durationS : 0;
        s.snoresPerHour = durationS > 0 ? snores.size() / (durationS / 3600) : 0;
        double loudFrac = snores.isEmpty() ? 0 : (0.5 * loud + epic) / snores.size();
        s.snoreScore = 100 * (0.65 * Math.min(s.snorePercent, 60) / 60 + 0.35 * loudFrac);
        return s;
    }

    /** 16-bit PCM mono WAV. */
    public static byte[] wav(float[] samples) {
        int dataBytes = samples.length * 2;
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(44 + dataBytes)
                .order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.put(new byte[] {'R', 'I', 'F', 'F'}).putInt(36 + dataBytes).put(new byte[] {'W', 'A', 'V', 'E'});
        b.put(new byte[] {'f', 'm', 't', ' '}).putInt(16).putShort((short) 1).putShort((short) 1);
        b.putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort((short) 2).putShort((short) 16);
        b.put(new byte[] {'d', 'a', 't', 'a'}).putInt(dataBytes);
        for (float v : samples) b.putShort((short) (Math.max(-1f, Math.min(1f, v)) * 32767));
        return b.array();
    }

    /** Minimal growable float array. */
    static final class FloatList {
        private float[] data = new float[1024];
        private int size = 0;

        void add(float v) { ensure(size + 1); data[size++] = v; }
        void addAll(float[] src, int n) { ensure(size + n); System.arraycopy(src, 0, data, size, n); size += n; }
        void clear() { size = 0; }
        int size() { return size; }
        float[] toArray() { return toArray(size); }
        float[] toArray(int n) { return java.util.Arrays.copyOf(data, n); }

        private void ensure(int cap) {
            if (cap > data.length) data = java.util.Arrays.copyOf(data, Math.max(cap, data.length * 2));
        }
    }
}
