#!/usr/bin/env node
'use strict';
/* Reset the local test instance after a pregnancy-tracker run: deletes the
 * program (rules/PRVs/PIs first, mirroring the extension's cascade), then every
 * dataElement / optionSet / option / trackedEntityAttribute / trackedEntityType
 * / programIndicator / visualization / map / eventVisualization / dashboard /
 * legendSet created on or after the given date (default: today). Pre-existing
 * metadata is never touched. Direct REST — this is maintenance, not a tool test. */
const BASE = (process.env.DHIS2_BASE || 'http://localhost:8081').replace(/\/+$/, '') + '/api';
const AUTH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');
const SINCE = process.env.CLEANUP_SINCE || new Date().toISOString().slice(0, 10);

async function req(method, path, body) {
  const r = await fetch(`${BASE}/${path}`, {
    method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, ok: r.ok, body: j };
}

async function listCreatedSince(type, extraFilter = '') {
  const r = await req('GET', `${type}?filter=created:ge:${SINCE}${extraFilter}&fields=id,name,created&paging=false`);
  return r.body?.[type] || [];
}

async function deleteAll(type, items, label) {
  let okCount = 0, failed = [];
  for (const it of items) {
    const r = await req('DELETE', `${type}/${it.id}`);
    if (r.ok || r.status === 404) okCount++;
    else failed.push({ ...it, status: r.status, msg: JSON.stringify(r.body?.response?.errorReports?.[0]?.message || r.body?.message || '').slice(0, 120) });
  }
  console.log(`${label || type}: deleted ${okCount}/${items.length}${failed.length ? ` — FAILED: ${failed.map(f => `${f.name}(${f.status} ${f.msg})`).join('; ')}` : ''}`);
  return failed;
}

(async () => {
  console.log(`Cleanup: removing objects created >= ${SINCE}`);

  // 0. dashboards & analytical outputs first (they reference PIs/legends)
  for (const type of ['dashboards', 'eventVisualizations', 'visualizations', 'maps', 'eventReports', 'eventCharts']) {
    const items = await listCreatedSince(type).catch(() => []);
    if (items.length) await deleteAll(type, items);
  }
  // legend sets
  await deleteAll('legendSets', await listCreatedSince('legendSets'));

  // 1. programs created since date — cascade: PIs, rules(+actions), PRVs, then program
  const progs = await listCreatedSince('programs');
  for (const p of progs) {
    const pis = (await req('GET', `programIndicators?filter=program.id:eq:${p.id}&fields=id,name&paging=false`)).body?.programIndicators || [];
    await deleteAll('programIndicators', pis, `  PIs of ${p.name}`);
    const rules = (await req('GET', `programRules?filter=program.id:eq:${p.id}&fields=id,name&paging=false`)).body?.programRules || [];
    await deleteAll('programRules', rules, `  rules of ${p.name}`);
    const prvs = (await req('GET', `programRuleVariables?filter=program.id:eq:${p.id}&fields=id,name&paging=false`)).body?.programRuleVariables || [];
    await deleteAll('programRuleVariables', prvs, `  PRVs of ${p.name}`);
    const del = await req('DELETE', `programs/${p.id}`);
    console.log(`  program "${p.name}": ${del.status}`);
  }

  // 2. loose program indicators created since (orphans from failed runs)
  await deleteAll('programIndicators', await listCreatedSince('programIndicators'));

  // 3. data elements, then option sets, then options, then TEAs, then TETs
  let failedDes = await deleteAll('dataElements', await listCreatedSince('dataElements'));
  await deleteAll('trackedEntityAttributes', await listCreatedSince('trackedEntityAttributes'));
  await deleteAll('optionSets', await listCreatedSince('optionSets'));
  await deleteAll('options', await listCreatedSince('options'));
  await deleteAll('trackedEntityTypes', await listCreatedSince('trackedEntityTypes'));
  // retry DEs that were blocked by option-set refs the first time
  if (failedDes.length) await deleteAll('dataElements', failedDes);

  // 4. report what's left from today (should be nothing)
  for (const type of ['programs', 'dataElements', 'optionSets', 'trackedEntityAttributes', 'trackedEntityTypes', 'programRules', 'programIndicators', 'eventVisualizations', 'visualizations', 'maps', 'dashboards', 'legendSets']) {
    const left = await listCreatedSince(type).catch(() => []);
    if (left.length) console.log(`⚠ ${type} still present: ${left.map(x => x.name).join(', ')}`);
  }
  console.log('Cleanup done.');
})();
