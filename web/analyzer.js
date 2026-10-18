// analyzer.js — the detection + classification + scoring engine.
//
// This is the Python engine (nightsound/analysis.py) ported to run live on
// Web Audio frames. Same idea: a loudness envelope with an adaptive noise
// floor finds events; spectral shape + breathing rhythm decide which events
// are snores; aggregates become a score.

export const CFG = {
  frameS: 0.05,              // analysis cadence (50 ms)
  noisePctl: 20,            // percentile of recent loudness = noise floor
  threshOverFloorDb: 9.0,   // event must rise this far above the floor
  absFloorDbfs: -55.0,
  minEventS: 0.20,
  mergeGapS: 0.35,
  breathMinS: 1.5,
  breathMaxS: 6.0,
  loneSnoreMin: 0.65,       // a lone (non-rhythmic) snore candidate needs this probability
  noiseWindowS: 90,         // how much recent audio informs the noise floor
};

// Same presets as the native plugins (start({ sensitivity })).
export const SENSITIVITY = {
  low:    { threshOverFloorDb: 12, snoreThreshold: 0.6 },
  normal: { threshOverFloorDb: 9,  snoreThreshold: 0.5 },
  high:   { threshOverFloorDb: 6,  snoreThreshold: 0.4 },
};

const EPS = 1e-10;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function percentile(arr, p) {
  if (!arr.length) return -50;
  const a = Float64Array.from(arr).sort();
  const idx = clamp((p / 100) * (a.length - 1), 0, a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

function intensityOf(peakDb, floorDb) {
  const over = peakDb - floorDb;
  if (over < 10) return "quiet";
  if (over < 20) return "light";
  if (over < 30) return "loud";
  return "epic";
}

// Fundamental via autocorrelation of the event PCM, restricted to 40–400 Hz.
function estimateF0(pcm, sr) {
  if (!pcm || pcm.length < sr / 20) return [0, 0];
  let mean = 0;
  for (let i = 0; i < pcm.length; i++) mean += pcm[i];
  mean /= pcm.length;
  const x = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) x[i] = pcm[i] - mean;

  const loLag = Math.floor(sr / 400);
  const hiLag = Math.min(Math.floor(sr / 40), x.length - 1);
  if (hiLag <= loLag) return [0, 0];

  let ac0 = 0;
  for (let i = 0; i < x.length; i++) ac0 += x[i] * x[i];
  ac0 += EPS;

  let bestLag = 0, bestVal = -Infinity;
  for (let lag = loLag; lag <= hiLag; lag++) {
    let s = 0;
    for (let i = 0; i < x.length - lag; i++) s += x[i] * x[i + lag];
    if (s > bestVal) { bestVal = s; bestLag = lag; }
  }
  const harmonicity = clamp(bestVal / ac0, 0, 1);
  const f0 = bestLag ? sr / bestLag : 0;
  return [harmonicity > 0.15 ? f0 : 0, harmonicity];
}

function snoreProbability(ev) {
  let s = 0;
  s += 0.32 * clamp((ev.lowRatio - 0.45) / 0.45, 0, 1);
  s += 0.22 * clamp((900 - ev.centroid) / 700, 0, 1);
  s += 0.18 * clamp((0.55 - ev.flatness) / 0.45, 0, 1);
  s += 0.16 * clamp((ev.harmonicity - 0.2) / 0.5, 0, 1);
  const d = ev.endS - ev.startS;
  const dScore = d >= 0.3 && d <= 3.0 ? 1 : Math.max(0, 1 - Math.abs(d - 1.5) / 3.0);
  s += 0.12 * dScore;
  return clamp(s, 0, 1);
}

export class SnoreAnalyzer {
  constructor({ sampleRate, fftSize, recorder, sensitivity = "normal", onEvent = null }) {
    const s = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
    this.threshOverFloorDb = s.threshOverFloorDb;
    const snoreThreshold = s.snoreThreshold;
    this.sr = sampleRate;
    this.fftSize = fftSize;
    this.recorder = recorder;
    this.snoreThreshold = snoreThreshold;
    this.onEvent = onEvent;

    this.freqs = new Float32Array(fftSize / 2);
    for (let i = 0; i < this.freqs.length; i++) this.freqs[i] = (i * sampleRate) / fftSize;

    this.recentDb = [];            // rolling loudness for the noise floor
    this.noiseFloor = -50;
    this.envelope = [];            // {t, db} decimated for the timeline
    this.events = [];
    this.startTime = null;         // ctx seconds at record start

    this._ev = null;               // in-progress event accumulator
  }

  _updateNoiseFloor(db) {
    this.recentDb.push(db);
    const maxLen = Math.ceil(CFG.noiseWindowS / CFG.frameS);
    if (this.recentDb.length > maxLen) this.recentDb.shift();
    if (this.recentDb.length >= 20) {
      this.noiseFloor = percentile(this.recentDb, CFG.noisePctl);
    }
  }

  get threshold() {
    return Math.max(this.noiseFloor + this.threshOverFloorDb, CFG.absFloorDbfs);
  }

  // Called ~every frameS seconds with the current time-domain + frequency data.
  pushFrame(tSec, timeData, freqDb) {
    if (this.startTime === null) this.startTime = tSec;
    const t = tSec - this.startTime;

    // loudness
    let sq = 0;
    for (let i = 0; i < timeData.length; i++) sq += timeData[i] * timeData[i];
    const rms = Math.sqrt(sq / timeData.length);
    const db = 20 * Math.log10(rms + EPS);

    this._updateNoiseFloor(db);
    this.envelope.push({ t, db });

    // linear power spectrum for this frame
    const power = new Float32Array(freqDb.length);
    for (let i = 0; i < freqDb.length; i++) power[i] = Math.pow(10, freqDb[i] / 10);

    const above = db >= this.threshold;
    if (above) {
      if (!this._ev) {
        this._ev = { startS: t, lastAboveS: t, peakDb: db, sumPower: new Float32Array(power.length), frames: 0 };
      }
      this._ev.lastAboveS = t;
      this._ev.peakDb = Math.max(this._ev.peakDb, db);
      const sp = this._ev.sumPower;
      for (let i = 0; i < power.length; i++) sp[i] += power[i];
      this._ev.frames++;
    } else if (this._ev && (t - this._ev.lastAboveS) > CFG.mergeGapS) {
      this._finalizeEvent(this._ev.lastAboveS);
    }
    return { t, db, floor: this.noiseFloor, threshold: this.threshold };
  }

  flush(tSec) {
    if (this._ev) this._finalizeEvent(tSec - this.startTime);
  }

  _finalizeEvent(endS) {
    const e0 = this._ev;
    this._ev = null;
    const startS = e0.startS, dur = endS - startS;
    if (dur < CFG.minEventS || e0.frames === 0) return;

    const avg = new Float32Array(e0.sumPower.length);
    for (let i = 0; i < avg.length; i++) avg[i] = e0.sumPower[i] / e0.frames;

    let total = EPS, low = 0, band = EPS, cen = 0, logsum = 0, bandCount = 0;
    for (let i = 0; i < avg.length; i++) {
      const f = this.freqs[i], p = avg[i];
      if (f >= 30 && f <= 4000) {
        band += p; cen += f * p; logsum += Math.log(p + EPS); bandCount++;
        if (f <= 600) low += p;
      }
      total += p;
    }
    const centroid = cen / band;
    const lowRatio = low / band;
    const flatness = bandCount ? Math.exp(logsum / bandCount) / (band / bandCount + EPS) : 1;

    const pcm = this.recorder
      // the ring buffer counts samples from the AudioContext's start; event
      // times count from the first analysed frame (later, with a start delay)
      ? this.recorder.extract(Math.round((this.startTime + startS) * this.sr),
                              Math.round((this.startTime + endS) * this.sr))
      : null;
    const [f0, harmonicity] = estimateF0(pcm, this.sr);

    const ev = {
      startS, endS, durationS: dur,
      peakDbfs: e0.peakDb,
      centroid, lowRatio, flatness, f0, harmonicity,
    };
    ev.snoreProb = snoreProbability(ev);
    ev.isSnore = ev.snoreProb >= this.snoreThreshold;
    ev.label = ev.isSnore ? "snore" : "other";
    ev.intensity = intensityOf(ev.peakDbfs, this.noiseFloor);

    if (pcm) ev.clip = pcm;   // kept for on-demand WAV encoding; trimmed below
    this.events.push(ev);
    this._trimClips();
    if (this.onEvent) this.onEvent(ev, this);
  }

  // Keep raw clips only for the most recent events, to bound memory.
  _trimClips(keep = 40) {
    const withClips = this.events.filter((e) => e.clip);
    for (let i = 0; i < withClips.length - keep; i++) delete withClips[i].clip;
  }

  episodes() {
    return episodesOf(this.events);
  }

  report(nowSec) {
    const duration = this.startTime === null ? 0 : nowSec - this.startTime;
    return computeReport({ events: this.events, durationS: duration, noiseFloorDbfs: this.noiseFloor });
  }
}

// Rhythmic snoring runs: >= 3 snore candidates spaced at breathing rate.
// Marks e.inEpisode on their members.
export function episodesOf(events) {
  events.forEach((e) => (e.inEpisode = false));
  const snores = events.filter((e) => e.isSnore);
  const eps = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) {
      const iv = [];
      for (let i = 1; i < run.length; i++) iv.push(run[i].startS - run[i - 1].startS);
      run.forEach((e) => (e.inEpisode = true));
      eps.push({
        startS: run[0].startS, endS: run[run.length - 1].endS,
        snores: run.length,
        meanIntervalS: iv.reduce((a, b) => a + b, 0) / iv.length,
      });
    }
    run = [];
  };
  for (const e of snores) {
    if (!run.length) { run.push(e); continue; }
    const gap = e.startS - run[run.length - 1].startS;
    if (gap >= CFG.breathMinS && gap <= CFG.breathMaxS) run.push(e);
    else { flush(); run.push(e); }
  }
  flush();
  return eps;
}

// Session aggregates from a list of events. Used for live web sessions and
// for sessions recorded by the native plugin.
//
// `isSnore` on an event is the engine's per-sound verdict. A snore-like sound
// outside any rhythmic run (a thud, a cough) must also reach LONE_SNORE_MIN;
// the final verdict lands on e.confirmedSnore, which the UI shows.
export function computeReport({ events, durationS, noiseFloorDbfs }) {
  const duration = durationS || 0;
  const episodes = episodesOf(events);
  events.forEach((e) => {
    e.confirmedSnore = e.isSnore && (e.inEpisode || e.snoreProb >= CFG.loneSnoreMin);
  });
  const snores = events.filter((e) => e.confirmedSnore);
  const snoreTime = snores.reduce((a, e) => a + e.durationS, 0);
  const counts = { quiet: 0, light: 0, loud: 0, epic: 0 };
  snores.forEach((e) => (counts[e.intensity]++));

  const pct = duration ? (100 * snoreTime) / duration : 0;
  const loud = 0.5 * counts.loud + counts.epic;   // 0..1 per snore
  const loudFrac = loud / Math.max(snores.length, 1);
  const score = 100 * (0.65 * (Math.min(pct, 60) / 60) + 0.35 * loudFrac);

  return {
    durationS: duration,
    noiseFloorDbfs,
    snoreEvents: snores.length,
    snoreTimeS: snoreTime,
    snorePercent: pct,
    snoresPerHour: duration ? snores.length / (duration / 3600) : 0,
    snoreScore: score,
    intensityCounts: counts,
    episodes,
    weirdSounds: events
      .filter((e) => !e.confirmedSnore && (e.intensity === "loud" || e.intensity === "epic"))
      .map((e) => ({ startS: e.startS, peakDbfs: e.peakDbfs, intensity: e.intensity, centroid: e.centroid })),
  };
}
