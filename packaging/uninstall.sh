#!/usr/bin/env bash
# LGAI Node uninstaller — macOS / Linux
set -u
PREFIX="${LGAI_HOME:-$HOME/.lgai-node}"
if [ "$(uname -s)" = "Darwin" ]; then
  launchctl unload "$HOME/Library/LaunchAgents/com.lgai.node.plist" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/com.lgai.node.plist"
elif command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now lgai-node 2>/dev/null
  rm -f "$HOME/.config/systemd/user/lgai-node.service"
  systemctl --user daemon-reload 2>/dev/null
fi
rm -f "$HOME/.local/bin/lgai-node" "$HOME/.local/bin/lgai-coordinator"
rm -rf "$PREFIX"
echo "removed $PREFIX (node credentials in ~/.lgai/ kept; delete manually if needed)"
