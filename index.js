import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { appendWorkerLogLine } from './worker-log.mjs';
import { loadOpenClawPluginSdk } from './openclaw-resolve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { definePluginEntry, sendMessageDiscord } = loadOpenClawPluginSdk();
const DEFAULT_VOICE = 'en-US-AndrewNeural';
const DEFAULT_MAX_TEXT_LENGTH = 12000;
const DEFAULT_DEBOUNCE_MS = 3500;
const DEFAULT_PICKUP_INTERVAL_MS = 2000;
const DEFAULT_PICKUP_TIMEOUT_MS = 60000;
/** Drop a second TTS job when the same text is flushed for the same Discord target within this window (double hook / burst-key mismatch). Instant doubles are caught; keep a bit above debounce (3.5s) so two flushes landing together still dedupe. */
const DEFAULT_SEND_DEDUPE_MS = 4000;
const DEFAULT_SYNTH_TIMEOUT_BASE_MS = 4000;
const DEFAULT_SYNTH_TIMEOUT_PER_CHAR_MS = 10;
const DEFAULT_SYNTH_TIMEOUT_JITTER_MS = 5000;
const DEFAULT_SYNTH_TIMEOUT_MAX_MS = 120000;
const FINALIZER_TAG = '[tts-audio-followup]';
const replyBursts = new Map();
/** fingerprint -> last flush timestamp ms */
const recentTtsFlushByFingerprint = new Map();
/** Prevents overlapping pickup callbacks from double-sending the same jobId. */
const pickupSendInFlight = new Set();

function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Same family as OpenClaw REPLY_TAG_RE / AUDIO_TAG_RE — stripped before Discord send, but often still present in llm_output text. */
const OPENCLAW_OUTBOUND_DIRECTIVE_RE =
  /\[\[\s*(?:audio_as_voice|reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]/gi;

function stripOpenClawOutboundDirectives(raw) {
  let s = String(raw ?? '').replace(OPENCLAW_OUTBOUND_DIRECTIVE_RE, ' ');
  s = s.replace(/^\s*reply_to_current\b\s*/i, '');
  s = s.replace(/^\s*reply_to\s*:\s*\S+\s*/i, '');
  return s.trim();
}

/** Default TTS dir: $OPENCLAW_STATE_DIR/workspace/TTS, else ~/.openclaw/workspace/TTS — no hard-coded username. */
function resolveDefaultOutputDir(api) {
  const envOut = process.env.DISCORD_TTS_OUTPUT_DIR?.trim();
  if (envOut) return api.resolvePath(envOut);
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(homedir(), '.openclaw');
  return path.join(stateDir, 'workspace', 'TTS');
}

function resolveConfig(pluginCfg, api) {
  const allow = Array.isArray(pluginCfg?.channelAllowlist) ? pluginCfg.channelAllowlist : null;
  const outputDir =
    typeof pluginCfg?.outputDir === 'string' && pluginCfg.outputDir.trim()
      ? api.resolvePath(pluginCfg.outputDir.trim())
      : resolveDefaultOutputDir(api);
  return {
    enabled: pluginCfg?.enabled !== false,
    voice: typeof pluginCfg?.voice === 'string' && pluginCfg.voice.trim() ? pluginCfg.voice.trim() : DEFAULT_VOICE,
    outputDir,
    channelAllowlist: allow,
    maxTextLength: Number.isInteger(pluginCfg?.maxTextLength) && pluginCfg.maxTextLength > 0 ? pluginCfg.maxTextLength : DEFAULT_MAX_TEXT_LENGTH,
    debounceMs: Number.isInteger(pluginCfg?.debounceMs) && pluginCfg.debounceMs > 0 ? pluginCfg.debounceMs : DEFAULT_DEBOUNCE_MS,
    pickupIntervalMs: Number.isInteger(pluginCfg?.pickupIntervalMs) && pluginCfg.pickupIntervalMs > 0 ? pluginCfg.pickupIntervalMs : DEFAULT_PICKUP_INTERVAL_MS,
    pickupTimeoutMs: Number.isInteger(pluginCfg?.pickupTimeoutMs) && pluginCfg.pickupTimeoutMs > 0 ? pluginCfg.pickupTimeoutMs : DEFAULT_PICKUP_TIMEOUT_MS,
    sendDedupeMs:
      Number.isInteger(pluginCfg?.sendDedupeMs) && pluginCfg.sendDedupeMs >= 0 ? pluginCfg.sendDedupeMs : DEFAULT_SEND_DEDUPE_MS,
    synthTimeoutBaseMs:
      Number.isInteger(pluginCfg?.synthTimeoutBaseMs) && pluginCfg.synthTimeoutBaseMs > 0 ? pluginCfg.synthTimeoutBaseMs : DEFAULT_SYNTH_TIMEOUT_BASE_MS,
    synthTimeoutPerCharMs:
      Number.isFinite(pluginCfg?.synthTimeoutPerCharMs) && pluginCfg.synthTimeoutPerCharMs > 0 ? Number(pluginCfg.synthTimeoutPerCharMs) : DEFAULT_SYNTH_TIMEOUT_PER_CHAR_MS,
    synthTimeoutJitterMs:
      Number.isInteger(pluginCfg?.synthTimeoutJitterMs) && pluginCfg.synthTimeoutJitterMs >= 0 ? pluginCfg.synthTimeoutJitterMs : DEFAULT_SYNTH_TIMEOUT_JITTER_MS,
    synthTimeoutMaxMs:
      Number.isInteger(pluginCfg?.synthTimeoutMaxMs) && pluginCfg.synthTimeoutMaxMs > 0 ? pluginCfg.synthTimeoutMaxMs : DEFAULT_SYNTH_TIMEOUT_MAX_MS
  };
}

function makeBurstKey(parts) {
  const { channelId, accountId, to } = parts;
  return [channelId ?? 'unknown', accountId ?? 'default', to ?? 'unknown'].join('::');
}

/**
 * Derive Discord send target from an agent session key. Shapes follow OpenClaw session-key builders
 * (see dmScope: per-account-channel-peer, per-channel-peer, per-peer).
 */
function parseDiscordRouteFromSessionKey(sessionKey, channelId) {
  const raw = String(sessionKey ?? '').trim().toLowerCase();
  const main = raw.split(':thread:')[0];
  const onDiscordSurface = channelId === 'discord' || raw.includes(':discord:');
  if (!onDiscordSurface) return null;

  // agent:<agentId>:discord:<accountId>:direct:<peerId> (per-account-channel-peer)
  const dmAccount = main.match(/^agent:[^:]+:discord:([^:]+):direct:([0-9]+)$/);
  if (dmAccount) return { accountId: dmAccount[1], to: `user:${dmAccount[2]}` };

  // agent:<agentId>:discord:direct:<peerId> (per-channel-peer — no account segment)
  const dmChannelPeer = main.match(/^agent:[^:]+:discord:direct:([0-9]+)$/);
  if (dmChannelPeer) return { accountId: 'default', to: `user:${dmChannelPeer[1]}` };

  // agent:<agentId>:direct:<peerId> (per-peer; key has no :discord: segment but ctx is still Discord)
  if (channelId === 'discord') {
    const dmPeer = main.match(/^agent:[^:]+:direct:([0-9]+)$/);
    if (dmPeer) return { accountId: 'default', to: `user:${dmPeer[1]}` };
  }

  if (!raw.includes(':discord:')) return null;

  const channelMatches = [...main.matchAll(/channel:([0-9]+)/g)];
  if (channelMatches.length > 0) {
    const id = channelMatches[channelMatches.length - 1][1];
    return { accountId: 'default', to: `channel:${id}` };
  }
  const userMatch = main.match(/:user:([0-9]+)/);
  if (userMatch) return { accountId: 'default', to: `user:${userMatch[1]}` };
  return null;
}

function extractAssistantTextFromLlmOutput(event) {
  const texts = Array.isArray(event?.assistantTexts) ? event.assistantTexts : [];
  const joined = texts
    .map((t) => normalizeText(stripOpenClawOutboundDirectives(String(t ?? ''))))
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return normalizeText(stripOpenClawOutboundDirectives(joined));
}

function channelIdFromDiscordTo(to) {
  const s = String(to ?? '');
  const ch = s.match(/^channel:(\d+)/);
  return ch ? ch[1] : null;
}

function isChannelAllowlisted(cfg, to) {
  const list = cfg.channelAllowlist;
  if (!Array.isArray(list) || list.length === 0) return true;
  const id = channelIdFromDiscordTo(to);
  if (!id) return true;
  const set = new Set(list.map((x) => String(x).trim()).filter(Boolean));
  return set.has(id);
}

function buildJobId(key, combined) {
  const hash = crypto.createHash('sha256').update(`${Date.now()}::${key}::${combined}`).digest('hex').slice(0, 12);
  return `${Date.now()}-${hash}`;
}

function fingerprintTtsFlush(to, combinedText) {
  return crypto
    .createHash('sha256')
    .update(`${String(to ?? '').trim().toLowerCase()}::${combinedText}`)
    .digest('hex')
    .slice(0, 32);
}

function pruneStaleDedupeEntries(windowMs, now) {
  const maxAge = windowMs * 3;
  for (const [k, t] of recentTtsFlushByFingerprint) {
    if (now - t > maxAge) recentTtsFlushByFingerprint.delete(k);
  }
}

/** @returns {boolean} true = skip this flush (duplicate within window). Does not mutate map. */
function isDuplicateTtsFlushPending(cfg, fp, logger, to, combinedText) {
  const windowMs = cfg.sendDedupeMs;
  if (windowMs <= 0) return false;
  const now = Date.now();
  pruneStaleDedupeEntries(windowMs, now);
  const prev = recentTtsFlushByFingerprint.get(fp);
  if (prev != null && now - prev < windowMs) {
    logger?.info?.(
      `discord-tts-attacher: skip duplicate TTS flush fp=${fp.slice(0, 12)}… deltaMs=${now - prev} to=${to ?? 'unknown'} text=${JSON.stringify(combinedText.length > 120 ? `${combinedText.slice(0, 120)}…` : combinedText)}`
    );
    return true;
  }
  return false;
}

function markTtsFlushDedupe(fp) {
  recentTtsFlushByFingerprint.set(fp, Date.now());
}

function releaseTtsFlushDedupe(fp) {
  if (fp) recentTtsFlushByFingerprint.delete(fp);
}

function buildJobPaths(outputDir, jobId) {
  const base = path.join(outputDir, `discord-tts-attacher-${jobId}`);
  return {
    base,
    mp3Path: `${base}.mp3`,
    donePath: `${base}.done.json`
  };
}

function estimateSynthTimeoutMs(cfg, charCount) {
  const chars = Math.max(0, Number(charCount) || 0);
  const estimate = cfg.synthTimeoutBaseMs + Math.ceil(chars * cfg.synthTimeoutPerCharMs) + cfg.synthTimeoutJitterMs;
  return Math.min(cfg.synthTimeoutMaxMs, Math.max(1000, estimate));
}

function computePickupTimeoutMs(cfg, synthTimeoutMs) {
  return Math.max(cfg.pickupTimeoutMs, synthTimeoutMs + cfg.pickupIntervalMs + 2000);
}

function clearBurstTimer(entry) {
  if (entry?.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function destroyBurst(key, reason, logger) {
  const entry = replyBursts.get(key);
  if (!entry) {
    logger?.info?.(`discord-tts-attacher: destroyBurst no-op key=${key} reason=${reason} activeBursts=${replyBursts.size}`);
    return;
  }
  clearBurstTimer(entry);
  replyBursts.delete(key);
  logger?.info?.(`discord-tts-attacher: cleared burst ${key} (${reason}) activeBursts=${replyBursts.size}`);
}

function formatError(err) {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}${err.stack ? ` | stack=${err.stack.replace(/\s+/g, ' ').slice(0, 1500)}` : ''}`;
  }
  return String(err);
}

function safePreview(text, max = 180) {
  const normalized = normalizeText(text);
  return JSON.stringify(normalized.length > max ? `${normalized.slice(0, max)}…` : normalized);
}

async function cleanupJobFiles(jobPaths, logger, reason) {
  const targets = [jobPaths.donePath, jobPaths.mp3Path];
  for (const target of targets) {
    try {
      await fs.unlink(target);
      logger?.info?.(`discord-tts-attacher: cleaned ${target} (${reason})`);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        logger?.warn?.(`discord-tts-attacher: cleanup failed for ${target}: ${formatError(err)}`);
      }
    }
  }
}

async function cleanupStrayJobArtifacts(outputDir, activePaths, logger) {
  try {
    const files = await fs.readdir(outputDir);
    const allowed = new Set([activePaths.donePath, activePaths.mp3Path, path.join(outputDir, 'worker.log')]);
    for (const name of files) {
      const fullPath = path.join(outputDir, name);
      if (allowed.has(fullPath)) continue;
      if (!name.startsWith('discord-tts-attacher-') && !name.startsWith('discord-tts-')) continue;
      if (!(name.endsWith('.mp3') || name.endsWith('.done.json'))) continue;
      try {
        await fs.unlink(fullPath);
        logger?.info?.(`discord-tts-attacher: removed stray artifact ${fullPath}`);
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          logger?.warn?.(`discord-tts-attacher: stray cleanup failed for ${fullPath}: ${formatError(err)}`);
        }
      }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      logger?.warn?.(`discord-tts-attacher: failed to scan output dir for cleanup: ${formatError(err)}`);
    }
  }
}

async function pickupAndSendIfReady(api, jobId, jobPaths) {
  if (pickupSendInFlight.has(jobId)) {
    api.logger.info?.(`discord-tts-attacher: pickup skip already in flight jobId=${jobId}`);
    return false;
  }
  pickupSendInFlight.add(jobId);
  try {
    const raw = await fs.readFile(jobPaths.donePath, 'utf8');
    let done;
    try {
      done = JSON.parse(raw);
    } catch (err) {
      throw new Error(`invalid done.json for jobId=${jobId}: ${formatError(err)}`);
    }
    const stat = await fs.stat(done.mp3Path);
    api.logger.info?.(`discord-tts-attacher: pickup ready jobId=${jobId} donePath=${jobPaths.donePath} mp3=${done.mp3Path} bytes=${stat.size}`);
    const result = await sendMessageDiscord(done.to, `${FINALIZER_TAG} Audio version of my previous reply.`, {
      cfg: api.config,
      accountId: done.accountId,
      mediaUrl: `file://${done.mp3Path}`,
      filename: done.filename
    });
    api.logger.info?.(`discord-tts-attacher: pickup send done jobId=${jobId} messageId=${result?.messageId ?? 'unknown'} file=${done.filename}`);
    await cleanupJobFiles(jobPaths, api.logger, 'post-send');
    await cleanupStrayJobArtifacts(path.dirname(jobPaths.donePath), jobPaths, api.logger);
    return true;
  } finally {
    pickupSendInFlight.delete(jobId);
  }
}

async function startPickupLoop(api, cfg, jobId, jobPaths, dedupeFp, jobPickupTimeoutMs) {
  const startedAt = Date.now();
  const timer = setInterval(async () => {
    try {
      const elapsed = Date.now() - startedAt;
      if (elapsed > jobPickupTimeoutMs) {
        clearInterval(timer);
        api.logger.warn?.(`discord-tts-attacher: pickup loop timed out jobId=${jobId} after ${jobPickupTimeoutMs}ms`);
        releaseTtsFlushDedupe(dedupeFp);
        await cleanupJobFiles(jobPaths, api.logger, 'timeout');
        await cleanupStrayJobArtifacts(cfg.outputDir, jobPaths, api.logger);
        return;
      }
      try {
        await fs.access(jobPaths.donePath);
      } catch {
        api.logger.info?.(`discord-tts-attacher: pickup loop waiting jobId=${jobId} (${elapsed}ms elapsed)`);
        return;
      }
      clearInterval(timer);
      api.logger.info?.(`discord-tts-attacher: attempting pickup jobId=${jobId} from ${jobPaths.donePath}`);
      try {
        await pickupAndSendIfReady(api, jobId, jobPaths);
      } catch (err) {
        api.logger.warn?.(`discord-tts-attacher: pickup/send failed jobId=${jobId}: ${formatError(err)}`);
        releaseTtsFlushDedupe(dedupeFp);
        await cleanupJobFiles(jobPaths, api.logger, 'send-failed');
        await cleanupStrayJobArtifacts(cfg.outputDir, jobPaths, api.logger);
      }
    } catch (err) {
      api.logger.warn?.(`discord-tts-attacher: pickup loop error jobId=${jobId}: ${formatError(err)}`);
      clearInterval(timer);
      releaseTtsFlushDedupe(dedupeFp);
      await cleanupJobFiles(jobPaths, api.logger, 'send-failed');
      await cleanupStrayJobArtifacts(cfg.outputDir, jobPaths, api.logger);
    }
  }, cfg.pickupIntervalMs);
}

var discord_tts_attacher_default = definePluginEntry({
  id: 'discord-tts-attacher',
  name: 'Discord TTS Attacher',
  description: 'Synthesize outbound Discord replies to MP3 via Edge TTS and attach as a follow-up message.',
  register(api) {
    const cfg = resolveConfig(api.pluginConfig ?? {}, api);
    api.logger.info?.(`discord-tts-attacher: register enabled=${cfg.enabled} voice=${cfg.voice} outputDir=${cfg.outputDir} activeBursts=${replyBursts.size}`);

    async function flushBurst(key) {
      const entry = replyBursts.get(key);
      if (!entry) {
        api.logger.info?.(`discord-tts-attacher: flush skipped missing burst key=${key} activeBursts=${replyBursts.size}`);
        return;
      }
      clearBurstTimer(entry);
      const combined = normalizeText(stripOpenClawOutboundDirectives(entry.parts.filter(Boolean).join('\n\n')));
      api.logger.info?.(`discord-tts-attacher: flushing burst ${key} with ${entry.parts.length} chunk(s), chars=${combined.length} activeBursts=${replyBursts.size}`);
      if (!combined) {
        destroyBurst(key, 'empty-combined-text', api.logger);
        return;
      }
      if (combined.length > cfg.maxTextLength) {
        api.logger.info?.(`discord-tts-attacher: skipping long combined reply (${combined.length} chars)`);
        destroyBurst(key, 'too-long', api.logger);
        return;
      }
      const dedupeFp = cfg.sendDedupeMs > 0 ? fingerprintTtsFlush(entry.to, combined) : null;
      if (dedupeFp && isDuplicateTtsFlushPending(cfg, dedupeFp, api.logger, entry.to, combined)) {
        destroyBurst(key, 'send-dedupe', api.logger);
        return;
      }
      if (dedupeFp) markTtsFlushDedupe(dedupeFp);
      try {
        const jobId = buildJobId(key, combined);
        const jobPaths = buildJobPaths(cfg.outputDir, jobId);
        const logPath = path.join(cfg.outputDir, 'worker.log');
        const synthTimeoutMs = estimateSynthTimeoutMs(cfg, combined.length);
        const jobPickupTimeoutMs = computePickupTimeoutMs(cfg, synthTimeoutMs);
        const payload = {
          jobId,
          text: combined,
          voice: cfg.voice,
          outputDir: cfg.outputDir,
          to: entry.to,
          accountId: entry.accountId,
          logPath,
          synthTimeoutMs
        };
        await cleanupStrayJobArtifacts(cfg.outputDir, jobPaths, api.logger);
        await appendWorkerLogLine(
          logPath,
          `plugin flush handoff key=${key} jobId=${jobId} to=${entry.to} chars=${combined.length} synthTimeoutMs=${synthTimeoutMs} pickupTimeoutMs=${jobPickupTimeoutMs}`
        );
        const child = spawn(process.execPath, [path.join(__dirname, 'worker.mjs'), JSON.stringify(payload)], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        api.logger.info?.(`discord-tts-attacher: worker spawned pid=${child.pid ?? 'unknown'} for ${key} jobId=${jobId} synthTimeoutMs=${synthTimeoutMs} pickupTimeoutMs=${jobPickupTimeoutMs}`);
        void startPickupLoop(api, cfg, jobId, jobPaths, dedupeFp, jobPickupTimeoutMs);
        destroyBurst(key, 'worker-spawned', api.logger);
      } catch (err) {
        releaseTtsFlushDedupe(dedupeFp);
        api.logger.warn?.(`discord-tts-attacher: worker spawn failed: ${formatError(err)}`);
        destroyBurst(key, 'worker-spawn-failed', api.logger);
      }
    }

    function bufferOutboundDiscordText(source, text, to, accountId) {
      text = normalizeText(stripOpenClawOutboundDirectives(String(text ?? '')));
      const channelId = 'discord';
      const key = makeBurstKey({ channelId, accountId, to });
      api.logger.info?.(
        `discord-tts-attacher: ${source} enter key=${key} to=${to ?? 'unknown'} accountId=${accountId ?? 'unknown'} text=${safePreview(text)} activeBursts=${replyBursts.size}`
      );

      if (!cfg.enabled) {
        api.logger.info?.(`discord-tts-attacher: ${source} skip disabled key=${key}`);
        return;
      }
      if (!text) {
        api.logger.info?.(`discord-tts-attacher: ${source} skip empty text key=${key}`);
        return;
      }
      if (text === 'NO_REPLY' || text === 'HEARTBEAT_OK') {
        api.logger.info?.(`discord-tts-attacher: ${source} skip control text key=${key} text=${safePreview(text)}`);
        return;
      }
      if (text.includes(FINALIZER_TAG)) {
        api.logger.info?.(`discord-tts-attacher: ${source} skip finalizer key=${key}`);
        return;
      }
      if (!isChannelAllowlisted(cfg, to)) {
        api.logger.info?.(`discord-tts-attacher: ${source} skip channel allowlist key=${key} to=${to ?? 'unknown'}`);
        return;
      }

      let entry = replyBursts.get(key);
      if (!entry) {
        entry = {
          to,
          accountId,
          parts: [],
          timer: null
        };
        replyBursts.set(key, entry);
        api.logger.info?.(`discord-tts-attacher: created burst ${key} activeBursts=${replyBursts.size}`);
      } else {
        api.logger.info?.(`discord-tts-attacher: reusing burst ${key} existingParts=${entry.parts.length} timerActive=${entry.timer ? 'yes' : 'no'} activeBursts=${replyBursts.size}`);
      }

      entry.parts.push(text);
      api.logger.info?.(`discord-tts-attacher: buffered chunk ${entry.parts.length} for ${key} text=${safePreview(text, 400)}`);
      clearBurstTimer(entry);
      entry.timer = setTimeout(() => {
        flushBurst(key).catch((err) => {
          api.logger.warn?.(`discord-tts-attacher: flush error for ${key}: ${formatError(err)}`);
          destroyBurst(key, 'flush-exception', api.logger);
        });
      }, cfg.debounceMs);
      api.logger.info?.(`discord-tts-attacher: scheduled flush in ${cfg.debounceMs}ms for ${key} activeBursts=${replyBursts.size}`);
    }

    /**
     * Normal Discord chat + thread replies are delivered via deliverDiscordReply / stream edits, which do not
     * emit message_sent. llm_output runs after the model turn and carries the same assistant text.
     * Heartbeat/cron still use deliverOutboundPayloads → message_sent; skip those triggers here to avoid double TTS.
     */
    api.on('llm_output', async (event, ctx) => {
      if (!cfg.enabled) return;
      if (ctx.channelId !== 'discord') return;
      if (ctx.trigger === 'heartbeat' || ctx.trigger === 'cron') {
        api.logger.info?.(`discord-tts-attacher: llm_output skip trigger=${ctx.trigger ?? 'unknown'} (use message_sent)`);
        return;
      }
      const route = parseDiscordRouteFromSessionKey(ctx.sessionKey, ctx.channelId);
      if (!route?.to) {
        api.logger.info?.(`discord-tts-attacher: llm_output skip no route sessionKey=${JSON.stringify(ctx.sessionKey ?? '')}`);
        return;
      }
      const text = extractAssistantTextFromLlmOutput(event);
      bufferOutboundDiscordText('llm_output', text, route.to, route.accountId);
    });

    api.on('message_sent', async (event, ctx) => {
      const text = normalizeText(stripOpenClawOutboundDirectives(String(event.content ?? '')));
      const key = makeBurstKey({
        channelId: ctx.channelId,
        accountId: ctx.accountId,
        to: event.to
      });
      api.logger.info?.(
        `discord-tts-attacher: message_sent enter key=${key} success=${event.success === true} channelId=${ctx.channelId ?? 'unknown'} accountId=${ctx.accountId ?? 'unknown'} to=${event.to ?? 'unknown'} text=${safePreview(text)} activeBursts=${replyBursts.size}`
      );

      if (ctx.channelId !== 'discord') {
        api.logger.info?.(`discord-tts-attacher: message_sent skip non-discord key=${key} channelId=${ctx.channelId ?? 'unknown'}`);
        return;
      }
      if (!event.success) {
        api.logger.info?.(`discord-tts-attacher: message_sent skip unsuccessful key=${key}`);
        return;
      }
      bufferOutboundDiscordText('message_sent', text, event.to, ctx.accountId);
    });
  }
});

export { discord_tts_attacher_default as default };
