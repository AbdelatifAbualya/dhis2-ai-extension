/*
 * DHIS2 AI Assistant background module: aggregate metadata, datasets, dashboards, forms, translations, plugins, and creation flows.
 * Loaded synchronously by background.js with importScripts(); classic-script
 * global bindings intentionally preserve the original service-worker runtime.
 */

// ── manage_validation_rules: CRUD for DHIS2 validationRules (aggregate data-quality checks) ──

const VALIDATION_OPERATORS = new Set([
  'equal_to', 'not_equal_to', 'greater_than', 'greater_than_or_equal_to',
  'less_than', 'less_than_or_equal_to', 'compulsory_pair', 'exclusive_pair',
]);
const VALIDATION_IMPORTANCE = new Set(['HIGH', 'MEDIUM', 'LOW']);
const VALIDATION_MISSING_STRATEGY = new Set([
  'NEVER_SKIP', 'SKIP_IF_ANY_VALUE_MISSING', 'SKIP_IF_ALL_VALUES_MISSING',
]);

// Server-side validate a validation-rule side expression via DHIS2's
// /api/expressions/description endpoint (GET). This is the authoritative
// validator for validationRule left/right expressions — it confirms the
// #{...} references resolve and the syntax is well-formed.
// Returns { ok: true, description } or { ok: false, error }.
async function describeValidationExpression(expression) {
  const resp = await safeDhis2Fetch(
    `expressions/description?expression=${encodeURIComponent(expression)}`
  );
  if (resp?._error) {
    return { ok: false, error: `Could not reach the expression validator for "${expression}": ${resp._error}` };
  }
  const status = resp?.status;
  if (status && status !== 'OK') {
    return { ok: false, error: resp?.message || 'Expression is not well-formed' };
  }
  return { ok: true, description: resp?.description || '' };
}

async function executeManageValidationRules(args) {
  const action = args?.action;
  if (!action) {
    return {
      _error: 'Missing required parameter: action',
      _hint: 'One of: list, get, create, update, delete.',
    };
  }

  // ── list ──────────────────────────────────────────────────────────────
  if (action === 'list') {
    const filters = [];
    if (args.name_filter) filters.push(`name:ilike:${encodeURIComponent(args.name_filter)}`);
    if (args.importance && VALIDATION_IMPORTANCE.has(args.importance)) filters.push(`importance:eq:${args.importance}`);
    if (args.period_type) filters.push(`periodType:eq:${encodeURIComponent(args.period_type)}`);
    const fp = filters.length ? `&${filters.map(f => `filter=${f}`).join('&')}` : '';
    const pageSize = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    const resp = await safeDhis2Fetch(
      `validationRules?fields=id,displayName,importance,operator,periodType,leftSide[expression],rightSide[expression]&pageSize=${pageSize}${fp}&order=displayName:iasc`
    );
    if (resp?._error) return { _error: `validationRules list failed: ${resp._error}` };
    const rules = (resp.validationRules || []).map(r => ({
      id: r.id,
      name: r.displayName,
      importance: r.importance,
      operator: r.operator,
      periodType: r.periodType,
      leftSide: r.leftSide?.expression,
      rightSide: r.rightSide?.expression,
    }));
    return {
      success: true,
      total: rules.length,
      pager_total: resp.pager?.total ?? null,
      validation_rules: rules,
    };
  }

  // ── get ───────────────────────────────────────────────────────────────
  if (action === 'get') {
    const id = args.rule_id || args.object_id;
    if (!id) return { _error: 'rule_id required for get' };
    const resp = await safeDhis2Fetch(
      `validationRules/${id}?fields=id,displayName,description,instruction,importance,operator,periodType,` +
      `leftSide[expression,description,missingValueStrategy],rightSide[expression,description,missingValueStrategy],sharing,access`
    );
    if (resp?._status === 404) return { _error: `validationRules with id "${id}" does not exist (404).` };
    if (resp?._error) return { _error: `Could not load validation rule ${id}: ${resp._error}` };
    return {
      success: true,
      id: resp.id,
      name: resp.displayName,
      description: resp.description,
      instruction: resp.instruction,
      importance: resp.importance,
      operator: resp.operator,
      periodType: resp.periodType,
      leftSide: resp.leftSide,
      rightSide: resp.rightSide,
      access: resp.access,
    };
  }

  // ── create ────────────────────────────────────────────────────────────
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_validation_rules', 'create');
    if (_gate) return _gate;
    return await createValidationRule(args);
  }

  // ── update ────────────────────────────────────────────────────────────
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_validation_rules', 'update', { rule_id: args.rule_id });
    if (_gate) return _gate;
    const id = args.rule_id || args.object_id;
    if (!id) return { _error: 'rule_id required for update' };
    if (!args.rule || typeof args.rule !== 'object') {
      return {
        _error: 'rule object required for update',
        _hint: 'Pass rule:{ name?, description?, instruction?, importance?, operator?, period_type?, left_expression?, left_description?, left_missing_strategy?, right_expression?, right_description?, right_missing_strategy? }',
      };
    }
    const exists = await verifyTargetExists('validationRules', id, 'manage_validation_rules', 'update', 'id,displayName');
    if (!exists.exists) return exists.refusal;

    const vrResp = await safeDhis2Fetch(`validationRules/${id}?fields=:owner`);
    if (vrResp?._error) return { _error: `Could not load validation rule ${id}: ${vrResp._error}` };
    const objName = vrResp.name || vrResp.displayName || id;

    // Validate field values + any new expressions BEFORE snapshotting/mutating,
    // so an invalid patch never triggers a backup or a half-applied write.
    const r = args.rule;
    if (r.importance !== undefined && !VALIDATION_IMPORTANCE.has(r.importance)) {
      return { _error: `Invalid importance "${r.importance}". One of: HIGH, MEDIUM, LOW.` };
    }
    if (r.operator !== undefined && !VALIDATION_OPERATORS.has(r.operator)) {
      return { _error: `Invalid operator "${r.operator}". One of: ${[...VALIDATION_OPERATORS].join(', ')}.` };
    }
    if (r.period_type !== undefined && !VALID_PERIOD_TYPES.has(r.period_type)) {
      return { _error: `Invalid period_type "${r.period_type}".`, _hint: `One of: ${[...VALID_PERIOD_TYPES].join(', ')}` };
    }
    for (const [side, strat] of [['left', r.left_missing_strategy], ['right', r.right_missing_strategy]]) {
      if (strat !== undefined && !VALIDATION_MISSING_STRATEGY.has(strat)) {
        return { _error: `Invalid ${side}_missing_strategy "${strat}". One of: ${[...VALIDATION_MISSING_STRATEGY].join(', ')}.` };
      }
    }
    for (const [side, expr] of [['left', r.left_expression], ['right', r.right_expression]]) {
      if (expr !== undefined) {
        if (typeof expr !== 'string' || !expr.trim()) return { _error: `${side}_expression must be a non-empty string.` };
        const chk = await describeValidationExpression(expr);
        if (!chk.ok) return { _error: `${side}_expression rejected by DHIS2: ${chk.error}`, _hint: 'Confirm each #{dataElementUid} / #{deUid.cocUid} exists (use search_metadata) and the syntax is well-formed, then retry.' };
      }
    }

    const backup = await ensureBackupOrBail(
      { operation: 'update_validation_rule', tool: 'manage_validation_rules', action: 'update', reason: `Update validation rule ${objName}` },
      [{ object_type: 'validationRules', object_id: id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const applied = {};
    if (r.name !== undefined) { vrResp.name = r.name; applied.name = r.name; }
    if (r.description !== undefined) { vrResp.description = r.description; applied.description = r.description; }
    if (r.instruction !== undefined) { vrResp.instruction = r.instruction; applied.instruction = r.instruction; }
    if (r.importance !== undefined) { vrResp.importance = r.importance; applied.importance = r.importance; }
    if (r.operator !== undefined) { vrResp.operator = r.operator; applied.operator = r.operator; }
    if (r.period_type !== undefined) { vrResp.periodType = r.period_type; applied.periodType = r.period_type; }
    vrResp.leftSide = vrResp.leftSide || {};
    vrResp.rightSide = vrResp.rightSide || {};
    if (r.left_expression !== undefined) { vrResp.leftSide.expression = r.left_expression; applied.leftSide_expression = r.left_expression; }
    if (r.left_description !== undefined) { vrResp.leftSide.description = r.left_description; applied.leftSide_description = r.left_description; }
    if (r.left_missing_strategy !== undefined) { vrResp.leftSide.missingValueStrategy = r.left_missing_strategy; applied.leftSide_missingValueStrategy = r.left_missing_strategy; }
    if (r.right_expression !== undefined) { vrResp.rightSide.expression = r.right_expression; applied.rightSide_expression = r.right_expression; }
    if (r.right_description !== undefined) { vrResp.rightSide.description = r.right_description; applied.rightSide_description = r.right_description; }
    if (r.right_missing_strategy !== undefined) { vrResp.rightSide.missingValueStrategy = r.right_missing_strategy; applied.rightSide_missingValueStrategy = r.right_missing_strategy; }

    if (Object.keys(applied).length === 0) {
      return { _error: 'rule supplied no recognized fields to update.', backup: backup.block };
    }

    const putResp = await safeDhis2Fetch(`validationRules/${id}`, { method: 'PUT', body: vrResp });
    if (putResp?._error) return { _error: `Failed to update validation rule: ${putResp._error}`, backup: backup.block };
    return { success: true, action: 'update', rule_id: id, rule_name: objName, applied, backup: backup.block };
  }

  // ── delete ────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_validation_rules', 'delete', { rule_id: args.rule_id });
    if (_gate) return _gate;
    const id = args.rule_id || args.object_id;
    if (!id) return { _error: 'rule_id required for delete' };
    const exists = await verifyTargetExists('validationRules', id, 'manage_validation_rules', 'delete', 'id,displayName');
    if (!exists.exists) return exists.refusal;
    const objName = exists.data?.displayName || id;

    const refsResult = await checkMetadataReferences('validationRules', id);
    if (refsResult.has_references) {
      return {
        _error: `Cannot delete validation rule "${objName}" — it has active references.`,
        references: refsResult.references,
        _hint: buildDeletionHint('validationRules', id, refsResult.references),
      };
    }

    const backup = await ensureBackupOrBail(
      { operation: 'delete_validation_rule', tool: 'manage_validation_rules', action: 'delete', reason: `Deleting validation rule ${objName} (${id})` },
      [{ object_type: 'validationRules', object_id: id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const delResp = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', {
      method: 'POST',
      body: { validationRules: [{ id }] },
    });
    if (delResp?._error) return { _error: `Validation rule deletion failed: ${delResp._error}`, backup: backup.block };

    const stats = delResp?.response?.stats || delResp?.stats || {};
    if ((stats.deleted || 0) >= 1) {
      return {
        success: true,
        deleted: { type: 'validationRules', id, name: objName },
        message: `Successfully deleted validation rule "${objName}".`,
        backup: backup.block,
      };
    }
    return { _error: 'Deletion did not remove the validation rule (deleted count 0). It may already be gone or still have references.', backup: backup.block };
  }

  return {
    _error: `Unknown action "${action}" for manage_validation_rules.`,
    _hint: 'One of: list, get, create, update, delete.',
  };
}

async function createValidationRule(args) {
  const r = args.rule;
  if (!r || typeof r !== 'object') {
    return {
      _error: 'rule object required for create',
      _hint: 'Pass rule:{ name, operator, left_expression, right_expression, importance?, period_type?, instruction?, ... }',
    };
  }
  if (!r.name || !String(r.name).trim()) return { _error: 'rule.name is required.' };
  if (!r.operator || !VALIDATION_OPERATORS.has(r.operator)) {
    return { _error: `rule.operator is required and must be one of: ${[...VALIDATION_OPERATORS].join(', ')}.` };
  }
  if (!r.left_expression || !String(r.left_expression).trim()) return { _error: 'rule.left_expression is required.' };
  if (!r.right_expression || !String(r.right_expression).trim()) return { _error: 'rule.right_expression is required.' };

  const importance = r.importance || 'MEDIUM';
  if (!VALIDATION_IMPORTANCE.has(importance)) return { _error: `Invalid importance "${importance}". One of: HIGH, MEDIUM, LOW.` };
  const periodType = r.period_type || 'Monthly';
  if (!VALID_PERIOD_TYPES.has(periodType)) return { _error: `Invalid period_type "${periodType}".`, _hint: `One of: ${[...VALID_PERIOD_TYPES].join(', ')}` };
  const leftStrategy = r.left_missing_strategy || 'NEVER_SKIP';
  const rightStrategy = r.right_missing_strategy || 'NEVER_SKIP';
  for (const [side, strat] of [['left', leftStrategy], ['right', rightStrategy]]) {
    if (!VALIDATION_MISSING_STRATEGY.has(strat)) {
      return { _error: `Invalid ${side}_missing_strategy "${strat}". One of: ${[...VALIDATION_MISSING_STRATEGY].join(', ')}.` };
    }
  }

  // Server-validate BOTH expressions before building the payload — a broken
  // reference is caught here with the parser's exact error, not silently saved.
  const leftChk = await describeValidationExpression(r.left_expression);
  if (!leftChk.ok) return { _error: `left_expression rejected by DHIS2: ${leftChk.error}`, _hint: 'Confirm each #{dataElementUid} / #{deUid.cocUid} exists (use search_metadata to find UIDs) and the syntax is well-formed, then retry.' };
  const rightChk = await describeValidationExpression(r.right_expression);
  if (!rightChk.ok) return { _error: `right_expression rejected by DHIS2: ${rightChk.error}`, _hint: 'Confirm each #{dataElementUid} / #{deUid.cocUid} exists (use search_metadata to find UIDs) and the syntax is well-formed, then retry.' };

  const id = generateDhis2Uid();
  const leftSide = {
    expression: r.left_expression,
    description: r.left_description || leftChk.description || 'Left side',
    missingValueStrategy: leftStrategy,
  };
  const rightSide = {
    expression: r.right_expression,
    description: r.right_description || rightChk.description || 'Right side',
    missingValueStrategy: rightStrategy,
  };
  const ruleObj = {
    id,
    name: String(r.name).trim(),
    importance,
    operator: r.operator,
    periodType,
    leftSide,
    rightSide,
  };
  if (r.description) ruleObj.description = r.description;
  if (r.instruction) ruleObj.instruction = r.instruction;

  const result = await postMetadataPayload({ validationRules: [ruleObj] }, !!args.dry_run_only);
  if (!result.success) {
    return {
      _error: result._error || 'Validation rule create failed.',
      phase: result.phase,
      errors: result.errors,
      _validated_expressions: { left: leftChk.description, right: rightChk.description },
    };
  }
  if (args.dry_run_only) {
    return {
      success: true,
      dry_run: true,
      message: `Validation passed for "${r.name}". No rule created (dry_run_only=true).`,
      would_create: { id, name: ruleObj.name, importance, operator: r.operator, periodType },
      left_meaning: leftChk.description,
      right_meaning: rightChk.description,
    };
  }
  return {
    success: true,
    action: 'create',
    rule_id: id,
    rule: { id, name: ruleObj.name, importance, operator: r.operator, periodType, leftSide, rightSide },
    left_meaning: leftChk.description,
    right_meaning: rightChk.description,
    message: `Created validation rule "${ruleObj.name}" (${id}).`,
  };
}

// ── manage_org_units: CRUD for DHIS2 organisationUnits (the OU hierarchy) ──
//
// level + path are DERIVED by DHIS2 from the parent — this tool never sets
// them. create verifies the parent first; update validates a re-parent target
// (and rejects cycles) and auto-snapshots before writing; delete refuses any
// unit that still has children and surfaces DHIS2's exact blocking reason for
// units that still hold data/assignments. All shared helpers are reused with
// their existing signatures — no shared code is modified.

const OU_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
function normalizeOuDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return OU_DATE_ONLY_RE.test(s) ? `${s}T00:00:00.000` : s;
}
function isValidOuDate(value) {
  const s = String(value ?? '').trim();
  return OU_DATE_ONLY_RE.test(s) || /^\d{4}-\d{2}-\d{2}T/.test(s);
}

async function executeManageOrgUnits(args) {
  const action = args?.action;
  if (!action) {
    return {
      _error: 'Missing required parameter: action',
      _hint: 'One of: list, get, create, update, delete.',
    };
  }

  // ── list ──────────────────────────────────────────────────────────────
  if (action === 'list') {
    const filters = [];
    if (args.name_filter) filters.push(`name:ilike:${encodeURIComponent(args.name_filter)}`);
    if (args.level != null && Number.isFinite(Number(args.level))) filters.push(`level:eq:${Number(args.level)}`);
    if (args.parent_id) filters.push(`parent.id:eq:${encodeURIComponent(args.parent_id)}`);
    const fp = filters.length ? `&${filters.map(f => `filter=${f}`).join('&')}` : '';
    const pageSize = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    const resp = await safeDhis2Fetch(
      `organisationUnits?fields=id,displayName,level,path,parent[id,displayName],children~size,openingDate,closedDate&pageSize=${pageSize}${fp}&order=path:asc`
    );
    if (resp?._error) return { _error: `organisationUnits list failed: ${resp._error}` };
    const ous = (resp.organisationUnits || []).map(o => ({
      id: o.id,
      name: o.displayName,
      level: o.level,
      path: o.path,
      parent: o.parent ? { id: o.parent.id, name: o.parent.displayName } : null,
      children: o.children ?? 0,
      openingDate: o.openingDate,
      closedDate: o.closedDate || null,
    }));
    return {
      success: true,
      total: ous.length,
      pager_total: resp.pager?.total ?? null,
      org_units: ous,
    };
  }

  // ── get ───────────────────────────────────────────────────────────────
  if (action === 'get') {
    const id = args.org_unit_id || args.object_id;
    if (!id) return { _error: 'org_unit_id required for get' };
    const resp = await safeDhis2Fetch(
      `organisationUnits/${id}?fields=id,displayName,shortName,code,level,path,parent[id,displayName,level],` +
      `children~size,openingDate,closedDate,description,comment,address,email,phoneNumber,url,contactPerson,featureType,access`
    );
    if (resp?._status === 404) return { _error: `organisationUnits with id "${id}" does not exist (404).` };
    if (resp?._error) return { _error: `Could not load org unit ${id}: ${resp._error}` };
    return {
      success: true,
      id: resp.id,
      name: resp.displayName,
      shortName: resp.shortName,
      code: resp.code || null,
      level: resp.level,
      path: resp.path,
      parent: resp.parent ? { id: resp.parent.id, name: resp.parent.displayName, level: resp.parent.level } : null,
      childCount: resp.children ?? 0,
      openingDate: resp.openingDate,
      closedDate: resp.closedDate || null,
      description: resp.description || null,
      comment: resp.comment || null,
      contact: {
        address: resp.address || null,
        email: resp.email || null,
        phoneNumber: resp.phoneNumber || null,
        contactPerson: resp.contactPerson || null,
        url: resp.url || null,
      },
      featureType: resp.featureType || null,
      access: resp.access,
    };
  }

  // ── create ────────────────────────────────────────────────────────────
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_org_units', 'create');
    if (_gate) return _gate;
    return await createOrgUnit(args);
  }

  // ── update ────────────────────────────────────────────────────────────
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_org_units', 'update', { org_unit_id: args.org_unit_id });
    if (_gate) return _gate;
    const id = args.org_unit_id || args.object_id;
    if (!id) return { _error: 'org_unit_id required for update' };
    if (!args.org_unit || typeof args.org_unit !== 'object') {
      return {
        _error: 'org_unit object required for update',
        _hint: 'Pass org_unit:{ name?, short_name?, parent_id?, opening_date?, closed_date?, code?, description?, comment?, address?, email?, phone_number?, contact_person?, url? }',
      };
    }
    const exists = await verifyTargetExists('organisationUnits', id, 'manage_org_units', 'update', 'id,displayName');
    if (!exists.exists) return exists.refusal;

    const o = args.org_unit;
    // Validate field values + any re-parent target BEFORE snapshotting/mutating,
    // so an invalid patch never triggers a backup or a half-applied write.
    if (o.opening_date !== undefined && !isValidOuDate(o.opening_date)) {
      return { _error: `Invalid opening_date "${o.opening_date}". Use YYYY-MM-DD.` };
    }
    if (o.closed_date !== undefined && o.closed_date !== null && String(o.closed_date).trim() !== '' && !isValidOuDate(o.closed_date)) {
      return { _error: `Invalid closed_date "${o.closed_date}". Use YYYY-MM-DD (or "" to clear).` };
    }

    let newParent = null;
    if (o.parent_id !== undefined && o.parent_id !== null && String(o.parent_id).trim() !== '') {
      const newParentId = String(o.parent_id).trim();
      if (newParentId === id) return { _error: 'Cannot set an org unit as its own parent.' };
      const pResp = await safeDhis2Fetch(`organisationUnits/${newParentId}?fields=id,displayName,level,path`);
      if (pResp?._status === 404) return { _error: `New parent org unit "${newParentId}" does not exist (404).`, _hint: 'Confirm the parent UID via manage_org_units(action=list) or search_metadata.' };
      if (pResp?._error) return { _error: `Could not load new parent ${newParentId}: ${pResp._error}` };
      // Cycle guard: the new parent must NOT be this unit's own descendant.
      if (pResp.path && pResp.path.split('/').includes(id)) {
        return { _error: `Cannot move org unit ${id} under "${pResp.displayName}" — that target is a descendant of this org unit (would create a cycle).` };
      }
      newParent = pResp;
    }

    const objResp = await safeDhis2Fetch(`organisationUnits/${id}?fields=:owner`);
    if (objResp?._error) return { _error: `Could not load org unit ${id}: ${objResp._error}` };
    const objName = objResp.name || objResp.displayName || id;

    const backup = await ensureBackupOrBail(
      { operation: 'update_org_unit', tool: 'manage_org_units', action: 'update', reason: `Update org unit ${objName}` },
      [{ object_type: 'organisationUnits', object_id: id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const applied = {};
    if (o.name !== undefined) { objResp.name = String(o.name).trim(); applied.name = objResp.name; }
    if (o.short_name !== undefined || o.shortName !== undefined) {
      objResp.shortName = String(o.short_name ?? o.shortName).trim().slice(0, 50);
      applied.shortName = objResp.shortName;
    }
    if (o.opening_date !== undefined) { objResp.openingDate = normalizeOuDate(o.opening_date); applied.openingDate = objResp.openingDate; }
    if (o.closed_date !== undefined) {
      if (o.closed_date === null || String(o.closed_date).trim() === '') { delete objResp.closedDate; applied.closedDate = null; }
      else { objResp.closedDate = normalizeOuDate(o.closed_date); applied.closedDate = objResp.closedDate; }
    }
    if (o.code !== undefined) { if (o.code) { objResp.code = String(o.code).trim(); } else { delete objResp.code; } applied.code = objResp.code || null; }
    if (o.description !== undefined) { objResp.description = o.description; applied.description = o.description; }
    if (o.comment !== undefined) { objResp.comment = o.comment; applied.comment = o.comment; }
    for (const [field, src] of [['address', 'address'], ['email', 'email'], ['phoneNumber', 'phone_number'], ['url', 'url'], ['contactPerson', 'contact_person']]) {
      if (o[src] !== undefined) { objResp[field] = o[src]; applied[field] = o[src]; }
    }
    if (newParent) { objResp.parent = { id: newParent.id }; applied.parent = { id: newParent.id, name: newParent.displayName }; }

    if (Object.keys(applied).length === 0) {
      return { _error: 'org_unit supplied no recognized fields to update.', backup: backup.block };
    }

    const putResp = await safeDhis2Fetch(`organisationUnits/${id}`, { method: 'PUT', body: objResp });
    if (putResp?._error) return { _error: `Failed to update org unit: ${putResp._error}`, backup: backup.block };
    const result = { success: true, action: 'update', org_unit_id: id, org_unit_name: objName, applied, backup: backup.block };
    if (newParent) result.note = `Moved under "${newParent.displayName}". DHIS2 recomputes level/path for this org unit and all its descendants automatically.`;
    return result;
  }

  // ── delete ────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_org_units', 'delete', { org_unit_id: args.org_unit_id });
    if (_gate) return _gate;
    const id = args.org_unit_id || args.object_id;
    if (!id) return { _error: 'org_unit_id required for delete' };
    const exists = await verifyTargetExists('organisationUnits', id, 'manage_org_units', 'delete', 'id,displayName,children~size,path');
    if (!exists.exists) return exists.refusal;
    const objName = exists.data?.displayName || id;
    const childCount = exists.data?.children ?? 0;

    // Hard guard: never delete a non-leaf unit. DHIS2 blocks it (E4030) anyway,
    // but refusing up-front gives a precise, actionable message and avoids
    // snapshotting a node that cannot be removed.
    if (childCount > 0) {
      return {
        _error: `Cannot delete org unit "${objName}" — it has ${childCount} child org unit(s).`,
        _hint: `Re-parent or delete its children first: manage_org_units(action=list, parent_id="${id}") to see them, then either move each (action=update, org_unit:{parent_id:"<other OU>"}) or delete the leaves bottom-up.`,
        child_count: childCount,
      };
    }

    // organisationUnits is an unmapped type in checkMetadataReferences → returns
    // has_references:false; DHIS2's atomic DELETE is the authoritative net for any
    // remaining association (assigned programs/datasets, captured data values,
    // users' org-unit scope) and is surfaced explicitly below.
    const refsResult = await checkMetadataReferences('organisationUnits', id);
    if (refsResult.has_references) {
      return {
        _error: `Cannot delete org unit "${objName}" — it has active references.`,
        references: refsResult.references,
        _hint: buildDeletionHint('organisationUnits', id, refsResult.references),
      };
    }

    const backup = await ensureBackupOrBail(
      { operation: 'delete_org_unit', tool: 'manage_org_units', action: 'delete', reason: `Deleting org unit ${objName} (${id})` },
      [{ object_type: 'organisationUnits', object_id: id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const delResp = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', {
      method: 'POST',
      body: { organisationUnits: [{ id }] },
    });
    if (delResp?._error) return { _error: `Org unit deletion failed: ${delResp._error}`, backup: backup.block };

    const stats = delResp?.response?.stats || delResp?.stats || {};
    if ((stats.deleted || 0) >= 1) {
      return {
        success: true,
        deleted: { type: 'organisationUnits', id, name: objName },
        message: `Successfully deleted org unit "${objName}".`,
        backup: backup.block,
      };
    }
    // Surface DHIS2's exact blocking reason (E4030 "associated with another
    // object", data values, program assignment) instead of a generic message.
    const blockingMsgs = [];
    for (const tr of (delResp?.response?.typeReports || delResp?.typeReports || [])) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) { if (er.message) blockingMsgs.push(er.message); }
      }
    }
    return {
      _error: `Org unit "${objName}" was not deleted${blockingMsgs.length ? ': ' + blockingMsgs.join('; ') : ' (deleted count 0).'}`,
      _hint: 'The unit is still associated with other objects (assigned programs/datasets, captured data values, or users’ org-unit scope). Remove those associations, then retry.',
      backup: backup.block,
    };
  }

  return {
    _error: `Unknown action "${action}" for manage_org_units.`,
    _hint: 'One of: list, get, create, update, delete.',
  };
}

async function createOrgUnit(args) {
  const o = args.org_unit;
  if (!o || typeof o !== 'object') {
    return {
      _error: 'org_unit object required for create',
      _hint: 'Pass org_unit:{ name, parent_id, opening_date, short_name?, code?, description?, ... }',
    };
  }
  if (!o.name || !String(o.name).trim()) return { _error: 'org_unit.name is required.' };

  const parentId = (o.parent_id || args.parent_id) ? String(o.parent_id || args.parent_id).trim() : '';
  let isRoot = false;
  if (!parentId) {
    // No parent given. A second root splits the hierarchy, so that stays
    // refused — BUT on a genuinely EMPTY instance the first org unit MUST be a
    // root. Without this, a fresh instance can never get its first OU through
    // this tool, forcing the model into raw metadata calls (where it hit the
    // parent-by-name E5002 wall). Check the live count and allow ONLY the first.
    const existing = await safeDhis2Fetch('organisationUnits?fields=id&pageSize=1');
    if (existing?._error) {
      return { _error: `Could not check existing org units before creating a root: ${existing._error}` };
    }
    const existingTotal = existing?.pager?.total
      ?? (Array.isArray(existing?.organisationUnits) ? existing.organisationUnits.length : null);
    if (existingTotal === 0) {
      isRoot = true; // fresh instance → the first (root) org unit is allowed
    } else {
      return {
        _error: 'org_unit.parent_id is required.',
        _hint: `This instance already has ${existingTotal ?? 'existing'} org unit(s), so a new org unit needs a parent. Pass the parent OU UID (find it with manage_org_units(action=list) or search_metadata). Creating a SECOND root is not supported — it would split the hierarchy.`,
      };
    }
  }

  const openingRaw = o.opening_date ?? o.openingDate;
  if (!openingRaw) return { _error: 'org_unit.opening_date is required (YYYY-MM-DD).' };
  if (!isValidOuDate(openingRaw)) return { _error: `Invalid opening_date "${openingRaw}". Use YYYY-MM-DD.` };
  const closedRaw = o.closed_date ?? o.closedDate;
  if (closedRaw && !isValidOuDate(closedRaw)) return { _error: `Invalid closed_date "${closedRaw}". Use YYYY-MM-DD.` };

  // Verify the parent exists up-front: gives a clear error + lets us report the
  // derived level. postMetadataPayload's VALIDATE pass is the backstop for a
  // reference that vanishes between this check and the import (E5002). Skipped
  // for a root OU (there is no parent to verify).
  let parentResp = null;
  if (!isRoot) {
    parentResp = await safeDhis2Fetch(`organisationUnits/${parentId}?fields=id,displayName,level,path`);
    if (parentResp?._status === 404) {
      return { _error: `Parent org unit "${parentId}" does not exist (404).`, _hint: 'Confirm the parent UID via manage_org_units(action=list) or search_metadata before creating a child.' };
    }
    if (parentResp?._error) return { _error: `Could not load parent org unit ${parentId}: ${parentResp._error}` };
  }

  const id = generateDhis2Uid();
  const name = String(o.name).trim();
  const shortName = String(o.short_name || o.shortName || name).trim().slice(0, 50);
  const ouObj = {
    id,
    name,
    shortName,
    openingDate: normalizeOuDate(openingRaw),
  };
  if (!isRoot) ouObj.parent = { id: parentId };
  if (closedRaw) ouObj.closedDate = normalizeOuDate(closedRaw);
  if (o.code) ouObj.code = String(o.code).trim();
  if (o.description) ouObj.description = String(o.description);
  if (o.comment) ouObj.comment = String(o.comment);
  for (const [field, src] of [['address', 'address'], ['email', 'email'], ['phoneNumber', 'phone_number'], ['url', 'url'], ['contactPerson', 'contact_person']]) {
    const v = o[src] ?? o[field];
    if (v) ouObj[field] = String(v);
  }

  const result = await postMetadataPayload({ organisationUnits: [ouObj] }, !!args.dry_run_only);
  if (!result.success) {
    return { _error: result._error || 'Org unit create failed.', phase: result.phase, errors: result.errors };
  }

  const expectedLevel = isRoot ? 1 : (parentResp.level || 0) + 1;
  const parentInfo = isRoot ? null : { id: parentId, name: parentResp.displayName };
  if (args.dry_run_only) {
    return {
      success: true,
      dry_run: true,
      message: `Validation passed for "${name}". No org unit created (dry_run_only=true).`,
      would_create: { id, name, shortName, parent: parentInfo, expected_level: expectedLevel, root: isRoot },
    };
  }
  return {
    success: true,
    action: 'create',
    org_unit_id: id,
    org_unit: {
      id, name, shortName, level: expectedLevel,
      parent: parentInfo,
      openingDate: ouObj.openingDate, closedDate: ouObj.closedDate || null,
    },
    message: isRoot
      ? `Created ROOT org unit "${name}" (${id}) at level 1 (first org unit on this instance).`
      : `Created org unit "${name}" (${id}) under "${parentResp.displayName}" at level ${expectedLevel}.`,
  };
}

// ── manage_indicators: CRUD for DHIS2 aggregate indicators (numerator/denominator formulas) ──
//
// An aggregate INDICATOR is a calculated value: (numerator / denominator) ×
// the indicatorType factor (1, 100, 1000, …). numerator and denominator are
// DHIS2 aggregate expressions over data-element operands #{de} / #{de.coc},
// reporting rates R{ds.REPORTING_RATE}, program indicators I{pi}, constants
// C{const} and numeric literals. This tool reuses the SAME server-side
// validator already used for validation-rule sides (describeValidationExpression
// → GET /api/expressions/description), which the 2.43 playground confirmed
// accepts the full indicator grammar (#{}, R{}, I{}, numbers/operators). The
// indicatorType is resolved + verified (by UID or exact name) before any write.
// All shared helpers are reused with their existing signatures — no shared code
// is modified.

// Resolve an indicatorType by UID or exact name → { id, name, factor } or { _error }.
async function resolveIndicatorType(idOrName) {
  const v = String(idOrName ?? '').trim();
  if (!v) return { _error: 'indicator_type is required (an indicatorType UID or exact name, e.g. "Number (Factor 1)" or "Per cent").' };
  if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(v)) {
    const resp = await safeDhis2Fetch(`indicatorTypes/${v}?fields=id,name,factor`);
    if (resp?._status === 404) return { _error: `indicatorType "${v}" does not exist (404).`, _hint: 'List the available types with dhis2_query GET indicatorTypes, or pass the type name instead.' };
    if (resp?._error) return { _error: `Could not load indicatorType ${v}: ${resp._error}` };
    return { id: resp.id, name: resp.name, factor: resp.factor };
  }
  const resp = await safeDhis2Fetch(`indicatorTypes?filter=name:eq:${encodeURIComponent(v)}&fields=id,name,factor&paging=false`);
  if (resp?._error) return { _error: `Could not look up indicatorType "${v}": ${resp._error}` };
  const types = resp.indicatorTypes || [];
  if (types.length === 0) return { _error: `No indicatorType named "${v}".`, _hint: 'Common types: "Number (Factor 1)", "Per cent", "Per thousand", "Per ten thousand", "Per hundred thousand". List all with dhis2_query GET indicatorTypes.' };
  return { id: types[0].id, name: types[0].name, factor: types[0].factor };
}

async function executeManageIndicators(args) {
  const action = args?.action;
  if (!action) {
    return { _error: 'Missing required parameter: action', _hint: 'One of: list, get, create, update, delete.' };
  }

  // ── list ──────────────────────────────────────────────────────────────
  if (action === 'list') {
    const filters = [];
    if (args.name_filter) filters.push(`name:ilike:${encodeURIComponent(args.name_filter)}`);
    if (args.indicator_type) {
      const it = await resolveIndicatorType(args.indicator_type);
      if (it._error) return it;
      filters.push(`indicatorType.id:eq:${it.id}`);
    }
    const fp = filters.length ? `&${filters.map(f => `filter=${f}`).join('&')}` : '';
    const pageSize = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    const resp = await safeDhis2Fetch(
      `indicators?fields=id,displayName,indicatorType[id,name,factor],annualized,numerator,denominator&pageSize=${pageSize}${fp}&order=displayName:iasc`
    );
    if (resp?._error) return { _error: `indicators list failed: ${resp._error}` };
    const indicators = (resp.indicators || []).map(i => ({
      id: i.id,
      name: i.displayName,
      indicatorType: i.indicatorType?.name,
      factor: i.indicatorType?.factor,
      annualized: i.annualized,
      numerator: i.numerator,
      denominator: i.denominator,
    }));
    return {
      success: true,
      total: indicators.length,
      pager_total: resp.pager?.total ?? null,
      indicators,
    };
  }

  // ── get ───────────────────────────────────────────────────────────────
  if (action === 'get') {
    const id = args.indicator_id || args.object_id;
    if (!id) return { _error: 'indicator_id required for get' };
    const resp = await safeDhis2Fetch(
      `indicators/${id}?fields=id,displayName,description,shortName,indicatorType[id,name,factor],annualized,decimals,` +
      `numerator,numeratorDescription,denominator,denominatorDescription,legendSets[id,displayName],sharing,access`
    );
    if (resp?._status === 404) return { _error: `indicators with id "${id}" does not exist (404).` };
    if (resp?._error) return { _error: `Could not load indicator ${id}: ${resp._error}` };
    return {
      success: true,
      id: resp.id,
      name: resp.displayName,
      shortName: resp.shortName,
      description: resp.description,
      indicatorType: resp.indicatorType,
      annualized: resp.annualized,
      decimals: resp.decimals,
      numerator: resp.numerator,
      numeratorDescription: resp.numeratorDescription,
      denominator: resp.denominator,
      denominatorDescription: resp.denominatorDescription,
      legendSets: (resp.legendSets || []).map(ls => ({ id: ls.id, name: ls.displayName })),
      access: resp.access,
    };
  }

  // ── create ────────────────────────────────────────────────────────────
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_indicators', 'create');
    if (_gate) return _gate;
    return await createIndicator(args);
  }

  // ── update ────────────────────────────────────────────────────────────
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_indicators', 'update', { indicator_id: args.indicator_id });
    if (_gate) return _gate;
    const id = args.indicator_id || args.object_id;
    if (!id) return { _error: 'indicator_id required for update' };
    if (!args.indicator || typeof args.indicator !== 'object') {
      return {
        _error: 'indicator object required for update',
        _hint: 'Pass indicator:{ name?, short_name?, description?, indicator_type?, annualized?, decimals?, numerator?, numerator_description?, denominator?, denominator_description?, legend_set_id? (attach a colour legend), legend_set_ids? ([] detaches) }',
      };
    }
    const exists = await verifyTargetExists('indicators', id, 'manage_indicators', 'update', 'id,displayName');
    if (!exists.exists) return exists.refusal;

    const ownerResp = await safeDhis2Fetch(`indicators/${id}?fields=:owner`);
    if (ownerResp?._error) return { _error: `Could not load indicator ${id}: ${ownerResp._error}` };
    const objName = ownerResp.name || ownerResp.displayName || id;

    // Validate field values + any new expressions/type BEFORE snapshotting/mutating,
    // so an invalid patch never triggers a backup or a half-applied write.
    const ind = args.indicator;
    let resolvedType = null;
    if (ind.indicator_type !== undefined) {
      resolvedType = await resolveIndicatorType(ind.indicator_type);
      if (resolvedType._error) return resolvedType;
    }
    if (ind.decimals !== undefined && ind.decimals !== null) {
      const d = Number(ind.decimals);
      if (!Number.isInteger(d) || d < 0 || d > 5) return { _error: 'decimals must be an integer 0–5 (or null to inherit the system default).' };
    }
    for (const [field, expr] of [['numerator', ind.numerator], ['denominator', ind.denominator]]) {
      if (expr !== undefined) {
        if (typeof expr !== 'string' || !expr.trim()) return { _error: `${field} must be a non-empty string.` };
        const chk = await describeValidationExpression(expr);
        if (!chk.ok) return { _error: `${field} rejected by DHIS2: ${chk.error}`, _hint: 'Confirm each #{dataElementUid} / #{deUid.cocUid} / R{dsUid.REPORTING_RATE} / I{programIndicatorUid} exists (use search_metadata) and the syntax is well-formed, then retry.' };
      }
    }
    // Legend-set attach/detach: resolve+verify BEFORE snapshotting/mutating, so an
    // invalid reference never triggers a backup or a half-applied write. A supplied
    // legend_set_id/legend_set_name attaches an existing set; an explicit
    // legend_set_ids:[] detaches all. Left untouched when no legend field is given.
    let resolvedLegendSets; // undefined = field not supplied → leave legendSets as-is
    const _touchesLegend = (ind.legend_set_id && String(ind.legend_set_id).trim())
      || Array.isArray(ind.legend_set_ids)
      || (ind.legend_set_name && String(ind.legend_set_name).trim());
    if (_touchesLegend) {
      const legendRefs = await resolveLegendSetRefs(ind.legend_set_id, ind.legend_set_ids, ind.legend_set_name);
      if (legendRefs._error) return legendRefs;
      resolvedLegendSets = legendRefs;
    }

    const backup = await ensureBackupOrBail(
      { operation: 'update_indicator', tool: 'manage_indicators', action: 'update', reason: `Update indicator ${objName}` },
      [{ object_type: 'indicators', object_id: id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const applied = {};
    if (ind.name !== undefined) { ownerResp.name = ind.name; applied.name = ind.name; }
    if (ind.short_name !== undefined) { ownerResp.shortName = String(ind.short_name).slice(0, 50); applied.shortName = ownerResp.shortName; }
    if (ind.description !== undefined) { ownerResp.description = ind.description; applied.description = ind.description; }
    if (resolvedType) { ownerResp.indicatorType = { id: resolvedType.id }; applied.indicatorType = resolvedType.name; }
    if (ind.annualized !== undefined) { ownerResp.annualized = !!ind.annualized; applied.annualized = !!ind.annualized; }
    if (ind.decimals !== undefined) { ownerResp.decimals = ind.decimals == null ? null : Number(ind.decimals); applied.decimals = ownerResp.decimals; }
    if (ind.numerator !== undefined) { ownerResp.numerator = ind.numerator; applied.numerator = ind.numerator; }
    if (ind.numerator_description !== undefined) { ownerResp.numeratorDescription = ind.numerator_description; applied.numeratorDescription = ind.numerator_description; }
    if (ind.denominator !== undefined) { ownerResp.denominator = ind.denominator; applied.denominator = ind.denominator; }
    if (ind.denominator_description !== undefined) { ownerResp.denominatorDescription = ind.denominator_description; applied.denominatorDescription = ind.denominator_description; }
    if (resolvedLegendSets) {
      ownerResp.legendSets = resolvedLegendSets.ids.map(lid => ({ id: lid }));
      applied.legendSets = resolvedLegendSets.ids.length ? resolvedLegendSets.names : '(detached all)';
    }

    if (Object.keys(applied).length === 0) {
      return { _error: 'indicator supplied no recognized fields to update.', backup: backup.block };
    }

    const putResp = await safeDhis2Fetch(`indicators/${id}`, { method: 'PUT', body: ownerResp });
    if (putResp?._error) return { _error: `Failed to update indicator: ${putResp._error}`, backup: backup.block };
    return { success: true, action: 'update', indicator_id: id, indicator_name: objName, applied, backup: backup.block };
  }

  // ── delete ────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_indicators', 'delete', { indicator_id: args.indicator_id });
    if (_gate) return _gate;
    const id = args.indicator_id || args.object_id;
    if (!id) return { _error: 'indicator_id required for delete' };
    const exists = await verifyTargetExists('indicators', id, 'manage_indicators', 'delete', 'id,displayName');
    if (!exists.exists) return exists.refusal;
    const objName = exists.data?.displayName || id;

    // indicators is an unmapped type in checkMetadataReferences → returns
    // has_references:false; DHIS2's atomic DELETE is the authoritative net for
    // any remaining association (dataSets, visualizations, indicatorGroups,
    // predictors) and its exact reason is surfaced below.
    const refsResult = await checkMetadataReferences('indicators', id);
    if (refsResult.has_references) {
      return {
        _error: `Cannot delete indicator "${objName}" — it has active references.`,
        references: refsResult.references,
        _hint: buildDeletionHint('indicators', id, refsResult.references),
      };
    }

    const backup = await ensureBackupOrBail(
      { operation: 'delete_indicator', tool: 'manage_indicators', action: 'delete', reason: `Deleting indicator ${objName} (${id})` },
      [{ object_type: 'indicators', object_id: id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const delResp = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', {
      method: 'POST',
      body: { indicators: [{ id }] },
    });
    if (delResp?._error) return { _error: `Indicator deletion failed: ${delResp._error}`, backup: backup.block };

    const stats = delResp?.response?.stats || delResp?.stats || {};
    if ((stats.deleted || 0) >= 1) {
      return {
        success: true,
        deleted: { type: 'indicators', id, name: objName },
        message: `Successfully deleted indicator "${objName}".`,
        backup: backup.block,
      };
    }
    // Surface DHIS2's exact blocking reason (referenced by a dataSet /
    // visualization / indicatorGroup / predictor) instead of a generic message.
    const blockingMsgs = [];
    for (const tr of (delResp?.response?.typeReports || delResp?.typeReports || [])) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) { if (er.message) blockingMsgs.push(er.message); }
      }
    }
    return {
      _error: `Indicator "${objName}" was not deleted${blockingMsgs.length ? ': ' + blockingMsgs.join('; ') : ' (deleted count 0).'}`,
      _hint: 'The indicator is still referenced by another object (a dataSet, visualization, indicatorGroup, or predictor). Remove those references first, then retry.',
      backup: backup.block,
    };
  }

  return {
    _error: `Unknown action "${action}" for manage_indicators.`,
    _hint: 'One of: list, get, create, update, delete.',
  };
}

// Resolve + verify EXISTING legend-set reference(s) for attaching to an
// indicator (its `legendSets` array). Mirrors resolveExistingOptionSetRef: a
// reference must point at a set that ALREADY exists — by UID (single/array) or
// by exact unique name — so an indicator never silently points at a
// non-existent legend set. Returns { ids:[...], names:[...] } (de-duplicated,
// order-preserving) or { _error, _hint }. An empty result means "no legend
// reference supplied" (caller decides whether that clears or leaves as-is).
async function resolveLegendSetRefs(legendSetId, legendSetIds, legendSetName) {
  const refs = [];
  if (Array.isArray(legendSetIds)) {
    for (const x of legendSetIds) { const v = String(x || '').trim(); if (v) refs.push({ id: v }); }
  }
  if (legendSetId && String(legendSetId).trim()) refs.push({ id: String(legendSetId).trim() });
  if (legendSetName && String(legendSetName).trim()) refs.push({ name: String(legendSetName).trim() });

  const ids = [];
  const names = [];
  const seen = new Set();
  for (const r of refs) {
    if (r.id) {
      const resp = await safeDhis2Fetch(`legendSets/${r.id}?fields=id,name`);
      if (resp?._error || resp?._status === 404 || !resp?.id) {
        return {
          _error: `legend_set_id "${r.id}" does not exist on this server.`,
          _hint: 'Chain the legend_set_id returned by manage_legend_sets(action="create"), or omit the legend reference.',
        };
      }
      if (!seen.has(resp.id)) { seen.add(resp.id); ids.push(resp.id); names.push(resp.name || resp.id); }
    } else if (r.name) {
      const probe = await safeDhis2Fetch(`legendSets?filter=name:eq:${encodeURIComponent(r.name)}&fields=id,name&pageSize=2`);
      const hits = probe?.legendSets || [];
      if (!hits.length) return {
        _error: `legend_set_name "${r.name}" not found on this server.`,
        _hint: 'Create it first with manage_legend_sets(action="create") and chain the returned legend_set_id.',
      };
      if (hits.length > 1) return { _error: `legend_set_name "${r.name}" is ambiguous (${hits.length} matches). Pass legend_set_id instead.` };
      if (!seen.has(hits[0].id)) { seen.add(hits[0].id); ids.push(hits[0].id); names.push(hits[0].name || r.name); }
    }
  }
  return { ids, names };
}

async function createIndicator(args) {
  const ind = args.indicator;
  if (!ind || typeof ind !== 'object') {
    return {
      _error: 'indicator object required for create',
      _hint: 'Pass indicator:{ name, indicator_type, numerator, denominator, short_name?, annualized?, decimals?, ... }',
    };
  }
  if (!ind.name || !String(ind.name).trim()) return { _error: 'indicator.name is required.' };
  if (!ind.numerator || !String(ind.numerator).trim()) return { _error: 'indicator.numerator is required (a DHIS2 expression, e.g. "#{deUid}" or "#{deA} + #{deB}").' };
  if (!ind.denominator || !String(ind.denominator).trim()) return { _error: 'indicator.denominator is required (use "1" for a plain count/sum).' };
  if (ind.indicator_type === undefined || ind.indicator_type === null || !String(ind.indicator_type).trim()) {
    return { _error: 'indicator.indicator_type is required (a UID or exact name such as "Number (Factor 1)" for a raw ratio, or "Per cent" for a percentage).' };
  }
  if (ind.decimals !== undefined && ind.decimals !== null) {
    const d = Number(ind.decimals);
    if (!Number.isInteger(d) || d < 0 || d > 5) return { _error: 'decimals must be an integer 0–5 (or omit to inherit the system default).' };
  }

  // Resolve + verify the indicatorType BEFORE any expression work, so a bad
  // type gives a clean error rather than a deep import-report failure.
  const itype = await resolveIndicatorType(ind.indicator_type);
  if (itype._error) return itype;

  // Server-validate BOTH expressions before building the payload — a broken
  // reference is caught here with the parser's exact error, not silently saved.
  const numChk = await describeValidationExpression(ind.numerator);
  if (!numChk.ok) return { _error: `numerator rejected by DHIS2: ${numChk.error}`, _hint: 'Confirm each #{dataElementUid} / #{deUid.cocUid} / R{dsUid.REPORTING_RATE} / I{programIndicatorUid} exists (use search_metadata to find UIDs) and the syntax is well-formed, then retry.' };
  const denChk = await describeValidationExpression(ind.denominator);
  if (!denChk.ok) return { _error: `denominator rejected by DHIS2: ${denChk.error}`, _hint: 'Confirm each reference exists (use search_metadata) and the syntax is well-formed. For a plain count/sum use denominator "1".' };

  const id = generateDhis2Uid();
  const name = String(ind.name).trim();
  const shortName = String(ind.short_name || name).slice(0, 50);
  const indObj = {
    id,
    name,
    shortName,
    numerator: ind.numerator,
    numeratorDescription: ind.numerator_description || numChk.description || 'Numerator',
    denominator: ind.denominator,
    denominatorDescription: ind.denominator_description || denChk.description || 'Denominator',
    indicatorType: { id: itype.id },
    annualized: !!ind.annualized,
  };
  if (ind.description) indObj.description = ind.description;
  if (ind.decimals !== undefined && ind.decimals !== null) indObj.decimals = Number(ind.decimals);

  // Optional: attach EXISTING legend set(s) so the indicator renders color-coded
  // (traffic-light) everywhere it appears — the legend-set → indicator chaining
  // path. Resolve+verify each set EXISTS before writing (never invent a UID).
  // Purely additive: skipped entirely when no legend reference is supplied.
  const legendRefs = await resolveLegendSetRefs(ind.legend_set_id, ind.legend_set_ids, ind.legend_set_name);
  if (legendRefs._error) return legendRefs;
  if (legendRefs.ids.length) indObj.legendSets = legendRefs.ids.map(id => ({ id }));

  const result = await postMetadataPayload({ indicators: [indObj] }, !!args.dry_run_only);
  if (!result.success) {
    return {
      _error: result._error || 'Indicator create failed.',
      phase: result.phase,
      errors: result.errors,
      _validated_expressions: { numerator: numChk.description, denominator: denChk.description },
    };
  }
  if (args.dry_run_only) {
    return {
      success: true,
      dry_run: true,
      message: `Validation passed for "${name}". No indicator created (dry_run_only=true).`,
      would_create: { id, name, shortName, indicatorType: itype.name, factor: itype.factor, annualized: indObj.annualized, legendSetIds: legendRefs.ids.length ? legendRefs.ids : undefined },
      numerator_meaning: numChk.description,
      denominator_meaning: denChk.description,
    };
  }
  return {
    success: true,
    action: 'create',
    indicator_id: id,
    indicator: { id, name, shortName, indicatorType: itype.name, factor: itype.factor, numerator: indObj.numerator, denominator: indObj.denominator, annualized: indObj.annualized, legendSetIds: legendRefs.ids.length ? legendRefs.ids : undefined },
    // Confirm the attached legend set(s) so a multi-step caller can report the
    // color-coding link (and never needs a second attach round).
    legend_sets: legendRefs.ids.length ? legendRefs.ids.map((lid, i) => ({ id: lid, name: legendRefs.names[i] })) : undefined,
    numerator_meaning: numChk.description,
    denominator_meaning: denChk.description,
    message: `Created indicator "${name}" (${id}) of type "${itype.name}" (factor ${itype.factor})${legendRefs.ids.length ? ` with legend set "${legendRefs.names[0]}"${legendRefs.ids.length > 1 ? ` (+${legendRefs.ids.length - 1} more)` : ''}` : ''}.`,
  };
}

// ── manage_option_sets: full lifecycle CRUD for DHIS2 option sets ──
//
// An option set is a reusable, ordered pick-list of { code, name } options that
// data elements / tracked-entity attributes reference to constrain input.
// Proven on the 2.43 playground BEFORE writing: the optionSet (owning side via
// its options[] list) and the standalone Option objects are imported together
// in one atomic /metadata payload; an option is removed by deleting the Option
// object (which auto-detaches it from the set); ordering is driven by each
// option's sortOrder. All shared helpers are reused with their existing
// signatures — no shared code is modified.

const OPTION_SET_VALUE_TYPES = new Set([
  'TEXT', 'LONG_TEXT', 'MULTI_TEXT', 'LETTER', 'PHONE_NUMBER', 'EMAIL', 'BOOLEAN',
  'TRUE_ONLY', 'DATE', 'DATETIME', 'TIME', 'NUMBER', 'UNIT_INTERVAL', 'PERCENTAGE',
  'INTEGER', 'INTEGER_POSITIVE', 'INTEGER_NEGATIVE', 'INTEGER_ZERO_OR_POSITIVE',
  'USERNAME', 'COORDINATE', 'ORGANISATION_UNIT', 'REFERENCE', 'AGE', 'URL',
  'FILE_RESOURCE', 'IMAGE', 'GEOJSON',
]);

// Validate + normalize an array of { code, name } option inputs.
// Returns { ok:true, options:[{code,name}] } or { _error }.
function normalizeOptionInputs(rawList, label = 'options') {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return { _error: `${label} must be a non-empty array of { code, name } objects.` };
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < rawList.length; i++) {
    const o = rawList[i] || {};
    const code = String(o.code ?? '').trim();
    const name = String(o.name ?? '').trim();
    if (!code) return { _error: `${label}[${i}] is missing a code.` };
    if (!name) return { _error: `${label}[${i}] (code "${code}") is missing a name.` };
    if (seen.has(code)) return { _error: `${label} contains duplicate code "${code}". Codes must be unique within an option set.` };
    seen.add(code);
    out.push({ code, name });
  }
  return { ok: true, options: out };
}

async function executeManageOptionSets(args) {
  const action = args?.action;
  if (!action) {
    return { _error: 'Missing required parameter: action', _hint: 'One of: list, get, create, update, add_options, remove_options, reorder_options, delete.' };
  }
  const osId = args.option_set_id || args.object_id;

  // ── list ──────────────────────────────────────────────────────────────
  if (action === 'list') {
    const filters = [];
    if (args.name_filter) filters.push(`name:ilike:${encodeURIComponent(args.name_filter)}`);
    if (args.value_type) filters.push(`valueType:eq:${encodeURIComponent(String(args.value_type).toUpperCase())}`);
    const fp = filters.length ? `&${filters.map(f => `filter=${f}`).join('&')}` : '';
    const pageSize = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    const resp = await safeDhis2Fetch(
      `optionSets?fields=id,displayName,code,valueType,options~size&pageSize=${pageSize}${fp}&order=displayName:iasc`
    );
    if (resp?._error) return { _error: `optionSets list failed: ${resp._error}` };
    const optionSets = (resp.optionSets || []).map(o => ({
      id: o.id,
      name: o.displayName,
      code: o.code || null,
      valueType: o.valueType,
      options: o.options ?? 0,
    }));
    return { success: true, total: optionSets.length, pager_total: resp.pager?.total ?? null, optionSets };
  }

  // ── get ───────────────────────────────────────────────────────────────
  if (action === 'get') {
    if (!osId) return { _error: 'option_set_id required for get' };
    const resp = await safeDhis2Fetch(
      `optionSets/${osId}?fields=id,displayName,code,description,valueType,options[id,displayName,code,sortOrder]`
    );
    if (resp?._status === 404) return { _error: `optionSet with id "${osId}" does not exist (404).` };
    if (resp?._error) return { _error: `Could not load option set ${osId}: ${resp._error}` };
    const options = (resp.options || [])
      .slice()
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(o => ({ id: o.id, name: o.displayName, code: o.code, sortOrder: o.sortOrder }));
    return {
      success: true,
      id: resp.id,
      name: resp.displayName,
      code: resp.code,
      description: resp.description,
      valueType: resp.valueType,
      option_count: options.length,
      options,
    };
  }

  // ── create ────────────────────────────────────────────────────────────
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_option_sets', 'create');
    if (_gate) return _gate;
    return await createOptionSet(args);
  }

  // ── update (own fields only) ────────────────────────────────────────────
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_option_sets', 'update', { option_set_id: osId });
    if (_gate) return _gate;
    if (!osId) return { _error: 'option_set_id required for update' };
    const os = args.option_set;
    if (!os || typeof os !== 'object') {
      return { _error: 'option_set object required for update', _hint: 'Pass option_set:{ name?, code?, description?, value_type? }. To change membership use add_options / remove_options / reorder_options.' };
    }
    if (os.value_type !== undefined && os.value_type !== null) {
      const vt = String(os.value_type).toUpperCase();
      if (!OPTION_SET_VALUE_TYPES.has(vt)) return { _error: `Invalid value_type "${os.value_type}".`, _hint: `One of: ${[...OPTION_SET_VALUE_TYPES].join(', ')}.` };
    }
    const exists = await verifyTargetExists('optionSets', osId, 'manage_option_sets', 'update', 'id,displayName');
    if (!exists.exists) return exists.refusal;
    const ownerResp = await safeDhis2Fetch(`optionSets/${osId}?fields=:owner`);
    if (ownerResp?._error) return { _error: `Could not load option set ${osId}: ${ownerResp._error}` };
    const objName = ownerResp.name || ownerResp.displayName || osId;

    const backup = await ensureBackupOrBail(
      { operation: 'update_option_set', tool: 'manage_option_sets', action: 'update', reason: `Update option set ${objName}` },
      [{ object_type: 'optionSets', object_id: osId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const applied = {};
    if (os.name !== undefined) { ownerResp.name = os.name; applied.name = os.name; }
    if (os.code !== undefined) { ownerResp.code = os.code; applied.code = os.code; }
    if (os.description !== undefined) { ownerResp.description = os.description; applied.description = os.description; }
    if (os.value_type !== undefined && os.value_type !== null) { ownerResp.valueType = String(os.value_type).toUpperCase(); applied.valueType = ownerResp.valueType; }
    if (Object.keys(applied).length === 0) {
      return { _error: 'option_set supplied no recognized own-fields to update.', _hint: 'Recognized: name, code, description, value_type. For options use add_options / remove_options / reorder_options.', backup: backup.block };
    }
    const putResp = await safeDhis2Fetch(`optionSets/${osId}`, { method: 'PUT', body: ownerResp });
    if (putResp?._error) return { _error: `Failed to update option set: ${putResp._error}`, backup: backup.block };
    return { success: true, action: 'update', option_set_id: osId, option_set_name: objName, applied, backup: backup.block };
  }

  // ── add_options ─────────────────────────────────────────────────────────
  if (action === 'add_options') {
    const _gate = requireWriteAuth('manage_option_sets', 'add_options', { option_set_id: osId });
    if (_gate) return _gate;
    if (!osId) return { _error: 'option_set_id required for add_options' };
    const norm = normalizeOptionInputs(args.options, 'options');
    if (norm._error) return norm;
    const ownerResp = await safeDhis2Fetch(`optionSets/${osId}?fields=:owner`);
    if (ownerResp?._status === 404) return { _error: `optionSet with id "${osId}" does not exist (404).` };
    if (ownerResp?._error) return { _error: `Could not load option set ${osId}: ${ownerResp._error}` };
    const objName = ownerResp.name || ownerResp.displayName || osId;

    // Reject codes that already exist in the set — option codes must be unique.
    const existing = await safeDhis2Fetch(`options?filter=optionSet.id:eq:${osId}&fields=code&paging=false`);
    if (existing?._error) return { _error: `Could not read existing options of ${osId}: ${existing._error}` };
    const existingCodes = new Set((existing.options || []).map(o => o.code));
    const collide = norm.options.filter(o => existingCodes.has(o.code)).map(o => o.code);
    if (collide.length) return { _error: `These codes already exist in "${objName}": ${collide.join(', ')}.`, _hint: 'Option codes must be unique within a set. Choose different codes, or remove the existing options first.' };

    const backup = await ensureBackupOrBail(
      { operation: 'add_options', tool: 'manage_option_sets', action: 'add_options', reason: `Add ${norm.options.length} option(s) to ${objName}` },
      [{ object_type: 'optionSets', object_id: osId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const baseOrder = Array.isArray(ownerResp.options) ? ownerResp.options.length : 0;
    const newOptionObjs = norm.options.map((o, i) => ({ id: generateDhis2Uid(), name: o.name, code: o.code, sortOrder: baseOrder + i, optionSet: { id: osId } }));
    ownerResp.options = [...(ownerResp.options || []), ...newOptionObjs.map(o => ({ id: o.id }))];

    const result = await postMetadataPayload({ optionSets: [ownerResp], options: newOptionObjs }, false);
    if (!result.success) return { _error: result._error || 'add_options failed.', phase: result.phase, errors: result.errors, backup: backup.block };
    return {
      success: true,
      action: 'add_options',
      option_set_id: osId,
      option_set_name: objName,
      added: newOptionObjs.map(o => ({ id: o.id, code: o.code, name: o.name })),
      backup: backup.block,
    };
  }

  // ── remove_options ───────────────────────────────────────────────────────
  if (action === 'remove_options') {
    const _gate = requireWriteAuth('manage_option_sets', 'remove_options', { option_set_id: osId });
    if (_gate) return _gate;
    if (!osId) return { _error: 'option_set_id required for remove_options' };
    const byId = Array.isArray(args.option_ids) && args.option_ids.length > 0;
    const byCode = Array.isArray(args.option_codes) && args.option_codes.length > 0;
    if (!byId && !byCode) return { _error: 'Provide option_codes[] or option_ids[] for remove_options.' };
    const ownerResp = await safeDhis2Fetch(`optionSets/${osId}?fields=id,displayName,options[id,code]`);
    if (ownerResp?._status === 404) return { _error: `optionSet with id "${osId}" does not exist (404).` };
    if (ownerResp?._error) return { _error: `Could not load option set ${osId}: ${ownerResp._error}` };
    const objName = ownerResp.displayName || osId;
    const setOptions = ownerResp.options || [];
    const targetIds = [];
    const notFound = [];
    if (byId) {
      for (const id of args.option_ids) { (setOptions.some(o => o.id === id) ? targetIds : notFound).push(id); }
    } else {
      const codeToId = new Map(setOptions.map(o => [o.code, o.id]));
      for (const c of args.option_codes) { const id = codeToId.get(c); if (id) targetIds.push(id); else notFound.push(c); }
    }
    if (notFound.length) return { _error: `These ${byId ? 'option ids' : 'codes'} are not in "${objName}": ${notFound.join(', ')}.`, _hint: 'Use action=get to list the set\'s current options.' };
    if (targetIds.length >= setOptions.length) return { _error: `Refusing to remove ALL ${setOptions.length} option(s) from "${objName}" — that would leave an empty option set.`, _hint: 'Keep at least one option, or delete the whole set with action=delete.' };

    const backup = await ensureBackupOrBail(
      { operation: 'remove_options', tool: 'manage_option_sets', action: 'remove_options', reason: `Remove ${targetIds.length} option(s) from ${objName}` },
      [{ object_type: 'optionSets', object_id: osId, role: 'primary' }, ...targetIds.map(id => ({ object_type: 'options', object_id: id, role: 'cascade' }))],
      args
    );
    if (!backup.ok) return backup.error;

    const removed = [];
    const failed = [];
    for (const id of targetIds) {
      const del = await safeDhis2Fetch(`options/${id}`, { method: 'DELETE' });
      if (del?._error) failed.push({ id, error: del._error }); else removed.push(id);
    }
    if (failed.length) return { _error: `Removed ${removed.length}/${targetIds.length}; ${failed.length} failed.`, removed, failed, backup: backup.block, _hint: 'An option may be referenced by saved data values; DHIS2 blocks those deletions.' };
    return { success: true, action: 'remove_options', option_set_id: osId, option_set_name: objName, removed_count: removed.length, removed_ids: removed, backup: backup.block };
  }

  // ── reorder_options ───────────────────────────────────────────────────────
  if (action === 'reorder_options') {
    const _gate = requireWriteAuth('manage_option_sets', 'reorder_options', { option_set_id: osId });
    if (_gate) return _gate;
    if (!osId) return { _error: 'option_set_id required for reorder_options' };
    const order = (Array.isArray(args.order) && args.order.length) ? args.order
      : (Array.isArray(args.option_ids) && args.option_ids.length ? args.option_ids : null);
    if (!order) return { _error: 'Provide order[] (option codes or UIDs in the desired display order) for reorder_options.' };
    const ownerResp = await safeDhis2Fetch(`optionSets/${osId}?fields=:owner`);
    if (ownerResp?._status === 404) return { _error: `optionSet with id "${osId}" does not exist (404).` };
    if (ownerResp?._error) return { _error: `Could not load option set ${osId}: ${ownerResp._error}` };
    const objName = ownerResp.name || ownerResp.displayName || osId;
    const optsResp = await safeDhis2Fetch(`options?filter=optionSet.id:eq:${osId}&fields=:owner&paging=false`);
    if (optsResp?._error) return { _error: `Could not load options of ${osId}: ${optsResp._error}` };
    const opts = optsResp.options || [];
    if (opts.length === 0) return { _error: `Option set "${objName}" has no options to reorder.` };
    const byOptId = new Map(opts.map(o => [o.id, o]));
    const byOptCode = new Map(opts.map(o => [o.code, o]));
    const resolved = [];
    const unknown = [];
    const seen = new Set();
    for (const tok of order) {
      const o = byOptId.get(tok) || byOptCode.get(tok);
      if (!o) { unknown.push(tok); continue; }
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      resolved.push(o);
    }
    if (unknown.length) return { _error: `These tokens don't match any option in "${objName}": ${unknown.join(', ')}.`, _hint: 'order[] must use this set\'s option codes or UIDs (action=get lists them).' };
    if (resolved.length !== opts.length) {
      const missing = opts.filter(o => !seen.has(o.id)).map(o => o.code);
      return { _error: `order[] must cover every option exactly once. Missing: ${missing.join(', ')}.`, _hint: 'Include all current option codes/UIDs.' };
    }

    const backup = await ensureBackupOrBail(
      { operation: 'reorder_options', tool: 'manage_option_sets', action: 'reorder_options', reason: `Reorder options of ${objName}` },
      [{ object_type: 'optionSets', object_id: osId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    resolved.forEach((o, i) => { o.sortOrder = i; });
    ownerResp.options = resolved.map(o => ({ id: o.id }));
    const result = await postMetadataPayload({ optionSets: [ownerResp], options: resolved }, false);
    if (!result.success) return { _error: result._error || 'reorder_options failed.', phase: result.phase, errors: result.errors, backup: backup.block };
    return { success: true, action: 'reorder_options', option_set_id: osId, option_set_name: objName, order: resolved.map(o => o.code), backup: backup.block };
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_option_sets', 'delete', { option_set_id: osId });
    if (_gate) return _gate;
    if (!osId) return { _error: 'option_set_id required for delete' };
    const exists = await verifyTargetExists('optionSets', osId, 'manage_option_sets', 'delete', 'id,displayName');
    if (!exists.exists) return exists.refusal;
    const objName = exists.data?.displayName || osId;

    // optionSets IS mapped in checkMetadataReferences (data elements + TEAs that
    // use it). If anything references it, refuse with the exact blockers — the
    // option set must be detached before it can be deleted.
    const refsResult = await checkMetadataReferences('optionSets', osId);
    if (refsResult.has_references) {
      return {
        _error: `Cannot delete option set "${objName}" — it is still in use.`,
        references: refsResult.references,
        _hint: buildDeletionHint('optionSets', osId, refsResult.references),
      };
    }

    // Child options must be deleted first; deleting the set alone can leave
    // orphaned Option objects. Snapshot the set AND its options for restore.
    const optsResp = await safeDhis2Fetch(`options?filter=optionSet.id:eq:${osId}&fields=id&paging=false`);
    const childIds = (optsResp?.options || []).map(o => o.id);
    const backup = await ensureBackupOrBail(
      { operation: 'delete_option_set', tool: 'manage_option_sets', action: 'delete', reason: `Deleting option set ${objName} (${osId})` },
      [{ object_type: 'optionSets', object_id: osId, role: 'primary' }, ...childIds.map(id => ({ object_type: 'options', object_id: id, role: 'cascade' }))],
      args
    );
    if (!backup.ok) return backup.error;

    for (const id of childIds) { await safeDhis2Fetch(`options/${id}`, { method: 'DELETE' }); }
    const delResp = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', {
      method: 'POST',
      body: { optionSets: [{ id: osId }] },
    });
    if (delResp?._error) return { _error: `Option set deletion failed: ${delResp._error}`, backup: backup.block };

    const stats = delResp?.response?.stats || delResp?.stats || {};
    if ((stats.deleted || 0) >= 1) {
      return {
        success: true,
        deleted: { type: 'optionSets', id: osId, name: objName, options_deleted: childIds.length },
        message: `Successfully deleted option set "${objName}" and its ${childIds.length} option(s).`,
        backup: backup.block,
      };
    }
    const blockingMsgs = [];
    for (const tr of (delResp?.response?.typeReports || delResp?.typeReports || [])) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) { if (er.message) blockingMsgs.push(er.message); }
      }
    }
    return {
      _error: `Option set "${objName}" was not deleted${blockingMsgs.length ? ': ' + blockingMsgs.join('; ') : ' (deleted count 0).'}`,
      _hint: 'It may still be referenced by a data element or tracked-entity attribute. Detach those first, then retry.',
      backup: backup.block,
    };
  }

  return {
    _error: `Unknown action "${action}" for manage_option_sets.`,
    _hint: 'One of: list, get, create, update, add_options, remove_options, reorder_options, delete.',
  };
}

async function createOptionSet(args) {
  const os = args.option_set;
  if (!os || typeof os !== 'object') {
    return { _error: 'option_set object required for create', _hint: 'Pass option_set:{ name, value_type, options:[{code,name},…] }.' };
  }
  if (!os.name || !String(os.name).trim()) return { _error: 'option_set.name is required.' };
  const vt = (os.value_type === undefined || os.value_type === null || !String(os.value_type).trim())
    ? 'TEXT'
    : String(os.value_type).toUpperCase();
  if (!OPTION_SET_VALUE_TYPES.has(vt)) return { _error: `Invalid value_type "${os.value_type}".`, _hint: `One of: ${[...OPTION_SET_VALUE_TYPES].join(', ')}.` };
  const norm = normalizeOptionInputs(os.options, 'option_set.options');
  if (norm._error) return norm;

  const setId = generateDhis2Uid();
  const name = String(os.name).trim();
  const optionObjs = norm.options.map((o, i) => ({ id: generateDhis2Uid(), name: o.name, code: o.code, sortOrder: i, optionSet: { id: setId } }));
  const setObj = { id: setId, name, valueType: vt, options: optionObjs.map(o => ({ id: o.id })) };
  if (os.code) setObj.code = String(os.code).trim();
  if (os.description) setObj.description = os.description;

  const result = await postMetadataPayload({ optionSets: [setObj], options: optionObjs }, !!args.dry_run_only);
  if (!result.success) {
    return { _error: result._error || 'Option set create failed.', phase: result.phase, errors: result.errors };
  }
  if (args.dry_run_only) {
    return { success: true, dry_run: true, message: `Validation passed for "${name}". No option set created (dry_run_only=true).`, would_create: { id: setId, name, valueType: vt, option_count: optionObjs.length } };
  }
  return {
    success: true,
    action: 'create',
    option_set_id: setId,
    option_set: { id: setId, name, valueType: vt, code: setObj.code, options: optionObjs.map(o => ({ id: o.id, code: o.code, name: o.name, sortOrder: o.sortOrder })) },
    message: `Created option set "${name}" (${setId}, ${vt}) with ${optionObjs.length} option(s).`,
  };
}

// ── manage_legend_sets: full lifecycle CRUD for DHIS2 legend sets ──
//
// A legend set owns an ordered list of colour bands (legends). Each legend is an
// EMBEDDED child of the set (DHIS2 2.43 has no standalone /api/legends collection
// — confirmed 404), so unlike option sets there are no separate child objects to
// DELETE: bands are added/removed by re-importing the set's full legends[] array
// via its :owner snapshot (mergeMode REPLACE drops any band left out), and a set
// delete cascades its legends. Proven on the 2.43 playground BEFORE writing:
// create (legends embedded), shrink-re-import deletes a dropped band, colour is
// optional, and a set referenced by a dataElement/indicator/visualisation/map is
// blocked from deletion. All shared helpers are reused with their existing
// signatures — no shared code's behaviour is changed.

const LEGEND_HEX_COLOR_RE = /^#?[0-9a-fA-F]{6}$/;

// Canonicalize an optional band colour. Returns a "#RRGGBB" string, undefined
// (no colour), or { _error } for a malformed value.
function normalizeLegendColor(c) {
  if (c === undefined || c === null || String(c).trim() === '') return undefined;
  let s = String(c).trim();
  if (!s.startsWith('#')) s = '#' + s;
  if (!LEGEND_HEX_COLOR_RE.test(s)) return { _error: `Invalid color "${c}". Use a 6-digit hex like #FF0000.` };
  return '#' + s.slice(1).toUpperCase();
}

// Validate + normalize an array of { name, startValue, endValue, color? } bands.
// Returns { ok:true, legends:[…] } or { _error }. Band names must be unique so
// remove_legends-by-name is unambiguous.
function normalizeLegendInputs(rawList, label = 'legends') {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return { _error: `${label} must be a non-empty array of { name, startValue, endValue, color? } objects.` };
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < rawList.length; i++) {
    const l = rawList[i] || {};
    const name = String(l.name ?? '').trim();
    if (!name) return { _error: `${label}[${i}] is missing a name.` };
    if (seen.has(name.toLowerCase())) return { _error: `${label} contains duplicate band name "${name}". Band names must be unique within a legend set.` };
    seen.add(name.toLowerCase());
    const sv = Number(l.startValue);
    const ev = Number(l.endValue);
    if (!Number.isFinite(sv)) return { _error: `${label}[${i}] ("${name}") has a non-numeric startValue.` };
    if (!Number.isFinite(ev)) return { _error: `${label}[${i}] ("${name}") has a non-numeric endValue.` };
    if (ev <= sv) return { _error: `${label}[${i}] ("${name}") must have endValue (${ev}) greater than startValue (${sv}).` };
    const band = { name, startValue: sv, endValue: ev };
    const col = normalizeLegendColor(l.color);
    if (col && col._error) return col;
    if (col) band.color = col;
    out.push(band);
  }
  return { ok: true, legends: out };
}

// Non-blocking data-quality check: report any pair of bands whose half-open
// [start,end) ranges overlap. DHIS2 itself accepts overlaps, so these are
// surfaced as warnings only.
function detectLegendOverlaps(legends) {
  const sorted = legends.slice().sort((a, b) => a.startValue - b.startValue);
  const warnings = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (cur.startValue < prev.endValue) {
      warnings.push(`Bands "${prev.name}" (${prev.startValue}–${prev.endValue}) and "${cur.name}" (${cur.startValue}–${cur.endValue}) overlap.`);
    }
  }
  return warnings;
}

// Interpolate a red→amber→green ramp (low→high) for default auto-band colours.
function legendRampColor(i, count) {
  if (count <= 1) return '#FBC02D';
  const t = i / (count - 1);
  const stops = [[211, 47, 47], [251, 192, 45], [56, 142, 60]]; // red, amber, green
  const seg = t * (stops.length - 1);
  const k = Math.min(Math.floor(seg), stops.length - 2);
  const f = seg - k;
  const c = [0, 1, 2].map(j => Math.round(stops[k][j] + (stops[k + 1][j] - stops[k][j]) * f));
  return '#' + c.map(v => v.toString(16).padStart(2, '0').toUpperCase()).join('');
}

// Generate count equal-width contiguous bands spanning start→end. Endpoints are
// pinned exactly (first startValue = start, last endValue = end) so floating
// point drift never leaves a gap. Returns { ok:true, legends } or { _error }.
function buildLegendAutoBands(cfg) {
  const start = Number(cfg.start);
  const end = Number(cfg.end);
  const count = Math.floor(Number(cfg.count));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { _error: 'auto_bands requires numeric start and end.' };
  if (end <= start) return { _error: `auto_bands end (${cfg.end}) must be greater than start (${cfg.start}).` };
  if (!Number.isFinite(count) || count < 1 || count > 50) return { _error: 'auto_bands count must be an integer between 1 and 50.' };
  const names = Array.isArray(cfg.names) ? cfg.names : null;
  if (names && names.length !== count) return { _error: `auto_bands.names has ${names.length} entries but count is ${count}.` };
  const colors = Array.isArray(cfg.colors) ? cfg.colors : null;
  if (colors && colors.length !== count) return { _error: `auto_bands.colors has ${colors.length} entries but count is ${count}.` };
  const round = (x) => Math.round(x * 1e6) / 1e6;
  const width = (end - start) / count;
  const legends = [];
  const seenNames = new Set();
  for (let i = 0; i < count; i++) {
    const sv = i === 0 ? start : round(start + i * width);
    const ev = i === count - 1 ? end : round(start + (i + 1) * width);
    const name = names ? String(names[i] ?? '').trim() : `${sv}–${ev}`;
    if (!name) return { _error: `auto_bands.names[${i}] is empty.` };
    if (seenNames.has(name.toLowerCase())) return { _error: `auto_bands.names contains duplicate "${name}". Band names must be unique.` };
    seenNames.add(name.toLowerCase());
    const band = { name, startValue: sv, endValue: ev };
    let color;
    if (colors) { const c = normalizeLegendColor(colors[i]); if (c && c._error) return c; color = c; }
    else color = legendRampColor(i, count);
    if (color) band.color = color;
    legends.push(band);
  }
  return { ok: true, legends };
}

async function executeManageLegendSets(args) {
  const action = args?.action;
  if (!action) {
    return { _error: 'Missing required parameter: action', _hint: 'One of: list, get, create, add_legends, remove_legends, update, delete.' };
  }
  const lsId = args.legend_set_id || args.object_id;

  // ── list ──────────────────────────────────────────────────────────────
  if (action === 'list') {
    const filters = [];
    if (args.name_filter) filters.push(`name:ilike:${encodeURIComponent(args.name_filter)}`);
    const fp = filters.length ? `&${filters.map(f => `filter=${f}`).join('&')}` : '';
    const pageSize = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    const resp = await safeDhis2Fetch(
      `legendSets?fields=id,displayName,code,legends~size&pageSize=${pageSize}${fp}&order=displayName:iasc`
    );
    if (resp?._error) return { _error: `legendSets list failed: ${resp._error}` };
    const legendSets = (resp.legendSets || []).map(o => ({
      id: o.id,
      name: o.displayName,
      code: o.code || null,
      legends: o.legends ?? 0,
    }));
    return { success: true, total: legendSets.length, pager_total: resp.pager?.total ?? null, legendSets };
  }

  // ── get ───────────────────────────────────────────────────────────────
  if (action === 'get') {
    if (!lsId) return { _error: 'legend_set_id required for get' };
    const resp = await safeDhis2Fetch(
      `legendSets/${lsId}?fields=id,displayName,code,legends[id,displayName,startValue,endValue,color]`
    );
    if (resp?._status === 404) return { _error: `legendSet with id "${lsId}" does not exist (404).` };
    if (resp?._error) return { _error: `Could not load legend set ${lsId}: ${resp._error}` };
    const legends = (resp.legends || [])
      .slice()
      .sort((a, b) => (a.startValue ?? 0) - (b.startValue ?? 0))
      .map(l => ({ id: l.id, name: l.displayName, startValue: l.startValue, endValue: l.endValue, color: l.color || null }));
    const warnings = detectLegendOverlaps(legends);
    return {
      success: true,
      id: resp.id,
      name: resp.displayName,
      code: resp.code,
      legend_count: legends.length,
      legends,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  // ── create ────────────────────────────────────────────────────────────
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_legend_sets', 'create');
    if (_gate) return _gate;
    return await createLegendSet(args);
  }

  // ── add_legends ─────────────────────────────────────────────────────────
  if (action === 'add_legends') {
    const _gate = requireWriteAuth('manage_legend_sets', 'add_legends', { legend_set_id: lsId });
    if (_gate) return _gate;
    if (!lsId) return { _error: 'legend_set_id required for add_legends' };
    const norm = normalizeLegendInputs(args.legends, 'legends');
    if (norm._error) return norm;
    const ownerResp = await safeDhis2Fetch(`legendSets/${lsId}?fields=:owner`);
    if (ownerResp?._status === 404) return { _error: `legendSet with id "${lsId}" does not exist (404).` };
    if (ownerResp?._error) return { _error: `Could not load legend set ${lsId}: ${ownerResp._error}` };
    const objName = ownerResp.name || ownerResp.displayName || lsId;

    // Band names must be unique within the set.
    const existingNames = new Set((ownerResp.legends || []).map(l => String(l.name || '').toLowerCase()));
    const collide = norm.legends.filter(l => existingNames.has(l.name.toLowerCase())).map(l => l.name);
    if (collide.length) return { _error: `These band names already exist in "${objName}": ${collide.join(', ')}.`, _hint: 'Band names must be unique within a legend set. Choose different names, or remove the existing bands first.' };

    const backup = await ensureBackupOrBail(
      { operation: 'add_legends', tool: 'manage_legend_sets', action: 'add_legends', reason: `Add ${norm.legends.length} band(s) to ${objName}` },
      [{ object_type: 'legendSets', object_id: lsId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const newBands = norm.legends.map(l => ({ id: generateDhis2Uid(), ...l }));
    ownerResp.legends = [...(ownerResp.legends || []), ...newBands];
    const result = await postMetadataPayload({ legendSets: [ownerResp] }, false);
    if (!result.success) return { _error: result._error || 'add_legends failed.', phase: result.phase, errors: result.errors, backup: backup.block };
    const warnings = detectLegendOverlaps(ownerResp.legends.map(l => ({ name: l.name, startValue: Number(l.startValue), endValue: Number(l.endValue) })));
    return {
      success: true,
      action: 'add_legends',
      legend_set_id: lsId,
      legend_set_name: objName,
      added: newBands.map(l => ({ id: l.id, name: l.name, startValue: l.startValue, endValue: l.endValue, color: l.color || null })),
      warnings: warnings.length ? warnings : undefined,
      backup: backup.block,
    };
  }

  // ── remove_legends ───────────────────────────────────────────────────────
  if (action === 'remove_legends') {
    const _gate = requireWriteAuth('manage_legend_sets', 'remove_legends', { legend_set_id: lsId });
    if (_gate) return _gate;
    if (!lsId) return { _error: 'legend_set_id required for remove_legends' };
    const byId = Array.isArray(args.legend_ids) && args.legend_ids.length > 0;
    const byName = Array.isArray(args.legend_names) && args.legend_names.length > 0;
    if (!byId && !byName) return { _error: 'Provide legend_names[] or legend_ids[] for remove_legends.' };
    const ownerResp = await safeDhis2Fetch(`legendSets/${lsId}?fields=:owner`);
    if (ownerResp?._status === 404) return { _error: `legendSet with id "${lsId}" does not exist (404).` };
    if (ownerResp?._error) return { _error: `Could not load legend set ${lsId}: ${ownerResp._error}` };
    const objName = ownerResp.name || ownerResp.displayName || lsId;
    const setLegends = ownerResp.legends || [];
    const targetIds = new Set();
    const notFound = [];
    if (byId) {
      const idSet = new Set(setLegends.map(l => l.id));
      for (const id of args.legend_ids) { if (idSet.has(id)) targetIds.add(id); else notFound.push(id); }
    } else {
      const nameToId = new Map(setLegends.map(l => [String(l.name || '').toLowerCase(), l.id]));
      for (const n of args.legend_names) { const id = nameToId.get(String(n).toLowerCase()); if (id) targetIds.add(id); else notFound.push(n); }
    }
    if (notFound.length) return { _error: `These ${byId ? 'band ids' : 'band names'} are not in "${objName}": ${notFound.join(', ')}.`, _hint: 'Use action=get to list the set\'s current bands.' };
    if (targetIds.size >= setLegends.length) return { _error: `Refusing to remove ALL ${setLegends.length} band(s) from "${objName}" — that would leave an empty legend set.`, _hint: 'Keep at least one band, or delete the whole set with action=delete.' };

    const backup = await ensureBackupOrBail(
      { operation: 'remove_legends', tool: 'manage_legend_sets', action: 'remove_legends', reason: `Remove ${targetIds.size} band(s) from ${objName}` },
      [{ object_type: 'legendSets', object_id: lsId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const removed = setLegends.filter(l => targetIds.has(l.id)).map(l => ({ id: l.id, name: l.name }));
    ownerResp.legends = setLegends.filter(l => !targetIds.has(l.id));
    const result = await postMetadataPayload({ legendSets: [ownerResp] }, false);
    if (!result.success) return { _error: result._error || 'remove_legends failed.', phase: result.phase, errors: result.errors, backup: backup.block };
    return { success: true, action: 'remove_legends', legend_set_id: lsId, legend_set_name: objName, removed_count: removed.length, removed, backup: backup.block };
  }

  // ── update (own fields only) ────────────────────────────────────────────
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_legend_sets', 'update', { legend_set_id: lsId });
    if (_gate) return _gate;
    if (!lsId) return { _error: 'legend_set_id required for update' };
    const ls = args.legend_set;
    if (!ls || typeof ls !== 'object') {
      return { _error: 'legend_set object required for update', _hint: 'Pass legend_set:{ name?, code? }. To change the bands use add_legends / remove_legends.' };
    }
    const exists = await verifyTargetExists('legendSets', lsId, 'manage_legend_sets', 'update', 'id,displayName');
    if (!exists.exists) return exists.refusal;
    const ownerResp = await safeDhis2Fetch(`legendSets/${lsId}?fields=:owner`);
    if (ownerResp?._error) return { _error: `Could not load legend set ${lsId}: ${ownerResp._error}` };
    const objName = ownerResp.name || ownerResp.displayName || lsId;

    const backup = await ensureBackupOrBail(
      { operation: 'update_legend_set', tool: 'manage_legend_sets', action: 'update', reason: `Update legend set ${objName}` },
      [{ object_type: 'legendSets', object_id: lsId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const applied = {};
    if (ls.name !== undefined) { ownerResp.name = ls.name; applied.name = ls.name; }
    if (ls.code !== undefined) { ownerResp.code = ls.code; applied.code = ls.code; }
    if (Object.keys(applied).length === 0) {
      return { _error: 'legend_set supplied no recognized own-fields to update.', _hint: 'Recognized: name, code. For bands use add_legends / remove_legends.', backup: backup.block };
    }
    const putResp = await safeDhis2Fetch(`legendSets/${lsId}`, { method: 'PUT', body: ownerResp });
    if (putResp?._error) return { _error: `Failed to update legend set: ${putResp._error}`, backup: backup.block };
    return { success: true, action: 'update', legend_set_id: lsId, legend_set_name: objName, applied, backup: backup.block };
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_legend_sets', 'delete', { legend_set_id: lsId });
    if (_gate) return _gate;
    if (!lsId) return { _error: 'legend_set_id required for delete' };
    const exists = await verifyTargetExists('legendSets', lsId, 'manage_legend_sets', 'delete', 'id,displayName');
    if (!exists.exists) return exists.refusal;
    const objName = exists.data?.displayName || lsId;

    // legendSets IS mapped in checkMetadataReferences (data elements / indicators /
    // visualisations / maps that use it). If anything references it, refuse with
    // the exact blockers — the legend set must be detached before deletion.
    const refsResult = await checkMetadataReferences('legendSets', lsId);
    if (refsResult.has_references) {
      return {
        _error: `Cannot delete legend set "${objName}" — it is still in use.`,
        references: refsResult.references,
        _hint: buildDeletionHint('legendSets', lsId, refsResult.references),
      };
    }

    // Legends are embedded children and cascade with the set, so a single
    // legendSet snapshot (:owner includes legends) fully restores on undo.
    const backup = await ensureBackupOrBail(
      { operation: 'delete_legend_set', tool: 'manage_legend_sets', action: 'delete', reason: `Deleting legend set ${objName} (${lsId})` },
      [{ object_type: 'legendSets', object_id: lsId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const delResp = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', {
      method: 'POST',
      body: { legendSets: [{ id: lsId }] },
    });
    if (delResp?._error) return { _error: `Legend set deletion failed: ${delResp._error}`, backup: backup.block };

    const stats = delResp?.response?.stats || delResp?.stats || {};
    if ((stats.deleted || 0) >= 1) {
      return {
        success: true,
        deleted: { type: 'legendSets', id: lsId, name: objName },
        message: `Successfully deleted legend set "${objName}" and its bands.`,
        backup: backup.block,
      };
    }
    const blockingMsgs = [];
    for (const tr of (delResp?.response?.typeReports || delResp?.typeReports || [])) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) { if (er.message) blockingMsgs.push(er.message); }
      }
    }
    return {
      _error: `Legend set "${objName}" was not deleted${blockingMsgs.length ? ': ' + blockingMsgs.join('; ') : ' (deleted count 0).'}`,
      _hint: 'It may still be referenced by a data element, indicator, visualisation or map. Detach those first, then retry.',
      backup: backup.block,
    };
  }

  return {
    _error: `Unknown action "${action}" for manage_legend_sets.`,
    _hint: 'One of: list, get, create, add_legends, remove_legends, update, delete.',
  };
}

async function createLegendSet(args) {
  const ls = args.legend_set;
  if (!ls || typeof ls !== 'object') {
    return { _error: 'legend_set object required for create', _hint: 'Pass legend_set:{ name, legends:[{name,startValue,endValue,color?},…] } OR legend_set:{ name } with auto_bands:{ start, end, count }.' };
  }
  if (!ls.name || !String(ls.name).trim()) return { _error: 'legend_set.name is required.' };

  let legends;
  if (args.auto_bands && typeof args.auto_bands === 'object') {
    const gen = buildLegendAutoBands(args.auto_bands);
    if (gen._error) return gen;
    legends = gen.legends;
  } else {
    const norm = normalizeLegendInputs(ls.legends, 'legend_set.legends');
    if (norm._error) return norm;
    legends = norm.legends;
  }

  const setId = generateDhis2Uid();
  const name = String(ls.name).trim();
  const legendObjs = legends.map(l => ({ id: generateDhis2Uid(), ...l }));
  const setObj = { id: setId, name, legends: legendObjs };
  if (ls.code) setObj.code = String(ls.code).trim();
  const warnings = detectLegendOverlaps(legends);

  const result = await postMetadataPayload({ legendSets: [setObj] }, !!args.dry_run_only);
  if (!result.success) {
    return { _error: result._error || 'Legend set create failed.', phase: result.phase, errors: result.errors };
  }
  if (args.dry_run_only) {
    return { success: true, dry_run: true, message: `Validation passed for "${name}". No legend set created (dry_run_only=true).`, would_create: { id: setId, name, legend_count: legendObjs.length }, warnings: warnings.length ? warnings : undefined };
  }
  return {
    success: true,
    action: 'create',
    legend_set_id: setId,
    legend_set: { id: setId, name, code: setObj.code, legends: legendObjs.map(l => ({ id: l.id, name: l.name, startValue: l.startValue, endValue: l.endValue, color: l.color || null })) },
    message: `Created legend set "${name}" (${setId}) with ${legendObjs.length} band(s).`,
    warnings: warnings.length ? warnings : undefined,
  };
}

// ── manage_dashboards: build + inspect DHIS2 analytics dashboards & visualizations ──
//
// CRITICAL structural facts, proven on the 2.43 playground BEFORE writing this
// (VALIDATE+COMMIT, read-back, render-check) so the chatbot can never ship a
// silently-empty chart:
//  • A visualization's LAYOUT is stored as columnDimensions / rowDimensions /
//    filterDimensions (lists of dimension ids like "dx"/"pe"/"ou"). The
//    columns/rows/filters item arrays are DERIVED read-only views — POSTing
//    them does NOTHING (they import back as []), so a naive raw /metadata POST
//    that only sets columns/rows/filters yields an empty, un-renderable chart.
//  • The dx data is carried by dataDimensionItems (typed: INDICATOR /
//    DATA_ELEMENT / PROGRAM_INDICATOR). pe is carried by relativePeriods
//    (boolean flags) + periods (fixed ISO). ou is carried by organisationUnits
//    (UID list) + organisationUnitLevels (PLAIN INTEGER list — [2], not
//    [{level:2}]) + userOrganisationUnit / userOrganisationUnitChildren flags.
//  • A dashboard's tiles are dashboardItems[{ type, visualization|map|text,
//    x,y,width,height }]; the 58-column grid is auto-packed here.
// All shared helpers (generateDhis2Uid, postMetadataPayload, safeDhis2Fetch,
// requireWriteAuth) are reused with their existing signatures — no shared
// code's behaviour changes.

// Locate an existing analytics favorite (chart / pivot) regardless of DHIS2
// version. 2.34+ unifies them under `visualizations`; older servers split them
// into `charts` and `reportTables`. Probing modern→legacy means one round-trip
// on current servers and graceful fall-through on old ones. Returns the
// dashboardItem type + property to use, or {_notFound}/{_error}.
async function resolveAnalyticsFavorite(id) {
  const candidates = [
    { resource: 'visualizations', itemType: 'VISUALIZATION', prop: 'visualization' },
    { resource: 'charts', itemType: 'CHART', prop: 'chart' },
    { resource: 'reportTables', itemType: 'REPORT_TABLE', prop: 'reportTable' },
  ];
  for (const c of candidates) {
    const r = await safeDhis2Fetch(`${c.resource}/${id}?fields=id,displayName`);
    if (r && !r._error) return { ...c, displayName: r.displayName || null };
    // A non-404 error (403 sharing, 500) is a real problem — surface it rather
    // than masking it as "not found". A 404 just means "try the next candidate".
    if (r && r._status && r._status !== 404) {
      return { _error: `could not verify analytics favorite ${id}: ${r._error}` };
    }
  }
  return { _notFound: true };
}

const VIZ_TYPES = new Set([
  'COLUMN', 'STACKED_COLUMN', 'BAR', 'STACKED_BAR', 'LINE', 'AREA', 'STACKED_AREA',
  'PIE', 'RADAR', 'GAUGE', 'SINGLE_VALUE', 'PIVOT_TABLE', 'YEAR_OVER_YEAR_LINE',
  'YEAR_OVER_YEAR_COLUMN', 'SCATTER', 'BUBBLE',
]);

// Relative-period keyword → relativePeriods flag (DHIS2 camelCase).
const VIZ_REL_PERIOD_FLAG = Object.freeze({
  THIS_DAY: 'thisDay', YESTERDAY: 'yesterday', LAST_3_DAYS: 'last3Days', LAST_7_DAYS: 'last7Days',
  LAST_14_DAYS: 'last14Days', LAST_30_DAYS: 'last30Days', LAST_60_DAYS: 'last60Days',
  LAST_90_DAYS: 'last90Days', LAST_180_DAYS: 'last180Days',
  THIS_WEEK: 'thisWeek', LAST_WEEK: 'lastWeek', THIS_BIWEEK: 'thisBiWeek', LAST_BIWEEK: 'lastBiWeek',
  LAST_4_WEEKS: 'last4Weeks', LAST_4_BIWEEKS: 'last4BiWeeks', LAST_12_WEEKS: 'last12Weeks', LAST_52_WEEKS: 'last52Weeks',
  WEEKS_THIS_YEAR: 'weeksThisYear',
  THIS_MONTH: 'thisMonth', LAST_MONTH: 'lastMonth', LAST_3_MONTHS: 'last3Months', LAST_6_MONTHS: 'last6Months',
  LAST_12_MONTHS: 'last12Months', MONTHS_THIS_YEAR: 'monthsThisYear', MONTHS_LAST_YEAR: 'monthsLastYear',
  THIS_BIMONTH: 'thisBimonth', LAST_BIMONTH: 'lastBimonth', LAST_6_BIMONTHS: 'last6BiMonths', BIMONTHS_THIS_YEAR: 'biMonthsThisYear',
  THIS_QUARTER: 'thisQuarter', LAST_QUARTER: 'lastQuarter', LAST_4_QUARTERS: 'last4Quarters',
  QUARTERS_THIS_YEAR: 'quartersThisYear', QUARTERS_LAST_YEAR: 'quartersLastYear',
  THIS_SIX_MONTH: 'thisSixMonth', LAST_SIX_MONTH: 'lastSixMonth', LAST_2_SIXMONTHS: 'last2SixMonths',
  THIS_YEAR: 'thisYear', LAST_YEAR: 'lastYear', LAST_5_YEARS: 'last5Years', LAST_10_YEARS: 'last10Years',
  THIS_FINANCIAL_YEAR: 'thisFinancialYear', LAST_FINANCIAL_YEAR: 'lastFinancialYear',
  LAST_5_FINANCIAL_YEARS: 'last5FinancialYears', LAST_10_FINANCIAL_YEARS: 'last10FinancialYears',
});
const VIZ_REL_OU = Object.freeze({
  USER_ORGUNIT: 'userOrganisationUnit',
  USER_ORGUNIT_CHILDREN: 'userOrganisationUnitChildren',
  USER_ORGUNIT_GRANDCHILDREN: 'userOrganisationUnitGrandChildren',
});
const VIZ_DDI_KEY = Object.freeze({
  INDICATOR: 'indicator', DATA_ELEMENT: 'dataElement', PROGRAM_INDICATOR: 'programIndicator',
});

// Default dx/pe/ou placement per visualization type.
function vizDefaultLayout(type) {
  switch (type) {
    case 'PIVOT_TABLE':
      return { columns: ['pe'], rows: ['dx'], filters: ['ou'] };
    case 'SINGLE_VALUE':
    case 'GAUGE':
    case 'PIE':
    case 'RADAR':
      return { columns: ['dx'], rows: [], filters: ['pe', 'ou'] };
    default: // COLUMN / BAR / LINE / AREA family
      return { columns: ['dx'], rows: ['pe'], filters: ['ou'] };
  }
}

// Resolve each data-item UID to its DHIS2 type AND verify it exists. Looks the
// UIDs up across indicators / dataElements / programIndicators in parallel.
// Returns { typeMap, unresolved:[…] }. Any UID found in none is unresolved.
async function resolveDataItemTypes(uids) {
  const list = [...new Set((uids || []).map(u => String(u).trim()).filter(Boolean))];
  const typeMap = {};
  if (!list.length) return { typeMap, unresolved: [] };
  const inFilter = `id:in:[${list.join(',')}]`;
  const [indResp, deResp, piResp] = await Promise.all([
    safeDhis2Fetch(`indicators.json?filter=${inFilter}&fields=id&paging=false`),
    safeDhis2Fetch(`dataElements.json?filter=${inFilter}&fields=id&paging=false`),
    safeDhis2Fetch(`programIndicators.json?filter=${inFilter}&fields=id&paging=false`),
  ]);
  for (const o of (indResp?.indicators || [])) if (!typeMap[o.id]) typeMap[o.id] = 'INDICATOR';
  for (const o of (deResp?.dataElements || [])) if (!typeMap[o.id]) typeMap[o.id] = 'DATA_ELEMENT';
  for (const o of (piResp?.programIndicators || [])) if (!typeMap[o.id]) typeMap[o.id] = 'PROGRAM_INDICATOR';
  const unresolved = list.filter(u => !typeMap[u]);
  return { typeMap, unresolved };
}

// Build a complete, render-correct visualization object from a friendly spec.
// typeMap must already contain a resolved type for every data_items UID.
// Returns { ok:true, id, viz } or { _error }. Pure/synchronous.
function buildVisualizationObject(spec, typeMap) {
  if (!spec || typeof spec !== 'object') return { _error: 'visualization spec object is required.' };
  const type = String(spec.vis_type || spec.type || 'COLUMN').toUpperCase();
  if (!VIZ_TYPES.has(type)) return { _error: `Unsupported vis_type "${type}". One of: ${[...VIZ_TYPES].join(', ')}.` };
  const name = String(spec.name || '').trim();
  if (!name) return { _error: 'visualization name is required.' };

  const dataItems = (Array.isArray(spec.data_items) ? spec.data_items : []).map(u => String(u).trim()).filter(Boolean);
  if (!dataItems.length) return { _error: 'data_items must list at least one indicator / data element / program indicator UID.' };
  const periods = (Array.isArray(spec.periods) ? spec.periods : []).map(p => String(p).trim()).filter(Boolean);
  if (!periods.length) return { _error: 'periods must list at least one period (relative keyword like LAST_12_MONTHS or fixed like 202401).' };
  const orgUnits = (Array.isArray(spec.org_units) ? spec.org_units : []).map(o => String(o).trim()).filter(Boolean);
  if (!orgUnits.length) return { _error: 'org_units must list at least one org-unit UID or relative keyword (USER_ORGUNIT, USER_ORGUNIT_CHILDREN, LEVEL-2).' };

  const id = spec.id || generateDhis2Uid();

  // dx — typed dataDimensionItems (+ dimension presence)
  const dataDimensionItems = [];
  const seenDx = new Set();
  for (const u of dataItems) {
    if (seenDx.has(u)) continue;
    seenDx.add(u);
    const t = typeMap[u];
    if (!t) return { _error: `Could not resolve data item "${u}" to a known type. Verify the UID with search_metadata.` };
    const key = VIZ_DDI_KEY[t];
    if (!key) return { _error: `Data item "${u}" has unsupported type ${t} for a visualization.` };
    dataDimensionItems.push({ dataDimensionItemType: t, [key]: { id: u } });
  }

  // pe — relative flags + fixed periods
  const relativePeriods = {};
  const fixedPeriods = [];
  let hasPe = false;
  for (const p of periods) {
    const flag = VIZ_REL_PERIOD_FLAG[p.toUpperCase()];
    if (flag) { relativePeriods[flag] = true; hasPe = true; }
    else { fixedPeriods.push({ id: p }); hasPe = true; } // fixed ISO period (e.g. 202401, 2025Q1, 2025)
  }

  // ou — fixed UIDs + relative keywords + levels
  const organisationUnits = [];
  const organisationUnitLevels = [];
  let userOrganisationUnit = false, userOrganisationUnitChildren = false, userOrganisationUnitGrandChildren = false;
  let hasOu = false;
  for (const o of orgUnits) {
    const up = o.toUpperCase();
    if (VIZ_REL_OU[up]) {
      if (up === 'USER_ORGUNIT') userOrganisationUnit = true;
      else if (up === 'USER_ORGUNIT_CHILDREN') userOrganisationUnitChildren = true;
      else userOrganisationUnitGrandChildren = true;
      hasOu = true;
    } else {
      const m = up.match(/^LEVEL-(\d+)$/);
      if (m) { const lvl = Number(m[1]); if (!organisationUnitLevels.includes(lvl)) organisationUnitLevels.push(lvl); hasOu = true; }
      else { organisationUnits.push({ id: o }); hasOu = true; }
    }
  }

  // Layout — store dimension lists; only include a dimension that has data.
  const hasData = { dx: dataDimensionItems.length > 0, pe: hasPe, ou: hasOu };
  const layoutSpec = spec.layout && typeof spec.layout === 'object' ? spec.layout : vizDefaultLayout(type);
  const ALLOWED_DIMS = new Set(['dx', 'pe', 'ou']);
  const axisDims = (dims) => (Array.isArray(dims) ? dims : [])
    .map(d => String(d).toLowerCase())
    .filter(d => ALLOWED_DIMS.has(d) && hasData[d]);
  // Guarantee every present dimension is placed exactly once; if a custom
  // layout omits one, fall back to the type default so no data is orphaned.
  const placed = new Set([...axisDims(layoutSpec.columns), ...axisDims(layoutSpec.rows), ...axisDims(layoutSpec.filters)]);
  const def = vizDefaultLayout(type);
  const fallbackFilters = [];
  for (const d of ['dx', 'pe', 'ou']) {
    if (hasData[d] && !placed.has(d)) fallbackFilters.push(d);
  }
  const columnDimensions = axisDims(layoutSpec.columns);
  const rowDimensions = axisDims(layoutSpec.rows);
  const filterDimensions = [...axisDims(layoutSpec.filters), ...fallbackFilters];
  // A visualization must have at least one column dimension to render.
  if (!columnDimensions.length) {
    const firstPresent = ['dx', 'pe', 'ou'].find(d => hasData[d]);
    if (firstPresent) {
      columnDimensions.push(firstPresent);
      const fi = filterDimensions.indexOf(firstPresent);
      if (fi >= 0) filterDimensions.splice(fi, 1);
      const ri = rowDimensions.indexOf(firstPresent);
      if (ri >= 0) rowDimensions.splice(ri, 1);
    }
  }

  const viz = {
    id, name, type,
    dataDimensionItems,
    columnDimensions, rowDimensions, filterDimensions,
    organisationUnits,
    organisationUnitLevels: organisationUnitLevels.slice(),
    userOrganisationUnit, userOrganisationUnitChildren, userOrganisationUnitGrandChildren,
    relativePeriods,
    periods: fixedPeriods,
  };
  if (spec.short_name) viz.shortName = String(spec.short_name).slice(0, 50);
  if (spec.description) viz.description = String(spec.description);
  return { ok: true, id, viz };
}

// ── Thematic map authoring ──────────────────────────────────────────────────
// DHIS2 has NO "create map" API object you can POST naively the way you might a
// visualization; a map is a container with mapViews[] (layers). This builds a
// single-layer THEMATIC (choropleth/bubble) map from a friendly spec and mirrors
// the exact structure proven on play 2.43.0.1 (2026-07-03): the data item goes on
// the mapView's `columns` dx dimension (typed dimensionItemType), the org units on
// `rows` ou (LEVEL-n markers + parent UIDs) with organisationUnitLevels, and the
// period on `filters` pe. Program is auto-attached for program-indicator/event
// layers. Returns { ok, map } or { _error }.
const MAP_THEMATIC_TYPES = new Set(['CHOROPLETH', 'BUBBLE']);
function buildMapObject(spec, typeMap) {
  if (!spec || typeof spec !== 'object') return { _error: 'map spec object is required.' };
  const name = String(spec.name || '').trim();
  if (!name) return { _error: 'map name is required.' };
  const item = String(spec.data_item || (Array.isArray(spec.data_items) ? spec.data_items[0] : '') || '').trim();
  if (!item) return { _error: 'data_item (one indicator / data element / program indicator UID) is required for a thematic map.' };
  const t = typeMap[item];
  if (!t) return { _error: `Could not resolve data item "${item}" to a known type. Verify the UID with search_metadata.` };
  const ddiKey = VIZ_DDI_KEY[t];
  if (!ddiKey) return { _error: `Data item "${item}" has unsupported type ${t} for a map.` };

  const period = String(spec.period || (Array.isArray(spec.periods) ? spec.periods[0] : '') || 'LAST_12_MONTHS').trim();
  const orgUnits = (Array.isArray(spec.org_units) ? spec.org_units : (spec.org_units ? [spec.org_units] : [])).map(o => String(o).trim()).filter(Boolean);
  const level = spec.org_unit_level != null ? Number(spec.org_unit_level) : null;

  // ou dimension: LEVEL markers + parent UIDs + user-orgunit flags.
  const ouItems = [];
  const organisationUnits = [];
  const organisationUnitLevels = [];
  const ouFlags = {};
  if (Number.isFinite(level) && level > 0) { organisationUnitLevels.push(level); ouItems.push({ id: `LEVEL-${level}` }); }
  for (const o of orgUnits) {
    const up = o.toUpperCase();
    const m = up.match(/^LEVEL-(\d+)$/);
    if (VIZ_REL_OU[up]) { ouFlags[VIZ_REL_OU[up]] = true; ouItems.push({ id: up }); }
    else if (m) { const lvl = Number(m[1]); if (!organisationUnitLevels.includes(lvl)) organisationUnitLevels.push(lvl); ouItems.push({ id: up }); }
    else { organisationUnits.push({ id: o }); ouItems.push({ id: o }); }
  }
  if (!ouItems.length) return { _error: 'A thematic map needs org units: pass org_unit_level (e.g. 2 for districts) and/or org_units (parent UIDs or USER_ORGUNIT).', _hint: 'Typical: org_unit_level:2 to shade every district, org_units:["<countryUid>"] as the boundary.' };
  if (Number.isFinite(level) && level > 0 && !organisationUnits.length && !Object.keys(ouFlags).length) {
    // A level with no parent boundary shades every OU at that level nationwide — allowed, but note it.
  }

  const thematicMapType = MAP_THEMATIC_TYPES.has(String(spec.thematic_map_type || '').toUpperCase())
    ? String(spec.thematic_map_type).toUpperCase() : 'CHOROPLETH';
  const mapViewId = generateDhis2Uid();
  const mapView = {
    id: mapViewId,
    layer: 'thematic',
    renderingStrategy: 'SINGLE',
    thematicMapType,
    classes: Number.isFinite(Number(spec.classes)) ? Number(spec.classes) : 5,
    colorScale: spec.color_scale || 'YlOrRd',
    aggregationType: spec.aggregation_type || 'DEFAULT',
    opacity: spec.opacity != null ? Number(spec.opacity) : 0.9,
    hideTitle: false,
    columns: [{ dimension: 'dx', items: [{ id: item, dimensionItemType: t }] }],
    rows: [{ dimension: 'ou', items: ouItems }],
    filters: [{ dimension: 'pe', items: [{ id: period }] }],
    organisationUnitSelectionMode: 'SELECTED',
    organisationUnitLevels,
    organisationUnits,
    ...ouFlags,
  };
  if (spec.program_id) mapView.program = { id: spec.program_id };
  // method 1 = predefined legend (legendSet); 2 = equal intervals (auto colours).
  if (spec.legend_set_id) { mapView.legendSet = { id: spec.legend_set_id }; mapView.method = 1; }
  else { mapView.method = 2; }

  const map = {
    id: spec.id || generateDhis2Uid(),
    name,
    basemap: spec.basemap || 'osmLight',
    latitude: spec.latitude != null ? Number(spec.latitude) : 0,
    longitude: spec.longitude != null ? Number(spec.longitude) : 0,
    zoom: spec.zoom != null ? Number(spec.zoom) : 3,
    mapViews: [mapView],
  };
  return { ok: true, map, needsProgram: t === 'PROGRAM_INDICATOR' && !spec.program_id, dataItemId: item };
}

// Resolve the owning program for a program-indicator data item (maps need it on
// the layer). Returns the program UID or null.
async function resolveProgramForProgramIndicator(piId) {
  const resp = await safeDhis2Fetch(`programIndicators/${piId}?fields=program[id]`);
  return resp?.program?.id || null;
}

async function executeManageMaps(args) {
  const action = args.action;
  if (!action) return { _error: 'action required', _hint: 'One of: list, get, create, delete.' };

  if (action === 'list') {
    const nameFilter = args.name_filter ? `&filter=name:ilike:${encodeURIComponent(args.name_filter)}` : '';
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
    const resp = await safeDhis2Fetch(`maps.json?fields=id,name,lastUpdated,mapViews[layer,thematicMapType]&order=lastUpdated:desc&pageSize=${limit}${nameFilter}`);
    if (resp?._error) return resp;
    return { maps: (resp.maps || []).map(m => ({ id: m.id, name: m.name, lastUpdated: m.lastUpdated, layers: (m.mapViews || []).length })), total: resp.pager?.total ?? (resp.maps || []).length };
  }

  if (action === 'get') {
    const id = extractMapIdFromInput(args.map_id) || args.map_id;
    if (!id) return { _error: 'map_id required for get.' };
    const resp = await safeDhis2Fetch(`maps/${id}?fields=id,name,basemap,mapViews[id,layer,thematicMapType,columns[dimension,items[id,dimensionItemType]],organisationUnitLevels,program[id,name],legendSet[id,name]]`);
    if (resp?._error) return resp;
    return { map: resp };
  }

  if (action === 'create') {
    const _gate = requireWriteAuth('manage_maps', 'create');
    if (_gate) return _gate;
    const spec = args.map || args;
    // Resolve the data item's type (+ existence) exactly like create_visualization.
    const itemId = String(spec.data_item || (Array.isArray(spec.data_items) ? spec.data_items[0] : '') || '').trim();
    if (!itemId) return { _error: 'data_item (one indicator / data element / program indicator UID) is required.' };
    const { typeMap, unresolved } = await resolveDataItemTypes([itemId]);
    if (unresolved.length) return { _error: `Data item not found: ${unresolved.join(', ')}. Verify the UID with search_metadata / a prior tool result.`, _scope: 'unresolved_data_item' };
    // Auto-attach program for a program-indicator layer.
    if (typeMap[itemId] === 'PROGRAM_INDICATOR' && !spec.program_id) {
      const pid = await resolveProgramForProgramIndicator(itemId);
      if (pid) spec.program_id = pid;
    }
    const built = buildMapObject(spec, typeMap);
    if (built._error) return built;
    const resp = await safeDhis2Fetch('maps', { method: 'POST', body: built.map });
    if (resp?._error) return { _error: `Map create failed: ${resp._error}`, _hint: 'Check the data item, org-unit level and period. A thematic layer needs exactly one data item, at least one org-unit selection, and one period.', _attempted_map_id: built.map.id };
    const newId = resp?.response?.uid || built.map.id;
    return {
      success: true,
      map_id: newId,
      name: built.map.name,
      layer: 'thematic',
      thematic_map_type: built.map.mapViews[0].thematicMapType,
      data_item: itemId,
      org_unit_levels: built.map.mapViews[0].organisationUnitLevels,
      period: built.map.mapViews[0].filters[0].items[0].id,
      legend_set: spec.legend_set_id || null,
      _next: `Embed it on a dashboard with manage_dashboards(action="add_items", dashboard_id=..., items=[{type:"MAP", map_id:"${newId}"}]) — or reference it in a new dashboard's items.`,
    };
  }

  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_maps', 'delete', { map_id: args.map_id });
    if (_gate) return _gate;
    const id = extractMapIdFromInput(args.map_id) || args.map_id;
    if (!id) return { _error: 'map_id required for delete.' };
    const _verify = await verifyTargetExists('maps', id, 'manage_maps', 'delete', 'id,name');
    if (!_verify.exists) return _verify.refusal;
    // Snapshot before delete so it can be restored.
    const backup = await ensureBackupOrBail(
      { operation: 'delete_map', tool: 'manage_maps', action: 'delete', user_text: lastUserText },
      [{ object_type: 'maps', object_id: id, role: 'primary' }], args);
    if (!backup.ok) return backup.error;
    const resp = await safeDhis2Fetch(`maps/${id}`, { method: 'DELETE' });
    if (resp?._error) return { _error: `Map delete failed: ${resp._error}`, backup: backup.block };
    return { success: true, deleted_map_id: id, backup: backup.block };
  }

  return { _error: `Unknown manage_maps action: ${action}`, _hint: 'One of: list, get, create, delete.' };
}

async function executeManageDashboards(args) {
  const action = args?.action;
  if (!action) {
    return { _error: 'Missing required parameter: action', _hint: 'One of: list, get, create_visualization, create_dashboard, add_items, remove_item, update, delete.' };
  }

  // ── list ──────────────────────────────────────────────────────────────
  if (action === 'list') {
    const filters = [];
    if (args.name_filter) filters.push(`name:ilike:${encodeURIComponent(args.name_filter)}`);
    const fp = filters.length ? `&${filters.map(f => `filter=${f}`).join('&')}` : '';
    const pageSize = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    const resp = await safeDhis2Fetch(
      `dashboards?fields=id,displayName,dashboardItems~size,access&pageSize=${pageSize}${fp}&order=displayName:iasc`
    );
    if (resp?._error) return { _error: `dashboards list failed: ${resp._error}` };
    const dashboards = (resp.dashboards || []).map(d => ({
      id: d.id,
      name: d.displayName,
      items: d.dashboardItems ?? 0,
      canEdit: !!d.access?.update,
    }));
    return { success: true, total: dashboards.length, pager_total: resp.pager?.total ?? null, dashboards };
  }

  // ── get ───────────────────────────────────────────────────────────────
  if (action === 'get') {
    const dId = args.dashboard_id || args.object_id;
    if (!dId) return { _error: 'dashboard_id required for get' };
    const resp = await safeDhis2Fetch(
      `dashboards/${dId}?fields=id,displayName,description,` +
      `dashboardItems[id,type,x,y,width,height,text,visualization[id,displayName,type],map[id,displayName]]`
    );
    if (resp?._status === 404) return { _error: `dashboard with id "${dId}" does not exist (404).` };
    if (resp?._error) return { _error: `Could not load dashboard ${dId}: ${resp._error}` };
    const items = (resp.dashboardItems || []).map(it => ({
      id: it.id,
      type: it.type,
      visualization: it.visualization ? { id: it.visualization.id, name: it.visualization.displayName, type: it.visualization.type } : undefined,
      map: it.map ? { id: it.map.id, name: it.map.displayName } : undefined,
      text: it.text || undefined,
      layout: { x: it.x, y: it.y, width: it.width, height: it.height },
    }));
    return { success: true, id: resp.id, name: resp.displayName, description: resp.description || null, item_count: items.length, items };
  }

  // ── create_visualization ────────────────────────────────────────────────
  if (action === 'create_visualization') {
    const _gate = requireWriteAuth('manage_dashboards', 'create_visualization');
    if (_gate) return _gate;
    const spec = args.visualization;
    if (!spec || typeof spec !== 'object') {
      return { _error: 'visualization object required for create_visualization', _hint: 'Pass visualization:{ name, vis_type, data_items:[…], periods:[…], org_units:[…] }.' };
    }
    const { typeMap, unresolved } = await resolveDataItemTypes(spec.data_items);
    if (unresolved.length) {
      return { _error: `These data_items UIDs do not exist as an indicator, data element or program indicator: ${unresolved.join(', ')}.`, _hint: 'Resolve the correct UIDs with search_metadata first; never invent UIDs.' };
    }
    const built = buildVisualizationObject(spec, typeMap);
    if (built._error) return built;
    const result = await postMetadataPayload({ visualizations: [built.viz] }, !!args.dry_run_only);
    if (!result.success) return { _error: result._error || 'Visualization create failed.', phase: result.phase, errors: result.errors };
    if (args.dry_run_only) {
      return { success: true, dry_run: true, message: `Validation passed for "${built.viz.name}". No visualization created (dry_run_only=true).`, would_create: { id: built.id, name: built.viz.name, type: built.viz.type } };
    }
    return {
      success: true,
      action: 'create_visualization',
      // Top-level *_id mirrors manage_indicators' `indicator_id` convention so a
      // multi-step caller can chain this UID into the next tool without digging
      // into the nested object. The nested `visualization` object is preserved.
      visualization_id: built.id,
      visualization: { id: built.id, name: built.viz.name, type: built.viz.type, data_items: built.viz.dataDimensionItems.length },
      message: `Created ${built.viz.type} visualization "${built.viz.name}" (${built.id}).`,
    };
  }

  // ── create_dashboard ──────────────────────────────────────────────────
  if (action === 'create_dashboard') {
    const _gate = requireWriteAuth('manage_dashboards', 'create_dashboard');
    if (_gate) return _gate;
    const dash = args.dashboard;
    if (!dash || typeof dash !== 'object' || !String(dash.name || '').trim()) {
      return { _error: 'dashboard:{ name } is required for create_dashboard.' };
    }
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length) {
      return { _error: 'items must list at least one dashboard item (existing visualization/map UID, inline new_visualization, or text).' };
    }

    // First pass: collect every data_items UID across all inline visualizations
    // so we resolve their types in ONE batched lookup.
    const inlineSpecs = [];
    const allDataItems = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      if (it.new_visualization && typeof it.new_visualization === 'object') {
        inlineSpecs.push({ index: i, spec: it.new_visualization });
        for (const u of (it.new_visualization.data_items || [])) allDataItems.push(u);
      }
    }
    let typeMap = {};
    if (allDataItems.length) {
      const res = await resolveDataItemTypes(allDataItems);
      if (res.unresolved.length) {
        return { _error: `These data_items UIDs (across the dashboard's new visualizations) do not exist: ${res.unresolved.join(', ')}.`, _hint: 'Resolve them with search_metadata; never invent UIDs.' };
      }
      typeMap = res.typeMap;
    }

    // Build inline visualizations.
    const newVisualizations = [];
    const inlineVizIdByIndex = {};
    for (const { index, spec } of inlineSpecs) {
      const built = buildVisualizationObject(spec, typeMap);
      if (built._error) return { _error: `Item ${index + 1} (new_visualization): ${built._error}` };
      newVisualizations.push(built.viz);
      inlineVizIdByIndex[index] = built.id;
    }

    // Assemble dashboardItems with auto grid-packing (58-col grid, default
    // 29×20 tiles, 2 per row) unless explicit x/y/width/height are given.
    const GRID_W = 58, DEF_W = 29, DEF_H = 20;
    let cursorX = 0, cursorY = 0, rowH = 0;
    const dashboardItems = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const itType = String(it.type || (it.map_id ? 'MAP' : it.text != null ? 'TEXT' : 'VISUALIZATION')).toUpperCase();
      const w = Number.isFinite(Number(it.width)) ? Number(it.width) : DEF_W;
      const h = Number.isFinite(Number(it.height)) ? Number(it.height) : DEF_H;
      let x, y;
      if (Number.isFinite(Number(it.x)) && Number.isFinite(Number(it.y))) {
        x = Number(it.x); y = Number(it.y);
      } else {
        if (cursorX + w > GRID_W) { cursorX = 0; cursorY += rowH; rowH = 0; }
        x = cursorX; y = cursorY;
        cursorX += w; rowH = Math.max(rowH, h);
      }
      const di = { id: generateDhis2Uid(), type: itType, x, y, width: w, height: h };
      if (itType === 'VISUALIZATION') {
        const vizId = inlineVizIdByIndex[i] || it.visualization_id;
        if (!vizId) return { _error: `Item ${i + 1} is a VISUALIZATION but has neither new_visualization nor visualization_id.` };
        di.visualization = { id: vizId };
      } else if (itType === 'MAP') {
        if (!it.map_id) return { _error: `Item ${i + 1} is a MAP but has no map_id.` };
        di.map = { id: it.map_id };
      } else if (itType === 'TEXT') {
        di.text = String(it.text || '');
      } else {
        return { _error: `Item ${i + 1} has unsupported type "${itType}". Use VISUALIZATION, MAP or TEXT.` };
      }
      dashboardItems.push(di);
    }

    // Verify referenced (existing) visualizations and maps exist, so a bad UID
    // fails clearly instead of importing a dashboard with a dangling tile.
    const refVizIds = [...new Set(items
      .map((it, i) => (String(it.type || (it.map_id ? 'MAP' : it.text != null ? 'TEXT' : 'VISUALIZATION')).toUpperCase() === 'VISUALIZATION' && !inlineVizIdByIndex[i]) ? it.visualization_id : null)
      .filter(Boolean))];
    if (refVizIds.length) {
      const vr = await safeDhis2Fetch(`visualizations.json?filter=id:in:[${refVizIds.join(',')}]&fields=id&paging=false`);
      const found = new Set((vr?.visualizations || []).map(o => o.id));
      const missing = refVizIds.filter(id => !found.has(id));
      if (missing.length) return { _error: `These referenced visualization UIDs do not exist: ${missing.join(', ')}.`, _hint: 'Create them first (new_visualization) or fix the UIDs via search_metadata / list.' };
    }
    const refMapIds = [...new Set(items.filter(it => String(it.type || '').toUpperCase() === 'MAP').map(it => it.map_id).filter(Boolean))];
    if (refMapIds.length) {
      const mr = await safeDhis2Fetch(`maps.json?filter=id:in:[${refMapIds.join(',')}]&fields=id&paging=false`);
      const foundM = new Set((mr?.maps || []).map(o => o.id));
      const missingM = refMapIds.filter(id => !foundM.has(id));
      if (missingM.length) return { _error: `These referenced map UIDs do not exist: ${missingM.join(', ')}.` };
    }

    const dashId = generateDhis2Uid();
    const dashObj = { id: dashId, name: String(dash.name).trim(), dashboardItems };
    if (dash.description) dashObj.description = String(dash.description);

    const payload = {};
    if (newVisualizations.length) payload.visualizations = newVisualizations;
    payload.dashboards = [dashObj];

    const result = await postMetadataPayload(payload, !!args.dry_run_only);
    if (!result.success) return { _error: result._error || 'Dashboard create failed.', phase: result.phase, errors: result.errors };
    if (args.dry_run_only) {
      return {
        success: true, dry_run: true,
        message: `Validation passed for dashboard "${dashObj.name}" (${dashboardItems.length} item(s), ${newVisualizations.length} new visualization(s)). Nothing created (dry_run_only=true).`,
        would_create: { dashboard_id: dashId, name: dashObj.name, items: dashboardItems.length, new_visualizations: newVisualizations.length },
      };
    }
    return {
      success: true,
      action: 'create_dashboard',
      // Top-level dashboard_id mirrors the *_id convention so the final sharing
      // step (manage_metadata update_sharing) can chain it directly. The nested
      // `dashboard` object is preserved for any existing reader.
      dashboard_id: dashId,
      dashboard: { id: dashId, name: dashObj.name },
      items: dashboardItems.length,
      new_visualizations: newVisualizations.map(v => ({ id: v.id, name: v.name, type: v.type })),
      message: `Created dashboard "${dashObj.name}" (${dashId}) with ${dashboardItems.length} item(s)${newVisualizations.length ? `, including ${newVisualizations.length} new visualization(s)` : ''}.`,
    };
  }

  // ── add_items (SAFE, NON-DESTRUCTIVE append to an EXISTING dashboard) ──────
  // This is the fix for "each time it added a chart, the whole dashboard went
  // missing": we read the FULL current dashboard, append, and write the
  // COMPLETE item set back (never a partial replace), snapshotting first so any
  // slip is one manage_backups(restore) away.
  if (action === 'add_items') {
    const _gate = requireWriteAuth('manage_dashboards', 'add_items', { dashboard_id: args.dashboard_id });
    if (_gate) return _gate;
    const dId = args.dashboard_id || args.object_id;
    if (!dId) return { _error: 'dashboard_id required for add_items' };
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length) {
      return { _error: 'items[] required for add_items', _hint: 'Each item: { visualization_id } | { type:"MAP", map_id } | { type:"TEXT", text } | { new_visualization:{ name, vis_type, data_items, periods, org_units } }.' };
    }
    // Read the FULL current object so every existing item is preserved on write.
    const owner = await safeDhis2Fetch(`dashboards/${dId}?fields=:owner`);
    if (owner?._status === 404) return { _error: `dashboard with id "${dId}" does not exist (404).` };
    if (owner?._error) return { _error: `Could not load dashboard ${dId}: ${owner._error}` };
    const dashName = owner.name || owner.displayName || dId;
    const existingItems = Array.isArray(owner.dashboardItems) ? owner.dashboardItems : [];

    // Resolve inline new_visualizations (reuse the create builder + batched type lookup).
    const inlineSpecs = [];
    const allDataItems = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      if (it.new_visualization && typeof it.new_visualization === 'object') {
        inlineSpecs.push({ index: i, spec: it.new_visualization });
        for (const u of (it.new_visualization.data_items || [])) allDataItems.push(u);
      }
    }
    let typeMap = {};
    if (allDataItems.length) {
      const res = await resolveDataItemTypes(allDataItems);
      if (res.unresolved.length) return { _error: `These data_items UIDs do not exist as an indicator, data element or program indicator: ${res.unresolved.join(', ')}.`, _hint: 'Resolve them with search_metadata; never invent UIDs.' };
      typeMap = res.typeMap;
    }
    const newVisualizations = [];
    const inlineVizIdByIndex = {};
    for (const { index, spec } of inlineSpecs) {
      const built = buildVisualizationObject(spec, typeMap);
      if (built._error) return { _error: `Item ${index + 1} (new_visualization): ${built._error}` };
      newVisualizations.push(built.viz);
      inlineVizIdByIndex[index] = built.id;
    }

    // Build the NEW dashboardItems, grid-packed BELOW existing tiles (same
    // 58-col / 29×20 convention as create_dashboard) so nothing overlaps.
    const GRID_W = 58, DEF_W = 29, DEF_H = 20;
    let startY = 0;
    for (const it of existingItems) { const y = Number(it.y) || 0, h = Number(it.height) || 0; if (y + h > startY) startY = y + h; }
    let cursorX = 0, cursorY = startY, rowH = 0;
    const newItems = [];
    const summary = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const itType = String(it.type || (it.map_id ? 'MAP' : it.text != null ? 'TEXT' : 'VISUALIZATION')).toUpperCase();
      const w = Number.isFinite(Number(it.width)) ? Number(it.width) : DEF_W;
      const h = Number.isFinite(Number(it.height)) ? Number(it.height) : DEF_H;
      let x, y;
      if (Number.isFinite(Number(it.x)) && Number.isFinite(Number(it.y))) { x = Number(it.x); y = Number(it.y); }
      else { if (cursorX + w > GRID_W) { cursorX = 0; cursorY += rowH; rowH = 0; } x = cursorX; y = cursorY; cursorX += w; rowH = Math.max(rowH, h); }
      const di = { id: generateDhis2Uid(), type: itType, x, y, width: w, height: h };
      if (itType === 'VISUALIZATION' || itType === 'CHART' || itType === 'REPORT_TABLE') {
        if (inlineVizIdByIndex[i] !== undefined) {
          di.type = 'VISUALIZATION';
          di.visualization = { id: inlineVizIdByIndex[i] };
          summary.push({ item_id: di.id, type: 'VISUALIZATION', object_id: di.visualization.id, inline: true });
        } else {
          const vizId = it.visualization_id || it.id;
          if (!vizId) return { _error: `Item ${i + 1} is a visualization but has neither new_visualization nor visualization_id.` };
          // Cross-version: resolve the ACTUAL type (visualization on 2.34+,
          // chart/reportTable on older) so we never add a dead tile.
          const fav = await resolveAnalyticsFavorite(vizId);
          if (fav._error) return { _error: `Item ${i + 1}: ${fav._error}` };
          if (fav._notFound) return { _error: `Item ${i + 1}: visualization/chart/report-table "${vizId}" does not exist (404). Not adding it — that would create a broken dashboard tile.`, _hint: 'Confirm the UID (search_metadata / action=list) or inline-create it with new_visualization.' };
          di.type = fav.itemType;
          di[fav.prop] = { id: vizId };
          summary.push({ item_id: di.id, type: fav.itemType, object_id: vizId, object_name: fav.displayName || null });
        }
      } else if (itType === 'MAP') {
        const mapId = it.map_id || it.id;
        if (!mapId) return { _error: `Item ${i + 1} is a MAP but has no map_id.` };
        const mr = await safeDhis2Fetch(`maps/${mapId}?fields=id,displayName`);
        if (mr?._status === 404) return { _error: `Item ${i + 1}: map "${mapId}" does not exist (404). Not adding a broken tile.` };
        if (mr?._error) return { _error: `Item ${i + 1}: could not verify map ${mapId}: ${mr._error}` };
        di.map = { id: mapId };
        summary.push({ item_id: di.id, type: 'MAP', object_id: mapId, object_name: mr.displayName || null });
      } else if (itType === 'TEXT') {
        di.text = String(it.text || '');
        summary.push({ item_id: di.id, type: 'TEXT' });
      } else {
        return { _error: `Item ${i + 1} has unsupported type "${itType}". Use VISUALIZATION, MAP or TEXT (or new_visualization).` };
      }
      newItems.push(di);
    }

    // Snapshot BEFORE the write (mandatory unless the user waived it).
    const backup = await ensureBackupOrBail(
      { operation: 'update', tool: 'manage_dashboards', action: 'add_items', reason: `Append ${newItems.length} item(s) to dashboard ${dashName}` },
      [{ object_type: 'dashboards', object_id: dId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    owner.dashboardItems = [...existingItems, ...newItems];
    const payload = {};
    if (newVisualizations.length) payload.visualizations = newVisualizations;
    payload.dashboards = [owner];
    const result = await postMetadataPayload(payload, false);
    if (!result.success) return { _error: result._error || 'add_items failed.', phase: result.phase, errors: result.errors, backup: backup.block };

    const verify = await safeDhis2Fetch(`dashboards/${dId}?fields=dashboardItems~size`);
    const after = verify && !verify._error ? (verify.dashboardItems ?? null) : null;
    return {
      success: true,
      action: 'add_items',
      dashboard_id: dId,
      dashboard_name: dashName,
      items_before: existingItems.length,
      items_added: newItems.length,
      items_after: after,
      new_visualizations: newVisualizations.map(v => ({ id: v.id, name: v.name, type: v.type })),
      added: summary,
      backup: backup.block,
      _note: (after !== null && after !== existingItems.length + newItems.length)
        ? `Warning: expected ${existingItems.length + newItems.length} items but server reports ${after}. Verify with action=get.`
        : undefined,
    };
  }

  // ── remove_item (drop one tile; preserves the rest; snapshots first) ──────
  if (action === 'remove_item') {
    const _gate = requireWriteAuth('manage_dashboards', 'remove_item', { dashboard_id: args.dashboard_id });
    if (_gate) return _gate;
    const dId = args.dashboard_id || args.object_id;
    if (!dId) return { _error: 'dashboard_id required for remove_item' };
    if (!args.item_id) return { _error: 'item_id required for remove_item', _hint: 'Call action=get first to see each item id.' };
    const owner = await safeDhis2Fetch(`dashboards/${dId}?fields=:owner`);
    if (owner?._status === 404) return { _error: `dashboard with id "${dId}" does not exist (404).` };
    if (owner?._error) return { _error: `Could not load dashboard ${dId}: ${owner._error}` };
    const dashName = owner.name || owner.displayName || dId;
    const existingItems = Array.isArray(owner.dashboardItems) ? owner.dashboardItems : [];
    if (!existingItems.some(it => it.id === args.item_id)) {
      return { _error: `Dashboard "${dashName}" has no item with id "${args.item_id}".`, _hint: 'Use action=get to list current item ids.' };
    }
    const backup = await ensureBackupOrBail(
      { operation: 'update', tool: 'manage_dashboards', action: 'remove_item', reason: `Remove item ${args.item_id} from dashboard ${dashName}` },
      [{ object_type: 'dashboards', object_id: dId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;
    owner.dashboardItems = existingItems.filter(it => it.id !== args.item_id);
    const result = await postMetadataPayload({ dashboards: [owner] }, false);
    if (!result.success) return { _error: result._error || 'remove_item failed.', phase: result.phase, errors: result.errors, backup: backup.block };
    return { success: true, action: 'remove_item', dashboard_id: dId, dashboard_name: dashName, removed_item_id: args.item_id, items_after: owner.dashboardItems.length, backup: backup.block };
  }

  // ── update (own fields only: name / description; snapshots first) ──────────
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_dashboards', 'update', { dashboard_id: args.dashboard_id });
    if (_gate) return _gate;
    const dId = args.dashboard_id || args.object_id;
    if (!dId) return { _error: 'dashboard_id required for update' };
    const d = args.dashboard;
    if (!d || typeof d !== 'object') return { _error: 'dashboard object required for update', _hint: 'Pass dashboard:{ name?, description? }. To add/remove tiles use add_items / remove_item.' };
    const owner = await safeDhis2Fetch(`dashboards/${dId}?fields=:owner`);
    if (owner?._status === 404) return { _error: `dashboard with id "${dId}" does not exist (404).` };
    if (owner?._error) return { _error: `Could not load dashboard ${dId}: ${owner._error}` };
    const dashName = owner.name || owner.displayName || dId;
    const backup = await ensureBackupOrBail(
      { operation: 'update', tool: 'manage_dashboards', action: 'update', reason: `Update dashboard ${dashName}` },
      [{ object_type: 'dashboards', object_id: dId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;
    const applied = {};
    if (d.name !== undefined) { owner.name = String(d.name); applied.name = owner.name; }
    if (d.description !== undefined) { owner.description = String(d.description); applied.description = owner.description; }
    if (Object.keys(applied).length === 0) return { _error: 'dashboard supplied no recognized own-fields to update.', _hint: 'Recognized: name, description. For tiles use add_items / remove_item.', backup: backup.block };
    const result = await postMetadataPayload({ dashboards: [owner] }, false);
    if (!result.success) return { _error: result._error || 'update failed.', phase: result.phase, errors: result.errors, backup: backup.block };
    return { success: true, action: 'update', dashboard_id: dId, dashboard_name: dashName, applied, backup: backup.block };
  }

  // ── delete (whole dashboard; snapshots first — fully restorable) ───────────
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_dashboards', 'delete', { dashboard_id: args.dashboard_id });
    if (_gate) return _gate;
    const dId = args.dashboard_id || args.object_id;
    if (!dId) return { _error: 'dashboard_id required for delete' };
    const exists = await verifyTargetExists('dashboards', dId, 'manage_dashboards', 'delete', 'id,displayName');
    if (!exists.exists) return exists.refusal;
    const dashName = exists.data?.displayName || dId;
    const backup = await ensureBackupOrBail(
      { operation: 'delete', tool: 'manage_dashboards', action: 'delete', reason: `Deleting dashboard ${dashName} (${dId})` },
      [{ object_type: 'dashboards', object_id: dId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;
    const delResp = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', { method: 'POST', body: { dashboards: [{ id: dId }] } });
    if (delResp?._error) return { _error: `Dashboard deletion failed: ${delResp._error}`, backup: backup.block };
    const stats = delResp?.response?.stats || delResp?.stats || {};
    if ((stats.deleted || 0) >= 1) {
      return { success: true, deleted: { type: 'dashboards', id: dId, name: dashName }, message: `Deleted dashboard "${dashName}". Restore with manage_backups(action="restore", backup_key="${backup.block?.key}").`, backup: backup.block };
    }
    return { _error: `Dashboard "${dashName}" was not deleted (deleted count 0).`, backup: backup.block };
  }

  return {
    _error: `Unknown action "${action}" for manage_dashboards.`,
    _hint: 'One of: list, get, create_visualization, create_dashboard, add_items, remove_item, update, delete.',
  };
}

// ── manage_datasets: full CRUD for DHIS2 dataSets (aggregate "programs") ──

const VALID_PERIOD_TYPES = new Set([
  'Daily','Weekly','WeeklyWednesday','WeeklyThursday','WeeklySaturday','WeeklySunday',
  'BiWeekly','Monthly','BiMonthly','Quarterly','QuarterlyNov',
  'SixMonthly','SixMonthlyApril','SixMonthlyNov','Yearly',
  'FinancialApril','FinancialJuly','FinancialSep','FinancialOct','FinancialNov',
]);
const VALID_FORM_TYPES = new Set(['DEFAULT','SECTION','CUSTOM','SECTION_MULTIORG']);

async function executeManageDatasets(args) {
  const action = args?.action;
  if (!action) {
    return {
      _error: 'Missing required parameter: action',
      _hint: 'One of: list, get, create, update, delete, add_data_elements, remove_data_elements, assign_org_units, update_sharing, create_section, update_section, delete_section.',
    };
  }

  // ── list ──────────────────────────────────────────────────────────────
  if (action === 'list') {
    const filters = [];
    if (args.name_filter) filters.push(`name:ilike:${encodeURIComponent(args.name_filter)}`);
    if (args.period_type) filters.push(`periodType:eq:${encodeURIComponent(args.period_type)}`);
    const fp = filters.length ? `&${filters.map(f => `filter=${f}`).join('&')}` : '';
    const pageSize = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    const resp = await safeDhis2Fetch(
      `dataSets?fields=id,displayName,shortName,periodType,formType,timelyDays,openFuturePeriods,categoryCombo[id,displayName,isDefault],dataSetElements~size,sections~size,organisationUnits~size,access&pageSize=${pageSize}${fp}&order=displayName:iasc`
    );
    if (resp?._error) return { _error: `dataSets list failed: ${resp._error}` };
    const datasets = (resp.dataSets || []).map(d => ({
      id: d.id,
      name: d.displayName,
      shortName: d.shortName,
      periodType: d.periodType,
      formType: d.formType || 'DEFAULT',
      categoryCombo: d.categoryCombo?.displayName || null,
      defaultCombo: !!d.categoryCombo?.isDefault,
      dataElements: d.dataSetElements ?? 0,
      sections: d.sections ?? 0,
      orgUnits: d.organisationUnits ?? 0,
      timelyDays: d.timelyDays,
      openFuturePeriods: d.openFuturePeriods,
      canRead: !!d.access?.read,
      canWriteData: !!d.access?.data?.write,
    }));
    return {
      success: true,
      total: datasets.length,
      pager_total: resp.pager?.total ?? null,
      datasets,
    };
  }

  // ── get ───────────────────────────────────────────────────────────────
  if (action === 'get') {
    const dsId = args.dataset_id || args.object_id;
    if (!dsId) return { _error: 'dataset_id required for get' };
    const resp = await safeDhis2Fetch(
      `dataSets/${dsId}?fields=id,displayName,shortName,code,description,periodType,formType,categoryCombo[id,displayName,isDefault],` +
      `timelyDays,openFuturePeriods,expiryDays,validCompleteOnly,compulsoryFieldsCompleteOnly,fieldCombinationRequired,` +
      `renderAsTabs,renderHorizontally,dataElementDecoration,notifyCompletingUser,mobile,skipOffline,style,` +
      `workflow[id,displayName],` +
      `dataSetElements[dataElement[id,displayName,valueType],categoryCombo[id,displayName]],` +
      `sections[id,displayName,sortOrder,dataElements[id,displayName],indicators[id,displayName],showRowTotals,showColumnTotals],` +
      `indicators[id,displayName],organisationUnits[id,displayName],sharing,access`
    );
    if (resp?._error) return { _error: `Could not load dataset ${dsId}: ${resp._error}` };
    return {
      success: true,
      id: resp.id,
      name: resp.displayName,
      shortName: resp.shortName,
      code: resp.code,
      description: resp.description,
      periodType: resp.periodType,
      formType: resp.formType || 'DEFAULT',
      categoryCombo: resp.categoryCombo || null,
      timelyDays: resp.timelyDays,
      openFuturePeriods: resp.openFuturePeriods,
      expiryDays: resp.expiryDays,
      flags: {
        validCompleteOnly: !!resp.validCompleteOnly,
        compulsoryFieldsCompleteOnly: !!resp.compulsoryFieldsCompleteOnly,
        fieldCombinationRequired: !!resp.fieldCombinationRequired,
        renderAsTabs: !!resp.renderAsTabs,
        renderHorizontally: !!resp.renderHorizontally,
        dataElementDecoration: !!resp.dataElementDecoration,
        notifyCompletingUser: !!resp.notifyCompletingUser,
        skipOffline: !!resp.skipOffline,
        mobile: !!resp.mobile,
      },
      data_elements: (resp.dataSetElements || []).map(dse => ({
        id: dse.dataElement?.id,
        name: dse.dataElement?.displayName,
        valueType: dse.dataElement?.valueType,
        categoryComboOverride: dse.categoryCombo?.displayName || null,
      })),
      sections: (resp.sections || []).map(s => ({
        id: s.id,
        name: s.displayName,
        sortOrder: s.sortOrder,
        dataElementCount: (s.dataElements || []).length,
        indicatorCount: (s.indicators || []).length,
        showRowTotals: !!s.showRowTotals,
        showColumnTotals: !!s.showColumnTotals,
      })),
      indicators: (resp.indicators || []).map(i => ({ id: i.id, name: i.displayName })),
      organisationUnits: (resp.organisationUnits || []).map(o => ({ id: o.id, name: o.displayName })),
      counts: {
        dataElements: (resp.dataSetElements || []).length,
        sections: (resp.sections || []).length,
        organisationUnits: (resp.organisationUnits || []).length,
        indicators: (resp.indicators || []).length,
      },
      sharing: resp.sharing,
      access: resp.access,
    };
  }

  // ── create ────────────────────────────────────────────────────────────
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_datasets', 'create');
    if (_gate) return _gate;
    return await createDataset(args);
  }

  // ── update ────────────────────────────────────────────────────────────
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_datasets', 'update', { dataset_id: args.dataset_id });
    if (_gate) return _gate;
    const dsId = args.dataset_id || args.object_id;
    if (!dsId) return { _error: 'dataset_id required for update' };
    if (!args.patch || typeof args.patch !== 'object') {
      return { _error: 'patch object required for update', _hint: 'Pass patch:{ name?, short_name?, description?, period_type?, form_type?, open_future_periods?, expiry_days?, timely_days?, render_as_tabs?, render_horizontally?, mobile?, valid_complete_only?, compulsory_fields_complete_only?, notify_completing_user?, no_value_requires_comment?, skip_offline?, data_element_decoration?, field_combination_required?, code? }' };
    }
    const exists = await verifyTargetExists('dataSets', dsId, 'manage_datasets', 'update', 'id,displayName');
    if (!exists.exists) return exists.refusal;

    const dsResp = await safeDhis2Fetch(`dataSets/${dsId}?fields=:owner`);
    if (dsResp?._error) return { _error: `Could not load dataset ${dsId}: ${dsResp._error}` };
    const objName = dsResp.name || dsResp.displayName || dsId;

    const backup = await ensureBackupOrBail(
      { operation: 'update_dataset', tool: 'manage_datasets', action: 'update', reason: `Update fields on dataset ${objName}` },
      [{ object_type: 'dataSets', object_id: dsId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const KEY_MAP = {
      name: 'name',
      short_name: 'shortName',
      description: 'description',
      code: 'code',
      period_type: 'periodType',
      form_type: 'formType',
      open_future_periods: 'openFuturePeriods',
      expiry_days: 'expiryDays',
      timely_days: 'timelyDays',
      render_as_tabs: 'renderAsTabs',
      render_horizontally: 'renderHorizontally',
      mobile: 'mobile',
      valid_complete_only: 'validCompleteOnly',
      compulsory_fields_complete_only: 'compulsoryFieldsCompleteOnly',
      notify_completing_user: 'notifyCompletingUser',
      no_value_requires_comment: 'noValueRequiresComment',
      skip_offline: 'skipOffline',
      data_element_decoration: 'dataElementDecoration',
      field_combination_required: 'fieldCombinationRequired',
    };
    const applied = {};
    const ignored = [];
    for (const [k, v] of Object.entries(args.patch)) {
      const mapped = KEY_MAP[k];
      if (!mapped) { ignored.push(k); continue; }
      if (mapped === 'shortName' && typeof v === 'string' && v.length > 50) {
        return { _error: `shortName value too long (${v.length} chars). Limit is 50.`, backup: backup.block };
      }
      if (mapped === 'periodType' && !VALID_PERIOD_TYPES.has(v)) {
        return { _error: `Invalid period_type "${v}".`, _hint: `Pick one of: ${[...VALID_PERIOD_TYPES].join(', ')}`, backup: backup.block };
      }
      if (mapped === 'formType' && !VALID_FORM_TYPES.has(v)) {
        return { _error: `Invalid form_type "${v}".`, _hint: `Pick one of: ${[...VALID_FORM_TYPES].join(', ')}`, backup: backup.block };
      }
      dsResp[mapped] = v;
      applied[mapped] = v;
    }
    if (Object.keys(applied).length === 0) {
      return { _error: 'patch supplied no recognized fields', ignored, backup: backup.block };
    }

    const putResp = await safeDhis2Fetch(`dataSets/${dsId}`, { method: 'PUT', body: dsResp });
    if (putResp?._error) return { _error: `Failed to update dataset: ${putResp._error}`, backup: backup.block };
    return {
      success: true,
      action: 'update',
      dataset_id: dsId,
      dataset_name: objName,
      applied,
      ignored: ignored.length ? ignored : undefined,
      backup: backup.block,
    };
  }

  // ── delete ────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_datasets', 'delete', { dataset_id: args.dataset_id });
    if (_gate) return _gate;
    const dsId = args.dataset_id || args.object_id;
    if (!dsId) return { _error: 'dataset_id required for delete' };
    const exists = await verifyTargetExists('dataSets', dsId, 'manage_datasets', 'delete', 'id,displayName');
    if (!exists.exists) return exists.refusal;
    const objName = exists.data?.displayName || dsId;

    const refsResult = await checkMetadataReferences('dataSets', dsId);
    if (refsResult.has_references) {
      return {
        _error: `Cannot delete dataset "${objName}" — it has active references.`,
        references: refsResult.references,
        _hint: buildDeletionHint('dataSets', dsId, refsResult.references),
      };
    }

    const backup = await ensureBackupOrBail(
      { operation: 'delete_dataset', tool: 'manage_datasets', action: 'delete', reason: `Deleting dataset ${objName} (${dsId})` },
      [{ object_type: 'dataSets', object_id: dsId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    // Use /metadata?importStrategy=DELETE for consistency with manage_metadata
    const delResp = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', {
      method: 'POST',
      body: { dataSets: [{ id: dsId }] },
    });
    if (delResp?._error) return { _error: `Dataset deletion failed: ${delResp._error}`, backup: backup.block };

    const stats = delResp?.response?.stats || delResp?.stats || {};
    if ((stats.deleted || 0) >= 1) {
      return {
        success: true,
        deleted: { type: 'dataSets', id: dsId, name: objName },
        message: `Successfully deleted dataset "${objName}".`,
        backup: backup.block,
      };
    }
    const errs = [];
    for (const tr of (delResp?.response?.typeReports || [])) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) errs.push(er.message);
      }
    }
    return {
      _error: `Deletion of "${objName}" was not applied.${errs.length ? ' Errors: ' + errs.join('; ') : ''}`,
      _hint: 'The dataset may still have hidden references (saved data values, completed registrations, sections). Inspect via action="get" before retrying.',
      backup: backup.block,
    };
  }

  // ── add_data_elements ─────────────────────────────────────────────────
  if (action === 'add_data_elements') {
    const _gate = requireWriteAuth('manage_datasets', 'add_data_elements', { dataset_id: args.dataset_id });
    if (_gate) return _gate;
    const dsId = args.dataset_id || args.object_id;
    if (!dsId) return { _error: 'dataset_id required' };
    if (!args.data_element_ids?.length) return { _error: 'data_element_ids[] required' };

    const exists = await verifyTargetExists('dataSets', dsId, 'manage_datasets', 'add_data_elements', 'id,displayName');
    if (!exists.exists) return exists.refusal;

    const dsResp = await safeDhis2Fetch(`dataSets/${dsId}?fields=:owner`);
    if (dsResp?._error) return { _error: `Could not load dataset ${dsId}: ${dsResp._error}` };

    const backup = await ensureBackupOrBail(
      { operation: 'add_data_elements', tool: 'manage_datasets', action: 'add_data_elements', reason: `Adding ${args.data_element_ids.length} DE(s) to dataset ${dsResp.name || dsId}` },
      [{ object_type: 'dataSets', object_id: dsId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const existing = Array.isArray(dsResp.dataSetElements) ? dsResp.dataSetElements : [];
    const existingIds = new Set(existing.map(dse => dse.dataElement?.id).filter(Boolean));
    const ccOverride = args.per_de_category_combo || {};
    const added = [];
    const alreadyPresent = [];
    for (const deId of args.data_element_ids) {
      if (!deId) continue;
      if (existingIds.has(deId)) { alreadyPresent.push(deId); continue; }
      const dse = { dataSet: { id: dsId }, dataElement: { id: deId } };
      if (ccOverride[deId]) dse.categoryCombo = { id: ccOverride[deId] };
      existing.push(dse);
      added.push(deId);
    }
    if (added.length === 0) {
      return {
        success: true,
        dataset_id: dsId,
        message: 'All requested DEs are already on this dataset; nothing to add.',
        already_present: alreadyPresent,
        backup: backup.block,
      };
    }
    dsResp.dataSetElements = existing;
    const putResp = await safeDhis2Fetch(`dataSets/${dsId}`, { method: 'PUT', body: dsResp });
    if (putResp?._error) return { _error: `Failed to add DEs: ${putResp._error}`, backup: backup.block };
    return {
      success: true,
      action: 'add_data_elements',
      dataset_id: dsId,
      added_data_elements: added,
      already_present: alreadyPresent.length ? alreadyPresent : undefined,
      total_data_elements: existing.length,
      backup: backup.block,
    };
  }

  // ── remove_data_elements ──────────────────────────────────────────────
  if (action === 'remove_data_elements') {
    const _gate = requireWriteAuth('manage_datasets', 'remove_data_elements', { dataset_id: args.dataset_id });
    if (_gate) return _gate;
    const dsId = args.dataset_id || args.object_id;
    if (!dsId) return { _error: 'dataset_id required' };
    if (!args.data_element_ids?.length) return { _error: 'data_element_ids[] required' };

    const exists = await verifyTargetExists('dataSets', dsId, 'manage_datasets', 'remove_data_elements', 'id,displayName');
    if (!exists.exists) return exists.refusal;

    const dsResp = await safeDhis2Fetch(`dataSets/${dsId}?fields=:owner`);
    if (dsResp?._error) return { _error: `Could not load dataset ${dsId}: ${dsResp._error}` };

    const backup = await ensureBackupOrBail(
      { operation: 'remove_data_elements', tool: 'manage_datasets', action: 'remove_data_elements', reason: `Removing ${args.data_element_ids.length} DE(s) from dataset ${dsResp.name || dsId}` },
      [{ object_type: 'dataSets', object_id: dsId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const removeSet = new Set(args.data_element_ids);
    const before = (dsResp.dataSetElements || []).length;
    const removedIds = [];
    dsResp.dataSetElements = (dsResp.dataSetElements || []).filter(dse => {
      const id = dse.dataElement?.id;
      if (id && removeSet.has(id)) { removedIds.push(id); return false; }
      return true;
    });
    if (removedIds.length === 0) {
      return {
        success: true,
        dataset_id: dsId,
        message: 'None of the requested DEs were on this dataset.',
        before_count: before,
        backup: backup.block,
      };
    }
    const putResp = await safeDhis2Fetch(`dataSets/${dsId}`, { method: 'PUT', body: dsResp });
    if (putResp?._error) return { _error: `Failed to remove DEs: ${putResp._error}`, backup: backup.block };
    return {
      success: true,
      action: 'remove_data_elements',
      dataset_id: dsId,
      removed_data_elements: removedIds,
      remaining_data_elements: dsResp.dataSetElements.length,
      backup: backup.block,
    };
  }

  // ── assign_org_units ──────────────────────────────────────────────────
  if (action === 'assign_org_units') {
    const _gate = requireWriteAuth('manage_datasets', 'assign_org_units', { dataset_id: args.dataset_id });
    if (_gate) return _gate;
    const dsId = args.dataset_id || args.object_id;
    if (!dsId) return { _error: 'dataset_id required' };
    if (!Array.isArray(args.org_unit_ids)) return { _error: 'org_unit_ids[] required' };
    const mergeMode = ['replace','add','remove'].includes(args.merge_mode) ? args.merge_mode : 'replace';

    const exists = await verifyTargetExists('dataSets', dsId, 'manage_datasets', 'assign_org_units', 'id,displayName');
    if (!exists.exists) return exists.refusal;

    const dsResp = await safeDhis2Fetch(`dataSets/${dsId}?fields=:owner`);
    if (dsResp?._error) return { _error: `Could not load dataset ${dsId}: ${dsResp._error}` };

    const currentIds = (dsResp.organisationUnits || []).map(o => o.id).filter(Boolean);
    const requestedIds = [...new Set(args.org_unit_ids.filter(Boolean))];
    let nextIds;
    if (mergeMode === 'add') nextIds = [...new Set([...currentIds, ...requestedIds])];
    else if (mergeMode === 'remove') {
      const rem = new Set(requestedIds);
      nextIds = currentIds.filter(id => !rem.has(id));
    } else nextIds = requestedIds;

    let backup = { ok: true, block: null };
    if (!args.dry_run_only) {
      backup = await ensureBackupOrBail(
        { operation: 'assign_org_units_dataset', tool: 'manage_datasets', action: 'assign_org_units', reason: `merge_mode=${mergeMode} on ${requestedIds.length} OU(s) for dataset ${dsResp.name || dsId}` },
        [{ object_type: 'dataSets', object_id: dsId, role: 'primary' }],
        args
      );
      if (!backup.ok) return backup.error;
    }

    if (args.dry_run_only) {
      return {
        success: true,
        dry_run: true,
        action: 'assign_org_units',
        dataset_id: dsId,
        merge_mode: mergeMode,
        previous_org_units: currentIds.length,
        requested_org_units: requestedIds.length,
        resulting_org_units: nextIds.length,
      };
    }

    dsResp.organisationUnits = nextIds.map(id => ({ id }));
    const putResp = await safeDhis2Fetch(`dataSets/${dsId}`, { method: 'PUT', body: dsResp });
    if (putResp?._error) return { _error: `Failed to assign OUs: ${putResp._error}`, backup: backup.block };
    return {
      success: true,
      action: 'assign_org_units',
      dataset_id: dsId,
      merge_mode: mergeMode,
      previous_org_units: currentIds.length,
      resulting_org_units: nextIds.length,
      _hint: nextIds.length === 0 ? 'Dataset now has 0 assigned OUs — it will not appear in any user\'s Data Entry app.' : undefined,
      backup: backup.block,
    };
  }

  // ── update_sharing ────────────────────────────────────────────────────
  if (action === 'update_sharing') {
    const _gate = requireWriteAuth('manage_datasets', 'update_sharing', { dataset_id: args.dataset_id });
    if (_gate) return _gate;
    const dsId = args.dataset_id || args.object_id;
    if (!dsId) return { _error: 'dataset_id required' };
    const exists = await verifyTargetExists('dataSets', dsId, 'manage_datasets', 'update_sharing', 'id,displayName');
    if (!exists.exists) return exists.refusal;

    const backup = await ensureBackupOrBail(
      { operation: 'update_sharing_dataset', tool: 'manage_datasets', action: 'update_sharing', reason: `Update sharing on dataset ${exists.data.displayName || dsId}` },
      [{ object_type: 'dataSets', object_id: dsId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const publicAccess = normalizeAccessString(args.public_access, 'rwrw----');
    const sharingPayload = {
      object: {
        publicAccess,
        externalAccess: !!args.external_access,
        userAccesses: (args.user_accesses || []).map(u => ({ id: u.id, access: normalizeAccessString(u.access, 'rwrw----') })),
        userGroupAccesses: (args.user_group_accesses || []).map(g => ({ id: g.id, access: normalizeAccessString(g.access, 'rwrw----') })),
      },
    };
    const resp = await safeDhis2Fetch(`sharing?type=dataSet&id=${dsId}`, {
      method: 'POST', body: sharingPayload,
    });
    if (resp?._error) return { _error: `Sharing update failed: ${resp._error}`, backup: backup.block };
    const dataWriteEnabled = publicAccess.slice(2,4) === 'rw';
    return {
      success: true,
      action: 'update_sharing',
      dataset_id: dsId,
      public_access: publicAccess,
      data_write_enabled: dataWriteEnabled,
      _hint: dataWriteEnabled ? undefined : 'public_access does NOT include data write (positions 3-4 are not "rw"). Users will see the form but Save will silently no-op for them. Use public_access:"rwrw----" to enable data entry.',
      backup: backup.block,
    };
  }

  // ── section CRUD ──────────────────────────────────────────────────────
  if (action === 'create_section' || action === 'update_section' || action === 'delete_section') {
    return await manageDatasetSection(action, args);
  }

  return { _error: `Unknown action: ${action}` };
}

async function createDataset(args) {
  if (!args.dataset_name) return { _error: 'dataset_name required for create' };
  const periodType = args.period_type || 'Monthly';
  if (!VALID_PERIOD_TYPES.has(periodType)) {
    return {
      _error: `Invalid period_type "${periodType}".`,
      _hint: `Pick one of: ${[...VALID_PERIOD_TYPES].join(', ')}`,
    };
  }
  const formType = VALID_FORM_TYPES.has(args.form_type) ? args.form_type : 'DEFAULT';

  await ensureConnected();
  const probeServer = dhis2.baseUrl;

  // Idempotent path: same-turn duplicate "create" calls return the prior result
  // instead of the confusing "name already exists" message against the row WE
  // just wrote.
  const recent = lookupRecentCreation('dataset', args.dataset_name);
  if (recent) {
    return {
      success: true,
      dataset_id: recent.id,
      dataset_name: args.dataset_name,
      message: `Dataset "${args.dataset_name}" was created earlier in this turn (id ${recent.id}). Returning prior result.`,
      _origin: 'recent_creation_cache',
      summary: recent.summary || null,
    };
  }

  // Probe by name to surface the cross-server collision early with a useful
  // error rather than a 409 from the import endpoint.
  const dsProbe = await safeDhis2Fetch(
    `dataSets?filter=name:eq:${encodeURIComponent(args.dataset_name)}&fields=id,name,periodType&pageSize=1`
  );
  if (dsProbe?.dataSets?.length) {
    const existing = dsProbe.dataSets[0];
    return {
      _error: `A dataset named "${args.dataset_name}" already exists (id ${existing.id}, periodType ${existing.periodType}). Pick a different name, or use action="update" / action="add_data_elements" to modify the existing one.`,
      existing,
      _origin_server: probeServer,
    };
  }

  // Resolve categoryCombo
  let categoryComboId = args.category_combo_id;
  if (!categoryComboId) {
    const ccResp = await safeDhis2Fetch('categoryCombos?filter=name:eq:default&fields=id&pageSize=1');
    categoryComboId = ccResp?.categoryCombos?.[0]?.id;
    if (!categoryComboId) return { _error: 'Could not resolve default categoryCombo. Pass category_combo_id explicitly or check the DHIS2 connection.' };
  }

  const dsUid = generateDhis2Uid();
  const seenShorts = new Set();
  const dataset = {
    id: dsUid,
    name: args.dataset_name,
    shortName: clampShortName(args.short_name, args.dataset_name, seenShorts, 'Dataset'),
    periodType,
    formType,
    categoryCombo: { id: categoryComboId },
    mobile: false,
    openFuturePeriods: typeof args.open_future_periods === 'number' ? args.open_future_periods : 0,
    expiryDays: typeof args.expiry_days === 'number' ? args.expiry_days : 0,
    timelyDays: typeof args.timely_days === 'number' ? args.timely_days : 15,
    fieldCombinationRequired: !!args.field_combination_required,
    validCompleteOnly: !!args.valid_complete_only,
    noValueRequiresComment: !!args.no_value_requires_comment,
    skipOffline: !!args.skip_offline,
    dataElementDecoration: !!args.data_element_decoration,
    renderAsTabs: !!args.render_as_tabs,
    renderHorizontally: !!args.render_horizontally,
    compulsoryFieldsCompleteOnly: !!args.compulsory_fields_complete_only,
    notifyCompletingUser: !!args.notify_completing_user,
  };
  if (args.code) dataset.code = String(args.code).slice(0, 50);
  if (args.description) dataset.description = String(args.description);

  // Data set elements (DE attachment)
  const ccOverride = args.per_de_category_combo || {};
  const dataSetElements = [];
  const seenDeIds = new Set();
  if (Array.isArray(args.data_element_ids)) {
    for (const deId of args.data_element_ids) {
      if (!deId || seenDeIds.has(deId)) continue;
      seenDeIds.add(deId);
      const dse = { dataSet: { id: dsUid }, dataElement: { id: deId } };
      if (ccOverride[deId]) dse.categoryCombo = { id: ccOverride[deId] };
      dataSetElements.push(dse);
    }
  }
  if (Array.isArray(args.data_set_elements)) {
    for (const dse of args.data_set_elements) {
      if (!dse?.data_element_id || seenDeIds.has(dse.data_element_id)) continue;
      seenDeIds.add(dse.data_element_id);
      const out = { dataSet: { id: dsUid }, dataElement: { id: dse.data_element_id } };
      if (dse.category_combo_id) out.categoryCombo = { id: dse.category_combo_id };
      dataSetElements.push(out);
    }
  }
  if (dataSetElements.length) dataset.dataSetElements = dataSetElements;

  // Org units
  if (Array.isArray(args.org_unit_ids) && args.org_unit_ids.length) {
    dataset.organisationUnits = [...new Set(args.org_unit_ids.filter(Boolean))].map(id => ({ id }));
  } else if (args.assign_all_org_units) {
    const allRoots = await safeDhis2Fetch('organisationUnits?fields=id&filter=level:eq:1&pageSize=20');
    dataset.organisationUnits = (allRoots?.organisationUnits || []).map(o => ({ id: o.id }));
  }

  // Indicators (display-only on the form)
  if (Array.isArray(args.indicator_ids) && args.indicator_ids.length) {
    dataset.indicators = [...new Set(args.indicator_ids.filter(Boolean))].map(id => ({ id }));
  }

  // Sharing — datasets ARE data-shareable; default rwrw---- so users can enter
  // data immediately. Pass metadata_only_sharing:true to get rw------ instead
  // (staging case).
  const wantedPublic = normalizeAccessString(
    args.public_access,
    args.metadata_only_sharing ? 'rw------' : 'rwrw----'
  );
  dataset.sharing = {
    public: wantedPublic,
    external: !!args.external_access,
    users: {},
    userGroups: {},
  };
  if (Array.isArray(args.user_group_accesses)) {
    for (const ug of args.user_group_accesses) {
      if (!ug?.id) continue;
      dataset.sharing.userGroups[ug.id] = { id: ug.id, access: normalizeAccessString(ug.access, 'rwrw----') };
    }
  }
  if (Array.isArray(args.user_accesses)) {
    for (const u of args.user_accesses) {
      if (!u?.id) continue;
      dataset.sharing.users[u.id] = { id: u.id, access: normalizeAccessString(u.access, 'rwrw----') };
    }
  }

  // Sections — bundled atomically in the same /metadata POST.
  const sections = [];
  if (Array.isArray(args.sections) && args.sections.length) {
    const seenSecNames = new Set();
    for (let i = 0; i < args.sections.length; i++) {
      const sec = args.sections[i];
      if (!sec?.name) continue;
      const secUid = generateDhis2Uid();
      const sectionPayload = {
        id: secUid,
        name: clampShortName(sec.name, sec.name, seenSecNames, `Section ${i + 1}`),
        sortOrder: typeof sec.sort_order === 'number' ? sec.sort_order : i + 1,
        dataSet: { id: dsUid },
        showRowTotals: !!sec.show_row_totals,
        showColumnTotals: !!sec.show_column_totals,
        disableDataElementAutoGroup: !!sec.disable_data_element_auto_group,
        dataElements: (sec.data_element_ids || []).filter(Boolean).map(id => ({ id })),
        indicators: (sec.indicator_ids || []).filter(Boolean).map(id => ({ id })),
      };
      if (sec.description) sectionPayload.description = sec.description;
      sections.push(sectionPayload);
    }
    if (sections.length && formType === 'DEFAULT') {
      // Sections only render in SECTION/SECTION_MULTIORG forms — auto-promote
      // form_type so the user actually sees them. (DHIS2 still accepts sections
      // on a DEFAULT form, but they are silently ignored in the entry UI.)
      dataset.formType = 'SECTION';
    }
  }

  const payload = { dataSets: [dataset] };
  if (sections.length) payload.sections = sections;

  const result = await postMetadataPayload(payload, args.dry_run_only);
  if (!result.success) return { ...result, _origin_server: probeServer };

  const summary = {
    period_type: periodType,
    form_type: dataset.formType,
    data_elements: dataSetElements.length,
    sections: sections.length,
    org_units: (dataset.organisationUnits || []).length,
    public_access: wantedPublic,
  };
  if (!args.dry_run_only) {
    recordRecentCreation('dataset', args.dataset_name, dsUid, summary);
  }

  const hints = [];
  if (wantedPublic.slice(2, 4) !== 'rw') {
    hints.push('Public access does NOT grant data write (positions 3-4 are not "rw") — users will see the form but Save will silently no-op. Use action="update_sharing" with public_access:"rwrw----" to enable data entry.');
  }
  if (!(dataset.organisationUnits || []).length) {
    hints.push('No org units assigned — the dataset is invisible in any user\'s Data Entry app. Use action="assign_org_units" to assign OUs.');
  }
  if (!dataSetElements.length) {
    hints.push('No data elements attached. Use action="add_data_elements" with data_element_ids:[...] to attach DEs.');
  }

  return {
    success: true,
    phase: result.phase,
    dataset_id: dsUid,
    dataset_name: args.dataset_name,
    summary,
    api_path: `/api/dataSets/${dsUid}`,
    stats: result.stats,
    _hints: hints.length ? hints : undefined,
  };
}

async function manageDatasetSection(action, args) {
  const _gate = requireWriteAuth('manage_datasets', action, { dataset_id: args.dataset_id, section_id: args.section_id });
  if (_gate) return _gate;

  if (action === 'create_section') {
    if (!args.dataset_id) return { _error: 'dataset_id required for create_section' };
    if (!args.section_name) return { _error: 'section_name required for create_section' };
    const exists = await verifyTargetExists('dataSets', args.dataset_id, 'manage_datasets', 'create_section', 'id,displayName,formType');
    if (!exists.exists) return exists.refusal;
    const sectionId = generateDhis2Uid();
    const section = {
      id: sectionId,
      name: args.section_name,
      sortOrder: typeof args.sort_order === 'number' ? args.sort_order : 1,
      dataSet: { id: args.dataset_id },
      showRowTotals: !!args.show_row_totals,
      showColumnTotals: !!args.show_column_totals,
      disableDataElementAutoGroup: !!args.disable_data_element_auto_group,
      dataElements: (args.data_element_ids || []).filter(Boolean).map(id => ({ id })),
      indicators: (args.indicator_ids || []).filter(Boolean).map(id => ({ id })),
    };
    if (args.description) section.description = args.description;
    const result = await postMetadataPayload({ sections: [section] }, args.dry_run_only);
    if (!result.success) return result;
    const hints = [];
    if (exists.data?.formType && exists.data.formType !== 'SECTION' && exists.data.formType !== 'SECTION_MULTIORG') {
      hints.push(`Dataset formType is "${exists.data.formType}" — sections do not render in this form type. Switch to SECTION via action="update", patch:{form_type:"SECTION"} so the new section is visible.`);
    }
    return {
      success: true,
      action: 'create_section',
      section_id: sectionId,
      dataset_id: args.dataset_id,
      name: args.section_name,
      _hints: hints.length ? hints : undefined,
    };
  }

  if (action === 'update_section') {
    if (!args.section_id) return { _error: 'section_id required for update_section' };
    const exists = await verifyTargetExists('sections', args.section_id, 'manage_datasets', 'update_section', 'id,name,dataSet[id]');
    if (!exists.exists) return exists.refusal;
    const secResp = await safeDhis2Fetch(`sections/${args.section_id}?fields=:owner`);
    if (secResp?._error) return { _error: `Could not load section ${args.section_id}: ${secResp._error}` };
    const backup = await ensureBackupOrBail(
      { operation: 'update_section', tool: 'manage_datasets', action: 'update_section', reason: `Update section ${secResp.name || args.section_id}` },
      [{ object_type: 'sections', object_id: args.section_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;
    if (args.section_name) secResp.name = args.section_name;
    if (typeof args.sort_order === 'number') secResp.sortOrder = args.sort_order;
    if (Array.isArray(args.data_element_ids)) {
      secResp.dataElements = args.data_element_ids.filter(Boolean).map(id => ({ id }));
    }
    if (Array.isArray(args.indicator_ids)) {
      secResp.indicators = args.indicator_ids.filter(Boolean).map(id => ({ id }));
    }
    if (typeof args.show_row_totals === 'boolean') secResp.showRowTotals = args.show_row_totals;
    if (typeof args.show_column_totals === 'boolean') secResp.showColumnTotals = args.show_column_totals;
    if (typeof args.disable_data_element_auto_group === 'boolean') {
      secResp.disableDataElementAutoGroup = args.disable_data_element_auto_group;
    }
    if (args.description != null) secResp.description = args.description;
    const putResp = await safeDhis2Fetch(`sections/${args.section_id}`, { method: 'PUT', body: secResp });
    if (putResp?._error) return { _error: `Section update failed: ${putResp._error}`, backup: backup.block };
    return {
      success: true,
      action: 'update_section',
      section_id: args.section_id,
      backup: backup.block,
    };
  }

  if (action === 'delete_section') {
    if (!args.section_id) return { _error: 'section_id required for delete_section' };
    const exists = await verifyTargetExists('sections', args.section_id, 'manage_datasets', 'delete_section', 'id,name,dataSet[id]');
    if (!exists.exists) return exists.refusal;
    const backup = await ensureBackupOrBail(
      { operation: 'delete_section', tool: 'manage_datasets', action: 'delete_section', reason: `Deleting section ${exists.data.name || args.section_id}` },
      [{ object_type: 'sections', object_id: args.section_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;
    const delResp = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', {
      method: 'POST',
      body: { sections: [{ id: args.section_id }] },
    });
    if (delResp?._error) return { _error: `Section deletion failed: ${delResp._error}`, backup: backup.block };
    const stats = delResp?.response?.stats || delResp?.stats || {};
    if ((stats.deleted || 0) >= 1) {
      return {
        success: true,
        deleted: { type: 'sections', id: args.section_id, name: exists.data.name || args.section_id },
        backup: backup.block,
      };
    }
    return { _error: `Section deletion was not applied. Stats: ${JSON.stringify(stats)}`, backup: backup.block };
  }
}

// ── manage_backups: list/get/restore/delete/purge_old metadata backups ──
async function executeManageBackups(args) {
  const action = args?.action;
  if (!action) return { _error: 'Missing required parameter: action', _hint: 'One of: list, get, restore, delete, purge_old.' };

  if (action === 'list') {
    return await listBackups({
      limit: args.limit,
      since: args.since,
      operation: args.operation,
      preview: args.preview,
    });
  }

  if (action === 'get') {
    if (!args.backup_key) return { _error: 'backup_key required for get' };
    const v = await safeDhis2Fetch(
      `dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(args.backup_key)}`
    );
    if (v?._error) return { _error: `Could not load backup ${args.backup_key}: ${v._error}` };
    return v;
  }

  if (action === 'restore') {
    const _gate = requireWriteAuth('manage_backups', 'restore', { backup_key: args.backup_key });
    if (_gate) return _gate;
    if (!args.backup_key) return { _error: 'backup_key required for restore' };
    return await restoreFromBackup(args.backup_key);
  }

  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_backups', 'delete', { backup_key: args.backup_key });
    if (_gate) return _gate;
    if (!args.backup_key) return { _error: 'backup_key required for delete' };
    const d = await safeDhis2Fetch(
      `dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(args.backup_key)}`,
      { method: 'DELETE', allowEmptyBody: true }
    );
    if (d?._error) return { _error: `Could not delete backup ${args.backup_key}: ${d._error}` };
    return { success: true, deleted_backup_key: args.backup_key };
  }

  if (action === 'purge_old') {
    const _gate = requireWriteAuth('manage_backups', 'purge_old');
    if (_gate) return _gate;
    return await purgeOldBackups(args.retention_days);
  }

  return { _error: `Unknown action: ${action}. Use: list, get, restore, delete, purge_old.` };
}

// ── Metadata Creation Engine ─────────────────────────────────────────────────

async function executeCreateMetadata(args, contextOrgUnitId) {
  const action = args.action;
  if (!action) return { _error: 'Missing required parameter: action' };

  // create_metadata is ALWAYS destructive (POSTs new objects). Gate on write auth.
  const _gate = requireWriteAuth('create_metadata', action);
  if (_gate) return _gate;

  try {
    // Resolve default category combo
    const catComboResp = await safeDhis2Fetch('categoryCombos?filter=name:eq:default&fields=id&pageSize=1');
    const defaultCatComboId = catComboResp?.categoryCombos?.[0]?.id;
    if (!defaultCatComboId) return { _error: 'Could not resolve default categoryCombo. Check DHIS2 connection.' };

    if (action === 'create_program') {
      return await createFullProgram(args, defaultCatComboId, contextOrgUnitId);
    } else if (action === 'add_stage') {
      return await addStageToProgram(args, defaultCatComboId);
    } else if (action === 'add_data_elements_to_stage') {
      return await addDataElementsToExistingStage(args, defaultCatComboId);
    } else if (action === 'add_program_rules') {
      return await addProgramRules(args);
    } else if (action === 'create_option_set') {
      return await createStandaloneOptionSet(args);
    } else if (action === 'create_data_elements') {
      return await createStandaloneDataElements(args, defaultCatComboId);
    } else if (action === 'create_category_combo') {
      return await createStandaloneCategoryCombo(args);
    } else {
      return { _error: `Unknown action: ${action}. Use one of: create_program, add_stage, add_data_elements_to_stage, add_program_rules, create_option_set, create_data_elements, create_category_combo` };
    }
  } catch (err) {
    return { _error: `Metadata creation failed: ${err.message}` };
  }
}

function sanitizeVariableName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 255);
}

// Resolve every #{token} / A{token} in a rule's condition AND action `data`
// expressions to a data element / tracked-entity attribute: exact
// sanitized-name match first, then a UNIQUE prefix match either way round
// (e.g. #{muac} → DE "MUAC in cm" whose sanitized name muac_in_cm starts with
// the token). Tokens already backed by an existing PRV name are skipped.
//
// The token is SANITIZED before matching, so a display-name token like
// A{Date of Birth} resolves to the TEA "Date of Birth" and the rule text is
// auto-rewritten to the canonical sanitized form (A{date_of_birth}) — models
// routinely emit display names here, and refusing over pure spelling was the
// single most common create_program failure ("references unresolved
// variable(s): A{Date of Birth}"). An A{token} that matches a DATA ELEMENT is
// healed to #{token} (A{} is attribute-only in the rule grammar). Every such
// rewrite is reported in `rewrites` so callers can surface it.
//
// Genuinely ambiguous or unmatched tokens land in `unresolved` so the caller
// can REFUSE the import instead of silently creating rules that never fire
// (E2E-verified failure mode: condition "#{muac} >= 11.5" with no muac PRV
// imports fine but the rule engine rejects the expression at runtime).
function resolveRuleTokenBindings(rule, deNames, teaNames, existingVarNames = new Set()) {
  const text = `${rule.condition || ''} ${(rule.actions || []).map(a => a.data || '').join(' ')}`;
  const bindings = [];
  const unresolved = [];
  const rewrites = [];
  const seen = new Set();
  // sanitize(existing PRV name) → actual PRV name, so a display-name token can
  // be rewritten onto a PRV that already exists under the sanitized name.
  const existingBySanitized = new Map();
  for (const n of existingVarNames) existingBySanitized.set(sanitizeVariableName(n), n);
  const rewriteToken = (teaOnly, fromToken, toToken, toTeaForm) => {
    const from = (teaOnly ? 'A{' : '#{') + fromToken + '}';
    const to = (toTeaForm === undefined ? teaOnly : toTeaForm) ? `A{${toToken}}` : `#{${toToken}}`;
    if (from === to) return;
    rule.condition = String(rule.condition || '').split(from).join(to);
    for (const act of (rule.actions || [])) {
      if (act.data) act.data = String(act.data).split(from).join(to);
    }
    rewrites.push({ from, to });
  };
  const resolve = (token, teaOnly) => {
    // Exact sanitized-name match, preferred kind first. An A{} token that
    // actually names a DATA ELEMENT still matches (kind 'de') and the caller
    // heals the brace style to #{} — refusing over the wrong prefix helps
    // nobody.
    const exact = (names, kind) => {
      for (const n of names) if (sanitizeVariableName(n) === token) return { kind, name: n };
      return null;
    };
    const prefix = (names, kind) => {
      const out = [];
      for (const n of names) {
        const s = sanitizeVariableName(n);
        if (s.startsWith(token) || token.startsWith(s)) out.push({ kind, name: n });
      }
      return out;
    };
    const kinds = teaOnly
      ? [[teaNames, 'tea'], [deNames, 'de']]
      : [[deNames, 'de'], [teaNames, 'tea']];
    for (const [names, kind] of kinds) {
      const hit = exact(names, kind);
      if (hit) return hit;
    }
    // UNIQUE prefix match: preferred kind wins outright; the other kind only
    // counts when the preferred kind had no candidate at all.
    const preferred = prefix(kinds[0][0], kinds[0][1]);
    if (preferred.length === 1) return preferred[0];
    if (preferred.length > 1) return null;
    const other = prefix(kinds[1][0], kinds[1][1]);
    return other.length === 1 ? other[0] : null;
  };
  for (const [re, teaOnly] of [[/#\{([^}]+)\}/g, false], [/A\{([^}]+)\}/g, true]]) {
    for (const m of text.matchAll(re)) {
      const token = m[1].trim();
      const key = (teaOnly ? 'A:' : '#:') + token;
      if (seen.has(key)) continue;
      seen.add(key);
      if (existingVarNames.has(token)) continue; // already a PRV on the program
      const sanToken = sanitizeVariableName(token);
      // Display-name/casing variant of an existing PRV → rewrite onto it.
      if (sanToken !== token && existingBySanitized.has(sanToken)) {
        rewriteToken(teaOnly, token, existingBySanitized.get(sanToken));
        continue;
      }
      const b = resolve(sanToken, teaOnly);
      if (b) {
        // Canonicalize: sanitized token, #{} for DEs / A{} for TEAs.
        const wantTeaForm = b.kind === 'tea';
        if (sanToken !== token || wantTeaForm !== teaOnly) {
          rewriteToken(teaOnly, token, sanToken, wantTeaForm);
        }
        bindings.push({ token: sanToken, ...b });
      } else {
        unresolved.push(teaOnly ? `A{${token}}` : `#{${token}}`);
      }
    }
  }
  return { bindings, unresolved, rewrites };
}

// DHIS2 icon search is prefix-matched against the keyword tree (e.g. the
// keyword "pregnant" is reachable from search="preg"/"pregnan", but search=
// "pregnancy" returns 0 hits — the trailing 'y' breaks the prefix). Models
// regularly fabricate icon keys ("pregnancy_positive", "vaccinated_positive"),
// then a single failed lookup makes the chatbot punt on the icon entirely.
//
// This resolver tries every cheap prefix variant before giving up:
//   1. exact key (icons/<input>)
//   2. full-input search
//   3. drop the canonical suffix (_positive/_negative/_outline) and re-search
//   4. tokenize the base on '_' and search each token
//   5. progressively shorten the longest token from the right (down to 4 chars)
//      so "pregnancy" → "pregnanc" → "pregnan" matches the "pregnant" keyword
// All paths return at most one resolved key, preferring the _positive variant
// when the user didn't explicitly pick a different shape.
async function resolveDhis2IconKey(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'empty input' };

  const SUFFIX_RE = /_(positive|negative|outline)$/i;
  const requestedSuffix = (raw.match(SUFFIX_RE)?.[1] || '').toLowerCase();
  const preferSuffix = requestedSuffix || 'positive';

  const pickCandidate = (candidates) => {
    if (!candidates?.length) return null;
    // Among matches with the preferred suffix, pick the shortest key — shorter
    // = more general (e.g. "pregnant_positive" beats "pregnant_0812w_positive"
    // when the user just asked for a "pregnancy" icon). Fall back to the first
    // candidate if no suffix match.
    const suffixed = candidates.filter(c => new RegExp(`_${preferSuffix}$`, 'i').test(c.key));
    if (suffixed.length) {
      return suffixed.slice().sort((a, b) => a.key.length - b.key.length)[0];
    }
    return candidates.slice().sort((a, b) => a.key.length - b.key.length)[0];
  };

  // Step 1: exact key
  const exact = await safeDhis2Fetch(`icons/${encodeURIComponent(raw)}?fields=key`);
  if (!exact?._error && exact?.key) {
    return { ok: true, key: exact.key, note: null };
  }

  const tried = [];

  // Helper: run a search query and return non-empty candidates (or null).
  const searchTerm = async (term) => {
    if (!term || term.length < 3) return null;
    tried.push(term);
    const r = await safeDhis2Fetch(`icons?search=${encodeURIComponent(term)}&fields=key,keywords&pageSize=50`);
    const list = r?.icons || [];
    return list.length ? list : null;
  };

  // Step 2: full-input search.
  let cands = await searchTerm(raw);

  // Step 3: drop suffix.
  const base = raw.replace(SUFFIX_RE, '');
  if (!cands && base !== raw) cands = await searchTerm(base);

  // Step 4: tokenize on _ and try each token, longest first.
  if (!cands) {
    const tokens = base.split(/[_\s-]+/).filter(t => t.length >= 3).sort((a, b) => b.length - a.length);
    for (const tok of tokens) {
      cands = await searchTerm(tok);
      if (cands) break;
    }
  }

  // Step 5: shrink the longest token from the right (prefix matching).
  if (!cands) {
    const longest = base.split(/[_\s-]+/).sort((a, b) => b.length - a.length)[0] || base;
    for (let n = longest.length - 1; n >= 4; n--) {
      cands = await searchTerm(longest.slice(0, n));
      if (cands) break;
    }
  }

  if (!cands) {
    return { ok: false, error: `no icons matched (tried: ${tried.slice(0, 6).join(', ') || raw})`, tried };
  }

  const chosen = pickCandidate(cands);
  return {
    ok: true,
    key: chosen.key,
    note: `Resolved "${raw}" to icon "${chosen.key}" via prefix-search fallback (${cands.length} candidate${cands.length === 1 ? '' : 's'}: ${cands.slice(0, 5).map(c => c.key).join(', ')}${cands.length > 5 ? '…' : ''}).`,
    candidates: cands.slice(0, 8).map(c => c.key),
  };
}

// DHIS2 access strings are EXACTLY 8 chars long, alphabet [rwd-]:
//   pos 1-2: metadata read/write
//   pos 3-4: data read/write
//   pos 5-8: reserved (must remain '-')
// Models occasionally fabricate malformed strings ("r--------" = 9 chars,
// "rwrw" = 4, "rwxr----" = wrong chars). DHIS2 then bails with
// "Invalid access string" and rolls the whole atomic metadata import back.
// This helper coerces ANY input into a canonical 8-char [rw-] string so the
// import never blows up on length / alphabet, regardless of which path built it.
function normalizeAccessString(input, fallback = 'rw------') {
  const cleanFallback = String(fallback || 'rw------').replace(/[^rw-]/gi, '-').toLowerCase().padEnd(8, '-').slice(0, 8);
  if (input == null || input === '') return cleanFallback;
  let str = String(input).replace(/[^rw-]/gi, '-').toLowerCase();
  if (str.length > 8) str = str.slice(0, 8);
  if (str.length < 8) str = str.padEnd(8, '-');
  return str;
}

// DHIS2 rejects data-level sharing (positions 3-4 / 7-8 of the 8-char access string)
// on object classes whose schema reports dataShareable=false — notably DataElement,
// OptionSet, TrackedEntityAttribute, ProgramIndicator. Attempting to POST them with
// "rwrw----" raises "Data sharing is not enabled for <klass>" and the whole atomic
// metadata import rolls back. This helper returns a clone of the sharing block with
// the data-access bits zeroed out everywhere (public string + every user/userGroup
// entry), so the same user intent ("share with me, give full access") flows through
// intact while the payload stays legal for metadata-only-shareable classes.
function toMetadataOnlySharing(sharing) {
  if (!sharing) return sharing;
  const stripData = (s) => {
    const str = normalizeAccessString(s, 'rw------');
    return str[0] + str[1] + '--' + str[4] + str[5] + '--';
  };
  const clone = {
    public: stripData(sharing.public),
    external: !!sharing.external,
    users: {},
    userGroups: {},
  };
  for (const [uid, entry] of Object.entries(sharing.users || {})) {
    clone.users[uid] = { id: entry.id || uid, access: stripData(entry.access) };
  }
  for (const [gid, entry] of Object.entries(sharing.userGroups || {})) {
    clone.userGroups[gid] = { id: entry.id || gid, access: stripData(entry.access) };
  }
  if (sharing.owner) clone.owner = sharing.owner;
  return clone;
}

// DHIS2 hard-rejects shortName values that are > 50 chars, empty, or
// duplicate within a single atomic metadata import. Plain .substring(0, 50)
// is not enough: it can split a UTF-16 surrogate pair, leave trailing
// whitespace, or produce identical 50-char prefixes for two long names that
// share their first 50 chars (the import then fails with "Property
// `shortName` with value `…`" — the exact symptom we keep hitting on
// programs with verbose DE names like "Was the patient diagnosed with severe
// acute … in childhood / adulthood"). This helper:
//   • coerces to a non-empty trimmed string (with a fallback)
//   • truncates to 50 chars and repairs an orphan high-surrogate
//   • when a `seen` Set is supplied, auto-suffixes a 4-char UID shard on
//     collision so every shortName in the same atomic POST stays unique
function clampShortName(rawShort, rawName, seen = null, fallback = 'Object') {
  const pick = (v) => (v != null && String(v).trim()) ? String(v).trim() : '';
  let s = pick(rawShort) || pick(rawName) || fallback;
  if (s.length > 50) s = s.slice(0, 50);
  // Repair orphaned high-surrogate at the truncation boundary
  const lastCode = s.charCodeAt(s.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) s = s.slice(0, -1);
  s = s.replace(/\s+$/, '');
  if (!s) s = fallback;
  if (seen) {
    if (seen.has(s)) {
      // Trim 5 chars to leave room for " " + 4-char UID shard.
      const base = s.slice(0, 45).replace(/\s+$/, '');
      let candidate = `${base} ${generateDhis2Uid().slice(-4)}`;
      let guard = 0;
      while (seen.has(candidate) && guard++ < 5) {
        candidate = `${base} ${generateDhis2Uid().slice(-4)}`;
      }
      s = candidate;
    }
    seen.add(s);
  }
  return s;
}

// DHIS2 enforces a Postgres-level UNIQUE constraint on `shortName` for several
// classes (DataElement, TrackedEntityAttribute, Program, ProgramIndicator).
// Per-payload dedupe (clampShortName + seen Set) only handles same-batch
// collisions. A new object whose name happens to truncate to a shortName
// already present in DHIS2 still raises "Property `shortName` with value …"
// or a raw 409 "duplicate key value violates unique constraint". This helper
// pre-probes the server for every candidate shortName in one batched filter
// query and auto-suffixes a 4-char UID shard on any collision so the import
// proceeds atomically. Skips objects already flagged `_skip` (= reused by
// name).
async function disambiguateShortNamesAgainstServer(objects, dhis2Resource, classKey) {
  if (!Array.isArray(objects) || objects.length === 0) return;
  const candidates = objects.filter(o => o && !o._skip && o.shortName);
  if (candidates.length === 0) return;

  // Batch in chunks of 50 to stay under URL length limits, and run the
  // batches in parallel — DHIS2 happily serves these concurrently and the
  // wall-clock saving on a 100+ DE program is several hundred ms.
  const seenInBatch = new Set();
  const conflicts = new Set();
  const batches = [];
  for (let i = 0; i < candidates.length; i += 50) {
    batches.push(candidates.slice(i, i + 50));
  }
  const responses = await Promise.all(batches.map(batch => {
    const filter = batch.map(o => encodeURIComponent(o.shortName)).join(',');
    return safeDhis2Fetch(
      `${dhis2Resource}?filter=shortName:in:[${filter}]&fields=id,shortName&pageSize=100&paging=false`
    );
  }));
  for (let i = 0; i < responses.length; i++) {
    const resp = responses[i];
    if (resp && resp[classKey]) {
      const ourIds = new Set(batches[i].map(o => o.id));
      for (const ex of resp[classKey]) {
        // Only treat as conflict if the existing record is a DIFFERENT object
        // (not the one we are creating with our own pre-generated UID).
        if (!ourIds.has(ex.id) && ex.shortName) {
          conflicts.add(ex.shortName);
        }
      }
    }
  }

  if (conflicts.size === 0) return;

  for (const obj of candidates) {
    if (!conflicts.has(obj.shortName) && !seenInBatch.has(obj.shortName)) {
      seenInBatch.add(obj.shortName);
      continue;
    }
    // Trim 5 chars to leave room for " " + 4-char UID shard.
    const base = obj.shortName.slice(0, 45).replace(/\s+$/, '');
    let suffixed;
    let guard = 0;
    do {
      suffixed = `${base} ${generateDhis2Uid().slice(-4)}`;
      guard++;
    } while ((conflicts.has(suffixed) || seenInBatch.has(suffixed)) && guard < 5);
    obj.shortName = suffixed;
    seenInBatch.add(suffixed);
  }
}

// Generate a DHIS2-valid, UNIQUE option code from an option name.
//
// DHIS2 enforces a per-option-set unique code (DB constraint
// `optionvalue_unique_optionsetid_and_code`). The naive `toUpperCase().replace(/[^A-Z0-9]/g,'_')`
// collapses any two names that differ only by a symbol — "A+" and "A-" both become "A_",
// "1+"/"1-" both become "1_" — so two options in one set get the SAME code and the COMMIT
// fails with a 409. The metadata VALIDATE pass can NOT catch this: it's a database unique
// constraint, not a metadata-import rule, so it only surfaces at COMMIT (INSERT) time.
//
// Fix: (1) map a trailing +/- sign to a readable _POS/_NEG token so the common
// blood-group / lab-result / urine-protein cases stay meaningful AND distinct, (2) sanitize
// the rest, then (3) guarantee uniqueness against codes already used in the same scope by
// appending _2, _3, … This makes the generated codes collision-free by construction, so the
// tool never emits a request that 409s on the duplicate-code constraint.
function deriveOptionCode(rawName, usedCodes, explicitCode) {
  const used = usedCodes instanceof Set ? usedCodes : new Set();
  const sanitize = (s) => String(s == null ? '' : s)
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  let base;
  if (explicitCode && String(explicitCode).trim()) {
    base = sanitize(explicitCode) || 'OPT';
  } else {
    let s = String(rawName == null ? '' : rawName).trim();
    let sign = '';
    const m = s.match(/([+\-])\s*$/); // trailing sign: A+, A-, 1+, 3-, O+ …
    if (m) { sign = m[1] === '+' ? '_POS' : '_NEG'; s = s.slice(0, m.index); }
    base = (sanitize(s) + sign).replace(/^_+/, '').slice(0, 50) || 'OPT';
  }
  let code = base;
  let n = 2;
  while (used.has(code)) {
    const suffix = `_${n}`;
    code = `${base.slice(0, 50 - suffix.length)}${suffix}`;
    n++;
  }
  used.add(code);
  return code;
}

function buildOptionSetAndOptions(osDef, parentValueType) {
  const osUid = generateDhis2Uid();
  const options = [];
  const optionUids = [];
  // Codes must be unique WITHIN this option set — track what we have minted so
  // "A+"/"A-" (and any other symbol-only-difference names) never collide.
  const usedCodes = new Set();
  for (let i = 0; i < osDef.options.length; i++) {
    const raw = osDef.options[i];
    const optName = (typeof raw === 'string') ? raw : (raw?.name ?? raw?.displayName ?? String(raw));
    const explicitCode = (raw && typeof raw === 'object') ? (raw.code ?? raw.optionCode) : undefined;
    const optUid = generateDhis2Uid();
    optionUids.push(optUid);
    options.push({
      id: optUid,
      name: optName,
      code: deriveOptionCode(optName, usedCodes, explicitCode),
      sortOrder: i + 1,
    });
  }
  // Option set valueType MUST match the parent DE/TEA. DHIS2 supports MULTI_TEXT
  // for multi-select option sets; pairing a MULTI_TEXT DE with a TEXT option set
  // breaks multi-select rendering in Capture/New Tracker silently. Order of
  // precedence: explicit osDef.value_type > inferred from parent > TEXT default.
  let osValueType = osDef.value_type || osDef.valueType;
  if (!osValueType) {
    osValueType = parentValueType === 'MULTI_TEXT' ? 'MULTI_TEXT' : 'TEXT';
  }
  const optionSet = {
    id: osUid,
    name: osDef.name,
    valueType: osValueType,
    options: optionUids.map(id => ({ id })),
  };
  return { optionSet, options, osUid };
}

// Safety net for when the model omits value_type on a data element / attribute.
// Historically the builder silently defaulted to TEXT, so an obviously numeric
// field ("Height in cm", "Weight in kg", "Head circumference", "Age in months")
// could be created as TEXT — blocking numeric validation, indicators and charts.
// This only fires when value_type is ABSENT; an explicit value_type always wins.
// Kept deliberately conservative: only high-confidence cues flip the default.
function inferValueType(rawName, fallback = 'TEXT') {
  const name = String(rawName || '').toLowerCase().trim();
  if (!name) return fallback;
  // Date-ish
  if (/\b(dob|date of birth|birth\s?date|date)\b/.test(name)) return 'DATE';
  // Count / age / "number of …" → whole numbers
  if (/\bage\b|\bage in (months|years|days|weeks)\b/.test(name)) return 'INTEGER';
  if (/\b(number of|no\.? of|count of|count|# of|quantity|qty|doses?|visits?|episodes?)\b/.test(name)) return 'INTEGER';
  // Measurements / vitals / generic numerics, incl. unit suffixes like (cm)/(kg)/(mm)/(g)
  if (/\b(height|weight|circumference|temperature|temp|bmi|length|width|diameter|pressure|pulse|heart rate|respiratory rate|spo2|saturation|glucose|haemoglobin|hemoglobin|dosage|dose|score|level|amount|volume|distance|measurement|reading)\b/.test(name)) return 'NUMBER';
  if (/\bpercent(age)?\b|\(\s*%\s*\)|\s%$/.test(name)) return 'PERCENTAGE';
  if (/\(\s*(cm|kg|mm|g|ml|mg|cm3|m|kg\/m2|mmhg|bpm|°c|c)\s*\)|\b(in|in cm|in kg|in mm|in g|in ml)\b/.test(name)) return 'NUMBER';
  return fallback;
}

function buildDataElement(de, defaultCatComboId, optionSetUidMap, seenShortNames = null, opts = {}) {
  const uid = generateDhis2Uid();
  // Aggregate DEs (used by dataSets) need domainType:AGGREGATE + a real
  // aggregationType (SUM by default). Tracker DEs stay TRACKER + NONE so the
  // existing program-builder paths are unchanged. A per-DE override on the
  // input always wins; opts is the shared default for a batch.
  const domainType =
    de.domain_type ||
    de.domainType ||
    opts.domainType ||
    'TRACKER';
  const isAggregate = domainType === 'AGGREGATE';
  const aggregationType =
    de.aggregation_type ||
    de.aggregationType ||
    opts.aggregationType ||
    (isAggregate ? 'SUM' : 'NONE');
  // Per-DE categoryCombo override (set by the dataset/disagg flow), then the
  // batch-level override, then the system default. The system default is what
  // every existing tracker DE will receive (no disaggregation).
  const ccId =
    de.category_combo_id ||
    de.categoryComboId ||
    opts.categoryComboId ||
    defaultCatComboId;
  const elem = {
    id: uid,
    name: de.name,
    shortName: clampShortName(de.short_name, de.name, seenShortNames, 'Data Element'),
    domainType,
    // Explicit value_type always wins. When absent, infer from the name so
    // numeric fields are not silently created as TEXT — but never infer when an
    // option set is attached (those are code-valued, keep TEXT default). When an
    // EXISTING option set is referenced, the DE valueType is AUTHORITATIVELY the
    // set's own valueType (TEXT/MULTI_TEXT) — a mismatch would make the DE
    // unusable, so the referenced set wins over any inferred/passed value_type.
    valueType: de._optionSetRef
      ? (de._optionSetRef.valueType || 'TEXT')
      : (de.value_type || (de.option_set ? 'TEXT' : inferValueType(de.name, 'TEXT'))),
    aggregationType,
    categoryCombo: { id: ccId },
  };
  if (de.option_set && optionSetUidMap[de.option_set.name]) {
    elem.optionSet = { id: optionSetUidMap[de.option_set.name] };
  } else if (de._optionSetRef && de._optionSetRef.id) {
    elem.optionSet = { id: de._optionSetRef.id };
  }
  if (de.code && typeof de.code === 'string' && de.code.trim()) {
    elem.code = de.code.trim();
  }
  if (de.description && typeof de.description === 'string') {
    elem.description = de.description;
  }
  return { elem, uid };
}

// Materialize CategoryOptionCombos for any newly-created CategoryCombo. DHIS2
// does NOT auto-generate the CoC table on /metadata POST — without this call,
// every dataElement using the new combo is unenterable in the form (the cell
// has no CoC to bind to, so Save silently no-ops). This is the single most
// common silent-failure path on disaggregation creation, so the chatbot ALWAYS
// calls it after a combo POST. Returns true on success; failure is non-fatal
// (the combo is still saved, but the user sees an empty form until they hit
// "Maintenance > Update category option combinations" in the UI).
async function triggerCategoryOptionComboUpdate() {
  const resp = await safeDhis2Fetch('maintenance/categoryOptionComboUpdate', { method: 'POST' });
  if (resp?._error) return { ok: false, error: resp._error };
  return { ok: true };
}

// Resolve a category-option request against the server. Reuse-by-name keeps
// the metadata graph clean: when the user says "Male / Female", we should not
// create new options if Gender already lives there with those exact options.
// Returns a Map<lowercaseName, { id, name, isExisting }> populated for every
// requested name.
async function resolveCategoryOptionsByName(requestedNames) {
  const map = new Map();
  const list = Array.from(new Set(requestedNames.map(n => String(n || '').trim()).filter(Boolean)));
  if (!list.length) return map;
  // Batch in /api/categoryOptions?filter=name:in:[...]
  const enc = list.map(n => encodeURIComponent(n)).join(',');
  const resp = await safeDhis2Fetch(`categoryOptions?filter=name:in:[${enc}]&fields=id,name&pageSize=200`);
  const found = resp?.categoryOptions || [];
  const byLower = new Map();
  for (const co of found) {
    if (co?.name) byLower.set(co.name.toLowerCase(), co);
  }
  for (const name of list) {
    const hit = byLower.get(name.toLowerCase());
    if (hit) {
      map.set(name.toLowerCase(), { id: hit.id, name: hit.name, isExisting: true });
    }
  }
  return map;
}

// Build the atomic /metadata payload for a categoryCombo plus its dependencies,
// reusing existing categories/options by exact-name match wherever possible.
// Inputs:
//   combo.name (required)
//   combo.code (optional)
//   combo.data_dimension_type ('DISAGGREGATION' | 'ATTRIBUTE') — default DISAGGREGATION
//   combo.skip_total (optional, default false)
//   combo.categories[] — each item is one of:
//     { id: '<existingCategoryUid>' }                    (reuse as-is)
//     { name: 'Gender' }                                 (reuse-by-name; fails if missing)
//     { name: 'HIV Result', options: ['Positive','Negative'], code? } (build new; reuses any
//                                                                    options that already
//                                                                    exist by exact name)
// Returns: { uid, payload, summary, _error? }
async function buildCategoryComboBundle(combo) {
  if (!combo?.name) return { _error: 'category_combo.name required' };
  if (!Array.isArray(combo.categories) || combo.categories.length === 0) {
    return { _error: 'category_combo.categories must be a non-empty array' };
  }

  const ddt = (combo.data_dimension_type || combo.dataDimensionType || 'DISAGGREGATION').toUpperCase();
  if (ddt !== 'DISAGGREGATION' && ddt !== 'ATTRIBUTE') {
    return { _error: `Invalid data_dimension_type "${ddt}". Use DISAGGREGATION or ATTRIBUTE.` };
  }

  // 1. Pre-collect every option name we may need to reuse, across every
  //    "build new" category. One server probe instead of N.
  const allOptionNames = [];
  for (const c of combo.categories) {
    if (c.options && Array.isArray(c.options)) {
      for (const opt of c.options) {
        const n = typeof opt === 'string' ? opt : opt?.name;
        if (n) allOptionNames.push(n);
      }
    }
  }
  const optionMap = await resolveCategoryOptionsByName(allOptionNames);

  // 2. Probe every "reuse-by-name" or "build new" category against the server
  //    so we don't create duplicate "Gender"/"HIV Result" rows on every call.
  const catNamesToProbe = combo.categories
    .filter(c => !c.id && c.name)
    .map(c => c.name.trim())
    .filter(Boolean);
  let existingCats = [];
  if (catNamesToProbe.length) {
    const enc = catNamesToProbe.map(n => encodeURIComponent(n)).join(',');
    const resp = await safeDhis2Fetch(
      `categories?filter=name:in:[${enc}]&fields=id,name,categoryOptions[id,name]&pageSize=200`
    );
    existingCats = resp?.categories || [];
  }
  const catByLower = new Map();
  for (const c of existingCats) if (c?.name) catByLower.set(c.name.toLowerCase(), c);

  // 3. Walk the requested list and decide reuse vs. create for each.
  const newOptions = [];
  const newOptionUidsByLower = new Map();
  // Category-option codes collide on the same "A+"/"A-" → "A_" problem; keep them
  // unique across everything we mint in this bundle.
  const usedOptionCodes = new Set();
  const newCategories = [];
  const resolvedCategoryIds = [];
  const summary = {
    reused_categories: [],
    reused_options: [],
    new_categories: [],
    new_options: [],
  };

  for (const c of combo.categories) {
    // a) Explicit id wins.
    if (c.id) {
      resolvedCategoryIds.push(c.id);
      summary.reused_categories.push({ id: c.id, source: 'id' });
      continue;
    }
    if (!c.name) return { _error: 'Each category needs id OR name (+ options for new)' };
    const reuse = catByLower.get(c.name.toLowerCase());
    if (reuse && (!c.options || !c.options.length)) {
      // Reuse-by-name with no options requested — accept the existing category as-is.
      resolvedCategoryIds.push(reuse.id);
      summary.reused_categories.push({ id: reuse.id, name: reuse.name, source: 'name' });
      continue;
    }
    if (reuse && Array.isArray(c.options) && c.options.length) {
      // Reuse-by-name and the user supplied options. Verify the existing
      // options match the requested names — if so reuse. Otherwise the user
      // would silently get the existing options, which is the LESS surprising
      // behavior than creating a duplicate-name category.
      const existingNames = new Set((reuse.categoryOptions || []).map(o => o.name?.toLowerCase()).filter(Boolean));
      const requestedNamesLower = new Set(
        c.options.map(o => (typeof o === 'string' ? o : o?.name) || '').filter(Boolean).map(s => s.toLowerCase())
      );
      const allMatch = requestedNamesLower.size === existingNames.size &&
        Array.from(requestedNamesLower).every(n => existingNames.has(n));
      if (allMatch) {
        resolvedCategoryIds.push(reuse.id);
        summary.reused_categories.push({ id: reuse.id, name: reuse.name, source: 'name+options' });
        continue;
      }
      // Mismatch — fall through to creating a new category with a disambiguated
      // name so the user's intent is preserved without trampling the existing one.
      // (We'll suffix on the server's collision auto-fix path.)
    }
    if (!c.options || !c.options.length) {
      return { _error: `Category "${c.name}" not found and no options[] supplied to create it.` };
    }

    // Build a new category. Resolve each option: reuse existing by name; else
    // mint a new option UID and queue it for the same atomic POST.
    const catUid = generateDhis2Uid();
    const catOptionRefs = [];
    for (const optSpec of c.options) {
      const optName = typeof optSpec === 'string' ? optSpec : optSpec?.name;
      const optCode = typeof optSpec === 'object' ? optSpec?.code : null;
      if (!optName) return { _error: `Category "${c.name}" has an option missing a name.` };
      const lower = optName.toLowerCase();

      // a) Already on the server.
      const exist = optionMap.get(lower);
      if (exist) {
        catOptionRefs.push({ id: exist.id });
        summary.reused_options.push({ id: exist.id, name: exist.name });
        continue;
      }
      // b) Already minted in this same bundle (e.g. "Yes"/"No" reused across
      //    two categories) — reuse the same UID, don't double-create.
      const minted = newOptionUidsByLower.get(lower);
      if (minted) {
        catOptionRefs.push({ id: minted });
        continue;
      }
      // c) Mint a new one.
      const optUid = generateDhis2Uid();
      newOptionUidsByLower.set(lower, optUid);
      const newOpt = {
        id: optUid,
        name: optName,
        shortName: clampShortName(optName, optName, null, 'Option'),
      };
      const codeVal = deriveOptionCode(optName, usedOptionCodes, optCode);
      if (codeVal) newOpt.code = codeVal;
      newOptions.push(newOpt);
      catOptionRefs.push({ id: optUid });
      summary.new_options.push({ id: optUid, name: optName });
    }

    const catObj = {
      id: catUid,
      name: c.name,
      shortName: clampShortName(c.short_name || c.shortName, c.name, null, 'Category'),
      dataDimensionType: ddt,
      categoryOptions: catOptionRefs,
    };
    if (c.code) catObj.code = c.code;
    newCategories.push(catObj);
    resolvedCategoryIds.push(catUid);
    summary.new_categories.push({ id: catUid, name: c.name, options: catOptionRefs.length });
  }

  // 4. Build the combo itself.
  const comboUid = generateDhis2Uid();
  const newCombo = {
    id: comboUid,
    name: combo.name,
    shortName: clampShortName(combo.short_name || combo.shortName, combo.name, null, 'Cat Combo'),
    dataDimensionType: ddt,
    skipTotal: combo.skip_total === true,
    categories: resolvedCategoryIds.map(id => ({ id })),
  };
  if (combo.code) newCombo.code = combo.code;
  if (combo.description) newCombo.description = combo.description;

  const payload = {};
  if (newOptions.length) payload.categoryOptions = newOptions;
  if (newCategories.length) payload.categories = newCategories;
  payload.categoryCombos = [newCombo];

  return {
    uid: comboUid,
    name: combo.name,
    payload,
    summary,
  };
}

// Apply sharing to a freshly-created object via the legacy /api/sharing
// endpoint. This is the ONLY path that works for metadata-only-shareable
// classes (DataElement, CategoryCombo, Category, OptionSet, TEA): the newer
// /{type}/{id}/sharing PUT rejects ANY request with E3016 "Data sharing is
// not enabled for this object" even when the access bits are metadata-only.
// Returns { ok, error?, applied[] }.
async function applySharingViaLegacyEndpoint(items, sharingInput) {
  if (!sharingInput || !items?.length) return { ok: true, applied: [] };
  const publicAccess = normalizeAccessString(sharingInput.public_access, '--------');
  const userGroupAccesses = (sharingInput.user_group_ids || []).map(gid => ({
    id: gid,
    access: normalizeAccessString(sharingInput.user_group_access, 'rw------'),
  }));
  const userAccesses = (sharingInput.user_ids || []).map(uid => ({
    id: uid,
    access: normalizeAccessString(sharingInput.user_access, 'rw------'),
  }));
  if (sharingInput.include_current_user) {
    const me = await safeDhis2Fetch('me?fields=id');
    if (me?.id && !userAccesses.find(u => u.id === me.id)) {
      userAccesses.push({ id: me.id, access: normalizeAccessString(sharingInput.user_access, 'rw------') });
    }
    if (sharingInput.include_current_user_groups) {
      const meGroups = await safeDhis2Fetch('me?fields=userGroups[id]');
      for (const g of (meGroups?.userGroups || [])) {
        if (g?.id && !userGroupAccesses.find(x => x.id === g.id)) {
          userGroupAccesses.push({ id: g.id, access: normalizeAccessString(sharingInput.user_group_access, 'rw------') });
        }
      }
    }
  }
  const applied = [];
  const errors = [];
  for (const it of items) {
    const cur = await safeDhis2Fetch(`sharing?type=${it.type}&id=${it.id}`);
    if (cur?._error || !cur?.object) {
      errors.push({ id: it.id, type: it.type, error: cur?._error || 'no sharing object' });
      continue;
    }
    const obj = cur.object;
    obj.publicAccess = publicAccess;
    obj.externalAccess = !!sharingInput.external_access;
    obj.userGroupAccesses = userGroupAccesses;
    obj.userAccesses = userAccesses;
    const put = await safeDhis2Fetch(`sharing?type=${it.type}&id=${it.id}`, {
      method: 'PUT',
      body: { object: obj },
    });
    if (put?._error) {
      errors.push({ id: it.id, type: it.type, error: put._error });
    } else {
      applied.push({ id: it.id, type: it.type });
    }
  }
  return errors.length ? { ok: false, error: errors[0]?.error, errors, applied } : { ok: true, applied };
}

// ── manage_custom_forms: custom dataEntryForm authoring for datasets & program stages ──
//
// VERIFIED end-to-end on DHIS2 2.43 (play stable-2-43-0-1). These are the mechanics
// the other tools never had to learn, codified here so the model never re-derives them:
//
//  1. A dataEntryForm CANNOT be created inline. Embedding `{name, htmlCode}` inside a
//     dataSet / programStage payload — via the /metadata importer OR a direct object PUT —
//     fails with E5002 "Invalid reference … (DataEntryForm)". The form MUST be created
//     standalone via POST /api/dataEntryForms FIRST, then referenced by id.
//  2. Input-id formats differ by target (the new Aggregate Data Entry app and the new
//     Capture app both bind native widgets to these ids and render the surrounding HTML):
//        dataset       → "<dataElementUID>-<categoryOptionComboUID>-val"
//        program stage → "<programStageUID>-<dataElementUID>-val"
//  3. Linking the form:
//        dataset       → PATCH /api/dataSets/{id} (formType=CUSTOM + dataEntryForm) works.
//        program stage → PATCH / naive PUT DROPS the `program` reference ("Program stage
//                        must reference a program"), because GET ?fields=:owner OMITS
//                        `program`. A full PUT must RE-ATTACH program:{id} explicitly.
//  4. Data entry into a dataset custom form additionally needs sharing rwrw---- (data write)
//     + at least one assigned org unit — that stays the job of manage_datasets.

const DATA_ENTRY_FORM_STYLES = new Set(['NORMAL', 'COMFORTABLE', 'COMPACT', 'NONE']);
const CUSTOM_FORM_REVERT_TYPES = new Set(['DEFAULT', 'SECTION', 'SECTION_MULTIORG']);

function escapeCustomFormHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A single data-entry cell DHIS2 binds to. The id is the only thing that matters for
// binding; title/value mirror what the Maintenance custom-form designer emits.
// width:100% + max-width keeps the rendered control sized by its table cell —
// Capture swaps the <input> for its own component but honors the cell's box.
function customFormInputCell(inputId) {
  return `<input id="${escapeCustomFormHtml(inputId)}" title="" value="" style="width:100%;max-width:430px;box-sizing:border-box">`;
}

// Build a clean, responsive two-column custom-form htmlCode from grouped field rows.
// groups: [{ heading?, rows: [{ inputId, label, hint? }] }]
//
// Layout rules (all verified by rendering in Capture 2.42 event view/edit AND the
// aggregate Data Entry app, 2026-07-01):
// - EVERYTHING is inline styles. <style> blocks are unreliable: the aggregate Data
//   Entry app injects htmlCode into an existing DOM (a stylesheet leaks globally),
//   and sanitizers may strip them.
// - The old generator emitted a bare <table border="1"> with no width control: the
//   table shrank to hug its content (too narrow in Capture's wide card) or, when a
//   long label/validation message appeared, stretched unpredictably (too wide /
//   layout jumping). Fix: a max-width wrapper + width:100% fixed-layout table with
//   an explicit 40/60 colgroup — fills narrow containers, caps on wide ones, and
//   never reflows on content changes.
// - Inputs get width:100%;max-width:430px;box-sizing:border-box so Capture's
//   replaced components line up regardless of value type.
function buildCustomFormHtml(title, groups) {
  const esc = escapeCustomFormHtml;
  const parts = [];
  parts.push('<div style="width:100%;max-width:920px;margin:0 auto;font-family:inherit">');
  if (title) parts.push(`<h3 style="margin:0 0 12px;font-size:20px;color:#212934">${esc(title)}</h3>`);
  for (const group of groups) {
    parts.push('<div style="border:1px solid #d5dde5;border-radius:8px;margin-bottom:16px;overflow:hidden;background:#fff">');
    if (group.heading) {
      parts.push(`<h4 style="margin:0;padding:10px 14px;font-size:14px;background:#f3f5f7;border-bottom:1px solid #d5dde5;border-left:4px solid #1976d2;color:#212934">${esc(group.heading)}</h4>`);
    }
    parts.push('<table style="width:100%;border-collapse:collapse;table-layout:fixed">');
    parts.push('<colgroup><col style="width:40%"><col style="width:60%"></colgroup>');
    parts.push('<tbody>');
    let i = 0;
    for (const row of group.rows) {
      const shade = i % 2 === 1 ? 'background:#fafbfc;' : '';
      const hint = row.hint
        ? `<div style="font-size:12px;color:#8a93a0;margin-top:2px">${esc(row.hint)}</div>`
        : '';
      parts.push(
        `<tr><td style="padding:10px 14px;border-bottom:1px solid #eef1f4;vertical-align:middle;font-size:14px;color:#40464e;word-wrap:break-word;${shade}">${esc(row.label)}${hint}</td>`
        + `<td style="padding:10px 14px;border-bottom:1px solid #eef1f4;${shade}">${customFormInputCell(row.inputId)}</td></tr>`
      );
      i++;
    }
    parts.push('</tbody>');
    parts.push('</table>');
    parts.push('</div>');
  }
  parts.push('</div>');
  return parts.join('\n');
}

// Pull every `id="…-val"` data-entry marker out of an htmlCode blob.
function extractCustomFormInputIds(htmlCode) {
  if (typeof htmlCode !== 'string') return [];
  const ids = [];
  for (const m of htmlCode.matchAll(/<(?:input|select|textarea)[^>]*\bid="([^"]+)"/gi)) {
    ids.push(m[1]);
  }
  return ids;
}

// Resolve which target the call addresses. Returns { kind, id } or { _error }.
function resolveCustomFormTarget(args) {
  const stageId = args.program_stage_id || args.stage_id;
  const datasetId = args.dataset_id || args.object_id;
  if (stageId && datasetId) {
    return { _error: 'Pass only ONE of program_stage_id or dataset_id, not both.' };
  }
  if (stageId) return { kind: 'stage', id: stageId };
  if (datasetId) return { kind: 'dataset', id: datasetId };
  return {
    _error: 'No target specified. Pass dataset_id (for a dataset custom form) OR program_stage_id (for a tracker/event program-stage custom form).',
  };
}

// Build the auto-generated field rows for a dataset, one input per DE × categoryOptionCombo.
async function buildDatasetFormGroups(datasetId) {
  const ds = await safeDhis2Fetch(
    `dataSets/${datasetId}?fields=id,displayName,dataSetElements[dataElement[id,displayName,valueType,categoryCombo[id,categoryOptionCombos[id,displayName]]],categoryCombo[id,categoryOptionCombos[id,displayName]]]`
  );
  if (ds?._error) return { _error: `Could not load dataset ${datasetId}: ${ds._error}` };
  const dses = ds.dataSetElements || [];
  if (!dses.length) {
    return { _error: `Dataset "${ds.displayName || datasetId}" has no data elements to build a form from. Attach data elements first (manage_datasets action="add_data_elements").` };
  }
  const groups = [{ rows: [] }];
  let totalInputs = 0;
  for (const dse of dses) {
    const de = dse.dataElement;
    if (!de?.id) continue;
    const combo = dse.categoryCombo || de.categoryCombo;
    const cocs = combo?.categoryOptionCombos || [];
    if (cocs.length <= 1) {
      const coc = cocs[0];
      if (!coc?.id) continue;
      groups[0].rows.push({ inputId: `${de.id}-${coc.id}-val`, label: de.displayName });
      totalInputs++;
    } else {
      for (const coc of cocs) {
        if (!coc?.id) continue;
        groups[0].rows.push({ inputId: `${de.id}-${coc.id}-val`, label: `${de.displayName} — ${coc.displayName}` });
        totalInputs++;
      }
    }
  }
  if (!totalInputs) return { _error: `Dataset "${ds.displayName || datasetId}" has data elements but no category-option-combos resolved. Run /api/maintenance/categoryOptionComboUpdate or check the category combo.` };
  return { groups, title: ds.displayName, totalInputs };
}

// Build the auto-generated field rows for a program stage, one input per DE.
function buildStageFormGroups(stageId, stageName, programStageDataElements) {
  const rows = [];
  for (const psde of (programStageDataElements || [])) {
    const de = psde.dataElement;
    if (!de?.id) continue;
    rows.push({ inputId: `${stageId}-${de.id}-val`, label: de.displayName });
  }
  if (!rows.length) return { _error: `Program stage "${stageName || stageId}" has no data elements to build a form from. Add data elements to the stage first.` };
  return { groups: [{ rows }], title: stageName, totalInputs: rows.length };
}

// Create a new standalone dataEntryForm (POST) or update the existing one in place (PATCH).
// Returns { formId } or { _error }.
async function upsertDataEntryForm(existingFormId, name, style, htmlCode) {
  const safeStyle = DATA_ENTRY_FORM_STYLES.has(style) ? style : 'NORMAL';
  if (existingFormId) {
    const patchBody = { style: safeStyle, htmlCode };
    if (name) patchBody.name = name;
    const resp = await safeDhis2Fetch(`dataEntryForms/${existingFormId}`, { method: 'PATCH', body: patchBody });
    if (resp?._error) return { _error: `Could not update dataEntryForm ${existingFormId}: ${resp._error}` };
    return { formId: existingFormId, reused: true };
  }
  const formId = generateDhis2Uid();
  const resp = await safeDhis2Fetch('dataEntryForms', {
    method: 'POST',
    body: { id: formId, name, style: safeStyle, format: 2, htmlCode },
  });
  if (resp?._error) {
    return {
      _error: `Could not create dataEntryForm: ${resp._error}`,
      _hint: 'dataEntryForm names are unique server-wide. Pass a distinct form_name if this collided.',
    };
  }
  return { formId, reused: false };
}

async function getCustomForm(args) {
  const target = resolveCustomFormTarget(args);
  if (target._error) return target;
  if (target.kind === 'dataset') {
    const ds = await safeDhis2Fetch(
      `dataSets/${target.id}?fields=id,displayName,formType,dataEntryForm[id,name,style,htmlCode],dataSetElements~size,organisationUnits~size,access`
    );
    if (ds?._error) return { _error: `Could not load dataset ${target.id}: ${ds._error}` };
    const html = ds.dataEntryForm?.htmlCode || '';
    return {
      success: true,
      target: 'dataset',
      id: ds.id,
      name: ds.displayName,
      form_type: ds.formType || 'DEFAULT',
      has_custom_form: !!ds.dataEntryForm,
      form_id: ds.dataEntryForm?.id || null,
      form_name: ds.dataEntryForm?.name || null,
      style: ds.dataEntryForm?.style || null,
      input_ids: extractCustomFormInputIds(html).slice(0, 200),
      input_count: extractCustomFormInputIds(html).length,
      html_length: html.length,
      html_preview: html.slice(0, 4000),
      data_elements: ds.dataSetElements ?? 0,
      org_units: ds.organisationUnits ?? 0,
      can_write_data: !!ds.access?.data?.write,
    };
  }
  const ps = await safeDhis2Fetch(
    `programStages/${target.id}?fields=id,displayName,formType,program[id,displayName,programType],dataEntryForm[id,name,style,htmlCode],programStageDataElements~size`
  );
  if (ps?._error) return { _error: `Could not load program stage ${target.id}: ${ps._error}` };
  const html = ps.dataEntryForm?.htmlCode || '';
  return {
    success: true,
    target: 'stage',
    id: ps.id,
    name: ps.displayName,
    program: ps.program ? { id: ps.program.id, name: ps.program.displayName, type: ps.program.programType } : null,
    form_type: ps.formType || 'DEFAULT',
    has_custom_form: !!ps.dataEntryForm,
    form_id: ps.dataEntryForm?.id || null,
    form_name: ps.dataEntryForm?.name || null,
    style: ps.dataEntryForm?.style || null,
    input_ids: extractCustomFormInputIds(html).slice(0, 200),
    input_count: extractCustomFormInputIds(html).length,
    html_length: html.length,
    html_preview: html.slice(0, 4000),
    data_elements: ps.programStageDataElements ?? 0,
  };
}

async function previewCustomFormHtml(args) {
  const target = resolveCustomFormTarget(args);
  if (target._error) return target;
  let built;
  if (target.kind === 'dataset') {
    built = await buildDatasetFormGroups(target.id);
  } else {
    const ps = await safeDhis2Fetch(
      `programStages/${target.id}?fields=id,displayName,programStageDataElements[dataElement[id,displayName,valueType]]`
    );
    if (ps?._error) return { _error: `Could not load program stage ${target.id}: ${ps._error}` };
    built = buildStageFormGroups(ps.id, ps.displayName, ps.programStageDataElements);
  }
  if (built._error) return built;
  const html = buildCustomFormHtml(built.title, built.groups);
  return {
    success: true,
    target: target.kind,
    id: target.id,
    input_count: built.totalInputs,
    html_length: html.length,
    html_code: html,
    _note: 'Preview only — nothing was saved. Call set_dataset_form / set_stage_form (optionally with this html_code) to apply it.',
  };
}

async function setDatasetCustomForm(args) {
  const datasetId = args.dataset_id || args.object_id;
  if (!datasetId) return { _error: 'dataset_id required for set_dataset_form' };
  const exists = await verifyTargetExists('dataSets', datasetId, 'manage_custom_forms', 'set_dataset_form', 'id,displayName');
  if (!exists.exists) return exists.refusal;

  const ds = await safeDhis2Fetch(
    `dataSets/${datasetId}?fields=id,displayName,formType,dataEntryForm[id,name],dataSetElements[dataElement[id]],organisationUnits~size,access`
  );
  if (ds?._error) return { _error: `Could not load dataset ${datasetId}: ${ds._error}` };
  const dsName = ds.displayName || datasetId;
  const validDeIds = new Set((ds.dataSetElements || []).map(d => d.dataElement?.id).filter(Boolean));

  // HTML: caller-supplied, or auto-built from the dataset's DE × COC grid.
  let htmlCode = typeof args.html_code === 'string' && args.html_code.trim() ? args.html_code : null;
  let autoInputs = null;
  if (!htmlCode) {
    const built = await buildDatasetFormGroups(datasetId);
    if (built._error) return built;
    htmlCode = buildCustomFormHtml(built.title, built.groups);
    autoInputs = built.totalInputs;
  }

  // Lint: warn (don't block) when referenced DEs aren't attached to the dataset.
  const inputIds = extractCustomFormInputIds(htmlCode);
  const unknownDes = [];
  for (const inputId of inputIds) {
    const m = inputId.match(/^([A-Za-z][A-Za-z0-9]{10})-([A-Za-z][A-Za-z0-9]{10})-val$/);
    if (!m) continue;
    if (!validDeIds.has(m[1])) unknownDes.push(m[1]);
  }
  if (!inputIds.length) {
    return { _error: 'The htmlCode contains no `id="<de>-<coc>-val"` data-entry inputs. A dataset custom form needs at least one bound cell.', _hint: 'Use action="preview_html" to auto-generate a valid form skeleton.' };
  }

  const backup = await ensureBackupOrBail(
    { operation: 'set_custom_form', tool: 'manage_custom_forms', action: 'set_dataset_form', reason: `Set custom form on dataset ${dsName}` },
    [{ object_type: 'dataSets', object_id: datasetId, role: 'primary' }],
    args
  );
  if (!backup.ok) return backup.error;

  const formName = args.form_name || `${dsName} custom form ${generateDhis2Uid().slice(-4)}`;
  const upsert = await upsertDataEntryForm(ds.dataEntryForm?.id, formName, args.style, htmlCode);
  if (upsert._error) return { ...upsert, backup: backup.block };

  // Link the form + flip to CUSTOM. PATCH is safe for dataSets.
  if (ds.formType !== 'CUSTOM' || ds.dataEntryForm?.id !== upsert.formId) {
    const link = await safeDhis2Fetch(`dataSets/${datasetId}`, {
      method: 'PATCH',
      body: { formType: 'CUSTOM', dataEntryForm: { id: upsert.formId } },
    });
    if (link?._error) return { _error: `Form saved (${upsert.formId}) but linking it to the dataset failed: ${link._error}`, form_id: upsert.formId, backup: backup.block };
  }

  const hints = [];
  if (!(ds.organisationUnits > 0)) hints.push('No org units are assigned — the dataset is invisible in Data Entry. Use manage_datasets(action="assign_org_units").');
  if (!ds.access?.data?.write) hints.push('Public/your data-write access may be off — if Save no-ops, set sharing to rwrw---- via manage_datasets(action="update_sharing").');
  if (unknownDes.length) hints.push(`htmlCode references ${unknownDes.length} data element(s) not attached to this dataset (${unknownDes.slice(0, 5).join(', ')}); those cells will not save until the DEs are added.`);

  return {
    success: true,
    target: 'dataset',
    dataset_id: datasetId,
    dataset_name: dsName,
    form_id: upsert.formId,
    form_reused: upsert.reused,
    form_type: 'CUSTOM',
    input_count: inputIds.length,
    auto_generated: autoInputs != null,
    backup: backup.block,
    _hints: hints.length ? hints : undefined,
  };
}

async function setStageCustomForm(args) {
  const stageId = args.program_stage_id || args.stage_id;
  if (!stageId) return { _error: 'program_stage_id required for set_stage_form' };
  const exists = await verifyTargetExists('programStages', stageId, 'manage_custom_forms', 'set_stage_form', 'id,displayName');
  if (!exists.exists) return exists.refusal;

  // Meta for html-building + the program reference we must re-attach on PUT.
  const meta = await safeDhis2Fetch(
    `programStages/${stageId}?fields=id,displayName,formType,program[id,displayName,programType],dataEntryForm[id,name],programStageDataElements[dataElement[id,displayName,valueType]]`
  );
  if (meta?._error) return { _error: `Could not load program stage ${stageId}: ${meta._error}` };
  if (!meta.program?.id) return { _error: `Program stage ${stageId} has no resolvable program — cannot safely PUT it.` };
  const stageName = meta.displayName || stageId;
  const validDeIds = new Set((meta.programStageDataElements || []).map(p => p.dataElement?.id).filter(Boolean));

  let htmlCode = typeof args.html_code === 'string' && args.html_code.trim() ? args.html_code : null;
  let autoInputs = null;
  if (!htmlCode) {
    const built = buildStageFormGroups(stageId, stageName, meta.programStageDataElements);
    if (built._error) return built;
    htmlCode = buildCustomFormHtml(built.title, built.groups);
    autoInputs = built.totalInputs;
  }

  const inputIds = extractCustomFormInputIds(htmlCode);
  if (!inputIds.length) {
    return { _error: 'The htmlCode contains no `id="<stage>-<de>-val"` data-entry inputs. A program-stage custom form needs at least one bound cell.', _hint: 'Use action="preview_html" to auto-generate a valid form skeleton.' };
  }
  const unknownDes = [];
  for (const inputId of inputIds) {
    const m = inputId.match(/^([A-Za-z][A-Za-z0-9]{10})-([A-Za-z][A-Za-z0-9]{10})-val$/);
    if (!m) continue;
    if (m[1] !== stageId) { unknownDes.push(`${inputId} (stage prefix mismatch)`); continue; }
    if (!validDeIds.has(m[2])) unknownDes.push(m[2]);
  }

  const backup = await ensureBackupOrBail(
    { operation: 'set_custom_form', tool: 'manage_custom_forms', action: 'set_stage_form', reason: `Set custom form on program stage ${stageName}` },
    [{ object_type: 'programStages', object_id: stageId, role: 'primary' }],
    args
  );
  if (!backup.ok) return backup.error;

  const formName = args.form_name || `${stageName} stage form ${generateDhis2Uid().slice(-4)}`;
  const upsert = await upsertDataEntryForm(meta.dataEntryForm?.id, formName, args.style, htmlCode);
  if (upsert._error) return { ...upsert, backup: backup.block };

  // Full-object PUT — a programStage PATCH/naive-PUT loses `program` (E: "must
  // reference a program"). :owner omits program, so we re-attach it explicitly.
  const owner = await safeDhis2Fetch(`programStages/${stageId}?fields=:owner`);
  if (owner?._error) return { _error: `Form saved (${upsert.formId}) but reloading the stage to link it failed: ${owner._error}`, form_id: upsert.formId, backup: backup.block };
  owner.program = { id: meta.program.id };
  owner.formType = 'CUSTOM';
  owner.dataEntryForm = { id: upsert.formId };
  const put = await safeDhis2Fetch(`programStages/${stageId}?mergeMode=REPLACE`, { method: 'PUT', body: owner });
  if (put?._error) return { _error: `Form saved (${upsert.formId}) but linking it to the stage failed: ${put._error}`, form_id: upsert.formId, backup: backup.block };

  const hints = [];
  if (unknownDes.length) hints.push(`htmlCode references ${unknownDes.length} input(s) whose DE is not on this stage (${unknownDes.slice(0, 5).join(', ')}); those cells will not save.`);
  hints.push('Custom program-stage forms render in the new Capture app when VIEWING or EDITING an existing event — the "New event" flow renders the DEFAULT layout in current Capture versions (verified on 2.42). Verify by opening an existing event of this stage.');
  hints.push('⚠️ Capture caches program metadata in IndexedDB. A form saved AFTER the user opened Capture will NOT appear until they hard-refresh the Capture tab (Ctrl+Shift+R / Cmd+Shift+R; if it still shows the old layout, DevTools > Application > Clear storage). TELL THE USER THIS — "the form does not show" is almost always this cache, not a save failure.');

  return {
    success: true,
    target: 'stage',
    program_stage_id: stageId,
    program_stage_name: stageName,
    program: { id: meta.program.id, name: meta.program.displayName },
    form_id: upsert.formId,
    form_reused: upsert.reused,
    form_type: 'CUSTOM',
    input_count: inputIds.length,
    auto_generated: autoInputs != null,
    backup: backup.block,
    _hints: hints,
  };
}

async function removeCustomForm(args) {
  const target = resolveCustomFormTarget(args);
  if (target._error) return target;
  const revertType = (args.new_form_type && CUSTOM_FORM_REVERT_TYPES.has(args.new_form_type)) ? args.new_form_type : 'DEFAULT';

  if (target.kind === 'dataset') {
    const exists = await verifyTargetExists('dataSets', target.id, 'manage_custom_forms', 'remove_form', 'id,displayName');
    if (!exists.exists) return exists.refusal;
    const owner = await safeDhis2Fetch(`dataSets/${target.id}?fields=:owner`);
    if (owner?._error) return { _error: `Could not load dataset ${target.id}: ${owner._error}` };
    const formId = owner.dataEntryForm?.id || null;
    const backup = await ensureBackupOrBail(
      { operation: 'remove_custom_form', tool: 'manage_custom_forms', action: 'remove_form', reason: `Remove custom form from dataset ${owner.name || target.id}` },
      [{ object_type: 'dataSets', object_id: target.id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;
    delete owner.dataEntryForm;
    owner.formType = revertType;
    const put = await safeDhis2Fetch(`dataSets/${target.id}?mergeMode=REPLACE`, { method: 'PUT', body: owner });
    if (put?._error) return { _error: `Failed to revert dataset form type: ${put._error}`, backup: backup.block };
    let deletedForm = false;
    if (formId && args.delete_form_object) {
      const del = await safeDhis2Fetch(`dataEntryForms/${formId}`, { method: 'DELETE' });
      deletedForm = !del?._error;
    }
    return { success: true, target: 'dataset', dataset_id: target.id, form_type: revertType, unlinked_form_id: formId, deleted_form_object: deletedForm, backup: backup.block };
  }

  const exists = await verifyTargetExists('programStages', target.id, 'manage_custom_forms', 'remove_form', 'id,displayName');
  if (!exists.exists) return exists.refusal;
  const meta = await safeDhis2Fetch(`programStages/${target.id}?fields=id,program[id],dataEntryForm[id]`);
  if (meta?._error) return { _error: `Could not load program stage ${target.id}: ${meta._error}` };
  if (!meta.program?.id) return { _error: `Program stage ${target.id} has no resolvable program — cannot safely PUT it.` };
  const owner = await safeDhis2Fetch(`programStages/${target.id}?fields=:owner`);
  if (owner?._error) return { _error: `Could not load program stage ${target.id}: ${owner._error}` };
  const formId = meta.dataEntryForm?.id || null;
  const backup = await ensureBackupOrBail(
    { operation: 'remove_custom_form', tool: 'manage_custom_forms', action: 'remove_form', reason: `Remove custom form from program stage ${target.id}` },
    [{ object_type: 'programStages', object_id: target.id, role: 'primary' }],
    args
  );
  if (!backup.ok) return backup.error;
  delete owner.dataEntryForm;
  owner.program = { id: meta.program.id };
  owner.formType = revertType === 'SECTION_MULTIORG' ? 'DEFAULT' : revertType;
  const put = await safeDhis2Fetch(`programStages/${target.id}?mergeMode=REPLACE`, { method: 'PUT', body: owner });
  if (put?._error) return { _error: `Failed to revert stage form type: ${put._error}`, backup: backup.block };
  let deletedForm = false;
  if (formId && args.delete_form_object) {
    const del = await safeDhis2Fetch(`dataEntryForms/${formId}`, { method: 'DELETE' });
    deletedForm = !del?._error;
  }
  return { success: true, target: 'stage', program_stage_id: target.id, form_type: owner.formType, unlinked_form_id: formId, deleted_form_object: deletedForm, backup: backup.block };
}

async function executeManageCustomForms(args) {
  const action = args?.action;
  if (!action) {
    return {
      _error: 'Missing required parameter: action',
      _hint: 'One of: get, preview_html, set_dataset_form, set_stage_form, remove_form.',
    };
  }
  if (action === 'get') return await getCustomForm(args);
  if (action === 'preview_html') return await previewCustomFormHtml(args);
  if (action === 'set_dataset_form') {
    const gate = requireWriteAuth('manage_custom_forms', 'set_dataset_form', { dataset_id: args.dataset_id });
    if (gate) return gate;
    return await setDatasetCustomForm(args);
  }
  if (action === 'set_stage_form') {
    const gate = requireWriteAuth('manage_custom_forms', 'set_stage_form', { program_stage_id: args.program_stage_id });
    if (gate) return gate;
    return await setStageCustomForm(args);
  }
  if (action === 'remove_form') {
    const gate = requireWriteAuth('manage_custom_forms', 'remove_form', { dataset_id: args.dataset_id, program_stage_id: args.program_stage_id });
    if (gate) return gate;
    return await removeCustomForm(args);
  }
  return { _error: `Unknown manage_custom_forms action: ${action}`, _hint: 'One of: get, preview_html, set_dataset_form, set_stage_form, remove_form.' };
}

// ── manage_custom_translations: experimental DHIS2 2.43 "custom-translations" datastore feature ──
//
// VERIFIED on DHIS2 2.43 (play stable-2-43-0-1): the new Capture app fetches, at startup:
//   1. GET /api/dataStore/custom-translations/controller   → { "<appSlug>": ["<locale>", ...] }
//   2. GET /api/dataStore/custom-translations/<slug>__<locale>  (when the active UI locale is
//      registered for that app) → { "<source string>": "<replacement>", ... }
// Both requests were observed returning 200 from the Capture app, and the key template
// `${slug}__${locale}` (slug lowercased) was confirmed in the app bundle. At render time the
// app swaps each matching source string for its replacement.
//
// The replacement can be a DIFFERENT language (true translation) or the SAME language (a plain
// string rewrite, e.g. "Report data" → "Submit report" under locale "en"). The feature treats
// it as a literal source→target map; this tool supports both uses identically.
//
// IMPORTANT: an app/locale pair that is NOT listed in the `controller` key is never loaded by
// the app, so set/remove always keep the controller registry and the per-locale key in sync.
//
// DataStore keys are not metadata objects, so the standard ensureBackupOrBail/manage_backups
// machinery (which restores via /api/metadata) cannot roll them back. Instead set/remove return
// the pre-write state inline (previous_value / previous_controller) for manual recovery.

const CUSTOM_TRANSLATIONS_NS = 'custom-translations';
const CUSTOM_TRANSLATIONS_CONTROLLER_KEY = 'controller';
const CUSTOM_TRANSLATIONS_MIN_API = 43;

// Refuse on servers older than 2.43 — the apps simply don't read this namespace there.
function customTranslationsVersionGate() {
  const v = Number(dhis2.apiVersion);
  if (Number.isFinite(v) && v >= CUSTOM_TRANSLATIONS_MIN_API) return null;
  return {
    _error: `Refused: custom translations require DHIS2 2.${CUSTOM_TRANSLATIONS_MIN_API}+. This instance reports API version "${dhis2.apiVersion || '?'}" (${dhis2.systemInfo?.version || 'unknown'}).`,
    _hint: 'The custom-translations datastore feature is only read by DHIS2 apps on 2.43 and later. On older servers, writing these keys has no visible effect — do not attempt it.',
  };
}

function normalizeAppSlug(app) {
  return String(app == null ? '' : app).trim().toLowerCase();
}
// Locale casing is significant (e.g. pt_BR, uz_UZ_Cyrl) — only trim, never lowercase.
function normalizeLocale(locale) {
  return String(locale == null ? '' : locale).trim();
}
function customTranslationKey(slug, locale) {
  return `${slug}__${locale}`;
}
function ctPath(key) {
  return `dataStore/${encodeURIComponent(CUSTOM_TRANSLATIONS_NS)}/${encodeURIComponent(key)}`;
}
function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Read the controller registry. Returns { exists, value } (value is {} when missing) or { _error }.
async function ctFetchController() {
  const resp = await safeDhis2Fetch(ctPath(CUSTOM_TRANSLATIONS_CONTROLLER_KEY));
  if (resp?._status === 404) return { exists: false, value: {} };
  if (resp?._error) return { _error: `Could not read the controller registry: ${resp._error}` };
  return { exists: true, value: isPlainObject(resp) ? resp : {} };
}

// Upsert any custom-translations key: POST to create, fall back to PUT on 409 (already exists).
async function ctUpsertKey(key, value) {
  let resp = await safeDhis2Fetch(ctPath(key), { method: 'POST', body: value });
  if (resp?._status === 409) {
    resp = await safeDhis2Fetch(ctPath(key), { method: 'PUT', body: value });
  }
  if (resp?._error) return { _error: `Could not write key "${key}": ${resp._error}` };
  return { ok: true };
}

async function ctWriteController(value) {
  return await ctUpsertKey(CUSTOM_TRANSLATIONS_CONTROLLER_KEY, value);
}

async function listCustomTranslations() {
  const keysResp = await safeDhis2Fetch(`dataStore/${encodeURIComponent(CUSTOM_TRANSLATIONS_NS)}`);
  if (keysResp?._status === 404) {
    return {
      success: true, namespace: CUSTOM_TRANSLATIONS_NS, exists: false,
      registered: {}, translation_keys: [],
      _note: 'The custom-translations namespace does not exist yet. Use action="set" to create the first translation (it also creates the controller registry).',
    };
  }
  if (keysResp?._error) return { _error: `Could not list custom-translations keys: ${keysResp._error}` };
  const keys = Array.isArray(keysResp) ? keysResp : [];
  const controller = await ctFetchController();
  if (controller._error) return controller;
  const translationKeys = keys
    .filter(k => k !== CUSTOM_TRANSLATIONS_CONTROLLER_KEY)
    .map(k => {
      const idx = k.indexOf('__');
      return idx > 0
        ? { key: k, app: k.slice(0, idx), locale: k.slice(idx + 2) }
        : { key: k, app: null, locale: null, _note: 'Key does not follow the <slug>__<locale> format.' };
    });
  return {
    success: true,
    namespace: CUSTOM_TRANSLATIONS_NS,
    exists: true,
    registered: controller.value,
    translation_keys: translationKeys,
    key_count: keys.length,
  };
}

async function getCustomTranslations(args) {
  const slug = normalizeAppSlug(args.app);
  const locale = normalizeLocale(args.locale);
  const controller = await ctFetchController();
  if (controller._error) return controller;
  if (!slug || !locale) {
    return {
      success: true, namespace: CUSTOM_TRANSLATIONS_NS,
      registered: controller.value,
      _note: 'Pass both app and locale to read a specific translation map.',
    };
  }
  const key = customTranslationKey(slug, locale);
  const registeredLocales = Array.isArray(controller.value[slug]) ? controller.value[slug] : [];
  const isRegistered = registeredLocales.includes(locale);
  const resp = await safeDhis2Fetch(ctPath(key));
  if (resp?._status === 404) {
    return {
      success: true, app: slug, locale, key, exists: false, registered: isRegistered, translations: {},
      _hint: isRegistered
        ? 'The controller lists this app/locale but the translation key is missing — the app has nothing to load. Use action="set" to add strings.'
        : 'No translations stored for this app/locale yet.',
    };
  }
  if (resp?._error) return { _error: `Could not read ${key}: ${resp._error}` };
  const translations = isPlainObject(resp) ? resp : {};
  return {
    success: true, app: slug, locale, key, exists: true,
    registered: isRegistered,
    entry_count: Object.keys(translations).length,
    translations,
    _hint: isRegistered
      ? undefined
      : `WARNING: "${slug}" + "${locale}" is NOT in the controller registry, so the app will NOT load these translations. Run action="set" (which registers automatically) to fix it.`,
  };
}

async function setCustomTranslations(args) {
  const slug = normalizeAppSlug(args.app);
  const locale = normalizeLocale(args.locale);
  if (!slug) return { _error: 'app is required for set (the app slug, e.g. "capture").' };
  if (!locale) return { _error: 'locale is required for set (e.g. "ar" to translate, or "en" to rewrite English strings in place).' };
  const translations = args.translations;
  if (!isPlainObject(translations)) {
    return { _error: 'translations must be a JSON object mapping each exact source string to its replacement, e.g. {"Report data":"الإبلاغ عن البيانات"}.' };
  }
  const entries = Object.entries(translations);
  if (!entries.length) return { _error: 'translations is empty — provide at least one source→replacement pair.' };
  const badValues = entries.filter(([, v]) => typeof v !== 'string');
  if (badValues.length) {
    return { _error: `All translation values must be strings. Offending source string(s): ${badValues.slice(0, 5).map(e => JSON.stringify(e[0])).join(', ')}.` };
  }

  const key = customTranslationKey(slug, locale);

  // Read existing map (for merge + restore snapshot).
  const existingResp = await safeDhis2Fetch(ctPath(key));
  const keyExisted = existingResp?._status !== 404;
  if (existingResp?._error && existingResp?._status !== 404) {
    return { _error: `Could not read the existing ${key}: ${existingResp._error}` };
  }
  const existing = (keyExisted && isPlainObject(existingResp)) ? existingResp : {};
  const replace = args.replace === true;
  const finalMap = replace ? { ...translations } : { ...existing, ...translations };

  // Controller registry: ensure slug + locale are registered.
  const controller = await ctFetchController();
  if (controller._error) return controller;
  const previousController = JSON.parse(JSON.stringify(controller.value || {}));
  const reg = controller.value || {};
  const locales = Array.isArray(reg[slug]) ? reg[slug].slice() : [];
  const controllerNeedsUpdate = !Array.isArray(reg[slug]) || !locales.includes(locale);
  if (!locales.includes(locale)) locales.push(locale);
  reg[slug] = locales;

  // Write the translation key first, then the controller (so a registered pair always has a key).
  const w1 = await ctUpsertKey(key, finalMap);
  if (w1._error) return w1;
  if (controllerNeedsUpdate) {
    const w2 = await ctWriteController(reg);
    if (w2._error) {
      return {
        _error: `Translations saved to ${key}, but updating the controller registry failed: ${w2._error}`,
        _hint: 'Without the controller entry the app will NOT load these translations. Retry action="set", or set the controller key manually.',
        previous_value: keyExisted ? existing : null,
      };
    }
  }

  const isRewrite = /^en\b/i.test(locale) || locale.toLowerCase() === 'en';
  return {
    success: true,
    namespace: CUSTOM_TRANSLATIONS_NS,
    app: slug,
    locale,
    key,
    mode: replace ? 'replace' : 'merge',
    entries_written: entries.length,
    total_entries: Object.keys(finalMap).length,
    key_existed: keyExisted,
    controller_updated: controllerNeedsUpdate,
    registered_locales: locales,
    previous_value: keyExisted ? existing : null,
    previous_controller: previousController,
    _hints: [
      `Reload the "${slug}" app with the UI locale set to "${locale}" to see the strings change.`,
      isRewrite
        ? 'Same-language rewrite: each value replaces its English source string verbatim.'
        : 'Translation: each English source string renders as its translated value.',
      'Each source string must match the on-screen text EXACTLY (capitalisation, punctuation, whitespace) or it will not be swapped.',
    ],
  };
}

async function removeCustomTranslations(args) {
  const slug = normalizeAppSlug(args.app);
  const locale = normalizeLocale(args.locale);
  if (!slug || !locale) return { _error: 'app and locale are required for remove.' };
  const key = customTranslationKey(slug, locale);
  const keysToRemove = Array.isArray(args.keys) ? args.keys.filter(k => typeof k === 'string') : null;

  const existingResp = await safeDhis2Fetch(ctPath(key));
  if (existingResp?._status === 404) {
    return { success: true, app: slug, locale, key, removed: false, _note: 'Nothing to remove — that translation key does not exist.' };
  }
  if (existingResp?._error) return { _error: `Could not read ${key}: ${existingResp._error}` };
  const existing = isPlainObject(existingResp) ? existingResp : {};

  // Partial removal: drop only the named source strings, keeping the key + registration —
  // unless that would empty the map, in which case fall through to a full delete.
  if (keysToRemove && keysToRemove.length) {
    const remaining = { ...existing };
    let removedCount = 0;
    for (const k of keysToRemove) { if (k in remaining) { delete remaining[k]; removedCount++; } }
    if (Object.keys(remaining).length > 0) {
      const w = await ctUpsertKey(key, remaining);
      if (w._error) return w;
      return {
        success: true, app: slug, locale, key,
        removed_entries: removedCount,
        remaining_entries: Object.keys(remaining).length,
        previous_value: existing,
      };
    }
  }

  // Full removal: delete the key and de-register the locale from the controller.
  const del = await safeDhis2Fetch(ctPath(key), { method: 'DELETE' });
  if (del?._error && del?._status !== 404) return { _error: `Could not delete ${key}: ${del._error}` };

  const controller = await ctFetchController();
  if (controller._error) return controller;
  const previousController = JSON.parse(JSON.stringify(controller.value || {}));
  const reg = controller.value || {};
  let controllerUpdated = false;
  if (Array.isArray(reg[slug]) && reg[slug].includes(locale)) {
    reg[slug] = reg[slug].filter(l => l !== locale);
    if (reg[slug].length === 0) delete reg[slug];
    controllerUpdated = true;
    const w = await ctWriteController(reg);
    if (w._error) return { _error: `Key deleted but de-registering it from the controller failed: ${w._error}`, previous_value: existing };
  }

  return {
    success: true, app: slug, locale, key, removed: true,
    controller_updated: controllerUpdated,
    previous_value: existing,
    previous_controller: previousController,
    _hint: 'Reload the app to confirm the strings reverted to their defaults.',
  };
}

async function executeManageCustomTranslations(args) {
  const action = args?.action;
  if (!action) {
    return { _error: 'Missing required parameter: action', _hint: 'One of: list, get, set, remove.' };
  }
  const gate = customTranslationsVersionGate();
  if (gate) return gate;

  if (action === 'list') return await listCustomTranslations();
  if (action === 'get') return await getCustomTranslations(args);
  if (action === 'set') {
    const wa = requireWriteAuth('manage_custom_translations', 'set', { app: args.app, locale: args.locale });
    if (wa) return wa;
    return await setCustomTranslations(args);
  }
  if (action === 'remove') {
    const wa = requireWriteAuth('manage_custom_translations', 'remove', { app: args.app, locale: args.locale });
    if (wa) return wa;
    return await removeCustomTranslations(args);
  }
  return { _error: `Unknown manage_custom_translations action: ${action}`, _hint: 'One of: list, get, set, remove.' };
}

// ── manage_growth_chart_plugin: WHO Capture Growth Chart plugin setup ──
//
// VERIFIED on DHIS2 2.43 (play stable-2-43-0-1) against the dev-otta plugin
// (https://github.com/dev-otta/dhis2-who-growth-chart). The plugin renders WHO growth
// charts on a tracker enrollment dashboard in the new Capture app. It needs:
//   1. The app installed (App Hub "Capture Growth Chart", key capture-growth-chart).
//   2. A dataStore key — namespace "captureGrowthChart", key "config" — mapping the
//      program's metadata to the plugin's expected roles:
//        metadata.attributes:  dateOfBirth, gender, firstName, lastName, femaleOptionCode, maleOptionCode
//        metadata.dataElements: weight, height, headCircumference
//        metadata.programStageForGrowthChart: { "<programId>": "<programStageId>" }
//        settings: usePercentiles, customReferences, weightInGrams, defaultIndicator (wfa|hcfa|lhfa|wflh)
//   3. The plugin widget ADDED to the enrollment dashboard (owned by Capture / the Tracker
//      Plugin Configurator — an internal dataStore/capture layout this tool does NOT touch).
//
// Install verified: POST /api/appHub/{versionId} → 201; afterwards /api/apps lists
// capture-growth-chart with pluginLaunchUrl …/api/apps/capture-growth-chart/plugin.html.
// Config write verified: POST dataStore/captureGrowthChart/config → 201. A full program +
// stage + 3 measurement DEs + enrolled child with 3 measurements was created and accepted.

const GROWTH_CHART_NS = 'captureGrowthChart';
const GROWTH_CHART_KEY = 'config';
const GROWTH_CHART_APP_KEY = 'capture-growth-chart';
const GROWTH_CHART_APPHUB_NAME = 'Capture Growth Chart';
const GROWTH_CHART_INDICATORS = new Set(['wfa', 'hcfa', 'lhfa', 'wflh']);

function gcPath(key) {
  return `dataStore/${encodeURIComponent(GROWTH_CHART_NS)}/${encodeURIComponent(key)}`;
}

// Read captureGrowthChart/config. Returns { exists, value } or { _error }.
async function gcReadConfig() {
  const resp = await safeDhis2Fetch(gcPath(GROWTH_CHART_KEY));
  if (resp?._status === 404) return { exists: false, value: null };
  if (resp?._error) return { _error: `Could not read ${GROWTH_CHART_NS}/${GROWTH_CHART_KEY}: ${resp._error}` };
  return { exists: true, value: isPlainObject(resp) ? resp : null };
}

async function gcWriteConfig(value) {
  let resp = await safeDhis2Fetch(gcPath(GROWTH_CHART_KEY), { method: 'POST', body: value });
  if (resp?._status === 409) {
    resp = await safeDhis2Fetch(gcPath(GROWTH_CHART_KEY), { method: 'PUT', body: value });
  }
  if (resp?._error) return { _error: `Could not write ${GROWTH_CHART_NS}/${GROWTH_CHART_KEY}: ${resp._error}` };
  return { ok: true };
}

// Is the plugin app installed? Returns { installed, pluginLaunchUrl }.
async function gcAppStatus() {
  const apps = await safeDhis2Fetch('apps.json');
  if (apps?._error || !Array.isArray(apps)) return { installed: null, _note: 'Could not read installed app list.' };
  const app = apps.find(a => a.key === GROWTH_CHART_APP_KEY || /capture\s*growth\s*chart/i.test(a.name || ''));
  if (!app) return { installed: false };
  return {
    installed: true,
    app_key: app.key,
    plugin_launch_url: app.pluginLaunchUrl || `${dhis2.baseUrl}/api/apps/${app.key}/plugin.html`,
    version: app.version,
  };
}

function gcServerMinorVersion() {
  const n = Number(dhis2.apiVersion);
  return Number.isFinite(n) ? n : null;
}

// Install the plugin from the App Hub. Idempotent.
async function gcInstall() {
  const before = await gcAppStatus();
  if (before.installed) {
    return { success: true, already_installed: true, app_key: before.app_key, plugin_launch_url: before.plugin_launch_url, version: before.version };
  }
  const search = await safeDhis2Fetch(`appHub/v2/apps?query=${encodeURIComponent(GROWTH_CHART_APPHUB_NAME)}`);
  if (search?._error) return { _error: `Could not query the App Hub: ${search._error}`, _hint: 'The server may have no App Hub access. Install the "Capture Growth Chart" app manually via App Management.' };
  const results = search?.result || [];
  const app = results.find(a => /capture\s*growth\s*chart/i.test(a.name || '')) || results[0];
  if (!app) return { _error: 'Could not find "Capture Growth Chart" in the App Hub.', _hint: 'Install it manually via App Management, then re-run with action="configure".' };
  const serverMinor = gcServerMinorVersion();
  // versions are newest-first; pick the first compatible with this server.
  const versions = Array.isArray(app.versions) ? app.versions : [];
  const minorOf = (v) => { const m = String(v || '').match(/^\s*\d+\.(\d+)/); return m ? Number(m[1]) : null; };
  const compatible = versions.find(v => {
    if (serverMinor == null) return true;
    const min = minorOf(v.minDhisVersion);
    const max = minorOf(v.maxDhisVersion);
    return (min == null || serverMinor >= min) && (max == null || serverMinor <= max);
  }) || versions[0];
  if (!compatible?.id) return { _error: 'The App Hub returned no installable version for Capture Growth Chart.' };
  const install = await safeDhis2Fetch(`appHub/${encodeURIComponent(compatible.id)}`, { method: 'POST' });
  if (install?._error) return { _error: `App Hub install failed: ${install._error}`, _hint: 'You may lack the authority to install apps. Install "Capture Growth Chart" via App Management instead.' };
  const after = await gcAppStatus();
  return {
    success: true,
    installed_version: compatible.version,
    app_key: after.app_key || GROWTH_CHART_APP_KEY,
    plugin_launch_url: after.plugin_launch_url || `${dhis2.baseUrl}/api/apps/${GROWTH_CHART_APP_KEY}/plugin.html`,
    _note: after.installed ? 'Installed and confirmed in the app list.' : 'Install POST accepted; the app may take a moment to appear.',
  };
}

// Build the dashboard-attach guidance block (the part this tool does NOT auto-write).
function gcDashboardAttachBlock(pluginUrl, programId) {
  return {
    plugin_source_url: pluginUrl || `${dhis2.baseUrl}/api/apps/${GROWTH_CHART_APP_KEY}/plugin.html`,
    note: 'The plugin is configured but must be ADDED to the enrollment dashboard to become visible. This tool does not modify the Capture dashboard layout (dataStore/capture) to avoid corrupting the Capture cache.',
    steps: [
      'Easiest: open the "Tracker Plugin Configurator" app, pick this program, and add the Capture Growth Chart plugin to the enrollment dashboard.',
      `Or in Capture: open an enrollment for program ${programId || '<program>'}, use the enrollment dashboard "Edit"/"Add plugin" option, and paste the plugin source URL above.`,
    ],
  };
}

// Fetch a program with the attributes + stage data elements needed for detection.
async function gcFetchProgram(programId) {
  return await safeDhis2Fetch(
    `programs/${programId}?fields=id,displayName,programType,` +
    `programTrackedEntityAttributes[mandatory,trackedEntityAttribute[id,displayName,valueType,optionSet[id,options[code,displayName]]]],` +
    `programStages[id,displayName,programStageDataElements[dataElement[id,displayName,valueType]]]`
  );
}

function gcMatch(list, getName, patterns, extra) {
  for (const re of patterns) {
    const m = list.find(item => re.test(getName(item)) && (!extra || extra(item)));
    if (m) return m;
  }
  return null;
}

async function growthChartConfigure(args) {
  const programId = args.program_id;
  if (!programId) return { _error: 'program_id is required for configure.' };
  const prog = await gcFetchProgram(programId);
  if (prog?._error) return { _error: `Could not load program ${programId}: ${prog._error}`, _hint: 'Pass a valid tracker program UID.' };
  if (prog.programType !== 'WITH_REGISTRATION') {
    return { _error: `Program "${prog.displayName}" is not a tracker (WITH_REGISTRATION) program. The growth chart plugin only works on tracker programs.` };
  }

  const teas = (prog.programTrackedEntityAttributes || []).map(p => p.trackedEntityAttribute).filter(Boolean);
  const teaName = t => t.displayName || '';
  const ov = args.attribute_ids || {};
  const byId = (id) => teas.find(t => t.id === id);

  // ── Attribute detection (explicit override wins) ──
  const dobTea = (ov.dateOfBirth && byId(ov.dateOfBirth))
    || gcMatch(teas, teaName, [/date\s*of\s*birth/i, /\bdob\b/i, /\bbirth\s*date\b/i, /\bbirth\b/i], t => t.valueType === 'DATE');
  const genderTea = (ov.gender && byId(ov.gender))
    || gcMatch(teas, teaName, [/\bgender\b/i, /\bsex\b/i], t => !!t.optionSet);
  const firstNameTea = (ov.firstName && byId(ov.firstName))
    || gcMatch(teas, teaName, [/first\s*name/i, /given\s*name/i]);
  const lastNameTea = (ov.lastName && byId(ov.lastName))
    || gcMatch(teas, teaName, [/last\s*name/i, /surname/i, /family\s*name/i]);

  // ── Stage + data-element detection ──
  const stages = prog.programStages || [];
  let stage = args.program_stage_id ? stages.find(s => s.id === args.program_stage_id) : null;
  if (args.program_stage_id && !stage) {
    return { _error: `Program stage ${args.program_stage_id} is not part of program ${programId}.` };
  }
  const deOv = args.data_element_ids || {};
  const detectInStage = (s) => {
    const des = (s.programStageDataElements || []).map(p => p.dataElement).filter(Boolean);
    const dn = d => d.displayName || '';
    const weight = (deOv.weight && des.find(d => d.id === deOv.weight)) || gcMatch(des, dn, [/\bweight\b/i, /\bwt\b/i]);
    const height = (deOv.height && des.find(d => d.id === deOv.height)) || gcMatch(des, dn, [/\bheight\b/i, /\blength\b/i, /\bstature\b/i]);
    const headCircumference = (deOv.headCircumference && des.find(d => d.id === deOv.headCircumference)) || gcMatch(des, dn, [/head\s*circ/i, /circumference/i, /\bhc\b/i]);
    return { weight, height, headCircumference, count: [weight, height, headCircumference].filter(Boolean).length };
  };
  let de;
  if (stage) {
    de = detectInStage(stage);
  } else {
    // pick the stage that contains the most of the three measurements
    let best = null;
    for (const s of stages) {
      const d = detectInStage(s);
      if (!best || d.count > best.de.count) best = { stage: s, de: d };
    }
    if (best) { stage = best.stage; de = best.de; }
  }
  if (!stage) return { _error: `Program "${prog.displayName}" has no program stages.` };

  // ── Gender option codes ──
  const genderOptions = genderTea?.optionSet?.options || [];
  let femaleCode = args.female_option_code
    || (genderOptions.find(o => /female/i.test(o.code) || /female/i.test(o.displayName)) || {}).code;
  let maleCode = args.male_option_code
    || (genderOptions.find(o => (/male/i.test(o.code) || /male/i.test(o.displayName)) && !/female/i.test(o.code) && !/female/i.test(o.displayName)) || {}).code;

  // ── Validate hard requirements ──
  const missing = [];
  if (!dobTea) missing.push('a Date-of-birth (DATE) tracked-entity attribute');
  if (!genderTea) missing.push('a Gender/sex attribute with an option set');
  if (genderTea && (!femaleCode || !maleCode)) missing.push('female/male option codes on the gender option set (pass female_option_code / male_option_code)');
  if (!de || !de.weight) missing.push('a Weight data element on the stage');
  if (!de || !de.height) missing.push('a Height/Length data element on the stage');
  if (!de || !de.headCircumference) missing.push('a Head-circumference data element on the stage');
  if (missing.length) {
    return {
      _error: `Program "${prog.displayName}" is missing required growth-chart metadata: ${missing.join('; ')}.`,
      _hint: 'The plugin will not render unless all three data elements (weight, height, head circumference) and the date-of-birth + gender attributes exist. Pass explicit ids via attribute_ids / data_element_ids, or run action="scaffold_program" to create a ready-to-use program.',
      detected: {
        dateOfBirth: dobTea ? { id: dobTea.id, name: dobTea.displayName } : null,
        gender: genderTea ? { id: genderTea.id, name: genderTea.displayName, femaleCode, maleCode } : null,
        stage: stage ? { id: stage.id, name: stage.displayName } : null,
        weight: de?.weight ? { id: de.weight.id, name: de.weight.displayName } : null,
        height: de?.height ? { id: de.height.id, name: de.height.displayName } : null,
        headCircumference: de?.headCircumference ? { id: de.headCircumference.id, name: de.headCircumference.displayName } : null,
      },
    };
  }

  // weightInGrams: explicit setting wins, else infer from the weight DE name.
  const weightName = de.weight.displayName || '';
  const inferGrams = /\(\s*g\s*\)|gram/i.test(weightName) && !/\(\s*kg\s*\)|kilogram/i.test(weightName);
  const settingsIn = isPlainObject(args.settings) ? args.settings : {};
  if (settingsIn.defaultIndicator && !GROWTH_CHART_INDICATORS.has(settingsIn.defaultIndicator)) {
    return { _error: `Invalid defaultIndicator "${settingsIn.defaultIndicator}". One of: ${[...GROWTH_CHART_INDICATORS].join(', ')}.` };
  }

  // ── Merge into existing config (preserve other programs + settings) ──
  const cfgRead = await gcReadConfig();
  if (cfgRead._error) return cfgRead;
  const existing = cfgRead.value || {};
  const existingMeta = isPlainObject(existing.metadata) ? existing.metadata : {};
  const existingStages = isPlainObject(existingMeta.programStageForGrowthChart) ? existingMeta.programStageForGrowthChart : {};
  const existingSettings = isPlainObject(existing.settings) ? existing.settings : {};

  const config = {
    ...existing,
    metadata: {
      ...existingMeta,
      attributes: {
        dateOfBirth: dobTea.id,
        gender: genderTea.id,
        firstName: firstNameTea ? firstNameTea.id : (existingMeta.attributes?.firstName || ''),
        lastName: lastNameTea ? lastNameTea.id : (existingMeta.attributes?.lastName || ''),
        femaleOptionCode: femaleCode,
        maleOptionCode: maleCode,
      },
      dataElements: {
        weight: de.weight.id,
        height: de.height.id,
        headCircumference: de.headCircumference.id,
      },
      programStageForGrowthChart: { ...existingStages, [programId]: stage.id },
    },
    settings: {
      usePercentiles: false,
      customReferences: false,
      weightInGrams: inferGrams,
      defaultIndicator: 'wfa',
      ...existingSettings,
      ...settingsIn,
    },
  };
  if (settingsIn.weightInGrams === undefined && existingSettings.weightInGrams === undefined) {
    config.settings.weightInGrams = inferGrams;
  }

  const wrote = await gcWriteConfig(config);
  if (wrote._error) return wrote;

  const appStatus = await gcAppStatus();
  const hints = [];
  if (appStatus.installed === false) hints.push('The Capture Growth Chart app is NOT installed yet — run action="install" (or install it via App Management) or the dashboard widget cannot load.');
  if (!firstNameTea || !lastNameTea) hints.push('First/last name attributes were not found; they are optional (used for printed charts) so configuration still proceeded.');

  return {
    success: true,
    program: { id: prog.id, name: prog.displayName },
    stage: { id: stage.id, name: stage.displayName },
    resolved: {
      attributes: config.metadata.attributes,
      dataElements: config.metadata.dataElements,
    },
    settings: config.settings,
    config_key: `${GROWTH_CHART_NS}/${GROWTH_CHART_KEY}`,
    plugin_installed: appStatus.installed,
    dashboard_attach: gcDashboardAttachBlock(appStatus.plugin_launch_url, programId),
    _hints: hints.length ? hints : undefined,
  };
}

async function growthChartScaffoldProgram(args) {
  const ouId = args.org_unit_id;
  if (!ouId) return { _error: 'org_unit_id is required for scaffold_program (the org unit the new program is assigned to).' };
  const ouCheck = await safeDhis2Fetch(`organisationUnits/${ouId}?fields=id,displayName`);
  if (ouCheck?._error) return { _error: `Org unit ${ouId} not found: ${ouCheck._error}` };
  const progName = (args.program_name && String(args.program_name).trim()) || 'Growth Monitoring';

  // default categoryCombo
  const ccResp = await safeDhis2Fetch('categoryCombos?fields=id&filter=isDefault:eq:true&paging=false');
  const defaultCC = ccResp?.categoryCombos?.[0]?.id || 'bjDvmb4bfuf';

  // Person TET — reuse if present, else create.
  const tetResp = await safeDhis2Fetch('trackedEntityTypes?fields=id,displayName&paging=false');
  let personTetId = (tetResp?.trackedEntityTypes || []).find(t => /person/i.test(t.displayName || ''))?.id;
  const newObjs = { trackedEntityTypes: [], trackedEntityAttributes: [], optionSets: [], options: [], dataElements: [], programs: [], programStages: [] };
  if (!personTetId) {
    personTetId = generateDhis2Uid();
    newObjs.trackedEntityTypes.push({ id: personTetId, name: `Person (${progName})`, sharing: { public: 'rwrw----' } });
  }

  // Reuse standard demo attributes by exact name when present, else create.
  const wantTeas = [
    { role: 'firstName', name: 'First name', valueType: 'TEXT' },
    { role: 'lastName', name: 'Last name', valueType: 'TEXT' },
    { role: 'gender', name: 'Gender', valueType: 'TEXT', withOptionSet: true },
    { role: 'dateOfBirth', name: 'Date of birth', valueType: 'DATE' },
  ];
  const teaResp = await safeDhis2Fetch(
    `trackedEntityAttributes?fields=id,displayName,valueType,optionSet[id,options[code,displayName]]&paging=false&filter=displayName:in:[${wantTeas.map(t => t.name).join(',')}]`
  );
  // Probe failure ≠ "none exist" — creating blindly would duplicate the demo TEAs.
  if (teaResp?._error) {
    return { _error: `Could not check for existing attributes (${teaResp._error}). Aborting BEFORE creating anything to avoid duplicates. Nothing was changed — verify connectivity and retry.` };
  }
  const foundTeas = teaResp?.trackedEntityAttributes || [];
  const teaIds = {};
  let optionSetId = null, femaleCode = 'Female', maleCode = 'Male';
  for (const want of wantTeas) {
    const hit = foundTeas.find(t => (t.displayName || '').toLowerCase() === want.name.toLowerCase() && t.valueType === want.valueType);
    if (hit) {
      teaIds[want.role] = hit.id;
      if (want.role === 'gender' && hit.optionSet?.options?.length) {
        femaleCode = (hit.optionSet.options.find(o => /female/i.test(o.code) || /female/i.test(o.displayName)) || {}).code || femaleCode;
        maleCode = (hit.optionSet.options.find(o => (/male/i.test(o.code) || /male/i.test(o.displayName)) && !/female/i.test(o.code) && !/female/i.test(o.displayName)) || {}).code || maleCode;
      }
      continue;
    }
    const id = generateDhis2Uid();
    teaIds[want.role] = id;
    const tea = { id, name: `${progName}: ${want.name}`, shortName: `${want.name}`.slice(0, 50), valueType: want.valueType, aggregationType: 'NONE', sharing: { public: 'rwrw----' } };
    if (want.withOptionSet) {
      optionSetId = generateDhis2Uid();
      const femaleId = generateDhis2Uid(), maleId = generateDhis2Uid();
      newObjs.optionSets.push({ id: optionSetId, name: `${progName}: Sex`, valueType: 'TEXT', options: [{ id: maleId }, { id: femaleId }] });
      newObjs.options.push({ id: maleId, name: 'Male', code: 'Male', optionSet: { id: optionSetId }, sortOrder: 1 });
      newObjs.options.push({ id: femaleId, name: 'Female', code: 'Female', optionSet: { id: optionSetId }, sortOrder: 2 });
      tea.optionSet = { id: optionSetId };
      femaleCode = 'Female'; maleCode = 'Male';
    }
    newObjs.trackedEntityAttributes.push(tea);
  }

  // Three fresh measurement data elements (names prefixed to avoid collisions).
  const deDefs = [
    { role: 'weight', label: 'Weight (kg)' },
    { role: 'height', label: 'Height (cm)' },
    { role: 'headCircumference', label: 'Head circumference (cm)' },
  ];
  const deIds = {};
  for (const d of deDefs) {
    const id = generateDhis2Uid();
    deIds[d.role] = id;
    newObjs.dataElements.push({ id, name: `${progName}: ${d.label}`, shortName: `${d.label}`.slice(0, 50), valueType: 'NUMBER', domainType: 'TRACKER', aggregationType: 'AVERAGE', categoryCombo: { id: defaultCC }, sharing: { public: 'rw------' } });
  }

  const programId = generateDhis2Uid();
  const stageId = generateDhis2Uid();
  newObjs.programs.push({
    id: programId, name: progName, shortName: progName.slice(0, 50), programType: 'WITH_REGISTRATION',
    trackedEntityType: { id: personTetId }, categoryCombo: { id: defaultCC }, sharing: { public: 'rwrw----' },
    organisationUnits: [{ id: ouId }],
    programTrackedEntityAttributes: [
      { trackedEntityAttribute: { id: teaIds.firstName }, displayInList: true, searchable: true },
      { trackedEntityAttribute: { id: teaIds.lastName }, displayInList: true, searchable: true },
      { trackedEntityAttribute: { id: teaIds.gender }, mandatory: true },
      { trackedEntityAttribute: { id: teaIds.dateOfBirth }, mandatory: true },
    ],
    programStages: [{ id: stageId }],
  });
  newObjs.programStages.push({
    id: stageId, name: 'Growth measurements', program: { id: programId }, repeatable: true, sharing: { public: 'rwrw----' },
    programStageDataElements: [
      { dataElement: { id: deIds.weight } },
      { dataElement: { id: deIds.height } },
      { dataElement: { id: deIds.headCircumference } },
    ],
  });

  // Strip empty buckets so the importer doesn't choke.
  const payload = {};
  for (const [k, v] of Object.entries(newObjs)) if (v.length) payload[k] = v;

  const imp = await safeDhis2Fetch('metadata?importStrategy=CREATE_AND_UPDATE&atomicMode=ALL', { method: 'POST', body: payload });
  const resp = imp?.response || imp;
  if (resp?.status === 'ERROR' || imp?._error) {
    const errs = (resp?.typeReports || []).flatMap(t => (t.objectReports || []).flatMap(o => (o.errorReports || []).map(e => `${(t.klass || '').split('.').pop()}: ${e.message}`)));
    return { _error: `Could not create the growth-monitoring program: ${imp?._error || 'import failed'}`, import_errors: errs.slice(0, 8) };
  }

  return {
    success: true,
    created_program: { id: programId, name: progName, stage_id: stageId },
    org_unit: { id: ouId, name: ouCheck.displayName },
    attributes: teaIds,
    data_elements: deIds,
    gender_codes: { femaleCode, maleCode },
    import_stats: resp?.stats,
    _next: `Now run action="configure" with program_id="${programId}" to write captureGrowthChart/config. Then run action="install" if the plugin app isn't installed.`,
  };
}

async function growthChartRemove(args) {
  const programId = args.program_id;
  const cfgRead = await gcReadConfig();
  if (cfgRead._error) return cfgRead;
  if (!cfgRead.exists) return { success: true, removed: false, _note: 'No captureGrowthChart/config key exists.' };

  if (!programId) {
    if (args.confirm_delete_all !== true) {
      return { _error: 'remove without program_id deletes the ENTIRE captureGrowthChart/config. Re-run with confirm_delete_all:true to proceed, or pass program_id to remove just one program.' };
    }
    const del = await safeDhis2Fetch(gcPath(GROWTH_CHART_KEY), { method: 'DELETE' });
    if (del?._error && del?._status !== 404) return { _error: `Could not delete config: ${del._error}` };
    return { success: true, removed_all: true, previous_value: cfgRead.value };
  }

  const cfg = cfgRead.value || {};
  const map = cfg.metadata?.programStageForGrowthChart || {};
  if (!(programId in map)) {
    return { success: true, removed: false, _note: `Program ${programId} is not in the growth-chart config.`, configured_programs: Object.keys(map) };
  }
  const previous = JSON.parse(JSON.stringify(cfg));
  delete map[programId];
  cfg.metadata.programStageForGrowthChart = map;
  const wrote = await gcWriteConfig(cfg);
  if (wrote._error) return wrote;
  return { success: true, removed_program: programId, remaining_programs: Object.keys(map), previous_value: previous };
}

async function growthChartStatus() {
  const app = await gcAppStatus();
  const cfgRead = await gcReadConfig();
  if (cfgRead._error) return cfgRead;
  const cfg = cfgRead.value;
  const programMap = cfg?.metadata?.programStageForGrowthChart || {};
  const programIds = Object.keys(programMap);
  let programs = [];
  if (programIds.length) {
    const resp = await safeDhis2Fetch(`programs?fields=id,displayName&filter=id:in:[${programIds.join(',')}]&paging=false`);
    const names = Object.fromEntries((resp?.programs || []).map(p => [p.id, p.displayName]));
    programs = programIds.map(id => ({ id, name: names[id] || '(unknown)', stage_id: programMap[id] }));
  }
  return {
    success: true,
    plugin_installed: app.installed,
    plugin_launch_url: app.plugin_launch_url || null,
    config_exists: cfgRead.exists,
    configured_programs: programs,
    settings: cfg?.settings || null,
    attributes: cfg?.metadata?.attributes || null,
    data_elements: cfg?.metadata?.dataElements || null,
    _hint: app.installed === false
      ? 'Plugin app not installed — run action="install".'
      : (!cfgRead.exists ? 'No config yet — run action="configure" with a program_id (or scaffold_program first).' : undefined),
  };
}

async function executeManageGrowthChartPlugin(args) {
  const action = args?.action;
  if (!action) return { _error: 'Missing required parameter: action', _hint: 'One of: status, install, scaffold_program, configure, remove.' };
  if (action === 'status') return await growthChartStatus();
  if (action === 'install') {
    const gate = requireWriteAuth('manage_growth_chart_plugin', 'install', {});
    if (gate) return gate;
    return await gcInstall();
  }
  if (action === 'scaffold_program') {
    const gate = requireWriteAuth('manage_growth_chart_plugin', 'scaffold_program', { org_unit_id: args.org_unit_id });
    if (gate) return gate;
    return await growthChartScaffoldProgram(args);
  }
  if (action === 'configure') {
    const gate = requireWriteAuth('manage_growth_chart_plugin', 'configure', { program_id: args.program_id });
    if (gate) return gate;
    return await growthChartConfigure(args);
  }
  if (action === 'remove') {
    const gate = requireWriteAuth('manage_growth_chart_plugin', 'remove', { program_id: args.program_id });
    if (gate) return gate;
    return await growthChartRemove(args);
  }
  return { _error: `Unknown manage_growth_chart_plugin action: ${action}`, _hint: 'One of: status, install, scaffold_program, configure, remove.' };
}

async function postMetadataPayload(payload, dryRunOnly) {
  // Helper: extract errors from DHIS2 import response typeReports
  function extractErrors(resp) {
    const typeReports = resp?.typeReports || resp?.response?.typeReports || [];
    const errors = [];
    for (const tr of typeReports) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) {
          errors.push(`${tr.klass?.split('.')?.pop() || 'Object'}: ${er.message}`);
        }
      }
    }
    return errors;
  }

  // Detect shortName conflicts in DHIS2 validation/import errors and
  // auto-suffix the offending object so the next retry succeeds. Handles
  // both the typed validation form ("Property `shortName` with value `X`")
  // and the raw Postgres form ("Key (shortname)=(X) already exists"). Returns
  // true when at least one object was patched in-place. The caller can then
  // re-POST without bothering the user.
  function tryAutofixShortNameConflicts(errorMessages) {
    if (!Array.isArray(errorMessages) || !errorMessages.length) return false;
    const conflictValues = new Set();
    for (const msg of errorMessages) {
      const text = String(msg || '');
      // "Property `shortName` with value `Patient Name` already exists"
      let m = text.match(/Property\s+`?shortName`?\s+with value\s+`([^`]+)`/i);
      if (m) { conflictValues.add(m[1]); continue; }
      // "Key (shortname)=(Patient Name) already exists"
      m = text.match(/\(shortname\)=\(([^)]+)\)/i);
      if (m) { conflictValues.add(m[1]); continue; }
      // Some DHIS2 versions use plain quotes
      m = text.match(/shortName\s+["']([^"']+)["']\s+(?:already|is)/i);
      if (m) { conflictValues.add(m[1]); continue; }
    }
    if (conflictValues.size === 0) return false;

    let patched = false;
    const objectArrays = [
      'dataElements', 'trackedEntityAttributes', 'programIndicators',
      'programs', 'programStages', 'optionSets', 'options', 'indicators',
    ];
    for (const key of objectArrays) {
      const arr = payload[key];
      if (!Array.isArray(arr)) continue;
      for (const obj of arr) {
        if (obj && obj.shortName && conflictValues.has(obj.shortName)) {
          const base = obj.shortName.slice(0, 45).replace(/\s+$/, '');
          obj.shortName = `${base} ${generateDhis2Uid().slice(-4)}`;
          patched = true;
        }
      }
    }
    return patched;
  }

  // ── NAME-conflict self-healing ──────────────────────────────────────────────
  // DHIS2 name uniqueness errors carry BOTH UIDs:
  //   "Property `name` with value `Sex` on object Sex [kzqq7s1sirO]
  //    (TrackedEntityAttribute) already exists on object WCffUc0Cp2j"
  // For classes where same-name means same-thing (TEA, DE, option set, TET,
  // category objects) the ONLY correct move is to REUSE the existing object:
  // drop our would-be duplicate from the payload and rewrite every reference
  // from our pre-generated UID to the existing one, then retry. Never let the
  // model "fix" this by inventing a name variant — that creates near-duplicate
  // metadata. For classes whose name is unique but instance-specific
  // (ProgramStage, ProgramIndicator) reuse would hijack another program's
  // object, so those get a rename-with-suffix instead (mirrors the pre-probe
  // convention). The duplicate object is REMOVED, not imported as an update —
  // importing it would overwrite the existing object's fields (optionSet,
  // description, unique flag, …) with our minimal stub.
  const REUSE_ON_NAME_CONFLICT = new Set([
    'TrackedEntityAttribute', 'DataElement', 'OptionSet', 'TrackedEntityType',
    'CategoryOption', 'Category', 'CategoryCombo',
  ]);
  const RENAME_ON_NAME_CONFLICT = new Set(['ProgramStage', 'ProgramIndicator']);
  const nameConflictRemaps = [];  // [{klass, name, from, to}] — deduped → reused existing UID
  const nameConflictRenames = []; // [{klass, from, to, id}]  — renamed to dodge unique name
  function remapUidInPayload(fromUid, toUid) {
    const walk = (node) => {
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) {
          if (node[k] === fromUid) node[k] = toUid;
          else walk(node[k]);
        }
      }
    };
    walk(payload);
  }
  function tryAutofixNameConflicts(errorMessages) {
    if (!Array.isArray(errorMessages) || !errorMessages.length) return false;
    let patched = false;
    for (const msg of errorMessages) {
      const m = String(msg || '').match(
        /Property\s+`name`\s+with value\s+`([^`]*)`\s+on object .*?\[([A-Za-z][A-Za-z0-9]{10})\]\s+\((\w+)\)\s+already exists on object\s+([A-Za-z][A-Za-z0-9]{10})/i
      );
      if (!m) continue;
      const [, dupName, newUid, klass, existingUid] = m;
      if (newUid === existingUid) continue;
      if (REUSE_ON_NAME_CONFLICT.has(klass)) {
        for (const key of Object.keys(payload)) {
          if (Array.isArray(payload[key])) payload[key] = payload[key].filter(o => !(o && o.id === newUid));
        }
        remapUidInPayload(newUid, existingUid);
        nameConflictRemaps.push({ klass, name: dupName, from: newUid, to: existingUid });
        patched = true;
      } else if (RENAME_ON_NAME_CONFLICT.has(klass)) {
        for (const key of Object.keys(payload)) {
          if (!Array.isArray(payload[key])) continue;
          for (const o of payload[key]) {
            if (o && o.id === newUid && o.name) {
              const renamed = `${String(o.name).slice(0, 225).replace(/\s+$/, '')} ${generateDhis2Uid().slice(-4)}`;
              nameConflictRenames.push({ klass, from: o.name, to: renamed, id: newUid });
              o.name = renamed;
              patched = true;
            }
          }
        }
      }
    }
    return patched;
  }
  // Recovery summary attached to every return so callers (and the model) see
  // that duplicates were auto-reused, and can sync their name→ID maps.
  const recoveryInfo = () => ({
    ...(nameConflictRemaps.length ? {
      _name_conflict_remaps: nameConflictRemaps,
      _recovery_note: `Auto-reused ${nameConflictRemaps.length} object(s) that ALREADY EXISTED on the server by name instead of creating duplicates: ${nameConflictRemaps.map(r => `${r.klass} "${r.name}" → ${r.to}`).join(', ')}.`,
    } : {}),
    ...(nameConflictRenames.length ? { _name_conflict_renames: nameConflictRenames } : {}),
  });

  // Helper: check if response indicates failure (HTTP error OR status=ERROR)
  function isResponseError(resp) {
    if (!resp) return 'Empty response from DHIS2';
    if (resp._error) return resp._error;
    const status = resp?.status || resp?.response?.status;
    if (status === 'ERROR') {
      const msg = resp?.message || resp?.response?.message || 'Unknown error';
      return `DHIS2 import status ERROR: ${msg}`;
    }
    return null;
  }

  // Dry-run validation
  let validateResp = await safeDhis2Fetch('metadata?importMode=VALIDATE&atomicMode=ALL', {
    method: 'POST',
    body: payload,
  });

  // Check for HTTP-level or status-level errors
  let validateError = isResponseError(validateResp);
  if (validateError) {
    // Extract detailed errors from the response body (e.g., 409 responses contain typeReports)
    const detailedErrors = validateResp._body ? extractErrors(validateResp._body) : [];
    const allErrors = detailedErrors.length > 0 ? detailedErrors : [validateError];
    // Defense-in-depth: auto-fix shortName + name conflicts and revalidate once.
    const fixedShort = tryAutofixShortNameConflicts(allErrors);
    const fixedName = tryAutofixNameConflicts(allErrors);
    if (fixedShort || fixedName) {
      validateResp = await safeDhis2Fetch('metadata?importMode=VALIDATE&atomicMode=ALL', {
        method: 'POST',
        body: payload,
      });
      validateError = isResponseError(validateResp);
    }
    if (validateError) {
      const detailedErrors2 = validateResp._body ? extractErrors(validateResp._body) : [];
      const errorMsg = detailedErrors2.length > 0
        ? `Validation failed with ${detailedErrors2.length} error(s): ${detailedErrors2.slice(0, 5).join('; ')}`
        : `Validation failed: ${validateError}`;
      return { success: false, _error: errorMsg, phase: 'validation', errors: detailedErrors2.length > 0 ? detailedErrors2 : [validateError], ...recoveryInfo() };
    }
  }

  let stats = validateResp?.stats || validateResp?.response?.stats || {};
  let errors = extractErrors(validateResp);

  if (errors.length > 0) {
    // Auto-fix shortName + name conflicts and revalidate once before failing.
    const fixedShort = tryAutofixShortNameConflicts(errors);
    const fixedName = tryAutofixNameConflicts(errors);
    if (fixedShort || fixedName) {
      validateResp = await safeDhis2Fetch('metadata?importMode=VALIDATE&atomicMode=ALL', {
        method: 'POST',
        body: payload,
      });
      stats = validateResp?.stats || validateResp?.response?.stats || {};
      errors = extractErrors(validateResp);
    }
    if (errors.length > 0) {
      return { success: false, _error: `Validation failed with ${errors.length} error(s): ${errors[0]}`, phase: 'validation', errors, stats, ...recoveryInfo() };
    }
  }

  if (dryRunOnly) {
    return { success: true, phase: 'dry_run', message: 'Validation passed. No import performed (dry_run_only=true).', stats, ...recoveryInfo() };
  }

  // Actual import
  let importResp = await safeDhis2Fetch('metadata?importMode=COMMIT&atomicMode=ALL', {
    method: 'POST',
    body: payload,
  });

  // Check for HTTP-level or status-level errors
  let importError = isResponseError(importResp);
  if (importError) {
    const detailedImportErrors = importResp._body ? extractErrors(importResp._body) : [];
    const allImportErrors = detailedImportErrors.length > 0 ? detailedImportErrors : [importError];
    // Defense-in-depth for the rare race-condition shortName/name conflict that
    // slipped past pre-probe (another import committed between our probe
    // and our COMMIT). Auto-suffix / auto-reuse and retry once.
    const fixedShort = tryAutofixShortNameConflicts(allImportErrors);
    const fixedName = tryAutofixNameConflicts(allImportErrors);
    if (fixedShort || fixedName) {
      importResp = await safeDhis2Fetch('metadata?importMode=COMMIT&atomicMode=ALL', {
        method: 'POST',
        body: payload,
      });
      importError = isResponseError(importResp);
    }
    if (importError) {
      const detailedImportErrors2 = importResp._body ? extractErrors(importResp._body) : [];
      const importErrMsg = detailedImportErrors2.length > 0
        ? `Import failed with ${detailedImportErrors2.length} error(s): ${detailedImportErrors2.slice(0, 5).join('; ')}`
        : `Import failed: ${importError}`;
      return { success: false, _error: importErrMsg, phase: 'import', errors: detailedImportErrors2.length > 0 ? detailedImportErrors2 : [importError], ...recoveryInfo() };
    }
  }

  let importStats = importResp?.stats || importResp?.response?.stats || {};
  let importErrors = extractErrors(importResp);

  if (importErrors.length > 0) {
    const fixedShort = tryAutofixShortNameConflicts(importErrors);
    const fixedName = tryAutofixNameConflicts(importErrors);
    if (fixedShort || fixedName) {
      importResp = await safeDhis2Fetch('metadata?importMode=COMMIT&atomicMode=ALL', {
        method: 'POST',
        body: payload,
      });
      importStats = importResp?.stats || importResp?.response?.stats || {};
      importErrors = extractErrors(importResp);
    }
    if (importErrors.length > 0) {
      return { success: false, _error: `Import failed with ${importErrors.length} error(s): ${importErrors[0]}`, phase: 'import', errors: importErrors, stats: importStats, ...recoveryInfo() };
    }
  }

  // Final sanity check: ensure something was actually created/updated
  const created = importStats.created || 0;
  const updated = importStats.updated || 0;
  if (created === 0 && updated === 0 && (importStats.ignored || 0) > 0) {
    return { success: false, _error: `Import completed but all ${importStats.ignored} objects were ignored. Check for duplicate names or missing references.`, phase: 'import', stats: importStats, ...recoveryInfo() };
  }

  return { success: true, phase: 'import', stats: importStats, ...recoveryInfo() };
}

async function createFullProgram(args, defaultCatComboId, contextOrgUnitId) {
  if (!args.program_name) return { _error: 'Missing program_name for create_program' };

  // Default program_type to WITH_REGISTRATION (tracker) if not specified
  const programType = args.program_type || 'WITH_REGISTRATION';
  const isTracker = programType === 'WITH_REGISTRATION';

  // ── Program name collision resolution ───────────────────────────────────────
  // DHIS2 enforces UNIQUE on Program.name. If a program with the requested name
  // already exists, fail fast with a clear, actionable error rather than letting
  // the DB throw "duplicate key value violates unique constraint".
  //
  // Re-sync against the active tab BEFORE the probe — without this, dhis2.baseUrl
  // can lag behind the user's actual server (cross-server tab switch, fresh tab
  // open) and the probe hits the prior instance, returning that server's UID
  // and producing the "already exists" false-positive across instances.
  await ensureConnected();
  const probeServer = dhis2.baseUrl;
  const progProbe = await safeDhis2Fetch(
    `programs?filter=name:eq:${encodeURIComponent(args.program_name)}&fields=id,name,programType&pageSize=1`
  );
  if (progProbe?.programs?.length) {
    const existing = progProbe.programs[0];

    // Idempotent replay: if this exact program was created earlier in THIS turn
    // (LLM retried the same tool call after a successful run), return the prior
    // success summary instead of an "already exists" error. Without this guard
    // the user sees a confusing "Failed: already exists on play.im.dhis2..."
    // even though the program was created seconds earlier by the same chain.
    // Real cross-server / pre-existing collisions still error: their id is NOT
    // in dhis2.recentCreations.
    const recent = lookupRecentCreation('program', args.program_name);
    if (recent && recent.id === existing.id) {
      return {
        success: true,
        phase: 'idempotent_replay',
        stats: { created: 0, updated: 0, ignored: 1, total: 1 },
        summary: recent.summary || { program: { id: existing.id, name: args.program_name, type: existing.programType } },
        _idempotent_replay: true,
        _idempotent_message: `Program "${args.program_name}" was already successfully created earlier in this same turn (id: ${existing.id} on ${probeServer}). Returning the previous success summary — do NOT call create_program again for this name; continue with follow-up steps or answer the user.`,
        _origin_server: probeServer,
      };
    }

    return {
      _error: `A program named "${args.program_name}" already exists on ${probeServer} (id: ${existing.id}, type: ${existing.programType}). If you expected this server to be empty, confirm the active DHIS2 tab points to the intended instance and retry. Otherwise pick a different program_name, or modify the existing one via manage_metadata / manage_program_rules / add_data_elements_to_stage against id=${existing.id}.`,
      _hint: 'This is NOT the program you just created in this turn — the id does not match anything in the per-turn creation registry. The program is pre-existing on this server. To proceed: (a) pick a different program_name, or (b) call manage_metadata / add_data_elements_to_stage / manage_program_rules against the existing program id, or (c) confirm with the user that the active DHIS2 tab points to the intended server.',
      _scope: 'program_name_collision_preexisting',
      existing_program_id: existing.id,
      _origin_server: probeServer,
    };
  }

  // Resolve tracked entity type for tracker programs. `tracked_entity_type_id`
  // is documented as a UID, but the model sometimes passes a NAME instead
  // (e.g. "Person"), or even a hallucinated UID-shaped token — either one,
  // written straight into trackedEntityType.id, makes DHIS2 bounce the WHOLE
  // atomic import with "Invalid reference [Person] (TrackedEntityType)". So we
  // VERIFY the reference resolves to a real TET on this server before it ever
  // reaches the payload, and fail fast (listing what IS available) if not.
  //
  // We fetch the full TET list once and match in JS rather than using a
  // server-side `filter=name:eq:` — that filter is case-sensitive, exact, and
  // only matches the raw `name` (not the translated `displayName`), so it
  // silently misses "person"/"Person "/instances where the type's name differs
  // from its displayName. In-memory matching is case-insensitive, checks both
  // name and displayName, and degrades from exact → contains → Person-fallback.
  let tetId = null;
  if (isTracker) {
    const rawTet = args.tracked_entity_type_id;
    const tetList = await safeDhis2Fetch('trackedEntityTypes?fields=id,name,displayName&paging=false');
    if (tetList?._error) {
      return { _error: `Could not load TrackedEntityTypes to resolve trackedEntityType: ${tetList._error}` };
    }
    const allTets = tetList?.trackedEntityTypes || [];
    const norm = (s) => String(s || '').trim().toLowerCase();

    if (rawTet && hasUidShape(rawTet)) {
      // UID-shaped → accept only if it actually exists (a hallucinated UID
      // finds no match and falls through, instead of reaching the server as an
      // invalid reference).
      const hit = allTets.find(t => t.id === rawTet);
      if (hit) tetId = hit.id;
    }
    if (!tetId && rawTet && !hasUidShape(rawTet)) {
      // Treat as a NAME — case-insensitive exact match on name/displayName,
      // then a contains match ("Person (client)" etc.).
      const want = norm(rawTet);
      const exact = allTets.find(t => norm(t.name) === want || norm(t.displayName) === want);
      const partial = exact || allTets.find(t => norm(t.name).includes(want) || norm(t.displayName).includes(want));
      if (partial) tetId = partial.id;
    }
    if (!tetId && (!rawTet || /person/i.test(String(rawTet)))) {
      // Omitted, or an unresolved "Person"-ish request → default to any Person
      // type on the instance (matches the historical omitted-default behavior).
      const person = allTets.find(t => /person/i.test(t.name || '') || /person/i.test(t.displayName || ''));
      if (person) tetId = person.id;
    }
    if (!tetId) {
      const available = allTets.map(t => `${t.displayName || t.name} (${t.id})`).join(', ') || '(none exist on this server)';
      return {
        _error: `Could not resolve a TrackedEntityType${rawTet ? ` for tracked_entity_type_id="${rawTet}"` : ''} on this server.`,
        _hint: `Do NOT guess a UID. Available TrackedEntityTypes: ${available}. Pass tracked_entity_type_id as one of those UIDs (or its exact name), or omit it to use a Person type. If none exist, create one first.`,
        _available_tracked_entity_types: allTets.map(t => ({ id: t.id, name: t.displayName || t.name })),
      };
    }
  }

  // Resolve org units — order of precedence:
  //   1. assign_all_org_units flag → fetch every OU in the instance (all levels)
  //   2. explicit org_unit_ids
  //   3. context org unit
  //   4. root OU fallback
  let orgUnitIds = [];
  if (args.assign_all_org_units) {
    // Fetch all org units in one server-side call with paging=false.
    // This is the correct way to "assign all OUs at all levels" — the model should
    // never paginate OUs manually through search_metadata/dhis2_query.
    const allOuResp = await safeDhis2Fetch('organisationUnits?fields=id&paging=false');
    if (allOuResp?._error) return { _error: `Failed to fetch all org units: ${allOuResp._error}` };
    orgUnitIds = (allOuResp?.organisationUnits || []).map(o => o.id);
    if (!orgUnitIds.length) return { _error: 'assign_all_org_units=true but server returned 0 org units.' };
  } else if (args.org_unit_ids?.length) {
    orgUnitIds = args.org_unit_ids;
  } else if (contextOrgUnitId) {
    orgUnitIds = [contextOrgUnitId];
  } else {
    const rootOuResp = await safeDhis2Fetch('organisationUnits?filter=level:eq:1&fields=id&pageSize=1');
    const rootId = rootOuResp?.organisationUnits?.[0]?.id;
    if (rootId) {
      orgUnitIds = [rootId];
    } else {
      return { _error: 'No org_unit_ids provided, no org unit in context, and could not find root org unit. Provide org_unit_ids explicitly or set assign_all_org_units=true.' };
    }
  }

  // Resolve sharing — build the sharing block that will be attached to the program
  // (and optionally to stages / DEs / option sets). Shape matches the new sharing
  // format DHIS2 expects on metadata POST: { public, external, users, userGroups }.
  // Sharing ALWAYS gets built — even when the model passes no sharing argument.
  // DHIS2's server default for new programs is metadata-only ("rw------"),
  // which means NOBODY (not even the creating admin) has data write access:
  // every enrollment/event import bounces with E1091/E1095/E1096 and Capture's
  // Save silently fails. Verified live on play 2.42.5.1 (2026-07-01): a program
  // created without a sharing block was born unusable for data entry. Default
  // to public "rwrw----" on the program + stages (the two data-shareable
  // classes) so tracker data entry works out of the box — same convention
  // manage_datasets has always used.
  const sharingInput = args.sharing || {};
  let sharingBlock = null;
  {
    // Normalize: any model-supplied access string is coerced to a canonical
    // 8-char [rw-] form here. Without this, "r--------" (9 chars) leaks into
    // program.publicAccess and DHIS2 rejects the entire atomic import.
    const defaultAccess = normalizeAccessString(sharingInput.public_access, 'rwrw----');
    const users = {};
    const userGroups = {};
    let ownerUid = null;

    if (sharingInput.include_current_user) {
      // Resolve current user once — matches the user record behind the admin session.
      const meResp = await safeDhis2Fetch('me?fields=id,username,displayName');
      if (meResp?.id) {
        users[meResp.id] = { id: meResp.id, access: 'rwrw----' };
        ownerUid = meResp.id;
      }
    }
    for (const uid of (sharingInput.user_ids || [])) {
      users[uid] = { id: uid, access: 'rwrw----' };
    }
    for (const gid of (sharingInput.user_group_ids || [])) {
      userGroups[gid] = { id: gid, access: 'rwrw----' };
    }

    sharingBlock = {
      public: defaultAccess,
      external: false,
      users,
      userGroups,
    };
    if (ownerUid) sharingBlock.owner = ownerUid;
  }
  const applySharingToChildren = !sharingInput || sharingInput.apply_to_children !== false;

  // Collect all inline option sets and data elements across stages
  const allOptions = [];
  const allOptionSets = [];
  const allDataElements = [];
  const allTrackedEntityAttributes = [];
  const optionSetUidMap = {}; // name → uid
  const optionSetOptionsByName = {}; // option set name → [{name, code}] as BUILT locally
  const deUidMap = {}; // name → uid
  const teaUidMap = {}; // name → uid
  // Per-class shortName dedupe — DHIS2 enforces shortName uniqueness within
  // each metadata class. Two DEs with names sharing their first 50 chars
  // would otherwise collide and abort the atomic import. clampShortName
  // auto-suffixes a 4-char UID shard when a duplicate is detected.
  const seenDEShortNames = new Set();
  const seenTEAShortNames = new Set();

  const stages = args.stages || [];

  for (const stage of stages) {
    for (const de of (stage.data_elements || [])) {
      // Build inline option set if specified
      if (de.option_set && de.option_set.name && de.option_set.options?.length) {
        if (!optionSetUidMap[de.option_set.name]) {
          const { optionSet, options, osUid } = buildOptionSetAndOptions(de.option_set, de.value_type);
          allOptions.push(...options);
          allOptionSets.push(optionSet);
          optionSetUidMap[de.option_set.name] = osUid;
          optionSetOptionsByName[de.option_set.name] = options.map(o => ({ name: o.name, code: o.code }));
        }
      }
      // Build data element (skip duplicates by name)
      if (!deUidMap[de.name]) {
        const { elem, uid } = buildDataElement(de, defaultCatComboId, optionSetUidMap, seenDEShortNames);
        allDataElements.push(elem);
        deUidMap[de.name] = uid;
      }
    }
  }

  // Collect tracked entity attributes for tracker programs
  const explicitTeaIds = []; // [{id, name}] — reused-by-UID entries, verified against the server below
  if (isTracker && args.program_attributes?.length) {
    for (const attr of args.program_attributes) {
      // Explicit reuse by UID: the attribute already exists on the server —
      // reference it as-is, create NOTHING for it.
      if (attr.id && /^[A-Za-z][A-Za-z0-9]{10}$/.test(attr.id)) {
        teaUidMap[attr.name || attr.id] = attr.id;
        explicitTeaIds.push({ id: attr.id, name: attr.name || attr.id });
        continue;
      }
      // Handle inline option set for attribute
      if (attr.option_set && attr.option_set.name && attr.option_set.options?.length) {
        if (!optionSetUidMap[attr.option_set.name]) {
          const { optionSet, options, osUid } = buildOptionSetAndOptions(attr.option_set, attr.value_type);
          allOptions.push(...options);
          allOptionSets.push(optionSet);
          optionSetUidMap[attr.option_set.name] = osUid;
          optionSetOptionsByName[attr.option_set.name] = options.map(o => ({ name: o.name, code: o.code }));
        }
      }
      // Build TEA (skip duplicates by name)
      if (!teaUidMap[attr.name]) {
        const teaUid = generateDhis2Uid();
        const tea = {
          id: teaUid,
          name: attr.name,
          shortName: clampShortName(attr.short_name, attr.name, seenTEAShortNames, 'Attribute'),
          // Explicit value_type wins; otherwise infer from the name (e.g. DOB →
          // DATE, "Age" → INTEGER) instead of silently defaulting numerics/dates
          // to TEXT. Option-set attributes stay TEXT.
          valueType: attr.value_type || (attr.option_set ? 'TEXT' : inferValueType(attr.name, 'TEXT')),
          aggregationType: 'NONE',
        };
        if (attr.option_set && optionSetUidMap[attr.option_set.name]) {
          tea.optionSet = { id: optionSetUidMap[attr.option_set.name] };
        }
        allTrackedEntityAttributes.push(tea);
        teaUidMap[attr.name] = teaUid;
      }
    }
  }

  // ── Duplicate checking: reuse existing objects by name to avoid 409 conflicts ──
  //
  // Perf note: every probe below was previously serial. For a typical program
  // (1 OS, 5 DEs, 3 TEAs, 2 stages) that was ~7 sequential round-trips before
  // we even reached validation. The restructure below is purely about
  // wall-clock — same probes, same dedup logic, but:
  //   • Step 1 (OS dedup) is one batched query instead of one-per-OS.
  //   • Steps 3 / 4 / 5 (options / DE / TEA name dedup) are independent of
  //     each other once Step 1 is done, so their batched queries fan out in
  //     parallel.
  // Capability is identical; latency drops from N RTTs to 2.

  // 1. Check option sets by name — one batched query, then remap & flag.
  const reusedOptionSetNames = new Set(); // sets that already exist server-side — their REAL option codes may differ from our locally derived ones
  if (allOptionSets.length > 0) {
    const osNames = allOptionSets.map(o => o.name);
    const osBatches = [];
    for (let i = 0; i < osNames.length; i += 50) osBatches.push(osNames.slice(i, i + 50));
    const osResponses = await Promise.all(osBatches.map(batch => {
      const nameFilter = batch.map(n => encodeURIComponent(n)).join(',');
      return safeDhis2Fetch(`optionSets?filter=name:in:[${nameFilter}]&fields=id,name&pageSize=50`);
    }));
    // Fail LOUD on probe errors — see the DE/TEA probe block below for why.
    const osProbeFailures = osResponses.filter(r => r?._error).map(r => `optionSets name probe: ${r._error}`);
    if (osProbeFailures.length) {
      return {
        success: false,
        nothing_created: true,
        phase: 'pre_check',
        _error: `Aborted BEFORE creating anything: could not check the server for existing option sets (${osProbeFailures.join('; ')})`,
        errors: osProbeFailures,
        _hint: 'The duplicate-check query against DHIS2 failed, so existing option sets could not be detected and creating blindly would duplicate them. Nothing was imported. Verify connectivity/permissions and retry the SAME create_program call.',
      };
    }
    for (const resp of osResponses) {
      for (const ex of (resp?.optionSets || [])) {
        const os = allOptionSets.find(o => o.name === ex.name);
        if (os && !os._skip) {
          const oldId = os.id;
          optionSetUidMap[os.name] = ex.id;
          os._skip = true;
          reusedOptionSetNames.add(os.name);
          for (const de of allDataElements) { if (de.optionSet?.id === oldId) de.optionSet.id = ex.id; }
          for (const tea of allTrackedEntityAttributes) { if (tea.optionSet?.id === oldId) tea.optionSet.id = ex.id; }
        }
      }
    }
  }
  const filteredOptionSets = allOptionSets.filter(os => !os._skip);

  // 2. Skip options belonging to skipped option sets (they already exist in DHIS2)
  const skippedOptionIds = new Set();
  for (const os of allOptionSets) {
    if (os._skip && os.options) {
      for (const ref of os.options) skippedOptionIds.add(ref.id);
    }
  }
  let finalOptions = allOptions.filter(opt => !skippedOptionIds.has(opt.id));

  // 3 + 4. Run DE / TEA name probes in parallel — they have no ordering
  // dependency on each other, only on Step 1 above.
  //
  // ⚠️ Options are deliberately NOT deduplicated against the server by name.
  // A DHIS2 Option belongs to exactly ONE optionSet (options.optionsetid FK).
  // The old "reuse an existing option with the same name" logic rewired a NEW
  // option set to reference options owned by OTHER option sets ("None",
  // "Negative", "Live birth", …) and the metadata import silently RE-PARENTED
  // them — ripping the option out of its original set and corrupting unrelated
  // metadata with no backup. Verified live on play 2.42.5.1 (2026-07-01): a new
  // set referencing an existing "None"/"Mild" stole both options from the set
  // that owned them. Same-name options across different sets are normal and
  // correct in DHIS2 — every new set must get ITS OWN option rows.
  const deBatches = [];
  if (allDataElements.length > 0) {
    const deNames = allDataElements.map(d => d.name);
    for (let i = 0; i < deNames.length; i += 50) deBatches.push(deNames.slice(i, i + 50));
  }
  const teaBatches = [];
  if (allTrackedEntityAttributes.length > 0) {
    const teaNames = allTrackedEntityAttributes.map(t => t.name);
    for (let i = 0; i < teaNames.length; i += 50) teaBatches.push(teaNames.slice(i, i + 50));
  }

  const [deResponses, teaResponses, explicitTeaResp] = await Promise.all([
    Promise.all(deBatches.map(batch => {
      const nameFilter = batch.map(n => encodeURIComponent(n)).join(',');
      return safeDhis2Fetch(`dataElements?filter=name:in:[${nameFilter}]&fields=id,name&pageSize=50`);
    })),
    Promise.all(teaBatches.map(batch => {
      const nameFilter = batch.map(n => encodeURIComponent(n)).join(',');
      return safeDhis2Fetch(`trackedEntityAttributes?filter=name:in:[${nameFilter}]&fields=id,name&pageSize=50`);
    })),
    explicitTeaIds.length
      ? safeDhis2Fetch(`trackedEntityAttributes?filter=id:in:[${explicitTeaIds.map(t => t.id).join(',')}]&fields=id,name&paging=false`)
      : Promise.resolve(null),
  ]);

  // ── Dedup probes MUST succeed before we import ─────────────────────────────
  // If a probe errored (network, auth, a strict proxy rejecting the URL, …) we
  // know NOTHING about what already exists — proceeding would blindly create
  // duplicates of objects that may already be there, and the atomic import
  // would bounce with confusing "already exists" errors (or worse, near-
  // duplicates would be created). Verified live 2026-07-10 on a Tomcat-fronted
  // 2.42: silent probe 400s caused create_program to recreate the existing
  // "Full name"/"DoB"/"Sex" TEAs three times in a row. Fail LOUD instead.
  {
    const probeFailures = [];
    for (const r of deResponses) if (r?._error) probeFailures.push(`dataElements name probe: ${r._error}`);
    for (const r of teaResponses) if (r?._error) probeFailures.push(`trackedEntityAttributes name probe: ${r._error}`);
    if (explicitTeaResp?._error) probeFailures.push(`trackedEntityAttributes id probe: ${explicitTeaResp._error}`);
    if (probeFailures.length) {
      return {
        success: false,
        nothing_created: true,
        phase: 'pre_check',
        _error: `Aborted BEFORE creating anything: could not check the server for existing objects (${probeFailures.length} probe failure(s)): ${probeFailures.join('; ')}`,
        errors: probeFailures,
        _hint: 'The duplicate-check queries against DHIS2 failed, so existing data elements / tracked entity attributes could not be detected. Creating blindly would duplicate metadata that may already exist. Nothing was imported. Verify connectivity/permissions to the DHIS2 instance and retry the SAME create_program call.',
      };
    }
    // Explicit reuse-by-UID entries must point at REAL attributes.
    if (explicitTeaIds.length) {
      const foundIds = new Set((explicitTeaResp?.trackedEntityAttributes || []).map(t => t.id));
      const phantom = explicitTeaIds.filter(t => !foundIds.has(t.id));
      if (phantom.length) {
        return {
          success: false,
          nothing_created: true,
          phase: 'pre_check',
          _error: `Aborted BEFORE creating anything: program_attributes reference ${phantom.length} trackedEntityAttribute UID(s) that do not exist on this server: ${phantom.map(t => `${t.name} [${t.id}]`).join(', ')}.`,
          _hint: 'Only pass id for a TEA you have VERIFIED on this instance (via search_metadata or an "already exists on object <UID>" server error). To create a new attribute instead, drop the id and pass name + value_type.',
        };
      }
    }
  }

  // Apply DE dedup
  for (const resp of deResponses) {
    for (const ex of (resp?.dataElements || [])) {
      const de = allDataElements.find(d => d.name === ex.name && !d._skip);
      if (de) { deUidMap[de.name] = ex.id; de._skip = true; }
    }
  }

  // Apply TEA dedup
  for (const resp of teaResponses) {
    for (const ex of (resp?.trackedEntityAttributes || [])) {
      const tea = allTrackedEntityAttributes.find(t => t.name === ex.name && !t._skip);
      if (tea) { teaUidMap[tea.name] = ex.id; tea._skip = true; }
    }
  }

  // Second pass: case-insensitive reuse for names the exact-match probe missed
  // ("DOB" requested vs existing "DoB"). DHIS2's unique-name constraint is
  // case-SENSITIVE, so a case variant imports "successfully" as a silent
  // near-duplicate — exactly what reuse-by-name exists to prevent (observed
  // 2026-07-10: the first Child-health attempt would have created "DOB"
  // alongside the instance's existing "DoB"). ilike = case-insensitive
  // contains; we only accept full-string case-insensitive equality. Probe
  // errors here are non-fatal — the exact probes above already proved
  // connectivity, and a residual duplicate is still caught by the
  // name-conflict self-healing in postMetadataPayload.
  {
    const ciReuse = async (obj, resource, key, uidMap) => {
      const resp = await safeDhis2Fetch(`${resource}?filter=name:ilike:${encodeURIComponent(obj.name)}&fields=id,name&pageSize=10`);
      if (resp?._error) return;
      const hit = (resp?.[key] || []).find(x => String(x.name || '').toLowerCase() === String(obj.name).toLowerCase());
      if (hit) { uidMap[obj.name] = hit.id; obj._skip = true; }
    };
    await Promise.all([
      ...allDataElements.filter(d => !d._skip).map(d => ciReuse(d, 'dataElements', 'dataElements', deUidMap)),
      ...allTrackedEntityAttributes.filter(t => !t._skip).map(t => ciReuse(t, 'trackedEntityAttributes', 'trackedEntityAttributes', teaUidMap)),
    ]);
  }
  const filteredDataElements = allDataElements.filter(de => !de._skip);
  const filteredTEAs = allTrackedEntityAttributes.filter(tea => !tea._skip);

  // ── Server-side shortName collision resolution ──────────────────────────────
  // DHIS2 has a UNIQUE Postgres constraint on shortName for DataElement,
  // TrackedEntityAttribute, ProgramIndicator, and Program. Even after
  // per-payload dedupe via clampShortName, a freshly built shortName can still
  // collide with a value that already exists in the instance — same name
  // pattern from a prior program, a sample tracker, or another tenant's
  // metadata. Probe for ALL three classes (DE, TEA, Program) in one parallel
  // block — the program shortName lives in a tiny ref object so we don't need
  // to wait for the full program object to be built first.
  const programShortNameRef = {
    id: '__program_pending__',
    shortName: clampShortName(args.program_short_name, args.program_name, null, 'Program'),
  };
  await Promise.all([
    disambiguateShortNamesAgainstServer(filteredDataElements, 'dataElements', 'dataElements'),
    disambiguateShortNamesAgainstServer(filteredTEAs, 'trackedEntityAttributes', 'trackedEntityAttributes'),
    disambiguateShortNamesAgainstServer([programShortNameRef], 'programs', 'programs'),
  ]);

  // ── Stage name collision resolution ─────────────────────────────────────────
  // DHIS2 enforces GLOBAL uniqueness on ProgramStage.name at the DB level, so
  // generic names like "Test" or "Results" routinely collide with leftovers
  // from earlier attempts and the metadata import fails with a raw Postgres
  // "duplicate key value violates unique constraint" 409. Pre-probe each
  // requested stage name and, on conflict, auto-suffix with the program's
  // short name (or a 4-char UID shard if that also collides). The user still
  // sees the original intent; we only disambiguate what DHIS2 requires to be
  // globally unique.
  const programShortForSuffix = (args.program_short_name || args.program_name || '').trim();
  // Per-stage probe chain (original → with program-short suffix → UID shard)
  // is preserved exactly — only the *across-stage* loop is parallelized so a
  // 5-stage program no longer pays 5×RTT for stage probes.
  const resolvedStageNames = await Promise.all(stages.map(async (stage) => {
    let candidate = stage.name;
    let probe = await safeDhis2Fetch(
      `programStages?filter=name:eq:${encodeURIComponent(candidate)}&fields=id&pageSize=1`
    );
    if (probe?.programStages?.length && programShortForSuffix) {
      candidate = `${stage.name} - ${programShortForSuffix}`.substring(0, 230);
      probe = await safeDhis2Fetch(
        `programStages?filter=name:eq:${encodeURIComponent(candidate)}&fields=id&pageSize=1`
      );
    }
    if (probe?.programStages?.length) {
      // Final fallback: short UID suffix — guaranteed unique.
      candidate = `${stage.name} ${generateDhis2Uid().slice(-4)}`.substring(0, 230);
    }
    return candidate;
  }));

  // Build program
  const programUid = generateDhis2Uid();
  const stageObjects = [];
  const stageUids = [];
  const stageRenames = []; // summary for caller: [{original, final}] when renamed

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const stageUid = generateDhis2Uid();
    stageUids.push(stageUid);
    const finalStageName = resolvedStageNames[i];
    if (finalStageName !== stage.name) stageRenames.push({ original: stage.name, final: finalStageName });

    const psdes = (stage.data_elements || []).map((de, j) => ({
      dataElement: { id: deUidMap[de.name] },
      compulsory: de.compulsory || false,
      sortOrder: j + 1,
    }));

    const stageObj = {
      id: stageUid,
      name: finalStageName,
      program: { id: programUid },
      sortOrder: i + 1,
      repeatable: stage.repeatable || false,
      programStageDataElements: psdes,
    };
    if (sharingBlock && applySharingToChildren) {
      stageObj.sharing = sharingBlock;
      stageObj.publicAccess = sharingBlock.public;
    }
    stageObjects.push(stageObj);
  }

  // Apply sharing to data elements, option sets, TEAs — these classes have
  // dataShareable=false in the DHIS2 schema, so the data-access bits must be
  // zeroed out. Program + stages keep the full block above.
  if (sharingBlock && applySharingToChildren) {
    const metaOnly = toMetadataOnlySharing(sharingBlock);
    for (const de of filteredDataElements) {
      de.sharing = metaOnly;
      de.publicAccess = metaOnly.public;
    }
    for (const os of filteredOptionSets) {
      os.sharing = metaOnly;
      os.publicAccess = metaOnly.public;
    }
    for (const tea of filteredTEAs) {
      tea.sharing = metaOnly;
      tea.publicAccess = metaOnly.public;
    }
  }

  const program = {
    id: programUid,
    name: args.program_name,
    // shortName was already probed-and-suffixed above in the parallel block.
    shortName: programShortNameRef.shortName,
    programType: programType,
    organisationUnits: orgUnitIds.map(id => ({ id })),
    programStages: stageUids.map(id => ({ id })),
  };
  if (isTracker && tetId) {
    program.trackedEntityType = { id: tetId };
  }
  if (sharingBlock) {
    program.sharing = sharingBlock;
    program.publicAccess = sharingBlock.public;
  }

  // Add tracked entity attributes to program
  if (Object.keys(teaUidMap).length > 0 && args.program_attributes?.length) {
    program.programTrackedEntityAttributes = args.program_attributes.map((attr, i) => ({
      trackedEntityAttribute: { id: teaUidMap[attr.name || attr.id] },
      mandatory: attr.mandatory || false,
      searchable: attr.searchable || false,
      displayInList: attr.display_in_list !== false, // default true
      sortOrder: i + 1,
    }));
  }

  // Build program rules if provided — uses separate top-level programRuleActions array
  const allProgramRuleVariables = [];
  const allProgramRuleActions = [];
  const allProgramRules = [];
  const prvCreated = {}; // track created variables by name
  let ruleConditionAdvisories = [];
  let ruleConditionRewrites = [];
  let ruleTokenRewrites = [];
  let ruleAutoGuards = [];

  if (args.program_rules?.length) {
    // Pre-flight: lint conditions for known-broken boolean patterns.
    const lintErrors = [];
    for (const rule of args.program_rules) {
      const err = lintProgramRuleCondition(rule.condition, rule.name);
      if (err) lintErrors.push(err);
    }
    if (lintErrors.length) {
      return {
        success: false,
        _error: `Program rule condition lint failed (${lintErrors.length}): ${lintErrors.join(' | ')}`,
        phase: 'lint',
        errors: lintErrors,
        _hint: 'Fix the condition(s) using the suggested canonical form, then retry.',
      };
    }

    // Pre-flight: visibility semantics — hide+mandate contradictions, show/hide
    // twin rules, inverted "Show X" rules. These import fine and break only in
    // front of the data-entry user, so they are hard errors here.
    const semanticErrors = lintRuleVisibilitySemantics(args.program_rules);
    if (semanticErrors.length) {
      return {
        success: false,
        _error: `Program rule semantics lint failed (${semanticErrors.length}): ${semanticErrors.join(' | ')}`,
        phase: 'lint',
        errors: semanticErrors,
        _hint: 'Rewrite the flagged rules as ONE hide rule per target (condition = the HIDE case) and retry the whole create_program. Do not work around this by re-wording rule names.',
      };
    }

    // deName → its inline option set name (needed so option-set PRVs resolve
    // option CODES, and so condition/ASSIGN literals can be name→code mapped).
    const deOptionSetName = {};
    for (const stage of stages) {
      for (const de of (stage.data_elements || [])) {
        if (de.option_set?.name) deOptionSetName[de.name] = de.option_set.name;
      }
    }
    const teaOptionSetName = {};
    for (const attr of (args.program_attributes || [])) {
      if (attr.option_set?.name) teaOptionSetName[attr.name] = attr.option_set.name;
    }

    // Stage references inside rule actions: stage IDs are generated CLIENT-SIDE
    // in this very call, so the model cannot know them — HIDEPROGRAMSTAGE /
    // CREATEEVENT actions reference stages by NAME instead (program_stage_name,
    // or a name passed in program_stage_id). Verified failure mode on play
    // 2.40.12 (2026-07-06): an id-less HIDEPROGRAMSTAGE bounced the whole atomic
    // import with "ProgramRuleAction: ProgramStage cannot be null".
    const stageNameToUid = {};
    for (let si = 0; si < stages.length; si++) {
      stageNameToUid[String(stages[si].name || '').trim().toLowerCase()] = stageUids[si];
      stageNameToUid[String(resolvedStageNames[si] || '').trim().toLowerCase()] = stageUids[si];
    }
    const resolveStageRefForAction = (act) => {
      const ref = act.program_stage_name || act.program_stage_id;
      if (!ref) return null;
      const byName = stageNameToUid[String(ref).trim().toLowerCase()];
      if (byName) return byName;
      if (stageUids.includes(ref)) return ref;
      if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(String(ref))) return ref; // plausible pre-existing UID — pass through
      return undefined; // unresolvable
    };

    // PRV builders keyed by PRV NAME so a token-named variable (e.g. muac →
    // DE "MUAC in cm") and an exact-sanitized-name variable never collide.
    const pushDePrv = (prvName, deName) => {
      if (prvCreated[prvName]) return;
      const prvUid = generateDhis2Uid();
      let sourceStageId = null;
      for (let si = 0; si < stages.length; si++) {
        if ((stages[si].data_elements || []).some(d => d.name === deName)) {
          sourceStageId = stageUids[si]; break;
        }
      }
      allProgramRuleVariables.push({
        id: prvUid,
        name: prvName,
        program: { id: programUid },
        dataElement: { id: deUidMap[deName] },
        programRuleVariableSourceType: 'DATAELEMENT_NEWEST_EVENT_PROGRAM',
        // Option-set DEs MUST resolve the option CODE, matching the code
        // literals the conditions compare against. useCodeForOptionSet=false
        // makes #{var} yield the option NAME → every `== 'CODE'` comparison
        // silently never fires (root cause of the MCH "hidden fields never
        // show" bug, play 2.40.12, 2026-07-07).
        ...(deOptionSetName[deName] ? { useCodeForOptionSet: true } : {}),
        ...(sourceStageId ? { programStage: { id: sourceStageId } } : {}),
      });
      prvCreated[prvName] = prvUid;
    };
    const pushTeaPrv = (prvName, teaName) => {
      if (prvCreated[prvName]) return;
      const prvUid = generateDhis2Uid();
      const teaObj = allTrackedEntityAttributes.find(t => t.name === teaName);
      allProgramRuleVariables.push({
        id: prvUid,
        name: prvName,
        program: { id: programUid },
        trackedEntityAttribute: { id: teaUidMap[teaName] },
        programRuleVariableSourceType: 'TEI_ATTRIBUTE',
        useCodeForOptionSet: !!teaObj?.optionSet,
      });
      prvCreated[prvName] = prvUid;
    };

    const deNamesAll = Object.keys(deUidMap);
    const teaNamesAll = Object.keys(teaUidMap);
    const autoGuardedConditions = [];
    for (const rule of args.program_rules) {
      // Bare `#{x} < n` fires on EMPTY fields (empty coerces to 0) — wrap with
      // d2:hasValue so warnings/hides don't trigger on a blank form.
      {
        const g = autoGuardNumericComparisons(rule.condition);
        if (g.guarded.length) {
          rule.condition = g.condition;
          autoGuardedConditions.push({ rule: rule.name, guarded_variables: g.guarded });
        }
      }
      // Resolve every #{}/A{} token in condition + action data to a DE/TEA
      // (exact sanitized name, then unique prefix; display-name tokens are
      // auto-rewritten to the canonical sanitized form). The PRV is created
      // under the TOKEN name so the expression resolves exactly as written.
      const { bindings, unresolved, rewrites } = resolveRuleTokenBindings(rule, deNamesAll, teaNamesAll);
      if (rewrites.length) ruleTokenRewrites.push({ rule: rule.name, rewrites });
      if (unresolved.length) {
        return {
          success: false,
          phase: 'lint',
          _error: `Program rule "${rule.name}" references unresolved variable(s): ${unresolved.join(', ')} — no data element or attribute in this request matches (exactly or by prefix). Nothing was imported.`,
          unresolved,
          available_variables: deNamesAll.map(n => `#{${sanitizeVariableName(n)}}`),
          available_attributes: teaNamesAll.map(n => `A{${sanitizeVariableName(n)}}`),
          _hint: 'Use #{sanitized_data_element_name} for DEs and A{sanitized_attribute_name} for TEAs, matching a data element/attribute defined in this same call. Fix the token(s) and retry the whole create_program.',
        };
      }
      for (const b of bindings) {
        if (b.kind === 'de') pushDePrv(b.token, b.name); else pushTeaPrv(b.token, b.name);
      }

      // Action-target DEs/TEAs also get a PRV under their sanitized name
      // (pre-existing behavior — harmless and occasionally referenced later).
      for (const act of (rule.actions || [])) {
        if (act.data_element_name && deUidMap[act.data_element_name]) {
          pushDePrv(sanitizeVariableName(act.data_element_name), act.data_element_name);
        }
        if (act.tracked_entity_attribute_name && teaUidMap[act.tracked_entity_attribute_name]) {
          pushTeaPrv(sanitizeVariableName(act.tracked_entity_attribute_name), act.tracked_entity_attribute_name);
        }
      }

      // Build program rule + separate actions (top-level programRuleActions array)
      const prUid = generateDhis2Uid();
      const actionRefs = [];

      for (const act of (rule.actions || [])) {
        const praUid = generateDhis2Uid();
        actionRefs.push({ id: praUid });
        const pra = {
          id: praUid,
          programRuleActionType: act.type,
          programRule: { id: prUid },
        };
        if (act.content) pra.content = act.content;
        if (act.data) pra.data = act.data;
        if (act.data_element_name && deUidMap[act.data_element_name]) {
          pra.dataElement = { id: deUidMap[act.data_element_name] };
        }
        if (act.tracked_entity_attribute_name && teaUidMap[act.tracked_entity_attribute_name]) {
          pra.trackedEntityAttribute = { id: teaUidMap[act.tracked_entity_attribute_name] };
        }
        const stageId = resolveStageRefForAction(act);
        if (stageId) pra.programStage = { id: stageId };
        if (act.program_stage_section_id) pra.programStageSection = { id: act.program_stage_section_id };

        // Fail FAST (before any server call) on stage-targeting actions that
        // could not resolve — the server rejects the whole atomic import with
        // "ProgramRuleAction: ProgramStage cannot be null" otherwise.
        if ((act.type === 'HIDEPROGRAMSTAGE' || act.type === 'CREATEEVENT') && !pra.programStage) {
          return {
            success: false,
            phase: 'lint',
            _error: `Program rule "${rule.name}" has a ${act.type} action whose target stage could not be resolved${act.program_stage_name || act.program_stage_id ? ` from "${act.program_stage_name || act.program_stage_id}"` : ' (no stage reference given)'}. Nothing was imported.`,
            valid_stage_names: stages.map(s => s.name),
            _hint: 'Stage IDs do not exist yet during create_program — reference the stage by NAME via program_stage_name (one of valid_stage_names) and the tool resolves it to the client-generated stage UID. Fix the action and retry the whole create_program.',
          };
        }
        if (act.type === 'HIDESECTION' && !pra.programStageSection) {
          return {
            success: false,
            phase: 'lint',
            _error: `Program rule "${rule.name}" has a HIDESECTION action without a program_stage_section_id — create_program does not create sections, so there is no section to hide. Nothing was imported.`,
            _hint: 'Use HIDEFIELD per data element (or HIDEPROGRAMSTAGE with program_stage_name for a whole stage) instead, or create the sections first and add the rule afterwards via manage_program_rules.',
          };
        }
        allProgramRuleActions.push(pra);
      }

      allProgramRules.push({
        id: prUid,
        name: rule.name,
        description: rule.description || '',
        program: { id: programUid },
        condition: rule.condition,
        programRuleActions: actionRefs, // ID refs only, not full objects
      });
    }

    // ── Option NAME → CODE mapping in conditions and ASSIGN data ──
    // PRVs above resolve option CODES (useCodeForOptionSet=true), so literals
    // must be codes too. Locally built sets carry their derived codes; sets
    // REUSED from the server may have different codes → fetch those.
    {
      const deNameByUid = {};
      for (const [n, uid] of Object.entries(deUidMap)) deNameByUid[uid] = n;
      const teaNameByUid = {};
      for (const [n, uid] of Object.entries(teaUidMap)) teaNameByUid[uid] = n;

      const varToOsKey = new Map();
      for (const prv of allProgramRuleVariables) {
        let osName = null;
        if (prv.dataElement?.id) osName = deOptionSetName[deNameByUid[prv.dataElement.id]] || null;
        else if (prv.trackedEntityAttribute?.id) osName = teaOptionSetName[teaNameByUid[prv.trackedEntityAttribute.id]] || null;
        if (osName) varToOsKey.set(String(prv.name).toLowerCase(), osName);
      }
      const targetToOsKey = new Map();
      for (const pra of allProgramRuleActions) {
        const deId = pra.dataElement?.id;
        const teaId = pra.trackedEntityAttribute?.id;
        const osName = (deId && deOptionSetName[deNameByUid[deId]]) || (teaId && teaOptionSetName[teaNameByUid[teaId]]) || null;
        if (osName) targetToOsKey.set(deId || teaId, osName);
      }

      const neededOsNames = new Set([...varToOsKey.values(), ...targetToOsKey.values()]);
      const optionsByOsKey = new Map();
      const reusedToFetch = [];
      for (const osName of neededOsNames) {
        if (reusedOptionSetNames.has(osName)) reusedToFetch.push(osName);
        else if (optionSetOptionsByName[osName]) optionsByOsKey.set(osName, optionSetOptionsByName[osName]);
      }
      if (reusedToFetch.length) {
        const resps = await Promise.all(reusedToFetch.map(n =>
          safeDhis2Fetch(`optionSets/${optionSetUidMap[n]}?fields=id,options[name,code]`)));
        for (let i = 0; i < reusedToFetch.length; i++) {
          const o = resps[i];
          if (o && !o._error) optionsByOsKey.set(reusedToFetch[i], (o.options || []).map(x => ({ name: x.name, code: x.code })));
        }
      }

      const mapped = rewriteOptionLiteralsGeneric({
        rules: allProgramRules,
        actions: allProgramRuleActions,
        varToOsKey,
        targetToOsKey,
        optionsByOsKey,
      });
      ruleConditionAdvisories = mapped.advisories;
      ruleConditionRewrites = mapped.rewrites;
    }
    ruleAutoGuards = autoGuardedConditions;
  }

  // Build the atomic payload (Batch 1: options + optionSets + TEAs + DEs + program + stages)
  const payload = {};
  if (finalOptions.length) payload.options = finalOptions;
  if (filteredOptionSets.length) payload.optionSets = filteredOptionSets;
  if (filteredTEAs.length) payload.trackedEntityAttributes = filteredTEAs;
  if (filteredDataElements.length) payload.dataElements = filteredDataElements;
  payload.programs = [program];
  if (stageObjects.length) payload.programStages = stageObjects;
  if (allProgramRuleVariables.length) payload.programRuleVariables = allProgramRuleVariables;
  if (allProgramRuleActions.length) payload.programRuleActions = allProgramRuleActions;
  if (allProgramRules.length) payload.programRules = allProgramRules;

  let result = await postMetadataPayload(payload, args.dry_run_only);

  // Defensive fallback — if DHIS2 still complains "Data sharing is not enabled for X"
  // for any klass we didn't know about (future-proofing for schema changes or custom
  // dataShareable=false types), downgrade every non-Program/non-ProgramStage object's
  // sharing to metadata-only and retry once. Program + ProgramStage keep the full
  // block since those ARE dataShareable.
  const dataSharingErrors = (result.errors || []).filter(e => /Data sharing is not enabled/i.test(e));
  if (!result.success && dataSharingErrors.length && sharingBlock) {
    const metaOnly = toMetadataOnlySharing(sharingBlock);
    for (const arr of [filteredOptionSets, filteredDataElements, filteredTEAs]) {
      for (const obj of arr) { obj.sharing = metaOnly; obj.publicAccess = metaOnly.public; }
    }
    const retryPayload = { ...payload };
    if (filteredOptionSets.length) retryPayload.optionSets = filteredOptionSets;
    if (filteredDataElements.length) retryPayload.dataElements = filteredDataElements;
    if (filteredTEAs.length) retryPayload.trackedEntityAttributes = filteredTEAs;
    const retry = await postMetadataPayload(retryPayload, args.dry_run_only);
    if (retry.success) {
      retry._recovered_from = `Retried after ${dataSharingErrors.length} "Data sharing not enabled" error(s); downgraded DE/OS/TEA sharing to metadata-only.`;
      result = retry;
    }
  }

  // If postMetadataPayload self-healed a name conflict by reusing an existing
  // object, our local name→ID maps still hold the discarded pre-generated UID.
  // Sync them so the summary / returned ID handles point at the REAL objects.
  if (result?._name_conflict_remaps?.length) {
    for (const r of result._name_conflict_remaps) {
      for (const map of [deUidMap, teaUidMap, optionSetUidMap]) {
        for (const [n, id] of Object.entries(map)) { if (id === r.from) map[n] = r.to; }
      }
    }
  }
  // Stage objects renamed by the name-conflict autofix live in payload.programStages
  // (same references as stageObjects) — mirror any rename into the summary names.
  if (result?._name_conflict_renames?.length) {
    for (let i = 0; i < stageObjects.length; i++) {
      if (stageObjects[i]?.name && stageObjects[i].name !== resolvedStageNames[i]) {
        stageRenames.push({ original: resolvedStageNames[i], final: stageObjects[i].name });
        resolvedStageNames[i] = stageObjects[i].name;
      }
    }
  }

  // Create program indicators as follow-up (they need stage UIDs from the created program)
  let indicatorResults = [];
  if (args.program_indicators?.length && result.success && !args.dry_run_only) {
    const piSharing = sharingBlock && applySharingToChildren ? toMetadataOnlySharing(sharingBlock) : null;
    const seenPIShortNames = new Set();
    const indicators = args.program_indicators.map(pi => {
      const piUid = generateDhis2Uid();
      const obj = {
        id: piUid,
        name: pi.name,
        shortName: clampShortName(pi.short_name, pi.name, seenPIShortNames, 'Indicator'),
        program: { id: programUid },
        analyticsType: pi.analytics_type || 'EVENT',
        aggregationType: pi.aggregation_type || 'COUNT',
        expression: pi.expression || 'V{event_count}',
        filter: pi.filter || '',
        description: pi.description || '',
        // Boundary target must match the analytics type — ENROLLMENT PIs with
        // EVENT_DATE boundaries over-count and break d2:count filters (see
        // _buildAndPostProgramIndicator for the verified failure mode).
        analyticsPeriodBoundaries: (pi.analytics_type === 'ENROLLMENT'
          ? [
            { boundaryTarget: 'ENROLLMENT_DATE', analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' },
            { boundaryTarget: 'ENROLLMENT_DATE', analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' },
          ]
          : [
            { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' },
            { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' },
          ]),
      };
      if (piSharing) { obj.sharing = piSharing; obj.publicAccess = piSharing.public; }
      return obj;
    });

    // ProgramIndicators also have a UNIQUE shortName constraint server-side.
    await disambiguateShortNamesAgainstServer(indicators, 'programIndicators', 'programIndicators');

    // NAME is globally unique too — probe in one batched query and auto-suffix
    // collisions with the program's short name (or a UID shard), mirroring the
    // stage-name convention. Without this, re-running a scenario whose PIs
    // already exist (even on another program) fails the whole follow-up POST.
    {
      const piNames = indicators.map(p => p.name);
      const nameBatches = [];
      for (let i = 0; i < piNames.length; i += 50) nameBatches.push(piNames.slice(i, i + 50));
      const probeResps = await Promise.all(nameBatches.map(batch => {
        const nameFilter = batch.map(n => encodeURIComponent(n)).join(',');
        return safeDhis2Fetch(`programIndicators?filter=name:in:[${nameFilter}]&fields=id,name&pageSize=50`);
      }));
      const taken = new Set();
      for (const resp of probeResps) for (const ex of (resp?.programIndicators || [])) taken.add(ex.name);
      if (taken.size) {
        const piRenames = [];
        for (const p of indicators) {
          if (!taken.has(p.name)) continue;
          let candidate = programShortForSuffix ? `${p.name} - ${programShortForSuffix}`.substring(0, 230) : '';
          if (!candidate || taken.has(candidate)) candidate = `${p.name} ${generateDhis2Uid().slice(-4)}`.substring(0, 230);
          piRenames.push({ original: p.name, final: candidate });
          p.name = candidate;
        }
        if (piRenames.length) result._indicator_renames = piRenames;
      }
    }

    const piPayload = { programIndicators: indicators };
    const piResult = await postMetadataPayload(piPayload, false);
    indicatorResults = indicators.map(pi => ({ id: pi.id, name: pi.name }));
    if (!piResult.success) {
      result._indicator_warning = `Program created but indicators failed: ${piResult._error || JSON.stringify(piResult)}`;
    }
  }

  // Build summary
  const summary = {
    program: { id: programUid, name: args.program_name, type: programType },
    stages: stages.map((s, i) => ({
      id: stageUids[i],
      name: resolvedStageNames[i],
      originalName: s.name,
      dataElements: (s.data_elements || []).length,
    })),
    stageRenames: stageRenames.length ? stageRenames : undefined,
    trackedEntityAttributes: Object.entries(teaUidMap).map(([name, id]) => ({ name, id })),
    dataElements: Object.entries(deUidMap).map(([name, id]) => ({ name, id })),
    optionSets: Object.entries(optionSetUidMap).map(([name, id]) => ({ name, id })),
    programRules: allProgramRules.map(r => ({ id: r.id, name: r.name })),
    programIndicators: indicatorResults,
    orgUnits: orgUnitIds,
    ...(ruleAutoGuards.length ? { auto_guarded_conditions: ruleAutoGuards } : {}),
    ...(ruleConditionRewrites.length ? { condition_option_rewrites: ruleConditionRewrites } : {}),
    ...(ruleConditionAdvisories.length ? { condition_option_advisories: ruleConditionAdvisories } : {}),
    ...(ruleTokenRewrites.length ? { rule_token_rewrites: ruleTokenRewrites } : {}),
  };

  // Record successful program create in the per-turn registry so a duplicate
  // call from the model in the same turn is detected as an idempotent replay
  // by the collision probe above instead of being reported as a hard failure.
  // Only record on a real successful import (not dry runs or failed imports).
  const importOk = result && (result.success === true) && result.phase === 'import';
  if (importOk) {
    recordRecentCreation('program', args.program_name, programUid, summary);
  }

  // Top-level ID handles for multi-step orchestration. The full detail stays in
  // `summary`, but the very next step of a "create program → add rules/indicators
  // → build a dashboard/map" chain needs the program + stage + DE UIDs without
  // digging into nested summary shapes. Mirror the top-level id exposure that
  // manage_program_indicators / manage_dashboards / manage_maps already provide,
  // so the model reliably reuses REAL UIDs (never invents them). name→id maps let
  // it target a stage/DE/attribute by the name it just asked for.
  const stage_ids = {};
  summary.stages.forEach((s) => { stage_ids[s.name] = s.id; });

  // On FAILURE, never expose the pre-generated ID handles: the import is atomic,
  // so NONE of those objects exist. Returning program_id alongside the error
  // caused the model to call add_program_rules against a phantom program (404
  // "Program OuyEAzGOp5i could not be found" — observed 2026-07-06 on the MCH
  // scenario after a validation failure).
  if (!result || result.success !== true) {
    const dupHint = (result?.errors || []).some(e => /already exists on object/i.test(String(e)))
      ? ' ⚠ For every "already exists on object <UID>" error: that object ALREADY EXISTS on the server — you MUST NOT recreate it, and you MUST NOT dodge the error by inventing a name variant (that creates near-duplicate metadata). Reuse it instead: for attributes pass { id: "<the existing UID from the error>" } in program_attributes; for data elements / option sets keep the EXACT existing name and the tool reuses them automatically.'
      : '';
    return {
      ...result,
      nothing_created: true,
      _hint: `${result?._hint ? result._hint + ' ' : ''}The import is ATOMIC and it failed — NOTHING was created (no program, stages, data elements, or rules exist on the server). Do NOT reuse any IDs from this attempt and do NOT call add_program_rules/add_stage for this program. Fix the reported error and re-issue the ENTIRE create_program call.${dupHint}`,
    };
  }

  return {
    ...result,
    program_id: programUid,
    stage_ids,
    data_element_ids: { ...deUidMap },
    tracked_entity_attribute_ids: { ...teaUidMap },
    option_set_ids: { ...optionSetUidMap },
    summary,
  };
}

async function addStageToProgram(args, defaultCatComboId) {
  if (!args.program_id) return { _error: 'Missing program_id for add_stage' };
  if (!args.stage) return { _error: 'Missing stage object for add_stage' };

  const stage = args.stage;

  // Get existing program to determine sort order
  const progResp = await safeDhis2Fetch(`programs/${args.program_id}?fields=id,programStages[id,sortOrder]`);
  if (progResp._error) return { _error: `Could not load program ${args.program_id}: ${progResp._error}` };
  const existingStageCount = progResp?.programStages?.length || 0;

  const allOptions = [];
  const allOptionSets = [];
  const allDataElements = [];
  const optionSetUidMap = {};
  const deUidMap = {};
  const seenDEShortNames = new Set();

  for (const de of (stage.data_elements || [])) {
    if (de.option_set && de.option_set.name && de.option_set.options?.length) {
      if (!optionSetUidMap[de.option_set.name]) {
        const { optionSet, options, osUid } = buildOptionSetAndOptions(de.option_set, de.value_type);
        allOptions.push(...options);
        allOptionSets.push(optionSet);
        optionSetUidMap[de.option_set.name] = osUid;
      }
    }
    if (!deUidMap[de.name]) {
      const { elem, uid } = buildDataElement(de, defaultCatComboId, optionSetUidMap, seenDEShortNames);
      allDataElements.push(elem);
      deUidMap[de.name] = uid;
    }
  }

  // Pre-probe DHIS2 for shortName collisions on these new DEs.
  await disambiguateShortNamesAgainstServer(allDataElements, 'dataElements', 'dataElements');

  const stageUid = generateDhis2Uid();
  const psdes = (stage.data_elements || []).map((de, j) => ({
    dataElement: { id: deUidMap[de.name] },
    compulsory: de.compulsory || false,
    sortOrder: j + 1,
  }));

  const stageObj = {
    id: stageUid,
    name: stage.name,
    program: { id: args.program_id },
    sortOrder: existingStageCount + 1,
    repeatable: stage.repeatable || false,
    programStageDataElements: psdes,
  };

  const payload = {};
  if (allOptions.length) payload.options = allOptions;
  if (allOptionSets.length) payload.optionSets = allOptionSets;
  if (allDataElements.length) payload.dataElements = allDataElements;
  payload.programStages = [stageObj];

  const result = await postMetadataPayload(payload, args.dry_run_only);

  return {
    ...result,
    summary: {
      stage: { id: stageUid, name: stage.name, dataElements: (stage.data_elements || []).length },
      program_id: args.program_id,
      dataElements: Object.entries(deUidMap).map(([name, id]) => ({ name, id })),
      optionSets: Object.entries(optionSetUidMap).map(([name, id]) => ({ name, id })),
    },
  };
}

async function addDataElementsToExistingStage(args, defaultCatComboId) {
  if (!args.stage_id) return { _error: 'Missing stage_id for add_data_elements_to_stage' };
  const hasExistingIds = args.data_element_ids?.length > 0;
  const hasNewDEs = args.data_elements?.length > 0;
  if (!hasExistingIds && !hasNewDEs) {
    return { _error: 'Provide data_element_ids (existing DE IDs) or data_elements (new DE definitions) for add_data_elements_to_stage' };
  }

  // 1. Fetch the full current stage — we need name + program for a valid PUT
  const stageResp = await safeDhis2Fetch(
    `programStages/${args.stage_id}?fields=id,name,program[id],sortOrder,repeatable,programStageDataElements[id,dataElement[id],compulsory,allowProvidedElsewhere,sortOrder,displayInReports,allowFutureDate,renderOptionsAsRadio,skipSynchronization,skipAnalytics]`
  );
  if (stageResp._error) return { _error: `Could not load stage ${args.stage_id}: ${stageResp._error}` };
  if (!stageResp.name) return { _error: `Stage ${args.stage_id} is missing required 'name' field` };
  if (!stageResp.program?.id) return { _error: `Stage ${args.stage_id} has no associated program` };

  const existing = stageResp.programStageDataElements || [];
  const existingIds = new Set(existing.map(psde => psde.dataElement?.id).filter(Boolean));
  const maxSortOrder = existing.reduce((m, e) => Math.max(m, e.sortOrder || 0), 0);
  let sortCounter = maxSortOrder;

  // Preserve the existing elements as-is in the PUT body
  const updatedPsdes = existing.map(psde => ({
    id: psde.id,
    dataElement: { id: psde.dataElement.id },
    compulsory: psde.compulsory || false,
    allowProvidedElsewhere: psde.allowProvidedElsewhere || false,
    sortOrder: psde.sortOrder,
    displayInReports: psde.displayInReports || false,
    allowFutureDate: psde.allowFutureDate || false,
    renderOptionsAsRadio: psde.renderOptionsAsRadio || false,
    skipSynchronization: psde.skipSynchronization || false,
    skipAnalytics: psde.skipAnalytics || false,
  }));

  const addedElements = [];

  // 2. Create new DEs if requested, then queue them for the stage
  if (hasNewDEs) {
    const allOptions = [];
    const allOptionSets = [];
    const allNewDEs = [];
    const optionSetUidMap = {};
    const deUidMap = {};
    const seenDEShortNames = new Set();

    for (const de of args.data_elements) {
      if (de.option_set && de.option_set.name && de.option_set.options?.length) {
        if (!optionSetUidMap[de.option_set.name]) {
          const { optionSet, options, osUid } = buildOptionSetAndOptions(de.option_set, de.value_type);
          allOptions.push(...options);
          allOptionSets.push(optionSet);
          optionSetUidMap[de.option_set.name] = osUid;
        }
      }
      const { elem, uid } = buildDataElement(de, defaultCatComboId, optionSetUidMap, seenDEShortNames);
      allNewDEs.push(elem);
      deUidMap[de.name] = uid;
    }

    // Pre-probe DHIS2 for shortName collisions on these new DEs.
    await disambiguateShortNamesAgainstServer(allNewDEs, 'dataElements', 'dataElements');

    // Import new DEs first via metadata endpoint
    const dePayload = {};
    if (allOptions.length) dePayload.options = allOptions;
    if (allOptionSets.length) dePayload.optionSets = allOptionSets;
    dePayload.dataElements = allNewDEs;
    const deResult = await postMetadataPayload(dePayload, args.dry_run_only);
    if (!deResult.success) return deResult;

    for (const de of args.data_elements) {
      const deId = deUidMap[de.name];
      if (!existingIds.has(deId)) {
        sortCounter++;
        updatedPsdes.push({
          dataElement: { id: deId },
          compulsory: de.compulsory || false,
          allowProvidedElsewhere: false,
          sortOrder: sortCounter,
          displayInReports: false,
          allowFutureDate: false,
          renderOptionsAsRadio: false,
          skipSynchronization: false,
          skipAnalytics: false,
        });
        addedElements.push({ id: deId, name: de.name });
      }
    }
  }

  // 3. Add existing DE IDs (skip duplicates already in the stage)
  if (hasExistingIds) {
    for (const deId of args.data_element_ids) {
      if (!existingIds.has(deId)) {
        sortCounter++;
        updatedPsdes.push({
          dataElement: { id: deId },
          compulsory: false,
          allowProvidedElsewhere: false,
          sortOrder: sortCounter,
          displayInReports: false,
          allowFutureDate: false,
          renderOptionsAsRadio: false,
          skipSynchronization: false,
          skipAnalytics: false,
        });
        addedElements.push({ id: deId });
      } else {
        addedElements.push({ id: deId, note: 'already_in_stage' });
      }
    }
  }

  if (args.dry_run_only) {
    return {
      success: true, phase: 'dry_run',
      message: 'Dry run: no changes made.',
      stage_id: args.stage_id, stage_name: stageResp.name,
      would_add: addedElements.filter(e => !e.note),
    };
  }

  // 4. PUT the complete stage back with name + program + full programStageDataElements
  // DHIS2 PUT on programStages requires 'name' and 'program' — sending only
  // programStageDataElements causes 409 "Missing required property name".
  const stageUpdate = {
    name: stageResp.name,
    program: { id: stageResp.program.id },
    sortOrder: stageResp.sortOrder,
    repeatable: stageResp.repeatable || false,
    programStageDataElements: updatedPsdes,
  };

  const putResp = await safeDhis2Fetch(`programStages/${args.stage_id}`, {
    method: 'PUT',
    body: stageUpdate,
  });
  if (putResp._error) return { _error: `Failed to update stage: ${putResp._error}` };

  // Surface any DHIS2 import-level errors from the PUT response
  const putStatus = putResp?.status || putResp?.response?.status;
  if (putStatus === 'ERROR') {
    const typeReports = putResp?.response?.typeReports || [];
    const errors = [];
    for (const tr of typeReports) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) errors.push(er.message);
      }
    }
    return { _error: `Stage update failed: ${putResp?.message || 'Unknown error'}`, errors };
  }

  return {
    success: true,
    stage_id: args.stage_id,
    stage_name: stageResp.name,
    added_elements: addedElements,
    total_elements: updatedPsdes.length,
  };
}
