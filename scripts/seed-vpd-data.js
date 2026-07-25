#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * seed-vpd-data.js — put sample VPD surveillance cases on a live DHIS2, DIRECTLY
 * through the Web API.
 *
 * This is TEST SCAFFOLDING, not a chatbot capability. The acceptance scenario
 * needs data in the program so the dashboard tiles, line lists and program
 * indicators have something to render — but creating patient records is not
 * what the assistant is for, so the harness seeds them itself and the assistant
 * is only asked to VERIFY that the analytics outputs work.
 *
 * Usage:
 *   DHIS2_BASE=http://localhost:8081 DHIS2_AUTH=admin:district \
 *     node scripts/seed-vpd-data.js [--program "VPD Case-Based Surveillance"]
 *
 * Idempotent-ish: every run uses a fresh Epid Number prefix, so re-running adds
 * cases rather than colliding on the unique attribute.
 * ───────────────────────────────────────────────────────────────────────────── */

const BASE = (process.env.DHIS2_BASE || 'http://localhost:8081').replace(/\/+$/, '');
const AUTH = 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64');
const API = `${BASE}/api`;

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PROGRAM_NAME = argOf('--program', 'VPD Case-Based Surveillance');
const CASE_COUNT = Number(argOf('--cases', 8));

// A stock Tomcat-fronted DHIS2 enforces RFC 7230 and rejects a raw `[`/`]` in
// the request target with 400 "Invalid character found in the request target" —
// and DHIS2's own nested `fields=a[b]` syntax is full of them. Encode the query
// portion the same way the extension's transport does.
function encodeQuery(path) {
  const q = path.indexOf('?');
  if (q === -1) return path;
  return path.slice(0, q + 1) + path.slice(q + 1).replace(/[\s"<>\[\\\]^`{|}]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

async function api(path, opts = {}) {
  const resp = await fetch(`${API}/${encodeQuery(path)}`, {
    ...opts,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) },
  });
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { _raw: text }; }
  return { ok: resp.ok, status: resp.status, body };
}

// DHIS2 base62 UID: a letter, then 10 alphanumerics.
const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALNUM = ALPHA + '0123456789';
const uid = () => ALPHA[Math.floor(Math.random() * ALPHA.length)]
  + Array.from({ length: 10 }, () => ALNUM[Math.floor(Math.random() * ALNUM.length)]).join('');

const isoDaysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const pick = (arr, i) => arr[i % arr.length];

(async () => {
  // ── Resolve the program and everything the payload references ──
  const progResp = await api(`programs?filter=name:eq:${encodeURIComponent(PROGRAM_NAME)}`
    + '&fields=id,name,trackedEntityType[id],organisationUnits[id],'
    + 'programTrackedEntityAttributes[trackedEntityAttribute[id,name,valueType,unique,optionSet[id]]],'
    + 'programStages[id,name,programStageDataElements[compulsory,dataElement[id,name,valueType,optionSet[id]]]]'
    + '&paging=false');
  const program = progResp.body?.programs?.[0];
  if (!program) {
    console.error(`Program "${PROGRAM_NAME}" not found on ${BASE}. Run the program-creation turn first.`);
    process.exit(2);
  }

  const orgUnits = (program.organisationUnits || []).map(o => o.id);
  if (!orgUnits.length) { console.error('Program has no org units assigned.'); process.exit(2); }

  const attrByName = new Map();
  for (const p of program.programTrackedEntityAttributes || []) {
    const a = p.trackedEntityAttribute;
    attrByName.set(a.name.toLowerCase(), a);
  }
  const stageByName = new Map();
  for (const st of program.programStages || []) stageByName.set(st.name.toLowerCase(), st);

  const findAttr = (frag) => [...attrByName.values()].find(a => a.name.toLowerCase().includes(frag));
  const findStage = (frag) => [...stageByName.values()].find(s => s.name.toLowerCase().includes(frag));
  const findDe = (stage, frag) => (stage?.programStageDataElements || [])
    .map(p => p.dataElement).find(d => d.name.toLowerCase().includes(frag));

  // Option codes for any option-set-backed field we fill.
  const optionCache = new Map();
  const codesFor = async (optionSetId) => {
    if (!optionSetId) return [];
    if (optionCache.has(optionSetId)) return optionCache.get(optionSetId);
    const r = await api(`optionSets/${optionSetId}?fields=options[code]`);
    const codes = (r.body?.options || []).map(o => o.code);
    optionCache.set(optionSetId, codes);
    return codes;
  };
  const codeFor = async (field, i, prefer) => {
    const codes = await codesFor(field?.optionSet?.id);
    if (!codes.length) return null;
    if (prefer) {
      const hit = codes.find(c => c.toUpperCase().includes(prefer.toUpperCase()));
      if (hit) return hit;
    }
    return pick(codes, i);
  };

  const aEpid = findAttr('epid');
  const aDiag = findAttr('clinical diagnosis');
  const aDob = findAttr('date of birth') || findAttr('birth');
  const aVillage = findAttr('village');

  const stInv = findStage('investigation') || program.programStages[0];
  const stLab = findStage('laborator');
  const stFinal = findStage('classification') || findStage('final');

  const deOnset = findDe(stInv, 'onset');
  const deFever = findDe(stInv, 'fever present') || findDe(stInv, 'fever');
  const deRash = findDe(stInv, 'rash present') || findDe(stInv, 'rash');
  const deVacc = findDe(stInv, 'vaccination status');
  const deInvDate = findDe(stInv, 'case investigation') || findDe(stInv, 'investigation');
  const deLastVacc = findDe(stInv, 'last vaccination');
  const deSpecId = findDe(stLab, 'specimen id');
  const deSpecType = findDe(stLab, 'specimen type');
  const deSpecColl = findDe(stLab, 'specimen collected');
  const deIgm = findDe(stLab, 'igm');
  const deFinal = findDe(stFinal, 'final case classification') || findDe(stFinal, 'classification');
  const deFinalDate = findDe(stFinal, 'date of final');

  // Compulsory DEs must all be present or DHIS2 rejects the event.
  const compulsoryOf = (stage) => (stage?.programStageDataElements || [])
    .filter(p => p.compulsory).map(p => p.dataElement);

  const stamp = Date.now().toString().slice(-6);
  const dv = (de, value) => (de && value !== null && value !== undefined ? [{ dataElement: de.id, value }] : []);

  const fillCompulsory = async (stage, already, i) => {
    const have = new Set(already.map(d => d.dataElement));
    const out = [];
    for (const de of compulsoryOf(stage)) {
      if (have.has(de.id)) continue;
      let v;
      if (de.optionSet?.id) v = await codeFor(de, i);
      else if (de.valueType === 'BOOLEAN' || de.valueType === 'TRUE_ONLY') v = true;
      else if (String(de.valueType).startsWith('DATE')) v = isoDaysAgo(30);
      else if (String(de.valueType).includes('INTEGER') || de.valueType === 'NUMBER') v = 1;
      else v = 'n/a';
      out.push({ dataElement: de.id, value: v });
    }
    return out;
  };

  const trackedEntities = [];
  for (let i = 0; i < CASE_COUNT; i++) {
    const ou = pick(orgUnits, i);
    const onsetDaysAgo = 20 + i * 18;                 // spread over ~6 months
    const investigatedFast = i % 2 === 0;             // half within 48h → indicator lands between 0 and 100
    const igmPositive = i % 3 !== 2;
    const attributes = [];
    if (aEpid) attributes.push({ attribute: aEpid.id, value: `VPD-${stamp}-${String(i + 1).padStart(3, '0')}` });
    if (aDiag) attributes.push({ attribute: aDiag.id, value: await codeFor(aDiag, i, i % 3 === 0 ? 'MEASLES' : null) });
    if (aDob) attributes.push({ attribute: aDob.id, value: isoDaysAgo(2000 + i * 400) });
    if (aVillage) attributes.push({ attribute: aVillage.id, value: `Village ${String.fromCharCode(65 + i)}` });

    const events = [];
    if (stInv) {
      let dvs = [
        ...dv(deOnset, isoDaysAgo(onsetDaysAgo)),
        ...dv(deFever, true),
        ...dv(deRash, i % 2 === 0),
        ...dv(deVacc, await codeFor(deVacc, i)),
        // The program's SETMANDATORYFIELD rule requires this whenever the case
        // is vaccinated — always supply it so the seed satisfies the rule.
        ...dv(deLastVacc, isoDaysAgo(onsetDaysAgo + 400)),
        ...dv(deInvDate, isoDaysAgo(onsetDaysAgo - (investigatedFast ? 1 : 6))),
      ];
      dvs = dvs.concat(await fillCompulsory(stInv, dvs, i));
      events.push({ programStage: stInv.id, orgUnit: ou, occurredAt: isoDaysAgo(onsetDaysAgo), status: 'COMPLETED', dataValues: dvs });
    }
    if (stLab && i % 4 !== 3) {
      let dvs = [
        ...dv(deSpecId, `SPEC-${stamp}-${i + 1}`),
        ...dv(deSpecType, await codeFor(deSpecType, i)),
        ...dv(deSpecColl, isoDaysAgo(onsetDaysAgo - 3)),
        ...dv(deIgm, await codeFor(deIgm, i, igmPositive ? 'POSITIVE' : 'NEGATIVE')),
      ];
      dvs = dvs.concat(await fillCompulsory(stLab, dvs, i));
      events.push({ programStage: stLab.id, orgUnit: ou, occurredAt: isoDaysAgo(onsetDaysAgo - 3), status: 'COMPLETED', dataValues: dvs });
    }
    if (stFinal && i % 4 !== 3) {
      let dvs = [
        ...dv(deFinal, await codeFor(deFinal, i, igmPositive ? 'LABORATORY_CONFIRMED' : 'DISCARDED')),
        ...dv(deFinalDate, isoDaysAgo(onsetDaysAgo - 10)),
      ];
      dvs = dvs.concat(await fillCompulsory(stFinal, dvs, i));
      events.push({ programStage: stFinal.id, orgUnit: ou, occurredAt: isoDaysAgo(onsetDaysAgo - 10), status: 'COMPLETED', dataValues: dvs });
    }

    const teUid = uid();
    trackedEntities.push({
      trackedEntity: teUid,
      trackedEntityType: program.trackedEntityType.id,
      orgUnit: ou,
      attributes,
      enrollments: [{
        enrollment: uid(),
        program: program.id,
        trackedEntity: teUid,
        orgUnit: ou,
        enrolledAt: isoDaysAgo(onsetDaysAgo),
        occurredAt: isoDaysAgo(onsetDaysAgo),
        status: 'COMPLETED',
        events: events.map(e => ({ ...e, event: uid(), trackedEntity: teUid })),
      }],
    });
  }

  const imp = await api('tracker?async=false&importStrategy=CREATE&atomicMode=ALL', {
    method: 'POST',
    body: JSON.stringify({ trackedEntities }),
  });
  const stats = imp.body?.stats || imp.body?.response?.stats || {};
  if (!imp.ok || (stats.ignored && !stats.created)) {
    console.error(`Seeding FAILED (HTTP ${imp.status}).`);
    const reports = imp.body?.validationReport?.errorReports || imp.body?.response?.validationReport?.errorReports || [];
    for (const r of reports.slice(0, 12)) console.error(`  ${r.errorCode || ''} ${r.message}`);
    process.exit(1);
  }
  console.log(`Seeded ${CASE_COUNT} VPD cases into "${program.name}" — created ${stats.created ?? '?'}, ignored ${stats.ignored ?? 0}.`);

  // Analytics must be regenerated before any of it renders.
  const run = await api('resourceTables/analytics', { method: 'POST' });
  const jobId = run.body?.response?.id;
  process.stdout.write('Running analytics tables');
  const started = Date.now();
  while (Date.now() - started < 300000) {
    await new Promise(r => setTimeout(r, 5000));
    process.stdout.write('.');
    const notes = await api(`system/tasks/ANALYTICS_TABLE/${jobId}`);
    const list = Array.isArray(notes.body) ? notes.body : [];
    if (list.some(n => n && n.completed === true)) {
      console.log(` done in ${Math.round((Date.now() - started) / 1000)}s.`);
      process.exit(0);
    }
  }
  console.log(' still running after 300s — analytics may lag.');
})();
