#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-mnch-dashboard.js — replays the 2026-10-29 "MNCH / PNC (Adult
 * Woman)" dashboard thread through the REAL executeTool pipeline against a
 * LIVE Sierra Leone demo instance (the program uy2gU8kT1jF ships with it):
 *
 *   DHIS2_BASE=https://play.im.dhis2.org/stable-2-43-2 DHIS2_APIVER=43 \
 *     node scripts/scenario-mnch-dashboard.js
 *
 * The thread asked for: a table of all org units with the % of women who
 * attended ANC 1 and ANC 2-4, a line chart of attended visits across org
 * units, and a map with a point per org unit sized by the % attending ANC 1-4.
 * It failed on every analytics-runtime trap below; this run proves each one is
 * now refused or healed BEFORE it reaches the server, and that the supported
 * equivalent (pivot table, column chart, bubble map, dashboard) builds clean:
 *   1. indicators: V{tei_count}+SUM healed to COUNT; countIfValue on a text DE
 *      (2.43) and a stage-named all-stage event count refused; the rest created
 *      and computed once by analytics (runtime_check)
 *   2. line list: a % column / a count column refused with the pivot-table
 *      alternative; joined "LEVEL-4;<uid>" org units healed
 *   3. raw dhis2_query POSTs of visualizations / maps / dashboards refused
 *   4. pivot table (org units × %), column chart (districts × visits), bubble
 *      map (facilities sized by %), one dashboard holding all of them
 *   5. full cleanup
 * PASS = every assertion holds AND zero failed API calls (build + cleanup).
 * ───────────────────────────────────────────────────────────────────────────── */
const { load, API, summarize, APIVER } = require('./live-harness');

const PROG = 'uy2gU8kT1jF';
const S_ANC1 = 'eaDHS084uMp', S_ANC24 = 'grIfo3oOf4Y';
const DE_WEIGHT = 'UXz7xuGCEhU', DE_VISIT = 'g9eOBujte1U'; // NUMBER, TEXT (option set)
const SL = 'ImspTQPwCqd';
const TAG = `ai-test-mnch-${Date.now().toString(36)}`;

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const show = (r) => JSON.stringify(r === undefined ? null : r).slice(0, 400);

(async () => {
  const ctx = load({ appType: 'Dashboard' });
  const t = (name, args) => ctx.executeTool(name, args);
  const made = { pis: [], viz: [], map: null, dash: null, lineList: null };

  try {
    console.log(`\n1. Program indicators (DHIS2 API v${APIVER})`);
    const r = await t('manage_program_indicators', {
      action: 'create', program_id: PROG,
      indicators: [
        // The thread's first broken one: SUM on a count variable (SQL 42883).
        { name: `${TAG} ANC 1st visit attendees`, analytics_type: 'ENROLLMENT', aggregation_type: 'SUM', expression: 'V{tei_count}', filter: `d2:hasValue(#{${S_ANC1}.${DE_WEIGHT}})` },
        // countIfValue on a TEXT/option DE → 42883 on 2.43.
        { name: `${TAG} ANC visit 2 count`, analytics_type: 'ENROLLMENT', aggregation_type: 'SUM', expression: `d2:countIfValue(#{${S_ANC24}.${DE_VISIT}}, '2')` },
        // Named after a stage, counts every stage's events.
        { name: `${TAG} ANC 1st visit count`, analytics_type: 'EVENT', aggregation_type: 'COUNT', expression: 'V{event_count}' },
        // The supported forms.
        { name: `${TAG} % attended ANC 1st visit`, analytics_type: 'ENROLLMENT', aggregation_type: 'AVERAGE', decimals: 1, expression: `d2:condition("d2:hasValue(#{${S_ANC1}.${DE_WEIGHT}})", 100, 0)` },
        { name: `${TAG} % attended ANC visits 2-4`, analytics_type: 'ENROLLMENT', aggregation_type: 'AVERAGE', decimals: 1, expression: `d2:condition("d2:hasValue(#{${S_ANC24}.${DE_VISIT}})", 100, 0)` },
        { name: `${TAG} % attended ANC 1-4`, analytics_type: 'ENROLLMENT', aggregation_type: 'AVERAGE', decimals: 1, expression: `d2:condition("d2:hasValue(#{${S_ANC1}.${DE_WEIGHT}}) || d2:hasValue(#{${S_ANC24}.${DE_VISIT}})", 100, 0)` },
        { name: `${TAG} ANC 1st visits`, analytics_type: 'EVENT', aggregation_type: 'COUNT', expression: 'V{event_count}', filter: `V{program_stage_id} == '${S_ANC1}'` },
        { name: `${TAG} ANC 2-4 visits`, analytics_type: 'EVENT', aggregation_type: 'COUNT', expression: 'V{event_count}', filter: `V{program_stage_id} == '${S_ANC24}'` },
      ],
    });
    made.pis.push(...(r.program_indicator_ids || []));
    const byName = new Map((r.created || []).map((p) => [p.name.replace(`${TAG} `, ''), p]));
    check('batch created the 6 valid indicators', r.success && r.created_count === 6, show(r));
    check('V{tei_count} + SUM healed to COUNT (and reported)', byName.get('ANC 1st visit attendees')?.aggregationType === 'COUNT' && (r.auto_corrected || []).length === 1, show(r.auto_corrected));
    const failedNames = (r.failed || []).map((f) => f.name.replace(`${TAG} `, ''));
    if (APIVER >= 43) check('countIfValue on a text data element refused (2.43)', failedNames.includes('ANC visit 2 count'), show(r.failed));
    check('stage-named all-stage event count refused with the stage filter', failedNames.includes('ANC 1st visit count') && /V\{program_stage_id\}/.test(JSON.stringify(r.failed)), show(r.failed));
    check('every created indicator computed once in analytics', r.runtime_check && r.runtime_check.ok === true && r.runtime_check.checked === 6, show(r.runtime_check));
    const id = (n) => byName.get(n)?.id;

    console.log('\n2. Line list limits');
    const ll = await t('manage_line_lists', {
      action: 'create', name: `${TAG} ANC coverage by facility`, output_type: 'ENROLLMENT', program_id: PROG,
      columns: [{ dimension: 'ou', org_units: [`LEVEL-4;${SL}`] }, id('% attended ANC 1st visit'), id('ANC 1st visit attendees')],
      filters: [{ dimension: 'enrollment_date', periods: ['LAST_12_MONTHS'] }],
    });
    check('a % column refused with the pivot-table alternative (nothing saved)', ll._error && /PERCENTAGE/.test(ll._error) && /PIVOT_TABLE/.test(ll._hint || ''), show(ll));
    const ll2 = await t('manage_line_lists', {
      action: 'create', name: `${TAG} ANC count list`, output_type: 'ENROLLMENT', program_id: PROG,
      columns: [{ dimension: 'ou', org_units: [`LEVEL-4;${SL}`] }, id('ANC 1st visit attendees')],
      filters: [{ dimension: 'enrollment_date', periods: ['LAST_12_MONTHS'] }],
    });
    check('a count-of-records column refused (it would show 1 on every row)', ll2._error && /1 on every row/.test(ll2._error), show(ll2));
    const ll3 = await t('manage_line_lists', {
      action: 'create', name: `${TAG} ANC visit register`, output_type: 'ENROLLMENT', program_id: PROG,
      columns: [{ dimension: 'ou', org_units: [`LEVEL-4;${SL}`] }, { dimension: DE_VISIT, program_stage_id: S_ANC24 }],
      filters: [{ dimension: 'enrollment_date', periods: ['THIS_YEAR', 'LAST_YEAR'] }],
    });
    made.lineList = ll3.line_list_id || ll3.id || null;
    check('a real row-per-woman register saves with the joined "LEVEL-4;<uid>" org units healed', !ll3._error && made.lineList, show(ll3));

    console.log('\n3. Raw analytics-object writes');
    const before = API.length;
    const rawViz = await t('dhis2_query', { method: 'POST', path: 'visualizations', body: { name: `${TAG} raw`, type: 'LINE', columns: [{ dimension: 'ou', items: [{ id: SL }] }] } });
    const rawMap = await t('dhis2_query', { method: 'POST', path: 'maps', body: { name: `${TAG} raw`, mapViews: [{ layer: 'thematic', renderingStrategy: 'SINGLE_COLOR' }] } });
    const rawDash = await t('dhis2_query', { method: 'POST', path: 'dashboards', body: { name: `${TAG} raw` } });
    check('raw POST visualizations / maps / dashboards refused with the right tool, nothing sent', rawViz._redirect === 'manage_dashboards' && rawMap._redirect === 'manage_maps' && rawDash._redirect === 'manage_dashboards' && API.length === before, show([rawViz._error, rawMap._error]));

    console.log('\n4. The supported equivalents');
    const pivot = await t('manage_dashboards', {
      action: 'create_visualization',
      visualization: {
        name: `${TAG} ANC attendance by facility`, vis_type: 'PIVOT_TABLE',
        data_items: [id('% attended ANC 1st visit'), id('% attended ANC visits 2-4')],
        periods: ['THIS_YEAR'], org_units: [SL, 'LEVEL-4'],
        layout: { rows: ['ou'], columns: ['dx'], filters: ['pe'] },
      },
    });
    if (pivot.visualization_id) made.viz.push(pivot.visualization_id);
    check('pivot table: facilities × % columns', !pivot._error && pivot.visualization_id, show(pivot));
    const chart = await t('manage_dashboards', {
      action: 'create_visualization',
      visualization: {
        name: `${TAG} ANC visits by district`, vis_type: 'COLUMN',
        data_items: [id('ANC 1st visits'), id('ANC 2-4 visits')],
        periods: ['THIS_YEAR'], org_units: [SL, 'LEVEL-2'],
        layout: { columns: ['dx'], rows: ['ou'], filters: ['pe'] },
      },
    });
    if (chart.visualization_id) made.viz.push(chart.visualization_id);
    check('column chart: districts × visit counts', !chart._error && chart.visualization_id, show(chart));
    const map = await t('manage_maps', {
      action: 'create', name: `${TAG} ANC 1-4 attendance by facility`, data_item: id('% attended ANC 1-4'),
      org_unit_level: 4, org_units: [SL], period: 'THIS_YEAR', thematic_map_type: 'BUBBLE',
    });
    made.map = map.map_id || null;
    check('bubble map: one point per facility sized by %', !map._error && made.map, show(map));
    const dash = await t('manage_dashboards', {
      action: 'create_dashboard', dashboard: { name: `${TAG} ANC Coverage` },
      items: [
        { visualization_id: made.viz[0] }, { visualization_id: made.viz[1] },
        { type: 'MAP', map_id: made.map }, { type: 'EVENT_VISUALIZATION', event_visualization_id: made.lineList },
      ],
    });
    made.dash = dash.dashboard_id || null;
    check('dashboard with all four tiles', !dash._error && made.dash, show(dash));

    // What the apps will load: the saved objects carry their data dimensions.
    const pv = await t('dhis2_query', { path: `visualizations/${made.viz[0]}?fields=type,rows[dimension],columns[dimension],organisationUnitLevels,dataDimensionItems[programIndicator[id]]` });
    check('saved pivot: ou on rows, dx on columns, level 4, both indicators', pv.type === 'PIVOT_TABLE' && pv.rows?.[0]?.dimension === 'ou' && pv.columns?.[0]?.dimension === 'dx' && (pv.organisationUnitLevels || []).includes(4) && (pv.dataDimensionItems || []).length === 2, show(pv));
    const mv = await t('dhis2_query', { path: `maps/${made.map}?fields=mapViews[thematicMapType,organisationUnitLevels,dataDimensionItems[programIndicator[id]]]` });
    check('saved map layer: BUBBLE, level 4, the % indicator as data', mv.mapViews?.[0]?.thematicMapType === 'BUBBLE' && (mv.mapViews[0].organisationUnitLevels || []).includes(4) && mv.mapViews[0].dataDimensionItems?.[0]?.programIndicator?.id === id('% attended ANC 1-4'), show(mv));
    const an = await t('dhis2_query', { path: `analytics?dimension=dx:${id('% attended ANC 1st visit')};${id('% attended ANC visits 2-4')}&dimension=ou:${SL};LEVEL-4&filter=pe:THIS_YEAR` });
    check('the pivot\'s analytics query runs', !an._error && Array.isArray(an.rows), show(an));
    const llv = await t('manage_line_lists', { action: 'validate', line_list_id: made.lineList });
    check('the saved line list validates', !llv._error, show(llv));
  } catch (e) {
    failures++;
    console.log('  ✗ threw:', e && e.stack || e);
  }

  const buildEnd = API.length;
  console.log('\n5. Cleanup');
  const del = async (label, name, args) => { const r = await t(name, { ...args, skip_backup: true }); check(`deleted ${label}`, !r._error, show(r)); };
  if (made.dash) await del('dashboard', 'manage_dashboards', { action: 'delete', dashboard_id: made.dash });
  for (const v of made.viz) await del(`visualization ${v}`, 'manage_metadata', { action: 'delete', object_type: 'visualizations', object_id: v });
  if (made.map) await del('map', 'manage_maps', { action: 'delete', map_id: made.map });
  if (made.lineList) await del('line list', 'manage_line_lists', { action: 'delete', line_list_id: made.lineList });
  for (const p of made.pis) await del(`indicator ${p}`, 'manage_program_indicators', { action: 'delete', indicator_id: p });
  const left = await t('dhis2_query', { path: `programIndicators?filter=name:like:${TAG}&fields=id&paging=false` });
  check('nothing left behind', (left.programIndicators || []).length === 0, show(left));

  const build = summarize(0, buildEnd);
  const all = summarize(0);
  console.log(`\nAPI calls: ${all.total} (build ${build.total}), failed: ${all.failed.length}`);
  for (const f of all.failed) console.log(`  ✗ ${f.method} ${f.url} → ${f.status}`);
  if (all.failed.length) failures++;
  console.log(failures ? `\nFAIL — ${failures} problem(s)` : '\nPASS');
  process.exit(failures ? 1 : 0);
})();
