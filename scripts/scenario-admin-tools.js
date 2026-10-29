#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-admin-tools.js — live deep test of the administration tools
 * (src/tools-admin.js) and the fixes shipped with them, against a LIVE DHIS2
 * (default http://localhost:8081, see live-harness.js env).
 *
 * The package a district HMIS officer would set up, end to end, through the
 * REAL executeTool pipeline:
 *   A. aggregate form: category combo → disaggregated DEs → dataset → a
 *      validation rule; then manage_data_values set / get / overwrite (undo
 *      record) / complete / incomplete / validate / delete / clear-all, plus
 *      every silent-wrong-data case refused client-side (wrong period type,
 *      unassigned org unit, missing disaggregation, bad option, negative value,
 *      not-yet-open period) and the hardened raw dataValueSets import;
 *   B. metadata translations: merge across locales, bulk items, remove, bad
 *      locale / property refused, raw PUT blocked;
 *   C. users: role with validated authorities (garbage refused), group, user
 *      with generated password + group membership, policy / duplicate refusals,
 *      update (roles, org units, groups, password), disable / enable, the raw
 *      POST /users and PATCH /userGroups guards, PATCH schema pre-check;
 *   D. rule-action key aliases (data_element / dataElement:{…} / field) bind;
 *   E. indicator type "Per cent" resolves to the instance's factor-100 type;
 *   F. full cleanup — the instance is left exactly as found.
 *
 * PASS = every assertion holds AND zero failed API calls outside the two
 * deliberately-provoked server rejections (marked EXPECTED below).
 * ───────────────────────────────────────────────────────────────────────────── */
const { load, API, summarize } = require('./live-harness');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const show = (r) => JSON.stringify(r === undefined ? null : r).slice(0, 400);
const expectedFailIdx = new Set();

function prevMonthId(offset = 1) {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - offset);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

(async () => {
  const ctx = load({ appType: 'Maintenance' });
  const t = (name, args) => ctx.executeTool(name, args);
  const raw = (path, method = 'GET', body) => ctx.safeDhis2Fetch(path, { method, ...(body ? { body } : {}) });
  const tag = Date.now().toString(36).slice(-5);
  const C = { cc: null, cats: [], opts: [], des: [], ds: null, vr: null, role: null, group: null, user: null, prog: null, ind: null };
  // Backups the tools auto-create are test artifacts too — remember what existed.
  const BACKUP_NS = 'dhis2-ai-extension-backups';
  const backupsBefore = new Set(await raw(`dataStore/${BACKUP_NS}`).then(k => Array.isArray(k) ? k : []).catch(() => []));

  try {
    // Two leaf org units: OU1 gets the dataset, OU2 does not.
    const ous = await raw('organisationUnits?filter=children:empty&fields=id,displayName&pageSize=2&order=displayName:asc');
    const [OU1, OU2] = ous.organisationUnits || [];
    check('found two leaf org units', OU1 && OU2, show(ous));

    // ── A. Aggregate form ────────────────────────────────────────────────
    console.log('\nA. Aggregate form + manage_data_values');
    let r = await t('create_metadata', { action: 'create_category_combo', category_combo: { name: `ZZ AT Sex ${tag}`, categories: [{ name: `ZZ AT Sex cat ${tag}`, options: [`ZZ Male ${tag}`, `ZZ Female ${tag}`] }] } });
    check('category combo created', r.success, show(r));
    C.cc = r.summary?.categoryCombo?.id; C.cats = (r.summary?.new_categories || []).map(c => c.id); C.opts = (r.summary?.new_options || []).map(o => o.id);
    r = await t('create_metadata', { action: 'create_data_elements', domain_type: 'AGGREGATE', category_combo_id: C.cc, data_elements: [
      { name: `ZZ AT Malaria cases ${tag}`, value_type: 'INTEGER_ZERO_OR_POSITIVE', use_category_combo: true },
      { name: `ZZ AT Malaria tests ${tag}`, value_type: 'INTEGER_ZERO_OR_POSITIVE', use_default_combo: true },
      { name: `ZZ AT Stock status ${tag}`, value_type: 'TEXT', use_default_combo: true, option_set: { name: `ZZ AT Stock ${tag}`, options: ['Adequate', 'Low', 'Stock out'] } },
      { name: `ZZ AT Supervision done ${tag}`, value_type: 'BOOLEAN', use_default_combo: true },
    ] });
    check('4 aggregate data elements created', r.success && (r.summary?.dataElements || []).length === 4, show(r));
    C.des = (r.summary?.dataElements || []).map(d => d.id);
    C.optionSets = (r.summary?.optionSets || []).map(o => o.id);
    const [DE_CASES, DE_TESTS] = C.des;
    r = await t('manage_datasets', { action: 'create', dataset_name: `ZZ AT Malaria Monthly ${tag}`, period_type: 'Monthly', data_element_ids: C.des, org_unit_ids: [OU1.id] });
    check('dataset created (assigned to OU1 only)', r.success && r.dataset_id, show(r));
    C.ds = r.dataset_id;
    r = await t('manage_datasets', { action: 'get', dataset_name: `ZZ AT Malaria Monthly ${tag}` });
    check('manage_datasets(get) accepts the dataset NAME', r && !r._error && (r.id === C.ds || r.dataset?.id === C.ds || JSON.stringify(r).includes(C.ds)), show(r));
    r = await t('manage_validation_rules', { action: 'create', rule: { name: `ZZ AT tests >= cases ${tag}`, operator: 'greater_than_or_equal_to', period_type: 'Monthly', left_expression: `#{${DE_TESTS}}`, right_expression: `#{${DE_CASES}}`, importance: 'HIGH' } });
    check('validation rule created', r.success && r.rule_id, show(r));
    C.vr = r.rule_id;
    // The new validation rule must belong to the dataset's DEs — DHIS2 links it automatically by expression.

    const pe = prevMonthId(1);
    const friendly = `${MONTH_NAMES[Number(pe.slice(4)) - 1]} ${pe.slice(0, 4)}`;
    const dsName = `ZZ AT Malaria Monthly ${tag}`;
    r = await t('manage_data_values', { action: 'set', dataset_id: dsName, period: friendly, org_unit_id: OU1.displayName, values: [
      { data_element: `ZZ AT Malaria cases ${tag}`, category_option_combo: `ZZ Male ${tag}`, value: '7' },
      { data_element: `zz at malaria cases ${tag}`, category_option_combo: [`ZZ Female ${tag}`], value: 9 },
      { data_element: `ZZ AT Malaria tests ${tag}`, value: '12' },
      { data_element: `ZZ AT Stock status ${tag}`, value: 'Low' },
      { data_element: `ZZ AT Supervision done ${tag}`, value: 'yes' },
    ] });
    check(`set 5 values by NAME with friendly period "${friendly}"`, r.success && r.period === pe && r.import_count?.imported === 5, show(r));

    r = await t('manage_data_values', { action: 'get', dataset_id: C.ds, period: pe, org_unit_id: OU1.id });
    const stock = (r.values || []).find(v => v.data_element.startsWith('ZZ AT Stock'));
    check('get returns 5 named values (option NAME stored as its code)', r.success && r.filled_cells === 5 && stock && stock.value !== 'Low' && r.total_cells === 5, show(r));

    // Refusals that must NOT reach the server.
    const before = API.length;
    const refusals = [
      ['missing disaggregation', { values: [{ data_element: DE_CASES, value: '3' }] }],
      ['bad option', { values: [{ data_element: `ZZ AT Stock status ${tag}`, value: 'Plenty' }] }],
      ['negative into ≥0', { values: [{ data_element: DE_TESTS, value: '-2' }] }],
      ['DE not in dataset', { values: [{ data_element: 'Definitely not a data element', value: '1' }] }],
    ];
    for (const [label, extra] of refusals) {
      r = await t('manage_data_values', { action: 'set', dataset_id: C.ds, period: pe, org_unit_id: OU1.id, ...extra });
      check(`refused before sending: ${label}`, r._error && Array.isArray(r.problems), show(r));
    }
    r = await t('manage_data_values', { action: 'set', dataset_id: C.ds, period: pe, org_unit_id: OU2.id, values: [{ data_element: DE_TESTS, value: '1' }] });
    check('refused: org unit not assigned to dataset', r._error && /not assigned/.test(r._error), show(r));
    r = await t('manage_data_values', { action: 'set', dataset_id: C.ds, period: `${pe.slice(0, 4)}W3`, org_unit_id: OU1.id, values: [{ data_element: DE_TESTS, value: '1' }] });
    check('refused: weekly period on a monthly dataset', r._error && /not a Monthly period/.test(r._error), show(r));
    r = await t('manage_data_values', { action: 'set', dataset_id: C.ds, period: prevMonthId(0), org_unit_id: OU1.id, values: [{ data_element: DE_TESTS, value: '1' }] });
    check('refused: current month not open (openFuturePeriods=0)', r._error && /not open/.test(r._error), show(r));
    check('none of the refusals produced a failed API call', summarize(before).failed.length === 0, show(summarize(before).failed));

    r = await t('manage_data_values', { action: 'set', dataset_id: C.ds, period: pe, org_unit_id: OU1.id, values: [{ data_element: DE_CASES, category_option_combo: `ZZ Female ${tag}`, value: '15' }] });
    check('overwrite returns previous value as undo record', r.success && r.import_count?.updated === 1 && r.previous_values?.[0]?.value === '9', show(r));

    r = await t('manage_data_values', { action: 'validate', dataset_id: C.ds, period: pe, org_unit_id: OU1.id });
    check('validate: tests(12) < cases → one violation', r.success && r.violation_count === 1, show(r));

    r = await t('manage_data_values', { action: 'complete', dataset_id: C.ds, period: pe, org_unit_id: OU1.id });
    check('complete', r.success && r.completed === true, show(r));
    r = await t('manage_data_values', { action: 'get', dataset_id: C.ds, period: pe, org_unit_id: OU1.id });
    check('get shows completed', r.completed === true, show(r));
    r = await t('manage_data_values', { action: 'incomplete', dataset_id: C.ds, period: pe, org_unit_id: OU1.id });
    check('incomplete', r.success && r.completed === false, show(r));

    r = await t('manage_data_values', { action: 'delete', dataset_id: C.ds, period: pe, org_unit_id: OU1.id, values: [{ data_element: DE_TESTS }] });
    check('delete one value', r.success && r.import_count?.deleted === 1 && r.previous_values?.[0]?.value === '12', show(r));
    r = await t('manage_data_values', { action: 'delete', dataset_id: C.ds, period: pe, org_unit_id: OU1.id, all: true });
    check('delete all without confirm_all is refused', r._error && Array.isArray(r.values_that_would_be_deleted), show(r));

    // Raw import through dhis2_query is hardened with strict* flags: the
    // wrong-period cell is now REJECTED instead of silently stored.
    const rawIdx = API.length;
    r = await t('dhis2_query', { path: 'dataValueSets', method: 'POST', body: { dataValues: [
      { dataElement: DE_TESTS, period: pe, orgUnit: OU1.id, value: '4' },
      { dataElement: DE_TESTS, period: `${pe.slice(0, 4)}W3`, orgUnit: OU1.id, value: '4' },
    ] } });
    for (let i = rawIdx; i < API.length; i++) if (/dataValueSets/.test(API[i].url)) expectedFailIdx.add(i); // EXPECTED 409 (partial import)
    check('raw dataValueSets import: strict flags added, partial import reported', r.partial === true && r.import_count?.imported === 1 && r.conflicts?.length === 1 && API.slice(rawIdx).some(a => /strictPeriods=true/.test(a.url)), show(r));

    r = await t('manage_data_values', { action: 'delete', dataset_id: C.ds, period: pe, org_unit_id: OU1.id, all: true, confirm_all: true });
    check('clear whole form with confirm_all', r.success && r.deleted >= 4, JSON.stringify(r).slice(0, 1500));

    // ── B. Metadata translations ─────────────────────────────────────────
    console.log('\nB. manage_metadata_translations');
    r = await t('manage_metadata_translations', { action: 'list_locales' });
    const hasFr = (r.locales || []).some(l => l.locale === 'fr'), hasAr = (r.locales || []).some(l => l.locale === 'ar');
    check('list_locales (fr + ar configured)', r.success && hasFr && hasAr, show(r));
    r = await t('manage_metadata_translations', { action: 'set', object_type: 'data element', object_id: DE_CASES, locale: 'fr-FR'.slice(0, 2), translations: { name: `ZZ AT Cas de paludisme ${tag}`, FORM_NAME: 'Cas de paludisme' } });
    check('set fr NAME + FORM_NAME (field-name key accepted)', r.success && r.verified?.display_name_in_locale === `ZZ AT Cas de paludisme ${tag}`, show(r));
    r = await t('manage_metadata_translations', { action: 'set', object_type: 'dataElements', object_id: DE_CASES, locale: 'Arabic', translations: { NAME: `ZZ AT حالات الملاريا ${tag}` } });
    check('set ar NAME (locale by language name)', r.success && r.locale === 'ar', show(r));
    r = await t('manage_metadata_translations', { action: 'get', object_type: 'dataElements', object_id: DE_CASES });
    const tr = r.objects?.[0]?.translations || {};
    check('MERGE: fr survived the ar write', tr.fr?.NAME && tr.fr?.FORM_NAME && tr.ar?.NAME, show(r));
    const b2 = API.length;
    r = await t('manage_metadata_translations', { action: 'set', object_type: 'dataElements', object_id: DE_CASES, locale: 'xx_YY', translations: { NAME: 'x' } });
    check('unknown locale refused', r._error && Array.isArray(r.available_locales), show(r));
    r = await t('manage_metadata_translations', { action: 'set', object_type: 'dataElements', object_id: DE_CASES, locale: 'fr', translations: { BOGUS: 'x' } });
    check('unknown property refused', r._error && r.problems?.[0]?.valid_properties, show(r));
    r = await t('dhis2_query', { path: `dataElements/${DE_CASES}/translations`, method: 'PUT', body: { translations: [] } });
    check('raw PUT translations blocked', r._error && r._redirect === 'manage_metadata_translations', show(r));
    check('translation refusals made no failed API call', summarize(b2).failed.length === 0, show(summarize(b2).failed));
    r = await t('manage_metadata_translations', { action: 'set', locale: 'fr', items: [
      { object_type: 'dataElements', object_id: DE_TESTS, translations: { NAME: `ZZ AT Tests paludisme ${tag}` } },
      { object_type: 'dataSets', object_id: C.ds, translations: { NAME: `ZZ AT Paludisme mensuel ${tag}` } },
    ] });
    check('bulk items (DE + dataset) in one call', r.success && r.objects_changed === 2, show(r));
    r = await t('manage_metadata_translations', { action: 'remove', object_type: 'dataElements', object_id: DE_CASES, locale: 'ar' });
    check('remove ar only', r.success && r.results?.[0]?.removed === 1, show(r));
    r = await t('manage_metadata_translations', { action: 'get', object_type: 'dataElements', object_id: DE_CASES });
    check('fr still present after removing ar', r.objects?.[0]?.translations?.fr?.NAME && !r.objects?.[0]?.translations?.ar, show(r));

    // ── C. Users / roles / groups ────────────────────────────────────────
    console.log('\nC. manage_users');
    r = await t('manage_users', { action: 'list_authorities', query: 'data value' });
    check('list_authorities finds data-value authorities', r.success && (r.authorities || []).some(a => a.id === 'F_DATAVALUE_ADD'), show(r));
    const b3 = API.length;
    r = await t('manage_users', { action: 'create_role', name: `ZZ AT Clerk ${tag}`, authorities: ['Add data value', 'F_DATAVALUE_ADDD'] });
    check('garbage authority refused with suggestion', r._error && (r.did_you_mean?.F_DATAVALUE_ADDD || []).includes('F_DATAVALUE_ADD'), show(r));
    r = await t('manage_users', { action: 'create_role', name: `ZZ AT Clerk ${tag}`, authorities: ['Add data value', 'F_DATAELEMENT_DELETE', 'Aggregate data entry'] });
    check('role created (human name + id + app-name authorities)', r.success && r.authorities?.length === 3 && r.authorities.some(a => a.id === 'M_dhis-web-aggregate-data-entry') && r.authorities.some(a => a.id === 'F_DATAVALUE_ADD'), show(r));
    C.role = r.role_id;
    r = await t('manage_users', { action: 'create_group', name: `ZZ AT Clerks ${tag}` });
    check('group created', r.success && r.group_id, show(r));
    C.group = r.group_id;
    const uname = `zz.at.${tag}`;
    r = await t('manage_users', { action: 'create', username: uname, first_name: 'Zz', surname: 'Clerk', roles: [`ZZ AT Clerk ${tag}`] });
    check('create without password → asks for one', r._error && /password/i.test(r._error), show(r));
    r = await t('manage_users', { action: 'create', username: uname, first_name: 'Zz', surname: 'Clerk', roles: [C.role], password: 'password1' });
    check('weak password refused client-side', r._error && /policy/.test(r._error), show(r));
    r = await t('manage_users', { action: 'create', userCredentials: { username: uname, userRoles: [{ id: C.role }] }, first_name: 'Zz', surname: 'Clerk', generate_password: true, org_units: [OU1.displayName], groups: [`ZZ AT Clerks ${tag}`] });
    check('create (legacy userCredentials healed, generated password, OU + group by name)', r.success && r.user_id && r.initial_password && r.groups?.length === 1, show(r));
    C.user = r.user_id;
    const pw = r.initial_password;
    r = await t('manage_users', { action: 'create', username: uname, first_name: 'A', surname: 'B', roles: [C.role], generate_password: true });
    check('duplicate username refused', r._error && /already exists/.test(r._error), show(r));
    check('user refusals made no failed API call', summarize(b3).failed.length === 0, show(summarize(b3).failed));
    r = await raw(`userGroups/${C.group}?fields=users[id]`);
    check('group membership really landed', (r.users || []).some(u => u.id === C.user), show(r));
    r = await t('manage_users', { action: 'update', user_id: uname, add_org_units: [OU2.id], data_view_org_units: [OU1.id], remove_groups: [C.group], email: 'zz.clerk@example.org' });
    check('update: add OU, data-view OU, leave group, email', r.success && r.backup && (r.applied?.groups || [])[0]?.change === 'removed', show(r));
    r = await t('manage_users', { action: 'get', user_id: C.user });
    check('get reflects update', r.success && r.user.capture_org_unit_ids?.length === 2 && r.user.groups.length === 0 && r.user.email === 'zz.clerk@example.org', show(r));
    r = await t('manage_users', { action: 'update', user_id: C.user, add_groups: [`ZZ AT Clerks ${tag}`], password: `${pw}x` });
    check('update: rejoin group + password change', r.success && r.applied?.password, show(r));
    r = await t('manage_users', { action: 'disable', user_id: C.user });
    check('disable', r.success && r.applied?.disabled === true, show(r));
    r = await t('manage_users', { action: 'list', query: uname, disabled: true });
    check('list filter disabled=true finds the user', r.success && r.users?.[0]?.username === uname && r.users[0].disabled, show(r));
    r = await t('manage_users', { action: 'enable', user_id: C.user });
    check('enable', r.success && r.applied?.disabled === false, show(r));
    r = await t('manage_users', { action: 'update_role', role_id: C.role, add_authorities: ['Capture'], remove_authorities: ['F_DATAELEMENT_DELETE'] });
    check('update_role add app + remove authority', r.success && r.applied?.added?.includes('M_dhis-web-capture') && r.applied?.removed?.includes('F_DATAELEMENT_DELETE'), show(r));
    r = await t('manage_users', { action: 'delete_role', role_id: C.role });
    check('delete_role refused while assigned', r._error && /still assigned/.test(r._error), show(r));
    const b4 = API.length;
    r = await t('dhis2_query', { path: 'users', method: 'POST', body: { userCredentials: { username: 'x' } } });
    check('raw POST /users blocked', r._redirect === 'manage_users', show(r));
    r = await t('dhis2_query', { path: `users/${C.user}`, method: 'PATCH', body: [{ op: 'replace', path: '/userGroups', value: [] }] });
    check('raw PATCH users /userGroups blocked', r._redirect === 'manage_users', show(r));
    r = await t('dhis2_query', { path: `userRoles/${C.role}`, method: 'PUT', body: { name: 'x', authorities: ['BOGUS'] } });
    check('raw role authorities write blocked', r._redirect === 'manage_users', show(r));
    r = await t('dhis2_query', { path: `dataSets/${C.ds}`, method: 'PATCH', body: { openFuturePeriod: 2 } });
    check('PATCH unknown property refused with did_you_mean', r._error && (r.did_you_mean?.openFuturePeriod || []).includes('openFuturePeriods'), show(r));
    r = await t('dhis2_query', { path: `dataSets/${C.ds}`, method: 'PATCH', body: { periodType: 'Monthlyy' } });
    check('PATCH invalid enum refused with allowed values', r._error && (r.allowed_values?.periodType || []).includes('Monthly'), show(r));
    check('dhis2_query guards made no failed API call', summarize(b4).failed.length === 0, show(summarize(b4).failed));
    r = await t('dhis2_query', { path: `dataSets/${C.ds}`, method: 'PATCH', body: { openFuturePeriods: 1 } });
    check('valid PATCH passes the pre-check', !r._error, show(r));

    // ── D. Rule-action key aliases ──────────────────────────────────────
    console.log('\nD. Rule-action aliases');
    r = await t('create_metadata', { action: 'create_program', program_name: `ZZ AT Alias Event ${tag}`, program_type: 'WITHOUT_REGISTRATION', org_unit_ids: [OU1.id],
      stages: [{ name: `ZZ AT Inspection ${tag}`, data_elements: [
        { name: `ZZ AT Chlorine ${tag}`, value_type: 'NUMBER' },
        { name: `ZZ AT Sample taken ${tag}`, value_type: 'BOOLEAN' },
        { name: `ZZ AT Sample ID ${tag}`, value_type: 'TEXT' } ] }],
      program_rules: [
        { name: `ZZ AT hide sample id ${tag}`, condition: `!d2:hasValue(#{ZZ AT Sample taken ${tag}}) || #{ZZ AT Sample taken ${tag}} != true`, actions: [{ type: 'HIDEFIELD', data_element: `ZZ AT Sample ID ${tag}` }] },
        { name: `ZZ AT low chlorine ${tag}`, condition: `#{ZZ AT Chlorine ${tag}} < 0.2`, actions: [{ action_type: 'SHOWWARNING', dataElement: { name: `ZZ AT Chlorine ${tag}` }, message: 'Chlorine below 0.2 mg/L' }] },
      ] });
    check('program created, no rule skipped', r.success && !(r._skipped_rules || []).length, show(r));
    C.prog = r.program_id || r.summary?.program?.id || (r.created || {}).program_id;
    if (!C.prog) { const s = await raw(`programs?filter=name:eq:${encodeURIComponent(`ZZ AT Alias Event ${tag}`)}&fields=id`); C.prog = s.programs?.[0]?.id; }
    r = await raw(`programRules?filter=program.id:eq:${C.prog}&fields=name,programRuleActions[programRuleActionType,content,dataElement[id]]&paging=false`);
    const acts = (r.programRules || []).flatMap(x => x.programRuleActions || []);
    check('both actions are bound to their data element', acts.length === 2 && acts.every(a => a.dataElement?.id), show(r));
    check('message alias became the warning content', acts.some(a => a.content === 'Chlorine below 0.2 mg/L'), show(acts));

    // ── E. Indicator type by factor ──────────────────────────────────────
    console.log('\nE. Indicator type resolution');
    r = await t('manage_indicators', { action: 'create', indicator: { name: `ZZ AT Positivity ${tag}`, indicator_type: 'Per cent', numerator: `#{${DE_CASES}}`, denominator: `#{${DE_TESTS}}`, decimals: 1 } });
    check('"Per cent" resolves to the instance factor-100 type', r.success && r.indicator?.factor === 100, show(r));
    C.ind = r.indicator_id;
  } catch (e) {
    failures++;
    console.log('  ✗ scenario threw:', e && e.stack || e);
  } finally {
    // ── F. Cleanup ───────────────────────────────────────────────────────
    console.log('\nF. Cleanup');
    const cleanupStart = API.length;
    const del = async (type, id) => { if (!id) return; const r = await raw(`${type}/${id}`, 'DELETE'); if (r?._error) console.log(`    cleanup ${type}/${id}: ${r._error}`); };
    try {
      if (C.user) await del('users', C.user);
      if (C.group) await del('userGroups', C.group);
      if (C.role) await del('userRoles', C.role);
      if (C.ind) await del('indicators', C.ind);
      if (C.prog) {
        const rules = await raw(`programRules?filter=program.id:eq:${C.prog}&fields=id&paging=false`);
        for (const x of (rules.programRules || [])) await del('programRules', x.id);
        const prvs = await raw(`programRuleVariables?filter=program.id:eq:${C.prog}&fields=id&paging=false`);
        for (const x of (prvs.programRuleVariables || [])) await del('programRuleVariables', x.id);
        const p = await raw(`programs/${C.prog}?fields=programStages[id,programStageDataElements[dataElement[id]]]`);
        const pdes = (p.programStages || []).flatMap(s => (s.programStageDataElements || []).map(x => x.dataElement.id));
        await del('programs', C.prog);
        for (const d of pdes) await del('dataElements', d);
      }
      if (C.vr) await del('validationRules', C.vr);
      // DELETE dataSets/{id} can 500 on 2.42 (Hibernate "could not initialize
      // proxy … no Session" after the dataset's DEs had option sets); the
      // metadata importer deletes the same object cleanly.
      // The 500 is a server bug the transport now verifies away; mark it EXPECTED.
      if (C.ds) {
        const at = API.length;
        const r = await t('manage_datasets', { action: 'delete', dataset_id: C.ds });
        for (let i = at; i < API.length; i++) if (API[i].status === 500 || (API[i].status === 404 && API[i].method === 'GET')) expectedFailIdx.add(i); // server bug + its 404 verification probe
        check('manage_datasets delete reports success despite the post-commit 500', r.success, show(r));
      }
      for (const d of C.des) {
        await raw(`maintenance/dataPruning/dataElements/${d}`, 'POST'); // audits of the test values block deletion
        await del('dataElements', d);
      }
      for (const o of (C.optionSets || [])) await del('optionSets', o); // options cascade
      if (C.cc) await del('categoryCombos', C.cc);
      for (const c of C.cats) await del('categories', c);
      for (const o of C.opts) await del('categoryOptions', o);
      const after = await raw(`dataStore/${BACKUP_NS}`);
      for (const k of (Array.isArray(after) ? after : [])) if (!backupsBefore.has(k)) await raw(`dataStore/${BACKUP_NS}/${k}`, 'DELETE');
    } catch (e) { console.log('  cleanup threw:', e.message); }
    const leftovers = await raw(`dataElements?filter=name:like:ZZ AT&fields=id,name&paging=false`);
    const leftU = await raw(`users?query=zz.at.&fields=id`);
    check('no test data elements / users left behind', !(leftovers.dataElements || []).length && !(leftU.users || []).length, show({ leftovers, leftU }));
    const { failed } = summarize(0, cleanupStart);
    const unexpected = failed.filter(f => !expectedFailIdx.has(API.indexOf(f)));
    const cleanupFails = summarize(cleanupStart).failed.filter(f => !expectedFailIdx.has(API.indexOf(f)));
    console.log(`\n${API.length} API calls · ${expectedFailIdx.size} expected (provoked rejection / server post-commit bug + probe) · ${unexpected.length} unexpected failed · cleanup failed ${cleanupFails.length}`);
    for (const f of [...unexpected, ...cleanupFails]) console.log(`    ✗ ${f.method} ${f.url} → ${f.status}`);
    if (unexpected.length || cleanupFails.length) failures++;
    console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ ALL PASSED');
    process.exit(failures ? 1 : 0);
  }
})();
