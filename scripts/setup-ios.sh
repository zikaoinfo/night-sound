#!/usr/bin/env bash
# One-command iOS setup for Sonora (run on your Mac from the repo root).
#
#   ./scripts/setup-ios.sh
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

echo
echo "Info.plist ready (microphone + background audio)."
echo "In Xcode: App target -> Signing & Capabilities -> pick your Team, plug in your iPhone, press Run."
npx cap open ios
