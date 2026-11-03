#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-restore-fidelity.js — does a backup bring an object back EXACTLY?
 *
 * Restore is a full-replace import, so anything a snapshot leaves out is wiped by
 * restoring it. Backups are the safety net of every destructive tool, so this is
 * checked on real objects: give each one distinctive values, take the backup the
 * tools take, restore it, and compare everything DHIS2 calls owned.
 *
 *   DHIS2_BASE=http://localhost:8081 DHIS2_AUTH=admin:district node scripts/scenario-restore-fidelity.js
 *
 * Makes its own ai-test objects and removes them. Touches nothing else.
 * ───────────────────────────────────────────────────────────────────────────── */
const { load, BASE } = require('./live-harness');

const H = { Authorization: 'Basic ' + Buffer.from(process.env.DHIS2_AUTH || 'admin:district').toString('base64'), 'Content-Type': 'application/json', Accept: 'application/json' };
const api = async (p, o = {}) => { const r = await fetch(`${BASE}/api/${p}`, { headers: H, ...o }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const del = (t, id) => fetch(`${BASE}/api/${t}/${id}`, { method: 'DELETE', headers: H });
const NS = 'dhis2-ai-extension-backups';
// Server-kept stamps, at any depth. A restored row keeps its id and content; DHIS2 re-stamps it.
const STAMPS = new Set(['lastUpdated', 'lastUpdatedBy', 'created', 'createdBy', 'user', 'href', 'version']);
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).sort().join(',')}]`
  : (v && typeof v === 'object') ? `{${Object.keys(v).filter((k) => !STAMPS.has(k)).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v === undefined ? null : v));
const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !STAMPS.has(k) && canon(a[k]) !== canon(b[k]));
let failures = 0;
const check = (name, pass, detail) => { console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${!pass && detail ? ` — ${String(detail).slice(0, 300)}` : ''}`); if (!pass) failures++; };

(async () => {
  const ctx = load({ appType: 'Maintenance' });
  await new Promise((r) => setTimeout(r, 50));
  require('vm').runInContext('lastUserText = "Create the test objects.";', ctx);
  const made = [];
  const mk = async (t, body) => { const r = await api(t, { method: 'POST', body: JSON.stringify(body) }); const id = r.response && r.response.uid; if (id) made.unshift([t, id]); return id; };
  const stamp = Date.now().toString(36);
  try {
    const n = (x) => `ai-test restore ${x} ${stamp}`;
    const pub = { sharing: { public: 'rw------' } };
    const tet = await mk('trackedEntityTypes', { name: n('tet'), shortName: n('tet').slice(0, 50), description: 'd', featureType: 'POINT', style: { color: '#123456' }, allowAuditLog: true, ...pub });
    const tea = await mk('trackedEntityAttributes', { name: n('tea'), shortName: n('tea').slice(0, 50), valueType: 'TEXT', aggregationType: 'NONE', formName: 'form name', skipSynchronization: true, ...pub });
    const optSet = await mk('optionSets', { name: n('os'), valueType: 'TEXT', code: `AT${stamp}`, ...pub });
    const de = await mk('dataElements', { name: n('de'), shortName: n('de').slice(0, 50), valueType: 'NUMBER', domainType: 'TRACKER', aggregationType: 'AVERAGE', formName: 'form name', aggregationLevels: [1, 2], ...pub });
    const it = (await api('indicatorTypes.json?fields=id&pageSize=1')).indicatorTypes[0].id;
    const ind = await mk('indicators', { name: n('ind'), shortName: n('ind').slice(0, 50), indicatorType: { id: it }, numerator: '1', denominator: '1', numeratorDescription: 'n', denominatorDescription: 'd', formName: 'form', style: { color: '#123456' }, ...pub });
    const program = await mk('programs', {
      name: n('prog'), shortName: n('prog').slice(0, 50), programType: 'WITH_REGISTRATION', trackedEntityType: { id: tet },
      enrollmentDateLabel: 'enrol label', incidentDateLabel: 'incident label', maxTeiCountToReturn: 50, style: { color: '#654321' }, sharing: { public: 'rwrw----' },
      programTrackedEntityAttributes: [{ trackedEntityAttribute: { id: tea }, mandatory: true, displayInList: true, sortOrder: 1 }],
    });
    const stage = await mk('programStages', {
      name: n('stage'), program: { id: program }, executionDateLabel: 'exec label', dueDateLabel: 'due label', standardInterval: 7, repeatable: true, sharing: { public: 'rwrw----' },
      programStageDataElements: [{ dataElement: { id: de }, compulsory: true, sortOrder: 1, allowFutureDate: true }],
    });
    const pi = await mk('programIndicators', {
      name: n('pi'), shortName: n('pi').slice(0, 50), program: { id: program }, expression: 'V{enrollment_count}', analyticsType: 'ENROLLMENT', aggregationType: 'COUNT', displayInForm: true, style: { color: '#654321' }, ...pub,
      analyticsPeriodBoundaries: [{ boundaryTarget: 'ENROLLMENT_DATE', analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' }, { boundaryTarget: 'ENROLLMENT_DATE', analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' }],
    });
    console.log('\nBackup, restore, compare:');
    for (const [t, id] of [['programs', program], ['programStages', stage], ['programIndicators', pi], ['dataElements', de], ['optionSets', optSet], ['trackedEntityTypes', tet], ['trackedEntityAttributes', tea], ['indicators', ind]]) {
      if (!id) { check(`${t}: test object made`, false); continue; }
      const before = await api(`${t}/${id}.json?fields=:owner`);
      const snap = await ctx.snapshotBeforeWrite({ operation: 'test', tool: 'test', action: 'test', reason: 'ai-test restore fidelity' }, [{ object_type: t, object_id: id, role: 'primary' }]);
      const key = snap.key || snap.backup_key || (snap.block && snap.block.key);
      const rs = await ctx.restoreFromBackup(key);
      const after = await api(`${t}/${id}.json?fields=:owner`);
      check(`${t} comes back exactly`, !rs._error && diff(before, after).length === 0, rs._error || `changed: ${diff(before, after).join(', ')}`);
      await api(`dataStore/${NS}/${key}`, { method: 'DELETE' });
    }

    console.log('\nA backup taken before a sharing change undoes it:');
    const up = await ctx.executeTool('manage_metadata', { action: 'update_sharing', object_type: 'trackedEntityTypes', object_id: tet, public_access: 'rwrw----' });
    const pubOf = async () => (await api(`sharing?type=trackedEntityType&id=${tet}`)).object.publicAccess;
    check('the sharing changes', up.success && (await pubOf()) === 'rwrw----', up._error);
    const rs = await ctx.executeTool('manage_backups', { action: 'restore', backup_key: up.backup.key });
    check('and restoring puts it back', rs.success && (await pubOf()) === 'rw------', rs._error || await pubOf());
    await api(`dataStore/${NS}/${up.backup.key}`, { method: 'DELETE' });
  } catch (e) {
    check(`scenario threw: ${e.message}`, false, e.stack);
  } finally {
    console.log('\nCleanup:');
    for (const [t, id] of made) await del(t, id);
    const keys = await api(`dataStore/${NS}`);
    let removed = 0;
    for (const k of Array.isArray(keys) ? keys : []) {
      if (!/restore|update_sharing/.test(k) || !k.includes(new Date().toISOString().slice(0, 10).replace(/-/g, ''))) continue;
      const e = await api(`dataStore/${NS}/${encodeURIComponent(k)}`);
      if (JSON.stringify(e).includes(`ai-test restore`)) { await api(`dataStore/${NS}/${encodeURIComponent(k)}`, { method: 'DELETE' }); removed++; }
    }
    const left = (await api(`trackedEntityTypes.json?filter=name:like:${encodeURIComponent(stamp)}&fields=id&paging=false`)).trackedEntityTypes || [];
    check(`nothing is left on the server (${removed} extra backup(s) removed)`, left.length === 0, JSON.stringify(left));
    console.log(failures ? `\n\x1b[31mFAILED\x1b[0m — ${failures} check(s)\n` : '\n\x1b[32mALL CHECKS PASSED\x1b[0m\n');
    process.exit(failures ? 1 : 0);
  }
})();
