#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-sql-views.js — live test of manage_sql_views, the metadata-only SQL
 * view privacy exception and the dhis2_query endpoint guards, against a LIVE
 * DHIS2 (default http://localhost:8081, see live-harness.js env), through the
 * REAL executeTool pipeline with a CLOUD provider configured (privacy gate on).
 *
 * The thread it replays (2026-10-23): "a dashboard plugin that shows the
 * transfer history of all org units, filterable by date and org unit". There
 * is no transfer program; the history is the programownershiphistory table.
 *   A. the guessed endpoints are answered without a request;
 *   B. describe shows the real columns (and the 2.41 renames);
 *   C. the transfer-history view is created, RUN once (row count, no rows),
 *      re-run with an org-unit filter, refused to dhis2_query (patient-level);
 *   D. a metadata-only view returns rows — via the tool AND dhis2_query;
 *   E. SQL that fails in the database is reported and removed (EXPECTED 409);
 *   F. update (backed up, re-run) and a failing update put back as it was;
 *   G. a plugin on the view passes preview; with sharing rw------ it is refused;
 *   H. cleanup — views, temporary views and this run's backups; nothing left.
 *
 * PASS = every assertion holds AND zero failed API calls outside the one
 * deliberately-provoked database error (marked EXPECTED).
 * ───────────────────────────────────────────────────────────────────────────── */
const vm = require('vm');
const { load, API, summarize, APIVER } = require('./live-harness');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const show = (r) => JSON.stringify(r === undefined ? null : r).slice(0, 500);
const expected = new Set();

const TRANSFER_SQL = `with history as (
  select h.programownershiphistoryid as transfer_id, h.trackedentityid, h.programid,
         h.organisationunitid as from_ou_id, h.enddate as transferred_at,
         lead(h.organisationunitid) over w as next_ou_id,
         lead(h.createdby) over w as next_owner_createdby
  from programownershiphistory h
  window w as (partition by h.trackedentityid, h.programid order by h.enddate, h.programownershiphistoryid)
)
select to_char(t.transferred_at, 'YYYY-MM-DD HH24:MI') as transferred_at,
       p.uid as program_id, p.name as program, te.uid as tracked_entity,
       fo.uid as from_org_unit_id, fo.name as from_org_unit,
       tu.uid as to_org_unit_id, tu.name as to_org_unit,
       coalesce(t.next_owner_createdby, cur.createdby) as transferred_by
from history t
join program p on p.programid = t.programid
join trackedentity te on te.trackedentityid = t.trackedentityid and te.deleted = false
join organisationunit fo on fo.organisationunitid = t.from_ou_id
left join trackedentityprogramowner cur on cur.trackedentityid = t.trackedentityid and cur.programid = t.programid
left join organisationunit tu on tu.organisationunitid = coalesce(t.next_ou_id, cur.organisationunitid)
where t.transferred_at >= cast('\${startDate}' as date)
  and t.transferred_at < cast('\${endDate}' as date) + interval '1 day'
  and ('\${orgUnit}' = 'ALL' or fo.path like '%' || '\${orgUnit}' || '%' or tu.path like '%' || '\${orgUnit}' || '%')
order by t.transferred_at desc`;
const ALL = { startDate: '2000-01-01', endDate: '2099-12-31', orgUnit: 'ALL' };

const PLUGIN = (viewId) => `const { useState, useEffect, useRef } = React;
const { Provider, useDataQuery } = D2Runtime;
const { CircularLoader, NoticeBox, DataTable, DataTableHead, DataTableRow, DataTableColumnHeader, DataTableBody, DataTableCell } = D2UI;
const ROWS = { rows: { resource: 'sqlViews/${viewId}/data', params: ({ startDate, endDate, orgUnit, page }) => ({
  var: [\`startDate:\${startDate}\`, \`endDate:\${endDate}\`, \`orgUnit:\${orgUnit}\`], page, pageSize: 50 }) } };
function Rows({ orgUnit }) {
  const { data, error, loading } = useDataQuery(ROWS, { variables: { startDate: '2000-01-01', endDate: '2099-12-31', orgUnit, page: 1 } });
  if (loading) return <CircularLoader small />;
  if (error) return <NoticeBox error title="Could not load transfers">{error.message}</NoticeBox>;
  const g = data.rows.listGrid;
  return (
    <DataTable>
      <DataTableHead><DataTableRow>{g.headers.map((h) => <DataTableColumnHeader key={h.name}>{h.name}</DataTableColumnHeader>)}</DataTableRow></DataTableHead>
      <DataTableBody>{g.rows.map((r, i) => <DataTableRow key={i}>{r.map((v, j) => <DataTableCell key={j}>{v}</DataTableCell>)}</DataTableRow>)}</DataTableBody>
    </DataTable>
  );
}
function Plugin({ dashboardItemFilters = {}, setPluginHeight }) {
  const ou = ((dashboardItemFilters.ou || [])[0] || {}).id || 'ALL';
  const ref = useRef(null);
  useEffect(() => {
    if (typeof setPluginHeight !== 'function' || !ref.current) return;
    const ro = new ResizeObserver(() => setPluginHeight(Math.ceil(ref.current.scrollHeight)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [setPluginHeight]);
  return <div ref={ref} style={{ padding: 12 }}><Rows key={ou} orgUnit={ou} /></div>;
}
const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
const root = ReactDOMClient.createRoot(document.getElementById('root'));
const render = (props) => root.render(<Provider config={CONFIG} plugin parentAlertsAdd={props.alertsAdd}><Plugin {...props} /></Provider>);
if (window.parent === window) render({});
else postRobot.send(window.parent, 'getPropsFromParent').then(({ data }) => render(data)).catch(() => render({}));
postRobot.on('updated', ({ data }) => { render(data); });
`;

(async () => {
  const ctx = load({ appType: 'Dashboard' });
  // A cloud provider: the privacy gate is ON for this whole run.
  vm.runInContext("_cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, providerType: 'fireworks', apiBaseUrl: 'https://api.fireworks.ai/inference/v1', modelId: 'harness' };", ctx);
  const t = (name, args) => ctx.executeTool(name, args);
  const raw = (path, method = 'GET', body) => ctx.safeDhis2Fetch(path, { method, ...(body ? { body } : {}) });
  const tag = Date.now().toString(36).slice(-5);
  const created = new Set();
  const BACKUP_NS = 'dhis2-ai-extension-backups';
  const backupsBefore = new Set(await raw(`dataStore/${BACKUP_NS}`).then((k) => (Array.isArray(k) ? k : [])).catch(() => []));
  const viewsBefore = await raw('sqlViews?fields=id&paging=false').then((r) => (r.sqlViews || []).map((v) => v.id));
  check('cloud provider configured — patient-level reads are refused', vm.runInContext('providerRequestsStayLocal(getProviderConfig())', ctx) === false);

  try {
    console.log('\nA. The endpoints the failed thread guessed are answered without a request:');
    let n0 = API.length;
    const own = await t('dhis2_query', { path: 'tracker/ownership/transfer' });
    const own2 = await t('dhis2_query', { path: 'tracker/ownership' });
    const aud = await t('dhis2_query', { path: 'audits' });
    const sch = await t('dhis2_query', { path: 'schemas/enrollment' });
    check('tracker/ownership/transfer, tracker/ownership, audits → guidance pointing to SQL views', [own, own2, aud].every((r) => r._scope === 'known_endpoint_guidance'), show(own));
    check('schemas/enrollment → "not a metadata schema"', /no metadata schema "enrollment"/.test(sch._error || ''), show(sch));
    check('…none of them sent a request except the one schema list lookup', API.slice(n0).every((a) => /\/schemas\?/.test(a.url)), show(API.slice(n0)));
    const audTe = await t('dhis2_query', { path: 'audits/trackedEntity?trackedEntities=x' });
    check('audits/trackedEntity (patient audit trail) is refused by the privacy gate', audTe._privacy_block === true, show(audTe));
    const healed = await t('dhis2_query', { path: 'schemas/dataElements?fields=name' });
    check('schemas/dataElements is healed to the singular name and answers', healed && healed.name === 'dataElement', show(healed));

    console.log('\nB. describe — the real database columns:');
    const desc = await t('manage_sql_views', { action: 'describe', tables: ['programownershiphistory', 'trackedentityprogramowner', 'organisationunit', 'trackedentityinstance'] });
    check('programownershiphistory columns are the real ones', (desc.tables?.programownershiphistory || []).join(',').includes('organisationunitid bigint') && (desc.tables?.programownershiphistory || []).some((c) => c.startsWith('enddate')), show(desc));
    check(`trackedentityinstance is reported gone on 2.${APIVER} with its new name`, /trackedentity/.test(desc.renamed?.trackedentityinstance || ''), show(desc.renamed));
    const srch = await t('manage_sql_views', { action: 'describe', search: 'ownership' });
    check('search "ownership" finds programownershiphistory and programtempownershipaudit', (srch.matching_tables || []).includes('programownershiphistory') && (srch.matching_tables || []).includes('programtempownershipaudit'), show(srch));
    const tmpLeft = await raw('sqlViews?fields=id,name&filter=name:like:ai-tmp-describe&paging=false');
    check('describe left no temporary view behind', (tmpLeft.sqlViews || []).length === 0, show(tmpLeft));

    console.log('\nC. The transfer-history view:');
    const tv = await t('manage_sql_views', { action: 'create', name: `ai-test-transfer-history-${tag}`, description: 'Ownership transfers (test)', sql_query: TRANSFER_SQL, test_variables: ALL });
    if (tv.id) created.add(tv.id);
    check('created and RUN once: columns + a row count, rows withheld (patient-level, cloud model)', tv.success && tv.test.columns.includes('transferred_at') && Number.isInteger(tv.test.row_count) && !tv.test.rows && /not metadata-only/.test(tv.test.rows_withheld || ''), show(tv));
    const direct = await raw(`sqlViews/${tv.id}/data?var=startDate:2000-01-01,endDate:2099-12-31,orgUnit:ALL&pageSize=1`);
    check(`row count matches the server (${direct.pager?.total} transfers)`, direct.pager && direct.pager.total === tv.test.row_count, show(direct.pager));
    check('readable by every logged-in user (public data read) — the plugin can read it', /every logged-in user/.test(tv.data_access), tv.data_access);
    const dup = await t('manage_sql_views', { action: 'create', name: `ai-test-transfer-history-${tag}`, sql_query: TRANSFER_SQL.replace('desc', 'asc'), test_variables: ALL });
    check('a second view with the same name is refused (update it instead)', /already exists/.test(dup._error || '') && dup.existing_id === tv.id, show(dup));
    const ouRow = await raw('organisationUnits?fields=id&filter=level:eq:1&pageSize=1');
    const root = ouRow.organisationUnits?.[0]?.id;
    const runOu = await t('manage_sql_views', { action: 'run', id: tv.id, variables: { ...ALL, orgUnit: root } });
    check('run with an org-unit filter: a count, no rows', Number.isInteger(runOu.row_count) && !runOu.rows && runOu.rows_withheld, show(runOu));
    n0 = API.length;
    const q = await t('dhis2_query', { path: `sqlViews/${tv.id}/data`, query_params: { var: 'startDate:2000-01-01,endDate:2099-12-31,orgUnit:ALL' } });
    check('dhis2_query GET …/data on it is refused: not metadata-only (reads programownershiphistory …)', q._privacy_block && /programownershiphistory/.test(q._error), show(q));
    check('…after reading only the view DEFINITION (no data request)', API.slice(n0).every((a) => !/\/data/.test(a.url)), show(API.slice(n0)));

    console.log('\nD. A metadata-only view returns its rows:');
    const mv = await t('manage_sql_views', { action: 'create', name: `ai-test-program-stages-${tag}`, sql_query: "select p.uid as program_id, p.name as program, count(ps.programstageid) as stages from program p left join programstage ps on ps.programid = p.programid where p.name ilike '%${q}%' group by p.uid, p.name order by p.name", test_variables: { q: 'a' } });
    if (mv.id) created.add(mv.id);
    check('created; the test run shows its rows', mv.success && Array.isArray(mv.test.rows) && mv.test.rows.length > 0, show(mv));
    const mq = await t('dhis2_query', { path: `sqlViews/${mv.id}/data?var=q:a&pageSize=5` });
    check('dhis2_query GET …/data is allowed for it on a cloud model and returns rows', mq && mq.listGrid && mq.listGrid.rows.length > 0, show(mq));
    const mr = await t('manage_sql_views', { action: 'run', id: mv.id, variables: { q: 'a' }, page_size: 3 });
    check('run returns rows + paging hint', Array.isArray(mr.rows) && mr.rows.length <= 3 && mr.row_count >= mr.rows.length, show(mr));

    console.log('\nE. SQL that fails in the database:');
    const before = API.length;
    const bad = await t('manage_sql_views', { action: 'create', name: `ai-test-bad-${tag}`, sql_query: 'select h.created from programownershiphistory h', test_variables: {} });
    API.slice(before).forEach((a, i) => { if (a.status === 409) expected.add(before + i); });
    check('EXPECTED 409: reported with the real PostgreSQL error and the view removed', /E714[45]/.test(bad._error || '') && /h\.created does not exist/.test(bad.db_error || '') && bad.view_removed === true, show(bad));
    const badLeft = await raw(`sqlViews?fields=id&filter=name:eq:ai-test-bad-${tag}`);
    check('…nothing left on the server', (badLeft.sqlViews || []).length === 0, show(badLeft));
    const pre = await t('manage_sql_views', { action: 'create', name: `ai-test-pre-${tag}`, sql_query: 'select tei.uid from trackedentityinstance tei where tei.uid <> \'delete\'', test_variables: {} });
    check('2.40 table name + illegal keyword caught before any request', /problem/.test(pre._error || '') && pre.problems.length === 2, show(pre));

    console.log('\nF. update:');
    const up = await t('manage_sql_views', { action: 'update', id: tv.id, description: 'Ownership transfers — every org unit (test)', test_variables: ALL });
    check('update is backed up and re-run', up.success && up.backup && up.test && up.test.ran, show(up));
    const upBadBefore = API.length;
    const upBad = await t('manage_sql_views', { action: 'update', id: tv.id, sql_query: TRANSFER_SQL.replace('h.enddate as transferred_at', 'h.enddated as transferred_at'), test_variables: ALL });
    API.slice(upBadBefore).forEach((a, i) => { if (a.status === 409) expected.add(upBadBefore + i); });
    const after = await raw(`sqlViews/${tv.id}?fields=sqlQuery`);
    check('EXPECTED 409: a failing update is put back exactly as it was', /does not exist/.test(upBad.db_error || '') && upBad.restored === true && after.sqlQuery === TRANSFER_SQL, show(upBad));

    console.log('\nG. A plugin on the view:');
    const pv = await t('manage_custom_app', { action: 'preview', name: `ai-test-transfers-${tag}`, key: `ai-test-transfers-${tag}`, kind: 'plugin', plugin_type: 'DASHBOARD', files: { 'plugin.jsx': PLUGIN(tv.id) } });
    // First call of a manual tool returns its manual.
    const pv2 = pv._tool_manual ? await t('manage_custom_app', { action: 'preview', name: `ai-test-transfers-${tag}`, key: `ai-test-transfers-${tag}`, kind: 'plugin', plugin_type: 'DASHBOARD', files: { 'plugin.jsx': PLUGIN(tv.id) } }) : pv;
    check('preview passes and names the view, its readers and variables', pv2.preview && Array.isArray(pv2.sql_views) && pv2.sql_views[0].id === tv.id && pv2.sql_views[0].variables.length === 3 && !pv2.warnings, show(pv2.warnings || pv2));
    n0 = API.length;
    const shut = await t('manage_sql_views', { action: 'update', id: tv.id, sharing: { public: 'rw------' }, test_variables: ALL });
    check('the tool refuses to save sharing nobody could read (rw------), before any request', /NOBODY could read/.test(shut._error || '') && API.slice(n0).every((a) => !/PUT/.test(a.method || '')), show(shut));
    // The failed thread's view: set rw------ directly, as its raw dhis2_query POST did.
    const own3 = await raw(`sqlViews/${tv.id}?fields=:owner`);
    await raw(`sqlViews/${tv.id}`, 'PUT', { ...own3, sharing: { ...own3.sharing, public: 'rw------' } });
    const pv3 = await t('manage_custom_app', { action: 'preview', name: `ai-test-transfers-${tag}`, key: `ai-test-transfers-${tag}`, kind: 'plugin', plugin_type: 'DASHBOARD', files: { 'plugin.jsx': PLUGIN(tv.id) } });
    check('a plugin on a view shared rw------ is refused at preview: nobody could read it (E4312)', /could not read/.test(pv3._error || '') && (pv3.problems || []).some((p) => /NOBODY/.test(p)), show(pv3));
  } catch (e) {
    failures++;
    console.log(`  ✗ threw: ${e && e.stack || e}`);
  } finally {
    console.log('\nH. Cleanup:');
    for (const id of created) await raw(`sqlViews/${id}`, 'DELETE');
    const viewsAfter = await raw('sqlViews?fields=id&paging=false').then((r) => (r.sqlViews || []).map((v) => v.id));
    const extra = viewsAfter.filter((id) => !viewsBefore.includes(id));
    check('no SQL view left behind', extra.length === 0, show(extra));
    const keys = await raw(`dataStore/${BACKUP_NS}`).then((k) => (Array.isArray(k) ? k : []));
    let removed = 0;
    for (const k of keys.filter((k2) => !backupsBefore.has(k2))) {
      const e = await raw(`dataStore/${BACKUP_NS}/${k}`);
      if ((e.objects || []).some((o) => created.has(o.object_id))) { await raw(`dataStore/${BACKUP_NS}/${k}`, 'DELETE'); removed++; }
    }
    console.log(`  (removed ${removed} backup(s) made for this run's views)`);
    const { failed } = summarize(0);
    const unexpected = failed.filter((a) => !expected.has(API.indexOf(a)));
    check(`zero unexpected failed API calls (${API.length} calls, ${failed.length - unexpected.length} expected)`, unexpected.length === 0, show(unexpected));
    console.log(failures ? `\n✗ ${failures} check(s) failed` : '\n✓ all checks passed');
    process.exit(failures ? 1 : 0);
  }
})();
