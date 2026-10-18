# Sonora — Project Plan

_(product name **Sonora**; git repo stays `night-sound`, engine package `nightsound`)_

An on-device app that listens through the night, detects and scores **snoring**,
and flags other notable sounds — the quality of SnoreLab / iRonfle, built fresh,
private by default (no audio leaves the device).

_Last updated: 2026-10-18_

---

## 1. Vision & principles

- **One job, done well:** record the night, tell me in the morning when and how
  much I snored, and let me hear the odd sounds.
- **Private by default:** all analysis on-device; no uploads, no account needed
  to use it.
- **Transparent detection:** rule-based engine you can read and tune, with room
  to add a learned model later behind the same interface.
- **One codebase, every target:** a web core wrapped by Capacitor into iOS +
  Android apps, and testable in a browser.

---

## 2. Where we are today (done)

| Piece | State |
|------|-------|
| **Python engine** (`nightsound/`) | Batch-analyses a recording file. Envelope → event detection → spectral features → breathing-rhythm episodes → scoring. Validated on a synthetic night; tests pass. |
| **JS engine** (`web/analyzer.js`) | Same pipeline on the Web Audio API. Validated end-to-end headless in Chromium. |
| **Web app** (`web/`) | Live mic monitor: Snore Score, timeline, intensity tiers, event list with clip playback, JSON export, wake lock. Dark-first, responsive. |
| **Capacitor scaffold** (`package.json`, `capacitor.config.json`, `CAPACITOR.md`) | Ready to `cap add ios/android` and run on device. Pinned to Capacitor 8.5.3. |

Repo: `github.com/zikaoinfo/night-sound`, branch `master`.

---

## 3. Decisions locked in

- **Platform:** hybrid — web core + Capacitor native wrappers for iOS + Android.
- **Detection:** rule-based first (no training data needed to start); ML optional
  later. The engine definition is fixed and shared across Python and JS.
- **Privacy:** on-device only for v1. No backend.
- **Accounts/costs:** free Apple ID is enough to test on your own devices.
  $99/yr Apple + $25 once Google only when shipping to the stores (per account,
  unlimited apps).
- **Hardware available:** Mac, iPhone, iPad.

---

## 4. The core technical challenge (name it up front)

**All-night, screen-off recording.** A browser / WebView suspends the mic and JS
timers when the screen locks. So:
- The **web + foreground-native** versions are for testing detection and
  screen-on use.
- A **native audio layer** (iOS AVAudioEngine + `audio` background mode; Android
  foreground service) is what makes true overnight capture work. This is the
  single most important build item and the one that needs on-device iteration
  (battery, thermals, interruptions from calls/alarms).

---

## 5. Roadmap

### Phase 0 — Foundation ✅ (done)
Engine (Python + JS), web app, Capacitor scaffold.

### Phase 1 — On-device foreground app
**Goal:** the app installed on your iPhone/iPad, mic working while open.
- [ ] `npm install && npx cap add ios && npx cap sync && npx cap open ios`
- [ ] Signing with free Apple ID; add `NSMicrophoneUsageDescription`.
- [ ] Run on iPhone + iPad; confirm live detection on real audio.
- [ ] First real-recording pass → note false positives/negatives.
**Done when:** you can start a session on-device and see sensible live results.

### Phase 2 — Native background recording (the hard part)
**Goal:** records reliably all night with the screen off.
- [x] Capacitor Swift plugin `sonora-recorder`: `AVAudioSession`
      (`.playAndRecord`, `.measurement`, `.mixWithOthers`), `AVAudioEngine`
      input tap, `UIBackgroundModes: audio` (set by `scripts/setup-ios.sh`).
- [x] Detection ported to Swift (`SnoreEngine.swift`, Accelerate FFT).
- [x] Native short-WAV clips (loudest 60 snores + notable other sounds),
      crash-safe `session.json` every 30 s, opt-in full-night AAC.
- [x] Restart after interruptions (calls, alarms, route changes).
- [x] Web UI drives the plugin and reloads the session on resume/relaunch
      (`web/native.js`, `NativeSource` in `app.js`); e2e-tested with a mock
      bridge (`tests/web/e2e.mjs`).
- [ ] **On device:** build in Xcode, measure battery + thermals over a night,
      confirm recording survives a phone call.
- [x] Android: foreground service (`RecorderService`) + `AudioRecord` 16 kHz,
      Java port of the engine (matches the Python engine on the synthetic
      night: same 37 events, 3 episodes, noise floor), same plugin API.
      Type-checked against the Android 14 API; `scripts/setup-android.sh`.
- [x] Android full-night recording (AAC via MediaCodec + MediaMuxer).
**Done when:** an 8-hour screen-off session captures events accurately with
acceptable battery use.

### Phase 3 — Detection quality
**Goal:** trustworthy snore vs. not, tuned to real bedrooms.
- [x] Lone-sound rule in all four engines: a snore candidate outside a
      rhythmic run needs probability ≥ 0.65. Synthetic night now yields
      exactly the 34 planted snores; cough/thud/mumble become "other".
- [x] Score fix in all engines: loud = ½, epic = 1 (was 1 and 2, so the
      score could pass 100).
- [x] Labelling + accuracy tool: `analyse --clips all`, then
      `python -m nightsound evaluate labelled/` (precision/recall sweep,
      suggested thresholds, misclassified clips).
- [x] Per-recording calibration: adaptive noise floor (already per night).
- [ ] **Your part:** record a few real nights (quiet, loud, partner, fan/AC,
      street noise), label the clips, run `evaluate`, and send me the output.
- [ ] Tune `_snore_probability` weights from that data.
- [ ] Optional: small learned classifier (e.g. logistic regression / tiny CNN on
      log-mel) behind the same `Event` interface, trained on labelled clips.
**Done when:** on your nights, snore episodes match what you'd mark by ear.

### Phase 4 — Product polish
**Goal:** something you'd actually open every morning.
- [x] Morning summary sentence ("You snored for 42 min (9% of 7 h 30 min) in
      6 episodes, mostly light…").
- [x] History tab: Snore Score trend (last 14 nights) + list of nights; open
      any night with its timeline and playable clips; delete with a
      confirmation. Native: plugin sessions; browser: IndexedDB.
- [x] Settings: sensitivity (low/normal/high, same presets in every engine),
      opt-in full-night audio (iOS). Persisted per device.
- [x] App icon + splash sources (`scripts/make_icons.py` → `assets/`, then
      `npx @capacitor/assets generate`), web manifest + home-screen icons.
- [x] Accessibility: tab roles, labelled play buttons, live summary region,
      chart text alternatives, visible focus.
- [ ] Smart/sunrise alarm (optional, later).

### Phase 5 — Ship
- [x] Release checklist, store listing copy, App Review notes for background
      audio, Play foreground-service declaration, Data Safety answers —
      `STORE.md`.
- [x] Privacy policy page (`web/privacy.html`, served by GitHub Pages).
- [ ] **You:** Apple Developer ($99/yr) + Google Play ($25), TestFlight /
      internal testing, then submit.

---

## 6. Decisions (resolved)

1. **Overnight analysis runs natively** (Swift/Kotlin) for battery; the web UI
   stays the presentation layer. ✅
2. **Event clips only by default**, with full-night recording as an opt-in. ✅
3. **History/trends local-only** for v1 (no account, no sync). ✅
4. **Label the sounds, on-device.** Two-stage: the rule engine gates events,
   then a lightweight classifier labels each clip — **Apple SoundAnalysis** on
   iOS (built in, 0 MB, serverless) and **YAMNet-TFLite** (~4 MB) on Android.
   Benchmark + harness in `bench/`; the accuracy benchmark that decides tuning
   needs real labelled nights (Phase 3). ✅

5. **Name: Sonora.** ✅ (`appId` com.zikao.sonora). All decisions resolved.

---

## 7. Definition of done (v1)

A native iOS app (then Android) that: records a full night with the screen off,
shows a morning Snore Score + timeline + playable clips, keeps a history of
nights, runs entirely on-device, and feels trustworthy on your own recordings.

---

## 8. Immediate next action

Phase 1: build milestone 1 on your Mac and run it on your iPhone (steps in
`CAPACITOR.md`). In parallel I can start the Phase 2 Swift background plugin so
it's ready when you are. Tell me which to prioritise.

---

## 9. Premium features (parity with iRonfle / SnoreLab Premium)

iRonfle is SnoreLab's French edition (same App Store id 529443604). Its
Premium tier: full-night recording, trends, factors & remedies comparison,
nightly comparison, cloud backup, emailing a night's report with audio.
Sonora builds all of them in, kept on-device:

- [x] **P1 Factors & remedies + rest rating + notes**, and "what affects your
      snoring" (average score with vs without each tag); custom tags;
      comparison with your average in the morning summary.
- [x] **P2 Start delay** (off / 15 / 30 / 45 / 60 min) on iOS, Android and web.
- [x] **P3 Full-night recording + playback** on iOS, Android and web; tap
      the timeline to listen from that moment.
- [x] **P4 Night report (PDF) to share with a doctor**, sent with the loudest clips (share sheet in the app; download in a browser).
- [ ] **P5 Sound labels** for other noises (talking, coughing, …) on iOS
      via Apple's built-in sound classifier.
- [ ] **P6 Backup & restore** to a file you keep (iCloud Drive / Google
      Drive / anywhere) — the privacy-preserving alternative to a cloud
      account.
