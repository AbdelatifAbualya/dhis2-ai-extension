# v2.8.15 — `manage_line_lists`: full Line Listing authoring (eventVisualizations)

Adds a new first-class tool that authors the saved line lists of the DHIS2 **Line
Listing** app (`/api/eventVisualizations`, `type: LINE_LIST`) — the capability a
senior implementor uses to build case registers, treatment-monitoring tables and
person directories — plus dashboard embedding for them. Deep-tested end-to-end
against a live DHIS2 2.42.5.1 (localhost:8081) until the full complex scenario
ran with **zero errors and zero failed API calls** (104 calls in the final run).

---

## 1. New module `src/tools-linelists.js` (~700 lines) — `manage_line_lists`

**Actions:** `list / get / create / update / delete / validate`.

**What create does that a raw POST cannot:**

1. **Zero-invention dimension resolution.** Every column/filter is resolved
   against the program's REAL metadata (2 reads: program w/ stages+PSDEs+TEAs,
   program indicators). Dimensions are accepted as UIDs *or exact display
   names*; DE stages are auto-resolved (explicit `program_stage_id` only needed
   when a DE lives in several stages); programs/legend sets resolve by name too.
2. **Output types**: `EVENT` (row per event of one stage — stage by UID or
   name, auto when unambiguous), `ENROLLMENT` (row per enrollment, cross-stage
   columns), `TRACKED_ENTITY` (row per person; requires + auto-attaches the
   program's trackedEntityType — the API rejects TE payloads without `program`).
3. **Repeated events** (ENROLLMENT + repeatable stage only, enforced):
   `repeated_events:{ oldest:2, most_recent:2 }` → `repetition.indexes
   [1,2,-1,0]`, or explicit `repetition_indexes`.
4. **Filters** validated per valueType: option-set values auto-map NAME→CODE
   (bad values are refused with the full valid-code list), booleans → `1/0`
   (how analytics stores them), numeric ops only on numeric types, multiple
   conditions per dimension.
5. **Program-indicator column linting** (each verified live on 2.42):
   - PI `analyticsType` must match the output type (EVENT↔EVENT, ENROLLMENT↔ENROLLMENT).
   - **Division PIs are refused** — per-row evaluation 409s the WHOLE table
     when any row's denominator is 0 (`allow_risky_program_indicator` opt-out).
   - **`aggregationType NONE` is refused** — it generates invalid SQL and the
     entire query fails.
   - **`aggregationType COUNT` + `d2:count…` warns** — it renders a constant
     `1` on every row; the warning names the exact
     `manage_program_indicators(action="update" … aggregation_type:"SUM")` fix.
6. **Layout invariants**: an org-unit dimension is required; EVENT/ENROLLMENT
   lists require a time dimension with periods (relative keywords validated
   against the full DHIS2 list, fixed ISO periods against a period regex);
   per-output-type time dimensions (`event_date` vs `enrollment_date` …);
   statuses validated per axis; sort dimensions must be columns (stage-
   qualified automatically for ENROLLMENT DEs); duplicate dimensions refused;
   duplicate NAME refused with the existing UID (reuse doctrine).
7. **Legend**: `FIXED` (verifies the legend set exists; resolves by name) or
   `BY_DATA_ITEM`; `FILL`/`TEXT`; warns when no numeric column exists to colour.
8. **Pre-flight analytics probe.** Before anything is saved, the tool runs the
   SAME query the Line Listing app would issue. If it fails → nothing is
   created and the error is diagnosed (division-PI candidates, invalid
   dimension, missing period). `data_check`: `warn_empty` (default) /
   `require_rows` / `skip`. **The probe returns ONLY row_count + header names —
   never row values** (privacy: no patient data reaches a remote provider).
9. `update` = full layout rebuild (same spec as create) or own-fields-only
   (layout byte-preserved through a saved→spec→payload round-trip); auto-backup
   first. `delete` = refuses while any dashboard still shows the list, then
   backup + delete. `validate` = re-runs a saved list's query → row_count/
   headers (the "why is my line list broken/empty" diagnostic).

**Live-verified API behaviours baked in:**
- The 2.42 deserializer derives `dataElementDimensions` / `attributeDimensions`
  / `programIndicatorDimensions` / `simpleDimensions` / `repetitions` /
  `relativePeriods` from plain `columns/filters` axes with inline `filter` /
  `programStage` / `repetition` — the tool sends that natural shape.
- `eventStatus/programStatus` are **comma**-separated query params on the
  analytics endpoints (`;` is a 400).
- `totalPages=true` on `/analytics/enrollments/query` fails with an SQL error
  on 2.42 (server bug) — the enrollment probe pages without it.
- The row count lives at `metaData.pager.total` on these endpoints.
- Tomcat rejects raw `[]` in query strings — everything is percent-encoded.

## 2. `manage_dashboards`: EVENT_VISUALIZATION dashboard items

`create_dashboard` and `add_items` now accept
`{ type:"EVENT_VISUALIZATION", event_visualization_id | line_list_id }`,
with the same existence verification as visualization/map items (a bad UID
refuses instead of importing a dead tile). File: `src/tools-metadata.js`.

## 3. Fix: legend-set reference check used an invalid filter (HTTP 400)

`checkMetadataReferences('legendSets')` queried
`visualizations?filter=legendSet.id:eq:…` — not a valid property path on 2.40+
(the schema property is `legend`, klass `LegendDefinitions`), so every
legend-set delete fired a 400 and silently skipped the visualization check.
Now `legend.set.id:eq:…`, and saved line lists (`eventVisualizations` with a
FIXED legend) are checked too. File: `src/tools-programs.js`.

## 4. Registry / selection / docs wiring

- `TOOLS` schema + `TOOL_ROUTER` + `MANUAL_TOOLS` (slim wire def + first-call
  manual gate) + `TOOL_SUMMARIES` + `MANUAL_EXTRAS` (`KB_LINE_LISTS_DETAILS`:
  output-type choice, the senior workflow — PIs → legend → line list →
  validate → dashboard — row-safe PI patterns incl. the SUM/COUNT/NONE
  aggregation trap, filter/period/org-unit reference).
- `getContextualTools`: `wantsLineListIntent` ("line list(ing)", "case/patient
  register", authoring verb + row-level noun…) surfaces the tool with its
  companions (`get_program_info`, `search_metadata`,
  `manage_program_indicators`, `manage_legend_sets`, `manage_dashboards`);
  always surfaced inside the Line Listing app; write-capable (backups ride
  along) and stripped in save-diagnosis read-only mode.
- `background.js`: new module loaded between `tools-programs.js` and
  `agent.js` (verify + live-harness auto-discover it). `src/agent.js`:
  progress label.

## 5. Deep test: `scripts/scenario-line-lists.js`

Recreates a full senior-implementor package on the live instance through the
real `executeTool` pipeline: 2 row-safe ENROLLMENT PIs (`d2:count`,
`d2:countIfValue`, aggregation SUM) → traffic-light legend set → EVENT case
register (option-code filter, boolean column, sort DESC) → ENROLLMENT
treatment-monitoring list (repeated adherence columns [1,2,-1,0], PI columns,
FIXED FILL legend, classification + program-status filters) → TRACKED_ENTITY
women's directory → dashboard with all three as EVENT_VISUALIZATION tiles →
validate/get/list/update round-trips → delete-guard → full cleanup. Plus 8
negative paths that must refuse mechanically with **zero failing HTTP calls**
(division PI, wrong analyticsType, NONE aggregation, bad option code,
repetition on non-repeatable stage, missing time dimension, sort on
non-column, duplicate name).

**Final run: 104 API calls, 0 failed, all 38 assertions green.** The rendered
result was verified visually in the Line Listing app and Dashboard app
(repeated columns, option labels, legend FILL bands, per-case PI values 1–6).

## 6. Version

`manifest.json` 2.8.14 → 2.8.15.
