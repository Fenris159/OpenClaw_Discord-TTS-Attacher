# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Version numbers match **`package.json`** and **`openclaw.plugin.json`**.

## [0.1.0] - 2026-04-06

### Added

- **OpenClaw Discord plugin** — After the assistant posts a text reply on Discord, synthesize it to **MP3** with Microsoft **Edge neural voices** ([`node-edge-tts`](https://www.npmjs.com/package/node-edge-tts)) and send a **follow-up message** with the audio as a normal **file attachment** (not Discord client TTS).
- **Configuration** — `voice`, `outputDir`, optional **guild channel allowlist**, `maxTextLength`, dedupe and debounce, and **scaled timeouts** for synthesis and gateway pickup (see README and `openclaw.plugin.json` `configSchema`).
- **SDK resolution** — Load OpenClaw’s plugin SDK from the running gateway (walk from host `argv[1]`), from **`OPENCLAW_PACKAGE_ROOT`**, or via an optional **`openclaw`** npm install in the extension folder.
- **Distribution metadata** — `openclaw.compat` / `openclaw.build` in `package.json` for ClawHub and gateway compatibility targets.
- **License** — MIT (`LICENSE`).

[0.1.0]: https://github.com/Fenris159/OpenClaw_Discord-TTS-Attacher/releases/tag/v0.1.0
