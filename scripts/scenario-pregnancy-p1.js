#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenario-pregnancy-p1.js — the "Integrated Pregnancy, Delivery and Postnatal
 * Care Tracker" deep test (prompt 1) against a LIVE DHIS2 instance.
 *
 * Recreates, through the REAL executeTool pipeline, exactly the build a model
 * following the v2.8.16 incremental doctrine would produce:
 *   0. tracked entity type "Pregnant Woman" (created if missing)
 *   1. create_program: shell + 15 TEAs + Stage 1 (20 DEs, 4 sections), NO rules
 *   2. add_stage ×4: stages 2–5 (20 DEs each, sections, shared-DE reuse)
 *   3. add_program_rules in batches ≤15 — ~100 rules covering every prompt bullet
 *   4. structural verification (stages, sections, DEs, TEAs, rules, PRVs)
 *
 * PASS = every step succeeds AND zero failed API calls.
 * Leaves the program in place — prompts 2 and 3 build on it.
 * ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const { load, API, summarize } = require('./live-harness');

const STATE_FILE = process.env.P1_STATE || path.join(__dirname, '..', '.p1-state.json');

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
function show(r) { return JSON.stringify(r === undefined ? null : r).slice(0, 400); }

// ── Option set definitions (reused wherever the meaning is identical) ────────
const OS = {
  language:   { name: 'Preferred Language', options: ['Arabic', 'English', 'Other'] },
  marital:    { name: 'Marital Status', options: ['Single', 'Married', 'Separated or Divorced', 'Widowed', 'Unknown'] },
  education:  { name: 'Education Level', options: ['None', 'Primary', 'Secondary', 'Diploma or University', 'Unknown'] },
  chronic:    { name: 'Main Chronic Condition', options: ['Hypertension', 'Diabetes', 'Cardiac disease', 'Renal disease', 'Epilepsy', 'Thyroid disease', 'Asthma', 'Other'] },
  risk:       { name: 'Pregnancy Risk Classification', options: ['Low', 'Moderate', 'High', 'Critical'] },
  visitType:  { name: 'ANC Visit Type', options: ['Scheduled', 'Unscheduled', 'Emergency'] },
  dangerSign: { name: 'Pregnancy Danger Sign', options: ['Severe headache or visual symptoms', 'Vaginal bleeding', 'Convulsions', 'Severe abdominal pain', 'Fever', 'Leaking fluid', 'Reduced fetal movement', 'Breathing difficulty', 'Other'] },
  fetalMove:  { name: 'Fetal Movement Status', options: ['Not yet expected', 'Normal', 'Reduced', 'Absent', 'Unknown'] },
  oedema:     { name: 'Oedema Grade', options: ['None', 'Mild', 'Moderate', 'Severe'] },
  urineProt:  { name: 'Urine Protein Result', options: ['Negative', 'Trace', '1+', '2+', '3+', '4+'] },
  adherence:  { name: 'Supplement Adherence', options: ['Good', 'Partial', 'Poor', 'Not assessed'] },
  referDest:  { name: 'Referral Destination', options: ['Same-facility doctor', 'District hospital', 'Referral hospital', 'Emergency department', 'Other'] },
  bloodGroup: { name: 'Blood Group', options: ['A', 'B', 'AB', 'O', 'Unknown'] },
  rhesus:     { name: 'Rhesus Factor', options: ['Positive', 'Negative', 'Unknown'] },
  testResult: { name: 'Infection Test Result', options: ['Negative', 'Positive', 'Indeterminate'] },
  fetuses:    { name: 'Number of Fetuses', options: ['One', 'Two', 'Three or more', 'Unknown'] },
  placenta:   { name: 'Placenta Location', options: ['Normal', 'Low-lying', 'Placenta previa', 'Suspected abruption', 'Unknown'] },
  growth:     { name: 'Fetal Growth Assessment', options: ['Appropriate', 'Suspected growth restriction', 'Large for gestational age', 'Uncertain'] },
  labour:     { name: 'Labour Onset', options: ['Spontaneous', 'Induced', 'No labour'] },
  delivMode:  { name: 'Mode of Delivery', options: ['Spontaneous vaginal', 'Assisted vaginal', 'Planned caesarean section', 'Emergency caesarean section', 'Other'] },
  csIndic:    { name: 'Caesarean Section Indication', options: ['Previous scar', 'Fetal distress', 'Obstructed labour', 'Malpresentation', 'Placenta previa', 'Hypertensive disorder', 'Multiple pregnancy', 'Other'] },
  attendant:  { name: 'Main Birth Attendant', options: ['Midwife', 'Nurse', 'Doctor', 'Obstetrician', 'Other'] },
  matOutcome: { name: 'Maternal Outcome', options: ['Stable', 'Maternal complication', 'Referred', 'Maternal death'] },
  matCompl:   { name: 'Main Maternal Complication', options: ['Postpartum haemorrhage', 'Hypertensive emergency or eclampsia', 'Sepsis', 'Uterine rupture', 'Obstructed labour', 'Other'] },
  nbOutcome:  { name: 'Newborn Outcome', options: ['Live birth', 'Fresh stillbirth', 'Macerated stillbirth', 'Neonatal death before discharge'] },
  nbSex:      { name: 'Newborn Sex', options: ['Female', 'Male', 'Indeterminate'] },
  pncTiming:  { name: 'Postnatal Contact Timing', options: ['Within 24 hours', '48-72 hours', '7-14 days', 'Six weeks', 'Other'] },
  matDanger:  { name: 'Postnatal Maternal Danger Sign', options: ['Heavy bleeding', 'Fever', 'Severe headache or visual symptoms', 'Convulsion', 'Breathing difficulty', 'Severe abdominal pain', 'Foul discharge', 'Other'] },
  wound:      { name: 'Wound Status', options: ['Not applicable', 'Clean and healing', 'Redness or discharge', 'Wound separation', 'Severe pain'] },
  bfStatus:   { name: 'Breastfeeding Status', options: ['Exclusive', 'Mixed feeding', 'Replacement feeding', 'Not feeding', 'Unknown'] },
  bfProblem:  { name: 'Main Breastfeeding Problem', options: ['Poor latch', 'Breast or nipple pain', 'Engorgement', 'Low-supply concern', 'Mastitis signs', 'Other'] },
  nbDanger:   { name: 'Newborn Danger Sign', options: ['Poor feeding', 'Fever', 'Low temperature', 'Difficult breathing', 'Convulsion', 'Lethargy', 'Severe jaundice', 'Umbilical infection', 'Other'] },
  pncDest:    { name: 'Postnatal Referral Destination', options: ['Same-facility doctor', 'District hospital', 'Referral hospital', 'Emergency department', 'Neonatal unit', 'Other'] },
};

// ── Stage data-element definitions ───────────────────────────────────────────
const STAGE1_DES = [
  { name: 'Last menstrual period known', value_type: 'BOOLEAN', compulsory: true, description: 'Whether the woman knows the date of her last menstrual period.' },
  { name: 'Last menstrual period date', value_type: 'DATE' },
  { name: 'Estimated due date', value_type: 'DATE', description: 'Calculated from LMP when known, otherwise entered from ultrasound dating.' },
  { name: 'Gestational age at first contact in completed weeks', value_type: 'INTEGER_POSITIVE' },
  { name: 'Gravidity', value_type: 'INTEGER_ZERO_OR_POSITIVE', compulsory: true, description: 'Total number of pregnancies including this one.' },
  { name: 'Parity', value_type: 'INTEGER_ZERO_OR_POSITIVE', compulsory: true, description: 'Number of previous births at or beyond 28 weeks.' },
  { name: 'Previous pregnancy loss', value_type: 'BOOLEAN' },
  { name: 'Previous stillbirth or neonatal death', value_type: 'BOOLEAN' },
  { name: 'Previous caesarean section', value_type: 'BOOLEAN' },
  { name: 'Number of previous caesarean sections', value_type: 'INTEGER_ZERO_OR_POSITIVE' },
  { name: 'Chronic medical condition present', value_type: 'BOOLEAN' },
  { name: 'Main chronic condition', value_type: 'TEXT', option_set: OS.chronic },
  { name: 'Current medication', value_type: 'LONG_TEXT' },
  { name: 'Drug or food allergy present', value_type: 'BOOLEAN' },
  { name: 'Allergy details', value_type: 'LONG_TEXT' },
  { name: 'Height in centimetres', value_type: 'NUMBER', compulsory: true },
  { name: 'Weight in kilograms', value_type: 'NUMBER', compulsory: true },
  { name: 'Systolic blood pressure', value_type: 'INTEGER_POSITIVE', compulsory: true },
  { name: 'Diastolic blood pressure', value_type: 'INTEGER_POSITIVE', compulsory: true },
  { name: 'Pregnancy risk classification', value_type: 'TEXT', option_set: OS.risk, description: 'Automatically assigned from age, blood pressure, history and ultrasound findings.' },
];
const STAGE2_DES = [
  { name: 'ANC contact number', value_type: 'INTEGER_POSITIVE', compulsory: true, description: 'Sequential ANC contact number; the first ANC assessment is contact 1.' },
  { name: 'Visit type', value_type: 'TEXT', option_set: OS.visitType, compulsory: true },
  { name: 'Gestational age at this visit', value_type: 'INTEGER_POSITIVE' },
  { name: 'Current weight in kilograms', value_type: 'NUMBER' },
  { name: 'Systolic blood pressure', value_type: 'INTEGER_POSITIVE', compulsory: true },
  { name: 'Diastolic blood pressure', value_type: 'INTEGER_POSITIVE', compulsory: true },
  { name: 'Maternal temperature in degrees Celsius', value_type: 'NUMBER' },
  { name: 'Any pregnancy danger sign present', value_type: 'BOOLEAN' },
  { name: 'Main danger sign', value_type: 'TEXT', option_set: OS.dangerSign },
  { name: 'Fetal movement status', value_type: 'TEXT', option_set: OS.fetalMove },
  { name: 'Fetal heart rate', value_type: 'INTEGER_POSITIVE', description: 'Beats per minute; expected range 110-160.' },
  { name: 'Fundal height in centimetres', value_type: 'NUMBER' },
  { name: 'Oedema grade', value_type: 'TEXT', option_set: OS.oedema },
  { name: 'Urine protein result', value_type: 'TEXT', option_set: OS.urineProt },
  { name: 'Haemoglobin in g/dL', value_type: 'NUMBER' },
  { name: 'Iron and folic acid days supplied', value_type: 'INTEGER_ZERO_OR_POSITIVE' },
  { name: 'Supplement adherence', value_type: 'TEXT', option_set: OS.adherence },
  { name: 'Referral required', value_type: 'BOOLEAN' },
  { name: 'Referral destination', value_type: 'TEXT', option_set: OS.referDest },
  { name: 'Next ANC contact date', value_type: 'DATE', description: 'Auto-suggested from gestational age; adjust to the clinical plan.' },
];
const STAGE3_DES = [
  { name: 'Assessment date', value_type: 'DATE', compulsory: true },
  { name: 'Blood group', value_type: 'TEXT', option_set: OS.bloodGroup },
  { name: 'Rhesus factor', value_type: 'TEXT', option_set: OS.rhesus },
  { name: 'Haemoglobin in g/dL', value_type: 'NUMBER' },
  { name: 'Fasting blood glucose', value_type: 'NUMBER', description: 'mmol/L; pregnancy threshold 5.1.' },
  { name: 'Two-hour blood glucose', value_type: 'NUMBER', description: 'mmol/L; pregnancy threshold 8.5.' },
  { name: 'HIV test performed', value_type: 'BOOLEAN' },
  { name: 'HIV test result', value_type: 'TEXT', option_set: OS.testResult },
  { name: 'HIV care linkage recorded', value_type: 'BOOLEAN' },
  { name: 'Syphilis test performed', value_type: 'BOOLEAN' },
  { name: 'Syphilis test result', value_type: 'TEXT', option_set: OS.testResult },
  { name: 'Syphilis treatment started', value_type: 'BOOLEAN' },
  { name: 'Urine protein result', value_type: 'TEXT', option_set: OS.urineProt },
  { name: 'Ultrasound performed', value_type: 'BOOLEAN' },
  { name: 'Ultrasound date', value_type: 'DATE' },
  { name: 'Gestational age by ultrasound', value_type: 'INTEGER_POSITIVE' },
  { name: 'Number of fetuses', value_type: 'TEXT', option_set: OS.fetuses },
  { name: 'Placenta location', value_type: 'TEXT', option_set: OS.placenta },
  { name: 'Fetal growth assessment', value_type: 'TEXT', option_set: OS.growth },
  { name: 'Fetal anomaly suspected', value_type: 'BOOLEAN' },
];
const STAGE4_DES = [
  { name: 'Delivery facility', value_type: 'ORGANISATION_UNIT' },
  { name: 'Admission date and time', value_type: 'DATETIME' },
  { name: 'Delivery date and time', value_type: 'DATETIME', compulsory: true },
  { name: 'Gestational age at delivery', value_type: 'INTEGER_POSITIVE' },
  { name: 'Labour onset', value_type: 'TEXT', option_set: OS.labour },
  { name: 'Mode of delivery', value_type: 'TEXT', option_set: OS.delivMode, compulsory: true },
  { name: 'Caesarean section indication', value_type: 'TEXT', option_set: OS.csIndic },
  { name: 'Main birth attendant', value_type: 'TEXT', option_set: OS.attendant },
  { name: 'Maternal outcome', value_type: 'TEXT', option_set: OS.matOutcome },
  { name: 'Main maternal complication', value_type: 'TEXT', option_set: OS.matCompl },
  { name: 'Estimated blood loss in millilitres', value_type: 'INTEGER_ZERO_OR_POSITIVE' },
  { name: 'Postpartum haemorrhage recorded', value_type: 'BOOLEAN' },
  { name: 'Blood transfusion given', value_type: 'BOOLEAN' },
  { name: 'Number of babies delivered', value_type: 'INTEGER_POSITIVE', compulsory: true },
  { name: 'Newborn outcome', value_type: 'TEXT', option_set: OS.nbOutcome, compulsory: true },
  { name: 'Newborn sex', value_type: 'TEXT', option_set: OS.nbSex },
  { name: 'Birth weight in grams', value_type: 'INTEGER_POSITIVE' },
  { name: 'Five-minute Apgar score', value_type: 'INTEGER_ZERO_OR_POSITIVE', description: '0-10.' },
  { name: 'Newborn resuscitation required', value_type: 'BOOLEAN' },
  { name: 'Breastfeeding started within one hour', value_type: 'BOOLEAN' },
];
const STAGE5_DES = [
  { name: 'Postnatal contact timing', value_type: 'TEXT', option_set: OS.pncTiming, description: 'Automatically determined from the delivery and contact dates.' },
  { name: 'Contact date and time', value_type: 'DATETIME', compulsory: true },
  { name: 'Maternal temperature', value_type: 'NUMBER' },
  { name: 'Heavy or abnormal bleeding', value_type: 'BOOLEAN' },
  { name: 'Maternal danger sign present', value_type: 'BOOLEAN' },
  { name: 'Main maternal danger sign', value_type: 'TEXT', option_set: OS.matDanger },
  { name: 'Caesarean or perineal wound status', value_type: 'TEXT', option_set: OS.wound },
  { name: 'Maternal emotional wellbeing screening score', value_type: 'INTEGER_ZERO_OR_POSITIVE', description: '0-20; higher scores need mental-health assessment.' },
  { name: 'Family-planning counselling provided', value_type: 'BOOLEAN' },
  { name: 'Breastfeeding status', value_type: 'TEXT', option_set: OS.bfStatus },
  { name: 'Breastfeeding problem present', value_type: 'BOOLEAN' },
  { name: 'Main breastfeeding problem', value_type: 'TEXT', option_set: OS.bfProblem },
  { name: 'Current newborn weight in grams', value_type: 'INTEGER_POSITIVE' },
  { name: 'Newborn temperature', value_type: 'NUMBER' },
  { name: 'Jaundice present', value_type: 'BOOLEAN' },
  { name: 'Newborn danger sign present', value_type: 'BOOLEAN' },
  { name: 'Main newborn danger sign', value_type: 'TEXT', option_set: OS.nbDanger },
  { name: 'BCG vaccination given', value_type: 'BOOLEAN' },
  { name: 'Referral required', value_type: 'BOOLEAN' },
  { name: 'Postnatal referral destination', value_type: 'TEXT', option_set: OS.pncDest },
];

// ── Rule building blocks ─────────────────────────────────────────────────────
const CRIT_ATOM = "(d2:hasValue(#{systolic_blood_pressure}) && #{systolic_blood_pressure} >= 160) || (d2:hasValue(#{diastolic_blood_pressure}) && #{diastolic_blood_pressure} >= 110)";
const HIGH_ATOM = "#{previous_stillbirth_or_neonatal_death} == true || (d2:hasValue(#{number_of_previous_caesarean_sections}) && #{number_of_previous_caesarean_sections} >= 2) || (d2:hasValue(#{systolic_blood_pressure}) && #{systolic_blood_pressure} >= 140) || (d2:hasValue(#{diastolic_blood_pressure}) && #{diastolic_blood_pressure} >= 90) || #{number_of_fetuses} == 'TWO' || #{number_of_fetuses} == 'THREE_OR_MORE' || #{placenta_location} == 'PLACENTA_PREVIA' || #{fetal_growth_assessment} == 'SUSPECTED_GROWTH_RESTRICTION' || #{fetal_anomaly_suspected} == true";
const MOD_ATOM = "#{chronic_medical_condition_present} == true || #{previous_pregnancy_loss} == true || #{previous_caesarean_section} == true || (d2:hasValue(A{date_of_birth}) && (d2:yearsBetween(A{date_of_birth}, V{current_date}) < 18 || d2:yearsBetween(A{date_of_birth}, V{current_date}) >= 40))";
const URGENT_ANC_ATOM = "(" + CRIT_ATOM + ") || (d2:hasValue(#{haemoglobin_in_g_dl}) && #{haemoglobin_in_g_dl} < 7) || #{fetal_movement_status} == 'ABSENT' || (d2:hasValue(#{fetal_heart_rate}) && (#{fetal_heart_rate} < 110 || #{fetal_heart_rate} > 160)) || #{main_danger_sign} == 'VAGINAL_BLEEDING' || #{main_danger_sign} == 'CONVULSIONS'";

// Batch 1 — Stage 1 registration logic (dating, history, hides)
const RULES_S1A = [
  { name: 'Assign estimated due date from LMP',
    description: 'EDD = LMP + 280 days when the LMP is known.',
    condition: "#{last_menstrual_period_known} == true && d2:hasValue(#{last_menstrual_period_date})",
    actions: [{ type: 'ASSIGN', data_element_name: 'Estimated due date', data: "d2:addDays(#{last_menstrual_period_date}, 280)" }] },
  { name: 'Assign gestational age at first contact from LMP',
    condition: "#{last_menstrual_period_known} == true && d2:hasValue(#{last_menstrual_period_date})",
    actions: [{ type: 'ASSIGN', data_element_name: 'Gestational age at first contact in completed weeks', data: "d2:weeksBetween(#{last_menstrual_period_date}, V{event_date})" }] },
  { name: 'Hide LMP date when LMP is not known',
    condition: "!d2:hasValue(#{last_menstrual_period_known}) || #{last_menstrual_period_known} != true",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Last menstrual period date' }] },
  { name: 'Require ultrasound-based due date when LMP unknown',
    condition: "d2:hasValue(#{last_menstrual_period_known}) && #{last_menstrual_period_known} != true",
    actions: [{ type: 'SETMANDATORYFIELD', data_element_name: 'Estimated due date' }] },
  { name: 'Hide previous pregnancy history for a first pregnancy',
    condition: "d2:hasValue(#{gravidity}) && #{gravidity} <= 1",
    actions: [
      { type: 'HIDEFIELD', data_element_name: 'Previous pregnancy loss' },
      { type: 'HIDEFIELD', data_element_name: 'Previous stillbirth or neonatal death' },
      { type: 'HIDEFIELD', data_element_name: 'Previous caesarean section' },
    ] },
  { name: 'Hide number of previous caesarean sections when none',
    condition: "!d2:hasValue(#{previous_caesarean_section}) || #{previous_caesarean_section} != true",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Number of previous caesarean sections' }] },
  { name: 'Hide chronic condition details when no chronic condition',
    condition: "!d2:hasValue(#{chronic_medical_condition_present}) || #{chronic_medical_condition_present} != true",
    actions: [
      { type: 'HIDEFIELD', data_element_name: 'Main chronic condition' },
      { type: 'HIDEFIELD', data_element_name: 'Current medication' },
    ] },
  { name: 'Hide allergy details when no allergy reported',
    condition: "!d2:hasValue(#{drug_or_food_allergy_present}) || #{drug_or_food_allergy_present} != true",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Allergy details' }] },
  { name: 'Display allergy alert in feedback',
    condition: "#{drug_or_food_allergy_present} == true",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'ALLERGY ALERT', data: "d2:concatenate('Allergy reported: ', #{allergy_details})" }] },
  { name: 'Display BMI in feedback',
    condition: "d2:hasValue(#{height_in_centimetres}) && d2:hasValue(#{weight_in_kilograms}) && #{height_in_centimetres} > 0",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'BMI (kg/m2)', data: "#{weight_in_kilograms} / ((#{height_in_centimetres} / 100) * (#{height_in_centimetres} / 100))" }] },
  { name: 'Warn when maternal age is below 18',
    condition: "d2:hasValue(A{date_of_birth}) && d2:yearsBetween(A{date_of_birth}, V{current_date}) < 18",
    actions: [{ type: 'SHOWWARNING', content: 'Maternal age is below 18 years - adolescent pregnancy carries a higher risk. Follow the adolescent ANC protocol.' }] },
  { name: 'Warn when maternal age is 40 or above',
    condition: "d2:hasValue(A{date_of_birth}) && d2:yearsBetween(A{date_of_birth}, V{current_date}) >= 40",
    actions: [{ type: 'SHOWWARNING', content: 'Maternal age is 40 years or above - advanced maternal age increases pregnancy risk.' }] },
  { name: 'Warn for high blood pressure',
    condition: "(d2:hasValue(#{systolic_blood_pressure}) && #{systolic_blood_pressure} >= 140 && #{systolic_blood_pressure} < 160 && (!d2:hasValue(#{diastolic_blood_pressure}) || #{diastolic_blood_pressure} < 110)) || (d2:hasValue(#{diastolic_blood_pressure}) && #{diastolic_blood_pressure} >= 90 && #{diastolic_blood_pressure} < 110 && (!d2:hasValue(#{systolic_blood_pressure}) || #{systolic_blood_pressure} < 160))",
    actions: [{ type: 'SHOWWARNING', content: 'Blood pressure is 140/90 mmHg or higher - recheck after rest and assess for a hypertensive disorder of pregnancy.' }] },
  { name: 'Urgent warning for severe blood pressure',
    condition: CRIT_ATOM,
    actions: [{ type: 'SHOWWARNING', content: 'URGENT: severe hypertension (160 systolic or 110 diastolic or higher). Manage immediately and refer according to the emergency protocol.' }] },
];

// Batch 2 — Stage 1 validation blocks, risk assignment, feedback displays
const RULES_S1B = [
  { name: 'Block completion when parity exceeds gravidity',
    condition: "d2:hasValue(#{parity}) && d2:hasValue(#{gravidity}) && #{parity} > #{gravidity}",
    actions: [{ type: 'ERRORONCOMPLETE', content: 'Parity cannot be greater than gravidity - correct the obstetric history before completing.' }] },
  { name: 'Block completion for an impossible gestational age',
    condition: "d2:hasValue(#{last_menstrual_period_date}) && (d2:daysBetween(#{last_menstrual_period_date}, V{event_date}) < 0 || d2:daysBetween(#{last_menstrual_period_date}, V{event_date}) > 301)",
    actions: [{ type: 'ERRORONCOMPLETE', content: 'The recorded dates produce an impossible gestational age (negative or beyond 43 weeks). Check the LMP date and the visit date.' }] },
  { name: 'Assign Critical pregnancy risk classification',
    condition: CRIT_ATOM,
    actions: [{ type: 'ASSIGN', data_element_name: 'Pregnancy risk classification', data: "'CRITICAL'" }] },
  { name: 'Assign High pregnancy risk classification',
    condition: "!(" + CRIT_ATOM + ") && (" + HIGH_ATOM + ")",
    actions: [{ type: 'ASSIGN', data_element_name: 'Pregnancy risk classification', data: "'HIGH'" }] },
  { name: 'Assign Moderate pregnancy risk classification',
    condition: "!(" + CRIT_ATOM + ") && !(" + HIGH_ATOM + ") && (" + MOD_ATOM + ")",
    actions: [{ type: 'ASSIGN', data_element_name: 'Pregnancy risk classification', data: "'MODERATE'" }] },
  { name: 'Assign Low pregnancy risk classification',
    condition: "d2:hasValue(#{systolic_blood_pressure}) && d2:hasValue(#{diastolic_blood_pressure}) && !(" + CRIT_ATOM + ") && !(" + HIGH_ATOM + ") && !(" + MOD_ATOM + ")",
    actions: [{ type: 'ASSIGN', data_element_name: 'Pregnancy risk classification', data: "'LOW'" }] },
  { name: 'Display estimated due date in feedback',
    condition: "d2:hasValue(#{estimated_due_date})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Estimated due date', data: "#{estimated_due_date}" }] },
  { name: 'Display current gestational age in feedback',
    condition: "d2:hasValue(#{last_menstrual_period_date})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Gestational age (weeks)', data: "d2:weeksBetween(#{last_menstrual_period_date}, V{current_date})" }] },
  { name: 'Display risk classification in feedback',
    condition: "d2:hasValue(#{pregnancy_risk_classification})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Risk classification', data: "#{pregnancy_risk_classification}" }] },
];

// Batch 3 — Stage 2 ANC follow-up
const RULES_S2A = [
  { name: 'Assign visit gestational age from LMP',
    condition: "d2:hasValue(#{last_menstrual_period_date})",
    actions: [{ type: 'ASSIGN', data_element_name: 'Gestational age at this visit', data: "d2:weeksBetween(#{last_menstrual_period_date}, V{event_date})" }] },
  { name: 'Assign visit gestational age from ultrasound estimate',
    description: 'Fallback dating when no LMP: ultrasound GA plus the weeks elapsed since the ultrasound.',
    condition: "!d2:hasValue(#{last_menstrual_period_date}) && d2:hasValue(#{gestational_age_by_ultrasound}) && d2:hasValue(#{ultrasound_date})",
    actions: [{ type: 'ASSIGN', data_element_name: 'Gestational age at this visit', data: "#{gestational_age_by_ultrasound} + d2:weeksBetween(#{ultrasound_date}, V{event_date})" }] },
  { name: 'Hide main danger sign when no danger sign present',
    condition: "!d2:hasValue(#{any_pregnancy_danger_sign_present}) || #{any_pregnancy_danger_sign_present} != true",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Main danger sign' }] },
  { name: 'Hide ANC referral destination when no referral required',
    condition: "!d2:hasValue(#{referral_required}) || #{referral_required} != true",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Referral destination' }] },
  { name: 'Warn for suspected pre-eclampsia after 20 weeks',
    condition: "d2:hasValue(#{gestational_age_at_this_visit}) && #{gestational_age_at_this_visit} >= 20 && ((d2:hasValue(#{systolic_blood_pressure}) && #{systolic_blood_pressure} >= 140) || (d2:hasValue(#{diastolic_blood_pressure}) && #{diastolic_blood_pressure} >= 90)) && (#{urine_protein_result} == '2_POS' || #{urine_protein_result} == '3_POS' || #{urine_protein_result} == '4_POS' || #{main_danger_sign} == 'SEVERE_HEADACHE_OR_VISUAL_SYMPTOMS')",
    actions: [{ type: 'SHOWWARNING', content: 'Suspected pre-eclampsia: high blood pressure after 20 weeks with significant proteinuria or warning symptoms. Assess urgently and refer per protocol.' }] },
  { name: 'Warn for anaemia',
    condition: "d2:hasValue(#{haemoglobin_in_g_dl}) && #{haemoglobin_in_g_dl} < 11 && #{haemoglobin_in_g_dl} >= 7",
    actions: [{ type: 'SHOWWARNING', content: 'Haemoglobin below 11 g/dL - anaemia in pregnancy. Provide iron and folic acid and follow up.' }] },
  { name: 'Urgent warning for severe anaemia',
    condition: "d2:hasValue(#{haemoglobin_in_g_dl}) && #{haemoglobin_in_g_dl} < 7",
    actions: [{ type: 'SHOWWARNING', content: 'URGENT: severe anaemia (haemoglobin below 7 g/dL). Refer for assessment and possible transfusion.' }] },
  { name: 'Warn for reduced or absent fetal movement',
    condition: "(#{fetal_movement_status} == 'ABSENT' || #{fetal_movement_status} == 'REDUCED') && d2:hasValue(#{gestational_age_at_this_visit}) && #{gestational_age_at_this_visit} >= 24",
    actions: [{ type: 'SHOWWARNING', content: 'Fetal movement is reduced or absent at a gestational age when movement should be felt - assess fetal wellbeing immediately.' }] },
  { name: 'Warn for abnormal fetal heart rate',
    condition: "d2:hasValue(#{fetal_heart_rate}) && (#{fetal_heart_rate} < 110 || #{fetal_heart_rate} > 160)",
    actions: [{ type: 'SHOWWARNING', content: 'Fetal heart rate is outside the expected 110-160 bpm range - repeat the measurement and assess.' }] },
  { name: 'Warn when fundal height differs from gestational age',
    condition: "d2:hasValue(#{fundal_height_in_centimetres}) && d2:hasValue(#{gestational_age_at_this_visit}) && #{gestational_age_at_this_visit} >= 24 && ((#{fundal_height_in_centimetres} - #{gestational_age_at_this_visit} > 3) || (#{gestational_age_at_this_visit} - #{fundal_height_in_centimetres} > 3))",
    actions: [{ type: 'SHOWWARNING', content: 'Fundal height differs from gestational age by more than 3 cm - consider ultrasound assessment of fetal growth and liquor.' }] },
  { name: 'Counselling feedback for partial or poor supplement adherence',
    condition: "#{supplement_adherence} == 'PARTIAL' || #{supplement_adherence} == 'POOR'",
    actions: [{ type: 'DISPLAYTEXT', content: 'Adherence to iron and folic acid is partial or poor - counsel the woman on the importance of daily supplementation and address side effects.' }] },
  { name: 'Suggest next ANC contact in 4 weeks before 28 weeks',
    condition: "d2:hasValue(#{gestational_age_at_this_visit}) && #{gestational_age_at_this_visit} < 28",
    actions: [{ type: 'ASSIGN', data_element_name: 'Next ANC contact date', data: "d2:addDays(V{event_date}, 28)" }] },
  { name: 'Suggest next ANC contact in 2 weeks from 28 to 35 weeks',
    condition: "d2:hasValue(#{gestational_age_at_this_visit}) && #{gestational_age_at_this_visit} >= 28 && #{gestational_age_at_this_visit} < 36",
    actions: [{ type: 'ASSIGN', data_element_name: 'Next ANC contact date', data: "d2:addDays(V{event_date}, 14)" }] },
  { name: 'Suggest next ANC contact in 1 week from 36 weeks',
    condition: "d2:hasValue(#{gestational_age_at_this_visit}) && #{gestational_age_at_this_visit} >= 36",
    actions: [{ type: 'ASSIGN', data_element_name: 'Next ANC contact date', data: "d2:addDays(V{event_date}, 7)" }] },
];

// Batch 4 — Stage 2 referral mandates + feedback
const RULES_S2B = [
  { name: 'Require referral flag for urgent maternal or fetal condition',
    condition: URGENT_ANC_ATOM,
    actions: [{ type: 'SETMANDATORYFIELD', data_element_name: 'Referral required' }] },
  { name: 'Require ANC referral destination when referral required',
    condition: "#{referral_required} == true",
    actions: [{ type: 'SETMANDATORYFIELD', data_element_name: 'Referral destination' }] },
  { name: 'Display visit gestational age in feedback',
    condition: "d2:hasValue(#{gestational_age_at_this_visit})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Gestational age at this visit (weeks)', data: "#{gestational_age_at_this_visit}" }] },
  { name: 'Display latest haemoglobin in feedback',
    condition: "d2:hasValue(#{haemoglobin_in_g_dl})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Latest haemoglobin (g/dL)', data: "#{haemoglobin_in_g_dl}" }] },
  { name: 'Display latest blood pressure in feedback',
    condition: "d2:hasValue(#{systolic_blood_pressure}) && d2:hasValue(#{diastolic_blood_pressure})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Latest blood pressure (mmHg)', data: "d2:concatenate(#{systolic_blood_pressure}, ' / ', #{diastolic_blood_pressure})" }] },
];

// Batch 5 — Stage 3 laboratory and ultrasound
const RULES_S3A = [
  { name: 'Hide HIV result when HIV test not performed',
    condition: "!d2:hasValue(#{hiv_test_performed}) || #{hiv_test_performed} != true",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'HIV test result' }] },
  { name: 'Hide syphilis result when syphilis test not performed',
    condition: "!d2:hasValue(#{syphilis_test_performed}) || #{syphilis_test_performed} != true",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Syphilis test result' }] },
  { name: 'Hide HIV care linkage unless HIV result is positive',
    condition: "!d2:hasValue(#{hiv_test_result}) || #{hiv_test_result} != 'POSITIVE'",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'HIV care linkage recorded' }] },
  { name: 'Require HIV care linkage for a positive HIV result',
    condition: "#{hiv_test_result} == 'POSITIVE'",
    actions: [{ type: 'SETMANDATORYFIELD', data_element_name: 'HIV care linkage recorded' }] },
  { name: 'Hide syphilis treatment unless syphilis result is positive',
    condition: "!d2:hasValue(#{syphilis_test_result}) || #{syphilis_test_result} != 'POSITIVE'",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Syphilis treatment started' }] },
  { name: 'Require syphilis treatment information for a positive result',
    condition: "#{syphilis_test_result} == 'POSITIVE'",
    actions: [{ type: 'SETMANDATORYFIELD', data_element_name: 'Syphilis treatment started' }] },
  { name: 'Warn for indeterminate HIV or syphilis result',
    condition: "#{hiv_test_result} == 'INDETERMINATE' || #{syphilis_test_result} == 'INDETERMINATE'",
    actions: [{ type: 'SHOWWARNING', content: 'An HIV or syphilis result is indeterminate - repeat the test according to the national testing algorithm.' }] },
  { name: 'Confidential feedback when HIV care linkage is needed',
    condition: "#{hiv_test_result} == 'POSITIVE' && (!d2:hasValue(#{hiv_care_linkage_recorded}) || #{hiv_care_linkage_recorded} != true)",
    actions: [{ type: 'DISPLAYTEXT', content: 'CONFIDENTIAL: HIV result is positive and care linkage is not yet recorded - link the client to HIV care and treatment services now.' }] },
  { name: 'Feedback for Rhesus negative women',
    condition: "#{rhesus_factor} == 'NEGATIVE'",
    actions: [{ type: 'DISPLAYTEXT', content: 'The woman is Rhesus negative - assess the need for anti-D immunoglobulin and record the partner blood group where relevant.' }] },
  { name: 'Warn when glucose exceeds pregnancy thresholds',
    condition: "(d2:hasValue(#{fasting_blood_glucose}) && #{fasting_blood_glucose} >= 5.1) || (d2:hasValue(#{two_hour_blood_glucose}) && #{two_hour_blood_glucose} >= 8.5)",
    actions: [{ type: 'SHOWWARNING', content: 'Blood glucose exceeds the pregnancy threshold (fasting 5.1 / two-hour 8.5 mmol/L) - assess for gestational diabetes.' }] },
  { name: 'Hide ultrasound details when no ultrasound performed',
    condition: "!d2:hasValue(#{ultrasound_performed}) || #{ultrasound_performed} != true",
    actions: [
      { type: 'HIDEFIELD', data_element_name: 'Ultrasound date' },
      { type: 'HIDEFIELD', data_element_name: 'Gestational age by ultrasound' },
      { type: 'HIDEFIELD', data_element_name: 'Number of fetuses' },
      { type: 'HIDEFIELD', data_element_name: 'Placenta location' },
      { type: 'HIDEFIELD', data_element_name: 'Fetal growth assessment' },
      { type: 'HIDEFIELD', data_element_name: 'Fetal anomaly suspected' },
    ] },
  { name: 'Error when ultrasound date is before enrollment',
    condition: "d2:hasValue(#{ultrasound_date}) && d2:daysBetween(V{enrollment_date}, #{ultrasound_date}) < 0",
    actions: [{ type: 'SHOWERROR', content: 'The ultrasound date is before the enrollment date - correct the date.' }] },
  { name: 'Error for impossible ultrasound gestational age',
    condition: "d2:hasValue(#{gestational_age_by_ultrasound}) && #{gestational_age_by_ultrasound} > 43",
    actions: [{ type: 'SHOWERROR', content: 'Gestational age by ultrasound is beyond 43 weeks, which is not possible - correct the value.' }] },
  { name: 'Urgent referral warning for serious ultrasound findings',
    condition: "#{placenta_location} == 'PLACENTA_PREVIA' || #{placenta_location} == 'SUSPECTED_ABRUPTION' || #{fetal_growth_assessment} == 'SUSPECTED_GROWTH_RESTRICTION' || #{fetal_anomaly_suspected} == true",
    actions: [{ type: 'SHOWWARNING', content: 'URGENT: placenta previa, suspected abruption, growth restriction or fetal anomaly - refer for specialist obstetric assessment.' }] },
];

// Batch 6 — Stage 3 feedback displays
const RULES_S3B = [
  { name: 'Display blood group and Rhesus factor in feedback',
    condition: "d2:hasValue(#{blood_group}) && d2:hasValue(#{rhesus_factor})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Blood group / Rhesus', data: "d2:concatenate(#{blood_group}, ' ', #{rhesus_factor})" }] },
  { name: 'Display infection test results in feedback',
    condition: "d2:hasValue(#{hiv_test_result}) || d2:hasValue(#{syphilis_test_result})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'HIV / Syphilis results', data: "d2:concatenate(#{hiv_test_result}, ' / ', #{syphilis_test_result})" }] },
  { name: 'Display number of fetuses in feedback',
    condition: "d2:hasValue(#{number_of_fetuses})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Number of fetuses', data: "#{number_of_fetuses}" }] },
  { name: 'Display ultrasound findings in feedback',
    condition: "#{ultrasound_performed} == true",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Ultrasound findings', data: "d2:concatenate(#{placenta_location}, ' / ', #{fetal_growth_assessment})" }] },
];

// Batch 7 — Stage 4 delivery
const RULES_S4A = [
  { name: 'Assign gestational age at delivery from LMP',
    condition: "d2:hasValue(#{last_menstrual_period_date})",
    actions: [{ type: 'ASSIGN', data_element_name: 'Gestational age at delivery', data: "d2:weeksBetween(#{last_menstrual_period_date}, V{event_date})" }] },
  { name: 'Assign gestational age at delivery from ultrasound estimate',
    condition: "!d2:hasValue(#{last_menstrual_period_date}) && d2:hasValue(#{gestational_age_by_ultrasound}) && d2:hasValue(#{ultrasound_date})",
    actions: [{ type: 'ASSIGN', data_element_name: 'Gestational age at delivery', data: "#{gestational_age_by_ultrasound} + d2:weeksBetween(#{ultrasound_date}, V{event_date})" }] },
  { name: 'Block completion when delivery is before admission',
    condition: "d2:hasValue(#{delivery_date_and_time}) && d2:hasValue(#{admission_date_and_time}) && d2:daysBetween(#{admission_date_and_time}, #{delivery_date_and_time}) < 0",
    actions: [{ type: 'ERRORONCOMPLETE', content: 'Delivery cannot be before admission - correct the dates.' }] },
  { name: 'Block completion when delivery is before enrollment',
    condition: "d2:hasValue(#{delivery_date_and_time}) && d2:daysBetween(V{enrollment_date}, #{delivery_date_and_time}) < 0",
    actions: [{ type: 'ERRORONCOMPLETE', content: 'Delivery cannot be before the pregnancy enrollment date - correct the dates.' }] },
  { name: 'Block completion for impossible gestational age at delivery',
    condition: "d2:hasValue(#{gestational_age_at_delivery}) && (#{gestational_age_at_delivery} < 20 || #{gestational_age_at_delivery} > 44)",
    actions: [{ type: 'ERRORONCOMPLETE', content: 'Gestational age at delivery is outside the possible range (20-44 weeks) - check the pregnancy dating and delivery date.' }] },
  { name: 'Hide caesarean indication unless a caesarean section',
    condition: "!d2:hasValue(#{mode_of_delivery}) || (#{mode_of_delivery} != 'PLANNED_CAESAREAN_SECTION' && #{mode_of_delivery} != 'EMERGENCY_CAESAREAN_SECTION')",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Caesarean section indication' }] },
  { name: 'Require caesarean indication for a caesarean section',
    condition: "#{mode_of_delivery} == 'PLANNED_CAESAREAN_SECTION' || #{mode_of_delivery} == 'EMERGENCY_CAESAREAN_SECTION'",
    actions: [{ type: 'SETMANDATORYFIELD', data_element_name: 'Caesarean section indication' }] },
  { name: 'Hide maternal complication when the maternal outcome is stable',
    condition: "!d2:hasValue(#{maternal_outcome}) || #{maternal_outcome} == 'STABLE'",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Main maternal complication' }] },
  { name: 'Urgent warning and required details for postpartum haemorrhage',
    condition: "#{postpartum_haemorrhage_recorded} == true",
    actions: [
      { type: 'SHOWWARNING', content: 'URGENT: postpartum haemorrhage recorded - manage per the PPH protocol and record blood loss and transfusion.' },
      { type: 'SETMANDATORYFIELD', data_element_name: 'Estimated blood loss in millilitres' },
      { type: 'SETMANDATORYFIELD', data_element_name: 'Blood transfusion given' },
    ] },
  { name: 'Urgent notification for maternal death',
    condition: "#{maternal_outcome} == 'MATERNAL_DEATH'",
    actions: [
      { type: 'SHOWWARNING', content: 'URGENT: maternal death recorded. Notify the maternal death surveillance and response team; routine postnatal scheduling for the mother is stopped.' },
      { type: 'HIDEPROGRAMSTAGE', program_stage_name: 'Postnatal Mother and Newborn Follow-up' },
    ] },
  { name: 'Hide live-newborn fields for a stillbirth',
    condition: "#{newborn_outcome} == 'FRESH_STILLBIRTH' || #{newborn_outcome} == 'MACERATED_STILLBIRTH'",
    actions: [
      { type: 'HIDEFIELD', data_element_name: 'Five-minute Apgar score' },
      { type: 'HIDEFIELD', data_element_name: 'Newborn resuscitation required' },
      { type: 'HIDEFIELD', data_element_name: 'Breastfeeding started within one hour' },
    ] },
  { name: 'Warn for low birth weight',
    condition: "d2:hasValue(#{birth_weight_in_grams}) && #{birth_weight_in_grams} < 2500 && #{birth_weight_in_grams} >= 1500",
    actions: [{ type: 'SHOWWARNING', content: 'Birth weight below 2500 g - low birth weight. Initiate kangaroo mother care counselling and close follow-up.' }] },
  { name: 'Strong warning for very low birth weight',
    condition: "d2:hasValue(#{birth_weight_in_grams}) && #{birth_weight_in_grams} < 1500 && #{birth_weight_in_grams} > 0",
    actions: [{ type: 'SHOWWARNING', content: 'URGENT: very low birth weight (below 1500 g) - the newborn needs specialised neonatal care. Refer to a neonatal unit.' }] },
  { name: 'Warn for preterm birth',
    condition: "d2:hasValue(#{gestational_age_at_delivery}) && #{gestational_age_at_delivery} < 37 && #{gestational_age_at_delivery} >= 20",
    actions: [{ type: 'SHOWWARNING', content: 'Delivery before 37 weeks - preterm birth. Apply preterm newborn care protocols.' }] },
  { name: 'Urgent warning and required resuscitation details for low Apgar',
    condition: "d2:hasValue(#{five_minute_apgar_score}) && #{five_minute_apgar_score} < 7",
    actions: [
      { type: 'SHOWWARNING', content: 'URGENT: five-minute Apgar score below 7 - record resuscitation and monitor the newborn closely.' },
      { type: 'SETMANDATORYFIELD', data_element_name: 'Newborn resuscitation required' },
    ] },
];

// Batch 8 — Stage 4 multiples note + feedback
const RULES_S4B = [
  { name: 'Remind to create a record for each baby of a multiple birth',
    condition: "d2:hasValue(#{number_of_babies_delivered}) && #{number_of_babies_delivered} > 1",
    actions: [{ type: 'DISPLAYTEXT', content: 'More than one baby was delivered - create or relate a separate newborn record for each baby so each child can be followed up individually.' }] },
  { name: 'Display mode of delivery in feedback',
    condition: "d2:hasValue(#{mode_of_delivery})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Mode of delivery', data: "#{mode_of_delivery}" }] },
  { name: 'Display maternal outcome in feedback',
    condition: "d2:hasValue(#{maternal_outcome})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Maternal outcome', data: "#{maternal_outcome}" }] },
  { name: 'Display newborn outcome in feedback',
    condition: "d2:hasValue(#{newborn_outcome})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Newborn outcome', data: "#{newborn_outcome}" }] },
  { name: 'Display birth weight in feedback',
    condition: "d2:hasValue(#{birth_weight_in_grams})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Birth weight (g)', data: "#{birth_weight_in_grams}" }] },
  { name: 'Display Apgar score in feedback',
    condition: "d2:hasValue(#{five_minute_apgar_score})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Five-minute Apgar score', data: "#{five_minute_apgar_score}" }] },
];

// Batch 9 — Stage 5 postnatal logic
const RULES_S5A = [
  { name: 'Assign postnatal timing within 24 hours',
    condition: "d2:hasValue(#{delivery_date_and_time}) && d2:hasValue(#{contact_date_and_time}) && d2:daysBetween(#{delivery_date_and_time}, #{contact_date_and_time}) <= 1 && d2:daysBetween(#{delivery_date_and_time}, #{contact_date_and_time}) >= 0",
    actions: [{ type: 'ASSIGN', data_element_name: 'Postnatal contact timing', data: "'WITHIN_24_HOURS'" }] },
  { name: 'Assign postnatal timing 48-72 hours',
    condition: "d2:hasValue(#{delivery_date_and_time}) && d2:hasValue(#{contact_date_and_time}) && d2:daysBetween(#{delivery_date_and_time}, #{contact_date_and_time}) >= 2 && d2:daysBetween(#{delivery_date_and_time}, #{contact_date_and_time}) <= 3",
    actions: [{ type: 'ASSIGN', data_element_name: 'Postnatal contact timing', data: "'48_72_HOURS'" }] },
  { name: 'Assign postnatal timing 7-14 days',
    condition: "d2:hasValue(#{delivery_date_and_time}) && d2:hasValue(#{contact_date_and_time}) && d2:daysBetween(#{delivery_date_and_time}, #{contact_date_and_time}) >= 7 && d2:daysBetween(#{delivery_date_and_time}, #{contact_date_and_time}) <= 14",
    actions: [{ type: 'ASSIGN', data_element_name: 'Postnatal contact timing', data: "'7_14_DAYS'" }] },
  { name: 'Assign postnatal timing six weeks',
    condition: "d2:hasValue(#{delivery_date_and_time}) && d2:hasValue(#{contact_date_and_time}) && d2:daysBetween(#{delivery_date_and_time}, #{contact_date_and_time}) >= 35 && d2:daysBetween(#{delivery_date_and_time}, #{contact_date_and_time}) <= 56",
    actions: [{ type: 'ASSIGN', data_element_name: 'Postnatal contact timing', data: "'SIX_WEEKS'" }] },
  { name: 'Warn when the first postnatal contact is later than 72 hours',
    condition: "d2:hasValue(#{delivery_date_and_time}) && d2:hasValue(#{contact_date_and_time}) && d2:daysBetween(#{delivery_date_and_time}, #{contact_date_and_time}) > 3 && d2:daysBetween(#{delivery_date_and_time}, #{contact_date_and_time}) < 7",
    actions: [{ type: 'SHOWWARNING', content: 'If this is the first postnatal contact, it is later than the recommended 72 hours after delivery - screen mother and newborn carefully for danger signs.' }] },
  { name: 'Hide maternal danger sign details when none present',
    condition: "!d2:hasValue(#{maternal_danger_sign_present}) || #{maternal_danger_sign_present} != true",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Main maternal danger sign' }] },
  { name: 'Show wound status only after caesarean or assisted delivery',
    condition: "!d2:hasValue(#{mode_of_delivery}) || (#{mode_of_delivery} != 'PLANNED_CAESAREAN_SECTION' && #{mode_of_delivery} != 'EMERGENCY_CAESAREAN_SECTION' && #{mode_of_delivery} != 'ASSISTED_VAGINAL')",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Caesarean or perineal wound status' }] },
  { name: 'Mental-health warning for a high wellbeing screening score',
    condition: "d2:hasValue(#{maternal_emotional_wellbeing_screening_score}) && #{maternal_emotional_wellbeing_screening_score} >= 10",
    actions: [{ type: 'SHOWWARNING', content: 'The emotional wellbeing screening score is high - assess maternal mental health according to the local protocol and refer where needed.' }] },
  { name: 'Hide breastfeeding problem details when no problem present',
    condition: "!d2:hasValue(#{breastfeeding_problem_present}) || #{breastfeeding_problem_present} != true",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Main breastfeeding problem' }] },
  { name: 'Warn for excessive newborn weight loss',
    condition: "d2:hasValue(#{current_newborn_weight_in_grams}) && d2:hasValue(#{birth_weight_in_grams}) && (#{birth_weight_in_grams} - #{current_newborn_weight_in_grams}) > (#{birth_weight_in_grams} * 0.1)",
    actions: [{ type: 'SHOWWARNING', content: 'The newborn has lost more than 10 percent of birth weight - assess feeding urgently and consider referral.' }] },
  { name: 'Warn for abnormal newborn temperature',
    condition: "d2:hasValue(#{newborn_temperature}) && (#{newborn_temperature} < 36.5 || #{newborn_temperature} > 37.5)",
    actions: [{ type: 'SHOWWARNING', content: 'Newborn temperature is outside 36.5-37.5 C - manage thermal care and assess for infection.' }] },
  { name: 'Urgent warning for serious newborn danger signs',
    condition: "#{main_newborn_danger_sign} == 'SEVERE_JAUNDICE' || #{main_newborn_danger_sign} == 'DIFFICULT_BREATHING' || #{main_newborn_danger_sign} == 'CONVULSION' || #{main_newborn_danger_sign} == 'POOR_FEEDING' || #{main_newborn_danger_sign} == 'LETHARGY' || #{main_newborn_danger_sign} == 'LOW_TEMPERATURE' || #{main_newborn_danger_sign} == 'FEVER'",
    actions: [{ type: 'SHOWWARNING', content: 'URGENT: a serious newborn danger sign is present - refer the newborn immediately according to the emergency protocol.' }] },
  { name: 'Hide postnatal referral destination when referral not required',
    condition: "!d2:hasValue(#{referral_required}) || #{referral_required} != true",
    actions: [{ type: 'HIDEFIELD', data_element_name: 'Postnatal referral destination' }] },
  { name: 'Require postnatal referral destination when referral required',
    condition: "#{referral_required} == true",
    actions: [{ type: 'SETMANDATORYFIELD', data_element_name: 'Postnatal referral destination' }] },
  { name: 'Warn when BCG is not recorded at the six-week visit',
    condition: "#{postnatal_contact_timing} == 'SIX_WEEKS' && (!d2:hasValue(#{bcg_vaccination_given}) || #{bcg_vaccination_given} != true)",
    actions: [{ type: 'SHOWWARNING', content: 'BCG vaccination has not been recorded by the six-week visit - vaccinate or refer to the immunization service.' }] },
];

// Batch 10 — Stage 5 scheduling note + feedback
const RULES_S5B = [
  { name: 'Prompt to schedule the next postnatal contact',
    condition: "d2:hasValue(#{postnatal_contact_timing}) && #{postnatal_contact_timing} != 'SIX_WEEKS'",
    actions: [{ type: 'DISPLAYTEXT', content: 'Schedule the next postnatal contact according to the national schedule: within 24 hours, 48-72 hours, 7-14 days and six weeks after delivery.' }] },
  { name: 'Display current newborn weight in feedback',
    condition: "d2:hasValue(#{current_newborn_weight_in_grams})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Current newborn weight (g)', data: "#{current_newborn_weight_in_grams}" }] },
  { name: 'Display newborn weight change in feedback',
    condition: "d2:hasValue(#{current_newborn_weight_in_grams}) && d2:hasValue(#{birth_weight_in_grams})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Weight change since birth (g)', data: "#{current_newborn_weight_in_grams} - #{birth_weight_in_grams}" }] },
  { name: 'Display breastfeeding status in feedback',
    condition: "d2:hasValue(#{breastfeeding_status})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Breastfeeding status', data: "#{breastfeeding_status}" }] },
  { name: 'Display BCG status in feedback',
    condition: "d2:hasValue(#{bcg_vaccination_given})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'BCG recorded', data: "#{bcg_vaccination_given}" }] },
  { name: 'Display maternal danger sign in feedback',
    condition: "#{maternal_danger_sign_present} == true && d2:hasValue(#{main_maternal_danger_sign})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Maternal danger sign', data: "#{main_maternal_danger_sign}" }] },
  { name: 'Display newborn danger sign in feedback',
    condition: "#{newborn_danger_sign_present} == true && d2:hasValue(#{main_newborn_danger_sign})",
    actions: [{ type: 'DISPLAYKEYVALUEPAIR', content: 'Newborn danger sign', data: "#{main_newborn_danger_sign}" }] },
];

const RULE_BATCHES = [
  ['Stage 1: registration logic', RULES_S1A],
  ['Stage 1: validation + risk + feedback', RULES_S1B],
  ['Stage 2: ANC follow-up', RULES_S2A],
  ['Stage 2: referral + feedback', RULES_S2B],
  ['Stage 3: laboratory + ultrasound', RULES_S3A],
  ['Stage 3: feedback', RULES_S3B],
  ['Stage 4: delivery', RULES_S4A],
  ['Stage 4: multiples + feedback', RULES_S4B],
  ['Stage 5: postnatal logic', RULES_S5A],
  ['Stage 5: scheduling + feedback', RULES_S5B],
];

(async () => {
  const ctx = load({ appType: 'Maintenance' });
  const t = (name, args) => ctx.executeTool(name, args);
  const state = { programId: null, tetId: null, stages: {} };

  // ── 0. Tracked entity type ────────────────────────────────────────────────
  console.log('\n0. Tracked entity type "Pregnant Woman"');
  const tetList = await t('dhis2_query', { path: "trackedEntityTypes?filter=name:eq:Pregnant Woman&fields=id,name" });
  let tetId = tetList?.trackedEntityTypes?.[0]?.id || null;
  if (!tetId) {
    const mk = await t('dhis2_query', {
      method: 'POST', path: 'trackedEntityTypes',
      body: { name: 'Pregnant Woman', shortName: 'Pregnant Woman', description: 'A woman followed through one pregnancy from first ANC contact to the end of postnatal follow-up.' },
    });
    tetId = mk?.response?.uid || mk?.uid || null;
    check('TET created', !!tetId, show(mk));
  } else {
    console.log(`  (reusing existing TET ${tetId})`);
  }
  state.tetId = tetId;

  // ── 0b. Pick a real icon key ──────────────────────────────────────────────
  const icons = await t('dhis2_query', { path: 'icons?search=preg&fields=key&pageSize=5' });
  const iconKey = (icons?.icons || icons?.pager ? (icons.icons || []) : [])[0]?.key
    || (Array.isArray(icons) ? icons[0]?.key : null) || null;
  console.log(`  icon key: ${iconKey || '(none found — color only)'}`);

  // ── 1. create_program: shell + TEAs + Stage 1 ─────────────────────────────
  console.log('\n1. create_program (shell + 15 attributes + Stage 1, no rules yet)');
  const r1 = await t('create_metadata', {
    action: 'create_program',
    program_name: 'Integrated Pregnancy, Delivery and Postnatal Care Tracker',
    program_short_name: 'Pregnancy Care Tracker',
    program_description: 'Follows one woman through one pregnancy: registration and first ANC assessment, routine ANC follow-up, laboratory and ultrasound assessment, delivery and birth outcome, and postnatal mother-and-newborn follow-up. A woman may enrol again for a future pregnancy, but should not have two active pregnancy enrollments at the same time.',
    program_type: 'WITH_REGISTRATION',
    tracked_entity_type_id: 'Pregnant Woman',
    assign_all_org_units: true,
    program_color: '#E91E63',
    ...(iconKey ? { program_icon: iconKey } : {}),
    program_attributes: [
      { name: 'Pregnancy client ID', value_type: 'TEXT', generated: true, unique: true, pattern: 'RANDOM(########)', searchable: true, display_in_list: true, description: 'Automatically generated unique identifier for the pregnancy client.' },
      { name: 'National ID', searchable: true, display_in_list: false },
      { name: 'Full name', searchable: true, display_in_list: true },
      { name: 'Date of Birth', display_in_list: true },
      { name: 'Primary phone number', value_type: 'PHONE_NUMBER', description: 'Main contact number for appointment reminders.' },
      { name: 'Alternative phone number', value_type: 'PHONE_NUMBER' },
      { name: 'Village or community', value_type: 'TEXT' },
      { name: 'Full residential address', value_type: 'LONG_TEXT' },
      { name: 'Preferred language', value_type: 'TEXT', option_set: OS.language },
      { name: 'Marital status', value_type: 'TEXT', option_set: OS.marital },
      { name: 'Education level', value_type: 'TEXT', option_set: OS.education },
      { name: 'Consent to receive appointment reminders', value_type: 'BOOLEAN' },
      { name: 'Emergency contact name', value_type: 'TEXT' },
      { name: 'Emergency contact phone', value_type: 'PHONE_NUMBER' },
      { name: 'Residence coordinate', value_type: 'COORDINATE', description: 'Household location for case-level geographic follow-up.' },
    ],
    stages: [
      {
        name: 'Registration and First ANC Assessment',
        repeatable: false,
        data_elements: STAGE1_DES,
        sections: [
          { name: 'Pregnancy Dating', data_elements: ['Last menstrual period known', 'Last menstrual period date', 'Estimated due date', 'Gestational age at first contact in completed weeks'] },
          { name: 'Obstetric History', data_elements: ['Gravidity', 'Parity', 'Previous pregnancy loss', 'Previous stillbirth or neonatal death', 'Previous caesarean section', 'Number of previous caesarean sections'] },
          { name: 'Medical History and Allergies', data_elements: ['Chronic medical condition present', 'Main chronic condition', 'Current medication', 'Drug or food allergy present', 'Allergy details'] },
          { name: 'Examination and Risk', data_elements: ['Height in centimetres', 'Weight in kilograms', 'Systolic blood pressure', 'Diastolic blood pressure', 'Pregnancy risk classification'] },
        ],
      },
    ],
  });
  const ok1 = r1 && r1.success !== false && !r1._error && (r1.program_id || r1.summary?.program?.id);
  check('program shell + stage 1 created', ok1, show(r1));
  if (!ok1) throw new Error('create_program failed — aborting');
  state.programId = r1.program_id || r1.summary.program.id;
  console.log(`  program id: ${state.programId}`);

  // ── 2. add_stage ×4 ───────────────────────────────────────────────────────
  const stageDefs = [
    ['Routine ANC Follow-up', true, STAGE2_DES, [
      { name: 'Visit Details', data_elements: ['ANC contact number', 'Visit type', 'Gestational age at this visit', 'Current weight in kilograms'] },
      { name: 'Examination', data_elements: ['Systolic blood pressure', 'Diastolic blood pressure', 'Maternal temperature in degrees Celsius', 'Fundal height in centimetres', 'Oedema grade', 'Fetal movement status', 'Fetal heart rate'] },
      { name: 'Danger Signs', data_elements: ['Any pregnancy danger sign present', 'Main danger sign'] },
      { name: 'Tests and Supplements', data_elements: ['Urine protein result', 'Haemoglobin in g/dL', 'Iron and folic acid days supplied', 'Supplement adherence'] },
      { name: 'Referral and Next Contact', data_elements: ['Referral required', 'Referral destination', 'Next ANC contact date'] },
    ]],
    ['Laboratory and Ultrasound Assessment', true, STAGE3_DES, [
      { name: 'Blood Tests', data_elements: ['Assessment date', 'Blood group', 'Rhesus factor', 'Haemoglobin in g/dL', 'Fasting blood glucose', 'Two-hour blood glucose'] },
      { name: 'Infection Screening', data_elements: ['HIV test performed', 'HIV test result', 'HIV care linkage recorded', 'Syphilis test performed', 'Syphilis test result', 'Syphilis treatment started', 'Urine protein result'] },
      { name: 'Ultrasound', data_elements: ['Ultrasound performed', 'Ultrasound date', 'Gestational age by ultrasound', 'Number of fetuses', 'Placenta location', 'Fetal growth assessment', 'Fetal anomaly suspected'] },
    ]],
    ['Delivery and Birth Outcome', false, STAGE4_DES, [
      { name: 'Admission and Delivery', data_elements: ['Delivery facility', 'Admission date and time', 'Delivery date and time', 'Gestational age at delivery', 'Labour onset', 'Mode of delivery', 'Caesarean section indication', 'Main birth attendant'] },
      { name: 'Maternal Outcome', data_elements: ['Maternal outcome', 'Main maternal complication', 'Estimated blood loss in millilitres', 'Postpartum haemorrhage recorded', 'Blood transfusion given'] },
      { name: 'Newborn Outcome', data_elements: ['Number of babies delivered', 'Newborn outcome', 'Newborn sex', 'Birth weight in grams', 'Five-minute Apgar score', 'Newborn resuscitation required', 'Breastfeeding started within one hour'] },
    ]],
    ['Postnatal Mother and Newborn Follow-up', true, STAGE5_DES, [
      { name: 'Contact Details', data_elements: ['Postnatal contact timing', 'Contact date and time'] },
      { name: 'Maternal Assessment', data_elements: ['Maternal temperature', 'Heavy or abnormal bleeding', 'Maternal danger sign present', 'Main maternal danger sign', 'Caesarean or perineal wound status', 'Maternal emotional wellbeing screening score', 'Family-planning counselling provided'] },
      { name: 'Breastfeeding', data_elements: ['Breastfeeding status', 'Breastfeeding problem present', 'Main breastfeeding problem'] },
      { name: 'Newborn Assessment', data_elements: ['Current newborn weight in grams', 'Newborn temperature', 'Jaundice present', 'Newborn danger sign present', 'Main newborn danger sign', 'BCG vaccination given'] },
      { name: 'Referral', data_elements: ['Referral required', 'Postnatal referral destination'] },
    ]],
  ];
  console.log('\n2. add_stage x4 (stages 2-5)');
  for (const [name, repeatable, des, sections] of stageDefs) {
    const r = await t('create_metadata', {
      action: 'add_stage', program_id: state.programId,
      stage: { name, repeatable, data_elements: des, sections },
    });
    const ok = r && r.success !== false && !r._error && r.summary?.stage?.id;
    check(`stage "${name}" added (${des.length} DEs, ${sections.length} sections)`, ok, show(r));
    if (!ok) throw new Error(`add_stage failed for ${name}`);
    state.stages[name] = r.summary.stage.id;
    const reused = r.summary.reused_existing_data_elements || [];
    if (reused.length) console.log(`    reused existing DEs: ${reused.map(d => d.name).join(', ')}`);
  }

  // ── 3. add_program_rules in batches ───────────────────────────────────────
  console.log('\n3. add_program_rules (batches of <=15)');
  let totalRules = 0;
  for (const [label, rules] of RULE_BATCHES) {
    const r = await t('create_metadata', { action: 'add_program_rules', program_id: state.programId, program_rules: rules });
    const created = r?.rules_created ?? r?.summary?.rules ?? null;
    const ok = r && r.success !== false && !r._error && !(r.skipped_rules || []).length && !(r.unresolved || []).length;
    check(`${label}: ${rules.length} rules`, ok, show(r));
    if (!ok) throw new Error(`add_program_rules failed for batch: ${label}`);
    totalRules += rules.length;
  }
  console.log(`  total rules sent: ${totalRules}`);

  // ── Result ────────────────────────────────────────────────────────────────
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  const { total, failed } = summarize();
  console.log(`\nAPI calls: ${total}, failed: ${failed.length}`);
  for (const f of failed) console.log(`  FAILED ${f.method} ${f.url} → ${f.status}`);
  if (failures || failed.length) { console.log('\nRESULT: FAIL'); process.exit(1); }
  console.log(`\nRESULT: PASS — program ${state.programId} built with 0 failed API calls. State → ${STATE_FILE}`);
})().catch(e => { console.error('\nFATAL:', e.message); const { total, failed } = summarize(); console.log(`API calls: ${total}, failed: ${failed.length}`); for (const f of failed) console.log(`  FAILED ${f.method} ${f.url} → ${f.status}`); process.exit(1); });
