#!/bin/bash
# Installs the LaunchDock worker on a Mac as a LaunchAgent (runs in your user session so it can use the keychain).
#   ./macos/install-worker.sh https://ship.4aro.com <WORKER_TOKEN>
set -euo pipefail

URL="${1:-}"; TOKEN="${2:-}"
if [[ -z "$URL" || -z "$TOKEN" ]]; then
  echo "Usage: $0 <LAUNCHDOCK_URL> <WORKER_TOKEN>"; exit 1
fi

check() { command -v "$1" >/dev/null 2>&1 || { echo "✖ $1 not found. $2"; exit 1; }; }
check xcodebuild "Install Xcode from the App Store, then: sudo xcode-select -s /Applications/Xcode.app"
check node "Install Node 22+: brew install node@22"
check pod "Install CocoaPods: brew install cocoapods"
check git "Install Xcode command line tools: xcode-select --install"
command -v java >/dev/null 2>&1 || echo "⚠ Java not found — this Mac can build iOS only. For Android too: brew install --cask zulu@17"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 20 )) || { echo "✖ Node 20+ required (found $(node -v))"; exit 1; }
sudo xcodebuild -license accept 2>/dev/null || true

SRC="$(cd "$(dirname "$0")/.." && pwd)/worker"
DEST="$HOME/.launchdock-worker"
mkdir -p "$DEST/logs"
rsync -a --delete "$SRC/" "$DEST/app/"

PLATFORMS="ios"
command -v java >/dev/null 2>&1 && [[ -n "${ANDROID_HOME:-}" ]] && PLATFORMS="ios,android"
PLIST="$HOME/Library/LaunchAgents/com.4aro.launchdock.worker.plist"
NODE_BIN="$(command -v node)"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.4aro.launchdock.worker</string>
  <key>ProgramArguments</key><array><string>${NODE_BIN}</string><string>${DEST}/app/src/index.js</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LAUNCHDOCK_URL</key><string>${URL}</string>
    <key>WORKER_TOKEN</key><string>${TOKEN}</string>
    <key>WORKER_ID</key><string>$(scutil --get LocalHostName)-mac</string>
    <key>PLATFORMS</key><string>${PLATFORMS}</string>
    <key>WORK_DIR</key><string>${DEST}/work</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>ANDROID_HOME</key><string>${ANDROID_HOME:-}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DEST}/logs/worker.log</string>
  <key>StandardErrorPath</key><string>${DEST}/logs/worker.log</string>
</dict>
</plist>
EOF
chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✔ LaunchDock worker installed (platforms: $PLATFORMS)"
echo "  Logs:      tail -f $DEST/logs/worker.log"
echo "  Stop:      launchctl bootout gui/$(id -u) $PLIST"
echo "  Keep the Mac awake: System Settings → Energy → Prevent automatic sleeping"
