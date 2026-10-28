// Key storage — same files and format as scripts/hashscraper.py of the Agent Skill, so both tools share one login.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { credentialsPath, pendingPath, runPendingPath, type Runtime } from './api.ts';

export interface KeyLookup {
  key?: string;
  source?: 'env' | 'saved';
  /** why a saved key was not used (shown to the user, never contains the key) */
  note?: string;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** HASHSCRAPER_API_KEY first, else the key saved by `login` — used only with the server it came from. */
export function findKey(rt: Runtime): KeyLookup {
  if (rt.envKey) return { key: rt.envKey, source: 'env' };
  const data = readJson(credentialsPath(rt));
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const savedBase = String(data.base_url || '').replace(/\/+$/, '');
  if (savedBase !== rt.baseUrl) {
    return { note: `The saved key belongs to ${data.base_url}, not ${rt.baseUrl}. It was not used. Call the \`login\` tool for this server (or set HASHSCRAPER_API_KEY).` };
  }
  const key = String(data.api_key || '').trim();
  return key ? { key, source: 'saved' } : {};
}

/** Write JSON readable only by the user (folder 0700, file 0600), replacing the old file in one step. */
export function writePrivate(path: string, payload: unknown): void {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

export function removeQuietly(path: string): void {
  rmSync(path, { force: true });
}

function localIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

export function saveKey(rt: Runtime, data: { api_key: string; key_name?: string | null; expires_at?: string | null }): void {
  writePrivate(credentialsPath(rt), {
    api_key: data.api_key,
    key_name: data.key_name ?? null,
    expires_at: data.expires_at ?? null,
    base_url: rt.baseUrl,
    saved_at: localIso(new Date(rt.now())),
  });
}

export interface Pending {
  device_code: string;
  interval: number;
  /** epoch seconds */
  deadline: number;
  base_url: string;
}

export function readPending(rt: Runtime): Pending | undefined {
  const data = readJson(pendingPath(rt));
  if (!data || typeof data !== 'object' || typeof data.device_code !== 'string') return undefined;
  return data as Pending;
}

export function writePending(rt: Runtime, pending: Pending): void {
  writePrivate(pendingPath(rt), pending);
}

export function clearPending(rt: Runtime): void {
  removeQuietly(pendingPath(rt));
}

/** Idempotency-Keys of collection starts whose answer never arrived, one per request fingerprint. */
export interface RunPendingEntry {
  idempotency_key: string;
  /** epoch milliseconds */
  saved_at: number;
}

export function readRunPending(rt: Runtime): Record<string, RunPendingEntry> {
  const data = readJson(runPendingPath(rt));
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const entries: Record<string, RunPendingEntry> = {};
  for (const [fingerprint, entry] of Object.entries<any>(data)) {
    if (entry && typeof entry.idempotency_key === 'string' && typeof entry.saved_at === 'number') entries[fingerprint] = entry;
  }
  return entries;
}

/** Keep only fresh entries; remove the file when none are left. */
export function writeRunPending(rt: Runtime, entries: Record<string, RunPendingEntry>, maxAgeMs: number): void {
  const fresh = Object.fromEntries(Object.entries(entries).filter(([, e]) => rt.now() - e.saved_at < maxAgeMs));
  if (Object.keys(fresh).length) writePrivate(runPendingPath(rt), fresh);
  else removeQuietly(runPendingPath(rt));
}
