# Fix: infinite loop when replacing a dashboard tile with a new (program-indicator) visualization

**Reported:** 2026-07-13 — self-hosted DHIS2 at `localhost:8081`.
**User message (verbatim, typos included):**
> remove this visulization Monthly Screening Trends by Method from the dahboard and replace it
> with a visulization that show percentge of male vs females that are enrolled in the program,
> note that you likely need to create an incdicator for this to work

**Symptom:** the model called the dashboard tool's `list` action ~45 times in a row — each one
succeeding — while narrating "Now let me proceed… I'll create the program indicators and update
the dashboard," never issuing a single create/update, until it hit the 50-iteration budget and
gave up. Nothing was created; the dashboard was untouched.

Program in the report: `mqAdJnBK2Ve` (Cervical Cancer Screening and Treatment Tracking).
Dashboard: `nUS9nm5dEAn`. Tile to remove: item `MPX6LizhfyZ` ("Monthly Screening Trends by Method").
Sex attribute: `WCffUc0Cp2j` (options `MALE` / `FEMALE`).

---

## Root cause (four compounding defects)

1. **The tool the task needed was never offered (root cause).** On the Dashboard app,
   `getContextualTools` surfaced `manage_dashboards`, `create_metadata`, `manage_metadata`,
   `manage_maps` — but **not** `manage_program_indicators`. The user's metric ("% male vs female
   *enrolled*") is a tracker **program** indicator (`V{enrollment_count}` filtered by the Sex
   attribute), which only `manage_program_indicators` can create. `create_metadata` cannot add a
   standalone program indicator to an existing program. Worse, the intent regexes look for the
   word "indicator" / "dashboard", and the user typed **"incdicator"** and **"dahboard"** — every
   keyword missed, so even the aggregate `manage_indicators` was not offered. The model correctly
   reasoned it needed to "create the program indicators" but had no tool to do it.

2. **Out-of-context tool calls were dropped silently (loop amplifier).** When the model emitted a
   call to a real tool that wasn't selected for the turn, the agentic loop filtered it out of
   `msg.tool_calls` and appended **no tool result and no feedback**. A temperature-0 model with
   identical history produces identical output, so it re-emitted the same (invisible) call every
   iteration and got zero signal that anything was wrong.

3. **The circuit breaker only caught *failures*.** Every existing guard
   (`repeatedFailureStopOrNull`, HTTP-error counter, same-error-family) triggers on a **failed**
   call. The model's repeated `manage_dashboards(list)` calls **succeeded** every time, so no
   guard ever fired. There was no protection against a call that keeps succeeding with the same
   useless result — the definition of a no-progress loop.

4. **`get_program_info` could not target a program by id/name.** It only worked on the page-context
   program and returned "No program in context." on the Dashboard app — even though the model knew
   the program UID (`mqAdJnBK2Ve`). It had no `program_id` / `program_name` parameter, so the model
   floundered early trying to inspect the program's attributes.

---

## Fixes

### A. Surface the chart-metric tools on any dashboard / data-visualizer turn
**File:** `src/registry.js` — `getContextualTools`, the `wantsDashboardIntent || isDashboard || isDataViz` block.

A chart plots indicators, and "replace this tile with one showing <a metric that doesn't exist
yet>" is a routine request — so a dashboard/viz turn must be able to **create** the data item the
new chart needs. Added, alongside `manage_dashboards`:

```js
selected.add('manage_program_indicators'); // tracker / enrollment metrics
selected.add('manage_indicators');         // aggregate ratios
selected.add('get_program_info');          // inspect stages / attributes for the PI expression
```

The model picks the right one from their descriptions. These are slim `MANUAL_TOOLS` summaries on
the wire, so the token cost is negligible — and the fix is **typo-proof** (it keys off the app,
not the spelling of "indicator").

### B. Every tool_call gets a result — never a silent drop
**File:** `src/agent.js` — the tool-dispatch section of the agentic loop.

Replaced the `validToolCalls` filter-and-drop with a loop over **all** `tool_calls`. A call we
can't run now returns an explanatory `role:"tool"` result instead of vanishing:

- **Unknown tool** (`_scope: 'unknown_tool'`) — "that tool doesn't exist; here are the tools you
  do have."
- **Real tool, not enabled this turn** (`_scope: 'tool_not_enabled'`) — names the available tools
  and the right alternative (e.g. tracker PIs → `manage_program_indicators`). It is **not**
  executed: the contextual set is sometimes a deliberate safety boundary (the read-only
  save-failure diagnostic mode strips destructive tools), so an unselected tool must never run.

Keeping the call in `msg.tool_calls` and answering it also keeps every provider happy — Anthropic
requires exactly one `tool_result` per `tool_use`.

### C. No-progress circuit breaker for repeated identical *successful* calls
**File:** `src/core.js` (`noteExecutedCall`, `noProgressStopOrNull`, wired into `preflightCheckCall`);
`src/agent.js` (records each dispatch; adds `no_progress_repeat` to the loop-block scopes).

Counts identical `(tool, args)` **executions** per turn (byte-stable signature, key order
independent). After `NO_PROGRESS_REPEAT_LIMIT` (3) identical runs that each returned the same
result, further identical calls are refused with an actionable directive ("stop re-checking; take
the next concrete action or answer"). The refusal feeds the existing mechanical circuit breaker,
so after 3 blocks the tool is removed from the wire schema and the model physically cannot call it
again. The limit is generous enough that a legitimate build (e.g. list a dashboard before and
after a write) never trips it — a 3rd byte-identical execution is a loop, not progress.

**Proven end-to-end** (fresh-state simulation of the exact failure): a temp-0 model repeating
`manage_dashboards(list)` now runs **3** executions, is blocked, and the tool is **disabled at
iteration 6** — the loop exits at iteration 7 instead of grinding to the 50-iteration budget.

### E. Refuse tracker data elements as visualization/map data items (the "3 of 5 tiles broken" defect)
**Files:** `src/tools-metadata.js` (`resolveDataItemTypes`, `buildVisualizationObject`, `manage_maps` create), `src/registry.js` (create_visualization doc).

The **same report** noted the dashboard was built with 5 tiles but only 2 rendered; the other 3
showed errors. Root cause: `create_visualization` typed every data element as the aggregate
`DATA_ELEMENT` dimension without checking `domainType`. The 3 broken tiles each plotted a
**TRACKER-domain** data element ("Screening Method Used", "Screening Assessment Result",
"Treatment Intervention Type") as an aggregate `dx` item with no program attached — which the
analytics engine rejects at render time. The 2 that worked used a program indicator and a map.

`resolveDataItemTypes` now fetches `domainType` and classifies a TRACKER data element as
`TRACKER_DATA_ELEMENT`; `buildVisualizationObject` (shared by create_visualization,
create_dashboard-with-inline-vizzes, and add_items) and the map `create` path **refuse** it with an
actionable message: create a program indicator that aggregates the data element (now possible on
dashboard turns thanks to fix A), then plot that. Aggregate data elements, aggregate indicators and
program indicators are unaffected. Verified against `localhost:8081`: the three broken-tile UIDs are
all `domainType: TRACKER`, so the guard fires on exactly the items that were failing.

### D. `get_program_info` accepts `program_id` / `program_name`
**Files:** `src/registry.js` (schema + description), `src/tools-metadata.js` (handler).

Added `program_id` and `program_name` parameters (resolved via the existing
`resolveProgramForRecentChanges`). The handler computes an effective program and uses it for every
query and label; page-context-only stage-name guards are skipped when targeting a different
program (`usingContextProgram`). The tool now works from the Dashboard app instead of dead-ending
on "No program in context."

---

## Verification

- `npm run verify` — all checks pass, including new assertions:
  - no-progress guard blocks after 3 identical executions (`no_progress_repeat`), leaves different
    args / different tools alone, and is key-order independent;
  - the **exact typo'd** report message on the Dashboard app now surfaces
    `manage_program_indicators`, `manage_indicators`, `get_program_info` (and still
    `manage_dashboards`);
  - `get_program_info` schema exposes `program_id` / `program_name`.
- Loop-termination simulation (fresh module load): disaster terminates at iteration 7/50.
- Live check against `localhost:8081` (the reported instance): program, Sex attribute, and
  dashboard items match the report; DHIS2 validated the required PI pieces —
  `V{enrollment_count}` → *"Enrollment count"* and `A{WCffUc0Cp2j} == 'MALE'` → *"Sex == 'MALE'"* —
  confirming the task is now completable end-to-end.
