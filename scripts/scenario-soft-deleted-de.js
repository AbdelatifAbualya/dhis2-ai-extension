#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-soft-deleted-de.js — regression scenario for the live 2026-07-28
 * "delete the duplicate data element" disaster.
 *
 * Reproduces the exact user flow: a data element that received event data,
 * whose events were then deleted in the Capture UI (= SOFT-deleted), still
 * blocks deletion with E4030. The chatbot previously flailed through
 * analytics/tracker/maintenance guesses. The fixed behaviour under test:
 *
 *   1. manage_metadata(delete) on the blocked DE returns the E4030 error WITH
 *      the new _hint naming maintenance?softDeletedEventRemoval=true.
 *   2. dhis2_query POST maintenance?softDeletedEventRemoval=true returns
 *      success:true (empty 2xx body = success, not the old "empty response"
 *      pseudo-error).
 *   3. Retrying the SAME delete now succeeds.
 *
 * Setup/teardown (scratch event program + event) go through the raw authed
 * fetch, NOT executeTool, so the counted tool window contains only the
 * behaviour under test. The intentional E4030 409 is snapshot-excluded the
 * same way post-delete 404 probes are.
 * ───────────────────────────────────────────────────────────────────────────── */
const { load, API, summarize, BASE, APIVER } = require('./live-harness');

const AUTH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');
const api = (p) => `${BASE}/api/${APIVER}/${p}`;

async function raw(method, pathRel, body) {
  const resp = await fetch(api(pathRel), {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: resp.status, ok: resp.ok, json, text };
}

function fail(msg) { console.error(`\x1b[31m✗ ${msg}\x1b[0m`); process.exitCode = 1; }
function pass(msg) { console.log(`\x1b[32m✓ ${msg}\x1b[0m`); }

(async () => {
  const ctx = load();

  // ── UIDs pre-generated so the bundle can self-reference ──────────────────
  const uid = () => ctx.generateDhis2Uid();
  const deId = uid(), progId = uid(), stageId = uid(), psdeId = uid();
  const suffix = Date.now().toString(36);

  // Root OU for the scratch program
  const rootRes = await raw('GET', 'organisationUnits.json?filter=level:eq:1&fields=id&pageSize=1');
  const ouId = rootRes.json?.organisationUnits?.[0]?.id;
  if (!ouId) { fail('no root OU found'); return; }

  // Default category combo (event programs need it on the stage-less shape)
  const ccRes = await raw('GET', 'categoryCombos.json?filter=name:eq:default&fields=id&pageSize=1');
  const ccId = ccRes.json?.categoryCombos?.[0]?.id;

  // ── Setup: DE + minimal EVENT program using it, then one event ───────────
  const meta = {
    dataElements: [{
      id: deId, name: `ZZ SoftDel Verify DE ${suffix}`, shortName: `ZZ SoftDel ${suffix}`.slice(0, 50),
      valueType: 'BOOLEAN', domainType: 'TRACKER', aggregationType: 'NONE',
    }],
    programs: [{
      id: progId, name: `ZZ SoftDel Verify Prog ${suffix}`, shortName: `ZZ SoftDelP ${suffix}`.slice(0, 50),
      programType: 'WITHOUT_REGISTRATION',
      categoryCombo: ccId ? { id: ccId } : undefined,
      organisationUnits: [{ id: ouId }],
      programStages: [{ id: stageId }],
    }],
    programStages: [{
      id: stageId, name: `ZZ SoftDel Stage ${suffix}`, program: { id: progId },
      programStageDataElements: [{ id: psdeId, programStage: { id: stageId }, dataElement: { id: deId } }],
    }],
  };
  const imp = await raw('POST', 'metadata?importMode=COMMIT&atomicMode=ALL', meta);
  if (imp.status !== 200 || imp.json?.status === 'ERROR') { fail(`setup metadata import: HTTP ${imp.status} ${JSON.stringify(imp.json?.response?.typeReports || imp.json).slice(0, 400)}`); return; }
  pass('setup: scratch DE + event program imported');

  const evId = uid();
  const evImp = await raw('POST', 'tracker?async=false&importStrategy=CREATE', {
    events: [{
      event: evId, program: progId, programStage: stageId, orgUnit: ouId,
      occurredAt: '2026-07-27', status: 'COMPLETED',
      dataValues: [{ dataElement: deId, value: 'true' }],
    }],
  });
  if (evImp.status !== 200 || evImp.json?.status === 'ERROR') { fail(`event create: HTTP ${evImp.status} ${JSON.stringify(evImp.json?.validationReport || evImp.json).slice(0, 400)}`); return; }
  pass('setup: event with a data value recorded against the DE');

  // Soft-delete the event — exactly what "I deleted the event in Capture" does.
  const evDel = await raw('POST', 'tracker?async=false&importStrategy=DELETE', { events: [{ event: evId }] });
  if (evDel.status !== 200 || evDel.json?.status === 'ERROR') { fail(`event soft-delete: HTTP ${evDel.status}`); return; }
  pass('setup: event soft-deleted (Capture-style)');

  // ── Behaviour under test (counted window starts here) ────────────────────
  // (writeAuth is already 'broad' via the harness bootstrap)

  // 0. Remove the DE from the stage (step 1 of the documented workflow — the
  //    user's real flow had already done this via the chatbot).
  const beforeCounted = API.length;
  const removed = await ctx.executeTool('manage_metadata', { action: 'remove_from_stage', stage_id: stageId, data_element_ids: [deId] });
  if (removed._error) { fail(`remove_from_stage failed: ${JSON.stringify(removed).slice(0, 300)}`); return; }
  pass('DE removed from the stage');

  // 1. Delete attempt must fail E4030 AND carry the actionable hint.
  const beforeBlocked = API.length;
  const blocked = await ctx.executeTool('manage_metadata', { action: 'delete', object_type: 'dataElements', object_id: deId });
  const blockedText = JSON.stringify(blocked);
  if (!blocked._error) { fail(`expected E4030 block, got: ${blockedText.slice(0, 300)}`); return; }
  if (!/softDeletedEventRemoval/.test(blockedText)) { fail(`blocked delete lacks the softDeletedEventRemoval hint: ${blockedText.slice(0, 400)}`); return; }
  pass('blocked delete returns E4030 with the softDeletedEventRemoval recovery hint');
  const afterBlocked = API.length; // the intentional 409 window — excluded from the tally

  // 2. Maintenance call must be reported as SUCCESS despite the empty body.
  const maint = await ctx.executeTool('dhis2_query', { method: 'POST', path: 'maintenance?softDeletedEventRemoval=true' });
  if (maint._error || maint.success !== true) { fail(`maintenance call not a success: ${JSON.stringify(maint).slice(0, 300)}`); return; }
  pass('maintenance?softDeletedEventRemoval=true reports success (empty 2xx body)');

  // 3. Retry the SAME delete — must now succeed.
  const retried = await ctx.executeTool('manage_metadata', { action: 'delete', object_type: 'dataElements', object_id: deId });
  if (!retried.success) { fail(`retried delete did not succeed: ${JSON.stringify(retried).slice(0, 400)}`); return; }
  pass('retried delete succeeds after soft-deleted event removal');
  const afterCounted = API.length;

  // ── Teardown ─────────────────────────────────────────────────────────────
  const progDel = await raw('DELETE', `programs/${progId}`);
  if (![200, 204].includes(progDel.status)) fail(`teardown: program delete HTTP ${progDel.status}`);
  const probeDe = await raw('GET', `dataElements/${deId}.json?fields=id`);
  const probeProg = await raw('GET', `programs/${progId}.json?fields=id`);
  if (probeDe.status === 404 && probeProg.status === 404) pass('teardown: instance left exactly as found (DE + program gone)');
  else fail(`teardown probes: DE ${probeDe.status}, program ${probeProg.status}`);

  // ── Failed-call tally over the counted tool window, minus the intended 409 ─
  const failures = [];
  for (let i = beforeCounted; i < afterCounted; i++) {
    const c = API[i];
    const intended409 = i >= beforeBlocked && i < afterBlocked && c.status === 409;
    if (!c.ok && !intended409) failures.push(c);
  }
  if (failures.length) {
    fail(`${failures.length} unexpected failed API call(s):`);
    for (const f of failures) console.error(`   ${f.method} ${f.url} → ${f.status}`);
  } else {
    pass(`0 unexpected failed API calls across ${afterCounted - beforeCounted} tool-driven requests`);
  }
})().catch((e) => { fail(`scenario threw: ${e.stack || e}`); });
