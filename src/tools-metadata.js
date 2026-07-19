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
    // Previously inspect-mode runs deleted 84 program rule variables + 10 rules in a
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
    // Target program: an explicit program_id / program_name overrides the page
    // context so this tool works from ANY page (e.g. the Dashboard app, which
    // has no program in context) instead of dead-ending on "No program in
    // context" even when the model already knows the program UID (2026-07-13).
    let effProgramId = programId;
    let effProgramName = dhis2.programMetadata?.displayName || null;
    if (args.program_id || args.program_name) {
      const resolved = await resolveProgramForRecentChanges(args, programId);
      if (resolved?._error) return resolved;
      effProgramId = resolved.id;
      effProgramName = resolved.displayName || effProgramName;
    }
    if (!effProgramId) {
      return { _error: 'No program in context. Pass program_id or program_name to target a specific program.' };
    }
    // Stage-name guards below validate against dhis2.programMetadata, which is
    // loaded for the PAGE program only — skip them when targeting another one.
    const usingContextProgram = effProgramId === programId;

    if (args.info_type === 'rules' || args.info_type === 'rules_for_stage') {
      let fields = 'id,displayName,description,condition';
      if (args.include_actions) {
        fields += ',programRuleActions[id,programRuleActionType,content,data,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]]';
      }
      let filter = `filter=program.id:eq:${effProgramId}`;
      if (args.info_type === 'rules_for_stage' && args.target_id) {
        // Get rules that reference this stage (via programStage field or via actions)
        filter += `&filter=programStage.id:eq:${args.target_id}`;
      }
      const result = await safeDhis2Fetch(`programRules?${filter}&fields=${fields}&paging=false`);
      if (result._error) return result;
      const rules = result.programRules || [];
      return {
        total_rules: rules.length,
        program: { id: effProgramId, name: effProgramName },
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
        `programIndicators?filter=program.id:eq:${effProgramId}&fields=id,displayName,description,expression,filter,displayInForm&paging=false`
      );
      if (result._error) return result;
      return {
        total_indicators: result.programIndicators?.length || 0,
        program: { id: effProgramId, name: effProgramName },
        indicators: result.programIndicators?.map(pi => ({
          id: pi.id, name: pi.displayName, description: pi.description,
          expression: pi.expression, filter: pi.filter
        })),
      };
    }

    if (args.info_type === 'stage_details') {
      if (args.target_id) {
        // Guard: reject the PROGRAM ID used as a stage ID. Only meaningful for
        // the page-context program (whose metadata + stage-in-context we know).
        if (usingContextProgram && args.target_id === effProgramId) {
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
        // Guard: validate target_id is a known stage in this program (only when
        // operating on the page-context program — dhis2.programMetadata holds
        // ITS stages, not those of a program targeted via program_id).
        const knownStages = usingContextProgram ? dhis2.programMetadata?.programStages : null;
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
        // Ground the stage id against the target program BEFORE fetching:
        // stale/hallucinated stage ids from long conversations otherwise
        // produce a raw 404 (observed live 2026-07-19). The membership probe
        // always succeeds and its result doubles as the correction hint.
        const memberProbe = await safeDhis2Fetch(
          `programStages?filter=program.id:eq:${effProgramId}&fields=id,displayName&paging=false`
        );
        const members = memberProbe?.programStages || [];
        if (!memberProbe?._error && members.length && !members.some(st => st.id === args.target_id)) {
          return {
            _error: `"${args.target_id}" is not a stage of program ${effProgramId}.`,
            _hint: `Use one of this program's real stage ids: ${members.map(st => `${st.displayName} (${st.id})`).join(', ')}.`,
            valid_stages: members,
          };
        }
        const result = await safeDhis2Fetch(
          `programStages/${args.target_id}?fields=id,displayName,description,executionDateLabel,formType,sortOrder,programStageSections[id,displayName,sortOrder,dataElements[id]],programStageDataElements[compulsory,displayInReports,dataElement[id,displayName,displayFormName,valueType,description,optionSetValue,optionSet[id,displayName,options[id,displayName,code]]]]`
        );
        return result;
      }
      // No target_id: list all stages for this program
      const result = await safeDhis2Fetch(
        `programStages?filter=program.id:eq:${effProgramId}&fields=id,displayName,description,sortOrder,repeatable,formType,programStageSections[id,displayName]&paging=false&order=sortOrder:asc`
      );
      if (result._error) return result;
      return {
        program: { id: effProgramId, name: effProgramName },
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
        router: LINE_LISTING_ROUTER_PATH,
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
    // Group unresolved items by type for efficient batch fetching
    const unresolvedIndicators = dataItems.filter(d => d.type === 'INDICATOR' && !d.name).map(d => d.id);
    const unresolvedDataElements = dataItems.filter(d => d.type === 'DATA_ELEMENT' && !d.name).map(d => d.id);
    const unresolvedProgramIndicators = dataItems.filter(d => d.type === 'PROGRAM_INDICATOR' && !d.name).map(d => d.id);
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

  // ── manage_line_lists ──
  if (name === 'manage_line_lists') {
    return await executeManageLineLists(args);
  }

  // ── manage_backups ──
  if (name === 'manage_backups') {
    return await executeManageBackups(args);
  }

  return { _error: `Unhandled tool route: ${name}` };
}

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

  // Heal common reference mistakes BEFORE validation (all advisory-reported):
  //   • #{<uid>} where the uid is a PROGRAM INDICATOR → I{<uid>} (aggregate
  //     indicator grammar references PIs with I{}, not #{});
  //   • I{<name>} / #{<name>} where a NAME was passed instead of a UID →
  //     resolved against programIndicators / indicators / aggregate DEs by
  //     exact name (unique match only).
  // Observed live 2026-07-19: a weak model burned 4 validation failures and a
  // circuit-breaker disable on exactly these shapes.
  const expressionRewrites = [];
  {
    const healExpr = async (label, expr) => {
      let out = String(expr);
      const uidTokens = [...out.matchAll(/#\{([A-Za-z][A-Za-z0-9]{10})\}/g)].map(m => m[1]);
      if (uidTokens.length) {
        const piResp = await safeDhis2Fetch(`programIndicators?filter=id:in:[${[...new Set(uidTokens)].join(',')}]&fields=id&paging=false`);
        for (const pi of (piResp?.programIndicators || [])) {
          out = out.split(`#{${pi.id}}`).join(`I{${pi.id}}`);
          expressionRewrites.push({ where: label, from: `#{${pi.id}}`, to: `I{${pi.id}}`, reason: 'program indicators are referenced with I{} in indicator expressions' });
        }
      }
      const nameTokens = [...out.matchAll(/(I|#)\{([^}]+)\}/g)]
        .filter(m => !/^[A-Za-z][A-Za-z0-9]{10}$/.test(m[2]) && !/^[A-Za-z][A-Za-z0-9]{10}\.[A-Za-z][A-Za-z0-9]{10}$/.test(m[2]));
      for (const m of nameTokens) {
        const raw = m[2].trim();
        const [piR, indR, deR] = await Promise.all([
          safeDhis2Fetch(`programIndicators?filter=name:eq:${encodeURIComponent(raw)}&fields=id&pageSize=2`),
          safeDhis2Fetch(`indicators?filter=name:eq:${encodeURIComponent(raw)}&fields=id&pageSize=2`),
          safeDhis2Fetch(`dataElements?filter=name:eq:${encodeURIComponent(raw)}&filter=domainType:eq:AGGREGATE&fields=id&pageSize=2`),
        ]);
        const pi = (piR?.programIndicators || []); const indL = (indR?.indicators || []); const de = (deR?.dataElements || []);
        let to = null;
        if (pi.length === 1) to = `I{${pi[0].id}}`;
        else if (indL.length === 1) to = `N{${indL[0].id}}`;
        else if (de.length === 1) to = `#{${de[0].id}}`;
        if (to) {
          out = out.split(m[0]).join(to);
          expressionRewrites.push({ where: label, from: m[0], to, reason: 'resolved object name to its UID reference' });
        }
      }
      return out;
    };
    ind.numerator = await healExpr('numerator', ind.numerator);
    ind.denominator = await healExpr('denominator', ind.denominator);
  }

  // Server-validate BOTH expressions before building the payload — a broken
  // reference is caught here with the parser's exact error, not silently saved.
  const numChk = await describeValidationExpression(ind.numerator);
  if (!numChk.ok) return { _error: `numerator rejected by DHIS2: ${numChk.error}`, _hint: `Reference grammar for AGGREGATE indicators: program indicator = I{<piUid>}, other indicator = N{<indicatorUid>}, aggregate data element = #{<deUid>} (optionally #{de.coc}), reporting rate = R{dsUid.REPORTING_RATE}, constant = C{uid}. Program-rule/PI functions (d2:*) and V{} variables are NOT valid here. The numerator after auto-healing was: ${ind.numerator}. Confirm each UID exists (search_metadata) and retry.`, ...(expressionRewrites.length ? { expression_rewrites: expressionRewrites } : {}) };
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
    ...(expressionRewrites.length ? { expression_rewrites: expressionRewrites } : {}),
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

  // Never-recreate: a same-name legend set is REUSED, not 409'd. Weak models
  // routinely re-issue a create for a set they already made earlier in the
  // turn (observed live 2026-07-19) — the duplicate 409 then burned a failed
  // API call and a retry loop. Returning the existing set is always safe: the
  // caller wanted a set with this name to exist, and its actual bands are
  // included so the model can add/adjust if they differ.
  {
    const probe = await safeDhis2Fetch(`legendSets?filter=name:eq:${encodeURIComponent(String(ls.name).trim())}&fields=id,name,legends[id,name,startValue,endValue,color]&pageSize=2`);
    const existing = probe?.legendSets?.[0];
    if (existing) {
      return {
        success: true,
        action: 'create',
        _idempotent_reuse: true,
        legend_set_id: existing.id,
        legend_set: existing,
        message: `Legend set "${existing.name}" already exists (${existing.id}) — reusing it instead of creating a duplicate. Its current bands are listed; use add_legends/update if they need adjusting.`,
      };
    }
  }

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

// DHIS2 minor version as a number (e.g. 42), or null if unknown. dhis2.apiVersion
// is set to info.version.split('.')[1] on connect, so it is already the minor.
function getDhis2MinorVersion() {
  const v = parseInt(dhis2.apiVersion, 10);
  return Number.isFinite(v) ? v : null;
}

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
    // domainType matters: a TRACKER-domain data element is NOT a valid aggregate
    // dx item — plotting one directly produces a visualization that errors at
    // render time (the 2026-07-13 "3 of 5 tiles broken" report). Fetch it so we
    // can reject those with an actionable message instead of saving a dud.
    safeDhis2Fetch(`dataElements.json?filter=${inFilter}&fields=id,displayName,domainType&paging=false`),
    safeDhis2Fetch(`programIndicators.json?filter=${inFilter}&fields=id&paging=false`),
  ]);
  const trackerNames = {}; // id → displayName for tracker DEs (invalid as aggregate dx)
  for (const o of (indResp?.indicators || [])) if (!typeMap[o.id]) typeMap[o.id] = 'INDICATOR';
  for (const o of (deResp?.dataElements || [])) {
    if (typeMap[o.id]) continue;
    if (o.domainType === 'TRACKER') {
      typeMap[o.id] = 'TRACKER_DATA_ELEMENT';
      trackerNames[o.id] = o.displayName || o.id;
    } else {
      typeMap[o.id] = 'DATA_ELEMENT';
    }
  }
  for (const o of (piResp?.programIndicators || [])) if (!typeMap[o.id]) typeMap[o.id] = 'PROGRAM_INDICATOR';
  let unresolved = list.filter(u => !typeMap[u]);

  // Name → UID aliasing: models routinely pass an object's NAME as a data
  // item (observed live 2026-07-19: data_items:["Early ANC initiation
  // (before 12 weeks)"] → hard failure + circuit breaker). Anything that is
  // not UID-shaped is resolved by exact name against indicators / program
  // indicators / aggregate DEs; a UNIQUE match substitutes the UID IN PLACE
  // in the caller's array (both create_visualization and dashboard items pass
  // spec.data_items by reference) and is reported in `aliases`.
  const aliases = [];
  const nameItems = unresolved.filter(u => !/^[A-Za-z][A-Za-z0-9]{10}$/.test(u));
  for (const raw of nameItems) {
    const [indR, piR, deR] = await Promise.all([
      safeDhis2Fetch(`indicators?filter=name:eq:${encodeURIComponent(raw)}&fields=id&pageSize=2`),
      safeDhis2Fetch(`programIndicators?filter=name:eq:${encodeURIComponent(raw)}&fields=id&pageSize=2`),
      safeDhis2Fetch(`dataElements?filter=name:eq:${encodeURIComponent(raw)}&filter=domainType:eq:AGGREGATE&fields=id&pageSize=2`),
    ]);
    let id = null, type = null;
    if ((indR?.indicators || []).length === 1) { id = indR.indicators[0].id; type = 'INDICATOR'; }
    else if ((piR?.programIndicators || []).length === 1) { id = piR.programIndicators[0].id; type = 'PROGRAM_INDICATOR'; }
    else if ((deR?.dataElements || []).length === 1) { id = deR.dataElements[0].id; type = 'DATA_ELEMENT'; }
    if (id) {
      typeMap[id] = type;
      aliases.push({ name: raw, id, type });
      if (Array.isArray(uids)) {
        for (let i = 0; i < uids.length; i++) if (String(uids[i]).trim() === raw) uids[i] = id;
      }
    }
  }
  if (aliases.length) unresolved = unresolved.filter(u => !aliases.some(a => a.name === u));
  return { typeMap, unresolved, trackerNames, aliases };
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
    if (t === 'TRACKER_DATA_ELEMENT') {
      // A tracker data element cannot be plotted directly: the aggregate
      // analytics engine only serves AGGREGATE-domain data, so a tile built on
      // one renders an error (the exact defect behind the "3 of 5 tiles broken"
      // report). Refuse at build time and point the model at the right pattern —
      // it now has manage_program_indicators available on dashboard turns.
      return {
        _error: `Data item "${u}" is a TRACKER data element and cannot be plotted directly on a visualization — a tile built on it renders an error in DHIS2 (aggregate analytics only serves AGGREGATE-domain data).`,
        _hint: `Create a PROGRAM INDICATOR that aggregates this data element, then plot THAT: manage_program_indicators(action="create", ...) with an expression/filter referencing #{stageId.${u}} (e.g. a count or percentage of events/enrollments matching a value), then pass the new program indicator's UID as the data_item. Do not pass raw tracker data element or tracked-entity-attribute UIDs as visualization data_items.`,
        _tracker_data_element: u,
      };
    }
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
    if (typeMap[itemId] === 'TRACKER_DATA_ELEMENT') {
      return {
        _error: `Data item "${itemId}" is a TRACKER data element and cannot shade a thematic map directly — aggregate analytics only serves AGGREGATE-domain data.`,
        _hint: `Create a program indicator that aggregates it (manage_program_indicators action="create") and pass that program indicator's UID as data_item.`,
        _tracker_data_element: itemId,
        _scope: 'tracker_data_element_not_aggregatable',
      };
    }
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
      const itType = String(it.type || (it.map_id ? 'MAP' : (it.event_visualization_id || it.line_list_id) ? 'EVENT_VISUALIZATION' : it.text != null ? 'TEXT' : 'VISUALIZATION')).toUpperCase();
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
      } else if (itType === 'EVENT_VISUALIZATION') {
        const evId = it.event_visualization_id || it.line_list_id;
        if (!evId) return { _error: `Item ${i + 1} is an EVENT_VISUALIZATION (line list) but has no event_visualization_id / line_list_id.` };
        di.eventVisualization = { id: evId };
      } else if (itType === 'TEXT') {
        di.text = String(it.text || '');
      } else {
        return { _error: `Item ${i + 1} has unsupported type "${itType}". Use VISUALIZATION, MAP, EVENT_VISUALIZATION (a saved line list) or TEXT.` };
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
    const refEvIds = [...new Set(dashboardItems.filter(di => di.type === 'EVENT_VISUALIZATION').map(di => di.eventVisualization.id))];
    if (refEvIds.length) {
      const er = await safeDhis2Fetch(`eventVisualizations.json?filter=id:in:[${refEvIds.join(',')}]&fields=id&paging=false`);
      const foundE = new Set((er?.eventVisualizations || []).map(o => o.id));
      const missingE = refEvIds.filter(id => !foundE.has(id));
      if (missingE.length) return { _error: `These referenced line-list (eventVisualization) UIDs do not exist: ${missingE.join(', ')}.`, _hint: 'Create them first with manage_line_lists, or fix the UIDs via manage_line_lists(action="list").' };
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
      const itType = String(it.type || (it.map_id ? 'MAP' : (it.event_visualization_id || it.line_list_id) ? 'EVENT_VISUALIZATION' : it.text != null ? 'TEXT' : 'VISUALIZATION')).toUpperCase();
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
      } else if (itType === 'EVENT_VISUALIZATION') {
        const evId = it.event_visualization_id || it.line_list_id || it.id;
        if (!evId) return { _error: `Item ${i + 1} is an EVENT_VISUALIZATION (line list) but has no event_visualization_id / line_list_id.` };
        const er = await safeDhis2Fetch(`eventVisualizations/${evId}?fields=id,displayName,type`);
        if (er?._status === 404) return { _error: `Item ${i + 1}: line list (eventVisualization) "${evId}" does not exist (404). Not adding a broken tile.`, _hint: 'Create it first with manage_line_lists, or confirm the UID via manage_line_lists(action="list").' };
        if (er?._error) return { _error: `Item ${i + 1}: could not verify line list ${evId}: ${er._error}` };
        di.eventVisualization = { id: evId };
        summary.push({ item_id: di.id, type: 'EVENT_VISUALIZATION', object_id: evId, object_name: er.displayName || null });
      } else if (itType === 'TEXT') {
        di.text = String(it.text || '');
        summary.push({ item_id: di.id, type: 'TEXT' });
      } else {
        return { _error: `Item ${i + 1} has unsupported type "${itType}". Use VISUALIZATION, MAP, EVENT_VISUALIZATION (a saved line list) or TEXT (or new_visualization).` };
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
    if (other.length === 1) return other[0];
    // Underscore-insensitive last resort: weak models emit near-miss tokens
    // ("haemoglobin_in_g_d_l" for "haemoglobin_in_g_dl"). Only an UNAMBIGUOUS
    // squash-equality/prefix match resolves.
    const squash = (x) => String(x).replace(/_/g, '');
    const sq = squash(token);
    const sqMatch = (names, kind) => {
      const eq = [], pref2 = [];
      for (const n of names) {
        const sn = squash(sanitizeVariableName(n));
        if (sn === sq) eq.push({ kind, name: n });
        else if (sn.startsWith(sq) || sq.startsWith(sn)) pref2.push({ kind, name: n });
      }
      return eq.length ? eq : pref2;
    };
    const sq1 = sqMatch(kinds[0][0], kinds[0][1]);
    if (sq1.length === 1) return sq1[0];
    if (sq1.length > 1) return null;
    const sq2 = sqMatch(kinds[1][0], kinds[1][1]);
    return sq2.length === 1 ? sq2[0] : null;
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

// ── Reuse-compatibility gate for existing DEs / TEAs ─────────────────────────
// Reusing an existing object by name is the never-recreate doctrine — but a
// same-name object whose definition CONTRADICTS the request silently breaks the
// program (live 2026-07-18: existing DE "Mode of delivery" was bound to a
// 2-option Vaginal/Cesarean set while the program needed 5 modes; blind reuse
// dropped 3 options and made every caesarean rule dead). Reuse is allowed when:
//   • the requested value type is in the same FAMILY as the existing one
//     (numeric/date/boolean/text buckets — INTEGER_POSITIVE reuses a NUMBER
//     field fine; a DATE can never reuse a TEXT), and
//   • when the request carries an inline option_set, the existing object's
//     option set already contains every requested option (case-insensitive).
// Anything else returns a reason string and the caller creates a coexisting
// "<name> (<program short name>)" object instead.
function valueTypeFamily(vt) {
  const v = String(vt || '').toUpperCase();
  if (/^(NUMBER|INTEGER|INTEGER_POSITIVE|INTEGER_NEGATIVE|INTEGER_ZERO_OR_POSITIVE|PERCENTAGE|UNIT_INTERVAL)$/.test(v)) return 'numeric';
  if (/^(DATE|DATETIME|AGE)$/.test(v)) return 'date';
  if (/^(BOOLEAN|TRUE_ONLY)$/.test(v)) return 'boolean';
  if (/^(TEXT|LONG_TEXT|MULTI_TEXT|PHONE_NUMBER|EMAIL|URL|USERNAME)$/.test(v)) return 'text';
  return v; // ORGANISATION_UNIT, COORDINATE, FILE_RESOURCE, IMAGE… must match exactly
}
function reuseIncompatibilityReason(reqDef, existing) {
  if (!reqDef) return null;
  const reqVt = reqDef.value_type || reqDef.valueType;
  if (reqVt && existing.valueType && valueTypeFamily(reqVt) !== valueTypeFamily(existing.valueType)) {
    return `existing value type ${existing.valueType} is incompatible with requested ${reqVt}`;
  }
  const reqOpts = reqDef.option_set && Array.isArray(reqDef.option_set.options) ? reqDef.option_set.options : null;
  if (reqOpts && reqOpts.length) {
    const have = new Set((existing.optionSet?.options || []).map(o => String((o && (o.name ?? o)) || '').toLowerCase()));
    const missing = reqOpts.map(o => (typeof o === 'string' ? o : o?.name)).filter(n => n && !have.has(String(n).toLowerCase()));
    if (missing.length) return `existing option set is missing requested option(s): ${missing.join(', ')}`;
  }
  return null;
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

