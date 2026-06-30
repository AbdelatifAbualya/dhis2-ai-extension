# Feature — `manage_validation_rules` tool

A new tool that gives the DHIS2 AI Assistant first-class, server-validated CRUD over **DHIS2
Validation Rules** — the aggregate data-quality checks surfaced in the Data Quality / Validation
Analysis app and the Data Entry "Run validation" panel.

## Why

The assistant already authored datasets, data elements, custom forms, program rules and program
indicators, but had no dedicated path for validation rules. The only option was hand-writing
`/api/metadata` payloads through `dhis2_query` — no expression validation, no backup, no reference
check. Validation rules are a core part of routine aggregate reporting (consistency between totals
and sub-totals, plausibility bounds, paired-field requirements), so this was a real gap.

## What a validation rule is

`leftSide` *expression*  `operator`  `rightSide` *expression*, evaluated per period. When data
violates the comparison, DHIS2 flags it. Examples:

- "Inpatient days must not exceed available bed-days" — `#{inpatientDays} <= #{bedDays}` (Monthly)
- "ANC 4th visits cannot exceed ANC 1st visits" — `#{anc4} <= #{anc1}`
- "Sex sub-totals must equal the grand total" — `#{male} + #{female} == #{total}`

Expressions reference data elements as `#{dataElementUid}` (all category-option-combos summed) or
`#{dataElementUid.cocUid}` (one disaggregation), plus constants `C{constantUid}` and arithmetic.

## Tool surface — `manage_validation_rules`

| action | behaviour |
|--------|-----------|
| `list`   | paginated list; optional `name_filter`, `importance`, `period_type` filters |
| `get`    | one rule with both sides, operator, importance, period, missing-value strategies |
| `create` | new rule; validates both expressions server-side, then VALIDATE→COMMIT import |
| `update` | patch any field; validates new expressions, auto-backs-up, then PUT |
| `delete` | reference-check + auto-backup, then atomic DELETE |

`create`/`update` accept a `rule` object: `name`, `description`, `instruction`, `importance`
(HIGH/MEDIUM/LOW), `operator` (the 8 DHIS2 operators including `compulsory_pair` and
`exclusive_pair`), `period_type` (the 20 dataset period types), and per side
`left_expression` / `right_expression`, `*_description`, `*_missing_strategy`
(NEVER_SKIP / SKIP_IF_ANY_VALUE_MISSING / SKIP_IF_ALL_VALUES_MISSING). `create` also supports
`dry_run_only`; `update`/`delete` support `skip_backup` (gated, dangerous).

## Robustness

- **Authoritative expression validation.** Both sides are checked via DHIS2's
  `/api/expressions/description` endpoint before any write. A bad UID or malformed `#{...}` is
  rejected at create/update time with the parser's exact message — never silently saved.
- **Reuses every existing safety rail.** Write-auth gating (`requireWriteAuth`), pre-write backups
  (`ensureBackupOrBail`, restorable via `manage_backups`), existence checks
  (`verifyTargetExists`), reference checks (`checkMetadataReferences`) and the shared
  VALIDATE-then-COMMIT importer (`postMetadataPayload`).
- **No shared-code edits.** Only new identifiers and handlers were added; no existing helper,
  router, prompt builder or contextual-selector behaviour was modified.

## Contextual surfacing

`manage_validation_rules` appears **only** when the user expresses explicit validation-rule intent
(`validation rule(s)`, or a data-quality/consistency/plausibility ask combined with rule/dataset/
expression terms, or "validate/validation" alongside a validation-specific noun such as "left
side", "compulsory pair", "greater than", "dataset"). This keeps it out of unrelated dataset and
tracker flows entirely. A matching Validation-Rules knowledge block is added to the system prompt
under the same gate, and `panel.js` renders the tool with a ✅ icon and an action/operator/period
detail line.

## Verification (DHIS2 2.43 — `play.im.dhis2.org/stable-2-43-0-1`)

- Confirmed `/api/expressions/description` returns `status:OK` + a description for valid
  expressions and `status:ERROR` for bad UIDs / malformed syntax.
- Two complete create → read-back → delete cycles using pre-generated UIDs, VALIDATE then COMMIT,
  ZERO import errors — including a rule with mixed missing-value strategies and auto-derived side
  descriptions. Read-back matched the built payload exactly.
- All test objects (the validation rule plus two supporting aggregate data elements) deleted and
  verified gone (HTTP 404). `node --check` passes for both `background.js` and `sidepanel/panel.js`.
