# Repeated-failure guard + liveness heartbeat (v2.8.1)

Fixes two production incidents observed while building an MCH tracker program (2026-07-06):

1. **The retry disaster.** `manage_program_indicators(create)` failed server-side validation
   ("Program indicator filter rejected by DHIS2 server: Expression is not valid") and the
   model re-sent the *identical* call dozens of times until the 50-iteration budget was
   exhausted, ending with the dead-end message *"Reached maximum iterations. Try a more
   specific question."*
2. **False "stopped responding".** On a second run the panel showed *"The assistant stopped
   responding (background worker interrupted or upstream timeout)"* … and then the run visibly
   continued and completed. The worker had never died.

---

## Root causes

### Incident 1 — why nothing stopped the retries

The only runaway-loop brake was the per-turn HTTP-error counter
(`noteHttpErrorFromResult` → `httpErrorStopOrNull`, blocks everything after 3 × 4xx/5xx).
But DHIS2's expression validators (`/programIndicators/expression/description` and
`/filter/description`) return **HTTP 200 with `{status:"ERROR"}`** — the tool surfaces
`_error` with no `_status ≥ 400` and no status code in the text. The counter never
incremented, preflight never blocked, and the model was free to repeat the same doomed call
48 times. Every deterministic HTTP-200-failure (validation rejections, lint failures,
`success:false` import conflicts) had the same hole.

### Incident 2 — why the panel declared the worker dead

`sidepanel/panel.js` runs a 90-second watchdog that is reset only by "life signals"
(`AI_THINKING`, `AI_TOOL_CALL`, `AI_TOOL_DONE`, `AI_STREAM_*`). While the model generates a
**large tool-call payload** (e.g. a whole-program `create_metadata` argument object, minutes
of tokens), the SSE stream delivers only `tool_calls` deltas — which broadcast **nothing**.
90 s of that silence ⇒ watchdog fires ⇒ error message ⇒ the loop later broadcasts again and
the UI "resumes". Additionally, a genuinely hung SSE body (`reader.read()` never resolving on
a half-dead connection) had **no timeout at all** — only connection establishment was
time-limited.

---

## Fixes (background.js)

### A. Per-turn repeated-failure guard (new, ~140 lines near `httpErrorStopOrNull`)

Tracks every failed tool call (any `_error` or `success === false`, regardless of HTTP
status) in two per-turn registries seeded in `_runAgenticLoopInner` and excluded from
persistence via `PER_TURN_DHIS2_FIELDS`:

- `dhis2.failedCallSigs` — Map keyed by `tool|stableStringify(args)` (sorted-key stringify, so
  arg order can't evade it) → `{count, error, transient, successMark, blockedAttempts}`.
- `dhis2.toolErrorFamilies` — Map keyed by `tool:action|<normalized error>` (UIDs → `<uid>`,
  digits → `#`) → failure count. Catches "same error, slightly different args".
- `dhis2.toolSuccessCount` — successes counter used for the prerequisite-fix bypass.

Enforcement in `preflightCheckCall` (runs before EVERY dispatch, including discovery tools):

| Situation | Behavior |
| --- | --- |
| Identical call already failed (deterministic error) | **Blocked from the 2nd attempt** — refusal quotes the previous error and instructs the model to change the input or stop and report. |
| Identical call already failed (transient error: timeout/network/5xx/429) | One identical retry allowed, blocked from the 3rd. |
| Another tool call **succeeded** since the failure (e.g. a missing option set was created) | ONE identical retry is allowed again (`successMark` bypass) — a failed retry re-blocks. |
| Model re-sends a **blocked** call | Refusal escalates (`blockedAttempts ≥ 2` demands an immediate final answer). |
| Same tool+action fails ≥ 2× with the same error family | The failing result's `_hint` is enriched: "failure #N … identical retries are BLOCKED … fix or stop". |
| Same tool+action fails **4×** with the same error family (any args) | **Hard block for the turn** (`same_error_family_limit`) — the refusal instructs the model to give the user a final answer: what was created (names+IDs), the exact server error, one concrete next step. |

Blocked calls never touch the network — the refusal is generated locally, so a runaway model
costs zero API churn.

### B. Budget-exhaustion final summary (end of `_runAgenticLoopInner`)

When the 50-iteration budget is exhausted, the loop now pushes a transient system message
("TOOL BUDGET EXHAUSTED — write your final answer NOW: what succeeded with IDs, what failed
with exact errors, recommended next step") and makes **one final tool-free provider call**,
streaming the result to the panel like a normal answer. The old dead-end text remains only as
a fallback if that call fails. History persistence matches the normal end-of-turn path.

### C. Liveness heartbeat + watchdog probe

- `acquireKeepalive`'s 20 s interval now also broadcasts `{type:'AI_HEARTBEAT'}` — held for
  the whole agentic run, so silent phases still prove liveness.
- New `AGENT_STATUS` message handler responds `{alive:true, busy: swKeepaliveRefs > 0}`. A
  restarted worker answers `busy:false` (refs reset on restart), which is exactly the "task
  lost" signal the panel needs.
- Both SSE parsers broadcast a progress label (`Composing action… (~N tokens)`) every 80
  tool-argument deltas — the user sees activity during multi-minute payload generations.

### D. Stream stall guard + transparent retry

- New `readSseChunkWithStallGuard()` wraps every `reader.read()` in both provider parsers
  (OpenAI-compatible + Anthropic): 120 s with zero bytes mid-stream ⇒ cancel the reader and
  throw "LLM stream stalled…" instead of hanging forever.
- The agentic loop catches that error: if **nothing was streamed to the panel yet**, the
  iteration is retried transparently (up to 2×, `messages` untouched so the request is safely
  repeatable); otherwise the error surfaces normally.

## Fixes (sidepanel/panel.js)

- `AI_HEARTBEAT` added to `LIFE_SIGNALS` (resets the watchdog).
- The watchdog no longer declares death on silence alone: it first probes the worker with
  `AGENT_STATUS`. Alive + busy ⇒ quietly re-arm and keep waiting. No reply, or alive but
  idle (= worker restarted and lost the in-flight task) ⇒ show the (reworded, actionable)
  error.

## Verification

- `node --check` passes on both files; `manifest.json` valid, version 2.8.0 → 2.8.1.
- **27 unit checks** (scratchpad `test_retry_guard.js`) against the extracted guard code:
  identical-block, key-order evasion, family escalation/limit, action isolation
  (`action=list` never blocked by `action=create` failures), transient allowance,
  success-bypass, success/manual/idempotent results never recorded.
- **15-check E2E** (scratchpad `harness/e2e-retry-guard.js`) driving the REAL
  `runAgenticLoop` + real `executeTool` against live playground `stable-2-43-0-1` with a
  scripted provider replaying the disaster: identical repeats ⇒ exactly 1 real execution,
  ≤ 2 validation calls (was ~48), repeats blocked locally, streamed FINAL SUMMARY returned;
  varied-args ⇒ exactly 4 executions then family hard-block; zero metadata committed.
- **8-check happy-path E2E** (`harness/e2e-happy-path.js`): a valid PI create flows through
  the loop untouched by the guard, ends via the normal path, `AGENT_STATUS` probe answers
  `{alive:true,busy:false}`; test indicator deleted from the playground (no leftovers).

## Real DHIS2 quirk worth remembering

`POST /api/programIndicators/{expression|filter}/description` returns **HTTP 200 +
`{status:"ERROR", message:"Expression is not valid"}`** for a bad expression — never a 4xx.
Any "too many errors" brake keyed on HTTP status is blind to it; brakes must key on the
tool-result payload (`_error` / `success:false`), which is what the new guard does.
