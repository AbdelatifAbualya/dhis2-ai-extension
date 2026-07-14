# Changes — complex-program robustness (weak-model recovery, 0 failed API calls)

Root-caused and fixed from a real failing session: a user gave the chatbot a very
large prompt — the **"Diabetes Care & Complications Tracker"** tracker program (6
profile attributes, 4 stages, 46 data elements, ~20 option sets, 30 program
rules) — running on a **custom OpenAI-compatible provider (MiniMax)**. The bot
dead-looped: the first `create_program` came back `Validation failed with 304
error(s): … Missing required property `name``, then several empty
`create_metadata` calls (`Missing required parameter: action`), the identical-
failure guard + circuit breaker **disabled the tool**, and the model spun on 30+
`check_existing` reads, finally emitting a garbled text tool call with leaked
`]<]minimax[>[` provider tokens.

## Was it the tool or the model? — proven with the live harness

Rebuilt the **entire** Diabetes program as a correct payload and ran the real
`executeTool('create_metadata', …)` against a live DHIS2 2.42 via
`scripts/live-harness.js`: **67 API calls, 0 failed, 242 objects created, all 4
stages / 46 DEs / 30 rules, in ONE atomic call.** So the tool is fully capable —
the failure was the weak model emitting broken/empty/corrupted tool-call JSON,
which the guardrails then amplified into an unrecoverable dead-loop. These fixes
make a recoverable model glitch actually recoverable, so an average LLM finishes
with 0 failed API calls.

Files: `src/tools-programs.js`, `src/core.js`, `src/agent.js`, `src/providers.js`.

---

## 1. `create_program` pre-validates its input client-side (no doomed atomic 304)

**File:** `src/tools-programs.js` — new `validateAndHealProgramInput()`, called at
the top of `createFullProgram()` before any network request.

**Symptom:** a payload with empty `name`s (weak-model placeholders / a truncated
giant call) was shipped straight to the atomic `/metadata` import, which rejected
the WHOLE program (`Missing required property `name`` ×N), created nothing, and —
because an empty `name` even **500s** the dedup `ilike:` probe — burned the
HTTP-error budget and fed the circuit breaker. Measured on the live instance
before the fix: **3 failed API calls + a 409 atomic reject** for a tiny broken
payload; the real 46-object one produced 304 errors.

**Fix:** a pure, zero-API-call pass that runs first and:
- **auto-heals** cosmetic gaps — a rule with no `name` gets a generated one
  (`<short> <ACTION> <target>` / `<short> rule N`, de-duplicated); an inline
  option set with no `name` inherits its field's name;
- **collects** the gaps DHIS2 would reject and that can't be safely inferred (a
  data element / attribute with no name, a new one with no `value_type`, an
  option set with no options) into **one precise error**;
- **detects truncation** — if ≥25% of name-required objects (or ≥8) lack a name,
  it says the payload looks *incomplete/truncated* and to **re-send the complete
  call**, instead of dumping 150 near-identical "missing name" lines.

The error carries `nothing_created:true`, `_scope:'incomplete_call'` and
`_no_disable:true` (see fix 2). Verified: the empty-name payload now fails with
**0 failed API calls** (was 3 + a 409); a one-placeholder payload **heals and
imports** (server read-back confirms the auto-named rule exists); the full
30-rule program still imports with **0 failed calls**. Auto-name/option-set heals
are surfaced to the model in `_input_heals`.

## 2. Malformed / empty / truncated calls never DISABLE the tool

**Files:** `src/core.js` — new `isIncompleteCallError()`; `repeatedFailureStopOrNull()`
now returns a NON-disabling `incomplete_call_repeat` scope for these. `src/agent.js`
— the circuit-breaker's `isLoopBlock` excludes `_no_disable` / `incomplete_call*`.

**Symptom:** after the 304, the model sent `create_metadata {}` a few times
(`Missing required parameter: action`). The identical-failure guard blocked it,
the mechanical circuit breaker counted the blocks, and at 3 it **removed
`create_metadata` from the tool set for the rest of the turn** — guaranteeing
failure. But an empty/truncated call is a *serialisation* glitch: the fix is
always "resend the complete call", never "stop using this tool".

**Fix:** incomplete-call errors (empty args, `Missing required parameter`,
`Missing required property`, the truncation error from fix 1) are now a distinct
class. The identical/same-family repeat is still refused (no spam) but with
**recovery framing** ("your arguments did not arrive intact — re-send the
COMPLETE call") and a scope that **does not count toward disabling the tool**. A
genuinely doomed operation (a rejected PI expression, a bad UID) still disables
as before. Verified: 6 empty repeats → tool NOT disabled; a real grammar-error
family → still `same_error_family_limit` (disables) — no regression.

## 3. No-progress guard for read-only "research forever" loops

**Files:** `src/core.js` — new `isDiscoveryCall()` / `discoveryStreakStopOrNull()`
in `preflightCheckCall()`; `src/agent.js` — `dhis2.consecutiveDiscoveryCalls`
counter, reset on any successful write.

**Symptom:** once the write tool was disabled the model made **30+**
`architect_metadata(check_existing)` / `discover_icons` calls, each with different
args, each narrating "now I'll build the payload" but never writing. Every
existing guard missed it: args differ (no-progress guard needs byte-identical),
the calls succeed (failure guards), and they're HTTP 200 (http-error guard).

**Fix:** count **consecutive read-only/discovery calls**; reset to 0 the moment a
write succeeds. After 12 in a row with nothing created, refuse further discovery
and point the model at the write ("issue the create_metadata call now — it
auto-reuses existing option sets/DEs/attributes by name, so you don't need to
look each one up first"). If ignored, the `no_progress_repeat` scope lets the
circuit breaker disable the discovery tool so the loop ends. Verified: streak 11
allowed, 12 blocked with the write-pointing hint; write calls never blocked.

## 4. Recover corrupted streamed tool-call JSON instead of silently sending `{}`

**Files:** `src/core.js` — new `repairToolCallArguments()`; `src/providers.js` —
streaming path repairs before the `{}` fallback and flags the unrecoverable case;
`src/agent.js` — a flagged/unparseable call returns an honest, non-disabling
"resend" (and, after 3, steers to smaller calls) instead of executing `{}`.

**Root trigger:** in the streaming provider adapter, any tool-call `arguments`
buffer that failed `JSON.parse` was **silently replaced with `'{}'`**. So when
MiniMax truncated the huge `create_program` payload or leaked `]<]minimax[>[`
separator tokens into it, the model *thought* it sent a full program but the tool
received `{}` → `Missing required parameter: action` → the fix-2 cascade.

**Fix:** `repairToolCallArguments()` strips leaked `]<]word[>[` tokens, balances
truncated braces/brackets, closes unterminated strings and drops trailing commas,
then re-parses. If it recovers, the call runs normally; if not, the arguments are
flagged and the agent loop returns a non-disabling "your tool-call JSON was
truncated/corrupted — re-send the COMPLETE call; if it keeps truncating, split
into smaller calls (shell + first stage, then `add_stage` / `add_program_rules`)".
Verified against the exact transcript tokens: a `create_program` payload with
`]<]minimax[>[` leaks (which fail raw `JSON.parse`) is **repaired and imported
with 0 failed API calls**; truncated/unterminated payloads recover; hopeless junk
correctly stays unrecoverable.

---

## Verification

- Live harness (`executeTool` → localhost DHIS2 2.42): full 30-rule Diabetes
  program imports with **0 failed API calls**; empty-name payload fails cheaply
  (0 failed calls, was 3+409); heal path creates the auto-named rule (server
  read-back); the exact `]<]minimax[>[` corruption is repaired and imports.
- Integrated cascade simulation through the REAL fixed functions: corrupted args
  → repaired → success; 6 empty repeats → tool never disabled; 12 discovery calls
  → streak guard fires. All green.
- `npm run verify` (module load + safety gates) green; `node --check` on all four
  changed modules passes.
- All test metadata deleted; instance left exactly as found (4 pre-existing
  programs intact; the reused pre-existing "Nutritional Status" DE/option set
  correctly preserved by the reference guard).
