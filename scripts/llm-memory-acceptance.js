#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * llm-memory-acceptance.js — end-to-end acceptance of the LEARNING MEMORY with a
 * REAL LLM driving the REAL agentic loop against a LIVE DHIS2 (see
 * llm-harness.js for LLM_* / DHIS2_* env).
 *
 * Thread 1 does real work that tends to hit DHIS2 errors (indicator +
 * dashboard, aggregate data entry incl. a not-yet-open period) and the user
 * explicitly teaches a rule. A NEW THREAD then asks for related work: the
 * lessons must be injected and the known failure must not be repeated. A final
 * turn on a patient-record page must write NOTHING to memory.
 * Everything created (prefix "ZZ LLM") and every backup written is removed.
 * ───────────────────────────────────────────────────────────────────────────── */
const { loadLLM, API, LLMLOG, events, summarize } = require('./llm-harness');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOffset = (k) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return { id: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`, name: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }; };

(async () => {
  const { ctx } = loadLLM({ appType: 'Maintenance' });
  await new Promise((r) => setTimeout(r, 50));
  const D = ctx.__getDhis2();
  const M = ctx.__memoryState();
  const t = (n, a) => ctx.executeTool(n, a);
  const raw = (p, m = 'GET', b) => ctx.safeDhis2Fetch(p, { method: m, ...(b ? { body: b } : {}) });
  const BACKUP_NS = 'dhis2-ai-extension-backups';
  const backupsBefore = new Set(await raw(`dataStore/${BACKUP_NS}`).then((k) => (Array.isArray(k) ? k : [])));
  await ctx.ensureMemoryLoaded();
  M.entries = [];
  M.enabled = true;

  // Log which lessons each turn's system prompt carried.
  const origBlock = ctx.buildMemoryPromptBlock;
  let lastBlock = '';
  ctx.buildMemoryPromptBlock = (...a) => { lastBlock = origBlock(...a); return lastBlock; };

  // ── Fixture: a disaggregated monthly malaria form ───────────────────────
  D.writeAuth = { scope: 'broad', reason: 'fixture' };
  const ous = await raw('organisationUnits?filter=children:empty&fields=id,displayName&pageSize=1&order=displayName:asc');
  const OU = ous.organisationUnits[0];
  const fx = {};
  let r = await t('create_metadata', { action: 'create_category_combo', category_combo: { name: 'ZZ LLM Sex', categories: [{ name: 'ZZ LLM Sex cat', options: ['ZZ LLM Male', 'ZZ LLM Female'] }] } });
  fx.cc = r.summary.categoryCombo.id; fx.cats = r.summary.new_categories.map((c) => c.id); fx.opts = r.summary.new_options.map((o) => o.id);
  r = await t('create_metadata', { action: 'create_data_elements', domain_type: 'AGGREGATE', category_combo_id: fx.cc, data_elements: [
    { name: 'ZZ LLM Malaria cases', value_type: 'INTEGER_ZERO_OR_POSITIVE', use_category_combo: true },
    { name: 'ZZ LLM Malaria tests', value_type: 'INTEGER_ZERO_OR_POSITIVE', use_default_combo: true },
    { name: 'ZZ LLM Stock-out days', value_type: 'INTEGER_ZERO_OR_POSITIVE', use_default_combo: true },
    { name: 'ZZ LLM Stock status', value_type: 'TEXT', use_default_combo: true, option_set: { name: 'ZZ LLM Stock', options: ['Adequate', 'Low', 'Stock out'] } },
  ] });
  fx.des = r.summary.dataElements.map((d) => d.id); fx.os = (r.summary.optionSets || []).map((o) => o.id);
  r = await t('manage_datasets', { action: 'create', dataset_name: 'ZZ LLM Malaria Monthly', period_type: 'Monthly', data_element_ids: fx.des, org_unit_ids: [OU.id] });
  fx.ds = r.dataset_id;
  console.log(`fixture: dataset ${fx.ds} at "${OU.displayName}", ${fx.des.length} DEs — ${API.length} setup calls, ${summarize().failed.length} failed`);
  const setupEnd = API.length;

  const prev = monthOffset(1), cur = monthOffset(0);
  const turns = [
    { label: 'T1 indicator + dashboard', text: `Create an aggregate indicator named "ZZ LLM Malaria test positivity" that shows the percentage of malaria tests that were positive: numerator is the data element "ZZ LLM Malaria cases" and denominator is "ZZ LLM Malaria tests". Then create a dashboard called "ZZ LLM Malaria" with a column chart of that indicator for the last 12 months for the org unit "${OU.displayName}".` },
    { label: 'T2 data entry (prev + CURRENT month)', text: `In the dataset "ZZ LLM Malaria Monthly" enter the data for "${OU.displayName}" for ${prev.name}: malaria cases male 4, female 6; malaria tests 15; stock status Low. Also enter malaria tests 9 for ${cur.name} at the same org unit.` },
    { label: 'T3 user teaches a rule', text: 'Please remember this for the future: on this server the ZZ LLM aggregate data may only be entered for months that have already ended, never the current month, and every ZZ LLM chart must use the period LAST_12_MONTHS.' },
    { label: 'T4 NEW THREAD: current-month entry again', newThread: true, text: `Enter malaria tests 11 for ${cur.name} at "${OU.displayName}" in the dataset "ZZ LLM Malaria Monthly".` },
    { label: 'T5 related build (indicator + add to dashboard)', text: 'Create a percentage indicator "ZZ LLM Stock-out share" equal to the data element "ZZ LLM Stock-out days" divided by 30, and add a column chart of it to the existing dashboard "ZZ LLM Malaria".' },
    { label: 'T6 PRIVACY: patient-record page', newThread: true, page: { appType: 'Capture', programId: 'fofUFvr9eUY', teiId: 'Zz9LLMtei01', orgUnitId: OU.id }, text: 'What can you tell me about this person and their enrollment? If something is wrong, remember how to fix it next time.' },
  ];

  const report = [];
  for (const turn of turns) {
    if (turn.newThread) await ctx.clearConversationState();
    if (turn.page) D.pageContext = turn.page; else D.pageContext = { appType: 'Maintenance' };
    const memBefore = M.entries.length;
    const usedBefore = Object.fromEntries(M.entries.map((e) => [e.id, e.used_count || 0]));
    const apiMark = API.length, evMark = events.length;
    console.log(`\n══════ ${turn.label} ══════\n> ${turn.text}`);
    const t0 = Date.now();
    let res;
    try { res = await ctx.runAgenticLoop(turn.text, null, false, false); } catch (e) { res = { text: `THREW ${e.message}` }; }
    const ev = events.slice(evMark);
    const calls = ev.filter((e) => e.type === 'AI_TOOL_CALL').map((e) => e.tool);
    const toolFails = ev.filter((e) => e.type === 'AI_TOOL_DONE' && !e.success && !/manual/i.test(e.summary || '')).map((e) => `${e.tool}: ${String(e.summary).slice(0, 140)}`);
    const { total, failed } = summarize(apiMark);
    const injected = (lastBlock.match(/\(#mem-[a-z0-9]+\)/g) || []).length;
    const used = M.entries.filter((e) => (e.used_count || 0) > (usedBefore[e.id] || 0)).map((e) => e.title);
    const rec = { turn: turn.label, secs: Math.round((Date.now() - t0) / 1000), dhis2_calls: total, failed_calls: failed.map((f) => `${f.method} ${f.url.slice(0, 120)} → ${f.status}`), tool_failures: toolFails, tools: calls, memory_before: memBefore, memory_after: M.entries.length, lessons_in_prompt: injected, lessons_used: used, memory_record_calls: calls.filter((c) => c === 'manage_memory').length };
    report.push(rec);
    console.log(`—— answer (${rec.secs}s) ——\n${String(res?.text || '').slice(0, 1500)}`);
    console.log(`RESULT ${JSON.stringify(rec, null, 1)}`);
  }

  // ── Memory content audit ────────────────────────────────────────────────
  console.log('\n══════ STORED MEMORY ══════');
  for (const e of M.entries) console.log(JSON.stringify({ id: e.id, area: e.area, source: e.source, scope: e.scope, tools: e.tools, endpoint: e.endpoint, title: e.title, problem: e.problem, solution: e.solution, seen: e.seen_count, used: e.used_count }));
  const blob = JSON.stringify(M.entries);
  const uidLike = (blob.match(/\b[A-Za-z][A-Za-z0-9]{10}\b/g) || []).filter((x) => ctx.looksLikeUidForMemory(x));
  console.log(`\nprivacy audit: ${uidLike.length} UID-like token(s) in memory ${uidLike.length ? JSON.stringify(uidLike) : ''}; personal-data pattern: ${ctx.looksLikePersonalData(blob)}; T6 wrote ${report[5].memory_after - report[5].memory_before} lesson(s)`);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  D.writeAuth = { scope: 'broad', reason: 'cleanup' };
  const cleanStart = API.length;
  const byName = async (type) => ((await raw(`${type}?filter=name:like:ZZ LLM&fields=id&paging=false`))[type] || []).map((o) => o.id);
  for (const type of ['dashboards', 'visualizations', 'maps', 'eventVisualizations', 'indicators', 'legendSets', 'validationRules']) {
    for (const id of await byName(type)) { const x = await raw(`${type}/${id}`, 'DELETE'); if (x?._error) console.log(`cleanup ${type}/${id}: ${x._error}`); }
  }
  await t('manage_datasets', { action: 'delete', dataset_id: fx.ds });
  for (const d of fx.des) { await raw(`maintenance/dataPruning/dataElements/${d}`, 'POST'); await raw(`dataElements/${d}`, 'DELETE'); }
  for (const o of fx.os) await raw(`optionSets/${o}`, 'DELETE');
  await raw(`categoryCombos/${fx.cc}`, 'DELETE');
  for (const c of fx.cats) await raw(`categories/${c}`, 'DELETE');
  for (const o of fx.opts) await raw(`categoryOptions/${o}`, 'DELETE');
  const after = await raw(`dataStore/${BACKUP_NS}`);
  for (const k of (Array.isArray(after) ? after : [])) if (!backupsBefore.has(k)) await raw(`dataStore/${BACKUP_NS}/${k}`, 'DELETE');
  const left = [];
  for (const type of ['dashboards', 'visualizations', 'indicators', 'dataSets', 'dataElements', 'optionSets', 'categoryCombos', 'categoryOptions']) {
    const ids = await byName(type); if (ids.length) left.push(`${type}:${ids.length}`);
  }
  console.log(`\ncleanup: leftovers ${left.length ? left.join(', ') : 'none'}; cleanup failed calls (post-commit 500 + probes expected): ${summarize(cleanStart).failed.map((f) => f.status).join(',') || 'none'}`);
  console.log(`\n══════ SUMMARY ══════`);
  for (const r2 of report) console.log(`${r2.turn.padEnd(48)} calls ${String(r2.dhis2_calls).padStart(3)}  failed ${r2.failed_calls.length}  tool✗ ${r2.tool_failures.length}  lessons-in-prompt ${r2.lessons_in_prompt}  memory ${r2.memory_before}→${r2.memory_after}  records ${r2.memory_record_calls}`);
  console.log(`setup failed: ${summarize(0, setupEnd).failed.length}; provider calls: ${LLMLOG.length} (HTTP errors: ${LLMLOG.filter((l) => l.status >= 400).length})`);
  process.exit(0);
})().catch((e) => { console.error('ACCEPTANCE THREW', e); process.exit(1); });
