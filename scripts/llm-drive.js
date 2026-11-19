#!/usr/bin/env node
'use strict';
/* One real-model thread per process. Logs every tool call (full args + result)
 * to <outdir>/calls.jsonl and the transcript to <outdir>/events.jsonl.
 * usage: node scripts/llm-drive.js <outdir> <prompt-file> [<prompt-file> …]
 * env: as scripts/llm-harness.js (LLM_*, DHIS2_*), REPO=path to New Design */
const fs = require('fs');
const path = require('path');
const REPO = process.env.REPO || path.resolve(__dirname, '..');
const outDir = process.argv[2];
const prompts = process.argv.slice(3);
fs.mkdirSync(outDir, { recursive: true });
process.env.LLM_SESSION_FILE = path.join(outDir, 'session.json');
const { loadLLM, API, LLMLOG, events, summarize, closeBrowser } = require(path.join(REPO, 'scripts/llm-harness.js'));

const callsFile = path.join(outDir, 'calls.jsonl');
fs.writeFileSync(callsFile, '');
(async () => {
  const { ctx } = loadLLM(process.env.LLM_PAGE_CONTEXT ? JSON.parse(process.env.LLM_PAGE_CONTEXT) : { appType: 'Maintenance' });
  await new Promise(r => setTimeout(r, 50));
  const realExec = ctx.executeTool;
  let n = 0;
  ctx.executeTool = async (name, args) => {
    const k = ++n; const t0 = Date.now(); const apiMark = API.length;
    let res, threw = null;
    try { res = await realExec(name, args); } catch (e) { threw = e; }
    const rec = { n: k, tool: name, args, ms: Date.now() - t0, api: API.slice(apiMark).map(a => `${a.method} ${a.status} ${a.url.slice(0, 300)}`) };
    if (threw) rec.threw = String(threw && threw.stack || threw);
    else rec.result = res;
    fs.appendFileSync(callsFile, JSON.stringify(rec) + '\n');
    if (threw) throw threw;
    return res;
  };
  let anyFail = false;
  for (const file of prompts) {
    const prompt = fs.readFileSync(file, 'utf8').trim();
    const mark = API.length; const t0 = Date.now();
    console.log(`\n══════ TURN ${file} ══════`);
    let result;
    try { result = await ctx.runAgenticLoop(prompt, null, false, false); }
    catch (e) { console.log('TURN THREW', e.stack); anyFail = true; continue; }
    const { total, failed } = summarize(mark);
    console.log(`\n—— answer (${Math.round((Date.now() - t0) / 1000)}s) ——\n${String(result?.text || '')}`);
    console.log(`\nDHIS2 calls this turn: ${total}, failed: ${failed.length}`);
    for (const f of failed) console.log(`  FAILED ${f.method} ${f.url.slice(0, 250)} → ${f.status}`);
    if (failed.length) anyFail = true;
    fs.writeFileSync(path.join(outDir, `answer-${path.basename(file)}.md`), String(result?.text || ''));
  }
  const toolDone = events.filter(e => e.type === 'AI_TOOL_DONE');
  const outcomes = {};
  for (const e of toolDone) outcomes[e.outcome || (e.success ? 'ok' : 'failed')] = (outcomes[e.outcome || (e.success ? 'ok' : 'failed')] || 0) + 1;
  fs.writeFileSync(path.join(outDir, 'events.jsonl'), events.filter(e => /AI_TOOL|AI_RESPONSE|AI_DONE/.test(e.type)).map(e => JSON.stringify(e).slice(0, 4000)).join('\n'));
  const { total, failed } = summarize();
  console.log(`\n══════ OVERALL: ${total} DHIS2 calls, ${failed.length} failed, ${LLMLOG.length} provider calls, tool outcomes ${JSON.stringify(outcomes)} ══════`);
  console.log(anyFail ? 'RESULT: FAIL' : 'RESULT: PASS');
  await closeBrowser();
  process.exit(anyFail ? 1 : 0);
})();
