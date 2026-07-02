# End-to-end audit — WHO ANC DAK build on the playground (2026-07-01/02)

Full-stack QA of the enhance-performance branch: a complex, real-world DHIS2 task was executed
**through the extension's own tool layer** (`executeTool` + router + write gates, driven
programmatically against `https://play.im.dhis2.org/stable-2-42-5-1`), every failure was
root-caused, the same task was completed directly via the Web API to establish best practice,
and the deltas were folded back into `background.js` (v2.6.8).

## The task (modeled on the WHO Antenatal Care Digital Adaptation Kit)

Built end-to-end, chatbot-tool-path only:

- **Program** "ANC Registry (AI QA)" — tracker, 5 stages (Profile & History, Quick Check ↺,
  ANC Contact ↺, Lab Tests ↺, Close Record), 28 DEs, 9 option sets, 4 TEAs, all-OU assignment —
  one atomic `create_metadata` bundle (73 objects, VALIDATE→COMMIT, 4.5 s).
- **9 program rules** (age 10–49 validation via `A{dob}`+`V{enrollment_date}`, BP ≥140/90
  warning, 3-band anemia ASSIGN from Hb, danger-signs → mandatory referral, 2 conditional
  HIDEFIELDs, EDD auto-calc `d2:addDays(#{lmp},280)`) + clean post-create audit.
- **6 program indicators** (1st contacts, total contacts, 4+ contacts, hypertensive, anemic,
  danger-sign referrals) — all server-validated pre-save; traffic-light legend set.
- **Custom HTML forms** on two stages (auto-generated + hand-designed).
- **Map** (choropleth on the anemic-contacts PI) + **dashboard** (TEXT, COLUMN, PIVOT_TABLE,
  SINGLE_VALUE, LINE, MAP) — all live with real analytics data from 11 synthetic patients.
- **Rules verified firing in Capture**: hypertension warning on BP 150/95, severity
  auto-assigned "Moderate" at Hb 8, danger-signs reveal + SETMANDATORYFIELD, HIDEFIELD.

## Findings → fixes (all live-reproduced before fixing, all regression-tested after)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | **Critical** | `create_metadata` reused same-name options **across option sets**; DHIS2 re-parents them (1 option belongs to 1 set), silently corrupting unrelated sets ("None"/"Mild" were stolen live from another set; demo-DB sets were also hit) | Cross-set option dedup deleted — every new set gets its own option rows with derived codes |
| 2 | **High** | Programs created without an explicit `sharing` arg got server default `rw------` → nobody (incl. admin) could save enrollments/events (E1091/E1095) | Sharing block always built: public `rwrw----` on program+stages, metadata-only cascade to children |
| 3 | **High** | Auto-generated custom forms: bare `<table border=1>`, no width control → too narrow in Capture's card, reflow/stretch on validation messages ("too narrow / too wide") | Responsive inline-styled generator: 920px max wrapper, fixed-layout 100% table, 40/60 colgroup, section cards, zebra rows, `max-width:430px` inputs — rendering verified in Capture view+edit |
| 4 | **High** | Rules assigning option *names* (`'Moderate'`) to option-set DEs bounce every event save w/ E1125 (server engine validates against CODES; runs on import in 2.42+) | Pre-POST check: codes pass, names auto-map to codes, unknown values refused with the valid-code list |
| 5 | Medium | `A{name}` refs were refused even when the model passed `variables:[]` exactly as the tool's own error hint instructed | A{} resolves against existing PRVs + supplied variables before TEA-name rewrite |
| 6 | Medium | Write-auth regex missed set/configure/apply/install/restore/undo…; object names containing "check" ("Quick Check") tipped requests into read_only | Verbs added (ambiguous ones imperative-only); problem reports still classify read_only |
| 7 | Medium | `search_metadata(query=…)` silently ignored `query` → returned the whole collection; arbitrary first row nearly steered a delete at the wrong program (server 409 + auto-backup caught it) | `query`/`name`/`search` aliases honored; exact displayName matches rank first |
| 8 | Doc | Capture caches program metadata in IndexedDB → newly saved custom forms "don't show" until hard refresh; custom stage forms render on **view/edit**, not the New-event flow (2.42) | Both stated in `set_stage_form` `_hints` |
| 9 | Doc | README claimed 25 tools (there are 31) and a "23-tool agentic loop" | Corrected; table lists all 31 |

## Safeguards verified working (19/19 pre-fix suite + 20/20 post-fix suite)

- **Hard privacy gate** (patient-level tracker data ⇄ local model only): blocks
  `tracker/trackedEntities|events|enrollments` (incl. `.json`/`.csv` suffix bypass),
  legacy `trackedEntityInstances`, `analytics/events/query`, `get_event_analytics(query)`,
  `detect_enrollment_abnormalities` on a remote provider; allows de-identified aggregates;
  lifts on Ollama/localhost. Enforced in code at the `executeTool` choke point.
- **Write-auth gate**: problem reports ("I'm getting an error…") refuse all destructive
  branches incl. raw `dhis2_query` writes; explicit verbs authorize per-turn only.
- **Auto-backup + restore**: every mutating action snapshotted first (custom forms, sharing,
  rule updates, option-set edits, deletes). Dashboard delete → `manage_backups(restore)`
  round-trip restored all 6 tiles exactly.
- **Destructive-404 circuit breaker** trips after 2 consecutive missing-target writes.
- **Misroute guards**: raw sharing PUT deflected to `manage_metadata`; protected app
  dataStore namespaces refused (server 403 + guard).
- Wrong-target delete attempt was stopped by DHIS2 reference checking **after** a backup
  had already been taken — defense in depth held.

## Best-practice sequence captured (direct-API path)

1. One atomic `/api/metadata` bundle for program+stages+DEs+option sets+TEAs (pre-generated
   UIDs), **including** `sharing` on program+stages.
2. PRVs + rules + actions in one bundle; `A{teaUid}` or TEI_ATTRIBUTE PRV names; ASSIGN uses
   option **codes**.
3. PIs validated via `/programIndicators/expression|filter/description` before save.
4. `dataEntryForms` POSTed standalone, then full-PUT the stage with `program` re-attached
   (already encoded); inline-styled responsive HTML.
5. Maps: `POST /api/maps` with `mapViews[]` (columns=dx PI item, rows=ou LEVEL-x, filters=pe),
   then dashboard references `{type:MAP, map_id}`.
6. `POST /api/resourceTables/analytics?lastYears=1` for fresh PI numbers.

## Residue

All QA/test objects created during verification were deleted (programs, DEs, option sets,
TEAs). The demo-DB option sets damaged by finding #1 pre-fix heal on the playground's nightly
reset. The "ANC Registry (AI QA)" program + dashboard were left on the instance intentionally
as a working reference build (also resets nightly).
