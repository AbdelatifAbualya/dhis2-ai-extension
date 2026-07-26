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
  'src/tools-metadata.js', 'src/tools-programs.js', 'src/tools-linelists.js',
  'src/agent.js',
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
  // `dhis2` is a bundle-lexical `let`, so expose a reader for the few checks
  // that need to drive per-turn counters (the loop guards).
  vm.runInContext(bundle + '\n;globalThis.__dhis2 = () => dhis2;',
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

// setImmediate: a few checks are async (promise-returning safety gates); they
// resolve on the microtask queue, so the verdict must run after it drains.
setImmediate(() => {
  console.log('');
  if (failures) { console.error(`\x1b[31mFAILED\x1b[0m — ${failures} check(s) failed\n`); process.exit(1); }
  console.log('\x1b[32mAll checks passed.\x1b[0m\n');
});
