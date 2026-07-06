# Lazy Tool Manuals — two-tier tool docs (v2.8.0)

**Goal:** stop filling the LLM context with per-tool *how-to* instructions before the model has
decided to use a tool — while keeping every tool available, every instruction intact, and the
security posture unchanged (or better).

**Result (measured on the target scenario — "create a tracker program with a custom form and
program rules" from the Maintenance app):** the per-iteration LLM payload dropped from
**~22,100 tokens to ~12,700 tokens (–42%)** — system prompt ~8,050 → ~3,630 tokens, tool
definitions ~14,080 → ~9,110 tokens — and the payload is re-sent on **every** iteration of the
agentic loop (typically 5–30 per authoring turn), so the absolute saving multiplies per turn.
No instruction text was deleted anywhere; it moved from "always in context" to "in context from
the moment the tool is first used".

## The design

### What the model sees per turn (Tier 1 — routing info)
`getContextualTools()` is **unchanged** — the same regex intent router picks the same tool set
per request. But before the request goes to the provider, `toWireTools()` swaps each
**write-capable tool** (the 16 in `MANUAL_TOOLS`) for a **slim definition**:

- `description` → a hand-written routing summary from `TOOL_SUMMARIES` — what the tool does,
  when to pick it, its action list, and the safety-critical "NEVER do this via dhis2_query"
  routing rules — plus a standard note that the first call returns the manual.
- `parameters` → `slimSchema()`: top-level property names, types, **enums**, and `required`
  are preserved exactly; long prose descriptions are truncated at a sentence boundary; nested
  object shapes (`stages[]`, `rule.actions[]`, …) are collapsed to a field-name list ("Item
  fields: name, repeatable, data_elements — full spec in the manual"). The `action` enum's
  full description is kept verbatim — choosing the right action is decide-time routing.

Read tools (`dhis2_query`, `search_metadata`, `count_records`, analytics, `architect_metadata`,
…) and `manage_backups` (recovery must be zero-friction) keep their full definitions on the
wire — they are small and their prose *is* their manual.

### What the model gets on use (Tier 2 — the manual gate)
The **first** call to a `MANUAL_TOOLS` member in a turn does **not execute**. Instead the tool
result is `buildManualGateResult(name)`:

- `manual` — the tool's **original full description** (still stored untouched in `TOOLS` — the
  single source of truth), plus the deep how-to KB text that used to live in
  `buildSystemPrompt` (`MANUAL_EXTRAS`), plus a complete parameter reference rendered from the
  **original** schema (`renderParamDocs`).
- `_note` / `_next_step` — explicit instructions: this is not an error; check your arguments
  against the manual and re-issue the call now; it will execute immediately.

The loop marks the manual delivered (per turn) and the re-issued call executes normally. This
guarantees, **deterministically**, that a write-capable tool can never execute before the model
has read its complete instructions — a property the old "everything upfront" design had, kept
at a fraction of the cost. In effect the first call becomes a *forced self-review checkpoint*
for write operations.

Shared grammar blocks (`KB_PROGRAM_RULE_SYNTAX`, `KB_PI_GRAMMAR`, `KB_VALUE_TYPE_MAPPING`)
appear in every manual that needs them (create_metadata + manage_program_rules +
manage_program_indicators), so the model always has the exact syntax **at write time**.

### What the system prompt keeps (decide-time core)
Every big per-tool KB block in `buildSystemPrompt` was reduced to a 2–5 line **routing stub**
that preserves the decide-time content: what the object is, which tool owns it, the
disambiguations (aggregate indicator vs program indicator; render_chart vs manage_dashboards;
dataset_id vs program_stage_id), and every "NEVER via dhis2_query" safety invariant. The
Meta-Architect Protocol keeps its decide-time core (ONE-CALL creation pattern, workflow order,
never-paginate-OUs, org-units-vs-sharing, routing for existing programs, audit-first for broken
rules/indicators) — the payload details, error recovery, value-type mapping, full rule syntax
and PI grammar moved into the manuals. Cross-cutting sections (RULES, Verify-before-call,
Auto-Backup Contract, Tool Quick-Reference, Multi-step orchestration, Tracker Write Protocol)
are untouched. New RULE 16 tells the model how the manual gate works.

### History hygiene
A delivered manual is only needed in the turn it was delivered in — the gate re-delivers next
turn if the tool is used again. `buildTurnHistory` therefore stubs manual results down to a
~170-char marker (`stubToolContentForHistory`) instead of dragging ~2k chars of truncated
manual through every later request.

### Why not an LLM intent-router pass?
Considered and rejected: the regex router in `getContextualTools`/`buildSystemPrompt` already
does deterministic, zero-latency, zero-cost intent routing, and its flags now also decide which
routing stubs appear. An extra LLM routing call would add latency + cost to *every* turn to
save a one-iteration gate that only write turns pay. Likewise, intent-based *pre-delivery* of
manuals into the system prompt was rejected — it would re-inflate exactly the context the user
asked to slim; the gate delivers the manual only when the model actually commits to the tool.

## Security review (no regression, by construction)
- `classifyWriteAuthorization` (per-turn write gate), `preflightCheckCall` (unknown-UID +
  HTTP-error breaker), `ensureBackupOrBail`, `verifyTargetExists`, the hard patient-data
  privacy gate, bulk-delete confirmations and the save-diagnosis read-only mode are all
  **untouched** and see exactly the same calls as before — the gate runs *before* preflight and
  makes **no API call**.
- The gate cannot be used to bypass anything: it only ever *withholds* execution.
- Manual text is the same static instruction text the model previously received upfront —
  no new information is exposed.
- The out-of-context tool-call filter still applies (wire names == contextual names).
- Regression-verified live: the privacy gate refused all patient-level fallbacks and the
  knownIds preflight refused an unverified UID during testing, exactly as before.

## Root-cause fix shipped with this work: inline program-rule variables (create_metadata)
The E2E test exposed a **pre-existing** silent failure in `create_metadata`: both the
`create_program` inline-rules path and the `add_program_rules` path resolved `#{token}`
condition references against DE/TEA sanitized names by **exact match only** and silently
dropped anything else. A rule like `#{muac} >= 11.5` against a DE named "MUAC in cm"
(sanitized `muac_in_cm`) imported *fine* — and then **never fired** (the rule engine rejects
the unknown variable at runtime; `manage_program_rules(action=audit)` flags it). Fixed at the
root with the shared `resolveRuleTokenBindings()`:

- Tokens in the **condition AND action `data` expressions** now resolve: exact sanitized-name
  match first, then a **unique prefix match** either way round (`#{muac}` → `muac_in_cm`); the
  PRV is created under the *token* name bound to the matched DE/TEA, so the expression resolves
  exactly as written.
- `add_program_rules` now also loads the program's **existing PRV names** — tokens naming them
  pass through, and new PRVs can't collide with them.
- Anything ambiguous or unmatched **refuses the whole import before any POST** with
  `unresolved[]` + the available `#{…}`/`A{…}` names — mirroring `manage_program_rules`'s
  contract, so broken-by-construction rules can no longer be created silently.

## Verification (all live on play.im.dhis2.org/stable-2-43-0-1, real LLM = Fireworks kimi-k2p6, real `runAgenticLoop`)
1. **Full E2E of the target scenario** ("tracker program + 2 TEAs + 3-DE stage + 2 program
   rules + OU assignment + sharing + custom stage form", one user turn): completed in **32 s,
   5 tool calls, 2 manual deliveries, 0 failed calls** — search_metadata → create_metadata
   (gate → manual → re-issued, **11 objects in one atomic import**) → manage_custom_forms
   (gate → re-issued, formType=CUSTOM). Server-verified: OU + `rwrw----` sharing correct, 3
   bound stage-prefixed inputs in the dataEntryForm, both rules on `#{muac_in_cm}` with the PRV
   auto-created — `manage_program_rules(action=audit)`: **0 rule issues, 0 variable issues**.
2. **Multi-turn**: turn 1 (list rules) delivered the manage_program_rules manual once and the
   history entry was stubbed (<300 chars); turn 2 (add SETMANDATORYFIELD rule) re-fired the
   gate, created the rule + `age_in_months` PRV — audit clean across all 3 rules.
3. **PRV fix, both paths, both directions**: fuzzy `#{zz_muac}` → "ZZ MUAC in cm QA" bound +
   audit-clean on create_program AND add_program_rules; garbage tokens refused with
   `unresolved[]` on both paths with **nothing imported** (verified server-side).
4. **Read-only regression**: metadata Q&A on Capture (Child Programme) answers correctly
   through unchanged paths; privacy gate + unknown-UID preflight still refuse correctly.
   (Enrollment *counts* were unavailable because this shared instance's analytics tables are
   down — the same environmental issue documented in changes.md §25, unrelated to this change.)
5. `node --check background.js` + `node --check sidepanel/panel.js` pass; 32 tools registered;
   all 16 manuals build; all test objects (2 E2E programs, QA programs, created DEs, forms)
   deleted from the playground — pre-existing demo TEAs ("First name", "Date of birth") were
   reused by the builds and left untouched.

## Cost/latency trade-off (explicit)
A write turn now pays **one extra loop iteration per gated tool actually used** (the manual
round-trip). Each iteration is ~9k tokens cheaper, so the gate pays for itself after the first
iteration; on the measured scenario the two gates cost 2 extra iterations while every one of
the 5–7 iterations saved ~9.4k tokens — and TTFT per iteration drops with the smaller prompt.
Read-only turns pay nothing.
