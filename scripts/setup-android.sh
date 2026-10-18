#!/usr/bin/env bash
# One-command Android setup for Sonora (needs Android Studio installed).
#
#   ./scripts/setup-android.sh
#
# Permissions (microphone, foreground service, wake lock) come from the
# sonora-recorder plugin's manifest and are merged in automatically.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "Install Node 20+ first." >&2; exit 1; }

npm install
if [[ ! -d android ]]; then
  npx cap add android
fi
npx cap sync android

echo
echo "In Android Studio: wait for Gradle sync, plug in your phone (USB debugging on), press Run."
npx cap open android
