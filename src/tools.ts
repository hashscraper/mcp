// The seven tools. Each handler returns an MCP tool result: { content: [{ type: 'text', text }], isError? }.
// No dependencies — src/index.ts only wires these to the MCP SDK. Behaviour mirrors scripts/hashscraper.py of the Agent Skill.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiError, BOT_CATALOG, call, defaultRuntime, FOOTER, HELP_EMAIL, HELP_HINT, LOGIN_HINT, NetworkError,
  SIGN_UP, SITE, UTM, type Runtime,
} from './api.ts';
import {
  clearPending, findKey, readPending, readRunPending, saveKey, writePending, writeRunPending,
} from './credentials.ts';

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const ENDED = ['done', 'attention', 'failed', 'canceled'];
const MAX_TEXT_CHARS = 60_000;
const MAX_CATALOG_LINES = 30;
const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 55;

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Raised inside a handler to stop with a message for the agent. */
class Stop extends Error {
  result: ToolResult;
  constructor(result: ToolResult) {
    super('stop');
    this.result = result;
  }
}

/* ---------- key, errors ---------- */

function requireKey(rt: Runtime): string {
  const found = findKey(rt);
  if (found.key) return found.key;
  throw new Stop(fail([
    ...(found.note ? [found.note] : []),
    `Not connected yet. ${LOGIN_HINT} (free sign-up included), or set HASHSCRAPER_API_KEY to a key from My page -> API.`,
  ].join('\n')));
}

function termsText(terms: Record<string, any>): string {
  return [
    'Before the first tool call that uses credits, the user must agree to the HashScraper data terms (nothing was collected or charged):',
    `  ${terms.text_en}`,
    `  ${terms.text}`,
    `  ${terms.url} (version ${terms.version})`,
    `Show these terms to the user. Only after the user clearly agrees, call the same tool again with accept_terms="${terms.version}". Never agree for the user.`,
  ].join('\n');
}

function termsLine(terms?: Record<string, any>): string {
  return terms ? `Terms: ${terms.text_en} ${terms.text} ${terms.url}` : '';
}

/** An API error as text for the agent, with what to do next. Limit errors are final for this call — never retry in a loop. */
export function explain(rt: Runtime, error: ApiError): ToolResult {
  if (error.code === 'TERMS_ACCEPTANCE_REQUIRED') return fail(termsText(error.details.terms || {}));
  const details = error.details;
  const lines = [`HashScraper API error — ${error.code}: ${error.serverMessage}`];
  if (error.code === 'DAILY_FREE_USED_UP') {
    if (details.hint) lines.push(details.hint);
    lines.push(`Free credits refill at ${details.resets_at || 'midnight KST'}. Your own credits: ${details.balance ?? '?'}. ` +
      'Call the same tool again with use_credits=true only if the user wants to spend their own credits.');
  } else if (error.code === 'CREDIT_EXHAUSTED' || error.code === 'TICKET_EXPIRED') {
    lines.push(`Top up credits at ${SITE}/plans?${UTM}`);
  } else if (error.code === 'MISSING_API_KEY' || error.code === 'INVALID_API_KEY') {
    lines.push(rt.envKey
      ? 'Check HASHSCRAPER_API_KEY (My page -> API). It is used before the key saved by login.'
      : `The saved key was turned off, deleted or expired. ${LOGIN_HINT} again.`);
  } else if (error.code === 'RATE_LIMITED') {
    lines.push(`Too many requests (or 5 data requests today). Wait a while — data requests reset at midnight KST — or email ${HELP_EMAIL}.`);
  } else if (error.code === 'CATEGORY_NOT_AVAILABLE') {
    if (Array.isArray(details.available) && details.available.length) {
      lines.push(`Available categories: ${details.available.join(', ')} (see the coupang_categories tool)`);
    }
    lines.push(`To ask for another category, email ${HELP_EMAIL} with the Coupang category URL or id.`);
  } else if (error.code === 'DATA_NOT_READY') {
    lines.push('No credits were used. The daily snapshot is not finished yet — try again later.');
  } else if (error.code === 'BOT_MAINTENANCE') {
    lines.push('The bot is being fixed. Try another bot or try later.');
  } else if (Object.keys(details).length) {
    lines.push(JSON.stringify(details));
  }
  return fail(lines.join('\n'));
}

/** Run a handler body; turn every known failure into a tool result with isError. Never puts the key in a message. */
function errorResult(rt: Runtime, e: unknown): ToolResult {
  if (e instanceof Stop) return e.result;
  if (e instanceof ApiError) return explain(rt, e);
  if (e instanceof NetworkError) return fail(`${e.message} Try again in a moment.`);
  return fail('Unexpected error in the HashScraper MCP server. Try again; if it repeats, email ' + HELP_EMAIL + '.');
}

async function guarded(rt: Runtime, body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (e) {
    return errorResult(rt, e);
  }
}

/* ---------- output helpers ---------- */

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows as a CSV file (UTF-8 with BOM so Excel reads Korean). Only absolute paths ending in .csv — no overwriting other files. */
function writeCsv(rows: Record<string, any>[], csvPath: string): string {
  if (!isAbsolute(csvPath) || !csvPath.toLowerCase().endsWith('.csv')) {
    throw new Stop(fail('csv_path must be an absolute path ending in .csv (nothing was written). The collection itself is not affected.'));
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(','))];
  try {
    writeFileSync(csvPath, '﻿' + lines.join('\r\n') + '\r\n', 'utf-8');
  } catch (e) {
    throw new Stop(fail(`Could not write ${csvPath} (${(e as NodeJS.ErrnoException).code || 'error'}). Pick another absolute .csv path.`));
  }
  return `${rows.length} rows -> ${csvPath}`;
}

/** Rows as JSON lines, at most maxRows and about MAX_TEXT_CHARS characters. */
function rowsText(rows: Record<string, any>[], maxRows: number): string {
  const lines: string[] = [];
  let size = 0;
  for (const row of rows.slice(0, maxRows)) {
    const line = JSON.stringify(row);
    if (size + line.length > MAX_TEXT_CHARS && lines.length > 0) break;
    lines.push(line);
    size += line.length + 1;
  }
  const head = lines.length < rows.length
    ? `Showing the first ${lines.length} of ${rows.length} rows (raise max_rows, or set csv_path to save all rows to a file):`
    : `${rows.length} rows:`;
  return [head, ...lines].join('\n');
}

function deliverRows(rows: Record<string, any>[], maxRows: number, csvPath?: string): string {
  return csvPath ? writeCsv(rows, csvPath) : rowsText(rows, maxRows);
}

const clampWait = (seconds: number | undefined) => Math.min(Math.max(Math.floor(seconds ?? DEFAULT_WAIT_SECONDS), 0), MAX_WAIT_SECONDS);
const clampRows = (n: number | undefined) => Math.max(Math.floor(n ?? 100), 1);

/* ---------- catalog ---------- */

interface CatalogInput { key: string; name?: string; name_en?: string; example?: string | null; options?: any[] }
interface CatalogBot {
  worker: string; name: string; site?: string; site_en?: string; summary?: string | null; summary_ko?: string | null;
  credits_per_row: number; inputs: CatalogInput[]; fail_rate_7d?: number;
}

function loadCatalog(): CatalogBot[] {
  const path = fileURLToPath(new URL('../catalog.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf-8')).bots as CatalogBot[];
}

/** { "Keyword": "x", "param5": 50 } -> { param1: "x", param5: "50" } — keys by param name or by the input's name / English name. */
function parseInputs(raw: Record<string, unknown> | undefined, entry: CatalogBot | undefined): Record<string, string> {
  const names = new Map<string, string>();
  for (const item of entry?.inputs ?? []) {
    for (const label of [item.key, item.name, item.name_en]) if (label) names.set(label.trim().toLowerCase(), item.key);
  }
  const inputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    const label = name.trim();
    const key = names.get(label.toLowerCase()) || (label.startsWith('param') ? label : undefined);
    if (!key) {
      throw new Stop(fail(`Unknown input ${JSON.stringify(name)}. Use the catalog tool to see the inputs of ${entry?.worker ?? 'the bot'}.`));
    }
    inputs[key] = Array.isArray(value) ? value.map(String).join('\n') : String(value);
  }
  return inputs;
}

export async function catalogTool(_rt: Runtime, args: { search?: string }): Promise<ToolResult> {
  let bots = loadCatalog();
  const needle = (args.search || '').trim().toLowerCase();
  if (needle) bots = bots.filter((bot) => JSON.stringify(bot).toLowerCase().includes(needle));
  const lines = bots.slice(0, MAX_CATALOG_LINES).map((bot) => {
    const inputs = bot.inputs.map((i) => `${i.key}=${i.name_en || i.name}${i.example ? ` (e.g. ${JSON.stringify(i.example)})` : ''}`).join(', ');
    const fail7 = bot.fail_rate_7d ? ` · failed ${Math.round(bot.fail_rate_7d * 100)}% of runs in 7 days` : '';
    return `${bot.worker}  [${bot.site_en || bot.site}] ${bot.name}  ${bot.credits_per_row} credits/row${fail7}\n    ${bot.summary || bot.summary_ko || ''}\n    inputs: ${inputs}`;
  });
  const more = bots.length > MAX_CATALOG_LINES ? `\n${bots.length - MAX_CATALOG_LINES} more matches — narrow the search.` : '';
  if (bots.length === 0) return ok(`No bot matches ${JSON.stringify(args.search)}. ${HELP_HINT}`);
  return ok(`${bots.length} bots${needle ? ` match ${JSON.stringify(args.search)}` : ''}. Pass the worker name to the run tool.\n\n${lines.join('\n')}${more}`);
}

/* ---------- login ---------- */

export async function loginTool(rt: Runtime, args: { restart?: boolean }): Promise<ToolResult> {
  return guarded(rt, async () => {
    const envNote = rt.envKey ? '\nNote: HASHSCRAPER_API_KEY is set, so it is used before the saved key.' : '';
    if (args.restart) clearPending(rt);
    let expiredNote = '';
    let pending = readPending(rt);
    if (pending && String(pending.base_url || '').replace(/\/+$/, '') !== rt.baseUrl) {
      clearPending(rt);
      pending = undefined;
    }
    if (pending && rt.now() / 1000 >= Number(pending.deadline)) {
      clearPending(rt);
      pending = undefined;
      expiredNote = 'The earlier code expired before it was approved. Starting a new login.\n\n';
    }
    if (!pending) return startLogin(rt, expiredNote, envNote);
    return waitLogin(rt, pending, envNote);
  });
}

async function startLogin(rt: Runtime, prefix: string, envNote: string): Promise<ToolResult> {
  let started: any;
  try {
    started = await call(rt, 'POST', '/auth/device', { body: {} });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return fail(`Browser login is not available yet. Set HASHSCRAPER_API_KEY to a key from My page -> API (free sign-up: ${SIGN_UP}).`);
    }
    throw e;
  }
  writePending(rt, {
    device_code: started.device_code,
    interval: started.interval,
    deadline: rt.now() / 1000 + Number(started.expires_in),
    base_url: rt.baseUrl,
  });
  return ok(`${prefix}Show this link and code to the user right now, and ask them to open the link, sign in (or sign up for free) and click "Approve and connect":
  ${started.verification_uri_complete}
Code: ${started.user_code} (the page shows the same code — the user should check it matches; it expires in ${Math.floor(Number(started.expires_in) / 60)} minutes)
After the user says they approved, call the login tool again to finish connecting. Do not open the link yourself and never ask the user to paste a key.${envNote}`);
}

async function waitLogin(rt: Runtime, pending: { device_code: string; interval: number; deadline: number }, envNote: string): Promise<ToolResult> {
  let interval = Math.max(Math.floor(Number(pending.interval) || 5), 1) * 1000;
  const windowEnd = rt.now() + rt.loginWindowMs;
  const deadlineMs = Number(pending.deadline) * 1000;
  for (;;) {
    let data: any;
    try {
      data = (await call(rt, 'POST', '/auth/token', { body: { device_code: pending.device_code } })).data;
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'authorization_pending') data = undefined;
        else if (e.code === 'slow_down') { interval += 5_000; data = undefined; }
        else {
          clearPending(rt);
          if (e.code === 'access_denied') {
            if (e.details.reason === 'key_limit') {
              return fail('Your account already has the maximum number of API keys. Delete one in My page -> API, then call the login tool again.');
            }
            return fail('The connection was not approved in the browser. Nothing was saved. Call the login tool again if the user wants to connect.');
          }
          if (e.code === 'expired_token') return fail('The code expired or was already used. Call the login tool again.');
          return explain(rt, e);
        }
      } else if (!(e instanceof NetworkError)) {
        throw e;
      }
    }
    if (data) {
      if (!data.api_key) return fail('The server did not return a key. Call the login tool again.');
      clearPending(rt);
      saveKey(rt, data);
      return ok(`Connected. Saved the key "${data.key_name}" to ~/.config/hashscraper/credentials (only the user can read it). The key is never shown.` +
        `${data.expires_at ? `\nThe key expires at ${data.expires_at}. Call the login tool again after that.` : ''}${envNote}\n` +
        'You can now use the other HashScraper tools (me, catalog, run, coupang_top …).');
    }
    if (rt.now() >= deadlineMs) {
      clearPending(rt);
      return fail('The code expired before it was approved. Call the login tool again for a new link.');
    }
    if (rt.now() + interval >= windowEnd) break;
    await rt.sleep(interval);
  }
  return ok('Still waiting for the user to approve the connection in the browser. Ask the user to open the link you showed (check the code), ' +
    'click "Approve and connect", then call the login tool again. If the link is lost, call login with restart=true for a new one.' + envNote);
}

/* ---------- me ---------- */

export async function meTool(rt: Runtime, _args: Record<string, never>): Promise<ToolResult> {
  return guarded(rt, async () => {
    const key = requireKey(rt);
    const data = (await call(rt, 'GET', '/me', { key })).data;
    const free = data.daily_free ?? null;
    let text = JSON.stringify({ email: data.email, daily_free: free });
    if (free === null) {
      text += '\nDaily free credits are not offered on this account right now. Use use_credits=true to run with the user\'s own credits (only if the user wants that).';
    }
    return ok(text);
  });
}

/* ---------- run / fetch ---------- */

async function findBot(rt: Runtime, key: string, worker: string): Promise<number | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const query: Record<string, string | number> = { limit: 100 };
    if (cursor) query.cursor = cursor;
    const page = await call(rt, 'GET', '/bots', { key, query });
    for (const bot of page.data ?? []) if (bot.worker_source?.name === worker) return bot.id;
    cursor = page.next_cursor;
    if (!cursor) return undefined;
  }
}

async function importBot(rt: Runtime, key: string, worker: string, notes: string[]): Promise<number | undefined> {
  try {
    const added = (await call(rt, 'POST', '/bots/import', { key, body: { worker } })).data;
    if (added.created) notes.push(`Added ${added.name || worker} to your account.`);
    return added.id;
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'BOT_NOT_FOUND' || e.code === 'RATE_LIMITED')) {
      notes.push(`Could not add ${worker} to your account (${e.code}).`);
      return undefined;
    }
    throw e;
  }
}

async function fetchRows(rt: Runtime, key: string, datasetId: number | string): Promise<Record<string, any>[]> {
  const rows: Record<string, any>[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query: Record<string, string | number> = { limit: 1000 };
    if (cursor) query.cursor = cursor;
    const page = await call(rt, 'GET', `/datasets/${datasetId}/results`, { key, query });
    rows.push(...(page.data ?? []));
    cursor = page.next_cursor;
    if (!cursor) return rows;
  }
}

/** Wait at most waitSeconds for the dataset; then rows + summary, or "still collecting — call fetch later". */
async function finish(rt: Runtime, key: string, datasetId: number | string, args: {
  wait_seconds?: number; max_rows?: number; csv_path?: string;
}, notes: string[]): Promise<ToolResult> {
  const waitMs = clampWait(args.wait_seconds) * 1000;
  const started = rt.now();
  let dataset = (await call(rt, 'GET', `/datasets/${datasetId}`, { key })).data;
  while (!ENDED.includes(dataset.status)) {
    const left = waitMs - (rt.now() - started);
    if (left <= 0) {
      return ok([...notes,
        `Dataset ${datasetId} is still collecting (status ${dataset.status}, ${dataset.data_count ?? 0} rows so far). A run usually takes 1–5 minutes.`,
        `Call the fetch tool with dataset_id=${datasetId} in a minute or two to get the rows. Do not start the same collection again.`].join('\n'));
    }
    await rt.sleep(Math.min(rt.pollMs, left));
    dataset = (await call(rt, 'GET', `/datasets/${datasetId}`, { key })).data;
  }
  const rows = await fetchRows(rt, key, datasetId);
  const after = (await call(rt, 'GET', '/me', { key })).data.daily_free || {};
  const delivered = deliverRows(rows, clampRows(args.max_rows), args.csv_path);
  let summary = `status ${dataset.status} · ${rows.length} rows · own credits used so far ${dataset.credits_used ?? 0} (updates a few minutes later)`;
  if (after.remaining !== undefined) summary += ` · daily free left ${after.remaining}`;
  if (dataset.status === 'attention' && dataset.empty_reason) summary += ` · empty reason: ${dataset.empty_reason}`;
  const text = [...notes, `Dataset ${datasetId}: ${summary}`, delivered, FOOTER].join('\n');
  return dataset.status === 'failed' ? fail(`${text}\nThe collection failed. You may try once more; do not loop.`) : ok(text);
}

export interface RunArgs {
  worker: string; inputs?: Record<string, unknown>; use_credits?: boolean; accept_terms?: string;
  wait_seconds?: number; max_rows?: number; csv_path?: string;
}

/** The server keeps an Idempotency-Key for 24 hours — reuse a saved one only well inside that. */
const RUN_PENDING_MAX_AGE_MS = 20 * 60 * 60 * 1000;

/** JSON with object keys sorted, so the same inputs in another order give the same fingerprint. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Start a collection. The Idempotency-Key is saved (per request) before sending, and resent — never a new one — while the
 * outcome is unknown, so a lost answer never starts or charges for a second collection. Only a success, or a rejection of a
 * request that was never in doubt, forgets the key.
 */
async function startCollection(rt: Runtime, key: string, botId: number | string, inputs: Record<string, unknown>, args: RunArgs): Promise<any> {
  const fingerprint = createHash('sha256')
    .update(canonical([rt.baseUrl, botId, inputs, !!args.use_credits, args.accept_terms ?? null])).digest('hex');
  const forget = () => {
    const entries = readRunPending(rt);
    delete entries[fingerprint];
    writeRunPending(rt, entries, RUN_PENDING_MAX_AGE_MS);
  };
  const entries = readRunPending(rt);
  const saved = entries[fingerprint];
  let inDoubt = !!saved && rt.now() - saved.saved_at < RUN_PENDING_MAX_AGE_MS;
  const idempotencyKey = inDoubt ? saved.idempotency_key : randomUUID();
  if (!inDoubt) {
    entries[fingerprint] = { idempotency_key: idempotencyKey, saved_at: rt.now() };
    writeRunPending(rt, entries, RUN_PENDING_MAX_AGE_MS);
  }
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const started = await call(rt, 'POST', `/bots/${botId}/collections`, {
        key, body: { inputs, save_to_settings: false }, idempotencyKey,
        useCredits: args.use_credits, acceptTerms: args.accept_terms,
      });
      forget();
      return started;
    } catch (e) {
      // 5xx, REQUEST_IN_PROGRESS (the same key is still being handled) and lost answers leave the outcome open
      const unknown = e instanceof NetworkError || (e instanceof ApiError && (e.status >= 500 || e.code === 'REQUEST_IN_PROGRESS'));
      if (!unknown) {
        // A rejection (428, 402, 429 …) is final only if no earlier send of this key may have started the collection
        if (!inDoubt) forget();
        throw e;
      }
      inDoubt = true;
      if (attempt < attempts) {
        await rt.sleep(rt.getRetryDelayMs);
        continue;
      }
      throw new Stop(fail('Could not confirm whether the collection started (the server did not answer). ' +
        'Call the run tool again with exactly the same worker and inputs: it resends the same request id (Idempotency-Key), ' +
        'so the server returns the collection that may already have started instead of starting — or charging for — a second one.'));
    }
  }
}

export async function runTool(rt: Runtime, args: RunArgs): Promise<ToolResult> {
  return guarded(rt, async () => {
    const key = requireKey(rt);
    const entry = loadCatalog().find((bot) => bot.worker === args.worker);
    const notes: string[] = [];
    if (!entry) notes.push(`${args.worker} is not in this server's catalog. Trying it anyway.`);
    const inputs = parseInputs(args.inputs, entry);
    const me = (await call(rt, 'GET', '/me', { key })).data;
    const free = me.daily_free;
    if ((free === null || free === undefined) && !args.use_credits) {
      return fail('Daily free credits are not offered on this account right now, so nothing was collected. ' +
        'Call run again with use_credits=true only if the user wants to use their own credits.');
    }
    if (free) notes.push(`daily free credits left today: ${free.remaining} / ${free.amount}`);

    const botId = (await findBot(rt, key, args.worker)) ?? (entry ? await importBot(rt, key, args.worker, notes) : undefined);
    if (!botId) {
      return fail([...notes, `Your account has no bot for ${args.worker}. Add it from the bot catalog (${BOT_CATALOG}), then call run again. ${HELP_HINT}`].join('\n'));
    }
    const started = await startCollection(rt, key, botId, inputs, args);
    const datasetId = started.data.id;
    notes.push(`collecting with ${args.worker} (dataset ${datasetId})...`);
    try {
      return await finish(rt, key, datasetId, args, notes);
    } catch (e) {
      // The collection already started — keep its id so the agent fetches it instead of starting (and paying for) a second one
      const base = errorResult(rt, e);
      const text = base.content.map((c) => c.text).join('\n');
      return fail(`${text}\nThe collection itself was started (dataset ${datasetId}). Call the fetch tool with dataset_id=${datasetId} to get the rows. Do not call run again for the same collection.`);
    }
  });
}

export async function fetchTool(rt: Runtime, args: { dataset_id: number; wait_seconds?: number; max_rows?: number; csv_path?: string }): Promise<ToolResult> {
  return guarded(rt, async () => finish(rt, requireKey(rt), args.dataset_id, args, []));
}

/* ---------- Coupang ---------- */

export async function coupangCategoriesTool(rt: Runtime, _args: Record<string, never>): Promise<ToolResult> {
  return guarded(rt, async () => {
    const page = await call(rt, 'GET', '/coupang/categories', { key: requireKey(rt) });
    const categories: any[] = page.data ?? [];
    const lines = categories.map((c) => `${c.category_id}  ${c.name}  latest ${c.latest_date || 'not ready'}  ${c.price_credits} credits per fetch`);
    return ok([
      ...lines,
      `${categories.length} categories. Pass a category id or name to the coupang_top tool. Not in the list? Email ${HELP_EMAIL} with the Coupang category URL or id.`,
      termsLine(page.terms),
    ].filter(Boolean).join('\n'));
  });
}

/** A category id as is, or a name looked up in the category list (one match only). */
async function resolveCategory(rt: Runtime, key: string, wanted: string): Promise<string> {
  const text = wanted.trim();
  if (!text) throw new Stop(fail('category is empty (nothing was requested or charged). Pass a category id or name — see the coupang_categories tool.'));
  if (/^\d+$/.test(text)) return text;
  const categories: any[] = (await call(rt, 'GET', '/coupang/categories', { key })).data ?? [];
  const needle = text.toLowerCase();
  const exact = categories.filter((c) => String(c.name).toLowerCase() === needle);
  const found = exact.length ? exact : categories.filter((c) => String(c.name).toLowerCase().includes(needle));
  if (found.length === 1) return String(found[0].category_id);
  const list = (items: any[]) => items.map((c) => `  ${c.category_id}  ${c.name}`).join('\n');
  if (found.length) {
    throw new Stop(fail(`Several categories match ${JSON.stringify(text)}. Ask the user which one, then call coupang_top again with one of these ids (nothing was requested or charged):\n${list(found)}`));
  }
  const available = categories.length ? `Available:\n${list(categories)}` : 'No categories are available yet.';
  throw new Stop(fail(`No Coupang category matches ${JSON.stringify(text)} (nothing was requested or charged). ${available}\n` +
    `To ask for another category, email ${HELP_EMAIL} with the Coupang category URL or id.`));
}

export interface CoupangTopArgs {
  category: string; limit?: number; use_credits?: boolean; accept_terms?: string; csv_path?: string;
}

export async function coupangTopTool(rt: Runtime, args: CoupangTopArgs): Promise<ToolResult> {
  return guarded(rt, async () => {
    const key = requireKey(rt);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 30), 1), 30);
    const categoryId = await resolveCategory(rt, key, args.category);
    const data = (await call(rt, 'GET', `/coupang/categories/${encodeURIComponent(categoryId)}/top`, {
      key, query: { limit }, useCredits: args.use_credits, acceptTerms: args.accept_terms,
    })).data;
    const rows: Record<string, any>[] = data.rows ?? [];
    const delivered = deliverRows(rows, limit, args.csv_path);
    const paid: Record<string, string> = {
      daily_free: 'daily free credits', credits: 'your own credits', none: 'already fetched this snapshot, no charge',
    };
    let summary = `${data.category.name} (${data.category.category_id}) · snapshot ${data.snapshot_date} (collected once a day) · ${rows.length} rows · ` +
      `charged ${data.charged_credits ?? 0} credits (${paid[data.charged_from] ?? data.charged_from})`;
    const free = data.daily_free || {};
    if (free.remaining !== undefined) summary += ` · daily free left ${free.remaining}`;
    return ok([summary, delivered, termsLine(data.terms), FOOTER].filter(Boolean).join('\n'));
  });
}

export { defaultRuntime };
