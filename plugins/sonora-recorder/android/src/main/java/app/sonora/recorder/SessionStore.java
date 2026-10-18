package app.sonora.recorder;

import android.content.Context;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One night's files under files/Sonora/sessions/&lt;id&gt;/: session.json (same
 * shape as the iOS plugin writes), clips/*.wav, and nothing else.
 */
final class SessionStore {
    static final int MAX_SNORE_CLIPS = 60;

    final String id;
    final File dir;
    final String startedAt;
    final String sensitivity;
    private final boolean keepClips;
    private final List<SnoreEngine.Event> events = new ArrayList<>();
    private final List<Integer> snoreClipIndexes = new ArrayList<>();
    private int clipCounter = 0;

    SessionStore(Context context, String id, String sensitivity, boolean keepClips) {
        this.id = id;
        this.dir = new File(root(context), id);
        this.startedAt = iso(new Date());
        this.sensitivity = sensitivity;
        this.keepClips = keepClips;
        new File(dir, "clips").mkdirs();
    }

    static File root(Context context) {
        return new File(context.getFilesDir(), "Sonora/sessions");
    }

    static String newId() {
        return new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
    }

    static String iso(Date d) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(d);
    }

    synchronized int eventCount() { return events.size(); }

    /** Store an event; keeps clips for notable sounds and the loudest snores. Returns its JSON. */
    synchronized JSONObject add(SnoreEngine.Event ev, float[] clip) throws JSONException {
        boolean worthAClip = ev.isSnore || !ev.intensity.equals("quiet");
        if (keepClips && worthAClip) {
            String name = String.format(Locale.US, "clips/clip-%05d.wav", clipCounter++);
            try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
                out.write(SnoreEngine.wav(clip));
                ev.clip = name;
            } catch (Exception ignored) {
                // A clip we can't write is not worth losing the event over.
            }
        }
        events.add(ev);
        int index = events.size() - 1;

        if (ev.isSnore && ev.clip != null) {
            snoreClipIndexes.add(index);
            if (snoreClipIndexes.size() > MAX_SNORE_CLIPS) {
                int quietest = 0;
                for (int i = 1; i < snoreClipIndexes.size(); i++) {
                    if (events.get(snoreClipIndexes.get(i)).peakDbfs
                            < events.get(snoreClipIndexes.get(quietest)).peakDbfs) quietest = i;
                }
                SnoreEngine.Event drop = events.get(snoreClipIndexes.remove(quietest));
                new File(dir, drop.clip).delete();
                drop.clip = null;
            }
        }
        return eventJSON(ev);
    }

    /** Write session.json atomically. Call from the audio thread (owns the engine). */
    synchronized void save(double durationS, double noiseFloor, float[] envelope, String endedAt)
            throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", id);
        o.put("startedAt", startedAt);
        o.put("endedAt", endedAt == null ? JSONObject.NULL : endedAt);
        o.put("durationS", durationS);
        o.put("noiseFloorDbfs", finite(noiseFloor));
        o.put("sensitivity", sensitivity);
        o.put("fullRecording", JSONObject.NULL);
        JSONArray env = new JSONArray();
        for (float v : envelope) env.put(finite(v));
        o.put("envelope", env);
        JSONArray evs = new JSONArray();
        for (SnoreEngine.Event e : events) evs.put(eventJSON(e));
        o.put("events", evs);
        o.put("summary", summaryJSON(SnoreEngine.summarize(events, durationS)));

        File tmp = new File(dir, "session.json.tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(o.toString().getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(new File(dir, "session.json"))) throw new IllegalStateException("rename failed");
    }

    // ------------------------------------------------------------ stored sessions

    static JSONObject load(Context context, String id) throws Exception {
        File f = new File(new File(root(context), id), "session.json");
        byte[] data = new byte[(int) f.length()];
        try (FileInputStream in = new FileInputStream(f)) {
            int off = 0;
            while (off < data.length) {
                int n = in.read(data, off, data.length - off);
                if (n < 0) break;
                off += n;
            }
        }
        return new JSONObject(new String(data, StandardCharsets.UTF_8));
    }

    static JSONArray list(Context context) {
        JSONArray out = new JSONArray();
        String[] ids = root(context).list();
        if (ids == null) return out;
        Arrays.sort(ids, (a, b) -> b.compareTo(a));
        for (String id : ids) {
            try {
                JSONObject s = load(context, id);
                JSONObject o = new JSONObject(s.getJSONObject("summary").toString());
                o.put("id", id);
                o.put("startedAt", s.getString("startedAt"));
                o.put("endedAt", s.opt("endedAt"));
                o.put("durationS", s.getDouble("durationS"));
                o.put("eventCount", s.getJSONArray("events").length());
                out.put(o);
            } catch (Exception ignored) {
                // Skip unreadable folders rather than failing the whole list.
            }
        }
        return out;
    }

    static boolean delete(Context context, String id) {
        return deleteTree(new File(root(context), id));
    }

    private static boolean deleteTree(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        return f.delete();
    }

    // ------------------------------------------------------------ JSON

    static JSONObject eventJSON(SnoreEngine.Event e) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("startS", e.startS);
        o.put("endS", e.endS);
        o.put("durationS", e.durationS);
        o.put("peakDbfs", finite(e.peakDbfs));
        o.put("centroid", finite(e.centroid));
        o.put("lowRatio", finite(e.lowRatio));
        o.put("flatness", finite(e.flatness));
        o.put("f0", finite(e.f0));
        o.put("harmonicity", finite(e.harmonicity));
        o.put("snoreProb", finite(e.snoreProb));
        o.put("isSnore", e.isSnore);
        o.put("intensity", e.intensity);
        if (e.clip != null) o.put("clip", e.clip);
        return o;
    }

    static JSONObject summaryJSON(SnoreEngine.Summary s) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("snoreEvents", s.snoreEvents);
        o.put("snoreTimeS", s.snoreTimeS);
        o.put("snorePercent", s.snorePercent);
        o.put("snoresPerHour", s.snoresPerHour);
        o.put("snoreScore", s.snoreScore);
        o.put("episodes", s.episodes);
        o.put("weirdSounds", s.weirdSounds);
        return o;
    }

    private static double finite(double v) {
        return Double.isFinite(v) ? v : -120.0;
    }
}
