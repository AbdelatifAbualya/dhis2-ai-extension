# v2.8.23 — Sticky stage context + actionable blocked-delete recovery (2026-07-28)

Two serious failures reported live from one session on localhost:8081 (W4W Clinic, 8 stages).

## Failure A — "The chatbot can't see what stage I'm in"

The user was inside a stage, asked to add a section to "this stage", and the model replied it
couldn't tell which stage — while the context bar showed only `STAGES 8`.

### Root-cause chain

1. `pageContext` was rebuilt from the **raw URL** on every hashchange, tab activation, window
   focus change (`syncFromTab`), and chat turn (`CHAT_MESSAGE`) — and Capture's URLs are
   context-poor:
   - enrollment dashboard: `#/enrollment?enrollmentId=…&programId=…` — **no stageId**
   - event edit: `#/enrollmentEventEdit?eventId=…&orgUnitId=…` — **no programId, no stageId**
   - new event: `#/enrollmentEventNew?…&stageId=…` — the only stage-carrying route
   So a stage resolved once (from an event fetch or DOM detection) was erased moments later by
   the next rebuild.
2. `content.js` sent `DHIS2_STAGE_DETECTED` **only when the stage changed**, so after any wipe
   (or MV3 service-worker restart) the stage was never re-sent.
3. The DOM fallback returned the *first* "expanded" stage widget — but the enrollment dashboard
   expands **all** widgets by default, so on builds where the selectors match it could report a
   wrong stage. (Verified live: production Capture ships **no** `data-test` attributes on stage
   widgets at all, so DOM detection is a dev-build-only channel.)
4. Even when a stage WAS in context, the side panel never displayed it — only the stage count.

### Fixes

| File | Change |
| --- | --- |
| `src/core.js` | New `carryStickyContext(freshCtx, prevCtx)`: keeps the resolved program/OU/TEI on event- or enrollment-scoped URLs, and the known stage within the same program. A stage in the fresh URL always wins; a **different eventId voids the carry**; leaving the program drops everything. Applied inside `initializeFromUrl` (stage stickiness after event/enrollment resolution). |
| `src/core.js` | `initializeFromUrl` now also resolves **enrollment-only URLs** via `tracker/enrollments/{id}?fields=program,orgUnit,trackedEntity` (mirrors the existing event resolution), and clears stale metadata **after** resolution instead of before. |
| `src/agent.js` | `syncFromTab` same-server path and the `CHAT_MESSAGE` context refresh now run the fresh URL parse through `carryStickyContext` — tab/window focus changes and chat turns can no longer downgrade context. Side benefit: on event-edit routes the carried programId prevents a needless full metadata re-fetch every turn. |
| `content.js` | Stage detection re-sends the current stage every 30 s (background no-ops when unchanged) so wipes/SW restarts self-heal; DOM fallback requires a **unique** match before reporting. |
| `sidepanel/panel.js` | Context bar shows `Stage <name>` when an active stage is known (stage count only as fallback). |

## Failure B — the blocked-delete flail

User deleted the events holding values for duplicate DEs, then asked to delete the DEs. DHIS2
**soft-deletes** events, the soft-deleted rows still block DE deletion (E4030 "associated with
another object: Event"), and nothing named the fix — so the model flailed: analytics probes,
privacy-refused tracker reads, `count_records`, and four random `maintenance/*` guesses whose
**successful** empty-200 responses were all reported as errors.

### Fixes

| File | Change |
| --- | --- |
| `src/core.js` `safeDhis2Fetch` | Non-OK responses now surface the metadata import report's per-object `errorReports` messages in `_error`/`error_details` (was: "please see full details in import report" with no details). Any "associated with another object: Event" failure attaches a `_hint` with the exact recovery: `POST maintenance?softDeletedEventRemoval=true` (param verified against the live 2.42 openapi spec), retry the SAME delete once, and never probe analytics/tracker/count tools for a blocked delete. |
| `src/core.js` `safeDhis2Fetch` | **Empty-body 2xx POST/PUT responses are successes** — the `/maintenance` family and collection-add endpoints idiomatically return HTTP 200 with an empty body. (DELETE keeps its existing fallback; GET keeps the error.) |
| `src/core.js` | `RESERVED_UID_SHAPED_WORDS` += `dataPruning` — an 11-char camelCase endpoint segment that passed the UID entropy test and got `maintenance/dataPruning` refused as a hallucinated UID. |
| `src/tools-programs.js` | `manage_metadata(action=delete)` propagates `safeDhis2Fetch`'s `_hint`/`error_details` on HTTP-level failures, and its own E4030 hint now teaches the soft-delete recovery (options: keep as orphan / maintenance removal / delete remaining real events). |
| `src/registry.js` | `manage_metadata` docs: E4030-after-user-deleted-events recovery added to the delete workflow. |
| `src/providers.js` | Patient-data privacy refusal hint now states that ALL patient-level endpoints are equally blocked this turn and metadata tasks never need patient rows — one refusal no longer cascades into more refused calls. |

## Verification

- `npm run verify` — all green; **new regressions**: 7 `carryStickyContext` cases (keep within
  program, drop across programs, event-URL program carry, different-event voids stage, fresh-URL
  stage wins, null prev, leaving flow) and `extractUidsFromCallArgs` dataPruning exemption + real
  UID still extracted.
- **New live scenario** `scripts/scenario-soft-deleted-de.js` (localhost:8081, real
  `executeTool`): builds a scratch DE + event program + event with a value, soft-deletes the
  event Capture-style, then asserts: blocked delete returns E4030 **with** the
  `softDeletedEventRemoval` hint → `dhis2_query POST maintenance?softDeletedEventRemoval=true`
  reports **success** (empty 2xx) → retried delete **succeeds** → teardown probes 404 →
  **0 unexpected failed API calls** across the counted tool window, instance left exactly as
  found.
- Stage context verified live in Capture on localhost:8081: `enrollmentEventNew` carries
  `stageId` in the URL; `enrollmentEventEdit` resolves via the event fetch; the enrollment
  dashboard preserves the previously known stage; the side panel shows the `Stage` chip.
