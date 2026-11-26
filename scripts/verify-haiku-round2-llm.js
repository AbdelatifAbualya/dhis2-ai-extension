#!/usr/bin/env node
'use strict';
/* Requirement checks for the second Haiku harness round (2026-11-25), written from the
 * prompts alone before any run (scripts/prompts/epi-dashboard-1, epi-scorecard-1-plugin,
 * child-vax-1-app on play 2.43.2.1; pregnancy-card-1-plugin, anc-bp-1-field-plugin on the
 * local instance). Plain fetch, numbers recomputed from the API, Chrome with playwright-core.
 *
 *   node scripts/verify-haiku-round2-llm.js <epi-dashboard|epi-scorecard|child-vax|pregnancy-card|anc-bp>
 *        [--answer <file>] [--since <ISO>] [--json <file>] [--no-browser]
 * env: DHIS2_BASE (default play 2.43.2.1; pregnancy-card/anc-bp default http://localhost:8081),
 *      DHIS2_AUTH, SHOT_DIR, SNAP_DIR (snapshot of capture/* before the run, for "other entries unchanged") */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const thread = argv[0];
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const LOCAL = /^(pregnancy-card|anc-bp)$/.test(thread || '');
const BASE = (process.env.DHIS2_BASE || (LOCAL ? 'http://localhost:8081' : 'https://play.im.dhis2.org/stable-2-43-2-1')).replace(/\/+$/, '');
const USERPASS = process.env.DHIS2_AUTH || 'admin:district';
const AUTH = 'Basic ' + Buffer.from(USERPASS).toString('base64');
const answerText = opt('--answer') && fs.existsSync(opt('--answer')) ? fs.readFileSync(opt('--answer'), 'utf8') : '';
const since = opt('--since');
const browserOn = !argv.includes('--no-browser');
const SHOT_DIR = process.env.SHOT_DIR || process.cwd();

let failures = 0; const results = [];
function check(id, label, cond, detail) {
  results.push({ id, label, pass: !!cond, detail: detail === undefined ? undefined : JSON.stringify(detail).slice(0, 600) });
  if (cond) console.log(`  ✓ ${id} ${label}`);
  else { failures++; console.log(`  ✗ ${id} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : ''}`); }
}
const info = (s) => console.log(`    · ${s}`);
const enc = encodeURIComponent;
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
const TODAY = dayIso(Date.now());
const links = (t) => Array.from(String(t).matchAll(/https?:\/\/\S+/g)).map(m => m[0].replace(/[)\].,>*`]+$/, ''));
const numIn = (n, t) => [String(n), Number(n).toLocaleString('en-US')].some(x => new RegExp(`(^|[^\\d.,])${x.replace(/[.,]/g, (c) => `\\${c}`)}([^\\d]|$)`).test(t));

async function trackerAll(resource, params, listKey) {
  const out = [];
  for (let page = 1; page <= 500; page++) {
    const r = await getJ(`tracker/${resource}?${params}&page=${page}&pageSize=1000&totalPages=true`);
    out.push(...(r[listKey] || r.instances || []));
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
const isPlugin = (a) => !!(a && (a.pluginLaunchUrl || /DASHBOARD|CAPTURE/i.test(a.pluginType || '')));
const pluginPage = (a) => String(a.pluginLaunchUrl || 'plugin.html').split('/').pop().split('?')[0] || 'plugin.html';

async function renderDashboard(id, titles, shotPrefix) {
  const s = await browserSession();
  if (!s) return null;
  const page = await s.c.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`${BASE}/dhis-web-dashboard/#/${id}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(45000);
  let text = ''; let same = 0;
  await page.mouse.move(3, 700);
  for (let step = 0; step < 18 && same < 2; step++) {
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

async function dashboardParts(name) {
  const list = await getJ(`dashboards?filter=name:ilike:${enc(name)}&fields=id,name,created,restrictFilters,allowedFilters,dashboardItems[id,type,appKey,visualization[id],map[id],eventVisualization[id],text]&paging=false`);
  const dashes = (list.dashboards || []).filter(x => String(x.name || '').trim().toLowerCase() === String(name).trim().toLowerCase());
  const d = dashes.sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
  if (!d) return { dashes, d: null, viz: [], maps: [], lls: [] };
  const viz = []; const maps = []; const lls = [];
  for (const it of d.dashboardItems || []) {
    if (it.visualization) viz.push(await getJ(`visualizations/${it.visualization.id}?fields=id,name,type,columns[dimension,items[id,dimensionItem]],rows[dimension,items[id,dimensionItem]],filters[dimension,items[id,dimensionItem]],dataDimensionItems[dataDimensionItemType,indicator[id],reportingRate[id],dataElement[id],programIndicator[id,name,expression,filter,analyticsType,aggregationType,analyticsPeriodBoundaries[boundaryTarget,analyticsPeriodBoundaryType,offsetPeriods,offsetPeriodType]],programDataElement[id]],relativePeriods,legendSet[id],legend,sortOrder,topLimit`));
    if (it.map) maps.push(await getJ(`maps/${it.map.id}?fields=id,name,mapViews[layer,program[id],programStage[id],organisationUnitLevels,periods[id],relativePeriods,startDate,endDate,legendSet[id],classes,method,thresholds,columns[dimension,items[id],filter],rows[dimension,items[id]],filters[dimension,items[id]],dataDimensionItems[indicator[id],reportingRate[id],programIndicator[id]]]`));
    if (it.eventVisualization) lls.push(await getJ(`eventVisualizations/${it.eventVisualization.id}?fields=id,name,type,outputType,program[id],programStage[id],columns[dimension,filter,items[id],programStage[id]],rows[dimension,filter,items[id]],filters[dimension,filter,items[id]],simpleDimensions,relativePeriods,startDate,endDate`));
  }
  return { dashes, d, viz, maps, lls };
}
const vizQuery = (v) => {
  const part = (d, kind) => `${kind}=${d.dimension}${(d.items || []).length ? ':' + d.items.map(i => i.dimensionItem || i.id).join(';') : ''}`;
  return [...(v.columns || []).map(d => part(d, 'dimension')), ...(v.rows || []).map(d => part(d, 'dimension')), ...(v.filters || []).map(d => part(d, 'filter'))].join('&');
};
const vizValue = async (v) => {
  const r = await get(`analytics.json?${vizQuery(v)}`);
  return { ok: r.status < 400, total: sumRows(r.body), rows: r.body?.rows || [], headers: r.body?.headers || [], status: r.status, body: r.body };
};
const dims = (v) => [...(v.columns || []), ...(v.rows || []), ...(v.filters || [])];
const periodOf = (v) => (dims(v).find(d => d.dimension === 'pe')?.items || []).map(i => i.id).join(';');
const ouOf = (v) => (dims(v).find(d => d.dimension === 'ou')?.items || []).map(i => i.id).join(';');
const dxOf = (v) => (dims(v).find(d => d.dimension === 'dx')?.items || []).map(i => i.dimensionItem || i.id);
// The date window of a period id (fixed months/years/quarters and common relative periods), for oracle counts.
function windowOf(pe) {
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  const monthStart = (yy, mm) => dayIso(Date.UTC(yy, mm, 1)); const monthEnd = (yy, mm) => dayIso(Date.UTC(yy, mm + 1, 0));
  const ps = pe.split(';').filter(Boolean);
  if (!ps.length) return null;
  const one = (p) => {
    if (/^\d{6}$/.test(p)) return [`${p.slice(0, 4)}-${p.slice(4)}-01`, monthEnd(+p.slice(0, 4), +p.slice(4) - 1)];
    if (/^\d{4}$/.test(p)) return [`${p}-01-01`, `${p}-12-31`];
    if (/^\d{4}Q[1-4]$/.test(p)) { const q = +p.slice(5); return [monthStart(+p.slice(0, 4), (q - 1) * 3), monthEnd(+p.slice(0, 4), q * 3 - 1)]; }
    if (p === 'LAST_12_MONTHS') return [monthStart(y, m - 12), monthEnd(y, m - 1)];
    if (p === 'LAST_6_MONTHS') return [monthStart(y, m - 6), monthEnd(y, m - 1)];
    if (p === 'LAST_3_MONTHS') return [monthStart(y, m - 3), monthEnd(y, m - 1)];
    if (p === 'THIS_YEAR') return [`${y}-01-01`, `${y}-12-31`];
    if (p === 'LAST_YEAR') return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    const ly = /^LAST_(\d+)_YEARS$/.exec(p); if (ly) return [`${y - +ly[1]}-01-01`, `${y - 1}-12-31`];
    if (p === 'THIS_MONTH') return [monthStart(y, m), monthEnd(y, m)];
    if (p === 'LAST_MONTH') return [monthStart(y, m - 1), monthEnd(y, m - 1)];
    if (p === 'MONTHS_THIS_YEAR') return [`${y}-01-01`, `${y}-12-31`];
    if (p === 'LAST_4_QUARTERS') { const q = Math.floor(m / 3); return [monthStart(y, (q - 4) * 3), monthEnd(y, q * 3 - 1)]; }
    return null;
  };
  const ws = ps.map(one);
  if (ws.some(w => !w)) return null;
  return [ws.map(w => w[0]).sort()[0], ws.map(w => w[1]).sort().slice(-1)[0]];
}
const inWin = (d, w) => d && String(d).slice(0, 10) >= w[0] && String(d).slice(0, 10) <= w[1];

// ───────────────────────── Child Immunization Performance (dashboard, play) ─────────────────────────
async function epiDashboard() {
  const P = 'IpHINAT79UW'; const BIRTH = 'A03MvHHogjR'; const PNC = 'ZzYYXq4fJie';
  const DE = { bcg: 'bx6fsa0t90x', weight: 'UXz7xuGCEhU', penta: 'vTUhAUZFoys' };
  const IND = { bcg: 'FnYCr2EAzWS', penta3: 'tUIlpyeeX9N', measles: 'FbKK4ofIv5R', drop13: 'EdN7qlmI5FS', dropMs: 'd9thHOJMROr' };
  const RR = 'BfMAe6Itzgt.REPORTING_RATE'; const RRT = 'BfMAe6Itzgt.REPORTING_RATE_ON_TIME';
  const { dashes, d, viz, maps, lls } = await dashboardParts('Child Immunization Performance');
  check('E1', 'one dashboard "Child Immunization Performance"', dashes.length === 1, dashes.map(x => [x.id, x.created]));
  if (!d) return;
  if (since) check('E1b', 'created by this run', String(d.created) >= since.slice(0, 19), d.created);
  info(`items: ${viz.length} charts/tables, ${maps.length} maps, ${lls.length} line lists, ${(d.dashboardItems || []).filter(i => i.type === 'TEXT').length} text`);
  check('E2', 'location and period filters allowed', !d.restrictFilters || ['pe', 'ou'].every(f => (d.allowedFilters || []).includes(f)));
  const all = JSON.stringify([viz, maps]);
  const missingAgg = Object.entries({ ...IND, rr: RR, rrOnTime: RRT }).filter(([, id]) => !all.includes(id)).map(([k]) => k);
  check('E3', 'routine-report items: BCG/Penta 3/Measles coverage, both dropout rates, reporting rate + on time', missingAgg.length === 0, { missing: missingAgg });
  const monthly = (v) => { const pe = periodOf(v); return pe.split(';').length >= 6 || /LAST_12_MONTHS|MONTHS_THIS_YEAR|LAST_6_MONTHS/.test(pe); };
  const trend = viz.filter(v => /LINE|COLUMN|AREA/.test(v.type) && monthly(v) && dims(v).some(x => x.dimension === 'pe' && (v.columns || []).concat(v.rows || []).includes(x)));
  check('E4', '12-month trend of coverage and dropout (periods on an axis)', trend.some(v => JSON.stringify(v).match(/tUIlpyeeX9N|FnYCr2EAzWS|FbKK4ofIv5R/)) && trend.some(v => JSON.stringify(v).match(/EdN7qlmI5FS|d9thHOJMROr/)), viz.map(v => [v.type, v.name, periodOf(v)]));
  const lvl2 = (v) => /LEVEL-2|LEVEL-[A-Za-z0-9]{11}|USER_ORGUNIT_CHILDREN|CHILDREN/.test(ouOf(v)) || (ouOf(v).split(';').length >= 10);
  const ranking = viz.filter(v => dxOf(v).includes(IND.penta3) && lvl2(v) && /BAR|COLUMN/.test(v.type));
  check('E5', 'district ranking by Penta 3 coverage (bar/column by district, sorted)', ranking.some(v => v.sortOrder && v.sortOrder !== 0), ranking.map(v => [v.name, v.type, v.sortOrder, ouOf(v)]));
  const table = viz.filter(v => v.type === 'PIVOT_TABLE' && lvl2(v) && JSON.stringify(v).match(/tUIlpyeeX9N|FnYCr2EAzWS|FbKK4ofIv5R/) && JSON.stringify(v).match(/EdN7qlmI5FS|d9thHOJMROr/) && JSON.stringify(v).includes('REPORTING_RATE'));
  check('E6', 'district table: coverage, dropout and reporting rate side by side', table.length >= 1, viz.filter(v => v.type === 'PIVOT_TABLE').map(v => [v.name, ouOf(v), dxOf(v)]));
  const views = maps.flatMap(m => (m.mapViews || []).map(x => ({ ...x, mapName: m.name })));
  const vText = (x) => JSON.stringify(x);
  check('E7', 'map: Penta 3 coverage by district with the Immunization Coverage legend', views.some(x => x.layer === 'thematic' && (x.organisationUnitLevels || []).includes(2) && vText(x).includes(IND.penta3) && x.legendSet?.id === 'BtxOoQuLyg1'), views.map(x => [x.mapName, x.layer, x.organisationUnitLevels, x.legendSet?.id]));
  check('E8', 'map: facilities (level 4) on the Penta 1–3 dropout, showing > 10 %', views.some(x => x.layer === 'thematic' && (x.organisationUnitLevels || []).some(l => l >= 4) && vText(x).includes(IND.drop13)), views.map(x => [x.mapName, x.organisationUnitLevels, x.legendSet?.id, x.method, x.classes]));
  check('E9', 'every map layer has a period', views.filter(x => /thematic|event/.test(x.layer)).every(x => (x.periods || []).length || x.startDate || Object.values(x.relativePeriods || {}).some(Boolean) || (x.filters || []).some(f => f.dimension === 'pe' && (f.items || []).length)), views.map(x => [x.mapName, (x.periods || []).map(p => p.id), x.startDate]));
  // Tracker oracle (individual records).
  const ens = await trackerAll('enrollments', `program=${P}&ouMode=ALL&fields=enrollment,enrolledAt,status`, 'enrollments');
  const evs = await trackerAll('events', `program=${P}&ouMode=ALL&fields=enrollment,programStage,status,occurredAt,dataValues[dataElement,value]`, 'events');
  info(`oracle: ${ens.length} enrollments, ${evs.length} events`);
  // Demo data holds SCHEDULE events WITH values (two "low-weight" births, a postnatal visit): enrollment
  // analytics counts them, so each tracker oracle accepts the count with or without them.
  const real = evs.filter(e => e.status !== 'SCHEDULE' && e.status !== 'SKIPPED');
  const withSched = evs.filter(e => e.status !== 'SKIPPED');
  const val = (e, de) => (e.dataValues || []).find(x => x.dataElement === de)?.value;
  const pncBy = new Set(real.filter(e => e.programStage === PNC).map(e => e.enrollment));
  const enBy = new Map(ens.map(e => [e.enrollment, e]));
  const trackerViz = viz.filter(v => JSON.stringify(v).includes('programIndicator') && (v.dataDimensionItems || []).some(x => x.programIndicator) || JSON.stringify(v).includes(P) || (v.dataDimensionItems || []).some(x => x.programDataElement));
  const tracked = { registered: false, bcg: false, lbw: false, nopnc: false };
  // Each program indicator in any tracker tile (single values, or one table holding several), valued
  // with the tile's own period and org unit (checker widened 2026-11-25: a table of the four measures is
  // as valid as four tiles). Each oracle is computed with and without those scheduled events.
  const sets = [evs.filter(e => e.status !== 'SCHEDULE' && e.status !== 'SKIPPED'), withSched];
  const oracle = (kind, set, w) => {
    const enIn = ens.filter(e => inWin(e.enrolledAt, w));
    const byEnr = (e) => enBy.has(e.enrollment) && inWin(enBy.get(e.enrollment).enrolledAt, w);
    const birth = set.filter(e => e.programStage === BIRTH);
    const wt = (e) => Number(val(e, DE.weight));
    if (kind === 'registered') return [enIn.length];
    if (kind === 'bcg') return [birth.filter(e => val(e, DE.bcg) === 'true' && inWin(e.occurredAt, w)).length, new Set(birth.filter(e => val(e, DE.bcg) === 'true' && byEnr(e)).map(e => e.enrollment)).size];
    if (kind === 'lbwShare') return [birth.filter(e => inWin(e.occurredAt, w)), birth.filter(byEnr)].map(ws => ws.filter(e => wt(e) > 0)).filter(ws => ws.length).map(ws => 100 * ws.filter(e => wt(e) < 2500).length / ws.length);
    if (kind === 'lbw') return [birth.filter(e => wt(e) > 0 && wt(e) < 2500 && byEnr(e)).length, birth.filter(e => wt(e) > 0 && wt(e) < 2500 && inWin(e.occurredAt, w)).length];
    if (kind === 'nopnc') { const pnc = new Set(set.filter(e => e.programStage === PNC).map(e => e.enrollment)); return [enIn.filter(e => !pnc.has(e.enrollment)).length]; }
    return [];
  };
  for (const v of trackerViz) {
    const pe = periodOf(v); const w = windowOf(pe); const ou = ouOf(v) || 'ImspTQPwCqd';
    const pis = (v.dataDimensionItems || []).map(x => x.programIndicator).filter(Boolean);
    info(`tracker tile "${v.name}" (${v.type}) period ${pe || 'none'}${w ? ` window ${w.join('..')}` : ''}: ${pis.length} indicators`);
    if (!w) continue;
    for (const pi of pis) {
      const r = await get(`analytics.json?dimension=dx:${pi.id}&filter=pe:${pe}&filter=ou:${ou}&skipMeta=true&skipRounding=true`);
      if (r.status >= 400) { check('E10x', `"${pi.name}" loads`, false, r.status); continue; }
      const total = sumRows(r.body); const name = pi.name;
      let kind = null, id = null;
      if (/regist|enrol/i.test(name) && !/bcg|weight|lbw|postnatal|penta|%|10 w|weeks/i.test(name)) { kind = 'registered'; id = 'E10'; tracked.registered = true; }
      else if (/bcg/i.test(name)) { kind = 'bcg'; id = 'E11'; tracked.bcg = true; }
      else if (/(weight|lbw|2500|2,500)/i.test(name) && /(share|%|percent|rate)/i.test(name)) { kind = 'lbwShare'; id = 'E12'; tracked.lbw = true; }
      else if (/(weight|lbw|2500|2,500)/i.test(name) && !/recorded|weighed/i.test(name)) { kind = 'lbw'; id = 'E12b'; }
      else if (/postnatal|pnc/i.test(name)) { kind = 'nopnc'; id = 'E13'; tracked.nopnc = true; }
      if (!kind) { info(`  "${name}" = ${total} (no oracle)`); continue; }
      const options = sets.flatMap(set => oracle(kind, set, w));
      const tol = kind === 'lbwShare' ? 0.005 : 0;
      check(id, `"${name}" = ${total} (oracle ${[...new Set(options.map(x => kind === 'lbwShare' ? x.toFixed(4) : x))].join(' or ')})`, options.some(x => Math.abs(total - x) <= tol), { tile: total, options });
    }
  }
  check('E14', 'tracker tiles present: registered, BCG at birth, LBW share, no postnatal visit', Object.values(tracked).every(Boolean), tracked);
  const llText = JSON.stringify(lls);
  check('E15', 'line list of low-birth-weight babies (weight < 2500 filter)', lls.some(l => (l.program?.id === P) && /UXz7xuGCEhU/.test(JSON.stringify(l)) && /LT:2500|LE:2499/.test(JSON.stringify(l))), lls.map(l => [l.name, l.outputType]));
  check('E16', 'line list of children registered > 10 weeks ago with no Penta dose', lls.some(l => l.program?.id === P && JSON.stringify(l).includes(DE.penta) && /NV/.test(JSON.stringify(l))), llText.slice(0, 300));
  const lk = links(answerText);
  check('E17', 'answer shares the dashboard link', lk.some(l => l.includes(d.id)), lk);
  check('E18', 'answer separates routine reports from individual records and states denominators', /denominator/i.test(answerText) && /(aggregate|routine|monthly report)/i.test(answerText) && /(tracker|individual|record)/i.test(answerText));
  check('E19', 'answer explains coverage above 100 %', /(above|over|exceed|more than|>)\s*100\s*%?/i.test(answerText));
  // Charts, maps and tables agree: the district table's Penta 3 values equal the ranking chart's for the same districts.
  if (ranking[0] && table[0] && periodOf(ranking[0]) === periodOf(table[0])) {
    const a = await vizValue(ranking[0]); const b = await vizValue(table[0]);
    const key = (rows, hdr) => { const iDx = hdr.findIndex(h => h.name === 'dx'); const iOu = hdr.findIndex(h => h.name === 'ou'); const m = new Map(); for (const r of rows) if (r[iDx] === IND.penta3) m.set(r[iOu], r[r.length - 1]); return m; };
    const ka = key(a.rows, a.headers); const kb = key(b.rows, b.headers);
    const diff = [...ka.keys()].filter(k => kb.has(k) && kb.get(k) !== ka.get(k));
    check('E20', 'ranking chart and district table agree on Penta 3 per district', diff.length === 0 && ka.size > 0, { compared: ka.size, diff });
  } else info(`E20 skipped: ranking/table periods differ (${ranking[0] && periodOf(ranking[0])} vs ${table[0] && periodOf(table[0])})`);
  if (browserOn) {
    const titles = [...viz.map(v => v.name), ...maps.map(m => m.name), ...lls.map(l => l.name)];
    const r = await renderDashboard(d.id, titles, 'epi-dash');
    if (r) check('E21', 'every tile renders (titles drawn, no error tiles)', r.errTiles === 0 && r.missing.length === 0, { errTiles: r.errTiles, missing: r.missing });
  }
}

// ───────────────────────── Immunization Scorecard (dashboard plugin, play) ─────────────────────────
async function epiScorecard() {
  const DEF = ['FnYCr2EAzWS', 'tUIlpyeeX9N', 'FbKK4ofIv5R', 'EdN7qlmI5FS', 'BfMAe6Itzgt'];
  const apps = await findApp(/immunization scorecard/i);
  check('S1', 'one installed dashboard plugin "Immunization Scorecard"', apps.length === 1 && apps.every(isPlugin), apps.map(a => [a.key, a.pluginType, !!a.pluginLaunchUrl]));
  const app = apps[0]; if (!app) return;
  const src = await appSource(app.key, pluginPage(app));
  check('S2', 'reads analytics for the five default items', /analytics/.test(src) && DEF.every(x => src.includes(x)), DEF.filter(x => !src.includes(x)));
  // The default window may be the keyword or computed months ("last 12 months vs previous 12"); S12 checks
  // its values against analytics LAST_12_MONTHS (checker widened 2026-11-26).
  check('S3', 'follows dashboard filters; defaults to last 12 months for the country', /dashboardItemFilters/.test(src) && /LAST_12_MONTHS|last 12/i.test(src));
  check('S4', 'numerator/denominator, legend colours, previous-period arrows, sort, drill down', /includeNumDen|numerator/i.test(src) && /legendSet|legends/i.test(src) && /(previous|prior|last).{0,40}period|↑|↓|▲|▼|arrow/i.test(src) && /sort/i.test(src) && /(drill|children|parent|back up|level)/i.test(src));
  check('S5', 'CSV export and a print view; "no data" for missing values', /csv/i.test(src) && /print/i.test(src) && /no data/i.test(src));
  const dl = await getJ(`dashboards?filter=dashboardItems.appKey:eq:${enc(app.key)}&fields=id,name,dashboardItems[id,appKey]&paging=false`);
  const dash = (dl.dashboards || [])[0];
  const copies = (dash?.dashboardItems || []).filter(i => i.appKey === app.key);
  check('S6', 'a demonstration dashboard holds the plugin twice', copies.length === 2, (dl.dashboards || []).map(x => [x.name, (x.dashboardItems || []).filter(i => i.appKey === app.key).length]));
  const settings = [];
  for (const n of await getJ('dataStore')) for (const it of copies) { const r = await get(`dataStore/${enc(n)}/${it.id}`); if (r.status === 200) settings.push({ ns: n, item: it.id, v: r.body }); }
  // A copy left on the defaults needs no saved entry (checker relaxed 2026-11-25: the prompt asks for
  // one default copy, it does not ask that defaults be stored); what matters is that the other copy's
  // settings are stored under its own item id, and that two stored entries differ.
  check('S7', 'the non-default copy has its own saved settings (keyed by its item id); stored entries differ', settings.length >= 1 && (settings.length === 1 || JSON.stringify(settings[0].v) !== JSON.stringify(settings[1].v)), settings.map(s => `${s.ns}/${s.item}: ${JSON.stringify(s.v).slice(0, 160)}`));
  const sText = settings.map(s => JSON.stringify(s.v));
  // Indicators by id or by the plugin's own names ("keys":["dropout"]) — checker widened 2026-11-26.
  check('S8', 'one copy is dropout-only by quarter', sText.some(t => /QUARTER/i.test(t) && /EdN7qlmI5FS|d9thHOJMROr|dropout/i.test(t) && !/FnYCr2EAzWS|tUIlpyeeX9N|FbKK4ofIv5R|"(?:bcg|penta3|measles)"/i.test(t)), sText.map(t => t.slice(0, 200)));
  if (dash) check('S9', 'answer shares the dashboard', links(answerText).some(l => l.includes(dash.id)), links(answerText));
  // Oracle: district values for the default copy (last 12 months, children of the country).
  const ora = await getJ(`analytics?dimension=dx:${DEF.slice(0, 4).join(';')};BfMAe6Itzgt.REPORTING_RATE&dimension=ou:ImspTQPwCqd;LEVEL-2&filter=pe:LAST_12_MONTHS&displayProperty=NAME&skipMeta=false`);
  const ouName = (id) => ora.metaData?.items?.[id]?.name || id;
  const sample = (ora.rows || []).filter(r => r[0] === 'tUIlpyeeX9N').slice(0, 14).map(r => ({ ou: ouName(r[1]), v: Number(r[2]) }));
  info(`oracle Penta 3 (LAST_12_MONTHS) by district: ${sample.map(s => `${s.ou} ${s.v}`).join(', ')}`);
  if (!browserOn || !dash) return;
  const s = await browserSession(); if (!s) return;
  const page = await s.c.newPage();
  const errs = []; const failed = [];
  page.on('console', m => { const u = (m.location && m.location().url) || ''; if (m.type() === 'error' && u.includes(`/api/apps/${app.key}/`)) errs.push(m.text()); });
  page.on('response', r => { let f = null; try { f = r.frame(); } catch { /* */ } if (r.status() >= 400 && f && f.url().includes(`/api/apps/${app.key}/`)) failed.push(`${r.status()} ${r.url().slice(0, 160)}`); });
  const read = async () => { const out = []; for (const f of page.frames().filter(f => f.url().includes(`/api/apps/${app.key}/`))) { try { out.push(await f.evaluate(() => `${document.body.innerText}\nINPUTS: ${[...document.querySelectorAll('input,select')].map(i => i.value).join(' | ')}`)); } catch { /* */ } } return out; };
  await page.goto(`${BASE}/dhis-web-dashboard/#/${dash.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(50000);
  const first = await read();
  await page.screenshot({ path: path.join(SHOT_DIR, 'scorecard-1.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(50000);
  const second = await read();
  await page.screenshot({ path: path.join(SHOT_DIR, 'scorecard-2.png') });
  check('S10', 'both copies render, differ, and are the same after reload', first.length === 2 && first[0] !== first[1] && second.slice().sort().join('|') === first.slice().sort().join('|'), first.map(t => t.slice(0, 160)));
  check('S11', 'no console errors or failed API calls in the plugin', errs.length === 0 && failed.length === 0, { errs: errs.slice(0, 3), failed: failed.slice(0, 3) });
  const def = first.find(t => /BCG/i.test(t) && /Penta\s*3|Penta3/i.test(t)) || '';
  const shown = sample.filter(x => def.includes(x.ou) && [x.v.toFixed(1), x.v.toFixed(0), String(x.v), x.v.toFixed(2)].some(n => def.includes(n)));
  check('S12', `default copy shows the districts' Penta 3 values equal to analytics (${shown.length}/${sample.length})`, sample.length > 0 && shown.length >= Math.min(sample.length, 10), def.slice(0, 500));
  await s.browser.close();
}

// ───────────────────────── Child Vaccination Follow-up (app, play) ─────────────────────────
async function childVax() {
  const P = 'IpHINAT79UW';
  const ids = ['A03MvHHogjR', 'ZzYYXq4fJie', 'bx6fsa0t90x', 'vTUhAUZFoys', 'FqlgKAG8HOu', 'rxBfISxXS2U'];
  const apps = await findApp(/child vaccination follow-?up/i);
  check('V1', 'one installed app "Child Vaccination Follow-up"', apps.length === 1, apps.map(a => a.key));
  const app = apps[0]; if (!app) return;
  const src = await appSource(app.key, 'index.html');
  // Both stages: by stage id, or by reading all of the program's events and picking the dose fields of
  // both stages by data element (checker widened 2026-11-26).
  const deIds = ids.slice(2);
  check('V2', 'reads the Child Programme, both stages\' dose fields', src.includes(P) && deIds.every(x => src.includes(x)) && (src.includes('ZzYYXq4fJie') || /tracker\/events/.test(src)), ids.filter(x => !src.includes(x)));
  // Days (42/70/98), weeks×7, or week/month fields (w: 6 … m: 9) — checker widened 2026-11-25.
  check('V3', 'schedule 0 / 6 / 10 / 14 weeks / 9 months, overdue after 4 weeks', /(\b42\b|6\s*\*\s*7|\b6\b)/.test(src) && /(\b70\b|10\s*\*\s*7|\b10\b)/.test(src) && /(\b98\b|14\s*\*\s*7|\b14\b)/.test(src) && /(\b9\b|270|274|273)/.test(src) && /(\b28\b|4\s*\*\s*7)/.test(src));
  check('V4', 'an "as of" date that leaves out later registrations', /as ?of|asOf/i.test(src));
  check('V5', 'filtered CSV export, Capture links and a facility map', /csv/i.test(src) && /(capture|enrollment=|teiId|trackedEntityId)/i.test(src) && /(leaflet|geojson|geometry|map)/i.test(src));
  check('V6', 'says where dose dates are not recorded', /(not recorded|isn.t recorded|not record|unknown date|date unknown|only one|single postnatal|dose dates)/i.test(src));
  const totalAll = (await getJ(`tracker/enrollments?program=${P}&ouMode=ALL&pageSize=1&totalPages=true&fields=enrollment`)).pager?.total;
  const totalToday = (await getJ(`tracker/enrollments?program=${P}&ouMode=ALL&enrolledBefore=${TODAY}&pageSize=1&totalPages=true&fields=enrollment`)).pager?.total;
  // "Count each child once": unique children (tracked entities) registered by today, or enrollments if equal.
  const ensAll = await trackerAll('enrollments', `program=${P}&ouMode=ALL&fields=trackedEntity,enrolledAt`, 'enrollments');
  const teToday = new Set(ensAll.filter(e => String(e.enrolledAt).slice(0, 10) <= TODAY).map(e => e.trackedEntity)).size;
  info(`oracle: ${totalAll} enrollments, ${totalToday} enrolled on/before ${TODAY}, ${teToday} unique children`);
  check('V7', 'answer gives the app link and the counts', links(answerText).some(l => l.includes(app.key)) && (numIn(totalToday, answerText) || numIn(teToday, answerText)), { links: links(answerText), totalToday, teToday });
  if (!browserOn) return;
  const s = await browserSession(); if (!s) return;
  const page = await s.c.newPage();
  const errs = []; const failed = [];
  page.on('console', m => { const u = (m.location && m.location().url) || ''; if (m.type() === 'error' && u.includes(`/api/apps/${app.key}/`)) errs.push(m.text()); });
  page.on('response', r => { let f = null; try { f = r.frame(); } catch { /* */ } if (r.status() >= 400 && f && f.url().includes(`/api/apps/${app.key}/`)) failed.push(`${r.status()} ${r.url().slice(0, 160)}`); });
  const t0 = Date.now();
  await page.goto(`${BASE}/api/apps/${app.key}/index.html`, { waitUntil: 'domcontentloaded' });
  let text = ''; let firstAt = null;
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000);
    const fr = page.frames().find(f => f.url().includes(`/api/apps/${app.key}/`)) || page.mainFrame();
    text = await fr.evaluate(() => document.body.innerText).catch(() => '');
    if (!firstAt && /\d{2,}/.test(text) && !/loading/i.test(text.slice(0, 200))) firstAt = Date.now() - t0;
    if (numIn(totalToday, text) || numIn(teToday, text)) break;
  }
  await page.screenshot({ path: path.join(SHOT_DIR, 'child-vax-app.png'), fullPage: true });
  info(`first numbers after ${firstAt ? Math.round(firstAt / 1000) + ' s' : 'never'}; total after ${Math.round((Date.now() - t0) / 1000)} s`);
  check('V8', 'opens with no console errors or failed API calls', errs.length === 0 && failed.length === 0, { errs: errs.slice(0, 3), failed: failed.slice(0, 3) });
  check('V9', `the app says it includes every child registered by today (${teToday} children / ${totalToday} enrollments)`, numIn(totalToday, text) || numIn(teToday, text), text.slice(0, 400));
  check('V10', 'first results within 30 s', firstAt != null && firstAt <= 30000, firstAt);
  fs.writeFileSync(path.join(SHOT_DIR, 'child-vax-app.txt'), text);
  await s.browser.close();
}

// ───────────────────────── Pregnancy Journey Card (enrollment plugin, local) ─────────────────────────
const PREG = 'DtrybmSigv0';
const PST = { reg: 'TxaaZJ0qp7u', anc: 'kUhCR6BYTcv', lab: 'xq8qg7Czxsi', del: 'L73VvffxPIJ', pnc: 'fKFwNPDKHTK' };
async function pregnancyCard() {
  const before = new Set(JSON.parse(fs.existsSync(path.join(process.env.SNAP_DIR || '.', 'local-pregnancy-tes.json')) ? fs.readFileSync(path.join(process.env.SNAP_DIR || '.', 'local-pregnancy-tes.json'), 'utf8') : '{"trackedEntities":[]}').trackedEntities.map(t => t.trackedEntity));
  const ens = await trackerAll('enrollments', `program=${PREG}&ouMode=ALL&fields=enrollment,trackedEntity,enrolledAt,occurredAt,status,orgUnit`, 'enrollments');
  const fresh = ens.filter(e => !before.has(e.trackedEntity));
  const people = new Map(); fresh.forEach(e => people.set(e.trackedEntity, (people.get(e.trackedEntity) || 0) + 1));
  info(`records: ${ens.length} enrollments (${fresh.length} new, ${people.size} new women)`);
  check('P1', 'about 30 fictional test pregnancies added (25–40)', fresh.length >= 25 && fresh.length <= 40, fresh.length);
  check('P2', 'one woman with two pregnancies', [...people.values()].some(n => n >= 2));
  const evs = await trackerAll('events', `program=${PREG}&ouMode=ALL&fields=event,enrollment,programStage,status,occurredAt,dataValues[dataElement,value]`, 'events');
  const mine = new Set(fresh.map(e => e.enrollment));
  const fe = evs.filter(e => mine.has(e.enrollment) && e.status !== 'SCHEDULE');
  const val = (e, de) => (e.dataValues || []).find(x => x.dataElement === de)?.value;
  const has = (st, pred) => fe.some(e => e.programStage === st && pred(e));
  const scen = {
    delivered: has(PST.del, () => true), postnatal: has(PST.pnc, () => true),
    highBP: fe.some(e => Number(val(e, 'h0lbfyndnXg')) >= 140 || Number(val(e, 'Npno6oRgG7D')) >= 90),
    anaemia: fe.some(e => val(e, 'tKJiFOQGcvq') != null && Number(val(e, 'tKJiFOQGcvq')) < 11),
    missingTests: fresh.some(en => !fe.some(e => e.enrollment === en.enrollment && e.programStage === PST.lab)),
    early: fe.some(e => e.programStage === PST.reg && Number(val(e, 'fFmXykfTEp3')) > 0 && Number(val(e, 'fFmXykfTEp3')) < 14),
  };
  check('P3', 'scenarios covered: delivered + postnatal, high BP, anaemia, missing tests, early pregnancy', Object.values(scen).every(Boolean), scen);
  // No saved record the program's error rules reject (the rules we can recompute here).
  const bad = [];
  for (const e of fe) {
    const g = val(e, 'k1TxgEFp6qe'); const p = val(e, 'Q2IQTwJASyv');
    if (g != null && p != null && Number(p) > Number(g)) bad.push(['parity>gravidity', e.event]);
    const adm = val(e, 'hdLXRrr5Zun'); const dlv = val(e, 'ZvPzzOUIGFx');
    if (adm && dlv && dlv < adm) bad.push(['delivery<admission', e.event]);
    const en = fresh.find(x => x.enrollment === e.enrollment);
    if (dlv && en && dlv.slice(0, 10) < String(en.enrolledAt).slice(0, 10)) bad.push(['delivery<enrollment', e.event]);
    const us = val(e, 'I7uaplHkAvM'); if (us && en && us.slice(0, 10) < String(en.enrolledAt).slice(0, 10)) bad.push(['ultrasound<enrollment', e.event]);
    const s = Number(val(e, 'h0lbfyndnXg')); const d = Number(val(e, 'Npno6oRgG7D')); if (s && d && d >= s) bad.push(['diastolic>=systolic', e.event]);
    if (String(e.occurredAt || '').slice(0, 10) > TODAY) bad.push(['future event', e.event]);
  }
  check('P4', 'no saved test record breaks the program\'s error rules', bad.length === 0, bad.slice(0, 8));
  const apps = await findApp(/pregnancy journey card/i);
  check('P5', 'one installed Capture plugin "Pregnancy Journey Card"', apps.length === 1 && apps.every(isPlugin), apps.map(a => [a.key, a.pluginType, !!a.pluginLaunchUrl]));
  const app = apps[0];
  const layout = (await get('dataStore/capture/enrollmentOverviewLayout')).body || {};
  const entry = layout[PREG];
  check('P6', 'placed on the program\'s enrollment page, Capture widgets kept', !!app && !!entry && JSON.stringify(entry).includes(`/apps/${app.key}/`) && /StagesAndEvents/.test(JSON.stringify(entry)) && /EnrollmentWidget|ProfileWidget/.test(JSON.stringify(entry)), entry);
  const snapF = path.join(process.env.SNAP_DIR || '.', 'local-capture-enrollmentOverviewLayout.json');
  if (fs.existsSync(snapF)) {
    const old = JSON.parse(fs.readFileSync(snapF, 'utf8'));
    const changed = Object.keys(old).filter(k => JSON.stringify(old[k]) !== JSON.stringify(layout[k]));
    check('P7', 'other programs\' enrollment layouts unchanged', changed.length === 0, changed);
  }
  if (!app) return;
  const src = await appSource(app.key, pluginPage(app));
  check('P8', 'reads the open enrollment and all five stages', /enrollmentId/.test(src) && Object.values(PST).every(x => src.includes(x)), Object.entries(PST).filter(([, x]) => !src.includes(x)).map(([k]) => k));
  check('P9', 'schedule 12/20/26/30/34/36/38/40 weeks; 140/90; Hb 11; ultrasound before 24 weeks; 7-day LMP/ultrasound rule', /12[^\d]{1,4}20[^\d]{1,4}26[^\d]{1,4}30[^\d]{1,4}34[^\d]{1,4}36[^\d]{1,4}38[^\d]{1,4}40/.test(src) && /140/.test(src) && /\b90\b/.test(src) && /\b11\b/.test(src) && /\b24\b/.test(src) && /\b7\b/.test(src));
  check('P10', 'buttons open Capture forms for the next step', /enrollmentEventNew/.test(src) && /stageId/.test(src));
  check('P11', 'answer gives a link and says what was checked', links(answerText).length >= 1 && /(test|check)/i.test(answerText), links(answerText));
  if (!browserOn) return;
  // Real Capture: open three test pregnancies (delivered, a two-pregnancy woman, an early one) and read the card.
  const s = await browserSession(); if (!s) return;
  const page = await s.c.newPage();
  const errs = [];
  page.on('console', m => { const u = (m.location && m.location().url) || ''; if (m.type() === 'error' && u.includes(`/api/apps/${app.key}/`)) errs.push(m.text()); });
  const twice = [...people.entries()].find(([, n]) => n >= 2)?.[0];
  const delivered = fresh.find(en => fe.some(e => e.enrollment === en.enrollment && e.programStage === PST.del));
  const picks = [delivered, ...fresh.filter(e => e.trackedEntity === twice)].filter(Boolean).slice(0, 3);
  const seen = [];
  for (const en of picks) {
    await page.goto(`${BASE}/dhis-web-capture/index.html#/enrollment?enrollmentId=${en.enrollment}&orgUnitId=${en.orgUnit}&programId=${PREG}&teiId=${en.trackedEntity}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(35000);
    const t = await framesText(page, f => f.url().includes(`/api/apps/${app.key}/`));
    seen.push(t);
    await page.screenshot({ path: path.join(SHOT_DIR, `preg-card-${en.enrollment}.png`), fullPage: true });
  }
  info(`card texts: ${seen.map(t => t.replace(/\s+/g, ' ').slice(0, 160)).join(' ‖ ')}`);
  check('P12', 'the card renders in Capture for each pregnancy (gestational age / due date shown)', seen.length === picks.length && seen.every(t => /gestation|weeks|due/i.test(t)), seen.map(t => t.slice(0, 120)));
  check('P13', 'separate pregnancies of the same woman show different cards', picks.length < 3 || seen[1] !== seen[2]);
  check('P14', 'the delivered pregnancy shows a delivery summary', !delivered || /deliver/i.test(seen[0] || ''));
  check('P15', 'no console errors from the plugin', errs.length === 0, errs.slice(0, 4));
  await s.browser.close();
}

// ───────────────────────── ANC Blood Pressure Check (form field plugin, local) ─────────────────────────
async function ancBp() {
  const apps = await findApp(/anc blood pressure check/i);
  check('B1', 'one installed form field plugin "ANC Blood Pressure Check"', apps.length === 1 && apps.every(isPlugin), apps.map(a => [a.key, a.pluginType, !!a.pluginLaunchUrl]));
  const app = apps[0];
  const forms = (await get('dataStore/capture/dataEntryForms')).body || {};
  const entry = forms[PST.anc];
  const ej = JSON.stringify(entry || {});
  const plugEl = (entry || []).flatMap(s => s.elements || []).find(e => e.type === 'plugin');
  const mapped = (plugEl?.fieldMap || []).map(f => f.IdFromApp);
  check('B2', 'placed on the Routine ANC Follow-up form with the systolic and diastolic fields mapped', !!app && !!plugEl && ej.includes(`/apps/${app.key}/`) && mapped.includes('h0lbfyndnXg') && mapped.includes('Npno6oRgG7D'), { mapped, src: plugEl?.pluginSource });
  const stage = await getJ(`programStages/${PST.anc}?fields=programStageDataElements[dataElement[id]]`);
  const stageDes = stage.programStageDataElements.map(x => x.dataElement.id);
  const listed = new Set((entry || []).flatMap(s => s.elements || []).flatMap(e => e.type === 'plugin' ? (e.fieldMap || []).map(f => f.IdFromApp) : [e.id]));
  check('B3', 'every other field of the stage is still on the form', stageDes.every(d => listed.has(d)), stageDes.filter(d => !listed.has(d)));
  const snapF = path.join(process.env.SNAP_DIR || '.', 'local-capture-dataEntryForms.json');
  if (fs.existsSync(snapF)) {
    const old = JSON.parse(fs.readFileSync(snapF, 'utf8'));
    const changed = Object.keys(old).filter(k => JSON.stringify(old[k]) !== JSON.stringify(forms[k]));
    check('B4', 'other stages\' forms unchanged', changed.length === 0, changed);
  }
  if (!app) return;
  const src = await appSource(app.key, pluginPage(app));
  check('B5', 'writes the rounded average with setFieldValue (reads fieldsMetadata)', /setFieldValue/.test(src) && /Math\.round/.test(src) && /fieldsMetadata/.test(src));
  check('B6', 'range checks 60–260 / 30–160 and diastolic < systolic', /\b60\b/.test(src) && /\b260\b/.test(src) && /\b30\b/.test(src) && /\b160\b/.test(src));
  check('B7', 'classification 140/90 and 160/110; pre-eclampsia with ≥ 20 weeks and urine protein', /140/.test(src) && /\b90\b/.test(src) && /\b110\b/.test(src) && /\b20\b/.test(src) && /(R22EdS5prgQ|urine|protein)/i.test(src) && /(Xdzd1ScCaDF|gestation)/i.test(src));
  check('B8', 'previous visits of this pregnancy read; rule errors/warnings shown', /(enrollment|enrollmentId)/.test(src) && /\berrors\b/.test(src) && /\bwarnings\b/.test(src));
  // The prompt asks to be told what was checked, not for a link (checker relaxed 2026-11-25).
  check('B9', 'answer is honest about the Capture test', /capture/i.test(answerText) && /(untested|not (yet )?tested|could not|cannot|have not)/i.test(answerText));
}

(async () => {
  const fn = { 'epi-dashboard': epiDashboard, 'epi-scorecard': epiScorecard, 'child-vax': childVax, 'pregnancy-card': pregnancyCard, 'anc-bp': ancBp }[thread];
  if (!fn) { console.log('usage: verify-haiku-round2-llm.js <epi-dashboard|epi-scorecard|child-vax|pregnancy-card|anc-bp> [--answer file] [--since ISO] [--json file] [--no-browser]'); process.exit(2); }
  try { await fn(); } catch (e) { failures++; console.log('  ✗ checker error: ' + (e.stack || e)); }
  const out = opt('--json'); if (out) fs.writeFileSync(out, JSON.stringify({ thread, base: BASE, results }, null, 1));
  console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks passed`);
  console.log(failures ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(failures ? 1 : 0);
})();
