# Night Sound — web app

The on-device snore & night-sound monitor, in plain HTML/CSS/JS (no build
step, no framework). This is also the **foundation for the iOS + Android
apps**: Capacitor wraps exactly this web code into native store apps.

## What it does

- Listens through the microphone and shows a live loudness meter.
- Detects sound events, classifies **snore vs. other** by spectral shape
  and breathing rhythm, and groups snores into **episodes**.
- Live **Snore Score**, time snoring, snores/hour, intensity tiers.
- A timeline canvas and a list of recent sounds, each with **playback** of
  the captured clip.
- **Export JSON** of the whole session.
- Everything runs locally in the browser — no audio leaves the device.

The detection logic (`analyzer.js`) is a direct port of the Python engine
in `../nightsound/`, so both agree on how a snore is defined.

## Test it

The microphone needs a **secure context** (HTTPS or `localhost`).

**On your computer (quickest):**
```bash
cd web
python3 -m http.server 8137
# open http://localhost:8137  — localhost counts as secure, so the mic works
```

**On your phone — via GitHub Pages (free HTTPS):**
1. Push this repo (already on GitHub).
2. Repo → Settings → Pages → Build from branch → `master` / root.
3. Open `https://<you>.github.io/night-sound/web/` on your phone and allow
   the mic.

Keep the screen on and the phone plugged in near the bed. Note the limit
below.

## The background-recording limit (why we need the native app)

Browsers **suspend the microphone when the screen sleeps**, so the pure web
version records only while the app is open and the screen is on — great for
testing detection, naps, or a screen-on/plugged-in setup, not a full night
with the screen off. The native build fixes this (below).

## Roadmap to the app stores (Capacitor)

```bash
npm create @capacitor/app         # or add Capacitor to this web dir
npx cap add ios && npx cap add android
```
- Point Capacitor's `webDir` at this folder.
- Add a **background-audio** capability: iOS `UIBackgroundModes: audio` +
  an `AVAudioSession`; Android a foreground service. A small native plugin
  keeps the mic alive with the screen off and hands PCM to this same JS
  engine (or runs the detection natively for battery).
- Build in Xcode (needs a Mac + Apple Developer account, $99/yr) and
  Android Studio (Google Play, $25 one-time).

## Files

| file | role |
|------|------|
| `index.html` | layout |
| `styles.css` | dark-first theme, responsive |
| `analyzer.js` | detection / classification / scoring (Web Audio) |
| `recorder.js` | raw-PCM ring buffer + WAV encoding for clips |
| `app.js` | mic capture, frame loop, timeline, event list, export |

Tested headless in Chromium (synthetic audio) end-to-end: event detection,
feature extraction, scoring, clip capture and playback all run clean.
