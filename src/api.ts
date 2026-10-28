// HashScraper v5 API client — standard fetch only, no dependencies (mirrors scripts/hashscraper.py of the Agent Skill).
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
export const VERSION: string = (require('../package.json') as { version: string }).version;
export const CLIENT = `agent-mcp/${VERSION}`;

export const SITE = 'https://www.hashscraper.com';
export const UTM = 'utm_source=mcp&utm_medium=mcp&utm_campaign=server';
export const SIGN_UP = `${SITE}/users/sign_up?${UTM}`;
export const BOT_CATALOG = `${SITE}/schedules/catalog?${UTM}`;
export const FOOTER = `Daily monitoring & bulk collection -> HashScraper ${SITE}/quotes/new?${UTM}`;
export const HELP_EMAIL = 'help@hashscraper.com';
export const HELP_HINT = `For data this server cannot collect, email ${HELP_EMAIL} with the site, the data you need, how much and how often.`;
export const LOGIN_HINT = 'Call the `login` tool to connect your HashScraper account in the browser';

/** Everything that differs between the real server and a test: server address, home folder, clocks, waits. */
export interface Runtime {
  baseUrl: string;
  home: string;
  envKey: string;
  version: string;
  client: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** how long one `login` call may wait for the approval */
  loginWindowMs: number;
  /** pause between polls of a running collection */
  pollMs: number;
  /** pause before a GET is retried */
  getRetryDelayMs: number;
  requestTimeoutMs: number;
}

export function defaultRuntime(): Runtime {
  return {
    baseUrl: (process.env.HASHSCRAPER_BASE_URL || `${SITE}/v5/api`).replace(/\/+$/, ''),
    home: homedir(),
    envKey: (process.env.HASHSCRAPER_API_KEY || '').trim(),
    version: VERSION,
    client: CLIENT,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    loginWindowMs: 45_000,
    pollMs: 3_000,
    getRetryDelayMs: 5_000,
    requestTimeoutMs: 30_000,
  };
}

export const credentialsPath = (rt: Runtime) => join(rt.home, '.config', 'hashscraper', 'credentials');
export const pendingPath = (rt: Runtime) => join(rt.home, '.config', 'hashscraper', 'login_pending');
/** The Idempotency-Key of a collection start whose answer never arrived — the next identical run resends it. */
export const runPendingPath = (rt: Runtime) => join(rt.home, '.config', 'hashscraper', 'run_pending');

export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, any>;
  serverMessage: string;
  constructor(status: number, payload: Record<string, any>) {
    const code = payload.code || 'HTTP_ERROR';
    super(`${status} ${code}: ${payload.message || ''}`);
    this.status = status;
    this.code = code;
    this.details = payload.details || {};
    this.serverMessage = String(payload.message || '');
  }
}

/** The server could not be reached (or answered with something that is not JSON). */
export class NetworkError extends Error {}

export interface CallOptions {
  key?: string;
  body?: unknown;
  query?: Record<string, string | number>;
  idempotencyKey?: string;
  useCredits?: boolean;
  acceptTerms?: string;
}

/** One request. Only GETs are retried (up to 3 attempts) — a POST that starts a collection is never sent twice. */
export async function call(rt: Runtime, method: 'GET' | 'POST', path: string, opts: CallOptions = {}): Promise<any> {
  let url = rt.baseUrl + path;
  if (opts.query) url += '?' + new URLSearchParams(Object.entries(opts.query).map(([k, v]): [string, string] => [k, String(v)])).toString();
  const headers: Record<string, string> = { Accept: 'application/json', 'X-HashScraper-Client': rt.client };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.useCredits) headers['X-HashScraper-Use-Credits'] = 'true';
  if (opts.acceptTerms) headers['X-HashScraper-Accept-Terms'] = opts.acceptTerms;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  const attempts = method === 'GET' ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(rt.requestTimeoutMs) });
      text = await response.text();
    } catch {
      if (attempt < attempts) {
        await rt.sleep(rt.getRetryDelayMs);
        continue;
      }
      throw new NetworkError('Could not reach the HashScraper API (network error or timeout).');
    }
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (response.ok) {
      if (payload === undefined) throw new NetworkError('The HashScraper API answered with something that is not JSON.');
      return payload;
    }
    if (method === 'GET' && response.status >= 500 && attempt < attempts) {
      await rt.sleep(rt.getRetryDelayMs);
      continue;
    }
    throw new ApiError(response.status, payload && typeof payload === 'object' ? payload : { message: `HTTP ${response.status}` });
  }
  throw new NetworkError('Could not reach the HashScraper API.');
}
