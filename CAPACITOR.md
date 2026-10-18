# Running Sonora on your iPhone / iPad (Capacitor)

This wraps the `web/` app into a native iOS (and Android) app. You install it
from Xcode onto your own device — **no $99 account needed for that**; a free
Apple ID signs it with a 7-day certificate (re-run from Xcode to renew).

## What runs where

Inside the app, recording is done by the native **SonoraRecorder** plugin
(`plugins/sonora-recorder/`), not the WebView: it keeps the microphone running
all night with the screen locked, detects events natively, and saves them.
The web UI shows the results and reloads them whenever you open the app.
In a plain browser the same UI falls back to Web Audio (screen must stay on).

---

## Prerequisites (on your Mac)

- **Xcode** (from the App Store) + command line tools.
- **Node 20+** and **CocoaPods**: `sudo gem install cocoapods` (or `brew install cocoapods`).

## Build it (milestone 1)

Shortcut — does everything below, including the Info.plist keys:

```bash
git clone https://github.com/zikaoinfo/night-sound.git && cd night-sound
./scripts/setup-ios.sh
```

Or step by step:

```bash
git clone https://github.com/zikaoinfo/night-sound.git
cd night-sound

npm install
npx cap add ios          # generates the ios/ Xcode project
npx cap sync ios         # copies web/ into the app + installs pods
npx cap open ios         # opens it in Xcode
```

In Xcode:
1. Select the **App** target → **Signing & Capabilities** → check *Automatically
   manage signing* → pick your **Team** (your free Apple ID; add it under
   Xcode → Settings → Accounts).
2. Add the microphone permission string — see **Info.plist** below.
3. Plug in your iPhone (or iPad), select it as the run destination, press **▶**.
4. First run on the device: **Settings → General → VPN & Device Management →**
   trust your developer certificate. Launch the app, tap **Start listening**,
   allow the mic.

To push code changes later: edit files in `web/`, then `npx cap sync ios` and
re-run in Xcode.

### Android

```bash
./scripts/setup-android.sh     # needs Android Studio
```

On Android the recorder runs as a foreground service, so a "Sonora is
listening" notification stays up while it records — Android requires that for
overnight microphone use. Full-night recording is iOS-only for now; event clips
work on both.

---

## App icon and splash screen

Sources live in `assets/` (drawn by `scripts/make_icons.py`). Generate every
iOS/Android size from them once the native projects exist:

```bash
npx @capacitor/assets generate --iconBackgroundColor '#0d1117' --splashBackgroundColor '#f3f5fa' --splashBackgroundColorDark '#0b0e16'
```

## Info.plist keys

Open `ios/App/App/Info.plist` in Xcode and add:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Sonora listens for snoring and other sounds while you sleep. Audio is analysed on your device and is never uploaded.</string>

<!-- needed for milestone 2 (background recording) -->
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

`NSMicrophoneUsageDescription` is required even for milestone 1 — without it iOS
kills the app the moment it asks for the mic.

---

## Changing the app identity

`capacitor.config.json` sets `appId` (`com.zikao.sonora`) and `appName`
(`Sonora`). Adjust `appId` to your own reverse-domain id before you ever ship to
a store; for local device testing anything unique works.

---

## The native recorder (`plugins/sonora-recorder`)

- `NightRecorder.swift` — `AVAudioSession` (`.playAndRecord`, `.measurement`
  mode so iOS doesn't apply voice processing, `.mixWithOthers`) and an
  `AVAudioEngine` input tap, resampled to 16 kHz mono. With the `audio`
  background mode it keeps recording while the screen is locked. Restarts
  itself after phone calls, alarms and route changes.
- `SnoreEngine.swift` — the same detection pipeline as `analyzer.js` and the
  Python engine (envelope → adaptive noise floor → events → spectral features
  via Accelerate → snore probability), so all three agree.
- Saves to `Documents/Sonora/sessions/<id>/`: `session.json` (events, per-second
  loudness, summary — rewritten every 30 s, so a crash loses at most 30 s),
  short WAV clips (the 60 loudest snores plus every notable other sound), and
  `full.m4a` only if full-night recording is turned on.
- Wired up automatically by `npx cap sync` (Swift Package Manager).

### Checking it on your iPhone

1. Run the app, tap **Start listening**, allow the microphone.
2. Lock the phone for a few minutes and make some noise near it.
3. Unlock and open Sonora: the timeline and sound list fill in with what
   happened while it was locked.

Things only a real device can tell us (please report back): battery use over
a full night, whether recording survives an incoming call on your phone, and
whether the device gets warm. I couldn't compile Swift in the environment
where this was written, so if Xcode reports a build error, paste it to me.
