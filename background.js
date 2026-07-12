/* ══════════════════════════════════════════════════════════════════════════════
   DHIS2 AI Assistant — Background Service Worker (v2.9.0)
   Handles: DHIS2 detection, metadata, multi-provider LLM agentic loop, tool exec
   ══════════════════════════════════════════════════════════════════════════════ */

importScripts('background/core.js', 'shared/tool-catalog.js');

const {
  contextIdentityChanged,
  extractDhis2IdFromInput,
  extractDhis2IdFromText,
  getChatCompletionsUrl: buildChatCompletionsUrl,
  hasUidShape,
  isLikelyDhisUid,
  isLocalProviderUrl,
  isValidProviderUrl,
  normalizePlainText,
  normalizeSearchText,
  sanitizeHeaderValue,
  stableStringify,
} = globalThis.Dhis2AiCore;
const TOOL_PRESENTATION = globalThis.Dhis2ToolCatalog;

// ── Universal Model Provider ─────────────────────────────────────────────────
// Default: Ollama (local, no API key, fully offline). Also supports any
// OpenAI-compatible cloud provider (Fireworks, OpenAI, Anthropic, Google,
// OpenRouter, Together, Groq, custom) via the same configurable fields:
//   - providerType: routing hint (anthropic uses /v1/messages; others share OAI path)
//   - apiBaseUrl:   e.g. http://localhost:11434/v1 (Ollama)
//                        https://api.openai.com/v1
//                        https://api.anthropic.com
//   - modelId:      provider-specific identifier
//   - maxTokens, temperature, hasThinkBlock (optional)
// Vision model is separately configurable for image analysis.

const DEFAULT_PROVIDER_CONFIG = {
  // ollama|fireworks|openai|anthropic|google|openrouter|together|groq|custom
  providerType: 'ollama',
  apiBaseUrl: 'http://localhost:11434/v1',
  modelId: 'llama3.2',
  modelLabel: 'Llama 3.2 (Ollama)',
  maxTokens: 16384,
  temperature: 0.2,
  hasThinkBlock: false,
  // Vision model (optional — leave empty to skip vision and pass image directly)
  visionApiBaseUrl: '',   // defaults to same as apiBaseUrl if empty
  visionModelId: '',
};

function isLocalProvider(cfg) {
  if (!cfg) return false;
  if (cfg.providerType === 'ollama') return true;
  return isLocalProviderUrl(cfg.apiBaseUrl);
}

let _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG };
let _cachedApiKey = null;

function getProviderConfig() {
  return _cachedProviderConfig;
}

function getChatCompletionsUrl(baseUrl) {
  return buildChatCompletionsUrl(baseUrl, DEFAULT_PROVIDER_CONFIG.apiBaseUrl);
}

// Load cached settings at startup
chrome.storage.local.get(['providerConfig', 'fireworksApiKey']).then(d => {
  if (d.providerConfig) {
    _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, ...d.providerConfig };
  }
  if (d.fireworksApiKey) _cachedApiKey = sanitizeHeaderValue(d.fireworksApiKey);
});

// Keep caches in sync whenever settings change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.providerConfig?.newValue) {
    _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, ...changes.providerConfig.newValue };
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'fireworksApiKey')) {
    _cachedApiKey = sanitizeHeaderValue(changes.fireworksApiKey.newValue) || null;
  }
});
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const LINE_LISTING_JSON_PATH = 'line-listing/dhis2_linelisting_tool.json';
const LINE_LISTING_SYSTEM_PROMPT_PATH = 'line-listing/dhis2_chrome_extension_system_prompt.md';

// ── State ────────────────────────────────────────────────────────────────────

let dhis2 = {
  baseUrl: null,
  apiVersion: null,
  systemInfo: null,
  pageContext: {},
  programMetadata: null,
  programRulesCount: null,
  ouContext: null,
  visualizationContext: null,
  mapContext: null,
  ouMaxLevel: null,
  lastFacilityOu: null,
  metadataAuditSupport: null,
  connected: false,
};

let conversationHistory = [];
let prefetchedIds = { viz: null, map: null };
let lastUserText = '';
// Set true once a NEW_THREAD/CLEAR_HISTORY reset has run in this service-worker
// lifetime. The async state-restoration IIFE (which rehydrates chatHistory from
// session storage on a cold start) checks this so a reset that races the
// restore can never resurrect the previous thread's conversation. See the
// restoration block and the CLEAR_HISTORY handler.
let historyExplicitlyCleared = false;
// Bumped on every new-thread reset. The agentic loop captures the epoch when a
// turn starts and refuses to write that turn back into conversationHistory if
// the epoch changed meanwhile — i.e. the thread was reset (panel reopened / "+"
// clicked) while a generation from the OLD thread was still finishing. Without
// this, a straggling turn would re-seed the freshly-cleared history with the
// old task.
let conversationEpoch = 0;
let lineListingAssets = {
  loaded: false,
  systemPromptMd: '',
  toolJson: null,
};

// ── Write-authorization gate ────────────────────────────────────────────────
// Classifies the user's most recent message into a write-authorization scope.
// Destructive tool branches consult this BEFORE acting. The default is
// 'read_only' — better to ask and confirm than to silently modify metadata.
//
// scope values:
//   'broad'     — explicit write/fix/delete/yes — destructive actions allowed
//   'read_only' — diagnose / check / inspect / "I'm getting an error" — REFUSE writes
//
// Why this exists: the model has historically interpreted "I'm getting error X"
// as authorization to start fixing things. A problem report is NOT consent.
// The model must explicitly ask the user before any destructive op.
const WRITE_AUTH_BROAD_RE = new RegExp(
  '\\b(?:please\\s+)?(?:'
  + 'fix|fixes?|repair|patch|correct|update|modify|change|edit|rewrite|overwrite'
  + '|delete|remove|drop|destroy|wipe|prune|sweep|purge|cleanup|clean ?up'
  + '|create|build|make|set ?up|setup|add|insert'
  // Write verbs that used to be missing: "Set a custom form on the Quick Check
  // stage" was classified read_only (worse: the stage NAME "Quick Check"
  // matched the diagnostic regex) and the write was refused. Verified live
  // 2026-07-01. Ambiguous verbs (set/apply) only count in imperative form
  // (followed by an article/pronoun) so problem reports like "the value isn't
  // set" or "the rule doesn't apply" stay read_only. Deliberately NOT added:
  // save/write/import/register — they dominate problem reports ("the save
  // failed") and would weaken the gate.
  + '|set\\s+(?:a|an|the|this|that|it|up|new|custom|public|sharing)\\b|configure|apply\\s+(?:a|an|the|this|that|it)\\b'
  + '|install|uninstall|author|generate|translate|relabel'
  // Form/layout authoring verbs. "Design a custom form for this stage" is the
  // tool's OWN documented trigger phrase, yet was classified read_only and the
  // write refused (verified live 2026-07-03). Constrain the ambiguous ones
  // (design/customize/style/lay out) to imperative form — followed by an
  // article/pronoun — so a problem report like "the form design is broken" or
  // "the style is off" stays read_only. redesign is unambiguous → unconstrained.
  + '|design\\s+(?:a|an|the|this|that|it|new|custom)\\b|redesign|customi[sz]e\\s+(?:a|an|the|this|that|it|new)\\b'
  + '|style\\s+(?:a|an|the|this|that|it)\\b|lay\\s?out\\s+(?:a|an|the|this)\\b'
  + '|restore|revert|roll ?back|undo|link|unlink'
  + '|enable|disable|turn (?:on|off)|share|grant|revoke|merge|split|rename|migrate|swap|convert|attach|assign|unassign|detach'
  + '|approve|confirm|proceed|do it|do this|go ahead|just do it'
  + '|yes(?:,?\\s*(?:please|do it|go ahead|fix(?: it)?|update|delete|remove))?'
  + '|let\'?s? (?:fix|update|delete|remove|do)'
  + ')\\b',
  'i'
);
const WRITE_AUTH_DIAG_RE = new RegExp(
  '\\b(?:diagnose|check|inspect|investigate|debug|troubleshoot|review'
  + '|why(?:\\s+(?:am|is|are|do|does|did|can\'?t|won\'?t))?'
  + '|what(?:\'?s| is|\\s+the)?\\s+(?:wrong|issue|problem|error|cause|reason)'
  + '|tell me|explain|show|list|find|where|how come|root[ -]?cause|figure out|look into'
  + ')\\b',
  'i'
);
const WRITE_AUTH_PROBLEM_RE = new RegExp(
  '\\b(?:error|fail(?:ed|ing|ure)?|broken|not working|won\'?t (?:save|load|work|enroll|enrol)'
  + '|cannot|can\'?t (?:save|load|work|enroll|enrol)|stuck|issue|problem|bug|crash(?:ed|ing)?'
  + ')\\b',
  'i'
);
// Matches phrasings of "the save failed" / "error saving enrollment" etc.
// Used by getContextualTools and buildSystemPrompt to switch to diagnostic mode.
// Catches both orders: "error … save" AND "save … error".
const SAVE_ACTION_VERBS = '(?:save|saving|saved|enroll|enrolling|enrol|enrolling|register|registering|submit|submitting|update|updating|load|loading|fetch|fetching|create|creating)';
const SAVE_FAILURE_VERBS = '(?:error|fail(?:ed|ing|ure)?|won\'?t|cannot|can\'?t|stuck|broken|not\\s+working|doesn\'?t)';
const SAVE_FAILURE_RE = new RegExp(
  '\\b(?:'
  // Direct phrases
  + 'error\\s+saving|fail(?:ed|ing)?\\s+to\\s+save|can\'?t\\s+save|cannot\\s+save|won\'?t\\s+save|not\\s+saving|doesn\'?t\\s+save'
  + '|save\\s+(?:fails?|failed|error|issue|problem)'
  + '|enroll(?:ment)?\\s+(?:error|fails?|failed|won\'?t|cannot|can\'?t|not\\s+saving)'
  + '|409\\s+conflict|tracker\\s+(?:import|api)\\s+(?:error|fail|fails|failed)'
  // Either order: failure-verb near save-verb (within ~50 chars)
  + '|' + SAVE_FAILURE_VERBS + '.{0,50}\\b' + SAVE_ACTION_VERBS + '\\b'
  + '|' + SAVE_ACTION_VERBS + '.{0,50}' + SAVE_FAILURE_VERBS
  + ')',
  'i'
);

function classifyWriteAuthorization(userText) {
  const text = String(userText || '');
  // Turn bookkeeping lives here because this is the single per-turn entry
  // point shared by the agentic loop and the test harness. Guarded so the
  // function still works when `dhis2` isn't defined (unit tests).
  const D = (typeof dhis2 === 'object' && dhis2) ? dhis2 : {};
  D.turnCounter = (D.turnCounter || 0) + 1;
  // Negation guard, verb-targeted: a "don't" only neutralizes the verb it
  // directly precedes ("don't recreate them", "do not delete anything") — it
  // must NOT nuke a separate affirmative in the same message. "use these
  // attributes that are already there, don't recreate them, go ahead" IS
  // authorization (verified wrong refusal 2026-07-10, Child health scenario:
  // the old bare-"don't" guard read_only'd an explicit "go ahead"). Strip each
  // negated verb phrase, then look for a surviving write verb.
  const negStripped = text.replace(
    /\b(?:please\s+)?(?:don'?t|do\s+not|never)\s+(?:ever\s+|just\s+|simply\s+)?[\w-]+(?:\s+(?:it|them|this|that|these|those|anything))?/gi,
    ' '
  );
  const isBroad = WRITE_AUTH_BROAD_RE.test(negStripped);
  const isDiag = WRITE_AUTH_DIAG_RE.test(text);
  const isProblem = WRITE_AUTH_PROBLEM_RE.test(text);
  // Hard refusal: an explicit "no, …" decline always wins over any verb match.
  const isRefusal = /\bno(?:\s+thanks)?,?\s+(?:don'?t|do\s+not|leave|stop|just\s+(?:diagnose|check|explain|look))\b/i.test(text);
  if (isBroad && !isRefusal) {
    // A BARE affirmation ("yes", "go ahead") directly after a refused write is
    // an answer to THAT proposal — scope the authorization to the proposed
    // tool so it cannot be spent on an unrelated write (observed live: "yes"
    // meant for growth-chart configure spent on deleting a data element).
    const bareAffirm = /^\s*(?:please\s+)?(?:yes|yep|yeah|ok(?:ay)?|sure|confirm(?:ed)?|do\s+it|go\s+ahead(?:\s+and\s+(?:do|run)\s+it)?|proceed|go\s+for\s+it|run\s+it|yes,?\s*please)[.!\s]*$/i.test(text);
    const lrw = D.lastRefusedWrite;
    if (bareAffirm && lrw && lrw.tool && lrw.turn === D.turnCounter - 1) {
      return { scope: 'scoped', tool: lrw.tool, action: lrw.action, reason: `bare affirmation — authorization scoped to the write proposed last turn: ${lrw.tool}(${lrw.action})` };
    }
    return { scope: 'broad', reason: 'user message contains explicit write/fix verb (or affirmative response)' };
  }
  if (isDiag) return { scope: 'read_only', reason: 'user asked to diagnose/check/inspect — no fix authorization' };
  if (isProblem) return { scope: 'read_only', reason: 'user reported a problem — diagnose first, fix only after explicit "yes"' };
  return { scope: 'read_only', reason: 'no explicit write authorization detected — default to safe mode' };
}

// Returns null if the destructive action is allowed; else a structured refusal
// that the model can read on the next iteration.
//
// Scopes:
//   'broad'  — any gated write allowed this turn.
//   'scoped' — the user answered a proposal with a BARE affirmation ("yes",
//              "go ahead"): ONLY the tool that was refused/proposed last turn
//              may write. The first matching call widens the scope to broad
//              for the rest of the turn (legitimate follow-up writes of the
//              same plan). This exists because a bare "yes" was observed being
//              spent on manage_metadata(delete <data element>) when the user
//              had approved manage_growth_chart_plugin(configure) — verified
//              live 2026-07-10 on the growth-chart transcript.
//   'read_only' — refuse and RECORD the proposal so next turn's "yes" can be
//              scoped to it.
function requireWriteAuth(toolName, action, descriptor) {
  const wa = dhis2.writeAuth || {};
  const scope = wa.scope || 'read_only';
  if (scope === 'broad') {
    if (dhis2.lastRefusedWrite && dhis2.lastRefusedWrite.tool === toolName) dhis2.lastRefusedWrite = null;
    return null;
  }
  if (scope === 'scoped') {
    if (toolName === wa.tool) {
      dhis2.writeAuth = { scope: 'broad', reason: `scoped approval fulfilled by ${toolName}(${action}) — follow-up writes this turn allowed` };
      dhis2.lastRefusedWrite = null;
      return null;
    }
    return {
      _error: `Refused: the user's bare "yes" authorizes ONLY the write you proposed last turn — ${wa.tool}(${wa.action || 'the proposed action'}) — not ${toolName}(action=${action}).`,
      _hint: `Call ${wa.tool} NOW to do exactly what the user approved. Do NOT substitute a different tool, do NOT route the write through raw dhis2_query, and NEVER spend this approval on deletes/changes the user did not ask for. After the approved ${wa.tool} call succeeds, further writes this turn are allowed again.`,
      _refused: { tool: toolName, action, target: descriptor || null, approved_tool: wa.tool, approved_action: wa.action || null },
      _scope: 'requires_matching_tool',
    };
  }
  // read_only: remember exactly what was proposed-and-refused so a bare "yes"
  // on the next turn authorizes THIS call and nothing else.
  dhis2.lastRefusedWrite = { tool: toolName, action, turn: dhis2.turnCounter || 0 };
  return {
    _error: `Refused: ${toolName}(action=${action}) is a destructive write, but this conversation turn does not authorize it. Reason: ${wa.reason || 'no authorization detected'}. NOTE: the tool itself IS available and working — this is a per-turn authorization gate, NOT a missing tool. Never tell the user the tool does not exist, and never fall back to a different tool for the same write.`,
    _hint: 'Tell the user EXACTLY what change you propose: object name + ID + before → after. Then ASK for confirmation. The user must reply with explicit authorization on the NEXT turn (e.g. "yes", "go ahead", "fix it", "update X", "delete it") — then retry THIS SAME tool call, not a substitute. A problem report ("I am getting error X", "this is broken") is NOT authorization — it is a request for diagnosis.',
    _refused: { tool: toolName, action, target: descriptor || null },
    _scope: 'requires_user_confirmation',
  };
}

// Tracks consecutive 404s on destructive verify-before-modify lookups within a
// single agentic turn. After 2 in a row, every further destructive call returns
// a hard STOP. Reset at the start of every agentic loop.
function noteDestructive404(toolName, action, id) {
  dhis2.destructive404Count = (dhis2.destructive404Count || 0) + 1;
  dhis2.destructive404History = dhis2.destructive404History || [];
  dhis2.destructive404History.push({ tool: toolName, action, id });
}
function destructive404StopOrNull(toolName, action) {
  const n = dhis2.destructive404Count || 0;
  if (n < 2) return null;
  return {
    _error: `STOP: ${n} consecutive destructive ${toolName} lookups have hit 404 (target not found) in this turn. Further write attempts are blocked.`,
    _hint: 'The IDs being targeted do NOT exist in the current metadata. Prior conversation or external diagnostics may carry stale IDs from old/unrelated contexts — those are not proof of a current defect, and inventing "stale cache" explanations is hallucination. STOP modifying things. Show the user the 404 history and ask which CURRENT object (if any) should be acted on. Use manage_program_rules(action=list) / manage_program_indicators(action=list) to see what actually exists.',
    _scope: 'destructive_404_limit_reached',
    _history: (dhis2.destructive404History || []).slice(-5),
  };
}

// ── Per-turn known-IDs registry & verify-before-call gate ───────────────────
// EVERY API call must derive from verified data. The chatbot must never
// construct a path/UID from a guess. dhis2.knownIds is seeded each turn from
// (a) the user message, (b) page context, (c) already-loaded
// program/OU/viz/map metadata, and (d) the persisted conversation
// history — every UID the model can literally see in its context window
// (objects it created or read in PRIOR turns) counts as verified — and is
// extended by every tool result in the same turn.
//
// Pre-flight checks at the dispatch layer use this set to refuse calls that
// reference a UID not present anywhere in verified sources — that almost
// always means the model hallucinated.
const DHIS_UID_RE = /\b[a-zA-Z][a-zA-Z0-9]{10}\b/g;

function harvestUidsInto(set, value, depth = 0) {
  if (value == null || depth > 8) return;
  if (typeof value === 'string') {
    const matches = value.match(DHIS_UID_RE);
    if (matches) for (const m of matches) set.add(m);
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) harvestUidsInto(set, v, depth + 1); return; }
  for (const v of Object.values(value)) harvestUidsInto(set, v, depth + 1);
}

function seedKnownIds(userText, ctx) {
  const set = new Set();
  harvestUidsInto(set, userText);
  harvestUidsInto(set, ctx || {});
  harvestUidsInto(set, dhis2.programMetadata);
  harvestUidsInto(set, dhis2.ouContext);
  harvestUidsInto(set, dhis2.visualizationContext);
  harvestUidsInto(set, dhis2.mapContext);
  harvestUidsInto(set, dhis2.datasetContext);
  harvestUidsInto(set, dhis2.lastFacilityOu);
  // Cross-turn verified sources: the conversation history (assistant replies +
  // persisted tool results from PRIOR turns) is context the model legitimately
  // sees, so any UID in it was either user-supplied or returned by a tool.
  // Without this, an object the chatbot ITSELF created one turn ago gets
  // refused as "unknown UID" the next turn — forcing a pointless re-list (or
  // worse, teaching the model the object no longer exists).
  harvestUidsInto(set, conversationHistory);
  // System-level UIDs that always exist in DHIS2 instances — pre-add common ones.
  set.add('bjDvmb4bfuf'); // default categoryCombo / attributeCombo
  dhis2.knownIds = set;
  dhis2.knownIdsSeedSize = set.size;
}

function recordKnownIdsFromResult(result) {
  // instanceof (not truthy) — a session-restored Set arrives as a plain `{}`
  // (JSON.stringify drops Set contents). `!{}` is false, so a truthy guard
  // would skip the rebuild and the next `.add()` would throw.
  if (!(dhis2.knownIds instanceof Set)) dhis2.knownIds = new Set();
  harvestUidsInto(dhis2.knownIds, result);
  // Also harvest any verified icon keys that surfaced in the result so a later
  // update_style call against them passes the verify-before-write gate.
  if (!(dhis2.knownIcons instanceof Set)) dhis2.knownIcons = new Set();
  harvestIconKeysInto(dhis2.knownIcons, result);
}

// ── Per-turn known-icon-key registry ───────────────────────────────────────
// DHIS2 ships ~900 icons whose keys live in a fixed library. Models routinely
// fabricate plausible-but-nonexistent keys ("tuberculosis_positive",
// "diabetes_positive", "vaccine_outline") because they sound right. The first
// PATCH then 404s, which burns a tool round trip and (worse) trains the user
// to expect "discover, then act" as a multi-turn ritual.
//
// dhis2.knownIcons mirrors dhis2.knownIds: a Set of icon keys that have been
// PROVEN to exist in this turn — seeded from /icons?search= responses, from
// any object's `style.icon` field surfaced in tool results, and from the
// canonical-key path of a successful resolveDhis2IconKey() call. update_style
// refuses to apply an icon that isn't in this Set unless the resolver can
// prove it exists; the resolver, on success, also adds the key here so the
// next call hits the cheap path.
function harvestIconKeysInto(set, value, depth = 0) {
  if (value == null || depth > 8) return;
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) harvestIconKeysInto(set, v, depth + 1); return; }
  // Common shapes: /icons response = {icons:[{key,keywords:[...]}]},
  // metadata object = {style:{icon:"<key>",color:"#..."}},
  // discover_icons result = {results:{kw:[{key,keywords}]}}.
  if (typeof value.key === 'string' && /_(positive|negative|outline)$/i.test(value.key)) {
    set.add(value.key);
  }
  if (value.style && typeof value.style === 'object' && typeof value.style.icon === 'string' && value.style.icon) {
    set.add(value.style.icon);
  }
  for (const v of Object.values(value)) harvestIconKeysInto(set, v, depth + 1);
}

function seedKnownIcons() {
  // Fresh empty Set per turn — no static seeding (keys must be proven via API
  // discovery this turn to count as "known").
  dhis2.knownIcons = new Set();
}

// ── Per-turn recent-creations registry ─────────────────────────────────────
// Maps `<kind>:<lowercased_name>` → { id, kind, summary, createdAt } for every
// metadata object successfully created in this same turn. Lets the create-path
// collision probes detect "the model just retried the exact same create call
// it already succeeded with" and return an idempotent success rather than the
// confusing "name already exists" error against the row WE just wrote.
//
// Real cross-server collisions are unaffected — they have an id that isn't in
// this Map, so the probe still errors the way it always has.
function seedRecentCreations() {
  dhis2.recentCreations = new Map();
}

function recordRecentCreation(kind, name, id, summary) {
  if (!kind || !name || !id) return;
  if (!(dhis2.recentCreations instanceof Map)) dhis2.recentCreations = new Map();
  dhis2.recentCreations.set(`${kind}:${String(name).toLowerCase()}`, {
    kind, id, name, summary: summary || null, createdAt: Date.now(),
  });
}

function lookupRecentCreation(kind, name) {
  if (!kind || !name) return null;
  if (!(dhis2.recentCreations instanceof Map)) return null;
  return dhis2.recentCreations.get(`${kind}:${String(name).toLowerCase()}`) || null;
}

// DHIS2 field / query-parameter names that share the 11-char UID shape (a
// letter followed by 10 alphanumerics) but are NEVER object UIDs. Without this
// denylist the pre-flight guard mistakes a `fields=id,displayName` entry for a
// hallucinated UID and REFUSES legitimate discovery calls — fatal on a fresh,
// empty instance where the model must call discovery/create endpoints to build
// anything (observed live: `dhis2_query trackedEntityTypes?fields=id,displayName`
// refused with "unknown UID: displayName"). DHIS_UID_RE only matches exactly-11-
// char tokens, so this list only needs 11-char words.
const RESERVED_UID_SHAPED_WORDS = new Set([
  'displayName', 'lastUpdated', 'description', 'dataElement', 'accessLevel',
  'coordinates', 'phoneNumber', 'optionGroup', 'programRule', 'inheritable',
  'aggregation', 'completedBy', 'programName', 'trackedName',
]);

// Pulls UIDs out of every arg position that is operationally a target
// (path SEGMENTS, rule_id, indicator_id, object_id, stage_id, program_id,
// template_id, trackedEntity, enrollment, event, plus any string/array passed
// under those names). Returns the unique UIDs that appear.
//
// IMPORTANT: for `path` we scan ONLY the portion before `?` (the resource path
// segments), never the query string. Query strings carry field lists
// (fields=id,displayName), ordering, and paging whose tokens are field NAMES,
// not target UIDs — scanning them produced false "unknown UID" refusals that
// blocked every discovery call. A hallucinated UID that matters operationally
// appears as a path segment (/programs/<uid>) or an explicit *_id argument,
// both still scanned. A bad UID inside a filter self-corrects (empty result),
// so not scanning it is a safe trade for eliminating the false positives.
function extractUidsFromCallArgs(toolName, args) {
  const set = new Set();
  if (!args) return [...set];
  const addUids = (str) => {
    for (const m of String(str).match(DHIS_UID_RE) || []) {
      if (!RESERVED_UID_SHAPED_WORDS.has(m)) set.add(m);
    }
  };
  // Path UIDs: resource-path segments only (drop the query string).
  if (typeof args.path === 'string') {
    addUids(args.path.split('?')[0]);
  }
  const idKeys = [
    'rule_id', 'indicator_id', 'template_id', 'object_id', 'stage_id',
    'program_id', 'option_set_id', 'data_element_id', 'tei_attribute_id',
    'visualization_id', 'map_id', 'tei_id', 'enrollment_id', 'event_id',
    'replace_stage_id', 'with_stage_id', 'program_stage_id',
  ];
  for (const k of idKeys) {
    const v = args[k];
    if (typeof v === 'string') {
      addUids(v);
    } else if (Array.isArray(v)) {
      for (const x of v) if (typeof x === 'string') addUids(x);
    }
  }
  // Array fields that carry UIDs by name
  const arrayKeys = ['indicator_ids', 'rule_ids', 'object_ids', 'data_element_ids', 'org_unit_ids'];
  for (const k of arrayKeys) {
    const v = args[k];
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') addUids(x);
  }
  return [...set];
}

// ── Per-turn HTTP error counter ────────────────────────────────────────────
// After 3 consecutive 4xx errors in any turn, every further tool call is hard
// blocked. This stops the failure mode where the chatbot kept retrying calls
// against IDs/paths that did not exist (404s on rule lookups, etc.).
function noteHttpErrorFromResult(toolName, result) {
  if (!result || typeof result !== 'object') return;
  // Status comes from safeDhis2Fetch error envelopes (_status), nested error bodies,
  // or text-form _error like "DHIS2 API 404: ...".
  let status = Number(result._status) || 0;
  if (!status && typeof result._error === 'string') {
    const m = result._error.match(/\b(4\d\d|5\d\d)\b/);
    if (m) status = Number(m[1]);
  }
  if (status < 400) return;
  dhis2.httpErrorCount = (dhis2.httpErrorCount || 0) + 1;
  dhis2.httpErrorHistory = dhis2.httpErrorHistory || [];
  dhis2.httpErrorHistory.push({ tool: toolName, status, url: result._url || null, error: (result._error || '').slice(0, 160) });
}

function httpErrorStopOrNull(threshold = 3) {
  if ((dhis2.httpErrorCount || 0) < threshold) return null;
  return {
    _error: `STOP: ${dhis2.httpErrorCount} HTTP 4xx/5xx errors have occurred in this conversation turn. Further tool calls are blocked.`,
    _hint: 'You are calling endpoints / IDs that do not exist (or constraints you have not satisfied). STOP. Show the user the error history and ask which CURRENT object should be acted on. Every API call MUST derive from prior verified data — never construct a path from a guess. To recover: (a) call a discovery endpoint (search_metadata, manage_program_rules action=list, etc.) for the resource type you need, (b) pick a UID from THAT response, (c) only then make the next call.',
    _scope: 'http_error_limit_reached',
    _history: (dhis2.httpErrorHistory || []).slice(-6),
  };
}

// ── Per-turn repeated-failure guard ─────────────────────────────────────────
// The HTTP counter above only sees 4xx/5xx. Many deterministic failures come
// back as HTTP 200 with an error payload — e.g. the program-indicator
// /expression/description validator returns 200 + {status:"ERROR"} — so
// nothing stopped the model from re-sending the EXACT same failing call until
// the iteration budget was gone. This guard tracks every failed call by a
// stable signature of (tool, args):
//   • an identical call that already failed deterministically is refused on
//     the 2nd attempt (transient network-ish errors get one identical retry);
//   • the same tool+action failing with the same error FAMILY (args may
//     differ) escalates the returned _hint from failure #2 and hard-blocks the
//     operation after SAME_ERROR_FAMILY_LIMIT failures, instructing the model
//     to give the user a final answer instead of hammering the server.

const IDENTICAL_FAILURE_LIMIT = 1;   // deterministic error: block from the 2nd identical attempt
const IDENTICAL_TRANSIENT_LIMIT = 2; // transient error: allow ONE identical retry, block the 3rd
const SAME_ERROR_FAMILY_LIMIT = 4;   // same tool+action+error family, any args: hard block after 4

function failedCallSignature(toolName, args) {
  return `${toolName}|${stableStringify(args || {})}`;
}

// Extract the failure text from a tool result, or '' when the result is not a
// failure. Mirrors the loop's own success test (!_error && success !== false).
function toolFailureText(result) {
  if (!result || typeof result !== 'object') return '';
  if (result._tool_manual || result._idempotent_replay) return '';
  if (result._error) return String(result._error);
  if (result.success === false) {
    const e = Array.isArray(result.errors) && result.errors.length ? result.errors[0] : null;
    return String(e || result.message || 'Operation failed (success=false)');
  }
  return '';
}

// Transient errors (network blips, rate limits, 5xx) may legitimately succeed
// on an identical retry; everything else is treated as deterministic.
function isTransientToolError(text) {
  return /timed?\s?out|timeout|stall|network|failed to fetch|connection|socket|temporar|rate.?limit|too many requests|overloaded|busy|(^|\D)(429|500|502|503|504|529)(\D|$)/i
    .test(String(text || ''));
}

// Collapse an error message into a "family" key: same message modulo UIDs,
// numbers and whitespace. Lets us catch "same error, slightly different args".
function toolErrorFamily(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b[a-z][a-z0-9]{10}\b/gi, '<uid>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// Record a failed tool call. Returns { famCount, error } when the result was a
// failure (famCount = how many times this tool+action has failed with this
// error family this turn), or null for successes.
function noteToolFailure(toolName, args, result) {
  const errText = toolFailureText(result);
  if (!errText) return null;
  if (!(dhis2.failedCallSigs instanceof Map)) dhis2.failedCallSigs = new Map();
  if (!(dhis2.toolErrorFamilies instanceof Map)) dhis2.toolErrorFamilies = new Map();
  const sig = failedCallSignature(toolName, args);
  const entry = dhis2.failedCallSigs.get(sig) || { count: 0, blockedAttempts: 0 };
  entry.count++;
  entry.tool = toolName;
  entry.error = errText.slice(0, 300);
  entry.transient = isTransientToolError(errText);
  // Snapshot the success counter: if some OTHER call succeeds after this
  // failure (e.g. a missing prerequisite gets created), ONE identical retry
  // is allowed again — the environment may have changed.
  entry.successMark = dhis2.toolSuccessCount || 0;
  dhis2.failedCallSigs.set(sig, entry);
  const famKey = `${toolName}:${args?.action || ''}|${toolErrorFamily(errText)}`;
  const famCount = (dhis2.toolErrorFamilies.get(famKey) || 0) + 1;
  dhis2.toolErrorFamilies.set(famKey, famCount);
  return { famCount, error: entry.error };
}

// Pre-flight refusal for calls that are doomed to repeat a known failure.
function repeatedFailureStopOrNull(toolName, args) {
  if (dhis2.failedCallSigs instanceof Map && dhis2.failedCallSigs.size) {
    const prev = dhis2.failedCallSigs.get(failedCallSignature(toolName, args));
    if (prev) {
      // If a DIFFERENT call succeeded since this one last failed, the model may
      // have fixed a prerequisite (created the missing option set, verified a
      // UID, …) — allow ONE identical retry. A failed retry re-snapshots the
      // mark in noteToolFailure, so it re-blocks unless something new succeeds.
      if ((dhis2.toolSuccessCount || 0) > (prev.successMark ?? 0)) {
        prev.successMark = dhis2.toolSuccessCount || 0;
        return null;
      }
      const limit = prev.transient ? IDENTICAL_TRANSIENT_LIMIT : IDENTICAL_FAILURE_LIMIT;
      if (prev.count >= limit) {
        prev.blockedAttempts = (prev.blockedAttempts || 0) + 1;
        return {
          _error: `BLOCKED: this exact ${toolName} call already failed ${prev.count} time(s) this turn with: "${prev.error}". Identical retries are refused — the same input produces the same error.`,
          _hint: prev.blockedAttempts >= 2
            ? `You have re-sent this blocked call ${prev.blockedAttempts} times. STOP calling ${toolName} with these arguments. Give the user your final answer NOW: (1) what succeeded so far this turn (object names + IDs), (2) what failed and the exact error quoted above, (3) a corrected approach or one specific question for the user.`
            : `Read the error message and CHANGE the failing input before calling again — e.g. rewrite the rejected expression/filter using only the allowed grammar, use different verified UIDs, or test with dry_run. If you cannot determine a fix from the error, stop and report it to the user instead of retrying.`,
          _scope: 'repeated_identical_failure',
          _previous_error: prev.error,
          _identical_failures: prev.count,
        };
      }
    }
  }
  if (dhis2.toolErrorFamilies instanceof Map && dhis2.toolErrorFamilies.size) {
    const prefix = `${toolName}:${args?.action || ''}|`;
    let worst = 0;
    let worstFamily = null;
    for (const [k, n] of dhis2.toolErrorFamilies) {
      if (k.startsWith(prefix) && n > worst) { worst = n; worstFamily = k.slice(prefix.length); }
    }
    if (worst >= SAME_ERROR_FAMILY_LIMIT) {
      return {
        _error: `STOP: ${toolName}${args?.action ? `(action=${args.action})` : ''} has failed ${worst} times this turn with the same class of error ("${worstFamily}"). Further calls to this operation are blocked for this turn.`,
        _hint: `This error is not going away by resending variations of the same attempt. Give the user your final answer NOW: (1) list everything successfully created this turn (names + IDs), (2) quote the exact server error for what failed, (3) recommend one concrete next step (e.g. show the corrected expression you would try and ask the user to confirm, or suggest skipping the failing objects). Do NOT call ${toolName} again this turn.`,
        _scope: 'same_error_family_limit',
        _family_error: worstFamily,
        _family_failures: worst,
      };
    }
  }
  return null;
}

// Pre-flight check called before EVERY tool dispatch. Returns null when the
// call is safe to proceed; else returns a structured refusal.
function preflightCheckCall(toolName, args) {
  // Hard stop on cumulative HTTP errors — prevents runaway retry loops.
  const stop = httpErrorStopOrNull();
  if (stop) return stop;
  // Refuse calls that repeat a known failure (identical args that already
  // failed, or an operation stuck on the same error family). Applies to ALL
  // tools — validation errors arrive as HTTP 200 payloads, so the HTTP
  // counter above never sees them.
  const repeatStop = repeatedFailureStopOrNull(toolName, args);
  if (repeatStop) return repeatStop;
  // Skip UID validation when the seed set is empty (very first iteration with
  // no context) OR for read-only discovery tools whose job is to populate IDs.
  const DISCOVERY_TOOLS = new Set([
    'search_metadata', 'get_program_info', 'count_records', 'browse_web',
    'render_chart', 'manage_backups',
  ]);
  if (DISCOVERY_TOOLS.has(toolName)) return null;
  if (!dhis2.knownIds || dhis2.knownIds.size === 0) return null;
  const uids = extractUidsFromCallArgs(toolName, args);
  if (!uids.length) return null;
  const unknown = uids.filter(u => !dhis2.knownIds.has(u));
  if (!unknown.length) return null;
  return {
    _error: `Refused: ${toolName} called with UID(s) that have not appeared in any verified source: ${unknown.join(', ')}.`,
    _hint: 'Every API call must derive from verified data. The UID(s) above were not in: the user message, page context, the conversation history, or any prior tool result. Possible causes: (a) the UID is hallucinated — call a discovery tool first (search_metadata / list / get_program_info) to find the real UID, (b) the UID came from a stale source — verify it exists. Do NOT construct paths from guesses. IMPORTANT: this refusal is a client-side gate and says NOTHING about server state — never tell the user the object "is already gone", "was deleted", or "does not exist" based on this refusal.',
    _refused: { tool: toolName, unknown_uids: unknown },
    _known_id_count: dhis2.knownIds.size,
    _scope: 'unknown_uid_in_args',
  };
}

// Verify a target ID exists before modifying it. Used by update/delete branches.
// On 404, bumps the counter and returns the refusal payload (also returns the
// hard-STOP if the limit has been hit). Returns { exists: true, data } on success.
async function verifyTargetExists(resourcePath, id, toolName, action, fields) {
  const stop = destructive404StopOrNull(toolName, action);
  if (stop) return { exists: false, refusal: stop };
  const fetchPath = fields
    ? `${resourcePath}/${id}?fields=${fields}`
    : `${resourcePath}/${id}?fields=id`;
  const data = await safeDhis2Fetch(fetchPath);
  if (data && data._status === 404) {
    noteDestructive404(toolName, action, id);
    return {
      exists: false,
      refusal: {
        _error: `${resourcePath} with id "${id}" does not exist (404). Do NOT proceed with ${toolName}(action=${action}).`,
        _hint: 'Prior conversation or external diagnostics may reference IDs that are not in the current metadata. Do NOT invent context like "stale cache" — DHIS2 has no client-side rule cache that returns ghost objects. Either (a) confirm with the user which CURRENT object to operate on, or (b) call the corresponding list action to see what actually exists.',
        _verified_404: true,
        _attempted: { resource: resourcePath, id },
        _scope: 'target_not_found',
        _consecutive_404s: dhis2.destructive404Count || 0,
      },
    };
  }
  if (data && data._error) {
    return { exists: false, refusal: { ...data, _hint: data._hint || `GET ${resourcePath}/${id} failed before the destructive action could proceed.` } };
  }
  return { exists: true, data };
}

// ── Auth policy ────────────────────────────────────────────────────────────
// This extension authenticates to DHIS2 ONLY via the browser session of the
// user's logged-in DHIS2 tab (cookies sent with `credentials: 'include'`).
// We do NOT store or read username/password, and we never build an
// Authorization header. When the user signs out of DHIS2, the session cookie
// becomes invalid and the extension loses access automatically.
//
// As a defensive cleanup, remove any legacy credential keys that might exist
// in chrome.storage from older versions or external writes.
(async () => {
  try {
    const keys = await chrome.storage.local.get(['dhis2Username', 'dhis2Password']);
    if (keys.dhis2Username != null || keys.dhis2Password != null) {
      await chrome.storage.local.remove(['dhis2Username', 'dhis2Password']);
      console.log('[Auth] Removed legacy stored DHIS2 credentials.');
    }
  } catch {}
})();

function extractVisualizationIdFromInput(input) {
  return extractDhis2IdFromInput(input, 'visualizations', ['id', 'visualization']);
}

function extractVisualizationIdFromText(text) {
  return extractDhis2IdFromText(text, 'visualizations', ['id', 'visualization']);
}

function extractMapIdFromInput(input) {
  return extractDhis2IdFromInput(input, 'maps', ['id', 'map']);
}

function extractMapIdFromText(text) {
  return extractDhis2IdFromText(text, 'maps', ['id', 'map']);
}

// DHIS2 auth is handled ENTIRELY by the browser session of the logged-in
// DHIS2 tab. `credentials: 'include'` on each fetch sends the session cookie.
// No Authorization header is ever built or sent, and no credentials are
// stored by the extension.

function userExplicitlyWantsDescendants(userText) {
  const t = normalizePlainText(userText);
  if (!t) return false;
  return [
    'all facilities',
    'all ous',
    'all org units',
    'all organization units',
    'all organisations',
    'across org units',
    'across all',
    'descendant',
    'children',
    'sub-',
    'sub org',
    'sub-org',
    'nationwide',
    'countrywide',
    'overall',
  ].some(k => t.includes(k));
}

// ── State Restoration (MV3 service worker can die and restart) ──────────────
(async () => {
  try {
    const stored = await chrome.storage.session.get(['dhis2Full', 'chatHistory']);
    // Do NOT resurrect the previous thread if a new-thread reset (CLEAR_HISTORY)
    // fired while this async get() was in flight — otherwise a fresh panel that
    // clears history the instant it opens could have the prior thread's
    // conversation AND task context (programMetadata, ouContext, …) restored
    // right back on top of it, and the model silently continues the old task.
    // The connect flow re-establishes the connection and re-fetches context.
    if (historyExplicitlyCleared) return;
    if (stored.dhis2Full) Object.assign(dhis2, stored.dhis2Full);
    if (stored.chatHistory) conversationHistory = stored.chatHistory;
  } catch (e) { console.warn('State restoration failed:', e); }
})();

async function ensureConnected() {
  // The active tab is authoritative. Never restore a previously persisted
  // connection when that tab points at another server: doing so can send the
  // next tool call to the wrong DHIS2 instance.
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!activeTab?.url) return false;
    const activeBaseUrl = extractBaseUrl(activeTab.url);
    if (!activeBaseUrl) return false;
    if (dhis2.connected && dhis2.baseUrl === activeBaseUrl) return true;
    const result = await syncPageContextFromUrl(activeTab.url);
    return result.success === true && dhis2.connected && dhis2.baseUrl === activeBaseUrl;
  } catch {}
  return false;
}

// Per-turn registries that must NOT be persisted across service-worker
// restarts. JSON.stringify silently converts Set → {} which then survives the
// truthy guard in recordKnownIdsFromResult and crashes the next .add() call
// with "set.add is not a function". Counters/history reset every turn anyway.
const PER_TURN_DHIS2_FIELDS = new Set([
  'knownIds', 'knownIdsSeedSize', 'knownIcons',
  'recentCreations',
  'writeAuth',
  'destructive404Count', 'destructive404History',
  'httpErrorCount', 'httpErrorHistory',
  'failedCallSigs', 'toolErrorFamilies', 'toolSuccessCount',
]);

function snapshotDhis2ForPersistence() {
  const out = {};
  for (const k of Object.keys(dhis2)) {
    if (PER_TURN_DHIS2_FIELDS.has(k)) continue;
    out[k] = dhis2[k];
  }
  return out;
}

// ── Conversation-memory helpers ─────────────────────────────────────────────
// The agentic loop accumulates a full structured turn in its local `messages`
// array: the user message, every assistant message that issued tool_calls, and
// every `tool` result message. Historically only the user text + final
// assistant prose were persisted into `conversationHistory`, so on the NEXT
// turn the model had amnesia about what it actually DID (API calls, created
// IDs, the metadata it built) — it could only re-read its own summary prose.
// These helpers let us persist the real action trail while keeping the history
// bounded and structurally valid for every provider.

// Cap on how much of a single tool result we keep in long-term history. Full
// results (OU dumps, whole-metadata exports) can be tens of KB; the model only
// needs the IDs / status / shape to stay oriented on later turns.
const HISTORY_TOOL_RESULT_CAP = 1800;
// Max messages retained across turns. Tool turns inflate the count (1 user + N
// assistant/tool messages), so this is larger than the old 20-message cap.
const HISTORY_MAX_MESSAGES = 60;

// Shrink a persisted `tool` message's content so history stays small. Tries to
// keep the head of the JSON (where ids/status/_error live) plus a truncation
// marker so the model knows the payload was clipped, not empty.
function truncateToolContentForHistory(content) {
  if (typeof content !== 'string' || content.length <= HISTORY_TOOL_RESULT_CAP) return content;
  return content.slice(0, HISTORY_TOOL_RESULT_CAP) +
    `…[truncated ${content.length - HISTORY_TOOL_RESULT_CAP} chars — full result was returned to the model on the turn it ran]`;
}

// Trim history WITHOUT orphaning a `tool` message from the assistant tool_calls
// it answers (which makes OpenAI/Anthropic/Google reject the request). We only
// ever cut on a `user` boundary, so every assistant→tool group stays intact.
function trimConversationHistory(history, maxMessages = HISTORY_MAX_MESSAGES) {
  if (!Array.isArray(history) || history.length <= maxMessages) return history;
  let start = history.length - maxMessages;
  // Advance to the next turn boundary (a 'user' message) so the slice never
  // begins in the middle of a tool_call/tool_result group.
  while (start < history.length && history[start].role !== 'user') start++;
  if (start >= history.length) {
    // Fallback: keep from the last user message onward.
    start = history.length - 1;
    while (start > 0 && history[start].role !== 'user') start--;
  }
  return history.slice(start);
}

// Build the persistable record of one turn from the live `messages` array.
// `persistFromIdx` points at the first message that belongs to THIS turn
// (right after system + prior history). Drops transient `system` nudges/
// reminders injected mid-loop, clones objects so the live array is untouched,
// and clips oversized tool results.
function buildTurnHistory(messages, persistFromIdx, userContentOverride) {
  const out = [];
  for (let k = persistFromIdx; k < messages.length; k++) {
    const m = messages[k];
    if (!m || m.role === 'system') continue; // transient nudges/reminders
    if (m.role === 'tool') {
      // Manual-gate results are stubbed (re-delivered on demand next turn);
      // everything else gets the normal size cap.
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: stubToolContentForHistory(m.content) });
    } else if (m.role === 'assistant') {
      const hasCalls = m.tool_calls && m.tool_calls.length;
      const hasText = m.content && String(m.content).trim();
      // Skip empty assistant turns (no text, no tool_calls) — they carry no
      // memory and some providers reject null-content assistant messages.
      if (!hasCalls && !hasText) continue;
      const a = { role: 'assistant', content: m.content ?? null };
      if (hasCalls) a.tool_calls = m.tool_calls;
      out.push(a);
    } else if (m.role === 'user') {
      // Persist the compact user text (override) for the turn's own user
      // message — the live array may carry large image/web context blocks we do
      // not want to retain across turns.
      const useOverride = k === persistFromIdx && typeof userContentOverride !== 'undefined';
      out.push({ role: 'user', content: useOverride ? userContentOverride : m.content });
    }
  }
  return out;
}

async function saveState() {
  try {
    await chrome.storage.session.set({
      dhis2State: getSerializableState(),
      dhis2Full: JSON.parse(JSON.stringify(snapshotDhis2ForPersistence())),
      // Trim on a user boundary so a reload never restores an orphaned tool msg.
      chatHistory: trimConversationHistory(conversationHistory),
    });
  } catch {}
}

// ── New-thread reset ────────────────────────────────────────────────────────
// Wipes ALL conversational memory and task-specific cached context so a new
// thread starts with a clean slate. Called both when the user clicks "+"
// (CLEAR_HISTORY) and automatically whenever a fresh side-panel opens, so a new
// thread NEVER inherits the previous thread's task — even across servers,
// windows, or service-worker restarts within the same browser profile.
//
// Deliberately KEEPS the connection identity (baseUrl/apiVersion/systemInfo/
// connected/ouMaxLevel/metadataAuditSupport) so reconnecting is fast; the
// task-specific caches below are re-fetched fresh by initializeFromUrl on the
// next INITIALIZE/CHAT_MESSAGE, satisfying "context must be fetched again".
function resetTaskScopedState() {
  conversationHistory = [];
  prefetchedIds = { viz: null, map: null };
  lastUserText = '';

  // Task/page-specific context that could be stale from a prior thread. Nulling
  // these forces initializeFromUrl to re-derive them from the active tab.
  dhis2.programMetadata = null;
  dhis2.programRulesCount = null;
  dhis2.ouContext = null;
  dhis2.visualizationContext = null;
  dhis2.mapContext = null;
  dhis2.datasetContext = null;
  dhis2.lastFacilityOu = null;
  dhis2.pageContext = {};

  // Per-turn action memory (created IDs, error trails). These normally reset
  // each turn, but drop them here too so no created-metadata memory from the
  // previous thread can leak into the new one.
  dhis2.knownIds = null;
  dhis2.knownIdsSeedSize = 0;
  dhis2.knownIcons = null;
  dhis2.recentCreations = null;
  dhis2.writeAuth = null;
  dhis2.failedCallSigs = null;
  dhis2.toolErrorFamilies = null;
  // Cross-turn write-approval memory: a proposal from the old thread must not
  // be redeemable by a bare "yes" in the new one.
  dhis2.lastRefusedWrite = null;
  dhis2.turnCounter = 0;
}

function resetForServerSwitch() {
  historyExplicitlyCleared = true;
  conversationEpoch++;
  resetTaskScopedState();
  dhis2.baseUrl = null;
  dhis2.apiVersion = null;
  dhis2.systemInfo = null;
  dhis2.metadataAuditSupport = null;
  dhis2.ouMaxLevel = null;
  dhis2.connected = false;
}

async function clearConversationState() {
  historyExplicitlyCleared = true;
  conversationEpoch++;
  resetTaskScopedState();
  await saveState();
}

// ── DHIS2 API Helpers ────────────────────────────────────────────────────────

async function dhis2Fetch(url) {
  const resp = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`DHIS2 ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

function apiUrl(path) {
  // Encode the query portion the same way safeDhis2Fetch does, so bracketed
  // `fields=a[b[c]]` context loads (program metadata, rules, OU context, viz,
  // maps, datasets) don't 400 on a strict Tomcat-fronted DHIS2. See
  // encodeStrictQueryChars (hoisted). appendQueryParamsToPath already encodes
  // via URLSearchParams, so this only matters for raw bracketed path strings.
  const s = String(path);
  const qIdx = s.indexOf('?');
  if (qIdx === -1) return `${dhis2.baseUrl}/api/${dhis2.apiVersion}/${s}`;
  return `${dhis2.baseUrl}/api/${dhis2.apiVersion}/${s.substring(0, qIdx)}?${encodeStrictQueryChars(s.substring(qIdx + 1))}`;
}

function appendQueryParamsToPath(path, queryParams) {
  if (!queryParams || typeof queryParams !== 'object') return path;
  const [base, q = ''] = String(path).split('?');
  const usp = new URLSearchParams(q);
  for (const [k, v] of Object.entries(queryParams)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) usp.append(k, String(item));
    } else {
      usp.set(k, String(v));
    }
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}

function generateDhis2Uid() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const alphanum = letters + '0123456789';
  let uid = letters.charAt(Math.floor(Math.random() * letters.length));
  for (let i = 0; i < 10; i++) uid += alphanum.charAt(Math.floor(Math.random() * alphanum.length));
  return uid;
}

// ── Backup namespace & retention ────────────────────────────────────────────
// Before any destructive metadata operation (delete / update) the extension
// snapshots the *before* state into this DHIS2 dataStore namespace. Each
// backup key holds a self-contained payload that can be POSTed back through
// /api/metadata?importStrategy=CREATE_AND_UPDATE to restore the prior state.
const BACKUP_NAMESPACE = 'dhis2-ai-extension-backups';
const BACKUP_RETENTION_DAYS = 30;
const BACKUP_KEY_VERSION = 1;
// Hard ceiling on how many objects one write call may touch even after the
// user has passed confirm_bulk_delete:true. Deleting 500 metadata rows in a
// single shot is almost never what the user meant — require a second
// explicit acknowledgement for anything above this.
const BULK_DELETE_SOFT_CAP = 100;

// Fields used to build a restorable snapshot. DHIS2's `:owner` preset returns
// every "owned" property of an object (i.e. exactly what /metadata expects
// back on import) but it does NOT auto-include referenced collections that
// live on OTHER tables. For those we have to spell the fields out.
const SNAPSHOT_FIELDS = {
  programRules:
    'id,name,description,condition,priority,program[id],' +
    'programRuleActions[id,programRuleActionType,content,data,evaluationTime,' +
    'dataElement[id],trackedEntityAttribute[id],programStage[id],programStageSection[id],option[id],optionGroup[id]]',
  programRuleActions:
    'id,programRule[id],programRuleActionType,content,data,evaluationTime,' +
    'dataElement[id],trackedEntityAttribute[id],programStage[id],programStageSection[id],option[id],optionGroup[id]',
  programRuleVariables:
    'id,name,program[id],programRuleVariableSourceType,valueType,useCodeForOptionSet,' +
    'dataElement[id],trackedEntityAttribute[id],programStage[id]',
  programIndicators:
    'id,name,shortName,description,code,expression,filter,analyticsType,aggregationType,decimals,' +
    'program[id],categoryCombo[id],attributeCombo[id],' +
    'analyticsPeriodBoundaries[id,boundaryTarget,analyticsPeriodBoundaryType,offsetPeriods,offsetPeriodType]',
  programStages:
    'id,name,description,program[id],sortOrder,repeatable,minDaysFromStart,autoGenerateEvent,' +
    'openAfterEnrollment,reportDateToUse,generatedByEnrollmentDate,blockEntryForm,hideDueDate,' +
    'programStageDataElements[id,dataElement[id],compulsory,allowProvidedElsewhere,sortOrder,' +
    'displayInReports,allowFutureDate,renderOptionsAsRadio,skipSynchronization,skipAnalytics],' +
    'programStageSections[id,name,sortOrder,dataElements[id]]',
  programs:
    'id,name,shortName,description,programType,trackedEntityType[id],categoryCombo[id],' +
    'onlyEnrollOnce,displayIncidentDate,ignoreOverdueEvents,relatedProgram[id],' +
    'organisationUnits[id],' +
    'programTrackedEntityAttributes[id,trackedEntityAttribute[id],mandatory,displayInList,sortOrder,searchable,renderOptionsAsRadio],' +
    'programStages[id],' +
    'sharing',
  programNotificationTemplates:
    'id,name,code,notificationTrigger,messageTemplate,subjectTemplate,notificationRecipient,' +
    'deliveryChannels,relativeScheduledDays,sendRepeatable,notifyParentOrganisationUnitOnly,' +
    'recipientUserGroup[id],recipientDataElement[id],recipientProgramAttribute[id]',
  dataElements:
    'id,name,shortName,code,description,formName,valueType,aggregationType,domainType,' +
    'categoryCombo[id],optionSet[id],commentOptionSet[id],zeroIsSignificant,url,fieldMask,style,sharing',
  trackedEntityAttributes:
    'id,name,shortName,code,description,valueType,optionSet[id],unique,inherit,confidential,' +
    'displayInListNoProgram,fieldMask,pattern,style,sharing',
  organisationUnits:
    'id,name,shortName,code,description,openingDate,closedDate,parent[id],comment,' +
    'featureType,coordinates,geometry,phoneNumber,email,url,contactPerson,address,style',
  optionSets:
    'id,name,code,description,valueType,options[id,name,code,sortOrder,style]',
  options:
    'id,name,code,description,sortOrder,optionSet[id],style',
  trackedEntityTypes:
    'id,name,description,minAttributesRequiredToSearch,maxTeiCountToReturn,' +
    'trackedEntityTypeAttributes[id,trackedEntityAttribute[id],mandatory,displayInList,sortOrder,searchable]',
  categoryCombos: 'id,name,code,description,dataDimensionType,skipTotal,categories[id]',
  categories: 'id,name,shortName,code,description,dataDimensionType,categoryOptions[id]',
  categoryOptions: 'id,name,shortName,code,description,startDate,endDate,style',
  userGroups: 'id,name,code,description,users[id]',
  dataSets:
    'id,name,shortName,code,description,periodType,categoryCombo[id],timelyDays,openFuturePeriods,' +
    'dataSetElements[dataElement[id],categoryCombo[id]],organisationUnits[id],sections[id],sharing',
  sections:
    'id,name,sortOrder,dataSet[id],showRowTotals,showColumnTotals,dataElements[id],indicators[id]',
  indicators:
    'id,name,shortName,code,description,indicatorType[id],numerator,numeratorDescription,' +
    'denominator,denominatorDescription,decimals,annualized,url',
  // Dashboards are the highest-risk restore target: their whole value lives in
  // the dashboardItems collection, and a careless full-object PUT that omits an
  // item permanently drops it. Spell the items out in full (every content-type
  // reference + grid geometry) so a restore re-creates the dashboard exactly.
  dashboards:
    'id,name,description,favorite,restrictFilters,allowedFilters,layout,itemConfig,' +
    'dashboardItems[id,type,x,y,width,height,shape,appKey,text,messages,' +
    'visualization[id],eventVisualization[id],eventChart[id],eventReport[id],map[id],' +
    'chart[id],reportTable[id],reports[id],resources[id],users[id]],' +
    'sharing',
};

function getSnapshotFields(objectType) {
  return SNAPSHOT_FIELDS[objectType] || ':owner';
}

function buildBackupKey(operation) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts =
    now.getUTCFullYear() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) + 'T' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds()) + 'Z';
  const short = generateDhis2Uid().slice(0, 6);
  const opSlug = String(operation || 'op').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'op';
  return `backup-${ts}-${opSlug}-${short}`;
}

// Fetch restorable "before" state for a list of targets, then persist a
// single dataStore entry. Returns { backup_key, backup_url, snapshot_count }
// on success, or { _error, _requires_user_confirmation: true, _hint } on
// failure. Callers that want to proceed anyway must pass skip_backup:true at
// the tool argument level — and that fact is reflected in the response so
// the model can surface it to the user.
//
// targets: [{ object_type, object_id, role? }]  role is an optional tag
// (e.g. 'primary' | 'cascade' | 'old_action') used purely for the audit
// section of the stored backup.
async function snapshotBeforeWrite(opMeta, targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { _error: 'snapshotBeforeWrite called with no targets', _requires_user_confirmation: false };
  }
  if (!dhis2.baseUrl) {
    return {
      _error: 'Cannot create backup: no DHIS2 connection detected.',
      _requires_user_confirmation: true,
      _hint: 'Open a DHIS2 tab first. Or, if the user has explicitly accepted the risk of no backup, retry the original write with skip_backup:true.',
    };
  }

  // Deduplicate by (type,id) — prevents double-fetching a cascade.
  const seen = new Set();
  const dedup = [];
  for (const t of targets) {
    if (!t || !t.object_type || !t.object_id) continue;
    const k = `${t.object_type}/${t.object_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(t);
  }
  if (dedup.length === 0) {
    return { _error: 'snapshotBeforeWrite: all targets were invalid', _requires_user_confirmation: false };
  }

  // Parallel fetch. Each 404 → object already gone, captured as a tombstone
  // so the restore logic can skip it. Each other error → propagate as a
  // hard failure so the caller can decide whether to bail or bypass with
  // user consent.
  const fetches = dedup.map(async (t) => {
    const fields = getSnapshotFields(t.object_type);
    const resp = await safeDhis2Fetch(
      `${t.object_type}/${encodeURIComponent(t.object_id)}?fields=${encodeURIComponent(fields)}`
    );
    if (resp?._status === 404) {
      return {
        object_type: t.object_type,
        object_id: t.object_id,
        role: t.role || 'primary',
        not_found_at_snapshot: true,
        before_snapshot: null,
      };
    }
    if (resp?._error) {
      return {
        object_type: t.object_type,
        object_id: t.object_id,
        role: t.role || 'primary',
        _fetch_error: resp._error,
      };
    }
    return {
      object_type: t.object_type,
      object_id: t.object_id,
      role: t.role || 'primary',
      name: resp?.displayName || resp?.name || null,
      before_snapshot: resp,
    };
  });

  const results = await Promise.all(fetches);
  const fetchFailures = results.filter((r) => r._fetch_error);
  if (fetchFailures.length > 0) {
    return {
      _error:
        `Could not snapshot ${fetchFailures.length}/${results.length} object(s) before the write: ` +
        fetchFailures.slice(0, 3).map((f) => `${f.object_type}/${f.object_id} (${f._fetch_error})`).join('; '),
      _requires_user_confirmation: true,
      _hint:
        'The backup step failed. If the user is OK proceeding without a backup, retry the original write with skip_backup:true. Otherwise, investigate the fetch errors (usually a 403 sharing issue on the service account or a lost DHIS2 session).',
      _partial: results,
    };
  }

  const backupKey = buildBackupKey(opMeta?.operation);
  const entry = {
    version: BACKUP_KEY_VERSION,
    created_at: new Date().toISOString(),
    retention_days: BACKUP_RETENTION_DAYS,
    operation: opMeta?.operation || 'unknown',
    tool: opMeta?.tool || null,
    action: opMeta?.action || null,
    reason: opMeta?.reason || null,
    origin_user: opMeta?.user || null,
    origin_user_text: opMeta?.user_text ? String(opMeta.user_text).slice(0, 500) : null,
    origin_server: dhis2.baseUrl || null,
    objects: results.map((r) => ({
      object_type: r.object_type,
      object_id: r.object_id,
      role: r.role,
      name: r.name || null,
      not_found_at_snapshot: !!r.not_found_at_snapshot,
      before_snapshot: r.before_snapshot || null,
    })),
  };

  const putResp = await safeDhis2Fetch(
    `dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(backupKey)}`,
    { method: 'POST', body: entry }
  );
  if (putResp?._error) {
    // POST returns 409 if the key already exists. With a UID suffix that's
    // essentially impossible, but if it happens we retry with PUT.
    const retry = await safeDhis2Fetch(
      `dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(backupKey)}`,
      { method: 'PUT', body: entry }
    );
    if (retry?._error) {
      return {
        _error: `Could not persist backup to dataStore/${BACKUP_NAMESPACE}: ${putResp._error}`,
        _requires_user_confirmation: true,
        _hint:
          'DataStore write failed. This usually means the DHIS2 user lacks METADATA_PRIVILEGE on dataStore, or the server blocks writes from this origin. Surface this to the user: ask whether to proceed WITHOUT a backup (retry with skip_backup:true) or abort the destructive operation entirely.',
      };
    }
  }

  return {
    backup_key: backupKey,
    backup_namespace: BACKUP_NAMESPACE,
    backup_url: `${dhis2.baseUrl}/api/${dhis2.apiVersion}/dataStore/${BACKUP_NAMESPACE}/${backupKey}`,
    snapshot_count: results.length,
    objects: results.map((r) => ({
      object_type: r.object_type,
      object_id: r.object_id,
      role: r.role,
      name: r.name,
      not_found_at_snapshot: !!r.not_found_at_snapshot,
    })),
  };
}

// Build the small "backup:{...}" block that each write site tacks onto its
// success response so the model — and the user — can see exactly how to
// restore. When skip_backup was used, emits a loud _warning instead.
function buildBackupResultBlock(backupResult, skipBackup) {
  if (skipBackup) {
    return {
      skipped: true,
      _warning:
        'Backup was skipped (skip_backup:true). This operation is NOT recoverable via the extension. The user explicitly authorized this — say so in your summary.',
    };
  }
  if (!backupResult || backupResult._error) {
    return null;
  }
  return {
    key: backupResult.backup_key,
    namespace: backupResult.backup_namespace,
    url: backupResult.backup_url,
    snapshot_count: backupResult.snapshot_count,
    objects: backupResult.objects,
    restore_hint: `manage_backups(action="restore", backup_key="${backupResult.backup_key}")`,
    expires_in_days: BACKUP_RETENTION_DAYS,
  };
}

// Helper used at every write site: either returns a backup block (on success
// or on intentional skip), or returns a tool-result-shaped error the caller
// should bail with. Keeps the wiring at each site to two lines.
async function ensureBackupOrBail(opMeta, targets, toolArgs) {
  if (toolArgs && toolArgs.skip_backup === true) {
    return { ok: true, block: buildBackupResultBlock(null, true), skipped: true };
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    // Nothing to snapshot (pure create). Pass-through OK.
    return { ok: true, block: null, skipped: false };
  }
  const snap = await snapshotBeforeWrite(opMeta, targets);
  if (snap && snap._error) {
    return {
      ok: false,
      error: {
        _error: snap._error,
        _requires_user_confirmation: !!snap._requires_user_confirmation,
        _hint: snap._hint || 'If the user explicitly accepts the risk, retry the original write with skip_backup:true.',
        _backup_failure: true,
        _bypass_argument: 'skip_backup:true',
      },
    };
  }
  return { ok: true, block: buildBackupResultBlock(snap, false), backup: snap };
}

// Restore the "before" snapshots in a backup key via /metadata with
// importStrategy=CREATE_AND_UPDATE. Each object in the backup is re-posted
// to its original type bucket. Tombstones (null snapshot) are skipped.
async function restoreFromBackup(backupKey) {
  if (!backupKey) return { _error: 'backup_key required' };
  const entry = await safeDhis2Fetch(
    `dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(backupKey)}`
  );
  if (entry?._error) {
    return {
      _error: `Could not load backup ${backupKey}: ${entry._error}`,
      _hint: 'Use manage_backups(action="list") to see available keys.',
    };
  }
  const objects = Array.isArray(entry?.objects) ? entry.objects : [];
  if (objects.length === 0) return { _error: `Backup ${backupKey} contains no objects.` };

  const byType = {};
  let skippedTombstones = 0;
  for (const o of objects) {
    if (!o?.before_snapshot || o.not_found_at_snapshot) {
      skippedTombstones++;
      continue;
    }
    (byType[o.object_type] = byType[o.object_type] || []).push(o.before_snapshot);
  }
  const payload = {};
  for (const [type, arr] of Object.entries(byType)) payload[type] = arr;
  if (Object.keys(payload).length === 0) {
    return {
      _error: `Backup ${backupKey} only contains tombstones (${skippedTombstones} object(s) were already gone at snapshot time). Nothing to restore.`,
    };
  }
  const resp = await safeDhis2Fetch(
    'metadata?importStrategy=CREATE_AND_UPDATE&atomicMode=ALL',
    { method: 'POST', body: payload }
  );
  if (resp?._error) {
    return {
      _error: `Restore POST failed: ${resp._error}`,
      _hint: 'Check DHIS2 import logs; the "before" snapshot may reference objects that have themselves been deleted since the backup.',
    };
  }
  const stats = resp?.stats || resp?.response?.stats || {};
  const typeReports = resp?.response?.typeReports || [];
  const errors = [];
  for (const tr of typeReports) {
    for (const or of (tr.objectReports || [])) {
      for (const er of (or.errorReports || [])) errors.push(`${tr.klass?.split('.')?.pop() || 'Object'}: ${er.message}`);
    }
  }
  return {
    success: errors.length === 0,
    backup_key: backupKey,
    created_at: entry.created_at,
    restored_counts_by_type: Object.fromEntries(Object.entries(byType).map(([t, a]) => [t, a.length])),
    skipped_tombstones: skippedTombstones,
    import_stats: stats,
    errors: errors.length ? errors : undefined,
    _hint: errors.length
      ? 'Some objects failed to restore. The backup is still preserved; you can fix references and retry.'
      : undefined,
  };
}

// Paginated list of backup keys, newest-first, with optional filtering.
async function listBackups(opts = {}) {
  const keysResp = await safeDhis2Fetch(`dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}`);
  if (keysResp?._status === 404) {
    return { keys: [], total: 0, _note: 'Backup namespace has no entries yet.' };
  }
  if (keysResp?._error) return { _error: `Could not list backups: ${keysResp._error}` };

  let keys = Array.isArray(keysResp) ? keysResp.slice() : [];
  if (opts.since) {
    const cutoff = new Date(opts.since).getTime();
    if (!Number.isNaN(cutoff)) {
      keys = keys.filter((k) => {
        const m = String(k).match(/^backup-(\d{8}T\d{6}Z)-/);
        if (!m) return true;
        const ts = m[1];
        const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`;
        return new Date(iso).getTime() >= cutoff;
      });
    }
  }
  if (opts.operation) {
    const op = String(opts.operation);
    keys = keys.filter((k) => k.includes(`-${op}-`));
  }
  keys.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(500, opts.limit)) : 50;
  const page = keys.slice(0, limit);

  let preview = null;
  if (opts.preview && page.length) {
    const previewN = Math.min(page.length, opts.preview === true ? 10 : Number(opts.preview) || 10);
    preview = [];
    for (const k of page.slice(0, previewN)) {
      const v = await safeDhis2Fetch(
        `dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(k)}`
      );
      if (v && !v._error) {
        preview.push({
          key: k,
          created_at: v.created_at,
          operation: v.operation,
          tool: v.tool,
          action: v.action,
          reason: v.reason,
          object_count: Array.isArray(v.objects) ? v.objects.length : 0,
          object_types: Array.from(new Set((v.objects || []).map((o) => o.object_type))),
        });
      }
    }
  }
  return { total: keys.length, returned: page.length, keys: page, preview };
}

// Delete backups older than retention_days (default BACKUP_RETENTION_DAYS).
async function purgeOldBackups(retentionDays) {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : BACKUP_RETENTION_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const keysResp = await safeDhis2Fetch(`dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}`);
  if (keysResp?._status === 404) return { deleted: 0, kept: 0, _note: 'No backups to purge.' };
  if (keysResp?._error) return { _error: `Could not list backups: ${keysResp._error}` };
  const keys = Array.isArray(keysResp) ? keysResp : [];
  const toDelete = [];
  for (const k of keys) {
    const m = String(k).match(/^backup-(\d{8}T\d{6}Z)-/);
    if (!m) continue;
    const ts = m[1];
    const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`;
    if (new Date(iso).getTime() < cutoff) toDelete.push(k);
  }
  const failed = [];
  for (const k of toDelete) {
    const d = await safeDhis2Fetch(
      `dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(k)}`,
      { method: 'DELETE', allowEmptyBody: true }
    );
    if (d?._error) failed.push({ key: k, error: d._error });
  }
  return {
    deleted: toDelete.length - failed.length,
    kept: keys.length - toDelete.length,
    retention_days: days,
    failed: failed.length ? failed : undefined,
  };
}

// ── Tab-based fetch for write requests ────────────────────────────────────────
// Chrome MV3 service worker fetch() for cross-origin POST can return empty bodies
// even with host_permissions. Routing writes through the active DHIS2 tab avoids
// this because the content-script context is same-origin with the DHIS2 page.
async function fetchViaTab(fullUrl, method, headers, bodyStr) {
  if (!dhis2.baseUrl) return null;
  try {
    const tabs = await chrome.tabs.query({});
    const dhis2Tab = tabs.find(t => t.url && t.url.startsWith(dhis2.baseUrl));
    if (!dhis2Tab) { console.warn('[fetchViaTab] No DHIS2 tab found'); return null; }

    const results = await chrome.scripting.executeScript({
      target: { tabId: dhis2Tab.id },
      func: async (url, meth, hdrs, body) => {
        try {
          const opts = { method: meth, headers: hdrs, credentials: 'include' };
          if (body) opts.body = body;
          const resp = await fetch(url, opts);
          const text = await resp.text();
          return { ok: resp.ok, status: resp.status, statusText: resp.statusText, text };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [fullUrl, method, headers, bodyStr],
    });

    const result = results?.[0]?.result;
    if (!result || result.error) {
      console.warn('[fetchViaTab] Injection failed:', result?.error || 'no result');
      return null;
    }
    return result; // { ok, status, statusText, text }
  } catch (e) {
    console.warn('[fetchViaTab] Error:', e.message);
    return null;
  }
}

// Percent-encode the characters that RFC 7230 / Tomcat reject in a raw request
// target (`" < > [ \ ] ^ ` { | }` and whitespace). DHIS2's nested-`fields` and
// `filter=...:in:[..]` syntaxes rely on `[`/`]`, so on a strict Tomcat-fronted
// instance an un-encoded query 400s ("Invalid character found in the request
// target"). We deliberately DO NOT touch `%`, so an already-encoded query is
// never double-encoded, and legal query delimiters (& = , : ;) are preserved —
// only the forbidden characters are escaped. Safe on relaxed servers too (they
// decode %5B/%5D back to [/] identically).
function encodeStrictQueryChars(query) {
  return String(query).replace(/[\s"<>\[\\\]^`{|}]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  );
}

async function safeDhis2Fetch(path, options = {}) {
  if (!dhis2.baseUrl || !dhis2.apiVersion) {
    const ok = await ensureConnected();
    if (!ok) return { _error: 'Not connected to DHIS2. Navigate to a DHIS2 page.' };
  }

  // Defensive: path must be a non-empty string. Previously an undefined/null
  // path crashed with "Cannot read properties of undefined (reading 'replace')"
  // and consumed an agentic iteration with an opaque tool error.
  if (typeof path !== 'string' || !path.trim()) {
    return {
      _error: 'safeDhis2Fetch called without a path. This is a caller bug, not a DHIS2 error.',
      _hint: 'For dhis2_query, pass a non-empty "path" argument (e.g. "programs/XYZ?fields=id,displayName"). Do NOT include /api/{version}/ — the tool adds it.',
      _received_path: String(path),
    };
  }

  let cleanPath = path.replace(/^\//, '').replace(/^api\/\d+\//, '');
  const qIdx = cleanPath.indexOf('?');
  let fullUrl;
  if (qIdx !== -1) {
    // DHIS2's nested `fields=a[b[c]]` and `filter=x:in:[..]` syntaxes contain
    // `[` and `]`. A stock Tomcat-fronted DHIS2 (e.g. self-hosted 2.42) enforces
    // strict RFC 7230 and rejects those raw with 400 "Invalid character found in
    // the request target"; play.dhis2.org sits behind a relaxed proxy so raw
    // brackets slip through there (which is why this only bites self-hosted
    // instances). Percent-encode the forbidden chars in the QUERY portion only.
    fullUrl = `${dhis2.baseUrl}/api/${dhis2.apiVersion}/${cleanPath.substring(0, qIdx)}?${encodeStrictQueryChars(cleanPath.substring(qIdx + 1))}`;
  } else {
    fullUrl = `${dhis2.baseUrl}/api/${dhis2.apiVersion}/${cleanPath}`;
  }

  try {
    const isWrite = options.method && options.method !== 'GET';
    const method = options.method || 'GET';

    const headers = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...options.headers,
    };
    // DHIS2 requires application/json-patch+json (RFC 6902) for PATCH, not application/json.
    // Accept either a JSON Patch array from the caller or a plain object; auto-convert the
    // object to an array of top-level "add" ops so raw dhis2_query PATCH stays usable.
    let patchBody = options.body;
    if (options.method === 'PATCH' && patchBody && !Array.isArray(patchBody)) {
      if (typeof patchBody === 'string') {
        try { patchBody = JSON.parse(patchBody); } catch { /* keep as-is */ }
      }
      if (patchBody && typeof patchBody === 'object' && !Array.isArray(patchBody)) {
        patchBody = Object.entries(patchBody).map(([k, v]) => ({
          op: 'add', path: '/' + String(k).replace(/~/g, '~0').replace(/\//g, '~1'), value: v,
        }));
      }
    }
    if (patchBody != null) {
      headers['Content-Type'] = options.method === 'PATCH'
        ? 'application/json-patch+json'
        : 'application/json';
    }
    const bodyStr = patchBody != null ? JSON.stringify(patchBody) : undefined;

    // ── Execute the fetch ──────────────────────────────────────────────────
    // For write requests (POST/PUT/DELETE), route through the active DHIS2 tab
    // so the request is same-origin (avoiding empty-body issues in MV3 service workers).
    // Fall back to direct service-worker fetch if no tab is available.
    let rawResp = null; // { ok, status, statusText, text }

    if (isWrite) {
      rawResp = await fetchViaTab(fullUrl, method, headers, bodyStr);
      if (rawResp) console.log(`[safeDhis2Fetch] ${method} via tab → HTTP ${rawResp.status}, body ${rawResp.text?.length || 0} chars`);
    }

    if (!rawResp) {
      // Direct fetch from service worker (always used for GET; fallback for writes).
      // Uses `credentials: 'include'` so the browser session cookie from the
      // logged-in DHIS2 tab is sent with the request. No auth header is added.
      const fetchOpts = {
        method,
        credentials: 'include',
        headers,
      };
      if (bodyStr) fetchOpts.body = bodyStr;

      const resp = await fetch(fullUrl, fetchOpts);
      const text = await resp.text().catch(() => '');
      rawResp = { ok: resp.ok, status: resp.status, statusText: resp.statusText, text };

      // For writes: if direct fetch returned empty, retry once (session quirks in MV3)
      if (isWrite && (!text || !text.trim())) {
        console.warn(`[safeDhis2Fetch] Empty from direct ${method}, retrying.`);
        const resp2 = await fetch(fullUrl, { ...fetchOpts, credentials: 'include' });
        const text2 = await resp2.text().catch(() => '');
        if (text2 && text2.trim()) {
          rawResp = { ok: resp2.ok, status: resp2.status, statusText: resp2.statusText, text: text2 };
        }
      }
    }

    // ── Process response ───────────────────────────────────────────────────
    if (!rawResp.ok) {
      let errMsg = `DHIS2 API ${rawResp.status}`;
      let errBody = null;
      try {
        errBody = JSON.parse(rawResp.text);
        if (errBody.message) errMsg += `: ${errBody.message}`;
        else if (errBody.httpStatusCode) errMsg += `: ${errBody.status || rawResp.statusText}`;
      } catch {
        if (rawResp.text && rawResp.text.length < 300) errMsg += `: ${rawResp.text}`;
      }
      // Include parsed body so callers (like postMetadataPayload) can extract detailed errors
      return { _error: errMsg, _url: fullUrl, _status: rawResp.status, ...(errBody ? { _body: errBody } : {}) };
    }

    if (rawResp.status === 204) return { success: true, message: 'Deleted successfully.' };

    let rawText = rawResp.text;
    if (!rawText || !rawText.trim()) {
      // For DELETE with empty 200: raw HTTP DELETE is unreliable in MV3 extensions.
      // Retry using POST /api/metadata?importStrategy=DELETE (uses POST transport, which works).
      if (method === 'DELETE') {
        const resourcePath = cleanPath.split('?')[0];
        // Extract object type and ID from path like "dataElements/UdmI16P0CAU"
        const pathMatch = resourcePath.match(/^([a-zA-Z]+)\/([A-Za-z][A-Za-z0-9]{10})$/);
        if (pathMatch) {
          console.warn(`[safeDhis2Fetch] Raw DELETE returned empty — retrying via POST metadata?importStrategy=DELETE for ${resourcePath}`);
          const metaDeleteUrl = `${dhis2.baseUrl}/api/${dhis2.apiVersion}/metadata?importStrategy=DELETE&atomicMode=ALL`;
          const deleteBody = JSON.stringify({ [pathMatch[1]]: [{ id: pathMatch[2] }] });
          const postHeaders = { ...headers, 'Content-Type': 'application/json' };
          try {
            let retryResp = await fetchViaTab(metaDeleteUrl, 'POST', postHeaders, deleteBody);
            if (!retryResp) {
              const r = await fetch(metaDeleteUrl, { method: 'POST', credentials: 'include', headers: postHeaders, body: deleteBody });
              retryResp = { ok: r.ok, status: r.status, text: await r.text().catch(() => '') };
            }
            if (retryResp.text && retryResp.text.trim()) {
              rawResp = retryResp;
              rawText = retryResp.text;
              // Handle 409 from the retry
              if (!retryResp.ok) {
                let errMsg = `DHIS2 API ${retryResp.status}`;
                let errBody = null;
                try {
                  errBody = JSON.parse(retryResp.text);
                  if (errBody.message) errMsg += `: ${errBody.message}`;
                } catch {}
                return { _error: errMsg, _url: fullUrl, _status: retryResp.status, ...(errBody ? { _body: errBody } : {}) };
              }
              // Fall through to normal JSON parsing below with updated rawText
            }
          } catch (retryErr) {
            console.warn(`[safeDhis2Fetch] POST-based DELETE retry also failed:`, retryErr.message);
          }
        }
        // If retry didn't produce a response, return the original error
        if (!rawText || !rawText.trim()) {
          return { _error: `DELETE failed for ${cleanPath.split('?')[0]}. Server returned empty response and POST-based fallback also failed. Use manage_metadata(action=delete) for reliable deletion.`, _url: fullUrl };
        }
      } else if (options.allowEmptyBody) {
        // Caller explicitly opted in: DHIS2 collection-add / link endpoints
        // (e.g. POST /programs/{pid}/notificationTemplates/{tid}) idiomatically
        // return HTTP 200 with an empty body on success. Treat as success and
        // let the caller verify via GET if it needs to be sure.
        return { success: true, message: 'OK', _status: rawResp.status, _url: fullUrl, _emptyBody: true };
      } else {
        return { _error: `DHIS2 returned empty response (HTTP ${rawResp.status}) for ${method} ${cleanPath.split('?')[0]}`, _url: fullUrl };
      }
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      const preview = rawText.substring(0, 300).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { _error: `DHIS2 returned non-JSON response (HTTP ${rawResp.status}): ${preview}`, _url: fullUrl };
    }

    if (data.pager) {
      data._pagerInfo = { page: data.pager.page, pageSize: data.pager.pageSize, total: data.pager.total };
    }
    data._apiPath = fullUrl.replace(dhis2.baseUrl, '');

    // Truncate large responses unless an internal tool explicitly needs the
    // complete metadata payload to make a correct decision.
    const json = JSON.stringify(data);
    if (options.noTruncate !== true && json.length > 80000) {
      const truncated = { _apiPath: data._apiPath, _pagerInfo: data._pagerInfo, _truncated: true, _originalSize: json.length };
      if (data.rows) {
        truncated.headers = data.headers;
        truncated.rows = data.rows.slice(0, 200);
        truncated.metaData = data.metaData;
        truncated.height = data.height;
        truncated.width = data.width;
        truncated._totalRows = data.rows.length;
      } else if (data.trackedEntities) {
        truncated.trackedEntities = data.trackedEntities.slice(0, 50);
        truncated._totalEntities = data.trackedEntities.length;
      } else if (data.instances) {
        truncated.instances = data.instances.slice(0, 50);
        truncated._totalInstances = data.instances.length;
      } else if (data.programRules) {
        truncated.programRules = data.programRules.slice(0, 80);
        truncated._totalRules = data.programRules.length;
      } else if (data.programIndicators) {
        truncated.programIndicators = data.programIndicators.slice(0, 50);
        truncated._totalIndicators = data.programIndicators.length;
        truncated._note = `Large response sliced to 50 of ${data.programIndicators.length} indicators. Use manage_program_indicators(action=audit) to check all indicators for issues, or request a specific page.`;
      } else {
        truncated._note = `Response too large (${json.length} chars). Use more specific filters or fields.`;
      }
      return truncated;
    }
    return data;
  } catch (err) {
    return { _error: `Fetch failed: ${err.message}`, _url: fullUrl };
  }
}

const TRACKER_BUNDLE_KEYS = ['events', 'trackedEntities', 'enrollments', 'relationships'];
const TRACKER_ID_KEYS = {
  events: 'event',
  trackedEntities: 'trackedEntity',
  enrollments: 'enrollment',
  relationships: 'relationship',
};
const TRACKER_TYPE_TO_COLLECTION = {
  EVENT: 'events',
  TRACKED_ENTITY: 'trackedEntities',
  ENROLLMENT: 'enrollments',
  RELATIONSHIP: 'relationships',
};

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeTextLoose(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function resolveOptionCode(options, rawValue) {
  if (!Array.isArray(options) || !options.length || rawValue == null) return null;
  const raw = String(rawValue).trim();
  if (!raw) return null;

  const exactCode = options.find(o => String(o.code || '') === raw);
  if (exactCode) return { code: String(exactCode.code || raw), displayName: exactCode.displayName || raw, matchedBy: 'code_exact' };

  const exactName = options.find(o => String(o.displayName || '') === raw);
  if (exactName) return { code: String(exactName.code || raw), displayName: exactName.displayName || raw, matchedBy: 'display_name_exact' };

  const normalized = normalizeTextLoose(raw);
  const normalizedCode = options.find(o => normalizeTextLoose(o.code) === normalized);
  if (normalizedCode) return { code: String(normalizedCode.code || raw), displayName: normalizedCode.displayName || raw, matchedBy: 'code_normalized' };

  const normalizedName = options.find(o => normalizeTextLoose(o.displayName) === normalized);
  if (normalizedName) return { code: String(normalizedName.code || raw), displayName: normalizedName.displayName || raw, matchedBy: 'display_name_normalized' };

  return null;
}

function getTrackerMetadataIndexes() {
  const dataElementsById = new Map();
  const attributesById = new Map();

  for (const stage of (dhis2.programMetadata?.programStages || [])) {
    for (const psde of (stage.programStageDataElements || [])) {
      const de = psde?.dataElement;
      if (!de?.id) continue;
      dataElementsById.set(de.id, {
        id: de.id,
        displayName: de.displayName || de.displayFormName || de.id,
        stageId: stage.id,
        stageName: stage.displayName || stage.id,
        options: Array.isArray(de.optionSet?.options) ? de.optionSet.options : [],
      });
    }
  }

  for (const ptea of (dhis2.programMetadata?.programTrackedEntityAttributes || [])) {
    const tea = ptea?.trackedEntityAttribute;
    if (!tea?.id) continue;
    attributesById.set(tea.id, {
      id: tea.id,
      displayName: tea.displayName || tea.displayFormName || tea.id,
      options: Array.isArray(tea.optionSet?.options) ? tea.optionSet.options : [],
    });
  }

  return { dataElementsById, attributesById };
}

function normalizeTrackerDataValues(dataValues, metaIndex, conversionNotes) {
  if (!Array.isArray(dataValues)) return dataValues;
  return dataValues.map(dv => {
    const out = { ...dv };
    const deId = out.dataElement;
    if (!deId || typeof out.value !== 'string') return out;

    const meta = metaIndex.dataElementsById.get(deId);
    const resolved = resolveOptionCode(meta?.options, out.value);
    if (resolved && resolved.code !== out.value) {
      conversionNotes.push({
        type: 'dataValue',
        dataElement: deId,
        dataElementName: meta?.displayName || deId,
        from: out.value,
        to: resolved.code,
        matchedBy: resolved.matchedBy,
      });
      out.value = resolved.code;
    }
    return out;
  });
}

function normalizeTrackerAttributes(attributes, metaIndex, conversionNotes) {
  if (!Array.isArray(attributes)) return attributes;
  return attributes.map(attr => {
    const out = { ...attr };
    const attrId = out.attribute;
    if (!attrId || typeof out.value !== 'string') return out;

    const meta = metaIndex.attributesById.get(attrId);
    const resolved = resolveOptionCode(meta?.options, out.value);
    if (resolved && resolved.code !== out.value) {
      conversionNotes.push({
        type: 'attribute',
        attribute: attrId,
        attributeName: meta?.displayName || attrId,
        from: out.value,
        to: resolved.code,
        matchedBy: resolved.matchedBy,
      });
      out.value = resolved.code;
    }
    return out;
  });
}

function normalizeTrackerEventObject(eventObj, metaIndex, conversionNotes, ctx) {
  const out = { ...eventObj };
  if (!out.program && ctx?.programId) out.program = ctx.programId;
  if (!out.orgUnit && ctx?.orgUnitId) out.orgUnit = ctx.orgUnitId;
  if (!out.programStage && ctx?.stageId) out.programStage = ctx.stageId;
  if (!out.trackedEntity && ctx?.teiId) out.trackedEntity = ctx.teiId;
  if (!out.enrollment && ctx?.enrollmentId) out.enrollment = ctx.enrollmentId;
  out.dataValues = normalizeTrackerDataValues(out.dataValues, metaIndex, conversionNotes);
  return out;
}

function normalizeTrackerEnrollmentObject(enrollmentObj, metaIndex, conversionNotes, ctx) {
  const out = { ...enrollmentObj };
  if (!out.program && ctx?.programId) out.program = ctx.programId;
  if (!out.orgUnit && ctx?.orgUnitId) out.orgUnit = ctx.orgUnitId;
  if (!out.trackedEntity && ctx?.teiId) out.trackedEntity = ctx.teiId;
  if (Array.isArray(out.events)) {
    out.events = out.events.map(ev => normalizeTrackerEventObject(ev, metaIndex, conversionNotes, ctx));
  }
  return out;
}

function normalizeTrackedEntityObject(entityObj, metaIndex, conversionNotes, ctx) {
  const out = { ...entityObj };
  if (!out.orgUnit && ctx?.orgUnitId) out.orgUnit = ctx.orgUnitId;
  out.attributes = normalizeTrackerAttributes(out.attributes, metaIndex, conversionNotes);
  if (Array.isArray(out.enrollments)) {
    out.enrollments = out.enrollments.map(enr => normalizeTrackerEnrollmentObject(enr, metaIndex, conversionNotes, ctx));
  }
  return out;
}

function normalizeTrackerBundle(bundle, collections, ctx) {
  const metaIndex = getTrackerMetadataIndexes();
  const conversionNotes = [];
  const out = cloneJson(bundle) || {};

  for (const collection of collections) {
    if (!Array.isArray(out[collection])) continue;
    if (collection === 'events') {
      out.events = out.events.map(ev => normalizeTrackerEventObject(ev, metaIndex, conversionNotes, ctx));
    } else if (collection === 'enrollments') {
      out.enrollments = out.enrollments.map(enr => normalizeTrackerEnrollmentObject(enr, metaIndex, conversionNotes, ctx));
    } else if (collection === 'trackedEntities') {
      out.trackedEntities = out.trackedEntities.map(te => normalizeTrackedEntityObject(te, metaIndex, conversionNotes, ctx));
    }
  }

  return { bundle: out, conversionNotes };
}

function wrapTrackerWriteBody(collection, body, id, method) {
  const payload = cloneJson(body);
  const idKey = TRACKER_ID_KEYS[collection];

  if (Array.isArray(payload?.[collection])) return payload;

  if (method === 'DELETE' && id && (payload == null || (typeof payload === 'object' && !Object.keys(payload).length))) {
    return { [collection]: [{ [idKey]: id }] };
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const item = { ...payload };
    if (id && !item[idKey]) item[idKey] = id;
    return { [collection]: [item] };
  }

  if (method === 'DELETE' && id) {
    return { [collection]: [{ [idKey]: id }] };
  }

  return null;
}

function buildTrackerWriteRequest(path, method, body, ctx) {
  const upperMethod = String(method || 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(upperMethod)) return null;

  const clean = String(path || '').replace(/^\//, '').replace(/^api\/\d+\//, '');
  const qIdx = clean.indexOf('?');
  const resourcePath = qIdx === -1 ? clean : clean.substring(0, qIdx);
  const query = qIdx === -1 ? '' : clean.substring(qIdx + 1);
  if (!resourcePath.startsWith('tracker')) return null;

  const match = resourcePath.match(/^tracker(?:\/(events|trackedEntities|enrollments|relationships)(?:\/([A-Za-z][A-Za-z0-9]{10}))?)?$/);
  if (!match) return null;

  const collection = match[1] || null;
  const objectId = match[2] || null;
  let bundle = collection ? wrapTrackerWriteBody(collection, body, objectId, upperMethod) : cloneJson(body);
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { _error: 'Tracker writes require a JSON object body.' };
  }

  let collections = TRACKER_BUNDLE_KEYS.filter(key => Array.isArray(bundle[key]));
  if (collection && !collections.includes(collection)) collections = [collection];
  if (!collections.length) {
    return { _error: 'Tracker write body must include one or more of: events, trackedEntities, enrollments, relationships.' };
  }

  const normalized = normalizeTrackerBundle(bundle, collections, ctx);
  bundle = normalized.bundle;

  const importStrategy = upperMethod === 'DELETE'
    ? 'DELETE'
    : (upperMethod === 'PUT' || upperMethod === 'PATCH' ? 'UPDATE' : 'CREATE');

  const commitParams = new URLSearchParams(query);
  if (!commitParams.has('importStrategy')) commitParams.set('importStrategy', importStrategy);
  commitParams.set('async', 'false');

  const dryRunOnly = commitParams.get('dryRun') === 'true';
  const preflightParams = new URLSearchParams(commitParams);
  preflightParams.set('dryRun', 'true');

  return {
    originalPath: clean,
    originalMethod: upperMethod,
    collection,
    collections,
    importStrategy: commitParams.get('importStrategy') || importStrategy,
    conversionNotes: normalized.conversionNotes,
    bundle,
    preflightPath: `tracker?${preflightParams.toString()}`,
    commitPath: `tracker?${commitParams.toString()}`,
    dryRunOnly,
  };
}

function extractTrackerValidationReports(result) {
  const reports = result?._body?.validationReport?.errorReports
    || result?.validationReport?.errorReports
    || [];
  return Array.isArray(reports) ? reports : [];
}

function formatTrackerValidationReports(reports) {
  return reports
    .slice(0, 5)
    .map(r => r?.message || r?.errorCode || JSON.stringify(r))
    .filter(Boolean)
    .join(' | ');
}

function extractTrackerBundleUids(result) {
  const out = {};
  const typeMap = result?.bundleReport?.typeReportMap || {};
  for (const [trackerType, report] of Object.entries(typeMap)) {
    const collection = TRACKER_TYPE_TO_COLLECTION[trackerType];
    if (!collection) continue;
    const ids = (report?.objectReports || [])
      .map(obj => obj?.uid)
      .filter(Boolean);
    if (ids.length) out[collection] = ids;
  }
  return out;
}

async function verifyTrackerBundleResult(result) {
  const idsByCollection = extractTrackerBundleUids(result);
  const verification = {};
  const pathMap = {
    events: id => `tracker/events/${id}?fields=event`,
    trackedEntities: id => `tracker/trackedEntities/${id}?fields=trackedEntity`,
    enrollments: id => `tracker/enrollments/${id}?fields=enrollment`,
  };

  for (const [collection, ids] of Object.entries(idsByCollection)) {
    if (!pathMap[collection]) continue;
    verification[collection] = [];
    for (const id of ids.slice(0, 5)) {
      const check = await safeDhis2Fetch(pathMap[collection](id));
      verification[collection].push({
        id,
        exists: !check?._error,
      });
    }
  }

  return verification;
}

async function finalizeTrackerWriteResult(result, trackerWrite, mode) {
  const reports = extractTrackerValidationReports(result);
  const stats = result?.stats || result?._body?.stats || {};
  const summary = {
    mode,
    importStrategy: trackerWrite.importStrategy,
    collections: trackerWrite.collections,
    created: Number(stats.created || 0),
    updated: Number(stats.updated || 0),
    deleted: Number(stats.deleted || 0),
    ignored: Number(stats.ignored || 0),
    total: Number(stats.total || 0),
  };

  if (result?._error) {
    const detail = reports.length ? formatTrackerValidationReports(reports) : result._error;
    return {
      ...result,
      _error: detail ? `Tracker write failed: ${detail}` : result._error,
      _trackerSummary: summary,
      _trackerRequest: {
        original_method: trackerWrite.originalMethod,
        original_path: trackerWrite.originalPath,
        normalized_path: mode === 'dry_run' ? trackerWrite.preflightPath : trackerWrite.commitPath,
        conversion_notes: trackerWrite.conversionNotes,
      },
    };
  }

  if (reports.length) {
    return {
      ...result,
      _error: `Tracker write failed validation: ${formatTrackerValidationReports(reports)}`,
      _trackerSummary: summary,
      _trackerRequest: {
        original_method: trackerWrite.originalMethod,
        original_path: trackerWrite.originalPath,
        normalized_path: mode === 'dry_run' ? trackerWrite.preflightPath : trackerWrite.commitPath,
        conversion_notes: trackerWrite.conversionNotes,
      },
    };
  }

  const mutated = summary.created + summary.updated + summary.deleted;
  if (summary.total > 0 && mutated === 0 && summary.ignored > 0) {
    return {
      ...result,
      _error: 'Tracker write was accepted by the endpoint but ignored by DHIS2. No records were created, updated, or deleted.',
      _trackerSummary: summary,
      _trackerRequest: {
        original_method: trackerWrite.originalMethod,
        original_path: trackerWrite.originalPath,
        normalized_path: mode === 'dry_run' ? trackerWrite.preflightPath : trackerWrite.commitPath,
        conversion_notes: trackerWrite.conversionNotes,
      },
    };
  }

  const out = {
    ...result,
    _trackerSummary: summary,
    _trackerRequest: {
      original_method: trackerWrite.originalMethod,
      original_path: trackerWrite.originalPath,
      normalized_path: mode === 'dry_run' ? trackerWrite.preflightPath : trackerWrite.commitPath,
      conversion_notes: trackerWrite.conversionNotes,
    },
  };

  if (mode === 'commit' && mutated > 0) {
    out._trackerVerification = await verifyTrackerBundleResult(result);
  }

  return out;
}

async function executeTrackerWrite(path, method, body, ctx) {
  const trackerWrite = buildTrackerWriteRequest(path, method, body, ctx);
  if (!trackerWrite) return null;
  if (trackerWrite._error) return { _error: trackerWrite._error };

  // ── Auto-repair enrollment UPDATEs: fill missing required fields from server ──
  const isUpdateStrategy = ['UPDATE', 'CREATE_AND_UPDATE'].includes(trackerWrite.importStrategy);
  if (isUpdateStrategy && Array.isArray(trackerWrite.bundle.enrollments)) {
    const enrollmentsNeedingFill = trackerWrite.bundle.enrollments.filter(
      enr => enr.enrollment && (!enr.enrolledAt || !enr.program || !enr.orgUnit || !enr.trackedEntity)
    );
    await Promise.all(enrollmentsNeedingFill.map(async (enr) => {
      try {
        const existing = await safeDhis2Fetch(
          `tracker/enrollments/${enr.enrollment}?fields=enrollment,trackedEntity,program,orgUnit,enrolledAt,status`
        );
        if (!existing._error) {
          if (!enr.enrolledAt)     enr.enrolledAt     = existing.enrolledAt;
          if (!enr.program)        enr.program        = existing.program;
          if (!enr.orgUnit)        enr.orgUnit        = existing.orgUnit;
          if (!enr.trackedEntity)  enr.trackedEntity   = existing.trackedEntity;
          console.log(`[executeTrackerWrite] Auto-filled enrollment ${enr.enrollment} fields from server`);
        }
      } catch (e) {
        console.warn(`[executeTrackerWrite] Failed to auto-fill enrollment: ${e.message}`);
      }
    }));
  }

  // ── Auto-repair event UPDATEs: fill missing required fields from server ──
  if (isUpdateStrategy && Array.isArray(trackerWrite.bundle.events)) {
    const eventsNeedingFill = trackerWrite.bundle.events.filter(
      ev => ev.event && (!ev.program || !ev.programStage || !ev.orgUnit)
    );
    await Promise.all(eventsNeedingFill.map(async (ev) => {
      try {
        const existing = await safeDhis2Fetch(
          `tracker/events/${ev.event}?fields=event,program,programStage,orgUnit,enrollment,trackedEntity,occurredAt,status`
        );
        if (!existing._error) {
          if (!ev.program)      ev.program      = existing.program;
          if (!ev.programStage) ev.programStage  = existing.programStage;
          if (!ev.orgUnit)      ev.orgUnit       = existing.orgUnit;
          if (!ev.enrollment)   ev.enrollment    = existing.enrollment;
          if (!ev.trackedEntity) ev.trackedEntity = existing.trackedEntity;
          console.log(`[executeTrackerWrite] Auto-filled event ${ev.event} fields from server`);
        }
      } catch (e) {
        console.warn(`[executeTrackerWrite] Failed to auto-fill event: ${e.message}`);
      }
    }));
  }

  const preflight = await safeDhis2Fetch(trackerWrite.preflightPath, {
    method: 'POST',
    body: trackerWrite.bundle,
  });
  const preflightResult = await finalizeTrackerWriteResult(preflight, trackerWrite, 'dry_run');
  if (preflightResult._error || trackerWrite.dryRunOnly) return preflightResult;

  const commit = await safeDhis2Fetch(trackerWrite.commitPath, {
    method: 'POST',
    body: trackerWrite.bundle,
  });
  return await finalizeTrackerWriteResult(commit, trackerWrite, 'commit');
}

async function getMaxOuLevel() {
  if (Number.isInteger(dhis2.ouMaxLevel) && dhis2.ouMaxLevel > 0) return dhis2.ouMaxLevel;
  const resp = await safeDhis2Fetch('organisationUnitLevels?fields=level&paging=false');
  if (resp?._error || !Array.isArray(resp?.organisationUnitLevels)) return null;
  const max = resp.organisationUnitLevels.reduce((m, x) => {
    const n = Number(x?.level);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  if (max > 0) dhis2.ouMaxLevel = max;
  return max > 0 ? max : null;
}

function rememberFacilityOu(ou) {
  if (!ou || !ou.id) return;
  const max = Number(dhis2.ouMaxLevel);
  const lvl = Number(ou.level);
  const hasChildren = Array.isArray(ou.children) ? ou.children.length > 0 : null;
  if ((Number.isFinite(max) && max > 0 && lvl === max) || hasChildren === false) {
    dhis2.lastFacilityOu = {
      id: ou.id,
      name: ou.displayName || ou.id,
      level: Number.isFinite(lvl) ? lvl : null,
      path: ou.path || null,
      updatedAt: new Date().toISOString(),
    };
  }
}

async function fetchOuById(ouId) {
  if (!ouId) return null;
  if (dhis2.ouContext?.id === ouId && dhis2.ouContext?.path && dhis2.ouContext?.level != null) return dhis2.ouContext;
  try {
    return await dhis2Fetch(apiUrl(
      `organisationUnits/${ouId}?fields=id,displayName,level,path,children[id,displayName,level]`
    ));
  } catch {
    return null;
  }
}

async function resolveFacilityScopedOu(ouId) {
  const base = await fetchOuById(ouId);
  if (!base) return { ouId, ouName: dhis2.ouContext?.displayName || ouId, source: 'fallback_no_context' };

  const maxLevel = await getMaxOuLevel();
  if (maxLevel && Number(base.level) === Number(maxLevel)) {
    rememberFacilityOu(base);
    return { ouId: base.id, ouName: base.displayName || base.id, source: 'current_ou_is_facility' };
  }

  if (Array.isArray(base.children) && base.children.length === 0) {
    rememberFacilityOu(base);
    return { ouId: base.id, ouName: base.displayName || base.id, source: 'current_ou_is_leaf' };
  }

  const last = dhis2.lastFacilityOu;
  if (
    last?.id &&
    base.path &&
    last.path &&
    (last.path === base.path || last.path.startsWith(`${base.path}/`))
  ) {
    return { ouId: last.id, ouName: last.name || last.id, source: 'last_known_facility_in_scope' };
  }

  if (maxLevel && base.path) {
    const leafResp = await safeDhis2Fetch(
      `organisationUnits?filter=path:like:${base.path}/&filter=level:eq:${maxLevel}&fields=id,displayName,path&paging=true&pageSize=2`
    );
    if (!leafResp?._error && Array.isArray(leafResp.organisationUnits)) {
      if (leafResp.organisationUnits.length === 1) {
        const only = leafResp.organisationUnits[0];
        rememberFacilityOu({ ...only, level: maxLevel, children: [] });
        return { ouId: only.id, ouName: only.displayName || only.id, source: 'single_facility_descendant' };
      }
      if (leafResp.organisationUnits.length > 1) {
        return {
          _error: 'Current OU is above facility level and has multiple facilities. Specify a facility or set include_children=true explicitly.',
          _scope: {
            current_ou: { id: base.id, name: base.displayName || base.id, level: base.level },
            facility_level: maxLevel,
          },
        };
      }
    }
  }

  return { ouId: base.id, ouName: base.displayName || base.id, source: 'fallback_current_ou' };
}

function relativeKeyToPeriodToken(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
}

function getRelativePeriodKeys(relativePeriods) {
  if (!relativePeriods || typeof relativePeriods !== 'object') return [];
  return Object.entries(relativePeriods)
    .filter(([, on]) => on === true)
    .map(([k]) => relativeKeyToPeriodToken(k))
    .sort();
}

function buildVisualizationAnalyticsBlueprint(viz) {
  const dimensions = [];
  const seen = new Set();
  const addDim = (d) => {
    if (!d || seen.has(d)) return;
    seen.add(d);
    dimensions.push(d);
  };

  const mapItems = (arr = []) => arr.map(x => x?.id).filter(Boolean);

  // dx from explicit data dimension items
  const dxItems = [];
  for (const it of (viz.dataDimensionItems || [])) {
    if (it.indicator?.id) dxItems.push(it.indicator.id);
    else if (it.dataElement?.id) dxItems.push(it.dataElement.id);
    else if (it.programIndicator?.id) dxItems.push(it.programIndicator.id);
  }
  if (dxItems.length) addDim(`dx:${dxItems.join(';')}`);

  // pe from fixed periods or relative period keys
  const fixedPe = mapItems(viz.periods);
  if (fixedPe.length) {
    addDim(`pe:${fixedPe.join(';')}`);
  } else {
    if (Array.isArray(viz.rawPeriods) && viz.rawPeriods.length) addDim(`pe:${viz.rawPeriods.join(';')}`);
    else {
      const relPe = getRelativePeriodKeys(viz.relativePeriods);
      if (relPe.length) addDim(`pe:${relPe.join(';')}`);
    }
  }

  // ou from fixed org units or user orgunit flags
  const fixedOu = mapItems(viz.organisationUnits);
  if (fixedOu.length) {
    addDim(`ou:${fixedOu.join(';')}`);
  } else if (viz.userOrganisationUnitGrandChildren) {
    addDim('ou:USER_ORGUNIT_GRANDCHILDREN');
  } else if (viz.userOrganisationUnitChildren) {
    addDim('ou:USER_ORGUNIT_CHILDREN');
  } else if (viz.userOrganisationUnit) {
    addDim('ou:USER_ORGUNIT');
  }

  // Additional fixed dimensions from columns/rows/filters
  const allAxes = [...(viz.columns || []), ...(viz.rows || []), ...(viz.filters || [])];
  for (const axis of allAxes) {
    const dim = axis?.dimension;
    if (!dim || ['dx', 'pe', 'ou'].includes(dim)) continue;
    const ids = mapItems(axis.items || []);
    if (ids.length) addDim(`${dim}:${ids.join(';')}`);
  }

  const params = dimensions.map(d => `dimension=${encodeURIComponent(d)}`).join('&');
  const endpoint = params ? `analytics.json?${params}` : 'analytics.json';
  return { dimensions, endpoint };
}

function isAnalyticsPath(path) {
  const p = String(path || '').toLowerCase();
  return p.includes('analytics.json') || p.includes('/analytics?') || p.endsWith('/analytics');
}

// ── Program-ID cache (used to reject hallucinated program UIDs before they hit analytics) ──
// Analytics endpoints return HTTP 409 "Program does not exist" for an invalid UID, which burns an
// iteration without teaching the model anything. We pre-validate against a cheap, cached list.
let _knownProgramsCache = null;
let _knownProgramsCacheTs = 0;
const _KNOWN_PROGRAMS_TTL_MS = 5 * 60 * 1000;

async function getKnownPrograms() {
  const now = Date.now();
  if (_knownProgramsCache && (now - _knownProgramsCacheTs) < _KNOWN_PROGRAMS_TTL_MS) {
    return _knownProgramsCache;
  }
  const resp = await safeDhis2Fetch('programs?fields=id,displayName,shortName&paging=false');
  if (resp?._error || !Array.isArray(resp?.programs)) return null;
  const byId = new Map();
  for (const p of resp.programs) {
    if (p?.id) byId.set(p.id, p.displayName || p.shortName || p.id);
  }
  _knownProgramsCache = byId;
  _knownProgramsCacheTs = now;
  return byId;
}

// Returns a structured error object with _hint if the analytics path targets a program UID
// that does not exist in this instance, otherwise null. Best-effort: if the cache can't be
// fetched, returns null (let the call through so we don't block real requests on a flaky probe).
async function validateAnalyticsProgramId(path) {
  // Matches: analytics/events/aggregate/{uid}, analytics/events/query/{uid},
  // analytics/enrollments/aggregate/{uid}, analytics/enrollments/query/{uid}
  const m = String(path || '').match(
    /(?:^|\/)analytics\/(events|enrollments)\/(aggregate|query|count)\/([A-Za-z][A-Za-z0-9]{10})(?:[\/.?]|$)/i
  );
  if (!m) return null;
  const [, kind, op, pid] = m;
  const known = await getKnownPrograms();
  if (!known) return null;
  if (known.has(pid)) return null;

  // Unknown UID — return the full program catalog so the model self-corrects in ONE round trip
  // instead of retrying. We cap at 40 entries to bound response size (each entry is ~40 chars).
  const entries = Array.from(known.entries());
  const cap = 40;
  const shown = entries.slice(0, cap).map(([id, name]) => ({ id, name }));
  return {
    _error: `Program UID "${pid}" does NOT exist in this DHIS2 instance. analytics/${kind}/${op}/${pid} will return 409. STOP guessing UIDs.`,
    _hint: 'If you need a program UID: (1) if a prior tool result (discover/list/search_metadata) returned programs, reuse one of THOSE UIDs — never invent a similar-looking one; (2) otherwise call manage_program_indicators(action="discover") or search_metadata(object_type="programs", name_filter="<keyword>") first. For "which OUs have the most data for indicators" use manage_program_indicators(action="rank_ou", indicator_ids=[...]) — no program UID needed from you.',
    _known_program_count: entries.length,
    _known_programs: shown,
    _known_programs_truncated: entries.length > cap ? entries.length - cap : 0,
  };
}

function splitPathAndQuery(path) {
  const raw = String(path || '');
  const qIdx = raw.indexOf('?');
  if (qIdx === -1) return { base: raw, usp: new URLSearchParams() };
  return { base: raw.slice(0, qIdx), usp: new URLSearchParams(raw.slice(qIdx + 1)) };
}

function isCountLikeTrackerQuery(path) {
  const { base, usp } = splitPathAndQuery(path);
  const cleanBase = String(base || '').replace(/^\//, '').replace(/^api\/\d+\//, '');
  if (!/^tracker\/(enrollments|events|trackedEntities)(?:\/|$)/i.test(cleanBase)) return false;

  const pageSize = usp.get('pageSize');
  const totalPages = String(usp.get('totalPages') || '').toLowerCase() === 'true';
  const fields = String(usp.get('fields') || '').trim();
  const idOnlyFields = /^(id|event|enrollment|trackedEntity)(,(id|event|enrollment|trackedEntity))*$/i.test(fields);
  const tinyPage = pageSize === '1' || pageSize === '0';

  return tinyPage || (totalPages && idOnlyFields);
}

function buildCountRecordsRedirect(path, ctx = {}) {
  if (!isCountLikeTrackerQuery(path)) return null;

  const { base, usp } = splitPathAndQuery(path);
  const cleanBase = String(base || '').replace(/^\//, '').replace(/^api\/\d+\//, '');
  const match = cleanBase.match(/^tracker\/(enrollments|events|trackedEntities)(?:\/|$)/i);
  if (!match) return null;

  const trackerType = match[1];
  const recordType = trackerType === 'trackedEntities' ? 'tracked_entities' : trackerType;
  const includeChildren = String(usp.get('ouMode') || '').toUpperCase() === 'DESCENDANTS';
  const suggested = {
    record_type: recordType,
  };

  const programId = usp.get('program') || ctx.programId || null;
  const orgUnitId = usp.get('orgUnit') || ctx.orgUnitId || null;
  if (programId) suggested.program_override = programId;
  if (orgUnitId) suggested.ou_override = orgUnitId;
  if (includeChildren) suggested.include_children = true;

  const stageId = usp.get('programStage') || usp.get('stage');
  if (recordType === 'events' && stageId) suggested.stage_id = stageId;

  const status = usp.get('status') || usp.get('eventStatus') || usp.get('enrollmentStatus');
  if (status) suggested.status = status;

  const dateAfter = usp.get('occurredAfter') || usp.get('enrolledAfter') || usp.get('startDate');
  const dateBefore = usp.get('occurredBefore') || usp.get('enrolledBefore') || usp.get('endDate');
  if (dateAfter) suggested.date_after = dateAfter;
  if (dateBefore) suggested.date_before = dateBefore;

  const filters = usp.getAll('filter');
  if (filters.length) suggested.filters = filters;

  return {
    _error:
      'Blocked: count-like tracker list queries can return totals outside the selected org unit for users with broad access. Use count_records instead so counts stay scoped to the current lowest org unit unless the user explicitly asks for broader scope.',
    _redirect: 'count_records',
    _suggested_args: suggested,
  };
}

function hasDimensionParam(usp, dimKey) {
  const vals = usp.getAll('dimension');
  return vals.some(v => String(v).startsWith(`${dimKey}:`));
}

async function enrichAnalyticsPathWithVisualizationContext(path, vizId) {
  if (!isAnalyticsPath(path) || !vizId) return path;
  const { base, usp } = splitPathAndQuery(path);
  const needsDx = !hasDimensionParam(usp, 'dx');
  const needsPe = !hasDimensionParam(usp, 'pe');
  const needsOu = !hasDimensionParam(usp, 'ou');
  if (!needsDx && !needsPe && !needsOu) return path;

  const fields = [
    'dataDimensionItems[indicator[id],dataElement[id],programIndicator[id]]',
    'periods[id]',
    'rawPeriods',
    'relativePeriods',
    'organisationUnits[id]',
    'userOrganisationUnit',
    'userOrganisationUnitChildren',
    'userOrganisationUnitGrandChildren',
    'columns[dimension,items[id]]',
    'rows[dimension,items[id]]',
    'filters[dimension,items[id]]',
  ].join(',');
  const viz = await safeDhis2Fetch(`visualizations/${vizId}.json?fields=${fields}`);
  if (viz?._error) return path;
  const bp = buildVisualizationAnalyticsBlueprint(viz);
  if (!Array.isArray(bp.dimensions) || !bp.dimensions.length) return path;

  for (const d of bp.dimensions) {
    if (!d.includes(':')) continue;
    const k = d.split(':')[0];
    if ((k === 'dx' && needsDx) || (k === 'pe' && needsPe) || (k === 'ou' && needsOu)) {
      usp.append('dimension', d);
    }
  }

  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}

function isVisualizationValueQuestion(text) {
  const t = normalizePlainText(text);
  if (!t) return false;
  const keys = [
    'value', 'values', 'how much', 'number', 'count', 'total',
    'highest', 'lowest', 'max', 'min', 'compare', 'comparison',
    'trend', 'rate', 'percent', 'percentage', 'average', 'mean',
    'sum', 'which is bigger', 'which is higher',
  ];
  return keys.some(k => t.includes(k));
}

/* Coarse module: DHIS2 URL context, initialization, active-tab synchronization, and line-listing assets. */
importScripts('background/context.js');

/* Coarse module: tool schemas, lazy manuals, contextual selection, and system-prompt construction. */
importScripts('background/tool-definitions.js');

/* Coarse module: OpenAI-compatible and Anthropic streaming adapters, vision analysis, and web search. */
importScripts('background/providers.js');

/* Coarse module: read, analytics, privacy, and central tool-dispatch implementations. */
importScripts('background/tools-read.js');

/* Coarse module: aggregate metadata, datasets, dashboards, forms, translations, plugins, and creation flows. */
importScripts('background/tools-metadata.js');

/* Coarse module: program metadata, notifications, rules, indicators, and architecture operations. */
importScripts('background/tools-programs.js');

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

async function runAgenticLoop(userText, imageBase64, browseWeb = false) {
  acquireKeepalive();
  try {
    return await _runAgenticLoopInner(userText, imageBase64, browseWeb);
  } finally {
    releaseKeepalive();
  }
}

async function _runAgenticLoopInner(userText, imageBase64, browseWeb = false) {
  // Capture the thread identity before the first await. A reset during prompt
  // assembly, vision analysis, or a reliability prefetch must abort this old
  // turn rather than letting it adopt the newly-cleared conversation epoch.
  const turnEpoch = conversationEpoch;
  const priorConversationHistory = conversationHistory.slice();
  const turnStartIdx = 1 + priorConversationHistory.length;
  const charts = [];
  const turnWasReset = () => turnEpoch !== conversationEpoch;
  const abortedTurnResult = () => ({ text: '', charts, streamed: false, aborted: true });

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

  // Seed the known-IDs registry from every verified source available BEFORE
  // any tool call: user text, page context, and already-loaded program/OU/viz/map
  // metadata. The registry grows as tools return data.
  seedKnownIds(userText, ctx);
  seedKnownIcons();
  seedRecentCreations();
  console.log(`[AgenticLoop] knownIds seeded with ${dhis2.knownIds.size} UID(s); knownIcons + recentCreations reset`);

  // ── Dynamic tool selection — send only tools relevant to this request ──
  const contextualTools = getContextualTools(ctx, userText, browseWeb);
  const contextualToolNames = new Set(contextualTools.map(t => t.function.name));
  console.log(`[AgenticLoop] Using ${contextualTools.length}/${TOOLS.length} tools:`,
    [...contextualToolNames].join(', '));

  // ── Two-tier tool docs ──
  // The provider receives SLIM definitions for MANUAL_TOOLS (routing info
  // only); each such tool's full manual is delivered by the gate below on its
  // first call this turn, BEFORE anything executes.
  const wireTools = toWireTools(contextualTools);
  const deliveredManuals = new Set();

  const systemPrompt = await buildSystemPrompt(userText, !!imageBase64, !!browseWeb);
  if (turnWasReset()) return abortedTurnResult();

  // If image is attached, analyze with a vision model first, then include description
  let userContent;
  let historyText = userText;

  if (imageBase64) {
    broadcast({ type: 'AI_THINKING', iteration: 0, label: 'Analyzing attached image' });
    const imageAnalysis = await analyzeImage(imageBase64, userText);
    if (turnWasReset()) return abortedTurnResult();
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
    ...priorConversationHistory,
    { role: 'user', content: userContent },
  ];

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
      if (turnWasReset()) return abortedTurnResult();
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
      if (turnWasReset()) return abortedTurnResult();
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
  const saveDiagDetected = SAVE_FAILURE_RE.test(saveDiagText);
  if (saveDiagDetected && ctx.programId) {
    broadcast({ type: 'AI_THINKING', iteration: 0, label: 'Diagnosing save error' });
    try {
      const diag = await prefetchSaveErrorContext(ctx);
      if (turnWasReset()) return abortedTurnResult();
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
          type: 'AI_TOOL_DONE',
          tool: 'diagnose_save_error',
          success: true,
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

  // Marker: everything in `messages` from this index on is THIS turn (the user
  // message + any prefetch + every assistant/tool message the loop adds). The
  // array was built as [system, ...priorConversationHistory, userMsg], so the
  // user message sits at exactly 1 + priorConversationHistory.length. At turn
  // end we persist
  // messages.slice(turnStartIdx) so the next turn remembers the actual tool
  // calls + results, not just the final prose.
  for (let i = 0; i < 50; i++) {
    if (turnWasReset()) return abortedTurnResult();
    // Contextual thinking label
    const thinkLabel = lastToolName
      ? TOOL_PRESENTATION[lastToolName]?.resultLabel || 'Processing results'
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
      if (turnWasReset()) {
        chunkBuffer = '';
        return;
      }
      if (chunkBuffer) {
        broadcast({ type: 'AI_STREAM_CHUNK', text: chunkBuffer });
        chunkBuffer = '';
      }
    };
    let result;
    try {
      result = await callProviderStreaming(messages, true, (chunk) => {
        if (turnWasReset()) return;
        if (chunk === null) {
          broadcast({ type: 'AI_STREAM_START' });
          streamStartBroadcast = true;
        } else if (streamStartBroadcast) {
          chunkBuffer += chunk;
          if (!flushTimer) flushTimer = setTimeout(flushChunks, FLUSH_MS);
        }
      }, wireTools, i);
    } catch (provErr) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      chunkBuffer = '';
      if (turnWasReset()) return abortedTurnResult();
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
    if (turnWasReset()) {
      if (flushTimer) clearTimeout(flushTimer);
      return abortedTurnResult();
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
        if (turnWasReset()) return abortedTurnResult();
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
          } else {
            try {
              toolResult = await executeTool(tc.function.name, args);
            } catch (toolErr) {
              toolResult = { _error: `Tool failed: ${toolErr.message}` };
            }
            if (turnWasReset()) return abortedTurnResult();
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
    if (turnWasReset()) return abortedTurnResult();
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
      if (turnWasReset()) {
        finalBuf = '';
        return;
      }
      if (finalBuf) { broadcast({ type: 'AI_STREAM_CHUNK', text: finalBuf }); finalBuf = ''; }
    };
    const finalResult = await callProviderStreaming(messages, false, (chunk) => {
      if (turnWasReset()) return;
      if (chunk === null) {
        broadcast({ type: 'AI_STREAM_START' });
        finalStreamStarted = true;
      } else if (finalStreamStarted) {
        finalBuf += chunk;
        if (!finalTimer) finalTimer = setTimeout(flushFinal, 40);
      }
    }, [], 49);
    if (turnWasReset()) {
      if (finalTimer) clearTimeout(finalTimer);
      return abortedTurnResult();
    }
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
  overlay.tabIndex = -1;
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

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      overlay.remove();
    }
  });

  document.body.appendChild(overlay);
  overlay.focus({ preventScroll: true });
}

// ── Broadcasting ─────────────────────────────────────────────────────────────

function broadcast(data) {
  chrome.runtime.sendMessage(data).catch(() => {});
}

async function isCurrentActiveTab(tabId) {
  if (!tabId) return false;
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab?.id === tabId;
}

async function handleContextUpdateMessage(msg, sender) {
  if (sender.tab?.id && !(await isCurrentActiveTab(sender.tab.id))) {
    return { success: true, ignored: 'inactive_tab' };
  }
  const url = msg.payload?.url || sender.tab?.url;
  if (!url) return { error: 'Context update did not include a URL.' };
  const result = await syncPageContextFromUrl(url);
  if (result.success) broadcast({ type: 'CONTEXT_UPDATED', state: result.state });
  return result;
}

async function handleStageDetectedMessage(msg, sender) {
  if (sender.tab?.id && !(await isCurrentActiveTab(sender.tab.id))) {
    return { success: true, ignored: 'inactive_tab' };
  }

  // Content script detected the active stage (from URL hash or DOM observation).
  // The structural UID is cross-checked against the current program's stages.
  const detectedStageId = msg.payload?.stageId;
  if (!detectedStageId || !hasUidShape(detectedStageId)) {
    return { success: false, error: 'Invalid stage ID.' };
  }

  const currentStageId = dhis2.pageContext?.stageId;
  if (detectedStageId === currentStageId) return { success: true, changed: false };
  const knownStages = dhis2.programMetadata?.programStages;
  if (knownStages && !knownStages.some(stage => stage.id === detectedStageId)) {
    return { success: false, error: 'Stage does not belong to the current program.' };
  }

  if (!dhis2.pageContext) dhis2.pageContext = {};
  dhis2.pageContext.stageId = detectedStageId;
  await saveState();
  console.log(`[StageDetect] Active stage updated: ${detectedStageId} (source: ${msg.payload?.source || 'unknown'})`);
  broadcast({ type: 'CONTEXT_UPDATED', state: getSerializableState() });
  return { success: true, changed: true };
}

function parseScreenshotArea(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const area = {
    x: Number(payload.x),
    y: Number(payload.y),
    width: Number(payload.width),
    height: Number(payload.height),
    devicePixelRatio: Number(payload.devicePixelRatio),
  };
  if (!Object.values(area).every(Number.isFinite)) return null;
  if (area.x < 0 || area.y < 0 || area.width < 10 || area.height < 10) return null;
  if (area.devicePixelRatio < 0.25 || area.devicePixelRatio > 8) return null;
  const pixelWidth = area.width * area.devicePixelRatio;
  const pixelHeight = area.height * area.devicePixelRatio;
  if (pixelWidth > 16384 || pixelHeight > 16384 || pixelWidth * pixelHeight > 25_000_000) {
    return null;
  }
  return area;
}

// ── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension's content scripts and pages.
  // Reject anything with an external `sender.id` or an `externally_connectable` origin.
  if (sender.id !== chrome.runtime.id) return false;
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'DHIS2_CONTEXT_UPDATE': {
      handleContextUpdateMessage(msg, sender)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;
    }

    case 'DHIS2_STAGE_DETECTED': {
      handleStageDetectedMessage(msg, sender)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;
    }

    case 'INITIALIZE': {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, async (tabs) => {
        if (tabs[0]?.url) {
          try {
            const r = await syncPageContextFromUrl(tabs[0].url);
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
      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      sendResponse({ status: 'processing' });
      (async () => {
        if (!(await ensureConnected())) {
          throw new Error('Could not connect to the active DHIS2 tab. Open a signed-in DHIS2 page and allow access to that server.');
        }
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.url) throw new Error('No active tab found.');
        const contextResult = await syncPageContextFromUrl(tab.url);
        if (!contextResult.success) throw new Error(contextResult.error || 'Could not refresh DHIS2 page context.');
        return runAgenticLoop(payload.text || '', payload.imageBase64, !!payload.browseWeb);
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
        'openrouter', 'together', 'groq', 'custom',
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
      (async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) throw new Error('No active tab found.');
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: injectedScreenshotSelection,
        });
        return { ok: true };
      })()
        .then(sendResponse)
        .catch((error) => {
          broadcast({ type: 'AI_ERROR', error: 'Cannot capture this page. Try on a regular web page.' });
          sendResponse({ error: error.message });
        });
      return true;
    }

    case 'SCREENSHOT_AREA_SELECTED': {
      // Capture the visible tab, then crop to the selected area
      const area = parseScreenshotArea(msg.payload);
      if (!area) {
        sendResponse({ error: 'Invalid screenshot selection.' });
        return false;
      }
      (async () => {
        if (!sender.tab?.id || !(await isCurrentActiveTab(sender.tab.id))) {
          throw new Error('Screenshot selection came from an inactive tab.');
        }
        const tab = await chrome.tabs.get(sender.tab.id);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const cropped = await cropImage(
          dataUrl,
          area.x,
          area.y,
          area.width,
          area.height,
          area.devicePixelRatio
        );
        broadcast({ type: 'SCREENSHOT_RESULT', dataUrl: cropped });
        return { ok: true };
      })()
        .then(sendResponse)
        .catch((error) => {
          broadcast({ type: 'AI_ERROR', error: 'Screenshot failed: ' + error.message });
          sendResponse({ error: error.message });
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
  if (info.url && (tab.url?.includes('/dhis-web-') || tab.url?.includes('/apps/') || tab.url?.includes('/api/'))) {
    syncFromTab(tabId);
  }
});

chrome.webNavigation?.onReferenceFragmentUpdated?.addListener?.((details) => {
  if (details.url && (details.url.includes('/dhis-web-') || details.url.includes('/apps/'))) {
    chrome.tabs.get(details.tabId).then((tab) => {
      if (tab.active) syncFromTab(details.tabId);
    }).catch(() => {});
  }
});

// Switching to a tab on a different DHIS2 instance must re-initialize the
// connection — without this, dhis2.baseUrl stays pinned to the previously
// focused server and tool calls hit the wrong instance (root cause of the
// "program already exists with id X" false-positive across servers).
async function syncFromTab(tabId) {
  try {
    if (!(await isCurrentActiveTab(tabId))) return;
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return;
    const result = await syncPageContextFromUrl(tab.url);
    if (result.success) broadcast({ type: 'CONTEXT_UPDATED', state: result.state });
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

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setOptions({ enabled: true });
  await syncContentScriptsToGrantedOrigins();
  const granted = await chrome.permissions.getAll().catch(() => ({ origins: [] }));
  await injectMonitorIntoOpenTabs(granted.origins || []);
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
