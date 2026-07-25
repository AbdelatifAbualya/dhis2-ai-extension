# Tool-router continuity, write discipline, and API-shape healing (v2.8.20)

Three user-reported failures drove this pass, plus a dead-code sweep and a long
tail of API-shape defects found by driving a weak model (MiniMax-M3 on Fireworks)
through a complete DHIS2 build end-to-end.

Everything below is verified live against DHIS2 **2.42.5.1** (`localhost:8081`),
with `npm run verify` extended to **199 assertions**. The acceptance scenario is
committed under `scripts/prompts/` and reproducible.

---

## 1. The tool router forgot the tool on follow-up turns

**Reported:** "I asked the chatbot to use custom translation and change some
strings, then said *remove it and put it back to original* — and it failed to
call the same tool. The bug seems to be that if the prompt itself doesn't have
the tool name it fails at listing them to the LLM."

**Root cause.** `getContextualTools` matched keywords against the CURRENT user
message only. A follow-up like *"now remove it and put it back to how it was"*
names no feature, so `wantsTranslationIntent` was false and
`manage_custom_translations` was never put on the wire.

**Why it is catastrophic rather than cosmetic** — both observed live:

1. **Lookalike substitution.** The model narrates "let me use the correct
   `manage_custom_translations` tool" and emits `manage_custom_forms`
   (`remove_form`), then `manage_metadata(delete dataSets …)`, thrashing until
   the circuit breaker ends the turn. The old "not enabled" refusal actively
   encouraged this — its hint said *"pick the closest available one for the goal"*.
2. **Fabricated success.** Reproduced with a direct provider probe: with no
   suitable tool available the model replies *"Done — I removed the custom
   translation via manage_custom_translations(action='remove')"* and emits **no
   tool call at all**. The user is told the work happened when nothing ran.

**Fix** (`src/core.js`, `src/registry.js`, `src/agent.js`):

- `noteToolUsedThisThread()` / `getThreadToolNames()` — every tool used in the
  conversation stays available for the rest of it. Backed by a per-thread list
  **and** the `tool_calls` still visible in `conversationHistory`, so neither the
  message cap nor the tool cap alone can lose it. Cleared by the new-thread reset.
- `getContextualTools` unions those in *before* the save-diagnosis strip, so the
  safety boundary still wins.
- **Late admission** (`src/agent.js`): a call to a real tool the router simply
  did not select is now *admitted* for the rest of the turn and executed
  (manual gate included), instead of refused. The router guessing wrong must
  cost one extra round trip, never make the task impossible.
- The one genuine boundary is preserved: in read-only save-diagnosis mode a
  destructive tool is still refused, now with a scope of its own
  (`tool_withheld_diagnostic_mode`) and a hint that says how to unlock it.
- The diagnosis strip now iterates the shared `WRITE_CAPABLE_TOOL_NAMES` instead
  of a hand-copied list — the copy had gone stale and was letting
  `manage_custom_translations` and `manage_growth_chart_plugin` through.

## 2. It changed things before it knew the cause

**Reported:** "if there is an issue and the chatbot did some api calls and found
something then it must be 100% sure that this is the cause before it changes
anything. This is a huge problem."

**Root cause — the write gate was wide open on bug reports.** A write verb
inside an *inability* clause counted as consent. Measured before the fix, every
one of these was classified `broad`:

| Message | before | after |
| --- | --- | --- |
| "something is wrong … it's not allowing me to **add** new enrollment" | broad | read_only |
| "I can't **add** a new enrollment" | broad | read_only |
| "it won't let me **create** an event" | broad | read_only |
| "the system is not allowing me to **delete** this" | broad | read_only |
| "unable to **update** the program" | broad | read_only |
| "why can't I **add** a data element?" | broad | read_only |

That is how a pure symptom report authorised rewriting sharing on 4 stages and
15 attributes on an unverified theory.

**Fix** (`src/core.js` `classifyWriteAuthorization`): an inability guard strips
the whole clause — marker (`can't`, `won't`, `unable to`, `not allowing`,
`fails to`, `blocked from`, …), any `me/us/you/I to` filler, the verb, and any
verbs coordinated onto it — then looks for a write verb that *survives*. A
complaint that also carries an instruction ("I can't add an enrollment — **fix**
the sharing please") still authorises. `WRITE_AUTH_PROBLEM_RE` also learned the
generic inability phrasings so the reason reported is accurate.

Supporting changes:

- **Rule 18** in the system prompt: state the symptom, the object+field you
  believe is at fault, and the tool result that PROVES it — before any write.
  Never fix-and-see; never apply a speculative change across a whole class of
  objects; a write that reports no change is *disproof*, so stop; and never
  create/update/delete tracker DATA to "test" a configuration.
- **Rule 19**: verify saved outputs with their own tools, not hand-written
  `/api/analytics` URLs.
- `update_sharing` no longer reports success when the server silently dropped
  what was asked for (see §3).

**Verified live:** the exact reported message now runs read-only — 5 calls, 0
failed, nothing changed, the real cause found and a proposal put to the user.
On "yes, go ahead and fix it" the fault is repaired in one call.

## 3. "add all OUs + fix sharing" made the program disappear

**Reported:** a new *Pharmacy* program stopped appearing in Capture entirely
after asking the assistant to add all org units and fix sharing.

Two defects in `manage_metadata(action=update_program_org_units)`:

- **It wiped every org unit.** `org_unit_ids: []` with the default
  `merge_mode:"replace"` un-assigned the program from all OUs. Now refused
  (`_scope: 'empty_org_unit_replace'`) unless `confirm_remove_all_org_units:true`,
  and a new **`all_org_units: true`** does "add all OUs" in one correct call
  instead of making the model fetch and echo the hierarchy.
- **It silently reset sharing.** The payload was a *partial* program object and
  DHIS2 `/metadata` defaults to **REPLACE**, so every unsent property — sharing
  included — went back to default. That is why "the sharing update was somehow
  overwritten". Now the tool fetches `?fields=:owner` and writes the **whole**
  object back with only `organisationUnits` changed.

Related, same family:

- **Sharing a program now cascades to its stages** (`cascade_to_stages`, default
  true). A programStage carries its own sharing and its DATA bits are what gate
  event capture, so a program on `rwrw----` whose stages sit on `rw------` looks
  correct and still blocks enrollment. `add_stage` also inherits the parent
  program's sharing — three of the four stages in the report had been added that
  way and defaulted to metadata-only.
- **`update_sharing` tells the truth.** `dataShareable:false` classes
  (dataElement, trackedEntityAttribute, optionSet, programIndicator, dashboard,
  visualization) accept a `rwrw----` PUT with HTTP 200 and store `rw------`. The
  metadata half still applies, so this is reported as success **plus**
  `_data_sharing_not_applicable` explaining the drop and saying explicitly not to
  repeat it across sibling objects — which is what turned one confused theory
  into 30 pointless calls.

**Verified live:** stages deliberately broken to `rw------`, then one
`update_sharing` on the program restored all three; sharing/stages/attributes all
preserved; 0 failed calls.

## 4. Dead code removed

- **The inspect subsystem (~370 lines).** `chrome.debugger` and the `debugger`
  permission were removed in "Harden permissions for Chrome Web Store
  submission", which left the consumer half orphaned: `inspectCapture.active`
  could never become true, the side panel never sent `inspect:true`, and
  `buildInspectSnapshot()` could only ever return empty logs. Removed the
  capture object, the parsers, the snapshot builder, the `inspectMode`/
  `inspectSnapshot` plumbing through `runAgenticLoop`/`getContextualTools`/
  `buildSystemPrompt`, and the unreachable "Inspect Mode" prompt block.
- **`line-listing/dhis2_extension_router.js` (227 lines).** An ES-module
  reference artifact that the classic worker cannot even load; its 74 keyword
  routes are duplicated verbatim by `LINE_LISTING_KEYWORD_ROUTES` in `core.js`.
- **`getDhis2MinorVersion()`** — unreferenced.
- Fixed a latent UI bug found while sweeping: the save-error diagnostic
  broadcast `AI_TOOL_RESULT`, which the side panel does not handle, so its tool
  card spun "running" forever. Now `AI_TOOL_DONE`.

## 5. API-shape healing (found by driving MiniMax-M3 end-to-end)

Each of these was a guaranteed failed call, now healed or refused before sending:

| Symptom | Cause | Fix |
| --- | --- | --- |
| 409 `column ax.dx does not exist` | `dimension=dx:` on an event/enrollment analytics endpoint (those take a bare UID) | `healEventAnalyticsDxDimension` |
| 409 `Dimensions cannot be specified more than once: [dx]` | two `dimension=dx:` params | `healDuplicateDxDimension` merges them |
| 409 `A end date was not specified in periods` | several dimensions packed into ONE `dimension=` with `;` | `healPackedAnalyticsDimensions` splits them |
| 404 `analytics/enrollment/query/…` | singular resource name | `healAnalyticsResourcePlural` |
| 405 on `programIndicators/{expression,filter}/description` | that endpoint is POST-only | `dhis2_query` runs the correct POST |
| 500 on an empty expression body | blank filter POSTed to the validator | blank is treated as valid, no call |
| 404 `jobConfigurations/analytics`, `maintenance/analyticsTables`, `resourceTables/analyticsProgramDataElementGroupJob`, … | invented analytics-run endpoints | any POST mentioning "analytic" routes to `resourceTables/analytics` |
| polling loop after starting analytics | no way to know when the job finished | the POST now **waits** (bounded, 180 s) and returns COMPLETED with a "do not poll" hint |
| whole 4-indicator batch aborted | one transient 500 from the advisory validator read as "invalid" | 5xx/network is INCONCLUSIVE, retried once, then deferred to VALIDATE→COMMIT |
| healthy analytics run reported FAILED | any ERROR-level notification treated as fatal (e.g. "skipped stage") | `completed:true` wins; only an explicitly fatal message fails |
| legitimate calls refused as "unknown UID" | `enrollments` is exactly 11 chars and matched the UID shape | preflight now uses the entropy check `isLikelyDhisUid` |
| verification turns cut off mid-way | the discovery-streak guard fired on read-only turns, where there is no write to redirect to | guard skips when the turn has no write authorization |

Plus two correctness fixes:

- **`A{…}` option literals in program rules were never rewritten.** The
  option-literal linter scanned only `#{…}`, so an attribute compared to a
  display name (`A{clinical_diagnosis} == 'Neonatal Tetanus'`) saved clean and
  **never fired**. Both linters now scan `#{}` and `A{}`, preserving the sigil.
- **`A{Display Name}` in a PROGRAM INDICATOR is now rejected.** DHIS2's own
  `/description` validator returns status OK for it, so the indicator saves and
  only detonates later at dashboard render time with HTTP 500
  `Cannot invoke "…Token.getText()" because "ctx.uid0" is null` — a permanently
  broken tile with an unreadable cause. PIs need UIDs (`A{teaUid}`,
  `#{stageUid.deUid}`); program *rules* are the ones that take names.

## 6. Tracker write path

Hardened while investigating, then **confirmed against the pristine code to be a
strict improvement, not a regression**:

| | CREATE | UPDATE |
| --- | --- | --- |
| before | ✗ 409 `DisplayIncidentDate is true but occurredAt is null` | ✗ 409 |
| after | ✓ 3 objects created | ✗ 409 (identical — pre-existing) |

- Legacy pre-2.36 field names (`enrollmentDate`, `incidentDate`, `eventDate`,
  `dueDate`, `trackedEntityInstance`, `trackedEntityAttributes`) are renamed to
  the current Tracker API names, which the server otherwise silently ignores.
- `occurredAt` defaults to `enrolledAt` (required when `displayIncidentDate`).
- Nested events inherit their enrollment's `trackedEntity` and `orgUnit`.
- Empty-string id fields are dropped rather than sent as `""` (which 400s the
  whole bundle), and duplicate ids within one bundle are de-duplicated.
- Readable ids (`VPD-CASE-001`) are remapped to real UIDs with every reference
  kept consistent — **on CREATE only**: on UPDATE/DELETE the id names an
  existing record, so minting one would silently retarget the write.
- An enrollment referencing a tracked entity the payload never creates is
  refused before sending, with the correct nested shape in the hint.
- Duplicate values for a UNIQUE attribute are caught in-payload.

> **Scope note.** Creating enrollments is *not* what this assistant is for. The
> acceptance scenario seeds its sample cases directly through the Web API
> (`scripts/seed-vpd-data.js`), and the assistant is only asked to VERIFY that
> the analytics outputs render. The hardening above exists so that a tracker
> write the user explicitly asks for behaves correctly — not to encourage them.

---

## Acceptance test

Sourced from the WHO/DHIS2 **VPD Case Surveillance** standard package
([design docs](https://docs.dhis2.org/en/implement/health/disease-surveillance/vpd-case-surveillance/design.html)).
Driven by **MiniMax-M3** (Fireworks), against DHIS2 2.42.5.1.

| Turn | Work | Calls | Failed |
| --- | --- | --- | --- |
| 1 | Tracker program: 5 attributes, 3 stages, 16 data elements, 6 option sets, 4 program rules, all OUs, public sharing | 47 | **0** |
| 2 | 5 program indicators (incl. two single-PI percentages) + analytics run | 29 | **0** |
| 3 | 3 visualizations (COLUMN / PIVOT / SINGLE_VALUE), 2 line lists, dashboard, public sharing | 39 | **0** |
| — | *(harness seeds 8 cases / 36 objects directly via the API)* | — | — |
| 4 | Verify all 11 outputs render real data | 36 | **0** |
| 5 | Sharing fault diagnosed **read-only**, nothing changed, user asked | 2 | **0** |
| 6 | "yes, go ahead and fix it" → stage sharing repaired via cascade | 15 | **0** |

Independently confirmed against the API rather than the model's own report:
5/5 program indicators return values (50.0 %, 50.0 %, 1, 1, 2), both line lists
return rows, all 3 visualizations resolve to real program indicators, and the
dashboard carries 5 wired items.

Reproduce:

```
npm run verify                                   # 199 assertions
node scripts/llm-run.js scripts/prompts/vpd-1-program.txt …   # see the file headers
DHIS2_BASE=http://localhost:8081 DHIS2_AUTH=admin:district node scripts/seed-vpd-data.js
```
