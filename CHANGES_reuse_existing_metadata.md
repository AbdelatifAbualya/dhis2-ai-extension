# v2.8.8 — Existing metadata is NEVER recreated (+ write-auth negation fix)

## The incident

On a self-hosted Tomcat DHIS2 (`http://localhost:8081`), a plain request —

> *Create new tracker program called Child health … for attributes it should be "Full name", "DOB", "Sex"*

— failed three times in a row with:

```
TrackedEntityAttribute: Property `name` with value `Full name` on object Full name
[ShfyyHJZqxa] (TrackedEntityAttribute) already exists on object PLA4AkFtZkA
```

and then, after the user replied *"use these attributes that are already there, don't
recreate them, go ahead"*, the write gate **refused** with *"no explicit write authorization
detected"*. Follow-up `add_program_attributes` / `search_metadata` calls died with bare
`DHIS2 API 400`.

The tested build was v2.8.5 — it predates the v2.8.7 bracket-encoding fix, so on Tomcat every
`filter=name:in:[…]` / `fields=a[b]` query 400'd. But the transport bug only *exposed* deeper
logic gaps, all fixed here so the failure class cannot recur even if a probe fails again.

## Root causes and fixes (background.js)

| # | Root cause | Fix |
|---|-----------|-----|
| 1 | `createFullProgram` dedup probes swallowed errors — a failed probe looked like "nothing exists", so the tool tried to create TEAs/DEs/option sets that already existed | Probe failure now **aborts before any import** (`phase: 'pre_check'`, `nothing_created: true`) with a retry hint. Same guard in `add_program_attributes` and the growth-chart scaffold |
| 2 | No recovery when DHIS2 said "already exists on object `<UID>`" — the model retried identically and was eventually blocked | **Self-healing** in `postMetadataPayload` (`tryAutofixNameConflicts`): for TEA / DE / OptionSet / TET / CategoryOption / Category / CategoryCombo, drop our duplicate from the payload, rewrite every reference to the existing UID, retry once. ProgramStage / ProgramIndicator name clashes get suffix-renamed instead. Remaps surface as `_name_conflict_remaps` + `_recovery_note`, and `createFullProgram` syncs its name→ID maps |
| 3 | Case variants slipped through: requesting `DOB` with `DoB` on the server would create a silent near-duplicate (DHIS2 name uniqueness is case-sensitive) | Second case-insensitive reuse pass (`name:ilike:` + exact case-insensitive equality) for anything the exact probe missed |
| 4 | Write-auth guard treated ANY "don't" as full negation — *"don't recreate them, **go ahead**"* was refused | `classifyWriteAuthorization` strips only the verb phrase each negation precedes, then looks for surviving write verbs; explicit declines ("no, don't", "no thanks, leave it") still refuse |

## Guidance / schema hardening

- `program_attributes` items now accept **`id`** to pin an existing TEA (verified server-side
  pre-import; phantom UIDs abort loudly). `value_type` required only for genuinely new TEAs.
- Schema description, `TOOL_SUMMARIES.create_metadata`, `KB_CREATE_PROGRAM_DETAILS`, and the
  atomic-failure `_hint` now state in MUST language: existing attributes (Full name, DoB, Sex,
  National ID, …) are **reused, never recreated**, and an "already exists on object `<UID>`"
  error means *use that UID* — never dodge it with a name variant like "Full name 2".

## Verification (live)

- **User's Tomcat instance (localhost:8081)** — `test-child-health-scenario.js`, 20/20 PASS:
  one-call create_program reuses `Full name`/`Sex`/`DoB` (incl. `DOB` case variant); server
  shows the program bound to the existing UIDs, zero new TEAs; add_program_attributes loads
  the program (no 400) and skips already-attached attributes; a forced duplicate-"Sex" payload
  self-heals (duplicate NOT created, sibling DE created, remap recorded); the transcript
  authorization phrase classifies `broad`; full cleanup, existing TEAs untouched.
- **Playground 2.43** — `test-mixed-attrs-playground.js`, 9/9 PASS: existing "First name"
  reused AND a genuinely new TEA created in the same call (creation not regressed).
- **Regressions:** `test-tomcat-brackets.js` 7/7, `e2e-happy-path.js` 8/8, tool sweep
  failures byte-identical to the pre-change HEAD baseline (stale test arg-shapes, not
  regressions). `node --check` clean on background.js + panel.js.
