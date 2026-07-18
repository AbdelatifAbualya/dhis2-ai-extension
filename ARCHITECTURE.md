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

## The background worker is 7 modules, not one file

`background.js` used to be a single ~26k-line service worker. It is now a thin
loader that pulls in seven focused modules **in order** with the synchronous
`importScripts()` API:

```
background.js  (loader — 40 lines)
└─ importScripts(
     src/core.js            ── provider config · global state · write-auth &
     src/registry.js           safety gates · DHIS2 transport & backups · context
     src/providers.js          / tool schemas · KB · manuals · tool selection ·
     src/tools-metadata.js     system prompt / LLM streaming · image · web search ·
     src/tools-programs.js     read helpers · privacy gate / executeTool + standard
     src/tools-linelists.js    metadata tools / program-authoring tools /
     src/agent.js              line-list authoring / agent loop · feedback ·
   )                           keepalive · message router
```

### Why `importScripts` and not ES modules?

The seven modules share **one classic-worker global scope**, exactly as when this
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
| `src/core.js` | 3.5k | `DEFAULT_PROVIDER_CONFIG` & provider URL helpers; the `dhis2` state object and conversation globals; the **write-authorization** gate (`classifyWriteAuthorization`, `requireWriteAuth`); UID recognition/harvesting; repeated-failure & HTTP circuit breakers; inspect capture; text/URL/UID utils (`lowercaseText`, `normalizeSearchTokens`, `extractContext`…); connection & state persistence; the DHIS2 transport choke point (`safeDhis2Fetch`, `dhis2Fetch`, `fetchViaTab`); backups (`snapshotBeforeWrite`, `restoreFromBackup`); tracker-write & analytics helpers; `initializeFromUrl`; line-listing routing. |
| `src/registry.js` | 4.2k | The `TOOLS` schema array (what the model sees); the knowledge-base `KB_*` strings and per-tool manuals; the parallel tool lists (`TOOL_ROUTER`, `MANUAL_TOOLS`, `TOOL_SUMMARIES`, `MANUAL_EXTRAS`); `getContextualTools` (deterministic tool selection) and `buildSystemPrompt`. |
| `src/providers.js` | 2.0k | LLM streaming for every provider (`callProviderStreaming`, OpenAI-compatible + Anthropic adapters, stall guard); `analyzeImage`; `tavilySearch`; read/analytics tool helpers (recent-changes, enrollment abnormalities); the **patient-data privacy gate** (`pathReadsPatientData`, `enforcePatientDataPrivacyGate`, `PATIENT_DATA_TOOL_NAMES`). |
| `src/tools-metadata.js` | 6.8k | `executeTool` (the dispatcher) plus the standard-metadata tool implementations: validation rules, org units, indicators, option sets, legend sets, visualizations, maps, dashboards, datasets, backups, generic create-metadata, custom forms. |
| `src/tools-programs.js` | 8.0k | The program-authoring tools: full program/stage creation, program rules (+ linters), program indicators (+ linters), program notifications, custom translations, growth-chart plugin, standalone metadata/architect helpers. |
| `src/tools-linelists.js` | 0.7k | `manage_line_lists` — Line Listing authoring (eventVisualizations of type LINE_LIST): program-metadata dimension resolution, filter/repetition/legend/PI linting, the pre-save analytics probe, CRUD + validate. |
| `src/agent.js` | 1.7k | The agentic loop (`runAgenticLoop`, `_runAgenticLoopInner`); feedback storage; the bounded keepalive lease; screenshot cropping; `broadcast`; the `chrome.runtime.onMessage` router and every other `chrome.*` event listener. |

## The safety gates (do not weaken these to simplify anything)

These are enforced in **code**, not in the prompt. They are the reason the
assistant can be trusted to touch a live DHIS2 server:

- **Write authorization** — `classifyWriteAuthorization` / `requireWriteAuth`
  (`core.js`). Default is read-only; a destructive action needs explicit user
  intent, and a bare "yes" is scoped to the previously proposed action.
- **Patient-data privacy** — `enforcePatientDataPrivacyGate` (`providers.js`).
  Row-level tracker/analytics reads are blocked for remote model providers at
  the execution choke point.
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
all seven modules in `importScripts` order under a minimal `chrome` shim to prove
the split is internally consistent, and (3) exercises the safety-critical pure
functions. A red result means a gate changed shape or a module stopped loading.

Then do a real reload: `chrome://extensions` → refresh the extension card →
reload the DHIS2 tab. Node checks are necessary, not sufficient.

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
- **De-duplicate the line-listing router** — `line-listing/dhis2_extension_router.js`
  is a reference artifact; the live routing is `LINE_LISTING_KEYWORD_ROUTES` +
  `routeLineListingBlocks` in `core.js`. (The dead `routerSource` fetch was
  already removed.)
- **Split `sidepanel/panel.js`** (2.6k lines) into controllers with a typed
  message contract.
- **TypeScript + a bundler** — only worth it if the team wants types; it adds a
  build step to a currently build-free extension.
