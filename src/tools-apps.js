// ── manage_custom_app: AI-built DHIS2 apps & dashboard plugins ──────────────
//
// The model writes JSX; this module validates it, packages it with the prebuilt
// runtime kit (libs/d2-kit — React 18 + @dhis2/ui + @dhis2/app-runtime +
// post-robot as browser globals) and installs the zip on the user's DHIS2
// server. No Node, CLI or build server is involved: Sucrase (libs/sucrase.min.js)
// compiles the JSX and fflate (libs/fflate.min.js) zips, both inside the worker.
//
// Every server behaviour below was verified on DHIS2 2.42.5.1 (localhost:8081,
// 2026-10-21) before it was encoded here:
//
//   • POST /api/apps (multipart, field `file`) → 201 with the app JSON. The
//     server only needs a zip with manifest.webapp — no App Platform tooling.
//   • The app's storage FOLDER is derived from the uploaded FILENAME
//     (apps/<filename-without-.zip>), not from the key. Two apps uploaded as
//     "app.zip" overwrite each other's files, and deleting one deletes the
//     other. Every upload is therefore named <key>.zip, and a key whose folder
//     another app already uses is refused.
//   • activities.dhis.namespace reserves a dataStore namespace; installing a
//     second app that declares the same one → 409 "Namespace defined in
//     manifest is already in use". Checked before uploading.
//   • manifest `developer` round-trips into GET /api/apps, so the assistant's
//     marker (developer.company) identifies its apps from the listing alone —
//     no probe request that would 404 for an app it did not build.
//   • App files are served only UNVERSIONED (/api/apps/<key>/<file>);
//     /api/42/apps/<key>/<file> is 404. /api/apps/<key>/index.html 302s to
//     the v42 Global Shell (/apps/<key>) unless ?redirect=false.
//   • DELETE /api/apps/<key> → 204 (404 "App does not exist" when missing);
//     ?deleteAppData=true also drops the app's dataStore namespace.
//   • GET /api/metadata?fields=id&filter=id:in:[…] returns only the ids that
//     exist (grouped by type, HTTP 200) — the no-404 way to verify the UIDs a
//     generated app hard-codes.
//   • GET /api/dataStore/<ns>?fields=.&filter=_:eq:<key> answers 200 with
//     entries:[] even when the namespace or key does not exist — the manual
//     teaches generated plugins to read their settings this way (a plain GET of
//     a missing key is a 404 in the browser console on every first load).

const CUSTOM_APP_PREFIX = 'ai-';
const CUSTOM_APP_MARKER = 'dhis2-ai-assistant';
const CUSTOM_APP_DEVELOPER = Object.freeze({ name: 'DHIS2 AI Assistant', company: CUSTOM_APP_MARKER });
const CUSTOM_APP_KEY_MAX = 40;
const CUSTOM_APP_BACKUPS_KEPT = 5;
const CUSTOM_APP_KIT_DIR = 'libs/d2-kit/';
// Load order inside the page: shared.js (top-level declarations become globals
// the other two can use) → app.js / plugin.js (each wrapped in its own IIFE, so
// re-declaring a shared name there shadows instead of throwing).
const CUSTOM_APP_SOURCE_NAMES = ['shared.jsx', 'app.jsx', 'plugin.jsx'];
const CUSTOM_APP_KINDS = new Set(['app', 'plugin', 'app_and_plugin']);
const CUSTOM_APP_PLUGIN_TYPES = new Set(['DASHBOARD', 'CAPTURE']);
const CUSTOM_APP_MAX_FILE_CHARS = 200 * 1024;
// @dhis2/ui Pagination's default page-size menu (read from libs/d2-kit, 2026-10-23).
const CUSTOM_APP_PAGE_SIZES = ['5', '10', '20', '30', '40', '50', '75', '100'];
const CUSTOM_APP_ACTIONS = ['list', 'get_source', 'preview', 'create', 'update', 'delete', 'rollback', 'place', 'unplace', 'placements'];
const CUSTOM_APP_KIT_GLOBALS = new Set([
  'React', 'ReactDOMClient', 'D2UI', 'D2Runtime', 'postRobot', 'echarts', 'D2_APP_CONFIG',
]);
// React 18 + react-dom/client public exports (CJS packages, so the kit build
// cannot read them from esbuild's metafile; these never change within 18.x).
const CUSTOM_APP_REACT_EXPORTS = new Set([
  'Children', 'Component', 'Fragment', 'Profiler', 'PureComponent', 'StrictMode', 'Suspense',
  'cloneElement', 'createContext', 'createElement', 'createFactory', 'createRef', 'forwardRef',
  'isValidElement', 'lazy', 'memo', 'startTransition', 'useCallback', 'useContext', 'useDebugValue',
  'useDeferredValue', 'useEffect', 'useId', 'useImperativeHandle', 'useInsertionEffect',
  'useLayoutEffect', 'useMemo', 'useReducer', 'useRef', 'useState', 'useSyncExternalStore',
  'useTransition', 'version',
]);
const CUSTOM_APP_REACT_DOM_CLIENT_EXPORTS = new Set(['createRoot', 'hydrateRoot']);

// ── Keys ────────────────────────────────────────────────────────────────────

function customAppKeyProblem(key) {
  const k = String(key || '');
  if (!k.startsWith(CUSTOM_APP_PREFIX)) return `key "${k}" must start with "${CUSTOM_APP_PREFIX}" — the assistant only installs apps under its own prefix so it can never overwrite a real app`;
  if (k.length > CUSTOM_APP_KEY_MAX) return `key "${k}" is ${k.length} characters (max ${CUSTOM_APP_KEY_MAX})`;
  if (!/^ai-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(k)) return `key "${k}" may contain only lower-case letters, digits and single hyphens`;
  return null;
}

// Deterministic short hash so a retried call with the same (non-Latin) name
// gets the same key instead of a new one each time.
function customAppShortHash(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36).slice(0, 6);
}

function slugifyCustomAppKey(name) {
  let s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.startsWith(CUSTOM_APP_PREFIX)) s = s.slice(CUSTOM_APP_PREFIX.length);
  if (!s) s = `app-${customAppShortHash(name)}`;
  return (CUSTOM_APP_PREFIX + s).slice(0, CUSTOM_APP_KEY_MAX).replace(/-+$/, '');
}

function resolveCustomAppKey(args) {
  if (args.key != null && String(args.key).trim()) {
    const key = String(args.key).trim();
    const problem = customAppKeyProblem(key);
    if (problem) {
      return {
        _error: `Invalid app key: ${problem}.`,
        _hint: `Use a key like "${slugifyCustomAppKey(args.name || key)}", or omit "key" and it is derived from the name.`,
      };
    }
    return { key };
  }
  if (!args.name) return { _error: 'Pass "name" (display name) or "key".', _hint: 'e.g. name:"ANC coverage widget" → key "ai-anc-coverage-widget".' };
  return { key: slugifyCustomAppKey(args.name) };
}

function bumpCustomAppVersion(version, part) {
  const m = String(version || '1.0.0').match(/^(\d+)\.(\d+)\.(\d+)/);
  const [maj, min, pat] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [1, 0, 0];
  if (part === 'major') return `${maj + 1}.0.0`;
  if (part === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

// ── Runtime kit (shipped with the extension, read at package time) ──────────

let _customAppKitPromise = null;

async function fetchExtensionAsset(rel, asText) {
  const resp = await fetch(chrome.runtime.getURL(rel));
  if (!resp.ok) throw new Error(`extension file ${rel}: HTTP ${resp.status}`);
  return asText ? resp.text() : new Uint8Array(await resp.arrayBuffer());
}

// { meta, files: { 'd2-kit.min.js': Uint8Array, 'd2-kit.css': …, 'fonts/…': … } }
function loadCustomAppKit() {
  if (!_customAppKitPromise) {
    _customAppKitPromise = (async () => {
      const meta = JSON.parse(await fetchExtensionAsset(`${CUSTOM_APP_KIT_DIR}KIT_VERSION.json`, true));
      const files = {};
      await Promise.all(Object.keys(meta.files || {}).map(async (rel) => {
        files[rel] = await fetchExtensionAsset(CUSTOM_APP_KIT_DIR + rel, false);
      }));
      if (!files['d2-kit.min.js'] || !files['d2-kit.css']) throw new Error('runtime kit is incomplete (d2-kit.min.js / d2-kit.css missing)');
      return { meta, files };
    })().catch((e) => { _customAppKitPromise = null; throw e; });
  }
  return _customAppKitPromise;
}

let _customAppEchartsPromise = null;
function loadCustomAppEcharts() {
  if (!_customAppEchartsPromise) {
    _customAppEchartsPromise = fetchExtensionAsset('libs/echarts.min.js', false)
      .catch((e) => { _customAppEchartsPromise = null; throw e; });
  }
  return _customAppEchartsPromise;
}

// ── Source analysis ─────────────────────────────────────────────────────────

// Two views of compiled JS, both with line structure preserved (so a match
// index maps to the author's line — Sucrase keeps line numbers):
//   code — comments blanked, strings intact (URL / method / <script checks)
//   bare — comments AND string contents blanked (identifier checks, so the UI
//          text "data saved locally" can never trip a rule)
function customAppSourceViews(js) {
  let code = '';
  let bare = '';
  const s = String(js);
  const n = s.length;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  let i = 0;
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && s[i] !== '\n') { code += ' '; bare += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      code += '  '; bare += '  '; i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { code += blank(s[i]); bare += blank(s[i]); i++; }
      if (i < n) { code += '  '; bare += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      code += c; bare += c; i++;
      while (i < n && s[i] !== c) {
        if (s[i] === '\\' && i + 1 < n) { code += s[i] + s[i + 1]; bare += '  '; i += 2; continue; }
        code += s[i]; bare += blank(s[i]); i++;
      }
      if (i < n) { code += s[i]; bare += s[i]; i++; }
      continue;
    }
    code += c; bare += c; i++;
  }
  return { code, bare };
}

function lineAt(text, index) {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

function customAppCodeFrame(source, line, column) {
  const lines = String(source).split('\n');
  const from = Math.max(1, line - 2);
  const to = Math.min(lines.length, line + 2);
  const out = [];
  for (let l = from; l <= to; l++) {
    out.push(`${l === line ? '>' : ' '} ${String(l).padStart(4)} | ${lines[l - 1]}`);
    if (l === line && column != null) out.push(`       | ${' '.repeat(Math.max(0, column))}^`);
  }
  return out.join('\n');
}

// Sucrase reports a mismatched JSX closing tag at the position it backtracked
// to (an arrow function's "=>", "expected ;" on line 1) — useless to a model
// fixing its code. When compilation fails, this walks the source with a small
// JS / JSX-children state machine and names the first tag or bracket mismatch
// exactly (a crossed/unclosed tag, or a ")" missing before "}").
// In JSX children every "<" is a tag; in JS (and inside {…}) a "<" only opens a
// tag where an expression can start, so `i<n` comparisons are never tags.
function findJsxTagMismatch(source, opts = {}) {
  const s = String(source);
  const n = s.length;
  const lineCol = (i) => { const before = s.slice(0, i); return { line: before.split('\n').length, column: i - before.lastIndexOf('\n') }; };
  const modes = [{ mode: 'js', parens: [] }];
  const top = () => modes[modes.length - 1];
  let lastSig = '';
  const exprStart = () => !lastSig || /(?:[(={,:?[>&|!;]|\breturn)$/.test(lastSig);
  const skipString = (i) => {
    const q = s[i];
    for (i += 1; i < n; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === q) return i + 1;
    }
    return n;
  };
  // Parse a tag starting at `<`; returns { end, name, closing, selfClosing } or null.
  const readTag = (i) => {
    const closing = s[i + 1] === '/';
    let j = i + (closing ? 2 : 1);
    const nm = /^[A-Za-z][\w.:-]*/.exec(s.slice(j, j + 80));
    const name = nm ? nm[0] : '';
    j += name.length;
    let depth = 0;
    for (; j < n; j++) {
      const c = s[j];
      if (c === '"' || c === "'" || (c === '`' && depth > 0)) { j = skipString(j) - 1; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth <= 0) return { end: j + 1, name, closing, selfClosing: s[j - 1] === '/' };
    }
    return null;
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    const m = top();
    if (m.mode === 'js') {
      if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); i = e < 0 ? n : e; continue; }
      if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === '"' || c === "'" || c === '`') { i = skipString(i); lastSig = 'x'; continue; }
      if (c === '(' || c === '[') { m.parens.push({ ch: c, at: i }); lastSig = c; i++; continue; }
      if (c === ')' || c === ']') {
        const open = m.parens.pop();
        const want = open ? (open.ch === '(' ? ')' : ']') : null;
        if (want !== c && !opts.tagsOnly) {
          return open
            ? { ...lineCol(i), message: `"${c}" found where "${want}" was expected — the "${open.ch}" opened on line ${lineCol(open.at).line} is not closed` }
            : { ...lineCol(i), message: `"${c}" has no matching opening bracket` };
        }
        lastSig = c; i++; continue;
      }
      if (c === '{') { modes.push({ mode: 'js', brace: true, parens: [] }); lastSig = '{'; i++; continue; }
      if (c === '}') {
        if (m.parens.length && !opts.tagsOnly) {
          const open = m.parens[m.parens.length - 1];
          return { ...lineCol(i), message: `"}" found where "${open.ch === '(' ? ')' : ']'}" was expected — the "${open.ch}" opened on line ${lineCol(open.at).line} is not closed` };
        }
        if (m.brace) modes.pop();
        lastSig = '}'; i++; continue;
      }
      if (c === '<' && /[A-Za-z>]/.test(s[i + 1] || '') && exprStart()) {
        const t = readTag(i);
        if (!t) return { ...lineCol(i), message: `<${s.slice(i + 1, i + 20).split(/[\s>/]/)[0]}> is never closed with ">"` };
        if (!t.selfClosing) modes.push({ mode: 'children', name: t.name, line: lineCol(i).line });
        lastSig = 'x';
        i = t.end;
        continue;
      }
      if (!/\s/.test(c)) lastSig = (lastSig + c).slice(-8);
      i++;
      continue;
    }
    // JSX children: text, {expressions} and tags.
    if (c === '{') { modes.push({ mode: 'js', brace: true, parens: [] }); lastSig = '{'; i++; continue; }
    if (c === '<') {
      const t = readTag(i);
      if (!t) return { ...lineCol(i), message: `a tag starting here is never closed with ">"` };
      if (t.closing) {
        if (t.name !== m.name) {
          return { ...lineCol(i), message: `</${t.name}> found where </${m.name}> was expected — <${m.name}> opened on line ${m.line} is not closed (or the tags are crossed)` };
        }
        modes.pop();
        lastSig = 'x';
      } else if (!t.selfClosing) {
        modes.push({ mode: 'children', name: t.name, line: lineCol(i).line });
      }
      i = t.end;
      continue;
    }
    i++;
  }
  const open = modes.filter((x) => x.mode === 'children').pop();
  return open ? { line: open.line, column: 1, message: `<${open.name}> opened on line ${open.line} is never closed` } : null;
}

// Compile one JSX file. Production JSX (React.createElement, React is a kit
// global); ES syntax is left as-is (disableESTransforms) — every browser DHIS2
// supports runs it natively, and transpiling optional chaining would inject
// helper functions on line 1 and shift the error line numbers.
function compileCustomAppFile(file, source) {
  if (typeof sucrase === 'undefined' || !sucrase.transform) {
    return { error: { file, message: 'The JSX compiler (libs/sucrase.min.js) is not loaded in this worker.' } };
  }
  try {
    const out = sucrase.transform(String(source), {
      transforms: ['jsx'], production: true, disableESTransforms: true,
      jsxPragma: 'React.createElement', jsxFragmentPragma: 'React.Fragment',
    });
    // Sucrase does NOT check that a closing tag matches its opening tag:
    // <h1>…</h2> compiles silently into a different page than the one written
    // (verified 2026-10-21). Run the tag walker on success too — tags only, so
    // an unusual bracket in a regex literal can never block valid code.
    const tag = findJsxTagMismatch(source, { tagsOnly: true });
    if (tag) {
      return {
        error: {
          file, line: tag.line, column: tag.column,
          message: `${tag.message} — the JSX compiler accepts this but would build a different page than the one written`,
          frame: customAppCodeFrame(source, tag.line, Math.max(0, tag.column - 1)),
        },
      };
    }
    return { code: out.code };
  } catch (e) {
    let loc = e && e.loc ? e.loc : null;
    let msg = String((e && e.message) || e).replace(/\s*\(\d+:\d+\)\s*$/, '');
    const tag = findJsxTagMismatch(source);
    if (tag) {
      msg = `${tag.message} (the compiler said: ${msg})`;
      loc = { line: tag.line, column: Math.max(0, tag.column - 1) };
    }
    return {
      error: {
        file,
        line: loc ? loc.line : null,
        column: loc ? loc.column + 1 : null,
        message: msg,
        frame: loc ? customAppCodeFrame(source, loc.line, loc.column) : undefined,
      },
    };
  }
}

const CUSTOM_APP_SAFETY_RULES = [
  { id: 'eval', view: 'bare', re: /\beval\s*\(/g, message: 'eval() runs arbitrary strings as code' },
  { id: 'new-function', view: 'bare', re: /\bnew\s+Function\s*\(|(?<![.\w$])Function\s*\(/g, message: 'new Function() runs arbitrary strings as code' },
  { id: 'string-timer', view: 'code', re: /\bset(?:Timeout|Interval)\s*\(\s*['"`]/g, message: 'setTimeout/setInterval with a string argument is eval' },
  { id: 'cookie', view: 'bare', re: /\bdocument\s*\.\s*cookie\b/g, message: 'document.cookie exposes the DHIS2 session' },
  { id: 'browser-storage', view: 'bare', re: /\b(?:localStorage|sessionStorage|indexedDB)\b/g, message: 'browser storage is shared by every DHIS2 app on this origin — store data in the app\'s dataStore namespace (D2_APP_CONFIG.namespace) or userDataStore instead' },
  { id: 'script-tag', view: 'code', re: /<\s*script\b|createElement\s*\(\s*['"`]script['"`]|\bimportScripts\s*\(/gi, message: 'loading or injecting <script> elements is not allowed' },
  { id: 'html-injection', view: 'bare', re: /\bdangerouslySetInnerHTML\b|\.\s*(?:innerHTML|outerHTML)\s*=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\s*\.\s*write(?:ln)?\s*\(/g, message: 'raw HTML injection lets server data run as code (XSS) — render text with JSX' },
  { id: 'import', view: 'bare', re: /^\s*import\b\s*(?:[\w*{'"`]|\()|\bimport\s*\(/gm, message: 'import statements are not supported — use the kit globals (React, D2UI, D2Runtime, …)' },
  { id: 'export', view: 'bare', re: /^\s*export\s+/gm, message: 'export statements are not supported in generated apps' },
  { id: 'require', view: 'bare', re: /\brequire\s*\(/g, message: 'require() is not available — use the kit globals' },
  { id: 'socket', view: 'bare', re: /\bnew\s+(?:WebSocket|EventSource)\s*\(|\bnavigator\s*\.\s*sendBeacon\s*\(/g, message: 'WebSocket / EventSource / sendBeacon can send data off the DHIS2 server' },
];

// Mutation patterns refused unless needs_write_access:true.
const CUSTOM_APP_WRITE_RULES = [
  { id: 'use-data-mutation', view: 'bare', re: /\b(?:useDataMutation|DataMutation)\b|\.\s*mutate\s*\(/g, message: 'data mutation (useDataMutation / engine.mutate)' },
  { id: 'mutation-type', view: 'code', re: /\btype\s*:\s*['"`](?:create|update|replace|delete|json-patch)['"`]/g, message: 'mutation type create/update/replace/delete' },
  { id: 'http-write', view: 'code', re: /\bmethod\s*:\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]|\.\s*open\s*\(\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]/gi, message: 'HTTP POST/PUT/PATCH/DELETE request' },
];

function customAppOrigin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// Static safety scan over the COMPILED code of every file (JSX text and
// attributes are string literals there, so a `<script` in markup is caught).
function scanCustomAppCode(compiled, opts = {}) {
  const violations = [];
  const allowedOrigin = opts.allowedOrigin ? customAppOrigin(opts.allowedOrigin) : null;
  for (const [file, js] of Object.entries(compiled)) {
    const views = customAppSourceViews(js);
    const push = (rule, index, matchText, message) => {
      violations.push({
        file, line: lineAt(views.code, index), rule,
        match: String(matchText).trim().slice(0, 80), message,
      });
    };
    for (const r of CUSTOM_APP_SAFETY_RULES) {
      const re = new RegExp(r.re.source, r.re.flags);
      for (const m of views[r.view].matchAll(re)) push(r.id, m.index, m[0], r.message);
    }
    // Network calls to an absolute URL on another origin.
    const netRe = /\bfetch\s*\(\s*(['"`])((?:https?:)?\/\/[^'"`\s]+)|\.\s*open\s*\(\s*['"`]\w+['"`]\s*,\s*(['"`])((?:https?:)?\/\/[^'"`\s]+)/g;
    for (const m of views.code.matchAll(netRe)) {
      const url = m[2] || m[4];
      const abs = url.startsWith('//') ? `https:${url}` : url;
      const origin = customAppOrigin(abs);
      if (!allowedOrigin || origin !== allowedOrigin) {
        push('external-request', m.index, m[0], `request to ${origin || url} — generated apps may only call the DHIS2 server they are installed on (use relative API paths through DataProvider)`);
      }
    }
    if (!opts.needsWriteAccess) {
      for (const r of CUSTOM_APP_WRITE_RULES) {
        const re = new RegExp(r.re.source, r.re.flags);
        for (const m of views[r.view].matchAll(re)) {
          push(`write:${r.id}`, m.index, m[0], `${r.message} — the app was declared read-only (needs_write_access:false)`);
        }
      }
    }
  }
  return violations;
}

const CUSTOM_APP_HOOK_NAMES = [...CUSTOM_APP_REACT_EXPORTS].filter((n) => /^use[A-Z]/.test(n));

function customAppDeclares(bare, name) {
  const n = name.replace(/\$/g, '\\$');
  return new RegExp(`\\b(?:const|let|var|function|class)\\s+${n}\\b`).test(bare)
    || new RegExp(`\\{[^{}]*(?<![\\w$.])${n}\\b[^{}]*\\}\\s*(?:=|\\)|,)`).test(bare)        // destructuring / destructured params
    || new RegExp(`\\(\\s*(?:[\\w$]+\\s*,\\s*)*${n}\\s*(?:,\\s*[\\w$]+\\s*)*\\)\\s*=>`).test(bare) // (a, Name) =>
    || new RegExp(`\\bfunction\\s*[\\w$]*\\s*\\([^)]*\\b${n}\\b`).test(bare)               // function f(Name)
    || new RegExp(`(?<![\\w$.])${n}\\s*=>`).test(bare);                                     // Name =>
}

// Static checks that catch the runtime errors a generated app would otherwise
// only show as a blank page: undeclared components / hooks, names the kit does
// not export, a missing DataProvider / render root / plugin handshake.
function lintCustomAppCode(compiled, kind, kitMeta, pluginType) {
  const errors = [];
  const warnings = [];
  const ui = new Set((kitMeta && kitMeta.exports && kitMeta.exports.D2UI) || []);
  const rt = new Set((kitMeta && kitMeta.exports && kitMeta.exports.D2Runtime) || []);
  const exportsOf = { D2UI: ui, D2Runtime: rt, React: CUSTOM_APP_REACT_EXPORTS, ReactDOMClient: CUSTOM_APP_REACT_DOM_CLIENT_EXPORTS };
  const views = {};
  for (const [f, js] of Object.entries(compiled)) views[f] = customAppSourceViews(js);
  const sharedBare = views['shared.jsx'] ? views['shared.jsx'].bare : '';
  const allBare = Object.values(views).map((v) => v.bare).join('\n');
  const allCode = Object.values(views).map((v) => v.code).join('\n');

  for (const [file, v] of Object.entries(views)) {
    const scope = file === 'shared.jsx' ? v.bare : `${sharedBare}\n${v.bare}`;
    // 1. Names destructured from / accessed on a kit global must exist.
    for (const m of v.bare.matchAll(/\{([^{}]*)\}\s*=\s*(D2UI|D2Runtime|React|ReactDOMClient)\b(?!\s*\.)/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().replace(/^\.\.\..*$/, '').split(/[:=]/)[0].trim();
        if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        if (exportsOf[m[2]].size && !exportsOf[m[2]].has(name)) {
          const alt = m[2] === 'D2UI' && rt.has(name) ? ' (it is in D2Runtime)' : m[2] === 'D2Runtime' && ui.has(name) ? ' (it is in D2UI)' : '';
          errors.push({ file, line: lineAt(v.bare, m.index), message: `${m[2]} has no export "${name}"${alt} — it would be undefined at runtime.` });
        }
      }
    }
    for (const m of v.bare.matchAll(/(?<![\w$.])(D2UI|D2Runtime|React|ReactDOMClient)\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      if (exportsOf[m[1]].size && !exportsOf[m[1]].has(m[2])) {
        errors.push({ file, line: lineAt(v.bare, m.index), message: `${m[1]}.${m[2]} does not exist in the runtime kit.` });
      }
    }
    // 2. Every component used in JSX must be declared (compiled JSX:
    //    React.createElement(Name, …)).
    const seen = new Set();
    for (const m of v.bare.matchAll(/React\.createElement\(\s*([A-Z][\w$]*)\b(?!\s*\.)/g)) {
      const name = m[1];
      if (seen.has(name) || CUSTOM_APP_KIT_GLOBALS.has(name)) continue;
      seen.add(name);
      if (!customAppDeclares(scope, name)) {
        const fix = ui.has(name) ? ` Add: const { ${name} } = D2UI;` : ' Define the component (or destructure it from D2UI) before using it.';
        errors.push({ file, line: lineAt(v.bare, m.index), message: `<${name}> is used but never declared — "${name} is not defined" at runtime.${fix}` });
      }
    }
    // 3. Hooks / runtime helpers called bare must be declared.
    for (const name of [...CUSTOM_APP_HOOK_NAMES, ...[...rt].filter((n) => /^use[A-Z]/.test(n))]) {
      const re = new RegExp(`(?<![\\w$.])${name}\\s*\\(`);
      const hit = v.bare.match(re);
      if (hit && !customAppDeclares(scope, name)) {
        const src = CUSTOM_APP_REACT_EXPORTS.has(name) ? 'React' : 'D2Runtime';
        errors.push({ file, line: lineAt(v.bare, hit.index), message: `${name}() is called but never declared. Add: const { ${name} } = ${src};` });
      }
    }
    // 4. The app runtime keeps the FIRST query/mutation object it is given
    //    (useStaticInput): an inline object built from props silently keeps
    //    returning the old data when the props change.
    for (const m of v.bare.matchAll(/\b(useDataQuery|useDataMutation)\s*\(\s*\{/g)) {
      errors.push({ file, line: lineAt(v.bare, m.index), message: `${m[1]}({…}) with an inline object: the runtime keeps the first object it sees, so later changes are ignored. Define the query once at module level and pass changing values as variables (params: ({ ou, pe }) => ({…}), useDataQuery(Q, { variables: { ou, pe } })).` });
    }
    if (/\bHeaderBar\b/.test(v.bare)) {
      errors.push({ file, message: 'Do not render a HeaderBar: the DHIS2 Global Shell (v42+) draws the header around every app, so it would appear twice.' });
    }
  }

  // A Modal that is always rendered covers the page with its backdrop and
  // blocks every click (a model-written notes app shipped exactly that,
  // 2026-10-22). Render it behind a condition, or pass hide.
  for (const [file, v] of Object.entries(views)) {
    for (const m of v.bare.matchAll(/React\.createElement\(\s*Modal\s*,/g)) {
      const before = v.bare.slice(Math.max(0, m.index - 120), m.index).replace(/[\s(]+$/, '');
      if (/(?:&&|\|\||\?|:|return|=>)$/.test(before)) continue; // conditional, or a component's own root
      const props = v.code.slice(m.index + m[0].length, m.index + m[0].length + 300);
      if (/^\s*\{[^}]*\bhide\b/.test(props)) continue;
      errors.push({ file, line: lineAt(v.bare, m.index), message: 'A <Modal> is rendered unconditionally, so it is always open and its backdrop blocks every click in the app. Render it only when needed — {target && <Modal …>} — or pass hide={!open}.' });
    }
  }

  // <Pagination> draws a page-size menu of 5, 10, 20, 30, 40, 50, 75, 100 (this
  // kit's @dhis2/ui). Any other pageSize logs "There is no option with the
  // value: "25"" on every render — the model-written transfer-history plugin
  // did exactly that (live 2026-10-23, deepseek-v4p1-flash), as did the failed
  // thread's v1.1. A listed size, pageSizes, or hidePageSizeSelect fixes it.
  for (const [file, v] of Object.entries(views)) {
    for (const m of v.bare.matchAll(/React\.createElement\(\s*Pagination\s*,\s*\{/g)) {
      const start = m.index + m[0].length - 1;
      let depth = 0;
      let end = start;
      for (; end < v.bare.length; end++) {
        if (v.bare[end] === '{') depth++;
        else if (v.bare[end] === '}' && --depth === 0) break;
      }
      const props = v.code.slice(start, end + 1);
      if (/\bpageSizes\s*:/.test(props) || /\bhidePageSizeSelect\s*:\s*(?!false\b)/.test(props)) continue;
      const pm = /\bpageSize\s*:\s*([A-Za-z_$][\w$]*|\d+)/.exec(props);
      if (!pm) continue;
      let size = pm[1];
      if (!/^\d+$/.test(size)) {
        const c = new RegExp(`\\b(?:const|let|var)\\s+${size}\\s*=\\s*(\\d+)\\b`).exec(allCode)
          || new RegExp(`\\[\\s*${size}\\s*,[^\\]]*\\]\\s*=\\s*(?:React\\.)?useState\\(\\s*(\\d+)\\s*\\)`).exec(allCode);
        if (!c) continue;
        size = c[1];
      }
      if (!CUSTOM_APP_PAGE_SIZES.includes(size)) {
        errors.push({ file, line: lineAt(v.bare, m.index), message: `<Pagination pageSize={${size}}>: its page-size menu offers only ${CUSTOM_APP_PAGE_SIZES.join(', ')}, so every render logs "There is no option with the value: "${size}"". Use one of those sizes (in the query's pageSize too), pass hidePageSizeSelect when users cannot change it, or pass pageSizes that include "${size}".` });
      }
    }
  }

  // Mutation shapes app-runtime refuses at runtime ("Invalid query", nothing
  // is sent): type 'delete' with data, type 'create' with id. A model-written
  // notes app deleted its last note with { type: last ? 'delete' : 'update',
  // data } — that delete always failed (2026-10-22).
  for (const [file, v] of Object.entries(views)) {
    for (const m of v.code.matchAll(/\btype\s*:\s*([^,}\n]*)/g)) {
      const del = /['"`]delete['"`]/.test(m[1]);
      const cre = /['"`]create['"`]/.test(m[1]);
      if (!del && !cre) continue;
      let depth = 0;
      let open = -1;
      for (let k = m.index - 1; k >= 0; k--) {
        const ch = v.bare[k];
        if (ch === '}') depth++;
        else if (ch === '{') { if (!depth) { open = k; break; } depth--; }
      }
      if (open === -1) continue;
      let top = '';
      depth = 0;
      for (let k = open + 1; k < v.bare.length; k++) {
        const ch = v.bare[k];
        if ('{[('.includes(ch)) depth++;
        else if ('}])'.includes(ch)) { if (!depth) break; depth--; }
        else if (!depth) top += ch;
      }
      if (!/(?:^|[\s,])resource\s*[:,]/.test(top)) continue; // not a mutation object
      if (del && /(?:^|[\s,])data\s*(?::|,|$)/.test(top)) {
        errors.push({ file, line: lineAt(v.code, m.index), message: 'Mutation type \'delete\' does not support property \'data\' — app-runtime throws "Invalid query" and nothing is sent. Use a separate delete mutation without data (or, for a list kept in one key, update the key with the shorter list).' });
      }
      if (cre && /(?:^|[\s,])id\s*(?::|,|$)/.test(top)) {
        errors.push({ file, line: lineAt(v.code, m.index), message: 'Mutation type \'create\' does not support property \'id\' — app-runtime throws "Invalid query" and nothing is sent. Put the key in resource (\`dataStore/<ns>/<key>\`) instead.' });
      }
    }
  }

  // A read of dataStore/<ns>/<key> is a 404 until the key exists: a failed
  // request on every first visit (a model-written notes app did exactly that,
  // 2026-10-22). Key paths belong in mutation objects (with a type:); reads go
  // through the namespace with filter=_:eq:<key>, which answers 200.
  if (!/_:eq:/.test(allCode)) {
    for (const [file, v] of Object.entries(views)) {
      for (const m of v.code.matchAll(/[`'"]dataStore\/[^`'"\s]*\/[^`'"\s]+[`'"]/g)) {
        const pre = v.code.slice(Math.max(0, m.index - 160), m.index);
        const post = v.code.slice(m.index + m[0].length, m.index + m[0].length + 160);
        const statement = pre.slice(pre.lastIndexOf(';') + 1) + (post.includes(';') ? post.slice(0, post.indexOf(';')) : post);
        if (/\btype\s*:/.test(statement)) continue;
        errors.push({ file, line: lineAt(v.code, m.index), message: `${m[0]} is read directly, which is a 404 until that key exists — every first visit logs a failed request. Read it with { resource: \`dataStore/\${D2_APP_CONFIG.namespace}\`, params: { fields: '.', filter: '_:eq:<key>' } } (HTTP 200, entries [] when nothing is saved; the value is entries[0].value) and write it with engine.mutate({ resource: 'dataStore/<ns>/<key>', type: saved ? 'update' : 'create', data }).` });
        break;
      }
    }
  }

  // Patient data NEVER goes into the dataStore (user rule, 2026-10-25): it has
  // no org-unit scoping, program sharing, ownership or audit, and a namespace
  // nobody reserves is public read-write. A flag plugin kept every patient's
  // flagged values in one dataStore key (live 2026-10-25). A file that can see
  // patient data may READ the dataStore (settings) but never write it.
  for (const [file, v] of Object.entries(views)) {
    if (file === 'shared.jsx' && views['app.jsx'] && views['plugin.jsx']) continue; // judged inside each file's scope
    const scopeCode = file === 'shared.jsx' ? v.code : `${views['shared.jsx'] ? views['shared.jsx'].code : ''}\n${v.code}`;
    const scopeBare = file === 'shared.jsx' ? v.bare : `${sharedBare}\n${v.bare}`;
    const write = customAppDataStoreWrite(scopeCode, scopeBare);
    if (!write) continue;
    const patient = customAppPatientDataSource(scopeCode, file, pluginType);
    if (!patient) continue;
    errors.push({ file, message: `Refused: this code writes the dataStore (${write}) and can see patient data (${patient}). Patient data never goes into the dataStore — it would bypass the program's org-unit access, sharing, ownership and audit, and an unreserved namespace is readable and writable by every user. Keep record data in tracker data: a form-field plugin writes it into a field of the event with setFieldValue (saved with the event); an app writes it with the tracker API (needs_write_access). The dataStore is for settings only, written by code that never reads patient data (e.g. app.jsx of an app_and_plugin, while the Capture plugin only reads those settings).` });
  }

  if (!/\bcreateRoot\s*\(/.test(allBare)) {
    errors.push({ message: 'Nothing is rendered: call ReactDOMClient.createRoot(document.getElementById(\'root\')).render(…) in app.jsx / plugin.jsx.' });
  }
  const usesData = /\b(?:useDataQuery|useDataMutation|useDataEngine|DataQuery|DataMutation)\b/.test(allBare);
  if (usesData && !/\b(?:DataProvider|Provider)\b/.test(allBare)) {
    errors.push({ message: 'useDataQuery / useDataMutation need a data engine: wrap the root in <DataProvider baseUrl={D2_APP_CONFIG.baseUrl} apiVersion={D2_APP_CONFIG.apiVersion}>.' });
  }
  if (kind !== 'app') {
    const pv = views['plugin.jsx'];
    const pluginCode = `${pv ? pv.code : ''}\n${views['shared.jsx'] ? views['shared.jsx'].code : ''}`;
    if (!/getPropsFromParent/.test(pluginCode)) {
      errors.push({ file: 'plugin.jsx', message: 'The plugin never asks the host for its props: call postRobot.send(window.parent, \'getPropsFromParent\') and render with the returned data.' });
    }
    if (!/setPluginHeight/.test(pluginCode)) {
      warnings.push({ file: 'plugin.jsx', message: pluginType === 'CAPTURE'
        ? 'setPluginHeight is never called — Capture sizes the widget to the height the plugin reports, so the content will be cut off. Observe an auto-height wrapper with a ResizeObserver and report its offsetHeight.'
        : 'setPluginHeight is never called — the dashboard item keeps its default height (content may be cut off or leave a gap). Observe the root with a ResizeObserver and report its height.' });
    }
    // The argument of setPluginHeight(…) itself: a wrapper's offsetHeight
    // (anything but #root / a variable named root).
    if (pluginType === 'CAPTURE' && [...pluginCode.matchAll(/setPluginHeight\s*\(([^;\n]*)/g)].some((m) => /\.offsetHeight/.test(m[1]) && !/\broot\b|getElementById/.test(m[1]))) {
      warnings.push({ file: 'plugin.jsx', message: 'Report the height of #root (document.getElementById(\'root\').getBoundingClientRect().height), not a wrapper\'s offsetHeight: a wrapper\'s own margins are not part of offsetHeight, so Capture cuts that much off.' });
    }
    // Two kinds of Capture plugin: an enrollment-page widget (enrollmentId /
    // teiId) or a form-field plugin (values / setFieldValue).
    if (pluginType === 'CAPTURE' && !/\b(?:enrollmentId|teiId)\b/.test(pluginCode) && !/\b(?:values|setFieldValue)\b/.test(pluginCode)) {
      warnings.push({ file: 'plugin.jsx', message: 'This Capture plugin reads neither enrollmentId / teiId (an enrollment-page widget gets { teiId, programId, enrollmentId, orgUnitId }) nor values / setFieldValue (a form-field plugin) — it cannot know which record or form it is in.' });
    }
    // Capture drops a mapped field it does not know (e.g. its cached program
    // predates the data element) and then ignores setFieldValue for that alias
    // with a console-only error — a button that does nothing (live 2026-10-25).
    if (pluginType === 'CAPTURE' && /\bsetFieldValue\b/.test(pluginCode) && !/\bfieldsMetadata\b/.test(pluginCode)) {
      warnings.push({ file: 'plugin.jsx', message: 'The plugin calls setFieldValue but never looks at fieldsMetadata. Capture silently ignores a write to an alias it did not give the plugin (unmapped, or a field its cached program does not have yet) — check fieldsMetadata[alias] first and show a visible message when it is missing, instead of a control that does nothing.' });
    }
  }
  // Conventions from the DHIS2 app-development skill (devotta-labs/dhis2-app-skills):
  // advisory only — they never block an install.
  const METADATA_RESOURCES = /^(?:programs|programStages|dataElements|dataSets|indicators|programIndicators|organisationUnits|organisationUnitGroups|optionSets|options|categoryCombos|categoryOptions|trackedEntityAttributes|trackedEntityTypes|users|userGroups|dashboards|visualizations|maps|eventVisualizations|legendSets|validationRules)$/;
  for (const [file, v] of Object.entries(views)) {
    for (const m of v.code.matchAll(/\bresource\s*:\s*(['"`])([A-Za-z]+)\1/g)) {
      if (!METADATA_RESOURCES.test(m[2])) continue;
      // The query's own text: up to the next resource (or 400 chars).
      const rest = v.code.slice(m.index + m[0].length, m.index + 400);
      const next = rest.search(/\bresource\s*:/);
      if (!/\bfields\b/.test(next === -1 ? rest : rest.slice(0, next))) {
        warnings.push({ file, line: lineAt(v.code, m.index), message: `"${m[2]}" is fetched without a fields parameter — request exactly the properties you render (e.g. fields: 'id,displayName').` });
      }
    }
    for (const m of v.code.matchAll(/\bfields\s*:\s*(['"`])([^'"`]*)\1/g)) {
      if (/(?:^|[,\[])name(?:[,\]]|$)/.test(m[2]) && !/displayName/.test(m[2])) {
        warnings.push({ file, line: lineAt(v.code, m.index), message: `fields "${m[2]}" uses name — show displayName (it is translated to the user's locale).` });
      }
    }
  }
  // @dhis2/ui SingleSelect(Field) / MultiSelect(Field) take <…Option> CHILDREN;
  // an items / options prop is ignored and the dropdown says "No data found"
  // (live 2026-10-28: an app's facility filter never offered a facility).
  for (const [file, v] of Object.entries(views)) {
    for (const m of v.code.matchAll(/createElement\(\s*(SingleSelectField|SingleSelect|MultiSelectField|MultiSelect)\s*,\s*\{([^{}]|\{[^{}]*\})*?\b(items|options)\s*:/g)) {
      errors.push({ file, line: lineAt(v.code, m.index), message: `<${m[1]}> has no "${m[3]}" prop — it is ignored and the dropdown shows "No data found". Render the choices as children: {list.map((x) => <${m[1].startsWith('Multi') ? 'MultiSelectOption' : 'SingleSelectOption'} key={x.id} value={x.id} label={x.name} />)} (values are non-empty strings — use 'ALL' for an "All" choice, not '').` });
    }
  }
  // Tracker lists (2.42): no pager.pageCount without totalPages=true, and
  // orgUnit / trackedEntity / enrollment are UID strings (nested fields are
  // ignored). Live 2026-10-28 an app read pageCount without totalPages (only
  // the first 100 events → two patients missing) and showed "—" for every
  // facility from orgUnit[id,displayName].
  if (/['"`]tracker\//.test(allCode)) {
    if (/\bpageCount\b/.test(allCode) && !/\btotalPages\b/.test(allCode)) {
      errors.push({ message: 'tracker/* lists return no pager.pageCount (or total) unless the request sends totalPages: true — this loop stops after the first page and silently drops records. Add totalPages: true to the tracker params (and loop to pager.pageCount).' });
    }
    const nested = allCode.match(/fields\s*:\s*['"`][^'"`]*\b(orgUnit|trackedEntity|enrollment|program|programStage)\[/);
    if (nested) {
      errors.push({ message: `Tracker records carry ${nested[1]} as a plain UID string — "${nested[1]}[…]" in fields is ignored, so any name read from it is undefined. Request ${nested[1]} and look the names up (organisationUnits with filter id:in:[…], fields id,displayName).` });
    }
  }
  // Tracker timestamps already carry a time part ("2026-01-23T00:00:00.000"):
  // appending 'T00:00:00' to one is Invalid Date — live 2026-10-28 an
  // enrollment widget showed "—" for "days since last visit" and raw
  // timestamps in its table. A DATE data value ("YYYY-MM-DD") may take the
  // suffix, so this fires only when the code reads a timestamp field, appends
  // the suffix, and never trims anything to its first 10 characters.
  if (/\b(?:occurredAt|enrolledAt|scheduledAt|completedAt|createdAt|updatedAt)\b/.test(allCode)
      && /\+\s*['"`]T00:00(?::00)?(?:\.000)?Z?['"`]|\$\{[^}]+\}T00:00/.test(allCode)
      && !/\.(?:slice|substring|substr)\(\s*0\s*,\s*10\s*\)|split\(\s*['"`]T['"`]\s*\)/.test(allCode)) {
    errors.push({ message: 'Tracker timestamps (occurredAt, enrolledAt, scheduledAt, completedAt, createdAt, updatedAt) come back as "2026-01-23T00:00:00.000" — date AND time. Appending \'T00:00:00\' to one gives Invalid Date (a "days since" shows nothing, dates print raw). Take the day first: const day = String(ev.occurredAt).slice(0, 10); then new Date(day + \'T00:00:00\') and display day.' });
  }
  if (/\btype\s*:\s*['"`]delete['"`]/.test(allCode) && !/\bModal\b/.test(allBare)) {
    warnings.push({ message: 'The app deletes data without a confirmation step — ask in a Modal (ModalTitle / ModalContent / ModalActions + ButtonStrip) before every delete.' });
  }
  if (/\/\/localhost[:/]|https?:\/\/\d+\.\d+\.\d+\.\d+/.test(allCode)) {
    warnings.push({ message: 'The code hard-codes a server address — use D2_APP_CONFIG.baseUrl so the app keeps working on any server.' });
  }
  return { errors, warnings };
}

// → a short description of the first dataStore / userDataStore WRITE in the
// code, else null. A write = a mutation object (type create / update / replace
// / json-patch) whose resource names the dataStore — directly, through a
// variable, or by shorthand — or a POST / PUT / PATCH request to it.
function customAppDataStoreWrite(code, bare) {
  const isDs = (expr) => /\b(?:user)?[dD]ataStore\b/.test(expr);
  const varExpr = (name) => {
    const m = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*([^;\\n]+)`).exec(code);
    return m ? m[1] : '';
  };
  for (const m of code.matchAll(/\btype\s*:\s*([^,}\n]*)/g)) {
    if (!/['"`](?:create|update|replace|json-patch)['"`]/.test(m[1])) continue;
    let depth = 0;
    let open = -1;
    for (let k = m.index - 1; k >= 0; k--) {
      const ch = bare[k];
      if (ch === '}') depth++;
      else if (ch === '{') { if (!depth) { open = k; break; } depth--; }
    }
    if (open === -1) continue;
    let close = open + 1;
    for (depth = 0; close < bare.length; close++) {
      const ch = bare[close];
      if ('{[('.includes(ch)) depth++;
      else if ('}])'.includes(ch)) { if (!depth) break; depth--; }
    }
    const obj = code.slice(open, close + 1);
    const r = /(?:^|[{\s,])resource\s*(?::\s*([^,}\n]+))?\s*[,}]/.exec(obj);
    if (!r) continue;
    const expr = (r[1] || 'resource').trim();
    if (isDs(expr) || (/^[A-Za-z_$][\w$]*$/.test(expr) && isDs(varExpr(expr)))) return 'a dataStore mutation';
  }
  if (/\bmethod\s*:\s*['"`](?:POST|PUT|PATCH)['"`]/i.test(code) && /['"`][^'"`]*\b(?:user)?[dD]ataStore\b/.test(code)) return 'a POST / PUT / PATCH request to the dataStore';
  return null;
}

// → why this file can see patient-level data, else null.
function customAppPatientDataSource(code, file, pluginType) {
  if (pluginType === 'CAPTURE' && file !== 'app.jsx') return 'a Capture plugin runs on a patient\'s record — its props carry the record ids and form values';
  const m = /['"`](tracker\/(?:events|trackedEntities|enrollments|relationships)|trackedEntityInstances|programStageInstances|enrollments|events|relationships|analytics\/(?:events|enrollments)\/query|audits\/tracked\w*)(?=['"`/?])/.exec(code);
  if (m) return `it reads ${m[1]}`;
  if (/['"`]sqlViews\//.test(code)) return 'it reads a SQL view (its rows can be patient rows)';
  return null;
}

// UID-shaped string literals the code hard-codes. Word-like camelCase strings
// ("dataElement", "ProgramName") pass the entropy test but are field names.
function extractCustomAppUids(compiled) {
  const out = new Set();
  for (const js of Object.values(compiled)) {
    const { code } = customAppSourceViews(js);
    for (const lit of code.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) || []) {
      for (const tok of lit.match(/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]{10}(?![A-Za-z0-9])/g) || []) {
        if (!isLikelyDhisUid(tok) || RESERVED_UID_SHAPED_WORDS.has(tok)) continue;
        if (/^[A-Za-z][a-z]+(?:[A-Z][a-z]+)+$/.test(tok)) continue; // camelCase words: indicatorId, dataElement
        out.add(tok);
      }
    }
  }
  return [...out];
}

async function checkCustomAppUids(uids) {
  if (!uids.length) return { checked: 0, found: {}, unknown: [] };
  const found = {};
  for (let i = 0; i < uids.length; i += 50) {
    const chunk = uids.slice(i, i + 50);
    const resp = await safeDhis2Fetch(`metadata?fields=id&filter=id:in:[${chunk.join(',')}]`, { noTruncate: true });
    if (resp && resp._error) return { skipped: `could not verify UIDs: ${resp._error}` };
    for (const [type, arr] of Object.entries(resp || {})) {
      if (!Array.isArray(arr)) continue;
      for (const o of arr) if (o && o.id) found[o.id] = type;
    }
  }
  return { checked: uids.length, found, unknown: uids.filter((u) => !found[u]) };
}

// A plugin reading a SQL view fails for its users when nobody has DATA read
// on the view (HTTP 409 E4312 — superusers included: live 2026-10-23, a view
// saved "rw------" made the installed plugin unusable) or when the code does
// not send a variable the SQL uses (409 E4307). found = the UID check's map.
async function checkCustomAppSqlViews(compiled, found) {
  const errors = [];
  const warnings = [];
  const views = [];
  const sv = Object.values(compiled).map((js) => customAppSourceViews(js));
  const code = sv.map((v) => v.code).join('\n');
  if (!/sqlViews/.test(code)) return { errors, warnings, views };
  // Only the CONTENTS of string / template literals (bare blanks them).
  const literals = sv.map((v) => Array.from({ length: v.code.length }, (_, i) => (v.code[i] !== v.bare[i] ? v.code[i] : '\n')).join('')).join('\n');
  const ids = Object.keys(found || {}).filter((id) => found[id] === 'sqlViews');
  if (!ids.length) {
    warnings.push('The code reads sqlViews/… but names no SQL view that exists on this server — create it with manage_sql_views and use the id it returns.');
    return { errors, warnings, views };
  }
  const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const id of ids) {
    const v = await safeDhis2Fetch(`sqlViews/${id}?fields=id,displayName,type,sqlQuery,sharing`, { noTruncate: true });
    if (!v || v._error) continue;
    const readers = sqlViewDataReaders(v.sharing);
    const vars = sqlViewVariables(v.sqlQuery);
    views.push({ id, name: v.displayName, readers: readers.text, variables: vars });
    if (!readers.anyone) {
      errors.push(`SQL view ${id} ("${v.displayName}"): ${readers.text}. Fix it first: manage_sql_views(action="update", id="${id}", sharing={"public":"r-r-----"}) — or share it with the user groups who will use this plugin.`);
    }
    // A variable is sent when "name:" is inside a string or template literal:
    // `startDate:${start}` or 'startDate:' + start (an object key is not enough).
    const missing = vars.filter((n) => !new RegExp(`\\b${reEsc(n)}:`).test(literals));
    if (missing.length) {
      errors.push(`SQL view ${id} uses ${missing.map((n) => `\${${n}}`).join(', ')} but the code never sends ${missing.length > 1 ? 'them' : 'it'}: every request needs var: [\`${missing[0]}:\${…}\`${missing.length > 1 ? ', …' : ''}] or DHIS2 answers 409 E4307.`);
    }
    if (/\bpaging\s*:\s*(?:false|'false'|"false")/.test(code) && !analyzeSqlViewPrivacy(v.sqlQuery).metadataOnly) {
      warnings.push(`SQL view ${id}: the code reads it with paging:false — every load downloads every row it returns. Page on the server (page, pageSize → pager.total) and filter with the view's variables.`);
    }
    if (v.type && v.type !== 'QUERY') warnings.push(`SQL view ${id} is a ${v.type}: its rows are a stored copy, refreshed only when it is executed again. A QUERY view is always current.`);
  }
  return { errors, warnings, views };
}

// API resources the code reads/writes — a plain-language summary for the user.
function customAppApiResources(compiled) {
  const out = new Set();
  for (const js of Object.values(compiled)) {
    const { code } = customAppSourceViews(js);
    for (const m of code.matchAll(/\bresource\s*:\s*(['"`])([^'"`$]+)/g)) out.add(m[2].replace(/\/+$/, ''));
    for (const m of code.matchAll(/\bresource\s*:\s*`([^`]*)`/g)) out.add(m[1].replace(/\$\{[^}]*\}/g, '…'));
  }
  return [...out].slice(0, 30);
}

// The connected server's version as { major, minor, patch, full } — what
// useConfig().serverVersion returns inside an App Platform app, so generated
// code can gate version-specific API use on D2_APP_CONFIG.serverVersion.minor.
// Recorded at install time (an update re-records it).
async function customAppServerVersion() {
  let full = dhis2.systemInfo && dhis2.systemInfo.version;
  if (!full) {
    const info = await safeDhis2Fetch('system/info?fields=version');
    full = info && !info._error ? info.version : null;
  }
  const m = String(full || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0), full: String(full) } : null;
}

// ── Packaging ───────────────────────────────────────────────────────────────

function customAppHasApp(kind) { return kind !== 'plugin'; }
function customAppHasPlugin(kind) { return kind !== 'app'; }

function buildCustomAppManifest(spec) {
  const m = {
    appType: 'APP',
    short_name: spec.key,
    name: spec.name,
    version: spec.version,
    description: spec.description || '',
    default_locale: 'en',
    developer: { ...CUSTOM_APP_DEVELOPER },
  };
  if (customAppHasApp(spec.kind)) m.launch_path = 'index.html';
  if (customAppHasPlugin(spec.kind)) {
    m.plugin_launch_path = 'plugin.html';
    m.plugin_type = spec.pluginType;
  }
  m.activities = { dhis: { href: '*' } };
  if (spec.namespace) m.activities.dhis.namespace = spec.namespace;
  return m;
}

function escapeCustomAppHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Capture sizes a plugin's frame to the height the plugin reports. #root as
// its own block formatting context keeps every child margin inside its height,
// so measuring #root is exact — a model-written plugin measured a wrapper that
// had margin: 4px 0 and lost those pixels (frame 88 px, content 92 px).
const CAPTURE_PLUGIN_CSS = '#root { display: flow-root; }\n';

function buildCustomAppHtml(spec, entryJs) {
  const scripts = ['d2-kit.min.js', 'app-config.js'];
  if (spec.usesEcharts) scripts.push('echarts.min.js');
  if (spec.sources['shared.jsx']) scripts.push('shared.js');
  scripts.push(entryJs);
  return '<!doctype html>\n<html dir="auto">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + `<title>${escapeCustomAppHtml(spec.name)}</title>\n<link rel="stylesheet" href="d2-kit.css">\n`
    + (entryJs === 'plugin.js' && spec.pluginType === 'CAPTURE' ? '<link rel="stylesheet" href="capture-plugin.css">\n' : '')
    + '</head>\n'
    // d2-plugin makes #root fill the frame — right for a fixed-size dashboard
    // item, wrong for Capture, which sizes the frame to the height the plugin
    // reports: a 100%-high wrapper there reports the frame's own height and the
    // content is cut off (seen live 2026-10-22: frame 651 px, content 697 px).
    + `<body${entryJs === 'plugin.js' ? (spec.pluginType === 'CAPTURE' ? ' class="d2-capture-plugin"' : ' class="d2-plugin"') : ''}>\n<div id="root"></div>\n`
    + scripts.map((s) => `<script src="${s}"></script>`).join('\n')
    + '\n</body>\n</html>\n';
}

// window.D2_APP_CONFIG — what the generated code needs to know about where it
// runs. baseUrl is computed at runtime (the server root above /api/apps/), so
// the same zip works behind any context path.
function buildCustomAppConfigJs(spec) {
  const cfg = {
    key: spec.key, name: spec.name, version: spec.version, kind: spec.kind,
    pluginType: spec.pluginType || null, namespace: spec.namespace || null,
    apiVersion: spec.apiVersion, kitVersion: spec.kitVersion,
    serverVersion: spec.serverVersion || null,
  };
  return `/* generated by the DHIS2 AI Assistant (manage_custom_app) */\n(function () {\n`
    + `  var p = location.pathname, i = p.indexOf('/api/apps/');\n`
    + `  var cfg = ${JSON.stringify(cfg)};\n`
    + `  cfg.baseUrl = location.origin + (i >= 0 ? p.slice(0, i) : '');\n`
    + `  window.D2_APP_CONFIG = Object.freeze(cfg);\n})();\n`;
}

function buildCustomAppAiManifest(spec) {
  return {
    key: spec.key,
    name: spec.name,
    description: spec.description || '',
    kind: spec.kind,
    plugin_type: spec.pluginType || null,
    version: spec.version,
    kit_version: spec.kitVersion,
    api_version: spec.apiVersion,
    needs_write_access: !!spec.needsWriteAccess,
    datastore_namespace: spec.namespace || null,
    uses_echarts: !!spec.usesEcharts,
    files: CUSTOM_APP_SOURCE_NAMES.filter((f) => spec.sources[f]),
    created_by: CUSTOM_APP_MARKER,
    created_at: spec.createdAt,
    updated_at: new Date().toISOString(),
    prompt_summary: String(spec.promptSummary || spec.description || '').slice(0, 500),
  };
}

// Pure: spec + compiled JS + kit (+ echarts bytes) → zip and its manifest.
function packageCustomApp(spec, compiled, kit, echartsBytes) {
  const enc = new TextEncoder();
  const entries = {};
  const add = (p, data, store) => { entries[p] = store ? [data, { level: 0 }] : data; };
  const manifest = buildCustomAppManifest(spec);
  const aiManifest = buildCustomAppAiManifest(spec);
  add('manifest.webapp', enc.encode(JSON.stringify(manifest, null, 2)));
  add('app-config.js', enc.encode(buildCustomAppConfigJs(spec)));
  if (compiled['shared.jsx'] != null) add('shared.js', enc.encode(compiled['shared.jsx']));
  // Entry files run in their own strict-mode IIFE (prefix on the SAME line, so
  // browser error line numbers still match the JSX source).
  const wrap = (js) => `(function () { 'use strict'; ${js}\n})();\n`;
  if (customAppHasApp(spec.kind)) {
    add('index.html', enc.encode(buildCustomAppHtml(spec, 'app.js')));
    add('app.js', enc.encode(wrap(compiled['app.jsx'])));
  }
  if (customAppHasPlugin(spec.kind)) {
    add('plugin.html', enc.encode(buildCustomAppHtml(spec, 'plugin.js')));
    add('plugin.js', enc.encode(wrap(compiled['plugin.jsx'])));
    if (spec.pluginType === 'CAPTURE') add('capture-plugin.css', enc.encode(CAPTURE_PLUGIN_CSS));
  }
  for (const [rel, bytes] of Object.entries(kit.files)) add(rel, bytes, /\.woff2$/.test(rel));
  if (spec.usesEcharts) add('echarts.min.js', echartsBytes);
  for (const f of aiManifest.files) add(`src/${f}`, enc.encode(spec.sources[f]));
  add('src/manifest.ai.json', enc.encode(JSON.stringify(aiManifest, null, 2)));
  const zip = fflate.zipSync(entries, { level: 9 });
  const files = Object.entries(entries).map(([p, v]) => ({ path: p, bytes: (Array.isArray(v) ? v[0] : v).length }));
  return { zip, manifest, aiManifest, files };
}

// ── Server state ────────────────────────────────────────────────────────────

function isAssistantBuiltApp(app) {
  return !!(app && app.developer && app.developer.company === CUSTOM_APP_MARKER);
}

async function listInstalledApps() {
  const resp = await safeDhis2Fetch('apps', { noTruncate: true });
  if (resp && resp._status === 401) {
    return { _error: DHIS2_NOT_SIGNED_IN_MSG, _status: 401, _not_signed_in: true, _hint: 'Nothing was changed. Ask the user to log in to DHIS2 in the browser tab, then retry the same call.' };
  }
  if (resp && resp._error) return resp;
  if (!Array.isArray(resp)) return { _error: 'GET /api/apps did not return a list.' };
  return resp;
}

function summarizeInstalledApp(app) {
  return {
    key: app.key,
    name: app.displayName || app.name,
    version: app.version,
    built_by_assistant: isAssistantBuiltApp(app),
    app_state: app.appState,
    launch_url: app.launchUrl || null,
    plugin_launch_url: app.pluginLaunchUrl || null,
    plugin_type: app.plugin_type || app.pluginType || null,
    datastore_namespace: (app.activities && app.activities.dhis && app.activities.dhis.namespace) || null,
  };
}

// App files are served unversioned (/api/apps/<key>/…); safeDhis2Fetch always
// adds /api/<version>/, so these reads go direct (GET only, same session).
async function fetchCustomAppFile(key, rel, asJson) {
  if (!dhis2.baseUrl) {
    const ok = await ensureConnected();
    if (!ok) return { _error: 'Not connected to DHIS2. Navigate to a DHIS2 page.' };
  }
  const url = `${dhis2.baseUrl}/api/apps/${encodeURIComponent(key)}/${rel}`;
  try {
    const resp = await fetch(url, { credentials: 'include', redirect: 'manual', cache: 'no-store' });
    if (resp.type === 'opaqueredirect' || resp.status === 0) return { _error: DHIS2_NOT_SIGNED_IN_MSG, _status: 401 };
    if (!resp.ok) return { _error: `GET ${url.replace(dhis2.baseUrl, '')} → HTTP ${resp.status}`, _status: resp.status };
    const text = await resp.text();
    if (!asJson) return { text };
    try { return { json: JSON.parse(text) }; } catch { return { _error: `${rel} is not valid JSON` }; }
  } catch (e) {
    return { _error: `Fetch failed: ${e.message}` };
  }
}

// The authoritative "this app is ours" check: the developer marker in the
// listing AND src/manifest.ai.json with created_by. Returns the source.
async function loadCustomAppSource(key, installedApp) {
  if (!installedApp) return { _error: `No app with key "${key}" is installed.`, _hint: 'manage_custom_app(action="list") shows the installed AI apps.' };
  if (!isAssistantBuiltApp(installedApp)) {
    return {
      _error: `Refused: "${key}" was not built by the DHIS2 AI Assistant (its manifest lacks the assistant's developer marker), so this tool will not read, change or remove it.`,
      _hint: 'Only apps created with manage_custom_app can be updated, rolled back or deleted here. Manage other apps in the App Management app.',
      _refused_not_managed: true,
    };
  }
  const man = await fetchCustomAppFile(key, 'src/manifest.ai.json', true);
  if (man._error) {
    return { _error: `Could not read ${key}/src/manifest.ai.json: ${man._error}`, _hint: 'The app has no embedded AI source; it cannot be updated with this tool.' };
  }
  const aiManifest = man.json;
  if (!aiManifest || aiManifest.created_by !== CUSTOM_APP_MARKER || aiManifest.key !== key) {
    return { _error: `Refused: ${key}/src/manifest.ai.json does not identify an assistant-built app.`, _refused_not_managed: true };
  }
  const sources = {};
  for (const f of (aiManifest.files || [])) {
    if (!CUSTOM_APP_SOURCE_NAMES.includes(f)) continue;
    const r = await fetchCustomAppFile(key, `src/${f}`, false);
    if (r._error) return { _error: `Could not read ${key}/src/${f}: ${r._error}` };
    sources[f] = r.text;
  }
  return { aiManifest, sources };
}

// Read-only conflicts with what is installed. mode: 'create' | 'replace'.
function customAppConflicts(spec, apps, mode) {
  const problems = [];
  const existing = apps.find((a) => a.key === spec.key);
  if (mode === 'create' && existing) {
    problems.push({
      code: 'key_exists',
      message: `An app with key "${spec.key}" is already installed (${existing.displayName || existing.name} v${existing.version}).`,
      hint: isAssistantBuiltApp(existing)
        ? `Use manage_custom_app(action="update", key="${spec.key}") to change it, or pick another name/key.`
        : 'It was not built by the assistant — choose a different name/key.',
    });
  }
  if (mode === 'replace' && existing && !isAssistantBuiltApp(existing)) {
    problems.push({ code: 'not_managed', message: `"${spec.key}" is installed but was not built by the assistant.` });
  }
  if (spec.namespace) {
    const owner = apps.find((a) => a.key !== spec.key && a.activities && a.activities.dhis && a.activities.dhis.namespace === spec.namespace);
    if (owner) {
      problems.push({
        code: 'namespace_in_use',
        message: `The dataStore namespace "${spec.namespace}" is already reserved by the app "${owner.key}" — DHIS2 rejects the install (409 "Namespace defined in manifest is already in use").`,
        hint: 'Choose a different key (the namespace equals the key), or pass datastore_namespace:false if the app stores nothing.',
      });
    }
  }
  const folder = `apps/${spec.key}`;
  const folderOwner = apps.find((a) => a.key !== spec.key && a.folderName === folder);
  if (folderOwner) {
    problems.push({
      code: 'folder_in_use',
      message: `The server folder "${folder}" already holds the app "${folderOwner.key}". DHIS2 names app folders after the uploaded file, so installing would overwrite that app's files.`,
      hint: 'Choose a different key.',
    });
  }
  return problems;
}

async function installCustomAppZip(zip, key) {
  const up = await uploadAppZip(zip, `${key}.zip`);
  if (up._error) return up;
  const installedKey = (up.app && up.app.key) || key;
  return { installedKey, response: up.app || null };
}

async function verifyCustomAppInstalled(key, version) {
  const apps = await listInstalledApps();
  if (apps._error) return { _error: `Installed, but could not re-read /api/apps: ${apps._error}` };
  const app = apps.find((a) => a.key === key);
  if (!app) return { _error: `The upload was accepted but "${key}" is not in /api/apps.` };
  const problems = [];
  if (app.appState && app.appState !== 'OK') problems.push(`appState is ${app.appState}`);
  if (version && app.version !== version) problems.push(`version is ${app.version}, expected ${version}`);
  return { app, summary: summarizeInstalledApp(app), problems };
}

function customAppWhereToFind(summary, kind, pluginType) {
  const lines = [];
  if (customAppHasApp(kind)) {
    lines.push(`Open the app from the DHIS2 app menu ("${summary.name}") — on DHIS2 2.42+ at ${dhis2.baseUrl}/apps/${summary.key}.`);
  }
  if (customAppHasPlugin(kind) && pluginType === 'DASHBOARD') {
    lines.push(`Add the plugin to a dashboard: open a dashboard → Edit → search "${summary.name}" in the item selector (it is listed under Apps) → Save. Requires DHIS2 ≥ 40.5 and Dashboard app ≥ 101.`);
  }
  if (customAppHasPlugin(kind) && pluginType === 'CAPTURE') {
    lines.push(`Not placed yet — it does not appear in Capture until it is: manage_custom_app(action="place", key="${summary.key}", target="enrollment_dashboard", program_id=…) for an enrollment widget, or target="form" with program_stage_id / program_id + field_map for a form-field plugin (the user can also add it in the Tracker Plugin Configurator app; source ${summary.plugin_launch_url}).`);
  }
  return lines;
}

// ── Backups (BACKUP_NAMESPACE, last CUSTOM_APP_BACKUPS_KEPT per app) ─────────
// Stored like every other backup (same timestamped key prefix, so manage_backups
// lists and purges them), holding the JSX source + AI manifest — never the kit,
// which is re-added from the current extension on restore.

function customAppBackupKey(key) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `backup-${ts}-app-${key}-${generateDhis2Uid().slice(0, 6)}`;
}

function parseCustomAppBackupKey(k) {
  const m = String(k).match(/^backup-(\d{8}T\d{6}Z)-app-(ai-[a-z0-9-]+)-([A-Za-z0-9]{6})$/);
  return m ? { ts: m[1], appKey: m[2] } : null;
}

async function listCustomAppBackupKeys(key) {
  // List namespaces first: GET dataStore/<ns> is a 404 when it has no keys yet.
  const namespaces = await safeDhis2Fetch('dataStore', { noTruncate: true });
  if (namespaces && namespaces._error) return { _error: `Could not list dataStore namespaces: ${namespaces._error}` };
  if (!Array.isArray(namespaces) || !namespaces.includes(BACKUP_NAMESPACE)) return [];
  const keys = await safeDhis2Fetch(`dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}`, { noTruncate: true });
  if (keys && keys._error) return { _error: `Could not list backups: ${keys._error}` };
  return (Array.isArray(keys) ? keys : [])
    .filter((k) => { const p = parseCustomAppBackupKey(k); return p && p.appKey === key; })
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

async function readCustomAppBackup(backupKey) {
  const entry = await safeDhis2Fetch(`dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(backupKey)}`, { noTruncate: true });
  if (entry && entry._error) return { _error: `Could not read backup ${backupKey}: ${entry._error}` };
  if (!entry || !entry.custom_app || !entry.custom_app.manifest_ai) return { _error: `Backup ${backupKey} is not an app backup.` };
  return entry;
}

async function backupCustomAppVersion(key, source, action, reason) {
  const backupKey = customAppBackupKey(key);
  const entry = {
    version: BACKUP_KEY_VERSION,
    created_at: new Date().toISOString(),
    retention_days: BACKUP_RETENTION_DAYS,
    operation: `custom_app_${action}`,
    tool: 'manage_custom_app',
    action,
    reason: reason || null,
    origin_server: dhis2.baseUrl || null,
    objects: [],
    custom_app: {
      key,
      version: source.aiManifest.version,
      manifest_ai: source.aiManifest,
      files: source.sources,
    },
  };
  const put = await safeDhis2Fetch(`dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(backupKey)}`, { method: 'POST', body: entry });
  if (put && put._error) {
    return {
      _error: `Could not back up ${key} v${source.aiManifest.version} before ${action}: ${put._error}`,
      _requires_user_confirmation: true,
      _hint: 'Nothing was changed. If the user accepts losing the ability to roll back, retry with skip_backup:true.',
    };
  }
  // Retention: keep the newest CUSTOM_APP_BACKUPS_KEPT for this app.
  const keys = await listCustomAppBackupKeys(key);
  const pruned = [];
  if (Array.isArray(keys)) {
    for (const old of keys.slice(CUSTOM_APP_BACKUPS_KEPT)) {
      const d = await safeDhis2Fetch(`dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(old)}`, { method: 'DELETE', allowEmptyBody: true });
      if (!(d && d._error)) pruned.push(old);
    }
  }
  return { backup_key: backupKey, version: source.aiManifest.version, pruned: pruned.length ? pruned : undefined };
}

// ── Build pipeline ──────────────────────────────────────────────────────────

// Validate → compile → safety scan → lint → UID check → package. Returns
// { spec, pkg, report } or a structured error. Never writes to the server.
async function prepareCustomAppBuild(spec, opts = {}) {
  const fileNames = Object.keys(spec.sources);
  const unknown = fileNames.filter((f) => !CUSTOM_APP_SOURCE_NAMES.includes(f));
  if (unknown.length) {
    return { _error: `Unknown source file(s): ${unknown.join(', ')}.`, _hint: `files may contain only ${CUSTOM_APP_SOURCE_NAMES.join(', ')}.` };
  }
  const missing = [];
  if (customAppHasApp(spec.kind) && !spec.sources['app.jsx']) missing.push('app.jsx');
  if (customAppHasPlugin(spec.kind) && !spec.sources['plugin.jsx']) missing.push('plugin.jsx');
  if (missing.length) {
    return { _error: `kind "${spec.kind}" needs ${missing.join(' and ')} in files.`, _hint: 'kind=app → app.jsx; kind=plugin → plugin.jsx; kind=app_and_plugin → both (shared.jsx optional).' };
  }
  for (const f of fileNames) {
    if (typeof spec.sources[f] !== 'string' || !spec.sources[f].trim()) return { _error: `files["${f}"] is empty.` };
    if (spec.sources[f].length > CUSTOM_APP_MAX_FILE_CHARS) return { _error: `files["${f}"] is ${spec.sources[f].length} characters (max ${CUSTOM_APP_MAX_FILE_CHARS}).`, _hint: 'Split the code or simplify the app.' };
  }
  // Drop files the kind does not load (e.g. a leftover plugin.jsx on kind=app).
  for (const f of fileNames) {
    if ((f === 'app.jsx' && !customAppHasApp(spec.kind)) || (f === 'plugin.jsx' && !customAppHasPlugin(spec.kind))) delete spec.sources[f];
  }

  const compiled = {};
  const compileErrors = [];
  for (const f of CUSTOM_APP_SOURCE_NAMES) {
    if (!spec.sources[f]) continue;
    const r = compileCustomAppFile(f, spec.sources[f]);
    if (r.error) compileErrors.push(r.error);
    else compiled[f] = r.code;
  }
  if (compileErrors.length) {
    return {
      _error: `JSX does not compile: ${compileErrors.map((e) => `${e.file}${e.line ? `:${e.line}:${e.column}` : ''} ${e.message}`).join('; ')}`,
      compile_errors: compileErrors,
      _hint: 'Fix exactly these lines (see frame) and resend the whole call. Common causes: an unclosed JSX tag, a missing ")" or "}", or an expression that is not wrapped in {…}.',
    };
  }

  const violations = scanCustomAppCode(compiled, { needsWriteAccess: spec.needsWriteAccess, allowedOrigin: dhis2.baseUrl });
  if (violations.length) {
    const writeOnly = violations.every((v) => v.rule.startsWith('write:'));
    return {
      _error: `Safety scan rejected the code: ${violations.length} violation(s).`,
      violations,
      _hint: writeOnly
        ? 'The code writes data but needs_write_access is false. If the app genuinely must save (settings, notes…), pass needs_write_access:true and tell the user what it writes; otherwise remove the mutations.'
        : 'Remove every listed pattern — they are never allowed in generated apps. Read data only through DataProvider/useDataQuery with relative resources, render text with JSX, and keep app data in the dataStore namespace D2_APP_CONFIG.namespace.',
    };
  }

  let kit;
  try { kit = await loadCustomAppKit(); }
  catch (e) { return { _error: `The runtime kit could not be loaded from the extension: ${e.message}`, _hint: 'Reload the extension; libs/d2-kit/ must contain the files listed in KIT_VERSION.json.' }; }
  spec.kitVersion = kit.meta.kit_version;
  spec.serverVersion = await customAppServerVersion();

  const lint = lintCustomAppCode(compiled, spec.kind, kit.meta, spec.pluginType);
  // An app that writes the dataStore without a namespace of its own writes a
  // namespace nobody reserved: DHIS2 creates those entries with public
  // read-write sharing (verified 2.42.5.1: "rw------"), so every user can read
  // and change them — patient values included (a flag plugin kept every
  // enrollment's flagged values in one such key, live 2026-10-25).
  const allCompiled = Object.values(compiled).join('\n');
  const foreignNs = await customAppUnreservedNamespaces(allCompiled, spec);
  if (foreignNs.length) {
    lint.warnings.push({ message: `The code uses dataStore namespace ${foreignNs.map((n) => `"${n}"`).join(', ')}, which no installed app reserves — DHIS2 shares entries there public read-write, so every user can read and change them. Use D2_APP_CONFIG.namespace (this app's own), or the namespace of the app that owns the shared state (its key), and never keep patient values in the dataStore (they belong in tracker data: see "Plugins that work together").` });
  } else if (/dataStore\//.test(allCompiled) && /\.\s*mutate\s*\(|\buseDataMutation\b/.test(allCompiled) && !spec.namespace && /D2_APP_CONFIG\s*\.\s*namespace/.test(allCompiled)) {
    lint.warnings.push({ message: 'The code writes D2_APP_CONFIG.namespace but the app reserves no namespace (datastore_namespace:false), so it is null. Keep the default namespace for an app that saves data.' });
  }
  if (lint.errors.length) {
    const patientWrite = lint.errors.some((e) => /Patient data never goes into the dataStore/.test(e.message || ''));
    return {
      _error: patientWrite
        ? 'Refused: this code would write to the dataStore from code that can see patient data — patient data never goes into the dataStore. Redesign it (problems explain how); do not retry the same code.'
        : `The code would fail at runtime: ${lint.errors.length} problem(s).`,
      problems: lint.errors,
      warnings: lint.warnings.length ? lint.warnings : undefined,
      _hint: 'Fix each listed problem and resend. Destructure every component/hook from its kit global: const { Card, DataTable } = D2UI; const { useDataQuery } = D2Runtime; const { useState } = React;',
    };
  }

  const uidCheck = opts.skipUidCheck ? { skipped: 'not requested' } : await checkCustomAppUids(extractCustomAppUids(compiled));
  if (uidCheck.unknown && uidCheck.unknown.length) {
    return {
      _error: `The code hard-codes ${uidCheck.unknown.length} id(s) that do not exist on this server: ${uidCheck.unknown.join(', ')}.`,
      unknown_uids: uidCheck.unknown,
      found_uids: uidCheck.found,
      _hint: 'Never invent UIDs. Look the real ones up (search_metadata, get_program_info, dhis2_query) and resend. If an object exists but is not shared with this user it also shows as unknown.',
    };
  }

  // Program-indicator VALUES come from /api/analytics with dx: — the event /
  // enrollment aggregate endpoints refuse them (409 E7224) or, as separate
  // dimensions, group by the indicator's value. Live 2026-10-28 a dashboard
  // league-table plugin queried analytics/events/aggregate with three program
  // indicators and showed nothing.
  {
    const pis = Object.entries(uidCheck.found || {}).filter(([, t]) => t === 'programIndicators').map(([id]) => id);
    const code = Object.values(compiled).map((js) => customAppSourceViews(js).code).join('\n');
    if (pis.length && /analytics\/(?:events|enrollments)\/aggregate/.test(code) && !/resource\s*:\s*['"`]analytics(?:\.json)?['"`]/.test(code)) {
      return {
        _error: `The code reads program indicator(s) ${pis.join(', ')} through analytics/events|enrollments/aggregate — DHIS2 refuses program indicators there (409 E7224), so the plugin would show nothing.`,
        _hint: "Read program-indicator values from the plain analytics resource: { resource: 'analytics', params: ({ ou, pe }) => ({ dimension: [`dx:${PI_IDS.join(';')}`, `ou:${ou}`], filter: `pe:${pe}`, displayProperty: 'NAME' }) } — rows are [dx, ou, value]. Keep events/enrollments aggregate for data elements only. Fix the query and preview again.",
      };
    }
  }

  const sqlCheck = await checkCustomAppSqlViews(compiled, uidCheck.found);
  if (sqlCheck.errors.length) {
    return {
      _error: `The code reads ${sqlCheck.views.length > 1 ? 'SQL views' : 'a SQL view'} its users could not read: ${sqlCheck.errors.length} problem(s).`,
      problems: sqlCheck.errors,
      _hint: 'Fix each listed problem (the view with manage_sql_views, the code here) and preview again.',
    };
  }
  lint.warnings.push(...sqlCheck.warnings);

  spec.usesEcharts = /(?<![\w$.])echarts\b/.test(Object.values(compiled).map((js) => customAppSourceViews(js).bare).join('\n'));
  let echartsBytes = null;
  if (spec.usesEcharts) {
    try { echartsBytes = await loadCustomAppEcharts(); }
    catch (e) { return { _error: `The code uses echarts but libs/echarts.min.js could not be loaded: ${e.message}` }; }
  }
  let pkg;
  try { pkg = packageCustomApp(spec, compiled, kit, echartsBytes); }
  catch (e) { return { _error: `Packaging failed: ${e.message}` }; }
  return {
    spec, pkg,
    report: {
      warnings: lint.warnings,
      uid_check: uidCheck,
      sql_views: sqlCheck.views,
      api_resources: customAppApiResources(compiled),
    },
  };
}

// dataStore namespaces the code names itself ('dataStore/x…', 'dataStore/' + NS,
// `dataStore/${NS}` with const NS = 'x') that neither this app nor any
// installed app — nor an app previewed in this conversation — reserves.
// D2_APP_CONFIG.namespace is always fine. A flag plugin hard-coded
// "ai-mch-flags" and kept every patient's flags there (live 2026-10-25).
async function customAppUnreservedNamespaces(code, spec) {
  const constOf = (name) => { const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*['"\`]([A-Za-z0-9_.-]+)['"\`]`).exec(code); return m ? m[1] : null; };
  const names = new Set();
  for (const m of code.matchAll(/dataStore\/([A-Za-z0-9_.-]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/['"`]dataStore\/['"`]\s*\+\s*([A-Za-z_$][\w$]*)/g)) { const v = constOf(m[1]); if (v) names.add(v); }
  for (const m of code.matchAll(/dataStore\/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) { const v = constOf(m[1]); if (v) names.add(v); }
  names.delete(spec.namespace);
  if (!names.size) return [];
  const reserved = new Set();
  const apps = await listInstalledApps();
  if (Array.isArray(apps)) for (const a of apps) if (a.activities && a.activities.dhis && a.activities.dhis.namespace) reserved.add(a.activities.dhis.namespace);
  for (const p of _customAppPreviews.values()) if (p && p.spec && p.spec.namespace) reserved.add(p.spec.namespace);
  return [...names].filter((n) => !reserved.has(n));
}

// Normalise create/update/preview arguments into a build spec.
function customAppSpecFromArgs(args, key, base) {
  const prev = base || {};
  const kind = args.kind || prev.kind || 'app';
  const pluginType = args.plugin_type ? String(args.plugin_type).toUpperCase() : (prev.plugin_type || null);
  const nsOn = args.datastore_namespace != null ? args.datastore_namespace !== false : (prev.datastore_namespace !== undefined ? !!prev.datastore_namespace : true);
  return {
    key,
    name: String(args.name || prev.name || key).slice(0, 100),
    description: String(args.description != null ? args.description : (prev.description || '')).slice(0, 500),
    kind,
    pluginType: customAppHasPlugin(kind) ? (pluginType || null) : null,
    version: args.version || prev.version || '1.0.0',
    namespace: nsOn ? key : null,
    needsWriteAccess: args.needs_write_access != null ? args.needs_write_access === true : !!prev.needs_write_access,
    apiVersion: Number(dhis2.apiVersion) || 42,
    promptSummary: args.prompt_summary || prev.prompt_summary || args.description || '',
    createdAt: prev.created_at || new Date().toISOString(),
    sources: {},
  };
}

function customAppSpecProblem(spec) {
  if (!CUSTOM_APP_KINDS.has(spec.kind)) return { _error: `kind must be one of: ${[...CUSTOM_APP_KINDS].join(', ')}.` };
  if (customAppHasPlugin(spec.kind) && !CUSTOM_APP_PLUGIN_TYPES.has(spec.pluginType)) {
    return { _error: `kind "${spec.kind}" needs plugin_type DASHBOARD or CAPTURE.`, _hint: 'A widget on a dashboard → plugin_type:"DASHBOARD".' };
  }
  if (!/^\d+\.\d+\.\d+$/.test(spec.version)) return { _error: `version "${spec.version}" must look like 1.2.3.` };
  return null;
}

// preview tokens: the exact spec the user was shown, so create can install it
// without the model re-emitting (and possibly altering) the code. Kept in
// memory and in chrome.storage.session (the MV3 worker may be stopped while
// the user reads the preview), with the turn it was made in (see
// customAppApprovalProblem).
const _customAppPreviews = new Map();
async function rememberCustomAppPreview(spec) {
  const bytes = new TextEncoder().encode(JSON.stringify(spec));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const token = `pv-${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const turn = dhis2.turnCounter || 0;
  _customAppPreviews.delete(token);
  _customAppPreviews.set(token, { spec, turn });
  while (_customAppPreviews.size > 5) _customAppPreviews.delete(_customAppPreviews.keys().next().value);
  try {
    const store = chrome.storage && chrome.storage.session;
    if (store) {
      const got = (await store.get('customAppPreviews')) || {};
      const all = got.customAppPreviews || {};
      all[token] = { spec, turn, at: Date.now() };
      const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 5);
      await store.set({ customAppPreviews: Object.fromEntries(keep) });
    }
  } catch { /* in-memory copy is enough */ }
  return token;
}
// → { spec, turn } or null.
async function recallCustomAppPreview(token) {
  if (_customAppPreviews.has(token)) return JSON.parse(JSON.stringify(_customAppPreviews.get(token)));
  try {
    const store = chrome.storage && chrome.storage.session;
    if (store) {
      const got = (await store.get('customAppPreviews')) || {};
      const hit = got.customAppPreviews && got.customAppPreviews[token];
      if (hit) return { spec: hit.spec, turn: hit.turn };
    }
  } catch { /* fall through */ }
  return null;
}

// The user approves a preview by answering it, i.e. in a LATER turn — unless
// their own message already asked to install ("create and install …").
// Without this the model previewed and installed in one breath even when the
// user wrote "Show me a preview first" (GLM-5.3-flash, live 2026-10-22).
function userAskedToInstall(text) {
  const t = String(text || '').toLowerCase();
  if (/\bpreview\b[^.?!]*\bfirst\b|\b(?:don'?t|do\s+not|not|never|without|before)\s+(?:\w+\s+){0,2}install/.test(t)) return false;
  return /\b(?:install|deploy|publish)/.test(t);
}
// Installing goes ahead when the user's message asks to install, or to put
// the plugin somewhere (placing implies installing), or when they are
// answering a preview shown in an EARLIER turn — for token and file creates
// alike (a model sent the files instead of the token, skipping the check).
// previewTurn: the turn of the newest preview of this key, or null.
function customAppApprovalProblem(key, token, previewTurn) {
  const turn = dhis2.turnCounter || 0;
  if (userAskedToInstall(lastUserText)) return null;
  if (typeof userAskedToPlace === 'function' && userAskedToPlace([lastUserText])) return null;
  if (previewTurn != null && previewTurn < turn) return null;
  return {
    _error: previewTurn === turn
      ? 'Not installed: the preview was made in this same turn and the user has not approved it yet.'
      : 'Not installed: the user has not seen a preview of this app or asked to install it.',
    _hint: `Do not call create again this turn — it will be refused the same way. End the turn: show the user the preview summary (what it shows, which data it reads, whether it writes, where it will appear) and ask whether to install it. After they agree, call manage_custom_app(action="create", key="${key}"${token ? `, preview_token="${token}"` : ', preview_token=<the preview\'s token>'}).`,
    _awaiting_approval: true,
  };
}
// The newest turn in which this key was previewed (memory, then session).
async function latestPreviewTurn(key) {
  let best = null;
  for (const v of _customAppPreviews.values()) if (v.spec && v.spec.key === key && (best == null || v.turn > best)) best = v.turn;
  try {
    const store = chrome.storage && chrome.storage.session;
    const got = store ? ((await store.get('customAppPreviews')) || {}).customAppPreviews || {} : {};
    for (const v of Object.values(got)) if (v.spec && v.spec.key === key && typeof v.turn === 'number' && (best == null || v.turn > best)) best = v.turn;
  } catch { /* memory is enough */ }
  return best;
}

function customAppFilesArg(args) {
  const files = args.files;
  if (files == null) return {};
  if (typeof files !== 'object' || Array.isArray(files)) return null;
  const out = {};
  for (const [k, v] of Object.entries(files)) out[String(k).replace(/^src\//, '')] = v;
  return out;
}

async function buildAndInstallCustomApp(spec, mode) {
  const prep = await prepareCustomAppBuild(spec);
  if (prep._error) return prep;
  const inst = await installCustomAppZip(prep.pkg.zip, spec.key);
  if (inst._error) return inst;
  const ver = await verifyCustomAppInstalled(inst.installedKey, spec.version);
  if (ver._error) return ver;
  return { prep, inst, ver };
}

function customAppResult(action, spec, built, extra) {
  const s = built.ver.summary;
  return {
    success: built.ver.problems.length === 0,
    action,
    key: s.key,
    name: s.name,
    version: s.version,
    kind: spec.kind,
    plugin_type: spec.pluginType || undefined,
    app_state: s.app_state,
    launch_url: s.launch_url || undefined,
    global_shell_url: customAppHasApp(spec.kind) ? `${dhis2.baseUrl}/apps/${s.key}` : undefined,
    plugin_launch_url: s.plugin_launch_url || undefined,
    datastore_namespace: spec.namespace || undefined,
    needs_write_access: spec.needsWriteAccess,
    zip_bytes: built.prep.pkg.zip.length,
    uses_echarts: spec.usesEcharts || undefined,
    warnings: built.prep.report.warnings.length ? built.prep.report.warnings : undefined,
    problems: built.ver.problems.length ? built.ver.problems : undefined,
    installed_key_differs: built.inst.installedKey !== spec.key ? built.inst.installedKey : undefined,
    where_to_find: customAppWhereToFind(s, spec.kind, spec.pluginType),
    ...extra,
  };
}

// Reinstall the version held in a backup entry (rollback, and manage_backups
// restore of an app backup). The caller has passed the write gate.
async function reinstallCustomAppFromBackup(backupKey, entry, apps, opts = {}) {
  const ca = entry.custom_app;
  const key = ca.key;
  if (customAppKeyProblem(key) || !ca.manifest_ai || ca.manifest_ai.created_by !== CUSTOM_APP_MARKER) {
    return { _error: `Backup ${backupKey} does not hold an assistant-built app.` };
  }
  const installed = apps.find((a) => a.key === key);
  let currentBackup = null;
  if (installed) {
    const cur = await loadCustomAppSource(key, installed);
    if (cur._error) return cur;
    if (!opts.skipBackup) {
      currentBackup = await backupCustomAppVersion(key, cur, 'rollback', `before rollback to v${ca.version}`);
      if (currentBackup._error) return currentBackup;
    }
  }
  const spec = customAppSpecFromArgs({}, key, ca.manifest_ai);
  spec.version = ca.manifest_ai.version;
  spec.createdAt = ca.manifest_ai.created_at || spec.createdAt;
  spec.sources = { ...ca.files };
  const conflicts = customAppConflicts(spec, apps, 'replace');
  if (conflicts.length) return { _error: conflicts.map((c) => c.message).join(' '), conflicts };
  const built = await buildAndInstallCustomApp(spec, 'rollback');
  if (built._error) return built;
  return customAppResult('rollback', spec, built, {
    restored_from_backup: backupKey,
    previous_version: installed ? installed.version : null,
    backup: currentBackup ? { key: currentBackup.backup_key, version: currentBackup.version } : undefined,
  });
}

// Hook for restoreFromBackup (core.js) when manage_backups restores an app backup.
async function restoreCustomAppFromBackup(backupKey, entry) {
  const apps = await listInstalledApps();
  if (apps._error) return apps;
  return reinstallCustomAppFromBackup(backupKey, entry, apps);
}

// ── Tool entry point ────────────────────────────────────────────────────────

async function executeManageCustomApp(args) {
  args = args || {};
  const action = args.action;
  if (!CUSTOM_APP_ACTIONS.includes(action)) {
    return { _error: `Unknown action "${action}" for manage_custom_app.`, _hint: `One of: ${CUSTOM_APP_ACTIONS.join(', ')}.` };
  }

  // Where a plugin is shown: dashboards, Capture pages, Capture forms
  // (src/tools-apps-placement.js).
  if (action === 'place' || action === 'unplace' || action === 'placements') return executeCustomAppPlacement(args);

  if (action === 'list') {
    const apps = await listInstalledApps();
    if (apps._error) return apps;
    const rows = apps.filter((a) => args.include_all === true || String(a.key).startsWith(CUSTOM_APP_PREFIX)).map(summarizeInstalledApp);
    return {
      total: rows.length,
      apps: rows,
      _note: args.include_all === true ? undefined : `Only apps whose key starts with "${CUSTOM_APP_PREFIX}" (pass include_all:true for every app). built_by_assistant=false apps cannot be changed with this tool.`,
    };
  }

  if (action === 'get_source') {
    if (!args.key) return { _error: 'Pass key.' };
    const problem = customAppKeyProblem(args.key);
    if (problem) return { _error: `Refused: ${problem}.`, _refused_not_managed: true };
    const apps = await listInstalledApps();
    if (apps._error) return apps;
    const src = await loadCustomAppSource(args.key, apps.find((a) => a.key === args.key));
    if (src._error) return src;
    return { key: args.key, manifest_ai: src.aiManifest, files: src.sources };
  }

  // ── rollback ──
  if (action === 'rollback') {
    if (!args.key) return { _error: 'Pass key (the app to roll back).' };
    const problem = customAppKeyProblem(args.key);
    if (problem) return { _error: `Refused: ${problem}.`, _refused_not_managed: true };
    const apps = await listInstalledApps();
    if (apps._error) return apps;
    const installed = apps.find((a) => a.key === args.key);
    if (installed && !isAssistantBuiltApp(installed)) {
      return { _error: `Refused: "${args.key}" was not built by the DHIS2 AI Assistant.`, _refused_not_managed: true };
    }
    const keys = await listCustomAppBackupKeys(args.key);
    if (keys._error) return keys;
    if (!keys.length) return { _error: `No backups exist for ${args.key}.`, _hint: 'Backups are taken automatically before every update / delete / rollback.' };
    let backupKey = null;
    let entry = null;
    if (args.backup_key) {
      if (!keys.includes(args.backup_key)) return { _error: `Backup ${args.backup_key} does not belong to ${args.key}.`, available: keys };
      backupKey = args.backup_key;
    } else if (args.version) {
      for (const k of keys) {
        const e = await readCustomAppBackup(k);
        if (!e._error && e.custom_app.version === String(args.version)) { backupKey = k; entry = e; break; }
      }
      if (!backupKey) return { _error: `No backup of ${args.key} v${args.version}.`, available: keys };
    } else {
      backupKey = keys[0];
    }
    const gate = requireWriteAuth('manage_custom_app', 'rollback', { key: args.key, backup_key: backupKey });
    if (gate) return gate;
    if (!entry) {
      entry = await readCustomAppBackup(backupKey);
      if (entry._error) return entry;
    }
    if (entry.custom_app.key !== args.key) return { _error: `Backup ${backupKey} belongs to ${entry.custom_app.key}, not ${args.key}.` };
    return reinstallCustomAppFromBackup(backupKey, entry, apps, { skipBackup: args.skip_backup === true });
  }

  // ── delete ──
  if (action === 'delete') {
    if (!args.key) return { _error: 'Pass key (the app to delete).' };
    const problem = customAppKeyProblem(args.key);
    if (problem) return { _error: `Refused: ${problem}.`, _refused_not_managed: true };
    const apps = await listInstalledApps();
    if (apps._error) return apps;
    const installed = apps.find((a) => a.key === args.key);
    if (!installed) return { _error: `No app with key "${args.key}" is installed.`, _hint: 'manage_custom_app(action="list") shows the installed AI apps.' };
    if (!isAssistantBuiltApp(installed)) {
      return { _error: `Refused: "${args.key}" was not built by the DHIS2 AI Assistant, so this tool will not delete it.`, _refused_not_managed: true, _hint: 'Remove other apps in the App Management app.' };
    }
    const gate = requireWriteAuth('manage_custom_app', 'delete', { key: args.key });
    if (gate) return gate;
    let backup = null;
    if (args.skip_backup !== true) {
      const src = await loadCustomAppSource(args.key, installed);
      if (src._error) return { ...src, _hint: 'Without the source no backup can be taken. Retry with skip_backup:true only if the user accepts that the app cannot be restored.' };
      backup = await backupCustomAppVersion(args.key, src, 'delete', `delete ${args.key}`);
      if (backup._error) return backup;
    }
    // Take it off dashboards and out of Capture first: a placement left
    // behind would render as a broken plugin.
    const unplaced = await unplaceCustomAppPlugin({ key: args.key, skip_backup: args.skip_backup }, { internal: true });
    if (unplaced._error) return { _error: `Not deleted: could not remove its placements first — ${unplaced._error}`, backup };
    const delPath = `apps/${encodeURIComponent(args.key)}${args.delete_app_data === true ? '?deleteAppData=true' : ''}`;
    const del = await safeDhis2Fetch(delPath, { method: 'DELETE', allowEmptyBody: true });
    if (del && del._error) return { _error: `DELETE /api/apps/${args.key} failed: ${del._error}`, backup };
    const after = await listInstalledApps();
    const stillThere = Array.isArray(after) && after.some((a) => a.key === args.key);
    return {
      success: !stillThere,
      action: 'delete',
      key: args.key,
      deleted_version: installed.version,
      app_data_deleted: args.delete_app_data === true,
      placements_removed: unplaced.removed && unplaced.removed.length ? unplaced.removed : undefined,
      backup: backup ? { key: backup.backup_key, version: backup.version, restore_hint: `manage_custom_app(action="rollback", key="${args.key}")` } : { skipped: true },
      _error: stillThere ? 'DELETE returned success but the app is still listed.' : undefined,
    };
  }

  // ── preview / create / update ──
  let base = null;
  let installedSource = null;
  let apps = null;
  let key;
  if (action === 'update') {
    if (!args.key) return { _error: 'Pass key (the app to update).', _hint: 'manage_custom_app(action="list") shows the installed AI apps.' };
    const problem = customAppKeyProblem(args.key);
    if (problem) return { _error: `Refused: ${problem}.`, _refused_not_managed: true };
    key = args.key;
    apps = await listInstalledApps();
    if (apps._error) return apps;
    installedSource = await loadCustomAppSource(key, apps.find((a) => a.key === key));
    if (installedSource._error) return installedSource;
    base = installedSource.aiManifest;
  } else {
    const r = resolveCustomAppKey(args);
    if (r._error) return r;
    key = r.key;
  }

  let spec;
  let previewTurnForCreate;
  const files = customAppFilesArg(args);
  if (files === null) return { _error: 'files must be an object like { "app.jsx": "…", "plugin.jsx": "…", "shared.jsx": "…" }.' };
  if (action === 'create' && args.preview_token && !Object.keys(files).length) {
    const pv = await recallCustomAppPreview(args.preview_token);
    if (!pv) return { _error: `Preview ${args.preview_token} has expired.`, _hint: 'Send the same call again with files (and the other arguments) instead of preview_token.' };
    spec = pv.spec;
    if (spec.key !== key) return { _error: `preview_token belongs to "${spec.key}", not "${key}".` };
    previewTurnForCreate = pv.turn;
  } else {
    spec = customAppSpecFromArgs(args, key, base);
    if (action === 'update') {
      spec.sources = { ...installedSource.sources };
      for (const [f, src] of Object.entries(files)) {
        if (src == null || src === '') delete spec.sources[f];
        else spec.sources[f] = src;
      }
      spec.version = args.version || bumpCustomAppVersion(base.version, args.version_bump);
    } else {
      spec.sources = { ...files };
      if (!Object.keys(spec.sources).length) return { _error: 'Pass files: { "app.jsx": "<JSX source>" } (and/or plugin.jsx, shared.jsx).' };
    }
    const bad = customAppSpecProblem(spec);
    if (bad) return bad;
  }

  if (action === 'preview') {
    const prep = await prepareCustomAppBuild(spec);
    if (prep._error) return { preview: true, ...prep };
    apps = await listInstalledApps();
    const conflicts = Array.isArray(apps) ? customAppConflicts(spec, apps, 'create') : [];
    const existing = Array.isArray(apps) ? apps.find((a) => a.key === key) : null;
    const token = await rememberCustomAppPreview(spec);
    return {
      preview: true,
      preview_token: token,
      key, name: spec.name, version: spec.version, kind: spec.kind,
      plugin_type: spec.pluginType || undefined,
      needs_write_access: spec.needsWriteAccess,
      datastore_namespace: spec.namespace || undefined,
      uses_echarts: spec.usesEcharts,
      api_resources: prep.report.api_resources,
      sql_views: prep.report.sql_views && prep.report.sql_views.length ? prep.report.sql_views : undefined,
      verified_uids: prep.report.uid_check.found,
      warnings: prep.report.warnings.length ? prep.report.warnings : undefined,
      server_conflicts: conflicts.length ? conflicts : undefined,
      already_installed: existing ? { version: existing.version, built_by_assistant: isAssistantBuiltApp(existing) } : undefined,
      manifest: prep.pkg.manifest,
      files: prep.pkg.files,
      zip_bytes: prep.pkg.zip.length,
      source: spec.sources,
      next_step: existing && isAssistantBuiltApp(existing)
        ? `Summarise what the change does, ask the user to approve, then manage_custom_app(action="update", key="${key}", files=…).`
        : `Summarise for the user (what it shows, which data it reads${spec.needsWriteAccess ? ', what it WRITES' : ''}, where it will appear) and ask for approval. After "yes": manage_custom_app(action="create", key="${key}", preview_token="${token}").`,
    };
  }

  if (action === 'create') {
    const prep = await prepareCustomAppBuild(spec);
    if (prep._error) return prep;
    const gate = requireWriteAuth('manage_custom_app', 'create', { key, name: spec.name });
    if (gate) return gate;
    const unapproved = customAppApprovalProblem(key, args.preview_token || null, previewTurnForCreate !== undefined ? previewTurnForCreate : await latestPreviewTurn(key));
    if (unapproved) return unapproved;
    apps = await listInstalledApps();
    if (apps._error) return apps;
    const conflicts = customAppConflicts(spec, apps, 'create');
    if (conflicts.length) {
      return { _error: `Not installed: ${conflicts.map((c) => c.message).join(' ')}`, conflicts, _hint: conflicts.map((c) => c.hint).filter(Boolean).join(' ') || undefined };
    }
    const inst = await installCustomAppZip(prep.pkg.zip, key);
    if (inst._error) return inst;
    const ver = await verifyCustomAppInstalled(inst.installedKey, spec.version);
    if (ver._error) return ver;
    return customAppResult('create', spec, { prep, inst, ver });
  }

  // update
  const prep = await prepareCustomAppBuild(spec);
  if (prep._error) return prep;
  const gate = requireWriteAuth('manage_custom_app', 'update', { key, version: spec.version });
  if (gate) return gate;
  const conflicts = customAppConflicts(spec, apps, 'replace');
  if (conflicts.length) return { _error: conflicts.map((c) => c.message).join(' '), conflicts };
  let backup = null;
  if (args.skip_backup !== true) {
    backup = await backupCustomAppVersion(key, installedSource, 'update', `update ${key} ${base.version} → ${spec.version}`);
    if (backup._error) return backup;
  }
  const inst = await installCustomAppZip(prep.pkg.zip, key);
  if (inst._error) return { ...inst, backup };
  const ver = await verifyCustomAppInstalled(inst.installedKey, spec.version);
  if (ver._error) return ver;
  return customAppResult('update', spec, { prep, inst, ver }, {
    previous_version: base.version,
    changed_files: Object.keys(files),
    backup: backup ? { key: backup.backup_key, version: backup.version, rollback_hint: `manage_custom_app(action="rollback", key="${key}")` } : { skipped: true },
  });
}
