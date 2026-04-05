import fs from 'node:fs/promises';
import path from 'node:path';

/** Keep log entries whose leading timestamp is within this window (ms). */
export const WORKER_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

const ENTRY_HEADER_RE = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\]/;

function splitIntoEntries(content) {
  const trimmed = content.replace(/^\uFEFF/, '');
  if (!trimmed) return [];
  const lines = trimmed.split('\n');
  const entries = [];
  let buf = [];
  for (const line of lines) {
    if (ENTRY_HEADER_RE.test(line) && buf.length > 0) {
      entries.push(buf.join('\n'));
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) entries.push(buf.join('\n'));
  return entries;
}

function parseFirstTimestamp(entry) {
  const m = entry.match(/^\[([^\]]+)\]/);
  if (!m) return null;
  const ms = Date.parse(m[1]);
  return Number.isNaN(ms) ? null : ms;
}

async function pruneAndAppend(logPath, newEntryText) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(logPath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const cutoff = Date.now() - WORKER_LOG_RETENTION_MS;
  const entries = splitIntoEntries(existing);
  const kept = entries.filter((e) => {
    const t = parseFirstTimestamp(e);
    return t != null && t >= cutoff;
  });
  const body = (kept.length ? `${kept.join('\n')}\n` : '') + newEntryText;
  const tmp = `${logPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, logPath);
}

/**
 * One logical line after the timestamp: `[ISO] ${line}\n`
 */
export async function appendWorkerLogLine(logPath, line) {
  const stamp = new Date().toISOString();
  await pruneAndAppend(logPath, `[${stamp}] ${line}\n`);
}

/**
 * Multi-line entry whose first line already starts with `[ISO]` (e.g. error + stack).
 */
export async function appendWorkerLogBlock(logPath, block) {
  const normalized = block.endsWith('\n') ? block : `${block}\n`;
  await pruneAndAppend(logPath, normalized);
}
