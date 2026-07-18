// ── manage_line_lists: DHIS2 Line Listing authoring (eventVisualizations, type LINE_LIST) ──
//
// Creates/inspects/updates/deletes the saved line lists shown in the Line
// Listing app, and validates them by running the SAME analytics query the app
// would issue. Everything the model passes is resolved and verified against
// the program's real metadata BEFORE any write:
//   - dimension ids/names → DE / TEA / PI (stage auto-resolved for DEs)
//   - filter values on option-set dims → option CODES (names auto-mapped)
//   - boolean filters → 1/0 (analytics stores booleans numerically)
//   - repetition only on repeatable stages in ENROLLMENT output
//   - program indicators: analyticsType must match the output type, and
//     division expressions are refused as line-list columns (a per-row zero
//     denominator 409s the WHOLE query at runtime — the classic trap)
// The analytics probe never returns row-level values — only row_count and
// column headers — so no patient data ever reaches a remote model provider.

const LINE_LIST_OUTPUT_TYPES = Object.freeze({
  EVENT: 'EVENT',
  ENROLLMENT: 'ENROLLMENT',
  TRACKED_ENTITY: 'TRACKED_ENTITY_INSTANCE',
  TRACKED_ENTITY_INSTANCE: 'TRACKED_ENTITY_INSTANCE',
  TEI: 'TRACKED_ENTITY_INSTANCE',
});

// Time-dimension keywords per output type. Keys are the canonical saved
// dimension ids; values are the accepted spellings.
const LINE_LIST_TIME_DIMENSIONS = Object.freeze({
  EVENT: {
    eventDate: ['event_date', 'eventdate', 'event date', 'occurred', 'occurred_date', 'report_date'],
    enrollmentDate: ['enrollment_date', 'enrollmentdate', 'enrollment date', 'enrolment_date'],
    incidentDate: ['incident_date', 'incidentdate', 'incident date'],
    scheduledDate: ['scheduled_date', 'scheduleddate', 'scheduled date', 'due_date'],
    lastUpdated: ['last_updated', 'lastupdated', 'last updated'],
  },
  ENROLLMENT: {
    enrollmentDate: ['enrollment_date', 'enrollmentdate', 'enrollment date', 'enrolment_date'],
    incidentDate: ['incident_date', 'incidentdate', 'incident date'],
    lastUpdated: ['last_updated', 'lastupdated', 'last updated'],
  },
  TRACKED_ENTITY_INSTANCE: {
    createdDate: ['created', 'created_date', 'registration_date', 'createddate'],
    lastUpdated: ['last_updated', 'lastupdated', 'last updated'],
  },
});

const LINE_LIST_RELATIVE_PERIODS = new Set([
  'TODAY', 'YESTERDAY', 'LAST_3_DAYS', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS',
  'LAST_60_DAYS', 'LAST_90_DAYS', 'LAST_180_DAYS',
  'THIS_WEEK', 'LAST_WEEK', 'LAST_4_WEEKS', 'LAST_12_WEEKS', 'LAST_52_WEEKS',
  'THIS_BIWEEK', 'LAST_BIWEEK', 'LAST_4_BIWEEKS',
  'THIS_MONTH', 'LAST_MONTH', 'LAST_3_MONTHS', 'LAST_6_MONTHS', 'LAST_12_MONTHS',
  'MONTHS_THIS_YEAR',
  'THIS_BIMONTH', 'LAST_BIMONTH', 'LAST_6_BIMONTHS',
  'THIS_QUARTER', 'LAST_QUARTER', 'LAST_4_QUARTERS', 'QUARTERS_THIS_YEAR',
  'THIS_SIX_MONTH', 'LAST_SIX_MONTH', 'LAST_2_SIXMONTHS',
  'THIS_YEAR', 'LAST_YEAR', 'LAST_5_YEARS', 'LAST_10_YEARS',
  'THIS_FINANCIAL_YEAR', 'LAST_FINANCIAL_YEAR', 'LAST_5_FINANCIAL_YEARS',
]);

// Fixed-period ISO ids: daily 20260115, weekly 2026W3, monthly 202601,
// bimonthly 202601B, quarterly 2026Q1, sixmonthly 2026S1, yearly 2026,
// financial-year 2026July etc.
const LINE_LIST_FIXED_PERIOD_RE = /^\d{4}(?:\d{2}(?:\d{2})?|W\d{1,2}|B\d?|Q[1-4]|S[1-2]|July|April|Oct|Nov)?$/;

const LINE_LIST_OU_KEYWORD_RE = /^(USER_ORGUNIT|USER_ORGUNIT_CHILDREN|USER_ORGUNIT_GRANDCHILDREN|LEVEL-\d{1,2}|OU_GROUP-[A-Za-z][A-Za-z0-9]{10})$/;

const LINE_LIST_EVENT_STATUSES = new Set(['ACTIVE', 'COMPLETED', 'SCHEDULE', 'OVERDUE', 'SKIPPED', 'VISITED']);
const LINE_LIST_PROGRAM_STATUSES = new Set(['ACTIVE', 'COMPLETED', 'CANCELLED']);

const LINE_LIST_NUMERIC_VALUE_TYPES = new Set([
  'NUMBER', 'INTEGER', 'INTEGER_POSITIVE', 'INTEGER_NEGATIVE', 'INTEGER_ZERO_OR_POSITIVE',
  'PERCENTAGE', 'UNIT_INTERVAL', 'AGE',
]);
const LINE_LIST_NUMERIC_OPS = new Set(['EQ', 'NE', 'GT', 'GE', 'LT', 'LE', 'IN']);
const LINE_LIST_TEXT_OPS = new Set(['EQ', 'NE', 'IN', 'LIKE', 'NLIKE']);

function lineListCanonOp(op) {
  const map = {
    'EQ': 'EQ', '=': 'EQ', '==': 'EQ', 'EQUALS': 'EQ',
    'NE': 'NE', '!=': 'NE', '<>': 'NE', 'NOT_EQUAL': 'NE',
    'GT': 'GT', '>': 'GT', 'GE': 'GE', '>=': 'GE',
    'LT': 'LT', '<': 'LT', 'LE': 'LE', '<=': 'LE',
    'IN': 'IN', 'LIKE': 'LIKE', 'CONTAINS': 'LIKE', 'NLIKE': 'NLIKE', 'NOT_CONTAINS': 'NLIKE',
  };
  return map[String(op || '').trim().toUpperCase()] || null;
}

// ── Program context loader ───────────────────────────────────────────────────
// Two reads: the program (stages + PSDEs + TEAs) and its program indicators.
// Everything create/update resolves against comes from here — the model can
// never smuggle an invented UID into a saved line list.
async function loadLineListProgramContext(programId) {
  const progResp = await safeDhis2Fetch(
    `programs/${programId}?fields=id,displayName,programType,trackedEntityType%5Bid,displayName%5D,`
    + `programStages%5Bid,displayName,repeatable,programStageDataElements%5BdataElement%5Bid,displayName,valueType,optionSet%5Bid%5D%5D%5D%5D,`
    + `programTrackedEntityAttributes%5BtrackedEntityAttribute%5Bid,displayName,valueType,optionSet%5Bid%5D%5D%5D`
  );
  if (progResp?._status === 404) return { _error: `Program "${programId}" does not exist (404).`, _hint: 'Resolve the program UID with search_metadata(object_type="programs") first.' };
  if (progResp?._error) return { _error: `Could not load program ${programId}: ${progResp._error}` };

  const piResp = await safeDhis2Fetch(
    `programIndicators?filter=program.id:eq:${programId}&fields=id,displayName,analyticsType,aggregationType,expression&pageSize=200`
  );
  if (piResp?._error) return { _error: `Could not load program indicators for ${programId}: ${piResp._error}` };

  const ctx = {
    program: { id: progResp.id, name: progResp.displayName, programType: progResp.programType },
    trackedEntityType: progResp.trackedEntityType || null,
    stages: [], stagesById: new Map(), stagesByName: new Map(),
    des: new Map(),            // deId → { id, name, valueType, optionSetId, stageIds: [] }
    deByName: new Map(),       // lower(name) → deId (null when ambiguous across DEs)
    teas: new Map(),           // teaId → { id, name, valueType, optionSetId }
    teaByName: new Map(),
    pis: new Map(),            // piId → { id, name, analyticsType, expression }
    piByName: new Map(),
  };
  for (const st of progResp.programStages || []) {
    const stage = { id: st.id, name: st.displayName, repeatable: !!st.repeatable, deIds: [] };
    ctx.stages.push(stage);
    ctx.stagesById.set(st.id, stage);
    ctx.stagesByName.set(lowercaseText(st.displayName), stage);
    for (const psde of st.programStageDataElements || []) {
      const de = psde.dataElement;
      if (!de) continue;
      stage.deIds.push(de.id);
      let entry = ctx.des.get(de.id);
      if (!entry) {
        entry = { id: de.id, name: de.displayName, valueType: de.valueType, optionSetId: de.optionSet?.id || null, stageIds: [] };
        ctx.des.set(de.id, entry);
        const key = lowercaseText(de.displayName);
        ctx.deByName.set(key, ctx.deByName.has(key) ? null : de.id);
      }
      entry.stageIds.push(st.id);
    }
  }
  for (const pta of progResp.programTrackedEntityAttributes || []) {
    const tea = pta.trackedEntityAttribute;
    if (!tea) continue;
    ctx.teas.set(tea.id, { id: tea.id, name: tea.displayName, valueType: tea.valueType, optionSetId: tea.optionSet?.id || null });
    ctx.teaByName.set(lowercaseText(tea.displayName), tea.id);
  }
  for (const pi of piResp.programIndicators || []) {
    ctx.pis.set(pi.id, { id: pi.id, name: pi.displayName, analyticsType: pi.analyticsType, aggregationType: pi.aggregationType, expression: pi.expression || '' });
    ctx.piByName.set(lowercaseText(pi.displayName), pi.id);
  }
  return ctx;
}

// Resolve one option-set's codes once per create/update; caches within the call.
async function lineListLoadOptionCodes(optionSetId, cache) {
  if (cache.has(optionSetId)) return cache.get(optionSetId);
  const resp = await safeDhis2Fetch(`optionSets/${optionSetId}?fields=id,options%5Bcode,displayName%5D`);
  if (resp?._error) return { _error: `Could not load option set ${optionSetId}: ${resp._error}` };
  const byCode = new Map(); const byName = new Map();
  for (const o of resp.options || []) {
    byCode.set(String(o.code), o.code);
    byName.set(lowercaseText(o.displayName), o.code);
  }
  const entry = { byCode, byName, codes: [...byCode.keys()] };
  cache.set(optionSetId, entry);
  return entry;
}

// Normalize a caller filter (string "IN:A;B" / "GT:50" or object
// { operator, value | values }) into a DHIS2 analytics filter string, validated
// against the target's valueType (+ option codes when applicable).
async function lineListNormalizeFilter(rawFilter, target, optionCache) {
  let pairs = [];
  if (typeof rawFilter === 'string' && rawFilter.trim()) {
    // A raw pre-encoded string like "GT:50:LT:100" or "IN:A;B".
    const parts = rawFilter.split(':');
    for (let i = 0; i < parts.length; i += 2) {
      const op = lineListCanonOp(parts[i]);
      if (!op || parts[i + 1] === undefined) {
        return { _error: `Unparseable filter "${rawFilter}" on "${target.name}". Use "OP:value" pairs (e.g. "GT:50", "IN:CODE_A;CODE_B") or the object form { operator, value | values }.` };
      }
      pairs.push({ op, value: parts[i + 1] });
    }
  } else if (rawFilter && typeof rawFilter === 'object') {
    const conditions = Array.isArray(rawFilter.conditions) ? rawFilter.conditions : [rawFilter];
    for (const c of conditions) {
      const op = lineListCanonOp(c.operator || c.op);
      if (!op) return { _error: `Unknown filter operator "${c.operator || c.op}" on "${target.name}". Supported: EQ, NE, GT, GE, LT, LE, IN, LIKE, NLIKE.` };
      const values = Array.isArray(c.values) ? c.values : (c.value !== undefined ? [c.value] : []);
      if (!values.length) return { _error: `Filter on "${target.name}" has operator ${op} but no value/values.` };
      pairs.push({ op, value: values.map(v => String(v)).join(';') });
    }
  } else {
    return { filter: null };
  }

  const vt = target.valueType || 'NUMBER'; // program indicators are numeric
  const isNumeric = target.kind === 'pi' || LINE_LIST_NUMERIC_VALUE_TYPES.has(vt);
  const isBoolean = vt === 'BOOLEAN' || vt === 'TRUE_ONLY';
  const isOptionSet = !!target.optionSetId;

  const out = [];
  for (const { op, value } of pairs) {
    if (isOptionSet) {
      if (op !== 'IN' && op !== 'EQ' && op !== 'NE') {
        return { _error: `"${target.name}" is an option-set dimension — filter it with IN (one or more option codes), not ${op}.` };
      }
      const codes = await lineListLoadOptionCodes(target.optionSetId, optionCache);
      if (codes._error) return codes;
      const mapped = [];
      for (const v of String(value).split(';')) {
        const code = codes.byCode.get(v) ?? codes.byName.get(lowercaseText(v));
        if (code === undefined) {
          return { _error: `"${v}" is not an option of "${target.name}". Valid codes: ${codes.codes.join(', ')}`, _hint: 'Pass option CODES (or exact option names — they are auto-mapped to codes).' };
        }
        mapped.push(code);
      }
      out.push(`${op === 'NE' ? 'NE' : 'IN'}:${mapped.join(';')}`);
    } else if (isBoolean) {
      const mapped = String(value).split(';').map(v => {
        const s = lowercaseText(String(v)).trim();
        if (['true', 'yes', '1'].includes(s)) return '1';
        if (['false', 'no', '0'].includes(s)) return '0';
        return null;
      });
      if (mapped.includes(null)) return { _error: `"${target.name}" is ${vt} — filter values must be true/false (analytics stores them as 1/0).` };
      out.push(`IN:${mapped.join(';')}`);
    } else if (isNumeric) {
      if (!LINE_LIST_NUMERIC_OPS.has(op)) return { _error: `Operator ${op} is not valid for numeric "${target.name}". Use EQ, NE, GT, GE, LT, LE or IN.` };
      const bad = String(value).split(';').find(v => v.trim() === '' || isNaN(Number(v)));
      if (bad !== undefined) return { _error: `Filter value "${bad}" on numeric "${target.name}" is not a number.` };
      out.push(`${op}:${value}`);
    } else {
      if (!LINE_LIST_TEXT_OPS.has(op)) return { _error: `Operator ${op} is not valid for text "${target.name}". Use EQ, NE, IN, LIKE or NLIKE.` };
      out.push(`${op}:${value}`);
    }
  }
  return { filter: out.join(':') };
}

// ── Dimension spec resolution ────────────────────────────────────────────────
// Turns one caller column/filter spec into a fully-resolved internal dimension.
async function lineListResolveDimension(spec, ctx, outputType, optionCache, axis) {
  const raw = typeof spec === 'string' ? { dimension: spec } : (spec || {});
  const dimToken = String(raw.dimension || raw.id || raw.name || '').trim();
  if (!dimToken) return { _error: `A ${axis} entry is missing its "dimension" (pass a keyword like "ou"/"event_date", a UID, or an exact DE/attribute/program-indicator name).` };
  const lower = lowercaseText(dimToken);

  // 1. Org units
  if (['ou', 'org_unit', 'orgunit', 'org_units', 'organisation_unit', 'organisation unit', 'organisation units', 'org unit', 'org units'].includes(lower)) {
    const items = (raw.org_units || raw.items || []).map(v => String(typeof v === 'object' ? v.id : v).trim()).filter(Boolean);
    if (!items.length) return { _error: `The org-unit ${axis} needs org_units[] — UIDs and/or USER_ORGUNIT, USER_ORGUNIT_CHILDREN, LEVEL-<n>, OU_GROUP-<uid>.` };
    const uids = [];
    for (const it of items) {
      if (LINE_LIST_OU_KEYWORD_RE.test(it)) continue;
      if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(it)) { uids.push(it); continue; }
      return { _error: `"${it}" is not a valid org-unit item. Use a UID, USER_ORGUNIT, USER_ORGUNIT_CHILDREN, USER_ORGUNIT_GRANDCHILDREN, LEVEL-<n> or OU_GROUP-<uid>.` };
    }
    if (uids.length) {
      const resp = await safeDhis2Fetch(`organisationUnits?filter=id:in:%5B${uids.join(',')}%5D&fields=id&pageSize=${uids.length}`);
      if (resp?._error) return { _error: `Could not verify org units: ${resp._error}` };
      const found = new Set((resp.organisationUnits || []).map(o => o.id));
      const missing = uids.filter(u => !found.has(u));
      if (missing.length) return { _error: `These org-unit UIDs do not exist: ${missing.join(', ')}.`, _hint: 'Resolve real UIDs with search_metadata(object_type="organisationUnits").' };
    }
    return { kind: 'ou', dimension: 'ou', items, label: 'Organisation unit' };
  }

  // 2. Time dimensions
  const timeDims = LINE_LIST_TIME_DIMENSIONS[outputType] || {};
  for (const [canonical, aliases] of Object.entries(timeDims)) {
    if (canonical === dimToken || aliases.includes(lower)) {
      const periods = (raw.periods || raw.items || []).map(v => String(typeof v === 'object' ? v.id : v).trim()).filter(Boolean);
      if (!periods.length) return { _error: `The ${canonical} ${axis} needs periods[] — relative keywords (e.g. LAST_12_MONTHS, THIS_YEAR) and/or fixed ISO periods (e.g. 202601, 2026Q1).` };
      const norm = [];
      for (const p of periods) {
        const up = p.toUpperCase().replace(/\s+/g, '_');
        if (LINE_LIST_RELATIVE_PERIODS.has(up)) { norm.push(up); continue; }
        if (LINE_LIST_FIXED_PERIOD_RE.test(p)) { norm.push(p); continue; }
        return { _error: `"${p}" is not a recognized period. Relative: ${[...LINE_LIST_RELATIVE_PERIODS].slice(0, 12).join(', ')}, … Fixed ISO: 202601 (month), 2026Q1 (quarter), 2026 (year), 2026W5 (week).` };
      }
      return { kind: 'time', dimension: canonical, items: norm, label: canonical };
    }
  }
  // A time keyword that exists for OTHER output types → targeted guidance.
  for (const [ot, dims] of Object.entries(LINE_LIST_TIME_DIMENSIONS)) {
    if (ot === outputType) continue;
    for (const [canonical, aliases] of Object.entries(dims)) {
      if (canonical === dimToken || aliases.includes(lower)) {
        return { _error: `Time dimension "${dimToken}" is not available for ${outputType} line lists. Available: ${Object.keys(timeDims).join(', ')}.` };
      }
    }
  }

  // 3. Status dimensions
  if (['event_status', 'eventstatus', 'event status'].includes(lower) || ['program_status', 'programstatus', 'program status', 'enrollment_status'].includes(lower)) {
    const isEvent = lower.startsWith('event');
    if (isEvent && outputType !== 'EVENT') return { _error: `event_status is only available on EVENT line lists (this is ${outputType}).` };
    if (outputType === 'TRACKED_ENTITY_INSTANCE') return { _error: 'Status dimensions are not supported on TRACKED_ENTITY line lists.' };
    const dimension = isEvent ? 'eventStatus' : 'programStatus';
    const valid = isEvent ? LINE_LIST_EVENT_STATUSES : LINE_LIST_PROGRAM_STATUSES;
    const statuses = (raw.statuses || raw.items || []).map(v => String(typeof v === 'object' ? v.id : v).trim().toUpperCase()).filter(Boolean);
    if (!statuses.length) return { _error: `The ${dimension} ${axis} needs statuses[] — one or more of: ${[...valid].join(', ')}.` };
    const bad = statuses.filter(s => !valid.has(s));
    if (bad.length) return { _error: `Invalid ${dimension} value(s): ${bad.join(', ')}. Valid: ${[...valid].join(', ')}.` };
    return { kind: 'status', dimension, items: statuses, label: dimension };
  }

  // 4. Data item: UID or exact name → TEA / DE / PI from the program context.
  let target = null;
  if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(dimToken)) {
    if (ctx.teas.has(dimToken)) target = { kind: 'tea', ...ctx.teas.get(dimToken) };
    else if (ctx.des.has(dimToken)) target = { kind: 'de', ...ctx.des.get(dimToken) };
    else if (ctx.pis.has(dimToken)) target = { kind: 'pi', ...ctx.pis.get(dimToken) };
  }
  if (!target) {
    const teaId = ctx.teaByName.get(lower);
    const deId = ctx.deByName.get(lower);
    const piId = ctx.piByName.get(lower);
    if (teaId) target = { kind: 'tea', ...ctx.teas.get(teaId) };
    else if (deId) target = { kind: 'de', ...ctx.des.get(deId) };
    else if (deId === null) return { _error: `Data element name "${dimToken}" is ambiguous in this program (several DEs share it). Pass its UID instead.` };
    else if (piId) target = { kind: 'pi', ...ctx.pis.get(piId) };
  }
  if (!target) {
    const sample = [
      ...[...ctx.teas.values()].slice(0, 6).map(t => `${t.name} (attribute ${t.id})`),
      ...[...ctx.des.values()].slice(0, 6).map(d => `${d.name} (DE ${d.id})`),
      ...[...ctx.pis.values()].slice(0, 4).map(p => `${p.name} (PI ${p.id})`),
    ];
    return {
      _error: `"${dimToken}" is not a dimension of program "${ctx.program.name}" — not an org-unit/time/status keyword, and no attribute, data element or program indicator matches it.`,
      _hint: `Available (sample): ${sample.join('; ')}. Use exact display names or UIDs from get_program_info.`,
    };
  }

  // TEA dims need a WITH_REGISTRATION program.
  if (target.kind === 'tea' && ctx.program.programType !== 'WITH_REGISTRATION') {
    return { _error: `"${target.name}" is a tracked-entity attribute but "${ctx.program.name}" is an event program (no registration).` };
  }

  // DE: resolve the stage.
  let stage = null;
  if (target.kind === 'de') {
    if (outputType === 'TRACKED_ENTITY_INSTANCE') {
      return { _error: `Data element columns are not supported on TRACKED_ENTITY line lists by this tool yet — use attributes, or an ENROLLMENT line list for "${target.name}".` };
    }
    const stageToken = raw.program_stage_id || raw.stage_id || raw.program_stage || raw.stage || null;
    if (stageToken) {
      stage = ctx.stagesById.get(stageToken) || ctx.stagesByName.get(lowercaseText(String(stageToken)));
      if (!stage) return { _error: `Stage "${stageToken}" not found in program "${ctx.program.name}". Stages: ${ctx.stages.map(s => `${s.name} (${s.id})`).join(', ')}.` };
      if (!target.stageIds.includes(stage.id)) return { _error: `Data element "${target.name}" is not in stage "${stage.name}". It belongs to: ${target.stageIds.map(id => ctx.stagesById.get(id)?.name || id).join(', ')}.` };
    } else if (target.stageIds.length === 1) {
      stage = ctx.stagesById.get(target.stageIds[0]);
    } else {
      return { _error: `Data element "${target.name}" appears in ${target.stageIds.length} stages (${target.stageIds.map(id => ctx.stagesById.get(id)?.name || id).join(', ')}) — pass program_stage_id to disambiguate.` };
    }
  }

  // PI: analytics type must match the output type; refuse per-row division traps.
  if (target.kind === 'pi') {
    if (outputType === 'TRACKED_ENTITY_INSTANCE') {
      return { _error: `Program indicators are not supported on TRACKED_ENTITY line lists.` };
    }
    if (target.analyticsType && target.analyticsType !== outputType) {
      return {
        _error: `Program indicator "${target.name}" has analyticsType ${target.analyticsType} and cannot be a column of an ${outputType} line list — the analytics query would reject or mis-count it.`,
        _hint: outputType === 'ENROLLMENT'
          ? 'Use an ENROLLMENT-analytics PI, or create one with manage_program_indicators (e.g. d2:count / d2:countIfValue over the repeatable stage).'
          : 'Use an EVENT-analytics PI, or switch the line list to output_type ENROLLMENT.',
      };
    }
    if (/\//.test(target.expression) && spec?.allow_risky_program_indicator !== true) {
      return {
        _error: `Program indicator "${target.name}" contains a DIVISION (${target.expression.slice(0, 120)}…). In a line list the expression is evaluated PER ROW, so any row where the denominator is 0 makes DHIS2 reject the ENTIRE query with "division by zero" — the line list saves but renders an error.`,
        _hint: 'Rate/percentage PIs belong on aggregate charts, not line-list columns. For per-row columns use count/flag PIs (d2:count, d2:countIfValue, d2:condition returning 1/0, d2:daysBetween). Create one with manage_program_indicators, or — if you are CERTAIN the denominator is never 0 per row — retry with allow_risky_program_indicator:true on this column.',
      };
    }
    // aggregationType shapes the PER-ROW SQL (verified live on 2.42):
    //   NONE  → the generated query is invalid SQL — the whole table 409s.
    //   COUNT → the expression is wrapped in count(...), so EVERY row shows 1
    //           regardless of the d2:count/countIfValue result.
    //   SUM / AVERAGE → the actual per-enrollment value.
    if (target.aggregationType === 'NONE') {
      return {
        _error: `Program indicator "${target.name}" has aggregationType NONE — as a line-list column that generates invalid SQL and DHIS2 rejects the ENTIRE query.`,
        _hint: `Set its aggregation to SUM first: manage_program_indicators(action="update", indicator_id="${target.id}", indicator:{ aggregation_type:"SUM" }), then retry.`,
      };
    }
  }

  // Repetition (repeated events of a repeatable stage; ENROLLMENT output only).
  let repetitionIndexes = null;
  const rep = raw.repetition_indexes || raw.repeated_events || raw.repetition || null;
  if (rep) {
    if (target.kind !== 'de') return { _error: `Repetition is only valid on data-element columns ("${target.name}" is a ${target.kind === 'tea' ? 'tracked-entity attribute' : 'program indicator'}).` };
    if (outputType !== 'ENROLLMENT') return { _error: `Repeated-event columns require output_type ENROLLMENT (this list is ${outputType}). In EVENT output every event is already its own row.` };
    if (!stage.repeatable) return { _error: `Stage "${stage.name}" is not repeatable — repeated-event indexes make no sense for "${target.name}".` };
    if (Array.isArray(rep)) {
      repetitionIndexes = rep.map(Number);
    } else if (Array.isArray(rep.indexes)) {
      repetitionIndexes = rep.indexes.map(Number);
    } else {
      const oldest = Math.max(0, Math.min(Number(rep.oldest) || 0, 10));
      const recent = Math.max(0, Math.min(Number(rep.most_recent) || 0, 10));
      if (!oldest && !recent) return { _error: `repeated_events on "${target.name}" needs { most_recent: n } and/or { oldest: m } (or repetition_indexes:[…]).` };
      repetitionIndexes = [];
      for (let i = 1; i <= oldest; i++) repetitionIndexes.push(i);       // 1 = first, 2 = second, …
      for (let i = recent - 1; i >= 0; i--) repetitionIndexes.push(-i);  // …, -1 = second-latest, 0 = latest
    }
    if (repetitionIndexes.some(n => !Number.isInteger(n))) return { _error: `repetition_indexes on "${target.name}" must be integers (1,2,… = oldest events; 0 = latest, -1 = second-latest …).` };
    repetitionIndexes = [...new Set(repetitionIndexes)];
  }

  // Filter conditions.
  const filterRes = await lineListNormalizeFilter(raw.filter ?? raw.condition ?? raw.conditions ?? null, target, optionCache);
  if (filterRes._error) return filterRes;

  return {
    kind: target.kind,
    dimension: target.id,
    label: target.name,
    valueType: target.kind === 'pi' ? 'NUMBER' : target.valueType,
    stageId: stage ? stage.id : null,
    stageName: stage ? stage.name : null,
    repetitionIndexes,
    filter: filterRes.filter,
    items: [],
  };
}

// Build the saved-payload dimension object for one resolved dim.
function lineListDimensionPayload(dim) {
  const out = { dimension: dim.dimension, items: (dim.items || []).map(id => ({ id })) };
  if (dim.stageId) out.programStage = { id: dim.stageId };
  if (dim.filter) out.filter = dim.filter;
  if (dim.repetitionIndexes && dim.repetitionIndexes.length) out.repetition = { indexes: dim.repetitionIndexes };
  return out;
}

// ── Analytics probe ──────────────────────────────────────────────────────────
// Runs the same query the Line Listing app issues for this layout and returns
// ONLY row_count + headers (never row values — privacy). Filters ride along so
// the probe proves the saved list will actually render.
function lineListBuildProbePath(outputType, programId, tetId, dims, allDims) {
  const parts = [];
  const enc = (s) => String(s).replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  let hasTime = false;
  for (const d of allDims) {
    if (d.kind === 'ou') parts.push(`dimension=ou:${d.items.join(';')}`);
    else if (d.kind === 'time') { hasTime = true; parts.push(`dimension=pe:${d.items.join(';')}`); }
    else if (d.kind === 'status') {
      // Statuses are COMMA-separated query params (not dimensions) on the
      // analytics endpoints — `programStatus=ACTIVE;COMPLETED` is a 400.
      const param = d.dimension === 'eventStatus' ? 'eventStatus' : 'programStatus';
      parts.push(`${param}=${d.items.join(',')}`);
    } else {
      let key = d.dimension;
      if (d.kind === 'de' && outputType === 'ENROLLMENT') key = `${d.stageId}.${d.dimension}`;
      else if (d.kind === 'de' && outputType === 'EVENT') key = `${d.stageId}.${d.dimension}`;
      parts.push(`dimension=${enc(key)}${d.filter ? ':' + enc(d.filter) : ''}`);
    }
  }
  if (outputType === 'EVENT') {
    parts.push('pageSize=1', 'totalPages=true');
    const stageDim = allDims.find(d => d.kind === 'de' && d.stageId);
    if (stageDim) parts.push(`stage=${stageDim.stageId}`);
    return { path: `analytics/events/query/${programId}?${parts.join('&')}`, hasTime };
  }
  if (outputType === 'ENROLLMENT') {
    // ⚠ totalPages=true makes /analytics/enrollments/query fail with an SQL
    // syntax error on 2.42 (server bug) — probe a capped first page instead.
    parts.push('pageSize=100');
    return { path: `analytics/enrollments/query/${programId}?${parts.join('&')}`, hasTime };
  }
  parts.push('pageSize=1', 'totalPages=true');
  parts.push(`program=${programId}`);
  return { path: `analytics/trackedEntities/query/${tetId}?${parts.join('&')}`, hasTime };
}

async function lineListRunProbe(probePath) {
  const resp = await safeDhis2Fetch(probePath);
  if (resp?._error) {
    return { ok: false, error: resp._error, status: resp._status || null };
  }
  // The analytics query endpoints put the pager under metaData (2.40+);
  // fall back to the visible first page when no total is available.
  const rowCount = resp.metaData?.pager?.total
    ?? resp.pager?.total
    ?? (Array.isArray(resp.rows) ? resp.rows.length : 0);
  return {
    ok: true,
    row_count: rowCount,
    headers: (resp.headers || []).map(h => h.column || h.name),
  };
}

// Map a failed probe to targeted guidance without leaking row data.
function lineListDiagnoseProbeError(error, dims) {
  const msg = String(error || '');
  const hints = [];
  if (/division by zero|Expression violation/i.test(msg)) {
    const piDims = dims.filter(d => d.kind === 'pi');
    hints.push(`A program-indicator column fails per-row evaluation${piDims.length ? ` (candidates: ${piDims.map(d => d.label).join(', ')})` : ''}. Replace rate/division PIs with count/flag PIs (see manage_program_indicators).`);
  }
  const badItem = msg.match(/Query item or filter is invalid: `?([^`\s]+)/);
  if (badItem) {
    hints.push(`DHIS2 rejected the dimension/filter "${badItem[1]}". Check the stage qualifier and filter syntax of that column.`);
  }
  if (/At least one period|start and end dates|dimension are not allowed/i.test(msg)) {
    hints.push('Add a time-dimension column/filter with periods[] (e.g. event_date or enrollment_date with LAST_12_MONTHS).');
  }
  return hints;
}

// ── Readable breakdown of a saved line list (for get / list detail) ──────────
function lineListSummarizeSaved(ev) {
  const typed = new Map(); // dimension uid → { name, filter, stage, kind }
  for (const d of ev.dataElementDimensions || []) {
    typed.set(d.dataElement?.id, { kind: 'data_element', name: d.dataElement?.displayName || d.dataElement?.name, filter: d.filter || null, stage: d.programStage?.id || null, value_type: d.dataElement?.valueType });
  }
  for (const d of ev.attributeDimensions || []) {
    typed.set(d.attribute?.id, { kind: 'attribute', name: d.attribute?.displayName || d.attribute?.name, filter: d.filter || null, value_type: d.attribute?.valueType });
  }
  for (const d of ev.programIndicatorDimensions || []) {
    typed.set(d.programIndicator?.id, { kind: 'program_indicator', name: d.programIndicator?.displayName || d.programIndicator?.name, filter: d.filter || null });
  }
  const simple = new Map();
  for (const s of ev.simpleDimensions || []) simple.set(s.dimension, s.values || []);
  const reps = new Map();
  for (const r of ev.repetitions || []) reps.set(r.dimension, r.indexes || []);

  const axis = (list) => (list || []).map(c => {
    const id = c.id || c.dimension;
    if (simple.has(id)) return { dimension: id, items: simple.get(id) };
    const t = typed.get(id);
    if (t) {
      const o = { dimension: id, type: t.kind, name: t.name };
      if (t.stage) o.program_stage_id = t.stage;
      if (t.filter) o.filter = t.filter;
      if (reps.has(id)) o.repetition_indexes = reps.get(id);
      return o;
    }
    return { dimension: id };
  });
  return {
    id: ev.id,
    name: ev.displayName || ev.name,
    description: ev.description || null,
    output_type: ev.outputType,
    program: ev.program ? { id: ev.program.id, name: ev.program.displayName } : null,
    program_stage: ev.programStage ? { id: ev.programStage.id, name: ev.programStage.displayName } : null,
    tracked_entity_type: ev.trackedEntityType?.id || null,
    columns: axis(ev.columns),
    filters: axis(ev.filters),
    sorting: ev.sorting || [],
    legend: ev.legend && ev.legend.set ? { legend_set_id: ev.legend.set.id, style: ev.legend.style, strategy: ev.legend.strategy, show_key: !!ev.legend.showKey } : null,
    last_updated: ev.lastUpdated,
  };
}

const LINE_LIST_GET_FIELDS =
  'id,name,displayName,description,type,outputType,lastUpdated,'
  + 'program%5Bid,displayName%5D,programStage%5Bid,displayName%5D,trackedEntityType%5Bid%5D,'
  + 'columns%5Bid%5D,filters%5Bid%5D,rows%5Bid%5D,sorting,legend,completedOnly,'
  + 'simpleDimensions,repetitions,'
  + 'dataElementDimensions%5BdataElement%5Bid,displayName,valueType%5D,programStage%5Bid%5D,filter%5D,'
  + 'attributeDimensions%5Battribute%5Bid,displayName,valueType%5D,filter%5D,'
  + 'programIndicatorDimensions%5BprogramIndicator%5Bid,displayName%5D,filter%5D';

// Rebuild resolved dims from a SAVED line list so validate/update can re-probe it.
function lineListDimsFromSaved(ev) {
  const summary = lineListSummarizeSaved(ev);
  const toDims = (axis) => axis.map(c => {
    if (c.dimension === 'ou') return { kind: 'ou', dimension: 'ou', items: c.items || [] };
    if (['eventDate', 'enrollmentDate', 'incidentDate', 'scheduledDate', 'lastUpdated', 'createdDate'].includes(c.dimension)) {
      return { kind: 'time', dimension: c.dimension, items: c.items || [] };
    }
    if (c.dimension === 'eventStatus' || c.dimension === 'programStatus') {
      return { kind: 'status', dimension: c.dimension, items: c.items || [] };
    }
    const kind = c.type === 'attribute' ? 'tea' : c.type === 'program_indicator' ? 'pi' : c.type === 'data_element' ? 'de' : 'de';
    return { kind, dimension: c.dimension, label: c.name || c.dimension, stageId: c.program_stage_id || null, filter: c.filter || null, repetitionIndexes: c.repetition_indexes || null, items: [] };
  });
  return { columns: toDims(summary.columns), filters: toDims(summary.filters), summary };
}

// ── Spec → payload assembly shared by create and update ─────────────────────
async function lineListBuildFromSpec(args, { requireName }) {
  const outputTypeRaw = String(args.output_type || args.input_type || 'EVENT').trim().toUpperCase().replace(/\s+/g, '_');
  const outputType = LINE_LIST_OUTPUT_TYPES[outputTypeRaw];
  if (!outputType) {
    return { _error: `Unknown output_type "${args.output_type}". Use EVENT (one row per event), ENROLLMENT (one row per enrollment, cross-stage + repeated events) or TRACKED_ENTITY (one row per person).` };
  }
  if (requireName && (!args.name || !String(args.name).trim())) {
    return { _error: 'Missing required parameter: name (the saved line list title).' };
  }

  // Program resolution — by UID or exact name.
  let programId = args.program_id;
  if (!programId && args.program_name) {
    const resp = await safeDhis2Fetch(`programs?filter=name:ilike:${encodeURIComponent(args.program_name)}&fields=id,displayName&pageSize=10`);
    if (resp?._error) return { _error: `Program lookup failed: ${resp._error}` };
    const exact = (resp.programs || []).filter(p => lowercaseText(p.displayName) === lowercaseText(args.program_name));
    const pick = exact.length === 1 ? exact[0] : ((resp.programs || []).length === 1 ? resp.programs[0] : null);
    if (!pick) return { _error: `Could not uniquely resolve program "${args.program_name}" (${(resp.programs || []).length} matches). Pass program_id.`, matches: (resp.programs || []).map(p => ({ id: p.id, name: p.displayName })) };
    programId = pick.id;
  }
  if (!programId) return { _error: 'program_id (or program_name) is required — a line list is always built on one program.' };

  const ctx = await loadLineListProgramContext(programId);
  if (ctx._error) return ctx;

  // EVENT output on a tracker program needs a stage.
  let stageObj = null;
  if (outputType === 'EVENT') {
    const stageToken = args.program_stage_id || args.program_stage_name || null;
    if (stageToken) {
      stageObj = ctx.stagesById.get(stageToken) || ctx.stagesByName.get(lowercaseText(String(stageToken)));
      if (!stageObj) return { _error: `Stage "${stageToken}" not found in "${ctx.program.name}". Stages: ${ctx.stages.map(s => `${s.name} (${s.id})`).join(', ')}.` };
    } else if (ctx.stages.length === 1) {
      stageObj = ctx.stages[0];
    } else if (ctx.program.programType === 'WITH_REGISTRATION') {
      return { _error: `An EVENT line list on tracker program "${ctx.program.name}" needs program_stage_id — the program has ${ctx.stages.length} stages: ${ctx.stages.map(s => `${s.name} (${s.id})`).join(', ')}.`, _hint: 'Pick the stage whose events become the rows, or use output_type ENROLLMENT for cross-stage rows.' };
    }
  }
  if (outputType === 'TRACKED_ENTITY_INSTANCE' && !ctx.trackedEntityType) {
    return { _error: `Program "${ctx.program.name}" has no tracked entity type — TRACKED_ENTITY output is impossible.` };
  }

  // Resolve every column / filter spec.
  const optionCache = new Map();
  const resolveAxis = async (specs, axis) => {
    const out = [];
    for (const spec of specs || []) {
      const dim = await lineListResolveDimension(spec, ctx, outputType, optionCache, axis);
      if (dim._error) return dim;
      // Default the stage for EVENT lists: a DE column on the selected stage.
      if (dim.kind === 'de' && outputType === 'EVENT') {
        if (stageObj && dim.stageId && dim.stageId !== stageObj.id) {
          return { _error: `Column "${dim.label}" is in stage "${dim.stageName}", but this EVENT line list is on stage "${stageObj.name}". An EVENT list shows ONE stage — move the column, or use output_type ENROLLMENT for cross-stage columns.` };
        }
        if (!dim.stageId && stageObj) dim.stageId = stageObj.id;
      }
      out.push(dim);
    }
    return { dims: out };
  };

  const colRes = await resolveAxis(args.columns, 'column');
  if (colRes._error) return colRes;
  const filtRes = await resolveAxis(args.filters, 'filter');
  if (filtRes._error) return filtRes;
  const columns = colRes.dims, filters = filtRes.dims;

  if (!columns.length) return { _error: 'columns[] is required — at least one column (org unit, time, data element, attribute or program indicator).' };
  const allDims = [...columns, ...filters];
  const dupes = allDims.map(d => d.dimension).filter((v, i, a) => a.indexOf(v) !== i);
  if (dupes.length) return { _error: `Dimension(s) appear more than once across columns+filters: ${[...new Set(dupes)].join(', ')}. Each dimension can appear on ONE axis only.` };

  if (!allDims.some(d => d.kind === 'ou')) {
    return { _error: 'No org-unit dimension. Add a column or filter like { dimension:"ou", org_units:["USER_ORGUNIT"] } — a line list without an org unit boundary cannot run.' };
  }
  const hasTime = allDims.some(d => d.kind === 'time');
  if (!hasTime && outputType !== 'TRACKED_ENTITY_INSTANCE') {
    const timeDims = Object.keys(LINE_LIST_TIME_DIMENSIONS[outputType]);
    return { _error: `No time dimension. An ${outputType} line list needs one (${timeDims.join(', ')}) with periods[] — e.g. { dimension:"${timeDims[0]}", periods:["LAST_12_MONTHS"] }.` };
  }

  // Sorting — every sort dimension must be one of the columns.
  const sorting = [];
  for (const s of args.sorting || args.sort_by || []) {
    const raw = typeof s === 'string' ? { dimension: s, direction: 'DESC' } : (s || {});
    const dir = String(raw.direction || 'DESC').toUpperCase();
    if (dir !== 'ASC' && dir !== 'DESC') return { _error: `Sort direction "${raw.direction}" must be ASC or DESC.` };
    const token = lowercaseText(String(raw.dimension || ''));
    const col = columns.find(c =>
      lowercaseText(c.dimension) === token || lowercaseText(c.label || '') === token
      || (c.kind === 'time' && (LINE_LIST_TIME_DIMENSIONS[outputType][c.dimension] || []).includes(token)));
    if (!col) return { _error: `Sort dimension "${raw.dimension}" is not one of the line list's columns. Sortable: ${columns.map(c => c.label || c.dimension).join(', ')}.` };
    let dimensionKey = col.dimension;
    if (col.kind === 'de' && outputType === 'ENROLLMENT') dimensionKey = `${col.stageId}.${col.dimension}`;
    sorting.push({ dimension: dimensionKey, direction: dir });
  }

  // Legend.
  let legend = null;
  if (args.legend) {
    const style = String(args.legend.style || 'FILL').toUpperCase();
    const strategy = String(args.legend.strategy || (args.legend.legend_set_id || args.legend.legend_set_name ? 'FIXED' : 'BY_DATA_ITEM')).toUpperCase();
    if (!['FILL', 'TEXT'].includes(style)) return { _error: `legend.style "${args.legend.style}" must be FILL (background colour) or TEXT.` };
    if (!['FIXED', 'BY_DATA_ITEM'].includes(strategy)) return { _error: `legend.strategy "${args.legend.strategy}" must be FIXED (one set for the whole list) or BY_DATA_ITEM (each item's own legend set).` };
    legend = { style, strategy, showKey: args.legend.show_key !== false };
    if (strategy === 'FIXED') {
      let lsId = args.legend.legend_set_id;
      if (!lsId && args.legend.legend_set_name) {
        const resp = await safeDhis2Fetch(`legendSets?filter=name:ilike:${encodeURIComponent(args.legend.legend_set_name)}&fields=id,displayName&pageSize=10`);
        if (resp?._error) return { _error: `Legend-set lookup failed: ${resp._error}` };
        const exact = (resp.legendSets || []).filter(l => lowercaseText(l.displayName) === lowercaseText(args.legend.legend_set_name));
        const pick = exact.length === 1 ? exact[0] : ((resp.legendSets || []).length === 1 ? resp.legendSets[0] : null);
        if (!pick) return { _error: `Could not uniquely resolve legend set "${args.legend.legend_set_name}". Create one with manage_legend_sets, or pass legend_set_id.` };
        lsId = pick.id;
      }
      if (!lsId) return { _error: 'legend.strategy FIXED needs legend_set_id (or legend_set_name). Create one with manage_legend_sets(action="create").' };
      const check = await safeDhis2Fetch(`legendSets/${lsId}?fields=id,displayName`);
      if (check?._status === 404) return { _error: `legendSet "${lsId}" does not exist (404).` };
      if (check?._error) return { _error: `Could not verify legend set ${lsId}: ${check._error}` };
      legend.set = { id: lsId };
      // A FIXED legend colours numeric cells; warn (not refuse) if no numeric column exists.
      if (!allDims.some(d => d.kind === 'pi' || LINE_LIST_NUMERIC_VALUE_TYPES.has(d.valueType))) {
        legend._warning = 'No numeric column in this line list — a FIXED legend will have nothing to colour.';
      }
    }
  }

  // Assemble the saved payload. The 2.42 deserializer derives
  // dataElementDimensions / attributeDimensions / programIndicatorDimensions /
  // simpleDimensions / repetitions / relativePeriods from these axes.
  const payload = {
    name: args.name ? String(args.name).trim() : undefined,
    description: args.description ? String(args.description) : undefined,
    type: 'LINE_LIST',
    outputType,
    program: { id: programId },
    columns: columns.map(lineListDimensionPayload),
    filters: filters.map(lineListDimensionPayload),
    rows: [],
  };
  if (stageObj) payload.programStage = { id: stageObj.id };
  if (outputType === 'TRACKED_ENTITY_INSTANCE') payload.trackedEntityType = { id: ctx.trackedEntityType.id };
  if (sorting.length) payload.sorting = sorting;
  if (legend) {
    const { _warning, ...legendClean } = legend;
    payload.legend = legendClean;
  }
  if (args.completed_only === true) payload.completedOnly = true;

  const probe = lineListBuildProbePath(outputType, programId, ctx.trackedEntityType?.id, columns, allDims);

  const warnings = [];
  if (legend && legend._warning) warnings.push(legend._warning);
  for (const d of allDims) {
    if (d.kind !== 'pi') continue;
    const pi = ctx.pis.get(d.dimension);
    if (pi && pi.aggregationType === 'COUNT' && /d2:(count|countifvalue|countifcondition)\s*\(/i.test(pi.expression)) {
      warnings.push(`Program indicator "${pi.name}" uses aggregationType COUNT — in a line list that renders a constant 1 on every row instead of the d2:count result. If it should show the per-case count, change it to SUM: manage_program_indicators(action="update", indicator_id="${pi.id}", indicator:{ aggregation_type:"SUM" }).`);
    }
  }

  return {
    payload, outputType, programId, ctx, stageObj, columns, filters, probe, warnings,
    resolved: {
      program: ctx.program.name,
      program_stage: stageObj ? stageObj.name : null,
      columns: columns.map(d => ({ dimension: d.dimension, name: d.label, stage: d.stageName || undefined, filter: d.filter || undefined, repetition_indexes: d.repetitionIndexes || undefined })),
      filters: filters.map(d => ({ dimension: d.dimension, name: d.label, stage: d.stageName || undefined, filter: d.filter || undefined })),
    },
  };
}

// ── The executor ─────────────────────────────────────────────────────────────
async function executeManageLineLists(args) {
  const action = args?.action;
  if (!action) {
    return { _error: 'Missing required parameter: action', _hint: 'One of: list, get, create, update, delete, validate.' };
  }
  const llId = args.line_list_id || args.event_visualization_id || args.object_id;

  // ── list ──
  if (action === 'list') {
    const filters = ['filter=type:eq:LINE_LIST'];
    if (args.name_filter) filters.push(`filter=name:ilike:${encodeURIComponent(args.name_filter)}`);
    if (args.program_id) filters.push(`filter=program.id:eq:${args.program_id}`);
    const pageSize = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    const resp = await safeDhis2Fetch(
      `eventVisualizations?${filters.join('&')}&fields=id,displayName,outputType,program%5Bid,displayName%5D,lastUpdated&pageSize=${pageSize}&order=lastUpdated:desc`
    );
    if (resp?._error) return { _error: `line list query failed: ${resp._error}` };
    return {
      success: true,
      total: resp.pager?.total ?? (resp.eventVisualizations || []).length,
      line_lists: (resp.eventVisualizations || []).map(ev => ({
        id: ev.id, name: ev.displayName, output_type: ev.outputType,
        program: ev.program?.displayName || null, program_id: ev.program?.id || null,
        last_updated: ev.lastUpdated,
      })),
      _note: 'Line lists live at /api/eventVisualizations (type LINE_LIST) and open in the Line Listing app.',
    };
  }

  // ── get ──
  if (action === 'get') {
    if (!llId) return { _error: 'line_list_id required for get' };
    const resp = await safeDhis2Fetch(`eventVisualizations/${llId}?fields=${LINE_LIST_GET_FIELDS}`);
    if (resp?._status === 404) return { _error: `Line list "${llId}" does not exist (404).` };
    if (resp?._error) return { _error: `Could not load line list ${llId}: ${resp._error}` };
    if (resp.type && resp.type !== 'LINE_LIST') {
      return { _error: `"${resp.displayName}" (${llId}) is an eventVisualization of type ${resp.type}, not a LINE_LIST.` };
    }
    const summary = lineListSummarizeSaved(resp);
    summary.open_url = `${dhis2.baseUrl}/dhis-web-line-listing/index.html#/${llId}`;
    return { success: true, line_list: summary };
  }

  // ── validate ──
  if (action === 'validate') {
    if (!llId) return { _error: 'line_list_id required for validate' };
    const resp = await safeDhis2Fetch(`eventVisualizations/${llId}?fields=${LINE_LIST_GET_FIELDS}`);
    if (resp?._status === 404) return { _error: `Line list "${llId}" does not exist (404).` };
    if (resp?._error) return { _error: `Could not load line list ${llId}: ${resp._error}` };
    const { columns, filters, summary } = lineListDimsFromSaved(resp);
    const allDims = [...columns, ...filters];
    const probe = lineListBuildProbePath(resp.outputType, resp.program?.id, resp.trackedEntityType?.id, columns, allDims);
    const probeRes = await lineListRunProbe(probe.path);
    if (!probeRes.ok) {
      return {
        _error: `Line list "${summary.name}" fails at query time: ${probeRes.error}`,
        diagnosis: lineListDiagnoseProbeError(probeRes.error, allDims),
        line_list: summary,
      };
    }
    return {
      success: true,
      line_list_id: llId,
      name: summary.name,
      row_count: probeRes.row_count,
      headers: probeRes.headers,
      empty: probeRes.row_count === 0,
      _note: probeRes.row_count === 0 ? 'The query is VALID but returns 0 rows — check periods/org units/filters, and whether analytics tables have run since the data was entered.' : undefined,
    };
  }

  // ── create ──
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_line_lists', 'create');
    if (_gate) return _gate;

    const built = await lineListBuildFromSpec(args, { requireName: true });
    if (built._error) return built;

    // Duplicate-name reuse guard: never recreate an existing line list.
    const dup = await safeDhis2Fetch(`eventVisualizations?filter=name:eq:${encodeURIComponent(built.payload.name)}&fields=id,displayName,type&pageSize=2`);
    if (dup?._error) return { _error: `Duplicate-name check failed: ${dup._error}` };
    if ((dup.eventVisualizations || []).length) {
      const ex = dup.eventVisualizations[0];
      return {
        _error: `A saved event visualization named "${built.payload.name}" already exists (${ex.id}).`,
        existing_id: ex.id,
        _hint: 'Use action="update" with line_list_id to change it, action="get" to inspect it, or pick a different name.',
      };
    }

    // Pre-flight probe: prove the layout runs BEFORE saving anything.
    const dataCheck = String(args.data_check || 'warn_empty');
    let probeRes = null;
    if (dataCheck !== 'skip') {
      probeRes = await lineListRunProbe(built.probe.path);
      if (!probeRes.ok) {
        return {
          _error: `Refusing to save "${built.payload.name}" — its analytics query fails, so the Line Listing app would show an error instead of a table: ${probeRes.error}`,
          diagnosis: lineListDiagnoseProbeError(probeRes.error, [...built.columns, ...built.filters]),
          resolved: built.resolved,
          _hint: 'Nothing was created. Fix the reported dimension/filter and retry.',
        };
      }
      if (dataCheck === 'require_rows' && probeRes.row_count === 0) {
        return {
          _error: `Refusing to save "${built.payload.name}" (data_check="require_rows") — the query is valid but returns 0 rows.`,
          resolved: built.resolved,
          _hint: 'Widen the periods/org units/filters, run analytics tables, or retry with data_check="warn_empty" to save it anyway.',
        };
      }
    }

    const postResp = await safeDhis2Fetch('eventVisualizations', { method: 'POST', body: built.payload });
    if (postResp?._error) return { _error: `Failed to save line list: ${postResp._error}`, resolved: built.resolved };
    const newId = postResp?.response?.uid || postResp?.uid;
    if (!newId) return { _error: 'DHIS2 accepted the POST but returned no UID.', raw_status: postResp?.status };
    if (typeof dhis2 !== 'undefined' && dhis2.knownIds) dhis2.knownIds.add(newId);

    const warnings = [...built.warnings];
    if (probeRes && probeRes.row_count === 0) {
      warnings.push('The saved list currently shows 0 rows. If data was entered recently, analytics tables may need a run (Data Administration → Analytics tables).');
    }
    return {
      success: true,
      action: 'create',
      line_list_id: newId,
      name: built.payload.name,
      output_type: built.outputType,
      program: built.resolved.program,
      program_stage: built.resolved.program_stage,
      columns: built.resolved.columns,
      filters: built.resolved.filters,
      sorting: built.payload.sorting || [],
      legend: built.payload.legend || null,
      row_count: probeRes ? probeRes.row_count : null,
      open_url: `${dhis2.baseUrl}/dhis-web-line-listing/index.html#/${newId}`,
      warnings: warnings.length ? warnings : undefined,
      _next_step: 'Place it on a dashboard with manage_dashboards(action="add_items", items:[{ type:"EVENT_VISUALIZATION", event_visualization_id:"' + newId + '" }]) or create_dashboard with the same item type.',
    };
  }

  // ── update ──
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_line_lists', 'update', { line_list_id: llId });
    if (_gate) return _gate;
    if (!llId) return { _error: 'line_list_id required for update' };

    const existing = await safeDhis2Fetch(`eventVisualizations/${llId}?fields=${LINE_LIST_GET_FIELDS},sharing,subscribers`);
    if (existing?._status === 404) return { _error: `Line list "${llId}" does not exist (404).`, _hint: 'Use action="create" for a new one — never invent UIDs.' };
    if (existing?._error) return { _error: `Could not load line list ${llId}: ${existing._error}` };
    if (existing.type && existing.type !== 'LINE_LIST') {
      return { _error: `"${existing.displayName}" (${llId}) is a ${existing.type} event visualization — this tool only updates LINE_LISTs.` };
    }

    const backup = await ensureBackupOrBail(
      { operation: 'update_line_list', tool: 'manage_line_lists', action: 'update', reason: `Update line list ${existing.displayName || llId}` },
      [{ object_type: 'eventVisualizations', object_id: llId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const relayouts = args.columns || args.filters;
    let body, resolved = null, probePath = null, probeDims = null;
    if (relayouts) {
      // Full layout rebuild: same resolution pipeline as create, program fixed
      // to the existing one unless overridden.
      const spec = {
        ...args,
        name: args.name || existing.name || existing.displayName,
        output_type: args.output_type || existing.outputType,
        program_id: args.program_id || existing.program?.id,
        program_stage_id: args.program_stage_id || (String(args.output_type || existing.outputType).toUpperCase() === 'EVENT' ? existing.programStage?.id : undefined),
        columns: args.columns || [],
        filters: args.filters || [],
      };
      const built = await lineListBuildFromSpec(spec, { requireName: true });
      if (built._error) return built;
      body = { ...built.payload, id: llId };
      if (existing.sharing) body.sharing = existing.sharing;
      resolved = built.resolved;
      probePath = built.probe.path;
      probeDims = [...built.columns, ...built.filters];
      if (!args.description && existing.description) body.description = existing.description;
    } else {
      // Own-fields update: keep the saved layout exactly as-is.
      const saved = lineListDimsFromSaved(existing);
      body = {
        id: llId,
        name: args.name || existing.name || existing.displayName,
        description: args.description !== undefined ? args.description : (existing.description || undefined),
        type: 'LINE_LIST',
        outputType: existing.outputType,
        program: existing.program ? { id: existing.program.id } : undefined,
        programStage: existing.programStage ? { id: existing.programStage.id } : undefined,
        trackedEntityType: existing.trackedEntityType ? { id: existing.trackedEntityType.id } : undefined,
        columns: saved.columns.map(lineListDimensionPayload),
        filters: saved.filters.map(lineListDimensionPayload),
        rows: [],
        sorting: args.sorting !== undefined ? args.sorting : (existing.sorting || []),
        legend: existing.legend && existing.legend.set ? existing.legend : undefined,
        completedOnly: args.completed_only !== undefined ? !!args.completed_only : (existing.completedOnly || undefined),
      };
      if (existing.sharing) body.sharing = existing.sharing;
      if (args.legend) {
        const built = await lineListBuildFromSpec({ ...args, program_id: existing.program?.id, output_type: existing.outputType, columns: [{ dimension: 'ou', org_units: ['USER_ORGUNIT'] }], name: 'x' }, { requireName: false });
        if (built._error) return built;
        body.legend = built.payload.legend;
      }
    }

    const putResp = await safeDhis2Fetch(`eventVisualizations/${llId}`, { method: 'PUT', body });
    if (putResp?._error) return { _error: `Failed to update line list: ${putResp._error}`, backup: backup.block };

    let probeRes = null;
    if (probePath && String(args.data_check || 'warn_empty') !== 'skip') {
      probeRes = await lineListRunProbe(probePath);
      if (!probeRes.ok) {
        return {
          success: true,
          action: 'update',
          line_list_id: llId,
          _warning: `The update SAVED, but the new layout fails at query time: ${probeRes.error}`,
          diagnosis: lineListDiagnoseProbeError(probeRes.error, probeDims || []),
          backup: backup.block,
          _hint: 'Restore with manage_backups if needed, or fix the layout with another update.',
        };
      }
    }
    return {
      success: true,
      action: 'update',
      line_list_id: llId,
      name: body.name,
      relayout: !!relayouts,
      resolved: resolved || undefined,
      row_count: probeRes ? probeRes.row_count : undefined,
      backup: backup.block,
    };
  }

  // ── delete ──
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_line_lists', 'delete', { line_list_id: llId });
    if (_gate) return _gate;
    if (!llId) return { _error: 'line_list_id required for delete' };
    const exists = await safeDhis2Fetch(`eventVisualizations/${llId}?fields=id,displayName,type`);
    if (exists?._status === 404) return { _error: `Line list "${llId}" does not exist (404) — nothing to delete.` };
    if (exists?._error) return { _error: `Could not load line list ${llId}: ${exists._error}` };
    const objName = exists.displayName || llId;

    // Dashboards referencing this line list block deletion (the tile would break).
    const refs = await safeDhis2Fetch(`dashboards?filter=dashboardItems.eventVisualization.id:eq:${llId}&fields=id,displayName&pageSize=20`);
    if (refs?._error) return { _error: `Reference check failed: ${refs._error}` };
    if ((refs.dashboards || []).length) {
      return {
        _error: `Cannot delete "${objName}" — ${refs.dashboards.length} dashboard(s) still show it: ${refs.dashboards.map(d => `${d.displayName} (${d.id})`).join(', ')}.`,
        _hint: 'Remove those tiles first with manage_dashboards(action="remove_item"), then retry the delete.',
      };
    }

    const backup = await ensureBackupOrBail(
      { operation: 'delete_line_list', tool: 'manage_line_lists', action: 'delete', reason: `Deleting line list ${objName} (${llId})` },
      [{ object_type: 'eventVisualizations', object_id: llId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const delResp = await safeDhis2Fetch(`eventVisualizations/${llId}`, { method: 'DELETE' });
    if (delResp?._error) return { _error: `Line list deletion failed: ${delResp._error}`, backup: backup.block };
    return { success: true, action: 'delete', deleted: { type: 'eventVisualizations', id: llId, name: objName }, backup: backup.block };
  }

  return { _error: `Unknown manage_line_lists action "${action}".`, _hint: 'One of: list, get, create, update, delete, validate.' };
}
