#!/bin/bash
# Installs the SIM monitoring agent for the current macOS user and starts it automatically at login.
# Usage: ./install.sh   (asks for this Mac's agent key from the dashboard's Users page)
# To uninstall: launchctl bootout gui/$(id -u)/me.bewen.sim-agent && rm ~/Library/LaunchAgents/me.bewen.sim-agent.plist
set -euo pipefail
cd "$(dirname "$0")"

for tool in node adb idevice_id ideviceinfo; do
  if ! command -v "$tool" >/dev/null; then
    echo "Missing $tool. Install the requirements first:"
    echo "  brew install node android-platform-tools libimobiledevice"
    exit 1
  fi
done

read -r -s -p "Agent key for this Mac (starts with sma_): " TOKEN
echo
if [[ ! "$TOKEN" =~ ^sma_[A-Za-z0-9_-]+$ ]]; then
  echo "That doesn't look like an agent key. Create one on the dashboard's Users page."
  exit 1
fi

URL="${SIM_AGENT_URL:-https://sim-monitoring.bewen.me}"
LABEL="me.bewen.sim-agent"
DEST="$HOME/sim-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/sim-agent.log"
# launchd starts with a minimal PATH, so pass the folders where Homebrew installed the tools.
TOOL_PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v adb)"):$(dirname "$(command -v ideviceinfo)"):/usr/bin:/bin"

mkdir -p "$DEST" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp sim-agent.js phone-reader.js package.json "$DEST/"

echo "Sending a test report to $URL ..."
if ! SIM_AGENT_URL="$URL" SIM_AGENT_TOKEN="$TOKEN" PATH="$TOOL_PATH" node "$DEST/sim-agent.js" --once; then
  echo "The test report failed. Check the agent key and the internet connection."
  exit 1
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$DEST/sim-agent.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SIM_AGENT_TOKEN</key><string>$TOKEN</string>
    <key>SIM_AGENT_URL</key><string>$URL</string>
    <key>PATH</key><string>$TOOL_PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
# The file holds the agent key.
chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. The agent now runs in the background and starts at login."
echo "Log file: $LOG"
