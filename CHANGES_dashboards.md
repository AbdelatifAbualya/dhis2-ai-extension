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
