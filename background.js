/* ══════════════════════════════════════════════════════════════════════════════
   DHIS2 AI Assistant — Background Service Worker (entry point)

   The worker is split into focused modules under src/, loaded IN ORDER via the
   synchronous importScripts() below. They all share ONE classic-worker global
   scope — exactly as when this was a single 26k-line file — so there is no
   import/export wiring and no build step: the running behaviour is identical to
   the concatenation of the modules, in this order.

   Because importScripts is synchronous and runs during the worker's initial
   evaluation, the chrome.* event listeners registered at the bottom of
   src/agent.js are registered synchronously, as Manifest V3 requires.

   Load order matters — each module may use declarations from earlier ones at
   load time. See ARCHITECTURE.md for the full map of what lives where.

     src/core.js            provider config · global state · write-auth & safety
                            gates · DHIS2 transport & backups · context/init
     src/memory.js          learning memory (lessons about DHIS2/API behaviour;
                            never patient data) · manage_memory tool — loaded
                            right after core.js (registry's TOOLS uses its areas)
     src/registry.js        tool schemas · knowledge-base · manuals · tool
                            selection · system-prompt builder
     src/providers.js       LLM provider streaming · image · web search ·
                            read/analytics helpers · patient-data privacy gate
     src/tools-metadata.js  executeTool dispatcher · standard metadata tools
                            (validation, org units, indicators, option/legend
                            sets, visualizations, maps, dashboards, datasets,
                            custom forms)
     src/tools-programs.js  program-authoring tools (metadata/programs, rules,
                            indicators, notifications) · plugins · standalone
     src/tools-linelists.js line-listing authoring (eventVisualizations of type
                            LINE_LIST: resolve/validate/probe/CRUD)
     src/tools-admin.js     administration tools (users/roles/groups, aggregate
                            data values, metadata translations) · schema-aware
                            PATCH pre-check for dhis2_query
     src/tools-apps.js      manage_custom_app — AI-built DHIS2 apps & dashboard
                            plugins (validate · safety-scan · package · install)
     src/tools-apps-placement.js  manage_custom_app place / unplace / placements
                            (dashboards · Capture pages · Capture form fields)
     src/agent.js           agentic loop · feedback · keepalive · message router
                            and every chrome.* event listener

   Two third-party libraries load first (vendored, built by the dev-only
   scripts/build-runtime-kit.js): libs/sucrase.min.js (JSX → JS, self.sucrase)
   and libs/fflate.min.js (zip, self.fflate) — used only by tools-apps.js.
   ══════════════════════════════════════════════════════════════════════════════ */

importScripts(
  'libs/sucrase.min.js',
  'libs/fflate.min.js',
  'src/core.js',
  'src/memory.js',
  'src/registry.js',
  'src/providers.js',
  'src/tools-metadata.js',
  'src/tools-programs.js',
  'src/tools-linelists.js',
  'src/tools-admin.js',
  'src/tools-apps.js',
  'src/tools-apps-placement.js',
  'src/agent.js',
);
