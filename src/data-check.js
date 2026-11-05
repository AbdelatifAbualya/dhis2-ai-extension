/* ══════════════════════════════════════════════════════════════════════════════
   src/data-check.js — what saved dashboards, charts, maps and line lists will
   actually show when the user opens them.

   Maternity thread, 2026-11-04 (play 2.43.2, dashboard X1Wj4covsXu): every saved
   object was correct and the run had no failed call, yet the dashboard looked
   broken. Delivery method and Pregnancy outcome have no value on any of the 1,982
   birth-care events, so the Caesarean % tile showed 0, a chart said "No data" and
   the map opened on an empty view of Africa. Unique ID is on 10 of 4,009 people, so
   the identifier column was blank. While it was being built the event analytics
   tables were also empty, because a job another user made was rebuilding them. The
   answer said only "all numbers must be confirmed by opening the tiles".

   So every build is measured, and the result does not depend on the model:
     - tile by tile: the same aggregate query the tile runs;
     - field by field: how many records hold a value (tracker totals, live);
     - program by program: do the analytics tables hold its records at all.

   Counts only. A tracker total asks for one id, which is dropped; a line list probe
   asks for one row holding only the facility name. No patient value is read, and
   nothing but these counts reaches the model, so it also runs in a metadata-only
   request, with the numbers held back. Failures never block a tool: what cannot be
   measured is left out.
   ══════════════════════════════════════════════════════════════════════════════ */

const DATA_CHECK_TTL_MS = 60 * 1000;       // one build asks about the same field many times
const DATA_CHECK_BUDGET_MS = 25 * 1000;    // never hold up a tool result or the end of a turn
const DATA_CHECK_FEW_SHARE = 0.05;         // under this share of records a column reads as blank
const DATA_CHECK_MAX_FIELDS = 40;
const DATA_CHECK_POOL = 4;
const _dataCheckCache = new Map();
// A real run spent 20 extra analytics queries re-checking a field reported as empty
// and looking for its values in other fields (Maternity replay, 2026-11-05).
const DATA_CHECK_MODEL_NOTE = 'These are live counts from the server: do not re-check them with analytics queries, and do not look for the values in other fields. The extension prints the findings under your final answer, so do not repeat them. Never say or imply that a listed tile shows data.';

function dataCheckCached(key, load) {
  const k = `${dhis2.baseUrl}|${key}`;
  const hit = _dataCheckCache.get(k);
  if (hit && Date.now() - hit.at < DATA_CHECK_TTL_MS) return hit.value;
  const value = Promise.resolve().then(load).catch(() => null);
  _dataCheckCache.set(k, { at: Date.now(), value });
  return value;
}

async function dataCheckPool(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await worker(items[i]); } catch { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DATA_CHECK_POOL, items.length) }, run));
  return out;
}

// A live total. One id comes back with it and is dropped here.
function dataCheckTrackerCount(path) {
  return dataCheckCached(`count:${path}`, async () => {
    const r = await safeDhis2Fetch(path);
    if (!r || r._error) return null;
    const total = r.pager?.total ?? r.total;
    return Number.isFinite(total) ? total : null;
  });
}

// How many records of a stage (or people of a program) hold a value for a field.
async function dataCheckFieldCoverage(f) {
  const base = f.kind === 'tea'
    ? `tracker/trackedEntities?program=${f.programId}&orgUnitMode=ACCESSIBLE&pageSize=1&totalPages=true&fields=trackedEntity`
    : `tracker/events?program=${f.programId}&programStage=${f.stageId}&orgUnitMode=ACCESSIBLE&pageSize=1&totalPages=true&fields=event`;
  const [withValues, total] = await Promise.all([
    dataCheckTrackerCount(`${base}&filter=${f.id}:!null`),
    dataCheckTrackerCount(base),
  ]);
  if (withValues == null || total == null) return { state: 'unknown' };
  const state = total === 0 ? 'no_records'
    : withValues === 0 ? 'none'
      : withValues / total < DATA_CHECK_FEW_SHARE ? 'few' : 'ok';
  return { state, with_values: withValues, total };
}

// Do the analytics tables hold this program's records? system/info cannot say: it
// reported a run minutes old while every event query answered 0, for every program.
function dataCheckAnalyticsState(programId) {
  return dataCheckCached(`analytics:${programId}`, async () => {
    const y = new Date().getFullYear();
    const [live, inTables] = await Promise.all([
      dataCheckTrackerCount(`tracker/events?program=${programId}&orgUnitMode=CAPTURE&occurredAfter=${y - 5}-01-01&occurredBefore=${y}-12-31&pageSize=1&totalPages=true&fields=event`),
      safeDhis2Fetch(`analytics/events/aggregate/${programId}?dimension=pe:THIS_YEAR;LAST_5_YEARS&filter=ou:USER_ORGUNIT`),
    ]);
    if (live == null) return { state: 'unknown' };
    if (live === 0) return { state: 'no_records', live };
    if (inTables?._error) {
      return /E7144|does not exist/i.test(String(inTables._error)) ? { state: 'missing', live } : { state: 'unknown' };
    }
    const held = sumAnalyticsValueColumn(inTables);
    const state = held === 0 ? 'empty' : held < live * 0.5 ? 'behind' : 'ok';
    if (state === 'ok') return { state, live, held };
    const [info, cache] = await Promise.all([
      safeDhis2Fetch('system/info?fields=lastAnalyticsTableSuccess'),
      safeDhis2Fetch('systemSettings/keyCacheStrategy'),
    ]);
    return {
      state, live, held,
      last_run: info?.lastAnalyticsTableSuccess || null,
      cache_strategy: cache?._error ? null : (cache?.keyCacheStrategy || null),
    };
  });
}

// ── Reading what a saved object asks for ─────────────────────────────────────
const DATA_CHECK_DX_FIELDS = 'dataDimensionItemType,programIndicator[id,displayName,expression,filter,program[id]],indicator[id,displayName],dataElement[id,displayName]';
const DATA_CHECK_SAVED_FIELDS = `periods[id],relativePeriods,organisationUnits[id],organisationUnitLevels,userOrganisationUnit,userOrganisationUnitChildren,userOrganisationUnitGrandChildren,dataDimensionItems[${DATA_CHECK_DX_FIELDS}]`;

function dataCheckOuDimension(saved) {
  const parts = (saved.organisationUnits || []).map(o => o.id);
  if (saved.userOrganisationUnit) parts.push('USER_ORGUNIT');
  if (saved.userOrganisationUnitChildren) parts.push('USER_ORGUNIT_CHILDREN');
  if (saved.userOrganisationUnitGrandChildren) parts.push('USER_ORGUNIT_GRANDCHILDREN');
  for (const lvl of saved.organisationUnitLevels || []) parts.push(`LEVEL-${lvl}`);
  return parts.join(';');
}

function dataCheckPeDimension(saved) {
  const fixed = (saved.periods || []).map(p => p.id).filter(Boolean);
  return [...fixed, ...getRelativePeriodKeys(saved.relativePeriods)].join(';');
}

// The fields an indicator reads, from its expression and filter.
function dataCheckIndicatorFields(pi) {
  const text = `${pi?.expression || ''} ${pi?.filter || ''}`;
  const programId = pi?.program?.id || null;
  const out = [];
  if (!programId) return out;
  for (const m of text.matchAll(/#\{([A-Za-z][A-Za-z0-9]{10})\.([A-Za-z][A-Za-z0-9]{10})\}/g)) out.push({ kind: 'de', programId, stageId: m[1], id: m[2] });
  for (const m of text.matchAll(/A\{([A-Za-z][A-Za-z0-9]{10})\}/g)) out.push({ kind: 'tea', programId, stageId: null, id: m[1] });
  return out;
}

const dataCheckFieldKey = (f) => `${f.programId}:${f.stageId || ''}:${f.id}`;

function dataCheckItems(dims) {
  return (dims || []).map((d) => {
    const o = d.programIndicator || d.indicator || d.dataElement;
    return o?.id ? { id: o.id, name: o.displayName || o.id, indicator: d.programIndicator || null } : null;
  }).filter(Boolean);
}

// One chart, table, single value or map layer: the tile's own aggregate query, with
// every dimension spread out so each item can be told apart.
async function dataCheckAggregateTile(tile, saved) {
  const items = dataCheckItems(saved.dataDimensionItems);
  const ou = dataCheckOuDimension(saved);
  const pe = dataCheckPeDimension(saved);
  if (!items.length || !ou || !pe) return { ...tile, state: 'not_checked', items };
  const r = await safeDhis2Fetch(`analytics?dimension=dx:${items.map(i => i.id).join(';')}&dimension=ou:${ou}&dimension=pe:${pe}&skipMeta=true`);
  if (r?._error) return { ...tile, state: 'failed', error: String(r._error).slice(0, 200), items };
  const headers = r?.headers || [];
  const dxCol = headers.findIndex(h => h.name === 'dx');
  const valueCol = headers.findIndex(h => h.name === 'value');
  const filled = new Set();
  for (const row of r?.rows || []) {
    const v = Number(row[valueCol]);
    if (dxCol >= 0 && valueCol >= 0 && Number.isFinite(v) && v !== 0) filled.add(row[dxCol]);
  }
  const emptyItems = items.filter(i => !filled.has(i.id));
  return {
    ...tile,
    state: !emptyItems.length ? 'ok' : emptyItems.length === items.length ? 'empty' : 'partly_empty',
    empty_items: emptyItems.map(i => ({ id: i.id, name: i.name })),
    items,
  };
}

async function dataCheckLineListTile(id) {
  const ev = await safeDhis2Fetch(`eventVisualizations/${id}?fields=${LINE_LIST_GET_FIELDS}`);
  if (ev?._error) return { tile: id, type: 'LINE_LIST', state: 'failed', error: String(ev._error).slice(0, 200), fields: [] };
  const { columns, filters, summary } = lineListDimsFromSaved(ev);
  const tile = { tile: summary.name || ev.displayName || id, type: 'LINE_LIST' };
  const programId = ev.program?.id || null;
  const fields = [];
  if (programId) {
    for (const d of columns) {
      if (d.kind === 'tea') fields.push({ kind: 'tea', programId, stageId: null, id: d.dimension, name: d.label });
      else if (d.kind === 'de' && (d.stageId || ev.programStage?.id)) fields.push({ kind: 'de', programId, stageId: d.stageId || ev.programStage.id, id: d.dimension, name: d.label });
    }
  }
  const probe = lineListBuildProbePath(ev.outputType, programId, ev.trackedEntityType?.id, columns, [...columns, ...filters]);
  const res = await lineListRunProbe(lineListProbeWithoutValues(probe.path));
  if (!res.ok) return { ...tile, state: 'failed', error: String(res.error || '').slice(0, 200), fields, programId };
  return { ...tile, state: res.row_count === 0 ? 'empty' : 'ok', fields, programId };
}

// ── The check ────────────────────────────────────────────────────────────────
// targets: { dashboards, visualizations, maps, lineLists, indicators } (ids).
async function runDataCheck(targets) {
  const vizIds = new Set(targets.visualizations || []);
  const mapIds = new Set(targets.maps || []);
  const listIds = new Set(targets.lineLists || []);
  for (const dashId of targets.dashboards || []) {
    const d = await safeDhis2Fetch(`dashboards/${dashId}?fields=dashboardItems[visualization[id],map[id],eventVisualization[id]]`);
    for (const it of d?.dashboardItems || []) {
      if (it.visualization?.id) vizIds.add(it.visualization.id);
      if (it.map?.id) mapIds.add(it.map.id);
      if (it.eventVisualization?.id) listIds.add(it.eventVisualization.id);
    }
  }

  const tiles = [];
  if (vizIds.size) {
    const r = await safeDhis2Fetch(`visualizations?filter=id:in:[${[...vizIds].join(',')}]&paging=false&fields=id,displayName,type,${DATA_CHECK_SAVED_FIELDS}`);
    const found = await dataCheckPool(r?.visualizations || [], v => dataCheckAggregateTile({ tile: v.displayName || v.id, type: v.type || 'CHART' }, v));
    tiles.push(...found.filter(Boolean));
  }
  const maps = await dataCheckPool([...mapIds], async (id) => {
    const m = await safeDhis2Fetch(`maps/${id}?fields=id,displayName,mapViews[layer,${DATA_CHECK_SAVED_FIELDS}]`);
    if (m?._error) return null;
    const layer = (m.mapViews || []).find(v => /^thematic/.test(String(v.layer || '')));
    return layer ? dataCheckAggregateTile({ tile: m.displayName || id, type: 'MAP' }, layer) : null;
  });
  tiles.push(...maps.filter(Boolean));
  const lists = await dataCheckPool([...listIds], dataCheckLineListTile);
  tiles.push(...lists.filter(Boolean));

  // Which fields each tile depends on, and which tile each field serves.
  const fields = new Map();
  const noteField = (f, usedBy, viaIndicator = null) => {
    const k = dataCheckFieldKey(f);
    if (!fields.has(k)) fields.set(k, { ...f, used_by: new Set(), indicators: new Set() });
    const e = fields.get(k);
    if (usedBy) e.used_by.add(usedBy);
    if (viaIndicator) e.indicators.add(viaIndicator);
    if (f.name && !e.name) e.name = f.name;
  };
  const programs = new Set();
  for (const t of tiles) {
    if (t.programId) programs.add(t.programId);
    for (const f of t.fields || []) noteField(f, t.tile);
    for (const i of t.items || []) {
      if (!i.indicator) continue;
      if (i.indicator.program?.id) programs.add(i.indicator.program.id);
      for (const f of dataCheckIndicatorFields(i.indicator)) noteField(f, t.tile, i.id);
    }
  }
  // Indicators not on any tile yet: what they read is still worth saying.
  if (!tiles.length && (targets.indicators || []).length) {
    const r = await safeDhis2Fetch(`programIndicators?filter=id:in:[${targets.indicators.join(',')}]&paging=false&fields=id,displayName,expression,filter,program[id]`);
    for (const pi of r?.programIndicators || []) {
      if (pi.program?.id) programs.add(pi.program.id);
      for (const f of dataCheckIndicatorFields(pi)) noteField(f, pi.displayName || pi.id, pi.id);
    }
  }

  const fieldList = [...fields.values()].slice(0, DATA_CHECK_MAX_FIELDS);
  const coverage = await dataCheckPool(fieldList, dataCheckFieldCoverage);
  fieldList.forEach((f, i) => { f.coverage = coverage[i] || { state: 'unknown' }; });

  // Readable field and stage names.
  const contexts = new Map();
  await dataCheckPool([...new Set(fieldList.map(f => f.programId))], async (pid) => {
    const c = await dataCheckCached(`names:${pid}`, () => loadLineListProgramContext(pid));
    if (c && !c._error) contexts.set(pid, c);
  });
  for (const f of fieldList) {
    const c = contexts.get(f.programId);
    if (!c) continue;
    if (f.kind === 'tea') f.name = c.teas?.get(f.id)?.name || f.name;
    else { f.name = c.des?.get(f.id)?.name || f.name; f.stage = c.stagesById?.get(f.stageId)?.name || null; }
  }

  const analytics = await dataCheckPool([...programs], async (pid) => ({ programId: pid, ...(await dataCheckAnalyticsState(pid) || { state: 'unknown' }), program: contexts.get(pid)?.program?.name || null }));

  return dataCheckAssemble(tiles, fieldList, analytics.filter(Boolean));
}

function dataCheckAssemble(tiles, fieldList, analytics) {
  const hideNumbers = !!dhis2.metadataOnlyTurn;
  const fieldLabel = (f) => `${f.name || f.id}${f.stage ? ` (${f.stage})` : ''}`;
  const usedBy = (f) => [...f.used_by];
  const noValue = fieldList.filter(f => f.coverage.state === 'none' || f.coverage.state === 'no_records');
  const few = fieldList.filter(f => f.coverage.state === 'few');
  const emptyFieldsOf = (itemId) => noValue.filter(f => f.indicators.has(itemId));

  const causeOf = (t) => [...new Set((t.empty_items || []).flatMap(i => emptyFieldsOf(i.id)).map(fieldLabel))];

  const emptyTiles = tiles.filter(t => t.state === 'empty');
  const partly = tiles.filter(t => t.state === 'partly_empty');
  const failed = tiles.filter(t => t.state === 'failed');
  const zeroTiles = emptyTiles.filter(t => t.type === 'SINGLE_VALUE');
  const zeroUnrecorded = zeroTiles.filter(t => causeOf(t).length).map(t => t.tile);
  const zeroOther = zeroTiles.filter(t => !causeOf(t).length).map(t => t.tile);

  const check = {
    what_was_read: 'Counts only: no patient values were read.',
    tiles: { total: tiles.length, with_data: tiles.filter(t => t.state === 'ok').length },
    ...(emptyTiles.length ? { empty_tiles: emptyTiles.map(t => ({ tile: t.tile, type: t.type, ...(causeOf(t).length ? { because_no_values_in: causeOf(t) } : {}) })) } : {}),
    ...(partly.length ? { partly_empty_tiles: partly.map(t => ({ tile: t.tile, type: t.type, empty_items: t.empty_items.map(i => i.name), ...(causeOf(t).length ? { because_no_values_in: causeOf(t) } : {}) })) } : {}),
    ...(failed.length ? { failed_tiles: failed.map(t => ({ tile: t.tile, type: t.type, error: t.error })) } : {}),
    ...(zeroUnrecorded.length ? { single_values_showing_0_for_nothing_recorded: zeroUnrecorded } : {}),
    ...(zeroOther.length ? { single_values_showing_0_for_no_data: zeroOther } : {}),
    ...(noValue.length ? { fields_without_values: noValue.map(f => ({ field: fieldLabel(f), used_by: usedBy(f), ...(f.coverage.state === 'no_records' ? { stage_has_no_records: true, stage: f.stage || null } : {}), ...(hideNumbers ? {} : { records: f.coverage.total }) })) } : {}),
    ...(few.length ? { fields_rarely_filled: few.map(f => ({ field: fieldLabel(f), used_by: usedBy(f), ...(hideNumbers ? {} : { with_values: f.coverage.with_values, records: f.coverage.total }) })) } : {}),
  };
  const notOk = analytics.filter(a => ['empty', 'behind', 'missing'].includes(a.state));
  if (notOk.length) {
    check.analytics_tables = notOk.map(a => ({
      program: a.program || a.programId,
      state: a.state,
      ...(hideNumbers ? {} : { records_live: a.live, ...(a.held != null ? { records_in_tables: a.held } : {}) }),
      ...(a.last_run ? { last_run_finished: a.last_run } : {}),
      ...(a.cache_strategy && a.cache_strategy !== 'NO_CACHE' ? { browser_cache: a.cache_strategy } : {}),
    }));
  }
  check.report_lines = dataCheckReportLines(check, notOk);
  if (check.report_lines.length) check._note = DATA_CHECK_MODEL_NOTE;
  return check;
}

// The findings as the user reads them.
function dataCheckReportLines(check, analyticsNotOk = []) {
  const lines = [];
  const quoted = (names) => names.map(n => `"${n}"`).join(', ');
  const hide = !!dhis2.metadataOnlyTurn;
  for (const a of analyticsNotOk) {
    const scope = a.program ? `${a.program}: ` : '';
    const counts = hide ? '' : ` (${a.held ?? 0} of ${a.live} records)`;
    const lastRun = a.last_run ? ` The last run finished at ${a.last_run}.` : '';
    const cacheNote = a.cache_strategy && a.cache_strategy !== 'NO_CACHE'
      ? ` This server also lets browsers keep analytics answers (${a.cache_strategy}), so a tile opened before the run can keep its old numbers afterwards: use a private window or clear this site's cached files.`
      : '';
    if (a.state === 'missing') lines.push(`**Analytics tables:** ${scope}the tables for this program do not exist yet, so every tile on it stays empty until an Analytics Tables run finishes (Data Administration).${lastRun}`);
    else if (a.state === 'empty') lines.push(`**Analytics tables:** ${scope}they hold none of this program's records right now, although the records exist${hide ? '' : ` (${a.live})`}. Tiles show 0 or "No data" until an Analytics Tables run finishes, and the columns from stages stay blank in an enrollment table. The saved items are not at fault.${lastRun}${cacheNote}`);
    else lines.push(`**Analytics tables:** ${scope}they hold only part of this program's records${counts}, so tiles show too little until an Analytics Tables run finishes.${lastRun}${cacheNote}`);
  }
  // A new program has no records anywhere: one line, not one per field.
  const noRecordStages = [...new Set((check.fields_without_values || []).filter(f => f.stage_has_no_records).map(f => f.stage || 'this program'))];
  if (noRecordStages.length) lines.push(`**No records yet:** ${noRecordStages.join(', ')}. Tiles that read them stay empty until data is entered.`);
  for (const f of (check.fields_without_values || []).filter(x => !x.stage_has_no_records)) {
    const tiles = f.used_by.length ? `, so ${quoted(f.used_by.slice(0, 8))}${f.used_by.length > 8 ? ` and ${f.used_by.length - 8} more` : ''} cannot show it` : '';
    lines.push(`**${f.field}:** no record on this server has a value${hide ? '' : ` (0 of ${f.records})`}${tiles}. The tile is set up correctly; there is nothing to show until this is recorded.`);
  }
  for (const f of check.fields_rarely_filled || []) {
    lines.push(`**${f.field}:** filled on ${hide ? 'very few records' : `only ${f.with_values} of ${f.records} records`}, so it is blank on almost every row of ${quoted(f.used_by.slice(0, 4))}.`);
  }
  const verb = (list) => (list.length === 1 ? 'shows' : 'show');
  if ((check.single_values_showing_0_for_nothing_recorded || []).length) {
    const list = check.single_values_showing_0_for_nothing_recorded;
    lines.push(`${quoted(list)} ${verb(list)} 0 because nothing is recorded. DHIS2 draws "no data" as 0 on a single-value tile, so read it as "no data", not as a real zero.`);
  }
  if ((check.single_values_showing_0_for_no_data || []).length) {
    const list = check.single_values_showing_0_for_no_data;
    const why = analyticsNotOk.length ? 'only because of the analytics tables above, not because the records are missing' : 'because nothing matches their saved period and places';
    lines.push(`${quoted(list)} ${verb(list)} 0 ${why}. DHIS2 draws "no data" as 0 on a single-value tile, so read it as "no data", not as a real zero.`);
  }
  for (const t of check.failed_tiles || []) lines.push(`"${t.tile}" did not load in this check: ${t.error}`);
  const explained = (check.fields_without_values || []).length > 0 || analyticsNotOk.length > 0;
  const unexplained = (check.empty_tiles || []).filter(t => !t.because_no_values_in && !explained);
  if (unexplained.length) lines.push(`${quoted(unexplained.map(t => t.tile))}: no values for the saved periods and places.`);
  return lines;
}

// Never let the check cost a tool its result.
async function dataCheckWithin(promise, ms = DATA_CHECK_BUDGET_MS) {
  let timer;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

// A tool's result block: only what the model needs, nothing when all is well.
async function dataCheckForResult(targets) {
  const check = await dataCheckWithin(runDataCheck(targets));
  if (!check) return null;
  if (!check.tiles.total && !check.report_lines.length) return null;
  const clean = !check.report_lines.length && !check.empty_tiles && !check.partly_empty_tiles && !check.failed_tiles;
  return clean ? { tiles: check.tiles, what_was_read: check.what_was_read } : check;
}

// ── Per turn ─────────────────────────────────────────────────────────────────
// What this turn saved, so the turn can end with one check of the finished work
// (the last changes in the thread came after the model's last read-back).
function noteDataCheckTarget(toolName, args, result) {
  if (!result || typeof result !== 'object' || result._error || result.dry_run || result.success === false) return;
  const st = dhis2.turnDataCheck || (dhis2.turnDataCheck = { dashboards: new Set(), visualizations: new Set(), maps: new Set(), lineLists: new Set(), indicators: new Set(), urls: new Map() });
  const action = String(args?.action || '');
  const addId = (set, id) => { if (typeof id === 'string' && id) set.add(id); };
  if (toolName === 'manage_dashboards') {
    if (action === 'delete') { st.dashboards.delete(args?.dashboard_id); st.urls.delete(args?.dashboard_id); return; }
    if (['create_dashboard', 'add_items', 'arrange', 'remove_item', 'update'].includes(action)) {
      const id = result.dashboard_id || args?.dashboard_id;
      addId(st.dashboards, id);
      if (id && result.dashboard_url) st.urls.set(id, result.dashboard_url);
    } else if (action === 'create_visualization') addId(st.visualizations, result.visualization_id);
  } else if (toolName === 'manage_maps') {
    if (action === 'delete') st.maps.delete(args?.map_id); else if (action === 'create') addId(st.maps, result.map_id);
  } else if (toolName === 'manage_line_lists') {
    if (action === 'delete') st.lineLists.delete(args?.line_list_id);
    else if (action === 'create' || action === 'update') addId(st.lineLists, result.line_list_id);
  } else if (toolName === 'manage_program_indicators' && /^create|^update/.test(action)) {
    for (const id of Array.isArray(result.program_indicator_ids) ? result.program_indicator_ids : []) addId(st.indicators, id);
    addId(st.indicators, result.program_indicator_id);
  }
}

// What goes under the model's final answer: the findings, and the dashboard link
// if the answer does not carry the right one. A thread's answer first gave a made-up
// link, then corrected itself in brackets.
async function finishTurnDataCheck(finalText) {
  const st = dhis2.turnDataCheck;
  if (!st) return '';
  const targets = {
    dashboards: [...st.dashboards], visualizations: [...st.visualizations], maps: [...st.maps],
    lineLists: [...st.lineLists], indicators: [...st.indicators],
  };
  dhis2.turnDataCheck = null;
  if (!Object.values(targets).some(list => list.length)) return '';
  const check = await dataCheckWithin(runDataCheck(targets));
  const parts = [];
  const missingLinks = [...st.urls.values()].filter(u => !String(finalText || '').includes(u));
  if (missingLinks.length) parts.push(missingLinks.map(u => `**Dashboard link:** ${u}`).join('\n'));
  const lines = check?.report_lines || [];
  if (lines.length) parts.push(`**Data check** (counted by the extension after saving; no patient values were read):\n${lines.map(l => `- ${l}`).join('\n')}`);
  return parts.length ? `\n\n---\n${parts.join('\n\n')}` : '';
}
