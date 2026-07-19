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

  // no-progress guard: identical EXECUTED calls are refused once the model is
  // clearly looping — the defect that let manage_dashboards(list) run 45× and
  // burn the whole iteration budget (2026-07-13). Guards run over a fresh
  // per-turn state (executedCallSigs is created lazily on first note).
  const noteExec = need('noteExecutedCall');
  const noProg = need('noProgressStopOrNull');
  const preflight = need('preflightCheckCall');
  if (noteExec && noProg && preflight) {
    const loopArgs = { action: 'list' };
    eq('noProgressStopOrNull before any run => null', noProg('manage_dashboards', loopArgs), null);
    eq('1st identical execution count', noteExec('manage_dashboards', loopArgs), 1);
    eq('2nd identical execution count', noteExec('manage_dashboards', loopArgs), 2);
    eq('noProgress after 2 runs (still under limit) => null', noProg('manage_dashboards', loopArgs), null);
    eq('3rd identical execution count', noteExec('manage_dashboards', loopArgs), 3);
    const stop = noProg('manage_dashboards', loopArgs);
    eq('noProgress after 3 identical runs → blocked scope', stop && stop._scope, 'no_progress_repeat');
    // key ordering must not matter (stable signature)
    truthy('preflightCheckCall refuses the looping call (any key order)',
      preflight('manage_dashboards', { action: 'list' }) &&
      preflight('manage_dashboards', { action: 'list' })._scope === 'no_progress_repeat');
    // a DIFFERENT call is unaffected — no false positive on genuine progress
    eq('different args are NOT blocked', noProg('manage_dashboards', { action: 'get', id: 'abc' }), null);
    eq('a different tool is NOT blocked', noProg('search_metadata', { object_type: 'programs' }), null);
  }

  // Fix A — a dashboard-app request to "create an indicator" for a tracker
  // enrollment metric must surface manage_program_indicators (the AGGREGATE
  // manage_indicators tool cannot count enrollments by a tracked-entity attr).
  const getTools = need('getContextualTools');
  if (getTools) {
    // The EXACT message from the 2026-07-13 report, typos and all ("incdicator",
    // "dahboard", "visulization") — those typos defeated every indicator/
    // dashboard keyword, so the fix must not depend on spelling. On the
    // Dashboard app the chart-metric tools must be present regardless.
    const req = 'remove this visulization Monthly Screening Trends by Method from the dahboard and replace it with a visulization that show percentge of male vs females that are enrolled in the program, note that you likely need to create an incdicator for this to work';
    let names = [];
    try { names = getTools({ appType: 'Dashboard' }, req, false, null).map((t) => t.function.name); }
    catch (e) { bad(`getContextualTools threw: ${e && e.message}`); }
    truthy('Dashboard app surfaces manage_program_indicators (typo-proof)', names.includes('manage_program_indicators'));
    truthy('Dashboard app surfaces manage_indicators', names.includes('manage_indicators'));
    truthy('Dashboard app surfaces get_program_info', names.includes('get_program_info'));
    truthy('Dashboard app still surfaces manage_dashboards', names.includes('manage_dashboards'));

    // Fix D — get_program_info must accept program_id / program_name so it works
    // from a page with no program in context (it dead-ended on "No program in
    // context" in the 2026-07-13 report even though the model knew the UID).
    const defs = getTools({ appType: 'Dashboard' }, req, false, null);
    const gpi = defs.find((t) => t.function.name === 'get_program_info');
    const props = (gpi && gpi.function.parameters && gpi.function.parameters.properties) || {};
    truthy('get_program_info schema exposes program_id', !!props.program_id);
    truthy('get_program_info schema exposes program_name', !!props.program_name);

    // Batch program-indicator create (v2.8.18) — the schema must expose an
    // `indicators` array so a big analytics build commits many PIs in ONE call
    // instead of one-per-loop-iteration (the 47-PI pregnancy disaster). The tool
    // description must steer toward the batch + single-PI percentage pattern.
    const mpi = defs.find((t) => t.function.name === 'manage_program_indicators');
    const mpiProps = (mpi && mpi.function.parameters && mpi.function.parameters.properties) || {};
    truthy('manage_program_indicators schema exposes indicators[] (batch)', !!(mpiProps.indicators && mpiProps.indicators.type === 'array'));
    truthy('manage_program_indicators still exposes single indicator', !!mpiProps.indicator);
    truthy('manage_program_indicators description teaches batch', /BATCH/.test(mpi.function.description || ''));
    truthy('manage_program_indicators description teaches single-PI % (AVERAGE)', /AVERAGE/.test(mpi.function.description || '') && /d2:condition/.test(mpi.function.description || ''));

    // A MAP is refused as a visualization type, and the refusal must point at
    // manage_maps + the { type:"MAP", map_id } dashboard tile (2026-07-19: kimi
    // tried to inline a map as new_visualization and needed the recovery hint).
    const buildViz = fn('buildVisualizationObject');
    if (buildViz) {
      const mapRefusal = buildViz({ name: 'X', vis_type: 'MAP', data_items: ['abcdef12345'], periods: ['LAST_12_MONTHS'], org_units: ['USER_ORGUNIT'] }, {});
      truthy('vis_type MAP is refused', !!(mapRefusal && mapRefusal._error));
      truthy('vis_type MAP refusal hints manage_maps', !!(mapRefusal && /manage_maps/.test(mapRefusal._hint || '')));
    } else {
      bad('buildVisualizationObject — missing (cannot verify MAP refusal hint)');
    }
  }

  // Named-program substitution guard — a user-named program that searches
  // proved absent must BLOCK program-bound writes against a lookalike program
  // (the 2026-07-19 incident: line lists silently built on the MCH program
  // when "Integrated Pregnancy, Delivery and Postnatal Care Tracker" did not
  // exist). Async check runs against a pre-seeded name cache — no network.
  // The `dhis2` state object lives in the bundle's lexical scope (a top-level
  // `let`), so it is NOT reachable as a context property — the guard is
  // therefore exercised purely through its own functions, which read/write
  // that state. safeDhis2Fetch is stubbed so program-name resolution needs no
  // network; overriding the context property redirects the internal call.
  const noteMissing = need('noteMissingNamedTarget');
  const clearFound = need('clearNamedTargetsFoundIn');
  const subStop = need('namedProgramSubstitutionStop');
  if (noteMissing && clearFound && subStop) {
    const NAMES = {
      hwuYFxYpWyK: 'Maternal and Child Health (MCH) Program',
      aBcDeFgHiJ2: 'Integrated Pregnancy, Delivery and Postnatal Care Tracker',
    };
    ctx.safeDhis2Fetch = async (p) => {
      const m = String(p).match(/programs\/([A-Za-z][A-Za-z0-9]{10})/);
      const id = m && m[1];
      return id && NAMES[id] ? { id, displayName: NAMES[id] } : { _error: 'not found' };
    };
    (async () => {
      // Generic / wrong-type searches must NOT arm the guard: a lookalike write
      // stays allowed (subStop returns null when nothing is armed).
      noteMissing('programs', 'ANC');                     // 1 word, <10 chars
      noteMissing('dataElements', 'Integrated Pregnancy'); // wrong object type
      eq('generic/wrong-type searches leave lookalike writes allowed',
        await subStop('manage_line_lists', 'create', 'hwuYFxYpWyK'), null);

      // A specific failed program search arms the guard → lookalike write blocked.
      noteMissing('programs', 'Integrated Pregnancy');
      const blocked = await subStop('manage_line_lists', 'create', 'hwuYFxYpWyK');
      truthy('write on a lookalike program is BLOCKED',
        blocked && blocked._scope === 'named_program_substitution_blocked');

      // A write on a program whose name matches the missing one passes AND
      // disarms — so the "create the missing program, then build on it" flow
      // is never blocked. Prove disarm: the lookalike write is allowed after.
      eq('write on a program matching the missing name passes',
        await subStop('manage_line_lists', 'create', 'aBcDeFgHiJ2'), null);
      eq('matching write disarmed the guard (lookalike now allowed)',
        await subStop('manage_line_lists', 'create', 'hwuYFxYpWyK'), null);

      // Finding the program later under a variant spelling also disarms it.
      noteMissing('programs', 'Integrated Pregnancy');
      clearFound(['Integrated Pregnancy, Delivery and Postnatal Care Tracker']);
      eq('a found program name containing the query disarms the guard',
        await subStop('manage_line_lists', 'create', 'hwuYFxYpWyK'), null);
    })().catch((e) => bad(`namedProgramSubstitutionStop threw: ${e && e.message}`));
  }

  // Broken-tile fix — a TRACKER-domain data element is not a valid aggregate dx
  // item; buildVisualizationObject must refuse it (the 3-of-5-tiles-broken
  // report) with a program-indicator pointer, while still building normal PIs.
  const buildViz = need('buildVisualizationObject');
  if (buildViz) {
    const base = { name: 'T', vis_type: 'PIE', periods: ['LAST_12_MONTHS'], org_units: ['USER_ORGUNIT'] };
    const trk = buildViz({ ...base, data_items: ['NfmqhsFpwnv'] }, { NfmqhsFpwnv: 'TRACKER_DATA_ELEMENT' });
    truthy('tracker data element is REFUSED as a viz data_item', trk && !!trk._error && trk._tracker_data_element === 'NfmqhsFpwnv');
    const pi = buildViz({ ...base, data_items: ['G2ON5cPuXxf'] }, { G2ON5cPuXxf: 'PROGRAM_INDICATOR' });
    truthy('program indicator still builds a valid visualization', pi && !pi._error && !!pi.viz);
  }
}

// setImmediate: a few checks are async (promise-returning safety gates); they
// resolve on the microtask queue, so the verdict must run after it drains.
setImmediate(() => {
  console.log('');
  if (failures) { console.error(`\x1b[31mFAILED\x1b[0m — ${failures} check(s) failed\n`); process.exit(1); }
  console.log('\x1b[32mAll checks passed.\x1b[0m\n');
});
