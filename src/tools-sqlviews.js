// ── manage_sql_views: DHIS2 SQL views ────────────────────────────────────────
// A SQL view is DHIS2's supported way to read data that no Web API endpoint
// exposes — e.g. tracker ownership-TRANSFER history, which lives only in the
// programownershiphistory table. Built 2026-10-23 after a chatbot asked for a
// "transfer history" dashboard plugin probed four guessed endpoints (405, 404,
// 404, 500), guessed column names from the 2.40 schema, created a view no one
// could read (sharing rw------ → E4312 even for a superuser), and then told the
// user "DHIS2 validated the SQL on save" — it does not.
//
// Server rules, verified live on 2.42.5.1 (localhost) and 2.43.2 (playground):
// - POST /sqlViews does NOT run or check the SQL: a view on a table that does
//   not exist saves with 201. Every check happens when the view is READ, so
//   create / update here always run the view once and remove a view that fails.
// - Read-time errors (HTTP 409): E7144 missing table, E7145 missing column or
//   other SQL error (their "run analytics" / "syntax error" wording misleads —
//   devMessage has the real PostgreSQL error), E4310 protected table, E4311 illegal keyword, E4307 a ${variable}
//   without a value, E4312 the caller has no DATA read on the view.
// - Illegal keywords: the 15 words below, case-insensitive, ANYWHERE in the
//   text (also inside a string: 'delete me' is refused); "lastupdated" and
//   "x_delete" are fine — the server splits on non-word characters.
// - A ${name} with no value, or a value outside letters/digits/space/_/-, is
//   E4307 ("var=name:a:b" counts as not provided).
// - Table renames: 2.41 trackedentityinstance → trackedentity, programinstance →
//   enrollment, programstageinstance → event; 2.43 splits event into
//   trackerevent (tracker programs) and singleevent (event programs).
// - Sharing is "metadata, data" access: a reader needs DATA read (3rd char r).

const SQL_VIEW_ACTIONS = ['list', 'get', 'describe', 'create', 'update', 'delete', 'run'];
const SQL_VIEW_TYPES = new Set(['QUERY', 'VIEW', 'MATERIALIZED_VIEW']);
const SQL_VIEW_CACHE = new Set(['NO_CACHE', 'RESPECT_SYSTEM_SETTING', 'CACHE_1_MINUTE', 'CACHE_5_MINUTES', 'CACHE_10_MINUTES', 'CACHE_15_MINUTES', 'CACHE_30_MINUTES', 'CACHE_1_HOUR', 'CACHE_6AM_TOMORROW', 'CACHE_TWO_WEEKS']);
const SQL_VIEW_ILLEGAL_KEYWORDS = ['delete', 'alter', 'update', 'create', 'drop', 'commit', 'createdb', 'createuser', 'insert', 'rename', 'restore', 'write', 'grant', 'truncate', 'revoke'];
const SQL_VIEW_PROTECTED_TABLES = new Set(['users', 'userinfo', 'trackedentityattributevalue', 'oauth_access_token', 'oauth2client']);
const SQL_VIEW_BUILTIN_VARS = new Set(['_current_user_id', '_current_username']);
const SQL_VIEW_VAR_NAME_RE = /^[-a-zA-Z0-9_]+$/;
const SQL_VIEW_VAR_VALUE_RE = /^[\p{L}\w\s-]*$/u;
// table → { since: first minor version WITHOUT it, use: replacement }
const SQL_VIEW_REMOVED_TABLES = {
  trackedentityinstance: { since: 41, use: 'trackedentity' },
  programinstance: { since: 41, use: 'enrollment' },
  programstageinstance: { since: 41, use: 'event (2.41–2.42) — trackerevent / singleevent from 2.43' },
  event: { since: 43, use: 'trackerevent (tracker-program events) or singleevent (event-program events)' },
  event_notes: { since: 43, use: 'trackerevent_notes / singleevent_notes' },
  eventchangelog: { since: 43, use: 'trackereventchangelog / singleeventchangelog' },
};
// table → first minor version that HAS it
const SQL_VIEW_NEW_TABLES = { trackedentity: 41, enrollment: 41, event: 41, trackerevent: 43, singleevent: 43 };
const SQL_VIEW_RENAMED_COLUMNS = {
  trackedentityinstanceid: 'trackedentityid', programinstanceid: 'enrollmentid', programstageinstanceid: 'eventid',
  executiondate: 'occurreddate', duedate: 'scheduleddate', incidentdate: 'occurreddate',
};

function sqlViewServerMinor() {
  const n = Number(dhis2 && dhis2.apiVersion);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Every ${name} in the SQL, builtins excluded.
function sqlViewVariables(sql) {
  const names = [];
  for (const m of String(sql || '').matchAll(/\$\{([^}]*)\}/g)) {
    if (!SQL_VIEW_BUILTIN_VARS.has(m[1]) && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// Everything that would make DHIS2 refuse or fail the view, found before any
// request. → { problems: [..], variables, analysis }
function precheckSqlViewQuery(sql, opts = {}) {
  const problems = [];
  if (typeof sql !== 'string' || !sql.trim()) return { problems: ['sql_query is empty.'], variables: [], analysis: null };
  if (sql.length > 50000) problems.push(`sql_query is ${sql.length} characters — keep a view under 50,000.`);
  const words = new Set(sql.toLowerCase().split(/[^a-z0-9_]+/));
  const illegal = SQL_VIEW_ILLEGAL_KEYWORDS.filter((k) => words.has(k));
  if (illegal.length) {
    problems.push(`Contains the word${illegal.length > 1 ? 's' : ''} ${illegal.map((k) => `"${k}"`).join(', ')}: DHIS2 refuses a SQL view with any of ${SQL_VIEW_ILLEGAL_KEYWORDS.join(', ')} ANYWHERE in its text — also inside a string literal or an alias (E4311). Rename the alias / reword the literal ("lastupdated" or "updated_at" are fine).`);
  }
  const analysis = analyzeSqlViewPrivacy(sql);
  for (const p of analysis.problems) {
    if (/not a SELECT/.test(p)) problems.push('A SQL view must be ONE read query starting with SELECT or WITH.');
    else if (/more than one statement/.test(p)) problems.push('Only one statement is allowed (a single trailing ";" is fine).');
    else if (/unterminated|unbalanced|positional/.test(p)) problems.push(`The SQL does not parse: ${p}.`);
  }
  const prot = analysis.tables.filter((t) => SQL_VIEW_PROTECTED_TABLES.has(t.replace(/^public\./, '')));
  if (prot.length) {
    problems.push(`Reads the protected table${prot.length > 1 ? 's' : ''} ${prot.join(', ')}: DHIS2 refuses ${[...SQL_VIEW_PROTECTED_TABLES].join(', ')} in SQL views (E4310). For the user who did something use a username column of the row itself (e.g. programownershiphistory.createdby, trackedentityprogramowner.createdby — both usernames).`);
  }
  const minor = opts.minor != null ? opts.minor : sqlViewServerMinor();
  if (minor) {
    for (const t of analysis.tables) {
      const r = SQL_VIEW_REMOVED_TABLES[t];
      if (r && minor >= r.since) problems.push(`Table "${t}" does not exist on this server (2.${minor}): use ${r.use}.`);
      const since = SQL_VIEW_NEW_TABLES[t];
      if (since && minor < since) problems.push(`Table "${t}" only exists from 2.${since}; this server is 2.${minor}.`);
    }
    if (minor >= 41) {
      const oldCols = Object.keys(SQL_VIEW_RENAMED_COLUMNS).filter((c) => words.has(c));
      if (oldCols.length) problems.push(`Column name${oldCols.length > 1 ? 's' : ''} from DHIS2 2.40 and older: ${oldCols.map((c) => `${c} → ${SQL_VIEW_RENAMED_COLUMNS[c]}`).join(', ')}.`);
    }
  }
  const variables = sqlViewVariables(sql);
  const badNames = variables.filter((v) => !SQL_VIEW_VAR_NAME_RE.test(v));
  if (badNames.length) problems.push(`Variable name${badNames.length > 1 ? 's' : ''} ${badNames.map((v) => `\${${v}}`).join(', ')} not allowed: letters, digits, "_" and "-" only.`);
  if (opts.testVariables !== undefined) {
    const tv = opts.testVariables && typeof opts.testVariables === 'object' ? opts.testVariables : {};
    const missing = variables.filter((v) => tv[v] == null || tv[v] === '');
    if (missing.length) {
      problems.push(`The view uses ${missing.map((v) => `\${${v}}`).join(', ')} — pass test_variables with a value for each (e.g. {"${missing[0]}": "…"}) so it can be test-run; every reader must send them too (var=name:value), or DHIS2 answers E4307.`);
    }
    for (const [k, v] of Object.entries(tv)) {
      if (!SQL_VIEW_VAR_VALUE_RE.test(String(v))) problems.push(`test_variables.${k} = "${v}" is not a value DHIS2 accepts: letters, digits, spaces, "_" and "-" only (a date is fine as YYYY-MM-DD; no ":", ".", "," or quotes).`);
    }
  }
  return { problems, variables, analysis };
}

// sharing arg → DHIS2 sharing object (keeps the current owner on update).
function sqlViewSharingFromArgs(arg, current) {
  const base = current && typeof current === 'object' ? current : {};
  const out = { ...base, external: false, users: base.users || {}, userGroups: base.userGroups || {} };
  out.public = (arg && arg.public != null) ? String(arg.public) : (base.public || 'r-r-----');
  if (!/^[r-][w-][r-][w-]-{4}$/.test(out.public)) return { _error: `sharing.public "${out.public}" is not a DHIS2 access string. Use 8 characters: metadata read/write then data read/write, e.g. "r-r-----" (everyone can see the view and read its rows) or "r-------" (see it, rows refused).` };
  if (arg && Array.isArray(arg.user_groups)) {
    out.userGroups = {};
    for (const g of arg.user_groups) {
      const id = g && String(g.id || '');
      const access = g && String(g.access || 'r-r-----');
      if (!/^[A-Za-z][A-Za-z0-9]{10}$/.test(id) || !/^[r-][w-][r-][w-]-{4}$/.test(access)) return { _error: `sharing.user_groups entry ${JSON.stringify(g)} needs a user-group UID and an access string like "r-r-----".` };
      out.userGroups[id] = { id, access };
    }
  }
  return { sharing: out };
}

// A view no one can read is never useful: DHIS2 answers 409 E4312 to every
// reader, superusers included (the failed thread's "rw------" view).
const SQL_VIEW_UNREADABLE = 'Not saved: with this sharing NOBODY could read the view\'s rows — not even a superuser (HTTP 409 E4312 on every read). Give data read: {"public":"r-r-----"}, or {"public":"r-------","user_groups":[{"id":"<group UID>","access":"r-r-----"}]}.';

// Who can read the view's rows, in words.
function sqlViewDataReaders(sharing) {
  const s = sharing || {};
  const dataRead = (a) => typeof a === 'string' && a[2] === 'r';
  const groups = Object.values(s.userGroups || {}).filter((g) => dataRead(g && g.access)).length;
  const users = Object.values(s.users || {}).filter((u) => dataRead(u && u.access)).length;
  if (dataRead(s.public)) return { anyone: true, text: 'every logged-in user can read its rows (public data read) — anyone who can open it reads EVERY row it returns' };
  if (groups || users) return { anyone: true, text: `rows readable by ${groups ? `${groups} user group(s)` : ''}${groups && users ? ' and ' : ''}${users ? `${users} user(s)` : ''} with data read` };
  return { anyone: false, text: 'NOBODY can read its rows — not even a superuser: no data-read sharing (HTTP 409 E4312 for every reader)' };
}

// PostgreSQL errors raised while planning (bad names, syntax) never contain
// row values; errors raised while reading rows can ("invalid input syntax for
// type integer: \"<a value>\""). For a view that is not metadata-only only
// the planning kind is passed on.
const SQL_PLANNING_ERROR_RE = /(?:relation|column|function|operator|type|schema) .{0,120}does not exist|syntax error at or near|missing FROM-clause entry|is ambiguous|must appear in the GROUP BY clause|aggregate functions are not allowed|invalid reference to FROM-clause entry|cannot be matched|is of type .{0,60} but expression is of type|could not identify|argument of .{0,40} must be type|window function .{0,60} requires an OVER clause|each UNION query must have the same number of columns|subquery .{0,40} must have an alias|recursive reference/i;
function sqlViewDbError(resp, metadataOnly) {
  const body = (resp && resp._body) || {};
  const code = body.errorCode || null;
  const dev = String(body.devMessage || '').replace(/\s+/g, ' ').trim();
  const message = String(body.message || resp._error || 'unknown error');
  let db = null;
  if (dev) {
    if (metadataOnly || SQL_PLANNING_ERROR_RE.test(dev)) db = dev.slice(0, 400);
    else db = 'a value in the data could not be processed (PostgreSQL details withheld: they can quote values from patient-level rows)';
  }
  let hint;
  if (code === 'E7144' || /does not exist/i.test(dev)) hint = 'A table or column name is wrong (db_error names it) — ignore DHIS2\'s "ensure analytics job was run" / "syntax error" wording, it is not about analytics here. Look up the real names with manage_sql_views(action="describe", tables=[…]) and fix the SQL.';
  else if (code === 'E7145') hint = 'The SQL has an error at the position db_error gives — fix it there.';
  else if (code === 'E4310') hint = 'Remove every protected table (users, userinfo, trackedentityattributevalue, oauth_access_token, oauth2client).';
  else if (code === 'E4311') hint = `Remove the words ${SQL_VIEW_ILLEGAL_KEYWORDS.join(', ')} from the SQL — anywhere, also inside strings and aliases.`;
  else if (code === 'E4307') hint = 'Give every ${variable} a value (test_variables / variables); values may contain letters, digits, spaces, "_" and "-" only.';
  else if (code === 'E4312') hint = 'The view has no data-read sharing for this user: update it with sharing {"public": "r-r-----"} (or user_groups with "r-r-----").';
  else hint = 'Fix the SQL using the database error above, then retry once.';
  return { code, message, db_error: db, hint };
}

function sqlViewQueryString(variables, page, pageSize) {
  const q = new URLSearchParams();
  const entries = Object.entries(variables || {}).filter(([, v]) => v != null && v !== '');
  if (entries.length) q.set('var', entries.map(([k, v]) => `${k}:${v}`).join(','));
  q.set('paging', 'true');
  q.set('page', String(page || 1));
  q.set('pageSize', String(pageSize || 5));
  return q.toString();
}

// Runs the view once. Never decides what the MODEL sees — callers do.
// → { columns, row_count, rows } | { _error, … }
async function runSqlViewOnce(id, type, variables, page, pageSize) {
  if (type && type !== 'QUERY') {
    const ex = await safeDhis2Fetch(`sqlViews/${id}/execute`, { method: 'POST' });
    if (ex && ex._error) return { _error: ex._error, _resp: ex };
  }
  const d = await safeDhis2Fetch(`sqlViews/${id}/data?${sqlViewQueryString(variables, page, pageSize)}`, { noTruncate: true });
  if (!d || d._error) return { _error: (d && d._error) || 'no response', _resp: d };
  const grid = d.listGrid || {};
  const columns = (grid.headers || []).map((h) => h.name || h.column);
  const rows = Array.isArray(grid.rows) ? grid.rows : [];
  const total = d.pager && Number.isFinite(d.pager.total) ? d.pager.total : rows.length;
  return { columns, row_count: total, rows };
}

// What the model may see of a run: rows only for a metadata-only QUERY view,
// or when requests stay on this machine (local model).
function sqlViewRowsAllowed(type, sql) {
  const local = typeof providerRequestsStayLocal === 'function' && providerRequestsStayLocal(getProviderConfig());
  const a = analyzeSqlViewPrivacy(sql);
  const metadataOnly = (type || 'QUERY') === 'QUERY' && a.metadataOnly;
  return { allowed: metadataOnly || local, metadataOnly, local, reason: metadataOnly ? null : sqlPrivacyReason(a, type) };
}

function sqlViewTestSummary(run, access, maxRows) {
  const out = { ran: true, columns: run.columns, row_count: run.row_count };
  if (access.allowed) out.rows = run.rows.slice(0, maxRows);
  else out.rows_withheld = `the view is not metadata-only (${access.reason}), so on a cloud model you see its columns and row count, never its rows`;
  if (run.row_count === 0) out.note = 'It ran and returned 0 rows on this server right now — say so plainly; do not claim it shows data.';
  return out;
}

// How a plugin / app reads the view (app-runtime, kit globals).
function sqlViewPluginRead(id, variables) {
  const vars = variables || [];
  const lines = [
    `const ROWS = { rows: { resource: 'sqlViews/${id}/data', params: ({ ${vars.length ? `${vars.join(', ')}, ` : ''}page }) => ({`,
  ];
  if (vars.length) lines.push(`  var: [${vars.map((v) => '`' + v + ':${' + v + '}`').join(', ')}],   // EVERY variable on every request (E4307 otherwise)`);
  lines.push('  page, pageSize: 50 }) } };   // server-side paging — never paging:false');
  lines.push(`// useDataQuery(ROWS, { variables: { ${vars.length ? `${vars.map((v) => `${v}: …`).join(', ')}, ` : ''}page: 1 } })`);
  lines.push('// → data.rows.listGrid.headers[i].name, data.rows.listGrid.rows (every value a STRING), data.rows.pager.total');
  return lines.join('\n');
}

async function findSqlViewByName(name) {
  const r = await safeDhis2Fetch(`sqlViews?fields=id,displayName,name,type,sqlQuery&paging=false&filter=name:eq:${encodeURIComponent(name)}`, { noTruncate: true });
  if (!r || r._error) return { _error: r && r._error };
  return { view: (r.sqlViews || [])[0] || null };
}

async function getSqlViewDef(id, fields) {
  return await safeDhis2Fetch(`sqlViews/${id}?fields=${fields || 'id,displayName,name,description,type,cacheStrategy,sqlQuery,sharing,created,lastUpdated'}`, { noTruncate: true });
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function listSqlViews(args) {
  const page = Math.max(1, Number(args.page) || 1);
  const q = String(args.query || '').trim();
  const r = await safeDhis2Fetch(`sqlViews?fields=id,displayName,type,cacheStrategy,lastUpdated&order=displayName:asc&pageSize=50&page=${page}${q ? `&filter=displayName:ilike:${encodeURIComponent(q)}` : ''}`, { noTruncate: true });
  if (!r || r._error) return { _error: `Could not list SQL views: ${r && r._error}` };
  return {
    sql_views: (r.sqlViews || []).map((v) => ({ id: v.id, name: v.displayName, type: v.type, cache: v.cacheStrategy, last_updated: v.lastUpdated })),
    pager: r.pager ? { page: r.pager.page, page_count: r.pager.pageCount, total: r.pager.total } : undefined,
    _hint: 'manage_sql_views(action="get", id) shows a view\'s SQL, variables and who can read it. Reuse a view that already returns what you need instead of creating a copy.',
  };
}

async function getSqlView(args) {
  if (!args.id) return { _error: 'get needs id.' };
  const v = await getSqlViewDef(args.id);
  if (!v || v._error) return { _error: `SQL view ${args.id}: ${v && v._error}` };
  const access = sqlViewRowsAllowed(v.type, v.sqlQuery);
  const variables = sqlViewVariables(v.sqlQuery);
  return {
    id: v.id, name: v.displayName, description: v.description || undefined, type: v.type, cache: v.cacheStrategy,
    sql_query: v.sqlQuery, variables,
    data_access: sqlViewDataReaders(v.sharing).text,
    metadata_only: access.metadataOnly,
    rows_visible_to_you: access.allowed,
    ...(access.allowed ? {} : { why_rows_hidden: access.reason }),
    plugin_read: sqlViewPluginRead(v.id, variables),
    last_updated: v.lastUpdated,
  };
}

// Real column names from the database (information_schema — metadata about
// the schema, not data) via a short-lived QUERY view that is removed again.
async function describeSqlTables(args) {
  const raw = Array.isArray(args.tables) ? args.tables : (args.table ? [args.table] : []);
  const names = [...new Set(raw.map((t) => String(t || '').trim().toLowerCase().replace(/^public\./, '')).filter(Boolean))];
  const search = String(args.search || '').trim().toLowerCase();
  if (!names.length && !search) return { _error: 'describe needs tables (["programownershiphistory", …]) and/or search ("ownership").' };
  if (names.length > 15) return { _error: `describe takes at most 15 tables per call (got ${names.length}).` };
  const bad = names.filter((t) => !/^[a-z_][a-z0-9_]{0,62}$/.test(t));
  if (bad.length || (search && !/^[a-z0-9_]{2,40}$/.test(search))) return { _error: `Not table names: ${[...bad, ...(search && !/^[a-z0-9_]{2,40}$/.test(search) ? [search] : [])].join(', ')} (letters, digits and "_" only).` };
  const parts = [];
  if (names.length) {
    parts.push(`select 'c' as k, c.table_name as t, c.column_name as n, c.data_type as d, c.is_nullable as x, c.ordinal_position as o from information_schema.columns c where c.table_schema = 'public' and c.table_name in (${names.map((t) => `'${t}'`).join(', ')})`);
  }
  if (search) {
    parts.push(`select 't' as k, i.table_name as t, null as n, null as d, null as x, 0 as o from information_schema.tables i where i.table_schema = 'public' and i.table_name like '%${search}%' and i.table_name not like 'analytics%' and i.table_name not like '\\_view\\_%'`);
  }
  const sql = `${parts.join(' union all ')} order by 1, 2, 6`;
  const id = generateDhis2Uid();
  const created = await safeDhis2Fetch('sqlViews', { method: 'POST', body: { id, name: `ai-tmp-describe-${id}`, type: 'QUERY', cacheStrategy: 'NO_CACHE', sqlQuery: sql, sharing: { public: 'r-r-----', external: false, users: {}, userGroups: {} } } });
  if (created && created._error) return { _error: `Could not read the database schema: ${created._error}`, _hint: 'Creating a SQL view needs the "Add/Update Public SQL View" authority (or ALL).' };
  let d;
  try {
    d = await safeDhis2Fetch(`sqlViews/${id}/data?paging=false`, { noTruncate: true });
  } finally {
    await safeDhis2Fetch(`sqlViews/${id}`, { method: 'DELETE' });
  }
  if (!d || d._error) return { _error: `Could not read the database schema: ${d && d._error}` };
  const tables = {};
  const matching = [];
  for (const [k, t, n, dt, nullable] of (d.listGrid && d.listGrid.rows) || []) {
    if (k === 't') { matching.push(t); continue; }
    (tables[t] = tables[t] || []).push(`${n} ${dt}${nullable === 'NO' ? ' not null' : ''}`);
  }
  const minor = sqlViewServerMinor();
  const notFound = names.filter((t) => !tables[t]);
  const renamed = {};
  for (const t of notFound) {
    const r = SQL_VIEW_REMOVED_TABLES[t];
    if (r && minor && minor >= r.since) renamed[t] = r.use;
  }
  return {
    server: minor ? `2.${minor}` : undefined,
    tables,
    ...(notFound.length ? { not_found: notFound } : {}),
    ...(Object.keys(renamed).length ? { renamed } : {}),
    ...(search ? { matching_tables: matching.slice(0, 60) } : {}),
  };
}

async function createSqlView(args) {
  const name = String(args.name || '').trim();
  if (!name) return { _error: 'create needs name.' };
  const type = String(args.type || 'QUERY').toUpperCase();
  if (!SQL_VIEW_TYPES.has(type)) return { _error: `type must be one of ${[...SQL_VIEW_TYPES].join(', ')} (QUERY recommended: runs fresh on every read and supports \${variables}).` };
  const cache = String(args.cache_strategy || 'NO_CACHE').toUpperCase();
  if (!SQL_VIEW_CACHE.has(cache)) return { _error: `cache_strategy must be one of ${[...SQL_VIEW_CACHE].join(', ')}.` };
  const pre = precheckSqlViewQuery(args.sql_query, { testVariables: args.test_variables || {} });
  if (type !== 'QUERY' && pre.variables.length) pre.problems.push(`\${variables} only work in QUERY views — use type "QUERY".`);
  if (pre.problems.length) {
    return {
      _error: `SQL view not created: ${pre.problems.length} problem(s) found before sending anything to DHIS2.`,
      problems: pre.problems,
      _hint: 'Fix exactly these and resend. Not sure about a table or column? manage_sql_views(action="describe", tables=[…]) lists the real columns on this server.',
    };
  }
  const sh = sqlViewSharingFromArgs(args.sharing, null);
  if (sh._error) return { _error: sh._error };
  if (!sqlViewDataReaders(sh.sharing).anyone) return { _error: SQL_VIEW_UNREADABLE };
  const gate = requireWriteAuth('manage_sql_views', 'create', { name });
  if (gate) return gate;

  const same = await findSqlViewByName(name);
  if (same._error) return { _error: `Could not check for an existing view named "${name}": ${same._error}` };
  if (same.view) {
    if (String(same.view.sqlQuery || '').trim() === String(args.sql_query).trim()) {
      return { ...(await getSqlView({ id: same.view.id })), success: true, reused: true, _note: 'A view with this name and exactly this SQL already exists — reused it, nothing was created.' };
    }
    return {
      _error: `A SQL view named "${name}" already exists (${same.view.id}) with different SQL.`,
      existing_id: same.view.id,
      _hint: `Change that view with manage_sql_views(action="update", id="${same.view.id}", sql_query=…) — it is backed up first — or choose another name. Never create a second copy.`,
    };
  }

  const id = generateDhis2Uid();
  const body = { id, name, type, cacheStrategy: cache, sqlQuery: args.sql_query, sharing: sh.sharing };
  if (args.description) body.description = String(args.description);
  const r = await safeDhis2Fetch('sqlViews', { method: 'POST', body });
  if (r && r._error) return { _error: `DHIS2 refused the SQL view: ${r._error}`, ...(r.error_details ? { error_details: r.error_details } : {}) };

  const access = sqlViewRowsAllowed(type, args.sql_query);
  const run = await runSqlViewOnce(id, type, args.test_variables, 1, access.allowed ? 5 : 1);
  if (run._error) {
    const err = sqlViewDbError(run._resp, access.metadataOnly);
    const del = await safeDhis2Fetch(`sqlViews/${id}`, { method: 'DELETE' });
    return {
      _error: `The SQL failed when DHIS2 ran it${err.code ? ` (${err.code})` : ''}: ${err.message}`,
      ...(err.db_error ? { db_error: err.db_error } : {}),
      view_removed: !(del && del._error),
      _hint: `${err.hint} The failed view was ${del && del._error ? 'NOT removed — delete ' + id + ' with manage_sql_views(action="delete")' : 'removed, so nothing is left behind'}; send create again with the corrected SQL.`,
    };
  }
  recordRecentCreation('sqlView', name, id);
  return {
    success: true,
    action: 'create',
    id, name, type, cache,
    variables: pre.variables,
    test: sqlViewTestSummary(run, access, 5),
    data_access: sqlViewDataReaders(sh.sharing).text,
    plugin_read: sqlViewPluginRead(id, pre.variables),
    _note: 'DHIS2 does not check SQL when a view is saved — this view was RUN once and works. Tell the user who can read its rows (data_access).',
  };
}

async function updateSqlView(args) {
  const id = String(args.id || '').trim();
  if (!id) return { _error: 'update needs id.' };
  const changing = ['name', 'description', 'sql_query', 'type', 'cache_strategy', 'sharing'].filter((k) => args[k] != null);
  if (!changing.length) return { _error: 'update needs at least one of name, description, sql_query, type, cache_strategy, sharing.' };
  const exists = await verifyTargetExists('sqlViews', id, 'manage_sql_views', 'update', ':owner');
  if (!exists.exists) return exists.refusal;
  const current = exists.data;
  const next = { ...current };
  if (args.name != null) next.name = String(args.name).trim();
  if (args.description != null) next.description = String(args.description);
  if (args.type != null) {
    next.type = String(args.type).toUpperCase();
    if (!SQL_VIEW_TYPES.has(next.type)) return { _error: `type must be one of ${[...SQL_VIEW_TYPES].join(', ')}.` };
  }
  if (args.cache_strategy != null) {
    next.cacheStrategy = String(args.cache_strategy).toUpperCase();
    if (!SQL_VIEW_CACHE.has(next.cacheStrategy)) return { _error: `cache_strategy must be one of ${[...SQL_VIEW_CACHE].join(', ')}.` };
  }
  if (args.sql_query != null) next.sqlQuery = String(args.sql_query);
  const pre = precheckSqlViewQuery(next.sqlQuery, { testVariables: args.test_variables || {} });
  if (next.type !== 'QUERY' && pre.variables.length) pre.problems.push(`\${variables} only work in QUERY views — use type "QUERY".`);
  if (pre.problems.length) {
    return { _error: `SQL view not updated: ${pre.problems.length} problem(s) found before sending anything to DHIS2.`, problems: pre.problems, _hint: 'Fix exactly these and resend. manage_sql_views(action="describe", tables=[…]) lists the real columns.' };
  }
  if (args.sharing != null) {
    const sh = sqlViewSharingFromArgs(args.sharing, current.sharing);
    if (sh._error) return { _error: sh._error };
    if (!sqlViewDataReaders(sh.sharing).anyone) return { _error: SQL_VIEW_UNREADABLE };
    next.sharing = sh.sharing;
  }
  const gate = requireWriteAuth('manage_sql_views', 'update', { id });
  if (gate) return gate;
  const backup = await ensureBackupOrBail(
    { operation: 'update_sql_view', tool: 'manage_sql_views', action: 'update', user_text: lastUserText },
    [{ object_type: 'sqlViews', object_id: id, role: 'primary' }], args);
  if (!backup.ok) return backup.error;
  const put = await safeDhis2Fetch(`sqlViews/${id}`, { method: 'PUT', body: next });
  if (put && put._error) return { _error: `DHIS2 refused the update: ${put._error}`, backup: backup.block };

  const access = sqlViewRowsAllowed(next.type, next.sqlQuery);
  const run = await runSqlViewOnce(id, next.type, args.test_variables, 1, access.allowed ? 5 : 1);
  if (run._error) {
    const err = sqlViewDbError(run._resp, access.metadataOnly);
    const back = await safeDhis2Fetch(`sqlViews/${id}`, { method: 'PUT', body: current });
    return {
      _error: `The new SQL failed when DHIS2 ran it${err.code ? ` (${err.code})` : ''}: ${err.message}`,
      ...(err.db_error ? { db_error: err.db_error } : {}),
      restored: !(back && back._error),
      backup: backup.block,
      _hint: `${err.hint} ${back && back._error ? 'Restoring the previous version FAILED — restore it from the backup with manage_backups.' : 'The view was put back exactly as it was.'}`,
    };
  }
  return {
    success: true,
    action: 'update',
    id, name: next.name, type: next.type,
    changed: changing,
    variables: pre.variables,
    test: sqlViewTestSummary(run, access, 5),
    data_access: sqlViewDataReaders(next.sharing).text,
    plugin_read: sqlViewPluginRead(id, pre.variables),
    backup: backup.block,
  };
}

async function deleteSqlView(args) {
  const id = String(args.id || '').trim();
  if (!id) return { _error: 'delete needs id.' };
  const gate = requireWriteAuth('manage_sql_views', 'delete', { id });
  if (gate) return gate;
  const exists = await verifyTargetExists('sqlViews', id, 'manage_sql_views', 'delete', 'id,displayName');
  if (!exists.exists) return exists.refusal;
  const backup = await ensureBackupOrBail(
    { operation: 'delete_sql_view', tool: 'manage_sql_views', action: 'delete', user_text: lastUserText },
    [{ object_type: 'sqlViews', object_id: id, role: 'primary' }], args);
  if (!backup.ok) return backup.error;
  const r = await safeDhis2Fetch(`sqlViews/${id}`, { method: 'DELETE' });
  if (r && r._error) return { _error: `Delete failed: ${r._error}`, backup: backup.block };
  return { success: true, action: 'delete', id, name: exists.data && exists.data.displayName, backup: backup.block, _note: 'A plugin or app that reads this view now shows "not found" — check none still uses it.' };
}

async function runSqlView(args) {
  const id = String(args.id || '').trim();
  if (!id) return { _error: 'run needs id.' };
  const v = await getSqlViewDef(id, 'id,displayName,type,sqlQuery');
  if (!v || v._error) return { _error: `SQL view ${id}: ${v && v._error}` };
  const variables = args.variables && typeof args.variables === 'object' ? args.variables : {};
  const needed = sqlViewVariables(v.sqlQuery);
  const missing = needed.filter((n) => variables[n] == null || variables[n] === '');
  const badVals = Object.entries(variables).filter(([, val]) => !SQL_VIEW_VAR_VALUE_RE.test(String(val)));
  if (missing.length || badVals.length) {
    return {
      _error: missing.length
        ? `The view needs a value for ${missing.map((n) => `\${${n}}`).join(', ')} — pass variables {"${missing[0]}": "…"}.`
        : `Variable value${badVals.length > 1 ? 's' : ''} ${badVals.map(([k, val]) => `${k}="${val}"`).join(', ')} not accepted by DHIS2: letters, digits, spaces, "_" and "-" only.`,
      variables_needed: needed,
    };
  }
  const access = sqlViewRowsAllowed(v.type, v.sqlQuery);
  const pageSize = access.allowed ? Math.min(100, Math.max(1, Number(args.page_size) || 20)) : 1;
  const page = access.allowed ? Math.max(1, Number(args.page) || 1) : 1;
  const run = await runSqlViewOnce(id, v.type, variables, page, pageSize);
  if (run._error) {
    const err = sqlViewDbError(run._resp, access.metadataOnly);
    return { _error: `The view failed when DHIS2 ran it${err.code ? ` (${err.code})` : ''}: ${err.message}`, ...(err.db_error ? { db_error: err.db_error } : {}), _hint: err.hint };
  }
  const out = { id, name: v.displayName, columns: run.columns, row_count: run.row_count };
  if (access.allowed) {
    out.page = page;
    out.rows = run.rows;
    if (run.row_count > page * pageSize) out._more = `Showing ${run.rows.length} of ${run.row_count} rows — pass page=${page + 1} for more.`;
  } else {
    out.rows_withheld = `Not metadata-only (${access.reason}): on a cloud model you get the column names and the row count, never the rows.`;
  }
  return out;
}

async function executeManageSqlViews(args) {
  const action = String((args && args.action) || 'list');
  if (!SQL_VIEW_ACTIONS.includes(action)) return { _error: `Unknown manage_sql_views action "${action}".`, _hint: `One of: ${SQL_VIEW_ACTIONS.join(', ')}.` };
  if (action === 'list') return await listSqlViews(args);
  if (action === 'get') return await getSqlView(args);
  if (action === 'describe') return await describeSqlTables(args);
  if (action === 'create') return await createSqlView(args);
  if (action === 'update') return await updateSqlView(args);
  if (action === 'delete') return await deleteSqlView(args);
  return await runSqlView(args);
}
