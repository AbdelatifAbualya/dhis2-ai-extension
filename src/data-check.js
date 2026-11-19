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
    const live = await dataCheckTrackerCount(`tracker/events?program=${programId}&orgUnitMode=CAPTURE&occurredAfter=${y - 5}-01-01&occurredBefore=${y}-12-31&pageSize=1&totalPages=true&fields=event`);
    if (live == null) return { state: 'unknown' };
    if (live === 0) return { state: 'no_records', live };
    // Only a program with records is asked about its analytics table: a program
    // created this turn has none, and the query is a sure 409 E7144 (TB program
    // build, 2026-11-17 — the one failed call of an otherwise clean turn).
    const inTables = await safeDhis2Fetch(`analytics/events/aggregate/${programId}?dimension=pe:THIS_YEAR;LAST_5_YEARS&filter=ou:USER_ORGUNIT`);
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
const DATA_CHECK_DX_FIELDS = 'dataDimensionItemType,programIndicator[id,displayName,expression,filter,aggregationType,analyticsType,program[id],categoryCombo[id,displayName],categoryMappingIds],indicator[id,displayName],dataElement[id,displayName],reportingRate[id,dimensionItem,displayName],dataElementOperand[id,dimensionItem,displayName]';
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

// A record count: its 0 is a real zero once the analytics tables hold the program.
// "Pregnant women with malaria" showed 0 because no case had Pregnant = Yes, and the
// check told the user to read it as "no data, not a real zero" (2026-11-08).
const dataCheckIsCount = (pi) => /^\s*V\{(?:event|enrollment|tei)_count\}\s*$/.test(String(pi?.expression || ''));

function dataCheckItems(dims) {
  return (dims || []).map((d) => {
    // A reporting rate's id is its data set's: the item analytics takes is dimensionItem.
    const o = d.programIndicator || d.indicator || d.dataElement || d.reportingRate || d.dataElementOperand;
    const id = o && (o.dimensionItem || o.id);
    return id ? { id, name: o.displayName || id, indicator: d.programIndicator || null } : null;
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
    pe,
    ou,
  };
}

// Date fields an indicator subtracts (d2:daysBetween and kin) that sit far from
// the record's own period: data entered with the wrong year. Inpatient Outcomes
// thread (2026-11-18): admission/discharge dates were in 2021 on records of
// Aug–Oct 2026; the length-of-stay tile still came out at 14 days and nothing
// said the dates were five years off, and a remote model cannot see them (no
// patient rows). Counts the records in the tile's period and places whose date
// is more than a year before its start or after its end. Counts only.
async function dataCheckDistantDates(tiles) {
  const jobs = new Map();
  for (const t of tiles) {
    for (const i of t.items || []) {
      const pi = i.indicator;
      if (!pi || !pi.program?.id || !t.pe || !t.ou) continue;
      const text = `${pi.expression || ''} ${pi.filter || ''}`;
      for (const call of text.matchAll(/d2:(?:days|weeks|months|years|minutes)Between\s*\(([^()]*)\)/gi)) {
        for (const r of call[1].matchAll(/#\{([A-Za-z][A-Za-z0-9]{10})\.([A-Za-z][A-Za-z0-9]{10})\}/g)) {
          const key = `${pi.program.id}:${r[1]}:${r[2]}`;
          if (!jobs.has(key)) jobs.set(key, { programId: pi.program.id, stage: r[1], de: r[2], indicator: pi.displayName || pi.id, enrollment: String(pi.analyticsType || '').toUpperCase() === 'ENROLLMENT', pe: t.pe, ou: t.ou, tiles: [] });
          jobs.get(key).tiles.push(t.tile);
        }
      }
    }
  }
  const out = [];
  await dataCheckPool([...jobs.values()].slice(0, 4), async (j) => {
    const range = typeof d2PeriodRange === 'function' ? d2PeriodRange(j.pe) : null;
    if (!range) return;
    const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
    const before = shift(range.start, -366);
    const after = shift(range.end, 366);
    const base = j.enrollment
      ? `analytics/enrollments/aggregate/${j.programId}?dimension=pe:${j.pe}&filter=ou:${j.ou}`
      : `analytics/events/aggregate/${j.programId}?stage=${j.stage}&dimension=pe:${j.pe}&filter=ou:${j.ou}&outputType=EVENT`;
    const dim = `${j.stage}.${j.de}`;
    const [all, early, late] = await Promise.all([
      safeDhis2Fetch(`${base}&filter=${dim}:NE:NV`),
      safeDhis2Fetch(`${base}&filter=${dim}:LT:${before}`),
      safeDhis2Fetch(`${base}&filter=${dim}:GT:${after}`),
    ]);
    if ([all, early, late].some((r) => !r || r._error)) return;
    const n = sumAnalyticsValueColumn(all);
    const e = sumAnalyticsValueColumn(early);
    const l = sumAnalyticsValueColumn(late);
    if (!e && !l) return;
    const ctx = await dataCheckCached(`names:${j.programId}`, () => loadLineListProgramContext(j.programId));
    out.push({ field: ctx?.des?.get(j.de)?.name || j.de, indicator: j.indicator, tiles: [...new Set(j.tiles)], records_with_date: n, more_than_a_year_before: e, more_than_a_year_after: l, period: `${range.start} to ${range.end}` });
  });
  return out;
}

// A program indicator with a category combination ("disaggregation") counts a
// record only when it fits one option of every category, by the option filters
// of the program's category mappings. A record with no value in a field those
// filters read fits none, and drops out of the indicator's TOTAL too. Inpatient
// Outcomes thread (2026-11-18): the demo "Inpatient cases" indicator is split by
// "Morbidity Age and Gender", so 3 records without age or sex were missing from
// the total-cases tile (13,799 of 13,802), and the model explained the gap
// wrongly. Counts, per field, the records in the tile's period and places with
// no value — a count, no patient value is read.
async function dataCheckSplitIndicators(tiles) {
  const byPi = new Map();
  for (const t of tiles) {
    for (const i of t.items || []) {
      const pi = i.indicator;
      const cc = pi && pi.categoryCombo;
      if (!pi || !cc || !cc.id || cc.displayName === 'default' || !(pi.categoryMappingIds || []).length || !pi.program?.id) continue;
      if (!byPi.has(pi.id)) byPi.set(pi.id, { pi, tiles: [], pe: t.pe, ou: t.ou });
      byPi.get(pi.id).tiles.push(t.tile);
    }
  }
  const out = [];
  await dataCheckPool([...byPi.values()].slice(0, 6), async ({ pi, tiles: usedBy, pe, ou }) => {
    if (!pe || !ou) return;
    const prog = await dataCheckCached(`catmap:${pi.program.id}`, () => safeDhis2Fetch(`programs/${pi.program.id}?fields=categoryMappings[id,mappingName,optionMappings[filter]]`, { noTruncate: true }));
    const maps = ((prog && prog.categoryMappings) || []).filter((m) => pi.categoryMappingIds.includes(m.id));
    const refs = new Map();
    for (const m of maps) {
      for (const om of m.optionMappings || []) {
        for (const r of String(om.filter || '').matchAll(/#\{([A-Za-z][A-Za-z0-9]{10})\.([A-Za-z][A-Za-z0-9]{10})\}/g)) refs.set(`${r[1]}.${r[2]}`, { stage: r[1], id: r[2], category: m.mappingName });
        for (const r of String(om.filter || '').matchAll(/A\{([A-Za-z][A-Za-z0-9]{10})\}/g)) refs.set(r[1], { stage: null, id: r[1], category: m.mappingName });
      }
    }
    if (!refs.size) return;
    const enrollment = String(pi.analyticsType || '').toUpperCase() === 'ENROLLMENT';
    const ctx = await dataCheckCached(`names:${pi.program.id}`, () => loadLineListProgramContext(pi.program.id));
    const leftOut = [];
    for (const f of refs.values()) {
      const dim = f.stage ? `${f.stage}.${f.id}` : f.id;
      const path = enrollment
        ? `analytics/enrollments/aggregate/${pi.program.id}?dimension=pe:${pe}&filter=ou:${ou}&filter=${dim}:EQ:NV`
        : `analytics/events/aggregate/${pi.program.id}?${f.stage ? `stage=${f.stage}&` : ''}dimension=pe:${pe}&filter=ou:${ou}&filter=${dim}:EQ:NV&outputType=EVENT`;
      const r = await safeDhis2Fetch(path);
      if (!r || r._error) continue;
      const n = sumAnalyticsValueColumn(r);
      const name = (f.stage ? ctx?.des?.get(f.id)?.name : ctx?.teas?.get(f.id)?.name) || f.id;
      leftOut.push({ field: name, category: f.category, records_without_value: n });
    }
    out.push({ indicator: pi.displayName || pi.id, split_by: pi.categoryCombo.displayName, tiles: usedBy, left_out: leftOut });
  });
  return out;
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
  let split = [];
  let distant = [];
  try { [split, distant] = await Promise.all([dataCheckSplitIndicators(tiles), dataCheckDistantDates(tiles)]); } catch { split = split || []; distant = distant || []; }

  return dataCheckAssemble(tiles, fieldList, analytics.filter(Boolean), split, distant);
}

function dataCheckAssemble(tiles, fieldList, analytics, split = [], distant = []) {
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
  const tablesOk = new Set(analytics.filter(a => a.state === 'ok').map(a => a.programId));
  const trueZero = (t) => (t.items || []).length > 0 && t.items.every(i => i.indicator && dataCheckIsCount(i.indicator) && tablesOk.has(i.indicator.program?.id));
  const zeroCounted = zeroTiles.filter(t => !causeOf(t).length && trueZero(t)).map(t => t.tile);
  const zeroOther = zeroTiles.filter(t => !causeOf(t).length && !trueZero(t)).map(t => t.tile);

  const check = {
    what_was_read: 'Counts only: no patient values were read.',
    tiles: { total: tiles.length, with_data: tiles.filter(t => t.state === 'ok').length },
    ...(emptyTiles.length ? { empty_tiles: emptyTiles.map(t => ({ tile: t.tile, type: t.type, ...(causeOf(t).length ? { because_no_values_in: causeOf(t) } : {}) })) } : {}),
    ...(partly.length ? { partly_empty_tiles: partly.map(t => ({ tile: t.tile, type: t.type, empty_items: t.empty_items.map(i => i.name), ...(causeOf(t).length ? { because_no_values_in: causeOf(t) } : {}) })) } : {}),
    ...(failed.length ? { failed_tiles: failed.map(t => ({ tile: t.tile, type: t.type, error: t.error })) } : {}),
    ...(zeroUnrecorded.length ? { single_values_showing_0_for_nothing_recorded: zeroUnrecorded } : {}),
    ...(zeroOther.length ? { single_values_showing_0_for_no_data: zeroOther } : {}),
    ...(zeroCounted.length ? { single_values_true_zero: zeroCounted } : {}),
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
  const splitShown = split.filter((x) => x.left_out.some((l) => l.records_without_value > 0) || hideNumbers);
  if (splitShown.length) {
    check.indicators_leaving_out_records = splitShown.map((x) => ({
      indicator: x.indicator, split_by: x.split_by, tiles: x.tiles,
      left_out: x.left_out.map((l) => ({ field: l.field, ...(hideNumbers ? {} : { records_without_value: l.records_without_value }) })),
    }));
  }
  if (distant.length) {
    check.dates_far_from_period = distant.map((x) => ({
      field: x.field, indicator: x.indicator, tiles: x.tiles, period: x.period,
      ...(hideNumbers ? {} : { records_with_date: x.records_with_date, more_than_a_year_before: x.more_than_a_year_before, more_than_a_year_after: x.more_than_a_year_after }),
    }));
  }
  check.report_lines = dataCheckReportLines(check, notOk);
  if (check.report_lines.length) check._note = DATA_CHECK_MODEL_NOTE;
  if (check.indicators_leaving_out_records) check._split_note = 'An indicator split by a category combination leaves out every record that fits no option (here: no value in the listed fields) — from its total too. If a tile is meant to count ALL records, rebuild it on an indicator without that category combination (manage_program_indicators create, e.g. expression V{event_count}), or say plainly that those records are not in it. Do not explain the gap as a timing or engine difference.';
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
  if ((check.single_values_true_zero || []).length) {
    const list = check.single_values_true_zero;
    lines.push(`${quoted(list)} ${verb(list)} 0: no record in ${list.length === 1 ? 'its' : 'their'} saved period and places matches. The analytics tables hold this program's records, so this is a real count of zero.`);
  }
  for (const x of check.indicators_leaving_out_records || []) {
    const fieldsTxt = x.left_out.map((l) => `${l.field}${hide ? '' : ` (${l.records_without_value})`}`).join(', ');
    lines.push(`**${x.indicator}** (on ${quoted(x.tiles.slice(0, 4))}) is split by "${x.split_by}": a record is counted only when it fits one option of each category, so records with no value in ${fieldsTxt} are left out of its total as well.`);
  }
  for (const x of check.dates_far_from_period || []) {
    const count = hide ? 'Some records' : `${(x.more_than_a_year_before || 0) + (x.more_than_a_year_after || 0)} of ${x.records_with_date} records`;
    lines.push(`**${x.field}** (used by "${x.indicator}"): ${count} in ${x.period} carry a date more than a year ${x.more_than_a_year_after && !x.more_than_a_year_before ? 'after' : x.more_than_a_year_before && !x.more_than_a_year_after ? 'before' : 'away from'} the period, so it is likely entered with the wrong year; "${x.indicator}" is still computed from it. The tiles are placed by the record's own date (event date), not by this field.`);
  }
  for (const t of check.failed_tiles || []) lines.push(`"${t.tile}" did not load in this check: ${t.error}`);
  const explained = (check.fields_without_values || []).length > 0 || analyticsNotOk.length > 0;
  const saidAbove = new Set([...(check.single_values_showing_0_for_no_data || []), ...(check.single_values_true_zero || [])]);
  const unexplained = (check.empty_tiles || []).filter(t => !t.because_no_values_in && !explained && !saidAbove.has(t.tile));
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
  } else if (toolName === 'manage_custom_app' && (action === 'create' || action === 'update') && result.key && result.kind !== 'plugin') {
    // An installed app's link goes under the answer when the answer lacks it
    // (TB Follow-up Workspace, 2026-11-19: "open it from the app menu", no link).
    const url = result.global_shell_url || result.launch_url;
    if (url) st.urls.set(`app:${result.key}`, url);
  } else if (toolName === 'manage_custom_app' && action === 'place' && args?.target === 'dashboard') {
    // A plugin placed on a dashboard: its link goes under the answer too (Malaria
    // focus plugin, 2026-11-18: "share the result" and the answer gave no link).
    const id = result.dashboard?.dashboard_id || result.dashboard_id || args?.dashboard_id;
    const url = result.dashboard?.dashboard_url || (id && dhis2.baseUrl ? `${dhis2.baseUrl}/dhis-web-dashboard/#/${id}` : null);
    if (id && url) st.urls.set(id, url);
  } else if (toolName === 'manage_program_indicators' && /^create|^update/.test(action)) {
    for (const id of Array.isArray(result.program_indicator_ids) ? result.program_indicator_ids : []) addId(st.indicators, id);
    addId(st.indicators, result.program_indicator_id);
  }
}

// Objects saved this turn that are on none of the dashboards this turn built or
// edited. CCR dashboard (Haiku, 2026-11-18): "Missed appointments" was created
// after a failed first try, never added, and the answer listed it as on the
// dashboard. Only when the turn touched a dashboard; at most 12 objects.
async function turnOrphanObjects() {
  const st = dhis2.turnDataCheck;
  if (!st || !st.dashboards || !st.dashboards.size) return [];
  const made = [
    ...[...st.visualizations].map((id) => ({ kind: 'visualization', path: 'visualizations', id })),
    ...[...st.maps].map((id) => ({ kind: 'map', path: 'maps', id })),
    ...[...st.lineLists].map((id) => ({ kind: 'line list', path: 'eventVisualizations', id })),
  ].slice(0, 12);
  if (!made.length) return [];
  const onDash = new Set();
  const dashNames = [];
  for (const dashId of [...st.dashboards].slice(0, 4)) {
    const d = await safeDhis2Fetch(`dashboards/${dashId}?fields=name,dashboardItems[visualization[id],map[id],eventVisualization[id]]`, { noTruncate: true });
    if (!d || d._error) return []; // cannot tell: say nothing
    dashNames.push(d.name || dashId);
    for (const it of d.dashboardItems || []) for (const k of ['visualization', 'map', 'eventVisualization']) if (it[k]?.id) onDash.add(it[k].id);
  }
  const out = [];
  for (const m of made) {
    if (onDash.has(m.id)) continue;
    const o = await safeDhis2Fetch(`${m.path}/${m.id}?fields=id,name`, { noTruncate: true });
    if (!o || o._error) continue; // deleted since, or unreadable
    out.push({ kind: m.kind, id: m.id, name: o.name || m.id });
  }
  return out.length ? [{ dashboards: dashNames }, ...out] : [];
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
  const anyTarget = Object.values(targets).some(list => list.length);
  if (!anyTarget && !st.urls.size) return '';
  const check = anyTarget ? await dataCheckWithin(runDataCheck(targets)) : null;
  const parts = [];
  const said = String(finalText || '');
  const missingLinks = [...st.urls.entries()].filter(([k, u]) => !said.includes(u) && !(k.startsWith('app:') && said.includes(`/apps/${k.slice(4)}`)));
  if (missingLinks.length) parts.push(missingLinks.map(([k, u]) => `**${k.startsWith('app:') ? 'App' : 'Dashboard'} link:** ${u}`).join('\n'));
  const lines = check?.report_lines || [];
  if (lines.length) parts.push(`**Data check** (counted by the extension after saving; no patient values were read):\n${lines.map(l => `- ${l}`).join('\n')}`);
  return parts.length ? `\n\n---\n${parts.join('\n\n')}` : '';
}
