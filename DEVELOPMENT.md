# Discord TTS Attacher — development

This document is for **maintainers**: releases, ClawHub, and how the plugin fits the **`~/.openclaw/extensions/`** layout. **End users** should read **[README.md](README.md)** instead.

## Repository layout

| Location | Purpose |
|----------|---------|
| **Plugin sources** (repository root) | Source of truth: `index.js`, `worker.mjs`, `worker-log.mjs`, `openclaw-resolve.mjs`, `package.json`, `openclaw.plugin.json`, user-facing **[README.md](README.md)**, **[CHANGELOG.md](CHANGELOG.md)** (release notes; copied into the minimal bundle). |
| **`~/.openclaw/extensions/discord-tts-attacher/`** | Typical runtime location. Run **`rm -rf node_modules && npm install`** there (pulls **`node-edge-tts`**; **`openclaw`** is optional). |

## Release version (semver)

| Location | Who reads it |
|----------|----------------|
| **`package.json` → `version`** | **ClawHub** (`clawhub package publish`), npm, and anything that treats this folder as a Node package. This is the **canonical** plugin release semver. |
| **`openclaw.plugin.json` → `version`** | **OpenClaw** when it loads the plugin manifest (same semver as `package.json`). |

Keep them **identical**. After changing **`package.json` → `version`**, update **`openclaw.plugin.json` → `version`** to match.

```bash
npm run check-version
```

**`npm run release`** runs this check automatically before building the output bundle.

**OpenClaw root resolution** (optional): with a file path under a real OpenClaw install (for example the gateway entry script), run:

```bash
npm run test:openclaw-resolve -- /path/to/any/file/under/openclaw
```

Add **`--strict`** if **`loadOpenClawPluginSdk()`** must succeed end-to-end (needs **`npm install`** inside that OpenClaw package so `require()` can load plugin entry + Discord module and their deps, not just an unpacked tarball).

Separate from semver: **`package.json` → `openclaw.build.openclawVersion`** / **`pluginSdkVersion`** record which **OpenClaw** release you built or tested against (calendar-style versions). Bump those when you verify against a newer gateway; they are **not** the plugin’s `1.2.3` release number.

## Config schema and user-facing docs

- **`openclaw.plugin.json`** is the source of truth for which **`plugins.entries.discord-tts-attacher.config`** keys exist and their types. End-user option descriptions live in **[README.md](README.md)** and are copied into minimal plugin packages when you run **`npm run release`**.
- Keep README option names, defaults, and behavior aligned with **`openclaw.plugin.json`** when you add or change settings.

## Timeout behavior (implementation)

The **[README.md](README.md)** configuration table describes what each timeout-related option does. Exact behavior in code:

**Synthesis timeout** (ms), from reply character count `chars`:

`min(synthTimeoutMaxMs, max(1000, synthTimeoutBaseMs + ceil(chars * synthTimeoutPerCharMs) + synthTimeoutJitterMs))`

That value is passed to **`node-edge-tts`** and wrapped in a matching **`Promise.race`** in **`worker.mjs`**.

**Pickup deadline** (ms): the gateway polls every **`pickupIntervalMs`** until the MP3 is ready or this elapses:

`max(pickupTimeoutMs, synthTimeoutMs + pickupIntervalMs + 2000)`

Here **`synthTimeoutMs`** is the synthesis estimate above. So **`pickupTimeoutMs`** is a floor; longer text gets a longer pickup window without raising only the floor.

## Workflow

1. Edit sources at the repository root.  
   Optional: **`npm install`** in the root for **`node-edge-tts`** and maintainer scripts. **`openclaw-resolve.mjs`** loads **`definePluginEntry`** from **`dist/plugin-sdk/plugin-entry.js`** and picks **`sendMessageDiscord`** from **`dist/extensions/discord/runtime-api.js`** (OpenClaw **2026.4+**) or **`dist/plugin-sdk/discord.js`** (legacy). Optional **`npm install openclaw`** if you need the **`openclaw/package.json`** fallback outside a gateway. The **gateway** still uses **`node_modules`** inside **`~/.openclaw/extensions/discord-tts-attacher/`**.

2. **`npm run release`**  
   Refreshes the minimal plugin bundle (plugin sources only, no `node_modules`, no `scripts/`). Copies the root **`README.md`** into that bundle **and** mirrors it one level up as **`release/README.md`**. **`CHANGELOG.md`** is included in the bundle via rsync. The command prints the bundle output directory when it finishes. That output tree is **not committed to git** and is **omitted from ClawHub “publish whole repo” uploads**; generate it whenever you need a zip or a **`clawhub package publish .`** target.

3. **ClawHub (`clawhub package publish`)**  
   Code plugins need **`openclaw.compat.pluginApi`** and **`openclaw.build.openclawVersion`** in **`package.json`** (ClawHub rejects uploads without them). Bump **`openclaw.build.openclawVersion`** / **`pluginSdkVersion`** when you verify against a newer OpenClaw release.

   Publish from the directory printed at the end of **`npm run release`**:

   ```bash
   npm run release
   cd <directory-printed-by-the-command>
   clawhub package publish .
   ```

   To publish from the **repository root** via GitHub, the same **`package.json`** metadata applies; committed ignore rules omit dev-only paths from that upload. Required fields for external code plugins: [ClawHub `openclawContract.ts`](https://github.com/openclaw/clawhub/blob/main/packages/schema/src/openclawContract.ts).

## Documentation for releases

- Update the **root [README.md](README.md)** for anything users should see in minimal packages.
- Run **`npm run release`** so the bundled README stays in sync.
