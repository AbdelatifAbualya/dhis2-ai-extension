#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-app-install-check.js — manage_custom_app's install check, through the
 * real tools and real Chrome, on a live DHIS2 with tracker data:
 *   - it opens the app with no record fetched (checked on the wire),
 *   - it catches a failing request with DHIS2's own message, a crash, an app that
 *     renders nothing, a failing D2_SELF_TEST,
 *   - an app written with the wrong tracker parameter names still works, in the
 *     check and when a person opens it,
 *   - the assistant can repair its own app when the user reports an error.
 *
 *   DHIS2_BASE=https://play.im.dhis2.org/stable-2-42-7-1 DHIS2_APIVER=42 \
 *   LLM_BROWSER=1 npm run appcheck
 *
 * Needs a tracker program with registrations: SCENARIO_PROGRAM (default WSGAb5XwJ3Y,
 * WHO RMNCH Tracker on the playground). Creates ai-test-check-* apps only and
 * removes exactly those. Prints statuses and counts, never record values.
 * ───────────────────────────────────────────────────────────────────────────── */
process.env.LLM_BROWSER = '1';
process.env.LLM_SESSION_FILE = process.env.LLM_SESSION_FILE || require('path').join(require('os').tmpdir(), `app-check-${process.pid}.json`);
const vm = require('vm');
const { loadLLM, BASE, browserPage, closeBrowser } = require('./llm-harness');

const PROGRAM = process.env.SCENARIO_PROGRAM || 'WSGAb5XwJ3Y';
let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${!pass && detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  if (!pass) failures++;
};
const AUTH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');
const api = async (p, opts = {}) => {
  const r = await fetch(`${BASE}/api/${p}`, { ...opts, headers: { Authorization: AUTH, Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: null }; }
};

const shell = (body) => `
const { useState, useEffect } = React;
function App() {
  const [st, setSt] = useState('loading');
  ${body}
  return <div data-test="state">{st}</div>;
}
ReactDOMClient.createRoot(document.getElementById('root')).render(<App />);
`;
const load = (path, read) => `useEffect(() => { fetch(\`\${D2_APP_CONFIG.baseUrl}/api/${path}\`).then((r) => r.json().then((j) => [r.status, j])).then(([status, j]) => setSt(${read})); }, []);`;

(async () => {
  const { ctx } = loadLLM({ appType: 'Maintenance' });
  await new Promise((r) => setTimeout(r, 50));
  const d = vm.runInContext('dhis2', ctx);
  const tool = (args) => ctx.executeTool('manage_custom_app', args);
  const say = (text) => { vm.runInContext(`lastUserText = ${JSON.stringify(text)}`, ctx); d.writeAuth = ctx.classifyWriteAuthorization(text); };
  const made = [];
  const install = async (key, name, source, extra = {}) => {
    say(`create and install the app ${name}`);
    const r = await tool({ action: 'create', key, name, description: 'Install check test', files: { 'app.jsx': source }, ...extra });
    if (r.success) made.push(key);
    return r;
  };
  const page = await browserPage();
  const seen = [];
  page.on('request', (q) => { const u = q.url(); if (/\/api\/(?:\d+\/)?tracker\//.test(u)) seen.push(u.replace(BASE, '')); });

  try {
    // ── wrong names: the very requests of the failed thread ──
    console.log('\nAn app using the wrong tracker parameter names (the failed thread):');
    const wrong = await install('ai-test-check-wrong', 'ai-test check wrong names', shell(`
      useEffect(() => {
        Promise.all([
          fetch(\`\${D2_APP_CONFIG.baseUrl}/api/tracker/enrollments?program=${PROGRAM}&orgUnit=ImspTQPwCqd&orgUnitMode=DESCENDANTS&programStartDate=2026-01-01&pageSize=50&totalPages=true&fields=enrollment\`).then((r) => r.json().then((j) => [r.status, j])),
          fetch(\`\${D2_APP_CONFIG.baseUrl}/api/tracker/events?program=${PROGRAM}&orgUnits=ImspTQPwCqd&orgUnitMode=DESCENDANTS&pageSize=5&fields=event\`).then((r) => r.json().then((j) => [r.status, j])),
          fetch(\`\${D2_APP_CONFIG.baseUrl}/api/tracker/trackedEntities?program=${PROGRAM}&orgUnit=USER_ORGUNIT&orgUnitMode=DESCENDANTS&pageSize=5&fields=trackedEntity\`).then((r) => r.json().then((j) => [r.status, j])),
        ]).then((all) => setSt(all.map(([s]) => s).join(',')));
      }, []);`));
    check('it installs', wrong.success === true, wrong._error);
    const rc = wrong.runtime_check || {};
    check('the check ran and opened the app', rc.ran === true && rc.opened === true, JSON.stringify(rc).slice(0, 300));
    check('…the corrected requests pass, verdict clean', rc.verdict === 'clean' && rc.failed_requests.length === 0, JSON.stringify(rc.failed_requests));
    check('…no record could be fetched: every tracker request on the wire carried the empty window', seen.length >= 3 && seen.every((u) => /updatedAfter=2099-01-01/.test(u)), seen.join(' | '));
    check('…and the wrong names were corrected on the wire', seen.some((u) => /tracker\/enrollments\?.*orgUnits=/.test(u) && !/[?&]orgUnit=/.test(u) && /enrolledAfter=2026/.test(u)) && seen.some((u) => /tracker\/events\?.*[?&]orgUnit=/.test(u)), seen.join(' | '));

    // a person opening it: real data, real answer (statuses only are shown)
    seen.length = 0;
    const open = await page.context().newPage();
    const opened = [];
    open.on('request', (q) => { const u = q.url(); if (/\/api\/(?:\d+\/)?tracker\//.test(u)) opened.push(u); });
    await open.goto(`${BASE}/api/apps/ai-test-check-wrong/index.html?redirect=false`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await open.waitForTimeout(5000);
    const shown = await open.locator('[data-test="state"]').innerText({ timeout: 5000 }).catch(() => '');
    check('opened normally, the same app gets 200 on all three', shown === '200,200,200', shown);
    check('…without the check\'s empty window', opened.length >= 3 && opened.every((u) => !/updatedAfter=2099/.test(u)), opened.join(' | ').slice(0, 300));
    await open.close();

    // ── one registration's events: the privacy-critical name ──
    console.log('\nenrollment= (singular) on tracker/events:');
    const list = await api(`tracker/enrollments?program=${PROGRAM}&pageSize=20&fields=enrollment`);
    const rows = list.json?.enrollments || [];
    let target = null;
    for (const r of rows) {
      const ev = await api(`tracker/events?program=${PROGRAM}&enrollments=${r.enrollment}&fields=event&paging=false`);
      if ((ev.json?.events || []).length) { target = { id: r.enrollment, n: ev.json.events.length }; break; }
    }
    check('a registration with events exists to test with', !!target);
    if (target) {
      const raw = await api(`tracker/events?program=${PROGRAM}&enrollment=${target.id}&fields=event,enrollment&pageSize=200`);
      const leak = (raw.json?.events || []).filter((e) => e.enrollment !== target.id).length;
      check('as sent, the server ignores it and answers other registrations (the reason for the correction)', leak > 0, `other rows ${leak}`);
      const healed = await api(ctx.normalizeTrackerQuery(`tracker/events?program=${PROGRAM}&enrollment=${target.id}&fields=event,enrollment&pageSize=200`, Number(d.apiVersion)));
      const healedRows = healed.json?.events || [];
      check('corrected, it answers only that registration, all of it', healedRows.length === target.n && healedRows.every((e) => e.enrollment === target.id), `${healedRows.length} of ${target.n}`);
    }

    // ── what the check must catch ──
    console.log('\nWhat the check catches:');
    const bad = await install('ai-test-check-bad', 'ai-test check bad request', shell(load(`tracker/enrollments?program=xxxxxxxxxxx&orgUnits=ImspTQPwCqd&orgUnitMode=DESCENDANTS&fields=enrollment`, 'String(status)')));
    const brc = bad.runtime_check || {};
    check('a request DHIS2 refuses: verdict problems, with DHIS2\'s own message', brc.verdict === 'problems' && brc.failed_requests.length >= 1 && !!brc.failed_requests[0].dhis2_message, JSON.stringify(brc).slice(0, 400));
    check('…and the result says to fix it now', /Fix it now/.test(bad._must_fix || ''), bad._must_fix);

    const crash = await install('ai-test-check-crash', 'ai-test check crash', `
const { useState } = React;
function App() { const rows = useState(null)[0]; return <div>{rows.length}</div>; }
ReactDOMClient.createRoot(document.getElementById('root')).render(<App />);
`);
    const crc = crash.runtime_check || {};
    check('a crash while rendering: problems, with the error', crc.verdict === 'problems' && (crc.page_errors || []).length > 0, JSON.stringify(crc).slice(0, 300));

    const selfT = await install('ai-test-check-self', 'ai-test check self test', `${shell("useEffect(() => { setSt('ready'); }, []);")}
window.D2_SELF_TEST = () => [
  { name: 'two plus two', pass: 2 + 2 === 4 },
  { name: 'missing stays missing', pass: Number(null) === null, detail: 'got 0' },
];
`);
    const src = selfT.runtime_check || {};
    check('D2_SELF_TEST runs and is reported: 1 of 2 passed, the failure named', src.self_test?.total === 2 && src.self_test?.passed === 1 && /missing/.test(src.self_test?.failed?.[0]?.name || '') && src.verdict === 'problems', selfT._error || JSON.stringify(src));

    const one = await install('ai-test-check-one', 'ai-test check one record', shell(load(`tracker/enrollments/abcdefghijk?fields=enrollment`, 'String(status)')));
    const orc = one.runtime_check || {};
    check('a single-record read is not sent during the check', (orc.not_opened || []).length === 1, JSON.stringify(orc).slice(0, 300));

    // ── a plugin ──
    console.log('\nA dashboard plugin:');
    say('create and install the plugin');
    const plug = await tool({ action: 'create', key: 'ai-test-check-plugin', name: 'ai-test check plugin', kind: 'plugin', plugin_type: 'DASHBOARD', description: 'Install check test', files: { 'plugin.jsx': `
const { useState, useEffect } = React;
function Plugin() {
  const [st, setSt] = useState('loading');
  useEffect(() => { fetch(\`\${D2_APP_CONFIG.baseUrl}/api/tracker/enrollments?program=${PROGRAM}&pageSize=1&fields=enrollment\`).then((r) => setSt(String(r.status))); }, []);
  return <div>{st}</div>;
}
const root = ReactDOMClient.createRoot(document.getElementById('root'));
const render = (props) => root.render(<Plugin {...props} />);
if (window.parent === window) render({});
else postRobot.send(window.parent, 'getPropsFromParent').then(({ data }) => render(data)).catch(() => render({}));
postRobot.on('updated', ({ data }) => { render(data); });
` } });
    if (plug.success) made.push('ai-test-check-plugin');
    const prc = plug.runtime_check || {};
    check('a plugin is opened on its own, with no record fetched, and comes back clean', plug.success === true && prc.ran === true && prc.opened === true && prc.verdict === 'clean', plug._error || JSON.stringify(prc).slice(0, 300));

    // ── small edits ──
    console.log('\nSmall edits on update:');
    say('update the app ai-test-check-self');
    const ed = await tool({ action: 'update', key: 'ai-test-check-self', edits: [{ file: 'app.jsx', find: "setSt('ready')", replace: "setSt('edited')" }] });
    check('a one-line edit installs, and the check shows it', ed.success === true && /edited/.test(ed.runtime_check?.page_text || ''), ed._error || JSON.stringify(ed.runtime_check).slice(0, 200));
    const before = ed.version;
    const edMiss = await tool({ action: 'update', key: 'ai-test-check-self', edits: [{ file: 'app.jsx', find: 'text that is not there', replace: 'x' }] });
    const stillThere = (await api('apps')).json.find((a) => a.key === 'ai-test-check-self');
    check('an edit whose text is not found changes nothing', /occurs 0 times/.test(edMiss._error || '') && stillThere.version === before, edMiss._error);

    // ── repair ──
    console.log('\nRepairing its own app:');
    say('getting this error');
    check('"getting this error" alone is read-only', d.writeAuth.scope === 'read_only');
    const fix = await tool({ action: 'update', key: 'ai-test-check-bad', files: { 'app.jsx': shell(load(`tracker/enrollments?program=${PROGRAM}&orgUnits=ImspTQPwCqd&orgUnitMode=DESCENDANTS&pageSize=5&fields=enrollment`, 'String(status)')) } });
    check('its own app can be repaired on that report, and the repair is proved', fix.success === true && fix.runtime_check?.verdict === 'clean', fix._error || JSON.stringify(fix.runtime_check).slice(0, 200));
    say('why is this failing? do not change anything');
    const noChange = await tool({ action: 'update', key: 'ai-test-check-bad', files: { 'app.jsx': shell("useEffect(() => { setSt('x'); }, []);") } });
    check('…not when the user said to change nothing', !!noChange._error && /does not authorize/.test(noChange._error), noChange._error || 'updated');
  } finally {
    for (const key of made) {
      say('delete it');
      const del = await tool({ action: 'delete', key, confirm: true }).catch((e) => ({ _error: e.message }));
      if (del._error) console.log(`  left behind: ${key}: ${del._error}`);
    }
    await closeBrowser();
  }
  console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mALL CHECKS PASSED\x1b[0m');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e); await closeBrowser(); process.exit(1); });
