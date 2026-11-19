#!/usr/bin/env node
'use strict';
/* Requirement checks for three complex builds, written from the user's prompts
 * alone (scripts/prompts/complex-*.txt), run against the play 2.43 demo data.
 * Independent of the extension: plain fetch, numbers recomputed from the API.
 *
 *   node scripts/verify-complex-builds-llm.js <inpatient|malaria|contacts> [--answer <file>] [--since <ISO>] [--no-browser]
 *
 * env: DHIS2_BASE (default https://play.im.dhis2.org/stable-2-43-2-1), DHIS2_AUTH (admin:district),
 *      PLAYWRIGHT_CORE_PATH / CHROME_PATH for the browser checks, SHOT_DIR for screenshots. */
const fs = require('fs');
const path = require('path');

const BASE = (process.env.DHIS2_BASE || 'https://play.im.dhis2.org/stable-2-43-2-1').replace(/\/+$/, '');
const USERPASS = process.env.DHIS2_AUTH || 'admin:district';
const AUTH = 'Basic ' + Buffer.from(USERPASS).toString('base64');
const argv = process.argv.slice(2);
const thread = argv[0];
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const answerText = opt('--answer') ? fs.readFileSync(opt('--answer'), 'utf8') : '';
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
async function get(p) {
  const r = await fetch(`${BASE}/api/${p}`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
async function getJ(p) { const r = await get(p); if (r.status >= 400) throw new Error(`GET ${p} → ${r.status} ${String(JSON.stringify(r.body)).slice(0, 200)}`); return r.body; }
const enc = encodeURIComponent;
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;
const dayIso = (d) => new Date(d).toISOString().slice(0, 10);

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
  const c = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const [u, p] = USERPASS.split(':');
  await c.request.post(BASE + '/api/auth/login', { data: { username: u, password: p }, headers: { 'Content-Type': 'application/json' } });
  return { browser, c };
}
async function allFramesText(page) {
  let text = '';
  for (const f of page.frames()) { try { text += '\n' + await f.evaluate(() => document.body ? document.body.innerText : ''); } catch { /* detached */ } }
  return text;
}
function answerLinkIds(text) {
  return Array.from(String(text).matchAll(/https?:\/\/\S+/g)).map(m => m[0].replace(/[)\].,>*`]+$/, ''));
}

// The app's own code: its page (2.43 redirects /api/apps/<key>/index.html into the
// global shell unless ?redirect=false) and the scripts it ships, minus the bundled
// runtime kit and chart/map libraries (their text would satisfy any keyword check).
const VENDOR_RE = /(?:\.min\.js$|^app-guard\.js$|^d2-kit)/;
async function appSource(key, page) {
  const base = `${BASE}/api/apps/${key}/`;
  const idx = await fetch(`${base}${page}?redirect=false`, { headers: { Authorization: AUTH } }).then(r => r.text());
  const scripts = Array.from(idx.matchAll(/<script[^>]+src="([^"]+)"/g)).map(m => m[1]).filter(x => !/^https?:/.test(x) && !VENDOR_RE.test(x.split('/').pop()));
  let src = idx;
  for (const x of scripts) src += '\n' + await fetch(new URL(x, base).toString(), { headers: { Authorization: AUTH } }).then(r => r.text());
  return src;
}
const appFrame = (page, key) => page.frames().find(f => f.url().includes(`/api/apps/${key}/`)) || page.mainFrame();

// ───────────────────────── 1. Inpatient Outcomes dashboard ─────────────────────────
async function inpatient() {
  const P = 'eBAyeGv0exc', S = 'Zj7UnCAulEk', ROOT = 'ImspTQPwCqd';
  const DE = { mode: 'fWIAEtYVEGk', sex: 'oZg33kd9taw', age: 'qrur9Dvnyt5', dx: 'K6uUAvq500H', adm: 'eMyVanycQSC', dis: 'msodh3rEMJa' };
  const PE = '202608;202609;202610';
  console.log('\n— Oracle (independent analytics, Aug–Oct 2026, Sierra Leone, event/report date) —');
  const ev = async (extra) => (await getJ(`analytics/events/aggregate/${P}.json?dimension=pe:${PE}&filter=ou:${ROOT}&outputType=EVENT${extra || ''}`)).rows.reduce((s, r) => s + Number(r[r.length - 1]), 0);
  const total = await ev('');
  const deaths = await ev(`&filter=${S}.${DE.mode}:IN:MODDIED`);
  const pct = total ? 100 * deaths / total : 0;
  info(`total=${total} deaths=${deaths} death%=${pct.toFixed(2)}`);

  console.log('\n— Dashboard —');
  const list = await getJ(`dashboards?filter=name:ilike:Inpatient Outcomes&fields=id,name,created,restrictFilters,allowedFilters,dashboardItems[id,type,visualization[id],map[id],eventVisualization[id],eventChart[id],eventReport[id],text]&paging=false`);
  const dashes = list.dashboards || [];
  check('AC1.1', 'exactly one dashboard named "Inpatient Outcomes"', dashes.length === 1, dashes.map(d => [d.id, d.name, d.created]));
  const dash = dashes.sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
  if (!dash) return;
  if (since) check('AC1.1b', 'the dashboard was created by this run', String(dash.created) >= since.slice(0, 19), dash.created);
  const items = dash.dashboardItems || [];
  info(`items: ${items.map(i => i.type).join(', ')}`);
  check('AC1.8', 'location and period filters allowed on the dashboard', !dash.restrictFilters || ['pe', 'ou'].every(f => (dash.allowedFilters || []).includes(f)), { restrictFilters: dash.restrictFilters, allowedFilters: dash.allowedFilters });

  const viz = [];
  for (const it of items.filter(i => i.visualization)) {
    viz.push(await getJ(`visualizations/${it.visualization.id}?fields=id,name,type,columns[dimension,items[id,dimensionItem,name]],rows[dimension,items[id,dimensionItem,name]],filters[dimension,items[id,dimensionItem,name],filter],dataDimensionItems[dataDimensionItemType,programIndicator[id,name],programDataElement[id],dataElement[id]],relativePeriods,startDate,endDate,legendSet[id],programIndicatorDimensions[programIndicator[id],legendSet[id],filter],dataElementDimensions[dataElement[id],legendSet[id],filter],sortOrder,topLimit`));
  }
  const maps = [];
  for (const it of items.filter(i => i.map)) {
    maps.push(await getJ(`maps/${it.map.id}?fields=id,name,mapViews[id,name,layer,thematicMapType,program[id],programStage[id],programIndicator[id],organisationUnitLevels,organisationUnits[id,path],periods[id],relativePeriods,startDate,endDate,filters[dimension,items[id],filter],columns[dimension,items[id,dimensionItem],filter],rows[dimension,items[id]],dataDimensionItems[dataDimensionItemType,programIndicator[id],programDataElement[id],dataElement[id]],eventCoordinateField,eventStatus,userOrganisationUnit,organisationUnitSelectionMode]`));
  }
  const lls = [];
  for (const it of items.filter(i => i.eventVisualization)) {
    lls.push(await getJ(`eventVisualizations/${it.eventVisualization.id}?fields=id,name,type,program[id],programStage[id],outputType,columns[dimension,filter,items[id]],rows[dimension,filter,items[id]],filters[dimension,filter,items[id]],dataElementDimensions[dataElement[id],filter],relativePeriods,startDate,endDate,simpleDimensions,eventStatus,programStatus`));
  }
  info(`visualizations ${viz.length}: ${viz.map(v => `${v.type}:${v.name}`).join(' | ')}`);
  info(`maps ${maps.length}: ${maps.map(m => `${m.name}[${(m.mapViews || []).map(v => v.layer).join(',')}]`).join(' | ')}`);
  info(`line lists ${lls.length}: ${lls.map(l => `${l.type}:${l.name}`).join(' | ')}`);

  // Every saved period must be Aug–Oct 2026 (fixed periods or the exact date range), not a drifting relative period.
  const hasRel = (rp) => rp && Object.entries(rp).some(([, v]) => v === true);
  const periodOk = (o) => {
    const dims = [...(o.columns || []), ...(o.rows || []), ...(o.filters || [])];
    const pe = dims.find(d => d.dimension === 'pe');
    const fixed = pe ? pe.items.map(i => i.id).sort().join(';') : '';
    const datesOk = o.startDate && o.endDate && dayIso(o.startDate) === '2026-08-01' && dayIso(o.endDate) === '2026-10-31';
    return (fixed === PE || datesOk) && !hasRel(o.relativePeriods);
  };
  const vizPeriodBad = viz.filter(v => !periodOk(v)).map(v => v.name);
  check('AC1.9a', 'every chart/table uses Aug–Oct 2026 (fixed, not relative)', vizPeriodBad.length === 0, vizPeriodBad);

  // Tile numbers via the server's own render of each saved visualization.
  // Tile numbers: the analytics request the tile itself makes, built from its
  // saved columns/rows/filters (visualizations/<id>/data.json answers nothing for
  // a single value, which has no row dimension).
  const tileData = {};
  for (const v of viz) {
    const part = (d, kind) => `${kind}=${d.dimension}${(d.items || []).length ? ':' + d.items.map(i => i.id).join(';') : ''}`;
    const q = [...(v.columns || []).map(d => part(d, 'dimension')), ...(v.rows || []).map(d => part(d, 'dimension')), ...(v.filters || []).map(d => part(d, 'filter'))].join('&');
    const r = await get(`analytics.json?${q}`);
    tileData[v.id] = r.status < 400 && r.body && r.body.rows ? r.body : null;
    check('AC1.11', `tile "${v.name}" returns data`, r.status < 400 && r.body && r.body.rows && r.body.rows.length > 0, r.status >= 400 ? r.body : 'no rows');
  }
  const numbersOf = (v) => (tileData[v.id]?.rows || []).map(r => Number(r[r.length - 1])).filter(n => Number.isFinite(n));
  const singleNums = viz.filter(v => v.type === 'SINGLE_VALUE').map(v => ({ v, n: numbersOf(v).reduce((a, b) => a + b, 0) }));
  const allTileNums = viz.flatMap(v => { const n = numbersOf(v); return [...n, n.reduce((a, b) => a + b, 0)]; });
  info(`single values: ${singleNums.map(s => `${s.v.name}=${s.n}`).join(' | ')}`);
  // All records are cases: an indicator that leaves records out (e.g. split by a
  // category combination, records without age/sex) does not show the total.
  const piTotal = (await getJ(`analytics.json?dimension=dx:luLGbE2WKGP&filter=pe:${PE}&filter=ou:${ROOT}`)).rows?.[0]?.[1];
  info(`demo indicator "Inpatient cases" total = ${piTotal} (reference only)`);
  check('AC1.2a', `total cases ${total} shown`, allTileNums.some(n => n === total), singleNums.map(s => s.n));
  check('AC1.2b', `deaths ${deaths} shown`, allTileNums.some(n => n === deaths), singleNums.map(s => s.n));
  check('AC1.2c', `death percentage ${pct.toFixed(1)}% shown`, allTileNums.some(n => near(n, pct, 0.15)), singleNums.map(s => s.n));
  const stayIds = viz.flatMap(v => (v.dataDimensionItems || []).map(d => d.programIndicator?.id).filter(Boolean));
  let stayOk = false; let stayOracle = null;
  for (const pi of new Set(stayIds)) {
    const p = await getJ(`programIndicators/${pi}?fields=name,expression,filter,aggregationType`);
    if (/daysBetween|minutesBetween/i.test(p.expression || '') && /eMyVanycQSC|msodh3rEMJa/.test(p.expression)) {
      const a = await getJ(`analytics.json?dimension=dx:${pi}&filter=pe:${PE}&filter=ou:${ROOT}`);
      stayOracle = a.rows?.[0]?.[1];
      stayOk = allTileNums.some(n => near(n, Number(stayOracle), 0.05));
      info(`stay indicator "${p.name}" ${p.aggregationType} expr=${p.expression} filter=${p.filter} → ${stayOracle}`);
      check('AC1.2e', 'hospital-stay indicator ignores invalid dates (discharge before admission / missing)', /msodh3rEMJa\}?\s*>=?\s*#\{[^}]*eMyVanycQSC|daysBetween[^)]*\)\s*>=?\s*0|!= *''|d2:hasValue/i.test(p.filter || '') || /d2:condition/.test(p.expression), p.filter);
    }
  }
  check('AC1.2d', 'average hospital stay shown (admission→discharge days)', stayOk, { stayIds, stayOracle });

  const dims = (v) => [...(v.columns || []), ...(v.rows || []), ...(v.filters || [])];
  const peIsMonthly = (v) => dims(v).some(d => d.dimension === 'pe' && v.columns.concat(v.rows).some(x => x.dimension === 'pe') && d.items.length >= 3);
  check('AC1.3', 'a monthly trend chart (months on the axis)', viz.some(v => /LINE|COLUMN|BAR|AREA/.test(v.type) && peIsMonthly(v)), viz.map(v => v.type));
  const deDim = (v, de) => [...(v.columns || []), ...(v.rows || [])].some(d => d.dimension.endsWith(de)) || (v.dataElementDimensions || []).some(d => d.dataElement?.id === de && [...(v.columns || []), ...(v.rows || [])].some(x => x.dimension.includes(de)));
  const evDe = (o, de) => [...(o.columns || []), ...(o.rows || [])].some(d => d.dimension.includes(de));
  // What each tile really reads: its non-dx/pe/ou dimensions by name, and the
  // fields its program indicators filter on.
  const dimName = {};
  const readsField = async (v, re, deId) => {
    for (const d of [...(v.columns || []), ...(v.rows || []), ...(v.filters || [])]) {
      if (['dx', 'pe', 'ou'].includes(d.dimension)) continue;
      if (d.dimension.includes(deId)) return true;
      if (!(d.dimension in dimName)) { const r = await get(`dimensions/${d.dimension}?fields=displayName`); dimName[d.dimension] = r.body?.displayName || ''; }
      if (re.test(dimName[d.dimension])) return true;
    }
    for (const pi of (v.dataDimensionItems || []).map(x => x.programIndicator?.id).filter(Boolean)) {
      const p = await getJ(`programIndicators/${pi}?fields=filter,expression`);
      if (String(`${p.filter} ${p.expression}`).includes(deId)) return true;
    }
    return false;
  };
  let dxTile = null, ageSexTile = null;
  for (const v of viz) {
    if (!dxTile && await readsField(v, /diagnos|icd/i, DE.dx)) dxTile = v.name;
    if (!ageSexTile && await readsField(v, /\bage\b/i, DE.age) && await readsField(v, /sex|gender/i, DE.sex)) ageSexTile = v.name;
  }
  check('AC1.4', 'most common diagnoses: a tile that reads the Diagnosis (ICD-10) field', !!dxTile, viz.map(v => v.name));
  check('AC1.5', 'age-and-sex breakdown: one tile that reads both age and sex', !!ageSexTile, viz.map(v => v.name));

  console.log('\n— Maps —');
  const views = maps.flatMap(m => (m.mapViews || []).map(v => ({ ...v, mapName: m.name })));
  const lvl = (v) => (v.organisationUnitLevels || [])[0];
  const isDeaths = (v) => /death|died|mortal/i.test(`${v.name} ${v.mapName}`) || JSON.stringify(v.filters || []).includes('MODDIED') || JSON.stringify(v.dataDimensionItems || []).length && /death|died/i.test(v.mapName);
  const thematic = views.filter(v => v.layer && v.layer.startsWith('thematic'));
  const deathsDistrict = thematic.find(v => lvl(v) === 2 && isDeaths(v));
  check('AC1.6a', 'map: deaths by district (thematic, level 2)', !!deathsDistrict, thematic.map(v => [v.mapName, lvl(v)]));
  const casesFacility = views.find(v => (v.layer?.startsWith('thematic') && lvl(v) === 4 && !isDeaths(v)));
  check('AC1.6b', 'map: case numbers by facility (level 4)', !!casesFacility, thematic.map(v => [v.mapName, lvl(v)]));
  const eventLayer = views.find(v => v.layer === 'event' && v.program?.id === P);
  check('AC1.6c', 'map: individual cases (event layer on the program)', !!eventLayer, views.map(v => [v.mapName, v.layer]));
  const mapPeriodBad = views.filter(v => v.layer === 'thematic' || v.layer === 'event').filter(v => {
    const fixed = (v.periods || []).map(p => p.id).sort().join(';') || (v.filters || []).find(f => f.dimension === 'pe')?.items?.map(i => i.id).sort().join(';') || '';
    const datesOk = v.startDate && v.endDate && dayIso(v.startDate) === '2026-08-01' && dayIso(v.endDate) === '2026-10-31';
    return !((fixed === PE || datesOk) && !hasRel(v.relativePeriods));
  }).map(v => v.mapName);
  check('AC1.9b', 'every map layer uses Aug–Oct 2026', mapPeriodBad.length === 0, mapPeriodBad);
  // Consistency: the district deaths layer adds up to the deaths total.
  if (deathsDistrict) {
    const dx = (deathsDistrict.columns || []).find(c => c.dimension === 'dx')?.items?.[0]?.id || deathsDistrict.dataDimensionItems?.[0]?.programIndicator?.id;
    if (dx) {
      const a = await get(`analytics.json?dimension=dx:${dx}&dimension=ou:${ROOT};LEVEL-2&filter=pe:${PE}`);
      const sum = (a.body?.rows || []).reduce((s, r) => s + Number(r[r.length - 1]), 0);
      check('AC1.9c', `district deaths map adds up to the deaths total (${deaths})`, sum === deaths, { dx, sum, status: a.status });
    } else check('AC1.9c', 'district deaths map has a data item', false, deathsDistrict.columns);
  }
  if (casesFacility) {
    const dx = (casesFacility.columns || []).find(c => c.dimension === 'dx')?.items?.[0]?.id;
    if (dx) {
      const a = await get(`analytics.json?dimension=dx:${dx}&dimension=ou:${ROOT};LEVEL-4&filter=pe:${PE}`);
      const sum = (a.body?.rows || []).reduce((s, r) => s + Number(r[r.length - 1]), 0);
      check('AC1.9d', `facility cases map adds up to the cases total (${total})`, sum === total, { dx, sum, status: a.status });
    }
  }

  console.log('\n— Line lists —');
  const lineLists = lls.filter(l => l.type === 'LINE_LIST' && l.program?.id === P);
  check('AC1.7a', 'two line lists on the program', lineLists.length >= 2, lls.map(l => [l.type, l.program?.id]));
  const filt = (l) => JSON.stringify([...(l.columns || []), ...(l.rows || []), ...(l.filters || [])].filter(d => d.dimension.includes(DE.mode)).map(d => d.filter || '') );
  const deathsLL = lineLists.find(l => /MODDIED/.test(filt(l)));
  const allLL = lineLists.find(l => l !== deathsLL && !/MODDIED/.test(filt(l)));
  check('AC1.7b', 'a deaths line list filtered on Mode of Discharge = died', !!deathsLL, lineLists.map(l => [l.name, filt(l)]));
  check('AC1.7c', 'an all-cases line list (no outcome filter)', !!allLL, lineLists.map(l => l.name));
  const llPeriodBad = lineLists.filter(l => {
    const pe = [...(l.columns || []), ...(l.rows || []), ...(l.filters || [])].find(d => /^(pe|eventDate|enrollmentDate|incidentDate|scheduledDate|lastUpdated)$/.test(d.dimension));
    const fixed = pe ? (pe.items || []).map(i => i.id).sort().join(';') : '';
    const datesOk = l.startDate && l.endDate && dayIso(l.startDate) === '2026-08-01' && dayIso(l.endDate) === '2026-10-31';
    return !((fixed === PE || datesOk) && !hasRel(l.relativePeriods));
  }).map(l => l.name);
  check('AC1.9e', 'line lists use Aug–Oct 2026', llPeriodBad.length === 0, llPeriodBad);
  if (deathsLL) {
    // The saved list's own period, places and outcome filter.
    const axes = [...(deathsLL.columns || []), ...(deathsLL.rows || []), ...(deathsLL.filters || [])];
    const time = axes.find(d => /^(pe|eventDate)$/.test(d.dimension));
    const ouAx = axes.find(d => d.dimension === 'ou');
    const modeAx = axes.find(d => d.dimension.includes(DE.mode));
    const timePart = time && (time.items || []).length ? `dimension=pe:${time.items.map(i => i.id).join(';')}` : (deathsLL.startDate ? `startDate=${dayIso(deathsLL.startDate)}&endDate=${dayIso(deathsLL.endDate)}` : '');
    const q = await get(`analytics/events/query/${P}.json?${timePart}&dimension=ou:${(ouAx?.items || [{ id: ROOT }]).map(i => i.id).join(';')}&dimension=${S}.${DE.mode}:${modeAx?.filter || 'IN:MODDIED'}&pageSize=1&totalPages=true`);
    check('AC1.9f', `the saved deaths line list returns ${deaths} rows`, q.body?.metaData?.pager?.total === deaths, { pager: q.body?.metaData?.pager, timePart, filter: modeAx?.filter });
  }

  console.log('\n— Answer —');
  const links = answerLinkIds(answerText);
  check('AC1.10a', 'answer gives the dashboard link', links.some(l => l.includes(dash.id)), links);
  check('AC1.10b', 'answer says which date the charts use (report/event date)', /(report|event|visit|occurr\w*)[ -]dates?/i.test(answerText));
  check('AC1.10c', 'answer explains that admission/discharge dates are years before the report dates', /(admission|discharge)[^\n]{0,220}(2021|wrong year|years? (?:before|earlier|off|apart)|more than a year|five years|do not match|don't match|inconsisten)/i.test(answerText));
  check('AC1.10d', 'answer mentions the records with missing values (age / sex)', /(missing|no|without|blank)[^.\n]{0,60}(age|sex|gender)/i.test(answerText));

  if (browserOn) {
    console.log('\n— Rendered in Chrome —');
    const s = await browserSession();
    if (!s) { check('AC1.12', 'dashboard rendered in Chrome', false, 'no playwright-core'); return; }
    const page = await s.c.newPage();
    const errs = []; page.on('pageerror', e => errs.push(String(e)));
    await page.goto(`${BASE}/dhis-web-dashboard/#/${dash.id}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(45000);
    // Scroll the dashboard step by step so every tile loads (tiles load when shown).
    let text = '';
    let same = 0;
    await page.mouse.move(800, 700);
    for (let step = 0; step < 14 && same < 2; step++) {
      await page.screenshot({ path: path.join(SHOT_DIR, `inpatient-${step + 1}.png`) });
      const now = await allFramesText(page);
      same = text.includes(now) ? same + 1 : 0;
      text += '\n' + now;
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(10000);
    }
    const errTiles = (text.match(/There was an error loading data|Something went wrong|Error loading|failed to load|\bError: |Cannot read properties/gi) || []).length;
    const titles = [...viz.map(v => v.name), ...maps.map(m => m.name), ...lls.map(l => l.name)];
    const shown = titles.filter(t => text.includes(t));
    check('AC1.12', 'every tile renders: all tile titles drawn, no error tiles', errTiles === 0 && shown.length === titles.length && !/Log in|Sign in to/i.test(text.slice(0, 400)), { errTiles, missing: titles.filter(t => !text.includes(t)), pageErrors: errs.slice(0, 3) });
    info(`screenshots: ${path.join(SHOT_DIR, 'inpatient-1.png')} … inpatient-N.png`);
    await s.browser.close();
  }
}

// ───────────────────────── 2. Malaria Case Explorer app ─────────────────────────
async function malaria() {
  const P = 'qDkgAbB5Jlk';
  const ST = { hYyB7FUS5eR: 'dx', wYTF0YCHMWr: 'inv', eHvTba5ijAh: 'out', C0aLZo75dgJ: 'hh' };
  console.log('\n— Oracle (tracker API) —');
  const te = await getJ(`tracker/trackedEntities?program=${P}&ouMode=ALL&paging=false&fields=trackedEntity,enrollments[enrollment,program,status,enrolledAt,orgUnit,events[programStage,status,occurredAt,dataValues[dataElement,value]]]`);
  const tes = te.trackedEntities || te.instances || [];
  const cases = [];
  for (const t of tes) for (const en of t.enrollments || []) {
    if (en.program !== P) continue;
    const by = { dx: [], inv: [], out: [], hh: [] };
    for (const e of en.events || []) if (ST[e.programStage]) by[ST[e.programStage]].push(e);
    const val = (st, de) => by[st].flatMap(e => e.dataValues).find(v => v.dataElement === de)?.value;
    cases.push({ en: en.enrollment, status: en.status, result: val('dx', 'aY4kB8kS521'), hasInv: by.inv.length > 0, hasOut: by.out.length > 0, outcome: val('out', 'zXNfOKXRBA9'), hasHH: by.hh.length > 0 });
  }
  const total = cases.length;
  const posNoInv = cases.filter(c => c.result === 'POSITIVE' && !c.hasInv).length;
  const noOutcome = cases.filter(c => !c.outcome).length;
  const noOutcomeEvent = cases.filter(c => !c.hasOut).length;
  const positive = cases.filter(c => c.result === 'POSITIVE').length;
  const negative = cases.filter(c => c.result === 'NEGATIVE').length;
  const noResult = cases.filter(c => !c.result).length;
  info(`cases=${total} positive=${positive} negative=${negative} noResult=${noResult} positive-not-investigated=${posNoInv} no-outcome=${noOutcome} (no outcome event ${noOutcomeEvent})`);

  console.log('\n— Installed app —');
  const apps = (await getJ('apps')).filter(a => /malaria case explorer/i.test(a.name || a.displayName || ''));
  check('AC2.1', 'one installed app named "Malaria Case Explorer"', apps.length === 1, apps.map(a => [a.key, a.name]));
  const app = apps[0]; if (!app) return;
  const launch = app.launchUrl || `${BASE}/api/apps/${app.key}/index.html`;
  info(`key=${app.key} launch=${launch}`);
  const src = await appSource(app.key, 'index.html');
  check('AC2.2a', 'reads the malaria program', src.includes(P));
  check('AC2.2b', 'uses all four stages (diagnosis, investigation, outcome, household)', Object.keys(ST).every(s => src.includes(s)), Object.keys(ST).filter(s => !src.includes(s)));
  check('AC2.2c', 'treatment kept per stage (medication read by stage, not merged)', /nTMP8Aj1rYA/.test(src) && /programStage/.test(src));
  check('AC2.4a', 'export of matching cases (CSV/download)', /csv|download|export/i.test(src));
  check('AC2.4b', 'filters for location, dates, test result and case status in the code', /orgUnit|org unit|location/i.test(src) && /date/i.test(src) && /aY4kB8kS521|test result/i.test(src) && /status/i.test(src));
  const links = answerLinkIds(answerText);
  check('AC2.7', 'answer gives the app link', links.some(l => l.includes(app.key) || l.includes(encodeURIComponent(app.name))), links);

  if (!browserOn) return;
  console.log('\n— Opened in Chrome —');
  const s = await browserSession();
  if (!s) { check('AC2.3', 'app opened in Chrome', false, 'no playwright-core'); return; }
  const page = await s.c.newPage();
  const consoleErr = []; const failed = [];
  // Only what the APP does counts: the 2.43 global shell around it requests its own
  // header assets (staticContent/logo_banner is a 404 when no logo is set).
  const fromApp = (f) => !!f && f.url().includes(`/api/apps/${app.key}/`);
  page.on('console', m => { const u = (m.location && m.location().url) || ''; if (m.type() === 'error' && (u.includes(`/api/apps/${app.key}/`) || /\/api\/apps\//.test(m.text()))) consoleErr.push(`${m.text()} @ ${u.slice(-80)}`); });
  page.on('pageerror', e => { if (String(e.stack || e).includes(`/api/apps/${app.key}/`)) consoleErr.push(String(e)); });
  page.on('response', r => { let f = null; try { f = r.frame(); } catch { /* */ } if (r.status() >= 400 && r.url().includes('/api/') && fromApp(f)) failed.push(`${r.status()} ${r.url().slice(0, 160)}`); });
  await page.goto(launch, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(30000);
  await page.screenshot({ path: path.join(SHOT_DIR, 'malaria-app.png'), fullPage: true });
  const text = await allFramesText(page);
  const nums = (text.match(/\d+/g) || []).map(Number);
  check('AC2.3a', 'opens with no console errors and no failed API calls', consoleErr.length === 0 && failed.length === 0, { consoleErr: consoleErr.slice(0, 3), failed: failed.slice(0, 3) });
  check('AC2.3b', `total cases ${total} shown`, nums.includes(total), text.slice(0, 300));
  check('AC2.3c', `positive cases not investigated (${posNoInv}) shown`, nums.includes(posNoInv));
  check('AC2.3d', `cases without an outcome (${noOutcome}) shown`, nums.includes(noOutcome) || nums.includes(noOutcomeEvent));
  const fr = appFrame(page, app.key);
  // The case table can sit behind a tab ("Cases (37)"): open it the way a user would.
  // Tabs and actions are buttons; a summary card can carry the same word ("Cases").
  const clickText = async (re) => { const loc = fr.locator('button, [role="tab"], a', { hasText: re }).first(); if (await loc.count()) { await loc.click({ timeout: 10000 }); await page.waitForTimeout(3000); return true; } return false; };
  await clickText(/^\s*(cases|case list|case table)\b/i).catch(() => false);
  const rows = await fr.evaluate(() => document.querySelectorAll('table tbody tr, [role="row"]').length).catch(() => 0);
  // All cases are in the list: as rows, or as a paged list whose total says so ("items 1-20 of 37").
  check('AC2.5', `all ${total} cases listed, including those with missing visits`, rows >= total || new RegExp(`\\b${total}\\b\\s*(cases|records|results)|\\bof\\s+${total}\\b`, 'i').test(await fr.evaluate(() => document.body.innerText).catch(() => text)), { rows });
  // open the first case → a timeline should appear
  try {
    const before = await fr.evaluate(() => document.body.innerText);
    // Open the first case the way a user would: its button / link / the text with a
    // pointer cursor (a case id), else the row itself.
    const openBtn = fr.locator('tbody tr button, [role="row"] button', { hasText: /open|view|details/i }).first();
    if (await openBtn.count()) await openBtn.click({ timeout: 10000 });
    else {
      const marked = await fr.evaluate(() => {
        const row = document.querySelector('tbody tr');
        const el = row && ([...row.querySelectorAll('a, button, [role="button"]')][0] || [...row.querySelectorAll('*')].find((e) => getComputedStyle(e).cursor === 'pointer' && e.children.length === 0));
        if (el) el.setAttribute('data-verify-open', '1');
        return !!el;
      });
      await (marked ? fr.locator('[data-verify-open="1"]').first() : fr.locator('tbody tr').first()).click({ timeout: 10000 });
    }
    await page.waitForTimeout(4000);
    const t2 = (await fr.evaluate(() => document.body.innerText)).replace(before, '');
    await page.screenshot({ path: path.join(SHOT_DIR, 'malaria-case.png'), fullPage: true });
    const stagesShown = ['diagnosis', 'investigation', 'outcome', 'household'].filter(w => new RegExp(w, 'i').test(t2)).length;
    check('AC2.6', 'opening a case shows its visits in date order (a timeline)', (/timeline|history|visits/i.test(t2) && stagesShown >= 1 || stagesShown >= 2) && /\d{4}-\d{2}-\d{2}/.test(t2), t2.slice(0, 300));
  } catch (e) { check('AC2.6', 'opening a case shows a timeline', false, String(e).slice(0, 160)); }
  // Close the case window the way a user would, then open the map view.
  const closeBtn = fr.locator('button', { hasText: /^\s*close\s*$/i }).first();
  if (await closeBtn.count()) await closeBtn.click().catch(() => {}); else await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1500);
  await clickText(/facility map|^\s*map\s*$/i).catch(() => false);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(SHOT_DIR, 'malaria-map.png'), fullPage: true });
  // A map: a map library, or an echarts chart on a geo coordinate system (boundaries),
  // not a latitude/longitude scatter.
  const mapState = await fr.evaluate(() => {
    const libMap = !!document.querySelector('.leaflet-container, .maplibregl-canvas, .ol-viewport');
    let geo = false; let scatterOnly = false;
    if (window.echarts) {
      for (const el of document.querySelectorAll('div')) {
        const inst = window.echarts.getInstanceByDom(el);
        if (!inst) continue;
        const o = inst.getOption() || {};
        const series = o.series || [];
        if ((o.geo && o.geo.length) || series.some((x) => x.type === 'map' || x.coordinateSystem === 'geo')) geo = true;
        else if (series.some((x) => x.type === 'scatter' || x.type === 'effectScatter')) scatterOnly = true;
      }
    }
    return { modalOpen: !!document.querySelector('[role="dialog"], [data-test*="modal"]'), libMap, geo, scatterOnly };
  }).catch(() => ({}));
  check('AC2.6b', 'a facility map is drawn on boundaries (not a latitude/longitude scatter)', !mapState.modalOpen && (mapState.libMap || mapState.geo), mapState);

  // Filter: test result = positive must show the positive cases only.
  try {
    // The select whose label says "test result" (DHIS2 UI SingleSelectField), then its "Positive" option.
    const field = fr.locator('[data-test="dhis2-uiwidgets-singleselectfield"]', { hasText: /test result/i }).first();
    const opener = (await field.count()) ? field.locator('[data-test="dhis2-uicore-select-input"]').first() : fr.locator('select').filter({ hasText: /positive/i }).first();
    if (await fr.locator('select').filter({ hasText: /positive/i }).count()) await fr.locator('select').filter({ hasText: /positive/i }).first().selectOption({ label: 'Positive' });
    else {
      await opener.click({ timeout: 8000 });
      await page.waitForTimeout(800);
      await fr.locator('[data-test="dhis2-uicore-singleselectoption"], [role="option"]', { hasText: /^\s*positive\s*$/i }).first().click({ timeout: 8000 });
    }
    await page.waitForTimeout(4000);
    const t3 = await fr.evaluate(() => document.body.innerText);
    check('AC2.4c', `filtering on test result "positive" shows ${positive} cases`, new RegExp(`(^|\\D)${positive}(\\D|$)`).test(t3) && !new RegExp(`(^|\\D)${total}\\s+(matching|cases)`, 'i').test(t3), t3.slice(0, 200));
  } catch (e) { check('AC2.4c', 'filtering on test result works', false, String(e).slice(0, 160)); }

  // Export: the CSV holds every matching case.
  try {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), fr.locator('button', { hasText: /export|csv|download/i }).first().click()]);
    const file = await dl.path();
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    check('AC2.4d', `the CSV export holds the ${positive} filtered cases (plus a header)`, lines.length - 1 === positive, { rows: lines.length - 1, header: lines[0].slice(0, 120) });
  } catch (e) { check('AC2.4d', 'the CSV export downloads', false, String(e).slice(0, 160)); }
  info(`screenshots: ${path.join(SHOT_DIR, 'malaria-app.png')}, malaria-case.png`);
  await s.browser.close();
}

// ───────────────────────── 3. Contact Follow-up dashboard plugin ─────────────────────────
async function contacts() {
  const P = 'N7bpeUCYTbV';
  console.log('\n— Installed plugin —');
  const apps = (await getJ('apps')).filter(a => /contact follow-?up/i.test(a.name || a.displayName || ''));
  check('AC3.1', 'one installed app named "Contact Follow-up" that is a dashboard plugin', apps.length === 1 && apps.every(a => a.pluginLaunchUrl || /DASHBOARD/i.test(a.pluginType || '')), apps.map(a => [a.key, a.name, a.pluginType, !!a.pluginLaunchUrl]));
  const app = apps[0]; if (!app) return;
  const pluginUrl = app.pluginLaunchUrl || `${BASE}/api/apps/${app.key}/plugin.html`;
  const src = await appSource(app.key, String(pluginUrl).split('/').pop().split('?')[0] || 'plugin.html');
  check('AC3.2a', 'reads the Ebola contact follow-up program', src.includes(P));
  check('AC3.2b', '21 follow-up days', /\b21\b/.test(src));
  check('AC3.2c', 'labels the "day after enrollment" assumption', /day after enrol/i.test(src));
  check('AC3.2d', 'distinguishes seen / not seen / missing / future', /not seen/i.test(src) && /missing/i.test(src) && /future/i.test(src));
  check('AC3.6', 'responds to dashboard filters (dashboardItemFilters)', /dashboardItemFilters/.test(src));

  console.log('\n— Demonstration dashboard —');
  const dl = await getJ(`dashboards?filter=dashboardItems.appKey:eq:${enc(app.key)}&fields=id,name,dashboardItems[id,type,appKey]&paging=false`);
  const dash = (dl.dashboards || [])[0];
  const copies = (dash?.dashboardItems || []).filter(i => i.appKey === app.key);
  check('AC3.3', 'a dashboard holds the plugin twice', copies.length === 2, { dashboards: (dl.dashboards || []).map(d => d.name), copies: copies.length });
  if (!dash) return;
  // per-copy settings in the dataStore, keyed by dashboard item id
  const ns = await getJ('dataStore');
  const hits = [];
  for (const n of ns) {
    for (const it of copies) {
      const r = await get(`dataStore/${enc(n)}/${it.id}`);
      if (r.status === 200) hits.push({ ns: n, item: it.id, value: r.body });
    }
  }
  const vals = hits.map(h => JSON.stringify(h.value));
  check('AC3.4a', 'each copy has its own saved settings', hits.length === 2 && vals[0] !== vals[1], hits.map(h => [h.ns, h.item, JSON.stringify(h.value).slice(0, 120)]));
  // Not asked for by this prompt: reported, not judged.
  const links = answerLinkIds(answerText);
  info(`answer links the dashboard: ${links.some(l => l.includes(dash.id))}`);

  if (!browserOn) return;
  console.log('\n— Rendered in Chrome (twice: before and after reload) —');
  const s = await browserSession();
  if (!s) { check('AC3.5', 'plugin rendered in Chrome', false, 'no playwright-core'); return; }
  const page = await s.c.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  const pluginFrames = () => page.frames().filter(f => f.url().includes(`/api/apps/${app.key}/`) || f.url().includes(`/${app.key}/`));
  const read = async () => { const out = []; for (const f of pluginFrames()) { try { out.push(await f.evaluate(() => document.body.innerText)); } catch { /* */ } } return out; };
  await page.goto(`${BASE}/dhis-web-dashboard/#/${dash.id}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(60000);
  const first = await read();
  await page.screenshot({ path: path.join(SHOT_DIR, 'contacts-1.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(60000);
  const second = await read();
  await page.screenshot({ path: path.join(SHOT_DIR, 'contacts-2.png') });
  check('AC3.5a', 'both copies render', first.length === 2 && first.every(t => t.length > 50), first.map(t => t.slice(0, 100)));
  check('AC3.5b', 'the two copies show different settings', first.length === 2 && first[0] !== first[1]);
  check('AC3.5c', 'each copy keeps its settings after reload', second.length === 2 && second.slice().sort().join('|') === first.slice().sort().join('|'), second.map(t => t.slice(0, 100)));
  check('AC3.5d', 'no errors in the plugin', errs.length === 0 && !first.join('\n').match(/error|failed/i), errs.slice(0, 3));
  // Numbers: recomputed from the tracker API for the window and day count each copy states.
  const te = await getJ(`tracker/trackedEntities?program=${P}&ouMode=ALL&paging=false&fields=enrollments[enrollment,program,enrolledAt,events[occurredAt,status,dataValues[value]]]`);
  const ens = (te.trackedEntities || te.instances || []).flatMap(t => t.enrollments || []).filter(e => e.program === P);
  const today = dayIso(Date.now());
  const fmt = (n) => [String(n), n.toLocaleString('en-US')];
  second.forEach((txt, i) => {
    let w = txt.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|–|-|—)\s*(\d{4}-\d{2}-\d{2})/);
    // A copy may state a relative period instead of dates (LAST_12_MONTHS = the 12 completed months).
    const rel = txt.match(/LAST_(\d+)_MONTHS|last (\d+) months/i);
    if (!w && rel) {
      const n = Number(rel[1] || rel[2]); const now = new Date();
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - n + 1, 1));
      w = [null, dayIso(start), dayIso(end)];
    }
    if (!w && /this year|THIS_YEAR/i.test(txt)) { const y = new Date().getUTCFullYear(); w = [null, `${y}-01-01`, `${y}-12-31`]; }
    // The day count: the last day column (D1 … D21), else "through day N" / "N-day".
    // Day columns are "D1 … D21" or a header row of plain numbers "1 2 … 21".
    const hdr = txt.match(/(?:^|\n)[^\n]*?((?:\b\d{1,2}\b\s+){5,})/);
    const plain = hdr ? hdr[1].trim().split(/\s+/).map(Number) : [];
    const seq = plain.length && plain.every((n, k) => n === k + 1) ? plain : [];
    const cols = [...Array.from(txt.matchAll(/\bD(\d{1,2})\b/g)).map(m => Number(m[1])), ...seq];
    const nDays = (cols.length ? Math.max(...cols) : 0) || Number((txt.match(/through day (\d+)|(\d+)[- ]day/i) || []).slice(1).find(Boolean)) || 21;
    if (!w) { check('AC3.8', `copy ${i + 1}: states its date window`, false, txt.slice(0, 160)); return; }
    const cohort = ens.filter(e => e.enrolledAt.slice(0, 10) >= w[1] && e.enrolledAt.slice(0, 10) <= w[2]);
    let seen = 0, notSeen = 0;
    for (const en of cohort) {
      const e0 = new Date(en.enrolledAt.slice(0, 10) + 'T00:00:00Z');
      const days = new Map();
      for (const ev of en.events || []) {
        if (!ev.occurredAt) continue;
        const d = Math.round((new Date(ev.occurredAt.slice(0, 10) + 'T00:00:00Z') - e0) / 86400000);
        if (d < 1 || d > nDays) continue;
        const v = (ev.dataValues || [])[0]?.value;
        days.set(d, (days.get(d) || new Set()).add(v));
      }
      for (const [d, vals] of days) { if (dayIso(e0.getTime() + d * 86400000) > today) continue; if (vals.has('SEEN')) seen++; else if (vals.has('NOT_SEEN')) notSeen++; }
    }
    const has = (n) => fmt(n).some(x => new RegExp(`(^|\\D)${x.replace(/,/g, ',')}(\\D|$)`).test(txt));
    info(`copy ${i + 1}: window ${w[1]}..${w[2]}, ${nDays} days → contacts ${cohort.length}, seen days ${seen}, not-seen days ${notSeen}`);
    check('AC3.8', `copy ${i + 1}: contacts (${cohort.length}), seen days (${seen}) and not-seen days (${notSeen}) match the tracker data`, has(cohort.length) && has(seen) && has(notSeen), txt.slice(0, 400));
  });
  // Clicking a day shows that day's visits.
  try {
    const f1 = pluginFrames()[0];
    const before = await f1.evaluate(() => document.body.innerText);
    const marked = await f1.evaluate(() => {
      const cell = [...document.querySelectorAll('td, [role="gridcell"], button, div')].find((e) => /^\s*✓\s*$/.test(e.innerText || '') && e.children.length <= 1);
      if (cell) cell.setAttribute('data-verify-day', '1');
      return !!cell;
    });
    if (!marked) throw new Error('no seen day cell found');
    await f1.locator('[data-verify-day="1"]').first().click({ timeout: 8000 });
    await page.waitForTimeout(3000);
    let after = await f1.evaluate(() => document.body.innerText);
    // "Clicking a day" may mean the day's column header (D7) rather than one cell.
    if (after === before) {
      const head = f1.locator('th, [role="columnheader"], button', { hasText: /^\s*D?7\s*$/ }).first();
      if (await head.count()) { await head.click({ timeout: 8000 }); await page.waitForTimeout(3000); after = await f1.evaluate(() => document.body.innerText); }
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'contacts-day.png') });
    const added = after.length > before.length ? after : '';
    check('AC3.9', 'clicking a day shows the visits of that day (date and seen status)', !!added && /\d{4}-\d{2}-\d{2}|\d{1,2} [A-Z][a-z]{2}/.test(added) && /seen/i.test(added) && after !== before, after.slice(0, 200));
    await page.keyboard.press('Escape').catch(() => {});
  } catch (e) { check('AC3.9', 'clicking a day shows its visits', false, String(e).slice(0, 160)); }

  // The dashboard's period filter reaches both copies: This month = contacts enrolled this month.
  try {
    const dashFrame = page.frames().find((f) => f.url().includes('dhis-web-dashboard')) || page.mainFrame();
    await dashFrame.getByRole('button', { name: /filter/i }).first().click({ timeout: 10000 });
    await page.waitForTimeout(1200);
    await dashFrame.getByText(/^Period$/).first().click({ timeout: 10000 });
    await page.waitForTimeout(2000);
    await dashFrame.getByText(/^This month$/).first().dblclick({ timeout: 10000 });
    await page.waitForTimeout(800);
    await dashFrame.getByRole('button', { name: /^confirm$/i }).first().click({ timeout: 10000 });
    await page.waitForTimeout(40000);
    const filtered = await read();
    await page.screenshot({ path: path.join(SHOT_DIR, 'contacts-filtered.png') });
    const now = new Date(); const y = now.getUTCFullYear(); const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const te2 = await getJ(`tracker/enrollments?program=${P}&ouMode=ALL&enrolledAfter=${y}-${m}-01&enrolledBefore=${dayIso(Date.UTC(y, now.getUTCMonth() + 1, 0))}&pageSize=1&totalPages=true&fields=enrollment`);
    const want = te2.pager?.total;
    const showsCount = (t) => new RegExp(`(^|\\D)${want}(\\D|$)`).test(t) && !/(^|\D)(225|300)(\D|$)/.test(t.slice(0, 400));
    check('AC3.6b', `with the dashboard period filter "This month", both copies show the ${want} contacts enrolled this month`, filtered.length === 2 && filtered.every(showsCount), filtered.map((t) => t.slice(0, 160)));
  } catch (e) { check('AC3.6b', 'the dashboard period filter reaches the plugin', false, String(e).slice(0, 160)); }
  info(`screenshots: ${path.join(SHOT_DIR, 'contacts-1.png')}, contacts-2.png, contacts-day.png, contacts-filtered.png`);
  await s.browser.close();
}

(async () => {
  const fn = { inpatient, malaria, contacts }[thread];
  if (!fn) { console.log('usage: verify-complex-builds-llm.js <inpatient|malaria|contacts> [--answer file] [--since ISO] [--no-browser]'); process.exit(2); }
  try { await fn(); } catch (e) { failures++; console.log('  ✗ checker error: ' + (e.stack || e)); }
  const out = opt('--json'); if (out) fs.writeFileSync(out, JSON.stringify({ thread, base: BASE, results }, null, 1));
  console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks passed`);
  console.log(failures ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(failures ? 1 : 0);
})();
