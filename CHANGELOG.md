# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Version numbers match **`package.json`** and **`openclaw.plugin.json`**.

## [0.1.1] - 2026-04-07

### Fixed

- **OpenClaw 2026.4+ Discord API path** — OpenClaw removed **`dist/plugin-sdk/discord.js`**; **`sendMessageDiscord`** now lives under **`dist/extensions/discord/runtime-api.js`**. Resolution tries that path first and falls back to the legacy **`dist/plugin-sdk/discord.js`** for older installs (`openclaw-resolve.mjs`).
- **npm / non-argv installs** — When package-root walk fails, the plugin resolves the **`openclaw`** package via **`openclaw/package.json`** and loads Discord send from the same modern/legacy layout (instead of relying on non-existent **`openclaw`** export paths for **`plugin-sdk/discord`**).

### Changed

- **README** — Document intentional **`child_process.spawn`** use for the bundled **`worker.mjs`** (footnote for reviewers / scanners such as ClawHub). Clarify **MIT** in the License section. Align SDK resolution wording with OpenClaw **2026.4+** (**`runtime-api.js`** vs legacy **`discord.js`**) and **`openclaw/package.json`** fallback.
- **DEVELOPMENT** — Repository layout and **`npm run release`** description updated for **`CHANGELOG.md`** in the bundle and accurate **`openclaw-resolve.mjs`** behavior.

## [0.1.0] - 2026-04-06

### Added

- **OpenClaw Discord plugin** — After the assistant posts a text reply on Discord, synthesize it to **MP3** with Microsoft **Edge neural voices** ([`node-edge-tts`](https://www.npmjs.com/package/node-edge-tts)) and send a **follow-up message** with the audio as a normal **file attachment** (not Discord client TTS).
- **Configuration** — `voice`, `outputDir`, optional **guild channel allowlist**, `maxTextLength`, dedupe and debounce, and **scaled timeouts** for synthesis and gateway pickup (see README and `openclaw.plugin.json` `configSchema`).
- **SDK resolution** — Load OpenClaw’s plugin SDK from the running gateway (walk from host `argv[1]`), from **`OPENCLAW_PACKAGE_ROOT`**, or via an optional **`openclaw`** npm install in the extension folder.
- **Distribution metadata** — `openclaw.compat` / `openclaw.build` in `package.json` for ClawHub and gateway compatibility targets.
- **License** — MIT (`LICENSE`).

[0.1.1]: https://github.com/Fenris159/OpenClaw_Discord-TTS-Attacher/releases/tag/v0.1.1
[0.1.0]: https://github.com/Fenris159/OpenClaw_Discord-TTS-Attacher/releases/tag/v0.1.0
