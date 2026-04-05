import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { appendWorkerLogLine, appendWorkerLogBlock } from './worker-log.mjs';

const require = createRequire(import.meta.url);

function loadEdgeTTS() {
  try {
    return require('node-edge-tts/dist/edge-tts.js').EdgeTTS;
  } catch {
    try {
      return require('node-edge-tts').EdgeTTS;
    } catch (err) {
      throw new Error(
        `discord-tts-attacher worker: install peer dependency node-edge-tts (npm install in the extension directory). ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

const EdgeTTS = loadEdgeTTS();

const MAX_SYNTH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const DEFAULT_SYNTH_TIMEOUT_MS = 60000;

function buildFileBase(jobId) {
  return `discord-tts-attacher-${jobId}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err) {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

async function withTimeout(promise, timeoutMs, label = 'operation') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error('Missing payload argument');
  const payload = JSON.parse(raw);
  const { text, voice, outputDir, to, accountId, logPath, jobId, synthTimeoutMs } = payload;
  if (!jobId) throw new Error('Missing jobId');
  const effectiveSynthTimeoutMs = Number.isFinite(synthTimeoutMs) && synthTimeoutMs > 0 ? Math.floor(synthTimeoutMs) : DEFAULT_SYNTH_TIMEOUT_MS;
  const log = async (line) => {
    if (!logPath) return;
    await appendWorkerLogLine(logPath, line);
  };

  await log(`worker start jobId=${jobId} to=${to} chars=${text.length} voice=${voice} synthTimeoutMs=${effectiveSynthTimeoutMs}`);
  await fs.mkdir(outputDir, { recursive: true });
  const base = buildFileBase(jobId);
  const mp3Path = path.join(outputDir, `${base}.mp3`);
  const donePath = path.join(outputDir, `${base}.done.json`);

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_SYNTH_ATTEMPTS; attempt += 1) {
    try {
      await fs.unlink(mp3Path).catch(() => {});
      await fs.unlink(donePath).catch(() => {});
      await log(`worker synth attempt ${attempt}/${MAX_SYNTH_ATTEMPTS} jobId=${jobId} synthTimeoutMs=${effectiveSynthTimeoutMs}`);
      const synthStart = Date.now();
      const tts = new EdgeTTS({ voice, timeout: effectiveSynthTimeoutMs });
      await withTimeout(tts.ttsPromise(text, mp3Path), effectiveSynthTimeoutMs, 'EdgeTTS synthesis');
      const synthMs = Date.now() - synthStart;
      const stat = await fs.stat(mp3Path);
      await log(`worker synth done jobId=${jobId} attempt=${attempt} path=${mp3Path} bytes=${stat.size} synthMs=${synthMs}`);

      const donePayload = {
        jobId,
        to,
        accountId,
        mp3Path,
        donePath,
        filename: `${base}.mp3`,
        chars: text.length,
        bytes: stat.size,
        createdAt: new Date().toISOString(),
        attempt,
        synthTimeoutMs: effectiveSynthTimeoutMs
      };
      await fs.writeFile(donePath, JSON.stringify(donePayload, null, 2));
      await log(`worker wrote completion marker jobId=${jobId} attempt=${attempt} ${donePath}`);
      return;
    } catch (err) {
      lastError = err;
      await log(`worker synth failed jobId=${jobId} attempt=${attempt} error=${formatError(err)}`);
      await fs.unlink(mp3Path).catch(() => {});
      await fs.unlink(donePath).catch(() => {});
      if (attempt < MAX_SYNTH_ATTEMPTS) {
        await log(`worker retrying jobId=${jobId} after ${RETRY_DELAY_MS}ms`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError ?? new Error('Synthesis failed without error');
}

main().catch(async (err) => {
  const raw = process.argv[2];
  let logPath = '';
  try { logPath = JSON.parse(raw || '{}').logPath || ''; } catch {}
  const line = `[${new Date().toISOString()}] worker error ${err instanceof Error ? `${err.name}: ${err.message}\n${err.stack || ''}` : String(err)}\n`;
  if (logPath) {
    await appendWorkerLogBlock(logPath, line).catch(() => {});
  }
  process.exitCode = 1;
});
