"""The analysis engine: envelope -> events -> features -> classification -> score.

Nothing here needs a trained model. Snoring has a stable acoustic
signature — low-frequency, tonal/harmonic, and *rhythmic* at breathing
rate — and that is enough to separate it from coughs, speech, traffic and
other one-off night sounds with rule-based features. The classifier is
deliberately transparent so you can tune the thresholds to your own room
and mic, and swap in an ML model later behind the same interface.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np
from scipy import signal

from . import audio

# --- tunables -------------------------------------------------------------

HOP_S = 0.05                 # loudness envelope resolution (50 ms)
NOISE_PCTL = 20.0            # percentile of frame energy taken as the noise floor
THRESH_OVER_FLOOR_DB = 9.0   # an event must rise this far above the noise floor
ABS_FLOOR_DBFS = -55.0       # ...and clear this absolute level (ignore dead silence)
MIN_EVENT_S = 0.20           # ignore clicks shorter than this
MERGE_GAP_S = 0.35           # bridge gaps shorter than this into one event
MAX_EVENT_S = 8.0            # cap a single event; longer runs get split

# snore-shaped breathing cycle: one snore every ~1.5–6 s
BREATH_MIN_S, BREATH_MAX_S = 1.5, 6.0
# a snore candidate that isn't part of a rhythmic run needs at least this probability
LONE_SNORE_MIN = 0.65

EPS = 1e-10


def _dbfs(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    r = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return 20.0 * np.log10(r + EPS)


# --- per-event feature extraction & classification ------------------------

@dataclass
class Event:
    start_s: float
    end_s: float
    peak_dbfs: float = 0.0
    rms_dbfs: float = 0.0
    centroid_hz: float = 0.0        # spectral centre of mass
    low_band_ratio: float = 0.0     # energy in 30–600 Hz / 30–4000 Hz
    flatness: float = 0.0           # 0 tonal .. 1 noise-like
    f0_hz: float = 0.0              # estimated fundamental (0 = none found)
    harmonicity: float = 0.0        # 0 .. 1 strength of periodic structure
    snore_prob: float = 0.0         # rule-based likelihood, 0..1
    is_snore: bool = False
    in_episode: bool = False        # part of a rhythmic snoring run
    label: str = "other"            # "snore" | "other"
    intensity: str = "quiet"        # quiet | light | loud | epic

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s


def _extract_features(x: np.ndarray, sr: int, ev: Event) -> None:
    """Fill the acoustic feature fields of `ev` from its waveform `x`."""
    ev.peak_dbfs = 20.0 * np.log10(float(np.max(np.abs(x))) + EPS) if x.size else -120.0
    ev.rms_dbfs = _dbfs(x)

    nperseg = min(512, x.size) if x.size else 512
    if nperseg < 32:
        return
    f, _, Zxx = signal.stft(x, fs=sr, nperseg=nperseg, noverlap=nperseg // 2)
    P = np.mean(np.abs(Zxx) ** 2, axis=1)  # average power spectrum
    total = float(P.sum()) + EPS

    ev.centroid_hz = float((f * P).sum() / total)

    low = P[(f >= 30) & (f <= 600)].sum()
    band = P[(f >= 30) & (f <= 4000)].sum() + EPS
    ev.low_band_ratio = float(low / band)

    # spectral flatness: geometric mean / arithmetic mean over the voice band
    bandP = P[(f >= 30) & (f <= 4000)]
    if bandP.size:
        gmean = float(np.exp(np.mean(np.log(bandP + EPS))))
        amean = float(np.mean(bandP) + EPS)
        ev.flatness = gmean / amean

    ev.f0_hz, ev.harmonicity = _estimate_f0(x, sr)


def _estimate_f0(x: np.ndarray, sr: int) -> tuple[float, float]:
    """Fundamental frequency via autocorrelation on a low-pass band (40–400 Hz)."""
    if x.size < sr // 20:
        return 0.0, 0.0
    sos = signal.butter(4, [40, 400], btype="band", fs=sr, output="sos")
    y = signal.sosfiltfilt(sos, x.astype(np.float64))
    y = y - y.mean()
    if np.allclose(y, 0):
        return 0.0, 0.0
    ac = signal.correlate(y, y, mode="full")
    ac = ac[ac.size // 2:]
    ac0 = ac[0] + EPS
    lo, hi = int(sr / 400), int(sr / 40)  # lag range for 40–400 Hz
    hi = min(hi, ac.size - 1)
    if hi <= lo:
        return 0.0, 0.0
    seg = ac[lo:hi]
    k = int(np.argmax(seg)) + lo
    harmonicity = float(np.clip(ac[k] / ac0, 0.0, 1.0))
    f0 = sr / k if k else 0.0
    return (f0 if harmonicity > 0.15 else 0.0), harmonicity


def _snore_probability(ev: Event) -> float:
    """Transparent weighted score in [0,1]. Snores are low, tonal, and ~0.5–3 s."""
    s = 0.0
    # energy concentrated in the low band
    s += 0.32 * np.clip((ev.low_band_ratio - 0.45) / 0.45, 0, 1)
    # low spectral centroid
    s += 0.22 * np.clip((900.0 - ev.centroid_hz) / 700.0, 0, 1)
    # tonal, not hissy (low flatness)
    s += 0.18 * np.clip((0.55 - ev.flatness) / 0.45, 0, 1)
    # periodic vibration present
    s += 0.16 * np.clip((ev.harmonicity - 0.2) / 0.5, 0, 1)
    # plausible snore-burst duration
    dur = ev.duration_s
    dur_score = 1.0 if 0.3 <= dur <= 3.0 else max(0.0, 1.0 - abs(dur - 1.5) / 3.0)
    s += 0.12 * dur_score
    return float(np.clip(s, 0.0, 1.0))


def _intensity(peak_dbfs: float, noise_floor_dbfs: float) -> str:
    over = peak_dbfs - noise_floor_dbfs
    if over < 10:
        return "quiet"
    if over < 20:
        return "light"
    if over < 30:
        return "loud"
    return "epic"


# --- session-level orchestration ------------------------------------------

@dataclass
class SessionReport:
    file: str
    duration_s: float
    sample_rate: int
    noise_floor_dbfs: float
    events: list[Event] = field(default_factory=list)
    episodes: list[dict] = field(default_factory=list)   # rhythmic snoring runs
    # aggregates
    snore_events: int = 0
    snore_time_s: float = 0.0
    snore_percent: float = 0.0          # of recording time
    snores_per_hour: float = 0.0
    snore_score: float = 0.0            # headline 0–100
    intensity_counts: dict = field(default_factory=dict)
    weird_sounds: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


def _build_envelope(path: str, sr: int) -> tuple[np.ndarray, float]:
    """Stream the file and return (per-frame RMS dBFS, duration seconds)."""
    hop = int(HOP_S * sr)
    frames: list[np.ndarray] = []
    carry = np.empty(0, dtype=np.float32)
    total = 0
    for chunk in audio.stream_mono(path, sr=sr):
        total += chunk.size
        buf = np.concatenate([carry, chunk]) if carry.size else chunk
        n = (buf.size // hop) * hop
        if n:
            block = buf[:n].reshape(-1, hop)
            rms = np.sqrt(np.mean(block.astype(np.float64) ** 2, axis=1))
            frames.append(20.0 * np.log10(rms + EPS))
        carry = buf[n:]
    if carry.size:
        rms = np.sqrt(np.mean(carry.astype(np.float64) ** 2))
        frames.append(np.array([20.0 * np.log10(rms + EPS)]))
    env = np.concatenate(frames) if frames else np.zeros(1)
    return env, total / sr


def _detect_events(env_dbfs: np.ndarray, noise_floor: float) -> list[tuple[int, int]]:
    """Return (start_frame, end_frame) spans above the adaptive threshold."""
    thresh = max(noise_floor + THRESH_OVER_FLOOR_DB, ABS_FLOOR_DBFS)
    active = env_dbfs >= thresh
    spans: list[list[int]] = []
    i = 0
    n = active.size
    merge_frames = int(round(MERGE_GAP_S / HOP_S))
    while i < n:
        if active[i]:
            j = i
            while j < n and active[j]:
                j += 1
            if spans and i - spans[-1][1] <= merge_frames:
                spans[-1][1] = j           # merge with previous across a short gap
            else:
                spans.append([i, j])
            i = j
        else:
            i += 1
    min_frames = int(round(MIN_EVENT_S / HOP_S))
    return [(a, b) for a, b in spans if (b - a) >= min_frames]


def _mark_episodes(events: list[Event]) -> list[dict]:
    """Group snore events whose spacing matches a breathing rhythm."""
    snores = [e for e in events if e.is_snore]
    episodes: list[dict] = []
    run: list[Event] = []

    def flush() -> None:
        if len(run) >= 3:
            for e in run:
                e.in_episode = True
            episodes.append({
                "start_s": round(run[0].start_s, 2),
                "end_s": round(run[-1].end_s, 2),
                "snores": len(run),
                "mean_interval_s": round(
                    float(np.mean(np.diff([e.start_s for e in run]))), 2),
            })
        run.clear()

    for e in snores:
        if not run:
            run.append(e)
            continue
        gap = e.start_s - run[-1].start_s
        if BREATH_MIN_S <= gap <= BREATH_MAX_S:
            run.append(e)
        else:
            flush()
            run.append(e)
    flush()
    return episodes


def analyse(
    path: str,
    *,
    sr: int = audio.TARGET_SR,
    snore_threshold: float = 0.5,
    progress: Optional[callable] = None,
) -> SessionReport:
    """Analyse an audio file and return a SessionReport."""
    if progress:
        progress("decoding + building loudness envelope")
    env, duration = _build_envelope(path, sr)

    noise_floor = float(np.percentile(env, NOISE_PCTL))
    rep = SessionReport(
        file=path, duration_s=round(duration, 2), sample_rate=sr,
        noise_floor_dbfs=round(noise_floor, 2),
    )

    if progress:
        progress("detecting events")
    spans = _detect_events(env, noise_floor)

    if progress:
        progress(f"extracting features for {len(spans)} events")
    for a, b in spans:
        start_s = a * HOP_S
        end_s = min(b * HOP_S, duration)
        # split overly long runs so one feature vector describes one burst
        seg_start = start_s
        while seg_start < end_s - 1e-3:
            seg_end = min(seg_start + MAX_EVENT_S, end_s)
            ev = Event(start_s=round(seg_start, 3), end_s=round(seg_end, 3))
            x = audio.read_region(path, seg_start, seg_end - seg_start, sr=sr)
            _extract_features(x, sr, ev)
            ev.snore_prob = round(_snore_probability(ev), 3)
            ev.is_snore = ev.snore_prob >= snore_threshold
            ev.label = "snore" if ev.is_snore else "other"
            ev.intensity = _intensity(ev.peak_dbfs, noise_floor)
            for f_ in ("peak_dbfs", "rms_dbfs", "centroid_hz",
                       "low_band_ratio", "flatness", "f0_hz", "harmonicity"):
                setattr(ev, f_, round(getattr(ev, f_), 3))
            rep.events.append(ev)
            seg_start = seg_end

    # rhythm: confirm snoring that recurs at breathing rate
    rep.episodes = _mark_episodes(rep.events)
    _apply_lone_rule(rep.events)

    # aggregates
    snores = [e for e in rep.events if e.is_snore]
    rep.snore_events = len(snores)
    rep.snore_time_s = round(sum(e.duration_s for e in snores), 2)
    rep.snore_percent = round(100.0 * rep.snore_time_s / duration, 2) if duration else 0.0
    rep.snores_per_hour = round(len(snores) / (duration / 3600.0), 2) if duration else 0.0

    rep.intensity_counts = {k: 0 for k in ("quiet", "light", "loud", "epic")}
    for e in snores:
        rep.intensity_counts[e.intensity] += 1

    # "weird sounds": loud non-snore events worth a listen
    rep.weird_sounds = [
        {"start_s": e.start_s, "end_s": e.end_s,
         "peak_dbfs": e.peak_dbfs, "intensity": e.intensity,
         "centroid_hz": e.centroid_hz}
        for e in rep.events
        if not e.is_snore and e.intensity in ("loud", "epic")
    ]

    rep.snore_score = round(_session_score(rep), 1)
    return rep


def _session_score(rep: SessionReport) -> float:
    """Headline 0–100. Blends how much of the night you snored with how loud."""
    pct = min(rep.snore_percent, 60.0) / 60.0           # saturate at 60%
    # 0..1: half weight for loud snores, full weight for epic ones
    loud = 0.5 * rep.intensity_counts.get("loud", 0) + rep.intensity_counts.get("epic", 0)
    loud_frac = loud / max(rep.snore_events, 1)
    return 100.0 * (0.65 * pct + 0.35 * loud_frac)


def _apply_lone_rule(events: list[Event]) -> None:
    """A snore-like sound outside any breathing-rate run must be more confident.

    Thuds and coughs can look spectrally like a snore, but they don't repeat
    every few seconds. Run after _mark_episodes.
    """
    for e in events:
        if e.is_snore and not e.in_episode and e.snore_prob < LONE_SNORE_MIN:
            e.is_snore = False
            e.label = "other"
