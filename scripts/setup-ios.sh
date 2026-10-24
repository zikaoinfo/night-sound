#!/usr/bin/env bash
# One-command iOS setup for Sonora (run on your Mac from the repo root).
#
#   ./scripts/setup-ios.sh            # first time, or after git pull
#   ./scripts/setup-ios.sh --clean    # start over: regenerates ios/ and clears
#                                     # Xcode's caches (fixes "Missing package product")
#
# Installs JS deps, generates the Xcode project if missing, syncs the web app
# and native plugin into it, adds the required Info.plist keys, and opens Xcode.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script needs macOS (Xcode)." >&2
  exit 1
fi
command -v node >/dev/null || { echo "Install Node 20+ first." >&2; exit 1; }

if [[ "${1:-}" == "--clean" ]]; then
  echo "Cleaning: ios/, node_modules/, Xcode build and package caches for this app"
  osascript -e 'quit app "Xcode"' 2>/dev/null || true
  rm -rf ios node_modules package-lock.json
  rm -rf ~/Library/Developer/Xcode/DerivedData/App-*
  rm -rf ~/Library/Caches/org.swift.swiftpm ~/Library/org.swift.swiftpm
fi

npm install

if [[ ! -d ios ]]; then
  npx cap add ios
fi
npx cap sync ios

PLIST="ios/App/App/Info.plist"
PB=/usr/libexec/PlistBuddy
MIC_TEXT="Sonora listens for snoring and other sounds while you sleep. Audio is analysed on your device and is never uploaded."

if ! $PB -c "Print :NSMicrophoneUsageDescription" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Add :NSMicrophoneUsageDescription string $MIC_TEXT" "$PLIST"
fi
if ! $PB -c "Print :UIBackgroundModes" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Add :UIBackgroundModes array" "$PLIST"
  $PB -c "Add :UIBackgroundModes:0 string audio" "$PLIST"
elif ! $PB -c "Print :UIBackgroundModes" "$PLIST" | grep -q audio; then
  $PB -c "Add :UIBackgroundModes:0 string audio" "$PLIST"
fi

# Sonora's icon and launch screen instead of Capacitor's defaults
# (sources drawn by scripts/make_icons.py).
XC="ios/App/App/Assets.xcassets"
cp assets/icon-only.png "$XC/AppIcon.appiconset/AppIcon-512@2x.png"
for f in splash-2732x2732.png splash-2732x2732-1.png splash-2732x2732-2.png; do
  cp assets/splash-dark.png "$XC/Splash.imageset/$f"
done

# The app should only use these packages; anything else is a stale project.
if grep -q "capacitor/filesystem" ios/App/CapApp-SPM/Package.swift; then
  echo "ios/ still references @capacitor/filesystem — run: ./scripts/setup-ios.sh --clean" >&2
  exit 1
fi

echo
echo "Info.plist ready (microphone + background audio)."
echo "In Xcode: App target -> Signing & Capabilities -> pick your Team, plug in your iPhone, press Run."
npx cap open ios
