/*
 * DHIS2 AI Assistant background module: program metadata, notifications, rules, indicators, and architecture operations.
 * Loaded synchronously by background.js with importScripts(); classic-script
 * global bindings intentionally preserve the original service-worker runtime.
 */

// ── manage_metadata: remove from stage, delete, check references ──────────
async function executeManageMetadata(args) {
  const action = args.action;

  // ── remove_from_stage: Remove data element(s) from a program stage ──
  if (action === 'remove_from_stage') {
    const _gate = requireWriteAuth('manage_metadata', 'remove_from_stage', { stage_id: args.stage_id });
    if (_gate) return _gate;
    if (!args.stage_id) return { _error: 'stage_id required for remove_from_stage' };
    if (!args.data_element_ids?.length) return { _error: 'data_element_ids (array of DE UIDs) required for remove_from_stage' };

    // Fetch the full current stage — we need name + program for a valid PUT
    const stageResp = await safeDhis2Fetch(
      `programStages/${args.stage_id}?fields=id,name,program[id],sortOrder,repeatable,programStageDataElements[id,dataElement[id,name],compulsory,allowProvidedElsewhere,sortOrder,displayInReports,allowFutureDate,renderOptionsAsRadio,skipSynchronization,skipAnalytics]`
    );
    if (stageResp._error) return { _error: `Could not load stage ${args.stage_id}: ${stageResp._error}` };
    if (!stageResp.name || !stageResp.program?.id) return { _error: `Stage ${args.stage_id} is missing required 'name' or program reference` };

    const removeSet = new Set(args.data_element_ids);
    const existing = stageResp.programStageDataElements || [];
    const removed = [];
    const kept = [];

    for (const psde of existing) {
      const deId = psde.dataElement?.id;
      if (removeSet.has(deId)) {
        removed.push({ id: deId, name: psde.dataElement?.name || deId });
      } else {
        kept.push({
          id: psde.id,
          dataElement: { id: deId },
          compulsory: psde.compulsory || false,
          allowProvidedElsewhere: psde.allowProvidedElsewhere || false,
          sortOrder: psde.sortOrder,
          displayInReports: psde.displayInReports || false,
          allowFutureDate: psde.allowFutureDate || false,
          renderOptionsAsRadio: psde.renderOptionsAsRadio || false,
          skipSynchronization: psde.skipSynchronization || false,
          skipAnalytics: psde.skipAnalytics || false,
        });
      }
    }

    if (removed.length === 0) {
      return {
        _error: `None of the specified data elements were found in stage "${stageResp.name}"`,
        stage_elements: existing.map(e => ({ id: e.dataElement?.id, name: e.dataElement?.name })),
      };
    }

    // Snapshot the stage BEFORE we mutate it.
    const backup = await ensureBackupOrBail(
      { operation: 'remove_from_stage', tool: 'manage_metadata', action: 'remove_from_stage', reason: `Removing ${removed.length} data element(s) from stage ${stageResp.name}` },
      [{ object_type: 'programStages', object_id: args.stage_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    // PUT the complete stage back without the removed elements
    const stageUpdate = {
      name: stageResp.name,
      program: { id: stageResp.program.id },
      sortOrder: stageResp.sortOrder,
      repeatable: stageResp.repeatable || false,
      programStageDataElements: kept,
    };

    const putResp = await safeDhis2Fetch(`programStages/${args.stage_id}`, {
      method: 'PUT',
      body: stageUpdate,
    });
    if (putResp._error) return { _error: `Failed to update stage: ${putResp._error}`, backup: backup.block };

    // Check for import-level errors
    const putStatus = putResp?.status || putResp?.response?.status;
    if (putStatus === 'ERROR') {
      const errors = [];
      for (const tr of (putResp?.response?.typeReports || [])) {
        for (const or of (tr.objectReports || [])) {
          for (const er of (or.errorReports || [])) errors.push(er.message);
        }
      }
      return { _error: `Stage update failed: ${putResp?.message || 'Unknown error'}`, errors, backup: backup.block };
    }

    return {
      success: true,
      action: 'remove_from_stage',
      stage_id: args.stage_id,
      stage_name: stageResp.name,
      removed_elements: removed,
      remaining_elements: kept.length,
      backup: backup.block,
    };
  }

  // ── check_references: Inspect dependencies of a metadata object ──
  if (action === 'check_references') {
    if (!args.object_type || !args.object_id) return { _error: 'object_type and object_id required for check_references' };
    return await checkMetadataReferences(args.object_type, args.object_id);
  }

  // ── delete: Delete a metadata object with smart reference checking ──
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_metadata', 'delete', { object_type: args.object_type, object_id: args.object_id });
    if (_gate) return _gate;
    if (!args.object_type || !args.object_id) return { _error: 'object_type and object_id required for delete' };

    // Verify the object exists first
    const objResp = await safeDhis2Fetch(`${args.object_type}/${args.object_id}?fields=id,name,displayName`);
    if (objResp._error) {
      if (objResp._status === 404) return { success: true, message: 'Object does not exist (already deleted or never existed).' };
      return { _error: `Could not verify object: ${objResp._error}` };
    }
    const objName = objResp.displayName || objResp.name || args.object_id;

    // Check references before attempting deletion
    const refsResult = await checkMetadataReferences(args.object_type, args.object_id);
    if (refsResult.has_references) {
      return {
        _error: `Cannot delete ${objName} (${args.object_type}/${args.object_id}) because it has active references that must be removed first.`,
        references: refsResult.references,
        _hint: buildDeletionHint(args.object_type, args.object_id, refsResult.references),
      };
    }

    // Snapshot the object BEFORE attempting deletion. The reference-check
    // above filters most failure cases; if the delete still fails, the
    // backup is preserved so the user can inspect what would have been lost.
    const backup = await ensureBackupOrBail(
      { operation: 'delete', tool: 'manage_metadata', action: 'delete', reason: `Deleting ${args.object_type}/${args.object_id} (${objName})` },
      [{ object_type: args.object_type, object_id: args.object_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    // Attempt deletion via POST /api/metadata?importStrategy=DELETE
    const deletePayload = { [args.object_type]: [{ id: args.object_id }] };
    const delResp = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', {
      method: 'POST',
      body: deletePayload,
    });

    if (delResp._error) {
      return { _error: `Deletion failed: ${delResp._error}`, backup: backup.block };
    }

    const stats = delResp?.response?.stats || delResp?.stats || {};
    const typeReports = delResp?.response?.typeReports || [];

    if (stats.deleted >= 1) {
      return {
        success: true,
        deleted: { type: args.object_type, id: args.object_id, name: objName },
        message: `Successfully deleted ${objName}.`,
        backup: backup.block,
      };
    }

    const errorMessages = [];
    for (const tr of typeReports) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) {
          errorMessages.push(er.message);
        }
      }
    }

    if (errorMessages.length > 0) {
      const hasEventData = errorMessages.some(e => /associated with another object.*Event/i.test(e));
      return {
        _error: `Cannot delete ${objName}: ${errorMessages.join('; ')}`,
        error_details: errorMessages,
        _hint: hasEventData
          ? `This data element has been used in submitted events — DHIS2 prevents deletion to preserve data integrity. Options:\n(a) Keep as unused metadata (recommended — preserves historical data)\n(b) Remove all event data values referencing this DE first, then retry deletion`
          : 'Resolve the reported conflicts above, then retry deletion.',
        backup: backup.block,
      };
    }

    return {
      _error: `Deletion of ${objName} was not applied. DHIS2 import stats: ${JSON.stringify(stats)}`,
      _hint: 'The object may have hidden dependencies. Check the DHIS2 server logs for details.',
      backup: backup.block,
    };
  }

  // ── update_program_org_units: set/add/remove program organisation units ──
  if (action === 'update_program_org_units') {
    const _gate = requireWriteAuth('manage_metadata', 'update_program_org_units', { program_id: args.program_id || args.object_id });
    if (_gate) return _gate;
    const programId = args.program_id || args.object_id;
    if (!programId) return { _error: 'program_id or object_id required for update_program_org_units' };
    if (!Array.isArray(args.org_unit_ids)) return { _error: 'org_unit_ids array required for update_program_org_units' };

    const mergeMode = ['replace', 'add', 'remove'].includes(args.merge_mode) ? args.merge_mode : 'replace';
    const requestedIds = [...new Set(args.org_unit_ids.filter(Boolean))];

    const progResp = await safeDhis2Fetch(
      `programs/${programId}?fields=id,displayName,name,shortName,programType,organisationUnits[id,displayName]`
    );
    if (progResp._error) return { _error: `Could not fetch program ${programId}: ${progResp._error}` };

    const currentOrgUnits = Array.isArray(progResp.organisationUnits) ? progResp.organisationUnits : [];
    const currentIds = currentOrgUnits.map(ou => ou.id).filter(Boolean);
    let nextIds;
    if (mergeMode === 'add') {
      nextIds = [...new Set([...currentIds, ...requestedIds])];
    } else if (mergeMode === 'remove') {
      const removeSet = new Set(requestedIds);
      nextIds = currentIds.filter(id => !removeSet.has(id));
    } else {
      nextIds = requestedIds;
    }

    const payload = {
      programs: [{
        id: progResp.id,
        name: progResp.name || progResp.displayName || progResp.id,
        shortName: progResp.shortName || progResp.name || progResp.displayName || progResp.id,
        programType: progResp.programType,
        organisationUnits: nextIds.map(id => ({ id })),
      }],
    };

    // Skip backup on a pure dry-run (nothing will be committed).
    let backup = { ok: true, block: null, skipped: false };
    if (!args.dry_run_only) {
      backup = await ensureBackupOrBail(
        { operation: 'update_program_org_units', tool: 'manage_metadata', action: 'update_program_org_units', reason: `merge_mode=${mergeMode} on ${requestedIds.length} OU(s)` },
        [{ object_type: 'programs', object_id: programId, role: 'primary' }],
        args
      );
      if (!backup.ok) return backup.error;
    }

    const result = await postMetadataPayload(payload, args.dry_run_only);
    if (!result.success) return { ...result, backup: backup.block };

    if (args.dry_run_only) {
      return {
        ...result,
        action: 'update_program_org_units',
        program_id: progResp.id,
        program_name: progResp.displayName || progResp.name || progResp.id,
        merge_mode: mergeMode,
        current_org_units: currentIds.length,
        requested_org_units: requestedIds.length,
        resulting_org_units: nextIds.length,
      };
    }

    const verifyResp = await safeDhis2Fetch(
      `programs/${programId}?fields=id,displayName,organisationUnits[id,displayName]`
    );
    if (verifyResp._error) {
      return {
        success: true,
        action: 'update_program_org_units',
        program_id: progResp.id,
        program_name: progResp.displayName || progResp.name || progResp.id,
        merge_mode: mergeMode,
        current_org_units: currentIds.length,
        resulting_org_units: nextIds.length,
        _warning: `Update committed, but verification fetch failed: ${verifyResp._error}`,
        backup: backup.block,
      };
    }

    const verifiedOrgUnits = Array.isArray(verifyResp.organisationUnits) ? verifyResp.organisationUnits : [];
    const verifiedMap = new Map(verifiedOrgUnits.map(ou => [ou.id, ou.displayName || ou.id]));
    const verifiedIds = verifiedOrgUnits.map(ou => ou.id).filter(Boolean);
    const currentSet = new Set(currentIds);
    const verifiedSet = new Set(verifiedIds);

    return {
      success: true,
      action: 'update_program_org_units',
      program_id: verifyResp.id,
      program_name: verifyResp.displayName || progResp.displayName || progResp.name || progResp.id,
      merge_mode: mergeMode,
      previous_org_units: currentIds.length,
      resulting_org_units: verifiedIds.length,
      added_org_units: verifiedIds
        .filter(id => !currentSet.has(id))
        .slice(0, 50)
        .map(id => ({ id, name: verifiedMap.get(id) || id })),
      removed_org_units: currentOrgUnits
        .filter(ou => !verifiedSet.has(ou.id))
        .slice(0, 50)
        .map(ou => ({ id: ou.id, name: ou.displayName || ou.id })),
      org_unit_sample: verifiedOrgUnits
        .slice(0, 20)
        .map(ou => ({ id: ou.id, name: ou.displayName || ou.id })),
      _note: 'Program organisationUnits control where the program is assigned/available in Capture and Tracker. This is separate from sharing/publicAccess.',
      backup: backup.block,
    };
  }

  // ── update_sharing: Update sharing/access settings via the DHIS2 sharing API ──
  if (action === 'update_sharing') {
    const _gate = requireWriteAuth('manage_metadata', 'update_sharing', { object_type: args.object_type, object_id: args.object_id });
    if (_gate) return _gate;
    if (!args.object_type || !args.object_id) return { _error: 'object_type and object_id required for update_sharing' };

    // Map plural API type names to singular form for the sharing endpoint
    const sharingTypeMap = {
      programs: 'program', dataSets: 'dataSet', dataElements: 'dataElement',
      indicators: 'indicator', optionSets: 'optionSet',
      trackedEntityAttributes: 'trackedEntityAttribute',
      programStages: 'programStage', categoryOptions: 'categoryOption',
      categories: 'category', categoryCombos: 'categoryCombo',
      dataElementGroups: 'dataElementGroup', indicatorGroups: 'indicatorGroup',
      dashboards: 'dashboard', visualizations: 'visualization',
      maps: 'map', eventReports: 'eventReport', eventCharts: 'eventChart',
      options: 'option',
    };
    const singularType = sharingTypeMap[args.object_type] || args.object_type;

    // 1. Fetch current sharing settings
    const currentResp = await safeDhis2Fetch(`sharing?type=${singularType}&id=${args.object_id}`);
    if (currentResp._error) return { _error: `Could not fetch current sharing for ${args.object_type}/${args.object_id}: ${currentResp._error}` };
    const obj = currentResp.object;
    if (!obj) return { _error: `No sharing object returned for ${args.object_type}/${args.object_id}` };

    const previousPublicAccess = obj.publicAccess;

    // Snapshot the object BEFORE we change sharing.
    const backup = await ensureBackupOrBail(
      { operation: 'update_sharing', tool: 'manage_metadata', action: 'update_sharing', reason: `Sharing update on ${args.object_type}/${args.object_id}` },
      [{ object_type: args.object_type, object_id: args.object_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    // 2. Apply requested changes (merge with existing). Every access string is
    // pushed through normalizeAccessString so a malformed input ("r--------",
    // "rwx-----", "rwrw") never reaches DHIS2 — which rejects the whole PUT
    // with "Invalid access string" and leaves the object's prior sharing intact
    // but wedges any caller waiting on success.
    if (args.public_access !== undefined) {
      obj.publicAccess = normalizeAccessString(args.public_access, obj.publicAccess || 'rw------');
    }
    if (Array.isArray(args.user_group_accesses)) {
      obj.userGroupAccesses = args.user_group_accesses.map(e => ({
        ...e,
        access: normalizeAccessString(e.access, 'rw------'),
      }));
    }
    if (Array.isArray(args.user_accesses)) {
      obj.userAccesses = args.user_accesses.map(e => ({
        ...e,
        access: normalizeAccessString(e.access, 'rw------'),
      }));
    }

    // 3. PUT to the DHIS2 sharing API
    const putResp = await safeDhis2Fetch(`sharing?type=${singularType}&id=${args.object_id}`, {
      method: 'PUT',
      body: { object: obj },
    });
    if (putResp._error) return { _error: `Failed to update sharing: ${putResp._error}`, backup: backup.block };

    // 4. Verify the update
    const verifyResp = await safeDhis2Fetch(`sharing?type=${singularType}&id=${args.object_id}`);
    const verified = verifyResp.object || {};

    return {
      success: true,
      action: 'update_sharing',
      object_type: args.object_type,
      object_id: args.object_id,
      object_name: obj.displayName || obj.name || args.object_id,
      previous_public_access: previousPublicAccess,
      new_public_access: verified.publicAccess || obj.publicAccess,
      user_group_accesses: (verified.userGroupAccesses || obj.userGroupAccesses || []).length,
      user_accesses: (verified.userAccesses || obj.userAccesses || []).length,
      _access_key: 'Positions 1-2=metadata(rw), 3-4=data(rw). "rwrw----"=full, "rw------"=metadata only, "r-r-----"=read-only.',
      backup: backup.block,
    };
  }

  // ── add_program_attributes: attach TEAs (existing or new) to an existing program ──
  // This is the correct path for "add name/age as searchable attributes to program X".
  // The naive routes fail:
  //   - PATCH programs/{id} with application/json → 415 (DHIS2 requires application/json-patch+json)
  //   - POST programTrackedEntityAttributes              → 404 (not a real endpoint)
  //   - POST metadata with just programTrackedEntityAttributes → ignored / 409
  // Correct path: GET the full program, append new programTrackedEntityAttributes
  // entries, then PUT the full object back.
  if (action === 'add_program_attributes') {
    const _gate = requireWriteAuth('manage_metadata', 'add_program_attributes', { program_id: args.program_id || args.object_id });
    if (_gate) return _gate;
    const progId = args.program_id || args.object_id;
    if (!progId) return { _error: 'program_id (or object_id) is required for add_program_attributes' };
    const attrs = args.program_attributes || [];
    if (!attrs.length) return { _error: 'program_attributes must be a non-empty array for add_program_attributes' };

    // 1. Fetch the full program — we need the complete object back to PUT it.
    const progResp = await safeDhis2Fetch(
      `programs/${progId}?fields=:owner,programTrackedEntityAttributes[:owner,trackedEntityAttribute[id,name]]`
    );
    if (progResp?._error) return { _error: `Could not load program ${progId}: ${progResp._error}` };
    if (!progResp?.id) return { _error: `Program ${progId} not found.` };

    // Resolve default categoryCombo for any new TEAs (not strictly required on TEA but safe-guard).
    const catComboResp = await safeDhis2Fetch('categoryCombos?filter=name:eq:default&fields=id&pageSize=1');
    const defaultCatComboId = catComboResp?.categoryCombos?.[0]?.id || null;

    const existingPtas = progResp.programTrackedEntityAttributes || [];
    const existingTeaIds = new Set(existingPtas.map(p => p.trackedEntityAttribute?.id).filter(Boolean));
    const maxSort = existingPtas.reduce((m, p) => Math.max(m, p.sortOrder || 0), 0);
    let nextSort = maxSort;

    // 2. Resolve/create each requested TEA.
    const newlyCreatedTeas = [];
    const newlyCreatedOptions = [];
    const newlyCreatedOptionSets = [];
    const resolvedAttrs = []; // [{ teaId, cfg }]

    for (const a of attrs) {
      let teaId = a.id || null;

      if (!teaId && a.name) {
        const found = await safeDhis2Fetch(
          `trackedEntityAttributes?filter=name:eq:${encodeURIComponent(a.name)}&fields=id,name&pageSize=1`
        );
        // Probe failure ≠ "does not exist". Creating here would duplicate an
        // attribute we simply could not see — abort loudly instead.
        if (found?._error) {
          return { _error: `Could not check for an existing attribute named "${a.name}" (${found._error}). Aborting BEFORE creating anything to avoid duplicating an attribute that may already exist. Nothing was changed — verify connectivity and retry.` };
        }
        teaId = found?.trackedEntityAttributes?.[0]?.id || null;
      }

      if (!teaId) {
        // Create a new TEA. value_type is required; otherwise skip with clear error.
        if (!a.name || !a.value_type) {
          return { _error: `Cannot resolve or create attribute: provide id, or name + value_type. Got: ${JSON.stringify(a)}` };
        }
        const teaUid = generateDhis2Uid();
        const tea = {
          id: teaUid,
          name: a.name,
          shortName: clampShortName(a.short_name, a.name, null, 'Attribute'),
          valueType: a.value_type,
          aggregationType: 'NONE',
        };
        if (a.option_set?.name && a.option_set.options?.length) {
          const { optionSet, options, osUid } = buildOptionSetAndOptions(a.option_set);
          newlyCreatedOptions.push(...options);
          newlyCreatedOptionSets.push(optionSet);
          tea.optionSet = { id: osUid };
        }
        newlyCreatedTeas.push(tea);
        teaId = teaUid;
      }

      resolvedAttrs.push({ teaId, cfg: a });
    }

    // 3. If we created any new TEAs / option sets, import them first in one atomic POST.
    //    These are pure-create — no snapshot needed.
    if (newlyCreatedTeas.length || newlyCreatedOptionSets.length) {
      // Pre-probe DHIS2 for shortName collisions before committing.
      await disambiguateShortNamesAgainstServer(newlyCreatedTeas, 'trackedEntityAttributes', 'trackedEntityAttributes');
      const pre = {};
      if (newlyCreatedOptions.length) pre.options = newlyCreatedOptions;
      if (newlyCreatedOptionSets.length) pre.optionSets = newlyCreatedOptionSets;
      if (newlyCreatedTeas.length) pre.trackedEntityAttributes = newlyCreatedTeas;
      const preResult = await postMetadataPayload(pre, false);
      if (!preResult.success) {
        return { _error: `Failed to create prerequisite attributes/option sets: ${preResult._error || 'unknown'}`, phase: 'prerequisites', details: preResult };
      }
    }

    // Snapshot the program BEFORE we mutate its TEA list.
    const backup = await ensureBackupOrBail(
      { operation: 'add_program_attributes', tool: 'manage_metadata', action: 'add_program_attributes', reason: `Adding ${attrs.length} attribute(s) to program ${progResp.name || progId}` },
      [{ object_type: 'programs', object_id: progId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    // 4. Append new programTrackedEntityAttributes entries.
    const updatedProgram = { ...progResp };
    const updatedPtas = [...existingPtas];
    const addedAttrs = [];
    for (const { teaId, cfg } of resolvedAttrs) {
      if (existingTeaIds.has(teaId)) {
        addedAttrs.push({ trackedEntityAttribute: teaId, skipped: 'already_on_program' });
        continue;
      }
      nextSort += 1;
      updatedPtas.push({
        trackedEntityAttribute: { id: teaId },
        mandatory: cfg.mandatory === true,
        searchable: cfg.searchable === true,
        displayInList: cfg.display_in_list !== false,
        sortOrder: nextSort,
      });
      addedAttrs.push({ trackedEntityAttribute: teaId, searchable: cfg.searchable === true, displayInList: cfg.display_in_list !== false });
    }
    updatedProgram.programTrackedEntityAttributes = updatedPtas;

    // 5. PUT the full program back. DHIS2 supports PUT /api/{ver}/programs/{id} with
    //    Content-Type: application/json — this is the correct update path (not PATCH).
    const putResp = await safeDhis2Fetch(`programs/${progId}`, {
      method: 'PUT',
      body: updatedProgram,
    });
    if (putResp?._error) {
      return { _error: `Failed to update program: ${putResp._error}`, phase: 'update_program', backup: backup.block };
    }

    // 6. Verify.
    const verifyResp = await safeDhis2Fetch(
      `programs/${progId}?fields=id,name,programTrackedEntityAttributes[trackedEntityAttribute[id,displayName],searchable,displayInList,mandatory,sortOrder]`
    );
    const verifiedPtas = verifyResp?.programTrackedEntityAttributes || [];

    return {
      success: true,
      action: 'add_program_attributes',
      program_id: progId,
      added: addedAttrs,
      created_trackedEntityAttributes: newlyCreatedTeas.map(t => ({ id: t.id, name: t.name, valueType: t.valueType })),
      created_option_sets: newlyCreatedOptionSets.map(o => ({ id: o.id, name: o.name })),
      program_attributes_after: verifiedPtas.map(p => ({
        id: p.trackedEntityAttribute?.id,
        name: p.trackedEntityAttribute?.displayName,
        searchable: p.searchable,
        displayInList: p.displayInList,
        mandatory: p.mandatory,
        sortOrder: p.sortOrder,
      })),
      backup: backup.block,
    };
  }

  // ── discover_icons: bulk verify icon keys before update_style ─────────────
  // DHIS2 has a fixed icon library. Models routinely fabricate plausible keys
  // ("tuberculosis_positive", "diabetes_positive") — update_style now refuses
  // unverified keys, so the model has to come through this action first. One
  // tool call burns N parallel /icons?search= queries (one per keyword) and
  // returns every match it found, plus a deduped flat key list. The keys are
  // also added to dhis2.knownIcons so the immediate update_style call passes
  // the verify-before-write gate without re-checking.
  if (action === 'discover_icons') {
    const rawKeywords = Array.isArray(args.keywords) ? args.keywords : [];
    const keywords = [...new Set(
      rawKeywords
        .map(k => String(k || '').trim().toLowerCase())
        .filter(k => k && k.length >= 3)
    )];
    if (!keywords.length) {
      return {
        _error: 'discover_icons requires keywords[] (an array of 4-8 short keyword roots).',
        _hint: 'DHIS2 icon search is prefix-on-keyword. Use SHORT roots: ["lung","respir","tb","medical","clinic"] not ["tuberculosis","respiratory"]. The latter return 0 because the trailing letters break prefix matching.',
      };
    }
    if (!(dhis2.knownIcons instanceof Set)) dhis2.knownIcons = new Set();

    // Run searches in parallel — single round-trip latency for all keywords.
    const searches = await Promise.all(keywords.map(async (kw) => {
      const r = await safeDhis2Fetch(`icons?search=${encodeURIComponent(kw)}&fields=key,keywords&pageSize=20`);
      const list = (r?.icons || []).map(i => ({ key: i.key, keywords: i.keywords || [] }));
      return { keyword: kw, matches: list };
    }));

    const byKeyword = {};
    const allKeysSet = new Set();
    for (const s of searches) {
      byKeyword[s.keyword] = s.matches;
      for (const m of s.matches) {
        allKeysSet.add(m.key);
        dhis2.knownIcons.add(m.key);
      }
    }

    const allKeys = [...allKeysSet];
    const noneMatched = allKeys.length === 0;

    return {
      success: true,
      action: 'discover_icons',
      keywords_tried: keywords,
      results: byKeyword,
      verified_keys: allKeys,
      total_unique_matches: allKeys.length,
      ...(noneMatched ? {
        _hint: 'No icons matched any of these keyword roots. DHIS2 search needs SHORTER prefixes — e.g. "preg" not "pregnan", "respir" not "respiratory". Try again with broader or shorter roots, OR fall back to generic terms ("medical","clinic","health","hospital","stethoscope","syringe","capsule") that almost always return matches. If still nothing, skip the icon and call update_style with only `color`.',
      } : {
        _next: 'Pick ONE key from verified_keys[] (or from results[<keyword>]) and call manage_metadata(action=update_style, object_type=..., object_id=..., icon=<exact key>, color=...). Do NOT modify the key — pass it verbatim.',
      }),
    };
  }

  // ── update_style: set display icon + color on any styled metadata object ──
  // DHIS2 PATCH requires application/json-patch+json (safeDhis2Fetch handles this now).
  // Icon must be a key already verified this turn (in dhis2.knownIcons) — the
  // verify-before-write gate prevents the failure mode where the model picks a
  // plausible-but-fabricated key, eats a 404, then has to retry. If the model
  // somehow sends an unverified key we still run the resolver, and on success
  // record the canonical key into knownIcons so the gate stays consistent.
  if (action === 'update_style') {
    const _gate = requireWriteAuth('manage_metadata', 'update_style', { object_type: args.object_type, object_id: args.object_id });
    if (_gate) return _gate;
    if (!args.object_type || !args.object_id) return { _error: 'object_type and object_id required for update_style' };
    if (args.icon == null && args.color == null) return { _error: 'Provide at least one of: icon, color.' };

    const stylableTypes = new Set([
      'programs', 'programStages', 'dataElements', 'optionSets',
      'trackedEntityAttributes', 'indicators', 'options',
    ]);
    if (!stylableTypes.has(args.object_type)) {
      return { _error: `object_type "${args.object_type}" does not expose a style field. Supported: ${[...stylableTypes].join(', ')}.` };
    }

    // Verify the object exists and capture current style.
    const objResp = await safeDhis2Fetch(`${args.object_type}/${args.object_id}?fields=id,displayName,name,style`);
    if (objResp._error) return { _error: `Could not load ${args.object_type}/${args.object_id}: ${objResp._error}` };
    if (!objResp.id) return { _error: `${args.object_type}/${args.object_id} not found.` };

    // Verify-before-write: icon MUST come from a discover_icons response in
    // this turn (or have surfaced organically through any other tool result
    // that exposes /icons or `style.icon` data). Block fabricated keys at
    // the gate — failed PATCH attempts on made-up keys ("tuberculosis_positive",
    // "diabetes_positive") were burning round trips and frustrating the user.
    let resolvedIcon = args.icon ? String(args.icon).trim() : undefined;
    let iconLookupNote = null;
    if (resolvedIcon) {
      if (!(dhis2.knownIcons instanceof Set)) dhis2.knownIcons = new Set();
      const isPreVerified = dhis2.knownIcons.has(resolvedIcon);

      if (!isPreVerified) {
        // Step 1: a model that supplies an unverified key MUST go through
        // discover_icons first. Refuse before doing any network work — even
        // the resolver call would be wasted bandwidth here.
        return {
          _error: `Icon "${resolvedIcon}" was not verified this turn. update_style refuses unverified icon keys.`,
          _hint: 'Call manage_metadata(action=discover_icons, keywords=["<short-root1>","<short-root2>",...]) FIRST to discover real DHIS2 icons relevant to this object. Then call update_style again with one of the keys returned in `verified_keys[]`. Use SHORT keyword roots: ["lung","respir","tb","medical","clinic"] for a TB program, not ["tuberculosis","respiratory"] (those return 0 because DHIS2 search is prefix-on-keyword). Common fabrications that DO NOT exist: tuberculosis_positive, diabetes_positive, vaccine_positive, pregnancy_positive (real key is pregnant_positive).',
          _scope: 'icon_not_verified',
          _attempted_icon: resolvedIcon,
          _verified_icons_this_turn: [...dhis2.knownIcons].slice(0, 30),
        };
      }

      // Pre-verified: still run the canonical-key check to defend against
      // typos in the verified-key copy. resolveDhis2IconKey() is cheap when
      // exact-key path hits.
      const resolution = await resolveDhis2IconKey(resolvedIcon);
      if (!resolution.ok) {
        // Should be unreachable (key was in knownIcons) but bail safely if
        // the icon was deleted between discover and update.
        return {
          _error: `Icon "${resolvedIcon}" was reported verified but no longer resolves on the server (${resolution.error}).`,
          _hint: 'Re-run manage_metadata(action=discover_icons,...) to get a current list and pick a still-existing key.',
          _scope: 'icon_disappeared',
        };
      }
      resolvedIcon = resolution.key;
      dhis2.knownIcons.add(resolvedIcon);
      if (resolution.note) iconLookupNote = resolution.note;
    }

    // Build the JSON Patch. If a style object already exists, use replace; otherwise add.
    const currentStyle = objResp.style || null;
    const newStyle = {
      ...(currentStyle || {}),
      ...(resolvedIcon !== undefined ? { icon: resolvedIcon } : {}),
      ...(args.color !== undefined ? { color: String(args.color) } : {}),
    };
    const patchOp = currentStyle ? 'replace' : 'add';
    const patchBody = [{ op: patchOp, path: '/style', value: newStyle }];

    // Snapshot the object BEFORE patching style.
    const backup = await ensureBackupOrBail(
      { operation: 'update_style', tool: 'manage_metadata', action: 'update_style', reason: `Style change on ${args.object_type}/${args.object_id} (icon=${resolvedIcon || '-'}, color=${args.color || '-'})` },
      [{ object_type: args.object_type, object_id: args.object_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const patchResp = await safeDhis2Fetch(`${args.object_type}/${args.object_id}`, {
      method: 'PATCH',
      body: patchBody,
    });
    if (patchResp?._error) return { _error: `Failed to update style: ${patchResp._error}`, _hint: iconLookupNote, backup: backup.block };

    // Verify
    const verifyResp = await safeDhis2Fetch(`${args.object_type}/${args.object_id}?fields=id,displayName,style`);
    return {
      success: true,
      action: 'update_style',
      object_type: args.object_type,
      object_id: args.object_id,
      object_name: verifyResp?.displayName || objResp.displayName || objResp.name || args.object_id,
      previous_style: currentStyle,
      new_style: verifyResp?.style || newStyle,
      ...(iconLookupNote ? { icon_resolution: iconLookupNote } : {}),
      backup: backup.block,
    };
  }

  // ── convert_value_type: flip valueType on a DE/TEA/optionSet and cascade ──
  // DHIS2 multi-select (MULTI_TEXT) requires BOTH the DE/TEA AND its optionSet to
  // be MULTI_TEXT — otherwise the New Tracker Capture form renders a single-select
  // dropdown even though the field stores comma-separated codes. Patching only one
  // side leaves a broken pair that nobody notices until users try to multi-pick.
  if (action === 'convert_value_type') {
    const _gate = requireWriteAuth('manage_metadata', 'convert_value_type', { object_type: args.object_type, object_id: args.object_id });
    if (_gate) return _gate;
    if (!args.object_type || !args.object_id) return { _error: 'object_type and object_id required for convert_value_type' };
    if (!args.value_type) return { _error: 'value_type required (e.g. "MULTI_TEXT", "TEXT", "LONG_TEXT")' };
    const newVT = String(args.value_type).trim().toUpperCase();

    const supportedTypes = new Set(['dataElements', 'trackedEntityAttributes', 'optionSets']);
    if (!supportedTypes.has(args.object_type)) {
      return { _error: `convert_value_type only supports dataElements, trackedEntityAttributes, optionSets — got "${args.object_type}".` };
    }

    // Targets: each {object_type, object_id, current_value_type} we will patch.
    const targets = [];
    let cascadedFrom = null;

    if (args.object_type === 'optionSets') {
      const osResp = await safeDhis2Fetch(`optionSets/${args.object_id}?fields=id,displayName,valueType`);
      if (osResp._error || !osResp.id) return { _error: `Could not load optionSets/${args.object_id}: ${osResp._error || 'not found'}` };
      targets.push({ object_type: 'optionSets', object_id: osResp.id, name: osResp.displayName, current: osResp.valueType });

      // Cascade: every DE that uses this option set
      const deResp = await safeDhis2Fetch(`dataElements?filter=optionSet.id:eq:${osResp.id}&fields=id,displayName,valueType&paging=false`);
      for (const de of (deResp?.dataElements || [])) {
        targets.push({ object_type: 'dataElements', object_id: de.id, name: de.displayName, current: de.valueType });
      }
      // Cascade: every TEA that uses this option set
      const teaResp = await safeDhis2Fetch(`trackedEntityAttributes?filter=optionSet.id:eq:${osResp.id}&fields=id,displayName,valueType&paging=false`);
      for (const tea of (teaResp?.trackedEntityAttributes || [])) {
        targets.push({ object_type: 'trackedEntityAttributes', object_id: tea.id, name: tea.displayName, current: tea.valueType });
      }
    } else {
      // dataElements or trackedEntityAttributes — load it, get its optionSet, then cascade upward.
      const objResp = await safeDhis2Fetch(`${args.object_type}/${args.object_id}?fields=id,displayName,valueType,optionSet[id,displayName,valueType]`);
      if (objResp._error || !objResp.id) return { _error: `Could not load ${args.object_type}/${args.object_id}: ${objResp._error || 'not found'}` };
      targets.push({ object_type: args.object_type, object_id: objResp.id, name: objResp.displayName, current: objResp.valueType });
      if (objResp.optionSet?.id) {
        cascadedFrom = args.object_type;
        // Add option set itself
        targets.push({ object_type: 'optionSets', object_id: objResp.optionSet.id, name: objResp.optionSet.displayName, current: objResp.optionSet.valueType });
        // Add every other DE/TEA referencing the same option set
        const deResp = await safeDhis2Fetch(`dataElements?filter=optionSet.id:eq:${objResp.optionSet.id}&fields=id,displayName,valueType&paging=false`);
        for (const de of (deResp?.dataElements || [])) {
          if (de.id !== objResp.id) targets.push({ object_type: 'dataElements', object_id: de.id, name: de.displayName, current: de.valueType });
        }
        const teaResp = await safeDhis2Fetch(`trackedEntityAttributes?filter=optionSet.id:eq:${objResp.optionSet.id}&fields=id,displayName,valueType&paging=false`);
        for (const tea of (teaResp?.trackedEntityAttributes || [])) {
          if (tea.id !== objResp.id) targets.push({ object_type: 'trackedEntityAttributes', object_id: tea.id, name: tea.displayName, current: tea.valueType });
        }
      } else if (newVT === 'MULTI_TEXT') {
        return {
          _error: `${args.object_type}/${args.object_id} has no optionSet — MULTI_TEXT requires an option set.`,
          _hint: `Use create_metadata to attach an option set first, or convert an optionSet that already has options.`,
        };
      }
    }

    // Filter out targets already at the new value type (idempotent)
    const toPatch = targets.filter(t => t.current !== newVT);
    if (!toPatch.length) {
      return {
        success: true,
        action: 'convert_value_type',
        new_value_type: newVT,
        already_correct: true,
        targets: targets.map(t => ({ object_type: t.object_type, object_id: t.object_id, name: t.name, value_type: t.current })),
        message: 'All targets already use the requested valueType.',
      };
    }

    // Pre-flight backup over every object we'll touch
    const backup = await ensureBackupOrBail(
      { operation: 'convert_value_type', tool: 'manage_metadata', action: 'convert_value_type', reason: `Convert valueType→${newVT} on ${args.object_type}/${args.object_id} (cascading to ${toPatch.length} object(s))` },
      toPatch.map((t, i) => ({ object_type: t.object_type, object_id: t.object_id, role: i === 0 ? 'primary' : 'cascade' })),
      args
    );
    if (!backup.ok) return backup.error;

    const results = [];
    for (const t of toPatch) {
      const patchResp = await safeDhis2Fetch(`${t.object_type}/${t.object_id}`, {
        method: 'PATCH',
        body: [{ op: 'replace', path: '/valueType', value: newVT }],
      });
      if (patchResp?._error) {
        results.push({ object_type: t.object_type, object_id: t.object_id, name: t.name, ok: false, error: patchResp._error });
      } else {
        results.push({ object_type: t.object_type, object_id: t.object_id, name: t.name, ok: true, from: t.current, to: newVT });
      }
    }

    const failed = results.filter(r => !r.ok);
    return {
      success: failed.length === 0,
      action: 'convert_value_type',
      new_value_type: newVT,
      cascaded_from: cascadedFrom,
      patched: results.filter(r => r.ok),
      failed,
      backup: backup.block,
      ...(failed.length ? { _hint: 'Some targets failed to patch — the optionSet/DE pair may now be inconsistent. Re-run convert_value_type on the failed object_id, or roll back via manage_backups(action=restore).' } : {}),
    };
  }

  return { _error: `Unknown action: ${action}. Use remove_from_stage, delete, check_references, update_program_org_units, update_sharing, add_program_attributes, update_style, convert_value_type, or discover_icons.` };
}

// Helper: check all references for a metadata object
async function checkMetadataReferences(objectType, objectId) {
  const refs = {};
  const id = objectId;

  if (objectType === 'dataElements') {
    // Check program stages containing this DE
    const stagesResp = await safeDhis2Fetch(
      `programStages?filter=programStageDataElements.dataElement.id:eq:${id}&fields=id,name,program[id,name]&paging=false`
    );
    if (!stagesResp._error && stagesResp.programStages?.length) {
      refs.program_stages = stagesResp.programStages.map(ps => ({
        stage_id: ps.id,
        stage_name: ps.name,
        program_id: ps.program?.id,
        program_name: ps.program?.name,
      }));
    }

    // Check program rule variables referencing this DE
    const prvResp = await safeDhis2Fetch(
      `programRuleVariables?filter=dataElement.id:eq:${id}&fields=id,name,program[id,name]&paging=false`
    );
    if (!prvResp._error && prvResp.programRuleVariables?.length) {
      refs.program_rule_variables = prvResp.programRuleVariables.map(v => ({
        id: v.id, name: v.name, program_name: v.program?.name,
      }));
    }

    // Check data element groups
    const degResp = await safeDhis2Fetch(
      `dataElementGroups?filter=dataElements.id:eq:${id}&fields=id,name&paging=false`
    );
    if (!degResp._error && degResp.dataElementGroups?.length) {
      refs.data_element_groups = degResp.dataElementGroups.map(g => ({ id: g.id, name: g.name }));
    }

    refs._note = 'Event data values referencing this data element cannot be fully checked via API. If events contain data for this DE, DHIS2 will return a 409 error on deletion.';
  }

  if (objectType === 'optionSets') {
    const deResp = await safeDhis2Fetch(`dataElements?filter=optionSet.id:eq:${id}&fields=id,name&paging=false`);
    if (!deResp._error && deResp.dataElements?.length) {
      refs.data_elements_using_this = deResp.dataElements.map(de => ({ id: de.id, name: de.name }));
    }
    const teaResp = await safeDhis2Fetch(`trackedEntityAttributes?filter=optionSet.id:eq:${id}&fields=id,name&paging=false`);
    if (!teaResp._error && teaResp.trackedEntityAttributes?.length) {
      refs.tracked_entity_attributes_using_this = teaResp.trackedEntityAttributes.map(t => ({ id: t.id, name: t.name }));
    }
  }

  if (objectType === 'legendSets') {
    // Distinct ref keys (…_using_legendset) so buildDeletionHint can give
    // legend-set-specific guidance without colliding with the option-set keys.
    const deResp = await safeDhis2Fetch(`dataElements?filter=legendSets.id:eq:${id}&fields=id,name&paging=false`);
    if (!deResp._error && deResp.dataElements?.length) {
      refs.data_elements_using_legendset = deResp.dataElements.map(de => ({ id: de.id, name: de.name }));
    }
    const indResp = await safeDhis2Fetch(`indicators?filter=legendSets.id:eq:${id}&fields=id,name&paging=false`);
    if (!indResp._error && indResp.indicators?.length) {
      refs.indicators_using_legendset = indResp.indicators.map(x => ({ id: x.id, name: x.name }));
    }
    const visResp = await safeDhis2Fetch(`visualizations?filter=legendSet.id:eq:${id}&fields=id,name&paging=false`);
    if (!visResp._error && visResp.visualizations?.length) {
      refs.visualizations_using_legendset = visResp.visualizations.map(x => ({ id: x.id, name: x.name }));
    }
    const mapResp = await safeDhis2Fetch(`maps?filter=mapViews.legendSet.id:eq:${id}&fields=id,name&paging=false`);
    if (!mapResp._error && mapResp.maps?.length) {
      refs.maps_using_legendset = mapResp.maps.map(x => ({ id: x.id, name: x.name }));
    }
  }

  if (objectType === 'trackedEntityAttributes') {
    const ptaResp = await safeDhis2Fetch(
      `programs?filter=programTrackedEntityAttributes.trackedEntityAttribute.id:eq:${id}&fields=id,name&paging=false`
    );
    if (!ptaResp._error && ptaResp.programs?.length) {
      refs.programs_using_this = ptaResp.programs.map(p => ({ id: p.id, name: p.name }));
    }
    const prvResp = await safeDhis2Fetch(
      `programRuleVariables?filter=trackedEntityAttribute.id:eq:${id}&fields=id,name,program[id,name]&paging=false`
    );
    if (!prvResp._error && prvResp.programRuleVariables?.length) {
      refs.program_rule_variables = prvResp.programRuleVariables.map(v => ({
        id: v.id, name: v.name, program_name: v.program?.name,
      }));
    }
  }

  if (objectType === 'programStages') {
    const progResp = await safeDhis2Fetch(`programStages/${id}?fields=program[id,name]`);
    if (!progResp._error && progResp.program?.id) {
      refs.parent_program = { id: progResp.program.id, name: progResp.program.name };
    }
  }

  const hasRefs = Object.keys(refs).filter(k => !k.startsWith('_')).some(k => {
    const v = refs[k];
    return Array.isArray(v) ? v.length > 0 : !!v;
  });

  return { object_type: objectType, object_id: id, references: refs, has_references: hasRefs };
}

// Helper: build human-readable hint for resolving references before deletion
function buildDeletionHint(objectType, objectId, refs) {
  const hints = [];
  if (refs.program_stages?.length) {
    for (const s of refs.program_stages) {
      hints.push(`Remove from stage "${s.stage_name}" (${s.stage_id}) using manage_metadata(action=remove_from_stage, stage_id="${s.stage_id}", data_element_ids=["${objectId}"])`);
    }
  }
  if (refs.program_rule_variables?.length) {
    hints.push(`Delete ${refs.program_rule_variables.length} program rule variable(s) that reference this object: ${refs.program_rule_variables.map(v => `${v.name} (${v.id})`).join(', ')}`);
  }
  if (refs.data_element_groups?.length) {
    hints.push(`Remove from ${refs.data_element_groups.length} data element group(s): ${refs.data_element_groups.map(g => g.name).join(', ')}`);
  }
  if (refs.data_elements_using_this?.length) {
    hints.push(`${refs.data_elements_using_this.length} data element(s) use this option set — remove or reassign them first`);
  }
  if (refs.tracked_entity_attributes_using_this?.length) {
    hints.push(`${refs.tracked_entity_attributes_using_this.length} tracked entity attribute(s) use this option set — remove or reassign them first`);
  }
  if (refs.programs_using_this?.length) {
    hints.push(`Remove this attribute from ${refs.programs_using_this.length} program(s): ${refs.programs_using_this.map(p => p.name).join(', ')}`);
  }
  if (refs.data_elements_using_legendset?.length) {
    hints.push(`${refs.data_elements_using_legendset.length} data element(s) use this legend set — detach it from them first (manage_metadata): ${refs.data_elements_using_legendset.map(d => d.name).join(', ')}`);
  }
  if (refs.indicators_using_legendset?.length) {
    hints.push(`${refs.indicators_using_legendset.length} indicator(s) use this legend set — detach it from them first: ${refs.indicators_using_legendset.map(d => d.name).join(', ')}`);
  }
  if (refs.visualizations_using_legendset?.length) {
    hints.push(`${refs.visualizations_using_legendset.length} visualization(s) use this legend set — change their legend in Data Visualizer first: ${refs.visualizations_using_legendset.map(d => d.name).join(', ')}`);
  }
  if (refs.maps_using_legendset?.length) {
    hints.push(`${refs.maps_using_legendset.length} map(s) use this legend set — change the layer legend in Maps first: ${refs.maps_using_legendset.map(d => d.name).join(', ')}`);
  }
  if (refs.parent_program) {
    hints.push(`This stage belongs to program "${refs.parent_program.name}" — removing it will affect all enrollments`);
  }
  return hints.length ? hints.join('\n') : 'Remove all references listed above, then retry deletion.';
}

async function addProgramRules(args) {
  if (!args.program_id) return { _error: 'Missing program_id for add_program_rules' };
  if (!args.program_rules?.length) return { _error: 'Missing program_rules array' };

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

  // Load existing program DEs and TEAs to map names → IDs.
  // PSDE id+compulsory included so HIDEALLFIELDS sugar can flip compulsory→false on
  // hidden DEs (DHIS2 New Tracker Capture refuses to visually hide a compulsory DE).
  const progResp = await safeDhis2Fetch(
    `programs/${args.program_id}?fields=id,programStages[id,displayName,sortOrder,programStageDataElements[id,compulsory,dataElement[id,displayName,optionSet[id]]]],programTrackedEntityAttributes[trackedEntityAttribute[id,displayName,optionSet[id]]]`
  );
  if (progResp._error) {
    return {
      _error: `Could not load program ${args.program_id}: ${progResp._error}`,
      _hint: 'If this program id came from a FAILED create_program attempt, nothing was created (the import is atomic) — that id does not exist. Either re-issue the full create_program call (rules can be included inline), or find the real program first via search_metadata(object_type="programs", name_filter=...).',
    };
  }

  // Pre-flight: visibility semantics — checked against BOTH the batch itself
  // and the rules already on the program (a "Show X when Yes" twin of an
  // existing "Hide X when No" is the classic broken pattern). A failed
  // existing-rules read degrades to batch-only linting rather than blocking.
  {
    const existingRulesResp = await safeDhis2Fetch(
      `programRules?filter=program.id:eq:${args.program_id}&fields=id,name,condition,programRuleActions%5BprogramRuleActionType,dataElement%5Bid,displayName%5D,trackedEntityAttribute%5Bid,displayName%5D,programStage%5Bid,displayName%5D,programStageSection%5Bid,displayName%5D%5D&pageSize=100`
    );
    const semanticErrors = lintRuleVisibilitySemantics(
      args.program_rules,
      existingRulesResp._error ? [] : (existingRulesResp.programRules || [])
    );
    if (semanticErrors.length) {
      return {
        success: false,
        _error: `Program rule semantics lint failed (${semanticErrors.length}): ${semanticErrors.join(' | ')}`,
        phase: 'lint',
        errors: semanticErrors,
        _hint: 'Rewrite as ONE hide rule per target (condition = the HIDE case); mandatory-when-visible goes in a separate SETMANDATORYFIELD-only rule with the positive condition. Then retry. Do not work around this by re-wording rule names.',
      };
    }
  }

  // Auto-rewrite SHOWWARNING content + expand HIDEALLFIELDS sugar before processing actions.
  // Side effects: PUT each affected stage with compulsory→false; auto-append a sibling
  // SETMANDATORYFIELD rule that re-mandates those DEs when the trigger condition is false.
  const sugarPlan = applyRuleActionSugar(args.program_rules, progResp.programStages || []);
  const sugarSideEffects = await applyRuleActionSugarSideEffects(sugarPlan, args.program_rules);

  const deNameToId = {};
  const deNameToStage = {};
  const deNameToOptionSetId = {};
  const stageNameToId = {};
  for (const ps of (progResp.programStages || [])) {
    if (ps.displayName) stageNameToId[String(ps.displayName).trim().toLowerCase()] = ps.id;
    for (const psde of (ps.programStageDataElements || [])) {
      const de = psde.dataElement;
      deNameToId[de.displayName] = de.id;
      deNameToStage[de.displayName] = ps.id;
      if (de.optionSet?.id) deNameToOptionSetId[de.displayName] = de.optionSet.id;
    }
  }
  const validStageIdSet = new Set((progResp.programStages || []).map(ps => ps.id));
  // Stage references in actions may arrive as a stage NAME (models often can't
  // know stage UIDs) — resolve name → id; a valid known UID passes through.
  const resolveStageRefForAction = (act) => {
    const ref = act.program_stage_name || act.program_stage_id;
    if (!ref) return null;
    if (validStageIdSet.has(ref)) return ref;
    const byName = stageNameToId[String(ref).trim().toLowerCase()];
    if (byName) return byName;
    if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(String(ref))) return ref; // plausible UID from elsewhere — let the server validate
    return undefined;
  };

  const teaNameToId = {};
  const teaHasOptionSet = {};
  const teaNameToOptionSetId = {};
  for (const ptea of (progResp.programTrackedEntityAttributes || [])) {
    const tea = ptea.trackedEntityAttribute;
    teaNameToId[tea.displayName] = tea.id;
    teaHasOptionSet[tea.displayName] = !!tea.optionSet;
    if (tea.optionSet?.id) teaNameToOptionSetId[tea.displayName] = tea.optionSet.id;
  }

  // Existing PRVs on the program: tokens naming them resolve as-is (no new
  // PRV), and new PRVs must not collide with their names. Option-set details
  // are fetched too so literals compared against EXISTING option-backed
  // variables get the same name→code mapping as new ones.
  const existingPrvResp = await safeDhis2Fetch(
    `programRuleVariables?filter=program.id:eq:${args.program_id}&fields=name,useCodeForOptionSet,dataElement[id,optionSet[id]],trackedEntityAttribute[id,optionSet[id]]&paging=false`
  );
  const existingPrvList = existingPrvResp.programRuleVariables || [];
  const existingVarNames = new Set(existingPrvList.map(v => v.name));

  const allPRVs = [];
  const allPRAs = [];
  const allPRs = [];
  const prvCreated = {};
  for (const n of existingVarNames) prvCreated[n] = 'existing';

  const pushDePrv = (prvName, deName) => {
    if (prvCreated[prvName]) return;
    const prvUid = generateDhis2Uid();
    allPRVs.push({
      id: prvUid,
      name: prvName,
      program: { id: args.program_id },
      dataElement: { id: deNameToId[deName] },
      programRuleVariableSourceType: 'DATAELEMENT_NEWEST_EVENT_PROGRAM',
      // Option-set DEs must resolve option CODES so `== 'CODE'` conditions
      // fire (useCodeForOptionSet=false yields the option NAME — silent
      // never-matching rules; MCH bug, play 2.40.12, 2026-07-07).
      ...(deNameToOptionSetId[deName] ? { useCodeForOptionSet: true } : {}),
      ...(deNameToStage[deName] ? { programStage: { id: deNameToStage[deName] } } : {}),
    });
    prvCreated[prvName] = prvUid;
  };
  const pushTeaPrv = (prvName, teaName) => {
    if (prvCreated[prvName]) return;
    const prvUid = generateDhis2Uid();
    allPRVs.push({
      id: prvUid,
      name: prvName,
      program: { id: args.program_id },
      trackedEntityAttribute: { id: teaNameToId[teaName] },
      programRuleVariableSourceType: 'TEI_ATTRIBUTE',
      useCodeForOptionSet: !!teaHasOptionSet[teaName],
    });
    prvCreated[prvName] = prvUid;
  };

  const deNamesAll = Object.keys(deNameToId);
  const teaNamesAll = Object.keys(teaNameToId);
  const autoGuardedConditions = [];
  const ruleTokenRewrites = [];
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
    // Resolve #{}/A{} tokens (condition + action data) to program DEs/TEAs —
    // exact sanitized name, then unique prefix; display-name tokens are
    // auto-rewritten to canonical form; tokens naming an existing PRV pass
    // through. Unresolved tokens REFUSE the import (rules with unknown
    // variables save fine but never fire).
    const { bindings, unresolved, rewrites } = resolveRuleTokenBindings(rule, deNamesAll, teaNamesAll, existingVarNames);
    if (rewrites.length) ruleTokenRewrites.push({ rule: rule.name, rewrites });
    if (unresolved.length) {
      return {
        success: false,
        phase: 'lint',
        _error: `Program rule "${rule.name}" references unresolved variable(s): ${unresolved.join(', ')} — no program rule variable, data element or attribute of this program matches (exactly or by prefix). Nothing was imported.`,
        unresolved,
        available_variables: [...existingVarNames].map(n => `#{${n}}`),
        available_data_elements: deNamesAll.map(n => `#{${sanitizeVariableName(n)}}`),
        available_attributes: teaNamesAll.map(n => `A{${sanitizeVariableName(n)}}`),
        _hint: 'Reference an existing program rule variable, or #{sanitized_data_element_name} / A{sanitized_attribute_name} of this program. Fix the token(s) and retry.',
      };
    }
    for (const b of bindings) {
      if (b.kind === 'de') pushDePrv(b.token, b.name); else pushTeaPrv(b.token, b.name);
    }

    // Action-target DEs/TEAs also get a PRV under their sanitized name
    // (pre-existing behavior).
    for (const act of (rule.actions || [])) {
      if (act.data_element_name && deNameToId[act.data_element_name]) {
        pushDePrv(sanitizeVariableName(act.data_element_name), act.data_element_name);
      }
      if (act.tracked_entity_attribute_name && teaNameToId[act.tracked_entity_attribute_name]) {
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
      if (act.data_element_id) {
        // Direct ID target — used by HIDEALLFIELDS expansion and any explicit id pass-through.
        pra.dataElement = { id: act.data_element_id };
      } else if (act.data_element_name && deNameToId[act.data_element_name]) {
        pra.dataElement = { id: deNameToId[act.data_element_name] };
      }
      if (act.tei_attribute_id) {
        pra.trackedEntityAttribute = { id: act.tei_attribute_id };
      } else if (act.tracked_entity_attribute_name && teaNameToId[act.tracked_entity_attribute_name]) {
        pra.trackedEntityAttribute = { id: teaNameToId[act.tracked_entity_attribute_name] };
      }
      const stageId = resolveStageRefForAction(act);
      if (stageId) pra.programStage = { id: stageId };
      if (act.program_stage_section_id) pra.programStageSection = { id: act.program_stage_section_id };

      // Fail fast on stage-targeting actions with no resolvable stage — the
      // server rejects the whole bundle with "ProgramStage cannot be null".
      if ((act.type === 'HIDEPROGRAMSTAGE' || act.type === 'CREATEEVENT') && !pra.programStage) {
        return {
          success: false,
          phase: 'lint',
          _error: `Program rule "${rule.name}" has a ${act.type} action whose target stage could not be resolved${act.program_stage_name || act.program_stage_id ? ` from "${act.program_stage_name || act.program_stage_id}"` : ' (no stage reference given)'}. Nothing was imported.`,
          valid_stages: (progResp.programStages || []).map(ps => ({ id: ps.id, name: ps.displayName })),
          _hint: 'Pass program_stage_id with one of the valid stage ids, or program_stage_name with the stage name — the tool resolves names automatically. Fix the action and retry.',
        };
      }
      allPRAs.push(pra);
    }

    allPRs.push({
      id: prUid,
      name: rule.name,
      description: rule.description || '',
      program: { id: args.program_id },
      condition: rule.condition,
      programRuleActions: actionRefs, // ID refs only, not full objects
    });
  }

  // ── Option NAME → CODE mapping in conditions and ASSIGN data ──
  // New PRVs above resolve option CODES (useCodeForOptionSet=true); rewrite any
  // option-NAME literal to its code and flag literals that match neither.
  let ruleConditionAdvisories = [];
  let ruleConditionRewrites = [];
  {
    const deIdToOsId = new Map();
    for (const [n, id] of Object.entries(deNameToId)) {
      if (deNameToOptionSetId[n]) deIdToOsId.set(id, deNameToOptionSetId[n]);
    }
    const teaIdToOsId = new Map();
    for (const [n, id] of Object.entries(teaNameToId)) {
      if (teaNameToOptionSetId[n]) teaIdToOsId.set(id, teaNameToOptionSetId[n]);
    }
    const varToOsKey = new Map();
    for (const prv of allPRVs) {
      const osId = (prv.dataElement?.id && deIdToOsId.get(prv.dataElement.id))
        || (prv.trackedEntityAttribute?.id && teaIdToOsId.get(prv.trackedEntityAttribute.id)) || null;
      if (osId) varToOsKey.set(String(prv.name).toLowerCase(), osId);
    }
    // Existing option-backed PRVs: code-resolving ones join the rewrite; a
    // NAME-resolving one (useCodeForOptionSet=false) compared to a literal is
    // flagged — code literals never match it.
    const nameResolvingOptionVars = [];
    for (const prv of existingPrvList) {
      const osId = prv.dataElement?.optionSet?.id || prv.trackedEntityAttribute?.optionSet?.id || null;
      if (!osId) continue;
      if (prv.useCodeForOptionSet === false) nameResolvingOptionVars.push(prv.name);
      else varToOsKey.set(String(prv.name).toLowerCase(), osId);
    }
    for (const varName of nameResolvingOptionVars) {
      const esc = String(varName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`#\\{${esc}\\}\\s*(==|!=)\\s*'[^']+'`);
      for (const pr of allPRs) {
        if (re.test(pr.condition || '')) {
          ruleConditionAdvisories.push(`Rule "${pr.name}" compares #{${varName}} to a quoted literal, but that EXISTING variable has useCodeForOptionSet=false (it yields the option NAME, not the CODE) — a code literal never matches. Fix the variable via manage_program_rules or compare against the option name.`);
        }
      }
    }
    const targetToOsKey = new Map();
    for (const pra of allPRAs) {
      const osId = (pra.dataElement?.id && deIdToOsId.get(pra.dataElement.id))
        || (pra.trackedEntityAttribute?.id && teaIdToOsId.get(pra.trackedEntityAttribute.id)) || null;
      if (osId) targetToOsKey.set(pra.dataElement?.id || pra.trackedEntityAttribute?.id, osId);
    }
    const neededOsIds = [...new Set([...varToOsKey.values(), ...targetToOsKey.values()])];
    if (neededOsIds.length) {
      const resps = await Promise.all(neededOsIds.map(id =>
        safeDhis2Fetch(`optionSets/${id}?fields=id,options[name,code]`)));
      const optionsByOsKey = new Map();
      for (let i = 0; i < neededOsIds.length; i++) {
        const o = resps[i];
        if (o && !o._error) optionsByOsKey.set(neededOsIds[i], (o.options || []).map(x => ({ name: x.name, code: x.code })));
      }
      const mapped = rewriteOptionLiteralsGeneric({
        rules: allPRs,
        actions: allPRAs,
        varToOsKey,
        targetToOsKey,
        optionsByOsKey,
      });
      ruleConditionAdvisories = mapped.advisories;
      ruleConditionRewrites = mapped.rewrites;
    }
  }

  const payload = {};
  if (allPRVs.length) payload.programRuleVariables = allPRVs;
  if (allPRAs.length) payload.programRuleActions = allPRAs;
  if (allPRs.length) payload.programRules = allPRs;

  const result = await postMetadataPayload(payload, args.dry_run_only);

  return {
    ...result,
    summary: {
      program_id: args.program_id,
      programRules: allPRs.map(r => ({ id: r.id, name: r.name })),
      programRuleVariables: allPRVs.map(v => ({ id: v.id, name: v.name })),
      programRuleActions: allPRAs.map(a => ({ id: a.id, type: a.programRuleActionType })),
      ...(sugarSideEffects.stageUpdates.length ? { compulsory_flags_cleared: sugarSideEffects.stageUpdates } : {}),
      ...(sugarSideEffects.errors.length ? { compulsory_flag_errors: sugarSideEffects.errors } : {}),
      ...(sugarPlan.siblingMandateRules.length ? { auto_paired_mandate_rules: sugarPlan.siblingMandateRules.map(r => r.name) } : {}),
      ...(autoGuardedConditions.length ? { auto_guarded_conditions: autoGuardedConditions } : {}),
      ...(ruleConditionRewrites.length ? { condition_option_rewrites: ruleConditionRewrites } : {}),
      ...(ruleConditionAdvisories.length ? { condition_option_advisories: ruleConditionAdvisories } : {}),
      ...(ruleTokenRewrites.length ? { rule_token_rewrites: ruleTokenRewrites } : {}),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// manage_program_notifications — Program Notification Templates (CRUD + link)
// Codifies DHIS2's non-obvious rules so the model never has to rediscover them:
//  - No `url` field on the schema → webhook URL goes into messageTemplate.
//  - WEB_HOOK recipient auto-gets deliveryChannels=[HTTP] via postProcess hook
//    (ProgramNotificationTemplateObjectBundleHook), so we don't have to set it.
//  - Template ↔ program linking is a dedicated endpoint:
//      POST /api/programs/{programId}/notificationTemplates/{templateId}
//    (PATCH on the program with `programNotificationTemplates` fails 400.)
//  - subjectTemplate max 100, messageTemplate max 10000.
//  - SCHEDULED_* triggers require relativeScheduledDays (non-null).
//  - External recipients (eligible to carry deliveryChannels):
//      TRACKED_ENTITY_INSTANCE, ORGANISATION_UNIT_CONTACT,
//      PROGRAM_ATTRIBUTE, DATA_ELEMENT, WEB_HOOK
//    Internal (no deliveryChannels — go to the DHIS2 messaging inbox):
//      USER_GROUP, USERS_AT_ORGANISATION_UNIT
// ────────────────────────────────────────────────────────────────────────────

const PN_EXTERNAL_RECIPIENTS = new Set([
  'TRACKED_ENTITY_INSTANCE',
  'ORGANISATION_UNIT_CONTACT',
  'PROGRAM_ATTRIBUTE',
  'DATA_ELEMENT',
  'WEB_HOOK',
]);
const PN_SCHEDULED_TRIGGERS = new Set([
  'SCHEDULED_DAYS_DUE_DATE',
  'SCHEDULED_DAYS_INCIDENT_DATE',
  'SCHEDULED_DAYS_ENROLLMENT_DATE',
]);
const PN_TEMPLATE_FIELDS =
  'id,name,displayName,subjectTemplate,messageTemplate,notificationTrigger,'
  + 'notificationRecipient,deliveryChannels,sendRepeatable,relativeScheduledDays,'
  + 'recipientUserGroup[id,name],recipientProgramAttribute[id,name,valueType],'
  + 'recipientDataElement[id,name,valueType]';

function _pnBuildCreatePayload(args) {
  const name = (args.name || '').trim();
  if (!name) return { _error: 'name is required for create / create_and_link', _hint: 'Pass name="Human-readable template title" (shown in DHIS2 Notifications app).' };
  if (!args.trigger) return { _error: 'trigger is required for create / create_and_link', _hint: 'One of: ENROLLMENT, COMPLETION, PROGRAM_RULE, SCHEDULED_DAYS_DUE_DATE, SCHEDULED_DAYS_INCIDENT_DATE, SCHEDULED_DAYS_ENROLLMENT_DATE.' };
  if (!args.recipient) return { _error: 'recipient is required for create / create_and_link', _hint: 'One of: TRACKED_ENTITY_INSTANCE, ORGANISATION_UNIT_CONTACT, USERS_AT_ORGANISATION_UNIT, USER_GROUP, PROGRAM_ATTRIBUTE, DATA_ELEMENT, WEB_HOOK.' };

  const isWebhook = args.recipient === 'WEB_HOOK';
  const isScheduled = PN_SCHEDULED_TRIGGERS.has(args.trigger);

  // Resolve subjectTemplate + messageTemplate per recipient convention
  let subjectTemplate = args.subject_template;
  let messageTemplate = args.message_template;

  if (isWebhook) {
    // DHIS2 has no url field. Convention: messageTemplate = webhook URL.
    if (!messageTemplate) {
      if (!args.webhook_url) return { _error: 'webhook_url is required when recipient=WEB_HOOK', _hint: 'Pass webhook_url="https://..." — it is stored in messageTemplate (DHIS2 has no dedicated url field).' };
      if (!/^https?:\/\//i.test(args.webhook_url)) return { _error: 'webhook_url must be an http(s) URL', _hint: `Got "${args.webhook_url}". Expected http:// or https://.` };
      messageTemplate = args.webhook_url;
    }
    if (!subjectTemplate) {
      // Put human-readable body / template variables into subjectTemplate.
      subjectTemplate = (args.message_content || name).slice(0, 100);
    }
  } else {
    if (!messageTemplate) messageTemplate = args.message_content || '';
    if (!subjectTemplate) subjectTemplate = (args.subject_template || name).slice(0, 100);
  }

  if (subjectTemplate && subjectTemplate.length > 100) {
    return { _error: `subjectTemplate is ${subjectTemplate.length} chars — DHIS2 limit is 100.`, _hint: 'Shorten subject (for WEB_HOOK, move long content out of subject — but the URL already lives in messageTemplate, so keep subject concise with template vars only).' };
  }
  if (messageTemplate && messageTemplate.length > 10000) {
    return { _error: `messageTemplate is ${messageTemplate.length} chars — DHIS2 limit is 10000.`, _hint: 'Trim message body.' };
  }
  if (!messageTemplate) {
    return { _error: 'messageTemplate cannot be empty', _hint: isWebhook ? 'Pass webhook_url.' : 'Pass message_content="..." with template variables like V{program_name}, V{org_unit_name}, A{<teaUid>}.' };
  }

  // Recipient-specific required fields
  if (args.recipient === 'USER_GROUP' && !args.recipient_user_group_id) {
    return { _error: 'recipient=USER_GROUP requires recipient_user_group_id', _hint: 'Pass the UID of a userGroup — DHIS2 will deliver dashboard messages to its members.' };
  }
  if (args.recipient === 'PROGRAM_ATTRIBUTE' && !args.recipient_program_attribute_id) {
    return { _error: 'recipient=PROGRAM_ATTRIBUTE requires recipient_program_attribute_id (TEA UID)', _hint: 'TEA must be of valueType EMAIL or PHONE_NUMBER so DHIS2 can infer the deliveryChannel.' };
  }
  if (args.recipient === 'DATA_ELEMENT' && !args.recipient_data_element_id) {
    return { _error: 'recipient=DATA_ELEMENT requires recipient_data_element_id (DE UID)', _hint: 'DE must be of valueType EMAIL or PHONE_NUMBER.' };
  }
  if (isScheduled && (args.relative_scheduled_days == null || isNaN(Number(args.relative_scheduled_days)))) {
    return { _error: `trigger=${args.trigger} requires relative_scheduled_days (integer, negative = before the anchor date)`, _hint: 'e.g. relative_scheduled_days=-3 to fire 3 days before due date.' };
  }

  const payload = {
    name,
    subjectTemplate: subjectTemplate || '',
    messageTemplate,
    notificationTrigger: args.trigger,
    notificationRecipient: args.recipient,
    sendRepeatable: !!args.send_repeatable,
  };
  if (isScheduled) payload.relativeScheduledDays = Number(args.relative_scheduled_days);
  if (args.recipient === 'USER_GROUP') payload.recipientUserGroup = { id: args.recipient_user_group_id };
  if (args.recipient === 'PROGRAM_ATTRIBUTE') payload.recipientProgramAttribute = { id: args.recipient_program_attribute_id };
  if (args.recipient === 'DATA_ELEMENT') payload.recipientDataElement = { id: args.recipient_data_element_id };

  // Only set deliveryChannels for external recipients; the server's postProcess
  // will overwrite it anyway for WEB_HOOK/PROGRAM_ATTRIBUTE/DATA_ELEMENT, but
  // setting for WEB_HOOK up front avoids a transient empty-channels window.
  if (PN_EXTERNAL_RECIPIENTS.has(args.recipient)) {
    if (Array.isArray(args.delivery_channels) && args.delivery_channels.length) {
      payload.deliveryChannels = args.delivery_channels;
    } else if (isWebhook) {
      payload.deliveryChannels = ['HTTP'];
    }
  }

  return { payload, _notes: [
    isWebhook ? 'WEB_HOOK: URL placed in messageTemplate; deliveryChannels=[HTTP] will be enforced by DHIS2 postProcess.' : null,
    isScheduled ? `Scheduled trigger: relativeScheduledDays=${payload.relativeScheduledDays}.` : null,
  ].filter(Boolean) };
}

async function executeManageProgramNotifications(args) {
  const action = args.action;
  if (!action) return { _error: 'Missing required parameter: action', _hint: 'One of: list, get, create, update, delete, link, unlink, create_and_link.' };

  // ── list ──
  if (action === 'list') {
    if (!args.program_id) return { _error: 'program_id required for list', _hint: 'Pass the program UID whose notification templates you want.' };
    const resp = await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}/notificationTemplates?fields=${PN_TEMPLATE_FIELDS}&paging=false`);
    if (resp._error) return { _error: `Failed to list templates: ${resp._error}`, _hint: 'Check the program_id — it must be an existing program UID.' };
    const templates = resp.programNotificationTemplates || resp.notificationTemplates || [];
    return {
      success: true,
      program_id: args.program_id,
      count: templates.length,
      templates,
    };
  }

  // ── get ──
  if (action === 'get') {
    if (!args.template_id) return { _error: 'template_id required for get' };
    const resp = await safeDhis2Fetch(`programNotificationTemplates/${encodeURIComponent(args.template_id)}?fields=${PN_TEMPLATE_FIELDS}`);
    if (resp._error) return { _error: `Failed to fetch template: ${resp._error}`, _hint: 'Verify template_id is a valid UID.' };
    return { success: true, template: resp };
  }

  // ── create ──
  if (action === 'create' || action === 'create_and_link') {
    const _gate = requireWriteAuth('manage_program_notifications', action);
    if (_gate) return _gate;
    const built = _pnBuildCreatePayload(args);
    if (built._error) return built;
    const payload = built.payload;

    // Validate program exists up front to avoid creating orphaned templates.
    if (action === 'create_and_link') {
      if (!args.program_id) return { _error: 'program_id required for create_and_link' };
      const progProbe = await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}?fields=id,name`);
      if (progProbe._error) return { _error: `program_id ${args.program_id} not found: ${progProbe._error}`, _hint: 'Use search_metadata(type="program", query="...") to find the correct UID.' };
    }

    // For USER_GROUP/PROGRAM_ATTRIBUTE/DATA_ELEMENT, probe the referenced UID
    // so we fail fast with a clear error instead of a vague DHIS2 500.
    if (payload.recipientUserGroup) {
      const ugProbe = await safeDhis2Fetch(`userGroups/${encodeURIComponent(payload.recipientUserGroup.id)}?fields=id`);
      if (ugProbe._error) return { _error: `recipient_user_group_id ${payload.recipientUserGroup.id} not found`, _hint: 'Pass a valid userGroup UID.' };
    }
    if (payload.recipientProgramAttribute) {
      const teaProbe = await safeDhis2Fetch(`trackedEntityAttributes/${encodeURIComponent(payload.recipientProgramAttribute.id)}?fields=id,valueType`);
      if (teaProbe._error) return { _error: `recipient_program_attribute_id ${payload.recipientProgramAttribute.id} not found`, _hint: 'Pass a valid TEA UID.' };
      const vt = teaProbe.valueType;
      if (vt !== 'EMAIL' && vt !== 'PHONE_NUMBER') {
        return { _error: `TEA ${payload.recipientProgramAttribute.id} has valueType=${vt}; only EMAIL or PHONE_NUMBER are usable as notification recipients`, _hint: 'Choose a TEA storing an email or phone number.' };
      }
    }
    if (payload.recipientDataElement) {
      const deProbe = await safeDhis2Fetch(`dataElements/${encodeURIComponent(payload.recipientDataElement.id)}?fields=id,valueType`);
      if (deProbe._error) return { _error: `recipient_data_element_id ${payload.recipientDataElement.id} not found`, _hint: 'Pass a valid DE UID.' };
      const vt = deProbe.valueType;
      if (vt !== 'EMAIL' && vt !== 'PHONE_NUMBER') {
        return { _error: `DE ${payload.recipientDataElement.id} has valueType=${vt}; only EMAIL or PHONE_NUMBER are usable as notification recipients`, _hint: 'Choose a DE storing an email or phone number.' };
      }
    }

    // ── Pre-flight dedup (create_and_link only): if a template with the same
    // name is already attached to the target program, return it instead of
    // creating a duplicate. This prevents the "two MCH enrollment templates"
    // class of issue caused by retries after a false-negative link.
    if (action === 'create_and_link') {
      const existing = await safeDhis2Fetch(
        `programs/${encodeURIComponent(args.program_id)}/notificationTemplates?fields=${PN_TEMPLATE_FIELDS}&paging=false`
      );
      const existingList = existing?.programNotificationTemplates || existing?.notificationTemplates || [];
      const match = Array.isArray(existingList) && existingList.find(t => t.name === payload.name);
      if (match) {
        return {
          success: true,
          template_id: match.id,
          linked_to_program: args.program_id,
          template: match,
          _notes: [...(built._notes || []), `Dedup: a template named "${payload.name}" is already linked to this program — returning existing (no duplicate created).`],
        };
      }
    }

    // POST to the programNotificationTemplates collection.
    const createResp = await safeDhis2Fetch('programNotificationTemplates', {
      method: 'POST',
      body: payload,
    });
    if (createResp._error) {
      return {
        _error: `Create failed: ${createResp._error}`,
        _status: createResp._status,
        _body: createResp._body,
        _hint: 'If 409 on subjectTemplate length, shorten message_content/subject_template. If 500 with a property error, the payload shape is correct for DHIS2 2.36+ — check the server version and any custom webhook sender plugin.',
        payload,
      };
    }
    const templateId = createResp.response?.uid || createResp.uid;
    if (!templateId) {
      return { _error: 'Create returned no uid', _raw: createResp, _hint: 'The server response did not include a template UID; the template may not have been persisted.' };
    }

    // Verify the create by reading it back. If the read fails, we have already
    // persisted a template on the server but can't confirm state — attempt a
    // rollback delete so we never leave an unverifiable orphan.
    const verify = await safeDhis2Fetch(`programNotificationTemplates/${templateId}?fields=${PN_TEMPLATE_FIELDS}`);
    if (verify._error) {
      const rb = await safeDhis2Fetch(`programNotificationTemplates/${templateId}`, { method: 'DELETE', allowEmptyBody: true });
      return {
        _error: `Template create verification failed (uid=${templateId}). ${rb._error ? 'Rollback delete also failed.' : 'Rollback delete succeeded — server is clean.'}`,
        rollback: { attempted: true, succeeded: !rb._error, template_id: templateId },
        _hint: rb._error
          ? `Manual cleanup needed: manage_program_notifications(action="delete", template_id="${templateId}"). Rollback error: ${rb._error}`
          : 'Server is clean. Retry the create_and_link call.',
      };
    }

    if (action === 'create') {
      return {
        success: true,
        template_id: templateId,
        template: verify,
        _notes: built._notes,
        _hint: 'Template created but NOT yet linked to any program. Call action="link" with program_id to activate it, or use action="create_and_link" next time.',
      };
    }

    // action === 'create_and_link' → link with retry + auto-rollback.
    // DHIS2's link endpoint returns HTTP 200 with an empty body on success, so
    // we opt into allowEmptyBody and verify by listing the program's
    // notificationTemplates (source-of-truth check, idempotent).
    const tryLink = async () => {
      const resp = await safeDhis2Fetch(
        `programs/${encodeURIComponent(args.program_id)}/notificationTemplates/${templateId}`,
        { method: 'POST', allowEmptyBody: true }
      );
      const vr = await safeDhis2Fetch(
        `programs/${encodeURIComponent(args.program_id)}/notificationTemplates?fields=id&paging=false`
      );
      const lst = vr?.programNotificationTemplates || vr?.notificationTemplates || [];
      return { linked: Array.isArray(lst) && lst.some(t => t.id === templateId), resp };
    };

    let linkAttempt = await tryLink();
    if (!linkAttempt.linked) linkAttempt = await tryLink(); // one retry
    if (!linkAttempt.linked) {
      // Auto-rollback: delete the orphan template so the server goes back to
      // the exact state it was in before this call. This honors the user-stated
      // invariant: "never end up with leftovers when the task doesn't complete".
      const rb = await safeDhis2Fetch(
        `programNotificationTemplates/${templateId}`,
        { method: 'DELETE', allowEmptyBody: true }
      );
      return {
        _error: `Link failed after retry (template ${templateId} could not be attached to program ${args.program_id}). ${linkAttempt.resp?._error || ''}`.trim(),
        rollback: { attempted: true, succeeded: !rb._error, template_id_was: templateId },
        _hint: rb._error
          ? `Rollback delete FAILED — manual cleanup needed: manage_program_notifications(action="delete", template_id="${templateId}"). Rollback error: ${rb._error}`
          : 'Template rolled back (deleted). Server is clean — safe to retry the create_and_link call.',
      };
    }
    return {
      success: true,
      template_id: templateId,
      linked_to_program: args.program_id,
      template: verify,
      _notes: built._notes,
    };
  }

  // ── update ──
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_program_notifications', 'update', { template_id: args.template_id });
    if (_gate) return _gate;
    if (!args.template_id) return { _error: 'template_id required for update' };
    // Verify the template exists before patching.
    const _verify = await verifyTargetExists('programNotificationTemplates', args.template_id, 'manage_program_notifications', 'update');
    if (!_verify.exists) return _verify.refusal;
    // Accept `patch` object OR top-level args — both forms map to the same JSON Patch ops.
    // This avoids the "patch had no recognized keys" dead-end when the model places
    // update keys directly on the call instead of nesting them under `patch`.
    const p = (args.patch && typeof args.patch === 'object') ? { ...args.patch } : {};
    for (const k of ['name', 'subject_template', 'message_template', 'webhook_url', 'message_content', 'trigger', 'recipient', 'send_repeatable', 'relative_scheduled_days', 'url', 'webhookUrl', 'hookUrl', 'endpoint', 'targetUrl']) {
      if (args[k] != null && p[k] == null) p[k] = args[k];
    }
    if (Object.keys(p).length === 0) return { _error: 'No fields to update', _hint: 'Pass either patch={...} or the fields directly (name, webhook_url, trigger, recipient, subject_template, message_template, message_content, send_repeatable, relative_scheduled_days). Do NOT use "url" — DHIS2 has no such field; pass webhook_url which writes to messageTemplate.' };
    // Translate friendly keys → DHIS2 property names.
    const map = [];
    const reject = [];
    if (p.name != null) map.push(['name', p.name]);
    if (p.subject_template != null) {
      if (String(p.subject_template).length > 100) reject.push('subject_template >100 chars');
      else map.push(['subjectTemplate', p.subject_template]);
    }
    if (p.message_template != null) {
      if (String(p.message_template).length > 10000) reject.push('message_template >10000 chars');
      else map.push(['messageTemplate', p.message_template]);
    }
    if (p.webhook_url != null) {
      if (!/^https?:\/\//i.test(p.webhook_url)) reject.push('webhook_url must be http(s)');
      else map.push(['messageTemplate', p.webhook_url]);
    }
    if (p.message_content != null) map.push(['subjectTemplate', String(p.message_content).slice(0, 100)]);
    if (p.trigger != null) map.push(['notificationTrigger', p.trigger]);
    if (p.recipient != null) map.push(['notificationRecipient', p.recipient]);
    if (p.send_repeatable != null) map.push(['sendRepeatable', !!p.send_repeatable]);
    if (p.relative_scheduled_days != null) map.push(['relativeScheduledDays', Number(p.relative_scheduled_days)]);
    if ('url' in p || 'webhookUrl' in p || 'hookUrl' in p || 'endpoint' in p || 'targetUrl' in p) {
      reject.push('DHIS2 has no url/webhookUrl/hookUrl/endpoint/targetUrl field — use webhook_url (which writes to messageTemplate)');
    }
    if (reject.length) return { _error: `Invalid patch keys: ${reject.join('; ')}`, _hint: 'See the tool description for supported keys.' };
    if (!map.length) return { _error: 'patch had no recognized keys', _hint: 'Supported: name, subject_template, message_template, webhook_url, message_content, trigger, recipient, send_repeatable, relative_scheduled_days.' };

    // Snapshot the template BEFORE patching.
    const updateBackup = await ensureBackupOrBail(
      { operation: 'update', tool: 'manage_program_notifications', action: 'update', reason: `Updating notification template ${args.template_id}` },
      [{ object_type: 'programNotificationTemplates', object_id: args.template_id, role: 'primary' }],
      args
    );
    if (!updateBackup.ok) return updateBackup.error;

    // Build RFC 6902 JSON Patch
    const patchOps = map.map(([k, v]) => ({ op: 'replace', path: '/' + k, value: v }));
    const patchResp = await safeDhis2Fetch(`programNotificationTemplates/${encodeURIComponent(args.template_id)}`, {
      method: 'PATCH',
      body: patchOps,
    });
    if (patchResp._error) {
      return { _error: `Patch failed: ${patchResp._error}`, _status: patchResp._status, _body: patchResp._body, _hint: 'PATCH uses application/json-patch+json — the tool sets this automatically. 400 usually means you tried to write a property that does not exist on the schema.', backup: updateBackup.block };
    }
    const verify = await safeDhis2Fetch(`programNotificationTemplates/${encodeURIComponent(args.template_id)}?fields=${PN_TEMPLATE_FIELDS}`);
    return { success: true, template_id: args.template_id, applied_ops: patchOps, template: verify, backup: updateBackup.block };
  }

  // ── delete ──
  if (action === 'delete') {
    if (!args.template_id) return { _error: 'template_id required for delete' };

    const _gate = requireWriteAuth('manage_program_notifications', 'delete', { template_id: args.template_id });
    if (_gate) return _gate;
    const _verify = await verifyTargetExists('programNotificationTemplates', args.template_id, 'manage_program_notifications', 'delete');
    if (!_verify.exists) return _verify.refusal;

    const deleteBackup = await ensureBackupOrBail(
      { operation: 'delete', tool: 'manage_program_notifications', action: 'delete', reason: `Deleting notification template ${args.template_id}` },
      [{ object_type: 'programNotificationTemplates', object_id: args.template_id, role: 'primary' }],
      args
    );
    if (!deleteBackup.ok) return deleteBackup.error;

    const delResp = await safeDhis2Fetch(`programNotificationTemplates/${encodeURIComponent(args.template_id)}`, { method: 'DELETE' });
    if (delResp._error) return { _error: `Delete failed: ${delResp._error}`, _hint: 'If the template is still linked to a program, DHIS2 will usually still delete it (the link is removed too). A 404 means it was already gone.', backup: deleteBackup.block };
    return { success: true, template_id: args.template_id, message: 'Template deleted.', backup: deleteBackup.block };
  }

  // ── link ──
  if (action === 'link') {
    const _gate = requireWriteAuth('manage_program_notifications', 'link', { program_id: args.program_id, template_id: args.template_id });
    if (_gate) return _gate;
    if (!args.program_id) return { _error: 'program_id required for link' };
    if (!args.template_id) return { _error: 'template_id required for link' };
    // DHIS2's link endpoint returns HTTP 200 with empty body on success — opt into
    // allowEmptyBody and then GET-verify against the program's templates list.
    await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}/notificationTemplates/${encodeURIComponent(args.template_id)}`, { method: 'POST', allowEmptyBody: true });
    const verify = await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}/notificationTemplates?fields=id&paging=false`);
    const list = verify?.programNotificationTemplates || verify?.notificationTemplates || [];
    const linked = Array.isArray(list) && list.some(t => t.id === args.template_id);
    if (!linked) return { _error: `Link verification failed: template ${args.template_id} is not in program ${args.program_id}.`, _hint: 'Verify both UIDs exist. A 404 on POST typically means either the program or the template UID is wrong.' };
    return { success: true, program_id: args.program_id, template_id: args.template_id, linked: true };
  }

  // ── unlink ──
  if (action === 'unlink') {
    const _gate = requireWriteAuth('manage_program_notifications', 'unlink', { program_id: args.program_id, template_id: args.template_id });
    if (_gate) return _gate;
    if (!args.program_id) return { _error: 'program_id required for unlink' };
    if (!args.template_id) return { _error: 'template_id required for unlink' };
    await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}/notificationTemplates/${encodeURIComponent(args.template_id)}`, { method: 'DELETE', allowEmptyBody: true });
    const verify = await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}/notificationTemplates?fields=id&paging=false`);
    const list = verify?.programNotificationTemplates || verify?.notificationTemplates || [];
    const stillLinked = Array.isArray(list) && list.some(t => t.id === args.template_id);
    if (stillLinked) return { _error: `Unlink verification failed: template ${args.template_id} is still attached to program ${args.program_id}.`, _hint: 'If the endpoint returned 404 the template was not attached in the first place; otherwise retry or check admin access.' };
    return { success: true, program_id: args.program_id, template_id: args.template_id, unlinked: true };
  }

  // ── orphan_sweep ── find templates not linked to any program or stage
  if (action === 'orphan_sweep') {
    // Source of truth for "linked": a template UID appears in
    // programs[].notificationTemplates OR programStages[].notificationTemplates.
    const [progs, stages, all] = await Promise.all([
      safeDhis2Fetch('programs?fields=id,name,notificationTemplates%5Bid%5D&paging=false'),
      safeDhis2Fetch('programStages?fields=id,name,notificationTemplates%5Bid%5D&paging=false'),
      safeDhis2Fetch(`programNotificationTemplates?fields=id,name,notificationTrigger,notificationRecipient,created,lastUpdated&paging=false`),
    ]);
    if (progs._error) return { _error: `orphan_sweep: failed to list programs: ${progs._error}` };
    if (stages._error) return { _error: `orphan_sweep: failed to list programStages: ${stages._error}` };
    if (all._error) return { _error: `orphan_sweep: failed to list templates: ${all._error}` };

    const linkedIds = new Set();
    for (const p of (progs.programs || [])) for (const t of (p.notificationTemplates || [])) linkedIds.add(t.id);
    for (const s of (stages.programStages || [])) for (const t of (s.notificationTemplates || [])) linkedIds.add(t.id);

    const templates = all.programNotificationTemplates || [];
    const orphans = templates.filter(t => !linkedIds.has(t.id));

    if (!args.delete) {
      return {
        success: true,
        total_templates: templates.length,
        linked_count: templates.length - orphans.length,
        orphans_found: orphans.length,
        orphans,
        _hint: orphans.length
          ? 'Re-run with delete=true to remove these orphans. Each has never been attached to any program or stage.'
          : 'No orphaned notification templates on this server.',
      };
    }

    // delete=true → snapshot every orphan in one batch BEFORE deleting any.
    if (orphans.length > BULK_DELETE_SOFT_CAP && args.acknowledge_large_bulk !== true) {
      return {
        _error: `Refusing to delete ${orphans.length} orphan template(s) in one sweep — soft cap is ${BULK_DELETE_SOFT_CAP}. List the IDs to the user, get an explicit "yes", then retry with acknowledge_large_bulk:true.`,
        orphans_found: orphans.length,
        first_30_orphans: orphans.slice(0, 30),
        _hint: `Add acknowledge_large_bulk:true to authorize a sweep larger than ${BULK_DELETE_SOFT_CAP} items.`,
      };
    }
    const sweepBackup = await ensureBackupOrBail(
      { operation: 'orphan_sweep', tool: 'manage_program_notifications', action: 'orphan_sweep', reason: `Deleting ${orphans.length} orphan notification template(s)` },
      orphans.map((o) => ({ object_type: 'programNotificationTemplates', object_id: o.id, role: 'primary' })),
      args
    );
    if (!sweepBackup.ok) return sweepBackup.error;

    const deleted = [];
    const failed = [];
    for (const o of orphans) {
      const d = await safeDhis2Fetch(`programNotificationTemplates/${encodeURIComponent(o.id)}`, { method: 'DELETE', allowEmptyBody: true });
      if (d._error) failed.push({ id: o.id, name: o.name, error: d._error });
      else deleted.push({ id: o.id, name: o.name });
    }
    return {
      success: failed.length === 0,
      orphans_found: orphans.length,
      deleted_count: deleted.length,
      deleted,
      failed_count: failed.length,
      failed,
      _hint: failed.length ? 'Some deletes failed — inspect `failed[]` for details.' : 'All orphans cleaned.',
      backup: sweepBackup.block,
    };
  }

  return { _error: `Unknown action: ${action}`, _hint: 'One of: list, get, create, update, delete, link, unlink, create_and_link, orphan_sweep.' };
}

// ────────────────────────────────────────────────────────────────────────────
// manage_program_rules — Full CRUD for program rules, variables and actions
// ────────────────────────────────────────────────────────────────────────────

// Validate a program rule condition via DHIS2's own parser. This catches syntax
// and reference errors that local linting cannot model perfectly.
async function validateProgramRuleCondition(condition, programId) {
  if (!dhis2.baseUrl || !dhis2.apiVersion) {
    const ok = await ensureConnected();
    if (!ok) return { _error: 'Not connected to DHIS2' };
  }
  const url = `${dhis2.baseUrl}/api/${dhis2.apiVersion}/programRules/condition/description?programId=${encodeURIComponent(programId)}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'text/plain',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: condition || '',
    });
    const bodyText = await resp.text().catch(() => '');
    if (!resp.ok) {
      try {
        const parsed = JSON.parse(bodyText);
        return { _error: parsed.message || parsed.description || `HTTP ${resp.status}`, _status: resp.status };
      } catch {
        return { _error: `HTTP ${resp.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`, _status: resp.status };
      }
    }
    try { return JSON.parse(bodyText); } catch { return { status: 'OK', description: bodyText }; }
  } catch (e) {
    return { _error: `Validation fetch failed: ${e.message}` };
  }
}

function getProgramRuleExpressionRefs(text) {
  const s = String(text || '');
  const hash = [...s.matchAll(/#\{([^}]+)\}/g)].map(m => m[1]);
  const tea = [...s.matchAll(/A\{([^}]+)\}/g)].map(m => m[1]);
  return { hash, tea };
}

async function executeManageProgramRules(args, ctxProgramId) {
  const action = args.action;
  if (!action) return { _error: 'Missing required parameter: action' };

  const programId = args.program_id || ctxProgramId;

  // ── list ──
  if (action === 'list') {
    if (!programId) return { _error: 'program_id required for list' };
    const [rulesResp, varsResp] = await Promise.all([
      safeDhis2Fetch(
        `programRules?filter=program.id:eq:${programId}&fields=id,name,condition,priority,description,programRuleActions[id,programRuleActionType,content,data,evaluationTime,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]]&pageSize=100&order=priority:asc`
      ),
      safeDhis2Fetch(
        `programRuleVariables?filter=program.id:eq:${programId}&fields=id,name,programRuleVariableSourceType,valueType,useCodeForOptionSet,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]&pageSize=100`
      ),
    ]);
    if (rulesResp._error) return rulesResp;
    return {
      programRules: rulesResp.programRules || [],
      programRuleVariables: varsResp._error ? [] : (varsResp.programRuleVariables || []),
      total_rules: rulesResp._pagerInfo?.total ?? (rulesResp.programRules || []).length,
      _note: 'Use action=get with rule_id for full action details on a specific rule.',
    };
  }

  // ── list_variables ──
  if (action === 'list_variables') {
    if (!programId) return { _error: 'program_id required for list_variables' };
    return safeDhis2Fetch(
      `programRuleVariables?filter=program.id:eq:${programId}&fields=id,name,programRuleVariableSourceType,valueType,useCodeForOptionSet,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]&pageSize=100`
    );
  }

  // ── get ──
  if (action === 'get') {
    if (!args.rule_id) return { _error: 'rule_id required for get' };
    return safeDhis2Fetch(
      `programRules/${args.rule_id}?fields=id,name,condition,priority,description,program[id,displayName],programRuleActions[id,programRuleActionType,content,data,evaluationTime,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName],programStageSection[id,displayName]]`
    );
  }

  // ── create ──
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_program_rules', 'create');
    if (_gate) return _gate;
    if (!programId) return { _error: 'program_id required for create' };
    const rulesToCreate = args.rules || (args.rule ? [args.rule] : null);
    if (!rulesToCreate?.length) return { _error: 'rule object or rules array required for create' };
    return await _buildAndPostProgramRules(programId, rulesToCreate, args.dry_run_only);
  }

  // ── update ──
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_program_rules', 'update', { rule_id: args.rule_id });
    if (_gate) return _gate;
    if (!args.rule_id) return { _error: 'rule_id required for update' };
    if (!args.rule) return { _error: 'rule object (with fields to change) required for update' };

    // Verify the rule exists BEFORE touching it. 404 → STOP, do not invent context.
    const _verify = await verifyTargetExists('programRules', args.rule_id, 'manage_program_rules', 'update',
      'id,name,condition,priority,description,program[id],programRuleActions[id,programRuleActionType,content,data,evaluationTime,dataElement[id],trackedEntityAttribute[id],programStage[id]]');
    if (!_verify.exists) return _verify.refusal;
    const existing = _verify.data;

    const merged = {
      name:        args.rule.name        ?? existing.name,
      condition:   args.rule.condition   ?? existing.condition,
      description: args.rule.description ?? existing.description,
      priority:    args.rule.priority    ?? existing.priority,
      variables:   args.rule.variables   || [],
      // New actions array replaces all old actions when provided; otherwise keep existing
      actions:     args.rule.actions     || null,
    };

    const oldActionIds = (existing.programRuleActions || []).map(a => a.id);
    const pid = existing.program?.id || programId;

    const allPRVs = [];
    const allPRAs = [];

    // Build variables if any
    for (const v of (merged.variables || [])) {
      const prvUid = generateDhis2Uid();
      const prv = {
        id: prvUid,
        name: v.name,
        program: { id: pid },
        programRuleVariableSourceType: v.source_type || 'DATAELEMENT_NEWEST_EVENT_PROGRAM',
        valueType: v.value_type || 'TEXT',
        useCodeForOptionSet: v.use_code_for_option_set || false,
      };
      if (v.data_element_id) prv.dataElement = { id: v.data_element_id };
      if (v.tei_attribute_id) prv.trackedEntityAttribute = { id: v.tei_attribute_id };
      if (v.program_stage_id) prv.programStage = { id: v.program_stage_id };
      allPRVs.push(prv);
    }

    // Resolve any action target display names → UIDs (same as the create path).
    // Without this a name-targeted ASSIGN/SETMANDATORYFIELD/HIDEFIELD would save
    // target-less and DHIS2 would reject the whole update.
    if (merged.actions) {
      const _res = await resolveRuleActionTargetNames(pid, merged.actions);
      if (_res.unresolved && _res.unresolved.length) {
        return {
          _error: `Rule action target name(s) could not be resolved on this program: ${_res.unresolved.map(u => `${u.kind} "${u.name}"`).join(', ')}.`,
          _hint: 'Pass the exact data element / attribute display name as it appears on this program, or pass the UID directly (data_element_id / tei_attribute_id).',
        };
      }
    }

    // Visibility semantics on the merged rule: refuse an update that would
    // leave the rule hiding + mandating the same field, or "showing" a field
    // by hiding it (same checks as create — see lintRuleVisibilitySemantics).
    if (merged.actions) {
      const semanticErrors = lintRuleVisibilitySemantics([
        { name: merged.name, condition: merged.condition, actions: merged.actions },
      ]);
      if (semanticErrors.length) {
        return {
          success: false,
          _error: `Program rule semantics lint failed: ${semanticErrors.join(' | ')}`,
          phase: 'lint',
          errors: semanticErrors,
          _hint: 'Rewrite as ONE hide rule per target (condition = the HIDE case); mandatory-when-visible goes in a separate SETMANDATORYFIELD-only rule with the positive condition. Then retry.',
        };
      }
    }

    // Token resolution on the UPDATED condition / action data. Without this,
    // an update whose new condition references #{a_de_never_variable_ized}
    // saves fine but the rule silently never fires — the same failure class
    // the create paths already refuse. Display-name tokens are auto-rewritten
    // to canonical form; tokens that resolve to a program DE/TEA get their
    // PRV auto-created; genuinely unknown tokens refuse the update.
    const tokenRewrites = [];
    if (args.rule.condition !== undefined || (merged.actions || []).some(a => a.data)) {
      const [progStructResp, prvResp] = await Promise.all([
        safeDhis2Fetch(`programs/${pid}?fields=programStages%5Bid,programStageDataElements%5BdataElement%5Bid,displayName,valueType,optionSet%5Bid%5D%5D%5D%5D,programTrackedEntityAttributes%5BtrackedEntityAttribute%5Bid,displayName,valueType,optionSet%5Bid%5D%5D%5D`),
        safeDhis2Fetch(`programRuleVariables?filter=program.id:eq:${pid}&fields=id,name&pageSize=200`),
      ]);
      if (!progStructResp._error && !prvResp._error) {
        const deInfo = new Map();   // displayName → {id, valueType, optionSet, stageId}
        for (const ps of (progStructResp.programStages || [])) {
          for (const psde of (ps.programStageDataElements || [])) {
            const de = psde.dataElement;
            if (de?.id && !deInfo.has(de.displayName)) deInfo.set(de.displayName, { ...de, stageId: ps.id });
          }
        }
        const teaInfo = new Map();
        for (const ptea of (progStructResp.programTrackedEntityAttributes || [])) {
          const tea = ptea.trackedEntityAttribute;
          if (tea?.id) teaInfo.set(tea.displayName, tea);
        }
        const existingVarNames = new Set((prvResp.programRuleVariables || []).map(v => v.name));
        for (const v of (merged.variables || [])) if (v.name) existingVarNames.add(v.name);
        const pseudoRule = { name: merged.name, condition: merged.condition, actions: merged.actions || [] };
        const { bindings, unresolved, rewrites } = resolveRuleTokenBindings(
          pseudoRule, [...deInfo.keys()], [...teaInfo.keys()], existingVarNames
        );
        if (unresolved.length) {
          return {
            success: false,
            phase: 'lint',
            _error: `Updated rule "${merged.name}" references unresolved variable(s): ${unresolved.join(', ')} — no program rule variable, data element or attribute of this program matches. The rule would save but NEVER fire. Nothing was changed.`,
            unresolved,
            available_variables: [...existingVarNames].map(n => `#{${n}}`),
            available_data_elements: [...deInfo.keys()].map(n => `#{${sanitizeVariableName(n)}}`),
            available_attributes: [...teaInfo.keys()].map(n => `A{${sanitizeVariableName(n)}}`),
            _hint: 'Reference an existing program rule variable, or #{sanitized_data_element_name} / A{sanitized_attribute_name} of this program. Fix the token(s) and retry.',
          };
        }
        merged.condition = pseudoRule.condition;
        tokenRewrites.push(...rewrites);
        // Auto-create the PRVs the (re)written expression needs.
        for (const b of bindings) {
          if (b.kind === 'de') {
            const de = deInfo.get(b.name);
            allPRVs.push({
              id: generateDhis2Uid(), name: b.token, program: { id: pid },
              programRuleVariableSourceType: 'DATAELEMENT_NEWEST_EVENT_PROGRAM',
              valueType: de.valueType || 'TEXT',
              useCodeForOptionSet: !!de.optionSet,
              dataElement: { id: de.id },
              ...(de.stageId ? { programStage: { id: de.stageId } } : {}),
            });
          } else {
            const tea = teaInfo.get(b.name);
            allPRVs.push({
              id: generateDhis2Uid(), name: b.token, program: { id: pid },
              programRuleVariableSourceType: 'TEI_ATTRIBUTE',
              valueType: tea.valueType || 'TEXT',
              useCodeForOptionSet: !!tea.optionSet,
              trackedEntityAttribute: { id: tea.id },
            });
          }
        }
      }
    }

    // Decide which actions to use
    const actionsToPost = merged.actions
      ? merged.actions  // new set provided — will replace all old ones
      : (existing.programRuleActions || []).map(a => ({
          // re-use existing actions unchanged
          _existingId: a.id,
          type: a.programRuleActionType,
          content: a.content,
          data: a.data,
          data_element_id: a.dataElement?.id,
          tei_attribute_id: a.trackedEntityAttribute?.id,
          program_stage_id: a.programStage?.id,
          evaluation_time: a.evaluationTime,
        }));

    // Reuse the existing action UIDs positionally when a new actions array is
    // provided: the metadata import (mergeMode REPLACE) then UPDATES each old
    // row in place — type/content/target all swap cleanly — instead of
    // creating new rows and orphaning the old ones. The orphan-delete used to
    // 409 ("could not automatically delete the old action") and leave junk
    // programRuleAction rows behind; with ID reuse the common N→N action swap
    // produces zero orphans and zero DELETE calls.
    const reusableOldIds = merged.actions ? [...oldActionIds] : [];
    const newActionIds = [];
    for (const act of actionsToPost) {
      const praId = act._existingId || reusableOldIds.shift() || generateDhis2Uid();
      newActionIds.push(praId);
      const pra = {
        id: praId,
        programRule: { id: args.rule_id },
        programRuleActionType: act.type,
        evaluationTime: act.evaluation_time || 'ON_DATA_ENTRY',
      };
      if (act.content) pra.content = act.content;
      if (act.data) pra.data = act.data;
      if (act.data_element_id) pra.dataElement = { id: act.data_element_id };
      if (act.tei_attribute_id) pra.trackedEntityAttribute = { id: act.tei_attribute_id };
      if (act.program_stage_id) pra.programStage = { id: act.program_stage_id };
      if (act.program_stage_section_id) pra.programStageSection = { id: act.program_stage_section_id };
      allPRAs.push(pra);
    }

    const updatedRule = {
      id: args.rule_id,
      name: merged.name,
      program: { id: pid },
      condition: merged.condition || 'true',
      programRuleActions: newActionIds.map(id => ({ id })),
    };
    if (merged.description !== undefined) updatedRule.description = merged.description;
    if (merged.priority !== undefined) updatedRule.priority = merged.priority;

    const payload = {};
    if (allPRVs.length) payload.programRuleVariables = allPRVs;
    if (allPRAs.length) payload.programRuleActions = allPRAs;
    payload.programRules = [updatedRule];

    // Lint the merged condition the same way create does.
    const lintErr = lintProgramRuleCondition(updatedRule.condition, updatedRule.name);
    if (lintErr) {
      return {
        success: false,
        _error: `Program rule condition lint failed: ${lintErr}`,
        phase: 'lint',
        errors: [lintErr],
        _hint: 'Fix the condition using the suggested canonical form, then retry.',
      };
    }

    if (args.dry_run_only) {
      return { success: true, phase: 'dry_run', message: 'Dry run only. No changes committed.', would_update: updatedRule };
    }

    // Snapshot the rule and every action it references (including any old
    // actions that this update will orphan-delete) so a restore can rebuild
    // the full rule structure.
    const ruleBackupTargets = [
      { object_type: 'programRules', object_id: args.rule_id, role: 'primary' },
      ...oldActionIds.map((aid) => ({ object_type: 'programRuleActions', object_id: aid, role: 'cascade' })),
    ];
    const backup = await ensureBackupOrBail(
      { operation: 'update', tool: 'manage_program_rules', action: 'update', reason: `Updating program rule ${merged.name || args.rule_id}` },
      ruleBackupTargets,
      args
    );
    if (!backup.ok) return backup.error;

    const result = await postMetadataPayload(payload, false);

    // Delete surplus old actions the update no longer uses (only possible when
    // the new actions array is SHORTER than the old one — equal/longer arrays
    // reuse every old UID in place and leave nothing to clean up).
    const orphan_cleanup = { attempted: [], deleted: [], failed: [] };
    if (result.success && merged.actions && oldActionIds.length) {
      const toDelete = oldActionIds.filter(id => !newActionIds.includes(id));
      orphan_cleanup.attempted = toDelete;
      for (const aid of toDelete) {
        let d = await safeDhis2Fetch(`programRuleActions/${aid}`, { method: 'DELETE', allowEmptyBody: true });
        if (d._error) {
          // Raw DELETE on programRuleActions can 409 right after the rule
          // import; the metadata import path handles the reference bookkeeping
          // and succeeds where the raw endpoint conflicts.
          d = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL',
            { method: 'POST', body: { programRuleActions: [{ id: aid }] } });
        }
        if (d._error) orphan_cleanup.failed.push({ id: aid, error: d._error });
        else orphan_cleanup.deleted.push(aid);
      }
    }

    const response = { ...result, updated_rule_id: args.rule_id, rule_name: merged.name, backup: backup.block };
    if (tokenRewrites.length) response.rule_token_rewrites = tokenRewrites;
    if (orphan_cleanup.attempted.length) {
      response.orphan_cleanup = orphan_cleanup;
      if (orphan_cleanup.failed.length) {
        response._hint = `Rule update succeeded but ${orphan_cleanup.failed.length} old programRuleAction row(s) could not be deleted — they are now orphaned. Inspect orphan_cleanup.failed and delete manually via dhis2_query DELETE programRuleActions/{id}.`;
      }
    }
    return response;
  }

  // ── delete ──
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_program_rules', 'delete', { rule_id: args.rule_id });
    if (_gate) return _gate;
    if (!args.rule_id) return { _error: 'rule_id required for delete' };

    // Verify the rule exists BEFORE deleting. 404 → STOP, do not invent context.
    const _verify = await verifyTargetExists('programRules', args.rule_id, 'manage_program_rules', 'delete');
    if (!_verify.exists) return _verify.refusal;

    // Snapshot the rule (and its actions) so a restore can recreate the full structure.
    const backup = await ensureBackupOrBail(
      { operation: 'delete', tool: 'manage_program_rules', action: 'delete', reason: `Deleting program rule ${args.rule_id}` },
      [{ object_type: 'programRules', object_id: args.rule_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const resp = await safeDhis2Fetch(`programRules/${args.rule_id}`, { method: 'DELETE' });
    if (resp._error) return { ...resp, backup: backup.block };
    return { success: true, deleted_rule_id: args.rule_id, backup: backup.block };
  }

  // ── audit ──
  // Scan every rule + variable in a program and report structural problems that stop rules
  // firing at runtime. Does NOT commit any change — returns issues + fix hints.
  if (action === 'audit') {
    if (!programId) return { _error: 'program_id required for audit' };
    const deep = args.deep !== false;

    // Paginate rules + actions (pageCount-driven so we never miss a page)
    const PAGE_SIZE = 100;
    const allRules = [];
    const ruleFirst = await safeDhis2Fetch(
      `programRules?filter=program.id:eq:${programId}&fields=id,name,condition,priority,description,programStage[id,displayName],programRuleActions[id,programRuleActionType,content,data,evaluationTime,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName],programStageSection[id,displayName]]&pageSize=${PAGE_SIZE}&page=1&order=name:asc&totalPages=true`,
      { noTruncate: true }
    );
    if (ruleFirst._error) return ruleFirst;
    allRules.push(...(ruleFirst.programRules || []));
    const totalRules = ruleFirst.pager?.total ?? allRules.length;
    const rulePageCount = ruleFirst.pager?.pageCount ?? 1;
    const fetchErrors = [];
    for (let p = 2; p <= Math.min(rulePageCount, 50); p++) {
      const resp = await safeDhis2Fetch(
        `programRules?filter=program.id:eq:${programId}&fields=id,name,condition,priority,description,programStage[id,displayName],programRuleActions[id,programRuleActionType,content,data,evaluationTime,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName],programStageSection[id,displayName]]&pageSize=${PAGE_SIZE}&page=${p}&order=name:asc`,
        { noTruncate: true }
      );
      if (resp._error) { fetchErrors.push({ kind: 'rules', page: p, error: resp._error }); continue; }
      allRules.push(...(resp.programRules || []));
    }

    // Variables
    const allVars = [];
    const varFirst = await safeDhis2Fetch(
      `programRuleVariables?filter=program.id:eq:${programId}&fields=id,name,programRuleVariableSourceType,valueType,useCodeForOptionSet,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]&pageSize=${PAGE_SIZE}&page=1&order=name:asc&totalPages=true`,
      { noTruncate: true }
    );
    if (varFirst._error) {
      fetchErrors.push({ kind: 'variables', error: varFirst._error });
    } else {
      allVars.push(...(varFirst.programRuleVariables || []));
      const varPageCount = varFirst.pager?.pageCount ?? 1;
      for (let p = 2; p <= Math.min(varPageCount, 50); p++) {
        const resp = await safeDhis2Fetch(
          `programRuleVariables?filter=program.id:eq:${programId}&fields=id,name,programRuleVariableSourceType,valueType,useCodeForOptionSet,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]&pageSize=${PAGE_SIZE}&page=${p}&order=name:asc`,
          { noTruncate: true }
        );
        if (resp._error) { fetchErrors.push({ kind: 'variables', page: p, error: resp._error }); continue; }
        allVars.push(...(resp.programRuleVariables || []));
      }
    }
    const varByName = new Map();
    for (const v of allVars) varByName.set(v.name, v);

    // Program structure — for validating DE / TEA / stage / section references.
    // PSDE compulsory included so we can flag HIDEFIELD-on-compulsory (DHIS2 New
    // Tracker Capture refuses to visually hide a compulsory DE — exactly the
    // "5 unhidden" failure mode users hit when HIDEALLFIELDS is asked of stages
    // whose DEs are compulsory).
    const progResp = await safeDhis2Fetch(
      `programs/${programId}?fields=id,programStages[id,displayName,programStageDataElements[id,compulsory,dataElement[id,displayName]],programStageSections[id,displayName]],programTrackedEntityAttributes[trackedEntityAttribute[id,displayName]]`,
      { noTruncate: true }
    );
    const validStageIds = new Set();
    const validDeIds = new Set();
    const validTeaIds = new Set();
    const validSectionIds = new Set();
    const compulsoryDeIds = new Set(); // DE ids with compulsory=true on at least one PSDE
    let structureAvailable = false;
    if (!progResp._error) {
      structureAvailable = true;
      for (const stage of (progResp.programStages || [])) {
        validStageIds.add(stage.id);
        for (const psde of (stage.programStageDataElements || [])) {
          if (psde.dataElement?.id) {
            validDeIds.add(psde.dataElement.id);
            if (psde.compulsory) compulsoryDeIds.add(psde.dataElement.id);
          }
        }
        for (const sec of (stage.programStageSections || [])) {
          if (sec.id) validSectionIds.add(sec.id);
        }
      }
      for (const ptea of (progResp.programTrackedEntityAttributes || [])) {
        if (ptea.trackedEntityAttribute?.id) validTeaIds.add(ptea.trackedEntityAttribute.id);
      }
    }

    // Action types that require each of the target fields
    const NEEDS_CONTENT = new Set(['SHOWWARNING', 'SHOWERROR', 'DISPLAYTEXT', 'WARNINGONCOMPLETE', 'ERRORONCOMPLETE']);
    const NEEDS_DATA = new Set(['ASSIGN']);
    const NEEDS_DE_OR_TEA = new Set(['HIDEFIELD', 'SETMANDATORYFIELD']);
    const NEEDS_STAGE = new Set(['HIDEPROGRAMSTAGE', 'CREATEEVENT']);
    const NEEDS_SECTION = new Set(['HIDESECTION']);

    const ruleIssues = [];
    const varIssues = [];

    // ── Rule-level scan ──
    for (const rule of allRules) {
      const probs = [];
      const cond = rule.condition || '';

      if (!cond.trim()) {
        probs.push('Empty condition — rule will never fire.');
      } else {
        const lintErr = lintProgramRuleCondition(cond, null);
        if (lintErr) probs.push(`Condition lint: ${lintErr}`);
      }

      // #{var} references must resolve to a programRuleVariable
      const hashRefs = getProgramRuleExpressionRefs(cond).hash;
      const seenHash = new Set();
      for (const varName of hashRefs) {
        if (seenHash.has(varName)) continue;
        seenHash.add(varName);
        if (!varByName.has(varName)) {
          probs.push(`Condition references unknown variable #{${varName}} — no programRuleVariable with that name exists in this program.`);
        }
      }

      // A{attr} references must resolve to a program TEA (by UID — 11-char DHIS2 UID)
      const teaRefs = getProgramRuleExpressionRefs(cond).tea;
      const seenTea = new Set();
      for (const ref of teaRefs) {
        if (seenTea.has(ref)) continue;
        seenTea.add(ref);
        if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(ref)) {
          if (structureAvailable && !validTeaIds.has(ref)) {
            probs.push(`Condition references tracked-entity attribute not on this program: A{${ref}}`);
          }
        }
        // A{name} form is also legal — skipped; the engine resolves by name
      }

      // Balanced braces/parens
      let dp = 0, db = 0;
      for (const c of cond) {
        if (c === '(') dp++; else if (c === ')') dp--;
        else if (c === '{') db++; else if (c === '}') db--;
        if (dp < 0 || db < 0) break;
      }
      if (dp !== 0) probs.push('Unbalanced parentheses in condition.');
      if (db !== 0) probs.push('Unbalanced braces in condition.');

      // Actions — each must have the fields its type demands, and refs must resolve.
      const actions = rule.programRuleActions || [];
      if (actions.length === 0) {
        probs.push('No programRuleActions — rule has nothing to do even if condition fires.');
      }
      for (const a of actions) {
        const t = a.programRuleActionType;
        const deId = a.dataElement?.id;
        const teaId = a.trackedEntityAttribute?.id;
        const stageId = a.programStage?.id;
        const sectionId = a.programStageSection?.id;

        if (NEEDS_CONTENT.has(t) && !String(a.content || '').trim() && !String(a.data || '').trim()) {
          probs.push(`${t} action ${a.id} has no content — warning/error/display will be blank.`);
        }
        // Variable refs in `content` are shown literally (DHIS2 only evaluates `data`).
        if (NEEDS_CONTENT.has(t) && t !== 'DISPLAYTEXT' && /[#A]\{[^}]+\}/.test(String(a.content || ''))) {
          probs.push(`${t} action ${a.id} has variable refs in content — DHIS2 will display the literal "#{var}" / "A{attr}" tokens. Move dynamic refs to the data field (e.g. content="Selected:" + data="#{my_de}", or data="d2:concatenate(\\"prefix \\", #{a}, \\", \\", #{b})"). Fix via manage_program_rules(action=update) or bulk_fix_conditions can't help here — this is an action-level fix.`);
        }
        if (NEEDS_DATA.has(t) && !String(a.data || '').trim()) {
          probs.push(`${t} action ${a.id} has no data expression — ASSIGN cannot compute a value.`);
        }
        if (String(a.data || '').trim()) {
          const refs = getProgramRuleExpressionRefs(a.data);
          const seenActionHash = new Set();
          for (const varName of refs.hash) {
            if (seenActionHash.has(varName)) continue;
            seenActionHash.add(varName);
            if (!varByName.has(varName)) {
              probs.push(`${t} action ${a.id} data references unknown variable #{${varName}} — no programRuleVariable with that name exists in this program.`);
            }
          }
          const seenActionTea = new Set();
          for (const ref of refs.tea) {
            if (seenActionTea.has(ref)) continue;
            seenActionTea.add(ref);
            if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(ref) && structureAvailable && !validTeaIds.has(ref)) {
              probs.push(`${t} action ${a.id} data references tracked-entity attribute not on this program: A{${ref}}`);
            }
          }
        }
        if (NEEDS_DE_OR_TEA.has(t) && !deId && !teaId) {
          probs.push(`${t} action ${a.id} has neither dataElement nor trackedEntityAttribute target — it will not apply to any field.`);
        }
        if (NEEDS_STAGE.has(t) && !stageId) {
          probs.push(`${t} action ${a.id} has no programStage target.`);
        }
        if (NEEDS_SECTION.has(t) && !sectionId) {
          probs.push(`${t} action ${a.id} has no programStageSection target.`);
        }

        if (structureAvailable) {
          if (deId && !validDeIds.has(deId)) {
            probs.push(`${t} action ${a.id} targets dataElement ${deId} which is not on any stage of this program (orphan reference).`);
          }
          if (teaId && !validTeaIds.has(teaId)) {
            probs.push(`${t} action ${a.id} targets trackedEntityAttribute ${teaId} which is not on this program.`);
          }
          if (stageId && !validStageIds.has(stageId)) {
            probs.push(`${t} action ${a.id} targets programStage ${stageId} which does not exist on this program.`);
          }
          if (sectionId && !validSectionIds.has(sectionId)) {
            probs.push(`${t} action ${a.id} targets programStageSection ${sectionId} which does not exist on this program.`);
          }
          // HIDEFIELD on a compulsory PSDE: DHIS2 New Tracker Capture leaves the
          // field VISIBLE because compulsion outranks visibility rules. Surface a
          // structured fix hint pointing at the auto-fix path.
          if (t === 'HIDEFIELD' && deId && compulsoryDeIds.has(deId)) {
            probs.push(`HIDEFIELD action ${a.id} targets dataElement ${deId} which is compulsory in its program stage — DHIS2 New Tracker Capture will NOT visually hide a compulsory DE, so this rule appears to fail. Fix: clear the PSDE compulsory flag (PUT the parent programStage with compulsory=false on the PSDE) AND add a paired SETMANDATORYFIELD rule with the inverse condition to restore mandatory status when the DE is shown. Recreating the rule via manage_program_rules(action=create) using HIDEALLFIELDS does both automatically.`);
          }
        }
      }

      const hasConditionFinding = probs.some(p => p.startsWith('Condition ') || p.includes(' condition'));
      if (deep && cond.trim() && hasConditionFinding) {
        const serverRes = await validateProgramRuleCondition(cond, programId);
        const status = serverRes?.status;
        const serverRejected = serverRes?._error
          || (status && status !== 'OK' && status !== 'VALID' && status !== 'SUCCESS');
        if (serverRejected) {
          const msg = serverRes._error || serverRes.message || serverRes.description || status || 'unknown error';
          probs.push(`Server rejected condition: ${String(msg).substring(0, 200)}`);
        } else if (serverRes?.status === 'OK') {
          // DHIS2's parser is authoritative for condition references. If a
          // metadata page failed to load completely, do not keep local-only
          // unknown-variable findings for the condition.
          for (let i = probs.length - 1; i >= 0; i--) {
            if (probs[i].startsWith('Condition references unknown variable ')) probs.splice(i, 1);
          }
        }
      }

      if (probs.length) {
        ruleIssues.push({
          id: rule.id,
          name: rule.name,
          condition: cond.substring(0, 300),
          action_count: actions.length,
          issues: probs,
        });
      }
    }

    // ── Variable-level scan ──
    for (const v of allVars) {
      const probs = [];
      const st = v.programRuleVariableSourceType;
      if (!st) {
        probs.push('Missing programRuleVariableSourceType.');
      }
      if (st === 'TEI_ATTRIBUTE') {
        if (!v.trackedEntityAttribute?.id) probs.push('TEI_ATTRIBUTE variable has no trackedEntityAttribute reference.');
        else if (structureAvailable && !validTeaIds.has(v.trackedEntityAttribute.id)) {
          probs.push(`TEI_ATTRIBUTE variable points at TEA ${v.trackedEntityAttribute.id} not on this program (orphan).`);
        }
      }
      if (st && st.startsWith('DATAELEMENT_')) {
        if (!v.dataElement?.id) probs.push(`${st} variable has no dataElement reference.`);
        else if (structureAvailable && !validDeIds.has(v.dataElement.id)) {
          probs.push(`${st} variable points at dataElement ${v.dataElement.id} not in any stage of this program (orphan).`);
        }
        if (st === 'DATAELEMENT_NEWEST_EVENT_PROGRAM_STAGE' && !v.programStage?.id) {
          probs.push('DATAELEMENT_NEWEST_EVENT_PROGRAM_STAGE variable has no programStage reference.');
        }
      }
      if (probs.length) {
        varIssues.push({ id: v.id, name: v.name, source_type: st, issues: probs });
      }
    }

    // ── Cross-rule visibility-semantics scan ──
    // Same checks the create/update paths enforce at lint time, run over the
    // EXISTING rule set: hide+mandate contradictions inside one rule, show/hide
    // twin rules that hide the same target under complementary conditions
    // (target permanently hidden — the classic "field shows but can't be
    // used" / "field never appears" complaint), and duplicate hide rules.
    const crossRuleIssues = lintRuleVisibilitySemantics(allRules);

    // Build fix hints for the conditions that only need a lint-driven rewrite.
    const conditionFixHints = [];
    for (const r of ruleIssues) {
      const lintLine = r.issues.find(x => x.startsWith('Condition lint:'));
      if (!lintLine) continue;
      const fixMatch = lintLine.match(/Rewrite as `([^`]+)`/);
      if (fixMatch) {
        conditionFixHints.push({
          rule_id: r.id,
          name: r.name,
          current_condition: r.condition,
          suggested_condition: fixMatch[1],
        });
      }
    }

    return {
      program_id: programId,
      total_rules_checked: allRules.length,
      total_rules_in_program: totalRules,
      total_variables_checked: allVars.length,
      structure_validation: structureAvailable ? 'full (DE/TEA/stage/section references checked)' : 'limited (program structure unavailable)',
      total_rules_with_issues: ruleIssues.length,
      total_variables_with_issues: varIssues.length,
      rule_issues: ruleIssues.slice(0, 200),
      variable_issues: varIssues.slice(0, 200),
      _has_more_rule_issues: ruleIssues.length > 200,
      _has_more_variable_issues: varIssues.length > 200,
      ...(crossRuleIssues.length ? { cross_rule_issues: crossRuleIssues.slice(0, 50) } : {}),
      ...(fetchErrors.length ? { _fetch_errors: fetchErrors } : {}),
      ...(conditionFixHints.length ? {
        _condition_fix_hints: conditionFixHints,
        _condition_fix_action: `manage_program_rules(action=bulk_fix_conditions, fixes=[...])`,
      } : {}),
      summary: (ruleIssues.length + varIssues.length + crossRuleIssues.length) === 0
        ? `All ${allRules.length} rules and ${allVars.length} variables are structurally sound.`
        : `Found ${ruleIssues.length} rule(s), ${varIssues.length} variable(s)${crossRuleIssues.length ? `, and ${crossRuleIssues.length} cross-rule contradiction(s)` : ''} with issues. ${crossRuleIssues.length ? 'Cross-rule contradictions make fields permanently hidden or hidden-and-mandatory — fix by DELETING the redundant "Show …" twin rule (there is no SHOW action in DHIS2; fields re-appear when the hide condition is false). ' : ''}${conditionFixHints.length ? 'Use bulk_fix_conditions to apply the suggested condition rewrites.' : 'Fix action targets / variable references via update/create/delete.'} NEVER use dhis2_query PUT/PATCH for program rule metadata.`,
    };
  }

  // ── bulk_fix_conditions ──
  // Batch-apply condition rewrites across many rules. Each fix either sets a new condition
  // directly, or applies a find/replace regex. All new conditions are lint-checked before POST.
  if (action === 'bulk_fix_conditions') {
    const _gate = requireWriteAuth('manage_program_rules', 'bulk_fix_conditions', { count: (args.fixes || []).length });
    if (_gate) return _gate;
    if (!Array.isArray(args.fixes) || !args.fixes.length) {
      return { _error: 'fixes array required for bulk_fix_conditions — each entry: { rule_id, condition? | find+replace? }' };
    }

    const prObjects = [];
    const changes = [];
    const lintErrors = [];
    const fetchErrors = [];

    for (const fix of args.fixes) {
      if (!fix.rule_id) { fetchErrors.push({ error: 'fix entry missing rule_id', entry: fix }); continue; }

      const existing = await safeDhis2Fetch(
        `programRules/${fix.rule_id}?fields=id,name,condition,priority,description,program[id],programStage[id],programRuleActions[id]`
      );
      if (existing._error) { fetchErrors.push({ id: fix.rule_id, error: existing._error }); continue; }

      let newCondition = existing.condition;
      if (typeof fix.condition === 'string') {
        newCondition = fix.condition;
      } else if (fix.find && typeof fix.replace === 'string') {
        try {
          newCondition = (existing.condition || '').replace(new RegExp(fix.find, 'g'), fix.replace);
        } catch (e) {
          fetchErrors.push({ id: fix.rule_id, error: `Invalid regex in fix.find: ${e.message}` });
          continue;
        }
      } else {
        fetchErrors.push({ id: fix.rule_id, error: 'fix entry must supply condition or find+replace' });
        continue;
      }

      const lintErr = lintProgramRuleCondition(newCondition, existing.name);
      if (lintErr) {
        lintErrors.push({ id: fix.rule_id, name: existing.name, rejected_value: newCondition, reason: lintErr });
        continue;
      }

      if (newCondition === existing.condition) continue; // nothing to do

      const pr = {
        id: existing.id,
        name: existing.name,
        program: { id: existing.program?.id || programId },
        condition: newCondition,
        programRuleActions: (existing.programRuleActions || []).map(a => ({ id: a.id })),
      };
      if (existing.programStage?.id) pr.programStage = { id: existing.programStage.id };
      if (existing.description !== undefined) pr.description = existing.description;
      if (existing.priority !== undefined) pr.priority = existing.priority;

      prObjects.push(pr);
      changes.push({
        id: existing.id,
        name: existing.name,
        before: existing.condition,
        after: newCondition,
      });
    }

    if (args.dry_run_only) {
      return {
        success: true,
        phase: 'dry_run',
        message: 'Dry run only. No changes committed.',
        would_commit: prObjects.length,
        changes,
        lint_errors: lintErrors,
        fetch_errors: fetchErrors,
      };
    }

    if (!prObjects.length) {
      return {
        _error: 'No rules to update.',
        lint_errors: lintErrors,
        fetch_errors: fetchErrors,
      };
    }

    // Snapshot every rule that we are about to mutate, in one batched dataStore entry.
    const backup = await ensureBackupOrBail(
      { operation: 'bulk_fix_conditions', tool: 'manage_program_rules', action: 'bulk_fix_conditions', reason: `Bulk-fixing conditions on ${prObjects.length} rule(s)` },
      prObjects.map((p) => ({ object_type: 'programRules', object_id: p.id, role: 'primary' })),
      args
    );
    if (!backup.ok) return backup.error;

    const result = await postMetadataPayload({ programRules: prObjects }, false);
    return {
      ...result,
      summary: {
        fixed_count: prObjects.length,
        lint_errors_count: lintErrors.length,
        fetch_errors_count: fetchErrors.length,
        rules: prObjects.map(p => ({ id: p.id, name: p.name })),
      },
      changes,
      ...(lintErrors.length ? { lint_errors: lintErrors } : {}),
      ...(fetchErrors.length ? { fetch_errors: fetchErrors } : {}),
      backup: backup.block,
    };
  }

  return { _error: `Unknown action: ${action}. Use: list, get, create, update, delete, list_variables, audit, bulk_fix_conditions` };
}

// Lint a program-rule condition for patterns known to fail in the DHIS2 rule engine.
// Returns null if OK, or an error string with the canonical fix.
function lintProgramRuleCondition(condition, ruleName) {
  if (!condition || typeof condition !== 'string') return null;
  const label = ruleName ? `"${ruleName}": ` : '';

  // #{var} == false / != false → engine treats false inconsistently, esp. when empty.
  const eqFalse = condition.match(/(#\{[^}]+\}|A\{[^}]+\})\s*(==|!=)\s*false\b/);
  if (eqFalse) {
    const v = eqFalse[1];
    const op = eqFalse[2];
    const fix = op === '==' ? `!d2:hasValue(${v}) || ${v} != true` : `d2:hasValue(${v}) && ${v} == true`;
    return `${label}condition uses \`${eqFalse[0]}\` which fails on BOOLEAN/TRUE_ONLY fields in DHIS2. Rewrite as \`${fix}\`.`;
  }

  // Quoted boolean literals: == 'true' / == "false" / == 'Yes' / == 'No'
  const quotedBool = condition.match(/(#\{[^}]+\}|A\{[^}]+\})\s*(==|!=)\s*['"](true|false|Yes|No|yes|no|YES|NO)['"]/);
  if (quotedBool) {
    const v = quotedBool[1];
    const op = quotedBool[2];
    const lit = quotedBool[3].toLowerCase();
    const wantsTrue = (op === '==' && (lit === 'true' || lit === 'yes'))
                   || (op === '!=' && (lit === 'false' || lit === 'no'));
    const fix = wantsTrue
      ? `${v} == true`
      : `!d2:hasValue(${v}) || ${v} != true`;
    return `${label}condition compares boolean against quoted literal \`${quotedBool[0]}\`. DHIS2 booleans are unquoted true/false. Rewrite as \`${fix}\`.`;
  }

  return null;
}

// ── Visibility-semantics lint ───────────────────────────────────────────────
// DHIS2 has NO "show field" action: everything is visible by default, HIDEFIELD
// / HIDESECTION / HIDEPROGRAMSTAGE hide while their condition is TRUE and the
// engine re-shows automatically when it turns false. Models that don't know
// this emit catastrophic rule sets — observed live (TB program, 2026-07-11):
//   • "Show Primary Symptoms when X is Yes"  = HIDEFIELD + SETMANDATORYFIELD
//     on the SAME field under the positive condition → selecting Yes hides the
//     field AND makes it mandatory at once (multi-select rendered unusable);
//   • paired with "Hide Primary Symptoms when X is No" (complementary
//     condition, same target) → the field is hidden in EVERY case.
// These import fine and fail only in front of the health worker, so they are
// blocked at lint time. Handles both the tool-input shape ({actions:[{type,
// data_element_name,...}]}) and the server shape ({programRuleActions:[...]}).

const PR_HIDE_ACTION_TYPES = new Set(['HIDEFIELD', 'HIDESECTION', 'HIDEPROGRAMSTAGE']);

// Reduce a condition to the comparison that drives it: strip whitespace noise,
// the two canonical emptiness-guard prefixes, and redundant outer parens.
function _prCoreCondition(cond) {
  let s = String(cond || '').replace(/\s+/g, ' ').trim();
  let m = s.match(/^!\s*d2:hasValue\(\s*([#A]\{[^}]+\})\s*\)\s*\|\|\s*(.+)$/i);
  if (m) s = m[2].trim();
  else if ((m = s.match(/^d2:hasValue\(\s*([#A]\{[^}]+\})\s*\)\s*&&\s*(.+)$/i))) s = m[2].trim();
  for (;;) {
    if (!(s.startsWith('(') && s.endsWith(')'))) break;
    let depth = 0, wraps = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0 && i < s.length - 1) { wraps = false; break; } }
    }
    if (!wraps) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

function _prConditionsComplementary(a, b) {
  const ca = _prCoreCondition(a), cb = _prCoreCondition(b);
  if (!ca || !cb) return false;
  const parse = (s) => {
    const m = s.match(/^([#A]\{[^}]+\})\s*(==|!=)\s*(.+)$/);
    return m ? { ref: m[1], op: m[2], lit: m[3].trim() } : null;
  };
  const pa = parse(ca), pb = parse(cb);
  if (pa && pb && pa.ref === pb.ref && pa.lit === pb.lit && pa.op !== pb.op) return true;
  return `!(${ca})` === cb || `!(${cb})` === ca;
}

function _prConditionsEquivalent(a, b) {
  const ca = _prCoreCondition(a), cb = _prCoreCondition(b);
  return !!ca && ca === cb;
}

// Normalize one rule (either shape) → { name, condition, actions:[{type, keys:Set,
// label, hasHideAllFields}] }. `keys` holds every identifier the action's target
// answers to (kind-prefixed UID and sanitized display name) so input-shape rules
// (names) and server-shape rules (ids) can be matched against each other.
function _prNormalizeRuleForLint(rule) {
  const rawActions = rule.programRuleActions || rule.actions || [];
  const actions = [];
  let hasHideAllFields = false;
  for (const a of rawActions) {
    const type = a.programRuleActionType || a.type;
    if (type === 'HIDEALLFIELDS') hasHideAllFields = true;
    const keys = new Set();
    let label = null;
    const add = (prefix, id, name) => {
      if (id) keys.add(`${prefix}:${id}`);
      if (name) { keys.add(`${prefix}:${sanitizeVariableName(name)}`); label = label || name; }
    };
    add('de', a.data_element_id || a.dataElement?.id, a.data_element_name || a.dataElement?.displayName);
    add('tea', a.tei_attribute_id || a.trackedEntityAttribute?.id, a.tracked_entity_attribute_name || a.trackedEntityAttribute?.displayName);
    add('stage', a.program_stage_id || a.programStage?.id, a.program_stage_name || a.programStage?.displayName);
    add('section', a.program_stage_section_id || a.programStageSection?.id, a.programStageSection?.displayName);
    if (!label) label = a.data_element_id || a.tei_attribute_id || a.program_stage_id || a.program_stage_section_id
      || a.dataElement?.id || a.trackedEntityAttribute?.id || a.programStage?.id || a.programStageSection?.id || null;
    actions.push({ type, keys, label });
  }
  return { id: rule.id || null, name: rule.name || '', condition: rule.condition || '', actions, hasHideAllFields };
}

const _prKeysIntersect = (a, b) => { for (const k of a) if (b.has(k)) return true; return false; };

const PR_ONE_RULE_DOCTRINE = 'DHIS2 has NO SHOW action — fields/sections/stages are visible by default, and a HIDE action automatically un-hides when its condition turns false. "Show X only when C" = exactly ONE rule: condition = the HIDE case (e.g. !d2:hasValue(#{c}) || #{c} != true), action = HIDEFIELD on X. If X must also be mandatory when visible, add a SEPARATE rule with the positive condition and SETMANDATORYFIELD only. NEVER create show/hide rule pairs and NEVER put HIDEFIELD under the "show" condition.';

// Lint new rules (tool-input or server shape) against each other AND against
// the program's existing rules. Returns an array of error strings — callers
// refuse the import when any are present.
function lintRuleVisibilitySemantics(newRules, existingRules = []) {
  const errors = [];
  const news = (newRules || []).map(_prNormalizeRuleForLint);
  const olds = (existingRules || []).map(_prNormalizeRuleForLint);

  // 1. Same-rule contradiction: HIDE + SETMANDATORYFIELD on the same target.
  for (const r of news) {
    for (const hide of r.actions) {
      if (!PR_HIDE_ACTION_TYPES.has(hide.type)) continue;
      const mand = r.actions.find(a => a.type === 'SETMANDATORYFIELD' && _prKeysIntersect(a.keys, hide.keys));
      if (mand) {
        errors.push(`Rule "${r.name}": contradictory actions — ${hide.type} and SETMANDATORYFIELD both target "${hide.label}" in the SAME rule, so when the condition is true the field is hidden AND mandatory at once (the field renders broken/un-fillable in Capture). ${PR_ONE_RULE_DOCTRINE}`);
      }
    }
    // 2. Inverted "Show X" rule: the rule's name promises to SHOW the very
    // target its action HIDES while the condition is true.
    if (!r.hasHideAllFields && /^\s*(show|display|reveal|unhide)\b/i.test(r.name)) {
      const nameSan = `_${sanitizeVariableName(r.name)}_`;
      for (const act of r.actions) {
        if (!PR_HIDE_ACTION_TYPES.has(act.type)) continue;
        if (act.label && nameSan.includes(`_${sanitizeVariableName(String(act.label))}_`)) {
          errors.push(`Rule "${r.name}" claims to SHOW "${act.label}" but its ${act.type} action HIDES it while the condition is true — inverted semantics. ${PR_ONE_RULE_DOCTRINE}`);
          break;
        }
      }
    }
  }

  // 3. Complementary / duplicate hide pairs on the same target (batch-internal
  // and new-vs-existing). Complementary pair ⇒ the target is hidden in EVERY
  // case; duplicate ⇒ redundant twin rule.
  const hideEntries = (list, isNew) => {
    const out = [];
    for (const r of list) {
      for (const act of r.actions) {
        if (PR_HIDE_ACTION_TYPES.has(act.type)) out.push({ rule: r, act, isNew });
      }
    }
    return out;
  };
  const newHides = hideEntries(news, true);
  const allHides = [...newHides, ...hideEntries(olds, false)];
  const flagged = new Set();
  for (const a of newHides) {
    for (const b of allHides) {
      if (a === b || a.rule === b.rule) continue;
      if (a.act.type !== b.act.type || !_prKeysIntersect(a.act.keys, b.act.keys)) continue;
      const pairKey = [a.rule.name, b.rule.name, a.act.label].sort().join('|');
      if (flagged.has(pairKey)) continue;
      if (_prConditionsComplementary(a.rule.condition, b.rule.condition)) {
        flagged.add(pairKey);
        const bDesc = b.isNew ? `rule "${b.rule.name}" in this same request` : `EXISTING rule "${b.rule.name}"${b.rule.id ? ` (${b.rule.id})` : ''}`;
        errors.push(`Rule "${a.rule.name}" and ${bDesc} BOTH hide "${a.act.label}" under COMPLEMENTARY conditions ("${a.rule.condition}" vs "${b.rule.condition}") — together they hide it in every case, so the field/stage never appears. Keep ONLY the rule whose condition expresses when to HIDE and drop the other. ${PR_ONE_RULE_DOCTRINE}`);
      } else if (_prConditionsEquivalent(a.rule.condition, b.rule.condition)) {
        flagged.add(pairKey);
        const bDesc = b.isNew ? `rule "${b.rule.name}" in this same request` : `EXISTING rule "${b.rule.name}"${b.rule.id ? ` (${b.rule.id})` : ''}`;
        errors.push(`Rule "${a.rule.name}" duplicates ${bDesc}: same ${a.act.type} target "${a.act.label}" under an equivalent condition. Do not create duplicate rules — keep one.`);
      }
    }
  }
  return errors;
}

// ── Auto-guard bare `< / <=` numeric comparisons against EMPTY fields ──
// The Capture rules engine coerces an empty numeric field to 0, so a condition
// like `#{apgar_score} < 7` is TRUE before the user types anything and its
// SHOWWARNING/HIDEFIELD fires on a blank form. Verified live on play 2.40.12
// (2026-07-07): "APGAR < 7" warning rendered under an untouched empty field.
// Fix: wrap each bare `#{x} < n` / `#{x} <= n` atom in-place as
// `(d2:hasValue(#{x}) && #{x} < n)` — compositional under && and ||, so
// compound conditions keep their meaning. Deliberately skipped when the
// condition contains any negation (`!` other than `!=`) or already guards the
// same variable with d2:hasValue — rewriting inside a negation would invert
// the intended empty-field behavior.
function autoGuardNumericComparisons(condition) {
  const original = String(condition || '');
  if (!original.trim()) return { condition: original, guarded: [] };
  if (/!(?!=)/.test(original)) return { condition: original, guarded: [] }; // negations present — hands off
  const guarded = [];
  const re = /([#A]\{[^}]+\})\s*(<=?)\s*(-?\d+(?:\.\d+)?)(?!\d)/g;
  const rewritten = original.replace(re, (full, token, op, num) => {
    if (original.includes(`d2:hasValue(${token})`)) return full; // author already guarded it
    guarded.push(token);
    return `(d2:hasValue(${token}) && ${token} ${op} ${num})`;
  });
  return { condition: rewritten, guarded };
}

// ── Rewrite option NAMES → CODES in rule conditions and ASSIGN data ──
// Shared by the create_program embedded-rules path and add_program_rules.
// (manage_program_rules has its own equivalent, verified earlier — untouched.)
// Auto-created option-set PRVs use useCodeForOptionSet=true, so the engine
// compares option CODES. A condition/ASSIGN written with the option NAME
// ('Live Birth' instead of 'LIVE_BIRTH') lints clean, saves, and then never
// matches — the exact silent failure seen on the MCH program (play 2.40.12,
// 2026-07-07: Stage-2 infant fields stayed hidden even with outcome = Live
// Birth). This only rewrites a NAME literal to its CODE; literals that are
// already codes, empty-string checks, and unknown literals are left alone
// (unknowns are surfaced as advisories instead).
//   rules:   [{ name, condition }]                      — condition mutated in place
//   actions: [{ programRuleActionType, data, dataElement, trackedEntityAttribute }]
//   varToOsKey:    Map lowercased #{var} name → option-set key
//   targetToOsKey: Map DE/TEA id (action targets) → option-set key
//   optionsByOsKey: Map key → [{ name, code }]
function rewriteOptionLiteralsGeneric({ rules, actions, varToOsKey, targetToOsKey, optionsByOsKey }) {
  const advisories = [];
  const rewrites = [];
  const lookup = (osKey) => {
    const opts = optionsByOsKey.get(osKey);
    if (!opts || !opts.length) return null;
    return {
      byCode: new Set(opts.map(o => String(o.code))),
      byName: new Map(opts.map(o => [String(o.name).toLowerCase(), String(o.code)])),
      codes: opts.map(o => o.code).join(', '),
    };
  };

  for (const rule of (rules || [])) {
    let cond = String(rule.condition || '');
    const usedVars = new Set((cond.match(/#\{([^}]+)\}/g) || []).map(m => m.slice(2, -1)));
    for (const vRaw of usedVars) {
      const osKey = varToOsKey.get(vRaw.toLowerCase());
      if (!osKey) continue;
      const os = lookup(osKey);
      if (!os) continue;
      const varToken = `#{${vRaw}}`;
      const esc = vRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`#\\{${esc}\\}\\s*(==|!=)\\s*'([^']*)'|'([^']*)'\\s*(==|!=)\\s*#\\{${esc}\\}`, 'g');
      cond = cond.replace(re, (full, op1, lit1, lit2, op2) => {
        const lit = (lit1 !== undefined ? lit1 : lit2);
        const op = op1 || op2;
        if (lit === '') return full;         // empty-value check — leave alone
        if (os.byCode.has(lit)) return full; // already a code — leave alone
        const code = os.byName.get(lit.toLowerCase());
        if (code) {
          rewrites.push(`Rule "${rule.name}": '${lit}' → option code '${code}'`);
          return op1 ? `${varToken} ${op} '${code}'` : `'${code}' ${op} ${varToken}`;
        }
        advisories.push(`Rule "${rule.name}": #{${vRaw}} is compared to '${lit}', which is neither a code nor a name of its option set (codes: ${os.codes}). This comparison will never match — verify the value.`);
        return full;
      });
    }
    rule.condition = cond;
  }

  for (const pra of (actions || [])) {
    if (pra.programRuleActionType !== 'ASSIGN') continue;
    const targetId = pra.dataElement?.id || pra.trackedEntityAttribute?.id;
    const osKey = targetId && targetToOsKey.get(targetId);
    if (!osKey) continue;
    const os = lookup(osKey);
    if (!os) continue;
    const literal = typeof pra.data === 'string' && pra.data.trim().match(/^'([^']*)'$/);
    if (!literal) continue; // dynamic expression — can't statically check
    const value = literal[1];
    if (value === '' || os.byCode.has(value)) continue;
    const code = os.byName.get(value.toLowerCase());
    if (code) {
      rewrites.push(`ASSIGN '${value}' → option code '${code}'`);
      pra.data = `'${code}'`;
    } else {
      advisories.push(`ASSIGN uses '${value}', which is neither an option code nor an option name of the target's option set (codes: ${os.codes}). The assigned value will bounce on save — fix it.`);
    }
  }

  return { advisories, rewrites };
}

// PI grammar — d2 functions DHIS2 2.41 actually accepts inside a programIndicator
// expression OR filter. Keep in sync with VALID_D2_FUNCS in audit (line ~12854).
// d2:contains / d2:containsString / d2:inOrgUnit / d2:hasUserRole / d2:removeMin
// look tempting because they exist in Program Rules — they DO NOT exist in PI.
// Functions the PI ANTLR parser ACTUALLY accepts — every entry verified live
// against /programIndicators/{expression|filter}/description on BOTH
// play 2.42.5.1 and 2.43.0-1 (2026-07-10). The DHIS2 docs list many more
// (floor/ceil/round, string fns, zScore*, inOrgUnitGroup, lastEventDate) but
// the parser rejects them with "Item d2:<fn>( not supported for this type of
// expression" — docs-derived whitelisting produced false "valid" lints.
const VALID_PI_D2_FUNCS = new Set([
  'condition', 'count', 'countIfValue', 'countIfCondition', 'daysBetween',
  'hasValue', 'maxValue', 'minValue', 'monthsBetween', 'oizp', 'relationshipCount',
  'weeksBetween', 'yearsBetween', 'minutesBetween', 'zing', 'zpvc',
]);
// Documented-but-rejected: caught locally with a targeted workaround hint so
// the model self-corrects in one step instead of bouncing off the server.
const PI_D2_FUNCS_PARSER_REJECTS = new Set([
  'ceil', 'floor', 'round', 'modulus', 'addDays', 'validatePattern',
  'left', 'right', 'substring', 'split', 'concatenate', 'length',
  'inOrgUnitGroup', 'lastEventDate', 'zScoreHFA', 'zScoreWFA', 'zScoreWFH',
]);

// lintProgramIndicatorExpression — fast local check before round-tripping to
// DHIS2's /programIndicators/{expression|filter}/description. Catches the
// dead-on-arrival patterns that the model commonly emits, so the user gets a
// useful hint instead of a generic "Invalid string token 'd' at line:1
// character:0" from the server. Returns null when clean, else { error, hint }.
//
// kind: 'expression' | 'filter' (only used to phrase the hint)
function lintProgramIndicatorExpression(text, kind) {
  if (!text || typeof text !== 'string') return null;
  const t = text;

  // Program-RULE-only d2 functions leaking into a PI. d2:contains is the #1
  // offender — common ask is "MULTI_TEXT contains X AND Y" and the model
  // reaches for the rule-engine helper. The DHIS2 PI parser rejects it with
  // "Invalid string token 'd' at line:1 character:0" and analytics returns 409.
  const ruleOnly = t.match(/d2:(contains|containsString|inOrgUnit|hasUserRole|removeMin)\s*\(/);
  if (ruleOnly) {
    const fn = ruleOnly[1];
    const isContains = fn === 'contains' || fn === 'containsString';
    return {
      error: `\`d2:${fn}(\` is a program-rule function, not a program-indicator function. The DHIS2 PI parser rejects it (e.g. "Invalid string token 'd' at line:1 character:0"). Even if the create returns 201, analytics returns 409 at query time.`,
      hint: isContains
        ? 'There is NO contains operator in DHIS2 2.41 program-indicator grammar — `==` does exact-string match even on MULTI_TEXT (verified). Workarounds for "MULTI_TEXT contains both X and Y": (a) restructure: split the multi-select into separate BOOLEAN data elements (Diabetes flag, Hypertension flag), then filter `#{stage.de_dm} == true && #{stage.de_htn} == true` — clean and analytics-safe; (b) for ad-hoc analysis, use the Line Listing app which DOES support contains via the IN operator at query time; (c) brittle exact-match: `#{stage.de} == \'Diabetes,HYPERTENSION\'` — order-dependent and breaks if any other risk factor is selected. Tell the user (a) is the right fix; (c) is a stopgap only.'
        : 'This d2 function is only valid in Program Rules. Restructure the expression using a supported PI d2 function or plain operators.',
    };
  }

  // Unknown or parser-rejected d2 function — catch typos, made-up names, and
  // the documented-but-unsupported set early with a targeted workaround.
  const SUPPORTED_LIST = 'condition, count, countIfValue, countIfCondition, hasValue (FILTER only), daysBetween, weeksBetween, monthsBetween, yearsBetween, minutesBetween, minValue, maxValue, oizp, zing, zpvc, relationshipCount';
  const d2Calls = [...t.matchAll(/d2:([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];
  for (const [, fn] of d2Calls) {
    if (PI_D2_FUNCS_PARSER_REJECTS.has(fn)) {
      const isRounding = fn === 'floor' || fn === 'ceil' || fn === 'round';
      return {
        error: `\`d2:${fn}(\` appears in the DHIS2 docs but the program-indicator parser REJECTS it ("Item d2:${fn}( not supported for this type of expression") — verified live on 2.42 and 2.43.`,
        hint: isRounding
          ? 'For rounding, drop the function and keep the plain arithmetic (e.g. `d2:daysBetween(#{stage.lmp}, V{event_date}) / 7`), then set the indicator\'s `decimals` (0 for whole numbers) — analytics rounds the displayed value. Supported functions: ' + SUPPORTED_LIST + '.'
          : `Restructure without d2:${fn}. Supported PI d2 functions (parser-verified): ${SUPPORTED_LIST}. String/date manipulation beyond these belongs in program RULES or the Line Listing app, and org-unit scoping belongs in the visualization's ou dimension, not the PI.`,
      };
    }
    if (!VALID_PI_D2_FUNCS.has(fn)) {
      return {
        error: `Unknown program-indicator function: \`d2:${fn}(\`.`,
        hint: `Supported PI d2 functions (parser-verified on 2.42/2.43): ${SUPPORTED_LIST}.`,
      };
    }
  }

  // d2:hasValue parses ONLY in filter context — in an expression the parser
  // returns "not supported for this type of expression" (verified 2.42 + 2.43).
  if (kind === 'expression' && /d2:hasValue\s*\(/.test(t)) {
    return {
      error: '`d2:hasValue(` is FILTER-only in the program-indicator grammar — the expression parser rejects it (verified live on 2.42 and 2.43).',
      hint: 'Move the has-value check into the indicator\'s `filter`, or in the expression use a numeric proxy like `d2:count(#{stage.de}) > 0` inside a d2:condition.',
    };
  }

  // subExpression(...) — Indicator (regular) feature; PI parser returns
  // "Item subExpression( not supported for this type of expression" (verified
  // against play.im.dhis2.org/stable-2-41-8 in both expression and filter context).
  if (/\bsubExpression\s*\(/.test(t)) {
    return {
      error: '`subExpression(...)` is not supported in program-indicator expressions or filters in DHIS2 2.41 — it is a feature of regular Indicators (a different object). The server returns "Item subExpression( not supported for this type of expression".',
      hint: 'Use only the documented PI grammar: ==, !=, <, >, <=, >=, &&, ||, +, -, *, / and the supported d2:* functions.',
    };
  }

  // SQL-style operators that look tempting but the PI ANTLR grammar rejects
  // ("Invalid string token 'LIKE' at line:1 character:N"). Verified.
  const sqlIsh = t.match(/(?:^|[\s(])(LIKE|ILIKE|IN\s*\(|position\s*\(|string_to_array\s*\(|coalesce\s*\(|regexp_match\s*\(|~\s*\')/i);
  if (sqlIsh) {
    return {
      error: `Token \`${sqlIsh[1].trim()}\` is SQL-style and is rejected by the DHIS2 program-indicator parser.`,
      hint: 'PI grammar supports only: ==, !=, <, >, <=, >=, &&, ||, +, -, *, / and the documented d2:* functions. There is no LIKE/ILIKE/IN/position/regex.',
    };
  }

  // Wrong reference shapes — defence in depth. C{}/I{}/OUG{} are valid in
  // regular indicators but not in program indicators.
  if (/\bC\{[^}]+\}/.test(t)) return { error: 'C{} (category option combo) references are not valid in program indicators.', hint: 'Use #{stageId.deId}, A{teaId}, V{var}, or a constant value instead.' };
  if (/\bI\{[^}]+\}/.test(t)) return { error: 'I{} (indicator) references are not valid in program indicators.', hint: 'Compose the calculation directly in this PI using #{stage.de} / A{tea}.' };
  if (/\bOUG\{[^}]+\}/.test(t)) return { error: 'OUG{} (org unit group) references are not valid in program indicators.', hint: 'Scope by org unit in the ANALYTICS request instead: put the org-unit group / OUs in the visualization\'s ou dimension (e.g. OU_GROUP-<ougId> in dhis2 analytics, or org_units in manage_dashboards). The PI itself must stay OU-agnostic — d2:inOrgUnitGroup is rejected by the PI parser on 2.42/2.43.' };

  // Same-field equality against two DIFFERENT literals is impossible ONLY when the
  // comparisons are AND-ed: `#{X} == 'A' && #{X} == 'B'`. The OR form
  // `#{X} == 'A' || #{X} == 'B'` is the NORMAL, correct way to match one of several
  // option codes (RR/MDR profile, treatment-outcome cohorts, …) and must NOT be
  // blocked. So evaluate the check PER OR-TERM (split on ||): within a single
  // conjunction a field can equal only one literal; across OR-terms it can equal
  // any of them. (The old check counted same-ref equalities across the whole
  // filter and wrongly rejected valid `||` "field in set" filters.)
  if (kind === 'filter') {
    for (const term of t.split('||')) {
      const byRef = new Map(); // ref → Set(distinct literals compared with ==)
      for (const m of term.matchAll(/(#\{[^}]+\}|A\{[^}]+\})\s*==\s*'([^']*)'/g)) {
        if (!byRef.has(m[1])) byRef.set(m[1], new Set());
        byRef.get(m[1]).add(m[2]);
      }
      for (const [ref, lits] of byRef) {
        if (lits.size >= 2) {
          return {
            error: `Filter requires the same field ${ref} to equal ${[...lits].map(l => `'${l}'`).join(' AND ')} simultaneously — logically impossible (within an AND a field can equal only one literal).`,
            hint: 'To match ANY of several values use OR: `#{X} == \'A\' || #{X} == \'B\'`. For a MULTI_TEXT "contains both A and B" (not expressible in PI grammar): split into BOOLEAN data elements and filter `#{stage.a} == true && #{stage.b} == true`, or use the Line Listing app at query time.',
          };
        }
      }
    }
  }

  return null;
}

// applyRuleActionSugar — shared rewrite step for both create-rule paths.
// Mutates `rules[].actions` in place AND returns the side-effect plan that the
// caller must execute against DHIS2:
//
//   { psdesToFlipNonCompulsory: [{ stageId, psdeId, deId, deName }],
//     siblingMandateRules: [{ name, condition, actions: [SETMANDATORYFIELD per DE] }] }
//
// Behaviors:
//   1. Auto-move #{var}/A{attr} refs out of `content` into `data` for the
//      *_WARNING / *_ERROR / SHOWWARNINGINFORMATION action types. Variables in
//      `content` are shown LITERALLY by DHIS2; only `data` is evaluated.
//   2. Expand HIDEALLFIELDS sugar into real HIDEFIELDs (per DE in the trigger
//      DE's stage) + HIDEPROGRAMSTAGEs (every other stage). Trigger DE list comes
//      from action.exclude_data_element_ids, falling back to #{var} refs in the
//      rule condition resolved via sanitized DE display name.
//   3. For HIDEALLFIELDS targets that are COMPULSORY in their PSDE: report them
//      via psdesToFlipNonCompulsory so the caller can PUT the stage with
//      compulsory=false. DHIS2 New Tracker Capture refuses to visually hide a
//      compulsory DE — leaving the flag set is exactly what made 5 fields stay
//      visible in the user-reported "5 unhidden" bug.
//   4. To preserve the original "required when shown" semantic, when at least
//      one compulsory PSDE was flipped AND the rule action did NOT pass
//      restore_mandate_when_visible:false, emit a sibling rule with the inverse
//      condition that SETMANDATORYFIELD's each formerly-compulsory DE.
//      Inverse-condition heuristics:
//        Pattern A: !d2:hasValue(#{X}) || #{X} != true   → #{X} == true
//        Pattern B: #{X} == true                          → !d2:hasValue(#{X}) || #{X} != true
//        Otherwise: !( <original> )    (always valid d2)
function applyRuleActionSugar(rules, programStages) {
  const result = { psdesToFlipNonCompulsory: [], siblingMandateRules: [] };

  const TEMPLATE_TYPES = new Set([
    'SHOWWARNING', 'SHOWERROR', 'WARNINGONCOMPLETE', 'ERRORONCOMPLETE', 'SHOWWARNINGINFORMATION',
  ]);
  const VAR_REF_PATTERN = /[#A]\{[^}]+\}/g;
  const splitTemplateContent = (raw) => {
    const matches = [...raw.matchAll(new RegExp(VAR_REF_PATTERN.source, 'g'))];
    if (!matches.length) return null;
    if (matches.length === 1) {
      const ref = matches[0][0];
      const stripped = raw.replace(ref, '').replace(/[\s:\-–—]+$/, '').trimEnd();
      return { content: stripped, data: ref };
    }
    const parts = [];
    let lastIdx = 0;
    let m;
    const re = new RegExp(VAR_REF_PATTERN.source, 'g');
    while ((m = re.exec(raw)) !== null) {
      if (m.index > lastIdx) parts.push(JSON.stringify(raw.substring(lastIdx, m.index)));
      parts.push(m[0]);
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < raw.length) parts.push(JSON.stringify(raw.substring(lastIdx)));
    return { content: '', data: `d2:concatenate(${parts.join(', ')})` };
  };

  // 1. Content → data rewrite
  for (const rule of rules) {
    for (const act of (rule.actions || [])) {
      if (!TEMPLATE_TYPES.has(act.type)) continue;
      const c = String(act.content || '');
      if (!new RegExp(VAR_REF_PATTERN.source).test(c)) continue;
      if (String(act.data || '').trim()) continue; // respect explicit data
      const split = splitTemplateContent(c);
      if (split) {
        act.content = split.content;
        act.data = split.data;
        act._auto_rewrote_template = true;
      }
    }
  }

  // 2-4. HIDEALLFIELDS expansion + compulsion handling + inverse mandate rule
  const stages = Array.isArray(programStages) ? programStages : [];
  if (!stages.length) return result;

  // Index PSDEs/DEs across the program. We track psdeId + compulsory so we can
  // flip the flag on stages whose DEs are about to get HIDEFIELD'd.
  const deIdToInfo = new Map(); // deId → { stageId, psdeId, displayName, compulsory }
  const deBySanitizedName = new Map();
  for (const ps of stages) {
    for (const psde of (ps.programStageDataElements || [])) {
      const de = psde.dataElement;
      if (!de?.id) continue;
      deIdToInfo.set(de.id, {
        stageId: ps.id,
        psdeId: psde.id,
        displayName: de.displayName,
        compulsory: !!psde.compulsory,
      });
      if (de.displayName) deBySanitizedName.set(sanitizeVariableName(de.displayName), de.id);
    }
  }
  const allStageIds = stages.map(ps => ps.id).filter(Boolean);

  // Inverse-condition helper — covers the two common boolean shapes plus a generic !(...) fallback.
  const inverseCondition = (cond) => {
    if (!cond) return 'true';
    const s = cond.trim();
    let m;
    if ((m = s.match(/^!d2:hasValue\(#\{(\w+)\}\)\s*\|\|\s*#\{\1\}\s*!=\s*true$/))) {
      return `#{${m[1]}} == true`;
    }
    if ((m = s.match(/^#\{(\w+)\}\s*==\s*true$/))) {
      return `!d2:hasValue(#{${m[1]}}) || #{${m[1]}} != true`;
    }
    return `!(${s})`;
  };

  for (const rule of rules) {
    if (!(rule.actions || []).some(a => a.type === 'HIDEALLFIELDS')) continue;
    const expanded = [];
    const compulsoryHiddenDEs = []; // { deId, deName, stageId, psdeId } across this rule
    let restoreMandate = true; // default true; can be turned off per HIDEALLFIELDS action

    for (const act of (rule.actions || [])) {
      if (act.type !== 'HIDEALLFIELDS') { expanded.push(act); continue; }
      if (act.restore_mandate_when_visible === false) restoreMandate = false;

      const excludeIds = new Set(act.exclude_data_element_ids || []);
      if (excludeIds.size === 0) {
        for (const m of String(rule.condition || '').match(/#\{([^}]+)\}/g) || []) {
          const name = m.slice(2, -1);
          const hit = deBySanitizedName.get(sanitizeVariableName(name));
          if (hit) excludeIds.add(hit);
        }
      }
      const triggerStageIds = new Set();
      for (const id of excludeIds) {
        const info = deIdToInfo.get(id);
        if (info?.stageId) triggerStageIds.add(info.stageId);
      }
      const expandFieldStages = triggerStageIds.size ? triggerStageIds : new Set(allStageIds);
      for (const ps of stages) {
        if (expandFieldStages.has(ps.id)) {
          for (const psde of (ps.programStageDataElements || [])) {
            const deId = psde.dataElement?.id;
            if (!deId || excludeIds.has(deId)) continue;
            expanded.push({ type: 'HIDEFIELD', data_element_id: deId });
            if (psde.compulsory) {
              compulsoryHiddenDEs.push({
                deId,
                deName: psde.dataElement.displayName,
                stageId: ps.id,
                psdeId: psde.id,
              });
            }
          }
        } else {
          expanded.push({ type: 'HIDEPROGRAMSTAGE', program_stage_id: ps.id });
        }
      }
    }
    rule.actions = expanded;

    if (compulsoryHiddenDEs.length) {
      // Schedule each PSDE for compulsory→false (DHIS2 won't hide a compulsory DE).
      for (const c of compulsoryHiddenDEs) result.psdesToFlipNonCompulsory.push(c);

      // Optionally re-mandate them when the trigger condition is FALSE (i.e. shown).
      if (restoreMandate) {
        result.siblingMandateRules.push({
          name: `${rule.name || 'Hide all fields'} — require when visible`,
          description: `Auto-paired with "${rule.name || ''}" to restore mandatory status on ${compulsoryHiddenDEs.length} originally-compulsory data element(s) when the hide condition is false. Created automatically because HIDEFIELD does not visually hide compulsory DEs in DHIS2 New Tracker Capture; the partner rule clears compulsion at metadata level, this rule re-applies it via SETMANDATORYFIELD when fields are shown.`,
          condition: inverseCondition(rule.condition),
          actions: compulsoryHiddenDEs.map(c => ({ type: 'SETMANDATORYFIELD', data_element_id: c.deId })),
          _auto_paired_with: rule.name,
        });
      }
    }
  }

  return result;
}

// Apply the side effects collected by applyRuleActionSugar:
//   - Flip PSDE.compulsory→false on each affected stage via PUT (one PUT per stage).
//   - Append the auto-built sibling SETMANDATORYFIELD rules into the rules list so
//     the caller's existing build pipeline emits them in the same metadata POST.
// Returns { stageUpdates: [{ stage_id, flipped: [{ deId, deName }] }], errors: [...] }.
async function applyRuleActionSugarSideEffects(plan, rules) {
  const result = { stageUpdates: [], errors: [] };
  if (!plan) return result;

  // 1. Group PSDE flips by stage.
  const byStage = new Map();
  for (const f of (plan.psdesToFlipNonCompulsory || [])) {
    if (!byStage.has(f.stageId)) byStage.set(f.stageId, []);
    byStage.get(f.stageId).push(f);
  }
  for (const [stageId, flips] of byStage) {
    const stageResp = await safeDhis2Fetch(`programStages/${stageId}.json?fields=:owner`);
    if (stageResp?._error || !stageResp?.id) {
      result.errors.push({ stage_id: stageId, error: stageResp?._error || 'stage not found' });
      continue;
    }
    const targetPsdeIds = new Set(flips.map(f => f.psdeId));
    let flipped = 0;
    for (const psde of (stageResp.programStageDataElements || [])) {
      if (targetPsdeIds.has(psde.id) && psde.compulsory) {
        psde.compulsory = false;
        flipped++;
      }
    }
    if (!flipped) {
      result.stageUpdates.push({ stage_id: stageId, flipped: [], note: 'No matching compulsory PSDEs (already cleared).' });
      continue;
    }
    const putResp = await safeDhis2Fetch(`programStages/${stageId}`, { method: 'PUT', body: stageResp });
    if (putResp?._error) {
      result.errors.push({ stage_id: stageId, error: `PUT failed: ${putResp._error}` });
      continue;
    }
    result.stageUpdates.push({
      stage_id: stageId,
      flipped: flips.map(f => ({ data_element_id: f.deId, data_element_name: f.deName })),
    });
  }

  // 2. Append sibling mandate rules so they go through the normal build pipeline.
  if ((plan.siblingMandateRules || []).length) {
    rules.push(...plan.siblingMandateRules);
  }

  return result;
}

// Build and post programRuleVariables + programRuleActions + programRules atomically.
// actions must reference their parent rule via programRule:{id} (confirmed working pattern).
//
// Variable-reference contract: DHIS2 silently accepts rules with unresolved #{var}
// references — the rule is created but never fires at runtime. To prevent dead rules,
// this function:
//   1. scans every condition + action.data for #{varName} and A{attrRef}
//   2. matches each #{varName} against existing programRuleVariables, model-supplied
//      rule.variables[], and (as last resort) program data elements by sanitized
//      displayName — auto-creating a PRV when a DE match is found
//   3. rewrites A{name} (non-UID) into A{UID} using the program's TEAs
//   4. refuses the POST with a structured _hint when a reference cannot be resolved
// Resolve rule-action target display names (data_element_name /
// tracked_entity_attribute_name) to UIDs against a program's DEs + TEAs. Mutates
// each action in place, filling data_element_id / tei_attribute_id when only a
// name was supplied. Returns { unresolved:[{name,kind}] } for names that matched
// nothing. Lets the manage_program_rules UPDATE path bind name-targeted actions
// the same way the create path (_buildAndPostProgramRules) already does — without
// it, an ASSIGN/SETMANDATORYFIELD/HIDEFIELD passed by name saved target-less and
// DHIS2 rejected the bundle ("DataElement ... cannot be null").
async function resolveRuleActionTargetNames(pid, actions) {
  const needs = (actions || []).some(a => a && (
    (a.data_element_name && !a.data_element_id) ||
    (a.tracked_entity_attribute_name && !a.tei_attribute_id)));
  if (!needs) return { unresolved: [] };
  const prog = await safeDhis2Fetch(`programs/${pid}?fields=programStages[programStageDataElements[dataElement[id,displayName]]],programTrackedEntityAttributes[trackedEntityAttribute[id,displayName]]`);
  if (!prog || prog._error) return { unresolved: [], _fetchError: prog && prog._error };
  const deByName = new Map(), deBySan = new Map();
  for (const ps of (prog.programStages || [])) for (const psde of (ps.programStageDataElements || [])) {
    const de = psde.dataElement; if (!de?.id) continue;
    deByName.set(de.displayName, de.id); deBySan.set(sanitizeVariableName(de.displayName), de.id);
  }
  const teaByName = new Map(), teaBySan = new Map();
  for (const pta of (prog.programTrackedEntityAttributes || [])) {
    const tea = pta.trackedEntityAttribute; if (!tea?.id) continue;
    teaByName.set(tea.displayName, tea.id); teaBySan.set(sanitizeVariableName(tea.displayName), tea.id);
  }
  const unresolved = [];
  for (const a of (actions || [])) {
    if (a.data_element_name && !a.data_element_id) {
      const id = deByName.get(a.data_element_name) || deBySan.get(sanitizeVariableName(a.data_element_name));
      if (id) a.data_element_id = id; else unresolved.push({ name: a.data_element_name, kind: 'dataElement' });
    }
    if (a.tracked_entity_attribute_name && !a.tei_attribute_id) {
      const id = teaByName.get(a.tracked_entity_attribute_name) || teaBySan.get(sanitizeVariableName(a.tracked_entity_attribute_name));
      if (id) a.tei_attribute_id = id; else unresolved.push({ name: a.tracked_entity_attribute_name, kind: 'trackedEntityAttribute' });
    }
  }
  return { unresolved };
}

async function _buildAndPostProgramRules(programId, rules, dryRun) {
  // 1. Lint conditions for known-broken boolean patterns.
  const lintErrors = [];
  for (const rule of rules) {
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

  // 1a. Bare `#{x} < n` fires on EMPTY fields (empty coerces to 0) — wrap with
  // d2:hasValue so warnings/hides don't trigger on a blank form.
  const autoGuardedConditions = [];
  for (const rule of rules) {
    const g = autoGuardNumericComparisons(rule.condition);
    if (g.guarded.length) {
      rule.condition = g.condition;
      autoGuardedConditions.push({ rule: rule.name, guarded_variables: g.guarded });
    }
  }

  // 2. Load program so we can resolve variable references and pick smart defaults.
  // PSDE id+compulsory included so HIDEALLFIELDS sugar can flip compulsory→false on
  // hidden DEs (DHIS2 New Tracker Capture refuses to visually hide a compulsory DE).
  const progResp = await safeDhis2Fetch(
    `programs/${programId}?fields=id,programStages[id,displayName,programStageDataElements[id,compulsory,dataElement[id,displayName,valueType,optionSet[id]]]],programTrackedEntityAttributes[trackedEntityAttribute[id,displayName,valueType,optionSet[id]]],programRuleVariables[id,name,programRuleVariableSourceType,valueType,useCodeForOptionSet,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id]]`
  );
  if (progResp._error) {
    return { success: false, _error: `Could not load program ${programId}: ${progResp._error}`, phase: 'preflight' };
  }

  // 1b. Visibility-semantics lint against the batch AND the program's existing
  // rules (show/hide twins, hide+mandate contradictions, inverted "Show X"
  // rules). A failed existing-rules read degrades to batch-only linting.
  {
    const existingRulesResp = await safeDhis2Fetch(
      `programRules?filter=program.id:eq:${programId}&fields=id,name,condition,programRuleActions%5BprogramRuleActionType,dataElement%5Bid,displayName%5D,trackedEntityAttribute%5Bid,displayName%5D,programStage%5Bid,displayName%5D,programStageSection%5Bid,displayName%5D%5D&pageSize=100`
    );
    const semanticErrors = lintRuleVisibilitySemantics(
      rules,
      existingRulesResp._error ? [] : (existingRulesResp.programRules || [])
    );
    if (semanticErrors.length) {
      return {
        success: false,
        _error: `Program rule semantics lint failed (${semanticErrors.length}): ${semanticErrors.join(' | ')}`,
        phase: 'lint',
        errors: semanticErrors,
        _hint: 'Rewrite as ONE hide rule per target (condition = the HIDE case); mandatory-when-visible goes in a separate SETMANDATORYFIELD-only rule with the positive condition. Then retry. Do not work around this by re-wording rule names.',
      };
    }
  }

  // 2a/2b. Apply the shared rule-action sugar: auto-move #{var}/A{attr} from
  //         SHOWWARNING/SHOWERROR/etc content → data, and expand HIDEALLFIELDS into
  //         HIDEFIELD-per-DE (trigger stage) + HIDEPROGRAMSTAGE (other stages).
  // Side effects (executed before rule POST): PSDE compulsory→false PUTs +
  // sibling SETMANDATORYFIELD rule appended to `rules` so the PSDE-flipped DEs
  // remain required when the trigger condition is FALSE (i.e. when shown).
  const sugarPlan = applyRuleActionSugar(rules, progResp.programStages || []);
  const sugarSideEffects = await applyRuleActionSugarSideEffects(sugarPlan, rules);

  // Index existing PRVs by name (case-insensitive for tolerance).
  const existingPRVs = new Map();  // lowercased name → PRV
  for (const prv of (progResp.programRuleVariables || [])) {
    existingPRVs.set(String(prv.name || '').toLowerCase(), prv);
  }

  // Index program DEs by sanitized display name AND by which stage(s) they live in.
  const deBySanitized = new Map();  // sanitized(displayName) → { id, displayName, valueType, optionSet, stageIds:[] }
  const deByDisplayName = new Map(); // raw displayName → same
  const deById = new Map();          // deId → same entry (for ASSIGN option-code checks)
  for (const ps of (progResp.programStages || [])) {
    for (const psde of (ps.programStageDataElements || [])) {
      const de = psde.dataElement;
      if (!de?.id) continue;
      const sKey = sanitizeVariableName(de.displayName);
      let entry = deBySanitized.get(sKey);
      if (!entry) {
        entry = { id: de.id, displayName: de.displayName, valueType: de.valueType, optionSet: de.optionSet, stageIds: [] };
        deBySanitized.set(sKey, entry);
        deByDisplayName.set(de.displayName, entry);
      }
      deById.set(de.id, entry);
      if (!entry.stageIds.includes(ps.id)) entry.stageIds.push(ps.id);
    }
  }

  // Index TEAs by sanitized display name and by UID for A{} rewriting.
  const teaBySanitized = new Map();
  const teaByDisplayName = new Map(); // raw displayName → entry (for action target resolution)
  const teaById = new Map();
  for (const ptea of (progResp.programTrackedEntityAttributes || [])) {
    const tea = ptea.trackedEntityAttribute;
    if (!tea?.id) continue;
    const entry = { id: tea.id, displayName: tea.displayName, valueType: tea.valueType, optionSet: tea.optionSet };
    teaBySanitized.set(sanitizeVariableName(tea.displayName), entry);
    teaByDisplayName.set(tea.displayName, entry);
    teaById.set(tea.id, entry);
  }

  const isDhis2Uid = (s) => /^[a-zA-Z][a-zA-Z0-9]{10}$/.test(s);

  // Stage references in actions may arrive as a stage NAME — resolve name → id.
  const stageNameToId = new Map();
  const validStageIdSet = new Set();
  for (const ps of (progResp.programStages || [])) {
    validStageIdSet.add(ps.id);
    if (ps.displayName) stageNameToId.set(String(ps.displayName).trim().toLowerCase(), ps.id);
  }
  const resolveStageRefForAction = (act) => {
    const ref = act.program_stage_name || act.program_stage_id;
    if (!ref) return null;
    if (validStageIdSet.has(ref)) return ref;
    const byName = stageNameToId.get(String(ref).trim().toLowerCase());
    if (byName) return byName;
    if (isDhis2Uid(String(ref))) return ref; // plausible UID from elsewhere — let the server validate
    return undefined;
  };

  // Resolve a rule action's TARGET (the DE/TEA the action acts on) from either an
  // explicit UID (data_element_id / tei_attribute_id) OR a display name
  // (data_element_name / tracked_entity_attribute_name). The schema advertises the
  // *_name fields as "resolved to ID automatically" and the create_metadata rule
  // path already resolves them (via deUidMap) — this makes manage_program_rules
  // behave identically, so ASSIGN / SETMANDATORYFIELD / HIDEFIELD written by name
  // actually bind instead of bouncing with "DataElement ... cannot be null".
  const resolveActionDeEntry = (act) => {
    if (!act) return null;
    if (act.data_element_id) return deById.get(act.data_element_id) || { id: act.data_element_id };
    const nm = act.data_element_name;
    if (!nm) return null;
    return deByDisplayName.get(nm)
      || deBySanitized.get(String(nm).toLowerCase())
      || deBySanitized.get(sanitizeVariableName(nm))
      || null;
  };
  const resolveActionTeaEntry = (act) => {
    if (!act) return null;
    if (act.tei_attribute_id) return teaById.get(act.tei_attribute_id) || { id: act.tei_attribute_id };
    const nm = act.tracked_entity_attribute_name;
    if (!nm) return null;
    return teaByDisplayName.get(nm)
      || teaBySanitized.get(String(nm).toLowerCase())
      || teaBySanitized.get(sanitizeVariableName(nm))
      || null;
  };

  // 3. Build payload while resolving references per-rule.
  const allPRVs = [];
  const allPRAs = [];
  const allPRs  = [];
  const newPRVsByName = new Map();  // lowercased name → PRV (tracks PRVs we're creating in this batch)
  const unresolved = []; // { rule, ref, suggestions }
  const autoCreated = []; // for summary

  // Pick a smart sourceType: if the DE lives in a stage that this rule's actions also target,
  // CURRENT_EVENT is the right default (in-form visibility). Otherwise fall back to
  // NEWEST_EVENT_PROGRAM (cross-event lookups).
  const pickSourceType = (deEntry, rule) => {
    const actionStageIds = new Set();
    for (const act of (rule.actions || [])) {
      // Resolve the action target by id OR name so name-targeted actions still
      // steer the PRV toward CURRENT_EVENT when they act on the trigger's stage.
      const tgt = resolveActionDeEntry(act);
      if (tgt && Array.isArray(tgt.stageIds)) {
        for (const sid of tgt.stageIds) actionStageIds.add(sid);
      }
      const actStageId = resolveStageRefForAction(act);
      if (actStageId) actionStageIds.add(actStageId);
    }
    for (const sid of deEntry.stageIds) {
      if (actionStageIds.has(sid)) return { sourceType: 'DATAELEMENT_CURRENT_EVENT', stageId: null };
    }
    return { sourceType: 'DATAELEMENT_NEWEST_EVENT_PROGRAM', stageId: null };
  };

  const buildPRVFromDE = (varName, deEntry, rule) => {
    const { sourceType } = pickSourceType(deEntry, rule);
    const prvUid = generateDhis2Uid();
    const prv = {
      id: prvUid,
      name: varName,
      program: { id: programId },
      programRuleVariableSourceType: sourceType,
      valueType: deEntry.valueType || 'TEXT',
      useCodeForOptionSet: !!deEntry.optionSet,
      dataElement: { id: deEntry.id },
    };
    return prv;
  };

  const buildPRVFromTEA = (varName, teaEntry) => {
    const prvUid = generateDhis2Uid();
    return {
      id: prvUid,
      name: varName,
      program: { id: programId },
      programRuleVariableSourceType: 'TEI_ATTRIBUTE',
      valueType: teaEntry.valueType || 'TEXT',
      useCodeForOptionSet: !!teaEntry.optionSet,
      trackedEntityAttribute: { id: teaEntry.id },
    };
  };

  // Ensure a PRV exists for `name`. Returns true if resolved (existing, model-supplied,
  // or auto-created); false if no match could be found — also pushes to `unresolved`.
  const ensureVarForRule = (name, rule) => {
    const key = name.toLowerCase();
    if (existingPRVs.has(key)) return true;
    if (newPRVsByName.has(key)) return true;

    // Model supplied it explicitly — build from the provided def.
    const modelVar = (rule.variables || []).find(v => String(v.name || '').toLowerCase() === key);
    if (modelVar) {
      const prvUid = generateDhis2Uid();
      const prv = {
        id: prvUid,
        name: modelVar.name,
        program: { id: programId },
        programRuleVariableSourceType: modelVar.source_type || 'DATAELEMENT_NEWEST_EVENT_PROGRAM',
        valueType: modelVar.value_type || 'TEXT',
        useCodeForOptionSet: modelVar.use_code_for_option_set || false,
      };
      if (modelVar.data_element_id) prv.dataElement = { id: modelVar.data_element_id };
      if (modelVar.tei_attribute_id) prv.trackedEntityAttribute = { id: modelVar.tei_attribute_id };
      if (modelVar.program_stage_id) prv.programStage = { id: modelVar.program_stage_id };
      allPRVs.push(prv);
      newPRVsByName.set(key, prv);
      return true;
    }

    // Auto-resolve via DE display name (sanitized).
    const deEntry = deBySanitized.get(key) || deBySanitized.get(sanitizeVariableName(name));
    if (deEntry) {
      const prv = buildPRVFromDE(name, deEntry, rule);
      allPRVs.push(prv);
      newPRVsByName.set(key, prv);
      autoCreated.push({ name, source: 'dataElement', data_element_id: deEntry.id, data_element_name: deEntry.displayName, source_type: prv.programRuleVariableSourceType, valueType: prv.valueType });
      return true;
    }

    // Auto-resolve via TEA display name (sanitized).
    const teaEntry = teaBySanitized.get(key) || teaBySanitized.get(sanitizeVariableName(name));
    if (teaEntry) {
      const prv = buildPRVFromTEA(name, teaEntry);
      allPRVs.push(prv);
      newPRVsByName.set(key, prv);
      autoCreated.push({ name, source: 'trackedEntityAttribute', tei_attribute_id: teaEntry.id, source_type: 'TEI_ATTRIBUTE', valueType: prv.valueType });
      return true;
    }

    return false;
  };

  const collectSuggestions = (name) => {
    const nLower = name.toLowerCase();
    const suggestions = [];
    for (const [_, e] of deBySanitized) {
      if (e.displayName && (e.displayName.toLowerCase().includes(nLower) || nLower.includes(sanitizeVariableName(e.displayName)))) {
        suggestions.push({ kind: 'dataElement', id: e.id, displayName: e.displayName });
      }
    }
    for (const [_, e] of teaBySanitized) {
      if (e.displayName && (e.displayName.toLowerCase().includes(nLower) || nLower.includes(sanitizeVariableName(e.displayName)))) {
        suggestions.push({ kind: 'trackedEntityAttribute', id: e.id, displayName: e.displayName });
      }
    }
    return suggestions.slice(0, 6);
  };

  for (const rule of rules) {
    const prUid = generateDhis2Uid();
    let condition = rule.condition || 'true';

    // Extract #{var} references from condition AND any action.data expressions.
    const scanStrings = [condition, ...(rule.actions || []).map(a => a.data || '').filter(Boolean)];
    const varRefs = new Set();
    const attrRefs = new Set();
    for (const s of scanStrings) {
      for (const m of (s.match(/#\{([^}]+)\}/g) || [])) varRefs.add(m.slice(2, -1));
      for (const m of (s.match(/A\{([^}]+)\}/g) || [])) attrRefs.add(m.slice(2, -1));
    }

    for (const name of varRefs) {
      const ok = ensureVarForRule(name, rule);
      if (!ok) unresolved.push({ rule: rule.name, reference: `#{${name}}`, suggestions: collectSuggestions(name) });
    }

    // A{ref}: DHIS2's grammar accepts BOTH a TEA UID and the NAME of a
    // TEI_ATTRIBUTE-sourced programRuleVariable (the demo DB's own rules use
    // e.g. d2:yearsBetween(A{born}, V{current_date}) where "born" is a PRV).
    // Resolution order:
    //   1. UID → pass through.
    //   2. Existing PRV with that name, or a variables:[] entry the model
    //      supplied in THIS rule (source_type TEI_ATTRIBUTE) → keep A{name},
    //      creating the PRV if it came from variables:[]. (Previously this
    //      path was missing: the tool's own error hint told the model to pass
    //      variables:[], then ignored them for A{} refs and refused the POST.)
    //   3. TEA displayName match → rewrite to A{uid}.
    //   4. Otherwise unresolved.
    for (const ref of attrRefs) {
      if (isDhis2Uid(ref) && teaById.has(ref)) continue;
      if (isDhis2Uid(ref)) continue;  // Leave unknown UIDs alone — DHIS2 will resolve at runtime.
      if (existingPRVs.has(ref.toLowerCase()) || newPRVsByName.has(ref.toLowerCase())) continue;
      const suppliedVar = (rule.variables || []).find(v =>
        String(v.name || '').toLowerCase() === ref.toLowerCase()
        && (v.source_type === 'TEI_ATTRIBUTE' || v.tei_attribute_id));
      if (suppliedVar && ensureVarForRule(ref, rule)) continue;
      const teaEntry = teaBySanitized.get(ref.toLowerCase()) || teaBySanitized.get(sanitizeVariableName(ref));
      if (teaEntry) {
        const before = `A{${ref}}`;
        const after  = `A{${teaEntry.id}}`;
        condition = condition.split(before).join(after);
        for (const act of (rule.actions || [])) {
          if (act.data) act.data = act.data.split(before).join(after);
        }
      } else {
        unresolved.push({ rule: rule.name, reference: `A{${ref}}`, suggestions: collectSuggestions(ref) });
      }
    }

    // Build this rule's actions (regardless of unresolved refs — we'll abort below if any).
    const actionRefs = [];
    for (const act of (rule.actions || [])) {
      const praUid = generateDhis2Uid();
      actionRefs.push({ id: praUid });
      const pra = {
        id: praUid,
        programRule: { id: prUid },
        programRuleActionType: act.type,
        evaluationTime: act.evaluation_time || 'ON_DATA_ENTRY',
      };
      if (act.content) pra.content = act.content;
      if (act.data) pra.data = act.data;
      // Resolve the action's target DE/TEA by id OR by display name. Previously
      // only *_id was honored, so a name-targeted ASSIGN/SETMANDATORYFIELD/HIDEFIELD
      // saved with no target and DHIS2 rejected the whole bundle at validation.
      const deTgt = resolveActionDeEntry(act);
      const teaTgt = deTgt ? null : resolveActionTeaEntry(act);
      if (deTgt && deTgt.id) pra.dataElement = { id: deTgt.id };
      else if (teaTgt && teaTgt.id) pra.trackedEntityAttribute = { id: teaTgt.id };
      // A name was supplied but did not resolve → surface it (fail loudly with
      // suggestions) rather than posting a target-less action that bounces server-side.
      if (!pra.dataElement && !pra.trackedEntityAttribute) {
        if (act.data_element_name) {
          unresolved.push({ rule: rule.name, reference: `action target data_element_name="${act.data_element_name}"`, suggestions: collectSuggestions(act.data_element_name) });
        } else if (act.tracked_entity_attribute_name) {
          unresolved.push({ rule: rule.name, reference: `action target tracked_entity_attribute_name="${act.tracked_entity_attribute_name}"`, suggestions: collectSuggestions(act.tracked_entity_attribute_name) });
        }
      }
      const stageId = resolveStageRefForAction(act);
      if (stageId) pra.programStage = { id: stageId };
      if (act.program_stage_section_id) pra.programStageSection = { id: act.program_stage_section_id };
      // Stage-targeting actions without a resolvable stage bounce server-side
      // with "ProgramStage cannot be null" — surface via the unresolved flow.
      if ((act.type === 'HIDEPROGRAMSTAGE' || act.type === 'CREATEEVENT') && !pra.programStage) {
        unresolved.push({
          rule: rule.name,
          reference: `${act.type} target stage "${act.program_stage_name || act.program_stage_id || '(none given)'}"`,
          suggestions: (progResp.programStages || []).map(ps => ({ kind: 'programStage', id: ps.id, displayName: ps.displayName })),
        });
      }
      allPRAs.push(pra);
    }

    const pr = {
      id: prUid,
      name: rule.name,
      program: { id: programId },
      condition,
      programRuleActions: actionRefs,
    };
    if (rule.description) pr.description = rule.description;
    if (rule.priority !== undefined) pr.priority = rule.priority;
    allPRs.push(pr);
  }

  // 4. Abort if any reference could not be resolved — surface a structured hint so
  //    the model can self-correct in the next agentic iteration.
  if (unresolved.length) {
    return {
      success: false,
      _error: `Program rule references cannot be resolved: ${unresolved.map(u => u.reference).join(', ')}`,
      phase: 'variable_resolution',
      unresolved,
      _hint: `Every #{name} must resolve to a programRuleVariable. Either (a) pass variables:[{name, source_type:"DATAELEMENT_CURRENT_EVENT"|"DATAELEMENT_NEWEST_EVENT_PROGRAM"|"TEI_ATTRIBUTE", value_type, data_element_id|tei_attribute_id}] inside the rule, (b) rename the reference to match an existing data element's sanitized display name (lowercase, non-alphanumerics → "_") so it can auto-resolve, or (c) first call manage_program_rules(action=list_variables, program_id=...) to see what variables already exist. A{name} references must use a tracked-entity-attribute UID or a displayName that matches a TEA on the program.`,
    };
  }

  // ── ASSIGN → option-set DE: the assigned literal MUST be an option CODE ──
  // The server-side rule engine (2.42+ runs ASSIGN on tracker import) and the
  // tracker importer validate assigned values against the option set's CODES,
  // not names. A rule assigning 'Moderate' to a DE whose option codes are
  // MILD/MODERATE/SEVERE bounces every event save with E1125. Verified live on
  // play 2.42.5.1 (2026-07-01). Auto-map a name → its code; reject unknowns
  // with the valid code list so the model can self-correct in one iteration.
  {
    const assignsByOptionSet = new Map(); // optionSetId → [pra]
    for (const pra of allPRAs) {
      if (pra.programRuleActionType !== 'ASSIGN' || !pra.dataElement?.id) continue;
      const deEntry = deById.get(pra.dataElement.id);
      const osId = deEntry?.optionSet?.id;
      if (!osId) continue;
      const literal = typeof pra.data === 'string' && pra.data.trim().match(/^'([^']*)'$|^"([^"]*)"$/);
      if (!literal) continue; // dynamic expression — can't statically check
      if (!assignsByOptionSet.has(osId)) assignsByOptionSet.set(osId, []);
      assignsByOptionSet.get(osId).push(pra);
    }
    if (assignsByOptionSet.size) {
      const optionSetIds = [...assignsByOptionSet.keys()];
      const optResps = await Promise.all(optionSetIds.map(id =>
        safeDhis2Fetch(`optionSets/${id}?fields=id,name,options[name,code]`)));
      const codeErrors = [];
      for (let i = 0; i < optionSetIds.length; i++) {
        const os = optResps[i];
        if (!os || os._error) continue; // can't verify — let the server decide
        const byCode = new Map((os.options || []).map(o => [String(o.code), o]));
        const byName = new Map((os.options || []).map(o => [String(o.name).toLowerCase(), o]));
        for (const pra of assignsByOptionSet.get(optionSetIds[i])) {
          const raw = pra.data.trim();
          const value = raw.slice(1, -1);
          if (byCode.has(value)) continue;
          const named = byName.get(value.toLowerCase());
          if (named) {
            pra.data = `'${named.code}'`; // auto-map display name → code
          } else {
            codeErrors.push(`ASSIGN to "${deById.get(pra.dataElement.id)?.displayName}" uses '${value}', which is neither an option code nor an option name of option set "${os.name}". Valid codes: ${(os.options || []).map(o => o.code).join(', ')}`);
          }
        }
      }
      if (codeErrors.length) {
        return {
          success: false,
          _error: `ASSIGN value(s) do not match the target data element's option set: ${codeErrors.join(' | ')}`,
          phase: 'assign_option_code_check',
          _hint: 'ASSIGN writes the raw value into the field; for an option-set data element the value must be an option CODE (names are auto-mapped when they match). Fix the data expression to one of the listed codes and retry.',
        };
      }
    }
  }

  // ── Option-set CONDITION literals: rewrite option NAMES → CODES ──
  // Auto-created option-set PRVs use useCodeForOptionSet=true, so the value the
  // rule engine compares is the option CODE (this matches the DHIS2 demo DB
  // convention, e.g. #{CaseClassifiedAs} != 'IMPORTED'). A condition that compares
  // such a variable to an option NAME (…== 'Positive') lints clean, SAVES, and then
  // NEVER FIRES — a silent failure. We already map ASSIGN data names→codes; do the
  // same for conditions. This only ever rewrites a NAME literal to its CODE — it
  // never touches '' (empty checks) or literals that are already valid codes, so it
  // cannot break a condition that was already correct (it can only fix a broken one).
  let conditionOptionAdvisories = [];
  {
    // varName(lower) → { optionSetId, useCode } for every option-set-backed PRV
    // in scope (freshly built for this batch + already existing on the program).
    const varOptionInfo = new Map();
    const noteVar = (name, useCode, deId, teaId) => {
      if (!name) return;
      let osId = null;
      if (deId) osId = deById.get(deId)?.optionSet?.id || null;
      else if (teaId) osId = teaById.get(teaId)?.optionSet?.id || null;
      if (osId) varOptionInfo.set(String(name).toLowerCase(), { optionSetId: osId, useCode: useCode !== false });
    };
    for (const prv of allPRVs) noteVar(prv.name, prv.useCodeForOptionSet, prv.dataElement?.id, prv.trackedEntityAttribute?.id);
    for (const [, prv] of existingPRVs) noteVar(prv.name, prv.useCodeForOptionSet, prv.dataElement?.id, prv.trackedEntityAttribute?.id);

    // Which option sets do the conditions actually reference (option vars w/ useCode)?
    const neededOsIds = new Set();
    for (const pr of allPRs) {
      for (const m of (pr.condition.match(/#\{([^}]+)\}/g) || [])) {
        const info = varOptionInfo.get(m.slice(2, -1).toLowerCase());
        if (info && info.useCode) neededOsIds.add(info.optionSetId);
      }
    }
    if (neededOsIds.size) {
      const osIds = [...neededOsIds];
      const resps = await Promise.all(osIds.map(id => safeDhis2Fetch(`optionSets/${id}?fields=id,name,options[name,code]`)));
      const osMap = new Map(); // osId → { byCode:Set, byName:Map(lower→code), name, options }
      for (let i = 0; i < osIds.length; i++) {
        const o = resps[i];
        if (!o || o._error) continue;
        osMap.set(osIds[i], {
          byCode: new Set((o.options || []).map(x => String(x.code))),
          byName: new Map((o.options || []).map(x => [String(x.name).toLowerCase(), String(x.code)])),
          name: o.name,
          options: o.options || [],
        });
      }
      for (const pr of allPRs) {
        let cond = pr.condition;
        const usedVars = new Set((cond.match(/#\{([^}]+)\}/g) || []).map(m => m.slice(2, -1)));
        for (const vRaw of usedVars) {
          const info = varOptionInfo.get(vRaw.toLowerCase());
          if (!info || !info.useCode) continue;
          const os = osMap.get(info.optionSetId);
          if (!os) continue;
          const varToken = `#{${vRaw}}`;
          const esc = vRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // `#{var} ==|!= 'literal'` in either order.
          const re = new RegExp(`#\\{${esc}\\}\\s*(==|!=)\\s*'([^']*)'|'([^']*)'\\s*(==|!=)\\s*#\\{${esc}\\}`, 'g');
          cond = cond.replace(re, (full, op1, lit1, lit2, op2) => {
            const lit = (lit1 !== undefined ? lit1 : lit2);
            const op = op1 || op2;
            if (lit === '') return full;         // empty-value check — leave alone
            if (os.byCode.has(lit)) return full; // already a code — leave alone
            const code = os.byName.get(lit.toLowerCase());
            if (code) return op1 ? `${varToken} ${op} '${code}'` : `'${code}' ${op} ${varToken}`;
            // Neither a code nor a name of this option set → advise (don't rewrite).
            conditionOptionAdvisories.push(`Rule "${pr.name}": #{${vRaw}} is compared to '${lit}', which is neither a code nor a name of option set "${os.name}" (codes: ${os.options.map(x => x.code).join(', ')}). This comparison will never match — verify the value.`);
            return full;
          });
        }
        pr.condition = cond;
      }
    }
  }

  const payload = {};
  if (allPRVs.length) payload.programRuleVariables = allPRVs;
  if (allPRAs.length) payload.programRuleActions = allPRAs;
  payload.programRules = allPRs;

  const result = await postMetadataPayload(payload, dryRun);
  return {
    ...result,
    summary: {
      programRules: allPRs.map(r => ({ id: r.id, name: r.name })),
      programRuleVariables: allPRVs.map(v => ({ id: v.id, name: v.name, sourceType: v.programRuleVariableSourceType, dataElement: v.dataElement?.id, trackedEntityAttribute: v.trackedEntityAttribute?.id })),
      programRuleActions: allPRAs.map(a => ({ id: a.id, type: a.programRuleActionType })),
      auto_created_variables: autoCreated,
      reused_existing_variables: Array.from(varRefsCovered(allPRs, existingPRVs)),
      ...(sugarSideEffects.stageUpdates.length ? { compulsory_flags_cleared: sugarSideEffects.stageUpdates } : {}),
      ...(sugarSideEffects.errors.length ? { compulsory_flag_errors: sugarSideEffects.errors } : {}),
      ...(sugarPlan.siblingMandateRules.length ? { auto_paired_mandate_rules: sugarPlan.siblingMandateRules.map(r => r.name) } : {}),
      ...(conditionOptionAdvisories.length ? { condition_option_advisories: conditionOptionAdvisories } : {}),
      ...(autoGuardedConditions.length ? { auto_guarded_conditions: autoGuardedConditions } : {}),
    },
  };
}

// Enumerate variable names that the posted rules reference AND that already existed
// (i.e. were not auto-created). Purely for the summary — helps the model + user see
// which PRVs were reused vs freshly created.
function varRefsCovered(rules, existingPRVs) {
  const out = new Set();
  for (const r of rules) {
    const s = r.condition || '';
    for (const m of (s.match(/#\{([^}]+)\}/g) || [])) {
      const n = m.slice(2, -1).toLowerCase();
      if (existingPRVs.has(n)) out.add(m.slice(2, -1));
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// manage_program_indicators — Full CRUD for program indicators
// ────────────────────────────────────────────────────────────────────────────

// Validate a program indicator expression/filter via DHIS2's server-side description endpoint.
// The endpoint accepts a raw text body (Content-Type: text/plain) and returns { status, description, message }.
async function validateProgramIndicatorExpression(kind, text, programId) {
  if (!dhis2.baseUrl || !dhis2.apiVersion) {
    const ok = await ensureConnected();
    if (!ok) return { _error: 'Not connected to DHIS2' };
  }
  const endpoint = kind === 'filter' ? 'filter/description' : 'expression/description';
  const url = `${dhis2.baseUrl}/api/${dhis2.apiVersion}/programIndicators/${endpoint}?programId=${encodeURIComponent(programId)}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'text/plain',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: text || '',
    });
    const bodyText = await resp.text().catch(() => '');
    if (!resp.ok) {
      // Some DHIS2 versions return 409/400 with JSON { message }; surface that as the error.
      try {
        const parsed = JSON.parse(bodyText);
        return { _error: parsed.message || parsed.description || `HTTP ${resp.status}`, _status: resp.status };
      } catch {
        return { _error: `HTTP ${resp.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`, _status: resp.status };
      }
    }
    try { return JSON.parse(bodyText); } catch { return { status: 'OK', description: bodyText }; }
  } catch (e) {
    return { _error: `Validation fetch failed: ${e.message}` };
  }
}

async function executeManageProgramIndicators(args, ctxProgramId) {
  const action = args.action;
  if (!action) return { _error: 'Missing required parameter: action' };

  const programId = args.program_id || ctxProgramId;

  // ── discover (cross-program, no program_id required) ──
  // Ranks program indicators by expression complexity and/or per-program event volume.
  // One metadata pass (paginated) + parallel analytics counts per distinct program.
  if (action === 'discover') {
    const sortBy = ['complexity', 'data_volume', 'combined'].includes(args.sort_by) ? args.sort_by : 'combined';
    const topN = Math.max(1, Math.min(100, parseInt(args.top_n) || 20));
    const period = (args.period && String(args.period).trim()) || 'LAST_5_YEARS';
    const includeCounts = args.include_event_counts !== false;
    const nameFilter = (args.name_filter || '').trim();
    const programsFilter = Array.isArray(args.programs) ? args.programs.filter(Boolean) : [];

    // Step 1 — fetch all program indicators with pagination
    const PAGE_SIZE = 200;
    const fields = 'id,displayName,shortName,program[id,displayName],expression,filter,analyticsType,aggregationType';
    const buildUrl = (page) => {
      const parts = [
        `fields=${encodeURIComponent(fields)}`,
        `pageSize=${PAGE_SIZE}`,
        `page=${page}`,
        'totalPages=true',
        'order=displayName:asc',
      ];
      if (nameFilter) parts.push(`filter=${encodeURIComponent(`displayName:ilike:${nameFilter}`)}`);
      if (programsFilter.length) parts.push(`filter=${encodeURIComponent(`program.id:in:[${programsFilter.join(',')}]`)}`);
      return `programIndicators?${parts.join('&')}`;
    };

    const first = await safeDhis2Fetch(buildUrl(1), { noTruncate: true });
    if (first?._error) return first;
    const allPIs = Array.isArray(first.programIndicators) ? [...first.programIndicators] : [];
    const totalCount = first.pager?.total ?? allPIs.length;
    const pageCount = first.pager?.pageCount ?? 1;
    const PAGE_CAP = 50; // safety cap: 10,000 indicators
    const fetchErrors = [];
    if (pageCount > 1) {
      const pagePromises = [];
      for (let p = 2; p <= Math.min(pageCount, PAGE_CAP); p++) {
        pagePromises.push(safeDhis2Fetch(buildUrl(p), { noTruncate: true }).then(r => ({ p, r })));
      }
      const results = await Promise.all(pagePromises);
      for (const { p, r } of results) {
        if (r?._error) { fetchErrors.push({ page: p, error: r._error }); continue; }
        if (Array.isArray(r.programIndicators)) allPIs.push(...r.programIndicators);
      }
    }

    if (allPIs.length === 0) {
      return {
        _note: `No program indicators found${nameFilter ? ` matching name_filter="${nameFilter}"` : ''}${programsFilter.length ? ` in programs [${programsFilter.join(',')}]` : ''}.`,
        total_indicators_scanned: 0,
      };
    }

    // Step 2 — compute complexity per indicator
    const scorePI = (pi) => {
      const expr = pi.expression || '';
      const filt = pi.filter || '';
      const combined = `${expr} ${filt}`;
      const hashRefs = (combined.match(/#\{[^}]+\}/g) || []).length;
      const attrRefs = (combined.match(/A\{[^}]+\}/g) || []).length;
      const varRefs = (combined.match(/V\{[^}]+\}/g) || []).length;
      const d2Funcs = (combined.match(/d2:\w+/g) || []).length;
      const operators = (combined.match(/==|!=|<=|>=|&&|\|\||[+\-*/<>]/g) || []).length;
      const condBlocks = (combined.match(/\bcase\b|\bif\b|\?.*:/g) || []).length;
      const length = combined.length;
      const score =
        hashRefs * 2 +
        attrRefs * 2 +
        varRefs * 1 +
        d2Funcs * 3 +
        operators * 1 +
        condBlocks * 2 +
        Math.floor(length / 40);
      return {
        score,
        breakdown: { hash_refs: hashRefs, attr_refs: attrRefs, var_refs: varRefs, d2_funcs: d2Funcs, operators, cond_blocks: condBlocks, length },
      };
    };
    const scored = allPIs.map(pi => ({ pi, complexity: scorePI(pi) }));

    // Step 3 — per-program event counts via /analytics/events/query (totalPages trick, pageSize=1)
    //   Uses USER_ORGUNIT so the count respects the user's org-unit scope. Parallel across programs.
    const distinctProgramIds = Array.from(new Set(scored.map(s => s.pi.program?.id).filter(Boolean)));
    const eventCounts = new Map(); // programId -> number (or null on failure)
    const countErrors = [];
    if (includeCounts && distinctProgramIds.length) {
      const CONCURRENCY = 5;
      const queue = [...distinctProgramIds];
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
          const pid = queue.shift();
          if (!pid) break;
          const path = `analytics/events/query/${pid}?dimension=pe:${encodeURIComponent(period)}&dimension=ou:USER_ORGUNIT&pageSize=1&totalPages=true&outputType=EVENT`;
          const r = await safeDhis2Fetch(path);
          if (r?._error) {
            eventCounts.set(pid, null);
            countErrors.push({ program_id: pid, error: r._error });
            continue;
          }
          const total = r?.metaData?.pager?.total;
          eventCounts.set(pid, Number.isFinite(total) ? total : (parseInt(total, 10) || 0));
        }
      });
      await Promise.all(workers);
    }

    // Step 4 — rank by chosen axis
    const ranked = scored.map(({ pi, complexity }) => {
      const progId = pi.program?.id;
      const events = includeCounts ? eventCounts.get(progId) : null;
      const dataVolume = Number.isFinite(events) ? events : 0;
      let combined;
      if (!includeCounts) {
        combined = complexity.score;
      } else {
        combined = complexity.score * Math.log10(dataVolume + 10);
      }
      return {
        indicator_id: pi.id,
        name: pi.displayName || pi.shortName || pi.id,
        program: { id: progId, name: pi.program?.displayName || progId },
        analytics_type: pi.analyticsType,
        aggregation_type: pi.aggregationType,
        complexity_score: complexity.score,
        complexity_breakdown: complexity.breakdown,
        program_event_count: dataVolume,
        combined_score: Math.round(combined * 100) / 100,
        expression: pi.expression,
        filter: pi.filter || null,
      };
    });
    const sortKey = sortBy === 'complexity' ? 'complexity_score'
      : sortBy === 'data_volume' ? 'program_event_count'
      : 'combined_score';
    ranked.sort((a, b) => (b[sortKey] - a[sortKey]));
    const top = ranked.slice(0, topN);

    return {
      action: 'discover',
      sort_by: sortBy,
      period_used_for_counts: includeCounts ? period : null,
      total_indicators_scanned: allPIs.length,
      total_indicators_in_instance: totalCount,
      distinct_programs_scanned: distinctProgramIds.length,
      pagination_complete: allPIs.length >= totalCount && fetchErrors.length === 0,
      pagination_errors: fetchErrors.length ? fetchErrors : undefined,
      event_count_errors: countErrors.length ? countErrors : undefined,
      top_indicators: top,
      _note: `Top ${top.length} of ${allPIs.length} indicators ranked by ${sortKey}. Complexity = hash_refs×2 + attr_refs×2 + var_refs + d2_funcs×3 + operators + cond_blocks×2 + length÷40. ${includeCounts ? `Event counts over ${period} at USER_ORGUNIT via analytics/events/query totalPages.` : 'Pass include_event_counts=true to rank by data volume as well.'}`,
    };
  }

  // ── rank_ou (cross-program, OU-breakdown) ──
  // For "which OUs/districts/regions/facilities have the most data for these indicators".
  // Takes indicator_ids (preferred, reused from a prior discover call) or an explicit programs list,
  // runs one analytics/events/aggregate per distinct program at the requested OU level, sums per OU.
  if (action === 'rank_ou') {
    const level = Math.max(1, Math.min(6, parseInt(args.level) || 2));
    const period = (args.period && String(args.period).trim()) || 'LAST_5_YEARS';
    const topN = Math.max(1, Math.min(100, parseInt(args.top_n) || 10));

    // Step 0 — resolve distinct program IDs
    let distinctProgramIds = [];
    if (Array.isArray(args.indicator_ids) && args.indicator_ids.length) {
      // Validate indicator IDs look like UIDs, then fetch their programs
      const goodIds = args.indicator_ids.filter(id => /^[A-Za-z][A-Za-z0-9]{10}$/.test(id));
      if (goodIds.length === 0) return {
        _error: 'indicator_ids contained no valid DHIS2 UIDs (must be 11 chars, first alphabetic).',
        _hint: 'Reuse indicator IDs returned by a prior manage_program_indicators(action="discover") call.',
      };
      const fetched = await safeDhis2Fetch(
        `programIndicators?filter=id:in:[${goodIds.join(',')}]&fields=id,program[id]&paging=false`
      );
      if (fetched?._error) return fetched;
      const seen = new Set();
      for (const pi of (fetched.programIndicators || [])) {
        const pid = pi?.program?.id;
        if (pid && !seen.has(pid)) { seen.add(pid); distinctProgramIds.push(pid); }
      }
      const resolvedIds = new Set((fetched.programIndicators || []).map(pi => pi.id));
      const missing = goodIds.filter(id => !resolvedIds.has(id));
      if (missing.length) {
        return {
          _error: `indicator_ids not found in this instance: ${missing.join(', ')}.`,
          _hint: 'Do NOT invent indicator IDs. Use manage_program_indicators(action="discover") to get real UIDs.',
        };
      }
    } else if (Array.isArray(args.programs) && args.programs.length) {
      const known = await getKnownPrograms();
      const goodIds = args.programs.filter(id => /^[A-Za-z][A-Za-z0-9]{10}$/.test(id));
      const bad = goodIds.filter(id => known && !known.has(id));
      if (bad.length) {
        return {
          _error: `programs not found in this instance: ${bad.join(', ')}.`,
          _hint: 'Reuse program UIDs from a prior discover/search_metadata call. NEVER invent.',
        };
      }
      distinctProgramIds = goodIds;
    } else {
      return {
        _error: 'rank_ou requires either indicator_ids or programs.',
        _hint: 'Pass indicator_ids from a prior manage_program_indicators(action="discover"). Do not invent UIDs.',
      };
    }

    if (distinctProgramIds.length === 0) {
      return { _error: 'No distinct programs resolved from the input.' };
    }

    // Step 1 — resolve root OU: user-provided UID, else ctx, else USER_ORGUNIT literal dim
    let rootOuId = (args.root_ou && /^[A-Za-z][A-Za-z0-9]{10}$/.test(args.root_ou)) ? args.root_ou : null;
    if (!rootOuId) rootOuId = dhis2.pageContext?.orgUnitId || null;
    // If still null, use USER_ORGUNIT keyword (analytics accepts it in dimension values).
    const ouDim = rootOuId ? `${rootOuId};LEVEL-${level}` : `USER_ORGUNIT;LEVEL-${level}`;

    // Step 2 — parallel analytics/events/aggregate per program
    const CONCURRENCY = 5;
    const ouTotals = new Map();    // ouId -> number
    const ouNames = new Map();     // ouId -> displayName
    const perProgram = new Map();  // programId -> { name, events, per_ou: Map<ouId, n> }
    const errors = [];
    const queue = [...distinctProgramIds];
    const known = await getKnownPrograms();
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const pid = queue.shift();
        if (!pid) break;
        const path = `analytics/events/aggregate/${pid}?dimension=ou:${encodeURIComponent(ouDim)}&dimension=pe:${encodeURIComponent(period)}`;
        const r = await safeDhis2Fetch(path);
        if (r?._error) { errors.push({ program_id: pid, error: r._error }); continue; }
        const headers = Array.isArray(r.headers) ? r.headers : [];
        const ouIdx = headers.findIndex(h => h?.name === 'ou');
        const vIdx = headers.findIndex(h => h?.name === 'value');
        const items = r?.metaData?.items || {};
        let progTotal = 0;
        const programOus = new Map();
        if (ouIdx >= 0 && vIdx >= 0 && Array.isArray(r.rows)) {
          for (const row of r.rows) {
            const ou = row[ouIdx];
            const v = parseFloat(row[vIdx]);
            if (!ou || !Number.isFinite(v)) continue;
            ouTotals.set(ou, (ouTotals.get(ou) || 0) + v);
            if (items[ou]?.name && !ouNames.has(ou)) ouNames.set(ou, items[ou].name);
            programOus.set(ou, (programOus.get(ou) || 0) + v);
            progTotal += v;
          }
        }
        perProgram.set(pid, {
          name: (known && known.get(pid)) || items[pid]?.name || pid,
          events: progTotal,
          per_ou: programOus,
        });
      }
    });
    await Promise.all(workers);

    if (ouTotals.size === 0 && errors.length === distinctProgramIds.length) {
      return {
        _error: 'All analytics/events/aggregate calls failed.',
        _details: errors,
        _hint: 'Common causes: analytics tables not rebuilt (E7144) or wrong LEVEL for this instance. Try a different level or ask the admin to run the analytics job.',
      };
    }

    // Step 3 — rank
    const rows = Array.from(ouTotals.entries()).map(([ou, total]) => ({
      org_unit_id: ou,
      org_unit_name: ouNames.get(ou) || ou,
      total_events: Math.round(total),
      per_program: Array.from(perProgram.entries())
        .filter(([, p]) => p.per_ou.has(ou))
        .map(([pid, p]) => ({ program_id: pid, program_name: p.name, events: Math.round(p.per_ou.get(ou) || 0) })),
    }));
    rows.sort((a, b) => b.total_events - a.total_events);

    return {
      action: 'rank_ou',
      level,
      period,
      root_ou: rootOuId || 'USER_ORGUNIT',
      programs_scanned: distinctProgramIds.length,
      program_errors: errors.length ? errors : undefined,
      total_org_units_with_data: rows.length,
      top_org_units: rows.slice(0, topN),
      _note: `Top ${Math.min(topN, rows.length)} of ${rows.length} OUs at level ${level} under ${rootOuId || 'USER_ORGUNIT'} over ${period}, summed across ${distinctProgramIds.length} program(s). Per-program breakdown included per OU.`,
    };
  }

  // ── list ──
  if (action === 'list') {
    if (!programId) return { _error: 'program_id required for list' };
    const page = Math.max(1, parseInt(args.page) || 1);
    const resp = await safeDhis2Fetch(
      `programIndicators?filter=program.id:eq:${programId}&fields=id,name,shortName,description,expression,filter,analyticsType,aggregationType,decimals&pageSize=50&page=${page}&order=name:asc`
    );
    if (resp._error) return resp;
    const total = resp.pager?.total ?? 0;
    const pageCount = resp.pager?.pageCount ?? 1;
    return {
      ...resp,
      _page: page,
      _has_more: page < pageCount,
      _total: total,
      _note: page < pageCount
        ? `Showing page ${page} of ${pageCount} (${total} total). Call list(page=${page + 1}) for next page. To find issues across all indicators, use action=audit instead.`
        : `All ${total} indicator(s) shown (page ${page} of ${pageCount}).`,
    };
  }

  // ── audit ──
  if (action === 'audit') {
    if (!programId) return { _error: 'program_id required for audit' };
    const deep = args.deep !== false; // server-side validation default ON; pass deep:false to skip

    // Step 1: Fetch all indicators reliably using pager.pageCount (not batch-length heuristic).
    const PAGE_SIZE = 100;
    const allIndicators = [];
    const firstResp = await safeDhis2Fetch(
      `programIndicators?filter=program.id:eq:${programId}&fields=id,name,expression,filter,analyticsType,aggregationType,analyticsPeriodBoundaries[boundaryTarget,analyticsPeriodBoundaryType]&pageSize=${PAGE_SIZE}&page=1&order=name:asc&totalPages=true`,
      { noTruncate: true }
    );
    if (firstResp._error) return firstResp;
    allIndicators.push(...(firstResp.programIndicators || []));
    const totalCount = firstResp.pager?.total ?? allIndicators.length;
    const pageCount = firstResp.pager?.pageCount ?? 1;
    const fetchedPages = [1];
    const fetchErrors = [];
    const CAP = 100; // safety cap: 10000 indicators
    for (let p = 2; p <= Math.min(pageCount, CAP); p++) {
      const resp = await safeDhis2Fetch(
        `programIndicators?filter=program.id:eq:${programId}&fields=id,name,expression,filter,analyticsType,aggregationType,analyticsPeriodBoundaries[boundaryTarget,analyticsPeriodBoundaryType]&pageSize=${PAGE_SIZE}&page=${p}&order=name:asc`,
        { noTruncate: true }
      );
      if (resp._error) { fetchErrors.push({ page: p, error: resp._error }); continue; }
      allIndicators.push(...(resp.programIndicators || []));
      fetchedPages.push(p);
    }
    const paginationComplete = allIndicators.length >= totalCount && fetchErrors.length === 0;

    // Step 2: Fetch program structure for UID validation
    const progResp = await safeDhis2Fetch(
      `programs/${programId}?fields=programStages[id,programStageDataElements[dataElement[id]]],programTrackedEntityAttributes[trackedEntityAttribute[id]]`,
      { noTruncate: true }
    );

    const validStageIds = new Set();
    const validStageDeIds = new Map(); // stageId -> Set<deId>
    const validTeaIds = new Set();

    if (!progResp._error && !progResp._truncated) {
      for (const stage of (progResp.programStages || [])) {
        validStageIds.add(stage.id);
        const deSet = new Set();
        for (const psde of (stage.programStageDataElements || [])) {
          if (psde.dataElement?.id) deSet.add(psde.dataElement.id);
        }
        validStageDeIds.set(stage.id, deSet);
      }
      for (const ptea of (progResp.programTrackedEntityAttributes || [])) {
        if (ptea.trackedEntityAttribute?.id) validTeaIds.add(ptea.trackedEntityAttribute.id);
      }
    }
    const structureAvailable = validStageIds.size > 0;

    // Known program-indicator expression variables. Anything else inside V{...} is invalid.
    // Ref: https://docs.dhis2.org/master/en/developer/html/dhis2_developer_manual_full.html (Program Indicators)
    const VALID_V_VARS = new Set([
      'event_count', 'tei_count', 'enrollment_count', 'event_date', 'enrollment_date',
      'incident_date', 'due_date', 'completed_date', 'execution_date', 'scheduled_date',
      'value_count', 'zero_pos_value_count', 'org_unit_count', 'current_date',
      'reporting_period_start', 'reporting_period_end', 'enrollment_status', 'event_status',
      'program_stage_id', 'program_stage_name', 'analytics_period_start', 'analytics_period_end',
      'creation_date', 'completed_status', 'sync_date',
    ]);
    const VALID_D2_FUNCS = new Set([
      'condition', 'count', 'countIfValue', 'countIfCondition', 'daysBetween', 'hasValue',
      'maxValue', 'minValue', 'monthsBetween', 'oizp', 'relationshipCount', 'weeksBetween',
      'yearsBetween', 'zing', 'zpvc', 'zScoreHFA', 'zScoreWFA', 'zScoreWFH',
      'addDays', 'ceil', 'floor', 'round', 'modulus', 'validatePattern', 'left', 'right',
      'substring', 'split', 'concatenate', 'length', 'inOrgUnitGroup', 'lastEventDate',
    ]);

    // Step 3: Analyse each indicator for structural issues
    const issues = [];
    for (const pi of allIndicators) {
      const piIssues = [];

      if (!pi.analyticsPeriodBoundaries || pi.analyticsPeriodBoundaries.length === 0) {
        piIssues.push('Missing analyticsPeriodBoundaries — indicator will not compute in analytics');
      }
      if (pi.analyticsType === 'ENROLLMENT'
          && Array.isArray(pi.analyticsPeriodBoundaries) && pi.analyticsPeriodBoundaries.length
          && pi.analyticsPeriodBoundaries.every(b => b.boundaryTarget === 'EVENT_DATE')) {
        piIssues.push('ENROLLMENT indicator with EVENT_DATE-only boundaries — values are distorted: each enrollment is counted in EVERY period containing one of its events, and d2:count()-style filters see only same-period events (often always 0). Recreate the boundaries with boundaryTarget ENROLLMENT_DATE (update the indicator with analytics_type ENROLLMENT after clearing boundaries, or delete + re-create via this tool).');
      }
      if (!pi.expression || !pi.expression.trim()) {
        piIssues.push('Empty expression — indicator has no measure defined');
      }

      const exprStr = pi.expression || '';
      const filterStr = pi.filter || '';

      // Balanced braces/parens (quick syntactic sanity check on the expression and filter)
      for (const [label, s] of [['expression', exprStr], ['filter', filterStr]]) {
        if (!s) continue;
        let depthParen = 0, depthBrace = 0;
        for (const c of s) {
          if (c === '(') depthParen++;
          else if (c === ')') depthParen--;
          else if (c === '{') depthBrace++;
          else if (c === '}') depthBrace--;
          if (depthParen < 0 || depthBrace < 0) break;
        }
        if (depthParen !== 0) piIssues.push(`Unbalanced parentheses in ${label}`);
        if (depthBrace !== 0) piIssues.push(`Unbalanced braces in ${label}`);
      }

      const combined = exprStr + ' ' + filterStr;

      // #{...} references — must be stageId.deId or stageId.deId.optionId form
      const hashRefs = [...combined.matchAll(/#\{([^}]*)\}/g)];
      const seenHash = new Set();
      for (const [, inside] of hashRefs) {
        if (seenHash.has(inside)) continue;
        seenHash.add(inside);
        const parts = inside.split('.');
        if (parts.length < 2) {
          piIssues.push(`Malformed data element reference: #{${inside}} — must be #{stageId.deId}`);
          continue;
        }
        const [stageId, deId] = parts;
        if (!/^[A-Za-z][A-Za-z0-9]{10}$/.test(stageId) || !/^[A-Za-z][A-Za-z0-9]{10}$/.test(deId)) {
          piIssues.push(`Invalid UID in #{${inside}} — DHIS2 UIDs are 11 chars, first alphabetic`);
          continue;
        }
        if (structureAvailable) {
          if (!validStageIds.has(stageId)) {
            piIssues.push(`References unknown program stage: ${stageId}`);
          } else if (!validStageDeIds.get(stageId)?.has(deId)) {
            piIssues.push(`Data element ${deId} not found in stage ${stageId}`);
          }
        }
      }

      // A{attrId} references
      const teaRefs = [...combined.matchAll(/A\{([^}]*)\}/g)];
      const seenTea = new Set();
      for (const [, inside] of teaRefs) {
        if (seenTea.has(inside)) continue;
        seenTea.add(inside);
        if (!/^[A-Za-z][A-Za-z0-9]{10}$/.test(inside)) {
          piIssues.push(`Invalid TEA reference shape: A{${inside}}`);
          continue;
        }
        if (structureAvailable && !validTeaIds.has(inside)) {
          piIssues.push(`References unknown tracked entity attribute: ${inside}`);
        }
      }

      // V{...} — must be a known program-indicator variable
      const varRefs = [...combined.matchAll(/V\{([^}]*)\}/g)];
      for (const [, v] of varRefs) {
        if (!VALID_V_VARS.has(v)) {
          piIssues.push(`Unknown V{} variable: V{${v}} — not a recognised program-indicator variable`);
        }
      }

      // d2:functionName(...) — must be a known d2 function
      const d2Calls = [...combined.matchAll(/d2:([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];
      for (const [, fn] of d2Calls) {
        if (!VALID_D2_FUNCS.has(fn)) {
          piIssues.push(`Unknown d2 function: d2:${fn}( — not a recognised program-indicator function`);
        }
      }

      // Detect ref-shapes that should not appear in program indicators
      if (/\bC\{[^}]+\}/.test(combined)) piIssues.push('C{} (category option combo) references are not valid in program indicators');
      if (/\bI\{[^}]+\}/.test(combined)) piIssues.push('I{} (indicator) references are not valid in program indicators');
      if (/\bOUG\{[^}]+\}/.test(combined)) piIssues.push('OUG{} references are not valid in program indicators');

      if (piIssues.length > 0) {
        issues.push({
          id: pi.id,
          name: pi.name,
          issues: piIssues,
          expression: exprStr.substring(0, 300),
          filter: filterStr ? filterStr.substring(0, 300) : null,
        });
      }
    }

    // Step 3b: Optional server-side validation via /programIndicators/expression/description.
    // Catches everything local rules miss (semantic errors, type mismatches, non-existent IDs we
    // couldn't resolve). Skipped when deep=false to save API calls on very large programs.
    let serverValidated = 0;
    let serverIssuesAdded = 0;
    if (deep && allIndicators.length > 0 && allIndicators.length <= 600) {
      const knownBrokenIds = new Set(issues.map(i => i.id));
      const concurrency = 6;
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= allIndicators.length) return;
          const pi = allIndicators[idx];
          const checks = [];
          if (pi.expression && pi.expression.trim()) {
            checks.push(['expression', pi.expression]);
          }
          if (pi.filter && pi.filter.trim()) {
            checks.push(['filter', pi.filter]);
          }
          const newMessages = [];
          for (const [kind, text] of checks) {
            try {
              const res = await validateProgramIndicatorExpression(kind, text, programId);
              serverValidated++;
              // DHIS2 returns { status: "OK"|"ERROR", description, message }
              const status = res?.status;
              const isBad = res?._error
                || (status && status !== 'OK' && status !== 'VALID' && status !== 'SUCCESS');
              if (isBad) {
                const msg = res._error || res.message || res.description || status || 'unknown error';
                newMessages.push(`Server rejected ${kind}: ${String(msg).substring(0, 200)}`);
              }
            } catch { /* ignore transient errors; structural scan already ran */ }
          }
          if (newMessages.length) {
            let entry = issues.find(i => i.id === pi.id);
            if (!entry) {
              entry = {
                id: pi.id,
                name: pi.name,
                issues: [],
                expression: (pi.expression || '').substring(0, 300),
                filter: pi.filter ? pi.filter.substring(0, 300) : null,
              };
              issues.push(entry);
            }
            for (const m of newMessages) {
              if (!entry.issues.includes(m)) { entry.issues.push(m); serverIssuesAdded++; }
            }
            knownBrokenIds.add(pi.id);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    }

    // Detect wrong stage IDs referenced across the broken indicators and build bulk_fix hints
    const wrongStageToIndicators = new Map();
    for (const issue of issues) {
      for (const msg of issue.issues) {
        const m = msg.match(/References unknown program stage: ([A-Za-z][A-Za-z0-9]{10})/);
        if (m) {
          const sid = m[1];
          if (!wrongStageToIndicators.has(sid)) wrongStageToIndicators.set(sid, []);
          wrongStageToIndicators.get(sid).push({ id: issue.id, name: issue.name });
        }
      }
    }
    const stageFixHints = [];
    for (const [wrongStageId, affected] of wrongStageToIndicators.entries()) {
      stageFixHints.push({
        wrong_stage_id: wrongStageId,
        affected_indicator_ids: affected.map(a => a.id),
        affected_indicator_names: affected.map(a => a.name),
        fix_action: `manage_program_indicators(action=bulk_fix, indicator_ids=[${affected.map(a => `"${a.id}"`).join(',')}], replace_stage_id="${wrongStageId}", with_stage_id="<correct_stage_id>")`,
        note: 'Find the correct stage ID from the program structure, then call bulk_fix — it fetches, patches, and saves all indicators in one operation.',
      });
    }

    const serverValidatedNote = deep
      ? (allIndicators.length > 600
        ? 'server validation skipped (program has >600 indicators — pass deep:false or use bulk_fix after local audit)'
        : `server validated ${serverValidated} expression/filter strings, added ${serverIssuesAdded} server-detected issue(s)`)
      : 'server validation skipped (deep:false)';

    return {
      program_id: programId,
      total_indicators_checked: allIndicators.length,
      total_in_program: totalCount,
      pages_fetched: fetchedPages.length,
      total_pages: pageCount,
      pagination_complete: paginationComplete,
      total_with_issues: issues.length,
      structure_validation: structureAvailable ? 'full (stage+DE+TEA references checked)' : 'limited (program structure unavailable, only boundaries/expression checked)',
      server_validation: serverValidatedNote,
      issues: issues.slice(0, 250),
      _has_more_issues: issues.length > 250,
      ...(fetchErrors.length ? { _fetch_errors: fetchErrors } : {}),
      ...(stageFixHints.length > 0 ? { _stage_fix_hints: stageFixHints } : {}),
      _fix_hint: issues.length === 0 ? undefined
        : 'To fix expression/filter issues on one or many indicators in a single batch, use manage_program_indicators(action=bulk_fix_expressions, fixes=[{indicator_id, expression?, filter?}]). For a simple wrong-stage-id swap across many indicators, use action=bulk_fix.',
      summary: issues.length === 0
        ? `All ${allIndicators.length} indicators are structurally valid${deep ? ' (structural + server-side description check)' : ''} — boundaries present, references resolve${paginationComplete ? '' : ' (⚠️ pagination INCOMPLETE: some pages failed — retry)'}.`
        : `Found ${issues.length} of ${allIndicators.length} indicators with issues${paginationComplete ? '' : ' (⚠️ pagination INCOMPLETE: some pages failed — retry)'}. Use bulk_fix_expressions to apply per-indicator fixes, or bulk_fix for wrong-stage-id swaps. NEVER use dhis2_query PUT/PATCH.`,
    };
  }

  // ── bulk_fix ──
  // Replace a wrong stage ID with the correct one across multiple indicators in a single metadata batch.
  // This is the correct approach when audit returns "References unknown program stage" issues.
  if (action === 'bulk_fix') {
    const _gate = requireWriteAuth('manage_program_indicators', 'bulk_fix', { count: (args.indicator_ids || []).length });
    if (_gate) return _gate;
    if (!args.indicator_ids?.length) return { _error: 'indicator_ids array required for bulk_fix' };
    if (!args.replace_stage_id) return { _error: 'replace_stage_id required for bulk_fix' };
    if (!args.with_stage_id) return { _error: 'with_stage_id required for bulk_fix' };

    const wrongId = args.replace_stage_id;
    const rightId = args.with_stage_id;
    const fixStr = s => (s ? s.replace(new RegExp(wrongId, 'g'), rightId) : s);

    const piObjects = [];
    const fetchErrors = [];
    for (const indId of args.indicator_ids) {
      const existing = await safeDhis2Fetch(
        `programIndicators/${indId}?fields=id,name,shortName,description,expression,filter,analyticsType,aggregationType,decimals,displayInForm,program[id],categoryCombo[id],attributeCombo[id],analyticsPeriodBoundaries[id,boundaryTarget,analyticsPeriodBoundaryType]`
      );
      if (existing._error) { fetchErrors.push({ id: indId, error: existing._error }); continue; }

      const pi = {
        id: existing.id,
        name: existing.name,
        shortName: existing.shortName,
        program: { id: existing.program?.id || programId },
        expression: fixStr(existing.expression),
        filter: fixStr(existing.filter),
        analyticsType: existing.analyticsType || 'EVENT',
        aggregationType: existing.aggregationType || 'COUNT',
        categoryCombo:  { id: existing.categoryCombo?.id  || 'bjDvmb4bfuf' },
        attributeCombo: { id: existing.attributeCombo?.id || 'bjDvmb4bfuf' },
        analyticsPeriodBoundaries: existing.analyticsPeriodBoundaries || [
          { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' },
          { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' },
        ],
      };
      if (existing.description !== undefined) pi.description = existing.description;
      if (existing.decimals  !== undefined) pi.decimals  = existing.decimals;
      pi.displayInForm = existing.displayInForm === true;
      piObjects.push(pi);
    }

    if (fetchErrors.length) return { _error: 'Could not fetch some indicators', fetch_errors: fetchErrors };
    if (!piObjects.length)  return { _error: 'No indicators to update after fetch' };

    const backup = await ensureBackupOrBail(
      { operation: 'bulk_fix', tool: 'manage_program_indicators', action: 'bulk_fix', reason: `Replacing stage id ${wrongId} → ${rightId} on ${piObjects.length} indicator(s)` },
      piObjects.map((p) => ({ object_type: 'programIndicators', object_id: p.id, role: 'primary' })),
      args
    );
    if (!backup.ok) return backup.error;

    const result = await postMetadataPayload({ programIndicators: piObjects }, false);
    return {
      ...result,
      summary: {
        fixed_count: piObjects.length,
        replaced: `${wrongId} → ${rightId}`,
        indicators: piObjects.map(p => ({ id: p.id, name: p.name })),
      },
      backup: backup.block,
    };
  }

  // ── bulk_fix_expressions ──
  // Apply arbitrary per-indicator expression/filter replacements in a single metadata batch.
  // Supports two shapes per entry in `fixes`:
  //   { indicator_id, expression?, filter? }              — set expression/filter to the given strings
  //   { indicator_id, find, replace, scope? }             — regex replace. scope: "both"|"expression"|"filter" (default both)
  // Optionally set `validate: true` to server-validate each new expression/filter before POSTing;
  // entries that fail validation are rejected and returned in `validation_errors` instead of committed.
  if (action === 'bulk_fix_expressions') {
    const _gate = requireWriteAuth('manage_program_indicators', 'bulk_fix_expressions', { count: (args.fixes || []).length });
    if (_gate) return _gate;
    if (!Array.isArray(args.fixes) || !args.fixes.length) {
      return { _error: 'fixes array required for bulk_fix_expressions — each entry: { indicator_id, expression? | filter? | find+replace+scope? }' };
    }
    const validate = args.validate !== false;

    const piObjects = [];
    const fetchErrors = [];
    const changes = [];

    for (const fix of args.fixes) {
      if (!fix.indicator_id) { fetchErrors.push({ error: 'fix entry missing indicator_id', entry: fix }); continue; }

      const existing = await safeDhis2Fetch(
        `programIndicators/${fix.indicator_id}?fields=id,name,shortName,description,expression,filter,analyticsType,aggregationType,decimals,displayInForm,program[id],categoryCombo[id],attributeCombo[id],analyticsPeriodBoundaries[id,boundaryTarget,analyticsPeriodBoundaryType]`
      );
      if (existing._error) { fetchErrors.push({ id: fix.indicator_id, error: existing._error }); continue; }

      let newExpression = existing.expression;
      let newFilter = existing.filter;

      if (typeof fix.expression === 'string') newExpression = fix.expression;
      if (typeof fix.filter === 'string')     newFilter     = fix.filter;
      if (fix.find && typeof fix.replace === 'string') {
        const scope = fix.scope || 'both';
        try {
          const re = new RegExp(fix.find, 'g');
          if (scope === 'both' || scope === 'expression') newExpression = (newExpression || '').replace(re, fix.replace);
          if (scope === 'both' || scope === 'filter')     newFilter     = (newFilter || '').replace(re, fix.replace);
        } catch (e) {
          fetchErrors.push({ id: fix.indicator_id, error: `Invalid regex in fix.find: ${e.message}` });
          continue;
        }
      }

      const pi = {
        id: existing.id,
        name: existing.name,
        shortName: existing.shortName,
        program: { id: existing.program?.id || programId },
        expression: newExpression,
        filter: newFilter,
        analyticsType: existing.analyticsType || 'EVENT',
        aggregationType: existing.aggregationType || 'COUNT',
        categoryCombo:  { id: existing.categoryCombo?.id  || 'bjDvmb4bfuf' },
        attributeCombo: { id: existing.attributeCombo?.id || 'bjDvmb4bfuf' },
        analyticsPeriodBoundaries: existing.analyticsPeriodBoundaries || [
          { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' },
          { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' },
        ],
      };
      if (existing.description !== undefined) pi.description = existing.description;
      if (existing.decimals !== undefined)    pi.decimals    = existing.decimals;
      pi.displayInForm = existing.displayInForm === true;

      changes.push({
        id: pi.id,
        name: pi.name,
        expression_changed: newExpression !== existing.expression,
        filter_changed: newFilter !== existing.filter,
        before: { expression: existing.expression || null, filter: existing.filter || null },
        after:  { expression: newExpression || null,        filter: newFilter || null },
      });
      piObjects.push(pi);
    }

    if (!piObjects.length) {
      return { _error: 'No indicators to update after fetch', fetch_errors: fetchErrors };
    }

    // Optional server-side validation of the new expressions before committing.
    const validationErrors = [];
    if (validate) {
      for (let i = piObjects.length - 1; i >= 0; i--) {
        const pi = piObjects[i];
        const progIdForCheck = pi.program?.id || programId;
        if (!progIdForCheck) continue;
        for (const [kind, text] of [['expression', pi.expression], ['filter', pi.filter]]) {
          if (!text || !String(text).trim()) continue;
          const res = await validateProgramIndicatorExpression(kind, text, progIdForCheck);
          const status = res?.status;
          const bad = res?._error || (status && status !== 'OK' && status !== 'VALID' && status !== 'SUCCESS');
          if (bad) {
            validationErrors.push({
              id: pi.id,
              name: pi.name,
              kind,
              rejected_value: (text || '').substring(0, 300),
              reason: res._error || res.message || res.description || status || 'unknown error',
            });
            piObjects.splice(i, 1);
            break;
          }
        }
      }
    }

    if (args.dry_run_only) {
      return {
        success: true,
        phase: 'dry_run',
        message: 'Dry run only. No changes committed.',
        would_commit: piObjects.length,
        changes,
        validation_errors: validationErrors,
        fetch_errors: fetchErrors,
      };
    }

    if (!piObjects.length) {
      return {
        _error: 'All fixes were rejected by server-side validation. Pass validate:false to bypass, or supply corrected expressions.',
        validation_errors: validationErrors,
        fetch_errors: fetchErrors,
      };
    }

    const backup = await ensureBackupOrBail(
      { operation: 'bulk_fix_expressions', tool: 'manage_program_indicators', action: 'bulk_fix_expressions', reason: `Bulk-fixing expressions on ${piObjects.length} indicator(s)` },
      piObjects.map((p) => ({ object_type: 'programIndicators', object_id: p.id, role: 'primary' })),
      args
    );
    if (!backup.ok) return backup.error;

    const result = await postMetadataPayload({ programIndicators: piObjects }, false);
    return {
      ...result,
      summary: {
        fixed_count: piObjects.length,
        validation_performed: validate,
        validation_errors_count: validationErrors.length,
        fetch_errors_count: fetchErrors.length,
        indicators: piObjects.map(p => ({ id: p.id, name: p.name })),
      },
      changes,
      ...(validationErrors.length ? { validation_errors: validationErrors } : {}),
      ...(fetchErrors.length ? { fetch_errors: fetchErrors } : {}),
      backup: backup.block,
    };
  }

  // ── get ──
  if (action === 'get') {
    if (!args.indicator_id) return { _error: 'indicator_id required for get' };
    return safeDhis2Fetch(
      `programIndicators/${args.indicator_id}?fields=id,name,shortName,description,expression,filter,analyticsType,aggregationType,decimals,displayInForm,program[id,displayName],analyticsPeriodBoundaries[id,boundaryTarget,analyticsPeriodBoundaryType],categoryCombo[id,name],attributeCombo[id,name]`
    );
  }

  // ── create ──
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_program_indicators', 'create');
    if (_gate) return _gate;
    if (!programId) return { _error: 'program_id required for create' };
    if (!args.indicator) return { _error: 'indicator object required for create' };
    if (!args.indicator.name) return { _error: 'indicator.name is required' };
    return await _buildAndPostProgramIndicator(programId, null, args.indicator, args.dry_run_only);
  }

  // ── update ──
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_program_indicators', 'update', { indicator_id: args.indicator_id });
    if (_gate) return _gate;
    if (!args.indicator_id) return { _error: 'indicator_id required for update' };
    if (!args.indicator) return { _error: 'indicator object (fields to change) required for update' };

    // Verify the indicator exists BEFORE touching it. 404 → STOP.
    const _verify = await verifyTargetExists('programIndicators', args.indicator_id, 'manage_program_indicators', 'update',
      'id,name,shortName,description,expression,filter,analyticsType,aggregationType,decimals,displayInForm,program[id],categoryCombo[id],attributeCombo[id],analyticsPeriodBoundaries[id,boundaryTarget,analyticsPeriodBoundaryType]');
    if (!_verify.exists) return _verify.refusal;
    const existing = _verify.data;

    if (!args.dry_run_only) {
      const backup = await ensureBackupOrBail(
        { operation: 'update', tool: 'manage_program_indicators', action: 'update', reason: `Updating program indicator ${existing.name || args.indicator_id}` },
        [{ object_type: 'programIndicators', object_id: args.indicator_id, role: 'primary' }],
        args
      );
      if (!backup.ok) return backup.error;
      const updateResult = await _buildAndPostProgramIndicator(existing.program?.id || programId, args.indicator_id, {
        name:             args.indicator.name             ?? existing.name,
        short_name:       args.indicator.short_name       ?? existing.shortName,
        description:      args.indicator.description      ?? existing.description,
        expression:       args.indicator.expression       ?? existing.expression,
        filter:           args.indicator.filter           ?? existing.filter,
        analytics_type:   args.indicator.analytics_type   ?? existing.analyticsType,
        aggregation_type: args.indicator.aggregation_type ?? existing.aggregationType,
        decimals:         args.indicator.decimals         ?? existing.decimals,
        display_in_form:  args.indicator.display_in_form  ?? existing.displayInForm,
        _catComboId:      existing.categoryCombo?.id,
        _attrComboId:     existing.attributeCombo?.id,
        // Changing the analytics type invalidates the old boundary pair — drop
        // it so the type-correct defaults regenerate.
        _boundaries:      (args.indicator.analytics_type && args.indicator.analytics_type !== existing.analyticsType) ? null : existing.analyticsPeriodBoundaries,
      }, args.dry_run_only);
      if (updateResult && typeof updateResult === 'object' && !Array.isArray(updateResult)) {
        updateResult.backup = backup.block;
      }
      return updateResult;
    }

    return await _buildAndPostProgramIndicator(existing.program?.id || programId, args.indicator_id, {
      name:             args.indicator.name             ?? existing.name,
      short_name:       args.indicator.short_name       ?? existing.shortName,
      description:      args.indicator.description      ?? existing.description,
      expression:       args.indicator.expression       ?? existing.expression,
      filter:           args.indicator.filter           ?? existing.filter,
      analytics_type:   args.indicator.analytics_type   ?? existing.analyticsType,
      aggregation_type: args.indicator.aggregation_type ?? existing.aggregationType,
      decimals:         args.indicator.decimals         ?? existing.decimals,
      display_in_form:  args.indicator.display_in_form  ?? existing.displayInForm,
      _catComboId:      existing.categoryCombo?.id,
      _attrComboId:     existing.attributeCombo?.id,
      _boundaries:      (args.indicator.analytics_type && args.indicator.analytics_type !== existing.analyticsType) ? null : existing.analyticsPeriodBoundaries,
    }, args.dry_run_only);
  }

  // ── delete ──
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_program_indicators', 'delete', { indicator_id: args.indicator_id });
    if (_gate) return _gate;
    if (!args.indicator_id) return { _error: 'indicator_id required for delete' };

    // Verify the indicator exists BEFORE deleting. 404 → STOP.
    const _verify = await verifyTargetExists('programIndicators', args.indicator_id, 'manage_program_indicators', 'delete');
    if (!_verify.exists) return _verify.refusal;

    const backup = await ensureBackupOrBail(
      { operation: 'delete', tool: 'manage_program_indicators', action: 'delete', reason: `Deleting program indicator ${args.indicator_id}` },
      [{ object_type: 'programIndicators', object_id: args.indicator_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const resp = await safeDhis2Fetch(`programIndicators/${args.indicator_id}`, { method: 'DELETE' });
    if (resp._error) return { ...resp, backup: backup.block };
    return { success: true, deleted_indicator_id: args.indicator_id, backup: backup.block };
  }

  return { _error: `Unknown action: ${action}. Use: list, get, create, update, delete, audit, bulk_fix, bulk_fix_expressions, discover, rank_ou` };
}

// Build and POST a program indicator object.
// indicator_id=null → create new; indicator_id=string → update existing.
async function _buildAndPostProgramIndicator(programId, indicatorId, indicator, dryRun) {
  // Resolve default categoryCombo once
  const catComboId = indicator._catComboId
    || (await safeDhis2Fetch('categoryCombos?filter=name:eq:default&fields=id&pageSize=1'))?.categoryCombos?.[0]?.id
    || 'bjDvmb4bfuf';

  const uid = indicatorId || generateDhis2Uid();
  // Boundary target MUST follow the analytics type. An ENROLLMENT indicator
  // with EVENT_DATE boundaries silently corrupts the numbers (verified live on
  // play 2.42.5.1, 2026-07-10): each enrollment is counted in EVERY period
  // that contains one of its events (massive over-count), and d2:count()
  // filters see only same-period events, so "4+ ANC visits" style indicators
  // return 0 forever. The Maintenance app uses ENROLLMENT_DATE for enrollment
  // PIs — mirror that.
  const analyticsType = indicator.analytics_type || 'EVENT';
  const boundaryTarget = analyticsType === 'ENROLLMENT' ? 'ENROLLMENT_DATE' : 'EVENT_DATE';
  const pi = {
    id: uid,
    name: indicator.name,
    shortName: clampShortName(indicator.short_name, indicator.name, null, 'Indicator'),
    program: { id: programId },
    expression: indicator.expression || 'V{event_count}',
    filter: indicator.filter || '',
    analyticsType,
    aggregationType: indicator.aggregation_type || 'COUNT',
    categoryCombo:  { id: catComboId },
    attributeCombo: { id: indicator._attrComboId || catComboId },
    // Preserve existing boundaries on update; generate the type-correct pair on create
    analyticsPeriodBoundaries: indicator._boundaries || [
      { boundaryTarget, analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' },
      { boundaryTarget, analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' },
    ],
  };
  if (indicator.description !== undefined) pi.description = indicator.description;
  if (indicator.decimals !== undefined) pi.decimals = indicator.decimals;
  // Always serialize displayInForm: the metadata import replaces the FULL
  // object, so omitting it on update would silently reset a widget-visible
  // indicator back to hidden. Callers thread existing.displayInForm through.
  pi.displayInForm = indicator.display_in_form === true;

  // Pre-flight validation. DHIS2 happily returns 201 on a syntactically broken
  // filter (e.g. d2:contains is a program-rule fn, not a PI fn) — but analytics
  // then returns 409 forever after. Lint locally first, then ask DHIS2's own
  // /expression/description and /filter/description endpoints. Fail fast with a
  // structured hint so the model can self-correct in the next loop iteration.
  const exprLint = lintProgramIndicatorExpression(pi.expression, 'expression');
  if (exprLint) {
    return {
      _error: `Program indicator ${indicatorId ? 'update' : 'create'} blocked by expression lint. ${exprLint.error}`,
      _hint: exprLint.hint || 'Fix the expression and retry.',
      expression: pi.expression,
    };
  }
  if (pi.filter && pi.filter.trim()) {
    const filterLint = lintProgramIndicatorExpression(pi.filter, 'filter');
    if (filterLint) {
      return {
        _error: `Program indicator ${indicatorId ? 'update' : 'create'} blocked by filter lint. ${filterLint.error}`,
        _hint: filterLint.hint || 'Fix the filter and retry.',
        filter: pi.filter,
      };
    }
  }

  // Server-side validation — authoritative. Catches semantic errors the local
  // lint can't (unresolved DE/stage/TEA IDs, type mismatches, parser quirks).
  const exprChecks = [];
  exprChecks.push(['expression', pi.expression]);
  if (pi.filter && pi.filter.trim()) exprChecks.push(['filter', pi.filter]);
  const validationResults = await Promise.all(
    exprChecks.map(([kind, text]) =>
      validateProgramIndicatorExpression(kind, text, programId).then(r => ({ kind, text, r }))
    )
  );
  for (const { kind, text, r } of validationResults) {
    const status = r?.status;
    const isBad = r?._error || (status && status !== 'OK' && status !== 'VALID' && status !== 'SUCCESS');
    if (isBad) {
      const msg = r._error || r.message || r.description || status || 'invalid';
      const hint = (kind === 'filter' && /d2:contains|Invalid string token 'd'/.test(String(msg)))
        ? 'Likely cause: `d2:contains(...)` was used in a PI filter. d2:contains exists only in Program Rules, not Program Indicators. There is NO contains operator in DHIS2 2.41 PI grammar — `==` is exact match, even for MULTI_TEXT. For "MULTI_TEXT contains both X and Y": split the multi-select into separate BOOLEAN data elements and filter `#{stage.dm} == true && #{stage.htn} == true`. Or use the Line Listing app for ad-hoc analysis.'
        : (kind === 'filter'
          ? 'Fix the filter using only PI grammar: ==, !=, <, >, <=, >=, &&, ||, +, -, *, / and supported d2:* functions. No LIKE/IN/regex/subExpression.'
          : 'Fix the expression using only PI grammar and supported d2:* functions.');
      return {
        _error: `Program indicator ${kind} rejected by DHIS2 server: ${String(msg).substring(0, 300)}`,
        _server_description: r.description,
        _hint: hint,
        [kind]: text,
      };
    }
  }

  if (dryRun) {
    return { success: true, phase: 'dry_run', message: 'Dry run only. No changes committed.', would_save: pi };
  }

  // For CREATE, pre-probe the server for shortName collisions. UPDATE keeps
  // its existing shortName (the same row), so skip when indicatorId is set.
  if (!indicatorId) {
    await disambiguateShortNamesAgainstServer([pi], 'programIndicators', 'programIndicators');

    // NAME is also globally unique on programIndicators. A collision (e.g. the
    // same indicator set created earlier for another program on a shared
    // server) fails the whole POST with "Property `name` … already exists" —
    // auto-suffix with the program's short name (then a UID shard), same
    // convention as stage-name disambiguation. Observed live on play 2.40.12
    // (2026-07-07) re-running the MCH scenario.
    const nameProbe = await safeDhis2Fetch(`programIndicators?filter=name:eq:${encodeURIComponent(pi.name)}&fields=id&pageSize=1`);
    if (nameProbe?.programIndicators?.length) {
      const progMeta = await safeDhis2Fetch(`programs/${programId}?fields=shortName,name`);
      const suffix = String(progMeta?.shortName || progMeta?.name || '').trim();
      let candidate = suffix ? `${indicator.name} - ${suffix}`.substring(0, 230) : '';
      if (candidate) {
        const probe2 = await safeDhis2Fetch(`programIndicators?filter=name:eq:${encodeURIComponent(candidate)}&fields=id&pageSize=1`);
        if (probe2?.programIndicators?.length) candidate = '';
      }
      if (!candidate) candidate = `${indicator.name} ${generateDhis2Uid().slice(-4)}`.substring(0, 230);
      pi._renamedFrom = indicator.name;
      pi.name = candidate;
    }
  }

  const renamedFrom = pi._renamedFrom;
  delete pi._renamedFrom;
  const result = await postMetadataPayload({ programIndicators: [pi] }, false);
  const out = {
    ...result,
    summary: {
      indicator: { id: uid, name: pi.name },
      ...(renamedFrom ? { name_auto_disambiguated: { from: renamedFrom, to: pi.name, reason: 'a program indicator with the requested name already exists (names are globally unique)' } } : {}),
    },
  };
  // Mirror the top-level *_id convention every other write tool already exposes
  // (manage_indicators → indicator_id, manage_dashboards → visualization_id /
  // dashboard_id, manage_org_units → org_unit_id, manage_datasets → dataset_id)
  // so a multi-step caller can chain this program indicator's UID STRAIGHT into
  // the next tool — e.g. a dashboard visualization's data_items, where it is
  // auto-resolved as PROGRAM_INDICATOR — without having to dig into the nested
  // summary object. Purely additive: summary.indicator.id is preserved for any
  // existing reader. Only surfaced on a successful import so a failed create can
  // never yield a chainable-but-nonexistent UID.
  if (result && result.success) out.program_indicator_id = uid;
  return out;
}

async function createStandaloneOptionSet(args) {
  if (!args.option_set_name) return { _error: 'Missing option_set_name' };
  if (!args.options?.length) return { _error: 'Missing options array' };

  const { optionSet, options } = buildOptionSetAndOptions({
    name: args.option_set_name,
    options: args.options,
  });

  const payload = { options, optionSets: [optionSet] };
  const result = await postMetadataPayload(payload, args.dry_run_only);

  return {
    ...result,
    summary: {
      optionSet: { id: optionSet.id, name: optionSet.name },
      options: options.map(o => ({ id: o.id, name: o.name, code: o.code })),
    },
  };
}

// Resolve an EXISTING option set for a data element that references one by UID
// or exact name (as opposed to bundling a brand-new inline option_set). Returns
// { id, valueType, name } on success or { _error } if it cannot be resolved — so
// a DE never silently points at a non-existent set (which would fail the import
// with an opaque message). Purely additive: DEs that pass only an inline
// option_set (or none) never reach this path. This is what lets the
// manage_option_sets(create) → create_data_elements chain compose — the DE step
// can attach the just-created set by option_set_id instead of duplicating it.
async function resolveExistingOptionSetRef(optionSetId, optionSetName) {
  if (optionSetId) {
    const id = String(optionSetId).trim();
    const resp = await safeDhis2Fetch(`optionSets/${id}?fields=id,name,valueType`);
    if (resp?._error || resp?._status === 404 || !resp?.id) {
      return {
        _error: `option_set_id "${id}" does not exist on this server.`,
        _hint: 'Chain the option_set_id returned by manage_option_sets(action="create"), or pass an inline option_set:{name,options:[...]} to create a new one.',
      };
    }
    return { id: resp.id, valueType: resp.valueType || 'TEXT', name: resp.name || id };
  }
  const nm = String(optionSetName || '').trim();
  if (!nm) return { _error: 'option_set reference is empty (no option_set_id or option_set_name).' };
  const probe = await safeDhis2Fetch(`optionSets?filter=name:eq:${encodeURIComponent(nm)}&fields=id,name,valueType&pageSize=2`);
  const hits = probe?.optionSets || [];
  if (!hits.length) return {
    _error: `option_set_name "${nm}" not found on this server.`,
    _hint: 'Create it first with manage_option_sets(action="create") and chain the returned option_set_id, or pass an inline option_set:{name,options:[...]}.',
  };
  if (hits.length > 1) return { _error: `option_set_name "${nm}" is ambiguous (${hits.length} matches). Pass option_set_id instead.` };
  return { id: hits[0].id, valueType: hits[0].valueType || 'TEXT', name: hits[0].name || nm };
}

async function createStandaloneDataElements(args, defaultCatComboId) {
  if (!args.data_elements?.length) return { _error: 'Missing data_elements array' };

  const allOptions = [];
  const allOptionSets = [];
  const allDataElements = [];
  const optionSetUidMap = {};
  const seenDEShortNames = new Set();

  // Batch defaults — applied to every DE that doesn't override.
  const batchDomain = args.domain_type || args.domainType || null;
  const batchAgg = args.aggregation_type || args.aggregationType || null;

  // ── Inline category combo support ─────────────────────────────────────
  // The chatbot's most common disaggregation request is "create a categoryCombo
  // and attach these data elements to it" (HTS-by-Sex, OPV-by-Dose, etc.).
  // Without first-class support, the model splits this into raw /metadata POSTs
  // and trips on dependency ordering or missing dataDimensionType. This branch
  // bundles the entire payload (options + categories + combo + DEs) into ONE
  // atomic POST, then triggers CoC regen so the DEs are immediately enterable.
  let comboBundle = null;
  let comboPayload = {};
  let inlineComboUid = null;
  let resolvedComboName = null;
  if (args.category_combo && typeof args.category_combo === 'object') {
    comboBundle = await buildCategoryComboBundle(args.category_combo);
    if (comboBundle?._error) return { _error: `category_combo build failed: ${comboBundle._error}` };
    inlineComboUid = comboBundle.uid;
    resolvedComboName = comboBundle.name;
    comboPayload = comboBundle.payload || {};
  }

  // OR: model passed a pre-existing combo by id/name.
  let existingComboId = args.category_combo_id || args.categoryComboId || null;
  if (!existingComboId && args.category_combo_name && !comboBundle) {
    const probe = await safeDhis2Fetch(
      `categoryCombos?filter=name:eq:${encodeURIComponent(args.category_combo_name)}&fields=id,name&pageSize=1`
    );
    const hit = probe?.categoryCombos?.[0];
    if (hit?.id) existingComboId = hit.id;
    else return {
      _error: `category_combo_name "${args.category_combo_name}" not found on this server. Pass category_combo_id, an inline category_combo:{...} definition, or omit to use default.`,
    };
  }

  // The cc UID applied to DEs that opt into the combo. Order: per-DE override
  // > inline-bundle UID > looked-up existing UID > batch default > system default.
  const batchComboId = inlineComboUid || existingComboId || null;

  for (const de of args.data_elements) {
    const hasInlineOptionSet = !!(de.option_set && de.option_set.name && de.option_set.options?.length);
    const refIdRaw = de.option_set_id || de.optionSetId || null;
    const refNameRaw = de.option_set_name || de.optionSetName || null;
    // Reference an EXISTING option set by UID/name (the chaining path). Mutually
    // exclusive with an inline option_set so intent is never ambiguous.
    if ((refIdRaw || refNameRaw) && hasInlineOptionSet) {
      return {
        _error: `Data element "${de.name || '(unnamed)'}" specifies BOTH an inline option_set and an existing option_set_id/option_set_name.`,
        _hint: 'Use inline option_set:{name,options} to CREATE a new set, OR option_set_id/option_set_name to REFERENCE an existing one — not both.',
      };
    }
    if (refIdRaw || refNameRaw) {
      const ref = await resolveExistingOptionSetRef(refIdRaw, refNameRaw);
      if (ref._error) return ref;
      de._optionSetRef = { id: ref.id, valueType: ref.valueType };
    }
    // Inline option set bundling (existing behavior — preserved verbatim).
    if (hasInlineOptionSet) {
      if (!optionSetUidMap[de.option_set.name]) {
        const { optionSet, options, osUid } = buildOptionSetAndOptions(de.option_set, de.value_type);
        allOptions.push(...options);
        allOptionSets.push(optionSet);
        optionSetUidMap[de.option_set.name] = osUid;
      }
    }
    // Resolve effective categoryCombo for this DE.
    //   • per-DE category_combo_id wins
    //   • use_category_combo:true binds to the inline combo / batch combo
    //   • use_default_combo:true forces the system default (overrides batch combo)
    //   • otherwise falls through to the batch / system default
    let perDeCcId = de.category_combo_id || de.categoryComboId || null;
    if (!perDeCcId && de.use_category_combo === true && batchComboId) {
      perDeCcId = batchComboId;
    }
    if (de.use_default_combo === true) {
      perDeCcId = defaultCatComboId;
    }
    const opts = {
      domainType: de.domain_type || batchDomain || undefined,
      aggregationType: de.aggregation_type || batchAgg || undefined,
      categoryComboId: perDeCcId || batchComboId || undefined,
    };
    const { elem } = buildDataElement(de, defaultCatComboId, optionSetUidMap, seenDEShortNames, opts);
    allDataElements.push(elem);
  }

  // Pre-probe the server for shortName collisions on these new DEs.
  await disambiguateShortNamesAgainstServer(allDataElements, 'dataElements', 'dataElements');

  const payload = {
    ...comboPayload, // categoryOptions / categories / categoryCombos (if inline)
  };
  if (allOptions.length) payload.options = allOptions;
  if (allOptionSets.length) payload.optionSets = allOptionSets;
  payload.dataElements = allDataElements;

  const result = await postMetadataPayload(payload, args.dry_run_only);

  // If we bundled a brand-new categoryCombo, trigger CoC regeneration so the
  // DEs are immediately enterable in any dataset/form. Without this the form
  // renders no disaggregation columns.
  let cocUpdate = null;
  if (result?.success && !args.dry_run_only && inlineComboUid && comboBundle?.payload?.categoryCombos?.length) {
    const t = await triggerCategoryOptionComboUpdate();
    cocUpdate = t.ok ? { ok: true, note: 'CategoryOptionCombos regenerated.' } : { ok: false, error: t.error };
  }

  // Optional sharing application via legacy /api/sharing on the new combo + DEs.
  let sharingResult = null;
  if (result?.success && !args.dry_run_only && args.sharing) {
    const items = [];
    if (inlineComboUid) items.push({ type: 'categoryCombo', id: inlineComboUid });
    for (const cat of (comboBundle?.payload?.categories || [])) items.push({ type: 'category', id: cat.id });
    for (const opt of (comboBundle?.payload?.categoryOptions || [])) items.push({ type: 'categoryOption', id: opt.id });
    for (const de of allDataElements) items.push({ type: 'dataElement', id: de.id });
    if (items.length) sharingResult = await applySharingViaLegacyEndpoint(items, args.sharing);
  }

  return {
    ...result,
    summary: {
      dataElements: allDataElements.map(de => ({
        id: de.id,
        name: de.name,
        valueType: de.valueType,
        domainType: de.domainType,
        aggregationType: de.aggregationType,
        categoryComboId: de.categoryCombo?.id,
        optionSetId: de.optionSet?.id || null,
      })),
      optionSets: Object.entries(optionSetUidMap).map(([name, id]) => ({ name, id })),
      categoryCombo: inlineComboUid
        ? { id: inlineComboUid, name: resolvedComboName, ...(comboBundle?.summary || {}) }
        : (existingComboId ? { id: existingComboId, reused: true } : null),
      cocUpdate,
      sharing: sharingResult,
    },
  };
}

// Standalone categoryCombo (with optional inline categories/options). Atomic
// /metadata POST + maintenance/CoC regen + optional legacy sharing application.
async function createStandaloneCategoryCombo(args) {
  const combo = args.category_combo || args;
  if (!combo?.name) {
    return {
      _error: 'category_combo.name (or top-level name) is required',
      _hint: 'Call shape: create_metadata(action="create_category_combo", category_combo:{name, categories:[{name, options:[...]} | {id}]}, sharing?)',
    };
  }
  if (!combo.categories || !combo.categories.length) {
    return {
      _error: 'category_combo.categories[] required',
      _hint: 'Each item is { id } to reuse an existing category, or { name, options:[...] } to create a new one. Existing options/categories are auto-detected by exact name and reused.',
    };
  }

  const bundle = await buildCategoryComboBundle(combo);
  if (bundle?._error) return { _error: bundle._error };

  const result = await postMetadataPayload(bundle.payload, args.dry_run_only);

  let cocUpdate = null;
  if (result?.success && !args.dry_run_only) {
    const t = await triggerCategoryOptionComboUpdate();
    cocUpdate = t.ok ? { ok: true, note: 'CategoryOptionCombos regenerated.' } : { ok: false, error: t.error };
  }

  // Optional sharing via legacy endpoint (works for metadata-only-shareable
  // categoryCombo / category / categoryOption).
  let sharingResult = null;
  if (result?.success && !args.dry_run_only && args.sharing) {
    const items = [{ type: 'categoryCombo', id: bundle.uid }];
    for (const cat of (bundle.payload?.categories || [])) items.push({ type: 'category', id: cat.id });
    for (const opt of (bundle.payload?.categoryOptions || [])) items.push({ type: 'categoryOption', id: opt.id });
    sharingResult = await applySharingViaLegacyEndpoint(items, args.sharing);
  }

  return {
    ...result,
    summary: {
      categoryCombo: { id: bundle.uid, name: bundle.name },
      ...bundle.summary,
      cocUpdate,
      sharing: sharingResult,
    },
    _next_steps: [
      'Use create_metadata(action="create_data_elements", category_combo_id="' + bundle.uid + '", domain_type="AGGREGATE", data_elements:[...]) to attach data elements to this combo.',
      'Or pass category_combo_id="' + bundle.uid + '" to manage_datasets(action="create" or "add_data_elements") for dataset-level attribute disaggregation.',
    ],
  };
}

// ── Meta-Architect Agent Engine ──────────────────────────────────────────────

async function executeArchitectMetadata(args) {
  const action = args.action;
  if (!action) return { _error: 'Missing required parameter: action' };

  try {
    switch (action) {

      // ── lookup_schema: introspect DHIS2 API schema for any metadata type ──
      case 'lookup_schema': {
        const schemaType = args.schema_type;
        if (!schemaType) return { _error: 'Missing schema_type for lookup_schema action.' };

        const schema = await safeDhis2Fetch(`schemas/${schemaType}.json?fields=name,plural,klass,properties[name,fieldName,propertyType,itemPropertyType,required,writable,constants,persisted,owner,description]`);
        if (!schema || schema._error) {
          return { _error: `Failed to fetch schema for "${schemaType}": ${schema?._error || 'unknown error'}` };
        }

        // Extract the most useful info: required writable fields, optional writable fields, value type enums
        const props = schema.properties || [];
        const requiredFields = props.filter(p => p.required && p.writable).map(p => ({
          name: p.name || p.fieldName,
          type: p.propertyType,
          itemType: p.itemPropertyType || undefined,
          description: p.description || undefined,
        }));
        const optionalWritable = props.filter(p => !p.required && p.writable && p.persisted).map(p => ({
          name: p.name || p.fieldName,
          type: p.propertyType,
          itemType: p.itemPropertyType || undefined,
          constants: p.constants?.length ? p.constants : undefined,
        }));

        return {
          schema_type: schemaType,
          plural: schema.plural || schemaType + 's',
          required_fields: requiredFields,
          optional_writable_fields: optionalWritable.slice(0, 40), // limit to keep response manageable
          total_properties: props.length,
          hint: 'Use required_fields to understand what must be supplied when creating this object type. constants arrays show allowed enum values (e.g. valueType constants for dataElement).',
        };
      }

      // ── check_existing: search for existing metadata to avoid duplicates ──
      case 'check_existing': {
        const objectType = args.object_type;
        const nameFilter = args.name_filter;
        if (!objectType) return { _error: 'Missing object_type for check_existing action.' };
        if (!nameFilter) return { _error: 'Missing name_filter for check_existing action.' };

        const encodedFilter = encodeURIComponent(nameFilter);
        const resp = await safeDhis2Fetch(
          `${objectType}?filter=name:ilike:${encodedFilter}&fields=id,name,shortName,created,lastUpdated&pageSize=25`
        );
        if (!resp || resp._error) {
          return { _error: `Failed to search ${objectType}: ${resp?._error || 'unknown error'}` };
        }

        const items = resp[objectType] || [];
        return {
          object_type: objectType,
          search_term: nameFilter,
          found: items.length,
          items: items,
          hint: items.length > 0
            ? `Found ${items.length} existing ${objectType} matching "${nameFilter}". Reuse existing IDs to avoid duplicates.`
            : `No existing ${objectType} found matching "${nameFilter}". Safe to create new.`,
        };
      }

      // ── verify: confirm created objects exist and are correctly configured ──
      case 'verify': {
        const results = [];

        // Verify individual objects by ID
        if (args.verify_ids?.length) {
          for (const item of args.verify_ids) {
            try {
              const obj = await safeDhis2Fetch(`${item.type}/${item.id}?fields=id,name,displayName,created`);
              const exists = !!(obj && obj.id);
              const nameMatch = item.expected_name ? (obj?.name === item.expected_name || obj?.displayName === item.expected_name) : null;
              results.push({
                type: item.type,
                id: item.id,
                exists,
                name: obj?.name || obj?.displayName || null,
                name_matches: nameMatch,
                status: exists ? (nameMatch === false ? '⚠️ EXISTS but name mismatch' : '✅ VERIFIED') : '❌ NOT FOUND',
              });
            } catch (e) {
              results.push({ type: item.type, id: item.id, exists: false, status: '❌ ERROR', error: e.message });
            }
          }
        }

        // Deep verify a full program structure
        if (args.verify_program_id) {
          try {
            // NOTE: rules + rule variables are fetched via the programRules /
            // programRuleVariables endpoints with a program filter, NOT as
            // program fields — `programs/{id}?fields=programRules[...]` returns
            // an EMPTY collection on DHIS2 2.40 even when rules exist (verified
            // live on play 2.40.12, 2026-07-07), which silently made this
            // verify skip every rule check.
            const [prog, rulesResp, prvsResp] = await Promise.all([
              safeDhis2Fetch(
                `programs/${args.verify_program_id}?fields=id,name,programType,programStages[id,name,sortOrder,programStageDataElements[dataElement[id,name,valueType,optionSet[id,name]]]],trackedEntityType[id,name],organisationUnits[id,name]`
              ),
              safeDhis2Fetch(
                `programRules?filter=program.id:eq:${args.verify_program_id}&fields=id,name,condition,programRuleActions[id,programRuleActionType,content,data,dataElement[id,name],programStage[id]]&paging=false`
              ),
              safeDhis2Fetch(
                `programRuleVariables?filter=program.id:eq:${args.verify_program_id}&fields=id,name,programRuleVariableSourceType,useCodeForOptionSet,dataElement[id],trackedEntityAttribute[id]&paging=false`
              ),
            ]);
            if (!prog || prog._error) {
              results.push({ program_verify: args.verify_program_id, status: '❌ NOT FOUND', error: prog?._error });
            } else {
              const stages = prog.programStages || [];
              const rules = rulesResp?.programRules || [];
              const prvs = prvsResp?.programRuleVariables || [];
              const ous = prog.organisationUnits || [];

              // Rule-quality advisories the pure existence checks can't see.
              // (a) An option-set-backed PRV with useCodeForOptionSet=false that a
              //     condition compares to a quoted literal → the variable yields the
              //     option NAME while conditions conventionally use CODES, so the
              //     rule silently never fires (exact MCH failure, play 2.40.12).
              // (b) HIDEPROGRAMSTAGE reminder — in the new Capture web app it only
              //     blocks adding events; the stage card stays visible.
              const ruleAdvisories = [];
              {
                const optionSetDeIds = new Set();
                for (const s of stages) {
                  for (const psde of (s.programStageDataElements || [])) {
                    if (psde.dataElement?.optionSet) optionSetDeIds.add(psde.dataElement.id);
                  }
                }
                for (const v of prvs) {
                  const bound = v.dataElement?.id;
                  if (!bound || !optionSetDeIds.has(bound) || v.useCodeForOptionSet === true) continue;
                  for (const r of rules) {
                    const esc = String(v.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    if (new RegExp(`#\\{${esc}\\}\\s*(==|!=)\\s*'[^']+'`).test(r.condition || '')) {
                      ruleAdvisories.push(`Rule "${r.name}" compares #{${v.name}} to a quoted literal, but that variable has useCodeForOptionSet=false (it yields the option NAME, not the CODE) — if the literal is an option code the rule NEVER fires. Fix: set useCodeForOptionSet=true on the variable via manage_program_rules, or compare against the option name.`);
                    }
                  }
                }
                if (rules.some(r => (r.programRuleActions || []).some(a => a.programRuleActionType === 'HIDEPROGRAMSTAGE'))) {
                  ruleAdvisories.push('This program uses HIDEPROGRAMSTAGE: in the NEW Capture web app that only disables adding events to the stage (the stage card stays visible on the enrollment dashboard); the legacy Tracker Capture / Android apps hide the stage entirely. Expected behavior — mention it to the user.');
                }
              }

              results.push({
                program_verify: args.verify_program_id,
                status: '✅ PROGRAM VERIFIED',
                name: prog.name,
                programType: prog.programType,
                trackedEntityType: prog.trackedEntityType ? { id: prog.trackedEntityType.id, name: prog.trackedEntityType.name } : null,
                organisationUnits: ous.length,
                stages: stages.map(s => ({
                  id: s.id,
                  name: s.name,
                  sortOrder: s.sortOrder,
                  dataElements: (s.programStageDataElements || []).map(psde => ({
                    id: psde.dataElement?.id,
                    name: psde.dataElement?.name,
                    valueType: psde.dataElement?.valueType,
                    hasOptionSet: !!psde.dataElement?.optionSet,
                  })),
                })),
                programRuleVariables: prvs.map(v => ({ id: v.id, name: v.name, sourceType: v.programRuleVariableSourceType })),
                programRules: rules.map(r => ({
                  id: r.id,
                  name: r.name,
                  condition: r.condition,
                  actions: (r.programRuleActions || []).map(a => ({
                    type: a.programRuleActionType,
                    content: a.content || null,
                    data: a.data || null,
                    dataElement: a.dataElement ? { id: a.dataElement.id, name: a.dataElement.name } : null,
                  })),
                })),
                integrity_checks: {
                  has_tracked_entity_type: !!prog.trackedEntityType,
                  has_org_units: ous.length > 0,
                  all_stages_have_data_elements: stages.every(s => (s.programStageDataElements || []).length > 0),
                  rule_count: rules.length,
                  prv_count: prvs.length,
                  rule_quality_ok: ruleAdvisories.length === 0,
                },
                ...(ruleAdvisories.length ? { rule_advisories: ruleAdvisories } : {}),
              });
            }
          } catch (e) {
            results.push({ program_verify: args.verify_program_id, status: '❌ ERROR', error: e.message });
          }
        }

        if (results.length === 0) {
          return { _error: 'Provide verify_ids array and/or verify_program_id to verify.' };
        }
        return { verification_results: results };
      }

      // ── browse_dhis2_docs: search official DHIS2 docs via Tavily ──
      case 'browse_dhis2_docs': {
        const query = args.docs_query;
        if (!query) return { _error: 'Missing docs_query for browse_dhis2_docs action.' };

        try {
          const stored = await chrome.storage.local.get(['tavilyApiKey']);
          const tavilyKey = stored.tavilyApiKey;
          if (!tavilyKey) {
            return { _error: 'No Tavily API key configured. Open settings to add your Tavily API key. Alternatively, use browse_web tool directly.' };
          }

          const resp = await fetch(TAVILY_SEARCH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: tavilyKey,
              query: `DHIS2 ${query}`,
              search_depth: 'advanced',
              include_domains: ['docs.dhis2.org', 'community.dhis2.org', 'developers.dhis2.org'],
              max_results: 5,
              include_answer: true,
            }),
          });
          const data = await resp.json();
          return {
            answer: data.answer || null,
            results: (data.results || []).map(r => ({
              title: r.title,
              url: r.url,
              snippet: r.content?.substring(0, 500),
            })),
            hint: 'Use these docs to understand DHIS2 metadata structures, API payloads, program rules syntax, etc.',
          };
        } catch (e) {
          return { _error: `Docs search failed: ${e.message}. You can also try the browse_web tool directly.` };
        }
      }

      // ── inspect_program: deep inspection of an existing program ──
      case 'inspect_program': {
        const pid = args.program_id;
        if (!pid) return { _error: 'Missing program_id for inspect_program action.' };

        const prog = await safeDhis2Fetch(
          `programs/${pid}?fields=id,name,displayName,shortName,programType,enrollmentDateLabel,incidentDateLabel,` +
          `trackedEntityType[id,name],` +
          `organisationUnits[id,name],` +
          `programTrackedEntityAttributes[trackedEntityAttribute[id,name,valueType,optionSet[id,name,options[id,name,code]]],mandatory,searchable,displayInList],` +
          `programStages[id,name,displayName,sortOrder,repeatable,` +
            `programStageDataElements[compulsory,dataElement[id,name,valueType,optionSet[id,name,options[id,name,code]]]]],` +
          `programRuleVariables[id,name,programRuleVariableSourceType,dataElement[id,name],trackedEntityAttribute[id,name],programStage[id,name]],` +
          `programRules[id,name,description,condition,priority,` +
            `programRuleActions[id,programRuleActionType,content,data,location,` +
              `dataElement[id,name],trackedEntityAttribute[id,name],programStage[id,name],` +
              `programStageSection[id,name],option[id,name],optionGroup[id,name]]],` +
          `programIndicators[id,name,expression,filter,analyticsType]`
        );

        if (!prog || prog._error) {
          return { _error: `Failed to fetch program "${pid}": ${prog?._error || 'not found'}` };
        }

        const ctxStageId = dhis2.pageContext?.stageId || null;
        return {
          _currentStageId: ctxStageId,
          _currentStageName: ctxStageId ? (prog.programStages || []).find(s => s.id === ctxStageId)?.name || null : null,
          program: {
            id: prog.id,
            name: prog.name,
            shortName: prog.shortName,
            programType: prog.programType,
            enrollmentDateLabel: prog.enrollmentDateLabel,
            incidentDateLabel: prog.incidentDateLabel,
            trackedEntityType: prog.trackedEntityType || null,
            organisationUnits: (prog.organisationUnits || []).length,
            orgUnitSample: (prog.organisationUnits || []).slice(0, 5).map(o => ({ id: o.id, name: o.name })),
          },
          trackedEntityAttributes: (prog.programTrackedEntityAttributes || []).map(ptea => ({
            id: ptea.trackedEntityAttribute?.id,
            name: ptea.trackedEntityAttribute?.name,
            valueType: ptea.trackedEntityAttribute?.valueType,
            mandatory: ptea.mandatory,
            searchable: ptea.searchable,
            displayInList: ptea.displayInList,
            hasOptionSet: !!ptea.trackedEntityAttribute?.optionSet,
            optionSetName: ptea.trackedEntityAttribute?.optionSet?.name || null,
          })),
          stages: (prog.programStages || []).map(s => ({
            id: s.id,
            name: s.name,
            sortOrder: s.sortOrder,
            repeatable: s.repeatable,
            dataElements: (s.programStageDataElements || []).map(psde => ({
              id: psde.dataElement?.id,
              name: psde.dataElement?.name,
              valueType: psde.dataElement?.valueType,
              compulsory: psde.compulsory,
              hasOptionSet: !!psde.dataElement?.optionSet,
              optionSetName: psde.dataElement?.optionSet?.name || null,
              options: psde.dataElement?.optionSet?.options?.map(o => ({ name: o.name, code: o.code })) || [],
            })),
          })),
          programRuleVariables: (prog.programRuleVariables || []).map(v => ({
            id: v.id,
            name: v.name,
            sourceType: v.programRuleVariableSourceType,
            dataElement: v.dataElement ? { id: v.dataElement.id, name: v.dataElement.name } : null,
            attribute: v.trackedEntityAttribute ? { id: v.trackedEntityAttribute.id, name: v.trackedEntityAttribute.name } : null,
            stage: v.programStage ? { id: v.programStage.id, name: v.programStage.name } : null,
          })),
          programRules: (prog.programRules || []).map(r => ({
            id: r.id,
            name: r.name,
            description: r.description,
            condition: r.condition,
            priority: r.priority,
            actions: (r.programRuleActions || []).map(a => ({
              type: a.programRuleActionType,
              content: a.content,
              data: a.data,
              location: a.location,
              dataElement: a.dataElement ? `${a.dataElement.name} (${a.dataElement.id})` : null,
              attribute: a.trackedEntityAttribute ? `${a.trackedEntityAttribute.name} (${a.trackedEntityAttribute.id})` : null,
              stage: a.programStage ? `${a.programStage.name} (${a.programStage.id})` : null,
            })),
          })),
          programIndicators: (prog.programIndicators || []).map(pi => ({
            id: pi.id, name: pi.name, expression: pi.expression, filter: pi.filter,
          })),
          hint: 'Use this detailed structure to understand what exists before making modifications. Cross-reference stage DEs and PRVs when adding rules.',
        };
      }

      default:
        return { _error: `Unknown architect_metadata action: "${action}". Valid actions: lookup_schema, check_existing, verify, browse_dhis2_docs, inspect_program.` };
    }
  } catch (err) {
    return { _error: `architect_metadata(${action}) failed: ${err.message}` };
  }
}
