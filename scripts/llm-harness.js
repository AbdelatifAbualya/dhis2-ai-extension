#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * llm-harness.js — run the REAL agentic loop (runAgenticLoop) end-to-end with a
 * REAL LLM provider against a LIVE DHIS2 instance.
 *
 * live-harness.js proves the TOOLS work when driven directly; this harness
 * proves the whole chatbot works when a real (possibly weak) model drives them:
 * provider streaming, tool-call parsing/repair, manuals gate, loop guards,
 * write authorization — the exact service-worker code path.
 *
 * Model/provider come from env (NOTHING model-specific is hardcoded):
 *   LLM_API_KEY      provider API key
 *   LLM_BASE_URL     e.g. https://api.fireworks.ai/inference/v1
 *   LLM_MODEL        e.g. accounts/fireworks/models/minimax-m3
 *   LLM_THINK        "1" if the model streams <think>…</think> blocks
 *   LLM_MAX_TOKENS   optional, default 16384
 *   LLM_BROWSER      "1" runs manage_custom_app's install check in real Chrome
 *                    (needs playwright-core and CHROME_PATH or /usr/bin/google-chrome)
 *   DHIS2_BASE / DHIS2_AUTH / DHIS2_APIVER as in live-harness.js
 *
 * Exposes loadLLM() → { ctx, API, summarize, events } where ctx.runAgenticLoop
 * is callable per user turn (conversation persists across turns in the VM).
 * ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.DHIS2_BASE || 'http://localhost:8081').replace(/\/+$/, '');
const APIVER = Number(process.env.DHIS2_APIVER || 42);
const AUTH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');

const PROVIDER = {
  fireworksApiKey: process.env.LLM_API_KEY || '',
  providerConfig: {
    providerType: 'custom',
    apiBaseUrl: process.env.LLM_BASE_URL || '',
    modelId: process.env.LLM_MODEL || '',
    modelLabel: process.env.LLM_MODEL || 'harness-model',
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 16384),
    temperature: Number(process.env.LLM_TEMPERATURE || 0.2),
    hasThinkBlock: process.env.LLM_THINK === '1',
  },
};

const API = [];      // DHIS2 API calls: { method, url, status, ok }
const LLMLOG = [];   // provider calls: { status }
const events = [];   // broadcast events (AI_TOOL_CALL / AI_TOOL_DONE / …)

const realFetch = global.fetch;
// chrome.runtime.getURL(p) → EXT_ORIGIN + p, served from disk like the browser
// serves an extension's own files (manage_custom_app reads its runtime kit).
const EXT_ORIGIN = 'chrome-extension://llm-harness/';
async function shimFetch(url, opts = {}) {
  const u = String(url);
  if (u.startsWith(EXT_ORIGIN)) {
    const abs = path.join(ROOT, decodeURIComponent(u.slice(EXT_ORIGIN.length).split(/[?#]/)[0]));
    if (!abs.startsWith(ROOT + path.sep) || !fs.existsSync(abs)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(abs), { status: 200 });
  }
  const isDhis2 = u.startsWith(BASE + '/');
  const method = ((opts && opts.method) || 'GET').toUpperCase();
  // Only the DHIS2 instance gets basic auth injected; provider calls keep
  // their own Authorization header untouched.
  const finalOpts = isDhis2
    ? { ...opts, headers: Object.assign({}, opts.headers || {}, { Authorization: AUTH }) }
    : opts;
  let resp;
  try {
    resp = await realFetch(u, finalOpts);
  } catch (e) {
    if (isDhis2 && u.includes('/api/')) API.push({ method, url: u.replace(BASE, ''), status: 'THREW:' + e.message, ok: false });
    throw e;
  }
  if (isDhis2 && u.includes('/api/')) API.push({ method, url: u.replace(BASE, ''), status: resp.status, ok: resp.ok });
  else if (!isDhis2) LLMLOG.push({ url: u.replace(/\?.*$/, ''), status: resp.status });
  return resp;
}

// The install check runs in the user's DHIS2 tab: LLM_BROWSER gives it a real page.
// Only that function runs there. Everything else keeps the logged direct fetch, so
// a failed API call is still counted (an empty result = no tab, as for fetchViaTab).
const browserState = { page: null, browser: null };
async function browserPage() {
  if (browserState.page) return browserState.page;
  const npx = path.join(require('os').homedir(), '.npm', '_npx');
  let pw = null;
  for (const t of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) { try { pw = require(t); break; } catch { /* next */ } }
  if (!pw && fs.existsSync(npx)) for (const d of fs.readdirSync(npx)) { const p = path.join(npx, d, 'node_modules', 'playwright-core'); if (fs.existsSync(path.join(p, 'package.json'))) { try { pw = require(p); break; } catch { /* next */ } } }
  if (!pw) throw new Error('LLM_BROWSER needs playwright-core');
  browserState.browser = await pw.chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
  const c = await browserState.browser.newContext({ viewport: { width: 1400, height: 900 } });
  const [user, password] = (process.env.DHIS2_AUTH || 'admin:district').split(':');
  await c.request.post(`${BASE}/api/auth/login`, { data: { username: user, password }, headers: { 'Content-Type': 'application/json' } });
  browserState.page = await c.newPage();
  await browserState.page.goto(`${BASE}/api/system/info.json`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return browserState.page;
}
async function closeBrowser() { if (browserState.browser) await browserState.browser.close().catch(() => {}); browserState.browser = null; browserState.page = null; }

const noop = () => {};
const evt = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });
// chrome.storage.local must serve the provider config so core.js's startup
// cache load picks it up — exactly how the extension reads user settings.
const storedData = { ...PROVIDER };
const localStore = {
  get: (keys) => {
    if (!keys) return Promise.resolve({ ...storedData });
    const arr = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys));
    const out = {};
    for (const k of arr) if (k in storedData) out[k] = storedData[k];
    return Promise.resolve(out);
  },
  set: (obj) => { Object.assign(storedData, obj); return Promise.resolve(); },
  remove: (k) => { (Array.isArray(k) ? k : [k]).forEach(x => delete storedData[x]); return Promise.resolve(); },
};
// chrome.storage.session backed by a JSON file: conversation history and dhis2
// context persist across harness processes exactly like a service-worker
// restart — each prompt file can run as its own process while continuing the
// same conversation (and this exercises the real state-restoration path).
const SESSION_FILE = process.env.LLM_SESSION_FILE || path.join(ROOT, '.llm-session.json');
let sessionData = {};
try { if (fs.existsSync(SESSION_FILE)) sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch {}
const sessionStore = {
  get: (keys) => {
    if (!keys) return Promise.resolve({ ...sessionData });
    const arr = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys));
    const out = {};
    for (const k of arr) if (k in sessionData) out[k] = sessionData[k];
    return Promise.resolve(out);
  },
  set: (obj) => {
    Object.assign(sessionData, obj);
    try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData)); } catch {}
    return Promise.resolve();
  },
  remove: (k) => { (Array.isArray(k) ? k : [k]).forEach(x => delete sessionData[x]); try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData)); } catch {} return Promise.resolve(); },
};
const chrome = {
  runtime: { id: 'llm-harness', onMessage: evt(), onInstalled: evt(), onStartup: evt(),
             getURL: (p) => EXT_ORIGIN + String(p).replace(/^\//, ''), getPlatformInfo: () => Promise.resolve({ os: 'linux' }),
             sendMessage: () => Promise.resolve() },
  storage: { local: localStore, session: sessionStore, onChanged: evt() },
  tabs: { onUpdated: evt(), onActivated: evt(), query: () => Promise.resolve(process.env.LLM_BROWSER === '1' ? [{ id: 1, url: `${BASE}/`, active: true }] : []), sendMessage: () => Promise.resolve() },
  action: { onClicked: evt() },
  // `contains: true`: the harness stands in for a user who granted host access.
  // Without it initializeFromUrlNow refuses silently and a page-bound prompt
  // ("this form") runs with no page context at all.
  permissions: { onAdded: evt(), onRemoved: evt(), getAll: () => Promise.resolve({ origins: [] }), contains: () => Promise.resolve(true) },
  scripting: {
    getRegisteredContentScripts: () => Promise.resolve([]),
    executeScript: async ({ func, args }) => {
      if (process.env.LLM_BROWSER !== '1' || !func || func.name !== 'customAppCheckInPage') return [];
      const page = await browserPage();
      return [{ result: await page.evaluate(`(${func.toString()})(...${JSON.stringify(args || [])})`) }];
    },
  },
  sidePanel: { setOptions: noop, open: () => Promise.resolve() },
};

function loadLLM(pageContext = { appType: 'Maintenance' }) {
  const loaderSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const modules = [...loaderSrc.matchAll(/'((?:src|libs)\/[^']+\.js)'/g)].map((m) => m[1]);
  if (!modules.length) throw new Error('background.js declares no src/*.js modules');
  const sandbox = {
    chrome, console, fetch: shimFetch,
    URL, URLSearchParams, TextEncoder, TextDecoder, FormData, Blob, Response,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    AbortSignal, AbortController, Promise,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: require('crypto').webcrypto, structuredClone,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const boot = `\n;dhis2.baseUrl=${JSON.stringify(BASE)};dhis2.apiVersion=${APIVER};`
    + `dhis2.pageContext=${JSON.stringify(pageContext)};`
    + `dhis2.knownIds=new Set();dhis2.programMetadata=null;`
    + `globalThis.__getDhis2=()=>dhis2;globalThis.__memoryState=()=>memoryState;`;
  const bundle = modules.map((m) => `\n//# ${m}\n` + fs.readFileSync(path.join(ROOT, m), 'utf8')).join('\n') + boot;
  vm.runInContext(bundle, ctx, { filename: 'background.bundle.js' });

  // Capture broadcast events for the transcript (tool calls, stream text).
  const origBroadcast = sandbox.broadcast;
  sandbox.broadcast = (data) => {
    try {
      events.push(data);
      if (data.type === 'AI_TOOL_CALL') {
        console.log(`  → TOOL ${data.tool} ${JSON.stringify(data.args || {}).slice(0, 600)}`);
      } else if (data.type === 'AI_TOOL_DONE') {
        console.log(`  ${data.success ? '✓' : '✗'} ${data.tool}: ${String(data.summary || '').slice(0, 220)}${data.apiPath ? ` [${data.apiPath}]` : ''}`);
      } else if (data.type === 'AI_THINKING' && data.label) {
        if (!/Reasoning|Composing/.test(data.label) || /\(6\d\d|12\d\d/.test(data.label)) console.log(`  … ${data.label}`);
      }
    } catch {}
    if (typeof origBroadcast === 'function') { try { origBroadcast(data); } catch {} }
  };

  return { ctx: sandbox, API, LLMLOG, events };
}

function summarize(sinceIndex = 0, untilIndex = API.length) {
  const slice = API.slice(sinceIndex, untilIndex);
  const failed = slice.filter((a) => (typeof a.status === 'number' && a.status >= 400) || String(a.status).startsWith('THREW'));
  return { total: slice.length, failed };
}

module.exports = { loadLLM, API, LLMLOG, events, summarize, BASE, APIVER, browserPage, closeBrowser };
