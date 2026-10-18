# Shipping Sonora to the App Store and Google Play

Everything here is ready to paste. Steps marked **you** need your accounts or
devices.

## 0. Before submitting

- [ ] **you:** At least a week of real nights on your iPhone (and an Android
      phone if shipping there). Check battery use, that recording survives a
      phone call, and detection via `python -m nightsound evaluate` (Phase 3).
- [ ] `appId` in `capacitor.config.json` is `com.zikao.sonora`. It becomes
      permanent once you create the store listing, so change it now if you
      want a different one.
- [ ] Icons and splash: `npx @capacitor/assets generate` (see CAPACITOR.md).
- [ ] Privacy policy is live: GitHub Pages (Source: GitHub Actions) deploys `web/`;
      the URL is `https://zikaoinfo.github.io/night-sound/privacy.html`.
- [ ] Version: Xcode → App target → General → Version `1.0.0`, Build `1`;
      Android `android/app/build.gradle` → `versionName "1.0.0"`, `versionCode 1`.

## 1. Apple App Store

1. **you:** Join the Apple Developer Program ($99/year, unlimited apps).
2. **you:** App Store Connect → My Apps → **+** New App: platform iOS, name
   **Sonora** (if taken, "Sonora — Snore Tracker"), bundle ID
   `com.zikao.sonora`, SKU `sonora-ios`.
3. In Xcode: select *Any iOS Device*, Product → **Archive**, then
   Distribute App → App Store Connect → Upload.
4. **TestFlight** first: add yourself (and anyone else) as testers; run a few
   nights from the TestFlight build.
5. Fill in the listing (below), the privacy answers, and the review notes,
   then Submit for Review.

### App Privacy (the "nutrition label")

Answer **"No, we do not collect data from this app."** That's accurate:
nothing is sent off the device. Result on the store page: **Data Not Collected**.

### App Review notes (paste into "Notes" — this matters)

Apple checks every app that uses `UIBackgroundModes: audio`. Paste:

> Sonora is a sleep-sound monitor. The user taps "Start listening" at
> bedtime and locks the phone; Sonora records the microphone in the
> background all night to detect snoring and other sounds, which is the
> app's core function. That is why the app declares the "audio" background
> mode. Recording only happens during a session the user started, iOS shows
> the orange microphone indicator the whole time, and the user stops it in
> the morning. All analysis is on-device; no audio or data leaves the phone.
> To test: tap Start listening, lock the device for a few minutes while
> making some noise, unlock and open Sonora — the timeline shows what was
> recorded while locked.

Category: **Health & Fitness** (secondary: Lifestyle). Age rating: 4+.

## 2. Google Play

1. **you:** Google Play Console ($25 one-time).
2. Create app → name **Sonora**, free, app.
3. In Android Studio: Build → Generate Signed App Bundle (`.aab`); create
   and **back up** the upload keystore (losing it is painful).
4. Internal testing track first, then Production.

### Data safety form

- Does your app collect or share user data? **No.**
- Data is processed only on the device (ephemeral or stored locally), which
  Google does not count as collection.

### Foreground service declaration (required for the microphone service)

Play Console → App content → **Foreground service permissions** → type
**Microphone**. Use case text:

> The user starts a sleep recording session; a foreground service with a
> persistent "Sonora is listening" notification records the microphone
> overnight to detect snoring, and stops when the user ends the session.

Google asks for a short video: start a session, lock the phone, show the
notification, unlock, stop. A screen recording is enough.

### Permissions you'll see in the build

`RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`,
`POST_NOTIFICATIONS`, `WAKE_LOCK` — all from the sonora-recorder plugin.

## 3. Store listing copy

**Name:** Sonora
**Subtitle (iOS, 30 chars):** Snore & sleep-sound tracker
**Short description (Play, 80 chars):** Find out when and how much you snore. Private: nothing leaves your phone.

**Description:**

> Find out when you snore, how loud it gets, and what else goes bump in the
> night.
>
> Put your phone by the bed, tap Start, and lock the screen. In the morning,
> Sonora shows your Snore Score, a timeline of the night, and short clips you
> can play back.
>
> • Snore Score from 0 to 100, plus time snoring and how loud it got
> • A timeline of the night with every snoring episode
> • Listen back to the loudest snores and any other loud sounds
> • History: see how your nights compare over time
> • Adjustable sensitivity for quiet or noisy rooms
>
> Private by design. All listening and analysis happen on your phone. No
> account, no uploads, no ads, no tracking.
>
> Sonora is not a medical device and doesn't diagnose sleep apnoea. If you're
> concerned about your sleep or breathing, talk to a doctor.

**Keywords (iOS, 100 chars):** snore,snoring,sleep,recorder,sleep sounds,sleep talk,apnea,night,tracker,sleep monitor

**Screenshots:** take them from your phone after a real night: Tonight with a
score, the timeline, the sounds list, History. iPhone 6.9" and 6.5" sizes are
required; iPad if you ship for iPad (Capacitor apps are universal by default —
turn off iPad in Xcode under General → Supported Destinations if you don't
want to make iPad screenshots).

## 4. Wording to stay clear of

Don't claim Sonora detects, measures, or diagnoses **sleep apnoea** or any
condition, in the app or the listing. Health claims trigger medical-device
review at Apple and Google (and regulators). "Track your snoring" is fine;
"detect apnoea" is not.
