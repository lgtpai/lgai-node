#!/usr/bin/env bash
# LGAI Node installer — macOS / Linux / Raspberry Pi
# Usage:
#   ./install.sh [--coordinator URL] [--name NAME] [--service] [--prefix DIR]
#   --service : auto-start on login (launchd on macOS, systemd --user on Linux)
set -euo pipefail

COORD="${LGAI_COORDINATOR:-http://127.0.0.1:18402}"
NODE_NAME="$(hostname -s 2>/dev/null || echo lgai-node)"
PREFIX="${LGAI_HOME:-$HOME/.lgai-node}"
SERVICE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --coordinator) COORD="$2"; shift 2;;
    --name)        NODE_NAME="$2"; shift 2;;
    --prefix)      PREFIX="$2"; shift 2;;
    --service)     SERVICE=1; shift;;
    -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown option: $1" >&2; exit 1;;
  esac
done

say()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- 1. Node.js >= 18 ----
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not found. Install Node 18+:
  macOS:          brew install node
  Debian/Ubuntu:  sudo apt install -y nodejs npm   (or use nvm/nodesource)
  Raspberry Pi:   sudo apt install -y nodejs npm
  Any platform:   https://nodejs.org"
fi
NV="$(node -v | sed 's/^v//; s/\..*//')"
[ "$NV" -ge 18 ] || fail "Node.js >= 18 required (found $(node -v))"
say "Node.js $(node -v)"

# ---- 2. copy files ----
SRC="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SRC/client/lgai-node.js" ] || SRC="$(dirname "$SRC")"   # run from packaging/ or package root
[ -f "$SRC/client/lgai-node.js" ] || fail "cannot locate package files next to install.sh"
mkdir -p "$PREFIX"
cp -R "$SRC/client" "$SRC/coordinator" "$PREFIX/"
cp "$SRC/package.json" "$PREFIX/" 2>/dev/null || true
cp "$SRC"/README*.md "$PREFIX/" 2>/dev/null || true
mkdir -p "$PREFIX/logs"
say "installed to $PREFIX"

# ---- 3. launchers ----
BIN="$HOME/.local/bin"; mkdir -p "$BIN"
cat > "$BIN/lgai-node" <<EOF
#!/bin/sh
exec node "$PREFIX/client/lgai-node.js" "\$@"
EOF
cat > "$BIN/lgai-coordinator" <<EOF
#!/bin/sh
exec node "$PREFIX/coordinator/server.js" "\$@"
EOF
chmod +x "$BIN/lgai-node" "$BIN/lgai-coordinator"
say "launchers: $BIN/lgai-node, $BIN/lgai-coordinator"
case ":$PATH:" in *":$BIN:"*) ;; *)
  echo "  ⚠ add to PATH:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc (or ~/.bashrc)";;
esac

# ---- 4. optional service ----
if [ "$SERVICE" = 1 ]; then
  OS="$(uname -s)"
  if [ "$OS" = "Darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/com.lgai.node.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lgai.node</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v node)</string>
    <string>$PREFIX/client/lgai-node.js</string>
    <string>--coordinator</string><string>$COORD</string>
    <string>--name</string><string>$NODE_NAME</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PREFIX/logs/node.log</string>
  <key>StandardErrorPath</key><string>$PREFIX/logs/node.err</string>
</dict></plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    say "launchd service loaded (com.lgai.node) — logs: $PREFIX/logs/"
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    UNIT_DIR="$HOME/.config/systemd/user"; mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/lgai-node.service" <<EOF
[Unit]
Description=LGAI Node
After=network-online.target

[Service]
ExecStart=$(command -v node) $PREFIX/client/lgai-node.js --coordinator $COORD --name $NODE_NAME
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now lgai-node
    say "systemd user service enabled (lgai-node) — journalctl --user -u lgai-node -f"
  else
    echo "  ⚠ no launchd/systemd available; start manually or via cron:"
    echo "    @reboot $BIN/lgai-node --coordinator $COORD --name $NODE_NAME >> $PREFIX/logs/node.log 2>&1"
  fi
fi

echo
say "done. try it:"
echo "    lgai-node --coordinator $COORD --name $NODE_NAME"
echo "    lgai-node --mock            # offline test"
echo "    lgai-coordinator            # run your own coordinator (dashboard :18402)"
