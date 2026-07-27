#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-stage-context.js — live regression for the "can't see what stage
 * I'm in" wipe (v2.8.23). Drives the REAL initializeFromUrl / syncFromTab
 * context pipeline against a live DHIS2 using the actual Capture URL shapes
 * observed in the browser:
 *
 *   dashboard:  #/enrollment?enrollmentId=…&orgUnitId=…&programId=…&teiId=…
 *   event edit: #/enrollmentEventEdit?eventId=…&orgUnitId=…      (no program/stage!)
 *   new event:  #/enrollmentEventNew?…&stageId=…
 *
 * Asserts: event URLs resolve program+stage from the API; dashboard URLs keep
 * the known stage (sticky) instead of wiping it; leaving the program clears it;
 * getSerializableState resolves the stage NAME the side-panel chip shows.
 * Uses a scratch tracker program + TEI + enrollment + event; cleans up fully.
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
  const uid = () => ctx.generateDhis2Uid();
  const suffix = Date.now().toString(36);

  // ── Scratch tracker program: TET person + program + 2 stages ─────────────
  const tetRes = await raw('GET', 'trackedEntityTypes.json?fields=id&pageSize=1');
  const tetId = tetRes.json?.trackedEntityTypes?.[0]?.id;
  const rootRes = await raw('GET', 'organisationUnits.json?filter=level:eq:1&fields=id&pageSize=1');
  const ouId = rootRes.json?.organisationUnits?.[0]?.id;
  if (!tetId || !ouId) { fail('missing TET or root OU'); return; }

  const progId = uid(), stage1 = uid(), stage2 = uid();
  const meta = {
    programs: [{
      id: progId, name: `ZZ StageCtx Prog ${suffix}`, shortName: `ZZ StageCtx ${suffix}`.slice(0, 50),
      programType: 'WITH_REGISTRATION', trackedEntityType: { id: tetId },
      organisationUnits: [{ id: ouId }],
      programStages: [{ id: stage1 }, { id: stage2 }],
    }],
    programStages: [
      { id: stage1, name: `ZZ StageCtx One ${suffix}`, program: { id: progId } },
      { id: stage2, name: `ZZ StageCtx Two ${suffix}`, program: { id: progId } },
    ],
  };
  const imp = await raw('POST', 'metadata?importMode=COMMIT&atomicMode=ALL', meta);
  if (imp.status !== 200 || imp.json?.status === 'ERROR') { fail(`setup import HTTP ${imp.status}: ${JSON.stringify(imp.json?.response?.typeReports || imp.json).slice(0, 300)}`); return; }

  const teiId = uid(), enrId = uid(), evId = uid();
  const trk = await raw('POST', 'tracker?async=false&importStrategy=CREATE_AND_UPDATE', {
    trackedEntities: [{
      trackedEntity: teiId, trackedEntityType: tetId, orgUnit: ouId,
      enrollments: [{
        enrollment: enrId, program: progId, orgUnit: ouId,
        enrolledAt: '2026-07-27T00:00:00.000', occurredAt: '2026-07-27T00:00:00.000',
        events: [{
          event: evId, program: progId, programStage: stage2, orgUnit: ouId,
          occurredAt: '2026-07-27', status: 'ACTIVE',
        }],
      }],
    }],
  });
  if (trk.status !== 200 || trk.json?.status === 'ERROR') { fail(`tracker setup HTTP ${trk.status}: ${JSON.stringify(trk.json?.validationReport || trk.json).slice(0, 400)}`); return; }
  pass('setup: scratch tracker program (2 stages) + TEI + enrollment + event in stage TWO');

  const capture = (hash) => `${BASE}/apps/capture/index.html#/${hash}`;

  // 1. Event-edit URL — no programId/stageId in URL; must resolve BOTH via API.
  let r = await ctx.initializeFromUrl(capture(`enrollmentEventEdit?eventId=${evId}&orgUnitId=${ouId}`));
  let st = ctx.getSerializableState();
  if (st.stageId === stage2 && st.programId === progId) pass('event-edit URL resolves program + stage from the event');
  else { fail(`event-edit resolution: stageId=${st.stageId} programId=${st.programId} (wanted ${stage2}/${progId})`); }

  // 2. Back to the enrollment dashboard (no stageId in URL) — stage must SURVIVE.
  await ctx.initializeFromUrl(capture(`enrollment?enrollmentId=${enrId}&orgUnitId=${ouId}&programId=${progId}&teiId=${teiId}`));
  st = ctx.getSerializableState();
  if (st.stageId === stage2) pass('dashboard URL keeps the resolved stage (sticky — the v2.8.22 wipe)');
  else fail(`dashboard rebuild wiped the stage: stageId=${st.stageId}`);
  if (st.stageName && st.stageName.startsWith('ZZ StageCtx Two')) pass(`side-panel chip name resolves: "${st.stageName}"`);
  else fail(`stageName not resolved: ${st.stageName}`);

  // 3. New-event URL for stage ONE — fresh URL stage must WIN over the sticky one.
  await ctx.initializeFromUrl(capture(`enrollmentEventNew?enrollmentId=${enrId}&orgUnitId=${ouId}&programId=${progId}&stageId=${stage1}&teiId=${teiId}`));
  st = ctx.getSerializableState();
  if (st.stageId === stage1) pass('a stageId in the fresh URL overrides the sticky stage');
  else fail(`URL stage did not win: stageId=${st.stageId}`);

  // 4. Enrollment-only URL (older Capture shape) — program resolved via enrollment.
  await ctx.initializeFromUrl(capture(`enrollment?enrollmentId=${enrId}`));
  st = ctx.getSerializableState();
  if (st.programId === progId) pass('enrollment-only URL resolves the program via tracker/enrollments');
  else fail(`enrollment-only resolution failed: programId=${st.programId}`);
  if (st.stageId === stage1) pass('…and keeps the sticky stage across it');
  else fail(`sticky stage lost on enrollment-only URL: stageId=${st.stageId}`);

  // 5. Leaving the program entirely must DROP the stage.
  await ctx.initializeFromUrl(`${BASE}/dhis-web-dashboard/index.html#/`);
  st = ctx.getSerializableState();
  if (!st.stageId) pass('leaving the program clears the stage');
  else fail(`stage leaked outside the program: stageId=${st.stageId}`);

  // ── Teardown: delete TEI (hard), then program, then purge soft-deletes ───
  const delTei = await raw('POST', 'tracker?async=false&importStrategy=DELETE', { trackedEntities: [{ trackedEntity: teiId }] });
  if (delTei.status !== 200) fail(`teardown TEI delete HTTP ${delTei.status}`);
  await raw('POST', 'maintenance?softDeletedEventRemoval=true&softDeletedEnrollmentRemoval=true&softDeletedTrackedEntityRemoval=true');
  const delProg = await raw('DELETE', `programs/${progId}`);
  if (![200, 204].includes(delProg.status)) fail(`teardown program delete HTTP ${delProg.status}`);
  const probe = await raw('GET', `programs/${progId}.json?fields=id`);
  if (probe.status === 404) pass('teardown: instance left exactly as found');
  else fail(`teardown probe: program still ${probe.status}`);

  const { failed } = summarize();
  const realFailures = failed.filter(f => !(f.status === 404));
  if (realFailures.length) {
    fail(`${realFailures.length} failed API call(s) during context pipeline:`);
    for (const f of realFailures) console.error(`   ${f.method} ${f.url} → ${f.status}`);
  } else {
    pass('0 failed API calls across the context pipeline');
  }
})().catch((e) => { fail(`scenario threw: ${e.stack || e}`); });
