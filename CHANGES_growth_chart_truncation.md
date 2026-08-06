# Growth chart plugin — `Program "undefined" is not a tracker program`

**Date:** 2026-07-26
**Branch:** New-Design
**Reported against:** a self-hosted DHIS2 2.42.5.1 instance, on an existing tracker
program with a school-examination stage
**Files:**
- `src/core.js` — `safeDhis2Fetch()` large-response truncation + `_apiPath`/`_pagerInfo` stamping
- `src/tools-programs.js` — `gcFetchProgram()`, `gcFetchStageDataElements()` (new),
  `gcPickMeasurement()` (new), `gcReadConfig()`, `gcWriteConfig()`, `growthChartConfigure()`
- `src/registry.js` — `KB_GROWTH_CHART_DETAILS` manual
- `scripts/scenario-growth-chart.js` (new) — live acceptance
- `scripts/verify.js` — offline regression for the measurement picker

## What the user saw

> `manage_growth_chart_plugin(configure, program: …, stage: …)`
> → `Program "undefined" is not a tracker (WITH_REGISTRATION) program.`

Every retry produced the identical error. The retry guard then blocked the tool, the
model tried to hand-write `dataStore/captureGrowthChart/config` via `dhis2_query`
(correctly refused by the namespace guard), and the turn ended with the setup
handed back to the user as a manual `curl`. Meanwhile a plain
`dhis2_query programs/<uid>?fields=id,displayName,programType` in the same turn
returned `WITH_REGISTRATION` — the tool was contradicting a call the model had just
made.

## Root cause 1 — the 80 KB truncation gutted the program object

`gcFetchProgram()` asked for the whole program in one request, expanding
`optionSet[id,options[code,displayName]]` for **every** tracked-entity attribute.
That program carries a "School" lookup option set with a few thousand options, so
the response was **446 KB**.

`safeDhis2Fetch()` truncated anything over 80 KB, and for a plain object (no `rows`,
`trackedEntities`, `programRules`, …) the truncation branch fell through to:

```js
const truncated = { _apiPath, _pagerInfo, _truncated: true, _originalSize };
// … no matching collection branch …
truncated._note = `Response too large (…). Use more specific filters or fields.`;
return truncated;
```

Everything else was discarded. `prog.programType` and `prog.displayName` became
`undefined`, and the very next line reported the program was not a tracker:

```js
if (prog.programType !== 'WITH_REGISTRATION') {
  return { _error: `Program "${prog.displayName}" is not a tracker …` };
}
```

Truncation is a **model-context** protection. It fired on a response the extension
itself was parsing to make a decision, and turned a valid program into a confident
lie that no retry could escape.

### Fix

`src/core.js`, `safeDhis2Fetch()`:

1. **Never truncate a response the extension consumes as data.** Three categories
   are now always returned whole:
   - callers that opt out (`noTruncate: true`);
   - **every write response** — import/validate `typeReports` carry the import
     errors, so a truncated report reads as a clean success;
   - **`fields=:owner` / `:all` reads**, which are always read-modify-write. A
     truncated `:owner` body PUT straight back would have wiped the object.
2. **Shape-preserving truncation** for everything else. Top-level scalars (`id`,
   `displayName`, `programType`, `valueType`, `formType`, `code`, …) are always
   carried over, and the withheld collections are named in `_truncated_fields`
   (e.g. `["programStages[1]", "programTrackedEntityAttributes[14]"]`) so a caller
   can tell "absent" apart from "too big to send".

Proven live against the reported program:

```
truncated         : true
originalSize      : 352477
id                : <program uid>
displayName       : <program name>
programType       : WITH_REGISTRATION      ← was undefined
_truncated_fields : [ 'programStages[1]', 'programTrackedEntityAttributes[14]' ]
:owner read never truncated: true
```

`src/tools-programs.js`:

3. **Stop asking for 446 KB.** `gcFetchProgram()` no longer expands option sets at
   all; the ONE option set that matters (gender) is fetched separately, and stage
   data elements come from a new bounded `gcFetchStageDataElements()`. Both use
   `noTruncate: true`.
4. **Refuse to judge an incomplete read.** `growthChartConfigure()` checks
   `_truncated` / missing `id` before looking at `programType`, and says so
   plainly ("this is a read problem, not a metadata problem — retrying will not
   help") instead of blaming the program.

## Root cause 2 — the wrong data elements were being chosen (silent)

Even with the fetch fixed, detection was first-match-wins on name:

```js
const height = gcMatch(des, dn, [/\bheight\b/i, /\blength\b/i, /\bstature\b/i]);
```

The stage listed its data elements in this order:

| # | data element | valueType |
|---|---|---|
| 1 | Height status | **TEXT** |
| 2 | Weight Status | **TEXT** |
| 4 | Height (cm) | NUMBER |
| 5 | Weight (Kg) | NUMBER |

So `height` resolved to the **TEXT** "Height status" and `weight` to "Weight Status".
The plugin's own validator (read out of `assets/Plugin-*.js` on the instance) only
checks that a configured UID belongs to the stage — it does not check the value
type. The config would have been written, accepted, and the chart would have
plotted **nothing**, with no error anywhere to explain why.

### Fix — `gcPickMeasurement()`

- The measurement **must be numeric** (`NUMBER`, `INTEGER`, `INTEGER_POSITIVE`,
  `INTEGER_ZERO_OR_POSITIVE`).
- Derived/annotation lookalikes are excluded outright: `status`, `classification`,
  `category`, `z-score`, `percentile`, `notes`, `type`, `target`, `gain`, `change`,
  `birth weight`, `-for-age`, `stunting`/`wasting`/`underweight`, …
- Remaining candidates are **ranked**, not first-match: pattern specificity →
  unit-carrying name (`Weight (Kg)` beats bare `Weight`) → shorter name → stage
  order. Deterministic.
- `headCircumference` never matches an unrelated circumference (MUAC, waist,
  chest, arm, hip).

## Other correctness and hygiene fixes in `manage_growth_chart_plugin`

| | |
|---|---|
| **`_apiPath` leaked into the stored config** | `safeDhis2Fetch` stamped `_apiPath`/`_pagerInfo` as enumerable properties on the parsed body. Read-modify-write tools carry that straight into the PUT body — it turned up verbatim inside the plugin's stored `captureGrowthChart/config`. Both are now **non-enumerable**: property access works everywhere, `JSON.stringify` and spread stop carrying them. `gcReadConfig()` additionally strips any `_`-prefixed key before merging. |
| **Two 404s and a 409 per run** | `gcReadConfig()` probed the key directly (404 when absent) and `gcWriteConfig()` always POSTed first (409 when the key exists). Both logged as *failed API calls* on runs where nothing was wrong. Existence is now probed via `GET /api/dataStore` (always 200), and the caller passes the known existence so the right verb is used first. |
| **Write not verified** | `configure` now reads the key back and confirms the stored program→stage mapping before reporting success. |
| **Silent wrong pick** | `configure` returns `resolved.named` — the actual **name** of every attribute and data element chosen. Since neither DHIS2 nor the plugin will ever complain about a plausible-but-wrong UID, relaying the names is the only way a user can catch it. |
| **Vague refusals** | A stage that isn't in the program now lists the stages that are; a `data_element_ids.*` override that isn't on the stage lists the numeric data elements that are; an unknown `female_option_code`/`male_option_code` lists the real option codes; a non-DATE date-of-birth attribute is named. |
| **Non-numeric override** | Accepted (the caller may know better) but returned in `_warnings`, because the chart would render empty. |

## The same failure class elsewhere — `get_program_info(stage_details)`

Stress-testing the new truncation path against the largest program on the test
instance (6 stages, 1352 stage data elements) turned up the identical shape of
bug in a much more commonly used call. `stage_details` with a `target_id`
returned the raw fetch, and its field list expands **every** data element's
option set. On 4 of those 6 stages that exceeded the budget, so the model — which
had asked precisely for the data elements — got back a stub with **none of them**
and a note telling it to "request narrower fields", which it cannot do: it does
not build that query.

New `fetchStageDetails()` narrows it here instead, and always returns the data
element list:

1. full detail; if truncated →
2. same, minus the option lists (usually the bulk), flagged `_options_omitted`
   with a pointer to `get_program_info(info_type="option_set", …)`; if still
   truncated →
3. a minimal projection fetched whole and summarised locally — every data
   element's id, name, valueType, compulsory flag and option-set id, capped at
   400 with an honest `total_data_elements` count.

Before / after on that program:

```
Drug Order                          DEs=  85  (was 0 — truncated away)
Drug Order (Most frequently)        DEs= 400 of 981   (was 0)
Patient medication history          DEs=  77
History (Test)                      DEs=  61  (was 0)
Specialized Clinics Drug Order (Te  DEs= 101  (was 0)
Specialized Clinics Drug Order      DEs=  47
26 API calls, 0 failed
```

## Manual (`KB_GROWTH_CHART_DETAILS`)

Added: the three measurements must be **valueType NUMBER** — when adding a missing
one with `add_data_elements_to_stage`, a TEXT "Head circumference" is accepted by
the plugin and plots nothing; and: relay `resolved.named` to the user.

## Verification

**Offline** — `npm run verify`, new "Growth-chart measurement detection" section:
height/weight skip the TEXT lookalikes, z-score / birth weight / weight gain are
never the weight, a unit-carrying name outranks a bare one, MUAC is not head
circumference, a non-numeric candidate is never chosen.

**Live** — `scripts/scenario-growth-chart.js`, which takes the program and stage as
arguments (no instance details are baked in):

```
DHIS2_BASE=… DHIS2_AUTH=… node scripts/scenario-growth-chart.js <programId> <stageId>
```

status → configure → the three measurements are the numeric ones (re-checked
against DHIS2, not just against the tool's own answer) → the stored config matches
the plugin schema → configure is idempotent → bad stage / bad data element are
refused precisely.

```
24 API call(s), 0 failed
All growth-chart checks passed with 0 failed API calls.
```

`scripts/scenario-line-lists.js` re-run to confirm the `safeDhis2Fetch` changes
did not regress the other tools: **110 API calls, 0 failed**.

## Result on the reported instance

`captureGrowthChart/config` is written and verified, mapping the program to its
examination stage with the numeric Weight (Kg), Height (cm) and Head Circumference
(cm) data elements, the DATE date-of-birth attribute, and the Sex attribute's real
`Male`/`Female` option codes — `weightInGrams: false`, `defaultIndicator: "wfa"`.

Still manual (by design — the tool does not write `dataStore/capture`): adding the
plugin widget to the enrollment dashboard via the Tracker Plugin Configurator app,
using the plugin source URL the tool returns in `dashboard_attach`.
