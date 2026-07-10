# v2.8.9 — Program-indicator deep test: widget visibility, boundary correctness, real parser grammar

## What was tested (play 2.42.5.1, "Maternal and Child Health (MCH) Program" `aks8IcfaKad`)

The full indicator lifecycle was driven through the extension's REAL tools (chrome-shim
harness → `executeTool`), modeling WHO ANC DAK indicators against the program's actual
metadata:

1. **12 complex program indicators** via `manage_program_indicators(create)` — first-trimester
   booking (`d2:daysBetween(LMP, V{enrollment_date}) <= 84`), 4+ ANC contacts
   (`d2:count(...) >= 4`), IFA at least once (`d2:countIfValue(...) > 0`), gestational age
   (`daysBetween/7`, AVERAGE, decimals 0), anaemia (Hb<11), hypertension (≥140/90),
   C-section, low birth weight, mean birth weight, APGAR<7, heavy PP bleeding, exclusive
   breastfeeding. 5 of them widget-visible.
2. **12-woman tracker cohort** (12 enrollments, 67 ANC/delivery/PNC events, 91 objects)
   entered through `dhis2_query` tracker bundle write; analytics run; values verified.
3. **6-tile dashboard** `ON7Mo5bJtd8` ("MCH Program Monitoring") via
   `manage_dashboards` — COLUMN + LINE + PIVOT_TABLE + SINGLE_VALUE inline in one atomic
   `create_dashboard`, then standalone `create_visualization` + non-destructive `add_items`.

## Defects found and fixed (background.js)

| # | Defect | Fix |
|---|--------|-----|
| 1 | No way to show an indicator in the Tracker Capture right-side **Indicators widget**, and every tool update silently RESET `displayInForm` to false (full-object import) | New `indicator.display_in_form` (create/update); always serialized; existing flag fetched and threaded through update, bulk_fix, bulk_fix_expressions; returned by `get`. Round-trip proven on 2.42.5.1 before coding |
| 2 | ENROLLMENT indicators created with hard-coded **EVENT_DATE boundaries** → enrollment counted in every period containing one of its events ("first trimester" = 58 with only 25 enrollments) and `d2:count()` filters permanently 0 ("4+ ANC contacts") | Boundary target now follows analytics type (ENROLLMENT_DATE ↔ EVENT_DATE) in `_buildAndPostProgramIndicator` AND create_program's embedded-PI path; changing analytics_type on update regenerates the pair; `audit` flags existing mismatched PIs. Verified: 4+ANC 0→12, first-trimester 58→14, IFA 44→20 |
| 3 | d2-function whitelist followed the **docs**, but the real PI parser (verified on 2.42.5.1 AND 2.43.0-1) rejects floor/ceil/round/modulus/addDays/left/right/substring/split/concatenate/length/validatePattern/inOrgUnitGroup/lastEventDate/zScoreHFA/WFA/WFH, and accepts `d2:hasValue` in FILTERS only | Whitelist reduced to the 16 parser-verified functions; rejected set now caught locally with targeted hints (rounding → plain arithmetic + `decimals`; OU scoping → visualization ou dimension); hasValue-in-expression caught; `KB_PI_GRAMMAR` rewritten to match reality + documents `display_in_form` |

## Verification

- `mch-pi-drive.js` 26/26 · `mch-pi-retry.js` 3/3 · `mch-data-entry.js` 7/7 ·
  `mch-fix-enrollment-pis.js` 13/13 · `mch-dashboard.js` (dashboard live, 6 tiles, 11 PI
  dimension items) — all against play 2.42.5.1 through the real `executeTool`.
- Parser-support matrix built live: every claimed d2 function POSTed to
  `/programIndicators/{expression|filter}/description` on both 2.42.5.1 and 2.43.0-1.
- Regressions: `e2e-happy-path.js` 8/8 (full agentic loop incl. PI create+delete),
  auth-gate suite 18/18, `node --check` clean.

## Deliverables left on the playground (intentional — user-requested)

- 12 `MCH:` program indicators on program `aks8IcfaKad` (5 with `displayInForm:true`).
- 12 demo TEIs + enrollments + 67 events at Ngelehun CHC.
- Dashboard **MCH Program Monitoring** (`ON7Mo5bJtd8`) with 5 visualizations + text tile.

Note: play.im.dhis2.org resets nightly — the deliverables exist for review until the reset.
