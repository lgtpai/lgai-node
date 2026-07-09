#!/usr/bin/env bash
# Build cross-platform install packages -> dist/
#   packaging/build.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$(node -p "require('$ROOT/package.json').version")"
OUT="$ROOT/dist"
STAGE="$OUT/stage/lgai-node-$V"
rm -rf "$OUT/stage"
mkdir -p "$STAGE" "$OUT"

cp -R "$ROOT/client" "$ROOT/coordinator" "$STAGE/"
rm -rf "$STAGE/coordinator/data"
cp "$ROOT/package.json" "$ROOT/README.md" "$ROOT/README.zh-CN.md" "$STAGE/"
mkdir -p "$STAGE/packaging"

# unix package
cp "$ROOT/packaging/install.sh" "$ROOT/packaging/uninstall.sh" "$STAGE/"
chmod +x "$STAGE/install.sh" "$STAGE/uninstall.sh"
tar -czf "$OUT/lgai-node-$V-macos-linux.tar.gz" -C "$OUT/stage" "lgai-node-$V"

# windows package
rm -f "$STAGE/install.sh" "$STAGE/uninstall.sh"
cp "$ROOT/packaging/install.ps1" "$ROOT/packaging/uninstall.ps1" "$STAGE/"
(cd "$OUT/stage" && zip -qr "$OUT/lgai-node-$V-windows.zip" "lgai-node-$V")

rm -rf "$OUT/stage"
(cd "$OUT" && (sha256sum lgai-node-$V-* 2>/dev/null || shasum -a 256 lgai-node-$V-*) > checksums.txt)
echo "== dist/"
ls -lh "$OUT"
