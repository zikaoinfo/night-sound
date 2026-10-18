# night-sound · Sonora

The engine and app behind **Sonora** — an on-device snore & sleep-sound
monitor (product name Sonora; this repo stays `night-sound`).

A dependency-light engine that detects and analyses **snoring** and other
night-time sounds in an overnight audio recording — the analysis core
behind apps like SnoreLab / iRonfle, without the app.

Point it at a recording (any format `ffmpeg` can read: `.m4a`, `.mp3`,
`.wav`, `.opus`, …) and it tells you when you snored, how loud, how often,
and lists other odd sounds in the night — as JSON, a text summary, a
timeline PNG, and optional review clips.

## How it works

No trained model required. The pipeline mirrors how the commercial apps
work, with transparent, tunable rules:

1. **Decode** to 16 kHz mono via ffmpeg, **streamed in chunks** so an
   8-hour file doesn't blow up memory.
2. **Loudness envelope** — RMS every 50 ms; an **adaptive noise floor**
   (20th percentile) adapts to your room and mic.
3. **Event detection** — spans that rise ~9 dB above the floor, merged
   across short gaps.
4. **Per-event features** — spectral centroid, low-band (30–600 Hz) energy
   ratio, spectral flatness (tonal vs. hissy), and a fundamental-frequency /
   harmonicity estimate. Snores are low, tonal and harmonic.
5. **Rhythm analysis** — snoring recurs at breathing rate (~1 per 1.5–6 s).
   Events that repeat rhythmically are grouped into **episodes**; this is
   what separates real snoring from a one-off cough, thud or bit of speech.
6. **Scoring** — snore %, snores/hour, intensity tiers
   (quiet / light / loud / epic), a 0–100 **Snore Score**, and a
   **"weird sounds"** list of loud non-snore events with timestamps.

See `nightsound/analysis.py` — the tunables are constants at the top, and
`_snore_probability()` is a readable weighted score you can adjust for your
own setup (or replace with an ML classifier behind the same `Event`
interface).

## Install

```bash
pip install -r requirements.txt     # numpy, scipy, matplotlib
# plus ffmpeg + ffprobe on your PATH:
#   macOS:  brew install ffmpeg
#   Ubuntu: sudo apt install ffmpeg
```

## Use

```bash
# analyse a real recording
python -m nightsound analyse last_night.m4a -o out/

# also cut audio clips of each snoring episode for a listen
python -m nightsound analyse last_night.m4a -o out/ --clips episodes

# try it with no recording — builds and analyses a synthetic night
python -m nightsound demo
```

Outputs land in the output directory: `<name>.report.json`,
`<name>.timeline.png`, and (with `--clips`) a `clips/` folder.

As a library:

```python
from nightsound import analyse
from nightsound.report import text_summary

rep = analyse("last_night.m4a")
print(text_summary(rep))
print(rep.snore_score, rep.snore_percent, len(rep.episodes))
```

## Tuning for your room

Measure first, then tune. Pull every detected sound out of a real night,
listen, and sort the clips into folders:

```bash
python -m nightsound analyse night.m4a -o out/ --clips all
# move out/clips/*.wav into labelled/snore/ and labelled/other/
python -m nightsound evaluate labelled/
```

`evaluate` prints precision/recall at each threshold, suggests a snore
threshold and a lone-sound threshold, and lists the clips it got wrong.

The knobs:

- Recording too quiet / too loud → adjust `THRESH_OVER_FLOOR_DB` and
  `ABS_FLOOR_DBFS` in `analysis.py`.
- Too many / too few snores flagged → raise/lower `--threshold` (the snore
  probability cutoff) or re-weight `_snore_probability()`.
- Different breathing cadence → `BREATH_MIN_S` / `BREATH_MAX_S`.

## Live web app

`web/` is an on-device browser app (live mic monitoring, Snore Score,
timeline, clip playback, JSON export) built on a JavaScript port of this
engine — and the foundation for the iOS + Android apps via Capacitor. See
[`web/README.md`](web/README.md) for how to run it and the path to the app
stores.

## Status

v0.1 — Python engine + matching JS engine and web UI, both validated
(Python on a synthetic night; the web app end-to-end headless in Chromium).
Next candidates: per-recording calibration, an optional learned classifier,
and the Capacitor native wrapper for all-night background recording.
