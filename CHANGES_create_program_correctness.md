# Changes — create_program correctness (zero-error TB program)

Root-caused and fixed from a real failing playground session: creating the
"Tuberculosis Case Surveillance and Treatment" tracker program hit a cascade of
failed API calls (a 500/409 on an invalid rule action, repeated "Option cannot
be null" validation errors, missing visual sections) before limping to a partial
result. Every fix below was **proven on the live 2.43 playground** (`https://play.im.dhis2.org/stable-2-43-0-1`)
via a Node harness that runs the real `executeTool` against the server; the full
program now imports with **32 API calls, 0 errors** — all 10 rules, 3 program
indicators, and 5 stage sections created — and all test metadata was deleted
afterward.

Files: `src/tools-programs.js`, `src/registry.js`, `src/core.js`.

---

## 1. Invalid program-rule action types no longer 409 the whole import

**File:** `src/tools-programs.js` — new `VALID_PR_ACTION_TYPES` / `PR_ACTION_TYPE_ALIASES`
/ `normalizeRuleActionType()`; used in `createFullProgram()`'s action loop.

**Symptom:** a rule with action type `COMPLETEENROLLMENT` (a type DHIS2 does not
have) failed the entire atomic `/metadata` import with
`Cannot deserialize value of type ProgramRuleActionType from String "COMPLETEENROLLMENT"`
(HTTP 500 on 2.40, 409 on 2.43). Jackson enum deserialization fails before
validation, so the whole program/stages/DEs/rules import is rejected and NOTHING
is created — and the client-side skip-and-continue logic can't catch it because
the payload is well-formed.

**Root cause:** `createFullProgram` wrote `programRuleActionType: act.type`
straight from model input with no whitelist. DHIS2 has NO complete/close-enrollment
program-rule action; the model invented one to satisfy "close out the tracker
file on Cured/Completed."

**Fix:** every action type is now normalized before it goes on the wire:
- valid types (union across 2.40–2.43) pass through canonicalised;
- known model inventions (`COMPLETEENROLLMENT`, `CLOSEENROLLMENT`, …) are
  **translated to a `SHOWWARNING` completion prompt** (the documented best effort,
  since DHIS2 can't auto-complete via a rule), recorded in `rule_action_fixes`;
- anything else unknown is **dropped** (recorded), and if a rule loses all its
  actions the rule is skipped — so a bad enum can never reach the server.

## 2. HIDEOPTION now resolves and binds the option UID

**File:** `src/tools-programs.js` — `createFullProgram()` (new `optionSetNameByDeName`
map + `optionSetOptionsByName` now carries option `id`s + HIDEOPTION resolution in
the action loop). **Schema:** `src/registry.js` adds `option_name` / `option_code`
to the rule-action schema and documents HIDEOPTION.

**Symptom:** `ProgramRuleAction: Option cannot be null for program rule 'Hide
First-Line regimen when Rifampicin resistance'` — repeatedly, both in the atomic
create and in the follow-up `manage_program_rules` retry.

**Root cause:** HIDEOPTION requires the specific option's UID, but the tool had no
way to name an option and never bound `programRuleAction.option`. The option is
created in the same bundle, so its UID isn't known to the model.

**Fix:** the action loop resolves the target option from the option set built for
`data_element_name` **in this call** — by exact display name, then code, then a
forgiving prefix/contains match — and sets `pra.option = { id }`. Unresolvable →
the rule is skipped cleanly (never sent), never a 409.

## 3. create_program now builds visual stage sections

**File:** `src/tools-programs.js` — `createFullProgram()` (per-stage section build +
new top-level `allProgramStageSections` collection). **Schema:** `src/registry.js`
adds `sections` to the stage schema.

**Symptom:** the user asked for named sections ("Signs and Risk Screening",
"Laboratory Investigation", …); they were silently not created, and HIDESECTION
rules were skipped with "create_program does not create sections."

**Root cause:** there was no `sections` input and no `programStageSections` output.

**Fix:** each stage accepts `sections: [{ name, data_elements: [<de names>] }]`.
Sections are built with pre-generated UIDs and — critically — emitted as a
**top-level `programStageSections` collection** with the stage referencing them
by id. (Nesting the full section objects inside the stage fails with
`ProgramStage: Invalid reference … (ProgramStageSection)` — verified live; DHIS2
requires the flat collection form, like `programRuleActions`.)

## 4. "continue" now counts as write authorization

**File:** `src/core.js` — `WRITE_AUTH_BROAD_RE` and the bare-affirmation regex in
`classifyWriteAuthorization()`.

**Symptom:** after the assistant said *'Reply "continue" and I will create the
program'*, the user replied "continue …" and the write was **refused** ("this
conversation turn does not authorize it").

**Root cause:** the affirmation vocabulary had `proceed`/`go ahead`/`yes` but not
`continue`, so the assistant's own suggested word didn't authorize the write.

**Fix:** added `continue` next to `proceed` in both the broad write-verb regex and
the bare-affirmation regex (scoped-approval path). The negation guard still
neutralises "don't continue".

---

## Verification

- Harness (`executeTool` → live 2.43 playground) reproduced each error, then
  confirmed the fix; the full TB program imports with **0 API errors**
  (VALIDATE 200 → COMMIT 200 for the program, then again for the indicators).
- Server read-back confirmed 10/10 rules (incl. HIDEOPTION with the bound option
  and the translated completion prompt), 3/3 indicators, 5/5 sections, and the
  repeatable Monthly Follow-Up stage.
- All test metadata deleted; playground left clean (0 `ZZTEST*` objects).
- `npm run verify` (safety gates + module load) still green.

## Not addressed here (model behaviour, not a tool bug)

The original session also burned its HTTP-error budget on **guessed icon keys**
(`icons/clinical_m_positive`, `medic_outline`, `warning_positive` → 404). That is
the model constructing icon keys instead of using `discover_icons` results; the
circuit breaker correctly stopped it. A tool-side mitigation (resolve an icon
keyword inside create_program so the model never probes `icons/<key>`) is a
sensible follow-up but is deliberately out of scope for this correctness pass.
