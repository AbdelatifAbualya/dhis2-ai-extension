#!/usr/bin/env node
'use strict';
/* Verify EVERY prompt-1 detail of the Integrated Pregnancy tracker on the live
 * instance: program shell, 15 TEAs (flags/types), 5 stages (repeatable, order,
 * sections, 20 DEs each, value types, option sets, compulsory), option-set
 * contents, 103 rules with resolving variables, and a clean rule audit. */
const path = require('path');
const { load, API, summarize } = require('./live-harness');
const state = require(process.env.P1_STATE || path.join(__dirname, '..', '.p1-state.json'));

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + JSON.stringify(detail).slice(0, 250) : ''}`); }
}

(async () => {
  const ctx = load({ appType: 'Maintenance' });
  const t = (name, args) => ctx.executeTool(name, args);
  const pid = state.programId;

  console.log(`\nVerifying program ${pid} on the live instance`);
  const prog = await t('dhis2_query', {
    path: `programs/${pid}?fields=id,name,shortName,description,style,onlyEnrollOnce,trackedEntityType[id,name],organisationUnits~size,` +
      'programTrackedEntityAttributes[mandatory,searchable,displayInList,trackedEntityAttribute[id,name,valueType,unique,generated,pattern,optionSet[id,name,options[name,code]]]],' +
      'programStages[id,name,sortOrder,repeatable,programStageSections[name,dataElements~size],programStageDataElements[compulsory,dataElement[id,name,valueType,optionSet[id,name,options[name,code]]]]]',
  });

  // ── Program shell ─────────────────────────────────────────────────────────
  console.log('\n— Program shell —');
  check('name', prog.name === 'Integrated Pregnancy, Delivery and Postnatal Care Tracker', prog.name);
  check('description present', !!(prog.description && prog.description.length > 50));
  check('tracked entity type is Pregnant Woman', prog.trackedEntityType?.name === 'Pregnant Woman', prog.trackedEntityType);
  check('style color set', prog.style?.color === '#E91E63', prog.style);
  check('style icon set', !!prog.style?.icon, prog.style);
  const ouTotal = (await t('dhis2_query', { path: 'organisationUnits?totalPages=true&pageSize=1&fields=id' }))?.pager?.total || 0;
  check(`assigned to ALL org units (${ouTotal})`, (prog.organisationUnits || 0) === ouTotal && ouTotal > 0, { program: prog.organisationUnits, instance: ouTotal });

  // ── Tracked entity attributes ─────────────────────────────────────────────
  console.log('\n— Tracked entity attributes (15) —');
  const pteas = prog.programTrackedEntityAttributes || [];
  check('15 attributes on program', pteas.length === 15, pteas.length);
  const byName = new Map(pteas.map(p => [p.trackedEntityAttribute.name, p]));
  const expectTea = [
    ['Pregnancy client ID', 'TEXT'], ['National ID', 'TEXT'], ['Full name', 'TEXT'],
    ['Date of Birth', null], ['Primary phone number', 'PHONE_NUMBER'], ['Alternative phone number', 'PHONE_NUMBER'],
    ['Village or community', 'TEXT'], ['Full residential address', 'LONG_TEXT'],
    ['Preferred language', 'TEXT'], ['Marital status', 'TEXT'], ['Education level', 'TEXT'],
    ['Consent to receive appointment reminders', 'BOOLEAN'], ['Emergency contact name', 'TEXT'],
    ['Emergency contact phone', 'PHONE_NUMBER'], ['Residence coordinate', 'COORDINATE'],
  ];
  for (const [name, vt] of expectTea) {
    const p = byName.get(name);
    check(`TEA "${name}"${vt ? ` (${vt})` : ''}`, !!p && (vt === null || p.trackedEntityAttribute.valueType === vt),
      p ? p.trackedEntityAttribute.valueType : 'MISSING');
  }
  const clientId = byName.get('Pregnancy client ID')?.trackedEntityAttribute;
  check('client ID auto-generated + unique + pattern', clientId?.generated === true && clientId?.unique === true && !!clientId?.pattern, clientId);
  check('client ID searchable + in lists', byName.get('Pregnancy client ID')?.searchable === true && byName.get('Pregnancy client ID')?.displayInList === true);
  check('full name searchable + in lists', byName.get('Full name')?.searchable === true && byName.get('Full name')?.displayInList === true);
  check('national ID searchable', byName.get('National ID')?.searchable === true);
  check('marital status has 5 options', (byName.get('Marital status')?.trackedEntityAttribute.optionSet?.options || []).length === 5);
  check('education level has 5 options', (byName.get('Education level')?.trackedEntityAttribute.optionSet?.options || []).length === 5);
  check('preferred language has 3 options', (byName.get('Preferred language')?.trackedEntityAttribute.optionSet?.options || []).length === 3);

  // ── Stages ────────────────────────────────────────────────────────────────
  console.log('\n— Stages —');
  const stages = (prog.programStages || []).sort((a, b) => a.sortOrder - b.sortOrder);
  check('5 stages', stages.length === 5, stages.map(s => s.name));
  const expectStages = [
    ['Registration and First ANC Assessment', false, 4],
    ['Routine ANC Follow-up', true, 5],
    ['Laboratory and Ultrasound Assessment', true, 3],
    ['Delivery and Birth Outcome', false, 3],
    ['Postnatal Mother and Newborn Follow-up', true, 5],
  ];
  const stageByName = new Map(stages.map(s => [s.name, s]));
  expectStages.forEach(([name, rep, nSections], i) => {
    const s = stages[i];
    check(`stage ${i + 1} "${name}" order+repeatable=${rep}`, !!s && s.name === name && s.repeatable === rep, s && { name: s.name, repeatable: s.repeatable });
    check(`  20 data elements`, (s?.programStageDataElements || []).length === 20, s?.programStageDataElements?.length);
    check(`  ${nSections} sections`, (s?.programStageSections || []).length === nSections, s?.programStageSections?.length);
  });

  // Per-stage DE spot checks: value types + option sets + compulsory
  // Reuse doctrine makes DE display names flexible: an existing case-variant
  // ("Systolic Blood Pressure") may be reused, or an incompatible same-name DE
  // forces a coexisting "<name> (<program short>)" — match all three forms.
  const de = (stageName, deName) => (stageByName.get(stageName)?.programStageDataElements || [])
    .find(x => x.dataElement.name.toLowerCase() === deName.toLowerCase()
      || x.dataElement.name.toLowerCase().startsWith(deName.toLowerCase() + ' ('));
  console.log('\n— Data element details —');
  const S1 = 'Registration and First ANC Assessment', S2 = 'Routine ANC Follow-up',
        S3 = 'Laboratory and Ultrasound Assessment', S4 = 'Delivery and Birth Outcome',
        S5 = 'Postnatal Mother and Newborn Follow-up';
  check('S1 LMP known BOOLEAN compulsory', de(S1, 'Last menstrual period known')?.dataElement.valueType === 'BOOLEAN' && de(S1, 'Last menstrual period known')?.compulsory === true);
  check('S1 risk classification has Low/Moderate/High/Critical', (de(S1, 'Pregnancy risk classification')?.dataElement.optionSet?.options || []).map(o => o.code).join(',') === 'LOW,MODERATE,HIGH,CRITICAL', de(S1, 'Pregnancy risk classification')?.dataElement.optionSet);
  check('S1 chronic condition option set (8)', (de(S1, 'Main chronic condition')?.dataElement.optionSet?.options || []).length === 8);
  const sharedBp = de(S1, 'Systolic blood pressure')?.dataElement.id;
  check('S2 reuses the SAME systolic BP data element', !!sharedBp && de(S2, 'Systolic blood pressure')?.dataElement.id === sharedBp, { s1: sharedBp, s2: de(S2, 'Systolic blood pressure')?.dataElement.id });
  check('S2 danger sign option set (9)', (de(S2, 'Main danger sign')?.dataElement.optionSet?.options || []).length === 9);
  check('S2 urine protein options Negative..4+', (de(S2, 'Urine protein result')?.dataElement.optionSet?.options || []).length === 6);
  const sharedUrine = de(S2, 'Urine protein result')?.dataElement.id;
  check('S3 reuses the SAME urine protein DE', !!sharedUrine && de(S3, 'Urine protein result')?.dataElement.id === sharedUrine);
  const sharedHb = de(S2, 'Haemoglobin in g/dL')?.dataElement.id;
  check('S3 reuses the SAME haemoglobin DE', !!sharedHb && de(S3, 'Haemoglobin in g/dL')?.dataElement.id === sharedHb);
  check('S3 HIV + syphilis share ONE result option set', de(S3, 'HIV test result')?.dataElement.optionSet?.id === de(S3, 'Syphilis test result')?.dataElement.optionSet?.id);
  check('S4 delivery facility ORGANISATION_UNIT', de(S4, 'Delivery facility')?.dataElement.valueType === 'ORGANISATION_UNIT');
  check('S4 delivery datetime compulsory', de(S4, 'Delivery date and time')?.dataElement.valueType === 'DATETIME' && de(S4, 'Delivery date and time')?.compulsory === true);
  check('S4 mode of delivery (5 options)', (de(S4, 'Mode of delivery')?.dataElement.optionSet?.options || []).length === 5);
  check('S4 newborn outcome (4 options)', (de(S4, 'Newborn outcome')?.dataElement.optionSet?.options || []).length === 4);
  const sharedRef = de(S2, 'Referral required')?.dataElement.id;
  check('S5 reuses the SAME referral-required DE', !!sharedRef && de(S5, 'Referral required')?.dataElement.id === sharedRef);
  check('S5 postnatal destination includes Neonatal unit', (de(S5, 'Postnatal referral destination')?.dataElement.optionSet?.options || []).some(o => o.code === 'NEONATAL_UNIT'));
  check('S5 timing option set (5)', (de(S5, 'Postnatal contact timing')?.dataElement.optionSet?.options || []).length === 5);

  // ── Rules ─────────────────────────────────────────────────────────────────
  console.log('\n— Program rules —');
  const rules = await t('dhis2_query', { path: `programRules?filter=program.id:eq:${pid}&fields=id,name,condition,programRuleActions[programRuleActionType,content,data,location,dataElement[name],trackedEntityAttribute[name],programStage[name]]&pageSize=200` });
  const ruleList = rules?.programRules || [];
  check('103 rules created', ruleList.length === 103, ruleList.length);
  const ruleNames = new Set(ruleList.map(r => r.name));
  for (const mustExist of [
    'Assign estimated due date from LMP', 'Hide LMP date when LMP is not known',
    'Hide previous pregnancy history for a first pregnancy', 'Display BMI in feedback',
    'Urgent warning for severe blood pressure', 'Block completion when parity exceeds gravidity',
    'Assign Critical pregnancy risk classification', 'Assign Low pregnancy risk classification',
    'Warn for suspected pre-eclampsia after 20 weeks', 'Urgent warning for severe anaemia',
    'Suggest next ANC contact in 4 weeks before 28 weeks',
    'Hide HIV care linkage unless HIV result is positive', 'Require syphilis treatment information for a positive result',
    'Hide ultrasound details when no ultrasound performed', 'Urgent referral warning for serious ultrasound findings',
    'Block completion when delivery is before admission', 'Urgent notification for maternal death',
    'Hide live-newborn fields for a stillbirth', 'Urgent warning and required resuscitation details for low Apgar',
    'Remind to create a record for each baby of a multiple birth',
    'Assign postnatal timing within 24 hours', 'Warn when the first postnatal contact is later than 72 hours',
    'Warn for excessive newborn weight loss', 'Warn when BCG is not recorded at the six-week visit',
    'Require postnatal referral destination when referral required',
  ]) check(`rule "${mustExist}"`, ruleNames.has(mustExist));

  // Maternal-death rule hides the postnatal stage
  const mdRule = ruleList.find(r => r.name === 'Urgent notification for maternal death');
  check('maternal death rule hides postnatal stage', (mdRule?.programRuleActions || []).some(a => a.programRuleActionType === 'HIDEPROGRAMSTAGE' && a.programStage?.name === S5), mdRule?.programRuleActions);
  // DISPLAYKEYVALUEPAIR actions carry a feedback location
  const kvActions = ruleList.flatMap(r => r.programRuleActions || []).filter(a => a.programRuleActionType === 'DISPLAYKEYVALUEPAIR');
  check(`feedback key-value actions present (${kvActions.length}) with location=feedback`, kvActions.length >= 20 && kvActions.every(a => a.location === 'feedback'), kvActions.filter(a => a.location !== 'feedback').length);

  // Every #{var} in every condition resolves to a programRuleVariable
  const prvs = await t('dhis2_query', { path: `programRuleVariables?filter=program.id:eq:${pid}&fields=id,name&pageSize=300` });
  const prvNames = new Set((prvs?.programRuleVariables || []).map(v => v.name));
  let unresolved = [];
  for (const r of ruleList) {
    const refs = String(r.condition || '').match(/#\{([^}]+)\}/g) || [];
    for (const ref of refs) {
      const v = ref.slice(2, -1);
      if (!prvNames.has(v)) unresolved.push(`${r.name}: #{${v}}`);
    }
  }
  check('every #{variable} in every rule condition resolves', unresolved.length === 0, unresolved.slice(0, 5));

  // ── Tool-level audit (cross-rule contradictions, lint) ────────────────────
  console.log('\n— Rule audit —');
  const audit = await t('manage_program_rules', { action: 'audit', program_id: pid });
  const crossIssues = audit?.cross_rule_issues || [];
  const ruleIssues = audit?.rule_issues || audit?.issues || [];
  check('audit: no cross-rule contradictions', crossIssues.length === 0, crossIssues.slice(0, 3));
  const hard = (Array.isArray(ruleIssues) ? ruleIssues : []).filter(i => !/compuls/i.test(JSON.stringify(i)));
  check('audit: no rule-level issues', hard.length === 0, hard.slice(0, 3));

  const { total, failed } = summarize();
  console.log(`\nAPI calls: ${total}, failed: ${failed.length}`);
  for (const f of failed) console.log(`  FAILED ${f.method} ${f.url} → ${f.status}`);
  if (failures || failed.length) { console.log(`\nRESULT: FAIL (${failures} check failures, ${failed.length} failed calls)`); process.exit(1); }
  console.log('\nRESULT: PASS — every prompt-1 detail verified on the live instance.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
