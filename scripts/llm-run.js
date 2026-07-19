#!/usr/bin/env node
'use strict';
/* Run one or more user prompts through the REAL agentic loop with the
 * env-configured LLM (see llm-harness.js). Usage:
 *   node scripts/llm-run.js <prompt-file> [<prompt-file> …]
 * Each file is one user turn; the conversation persists across turns.
 * PASS = every turn returns a non-error answer AND zero failed DHIS2 calls. */
const fs = require('fs');
const { loadLLM, API, LLMLOG, summarize } = require('./llm-harness');

const promptFiles = process.argv.slice(2);
if (!promptFiles.length) { console.error('usage: llm-run.js <prompt-file> …'); process.exit(2); }

(async () => {
  const { ctx } = loadLLM({ appType: 'Maintenance' });
  // Give core.js's async startup credential load a tick to resolve.
  await new Promise(r => setTimeout(r, 50));

  let anyFail = false;
  for (const file of promptFiles) {
    const prompt = fs.readFileSync(file, 'utf8').replace(/^prompt \d+:\s*/i, '').trim();
    const mark = API.length;
    console.log(`\n${'═'.repeat
      ? '' : ''}══════ TURN: ${file} (${prompt.length} chars) ══════`);
    const t0 = Date.now();
    let result;
    try {
      result = await ctx.runAgenticLoop(prompt, null, false, false);
    } catch (e) {
      console.log(`\nTURN THREW: ${e.message}`);
      anyFail = true;
      const { total, failed } = summarize(mark);
      console.log(`DHIS2 calls this turn: ${total}, failed: ${failed.length}`);
      continue;
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    const { total, failed } = summarize(mark);
    console.log(`\n—— answer (${secs}s) ——\n${String(result?.text || '').slice(0, 3000)}`);
    console.log(`\nDHIS2 calls this turn: ${total}, failed: ${failed.length}`);
    for (const f of failed) console.log(`  FAILED ${f.method} ${f.url} → ${f.status}`);
    const llmErrors = LLMLOG.filter(l => l.status >= 400);
    if (llmErrors.length) console.log(`provider HTTP errors: ${llmErrors.map(l => l.status).join(',')}`);
    if (failed.length || !String(result?.text || '').trim()) anyFail = true;
  }

  const { total, failed } = summarize();
  console.log(`\n══════ OVERALL: ${total} DHIS2 calls, ${failed.length} failed, ${LLMLOG.length} provider calls ══════`);
  console.log(anyFail ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(anyFail ? 1 : 0);
})();
