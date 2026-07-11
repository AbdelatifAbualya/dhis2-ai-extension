# v2.8.13 — create_program no longer dead-loops on one bad rule (skip-and-continue + mechanical circuit breaker)

**Date:** 2026-07-12
**Branch:** `enhance-performance`
**File:** `background.js` (+ `manifest.json` version)

## What the user hit

Prompt: "set up a brand new DHIS2 Tracker Program 'Tuberculosis Case Surveillance
and Treatment' …" (5 attributes, 3 stages, ~6 rules, 3 program indicators), model
**grok-4.5**. The turn collapsed into a visible loop of red rows:

```
create_program … Program rule "Pediatric TB age alert" references unresolved
variable(s): A{date_of_birth} — … Nothing was imported.
create_program … BLOCKED: this exact create_metadata call already failed 1 time(s) …
create_program … BLOCKED …            (repeated ~12×, nothing created)
```

The user reported the **exact same prompt + model + instance worked when the LLM
temperature was changed from 0 to 0.1**. That is the key clue.

## Root cause (two independent defects)

1. **The trigger — atomic hard-fail on one rule.** When any single program rule
   referenced a variable the resolver couldn't match (`A{date_of_birth}` with no
   attribute in the payload sanitizing to `date_of_birth`), `createFullProgram`
   returned `success:false` / "Nothing was imported" and threw away the ENTIRE
   program — all stages, data elements, attributes, other rules, and indicators.
   (Offline test confirms the resolver is correct when a "Date of Birth"
   attribute IS present; it only fails when the attribute is absent or named so
   it can't match, e.g. "DOB".)

2. **The amplifier — an advisory-only retry guard.** The repeated-failure guard
   (`preflightCheckCall`) only *returns an error telling the model to stop*. A
   model at **temperature 0 is deterministic**: identical message history →
   identical output, so grok-4.5 re-emitted the byte-identical create call every
   iteration and ignored every "please stop" until the 50-iteration budget ran
   out. At temperature 0.1 the added randomness let it stumble onto a payload
   whose attribute name matched — which is why 0.1 "worked" and 0 didn't. The
   cause was never the model's strength; it was that a deterministic model has no
   way to escape a guard that only asks.

## Fixes

### 1. Skip-and-continue instead of nuke-everything (the trigger)
`createFullProgram` now builds each rule into local scratch and **skips** (does
not abort) any rule that references an unresolved variable, an unresolvable
stage (HIDEPROGRAMSTAGE/CREATEEVENT), an unresolvable section (HIDESECTION), or a
known-broken boolean condition. The program + stages + DEs + TEAs + all *valid*
rules + indicators still import. Skipped rules are reported on a **successful**
result as `_skipped_rules`, `_skipped_rules_warning`, and a `_next_step` telling
the model to add them via `manage_program_rules(action=create, program_id=…)` —
so the model does not retry the whole create. The cross-rule visibility-semantics
lint (contradictory combinations) stays a hard error, but is now bounded by the
breaker below.

Net effect for the TB prompt: instead of "created nothing, looped forever," the
user gets the full program created, with a clear "1 rule was skipped, here's why,
adding it now" follow-up.

### 2. Mechanical circuit breaker (the amplifier)
The agentic loop now **counts** how many times each tool is blocked by the
repeated-failure / HTTP-limit guard. Once a tool trips
`TOOL_BLOCK_DISABLE_THRESHOLD` (3) blocks, it is **removed from the wire schema
for the rest of the turn** and a hard directive is injected. A deterministic
model then physically cannot re-emit the call and is forced to answer from what
it already has (or take a different path). A stubborn model that hallucinates the
disabled tool anyway is short-circuited without executing. This bounds ANY
deterministic tool loop — not just create_program — and turns a 50-iteration
budget burn into a ~4-attempt stop. Legitimate fix-and-retry is unaffected: a
changed payload has a different signature and is never counted as a block.

## Verification (offline, no server, real code in a Node VM shim)

- **Resolver unit test:** `A{date_of_birth}` resolves against "Date of Birth" /
  "Date of birth" / "Date of Birth (DOB)"; fails only when absent or "DOB".
- **Skip E2E** through real `createFullProgram`: DOB present → rule created, 0
  skipped; DOB misnamed → bad rule skipped, good rule + program created with a
  real `program_id`, warning + next_step populated.
- **Condition-lint skip:** `#{x} == 'true'` (broken) skipped, valid twin +
  program created.
- **No false skips:** a fully-valid 3-rule program creates all 3, skips 0.
- **Circuit-breaker E2E** through the real agentic loop with a deterministic
  fake provider that always re-emits the same failing call: tool disabled after
  3 blocks, loop ends at 6 provider calls (budget is 50) with a real final
  answer instead of an endless BLOCKED wall.
- `node --check background.js` passes.

## Note on the temperature

Temperature 0 is handled correctly everywhere (no falsy-zero bug — it is sent as
0). The 0-vs-0.1 difference was a symptom, not a cause: it only determined
whether the deterministic model happened to emit a self-consistent payload. Both
fixes make the outcome robust regardless of temperature or model.
