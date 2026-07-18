#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-line-lists.js — the manage_line_lists deep test against a LIVE
 * DHIS2 instance (default http://localhost:8081, see live-harness.js env).
 *
 * Recreates the "TB Programme Quarterly Review" package a senior implementor
 * would build, through the REAL executeTool pipeline:
 *   1. two row-safe ENROLLMENT program indicators (manage_program_indicators)
 *   2. a traffic-light legend set (manage_legend_sets)
 *   3. EVENT line list  — TB case register on the Screening stage
 *   4. ENROLLMENT line list — treatment monitoring with repeated follow-up
 *      columns, PI columns and a FIXED legend
 *   5. TRACKED_ENTITY line list — women's directory
 *   6. a dashboard embedding all three as EVENT_VISUALIZATION tiles
 *   7. validate/get/list/update round-trips
 *   8. full cleanup (instance left as found)
 * Plus the negative paths that MUST refuse mechanically (no failing HTTP):
 *   division-PI column, wrong-analyticsType PI, bad option value, repetition
 *   on a non-repeatable stage, missing time dimension, sort on a non-column,
 *   duplicate name, delete-while-on-dashboard.
 *
 * PASS = every step behaves as asserted AND zero failed API calls.
 * ───────────────────────────────────────────────────────────────────────────── */
const { load, API, summarize } = require('./live-harness');

const TB = 'fofUFvr9eUY';
const ST_SCREEN = 'LpLNpNLOpt9', ST_FU = 'AtNXKcDte6A';
const PI_SUCCESS_RATE = 'QKvLpdBdGRg'; // division PI — must be refused as a column

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
function show(r) { return JSON.stringify(r === undefined ? null : r).slice(0, 300); }

(async () => {
  const ctx = load({ appType: 'Dashboard' });
  const t = (name, args) => ctx.executeTool(name, args);
  const created = { pis: [], legendSet: null, lineLists: [], dashboard: null };

  try {
    // ── 1. Row-safe program indicators ──────────────────────────────────────
    console.log('\n1. Program indicators (row-level, ENROLLMENT analytics)');
    for (const [name, expression] of [
      ['TB Follow-up Visits Recorded', `d2:count(#{${ST_FU}.a4VFTEz17gK})`],
      ['TB Poor-Adherence Months', `d2:countIfValue(#{${ST_FU}.a4VFTEz17gK}, 'POOR')`],
    ]) {
      // aggregation_type SUM is deliberate: with COUNT a line-list cell shows a
      // constant 1 per row; with NONE the whole query fails (verified on 2.42).
      const r = await t('manage_program_indicators', {
        action: 'create', program_id: TB,
        indicator: { name, expression, analytics_type: 'ENROLLMENT', aggregation_type: 'SUM', decimals: 0 },
      });
      const piId = r.program_indicator_id || r.indicator_id || r.id;
      check(`PI "${name}" created`, r && r.success !== false && !r._error && piId, show(r));
      created.pis.push(piId);
    }
    const [PI_VISITS, PI_POOR] = created.pis;

    // ── 2. Legend set ───────────────────────────────────────────────────────
    console.log('\n2. Legend set');
    {
      const r = await t('manage_legend_sets', {
        action: 'create',
        legend_set: {
          name: 'TB Adherence Risk (poor months)',
          legends: [
            { name: 'On track', startValue: 0, endValue: 1, color: '#1a9850' },
            { name: 'Watch', startValue: 1, endValue: 2, color: '#fdae61' },
            { name: 'High risk', startValue: 2, endValue: 13, color: '#d73027' },
          ],
        },
      });
      created.legendSet = r.legend_set_id || r.id;
      check('legend set created', !r._error && created.legendSet, show(r));
    }

    // ── 3. EVENT line list — TB case register ───────────────────────────────
    console.log('\n3. EVENT line list (case register, Screening stage)');
    let evList;
    {
      const r = await t('manage_line_lists', {
        action: 'create',
        name: 'TB Case Register — Diagnosis (12m)',
        description: 'Row per screening event; excludes NOT_TB.',
        output_type: 'EVENT',
        program_id: TB,
        program_stage_id: 'Screening and Diagnostics',     // stage by NAME
        columns: [
          { dimension: 'ou', org_units: ['LEVEL-4', 'K7ddAAHQpJF'] },
          { dimension: 'event_date', periods: ['LAST_12_MONTHS'] },
          { dimension: 'Full name' },                       // TEA by name
          { dimension: 'Sex' },
          { dimension: 'Diagnostic Test Performed' },
          { dimension: 'GeneXpert Result' },
          { dimension: 'Final Case Classification',
            filter: { operator: 'IN', values: ['Bacteriologically Confirmed', 'CLINICALLY_DIAGNOSED'] } }, // name + code mix
          { dimension: 'kV2Q4g4wqJA' },                     // boolean DE by UID
        ],
        sorting: [{ dimension: 'event_date', direction: 'DESC' }],
        data_check: 'require_rows',
      });
      evList = r.line_list_id;
      check('EVENT list created', !r._error && evList, show(r));
      check('EVENT list has rows', (r.row_count || 0) >= 1, `row_count=${r.row_count}`);
      if (evList) created.lineLists.push(evList);
    }

    // ── 4. ENROLLMENT line list — treatment monitoring ──────────────────────
    console.log('\n4. ENROLLMENT line list (repeated events + PIs + legend)');
    let enList;
    {
      const r = await t('manage_line_lists', {
        action: 'create',
        name: 'TB Treatment Monitoring — Adherence & Outcomes (12m)',
        output_type: 'ENROLLMENT',
        program_name: 'Tuberculosis Case Surveillance and Treatment', // program by NAME
        columns: [
          { dimension: 'ou', org_units: ['USER_ORGUNIT'] },
          { dimension: 'enrollment_date', periods: ['LAST_12_MONTHS'] },
          { dimension: 'Full name' },
          { dimension: 'Mobile Phone Number' },
          { dimension: 'Treatment Regimen Type' },          // stage auto-resolved
          { dimension: 'Adherence Rate This Month',
            repeated_events: { oldest: 2, most_recent: 2 } },
          { dimension: 'Current Treatment Outcome Status' },
          { dimension: PI_VISITS },
          { dimension: 'TB Poor-Adherence Months' },        // PI by name
        ],
        filters: [
          { dimension: 'Final Case Classification', filter: { operator: 'IN', values: ['BACTERIOLOGICALLY_CONFIRMED'] } },
          { dimension: 'program_status', statuses: ['ACTIVE', 'COMPLETED'] },
        ],
        sorting: [{ dimension: 'enrollment_date', direction: 'DESC' }],
        legend: { legend_set_name: 'TB Adherence Risk (poor months)', strategy: 'FIXED', style: 'FILL', show_key: true },
        data_check: 'require_rows',
      });
      enList = r.line_list_id;
      check('ENROLLMENT list created', !r._error && enList, show(r));
      check('ENROLLMENT list has rows', (r.row_count || 0) >= 1, `row_count=${r.row_count}`);
      const adh = (r.columns || []).find(c => /Adherence Rate/.test(c.name || ''));
      check('repetition indexes resolved [1,2,-1,0]', adh && JSON.stringify(adh.repetition_indexes) === '[1,2,-1,0]', show(adh));
      if (enList) created.lineLists.push(enList);
    }

    // ── 5. TRACKED_ENTITY line list ─────────────────────────────────────────
    console.log('\n5. TRACKED_ENTITY line list (women\'s directory)');
    let teList;
    {
      const r = await t('manage_line_lists', {
        action: 'create',
        name: 'TB Persons Directory — Women',
        output_type: 'TRACKED_ENTITY',
        program_id: TB,
        columns: [
          { dimension: 'ou', org_units: ['USER_ORGUNIT'] },
          { dimension: 'Full name' },
          { dimension: 'Mobile Phone Number' },
          { dimension: 'Sex', filter: { operator: 'IN', values: ['FEMALE'] } },
          { dimension: 'Date of Birth' },
        ],
        data_check: 'require_rows',
      });
      teList = r.line_list_id;
      check('TE list created', !r._error && teList, show(r));
      check('TE list has rows', (r.row_count || 0) >= 1, `row_count=${r.row_count}`);
      if (teList) created.lineLists.push(teList);
    }

    // ── 6. Negative paths — every one must REFUSE without a failed API call ─
    console.log('\n6. Negative paths (mechanical refusals, zero failing HTTP)');
    const negStart = API.length;
    {
      let r = await t('manage_line_lists', {
        action: 'create', name: 'XNEG division PI', output_type: 'ENROLLMENT', program_id: TB,
        columns: [
          { dimension: 'ou', org_units: ['USER_ORGUNIT'] },
          { dimension: 'enrollment_date', periods: ['LAST_12_MONTHS'] },
          { dimension: PI_SUCCESS_RATE },
        ],
      });
      check('division PI refused', r._error && /DIVISION/i.test(r._error), show(r));

      r = await t('manage_line_lists', {
        action: 'create', name: 'XNEG wrong PI type', output_type: 'EVENT', program_id: TB, program_stage_id: ST_SCREEN,
        columns: [
          { dimension: 'ou', org_units: ['USER_ORGUNIT'] },
          { dimension: 'event_date', periods: ['LAST_12_MONTHS'] },
          { dimension: PI_VISITS }, // ENROLLMENT PI on an EVENT list
        ],
      });
      check('wrong-analyticsType PI refused', r._error && /analyticsType/i.test(r._error), show(r));

      r = await t('manage_line_lists', {
        action: 'create', name: 'XNEG bad option', output_type: 'EVENT', program_id: TB, program_stage_id: ST_SCREEN,
        columns: [
          { dimension: 'ou', org_units: ['USER_ORGUNIT'] },
          { dimension: 'event_date', periods: ['LAST_12_MONTHS'] },
          { dimension: 'GeneXpert Result', filter: { operator: 'IN', values: ['RIF_DETECTED'] } }, // not a code
        ],
      });
      check('bad option value refused w/ valid codes', r._error && /Valid codes/i.test(r._error), show(r));

      r = await t('manage_line_lists', {
        action: 'create', name: 'XNEG rep on non-repeatable', output_type: 'ENROLLMENT', program_id: TB,
        columns: [
          { dimension: 'ou', org_units: ['USER_ORGUNIT'] },
          { dimension: 'enrollment_date', periods: ['LAST_12_MONTHS'] },
          { dimension: 'GeneXpert Result', repeated_events: { most_recent: 2 } }, // Screening is NOT repeatable
        ],
      });
      check('repetition on non-repeatable stage refused', r._error && /not repeatable/i.test(r._error), show(r));

      r = await t('manage_line_lists', {
        action: 'create', name: 'XNEG no time', output_type: 'EVENT', program_id: TB, program_stage_id: ST_SCREEN,
        columns: [{ dimension: 'ou', org_units: ['USER_ORGUNIT'] }, { dimension: 'GeneXpert Result' }],
      });
      check('missing time dimension refused', r._error && /time dimension/i.test(r._error), show(r));

      r = await t('manage_line_lists', {
        action: 'create', name: 'XNEG bad sort', output_type: 'EVENT', program_id: TB, program_stage_id: ST_SCREEN,
        columns: [
          { dimension: 'ou', org_units: ['USER_ORGUNIT'] },
          { dimension: 'event_date', periods: ['LAST_12_MONTHS'] },
          { dimension: 'GeneXpert Result' },
        ],
        sorting: [{ dimension: 'Full name', direction: 'ASC' }], // not a column
      });
      check('sort on non-column refused', r._error && /not one of the line list'?s columns/i.test(r._error), show(r));

      r = await t('manage_line_lists', {
        action: 'create', name: 'TB Case Register — Diagnosis (12m)', output_type: 'EVENT', program_id: TB, program_stage_id: ST_SCREEN,
        columns: [
          { dimension: 'ou', org_units: ['USER_ORGUNIT'] },
          { dimension: 'event_date', periods: ['LAST_12_MONTHS'] },
          { dimension: 'GeneXpert Result' },
        ],
      });
      check('duplicate name refused w/ existing id', r._error && r.existing_id === evList, show(r));

      // A NONE-aggregation PI generates invalid SQL per row — must be refused
      // mechanically before any probe/POST.
      const nonePi = await t('manage_program_indicators', {
        action: 'create', program_id: TB,
        indicator: { name: 'XNEG none-agg PI', expression: `d2:count(#{${ST_FU}.a4VFTEz17gK})`, analytics_type: 'ENROLLMENT', aggregation_type: 'NONE' },
      });
      r = await t('manage_line_lists', {
        action: 'create', name: 'XNEG none agg', output_type: 'ENROLLMENT', program_id: TB,
        columns: [
          { dimension: 'ou', org_units: ['USER_ORGUNIT'] },
          { dimension: 'enrollment_date', periods: ['LAST_12_MONTHS'] },
          { dimension: 'XNEG none-agg PI' },
        ],
      });
      check('NONE-aggregation PI refused', r._error && /aggregationType NONE/i.test(r._error), show(r));
      await t('manage_program_indicators', { action: 'delete', indicator_id: nonePi.program_indicator_id, skip_backup: true });
    }
    const negFailed = summarize(negStart).failed;
    check('negative paths fired ZERO failing HTTP calls', negFailed.length === 0,
      negFailed.map(f => `${f.method} ${f.url} → ${f.status}`).join(' | '));

    // ── 7. Dashboard with all three line lists ──────────────────────────────
    console.log('\n7. Dashboard (EVENT_VISUALIZATION tiles)');
    {
      const r = await t('manage_dashboards', {
        action: 'create_dashboard',
        dashboard: { name: 'TB Programme Review — Line Lists', description: 'Quarterly review case registers.' },
        items: [
          { type: 'EVENT_VISUALIZATION', event_visualization_id: evList },
          { type: 'EVENT_VISUALIZATION', event_visualization_id: enList },
          { type: 'EVENT_VISUALIZATION', line_list_id: teList }, // alias form
        ],
      });
      created.dashboard = r.dashboard_id;
      check('dashboard created with 3 line-list tiles', !r._error && created.dashboard && r.items === 3, show(r));
    }

    // ── 8. validate / get / list round-trips ────────────────────────────────
    console.log('\n8. validate / get / list');
    for (const [label, id] of [['EVENT', evList], ['ENROLLMENT', enList], ['TE', teList]]) {
      const r = await t('manage_line_lists', { action: 'validate', line_list_id: id });
      check(`validate ${label}: rows>=1`, !r._error && r.row_count >= 1, show(r));
    }
    {
      const r = await t('manage_line_lists', { action: 'get', line_list_id: enList });
      const cols = r.line_list && r.line_list.columns || [];
      const adh = cols.find(c => /Adherence/.test(c.name || ''));
      const legend = r.line_list && r.line_list.legend;
      check('get: decoded repetition + legend + filter', !r._error
        && adh && JSON.stringify(adh.repetition_indexes) === '[1,2,-1,0]'
        && legend && legend.legend_set_id === created.legendSet
        && (r.line_list.filters || []).some(f => /IN:BACTERIOLOGICALLY_CONFIRMED/.test(f.filter || '')), show(r).slice(0, 400));
    }
    {
      const r = await t('manage_line_lists', { action: 'list', program_id: TB });
      check('list: all three found', !r._error && created.lineLists.every(id => (r.line_lists || []).some(l => l.id === id)), show(r));
    }

    // ── 9. update (own fields, layout preserved) ────────────────────────────
    console.log('\n9. update (rename, keep layout)');
    {
      const r = await t('manage_line_lists', {
        action: 'update', line_list_id: evList,
        name: 'TB Case Register — Diagnosis (last 12 months)',
      });
      check('update saved', !r._error && r.success, show(r));
      const v = await t('manage_line_lists', { action: 'validate', line_list_id: evList });
      check('layout still valid after update: rows>=1', !v._error && v.row_count >= 1, show(v));
      const g = await t('manage_line_lists', { action: 'get', line_list_id: evList });
      check('columns survived own-field update', (g.line_list?.columns || []).length === 8, show(g).slice(0, 300));
    }

    // ── 10. delete-while-on-dashboard refusal ───────────────────────────────
    console.log('\n10. delete guard');
    {
      const r = await t('manage_line_lists', { action: 'delete', line_list_id: evList });
      check('delete refused while on dashboard', r._error && /dashboard/i.test(r._error), show(r));
    }
  } catch (e) {
    failures++;
    console.error('✗ scenario threw:', e.stack || e.message);
  }

  // ── Cleanup — leave the instance exactly as found ─────────────────────────
  console.log('\nCleanup');
  const preCleanup = API.length;
  try {
    const t = (name, args) => ctx.executeTool(name, args);
    if (created.dashboard) {
      const r = await t('manage_dashboards', { action: 'delete', dashboard_id: created.dashboard, skip_backup: true });
      check('dashboard deleted', !r._error, show(r));
    }
    for (const id of created.lineLists) {
      const r = await t('manage_line_lists', { action: 'delete', line_list_id: id, skip_backup: true });
      check(`line list ${id} deleted`, !r._error, show(r));
    }
    for (const id of created.pis.filter(Boolean)) {
      const r = await t('manage_program_indicators', { action: 'delete', indicator_id: id, skip_backup: true });
      check(`PI ${id} deleted`, !r._error, show(r));
    }
    if (created.legendSet) {
      const r = await t('manage_legend_sets', { action: 'delete', legend_set_id: created.legendSet, skip_backup: true });
      check('legend set deleted', !r._error, show(r));
    }
  } catch (e) {
    failures++;
    console.error('✗ cleanup threw:', e.stack || e.message);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const { total, failed } = summarize();
  console.log(`\n${total} API call(s) total, ${failed.length} failed.`);
  for (const f of failed) console.log(`  FAILED: ${f.method} ${f.url} → ${f.status}`);
  if (failures) console.log(`\n✗ ${failures} assertion(s) failed.`);
  else if (failed.length) console.log('\n✗ assertions passed but there were failed API calls.');
  else console.log('\n✓ scenario PASSED with zero errors and zero failed API calls.');
  process.exit(failures || failed.length ? 1 : 0);
})();
