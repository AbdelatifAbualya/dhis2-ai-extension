/*
 * DHIS2 AI Assistant background module: read, analytics, privacy, and central tool-dispatch implementations.
 * Loaded synchronously by background.js with importScripts(); classic-script
 * global bindings intentionally preserve the original service-worker runtime.
 */

// ── Tracker-based count fallback (when analytics tables are not available) ───

async function countViaTracker(pid, ouid, args, progName, ouName, stageName) {
  let endpoint;
  if (args.record_type === 'enrollments') {
    endpoint = 'tracker/enrollments';
  } else if (args.record_type === 'events') {
    endpoint = 'tracker/events';
  } else {
    endpoint = 'tracker/trackedEntities';
  }

  let path = `${endpoint}?program=${pid}&orgUnit=${ouid}&ouMode=SELECTED&totalPages=true&pageSize=1`;
  if (args.include_children) path = path.replace('ouMode=SELECTED', 'ouMode=DESCENDANTS');
  if (args.stage_id && args.record_type === 'events') path += `&programStage=${args.stage_id}`;
  if (args.status) path += `&status=${args.status}`;
  if (args.date_after) {
    if (args.record_type === 'events') path += `&occurredAfter=${args.date_after}`;
    else if (args.record_type === 'enrollments') path += `&enrolledAfter=${args.date_after}`;
  }
  if (args.date_before) {
    if (args.record_type === 'events') path += `&occurredBefore=${args.date_before}`;
    else if (args.record_type === 'enrollments') path += `&enrolledBefore=${args.date_before}`;
  }
  if (args.filters?.length) {
    for (const f of args.filters) path += `&filter=${f}`;
  }

  const result = await safeDhis2Fetch(path);
  if (result._error) return result;

  const total = result.pager?.total ?? result._pagerInfo?.total ?? 0;
  return {
    count: total,
    record_type: args.record_type,
    program: { id: pid, name: progName },
    org_unit: { id: ouid, name: ouName },
    stage: args.record_type === 'events' ? stageName : undefined,
    include_children: !!args.include_children,
    filters_applied: args.filters || [],
    date_range: args.date_after || args.date_before ? { after: args.date_after, before: args.date_before } : undefined,
    _method: 'tracker_fallback',
    _warning: 'Count from tracker API — may include records outside selected org unit if user has broad access.',
  };
}

function parseIsoDate(value) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(later, earlier) {
  if (!later || !earlier) return null;
  return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
}

function truncateTextForTool(value, limit = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function isoToMillis(value) {
  const d = parseIsoDate(value);
  return d ? d.getTime() : null;
}

function isoDateOnly(daysOffset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

function isWithinMillisRange(value, afterMs, beforeMs) {
  const ms = isoToMillis(value);
  if (ms == null) return false;
  if (afterMs != null && ms < afterMs) return false;
  if (beforeMs != null && ms > beforeMs) return false;
  return true;
}

function changeActionFromDates(createdAt, updatedAt, afterMs, fallback = 'updated') {
  const createdMs = isoToMillis(createdAt);
  const updatedMs = isoToMillis(updatedAt);
  if (createdMs != null && afterMs != null && createdMs >= afterMs) return 'created';
  if (createdMs != null && updatedMs != null && createdMs === updatedMs) return 'created';
  return fallback;
}

function summarizeRuleActions(actions) {
  if (!Array.isArray(actions) || !actions.length) return '';
  return actions
    .slice(0, 4)
    .map(a => {
      const target = a?.dataElement?.displayName || a?.trackedEntityAttribute?.displayName || a?.programStage?.displayName || '';
      return target ? `${a.programRuleActionType}:${target}` : `${a.programRuleActionType}`;
    })
    .join(', ');
}

async function resolveProgramForRecentChanges(args, ctxProgramId) {
  if (args.program_id) {
    const exact = await safeDhis2Fetch(`programs/${args.program_id}?fields=id,displayName,programType,lastUpdated`);
    if (exact?._error) return exact;
    return { id: exact.id, displayName: exact.displayName || exact.name || args.program_id, programType: exact.programType || null, lastUpdated: exact.lastUpdated || null };
  }

  if (args.program_name) {
    const resp = await safeDhis2Fetch(
      `programs?filter=displayName:ilike:${encodeURIComponent(args.program_name)}&fields=id,displayName,programType,lastUpdated&pageSize=20`
    );
    if (resp?._error) return resp;
    const programs = Array.isArray(resp.programs) ? resp.programs : [];
    if (!programs.length) return { _error: `No program found matching "${args.program_name}".` };
    const exact = programs.find(p => normalizeTextLoose(p.displayName) === normalizeTextLoose(args.program_name));
    const best = exact || programs[0];
    return {
      id: best.id,
      displayName: best.displayName || best.name || best.id,
      programType: best.programType || null,
      lastUpdated: best.lastUpdated || null,
      _matches: programs.slice(0, 10).map(p => ({ id: p.id, displayName: p.displayName || p.name || p.id })),
    };
  }

  if (ctxProgramId) {
    return {
      id: ctxProgramId,
      displayName: dhis2.programMetadata?.displayName || ctxProgramId,
      programType: dhis2.programMetadata?.programType || null,
      lastUpdated: dhis2.programMetadata?.lastUpdated || null,
    };
  }

  return { _error: 'No program in context. Provide program_id or program_name.' };
}

async function fetchProgramMetadataForRecentChanges(programId) {
  const fields = [
    'id,displayName,programType,created,lastUpdated,createdBy[displayName,username],lastUpdatedBy[displayName,username]',
    'programStages[id,displayName,created,lastUpdated,createdBy[displayName,username],lastUpdatedBy[displayName,username]',
      ',programStageDataElements[id,created,lastUpdated,dataElement[id,displayName,displayFormName,valueType,created,lastUpdated,createdBy[displayName,username],lastUpdatedBy[displayName,username],optionSet[id,displayName]]]]',
    'programTrackedEntityAttributes[id,created,lastUpdated,trackedEntityAttribute[id,displayName,displayFormName,valueType,created,lastUpdated,createdBy[displayName,username],lastUpdatedBy[displayName,username],optionSet[id,displayName]]]',
    'programRuleVariables[id,name,created,lastUpdated,lastUpdatedBy[displayName,username],programStage[id,displayName],dataElement[id,displayName],trackedEntityAttribute[id,displayName]]',
    'programRules[id,name,condition,priority,created,lastUpdated,lastUpdatedBy[displayName,username],programStage[id,displayName],programRuleActions[id,programRuleActionType,data,content,dataElement[id,displayName],programStage[id,displayName],trackedEntityAttribute[id,displayName]]]',
    'programIndicators[id,displayName,expression,filter,created,lastUpdated,lastUpdatedBy[displayName,username]]',
  ].join('');
  return await dhis2Fetch(apiUrl(`programs/${programId}.json?fields=${fields}`));
}

async function detectMetadataAuditSupport() {
  if (dhis2.metadataAuditSupport !== null) return dhis2.metadataAuditSupport;

  const updateCandidates = [
    'metadataAudits?fields=:all&pageSize=1',
    'audits?fields=:all&pageSize=1',
    'audit?fields=:all&pageSize=1',
    'changelog?fields=:all&pageSize=1',
    'changeLogs?fields=:all&pageSize=1',
    'changeLog?fields=:all&pageSize=1',
  ];

  // Probe all candidates in parallel (plus the deletedObjects probe) — first success wins.
  const [candidateResps, deletedObjectsProbe] = await Promise.all([
    Promise.all(updateCandidates.map(p => safeDhis2Fetch(p))),
    safeDhis2Fetch('deletedObjects?pageSize=1&fields=uid,klass,deletedAt,deletedBy'),
  ]);
  let updateAudit = null;
  for (let i = 0; i < updateCandidates.length; i++) {
    if (!candidateResps[i]?._error) {
      updateAudit = { supported: true, path: updateCandidates[i] };
      break;
    }
  }
  const deleteAudit = deletedObjectsProbe?._error
    ? { supported: false, path: 'deletedObjects', reason: deletedObjectsProbe._error }
    : { supported: true, path: 'deletedObjects' };

  dhis2.metadataAuditSupport = {
    supported: !!updateAudit,
    update_logs: updateAudit || {
      supported: false,
      reason: 'No metadata audit/changelog endpoint exposed by this DHIS2 Web API.',
    },
    delete_logs: deleteAudit,
  };
  return dhis2.metadataAuditSupport;
}

async function fetchRecentDeletedObjects(args) {
  const support = await detectMetadataAuditSupport();
  if (!support?.delete_logs?.supported) {
    return { deletions: [], support };
  }

  const daysBack = Number.isFinite(Number(args.days_back)) ? Number(args.days_back) : 30;
  const afterIso = args.updated_after || `${isoDateOnly(-daysBack)}T00:00:00.000`;
  const beforeIso = args.updated_before
    ? `${String(args.updated_before).slice(0, 10)}T23:59:59.999`
    : `${isoDateOnly(0)}T23:59:59.999`;
  const afterMs = isoToMillis(afterIso);
  const beforeMs = isoToMillis(beforeIso);
  const classesOfInterest = new Set([
    'Program',
    'ProgramStage',
    'ProgramStageDataElement',
    'ProgramTrackedEntityAttribute',
    'ProgramRule',
    'ProgramRuleAction',
    'ProgramRuleVariable',
    'ProgramIndicator',
    'DataElement',
    'TrackedEntityAttribute',
    'OptionSet',
    'Option',
  ]);

  const firstPage = await safeDhis2Fetch('deletedObjects?page=1&pageSize=1&fields=uid,klass,deletedAt,deletedBy');
  if (firstPage?._error) return { deletions: [], support, _warning: firstPage._error };
  const pageCount = Number(firstPage.pager?.pageCount || 0);
  if (!pageCount) return { deletions: [], support };

  const maxPages = Math.max(1, Math.min(25, Number(args.max_delete_pages) || 8));
  const pageSize = Math.max(1, Math.min(100, Number(args.delete_page_size) || 50));
  const deletions = [];

  for (let page = pageCount; page > 0 && (pageCount - page) < maxPages; page--) {
    const resp = await safeDhis2Fetch(`deletedObjects?page=${page}&pageSize=${pageSize}&fields=uid,klass,deletedAt,deletedBy`);
    if (resp?._error) {
      return { deletions, support, _warning: resp._error };
    }

    const rows = Array.isArray(resp.deletedObjects) ? resp.deletedObjects : [];
    if (!rows.length) break;

    let olderThanWindow = false;
    for (const row of rows) {
      const ms = isoToMillis(row.deletedAt);
      if (ms == null) continue;
      if (beforeMs != null && ms > beforeMs) continue;
      if (afterMs != null && ms < afterMs) {
        olderThanWindow = true;
        continue;
      }
      if (!classesOfInterest.has(row.klass)) continue;
      deletions.push({
        changed_at: row.deletedAt,
        action: 'deleted',
        object_type: row.klass,
        object_name: row.uid,
        stage_name: null,
        data_element_name: null,
        changed_by: row.deletedBy || null,
        details: `uid=${row.uid}`,
        attribution: 'global_delete_log_only',
      });
    }
    if (olderThanWindow) break;
  }

  deletions.sort((a, b) => String(b.changed_at || '').localeCompare(String(a.changed_at || '')));
  return { deletions, support };
}

function collectRecentProgramChangesFromSnapshot(programMeta, args) {
  const daysBack = Number.isFinite(Number(args.days_back)) ? Number(args.days_back) : 30;
  const afterIso = args.updated_after || `${isoDateOnly(-daysBack)}T00:00:00.000`;
  const beforeIso = args.updated_before
    ? `${String(args.updated_before).slice(0, 10)}T23:59:59.999`
    : `${isoDateOnly(0)}T23:59:59.999`;
  const afterMs = isoToMillis(afterIso);
  const beforeMs = isoToMillis(beforeIso);
  const changes = [];

  const pushChange = change => {
    if (!isWithinMillisRange(change.changed_at, afterMs, beforeMs)) return;
    changes.push(change);
  };

  if (programMeta?.lastUpdated) {
    pushChange({
      changed_at: programMeta.lastUpdated,
      action: changeActionFromDates(programMeta.created, programMeta.lastUpdated, afterMs),
      object_type: 'program',
      object_name: programMeta.displayName || programMeta.id,
      stage_name: null,
      data_element_name: null,
      changed_by: programMeta.lastUpdatedBy?.displayName || programMeta.lastUpdatedBy?.username || null,
      details: `programType=${programMeta.programType || ''}`,
    });
  }

  for (const stage of (programMeta?.programStages || [])) {
    if (stage?.lastUpdated) {
      pushChange({
        changed_at: stage.lastUpdated,
        action: changeActionFromDates(stage.created, stage.lastUpdated, afterMs),
        object_type: 'programStage',
        object_name: stage.displayName || stage.id,
        stage_name: stage.displayName || stage.id,
        data_element_name: null,
        changed_by: stage.lastUpdatedBy?.displayName || stage.lastUpdatedBy?.username || null,
        details: 'Stage metadata changed',
      });
    }

    for (const psde of (stage.programStageDataElements || [])) {
      const de = psde?.dataElement;
      const psdeMs = isoToMillis(psde?.lastUpdated);
      const deMs = isoToMillis(de?.lastUpdated);
      const changedAt = psdeMs != null && deMs != null
        ? (psdeMs > deMs ? psde.lastUpdated : de.lastUpdated)
        : (psde?.lastUpdated || de?.lastUpdated || null);
      if (!changedAt) continue;

      let action = 'updated';
      const psdeCreatedMs = isoToMillis(psde?.created);
      const deCreatedMs = isoToMillis(de?.created);
      if (deCreatedMs != null && afterMs != null && deCreatedMs >= afterMs) action = 'created';
      else if (psdeCreatedMs != null && afterMs != null && psdeCreatedMs >= afterMs) action = 'linked_to_stage';
      else if (psdeMs != null && deMs != null && psdeMs > deMs) action = 'stage_link_updated';

      pushChange({
        changed_at: changedAt,
        action,
        object_type: 'programStageDataElement',
        object_name: de?.displayName || de?.displayFormName || de?.id || psde?.id || 'Unknown data element',
        stage_name: stage.displayName || stage.id,
        data_element_name: de?.displayName || de?.displayFormName || de?.id || null,
        changed_by: de?.lastUpdatedBy?.displayName || de?.lastUpdatedBy?.username || null,
        details: `valueType=${de?.valueType || ''}${de?.optionSet?.displayName ? `, optionSet=${de.optionSet.displayName}` : ''}`,
      });
    }
  }

  for (const ptea of (programMeta?.programTrackedEntityAttributes || [])) {
    const tea = ptea?.trackedEntityAttribute;
    const pteaMs = isoToMillis(ptea?.lastUpdated);
    const teaMs = isoToMillis(tea?.lastUpdated);
    const changedAt = pteaMs != null && teaMs != null
      ? (pteaMs > teaMs ? ptea.lastUpdated : tea.lastUpdated)
      : (ptea?.lastUpdated || tea?.lastUpdated || null);
    if (!changedAt) continue;

    let action = 'updated';
    const pteaCreatedMs = isoToMillis(ptea?.created);
    const teaCreatedMs = isoToMillis(tea?.created);
    if (teaCreatedMs != null && afterMs != null && teaCreatedMs >= afterMs) action = 'created';
    else if (pteaCreatedMs != null && afterMs != null && pteaCreatedMs >= afterMs) action = 'linked_to_program';

    pushChange({
      changed_at: changedAt,
      action,
      object_type: 'programTrackedEntityAttribute',
      object_name: tea?.displayName || tea?.displayFormName || tea?.id || ptea?.id || 'Unknown attribute',
      stage_name: null,
      data_element_name: null,
      changed_by: tea?.lastUpdatedBy?.displayName || tea?.lastUpdatedBy?.username || null,
      details: `valueType=${tea?.valueType || ''}${tea?.optionSet?.displayName ? `, optionSet=${tea.optionSet.displayName}` : ''}`,
    });
  }

  for (const prv of (programMeta?.programRuleVariables || [])) {
    if (!prv?.lastUpdated) continue;
    pushChange({
      changed_at: prv.lastUpdated,
      action: changeActionFromDates(prv.created, prv.lastUpdated, afterMs),
      object_type: 'programRuleVariable',
      object_name: prv.name || prv.id,
      stage_name: prv.programStage?.displayName || null,
      data_element_name: prv.dataElement?.displayName || prv.trackedEntityAttribute?.displayName || null,
      changed_by: prv.lastUpdatedBy?.displayName || prv.lastUpdatedBy?.username || null,
      details: `source=${prv.dataElement?.displayName || prv.trackedEntityAttribute?.displayName || ''}`,
    });
  }

  for (const rule of (programMeta?.programRules || [])) {
    if (!rule?.lastUpdated) continue;
    pushChange({
      changed_at: rule.lastUpdated,
      action: changeActionFromDates(rule.created, rule.lastUpdated, afterMs),
      object_type: 'programRule',
      object_name: rule.name || rule.id,
      stage_name: rule.programStage?.displayName || null,
      data_element_name: null,
      changed_by: rule.lastUpdatedBy?.displayName || rule.lastUpdatedBy?.username || null,
      details: truncateTextForTool(`priority=${rule.priority ?? ''}; condition=${rule.condition || ''}; actions=${summarizeRuleActions(rule.programRuleActions)}`),
    });
  }

  for (const indicator of (programMeta?.programIndicators || [])) {
    if (!indicator?.lastUpdated) continue;
    pushChange({
      changed_at: indicator.lastUpdated,
      action: changeActionFromDates(indicator.created, indicator.lastUpdated, afterMs),
      object_type: 'programIndicator',
      object_name: indicator.displayName || indicator.id,
      stage_name: null,
      data_element_name: null,
      changed_by: indicator.lastUpdatedBy?.displayName || indicator.lastUpdatedBy?.username || null,
      details: truncateTextForTool(`expression=${indicator.expression || ''}; filter=${indicator.filter || ''}`),
    });
  }

  changes.sort((a, b) => String(b.changed_at || '').localeCompare(String(a.changed_at || '')));
  return {
    changes,
    window: {
      updated_after: afterIso,
      updated_before: beforeIso,
      days_back: daysBack,
    },
  };
}

function summarizeRecentProgramChanges(changes, limit = 100) {
  const countsBy = key => Object.entries(changes.reduce((acc, item) => {
    const bucket = item?.[key] || 'Unspecified';
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, {}))
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  return {
    total_changes: changes.length,
    object_types: countsBy('object_type'),
    actions: countsBy('action'),
    stages: countsBy('stage_name').filter(x => x.name !== 'Unspecified').slice(0, 15),
    changed_by: countsBy('changed_by').filter(x => x.name !== 'Unspecified').slice(0, 15),
    top_changes: changes.slice(0, Math.max(1, limit)),
  };
}

function extractEnrollmentRows(resp) {
  if (!resp || typeof resp !== 'object') return [];
  if (Array.isArray(resp.instances)) return resp.instances;
  if (Array.isArray(resp.enrollments)) return resp.enrollments;
  if (Array.isArray(resp.trackedEntities)) return resp.trackedEntities;
  return [];
}

function extractEventRows(resp) {
  if (!resp || typeof resp !== 'object') return [];
  if (Array.isArray(resp.events)) return resp.events;
  if (Array.isArray(resp.instances)) return resp.instances;
  return [];
}

function intersectSets(a, b) {
  const out = new Set();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

const TEXT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'had', 'has',
  'are', 'was', 'were', 'also', 'only', 'women', 'woman', 'people', 'person',
  'in', 'on', 'at', 'to', 'of', 'by', 'or', 'is', 'be', 'as', 'an', 'a',
  'history', 'previous', 'stage', 'program', 'condition', 'disease',
  'known', 'family', 'pregnancy', 'pregnancies', 'medical',
]);

function tokenize(input) {
  return normalizeSearchText(input)
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => w.length >= 3 && !TEXT_STOPWORDS.has(w));
}

function isNumericLike(value) {
  return value != null && value !== '' && !Number.isNaN(Number(value));
}

function isTruthyLike(value) {
  return ['true', 'yes', '1'].includes(String(value || '').toLowerCase());
}

function getProgramDataElementsIndex() {
  const idx = [];
  const stages = dhis2.programMetadata?.programStages || [];
  for (const stage of stages) {
    for (const psde of (stage.programStageDataElements || [])) {
      const de = psde.dataElement;
      if (!de?.id) continue;
      idx.push({
        stage_id: stage.id,
        stage_name: stage.displayName || '',
        data_element_id: de.id,
        display_name: de.displayName || '',
        form_name: de.displayFormName || '',
        value_type: de.valueType || '',
        option_set_value: !!de.optionSetValue,
        options: (de.optionSet?.options || []).map(o => ({
          code: String(o.code || ''),
          displayName: String(o.displayName || ''),
        })),
      });
    }
  }
  return idx;
}

function buildConditionKeywords(cond, deMeta) {
  const chunks = [];
  if (cond?.label) chunks.push(cond.label);
  if (cond?.value && !isNumericLike(cond.value) && !['true', 'false'].includes(String(cond.value).toLowerCase())) {
    chunks.push(cond.value);
  }
  // Fallback to DE metadata only when label/value are missing.
  if (chunks.length === 0) {
    if (deMeta?.display_name) chunks.push(deMeta.display_name);
    if (deMeta?.form_name) chunks.push(deMeta.form_name);
  }

  return [...new Set(tokenize(chunks.join(' ')))];
}

function resolveConditionCandidates(cond) {
  const index = getProgramDataElementsIndex();
  const primary = index.find(
    x => x.stage_id === cond.stage_id && x.data_element_id === cond.data_element_id
  );
  const keywords = buildConditionKeywords(cond, primary);
  const queryText = keywords.join(' ');
  const truthyValue = isTruthyLike(cond.value);
  const hasExplicitLocator = !!(cond.stage_id && cond.data_element_id);

  const out = [];
  if (hasExplicitLocator) {
    out.push({
      stage_id: cond.stage_id,
      data_element_id: cond.data_element_id,
      operator: cond.operator,
      value: String(cond.value),
      source: 'primary',
    });
  }

  if (!keywords.length) return out.length ? out : [];

  const overlapCount = (text) => {
    const toks = new Set(tokenize(text));
    let hits = 0;
    for (const k of keywords) if (toks.has(k)) hits++;
    return hits;
  };

  const scored = [];
  for (const de of index) {
    const nameHits = overlapCount(`${de.display_name} ${de.form_name}`);
    let bestOption = null;
    let bestOptionHits = 0;
    for (const o of de.options) {
      const hits = overlapCount(`${o.code} ${o.displayName}`);
      if (hits > bestOptionHits) {
        bestOptionHits = hits;
        bestOption = o;
      }
    }
    const totalHits = Math.max(nameHits, bestOptionHits);
    if (totalHits <= 0) continue;

    let score = 0;
    if (de.data_element_id === cond.data_element_id) score += 5;
    if (de.stage_id === cond.stage_id) score += 2;
    score += nameHits * 2;
    score += bestOptionHits * 3;
    if (truthyValue && (de.value_type === 'BOOLEAN' || de.value_type === 'TRUE_ONLY')) score += 2;
    if (truthyValue && de.value_type === 'MULTI_TEXT') score += 3;
    if (keywords.length >= 2 && totalHits < 2 && !hasExplicitLocator) continue;
    scored.push({ de, score, bestOption, bestOptionHits, nameHits });
  }

  scored.sort((a, b) => b.score - a.score);
  for (const item of scored.slice(0, 10)) {
    const { de, bestOption, bestOptionHits } = item;
    let operator = cond.operator;
    let value = String(cond.value);

    if (truthyValue) {
      if (de.value_type === 'INTEGER_ZERO_OR_POSITIVE' || de.value_type.startsWith('INTEGER') || de.value_type === 'NUMBER') {
        operator = 'gt';
        value = '0';
      } else if (de.value_type === 'MULTI_TEXT' || de.option_set_value || de.options.length) {
        operator = 'like';
        // Prefer strongest option hit; otherwise keyword text.
        value = (bestOptionHits > 0 ? (bestOption?.code || bestOption?.displayName) : null) || queryText;
      } else if (de.value_type === 'BOOLEAN' || de.value_type === 'TRUE_ONLY') {
        operator = 'eq';
        value = 'true';
      }
    } else if (de.option_set_value || de.options.length) {
      // Keep eq for option-set exact codes, else fallback to like text
      if (operator === 'eq' && !de.options.some(o => String(o.code) === value || String(o.displayName) === value)) {
        operator = 'like';
        value = queryText;
      }
    }

    out.push({
      stage_id: de.stage_id,
      data_element_id: de.data_element_id,
      operator,
      value,
      source: 'expanded',
    });
  }

  // de-duplicate preserving order
  const seen = new Set();
  return out.filter(c => {
    const k = `${c.stage_id}|${c.data_element_id}|${c.operator}|${c.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function splitCompositeCondition(cond) {
  const label = String(cond?.label || '').trim();
  if (!label) return [cond];
  const isCompound = /,| and |\/|&/.test(label);
  const truthy = isTruthyLike(cond?.value ?? true);
  const hasExplicitLocator = !!(cond?.stage_id && cond?.data_element_id);
  if (!isCompound || !truthy || hasExplicitLocator) return [cond];

  const parts = label
    .split(/,| and |\/|&/i)
    .map(s => s.trim())
    .filter(s => s.length >= 3);
  if (parts.length <= 1) return [cond];

  return parts.map(p => ({
    ...cond,
    label: p,
    stage_id: undefined,
    data_element_id: undefined,
    operator: 'eq',
    value: 'true',
    _splitFrom: label,
  }));
}

function findProgramStagesForDataElement(dataElementId) {
  const out = [];
  const stages = dhis2.programMetadata?.programStages || [];
  for (const stage of stages) {
    const has = (stage.programStageDataElements || []).some(
      psde => psde.dataElement?.id === dataElementId
    );
    if (has) out.push(stage.id);
  }
  return out;
}

async function fetchTeiSetForCondition({ pid, ouid, includeChildren, condition, pageSize, maxPages }) {
  const normalizedCondition = {
    ...condition,
    operator: condition?.operator || 'eq',
    value: condition?.value == null ? 'true' : String(condition.value),
  };
  const ouMode = includeChildren ? 'DESCENDANTS' : 'SELECTED';
  let totalEvents = 0;
  const teiSet = new Set();
  let lastApiPath = null;
  let stageAutoResolved = false;
  let expanded = false;
  const candidates = resolveConditionCandidates(normalizedCondition);
  if (!candidates.length) {
    return {
      teiSet,
      totalEvents: 0,
      _apiPath: null,
      stageAutoResolved: false,
      resolvedStages: [],
      expanded: false,
      triedCandidates: [],
      _warning: `No metadata candidates resolved for condition: ${normalizedCondition.label || '[unlabeled condition]'}`,
    };
  }

  let usedCandidates = [];
  for (const cand of candidates) {
    const filterExpr = `${cand.data_element_id}:${cand.operator}:${cand.value}`;
    let stagesToQuery = [cand.stage_id];
    const validStages = findProgramStagesForDataElement(cand.data_element_id);
    if (validStages.length && !validStages.includes(cand.stage_id)) {
      stagesToQuery = validStages;
      stageAutoResolved = true;
    }

    let localEvents = 0;
    let localTeis = 0;
    for (const stageId of stagesToQuery) {
      for (let page = 1; page <= maxPages; page++) {
        const path = appendQueryParamsToPath('tracker/events', {
          program: pid,
          programStage: stageId,
          orgUnit: ouid,
          ouMode,
          filter: filterExpr,
          fields: 'event,trackedEntity,enrollment,orgUnit,occurredAt',
          pageSize,
          totalPages: true,
          page,
        });
        const resp = await safeDhis2Fetch(path);
        if (resp._error) return { _error: resp._error, _apiPath: resp._apiPath || `/${path}` };

        lastApiPath = resp._apiPath || `/${path}`;
        const events = extractEventRows(resp);
        totalEvents += events.length;
        localEvents += events.length;
        for (const ev of events) {
          if (ev.trackedEntity) teiSet.add(ev.trackedEntity);
        }

        const pager = resp.pager || resp._pagerInfo;
        if (!pager || !pager.total || page >= Math.ceil(pager.total / pageSize)) break;
      }
    }

    // Track candidate effectiveness
    localTeis = teiSet.size;
    usedCandidates.push({
      stage_id: cand.stage_id,
      data_element_id: cand.data_element_id,
      operator: cand.operator,
      value: cand.value,
      source: cand.source,
      matched_events: localEvents,
      matched_entities_total_after_candidate: localTeis,
    });

    if (cand.source === 'expanded' && localEvents > 0) {
      expanded = true;
    }

    // If primary produced results, no need to run all expansions.
    if (cand.source === 'primary' && localEvents > 0) break;
    // If expansions found results, keep first successful expansion and stop for speed.
    if (cand.source === 'expanded' && localEvents > 0) break;
  }

  return {
    teiSet,
    totalEvents,
    _apiPath: lastApiPath,
    stageAutoResolved,
    resolvedStages: [...new Set(usedCandidates.map(c => c.stage_id))],
    expanded,
    triedCandidates: usedCandidates,
  };
}

async function fetchEnrollmentCount({ pid, ouid, ouMode, status, date_after, date_before, includeOrgUnit = true }) {
  let path = `tracker/enrollments?program=${pid}&page=1&pageSize=1&totalPages=true`;
  if (includeOrgUnit && ouid) {
    path += `&orgUnit=${ouid}`;
    if (ouMode) path += `&ouMode=${ouMode}`;
  }
  if (status) path += `&status=${status}`;
  if (date_after) path += `&enrolledAfter=${date_after}`;
  if (date_before) path += `&enrolledBefore=${date_before}`;

  const resp = await safeDhis2Fetch(path);
  if (resp._error) return { _error: resp._error, _apiPath: resp._apiPath || `/${path}` };

  const total = Number(resp.pager?.total ?? resp._pagerInfo?.total ?? extractEnrollmentRows(resp).length ?? 0);
  return { total: Number.isNaN(total) ? 0 : total, _apiPath: resp._apiPath || `/${path}` };
}

async function fetchEnrollmentPage({ pid, ouid, ouMode, status, date_after, date_before, page, pageSize, includeOrgUnit = true }) {
  let path = `tracker/enrollments?program=${pid}&page=${page}&pageSize=${pageSize}&totalPages=true`;
  if (includeOrgUnit && ouid) {
    path += `&orgUnit=${ouid}`;
    if (ouMode) path += `&ouMode=${ouMode}`;
  }
  path += '&fields=enrollment,trackedEntity,status,enrolledAt,incidentDate,orgUnit,events[event,status,scheduledAt,occurredAt,programStage,dataValues[dataElement,value]]';
  if (status) path += `&status=${status}`;
  if (date_after) path += `&enrolledAfter=${date_after}`;
  if (date_before) path += `&enrolledBefore=${date_before}`;

  const resp = await safeDhis2Fetch(path);
  if (resp._error) return { _error: resp._error, _apiPath: resp._apiPath || `/${path}` };

  return {
    enrollments: extractEnrollmentRows(resp),
    pager: resp.pager || resp._pagerInfo || null,
    _apiPath: resp._apiPath || `/${path}`,
  };
}

async function detectEnrollmentAbnormalities(args, programId, orgUnitId) {
  const pid = args.program_override || programId;
  const ouid = args.ou_override || orgUnitId;
  if (!pid) return { _error: 'No program in context.' };
  if (!ouid) return { _error: 'No org unit in context.' };

  const now = new Date();
  const pageSize = Math.min(Math.max(Number(args.scan_page_size) || 200, 50), 500);
  const maxPages = Math.min(Math.max(Number(args.max_pages) || 6, 1), 12);
  const sampleSize = Math.min(Math.max(Number(args.sample_size) || 50, 5), 100);
  const includeChildrenRequested = typeof args.include_children === 'boolean' ? args.include_children : null;
  const modeCandidates = includeChildrenRequested == null
    ? ['SELECTED', 'DESCENDANTS']
    : [includeChildrenRequested ? 'DESCENDANTS' : 'SELECTED'];
  let activeMode = modeCandidates[0];
  let scope = 'orgUnit';
  let totalEnrollments = null;

  const mandatoryStageElements = {};
  for (const stage of (dhis2.programMetadata?.programStages || [])) {
    mandatoryStageElements[stage.id] = new Set(
      (stage.programStageDataElements || [])
        .filter(psde => psde.compulsory && psde.dataElement?.id)
        .map(psde => psde.dataElement.id)
    );
  }
  let countApiPath = null;
  for (const candidateMode of modeCandidates) {
    const countResp = await fetchEnrollmentCount({
      pid,
      ouid,
      ouMode: candidateMode,
      status: args.status,
      date_after: args.date_after,
      date_before: args.date_before,
      includeOrgUnit: true,
    });
    if (countResp._error) continue;
    countApiPath = countResp._apiPath;
    totalEnrollments = countResp.total;
    activeMode = candidateMode;
    if (countResp.total > 0 || candidateMode === modeCandidates[modeCandidates.length - 1]) break;
  }

  let programWideEnrollments = null;
  if ((totalEnrollments == null || totalEnrollments === 0) && !args.ou_override) {
    const globalCountResp = await fetchEnrollmentCount({
      pid,
      status: args.status,
      date_after: args.date_after,
      date_before: args.date_before,
      includeOrgUnit: false,
    });
    if (!globalCountResp._error) {
      programWideEnrollments = globalCountResp.total;
      if ((totalEnrollments == null || totalEnrollments === 0) && globalCountResp.total > 0) {
        scope = 'programWideFallback';
      }
    }
  }

  const abnormalCounts = {
    cancelled_enrollment: 0,
    future_enrollment_date: 0,
    overdue_scheduled_event: 0,
    event_before_enrollment: 0,
    missing_mandatory_data: 0,
    stale_active_without_events: 0,
  };

  const abnormalDetails = [];
  let totalAbnormalEnrollments = 0;
  let scannedEnrollments = 0;
  let scannedPages = 0;
  let queryPath = '';

  const includeOrgUnitInScan = scope !== 'programWideFallback';
  for (let page = 1; page <= maxPages; page++) {
    const resp = await fetchEnrollmentPage({
      pid,
      ouid,
      ouMode: activeMode,
      status: args.status,
      date_after: args.date_after,
      date_before: args.date_before,
      page,
      pageSize,
      includeOrgUnit: includeOrgUnitInScan,
    });
    if (resp._error) return { _error: resp._error, _apiPath: resp._apiPath };

    queryPath = resp._apiPath || queryPath;
    const enrollments = resp.enrollments || [];
    if (!enrollments.length) break;
    scannedPages++;

    for (const enr of enrollments) {
      scannedEnrollments++;
      const reasons = [];
      const enrolledAt = parseIsoDate(enr.enrolledAt || enr.incidentDate);
      const events = Array.isArray(enr.events) ? enr.events : [];

      if (enr.status === 'CANCELLED') {
        abnormalCounts.cancelled_enrollment++;
        reasons.push({ code: 'cancelled_enrollment', detail: 'Enrollment status is CANCELLED.' });
      }

      if (enrolledAt && enrolledAt.getTime() > now.getTime() + 86400000) {
        abnormalCounts.future_enrollment_date++;
        reasons.push({ code: 'future_enrollment_date', detail: `Enrollment date is in the future (${enr.enrolledAt || enr.incidentDate}).` });
      }

      let hasCompletedEvent = false;
      let hasOverdueScheduled = false;
      let hasEventBeforeEnrollment = false;
      let hasMissingMandatory = false;

      for (const ev of events) {
        if (ev.status === 'COMPLETED') hasCompletedEvent = true;

        const scheduledAt = parseIsoDate(ev.scheduledAt);
        if (scheduledAt && scheduledAt < now && (ev.status === 'SCHEDULE' || ev.status === 'ACTIVE' || !ev.occurredAt)) {
          hasOverdueScheduled = true;
        }

        const occurredAt = parseIsoDate(ev.occurredAt);
        if (occurredAt && enrolledAt && occurredAt < enrolledAt) {
          hasEventBeforeEnrollment = true;
        }

        const requiredSet = mandatoryStageElements[ev.programStage];
        if (requiredSet?.size) {
          const present = new Set((ev.dataValues || []).filter(d => d.value != null && String(d.value).trim() !== '').map(d => d.dataElement));
          for (const deId of requiredSet) {
            if (!present.has(deId)) {
              hasMissingMandatory = true;
              break;
            }
          }
        }
      }

      if (hasOverdueScheduled) {
        abnormalCounts.overdue_scheduled_event++;
        reasons.push({ code: 'overdue_scheduled_event', detail: 'Contains scheduled/active events that are overdue.' });
      }
      if (hasEventBeforeEnrollment) {
        abnormalCounts.event_before_enrollment++;
        reasons.push({ code: 'event_before_enrollment', detail: 'Contains events dated before enrollment date.' });
      }
      if (hasMissingMandatory) {
        abnormalCounts.missing_mandatory_data++;
        reasons.push({ code: 'missing_mandatory_data', detail: 'Contains events missing compulsory data elements.' });
      }

      const ageDays = enrolledAt ? daysBetween(now, enrolledAt) : null;
      if (enr.status === 'ACTIVE' && !events.length && ageDays != null && ageDays > 60) {
        abnormalCounts.stale_active_without_events++;
        reasons.push({ code: 'stale_active_without_events', detail: `Active enrollment has no events for ${ageDays} days.` });
      }

      if (reasons.length) {
        totalAbnormalEnrollments++;
        if (abnormalDetails.length < sampleSize) {
          abnormalDetails.push({
            enrollment: enr.enrollment,
            trackedEntity: enr.trackedEntity,
            status: enr.status,
            enrolledAt: enr.enrolledAt || enr.incidentDate || null,
            orgUnit: enr.orgUnit || null,
            eventCount: events.length,
            reasons,
          });
        }
      }
    }

    const pager = resp.pager;
    if (!pager || !pager.total || page >= Math.ceil(pager.total / pageSize)) break;
  }

  const includeChildrenEffective = includeOrgUnitInScan ? (activeMode === 'DESCENDANTS') : true;
  return {
    program: { id: pid, name: dhis2.programMetadata?.displayName || pid },
    org_unit: {
      id: ouid,
      name: dhis2.ouContext?.displayName || ouid,
      include_children: includeChildrenEffective,
      mode: includeOrgUnitInScan ? activeMode : 'PROGRAM_WIDE',
    },
    totals: {
      total_enrollments: totalEnrollments,
      total_enrollments_program_wide: programWideEnrollments,
      scanned_enrollments: scannedEnrollments,
      scanned_pages: scannedPages,
      abnormalities_detected: totalAbnormalEnrollments,
    },
    abnormality_breakdown: abnormalCounts,
    abnormal_enrollments: abnormalDetails,
    scan_config: { page_size: pageSize, max_pages: maxPages, sample_size: sampleSize },
    scope,
    _countApiPath: countApiPath,
    _note: scannedEnrollments >= (maxPages * pageSize)
      ? 'Scan capped by max_pages for speed. Increase max_pages for full scan.'
      : (scope === 'programWideFallback'
        ? 'No enrollments found in current org unit scope; switched to program-wide scan fallback.'
        : undefined),
    _apiPath: queryPath || undefined,
  };
}

// ── HARD privacy safeguard: patient-level tracker data ↔ LOCAL model only ────
// Reading patient/tracker INDIVIDUAL records (events, enrollments, tracked
// entities, relationships, row-level event queries, the enrollment-abnormality
// scanner) is permitted ONLY when the LLM backend is LOCAL (Ollama / localhost).
// With ANY remote/cloud provider these reads are refused unconditionally so that
// patient identities never leave the device to a third-party model.
//
// This is enforced in CODE at the single tool-execution choke point — it is NOT
// a system-prompt instruction and CANNOT be enabled, overridden, or jailbroken
// by anything the model is told or asked. Adding a new patient-data tool in the
// future? Put its name in PATIENT_DATA_TOOL_NAMES (or extend toolReadsPatientData)
// and it is automatically gated. De-identified AGGREGATE analytics and metadata
// are unaffected.
const PATIENT_DATA_TOOL_NAMES = new Set([
  'detect_enrollment_abnormalities',
]);
// True when a raw dhis2_query path targets individual patient records.
function pathReadsPatientData(rawPath) {
  if (typeof rawPath !== 'string') return false;
  const base = rawPath.split('?')[0].replace(/^\//, '').replace(/^api\/\d+\//i, '').toLowerCase();
  // Boundary `(\/|\.|$)` = the resource name is followed by a sub-path (`/`), a
  // format/extension suffix (`.json`, `.csv`, `.xml`, `.geojson`, `.csv.gz`, …),
  // or end-of-path. The extension form MUST be gated too: `tracker/events.csv`,
  // `tracker/trackedEntities.json`, `analytics/events/query.csv` etc. return the
  // exact same patient-level rows as the extension-less endpoint, so anchoring on
  // `/` or `$` alone (the old patterns) let a `.csv`/`.json` suffix slip the gate.
  // None of the de-identified/metadata endpoints (eventReports, eventCharts,
  // analytics/events/aggregate, dataValueSets, …) begin with these exact resource
  // names followed by `/`, `.`, or end, so the `.` boundary never over-gates them.
  // New Tracker API individual-record endpoints
  if (/^tracker\/(events|enrollments|trackedentities|relationships)(\/|\.|$)/.test(base)) return true;
  // Legacy tracker endpoints
  if (/^(events|enrollments|trackedentityinstances)(\/|\.|$)/.test(base)) return true;
  // Row-level (individual) event/enrollment analytics — aggregate is de-identified and allowed
  if (/^analytics\/(events|enrollments)\/query(\/|\.|$)/.test(base)) return true;
  // SQL view EXECUTION (…/data, …/execute). A saved SQL view can SELECT arbitrary
  // columns — including patient identifiers — from any table (trackedentityinstance,
  // event/programstageinstance, enrollment, trackedentityattributevalue, …), so
  // executing one on a remote model could exfiltrate row-level tracker data past
  // the endpoint checks above. Fail closed: gate the execution sub-endpoints. The
  // view DEFINITION (…/sqlViews/{id}?fields=…, i.e. no /data|/execute) stays
  // readable as metadata. A purely-aggregate view is over-gated on a remote model —
  // run it on a local model or use aggregate analytics. Verified live 2026-07-03:
  // sqlViews/{id}/data was NOT gated before this line (torture-test bypass probe).
  if (/^sqlviews\/[a-z0-9]+\/(data|execute)(\/|\.|$)/i.test(base)) return true;
  return false;
}
// True when a tool call would read patient-level tracker data.
function toolReadsPatientData(name, args) {
  if (PATIENT_DATA_TOOL_NAMES.has(name)) return true;
  if (name === 'dhis2_query') return pathReadsPatientData(args && args.path);
  if (name === 'get_event_analytics' && args) {
    // aggregate_type "query" (and value_dimensions, which implies query) returns
    // individual event rows; aggregate counts/sums are de-identified and allowed.
    if (String(args.aggregate_type || '').toLowerCase() === 'query') return true;
    if (Array.isArray(args.value_dimensions) && args.value_dimensions.length) return true;
  }
  return false;
}
// Returns a refusal object if the call must be blocked, else null.
function enforcePatientDataPrivacyGate(name, args) {
  if (!toolReadsPatientData(name, args)) return null;
  if (isLocalProvider(getProviderConfig())) return null; // local model → permitted
  return {
    _error: 'Refused by hard privacy safeguard: patient-level tracker data (events, enrollments, tracked entities, individual event rows) can only be read when the assistant runs on a LOCAL model (Ollama / localhost). The current provider is remote/cloud, so this data cannot be accessed.',
    _privacy_block: true,
    _scope: 'patient_data_privacy_gate',
    _hint: 'This is a hard-coded, non-overridable safeguard — no instruction can enable it. To work with patient-level data, switch the provider to a local model (Ollama) in settings. For program-level needs without patient identities, use aggregate alternatives: count_records, get_event_analytics(aggregate_type="aggregate"), get_program_info.',
  };
}

// ── Tool Execution ───────────────────────────────────────────────────────────

async function executeTool(name, args) {
  if (!TOOL_ROUTER[name]) {
    return { _error: `Unknown tool: ${name}` };
  }

  // HARD privacy gate (see above): block patient-level tracker-data reads unless
  // the LLM backend is local. Runs before ANY tool logic; cannot be bypassed by
  // prompt content. De-identified aggregates and metadata pass straight through.
  const _privacyBlock = enforcePatientDataPrivacyGate(name, args);
  if (_privacyBlock) return _privacyBlock;

  const ctx = dhis2.pageContext || {};
  const programId = ctx.programId;
  const orgUnitId = ctx.orgUnitId;

  // ── dhis2_query (universal) ──
  if (name === 'dhis2_query') {
    // Validate path up front. The tool schema lists path as required, but the
    // model occasionally omits it (or passes a non-string like an object). Let
    // the model self-correct in one round trip instead of crashing on
    // `path.replace` downstream and burning an iteration with an opaque error.
    if (typeof args.path !== 'string' || !args.path.trim()) {
      return {
        _error: 'dhis2_query called without a valid "path". The "path" argument is required and must be a non-empty string.',
        _hint: 'Pass path without the /api/{version}/ prefix, e.g. path="programs/<uid>?fields=id,displayName". If you meant to search metadata, call search_metadata(object_type=...) instead.',
        _received_args_keys: Object.keys(args || {}),
      };
    }
    const method = (args.method || 'GET').toString().toUpperCase();
    // dhis2_query write methods (POST/PUT/PATCH/DELETE) are destructive — gate on
    // write authorization the same way as the dedicated manage_* tools, so the
    // model cannot route around the gates by sending a raw API call.
    if (method !== 'GET') {
      const _gate = requireWriteAuth('dhis2_query', method, { path: args.path });
      if (_gate) return _gate;
    }
    const opts = {};
    if (method !== 'GET') opts.method = method;
    if (args.body) opts.body = args.body;
    let safePath = appendQueryParamsToPath(args.path, args.query_params);

    // Guard: POST/PATCH/PUT to staticContent/* requires multipart form data (file upload),
    // not JSON. Previously the model tried POST staticContent/logo_banner with a JSON
    // body → DHIS2 returned HTTP 500 "Current request is not a multipart request",
    // burning an iteration. Redirect to the correct mechanism.
    if (method !== 'GET' && method !== 'DELETE') {
      const staticMatch = safePath.match(/^staticContent(\b|\/|\?|$)/);
      if (staticMatch) {
        return {
          _error: `Blocked: ${method} staticContent via dhis2_query is unsupported. The staticContent endpoint accepts multipart/form-data file uploads only, not JSON. DHIS2 returns HTTP 500 "Current request is not a multipart request" for JSON bodies.`,
          _hint: 'Ask the user to upload the logo via the DHIS2 System Settings app (Appearance → Logos). The extension cannot perform multipart uploads from the side panel. A missing staticContent/logo_banner (404) is HARMLESS — DHIS2 falls back to the default logo.',
        };
      }
    }

    // Guard: writes to dataStore/capture/* and dataStore/settings/* are owned
    // by the Capture / Settings apps. Fabricating keys here (e.g. dataStore/capture/ruleEngine
    // with {useNew: true}) looks like a "fix" but can poison the app cache. If the key is
    // legitimately missing, the app recreates it on next load — do NOT write it from here.
    if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && /^dataStore\/(capture|settings|user-settings|userDataStore)\b/i.test(safePath)) {
      return {
        _error: `Blocked: ${method} to ${safePath.split('?')[0]} is unsafe from the assistant. The dataStore/capture and dataStore/settings namespaces are owned by the DHIS2 Capture and Settings apps. Writing arbitrary keys (or default values like {"useNew":true}) can corrupt the app cache.`,
        _hint: 'If a dataStore key is missing, open the relevant DHIS2 app and let it recreate the key on first use. If the user explicitly asks for a specific value, ask them to confirm the exact JSON before writing.',
      };
    }

    // Guard: bulk deletion via POST metadata?importStrategy=DELETE must be gated.
    // Previously automated repair runs deleted 84 program rule variables + 10 rules in a
    // single call, based only on audit heuristics that flagged them as "orphan". The
    // caller must pass args.confirm_bulk_delete: true to authorize this path, OR use
    // manage_metadata / manage_program_rules which do safer per-object handling.
    if (method === 'POST' && /^metadata\b/.test(safePath) && /importStrategy=DELETE/i.test(safePath)) {
      let bulkCount = 0;
      let parsedBulkBody = null;
      try {
        parsedBulkBody = typeof args.body === 'string' ? JSON.parse(args.body) : args.body;
        if (parsedBulkBody && typeof parsedBulkBody === 'object') {
          for (const v of Object.values(parsedBulkBody)) {
            if (Array.isArray(v)) bulkCount += v.length;
          }
        }
      } catch { /* body parse failure → treat as unknown → block */ }
      if (bulkCount > 1 && args.confirm_bulk_delete !== true) {
        return {
          _error: `Blocked: POST metadata?importStrategy=DELETE would delete ${bulkCount || 'an unknown number of'} object(s) in one call. Bulk deletion requires explicit user confirmation.`,
          _hint: 'For a single object use manage_metadata(action="delete", object_type=..., object_id=...) — it checks references first. For program rules / indicators use manage_program_rules / manage_program_indicators actions. If the user has explicitly approved the batch, retry with confirm_bulk_delete:true, but ONLY after listing the exact IDs to the user and getting a clear "yes".',
          _bulk_delete_count: bulkCount,
        };
      }
      // Hard ceiling: even with confirm_bulk_delete, refuse really large
      // batches without a second-level acknowledgement. Reduces blast radius
      // when the model misreads an audit result.
      if (bulkCount > BULK_DELETE_SOFT_CAP && args.acknowledge_large_bulk !== true) {
        return {
          _error: `Refusing bulk delete of ${bulkCount} object(s) in one call (soft cap is ${BULK_DELETE_SOFT_CAP}). List the exact IDs to the user, get explicit "yes", then retry with acknowledge_large_bulk:true (in addition to confirm_bulk_delete:true).`,
          _bulk_delete_count: bulkCount,
          _hint: `Why this exists: a single typo in audit logic could otherwise wipe hundreds of objects. Smaller batches give the user a chance to abort.`,
        };
      }
      // Snapshot every object slated for deletion BEFORE we send the bulk
      // delete. This is the riskiest path the model has, so the backup is
      // mandatory unless the user has expressly waived it via skip_backup.
      if (bulkCount >= 1 && parsedBulkBody && typeof parsedBulkBody === 'object') {
        const targets = [];
        for (const [type, arr] of Object.entries(parsedBulkBody)) {
          if (!Array.isArray(arr)) continue;
          for (const o of arr) {
            if (o && o.id) targets.push({ object_type: type, object_id: o.id, role: 'primary' });
          }
        }
        if (targets.length) {
          const bulkBackup = await ensureBackupOrBail(
            { operation: 'bulk_delete', tool: 'dhis2_query', action: 'POST metadata?importStrategy=DELETE', reason: `Bulk delete via dhis2_query: ${targets.length} object(s)` },
            targets,
            args
          );
          if (!bulkBackup.ok) return bulkBackup.error;
          // Stash the backup block so we can attach it after the actual write.
          opts._backup_block = bulkBackup.block;
        }
      }
    }

    const trackerWriteResult = await executeTrackerWrite(safePath, method, args.body, ctx);
    if (trackerWriteResult) return trackerWriteResult;

    // Guard: prevent fetching ALL programIndicators or programRules at once via paging=false.
    // Large programs can have 500+ indicators (300KB+) or hundreds of rules — responses will be
    // truncated and the LLM will get stuck. Redirect to the appropriate managed tool instead.
    if (method === 'GET' && /paging=false/i.test(safePath)) {
      // Try to extract program ID from the path itself first, fall back to context
      const pathProgramMatch = safePath.match(/filter=program\.id(?:%3A|:)eq(?:%3A|:)([A-Za-z][A-Za-z0-9]{10})/i);
      const pathProgramId = pathProgramMatch?.[1] || null;
      const ctxProgramId = pathProgramId || ctx.programId || dhis2.programMetadata?.id || '<program_id>';

      if (/programIndicators/i.test(safePath)) {
        return {
          _error:
            `Blocked: fetching programIndicators with paging=false can return very large responses (100KB–400KB+) that will be truncated. Use manage_program_indicators instead:\n` +
            `• To find broken/non-working indicators: manage_program_indicators(action=audit, program_id="${ctxProgramId}") — fetches all pages internally, validates references, returns ONLY problematic indicators\n` +
            `• To browse indicators page by page: manage_program_indicators(action=list, program_id="${ctxProgramId}", page=1) — returns 50/page with _has_more flag\n` +
            `• To read a single indicator: manage_program_indicators(action=get, indicator_id="<id>")`,
          _redirect: 'manage_program_indicators',
          _suggested_program_id: ctxProgramId,
        };
      }

      if (/programRules/i.test(safePath) && !/programRuleVariables|programRuleActions/i.test(safePath)) {
        return {
          _error:
            `Blocked: fetching programRules with paging=false can return very large responses that will be truncated. Use manage_program_rules instead:\n` +
            `• To list rules and variables: manage_program_rules(action=list, program_id="${ctxProgramId}") — paginated, returns up to 100 rules\n` +
            `• To read a single rule with full actions: manage_program_rules(action=get, rule_id="<id>")`,
          _redirect: 'manage_program_rules',
          _suggested_program_id: ctxProgramId,
        };
      }
    }

    const trackerCountRedirect = method === 'GET' ? buildCountRecordsRedirect(safePath, ctx) : null;
    if (trackerCountRedirect) {
      return trackerCountRedirect;
    }

    // Guard: redirect sharing write attempts to manage_metadata(action=update_sharing).
    // Direct PUT/PATCH to {type}/{id}/sharing or sharing endpoints will fail (405/500).
    // The correct DHIS2 sharing API is PUT /api/sharing?type={singular}&id={id} — handled by manage_metadata.
    if (method !== 'GET') {
      const sharingSubResourceMatch = safePath.match(/^([a-zA-Z]+)\/([A-Za-z][A-Za-z0-9]{10})\/sharing/);
      const sharingEndpointMatch = safePath.match(/^sharing\?/);
      if (sharingSubResourceMatch) {
        return {
          _error: `Blocked: Direct ${method} to ${sharingSubResourceMatch[1]}/${sharingSubResourceMatch[2]}/sharing will fail (405/500). DHIS2 sharing must be updated via the dedicated sharing API.\n` +
            `Use: manage_metadata(action=update_sharing, object_type="${sharingSubResourceMatch[1]}", object_id="${sharingSubResourceMatch[2]}", public_access="rwrw----")\n` +
            `Access string: "rw------"=metadata only, "rwrw----"=metadata+data, "r-r-----"=read-only.`,
          _redirect: 'manage_metadata',
        };
      }
      if (sharingEndpointMatch) {
        const typeParam = safePath.match(/type=([^&]+)/)?.[1];
        const idParam = safePath.match(/id=([A-Za-z][A-Za-z0-9]{10})/)?.[1];
        return {
          _error: `Blocked: Use manage_metadata(action=update_sharing) instead of raw ${method} to sharing endpoint. It handles the correct API format and verifies the result.\n` +
            (typeParam && idParam ? `Use: manage_metadata(action=update_sharing, object_type="${typeParam}s", object_id="${idParam}", public_access="rwrw----")` : ''),
          _redirect: 'manage_metadata',
        };
      }
    }

    // Guard: DASHBOARD DATA-LOSS PREVENTION. The single most destructive thing
    // the model has ever done: to "add a chart to a dashboard" it did a full
    // PUT /dashboards/{id} (or POST /metadata with a dashboards[] entry) whose
    // body carried only the NEW item — DHIS2 treats a dashboard PUT as a
    // whole-object replace, so every pre-existing dashboardItem was wiped and
    // the dashboard "went missing" (verified on the 2.43 playground: HTTP 200,
    // silent data loss). These raw writes are now refused and routed to
    // manage_dashboards(action=add_items), which snapshots first and APPENDS
    // without touching existing items. (Item-level ops like
    // PUT dashboards/{id}/items/{itemId} and the append endpoint
    // dashboards/{id}/items/content are left alone.)
    if (method === 'PUT' || method === 'PATCH' || method === 'POST') {
      const dashItemMatch = safePath.match(/^dashboards\/([A-Za-z][A-Za-z0-9]{10})(\b|\/|\?|$)/);
      const isContentAppend = /^dashboards\/[A-Za-z][A-Za-z0-9]{10}\/items\/content(\b|\?|$)/.test(safePath);
      const isItemLevel = /^dashboards\/[A-Za-z][A-Za-z0-9]{10}\/items\/[A-Za-z][A-Za-z0-9]{10}/.test(safePath);
      if ((method === 'PUT' || method === 'PATCH') && dashItemMatch && !isContentAppend && !isItemLevel) {
        return {
          _error: `Blocked: ${method} dashboards/${dashItemMatch[1]} via dhis2_query REPLACES the entire dashboard object. If the body does not carry every existing dashboardItem, the whole dashboard's contents are permanently destroyed — this is exactly how dashboards "went missing" before. Never hand-write a dashboard PUT.`,
          _hint: `Use manage_dashboards — it snapshots the dashboard first, then APPENDS without touching existing items:\n• Add existing/new charts to a dashboard: manage_dashboards(action="add_items", dashboard_id="${dashItemMatch[1]}", items=[{ visualization_id:"<vizId>" }])\n• Remove one tile: manage_dashboards(action="remove_item", dashboard_id="${dashItemMatch[1]}", item_id="<itemId>").\n• Rename: manage_dashboards(action="update"). To restore a wiped one: manage_backups(action="list") then restore.`,
          _redirect: 'manage_dashboards',
        };
      }
      if (method === 'POST' && /^metadata(\?|$)/.test(safePath)) {
        try {
          const parsedMeta = typeof args.body === 'string' ? JSON.parse(args.body) : args.body;
          const dashArr = parsedMeta && Array.isArray(parsedMeta.dashboards) ? parsedMeta.dashboards : null;
          if (dashArr && dashArr.some(d => d && d.id && Array.isArray(d.dashboardItems))) {
            return {
              _error: `Blocked: POST /metadata with a dashboards[] entry that has an existing id and a dashboardItems array replaces that dashboard's items wholesale — the classic "dashboard vanished" data-loss path.`,
              _hint: `Use manage_dashboards(action="add_items", dashboard_id="<id>", items=[…]) to append safely (it snapshots first), or action="create_dashboard" for a brand-new dashboard.`,
              _redirect: 'manage_dashboards',
            };
          }
        } catch { /* non-JSON body — fall through */ }
      }
      if (method === 'POST' && dashItemMatch && /^dashboards\/[A-Za-z][A-Za-z0-9]{10}\/items\/?(\?|$)/.test(safePath)) {
        return {
          _error: `Blocked: POST dashboards/${dashItemMatch[1]}/items is not the correct way to add a dashboard item and can fail silently.`,
          _hint: `Use manage_dashboards(action="add_items", dashboard_id="${dashItemMatch[1]}", items=[{ visualization_id:"<vizId>" }]).`,
          _redirect: 'manage_dashboards',
        };
      }
    }

    // Guard: redirect raw programNotificationTemplates writes to manage_program_notifications.
    // DHIS2 2.36+ reality: no `url` / `webhookUrl` field on the schema → silently dropped on POST,
    // PATCH returns 400. Linking needs POST /api/programs/{id}/notificationTemplates/{templateId},
    // not PATCH on the program. Both failure modes previously burned agentic-loop iterations.
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      const pntCollectionMatch = safePath.match(/^programNotificationTemplates(\b|\/|\?|$)/);
      const pntItemMatch = safePath.match(/^programNotificationTemplates\/([A-Za-z][A-Za-z0-9]{10})\b/);
      const progPatchMatch2 = safePath.match(/^programs\/([A-Za-z][A-Za-z0-9]{10})(\b|\/|\?|$)/);
      const bodyStr2 = typeof args.body === 'string' ? args.body : (args.body ? JSON.stringify(args.body) : '');
      const bodyMentionsUrlField = /"(url|webhookUrl|webHookUrl|hookUrl|targetUrl|endpointUrl|endpoint)"\s*:/i.test(bodyStr2);
      const bodyMentionsNotifTemplates = /"(notificationTemplates|programNotificationTemplates)"\s*:/i.test(bodyStr2);

      if (pntCollectionMatch && method === 'POST') {
        if (bodyMentionsUrlField) {
          return {
            _error: `Blocked: POST programNotificationTemplates with a "url"/"webhookUrl" field — DHIS2 silently drops those keys (no such property on the ProgramNotificationTemplate schema). Use manage_program_notifications(action="create_and_link", program_id=..., trigger=..., recipient="WEB_HOOK", webhook_url="...") — it places the URL correctly (messageTemplate), sets deliveryChannels=[HTTP], and links to the program in one call.`,
            _redirect: 'manage_program_notifications',
          };
        }
        return {
          _error: `Blocked: Direct POST to programNotificationTemplates is unreliable — the payload shape is non-obvious and the template is NOT automatically linked to any program. Use manage_program_notifications(action="create_and_link", ...) for a single-call create+link with validated fields and clear errors.`,
          _redirect: 'manage_program_notifications',
        };
      }
      if (pntItemMatch && (method === 'PATCH' || method === 'PUT')) {
        return {
          _error: `Blocked: ${method} programNotificationTemplates/${pntItemMatch[1]} via dhis2_query is error-prone. DHIS2 ignores "url"/"webhookUrl" fields (not on schema) and requires application/json-patch+json for PATCH. Use manage_program_notifications(action="update", template_id="${pntItemMatch[1]}", patch={ name?, subject_template?, message_template?, webhook_url?, trigger?, recipient? }).`,
          _redirect: 'manage_program_notifications',
        };
      }
      if (progPatchMatch2 && method === 'PATCH' && bodyMentionsNotifTemplates) {
        return {
          _error: `Blocked: PATCH programs/${progPatchMatch2[1]} with notificationTemplates/programNotificationTemplates does not link templates. The Program schema has a `
            + `"notificationTemplates" field but DHIS2 enforces linking through a dedicated endpoint: POST /api/programs/{programId}/notificationTemplates/{templateId}. Use manage_program_notifications(action="link", program_id="${progPatchMatch2[1]}", template_id="<uid>").`,
          _redirect: 'manage_program_notifications',
        };
      }
    }

    // Guard: redirect TEA-attach write patterns to manage_metadata(action=add_program_attributes).
    // DHIS2 has no programTrackedEntityAttributes collection endpoint; PATCH programs/{id} with
    // application/json returns 415; POSTing a bare programTrackedEntityAttributes block to /metadata
    // strips the link. The correct path is fetch program with ?fields=:owner, append entry, PUT full.
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      const teaCollectionMatch = safePath.match(/^programTrackedEntityAttributes(\b|\/|\?|$)/);
      if (teaCollectionMatch) {
        return {
          _error: `Blocked: There is no POST/PATCH/PUT endpoint on programTrackedEntityAttributes in DHIS2 — these are embedded inside program objects, not a standalone collection. Use: manage_metadata(action=add_program_attributes, program_id="<uid>", program_attributes=[{ tea_id | name, searchable, mandatory, display_in_list }]).`,
          _redirect: 'manage_metadata',
        };
      }

      const programPatchMatch = safePath.match(/^programs\/([A-Za-z][A-Za-z0-9]{10})(\b|\/|\?|$)/);
      const bodyStr = typeof args.body === 'string' ? args.body : (args.body ? JSON.stringify(args.body) : '');
      const bodyMentionsTea = /programTrackedEntityAttributes|trackedEntityAttribute/i.test(bodyStr);
      // Only block PATCH programs/{id} when the body is trying to attach/modify TEAs — that path
      // still needs the full-PUT workflow in manage_metadata(action=add_program_attributes).
      // Non-TEA PATCHes (style, description, displayName, etc.) now work via safeDhis2Fetch,
      // which uses application/json-patch+json and auto-wraps objects into JSON Patch ops.
      // Prefer manage_metadata(action=update_style) for icon/color changes — it also resolves
      // icon keywords via /icons?search=... and verifies the result.
      if (method === 'PATCH' && programPatchMatch && bodyMentionsTea) {
        return {
          _error: `Blocked: PATCH programs/${programPatchMatch[1]} with a TEA/trackedEntityAttribute body is unreliable (DHIS2 ignores the link under PATCH). Use manage_metadata(action=add_program_attributes, program_id="${programPatchMatch[1]}", program_attributes=[{ tea_id | name, searchable:true, mandatory:false, display_in_list:true }]) — it fetches :owner, appends with correct sortOrder, PUTs the full object, and verifies.`,
          _redirect: 'manage_metadata',
        };
      }

      if (method === 'POST' && /^metadata(\?|$)/.test(safePath) && bodyStr) {
        try {
          const parsed = typeof args.body === 'string' ? JSON.parse(args.body) : args.body;
          if (parsed && typeof parsed === 'object') {
            const keys = Object.keys(parsed).filter(k => Array.isArray(parsed[k]) && parsed[k].length > 0);
            const onlyTeaLink = keys.length === 1 && keys[0] === 'programTrackedEntityAttributes';
            if (onlyTeaLink) {
              const sampleProgramId = parsed.programTrackedEntityAttributes[0]?.program?.id || '<uid>';
              return {
                _error: `Blocked: POST /metadata with only programTrackedEntityAttributes does not attach attributes to the program — DHIS2 ignores the link because the parent program object is not being updated in the same import. Use: manage_metadata(action=add_program_attributes, program_id="${sampleProgramId}", program_attributes=[{ tea_id | name, searchable, mandatory, display_in_list }]).`,
                _redirect: 'manage_metadata',
              };
            }
          }
        } catch { /* body not JSON — let the request through */ }
      }
    }

    // Guard: growth-chart plugin dataStore writes MUST go through
    // manage_growth_chart_plugin. Observed live (2026-07-10): the model
    // hand-wrote a config into an INVENTED namespace (childGrowthPlugin) with
    // a made-up shape (including BMI/nutrition DEs the plugin never reads) —
    // the plugin only reads captureGrowthChart/config in its canonical shape,
    // so the user saw "it's not working" with no error anywhere. Allow DELETE
    // on non-official growth namespaces (cleaning up junk is fine); block all
    // other writes on any growth-ish namespace.
    if (method !== 'GET') {
      const dsMatch = safePath.match(/^dataStore\/([^/?]+)/);
      if (dsMatch) {
        let ns = dsMatch[1];
        try { ns = decodeURIComponent(ns); } catch { /* keep raw */ }
        const growthish = /growth/i.test(ns);
        const isOfficial = ns === GROWTH_CHART_NS;
        if (growthish && !(method === 'DELETE' && !isOfficial)) {
          return {
            _error: `Blocked: dataStore namespace "${ns}" is growth-chart plugin territory — hand-written configs are exactly how broken setups happen. The WHO Capture Growth Chart plugin ONLY reads ${GROWTH_CHART_NS}/${GROWTH_CHART_KEY} in its canonical shape; a config written anywhere else (or shaped differently) is silently ignored and the chart never renders.`,
            _hint: `Use manage_growth_chart_plugin instead: action=status (inspect), action=configure with program_id (auto-detects the DOB/gender attributes and weight/height/head-circumference data elements, validates them, writes the canonical config, and returns the dashboard_attach steps), action=remove (delete the official config). The tool IS available in this conversation.`,
            _redirect: 'manage_growth_chart_plugin',
          };
        }
      }
    }

    // Guard: redirect DELETE on metadata objects to manage_metadata for smart reference checking.
    // Common metadata types that benefit from pre-deletion reference checking.
    if (method === 'DELETE') {
      const metaDeleteMatch = safePath.match(/^(dataElements|optionSets|options|trackedEntityAttributes|programStages|categoryOptions|categories|categoryCombos|indicators|dataElementGroups|indicatorGroups)\/([A-Za-z][A-Za-z0-9]{10})$/);
      if (metaDeleteMatch) {
        return {
          _error: `Blocked: Use manage_metadata instead of dhis2_query for DELETE operations on metadata objects. Raw DELETE can fail silently or return unhelpful errors.\n` +
            `Use: manage_metadata(action=delete, object_type="${metaDeleteMatch[1]}", object_id="${metaDeleteMatch[2]}") — this checks references first and provides clear error messages.`,
          _redirect: 'manage_metadata',
        };
      }
    }

    if (method === 'GET' && isAnalyticsPath(safePath)) {
      const ctxVizId = ctx.visualizationId || dhis2.visualizationContext?.id || extractVisualizationIdFromText(lastUserText);
      safePath = await enrichAnalyticsPathWithVisualizationContext(safePath, ctxVizId);
    }

    // Pre-validate program UIDs embedded in analytics paths. This catches the common
    // failure mode where the model guesses a program UID and hits 409 "Program does
    // not exist" — better to refuse up front with a redirecting hint.
    if (method === 'GET') {
      const invalidProg = await validateAnalyticsProgramId(safePath);
      if (invalidProg) return invalidProg;
    }

    // ── Auto-snapshot before any item-level metadata mutation routed through
    // dhis2_query. Most managed-tool callers bypass this handler entirely, so
    // we only catch the cases where the model talks to dhis2_query directly:
    // PUT / PATCH / DELETE on /<type>/<uid>. Bulk POST /metadata?importStrategy=DELETE
    // is already covered above. Skip when the existing redirect guards have
    // already returned (we'd never reach here in that case).
    if ((method === 'PUT' || method === 'PATCH' || method === 'DELETE') && !opts._backup_block) {
      // Strip any query-string before pattern-matching the resource.
      const pathOnly = safePath.split('?')[0];
      const itemMatch = pathOnly.match(/^([a-zA-Z]+)\/([A-Za-z][A-Za-z0-9]{10})(?:\/[A-Za-z]+)?$/);
      // List of known metadata collections that are worth backing up. Reads
      // (analytics/tracker/etc.) are filtered out by virtue of being GET, but
      // we still narrow this list so writes to dataStore/* and similar don't
      // try to snapshot themselves recursively.
      const backupableTypes = new Set([
        'programs', 'programStages', 'programRules', 'programRuleActions',
        'programRuleVariables', 'programIndicators', 'programNotificationTemplates',
        'dataElements', 'trackedEntityAttributes', 'organisationUnits',
        'optionSets', 'options', 'trackedEntityTypes',
        'categoryCombos', 'categories', 'categoryOptions',
        'userGroups', 'dataSets', 'sections', 'indicators',
        // Analytics-app objects. Dashboards especially: a raw PUT replaces the
        // whole object, so a pre-write snapshot is the only safety net if the
        // model slips past the redirect guard with skip_backup off.
        'dashboards', 'visualizations', 'maps',
        'eventCharts', 'eventReports', 'eventVisualizations',
        'charts', 'reportTables', // legacy (pre-2.34) analytics favorites
      ]);
      if (itemMatch && backupableTypes.has(itemMatch[1])) {
        const itemBackup = await ensureBackupOrBail(
          { operation: method === 'DELETE' ? 'delete' : 'update', tool: 'dhis2_query', action: `${method} ${itemMatch[1]}/${itemMatch[2]}`, reason: `${method} via dhis2_query on ${itemMatch[1]}/${itemMatch[2]}` },
          [{ object_type: itemMatch[1], object_id: itemMatch[2], role: 'primary' }],
          args
        );
        if (!itemBackup.ok) return itemBackup.error;
        opts._backup_block = itemBackup.block;
      }
    }

    const writeResult = await safeDhis2Fetch(safePath, opts);
    // Surface the backup block alongside the write result so the model — and
    // the user — can see how to restore.
    if (opts._backup_block && writeResult && typeof writeResult === 'object' && !Array.isArray(writeResult)) {
      writeResult.backup = opts._backup_block;
    }
    return writeResult;
  }

  // ── count_records ──
  if (name === 'count_records') {
    const pid = args.program_override || programId;
    const originalOuid = args.ou_override || orgUnitId;
    if (!pid) return {
      _error: 'No program in context and no program_override given.',
      _hint: 'Do NOT guess a program UID. Pick a tool that does not need one: manage_program_indicators(action="discover") for cross-program indicator questions, search_metadata(object_type="programs", name_filter="<keyword>") to find a specific program, or ask the user to open a program first.',
    };
    if (!originalOuid) return {
      _error: 'No org unit in context and no ou_override given.',
      _hint: 'Pass ou_override to a specific org unit, or ask the user to select one. Do NOT guess an org unit UID.',
    };

    const progName = dhis2.programMetadata?.displayName || pid;
    const hasOuOverride = typeof args.ou_override === 'string' && args.ou_override.trim().length > 0;
    const userWantsDescendants = userExplicitlyWantsDescendants(lastUserText);
    // Unless user explicitly asks broader scope, keep counts at selected OU only.
    let includeChildren = args.include_children === true;
    if (!hasOuOverride && !userWantsDescendants) includeChildren = false;
    if (!hasOuOverride && userWantsDescendants) includeChildren = true;

    let ouid = originalOuid;
    let ouName = dhis2.ouContext?.displayName || originalOuid;
    let scopeResolution = null;
    if (!hasOuOverride && !includeChildren) {
      const resolved = await resolveFacilityScopedOu(originalOuid);
      if (resolved?._error) return resolved;
      if (resolved?.ouId) {
        ouid = resolved.ouId;
        ouName = resolved.ouName || ouName;
        scopeResolution = {
          requested_ou: originalOuid,
          applied_ou: ouid,
          source: resolved.source || 'facility_scope_resolution',
        };
      }
    }

    let stageName = 'All stages';
    if (args.stage_id && dhis2.programMetadata?.programStages) {
      const s = dhis2.programMetadata.programStages.find(s => s.id === args.stage_id);
      if (s) stageName = s.displayName;
    }

    // ── Use analytics endpoints for accurate org-unit-scoped counts ──
    // The tracker /enrollments and /trackedEntities endpoints ignore orgUnit
    // filters for users with broad access, returning system-wide counts.
    // Analytics endpoints respect org unit boundaries correctly.

    if (args.record_type === 'enrollments' || args.record_type === 'tracked_entities') {
      // Use enrollment analytics for both enrollments and tracked_entities
      // (each tracked entity has one enrollment per program, so enrollment count ≈ patient count)
      let ouDim = `ou:${ouid}`;
      if (includeChildren) ouDim = `ou:${ouid};CHILDREN`;

      let path = `analytics/enrollments/aggregate/${pid}?dimension=${ouDim}`;

      // Date range
      const startDate = args.date_after || '2000-01-01';
      const endDate = args.date_before || '2030-12-31';
      path += `&startDate=${startDate}&endDate=${endDate}`;

      // Status filter
      if (args.status) {
        path += `&enrollmentStatus=${args.status}`;
      }

      // Attribute filters for tracked_entities
      if (args.filters?.length) {
        for (const f of args.filters) {
          // Convert filter format: {attrId}:eq:{value} → dimension={attrId}:{value}
          const parts = f.match(/^([^:]+):(eq|like|ilike):(.+)$/);
          if (parts) {
            path += `&dimension=${parts[1]}:${parts[3]}`;
          }
        }
      }

      const result = await safeDhis2Fetch(path);
      if (result._error) {
        return {
          _error: 'Unable to return a reliable org-unit-scoped count from analytics.',
          _details: result._error,
          _hint: 'Rebuild analytics tables (or retry later). Tracker fallback is disabled for strict OU accuracy.',
          _method: 'analytics_error'
        };
      }

      // Extract count from analytics response
      let total = 0;
      if (result.rows?.length) {
        // Sum up all row values (there may be multiple rows if broken down)
        for (const row of result.rows) {
          const valIdx = result.headers?.findIndex(h => h.name === 'value') ?? (result.headers?.length - 1 ?? 0);
          const v = parseInt(row[valIdx], 10);
          if (!isNaN(v)) total += v;
        }
      }

      return {
        count: total,
        record_type: args.record_type,
        program: { id: pid, name: progName },
        org_unit: { id: ouid, name: ouName },
        include_children: includeChildren,
        scope_resolution: scopeResolution || undefined,
        filters_applied: args.filters || [],
        date_range: args.date_after || args.date_before ? { after: args.date_after, before: args.date_before } : undefined,
        _method: 'analytics',
      };
    }

    // ── Events: use event analytics for accurate count ──
    if (args.record_type === 'events') {
      let ouDim = `ou:${ouid}`;
      if (includeChildren) ouDim = `ou:${ouid};CHILDREN`;

      let path = `analytics/events/aggregate/${pid}?dimension=${ouDim}`;
      if (args.stage_id) path += `&stage=${args.stage_id}`;

      const startDate = args.date_after || '2000-01-01';
      const endDate = args.date_before || '2030-12-31';
      path += `&startDate=${startDate}&endDate=${endDate}`;

      if (args.status) {
        path += `&eventStatus=${args.status}`;
      }

      if (args.filters?.length) {
        for (const f of args.filters) {
          const parts = f.match(/^([^:]+):(eq|like|ilike):(.+)$/);
          if (parts) {
            // For event filters, prefix with stage ID if available
            const stagePrefix = args.stage_id ? `${args.stage_id}.` : '';
            path += `&dimension=${stagePrefix}${parts[1]}:${parts[3]}`;
          }
        }
      }

      const result = await safeDhis2Fetch(path);
      if (result._error) {
        return {
          _error: 'Unable to return a reliable org-unit-scoped count from analytics.',
          _details: result._error,
          _hint: 'Rebuild analytics tables (or retry later). Tracker fallback is disabled for strict OU accuracy.',
          _method: 'analytics_error'
        };
      }

      let total = 0;
      if (result.rows?.length) {
        for (const row of result.rows) {
          const valIdx = result.headers?.findIndex(h => h.name === 'value') ?? (result.headers?.length - 1 ?? 0);
          const v = parseInt(row[valIdx], 10);
          if (!isNaN(v)) total += v;
        }
      }

      return {
        count: total,
        record_type: args.record_type,
        program: { id: pid, name: progName },
        org_unit: { id: ouid, name: ouName },
        stage: stageName,
        include_children: includeChildren,
        scope_resolution: scopeResolution || undefined,
        filters_applied: args.filters || [],
        date_range: args.date_after || args.date_before ? { after: args.date_after, before: args.date_before } : undefined,
        _method: 'analytics',
      };
    }

    // Fallback for unknown record_type
    return await countViaTracker(pid, ouid, args, progName, ouName, stageName);
  }

  // ── get_event_analytics ──
  if (name === 'get_event_analytics') {
    const pid = programId;
    if (!pid) return {
      _error: 'No program in context for event analytics.',
      _hint: 'Do NOT guess a program UID. Use manage_program_indicators(action="discover") for cross-program indicator questions, or search_metadata(object_type="programs", name_filter="<keyword>") to pick a specific program first.',
    };
    const ou = args.ou_override || orgUnitId;
    if (!ou) return { _error: 'No org unit in context.', _hint: 'Pass ou_override or ask the user to select an org unit. Do NOT guess a UID.' };
    const includeChildren = args.ou_mode === 'DESCENDANTS';
    const ouDim = includeChildren ? `ou:${ou};CHILDREN` : `ou:${ou}`;

    const type = args.aggregate_type;
    const startDate = args.date_range?.start || '2015-01-01';
    const endDate = args.date_range?.end || '2030-12-31';

    let path;
    if (type === 'aggregate') {
      path = `analytics/events/aggregate/${pid}?dimension=${ouDim}`;
      if (args.period) path += `&dimension=pe:${args.period}`;
      if (args.stage_id) path += `&stage=${args.stage_id}`;
      if (args.breakdown_dimension) path += `&dimension=${args.breakdown_dimension}`;
      path += `&startDate=${startDate}&endDate=${endDate}`;
    } else {
      // query type
      path = `analytics/events/query/${pid}?dimension=${ouDim}`;
      if (args.period) path += `&dimension=pe:${args.period}`;
      if (args.stage_id) path += `&stage=${args.stage_id}`;
      if (args.value_dimensions?.length) {
        for (const dim of args.value_dimensions) {
          path += `&dimension=${dim}`;
        }
      }
      if (args.breakdown_dimension) path += `&dimension=${args.breakdown_dimension}`;
      if (args.event_filters?.length) {
        for (const f of args.event_filters) {
          if (!f?.dimension || !f?.operator) continue;
          const expr = `${f.dimension}:${f.operator}:${f.value ?? ''}`;
          path += `&filter=${encodeURIComponent(expr)}`;
        }
      }
      path += `&startDate=${startDate}&endDate=${endDate}`;
      path += `&pageSize=${args.page_size || 100}`;
    }

    const result = await safeDhis2Fetch(path);
    if (result._error) return result;

    // Enrich with human-readable metadata
    if (result.metaData?.items) {
      result._dimensionNames = {};
      for (const [key, val] of Object.entries(result.metaData.items)) {
        if (val.name) result._dimensionNames[key] = val.name;
      }
    }

    return result;
  }

  // ── cross_stage_entity_intersection ──
  if (name === 'cross_stage_entity_intersection') {
    const pid = args.program_override || programId;
    const ouid = args.ou_override || orgUnitId;
    if (!pid) return { _error: 'No program in context.' };
    if (!ouid) return { _error: 'No org unit in context.' };

    const allOfRaw = Array.isArray(args.all_of) ? args.all_of : [];
    const anyOfRaw = Array.isArray(args.any_of) ? args.any_of : [];
    const allOf = allOfRaw.flatMap(splitCompositeCondition);
    const anyOf = anyOfRaw.flatMap(splitCompositeCondition);
    if (!allOf.length && !anyOf.length) {
      return { _error: 'Provide all_of and/or any_of conditions.' };
    }

    const pageSize = Math.min(Math.max(Number(args.page_size) || 1000, 100), 2000);
    const maxPages = Math.min(Math.max(Number(args.max_pages) || 20, 1), 50);
    const includeChildren = args.include_children !== false;
    const conditionDetails = [];
    let firstApiPath = null;

    let allIntersection = null;
    for (const cond of allOf) {
      const r = await fetchTeiSetForCondition({
        pid, ouid, includeChildren, condition: cond, pageSize, maxPages,
      });
      if (r._error) return { _error: r._error, _apiPath: r._apiPath };
      if (!firstApiPath) firstApiPath = r._apiPath;
      conditionDetails.push({
        group: 'all_of',
        label: cond.label || `${cond.stage_id}.${cond.data_element_id} ${cond.operator} ${cond.value}`,
        matched_entities: r.teiSet.size,
        matched_events: r.totalEvents,
        stage_auto_resolved: !!r.stageAutoResolved,
        resolved_stages: r.resolvedStages || [cond.stage_id],
        expanded_lookup_used: !!r.expanded,
        tried_candidates: r.triedCandidates || [],
      });
      allIntersection = allIntersection == null ? new Set(r.teiSet) : intersectSets(allIntersection, r.teiSet);
    }

    let anyUnion = null;
    if (anyOf.length) {
      anyUnion = new Set();
      for (const cond of anyOf) {
        const r = await fetchTeiSetForCondition({
          pid, ouid, includeChildren, condition: cond, pageSize, maxPages,
        });
        if (r._error) return { _error: r._error, _apiPath: r._apiPath };
        if (!firstApiPath) firstApiPath = r._apiPath;
        for (const x of r.teiSet) anyUnion.add(x);
        conditionDetails.push({
          group: 'any_of',
          label: cond.label || `${cond.stage_id}.${cond.data_element_id} ${cond.operator} ${cond.value}`,
          matched_entities: r.teiSet.size,
          matched_events: r.totalEvents,
          stage_auto_resolved: !!r.stageAutoResolved,
          resolved_stages: r.resolvedStages || [cond.stage_id],
          expanded_lookup_used: !!r.expanded,
          tried_candidates: r.triedCandidates || [],
        });
      }
    }

    let finalSet;
    if (allIntersection && anyUnion) finalSet = intersectSets(allIntersection, anyUnion);
    else if (allIntersection) finalSet = allIntersection;
    else finalSet = anyUnion || new Set();

    return {
      count: finalSet.size,
      matched_entities: [...finalSet].slice(0, 200),
      conditions: conditionDetails,
      logic: {
        all_of_count: allOf.length,
        any_of_count: anyOf.length,
        include_children: includeChildren,
      },
      program: { id: pid, name: dhis2.programMetadata?.displayName || pid },
      org_unit: { id: ouid, name: dhis2.ouContext?.displayName || ouid },
      _apiPath: firstApiPath,
      _note: finalSet.size > 200 ? 'Showing first 200 entity IDs.' : undefined,
    };
  }

  // ── get_program_info ──
  if (name === 'get_program_info') {
    if (!programId) return { _error: 'No program in context.' };

    if (args.info_type === 'rules' || args.info_type === 'rules_for_stage') {
      let fields = 'id,displayName,description,condition';
      if (args.include_actions) {
        fields += ',programRuleActions[id,programRuleActionType,content,data,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]]';
      }
      let filter = `filter=program.id:eq:${programId}`;
      if (args.info_type === 'rules_for_stage' && args.target_id) {
        // Get rules that reference this stage (via programStage field or via actions)
        filter += `&filter=programStage.id:eq:${args.target_id}`;
      }
      const result = await safeDhis2Fetch(`programRules?${filter}&fields=${fields}&paging=false`);
      if (result._error) return result;
      const rules = result.programRules || [];
      return {
        total_rules: rules.length,
        program: { id: programId, name: dhis2.programMetadata?.displayName },
        stage_filter: args.target_id || null,
        rules: rules.slice(0, 100).map(r => ({
          id: r.id,
          name: r.displayName,
          description: r.description,
          condition: r.condition,
          actions: r.programRuleActions?.map(a => ({
            type: a.programRuleActionType,
            content: a.content,
            data: a.data,
            dataElement: a.dataElement?.displayName,
            attribute: a.trackedEntityAttribute?.displayName,
            stage: a.programStage?.displayName,
          })),
        })),
        _note: rules.length > 100 ? `Showing 100 of ${rules.length}. Use more specific filters.` : undefined,
      };
    }

    if (args.info_type === 'indicators') {
      const result = await safeDhis2Fetch(
        `programIndicators?filter=program.id:eq:${programId}&fields=id,displayName,description,expression,filter,displayInForm&paging=false`
      );
      if (result._error) return result;
      return {
        total_indicators: result.programIndicators?.length || 0,
        program: { id: programId, name: dhis2.programMetadata?.displayName },
        indicators: result.programIndicators?.map(pi => ({
          id: pi.id, name: pi.displayName, description: pi.description,
          expression: pi.expression, filter: pi.filter
        })),
      };
    }

    if (args.info_type === 'stage_details') {
      if (args.target_id) {
        // Guard: reject program ID used as stage ID
        if (args.target_id === programId) {
          const stageList = (dhis2.programMetadata?.programStages || [])
            .map(s => `${s.displayName} (${s.id})`).join(', ');
          const ctxStage = dhis2.pageContext?.stageId;
          return {
            _error: `"${args.target_id}" is the PROGRAM ID, not a stage ID. ` +
              (ctxStage
                ? `The current stage in context is: ${ctxStage}. Use that as target_id instead.`
                : `Available stages: ${stageList || 'none loaded'}. Use a stage ID as target_id.`),
          };
        }
        // Guard: validate target_id is a known stage in this program (if metadata loaded)
        const knownStages = dhis2.programMetadata?.programStages;
        if (knownStages?.length && !knownStages.some(s => s.id === args.target_id)) {
          const ctxStage = dhis2.pageContext?.stageId;
          const stageList = knownStages.map(s => `${s.displayName} (${s.id})`).join(', ');
          // Still attempt the fetch — the ID might be from a different program — but warn
          const result = await safeDhis2Fetch(
            `programStages/${args.target_id}?fields=id,displayName,description,executionDateLabel,formType,sortOrder,programStageSections[id,displayName,sortOrder,dataElements[id]],programStageDataElements[compulsory,displayInReports,dataElement[id,displayName,displayFormName,valueType,description,optionSetValue,optionSet[id,displayName,options[id,displayName,code]]]]`
          );
          if (result._error) {
            return {
              _error: result._error,
              _hint: `"${args.target_id}" is not a stage in the current program. ` +
                (ctxStage ? `Current stage in context: ${ctxStage}. ` : '') +
                `Available stages in this program: ${stageList}`,
            };
          }
          return result;
        }
        const result = await safeDhis2Fetch(
          `programStages/${args.target_id}?fields=id,displayName,description,executionDateLabel,formType,sortOrder,programStageSections[id,displayName,sortOrder,dataElements[id]],programStageDataElements[compulsory,displayInReports,dataElement[id,displayName,displayFormName,valueType,description,optionSetValue,optionSet[id,displayName,options[id,displayName,code]]]]`
        );
        return result;
      }
      // No target_id: list all stages for this program
      const result = await safeDhis2Fetch(
        `programStages?filter=program.id:eq:${programId}&fields=id,displayName,description,sortOrder,repeatable,formType,programStageSections[id,displayName]&paging=false&order=sortOrder:asc`
      );
      if (result._error) return result;
      return {
        program: { id: programId, name: dhis2.programMetadata?.displayName },
        total_stages: result.programStages?.length || 0,
        stages: result.programStages || [],
        _note: 'Use target_id with stage_details to get full data elements for a specific stage.',
      };
    }

    if (args.info_type === 'option_set' && args.target_id) {
      return await safeDhis2Fetch(`optionSets/${args.target_id}?fields=id,displayName,valueType,options[id,displayName,code,sortOrder]`);
    }

    return { _error: `Unknown info_type: ${args.info_type}` };
  }

  // ── get_program_recent_changes ──
  if (name === 'get_program_recent_changes') {
    const resolvedProgram = await resolveProgramForRecentChanges(args, programId);
    if (resolvedProgram?._error) return resolvedProgram;

    const auditSupport = await detectMetadataAuditSupport();
    if (args.require_real_logs === true && !auditSupport?.update_logs?.supported) {
      const deleted = await fetchRecentDeletedObjects(args);
      return {
        _error: 'This DHIS2 instance does not expose true metadata audit/changelog logs for add/update history via the Web API.',
        program: {
          id: resolvedProgram.id,
          name: resolvedProgram.displayName || resolvedProgram.id,
        },
        audit_support: auditSupport,
        delete_log_support: deleted.support?.delete_logs || auditSupport?.delete_logs || null,
        recent_global_metadata_deletions: deleted.deletions.slice(0, Math.min(20, Number(args.limit) || 20)),
        _note: 'Only global deletedObjects logs are exposed. They include uid/class/user/time but not enough context to attribute deletes to a specific program, stage, or data element.',
      };
    }

    let programMeta;
    try {
      programMeta = await fetchProgramMetadataForRecentChanges(resolvedProgram.id);
    } catch (e) {
      return { _error: `Unable to fetch program metadata for recent changes: ${e.message}` };
    }

    const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
    const collected = collectRecentProgramChangesFromSnapshot(programMeta, args);
    const deleted = await fetchRecentDeletedObjects(args);
    const summary = summarizeRecentProgramChanges(collected.changes, limit);

    return {
      program: {
        id: resolvedProgram.id,
        name: programMeta.displayName || resolvedProgram.displayName || resolvedProgram.id,
        type: programMeta.programType || resolvedProgram.programType || null,
      },
      date_window: collected.window,
      source_mode: auditSupport?.update_logs?.supported
        ? 'metadata_audit_or_fallback'
        : (deleted.deletions.length ? 'metadata_snapshot_plus_global_delete_logs_fallback' : 'metadata_snapshot_fallback'),
      audit_support: auditSupport,
      delete_log_support: deleted.support?.delete_logs || auditSupport?.delete_logs || null,
      summary: {
        total_changes: summary.total_changes,
        object_types: summary.object_types,
        actions: summary.actions,
        stages: summary.stages,
        changed_by: summary.changed_by,
        global_delete_logs_found: deleted.deletions.length,
      },
      changes: summary.top_changes,
      global_delete_logs: deleted.deletions.slice(0, Math.min(50, limit)),
      _apiPath: `/api/${dhis2.apiVersion}/programs/${resolvedProgram.id}.json?fields=...`,
      _note: auditSupport?.update_logs?.supported
        ? 'Audit endpoint is advertised as available, but this response is currently derived from metadata timestamps until a concrete metadata-audit path is confirmed for this instance.'
        : (deleted.deletions.length
          ? 'This DHIS2 instance does not expose true metadata add/update audit logs. Add/update results are derived from created/lastUpdated timestamps on current metadata objects. Delete rows come from the real deletedObjects log, but those rows do not identify the program/stage/data element context.'
          : 'This DHIS2 instance does not expose true metadata audit logs via the Web API. Results are derived from created/lastUpdated timestamps on current metadata objects, so field-level before/after diffs and program-scoped deletions are not available.'),
      _truncated: collected.changes.length > limit,
      _total_changes_before_limit: collected.changes.length,
      ...(resolvedProgram._matches ? { _matches: resolvedProgram._matches } : {}),
      ...(deleted._warning ? { _delete_warning: deleted._warning } : {}),
    };
  }

  // ── search_metadata ──
  if (name === 'search_metadata') {
    const type = args.object_type;
    const defaultFields = {
      dataElements: 'id,displayName,displayFormName,code,valueType,description,aggregationType,domainType,optionSet[id,displayName]',
      indicators: 'id,displayName,code,description,numerator,denominator,indicatorType[displayName]',
      organisationUnits: 'id,displayName,code,level,path,parent[id,displayName]',
      optionSets: 'id,displayName,valueType,options[id,displayName,code]',
      dataSets: 'id,displayName,code,periodType,dataSetElements[dataElement[id,displayName]],organisationUnits~size',
      users: 'id,displayName,email,userCredentials[username,lastLogin],organisationUnits[id,displayName]',
      programs: 'id,displayName,programType,trackedEntityType[displayName],programStages~size,programRules::size,programIndicators::size',
      programIndicators: 'id,displayName,description,expression,filter,program[id,displayName]',
    };
    const fields = args.fields || defaultFields[type] || 'id,displayName,code,description';

    if (args.id) {
      return await safeDhis2Fetch(`${type}/${args.id}?fields=${fields}`);
    }

    // Accept the aliases models actually use. `query` was previously IGNORED,
    // so search_metadata(query="X") returned the ENTIRE collection and the
    // model could act on an arbitrary first row — observed live steering a
    // delete toward the wrong program (2026-07-01).
    const nameFilter = args.name_filter || args.query || args.name || args.search || null;

    let path = `${type}?fields=${fields}&pageSize=${args.page_size || 50}`;
    if (nameFilter) path += `&filter=displayName:ilike:${encodeURIComponent(nameFilter)}`;
    if (args.filters?.length) {
      for (const f of args.filters) path += `&filter=${f}`;
    }
    const resp = await safeDhis2Fetch(path);
    // Rank exact displayName matches first, then prefix matches, so "the
    // first result" is the least-surprising object when the model follows up
    // with a destructive action on it.
    if (resp && !resp._error && nameFilter && Array.isArray(resp[type])) {
      const q = String(nameFilter).toLowerCase();
      const rank = (o) => {
        const n = String(o.displayName || '').toLowerCase();
        if (n === q) return 0;
        if (n.startsWith(q)) return 1;
        return 2;
      };
      resp[type] = resp[type].slice().sort((a, b) => rank(a) - rank(b));
    }
    return resp;
  }

  // ── resolve_option_codes ──
  if (name === 'resolve_option_codes') {
    const result = {};
    const chunk50 = (arr) => {
      const out = [];
      for (let i = 0; i < arr.length; i += 50) out.push(arr.slice(i, i + 50));
      return out;
    };

    const optBatches = args.option_codes?.length ? chunk50(args.option_codes) : [];
    const deBatches = args.data_element_ids?.length ? chunk50(args.data_element_ids) : [];
    const ouIds = args.org_unit_ids?.length ? args.org_unit_ids : null;

    const [optResps, deResps, ouResp] = await Promise.all([
      Promise.all(optBatches.map(batch => safeDhis2Fetch(
        `options?filter=code:in:[${batch.join(',')}]&fields=code,displayName&paging=false`
      ))),
      Promise.all(deBatches.map(batch => safeDhis2Fetch(
        `dataElements?filter=id:in:[${batch.join(',')}]&fields=id,displayName,displayFormName&paging=false`
      ))),
      ouIds
        ? safeDhis2Fetch(`organisationUnits?filter=id:in:[${ouIds.join(',')}]&fields=id,displayName&paging=false`)
        : Promise.resolve(null),
    ]);

    if (args.option_codes?.length) {
      result.options = {};
      for (const resp of optResps) {
        if (resp?._error) { console.warn('[resolve_option_codes] options fetch failed:', resp._error); continue; }
        for (const opt of resp?.options || []) {
          result.options[opt.code] = opt.displayName;
        }
      }
      for (const code of args.option_codes) {
        if (!(code in result.options)) result.options[code] = null;
      }
    }

    if (args.data_element_ids?.length) {
      result.dataElements = {};
      for (const resp of deResps) {
        if (resp?._error) { console.warn('[resolve_option_codes] dataElements fetch failed:', resp._error); continue; }
        for (const de of resp?.dataElements || []) {
          result.dataElements[de.id] = de.displayFormName || de.displayName;
        }
      }
    }

    if (ouIds) {
      result.orgUnits = {};
      if (!ouResp?._error) {
        for (const ou of ouResp?.organisationUnits || []) {
          result.orgUnits[ou.id] = ou.displayName;
        }
      }
    }

    return result;
  }

  // ── browse_web ──
  if (name === 'browse_web') {
    return await tavilySearch(args);
  }

  // ── line_listing_guide ──
  if (name === 'line_listing_guide') {
    const loaded = await ensureLineListingAssetsLoaded();
    if (!loaded || !lineListingAssets.toolJson) {
      return { _error: 'Line Listing guidance assets are not available.' };
    }
    const forceBlocks = Array.isArray(args.force_blocks) ? args.force_blocks.filter(x => typeof x === 'string') : [];
    const blockIds = forceBlocks.length
      ? [...new Set(forceBlocks)].sort()
      : routeLineListingBlocks(args.query || '', !!args.is_screenshot);
    const blocks = loadLineListingBlocks(blockIds);
    return {
      app: 'Line Listing',
      query: args.query || '',
      block_ids: blockIds,
      blocks,
      source: {
        json: LINE_LISTING_JSON_PATH,
        system_prompt: LINE_LISTING_SYSTEM_PROMPT_PATH,
      },
      usage: {
        mode: 'route-first',
        note: 'Use only returned blocks for this answer.',
      },
    };
  }

  // ── get_visualization_details ──
  if (name === 'get_visualization_details') {
    const ctxVizId = ctx.visualizationId || dhis2.visualizationContext?.id;
    const argVizId = extractVisualizationIdFromInput(args.visualization_id);
    const textVizId = extractVisualizationIdFromText(lastUserText);
    const vid = argVizId || ctxVizId || textVizId;
    if (!vid) {
      return {
        _error: 'No visualization ID in context.',
        _hint: 'Open a Data Visualizer URL like apps/data-visualizer#/XGcG2PFIvOU or pass visualization_id.'
      };
    }

    // Guard: reject IDs that are actually programs or stages (not visualizations)
    if (vid === dhis2.programMetadata?.id) {
      return {
        _error: `"${vid}" is a program ID ("${dhis2.programMetadata.displayName}"), not a visualization. Use get_program_info or search_metadata instead.`,
      };
    }
    if (dhis2.programMetadata?.programStages?.some(s => s.id === vid)) {
      const stage = dhis2.programMetadata.programStages.find(s => s.id === vid);
      return {
        _error: `"${vid}" is a program stage ("${stage.displayName}"), not a visualization. Use get_program_info(info_type="stage_details", target_id="${vid}") or search_metadata instead.`,
      };
    }

    // Guard: reject obviously-non-UID tokens (English words like "Respiratory"
    // that happen to be 11 chars). Real DHIS2 UIDs always have a digit or
    // interior case mix; bare dictionary words do not.
    if (!isLikelyDhisUid(vid)) {
      return {
        _error: `"${vid}" does not look like a valid DHIS2 visualization UID.`,
        _hint: 'UIDs are 11 chars of mixed case + digits (e.g. XGcG2PFIvOU). If the user asked to create/search for something, use create_metadata or search_metadata instead of get_visualization_details.',
      };
    }

    const defPath = `visualizations/${vid}.json?fields=:all`;
    const viz = await safeDhis2Fetch(defPath);
    if (viz._error) return viz;

    // ── Parse layout dimensions correctly ──
    // DHIS2 columns/rows/filters use {id:"dx"} or {dimension:"dx", items:[...]} format
    const parseDimAxis = (arr = []) => arr.map(a => {
      const dimId = a?.dimension || a?.id || null;
      const items = (a?.items || []).map(it => ({
        id: it?.id || null,
        name: it?.displayName || it?.name || it?.id || null,
        type: it?.dimensionItemType || null,
      }));
      return { dimension: dimId, items };
    });

    // ── Extract data dimension items with IDs ──
    const dataItems = (viz.dataDimensionItems || []).map(it => {
      if (it.indicator?.id) return { type: 'INDICATOR', id: it.indicator.id, name: it.indicator.name || it.indicator.displayName || null };
      if (it.dataElement?.id) return { type: 'DATA_ELEMENT', id: it.dataElement.id, name: it.dataElement.name || it.dataElement.displayName || null };
      if (it.programIndicator?.id) return { type: 'PROGRAM_INDICATOR', id: it.programIndicator.id, name: it.programIndicator.name || it.programIndicator.displayName || null };
      if (it.reportingRate?.id) return { type: 'REPORTING_RATE', id: it.reportingRate.id, name: it.reportingRate.name || it.reportingRate.displayName || null };
      return null;
    }).filter(Boolean);

    // ── Batch-resolve data item names and descriptions ──
    // Group every item by type because descriptions are needed even when a
    // display name was embedded in the visualization response.
    const allIndicatorIds = dataItems.filter(d => d.type === 'INDICATOR').map(d => d.id);
    const allDataElementIds = dataItems.filter(d => d.type === 'DATA_ELEMENT').map(d => d.id);
    const allProgramIndicatorIds = dataItems.filter(d => d.type === 'PROGRAM_INDICATOR').map(d => d.id);

    // Fetch detailed metadata for ALL data items (not just unresolved) to get descriptions
    const metadataMap = {};
    const fetchPromises = [];

    if (allIndicatorIds.length) {
      fetchPromises.push(
        safeDhis2Fetch(`indicators.json?filter=id:in:[${allIndicatorIds.join(',')}]&fields=id,displayName,displayShortName,description,numeratorDescription,denominatorDescription,indicatorType[displayName]&paging=false`)
          .then(resp => {
            for (const ind of (resp.indicators || [])) {
              metadataMap[ind.id] = {
                name: ind.displayName,
                shortName: ind.displayShortName || null,
                description: ind.description || null,
                numeratorDescription: ind.numeratorDescription || null,
                denominatorDescription: ind.denominatorDescription || null,
                indicatorType: ind.indicatorType?.displayName || null,
              };
            }
          }).catch(() => {})
      );
    }
    if (allDataElementIds.length) {
      fetchPromises.push(
        safeDhis2Fetch(`dataElements.json?filter=id:in:[${allDataElementIds.join(',')}]&fields=id,displayName,displayShortName,description,valueType,categoryCombo[displayName],dataElementGroups[displayName]&paging=false`)
          .then(resp => {
            for (const de of (resp.dataElements || [])) {
              metadataMap[de.id] = {
                name: de.displayName,
                shortName: de.displayShortName || null,
                description: de.description || null,
                valueType: de.valueType || null,
                categoryCombo: de.categoryCombo?.displayName || null,
                groups: (de.dataElementGroups || []).map(g => g.displayName),
              };
            }
          }).catch(() => {})
      );
    }
    if (allProgramIndicatorIds.length) {
      fetchPromises.push(
        safeDhis2Fetch(`programIndicators.json?filter=id:in:[${allProgramIndicatorIds.join(',')}]&fields=id,displayName,displayShortName,description,expression,filter,program[displayName]&paging=false`)
          .then(resp => {
            for (const pi of (resp.programIndicators || [])) {
              metadataMap[pi.id] = {
                name: pi.displayName,
                shortName: pi.displayShortName || null,
                description: pi.description || null,
                program: pi.program?.displayName || null,
              };
            }
          }).catch(() => {})
      );
    }

    // Resolve fixed org unit names if any
    const fixedOuIds = (viz.organisationUnits || []).map(o => o.id).filter(Boolean);
    if (fixedOuIds.length) {
      fetchPromises.push(
        safeDhis2Fetch(`organisationUnits.json?filter=id:in:[${fixedOuIds.join(',')}]&fields=id,displayName,level,path&paging=false`)
          .then(resp => {
            for (const ou of (resp.organisationUnits || [])) {
              metadataMap[`ou_${ou.id}`] = { name: ou.displayName, level: ou.level };
            }
          }).catch(() => {})
      );
    }

    // Resolve fixed period display names
    const fixedPeriodIds = (viz.periods || []).map(p => p.id).filter(Boolean);

    await Promise.all(fetchPromises);

    // ── Enrich data items with resolved metadata ──
    const enrichedDataItems = dataItems.map(item => {
      const meta = metadataMap[item.id];
      const enriched = {
        type: item.type,
        id: item.id,
        name: meta?.name || item.name || item.id,
      };
      if (meta?.shortName) enriched.shortName = meta.shortName;
      if (meta?.description) enriched.description = meta.description;
      if (item.type === 'INDICATOR') {
        if (meta?.numeratorDescription) enriched.numerator = meta.numeratorDescription;
        if (meta?.denominatorDescription) enriched.denominator = meta.denominatorDescription;
        if (meta?.indicatorType) enriched.indicatorType = meta.indicatorType;
      }
      if (item.type === 'DATA_ELEMENT') {
        if (meta?.valueType) enriched.valueType = meta.valueType;
        if (meta?.categoryCombo) enriched.categoryCombo = meta.categoryCombo;
        if (meta?.groups?.length) enriched.groups = meta.groups;
      }
      if (item.type === 'PROGRAM_INDICATOR') {
        if (meta?.program) enriched.program = meta.program;
      }
      return enriched;
    });

    // ── Period scope with human-readable descriptions ──
    const rawPeriods = Array.isArray(viz.rawPeriods) ? viz.rawPeriods : [];
    const relPeriods = getRelativePeriodKeys(viz.relativePeriods);
    const periodTokens = fixedPeriodIds.length ? fixedPeriodIds : rawPeriods.length ? rawPeriods : relPeriods;
    const periodDescriptions = periodTokens.map(t => {
      const map = {
        'THIS_YEAR': 'Current year', 'LAST_YEAR': 'Previous year',
        'THIS_MONTH': 'Current month', 'LAST_MONTH': 'Previous month',
        'THIS_QUARTER': 'Current quarter', 'LAST_QUARTER': 'Previous quarter',
        'LAST_12_MONTHS': 'Last 12 months', 'LAST_6_MONTHS': 'Last 6 months',
        'LAST_3_MONTHS': 'Last 3 months', 'MONTHS_THIS_YEAR': 'All months this year',
        'QUARTERS_THIS_YEAR': 'All quarters this year', 'LAST_4_QUARTERS': 'Last 4 quarters',
        'LAST_5_YEARS': 'Last 5 years', 'LAST_10_YEARS': 'Last 10 years',
        'MONTHS_LAST_YEAR': 'All months last year', 'QUARTERS_LAST_YEAR': 'All quarters last year',
        'THIS_SIX_MONTH': 'Current six-month period', 'LAST_SIX_MONTH': 'Previous six-month period',
        'LAST_52_WEEKS': 'Last 52 weeks', 'LAST_12_WEEKS': 'Last 12 weeks',
        'THIS_WEEK': 'Current week', 'LAST_WEEK': 'Previous week',
        'THIS_FINANCIAL_YEAR': 'Current financial year', 'LAST_FINANCIAL_YEAR': 'Previous financial year',
      };
      return { token: t, description: map[t] || t };
    });
    const periodScope = {
      fixed_period_ids: fixedPeriodIds,
      raw_period_tokens: rawPeriods,
      relative_periods_enabled: relPeriods,
      resolved_tokens: periodDescriptions,
      summary: periodDescriptions.map(p => p.description).join(', ') || 'No periods specified',
    };

    // ── Org unit scope with resolved names ──
    const resolvedOrgUnits = fixedOuIds.map(id => {
      const meta = metadataMap[`ou_${id}`];
      return { id, name: meta?.name || id, level: meta?.level || null };
    });
    const ouScopeFlags = [];
    if (viz.userOrganisationUnit) ouScopeFlags.push('USER_ORGUNIT');
    if (viz.userOrganisationUnitChildren) ouScopeFlags.push('USER_ORGUNIT_CHILDREN');
    if (viz.userOrganisationUnitGrandChildren) ouScopeFlags.push('USER_ORGUNIT_GRANDCHILDREN');
    const ouScopeSummary = resolvedOrgUnits.length
      ? resolvedOrgUnits.map(o => o.name).join(', ')
      : ouScopeFlags.length
        ? ouScopeFlags.map(f => {
            if (f === 'USER_ORGUNIT') return "Logged-in user's assigned organisation unit";
            if (f === 'USER_ORGUNIT_CHILDREN') return "Children of user's assigned org unit";
            return "Grandchildren of user's assigned org unit";
          }).join('; ')
        : 'No org unit scope specified';
    const ouScope = {
      fixed_org_units: resolvedOrgUnits,
      user_org_unit: !!viz.userOrganisationUnit,
      user_org_unit_children: !!viz.userOrganisationUnitChildren,
      user_org_unit_grandchildren: !!viz.userOrganisationUnitGrandChildren,
      org_unit_levels: viz.organisationUnitLevels || [],
      summary: ouScopeSummary,
    };

    // ── Layout summary for LLM ──
    const vizTypeFriendly = {
      'COLUMN': 'Column Chart', 'BAR': 'Bar Chart', 'LINE': 'Line Chart',
      'AREA': 'Area Chart', 'PIE': 'Pie Chart', 'RADAR': 'Radar Chart',
      'GAUGE': 'Gauge Chart', 'YEAR_OVER_YEAR_LINE': 'Year-over-Year Line',
      'YEAR_OVER_YEAR_COLUMN': 'Year-over-Year Column', 'SINGLE_VALUE': 'Single Value',
      'PIVOT_TABLE': 'Pivot Table', 'SCATTER': 'Scatter Plot',
      'STACKED_COLUMN': 'Stacked Column Chart', 'STACKED_BAR': 'Stacked Bar Chart',
      'STACKED_AREA': 'Stacked Area Chart',
    };
    const colDims = (viz.columnDimensions || []);
    const rowDims = (viz.rowDimensions || []);
    const filterDims = (viz.filterDimensions || []);
    const dimLabel = (d) => {
      if (d === 'dx') return 'Data (measures/indicators)';
      if (d === 'pe') return 'Period';
      if (d === 'ou') return 'Organisation Unit';
      return d;
    };
    const layoutSummary = {
      columns: colDims.map(dimLabel).join(', ') || 'None',
      rows: rowDims.map(dimLabel).join(', ') || 'None',
      filters: filterDims.map(dimLabel).join(', ') || 'None',
      explanation: `Columns show ${colDims.map(dimLabel).join(', ') || 'nothing'}. Rows show ${rowDims.map(dimLabel).join(', ') || 'nothing'}. Filtered by ${filterDims.map(dimLabel).join(', ') || 'nothing'}.`,
    };

    // ── Build analytics blueprint ──
    const analyticsBlueprint = buildVisualizationAnalyticsBlueprint(viz);

    // ── Analytics preview with name resolution ──
    const previewLimit = Math.max(1, Math.min(200, Number(args.analytics_preview_limit) || 100));
    const includePreview = args.include_analytics_preview !== false;
    let analyticsPreview = null;
    let analyticsPreviewError = null;
    let valuesStatus = {
      available: null,
      source: null,
      reason: null,
      evidence: [],
    };
    if (includePreview) {
      const previewPath = appendQueryParamsToPath(analyticsBlueprint.endpoint, {
        pageSize: previewLimit,
        skipMeta: false,
      });
      const previewResp = await safeDhis2Fetch(previewPath);
      if (previewResp._error) {
        analyticsPreviewError = previewResp._error;
        valuesStatus.evidence.push({
          endpoint: `/api/${dhis2.apiVersion}/${previewPath}`,
          status: previewResp._status || null,
          error: previewResp._error,
        });
      } else {
        analyticsPreview = previewResp;
        valuesStatus.available = true;
        valuesStatus.source = 'analytics_blueprint';
      }

      if (!analyticsPreview) {
        const vizDataPath = `visualizations/${vid}/data.json`;
        const vizDataResp = await safeDhis2Fetch(vizDataPath);
        if (!vizDataResp._error) {
          analyticsPreview = vizDataResp;
          analyticsPreviewError = null;
          valuesStatus.available = true;
          valuesStatus.source = 'visualization_data';
        } else {
          valuesStatus.evidence.push({
            endpoint: `/api/${dhis2.apiVersion}/${vizDataPath}`,
            status: vizDataResp._status || null,
            error: vizDataResp._error,
          });
          const errText = String(vizDataResp._error || '').toLowerCase();
          if (errText.includes('referenced table does not exist') || errText.includes('analytics job was run')) {
            valuesStatus.available = false;
            valuesStatus.reason = 'analytics_tables_missing';
          } else if (analyticsPreviewError && String(analyticsPreviewError).toLowerCase().includes('end date was not specified')) {
            valuesStatus.available = false;
            valuesStatus.reason = 'analytics_query_incomplete';
          } else {
            valuesStatus.available = false;
            valuesStatus.reason = 'analytics_unavailable';
          }
        }
      }

      // If analytics preview succeeded, enrich row values with resolved names from metaData
      if (analyticsPreview && analyticsPreview.metaData?.items) {
        const metaItems = analyticsPreview.metaData.items;
        // Build a friendly data table from headers + rows
        const headers = (analyticsPreview.headers || []).map(h => h.name || h.column);
        if (analyticsPreview.rows?.length && headers.length) {
          analyticsPreview._resolved_table = analyticsPreview.rows.map(row => {
            const obj = {};
            headers.forEach((h, i) => {
              const rawVal = row[i];
              const metaItem = metaItems[rawVal];
              obj[h] = metaItem?.name || rawVal;
            });
            return obj;
          });
        }
      }
    }

    // ── Build human-readable explanation for LLM ──
    const dataItemsSummary = enrichedDataItems.map(d => {
      let s = `${d.name} (${d.type})`;
      if (d.description) s += ` — ${d.description}`;
      if (d.numerator && d.denominator) s += ` [Numerator: ${d.numerator}, Denominator: ${d.denominator}]`;
      return s;
    }).join('\n  - ');

    const humanSummary = [
      `**${viz.displayName || viz.name || vid}** is a **${vizTypeFriendly[viz.type] || viz.type || 'visualization'}**.`,
      ``,
      `**What it measures:** ${enrichedDataItems.map(d => d.name).join(', ')}`,
      `**Period:** ${periodScope.summary}`,
      `**Organisation Unit scope:** ${ouScope.summary}`,
      `**Layout:** ${layoutSummary.explanation}`,
      enrichedDataItems.some(d => d.description) ? `\n**Data item details:**\n  - ${dataItemsSummary}` : '',
      valuesStatus.available === false ? `\n_Note: Actual data values are not available on this instance${valuesStatus.reason === 'analytics_tables_missing' ? ' (analytics tables not generated)' : ''}, but the visualization definition above fully describes what this chart is designed to show._` : '',
    ].filter(Boolean).join('\n');

    // Keep a light cached summary in state for UI context chips and follow-up questions
    dhis2.visualizationContext = {
      id: viz.id || vid,
      name: viz.displayName || viz.name || vid,
      type: viz.type || null,
      lastUpdated: viz.lastUpdated || null,
      owner: viz.user?.displayName || null,
    };

    return {
      visualization: {
        id: viz.id || vid,
        name: viz.displayName || viz.name || vid,
        type: viz.type || null,
        type_friendly: vizTypeFriendly[viz.type] || viz.type || null,
        description: viz.description || null,
        created: viz.created || null,
        last_updated: viz.lastUpdated || null,
        owner: viz.user?.displayName || null,
      },
      human_summary: humanSummary,
      layout: {
        columns: parseDimAxis(viz.columns),
        rows: parseDimAxis(viz.rows),
        filters: parseDimAxis(viz.filters),
        column_dimensions: colDims,
        row_dimensions: rowDims,
        filter_dimensions: filterDims,
        layout_summary: layoutSummary,
        data_items: enrichedDataItems,
      },
      scope: {
        periods: periodScope,
        org_units: ouScope,
      },
      chart_settings: {
        aggregation_type: viz.aggregationType || 'DEFAULT',
        cumulative_values: !!viz.cumulativeValues,
        percent_stacked: !!viz.percentStackedValues,
        show_data: !!viz.showData,
        hide_empty_rows: !!viz.hideEmptyRows,
        hide_empty_columns: !!viz.hideEmptyColumns,
        hide_legend: !!viz.hideLegend,
        regression_type: viz.regressionType || 'NONE',
        sort_order: viz.sortOrder || 0,
        digit_group_separator: viz.digitGroupSeparator || 'SPACE',
      },
      api_endpoints: {
        visualization_definition: `/api/${dhis2.apiVersion}/${defPath}`,
        visualization_render_png: `/api/${dhis2.apiVersion}/visualizations/${vid}/data`,
        analytics_blueprint: `/api/${dhis2.apiVersion}/${analyticsBlueprint.endpoint}`,
      },
      analytics_blueprint: analyticsBlueprint,
      analytics_preview: analyticsPreview || undefined,
      analytics_preview_error: analyticsPreviewError || undefined,
      values_status: includePreview ? valuesStatus : undefined,
      _apiPath: viz._apiPath,
      full_definition: args.include_full_definition === false ? undefined : viz,
    };
  }

  // ── get_map_details ──
  if (name === 'get_map_details') {
    const ctxMapId = ctx.mapId || dhis2.mapContext?.id;
    const argMapId = extractMapIdFromInput(args.map_id);
    const textMapId = extractMapIdFromText(lastUserText);
    const mid = argMapId || ctxMapId || textMapId;
    if (!mid) {
      return {
        _error: 'No map ID in context.',
        _hint: 'Open a Maps URL like apps/maps#/voX07ulo2Bq or pass map_id.'
      };
    }

    if (!isLikelyDhisUid(mid)) {
      return {
        _error: `"${mid}" does not look like a valid DHIS2 map UID.`,
        _hint: 'UIDs are 11 chars of mixed case + digits. If the user asked to create/search for something, use create_metadata or search_metadata instead.',
      };
    }

    const defPath = `maps/${mid}.json?fields=:all`;
    const mapDef = await safeDhis2Fetch(defPath);
    if (mapDef._error) return mapDef;

    const mapViews = mapDef.mapViews || [];
    const metadataMap = {};
    const fetchPromises = [];

    // Collect all IDs that need resolution across all layers
    const allIndicatorIds = new Set();
    const allDataElementIds = new Set();
    const allProgramIndicatorIds = new Set();
    const allOuIds = new Set();
    const allProgramIds = new Set();
    const allLegendSetIds = new Set();
    const allOuGroupSetIds = new Set();

    for (const mv of mapViews) {
      for (const item of (mv.dataDimensionItems || [])) {
        if (item.indicator?.id) allIndicatorIds.add(item.indicator.id);
        if (item.dataElement?.id) allDataElementIds.add(item.dataElement.id);
        if (item.programIndicator?.id) allProgramIndicatorIds.add(item.programIndicator.id);
      }
      for (const ou of (mv.organisationUnits || [])) {
        if (ou.id) allOuIds.add(ou.id);
      }
      if (mv.program?.id) allProgramIds.add(mv.program.id);
      if (mv.legendSet?.id) allLegendSetIds.add(mv.legendSet.id);
      if (mv.organisationUnitGroupSet?.id) allOuGroupSetIds.add(mv.organisationUnitGroupSet.id);
    }

    // Batch-resolve indicators
    if (allIndicatorIds.size) {
      fetchPromises.push(
        safeDhis2Fetch(`indicators.json?filter=id:in:[${[...allIndicatorIds].join(',')}]&fields=id,displayName,displayShortName,description,numeratorDescription,denominatorDescription,indicatorType[displayName]&paging=false`)
          .then(resp => {
            for (const ind of (resp.indicators || [])) {
              metadataMap[ind.id] = {
                name: ind.displayName,
                shortName: ind.displayShortName || null,
                description: ind.description || null,
                numeratorDescription: ind.numeratorDescription || null,
                denominatorDescription: ind.denominatorDescription || null,
                indicatorType: ind.indicatorType?.displayName || null,
              };
            }
          }).catch(() => {})
      );
    }

    // Batch-resolve data elements
    if (allDataElementIds.size) {
      fetchPromises.push(
        safeDhis2Fetch(`dataElements.json?filter=id:in:[${[...allDataElementIds].join(',')}]&fields=id,displayName,displayShortName,description,valueType&paging=false`)
          .then(resp => {
            for (const de of (resp.dataElements || [])) {
              metadataMap[de.id] = {
                name: de.displayName,
                shortName: de.displayShortName || null,
                description: de.description || null,
                valueType: de.valueType || null,
              };
            }
          }).catch(() => {})
      );
    }

    // Batch-resolve program indicators
    if (allProgramIndicatorIds.size) {
      fetchPromises.push(
        safeDhis2Fetch(`programIndicators.json?filter=id:in:[${[...allProgramIndicatorIds].join(',')}]&fields=id,displayName,description,program[displayName]&paging=false`)
          .then(resp => {
            for (const pi of (resp.programIndicators || [])) {
              metadataMap[pi.id] = {
                name: pi.displayName,
                description: pi.description || null,
                program: pi.program?.displayName || null,
              };
            }
          }).catch(() => {})
      );
    }

    // Batch-resolve org units
    if (allOuIds.size) {
      fetchPromises.push(
        safeDhis2Fetch(`organisationUnits.json?filter=id:in:[${[...allOuIds].join(',')}]&fields=id,displayName,level&paging=false`)
          .then(resp => {
            for (const ou of (resp.organisationUnits || [])) {
              metadataMap[`ou_${ou.id}`] = { name: ou.displayName, level: ou.level };
            }
          }).catch(() => {})
      );
    }

    // Batch-resolve programs
    if (allProgramIds.size) {
      fetchPromises.push(
        safeDhis2Fetch(`programs.json?filter=id:in:[${[...allProgramIds].join(',')}]&fields=id,displayName,programType&paging=false`)
          .then(resp => {
            for (const prog of (resp.programs || [])) {
              metadataMap[`prog_${prog.id}`] = { name: prog.displayName, programType: prog.programType };
            }
          }).catch(() => {})
      );
    }

    // Batch-resolve legend sets
    if (allLegendSetIds.size) {
      fetchPromises.push(
        safeDhis2Fetch(`legendSets.json?filter=id:in:[${[...allLegendSetIds].join(',')}]&fields=id,displayName,legends[id,displayName,startValue,endValue,color]&paging=false`)
          .then(resp => {
            for (const ls of (resp.legendSets || [])) {
              metadataMap[`legend_${ls.id}`] = {
                name: ls.displayName,
                legends: (ls.legends || []).map(l => ({
                  name: l.displayName, start: l.startValue, end: l.endValue, color: l.color,
                })),
              };
            }
          }).catch(() => {})
      );
    }

    // Batch-resolve org unit group sets
    if (allOuGroupSetIds.size) {
      fetchPromises.push(
        safeDhis2Fetch(`organisationUnitGroupSets.json?filter=id:in:[${[...allOuGroupSetIds].join(',')}]&fields=id,displayName,organisationUnitGroups[id,displayName]&paging=false`)
          .then(resp => {
            for (const gs of (resp.organisationUnitGroupSets || [])) {
              metadataMap[`ougs_${gs.id}`] = {
                name: gs.displayName,
                groups: (gs.organisationUnitGroups || []).map(g => g.displayName),
              };
            }
          }).catch(() => {})
      );
    }

    await Promise.all(fetchPromises);

    // ── Parse each mapView/layer ──
    const layerTypeFriendly = {
      'thematic': 'Thematic', 'thematic1': 'Thematic', 'thematic2': 'Thematic (2nd)',
      'thematic3': 'Thematic (3rd)', 'thematic4': 'Thematic (4th)',
      'boundary': 'Boundary', 'facility': 'Facility',
      'event': 'Event', 'earthEngine': 'Earth Engine', 'external': 'External Tile',
    };

    const parsedLayers = mapViews.map((mv, idx) => {
      const layerType = mv.layer || 'unknown';
      const friendly = layerTypeFriendly[layerType] || layerType;

      // Data items
      const dataItems = (mv.dataDimensionItems || []).map(it => {
        if (it.indicator?.id) {
          const meta = metadataMap[it.indicator.id];
          return {
            type: 'INDICATOR', id: it.indicator.id,
            name: meta?.name || it.indicator.displayName || it.indicator.id,
            description: meta?.description || null,
            numerator: meta?.numeratorDescription || null,
            denominator: meta?.denominatorDescription || null,
            indicatorType: meta?.indicatorType || null,
          };
        }
        if (it.dataElement?.id) {
          const meta = metadataMap[it.dataElement.id];
          return {
            type: 'DATA_ELEMENT', id: it.dataElement.id,
            name: meta?.name || it.dataElement.displayName || it.dataElement.id,
            description: meta?.description || null,
            valueType: meta?.valueType || null,
          };
        }
        if (it.programIndicator?.id) {
          const meta = metadataMap[it.programIndicator.id];
          return {
            type: 'PROGRAM_INDICATOR', id: it.programIndicator.id,
            name: meta?.name || it.programIndicator.displayName || it.programIndicator.id,
            description: meta?.description || null,
            program: meta?.program || null,
          };
        }
        return null;
      }).filter(Boolean);

      // Org units
      const fixedOus = (mv.organisationUnits || []).map(o => {
        const meta = metadataMap[`ou_${o.id}`];
        return { id: o.id, name: meta?.name || o.id, level: meta?.level || null };
      });
      const ouLevels = mv.organisationUnitLevels || [];
      const ouScopeFlags = [];
      if (mv.userOrganisationUnit) ouScopeFlags.push('USER_ORGUNIT');
      if (mv.userOrganisationUnitChildren) ouScopeFlags.push('USER_ORGUNIT_CHILDREN');
      if (mv.userOrganisationUnitGrandChildren) ouScopeFlags.push('USER_ORGUNIT_GRANDCHILDREN');
      const ouSummary = fixedOus.length
        ? fixedOus.map(o => o.name).join(', ') + (ouLevels.length ? ` at level(s) ${ouLevels.join(', ')}` : '')
        : ouScopeFlags.length
          ? ouScopeFlags.map(f => {
              if (f === 'USER_ORGUNIT') return "User's org unit";
              if (f === 'USER_ORGUNIT_CHILDREN') return "Children of user's org unit";
              return "Grandchildren of user's org unit";
            }).join('; ') + (ouLevels.length ? ` at level(s) ${ouLevels.join(', ')}` : '')
          : ouLevels.length ? `Org unit level(s) ${ouLevels.join(', ')}` : 'Not specified';

      // Periods
      const rawPeriods = Array.isArray(mv.rawPeriods) ? mv.rawPeriods : [];
      const relPeriods = getRelativePeriodKeys(mv.relativePeriods);
      const fixedPeriodIds = (mv.periods || []).map(p => p.id).filter(Boolean);
      const periodTokens = fixedPeriodIds.length ? fixedPeriodIds : rawPeriods.length ? rawPeriods : relPeriods;
      const periodMap = {
        'THIS_YEAR': 'Current year', 'LAST_YEAR': 'Previous year',
        'THIS_MONTH': 'Current month', 'LAST_MONTH': 'Previous month',
        'THIS_QUARTER': 'Current quarter', 'LAST_QUARTER': 'Previous quarter',
        'LAST_12_MONTHS': 'Last 12 months', 'LAST_6_MONTHS': 'Last 6 months',
        'LAST_3_MONTHS': 'Last 3 months', 'MONTHS_THIS_YEAR': 'All months this year',
        'LAST_5_YEARS': 'Last 5 years', 'LAST_52_WEEKS': 'Last 52 weeks',
      };
      const periodSummary = periodTokens.map(t => periodMap[t] || t).join(', ') || 'No period specified';

      // Layer-specific details
      const layerDetails = { type: friendly, layer_id: mv.id };

      if (layerType.startsWith('thematic')) {
        layerDetails.thematicMapType = mv.thematicMapType || 'CHOROPLETH';
        layerDetails.classes = mv.classes || null;
        layerDetails.method = mv.method || null;
        layerDetails.colorScale = mv.colorScale || null;
        if (mv.legendSet?.id) {
          const ls = metadataMap[`legend_${mv.legendSet.id}`];
          layerDetails.legendSet = ls ? { name: ls.name, legends: ls.legends } : { id: mv.legendSet.id };
        }
        layerDetails.radiusLow = mv.radiusLow || null;
        layerDetails.radiusHigh = mv.radiusHigh || null;
      }

      if (layerType === 'event') {
        const progMeta = mv.program?.id ? metadataMap[`prog_${mv.program.id}`] : null;
        layerDetails.program = progMeta ? { id: mv.program.id, name: progMeta.name, type: progMeta.programType }
          : mv.program?.id ? { id: mv.program.id } : null;
        layerDetails.programStage = mv.programStage?.id || null;
        layerDetails.eventClustering = !!mv.eventClustering;
        layerDetails.eventPointColor = mv.eventPointColor || null;
        layerDetails.eventPointRadius = mv.eventPointRadius || null;
        if (mv.styleDataItem?.id) {
          layerDetails.styleDataItem = { id: mv.styleDataItem.id, valueType: mv.styleDataItem.valueType || null };
        }
      }

      if (layerType === 'facility') {
        if (mv.organisationUnitGroupSet?.id) {
          const gsMeta = metadataMap[`ougs_${mv.organisationUnitGroupSet.id}`];
          layerDetails.organisationUnitGroupSet = gsMeta
            ? { id: mv.organisationUnitGroupSet.id, name: gsMeta.name, groups: gsMeta.groups }
            : { id: mv.organisationUnitGroupSet.id };
        }
      }

      if (layerType === 'earthEngine' || layerType === 'external') {
        try {
          layerDetails.config = typeof mv.config === 'string' ? JSON.parse(mv.config) : mv.config || null;
        } catch {
          layerDetails.config = mv.config || null;
        }
      }

      layerDetails.opacity = mv.opacity != null ? mv.opacity : null;
      layerDetails.hidden = !!mv.hidden;
      layerDetails.labels = !!mv.labels;

      return {
        index: idx,
        ...layerDetails,
        data_items: dataItems,
        org_units: { fixed: fixedOus, levels: ouLevels, flags: ouScopeFlags, summary: ouSummary },
        periods: { tokens: periodTokens, summary: periodSummary },
      };
    });

    // ── Analytics preview for thematic layers ──
    const includePreview = args.include_analytics_preview !== false;
    const previewLimit = Math.max(1, Math.min(200, Number(args.analytics_preview_limit) || 50));
    const layerPreviews = {};

    if (includePreview) {
      for (const layer of parsedLayers) {
        if (!layer.type.startsWith('Thematic') || !layer.data_items.length) continue;
        const mv = mapViews[layer.index];
        const blueprint = buildVisualizationAnalyticsBlueprint(mv);
        if (!blueprint.endpoint || blueprint.endpoint === 'analytics.json') continue;

        const previewPath = appendQueryParamsToPath(blueprint.endpoint, { pageSize: previewLimit, skipMeta: false });
        const previewResp = await safeDhis2Fetch(previewPath);
        if (!previewResp._error && previewResp.rows?.length) {
          // Resolve names from metaData
          const metaItems = previewResp.metaData?.items || {};
          const headers = (previewResp.headers || []).map(h => h.name || h.column);
          const resolvedTable = previewResp.rows.map(row => {
            const obj = {};
            headers.forEach((h, i) => {
              const rawVal = row[i];
              const metaItem = metaItems[rawVal];
              obj[h] = metaItem?.name || rawVal;
            });
            return obj;
          });
          layerPreviews[layer.layer_id] = {
            available: true,
            endpoint: `/api/${dhis2.apiVersion}/${previewPath}`,
            row_count: previewResp.rows.length,
            resolved_table: resolvedTable.slice(0, previewLimit),
          };
        } else {
          layerPreviews[layer.layer_id] = {
            available: false,
            reason: previewResp._error || 'No data returned',
          };
        }
      }
    }

    // ── Build human-readable summary ──
    const layerSummaries = parsedLayers.map((l, i) => {
      let desc = `**Layer ${i + 1}: ${l.type}**`;
      if (l.hidden) desc += ' (hidden)';
      desc += '\n';
      if (l.data_items.length) {
        desc += `  Data: ${l.data_items.map(d => {
          let s = d.name;
          if (d.description) s += ` — ${d.description}`;
          if (d.numerator && d.denominator) s += ` [Num: ${d.numerator}, Den: ${d.denominator}]`;
          return s;
        }).join('; ')}\n`;
      }
      if (l.thematicMapType) desc += `  Style: ${l.thematicMapType}${l.classes ? `, ${l.classes} classes` : ''}\n`;
      if (l.program) desc += `  Program: ${l.program.name || l.program.id}\n`;
      desc += `  Org Units: ${l.org_units.summary}\n`;
      if (l.periods.summary !== 'No period specified') desc += `  Period: ${l.periods.summary}\n`;
      if (l.organisationUnitGroupSet) desc += `  Grouped by: ${l.organisationUnitGroupSet.name || l.organisationUnitGroupSet.id}\n`;
      if (l.config?.id) desc += `  Dataset: ${l.config.id}\n`;
      const preview = layerPreviews[l.layer_id];
      if (preview?.available) desc += `  Data preview: ${preview.row_count} rows available\n`;
      return desc;
    });

    const humanSummary = [
      `**${mapDef.displayName || mapDef.name || mid}** is a **DHIS2 Map** with **${parsedLayers.length} layer(s)**.`,
      ``,
      `**Basemap:** ${mapDef.basemap || 'Default'}`,
      `**Center:** ${mapDef.latitude?.toFixed(4) || '?'}, ${mapDef.longitude?.toFixed(4) || '?'} (zoom ${mapDef.zoom || '?'})`,
      ``,
      ...layerSummaries,
    ].filter(Boolean).join('\n');

    // Update cached context
    dhis2.mapContext = {
      id: mapDef.id || mid,
      name: mapDef.displayName || mapDef.name || mid,
      basemap: mapDef.basemap || null,
      layerCount: parsedLayers.length,
      layers: parsedLayers.map(l => ({ id: l.layer_id, layer: l.type, name: l.data_items[0]?.name || l.type })),
      lastUpdated: mapDef.lastUpdated || null,
      owner: mapDef.user?.displayName || null,
    };

    return {
      map: {
        id: mapDef.id || mid,
        name: mapDef.displayName || mapDef.name || mid,
        description: mapDef.description || null,
        basemap: mapDef.basemap || null,
        latitude: mapDef.latitude || null,
        longitude: mapDef.longitude || null,
        zoom: mapDef.zoom || null,
        created: mapDef.created || null,
        last_updated: mapDef.lastUpdated || null,
        owner: mapDef.user?.displayName || null,
      },
      human_summary: humanSummary,
      layers: parsedLayers,
      layer_analytics_previews: Object.keys(layerPreviews).length ? layerPreviews : undefined,
      api_endpoints: {
        map_definition: `/api/${dhis2.apiVersion}/${defPath}`,
        map_render_png: `/api/${dhis2.apiVersion}/maps/${mid}/data`,
      },
      _apiPath: mapDef._apiPath,
      full_definition: args.include_full_definition === false ? undefined : mapDef,
    };
  }

  // ── detect_enrollment_abnormalities ──
  if (name === 'detect_enrollment_abnormalities') {
    return await detectEnrollmentAbnormalities(args, programId, orgUnitId);
  }

  // ── create_metadata ──
  if (name === 'create_metadata') {
    return await executeCreateMetadata(args, orgUnitId);
  }

  // ── manage_metadata ──
  if (name === 'manage_metadata') {
    return await executeManageMetadata(args);
  }

  // ── manage_program_notifications ──
  if (name === 'manage_program_notifications') {
    return await executeManageProgramNotifications(args);
  }

  // ── architect_metadata ──
  if (name === 'architect_metadata') {
    return await executeArchitectMetadata(args);
  }

  // ── manage_program_rules ──
  if (name === 'manage_program_rules') {
    return await executeManageProgramRules(args, programId);
  }

  // ── manage_program_indicators ──
  if (name === 'manage_program_indicators') {
    return await executeManageProgramIndicators(args, programId);
  }

  // ── render_chart ──
  if (name === 'render_chart') {
    return { success: true, message: 'Chart rendered.' };
  }

  // ── manage_datasets ──
  if (name === 'manage_datasets') {
    return await executeManageDatasets(args);
  }

  // ── manage_custom_forms ──
  if (name === 'manage_custom_forms') {
    return await executeManageCustomForms(args);
  }

  // ── manage_custom_translations ──
  if (name === 'manage_custom_translations') {
    return await executeManageCustomTranslations(args);
  }

  // ── manage_growth_chart_plugin ──
  if (name === 'manage_growth_chart_plugin') {
    return await executeManageGrowthChartPlugin(args);
  }

  // ── manage_validation_rules ──
  if (name === 'manage_validation_rules') {
    return await executeManageValidationRules(args);
  }

  // ── manage_org_units ──
  if (name === 'manage_org_units') {
    return await executeManageOrgUnits(args);
  }

  // ── manage_indicators ──
  if (name === 'manage_indicators') {
    return await executeManageIndicators(args);
  }

  // ── manage_option_sets ──
  if (name === 'manage_option_sets') {
    return await executeManageOptionSets(args);
  }

  // ── manage_legend_sets ──
  if (name === 'manage_legend_sets') {
    return await executeManageLegendSets(args);
  }

  // ── manage_dashboards ──
  if (name === 'manage_dashboards') {
    return await executeManageDashboards(args);
  }

  // ── manage_maps ──
  if (name === 'manage_maps') {
    return await executeManageMaps(args);
  }

  // ── manage_backups ──
  if (name === 'manage_backups') {
    return await executeManageBackups(args);
  }

  return { _error: `Unhandled tool route: ${name}` };
}
