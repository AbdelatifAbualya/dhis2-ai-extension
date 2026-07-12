// ── Feedback Storage ─────────────────────────────────────────────────────────
let lastInteraction = { question: '', apiCalls: [], answer: '' };

const FEEDBACK_LOG_MAX = 200;
const FEEDBACK_FIELD_MAX = 4000;
function truncateForFeedback(v) {
  if (typeof v === 'string') return v.length > FEEDBACK_FIELD_MAX ? v.slice(0, FEEDBACK_FIELD_MAX) + '…[truncated]' : v;
  if (Array.isArray(v)) {
    try {
      const s = JSON.stringify(v);
      return s.length > FEEDBACK_FIELD_MAX ? s.slice(0, FEEDBACK_FIELD_MAX) + '…[truncated]' : v;
    } catch { return '[unserializable]'; }
  }
  return v;
}

async function storeFeedback(type, question, apiCalls, answer, comment) {
  try {
    const stored = await chrome.storage.local.get(['feedbackLog']);
    const log = stored.feedbackLog || [];
    log.push({
      timestamp: new Date().toISOString(),
      feedback: type,
      question: truncateForFeedback(question),
      apiCalls: truncateForFeedback(apiCalls),
      answer: truncateForFeedback(answer),
      comment: truncateForFeedback(comment || ''),
      context: {
        program: dhis2.programMetadata?.displayName || null,
        programId: dhis2.pageContext?.programId || null,
        orgUnit: dhis2.ouContext?.displayName || null,
        orgUnitId: dhis2.pageContext?.orgUnitId || null,
      },
    });
    // Cap log size so chrome.storage.local doesn't grow unbounded.
    if (log.length > FEEDBACK_LOG_MAX) log.splice(0, log.length - FEEDBACK_LOG_MAX);
    await chrome.storage.local.set({ feedbackLog: log });
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Service Worker Keepalive ────────────────────────────────────────────────
// MV3 service workers are evicted after ~30s of idle. Multi-step agentic runs
// (create_metadata, long chains of dhis2_query, upstream LLM streams) easily
// exceed that, producing the "background worker interrupted or upstream
// timeout" error. While any long-running task is active we self-ping
// chrome.runtime.getPlatformInfo() every 20s — each call is an API access that
// resets the SW idle timer. Reference-counted so concurrent requests don't
// drop the keepalive early.
let swKeepaliveInterval = null;
let swKeepaliveRefs = 0;
function acquireKeepalive() {
  swKeepaliveRefs++;
  if (swKeepaliveInterval) return;
  swKeepaliveInterval = setInterval(() => {
    try { chrome.runtime.getPlatformInfo().catch(() => {}); } catch {}
    // Heartbeat to the side panel: proves the worker is alive during long
    // silent phases (big tool-argument generations emit no stream chunks),
    // so the panel's watchdog doesn't falsely declare "stopped responding".
    broadcast({ type: 'AI_HEARTBEAT', at: Date.now() });
  }, 20_000);
}
function releaseKeepalive() {
  swKeepaliveRefs = Math.max(0, swKeepaliveRefs - 1);
  if (swKeepaliveRefs === 0 && swKeepaliveInterval) {
    clearInterval(swKeepaliveInterval);
    swKeepaliveInterval = null;
  }
}

// ── Save-error auto-diagnosis ──────────────────────────────────────────────
// When the user reports a save error and a program is in context, fetch every
// save-relevant config in parallel so the model has the answer without needing
// to ask the user for the error code or DevTools output.
async function prefetchSaveErrorContext(ctx) {
  const programId = ctx.programId;
  if (!programId) return null;

  const programFields = [
    'id', 'name', 'shortName', 'programType',
    'selectEnrollmentDatesInFuture', 'selectIncidentDatesInFuture',
    'onlyEnrollOnce', 'displayIncidentDate',
    'enrollmentDateLabel', 'incidentDateLabel',
    'organisationUnits[id,displayName]',
    'programTrackedEntityAttributes[mandatory,trackedEntityAttribute[id,displayName,valueType,unique]]',
    'trackedEntityType[id,displayName,trackedEntityTypeAttributes[mandatory,trackedEntityAttribute[id,displayName,valueType]]]',
    'access',
    'sharing[public,users,userGroups]',
  ].join(',');

  const calls = [
    safeDhis2Fetch(`programs/${programId}?fields=${programFields}`),
    safeDhis2Fetch(`me?fields=id,username,organisationUnits[id,displayName],dataViewOrganisationUnits[id,displayName],userCredentials[username,userRoles[id,displayName,authorities]],authorities`),
  ];
  // If a TEI is in context, also fetch existing enrollments for this entity in this program
  if (ctx.teiId) {
    calls.push(safeDhis2Fetch(`tracker/enrollments?trackedEntity=${ctx.teiId}&program=${programId}&fields=enrollment,status,enrolledAt,occurredAt,orgUnit&pageSize=20`));
  }

  const [progResp, meResp, enrResp] = await Promise.allSettled(calls);
  const program = progResp.status === 'fulfilled' && !progResp.value._error ? progResp.value : { _error: progResp.value?._error || 'fetch failed' };
  const me = meResp.status === 'fulfilled' && !meResp.value._error ? meResp.value : { _error: meResp.value?._error || 'fetch failed' };
  const enrollments = enrResp && enrResp.status === 'fulfilled' && !enrResp.value._error ? enrResp.value : null;

  // Compute structured findings the model can read directly
  const findings = [];
  if (program && !program._error) {
    if (program.selectEnrollmentDatesInFuture === false) {
      findings.push({ code: 'E1020', risk: 'high', cause: 'Future enrollment dates are NOT allowed on this program', evidence: { selectEnrollmentDatesInFuture: false } });
    }
    if (program.selectIncidentDatesInFuture === false) {
      findings.push({ code: 'E1021', risk: 'high', cause: 'Future incident dates are NOT allowed on this program', evidence: { selectIncidentDatesInFuture: false } });
    }
    if (program.onlyEnrollOnce === true) {
      findings.push({ code: 'E1016', risk: 'medium', cause: 'Program allows only one enrollment per tracked entity (onlyEnrollOnce=true)', evidence: { onlyEnrollOnce: true } });
    }
    const mandatory = (program.programTrackedEntityAttributes || []).filter(p => p.mandatory).map(p => p.trackedEntityAttribute);
    if (mandatory.length) {
      findings.push({ code: 'E1018', risk: 'medium', cause: 'These tracked-entity attributes are mandatory for enrollment', evidence: { mandatory_attributes: mandatory } });
    }
    const programOus = program.organisationUnits || [];
    if (programOus.length === 0) {
      findings.push({ code: 'E1041', risk: 'high', cause: 'Program has NO organisation units assigned — no enrollment can be saved', evidence: { program_org_unit_count: 0 } });
    }
    if (program.access && (program.access.write === false || program.access.data?.write === false)) {
      findings.push({ code: 'E1091', risk: 'high', cause: 'Current user does NOT have write/data-write access to this program', evidence: { access: program.access } });
    }
  }
  if (me && !me._error && program && !program._error && Array.isArray(program.organisationUnits)) {
    const userOuIds = new Set((me.organisationUnits || []).map(o => o.id));
    const programOuIds = new Set((program.organisationUnits || []).map(o => o.id));
    const overlap = [...userOuIds].filter(id => programOuIds.has(id));
    // Note: only ID-equality is checked here. Path-based descendant matches
    // (a user at facility level X who is a child of a program-assigned district)
    // would NOT show overlap by ID — so this is downgraded to "low" risk and
    // marked as advisory. The lead E1020/E1021/E1015/E1016/E1018 findings are
    // higher-confidence and should be reported first when present.
    if (userOuIds.size && programOuIds.size && overlap.length === 0) {
      findings.push({
        code: 'E1000/E1041',
        risk: 'low',
        cause: 'User\'s capture org units may not overlap with program OUs (ID-only check; OU-hierarchy descendants are NOT considered)',
        evidence: {
          user_capture_ou_count: userOuIds.size,
          program_ou_count: programOuIds.size,
          note: 'False-positive possible if user OU is a descendant of a program-assigned OU.',
        },
      });
    }
  }
  const teiActiveEnrollment = (enrollments?.enrollments || enrollments?.instances || []).find(e => e.status === 'ACTIVE');
  if (ctx.teiId && teiActiveEnrollment) {
    findings.push({ code: 'E1015', risk: 'high', cause: 'This tracked entity already has an ACTIVE enrollment in this program', evidence: { existing_enrollment: teiActiveEnrollment } });
  }
  if (ctx.teiId && program?.onlyEnrollOnce && (enrollments?.enrollments || enrollments?.instances || []).length > 0) {
    findings.push({ code: 'E1016', risk: 'high', cause: 'This program allows only one enrollment AND this entity has been enrolled before', evidence: { existing_count: (enrollments?.enrollments || enrollments?.instances || []).length } });
  }

  return {
    program_id: programId,
    program: program._error ? { _error: program._error } : program,
    user: me._error ? { _error: me._error } : { id: me.id, username: me.username, organisationUnits: me.organisationUnits, authorities_count: (me.authorities || []).length },
    existing_enrollments: enrollments,
    findings,
    diagnostic_note: 'Use findings[] to identify the cause directly. Do NOT ask the user for the error code or DevTools output unless findings is empty AND no E-code can be inferred from the data above.',
  };
}

function summarizeSaveErrorDiagnosis(diag) {
  if (!diag) return { headline: 'No program context', guidance: 'Ask the user which program/page.' };
  const f = diag.findings || [];
  if (!f.length) {
    return {
      headline: 'No obvious config issue',
      guidance: 'No automatic finding from program flags + user access + existing enrollments. Ask the user one specific question: "What did you fill into the form, and what date did you enter?" — do NOT ask for the error code or DevTools output.',
    };
  }
  const high = f.filter(x => x.risk === 'high');
  const lead = high[0] || f[0];
  const others = f.filter(x => x !== lead).map(x => x.code).join(', ');
  return {
    headline: `Likely ${lead.code}: ${lead.cause}`,
    guidance: `Lead finding: ${lead.code} (${lead.cause}). ${others ? 'Also potentially relevant: ' + others + '.' : ''} Tell the user this finding directly. If the lead is E1020/E1021, ask ONE confirmation: "Did you enter a date later than today?" If E1015/E1016, tell them the existing enrollment exists. If E1018, list the mandatory attributes by name. Never list every E-code as a generic menu.`,
  };
}

// ── Agentic Loop ─────────────────────────────────────────────────────────────

async function runAgenticLoop(userText, imageBase64, browseWeb = false, inspectMode = false) {
  acquireKeepalive();
  try {
    return await _runAgenticLoopInner(userText, imageBase64, browseWeb, inspectMode);
  } finally {
    releaseKeepalive();
  }
}

async function _runAgenticLoopInner(userText, imageBase64, browseWeb = false, inspectMode = false) {
  lastUserText = userText || '';

  // ── Per-turn write-authorization gate ──
  // Classify the user's most recent message into a write scope. Destructive
  // tool branches consult dhis2.writeAuth before acting. Reset every turn so
  // authorization NEVER persists across user turns — the user must re-affirm.
  dhis2.writeAuth = classifyWriteAuthorization(userText);
  dhis2.destructive404Count = 0;
  dhis2.destructive404History = [];
  dhis2.httpErrorCount = 0;
  dhis2.httpErrorHistory = [];
  dhis2.failedCallSigs = new Map();
  dhis2.toolErrorFamilies = new Map();
  dhis2.toolSuccessCount = 0;
  console.log(`[AgenticLoop] writeAuth = ${dhis2.writeAuth.scope} (${dhis2.writeAuth.reason})`);

  const ctx = dhis2.pageContext || {};
  const inspectSnapshot = inspectMode ? buildInspectSnapshot() : null;

  // Seed the known-IDs registry from every verified source available BEFORE
  // any tool call: user text, page context, inspect logs, already-loaded
  // program/OU/viz/map metadata. The registry grows as tools return data.
  seedKnownIds(userText, ctx, inspectSnapshot);
  seedKnownIcons();
  seedRecentCreations();
  console.log(`[AgenticLoop] knownIds seeded with ${dhis2.knownIds.size} UID(s); knownIcons + recentCreations reset`);
  const routingText = inspectSnapshot?.enabled
    ? `${userText || ''}\n\n[Inspect diagnostics]\n${JSON.stringify(inspectSnapshot.insights || {})}`
    : userText;

  // ── Dynamic tool selection — send only tools relevant to this request ──
  const contextualTools = getContextualTools(ctx, routingText, browseWeb, inspectSnapshot);
  const contextualToolNames = new Set(contextualTools.map(t => t.function.name));
  console.log(`[AgenticLoop] Using ${contextualTools.length}/${TOOLS.length} tools:`,
    [...contextualToolNames].join(', '));

  // ── Two-tier tool docs ──
  // The provider receives SLIM definitions for MANUAL_TOOLS (routing info
  // only); each such tool's full manual is delivered by the gate below on its
  // first call this turn, BEFORE anything executes.
  const wireTools = toWireTools(contextualTools);
  const deliveredManuals = new Set();

  const systemPrompt = await buildSystemPrompt(userText, !!imageBase64, !!browseWeb, inspectSnapshot);

  // If image is attached, analyze with a vision model first, then include description
  let userContent;
  let historyText = userText;

  if (imageBase64) {
    broadcast({ type: 'AI_THINKING', iteration: 0, label: 'Analyzing attached image' });
    const imageAnalysis = await analyzeImage(imageBase64, userText);
    if (imageAnalysis) {
      // Vision model succeeded — include description in text for the main model
      const enrichedText = `${userText}\n\n[Attached Image Analysis]\n${imageAnalysis}`;
      userContent = enrichedText;
      historyText = enrichedText;
    } else {
      // Vision model failed — pass image directly as fallback
      userContent = [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: imageBase64 } },
      ];
    }
  } else {
    userContent = browseWeb
      ? `${userText}\n\n[Web Browsing Enabled]\nUse browse_web tool if external/current web info is needed.`
      : userText;
  }

  if (inspectSnapshot?.enabled) {
    const inspectBlock =
      `\n\n[Inspect Logs]\n` +
      `Captured ${inspectSnapshot.captured} console/runtime/network entries for the active tab since ${inspectSnapshot.startedAt}.\n` +
      `Active tab URL: ${inspectSnapshot.url || 'unknown'}\n` +
      `${JSON.stringify({
        counts: inspectSnapshot.counts,
        insights: inspectSnapshot.insights,
        logs: inspectSnapshot.logs,
      })}`;
    if (typeof userContent === 'string') {
      userContent += inspectBlock;
      historyText += `\n\n[Inspect Logs attached: ${inspectSnapshot.captured} entries]`;
    } else if (Array.isArray(userContent) && userContent[0]?.type === 'text') {
      userContent[0].text += inspectBlock;
      historyText += `\n\n[Inspect Logs attached: ${inspectSnapshot.captured} entries]`;
    }
  }

  if (browseWeb) {
    if (typeof userContent === 'string') {
      if (!userContent.includes('[Web Browsing Enabled]')) {
        userContent += '\n\n[Web Browsing Enabled]';
      }
    } else if (Array.isArray(userContent) && userContent[0]?.type === 'text') {
      userContent[0].text += '\n\n[Web Browsing Enabled]\nUse browse_web tool if external/current web info is needed.';
    }
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: userContent },
  ];

  const charts = [];
  const apiCallsLog = [];
  // Only harvest a "pasted viz ID" from free text when the user actually included
  // an explicit DHIS2-looking URL. Bare-word scanning is too permissive even with
  // the entropy-aware isLikelyDhisUid — e.g. a UID typed mid-sentence unrelated
  // to viz. Requiring a URL keeps the prefetch off unless the intent is clear.
  const userTextHasUrl = /https?:\/\/\S+/i.test(lastUserText || '');
  const pastedVizId = userTextHasUrl ? extractVisualizationIdFromText(lastUserText) : null;

  // Reliability prefetch: when user is in Data Visualizer route with a viz ID,
  // preload visualization details so answers are grounded even if model skips tool call.
  // Skip re-fetching if the same viz was already prefetched in this conversation.
  // Gate strictly on appType or an explicit pasted URL — never on free-text word
  // matches. Previously "Respiratory" (11-char English word) leaked in as a viz
  // ID, triggered a 404 prefetch, and destabilized the turn.
  const prefetchVizId = ctx.visualizationId || pastedVizId;
  if (prefetchVizId && (ctx.appType === 'Data Visualizer' || pastedVizId)) {
    if (prefetchedIds.viz === prefetchVizId && conversationHistory.length > 0) {
      // Already loaded in a previous turn — just remind the model not to re-fetch
      messages.push({
        role: 'system',
        content: `Visualization "${prefetchVizId}" was already loaded and explained earlier in this conversation. Do NOT call get_visualization_details again — use the data already in the conversation history to answer the user's follow-up question directly.`,
      });
    } else {
      broadcast({ type: 'AI_THINKING', iteration: 0, label: 'Loading visualization metadata' });
      const needValues = isVisualizationValueQuestion(userText);
      const prefetchArgs = {
        visualization_id: prefetchVizId,
        include_full_definition: false,
        include_analytics_preview: true,
        analytics_preview_limit: needValues ? 200 : 80,
      };
      broadcast({ type: 'AI_TOOL_CALL', tool: 'get_visualization_details', args: prefetchArgs });
      const prefetch = await executeTool('get_visualization_details', prefetchArgs);
      const summary = prefetch._error
        ? (prefetch._error || 'Failed').slice(0, 80)
        : `${prefetch.visualization?.name || prefetchVizId}${prefetch.visualization?.type ? ` (${prefetch.visualization.type})` : ''}`;
      broadcast({
        type: 'AI_TOOL_DONE',
        tool: 'get_visualization_details',
        success: !prefetch._error,
        summary,
        apiPath: prefetch._apiPath || prefetch.api_endpoints?.visualization_definition || null,
      });
      apiCallsLog.push({ tool: 'get_visualization_details', args: JSON.parse(JSON.stringify(prefetchArgs)) });

      // Build a rich prefetch context for the LLM with resolved names and human-readable summaries
      const prefetchContext = {
        visualization: prefetch.visualization,
        human_summary: prefetch.human_summary || null,
        layout: prefetch.layout,
        scope: prefetch.scope,
        chart_settings: prefetch.chart_settings,
        api_endpoints: prefetch.api_endpoints,
        analytics_blueprint: prefetch.analytics_blueprint,
        values_status: prefetch.values_status || null,
        analytics_preview_resolved: prefetch.analytics_preview?._resolved_table?.slice?.(0, 50) || null,
        analytics_preview_sample_rows: prefetch.analytics_preview?.rows?.slice?.(0, 30) || null,
        analytics_preview_headers: prefetch.analytics_preview?.headers || null,
        analytics_preview_meta_items: prefetch.analytics_preview?.metaData?.items || null,
        prefetch_error: prefetch._error || null,
      };

      if (prefetch._error) {
        // Prefetch failed. Only nudge the model to retry when the user is
        // actually in Data Visualizer (ctx.visualizationId is authoritative).
        // If the ID came from a pasted URL and 404s, silently drop it — asking
        // the model to call a tool that just failed wastes a turn and risks
        // derailing the real task (e.g. create a program titled "Respiratory...").
        if (ctx.visualizationId) {
          messages.push({
            role: 'system',
            content: `Visualization prefetch failed: ${prefetch._error}. Call get_visualization_details to load it directly.`,
          });
        }
      } else {
        const vizInstruction = prefetchContext.values_status?.available === false
          ? `IMPORTANT: Analytics data is unavailable on this instance, but you have the FULL visualization definition with resolved names. You MUST explain the visualization thoroughly using the metadata below (name, type, data items, periods, org units, layout, chart settings). Do NOT just report an analytics error — give a complete explanation.`
          : `Use human_summary as your foundation. Expand with data_items details and analytics_preview values.`;
        messages.push({
          role: 'system',
          content:
            `Prefetched visualization context for this turn. ${vizInstruction}\n` +
            `${JSON.stringify(prefetchContext)}`,
        });
        prefetchedIds.viz = prefetchVizId;
      }
    }
  }

  // Reliability prefetch: when user is in Maps route with a map ID,
  // preload map details so answers are grounded even if model skips tool call.
  // Skip re-fetching if the same map was already prefetched in this conversation.
  // Only fire when user is in Maps app; never triggered by bare-word scans.
  const prefetchMapId = ctx.mapId || (ctx.appType === 'Maps' ? extractMapIdFromText(lastUserText) : null);
  if (prefetchMapId && ctx.appType === 'Maps') {
    if (prefetchedIds.map === prefetchMapId && conversationHistory.length > 0) {
      // Already loaded in a previous turn — just remind the model not to re-fetch
      messages.push({
        role: 'system',
        content: `Map "${prefetchMapId}" was already loaded and explained earlier in this conversation. Do NOT call get_map_details again — use the data already in the conversation history to answer the user's follow-up question directly.`,
      });
    } else {
      broadcast({ type: 'AI_THINKING', iteration: 0, label: 'Loading map metadata' });
      const prefetchArgs = {
        map_id: prefetchMapId,
        include_full_definition: false,
        include_analytics_preview: true,
        analytics_preview_limit: 50,
      };
      broadcast({ type: 'AI_TOOL_CALL', tool: 'get_map_details', args: prefetchArgs });
      const prefetch = await executeTool('get_map_details', prefetchArgs);
      const summary = prefetch._error
        ? (prefetch._error || 'Failed').slice(0, 80)
        : `${prefetch.map?.name || prefetchMapId} (${prefetch.layers?.length || 0} layers)`;
      broadcast({
        type: 'AI_TOOL_DONE',
        tool: 'get_map_details',
        success: !prefetch._error,
        summary,
        apiPath: prefetch._apiPath || prefetch.api_endpoints?.map_definition || null,
      });
      apiCallsLog.push({ tool: 'get_map_details', args: JSON.parse(JSON.stringify(prefetchArgs)) });

      if (prefetch._error) {
        messages.push({
          role: 'system',
          content: `Map prefetch failed: ${prefetch._error}. Call get_map_details to load it directly.`,
        });
      } else {
        const mapPrefetchContext = {
          map: prefetch.map,
          human_summary: prefetch.human_summary || null,
          layers: prefetch.layers,
          layer_analytics_previews: prefetch.layer_analytics_previews || null,
          api_endpoints: prefetch.api_endpoints,
        };

        messages.push({
          role: 'system',
          content:
            `Prefetched map context for this turn (all names are resolved, use human_summary for explanation):\n` +
            `${JSON.stringify(mapPrefetchContext)}`,
        });
        prefetchedIds.map = prefetchMapId;
      }
    }
  }

  // Patient/TEI data auto-loading is disabled. The chatbot must not fetch
  // tracked-entity (person) records, attributes, or events automatically — even
  // when a TEI ID is present in the page context. If the user is on a tracker
  // profile page, inject a privacy notice instead so the model knows it cannot
  // retrieve patient data.
  if (ctx.teiId) {
    messages.push({
      role: 'system',
      content:
        `Privacy mode: patient/TEI data lookup is disabled in this build. ` +
        `Although a tracked-entity ID ("${ctx.teiId}") is in the page URL, you MUST NOT fetch ` +
        `tracker/trackedEntities/${ctx.teiId} or any per-person endpoint via dhis2_query, and you have no get_tracked_entity tool. ` +
        `If the user asks about "this person", "this patient", their attributes, enrollments, events, or visits, ` +
        `reply that patient-level data retrieval has been disabled by the extension owner and offer program-level alternatives ` +
        `(aggregate counts via count_records, program metadata via get_program_info, etc.).`,
    });
  }

  // ── Save-error auto-diagnosis prefetch ──
  // When the user reports a save failure AND a program is in context, eagerly
  // pull every save-relevant config flag, the user's OU/program access, and
  // any existing enrollments for the TEI in context. Inject the bundle as a
  // system message so the model can identify the likely cause WITHOUT asking
  // the user for the error code — the chatbot has tools, it should use them.
  const saveDiagText = (userText || '').toLowerCase();
  const saveDiagInspect = inspectSnapshot?.enabled ? JSON.stringify(inspectSnapshot.insights || {}).toLowerCase() : '';
  const saveDiagDetected = SAVE_FAILURE_RE.test(saveDiagText + '\n' + saveDiagInspect)
    || (inspectSnapshot?.enabled && /\b409\b/.test(saveDiagInspect));
  if (saveDiagDetected && ctx.programId) {
    broadcast({ type: 'AI_THINKING', iteration: 0, label: 'Diagnosing save error' });
    try {
      const diag = await prefetchSaveErrorContext(ctx);
      if (diag) {
        // Extend known IDs from this prefetched bundle so subsequent calls work
        recordKnownIdsFromResult(diag);
        const summary = summarizeSaveErrorDiagnosis(diag);
        broadcast({
          type: 'AI_TOOL_CALL',
          tool: 'diagnose_save_error',
          args: { program_id: ctx.programId, tei_id: ctx.teiId || null },
          summary: summary.headline,
        });
        broadcast({
          type: 'AI_TOOL_RESULT',
          tool: 'diagnose_save_error',
          summary: summary.headline,
          apiPath: `programs/${ctx.programId}?fields=...`,
        });
        messages.push({
          role: 'system',
          content:
            `[Save-error diagnostic context — pre-fetched]\n` +
            `${JSON.stringify(diag)}\n\n` +
            `INSTRUCTIONS — read carefully:\n` +
            `1. Use the data above to identify the likely cause of the save error WITHOUT asking the user for the error code or DevTools data.\n` +
            `2. ${summary.guidance}\n` +
            `3. Do NOT list every E-code as candidates. Pick the one(s) most consistent with the prefetched data and tell the user directly. Phrase it as a finding, not a question. Example: "This program has selectEnrollmentDatesInFuture=false, which means future enrollment dates are blocked (E1020). If you entered a date later than today, that is the cause." Confirm with one short clarifying question only if needed.\n` +
            `4. Do NOT modify any metadata. The user has not authorized writes.`,
        });
      }
    } catch (e) {
      console.warn('[SaveErrorDiag] prefetch failed:', e?.message || e);
    }
  }

  // Contextual thinking labels based on tool that just completed
  const thinkingAfterTool = {
    count_records: 'Analyzing count results',
    get_event_analytics: 'Interpreting analytics data',
    get_program_info: 'Reviewing program structure',
    get_program_recent_changes: 'Reviewing recent program changes',
    search_metadata: 'Reviewing search results',
    resolve_option_codes: 'Resolving display names',
    detect_enrollment_abnormalities: 'Analyzing abnormalities',
    cross_stage_entity_intersection: 'Matching conditions',
    line_listing_guide: 'Preparing guidance',
    get_visualization_details: 'Interpreting visualization',
    get_map_details: 'Interpreting map layers',
    browse_web: 'Processing web results',
    dhis2_query: 'Processing API response',
    render_chart: 'Preparing chart',
    create_metadata: 'Processing metadata creation',
    architect_metadata: 'Reviewing architecture',
    manage_program_rules: 'Processing program rules',
    manage_program_indicators: 'Processing program indicators',
    manage_metadata: 'Processing metadata changes',
  };
  const thinkingLabels = [
    'Analyzing your question',
    'Planning approach',
    'Gathering data',
    'Synthesizing information',
    'Refining analysis',
    'Cross-referencing data',
  ];
  let lastToolName = null;
  let emptyResponseCount = 0; // Guard against infinite think-only loops
  let providerStallRetries = 0; // Transparent retries for mid-stream stalls (nothing shown to the user yet)

  // ── Mechanical circuit breaker for deterministic retry loops ────────────────
  // The repeated-failure guard (preflightCheckCall) only ASKS the model to stop
  // — it returns an error telling it to change approach. A model at temperature
  // 0 is deterministic: identical history → identical output, so it re-emits the
  // exact same blocked call every iteration until the budget is exhausted (the
  // TB create_program loop, 2026-07-12). Politeness cannot break that; removal
  // can. Once a tool has been BLOCKED by the guard this many times, it is pulled
  // from the wire schema for the rest of the turn so the model physically cannot
  // call it again and is forced to answer or take a different path.
  const TOOL_BLOCK_DISABLE_THRESHOLD = 3;
  const toolBlockCounts = new Map();   // toolName → # of preflight blocks this turn
  const disabledToolNames = new Set(); // tools removed from the wire schema this turn
  // Wire tools sent to the provider each iteration, minus anything disabled.
  const effectiveWireTools = () =>
    disabledToolNames.size ? wireTools.filter(t => !disabledToolNames.has(t?.function?.name)) : wireTools;

  // Marker: everything in `messages` from this index on is THIS turn (the user
  // message + any prefetch + every assistant/tool message the loop adds). The
  // array was built as [system, ...conversationHistory, userMsg], and
  // conversationHistory is not mutated until turn end, so the user message sits
  // at exactly 1 + conversationHistory.length. At turn end we persist
  // messages.slice(turnStartIdx) so the next turn remembers the actual tool
  // calls + results, not just the final prose.
  const turnStartIdx = 1 + conversationHistory.length;
  // Snapshot the thread identity. If a new-thread reset happens while this turn
  // is still running (panel reopened / "+" clicked mid-generation), the epoch
  // changes and every persistence site below drops this turn instead of
  // re-seeding the freshly-cleared history with the old task.
  const turnEpoch = conversationEpoch;

  for (let i = 0; i < 50; i++) {
    // Contextual thinking label
    const thinkLabel = lastToolName
      ? thinkingAfterTool[lastToolName] || 'Processing results'
      : thinkingLabels[Math.min(i, thinkingLabels.length - 1)];
    broadcast({ type: 'AI_THINKING', iteration: i + 1, label: thinkLabel });
    lastToolName = null;

    // Use streaming for the API call so text appears progressively.
    // Coalesce per-token chunks into at-most-25Hz broadcasts to reduce
    // chrome.runtime.sendMessage overhead between the service worker and the side panel —
    // providers typically emit 40-100 tokens/sec which would otherwise saturate the channel.
    let streamStartBroadcast = false;
    let chunkBuffer = '';
    let flushTimer = null;
    const FLUSH_MS = 40;
    const flushChunks = () => {
      flushTimer = null;
      if (chunkBuffer) {
        broadcast({ type: 'AI_STREAM_CHUNK', text: chunkBuffer });
        chunkBuffer = '';
      }
    };
    let result;
    try {
      result = await callProviderStreaming(messages, true, (chunk) => {
        if (chunk === null) {
          broadcast({ type: 'AI_STREAM_START' });
          streamStartBroadcast = true;
        } else if (streamStartBroadcast) {
          chunkBuffer += chunk;
          if (!flushTimer) flushTimer = setTimeout(flushChunks, FLUSH_MS);
        }
      }, effectiveWireTools(), i);
    } catch (provErr) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      chunkBuffer = '';
      // A mid-stream stall before ANY text reached the panel can be retried
      // transparently — `messages` was not mutated for this iteration, so the
      // request is safely repeatable. If text already streamed, rethrow so the
      // user sees the error rather than duplicated output.
      if (/stream stalled/i.test(provErr?.message || '') && !streamStartBroadcast && providerStallRetries < 2) {
        providerStallRetries++;
        console.warn(`[AgenticLoop] provider stream stalled — retrying (${providerStallRetries}/2)`);
        broadcast({ type: 'AI_THINKING', iteration: i + 1, label: `Connection dropped — retrying (${providerStallRetries}/2)` });
        continue;
      }
      throw provErr;
    }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (chunkBuffer) {
      broadcast({ type: 'AI_STREAM_CHUNK', text: chunkBuffer });
      chunkBuffer = '';
    }

    const msg = result.choices[0].message;
    messages.push(msg);

    // Filter out hallucinated / invalid tool calls before processing
    // Check both TOOL_ROUTER (exists at all) and contextualToolNames (was provided to the model)
    const validToolCalls = (msg.tool_calls || []).filter(tc => {
      const name = tc.function?.name;
      if (!name || !TOOL_ROUTER[name]) {
        console.warn(`[AgenticLoop] Skipping hallucinated tool call: "${name}" (not in TOOL_ROUTER)`);
        return false;
      }
      if (!contextualToolNames.has(name)) {
        console.warn(`[AgenticLoop] Skipping out-of-context tool call: "${name}" (not in contextual tools for this request)`);
        return false;
      }
      return true;
    });
    // Also patch the message we pushed to history so only valid calls remain
    if (msg.tool_calls && validToolCalls.length !== msg.tool_calls.length) {
      msg.tool_calls = validToolCalls.length > 0 ? validToolCalls : undefined;
      // Re-update the message already pushed into the messages array
      messages[messages.length - 1] = msg;
    }

    if (validToolCalls.length > 0) {
      for (const tc of validToolCalls) {
        let args;
        try {
          const rawArgs = tc.function.arguments;
          args = typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : JSON.parse(rawArgs);
        } catch { args = {}; }

        broadcast({ type: 'AI_TOOL_CALL', tool: tc.function.name, args });

        if (tc.function.name === 'render_chart') {
          charts.push(args);
          broadcast({ type: 'AI_CHART', spec: args });
        }

        let toolResult;
        // ── Circuit breaker: a tool disabled earlier this turn is gone from the
        //    wire schema, but guard against a model that re-emits the call anyway
        //    (hallucinated tool) — never execute it; return the stop directive.
        if (disabledToolNames.has(tc.function.name)) {
          toolResult = {
            _error: `${tc.function.name} is disabled for the rest of this turn (it was retried too many times with the same failure) and was NOT executed.`,
            _scope: 'circuit_breaker_tool_disabled',
            _hint: `Do not call ${tc.function.name} again. Write your final answer now from the results already gathered: what was created (names + IDs), what failed and why, and one recommended next step.`,
          };
          broadcast({ type: 'AI_TOOL_DONE', tool: tc.function.name, success: false, summary: `${tc.function.name} is disabled for this turn — not executed`, details: { scope: 'circuit_breaker_tool_disabled' } });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
          continue;
        }
        // ── Manual gate (two-tier tool docs): the FIRST call to a
        //    MANUAL_TOOLS member this turn returns its full usage manual
        //    instead of executing, so the model always reads the complete
        //    instructions before the first real (write-capable) execution.
        //    No API call is made and no preflight/error counters are touched.
        if (MANUAL_TOOLS.has(tc.function.name) && !deliveredManuals.has(tc.function.name)) {
          deliveredManuals.add(tc.function.name);
          console.log(`[AgenticLoop] Manual gate: delivering ${tc.function.name} manual (call not executed)`);
          toolResult = buildManualGateResult(tc.function.name);
        } else {
          if (tc.function.name !== 'render_chart') {
            apiCallsLog.push({ tool: tc.function.name, args: JSON.parse(JSON.stringify(args)) });
          }

          // ── Pre-flight: refuse calls that reference unverified UIDs or that
          //    exceed the per-turn HTTP-error limit. Prevents 404/409 churn. ──
          const preflightStop = preflightCheckCall(tc.function.name, args);
          if (preflightStop) {
            toolResult = preflightStop;
            // Mechanical circuit breaker: a repeated-failure/HTTP-limit block is
            // only advisory to the model. Count blocks per tool and, once a tool
            // trips the threshold, remove it from the wire schema for the rest of
            // the turn AND inject a hard directive. A deterministic model that
            // keeps re-emitting the blocked call is then physically unable to,
            // and must answer or switch tools — breaking the loop for real.
            const isLoopBlock = preflightStop._scope === 'repeated_identical_failure'
              || preflightStop._scope === 'same_error_family_limit'
              || preflightStop._scope === 'http_error_limit_reached';
            if (isLoopBlock) {
              const n = (toolBlockCounts.get(tc.function.name) || 0) + 1;
              toolBlockCounts.set(tc.function.name, n);
              if (n >= TOOL_BLOCK_DISABLE_THRESHOLD && !disabledToolNames.has(tc.function.name)) {
                disabledToolNames.add(tc.function.name);
                console.warn(`[AgenticLoop] Circuit breaker: disabling ${tc.function.name} for this turn after ${n} blocked attempts`);
                toolResult = {
                  ...toolResult,
                  _tool_disabled_this_turn: tc.function.name,
                  _scope: 'circuit_breaker_tool_disabled',
                  _hint: `${tc.function.name} has now been DISABLED for the rest of this turn — you attempted it ${n} times and every attempt was blocked with the same error, so it has been removed from your available tools. You CANNOT call it again. Stop retrying and, using ONLY the tool results already in this conversation, write your final answer to the user now: (1) exactly what was created this turn (names + IDs), (2) what failed and the verbatim error, (3) one concrete recommended next step. If earlier steps DID create objects (e.g. a program), report them as successes — do not describe the whole task as failed.`,
                };
              }
            }
          } else {
            try {
              toolResult = await executeTool(tc.function.name, args);
            } catch (toolErr) {
              toolResult = { _error: `Tool failed: ${toolErr.message}` };
            }
            // ── Post-flight: harvest UIDs from the result so subsequent calls
            //    can reference them, and bump the HTTP-error counter on 4xx/5xx. ──
            recordKnownIdsFromResult(toolResult);
            noteHttpErrorFromResult(tc.function.name, toolResult);
            // Track EVERY failure (including HTTP-200 error payloads like
            // rejected PI expressions) so preflight can refuse doomed retries.
            // From the 2nd same-family failure, escalate the hint the model
            // sees so it changes approach instead of resending variations.
            const failNote = noteToolFailure(tc.function.name, args, toolResult);
            if (failNote && failNote.famCount >= 2) {
              toolResult._failure_streak = failNote.famCount;
              toolResult._hint = `${toolResult._hint ? toolResult._hint + ' ' : ''}⚠ This is failure #${failNote.famCount} of ${tc.function.name} with the same error this turn. Identical retries are BLOCKED. Change the failing part based on the exact error above (e.g. simplify the expression to the supported grammar, or test with dry_run). If you cannot fix it now, STOP calling ${tc.function.name}: give the user a final answer listing what succeeded (names + IDs), what failed with this exact error, and your recommended next step.`;
            } else if (!failNote) {
              // Success — unlocks ONE identical retry for previously failed
              // calls (a prerequisite may have just been fixed).
              dhis2.toolSuccessCount = (dhis2.toolSuccessCount || 0) + 1;
              // Reset the cumulative HTTP-error counter so it measures
              // CONSECUTIVE failures (its documented intent), not lifetime
              // ones. A long legitimate build — e.g. creating an OU hierarchy
              // then an option set on a fresh instance — interleaves recoverable
              // 4xx/409s (wrong order, name-collision probes) with real
              // successes; the old cumulative count hit the hard-stop mid-build
              // even though progress was being made. The identical-call and
              // same-error-family guards still bound genuine retry loops.
              dhis2.httpErrorCount = 0;
              dhis2.httpErrorHistory = [];
            }
          }
        }

        // Compute summary for panel display
        let summary = '?';
        let apiPath = toolResult._apiPath || null;
        if (toolResult._tool_manual) {
          summary = 'Loaded usage manual — validating the call against it';
        } else if (toolResult._tool_disabled_this_turn) {
          summary = `Stopped retrying ${toolResult._tool_disabled_this_turn} — it failed repeatedly with the same error and is disabled for the rest of this turn`;
        } else if (toolResult._error) {
          // Show the full error sentence in the inline summary (was 80 chars,
          // which truncated mid-message). The expandable details panel below
          // carries the structured _hint / _scope / _origin_server / _refused.
          summary = String(toolResult._error);
        } else if (toolResult._idempotent_replay) {
          summary = toolResult._idempotent_message || 'Already created earlier this turn — replayed previous success.';
        } else if (tc.function.name === 'count_records') {
          summary = `${toolResult.count} ${toolResult.record_type}`;
        } else if (tc.function.name === 'get_program_info') {
          summary = toolResult.total_rules != null ? `${toolResult.total_rules} rules`
            : toolResult.total_indicators != null ? `${toolResult.total_indicators} indicators`
            : 'Done';
        } else if (tc.function.name === 'get_program_recent_changes') {
          summary = `${toolResult.summary?.total_changes ?? toolResult.changes?.length ?? 0} changes`;
        } else if (tc.function.name === 'get_event_analytics') {
          summary = toolResult.height != null ? `${toolResult.height} rows` : `${toolResult.rows?.length || '?'} rows`;
        } else if (tc.function.name === 'render_chart') {
          summary = 'Chart rendered';
        } else if (tc.function.name === 'dhis2_query') {
          const r = toolResult;
          if (r._trackerSummary) {
            const s = r._trackerSummary;
            const verb = s.mode === 'dry_run' ? 'Dry run' : 'Tracker write';
            summary = `${verb}: ${s.created} created, ${s.updated} updated, ${s.deleted} deleted, ${s.ignored} ignored`;
          } else {
            summary = String(
              r._pagerInfo?.total
              ?? r.trackedEntities?.length ?? r._totalEntities
              ?? r.events?.length
              ?? r.instances?.length ?? r._totalInstances
              ?? r.height ?? r.rows?.length
              ?? r.programs?.length ?? r.organisationUnits?.length
              ?? r.programRules?.length ?? r._totalRules
              ?? r.dataElements?.length ?? r.indicators?.length
              ?? '?'
            ) + ' results';
          }
        } else if (tc.function.name === 'cross_stage_entity_intersection') {
          summary = `${toolResult.count ?? 0} matched`;
        } else if (tc.function.name === 'search_metadata') {
          const key = Object.keys(toolResult).find(k => Array.isArray(toolResult[k]));
          summary = key ? `${toolResult[key].length} found` : 'Done';
        } else if (tc.function.name === 'resolve_option_codes') {
          const counts = [];
          if (toolResult.options) counts.push(`${Object.keys(toolResult.options).length} codes`);
          if (toolResult.dataElements) counts.push(`${Object.keys(toolResult.dataElements).length} elements`);
          if (toolResult.orgUnits) counts.push(`${Object.keys(toolResult.orgUnits).length} org units`);
          summary = counts.length ? counts.join(', ') + ' resolved' : 'Done';
        } else if (tc.function.name === 'detect_enrollment_abnormalities') {
          summary = `${toolResult.totals?.abnormalities_detected ?? 0} abnormal`;
        } else if (tc.function.name === 'line_listing_guide') {
          summary = `${toolResult.block_ids?.length || 0} blocks`;
        } else if (tc.function.name === 'get_visualization_details') {
          const t = toolResult.visualization?.type ? ` (${toolResult.visualization.type})` : '';
          summary = `${toolResult.visualization?.name || 'Visualization'}${t}`;
        } else if (tc.function.name === 'browse_web') {
          summary = `${toolResult.total_results ?? toolResult.results?.length ?? 0} sources`;
        } else if (tc.function.name === 'create_metadata') {
          if (toolResult._error || toolResult.success === false) {
            summary = toolResult._error || toolResult.errors?.[0] || 'Failed';
          } else if (toolResult.phase === 'dry_run') {
            summary = `Validation passed (dry run) — ${toolResult.stats?.total || '?'} objects`;
          } else {
            const s = toolResult.stats || {};
            const parts = [];
            if (s.created) parts.push(`${s.created} created`);
            if (s.updated) parts.push(`${s.updated} updated`);
            summary = parts.length ? parts.join(', ') : `Import OK`;
            if (toolResult.summary?.program?.name) summary += ` — ${toolResult.summary.program.name}`;
            // Surface skipped rules so the user sees the program imported but N
            // rules still need adding (rather than a silent partial success).
            const skipN = toolResult._skipped_rules?.length || toolResult.summary?.skipped_rules?.length || 0;
            if (skipN) summary += ` (${skipN} rule${skipN > 1 ? 's' : ''} skipped — need follow-up)`;
          }
        } else if (tc.function.name === 'architect_metadata') {
          if (toolResult._error) {
            summary = toolResult._error.slice(0, 80);
          } else if (toolResult.verification_results) {
            const verified = toolResult.verification_results.filter(r => r.status?.includes('VERIFIED')).length;
            const total = toolResult.verification_results.length;
            summary = `${verified}/${total} verified`;
          } else if (toolResult.found != null) {
            summary = `${toolResult.found} existing ${toolResult.object_type || 'objects'} found`;
          } else if (toolResult.schema_type) {
            summary = `Schema: ${toolResult.schema_type} (${toolResult.required_fields?.length || 0} required fields)`;
          } else if (toolResult.program?.name) {
            summary = `Inspected: ${toolResult.program.name} (${toolResult.stages?.length || 0} stages)`;
          } else if (toolResult.results) {
            summary = `${toolResult.results.length} docs found`;
          } else {
            summary = 'Done';
          }
        } else if (tc.function.name === 'get_map_details') {
          summary = toolResult._error
            ? toolResult._error.slice(0, 80)
            : `${toolResult.map?.name || 'Map'} (${toolResult.layers?.length || 0} layers)`;
        } else if (tc.function.name === 'manage_program_rules') {
          if (toolResult._error) {
            summary = toolResult._error.slice(0, 80);
          } else if (toolResult.programRules || toolResult.rules) {
            const r = toolResult.programRules || toolResult.rules;
            summary = `${r.length} rules (${toolResult.total_rules ?? r.length} total)`;
          } else {
            summary = 'Done';
          }
        } else if (tc.function.name === 'manage_program_indicators') {
          if (toolResult._error) {
            summary = toolResult._error.slice(0, 80);
          } else if (toolResult.indicators) {
            summary = `${toolResult.indicators.length} indicators`;
          } else if (toolResult.issues) {
            summary = `${toolResult.issues.length} issues found`;
          } else {
            summary = 'Done';
          }
        } else if (tc.function.name === 'manage_metadata') {
          if (toolResult._error) {
            summary = toolResult._error.slice(0, 80);
          } else if (toolResult.deleted) {
            summary = `Deleted ${toolResult.object_type || 'object'}`;
          } else if (toolResult.removed) {
            summary = `Removed ${toolResult.removed} element(s)`;
          } else {
            summary = 'Done';
          }
        } else {
          summary = 'Done';
        }

        lastToolName = tc.function.name;
        const isToolSuccess = !toolResult._error && toolResult.success !== false;
        // Build a structured details payload so the panel can show the user
        // EXACTLY why a call failed (full _error sentence, _hint, _scope,
        // _origin_server, refused descriptor, history) instead of just an
        // 80-char headline. On success this is null so the UI stays compact.
        const details = isToolSuccess ? null : {
          error: toolResult._error || toolResult.errors?.[0] || null,
          hint: toolResult._hint || null,
          scope: toolResult._scope || null,
          originServer: toolResult._origin_server || null,
          refused: toolResult._refused || null,
          history: toolResult._history || null,
          existingId: toolResult.existing_program_id || null,
          unresolved: toolResult.unresolved || null,
          rawErrors: Array.isArray(toolResult.errors) ? toolResult.errors.slice(0, 10) : null,
          status: toolResult.status || toolResult.response?.status || null,
          httpStatus: toolResult._httpStatus || null,
        };
        broadcast({
          type: 'AI_TOOL_DONE',
          tool: tc.function.name,
          success: isToolSuccess,
          summary,
          apiPath,
          details,
        });

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult),
        });
      }
    } else {
      // Final text response (already streamed to UI if streaming was active)
      const text = msg.content || '';

      // If content is empty (e.g., think block stripped) and nothing streamed,
      // nudge the model to produce a real response or tool call.
      if (!text.trim() && !streamStartBroadcast) {
        emptyResponseCount++;
        if (emptyResponseCount >= 3) {
          // Too many empty responses — bail out with a helpful message
          const fallback = 'I was unable to produce a response. Please try rephrasing your question.';
          broadcast({ type: 'AI_STREAM_START' });
          broadcast({ type: 'AI_STREAM_END', text: fallback });
          // Persist the full action trail for this turn (tool calls + results),
          // then the fallback as the assistant's closing message, so the next
          // turn still remembers what was done before the empty-response bail.
          const turnHist = buildTurnHistory(messages, turnStartIdx, historyText)
            .filter(m => !(m.role === 'assistant' && !m.tool_calls && !(m.content && String(m.content).trim())));
          turnHist.push({ role: 'assistant', content: fallback });
          // Drop this turn if the thread was reset while it was running.
          if (turnEpoch !== conversationEpoch) return { text: '', charts, streamed: false, aborted: true };
          conversationHistory.push(...turnHist);
          conversationHistory = trimConversationHistory(conversationHistory);
          saveState();
          return { text: fallback, charts, streamed: true };
        }
        const nudge = emptyResponseCount >= 2
          ? 'You must produce a tool call OR a direct text answer right now. Do not reason internally — output your response immediately.'
          : 'Your previous response was empty. Call the appropriate tool NOW or answer directly. Do NOT describe your plan.';
        messages.push({ role: 'system', content: nudge });
        continue;
      }

      // Reset counter on any real content
      emptyResponseCount = 0;

      if (streamStartBroadcast) {
        broadcast({ type: 'AI_STREAM_END', text });
      }
      // Persist the WHOLE structured turn — the user message plus every
      // assistant tool_call and tool result the loop produced (the final
      // assistant text message was already pushed onto `messages` at the top of
      // this iteration, so it is included). This is what gives the model real
      // memory of the API calls it made and the IDs it created on later turns,
      // instead of forcing it to re-read its own summary prose.
      const turnHist = buildTurnHistory(messages, turnStartIdx, historyText);
      // Drop this turn if the thread was reset while it was running — pushing it
      // now would re-seed the new thread with the old task.
      if (turnEpoch !== conversationEpoch) return { text: '', charts, streamed: false, aborted: true };
      conversationHistory.push(...turnHist);
      conversationHistory = trimConversationHistory(conversationHistory);

      lastInteraction = { question: userText, apiCalls: apiCallsLog, answer: text };
      saveState();
      return { text, charts, streamed: streamStartBroadcast };
    }
  }

  // Iteration budget exhausted. Instead of the dead-end "Reached maximum
  // iterations" error (disastrous after a long build — the user gets no record
  // of what WAS created), force ONE final tool-free completion so the model
  // summarizes what succeeded (names + IDs), what failed (exact errors), and
  // what to do next. The system nudge is transient — buildTurnHistory drops it.
  try {
    messages.push({
      role: 'system',
      content:
        'TOOL BUDGET EXHAUSTED — you cannot make any more tool calls this turn. ' +
        'Write your final answer to the user NOW, in plain language: ' +
        '(1) what completed successfully this turn (object names + IDs), ' +
        '(2) what failed — quote the exact error message(s), ' +
        '(3) the most likely cause and one concrete recommended next step. ' +
        'Do not promise to retry and do not output tool calls.',
    });
    broadcast({ type: 'AI_THINKING', iteration: 50, label: 'Summarizing results' });
    let finalStreamStarted = false;
    let finalBuf = '';
    let finalTimer = null;
    const flushFinal = () => {
      finalTimer = null;
      if (finalBuf) { broadcast({ type: 'AI_STREAM_CHUNK', text: finalBuf }); finalBuf = ''; }
    };
    const finalResult = await callProviderStreaming(messages, false, (chunk) => {
      if (chunk === null) {
        broadcast({ type: 'AI_STREAM_START' });
        finalStreamStarted = true;
      } else if (finalStreamStarted) {
        finalBuf += chunk;
        if (!finalTimer) finalTimer = setTimeout(flushFinal, 40);
      }
    }, [], 49);
    if (finalTimer) { clearTimeout(finalTimer); finalTimer = null; }
    if (finalBuf) { broadcast({ type: 'AI_STREAM_CHUNK', text: finalBuf }); finalBuf = ''; }
    const finalText = finalResult?.choices?.[0]?.message?.content || '';
    if (finalText.trim()) {
      messages.push({ role: 'assistant', content: finalText });
      if (finalStreamStarted) broadcast({ type: 'AI_STREAM_END', text: finalText });
      const turnHist = buildTurnHistory(messages, turnStartIdx, historyText);
      // Drop this turn if the thread was reset while it was running — pushing it
      // now would re-seed the new thread with the old task.
      if (turnEpoch !== conversationEpoch) return { text: '', charts, streamed: false, aborted: true };
      conversationHistory.push(...turnHist);
      conversationHistory = trimConversationHistory(conversationHistory);
      lastInteraction = { question: userText, apiCalls: apiCallsLog, answer: finalText };
      saveState();
      return { text: finalText, charts, streamed: finalStreamStarted };
    }
  } catch (e) {
    console.warn('[AgenticLoop] budget-exhaustion summary failed:', e?.message || e);
  }

  // Fallback: persist the action trail so the next turn still remembers the
  // tool calls/IDs from this turn, then return the generic message.
  try {
    const turnHist = buildTurnHistory(messages, turnStartIdx, historyText);
    if (turnHist.length) {
      // Drop this turn if the thread was reset while it was running — pushing it
      // now would re-seed the new thread with the old task.
      if (turnEpoch !== conversationEpoch) return { text: '', charts, streamed: false, aborted: true };
      conversationHistory.push(...turnHist);
      conversationHistory = trimConversationHistory(conversationHistory);
      saveState();
    }
  } catch {}
  return { text: 'Reached maximum iterations — I could not finish this request. The action log above shows what completed (✓) and what failed (✗).', charts };
}

// ── Image Cropping (OffscreenCanvas in service worker) ───────────────────────

async function cropImage(dataUrl, x, y, w, h, dpr) {
  // Fetch the image as a blob and use createImageBitmap to decode it
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  // Scale selection coordinates by device pixel ratio
  const sx = Math.round(x * dpr);
  const sy = Math.round(y * dpr);
  const sw = Math.round(w * dpr);
  const sh = Math.round(h * dpr);

  // Use OffscreenCanvas to crop
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageBitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  imageBitmap.close();

  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  return await blobToDataUrl(croppedBlob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    // In service worker, FileReader may not be available, so use Response + arrayBuffer
    blob.arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      resolve(`data:${blob.type};base64,${base64}`);
    });
  });
}

// ── Screenshot Selection (injected into page via chrome.scripting) ────────

function injectedScreenshotSelection() {
  const existing = document.getElementById('__dhis2_screenshot_overlay__');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = '__dhis2_screenshot_overlay__';
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    cursor: 'crosshair',
    background: 'rgba(0,0,0,0.18)',
    userSelect: 'none',
  });

  const tooltip = document.createElement('div');
  Object.assign(tooltip.style, {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(15,23,42,0.9)',
    color: '#fff',
    padding: '8px 18px',
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontWeight: '500',
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    zIndex: '2147483647',
    pointerEvents: 'none',
  });
  tooltip.textContent = 'Drag to select area \u2022 Esc to cancel';
  overlay.appendChild(tooltip);

  const selBox = document.createElement('div');
  Object.assign(selBox.style, {
    position: 'fixed',
    border: '2px solid #4f46e5',
    background: 'rgba(79,70,229,0.08)',
    borderRadius: '4px',
    display: 'none',
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  overlay.appendChild(selBox);

  let startX = 0, startY = 0, isDragging = false;

  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    isDragging = true;
    selBox.style.display = 'block';
    selBox.style.left = startX + 'px';
    selBox.style.top = startY + 'px';
    selBox.style.width = '0px';
    selBox.style.height = '0px';
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selBox.style.left = x + 'px';
    selBox.style.top = y + 'px';
    selBox.style.width = w + 'px';
    selBox.style.height = h + 'px';
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    overlay.remove();
    if (w < 10 || h < 10) return;
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'SCREENSHOT_AREA_SELECTED',
        payload: {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(w),
          height: Math.round(h),
          devicePixelRatio: window.devicePixelRatio || 1,
        },
      });
    }, 80);
  });

  const cancelHandler = (e) => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', cancelHandler);
    }
  };
  document.addEventListener('keydown', cancelHandler);

  document.body.appendChild(overlay);
}

// ── Broadcasting ─────────────────────────────────────────────────────────────

function broadcast(data) {
  chrome.runtime.sendMessage(data).catch(() => {});
}

// ── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension's content scripts and pages.
  // Reject anything with an external `sender.id` or an `externally_connectable` origin.
  if (sender.id !== chrome.runtime.id) return false;
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'DHIS2_CONTEXT_UPDATE': {
      const url = msg.payload?.url || sender.tab?.url;
      if (url) {
        initializeFromUrl(url).then(r => {
          broadcast({ type: 'CONTEXT_UPDATED', state: getSerializableState() });
          sendResponse(r);
        }).catch(e => sendResponse({ error: e.message }));
      }
      return true;
    }

    case 'DHIS2_STAGE_DETECTED': {
      // Content script detected the active stage (from URL hash or DOM observation)
      // Use hasUidShape (loose) — the stage ID comes from a DHIS2-served URL
      // and is further cross-checked against knownStages below.
      const detectedStageId = msg.payload?.stageId;
      if (detectedStageId && hasUidShape(detectedStageId)) {
        // Only update if different from current and it's a valid stage in the program
        const currentStageId = dhis2.pageContext?.stageId;
        if (detectedStageId !== currentStageId) {
          // Validate against known stages if program metadata is loaded
          const knownStages = dhis2.programMetadata?.programStages;
          if (!knownStages || knownStages.some(s => s.id === detectedStageId)) {
            if (!dhis2.pageContext) dhis2.pageContext = {};
            dhis2.pageContext.stageId = detectedStageId;
            console.log(`[StageDetect] Active stage updated: ${detectedStageId} (source: ${msg.payload?.source || 'unknown'})`);
            broadcast({ type: 'CONTEXT_UPDATED', state: getSerializableState() });
          }
        }
      }
      sendResponse({ success: true });
      return true;
    }

    case 'INITIALIZE': {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (tabs[0]?.url) {
          try {
            const r = await initializeFromUrl(tabs[0].url);
            sendResponse(r);
          } catch (e) { sendResponse({ error: e.message }); }
        } else {
          sendResponse({ error: 'No active tab found' });
        }
      });
      return true;
    }

    case 'GET_STATE': {
      sendResponse({ state: getSerializableState() });
      return true;
    }

    case 'AGENT_STATUS': {
      // Liveness probe from the side panel's watchdog. `busy` distinguishes a
      // worker that is still mid-task (keepalive held) from one that Chrome
      // restarted and lost the in-flight request (refs reset to 0 on restart).
      sendResponse({ alive: true, busy: swKeepaliveRefs > 0 });
      return true;
    }

    case 'CHAT_MESSAGE': {
      sendResponse({ status: 'processing' });
      (async () => {
        await ensureConnected();
        // Re-extract context from current tab for SPA navigation
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.url && dhis2.baseUrl) {
            const freshBaseUrl = extractBaseUrl(tab.url);
            const freshCtx = extractContext(tab.url);
            const oldProgramId = dhis2.pageContext?.programId;
            const oldOrgUnitId = dhis2.pageContext?.orgUnitId;
            const oldAppType = dhis2.pageContext?.appType;
            const oldStageId = dhis2.pageContext?.stageId;
            const oldVisualizationId = dhis2.pageContext?.visualizationId;
            const oldMapId = dhis2.pageContext?.mapId;

            // Rebuild pageContext from the current URL instead of merging onto stale state.
            // Preserve a DOM-detected stage only when staying in the same tracker program.
            dhis2.pageContext = { ...freshCtx };
            if (!freshCtx.stageId && freshCtx.programId && freshCtx.programId === oldProgramId && oldStageId) {
              dhis2.pageContext.stageId = oldStageId;
            }

            // Re-run full initialization whenever page type or top-level context changes.
            // This clears stale app-specific state when navigating away from Data Visualizer/Maps.
            // baseUrl mismatch must force a refresh — otherwise we'd keep talking to the
            // previous DHIS2 instance and tools would return that server's UIDs.
            const baseUrlChanged = !!(freshBaseUrl && freshBaseUrl !== dhis2.baseUrl);
            const needsFullRefresh =
              baseUrlChanged ||
              freshCtx.appType !== oldAppType ||
              freshCtx.programId !== oldProgramId ||
              freshCtx.visualizationId !== oldVisualizationId ||
              freshCtx.mapId !== oldMapId ||
              (!freshCtx.programId && !!oldProgramId);

            if (needsFullRefresh) {
              await initializeFromUrl(tab.url);
            } else if (freshCtx.orgUnitId && freshCtx.orgUnitId !== oldOrgUnitId) {
              try {
                dhis2.ouContext = await dhis2Fetch(apiUrl(
                  `organisationUnits/${freshCtx.orgUnitId}?fields=id,displayName,code,path,level,ancestors[id,displayName,level],children[id,displayName]`
                ));
                await getMaxOuLevel();
                rememberFacilityOu(dhis2.ouContext);
                await saveState();
              } catch {}
            } else if (!freshCtx.orgUnitId && oldOrgUnitId) {
              dhis2.ouContext = null;
              await saveState();
            }
          }
        } catch {}
        return runAgenticLoop(msg.payload.text, msg.payload.imageBase64, !!msg.payload.browseWeb, !!msg.payload.inspect);
      })()
        .then(r => {
          // If response was already streamed, only send AI_RESPONSE for non-text cleanup (charts, state reset)
          broadcast({ type: 'AI_RESPONSE', text: r.streamed ? null : r.text, charts: r.charts, streamed: !!r.streamed });
        })
        .catch(e => broadcast({ type: 'AI_ERROR', error: e.message }));
      return true;
    }

    case 'SAVE_API_KEY': {
      const rawKey = msg.payload?.key;
      if (rawKey != null && typeof rawKey !== 'string') {
        sendResponse({ error: 'Invalid API key: must be a string.' });
        return true;
      }
      // Strip control chars and cap length so a paste accident can't bloat storage.
      const cleaned = sanitizeHeaderValue(rawKey || '') || '';
      chrome.storage.local.set({ fireworksApiKey: cleaned })
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'SAVE_TAVILY_API_KEY': {
      const rawKey = msg.payload?.key;
      if (rawKey != null && typeof rawKey !== 'string') {
        sendResponse({ error: 'Invalid Tavily key: must be a string.' });
        return true;
      }
      const cleaned = sanitizeHeaderValue(rawKey || '') || '';
      chrome.storage.local.set({ tavilyApiKey: cleaned })
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'GET_API_KEY': {
      chrome.storage.local.get(['fireworksApiKey'])
        .then(d => sendResponse({ key: d.fireworksApiKey || '' }))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'GET_TAVILY_API_KEY': {
      chrome.storage.local.get(['tavilyApiKey'])
        .then(d => sendResponse({ key: d.tavilyApiKey || '' }))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'SAVE_PROVIDER_CONFIG': {
      const newCfg = msg.payload?.config;
      if (!newCfg || typeof newCfg !== 'object' || Array.isArray(newCfg)) {
        sendResponse({ error: 'Invalid provider config' });
        return true;
      }
      // Validate URL fields. Reject anything that isn't http(s):// to prevent
      // javascript:, data:, file:, or non-URL gibberish from being persisted.
      if (newCfg.apiBaseUrl != null && newCfg.apiBaseUrl !== '' && !isValidProviderUrl(newCfg.apiBaseUrl)) {
        sendResponse({ error: 'API Base URL must be a valid http(s) URL.' });
        return true;
      }
      if (newCfg.visionApiBaseUrl != null && newCfg.visionApiBaseUrl !== '' && !isValidProviderUrl(newCfg.visionApiBaseUrl)) {
        sendResponse({ error: 'Vision API Base URL must be a valid http(s) URL.' });
        return true;
      }
      // Validate providerType against the known set.
      const ALLOWED_PROVIDERS = new Set([
        'ollama', 'fireworks', 'openai', 'anthropic', 'google',
        'openrouter', 'together', 'groq', 'grok', 'custom',
      ]);
      if (newCfg.providerType && !ALLOWED_PROVIDERS.has(newCfg.providerType)) {
        sendResponse({ error: `Unknown providerType: ${newCfg.providerType}` });
        return true;
      }
      // Numeric clamps so the model can't be poked with absurd values.
      if (newCfg.maxTokens != null) {
        const n = Number(newCfg.maxTokens);
        if (!Number.isFinite(n) || n < 256 || n > 200_000) {
          sendResponse({ error: 'maxTokens must be between 256 and 200000.' });
          return true;
        }
        newCfg.maxTokens = Math.floor(n);
      }
      if (newCfg.temperature != null) {
        const t = Number(newCfg.temperature);
        if (!Number.isFinite(t) || t < 0 || t > 2) {
          sendResponse({ error: 'temperature must be between 0 and 2.' });
          return true;
        }
        newCfg.temperature = t;
      }
      // Cap string fields so storage stays sane.
      const capStr = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s);
      newCfg.apiBaseUrl = capStr(newCfg.apiBaseUrl, 2048);
      newCfg.visionApiBaseUrl = capStr(newCfg.visionApiBaseUrl, 2048);
      newCfg.modelId = capStr(newCfg.modelId, 256);
      newCfg.visionModelId = capStr(newCfg.visionModelId, 256);
      newCfg.modelLabel = capStr(newCfg.modelLabel, 128);

      // Merge with defaults so partial updates work
      const merged = { ...DEFAULT_PROVIDER_CONFIG, ...newCfg };
      _cachedProviderConfig = merged;
      chrome.storage.local.set({ providerConfig: merged })
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'GET_PROVIDER_CONFIG': {
      chrome.storage.local.get(['providerConfig'])
        .then(d => sendResponse({
          config: { ...DEFAULT_PROVIDER_CONFIG, ...(d.providerConfig || {}) },
        }))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'CLEAR_HISTORY': {
      // Full new-thread reset: conversation memory + prefetch + task-specific
      // cached context. Sent by the "+" button AND automatically on every fresh
      // side-panel open, so a new thread never inherits the old task.
      clearConversationState()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'STORE_FEEDBACK': {
      const fb = msg.payload;
      storeFeedback(
        fb.type,
        fb.question || lastInteraction.question,
        fb.apiCalls || lastInteraction.apiCalls,
        fb.answer || lastInteraction.answer,
        fb.comment || ''
      ).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'START_SCREENSHOT_CAPTURE': {
      // Inject screenshot selection overlay directly via scripting API (works on any page)
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (!tabs[0]?.id) return;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: injectedScreenshotSelection,
          });
        } catch (e) {
          broadcast({ type: 'AI_ERROR', error: 'Cannot capture this page. Try on a regular web page.' });
        }
      });
      sendResponse({ ok: true });
      return true;
    }

    case 'SCREENSHOT_AREA_SELECTED': {
      // Capture the visible tab, then crop to the selected area
      const { x, y, width, height, devicePixelRatio } = msg.payload;
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (!tabs[0]?.id) { sendResponse({ error: 'No active tab' }); return; }
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
          // Crop the captured image to the selected region
          const cropped = await cropImage(dataUrl, x, y, width, height, devicePixelRatio);
          // Send the cropped image back to the side panel
          broadcast({ type: 'SCREENSHOT_RESULT', dataUrl: cropped });
          sendResponse({ ok: true });
        } catch (e) {
          broadcast({ type: 'AI_ERROR', error: 'Screenshot failed: ' + e.message });
          sendResponse({ error: e.message });
        }
      });
      return true;
    }

    case 'GET_FEEDBACK_LOG': {
      chrome.storage.local.get(['feedbackLog'])
        .then(d => sendResponse({ log: d.feedbackLog || [] }))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'GET_LAST_INTERACTION': {
      sendResponse(lastInteraction);
      return true;
    }
  }
});

// ── Extension Icon → Open Side Panel ─────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// ── Tab URL Change ───────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url && (tab.url.includes('/dhis-web-') || tab.url.includes('/apps/') || tab.url.includes('/api/'))) {
    initializeFromUrl(tab.url).then(() => {
      broadcast({ type: 'CONTEXT_UPDATED', state: getSerializableState() });
    }).catch(() => {});
  }
});

chrome.webNavigation?.onReferenceFragmentUpdated?.addListener?.((details) => {
  if (details.url && (details.url.includes('/dhis-web-') || details.url.includes('/apps/'))) {
    initializeFromUrl(details.url).then(() => {
      broadcast({ type: 'CONTEXT_UPDATED', state: getSerializableState() });
    }).catch(() => {});
  }
});

// Switching to a tab on a different DHIS2 instance must re-initialize the
// connection — without this, dhis2.baseUrl stays pinned to the previously
// focused server and tool calls hit the wrong instance (root cause of the
// "program already exists with id X" false-positive across servers).
async function syncFromTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return;
    const candidateBase = extractBaseUrl(tab.url);
    if (!candidateBase) return;
    if (candidateBase === dhis2.baseUrl && dhis2.connected) {
      // Same server — only refresh page context (cheap), don't re-fetch system info.
      const ctx = extractContext(tab.url);
      dhis2.pageContext = ctx;
      broadcast({ type: 'CONTEXT_UPDATED', state: getSerializableState() });
      return;
    }
    await initializeFromUrl(tab.url);
    broadcast({ type: 'CONTEXT_UPDATED', state: getSerializableState() });
  } catch {}
}

chrome.tabs.onActivated.addListener(({ tabId }) => { syncFromTab(tabId); });

chrome.windows?.onFocusChanged?.addListener?.(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id) syncFromTab(tab.id);
  } catch {}
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true });
  syncContentScriptsToGrantedOrigins();
});

chrome.runtime.onStartup?.addListener?.(() => {
  syncContentScriptsToGrantedOrigins();
});

// ── Runtime host permissions & dynamic content-script registration ───────────
// The extension no longer ships an <all_urls> host permission or a static
// <all_urls> content script. Instead the side panel asks the user (via a single
// Chrome prompt) to grant the SPECIFIC DHIS2 origin they are on. Once granted,
// the URL-monitoring content script (content.js) is registered ONLY for that
// origin, and the background's credentialed fetches to that server become
// privileged. Nothing runs on any site the user has not explicitly allowed.
const URL_MONITOR_SCRIPT_ID = 'dhis2-url-monitor';

function originFromPattern(pattern) {
  // "https://play.dhis2.org/*" → "https://play.dhis2.org"
  return String(pattern).replace(/\/\*$/, '').replace(/\/$/, '');
}

async function syncContentScriptsToGrantedOrigins() {
  try {
    const granted = await chrome.permissions.getAll();
    const matches = (granted.origins || []).filter(o => /^https?:\/\//i.test(o));
    const existing = await chrome.scripting
      .getRegisteredContentScripts({ ids: [URL_MONITOR_SCRIPT_ID] })
      .catch(() => []);

    if (!matches.length) {
      if (existing && existing.length) {
        await chrome.scripting.unregisterContentScripts({ ids: [URL_MONITOR_SCRIPT_ID] }).catch(() => {});
      }
      return;
    }

    const cfg = {
      id: URL_MONITOR_SCRIPT_ID,
      js: ['content.js'],
      matches,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    };
    if (existing && existing.length) {
      await chrome.scripting.updateContentScripts([cfg]);
    } else {
      await chrome.scripting.registerContentScripts([cfg]);
    }
  } catch (e) {
    console.warn('[perm] Failed to sync content scripts to granted origins:', e?.message || e);
  }
}

// registerContentScripts only injects on FUTURE navigations. The page the user
// is already looking at when they grant access won't have content.js yet, so
// inject it once into any already-open tab on the newly granted origin to match
// the previous always-on behaviour without forcing a reload.
async function injectMonitorIntoOpenTabs(originPatterns) {
  const origins = (originPatterns || []).map(originFromPattern).filter(Boolean);
  if (!origins.length) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id || !t.url) continue;
      let tabOrigin;
      try { tabOrigin = new URL(t.url).origin; } catch { continue; }
      if (!origins.includes(tabOrigin)) continue;
      chrome.scripting
        .executeScript({ target: { tabId: t.id }, files: ['content.js'] })
        .catch(() => {});
    }
  } catch {}
}

chrome.permissions.onAdded.addListener(async (perms) => {
  await syncContentScriptsToGrantedOrigins();
  if (perms?.origins?.length) await injectMonitorIntoOpenTabs(perms.origins);
});

chrome.permissions.onRemoved.addListener(() => {
  syncContentScriptsToGrantedOrigins();
});
