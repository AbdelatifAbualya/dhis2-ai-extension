#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * verify.js — dependency-free health check for the DHIS2 AI Assistant worker.
 *
 * Run:  npm run verify   (or:  node scripts/verify.js)
 * Exit: 0 = all good, 1 = something failed.
 *
 * What it does, with ZERO npm dependencies (pure Node + a small chrome shim):
 *   1. Syntax-checks every runtime JavaScript file (`node --check`).
 *   2. Loads the background modules exactly the way the extension does —
 *      concatenated in the importScripts() order declared in background.js, in
 *      one shared global scope — under a minimal `chrome` shim. This proves the
 *      split is internally consistent and that cross-module references resolve
 *      at load time.
 *   3. Exercises the safety-critical PURE functions (write authorization, UID
 *      recognition, patient-data privacy path gate, text normalizers, query
 *      encoding, UID generation) so a future edit can't silently weaken a gate
 *      without turning this check red.
 *
 * This is intentionally NOT a full test framework. It is the smallest thing that
 * makes the refactor safe to build on. See ARCHITECTURE.md → "Verifying changes".
 * ───────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = (m) => { console.log('  \x1b[31m✗\x1b[0m ' + m); failures++; };

// ── 1. Syntax check every runtime JS file ───────────────────────────────────
console.log('\nSyntax check (node --check):');
const runtimeFiles = [
  'background.js', 'content.js', 'generate-icons.js',
  'src/core.js', 'src/registry.js', 'src/providers.js',
  'src/tools-metadata.js', 'src/tools-programs.js', 'src/agent.js',
  'sidepanel/panel.js',
];
for (const rel of runtimeFiles) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { bad(`${rel} — missing`); continue; }
  try { execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' }); ok(rel); }
  catch (e) { bad(`${rel}\n${String(e.stderr || e.message).trim()}`); }
}

// ── 2. Load the background modules under a chrome shim ───────────────────────
console.log('\nModule load (importScripts order, one shared scope):');
const loaderSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const modules = [...loaderSrc.matchAll(/'(src\/[^']+\.js)'/g)].map((m) => m[1]);
if (!modules.length) bad('background.js declares no src/*.js modules');

const noop = () => {};
const evt = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });
const store = () => ({ get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() });
const chrome = {
  runtime: { id: 'verify', onMessage: evt(), onInstalled: evt(), onStartup: evt(),
             getURL: (p) => p, getPlatformInfo: (cb) => cb && cb({ os: 'linux' }) },
  storage: { local: store(), session: store(), onChanged: evt() },
  tabs: { onUpdated: evt(), onActivated: evt(), query: () => Promise.resolve([]) },
  action: { onClicked: evt() },
  permissions: { onAdded: evt(), onRemoved: evt(), getAll: () => Promise.resolve({ origins: [] }) },
  scripting: { getRegisteredContentScripts: () => Promise.resolve([]) },
  sidePanel: { setOptions: noop, open: () => Promise.resolve() },
  webNavigation: undefined,
  windows: undefined,
};
const sandbox = {
  chrome, console,
  fetch: () => Promise.reject(new Error('fetch disabled in verify')),
  URL, URLSearchParams, TextEncoder, TextDecoder,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  crypto: require('crypto').webcrypto,
  structuredClone,
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

let loaded = false;
try {
  const bundle = modules
    .map((m) => `\n//# ${m}\n` + fs.readFileSync(path.join(ROOT, m), 'utf8'))
    .join('\n');
  vm.runInContext(bundle, ctx, { filename: 'background.bundle.js' });
  loaded = true;
  ok(`loaded ${modules.length} modules: ${modules.map((m) => m.replace('src/', '')).join(', ')}`);
} catch (e) {
  bad(`module load threw: ${(e && e.stack) || e}`);
}

// ── 3. Safety-critical pure-function behaviour ──────────────────────────────
if (loaded) {
  console.log('\nSafety gates & pure helpers:');
  const fn = (n) => (typeof ctx[n] === 'function' ? ctx[n] : null);
  const eq = (label, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) ok(`${label} => ${JSON.stringify(got)}`);
    else bad(`${label} => ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
  };
  const truthy = (label, got) => (got ? ok(`${label} => truthy`) : bad(`${label} => ${JSON.stringify(got)} (expected truthy)`));
  const need = (n) => { const f = fn(n); if (!f) bad(`${n} — missing (safety function vanished!)`); return f; };

  // write authorization: writes need explicit intent; problem reports do not authorize
  const cwa = need('classifyWriteAuthorization');
  if (cwa) {
    eq("classifyWriteAuthorization('delete the TB program').scope", cwa('delete the TB program').scope, 'broad');
    eq("classifyWriteAuthorization('create a program indicator').scope", cwa('create a program indicator').scope, 'broad');
    eq("classifyWriteAuthorization('yes').scope", cwa('yes').scope, 'broad');
    eq("classifyWriteAuthorization('why is saving failing?').scope", cwa('why is saving failing?').scope, 'read_only');
    eq("classifyWriteAuthorization('diagnose the enrollment issue').scope", cwa('diagnose the enrollment issue').scope, 'read_only');
  }

  // DHIS2 UID recognition — entropy gate rejects English-word-shaped tokens
  const uid = need('isLikelyDhisUid');
  if (uid) {
    eq("isLikelyDhisUid('a3kGcGpz8FJ')", uid('a3kGcGpz8FJ'), true);
    eq("isLikelyDhisUid('XGcG2PFIvOU')", uid('XGcG2PFIvOU'), true);
    eq("isLikelyDhisUid('Respiratory')", uid('Respiratory'), false);
    eq("isLikelyDhisUid('short')", uid('short'), false);
  }
  const shape = need('hasUidShape');
  if (shape) { eq("hasUidShape('a3kGcGpz8FJ')", shape('a3kGcGpz8FJ'), true); eq("hasUidShape('nope')", shape('nope'), false); }

  // generated UIDs must satisfy the DHIS2 UID shape
  const gen = need('generateDhis2Uid');
  if (gen) { const u = gen(); truthy(`generateDhis2Uid() = ${JSON.stringify(u)} matches /^[A-Za-z][A-Za-z0-9]{10}$/`, /^[A-Za-z][A-Za-z0-9]{10}$/.test(u)); }

  // patient-data privacy path gate (row-level tracker/analytics blocked, aggregate/metadata allowed)
  const priv = need('pathReadsPatientData');
  if (priv) {
    eq("pathReadsPatientData('tracker/events')", priv('tracker/events'), true);
    eq("pathReadsPatientData('tracker/trackedEntities.json')", priv('tracker/trackedEntities.json'), true);
    eq("pathReadsPatientData('analytics/events/query/PROG')", priv('analytics/events/query/PROG'), true);
    eq("pathReadsPatientData('trackedEntityInstances.csv')", priv('trackedEntityInstances.csv'), true);
    eq("pathReadsPatientData('analytics/events/aggregate/PROG')", priv('analytics/events/aggregate/PROG'), false);
    eq("pathReadsPatientData('programs?fields=id')", priv('programs?fields=id'), false);
  }

  // the two normalizers that used to collide under one name
  const lc = need('lowercaseText'), ns = need('normalizeSearchTokens');
  if (lc) eq("lowercaseText('Sub-County')", lc('Sub-County'), 'sub-county');
  if (ns) eq("normalizeSearchTokens('Sub-County!')", ns('Sub-County!'), 'sub county');
  eq('normalizeText is gone (dedup regression guard)', typeof ctx.normalizeText, 'undefined');

  // the descendant trigger the dedup bug had silently disabled
  const desc = need('userExplicitlyWantsDescendants');
  if (desc) {
    eq("userExplicitlyWantsDescendants('counts for all sub-counties')", desc('counts for all sub-counties'), true);
    eq("userExplicitlyWantsDescendants('this facility only')", desc('this facility only'), false);
  }

  // strict query encoding (self-hosted Tomcat 400s on raw brackets)
  const enc = need('encodeStrictQueryChars');
  if (enc) eq("encodeStrictQueryChars('filter=a[b]')", enc('filter=a[b]'), 'filter=a%5Bb%5D');

  // line-listing router returns a block-id array
  const route = need('routeLineListingBlocks');
  if (route) truthy("routeLineListingBlocks('show me a line list') is an array", Array.isArray(route('show me a line list')));
}

console.log('');
if (failures) { console.error(`\x1b[31mFAILED\x1b[0m — ${failures} check(s) failed\n`); process.exit(1); }
console.log('\x1b[32mAll checks passed.\x1b[0m\n');
