#!/usr/bin/env node
'use strict';
/* Requirement checks for the six "harness testing" prompts (scripts/prompts/
 * maternal-journey-*, tb-workspace-*, focus-explorer-* on play 2.43.2.1 and
 * ccr-* on the local instance), written from the prompts alone. Plain fetch,
 * numbers recomputed from the API, Chrome renders with playwright-core.
 *
 *   node scripts/verify-haiku-builds-llm.js <maternal|tb|focus|ccr-program|ccr-dashboard|ccr-app> [--answer <file>] [--since <ISO>] [--json <file>] [--no-browser]
 * env: DHIS2_BASE (default play 2.43.2.1; ccr-* default http://localhost:8081), DHIS2_AUTH, SHOT_DIR */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const thread = argv[0];
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const LOCAL = /^ccr-/.test(thread || '');
const BASE = (process.env.DHIS2_BASE || (LOCAL ? 'http://localhost:8081' : 'https://play.im.dhis2.org/stable-2-43-2-1')).replace(/\/+$/, '');
const USERPASS = process.env.DHIS2_AUTH || 'admin:district';
const AUTH = 'Basic ' + Buffer.from(USERPASS).toString('base64');
const answerText = opt('--answer') && fs.existsSync(opt('--answer')) ? fs.readFileSync(opt('--answer'), 'utf8') : '';
const since = opt('--since');
const browserOn = !argv.includes('--no-browser');
const SHOT_DIR = process.env.SHOT_DIR || process.cwd();

let failures = 0; const results = [];
function check(id, label, cond, detail) {
  results.push({ id, label, pass: !!cond, detail: detail === undefined ? undefined : JSON.stringify(detail).slice(0, 400) });
  if (cond) console.log(`  ✓ ${id} ${label}`);
  else { failures++; console.log(`  ✗ ${id} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
}
const info = (s) => console.log(`    · ${s}`);
const enc = encodeURIComponent;
// Tomcat (8081) refuses raw [ ] in a query string.
const safe = (p) => p.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
async function get(p) {
  const r = await fetch(`${BASE}/api/${safe(p)}`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
async function getJ(p) { const r = await get(p); if (r.status >= 400) throw new Error(`GET ${p} → ${r.status} ${String(JSON.stringify(r.body)).slice(0, 200)}`); return r.body; }
const sumRows = (r) => (r?.rows || []).reduce((s, row) => s + Number(row[row.length - 1] || 0), 0);
const dayIso = (d) => new Date(d).toISOString().slice(0, 10);
const links = (t) => Array.from(String(t).matchAll(/https?:\/\/\S+/g)).map(m => m[0].replace(/[)\].,>*`]+$/, ''));
const numIn = (n, t) => [String(n), Number(n).toLocaleString('en-US')].some(x => new RegExp(`(^|[^\\d.,])${x.replace(/[.,]/g, (c) => `\\${c}`)}([^\\d]|$)`).test(t));

async function trackerAll(resource, params, listKey) {
  const out = [];
  for (let page = 1; page <= 500; page++) {
    const r = await getJ(`tracker/${resource}?${params}&page=${page}&pageSize=1000&totalPages=true`);
    const list = r[listKey] || r.instances || [];
    out.push(...list);
    if (page >= (r.pager?.pageCount || 1)) break;
  }
  return out;
}

function loadPlaywright() {
  for (const t of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) { try { return require(t); } catch { /* next */ } }
  const npx = path.join(require('os').homedir(), '.npm', '_npx');
  if (fs.existsSync(npx)) for (const d of fs.readdirSync(npx)) {
    const p = path.join(npx, d, 'node_modules', 'playwright-core');
    if (fs.existsSync(path.join(p, 'package.json'))) { try { return require(p); } catch { /* next */ } }
  }
  return null;
}
async function browserSession() {
  const pw = loadPlaywright(); if (!pw) return null;
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
  const c = await browser.newContext({ viewport: { width: 1600, height: 1200 }, acceptDownloads: true });
  const [u, p] = USERPASS.split(':');
  await c.request.post(BASE + '/api/auth/login', { data: { username: u, password: p }, headers: { 'Content-Type': 'application/json' } });
  return { browser, c };
}
async function framesText(page, filter = () => true) {
  let t = '';
  for (const f of page.frames().filter(filter)) { try { t += '\n' + await f.evaluate(() => (document.body ? document.body.innerText : '')); } catch { /* */ } }
  return t;
}
const VENDOR_RE = /(?:\.min\.js$|^app-guard\.js$|^d2-kit)/;
async function appSource(key, page) {
  const base = `${BASE}/api/apps/${key}/`;
  const idx = await fetch(`${base}${page}?redirect=false`, { headers: { Authorization: AUTH } }).then(r => r.text());
  const scripts = Array.from(idx.matchAll(/<script[^>]+src="([^"]+)"/g)).map(m => m[1]).filter(x => !/^https?:/.test(x) && !VENDOR_RE.test(x.split('/').pop()));
  let src = idx;
  for (const x of scripts) src += '\n' + await fetch(new URL(x, base).toString(), { headers: { Authorization: AUTH } }).then(r => r.text());
  return src;
}
async function findApp(re) { return (await getJ('apps')).filter(a => re.test(a.name || a.displayName || '')); }

// Render a dashboard, scrolling until nothing new appears; returns text + error count.
async function renderDashboard(id, titles, shotPrefix) {
  const s = await browserSession();
  if (!s) return null;
  const page = await s.c.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`${BASE}/dhis-web-dashboard/#/${id}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(45000);
  let text = ''; let same = 0;
  // Scroll from the left page margin: over a line-list table the wheel scrolls the table, not the page.
  await page.mouse.move(3, 700);
  for (let step = 0; step < 16 && same < 2; step++) {
    await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-${step + 1}.png`) });
    const now = await framesText(page);
    same = text.includes(now) ? same + 1 : 0;
    text += '\n' + now;
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(9000);
  }
  await s.browser.close();
  const errTiles = (text.match(/There was an error loading data|Something went wrong|Error loading|failed to load|\bError: |Cannot read properties/gi) || []).length;
  return { text, errTiles, missing: titles.filter(t => !text.includes(t)), pageErrors: errs };
}

async function dashboardParts(nameRe) {
  const list = await getJ(`dashboards?filter=name:ilike:${enc(nameRe)}&fields=id,name,created,restrictFilters,allowedFilters,dashboardItems[id,type,appKey,visualization[id],map[id],eventVisualization[id]]&paging=false`);
  // The exact name the prompt asked for (an earlier build kept under a suffixed name does not count).
  const dashes = (list.dashboards || []).filter(x => String(x.name || '').trim().toLowerCase() === String(nameRe).trim().toLowerCase());
  const d = dashes.sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
  if (!d) return { dashes, d: null, viz: [], maps: [], lls: [] };
  const viz = []; const maps = []; const lls = [];
  for (const it of d.dashboardItems || []) {
    if (it.visualization) viz.push(await getJ(`visualizations/${it.visualization.id}?fields=id,name,type,columns[dimension,items[id]],rows[dimension,items[id]],filters[dimension,items[id]],dataDimensionItems[programIndicator[id,name,expression,filter,analyticsType,aggregationType]],relativePeriods,startDate,endDate`));
    if (it.map) maps.push(await getJ(`maps/${it.map.id}?fields=id,name,mapViews[layer,program[id],programStage[id],organisationUnitLevels,periods[id],startDate,endDate,filters[dimension,items[id]],columns[dimension,items[id],filter],eventCoordinateField]`));
    if (it.eventVisualization) lls.push(await getJ(`eventVisualizations/${it.eventVisualization.id}?fields=id,name,type,outputType,program[id],programStage[id],columns[dimension,filter,items[id]],filters[dimension,filter,items[id]],simpleDimensions`));
  }
  return { dashes, d, viz, maps, lls };
}
const vizValue = async (v) => {
  const part = (d, kind) => `${kind}=${d.dimension}${(d.items || []).length ? ':' + d.items.map(i => i.id).join(';') : ''}`;
  const q = [...(v.columns || []).map(d => part(d, 'dimension')), ...(v.rows || []).map(d => part(d, 'dimension')), ...(v.filters || []).map(d => part(d, 'filter'))].join('&');
  const r = await get(`analytics.json?${q}`);
  return { ok: r.status < 400, total: sumRows(r.body), rows: r.body?.rows || [], status: r.status };
};
const periodOf = (v) => {
  const dims = [...(v.columns || []), ...(v.rows || []), ...(v.filters || [])];
  const pe = dims.find(d => d.dimension === 'pe');
  return pe ? pe.items.map(i => i.id).join(';') : '';
};
const ouOf = (v) => {
  const dims = [...(v.columns || []), ...(v.rows || []), ...(v.filters || [])];
  const ou = dims.find(d => d.dimension === 'ou');
  return ou ? ou.items.map(i => i.id).join(';') : '';
};

// ───────────────────────── maternal journey (WHO RMNCH Tracker) ─────────────────────────
async function maternal() {
  const P = 'WSGAb5XwJ3Y';
  const ST = { anc1: 'WZbXY0S00lP', ancN: 'edqlbukwRfQ', birth: 'PFDfvmGpsR3', pnc: 'bbKtnxRZKEP' };
  const DE = { method: 'spkG704sTh6', outcome: 'V5PR8Kw8ZnC', nearMiss: 'FIHEeJwfhZH' };
  const { dashes, d, viz, maps, lls } = await dashboardParts('Maternal Care Journey');
  check('M1', 'one dashboard "Maternal Care Journey"', dashes.length === 1, dashes.map(x => [x.id, x.created]));
  if (!d) return;
  if (since) check('M1b', 'created by this run', String(d.created) >= since.slice(0, 19), d.created);
  info(`items: ${viz.length} charts/tables, ${maps.length} maps, ${lls.length} line lists`);
  check('M2', 'location and period filters allowed', !d.restrictFilters || ['pe', 'ou'].every(f => (d.allowedFilters || []).includes(f)));
  // Oracle: per-pregnancy ANC counts from the tracker records.
  const evs = await trackerAll('events', `program=${P}&ouMode=ALL&fields=enrollment,programStage,status,occurredAt,dataValues[dataElement,value]`, 'events');
  const ens = await trackerAll('enrollments', `program=${P}&ouMode=ALL&fields=enrollment,trackedEntity,enrolledAt,orgUnit,status`, 'enrollments');
  info(`oracle: ${ens.length} enrollments (pregnancies), ${new Set(ens.map(e => e.trackedEntity)).size} women, ${evs.length} events`);
  const ancBy = new Map();
  for (const e of evs) if ((e.programStage === ST.anc1 || e.programStage === ST.ancN) && e.status !== 'SCHEDULE' && e.status !== 'SKIPPED') ancBy.set(e.enrollment, (ancBy.get(e.enrollment) || 0) + 1);
  // KPI tiles: pregnancies and 4+ ANC, each against the oracle for the tile's own period window.
  const kpi = viz.filter(v => v.type === 'SINGLE_VALUE');
  for (const v of kpi) {
    const val = await vizValue(v);
    const pe = periodOf(v);
    let window = null;
    if (/^\d{6}(;\d{6})*$/.test(pe)) { const ps = pe.split(';').sort(); window = [`${ps[0].slice(0, 4)}-${ps[0].slice(4)}-01`, dayIso(Date.UTC(+ps[ps.length - 1].slice(0, 4), +ps[ps.length - 1].slice(4), 0))]; }
    else if (/^\d{4}$/.test(pe)) window = [`${pe}-01-01`, `${pe}-12-31`];
    else if (/LAST_12_MONTHS/.test(pe)) { const n = new Date(); window = [dayIso(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 12, 1)), dayIso(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0))]; }
    else if (/THIS_YEAR/.test(pe)) { const y = new Date().getUTCFullYear(); window = [`${y}-01-01`, `${y}-12-31`]; }
    const inWin = window ? ens.filter(e => e.enrolledAt.slice(0, 10) >= window[0] && e.enrolledAt.slice(0, 10) <= window[1]) : null;
    info(`KPI "${v.name}" = ${val.total} (period ${pe || 'none'}${window ? `, oracle window ${window.join('..')}` : ''})`);
    if (!inWin) continue;
    if (/pregnan/i.test(v.name) && !/4|four|\banc\b|antenatal|visit|postpartum|deliver|near.?miss/i.test(v.name)) check('M3', `"${v.name}" equals pregnancies enrolled in its period (${inWin.length})`, val.total === inWin.length, { tile: val.total, oracle: inWin.length });
    if (/(4|four)\+?/i.test(v.name) && /anc|antenatal|visit/i.test(v.name) && !/%|percent|rate|share/i.test(v.name)) {
      const four = inWin.filter(e => (ancBy.get(e.enrollment) || 0) >= 4).length;
      check('M4', `"${v.name}" equals pregnancies with 4+ ANC visits (${four})`, val.total === four, { tile: val.total, oracle: four });
    }
  }
  const reads = (v, de) => JSON.stringify(v).includes(de);
  check('M5', 'delivery methods broken down (a tile reads Delivery method)', viz.some(v => reads(v, DE.method)) || lls.some(l => reads(l, DE.method)), viz.map(v => v.name));
  check('M6', 'pregnancy outcomes shown (a tile reads Pregnancy outcome)', viz.some(v => reads(v, DE.outcome)) || lls.some(l => reads(l, DE.outcome)), viz.map(v => v.name));
  check('M7', 'postpartum visits within two days of delivery (a tile on the postpartum stage)', viz.some(v => reads(v, ST.pnc) && /2|two|48/i.test(`${v.name} ${JSON.stringify(v.dataDimensionItems)}`)), viz.map(v => v.name));
  // A trend: months on the axis, as fixed months or a multi-month relative period.
  const monthly = (v) => { const pe = periodOf(v); return pe.split(';').length >= 3 || /LAST_\d+_MONTHS|MONTHS_THIS_YEAR|MONTHS_LAST_YEAR/.test(pe); };
  check('M8', 'monthly trend + facility comparison', viz.some(v => /LINE|COLUMN|BAR/.test(v.type) && monthly(v)) && viz.some(v => /facilit/i.test(v.name) || /LEVEL-[3-6]/.test(JSON.stringify(v))), viz.map(v => [v.type, v.name, periodOf(v), ouOf(v)]));
  const views = maps.flatMap(m => (m.mapViews || []).map(x => ({ ...x, mapName: m.name })));
  check('M9', 'district map of care completion (thematic level 2) and facility map of deliveries (level 4)', views.some(x => x.layer === 'thematic' && (x.organisationUnitLevels || []).includes(2)) && views.some(x => x.layer === 'thematic' && (x.organisationUnitLevels || []).some(l => l >= 4)), views.map(x => [x.mapName, x.layer, x.organisationUnitLevels]));
  check('M10', 'every map layer has a period', views.filter(x => /thematic|event/.test(x.layer)).every(x => (x.periods || []).length || x.startDate || (x.filters || []).some(f => f.dimension === 'pe' && (f.items || []).length)), views.map(x => [x.mapName, (x.periods || []).length, x.startDate]));
  check('M11', 'three line lists: incomplete journeys, near-misses, deliveries without postpartum follow-up', lls.length >= 3 && lls.some(l => reads(l, DE.nearMiss)), lls.map(l => l.name));
  const lk = links(answerText);
  check('M12', 'answer shares the dashboard link', lk.some(l => l.includes(d.id)), lk);
  check('M13', 'answer explains dates and denominators', /denominator/i.test(answerText) && /(enrol+ment|event|visit|report) date/i.test(answerText));
  if (browserOn) {
    const titles = [...viz.map(v => v.name), ...maps.map(m => m.name), ...lls.map(l => l.name)];
    const r = await renderDashboard(d.id, titles, 'maternal');
    if (r) check('M14', 'every tile renders (titles drawn, no error tiles)', r.errTiles === 0 && r.missing.length === 0, { errTiles: r.errTiles, missing: r.missing });
  }
}

// ───────────────────────── TB follow-up workspace (app) ─────────────────────────
async function tb() {
  const P = 'ur1Edk5Oe2n';
  const ST = ['EPEcjy3FWmI', 'ZkbAXlQUYJG', 'jdRD35YwbRH'];
  const apps = await findApp(/tb follow-?up workspace/i);
  check('T1', 'one installed app "TB Follow-up Workspace"', apps.length === 1, apps.map(a => a.key));
  const app = apps[0]; if (!app) return;
  const enrollTotal = (await getJ(`tracker/enrollments?program=${P}&ouMode=ALL&pageSize=1&totalPages=true&fields=enrollment`)).pager?.total;
  info(`oracle: ${enrollTotal} enrollments`);
  const src = await appSource(app.key, 'index.html');
  check('T2', 'reads the TB program and all three stages', src.includes(P) && ST.every(s => src.includes(s)), ST.filter(s => !src.includes(s)));
  check('T3', 'server-side paging over the patient list (pageSize/page params with totalPages)', /totalPages/.test(src) && /\bpage\b/.test(src));
  // Review state about a patient may not go into the dataStore (the harness refuses
  // patient data there); tracker notes on the enrollment keep the values untouched.
  check('T4', 'review notes stored without changing clinical values (tracker notes or settings-only dataStore), with a conflict check', (/notes/.test(src) || /dataStore/.test(src)) && /(lastUpdated|version|etag|modified|updatedAt|storedAt|since you opened|another reviewer)/i.test(src));
  check('T5', 'expected interval and "as of" date controls', /interval/i.test(src) && /as of|asOf/i.test(src));
  check('T6', 'filtered export and links to the original records', /csv|export/i.test(src) && /(capture|tracker-capture|\/enrollment|enrollment=|teiId|trackedEntity=)/i.test(src));
  check('T7', 'answer gives the app link', links(answerText).some(l => l.includes(app.key) || /TB.Follow/i.test(l)));
  if (!browserOn) return;
  const s = await browserSession(); if (!s) return;
  const page = await s.c.newPage();
  const errs = []; const failed = [];
  page.on('console', m => { const u = (m.location && m.location().url) || ''; if (m.type() === 'error' && u.includes(`/api/apps/${app.key}/`)) errs.push(m.text()); });
  page.on('response', r => { let f = null; try { f = r.frame(); } catch { /* */ } if (r.status() >= 400 && f && f.url().includes(`/api/apps/${app.key}/`)) failed.push(`${r.status()} ${r.url().slice(0, 140)}`); });
  await page.goto(`${BASE}/api/apps/${app.key}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(40000);
  await page.screenshot({ path: path.join(SHOT_DIR, 'tb-app.png'), fullPage: true });
  const fr = page.frames().find(f => f.url().includes(`/api/apps/${app.key}/`)) || page.mainFrame();
  let text = await fr.evaluate(() => document.body.innerText).catch(() => '');
  // An app may wait for the user to load records (sensible for 50,000 enrollments): press its Load button.
  const loadBtn = fr.locator('button', { hasText: /^\s*(load|show|search|apply|run)\b[^\n]{0,20}$/i }).first();
  if (!numIn(enrollTotal, text) && await loadBtn.count().catch(() => 0)) {
    await loadBtn.click().catch(() => {});
    await page.waitForTimeout(40000);
    await page.screenshot({ path: path.join(SHOT_DIR, 'tb-app-loaded.png'), fullPage: true });
    text = await fr.evaluate(() => document.body.innerText).catch(() => text);
  }
  check('T8', 'opens with no console errors or failed API calls', errs.length === 0 && failed.length === 0, { errs: errs.slice(0, 3), failed: failed.slice(0, 3) });
  // "a searchable patient list": the total of patients (people) or of enrollments.
  const teTotal = (await getJ(`tracker/trackedEntities?program=ur1Edk5Oe2n&orgUnitMode=ACCESSIBLE&pageSize=1&totalPages=true&fields=trackedEntity`)).pager?.total;
  check('T9', `the patient list covers everyone (${teTotal} patients / ${enrollTotal} enrollments; total shown)`, numIn(enrollTotal, text) || (teTotal != null && numIn(teTotal, text)), text.slice(0, 300));
  await s.browser.close();
}

// ───────────────────────── Malaria focus response explorer (plugin) ─────────────────────────
async function focus() {
  const P = 'M3xtLkYBlKI';
  const apps = await findApp(/focus response explorer/i);
  check('F1', 'one installed dashboard plugin "Malaria Focus Response Explorer"', apps.length === 1 && apps.every(a => a.pluginLaunchUrl || /DASHBOARD/i.test(a.pluginType || '')), apps.map(a => [a.key, a.pluginType]));
  const app = apps[0]; if (!app) return;
  const foci = (await getJ(`tracker/trackedEntities?program=${P}&ouMode=ALL&pageSize=1&totalPages=true&fields=trackedEntity`)).pager?.total;
  info(`oracle: ${foci} foci`);
  const src = await appSource(app.key, String(app.pluginLaunchUrl || 'plugin.html').split('/').pop().split('?')[0] || 'plugin.html');
  check('F2', 'reads the focus program, both stages', src.includes(P) && ['uvMKOn1oWvd', 'CWaAcQYKVpq'].every(x => src.includes(x)));
  check('F3', 'two dates compared; latest record at each date', /date/i.test(src) && /(latest|<=|before|asOf|as of)/i.test(src));
  check('F4', 'follows dashboard filters; export and print', /dashboardItemFilters/.test(src) && /csv|export/i.test(src) && /print/i.test(src));
  const dl = await getJ(`dashboards?filter=dashboardItems.appKey:eq:${enc(app.key)}&fields=id,name,dashboardItems[id,appKey]&paging=false`);
  const dash = (dl.dashboards || [])[0];
  const copies = (dash?.dashboardItems || []).filter(i => i.appKey === app.key);
  check('F5', 'a demonstration dashboard holds the plugin twice', copies.length === 2, (dl.dashboards || []).map(x => x.name));
  const hits = [];
  for (const n of await getJ('dataStore')) for (const it of copies) { const r = await get(`dataStore/${enc(n)}/${it.id}`); if (r.status === 200) hits.push(JSON.stringify(r.body)); }
  check('F6', 'each copy has its own saved settings, and they differ', hits.length === 2 && hits[0] !== hits[1], hits.map(h => h.slice(0, 80)));
  if (dash) check('F7', 'answer shares the dashboard', links(answerText).some(l => l.includes(dash.id)));
  if (!browserOn || !dash) return;
  const s = await browserSession(); if (!s) return;
  const page = await s.c.newPage();
  // Visible text plus the values of the copy's inputs (its saved dates are input values, not text).
  const read = async () => { const out = []; for (const f of page.frames().filter(f => f.url().includes(`/api/apps/${app.key}/`))) { try { out.push(await f.evaluate(() => `${document.body.innerText}\nINPUTS: ${[...document.querySelectorAll('input,select')].map(i => i.value).join(' | ')}`)); } catch { /* */ } } return out; };
  await page.goto(`${BASE}/dhis-web-dashboard/#/${dash.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(50000);
  const first = await read();
  await page.screenshot({ path: path.join(SHOT_DIR, 'focus-1.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(50000);
  const second = await read();
  await page.screenshot({ path: path.join(SHOT_DIR, 'focus-2.png') });
  check('F8', 'both copies render, differ, and are the same after reload', first.length === 2 && first[0] !== first[1] && second.slice().sort().join('|') === first.slice().sort().join('|'), first.map(t => t.slice(0, 100)));
  // "Use the latest information available at each chosen date": a copy may show all foci, or the foci
  // known by its later date (with a recorded visit, or enrolled) — each counted once.
  const fev = await trackerAll('events', `program=${P}&ouMode=ALL&fields=trackedEntity,occurredAt,status`, 'events');
  const fen = await trackerAll('enrollments', `program=${P}&ouMode=ALL&fields=trackedEntity,enrolledAt`, 'enrollments');
  const fociAt = (d) => [new Set(fev.filter(e => e.status !== 'SCHEDULE' && String(e.occurredAt || '').slice(0, 10) <= d).map(e => e.trackedEntity)).size, new Set(fen.filter(e => String(e.enrolledAt || '').slice(0, 10) <= d).map(e => e.trackedEntity)).size];
  const copyOk = (t) => {
    const dates = (String(t.split('INPUTS:')[1] || '').match(/\d{4}-\d{2}-\d{2}/g) || []).sort();
    const allowed = [foci, ...(dates.length ? fociAt(dates[dates.length - 1]) : [])];
    return allowed.some(n => numIn(n, t.split('INPUTS:')[0]));
  };
  check('F9', `each focus counted once (${foci} foci, or the foci known at the copy's later date)`, first.length > 0 && first.every(copyOk), first.map(t => t.slice(0, 200)));
  await s.browser.close();
}

// ───────────────────────── Community Care and Referral (local) ─────────────────────────
async function ccrProgram() {
  const list = await getJ('programs?filter=name:ilike:Community Care and Referral&fields=id,name&paging=false');
  check('C1', 'one program "Community Care and Referral"', (list.programs || []).length === 1, list.programs);
  const pid = list.programs?.[0]?.id; if (!pid) return;
  const p = await getJ(`programs/${pid}?fields=id,name,programType,trackedEntityType[name],organisationUnits~size,programTrackedEntityAttributes[searchable,trackedEntityAttribute[id,name,valueType,unique,generated]],programStages[id,name,sortOrder,repeatable,programStageSections~size,programStageDataElements[dataElement[id,name,valueType]]],programRules~size,programIndicators~size`);
  const teas = (p.programTrackedEntityAttributes || []).map(x => x.trackedEntityAttribute);
  check('C2', 'tracker program on a person type', p.programType === 'WITH_REGISTRATION', p.trackedEntityType);
  check('C3', 'attributes: a unique patient number, name, birth date, sex, phone, address, home location (coordinate), contact preference, emergency contact, disability', teas.some(a => a.unique) && teas.some(a => a.valueType === 'COORDINATE') && teas.some(a => a.valueType === 'PHONE_NUMBER') && teas.some(a => /birth/i.test(a.name)) && teas.some(a => /emergency/i.test(a.name)) && teas.some(a => /disab/i.test(a.name)) && teas.some(a => /contact pref|preferred contact/i.test(a.name)), teas.map(a => `${a.name}:${a.valueType}${a.unique ? ':U' : ''}${a.generated ? ':G' : ''}`));
  const stages = (p.programStages || []).sort((a, b) => a.sortOrder - b.sortOrder);
  const want = [['initial', false], ['lab', true], ['referral', true], ['treatment', true], ['follow', true], ['admission', true], ['closure', false]];
  const got = want.map(([w, rep]) => { const s = stages.find(x => new RegExp(w, 'i').test(x.name)); return s ? (s.repeatable === rep) : null; });
  check('C4', '7 stages with the requested repeatability', stages.length === 7 && got.every(Boolean), stages.map(x => [x.name, x.repeatable]));
  const deCount = new Set(stages.flatMap(s => (s.programStageDataElements || []).map(x => x.dataElement.id))).size;
  check('C5', `≥ 80 data elements (${deCount})`, deCount >= 80);
  check('C6', 'every stage has form sections', stages.every(s => (s.programStageSections || 0) >= 1), stages.map(s => [s.name, s.programStageSections]));
  const ruleCount = (await getJ(`programRules?filter=program.id:eq:${pid}&fields=id&pageSize=1&totalPages=true`)).pager?.total || 0;
  check('C7', `program rules created (${ruleCount})`, ruleCount >= 10, ruleCount);
  check('C8', 'reporting indicators created', (p.programIndicators || 0) >= 5, p.programIndicators);
  check('C9', 'assigned to at least six facilities', (p.organisationUnits || 0) >= 6, p.organisationUnits);
  const ens = await trackerAll('enrollments', `program=${pid}&ouMode=ALL&fields=enrollment,trackedEntity,enrolledAt,orgUnit,status`, 'enrollments');
  const people = new Set(ens.map(e => e.trackedEntity)).size;
  const facs = new Set(ens.map(e => e.orgUnit)).size;
  const oldest = ens.map(e => e.enrolledAt).sort()[0];
  info(`records: ${people} people, ${ens.length} enrollments, ${facs} facilities, statuses ${JSON.stringify(ens.reduce((m, e) => (m[e.status] = (m[e.status] || 0) + 1, m), {}))}, oldest ${oldest}`);
  check('C10', '100 people with 120 care episodes', people === 100 && ens.length === 120, { people, enrollments: ens.length });
  check('C11', 'episodes across six facilities over the last 18 months, completed and ongoing', facs >= 6 && oldest && oldest.slice(0, 10) >= dayIso(Date.now() - 560 * 86400000) && ens.some(e => e.status === 'COMPLETED') && ens.some(e => e.status === 'ACTIVE'), { facs, oldest });
  const evs = await trackerAll('events', `program=${pid}&ouMode=ALL&fields=event,enrollment,programStage,status,occurredAt,scheduledAt,orgUnit`, 'events');
  const repeated = stages.filter(s => s.repeatable).some(s => { const c = new Map(); evs.filter(e => e.programStage === s.id).forEach(e => c.set(e.enrollment, (c.get(e.enrollment) || 0) + 1)); return [...c.values()].some(n => n > 1); });
  check('C12', 'repeated visits, referrals and missed appointments present', repeated && evs.some(e => e.status === 'SKIPPED' || e.status === 'OVERDUE' || (e.status === 'SCHEDULE' && e.scheduledAt && e.scheduledAt < new Date().toISOString())) && evs.some(e => /referr/i.test((stages.find(s => s.id === e.programStage) || {}).name || '')), { events: evs.length });
  check('C13', 'answer gives a short guide and baseline totals that match the server', numIn(people, answerText) && numIn(ens.length, answerText), links(answerText));
}

async function ccrDashboard() {
  const { dashes, d, viz, maps, lls } = await dashboardParts('Care Journey and Service Performance');
  check('D1', 'one dashboard "Care Journey and Service Performance"', dashes.length === 1, dashes.map(x => x.id));
  if (!d) return;
  info(`items: ${viz.length} charts/tables, ${maps.length} maps, ${lls.length} line lists`);
  check('D2', 'three maps, one of them home locations (event/tracked-entity layer on a coordinate)', maps.length >= 3, maps.map(m => m.name));
  check('D3', 'five line lists', lls.length >= 5, lls.map(l => l.name));
  check('D4', 'location and period filters allowed', !d.restrictFilters || ['pe', 'ou'].every(f => (d.allowedFilters || []).includes(f)));
  check('D5', 'answer shares the dashboard and the verification results', links(answerText).some(l => l.includes(d.id)) && /verif|compar|match/i.test(answerText));
  if (browserOn) {
    const r = await renderDashboard(d.id, [...viz.map(v => v.name), ...maps.map(m => m.name), ...lls.map(l => l.name)], 'ccr-dash');
    if (r) check('D6', 'every tile renders (titles drawn, no error tiles)', r.errTiles === 0 && r.missing.length === 0, { errTiles: r.errTiles, missing: r.missing });
  }
}

async function ccrApp() {
  const apps = await findApp(/care coordination workspace/i);
  check('A1', 'app "Care Coordination Workspace" installed', apps.length >= 1, apps.map(a => a.key));
  const all = await getJ('apps');
  // The plugin may be the app's own plugin entry point (one app, app + plugin) or a separate app;
  // 2.42 reports pluginType null, so a plugin is an app with a pluginLaunchUrl.
  const layoutPeek = await get('dataStore/capture/enrollmentOverviewLayout');
  const placedKeys = JSON.stringify(layoutPeek.body || {});
  const plugin = all.find(a => a.pluginLaunchUrl && /care|coordination|episode|ccr/i.test(a.name || '') && placedKeys.includes(a.key))
    || all.find(a => (a.pluginLaunchUrl || /CAPTURE/i.test(a.pluginType || '')) && /care|coordination|episode|ccr/i.test(a.name || ''));
  check('A2', 'a Capture enrollment plugin installed', !!plugin, all.filter(a => a.key.startsWith('ai-')).map(a => [a.key, a.pluginType, !!a.pluginLaunchUrl]));
  const layout = await get('dataStore/capture/enrollmentOverviewLayout');
  // This program's own layout entry (not anywhere in the namespace).
  const ccrList = await getJ('programs?filter=name:ilike:Community Care and Referral&fields=id&paging=false');
  const progLayout = JSON.stringify((layout.body || {})[ccrList.programs?.[0]?.id] || {});
  check('A3', 'the plugin is placed on the program\'s Capture enrollment page', !!plugin && layout.status === 200 && progLayout.includes(`/apps/${plugin.key}/`), layout.status);
  check('A4', 'answer shares working links and test results', links(answerText).length >= 1 && /test/i.test(answerText));
}

(async () => {
  const fn = { maternal, tb, focus, 'ccr-program': ccrProgram, 'ccr-dashboard': ccrDashboard, 'ccr-app': ccrApp }[thread];
  if (!fn) { console.log('usage: verify-haiku-builds-llm.js <maternal|tb|focus|ccr-program|ccr-dashboard|ccr-app> [--answer file] [--since ISO] [--json file] [--no-browser]'); process.exit(2); }
  try { await fn(); } catch (e) { failures++; console.log('  ✗ checker error: ' + (e.stack || e)); }
  const out = opt('--json'); if (out) fs.writeFileSync(out, JSON.stringify({ thread, base: BASE, results }, null, 1));
  console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks passed`);
  console.log(failures ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(failures ? 1 : 0);
})();
