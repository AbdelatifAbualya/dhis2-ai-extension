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

## The 37 tools

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
4. **Tool selection** — `getContextualTools()` filters the 37 tools down to the 6–12 relevant for the request.
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
├── manifest.json              MV3 config (v2.8.25)
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
│   └── agent.js               agentic loop · feedback · keepalive · screenshot · message router
├── scripts/
│   ├── verify.js              node --check + shim-load + safety-gate assertions (npm run verify)
│   ├── live-harness.js        real executeTool against a live DHIS2 (basic-auth fetch shim)
│   └── scenario-*.js          live regression scenarios (npm run admin / sticky, …)
├── content.js                 URL monitor with self-heal on extension reload
├── sidepanel/
│   ├── panel.html             Side panel UI
│   ├── panel.css              Light/dark theme, settings modal, tool-card styles
│   └── panel.js               Chat UI, streaming, tool progress, downloads (~2.5k LOC)
├── line-listing/
│   ├── dhis2_chrome_extension_system_prompt.md
│   └── dhis2_linelisting_tool.json
├── libs/
│   └── echarts.min.js
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

### Unreleased (after 2.8.25) — 2026-10-21

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


