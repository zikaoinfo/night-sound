# Running Sonora on your iPhone / iPad (Capacitor)

This wraps the `web/` app into a native iOS (and Android) app. You install it
from Xcode onto your own device — **no $99 account needed for that**; a free
Apple ID signs it with a 7-day certificate (re-run from Xcode to renew).

## Two milestones

1. **Foreground app (this scaffold).** The web app running as a real native
   app on your iPhone/iPad. The mic works while the app is open. This is the
   quickest way to feel it as an app and test detection on-device.
2. **All-night background recording (next step).** Needs a small native Swift
   plugin (AVAudioEngine) plus the `audio` background mode, because iOS
   suspends a WebView's JS timers and mic when the screen locks. Design notes
   at the bottom — tell me when milestone 1 runs and I'll build it.

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

### Android (optional, same idea)
```bash
npx cap add android
npx cap open android      # Android Studio; run on a device/emulator
```

---

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

## Milestone 2 — background recording (design)

The honest constraint: a WKWebView's `getUserMedia` stream and JS `setInterval`
loop are suspended when the app backgrounds or the screen locks, so the current
`analyzer.js` loop stalls overnight even with the `audio` background mode.

The fix is a native capture layer:

- A Capacitor plugin (Swift) configures `AVAudioSession` as `.playAndRecord`
  with `.mixWithOthers`, activates it, and installs a tap on `AVAudioEngine`'s
  input node. With `UIBackgroundModes: audio`, that keeps the mic alive with
  the screen off.
- Run the detection **natively** (port the small feature/scoring math from
  `analyzer.js` to Swift) for battery, and stream events + the loudness
  envelope back to the JS UI via plugin notifications. The web UI stays the
  presentation layer; the engine definition (envelope → events → spectral
  features → rhythm → score) is unchanged.
- Keep clips the same way — write short WAVs natively when an event fires.

This is the part that needs iterating on-device (battery, thermals, the audio
session interacting with alarms/phone calls). It's the real work of a
SnoreLab-class app, and it's well-scoped from here.
