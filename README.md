# DHIS2 AI Assistant

> Chrome extension (Manifest V3) that adds an **AI-powered side panel** to any DHIS2 instance. Ask questions in plain English; the assistant queries the DHIS2 API on your behalf, builds analytics, audits program rules and indicators, and authors metadata atomically — programs, datasets, category combinations, sharing, and more.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green)
![DHIS2](https://img.shields.io/badge/DHIS2-2.40%2B-009688)
![Any LLM Provider](https://img.shields.io/badge/AI-Any%20OpenAI--compatible-orange)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow)

---

## What it does

- **Talks to DHIS2 in your active session.** No passwords stored — the extension proxies API calls through the tab you're already logged into. Sign out of DHIS2 and the assistant immediately loses access.
- **Knows where you are.** Detects program / org unit / stage / TEI / dataset / visualization / map from the URL of your active DHIS2 tab. The system prompt narrows itself to the relevant tools and rules every turn.
- **Runs as an agent.** The model picks tools, calls them, reads the JSON, and continues — up to 50 iterations per turn — without you driving the API.
- **Authors metadata atomically.** Programs, stages, data elements, option sets, TEAs, program rules, program indicators, datasets, sections, **category combinations + disaggregation**, sharing, org-unit assignment, icons / colors, all in single bundled `/api/metadata` POSTs with auto-backup before every destructive write.
- **Streams answers and downloads them.** Real-time chat with progress indicators per tool call; every response can be exported as HTML / Word / CSV / JSON.

---

## The 39 tools

Each tool is wired through `TOOLS array → executeTool → TOOL_ROUTER → panel.js iconMap + toolLabels → CSS`. The model is given only the subset relevant to the current page and request — usually 6–12 of them.

| # | Tool | Purpose |
|---|------|---------|
| 1 | `dhis2_query` | Universal DHIS2 API access (any endpoint, any method) with tracker-write support, write-auth gating, save-error context prefetch, and guards against the most common destructive misroutes (sharing PUT, multipart-only endpoints, app-owned dataStore caches, bulk DELETE). |
| 2 | `count_records` | Fast enrollment / event / TEI counts via the analytics endpoint. |
| 3 | `get_event_analytics` | Aggregations, trends, breakdowns, line listings. |
| 4 | `get_program_info` | Full program structure: stages, DEs, rules summary, indicators summary, TEAs. |
| 5 | `get_program_recent_changes` | Audit / change history for program metadata. |
| 6 | `search_metadata` | Search any DHIS2 metadata type by name / code. |
| 7 | `resolve_option_codes` | Batch resolve option codes, DE IDs, and OU IDs to display names. |
| 8 | `detect_enrollment_abnormalities` | Scan enrollments for data-quality issues. |
| 9 | `cross_stage_entity_intersection` | Find TEIs matching conditions across multiple stages. |
| 10 | `line_listing_guide` | Modular guidance for the Line Listing app. |
| 11 | `get_visualization_details` | Load + explain a Data Visualizer chart with resolved names + analytics preview. |
| 12 | `get_map_details` | Load + explain a Maps layer with analytics preview. |
| 13 | `browse_web` | Web search via Tavily (optional). |
| 14 | `render_chart` | In-chat chart rendering via ECharts. |
| 15 | `create_metadata` | Atomic metadata authoring. Actions: `create_program`, `add_stage`, `add_data_elements_to_stage`, `add_program_rules`, `create_option_set`, `create_data_elements` (TRACKER or AGGREGATE, with optional inline category combo), **`create_category_combo`** (bundles options + categories + combo, reuses existing by exact-name match, auto-triggers `/api/maintenance/categoryOptionComboUpdate` so CoCs materialize, applies sharing via the legacy `/api/sharing` endpoint that works for metadata-only-shareable classes). |
| 16 | `architect_metadata` | Schema introspection, duplicate checking, post-create verification, doc browsing. Use BEFORE `create_metadata` for plan + lookup, AFTER for verify. |
| 17 | `manage_program_rules` | CRUD + audit + bulk_fix_conditions for program rules. Lints `==false` / quoted boolean literals before POST; auto-creates missing program-rule variables from `#{name}` references. |
| 18 | `manage_program_indicators` | CRUD + audit + bulk_fix_expressions + cross-program complexity-volume `discover` + `rank_ou`. Pre-validates expressions and filters via DHIS2's own `/programIndicators/expression/description` and `/filter/description` endpoints before saving. |
| 19 | `manage_metadata` | `remove_from_stage`, `delete` (with reference checking), `check_references`, `update_program_org_units`, `update_sharing`, `add_program_attributes`, `update_style` (icon/color, refuses unverified icon keys), `convert_value_type` (TEXT↔MULTI_TEXT cascading flip across DE + OS + every referencing DE/TEA), `discover_icons` (parallel `/icons?search=`, populates a per-turn `knownIcons` set required before `update_style`). |
| 20 | `manage_program_notifications` | Program notification template CRUD + dedicated link/unlink endpoint + `create_and_link`. Encodes DHIS2 quirks: webhook URL goes in `messageTemplate` (no `url` field on schema), subject ≤ 100 / message ≤ 10000, recipient → channel auto-mapping. |
| 21 | `manage_datasets` | Full DataSet CRUD (= "aggregate programs"): list / get / create / update / delete + `add_data_elements`, `remove_data_elements`, `assign_org_units`, `update_sharing`, plus full section CRUD (`create_section`, `update_section`, `delete_section`). Auto-resolves the system default categoryCombo, clamps shortName ≤ 50, defaults sharing to `rwrw----` so users can actually enter data, bundles sections atomically. |
| 22 | `manage_backups` | List / get / restore / delete / purge_old metadata snapshots in the dataStore namespace `dhis2-ai-extension-backups`. Auto-created before every destructive metadata op; 30-day retention. |
| 23 | `manage_custom_forms` | Author **CUSTOM (HTML) data-entry forms** for BOTH dataSets (render in Aggregate Data Entry) and tracker/event **program stages** (render in Capture). Actions: `get`, `preview_html` (auto-generate a table form skeleton from the target's DEs without saving), `set_dataset_form`, `set_stage_form`, `remove_form`. Encodes the verified-on-2.43 quirks: a `dataEntryForm` must be created standalone via `POST /api/dataEntryForms` first (it can never be embedded inline — E5002), the input-id binding differs per target (`<de>-<coc>-val` for datasets, `<stage>-<de>-val` for stages), and linking to a program stage re-attaches `program:{id}` on a full PUT (PATCH/naive PUT drops it). Auto-backup before every write. |
| 24 | `manage_custom_translations` | Translate or re-label **any app's UI strings** via the experimental **DHIS2 2.43+** `custom-translations` dataStore namespace — no source-code changes. Actions: `list`, `get`, `set`, `remove`. Keeps the `controller` registry (`{ "<slug>": ["<locale>"] }`) and the per-app key (`<slug>__<locale>`, a `{ "<source string>": "<replacement>" }` map) in sync automatically. Supports both true translation (different locale, e.g. `capture`→`ar`) and same-language rewriting (locale `en`, e.g. "Report data"→"Submit report"). Version-gated to 2.43+; merges by default (`replace:true` to overwrite); returns `previous_value`/`previous_controller` for manual rollback since dataStore keys aren't covered by `manage_backups`. Verified on play 2.43.0.1 — the Capture app fetches both `controller` and `capture__ar` (200) at startup. |
| 25 | `manage_growth_chart_plugin` | End-to-end setup of the **WHO Capture Growth Chart** plugin ([dev-otta/dhis2-who-growth-chart](https://github.com/dev-otta/dhis2-who-growth-chart), App Hub key `capture-growth-chart`). Actions: `status`, `install` (from the App Hub, idempotent), `scaffold_program` (create a ready-to-use growth tracker program), `configure` (auto-detect DOB/gender attributes + female/male option codes + weight/height/head-circumference data elements for a program and write/merge the `captureGrowthChart/config` dataStore key), `remove`. Validates the plugin's hard requirements (DOB + gender attribute, all three measurement DEs) and refuses with a precise missing-items list. Infers `weightInGrams` from the weight DE name. Surfaces a `dashboard_attach` block (plugin source URL + steps) rather than auto-writing the Capture-owned `dataStore/capture` dashboard layout. Verified on play 2.43.0.1: app installed via `POST /api/appHub/{versionId}`, a full program + 3 measurement DEs + enrolled child created, and `captureGrowthChart/config` written and read back. |
| 26 | `manage_validation_rules` | Aggregate data-quality validation rules — CRUD + server-side expression validation before save. |
| 27 | `manage_org_units` | Organisation-unit hierarchy CRUD with cascade/reference checks. |
| 28 | `manage_indicators` | Aggregate indicators (numerator/denominator) — CRUD, expressions server-validated, legend-set attach. |
| 29 | `manage_option_sets` | Option-set lifecycle: create/update/add/remove/reorder/delete with per-set unique codes. |
| 30 | `manage_legend_sets` | Colour-coded legend sets; `auto_bands` generates equal-width red→green ramps. |
| 31 | `manage_dashboards` | Dashboards + visualizations: list/get/create, safe `add_items`/`remove_item`/`update`/`delete` with pre-write snapshots. |
| 32 | `manage_maps` | **Thematic map authoring** (choropleth / bubble): `list`/`get`/`create`/`delete`. Assembles a thematic mapView from a friendly spec — data item on `columns[dx]` (type auto-resolved, program auto-attached for a program indicator), org units on `rows[ou]` with `organisationUnitLevels`, period on `filters[pe]`, optional legend set — the exact `/api/maps` structure DHIS2 needs (there is no simple "create map" object). Returns `map_id` to embed on a dashboard via `manage_dashboards(add_items, { type:"MAP", map_id })`. Auto-backup on delete. |
| 33 | `manage_line_lists` | Saved Line Listing tables (eventVisualizations LINE_LIST) — EVENT / ENROLLMENT / TRACKED_ENTITY, dimensions by name, layout proven against analytics before saving. |
| 34 | `manage_users` | Users, user roles and user groups: create/update/disable/enable/delete accounts (password policy, org-unit scopes, names → UIDs), roles with authorities validated against `/api/authorities` (DHIS2 silently stores misspelled ones), group membership through the group endpoint. |
| 35 | `manage_data_values` | Aggregate data entry for one dataset × period × org-unit form: get / set / delete / complete / incomplete / validate. Values by data-element and disaggregation NAME; refuses the wrong-period-type, unassigned-org-unit and missing-disaggregation values DHIS2 would silently store invisibly; returns previous values as an undo record. |
| 36 | `manage_metadata_translations` | Translate names / short names / form names / descriptions of any metadata object into a database locale — merges (a raw PUT wipes other locales), validates locale + property keys, bulk up to 100 objects. |
| 37 | `manage_memory` | The assistant's **learning memory**: `search` / `record` / `list` lessons about DHIS2 and API behaviour (what failed and the exact fix). Relevant lessons are also injected automatically — in the system prompt, with a tool's manual, and on a failed call. Stored only in this browser; never patient data (see below). |
| 38 | `manage_custom_app` | **AI-built DHIS2 apps & dashboard plugins.** The model writes React JSX; the tool compiles it, safety-scans and lints it, verifies every hard-coded UID, packages it with a prebuilt runtime kit (React 18 + `@dhis2/ui` + `@dhis2/app-runtime`) and installs it (`POST /api/apps`). Actions: `list`, `get_source`, `preview`, `create`, `update`, `delete`, `rollback`. Only ever touches assistant-built `ai-*` apps; backs up before every change. See [Building apps & plugins](#building-apps--plugins). |
| 39 | `manage_sql_views` | **DHIS2 SQL views** — data no Web API endpoint returns (tracker ownership-transfer history lives only in `programownershiphistory`) and the data source for plugins that need it. `list` / `get` / `describe` (the server's real columns via `information_schema`) / `create` (runs the view once — DHIS2 does not check SQL on save — and removes it if it fails) / `update` / `delete` (backed up) / `run` (column names + row count; rows only for metadata-only views on a cloud model). Pre-checks every server refusal (illegal words, protected tables, version-renamed tables, unset variables, sharing nobody can read) before a request. |

### Page-context auto-detection

`getContextualTools()` and `buildSystemPrompt()` read the active tab and load only the relevant slice:

| Page | Tools added | System-prompt blocks added |
|------|-------------|----------------------------|
| Maintenance / Capture / Tracker Capture | full authoring kit | Meta-Architect Protocol, Program Rules, Program Indicators, Sharing |
| Aggregate Data Entry / Data Entry / Dataset Report / Maintenance > dataSet | `manage_datasets`, `manage_metadata` | Dataset Context (active OU + period + AOC + form type + DE/section/OU counts + can-write-data flag), DHIS2 Datasets KB, Category-Combo creation flow |
| Data Visualizer | `get_visualization_details` | Visualization Context (with prefetched analytics) |
| Maps | `get_map_details` | Map Context |
| TEI / enrollment in URL | tracker tools | TEI prefetch context |
| Line Listing | `line_listing_guide` | Line Listing protocol |

---

## Architecture

```
┌──────────────────────┐    ┌────────────────────────────┐    ┌──────────────────────┐
│   Content Script      │   │  Background Service Worker  │   │    Side Panel         │
│   (content.js)        │──▶│  (background.js, 9 modules)│──▶│  (sidepanel/)         │
│                       │   │                             │   │                       │
│ • URL change monitor  │   │ • DHIS2 detection & session │   │ • Chat interface      │
│ • hashchange/popstate │   │ • Page-context extraction   │   │ • Streaming display   │
│ • 2s polling fallback │   │ • Universal LLM streaming   │   │ • Tool progress UI    │
│ • Sends ctx updates   │   │ • 37-tool agentic loop      │   │ • Chart rendering     │
│ • Self-heal on        │   │ • Tracker write pipeline    │   │ • Image attachments   │
│   "context invalid"   │   │ • Atomic metadata bundles   │   │ • Settings modal      │
│   after extension     │   │ • Auto-backup + restore     │   │ • Theme switching     │
│   reload              │   │ • Smart retry (429/503)     │   │ • Download HTML/Word/ │
│                       │   │ • SW keep-alive ping        │   │   CSV / JSON          │
└──────────────────────┘    └────────────────────────────┘    └──────────────────────┘
```

### Agentic loop (per turn)

1. **Context extraction** — read URL of active DHIS2 tab → app type, program, stage, dataset, OU, TEI, viz, map.
2. **System prompt assembly** — base rules + only the conditional blocks the request needs.
3. **Reliability prefetch** — TEI details / visualization data / map data / dataset metadata / save-error E-codes resolved BEFORE the LLM is consulted, so the model sees facts rather than asking for them.
4. **Tool selection** — `getContextualTools()` filters the 39 tools down to the 6–12 relevant for the request.
5. **Streaming agent loop** — model calls tools, results stream back, model decides whether to continue. Hard caps: 50 iterations per turn, 3 consecutive empty responses trigger bailout.
6. **Persistence** — per-turn state (`knownIds`, `knownIcons`, `recentCreations`, `writeAuth`, …) survives service-worker restarts via stripped JSON snapshots.

### Write pipeline (the strict path destructive operations follow)

1. **Per-turn write authorization.** `classifyWriteAuthorization()` defaults to `read_only`. The user has to express intent ("create / delete / update / fix …") for any write tool to even be reachable.
2. **`requireWriteAuth` gate.** 27 destructive branches (incl. raw `dhis2_query` writes) refuse to run without the gate passing.
3. **Per-turn `knownIds` registry.** Seeded from user text + page context; grown by every tool result; pre-flight refuses any UID the model can't justify having seen.
4. **`verifyTargetExists` 404 stop.** Refuses to PATCH / PUT / DELETE objects the server doesn't return.
5. **Auto-backup.** Before any destructive op, the affected `:owner` slice is snapshotted to `dataStore/dhis2-ai-extension-backups`. 30-day retention. Restore is idempotent — running it twice is safe.
6. **Validation pass.** `POST /api/metadata?importMode=VALIDATE&atomicMode=ALL` first; only on success does the COMMIT pass run. Auto-fixes `shortName` collisions and re-validates once.
7. **Atomic COMMIT.** `POST /api/metadata?importMode=COMMIT&atomicMode=ALL` — the whole bundle either lands or none of it does.
8. **Error-counter circuit-breaker.** ≥ 3 4xx responses in one turn → hard stop, model can't loop forever on a misdiagnosed problem.
9. **Save-failure context.** Save errors trigger `prefetchSaveErrorContext`, which auto-fetches program flags + user access + existing TEI enrollments and injects a `findings[]` array so the model states the lead E-code (E1020 future date / E1015 active enrollment / E1018 mandatory attr / etc.) directly instead of asking the user for DevTools logs.

### DHIS2 API quirks the extension already encodes

These are the silent-failure traps that this codebase has hit and codified, so you don't have to re-learn them:

- **PATCH content-type** must be `application/json-patch+json` with body `[{op,path,value}]` — `application/json` returns 415, `merge-patch+json` returns 415. `safeDhis2Fetch` auto-sets the header and auto-wraps object bodies as RFC 6902 ops.
- **Sharing on metadata-only-shareable classes** (DataElement, CategoryCombo, Category, CategoryOption, OptionSet, TEA, ProgramIndicator) MUST use the legacy `/api/sharing?type=X&id=Y` endpoint. The per-resource `/{type}/{id}/sharing` PUT returns 409 E3016 even when access bits are metadata-only.
- **CategoryOptionCombos do NOT auto-materialize** after creating a new CategoryCombo. Without `POST /api/maintenance/categoryOptionComboUpdate`, the form has no cells to bind to and Save silently no-ops.
- **MULTI_TEXT fields** filter with `like`, never `eq` (stores comma-separated values).
- **`d2:contains` is a Program Rule function**, not a Program Indicator function — PI grammar has no `contains`. `==` is exact match on MULTI_TEXT in PIs. The chatbot now lints PI expressions/filters locally AND validates them against `/programIndicators/expression/description` BEFORE saving.
- **Program-rule conditions** can't trust `== false` on BOOLEAN / TRUE_ONLY in DHIS2 2.41. Canonical pattern: `!d2:hasValue(#{v}) || #{v} != true` (false-or-empty) or `#{v} == true` (true). `lintProgramRuleCondition` rejects the wrong shape before POST.
- **Program rules with `#{var}` refs to data elements need matching program-rule variables** OR the rule loads but never fires. Auto-created by `_buildAndPostProgramRules` from the rule's data-element references.
- **Icon search is prefix-on-keyword.** `pregnant` matches; `pregnancy` returns 0. Use SHORT roots (`preg`, `vacc`, `mater`). `discover_icons` is required before any `update_style` call so the model can't fabricate non-existent keys.
- **Custom (HTML) data-entry forms can't be created inline.** A `dataEntryForm` embedded in a dataSet/programStage payload — via `/api/metadata` OR a direct object PUT — bounces with E5002 "Invalid reference (DataEntryForm)". It must be `POST`ed standalone to `/api/dataEntryForms` first, then referenced by id. Input ids bind by `<dataElementUID>-<categoryOptionComboUID>-val` (datasets) vs `<programStageUID>-<dataElementUID>-val` (stages). Linking to a program stage needs a full PUT that **re-attaches `program:{id}`** — a PATCH/naive PUT drops it ("Program stage must reference a program") because `?fields=:owner` omits `program`. All encoded in `manage_custom_forms`.
- **The WHO Growth Chart plugin is driven by a dataStore key + an enrollment-dashboard widget.** Functioning needs (1) the app installed (`capture-growth-chart`), and (2) `dataStore/captureGrowthChart/config` mapping the program's DOB/gender attributes, female/male option codes, and weight/height/head-circumference data elements (all three required or the chart hides), plus `programStageForGrowthChart: { "<programId>": "<stageId>" }`. The plugin *widget* must additionally be placed on the enrollment dashboard via the Tracker Plugin Configurator / Capture's "Add plugin" — that layout lives in the Capture-owned `dataStore/capture`, which `manage_growth_chart_plugin` deliberately does **not** overwrite (cache-corruption risk). All the safe/documented parts are automated; the widget step is surfaced as instructions.
- **Custom app translations live in a dataStore namespace (DHIS2 2.43+).** `custom-translations/controller` maps each app slug → registered locales (`{ "capture": ["ar"] }`); `custom-translations/<slug>__<locale>` (double underscore, slug lowercased) holds a `{ "<exact source string>": "<replacement>" }` map. An app/locale pair NOT listed in `controller` is never loaded — so `manage_custom_translations` always writes both keys together. The value can be another language (translation) or the same one (re-labelling). Confirmed on play 2.43.0.1: the Capture app fetches `controller` then `capture__ar` (both 200) at startup and renders the translated strings in the live app.
- **Aggregate imports store invisible values without strict flags.** A weekly period on a monthly dataset, an org unit the dataset is not assigned to, or a disaggregated data element without its category option combo all return `SUCCESS` and land where no Data Entry form shows them. `manage_data_values` refuses them client-side and `dhis2_query` adds `strictPeriods/strictOrganisationUnits/strictCategoryOptionCombos/strictAttributeOptionCombos/strictDataElements` to raw `dataValueSets` imports. A partial import answers HTTP 409 while some values *were* saved; a DELETE row without its `value` crashes the importer for option-set data elements.
- **`PUT {type}/{id}/translations` replaces the whole set.** One French write wipes every other locale; unknown locales/properties are stored and never render. `manage_metadata_translations` merges and validates.
- **`POST /api/users` ignores `dryRun`** (the user is really created), rejects the legacy `userCredentials` shape, and a role saved with a misspelled authority is accepted (201) but grants nothing. Group membership can only be changed through `userGroups/{g}/users/{u}`.
- **HIDEFIELD on a compulsory program-stage data element** doesn't visually hide it in New Tracker Capture. The chatbot now auto-PUTs `compulsory:false` on affected PSDEs and pairs the rule with a `SETMANDATORYFIELD` rule keyed to the inverse condition, so compulsion is restored when the field shows again.

---

## Building apps & plugins

Ask for an app, a dashboard widget or a Capture plugin in plain language — *"build a dashboard widget that shows ANC coverage by district for the selected period"*, *"add a widget to this enrollment dashboard that lists the medications ordered"*, *"add a plugin to this form that shows the BMI category"* — and the assistant writes it, packages it, installs it on your DHIS2 server and, if you ask, puts it where you work. **Zero setup:** no Node, no CLI, no build server. Everything runs inside the extension.

**How it works.** The model writes React JSX against a fixed set of globals (`React`, `ReactDOMClient`, `D2UI` = all of `@dhis2/ui`, `D2Runtime` = `@dhis2/app-runtime`, `postRobot`, `echarts`, `D2_APP_CONFIG`). `manage_custom_app` compiles it with Sucrase (`libs/sucrase.min.js`), checks it, and zips it with fflate (`libs/fflate.min.js`) together with the prebuilt runtime kit (`libs/d2-kit/`: one 1.6 MB IIFE + Roboto + design tokens). The zip (~0.5 MB, ~0.9 MB with charts) is uploaded through your logged-in DHIS2 tab to `POST /api/apps`, then verified in `/api/apps`.

**The workflow the assistant follows** (it is in the tool manual): look up the real metadata and run the exact queries the app will make → `preview` (compile + safety scan + lint + UID check, nothing installed) → a 3–5 line summary for you (what it shows, which data it reads, whether it writes, where it appears) → after your "yes", `create` with the preview token, so exactly the previewed build is installed → the app link, or the steps to add the plugin to a dashboard (Edit → search the app name, listed under *Apps*).

**What it refuses, in code.** Keys must start with `ai-`, and apps without the assistant's marker (`developer.company` in the manifest plus `src/manifest.ai.json`) are never updated or deleted. The safety scan rejects `eval` / `new Function`, `document.cookie`, `localStorage`/`sessionStorage`/`indexedDB`, `<script>` injection, `dangerouslySetInnerHTML` / `innerHTML`, `import`/`require`/`export`, requests to other servers and WebSocket/EventSource/`sendBeacon`. Unless the app is declared `needs_write_access`, any mutation is rejected too. The lint catches the runtime errors that would otherwise only show a blank page:
- undeclared components or hooks;
- names the kit does not export;
- inline query objects, which the runtime silently freezes;
- a missing render root, `DataProvider` or plugin handshake;
- a `HeaderBar` (the v42 Global Shell already draws one);
- crossed or unclosed JSX tags, which Sucrase itself accepts.

UID-shaped strings that do not exist on the server are refused. `create`/`update`/`delete`/`rollback`/`place`/`unplace` pass the normal write-authorization gate; `list`/`get_source`/`preview`/`placements` are read-only. A preview is installed in the same turn only when your own message asked to install; otherwise the assistant shows the summary and waits for your answer.

**Placing plugins** (`place` / `unplace` / `placements`):
- **Dashboards:** the plugin becomes an `APP` item on an existing dashboard (appended, dashboard backed up first) or on a new one. `manage_dashboards` accepts `{ type: "APP", app_key }` items too.
- **Capture pages:** an enrollment widget goes on the enrollment dashboard, the add-event or the edit-event page of one tracker program, in the left or right column, at the top or bottom. The tool writes Capture's own layout (`dataStore/capture/enrollmentOverviewLayout` and the two event-page keys) exactly as the Tracker Plugin Configurator does. A program without a layout starts from Capture's default page, so nothing else on the page changes.
- **Capture forms:** a form-field plugin goes into a tracker stage's event form or a program's registration form (`dataStore/capture/dataEntryForms`), with a **field map**: the aliases the plugin uses (`values.weight`, `setFieldValue({ fieldId: "bmi" })`) mapped to data elements or attributes. The form is written section by section the way the Configurator writes it. A mapped field either stays in the form or is replaced by the plugin (`replace_field`). A placement whose code writes an alias the field map does not cover is refused (Capture would reject that write).
- **Safety:** every Capture write is backed up first (`manage_backups(restore)` puts the old value back) and read back to verify it. `unplace` puts any replaced fields back where the plugin was, and removes a program or form entry that is back to Capture's default, so it follows the metadata again. `delete` takes a plugin off every dashboard and Capture page before uninstalling it. Writing `dataStore/capture` through `dhis2_query` stays blocked. Capture reads its configuration when it loads, so one reload shows the change.

**Maintenance.** Each app embeds its own JSX source, so `update` takes only the changed files, bumps the version and backs up the previous version first. App backups live in the usual `dhis2-ai-extension-backups` namespace, the last 5 per app, and `manage_backups(restore)` reinstalls them too. `rollback` reinstalls a previous version. `delete` backs up first; `delete_app_data:true` also drops the app's dataStore namespace.

**How generated code is written.** The tool manual adapts the [DHIS2 app-development agent skill](https://github.com/devotta-labs/dhis2-app-skills) (the one [developers.dhis2.org recommends](https://developers.dhis2.org/docs/guides/ai-development)) to this no-build runtime:
- React 18 only, and `@dhis2/ui` for everything;
- show `displayName`, always pass `fields`, and take the API contract from the server, not from memory;
- server-side paging, search and order;
- `engine.mutate` with alerts and pending states, and a confirmation Modal before every delete;
- the DHIS2 widget and dashboard layouts and design tokens;
- server-version feature flags;
- hash routes so the Global Shell URL stays in sync.

The skill's App Platform tooling (scaffolding, TanStack, react-router, i18n, CSS modules) does not exist in the kit, so each rule is restated with the equivalent the kit has.

**DHIS2 behaviour this relies on** (verified on 2.42.5.1 / Dashboard app 101.6.1 / Capture 106.2.2):
- **Upload filename:** the app's storage folder is named after the uploaded *file* (two apps uploaded as `app.zip` overwrite and co-delete each other). Uploads are therefore always `<key>.zip`, and a taken folder is refused.
- **Namespace conflicts:** a reserved namespace that is already in use is a 409, checked before upload.
- **App files:** they are served only unversioned (`/api/apps/<key>/…`), and `index.html` redirects to the Global Shell unless `?redirect=false`.
- **Plugin size:** the Dashboard app gives a plugin item a **fixed** size (`setPluginHeight` is `null`), so plugin pages fill the item instead.
- **Filters:** `dashboardItemFilters` (`ou`/`pe`) arrive through post-robot's `updated` message without reloading the plugin.
- **Settings without 404s:** `dataStore/<ns>?fields=.&filter=_:eq:<key>` answers 200 even when nothing is saved, which is how plugins read per-item settings.
- **Capture plugins:**
  - An enrollment plugin receives `programId`, `enrollmentId`, `teiId`, `orgUnitId` (plus `programStageId`/`eventId` on event pages) and `navigate`.
  - A form-field plugin receives `values`, `fieldsMetadata`, `errors`, `warnings` (all keyed by its own aliases), `setFieldValue`, `setContextFieldValue`, `formSubmitted`, `viewMode` and `orgUnitId`.
  - Both get `setPluginHeight`: Capture sizes the frame to what the plugin reports.
  - Form configs list data elements as `type: "TrackedEntityAttribute"`, and fields a config leaves out still appear in a trailing section.

  Read from Capture's bundle and the Configurator's saved configs.

Requirements: the App Management authority; dashboard plugins need DHIS2 ≥ 40.5 and Dashboard app ≥ 101; Capture form-field plugins are placed on tracker program stages and registration forms. An approve/reject card in the panel is still planned.

**Maintainers.**
- `node scripts/build-runtime-kit.js` rebuilds `libs/d2-kit/`, `libs/sucrase.min.js` and `libs/fflate.min.js` from exact pinned versions. It is dev-only, and the output is committed and reproducible byte for byte.
- `npm run apps` runs the live and visual acceptance suite (`scripts/scenario-custom-apps-visual.js`, Playwright plus a local Chrome) and writes `test-results/custom-apps/report.html`. `--keep` leaves the test apps and dashboards in place for inspection.
- `npm run apps:llm` (`scripts/llm-apps-acceptance.js`, needs `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`) has the chatbot itself build five complex apps and plugins. Each is verified in the real Dashboard and Capture apps, every DHIS2 call the chatbot makes is audited, and the server is left as found. Report: `test-results/custom-apps-llm/report.html`.

## Learning memory

The assistant learns from its own mistakes so it does not repeat them. Settings → **Learning memory** (on by default) has an on/off switch and a **View memories** screen (search, filter by area, delete, export, add your own note, clear all).

- **How lessons are made.** (1) *Automatically*: when a tool call fails and a later call in the same request succeeds, the loop records the error and the exact change that fixed it (tool, action, endpoint pattern, parameter names and configuration values only). A failure the tool explained but that was not fixed is kept as a "known issue". (2) *By the assistant*: right after it recovers from an error it is nudged to write a clean lesson with `manage_memory(action="record")`. (3) *By you*: "remember for the future …" or a note in the viewer.
- **How lessons are used.** Every request is matched to task areas (programs, rules, indicators, dashboards, maps, data values, users, translations, …) through the tools selected for it plus its wording; the best-matching lessons (max 8) are put in the system prompt. A tool's own lessons arrive with its manual on first use, and a failed call gets the lessons for that tool/endpoint attached to its result. Near-duplicates merge (seen count), the store is capped at 400 with least-valuable eviction, and "instance" lessons only apply on their own server.
- **Privacy, enforced in code.** Stored in `chrome.storage.local` only. No memory write at all in a request that read or wrote individual tracker records or ran on a patient's record page; all text is scrubbed (UIDs, e-mails, phone/ID numbers, dates, filter values) and anything that still reads like personal data is refused.

## Model providers

Universal OpenAI-compatible. Configure `apiBaseUrl`, `modelId`, optional `apiKey`, optional `visionModelId` + `visionApiBaseUrl`. Both keys live in `chrome.storage.local`.

| Provider | API Base URL | Example Model | Key needed |
|----------|-------------|---------------|------------|
| **Ollama (default)** | `http://localhost:11434/v1` | `llama3.2` | No |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` | Yes |
| Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-5` | Yes |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/kimi-k2p5` | Yes |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` | Yes |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | Yes |
| xAI Grok | `https://api.x.ai/v1` | `grok-4.5` | Yes |
| Together | `https://api.together.xyz/v1` | `meta-llama/Llama-3-70b-chat-hf` | Yes |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash-exp` | Yes |
| Custom / self-hosted | any OpenAI-compatible `/chat/completions` | — | depends |

**Local-first by default.** First-run config points at Ollama on `localhost:11434` with `llama3.2` and no key. Pull the model once (`ollama pull llama3.2`) and the assistant works fully offline against your DHIS2 session.

`isLocalProvider` / `isValidProviderUrl` helpers gate the no-key path and reject non-`http(s)` URLs. The patient-data privacy gate uses the stricter `providerRequestsStayLocal`: only a provider whose requests actually go to `localhost` counts as local. An "Ollama" preset pointed at another machine is treated as remote. All LLM and Tavily fetches have `AbortSignal.timeout` (90s non-stream / 60s stream-connect / 30s Tavily). `SAVE_PROVIDER_CONFIG` validates URL scheme, providerType allowlist, `maxTokens` 256-200000, `temperature` 0-2, and caps every string field.

### Vision

Two-step: image → vision model description → text-model context. If `visionModelId` and `visionApiBaseUrl` aren't set, images are passed directly to the main model.

---

## Install

1. **Clone or download** this folder.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the `dhis2-AI/` folder.
4. **(Default path: Ollama)** install Ollama from [ollama.com](https://ollama.com) and run `ollama pull llama3.2`. The extension will use it out-of-the-box with no key.
5. Navigate to any DHIS2 instance you're logged into (e.g. [https://play.im.dhis2.org/stable-2-41-8](https://play.im.dhis2.org/stable-2-41-8) — admin / district).
6. Click the extension icon to open the side panel.
7. (Optional) Click the gear → switch provider, paste API key, set theme.
8. (Optional) Provide a Tavily API key for the `browse_web` tool.

---

## Permissions

| Permission | Why |
|-----------|-----|
| `sidePanel` | Side-panel chat UI |
| `storage` | Conversation state, settings, and provider config (stored locally) |
| `tabs` | Read the active tab's URL to detect the DHIS2 server/page and keep in sync across tabs and instances |
| `webNavigation` | Detect in-app (SPA) DHIS2 navigations to refresh page context |
| `scripting` | Register the URL-monitor on granted DHIS2 sites, and execute writes through the DHIS2 tab so MV3 doesn't drop POST/PATCH bodies |
| Host access (per DHIS2 server) | Requested **at runtime, per server**, through Chrome's standard prompt the first time you use the extension on that server. The extension calls your DHIS2 server's Web API using your existing session. There is no broad `<all_urls>` access. |

The extension never stores DHIS2 usernames or passwords. Authentication is the existing browser session of your DHIS2 tab.

---

## Export & download

Every assistant response can be downloaded from the feedback bar:

| Format | Ext | What's in it |
|--------|-----|--------------|
| **HTML report** | `.html` | Standalone styled document with header, metadata bar (program / OU / DHIS2 version / timestamp), full rendered content, print-ready CSS |
| **Word** | `.doc` | Microsoft Word-compatible (HTML + Office XML namespaces, UTF-8 BOM). Opens cleanly in Word, LibreOffice, Google Docs |
| **CSV** | `.csv` | All tables in the response → comma-separated rows. UTF-8 BOM for Excel. If no tables, exports plain text as `.txt` |
| **JSON** | `.json` | Structured: `meta` (generatedAt / program / orgUnit / dhis2Version), `content.markdown`, `content.text`, `content.tables[]` parsed as named-key arrays |

Filenames: `DHIS2_Report_YYYY-MM-DD_<timestamp>.<ext>`.

---

## File layout

```
dhis2-AI/
├── manifest.json              MV3 config (v2.8.27)
├── background.js              Service worker entry — thin importScripts() loader
├── src/                       Background worker modules (loaded, in order, by background.js)
│   ├── core.js                config · state · safety gates · DHIS2 transport · backups · context
│   ├── memory.js              learning memory (lessons, privacy taint, manage_memory)
│   ├── registry.js            tool schemas · KB · manuals · tool selection · system prompt
│   ├── providers.js           LLM streaming · image · web search · patient-data privacy gate
│   ├── tools-metadata.js      executeTool dispatcher + standard metadata tools
│   ├── tools-programs.js      program-authoring tools · plugins · standalone
│   ├── tools-linelists.js     manage_line_lists
│   ├── tools-admin.js         manage_users · manage_data_values · manage_metadata_translations
│   ├── tools-sqlviews.js      manage_sql_views (SQL views · real DB columns)
│   ├── tools-apps.js          manage_custom_app (AI-built apps & dashboard plugins)
│   ├── tools-apps-placement.js  manage_custom_app place / unplace / placements
│   └── agent.js               agentic loop · feedback · keepalive · screenshot · message router
├── scripts/
│   ├── verify.js              node --check + shim-load + safety-gate assertions (npm run verify)
│   ├── scenario-sql-views.js  live SQL-view / privacy-exception / endpoint-guard test (npm run sqlviews)
│   ├── live-harness.js        real executeTool against a live DHIS2 (basic-auth fetch shim)
│   ├── build-runtime-kit.js   DEV-ONLY: rebuilds libs/d2-kit + sucrase + fflate (pinned)
│   ├── custom-app-scenarios/  JSX of the acceptance-test apps
│   └── scenario-*.js          live regression scenarios (npm run admin / sticky / apps, …)
├── content.js                 URL monitor with self-heal on extension reload
├── sidepanel/
│   ├── panel.html             Side panel UI
│   ├── panel.css              Light/dark theme, settings modal, tool-card styles
│   └── panel.js               Chat UI, streaming, tool progress, downloads (~2.5k LOC)
├── line-listing/
│   ├── dhis2_chrome_extension_system_prompt.md
│   └── dhis2_linelisting_tool.json
├── libs/
│   ├── echarts.min.js
│   ├── sucrase.min.js         JSX compiler for manage_custom_app (worker IIFE)
│   ├── fflate.min.js          zip for manage_custom_app (UMD)
│   └── d2-kit/                runtime kit packed into every AI-built app (JS, CSS, fonts, KIT_VERSION.json)
├── icons/
│   ├── icon16.png  icon48.png  icon128.png
└── README.md
```

---

## Development

No build step — pure HTML / CSS / JS. The background worker is split into
`src/*.js` modules loaded via `importScripts()`; see `ARCHITECTURE.md`.

1. Edit source files.
2. `npm run verify` — syntax-checks every module, loads them under a `chrome`
   shim, and asserts the safety gates (no dependencies to install).
3. `chrome://extensions/` → click the refresh button on the extension card.
4. Reload the DHIS2 tab.

Useful test target: `https://play.im.dhis2.org/stable-2-41-8` (admin / district). Every feature in this README has been verified against that instance.

### Project conventions

- **Atomic writes only.** No multi-step "create A, then B, then C" sequences — bundle into one `/api/metadata` POST so partial-failure rollback is automatic.
- **No `dhis2_query` writes for sharing, program rules, or category objects.** The dedicated tools encode the right endpoint + content-type + post-create maintenance triggers.
- **Lint before POST.** Local validators reject malformed program-rule conditions, fabricated icon keys, malformed sharing access strings, etc., so the chatbot doesn't waste a turn on a server-side bounce.
- **Verify before recommend.** Memory and prior-conversation references are checked against `git log` / current code state before being acted on; per-turn `knownIds` registry blocks UIDs the model can't justify.
- **Document every change in the [Changelog](#changelog) below**: what changed, why, and how it was verified. There are no separate change files.

---

## Changelog

Newest first. The long investigation write-ups for releases up to 2.8.25 lived in `changes.md` and `CHANGES_*.md`. Those files were folded into this section and removed; their full text is in the git history.

### 2.8.27 — SQL views, a metadata-only privacy exception, and the "transfer history" thread (2026-10-23)

**The failing thread.** Asked for "a dashboard plugin that shows the transfer history of all org units, filterable by date and org unit" (2.43.2 playground), the chatbot:
- did not know that a tracker "transfer" is an ownership transfer, recorded only in the `programownershiphistory` table;
- probed guessed endpoints: `tracker/ownership/transfer` (405), `tracker/ownership` (404), `audits` (404), `audits/trackedEntity` (500);
- built version 1 on a proxy signal (enrollment org unit ≠ owner org unit), with no transfer dates;
- had placement refused twice, although the request said "install it on a dashbaord" and the user then said "go ahead install and setup";
- once told to use a SQL view, sent `schemas/enrollment|programInstance|trackedEntityInstance` (3 × 404);
- wrote SQL with 2.40 table and column names and the protected `userinfo` table, saved with sharing `rw------`, so every reader, admin included, gets 409 E4312;
- told the user "DHIS2 validated the SQL on save". It does not: a view on a nonexistent table saves with 201.

**New tool `manage_sql_views`** (new module `src/tools-sqlviews.js`).
- `describe` returns the server's real columns from `information_schema`, through a temporary view that is removed again.
- `create` / `update` run the view once and report its columns and row count. SQL that fails there is reported with the real PostgreSQL error, and the view is removed (create) or put back as it was (update).
- Every refusal the server would give is caught before any request:
  - the 15 illegal words, which DHIS2 matches anywhere, strings included (`'delete me'` → E4311);
  - protected tables;
  - tables removed in 2.41 / 2.43 (`event` became `trackerevent` + `singleevent` on 2.43);
  - 2.40 column names;
  - variables without a value, or with a value DHIS2 rejects;
  - sharing nobody can read;
  - a second view with an existing name.
- Default sharing is `r-r-----`; every result states who can read the rows.

**Privacy: metadata-only SQL views are now readable on a cloud model.** Patient data stays blocked.
- The decision uses the view's **current** SQL, fetched at read time: a QUERY view whose every table is on a metadata allowlist (programs, data elements, org units, option sets, favourites, `information_schema` …).
- Anything unknown fails closed: unlisted tables, functions not on a safe list (`query_to_xml`, `dblink` …), variables outside string literals or in comments, more than one statement, VIEW/MATERIALIZED_VIEW types, extra query parameters.
- A patient-level view gives the model only its column names and row count; database errors that could quote row values are withheld.
- Gate holes closed: `audits/trackedEntity*` / `audits/enrollment` (patient audit trails) and `analytics/trackedEntities/query`.

**Other fixes from the thread.**
- **Placement:** misspelled place nouns are recognised ("dashbaord"); "install / set up … on a dashboard" counts as asking; "go ahead" answers the assistant's own placement plan, not only a question. A refused `place` says not to retry that turn.
- **`dhis2_query` answers guessed endpoints without sending them** (`tracker/ownership*`, bare `audits`, `schemas/<not a metadata type>`), and heals `schemas/dataElements` → `schemas/dataElement`. These refusals do not become memory "lessons".
- **Plugin preview** refuses a plugin on a SQL view nobody can read, or one that never sends a variable the view needs. It warns on `paging:false` over a patient-level view.
- **`<Pagination pageSize={25}>` is refused at preview.** The kit's `@dhis2/ui` page-size menu offers 5, 10, 20, 30, 40, 50, 75 and 100, so 25 logs "There is no option with the value: \"25\"" on every render. Both the failed thread's plugin and the first real-model rerun used 25. A listed size, `pageSizes` or `hidePageSizeSelect` passes; the manual says so.
- **Knowledge.** The manuals now cover:
  - the verified transfer-history SQL (from the user's dhis2-plugin-skill, run against 14 real transfers on 2.42.5.1);
  - the 2.41+/2.43 tracker tables;
  - how a plugin reads a view (variables, server-side paging, dashboard org-unit filter, the E4312 notice).
- The routing prompt now tells the model that a "transfer" is an ownership transfer, read with a SQL view.

**Verified.**
- `npm run verify`: 650 checks, all passing, 50 of them new. They include 33 privacy-analyzer cases: CTE shadowing, `TABLE x`, commented / identifier variables, `pg_catalog`, `datavalue`.
- `npm run sqlviews` (live, cloud provider configured): 30 of 30 checks on localhost 2.42.5.1 (14 transfers) and 30 of 30 on the 2.43.2 playground (0 transfers recorded — reported as such). Each run: 62 API calls, 0 unexpected failures (2 deliberate 409s), instance left as found.
- Server rules were probed live on 2.42.5.1, and the tables and columns on both 2.42.5.1 and 2.43.2.
- **Real model, the user's own message verbatim** (new case F in `npm run apps:llm`, Fireworks `deepseek-v4p1-flash-1017`, localhost):
  - One turn, 64 s. The model described the tables, created the SQL view (14 transfers), previewed and installed the plugin, and placed it on a new dashboard.
  - 22 DHIS2 calls, 0 failed. No guessed endpoint, no false claims.
  - In the real Dashboard app the plugin shows the 14 transfers (from, to, by, when). The date filter works. No console errors.
  - 20 of 20 checks pass, and the server is left as found. The first run failed only on the page-size console error, fixed above.

### Also in 2.8.26 — placing plugins: dashboards, Capture pages, Capture forms (2026-10-22)

**The assistant now puts the plugins it builds where people work**, and writes exactly what the Tracker Plugin Configurator writes (new module `src/tools-apps-placement.js`).
- **`manage_custom_app` `place` / `unplace` / `placements`.**
  - `target "dashboard"`: an existing dashboard (appended through `manage_dashboards`, backed up first) or a new one.
  - `"enrollment_dashboard"` / `"enrollment_event_new"` / `"enrollment_event_edit"`: a widget on that Capture page of one tracker program, left or right column, top or bottom.
  - `"form"`: a form-field plugin in a tracker stage's event form or a program's registration form, with a `field_map` from the plugin's aliases to data elements or attributes. A mapped field stays in the form, or the plugin replaces it (`replace_field`).
  - `delete` takes a plugin off every page first. `placements` is read-only.
- **The formats were verified, not assumed.** Sources: the Capture 106.2.2 bundle on 2.42.5.1, the configs the Configurator (3.0.2) had saved on that server, and developers.dhis2.org.
  - A program without a layout starts from Capture's own default page, which differs from the docs' example.
  - Data elements in stage forms are written as `type: "TrackedEntityAttribute"`, like the Configurator does. Fields left out of a config still appear in a trailing section.
  - Plugin props: enrollment pages pass `programId` / `enrollmentId` / `teiId` / `orgUnitId` (+ `programStageId` / `eventId`). Forms pass `values` / `fieldsMetadata` / `errors` / `warnings` keyed by alias, `setFieldValue`, `setContextFieldValue`, `formSubmitted`, `viewMode`. Both pass `setPluginHeight`.
  - `setFieldValue` only accepts mapped aliases, so `place` refuses a field map that misses an alias the code writes.
- **Safety.**
  - Every `dataStore/capture` write is backed up (`capture_config` backups; `manage_backups(restore)` writes the old value back) and read back. The comparison ignores key order, because DHIS2 stores dataStore values as jsonb.
  - `unplace` puts replaced fields back and removes an entry that is back to Capture's default.
  - Raw `dhis2_query` writes to `dataStore/capture` stay blocked, and its hint now points to `place`.
- **Manual.**
  - A form-field plugin template, `setFieldValue` value formats, field-map rules and placement steps.
  - Capture's widget card style (white, 1 px grey400 border, 3 px radius, 44 px header), read from the bundle.
- **Fixes found while testing.**
  - Capture plugin pages no longer get `body.d2-plugin`. Its full-height `#root` is right for fixed-size dashboard items, but in Capture a wrapper of 100% height reports the frame's own height. A model-written widget was cut off that way (651 px frame, 697 px content).
  - The lint no longer tells form-field plugins to read `enrollmentId`.
- **Found by having the chatbot build real apps** (`npm run apps:llm`, Fireworks GLM-5.3-flash). Each defect was fixed at the root, checked against the model's own code, and has a check in `npm run verify`:
  - **Notes-app read:** the notes app GET `dataStore/<ns>/notes` before the key existed, a 404 on every first visit. The lint now refuses direct key reads in code that never uses the `filter=_:eq:<key>` read (HTTP 200, `entries: []` when nothing is saved). Key paths inside mutations stay allowed. The manual teaches the read and create/update rules for any app, not only dashboard settings.
  - **Notes-app delete:** the same app deleted the last note with `{ type: last ? 'delete' : 'update', data }`, which app-runtime refuses ("Mutation type 'delete' does not support property 'data'"). Nothing was sent, and the note could never be deleted. The lint now refuses `type: 'delete'` with `data` and `type: 'create'` with `id` in mutation objects.
  - **Unrequested dashboard:** asked only to "build a dashboard widget … show me a preview first", then "yes, install it", the model also created a dashboard nobody asked for and put the widget on it. Installing is not placing: `place` now goes ahead only when a placement was asked for, either in the user's message or a recent one ("add it to …", "as a widget on the enrollment dashboard", "plugin here", "place it"), or as a yes to the assistant's own placement question. Otherwise it refuses and tells the model to ask where it should go. Refused once, the model created the dashboard through `manage_dashboards` instead, so `APP` items there obey the same rule. Scenario 9 checks that nothing was placed.
  - **Height lost to a wrapper's margin:** a model-written form plugin reported the `offsetHeight` of a wrapper that had `margin: 4px 0`, and Capture cut off the margin (frame 88 px, content 92 px). Capture plugin pages now also load `capture-plugin.css` (`#root { display: flow-root }`, so every margin stays inside `#root`). The manual's templates report `#root`'s height, and the lint warns when a Capture plugin reports a wrapper's `offsetHeight`.
  - **Always-open modal:** another notes app rendered its delete-confirmation `<Modal>` unconditionally. It was open on load, and its backdrop blocked every click in the app. The lint now refuses a `Modal` rendered as an unconditional child (behind `cond &&`, a ternary, `hide=` or a component's own `return` is fine), and the manual says so.
  - **Search-query probe:** while testing its app's search, the model sent `dhis2_query` `filter=programType:eq:WITH_REGISTRATION;displayName:ilike:mch`, a 400. On metadata endpoints this is now split into one `filter` parameter per expression; analytics `ou:A;B` and tracker filters stay as they are.
- **`manage_dashboards`** accepts `{ type: "APP", app_key }` items in `create_dashboard` and `add_items`, after checking the key is an installed dashboard plugin. The item shape was verified with a VALIDATE + COMMIT import.
- **No Tavily key → no docs search offered.** `architect_metadata(browse_dhis2_docs)` failed on every call without a key (in the hands-on session). The action, its parameter and its mention in the description are now left out of the wire tools until a key is saved; a direct call gets "unavailable, do not retry".
- **Verified.**
  - `npm run verify`: 600 checks, all passing.
  - `npm run apps` (the whole visual suite, with the real model for scenario 9): 330 of 330. The tool made 228 API calls; the only 5 failures were the deliberate negative tests.
  - `npm run apps:llm`, real model, five complex requests in plain user language. Every case passed on its latest run, with zero failed DHIS2 calls from the chatbot (A 9, B 15, C 39, D 26, E 6 calls):
    - A: a program explorer app with search and paging (correct stage and data-element counts);
    - B: a malaria chart plugin placed on a new dashboard;
    - C: the medication widget placed on the Pharmacy enrollment dashboard, listing the 11 ordered drugs in real Capture, sized exactly;
    - D: a BMI / fever form-field plugin the model mapped to Weight, Height and Temperature itself, working in the real Capture form;
    - E: a notes app that saves, confirms and deletes on the server.
  - In every run the Capture configuration and the app list ended exactly as before.
  - `npm run verify` also covers placement round trips against an in-memory server: place → unplace must leave every key identical.
  - `npm run apps --only=10,11,12,13`: 49 live checks, 0 failed API calls.
    - The KPI plugin was placed on a new dashboard and rendered.
    - A medication widget was placed on the Pharmacy enrollment dashboard. In the **real Capture app** it lists the 11 drugs actually ordered, at 1440 px and 1024 px, sized to its content.
    - A form-field plugin was placed in the W4W Initial Assessment form. In the real Capture event form, typed weight, height and temperature reach the plugin, and `setFieldValue` writes the mapped field. The form was left without saving.
    - After every unplace and delete, `dataStore/capture` is identical to before.
  - The test cleanups now delete only backups whose reason names a test object or app, so other activity on a shared server is never touched.

### Also in 2.8.26 — fixes from the first hands-on test (2026-10-22)

**The assistant forgot the conversation after a pause on large programs.** The test was on a Capture enrollment page of the Pharmacy program. The assistant previewed a plugin and asked "Shall I install it?". The answer "yes install it" got "I don't have a record of what 'it' refers to". This was reproduced in real Chrome with the real extension and side panel, using both a recording mock LLM and Fireworks GLM-5.3-flash.
- **Cause.**
  - `programMetadata` caches every option of every option set on every stage field. For the Pharmacy program (15 drug slots × the drug list) that is 6.1 MB.
  - `saveState` wrote it in the same `chrome.storage.session.set()` as the chat history. Chrome rejected the whole write ("Session storage quota bytes exceeded") and the empty `catch {}` swallowed the error.
  - Chrome evicts the idle MV3 worker after 30 s. The next message restored no history, and with it lost the sticky tool list, so `manage_custom_app` was not even offered.
  - Any large program was affected: every follow-up turn after a pause, and the stage context that sticky context relies on.
- **Fix (`src/core.js`, `src/agent.js`).**
  - `chatHistory`, `dhis2Full` and `dhis2State` are written separately, and failures are logged.
  - An over-budget state leaves out the re-fetchable `programMetadata`; the chat handler re-fetches it when it is missing after a restart.
  - A history that is itself over quota keeps its newest turns.
  - `CHAT_MESSAGE` awaits the state restore before building the turn.
- **Capture enrollment plugins: the manual now states what is true.**
  - The tool accepted `plugin_type: "CAPTURE"`, but the manual said nothing about it, so the model guessed props and told the user the widget would be "selectable" in Capture.
  - The props `{ teiId, programId, enrollmentId, orgUnitId }` and `setPluginHeight` were verified against three enrollment plugins already installed on 2.42 / Capture 106. The manual now covers them, the tracker query, auto-height reporting, a narrow-column list layout, the rule against reading patient rows, and the fact that placement is manual (Tracker Plugin Configurator).
  - The lint warns when a Capture plugin reads neither `enrollmentId` nor `teiId`, or never reports its height.
  - `where_to_find` says plainly that the widget is not placed automatically.
- **No more impossible offers.**
  - The `dhis2_query` block on `dataStore/capture` is unconditional, but its hint said "ask them to confirm the exact JSON before writing". The model then offered "say yes and I'll write the layout", a write that would be blocked again. The hint now says no confirmation lifts it and points to the Tracker Plugin Configurator.
  - A `manage_custom_app` call cut off by the output-token limit now gets "write shorter source" advice instead of advice about splitting a tracker program.
- **No install before the user approves.**
  - With the real model, "Build a dashboard widget … Show me a preview first." was previewed and installed in the same turn. The manual said to ask, but nothing enforced it, and the suite's check for it was broken: it counted the manual-gate notice as an install and searched for "create" in a summary that never contains it.
  - Previews now remember their turn. `create` is refused (`_awaiting_approval`) unless one of these holds: the user's own message asked to install ("create and install …"; not "preview first" or "don't install"), it asked to put the plugin somewhere (placing implies installing), or a preview of that key was shown in an earlier turn. This applies whether the model passes the preview token or the files: in one run the model sent the files instead of the token, which skipped a token-only check.
  - The refusal tells the model to end the turn and ask; it no longer retries the same install.
  - Scenario 9 now judges by the server's app list and deletes whatever key the model chose. It also starts a fresh conversation every run: `llm-harness.js` persists session storage to `.llm-session.json`, so the scenario had been continuing the previous run's thread, and the model skipped discovery for the app it "remembered".
- **A dropped LLM stream is retried.** If the provider's connection drops before any text has reached the panel ("terminated" / "network error"; Fireworks did this several times during the runs), the agent loop now retries the request up to twice, exactly as it already did for a stalled stream. The request is safely repeatable at that point because nothing in it has run yet. Once text has streamed, the error is still shown, so output is never duplicated.
- **A dropped LLM stream left an unhandled rejection.** Fireworks closed a streaming connection mid-response. The stall handler's `reader.cancel()` returns a rejected promise on an already-errored stream, and nothing caught it. Chrome logged it as an uncaught error; under Node it killed the visual suite before its cleanup. The rejection is now caught, in both the OpenAI-compatible and the Anthropic paths. The suite also records an unhandled rejection as a failed check, so a run always reaches cleanup.

### 2.8.26 — 2026-10-21

**AI-built DHIS2 apps & dashboard plugins (`manage_custom_app`, new module `src/tools-apps.js`).** The assistant writes React JSX and installs it as a real DHIS2 app or dashboard plugin, with zero setup for the user. See [Building apps & plugins](#building-apps--plugins).
- **Runtime kit.** A dev-only `scripts/build-runtime-kit.js` produces the committed kit from exact pins: React 18.3.1, @dhis2/ui 10.18.0, @dhis2/app-runtime 3.17.4, post-robot 10.0.46 (the version the host uses), Roboto 400/500/700 with an Arabic system-font fallback, `@dhis2/ui` design tokens as CSS variables, and the export lists the lint checks against. It also produces Sucrase and fflate for the worker. The extension itself stays build-free. A rebuild from a clean install matches the committed files byte for byte.
- **Tool.**
  - Actions: `list` / `get_source` / `preview` / `create` / `update` / `delete` / `rollback`.
  - Safety scan, lint and UID verification. Crossed JSX tags are refused because Sucrase compiles them silently, and a missing `)` is reported on its own line rather than where Sucrase backtracked.
  - A `preview_token` (memory + `chrome.storage.session`) so `create` installs exactly the previewed build.
  - Version bumps, app backups (last 5) and `manage_backups(restore)` support.
  - Client-side pre-checks for existing keys, namespace collisions and upload-folder collisions, so the server never answers with a 409.
  - `D2_APP_CONFIG` gives the generated code the server's `baseUrl`, `apiVersion` and `serverVersion`.
- **Wiring.**
  - `uploadAppZip` in `core.js`: multipart upload through the DHIS2 tab, falling back to the worker; a 401 or login redirect becomes "Not signed in".
  - `list` / `get_source` / `preview` are discovery actions.
  - Registry schema, manual, routing stub and intent detection; dispatcher; memory area; panel card.
  - `dhis2_query` can no longer `POST /api/apps` or `DELETE apps/<key>`; those go through the tool, which only touches assistant-built `ai-*` apps.
- **Manual.** It incorporates the DHIS2 app-development agent skill (devotta-labs/dhis2-app-skills @0ad888fd35, recommended by developers.dhis2.org), restated as rules for this runtime, not copied code. It adds what this server showed:
  - the fixed-size dashboard items (`setPluginHeight = null`) and the `print-layout` mode;
  - the `useStaticInput` trap, where inline query objects are frozen at first render;
  - the 404-free dataStore settings read;
  - alerts forwarded to the dashboard via `parentAlertsAdd`.
- **Transport fixes found by the real-browser run** (they help every tool, not only this one):
  - `fetchViaTab` passed `undefined` as the body of every body-less write. Chrome rejects that in `executeScript` args ("Value is unserializable"), so **every DELETE silently fell back to a direct worker fetch**. DHIS2 answers a write from the extension's own origin with HTTP 200, an empty body, and does nothing (verified for DELETE and for the multipart upload). Metadata deletes only worked thanks to the POST `importStrategy=DELETE` retry; dataStore-key and app deletes did not. The body is now `null`, and DELETEs really go through the tab (204).
  - `safeDhis2Fetch` re-sent a write answered **204 No Content** through its empty-body retry, turning a completed `DELETE /api/apps/<key>` into "404 App does not exist". 204 is never retried now.
  - A direct DELETE's 409 carries its reasons in `response.errorReports` (ObjectReport); those are now surfaced like import errors, keeping the existing E4030 hints.
  - `uploadAppZip` reports an empty 2xx as "NOT installed — open a DHIS2 tab" instead of passing it through.
- **Verified.**
  - `npm run verify`: 91 new offline checks, all green.
  - The existing live suites (`npm run admin`, line lists, sticky context) still pass with 0 unexpected failed calls.
  - The extension was loaded unpacked in real Chrome 155 over CDP. Inside the real service worker: libs and modules load under the MV3 CSP, preview reads the kit via `chrome.runtime.getURL`, the preview token survives in `chrome.storage.session`, the upload goes through the DHIS2 tab (201), the app renders, and the delete goes through the tab (204). 12 of 12 checks.
  - `npm run apps` on DHIS2 2.42.5.1 / Dashboard 101.6.1 / Global Shell 1.12.3 (Chrome, 1440 px and 400 px): 7 generated apps/plugins across 8 scenarios plus an error-state app, **277 checks, 0 failed**, 40 screenshots. The tool made 88 API calls; the only 5 failures were the deliberate negative tests (one bypassed-pre-check 409, four logged-out 401s). The instance was left exactly as found.
    - Coverage: standalone app (direct + Global Shell), KPI and echarts dashboard plugins following the ou/pe filters without reload, edit and print modes, per-item settings in two independent instances, a write-enabled notes app (refused when declared read-only), Arabic/RTL under `keyUiLocale=ar`, update → rollback, and the negative paths (syntax error, banned patterns, key prefix, real apps, namespace collision, existing key, logged out, read-only turn).
    - Rendered numbers were compared with the same API queries.
    - Every screenshot was reviewed by eye. The KPI tiles were redesigned to centred single-value style after review.
- **Not done here.** The end-to-end LLM scenario was skipped because no LLM credentials were configured. Capture plugins and automatic dashboard placement are phase 2.

### Also in 2.8.26 — security & performance review (2026-10-21)

**Security & performance review.** Each issue was reproduced live on DHIS2 2.42.5.1 before being fixed.
- **Privacy-gate bypass closed.** The patient-data gate checked the raw `dhis2_query` path, but `fetch()` resolves `..`, `%2e` and `\` and drops `#…`, and DHIS2 decodes `%74`. With a cloud model, `programs/../tracker/trackedEntities` and seven other spellings returned patient rows. `safeDhis2Fetch` and `apiUrl` now refuse such paths (`ambiguousApiPathReason`), and the gate matches the canonical path.
- **"Local" means where requests go.** An "Ollama" preset pointed at `ollama.com` or another machine counted as local for the privacy gate. The new `providerRequestsStayLocal` decides by the request URL.
- **Content-script messages are untrusted.** Code running in a DHIS2 page could read the stored API key, re-point the provider URL and read the learning memory through the message router. Content scripts may now send only their five message types; everything else must come from the extension's own pages.
- **Only the focused tab drives context.** A background DHIS2 tab navigating, or expiring to the login page, re-pointed the session mid-turn. Only the active tab of the focused window counts now, and only its top frame.
- **Markdown links** in replies are limited to `http(s)`/`mailto` with quotes encoded, which stops attribute injection.
- **Performance:** one in-app navigation loaded the page context up to 4× concurrently (6–8 requests, now 2). `initializeFromUrl` shares and serializes runs, and the latest navigation wins. Hidden tabs no longer wake the service worker.

**Screenshots work without `activeTab` / `<all_urls>`.** `captureVisibleTab` needs one of those, and the manifest deliberately has neither. The selection overlay now captures the tab itself with `getDisplayMedia({ preferCurrentTab })`: Chrome asks "Allow … to see this tab?", and the overlay grabs one native-resolution frame, crops it and stops the stream. A "Capture selection" button covers drags that outlive the ~5 s user activation. A cancelled prompt no longer cuts off a streaming reply. Requires HTTPS or localhost.

### 2.8.25 — 2026-10-20
- **Administration tools** (`src/tools-admin.js`):
  - `manage_users`: users, roles and groups. Enforces the password policy and validates authorities, which DHIS2 otherwise stores even when misspelled.
  - `manage_data_values`: aggregate data entry by names. Refuses wrong-period-type, unassigned-org-unit and missing-disaggregation values that DHIS2 silently stores invisibly.
  - `manage_metadata_translations`: merges instead of wiping other locales.
- **Learning memory** (`src/memory.js`, `manage_memory`, Settings → Learning memory). Lessons are recorded from failure→fix sequences and injected per task. Turns that touch patient data write nothing.
- **Six silent-failure fixes:**
  - rule-action key aliases;
  - indicator type matched by factor;
  - imperative data-entry/admin verbs now authorize writes;
  - `dhis2_query` PATCH pre-checked against `/api/schemas`, and strict flags added to raw `dataValueSets` imports;
  - post-commit 5xx on deletes verified;
  - an aggregate-data delete block gets a data-pruning hint.

### 2.8.24 — 2026-08-06
- `manage_line_lists` was mislabelled in the panel, so it looked like the wrong tool was being used. Labels and routing fixed.
- A stage the user called "repeatable" no longer ships one-event-only.
- `GET optionSets/A,B,C` (HTTP 405) is healed.
- The detected stage is persisted on every page-context write.

### 2.8.23 — 2026-07-28
- **Sticky stage context** (`carryStickyContext`): Capture's enrollment dashboard has no stage in its URL, so the context is no longer wiped by URL re-parses.
  - content.js re-sends the stage every 30 s, and the DOM fallback needs a unique match.
  - The panel shows a Stage chip.
- **Blocked-delete recovery:** E4030 from soft-deleted events gets the exact `softDeletedEventRemoval` recovery.
- An empty 2xx response counts as success.

### 2.8.22 — 2026-07-27
- **Unfinished-turn guard:** the loop no longer ends a task on a text-only "I'll now…" reply.
- Program-rule actions are no longer shipped without their target. Loose target names are resolved.

### 2.8.21 — 2026-07-26
- **Growth chart:** the 80 KB tool-result truncation also hit internal reads, which reported `Program "undefined"`. Internal fetches now bypass it, and measurement data elements are chosen by numeric value type.

### 2.8.20 — 2026-07-26
- The tool router keeps a thread's tools on follow-up turns.
- Bug reports no longer authorize writes.
- "Add all OUs + fix sharing" can no longer drop the program from Capture.
- About 600 lines of dead code removed.
- Twelve classes of guaranteed-failed API call are healed before sending.

### 2.8.19 — 2026-07-20
- **Program-rule correctness:**
  - Dead option literals are reported.
  - Duplicate-rule lint covers every action type.
  - "Person" is no longer substituted for a tracked entity type the user named.
- **Section-safe stage edits:** adding or removing stage data elements backs up first and preserves `formType` and sections; `section_name` routing added.
- **Not-signed-in switches:** switching to a DHIS2 instance you're not signed in to now gives a clean message instead of a CORS console error (`redirect: 'manual'`).

### 2.8.18 — 2026-07-19
- `manage_program_indicators` create accepts `indicators: […]` in a single import.
- A coverage percentage is ONE program indicator: `AVERAGE` of `d2:condition(…, 100, 0)`. This fixed the 47-PI build that never finished.

### 2.8.17 — 2026-07-19
- **Named-program guard:** when a program the user named isn't found, program-bound writes on a different program are refused, and the assistant stops and asks instead of building on a lookalike.

### 2.8.16 — 2026-07-19
- **Weak-LLM reliability.** Fixes:
  - wire-message sanitizing and tool-argument shape healing;
  - recovery of leaked XML tool calls;
  - reuse-compatibility gates for data elements, attributes and option sets.
- The 3-prompt maternal-care acceptance completed with 0 failed API calls on MiniMax-M3 and Kimi-K2.6.

### 2.8.15 — 2026-07-18
- New `manage_line_lists` tool (`src/tools-linelists.js`): saved Line Listing tables (EVENT / ENROLLMENT / TRACKED_ENTITY). Layouts are proven against analytics before saving, and the tool refuses the traps that silently break line lists.
- Dashboards accept `EVENT_VISUALIZATION` tiles.

### 2.8.14 — 2026-07-14
- **Complex-program robustness:**
  - `create_program` pre-validation;
  - malformed or truncated calls no longer disable the tool;
  - a discovery-streak guard stops long runs of read-only calls;
  - corrupted streamed tool-call JSON is repaired.

### 2.8.13 — 2026-07-12
- `create_program` skips one bad rule and continues, instead of dead-looping. A mechanical circuit breaker disables a tool after 3 blocks.
- **Modular refactor:** `background.js` was split into `src/*.js` modules (byte-identical), with `npm run verify` and `ARCHITECTURE.md`.
- **`create_program` correctness:** COMPLETEENROLLMENT and HIDEOPTION binding, stage sections, and "continue" now authorizes writes.
- **Dashboard "replace a tile":** infinite loop fixed. Every tool call now gets a result, and there's a no-progress guard. Tracker data elements are refused in charts.

### 2.8.12 — 2026-07-12
- xAI Grok preset, plus custom-provider URL normalization and host-permission grant.

### 2.8.11 — 2026-07-11
- **Program rules:**
  - cross-turn UID memory;
  - the one-rule visibility doctrine (lint + audit);
  - `A{Display Name}` token healing;
  - in-place action updates.
- Program deletes cascade (rules, program-rule variables, program indicators first).

### 2.8.10 — 2026-07-10
- A bare "yes" after a refused write authorizes only that tool.
- Growth-chart dataStore guard and routing.
- Refusals say the tool exists.

### 2.8.9 — 2026-07-10
- **Program indicators:**
  - widget visibility (`display_in_form`);
  - ENROLLMENT date boundaries;
  - a whitelist of the 16 `d2:` functions the parser actually accepts.

### 2.8.8 — 2026-07-10
- **Existing metadata is never recreated:**
  - loud dedup probes;
  - name-conflict self-healing;
  - case-insensitive reuse of attributes and data elements;
  - verb-targeted write-auth negation.

### 2.8.7 — 2026-07-09
- `[` and `]` are percent-encoded in query strings, so self-hosted Tomcat DHIS2 no longer returns 400 on bracketed `fields`/`filter`.

### 2.8.6 / 2.8.5 — 2026-07-08
- `create_program` checks the tracked entity type exists (by UID or name) before import, and never sends the word "Person" as a UID. Matching is done in memory instead of with a brittle `name:eq` filter.

### 2.8.4 — 2026-07-07
- Creating on a fresh instance no longer hits the guard walls: field names are no longer mistaken for UIDs, a stop after consecutive HTTP errors, and the root org unit is resolved on an empty instance.

### 2.8.3 — 2026-07-07
- A new thread fully resets conversation memory and page context.

### 2.8.2 — 2026-07-07
- **MCH-scenario fixes:**
  - stage-by-name rule actions;
  - no phantom IDs after a failed create;
  - option-code program-rule variables;
  - empty-field numeric guards;
  - program-indicator name disambiguation.

### 2.8.1 — 2026-07-07
- Repeated-failure guard, a budget-exhaustion summary, and a liveness heartbeat and stream-stall guard.

### 2.8.0 — 2026-07-06
- **Lazy tool manuals:** write tools send slim definitions, and the full manual is delivered on first use. That cut per-iteration context by 42%.
- Inline program-rule variable resolution fixed.

### 2.7.0 — 2026-07-04
- **TB end-to-end audit fixes:** program-rule action and condition binding, a program-indicator OR-filter linter, and `create_program` ID chaining.
- New `manage_maps` tool.
- SQL-view execution is privacy-gated.

### 2.6.0 – 2.6.8 — 2026-06-30 to 2026-07-02
- New `manage_dashboards` tool, with safe `add_items`/`remove_item`/`update`/`delete`, pre-write snapshots and a destructive-write guard.
- The privacy gate now also covers file-extension variants (`.csv`, `.json`).
- **Orchestration of multi-step goals:**
  - dashboards;
  - org-unit provisioning;
  - program indicator → dashboard;
  - existing option set → data element → dataset;
  - legend set → indicator.
- **End-to-end audit fixes:**
  - option theft;
  - default data sharing;
  - responsive custom forms;
  - `A{}` resolution;
  - ASSIGN option codes;
  - search ranking.

### 2.5.0 — 2026-07-01
- **Hard-coded privacy gate:** patient-level tracker data can be read only when the model is local (Ollama).

### 2.4.1 – 2.4.5 — 2026-06-30
- New tools: `manage_validation_rules`, `manage_org_units`, `manage_indicators`, `manage_option_sets` and `manage_legend_sets`.

### 2.2.0 – 2.4.0 — 2026-06-28/29
- New tools: `manage_custom_forms` (custom HTML forms for datasets and program stages), `manage_custom_translations` (2.43 custom translations) and `manage_growth_chart_plugin` (WHO growth chart setup).
- The agentic loop cap was raised to 50.
- Option-set codes deduplicated (`A+`/`A-` no longer collide as `A_`).
- Fixed cross-turn memory loss, a value-type default and a program-rule misdiagnosis.

### 2.1.8 – 2.1.9 — 2026-06-04 to 2026-06-08
- Agentic loop cap raised from 12 to 30.
- An instance switch on the same host detects the login redirect instead of failing with a CORS error.
- Permissions hardened for the Chrome Web Store: host access is now granted at runtime, per server.

---

## License

[MIT](LICENSE) — free to use, fork, modify, and redistribute. Built for the DHIS2 community.


