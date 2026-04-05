#!/usr/bin/env bash
# Build release/discord-tts-attacher/ — minimal plugin tree for zip, manual share, or
#   clawhub package publish ./release/discord-tts-attacher
# (see DEVELOPMENT.md). No node_modules or dev-only files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release/discord-tts-attacher"
node "$ROOT/scripts/check-version.mjs"
mkdir -p "$OUT"
rsync -a --delete \
  --exclude scripts \
  --exclude release \
  --exclude .git \
  --exclude .cursor \
  --exclude node_modules \
  --exclude '*.code-workspace' \
  --exclude '.DS_Store' \
  --exclude README.md \
  --exclude DEVELOPMENT.md \
  --exclude .gitignore \
  --exclude .clawhubignore \
  --exclude package-lock.json \
  "$ROOT/" "$OUT/"
ROOT="$ROOT" OUT="$OUT" node -e "
const fs = require('fs');
const path = require('path');
const root = process.env.ROOT;
const outDir = process.env.OUT;
const pkgPath = path.join(outDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
delete pkg.scripts;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
"
cp -f "$ROOT/README.md" "$OUT/README.md"
cp -f "$ROOT/README.md" "$ROOT/release/README.md"
cp -f "$ROOT/index.js" "$OUT/index.js"
cp -f "$ROOT/worker.mjs" "$OUT/worker.mjs"
cp -f "$ROOT/worker-log.mjs" "$OUT/worker-log.mjs"
cp -f "$ROOT/openclaw-resolve.mjs" "$OUT/openclaw-resolve.mjs"
rm -f "$OUT/package-lock.json"
echo "Release bundle ready: $OUT"
