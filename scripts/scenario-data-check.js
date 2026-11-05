#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-data-check.js — what a saved dashboard really shows, through the real
 * tools against a live DHIS2. Replays the shape of the Maternity thread
 * (2026-11-04): a dashboard on the WHO RMNCH Tracker whose Delivery method and
 * Pregnancy outcome hold no values and whose Unique ID is nearly empty.
 * Every finding is compared with a separately made query.
 *
 *   DHIS2_BASE=https://play.im.dhis2.org/stable-2-43-2-1 DHIS2_APIVER=43 npm run datacheck
 *
 * --keep leaves the objects in place, to open them in the real Dashboard app.
 * Otherwise the server is left as found: every object it makes is deleted.
 * ───────────────────────────────────────────────────────────────────────────── */
const { load, API, BASE } = require('./live-harness');

const KEEP = process.argv.includes('--keep');
const PROGRAM = process.env.SCENARIO_PROGRAM || 'WSGAb5XwJ3Y';
const FIRST_ANC = 'WZbXY0S00lP', SECOND_ANC = 'edqlbukwRfQ', BIRTH = 'PFDfvmGpsR3';
const HB = 'vANAXwtLwcT', METHOD = 'spkG704sTh6', OUTCOME = 'V5PR8Kw8ZnC', NEAR_MISS = 'FIHEeJwfhZH', UNIQUE_ID = 'lZGmxYbs97q';
const PREFIX = 'ai-test datacheck';
const AUTH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');
const api = async (p, opts = {}) => {
  const r = await fetch(`${BASE}/api/${p}`, { ...opts, headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
const trackerTotal = async (p) => (await api(`tracker/${p}&pageSize=1&totalPages=true`)).pager?.total;
let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${!pass && detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  if (!pass) failures++;
};

(async () => {
  const ctx = load({ appType: 'Dashboard' });
  await new Promise((r) => setTimeout(r, 50));
  const d = ctx.__getDhis2();
  const made = { dashboards: [], visualizations: [], maps: [], eventVisualizations: [], programIndicators: [] };
  const backupsBefore = new Set((await api('dataStore')).includes('dhis2-ai-extension-backups') ? await api('dataStore/dhis2-ai-extension-backups') : []);
  const mark = API.length;
  try {
    const ouRoot = (await api('organisationUnits.json?filter=level:eq:1&fields=id&paging=false')).organisationUnits[0].id;
    console.log(`\nGround truth, asked separately (${BASE}):`);
    const methodFilled = await trackerTotal(`events.json?program=${PROGRAM}&programStage=${BIRTH}&orgUnitMode=ACCESSIBLE&filter=${METHOD}:!null&fields=event`);
    const nearFilled = await trackerTotal(`events.json?program=${PROGRAM}&programStage=${BIRTH}&orgUnitMode=ACCESSIBLE&filter=${NEAR_MISS}:!null&fields=event`);
    const birthTotal = await trackerTotal(`events.json?program=${PROGRAM}&programStage=${BIRTH}&orgUnitMode=ACCESSIBLE&fields=event`);
    const uidFilled = await trackerTotal(`trackedEntities.json?program=${PROGRAM}&orgUnitMode=ACCESSIBLE&filter=${UNIQUE_ID}:!null&fields=trackedEntity`);
    const peopleTotal = await trackerTotal(`trackedEntities.json?program=${PROGRAM}&orgUnitMode=ACCESSIBLE&fields=trackedEntity`);
    console.log(`  birth-care events ${birthTotal}; delivery method on ${methodFilled}; near-miss on ${nearFilled}; Unique ID on ${uidFilled} of ${peopleTotal} people`);
    check('this server fits the scenario (a field with no values, one with, one nearly empty)', methodFilled === 0 && nearFilled > 0 && uidFilled / peopleTotal < 0.05);

    console.log('\nThe build, through the real tools:');
    const pis = await ctx.executeTool('manage_program_indicators', {
      action: 'create', program_id: PROGRAM,
      indicators: [
        { name: `${PREFIX} birth records`, expression: 'V{event_count}', filter: `V{program_stage_id} == '${BIRTH}'`, analytics_type: 'EVENT', aggregation_type: 'COUNT' },
        { name: `${PREFIX} near misses`, expression: 'V{event_count}', filter: `V{program_stage_id} == '${BIRTH}' && #{${BIRTH}.${NEAR_MISS}} == 1`, analytics_type: 'EVENT', aggregation_type: 'COUNT' },
        { name: `${PREFIX} caesareans`, expression: 'V{event_count}', filter: `V{program_stage_id} == '${BIRTH}' && #{${BIRTH}.${METHOD}} == 'Caesarian section'`, analytics_type: 'EVENT', aggregation_type: 'COUNT' },
        { name: `${PREFIX} caesarean percent`, expression: `d2:condition("#{${BIRTH}.${METHOD}} == 'Caesarian section'", 100, 0)`, filter: `V{program_stage_id} == '${BIRTH}' && d2:hasValue(#{${BIRTH}.${METHOD}})`, analytics_type: 'EVENT', aggregation_type: 'AVERAGE' },
      ],
    });
    check('program indicators are created', pis.success, pis._error);
    const [piBirth, piNear, piCaes, piPct] = pis.program_indicator_ids || [];
    made.programIndicators.push(...(pis.program_indicator_ids || []));
    const why = pis.runtime_check?.why_no_data;
    check('the indicator check already says why some have no data', (why?.fields_without_values || []).some(f => /Delivery method/.test(f.field)), JSON.stringify(pis.runtime_check));

    const items = [
      { new_visualization: { name: `${PREFIX} birth records KPI`, vis_type: 'SINGLE_VALUE', data_items: [piBirth], periods: ['2026'], org_units: [ouRoot] } },
      { new_visualization: { name: `${PREFIX} caesarean KPI`, vis_type: 'SINGLE_VALUE', data_items: [piPct], periods: ['2026'], org_units: [ouRoot] } },
      { new_visualization: { name: `${PREFIX} district table`, vis_type: 'PIVOT_TABLE', data_items: [piBirth, piNear, piCaes, piPct], periods: ['2026'], org_units: [ouRoot, 'LEVEL-2'], overall_row: true, layout: { rows: ['ou'], columns: ['dx'], filters: ['pe'] } } },
    ];
    const shaded = await ctx.executeTool('manage_maps', { action: 'create', name: `${PREFIX} caesarean map`, data_item: piPct, org_unit_level: 2, org_units: [ouRoot], period: '2026' });
    check('a shaded map is created', shaded.success, shaded._error);
    made.maps.push(shaded.map_id);
    const bubble = await ctx.executeTool('manage_maps', { action: 'create', name: `${PREFIX} bubble map`, data_item: piBirth, org_unit_level: 4, org_units: [ouRoot], period: '2026', thematic_map_type: 'BUBBLE' });
    check('a bubble map is created', bubble.success, bubble._error);
    made.maps.push(bubble.map_id);
    const sm = await api(`maps/${shaded.map_id}.json?fields=mapViews%5Blayer,noDataColor%5D`);
    check('the shaded map is saved with a no-data colour', sm.mapViews.find(v => v.layer === 'thematic').noDataColor === '#D9D9D9', JSON.stringify(sm));
    const bm = await api(`maps/${bubble.map_id}.json?fields=mapViews%5Blayer,noDataColor,organisationUnitLevels%5D`);
    const outline = bm.mapViews.find(v => v.layer === 'boundary');
    check('the bubble map is saved with district outlines and no grey markers', outline && outline.organisationUnitLevels[0] === 2 && !bm.mapViews.find(v => v.layer === 'thematic').noDataColor, JSON.stringify(bm));

    const ll = await ctx.executeTool('manage_line_lists', {
      action: 'create', name: `${PREFIX} registrations`, output_type: 'ENROLLMENT', program_id: PROGRAM,
      columns: [
        UNIQUE_ID,
        { dimension: 'enrollment_date', periods: ['2026'] },
        { dimension: 'ou', org_units: [ouRoot] },
        { dimension: HB, program_stage_id: FIRST_ANC },
        { dimension: HB, program_stage_id: SECOND_ANC },
        { dimension: METHOD, program_stage_id: BIRTH },
        { dimension: NEAR_MISS, program_stage_id: BIRTH },
      ],
    });
    check('the registration table is created', ll.success, ll._error);
    made.eventVisualizations.push(ll.line_list_id);
    const saved = await api(`eventVisualizations/${ll.line_list_id}.json?fields=columnDimensions`);
    check('its columns keep the order asked for', saved.columnDimensions[0] === UNIQUE_ID && saved.columnDimensions[1] === 'enrollmentDate' && saved.columnDimensions[2] === 'ou', JSON.stringify(saved.columnDimensions));
    check('the model hears the repeatable stage shows only the latest visit', (ll.warnings || []).some(w => /repeatable/.test(w) && /MOST RECENT/.test(w) && /Second antenatal/.test(w)), JSON.stringify(ll.warnings));
    check('the model hears which headers carry no stage name', (ll.warnings || []).some(w => /no stage in their header/.test(w) && /Delivery method/.test(w) && !/Hemoglobin value.*no stage/.test(w)), JSON.stringify(ll.warnings));
    check('the data check flags the columns that will be blank', (ll.data_check?.fields_without_values || []).some(f => /Delivery method/.test(f.field)) && (ll.data_check?.fields_rarely_filled || []).some(f => /Unique ID/.test(f.field) && f.with_values === uidFilled && f.records === peopleTotal), JSON.stringify(ll.data_check));
    const upd = await ctx.executeTool('manage_line_lists', {
      action: 'update', line_list_id: ll.line_list_id,
      columns: [
        UNIQUE_ID, { dimension: 'enrollment_date', periods: ['2026'] }, { dimension: 'ou', org_units: [ouRoot] },
        { dimension: HB, program_stage_id: SECOND_ANC, repeated_events: { oldest: 1 } },
        { dimension: METHOD, program_stage_id: BIRTH },
      ],
    });
    check('an update returns the notes too', upd.success && Array.isArray(upd.warnings), JSON.stringify(upd).slice(0, 300));
    check('…with no latest-visit note once a visit is named', !(upd.warnings || []).some(w => /MOST RECENT/.test(w)), JSON.stringify(upd.warnings));

    const scopedList = await ctx.executeTool('manage_line_lists', {
      action: 'create', name: `${PREFIX} scope on filters`, output_type: 'ENROLLMENT', program_id: PROGRAM,
      columns: [UNIQUE_ID, { dimension: 'enrollment_date' }, { dimension: 'ou' }, { dimension: NEAR_MISS, program_stage_id: BIRTH }],
      filters: [{ dimension: 'ou', org_units: [ouRoot] }, { dimension: 'enrollment_date', periods: ['2026'] }],
    });
    check('bare date and org-unit columns with their scope on the filters axis are saved', scopedList.success, scopedList._error);
    if (scopedList.line_list_id) {
      made.eventVisualizations.push(scopedList.line_list_id);
      const sl = await api(`eventVisualizations/${scopedList.line_list_id}.json?fields=columnDimensions,filterDimensions,simpleDimensions`);
      check('…as columns, in order, with no filter left', sl.columnDimensions[1] === 'enrollmentDate' && sl.columnDimensions[2] === 'ou' && !(sl.filterDimensions || []).length, JSON.stringify(sl));
    }

    const event = await ctx.executeTool('manage_line_lists', {
      action: 'create', name: `${PREFIX} flagged births`, output_type: 'EVENT', program_id: PROGRAM, program_stage_id: BIRTH,
      columns: [UNIQUE_ID, { dimension: 'event_date', periods: ['2026'] }, { dimension: 'ou', org_units: [ouRoot] }, METHOD, NEAR_MISS],
      filters: [{ dimension: NEAR_MISS, filter: { operator: 'EQ', value: true } }],
    });
    check('the event list is created', event.success, event._error);
    made.eventVisualizations.push(event.line_list_id);

    const dash = await ctx.executeTool('manage_dashboards', {
      action: 'create_dashboard', dashboard: { name: `${PREFIX} dashboard` },
      items: [...items, { type: 'MAP', map_id: shaded.map_id }, { type: 'MAP', map_id: bubble.map_id }, { type: 'EVENT_VISUALIZATION', event_visualization_id: ll.line_list_id }, { type: 'EVENT_VISUALIZATION', event_visualization_id: event.line_list_id }],
    });
    check('the dashboard is created', dash.success, dash._error);
    made.dashboards.push(dash.dashboard_id);
    made.visualizations.push(...(dash.new_visualizations || []).map(v => v.id));

    console.log('\nWhat the check reports, against the separate queries:');
    const c = dash.data_check || {};
    const empty = (c.empty_tiles || []).map(t => t.tile);
    const analyticsOk = !c.analytics_tables;
    if (!analyticsOk) console.log('  (the analytics tables are not healthy right now: tile checks are adjusted)', JSON.stringify(c.analytics_tables));
    check('every tile is checked', c.tiles?.total === 7, JSON.stringify(c.tiles));
    check('the caesarean tiles are empty, because of Delivery method', empty.includes(`${PREFIX} caesarean KPI`) && empty.includes(`${PREFIX} caesarean map`) && c.empty_tiles.find(t => t.tile === `${PREFIX} caesarean KPI`).because_no_values_in?.some(n => /Delivery method/.test(n)), JSON.stringify(c.empty_tiles));
    if (analyticsOk) {
      const kpi = (await api(`analytics.json?dimension=dx:${piBirth}&filter=pe:2026&filter=ou:${ouRoot}&skipMeta=true`)).rows?.[0]?.[1];
      check(`the birth-records KPI has data, as a separate query says (${kpi})`, Number(kpi) > 0 && !empty.includes(`${PREFIX} birth records KPI`));
      const partly = (c.partly_empty_tiles || []).find(t => t.tile === `${PREFIX} district table`);
      check('the district table is partly empty, naming exactly the empty columns', partly && partly.empty_items.length === 2 && partly.empty_items.every(n => /caesarean/.test(n)), JSON.stringify(c.partly_empty_tiles));
      check('the bubble map has data', !empty.includes(`${PREFIX} bubble map`));
    }
    check('Delivery method is reported as holding nothing, with the right total', (c.fields_without_values || []).some(f => /Delivery method/.test(f.field) && f.records === birthTotal), JSON.stringify(c.fields_without_values));
    check('Near-miss is not reported', !(c.fields_without_values || []).some(f => /near-miss/i.test(f.field)) && !(c.fields_rarely_filled || []).some(f => /near-miss/i.test(f.field)));
    check('Unique ID is reported as rarely filled, with the right counts', (c.fields_rarely_filled || []).some(f => /Unique ID/.test(f.field) && f.with_values === uidFilled && f.records === peopleTotal), JSON.stringify(c.fields_rarely_filled));
    check('the zero on the percentage KPI is explained', (c.single_values_showing_0_for_nothing_recorded || []).includes(`${PREFIX} caesarean KPI`));

    console.log('\nThe end of the turn:');
    const arm = () => { ctx.noteDataCheckTarget('manage_dashboards', { action: 'create_dashboard' }, dash); ctx.noteDataCheckTarget('manage_line_lists', { action: 'update' }, upd); };
    arm();
    const block = await ctx.finishTurnDataCheck('The dashboard is built.');
    check('the block names the field and the zero, and adds the link', /Data check/.test(block) && /Delivery method/.test(block) && /Unique ID/.test(block) && /real zero/.test(block) && block.includes(dash.dashboard_url), block);
    arm();
    check('a right link in the answer is not repeated', !/Dashboard link/.test(await ctx.finishTurnDataCheck(`Open ${dash.dashboard_url}`)));

    d.metadataOnlyTurn = true;
    arm();
    const callsBefore = API.length;
    const quiet = await ctx.finishTurnDataCheck('Built.');
    const validated = await ctx.executeTool('manage_line_lists', { action: 'validate', line_list_id: ll.line_list_id });
    d.metadataOnlyTurn = false;
    const rowReads = API.slice(callsBefore).filter(a => /analytics\/(?:events|enrollments|trackedEntities)\/query\//.test(a.url));
    const trackerReads = API.slice(mark).filter(a => /\/tracker\//.test(a.url));
    check(`every list probe asked for the facility name only (${rowReads.length})`, rowReads.length > 0 && rowReads.every(a => /headers=ouname/.test(a.url) && /pageSize=1\b/.test(a.url)), rowReads.map(a => a.url).join(' | '));
    check(`every tracker read of this whole run asked for ids only (${trackerReads.length})`, trackerReads.length > 0 && trackerReads.every(a => /fields=(?:event|trackedEntity)(?:&|$)/.test(a.url) && /pageSize=1\b/.test(a.url)), trackerReads.map(a => a.url).join(' | '));
    const numbers = [birthTotal, peopleTotal, uidFilled].filter(n => n > 0).map(String);
    check('a metadata-only request still gets the findings', /Delivery method/.test(quiet) && /Unique ID/.test(quiet), quiet);
    check('…with no count from the server in them', !numbers.some(n => new RegExp(`\\b${n}\\b`).test(quiet)), quiet);
    check('…and validate holds its counts back too', validated.success && validated.row_count === undefined && !numbers.some(n => new RegExp(`\\b${n}\\b`).test(JSON.stringify(validated.data_check || {}))), JSON.stringify(validated.data_check));

    console.log('\nAn event aggregate with skipMeta (500 on 2.43.2 when sent as it is):');
    const agg = await ctx.safeDhis2Fetch(`analytics/events/aggregate/${PROGRAM}?stage=${BIRTH}&dimension=ou:${ouRoot}&dimension=pe:2026&skipMeta=true`);
    check('answers', !agg._error && Array.isArray(agg.rows), JSON.stringify(agg).slice(0, 200));

    const failed = API.slice(mark).filter((a) => !a.ok);
    console.log('');
    check(`no API call failed (${API.length - mark} calls)`, failed.length === 0, failed.map((f) => `${f.status} ${f.method} ${f.url}`).join(' | '));
    if (KEEP) console.log(`\nKept for opening: ${dash.dashboard_url}`);
  } catch (e) {
    check(`scenario threw: ${e.message}`, false, e.stack);
  } finally {
    if (!KEEP) {
      console.log('\nCleanup:');
      for (const id of made.dashboards) await api(`dashboards/${id}`, { method: 'DELETE' });
      for (const id of made.eventVisualizations) if (id) await api(`eventVisualizations/${id}`, { method: 'DELETE' });
      for (const id of made.maps) if (id) await api(`maps/${id}`, { method: 'DELETE' });
      for (const id of made.visualizations) if (id) await api(`visualizations/${id}`, { method: 'DELETE' });
      for (const id of made.programIndicators) if (id) await api(`programIndicators/${id}`, { method: 'DELETE' });
      const keys = await api('dataStore/dhis2-ai-extension-backups');
      let removed = 0;
      for (const k of Array.isArray(keys) ? keys.filter((x) => !backupsBefore.has(x)) : []) {
        const e = await api(`dataStore/dhis2-ai-extension-backups/${encodeURIComponent(k)}`);
        if (JSON.stringify(e && e.reason || '').includes(PREFIX) || (e.objects || []).some((o) => String(o.name || '').includes(PREFIX))) { await api(`dataStore/dhis2-ai-extension-backups/${encodeURIComponent(k)}`, { method: 'DELETE' }); removed++; }
      }
      const q = `filter=name:like:${encodeURIComponent(PREFIX)}&fields=id&paging=false`;
      const left = [...((await api(`visualizations.json?${q}`)).visualizations || []), ...((await api(`maps.json?${q}`)).maps || []), ...((await api(`eventVisualizations.json?${q}`)).eventVisualizations || []), ...((await api(`programIndicators.json?${q}`)).programIndicators || []), ...((await api(`dashboards.json?${q}`)).dashboards || [])];
      check(`nothing is left on the server (${removed} backup(s) removed)`, left.length === 0, JSON.stringify(left));
    }
    console.log(failures ? `\n\x1b[31mFAILED\x1b[0m — ${failures} check(s)\n` : '\n\x1b[32mALL CHECKS PASSED\x1b[0m\n');
    process.exit(failures ? 1 : 0);
  }
})();
