# Batch program-indicator create + single-PI percentage (v2.8.18)

## The disaster

Prompt (abbreviated): *"Using the Integrated Pregnancy, Delivery and Postnatal Care
Tracker, create the analytical metadata … the necessary program indicators, supporting
numerator and denominator counts, final percentage indicators, legends, tables, charts,
maps, and dashboard items … Dashboard: Maternal and Newborn Continuum Dashboard."*

What the model did: created **47 program indicators, one per `manage_program_indicators`
call**, ran the 50-iteration agentic loop dry on PI creation, and stopped having produced
**zero** percentages, legends, visualizations, maps or the dashboard. It also split every
metric into a separate numerator PI + denominator PI + (never-reached) percentage object.

Two root causes:

1. **No batch.** `manage_program_indicators(action="create")` accepted only a single
   `indicator`. A build that legitimately needs 15–40 program indicators could never fit
   the loop budget — every indicator cost one whole iteration.
2. **No percentage model.** Nothing told the model that a DHIS2 coverage/rate **percentage
   is one program indicator**, so it over-decomposed and multiplied the object count.

## The fix

### 1. Batch create — `manage_program_indicators(action="create", program_id, indicators:[…])`

`src/tools-programs.js`:

- **`_buildAndPostProgramIndicator` was split.** The build + full validation half is now
  `_prepareProgramIndicatorObject(programId, indicatorId, indicator, opts)` — it resolves
  the category combo, builds the PI object, runs the local expression/filter lint, grounds
  every `#{stage.de}` against the program's real structure, and calls DHIS2's
  `/programIndicators/expression|filter/description` endpoints. It returns
  `{ pi, precedenceAdvisories }` or an `{ _error, _hint, … }` shaped exactly like the old
  create-time refusals. `opts.catComboId` / `opts.progStagesById` let a batch share ONE
  category-combo + program-structure fetch across all indicators. The single-indicator
  `_buildAndPostProgramIndicator` now delegates to it, so its behaviour is unchanged.
- **`_buildAndPostProgramIndicatorsBatch(programId, indicators, dryRun)`** validates every
  indicator with bounded concurrency (6), partitions valid vs. failed, then commits the
  valid ones in a SINGLE `/metadata` import. It:
  - **skips** invalid entries (never disables the tool) and returns them under `failed[]`
    with their `_error`/`_hint`, so the model fixes only those and re-batches the remainder;
  - guarantees **shortName uniqueness** against the server (batched probes) AND intra-batch;
  - guarantees **name uniqueness** (programIndicator names are globally unique) against the
    server (one `name:in:[…]` probe per 50) AND intra-batch, auto-suffixing collisions;
  - returns a flat **`program_indicator_ids`** list plus `created[]` for chaining straight
    into visualization/map/dashboard `data_items`.
- The `create` dispatch takes `indicators:[…]` when present, else the single `indicator`.

`src/registry.js`: the schema gains an `indicators` array (same item shape as `indicator`);
the tool description, the `create` action-enum text, and the `indicator`/`indicators`
property docs all steer toward the batch and the single-PI percentage pattern.

### 2. Single-PI percentage pattern (KB)

`KB_PI_GRAMMAR` (delivered on first `manage_program_indicators` call) now states that a
coverage/rate metric is **ONE** program indicator:

```
analytics_type : ENROLLMENT           # count each woman/pregnancy once, not per visit
filter         : <denominator population>          e.g. #{FIPs4MVhcok.npYTHMLdHdU} < 999
expression     : d2:condition("<numerator condition>", 100, 0)
                                       e.g. d2:condition("#{FIPs4MVhcok.npYTHMLdHdU} < 12", 100, 0)
aggregation_type : AVERAGE            # mean of the 0/100 flag over the denominator = the %
decimals       : 1
```

The mean of a 0/100 flag over the filtered (denominator) population **is** the percentage,
and it contains **no division**, so — unlike a numerator/denominator ratio — it never 409s
on a zero denominator. Separate numerator/denominator COUNT PIs are created only when a
table/breakdown explicitly needs those counts as columns. A new "build the analytical
package for a TRACKER program" worked chain in `buildSystemPrompt` lays out the full
sequence: read structure → batch the PIs → legends → maps → one `create_dashboard` with
inline visualizations + map tiles + text headers → share.

### 3. Map-tile refusal hint

`src/tools-metadata.js`: `buildVisualizationObject` refusing `vis_type:"MAP"` now returns a
`_hint` telling the model to create the map with `manage_maps` and add it as
`{ type:"MAP", map_id }` — one-step recovery from the one mistake the live LLM made.

## Verification

**Tier 1 — `npm run verify`:** green, with new assertions that the schema exposes
`indicators[]`, keeps the single `indicator`, teaches batch + the AVERAGE percentage
pattern in its description, and refuses `vis_type:"MAP"` with a `manage_maps` hint.

**Tier 2 — deterministic (`scripts/scenario-pregnancy-analytics.js`):** drives the real
`executeTool` on localhost:8081 — discover program, read structure, **batch-create 16 PIs
(8 AVERAGE percentages + 8 counts) in ONE call**, create a legend + 2 maps, create one
dashboard with 9 inline visualizations + 2 map tiles + 4 text headers, verify all
persisted, then delete everything. Result: **60 build API calls, 0 failed, 0 leftovers.**

**Tier 2 — real LLM (Kimi K2P7-code via Fireworks, live localhost:8081):** the exact
disaster prompt now completes end-to-end — **78 program indicators created in 2 batched
calls** (16 single-PI AVERAGE percentages + 62 requested supporting/breakdown counts), 4
legend sets, 4 district maps, and the full **Maternal and Newborn Continuum Dashboard** (35
tiles: 7 text sections, 24 charts, 4 maps, **0 dangling references**), with sharing —
**120 DHIS2 API calls, 0 failed.** Every test object was deleted afterward; the instance was
left exactly as found.

## Why this is only an improvement

- The single-`indicator` create path is byte-for-byte unchanged in behaviour (it now
  delegates to the extracted prepare step, which is the same code it used inline before).
- Batch validation reuses the exact same lint + server-description checks, so a bad
  expression is still refused before anything is saved — a batch of 40 with one bad
  expression saves the 39 good ones and reports the one, instead of failing the whole call.
- The map-tile hint only adds guidance to an already-existing refusal; it changes no
  success path.
