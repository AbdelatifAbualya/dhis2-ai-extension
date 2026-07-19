/* ══════════════════════════════════════════════════════════════════════════════
   DHIS2 AI Assistant — Background Service Worker (v3.0)
   Handles: DHIS2 detection, metadata, multi-provider LLM agentic loop, tool exec
   ══════════════════════════════════════════════════════════════════════════════ */

// ── Universal Model Provider ─────────────────────────────────────────────────
// Default: Ollama (local, no API key, fully offline). Also supports any
// OpenAI-compatible cloud provider (Fireworks, OpenAI, Anthropic, Google,
// OpenRouter, Together, Groq, xAI Grok, custom) via the same configurable fields:
//   - providerType: routing hint (anthropic uses /v1/messages; others share OAI path)
//   - apiBaseUrl:   e.g. http://localhost:11434/v1 (Ollama)
//                        https://api.openai.com/v1
//                        https://api.anthropic.com
//   - modelId:      provider-specific identifier
//   - maxTokens, temperature, hasThinkBlock (optional)
// Vision model is separately configurable for image analysis.

const DEFAULT_PROVIDER_CONFIG = {
  // ollama|fireworks|openai|anthropic|google|openrouter|together|groq|grok|custom
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

// Hosts that don't require an API key. Used to relax the "no key configured"
// gate so users can run a local Ollama out of the box.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
function isLocalProviderUrl(rawUrl) {
  if (!rawUrl) return false;
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return LOCAL_HOSTNAMES.has(h) || h.endsWith('.local');
}
function isLocalProvider(cfg) {
  if (!cfg) return false;
  if (cfg.providerType === 'ollama') return true;
  return isLocalProviderUrl(cfg.apiBaseUrl);
}
// Strict validator for user-supplied provider/vision URLs.
// Rejects javascript:, data:, file: and anything that doesn't parse.
function isValidProviderUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  let u;
  try { u = new URL(rawUrl.trim()); } catch { return false; }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

let _cachedProviderConfig = { ...DEFAULT_PROVIDER_CONFIG };
let _cachedApiKey = null;

function getProviderConfig() {
  return _cachedProviderConfig;
}

function getChatCompletionsUrl(baseUrl) {
  // Normalize: ensure base URL ends properly and append /chat/completions
  let url = (baseUrl || DEFAULT_PROVIDER_CONFIG.apiBaseUrl).replace(/\/+$/, '');
  // If URL already ends with /chat/completions, use as-is
  if (url.endsWith('/chat/completions')) return url;
  // Users paste full endpoint URLs from provider docs (e.g. xAI's
  // https://api.x.ai/v1/responses) — strip the endpoint back to the base.
  url = url.replace(/\/responses$/, '');
  // Google Gemini: bare domain needs /v1beta/openai prefix for OpenAI-compat
  if (url.match(/generativelanguage\.googleapis\.com\/?$/) || url.endsWith('googleapis.com')) {
    return url + '/v1beta/openai/chat/completions';
  }
  // Bare domain (no path): OpenAI-compatible APIs serve under /v1 — e.g.
  // https://api.x.ai → https://api.x.ai/v1/chat/completions. Users who really
  // need a root-path endpoint can enter the full …/chat/completions URL.
  try {
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') url += '/v1';
  } catch {}
  // If URL ends with /v1, /v1beta/openai, or similar versioned path, append /chat/completions
  return url + '/chat/completions';
}

// HTTP header values must be ISO-8859-1 (Latin-1). API keys pasted from web UIs
// frequently carry invisible Unicode characters (zero-width space, NBSP, smart
// quotes, stray newlines), which cause fetch() to throw
// "String contains non ISO-8859-1 code point". Strip anything outside the
// printable ASCII range plus normal whitespace trimming.
function sanitizeHeaderValue(v) {
  if (v == null) return null;
  // Remove ASCII control chars (including CR/LF) and any non-ASCII code points,
  // then trim whitespace. Preserves the rest of the key as-is. Hard-cap at 4 KB
  // to prevent oversized values from inflating every request body / header.
  const cleaned = String(v).replace(/[^\x20-\x7E]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.length > 4096 ? cleaned.slice(0, 4096) : cleaned;
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
const LINE_LISTING_ROUTER_PATH = 'line-listing/dhis2_extension_router.js';

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
  + '|approve|confirm|proceed|continue|do it|do this|go ahead|just do it'
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
    const bareAffirm = /^\s*(?:please\s+)?(?:yes|yep|yeah|ok(?:ay)?|sure|confirm(?:ed)?|do\s+it|go\s+ahead(?:\s+and\s+(?:do|run)\s+it)?|proceed|continue|go\s+for\s+it|run\s+it|yes,?\s*please)[.!\s]*$/i.test(text);
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
    _hint: 'The IDs being targeted do NOT exist in the current metadata. Inspect logs may carry stale IDs from old/unrelated contexts — those are not proof of a current defect, and inventing "stale cache" explanations is hallucination. STOP modifying things. Show the user the 404 history and ask which CURRENT object (if any) should be acted on. Use manage_program_rules(action=list) / manage_program_indicators(action=list) to see what actually exists.',
    _scope: 'destructive_404_limit_reached',
    _history: (dhis2.destructive404History || []).slice(-5),
  };
}

// ── Per-turn known-IDs registry & verify-before-call gate ───────────────────
// EVERY API call must derive from verified data. The chatbot must never
// construct a path/UID from a guess. dhis2.knownIds is seeded each turn from
// (a) the user message, (b) page context, (c) inspect-snapshot text, (d)
// already-loaded program/OU/viz/map metadata, (e) the persisted conversation
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

function seedKnownIds(userText, ctx, inspectSnapshot) {
  const set = new Set();
  harvestUidsInto(set, userText);
  harvestUidsInto(set, ctx || {});
  if (inspectSnapshot) {
    harvestUidsInto(set, inspectSnapshot.insights || {});
    // The raw logs also frequently contain UIDs (rule IDs, program IDs in URLs).
    harvestUidsInto(set, (inspectSnapshot.logs || []).map(l => `${l.text || ''} ${l.url || ''}`).join('\n'));
  }
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
  // discovery this turn to count as "known"). Could later seed from the inspect
  // snapshot if /icons responses showed up there.
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

// Deterministic stringify (sorted keys, recursively) so the same logical call
// always produces the same signature regardless of key order in the model's JSON.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value)
    .filter(k => value[k] !== undefined)
    .sort()
    .map(k => JSON.stringify(k) + ':' + stableStringify(value[k]))
    .join(',') + '}';
}

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

// "Incomplete call" = the model failed to SERIALIZE its arguments (empty args, a
// dispatcher's "Missing required parameter", or a truncated/empty-placeholder
// create_program payload flagged by validateAndHealProgramInput). Unlike a
// doomed OPERATION (a rejected expression, a bad UID), the fix is always "resend
// the COMPLETE call" — so these must NEVER disable the tool: a well-formed retry
// is exactly what should happen. We still refuse an identical empty REPEAT (no
// spam), but with recovery framing and a non-disabling scope. Detected by an
// explicit flag/scope from the tool, or by the error text as a fallback.
function isIncompleteCallError(resultOrText) {
  if (resultOrText && typeof resultOrText === 'object') {
    if (resultOrText._no_disable === true) return true;
    if (resultOrText._scope === 'incomplete_call' || resultOrText._scope === 'incomplete_call_repeat') return true;
    resultOrText = toolFailureText(resultOrText);
  }
  return /missing required parameter|missing program_name|input looks incomplete|input is missing \d+ required field|incomplete\/truncated|arguments? (?:were|was|arrived) (?:empty|incomplete|truncated)|did not arrive intact|missing required property/i
    .test(String(resultOrText || ''));
}

// Recover a streamed tool-call `arguments` JSON string that did not parse — the
// common failure on weaker / custom OpenAI-compatible models (e.g. MiniMax)
// under a large payload: the stream truncates mid-object, or leaks provider
// separator tokens like `]<]minimax[>[` into the buffer. Returns
// { ok:true, text, lossy } with a parseable JSON string when recovered, else
// { ok:false }. `lossy:false` means the payload is intact after stripping leaked
// tokens — safe to execute. `lossy:true` means braces had to be balanced /
// strings closed, i.e. THE TAIL OF THE PAYLOAD WAS LOST: executing it would
// silently run a partial call (e.g. a create_program missing its last stages
// and rules that then "succeeds"), so callers must treat it as corrupted and
// ask the model to resend/split instead. Never throws. Pure — safe to unit test.
function repairToolCallArguments(raw) {
  const s0 = String(raw == null ? '' : raw);
  const tryParse = (t) => { try { JSON.parse(t); return true; } catch { return false; } };
  if (tryParse(s0)) return { ok: true, text: s0, lossy: false };
  // Strip leaked provider separator tokens ( ]<]word[>[ ) and stray control chars.
  let s = s0.replace(/\]?<\]\w+\[>\[?/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  if (tryParse(s)) return { ok: true, text: s, lossy: false };
  // Isolate the outermost object/array of a stream truncated before it closed.
  const start = s.search(/[{[]/);
  if (start === -1) return { ok: false };
  s = s.slice(start).replace(/,\s*$/, '').replace(/:\s*$/, '').replace(/,\s*([}\]])/g, '$1');
  // Balance braces/brackets that are open outside of a string literal.
  let inStr = false, esc = false;
  const stack = [];
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) s += '"';               // close an unterminated string
  s = s.replace(/,\s*$/, '');
  while (stack.length) s += (stack.pop() === '{' ? '}' : ']');
  return tryParse(s) ? { ok: true, text: s, lossy: true } : { ok: false };
}

// ── Tool-call argument shape healing ─────────────────────────────────────────
// Grammar-constrained providers can mangle NESTED structures in tool-call
// arguments: given an item schema of bare `{type:'object'}`, Fireworks'
// constrained decoder (observed live with MiniMax-M3, 2026-07-18) emits each
// item as `{"$text": "<the intended object serialized as a JSON string>"}` —
// and some models stringify nested objects/arrays outright ("body": "{…}").
// Executing those shapes fails validation with misleading "missing required
// field" errors even though the model's INTENT was complete and correct.
// Heal generically (any tool, any provider):
//   • an object whose ONLY key is $text (string) → parse the string as JSON
//     when possible (else use the raw string);
//   • an array item / object value that is a string LOOKING like a JSON
//     object/array and parsing cleanly → parsed value.
// Plain strings that don't parse as JSON containers are never touched.
// Returns { value, healed }. Pure — safe to unit test.
function healToolArgumentShape(value, depth = 0) {
  if (depth > 12) return { value, healed: false };
  const tryParseContainer = (s) => {
    const t = String(s).trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
    try {
      const p = JSON.parse(t);
      return (p && typeof p === 'object') ? p : undefined;
    } catch { return undefined; }
  };
  if (Array.isArray(value)) {
    let healed = false;
    const out = value.map(item => {
      if (typeof item === 'string') {
        const parsed = tryParseContainer(item);
        if (parsed !== undefined) {
          healed = true;
          const inner = healToolArgumentShape(parsed, depth + 1);
          return inner.value;
        }
        return item;
      }
      const r = healToolArgumentShape(item, depth + 1);
      if (r.healed) healed = true;
      return r.value;
    });
    return { value: out, healed };
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$text' && typeof value.$text === 'string') {
      const parsed = tryParseContainer(value.$text);
      if (parsed !== undefined) {
        const inner = healToolArgumentShape(parsed, depth + 1);
        return { value: inner.value, healed: true };
      }
      return { value: value.$text, healed: true };
    }
    let healed = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = healToolArgumentShape(v, depth + 1);
      if (r.healed) healed = true;
      out[k] = r.value;
    }
    return { value: out, healed };
  }
  return { value, healed: false };
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
        // Incomplete/malformed call: refuse the identical empty repeat, but with
        // recovery framing and a NON-disabling scope — the model must be free to
        // send a well-formed call next (see isIncompleteCallError).
        if (isIncompleteCallError(prev.error)) {
          // The non-disabling refusal exists so a CORRECTED retry stays open —
          // but a model that re-sends the byte-identical empty/partial call
          // forever must not burn the whole iteration budget on it (observed
          // live 2026-07-18: 22 identical `rules:[{}]` repeats). After 3
          // blocked identical repeats, escalate to the disabling scope so the
          // circuit breaker ends the loop; a retry with DIFFERENT (fixed)
          // arguments is a different signature and is never affected.
          if ((prev.blockedAttempts || 0) >= 3) {
            return {
              _error: `BLOCKED: ${toolName} has now sent the SAME incomplete arguments ${prev.count + prev.blockedAttempts} times ("${prev.error}"). Re-sending them again will never work.`,
              _hint: `STOP repeating this exact call. Either send the tool call with COMPLETE, fully-populated arguments (every required field), or give the user your final answer now: what was created (names + IDs), what remains, and what blocked you.`,
              _scope: 'no_progress_repeat',
              _previous_error: prev.error,
              _identical_failures: prev.count,
            };
          }
          return {
            _error: `Your last ${toolName} call was refused because it repeated an INCOMPLETE call: "${prev.error}". `,
            _hint: `This is not a doomed operation — it means the arguments did not arrive intact (empty or truncated tool-call JSON). Re-send the COMPLETE ${toolName} call with EVERY required field populated. Do NOT send the same empty/partial arguments again. The tool stays fully available; a well-formed call will run normally.`,
            _scope: 'incomplete_call_repeat',
            _no_disable: true,
            _previous_error: prev.error,
            _identical_failures: prev.count,
          };
        }
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
      // A run of incomplete/malformed calls (empty args, "missing required
      // parameter", truncated payloads) must not disable the tool — steer the
      // model to send ONE complete call, keeping the tool available.
      if (isIncompleteCallError(worstFamily)) {
        return {
          _error: `${toolName}${args?.action ? `(action=${args.action})` : ''} has been called ${worst} times this turn with INCOMPLETE arguments ("${worstFamily}").`,
          _hint: `The arguments keep arriving empty or truncated. Send ONE complete ${toolName} call with every required field populated — or, if you cannot, give the user a final answer describing what you were trying to create and ask them to retry. The tool remains available for a well-formed call.`,
          _scope: 'incomplete_call_repeat',
          _no_disable: true,
          _family_error: worstFamily,
          _family_failures: worst,
        };
      }
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

// ── No-progress guard (repeated identical SUCCESSFUL calls) ─────────────────
// Every guard above only reacts to FAILURES. A call that keeps SUCCEEDING with
// the same useless result made no progress yet slipped past all of them — the
// model re-listed a dashboard 45× while narrating an action it never issued,
// running out the whole iteration budget (2026-07-13). This counts identical
// (tool, args) EXECUTIONS this turn and refuses further repeats once the model
// is clearly looping. NO_PROGRESS_REPEAT_LIMIT is generous (a legit turn may
// re-read the same list twice — e.g. before and after a write) so it never
// bites a real build; a 3rd+ byte-identical execution is a loop.
const NO_PROGRESS_REPEAT_LIMIT = 3;

// Record a dispatched tool call (called AFTER it executes, on success OR error).
// Returns the running count of identical (tool, args) executions this turn.
// Fires on success too — that is the whole point; the failure guards already
// cover the error case.
function noteExecutedCall(toolName, args) {
  if (!(dhis2.executedCallSigs instanceof Map)) dhis2.executedCallSigs = new Map();
  const sig = failedCallSignature(toolName, args);
  const count = (dhis2.executedCallSigs.get(sig) || 0) + 1;
  dhis2.executedCallSigs.set(sig, count);
  return count;
}

// Pre-flight refusal for a call that already executed with byte-identical args
// NO_PROGRESS_REPEAT_LIMIT times this turn. Applies to every tool (including
// read-only discovery tools — those are exactly what a no-progress loop spins
// on). Fed into the agentic loop's circuit breaker via _scope so a model that
// keeps re-emitting it has the tool physically removed, guaranteeing the loop
// terminates instead of exhausting the budget.
function noProgressStopOrNull(toolName, args) {
  if (!(dhis2.executedCallSigs instanceof Map) || !dhis2.executedCallSigs.size) return null;
  const count = dhis2.executedCallSigs.get(failedCallSignature(toolName, args)) || 0;
  if (count < NO_PROGRESS_REPEAT_LIMIT) return null;
  return {
    _error: `BLOCKED: ${toolName}${args?.action ? `(action=${args.action})` : ''} has already run ${count} times this turn with identical arguments and returned the same result each time — re-running it makes no progress.`,
    _hint: `You are looping on a call that changes nothing. STOP re-checking and do ONE of: (a) issue the NEXT concrete action with DIFFERENT arguments or a DIFFERENT tool, or (b) give the user your final answer now — what you have done so far (names + IDs), what still needs doing, and any tool you are missing to finish. Do NOT call ${toolName} with these arguments again.`,
    _scope: 'no_progress_repeat',
    _identical_executions: count,
  };
}

// ── Discovery-streak guard (read-only calls with no intervening write) ───────
// noProgressStopOrNull only catches BYTE-IDENTICAL repeats. A model can instead
// spin on read-only calls with DIFFERENT args — 30+ check_existing / search /
// discover_icons calls, each narrating "now I'll build the payload" but never
// writing (real 2026-07-14 session; the program was never created). Every
// existing guard missed it: the args differ (no-progress guard), the calls
// SUCCEED (failure guards), and they are HTTP 200 (http-error guard). This
// counts consecutive discovery calls and, once the model has clearly gathered
// enough without acting, refuses further discovery and points it at the write.
// The counter (dhis2.consecutiveDiscoveryCalls) is reset by the agent loop on
// any successful non-discovery (write/action) call and at the start of a turn.
const DISCOVERY_STREAK_LIMIT = 12;
const DISCOVERY_ONLY_TOOLS = new Set([
  'architect_metadata',            // lookup_schema/check_existing/verify/browse_docs/inspect — all read-only
  'search_metadata', 'count_records', 'get_program_info',
  'get_program_recent_changes', 'get_event_analytics',
]);
const DISCOVERY_ACTIONS = {
  manage_metadata: new Set(['discover_icons', 'check_references']),
  manage_program_rules: new Set(['list', 'get']),
  manage_program_indicators: new Set(['list', 'get']),
  manage_program_notifications: new Set(['list', 'get']),
  manage_backups: new Set(['list', 'get']),
};
function isDiscoveryCall(toolName, args) {
  if (DISCOVERY_ONLY_TOOLS.has(toolName)) return true;
  if (toolName === 'dhis2_query') return String(args?.method || 'GET').toUpperCase() === 'GET';
  const acts = DISCOVERY_ACTIONS[toolName];
  return !!(acts && args && acts.has(args.action));
}
function discoveryStreakStopOrNull(toolName, args) {
  if (!isDiscoveryCall(toolName, args)) return null;
  const streak = dhis2.consecutiveDiscoveryCalls || 0;
  if (streak < DISCOVERY_STREAK_LIMIT) return null;
  return {
    _error: `STOP researching: ${streak} read-only/discovery calls in a row this turn with NOTHING created or changed. You already have enough information to act.`,
    _hint: `Issue the actual write the task needs NOW. To build a program, send create_metadata(action=create_program) — it auto-reuses existing option sets / data elements / attributes by exact name, so you do NOT need to look each one up first. For a small/medium program put ALL components in that one call; for a VERY LARGE program (>2 stages / >40 data elements / >20 rules) send the shell + attributes + first stage now, then add_stage and add_program_rules calls for the rest. If you truly cannot proceed, give the user a final answer stating what is blocking you. Do NOT make another discovery call.`,
    _scope: 'no_progress_repeat',   // feeds the circuit breaker: if the model ignores this and keeps spinning, the discovery tool is disabled and the loop ends
    _discovery_streak: streak,
  };
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
  // Refuse a call that keeps SUCCEEDING with no progress (identical repeats).
  const noProgress = noProgressStopOrNull(toolName, args);
  if (noProgress) return noProgress;
  // Refuse an endless run of read-only discovery calls that never writes.
  const discoveryStop = discoveryStreakStopOrNull(toolName, args);
  if (discoveryStop) return discoveryStop;
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
    _hint: 'Every API call must derive from verified data. The UID(s) above were not in: the user message, page context, inspect logs, the conversation history, or any prior tool result. Possible causes: (a) the UID is hallucinated — call a discovery tool first (search_metadata / list / get_program_info) to find the real UID, (b) the UID came from a stale source — verify it exists. Do NOT construct paths from guesses. IMPORTANT: this refusal is a client-side gate and says NOTHING about server state — never tell the user the object "is already gone", "was deleted", or "does not exist" based on this refusal.',
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
        _hint: 'Inspect logs and prior conversation may reference IDs that are not in the current metadata. Do NOT invent context like "stale cache" — DHIS2 has no client-side rule cache that returns ghost objects. Either (a) confirm with the user which CURRENT object to operate on, or (b) call the corresponding list action to see what actually exists.',
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

const INSPECT_MAX_LOGS = 250;
const INSPECT_MAX_REQUESTS = 300;
const INSPECT_TEXT_LIMIT = 1800;
const inspectCapture = {
  active: false,
  attached: false,
  tabId: null,
  url: null,
  startedAt: null,
  logs: [],
  requests: new Map(),
};

function inspectNow() {
  return new Date().toISOString();
}

function clipText(value, limit = INSPECT_TEXT_LIMIT) {
  const s = String(value ?? '');
  return s.length > limit ? s.slice(0, limit) + '...[truncated]' : s;
}

function getArgText(arg) {
  if (!arg) return '';
  if (Object.prototype.hasOwnProperty.call(arg, 'value')) {
    try {
      return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  return arg.description || arg.unserializableValue || arg.className || arg.type || '';
}


function pushInspectLog(entry) {
  if (!inspectCapture.active || !inspectCapture.tabId) return;
  const normalized = {
    time: entry.time || inspectNow(),
    level: entry.level || 'info',
    source: entry.source || 'unknown',
    kind: entry.kind || entry.source || 'log',
    text: clipText(entry.text || ''),
    url: entry.url || null,
    line: entry.line ?? null,
    column: entry.column ?? null,
    requestId: entry.requestId || null,
    method: entry.method || null,
    status: entry.status ?? null,
    statusText: entry.statusText || null,
    stack: entry.stack || null,
  };
  inspectCapture.logs.push(normalized);
  if (inspectCapture.logs.length > INSPECT_MAX_LOGS) {
    inspectCapture.logs.splice(0, inspectCapture.logs.length - INSPECT_MAX_LOGS);
  }
}

function rememberInspectRequest(requestId, data) {
  if (!requestId) return;
  inspectCapture.requests.set(requestId, {
    ...(inspectCapture.requests.get(requestId) || {}),
    ...data,
  });
  if (inspectCapture.requests.size > INSPECT_MAX_REQUESTS) {
    const firstKey = inspectCapture.requests.keys().next().value;
    inspectCapture.requests.delete(firstKey);
  }
}

function formatStackTrace(stackTrace) {
  const frames = stackTrace?.callFrames || [];
  if (!frames.length) return null;
  return frames.slice(0, 6).map(f => ({
    functionName: f.functionName || '(anonymous)',
    url: f.url || null,
    line: f.lineNumber != null ? f.lineNumber + 1 : null,
    column: f.columnNumber != null ? f.columnNumber + 1 : null,
  }));
}

function parseProgramRuleInsight(text) {
  const s = String(text || '');
  if (!/\bRule\b/.test(s) || !/\braised an\b|\braised an unexpected exception\b/.test(s)) return null;
  const idMatch = s.match(/\bwith id ([A-Za-z][A-Za-z0-9]{10})\b/);
  const nameMatch = s.match(/^Rule\s+(.+?)\s+with id\s+[A-Za-z][A-Za-z0-9]{10}\s+executed/s);
  const errorMatch = s.match(/\braised an (?:unexpected exception|error):\s*([\s\S]+)/);
  const refs = Array.from(new Set(Array.from(s.matchAll(/#\{([^}]+)\}/g)).map(m => m[1]))).slice(0, 60);
  const functions = Array.from(new Set(Array.from(s.matchAll(/\bd2:[A-Za-z0-9_]+/g)).map(m => m[0]))).slice(0, 30);
  return {
    type: 'program_rule_error',
    rule_id: idMatch?.[1] || null,
    rule_name: nameMatch?.[1]?.trim() || null,
    error: clipText(errorMatch?.[1] || s, 1000),
    referenced_variables: refs,
    d2_functions: functions,
  };
}

// Classifies a log entry as a known-benign pattern that should NOT trigger
// destructive "fixes". Returns the reason string if benign, else null.
// Keeping this list tight on purpose: only patterns we know the DHIS2 server
// returns by design or are unrelated to app functionality.
function classifyBenignInspectPattern(log) {
  const txt = String(log?.text || '');
  const url = String(log?.url || '');
  const status = Number(log?.status);

  // staticContent/logo_banner|logo_front 404 = no custom logo uploaded (normal).
  if (/staticContent\/(logo_banner|logo_front)/i.test(url + ' ' + txt) && (status === 404 || /404/.test(txt))) {
    return 'staticContent logo 404: no custom logo set — DHIS2 falls back to default. Harmless.';
  }
  // dataStore namespace keys for app-owned caches 404 = lazy-init, not a defect.
  if (/dataStore\/(capture|settings|user-settings|userDataStore)\//i.test(url + ' ' + txt) && (status === 404 || /404/.test(txt))) {
    return 'dataStore namespace key 404: app-owned cache key not yet created. The owning app recreates it on first use. Do NOT write defaults from the assistant.';
  }
  // Vendor-prefix CSS warnings from the style injector.
  if (/stylesheet|css/i.test(log?.kind || '') && /(-moz-|-ms-|-webkit-|vendor prefix|-o-)/i.test(txt)) {
    return 'Vendor-prefix CSS rejection: cosmetic browser behavior. Unrelated to app load.';
  }
  if (/rule was ignored due to bad selector|unknown property name|unreachable code after return statement/i.test(txt)) {
    return 'Browser CSS/JS style lint: cosmetic. Unrelated to app functionality.';
  }
  // Favicons, source maps, and manifest 404s.
  if (/(favicon\.ico|\.map(\b|$)|site\.webmanifest|apple-touch-icon)/i.test(url + ' ' + txt) && (status === 404 || /404/.test(txt))) {
    return 'Asset 404 (favicon/sourcemap/manifest): cosmetic. Unrelated to app failure.';
  }
  return null;
}

function parseInspectInsights(logs) {
  const ruleErrors = [];
  const missingResources = [];
  const unknownFunctions = [];
  const benign = [];
  for (const log of logs) {
    const txt = log.text || '';
    const rule = parseProgramRuleInsight(txt);
    if (rule) {
      ruleErrors.push(rule);
      if (/Unknown function or constant/i.test(txt)) unknownFunctions.push(rule);
      continue;
    }
    const status = Number(log.status);
    const looksLikeError = status >= 400 || /\bstatus of 4\d\d\b|\bstatus of 5\d\d\b|Failed to load resource/i.test(txt);
    if (looksLikeError) {
      const benignReason = classifyBenignInspectPattern(log);
      if (benignReason) {
        benign.push({
          status: status || null,
          url: log.url || extractUrlFromText(txt),
          reason: benignReason,
          text: clipText(txt, 300),
        });
      } else {
        missingResources.push({
          status: status || null,
          url: log.url || extractUrlFromText(txt),
          text: clipText(txt, 600),
        });
      }
    }
  }
  return {
    rule_errors: ruleErrors.slice(-20),
    network_errors: missingResources.slice(-30),
    unknown_rule_functions: unknownFunctions.slice(-10),
    benign_ignored: benign.slice(-20),
    _diagnostic_policy: 'network_errors and rule_errors may indicate real defects. benign_ignored is the server/browser behaving as designed — do NOT propose fixes for these. If only benign_ignored entries are present, the Inspect logs do not justify destructive metadata changes.',
  };
}

function extractUrlFromText(text) {
  const hit = String(text || '').match(/https?:\/\/\S+|\/api\/\S+|\/[A-Za-z0-9/_?=&.%:-]+/);
  return hit ? hit[0].replace(/[),.;]+$/, '') : null;
}

function buildInspectSnapshot() {
  const logs = inspectCapture.logs.slice(-120);
  const counts = logs.reduce((acc, l) => {
    const key = l.level || 'info';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    enabled: inspectCapture.active,
    attached: inspectCapture.attached,
    tabId: inspectCapture.tabId,
    url: inspectCapture.url,
    startedAt: inspectCapture.startedAt,
    captured: inspectCapture.logs.length,
    included: logs.length,
    counts,
    insights: parseInspectInsights(logs),
    logs,
  };
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

// Lowercase only — preserves punctuation and hyphens. Use for substring checks
// that must match literals like "sub-" (see userExplicitlyWantsDescendants).
// NB: the file historically declared a SECOND, aggressive `normalizeText` far
// below; function-hoisting made that one silently win everywhere and quietly
// broke the "sub-" trigger. The two behaviours are now distinct and explicit:
// lowercaseText (here) and normalizeSearchTokens (below).
function lowercaseText(v) {
  return String(v || '').toLowerCase();
}

// Lowercase + collapse every non-alphanumeric run to a single space + trim.
// For tokenized keyword search only — do NOT use where hyphens/punctuation
// carry meaning (that was the bug that killed the "sub-" descendant trigger).
function normalizeSearchTokens(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isLikelyDhisUid(v) {
  const s = String(v || '');
  if (!/^[A-Za-z][A-Za-z0-9]{10}$/.test(s)) return false;
  // Reject English-word-shaped tokens. DHIS2 generates base62 UIDs, so a real
  // UID virtually always contains a digit OR mixes upper+lower case after
  // position 0 (e.g. "XGcG2PFIvOU", "a3kGcGpz8FJ"). Single-case words like
  // "Respiratory", "Information", "Development", "Environment" — all 11 chars
  // — must NOT be accepted; when they are, free-text scans mis-fire and
  // trigger bogus API calls (e.g. get_visualization_details with id=Respiratory).
  if (/\d/.test(s)) return true;
  const rest = s.slice(1);
  return /[A-Z]/.test(rest) && /[a-z]/.test(rest);
}
// Structural UID match from trusted positions (URL path/query/hash). DHIS2
// serves these directly so we accept the full 11-char charset without the
// entropy requirement above.
function hasUidShape(v) {
  return /^[A-Za-z][A-Za-z0-9]{10}$/.test(String(v || ''));
}

function extractVisualizationIdFromInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (isLikelyDhisUid(raw)) return raw;

  // Attempt URL parse. If this IS a URL we ONLY accept UIDs from well-known
  // structural positions (path segment after `/visualizations/`, query `id=`,
  // hash-route `#/<UID>`). We deliberately do NOT fall back to raw word-scanning
  // inside URL strings — e.g. "valorie-insinuative-wanda.ngrok-free.dev"
  // contains the 11-char token "insinuative" which passes isLikelyDhisUid but
  // is obviously not a DHIS2 UID.
  let isUrl = false;
  try {
    const u = new URL(raw);
    isUrl = true;
    const hash = u.hash || '';
    const hashRoute = hash.split('?')[0] || '';
    if (hashRoute.startsWith('#/')) {
      const seg = decodeURIComponent(hashRoute.slice(2)).split('/')[0];
      if (hasUidShape(seg)) return seg;
    }

    if (hash.includes('?')) {
      const hp = new URLSearchParams(hash.split('?')[1]);
      const hashId = hp.get('id') || hp.get('visualization');
      if (hasUidShape(hashId)) return hashId;
    }

    const qpId = u.searchParams.get('id') || u.searchParams.get('visualization');
    if (hasUidShape(qpId)) return qpId;

    const pathParts = u.pathname.split('/').filter(Boolean);
    const pIdx = pathParts.findIndex((p) => p === 'visualizations');
    if (pIdx !== -1 && pathParts[pIdx + 1]) {
      const pId = pathParts[pIdx + 1].replace(/\.json$/i, '');
      if (hasUidShape(pId)) return pId;
    }
  } catch {}

  if (isUrl) return null; // never word-scan inside an URL
  // Free-text word scan: use strict isLikelyDhisUid so English words like
  // "Respiratory"/"Information" (11-char, all-lowercase-after-capital) do NOT
  // match — they would otherwise trigger bogus get_visualization_details 404s.
  const directHit = raw.match(/\b([A-Za-z][A-Za-z0-9]{10})\b/);
  return directHit && isLikelyDhisUid(directHit[1]) ? directHit[1] : null;
}

function extractVisualizationIdFromText(text) {
  const t = String(text || '');
  if (!t) return null;
  const urlHit = t.match(/https?:\/\/\S+/i);
  if (urlHit) {
    const fromUrl = extractVisualizationIdFromInput(urlHit[0]);
    if (fromUrl) return fromUrl;
  }
  // Strip URLs before the fallback word-scan so tokens inside hostnames
  // (e.g. "insinuative" in "valorie-insinuative-wanda.ngrok.dev") are not
  // mistaken for DHIS2 UIDs.
  const stripped = t.replace(/https?:\/\/\S+/gi, ' ');
  const uidHit = stripped.match(/\b([A-Za-z][A-Za-z0-9]{10})\b/);
  return uidHit ? uidHit[1] : null;
}

function extractMapIdFromInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (isLikelyDhisUid(raw)) return raw;

  try {
    const u = new URL(raw);
    const hash = u.hash || '';
    const hashRoute = hash.split('?')[0] || '';
    if (hashRoute.startsWith('#/')) {
      const seg = decodeURIComponent(hashRoute.slice(2)).split('/')[0];
      if (hasUidShape(seg)) return seg;
    }

    if (hash.includes('?')) {
      const hp = new URLSearchParams(hash.split('?')[1]);
      const hashId = hp.get('id') || hp.get('map');
      if (hasUidShape(hashId)) return hashId;
    }

    const qpId = u.searchParams.get('id') || u.searchParams.get('map');
    if (hasUidShape(qpId)) return qpId;

    const pathParts = u.pathname.split('/').filter(Boolean);
    const pIdx = pathParts.findIndex((p) => p === 'maps');
    if (pIdx !== -1 && pathParts[pIdx + 1]) {
      const pId = pathParts[pIdx + 1].replace(/\.json$/i, '');
      if (hasUidShape(pId)) return pId;
    }
  } catch {}

  const directHit = raw.match(/\b([A-Za-z][A-Za-z0-9]{10})\b/);
  return directHit && isLikelyDhisUid(directHit[1]) ? directHit[1] : null;
}

function extractMapIdFromText(text) {
  const t = String(text || '');
  if (!t) return null;
  const urlHit = t.match(/https?:\/\/\S+/i);
  if (urlHit) {
    const fromUrl = extractMapIdFromInput(urlHit[0]);
    if (fromUrl) return fromUrl;
  }
  const uidHit = t.match(/\b([A-Za-z][A-Za-z0-9]{10})\b/);
  return uidHit ? uidHit[1] : null;
}

// DHIS2 auth is handled ENTIRELY by the browser session of the logged-in
// DHIS2 tab. `credentials: 'include'` on each fetch sends the session cookie.
// No Authorization header is ever built or sent, and no credentials are
// stored by the extension.

function userExplicitlyWantsDescendants(userText) {
  const t = lowercaseText(userText);
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
  // Even when we have a live connection, verify it still matches the active
  // DHIS2 tab. Without this, switching between two DHIS2 instances leaves
  // dhis2.baseUrl pointing at the prior server and tools (notably the
  // create_program name-collision probe) silently hit the wrong instance and
  // return stale UIDs.
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.url) {
      const activeBaseUrl = extractBaseUrl(activeTab.url);
      if (activeBaseUrl && dhis2.baseUrl && activeBaseUrl !== dhis2.baseUrl) {
        const r = await initializeFromUrl(activeTab.url);
        if (!r?.error) return dhis2.connected && !!dhis2.baseUrl;
        // Re-init failed — fall through and try the legacy paths so we still
        // return a usable answer (better than blocking the user entirely).
      }
    }
  } catch {}

  if (dhis2.connected && dhis2.baseUrl) return true;
  try {
    const stored = await chrome.storage.session.get(['dhis2Full']);
    if (stored.dhis2Full?.connected && stored.dhis2Full?.baseUrl) {
      Object.assign(dhis2, stored.dhis2Full);
      return true;
    }
  } catch {}
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const result = await initializeFromUrl(tab.url);
      return result.success === true;
    }
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
      // message — the live array may carry large inspect-log/web blocks we do
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
async function clearConversationState() {
  historyExplicitlyCleared = true;
  conversationEpoch++;
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
  // Cross-turn write-approval memory: a proposal from the old thread must not
  // be redeemable by a bare "yes" in the new one.
  dhis2.lastRefusedWrite = null;
  dhis2.turnCounter = 0;

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
  const t = normalizeSearchTokens(text);
  if (!t) return false;
  const keys = [
    'value', 'values', 'how much', 'number', 'count', 'total',
    'highest', 'lowest', 'max', 'min', 'compare', 'comparison',
    'trend', 'rate', 'percent', 'percentage', 'average', 'mean',
    'sum', 'which is bigger', 'which is higher',
  ];
  return keys.some(k => t.includes(k));
}

// ── URL Parsing ──────────────────────────────────────────────────────────────

function extractBaseUrl(url) {
  try {
    const m = url.match(/(https?:\/\/[^/]+(?:\/[^/]+)*?)\/(?:dhis-web-|api\/|apps\/)/);
    if (m) return m[1];
    const u = new URL(url);
    // chrome://, chrome-extension://, about:, file:, devtools:// etc. cannot
    // host a DHIS2 instance and Fetch refuses them anyway. Returning null here
    // stops syncFromTab/initializeFromUrl from issuing the impossible
    // "Fetch API cannot load chrome://.../api/system/info" call when the user
    // briefly focuses chrome://extensions or chrome://newtab.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length > 0 ? `${u.origin}/${parts[0]}` : u.origin;
  } catch { return null; }
}

function extractContext(url) {
  const ctx = {};
  try {
    const u = new URL(url);
    const hash = u.hash;
    // Read identifiers from BOTH location.hash (HashRouter apps like
    // Aggregate Data Entry) AND location.search (BrowserRouter apps and the
    // legacy /dhis-web-dataentry endpoint), so we catch the OU/dataset/period
    // regardless of which router the app uses. Order matters: hash query
    // wins because in HashRouter apps location.search is often stale.
    const sources = [];
    if (hash && hash.includes('?')) sources.push(new URLSearchParams(hash.split('?')[1]));
    sources.push(u.searchParams);
    const trackerKeys = ['programId','orgUnitId','teiId','enrollmentId','stageId','eventId','trackedEntityTypeId'];
    for (const src of sources) {
      for (const k of trackerKeys) {
        if (ctx[k]) continue;
        const v = src.get(k);
        if (v && v !== 'null') ctx[k] = v;
      }
    }
    if (hash) {
      const routePath = hash.split('?')[0] || '';
      if (routePath.startsWith('#/')) {
        const firstSeg = decodeURIComponent(routePath.slice(2)).split('/')[0];
        if (firstSeg) ctx.route = firstSeg;
      }
    }
    const apps = {
      'apps/capture':'Capture','dhis-web-capture':'Capture',
      'apps/tracker-capture':'Tracker Capture','dhis-web-tracker-capture':'Tracker Capture',
      'apps/data-entry':'Data Entry','dhis-web-data-entry':'Data Entry','dhis-web-dataentry':'Data Entry',
      'apps/maintenance':'Maintenance','dhis-web-maintenance':'Maintenance',
      'apps/dashboard':'Dashboard','dhis-web-dashboard':'Dashboard',
      'apps/data-visualizer':'Data Visualizer','dhis-web-data-visualizer':'Data Visualizer',
      'apps/aggregate-data-entry':'Aggregate Data Entry','dhis-web-aggregate-data-entry':'Aggregate Data Entry',
      'apps/dataset-report':'Dataset Report','dhis-web-dataset-report':'Dataset Report',
      'apps/reporting':'Reporting',
      'apps/line-listing':'Line Listing','dhis-web-line-listing':'Line Listing',
      'apps/pivot':'Pivot Table','dhis-web-pivot':'Pivot Table',
      'apps/maps':'Maps','dhis-web-maps':'Maps',
    };
    for (const [pat, name] of Object.entries(apps)) {
      if (url.includes(pat)) { ctx.appType = name; break; }
    }

    // Data Visualizer routes often look like: .../apps/data-visualizer#/XGcG2PFIvOU
    // URL-structural positions use the looser hasUidShape — DHIS2 serves these IDs
    // directly, so we don't need the entropy check that guards free-text scans.
    if (ctx.appType === 'Data Visualizer') {
      if (hasUidShape(ctx.route)) ctx.visualizationId = ctx.route;
      if (!ctx.visualizationId && hash) {
        const routePath = hash.split('?')[0] || '';
        const segs = routePath.replace(/^#\/?/, '').split('/').filter(Boolean);
        for (const seg of segs) {
          const s = decodeURIComponent(seg);
          if (hasUidShape(s)) {
            ctx.visualizationId = s;
            break;
          }
        }
      }
      if (!ctx.visualizationId && hash && hash.includes('?')) {
        const p = new URLSearchParams(hash.split('?')[1]);
        const idFromHash = p.get('id') || p.get('visualization');
        if (hasUidShape(idFromHash)) ctx.visualizationId = idFromHash;
      }
      if (!ctx.visualizationId) {
        const idFromQuery = u.searchParams.get('id') || u.searchParams.get('visualization');
        if (hasUidShape(idFromQuery)) ctx.visualizationId = idFromQuery;
      }
    }

    // Maps routes look like: .../apps/maps#/voX07ulo2Bq
    if (ctx.appType === 'Maps') {
      if (hasUidShape(ctx.route)) ctx.mapId = ctx.route;
      if (!ctx.mapId && hash) {
        const routePath = hash.split('?')[0] || '';
        const segs = routePath.replace(/^#\/?/, '').split('/').filter(Boolean);
        for (const seg of segs) {
          const s = decodeURIComponent(seg);
          if (hasUidShape(s)) {
            ctx.mapId = s;
            break;
          }
        }
      }
      if (!ctx.mapId && hash && hash.includes('?')) {
        const p = new URLSearchParams(hash.split('?')[1]);
        const idFromHash = p.get('id') || p.get('map');
        if (hasUidShape(idFromHash)) ctx.mapId = idFromHash;
      }
      if (!ctx.mapId) {
        const idFromQuery = u.searchParams.get('id') || u.searchParams.get('map');
        if (hasUidShape(idFromQuery)) ctx.mapId = idFromQuery;
      }
    }

    // ── Dataset / Aggregate-program detection ────────────────────────────
    // Aggregate "programs" in DHIS2 are dataSets — `programType:WITHOUT_REGISTRATION`
    // is the Event-Program (still tracker schema). Users say "aggregate program"
    // to mean a dataSet, so we surface the dataset UID to the chatbot.
    //
    // URL shapes seen in the wild:
    //   /apps/aggregate-data-entry/#/?dataSetId=<uid>&orgUnitId=<uid>&periodId=...
    //   /dhis-web-data-entry/index.action#... (dataSetId in hash query, sometimes ?ds=)
    //   /apps/dataset-report/#/?ds=<uid> or #/<uid>
    //   /apps/maintenance/#/list/dataSetSection/dataSet/<uid> (edit screen)
    //   /apps/maintenance/#/edit/dataSetSection/dataSet/<uid>
    //   /apps/maintenance/#/list/programSection/program/<uid> (used to detect program edit too)
    const isDatasetApp = ctx.appType === 'Aggregate Data Entry'
      || ctx.appType === 'Data Entry'
      || ctx.appType === 'Dataset Report'
      || ctx.appType === 'Reporting';
    if (isDatasetApp || ctx.appType === 'Maintenance') {
      // sources already covers hash-query + URL search params (set up at the top
      // of this function). Use the same precedence: hash wins.
      // 1. dataSet UID
      for (const src of sources) {
        if (ctx.datasetId) break;
        for (const k of ['dataSetId', 'dataSet', 'ds']) {
          const v = src.get(k);
          if (hasUidShape(v)) { ctx.datasetId = v; break; }
        }
      }
      // 2. periodId (period code like "202604" — not a UID)
      for (const src of sources) {
        if (ctx.periodId) break;
        const pe = src.get('periodId') || src.get('pe') || src.get('period');
        if (pe && pe !== 'null') ctx.periodId = pe;
      }
      // 3. attributeOptionComboSelection — JSON-encoded { categoryId: optionId }
      //    (Aggregate Data Entry app uses this exact key per dhis2/aggregate-data-entry-app.)
      //    Surfaces non-default attribute disaggregation so the chatbot knows
      //    which attribute combo the user is editing.
      for (const src of sources) {
        if (ctx.attributeOptionComboSelection) break;
        const aoc = src.get('attributeOptionComboSelection');
        if (aoc) {
          try {
            const parsed = JSON.parse(aoc);
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) {
              ctx.attributeOptionComboSelection = parsed;
            }
          } catch {}
        }
      }
      // 4. sectionFilter (UID of the active section in the form)
      for (const src of sources) {
        if (ctx.sectionFilter) break;
        const sf = src.get('sectionFilter');
        if (hasUidShape(sf)) ctx.sectionFilter = sf;
      }
      // 5. Maintenance app: hash route segments after /dataSet/
      //    e.g. #/list/dataSetSection/dataSet/<uid>/section/<uid>
      if (!ctx.datasetId && hash) {
        const routePath = hash.split('?')[0] || '';
        const segs = routePath.replace(/^#\/?/, '').split('/').filter(Boolean);
        for (let i = 0; i < segs.length - 1; i++) {
          if (/^dataset$/i.test(segs[i]) && hasUidShape(decodeURIComponent(segs[i + 1]))) {
            ctx.datasetId = decodeURIComponent(segs[i + 1]);
            ctx.maintainedObjectType = 'dataSet';
            break;
          }
        }
        if (!ctx.programId && ctx.appType === 'Maintenance') {
          for (let i = 0; i < segs.length - 1; i++) {
            if (/^program$/i.test(segs[i]) && hasUidShape(decodeURIComponent(segs[i + 1]))) {
              ctx.programId = decodeURIComponent(segs[i + 1]);
              ctx.maintainedObjectType = 'program';
              break;
            }
          }
        }
      }
    }
  } catch {}
  return ctx;
}

// ── DHIS2 Initialization ─────────────────────────────────────────────────────

// True only if the user has granted host access to this URL's origin. Every
// credentialed DHIS2 fetch is gated on this so we never issue a cross-origin
// request the browser would reject with a noisy CORS error before the user has
// approved that server. Once granted, the same fetch is privileged (no CORS).
async function hasHostPermissionForUrl(url) {
  try {
    const origin = new URL(url).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch { return false; }
}

async function initializeFromUrl(url) {
  const baseUrl = extractBaseUrl(url);
  if (!baseUrl) return { error: 'Not a DHIS2 page' };

  // Gate on host permission. The auto-init listeners (tab updates, focus
  // changes, SPA fragment changes) fire on any DHIS2-looking URL; without this
  // guard they'd hit /api/system/info on an origin we have no access to yet and
  // log a CORS error. The side panel surfaces an "Allow access" prompt instead.
  if (!(await hasHostPermissionForUrl(url))) {
    return { error: 'Host access not granted for this server' };
  }

  // Detect a real cross-server switch so we can purge ALL server-tied caches —
  // otherwise the next tool call may reuse program metadata, OU contexts, or
  // per-turn UID/icon registries from the previous instance and probes (e.g.
  // create_program's name-collision check) hit the wrong server.
  const previousBaseUrl = dhis2.baseUrl;
  const baseUrlChanged = previousBaseUrl && previousBaseUrl !== baseUrl;

  if (dhis2.baseUrl !== baseUrl || !dhis2.connected) {
    try {
      dhis2.baseUrl = baseUrl;
      // `redirect: 'manual'` so a "not logged in" 302 to the login page surfaces as an
      // opaque redirect instead of being followed into a noisy CORS error. Common on the
      // DHIS2 playground: every instance shares one host (so the host permission, granted
      // once, already covers them all) but each instance needs its own login.
      const resp = await fetch(`${baseUrl}/api/system/info`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
      if (resp.type === 'opaqueredirect' || resp.status === 0) {
        dhis2.baseUrl = null;
        dhis2.connected = false;
        return { error: 'Not signed in to this DHIS2 instance. Log in to this server in the tab, then reopen the panel.' };
      }
      if (!resp.ok) throw new Error(resp.status);
      const info = await resp.json();
      dhis2.apiVersion = info.version.split('.')[1];
      dhis2.systemInfo = info;
      dhis2.connected = true;
      dhis2.ouMaxLevel = null;
    } catch {
      if (dhis2.baseUrl === baseUrl) dhis2.baseUrl = null;
      dhis2.connected = false;
      return { error: 'Could not connect to DHIS2' };
    }
  }

  if (baseUrlChanged) {
    // UIDs are server-scoped: a program/OU/icon ID from server A is meaningless
    // on server B. Wipe every cached identifier and metadata blob so the model
    // re-discovers state from the new instance.
    dhis2.programMetadata = null;
    dhis2.programRulesCount = null;
    dhis2.ouContext = null;
    dhis2.visualizationContext = null;
    dhis2.mapContext = null;
    dhis2.datasetContext = null;
    dhis2.lastFacilityOu = null;
    dhis2.metadataAuditSupport = null;
    dhis2.knownIds = null;
    dhis2.knownIdsSeedSize = 0;
    dhis2.knownIcons = null;
    console.log(`[initializeFromUrl] Server switched: ${previousBaseUrl} → ${baseUrl}. Cleared server-tied caches.`);
  }

  const ctx = extractContext(url);
  dhis2.pageContext = ctx;

  // Clear stale metadata when navigating away from a program or org unit
  if (!ctx.programId) {
    dhis2.programMetadata = null;
    dhis2.programRulesCount = null;
  }
  if (!ctx.orgUnitId) {
    dhis2.ouContext = null;
  }

  // Resolve event context if needed (also resolve stageId when missing)
  if (ctx.eventId && (!ctx.programId || !ctx.stageId)) {
    try {
      const ev = await dhis2Fetch(apiUrl(
        `tracker/events/${ctx.eventId}?fields=program,programStage,enrollment,trackedEntity`
      ));
      if (!ctx.programId)    ctx.programId = ev.program;
      if (!ctx.stageId)      ctx.stageId = ev.programStage;
      if (!ctx.enrollmentId) ctx.enrollmentId = ev.enrollment;
      if (!ctx.teiId)        ctx.teiId = ev.trackedEntity;
    } catch {}
  }

  // Fetch program metadata
  if (ctx.programId && (!dhis2.programMetadata || dhis2.programMetadata.id !== ctx.programId)) {
    try {
      const fields = [
        'id,displayName,description,programType',
        'programStages[id,displayName,description,sortOrder',
          ',programStageSections[id,displayName,sortOrder,dataElements[id]]',
          ',programStageDataElements[compulsory,displayInReports',
            ',dataElement[id,displayName,displayFormName,valueType,description',
              ',optionSetValue,optionSet[id,displayName,options[id,displayName,code]]]]]',
        'programTrackedEntityAttributes[displayInList,searchable,mandatory',
          ',trackedEntityAttribute[id,displayName,displayFormName,valueType,description',
            ',optionSetValue,unique,optionSet[id,displayName,options[id,displayName,code]]]]',
        'programIndicators[id,displayName,description,expression,filter]',
        'trackedEntityType[id,displayName]',
        'categoryCombo[id,displayName,isDefault]',
      ].join(',');
      dhis2.programMetadata = await dhis2Fetch(apiUrl(`programs/${ctx.programId}?fields=${fields}`));
    } catch (e) { console.warn('Metadata fetch failed:', e); }

    // Also get program rules count
    try {
      const rulesResp = await dhis2Fetch(apiUrl(
        `programRules?filter=program.id:eq:${ctx.programId}&paging=true&pageSize=1&totalPages=true&fields=id`
      ));
      dhis2.programRulesCount = rulesResp.pager?.total ?? null;
    } catch { dhis2.programRulesCount = null; }
  }

  // Fetch OU context
  if (ctx.orgUnitId && (!dhis2.ouContext || dhis2.ouContext.id !== ctx.orgUnitId)) {
    try {
      dhis2.ouContext = await dhis2Fetch(apiUrl(
        `organisationUnits/${ctx.orgUnitId}?fields=id,displayName,code,path,level,ancestors[id,displayName,level],children[id,displayName]`
      ));
      await getMaxOuLevel();
      rememberFacilityOu(dhis2.ouContext);
    } catch {}
  }

  // Fetch lightweight visualization context when in Data Visualizer route
  if (ctx.visualizationId && (!dhis2.visualizationContext || dhis2.visualizationContext.id !== ctx.visualizationId)) {
    try {
      const viz = await dhis2Fetch(apiUrl(
        `visualizations/${ctx.visualizationId}.json?fields=id,displayName,name,type,lastUpdated,user[displayName]`
      ));
      dhis2.visualizationContext = {
        id: viz.id,
        name: viz.displayName || viz.name || viz.id,
        type: viz.type || null,
        lastUpdated: viz.lastUpdated || null,
        owner: viz.user?.displayName || null,
      };
    } catch {
      dhis2.visualizationContext = {
        id: ctx.visualizationId,
        name: ctx.visualizationId,
        type: null,
      };
    }
  } else if (!ctx.visualizationId) {
    dhis2.visualizationContext = null;
  }

  // Fetch lightweight map context when in Maps route
  if (ctx.mapId && (!dhis2.mapContext || dhis2.mapContext.id !== ctx.mapId)) {
    try {
      const mapMeta = await dhis2Fetch(apiUrl(
        `maps/${ctx.mapId}.json?fields=id,displayName,name,basemap,longitude,latitude,zoom,lastUpdated,user[displayName],mapViews[id,layer,displayName]`
      ));
      dhis2.mapContext = {
        id: mapMeta.id,
        name: mapMeta.displayName || mapMeta.name || mapMeta.id,
        basemap: mapMeta.basemap || null,
        layerCount: mapMeta.mapViews?.length || 0,
        layers: (mapMeta.mapViews || []).map(mv => ({
          id: mv.id,
          layer: mv.layer,
          name: mv.displayName || mv.layer,
        })),
        lastUpdated: mapMeta.lastUpdated || null,
        owner: mapMeta.user?.displayName || null,
      };
    } catch {
      dhis2.mapContext = {
        id: ctx.mapId,
        name: ctx.mapId,
        layerCount: 0,
        layers: [],
      };
    }
  } else if (!ctx.mapId) {
    dhis2.mapContext = null;
  }

  // Fetch lightweight dataset context when in Data Entry / Aggregate Data Entry /
  // Dataset Report / Maintenance > dataSet. Surfaces the dataset name, period type,
  // form type, DE/section/OU counts so the chatbot can answer "what dataset am I
  // in?" without an extra tool call, and reason about the right inputs for
  // create/update operations.
  if (ctx.datasetId && (!dhis2.datasetContext || dhis2.datasetContext.id !== ctx.datasetId)) {
    try {
      const ds = await dhis2Fetch(apiUrl(
        `dataSets/${ctx.datasetId}.json?fields=id,displayName,name,shortName,periodType,formType,categoryCombo[id,displayName,isDefault],` +
        `openFuturePeriods,expiryDays,timelyDays,renderAsTabs,renderHorizontally,validCompleteOnly,compulsoryFieldsCompleteOnly,` +
        `dataSetElements~size,sections~size,organisationUnits~size,indicators~size,access`
      ));
      dhis2.datasetContext = {
        id: ds.id,
        name: ds.displayName || ds.name || ds.id,
        shortName: ds.shortName || null,
        periodType: ds.periodType || null,
        formType: ds.formType || 'DEFAULT',
        categoryCombo: ds.categoryCombo?.displayName || null,
        categoryComboId: ds.categoryCombo?.id || null,
        isDefaultCombo: !!ds.categoryCombo?.isDefault,
        openFuturePeriods: ds.openFuturePeriods ?? null,
        expiryDays: ds.expiryDays ?? null,
        timelyDays: ds.timelyDays ?? null,
        dataElementsCount: ds.dataSetElements ?? 0,
        sectionsCount: ds.sections ?? 0,
        orgUnitsCount: ds.organisationUnits ?? 0,
        indicatorsCount: ds.indicators ?? 0,
        canRead: !!ds.access?.read,
        canWrite: !!ds.access?.write,
        canWriteData: !!ds.access?.data?.write,
      };
    } catch {
      dhis2.datasetContext = { id: ctx.datasetId, name: ctx.datasetId };
    }
  } else if (!ctx.datasetId) {
    dhis2.datasetContext = null;
  }

  await saveState();
  return { success: true, state: getSerializableState() };
}

function getSerializableState() {
  return {
    baseUrl: dhis2.baseUrl,
    apiVersion: dhis2.apiVersion,
    version: dhis2.systemInfo?.version,
    pageContext: dhis2.pageContext,
    programName: dhis2.programMetadata?.displayName,
    programId: dhis2.programMetadata?.id,
    programType: dhis2.programMetadata?.programType,
    visualizationId: dhis2.pageContext?.visualizationId || dhis2.visualizationContext?.id || null,
    visualizationName: dhis2.visualizationContext?.name || null,
    visualizationType: dhis2.visualizationContext?.type || null,
    mapId: dhis2.pageContext?.mapId || dhis2.mapContext?.id || null,
    mapName: dhis2.mapContext?.name || null,
    mapLayerCount: dhis2.mapContext?.layerCount || null,
    datasetId: dhis2.pageContext?.datasetId || dhis2.datasetContext?.id || null,
    datasetName: dhis2.datasetContext?.name || null,
    datasetPeriodType: dhis2.datasetContext?.periodType || null,
    datasetFormType: dhis2.datasetContext?.formType || null,
    datasetDataElementsCount: dhis2.datasetContext?.dataElementsCount ?? null,
    datasetSectionsCount: dhis2.datasetContext?.sectionsCount ?? null,
    datasetOrgUnitsCount: dhis2.datasetContext?.orgUnitsCount ?? null,
    datasetCanWriteData: dhis2.datasetContext?.canWriteData ?? null,
    periodId: dhis2.pageContext?.periodId || null,
    attributeOptionComboSelection: dhis2.pageContext?.attributeOptionComboSelection || null,
    sectionFilter: dhis2.pageContext?.sectionFilter || null,
    ouName: dhis2.ouContext?.displayName,
    ouId: dhis2.ouContext?.id,
    ouLevel: dhis2.ouContext?.level,
    ouMaxLevel: dhis2.ouMaxLevel || null,
    lastFacilityOu: dhis2.lastFacilityOu || null,
    ouAncestors: dhis2.ouContext?.ancestors?.map(a => a.displayName),
    stageId: dhis2.pageContext?.stageId || null,
    stageName: (dhis2.pageContext?.stageId && dhis2.programMetadata?.programStages)
      ? (dhis2.programMetadata.programStages.find(s => s.id === dhis2.pageContext.stageId)?.displayName || null)
      : null,
    stagesCount: dhis2.programMetadata?.programStages?.length,
    attributesCount: dhis2.programMetadata?.programTrackedEntityAttributes?.length,
    indicatorsCount: dhis2.programMetadata?.programIndicators?.length,
    programRulesCount: dhis2.programRulesCount,
    trackedEntityType: dhis2.programMetadata?.trackedEntityType?.displayName,
    connected: dhis2.connected,
    inspect: {
      enabled: inspectCapture.active,
      count: inspectCapture.logs.length,
      url: inspectCapture.url,
      startedAt: inspectCapture.startedAt,
    },
  };
}

const LINE_LISTING_KEYWORD_ROUTES = Object.freeze({
  'what is line listing': ['B00'],
  'what does this app do': ['B00'],
  purpose: ['B00'],
  start: ['B01'],
  'new line list': ['B01'],
  blank: ['B01'],
  open: ['B01'],
  create: ['B01'],
  begin: ['B01'],
  'from scratch': ['B01'],
  display: ['B02'],
  show: ['B02'],
  column: ['B02'],
  'add data': ['B02'],
  'data element': ['B02'],
  attribute: ['B02'],
  indicator: ['B02'],
  'organisation unit': ['B03'],
  'org unit': ['B03'],
  facility: ['B03'],
  district: ['B03'],
  region: ['B03'],
  hospital: ['B03'],
  level: ['B03'],
  'health center': ['B03'],
  period: ['B04'],
  time: ['B04'],
  date: ['B04'],
  month: ['B04'],
  year: ['B04'],
  quarter: ['B04'],
  'last 12': ['B04'],
  'this year': ['B04'],
  filter: ['B05'],
  condition: ['B05'],
  narrow: ['B05'],
  'only show': ['B05'],
  exclude: ['B05'],
  'greater than': ['B05'],
  equals: ['B05'],
  enrollment: ['B06'],
  'cross-stage': ['B06'],
  'multiple stages': ['B06'],
  'across stages': ['B06'],
  repeat: ['B07'],
  repeatable: ['B07'],
  'multiple visits': ['B07'],
  'repeated event': ['B07'],
  color: ['B08'],
  legend: ['B08'],
  scorecard: ['B08'],
  highlight: ['B08'],
  save: ['B09'],
  download: ['B09'],
  export: ['B09'],
  share: ['B09'],
  csv: ['B09'],
  excel: ['B09'],
  rounding: ['B10'],
  decimal: ['B10'],
  hierarchy: ['B10'],
  'full screen': ['B10'],
  options: ['B10'],
  empty: ['B11'],
  error: ['B11'],
  'not working': ['B11'],
  missing: ['B11'],
  'no data': ['B11'],
  broken: ['B11'],
  'greyed out': ['B11'],
  boolean: ['B13'],
  'data type': ['B13'],
  operator: ['B13'],
  'option set': ['B13'],
});

async function ensureLineListingAssetsLoaded() {
  if (lineListingAssets.loaded && lineListingAssets.toolJson) return true;
  try {
    // NOTE: line-listing/dhis2_extension_router.js is NOT fetched or executed —
    // its text was previously read into lineListingAssets.routerSource and never
    // used. Routing is done by the embedded LINE_LISTING_KEYWORD_ROUTES +
    // routeLineListingBlocks() below. The external router file is retained only
    // as a reference artifact whose PATH is still surfaced to the model.
    const [jsonResp, mdResp] = await Promise.all([
      fetch(chrome.runtime.getURL(LINE_LISTING_JSON_PATH)),
      fetch(chrome.runtime.getURL(LINE_LISTING_SYSTEM_PROMPT_PATH)),
    ]);
    if (!jsonResp.ok) throw new Error(`Could not load ${LINE_LISTING_JSON_PATH}`);
    lineListingAssets.toolJson = await jsonResp.json();
    lineListingAssets.systemPromptMd = mdResp.ok ? await mdResp.text() : '';
    lineListingAssets.loaded = true;
    return true;
  } catch (e) {
    console.warn('Line listing assets failed to load:', e);
    return false;
  }
}

function routeLineListingBlocks(userMessage, isScreenshot = false) {
  const msg = String(userMessage || '').toLowerCase();
  const matched = new Set();
  for (const [keyword, blockIds] of Object.entries(LINE_LISTING_KEYWORD_ROUTES)) {
    if (msg.includes(keyword)) {
      for (const id of blockIds) matched.add(id);
    }
  }
  if (isScreenshot) matched.add('B12');
  if (!matched.size) matched.add('B01');
  if (isScreenshot && matched.size === 1 && matched.has('B12')) matched.add('B01');
  if (
    (matched.has('B02') || matched.has('B03') || matched.has('B04')) &&
    (msg.includes('how do i') || msg.includes('i want to') || msg.includes('help me'))
  ) {
    matched.add('B01');
  }
  return [...matched].sort();
}

function loadLineListingBlocks(blockIds) {
  const blocksObj = lineListingAssets.toolJson?.blocks || {};
  return blockIds.map(id => blocksObj[id]).filter(Boolean);
}

