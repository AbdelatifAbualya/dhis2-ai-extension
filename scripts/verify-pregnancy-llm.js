#!/usr/bin/env node
'use strict';
/* Requirement-driven verification of an LLM-built "Integrated Pregnancy,
 * Delivery and Postnatal Care Tracker" — checks WHAT the prompt demanded
 * without assuming the exact names/phrasing the model chose. */
const { load, summarize } = require('./live-harness');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 220) : ''}`); }
}
const ci = (s) => String(s || '').toLowerCase();

(async () => {
  const ctx = load({ appType: 'Maintenance' });
  const t = (name, args) => ctx.executeTool(name, args);

  const progList = await t('dhis2_query', { path: 'programs?filter=name:ilike:Integrated Pregnancy&fields=id,name&paging=false' });
  const pid = progList?.programs?.[0]?.id;
  check('program "Integrated Pregnancy…" exists', !!pid, progList?.programs);
  if (!pid) { console.log('RESULT: FAIL'); process.exit(1); }

  const prog = await t('dhis2_query', {
    path: `programs/${pid}?fields=id,name,programType,description,trackedEntityType[name],organisationUnits~size,` +
      'programTrackedEntityAttributes[searchable,displayInList,trackedEntityAttribute[id,name,valueType,unique,generated]],' +
      'programStages[id,name,sortOrder,repeatable,programStageSections~size,programStageDataElements[compulsory,dataElement[id,name,valueType,optionSet[id,name,options~size]]]]',
  });

  console.log('\n— Program & tracked entity —');
  check('WITH_REGISTRATION', prog.programType === 'WITH_REGISTRATION');
  check('TET is Pregnant Woman', ci(prog.trackedEntityType?.name) === 'pregnant woman', prog.trackedEntityType);
  const pteas = prog.programTrackedEntityAttributes || [];
  check('15 tracked entity attributes', pteas.length === 15, pteas.length);
  const teas = pteas.map(p => p.trackedEntityAttribute);
  check('an auto-generated unique client ID attribute', teas.some(a => a.generated && a.unique));
  check('≥2 PHONE_NUMBER attributes', teas.filter(a => a.valueType === 'PHONE_NUMBER').length >= 2, teas.map(a => a.valueType));
  check('a COORDINATE attribute', teas.some(a => a.valueType === 'COORDINATE'));
  check('a LONG_TEXT address attribute', teas.some(a => a.valueType === 'LONG_TEXT'));
  check('≥2 searchable attributes', pteas.filter(p => p.searchable).length >= 2);
  check('≥2 attributes displayed in lists', pteas.filter(p => p.displayInList).length >= 2);

  console.log('\n— Stages —');
  const stages = (prog.programStages || []).sort((a, b) => a.sortOrder - b.sortOrder);
  check('5 stages', stages.length === 5, stages.map(s => s.name));
  const repeatPattern = stages.map(s => !!s.repeatable).join(',');
  check('repeatable pattern reg,anc,lab,delivery,pnc = false,true,true,false,true', repeatPattern === 'false,true,true,false,true', repeatPattern);
  stages.forEach((s, i) => {
    check(`stage ${i + 1} "${s.name}": 20 DEs`, (s.programStageDataElements || []).length === 20, (s.programStageDataElements || []).length);
    check(`stage ${i + 1} has form sections`, (s.programStageSections || 0) >= 2, s.programStageSections);
  });

  const allDes = stages.flatMap(s => (s.programStageDataElements || []).map(p => p.dataElement));
  console.log('\n— Data element requirements —');
  check('an ORGANISATION_UNIT delivery facility DE', allDes.some(d => d.valueType === 'ORGANISATION_UNIT'));
  check('≥2 DATETIME DEs (admission/delivery/contact)', allDes.filter(d => d.valueType === 'DATETIME').length >= 2);
  check('option-set DEs present (≥15)', allDes.filter(d => d.optionSet).length >= 15, allDes.filter(d => d.optionSet).length);
  const distinctIds = new Set(allDes.map(d => d.id));
  check('shared DEs reused across stages (distinct < 100)', distinctIds.size < 100, distinctIds.size);
  const urine = allDes.filter(d => /urine/i.test(d.name));
  check('urine protein uses ONE option set in both stages', urine.length >= 2 && new Set(urine.map(d => d.optionSet?.id)).size === 1, urine.map(d => d.optionSet?.id));

  console.log('\n— Program rules —');
  const rules = await t('dhis2_query', { path: `programRules?filter=program.id:eq:${pid}&fields=id,name,condition,programRuleActions[programRuleActionType,content,data,dataElement[name]]&pageSize=300` });
  const ruleList = rules?.programRules || [];
  const actions = ruleList.flatMap(r => (r.programRuleActions || []).map(a => ({ ...a, rule: r.name, cond: r.condition })));
  check('≥40 program rules', ruleList.length >= 40, ruleList.length);
  check('HIDEFIELD rules (≥10)', actions.filter(a => a.programRuleActionType === 'HIDEFIELD').length >= 10);
  check('ASSIGN rules (due date / GA / risk / timing)', actions.filter(a => a.programRuleActionType === 'ASSIGN').length >= 4);
  check('completion blocks (ERRORONCOMPLETE/SHOWERROR ≥3)', actions.filter(a => /ERRORONCOMPLETE|SHOWERROR/.test(a.programRuleActionType)).length >= 3);
  check('warnings (≥10)', actions.filter(a => /SHOWWARNING|WARNINGONCOMPLETE/.test(a.programRuleActionType)).length >= 10);
  check('mandatory-field rules (≥4)', actions.filter(a => a.programRuleActionType === 'SETMANDATORYFIELD').length >= 4);
  check('feedback-widget displays (DISPLAYTEXT/DISPLAYKEYVALUEPAIR ≥5)', actions.filter(a => /DISPLAY/.test(a.programRuleActionType)).length >= 5);
  check('a risk-classification ASSIGN exists', actions.some(a => a.programRuleActionType === 'ASSIGN' && /risk/i.test(a.dataElement?.name || '')));
  check('a BMI feedback exists', actions.some(a => /DISPLAY/.test(a.programRuleActionType) && /bmi/i.test((a.content || '') + (a.data || ''))));
  check('a pre-eclampsia warning exists', ruleList.some(r => /pre.?eclampsia/i.test(r.name + JSON.stringify(r.programRuleActions || []))));
  check('an anaemia warning exists', ruleList.some(r => /an(a)?emia|haemoglobin|hemoglobin/i.test(r.name + JSON.stringify(r.programRuleActions || []))));
  check('an Apgar rule exists', ruleList.some(r => /apgar/i.test(r.name + r.condition)));
  check('a BCG rule exists', ruleList.some(r => /bcg/i.test(r.name + r.condition)));

  // Every #{var} resolves
  const prvs = await t('dhis2_query', { path: `programRuleVariables?filter=program.id:eq:${pid}&fields=id,name&pageSize=400` });
  const prvNames = new Set((prvs?.programRuleVariables || []).map(v => v.name));
  const unresolved = [];
  for (const r of ruleList) {
    for (const ref of (String(r.condition || '').match(/#\{([^}]+)\}/g) || [])) {
      const v = ref.slice(2, -1);
      if (!prvNames.has(v)) unresolved.push(`${r.name}: #{${v}}`);
    }
  }
  check('every #{variable} resolves to a PRV', unresolved.length === 0, unresolved.slice(0, 5));

  console.log('\n— Rule audit —');
  const audit = await t('manage_program_rules', { action: 'audit', program_id: pid });
  check('no cross-rule contradictions', (audit?.cross_rule_issues || []).length === 0, (audit?.cross_rule_issues || []).slice(0, 3));

  const { total, failed } = summarize();
  console.log(`\nAPI calls: ${total}, failed: ${failed.length}`);
  console.log(failures ? `\nRESULT: FAIL (${failures})` : '\nRESULT: PASS');
  process.exit(failures || failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
