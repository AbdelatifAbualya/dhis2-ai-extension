// ── Administration tools: users & roles, aggregate data values, metadata
// translations — plus the schema-aware PATCH pre-check used by dhis2_query ──
//
// Everything in this module mirrors an API sequence verified live on a
// self-hosted DHIS2 2.42.5.1 (localhost:8081, 2026-10-20). The DHIS2 quirks
// each tool encodes — all of them SILENT on the server side, which is why a
// dedicated tool is the only safe path:
//
//   Users / roles
//   • POST /api/users IGNORES ?dryRun=true and really creates the user. Only
//     POST /api/metadata?importMode=VALIDATE is a true dry run for users.
//   • The legacy nested `userCredentials:{username,password,userRoles}` shape
//     (pre-2.38) is rejected on 2.42 (E4049 username null + E4055 no role).
//   • Password policy: minPasswordLength..maxPasswordLength (systemSettings),
//     plus ≥1 lower case, ≥1 upper case, ≥1 digit, ≥1 special character.
//   • A role saved with an UNKNOWN authority string ("BOGUS_AUTH") is accepted
//     with HTTP 201 and stored verbatim — it silently grants nothing.
//   • PATCH users/{id} replace /userGroups returns HTTP 500 (and an `add` op
//     returns 200 but changes nothing): group membership is owned by the
//     GROUP. The only reliable path is POST|DELETE userGroups/{g}/users/{u}.
//
//   Aggregate data values (dataValueSets)
//   • Without the strict* import flags DHIS2 SILENTLY stores values that can
//     never be seen in Data Entry: a weekly period on a monthly dataset, an org
//     unit the dataset is not assigned to, and a disaggregated data element
//     with no categoryOptionCombo (filed under the default COC) all return
//     status SUCCESS.
//   • openFuturePeriods=0 means only ENDED periods are open — the current month
//     is rejected (E7641 "after latest open future period").
//   • A partial import returns HTTP 409 with status WARNING while some values
//     WERE imported — reading the 409 as "nothing saved" is wrong.
//
//   Metadata translations
//   • PUT {type}/{id}/translations REPLACES the object's whole translation set
//     — writing one French name silently wipes every other locale.
//   • Unknown locales ("xx_YY") and unknown properties ("BOGUS") are accepted
//     with 204 and stored verbatim — they never render anywhere.
//   • Translated names only show with ?translate=true&locale=<l>, not ?locale=.

// ── Shared caches (per DHIS2 instance) ───────────────────────────────────────
const _adminCache = {
  baseUrl: null,
  schemaIndex: null,      // Map lowercase key → { name, plural }
  schemas: new Map(),     // singular name → schema (properties)
  authorities: null,      // [{ id, name }]
  dbLocales: null,        // [{ locale, name }]
  defaultCoc: null,       // default categoryOptionCombo UID
};
function _adminCacheSync() {
  if (_adminCache.baseUrl !== dhis2.baseUrl) {
    _adminCache.baseUrl = dhis2.baseUrl;
    _adminCache.schemaIndex = null;
    _adminCache.schemas = new Map();
    _adminCache.authorities = null;
    _adminCache.dbLocales = null;
    _adminCache.defaultCoc = null;
  }
}

// Every import call site needs the same "sanitize a free-text name into a
// filter value" step: DHIS2 filters split on ':' so a raw colon breaks them.
function _filterValue(s) {
  return encodeURIComponent(String(s ?? '').replace(/:/g, ' ').trim());
}

function _lc(s) { return String(s ?? '').trim().toLowerCase(); }
function _squash(s) { return _lc(s).replace(/[^a-z0-9؀-ۿ]+/g, ''); }
// Like _squash but KEEPS the symbols that carry meaning in disaggregation and
// data-element names: "<5" vs "5+" vs ">=5", "%". _squash collapses all three
// to "5" — a value would land in the WRONG age band.
function _soft(s) { return _lc(s).replace(/[^a-z0-9<>=+%≤≥\u0600-\u06ff]+/g, ''); }

// Small edit distance for "did you mean" suggestions (bounded input sizes).
function _editDistance(a, b) {
  a = _lc(a); b = _lc(b);
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function _closest(word, candidates, max = 5) {
  const w = _lc(word);
  return [...new Set(candidates)]
    .map(c => ({ c, d: _lc(c).includes(w) || w.includes(_lc(c)) ? 0 : _editDistance(w, c) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map(x => x.c);
}

// ── Schema index & per-type schema (used by translations + PATCH pre-check) ──
async function getSchemaIndex() {
  _adminCacheSync();
  if (_adminCache.schemaIndex) return _adminCache.schemaIndex;
  const resp = await safeDhis2Fetch('schemas?fields=name,plural,translatable', { noTruncate: true });
  if (!resp || resp._error || !Array.isArray(resp.schemas)) return null;
  const idx = new Map();
  for (const s of resp.schemas) {
    if (!s?.name || !s?.plural) continue;
    const entry = { name: s.name, plural: s.plural, translatable: !!s.translatable };
    for (const k of [s.name, s.plural]) {
      idx.set(_lc(k), entry);
      idx.set(_squash(k), entry);
    }
  }
  _adminCache.schemaIndex = idx;
  return idx;
}

// Resolve "data element" / "dataElement" / "dataElements" / "Data Elements" →
// { name:'dataElement', plural:'dataElements' } (or null).
async function resolveSchemaType(type) {
  if (!type) return null;
  const idx = await getSchemaIndex();
  if (!idx) return null;
  const raw = String(type).trim();
  return idx.get(_lc(raw)) || idx.get(_squash(raw))
    || idx.get(_squash(raw).replace(/s$/, '')) || idx.get(_squash(raw) + 's') || null;
}

async function getSchemaFor(type) {
  _adminCacheSync();
  const t = await resolveSchemaType(type);
  if (!t) return null;
  if (_adminCache.schemas.has(t.name)) return _adminCache.schemas.get(t.name);
  const resp = await safeDhis2Fetch(
    `schemas/${t.name}?fields=name,plural,translatable,properties[name,fieldName,collectionName,propertyType,klass,constants,writable,translatable,translationKey]`,
    { noTruncate: true }
  );
  if (!resp || resp._error || !Array.isArray(resp.properties)) return null;
  const schema = { name: t.name, plural: t.plural, translatable: !!resp.translatable, properties: resp.properties };
  _adminCache.schemas.set(t.name, schema);
  return schema;
}

// ── dhis2_query PATCH pre-check ──────────────────────────────────────────────
// A PATCH whose op path names a property the schema does not have is a
// guaranteed HTTP 400 ("Property allowFutureEnrollment does not exist on
// Schema"), and an enum value outside the schema's constants is a guaranteed
// 400 too (featureType "CIRCLE"). Both are knowable before the request, so
// refuse them client-side with the closest real property names — no failed
// API call, and the model gets the fix instead of a stack trace. Returns null
// when the patch looks valid OR when the schema cannot be loaded (never blocks
// on our own uncertainty).
async function precheckPatchAgainstSchema(safePath, body) {
  const m = String(safePath || '').split('?')[0].match(/^([a-zA-Z]+)\/([A-Za-z][A-Za-z0-9]{10})$/);
  if (!m) return null;
  let ops = body;
  if (typeof ops === 'string') { try { ops = JSON.parse(ops); } catch { return null; } }
  if (ops && typeof ops === 'object' && !Array.isArray(ops)) {
    ops = Object.entries(ops).map(([k, v]) => ({ op: 'add', path: '/' + k, value: v }));
  }
  if (!Array.isArray(ops) || !ops.length) return null;
  // Group membership is owned by the group: PATCHing /userGroups on a user is
  // a 500 (replace) or a silent no-op (add). Verified 2.42.5.1.
  if (m[1] === 'users' && ops.some(o => /^\/userGroups(\/|$)/.test(String(o?.path || '')))) {
    return {
      _error: 'Blocked: PATCH users/{id} on /userGroups does not work in DHIS2 — "replace" returns HTTP 500 and "add" returns 200 while changing nothing (membership is owned by the user GROUP).',
      _hint: `Use manage_users(action="update", user_id="${m[2]}", add_groups=[…], remove_groups=[…]) — it calls POST/DELETE userGroups/{groupId}/users/{userId}, the only reliable path.`,
      _redirect: 'manage_users',
    };
  }
  const schema = await getSchemaFor(m[1]);
  if (!schema) return null;
  const byName = new Map();
  for (const p of schema.properties) {
    for (const k of [p.name, p.fieldName, p.collectionName]) if (k) byName.set(k, p);
  }
  const unknown = [];
  const badEnum = [];
  for (const op of ops) {
    const seg = String(op?.path || '').replace(/^\//, '').split('/')[0].replace(/~1/g, '/').replace(/~0/g, '~');
    if (!seg) continue;
    const prop = byName.get(seg);
    if (!prop) { unknown.push(seg); continue; }
    // periodType is a reference (klass PeriodType), not an enum, so the schema
    // carries no constants — but an unknown name is still a guaranteed 409.
    if (/PeriodType$/.test(String(prop.klass || '')) && (op.op === 'add' || op.op === 'replace')
        && typeof op.value === 'string' && !Object.prototype.hasOwnProperty.call(PERIOD_PATTERNS, op.value)) {
      badEnum.push({ property: seg, value: op.value, allowed: Object.keys(PERIOD_PATTERNS) });
      continue;
    }
    if (prop.propertyType === 'CONSTANT' && Array.isArray(prop.constants) && prop.constants.length
        && (op.op === 'add' || op.op === 'replace') && op.value != null && typeof op.value === 'string'
        && String(op.path).split('/').length === 2 && !prop.constants.includes(op.value)) {
      badEnum.push({ property: seg, value: op.value, allowed: prop.constants });
    }
  }
  if (!unknown.length && !badEnum.length) return null;
  const allNames = [...byName.keys()];
  return {
    _error: `Refused before sending: this PATCH would fail on DHIS2 (HTTP 400) — ${[
      ...unknown.map(u => `"${u}" is not a property of ${schema.name}`),
      ...badEnum.map(b => `${b.property}="${b.value}" is not a valid value`),
    ].join('; ')}.`,
    _schema: schema.name,
    ...(unknown.length ? { did_you_mean: Object.fromEntries(unknown.map(u => [u, _closest(u, allNames, 6)])) } : {}),
    ...(badEnum.length ? { allowed_values: Object.fromEntries(badEnum.map(b => [b.property, b.allowed])) } : {}),
    _hint: 'Use the EXACT property names / enum values listed above (case-sensitive) and re-issue the PATCH. Do not guess other names.',
  };
}

// ── Raw dataValueSets imports (dhis2_query) ──────────────────────────────────
// Make DHIS2 reject the silent-wrong-data cases instead of storing them, and
// annotate the misleading partial-import 409. Explicitly passed strict* params
// are respected.
const DATA_VALUE_STRICT_PARAMS = ['strictPeriods', 'strictOrganisationUnits', 'strictCategoryOptionCombos', 'strictAttributeOptionCombos', 'strictDataElements'];
function hardenDataValueSetsPath(safePath) {
  const [p, q = ''] = String(safePath).split('?');
  const qs = new URLSearchParams(q);
  if (/^delete$/i.test(qs.get('importStrategy') || '')) return safePath;
  let changed = false;
  for (const k of DATA_VALUE_STRICT_PARAMS) {
    if (!qs.has(k)) { qs.set(k, 'true'); changed = true; }
  }
  return changed ? `${p}?${qs.toString()}` : safePath;
}
function summarizeDataValueImport(resp) {
  const body = resp?._body || resp;
  const r = body?.response || body;
  if (!r || !r.importCount) return null;
  return {
    status: r.status,
    importCount: r.importCount,
    conflicts: (r.conflicts || []).slice(0, 20).map(c => ({ code: c.errorCode, message: c.value, indexes: c.indexes })),
    ...(r.description && r.status !== 'SUCCESS' ? { description: r.description } : {}),
    ...(body?.message && r.status !== 'SUCCESS' ? { message: body.message } : {}),
  };
}

// ── Generic id-or-name resolution ────────────────────────────────────────────
// resource: plural endpoint. nameField: field used for exact/ilike matching.
// Returns { items:[{input,id,name}], unresolved:[{input,suggestions}], ambiguous:[{input,matches}] }.
async function resolveIdsOrNames(resource, inputs, { nameField = 'displayName', extraFields = '', exactField = null } = {}) {
  const items = [], unresolved = [], ambiguous = [];
  const list = (Array.isArray(inputs) ? inputs : [inputs]).filter(v => v != null && String(v).trim() !== '');
  const flds = `id,${nameField}${extraFields ? ',' + extraFields : ''}`;
  const uidInputs = list.filter(v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9]{10}$/.test(v.trim()) && isLikelyDhisUid(v.trim()));
  if (uidInputs.length) {
    const resp = await safeDhis2Fetch(`${resource}?filter=id:in:[${uidInputs.join(',')}]&fields=${flds}&paging=false`, { noTruncate: true });
    const found = new Map(((resp && resp[resource]) || []).map(o => [o.id, o]));
    for (const v of uidInputs) {
      const o = found.get(v.trim());
      if (o) items.push({ input: v, id: o.id, name: o[nameField] ?? o.displayName ?? o.name, obj: o });
    }
  }
  for (const v of list) {
    if (items.some(i => i.input === v)) continue;
    const s = typeof v === 'object' ? (v.id || v.name || '') : String(v).trim();
    if (typeof v === 'object' && v.id) {
      // {id} object passed but not found above (or not UID-shaped)
      unresolved.push({ input: s, suggestions: [] });
      continue;
    }
    const field = exactField || nameField;
    const resp = await safeDhis2Fetch(`${resource}?filter=${field}:ilike:${_filterValue(s)}&fields=${flds}&pageSize=25`, { noTruncate: true });
    const rows = (resp && resp[resource]) || [];
    const exact = rows.filter(o => _lc(o[field]) === _lc(s) || _lc(o[nameField]) === _lc(s));
    if (exact.length === 1) { items.push({ input: v, id: exact[0].id, name: exact[0][nameField], obj: exact[0] }); continue; }
    if (exact.length > 1) { ambiguous.push({ input: s, matches: exact.slice(0, 8).map(o => ({ id: o.id, name: o[nameField] })) }); continue; }
    if (rows.length === 1) { items.push({ input: v, id: rows[0].id, name: rows[0][nameField], obj: rows[0], loose: true }); continue; }
    if (rows.length > 1) { ambiguous.push({ input: s, matches: rows.slice(0, 8).map(o => ({ id: o.id, name: o[nameField] })) }); continue; }
    unresolved.push({ input: s, suggestions: [] });
  }
  return { items, unresolved, ambiguous };
}

function _resolutionError(kind, res) {
  const parts = [];
  if (res.unresolved.length) parts.push(`no ${kind} matches ${res.unresolved.map(u => `"${u.input}"`).join(', ')}`);
  if (res.ambiguous.length) parts.push(res.ambiguous.map(a => `"${a.input}" is ambiguous (${a.matches.map(m => `${m.name} [${m.id}]`).join(', ')})`).join('; '));
  if (!parts.length) return null;
  return {
    _error: `Could not resolve ${kind}: ${parts.join('; ')}.`,
    ...(res.ambiguous.length ? { ambiguous: res.ambiguous } : {}),
    _hint: `Pass the exact UID (from a list/search result) for each ${kind}, or the exact unique name. Never invent UIDs.`,
  };
}

// Array arguments sometimes arrive JSON-encoded (weak models, constrained
// decoders). Decode in place; anything unparseable is left for the normal
// validation message.
function _decodeJsonArgs(args, keys) {
  for (const k of keys) {
    if (typeof args?.[k] === 'string' && /^\s*[\[{]/.test(args[k])) {
      try { args[k] = JSON.parse(args[k]); } catch { /* leave as-is */ }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// manage_users — users, user roles, user groups, authorities
// ════════════════════════════════════════════════════════════════════════════

async function getAuthorityCatalog() {
  _adminCacheSync();
  if (_adminCache.authorities) return _adminCache.authorities;
  const resp = await safeDhis2Fetch('authorities', { noTruncate: true });
  const list = resp?.systemAuthorities;
  if (!Array.isArray(list)) return null;
  _adminCache.authorities = list.map(a => ({ id: a.id, name: a.name }));
  return _adminCache.authorities;
}

// Resolve authority inputs (exact id like "F_DATAVALUE_ADD", or the human name
// "Add data value", or an app name like "Capture"/"dhis-web-capture" → the
// M_<app> authority). Unknown ones are reported with suggestions instead of
// being stored verbatim (DHIS2 silently accepts garbage authorities).
async function resolveAuthorities(inputs) {
  const catalog = await getAuthorityCatalog();
  if (!catalog) return { _error: 'Could not load the authority catalogue (GET /api/authorities).' };
  const byId = new Map(catalog.map(a => [a.id, a]));
  const byIdLc = new Map(catalog.map(a => [_lc(a.id), a]));
  const byName = new Map(catalog.map(a => [_lc(a.name), a]));
  const ok = [], bad = [];
  for (const raw of (inputs || [])) {
    const s = String(raw || '').trim();
    if (!s) continue;
    let hit = byId.get(s) || byIdLc.get(_lc(s)) || byName.get(_lc(s));
    if (!hit) {
      // Every word of the request appears in exactly one authority's name:
      // "Add data value" → "Add/Update Data Value" (F_DATAVALUE_ADD).
      const words = _lc(s).split(/[^a-z0-9]+/).filter(w => w.length > 1);
      if (words.length >= 2) {
        const subset = catalog.filter(a => { const nw = new Set(_lc(a.name).split(/[^a-z0-9]+/)); return words.every(w => nw.has(w)); });
        if (subset.length === 1) hit = subset[0];
      }
    }
    if (!hit) {
      // App access: "capture" / "dhis-web-capture" / "Capture app" → M_dhis-web-capture
      const app = _lc(s).replace(/\s*app$/, '').replace(/^m_/, '').replace(/\s+/g, '-');
      hit = byIdLc.get(`m_${app}`) || byIdLc.get(`m_dhis-web-${app}`)
        || catalog.find(a => a.id.startsWith('M_') && _squash(a.id.slice(2)).endsWith(_squash(app)) && _squash(app).length >= 4) || null;
    }
    if (hit) ok.push(hit); else bad.push(s);
  }
  if (bad.length) {
    const all = catalog.flatMap(a => [a.id, a.name]);
    return {
      _error: `Unknown authority value(s): ${bad.join(', ')}. DHIS2 would store these verbatim and they would grant NOTHING.`,
      did_you_mean: Object.fromEntries(bad.map(b => [b, _closest(b, all, 6)])),
      _hint: 'Use manage_users(action="list_authorities", query="<keyword>") to find the exact authority ids, then retry.',
    };
  }
  return { authorities: [...new Map(ok.map(a => [a.id, a])).values()] };
}

async function getPasswordPolicy() {
  const s = await safeDhis2Fetch('systemSettings?key=minPasswordLength&key=maxPasswordLength');
  const min = Number(s?.minPasswordLength) || 8;
  const max = Number(s?.maxPasswordLength) || 72;
  return { min, max };
}
function checkPassword(pw, policy) {
  const p = String(pw || '');
  const problems = [];
  if (p.length < policy.min || p.length > policy.max) problems.push(`must be ${policy.min}–${policy.max} characters`);
  if (!/[a-z]/.test(p)) problems.push('needs a lower-case letter');
  if (!/[A-Z]/.test(p)) problems.push('needs an upper-case letter');
  if (!/[0-9]/.test(p)) problems.push('needs a digit');
  if (!/[^A-Za-z0-9]/.test(p)) problems.push('needs a special character');
  return problems;
}
function generateStrongPassword(len = 14) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%&*?'];
  const all = sets.join('');
  const rnd = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const chars = sets.map(s => s[rnd(s.length)]);
  while (chars.length < len) chars.push(all[rnd(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
function checkUsername(u) {
  const s = String(u || '');
  if (s.length < 4 || s.length > 255) return 'must be 4–255 characters';
  if (/\s/.test(s)) return 'must not contain spaces';
  if (!/^[A-Za-z0-9._@-]+$/.test(s)) return 'may only contain letters, digits and . _ @ -';
  return null;
}

async function findUser(userIdOrName) {
  const v = String(userIdOrName || '').trim();
  if (!v) return { _error: 'user_id (or username) is required.' };
  if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(v) && isLikelyDhisUid(v)) {
    const r = await safeDhis2Fetch(`users/${v}?fields=id,username,displayName,disabled`);
    if (r && !r._error) return { id: r.id, username: r.username, name: r.displayName, disabled: r.disabled };
  }
  const r = await safeDhis2Fetch(`users?filter=username:eq:${_filterValue(v)}&fields=id,username,displayName,disabled&paging=false`);
  const u = r?.users?.[0];
  if (u) return { id: u.id, username: u.username, name: u.displayName, disabled: u.disabled };
  return { _error: `No user with id or username "${v}".`, _hint: 'Use manage_users(action="list", query="<name>") to find the user first.' };
}

const USER_LIST_FIELDS = 'id,username,displayName,disabled,lastLogin,email,userRoles[displayName],userGroups[displayName],organisationUnits[displayName]';

function _shapeUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.displayName || [u.firstName, u.surname].filter(Boolean).join(' '),
    disabled: !!u.disabled,
    last_login: u.lastLogin || null,
    email: u.email || null,
    phone_number: u.phoneNumber || undefined,
    roles: (u.userRoles || []).map(r => r.displayName || r.id),
    groups: (u.userGroups || []).map(g => g.displayName || g.id),
    capture_org_units: (u.organisationUnits || []).map(o => o.displayName || o.id),
    ...(u.dataViewOrganisationUnits ? { data_view_org_units: u.dataViewOrganisationUnits.map(o => o.displayName || o.id) } : {}),
    ...(u.teiSearchOrganisationUnits ? { search_org_units: u.teiSearchOrganisationUnits.map(o => o.displayName || o.id) } : {}),
  };
}

// Resolve the four reference lists a user carries. Returns { refs } or { _error }.
async function resolveUserRefs(args, keys) {
  const out = {};
  const spec = {
    roles: ['userRoles', 'user role'], add_roles: ['userRoles', 'user role'], remove_roles: ['userRoles', 'user role'],
    groups: ['userGroups', 'user group'], add_groups: ['userGroups', 'user group'], remove_groups: ['userGroups', 'user group'],
    org_units: ['organisationUnits', 'org unit'], add_org_units: ['organisationUnits', 'org unit'], remove_org_units: ['organisationUnits', 'org unit'],
    data_view_org_units: ['organisationUnits', 'org unit'], search_org_units: ['organisationUnits', 'org unit'],
  };
  for (const k of keys) {
    if (args[k] == null) continue;
    const vals = Array.isArray(args[k]) ? args[k] : [args[k]];
    if (!vals.length) { out[k] = []; continue; }
    const [res, kind] = spec[k];
    const r = await resolveIdsOrNames(res, vals.map(v => (v && typeof v === 'object') ? (v.id || v.name) : v),
      res === 'organisationUnits' ? { extraFields: 'level,path' } : {});
    const err = _resolutionError(kind, r);
    if (err) return { _error: err._error, ambiguous: err.ambiguous, _hint: err._hint, _field: k };
    out[k] = r.items.map(i => ({ id: i.id, name: i.name }));
  }
  return { refs: out };
}

async function executeManageUsers(args) {
  _decodeJsonArgs(args, ['roles', 'add_roles', 'remove_roles', 'groups', 'add_groups', 'remove_groups', 'org_units', 'add_org_units', 'remove_org_units', 'data_view_org_units', 'search_org_units', 'authorities', 'add_authorities', 'remove_authorities', 'members', 'add_members', 'remove_members', 'userCredentials']);
  const action = args?.action;
  const ACTIONS = 'list, get, create, update, disable, enable, delete, list_roles, get_role, create_role, update_role, delete_role, list_groups, create_group, update_group, delete_group, list_authorities';
  if (!action) return { _error: 'Missing required parameter: action', _hint: `One of: ${ACTIONS}.` };

  // ── list ──
  if (action === 'list') {
    const ps = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    const parts = [`fields=${USER_LIST_FIELDS}`, `pageSize=${ps}`, 'order=username:asc'];
    if (args.query) parts.push(`query=${encodeURIComponent(String(args.query))}`);
    if (args.disabled === true || args.disabled === false) parts.push(`filter=disabled:eq:${args.disabled}`);
    for (const [k, res, path] of [['role', 'userRoles', 'userRoles.id'], ['group', 'userGroups', 'userGroups.id'], ['org_unit', 'organisationUnits', 'organisationUnits.id']]) {
      if (!args[k]) continue;
      const r = await resolveIdsOrNames(res, [args[k]]);
      const err = _resolutionError(k.replace('_', ' '), r);
      if (err) return err;
      parts.push(`filter=${path}:eq:${r.items[0].id}`);
    }
    const resp = await safeDhis2Fetch(`users?${parts.join('&')}`);
    if (resp?._error) return { _error: `users list failed: ${resp._error}` };
    const users = (resp.users || []).map(_shapeUser);
    return { success: true, total: resp.pager?.total ?? users.length, returned: users.length, users };
  }

  // ── get ──
  if (action === 'get') {
    const f = await findUser(args.user_id || args.username);
    if (f._error) return f;
    const u = await safeDhis2Fetch(`users/${f.id}?fields=id,username,displayName,firstName,surname,disabled,lastLogin,email,phoneNumber,created,accountExpiry,passwordLastUpdated,externalAuth,userRoles[id,displayName],userGroups[id,displayName],organisationUnits[id,displayName],dataViewOrganisationUnits[id,displayName],teiSearchOrganisationUnits[id,displayName]`);
    if (u?._error) return { _error: `Could not load user ${f.id}: ${u._error}` };
    return {
      success: true,
      user: {
        ..._shapeUser(u),
        first_name: u.firstName, surname: u.surname, created: u.created,
        account_expiry: u.accountExpiry || null, password_last_updated: u.passwordLastUpdated || null,
        role_ids: (u.userRoles || []).map(r => r.id), group_ids: (u.userGroups || []).map(g => g.id),
        capture_org_unit_ids: (u.organisationUnits || []).map(o => o.id),
      },
    };
  }

  // ── create ──
  if (action === 'create') {
    const gate = requireWriteAuth('manage_users', 'create', { username: args.username });
    if (gate) return gate;
    // Heal the legacy pre-2.38 nesting the model often reaches for.
    const uc = args.userCredentials || args.user_credentials;
    if (uc && typeof uc === 'object') {
      args.username = args.username || uc.username;
      args.password = args.password || uc.password;
      if (!args.roles && Array.isArray(uc.userRoles)) args.roles = uc.userRoles.map(r => (r && typeof r === 'object') ? (r.id || r.name) : r).filter(Boolean);
    }
    const username = String(args.username || '').trim();
    const firstName = String(args.first_name || args.firstName || '').trim();
    const surname = String(args.surname || args.last_name || args.lastName || '').trim();
    const missing = [!username && 'username', !firstName && 'first_name', !surname && 'surname'].filter(Boolean);
    if (missing.length) return { _error: `Missing required field(s): ${missing.join(', ')}.`, _hint: 'A DHIS2 user needs username, first_name, surname, ≥1 role, and (to do anything) capture org_units.' };
    const unProblem = checkUsername(username);
    if (unProblem) return { _error: `Invalid username "${username}": ${unProblem}.` };
    if (!args.roles || (Array.isArray(args.roles) && !args.roles.length)) {
      return { _error: 'At least one user role is required (DHIS2 rejects a user without a role, E4055).', _hint: 'Pass roles:["<role name or UID>"]. List roles with manage_users(action="list_roles").' };
    }
    const policy = await getPasswordPolicy();
    let password = args.password;
    let generated = false;
    if (!password) {
      if (args.generate_password !== true) {
        return { _error: 'A password is required to create the user.', _hint: `Ask the user for an initial password (DHIS2 policy: ${policy.min}–${policy.max} chars with upper case, lower case, a digit and a special character), or pass generate_password:true to create a strong random one that the result returns ONCE.` };
      }
      password = generateStrongPassword(Math.max(14, policy.min));
      generated = true;
    }
    const pwProblems = checkPassword(password, policy);
    if (pwProblems.length) return { _error: `Password does not meet the DHIS2 password policy: ${pwProblems.join(', ')}.`, _hint: 'Ask the user for a compliant password, or pass generate_password:true (omit password).' };
    const dup = await safeDhis2Fetch(`users?filter=username:eq:${_filterValue(username)}&fields=id,displayName&paging=false`);
    if (dup?.users?.length) return { _error: `Username "${username}" already exists (user ${dup.users[0].displayName}, ${dup.users[0].id}).`, existing_user_id: dup.users[0].id, _hint: 'Pick another username, or update the existing user with action="update".' };
    const rr = await resolveUserRefs(args, ['roles', 'groups', 'org_units', 'data_view_org_units', 'search_org_units']);
    if (rr._error) return rr;
    const { refs } = rr;
    if (!(refs.roles || []).length) {
      return { _error: 'No valid user role was given (the roles list resolved to nothing) — DHIS2 rejects a user without a role (E4055).', _hint: 'Pass roles:["<exact role name or UID>"] from manage_users(action="list_roles").' };
    }
    const id = generateDhis2Uid();
    const user = {
      id, username, password, firstName, surname,
      userRoles: refs.roles.map(r => ({ id: r.id })),
      organisationUnits: (refs.org_units || []).map(o => ({ id: o.id })),
      dataViewOrganisationUnits: (refs.data_view_org_units || []).map(o => ({ id: o.id })),
      teiSearchOrganisationUnits: (refs.search_org_units || []).map(o => ({ id: o.id })),
      userGroups: (refs.groups || []).map(g => ({ id: g.id })),
    };
    if (args.email) user.email = String(args.email);
    if (args.phone_number) user.phoneNumber = String(args.phone_number);
    if (args.disabled === true) user.disabled = true;
    if (args.account_expiry) user.accountExpiry = String(args.account_expiry);
    // POST /users ignores dryRun — /metadata VALIDATE is the true dry run.
    const result = await postMetadataPayload({ users: [user] }, args.dry_run === true);
    if (!result.success) return { _error: result._error || 'User creation failed.', errors: result.errors, phase: result.phase };
    if (args.dry_run === true) return { success: true, dry_run: true, message: 'Validation passed — no user created (dry_run).' };
    // Group membership is owned by the group: make sure it actually landed.
    const groupNotes = [];
    for (const g of (refs.groups || [])) {
      const chk = await safeDhis2Fetch(`userGroups/${g.id}?fields=users[id]`);
      if (!(chk?.users || []).some(x => x.id === id)) {
        const add = await safeDhis2Fetch(`userGroups/${g.id}/users/${id}`, { method: 'POST', allowEmptyBody: true });
        groupNotes.push(add?._error ? `could not add to group ${g.name}: ${add._error}` : `added to group ${g.name}`);
      }
    }
    recordRecentCreation('user', username, id);
    const warnings = [];
    if (!(refs.org_units || []).length) warnings.push('No capture org units assigned — the user cannot enter or see any data until org_units are set.');
    if ((refs.org_units || []).length && !(refs.data_view_org_units || []).length) warnings.push('No data-view org units set — analytics apps default to the capture org units.');
    return {
      success: true, action: 'create', user_id: id, username,
      name: `${firstName} ${surname}`,
      roles: refs.roles.map(r => r.name), groups: (refs.groups || []).map(g => g.name),
      capture_org_units: (refs.org_units || []).map(o => o.name),
      ...(generated ? { initial_password: password, _password_note: 'Generated password — shown ONCE. Give it to the user over a secure channel and ask them to change it at first login.' } : {}),
      ...(groupNotes.length ? { group_membership: groupNotes } : {}),
      ...(warnings.length ? { warnings } : {}),
      message: `Created user "${username}" (${id}).`,
    };
  }

  // ── update / disable / enable ──
  if (action === 'update' || action === 'disable' || action === 'enable') {
    const f = await findUser(args.user_id || args.username);
    if (f._error) return f;
    const gate = requireWriteAuth('manage_users', action, { user_id: f.id, username: f.username });
    if (gate) return gate;
    const ops = [];
    const applied = {};
    if (action === 'disable' || action === 'enable') {
      ops.push({ op: 'replace', path: '/disabled', value: action === 'disable' });
      applied.disabled = action === 'disable';
    } else {
      const simple = [['first_name', 'firstName'], ['surname', 'surname'], ['email', 'email'], ['phone_number', 'phoneNumber'], ['account_expiry', 'accountExpiry']];
      for (const [k, field] of simple) if (args[k] !== undefined) { ops.push({ op: 'replace', path: `/${field}`, value: args[k] }); applied[k] = args[k]; }
      if (args.disabled === true || args.disabled === false) { ops.push({ op: 'replace', path: '/disabled', value: args.disabled }); applied.disabled = args.disabled; }
      if (args.password) {
        const pwProblems = checkPassword(args.password, await getPasswordPolicy());
        if (pwProblems.length) return { _error: `New password does not meet the DHIS2 password policy: ${pwProblems.join(', ')}.` };
        ops.push({ op: 'replace', path: '/password', value: args.password });
        applied.password = '(changed)';
      }
    }
    const rr = action === 'update'
      ? await resolveUserRefs(args, ['roles', 'add_roles', 'remove_roles', 'org_units', 'add_org_units', 'remove_org_units', 'data_view_org_units', 'search_org_units', 'add_groups', 'remove_groups'])
      : { refs: {} };
    if (rr._error) return rr;
    const { refs } = rr;
    const needsCurrent = ['add_roles', 'remove_roles', 'add_org_units', 'remove_org_units'].some(k => refs[k]);
    let cur = null;
    if (needsCurrent) {
      cur = await safeDhis2Fetch(`users/${f.id}?fields=userRoles[id],organisationUnits[id]`);
      if (cur?._error) return { _error: `Could not load user ${f.id}: ${cur._error}` };
    }
    const mergeSet = (base, add, remove) => {
      const ids = new Set((base || []).map(x => x.id));
      for (const a of (add || [])) ids.add(a.id);
      for (const r of (remove || [])) ids.delete(r.id);
      return [...ids].map(id => ({ id }));
    };
    if (refs.roles || refs.add_roles || refs.remove_roles) {
      const roles = refs.roles ? refs.roles.map(r => ({ id: r.id })) : mergeSet(cur.userRoles, refs.add_roles, refs.remove_roles);
      if (!roles.length) return { _error: 'Refusing to leave the user with NO role (DHIS2 rejects it, E4055).', _hint: 'Keep at least one role, or disable the user instead.' };
      ops.push({ op: 'replace', path: '/userRoles', value: roles });
      applied.roles = refs.roles ? refs.roles.map(r => r.name) : { added: (refs.add_roles || []).map(r => r.name), removed: (refs.remove_roles || []).map(r => r.name) };
    }
    if (refs.org_units || refs.add_org_units || refs.remove_org_units) {
      const ous = refs.org_units ? refs.org_units.map(o => ({ id: o.id })) : mergeSet(cur.organisationUnits, refs.add_org_units, refs.remove_org_units);
      ops.push({ op: 'replace', path: '/organisationUnits', value: ous });
      applied.capture_org_units = refs.org_units ? refs.org_units.map(o => o.name) : { added: (refs.add_org_units || []).map(o => o.name), removed: (refs.remove_org_units || []).map(o => o.name) };
    }
    if (refs.data_view_org_units) { ops.push({ op: 'replace', path: '/dataViewOrganisationUnits', value: refs.data_view_org_units.map(o => ({ id: o.id })) }); applied.data_view_org_units = refs.data_view_org_units.map(o => o.name); }
    if (refs.search_org_units) { ops.push({ op: 'replace', path: '/teiSearchOrganisationUnits', value: refs.search_org_units.map(o => ({ id: o.id })) }); applied.search_org_units = refs.search_org_units.map(o => o.name); }
    const groupOps = [...(refs.add_groups || []).map(g => ({ g, method: 'POST' })), ...(refs.remove_groups || []).map(g => ({ g, method: 'DELETE' }))];
    if (!ops.length && !groupOps.length) {
      return { _error: 'Nothing to update.', _hint: 'Pass any of: first_name, surname, email, phone_number, disabled, password, roles / add_roles / remove_roles, org_units / add_org_units / remove_org_units, data_view_org_units, search_org_units, add_groups / remove_groups.' };
    }
    const backup = await ensureBackupOrBail(
      { operation: `user_${action}`, tool: 'manage_users', action, reason: `${action} user ${f.username}` },
      [{ object_type: 'users', object_id: f.id, role: 'primary' }, ...groupOps.map(x => ({ object_type: 'userGroups', object_id: x.g.id, role: 'related' }))],
      args
    );
    if (!backup.ok) return backup.error;
    if (ops.length) {
      const resp = await safeDhis2Fetch(`users/${f.id}`, { method: 'PATCH', body: ops });
      if (resp?._error) return { _error: `Updating user ${f.username} failed: ${resp._error}`, error_details: resp.error_details, backup: backup.block };
    }
    const groupResults = [];
    for (const { g, method } of groupOps) {
      const r = await safeDhis2Fetch(`userGroups/${g.id}/users/${f.id}`, { method, allowEmptyBody: true });
      groupResults.push({ group: g.name, change: method === 'POST' ? 'added' : 'removed', ok: !r?._error, ...(r?._error ? { error: r._error } : {}) });
    }
    if (groupResults.length) applied.groups = groupResults;
    return { success: groupResults.every(g => g.ok), action, user_id: f.id, username: f.username, applied, backup: backup.block };
  }

  // ── delete ──
  if (action === 'delete') {
    const f = await findUser(args.user_id || args.username);
    if (f._error) return f;
    const gate = requireWriteAuth('manage_users', 'delete', { user_id: f.id, username: f.username });
    if (gate) return gate;
    const me = await safeDhis2Fetch('me?fields=id');
    if (me?.id === f.id) return { _error: 'Refusing to delete the account you are signed in with.' };
    const backup = await ensureBackupOrBail(
      { operation: 'user_delete', tool: 'manage_users', action: 'delete', reason: `Delete user ${f.username}` },
      [{ object_type: 'users', object_id: f.id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;
    const resp = await safeDhis2Fetch(`users/${f.id}`, { method: 'DELETE' });
    if (resp?._error) return { _error: `Deleting user ${f.username} failed: ${resp._error}`, _hint: 'Users referenced by stored data/audits may be undeletable — disable the account instead (action="disable").', backup: backup.block };
    return { success: true, action: 'delete', deleted: { id: f.id, username: f.username }, _note: 'A restored user comes back WITHOUT a password (DHIS2 never exports it) — prefer action="disable" when the account may be needed again.', backup: backup.block };
  }

  // ── list_authorities ──
  if (action === 'list_authorities') {
    const catalog = await getAuthorityCatalog();
    if (!catalog) return { _error: 'Could not load the authority catalogue (GET /api/authorities).' };
    const q = _lc(args.query);
    const rows = q ? catalog.filter(a => _lc(a.id).includes(q) || _lc(a.name).includes(q)) : catalog;
    return { success: true, total: rows.length, authorities: rows.slice(0, Number(args.limit) || 60), ...(rows.length > (Number(args.limit) || 60) ? { _note: 'Truncated — narrow with query.' } : {}) };
  }

  // ── roles ──
  if (action === 'list_roles') {
    const q = args.query ? `&filter=displayName:ilike:${_filterValue(args.query)}` : '';
    const resp = await safeDhis2Fetch(`userRoles?fields=id,displayName,description,authorities~size,users~size&paging=false${q}&order=displayName:asc`);
    if (resp?._error) return { _error: `userRoles list failed: ${resp._error}` };
    return { success: true, total: (resp.userRoles || []).length, roles: (resp.userRoles || []).map(r => ({ id: r.id, name: r.displayName, description: r.description || null, authority_count: r.authorities ?? 0, user_count: r.users ?? 0 })) };
  }
  const resolveRole = async () => {
    const v = args.role_id || args.role || args.role_name;
    if (!v) return { _error: 'role_id (or role name) is required.' };
    const r = await resolveIdsOrNames('userRoles', [v]);
    const err = _resolutionError('user role', r);
    return err || { id: r.items[0].id, name: r.items[0].name };
  };
  if (action === 'get_role') {
    const role = await resolveRole();
    if (role._error) return role;
    const r = await safeDhis2Fetch(`userRoles/${role.id}?fields=id,displayName,description,authorities,users~size`);
    if (r?._error) return { _error: `Could not load role: ${r._error}` };
    const catalog = await getAuthorityCatalog() || [];
    const names = new Map(catalog.map(a => [a.id, a.name]));
    const auths = (r.authorities || []).sort();
    const unknown = auths.filter(a => catalog.length && !names.has(a));
    return {
      success: true, role: { id: r.id, name: r.displayName, description: r.description || null, user_count: r.users ?? 0 },
      authorities: auths.map(a => ({ id: a, name: names.get(a) || null })),
      ...(unknown.length ? { _warning: `This role carries ${unknown.length} authority string(s) DHIS2 does not recognise (they grant nothing): ${unknown.join(', ')}. Offer to remove them with update_role(remove_authorities).` } : {}),
    };
  }
  if (action === 'create_role') {
    const gate = requireWriteAuth('manage_users', 'create_role', { name: args.name });
    if (gate) return gate;
    const name = String(args.name || args.role_name || '').trim();
    if (!name) return { _error: 'name is required for create_role.' };
    const dup = await safeDhis2Fetch(`userRoles?filter=name:eq:${_filterValue(name)}&fields=id&paging=false`);
    if (dup?.userRoles?.length) return { _error: `A user role named "${name}" already exists (${dup.userRoles[0].id}).`, existing_role_id: dup.userRoles[0].id, _hint: 'Use update_role to change it instead.' };
    const ra = await resolveAuthorities(args.authorities || []);
    if (ra._error) return ra;
    if (!ra.authorities.length) return { _error: 'A role needs at least one authority.', _hint: 'Find them with manage_users(action="list_authorities", query="…").' };
    const id = generateDhis2Uid();
    const role = { id, name, authorities: ra.authorities.map(a => a.id) };
    if (args.description) role.description = String(args.description);
    const result = await postMetadataPayload({ userRoles: [role] }, args.dry_run === true);
    if (!result.success) return { _error: result._error || 'Role creation failed.', errors: result.errors };
    if (args.dry_run === true) return { success: true, dry_run: true };
    recordRecentCreation('userRole', name, id);
    return { success: true, action: 'create_role', role_id: id, name, authorities: ra.authorities };
  }
  if (action === 'update_role') {
    const role = await resolveRole();
    if (role._error) return role;
    const gate = requireWriteAuth('manage_users', 'update_role', { role_id: role.id });
    if (gate) return gate;
    const cur = await safeDhis2Fetch(`userRoles/${role.id}?fields=authorities`);
    if (cur?._error) return { _error: `Could not load role: ${cur._error}` };
    const set = new Set(cur.authorities || []);
    const applied = {};
    if (args.authorities) {
      const ra = await resolveAuthorities(args.authorities); if (ra._error) return ra;
      set.clear(); for (const a of ra.authorities) set.add(a.id);
      applied.authorities = ra.authorities.map(a => a.id);
    }
    if (args.add_authorities) {
      const ra = await resolveAuthorities(args.add_authorities); if (ra._error) return ra;
      for (const a of ra.authorities) set.add(a.id);
      applied.added = ra.authorities.map(a => a.id);
    }
    if (args.remove_authorities) {
      // Removal accepts raw strings too — that is how garbage authorities get cleaned out.
      const removed = [];
      for (const raw of args.remove_authorities) {
        const s = String(raw).trim();
        const hit = [...set].find(x => x === s || _lc(x) === _lc(s));
        if (hit) { set.delete(hit); removed.push(hit); continue; }
        const ra = await resolveAuthorities([s]);
        if (!ra._error && set.has(ra.authorities[0].id)) { set.delete(ra.authorities[0].id); removed.push(ra.authorities[0].id); }
      }
      applied.removed = removed;
    }
    const ops = [];
    if (applied.authorities || applied.added || applied.removed) {
      if (!set.size) return { _error: 'Refusing to leave the role with NO authorities.', _hint: 'Delete the role instead if it is no longer needed.' };
      ops.push({ op: 'replace', path: '/authorities', value: [...set] });
    }
    if (args.name) { ops.push({ op: 'replace', path: '/name', value: String(args.name) }); applied.name = args.name; }
    if (args.description !== undefined) { ops.push({ op: 'replace', path: '/description', value: String(args.description) }); applied.description = args.description; }
    if (!ops.length) return { _error: 'Nothing to update.', _hint: 'Pass authorities (replace), add_authorities, remove_authorities, name or description.' };
    const backup = await ensureBackupOrBail(
      { operation: 'role_update', tool: 'manage_users', action: 'update_role', reason: `Update role ${role.name}` },
      [{ object_type: 'userRoles', object_id: role.id, role: 'primary' }], args);
    if (!backup.ok) return backup.error;
    const resp = await safeDhis2Fetch(`userRoles/${role.id}`, { method: 'PATCH', body: ops });
    if (resp?._error) return { _error: `Updating role failed: ${resp._error}`, backup: backup.block };
    return { success: true, action: 'update_role', role_id: role.id, name: role.name, applied, authority_count: set.size, backup: backup.block };
  }
  if (action === 'delete_role') {
    const role = await resolveRole();
    if (role._error) return role;
    const gate = requireWriteAuth('manage_users', 'delete_role', { role_id: role.id });
    if (gate) return gate;
    const r = await safeDhis2Fetch(`userRoles/${role.id}?fields=users[id,username]`);
    if ((r?.users || []).length) return { _error: `Role "${role.name}" is still assigned to ${r.users.length} user(s): ${r.users.slice(0, 10).map(u => u.username).join(', ')}.`, _hint: 'Remove the role from those users first (update with remove_roles), then delete it.' };
    const backup = await ensureBackupOrBail({ operation: 'role_delete', tool: 'manage_users', action: 'delete_role', reason: `Delete role ${role.name}` }, [{ object_type: 'userRoles', object_id: role.id, role: 'primary' }], args);
    if (!backup.ok) return backup.error;
    const resp = await safeDhis2Fetch(`userRoles/${role.id}`, { method: 'DELETE' });
    if (resp?._error) return { _error: `Deleting role failed: ${resp._error}`, backup: backup.block };
    return { success: true, action: 'delete_role', deleted: role, backup: backup.block };
  }

  // ── groups ──
  if (action === 'list_groups') {
    const q = args.query ? `&filter=displayName:ilike:${_filterValue(args.query)}` : '';
    const resp = await safeDhis2Fetch(`userGroups?fields=id,displayName,code,users~size&paging=false${q}&order=displayName:asc`);
    if (resp?._error) return { _error: `userGroups list failed: ${resp._error}` };
    return { success: true, total: (resp.userGroups || []).length, groups: (resp.userGroups || []).map(g => ({ id: g.id, name: g.displayName, code: g.code || null, member_count: g.users ?? 0 })) };
  }
  const resolveGroup = async () => {
    const v = args.group_id || args.group || args.group_name;
    if (!v) return { _error: 'group_id (or group name) is required.' };
    const r = await resolveIdsOrNames('userGroups', [v]);
    const err = _resolutionError('user group', r);
    return err || { id: r.items[0].id, name: r.items[0].name };
  };
  const resolveMembers = async (list) => {
    const out = [], bad = [];
    for (const m of (list || [])) {
      const f = await findUser(m && typeof m === 'object' ? (m.id || m.username) : m);
      if (f._error) bad.push(String(m)); else out.push(f);
    }
    return bad.length ? { _error: `Unknown user(s): ${bad.join(', ')}.`, _hint: 'Pass user UIDs or exact usernames (manage_users(action="list", query=…)).' } : { users: out };
  };
  if (action === 'create_group') {
    const gate = requireWriteAuth('manage_users', 'create_group', { name: args.name });
    if (gate) return gate;
    const name = String(args.name || args.group_name || '').trim();
    if (!name) return { _error: 'name is required for create_group.' };
    const dup = await safeDhis2Fetch(`userGroups?filter=name:eq:${_filterValue(name)}&fields=id&paging=false`);
    if (dup?.userGroups?.length) return { _error: `A user group named "${name}" already exists (${dup.userGroups[0].id}).`, existing_group_id: dup.userGroups[0].id, _hint: 'Add members to it with update_group(add_members).' };
    const mem = await resolveMembers(args.members || args.add_members);
    if (mem._error) return mem;
    const id = generateDhis2Uid();
    const group = { id, name, users: mem.users.map(u => ({ id: u.id })) };
    if (args.code) group.code = String(args.code);
    const result = await postMetadataPayload({ userGroups: [group] }, args.dry_run === true);
    if (!result.success) return { _error: result._error || 'Group creation failed.', errors: result.errors };
    if (args.dry_run === true) return { success: true, dry_run: true };
    recordRecentCreation('userGroup', name, id);
    return { success: true, action: 'create_group', group_id: id, name, members: mem.users.map(u => u.username) };
  }
  if (action === 'update_group') {
    const g = await resolveGroup();
    if (g._error) return g;
    const gate = requireWriteAuth('manage_users', 'update_group', { group_id: g.id });
    if (gate) return gate;
    const add = await resolveMembers(args.add_members); if (add._error) return add;
    const rem = await resolveMembers(args.remove_members); if (rem._error) return rem;
    if (!add.users.length && !rem.users.length && !args.name) return { _error: 'Nothing to update.', _hint: 'Pass add_members, remove_members and/or name.' };
    const backup = await ensureBackupOrBail({ operation: 'group_update', tool: 'manage_users', action: 'update_group', reason: `Update group ${g.name}` }, [{ object_type: 'userGroups', object_id: g.id, role: 'primary' }], args);
    if (!backup.ok) return backup.error;
    const results = [];
    for (const u of add.users) { const r = await safeDhis2Fetch(`userGroups/${g.id}/users/${u.id}`, { method: 'POST', allowEmptyBody: true }); results.push({ user: u.username, change: 'added', ok: !r?._error, ...(r?._error ? { error: r._error } : {}) }); }
    for (const u of rem.users) { const r = await safeDhis2Fetch(`userGroups/${g.id}/users/${u.id}`, { method: 'DELETE', allowEmptyBody: true }); results.push({ user: u.username, change: 'removed', ok: !r?._error, ...(r?._error ? { error: r._error } : {}) }); }
    if (args.name) {
      const r = await safeDhis2Fetch(`userGroups/${g.id}`, { method: 'PATCH', body: [{ op: 'replace', path: '/name', value: String(args.name) }] });
      results.push({ rename: args.name, ok: !r?._error, ...(r?._error ? { error: r._error } : {}) });
    }
    return { success: results.every(r => r.ok), action: 'update_group', group_id: g.id, name: g.name, changes: results, backup: backup.block };
  }
  if (action === 'delete_group') {
    const g = await resolveGroup();
    if (g._error) return g;
    const gate = requireWriteAuth('manage_users', 'delete_group', { group_id: g.id });
    if (gate) return gate;
    const backup = await ensureBackupOrBail({ operation: 'group_delete', tool: 'manage_users', action: 'delete_group', reason: `Delete group ${g.name}` }, [{ object_type: 'userGroups', object_id: g.id, role: 'primary' }], args);
    if (!backup.ok) return backup.error;
    const resp = await safeDhis2Fetch(`userGroups/${g.id}`, { method: 'DELETE' });
    if (resp?._error) return { _error: `Deleting group failed: ${resp._error}`, _hint: 'A group used in sharing settings may be blocked from deletion — remove it from those objects\' sharing first (manage_metadata(action=update_sharing)).', backup: backup.block };
    return { success: true, action: 'delete_group', deleted: g, backup: backup.block };
  }

  return { _error: `Unknown action "${action}" for manage_users.`, _hint: `One of: ${ACTIONS}.` };
}

// ════════════════════════════════════════════════════════════════════════════
// manage_data_values — aggregate data entry (read / write / delete / complete /
// validate) for ONE dataset × period × org unit form
// ════════════════════════════════════════════════════════════════════════════

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PERIOD_PATTERNS = {
  Daily: /^\d{8}$/, Weekly: /^\d{4}W\d{1,2}$/, WeeklyWednesday: /^\d{4}WedW\d{1,2}$/,
  WeeklyThursday: /^\d{4}ThuW\d{1,2}$/, WeeklySaturday: /^\d{4}SatW\d{1,2}$/, WeeklySunday: /^\d{4}SunW\d{1,2}$/,
  BiWeekly: /^\d{4}BiW\d{1,2}$/, Monthly: /^\d{6}$/, BiMonthly: /^\d{6}B$/, Quarterly: /^\d{4}Q[1-4]$/,
  QuarterlyNov: /^\d{4}NovQ[1-4]$/, SixMonthly: /^\d{4}S[12]$/, SixMonthlyApril: /^\d{4}AprilS[12]$/,
  SixMonthlyNov: /^\d{4}NovS[12]$/, Yearly: /^\d{4}$/, FinancialApril: /^\d{4}April$/,
  FinancialJuly: /^\d{4}July$/, FinancialOct: /^\d{4}Oct$/, FinancialNov: /^\d{4}Nov$/, FinancialSep: /^\d{4}Sep$/,
};
const PERIOD_EXAMPLES = {
  Daily: '20260115', Weekly: '2026W3', Monthly: '202601', BiMonthly: '202601B', Quarterly: '2026Q1',
  SixMonthly: '2026S1', Yearly: '2026', FinancialApril: '2026April', FinancialJuly: '2026July', FinancialOct: '2026Oct',
};

// Turn friendly inputs into the DHIS2 period id for the dataset's period type:
// "January 2026" / "Jan 2026" / "2026-01" → 202601, "Q1 2026" / "2026-Q1" →
// 2026Q1, "2026-01-15" → 20260115 (Daily). Returns the input unchanged when it
// cannot be interpreted (the format check then reports it).
function normalizePeriodInput(periodType, raw) {
  let s = String(raw ?? '').trim();
  if (!s) return s;
  if (PERIOD_PATTERNS[periodType]?.test(s)) return s;
  const lc = s.toLowerCase();
  if (periodType === 'Monthly') {
    let m = lc.match(/^(\d{4})[-/.](\d{1,2})$/);
    if (m) return `${m[1]}${m[2].padStart(2, '0')}`;
    m = lc.match(/^([a-z]+)\.?[\s,-]+(\d{4})$/) || lc.match(/^(\d{4})[\s,-]+([a-z]+)$/);
    if (m) {
      const [y, name] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
      const idx = MONTHS.indexOf(name.slice(0, 3));
      if (idx >= 0) return `${y}${String(idx + 1).padStart(2, '0')}`;
    }
  }
  if (periodType === 'Quarterly') {
    const m = lc.match(/^q([1-4])[\s,-]*(\d{4})$/) || lc.match(/^(\d{4})[\s,-]*q([1-4])$/);
    if (m) return /^\d{4}$/.test(m[1]) ? `${m[1]}Q${m[2]}` : `${m[2]}Q${m[1]}`;
  }
  if (periodType === 'Daily') {
    const m = lc.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[1]}${m[2]}${m[3]}`;
  }
  if (periodType === 'Weekly') {
    const m = lc.match(/^(\d{4})[\s-]*w(?:eek)?\s*(\d{1,2})$/);
    if (m) return `${m[1]}W${Number(m[2])}`;
  }
  if (periodType === 'Yearly') {
    const m = lc.match(/^(?:year\s*)?(\d{4})$/);
    if (m) return m[1];
  }
  return s;
}

// Index of a period relative to an absolute origin, for the period types whose
// arithmetic is simple. null = unsupported (the server's strictPeriods check
// still backstops it).
function periodOrdinal(periodType, pe) {
  let m;
  switch (periodType) {
    case 'Monthly': m = pe.match(/^(\d{4})(\d{2})$/); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
    case 'BiMonthly': m = pe.match(/^(\d{4})(\d{2})B$/); return m ? Number(m[1]) * 6 + Number(m[2]) - 1 : null;
    case 'Quarterly': m = pe.match(/^(\d{4})Q([1-4])$/); return m ? Number(m[1]) * 4 + Number(m[2]) - 1 : null;
    case 'SixMonthly': m = pe.match(/^(\d{4})S([12])$/); return m ? Number(m[1]) * 2 + Number(m[2]) - 1 : null;
    case 'Yearly': m = pe.match(/^(\d{4})$/); return m ? Number(m[1]) : null;
    case 'Daily': m = pe.match(/^(\d{4})(\d{2})(\d{2})$/); return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : null;
    default: return null;
  }
}
function currentPeriodId(periodType, now = new Date()) {
  const y = now.getUTCFullYear(), mo = now.getUTCMonth();
  switch (periodType) {
    case 'Monthly': return `${y}${String(mo + 1).padStart(2, '0')}`;
    case 'BiMonthly': return `${y}${String(Math.floor(mo / 2) + 1).padStart(2, '0')}B`;
    case 'Quarterly': return `${y}Q${Math.floor(mo / 3) + 1}`;
    case 'SixMonthly': return `${y}S${mo < 6 ? 1 : 2}`;
    case 'Yearly': return `${y}`;
    case 'Daily': return `${y}${String(mo + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    default: return null;
  }
}

// Coerce + validate one value against its data element's value type / option
// set. Returns { value } or { problem }.
function coerceDataValue(de, raw) {
  if (raw === null || raw === undefined) return { problem: 'no value given (use action="delete" to clear a cell)' };
  let v = typeof raw === 'string' ? raw.trim() : raw;
  const vt = de.valueType || 'TEXT';
  if (de.optionSet && Array.isArray(de.optionSet.options) && de.optionSet.options.length) {
    const s = String(v);
    const byCode = de.optionSet.options.find(o => o.code === s) || de.optionSet.options.find(o => _lc(o.code) === _lc(s));
    const byName = de.optionSet.options.find(o => _lc(o.displayName || o.name) === _lc(s));
    const hit = byCode || byName;
    if (!hit) return { problem: `"${s}" is not an option of this data element (valid codes: ${de.optionSet.options.slice(0, 15).map(o => o.code).join(', ')}${de.optionSet.options.length > 15 ? ', …' : ''})` };
    return { value: hit.code };
  }
  const num = Number(typeof v === 'string' ? v.replace(/,/g, '') : v);
  const isNum = typeof v === 'number' || (String(v) !== '' && Number.isFinite(num));
  switch (vt) {
    case 'INTEGER': if (!isNum || !Number.isInteger(num)) return { problem: 'must be a whole number' }; return { value: String(num) };
    case 'INTEGER_POSITIVE': if (!isNum || !Number.isInteger(num) || num <= 0) return { problem: 'must be a positive whole number (> 0)' }; return { value: String(num) };
    case 'INTEGER_NEGATIVE': if (!isNum || !Number.isInteger(num) || num >= 0) return { problem: 'must be a negative whole number (< 0)' }; return { value: String(num) };
    case 'INTEGER_ZERO_OR_POSITIVE': if (!isNum || !Number.isInteger(num) || num < 0) return { problem: 'must be a whole number ≥ 0' }; return { value: String(num) };
    case 'NUMBER': if (!isNum) return { problem: 'must be a number' }; return { value: String(num) };
    case 'PERCENTAGE': if (!isNum || num < 0 || num > 100) return { problem: 'must be a percentage between 0 and 100' }; return { value: String(num) };
    case 'UNIT_INTERVAL': if (!isNum || num < 0 || num > 1) return { problem: 'must be between 0 and 1' }; return { value: String(num) };
    case 'BOOLEAN': {
      const s = _lc(v);
      if (['true', 'yes', 'y', '1'].includes(s) || v === true) return { value: 'true' };
      if (['false', 'no', 'n', '0'].includes(s) || v === false) return { value: 'false' };
      return { problem: 'must be yes/no (true/false)' };
    }
    case 'TRUE_ONLY': {
      const s = _lc(v);
      if (['true', 'yes', 'y', '1'].includes(s) || v === true) return { value: 'true' };
      return { problem: 'TRUE_ONLY accepts only "true" (delete the value to clear it)' };
    }
    case 'DATE': case 'AGE': if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return { problem: 'must be a date YYYY-MM-DD' }; return { value: String(v) };
    case 'DATETIME': if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(String(v))) return { problem: 'must be a date-time YYYY-MM-DDTHH:mm' }; return { value: String(v).replace(' ', 'T') };
    case 'LETTER': if (String(v).length !== 1) return { problem: 'must be a single letter' }; return { value: String(v) };
    case 'EMAIL': if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) return { problem: 'must be an e-mail address' }; return { value: String(v) };
    case 'TEXT': if (String(v).length > 50000) return { problem: 'text too long' }; return { value: String(v) };
    default: return { value: String(v) };
  }
}

async function getDefaultCoc() {
  _adminCacheSync();
  if (_adminCache.defaultCoc) return _adminCache.defaultCoc;
  const r = await safeDhis2Fetch('categoryCombos?filter=name:eq:default&fields=id,categoryOptionCombos[id]&paging=false');
  const coc = r?.categoryCombos?.[0]?.categoryOptionCombos?.[0]?.id || null;
  _adminCache.defaultCoc = coc;
  return coc;
}

const DV_DATASET_FIELDS = 'id,displayName,periodType,openFuturePeriods,expiryDays,'
  + 'categoryCombo[id,displayName,categoryOptionCombos[id,displayName,categoryOptions[displayName]]],'
  + 'dataSetElements[categoryCombo[id,displayName,categoryOptionCombos[id,displayName,categoryOptions[displayName]]],'
  + 'dataElement[id,displayName,displayFormName,shortName,code,valueType,optionSet[options[code,displayName]],'
  + 'categoryCombo[id,displayName,categoryOptionCombos[id,displayName,categoryOptions[displayName]]]]]';

// Resolve the addressing triple (dataset, period, org unit) + load the form
// structure. Returns { ds, des:Map, period, ou, aoc } or { _error }.
async function resolveDataValueForm(args, { needAssignedOu = true } = {}) {
  const dsInput = args.dataset_id || args.dataset || args.data_set;
  if (!dsInput) return { _error: 'dataset_id (or dataset name) is required.', _hint: 'Find it with manage_datasets(action="list") or search_metadata(object_type="dataSets").' };
  const dsRes = await resolveIdsOrNames('dataSets', [dsInput]);
  const dsErr = _resolutionError('dataset', dsRes);
  if (dsErr) return dsErr;
  const ds = await safeDhis2Fetch(`dataSets/${dsRes.items[0].id}?fields=${DV_DATASET_FIELDS}`, { noTruncate: true });
  if (!ds || ds._error) return { _error: `Could not load dataset: ${ds?._error}` };

  const rawPe = args.period;
  if (!rawPe) return { _error: 'period is required.', _hint: `This dataset is ${ds.periodType}; e.g. period="${PERIOD_EXAMPLES[ds.periodType] || '…'}".` };
  const period = normalizePeriodInput(ds.periodType, rawPe);
  const pat = PERIOD_PATTERNS[ds.periodType];
  if (pat && !pat.test(period)) {
    return { _error: `Period "${rawPe}" is not a ${ds.periodType} period. Dataset "${ds.displayName}" only accepts ${ds.periodType} periods.`, _hint: `Use the DHIS2 ${ds.periodType} format, e.g. "${PERIOD_EXAMPLES[ds.periodType] || 'see DHIS2 docs'}". A value stored under another period type is invisible in Data Entry.` };
  }

  const ouInput = args.org_unit_id || args.org_unit || args.orgUnit;
  if (!ouInput) return { _error: 'org_unit_id (or org unit name) is required.' };
  const ouRes = await resolveIdsOrNames('organisationUnits', [ouInput], { extraFields: 'level' });
  const ouErr = _resolutionError('org unit', ouRes);
  if (ouErr) return ouErr;
  const ou = { id: ouRes.items[0].id, name: ouRes.items[0].name };
  if (needAssignedOu) {
    const assigned = await safeDhis2Fetch(`dataSets?filter=id:eq:${ds.id}&filter=organisationUnits.id:eq:${ou.id}&fields=id&paging=false`);
    if (!assigned?._error && !(assigned?.dataSets || []).length) {
      return { _error: `Dataset "${ds.displayName}" is not assigned to org unit "${ou.name}". DHIS2 would silently store the values where no Data Entry form can ever show them.`, _hint: `Assign the org unit first (manage_datasets(action="assign_org_units", dataset_id="${ds.id}", org_unit_ids=["${ou.id}"], merge_mode="add")) — or pick an org unit the dataset IS assigned to.` };
    }
  }

  // Attribute option combo (dataset-level categoryCombo).
  const dsCocs = ds.categoryCombo?.categoryOptionCombos || [];
  let aoc = null;
  const isDefaultCombo = _lc(ds.categoryCombo?.displayName) === 'default' || dsCocs.length <= 1;
  if (isDefaultCombo) {
    aoc = dsCocs[0]?.id || await getDefaultCoc();
  } else {
    const want = args.attribute_option_combo;
    if (!want) {
      return { _error: `Dataset "${ds.displayName}" has an attribute category combo ("${ds.categoryCombo.displayName}") — attribute_option_combo is required.`, valid_attribute_option_combos: dsCocs.map(c => c.displayName), _hint: 'Pass attribute_option_combo as one of the names above (or its UID).' };
    }
    const hit = matchCoc(dsCocs, want);
    if (!hit) return { _error: `"${Array.isArray(want) ? want.join(', ') : want}" is not an attribute option combo of "${ds.categoryCombo.displayName}".`, valid_attribute_option_combos: dsCocs.map(c => c.displayName) };
    aoc = hit.id;
  }

  const des = new Map();
  for (const dse of (ds.dataSetElements || [])) {
    const de = dse.dataElement;
    if (!de?.id) continue;
    const cc = dse.categoryCombo || de.categoryCombo;
    des.set(de.id, { ...de, effectiveCombo: cc });
  }
  return { ds, des, period, ou, aoc, isDefaultCombo };
}

// Match a categoryOptionCombo by UID, exact name, or by its set of option
// names ("Male, <5" ≡ "<5, Male" ≡ ["<5","Male"]).
function matchCoc(cocs, want) {
  if (want == null) return null;
  if (typeof want === 'string' && /^[A-Za-z][A-Za-z0-9]{10}$/.test(want.trim())) {
    const byId = cocs.find(c => c.id === want.trim());
    if (byId) return byId;
  }
  const wantStr = Array.isArray(want) ? want.join(', ') : String(want);
  const exact = cocs.find(c => _lc(c.displayName) === _lc(wantStr));
  if (exact) return exact;
  // Split on separators that never occur inside an option name ("5+" keeps its +).
  const parts = (Array.isArray(want) ? want : wantStr.split(/\s*[,/&|]\s*|\s+and\s+/i)).map(_soft).filter(Boolean).sort().join('|');
  const bySet = cocs.filter(c => {
    const opts = (c.categoryOptions || []).map(o => _soft(o.displayName)).sort().join('|');
    return opts === parts || _soft(c.displayName) === _soft(wantStr);
  });
  return bySet.length === 1 ? bySet[0] : null;
}

function resolveFormDataElement(des, input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (des.has(s)) return des.get(s);
  const all = [...des.values()];
  const exact = all.filter(d => [d.displayName, d.displayFormName, d.shortName, d.code].some(n => n && _lc(n) === _lc(s)));
  if (exact.length === 1) return exact[0];
  const sq = _soft(s);
  const loose = all.filter(d => [d.displayName, d.displayFormName, d.shortName].some(n => n && (_soft(n) === sq)));
  if (loose.length === 1) return loose[0];
  const contains = all.filter(d => [d.displayName, d.displayFormName].some(n => n && _soft(n).includes(sq) && sq.length >= 4));
  return contains.length === 1 ? contains[0] : null;
}

// Build validated dataValues for set/delete. Returns { rows, problems }.
function buildFormValues(form, inputs, { forDelete = false } = {}) {
  const rows = [], problems = [];
  (inputs || []).forEach((v, i) => {
    const deIn = v?.data_element ?? v?.data_element_id ?? v?.dataElement ?? v?.data_element_name;
    const de = resolveFormDataElement(form.des, deIn);
    if (!de) {
      problems.push({ index: i, data_element: deIn, problem: `not a data element of dataset "${form.ds.displayName}"`, did_you_mean: _closest(String(deIn || ''), [...form.des.values()].map(d => d.displayName), 4) });
      return;
    }
    const cocs = de.effectiveCombo?.categoryOptionCombos || [];
    const isDefault = _lc(de.effectiveCombo?.displayName) === 'default' || cocs.length <= 1;
    const cocIn = v?.category_option_combo ?? v?.categoryOptionCombo ?? v?.disaggregation ?? v?.coc;
    let coc;
    if (isDefault) {
      coc = cocs[0]?.id || null;
    } else {
      if (cocIn == null || cocIn === '') {
        problems.push({ index: i, data_element: de.displayName, problem: `is disaggregated by "${de.effectiveCombo.displayName}" — category_option_combo is required (DHIS2 would otherwise file the value under "default", invisible in the form)`, valid_category_option_combos: cocs.map(c => c.displayName) });
        return;
      }
      const hit = matchCoc(cocs, cocIn);
      if (!hit) {
        problems.push({ index: i, data_element: de.displayName, problem: `"${Array.isArray(cocIn) ? cocIn.join(', ') : cocIn}" is not a disaggregation of "${de.effectiveCombo.displayName}"`, valid_category_option_combos: cocs.map(c => c.displayName) });
        return;
      }
      coc = hit.id;
    }
    const row = { dataElement: de.id, categoryOptionCombo: coc, _de: de.displayName, _coc: isDefault ? null : (cocs.find(c => c.id === coc)?.displayName || null) };
    if (!forDelete) {
      const cv = coerceDataValue(de, v?.value);
      if (cv.problem) { problems.push({ index: i, data_element: de.displayName, value: v?.value, problem: cv.problem, value_type: de.valueType }); return; }
      row.value = cv.value;
      if (v?.comment) row.comment = String(v.comment);
    }
    rows.push(row);
  });
  // Duplicate cells in one call: the last write would silently win.
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.dataElement}.${r.categoryOptionCombo}`;
    if (seen.has(k)) problems.push({ data_element: r._de, category_option_combo: r._coc, problem: 'the same cell appears more than once in this call' });
    seen.set(k, true);
  }
  return { rows, problems };
}

async function readFormValues(form) {
  const q = `dataValueSets?dataSet=${form.ds.id}&period=${encodeURIComponent(form.period)}&orgUnit=${form.ou.id}`
    + (form.isDefaultCombo ? '' : `&attributeOptionCombo=${form.aoc}`);
  const r = await safeDhis2Fetch(q, { noTruncate: true });
  if (r?._error) return { _error: r._error };
  return { values: (r.dataValues || []).filter(v => !form.aoc || !v.attributeOptionCombo || v.attributeOptionCombo === form.aoc), completeDate: r.completeDate || null };
}

function describeCell(form, dv) {
  const de = form.des.get(dv.dataElement);
  const cocs = de?.effectiveCombo?.categoryOptionCombos || [];
  const coc = cocs.length > 1 ? (cocs.find(c => c.id === dv.categoryOptionCombo)?.displayName || dv.categoryOptionCombo) : null;
  return { data_element: de?.displayName || dv.dataElement, ...(coc ? { category_option_combo: coc } : {}) };
}

async function executeManageDataValues(args) {
  _decodeJsonArgs(args, ['values', 'data_values']);
  const action = args?.action;
  const ACTIONS = 'get, set, delete, complete, incomplete, validate';
  if (!action) return { _error: 'Missing required parameter: action', _hint: `One of: ${ACTIONS}.` };
  if (!['get', 'set', 'delete', 'complete', 'incomplete', 'validate'].includes(action)) {
    return { _error: `Unknown action "${action}" for manage_data_values.`, _hint: `One of: ${ACTIONS}.` };
  }
  const writes = ['set', 'delete', 'complete', 'incomplete'];
  if (writes.includes(action)) {
    const gate = requireWriteAuth('manage_data_values', action, { dataset: args.dataset_id || args.dataset, period: args.period, org_unit: args.org_unit_id || args.org_unit });
    if (gate) return gate;
  }
  const form = await resolveDataValueForm(args, { needAssignedOu: action !== 'get' && action !== 'validate' });
  if (form._error) return form;
  const where = { dataset: form.ds.displayName, dataset_id: form.ds.id, period: form.period, org_unit: form.ou.name, org_unit_id: form.ou.id };

  // Lock / completion status. dataEntry/dataValues only exists on 2.39+ — on an
  // older server the probe would be a guaranteed 404, so skip it there.
  const minor = Number(String(dhis2.systemInfo?.version || '').split('.')[1]) || 0;
  const entry = form.isDefaultCombo && (minor === 0 || minor >= 39)
    ? await safeDhis2Fetch(`dataEntry/dataValues?ds=${form.ds.id}&pe=${encodeURIComponent(form.period)}&ou=${form.ou.id}`)
    : null;
  const lockStatus = entry && !entry._error ? entry.lockStatus || null : null;
  const complete = entry && !entry._error ? !!entry.completeStatus?.complete : null;

  if (action === 'get') {
    const cur = await readFormValues(form);
    if (cur._error) return { _error: `Could not read data values: ${cur._error}` };
    const cells = [];
    for (const de of form.des.values()) {
      const cocs = de.effectiveCombo?.categoryOptionCombos || [];
      for (const c of (cocs.length ? cocs : [{ id: null }])) cells.push({ de, coc: c });
    }
    const byKey = new Map(cur.values.map(v => [`${v.dataElement}.${v.categoryOptionCombo}`, v]));
    const values = cur.values.map(v => ({ ...describeCell(form, v), value: v.value, ...(v.comment ? { comment: v.comment } : {}), stored_by: v.storedBy, last_updated: v.lastUpdated, ...(v.followup || v.followUp ? { follow_up: true } : {}) }));
    const empty = cells.filter(c => !byKey.has(`${c.de.id}.${c.coc.id}`)).map(c => ({ data_element: c.de.displayName, ...(c.coc.displayName && c.coc.displayName !== 'default' ? { category_option_combo: c.coc.displayName } : {}) }));
    return {
      success: true, ...where, period_type: form.ds.periodType,
      lock_status: lockStatus, completed: complete,
      filled_cells: values.length, total_cells: cells.length,
      values,
      empty_cells: empty.slice(0, 60), ...(empty.length > 60 ? { empty_cells_truncated: empty.length } : {}),
    };
  }

  if (action === 'validate') {
    const r = await safeDhis2Fetch(`validation/dataSet/${form.ds.id}?pe=${encodeURIComponent(form.period)}&ou=${form.ou.id}`);
    if (r?._error) return { _error: `Validation run failed: ${r._error}` };
    const viol = r.validationRuleViolations || [];
    const ruleIds = [...new Set(viol.map(v => v.validationRule?.id || v.validationRuleId).filter(Boolean))];
    let names = new Map();
    if (ruleIds.length) {
      const vr = await safeDhis2Fetch(`validationRules?filter=id:in:[${ruleIds.join(',')}]&fields=id,displayName,instruction,importance,operator&paging=false`);
      names = new Map((vr?.validationRules || []).map(x => [x.id, x]));
    }
    return {
      success: true, ...where,
      violation_count: viol.length,
      violations: viol.slice(0, 50).map(v => {
        const id = v.validationRule?.id || v.validationRuleId;
        const meta = names.get(id) || {};
        return { rule: meta.displayName || v.validationRuleDescription || id, importance: meta.importance || v.importance, operator: meta.operator, left_side_value: v.leftsideValue ?? v.leftSideValue, right_side_value: v.rightsideValue ?? v.rightSideValue, instruction: meta.instruction || null };
      }),
      comment_required_violations: (r.commentRequiredViolations || []).length,
      message: viol.length ? `${viol.length} validation rule violation(s).` : 'No validation rule violations for this form.',
    };
  }

  if (lockStatus === 'LOCKED' && writes.includes(action)) {
    return { _error: `The ${form.period} form of "${form.ds.displayName}" at ${form.ou.name} is LOCKED (expiry days passed or approved) — DHIS2 will not accept changes.`, ...where, _hint: 'A user with the "Edit expired data" authority, or un-approving the data, is needed. Do not retry.' };
  }

  if (action === 'complete' || action === 'incomplete') {
    if (action === 'complete') {
      const body = { completeDataSetRegistrations: [{ dataSet: form.ds.id, period: form.period, organisationUnit: form.ou.id, attributeOptionCombo: form.aoc, completed: true }] };
      const r = await safeDhis2Fetch('completeDataSetRegistrations', { method: 'POST', body });
      if (r?._error) return { _error: `Marking complete failed: ${r._error}`, ...where };
      const conflicts = r?.response?.conflicts || r?.conflicts || [];
      if (conflicts.length) return { _error: `DHIS2 refused to mark the form complete: ${conflicts.map(c => c.value).join('; ')}`, ...where };
      return { success: true, action, ...where, completed: true, message: `Marked ${form.ds.displayName} ${form.period} at ${form.ou.name} as complete.` };
    }
    const r = await safeDhis2Fetch(`completeDataSetRegistrations?ds=${form.ds.id}&pe=${encodeURIComponent(form.period)}&ou=${form.ou.id}${form.isDefaultCombo ? '' : `&cc=${form.ds.categoryCombo.id}`}`, { method: 'DELETE', allowEmptyBody: true });
    if (r?._error) return { _error: `Marking incomplete failed: ${r._error}`, ...where };
    return { success: true, action, ...where, completed: false };
  }

  // set / delete share the validated cell list
  const inputs = args.values || args.data_values;
  if (action === 'delete' && args.all === true) {
    const cur = await readFormValues(form);
    if (cur._error) return { _error: `Could not read data values: ${cur._error}` };
    if (!cur.values.length) return { success: true, action, ...where, deleted: 0, message: 'The form has no values — nothing to delete.' };
    if (args.confirm_all !== true) {
      return { _error: `Refusing to clear ALL ${cur.values.length} value(s) of this form without confirm_all:true.`, ...where, values_that_would_be_deleted: cur.values.slice(0, 30).map(v => ({ ...describeCell(form, v), value: v.value })), _hint: 'Show the user exactly what will be deleted; only after an explicit "yes" retry with all:true, confirm_all:true.' };
    }
    // The stored value rides along: a DELETE row WITHOUT `value` crashes the
    // importer for option-set data elements ("The import process failed: null",
    // HTTP 409 — DHIS2 2.42.5.1 validates the option of the null value).
    const body = { dataSet: form.ds.id, period: form.period, orgUnit: form.ou.id, attributeOptionCombo: form.aoc, dataValues: cur.values.map(v => ({ dataElement: v.dataElement, categoryOptionCombo: v.categoryOptionCombo, value: v.value })) };
    const r = await safeDhis2Fetch('dataValueSets?importStrategy=DELETE', { method: 'POST', body });
    const sum = summarizeDataValueImport(r);
    if (r?._error && !sum) return { _error: `Delete failed: ${r._error}`, ...where };
    const deleted = sum?.importCount?.deleted ?? 0;
    const ok = !(sum?.conflicts || []).length && deleted === body.dataValues.length;
    return {
      success: ok, action, ...where, deleted, ...(ok ? {} : { not_deleted: body.dataValues.length - deleted, server: sum }),
      conflicts: sum?.conflicts,
      previous_values: cur.values.map(v => ({ ...describeCell(form, v), value: v.value })),
      _restore_hint: 'To undo, call action="set" with previous_values.',
    };
  }
  if (!Array.isArray(inputs) || !inputs.length) {
    return { _error: `values[] is required for ${action}.`, _hint: action === 'set'
      ? 'values:[{ data_element:"<name or UID>", category_option_combo:"<disaggregation name>" (only for disaggregated elements), value:"12" }]'
      : 'values:[{ data_element, category_option_combo? }] — or all:true (with confirm_all:true) to clear the whole form.' };
  }
  const { rows, problems } = buildFormValues(form, inputs, { forDelete: action === 'delete' });
  if (problems.length) {
    return { _error: `${problems.length} value(s) were rejected BEFORE sending (nothing was written).`, ...where, problems, _hint: 'Fix exactly these entries and resend the WHOLE call (all values together).' };
  }

  // Period openness (openFuturePeriods: 0 = only ENDED periods are open).
  if (action === 'set') {
    const ofp = Number(form.ds.openFuturePeriods) || 0;
    const p = periodOrdinal(form.ds.periodType, form.period);
    const c = periodOrdinal(form.ds.periodType, currentPeriodId(form.ds.periodType) || '');
    if (p != null && c != null && p - c > ofp - 1) {
      return { _error: `Period ${form.period} is not open for data entry yet: "${form.ds.displayName}" has openFuturePeriods=${ofp}, so ${ofp === 0 ? 'only periods that have already ENDED (not the current one)' : `only up to ${ofp - 1} period(s) after the current one`} accept data.`, ...where, _hint: `Use an ended period, or increase openFuturePeriods via manage_datasets(action="update", dataset_id="${form.ds.id}", patch:{ open_future_periods: ${Math.max(1, p - c + 1)} }) if the user wants to allow it.` };
    }
  }

  // Previous values of exactly the touched cells — the undo record.
  const cur = await readFormValues(form);
  const prev = new Map(((cur && cur.values) || []).map(v => [`${v.dataElement}.${v.categoryOptionCombo}`, v]));
  const previous = rows.map(r => prev.get(`${r.dataElement}.${r.categoryOptionCombo}`)).filter(Boolean)
    .map(v => ({ ...describeCell(form, v), value: v.value }));
  if (action === 'delete' && !previous.length) {
    return { success: true, action, ...where, deleted: 0, message: 'None of these cells has a value — nothing to delete.' };
  }
  // Deleting an empty cell is a conflict on the server — send only cells that hold a value.
  // …and each delete row carries its stored value (option-set NPE, see delete-all).
  const sendRows = action === 'delete'
    ? rows.filter(r => prev.has(`${r.dataElement}.${r.categoryOptionCombo}`))
      .map(r => ({ ...r, value: prev.get(`${r.dataElement}.${r.categoryOptionCombo}`).value }))
    : rows;

  const body = {
    dataSet: form.ds.id, period: form.period, orgUnit: form.ou.id, attributeOptionCombo: form.aoc,
    dataValues: sendRows.map(({ _de, _coc, ...r }) => r),
  };
  const strict = DATA_VALUE_STRICT_PARAMS.map(k => `${k}=true`).join('&');
  const qs = action === 'delete'
    ? 'importStrategy=DELETE'
    : `importStrategy=CREATE_AND_UPDATE&${strict}${args.dry_run === true ? '&dryRun=true' : ''}`;
  const r = await safeDhis2Fetch(`dataValueSets?${qs}`, { method: 'POST', body });
  const sum = summarizeDataValueImport(r);
  if (r?._error && !sum) return { _error: `Import failed: ${r._error}`, ...where };
  const conflicts = (sum?.conflicts || []).map(c => ({ ...c, cells: (c.indexes || []).map(i => sendRows[i] ? { data_element: sendRows[i]._de, ...(sendRows[i]._coc ? { category_option_combo: sendRows[i]._coc } : {}) } : null).filter(Boolean) }));
  const ic = sum?.importCount || {};
  const written = (ic.imported || 0) + (ic.updated || 0) + (ic.deleted || 0);
  return {
    success: !conflicts.length,
    ...(conflicts.length && written ? { partial: true } : {}),
    action, ...(args.dry_run === true ? { dry_run: true } : {}), ...where,
    import_count: ic,
    ...(conflicts.length ? { conflicts, _hint: `${written ? `${written} value(s) WERE saved; ` : 'Nothing was saved; '}the cells listed in conflicts were NOT. Fix those cells only and resend them — do not resend the ones already saved.` } : {}),
    previous_values: previous,
    ...(previous.length ? { _restore_hint: action === 'delete' ? 'To undo, call action="set" with previous_values.' : 'previous_values holds what these cells contained before — to undo, call action="set" with them.' } : {}),
    ...(complete && action === 'set' ? { _note: 'This form is marked COMPLETE; the values were still saved.' } : {}),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// manage_metadata_translations — per-object translations (names, short names,
// descriptions, form names, labels) shown when a user's DB locale is set
// ════════════════════════════════════════════════════════════════════════════

async function getDbLocales(force = false) {
  _adminCacheSync();
  if (_adminCache.dbLocales && !force) return _adminCache.dbLocales;
  const r = await safeDhis2Fetch('locales/db');
  if (!Array.isArray(r)) return null;
  _adminCache.dbLocales = r.map(l => ({ locale: l.locale, name: l.displayName || l.name }));
  return _adminCache.dbLocales;
}

// "fr-FR" / "fr_fr" / "French" → "fr_FR" / "fr" as configured on the server.
async function resolveLocale(input) {
  const locales = await getDbLocales();
  if (!locales) return { _error: 'Could not load the database locales (GET /api/locales/db).' };
  const s = String(input || '').trim();
  if (!s) return { _error: 'locale is required (e.g. "fr", "ar", "pt_BR").', available_locales: locales.map(l => l.locale) };
  const norm = s.replace('-', '_');
  const hit = locales.find(l => l.locale === norm)
    || locales.find(l => _lc(l.locale) === _lc(norm))
    || locales.find(l => _lc(l.name) === _lc(s));
  if (hit) return { locale: hit.locale, name: hit.name };
  return {
    _error: `Locale "${s}" is not configured as a database locale on this server — translations stored under it would never be shown.`,
    available_locales: locales.map(l => `${l.locale} (${l.name})`),
    _hint: `Pick one of the available locales, or add it first with manage_metadata_translations(action="add_locale", language="${norm.split('_')[0]}"${norm.includes('_') ? `, country="${norm.split('_')[1]}"` : ''}).`,
  };
}

// Accept the three shapes models actually send: { NAME: "…" }, a JSON string of
// that (grammar-constrained decoders emit free-form objects as strings), and
// DHIS2's own [{ property, value, locale? }] array.
function normalizeTranslationMap(t) {
  if (typeof t === 'string') { try { t = JSON.parse(t); } catch { return t; } }
  if (t && typeof t === 'object' && typeof t.$text === 'string') { try { t = JSON.parse(t.$text); } catch { /* keep */ } }
  if (Array.isArray(t)) {
    const out = {};
    for (const e of t) if (e && (e.property || e.key) && e.value != null) out[e.property || e.key] = e.value;
    return out;
  }
  return t;
}

// Map user-facing property names to the schema's translationKey.
function translatableProps(schema) {
  return (schema.properties || []).filter(p => p.translatable && p.translationKey)
    .map(p => ({ key: p.translationKey, field: p.fieldName || p.name }));
}
function resolveTranslationKey(props, input) {
  const s = String(input || '').trim();
  const sq = _squash(s);
  return props.find(p => p.key === s)
    || props.find(p => _squash(p.key) === sq)
    || props.find(p => _squash(p.field) === sq)
    || null;
}

async function executeManageMetadataTranslations(args) {
  _decodeJsonArgs(args, ['items', 'properties']);
  const action = args?.action;
  const ACTIONS = 'list_locales, get, set, remove, add_locale';
  if (!action) return { _error: 'Missing required parameter: action', _hint: `One of: ${ACTIONS}.` };

  if (action === 'list_locales') {
    const locales = await getDbLocales(true);
    if (!locales) return { _error: 'Could not load the database locales.' };
    return { success: true, locales, _note: 'These are the DATABASE (metadata) locales. A user sees translated metadata after choosing one under Profile → Settings → Database locale.' };
  }

  if (action === 'add_locale') {
    const gate = requireWriteAuth('manage_metadata_translations', 'add_locale', { language: args.language, country: args.country });
    if (gate) return gate;
    const lang = String(args.language || '').trim().toLowerCase();
    if (!/^[a-z]{2,3}$/.test(lang)) return { _error: 'language must be an ISO 639 code like "fr", "ar", "pt".' };
    const country = args.country ? String(args.country).trim().toUpperCase() : '';
    if (country && !/^[A-Z]{2}$/.test(country)) return { _error: 'country must be an ISO 3166 code like "FR", "EG".' };
    const want = country ? `${lang}_${country}` : lang;
    const existing = (await getDbLocales(true)) || [];
    if (existing.some(l => l.locale === want)) return { success: true, action, locale: want, message: `Locale ${want} is already configured.` };
    const r = await safeDhis2Fetch(`locales/dbLocales?language=${lang}${country ? `&country=${country}` : ''}`, { method: 'POST', allowEmptyBody: true });
    if (r?._error) return { _error: `Adding locale failed: ${r._error}` };
    await getDbLocales(true);
    return { success: true, action, locale: want, message: `Database locale ${want} added.` };
  }

  // Normalize the object list: items[] (bulk) or a single object_type/object_id.
  const items = Array.isArray(args.items) && args.items.length
    ? args.items
    : [{ object_type: args.object_type, object_id: args.object_id, translations: args.translations, properties: args.properties }];
  if (items.length > 100) return { _error: `Too many objects in one call (${items.length}); send at most 100.` };

  const prepared = [];
  for (const [i, it] of items.entries()) {
    const type = it.object_type || args.object_type;
    const id = it.object_id;
    if (!type || !id) return { _error: `items[${i}]: object_type and object_id are required.` };
    const schema = await getSchemaFor(type);
    if (!schema) return { _error: `items[${i}]: unknown object type "${type}".`, _hint: 'Use the API collection name, e.g. dataElements, programs, programStages, options, trackedEntityAttributes, dataSets, sections, indicators, programIndicators, organisationUnits, categoryOptions.' };
    const props = translatableProps(schema);
    if (!props.length) return { _error: `items[${i}]: ${schema.plural} objects have no translatable properties.` };
    prepared.push({ i, it, schema, props, type: schema.plural, id });
  }

  if (action === 'get') {
    const locale = args.locale ? await resolveLocale(args.locale) : null;
    if (locale?._error) return locale;
    const out = [];
    for (const p of prepared) {
      const r = await safeDhis2Fetch(`${p.type}/${p.id}?fields=id,displayName,translations,${p.props.map(x => x.field).join(',')}`);
      if (r?._status === 404) return { _error: `${p.type}/${p.id} does not exist (404).` };
      if (r?._error) return { _error: `Could not load ${p.type}/${p.id}: ${r._error}` };
      const tr = (r.translations || []).filter(t => !locale || t.locale === locale.locale);
      const byLocale = {};
      for (const t of tr) (byLocale[t.locale] = byLocale[t.locale] || {})[t.property] = t.value;
      out.push({
        object_type: p.type, object_id: p.id, name: r.displayName,
        translatable_properties: p.props.map(x => ({ property: x.key, field: x.field, source_value: r[x.field] ?? null })),
        translations: byLocale,
      });
    }
    return { success: true, objects: out };
  }

  if (action === 'set' || action === 'remove') {
    const gate = requireWriteAuth('manage_metadata_translations', action, { object_type: prepared[0].type, object_id: prepared[0].id, count: prepared.length });
    if (gate) return gate;
    const locale = await resolveLocale(args.locale);
    if (locale._error) return locale;

    // Validate everything BEFORE the first write.
    const plans = [];
    const problems = [];
    for (const p of prepared) {
      if (action === 'set') {
        const map = normalizeTranslationMap(p.it.translations || args.translations);
        if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.keys(map).length) {
          problems.push({ object_id: p.id, problem: 'translations must be an object like { NAME: "…", SHORT_NAME: "…" }' });
          continue;
        }
        const entries = [];
        for (const [k, v] of Object.entries(map)) {
          const key = resolveTranslationKey(p.props, k);
          if (!key) { problems.push({ object_id: p.id, property: k, problem: `not a translatable property of ${p.schema.name}`, valid_properties: p.props.map(x => x.key) }); continue; }
          if (v == null || String(v).trim() === '') { problems.push({ object_id: p.id, property: k, problem: 'empty value (use action="remove" to delete a translation)' }); continue; }
          if (key.key === 'SHORT_NAME' && String(v).length > 50) { problems.push({ object_id: p.id, property: k, problem: 'short name translation longer than 50 characters' }); continue; }
          entries.push({ property: key.key, value: String(v) });
        }
        plans.push({ ...p, entries });
      } else {
        const list = p.it.properties || args.properties;
        let keys = null;
        if (Array.isArray(list) && list.length) {
          keys = [];
          for (const k of list) {
            const key = resolveTranslationKey(p.props, k);
            if (!key) problems.push({ object_id: p.id, property: k, problem: `not a translatable property of ${p.schema.name}`, valid_properties: p.props.map(x => x.key) });
            else keys.push(key.key);
          }
        }
        plans.push({ ...p, keys });
      }
    }
    if (problems.length) return { _error: `${problems.length} problem(s) found BEFORE writing (nothing was changed).`, problems };

    // Read current translations (also the existence check).
    for (const pl of plans) {
      const r = await safeDhis2Fetch(`${pl.type}/${pl.id}/translations`);
      if (r?._status === 404) return { _error: `${pl.type}/${pl.id} does not exist (404). Nothing was changed.` };
      if (r?._error) return { _error: `Could not read translations of ${pl.type}/${pl.id}: ${r._error}` };
      pl.before = Array.isArray(r.translations) ? r.translations : [];
    }

    const results = [];
    for (const pl of plans) {
      let next;
      if (action === 'set') {
        // MERGE: PUT replaces the whole set, so carry every other locale/property over.
        const touched = new Set(pl.entries.map(e => e.property));
        next = pl.before.filter(t => !(t.locale === locale.locale && touched.has(t.property)))
          .concat(pl.entries.map(e => ({ locale: locale.locale, property: e.property, value: e.value })));
      } else {
        next = pl.before.filter(t => !(t.locale === locale.locale && (!pl.keys || pl.keys.includes(t.property))));
        if (next.length === pl.before.length) { results.push({ object_type: pl.type, object_id: pl.id, ok: true, removed: 0 }); continue; }
      }
      const r = await safeDhis2Fetch(`${pl.type}/${pl.id}/translations`, { method: 'PUT', body: { translations: next } });
      results.push({
        object_type: pl.type, object_id: pl.id, ok: !r?._error,
        ...(r?._error ? { error: r._error } : {}),
        ...(action === 'set' ? { set: pl.entries.map(e => e.property) } : { removed: pl.before.length - next.length }),
        previous_translations: pl.before.filter(t => t.locale === locale.locale),
      });
    }
    // Verify one object end-to-end the way users see it.
    let verified = null;
    const firstOk = results.find(x => x.ok && action === 'set');
    if (firstOk) {
      const v = await safeDhis2Fetch(`${firstOk.object_type}/${firstOk.object_id}?fields=displayName&translate=true&locale=${encodeURIComponent(locale.locale)}`);
      if (v && !v._error) verified = { object_id: firstOk.object_id, display_name_in_locale: v.displayName };
    }
    const failed = results.filter(x => !x.ok);
    return {
      success: !failed.length, action, locale: locale.locale, locale_name: locale.name,
      objects_changed: results.filter(x => x.ok).length, results,
      ...(verified ? { verified } : {}),
      _note: 'Other locales and properties were preserved (merge). Users see these translations after selecting this Database locale in their profile settings.',
    };
  }

  return { _error: `Unknown action "${action}" for manage_metadata_translations.`, _hint: `One of: ${ACTIONS}.` };
}
