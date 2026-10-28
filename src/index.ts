#!/usr/bin/env node
// HashScraper MCP server (stdio). Only the MCP wiring lives here; the tools are in tools.ts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VERSION } from './api.ts';
import {
  catalogTool, coupangCategoriesTool, coupangTopTool, defaultRuntime, fetchTool, loginTool, meTool, runTool,
} from './tools.ts';

const csvPath = z.string().optional().describe('Absolute path ending in .csv. Saves ALL rows to this file (UTF-8 with BOM, opens in Excel) instead of returning them in the answer.');
const acceptTerms = z.string().optional().describe('The data terms version the user was shown and clearly agreed to (e.g. "v0.2"). Only set it after the user agrees; never agree for the user.');
const useCredits = z.boolean().optional().describe("Set true only if the user wants to spend their own credits after today's free credits are used up.");
const waitSeconds = z.number().int().min(0).max(55).optional().describe('How long to wait for the collection in this call (default 45, max 55). If it is not finished, the answer says to call fetch later.');
const maxRows = z.number().int().min(1).optional().describe('Return at most this many rows in the answer (default 100). The summary always shows the total.');

function main(): Promise<void> {
  const rt = defaultRuntime();
  const server = new McpServer({ name: 'hashscraper', version: VERSION });

  server.registerTool('login', {
    title: 'Connect HashScraper account',
    description: 'Connect the user\'s HashScraper account in the browser (device login, free sign-up included). Use it first when another HashScraper tool says "Not connected", or when the user asks to connect or reconnect. ' +
      'It never blocks for minutes: the first call returns a link and a code to SHOW THE USER; after the user approves in the browser, call login again to finish and save the key. The key is never shown. ' +
      'Skip it if HASHSCRAPER_API_KEY is set.',
    inputSchema: { restart: z.boolean().optional().describe('Throw away a waiting login and start a new link.') },
    annotations: { title: 'Connect HashScraper account', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => loginTool(rt, args));

  server.registerTool('me', {
    title: 'Account and daily free credits',
    description: 'Show the connected account\'s email and how many daily free credits are left today (they refill at midnight KST). Use before a paid-looking collection to check what is free.',
    inputSchema: {},
    annotations: { title: 'Account and daily free credits', readOnlyHint: true, openWorldHint: true },
  }, () => meTool(rt, {}));

  server.registerTool('catalog', {
    title: 'Find a HashScraper bot',
    description: 'Search the built-in list of 120+ ready-made data bots (Coupang, Naver blog/cafe/news/shopping/maps, Instagram, YouTube, Olive Young, Musinsa, Kurly, KREAM, Google/Kakao maps, app stores, community boards …). ' +
      'Use it to find the worker name and the inputs of a bot before calling run. Works offline; no account needed.',
    inputSchema: { search: z.string().optional().describe('Text to look for in site, bot name, summary and inputs, e.g. "coupang", "naver blog", "reviews".') },
    annotations: { title: 'Find a HashScraper bot', readOnlyHint: true, openWorldHint: false },
  }, (args) => catalogTool(rt, args));

  server.registerTool('run', {
    title: 'Collect data with a bot',
    description: 'Collect public web data with one HashScraper bot (find the worker with catalog first) and return the rows — e.g. a Coupang product page\'s price, 50 Naver blog posts for a keyword, reviews, map places. ' +
      'Uses only the daily free credits unless use_credits=true. The first paid use needs the user\'s agreement to the data terms (accept_terms). It waits up to wait_seconds; if the bot is still collecting it returns a dataset id — call fetch later instead of running again.',
    inputSchema: {
      worker: z.string().describe('Worker name from catalog, e.g. "DemoCoupangDetailWorker".'),
      inputs: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional()
        .describe('Bot inputs: keys are "param1"… or the input name / English name from catalog; values are text (several URLs or keywords: an array or one per line). Omitted inputs use the bot\'s saved settings.'),
      use_credits: useCredits, accept_terms: acceptTerms, wait_seconds: waitSeconds, max_rows: maxRows, csv_path: csvPath,
    },
    annotations: { title: 'Collect data with a bot', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => runTool(rt, args));

  server.registerTool('fetch', {
    title: 'Get rows of an earlier run',
    description: 'Get the rows of an earlier run by dataset id (from run). Use it when run said the collection was still going. Waits up to wait_seconds if it is still collecting. Reading rows costs nothing extra.',
    inputSchema: { dataset_id: z.number().int().describe('Dataset id returned by run.'), wait_seconds: waitSeconds, max_rows: maxRows, csv_path: csvPath },
    annotations: { title: 'Get rows of an earlier run', readOnlyHint: true, openWorldHint: true },
  }, (args) => fetchTool(rt, args));

  server.registerTool('coupang_categories', {
    title: 'Coupang categories with a daily top 30',
    description: 'List the Coupang categories whose daily best-selling top 30 is ready, with the latest snapshot date. Free. Use it to answer "which categories can you rank?" or to pick the right category for coupang_top.',
    inputSchema: {},
    annotations: { title: 'Coupang categories with a daily top 30', readOnlyHint: true, openWorldHint: true },
  }, () => coupangCategoriesTool(rt, {}));

  server.registerTool('coupang_top', {
    title: 'Coupang category top 30',
    description: 'Use when the user wants today\'s best-selling / top 30 products of a Coupang category with price, reviews, delivery and detail-page columns (sale price, coupons, seller type, monthly buyers …), or a price comparison of its top products. ' +
      'The data is collected once a day and reused (snapshot_date says which day). Costs 300 credits per category per daily snapshot, whatever the limit; fetching the same snapshot again is free; daily free credits are used first. ' +
      'A category name that matches several categories, or none, returns a list and charges nothing. The first paid use needs the user\'s agreement to the data terms (accept_terms).',
    inputSchema: {
      category: z.string().trim().min(1).describe('Category id (e.g. "429888") or name (e.g. "커피믹스"). See coupang_categories.'),
      limit: z.number().int().min(1).max(30).optional().describe('Rows 1-30 (default 30). The price is the same.'),
      use_credits: useCredits, accept_terms: acceptTerms, csv_path: csvPath,
    },
    annotations: { title: 'Coupang category top 30', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => coupangTopTool(rt, args));

  return server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error('Failed to start the HashScraper MCP server:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
