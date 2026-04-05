#!/usr/bin/env bash
# Copy plugin sources from this dev tree into ~/.openclaw/extensions/discord-tts-attacher (OpenClaw runtime).
# Does not remove existing node_modules. Re-run: npm install
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/.openclaw/extensions/discord-tts-attacher}"
mkdir -p "$DEST"
rsync -a \
  --exclude scripts \
  --exclude release \
  --exclude .git \
  --exclude .cursor \
  --exclude node_modules \
  --exclude '*.code-workspace' \
  --exclude README.md \
  --exclude DEVELOPMENT.md \
  --exclude .gitignore \
  --exclude .clawhubignore \
  --exclude package-lock.json \
  "$ROOT/" "$DEST/"
echo "Synced $ROOT -> $DEST"
echo "If needed: (cd \"$DEST\" && npm install)"
