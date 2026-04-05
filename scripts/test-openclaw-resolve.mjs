#!/usr/bin/env node
/**
 * Verify OpenClaw package root resolution (argv[1] walk or env).
 *
 * Usage:
 *   node scripts/test-openclaw-resolve.mjs <path-to-any-file-under-openclaw-install>
 *
 * Example:
 *   node scripts/test-openclaw-resolve.mjs "$(npm root -g)/openclaw/dist/gateway-cli.mjs"
 *
 * By default: require() of dist/plugin-sdk may fail if that openclaw tree has no
 * npm install (resolution + on-disk layout still pass). Use --strict to exit 1
 * when require fails.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const strict = process.argv.includes('--strict');
const args = process.argv.filter((a) => a !== '--strict');
const entry = args[2];
if (!entry) {
  console.error(
    'usage: node scripts/test-openclaw-resolve.mjs [--strict] <path-to-file-under-openclaw-tree>',
  );
  process.exit(1);
}

process.argv[1] = path.resolve(entry);

const here = path.dirname(fileURLToPath(import.meta.url));
const { resolveOpenClawPackageRoot, loadOpenClawPluginSdk } = await import(
  pathToFileURL(path.join(here, '..', 'openclaw-resolve.mjs')).href,
);

const root = resolveOpenClawPackageRoot();
console.log('resolveOpenClawPackageRoot():', root);
if (!root) {
  console.error('FAILED: could not resolve openclaw package root');
  process.exit(1);
}

const pe = path.join(root, 'dist', 'plugin-sdk', 'plugin-entry.js');
const disc = path.join(root, 'dist', 'plugin-sdk', 'discord.js');
if (!existsSync(pe) || !existsSync(disc)) {
  console.error('FAILED: missing dist/plugin-sdk files under', root);
  process.exit(1);
}
console.log('layout OK:', pe);

try {
  const sdk = loadOpenClawPluginSdk();
  console.log('loadOpenClawPluginSdk OK — definePluginEntry:', typeof sdk.definePluginEntry);
  console.log('loadOpenClawPluginSdk OK — sendMessageDiscord:', typeof sdk.sendMessageDiscord);
  console.log('openClawPackageRoot:', sdk.openClawPackageRoot ?? '(npm fallback)');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    'WARN: root resolved but require(dist/plugin-sdk) failed (install deps under that openclaw package, or use a full global install):',
    msg,
  );
  if (strict) process.exit(1);
}
