# Weak-LLM reliability: no failed turns on giant program builds (v2.8.16)

**Date:** 2026-07-18
**Trigger:** Two live failures on the same 5-stage / 100-DE / 100-rule tracker
prompt ("Integrated Pregnancy, Delivery and Postnatal Care Tracker"):

- **KIMI 2.7** — its `create_metadata` tool-call arguments arrived truncated;
  the agent flagged them with an internal `tc._argsCorrupted` marker and asked
  for a resend — but the marker was left on the message object, went out on the
  wire in the next request, and Moonshot's strict API rejected the whole turn:
  `400 Extra inputs are not permitted, field: 'messages[9].tool_calls[0]._argsCorrupted'`.
- **GLM 5.2** — planning the entire build in one atomic call burned the whole
  output-token budget on reasoning three times in a row → empty responses →
  "I was unable to produce a response."

## 1. Internal markers can never leak onto the wire

`sanitizeWireMessages()` (src/providers.js) now runs on EVERY outbound request
and strips every `_`-prefixed key from messages and their tool_calls — and ONLY
those, because some providers require their own extra fields echoed back
(Google Gemini's `thought_signature`). The agent loop also consumes
(`delete`s) `tc._argsCorrupted` immediately after reading it, so persisted
conversation history stays clean too.

## 2. Truncated tool calls are never "repaired" into silent partial writes

`repairToolCallArguments()` now reports `lossy: true` when it had to balance
braces / close strings — i.e. the tail of the payload was LOST. The streaming
adapter refuses lossy repairs (previously a truncated `create_program` could be
brace-balanced into valid JSON missing its last stages and "succeed"). Only
token-leak corruption (`]<]minimax[>[` separators, control chars) is repaired
and executed; anything lossy is flagged for an honest resend.

## 3. Deterministic-truncation guidance (finish_reason plumbing)

The agent loop now reads `finish_reason`. When a tool call was cut by the
token limit (`length`), resending the same payload WILL truncate at the same
point — the feedback skips the "resend the same call" pass and steers straight
to the incremental build (`create_program` shell+stage 1 → `add_stage` →
`add_program_rules` in batches of ≤15). When a response is EMPTY with
`finish_reason=length` (reasoning burned the budget), the nudge says exactly
that and demands the smallest next concrete step; the final bail message
explains the cause and the fixes (raise max tokens / split / stronger model)
instead of "try rephrasing".

## 4. Incremental-build doctrine for very large programs

The create_metadata manual now instructs: >~2 stages / ~40 DEs / ~20 rules →
build incrementally from the start (shell + first stage, then add_stage per
stage, then add_program_rules in ≤15-rule batches). The discovery-streak guard
hint and the tool summary carry the same split guidance.

## 5. add_stage brought to full parity with create_program

`add_stage` is the recommended path for large builds, so it now:
- **reuses existing DEs and option sets by exact name** (batched probes,
  fail-loud on probe errors) — later stages repeat earlier stages' DEs
  (blood pressure, haemoglobin, referral fields) and shared option sets;
- adds a **case-insensitive second pass** (an existing "Systolic Blood
  Pressure" is reused for "Systolic blood pressure" instead of importing a
  silent near-duplicate);
- probes **global stage-name uniqueness** (original → "<name> - <program
  short>" → UID shard) like create_program;
- supports **sections** (same construction: top-level programStageSections +
  stage refs).

## 6. Reuse-compatibility gate (create_program AND add_stage)

Blind reuse-by-name broke real requirements: the instance's existing
"Mode of Delivery" option set had only Vaginal/Cesarean while the program
needed 5 modes — reuse silently dropped 3 options and made every caesarean
rule dead. Now an existing same-name object is reused ONLY when compatible:
- option sets: the existing set must already contain every requested option
  (case-insensitive); otherwise OUR full set is created as a coexisting
  "<name> (<program short name>)" (advisory: `option_set_renames`);
- DEs/TEAs: same value-type FAMILY (numeric/date/boolean/text) and, when the
  request has an inline option_set, the existing object's set must contain all
  requested options; otherwise a coexisting renamed DE/TEA is created
  (advisory: `reuse_conflict_renames`).

## 7. Pre-validation no longer contradicts the reuse manual

`validateAndHealProgramInput` demanded `value_type` on every attribute/DE —
but the documented reuse pattern lists EXISTING objects by bare name, and new
ones get an inferred type. Missing value_type is now a heal-note, not a block.

## 8. Small capability gaps closed (all generic)

- TEAs: `unique`, `generated`, `pattern` (auto-generated IDs), `description`.
- Programs: `program_description`, `program_color`, `program_icon` (style).
- Rule actions: `location` pass-through; DISPLAYTEXT / DISPLAYKEYVALUEPAIR
  default to `location: "feedback"`; DISPLAYKEYVALUEPAIR documented as THE
  action for "display X in the Feedback widget".
- add_stage schema documents `sections`; program_rules schema documents
  DISPLAYTEXT/DISPLAYKEYVALUEPAIR and `location`.

## 9. Grammar-constrained decoders can now emit (and we can heal) nested payloads

Live LLM-driven run (Fireworks / MiniMax-M3 through the real `runAgenticLoop`)
exposed a third failure class: the two-tier slim wire schema declared nested
array items as bare `{type:'object'}`, and Fireworks' grammar-constrained
tool-call decoder — having no field spec — wrapped EVERY nested item as
`{"$text": "<the intended object as a JSON string>"}`. The tool saw objects
with no usable fields, pre-validation refused ("16 of 16 objects missing a
name"), the model retried into the circuit breaker, and the turn died. Fixed
generically at both ends:

- **Slim schema keeps a type skeleton** (`schemaSkeleton()` in registry.js):
  nested `properties`/`required`/`enum`/`items` survive slimming with
  descriptions stripped — constrained decoders now know the real field names
  for a few hundred extra tokens. Verified: MiniMax-M3 emits perfect nested
  objects with the skeleton schema.
- **Argument shape healer** (`healToolArgumentShape()` in core.js, applied to
  every tool call in agent.js): unwraps `{"$text": "…"}` wrappers and parses
  array items that arrive as stringified JSON objects, recursively, before
  validation. Plain strings are never touched. Covers providers that mangle
  shapes regardless of schema.

## 10. create_program auto-creates a missing named TrackedEntityType

"Use **Pregnant Woman** as the tracked entity type" on an instance where that
type doesn't exist used to fail with "Could not resolve a TrackedEntityType".
A NAME (non-UID) that resolves to nothing is now CREATED (id, name, shortName,
description) before the program import — the full-dependency-chain promise.
Unresolvable UID-shaped inputs still fail fast (hallucinated UIDs must never
reach the server).

## 11. architect_metadata check_existing works without a filter

`check_existing` with no `name_filter` now lists the first 25 objects of the
type instead of returning a hard "Missing name_filter" error — an exploring
model shouldn't hit failures for a reasonable read.

## 12. Second live MiniMax round — five more generic fixes (2026-07-19)

The first full LLM-driven build got to 304 DHIS2 calls with only 3 failures;
each failure exposed a distinct generic defect, all fixed:

- **Schema/dispatcher drift killed batch rule creation.** The dispatcher
  accepts `rules` (batch) but the schema only declared `rule` — a
  grammar-constrained decoder therefore emitted `rules:[{}]` (no spec = no
  fields) 22 times in a row. `rules` is now declared programmatically FROM the
  `rule` schema so they can never drift again.
- **Identical incomplete repeats now escalate.** The non-disabling
  "incomplete call — resend" refusal is right for corrected retries, but a
  byte-identical empty repeat looped forever. After 3 blocked identical
  repeats it escalates to the disabling scope so the circuit breaker ends the
  loop; a corrected retry (different args) is never affected.
- **Empty/invalid rules are refused client-side** (no API call) in
  manage_program_rules create — previously an empty rule reached server
  validation and produced a failed VALIDATE call ("Missing required property
  `name`").
- **SHOWWARNINGINFORMATION is not a real server enum** (verified live:
  Jackson rejects it) yet our own docs advertised it. Removed from all
  docs/enums, auto-aliased to SHOWWARNING, and ALL rule-building paths
  (create_program, add_program_rules, manage_program_rules create/update) now
  run the same client-side action-type normalization — an invalid enum can
  never reach the server again.
- **Failed atomic imports no longer leak phantom ids.** add_stage /
  add_program_rules / manage_program_rules returned their summary (with
  pre-generated ids) even when the import failed; the model then GET-ed a
  phantom rule id → 404. Failures now return `nothing_created` with no ids.
- **Fuzzy (underscore-insensitive, unique-prefix) name resolution** in every
  rule-reference resolver: `#{haemoglobin_in_g_d_l}` resolves to
  "Haemoglobin in g/dL", and a short `#{mode_of_delivery}` resolves to a
  coexistence-renamed "Mode of delivery (<program>)" DE. Ambiguity still
  refuses with suggestions.
- **create_program auto-creates a missing NAMED TrackedEntityType** and
  `check_existing` lists without a filter instead of erroring (round 1 of the
  live run).

## 13. Third live round — analytics-building fixes (prompt 2, 2026-07-19)

The dashboard/indicator continuation surfaced four more generic defects:

- **Tool calls leaked as plain text ended the turn mid-task.** Under stress
  MiniMax emitted its next tool call as XML markup (with `]<]minimax[>[`
  separator tokens) inside CONTENT; the loop accepted it as the final answer
  and abandoned the build. The agent now detects tool-call markup in a final
  text (`<tool_call>`, `<invoke name=`, …), tells the model nothing was
  executed, and demands a native call (up to 3 nudges); the streaming adapter
  also strips leaked separator tokens from content.
- **Aggregate-indicator expression healing.** Models reference program
  indicators as `#{piUid}` or by NAME; DHIS2 requires `I{uid}`. createIndicator
  now auto-rewrites `#{<uid>}` → `I{<uid>}` when the uid is a PI, resolves
  name-form references (PI → I{uid}, indicator → N{uid}, aggregate DE →
  #{uid}) before validation, reports `expression_rewrites`, and the failure
  hint now teaches the full reference grammar.
- **Legend sets are idempotent by name.** Re-creating "Coverage Performance
  (RAG)" 409'd (a real failed API call) and tripped the breaker; a same-name
  set is now REUSED with its bands reported.
- **Visualization/dashboard data_items accept names.** `data_items:["Early ANC
  initiation (before 12 weeks)"]` (a name, not a UID) hard-failed; unresolved
  non-UID items are now resolved by exact name against indicators / program
  indicators / aggregate DEs (unique match, reported in `aliases`).

## 14. Fourth live round — indicator-semantics fixes (2026-07-19)

- **`#{stage.de}` refs are grounded client-side** before PI validation: a
  stale/hallucinated stage or DE uid now returns "X is not a stage of this
  program; its stages are: …" instead of the server's bare "Expression is not
  valid" (which a weak model retried into the circuit breaker).
  `get_program_info(stage_details)` verifies membership the same way instead
  of 404ing.
- **Unknown-d2-function lint now teaches the counting recipe**: models invent
  `d2:countByProgramStage(...)`; the refusal now says exactly how to count
  (analytics EVENT + expression `V{event_count}` + condition in `filter`).
- **The same-field contradiction lint understands `or`/`and` keywords** — the
  DHIS2 parser accepts them (verified live), and splitting OR-terms only on
  `||` made valid keyword-form filters false-positive as "impossible".
- **Mixed `&&`/`||` without parentheses returns a precedence advisory**
  (`A || B && C` = `A || (B && C)`) on every PI save, so grouping mistakes are
  visible immediately instead of silently miscounting.

## 15. Line-list probes respect analytics-table freshness (prompt 3, 2026-07-19)

On an instance whose analytics tables were last generated BEFORE the program
was created, EVERY analytics query for it 409s ("referenced table does not
exist", E7144) regardless of how correct the line list is — so the protective
pre-save probe itself produced a failed API call and misleading "fix your
list" pressure. manage_line_lists (create/update/validate) now compares
`system/info.lastAnalyticsTableSuccess` with the program's `created`
timestamp; when stale it skips the doomed probe and saves with an explicit
warning telling the user to run the Analytics Tables job. TRACKED_ENTITY
lists (no program) are unaffected; the TB line-list regression scenario still
passes with 0 failed calls.

## Verification

- `scripts/scenario-pregnancy-p1.js` — the full 5-stage / 100-DE / 29-option-
  set / 103-rule build through real executeTool against live 2.42.5.1:
  **0 failed API calls**, shared DEs reused across stages, incompatible
  same-name metadata coexists correctly.
- `scripts/verify-pregnancy-p1.js` — detail-by-detail live verification
  (TEA flags/types, stage order/repeatable/sections, DE value types + option
  sets + compulsory flags, 103 rules present, every #{var} resolves, clean
  rule audit): **all green**.
- `scripts/llm-harness.js` / `llm-run.js` — the REAL `runAgenticLoop` driven
  end-to-end by real weak LLMs (env-configured provider; nothing
  model-specific), DHIS2 auth injected only for the DHIS2 host. Conversation
  state persists across harness processes through the real
  service-worker-restart restore path (file-backed chrome.storage.session).
- **Full three-prompt live acceptance (MiniMax-M3 + Kimi-K2.6 on Fireworks,
  DHIS2 2.42.5.1):**
  - Prompt 1 (5-stage / 100-DE / 15-TEA tracker): 415 DHIS2 calls, **0
    failed**; requirement-driven verification all green (126 rules, every
    `#{var}` resolves, clean audit, auto-generated unique client ID,
    incremental shell → add_stage → rule batches exactly per doctrine).
  - Prompt 2 (52 PIs, 11 % indicators, 26 visualizations, 4 maps, 3 legend
    sets, 35-tile dashboard in the prompt's section layout): **0 failed
    calls** across the build turns; caesarean-by-indication filters verified
    per-indication with explicit parentheses.
  - Prompt 3 (10 saved line lists + 8-tile case-management dashboard): 92
    DHIS2 calls, **0 failed**; platform limitations honestly reported.
- `scripts/scenario-line-lists.js` (TB regression): 110 calls, 0 failed.
- `npm run verify` green; `node --check` clean on all changed modules.
