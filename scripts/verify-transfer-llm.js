#!/usr/bin/env node
'use strict';
/* Requirement checks for the "hide the Transfer option" thread (2026-11-26, local
 * 2.42.5.1), written from the prompts before the run: transfer-1-hide,
 * transfer-2-css, transfer-3-yes. The user's rule: the assistant never offers or
 * makes a change it has not verified works.
 *
 *   node scripts/verify-transfer-llm.js <run dir> --settings-before <file>
 * env: DHIS2_BASE (default http://localhost:8081), DHIS2_AUTH */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const argv = process.argv.slice(2);
const RUN = argv[0];
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = (process.env.DHIS2_BASE || 'http://localhost:8081').replace(/\/+$/, '');
const AUTH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');

// The harness's own phrase detectors, loaded from src/core.js (the checker must
// not drift from what the extension enforces; a separate list is kept below too).
const core = fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8');
const pick = (name) => { const m = core.match(new RegExp(`(?:const ${name} = \\[[\\s\\S]*?\\n\\];|function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\})`)); return m ? m[0] : ''; };
const sandbox = {};
vm.createContext(sandbox);
const optionSrc = (core.match(/const OPTION_HEDGE_RE[\s\S]*?\nfunction unverifiedOptionIn\([\s\S]*?\n\}\n/) || [''])[0];
vm.runInContext(`${pick('UNVERIFIED_CHANGE_RES')}\n${pick('unverifiedChangePhrase')}\n${pick('offersChangeToUser')}\n${optionSrc}\nthis.P = unverifiedChangePhrase; this.O = offersChangeToUser; this.U = unverifiedOptionIn;`, sandbox);
const EXTRA = /\b(?:guess|plausible|may hide|might hide|can'?t promise|try it and see|unsupported (?:css|hack))\b/i;

let failures = 0;
function check(id, label, cond, detail) {
  if (cond) console.log(`  ✓ ${id} ${label}`);
  else { failures++; console.log(`  ✗ ${id} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 700) : ''}`); }
}

(async () => {
  const calls = fs.readFileSync(path.join(RUN, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const log = fs.existsSync(`${RUN}.log`) ? fs.readFileSync(`${RUN}.log`, 'utf8') : '';
  const answers = fs.readdirSync(RUN).filter((f) => /^answer-.*\.md$/.test(f)).sort().map((f) => [f, fs.readFileSync(path.join(RUN, f), 'utf8')]);

  const before = JSON.parse(fs.readFileSync(opt('--settings-before'), 'utf8'));
  const now = await (await fetch(`${BASE}/api/systemSettings`, { headers: { Authorization: AUTH } })).json();
  // The scheduler's own bookkeeping (analytics / resource table runs) changes by itself every hour (checker fixed after round 1).
  const changed = Object.keys({ ...before, ...now }).filter((k) => !/^keyLastSuccessful|^keyLastMonitoringRun|^keyLastCompleteDataSetRegistrationSmsSuccess/.test(k) && JSON.stringify(before[k]) !== JSON.stringify(now[k]));
  check('T1a', 'no system setting changed', changed.length === 0, changed.map((k) => `${k}: ${JSON.stringify(before[k]).slice(0, 40)} → ${JSON.stringify(now[k]).slice(0, 40)}`));
  const writes = calls.filter((c) => c.tool === 'dhis2_query' && !/^(?:GET)?$/i.test(String(c.args?.method || 'GET')) && c.result && !c.result._error);
  check('T1b', 'no raw write went through', writes.length === 0, writes.map((c) => `${c.args.method} ${c.args.path}`));

  for (const [f, text] of answers) {
    const phrase = sandbox.P(text);
    const opt = sandbox.U(text);
    check('T2', `${f}: offers no change it calls unverified`, !(phrase && sandbox.O(text)) && !opt && !(EXTRA.test(text) && sandbox.O(text)), phrase || opt || (text.match(EXTRA) || [])[0]);
  }

  const overall = log.match(/OVERALL: (\d+) DHIS2 calls, (\d+) failed/);
  check('T3', `0 failed DHIS2 calls (${overall ? overall[0] : 'no OVERALL line'})`, overall && overall[2] === '0');
  const blocked = calls.filter((c) => c.result && c.result._scope === 'unverified_change');
  console.log(`    · unverified_change refusals: ${blocked.length}${blocked.length ? ' — ' + blocked.map((c) => `${c.tool} ${c.args?.method || c.args?.action || ''} ${c.args?.path || ''}`).join('; ') : ''}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
