#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * live-harness.js — run the REAL extension tools against a LIVE DHIS2 instance.
 *
 * `npm run verify` proves the modules load and the pure safety helpers behave.
 * This harness goes further: it loads the same six `src/*.js` modules in one VM
 * scope (exactly as the service worker does) but wires a **basic-auth `fetch`
 * shim** pointed at a real DHIS2 server, so you can call the actual
 * `executeTool(name, args)` and watch every HTTP request + status. Use it to
 * prove — before committing — that a changed tool completes a COMPLEX task with
 * ZERO failed API calls, per the performance-enhancement skill's hard rule.
 *
 * It is deliberately NOT part of `npm run verify` (that must stay dependency- and
 * network-free). Run it against localhost or a playground instance on demand.
 *
 * Usage from a scenario script:
 *   const { load, API, summarize } = require('./live-harness');
 *   const ctx = load();                        // modules loaded, connection wired
 *   const r = await ctx.executeTool('get_program_info', { info_type:'indicators', program_id:'…' });
 *   const { failed } = summarize();            // HTTP >= 400 or thrown fetches
 *
 * Env:
 *   DHIS2_BASE   default http://localhost:8081
 *   DHIS2_AUTH   default admin:district        (basic-auth user:pass)
 *   DHIS2_APIVER default 42
 *
 * Writes: the extension normally POSTs via a browser tab; with no tab present
 * `fetchViaTab` returns null and safeDhis2Fetch falls back to a direct fetch,
 * which this shim authenticates. `dhis2.writeAuth` is set to `broad` so write
 * gates are open (the harness stands in for an authorizing user).
 *
 * ALWAYS clean up every object a scenario creates, and re-run until the instance
 * is left exactly as found. Post-delete existence probes are EXPECTED to 404 —
 * exclude them from the failed-call tally (snapshot API.length first).
 * ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.DHIS2_BASE || 'http://localhost:8081').replace(/\/+$/, '');
const APIVER = Number(process.env.DHIS2_APIVER || 42);
const AUTH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');

// Every DHIS2 API request the tools make, in order: { method, url, status, ok }.
const API = [];

const realFetch = global.fetch;
async function shimFetch(url, opts = {}) {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = Object.assign({}, opts.headers || {}, { Authorization: AUTH });
  let resp;
  try {
    resp = await realFetch(u, { ...opts, headers });
  } catch (e) {
    API.push({ method, url: u.replace(BASE, ''), status: 'THREW:' + e.message, ok: false });
    throw e;
  }
  if (u.includes('/api/')) API.push({ method, url: u.replace(BASE, ''), status: resp.status, ok: resp.ok });
  return resp;
}

const noop = () => {};
const evt = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });
const store = () => ({ get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() });
const chrome = {
  runtime: { id: 'live-harness', onMessage: evt(), onInstalled: evt(), onStartup: evt(),
             getURL: (p) => p, getPlatformInfo: (cb) => cb && cb({ os: 'linux' }) },
  storage: { local: store(), session: store(), onChanged: evt() },
  tabs: { onUpdated: evt(), onActivated: evt(), query: () => Promise.resolve([]) },
  action: { onClicked: evt() },
  permissions: { onAdded: evt(), onRemoved: evt(), getAll: () => Promise.resolve({ origins: [] }) },
  scripting: { getRegisteredContentScripts: () => Promise.resolve([]), executeScript: () => Promise.resolve([]) },
  sidePanel: { setOptions: noop, open: () => Promise.resolve() },
};

// Load the six modules in importScripts order, then wire live connection state via
// an in-scope bootstrap (dhis2 is a lexical `let`, unreachable from the outside).
function load(pageContext = { appType: 'Dashboard' }) {
  const loaderSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const modules = [...loaderSrc.matchAll(/'(src\/[^']+\.js)'/g)].map((m) => m[1]);
  if (!modules.length) throw new Error('background.js declares no src/*.js modules');
  const sandbox = {
    chrome, console, fetch: shimFetch,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: require('crypto').webcrypto, structuredClone,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const boot = `\n;dhis2.baseUrl=${JSON.stringify(BASE)};dhis2.apiVersion=${APIVER};`
    + `dhis2.pageContext=${JSON.stringify(pageContext)};`
    + `dhis2.writeAuth={scope:'broad',reason:'live-harness'};`
    + `dhis2.knownIds=new Set();dhis2.programMetadata=null;`
    + `globalThis.__getDhis2=()=>dhis2;`;
  const bundle = modules.map((m) => `\n//# ${m}\n` + fs.readFileSync(path.join(ROOT, m), 'utf8')).join('\n') + boot;
  vm.runInContext(bundle, ctx, { filename: 'background.bundle.js' });
  return ctx;
}

// Failed = HTTP >= 400 or a thrown fetch. `sinceIndex` lets a caller exclude the
// intentional post-cleanup 404 probes (snapshot API.length before verifying).
function summarize(sinceIndex = 0, untilIndex = API.length) {
  const slice = API.slice(sinceIndex, untilIndex);
  const failed = slice.filter((a) => (typeof a.status === 'number' && a.status >= 400) || String(a.status).startsWith('THREW'));
  return { total: slice.length, failed };
}

module.exports = { load, API, summarize, BASE, APIVER };

// Run directly → a connectivity smoke test (no writes, no cleanup needed).
if (require.main === module) {
  (async () => {
    try {
      const ctx = load();
      const info = await ctx.executeTool('dhis2_query', { path: 'system/info.json' });
      const ok = info && !info._error && info.version;
      console.log(ok ? `✓ live-harness connected to ${BASE} — DHIS2 ${info.version}`
                     : `✗ live-harness could not read system/info from ${BASE}: ${info && info._error}`);
      const { failed } = summarize();
      console.log(`  ${API.length} API call(s), ${failed.length} failed`);
      process.exit(ok && !failed.length ? 0 : 1);
    } catch (e) {
      console.error('✗ live-harness failed to load/connect:', e.message);
      console.error('  Is a DHIS2 instance reachable at', BASE, '? Set DHIS2_BASE / DHIS2_AUTH.');
      process.exit(1);
    }
  })();
}
