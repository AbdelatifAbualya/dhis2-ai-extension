# Architecture

How this extension is put together, and where to make a change so you touch one
place instead of scrolling a 26,000-line file.

## The big picture

It is a Manifest V3 Chrome extension with **no build step**. The source you edit
is the source that ships. Three runtime pieces:

| Piece | File(s) | Role |
| --- | --- | --- |
| Content script | `content.js` | Watches the DHIS2 tab URL and reports context changes. Runs only on origins the user has granted. |
| Background service worker | `background.js` → `src/*.js` | All AI + DHIS2 logic: LLM streaming, the agentic loop, 30+ tools, safety gates, metadata/tracker writes. |
| Side panel | `sidepanel/panel.{html,css,js}` | The chat UI, streaming display, tool cards, charts, exports. |

## The background worker is 11 modules (+ 2 vendored libs), not one file

`background.js` used to be a single ~26k-line service worker. It is now a thin
loader that pulls in two vendored libraries and twelve focused modules **in order**
with the synchronous `importScripts()` API:

```
background.js  (loader)
└─ importScripts(
     libs/sucrase.min.js     JSX → JS compiler (self.sucrase) — used by tools-apps.js
     libs/fflate.min.js      zip (self.fflate) — used by tools-apps.js
     src/core.js             provider config · global state · write-auth & safety gates ·
                             DHIS2 transport & backups · context
     src/memory.js           learning memory (lessons, privacy taint, retrieval, manage_memory)
     src/registry.js         tool schemas · KB · manuals · tool selection · system prompt
     src/providers.js        LLM streaming · image · web search · read helpers · privacy gate
     src/tools-metadata.js   executeTool + standard metadata tools
     src/tools-programs.js   program-authoring tools
     src/tools-linelists.js  line-list authoring
     src/tools-admin.js      users · data values · metadata translations · PATCH pre-check
     src/tools-sqlviews.js   manage_sql_views — SQL views (data no endpoint has, real DB columns)
     src/tools-apps.js       manage_custom_app — AI-built DHIS2 apps & dashboard plugins
     src/tools-apps-placement.js  manage_custom_app place / unplace / placements
     src/agent.js            agent loop · feedback · keepalive · message router
   )
```

### Why `importScripts` and not ES modules?

The modules share **one classic-worker global scope**, exactly as when this
was a single file. A `const` or `function` declared in `core.js` is visible to
every later module with no `import`/`export`. That is deliberate:

- The original code leaned heavily on shared mutable globals (`dhis2`,
  `conversationHistory`, `conversationEpoch`, per-turn registries…). Rewiring all
  of that into ES-module imports/exports is a large, bug-prone change. Splitting
  along `importScripts` preserves behaviour **exactly** — the running worker is
  identical to the concatenation of `src/*.js` in load order.
- `importScripts` is synchronous and runs during the worker's initial
  evaluation, so the `chrome.*` event listeners at the bottom of `src/agent.js`
  are registered synchronously, which Manifest V3 requires.

**Load order matters.** A module may use declarations from an *earlier* module at
load time, never a later one. Keep the order in `background.js` as-is unless you
know a moved declaration has no load-time dependents.

## What lives in each module

| Module | ~lines | Contents |
| --- | --- | --- |
| `src/core.js` | 3.6k | `DEFAULT_PROVIDER_CONFIG` & provider URL helpers; the `dhis2` state object and conversation globals; the **write-authorization** gate (`classifyWriteAuthorization`, `requireWriteAuth`); UID recognition/harvesting; repeated-failure & HTTP circuit breakers; inspect capture; text/URL/UID utils (`lowercaseText`, `normalizeSearchTokens`, `extractContext`…); connection & state persistence; the DHIS2 transport choke point (`safeDhis2Fetch`, `dhis2Fetch`, `fetchViaTab`); backups (`snapshotBeforeWrite`, `restoreFromBackup`); tracker-write & analytics helpers; `initializeFromUrl`; line-listing routing. |
| `src/memory.js` | 0.8k | The **learning memory**: lesson store in `chrome.storage.local` (`dhis2AiMemory`, on/off `memoryEnabled`), privacy scrubbing + patient-data taint, per-turn observation (`memoryBeginTurn` / `memoryObserveCall` / `memoryEndTurn` — failure→fix pairs become lessons), task-aware retrieval (`buildMemoryPromptBlock`, `memoryLessonsFor`), the `manage_memory` tool and the panel's `MEMORY_*` API. Loaded right after `core.js` because `TOOLS` uses its area list. |
| `src/registry.js` | 4.2k | The `TOOLS` schema array (what the model sees); the knowledge-base `KB_*` strings and per-tool manuals; the parallel tool lists (`TOOL_ROUTER`, `MANUAL_TOOLS`, `TOOL_SUMMARIES`, `MANUAL_EXTRAS`); `getContextualTools` (deterministic tool selection) and `buildSystemPrompt`. |
| `src/providers.js` | 2.0k | LLM streaming for every provider (`callProviderStreaming`, OpenAI-compatible + Anthropic adapters, stall guard); `analyzeImage`; `tavilySearch`; read/analytics tool helpers (recent-changes, enrollment abnormalities); the **patient-data privacy gate** (`canonicalApiPath`, `pathReadsPatientData`, `enforcePatientDataPrivacyGate`, `PATIENT_DATA_TOOL_NAMES`) and its one exception, SQL views that read only metadata (`analyzeSqlViewPrivacy` — a fail-closed SQL table/function/variable analyzer — `sqlViewPrivacyVerdict`, `enforcePatientDataPrivacyGateAsync`). |
| `src/tools-metadata.js` | 6.8k | `executeTool` (the dispatcher) plus the standard-metadata tool implementations: validation rules, org units, indicators, option sets, legend sets, visualizations, maps, dashboards, datasets, backups, generic create-metadata, custom forms. |
| `src/tools-programs.js` | 8.0k | The program-authoring tools: full program/stage creation, program rules (+ linters), program indicators (+ linters), program notifications, custom translations, growth-chart plugin, standalone metadata/architect helpers. |
| `src/tools-linelists.js` | 0.7k | `manage_line_lists` — Line Listing authoring (eventVisualizations of type LINE_LIST): program-metadata dimension resolution, filter/repetition/legend/PI linting, the pre-save analytics probe, CRUD + validate. |
| `src/tools-admin.js` | 1.3k | Administration tools: `manage_users` (users, roles with authority validation, groups), `manage_data_values` (one aggregate form: get/set/delete/complete/validate with client-side period/OU/disaggregation/value checks), `manage_metadata_translations` (merge-safe object translations); shared id-or-name resolution, the schema cache, and `precheckPatchAgainstSchema` used by `dhis2_query`. |
| `src/tools-sqlviews.js` | 0.5k | `manage_sql_views`: list / get / describe (real columns from `information_schema` via a temporary view) / create / update (each RUNS the view once; a failing view is removed or put back) / delete / run. Client-side pre-checks for every read-time refusal DHIS2 gives (illegal words anywhere in the text, protected tables, 2.41/2.43 table renames, variables, unreadable sharing). What the model sees of a run is decided by `analyzeSqlViewPrivacy` (`providers.js`). |
| `src/tools-apps.js` | 1.4k | `manage_custom_app`: key rules, the runtime kit loader (`libs/d2-kit/` via `fetch(chrome.runtime.getURL(…))`), Sucrase compile + JSX tag/bracket diagnosis, the static safety scan, the runtime-error lint (kit export lists in `KIT_VERSION.json`), hard-coded-UID verification, packaging (manifest, HTML, `app-config.js`, embedded `src/`), install/verify through `uploadAppZip` (`core.js`), app backups in the shared backup namespace, preview tokens, update/rollback/delete. Only ever touches `ai-*` apps carrying the assistant's marker. |
| `src/tools-apps-placement.js` | 0.6k | `manage_custom_app` `place` / `unplace` / `placements`. Dashboard plugins go onto dashboards through `manage_dashboards` (`APP` items). Capture plugins are written into Capture's own configuration in the `capture` dataStore namespace, in the Tracker Plugin Configurator's exact format (verified against the Capture 106 bundle): enrollment-page layouts per program (starting from Capture's default page when a program has none), and stage / registration forms with a field map. Every write is backed up (`capture_config` entries that `manage_backups` restores) and read back with jsonb-key-order-insensitive comparison. `unplace` restores replaced fields and drops entries that are back to Capture's default. |
| `src/agent.js` | 1.7k | The agentic loop (`runAgenticLoop`, `_runAgenticLoopInner`); feedback storage; the bounded keepalive lease; screenshot capture (selection overlay with in-page tab-capture fallback) and cropping; `broadcast`; the `chrome.runtime.onMessage` router and every other `chrome.*` event listener. |

## The safety gates (do not weaken these to simplify anything)

These are enforced in **code**, not in the prompt. They are the reason the
assistant can be trusted to touch a live DHIS2 server:

- **Write authorization** — `classifyWriteAuthorization` / `requireWriteAuth`
  (`core.js`). Default is read-only; a destructive action needs explicit user
  intent, and a bare "yes" is scoped to the previously proposed action.
- **Patient-data privacy** — `enforcePatientDataPrivacyGateAsync` (`providers.js`).
  Row-level tracker/analytics reads and tracker audit trails are blocked for
  remote model providers at the execution choke point. The only exception is a
  QUERY SQL view whose CURRENT SQL reads metadata tables alone (decided by
  `analyzeSqlViewPrivacy`, fail closed); `manage_sql_views` shows any other view
  as column names + row count only.
- **Verified IDs & preflight** — `core.js`. The model cannot invent a DHIS2 UID
  and use it in a destructive call.
- **Backups first** — `ensureBackupOrBail` / `snapshotBeforeWrite` (`core.js`).
- **Circuit breakers** — repeated-failure and HTTP breakers (`core.js`) stop the
  loop retrying a deterministic error forever.

`scripts/verify.js` asserts the behaviour of several of these on every run.

## Adding or changing a tool

Tool knowledge is still spread across several hand-maintained lists (this was
**not** consolidated into one registry in this pass — see "Deferred", below). To
add a tool today you touch, in order:

1. `src/registry.js` — add the schema to **`TOOLS`**; add the name to
   **`TOOL_ROUTER`** (existence allowlist). For a write tool with a first-call
   manual, also add **`TOOL_SUMMARIES`**, **`MANUAL_TOOLS`**, and any
   **`MANUAL_EXTRAS`**. Wire it into **`getContextualTools`** so it is offered in
   the right context (and into `writeCapableNames` there if it writes).
2. `src/tools-metadata.js` — add the dispatch branch in **`executeTool`**, and
   the handler itself (or a `executeManageX` in the appropriate tools module).
3. If it reads patient-level data, classify it in **`PATIENT_DATA_TOOL_NAMES`**
   (`providers.js`).
4. Optionally add a progress label to **`thinkingAfterTool`** (`src/agent.js`).
5. Run `npm run verify` and reload the extension.

> Because the lists are parallel, `scripts/verify.js` and a manual reload are
> your safety net until the single-registry work (below) is done.

## Verifying changes

```
npm run verify      # or: node scripts/verify.js
```

It has **no dependencies**. It (1) `node --check`s every runtime file, (2) loads
all modules (and the two vendored libs) in `importScripts` order under a minimal `chrome` shim to prove
the split is internally consistent, and (3) exercises the safety-critical pure
functions. A red result means a gate changed shape or a module stopped loading.

Then do a real reload: `chrome://extensions` → refresh the extension card →
reload the DHIS2 tab. Node checks are necessary, not sufficient.

### Vendored files and the one dev-time build

The extension never runs npm. `libs/d2-kit/` (the runtime kit packed into every
AI-built app), `libs/sucrase.min.js` and `libs/fflate.min.js` are **committed
output** of `scripts/build-runtime-kit.js`, a dev-only script that installs exact
pinned versions in a temp dir and bundles them with esbuild. Run it only when
bumping a pin; the output is reproducible byte for byte. `npm run apps`
(`scripts/scenario-custom-apps-visual.js`) is the live + visual acceptance suite
for `manage_custom_app` (needs a local DHIS2, Chrome and an existing Playwright
install).

## Deferred (intentionally not done in this pass)

These are sound ideas from the maintainability review that were **left for
later** because each changes runtime behaviour or adds a build step, and this
pass prioritised a safe, behaviour-preserving refactor:

- **Single declarative tool registry** — collapse the parallel lists in
  "Adding a tool" into one `ToolModule` entry per tool with contract tests. This
  is the highest-value next step.
- **Typed state stores** — split the `dhis2` mega-object into settings / session
  / conversation / per-turn stores with explicit lifetimes.
- **A single `Dhis2Client`** injected into tools so no handler can bypass the
  transport/backup/privacy pipeline with a raw `fetch`.
- **Split `sidepanel/panel.js`** (2.6k lines) into controllers with a typed
  message contract.
- **TypeScript + a bundler** — only worth it if the team wants types; it adds a
  build step to a currently build-free extension.
