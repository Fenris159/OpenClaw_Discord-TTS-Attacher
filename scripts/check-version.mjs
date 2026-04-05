#!/usr/bin/env node
/**
 * Ensures openclaw.plugin.json "version" matches package.json "version".
 * ClawHub/npm use package.json; OpenClaw reads the plugin manifest.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
const pv = typeof pkg.version === "string" ? pkg.version.trim() : "";
const mv = typeof manifest.version === "string" ? manifest.version.trim() : "";

if (!pv) {
  console.error("check-version: package.json is missing a non-empty \"version\".");
  process.exit(1);
}
if (!mv) {
  console.error(
    `check-version: openclaw.plugin.json is missing \"version\". Set it to the same semver as package.json (currently ${pv}).`,
  );
  process.exit(1);
}
if (pv !== mv) {
  console.error(
    `check-version: version mismatch.\n  package.json          -> "${pv}"\n  openclaw.plugin.json -> "${mv}"\nBump both to the same semver (package.json is the source of truth).`,
  );
  process.exit(1);
}

console.log(`check-version: ${pv} (package.json + openclaw.plugin.json)`);
