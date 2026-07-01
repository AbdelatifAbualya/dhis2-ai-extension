# manage_dashboards — DHIS2 analytics dashboards & visualizations builder

**Version:** 2.5.0 → 2.6.0 · **Files:** `background.js`, `sidepanel/panel.js`, `manifest.json`

## Why

The extension could READ visualizations (`get_visualization_details`, `get_map_details`) and DELETE /
share dashboards & visualizations (`manage_metadata`), but had **no tool to CREATE** a visualization or
a dashboard. "Build me an ANC dashboard" therefore forced the chatbot down the raw-`dhis2_query`
`/metadata` POST path — the exact route every other authoring tool explicitly warns against.

## The structural trap (proven on the live 2.43 playground before any code was written)

A visualization POST that sets only `columns`/`rows`/`filters` imports with **status OK** but reads back
**empty** and renders nothing — those arrays are derived, read-only views. The real, persisted fields:

| Concern | Correct field(s) |
|---|---|
| Layout (which dim on each axis) | `columnDimensions` / `rowDimensions` / `filterDimensions` — lists of dimension ids (`"dx"`, `"pe"`, `"ou"`) |
| Data items (dx) | `dataDimensionItems` — typed: `{dataDimensionItemType:"INDICATOR", indicator:{id}}` (or `DATA_ELEMENT` / `PROGRAM_INDICATOR`) |
| Relative periods (pe) | `relativePeriods` boolean flags (e.g. `last12Months:true`) |
| Fixed periods (pe) | `periods:[{id:"202401"}]` |
| Org units (ou) | `organisationUnits:[{id}]` + `organisationUnitLevels:[2]` (**plain integers**, not `[{level:2}]`) + `userOrganisationUnit` / `userOrganisationUnitChildren` flags |

`buildVisualizationObject` assembles all of this from a friendly spec, so the chatbot can never ship a
silently-empty chart.

## Actions

- **`list`** — dashboards (optional `name_filter`, `limit`). Read-only.
- **`get`** — one dashboard (`dashboard_id`) with its items and each item's visualization/map/text. Read-only.
- **`create_visualization`** — one chart/pivot/single-value:
  `visualization:{ name, vis_type, data_items:[…UIDs], periods:[…], org_units:[…], short_name?, description?, layout? }`.
- **`create_dashboard`** — a whole dashboard in one atomic import:
  `dashboard:{ name, description? }` + `items:[…]`, where each item is one of
  `{ visualization_id }`, `{ type:"MAP", map_id }`, `{ type:"TEXT", text }`, or
  `{ new_visualization:{ …same fields as create_visualization… } }`.
  Items are auto-placed on the 58-column grid (override per item with `x`/`y`/`width`/`height`).

**vis_type** (16): COLUMN, STACKED_COLUMN, BAR, STACKED_BAR, LINE, AREA, STACKED_AREA, PIE, RADAR,
GAUGE, SINGLE_VALUE, PIVOT_TABLE, YEAR_OVER_YEAR_LINE, YEAR_OVER_YEAR_COLUMN, SCATTER, BUBBLE.
**periods**: relative keywords (LAST_12_MONTHS, THIS_YEAR, LAST_4_QUARTERS, MONTHS_THIS_YEAR, …) and/or
fixed ISO (202401, 2025Q1, 2025). **org_units**: UIDs and/or USER_ORGUNIT, USER_ORGUNIT_CHILDREN,
USER_ORGUNIT_GRANDCHILDREN, LEVEL-`<n>`. **layout** defaults per type (pivot → cols[pe]/rows[dx];
single-value/gauge/pie → cols[dx], pe+ou in filter; charts → cols[dx]/rows[pe]).

## Safety & robustness

- Both create actions are gated by `requireWriteAuth` (refused until the user authorizes writes).
- `resolveDataItemTypes` looks up every `data_items` UID across indicators / dataElements /
  programIndicators in one batched call — resolving its type **and verifying it exists**; a
  hallucinated UID is rejected with a clear error, never silently dropped.
- Referenced existing visualization / map UIDs are existence-checked before import.
- `create_dashboard` imports the new visualizations **and** the dashboard in a single
  `VALIDATE`→`COMMIT` (`postMetadataPayload`, `atomicMode=ALL`), so one bad UID rolls back the whole
  thing — nothing half-built remains.
- Reads/creates only AGGREGATE visualization + indicator/DE/PI/OU metadata → never patient-level data,
  so correctly NOT a `PATIENT_DATA_TOOL_NAMES` member; the `enforcePatientDataPrivacyGate` choke point
  still runs ahead of it.
- DELETE and sharing stay with `manage_metadata`; `render_chart` (inline preview) stays a distinct job.

## Wiring (every layer)

TOOLS array · TOOL_ROUTER · `executeTool` dispatch · `executeManageDashboards` handler ·
`getContextualTools` (`wantsDashboardIntent`, plus Dashboard / Data Visualizer app contexts) ·
`writeCapableNames` · save-failure read-only strip · `buildSystemPrompt` (`wantsDashboardPrompt` + KB) ·
`sidepanel/panel.js` icon/label/detail.

## Verification

- `node --check` passes on `background.js` and `sidepanel/panel.js`.
- Symbol-collision check: every new symbol is unique; the diff is purely additive (no existing tool,
  prompt path, contextual selector, or safeguard modified).
- The **shipped** `buildVisualizationObject` was extracted and run in Node: COLUMN / PIVOT_TABLE /
  SINGLE_VALUE / LINE payloads imported on the live 2.43 playground (`VALIDATE` OK → `COMMIT` OK) and
  read back with correct layout dims, typed `dataDimensionItems`, `relativePeriods`, fixed `periods`,
  `organisationUnitLevels:[2]`, and `userOrganisationUnit*` flags. Error paths (bad vis_type / missing
  UID / empty name) returned `_error` rather than throwing.
- The **shipped** `executeManageDashboards` create_dashboard path was run with stubbed network helpers
  → correct mixed payload (inline viz + existing-viz reference + TEXT tile, grid-packed 0/29/wrap);
  that payload (pointed at a real existing viz) imported end-to-end and read back as a 3-item dashboard.
- All playground test objects deleted; `name:like:ZZAITEST` sweep returned ZERO residue for both
  visualizations and dashboards.
- The 409 `E7144` on `/visualizations/{id}/data.json` during testing is an instance limitation
  (analytics tables not generated on this playground — a pre-existing real viz 409s identically), not a
  structural defect: the built visualizations are shape-identical to native Data Visualizer output.

---

## Update (v2.6.7) — safe mutation of EXISTING dashboards + data-loss guard

The initial tool could CREATE dashboards/visualizations but not safely modify an existing dashboard.
Adding a chart to an existing dashboard therefore still fell back to a raw `dhis2_query` PUT
`/dashboards/{id}` — a **whole-object replace** that silently wipes every tile not in the body
(verified on 2.43: a partial PUT took a 2-item dashboard to 1, HTTP 200, no error). This update
closes that gap.

### New actions (additive; list/get/create_visualization/create_dashboard unchanged)

- **`add_items`** (`dashboard_id` + `items[]`) — the ONLY safe way to add to an existing dashboard.
  Reads the full dashboard (`?fields=:owner`), appends the new tiles grid-packed BELOW the existing
  ones, and writes the COMPLETE item set back (via `postMetadataPayload`). Existing tiles are always
  preserved. Items may be existing `{ visualization_id }`, inline `{ new_visualization:{…} }` (same
  `buildVisualizationObject`, so never an empty chart), `{ type:"MAP", map_id }`, or `{ type:"TEXT", text }`.
  Every referenced object is existence-checked (no broken tiles). **Snapshots to backups first.**
- **`remove_item`** (`dashboard_id` + `item_id`), **`update`** (`dashboard_id` + `dashboard:{name?,description?}`),
  **`delete`** (`dashboard_id`) — read-modify-write / DELETE, each **snapshotted first** → all reversible
  via `manage_backups`.

### Guard + backups + cross-version

- The `dhis2_query` handler now **blocks** raw `PUT`/`PATCH dashboards/{id}`, `POST /metadata` that
  replaces an existing dashboard's items, and raw `POST .../items`, redirecting to `manage_dashboards`.
  The append endpoint, item-level ops, and GETs are unaffected.
- `SNAPSHOT_FIELDS.dashboards` + `dashboards`/`visualizations`/`maps`/`eventCharts`/`eventReports`/
  `eventVisualizations`/`charts`/`reportTables` added to `backupableTypes`. Restore rebuilds a wiped
  dashboard exactly (proven: re-POST of the snapshot brought a wiped dashboard back to full items).
- `resolveAnalyticsFavorite` probes `visualizations`→`charts`→`reportTables`, so `add_items` works on
  2.34+ (unified `visualizations`) AND older servers (`charts`/`reportTables`), storing the item with the
  right type (`VISUALIZATION` vs `CHART`/`REPORT_TABLE`).

### Verification (v2.6.7)

- 19/19 merged-logic assertions (incl. a regression guard that create_visualization is unchanged) +
  9/9 guard-classification assertions.
- Live 2.43: full `add_items` operation 1→2 items with both tiles present; the appended viz reads back
  with `columnDimensions:["dx"]` + `userOrganisationUnit:true` (renderable). Partial-PUT loss (2→1)
  reproduced; ZZAITEST residue sweep = 0.
