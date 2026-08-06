#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-sticky-context.js — does the detected program/stage survive an MV3
 * service-worker restart?
 *
 * Run:  node scripts/scenario-sticky-context.js   (no network, no DHIS2 needed)
 * Exit: 0 = all good, 1 = context was lost.
 *
 * The bug this pins (reported live 2026-08-06: "the chatbot finds the stage for
 * a bit then loses it"):
 *
 *   Chrome terminates the MV3 service worker after ~30 s idle and rebuilds the
 *   `dhis2` object from chrome.storage.session on the next event. The active
 *   stage on Capture's enrollment dashboard exists ONLY as a content-script
 *   detection — the URL carries no stageId, so NOTHING can re-derive it. Three
 *   sites assigned pageContext in memory without calling saveState(), so the
 *   stage was reliably known for a short while and then permanently gone.
 *
 * This boots the real background bundle twice against ONE shared session store
 * — which is exactly what a worker restart looks like — and asserts the sticky
 * context is still there on the other side.
 * ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = (m) => { console.log('  \x1b[31m✗\x1b[0m ' + m); failures++; };

// chrome.storage.session is what survives a worker restart — everything else dies.
const SESSION = {};

function bootWorker() {
  const loaderSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const modules = [...loaderSrc.matchAll(/'(src\/[^']+\.js)'/g)].map((m) => m[1]);
  if (!modules.length) throw new Error('background.js declares no src/*.js modules');

  const noop = () => {};
  const msgListeners = [];
  const evt = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });
  const store = (backing) => ({
    get: (keys) => {
      if (!keys) return Promise.resolve({ ...backing });
      const arr = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys));
      const out = {};
      for (const k of arr) if (k in backing) out[k] = backing[k];
      return Promise.resolve(out);
    },
    set: (obj) => { Object.assign(backing, obj); return Promise.resolve(); },
    remove: (k) => { (Array.isArray(k) ? k : [k]).forEach((x) => delete backing[x]); return Promise.resolve(); },
  });
  const chrome = {
    runtime: {
      id: 'sticky-probe',
      onMessage: { addListener: (f) => msgListeners.push(f), removeListener: noop, hasListener: () => false },
      onInstalled: evt(), onStartup: evt(), getURL: (p) => p,
      getPlatformInfo: () => Promise.resolve({ os: 'linux' }), sendMessage: () => Promise.resolve(),
    },
    storage: { local: store({}), session: store(SESSION), onChanged: evt() },
    tabs: { onUpdated: evt(), onActivated: evt(), query: () => Promise.resolve([]), sendMessage: () => Promise.resolve() },
    action: { onClicked: evt() },
    permissions: { onAdded: evt(), onRemoved: evt(), getAll: () => Promise.resolve({ origins: [] }) },
    scripting: { getRegisteredContentScripts: () => Promise.resolve([]) },
    sidePanel: { setOptions: noop, open: () => Promise.resolve() },
  };
  const sandbox = {
    chrome, console: { log: noop, warn: noop, error: noop },
    fetch: () => Promise.reject(new Error('offline scenario')),
    URL, URLSearchParams, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    AbortController, AbortSignal, Promise,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: require('crypto').webcrypto, structuredClone,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const bundle = modules.map((m) => fs.readFileSync(path.join(ROOT, m), 'utf8')).join('\n');
  vm.runInContext(bundle + '\n;globalThis.__dhis2 = () => dhis2;', ctx, { filename: 'background.bundle.js' });
  return { sandbox, onMessage: msgListeners[0] };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// Real DHIS2-shaped UIDs — hasUidShape() applies an entropy test, so
// human-readable placeholders like "STAGEabcdef" are (correctly) rejected.
const PROGRAM_UID = 'OkA1bPReqR1';
const STAGE_UID = 'T7P34dKkJvS';

(async () => {
  console.log('\nSticky page context across a service-worker restart:');

  // ── Worker instance #1: the user opens a stage in Capture ──
  let w = bootWorker();
  await settle(120);
  const d1 = w.sandbox.__dhis2();
  d1.baseUrl = 'http://localhost:8081';
  d1.connected = true;
  d1.pageContext = { appType: 'Capture', programId: PROGRAM_UID };
  d1.programMetadata = { programStages: [{ id: STAGE_UID, displayName: 'Treatment' }] };

  if (typeof w.onMessage !== 'function') { bad('no onMessage listener registered'); process.exit(1); }
  // sender.id must match runtime.id — the listener rejects foreign senders.
  w.onMessage({ type: 'DHIS2_STAGE_DETECTED', payload: { stageId: STAGE_UID, source: 'dom' } },
    { id: 'sticky-probe' }, () => {});
  await settle();

  if (w.sandbox.__dhis2().pageContext.stageId === STAGE_UID) ok('content script detection sets the stage in memory');
  else bad(`stage not applied in memory (got ${w.sandbox.__dhis2().pageContext.stageId})`);

  const persisted = SESSION.dhis2Full && SESSION.dhis2Full.pageContext
    ? SESSION.dhis2Full.pageContext.stageId : undefined;
  if (persisted === STAGE_UID) ok('detected stage is written to chrome.storage.session');
  else bad('detected stage was NOT persisted — an in-memory-only write dies with the worker');

  // ── Chrome kills the worker. A new instance boots from session storage. ──
  w = bootWorker();
  await settle(220);
  const revived = w.sandbox.__dhis2().pageContext ? w.sandbox.__dhis2().pageContext.stageId : undefined;
  if (revived === STAGE_UID) ok('stage survives the restart — "what stage am I in?" still answerable');
  else bad(`stage LOST after restart (got ${revived}) — this is the reported "finds it for a bit then loses it"`);

  const revivedProgram = w.sandbox.__dhis2().pageContext ? w.sandbox.__dhis2().pageContext.programId : undefined;
  if (revivedProgram === PROGRAM_UID) ok('program survives the restart');
  else bad(`program LOST after restart (got ${revivedProgram})`);

  console.log('');
  if (failures) { console.error(`\x1b[31mFAILED\x1b[0m — ${failures} check(s) failed\n`); process.exit(1); }
  console.log('\x1b[32mAll checks passed.\x1b[0m\n');
})();
