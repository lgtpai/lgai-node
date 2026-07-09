#!/usr/bin/env bash
# LGAI Node one-line installer (macOS / Linux / Raspberry Pi)
#   curl -fsSL https://raw.githubusercontent.com/lgtpai/lgai-node/main/packaging/get.sh | bash
#   curl -fsSL .../get.sh | bash -s -- --coordinator http://host:8402 --service
set -euo pipefail
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "downloading lgtpai/lgai-node ..."
curl -fsSL https://codeload.github.com/lgtpai/lgai-node/tar.gz/refs/heads/main | tar -xz -C "$TMP"
bash "$TMP"/lgai-node-main/packaging/install.sh "$@"
