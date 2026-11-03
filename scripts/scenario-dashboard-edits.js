#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-dashboard-edits.js — the dashboard edits users ask for after the first
 * build, through the real tools against a live DHIS2. Each check is something a
 * real model got wrong or could not do on 2026-11-02:
 *   replace a tile in place, sort a chart, hide units with no data, refuse an
 *   invented period, merge a line-list column with its filter, warn about a map
 *   whose data sits on units with no boundary.
 *
 *   DHIS2_BASE=http://localhost:8081 DHIS2_AUTH=admin:district node scripts/scenario-dashboard-edits.js
 *
 * Needs one tracker program with at least one program indicator (found by name,
 * see PROGRAM). Leaves the server as found: every object it makes is deleted.
 * ───────────────────────────────────────────────────────────────────────────── */
const { load, API, BASE } = require('./live-harness');

const PROGRAM = process.env.SCENARIO_PROGRAM || 'NCD Hypertension and Diabetes Care';
const AUTH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');
const api = async (p, opts = {}) => {
  const r = await fetch(`${BASE}/api/${p}`, { ...opts, headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${!pass && detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
  if (!pass) failures++;
};

(async () => {
  const ctx = load({ appType: 'Dashboard' });
  await new Promise((r) => setTimeout(r, 50));
  const tool = (args) => ctx.executeTool('manage_dashboards', args);
  const made = { dashboards: [], visualizations: [], eventVisualizations: [], backups: [] };
  const backupsBefore = new Set((await api('dataStore')).includes('dhis2-ai-extension-backups') ? await api('dataStore/dhis2-ai-extension-backups') : []);
  const mark = API.length;
  try {
    const q = encodeURIComponent(PROGRAM);
    const prog = (await api(`programs.json?filter=name:eq:${q}&fields=id,programStages%5Bid%5D,programIndicators%5Bid%5D&paging=false`)).programs[0];
    if (!prog || !prog.programIndicators.length) throw new Error(`Program "${PROGRAM}" with an indicator not found (set SCENARIO_PROGRAM).`);
    const pi = prog.programIndicators[0].id;
    const base = { data_items: [pi], periods: ['LAST_12_MONTHS'], org_units: ['USER_ORGUNIT', 'LEVEL-4'] };

    console.log('\nSort and empty units:');
    const sorted = await tool({ action: 'create_visualization', visualization: { ...base, name: 'ai-test edits sorted', vis_type: 'BAR', sort: 'desc', layout: { category: ['ou'], series: ['dx'], filters: ['pe'] } } });
    check('chart with sort is created', sorted.success, sorted._error);
    made.visualizations.push(sorted.visualization_id);
    const sv = await api(`visualizations/${sorted.visualization_id}.json?fields=sortOrder,hideEmptyRowItems`);
    check('saved highest first (sortOrder 1) with empty x-axis places hidden', sv.sortOrder === 1 && sv.hideEmptyRowItems === 'ALL', JSON.stringify(sv));
    const table = await tool({ action: 'create_visualization', visualization: { ...base, name: 'ai-test edits table', vis_type: 'PIVOT_TABLE', sort: 'desc', layout: { rows: ['ou'], columns: ['pe'], filters: ['dx'] } } });
    check('table is created, and the model is told a saved table cannot be sorted', table.success && /cannot be sorted/.test(String(table._layout_corrected)), table._error || table._layout_corrected);
    made.visualizations.push(table.visualization_id);
    const tv = await api(`visualizations/${table.visualization_id}.json?fields=hideEmptyRows,sortOrder`);
    check('saved with empty rows hidden and no sort fields', tv.hideEmptyRows === true && !tv.sortOrder, JSON.stringify(tv));
    const invented = await tool({ action: 'create_visualization', visualization: { ...base, periods: ['LAST_5_QUARTERS'], name: 'ai-test edits invented', vis_type: 'LINE' } });
    check('an invented period is refused, with the real ones listed', !invented.success && /not a DHIS2 period/.test(invented._error) && /LAST_4_QUARTERS/.test(invented._hint), JSON.stringify(invented).slice(0, 200));
    const bad = await ctx.executeTool('dhis2_query', { path: 'analytics', query_params: { dimension: [`dx:${pi}`, 'pe:LAST_24_MONTHS'], filter: 'ou:USER_ORGUNIT' } });
    check('…and in an analytics query it is never sent', /not a DHIS2 period/.test(bad._error || ''), JSON.stringify(bad).slice(0, 200));

    console.log('\nStatus parameters on event analytics:');
    const st = prog.programStages[0].id;
    const asDim = await ctx.executeTool('dhis2_query', { path: `analytics/events/aggregate/${prog.id}`, query_params: { dimension: ['pe:THIS_YEAR', 'eventStatus:COMPLETED'], filter: 'ou:USER_ORGUNIT', stage: st } });
    check('eventStatus as a dimension is corrected and the model is told', !asDim._error && (JSON.stringify(asDim._notes || asDim._query_notes || asDim).includes('query parameter')), JSON.stringify(asDim).slice(0, 240));

    console.log('\nReplace a tile:');
    const mk = async (n) => { const r = await tool({ action: 'create_visualization', visualization: { ...base, org_units: ['USER_ORGUNIT'], name: `ai-test edits ${n}`, vis_type: 'SINGLE_VALUE' } }); made.visualizations.push(r.visualization_id); return r.visualization_id; };
    const [k1, k2] = [await mk('kpi one'), await mk('kpi two')];
    const dash = await tool({ action: 'create_dashboard', dashboard: { name: 'ai-test edits board' }, items: [{ visualization_id: k1 }, { visualization_id: k2 }, { visualization_id: sorted.visualization_id }, { visualization_id: table.visualization_id }] });
    check('dashboard is created', dash.success, dash._error);
    made.dashboards.push(dash.dashboard_id);
    const tiles = async () => {
      const g = await tool({ action: 'get', dashboard_id: dash.dashboard_id });
      return g.items;
    };
    const before = await tiles();
    const oldTile = before.find((t) => (t.visualization_id || t.object_id || (t.visualization && t.visualization.id)) === sorted.visualization_id) || before[2];
    const k3 = await mk('kpi three');
    const rep = await tool({ action: 'add_items', dashboard_id: dash.dashboard_id, replace_item_id: oldTile.id, items: [{ visualization_id: k3 }] });
    check('replace_item_id succeeds with one write', rep.success && rep.replaced, JSON.stringify(rep).slice(0, 240));
    const after = await tiles();
    check('the tile count is unchanged', after.length === before.length, `${before.length} → ${after.length}`);
    check('the old tile is gone', !after.some((t) => t.id === oldTile.id));
    const raw = (await api(`dashboards/${dash.dashboard_id}.json?fields=dashboardItems%5Bid,y,x,visualization%5Bid%5D%5D`)).dashboardItems;
    const reading = [...raw].sort((a, b) => a.y - b.y || a.x - b.x).map((t) => t.visualization.id);
    check('the new tile is exactly where the old one was', reading[2] === k3, reading.join(','));
    check('the chart the old tile showed is still on the server', !!(await api(`visualizations/${sorted.visualization_id}.json?fields=id`)).id);
    const both = await tool({ action: 'add_items', dashboard_id: dash.dashboard_id, replace_item_id: after[0].id, insert_after_item_id: after[1].id, items: [{ visualization_id: k3 }] });
    check('replace with an insert position is refused', !both.success && /only one of/.test(both._error), both._error);

    const inl = await tool({ action: 'add_items', dashboard_id: dash.dashboard_id, items: [{ new_visualization: { ...base, name: 'ai-test edits inline', vis_type: 'PIVOT_TABLE', layout: { rows: ['ou'], columns: ['pe'], filters: ['dx'] } } }] });
    check('an inline table is added', inl.success, inl._error);
    (inl.new_visualizations || []).forEach((v) => made.visualizations.push(v.id));
    const inlId = (inl.new_visualizations || [])[0] && inl.new_visualizations[0].id;
    const inlTile = (await api(`dashboards/${dash.dashboard_id}.json?fields=dashboardItems%5Bheight,visualization%5Bid%5D%5D`)).dashboardItems.find((t) => t.visualization && t.visualization.id === inlId);
    check('…and is not sized for every unit at the level, since its empty rows are hidden', inlTile && inlTile.height <= 20, JSON.stringify(inlTile));

    console.log('\nLine list: one dimension as column and filter:');
    const stage = await api(`programStages.json?filter=program.id:eq:${prog.id}&fields=id,repeatable,programStageDataElements%5BdataElement%5Bid,valueType%5D%5D&paging=false`);
    const s0 = stage.programStages.find((s) => s.programStageDataElements.some((d) => /INTEGER|NUMBER/.test(d.dataElement.valueType)));
    const numDe = s0.programStageDataElements.find((d) => /INTEGER|NUMBER/.test(d.dataElement.valueType)).dataElement.id;
    const ll = await ctx.executeTool('manage_line_lists', {
      action: 'create', name: 'ai-test edits list', output_type: 'EVENT', program_id: prog.id, program_stage_id: s0.id,
      columns: [{ dimension: 'ou', org_units: ['USER_ORGUNIT'] }, { dimension: 'event_date', periods: ['LAST_12_MONTHS'] }, { dimension: numDe }],
      filters: [{ dimension: numDe, filter: { operator: 'GE', value: 1 } }],
    });
    check('the same data element as column and filter becomes one filtered column', ll.success, ll._error);
    if (ll.line_list_id) {
      made.eventVisualizations.push(ll.line_list_id);
      const lv = await api(`eventVisualizations/${ll.line_list_id}.json?fields=columnDimensions,filterDimensions,dataElementDimensions%5Bfilter,dataElement%5Bid%5D%5D`);
      const dim = (lv.dataElementDimensions || []).find((d) => d.dataElement && d.dataElement.id === numDe);
      check('…saved on the column with its filter', dim && /GE:1/.test(dim.filter || '') && (lv.columnDimensions || []).some((c) => c.includes(numDe)) && !(lv.filterDimensions || []).some((c) => c.includes(numDe)), JSON.stringify(lv).slice(0, 300));
    }

    const failed = API.slice(mark).filter((a) => !a.ok);
    console.log('');
    check(`no API call failed (${API.length - mark} calls)`, failed.length === 0, failed.map((f) => `${f.status} ${f.method} ${f.url}`).join(' | '));
  } catch (e) {
    check(`scenario threw: ${e.message}`, false, e.stack);
  } finally {
    console.log('\nCleanup:');
    for (const id of made.dashboards) await api(`dashboards/${id}`, { method: 'DELETE' });
    for (const id of made.eventVisualizations) await api(`eventVisualizations/${id}`, { method: 'DELETE' });
    for (const id of made.visualizations) if (id) await api(`visualizations/${id}`, { method: 'DELETE' });
    const keys = await api('dataStore/dhis2-ai-extension-backups');
    let removed = 0;
    for (const k of Array.isArray(keys) ? keys.filter((x) => !backupsBefore.has(x)) : []) {
      const e = await api(`dataStore/dhis2-ai-extension-backups/${encodeURIComponent(k)}`);
      if (/ai-test edits/.test(JSON.stringify(e && e.reason || '')) || (e.objects || []).some((o) => /ai-test edits/.test(o.name || ''))) { await api(`dataStore/dhis2-ai-extension-backups/${encodeURIComponent(k)}`, { method: 'DELETE' }); removed++; }
    }
    const left = (await api('visualizations.json?filter=name:like:ai-test%20edits&fields=id&paging=false')).visualizations || [];
    check(`nothing is left on the server (${removed} backup(s) removed)`, left.length === 0, JSON.stringify(left));
    console.log(failures ? `\n\x1b[31mFAILED\x1b[0m — ${failures} check(s)\n` : '\n\x1b[32mALL CHECKS PASSED\x1b[0m\n');
    process.exit(failures ? 1 : 0);
  }
})();
