#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-growth-chart.js — live acceptance for manage_growth_chart_plugin.
 *
 * Reproduces the failure reported on 2026-07-25 against a tracker program whose
 * attributes include a several-thousand option lookup option set. Expanding every
 * option set in one program request produced a ~450 KB response, safeDhis2Fetch
 * truncated it to a stub, and the tool reported `Program "undefined" is not a
 * tracker (WITH_REGISTRATION) program` about a program that IS a tracker program.
 *
 * It also pins the second, quieter defect: the stage carried "Height status"
 * (TEXT) and "Weight Status" (TEXT) BEFORE "Height (cm)" and "Weight (Kg)", so
 * first-match-wins name detection wrote a config the plugin accepts and cannot
 * plot.
 *
 * Point it at any tracker program that has a date-of-birth attribute, a gender
 * attribute with an option set, and numeric weight/height/head-circumference data
 * elements on the stage:
 *
 *   DHIS2_BASE=… DHIS2_AUTH=user:pass \
 *     node scripts/scenario-growth-chart.js <programId> <stageId>
 *
 * Set GC_KEEP=1 to leave the written config in place; otherwise the scenario
 * restores the dataStore key to how it found it.
 * ───────────────────────────────────────────────────────────────────────────── */
const { load, API, summarize, BASE } = require('./live-harness');

const PROGRAM = process.argv[2] || process.env.GC_PROGRAM;
const STAGE = process.argv[3] || process.env.GC_STAGE;
if (!PROGRAM || !STAGE) {
  console.error('Usage: node scripts/scenario-growth-chart.js <programId> <stageId>');
  console.error('   or: GC_PROGRAM=… GC_STAGE=… node scripts/scenario-growth-chart.js');
  process.exit(2);
}
const KEEP = process.env.GC_KEEP === '1';

let failures = 0;
function check(label, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

// The write tools gate their first call behind a usage manual; the model re-issues
// the identical call afterwards. Do the same so the scenario exercises the tool.
async function callTool(ctx, name, args) {
  let r = await ctx.executeTool(name, args);
  if (r && (r._manual || r._usage_manual || r.manual)) r = await ctx.executeTool(name, args);
  return r;
}

(async () => {
  const ctx = load({ appType: 'Capture' });
  console.log(`\nGrowth chart plugin — live acceptance against ${BASE}`);
  console.log(`  program ${PROGRAM}, stage ${STAGE}\n`);

  // ── Snapshot the dataStore key so the run is reversible ──
  // Probe via the namespace list, which always answers 200 — asking for the key
  // directly would log a 404 on a run where nothing is wrong.
  const namespaces = await ctx.executeTool('dhis2_query', { path: 'dataStore' });
  const hadConfig = Array.isArray(namespaces) && namespaces.includes('captureGrowthChart');
  const snapshotIndex = API.length;

  console.log('1. status');
  const status = await callTool(ctx, 'manage_growth_chart_plugin', { action: 'status' });
  check('status returns without error', !status._error, status._error);
  check('plugin app is installed', status.plugin_installed === true, status.plugin_installed);

  console.log('2. configure (the call that used to report "Program \\"undefined\\"")');
  const cfg = await callTool(ctx, 'manage_growth_chart_plugin', {
    action: 'configure', program_id: PROGRAM, program_stage_id: STAGE,
  });
  check('configure succeeded', cfg.success === true, cfg._error || cfg);
  if (cfg._error) { report(); return; }

  check('program name resolved (not "undefined")', typeof cfg.program?.name === 'string' && cfg.program.name.length > 0, cfg.program);
  check('config read back and verified', cfg.config_verified === true, cfg.config_verified);
  check('stage mapped is the requested stage', cfg.stage?.id === STAGE, cfg.stage);

  console.log('3. the measurements chosen are the numeric ones, not the TEXT lookalikes');
  const named = cfg.resolved?.named || {};
  check(`weight is numeric ("${named.weight?.name}")`, /kg|gram|\bwt\b/i.test(named.weight?.name || '') && !/status/i.test(named.weight?.name || ''), named.weight);
  check(`height is numeric ("${named.height?.name}")`, !/status/i.test(named.height?.name || ''), named.height);
  check(`head circumference resolved ("${named.headCircumference?.name}")`, /head/i.test(named.headCircumference?.name || ''), named.headCircumference);

  // Confirm against DHIS2 that each configured UID really is a numeric DE on the stage.
  const stageDes = await ctx.executeTool('dhis2_query', {
    path: `programStages/${STAGE}?fields=programStageDataElements[dataElement[id,displayName,valueType]]`,
  });
  const byId = new Map((stageDes.programStageDataElements || []).map(p => [p.dataElement.id, p.dataElement]));
  for (const role of ['weight', 'height', 'headCircumference']) {
    const de = byId.get(cfg.resolved.dataElements[role]);
    check(`${role} is a NUMBER data element on the stage`, de && /^(NUMBER|INTEGER|INTEGER_POSITIVE|INTEGER_ZERO_OR_POSITIVE)$/.test(de.valueType), de);
  }

  console.log('4. the stored config matches the plugin schema');
  const stored = await ctx.executeTool('dhis2_query', { path: 'dataStore/captureGrowthChart/config' });
  check('config key exists', !stored._error, stored._error);
  check('metadata.attributes.dateOfBirth set', !!stored.metadata?.attributes?.dateOfBirth, stored.metadata?.attributes);
  check('gender codes are real option codes', !!stored.metadata?.attributes?.femaleOptionCode && !!stored.metadata?.attributes?.maleOptionCode, stored.metadata?.attributes);
  check('programStageForGrowthChart maps program → stage', stored.metadata?.programStageForGrowthChart?.[PROGRAM] === STAGE, stored.metadata?.programStageForGrowthChart);
  check('settings.defaultIndicator is valid', ['wfa', 'hcfa', 'lhfa', 'wflh'].includes(stored.settings?.defaultIndicator), stored.settings);
  check('weightInGrams is false for a Kg data element', stored.settings?.weightInGrams === false, stored.settings);

  console.log('5. configure is idempotent (a second run must not drift)');
  const again = await callTool(ctx, 'manage_growth_chart_plugin', {
    action: 'configure', program_id: PROGRAM, program_stage_id: STAGE,
  });
  check('second configure succeeded', again.success === true, again._error);
  check('same data elements resolved', JSON.stringify(again.resolved?.dataElements) === JSON.stringify(cfg.resolved.dataElements), again.resolved?.dataElements);

  console.log('6. bad input is refused precisely (no misleading verdicts)');
  const badStage = await callTool(ctx, 'manage_growth_chart_plugin', {
    action: 'configure', program_id: PROGRAM, program_stage_id: 'ZZZZZZZZZZZ',
  });
  check('a stage from another program is named as such', /is not part of program/.test(badStage._error || ''), badStage._error);
  const badDe = await callTool(ctx, 'manage_growth_chart_plugin', {
    action: 'configure', program_id: PROGRAM, program_stage_id: STAGE, data_element_ids: { weight: 'ZZZZZZZZZZZ' },
  });
  check('a data element not on the stage is named as such', /is not a data element of stage/.test(badDe._error || ''), badDe._error);

  // ── Restore ──
  if (!KEEP && !hadConfig) {
    // Only tear down what this run created. If the namespace already existed the
    // config belongs to the instance — leave it alone and say so.
    await callTool(ctx, 'manage_growth_chart_plugin', { action: 'remove', confirm_delete_all: true });
    console.log('\n  (dataStore restored — set GC_KEEP=1 to leave the config in place)');
  } else if (!KEEP) {
    console.log('\n  (captureGrowthChart already existed before this run — left as found, program mapping updated)');
  } else {
    console.log('\n  (GC_KEEP=1 — config left in place)');
  }

  report(snapshotIndex);

  function report(since = 0) {
    const { total, failed } = summarize(since);
    console.log(`\n  ${total} API call(s), ${failed.length} failed`);
    for (const f of failed) console.log(`    ${f.method} ${f.url} → ${f.status}`);
    console.log(failures === 0 && failed.length === 0
      ? '\n\x1b[32mAll growth-chart checks passed with 0 failed API calls.\x1b[0m\n'
      : `\n\x1b[31m${failures} check(s) failed, ${failed.length} failed API call(s).\x1b[0m\n`);
    process.exit(failures === 0 && failed.length === 0 ? 0 : 1);
  }
})().catch((e) => { console.error('scenario threw:', e); process.exit(1); });
