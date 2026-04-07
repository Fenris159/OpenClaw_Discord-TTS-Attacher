/**
 * Resolve the OpenClaw npm package root for loading dist/plugin-sdk/* without
 * requiring openclaw in this extension's node_modules.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function isValidOpenClawRoot(dir) {
  const resolved = path.resolve(dir);
  const pkgPath = path.join(resolved, 'package.json');
  const entryPath = path.join(resolved, 'dist', 'plugin-sdk', 'plugin-entry.js');
  if (!existsSync(pkgPath) || !existsSync(entryPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg?.name === 'openclaw';
  } catch {
    return false;
  }
}

/**
 * @returns {string | null} Absolute path to openclaw package root, or null if not found via env/argv walk.
 */
export function resolveOpenClawPackageRoot() {
  const env = process.env.OPENCLAW_PACKAGE_ROOT?.trim();
  if (env) {
    if (!isValidOpenClawRoot(env)) {
      throw new Error(
        `discord-tts-attacher: OPENCLAW_PACKAGE_ROOT is set but is not a valid OpenClaw package (${path.resolve(env)}): need package.json with "name":"openclaw" and dist/plugin-sdk/plugin-entry.js`
      );
    }
    return path.resolve(env);
  }

  const argv1 = process.argv[1];
  if (typeof argv1 === 'string' && argv1.length > 0) {
    try {
      const absFile = realpathSync(argv1);
      let dir = path.dirname(absFile);
      for (;;) {
        if (isValidOpenClawRoot(dir)) return path.resolve(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      /* missing argv path, continue */
    }
  }

  return null;
}

/**
 * Load definePluginEntry + sendMessageDiscord from resolved OpenClaw dist or fallback require.
 */
function resolveDiscordSendPath(openClawRoot) {
  const modern = path.join(openClawRoot, 'dist', 'extensions', 'discord', 'runtime-api.js');
  if (existsSync(modern)) return modern;
  const legacy = path.join(openClawRoot, 'dist', 'plugin-sdk', 'discord.js');
  if (existsSync(legacy)) return legacy;
  return null;
}

export function loadOpenClawPluginSdk() {
  const root = resolveOpenClawPackageRoot();
  if (root) {
    const pluginEntryPath = path.join(root, 'dist', 'plugin-sdk', 'plugin-entry.js');
    const discordPath = resolveDiscordSendPath(root);
    if (!discordPath) {
      throw new Error(
        `discord-tts-attacher: OpenClaw at ${root} has no Discord send API (expected dist/extensions/discord/runtime-api.js or dist/plugin-sdk/discord.js). Upgrade OpenClaw or discord-tts-attacher.`
      );
    }
    return {
      definePluginEntry: require(pluginEntryPath).definePluginEntry,
      sendMessageDiscord: require(discordPath).sendMessageDiscord,
      openClawPackageRoot: root
    };
  }

  try {
    const pkgJsonPath = require.resolve('openclaw/package.json');
    const npmRoot = path.dirname(pkgJsonPath);
    const pluginEntryPath = path.join(npmRoot, 'dist', 'plugin-sdk', 'plugin-entry.js');
    const discordPath = resolveDiscordSendPath(npmRoot);
    if (!discordPath || !existsSync(pluginEntryPath)) {
      throw new Error(`missing plugin-entry or discord send module under ${npmRoot}`);
    }
    return {
      definePluginEntry: require(pluginEntryPath).definePluginEntry,
      sendMessageDiscord: require(discordPath).sendMessageDiscord,
      openClawPackageRoot: npmRoot
    };
  } catch (err) {
    throw new Error(
      `discord-tts-attacher: cannot resolve OpenClaw SDK. Set OPENCLAW_PACKAGE_ROOT to your openclaw package dir, install optional peer openclaw here, or run from a process whose argv[1] lives under the openclaw install. ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
