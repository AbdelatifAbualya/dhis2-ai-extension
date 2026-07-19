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
async function shimFetch(url, opts = {}) {
  const u = String(url);
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
             getURL: (p) => p, getPlatformInfo: () => Promise.resolve({ os: 'linux' }),
             sendMessage: () => Promise.resolve() },
  storage: { local: localStore, session: sessionStore, onChanged: evt() },
  tabs: { onUpdated: evt(), onActivated: evt(), query: () => Promise.resolve([]), sendMessage: () => Promise.resolve() },
  action: { onClicked: evt() },
  permissions: { onAdded: evt(), onRemoved: evt(), getAll: () => Promise.resolve({ origins: [] }) },
  scripting: { getRegisteredContentScripts: () => Promise.resolve([]), executeScript: () => Promise.resolve([]) },
  sidePanel: { setOptions: noop, open: () => Promise.resolve() },
};

function loadLLM(pageContext = { appType: 'Maintenance' }) {
  const loaderSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const modules = [...loaderSrc.matchAll(/'(src\/[^']+\.js)'/g)].map((m) => m[1]);
  if (!modules.length) throw new Error('background.js declares no src/*.js modules');
  const sandbox = {
    chrome, console, fetch: shimFetch,
    URL, URLSearchParams, TextEncoder, TextDecoder,
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
    + `globalThis.__getDhis2=()=>dhis2;`;
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

module.exports = { loadLLM, API, LLMLOG, events, summarize, BASE, APIVER };
