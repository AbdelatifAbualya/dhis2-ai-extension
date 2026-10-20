// ── Learning memory: lessons about DHIS2 / API behaviour that persist across
// conversations, so a mistake the assistant made (and fixed) once is never
// repeated ──────────────────────────────────────────────────────────────────
//
// WHAT IS STORED: configuration / API knowledge only — "endpoint X fails when
// Y; do Z instead", "this instance names its percent indicator type
// 'Percentage'", "a dashboard PUT wipes its tiles; use add_items". Each entry
// is { area, tools, endpoint, title, problem, solution } plus bookkeeping.
//
// WHAT IS NEVER STORED — patient data. Enforced in code, three layers:
//   1. TAINT: a turn that read or wrote patient-level tracker records (any
//      toolReadsPatientData call, any tracker write, a tracker summary in a
//      result), ran on a patient's record page (TEI / enrollment / event in the
//      page context), or ran the save-error prefetch (reads a TEI's
//      enrollments) writes NOTHING to memory — no automatic lessons and
//      manage_memory(record) is refused for that turn.
//   2. NO RAW VALUES in automatic lessons: only tool names, actions, argument
//      KEY names, an allow-list of enum-like configuration values
//      (value_type, period_type, vis_type, …) and endpoint PATTERNS with UIDs,
//      ids and filter/query values replaced by placeholders.
//   3. SCRUB + REJECT on every stored text (automatic, model- or user-written):
//      UIDs → <uid>, e-mails → <email>, phone/ID-like digit runs → <number>,
//      dates → <date>, filter/query parameter values → <value>; a lesson that
//      still reads like personal data ("patient named …", "Mr …") is refused.
//
// STORAGE: chrome.storage.local only (this browser profile) — never the DHIS2
// server, never any third party. Each entry records the instance host and DHIS2
// version; scope "instance" lessons are only used on that instance.
//
// RETRIEVAL (all bounded, all skipped when memory is switched off):
//   • system prompt — the lessons most relevant to THIS request, scored by the
//     tools selected for the turn, task-area keywords and word overlap;
//   • manual gate — a tool's own lessons ride along with its manual on first use;
//   • failed calls — lessons matching the failing tool/action/endpoint are
//     attached to the error result, so the known fix is right there;
//   • manage_memory(search) — explicit lookup mid-task.

const MEMORY_STORAGE_KEY = 'dhis2AiMemory';
const MEMORY_ENABLED_KEY = 'memoryEnabled';
const MEMORY_SCHEMA_VERSION = 1;
const MEMORY_MAX_ENTRIES = 400;
const MEMORY_PROMPT_MAX_ENTRIES = 8;
const MEMORY_PROMPT_MAX_CHARS = 2600;

// Task areas: the index lessons are filed under and retrieved by.
const MEMORY_AREAS = {
  programs:            { label: 'Programs',                   tools: ['create_metadata', 'get_program_info', 'architect_metadata'], resources: ['programs'], words: /\b(programs?|programmes?|tracker programs?|event programs?)\b/ },
  program_stages:      { label: 'Program stages & sections',  tools: ['create_metadata'], resources: ['programStages', 'programStageSections'], words: /\b(stages?|sections?|repeatable)\b/ },
  data_elements:       { label: 'Data elements',              tools: ['create_metadata', 'manage_metadata'], resources: ['dataElements'], words: /\b(data\s*elements?|fields?)\b/ },
  option_sets:         { label: 'Option sets',                tools: ['manage_option_sets'], resources: ['optionSets', 'options'], words: /\b(option\s*sets?|options?|drop[\s-]?downs?)\b/ },
  attributes:          { label: 'Tracked entity attributes',  tools: ['manage_metadata'], resources: ['trackedEntityAttributes', 'trackedEntityTypes'], words: /\b(attributes?|tracked\s*entity|teas?)\b/ },
  program_rules:       { label: 'Program rules',              tools: ['manage_program_rules'], resources: ['programRules', 'programRuleVariables', 'programRuleActions'], words: /\b(program\s*rules?|rules?|hidefield|showwarning|assign)\b/ },
  program_indicators:  { label: 'Program indicators',         tools: ['manage_program_indicators'], resources: ['programIndicators'], words: /\b(program\s*indicators?|pis?)\b/ },
  indicators:          { label: 'Aggregate indicators',       tools: ['manage_indicators'], resources: ['indicators', 'indicatorTypes'], words: /\b(indicators?|numerator|denominator|percent(age)?|coverage|rates?)\b/ },
  datasets:            { label: 'Datasets & category combos', tools: ['manage_datasets', 'manage_custom_forms'], resources: ['dataSets', 'sections', 'categoryCombos', 'categories', 'categoryOptions', 'dataEntryForms'], words: /\b(data\s*sets?|datasets?|category\s*combos?|disaggregation|categor(y|ies)|aggregate\s*forms?)\b/ },
  data_values:         { label: 'Aggregate data values',      tools: ['manage_data_values'], resources: ['dataValueSets', 'dataValues', 'completeDataSetRegistrations', 'dataEntry'], words: /\b(data\s*values?|enter(ed)?\s+(data|values?)|data\s*entry|complete\s+the\s+form|reported)\b/ },
  validation_rules:    { label: 'Validation rules',           tools: ['manage_validation_rules'], resources: ['validationRules', 'validation', 'expressions'], words: /\b(validation\s*rules?|data\s*quality)\b/ },
  org_units:           { label: 'Organisation units',         tools: ['manage_org_units'], resources: ['organisationUnits', 'organisationUnitGroups', 'organisationUnitLevels'], words: /\b(org(anisation)?\s*units?|facilit(y|ies)|hierarchy|districts?)\b/ },
  visualizations:      { label: 'Visualizations & charts',    tools: ['manage_dashboards', 'get_visualization_details'], resources: ['visualizations'], words: /\b(visuali[sz]ations?|charts?|pivot\s*tables?|single\s*value|graphs?)\b/ },
  dashboards:          { label: 'Dashboards',                 tools: ['manage_dashboards'], resources: ['dashboards', 'dashboardItems'], words: /\b(dashboards?|tiles?)\b/ },
  maps:                { label: 'Maps',                       tools: ['manage_maps', 'get_map_details'], resources: ['maps', 'mapViews'], words: /\b(maps?|choropleth|thematic|bubble)\b/ },
  line_lists:          { label: 'Line lists',                 tools: ['manage_line_lists', 'line_listing_guide'], resources: ['eventVisualizations'], words: /\b(line[\s-]?lists?|line[\s-]?listings?|registers?)\b/ },
  legend_sets:         { label: 'Legend sets',                tools: ['manage_legend_sets'], resources: ['legendSets'], words: /\b(legends?|legend\s*sets?|colou?r[\s-]?cod)/ },
  notifications:       { label: 'Notifications',              tools: ['manage_program_notifications'], resources: ['programNotificationTemplates'], words: /\b(notifications?|webhooks?|sms|e-?mails?\s+alerts?)\b/ },
  sharing:             { label: 'Sharing & access',           tools: ['manage_metadata'], resources: ['sharing'], words: /\b(sharing|share|public\s*access|access|permissions?)\b/ },
  users:               { label: 'Users, roles & groups',      tools: ['manage_users'], resources: ['users', 'userRoles', 'userGroups', 'authorities', 'me'], words: /\b(users?|roles?|groups?|authorit(y|ies)|passwords?|accounts?)\b/ },
  translations:        { label: 'Translations',               tools: ['manage_metadata_translations', 'manage_custom_translations'], resources: ['translations', 'locales'], words: /\b(translat\w*|locales?|languages?|french|arabic|spanish|portuguese)\b/ },
  analytics:           { label: 'Analytics queries',          tools: ['get_event_analytics', 'count_records', 'manage_program_indicators'], resources: ['analytics', 'resourceTables'], words: /\b(analytics|how\s+many|counts?|trends?|totals?|breakdown)\b/ },
  plugins:             { label: 'Apps & plugins',             tools: ['manage_growth_chart_plugin'], resources: ['appHub', 'apps', 'dataStore'], words: /\b(plugins?|growth\s*charts?|apps?\s+(install|hub))\b/ },
  metadata_general:    { label: 'Metadata (general)',         tools: ['manage_metadata', 'search_metadata', 'architect_metadata', 'manage_backups'], resources: ['metadata', 'schemas', 'icons', 'maintenance', 'system'], words: /\b(metadata|delete|icons?|styles?|backups?|import|schemas?)\b/ },
  api_general:         { label: 'API (general)',              tools: ['dhis2_query'], resources: [], words: /\b(api|endpoint|query)\b/ },
};
const MEMORY_AREA_KEYS = Object.keys(MEMORY_AREAS);

// Tool → default area (first match wins).
const MEMORY_TOOL_AREA = (() => {
  const m = {};
  for (const [area, def] of Object.entries(MEMORY_AREAS)) for (const t of def.tools) if (!m[t]) m[t] = area;
  m.create_metadata = 'programs';
  m.manage_metadata = 'metadata_general';
  return m;
})();
// API resource (first path segment, lower-cased) → area.
const MEMORY_RESOURCE_AREA = (() => {
  const m = {};
  for (const [area, def] of Object.entries(MEMORY_AREAS)) for (const r of def.resources) m[r.toLowerCase()] = area;
  return m;
})();

// Configuration keys whose (short, enum-like) VALUES are safe and useful to
// keep in an automatic lesson. Anything else is recorded as a key name only.
const MEMORY_SAFE_VALUE_KEYS = new Set([
  'action', 'method', 'value_type', 'valueType', 'aggregation_type', 'aggregationType', 'analytics_type',
  'analyticsType', 'period_type', 'periodType', 'indicator_type', 'vis_type', 'type', 'program_type',
  'domain_type', 'form_type', 'formType', 'operator', 'importance', 'output_type', 'merge_mode', 'strategy',
  'style', 'record_type', 'aggregate_type', 'info_type', 'object_type', 'data_dimension_type', 'recipient',
  'trigger', 'thematic_map_type', 'relative_period', 'periods', 'evaluation_time', 'source_type',
  'importStrategy', 'importMode', 'atomicMode', 'missing_strategy', 'public_access',
]);

// ── State ────────────────────────────────────────────────────────────────────
const memoryState = { loaded: false, loading: null, enabled: true, entries: [], writeChain: Promise.resolve() };
let memoryTurn = null; // per-turn observation state (see memoryBeginTurn)

async function ensureMemoryLoaded() {
  if (memoryState.loaded) return;
  if (!memoryState.loading) {
    memoryState.loading = (async () => {
      try {
        const d = await chrome.storage.local.get([MEMORY_STORAGE_KEY, MEMORY_ENABLED_KEY]);
        memoryState.enabled = d[MEMORY_ENABLED_KEY] !== false; // default ON
        const store = d[MEMORY_STORAGE_KEY];
        memoryState.entries = (store && Array.isArray(store.entries)) ? store.entries.filter(e => e && e.id && e.title) : [];
      } catch (e) {
        console.warn('[Memory] load failed:', e?.message || e);
        memoryState.entries = [];
      }
      memoryState.loaded = true;
    })();
  }
  await memoryState.loading;
}
function isMemoryEnabled() { return memoryState.enabled !== false; }

// Serialized writes — the loop, the tool and the panel can all write.
function persistMemory() {
  memoryState.writeChain = memoryState.writeChain.then(async () => {
    try {
      await chrome.storage.local.set({ [MEMORY_STORAGE_KEY]: { version: MEMORY_SCHEMA_VERSION, entries: memoryState.entries } });
    } catch (e) {
      console.warn('[Memory] save failed:', e?.message || e);
    }
  });
  return memoryState.writeChain;
}
async function setMemoryEnabled(on) {
  await ensureMemoryLoaded();
  memoryState.enabled = !!on;
  try { await chrome.storage.local.set({ [MEMORY_ENABLED_KEY]: !!on }); } catch {}
  return memoryState.enabled;
}

// ── Privacy: scrubbing + rejection ───────────────────────────────────────────
function scrubMemoryText(raw, max = 900) {
  let s = String(raw ?? '');
  if (!s) return '';
  // The instance host is recorded separately; keep paths only.
  s = s.replace(/https?:\/\/[^\s"'`)]+/gi, (u) => {
    try { const x = new URL(u); return x.pathname.replace(/^\/api\/\d+\//, '/api/') + (x.search ? '?' + x.search.slice(1) : ''); } catch { return '<url>'; }
  });
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
  // Values of filter/query/search parameters can be anything a user typed.
  s = s.replace(/\b(filter=)([A-Za-z0-9_.]+):(\w+):([^&\s"'`]+)/g, '$1$2:$3:<value>');
  s = s.replace(/\b(query|search|q|username|trackedEntity|enrollment|event|te|ou|orgUnit)=([^&\s"'`]+)/gi, '$1=<value>');
  // Every DHIS2 UID (patient, enrollment, event and metadata alike) → placeholder.
  s = s.replace(/\b[A-Za-z][A-Za-z0-9]{10}\b/g, (t) => (looksLikeUidForMemory(t) ? '<uid>' : t));
  s = s.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?\b/g, '<date>');
  // Phone / ID numbers: any run with ≥8 digits (spaces, dots, dashes allowed).
  s = s.replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '<number>' : m));
  // Other long numbers — except a monthly period id (yyyyMM), which is config.
  s = s.replace(/\b\d{6,}\b/g, (m) => (/^(19|20)\d{2}(0[1-9]|1[0-2])$/.test(m) ? m : '<number>'));
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Text that still reads like a person/patient record after scrubbing.
const MEMORY_PERSONAL_RE = new RegExp(
  '\\b(?:patient|client|person|mother|father|child|baby|woman|man|beneficiary|case)\\s+(?:named|called|is)\\s+[A-Z][a-z]+'
  + '|\\b(?:Mr|Mrs|Ms|Miss|Dr)\\.?\\s+[A-Z][a-z]+'
  + '|\\b(?:first\\s*name|last\\s*name|surname|full\\s*name|date\\s*of\\s*birth|dob|national\\s*id|phone(?:\\s*number)?|address)\\s*[:=]\\s*\\S+'
);
// Stricter than isLikelyDhisUid: 11-char camelCase API words ("programType",
// "periodTypes") must survive. A random 11-char UID almost always carries a
// digit or ≥3 upper-case letters after the first character (≈99%).
function looksLikeUidForMemory(t) {
  if (!/^[A-Za-z][A-Za-z0-9]{10}$/.test(t) || RESERVED_UID_SHAPED_WORDS.has(t)) return false;
  const rest = t.slice(1);
  return /\d/.test(rest) || (rest.match(/[A-Z]/g) || []).length >= 3;
}
function looksLikePersonalData(text) { return MEMORY_PERSONAL_RE.test(String(text || '')); }

// ── Normalisation helpers ────────────────────────────────────────────────────
const MEMORY_STOPWORDS = new Set('a an the and or of to for in on at by with from is are was were be been it its this that these those as into via not no do does did use using used then than when what which who how can could should would will shall may might must i you we they he she them our your their my me us please also just only about after before over under new create make build add set get list show'.split(' '));
function memoryTokens(text) {
  return [...new Set(String(text || '').toLowerCase().replace(/<[a-z]+>/g, ' ').split(/[^a-z0-9_]+/)
    .filter(w => w.length > 2 && !MEMORY_STOPWORDS.has(w)))];
}
function memoryJaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function normalizeEndpoint(path) {
  if (!path) return null;
  let p = String(path).split('?')[0].replace(/^\/+/, '').replace(/^api\/(\d+\/)?/, '');
  p = p.split('/').map(seg => (looksLikeUidForMemory(seg) || /^\d+$/.test(seg) ? '<uid>' : seg)).join('/');
  return p.slice(0, 120) || null;
}
function areaForCall(tool, args) {
  if (tool === 'dhis2_query' && args?.path) {
    const first = String(args.path).replace(/^\/+/, '').replace(/^api\/(\d+\/)?/, '').split(/[/?]/)[0].toLowerCase();
    if (MEMORY_RESOURCE_AREA[first]) return MEMORY_RESOURCE_AREA[first];
    if (/^analytics/.test(first)) return 'analytics';
    return 'api_general';
  }
  if (tool === 'create_metadata') {
    const a = String(args?.action || '');
    if (/rule/.test(a)) return 'program_rules';
    if (/option_set/.test(a)) return 'option_sets';
    if (/category_combo/.test(a)) return 'datasets';
    if (/data_elements/.test(a)) return 'data_elements';
    if (/stage/.test(a)) return 'program_stages';
    return 'programs';
  }
  if (tool === 'manage_metadata') {
    const a = String(args?.action || '');
    if (/sharing/.test(a)) return 'sharing';
    if (/attributes/.test(a)) return 'attributes';
    if (/org_units/.test(a)) return 'programs';
  }
  if (tool === 'manage_dashboards' && /visualization/.test(String(args?.action || ''))) return 'visualizations';
  return MEMORY_TOOL_AREA[tool] || 'api_general';
}
function areasFromText(text) {
  const t = String(text || '').toLowerCase();
  return MEMORY_AREA_KEYS.filter(k => MEMORY_AREAS[k].words.test(t));
}
function memoryInstanceHost() {
  try { return dhis2.baseUrl ? new URL(dhis2.baseUrl).host : null; } catch { return null; }
}

// Flatten argument KEY paths (depth-limited) — never values. For a raw API
// call the query-parameter NAMES are part of the shape too.
function memoryArgShape(args, prefix = '', depth = 0, out = new Set()) {
  if (!args || typeof args !== 'object' || depth > 3) return out;
  if (depth === 0 && typeof args.path === 'string' && args.path.includes('?')) {
    for (const k of new URLSearchParams(args.path.split('?')[1]).keys()) out.add(`?${k}`);
  }
  if (Array.isArray(args)) {
    for (const x of args.slice(0, 5)) memoryArgShape(x, prefix + '[]', depth + 1, out);
    return out;
  }
  for (const [k, v] of Object.entries(args)) {
    if (k === 'body' && prefix === '') { out.add('body'); memoryArgShape(v, 'body', depth + 1, out); continue; }
    const key = prefix ? `${prefix}.${k}` : k;
    out.add(key);
    if (v && typeof v === 'object') memoryArgShape(v, key, depth + 1, out);
  }
  return out;
}
// Allow-listed enum-like configuration values, by key path.
function memorySafeValues(args, prefix = '', depth = 0, out = {}) {
  if (!args || typeof args !== 'object' || depth > 3) return out;
  if (Array.isArray(args)) { for (const x of args.slice(0, 5)) memorySafeValues(x, prefix + '[]', depth + 1, out); return out; }
  for (const [k, v] of Object.entries(args)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (MEMORY_SAFE_VALUE_KEYS.has(k)) {
      if ((typeof v === 'string' && v.length <= 40 && !/\s{2}/.test(v)) || typeof v === 'number' || typeof v === 'boolean') out[key] = scrubMemoryText(String(v), 40);
      else if (Array.isArray(v) && v.every(x => typeof x === 'string' && /^[A-Z0-9_]{2,30}$/.test(x))) out[key] = v.slice(0, 4).join(',');
    }
    if (v && typeof v === 'object') memorySafeValues(v, key, depth + 1, out);
  }
  return out;
}

// ── Entries: create / merge / evict ──────────────────────────────────────────
const MEMORY_SOURCE_RANK = { auto: 1, assistant: 2, user: 3 };
function memoryNewId() { return `mem-${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`; }

function buildMemoryEntry(input, source) {
  const area = MEMORY_AREAS[input.area] ? input.area : (input.tools?.[0] ? (MEMORY_TOOL_AREA[input.tools[0]] || 'api_general') : 'api_general');
  const tools = [...new Set((input.tools || []).filter(t => typeof t === 'string' && TOOL_ROUTER[t]))].slice(0, 4);
  const entry = {
    id: memoryNewId(),
    area,
    tools,
    endpoint: input.endpoint ? scrubMemoryText(normalizeEndpoint(input.endpoint) || input.endpoint, 120) : null,
    title: scrubMemoryText(input.title, 140),
    problem: scrubMemoryText(input.problem, 700),
    solution: scrubMemoryText(input.solution, 900),
    scope: input.scope === 'instance' ? 'instance' : 'general',
    resolved: input.resolved !== false,
    source,
    instance: memoryInstanceHost(),
    dhis2_version: dhis2.systemInfo?.version || null,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    seen_count: 1,
    used_count: 0,
  };
  return entry;
}

function memoryValidateEntry(e) {
  if (!e.title || e.title.length < 6) return 'title is required (≥6 characters).';
  if (!e.solution || e.solution.length < 12) return 'solution is required (≥12 characters) — say exactly how to do it correctly.';
  for (const f of ['title', 'problem', 'solution']) {
    if (looksLikePersonalData(e[f])) return `the ${f} looks like it contains personal/patient data — memory only stores configuration and API knowledge, never data about people.`;
  }
  return null;
}

function findSimilarMemory(entry) {
  const tok = memoryTokens(`${entry.title} ${entry.problem}`);
  let best = null, bestScore = 0;
  for (const e of memoryState.entries) {
    if (e.area !== entry.area) continue;
    if (entry.tools.length && e.tools.length && !entry.tools.some(t => e.tools.includes(t))) continue;
    if (entry.endpoint && e.endpoint && entry.endpoint !== e.endpoint) continue;
    const s = memoryJaccard(tok, memoryTokens(`${e.title} ${e.problem}`));
    if (s > bestScore) { bestScore = s; best = e; }
  }
  return bestScore >= 0.5 ? best : null;
}

// Insert or merge. Returns { entry, merged }.
function upsertMemoryEntry(entry, { supersedes = null } = {}) {
  if (supersedes) {
    const idx = memoryState.entries.findIndex(e => e.id === supersedes);
    if (idx >= 0) memoryState.entries.splice(idx, 1);
  }
  const twin = findSimilarMemory(entry);
  if (twin) {
    twin.seen_count = (twin.seen_count || 1) + 1;
    twin.updated = entry.updated;
    // Better-sourced text replaces weaker text; equal rank keeps the richer one.
    const newRank = MEMORY_SOURCE_RANK[entry.source] || 1, oldRank = MEMORY_SOURCE_RANK[twin.source] || 1;
    if (newRank > oldRank || (newRank === oldRank && entry.solution.length > twin.solution.length && entry.resolved)) {
      Object.assign(twin, { title: entry.title, problem: entry.problem || twin.problem, solution: entry.solution, source: entry.source, resolved: entry.resolved || twin.resolved });
    }
    for (const t of entry.tools) if (!twin.tools.includes(t)) twin.tools.push(t);
    if (twin.dhis2_version !== entry.dhis2_version && entry.dhis2_version) twin.dhis2_version = entry.dhis2_version;
    return { entry: twin, merged: true };
  }
  memoryState.entries.push(entry);
  if (memoryState.entries.length > MEMORY_MAX_ENTRIES) {
    // Evict the least valuable: weakest source, least seen/used, oldest.
    const score = (e) => (MEMORY_SOURCE_RANK[e.source] || 1) * 3 + Math.log2(1 + (e.seen_count || 1)) * 2 + Math.log2(1 + (e.used_count || 0)) + (Date.parse(e.updated) || 0) / 1e13;
    memoryState.entries.sort((a, b) => score(b) - score(a));
    memoryState.entries.length = MEMORY_MAX_ENTRIES;
  }
  return { entry, merged: false };
}

// ── Retrieval ────────────────────────────────────────────────────────────────
function memoryApplicable(e) {
  if (e.scope !== 'instance') return true;
  const host = memoryInstanceHost();
  return !host || !e.instance || e.instance === host;
}
function scoreMemory(e, { textTokens, textAreas, toolNames, tool, action, endpoint }) {
  let s = 0;
  const specificTools = (toolNames || []).filter(t => t !== 'dhis2_query' && t !== 'search_metadata');
  if (tool && e.tools.includes(tool)) s += 6;
  else if (e.tools.some(t => specificTools.includes(t))) s += 3;
  if (textAreas?.includes(e.area)) s += 3;
  if (endpoint && e.endpoint && endpoint === e.endpoint) s += 5;
  if (action && e.title.toLowerCase().includes(`(${String(action).toLowerCase()})`)) s += 2;
  if (textTokens?.length) {
    const et = memoryTokens(`${e.title} ${e.problem} ${e.solution} ${e.endpoint || ''}`);
    s += memoryJaccard(textTokens, et) * 12 + textTokens.filter(w => et.includes(w)).length * 0.6;
  }
  s += Math.log2(1 + (e.seen_count || 1)) * 0.5 + ((MEMORY_SOURCE_RANK[e.source] || 1) - 1) * 0.5;
  if (e.resolved === false) s -= 1;
  return s;
}
function selectMemories(query, { limit = MEMORY_PROMPT_MAX_ENTRIES, minScore = 3.5, area = null } = {}) {
  if (!isMemoryEnabled() || !memoryState.entries.length) return [];
  return memoryState.entries
    .filter(e => memoryApplicable(e) && (!area || e.area === area))
    .map(e => ({ e, s: scoreMemory(e, query) }))
    .filter(x => x.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.e);
}
const MEMORY_SOURCE_TAG = { user: 'user rule', assistant: 'learned', auto: 'learned' };
function formatMemoryLine(e, max = 330) {
  const line = `(#${e.id}) [${MEMORY_SOURCE_TAG[e.source] || 'learned'} · ${MEMORY_AREAS[e.area]?.label || e.area}${e.endpoint ? ` · ${e.endpoint}` : ''}] ${e.title}${e.problem ? ` — problem: ${e.problem}` : ''} → ${e.resolved === false ? 'known issue: ' : 'do: '}${e.solution}${(e.seen_count || 1) > 1 ? ` (seen ${e.seen_count}×)` : ''}`;
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
function compactMemory(e) {
  return { id: e.id, area: e.area, tools: e.tools, endpoint: e.endpoint || undefined, title: e.title, problem: e.problem || undefined, solution: e.solution, resolved: e.resolved !== false, seen_count: e.seen_count || 1, source: e.source };
}
function noteMemoriesUsed(list) {
  if (!memoryTurn) return;
  for (const e of list) memoryTurn.used.add(e.id);
}

// System-prompt block for this request.
function buildMemoryPromptBlock(userText, toolNames) {
  if (!isMemoryEnabled()) return '';
  const query = { textTokens: memoryTokens(userText), textAreas: areasFromText(userText), toolNames };
  const picked = selectMemories(query);
  if (!picked.length) {
    return memoryState.entries.length
      ? `\n## Learning memory\nYou have ${memoryState.entries.length} stored lesson(s) from earlier sessions, none matched this request. Before a step you are unsure of, call manage_memory(action="search", query="…").\n`
      : '';
  }
  noteMemoriesUsed(picked);
  let body = '';
  for (const e of picked) {
    const line = `- ${formatMemoryLine(e)}\n`;
    if (body.length + line.length > MEMORY_PROMPT_MAX_CHARS) break;
    body += line;
  }
  return `\n## Learning memory — BINDING lessons from earlier sessions that match this request
Each lesson was learned from a real failure on DHIS2 or is a rule the user gave you. They override your defaults:
- Before EVERY tool call, check whether a lesson below applies, and apply it.
- If a lesson says a call fails or is not allowed, do NOT make that call. Do what the lesson says; if that means the request cannot be done as asked, tell the user directly (cite the lesson) instead of trying the call.
- [user rule] lessons are instructions from the user — always follow them.
If a lesson turns out to be wrong or outdated, record the corrected one with manage_memory(action="record", supersedes="<id>", …). More: manage_memory(action="search", query="…").
${body}`;
}

const MEMORY_TOOL_RULE = 'BINDING lessons for this tool from earlier sessions: apply them to this call. If one says the call fails or is not allowed, do not make it — follow the lesson or tell the user.';

// Lessons for one tool (manual gate) or one failing call.
function memoryLessonsFor({ tool, args, userText, limit = 4 }) {
  if (!isMemoryEnabled()) return [];
  const query = {
    tool, action: args?.action || null,
    endpoint: tool === 'dhis2_query' ? normalizeEndpoint(args?.path) : null,
    textTokens: memoryTokens(`${userText || ''} ${args?.action || ''} ${tool === 'dhis2_query' ? args?.path || '' : ''}`),
    textAreas: [areaForCall(tool, args)],
    toolNames: [tool],
  };
  const picked = selectMemories(query, { limit, minScore: 6 });
  noteMemoriesUsed(picked);
  return picked.map(e => formatMemoryLine(e, 420));
}

// ── Per-turn observation (automatic lessons) ────────────────────────────────
const MEMORY_IGNORED_SCOPES = new Set([
  'requires_user_confirmation', 'requires_matching_tool', 'patient_data_privacy_gate',
  'incomplete_call', 'incomplete_call_repeat', 'circuit_breaker_tool_disabled', 'target_not_found',
  'destructive_404_limit_reached', 'http_error_limit_reached', 'repeated_identical_failure',
  'same_error_family_limit', 'no_progress_repeat', 'unknown_uid_in_args',
]);

function memoryBeginTurn(userText, ctx, toolNames) {
  memoryTurn = {
    toolNames: new Set(toolNames || []),
    taint: null,
    failures: [],      // pending failures (unresolved so far)
    recoveries: [],    // { failure, tool, args, betweenTools }
    recorded: [],      // ids recorded via manage_memory this turn
    recordedTools: new Set(),
    used: new Set(),
    nudged: false,
    executed: [],      // tool names in execution order (for "between" context)
    learned: [],       // titles of lessons written at turn end (for the panel)
  };
  if (ctx && (ctx.teiId || ctx.enrollmentId || ctx.eventId)) memoryTaint('the page shows a patient record (tracked entity / enrollment / event in the URL)');
  if (typeof SAVE_FAILURE_RE !== 'undefined' && SAVE_FAILURE_RE.test(String(userText || '').toLowerCase()) && ctx?.programId) {
    memoryTaint('save-error diagnosis reads the record\'s enrollments');
  }
}
function memoryTaint(reason) {
  if (memoryTurn && !memoryTurn.taint) {
    memoryTurn.taint = reason;
    console.log(`[Memory] turn tainted — no memory writes: ${reason}`);
  }
}
function memoryCallTouchesPatientData(tool, args, result) {
  try {
    if (typeof toolReadsPatientData === 'function' && toolReadsPatientData(tool, args)) return true;
  } catch { /* fall through */ }
  if (tool === 'dhis2_query') {
    const p = String(args?.path || '').replace(/^\/+/, '').replace(/^api\/(\d+\/)?/, '');
    const m = String(args?.method || 'GET').toUpperCase();
    if (m !== 'GET' && /^(tracker|trackedEntityInstances|events|enrollments|relationships)(\/|\?|$)/i.test(p)) return true;
  }
  if (tool === 'cross_stage_entity_intersection') return true;
  if (result && (result._trackerSummary || result.trackedEntities || result.instances)) return true;
  return false;
}
function memoryIsFailure(result) {
  if (!result || typeof result !== 'object') return false;
  if (result._tool_manual) return false;
  if (!(result._error || result.success === false)) return false;
  if (result._privacy_block || result._backup_failure) return false;
  if (MEMORY_IGNORED_SCOPES.has(result._scope)) return false;
  return true;
}
function memoryCallSig(tool, args) {
  return `${tool}|${args?.action || ''}|${tool === 'dhis2_query' ? `${String(args?.method || 'GET').toUpperCase()} ${normalizeEndpoint(args?.path) || ''}` : ''}`;
}

// Called after every EXECUTED tool call. Returns { lessons, note } to attach to
// the tool result (either may be null).
function memoryObserveCall(tool, args, result) {
  if (!memoryTurn || !isMemoryEnabled() || tool === 'manage_memory') return { lessons: null, note: null };
  if (memoryCallTouchesPatientData(tool, args, result)) memoryTaint(`${tool} touched patient-level tracker data`);
  memoryTurn.executed.push(tool);
  const out = { lessons: null, note: null };
  if (memoryIsFailure(result)) {
    const failure = {
      sig: memoryCallSig(tool, args), tool, action: args?.action || null,
      method: tool === 'dhis2_query' ? String(args?.method || 'GET').toUpperCase() : null,
      endpoint: tool === 'dhis2_query' ? normalizeEndpoint(args?.path) : null,
      area: areaForCall(tool, args),
      error: scrubMemoryText(result._error || (Array.isArray(result.errors) ? result.errors[0] : '') || 'failed', 360),
      hint: scrubMemoryText(result._hint || '', 360),
      redirect: result._redirect || null,
      shape: [...memoryArgShape(args)], safe: memorySafeValues(args),
      at: memoryTurn.executed.length,
    };
    if (!memoryTurn.failures.some(f => f.sig === failure.sig && f.error === failure.error)) memoryTurn.failures.push(failure);
    if (!memoryTurn.taint) {
      const lessons = memoryLessonsFor({ tool, args, userText: failure.error });
      if (lessons.length) out.lessons = lessons;
    }
    return out;
  }
  // Success: does it resolve an earlier failure this turn?
  const sig = memoryCallSig(tool, args);
  const ep = tool === 'dhis2_query' ? normalizeEndpoint(args?.path) : null;
  const idx = memoryTurn.failures.findIndex(f =>
    f.sig === sig
    || (f.tool === tool && f.action === (args?.action || null) && (tool !== 'dhis2_query' || (f.endpoint && ep && f.endpoint.split('/')[0] === ep.split('/')[0])))
    || (f.redirect && f.redirect === tool));
  if (idx >= 0) {
    const failure = memoryTurn.failures.splice(idx, 1)[0];
    memoryTurn.recoveries.push({
      failure, tool, action: args?.action || null,
      method: tool === 'dhis2_query' ? String(args?.method || 'GET').toUpperCase() : null,
      endpoint: ep, shape: [...memoryArgShape(args)], safe: memorySafeValues(args),
      between: memoryTurn.executed.slice(failure.at, memoryTurn.executed.length - 1),
    });
    if (!memoryTurn.taint && !memoryTurn.nudged && memoryTurn.toolNames.has('manage_memory')) {
      memoryTurn.nudged = true;
      out.note = `You recovered from the earlier ${failure.tool}${failure.action ? `(${failure.action})` : ''} failure ("${failure.error.slice(0, 140)}"). Save the lesson NOW in ONE short call so it never happens again: manage_memory(action="record", area="${failure.area}", tools=["${failure.tool}"${failure.tool !== tool ? `, "${tool}"` : ''}], title=<what to do, ≤12 words>, problem=<what failed and why>, solution=<the exact correct call/parameters>). Then continue the task.`;
    }
  }
  return out;
}

function describeRecoveryDiff(r) {
  const parts = [];
  if (r.failure.tool !== r.tool) parts.push(`use ${r.tool}${r.action ? `(action="${r.action}")` : ''} instead of ${r.failure.tool}${r.failure.action ? `(${r.failure.action})` : ''}`);
  if (r.failure.endpoint && r.endpoint && r.failure.endpoint !== r.endpoint) parts.push(`endpoint ${r.failure.method} ${r.failure.endpoint} → ${r.method} ${r.endpoint}`);
  else if (r.failure.method && r.method && r.failure.method !== r.method) parts.push(`method ${r.failure.method} → ${r.method}`);
  const before = new Set(r.failure.shape), after = new Set(r.shape);
  const added = [...after].filter(k => !before.has(k)).slice(0, 8);
  const removed = [...before].filter(k => !after.has(k)).slice(0, 8);
  if (added.length) parts.push(`added ${added.join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.join(', ')}`);
  const changed = [];
  for (const [k, v] of Object.entries(r.safe)) if (r.failure.safe[k] !== undefined && r.failure.safe[k] !== v) changed.push(`${k}: ${r.failure.safe[k]} → ${v}`);
  for (const [k, v] of Object.entries(r.safe)) if (r.failure.safe[k] === undefined && !added.includes(k)) changed.push(`${k}=${v}`);
  if (changed.length) parts.push(changed.slice(0, 6).join('; '));
  return parts;
}

// Called once when the turn ends (every exit path). Writes automatic lessons.
async function memoryEndTurn() {
  const t = memoryTurn;
  memoryTurn = null;
  if (!t || !isMemoryEnabled()) return [];
  let changed = false;
  for (const id of t.used) {
    const e = memoryState.entries.find(x => x.id === id);
    if (e) { e.used_count = (e.used_count || 0) + 1; changed = true; }
  }
  const learned = [];
  if (!t.taint) {
    for (const r of t.recoveries) {
      // The model already wrote a proper lesson about this tool — keep that one.
      if (t.recordedTools.has(r.failure.tool) || t.recordedTools.has(r.tool)) continue;
      const diff = describeRecoveryDiff(r);
      const solution = diff.length
        ? `Worked after changing the call: ${diff.join('; ')}.${r.failure.hint ? ` (Tool hint: ${r.failure.hint})` : ''}`
        : (r.between.length
          ? `The same call succeeded after first running ${[...new Set(r.between)].slice(0, 4).join(', ')} — do that step first.${r.failure.hint ? ` (Tool hint: ${r.failure.hint})` : ''}`
          : (r.failure.hint ? `Follow the tool hint: ${r.failure.hint}` : ''));
      if (!solution) continue;
      const entry = buildMemoryEntry({
        area: r.failure.area,
        tools: [r.failure.tool, r.tool],
        endpoint: r.failure.endpoint,
        title: `${r.failure.tool}${r.failure.action ? `(${r.failure.action})` : ''}${r.failure.endpoint ? ` ${r.failure.method} ${r.failure.endpoint}` : ''}: avoid "${r.failure.error.slice(0, 70)}"`,
        problem: `Failed with: ${r.failure.error}`,
        solution,
        scope: 'general',
      }, 'auto');
      if (memoryValidateEntry(entry)) continue;
      upsertMemoryEntry(entry);
      learned.push(entry.title);
      changed = true;
    }
    // Unrecovered failures are recorded only when the tool explained the fix.
    for (const f of t.failures) {
      if (!f.hint || f.hint.length < 30 || t.recordedTools.has(f.tool)) continue;
      const entry = buildMemoryEntry({
        area: f.area, tools: [f.tool, f.redirect].filter(Boolean), endpoint: f.endpoint,
        title: `${f.tool}${f.action ? `(${f.action})` : ''}${f.endpoint ? ` ${f.method} ${f.endpoint}` : ''}: "${f.error.slice(0, 70)}"`,
        problem: `Failed with: ${f.error}`,
        solution: f.hint,
        resolved: false,
        scope: 'general',
      }, 'auto');
      if (memoryValidateEntry(entry)) continue;
      upsertMemoryEntry(entry);
      learned.push(entry.title);
      changed = true;
    }
  }
  if (changed) await persistMemory();
  const all = [...t.learned, ...learned];
  if (all.length) {
    try { broadcast({ type: 'AI_MEMORY_LEARNED', count: all.length, titles: all.slice(0, 5) }); } catch {}
  }
  return all;
}

// The user explicitly asked to remember something this turn → the lesson the
// model records is a USER RULE (highest rank, tagged as such in the prompt).
// Decided from the user's own words, never from the model's say-so.
const MEMORY_USER_REMEMBER_RE = /\b(?:remember|memori[sz]e|keep in mind|note (?:this|that)|from now on|in (?:the )?future|next time|always (?:use|do|make|set|put)|never (?:use|do|make|set|enter))\b/i;
function memoryUserAskedToRemember() {
  return typeof lastUserText === 'string' && MEMORY_USER_REMEMBER_RE.test(lastUserText);
}

// ── manage_memory tool ───────────────────────────────────────────────────────
async function executeManageMemory(args) {
  await ensureMemoryLoaded();
  if (!isMemoryEnabled()) return { _error: 'Learning memory is switched off in the extension settings.', _hint: 'Continue without memory; do not call manage_memory again this turn.' };
  const action = args?.action;
  if (action === 'search') {
    const q = String(args.query || '');
    const area = args.area && MEMORY_AREAS[args.area] ? args.area : null;
    const query = { textTokens: memoryTokens(q), textAreas: area ? [area] : areasFromText(q), toolNames: Array.isArray(args.tools) ? args.tools : [], tool: args.tool || null, endpoint: args.endpoint ? normalizeEndpoint(args.endpoint) : null };
    const picked = selectMemories(query, { limit: Math.min(Number(args.limit) || 8, 20), minScore: 1.5, area });
    noteMemoriesUsed(picked);
    return { success: true, total_stored: memoryState.entries.length, matches: picked.length, lessons: picked.map(compactMemory), ...(picked.length ? {} : { _note: 'No stored lesson matches. Proceed carefully and record what you learn if you hit and fix an error.' }) };
  }
  if (action === 'list') {
    const area = args.area && MEMORY_AREAS[args.area] ? args.area : null;
    const rows = memoryState.entries.filter(e => memoryApplicable(e) && (!area || e.area === area));
    const byArea = {};
    for (const e of rows) byArea[e.area] = (byArea[e.area] || 0) + 1;
    return { success: true, total: rows.length, by_area: byArea, lessons: rows.slice(-Math.min(Number(args.limit) || 20, 50)).reverse().map(compactMemory) };
  }
  if (action === 'record') {
    if (memoryTurn?.taint) {
      return { _error: `Not recorded: this turn touched patient-level data (${memoryTurn.taint}), so memory writes are disabled for it. Memory never stores anything from such turns.`, _hint: 'Continue the task. Do not retry manage_memory this turn.' };
    }
    if (args.supersedes && !memoryState.entries.some(e => e.id === args.supersedes)) {
      return { _error: `supersedes="${args.supersedes}" does not match a stored lesson.`, _hint: 'Use the id shown as (#id) in the lesson, or omit supersedes.' };
    }
    const entry = buildMemoryEntry({
      area: args.area, tools: Array.isArray(args.tools) ? args.tools : (args.tool ? [args.tool] : []),
      endpoint: args.endpoint, title: args.title, problem: args.problem, solution: args.solution,
      scope: args.scope,
    }, memoryUserAskedToRemember() ? 'user' : 'assistant');
    const bad = memoryValidateEntry(entry);
    if (bad) return { _error: `Not recorded: ${bad}`, _hint: 'Write the lesson as general DHIS2/API knowledge (endpoints, parameters, rules) with no names, values or identifiers of people.' };
    const { entry: saved, merged } = upsertMemoryEntry(entry, { supersedes: args.supersedes || null });
    if (memoryTurn) {
      memoryTurn.recorded.push(saved.id);
      for (const t of saved.tools) memoryTurn.recordedTools.add(t);
      memoryTurn.learned.push(saved.title);
    }
    await persistMemory();
    return { success: true, action: 'record', id: saved.id, merged_with_existing: merged, lesson: compactMemory(saved), message: merged ? 'Merged into an existing matching lesson (seen count increased).' : 'Lesson stored — it will be shown automatically on future related tasks.' };
  }
  return { _error: `Unknown action "${action}" for manage_memory.`, _hint: 'One of: search, list, record.' };
}

// ── Panel API (settings → Learning memory) ───────────────────────────────────
async function memoryPanelRequest(msg) {
  await ensureMemoryLoaded();
  switch (msg.type) {
    case 'MEMORY_GET':
      return {
        enabled: isMemoryEnabled(),
        entries: memoryState.entries.slice().sort((a, b) => String(b.updated).localeCompare(String(a.updated))),
        areas: Object.fromEntries(MEMORY_AREA_KEYS.map(k => [k, MEMORY_AREAS[k].label])),
        max: MEMORY_MAX_ENTRIES,
      };
    case 'MEMORY_SET_ENABLED':
      return { enabled: await setMemoryEnabled(msg.enabled) };
    case 'MEMORY_DELETE': {
      const before = memoryState.entries.length;
      memoryState.entries = memoryState.entries.filter(e => e.id !== msg.id);
      await persistMemory();
      return { success: memoryState.entries.length < before };
    }
    case 'MEMORY_CLEAR':
      memoryState.entries = [];
      await persistMemory();
      return { success: true };
    case 'MEMORY_ADD_NOTE': {
      const n = msg.note || {};
      const entry = buildMemoryEntry({ area: n.area, tools: [], title: n.title, problem: n.problem, solution: n.solution, scope: n.scope }, 'user');
      const bad = memoryValidateEntry(entry);
      if (bad) return { error: bad };
      const { entry: saved, merged } = upsertMemoryEntry(entry);
      await persistMemory();
      return { success: true, entry: saved, merged };
    }
    default:
      return { error: `unknown memory request ${msg.type}` };
  }
}

// Load at worker start so the first turn's tool selection sees the setting.
ensureMemoryLoaded();
