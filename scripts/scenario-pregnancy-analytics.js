#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-pregnancy-analytics.js — Tier-2 live proof for the BATCH program-
 * indicator create path + the single-PI percentage pattern (v2.8.18).
 *
 * Drives the REAL executeTool against a live DHIS2 the way the "build the
 * analytical package for a tracker" prompt should be executed:
 *   1. discover the Integrated Pregnancy … Tracker + read its structure,
 *   2. BATCH-create 16 program indicators in ONE call — a mix of AVERAGE
 *      d2:condition(…,100,0) coverage %s and COUNT headline/breakdown counts,
 *   3. create a legend set + 2 thematic maps from those PIs,
 *   4. create the whole dashboard in ONE call (inline line/column/single-value/
 *      pivot visualizations + map tiles + text section headers),
 *   5. VERIFY every object exists and the batch reported 0 failures,
 *   6. DELETE everything and confirm the instance is left exactly as found.
 *
 * PASS = 0 failed API calls across build+verify AND cleanup leaves nothing behind.
 * Run: DHIS2_BASE=http://localhost:8081 DHIS2_AUTH=admin:district \
 *      node scripts/scenario-pregnancy-analytics.js
 * ───────────────────────────────────────────────────────────────────────────── */
const { load, API, summarize } = require('./live-harness');

const PROGRAM_NAME = 'Integrated Pregnancy, Delivery and Postnatal Care Tracker';
// Stage + DE UIDs (read live 2026-07-19; the scenario re-verifies the program by name).
const S = {
  reg: 'FIPs4MVhcok', gaFirst: 'npYTHMLdHdU', risk: 'bicgF8cFlIi',
  anc: 'eLbsatQYt3r', contactNo: 'PTVf4IV9qa8',
  lab: 'jJjqV8lrvBW', syphRes: 'iO3IfET8qlR', syphTx: 'UgBlxzAzuA0',
  del: 'INCOq0irB5o', gaDel: 'wrcr3ljPnVA', mode: 'Gv2Z5A3RPq1', nbOutcome: 'ONbE3Dljuoy', bw: 'VqMgzEbHImx',
  pnc: 'bxW0k4VKZeA', pncTiming: 'lqzDTkTn3ht',
};

const pct = (name, filter, numCond, extra) => ({
  name, short_name: name.slice(0, 50), analytics_type: 'ENROLLMENT', aggregation_type: 'AVERAGE',
  decimals: 1, filter, expression: `d2:condition("${numCond}", 100, 0)`, ...(extra || {}),
});
const count = (name, filter) => ({
  name, short_name: name.slice(0, 50), analytics_type: 'ENROLLMENT', aggregation_type: 'COUNT',
  expression: 'V{enrollment_count}', ...(filter ? { filter } : {}),
});

function buildIndicators() {
  return [
    pct('Early ANC initiation percentage', `#{${S.reg}.${S.gaFirst}} < 999`, `#{${S.reg}.${S.gaFirst}} < 12`),
    count('Early ANC initiation numerator', `#{${S.reg}.${S.gaFirst}} < 12`),
    count('Early ANC initiation denominator', `#{${S.reg}.${S.gaFirst}} < 999`),
    pct('ANC four or more contacts percentage', `#{${S.del}.${S.gaDel}} < 999`, `d2:count(#{${S.anc}.${S.contactNo}}) >= 4`),
    pct('ANC eight or more contacts percentage', `#{${S.del}.${S.gaDel}} < 999`, `d2:count(#{${S.anc}.${S.contactNo}}) >= 8`),
    pct('High or Critical risk pregnancies percentage', '', `#{${S.reg}.${S.risk}} == 'HIGH' || #{${S.reg}.${S.risk}} == 'CRITICAL'`),
    count('Active High or Critical risk pregnancies count', `#{${S.reg}.${S.risk}} == 'HIGH' || #{${S.reg}.${S.risk}} == 'CRITICAL'`),
    count('Active pregnancies by risk Low count', `#{${S.reg}.${S.risk}} == 'LOW'`),
    count('Active pregnancies by risk Moderate count', `#{${S.reg}.${S.risk}} == 'MODERATE'`),
    count('Active pregnancies by risk High count', `#{${S.reg}.${S.risk}} == 'HIGH'`),
    count('Active pregnancies by risk Critical count', `#{${S.reg}.${S.risk}} == 'CRITICAL'`),
    pct('Syphilis treatment coverage percentage', `#{${S.lab}.${S.syphRes}} == 'POSITIVE'`, `#{${S.lab}.${S.syphTx}} == true`),
    pct('Caesarean section rate percentage', `#{${S.del}.${S.gaDel}} < 999`, `#{${S.del}.${S.mode}} == 'PLANNED_CAESAREAN_SECTION' || #{${S.del}.${S.mode}} == 'EMERGENCY_CAESAREAN_SECTION'`),
    pct('Low birth weight rate percentage', `#{${S.del}.${S.nbOutcome}} == 'LIVE_BIRTH' && #{${S.del}.${S.bw}} < 9999`, `#{${S.del}.${S.bw}} < 2500`),
    count('Live births count', `#{${S.del}.${S.nbOutcome}} == 'LIVE_BIRTH'`),
    pct('Timely postnatal contact percentage', `#{${S.del}.${S.nbOutcome}} == 'LIVE_BIRTH'`, `#{${S.pnc}.${S.pncTiming}} == 'WITHIN_24_HOURS' || #{${S.pnc}.${S.pncTiming}} == '48_TO_72_HOURS'`),
  ];
}

(async () => {
  const ctx = load({ appType: 'Dashboard' });
  const created = { pis: [], viz: [], maps: [], legends: [], dashboards: [] };
  let failStage = null;
  const die = (stage, detail) => { failStage = stage; throw new Error(`${stage}: ${detail}`); };

  try {
    // 1 ── discover program + read structure
    const search = await ctx.executeTool('search_metadata', { object_type: 'programs', name_filter: 'Integrated Pregnancy' });
    const prog = (search.programs || search.results || []).find(p => (p.displayName || p.name) === PROGRAM_NAME) || (search.programs || [])[0];
    if (!prog?.id) die('discover', `program "${PROGRAM_NAME}" not found — ${JSON.stringify(search).slice(0, 200)}`);
    const programId = prog.id;
    console.log(`✓ program ${programId}`);
    const info = await ctx.executeTool('get_program_info', { info_type: 'stage_details', program_id: programId });
    if (info?._error) die('get_program_info', info._error);

    // 2 ── BATCH create 16 program indicators in ONE call
    const indicators = buildIndicators();
    const batch = await ctx.executeTool('manage_program_indicators', { action: 'create', program_id: programId, indicators });
    if (batch?._error) die('batch-create', `${batch._error} ${JSON.stringify(batch.failed || '').slice(0, 400)}`);
    if (!batch.success) die('batch-create', `not success: ${JSON.stringify(batch).slice(0, 300)}`);
    if (batch.failed_count) die('batch-create', `${batch.failed_count} indicator(s) failed: ${JSON.stringify(batch.failed).slice(0, 500)}`);
    if (batch.created_count !== indicators.length) die('batch-create', `expected ${indicators.length} created, got ${batch.created_count}`);
    created.pis = batch.program_indicator_ids.slice();
    console.log(`✓ batch created ${batch.created_count} program indicators in ONE call (${batch.program_indicator_ids.length} UIDs)`);
    const byName = {};
    for (const c of batch.created) byName[c.name] = c.id;
    const idOf = n => byName[n] || die('id-lookup', `no UID for "${n}"`);

    // 3 ── legend set + 2 maps
    const legend = await ctx.executeTool('manage_legend_sets', { action: 'create', legend_set: { name: `MNCH Coverage RAG ${Date.now()}` }, auto_bands: { start: 0, end: 100, count: 3 } });
    const legendId = legend.legend_set_id || legend?.summary?.id || legend?.id;
    if (!legendId) die('legend', JSON.stringify(legend).slice(0, 300));
    created.legends.push(legendId);
    console.log(`✓ legend set ${legendId}`);

    for (const [name, piName] of [['LBW by district', 'Low birth weight rate percentage'], ['High/Critical risk by district', 'High or Critical risk pregnancies percentage']]) {
      const map = await ctx.executeTool('manage_maps', { action: 'create', name: `${name} ${Date.now()}`, data_item: idOf(piName), org_unit_level: 2, period: 'LAST_12_MONTHS', legend_set_id: legendId });
      if (map?._error || !map.map_id) die('map', `${name}: ${map?._error || JSON.stringify(map).slice(0, 200)}`);
      created.maps.push(map.map_id);
    }
    console.log(`✓ ${created.maps.length} thematic maps`);

    // 4 ── one dashboard, many inline visualizations + map tiles + text headers
    const ou = ['USER_ORGUNIT'];
    const items = [
      { type: 'TEXT', text: '## Headline' },
      { new_visualization: { name: `Active High/Critical (card) ${Date.now()}`, vis_type: 'SINGLE_VALUE', data_items: [idOf('Active High or Critical risk pregnancies count')], periods: ['THIS_YEAR'], org_units: ou } },
      { new_visualization: { name: `Live births (card) ${Date.now()}`, vis_type: 'SINGLE_VALUE', data_items: [idOf('Live births count')], periods: ['THIS_YEAR'], org_units: ou } },
      { type: 'TEXT', text: '## ANC coverage' },
      { new_visualization: { name: `Early ANC over time ${Date.now()}`, vis_type: 'LINE', data_items: [idOf('Early ANC initiation percentage')], periods: ['LAST_12_MONTHS'], org_units: ou } },
      { new_visualization: { name: `ANC 4+ vs 8+ ${Date.now()}`, vis_type: 'COLUMN', data_items: [idOf('ANC four or more contacts percentage'), idOf('ANC eight or more contacts percentage')], periods: ['LAST_4_QUARTERS'], org_units: ou } },
      { new_visualization: { name: `ANC coverage table ${Date.now()}`, vis_type: 'PIVOT_TABLE', data_items: [idOf('Early ANC initiation numerator'), idOf('Early ANC initiation denominator'), idOf('Early ANC initiation percentage')], periods: ['LAST_12_MONTHS'], org_units: ou } },
      { type: 'TEXT', text: '## Clinical risk & delivery' },
      { new_visualization: { name: `Risk mix ${Date.now()}`, vis_type: 'STACKED_COLUMN', data_items: [idOf('Active pregnancies by risk Low count'), idOf('Active pregnancies by risk Moderate count'), idOf('Active pregnancies by risk High count'), idOf('Active pregnancies by risk Critical count')], periods: ['THIS_YEAR'], org_units: ou } },
      { new_visualization: { name: `Caesarean rate ${Date.now()}`, vis_type: 'COLUMN', data_items: [idOf('Caesarean section rate percentage')], periods: ['LAST_12_MONTHS'], org_units: ou } },
      { new_visualization: { name: `Syphilis tx coverage ${Date.now()}`, vis_type: 'COLUMN', data_items: [idOf('Syphilis treatment coverage percentage')], periods: ['LAST_4_QUARTERS'], org_units: ou } },
      { type: 'TEXT', text: '## Postnatal & geography' },
      { new_visualization: { name: `Timely PNC ${Date.now()}`, vis_type: 'LINE', data_items: [idOf('Timely postnatal contact percentage')], periods: ['LAST_12_MONTHS'], org_units: ou } },
      { type: 'MAP', map_id: created.maps[0] },
      { type: 'MAP', map_id: created.maps[1] },
    ];
    const dash = await ctx.executeTool('manage_dashboards', { action: 'create_dashboard', dashboard: { name: `Maternal and Newborn Continuum Dashboard ${Date.now()}` }, items });
    if (dash?._error || !dash.dashboard_id) die('dashboard', dash?._error || JSON.stringify(dash).slice(0, 300));
    created.dashboards.push(dash.dashboard_id);
    for (const v of (dash.new_visualizations || [])) created.viz.push(v.id);
    console.log(`✓ dashboard ${dash.dashboard_id} with ${dash.items} items (${created.viz.length} inline visualizations)`);

    // 5 ── verify persistence
    const verifyPis = await ctx.executeTool('dhis2_query', { path: `programIndicators.json?filter=id:in:[${created.pis.join(",")}]&fields=id,analyticsType,aggregationType&pageSize=100` });
    if ((verifyPis.programIndicators || []).length !== created.pis.length) die('verify', `only ${(verifyPis.programIndicators || []).length}/${created.pis.length} PIs persisted`);
    const avgCount = (verifyPis.programIndicators || []).filter(p => p.aggregationType === 'AVERAGE').length;
    console.log(`✓ verified ${created.pis.length} PIs persisted (${avgCount} AVERAGE percentage PIs, ${created.pis.length - avgCount} COUNT)`);

    const buildWindow = summarize(0, API.length);
    if (buildWindow.failed.length) {
      console.log('\nFAILED API CALLS during build/verify:');
      for (const f of buildWindow.failed) console.log(`  ${f.method} ${f.url} → ${f.status}`);
      die('api-failures', `${buildWindow.failed.length} failed call(s)`);
    }
    console.log(`\n✓ BUILD+VERIFY: ${buildWindow.total} API calls, 0 failed`);
  } catch (e) {
    console.log(`\n✗ SCENARIO FAILED at ${failStage || '?'}: ${e.message}`);
  }

  // 6 ── cleanup (snapshot so post-delete 404 probes don't count as build failures)
  const cleanupStart = API.length;
  console.log('\n── cleanup ──');
  for (const id of created.dashboards) await ctx.executeTool('manage_dashboards', { action: 'delete', dashboard_id: id }).catch(() => {});
  for (const id of created.viz) await ctx.executeTool('manage_metadata', { action: 'delete', object_type: 'visualizations', object_id: id }).catch(() => {});
  for (const id of created.maps) await ctx.executeTool('manage_maps', { action: 'delete', map_id: id }).catch(() => {});
  for (const id of created.legends) await ctx.executeTool('manage_legend_sets', { action: 'delete', legend_set_id: id }).catch(() => {});
  for (const id of created.pis) await ctx.executeTool('manage_program_indicators', { action: 'delete', indicator_id: id }).catch(() => {});

  // confirm nothing left behind
  let leftovers = 0;
  if (created.pis.length) {
    const chk = await ctx.executeTool('dhis2_query', { path: `programIndicators.json?filter=id:in:[${created.pis.join(",")}]&fields=id&pageSize=100` });
    leftovers += (chk.programIndicators || []).length;
  }
  if (created.dashboards.length) {
    const chk = await ctx.executeTool('dhis2_query', { path: `dashboards.json?filter=id:in:[${created.dashboards.join(",")}]&fields=id&pageSize=100` });
    leftovers += (chk.dashboards || []).length;
  }
  console.log(`cleanup done — ${leftovers} object(s) left behind`);

  const build = summarize(0, cleanupStart);
  const pass = !failStage && build.failed.length === 0 && leftovers === 0;
  console.log(`\n══════ ${build.total} build API calls, ${build.failed.length} failed; ${leftovers} leftovers ══════`);
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(pass ? 0 : 1);
})();
