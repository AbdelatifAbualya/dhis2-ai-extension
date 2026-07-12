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
     src/agent.js           agentic loop · feedback · keepalive · message router
                            and every chrome.* event listener
   ══════════════════════════════════════════════════════════════════════════════ */

importScripts(
  'src/core.js',
  'src/registry.js',
  'src/providers.js',
  'src/tools-metadata.js',
  'src/tools-programs.js',
  'src/agent.js',
);
