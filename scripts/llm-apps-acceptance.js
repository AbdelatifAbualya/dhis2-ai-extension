#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * llm-apps-acceptance.js — the chatbot builds complex apps and plugins itself.
 *
 * Each case is a fresh chat thread: the REAL agent loop (llm-harness.js) with a
 * REAL model, asked in plain user language. The test only answers the model's
 * questions with a plain "yes". Afterwards every result is checked in a real
 * browser against the DHIS2 API (rendered data, placement in the real Capture /
 * Dashboard apps, writes, console errors), and every DHIS2 API call the chatbot
 * made is audited (target: zero ≥ 400).
 *
 *   LLM_BASE_URL=https://api.fireworks.ai/inference/v1 LLM_MODEL=… LLM_API_KEY=… \
 *     node scripts/llm-apps-acceptance.js [--only=A,C] [--keep]
 *
 * Writes test-results/custom-apps-llm/report.html (gitignored). Leaves the
 * server as found: every app the model installed is deleted (which also takes
 * it off dashboards and out of Capture), its dashboards and backups removed,
 * and the Capture configuration compared with the snapshot taken first.
 * ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results', 'custom-apps-llm');
const SHOTS = path.join(OUT, 'screens');
fs.mkdirSync(SHOTS, { recursive: true });
// A fresh thread per run (llm-harness persists session storage to this file).
process.env.LLM_SESSION_FILE = path.join(OUT, 'llm-session.json');
fs.rmSync(process.env.LLM_SESSION_FILE, { force: true });
const { loadLLM, API, events, BASE } = require('./llm-harness');

const ARGS = process.argv.slice(2);
const KEEP = ARGS.includes('--keep');
const ONLY = ((ARGS.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean);
const AUTHH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');
const BACKUP_NS = 'dhis2-ai-extension-backups';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (p) => new URLSearchParams(p).toString();
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : (v && typeof v === 'object') ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v === undefined ? null : v);

async function api(p) {
  const r = await fetch(`${BASE}/api/${p}`, { headers: { Authorization: AUTHH, Accept: 'application/json' } });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}
async function apiDelete(p) { return (await fetch(`${BASE}/api/${p}`, { method: 'DELETE', headers: { Authorization: AUTHH } })).status; }
const aiApps = async () => ((await api('apps')) || []).filter((a) => String(a.key).startsWith('ai-'));
async function captureKey(k) {
  const nss = await api('dataStore');
  if (!Array.isArray(nss) || !nss.includes('capture')) return null;
  const keys = await api('dataStore/capture');
  return Array.isArray(keys) && keys.includes(k) ? api(`dataStore/capture/${k}`) : null;
}

function loadPlaywright() {
  for (const t of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright', 'playwright-core'].filter(Boolean)) { try { return require(t); } catch { /* next */ } }
  const npx = path.join(os.homedir(), '.npm', '_npx');
  for (const d of fs.existsSync(npx) ? fs.readdirSync(npx) : []) {
    const p = path.join(npx, d, 'node_modules', 'playwright-core');
    if (fs.existsSync(path.join(p, 'package.json'))) { try { return require(p); } catch { /* next */ } }
  }
  throw new Error('Playwright not found — set PLAYWRIGHT_CORE_PATH.');
}
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));

// ── Results ─────────────────────────────────────────────────────────────────
const R = { started: new Date().toISOString(), model: process.env.LLM_MODEL, cases: [] };
let cur = null;
function check(name, pass, detail) {
  cur.checks.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail).slice(0, 700) });
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`);
  return !!pass;
}
let shotN = 0;
async function shot(target, label) {
  const file = `${String(++shotN).padStart(2, '0')}-${cur.id}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`;
  try { await target.screenshot({ path: path.join(SHOTS, file) }); cur.shots.push({ file: `screens/${file}`, label }); } catch (e) { cur.logs.push(`screenshot ${label} failed: ${e.message}`); }
}
// Console errors and failed requests that come from ONE app's frames.
function collect(page, key) {
  const log = { console: [], failed: [] };
  const appPath = `/api/apps/${key}/`;
  const fromApp = (req) => { try { return req.frame().url().includes(appPath); } catch { return false; } };
  page.on('response', (res) => { if (res.status() >= 400 && (fromApp(res.request()) || res.url().includes(appPath))) log.failed.push(`${res.status()} ${res.request().method()} ${res.url().replace(BASE, '')}`); });
  page.on('console', (m) => { if (m.type() === 'error' && ((m.location() && m.location().url) || '').includes(appPath)) log.console.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => { if (String(e.stack || '').includes(appPath)) log.console.push(`uncaught: ${e.message}`); });
  return log;
}
async function waitFrame(page, key, file, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const f = page.frames().find((fr) => fr.url().includes(`/api/apps/${key}/${file}`));
    if (f) return f;
    await page.waitForTimeout(500);
  }
  return null;
}
async function settled(frame, timeout = 45000) {
  await frame.waitForFunction(() => { const r = document.getElementById('root'); return r && r.children.length > 0 && !document.querySelector('[role="progressbar"]'); }, null, { timeout }).catch(() => {});
  await frame.waitForTimeout(800);
}

// ── One chat thread ─────────────────────────────────────────────────────────
// Answers only what the model asks for: install after a preview, place after
// an install, then stops. Every DHIS2 call of the thread is audited.
async function converse(c) {
  const { ctx } = loadLLM(c.pageContext);
  await sleep(50);
  await ctx.clearConversationState(); // a fresh side panel
  if (c.url) await ctx.initializeFromUrlNow(c.url);
  const before = new Set((await aiApps()).map((a) => a.key));
  const apiMark = API.length;
  const transcript = [];
  let created = null;
  let msg = c.prompt;
  for (let turn = 1; turn <= 4 && msg; turn++) {
    const evMark = events.length;
    const t0 = Date.now();
    console.log(`  … turn ${turn}: ${msg.slice(0, 110)}`);
    await ctx.runAgenticLoop(msg, null, false, false);
    const ev = events.slice(evMark);
    const calls = ev.filter((e) => e.type === 'AI_TOOL_CALL').map((e) => `${e.tool}(${(e.args && (e.args.action || e.args.path || '')) || ''}${e.args && e.args.target ? ` → ${e.args.target}` : ''})`);
    const answer = [...ev].reverse().find((e) => e.type === 'AI_STREAM_END' && e.text);
    transcript.push({ user: msg, seconds: Math.round((Date.now() - t0) / 1000), tools: calls, answer: answer ? answer.text : '(no text)' });
    console.log(`    tools: ${calls.join(', ') || 'none'}`);
    const now = (await aiApps()).filter((a) => !before.has(a.key));
    if (now.length && !created) created = now[0];
    // Only ever say yes to what the user already asked for.
    if (!created) msg = 'Yes, install it.';
    else if (c.placement && !(await c.placed(created.key))) msg = 'Yes, please add it there.';
    else msg = null;
  }
  const calls = API.slice(apiMark);
  return { ctx, created, transcript, api: { total: calls.length, failed: calls.filter((x) => !x.ok).map((x) => `${x.status} ${x.method} ${x.url}`) } };
}

// ── Cases ───────────────────────────────────────────────────────────────────
const CASES = [
  {
    id: 'A',
    title: 'Standalone app — program explorer with search and paging',
    pageContext: { appType: 'Dashboard' },
    prompt: 'Build an app called "Program explorer" that lists every tracker program on this server with its number of stages and its total number of data elements, with a search box and paging.',
    async verify(browser, app) {
      const progs = (await api(`programs?${qs({ filter: 'programType:eq:WITH_REGISTRATION', fields: 'id,displayName,programStages[programStageDataElements[dataElement[id]]]', paging: 'false' })}`)).programs;
      const pharmacy = progs.find((p) => p.displayName === 'Pharmacy');
      const stages = pharmacy.programStages.length;
      const total = pharmacy.programStages.reduce((n, s) => n + s.programStageDataElements.length, 0);
      const unique = new Set(pharmacy.programStages.flatMap((s) => s.programStageDataElements.map((p) => p.dataElement.id))).size;
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: STATE })).newPage();
      const log = collect(page, app.key);
      await page.goto(`${BASE}/api/apps/${app.key}/index.html?redirect=false`);
      await settled(page.mainFrame());
      await page.waitForTimeout(2000);
      const all = await page.evaluate(() => document.body.innerText);
      check('the app renders a list of tracker programs', progs.filter((p) => all.includes(p.displayName)).length >= 3, all.slice(0, 200).replace(/\s+/g, ' '));
      const search = page.locator('input[type="search"], input[type="text"], input:not([type])').first();
      if (await search.count()) {
        await search.fill('Pharmacy');
        await page.waitForTimeout(2500);
      }
      const row = await page.evaluate(() => {
        const els = [...document.querySelectorAll('tr, li, [role="row"], div')].filter((e) => /\bPharmacy\b/.test(e.innerText || '') && e.innerText.length < 400);
        els.sort((a, b) => a.innerText.length - b.innerText.length);
        const el = els.find((e) => /\d/.test(e.innerText)) || els[0];
        return el ? el.innerText : '';
      });
      const nums = (row.match(/\d[\d,.\u00a0\u202f]*/g) || []).map((x) => Number(x.replace(/[,.\u00a0\u202f]/g, ''))); // "1,274" is one number
      check(`search finds "Pharmacy" and its row shows ${stages} stages and ${total} (or ${unique} unique) data elements`, nums.includes(stages) && (nums.includes(total) || nums.includes(unique)), row.replace(/\s+/g, ' '));
      const after = await page.evaluate(() => document.body.innerText);
      check('the search filters the list', !/\bW4W Clinic\b/.test(after) || !all.includes('W4W Clinic'), after.slice(0, 160).replace(/\s+/g, ' '));
      await shot(page, 'program explorer');
      check('no console errors / failed requests from the app', !log.console.length && !log.failed.length, [...log.console, ...log.failed].join(' | '));
      await page.context().close();
    },
  },
  {
    id: 'B',
    title: 'Dashboard plugin — monthly chart following the filters, placed on a new dashboard',
    pageContext: { appType: 'Dashboard' },
    placement: true,
    prompt: 'Create a dashboard plugin with a column chart of the number of Malaria events per month that follows the org unit and period filters of the dashboard, and add it to a new dashboard called "ai-test LLM malaria".',
    async placed(key) {
      const d = await api(`dashboards?${qs({ filter: `dashboardItems.appKey:eq:${key}`, fields: 'id,displayName', paging: 'false' })}`);
      return (d.dashboards || []).length > 0;
    },
    async verify(browser, app) {
      const d = (await api(`dashboards?${qs({ filter: `dashboardItems.appKey:eq:${app.key}`, fields: 'id,displayName', paging: 'false' })}`)).dashboards || [];
      check('the plugin was placed on a dashboard named "ai-test LLM malaria"', d.some((x) => /ai-test LLM malaria/i.test(x.displayName)), JSON.stringify(d));
      if (!d.length) return;
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: STATE })).newPage();
      const log = collect(page, app.key);
      await page.goto('about:blank');
      await page.goto(`${BASE}/dhis-web-dashboard/#/${d[0].id}`);
      const f = await waitFrame(page, app.key, 'plugin.html');
      check('the plugin renders on the dashboard', !!f);
      if (f) {
        await settled(f);
        await page.waitForTimeout(3000);
        const hasChart = await f.evaluate(() => !!document.querySelector('canvas, svg'));
        const text = await f.evaluate(() => document.body.innerText);
        check('it draws a chart (echarts canvas/svg) and no error notice', hasChart && !/error|failed|could not/i.test(text), text.slice(0, 200).replace(/\s+/g, ' '));
        await shot(page, 'malaria chart on its dashboard');
      }
      check('no console errors / failed requests from the plugin', !log.console.length && !log.failed.length, [...log.console, ...log.failed].join(' | '));
      await page.context().close();
      for (const x of d) createdDashboards.push(x.id);
    },
  },
  {
    id: 'C',
    title: 'Capture enrollment widget (the reported case) — built, installed and placed on the enrollment dashboard',
    url: `${BASE}/apps/capture#/enrollment?enrollmentId=ixCnD4spKWF&orgUnitId=d3V3O1ooYoL&programId=vj5cpA2OOfZ&teiId=dxtupxQ3Ohb`,
    pageContext: { programId: 'vj5cpA2OOfZ', orgUnitId: 'd3V3O1ooYoL', teiId: 'dxtupxQ3Ohb', enrollmentId: 'ixCnD4spKWF', route: 'enrollment', appType: 'Capture' },
    placement: true,
    prompt: 'Please create and install an enrollment plugin here that checks all the medications that were ordered in the Specialized Clinics Drug Order and lists them as a widget on the enrollment dashboard.',
    async placed(key) { const l = await captureKey('enrollmentOverviewLayout'); return !!(l && l.vj5cpA2OOfZ && JSON.stringify(l.vj5cpA2OOfZ).includes(`/api/apps/${key}/`)); },
    async verify(browser, app) {
      check('placed on the Pharmacy enrollment dashboard', await this.placed(app.key));
      const ev = await api(`tracker/events?${qs({ enrollments: 'ixCnD4spKWF', programStage: 'pHbLWI4CaxD', fields: 'dataValues[dataElement,value]', pageSize: 100 })}`);
      const st = await api(`programStages/pHbLWI4CaxD?${qs({ fields: 'programStageDataElements[dataElement[id,optionSet[id]]]' })}`);
      const osOf = Object.fromEntries(st.programStageDataElements.filter((p) => p.dataElement.optionSet).map((p) => [p.dataElement.id, p.dataElement.optionSet.id]));
      const expected = new Set();
      for (const e of ev.events || []) for (const dv of e.dataValues || []) if (osOf[dv.dataElement] && dv.value) {
        const o = (await api(`optionSets/${osOf[dv.dataElement]}?${qs({ fields: 'options[code,displayName]' })}`)).options.find((x) => x.code === dv.value);
        expected.add(o ? o.displayName : dv.value);
      }
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: STATE })).newPage();
      const log = collect(page, app.key);
      await page.goto(this.url);
      const f = await waitFrame(page, app.key, 'plugin.html');
      check('the widget is on the real Capture enrollment dashboard', !!f);
      if (f) {
        await settled(f);
        await page.waitForTimeout(4000);
        const text = await f.evaluate(() => document.body.innerText);
        const missing = [...expected].filter((n) => !text.includes(n));
        check(`it lists every drug ordered for the enrollment by name (${expected.size})`, expected.size && !missing.length, missing.join(' | ') || text.slice(0, 160).replace(/\s+/g, ' '));
        const el = await f.frameElement();
        await el.scrollIntoViewIfNeeded();
        const box = await el.boundingBox();
        const docH = await f.evaluate(() => document.documentElement.scrollHeight);
        check('Capture sized it to its content (nothing cut off)', box.height + 2 >= docH, `frame ${Math.round(box.height)} / content ${docH}`);
        await shot(el, 'medication widget in Capture');
        await shot(page, 'Capture enrollment dashboard');
      }
      check('no console errors / failed requests from the widget', !log.console.length && !log.failed.length, [...log.console, ...log.failed].join(' | '));
      await page.context().close();
    },
  },
  {
    id: 'D',
    title: 'Capture form-field plugin — BMI category + fever alert inside the Initial Assessment form',
    url: `${BASE}/apps/capture#/enrollmentEventNew?enrollmentId=AAHn18XlSn4&orgUnitId=d3V3O1ooYoL&programId=nqT1hqxxjvz&stageId=pP1KQ0hZmYZ&teiId=jrHAwYS65H5`,
    pageContext: { programId: 'nqT1hqxxjvz', orgUnitId: 'd3V3O1ooYoL', teiId: 'jrHAwYS65H5', enrollmentId: 'AAHn18XlSn4', stageId: 'pP1KQ0hZmYZ', route: 'enrollmentEventNew', appType: 'Capture' },
    placement: true,
    prompt: 'Add a plugin to this Initial Assessment form that reads the Weight, Height and Temperature fields and shows the BMI category and a fever alert (38 °C or higher) right inside the form.',
    async placed(key) { const f = await captureKey('dataEntryForms'); return !!(f && f.pP1KQ0hZmYZ && JSON.stringify(f.pP1KQ0hZmYZ).includes(`/api/apps/${key}/`)); },
    async verify(browser, app) {
      const form = ((await captureKey('dataEntryForms')) || {}).pP1KQ0hZmYZ || [];
      const plug = form.flatMap((s) => s.elements).find((e) => e.type === 'plugin' && e.pluginSource.includes(`/api/apps/${app.key}/`));
      const mapped = new Set(((plug && plug.fieldMap) || []).map((f) => f.IdFromApp));
      check('placed in the Initial Assessment form with Weight, Height and Temperature mapped', plug && ['eoCnd8XuOIr', 'DDbjsIbe1Oj', 'KA5fbw0sUQv'].every((id) => mapped.has(id)), JSON.stringify(plug && plug.fieldMap));
      if (!plug) return;
      const alias = Object.fromEntries(plug.fieldMap.map((f) => [f.IdFromApp, f.IdFromPlugin]));
      const eventsBefore = ((await api(`tracker/events?${qs({ enrollments: 'AAHn18XlSn4', programStage: 'pP1KQ0hZmYZ', fields: 'event', pageSize: 100 })}`)).events || []).length;
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: STATE })).newPage();
      const log = collect(page, app.key);
      await page.goto(this.url);
      const f = await waitFrame(page, app.key, 'plugin.html');
      check('the plugin is inside the real Capture form', !!f, JSON.stringify(alias));
      if (f) {
        const capture = f.parentFrame();
        const field = (id) => capture.locator(`[data-test="form-field-${id}"]`).locator('input, textarea').first();
        await settled(f);
        for (const [id, v] of [['eoCnd8XuOIr', '70'], ['DDbjsIbe1Oj', '175'], ['KA5fbw0sUQv', '38.4']]) { await field(id).fill(v); await field(id).press('Tab'); }
        await page.waitForTimeout(3000);
        const hot = (await f.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
        check('with 70 kg / 175 cm / 38.4 °C it shows a normal BMI category and a fever alert', /normal/i.test(hot) && /fever/i.test(hot), hot);
        await (await f.frameElement()).scrollIntoViewIfNeeded();
        await shot(page, 'form plugin with fever');
        await field('KA5fbw0sUQv').fill('36.6');
        await field('KA5fbw0sUQv').press('Tab');
        await page.waitForTimeout(3000);
        const cold = (await f.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
        check('with 36.6 °C the fever alert changes', cold !== hot && (/no fever|normal temp|afebrile/i.test(cold) || !/fever/i.test(cold)), cold);
        const el = await f.frameElement();
        const box = await el.boundingBox();
        const docH = await f.evaluate(() => document.documentElement.scrollHeight);
        check('Capture sized the plugin to its content', box.height + 2 >= docH, `frame ${Math.round(box.height)} / content ${docH}`);
        await shot(page, 'form plugin without fever');
      }
      check('no console errors / failed requests from the plugin', !log.console.length && !log.failed.length, [...log.console, ...log.failed].join(' | '));
      await page.context().close(); // leave the form without saving
      check('no event was saved', ((await api(`tracker/events?${qs({ enrollments: 'AAHn18XlSn4', programStage: 'pP1KQ0hZmYZ', fields: 'event', pageSize: 100 })}`)).events || []).length === eventsBefore);
    },
  },
  {
    id: 'E',
    title: 'App that writes data — shared team notes (add + delete with confirmation)',
    pageContext: { appType: 'Dashboard' },
    prompt: 'Make a small app where my team can add short notes (a title and a text) and delete them. Save them on the server so everyone sees the same notes.',
    async verify(browser, app) {
      const ns = app.activities && app.activities.dhis && app.activities.dhis.namespace;
      check('declared write access with its own dataStore namespace', !!ns, JSON.stringify(app.activities || {}));
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: STATE })).newPage();
      const log = collect(page, app.key);
      await page.goto(`${BASE}/api/apps/${app.key}/index.html?redirect=false`);
      await settled(page.mainFrame());
      const inputs = page.locator('input[type="text"], input:not([type]), textarea');
      const n = await inputs.count();
      check('the app shows a form to add a note', n >= 2, `${n} inputs`);
      if (n >= 2) {
        await inputs.nth(0).fill('ai-test note title');
        await inputs.nth(1).fill('ai-test note body text');
        await page.locator('button').filter({ hasText: /add|save|post|create/i }).first().click();
        await page.waitForTimeout(3000);
        const stored = ns ? JSON.stringify(await api(`dataStore/${ns}?${qs({ fields: '.', paging: 'false' })}`)) : '';
        check('the note is saved on the server (app namespace)', stored.includes('ai-test note title'), stored.slice(0, 200));
        check('and shown in the list', (await page.evaluate(() => document.body.innerText)).includes('ai-test note title'));
        await shot(page, 'notes app with a saved note');
        // Text button or an icon button named by title / aria-label.
        const del = page.locator('button').filter({ hasText: /delete|remove/i })
          .or(page.locator('button[title*="delete" i], button[aria-label*="delete" i], button[title*="remove" i], button[aria-label*="remove" i]')).first();
        if (await del.count()) {
          await del.click();
          await page.waitForTimeout(800);
          const confirm = page.locator('[role="dialog"] button, .modal button, [data-test*="modal"] button').filter({ hasText: /delete|remove|confirm|yes/i }).last();
          const asked = await confirm.count();
          check('delete asks for confirmation first (Modal)', asked > 0);
          if (asked) await confirm.click();
          await page.waitForTimeout(3000);
          const left = ns ? JSON.stringify(await api(`dataStore/${ns}?${qs({ fields: '.', paging: 'false' })}`)) : '';
          check('the note is deleted on the server', !left.includes('ai-test note title'), left.slice(0, 200));
        } else check('there is a delete button', false);
      }
      check('no console errors / failed requests from the app', !log.console.length && !log.failed.length, [...log.console, ...log.failed].join(' | '));
      await page.context().close();
    },
  },
  {
    id: 'F',
    title: 'Transfer-history dashboard plugin (the reported thread, verbatim) — SQL view + plugin + dashboard',
    pageContext: { appType: 'Dashboard' },
    placement: true,
    // The user's own message, typos included (2026-10-23 thread, 2.43.2).
    prompt: 'can you create an install a dhis2 dashboard plugin then install it on a dashbaord that will show the transfers history that happend in all OU where we can filter by date and OU and it shows all transfer history',
    async placed(key) {
      const d = await api(`dashboards?${qs({ filter: `dashboardItems.appKey:eq:${key}`, fields: 'id', paging: 'false' })}`);
      return (d.dashboards || []).length > 0;
    },
    async verify(browser, app, conv) {
      const tools = conv.transcript.flatMap((t) => t.tools).join(' ');
      check('no guessed endpoint was probed (tracker/ownership, audits, schemas/<tracker object>)', !/dhis2_query\((?:tracker\/ownership|audits|schemas\/(?:enrollment|event|trackedEntity|programInstance))/i.test(tools), tools);
      const views = ((await api(`sqlViews?${qs({ fields: 'id,displayName,type,sqlQuery,sharing[public,userGroups]', paging: 'false' })}`)).sqlViews || []).filter((v) => !sqlViewsBefore.has(v.id));
      createdSqlViews.push(...views.map((v) => v.id));
      const tv = views.find((v) => /programownershiphistory/i.test(v.sqlQuery));
      check('it created a QUERY SQL view over programownershiphistory', tv && tv.type === 'QUERY', JSON.stringify(views.map((v) => v.displayName)));
      check('…that its users can read (data-read sharing)', tv && ((tv.sharing && /^..r/.test(tv.sharing.public || '')) || Object.values((tv.sharing && tv.sharing.userGroups) || {}).some((g) => /^..r/.test(g.access || ''))), JSON.stringify(tv && tv.sharing));
      const src = await fetch(`${BASE}/api/apps/${app.key}/src/plugin.jsx`, { headers: { Authorization: AUTHH } }).then((r) => r.text()).catch(() => '');
      check('the plugin reads that view', tv && src.includes(tv.id), src.slice(0, 160));
      const lastAnswer = conv.transcript.map((t) => t.answer).join(' ');
      check('no false "validated on save" claim', !/validat\w* (?:the SQL )?on save|rejects invalid (?:SQL|queries) on save/i.test(lastAnswer), lastAnswer.slice(0, 200));
      // The transfers the plugin should show, read by the test itself (admin).
      const probe = await fetch(`${BASE}/api/sqlViews`, { method: 'POST', headers: { Authorization: AUTHH, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `ai-test-llm-probe-${Date.now()}`, type: 'QUERY', cacheStrategy: 'NO_CACHE', sharing: { public: 'r-r-----' }, sqlQuery: 'select distinct o.name from programownershiphistory h join organisationunit o on o.organisationunitid = h.organisationunitid' }) }).then((r) => r.json());
      const pid = probe && probe.response && probe.response.uid;
      const fromNames = pid ? ((await api(`sqlViews/${pid}/data?paging=false`)).listGrid || { rows: [] }).rows.map((r) => r[0]) : [];
      if (pid) await apiDelete(`sqlViews/${pid}`);
      const d = (await api(`dashboards?${qs({ filter: `dashboardItems.appKey:eq:${app.key}`, fields: 'id,displayName,created', paging: 'false' })}`)).dashboards || [];
      check('the plugin was placed on a dashboard', d.length > 0, JSON.stringify(d));
      for (const x of d) if (!dashboardsBefore.has(x.id)) createdDashboards.push(x.id);
      if (!d.length) return;
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: STATE })).newPage();
      const log = collect(page, app.key);
      await page.goto('about:blank');
      await page.goto(`${BASE}/dhis-web-dashboard/#/${d[0].id}`);
      const f = await waitFrame(page, app.key, 'plugin.html');
      check('the plugin renders on the dashboard', !!f);
      if (f) {
        await settled(f);
        await page.waitForTimeout(3000);
        const text = (await f.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
        const shown = fromNames.filter((n) => text.includes(n));
        check(`it shows the real transfers (org units transferred from: ${fromNames.join(', ')})`, fromNames.length > 0 && shown.length > 0 && !/could not|error|not authori[sz]ed/i.test(text), text.slice(0, 240));
        const dates = f.locator('input[type="date"]');
        check('it has a date filter and an org-unit filter', (await dates.count()) >= 1 && /org(?:anisation|anization)?\s*unit|\bOU\b/i.test(text), `${await dates.count()} date inputs`);
        await shot(page, 'transfer history on its dashboard');
        if (await dates.count()) {
          await dates.first().fill('2099-01-01');
          await dates.first().press('Tab');
          await page.waitForTimeout(3500);
          const after = (await f.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
          check('a From date in the future empties the list (the date filter works)', !fromNames.some((n) => after.includes(n)) || /\bno\b|0 transfers|nothing/i.test(after), after.slice(0, 200));
          await shot(page, 'transfer history filtered to 2099');
        }
      }
      check('no console errors / failed requests from the plugin', !log.console.length && !log.failed.length, [...log.console, ...log.failed].join(' | '));
      await page.context().close();
    },
  },
];

const createdDashboards = [];
const createdSqlViews = [];
let sqlViewsBefore = new Set();
let dashboardsBefore = new Set();
const STATE = path.join(OUT, 'session-state.json');

async function main() {
  if (!(process.env.LLM_BASE_URL && process.env.LLM_MODEL && process.env.LLM_API_KEY)) { console.error('Set LLM_BASE_URL, LLM_MODEL and LLM_API_KEY.'); process.exit(2); }
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true, executablePath: CHROME });
  const lc = await browser.newContext();
  await lc.request.post(`${BASE}/api/auth/login`, { data: { username: 'admin', password: 'district' } });
  await lc.storageState({ path: STATE });
  await lc.close();
  const snap = {};
  for (const k of ['enrollmentOverviewLayout', 'enrollmentEventNewLayout', 'enrollmentEventEditLayout', 'dataEntryForms']) snap[k] = await captureKey(k);
  const backupsBefore = new Set(((await api('dataStore')) || []).includes(BACKUP_NS) ? (await api(`dataStore/${BACKUP_NS}`)) : []);
  const installed = [];
  sqlViewsBefore = new Set(((await api('sqlViews?fields=id&paging=false')).sqlViews || []).map((v) => v.id));
  dashboardsBefore = new Set(((await api('dashboards?fields=id&paging=false')).dashboards || []).map((v) => v.id));
  for (const c of CASES.filter((x) => !ONLY.length || ONLY.includes(x.id))) {
    cur = { id: c.id, title: c.title, prompt: c.prompt, checks: [], shots: [], logs: [] };
    R.cases.push(cur);
    console.log(`\n── ${c.id}. ${c.title}`);
    try {
      const conv = await converse(c);
      cur.transcript = conv.transcript;
      cur.api = conv.api;
      check(`the chatbot's DHIS2 API calls all succeeded (${conv.api.total} calls)`, conv.api.failed.length === 0, conv.api.failed.join(' | '));
      if (!check('the chatbot built and installed an app', !!conv.created, conv.transcript.map((t) => t.answer.slice(0, 160)).join(' / '))) continue;
      installed.push(conv.created.key);
      cur.app = { key: conv.created.key, name: conv.created.displayName, plugin_type: conv.created.plugin_type || null };
      const src = await fetch(`${BASE}/api/apps/${conv.created.key}/src/manifest.ai.json`, { headers: { Authorization: AUTHH } });
      check('it carries the assistant marker + source manifest', src.ok && conv.created.developer && conv.created.developer.company === 'dhis2-ai-assistant');
      await c.verify(browser, conv.created, conv);
    } catch (e) {
      check(`case aborted: ${e.message}`, false, e.stack);
    }
  }
  // ── Cleanup: delete through the tool (takes placements off first) ─────────
  // Keep every generated source for review before anything is deleted.
  for (const key of installed) {
    const dir = path.join(OUT, 'sources', key);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['src/manifest.ai.json', 'src/app.jsx', 'src/plugin.jsx', 'src/shared.jsx']) {
      const r = await fetch(`${BASE}/api/apps/${key}/${f}`, { headers: { Authorization: AUTHH } });
      if (r.ok) fs.writeFileSync(path.join(dir, path.basename(f)), await r.text());
    }
  }
  if (!KEEP) {
    const { load } = require('./live-harness');
    const tctx = load({ appType: 'Dashboard' });
    await sleep(50);
    for (const key of installed) {
      const r = await tctx.executeTool('manage_custom_app', { action: 'delete', key, skip_backup: true, delete_app_data: true });
      R.cases.find((x) => x.app && x.app.key === key).cleanup = r.success ? `deleted (placements removed: ${(r.placements_removed || []).length})` : r._error;
    }
    for (const id of createdDashboards) await apiDelete(`dashboards/${id}`);
    // SQL views the chatbot created this run (and only those).
    const viewsNow = ((await api('sqlViews?fields=id&paging=false')).sqlViews || []).map((v) => v.id).filter((id) => !sqlViewsBefore.has(id));
    for (const id of new Set([...createdSqlViews, ...viewsNow])) await apiDelete(`sqlViews/${id}`);
    // Only the backups this run's apps caused (their reason names the app or
    // an ai-test- dashboard) — anything else written meanwhile is left alone.
    const keysNow = ((await api('dataStore')) || []).includes(BACKUP_NS) ? (await api(`dataStore/${BACKUP_NS}`)) : [];
    for (const k of keysNow.filter((x) => !backupsBefore.has(x))) {
      const e = await api(`dataStore/${BACKUP_NS}/${encodeURIComponent(k)}`);
      const why = String((e && e.reason) || '');
      const ofView = ((e && e.objects) || []).some((o) => o.object_type === 'sqlViews' && !sqlViewsBefore.has(o.object_id));
      if (installed.some((key) => why.includes(key) || k.includes(`-app-${key}-`)) || /ai-test LLM/i.test(why) || ofView) await apiDelete(`dataStore/${BACKUP_NS}/${encodeURIComponent(k)}`);
    }
    cur = { id: 'Z', title: 'Server left as found', checks: [], shots: [], logs: [] };
    R.cases.push(cur);
    for (const k of Object.keys(snap)) {
      const now = await captureKey(k);
      const diff = Object.keys({ ...(now || {}), ...(snap[k] || {}) }).filter((p) => canon((now || {})[p]) !== canon((snap[k] || {})[p]));
      check(`dataStore/capture/${k} is exactly as before`, canon(now) === canon(snap[k]), diff.length ? `entries that differ: ${diff.join(', ')} — now ${diff.map((p) => canon((now || {})[p]).slice(0, 300)).join(' | ')}` : '');
    }
    check('no app the model installed is left', !(await aiApps()).some((a) => installed.includes(a.key)));
    const viewsLeft = ((await api('sqlViews?fields=id&paging=false')).sqlViews || []).filter((v) => !sqlViewsBefore.has(v.id));
    check('no SQL view the model created is left', viewsLeft.length === 0, JSON.stringify(viewsLeft));
  }
  await browser.close();
  R.finished = new Date().toISOString();
  writeReport();
  const failed = R.cases.flatMap((c) => c.checks.filter((x) => !x.pass));
  console.log(`\n${failed.length ? '\x1b[31mFAILED\x1b[0m' : '\x1b[32mALL CHECKS PASSED\x1b[0m'} — ${R.cases.reduce((n, c) => n + c.checks.length, 0)} checks, ${failed.length} failed. Report: ${path.relative(process.cwd(), path.join(OUT, 'report.html'))}`);
  process.exit(failed.length ? 1 : 0);
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function writeReport() {
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(R, null, 2));
  const total = R.cases.reduce((n, c) => n + c.checks.length, 0);
  const failed = R.cases.reduce((n, c) => n + c.checks.filter((x) => !x.pass).length, 0);
  const sections = R.cases.map((c) => `<section><h2>${esc(c.id)}. ${esc(c.title)}</h2>
${c.prompt ? `<p class="prompt">“${esc(c.prompt)}”</p>` : ''}
${c.app ? `<p class="muted">Built: <b>${esc(c.app.name)}</b> (${esc(c.app.key)}${c.app.plugin_type ? `, ${esc(c.app.plugin_type)} plugin` : ''}) · API calls by the chatbot: ${c.api ? `${c.api.total}, failed ${c.api.failed.length}` : '–'}${c.cleanup ? ` · cleanup: ${esc(c.cleanup)}` : ''}</p>` : ''}
<table>${c.checks.map((x) => `<tr class="${x.pass ? 'ok' : 'bad'}"><td>${x.pass ? '✓' : '✗'}</td><td>${esc(x.name)}</td><td class="d">${esc(x.detail)}</td></tr>`).join('')}</table>
${(c.transcript || []).map((t) => `<details><summary>${esc(t.user)} <span class="muted">(${t.seconds}s · ${t.tools.length} tool calls)</span></summary><p class="muted">${esc(t.tools.join(', '))}</p><pre>${esc(t.answer)}</pre></details>`).join('')}
<div class="shots">${c.shots.map((s) => `<figure><a href="${esc(s.file)}"><img src="${esc(s.file)}" alt="${esc(s.label)}"></a><figcaption>${esc(s.label)}</figcaption></figure>`).join('')}</div></section>`).join('');
  fs.writeFileSync(path.join(OUT, 'report.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LLM-built apps acceptance</title>
<style>:root{--bg:#f4f6f8;--card:#fff;--ink:#212934;--muted:#4a5768;--ok:#1b5e20;--bad:#b71c1c;--badbg:#ffebee;--line:#d5dde5}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#11161c;--card:#1a2129;--ink:#e6edf3;--muted:#9aa7b5;--ok:#7ddc8a;--bad:#ff8a80;--badbg:#3a1414;--line:#2c3642}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 Roboto,"Segoe UI",Arial,sans-serif}main{max-width:1200px;margin:0 auto;padding:16px}
section{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:16px;margin:16px 0}table{border-collapse:collapse;width:100%}td{padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.ok td:first-child{color:var(--ok);font-weight:700}.bad{background:var(--badbg)}.bad td:first-child{color:var(--bad);font-weight:700}.d,.muted{color:var(--muted);font-size:12px;word-break:break-word}
.prompt{font-style:italic}pre{white-space:pre-wrap;font-size:12px}.shots{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}figure{margin:0;flex:1 1 320px;max-width:560px}img{width:100%;border:1px solid var(--line)}</style></head>
<body><main><h1>Apps & plugins built by the chatbot (${esc(R.model)})</h1><p>${failed ? `<b style="color:var(--bad)">${failed} of ${total} checks failed</b>` : `<b style="color:var(--ok)">All ${total} checks passed</b>`} · ${esc(R.started)} → ${esc(R.finished)}</p>${sections}</main></body></html>`);
}

process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); if (cur) check(`no unhandled promise rejection (${e && e.message})`, false, e && e.stack); });
main().catch((e) => { console.error(e); try { writeReport(); } catch { /* ignore */ } process.exit(1); });
