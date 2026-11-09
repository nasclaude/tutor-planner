#!/bin/bash
# Renders the PNG app icons from dev/icon-full-bleed.svg using headless Chrome (macOS).
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$PWD/web/icons/icon-512.png"
PROFILE="$(mktemp -d)"
rm -f "$OUT"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --user-data-dir="$PROFILE" --window-size=512,512 \
  --screenshot="$OUT" "file://$PWD/dev/icon-full-bleed.svg" >/dev/null 2>&1 &
CHROME_PID=$!
# Headless Chrome sometimes keeps running after taking the screenshot, so wait for the file and stop it.
for _ in $(seq 1 30); do [ -s "$OUT" ] && break; sleep 1; done
sleep 1
kill "$CHROME_PID" 2>/dev/null || true
wait "$CHROME_PID" 2>/dev/null || true
rm -rf "$PROFILE" 2>/dev/null || true
sips -z 192 192 "$OUT" --out web/icons/icon-192.png >/dev/null
sips -z 180 180 "$OUT" --out web/icons/apple-touch-icon.png >/dev/null
ls -l web/icons
