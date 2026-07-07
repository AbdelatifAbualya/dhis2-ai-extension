# Fresh-instance creation no longer hits the guard walls (v2.8.4)

## The report

On a brand-new DHIS2 instance with **zero metadata**, the user asked the
assistant to create an OU hierarchy (country→facility, all "Test"), a "Person"
tracked entity type, and three attributes (Full Name, DOB, Sex). It "hit the
wall" repeatedly and gave up half-done. The anti-hallucination rule (no API calls
for UIDs that never appeared in a verified source) must STAY — but a fresh
instance where the user explicitly wants to CREATE things must not be blocked.

The transcript shows the exact failure chain:

1. `dhis2_query trackedEntityTypes?fields=id,displayName` → **Refused:
   `displayName` is an unknown UID.** Same for `organisationUnitLevels?fields=…`.
2. `search_metadata organisationUnits` → one stray HTTP 400.
3. Bulk `POST metadata` for the OU hierarchy → HTTP 409.
4. `POST optionSets` with nested options → HTTP 409.
5. `POST options` → **STOP: 3 HTTP 4xx/5xx errors this turn. Further tool calls
   blocked.** — the assistant quit, even though it had already successfully
   created 4 OUs and the TET in between.

## Root causes (each verified against the live instance)

### 1. Field names mistaken for hallucinated UIDs

`DHIS_UID_RE = /\b[a-zA-Z][a-zA-Z0-9]{10}\b/` matches any 11-char alphanumeric
token. `displayName` and `lastUpdated` are exactly 11 chars and camelCase, so
they pass — and even the entropy-aware `isLikelyDhisUid()` accepts them (mixed
case). `extractUidsFromCallArgs()` scanned the **whole `path`**, including the
`fields=id,displayName` query list, so every discovery call that requested
`displayName` was refused with `unknown_uid_in_args`. On a fresh instance the
model *must* run discovery calls, so this was fatal.

### 2. The HTTP-error stop was cumulative, not consecutive

The comment says "3 **consecutive** 4xx errors," but the counter only reset at
turn start — it accumulated across the whole turn. A legitimate build on a fresh
instance interleaves recoverable 4xx/409s (wrong create order, name-collision
probes) with real successes; the cumulative count hit 3 mid-build and hard-
stopped even though 4 OUs + the TET had just been created successfully.

### 3. `manage_org_units` refused to create a root

`createOrgUnit()` hard-required `parent_id` ("Creating a NEW root is
intentionally not supported"). On an empty instance there is no parent to point
at, so the proper tool was unusable and the model fell back to raw `dhis2_query`
metadata POSTs — straight into the E5002 wall below.

### 4. (Diagnostic, informing the fix) how bulk create actually works

Verified live on the user's instance (2.42.5.1):
- Referencing a parent **by name** in a `/metadata` payload fails with
  `E5002 Invalid reference … for association 'parent'` — the importer resolves
  references by **UID or code**, never by name. The correct pattern is to
  **pre-generate UIDs** (`/api/system/id`) and link `parent:{id}`; a whole
  country→facility hierarchy then imports in **one** payload (created 4,
  ignored 0).
- An option set imports together with its options in **one** `/metadata`
  payload when both carry pre-generated UIDs and cross-reference each other
  (created 3, ignored 0). `manage_option_sets(action=create)` already does this
  correctly (owning-side write).
- `trackedEntityType` requires `shortName` on 2.42 (E4000 otherwise).

## The fixes (`background.js`)

1. **`extractUidsFromCallArgs()`** now scans only the path **before `?`** (the
   resource segments), never the query string, and filters every candidate
   through a new `RESERVED_UID_SHAPED_WORDS` denylist (displayName, lastUpdated,
   description, dataElement, …). Path-segment UIDs (`/programs/<uid>`) and
   explicit `*_id` arguments are still validated — the anti-hallucination guard
   is intact; only the field-name false positives are gone. A hallucinated UID
   inside a filter now self-corrects (empty result) instead of being a hard
   refusal, which is the safe trade.

2. **Consecutive HTTP-error counter.** On every successful tool call the loop
   now resets `dhis2.httpErrorCount`/`httpErrorHistory` to zero, so the hard-stop
   fires on **3 consecutive** failures (its documented intent), not 3 lifetime
   ones. The identical-call and same-error-family guards still bound genuine
   retry loops, so this does not reopen runaway-retry risk.

3. **Root org-unit creation on an empty instance.** `createOrgUnit()` now, when
   no `parent_id` is given, checks the live org-unit count: if it is **zero** the
   first (root) OU is created (no parent, level 1); if any OU already exists the
   old refusal stands (a second root would split the hierarchy) with a clearer
   hint. Tool description + KB updated to teach the fresh-instance top-down flow
   (create root with no parent, then pass each returned id as the next child's
   parent).

## Verification

- `node --check` passes.
- **UID extraction** unit cases: `…?fields=id,displayName…` → no UIDs;
  `programs/<uid>` and `organisationUnits/<uid>` → the real UID. All pass.
- **Counter** simulation of the exact transcript sequence: old cumulative logic
  blocks `options create` (as it did live); new consecutive logic reaches it.
- **Full scenario end-to-end on the live instance** (`localhost:8081`, 2.42.5.1):
  root country with NO parent + 3 descendants (1 payload), Person TET, Sex option
  set + Male/Female, and Full Name/DOB/Sex attributes — all created, `ignored:0`.
  Then every object deleted; the instance was returned to **completely empty**
  (0 OUs / levels / TETs / attributes / option sets / options) so the user can
  re-run the assistant from a clean slate. The stale objects the previous
  assistant run left behind (4 "Test" OUs + "Person" TET) were also removed.

## Files changed

- `background.js` — `RESERVED_UID_SHAPED_WORDS` + rewritten
  `extractUidsFromCallArgs`; consecutive HTTP-error reset in the dispatch loop;
  `createOrgUnit` root-on-empty logic; `manage_org_units` description + KB.
- `manifest.json` — version `2.8.3` → `2.8.4`.
