# manage_indicators — DHIS2 Aggregate Indicators (numerator/denominator formulas)

## Summary
A new first-class tool, **`manage_indicators`**, gives the chatbot full, safe CRUD over DHIS2 **aggregate
indicators** — the `(numerator / denominator) × indicatorType-factor` calculated values that dashboards, pivot
tables and maps display (e.g. ANC coverage, case-fatality rate, facility reporting rate). Before this, the only
path was hand-assembling `/api/metadata` bodies via `dhis2_query`, with no expression validation, no
indicatorType resolution, no auto-backup and no reference-aware delete.

> **Scope:** this tool is for **aggregate** indicators. Tracker / event **program** indicators are a different
> object and remain owned by `manage_program_indicators`. The tools are intentionally kept disjoint so neither
> steals the other's turns.

## Actions
| action | what it does |
| --- | --- |
| `list` | Paginated indicator list; optional `name_filter` (ilike) and `indicator_type` (UID or exact name) filters. |
| `get` | One indicator with both expressions, type, factor, annualized, decimals. |
| `create` | New indicator (validates expressions + indicatorType, VALIDATE→COMMIT). |
| `update` | Patch any field and/or change the type; auto-snapshots a backup first. |
| `delete` | Reference-aware delete; auto-backup; surfaces DHIS2's exact blocking reason on `deleted:0`. |

## The indicator object
```
indicator: {
  name,                       // required on create — unique
  short_name,                 // ≤50 chars, defaults to name
  description,
  indicator_type,             // required on create — UID or exact name (resolved + verified)
  numerator,                  // required — DHIS2 aggregate expression
  numerator_description,      // auto-derived from DHIS2 if omitted
  denominator,                // required — use "1" for a plain count/sum
  denominator_description,    // auto-derived if omitted
  annualized,                 // boolean, default false
  decimals                    // integer 0–5, or null to inherit
}
```

## Expressions (numerator & denominator)
Both sides are standard DHIS2 aggregate expressions, server-validated via `/api/expressions/description`
**before** anything is saved:
- `#{dataElementUid}` — data element summed across all category-option-combos.
- `#{dataElementUid.cocUid}` — one disaggregation cell.
- `R{dataSetUid.REPORTING_RATE}` — reporting rate (also `ACTUAL_REPORTS`, `EXPECTED_REPORTS`, …).
- `I{programIndicatorUid}` — reuse a program indicator's value.
- `C{constantUid}` — a constant; plus numeric literals and `+ - * /`.

A bad UID or malformed syntax is rejected at create/update time with the parser's exact error — never silently
saved. UIDs are never invented; resolve them with `search_metadata` / `manage_datasets(action=get)`.

## indicator_type (the scaling factor)
Pass a UID or the exact name. Common types on the playground:

| name | factor | use for |
| --- | --- | --- |
| Number (Factor 1) | 1 | raw ratio / count |
| Per cent | 100 | a percentage |
| Per thousand | 1000 | per-1,000 rates |
| Per ten thousand | 10000 | per-10,000 rates |
| Per hundred thousand | 100000 | e.g. maternal deaths per 100,000 live births |

The tool resolves the type to its UID and **verifies it exists** before writing, so a typo produces a clean
error instead of a deep import-report failure.

## Safety rails (all reused, none modified)
- **Write auth gate** (`requireWriteAuth`) on create/update/delete.
- **Existence check** (`verifyTargetExists`) before update/delete.
- **Auto-backup** (`ensureBackupOrBail`) before every update and delete — restorable via `manage_backups`
  (`indicators` is already a recognized backup type). `skip_backup:true` only after an explicit user override.
- **Reference-aware delete**: `checkMetadataReferences` + DHIS2's atomic `DELETE`; on `deleted:0` the exact
  blocking reason (dataSet / visualization / indicatorGroup / predictor) is surfaced.
- **VALIDATE-then-COMMIT** import via `postMetadataPayload` (which also auto-fixes shortName conflicts for
  `indicators`).

## Examples
- *"Create an ANC 1 coverage indicator as a percentage of expected pregnancies"* →
  `create indicator:{ name:"ANC 1 Coverage", indicator_type:"Per cent", numerator:"#{anc1}", denominator:"#{expectedPregnancies}" }`
- *"Maternal deaths per 100,000 live births"* →
  `indicator_type:"Per hundred thousand", numerator:"#{maternalDeaths}", denominator:"#{liveBirths}"`
- *"Total malaria cases (a plain sum)"* →
  `indicator_type:"Number (Factor 1)", numerator:"#{malariaConfirmed} + #{malariaClinical}", denominator:"1"`

## Verification (DHIS2 2.43 playground, `stable-2-43-0-1`)
Proven via curl before the code was written: pre-generated UID → metadata VALIDATE (created:1, 0 errors) →
COMMIT (created:1) → read-back matched payload → `:owner` PUT update (rename + annualized) OK → DELETE
(deleted:1) → read-back 404. Bad indicatorType rejected ("Invalid reference … (IndicatorType)"); bad expression
rejected by `/expressions/description`; `#{de}` / `R{ds.REPORTING_RATE}` / `I{pi}` / numeric expressions all
validated OK. All test objects deleted; `name:like:ZZ` residue sweep returned zero. Both `node --check` pass; a
25-case intent battery passes with zero false positives (no `manage_program_indicators` turn is ever stolen).
