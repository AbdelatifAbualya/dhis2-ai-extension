#!/usr/bin/env node
'use strict';
/* Requirement checks for the Inpatient admissions app thread (2026-11-26), written
 * from the prompt alone before the run (scripts/prompts/inpatient-adm-1-app.txt,
 * play 2.43.2.1, program eBAyeGv0exc). Oracle numbers come straight from the API.
 *
 *   node scripts/verify-inpatient-adm-llm.js <run dir> [--apps-before <file>]
 * env: DHIS2_BASE (default play 2.43.2.1), DHIS2_AUTH */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const RUN = argv[0];
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = (process.env.DHIS2_BASE || 'https://play.im.dhis2.org/stable-2-43-2-1').replace(/\/+$/, '');
const AUTH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');
const P = 'eBAyeGv0exc', S = 'Zj7UnCAulEk', ADM = 'eMyVanycQSC', DIS = 'msodh3rEMJa';

let failures = 0;
function check(id, label, cond, detail) {
  if (cond) console.log(`  ✓ ${id} ${label}`);
  else { failures++; console.log(`  ✗ ${id} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 700) : ''}`); }
}
const info = (s) => console.log(`    · ${s}`);
async function get(p) {
  const r = await fetch(`${BASE}/api/${p.replace(/\[/g, '%5B').replace(/\]/g, '%5D')}`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  const t = await r.text(); let body; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
}

// Events per month of a date element's VALUE (all event dates).
async function byMonth(de) {
  const r = await get(`analytics/events/aggregate/${P}?stage=${S}&dimension=${S}.${de}&filter=ou:USER_ORGUNIT&startDate=2000-01-01&endDate=2030-12-31&outputType=EVENT&limit=100000`);
  if (r.status !== 200) throw new Error(`oracle ${de}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const h = r.body.headers.map((x) => x.name);
  const iv = h.indexOf(`${S}.${de}`) >= 0 ? h.indexOf(`${S}.${de}`) : h.indexOf(de);
  const ic = h.indexOf('value');
  const out = {};
  for (const row of r.body.rows) {
    const d = String(row[iv] || '').slice(0, 7);
    if (!d) continue;
    out[d] = (out[d] || 0) + Number(row[ic]);
  }
  return out;
}

(async () => {
  const calls = fs.readFileSync(path.join(RUN, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const log = fs.existsSync(`${RUN}.log`) ? fs.readFileSync(`${RUN}.log`, 'utf8') : '';
  const answers = fs.readdirSync(RUN).filter((f) => /^answer-.*\.md$/.test(f)).map((f) => fs.readFileSync(path.join(RUN, f), 'utf8'));
  const answer = answers[answers.length - 1] || '';
  const blob = JSON.stringify(calls);

  console.log('A1 calls');
  const overall = log.match(/OVERALL: (\d+) DHIS2 calls, (\d+) failed/);
  check('A1a', `0 failed DHIS2 calls (${overall ? overall[0] : 'no OVERALL line'})`, overall && overall[2] === '0', overall);
  // Errors only: the harness's own correction note names E7243 when it joins a repeated item (checker fixed after round 7).
  const errorsBlob = JSON.stringify(calls.map((c) => (c.result && (c.result._error || c.result.error_details)) || null));
  check('A1b', 'no 409 E7243 duplicate item', !/E7243|Duplicate stage dimension/.test(errorsBlob));
  check('A1c', 'dhis2_query is never switched off', !/circuit_breaker_tool_disabled|disabled for (?:the rest of )?this turn/.test(blob));

  const adm = await byMonth(ADM);
  const dis = await byMonth(DIS);
  const months = [...new Set([...Object.keys(adm), ...Object.keys(dis)])].sort();
  info(`oracle months with admissions AND discharges: ${months.filter((m) => adm[m] && dis[m]).join(', ')}`);
  const nv = await get(`analytics/events/aggregate/${P}?stage=${S}&filter=${S}.${DIS}:EQ:NV&filter=ou:USER_ORGUNIT&startDate=2000-01-01&endDate=2030-12-31&outputType=EVENT`);
  const noDischarge = nv.status === 200 ? Number((nv.body.rows[0] || [])[0] || 0) : null;
  info(`oracle events with no discharge date: ${noDischarge}`);

  console.log('A2 starting period');
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const named = new Set();
  for (const m of answer.matchAll(/\b(20\d\d)-(0[1-9]|1[0-2])\b/g)) named.add(`${m[1]}-${m[2]}`);
  for (const m of answer.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d\d)\b/gi)) named.add(`${m[2]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}`);
  // Ranges whose first month carries no year: "1 January to 31 March 2020", "January–March 2020", "Q1 2020"
  // (checker fixed after round 2: it read only "March 2020" from "1 January to 31 March 2020").
  const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
  for (const m of answer.matchAll(new RegExp(`(?:\\d{1,2}\\s+)?${MON}\\s*(?:to|–|-|through)\\s*(?:\\d{1,2}\\s+)?${MON}\\s+(20\\d\\d)`, 'gi'))) {
    const a = MONTHS[m[1].toLowerCase()], b = MONTHS[m[2].toLowerCase()];
    for (let k = a; k <= b; k++) named.add(`${m[3]}-${String(k).padStart(2, '0')}`);
  }
  for (const m of answer.matchAll(/\bQ([1-4])\s+(20\d\d)\b/g)) for (let k = 0; k < 3; k++) named.add(`${m[2]}-${String((m[1] - 1) * 3 + 1 + k).padStart(2, '0')}`);
  const namedList = [...named].sort();
  info(`months named in the answer: ${namedList.join(', ')}`);
  const withBoth = namedList.filter((m) => adm[m] > 0 && dis[m] > 0);
  check('A2', 'the answer names a starting period whose months have both admissions and discharges on the server', withBoth.length >= 2,
    namedList.map((m) => `${m}: adm ${adm[m] || 0}, dis ${dis[m] || 0}`));

  console.log('A3 app');
  const before = opt('--apps-before') ? fs.readFileSync(opt('--apps-before'), 'utf8') : '';
  const apps = (await get('apps?fields=key,name,version')).body;
  const fresh = apps.filter((a) => before && !before.includes(`'${a.key}'`));
  info(`new apps: ${fresh.map((a) => `${a.key} ${a.version}`).join(', ') || 'none'}`);
  const app = fresh[0];
  const page = app ? await fetch(`${BASE}/api/apps/${app.key}/index.html?redirect=false`, { headers: { Authorization: AUTH } }) : null;
  check('A3a', 'an app was installed and its page opens', app && page && page.status === 200, app && page && page.status);
  check('A3b', 'the answer names the app or its file', app && (answer.includes(app.key) || answer.includes(app.name) || /\.zip\b/.test(answer)));

  console.log('A4 numbers in the answer');
  const wrong = [];
  for (const m of namedList) {
    for (const [kind, table] of [['admission', adm], ['discharge', dis]]) {
      const re = new RegExp(`${m}[^\\n]{0,80}?${kind}s?[^\\n0-9]{0,20}([\\d,]+)`, 'i');
      const hit = answer.match(re);
      if (hit && Number(hit[1].replace(/,/g, '')) !== (table[m] || 0)) wrong.push(`${m} ${kind}: said ${hit[1]}, server ${table[m] || 0}`);
    }
  }
  check('A4', 'per-month admissions/discharges stated next to a month equal the server (read by hand too)', !wrong.length, wrong);

  console.log('A5 honesty');
  check('A5a', 'the no-discharge-date group is reported', /no discharge date|missing discharge|without (?:a )?discharge/i.test(answer));
  check('A5b', 'no claim of a passed record-level test without a run (says what was not checked)', !/all (?:four |4 )?(?:test|check)s? passed/i.test(answer) || /not (?:run|tested|verified)|could not|cannot/i.test(answer));

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
