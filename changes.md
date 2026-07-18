# Changes

This file documents the changes made on the `enhance-performance` branch to improve the
performance and capability of the DHIS2 AI Assistant extension. Each entry records what was
changed, in which file, at which line(s), and what the change does.

---

## 1. Increase the agentic iteration limit from 12 to 30

**File:** `background.js`
**Line:** 17229
**Function:** `_runAgenticLoopInner` (the main agentic loop)

**Type of change:** Modified (1 line)

**Before:**
```js
for (let i = 0; i < 12; i++) {
```

**After:**
```js
for (let i = 0; i < 30; i++) {
```

**What it does:**
The agentic loop is the core reasoning loop where the model alternates between thinking,
calling tools, and reading tool results. Each pass through this `for` loop is one "agentic
iteration." When the counter reaches the upper bound, the loop stops and the assistant returns
the message *"Reached maximum iterations. Try a more specific question."* (see `background.js:17533`).

Previously the loop was capped at **12** iterations, which was being hit on more complex,
multi-step requests (e.g. metadata builds, multi-tool data investigations) before the model
could finish. This change raises the cap to **30** iterations, giving the model more room to
complete longer multi-step tasks before hitting the limit.

**Scope of impact:** Only the maximum number of allowed iterations changes. No tool, prompt,
or response-handling logic was altered. The user-facing "Reached maximum iterations" fallback
message at `background.js:17533` is unchanged and still triggers if the new, higher limit is
reached.

**Verification:** `node --check background.js` passes (syntax valid).

---

## 2. Fix confusing CORS error when switching between DHIS2 instances on the same host

**File:** `background.js`
**Function:** `initializeFromUrl` (the connection probe), around line 2696
**Type of change:** Modified (net +15 / −3 lines, one file; no panel/HTML/CSS changes)

### The issue

Chrome host permissions are granted **per host**, but a DHIS2 login session (cookie) is
scoped **per instance (path)**. On the DHIS2 playground every instance lives on the same host
(e.g. `https://play.im.dhis2.org/stable-2-41-…`, `…/stable-2-42-4-1/…`), so:

1. After you click **Allow** on the first instance, the granted pattern is host-wide
   (`https://play.im.dhis2.org/*`, built at `panel.js:184` and checked at `background.js:2671`).
   Switching to a *second* instance on the same host therefore shows **no permission prompt** —
   it is already covered.
2. But you are **not logged in** to that second instance. The connection probe
   `fetch('…/api/system/info', { credentials: 'include' })` has no valid session for it, so
   DHIS2 responds with a **302 redirect to its login page**
   (`…/stable-2-42-4-1/dhis-web-login/`).
3. `fetch` automatically **followed** that redirect, and the browser logged a **CORS error**
   (`No 'Access-Control-Allow-Origin' header`) for the redirected login-page response — which
   looks like an extension bug, when the real cause is simply "not signed in to this instance."

**Observed symptom:** the *only* visible sign of the problem was that CORS error in the
**extension's background / service-worker console** (`chrome://extensions` → "service worker" /
DevTools). The side panel itself did **not** show an error and did **not** say "Could not
connect" — it kept displaying the previously-connected instance's state (the panel retains its
in-memory state on a same-host tab-switch). So in practice the failure was silent in the panel UI
and visible only in the logs. That stray CORS error is exactly what a reviewer testing on the
playground would notice, which is why it was worth removing.

### The fix

Add `redirect: 'manual'` to the `/api/system/info` probe so the login bounce is **detected
instead of followed**:

- With `redirect: 'manual'`, a 302-to-login surfaces as an **opaque redirect**
  (`resp.type === 'opaqueredirect'` / `resp.status === 0`), so the redirect is **no longer
  followed into the login page and the CORS error is no longer produced**. The probe simply
  treats the instance as not-connected and bails out cleanly.
- The primary, verified outcome of this change is that **the CORS error is resolved**: switching
  to another instance on the same host no longer floods the console with a misleading
  `No 'Access-Control-Allow-Origin' header` error.

**Note on the returned error string:** the probe returns
`{ error: 'Not signed in to this DHIS2 instance…' }` for this case. That string is only surfaced
in the panel's status bar when the **panel itself** initiates the connection (panel open / the
"Allow access" flow) via `INITIALIZE → sendResponse → setStatus('disconnected', resp.error)`
(`background.js:17737`, `panel.js:203-204`). When you switch instances while the panel is
**already open**, reconnection is driven by the background auto-init listeners
(`onActivated`/`syncFromTab`, `onUpdated`, `webNavigation`), which intentionally discard the
returned value — so **no login message is shown on a live tab-switch**. This is acceptable: the
goal of this change was to eliminate the confusing CORS error, which it does.

**Before:**
```js
dhis2.baseUrl = baseUrl;
const info = await fetch(`${baseUrl}/api/system/info`, {
  credentials: 'include',
  headers: { Accept: 'application/json' }
}).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
dhis2.apiVersion = info.version.split('.')[1];
```

**After:**
```js
dhis2.baseUrl = baseUrl;
// `redirect: 'manual'` so a "not logged in" 302 to the login page surfaces as an
// opaque redirect instead of being followed into a noisy CORS error. Common on the
// DHIS2 playground: every instance shares one host (so the host permission, granted
// once, already covers them all) but each instance needs its own login.
const resp = await fetch(`${baseUrl}/api/system/info`, {
  credentials: 'include',
  headers: { Accept: 'application/json' },
  redirect: 'manual',
});
if (resp.type === 'opaqueredirect' || resp.status === 0) {
  dhis2.baseUrl = null;
  dhis2.connected = false;
  return { error: 'Not signed in to this DHIS2 instance. Log in to this server in the tab, then reopen the panel.' };
}
if (!resp.ok) throw new Error(resp.status);
const info = await resp.json();
dhis2.apiVersion = info.version.split('.')[1];
```

**Scope of impact:** Only the connection probe in `initializeFromUrl` changes. The permission
flow, tool logic, and all other fetches are untouched. The existing generic
`catch → 'Could not connect to DHIS2'` fallback is preserved for genuine network failures.

**Verification:** `node --check background.js` passes (syntax valid).

---

## 3. Increase the agentic iteration limit from 30 to 50

**File:** `background.js`
**Function:** the main agentic loop (`for (let i = 0; i < N; i++)`)
**Type of change:** Modified (1 line)

**Before:**
```js
for (let i = 0; i < 30; i++) {
```

**After:**
```js
for (let i = 0; i < 50; i++) {
```

**What it does:**
Raises the per-turn cap on agentic iterations from **30** to **50**. Each pass through this loop
is one think→tool-call→read-result cycle. Multi-step authoring flows (e.g. "build a dataset,
attach data elements, then design a custom form for it") can chain many tool calls in a single
turn; 30 was occasionally hit before such a flow finished. No tool, prompt, or response-handling
logic changed — only the upper bound. The "Reached maximum iterations" fallback still triggers if
the new, higher limit is reached.

Docs updated to match: `README.md` ("up to 50 iterations per turn", "Hard caps: 50 iterations per
turn").

**Verification:** `node --check background.js` passes (syntax valid).

---

## 4. New tool — `manage_custom_forms` (custom HTML data-entry forms for datasets AND tracker program stages)

**Files:** `background.js` (tool definition, `TOOL_ROUTER`, `executeTool` dispatch, handler block,
`getContextualTools`, `buildSystemPrompt` KB block), `sidepanel/panel.js` (icon, label, tool-card
detail), `README.md` (tool table + quirks). This brings the tool count from **22 → 23**.

**Type of change:** Added (new tool, ~430 new lines in `background.js`; small wiring edits elsewhere).

### What it does
Adds a dedicated tool to author **CUSTOM (HTML) data-entry forms** for two targets:

- **dataSets** — the form renders in the new Aggregate Data Entry app.
- **tracker/event program STAGES** — the form renders in the new Capture app.

Actions: `get` (inspect current form), `preview_html` (auto-generate a clean table-based form
skeleton from the target's data elements and return it **without saving**), `set_dataset_form`,
`set_stage_form` (create/replace the form and flip `formType` to `CUSTOM`; pass your own
`html_code` or let the tool auto-generate one), and `remove_form` (revert to DEFAULT/SECTION).
The tool reuses the existing write-auth gate, `verifyTargetExists` 404 guard, and auto-backup
(`ensureBackupOrBail`) before every write.

### Why it was built this way — verified live on DHIS2 2.43 (play `stable-2-43-0-1`)
The behaviour was confirmed end-to-end against a live 2.43 instance before writing the tool:
created a custom dataset form, confirmed it renders in Aggregate Data Entry and that an entered
value (42) persisted; created a custom program-stage form, confirmed it renders in Capture. The
following DHIS2 quirks were discovered and are now encoded so the model never re-derives them:

1. **A `dataEntryForm` cannot be created inline.** Embedding `{name, htmlCode}` in a
   dataSet/programStage payload — via the `/api/metadata` importer **or** a direct object PUT —
   fails with **E5002 "Invalid reference … (DataEntryForm)"**. The tool always `POST`s the form
   standalone to `/api/dataEntryForms` first, then references it by id.
2. **Input-id binding differs per target** (the apps bind native widgets to these ids and render
   the rest of the HTML verbatim):
   - dataset cell: `<input id="<dataElementUID>-<categoryOptionComboUID>-val" …>`
   - stage cell:   `<input id="<programStageUID>-<dataElementUID>-val" …>`
3. **Linking to a program stage drops the `program` reference** on a PATCH or naive PUT ("Program
   stage must reference a program"), because `GET ?fields=:owner` omits `program`. The tool does a
   full PUT that **re-attaches `program:{id}`** explicitly. (Datasets link cleanly via PATCH.)
4. A dataset custom form only accepts data entry when sharing is `rwrw----` and an org unit is
   assigned — the tool surfaces these as `_hints` (the fix stays with `manage_datasets`).

### Wiring
- `getContextualTools()` surfaces `manage_custom_forms` on dataset/tracker contexts and on custom-
  form intent ("custom form", "design a data entry form", "html form", …); it is stripped in
  read-only save-diagnosis mode and counted as write-capable (so `manage_backups` rides along).
- `buildSystemPrompt()` adds a concise "Custom (HTML) Forms" KB block when relevant.
- `panel.js` adds the 📝 icon, "Designing custom form" label, and a tool-card detail line.

**Verification:** `node --check background.js`, `node --check sidepanel/panel.js` both pass.
Underlying API sequence verified live on 2.43 (form renders + saves in both Aggregate Data Entry
and Capture); test metadata cleaned up afterward.

---

## 5. Fix — option-set creation 409 on duplicate auto-generated codes ("A+"/"A-" → "A_")

**File:** `background.js`
**Functions:** new `deriveOptionCode()` helper; `buildOptionSetAndOptions()`; the category-option
builder inside the category-combo flow.
**Type of change:** Bug fix (root cause of a 409 loop), net +~45 lines.

### Reported symptom
Creating a tracker program ("ANC Clinical & Lab Registry") with a Blood Group option set
(`A+, A-, B+, B-, AB+, AB-, O+, O-`) failed and the chatbot then looped through several more
failing calls:

```
create_program → 409 duplicate key … "optionvalue_unique_optionsetid_and_code" (optionsetid, code)=(…, A_)
create_option_set → same 409 on a NEW optionsetid
POST optionSets (raw) → 409
options?filter=… → STOP: 3 HTTP 4xx errors, tool calls blocked
```

### Root cause
Option codes were auto-generated with
`name.toUpperCase().replace(/[^A-Z0-9]/g,'_')` and **no uniqueness guarantee**. Any two option
names that differ only by a non-alphanumeric symbol collapse to the **same code**: `A+` and `A-`
both become `A_` (likewise `1+`/`1-`, `B+`/`B-`, …). DHIS2 enforces a per-option-set unique code
via the Postgres constraint `optionvalue_unique_optionsetid_and_code`, so the two same-coded
options collide and the import **fails with a 409 at COMMIT**.

Two compounding factors explained the loop:
- The `/api/metadata?importMode=VALIDATE` pass **cannot** catch this — it is a database unique
  constraint, not a metadata-import rule, so it only surfaces at COMMIT (INSERT) time.
- After the 409 the model **misdiagnosed** the cause ("orphaned objects may remain" — there were
  none; `atomicMode=ALL` had rolled the import back cleanly) and retried with the **same** buggy
  code generation, producing `A_` twice again, until the existing 3-error circuit-breaker stopped it.

### Fix
New `deriveOptionCode(rawName, usedCodes, explicitCode)` generates collision-free codes **by
construction**:
1. Maps a trailing `+`/`-` sign to a readable `_POS`/`_NEG` token, so the common blood-group /
   lab-result / urine-protein cases stay meaningful **and** distinct (`A+`→`A_POS`, `A-`→`A_NEG`,
   `1+`→`1_POS`).
2. Sanitizes the rest to `[A-Z0-9_]`.
3. Guarantees uniqueness against codes already minted in the same scope by appending `_2`, `_3`, …
   (so even pathological sets like `N/A, N.A., N-A, N+A` → `N_A, N_A_2, N_A_3, N_A_4`).

Applied at both option-creation chokepoints: `buildOptionSetAndOptions()` (per option set) and the
category-option builder in the category-combo flow (per bundle). `buildOptionSetAndOptions` also
now tolerates `{name, code}` option entries, not just strings.

### Verification (live, DHIS2 2.43 `stable-2-43-0-1`)
Reproduced the exact failing program as one atomic `/api/metadata` POST (5 option sets incl. Blood
Group, 24 options, 4 TEAs, 11 data elements, 2 stages, 1 program assigned to all 1332 org units
with production sharing):

```
VALIDATE → status OK, 47 created, 0 errors
COMMIT   → status OK, 47 created, 0 errors
Blood Group codes → A_POS, A_NEG, B_POS, B_NEG, AB_POS, AB_NEG, O_POS, O_NEG  (all unique)
```

Previously this same operation 409'd on the duplicate `A_` code. Unit-checked `deriveOptionCode`
against all the prompt's option sets (+ a deliberate all-collide set) — every code unique. Test
metadata deleted afterward. `node --check background.js` passes.

---

## 6. Dev process — add the "DHIS2 chatbot performance enhancement" skill

**File:** `.claude/skills/dhis2-chatbot-performance-enhancement/SKILL.md` (developer tooling;
NOT part of the shipped extension — the publish workflow excludes `.claude/`).
**Type of change:** Added.

A project skill that encodes the rules for working on this extension so they apply every time:
the chatbot must work perfectly after every change (zero-error API calls); a new tool/ability
must never regress another tool — cross-tool interactions may only make the other tools better;
and every change must be tested against the DHIS2 playground first so the tool logic mirrors a
sequence proven to succeed. Also captures the playground testing protocol (instances, VALIDATE
vs DB constraints, pre-generating UIDs for cross-referencing bundles, cleanup), the tool-wiring
map, and a definition-of-done checklist. Pairs with the `document-extension-changes` memory.

---

## 7. New tool — `manage_custom_translations` (DHIS2 2.43 custom-translations feature)

**Files:** `background.js` (tool definition, `TOOL_ROUTER`, `getContextualTools`, dispatch in
`callTool`, implementation `executeManageCustomTranslations` + helpers, system-prompt KB),
`sidepanel/panel.js` (icon, status label, args-detail renderer), `README.md`.
**Type of change:** Added.
**Tool count:** 23 → **24**.

Adds a tool that translates or re-labels any DHIS2 app's UI strings using the experimental
**DHIS2 2.43+** `custom-translations` dataStore namespace — no app source changes. Actions:
`list`, `get`, `set`, `remove`. `set`/`remove` keep the `controller` registry
(`{ "<slug>": ["<locale>"] }`) and the per-app key (`<slug>__<locale>` → a
`{ "<source string>": "<replacement>" }` map) in sync in one call. Supports both true
translation (different locale) and same-language re-labelling (locale `en`). Version-gated to
2.43+ (`customTranslationsVersionGate`); `requireWriteAuth` gates `set`/`remove`; merges by
default with `replace:true` to overwrite. DataStore keys aren't covered by `manage_backups`
(metadata-only restore), so `set`/`remove` return `previous_value` / `previous_controller`
inline for manual rollback.

**Playground verification (play `stable-2-43-0-1`, version 2.43.0.1):**
- Created `custom-translations/controller = { "capture": ["ar"] }` and `capture__ar` via the
  dataStore API → both `201 Created`.
- Set the user UI locale to `ar` and loaded the Capture app. Network capture showed the app
  itself fetching **`GET /api/dataStore/custom-translations/controller`** and
  **`GET /api/dataStore/custom-translations/capture__ar`** — both `200`. This confirms the
  namespace, the `controller` registry, and the `<slug>__<locale>` (double-underscore, lowercased
  slug) key format that the tool writes. The key template `${slug}__${locale}` was also confirmed
  in the Capture bundle (`main-CiArLA10.js`).
- The Capture app renders the translated strings in the live app (confirmed by the user in the
  open tab). Automated screenshots earlier missed the swap because they were taken against a
  PWA-cached / mid-reload state; clearing the service-worker cache mid-test also briefly broke the
  instance's `/apps/*` routing (self-heals on instance reset). Neither affected the tool.

`node --check background.js` and `node --check sidepanel/panel.js` both pass.

---

## 8. New tool — `manage_growth_chart_plugin` (WHO Capture Growth Chart setup)

**Files:** `background.js` (tool definition, `TOOL_ROUTER`, `getContextualTools` intent +
selection, dispatch in `callTool`, implementation `executeManageGrowthChartPlugin` + helpers,
system-prompt KB), `sidepanel/panel.js` (icon 📈, status label, args-detail renderer),
`README.md`, `manifest.json` (2.3.0 → **2.4.0**).
**Type of change:** Added.
**Tool count:** 24 → **25**.

Adds a tool that sets up the WHO Capture Growth Chart plugin
([dev-otta/dhis2-who-growth-chart](https://github.com/dev-otta/dhis2-who-growth-chart),
App Hub key `capture-growth-chart`) end to end. Actions:
- `status` — installed? config present? which programs configured.
- `install` — install from the App Hub (`POST /api/appHub/{versionId}`, latest server-compatible
  version), idempotent.
- `scaffold_program` — create a ready-to-use growth-monitoring tracker program (Person TET,
  First/Last name + Gender[Male/Female option set] + Date of birth attributes, repeatable stage
  with Weight/Height/Head-circumference DEs) assigned to a given org unit.
- `configure` — resolve the program's metadata (auto-detect DOB + gender attributes, female/male
  option codes, weight/height/head-circumference DEs; explicit overrides supported) and write/merge
  `dataStore/captureGrowthChart/config`. Validates the plugin's hard requirements and refuses with a
  precise missing-items list. Infers `weightInGrams` from the weight DE name. Merges so multiple
  programs coexist.
- `remove` — drop a program from the config, or delete the whole key (`confirm_delete_all:true`).

`install`/`scaffold_program`/`configure`/`remove` are gated by `requireWriteAuth`. The tool does
**not** write the Capture-owned `dataStore/capture` enrollment-dashboard layout (cache-corruption
risk + internal/undocumented schema); instead `configure` returns a `dashboard_attach` block with
the exact plugin source URL and the steps to add the widget via the Tracker Plugin Configurator.

**Playground verification (play `stable-2-43-0-1`, DHIS2 2.43.0.1):**
- Read the plugin docs (dev-otta `docs/using-capture-growth-charts.md`) for the namespace/key/schema.
- Plugin was **not** installed → installed it from the App Hub
  (`POST /api/appHub/742e72b1-…` v1.2.0) → `201`; `/api/apps` then lists `capture-growth-chart`
  with `pluginLaunchUrl …/api/apps/capture-growth-chart/plugin.html`.
- No clean target program existed (Child Programme lacks a DOB attribute + height/head-circ DEs), so
  created a dedicated tracker program **Growth Monitoring (Plugin Test)** (`bCdtzjLanGm`) with stage
  `yb00SY11bGc` and 3 NUMBER DEs, reusing the demo First/Last/Gender/Date-of-birth attributes
  (one `/api/metadata` import; fixed the data-sharing-on-DataElement E-string by using `rw------`
  for DEs and `rwrw----` for program/stage).
- Wrote `dataStore/captureGrowthChart/config` (`201`) and read it back intact.
- Enrolled a test child (`n8CBRSd3GyP`) with 3 growth measurements (`/api/tracker`, 5 objects, 0 errors).
- Validated the tool's **exact** call paths under the versioned `/api/43/` prefix that
  `safeDhis2Fetch` builds (`apps.json`, `appHub/v2/apps`, `categoryCombos?filter=isDefault`,
  `programs/{id}`) and confirmed the auto-detection heuristics resolve the right IDs on the test
  program (dob=`iESIqZ0R0R0`, gender=`cejWyOfXge6` + Female/Male codes, weight/height/head DEs).
- Not visually confirmed: the chart pixels on the enrollment dashboard, because that needs the
  widget placed on the dashboard (the manual/configurator step the tool guides) and the Capture UI
  was unavailable in the automated session. The functional contract is verified end to end.

`node --check background.js` and `node --check sidepanel/panel.js` both pass.

---

## 9. Fix three issues from the "Child and Adolescent Growth" program report (memory loss, value-type default, program-rule misdiagnosis)

A user created a tracker program ("Child and Adolescent Growth", program `eyloSZ4Gkef` on
`play.im.dhis2.org/stable-2-42-5-1`) and reported three problems: (1) numeric data elements were
allegedly created as TEXT, (2) the auto-age program rule "failed" and the assistant could not fix
it, and (3) the assistant has no memory of what it *did* (API calls, created IDs) across turns of
the same thread — only of the user's prompts.

### Ground-truth investigation (live, against the user's actual instance `stable-2-42-5-1`)

I queried the actual created metadata via the API (admin/district):
- **Data element value types were already correct:** Head circumference `NUMBER`, Height in cm
  `NUMBER`, Weight in kg `INTEGER_POSITIVE`, Age in months `INTEGER`; DOB attribute `DATE`. So #1
  did **not** manifest in this run — but the builder's silent `|| 'TEXT'` fallback is a real latent
  trap whenever the model omits `value_type`, so it is worth hardening.
- **The program rule was syntactically correct:** condition `d2:hasValue(A{dob})`, action
  `ASSIGN d2:monthsBetween(A{dob}, V{current_date}) → "Age in months"`, with a `dob` PRV of
  sourceType `TEI_ATTRIBUTE` mapped to the DOB attribute and an `age_in_months` DE PRV. The
  assistant's proposed "fix" (rewrite `A{dob}` → `#{dob}`) was a **misdiagnosis** — `A{tea}` is the
  canonical reference for an attribute-sourced rule variable. Confirmed by the demo DB's own working
  rules: WHO RMNCH uses `d2:yearsBetween(A{born}, V{current_date})` and Malaria uses
  `A{Sex} == 'MALE'` / `d2:yearsBetween(A{dateofbirth}, V{current_date})`. Importing a test TEI
  with a DOB through `/api/tracker` succeeded with 0 errors (then deleted); server-side import does
  not apply ASSIGN side-effects (that is a Capture/runtime behaviour), so emptiness there is not
  evidence the rule is broken.
- **The memory loss (#3) is a real code bug** (see fix below).

### Fix 3 (primary) — persist the full action trail across turns

**File:** `background.js`
**Functions/areas:** new helpers `truncateToolContentForHistory`, `trimConversationHistory`,
`buildTurnHistory` (near `saveState`); the agentic loop's turn-finalization blocks; `saveState`.

**Before:** after the agentic loop finished a turn, only two messages were appended to
`conversationHistory`: `{role:'user', content: historyText}` and `{role:'assistant', content:
finalText}`. Every assistant `tool_calls` message and every `role:'tool'` result produced during
the loop was discarded. On the next turn the model saw only the user's prompts and its own prose
summaries — it had amnesia about the API calls it made and the IDs it created. Trimming was a blunt
`slice(-16)`.

**After:** at turn end we persist the *whole structured turn* via `buildTurnHistory(messages,
turnStartIdx, historyText)` — the user message plus every assistant `tool_calls` message and every
`tool` result the loop produced (the final assistant text is already in `messages`). `turnStartIdx
= 1 + conversationHistory.length` marks where this turn's messages begin. Transient mid-loop
`system` nudges/reminders are dropped; empty assistant turns are skipped; oversized tool results are
clipped to 1800 chars (`truncateToolContentForHistory`) so history stays bounded. Trimming is now
`trimConversationHistory` which only ever cuts on a `user` turn boundary, so an
assistant-`tool_calls` message is never separated from its `tool` results (which every provider
rejects). `HISTORY_MAX_MESSAGES = 60`. `saveState` persists the trimmed history (was `slice(-20)`,
which could orphan a tool message on reload).

**Why this is safe for all providers:** the `messages` array is already provider-valid on every
loop iteration; we persist a subset of it (only dropping standalone `system` messages) and only cut
on user boundaries, so tool-call/result pairing is preserved by construction. Verified with a
simulation: persisted turns keep `user → assistant[tool_calls] → tool → assistant`, system messages
are dropped, the compact user text is stored (not the full inspect-log-laden content), trimming
keeps a user boundary, and every `tool` message stays paired with its assistant.

**Memory clears correctly on a new thread:** `CLEAR_HISTORY` still resets `conversationHistory = []`
(triggered by panel.js line 281), so within-thread memory now persists and a new thread starts clean
— exactly the requested behaviour.

### Fix 1 — value-type inference safety net (no more silent TEXT for numeric fields)

**File:** `background.js`
**Functions:** new `inferValueType(name, fallback)`; `buildDataElement` (DE valueType line);
the inline TEA builder in `createFullProgram`.

**Before:** `valueType: de.value_type || 'TEXT'` and `valueType: attr.value_type || 'TEXT'` — an
omitted `value_type` silently became TEXT.

**After:** `value_type: de.value_type || (de.option_set ? 'TEXT' : inferValueType(de.name, 'TEXT'))`
(same for TEAs). An explicit `value_type` always wins; option-set fields stay TEXT; otherwise the
name is inspected with conservative, high-confidence cues: DOB/"date" → `DATE`; "age"/"number of"/
counts/doses → `INTEGER`; height/weight/circumference/temperature/BMI/vitals and unit suffixes like
`(cm)`/`(kg)`/`(mm)`/`(g)`/`in cm`/`in kg` → `NUMBER`; "percent"/`(%)` → `PERCENTAGE`; else the
fallback. Unit-tested against 16 names (incl. all four from this program) — 16/16 correct, no false
positives on Name/Sex/Comments/Diagnosis. VALIDATE-imported NUMBER/INTEGER/PERCENTAGE DEs on 2.43
(`importMode=VALIDATE`, status OK, 0 errors).

### Fix 2 — program-rule guidance (stop the A{}→#{} misdiagnosis; diagnose from real metadata)

**File:** `background.js` — `buildSystemPrompt()` "Program Rule syntax" block.

Added two guidance bullets: (a) `A{attr_name}` IS the correct, canonical way to reference a
TEA-sourced program rule variable in conditions and ASSIGN/expression `data`, matching DHIS2's own
demo rules; never "fix" a working `A{tea}` into `#{tea}` (that is a regression and is never the
cause of a rule not firing). (b) When a user says an auto-assign/calc rule "isn't working", diagnose
from the real metadata (`manage_program_rules action=get` + `list_variables`) before claiming a
cause; if the expression matches a known-good pattern, say it is correct; the real reasons an ASSIGN
value looks missing are runtime/UX (value appears on opening the stage event once the source has a
value; field is read-only by design; target DE valueType can't hold the result) — do not invent
"the reference doesn't resolve at runtime" without evidence. Fix 3 reinforces this: the model will
now actually remember the rule + PRV mapping it built earlier in the thread.

**Scope of impact:** Fix 3 changes only how a completed turn is persisted/trimmed (no change to
tool execution or to what the model receives mid-turn). Fix 1 only changes the *default* valueType
when `value_type` is omitted and no option set is attached — explicit types and option-set fields
are untouched. Fix 2 is prompt-only. No existing tool is regressed.

**Verification:** `node --check background.js` and `node --check sidepanel/panel.js` pass;
`inferValueType` unit test 16/16; memory persistence/trim simulation confirms provider-valid
pairing; value types VALIDATE-import cleanly on 2.43; live diagnosis run against the user's
`stable-2-42-5-1` instance (test TEI created and deleted, no residue left behind).

---

## 10. New tool — `manage_validation_rules` (DHIS2 aggregate data-quality validation rules)

**File:** `background.js` (tool def, `TOOL_ROUTER`, `executeTool` dispatch, `executeManageValidationRules` +
`createValidationRule` + `describeValidationExpression` handlers, `getContextualTools`, `buildSystemPrompt`);
`sidepanel/panel.js` (iconMap / toolLabels / detail).

**What was missing:** The chatbot could create datasets, data elements, custom forms, program rules and
program indicators, but had **no** first-class way to author DHIS2 **validation rules** — the aggregate
data-quality checks that compare two expressions (`leftSide` vs `rightSide`) with an operator over a period
(e.g. "inpatient days ≤ available bed-days", "ANC 4th visits ≤ ANC 1st visits", "sub-totals == grand total").
Previously the only path was hand-assembling `/api/metadata` payloads via `dhis2_query`, with no expression
validation and no safety rails.

**New capability — `manage_validation_rules`** with actions `list / get / create / update / delete`:
- **create** server-validates BOTH expressions via DHIS2's `/api/expressions/description` endpoint BEFORE
  saving (a bad data-element UID or malformed `#{...}` syntax is rejected at create-time with the parser's
  exact error, never silently saved), then imports through the shared `postMetadataPayload`
  VALIDATE-then-COMMIT path. Side descriptions auto-derive from the validator when omitted. Supports
  `dry_run_only`.
- **update** validates field values + any new expressions first, then auto-snapshots a backup
  (`ensureBackupOrBail`, restorable via `manage_backups`) before the PUT.
- **delete** runs the existing reference check + auto-backup, then deletes via
  `metadata?importStrategy=DELETE&atomicMode=ALL` and confirms `deleted >= 1`.
- **list/get** are read-only summaries with both expressions, operator, importance, period and missing-value
  strategies.

Validated inputs: `operator` (8 DHIS2 operators incl. `compulsory_pair`/`exclusive_pair`), `importance`
(HIGH/MEDIUM/LOW), `period_type` (reuses the dataset `VALID_PERIOD_TYPES` set), and per-side
`missingValueStrategy` (NEVER_SKIP / SKIP_IF_ANY_VALUE_MISSING / SKIP_IF_ALL_VALUES_MISSING).

**Wiring (every layer):** `TOOLS` array → `TOOL_ROUTER` → `executeTool` dispatch → handler →
`getContextualTools` (surfaced **only** on an explicit, conservative `wantsValidationRuleIntent`, plus
`search_metadata` for resolving DE UIDs; added to `writeCapableNames` so `manage_backups` is offered after a
write; added to the save-error-diagnosis read-only strip list) → `buildSystemPrompt` (a Validation-Rules KB
block gated on the matching `wantsValidationRulePrompt`) → `panel.js` iconMap (`✅`), toolLabels and a
`detail` renderer.

**No-regression analysis:**
- Purely **additive**. The tool is surfaced ONLY on explicit validation-rule intent, so it adds nothing to —
  and cannot crowd or mis-route — any existing dataset / tracker / maintenance flow. The intent regex is
  conservative (bare "validate" only triggers alongside a validation-specific noun such as "left side",
  "compulsory pair", "greater than", or "dataset").
- Touches **no shared code's behavior**: it only *calls* `safeDhis2Fetch`, `requireWriteAuth`,
  `verifyTargetExists`, `ensureBackupOrBail`, `checkMetadataReferences`, `buildDeletionHint`,
  `postMetadataPayload` and `generateDhis2Uid` with their existing signatures — no edits to any of them. New
  module-level identifiers (`VALIDATION_OPERATORS/IMPORTANCE/MISSING_STRATEGY`, the three new functions) were
  confirmed collision-free. `checkMetadataReferences('validationRules', …)` is an unmapped type → returns
  `has_references:false`, after which DHIS2's atomic DELETE reports any genuine blocking reference (identical
  to how `manage_metadata` delete handles non-special types).
- `panel.js` changes are additive (`iconMap`/`toolLabels` lookups fall back by default; the new `else if`
  branch precedes `manage_backups`), so every existing tool still renders.

**Verification (DHIS2 2.43 playground, `stable-2-43-0-1`):** `/api/expressions/description` confirmed as the
authoritative validator (valid → status OK + description; bad UID / malformed → status ERROR). Two full
create→read-back→delete cycles run with pre-generated UIDs (VALIDATE then COMMIT, ZERO errors), including a
mixed missing-value-strategy rule with auto-derived side descriptions; read-back matched the payload exactly;
all test objects (validation rule + 2 supporting data elements) deleted and verified gone (404). `node --check
background.js` and `node --check sidepanel/panel.js` both pass.

---

## 11. New tool — `manage_org_units` (DHIS2 organisation-unit hierarchy CRUD)

**File:** `background.js` (tool def, `TOOL_ROUTER`, `executeTool` dispatch, `executeManageOrgUnits` +
`createOrgUnit` handlers, `normalizeOuDate` / `isValidOuDate` helpers, `getContextualTools`,
`buildSystemPrompt` KB); `sidepanel/panel.js` (iconMap / toolLabels / detail).

**What was missing:** The chatbot could read org units (they show up as context and in analytics) but had
**no** first-class way to author the **org-unit hierarchy** itself — the tree of facilities / chiefdoms /
districts that every program, dataset, data value and enrollment hangs off. The only path was hand-assembling
`/api/metadata` POST/PUT bodies via `dhis2_query`, with no parent verification, no cycle guard on a move, no
children check before a delete, and no auto-backup.

**New capability — `manage_org_units`** with actions `list / get / create / update / delete`:
- **create** requires `name`, `parent_id`, `opening_date`; it **verifies the parent exists** first (clear 404
  message + reports the *derived* level), generates the UID, and imports through the shared
  `postMetadataPayload` VALIDATE-then-COMMIT path (which also catches a parent reference that vanishes between
  the probe and the import, E5002). `level`/`path` are left for DHIS2 to derive from the parent — the tool
  never sets them. Supports `dry_run_only`. Creating a new **root** is intentionally unsupported (it would
  split the hierarchy).
- **update** patches any field and supports a safe **move (re-parent)**: it validates the new parent exists,
  rejects setting a unit as its own parent, and **rejects a move under the unit's own descendant** (cycle
  guard via a `path` check) — all *before* it auto-snapshots a backup (`ensureBackupOrBail`, restorable via
  `manage_backups`) and PUTs the `:owner` object. DHIS2 then re-computes level/path for the unit and every
  descendant.
- **delete** refuses any unit that still has **children** (precise message + how to re-parent/clear them),
  runs the existing reference check + auto-backup, deletes via `metadata?importStrategy=DELETE&atomicMode=ALL`,
  and on a `deleted:0` result **surfaces DHIS2's exact blocking reason** (e.g. E4030 "associated with another
  object", or captured data values / program-dataset assignment) instead of a generic message.
- **list/get** are read-only summaries (parent, level, path, child count, opening/closed dates, contact info).

Dates accept `YYYY-MM-DD` (normalized to the full ISO form DHIS2 stores) or a full timestamp; an invalid date
is rejected up-front.

**Wiring (every layer):** `TOOLS` array → `TOOL_ROUTER` → `executeTool` dispatch → handler →
`getContextualTools` (surfaced **only** on an explicit, conservative `wantsOrgUnitIntent`, plus
`search_metadata` for resolving parent UIDs; added to `writeCapableNames` so `manage_backups` is offered after
a write; added to the save-error-diagnosis read-only strip list) → `buildSystemPrompt` (an Org-Unit KB block
gated on the matching `wantsOrgUnitPrompt`) → `panel.js` iconMap (`🏢`), toolLabels and a `detail` renderer.

**No-regression analysis:**
- Purely **additive**. The tool is surfaced ONLY on explicit org-unit intent, so it adds nothing to — and
  cannot crowd or mis-route — any existing analytics / dataset / tracker flow. The intent regex was tested
  against a 25-phrase battery: all 13 org-unit phrasings fire and **all 12 unrelated analytics phrasings
  ("create a chart for the facility", "how many enrollments in this facility", "render a map of facilities",
  …) correctly do NOT fire** — zero false positives, so routing for existing tools is unchanged. The
  facility-verb clause requires the management verb immediately before the facility noun, which is what keeps
  "create a **chart** for the facility" from matching.
- Touches **no shared code's behavior**: it only *calls* `safeDhis2Fetch`, `requireWriteAuth`,
  `verifyTargetExists`, `ensureBackupOrBail`, `checkMetadataReferences`, `buildDeletionHint`,
  `postMetadataPayload` and `generateDhis2Uid` with their existing signatures — no edits to any of them. New
  module-level identifiers (`OU_DATE_ONLY_RE`, `normalizeOuDate`, `isValidOuDate`, `executeManageOrgUnits`,
  `createOrgUnit`) were confirmed collision-free. `organisationUnits` is already a `backupableType`, so the
  auto-backup/restore machinery supports the tool out of the box.
  `checkMetadataReferences('organisationUnits', …)` is an unmapped type → returns `has_references:false`,
  after which the explicit children-count guard plus DHIS2's atomic DELETE report any genuine blocker
  (identical in spirit to how `manage_validation_rules` delete behaves).
- `panel.js` changes are additive (iconMap/toolLabels lookups fall back by default; the new `else if` branch
  precedes `manage_backups`), so every existing tool still renders.

**Verification (DHIS2 2.43 playground, `stable-2-43-0-1`):** Proved the full hierarchy logic with the tool's
exact field projections and payloads before and after writing the code — create under a level-3 chiefdom
(level auto-derived to 4, path auto-derived), bad parent rejected (E5002 "Invalid reference"), rename +
closedDate via `:owner` PUT, **re-parent a child from one parent to another (path/level recomputed for the
moved node)**, a parent-with-children delete correctly blocked (E4030), and a clean leaf delete (`deleted:1`)
→ read-back 404. Every test object was deleted and a name sweep confirmed **zero residue**. `node --check
background.js` and `node --check sidepanel/panel.js` both pass; the 25-case intent-routing test passes with
zero false positives.

---

## 12. New tool — `manage_indicators` (DHIS2 aggregate indicators — numerator/denominator formulas)

**File:** `background.js` (tool def, `TOOL_ROUTER`, `executeTool` dispatch, `executeManageIndicators` +
`createIndicator` handlers, `resolveIndicatorType` helper, `getContextualTools`, `buildSystemPrompt` KB);
`sidepanel/panel.js` (iconMap / toolLabels / detail).

**What was missing:** The chatbot could author tracker/event **program** indicators (`manage_program_indicators`),
datasets, validation rules and org units — but had **no** first-class way to author **aggregate indicators**,
the `(numerator / denominator) × factor` calculated values that dashboards, pivot tables and maps actually
display (ANC coverage, case-fatality rate, reporting rate, …). The only path was hand-assembling `/api/metadata`
bodies via `dhis2_query`, with no expression validation, no indicatorType resolution, no auto-backup and no
reference-aware delete.

**New capability — `manage_indicators`** with actions `list / get / create / update / delete`:
- **create** requires `name`, `numerator`, `denominator`, `indicator_type`. It **resolves + verifies the
  indicatorType** first (by UID or exact name — "Number (Factor 1)", "Per cent", "Per thousand", …), then
  **server-validates BOTH expressions** via DHIS2's `/expressions/description` endpoint (the playground
  confirmed it accepts the full aggregate-indicator grammar: `#{de}` / `#{de.coc}`, `R{ds.REPORTING_RATE}`,
  `I{programIndicator}`, `C{const}`, numeric literals and `+ - * /`). A bad UID or malformed syntax is rejected
  at create time with the parser's exact error — never silently saved. It generates the UID and imports through
  the shared `postMetadataPayload` VALIDATE-then-COMMIT path. Descriptions auto-derive from the validator if
  omitted; `short_name` defaults to `name` (≤50); `decimals` is range-checked 0–5; `denominator:"1"` gives a
  plain count/sum. Supports `dry_run_only`.
- **update** patches any field (incl. re-resolving a new `indicator_type` and re-validating any new
  numerator/denominator) **before** auto-snapshotting a backup (`ensureBackupOrBail`, restorable via
  `manage_backups`) and PUTting the `:owner` object.
- **delete** runs the reference check + auto-backup, deletes via `metadata?importStrategy=DELETE&atomicMode=ALL`,
  and on a `deleted:0` result **surfaces DHIS2's exact blocking reason** (referenced by a dataSet /
  visualization / indicatorGroup / predictor) instead of a generic message.
- **list/get** are read-only summaries (type, factor, annualized, both expressions).

**Wiring (every layer):** `TOOLS` array → `TOOL_ROUTER` → `executeTool` dispatch → handler →
`getContextualTools` (surfaced **only** on an explicit, program-indicator-disjoint `wantsIndicatorIntent`, plus
`search_metadata` for resolving expression UIDs; added to `writeCapableNames` so `manage_backups` is offered
after a write; added to the save-error-diagnosis read-only strip list) → `buildSystemPrompt` (an Aggregate
Indicators KB block gated on the matching `wantsIndicatorPrompt`) → `panel.js` iconMap (`📊`), toolLabels and a
`detail` renderer.

**No-regression analysis:**
- **Purely additive.** The `background.js` and `panel.js` diffs contain **zero deleted lines** — no existing
  function, prompt block, router branch or contextual-selection rule was modified. The new contextual intent
  only *adds* `manage_indicators` (+`search_metadata`) to the selected Set; it can never remove or crowd out an
  existing tool.
- **Disjoint from program indicators.** `wantsIndicatorIntent` / `wantsIndicatorPrompt` bail out the instant a
  turn mentions "program indicator(s)", so a `manage_program_indicators` (tracker) turn is **never** stolen. A
  25-phrase intent battery passes with **zero false positives** — all 11 unrelated/program-indicator phrasings
  ("create a program indicator…", "fix the broken program indicators", "audit indicators with complex
  expressions", "render a map of facilities", "what is the ANC coverage in 2023", …) correctly do NOT fire; all
  10 aggregate-indicator phrasings do. The tool description and the KB block each explicitly point program/event
  indicator work back to `manage_program_indicators`, so the system-prompt addition reinforces rather than
  contradicts existing guidance.
- **Touches no shared code's behavior.** It only *calls* `safeDhis2Fetch`, `requireWriteAuth`,
  `verifyTargetExists`, `ensureBackupOrBail`, `checkMetadataReferences`, `buildDeletionHint`,
  `postMetadataPayload`, `generateDhis2Uid` and `describeValidationExpression` with their existing signatures —
  no edits to any of them. `describeValidationExpression` is reused as the generic `/expressions/description`
  validator (its only prior caller, `executeManageValidationRules`, is unaffected). New module-level identifiers
  (`resolveIndicatorType`, `executeManageIndicators`, `createIndicator`) were confirmed collision-free.
  `indicators` is already a recognized backup type and is in `postMetadataPayload`'s shortName-autofix list, so
  the auto-backup/restore + conflict-autofix machinery supports the tool out of the box.
  `checkMetadataReferences('indicators', …)` is an unmapped type → returns `has_references:false`, after which
  DHIS2's atomic DELETE reports any genuine blocking reference (identical to `manage_validation_rules` /
  `manage_org_units`).
- `panel.js` changes are additive (iconMap/toolLabels lookups fall back by default; the new `else if` branch
  precedes `manage_backups`), so every existing tool still renders.

**Verification (DHIS2 2.43 playground, `stable-2-43-0-1`):** The full lifecycle was proven via curl with the
tool's exact paths/payloads BEFORE writing the code — pre-generated UID; `/api/metadata?importMode=VALIDATE`
(created:1, 0 errors) then COMMIT (created:1); read-back matched the payload exactly (indicatorType "Number
(Factor 1)", factor 1); `:owner` PUT update (rename + annualized→true) returned OK; `DELETE` returned deleted:1;
read-back 404. A bad indicatorType was rejected ("Invalid reference … (IndicatorType)") and the generic
`/expressions/description` endpoint was confirmed to validate `#{de}`, `R{ds.REPORTING_RATE}`, `I{pi}` and
numeric expressions (valid → status OK + description; bad UID / malformed → status ERROR). Every test object was
deleted and a `name:like:ZZ` sweep confirmed **zero residue**. `node --check background.js` and
`node --check sidepanel/panel.js` both pass; the intent battery passes with zero false positives.

---

## 13. New tool — `manage_option_sets` (DHIS2 option sets — reusable code/label pick-lists)

**File:** `background.js` (new `executeManageOptionSets` + `createOptionSet` + `normalizeOptionInputs`
+ `OPTION_SET_VALUE_TYPES`, TOOLS entry, TOOL_ROUTER, dispatch, `getContextualTools`,
`buildSystemPrompt`), `sidepanel/panel.js` (iconMap / toolLabels / detail renderer),
`manifest.json` (version 2.4.3 → 2.4.4).

**Type of change:** Added (new tool, purely additive).

**What it does:**
Adds full **standalone option-set lifecycle management**. An option set is the reusable, ordered
pick-list (drop-down) of `{ code, name }` options that data elements and tracked-entity attributes
reference to constrain input (e.g. "HIV Result: Positive/Negative/Inconclusive"). Before this run the
chatbot could only create an option set **inline** inside a new data element (`create_metadata`) or
**convert/delete** one through `manage_metadata` — there was **no way** to create a standalone set,
add/remove/reorder its options, or rename/retype it. `manage_option_sets` closes that gap with eight
actions:

- **list / get** — read-only (get returns options in display order).
- **create** — a new standalone optionSet + its Option objects, imported atomically through the shared
  `postMetadataPayload` VALIDATE-then-COMMIT path. `value_type` is validated against the canonical DHIS2
  valueType enum (defaults to TEXT); option codes are required, non-empty and de-duplicated up front.
  Supports `dry_run_only`.
- **add_options** — appends new options to an existing set. Re-fetches the set's `:owner`, rejects codes
  that collide with existing ones, generates UIDs, extends `options[]` and imports the new Option objects
  + updated set in one atomic payload.
- **remove_options** — deletes options by `option_codes[]` or `option_ids[]`. Deletes the Option objects
  directly (DHIS2 auto-detaches them from the set), and **refuses to remove the last remaining option**.
- **reorder_options** — sets display order from `order[]` (codes or UIDs). Fetches every option's `:owner`,
  validates the list covers each option exactly once, reassigns `sortOrder` 0-based and re-imports.
- **update** — patches only the set's OWN fields (name / code / description / value_type), never membership;
  auto-snapshots a backup then PUTs the merged `:owner`.
- **delete** — runs `checkMetadataReferences('optionSets', …)` (data elements + TEAs using the set) and
  refuses with the exact blockers if in use; otherwise deletes the child options first (so none are
  orphaned), then the set via atomic DELETE, surfacing DHIS2's exact reason on a `deleted:0`.

All destructive actions auto-snapshot a backup first (`ensureBackupOrBail`, restorable via
`manage_backups`).

**Wiring (every layer):** `TOOLS` array → `TOOL_ROUTER` → `executeTool` dispatch → handler →
`getContextualTools` (surfaced **only** on an explicit `wantsOptionSetIntent`, plus `search_metadata` for
resolving set/option UIDs; added to `writeCapableNames` so `manage_backups` is offered after a write; added
to the save-error-diagnosis read-only strip list) → `buildSystemPrompt` (an Option Sets KB block gated on
`wantsOptionSetPrompt`) → `panel.js` iconMap (`🗂️`), toolLabels and a `detail` renderer.

**No-regression analysis:**
- **Purely additive.** The only `git diff` "deletion" is a one-line reflow that keeps `manage_indicators`
  in `writeCapableNames` while appending `manage_option_sets` to the same line — no behavior removed. No
  existing function, prompt block, router branch or contextual-selection rule was modified. The new
  contextual intent only *adds* `manage_option_sets` (+`search_metadata`) to the selected Set; it can never
  remove or crowd out an existing tool.
- **Conservative, collision-free intent.** `wantsOptionSetIntent` / `wantsOptionSetPrompt` fire on an
  explicit "option set(s)" / "optionset(s)" mention, or a membership-mutation verb on "option(s)" coupled
  with a drop-down / code-list / "the … set" container term. A 24-phrase battery passes with **zero false
  positives** across 14 negatives (including adversarial "set the options for the analysis", "remove me from
  the data set query", "give me options to improve performance", "show me the dropdown menu settings") and
  9/10 realistic positives. The KB block and tool description explicitly defer inline option-set creation to
  `create_metadata` and MULTI_TEXT conversion to `manage_metadata(action=convert_value_type)`, so the
  system-prompt addition **reinforces** rather than contradicts existing guidance.
- **Touches no shared code's behavior.** It only *calls* `safeDhis2Fetch`, `requireWriteAuth`,
  `verifyTargetExists`, `ensureBackupOrBail`, `checkMetadataReferences`, `buildDeletionHint`,
  `postMetadataPayload` and `generateDhis2Uid` with their existing signatures — no edits to any of them.
  `checkMetadataReferences` already maps `optionSets` (DE + TEA usage); `postMetadataPayload` already lists
  `optionSets`/`options` in its shortName-autofix array; `getSnapshotFields` falls back to `:owner` for
  `optionSets`, so the auto-backup/restore machinery supports the tool out of the box. New module-level
  identifiers (`OPTION_SET_VALUE_TYPES`, `normalizeOptionInputs`, `executeManageOptionSets`,
  `createOptionSet`) were confirmed collision-free.
- `panel.js` changes are additive (iconMap/toolLabels lookups fall back by default; the new `else if` branch
  precedes `manage_backups`), so every existing tool still renders.

**Verification (DHIS2 2.43 playground, `stable-2-43-0-1`):** The full lifecycle was proven via curl with the
tool's exact paths/payloads BEFORE writing the code — pre-generated UIDs; atomic create
(`optionSets` + `options`) via `importMode=VALIDATE` (created:4, 0 errors) then COMMIT; read-back matched
(3 options, sortOrder normalized 0-based); `add_options` (full set `:owner` + new Option → created:1
updated:1); `reorder_options` (fetch options `:owner`, reassign sortOrder, re-import → updated:4, order
reversed exactly); `remove_options` (direct `DELETE /options/{id}` auto-detached from the set);
`update` (PUT `:owner` rename) returned OK; `delete` (child options then set) returned 200 each. A
`name:like:ZZAITEST` sweep confirmed **zero residue** (0 optionSets, 0 options). `node --check background.js`
and `node --check sidepanel/panel.js` both pass; the intent battery passes with zero false positives.

---

## 14. New tool — `manage_legend_sets` (DHIS2 legend sets — reusable colour-coded value bands)

**File:** `background.js` (new `executeManageLegendSets` + `createLegendSet` + `normalizeLegendInputs`
+ `normalizeLegendColor` + `detectLegendOverlaps` + `legendRampColor` + `buildLegendAutoBands`
+ `LEGEND_HEX_COLOR_RE`, TOOLS entry, TOOL_ROUTER, dispatch, a `legendSets` branch in
`checkMetadataReferences`, legend-set branches in `buildDeletionHint`, `getContextualTools`
surfacing + `writeCapableNames` + save-diagnosis strip, `buildSystemPrompt` flag + KB block),
`sidepanel/panel.js` (iconMap / toolLabels / detail renderer), `manifest.json` (version 2.4.4 → 2.4.5).

**Type of change:** Added (new tool, purely additive).

**What it does:**
Adds full **standalone legend-set lifecycle management**. A DHIS2 *legend set* is the reusable, ordered
list of colour **bands** that data elements, indicators, visualisations and maps use to render numeric
values as a traffic-light / heat-map scale (e.g. ANC coverage shaded red 0–50, amber 50–80, green
80–100). Before this run the chatbot could only **read** legend sets (inside `get_map_details`); it had
**no way** to create one, add/remove bands, rename it, or delete it. `manage_legend_sets` closes that gap
with seven actions:

- **list / get** — read-only (get returns bands in value order and warns about any overlaps).
- **create** — a new legendSet + its embedded legends, imported atomically (VALIDATE then COMMIT) through
  the shared `postMetadataPayload`. Bands may be listed explicitly, **or** auto-generated with
  `auto_bands:{ start, end, count }` — `count` equal-width, contiguous, gap-free bands spanning start→end
  on a red→amber→green (low→high) ramp. `auto_bands.colors` / `auto_bands.names` (length must equal count)
  override the defaults.
- **add_legends / remove_legends** — append bands to, or drop bands (by name or UID) from, an existing
  set via its `:owner` snapshot (mergeMode REPLACE deletes any band left out); refuses to remove the last
  remaining band.
- **update** — patch the set's OWN fields (name / code) only — never the bands.
- **delete** — remove the whole set (its legends cascade); reference-checked against data elements,
  indicators, visualisations and maps, refusing with the exact blockers if anything still uses it.

Ranges are validated half-open **[startValue, endValue)** (endValue > startValue; a band's endValue may
equal the next band's startValue without overlapping). Colours are canonicalised to `#RRGGBB`. Overlaps
are **warned about, never blocked** — matching DHIS2's own server behaviour (proven below).

**Wiring (every layer):** `TOOLS` array → `TOOL_ROUTER` → `executeTool` dispatch → handler →
`getContextualTools` (surfaced **only** on an explicit `wantsLegendSetIntent`, plus `search_metadata`
for resolving DE/indicator UIDs; added to `writeCapableNames` so `manage_backups` is offered after a
write; added to the save-error-diagnosis read-only strip list) → `buildSystemPrompt` (a Legend Sets KB
block gated on `wantsLegendSetPrompt`) → `panel.js` iconMap (`🎨`), toolLabels and a `detail` renderer.

**No-regression analysis:**
- **Purely additive.** The only `git diff` "deletions" are a one-line reflow that keeps
  `manage_option_sets` in `writeCapableNames` while appending `manage_legend_sets` to the same line, and
  the `manifest.json` version bump — no behavior removed. No existing function, prompt block, router
  branch, reference-check branch, deletion-hint branch or contextual-selection rule was modified.
- **Shared code touched only by ADDING mutually-exclusive branches.** The new
  `if (objectType === 'legendSets')` branch in `checkMetadataReferences` runs only for that objectType, so
  every existing caller (dataElements / optionSets / trackedEntityAttributes / programStages) is byte-for-
  byte unchanged. It deliberately uses **distinct ref keys** (`*_using_legendset`) so it can never collide
  with the option-set keys (`data_elements_using_this`); the four new `buildDeletionHint` branches key off
  those distinct names, leaving every other type's hint output identical.
- **Calls shared helpers with their existing signatures only** — `safeDhis2Fetch`, `requireWriteAuth`,
  `verifyTargetExists`, `ensureBackupOrBail`, `postMetadataPayload`, `generateDhis2Uid`. No edits to any of
  them. `getSnapshotFields` falls back to `:owner` for legendSets (the snapshot includes the legends, so
  auto-backup/restore works out of the box); `postMetadataPayload`'s shortName-autofix list does **not**
  include legendSets (which have no shortName), so it is a guaranteed no-op for this tool.
- **Conservative, collision-free intent.** `wantsLegendSetIntent` / `wantsLegendSetPrompt` fire on an
  explicit "legend set(s)" / "legendset(s)" mention, or a colour-coding / colour-band-scale-ramp-range /
  value-threshold term coupled with an authoring or visual-styling noun. A 22-phrase battery passes with
  **zero false positives** across 12 negatives (including adversarial "show me the legend of this chart",
  "hide the legend on my visualization", "the threshold for the alert is too high, change the program
  rule", "the legendary performance of this query") and 10/10 realistic positives. The selection only
  *adds* `manage_legend_sets` (+`search_metadata`) to the chosen set — it can never remove or crowd out an
  existing tool. The KB block defers *attaching* a legend set to a DE/indicator/visualisation to
  `manage_metadata` and the relevant app, so it reinforces rather than contradicts existing guidance.
- New module-level identifiers (`LEGEND_HEX_COLOR_RE`, `normalizeLegendColor`, `normalizeLegendInputs`,
  `detectLegendOverlaps`, `legendRampColor`, `buildLegendAutoBands`, `executeManageLegendSets`,
  `createLegendSet`) were confirmed collision-free; `panel.js` changes are additive (the new `else if`
  branch precedes `manage_backups`; iconMap/toolLabels fall back by default), so every existing tool still
  renders.

**Verification (DHIS2 2.43 playground, `stable-2-43-0-1`):** The full lifecycle was proven via curl with
the tool's exact paths/payloads BEFORE and AFTER writing the code — pre-generated UIDs; atomic create
(legendSet with embedded legends) via `importMode=VALIDATE` (status OK) then COMMIT; read-back matched
(3 bands, colours preserved, sorted by startValue); **colour confirmed optional** (a band with no colour
imported as `color:null`); `add_legends` (full `:owner` + new band re-import → OK, grew 3→4);
`remove_legends` (shrink the `:owner` legends array and re-import → the dropped band is **deleted**, no
orphan — there is no standalone `/api/legends` collection in 2.43, confirmed 404); `update` (PUT `:owner`
rename) returned OK; `delete` via `metadata?importStrategy=DELETE` returned `deleted:1` (legends cascade);
**overlap is NOT rejected by the server** (a deliberately overlapping VALIDATE returned status OK), which
is why the tool warns rather than blocks. The four delete-time reference filters were validated against a
real in-use legend set (`legendSets.id` on dataElements + indicators, `legendSet.id` on visualizations,
`mapViews.legendSet.id` on maps — returned 2 DEs and 11 visualizations). The `auto_bands` generator was
unit-tested in Node (contiguous, gap-free, endpoints pinned exactly, red→amber→green ramp, colour-override
and bad-colour rejection). A `name:like:ZZAITEST` + `code:like:ZZAITEST` sweep confirmed **zero residue**.
`node --check background.js` and `node --check sidepanel/panel.js` both pass; the intent battery passes
with zero false positives.

---

## 15. Hard-coded privacy safeguard — patient-level tracker data only on a LOCAL (Ollama) model

**File:** `background.js` — new `PATIENT_DATA_TOOL_NAMES`, `pathReadsPatientData`,
`toolReadsPatientData`, `enforcePatientDataPrivacyGate` (just before `executeTool`); a gate call at
the top of `executeTool`; and a provider-aware rewrite of system-prompt rule #11 in
`buildSystemPrompt`. **Version:** 2.4.5 → 2.5.0.

**Why:** Patient/tracker individual-record reads must NEVER be processed by a remote/cloud LLM —
only by a local model — so patient identities never leave the device to a third party. The repo
already *told* the model "patient data lookup is DISABLED" (system-prompt rule #11), but that is a
soft instruction a model can be talked/jailbroken around. This adds a HARD, code-level enforcement.

**What it does:** `executeTool` is the single choke point through which every tool call runs
(verified: its only callers are the agentic loop and the viz/map prefetch). Before any tool logic,
`enforcePatientDataPrivacyGate(name, args)` runs:
- It returns a refusal (`_privacy_block:true`, `_scope:"patient_data_privacy_gate"`) when the call
  would read patient-level data AND the provider is not local.
- "Reads patient data" = the tool name is in `PATIENT_DATA_TOOL_NAMES` (currently
  `detect_enrollment_abnormalities`); OR `dhis2_query` to an individual-record path
  (`tracker/events|enrollments|trackedEntities|relationships`, legacy
  `events|enrollments|trackedEntityInstances`, or `analytics/(events|enrollments)/query`); OR
  `get_event_analytics` in row mode (`aggregate_type="query"` / `value_dimensions`).
- "Local" = `isLocalProvider(getProviderConfig())` — `providerType==="ollama"` or a
  localhost/127.0.0.1/::1/\*.local `apiBaseUrl`.
- De-identified AGGREGATE analytics (`analytics/events/aggregate`, `get_event_analytics`
  aggregate), `count_records`, and all metadata/dashboard work are UNAFFECTED.

This is **not** overridable by any prompt content — it is enforced in code regardless of what the
model is told or asked. Any future patient-data tool is auto-gated by adding its name to
`PATIENT_DATA_TOOL_NAMES` (or extending `toolReadsPatientData`).

System-prompt rule #11 is now provider-aware so the model's behavior matches the gate: on a local
model it MAY use patient-level tools; on cloud it is told the reads are hard-blocked in code and to
offer aggregate alternatives.

**Scope of impact:** No existing aggregate/metadata/dashboard capability changes. On cloud providers
the only new behavior is that patient-row reads are refused (previously discouraged only by prompt).
On local (Ollama) patient-level tools become usable, matching the owner's intent.

**Verification:** `node --check` passes on both JS files. Gate unit-tested 14/14 on classification
(8 patient-data vectors blocked, 6 aggregate/metadata/count cases allowed) and 4/4 on gate behavior
(cloud+patient → blocked with `_privacy_block`; local+patient → allowed; cloud+metadata → allowed;
local+patient via dhis2_query → allowed).

---

## 16. New tool — `manage_dashboards` (DHIS2 analytics dashboards & visualizations builder)

**File:** `background.js` — new `manage_dashboards` tool (TOOLS array, TOOL_ROUTER, `executeTool`
dispatch), new helpers `resolveDataItemTypes` / `buildVisualizationObject` / `executeManageDashboards`
and constants `VIZ_TYPES` / `VIZ_REL_PERIOD_FLAG` / `VIZ_REL_OU` / `VIZ_DDI_KEY` / `vizDefaultLayout`;
`getContextualTools` gains a `wantsDashboardIntent` selector (also surfaces on the Dashboard / Data
Visualizer apps) and adds `manage_dashboards` to `writeCapableNames` and the save-failure strip;
`buildSystemPrompt` gains a `wantsDashboardPrompt` flag + a Dashboards & Visualizations KB section.
`sidepanel/panel.js` — icon (📊), label ("Building dashboards"), and detail renderer.
**Version:** 2.5.0 → 2.6.0.

**The gap it closes:** the extension had read-only viz tooling (`get_visualization_details`,
`get_map_details`) and `manage_metadata` could only DELETE/share dashboards & visualizations — but
there was NO tool to CREATE a visualization or a dashboard. For "build me an ANC dashboard" the
chatbot had to hand-assemble raw `/metadata` `visualizations`/`dashboards` POSTs through
`dhis2_query`, the exact error-prone path every other authoring tool warns against.

**The trap it avoids (proven on the 2.43 playground BEFORE writing):** a naive visualization POST that
sets only `columns`/`rows`/`filters` imports with status OK but reads back EMPTY — those arrays are
DERIVED read-only views. DHIS2 stores the LAYOUT as `columnDimensions`/`rowDimensions`/
`filterDimensions` (dimension-id lists) and the DATA as `dataDimensionItems` (typed INDICATOR /
DATA_ELEMENT / PROGRAM_INDICATOR), `relativePeriods` (boolean flags) + `periods` (fixed ISO), and
`organisationUnits` + `organisationUnitLevels` (PLAIN INTEGER list — `[2]`, not `[{level:2}]`) +
`userOrganisationUnit*` flags. A raw POST that gets any of this wrong yields a silently un-renderable
chart. `buildVisualizationObject` assembles the exact correct structure.

**Actions:** `list` / `get` (read-only) · `create_visualization` (one chart / pivot / single-value) ·
`create_dashboard` (a whole dashboard atomically — each item references an existing visualization/map
by UID, embeds free text, or inline-creates a new visualization; items auto-packed on the 58-column
grid). 16 vis types supported (COLUMN, STACKED_COLUMN, BAR, LINE, AREA, PIE, RADAR, GAUGE,
SINGLE_VALUE, PIVOT_TABLE, YoY, …); friendly `periods` (relative keywords + fixed ISO) and `org_units`
(UIDs + USER_ORGUNIT / USER_ORGUNIT_CHILDREN / LEVEL-n); sensible per-type layout defaults with an
optional `layout` override.

**Safety:** both create actions are gated by `requireWriteAuth`; data-item UIDs are existence-verified
via `resolveDataItemTypes` (and a hallucinated UID is rejected, not silently dropped); referenced
existing visualization/map UIDs are verified before import; create_dashboard imports the new
visualizations and the dashboard in ONE atomic `VALIDATE`-then-`COMMIT` (`postMetadataPayload`), so one
bad UID rolls the whole thing back — nothing half-built is left behind. DELETE / sharing remain with
`manage_metadata`. The tool reads/creates only AGGREGATE visualization + indicator/DE/PI/OU metadata —
it never touches patient-level data, so it is correctly NOT a `PATIENT_DATA_TOOL_NAMES` member; the
`enforcePatientDataPrivacyGate` choke point still runs ahead of it and passes it through.

**Scope of impact:** purely additive. No existing tool, prompt path, contextual selection, or safeguard
was modified (verified: the diff touches no safeguard code; collision check shows every new symbol is
unique). `render_chart` (inline preview) and `get_visualization_details` remain in the tool set and the
dashboard intent is conservative and disjoint from them (it requires the word "dashboard", or a
persistence verb + a saved-visualization noun), so it never steals an inline-chart turn.

**Verification:** `node --check` passes on both JS files. The SHIPPED `buildVisualizationObject` was
extracted and run in Node: it produced valid COLUMN / PIVOT_TABLE / SINGLE_VALUE / LINE payloads that
imported on the live 2.43 playground (`VALIDATE` OK → `COMMIT` OK) and read back with correct
`columnDimensions`/`rowDimensions`/`filterDimensions`, `dataDimensionItems`, `relativePeriods`, fixed
`periods`, `organisationUnitLevels:[2]` and `userOrganisationUnit*` flags; its three error paths
(bad vis_type, missing UID, empty name) returned `_error` instead of throwing. The SHIPPED
`executeManageDashboards` create_dashboard path was run with stubbed network helpers and produced a
correct mixed payload (inline new viz + existing-viz reference + TEXT tile, grid-packed 0/29/wrap);
that payload (pointed at a real existing viz) imported end-to-end on the playground and read back as a
3-item dashboard. Every test object was deleted and a `name:like:ZZAITEST` sweep confirmed ZERO
residue (visualizations + dashboards).

## 17. Security hardening — close file-extension bypass in the patient-data privacy gate

**File:** `background.js` — `pathReadsPatientData` (the path matcher behind the hard-coded
`enforcePatientDataPrivacyGate` choke point in `executeTool`). The three endpoint-matching regexes
had their segment-boundary alternation widened from `(\/|$)` / `(\/|\.json|$)` to `(\/|\.|$)`.
**Version:** 2.6.0 → 2.6.1.

**The hole it closes (proven on the live 2.43 playground BEFORE the fix):** DHIS2 endpoints serve the
same record under a format/extension suffix as without it — `GET /api/tracker/trackedEntities.json`,
`/api/tracker/events.csv`, `/api/tracker/enrollments.json`, `/api/tracker/relationships.xml` and
`/api/analytics/events/query.csv` all return the exact same individual patient rows as their
extension-less form. The old patterns anchored the resource name on `/` or end-of-path only
(`tracker/(events|…)(\/|$)`), so a trailing `.json` / `.csv` / `.xml` made the path fall through the
matcher and the privacy gate passed it to a remote/cloud model. Live confirmation against
`stable-2-43-0-1`: `tracker/trackedEntities.json` → HTTP 200 with TEI UID + attributes (identical to
the gated `tracker/trackedEntities`), and `tracker/events.csv` → HTTP 200, **367 KB of individual
event rows** (occurredAt, orgUnit, enrollment, …). Both would have been exfiltrated to a third-party
LLM with the old gate; both are now blocked.

**The fix:** `(\/|\.|$)` treats a trailing dot-extension (`.json`, `.csv`, `.xml`, `.geojson`,
`.csv.gz`, …) exactly like end-of-segment, so the suffix forms are gated identically to the bare
endpoint. This is a strict superset — `(\/|$)` and `(\/|\.json|$)` are subsets of `(\/|\.|$)` — so the
matcher gates everything it did before plus the extension variants, and *un-gates nothing*. The legacy
pattern's narrower `(\/|\.json|$)` (which let `.csv`/`.xml` through) is likewise tightened to `(\/|\.|$)`.

**Safety / invariant compliance:** this only STRENGTHENS the existing hard-coded safeguard #15 — no
safeguard was weakened or removed, no patient-data tool was un-registered, and the local-vs-remote
decision (`isLocalProvider`) is untouched. Purely additive gating.

**Scope of impact:** `pathReadsPatientData` has exactly one caller — `toolReadsPatientData` (the
`dhis2_query` branch) — which feeds only `enforcePatientDataPrivacyGate`. No tool, prompt path,
contextual selection, or other safeguard is touched. None of the de-identified / metadata endpoints
begin with one of the gated resource names followed by `/`, `.`, or end-of-path, so the `.` boundary
never over-gates: `analytics/events/aggregate.json`, `eventReports(.json)`, `eventCharts.json`,
`eventVisualizations.json`, `relationshipTypes.json`, `trackedEntityAttributes/Types.json`,
`dataValueSets.json` etc. all still pass through unchanged.

**Verification:** `node --check` passes on both JS files. The SHIPPED `pathReadsPatientData` was
extracted and run in Node against a 36-case suite (22 MUST-BLOCK incl. every confirmed
extension-suffix bypass + version-prefixed + double-extension forms; 14 MUST-ALLOW de-identified /
metadata endpoints) → 36/36. The full gate chain (`pathReadsPatientData` → `toolReadsPatientData` →
`enforcePatientDataPrivacyGate`) was run with stubbed provider configs: under a REMOTE provider it
blocks `tracker/events.csv` and `tracker/trackedEntities.json` while still allowing
`analytics/events/aggregate.json`; under a LOCAL (Ollama) provider it correctly allows the patient
read. No playground objects were created (read-only GET probes), so there is nothing to clean up.

## 18. Router + orchestration — flawless multi-step dashboard goals (no new tools)

**Files:** `background.js` (getContextualTools router; buildSystemPrompt; executeManageDashboards), `manifest.json` (2.6.1 → 2.6.2).

**Goal of this phase:** make the ROUTER perfect and the EXISTING tools deeply orchestrated for
MULTI-STEP goals where reaching the user's request needs several dependent steps in the right order —
the canonical case being "build a dashboard that needs indicators/visualizations that don't exist
yet". No new user-facing tool was added; only routing, orchestration guidance, and integration
robustness were strengthened.

**What was reproduced first (the chatbot's own tools, traced end-to-end):** for the request *"Build a
malaria surveillance dashboard for case fatality rate and ACT coverage — we don't have those
indicators yet, create them and the dashboard, and share it with everyone"*, the existing
`getContextualTools` + `buildSystemPrompt` were traced. Three concrete defects surfaced:
1. **Routing miss (sharing tool absent):** `manage_metadata` is the ONLY tool that can set a
   dashboard's sharing or delete it (`manage_dashboards` only creates/reads). It was NOT co-surfaced
   with `manage_dashboards`, so on Data Visualizer / Maps the chain's final "share it" step had no tool
   and would fall back to a raw `dhis2_query` PUT that DHIS2 rejects (405/500).
2. **Routing miss (sharing intent too narrow):** `wantsSharingIntent` matched only
   "sharing/access/permission/share with…"; natural phrasings "share the dashboard with everyone",
   "make it public", "publicly" did NOT fire it, so a sharing follow-up off the Dashboard app surfaced
   no sharing tool.
3. **Orchestration gap:** no cross-tool playbook told the model to decompose a compound goal, create
   leaf metadata first, chain each tool's RETURNED UID into the next tool's inputs, and share last.
   Plus an integration wrinkle: `manage_indicators` returns top-level `indicator_id` but
   `manage_dashboards` returned only nested `visualization.id` / `dashboard.id`, making ID-chaining
   inconsistent.

**Gold-standard sequence proven on the live 2.43 playground (before editing):** real malaria data
elements → 2 aggregate indicators (atomic VALIDATE→COMMIT) → 2 visualizations + 1 dashboard referencing
those indicator UIDs (atomic VALIDATE→COMMIT) → dashboard public sharing (`publicAccess r-------`).
Every stage returned 0 errors; the dashboard read back with both visualizations chained to the new
indicators and `publicAccess=r-------`. All 5 objects deleted and a `name:like:ZZAITEST` sweep across
indicators + visualizations + dashboards confirmed ZERO residue.

**Changes made (all additive / strengthening — no safeguard touched):**
- **Routing — `getContextualTools`:** (a) `wantsSharingIntent` broadened to recognise "make/set/
  mark/publish/share … public(ly)", "public(ly) … access/sharing/visible/to everyone/to all",
  "share … with everyone/all users/the public/user group/team/colleagues", and "give/grant everyone
  access" — tightened so "create a public health **program**" does NOT misfire. (b) When explicit
  dashboard/visualization authoring intent fires (`wantsDashboardIntent`), `manage_metadata` is now
  co-surfaced alongside `manage_dashboards` so the sharing/delete step of the dashboard chain is always
  reachable in the same turn. Gated on explicit text intent (NOT bare `isDataViz`/`isDashboard`), so
  pure analytics turns add no destructive tool.
- **Orchestration — `buildSystemPrompt`:** new gated **"Multi-step goals — decompose, order by
  dependency, chain IDs"** section. It teaches: understand the end state → walk dependencies backwards
  → create leaf metadata first → read each result and capture the returned UID
  (`indicator_id` / `visualization_id` / `dashboard_id`) → chain it into the next tool's inputs →
  share LAST via `manage_metadata(update_sharing)`. Includes the exact 4-step malaria worked chain that
  was proven on the playground. Gated on a new `wantsMultiStepGoal` flag (dashboard CREATION + a second
  buildable piece, OR an assembling verb + chaining word + ≥2 distinct buildable nouns) so it never
  bloats single-step turns. `wantsSharingAccess` got the same "make public / share with everyone"
  alternatives so the Sharing KB loads on those phrasings.
- **Integration — `executeManageDashboards`:** `create_visualization` now returns top-level
  `visualization_id` and `create_dashboard` returns top-level `dashboard_id` (alongside the existing
  nested objects, which are preserved), mirroring `manage_indicators`' `indicator_id` convention so
  cross-tool ID-chaining is consistent and reliable.

**No-regression gate:** every `getContextualTools` change is purely additive (`selected.add` only — no
tool removed, no branch altered); the save-failure read-only strip block still runs AFTER the new
`manage_metadata` add, so destructive tools are still hidden in diagnostic mode (safeguard intact). The
new prompt flag only GATES the new section; no other KB section changed. The return-field additions are
new keys only — no code consumes these results (they go to the LLM); `args.visualization_id` /
`args.dashboard_id` readers operate on tool INPUTS, not outputs. `enforcePatientDataPrivacyGate`,
`PATIENT_DATA_TOOL_NAMES`, `requireWriteAuth`, `verifyTargetExists`, `ensureBackupOrBail`, and the
UID-verification gates are untouched. A node re-trace of the canonical request plus 5 regression
controls (explain-chart on Data Visualizer, "create a public health program", simple single-step
dashboard, share-follow-up, count question) passed every assertion: the canonical request now surfaces
`manage_metadata` and shows the orchestration playbook, while every control is unchanged. Both gold
payloads re-VALIDATE on the live playground with 0 errors. `node --check` passes on `background.js` and
`sidepanel/panel.js`.

## 19. Router — org-unit provisioning multi-step goals (surface `manage_org_units` for "register N facilities")

**Files:** `background.js` (getContextualTools router `wantsOrgUnitIntent`; buildSystemPrompt `wantsOrgUnitPrompt`), `manifest.json` (2.6.2 → 2.6.3).

**Goal of this phase:** perfect the ROUTER and orchestration of the EXISTING tools for MULTI-STEP goals —
no new user-facing tool. This run targets a DIFFERENT multi-step scenario than the recent dashboard runs:
an **org-unit provisioning chain** — *"Register three new health facilities under Badjia district, then
assign our malaria dataset to them so they can start reporting."* The correct chain is
`manage_org_units(action=create)` ×3 → chain each returned `org_unit_id` →
`manage_datasets(action=assign_org_units, org_unit_ids=[…], merge_mode="add")`.

**What was reproduced first (the chatbot's own tools, traced end-to-end):** tracing the request through
`getContextualTools`, the FIRST (leaf) step of the chain had **no tool surfaced** — a routing miss. The
org-unit intent's facility-creation alternative used
`(?:a|an|the|new|this|that)*(?:\w+\s+){0,1}(facility|health facility|clinic|hospital|chiefdom|…)`, which:
1. **Two-word determiner gap:** a numeral immediately followed by "new" (e.g. "three **new** health
   facilities", "create **two new** health facilities", "build **5 new** facilities") consumed BOTH
   determiner slots, so the facility noun fell outside the single free-word window → `wantsOrgUnitIntent`
   was **FALSE** and `manage_org_units` + `search_metadata` were never surfaced. The model would fall
   back to hand-rolled `dhis2_query` metadata POSTs (no parent-exists check, no level/path derivation,
   no auto-backup).
2. **Singular-only nouns:** "clinic"/"hospital"/"chiefdom"/"catchment area"/"sub-district" had no plural
   form, so "register new **clinics**", "delete three **hospitals**", "add four **catchment areas**" all
   missed. (`facility/facilities` already had both forms; the others did not.)

Both defects existed identically in the router (`wantsOrgUnitIntent`) AND in the prompt-side
`wantsOrgUnitPrompt` (which loads the org-unit KB), so the KB guidance was also withheld on these turns.

**Gold sequence proven on the playground (stable-2-43-0-1) BEFORE editing:** created 3 facilities under
*Badjia* (`YuQRtpLP10I`, L3) at level 4 via `metadata?importMode=VALIDATE&atomicMode=ALL` then `COMMIT`
(0 errors), then chained the 3 returned UIDs into the *ART monthly summary* dataset's `organisationUnits`
(1096 → 1099), read back the level-4 placement, then fully reverted (dataset back to 1096, all 3
facilities deleted, `name:like:ZZAITEST` sweep = 0 residue). This is the exact dependency-ordered,
ID-chaining sequence the chatbot must now produce on its own.

**Fix (purely additive widening — one regex alternative, mirrored in both `wantsOrgUnitIntent` and
`wantsOrgUnitPrompt`):**
- Determiner group gained `some|several|multiple|\d+|one…ten` so a quantifier ("three", "5", "several")
  and "new" can BOTH precede the facility noun.
- Noun group pluralised: `clinics?|hospitals?|chiefdoms?|catchment areas?|sub-districts?`.
- The single free-word window `(?:\w+\s+){0,1}` and every OTHER alternative are UNCHANGED, so this only
  ADDS matches — no previously-matching request stops matching.

**No-regression gate (all proven with node before commit):**
- **Improvement:** the org-unit provisioning request now surfaces `manage_org_units` + `search_metadata`
  in the router AND loads the org-unit KB in the prompt, so the full create-then-assign chain is
  reachable in one turn.
- **Zero collateral / no crowding-out:** the change is confined to ONE alternative of the org-unit OR.
  When it fires it only does `selected.add('manage_org_units'); selected.add('search_metadata')` — it
  REMOVES nothing and alters no other branch, so every other request type surfaces exactly the same
  tools as before. A 10-case false-positive control suite (e.g. "compare 3 facilities by ANC coverage",
  "list the top 5 facilities", "which 3 districts have the most cases", "make a pivot of 5 hospitals",
  "add data elements to the dataset", "build a dashboard of clinic performance") stays **FALSE** — pure
  analytics/count/dataset/dashboard turns never gain the org-unit tool — while a 5-case provisioning
  suite now correctly matches. The old-vs-new diff test confirmed every previously-TRUE case is still
  TRUE.
- **Integration verified:** `manage_org_units(action=create)` returns top-level `org_unit_id` and
  `manage_datasets(action=assign_org_units)` consumes `org_unit_ids[]` — the ID-chain composes cleanly,
  matching the proven playground sequence.
- **No safeguard weakened:** `enforcePatientDataPrivacyGate`, `PATIENT_DATA_TOOL_NAMES`,
  `requireWriteAuth`, `verifyTargetExists`, `ensureBackupOrBail`, and the UID-verification gates are
  untouched (org-unit create/update/delete still route through their existing write-auth + backup gates).
  No new tool was added.
- The gold create payload re-VALIDATEs on the live playground with 0 errors; 0 test residue left behind.
  `node --check` passes on `background.js` and `sidepanel/panel.js`.

---

## 20. Integration + orchestration — chain a NEW program indicator into a dashboard (tracker-PI → dashboard → sharing)

**Files:** `background.js` (`_buildAndPostProgramIndicator` create/update return; multi-step orchestration playbook in `buildSystemPrompt`), `manifest.json` (2.6.3 → 2.6.4).

**Goal of this phase:** perfect the ROUTER and the ORCHESTRATION/INTEGRATION of the EXISTING tools for
MULTI-STEP goals — no new user-facing tool. This run targets a DIFFERENT multi-step scenario than the
recent dashboard/org-unit runs: a **tracker-program-indicator → dashboard → sharing chain** —
*"On the malaria case tracker program, create a program indicator that counts confirmed malaria cases,
then build a dashboard with a monthly column chart of that indicator and make the dashboard public."*
The correct chain is `manage_program_indicators(action=create)` → chain the new PI UID →
`manage_dashboards(action=create_dashboard, items:[{new_visualization:{data_items:[<PI UID>]}}])` (the UID
auto-resolves as `PROGRAM_INDICATOR`) → `manage_metadata(action=update_sharing, object_type="dashboards")`.

**What was reproduced first (the chatbot's own tools, traced end-to-end):** routing was already correct —
tracing the request through `getContextualTools` surfaced `manage_program_indicators` (via
`wantsProgramIndicatorsIntent`), `manage_dashboards` + `manage_metadata` (via `wantsDashboardIntent`),
`manage_metadata` (via `wantsSharingIntent`), the authoring kit + `get_program_info` (via
`wantsCreateIntent`), and `search_metadata` (always). `buildSystemPrompt` fired `wantsMultiStepGoal`, so
the orchestration playbook loaded. The gaps were in **integration + orchestration guidance**, not routing:
1. **Integration inconsistency (buried chain-UID):** every other write tool returns its new object's UID
   at a top-level `*_id` field (`manage_indicators → indicator_id`, `manage_dashboards → visualization_id`
   / `dashboard_id`, `manage_org_units → org_unit_id`, `manage_datasets → dataset_id`), and the playbook
   tells the model to "capture the `*_id` the tool returns". But `manage_program_indicators(action=create)`
   returned the new PI UID ONLY at the nested `summary.indicator.id` — no top-level `*_id`. A model
   following the playbook literally would find no `*_id` and could fail to chain the PI into the dashboard.
2. **Orchestration guidance gap:** the playbook's step-4 ID-capture list omitted
   `manage_program_indicators` entirely, and its worked example covered only AGGREGATE indicators — so a
   tracker/event program indicator → dashboard chain (a very realistic compound goal) had no guidance that
   a `programIndicator` UID plots on a dashboard exactly like an aggregate indicator UID.

**Gold sequence proven on the playground (stable-2-43-0-1) BEFORE editing:** created a program indicator
(`V{event_count}`, EVENT/COUNT) on the *Malaria case diagnosis…* tracker program (`qDkgAbB5Jlk`) via
`metadata?importMode=VALIDATE&atomicMode=ALL` then `COMMIT` (0 errors); chained the returned PI UID into a
`COLUMN` visualization's `dataDimensionItems` as `PROGRAM_INDICATOR`; assembled a dashboard tile from that
visualization; set the dashboard `publicAccess` to `r-------` via `/sharing?type=dashboard`. Read back all
three objects (PI on program, viz plotting the PI, dashboard embedding the viz, sharing = `r-------`), then
fully cleaned up (dashboard + viz + PI deleted, `name:like:ZZAITEST` sweep = 0 residue across
programIndicators/visualizations/dashboards). This is the exact dependency-ordered, ID-chaining sequence
the chatbot must now produce on its own.

**Fix (purely additive — one return field + prompt-text guidance; no routing/logic change):**
- `_buildAndPostProgramIndicator` now returns a top-level `program_indicator_id` (the PI UID) alongside
  the preserved `summary.indicator.id`, mirroring the `*_id` convention of every other write tool. It is
  added ONLY when `postMetadataPayload` reports `success` (`if (result && result.success)`), so a failed
  create never yields a chainable-but-nonexistent UID.
- The multi-step orchestration playbook now lists `manage_program_indicators(action="create") →
  program_indicator_id` in its step-4 ID-capture table, and step-5 explains that `data_items` accepts
  aggregate-indicator, dataElement AND programIndicator UIDs interchangeably (types auto-resolved), so a
  tracker program indicator plots on a dashboard exactly like an aggregate one.

**No-regression gate (all verified before commit):**
- **Improvement:** a newly-created tracker program indicator's UID is now exposed at the same top-level
  `*_id` slot the playbook teaches, and the playbook explicitly covers chaining it into a dashboard — so
  the full PI → dashboard → sharing chain is reachable in one uninterrupted turn.
- **Zero collateral:** the return change is `out = { ...result, summary }` then a conditional additive
  field — `summary.indicator.id` and every existing key are byte-for-byte unchanged, so every existing
  reader of the create/update return is unaffected. The playbook edit is prompt STRING text inside the
  existing `if (wantsMultiStepGoal)` block — no regex, flag, or control-flow change.
- **No routing change:** `getContextualTools` was NOT touched, so every request type surfaces exactly the
  same tools as before — no crowding-out, no mis-route. (The scenario's tools were already surfaced
  correctly; the gap was integration/orchestration, not routing.)
- **Shared-code callers enumerated:** `_buildAndPostProgramIndicator` is called ONLY by
  `manage_program_indicators` create and update; both return its output verbatim to the executor, and no
  downstream code enumerates its keys — both paths are unchanged-or-improved (additive field on success).
- **No safeguard weakened:** `enforcePatientDataPrivacyGate`, `PATIENT_DATA_TOOL_NAMES`, `requireWriteAuth`
  (still gates PI create/update/delete), `verifyTargetExists`, `ensureBackupOrBail`, the expression/filter
  lint, and the UID-verification gates are all untouched. No new tool was added.
- The proven sequence re-VALIDATEs on the live playground with 0 errors (VALIDATE-only, nothing persisted);
  0 test residue left behind. `node --check` passes on `background.js` and `sidepanel/panel.js`.

---

## 21. Integration — reference an EXISTING option set from create_data_elements (option set → data element → dataset chain)

**Files:** `background.js` (`create_data_elements` schema; new `resolveExistingOptionSetRef`; `createStandaloneDataElements` reference resolution; `buildDataElement` reference attach + valueType alignment; DE summary), `manifest.json` (2.6.4 → 2.6.5).

**Goal of this phase:** perfect the ROUTER and the ORCHESTRATION/INTEGRATION of the EXISTING tools for
MULTI-STEP goals — no new user-facing tool. This run targets a DIFFERENT multi-step scenario than the
recent dashboard / org-unit / program-indicator runs: an **option set → data element → dataset chain** —
*"Create an option set 'Malaria RDT Result' (Positive/Negative/Invalid), create an aggregate data element
that uses that option set, and add it to the monthly malaria dataset."* The correct chain is
`manage_option_sets(action=create)` → chain the returned `option_set_id` →
`create_metadata(action=create_data_elements, data_elements:[{ …, option_set_id:<that id> }])` → chain the
new DE id → `manage_datasets(action=add_data_elements, data_element_ids:[<DE id>])`.

**What was reproduced first (the chatbot's own tools, traced end-to-end):** ROUTING was already correct —
tracing the request through `getContextualTools` surfaced `manage_option_sets` (via `wantsOptionSetIntent`),
`create_metadata` + the authoring kit (via `wantsCreateIntent`), `manage_datasets` + `manage_metadata`
(via `wantsDatasetIntent`), and `search_metadata` (always). `buildSystemPrompt` fired `wantsMultiStepGoal`
(create + "then"/"and" + ≥2 distinct build-nouns: option set, data element, dataset), so the orchestration
playbook loaded. The gap was a hard **INTEGRATION** wall, not routing:
- `create_metadata(action=create_data_elements)` could attach an option set ONLY by INLINING a brand-new
  one (`data_elements[].option_set = { name, options:[…] }`). There was **no way to reference an EXISTING
  option set by UID** — so the `option_set_id` returned by the immediately-preceding
  `manage_option_sets(create)` step had nowhere to go. A model following the playbook literally would be
  forced to either (a) re-inline the same options (creating a DUPLICATE option set with different
  codes/UID — data-quality damage), or (b) abandon the tool and hand-roll a raw `dhis2_query` /metadata
  POST (no write-auth gate, no backup, easy to get the DE↔optionSet valueType pairing wrong). The chain
  literally could not be executed cleanly with the chatbot's own tools.

**Gold sequence proven on the playground (stable-2-43-0-1) BEFORE editing:** created option set
*ZZAITEST Malaria RDT Result* (POS/NEG/INV) via `metadata?importMode=VALIDATE&atomicMode=ALL` then `COMMIT`
(0 errors); chained the returned set UID into an AGGREGATE data element (`optionSet:{id:<set>}`, VALIDATE +
COMMIT, 0 errors); read back the DE and confirmed its `optionSet` link resolved to the new set; appended
the DE to the *Child Health* dataset (`BfMAe6Itzgt`) via its `:owner` PUT (dataSetElements 31 → 32). Then
fully reverted (dataset back to 31, DE deleted, option set deleted — cascading its options),
`name:like:ZZAITEST` sweep = 0 residue across optionSets / dataElements / options. This is the exact
dependency-ordered, ID-chaining sequence the chatbot must now produce on its own.

**Fix (purely additive — reference-by-UID support + one prompt worked-chain; no routing/logic change to
existing paths):**
- New `data_elements[].option_set_id` (and `option_set_name`) on `create_data_elements` to attach an
  EXISTING option set, documented as mutually exclusive with the inline `option_set`.
- New async helper `resolveExistingOptionSetRef(id|name)` verifies the referenced set EXISTS (by UID, or by
  exact name → UID, refusing 0-match / ambiguous-multi-match) and returns its `valueType`, so a DE never
  silently points at a non-existent set and the DE↔set valueType pairing is always consistent.
- `createStandaloneDataElements` resolves the reference per-DE (erroring cleanly if BOTH inline and
  reference are supplied), stashing a transient `_optionSetRef` on the DE.
- `buildDataElement` attaches `optionSet:{id}` from `_optionSetRef` (an `else if` after the inline branch)
  and AUTHORITATIVELY aligns the DE `valueType` to the referenced set's own valueType (TEXT/MULTI_TEXT) —
  a mismatch would make the DE unusable. Both are gated on `_optionSetRef`, which is set ONLY on this path.
- The DE result `summary.dataElements[]` now also reports `optionSetId` so the model can confirm the link.
- The multi-step playbook gains `manage_option_sets(create) → option_set_id` and
  `create_metadata(create_data_elements) → summary.dataElements[].id` in its step-4 ID-capture list,
  step-5 explains chaining `option_set_id` into a DE via `option_set_id` (NEVER re-inlining), and a new
  worked chain walks option set → DE (by reference) → dataset add.

**No-regression gate (all verified before commit):**
- **Improvement:** the option set → data element → dataset chain is now executable end-to-end with the
  chatbot's own tools — the `option_set_id` from step 1 flows into the DE in step 2 by reference (no
  duplicate set, no raw-POST fallback), and the DE id flows into the dataset in step 3.
- **Zero collateral:** `buildDataElement`'s valueType change is a ternary whose non-`_optionSetRef` branch
  is byte-identical to the original expression, and the new `optionSet` attach is an `else if` — both fire
  ONLY when `_optionSetRef` is set, which happens ONLY inside `createStandaloneDataElements` for the new
  reference fields. The three OTHER `buildDataElement` callers (program-stage builders) never set it, so
  their output is unchanged. In `createStandaloneDataElements`, for inputs without the new fields both new
  `if`s are skipped and the inline-option-set block runs identically (same guard, just hoisted into
  `hasInlineOptionSet`). The `summary` gains one additive field.
- **No routing change:** `getContextualTools` was NOT touched — every request type surfaces exactly the
  same tools as before (the scenario's tools were already surfaced; the gap was integration).
- **Shared-code callers enumerated:** `buildDataElement` — callers at the program builder,
  add-DE-to-stage, and standalone paths; only the standalone path sets `_optionSetRef`, the rest are
  unchanged. `resolveExistingOptionSetRef` is new and called only from `createStandaloneDataElements`.
- **No safeguard weakened:** `enforcePatientDataPrivacyGate`, `PATIENT_DATA_TOOL_NAMES`, `requireWriteAuth`
  (still gates `create_data_elements`), `verifyTargetExists`, `ensureBackupOrBail`, and the UID-verification
  gates are all untouched. No new tool was added.
- The handler-shaped reference payload (DE with `optionSet:{id:<real existing set>}`, valueType aligned)
  re-VALIDATEs on the live playground with 0 errors (VALIDATE-only, nothing persisted); 0 test residue
  left behind. `node --check` passes on `background.js` and `sidepanel/panel.js`.

## 22. Router + integration — attach a legend set to an indicator (legend set → indicator → dashboard chain)

**Files:** `background.js` (`manage_indicators` schema: new `indicator.legend_set_id` / `legend_set_ids` / `legend_set_name`; new `resolveLegendSetRefs` helper; `createIndicator` legend attach + result surfacing; `manage_indicators` update legend attach/detach; `get` returns `legendSets`; `wantsLegendSetIntent` routing widened; Legend-Sets KB corrected; multi-step playbook + new worked chain), `manifest.json` (2.6.5 → 2.6.6).

**Goal of this phase:** perfect the ROUTER and the ORCHESTRATION/INTEGRATION of the EXISTING tools for
MULTI-STEP goals — no new user-facing tool. This run targets a DIFFERENT multi-step scenario than the
recent dashboard / org-unit / program-indicator / option-set runs: a **legend set → indicator → dashboard
chain** — *"Create an ANC coverage indicator, give it a traffic-light legend (red/amber/green, 0–100), and
add it to a new 'ANC Coverage' dashboard shared with everyone."* The gold-standard chain is
`manage_legend_sets(action=create, auto_bands)` → chain the returned `legend_set_id` →
`manage_indicators(action=create, indicator:{…, legend_set_id})` → chain `indicator_id` →
`manage_dashboards(action=create_dashboard, items:[{new_visualization:{data_items:[indicator_id]}}])` →
`manage_metadata(action=update_sharing, public_access="r-------")`.

**Two gaps found by tracing the request through the chatbot's own tools FIRST:**
1. **ROUTING miss** — `getContextualTools`'s `wantsLegendSetIntent` did NOT fire on natural colour-scale
   phrasings ("give it a **traffic-light** legend", "a **red/amber/green** legend", "a **colour-coded**
   legend", "a **heat-map** legend") because the colour branch required the literal tokens "colour-coded" /
   "colour band/scale/…" / "threshold". So `manage_legend_sets` was never surfaced and the model could not
   create the legend at all.
2. **INTEGRATION gap** — there was NO way to attach a legend set to an indicator with the chatbot's own
   tools. `manage_metadata` has no legend action (only `update_style` = icon/color), yet the Legend-Sets KB
   FALSELY claimed "ATTACHING it to a data element / indicator … is done with manage_metadata". The chain
   was therefore unfinishable: the model could create the set and the indicator but never link them, and
   following the KB it would waste a round on a manage_metadata call that has no such capability (or fall
   back to a raw dhis2_query PATCH the guidance elsewhere forbids).

**Fix (purely additive — reference-by-UID chaining + routing widening + prompt truth-up; mirrors the
option_set_id precedent from entry 21):**
- New `indicator.legend_set_id` (single), `legend_set_ids` (array), `legend_set_name` (exact-name) on
  `manage_indicators` create/update — attach an EXISTING legend set so the indicator renders colour-coded
  everywhere. Chaining-only: the set must already exist.
- New async helper `resolveLegendSetRefs(id, ids, name)` verifies every referenced set EXISTS (by UID, or
  by exact name → UID, refusing 0-match / ambiguous multi-match), de-duplicates, and returns `{ids, names}`
  — so an indicator never silently points at a non-existent legend set.
- `createIndicator` resolves the reference and attaches `legendSets:[{id}]` to the atomic import payload
  (an `if (legendRefs.ids.length)` after the DE-shape build — skipped entirely when no legend ref given);
  the create result now reports `legend_sets[]` / `indicator.legendSetIds` and the success message names the
  attached set, so a multi-step caller confirms the link with no second round.
- `manage_indicators(update)` resolves the reference in the pre-backup VALIDATE block (invalid ref never
  triggers a backup or half-write) and applies `legendSets` in the patch; an explicit `legend_set_ids:[]`
  detaches all. The `get` action now returns `legendSets[]` so the model can read the current link.
- `wantsLegendSetIntent` gains a branch: the word "legend" coupled with an explicit colour-scale signal
  (traffic-light / heat-map / colour-coded / thresholds / a red↔amber/orange/yellow↔green triple). A bare
  "the chart legend" / "hide the map legend" / "move the legend" stays FALSE (verified).
- Legend-Sets KB corrected to state the truth: attach to an indicator via `manage_indicators` `legend_set_id`;
  attach to a DE / visualisation / map layer in the relevant app; NEVER via manage_metadata (no legend
  action) or a raw dhis2_query PATCH.
- Multi-step playbook: `manage_legend_sets(create) → legend_set_id` added to the step-4 ID-capture list,
  step-5 explains chaining `legend_set_id` into an indicator, and a full new worked chain walks
  legend set → indicator → dashboard → sharing.

**No-regression gate (all verified before commit):**
- **Improvement:** the legend set → indicator → dashboard chain is now executable end-to-end with the
  chatbot's own tools — the `legend_set_id` from step 1 flows into the indicator in step 2 in ONE call, and
  the router now surfaces `manage_legend_sets` on natural traffic-light phrasing.
- **Zero collateral (routing):** the new `wantsLegendSetIntent` branch is purely ADDITIVE — it only adds
  `manage_legend_sets` + `search_metadata` to the tool set and removes nothing. 14/14 unit cases pass
  (7 new-true colour-scale phrasings fire; 7 controls — bare chart/map legend, plain indicator/dashboard/
  chart turns — stay false), so no other request type is crowded or mis-routed.
- **Zero collateral (handler):** `resolveLegendSetRefs(undefined,…)` returns `{ids:[],names:[]}` with no
  error and no attach, so an indicator create/update WITHOUT a legend field is byte-identical to before
  (no extra network call is even made on update — gated by `_touchesLegend`). On update, `ownerResp` is
  loaded with `:owner` (which includes `legendSets`), so a name-only update preserves the existing legend.
- **Shared-code callers enumerated:** `resolveLegendSetRefs` is new, called only from `createIndicator` and
  the `manage_indicators` update branch. `createIndicator` is called only from the create branch. No other
  caller touched.
- **No safeguard weakened:** `enforcePatientDataPrivacyGate`, `PATIENT_DATA_TOOL_NAMES`, `requireWriteAuth`
  (still gates `manage_indicators` create/update), `verifyTargetExists`, `ensureBackupOrBail` (still runs
  before the update PUT), and the UID-verification gates are all untouched. No new tool was added.
- The full gold-standard sequence (legend set → indicator with `legendSets:[{id}]` → visualization →
  dashboard → public sharing) was executed on the live 2.43 playground (VALIDATE then COMMIT, 0 errors),
  the indicator was confirmed to carry the legend set, and ALL test objects were deleted (verified 404).
  The handler-shaped attach payload independently re-VALIDATEs with 0 errors and 0 residue. `node --check`
  passes on `background.js` and `sidepanel/panel.js`.

---

## 23. Dashboard data-loss fix — safe `add_items`/`remove_item`/`update`/`delete` on manage_dashboards + destructive-write guard + backups

**Files:** `background.js`, `sidepanel/panel.js`, `manifest.json` (2.6.6 → 2.6.7).

### The disaster this closes

`manage_dashboards` (entry 16) could CREATE dashboards/visualizations but had **no way to add a chart to an EXISTING dashboard**. So "add this visualization to my dashboard" still forced the model down a raw `dhis2_query` PUT `/dashboards/{id}` — and a dashboard PUT is a **whole-object replace**: any dashboardItem not in the body is permanently destroyed (verified on 2.43: a partial PUT silently took a 2-item dashboard to 1, HTTP 200). Dashboards were also not in the backup set, so there was no undo.

### What changed (purely additive to the existing manage_dashboards)

1. **New actions** `add_items`, `remove_item`, `update`, `delete`:
   - `add_items` reads the FULL current dashboard (`?fields=:owner`), appends the new tiles (grid-packed BELOW existing ones on the same 58-col grid), and writes the COMPLETE item set back via `postMetadataPayload` — existing tiles are always preserved. Accepts existing `{ visualization_id }`, inline `{ new_visualization:{…} }` (built with the same `buildVisualizationObject`, so no empty charts), `{ type:"MAP", map_id }`, `{ type:"TEXT", text }`. Verifies every referenced object exists (no broken tiles).
   - `remove_item`/`update` are read-modify-write; `delete` uses importStrategy=DELETE.
   - **All four snapshot the dashboard to backups BEFORE writing** (`ensureBackupOrBail`), so every change is reversible via `manage_backups`.
2. **Destructive-write guard** in the `dhis2_query` handler: raw `PUT`/`PATCH dashboards/{id}`, `POST /metadata` with a `dashboards[]` entry that has an existing id + `dashboardItems`, and raw `POST .../items` are refused and redirected to `manage_dashboards`. The append endpoint, item-level ops, and GETs are untouched.
3. **Backup coverage**: `SNAPSHOT_FIELDS.dashboards` (full dashboardItems + all content refs) and `dashboards/visualizations/maps/eventCharts/eventReports/eventVisualizations/charts/reportTables` added to `backupableTypes`. Restore rebuilds a wiped dashboard exactly.
4. **Cross-version (2.34 → 2.43+ with pre-2.34 fallback)**: `resolveAnalyticsFavorite` probes `visualizations`→`charts`→`reportTables` so `add_items` references the object under whatever endpoint the server actually uses; `getDhis2MinorVersion` is available for version branching. (The remote's `create_visualization` already targets `visualizations`, correct for 2.34+.)
5. **Wiring**: action enum + `item_id`/`skip_backup` params + description updated; system-prompt dashboard KB block gained `add_items`/`remove_item`/`update`/`delete` guidance and an example; `sidepanel/panel.js` detail branch gained `item_id`.

**Scope / no-regression:** the existing `list`/`get`/`create_visualization`/`create_dashboard` actions are byte-for-byte unchanged (regression-tested); this only ADDS actions + a guard + backup coverage. No other tool changes behavior. Confirmed the remote's `create_visualization` field-shape finding (a viz set only via `columns`/`rows`/`filters` reads back with empty `columnDimensions`/`organisationUnits`) and kept their correct builder rather than my earlier columns/rows/filters approach.

**Verification:**
- `node --check` on both JS files; `manifest.json` valid.
- Merged-logic tests 19/19 (add_items preserves all existing items + backs up + posts the full set; inline-viz build has `columnDimensions`/`userOrganisationUnit`; missing-ref refusal; pre-2.34 CHART fallback; remove_item; delete snapshot; **create_visualization regression guard**). Guard-classification 9/9.
- **Live 2.43 playground:** full `add_items` operation (POST /metadata with the new viz + the full appended dashboard) 1→2 items, both tiles present, appended viz reads back with `columnDimensions:["dx"]` + `userOrganisationUnit:true` (renderable, not empty). Partial-PUT data loss reproduced (2→1). All ZZAITEST objects deleted; residue sweep returned 0 for visualizations and dashboards.

---

## 24. End-to-end audit fixes: option-theft corruption, unusable default sharing, responsive custom forms, A{} resolution, ASSIGN option codes, write-auth verbs, search ranking

**Files:** `background.js`, `README.md`, `manifest.json` (2.6.7 → 2.6.8). The WHO-ANC-DAK program was built end-to-end on play 2.42.5.1 through the real tool layer.

1. **CRITICAL — cross-set option theft removed** (`create_metadata` post-build dedup). Options were deduplicated against the server **globally by name** and the new option set referenced the existing option's UID. A DHIS2 Option belongs to exactly ONE optionSet (FK), so the import silently **re-parented** the option — ripping "None"/"Negative"/"Live birth"/… out of whatever unrelated set owned them, with no backup. Reproduced live: a new set referencing existing "None"+"Mild" stole both from another set. Options are now NEVER reused across sets; every new set gets its own option rows with `deriveOptionCode` codes. (CategoryOption reuse is untouched — genuinely many-to-many.)
2. **Programs are born usable** (`create_program`): a sharing block is now built even when the model passes no `sharing` argument — public `rwrw----` on program + stages (data-shareable classes), metadata-only bits cascaded to DE/OS/TEA/PI as before. Previously the server default `rw------` meant even the creating admin could not enroll/save (E1091/E1095/E1096) until a manual `update_sharing`.
3. **Custom-form generator produces a responsive, styled layout** (`buildCustomFormHtml`): max-width 920px centered wrapper, `width:100%` fixed-layout table with a 40/60 colgroup, section cards with an accent header, zebra rows, per-row optional hints, and `width:100%;max-width:430px;box-sizing:border-box` inputs. Fixes the "sometimes too narrow, sometimes too wide" width complaint at the root: the old bare `<table border=1>` hugged content in wide containers and reflowed when validation messages appeared. All styles inline (no `<style>` block — the aggregate Data Entry app injects htmlCode into an existing DOM). Rendered layout verified in Capture 2.42 view AND edit modes.
4. **Capture-cache truth in `set_stage_form` hints**: Capture keeps program metadata in IndexedDB — a form saved after Capture loaded does NOT appear until a hard refresh; and current Capture renders custom stage forms on view/edit of an existing event, NOT in the "New event" flow. Both were verified live and are now stated in `_hints` so the model tells the user instead of mis-diagnosing a save failure.
5. **`A{name}` program-rule refs resolve against supplied/existing variables** (`_buildAndPostProgramRules`): the tool's own error hint said "pass variables:[]" but the A{} branch never consulted them (only TEA displayName/UID), so TEI_ATTRIBUTE variables passed exactly as instructed were refused. A{} now resolves: UID → existing PRV name → supplied variables:[] entry (creating the PRV) → TEA displayName rewrite → unresolved.
6. **ASSIGN to an option-set DE is code-checked** (new pre-POST pass): the 2.42+ server rule engine validates assigned values against option CODES (E1125 on every event save otherwise — reproduced live when a rule assigned 'Moderate' to a set whose code was MODERATE). Quoted ASSIGN literals are now verified: exact code passes, an option NAME is auto-mapped to its code, anything else is refused with the valid-codes list.
7. **Write-auth verb gaps closed** (`WRITE_AUTH_BROAD_RE`): "Set a custom form…" was read_only (and the stage name "Quick Check" matched the *diagnostic* regex). Added configure/install/uninstall/author/generate/translate/relabel/restore/revert/rollback/undo/link/unlink, plus imperative-only `set …`/`apply …` (followed by article/pronoun) so problem reports ("the save failed", "nothing is set", "the rule doesn't apply") still classify read_only — regression-tested both directions.
8. **`search_metadata` honors `query`/`name`/`search` aliases and ranks exact matches first.** Previously `query` was silently ignored → the FULL collection came back and the first row was arbitrary; observed steering a delete toward the wrong program (DHIS2's 409 reference check + auto-backup caught it). Exact displayName match now sorts first, then prefix matches.
9. **README corrected**: tool count 25 → 31 (table now lists all six newer tools), "23-tool agentic loop" → 31.

**Verification:** 20/20 live post-fix regression checks on play 2.42.5.1 through the real `executeTool` layer (write-auth classifications ×4, option-set isolation ×3, default sharing ×2, A{}+ASSIGN rules ×3, generator markup ×3, hints ×1, search ×2, cleanup ×1 — plus the earlier 19-check safeguard suite: privacy gate incl. `.csv`/`.json` bypass attempts, read-only refusals, destructive-404 breaker, dashboard delete→backup→restore round-trip with all 6 items back). All QA test objects deleted from the playground. `node --check background.js` passes.

---

## 25. Second end-to-end audit (WHO TB case surveillance, play 2.43.0.1): program-rule action & condition binding, PI OR-filter linter, write-auth "design", create_program chaining IDs, new `manage_maps` tool, SQL-view privacy hardening

**Files:** `background.js`, `sidepanel/panel.js`, `README.md`, `manifest.json` (2.6.8 → 2.7.0). A complete WHO-TB-DAK-aligned tracker program — 5 stages, 31 data elements, 3 attributes, 16 option sets, 9 program rules, 9 program indicators, 2 custom forms, a legend set, a thematic map and a dashboard — was built **end-to-end through the real tool layer** against `https://play.im.dhis2.org/stable-2-43-0-1`, every failure root-caused and reproduced live, fixed, and regression-tested.

1. **HIGH — `manage_program_rules` now binds action targets given by NAME** (`_buildAndPostProgramRules` action builder + new `resolveActionDeEntry`/`resolveActionTeaEntry`; and the `update` path via new `resolveRuleActionTargetNames`). The action builder only honored `data_element_id` (a UID); `data_element_name`/`tracked_entity_attribute_name` — the schema's advertised "resolved to ID automatically" fields, which the sibling `create_metadata` rule path already resolves — were silently ignored. Result: **every ASSIGN / SETMANDATORYFIELD / HIDEFIELD written by name failed DHIS2 validation** ("DataElement or TrackedEntityAttribute cannot be null") and SHOWWARNING/SHOWERROR lost their field anchor. Reproduced live: a 9-rule create bounced with 9 validation errors; the same rules by UID committed. Now names resolve (exact displayName → sanitized), a supplied-but-unresolvable name fails loudly with `unresolved[]`+suggestions, and `pickSourceType` also sees name-targeted actions so a same-stage target correctly yields `DATAELEMENT_CURRENT_EVENT`.

2. **HIGH — option-set rule CONDITIONS written with option NAMES are rewritten to CODES** (new block in `_buildAndPostProgramRules`, after the ASSIGN code check). Auto-created option-set PRVs use `useCodeForOptionSet=true`, so the rule engine compares the option **code** — matching the DHIS2 demo DB's own rules (`#{CaseClassifiedAs} != 'IMPORTED'`). A condition comparing such a variable to an option **name** (`… == 'Positive'`) lints clean, SAVES, and then **never fires** — a silent failure. The tool already mapped ASSIGN *data* names→codes; it now does the same for conditions: `#{optvar} ==|!= 'name'` → the option's code, per OR-term, leaving `''` and already-code literals untouched (strictly an improvement — cannot break an already-correct condition). Confirmed live: HIV `'Positive'`→`'POSITIVE'`, Xpert `'MTB detected, RIF resistant'`→`'MTB_DETECTED_RIF_RESISTANT'`, outcome `'Died'`→`'DIED'`. Non-matching non-empty literals surface a `condition_option_advisories[]` note.

3. **HIGH — PI filter linter no longer rejects valid `||` "field in set" filters** (`lintProgramIndicatorExpression`, filter branch). The same-field-equality check counted `#{X} == 'A'` occurrences across the WHOLE filter and blocked any repeat — but `#{X} == 'A' || #{X} == 'B'` is the normal, correct way to match one of several option codes (RR/MDR profiles, treatment-outcome cohorts). It now evaluates **per OR-term** (split on `||`): within one conjunction a field can equal only one literal (still blocked — non-regression verified), across OR-terms it can equal any (now allowed). Reproduced live: "RR/MDR-TB cases" and "Treatment success" indicators were blocked pre-fix, commit post-fix; the impossible `&& 'A' && 'B'` case still blocks.

4. **MEDIUM — write-auth recognizes form/layout authoring verbs** (`WRITE_AUTH_BROAD_RE`). "**Design** a custom form for this stage" — the custom-forms tool's OWN documented trigger phrase — was classified `read_only` and the write refused. Added `design`/`customize`/`style`/`lay out` (constrained to imperative form, followed by an article/pronoun) and unconstrained `redesign`, so authoring authorizes while problem reports ("the form design is broken", "why is the style wrong") stay read_only. 7/7 classification cases pass.

5. **MEDIUM — `create_metadata(create_program)` exposes top-level chaining IDs.** The result nested everything under `summary.program.id` / `summary.stages[]` with no top-level handle, so the next step of a "create program → add rules/indicators → build dashboard/map" chain had to dig into nested shapes. It now returns top-level `program_id`, `stage_ids` (name→id), `data_element_ids`, `tracked_entity_attribute_ids`, `option_set_ids` — mirroring the id exposure `manage_program_indicators`/`manage_dashboards`/`manage_maps` already provide, so the model reuses REAL UIDs instead of inventing them.

6. **NEW TOOL — `manage_maps`** (thematic map authoring). The extension could embed an existing map on a dashboard but had **no way to create one** (only `get_map_details` read). `manage_maps` (list/get/create/delete) assembles a thematic choropleth/bubble layer — data item on the mapView's `columns[dx]` (type auto-resolved + program auto-attached for a PI), org units on `rows[ou]` with `organisationUnitLevels`, period on `filters[pe]`, optional legend set — mirroring the exact `/api/maps` structure proven live. Reuses the full safety stack (write-auth gate, knownIds preflight, `verifyTargetExists`, `ensureBackupOrBail` on delete). Wired through `TOOLS` → `TOOL_ROUTER` → `executeTool` → `getContextualTools` (map/dashboard intent + Maps app, stripped in read-only save-diagnosis, added to `writeCapableNames`) → `panel.js` icon/label/detail. Tool count 31 → 32.

7. **SECURITY — hard privacy gate now covers SQL-view EXECUTION** (`pathReadsPatientData`). A saved SQL view can `SELECT` arbitrary columns — including patient identifiers — from any table (trackedentityinstance, event, enrollment, trackedentityattributevalue). Executing one (`sqlViews/{id}/data`, `/execute`) on a remote model could exfiltrate row-level tracker data past the endpoint checks. The torture-test bypass probe confirmed it was NOT gated. Now the execution sub-endpoints are gated (fail closed; view DEFINITION reads stay allowed) on remote providers, lifting only on a local model like every other patient-data path.

**Verification (all live on play 2.43.0.1 through the real `executeTool` layer):**
- Full TB build committed with **zero errors** after fixes: program+stages+DEs+attrs+option sets (1 atomic bundle, 73+ objects), 9 rules (0 target-less actions, all conditions on codes), 9 program indicators (all server-validated via `/programIndicators/expression|filter/description`), 2 responsive custom forms (formType=CUSTOM, all four width guards present), legend set, thematic map (tool-created, program auto-attached), dashboard (text+5 viz+map).
- Program rules proven **firing server-side**: a synthetic 16-patient tracker import triggered E1301 (SETMANDATORYFIELD) + E1307 (ASSIGN) before the data was made rule-consistent; the ASSIGN rules then set basis-of-diagnosis / DR-profile on import.
- Custom-form width verified visually at 360 / 720 / 1240 px container widths: fills a narrow card (no shrink-to-content), caps at 920px centered in a wide card (no edge-to-edge stretch), inputs capped at 430px — the "too narrow / too wide" complaint resolved across the range.
- **Safeguards: 33/33** — privacy gate blocks 16 patient-read vectors incl. `.json`/`.csv`/`.geojson` suffixes, legacy endpoints, `analytics/events|enrollments/query`, tracker WRITEs, `get_event_analytics(query)`, `detect_enrollment_abnormalities`, **and now sqlView execution**; allows de-identified aggregates + metadata + sqlView definitions; lifts on a local model. Write-auth refuses writes on problem-report turns; knownIds preflight refuses unseen UIDs; verify-before-modify handles missing targets safely; `manage_maps` delete→backup→restore round-trip restored the map intact; misroute guards (raw sharing POST, `dataStore/capture` write) hold.
- Regression: 32 tools registered; existing tools unaffected; `node --check background.js` and `node --check sidepanel/panel.js` pass. All ZZ/QA test objects deleted; the "TB Case Surveillance (AI QA)" reference build left on the instance (resets nightly), matching the ANC precedent.

> Environmental note: this playground instance's **analytics tables were unavailable** during the audit (even the demo Child Programme returned 42P01 "referenced table does not exist"; a triggered rebuild ran but produced no queryable tables — a shared-server issue, not the extension's). Program-indicator LOGIC was therefore verified via the server-side `/description` endpoints (9/9 valid) rather than live aggregates; the dashboard/map tiles are structurally correct and populate once analytics is healthy.

---

## 26. Lazy tool manuals — two-tier tool docs (–42% per-iteration context) + inline program-rule variable resolution fix

**Files:** `background.js`, `manifest.json` (2.7.0 → 2.8.0), `CHANGES_lazy_tool_manuals.md` (full design doc).

**Problem:** every LLM iteration carried the FULL how-to documentation for every contextual tool — ~14k tokens of tool definitions + ~8k of system-prompt KB blocks on a typical authoring turn — before the model had decided which tools to use. Re-sent on every loop iteration (5–30 per authoring turn), no prompt caching.

1. **Two-tier tool docs** (`MANUAL_TOOLS`, `TOOL_SUMMARIES`, `toWireTools`/`slimSchema`, `buildToolManual`, `buildManualGateResult`, `MANUAL_EXTRAS` + shared `KB_PROGRAM_RULE_SYNTAX`/`KB_PI_GRAMMAR`/`KB_VALUE_TYPE_MAPPING` blocks). The 16 write-capable tools go on the wire as SLIM definitions — hand-written routing description (incl. all "NEVER via dhis2_query" invariants) + schema with types/enums/required intact, prose truncated, nested shapes collapsed to field-name lists (`action` enum docs kept in full). The FULL manual (original description — `TOOLS` stays the single source of truth — + relocated KB text + complete parameter reference) is delivered as the result of the FIRST call to that tool each turn; that call does not execute; the model re-issues and it runs. Deterministic guarantee preserved: a write tool never executes before the model has read its complete instructions. Read tools + manage_backups unchanged on the wire. New RULE 16 explains the gate; `stubToolContentForHistory` keeps delivered manuals out of persisted history (~170-char marker; the gate re-delivers next turn).
2. **buildSystemPrompt slimmed to decide-time cores**: the 10 per-tool KB blocks (datasets, validation rules, org units, aggregate indicators, option sets, legend sets, dashboards, custom forms, translations, growth chart) + the metadata-mgmt/icon/sharing/notifications sections became 2–5-line routing stubs preserving every disambiguation and safety invariant; the Meta-Architect Protocol kept its ONE-CALL/workflow/routing core (~450 tokens, was ~4,700) with payload details, error recovery, value-type mapping, rule syntax and PI grammar moved into the relevant manuals. Cross-cutting sections (RULES, Verify-before-call, Auto-Backup Contract, Quick-Reference, Multi-step goals, Tracker Write Protocol) untouched.
3. **Measured** (target scenario, Maintenance app, "create tracker program + custom form + rules"): per-iteration payload 22,128 → 12,740 tokens (system prompt 8,052 → 3,628; tools 14,076 → 9,111). Cost: one extra iteration per gated tool actually used per turn — pays for itself within one iteration of savings. An LLM intent-router pass and intent-based manual pre-delivery were considered and rejected (adds cost/latency to every turn; re-inflates the context — the deterministic regex router already does the routing).
4. **HIGH (pre-existing, exposed by the E2E) — inline program-rule variables now resolve or refuse** (shared `resolveRuleTokenBindings`; both `create_program` inline rules and `add_program_rules`). Previously `#{token}` refs resolved against DE/TEA sanitized names by EXACT match only and silently dropped otherwise: `#{muac} >= 11.5` against DE "MUAC in cm" imported fine and NEVER fired (no PRV; the rule engine rejects the expression at runtime — reproduced live, flagged by audit). Now: tokens in condition + action `data` resolve exact-then-unique-prefix, the PRV is created under the token name bound to the matched DE/TEA; `add_program_rules` also honors existing PRV names (no collisions); ambiguous/unmatched tokens REFUSE the whole import pre-POST with `unresolved[]` + available names — mirroring `manage_program_rules`'s contract.
5. **Security unchanged by construction**: write-auth gate, knownIds preflight, privacy gate, backups, bulk-delete confirmations, save-diagnosis read-only mode all untouched and see the same calls (the manual gate runs before preflight and makes no API call; it can only withhold execution, never grant it). Live-verified during testing: privacy gate + unknown-UID preflight refused exactly as before.

**Verification (live on play 2.43.0.1, real `runAgenticLoop` with Fireworks kimi-k2p6):** full one-turn E2E of the target scenario — 32s, 5 tool calls, 2 manual deliveries, **0 failed calls**; program + 2 TEAs (existing demo TEAs reused) + 3-DE stage + OU + `rwrw----` + custom stage form (3 bound inputs) + 2 rules with auto-created `muac_in_cm` PRV; `manage_program_rules(action=audit)` **0/0 issues**. Multi-turn: turn-1 manual stubbed in history, gate re-fired turn 2, SETMANDATORYFIELD rule + `age_in_months` PRV created, audit clean. PRV fix proven 4 ways (fuzzy bind + refusal × create/add paths; refusals imported NOTHING). Read-only turns unaffected. `node --check` passes both files; 32 tools registered; all 16 manuals build. All test objects cleaned from the playground.

---

## 27. Repeated-failure guard, budget-exhaustion summary, liveness heartbeat + stream stall guard (v2.8.1)

**Files:** `background.js`, `sidepanel/panel.js`, `manifest.json`
**Full write-up:** `CHANGES_retry_guard_liveness.md`

**Type of change:** New safety rail (agentic loop) + robustness fixes (streaming/panel watchdog)

**Incident (2026-07-06, MCH tracker build):** `manage_program_indicators(create)` was rejected by
DHIS2's expression validator and the model re-sent the IDENTICAL call ~48 times until the
50-iteration budget died with *"Reached maximum iterations."* Root cause: the validator returns
**HTTP 200 + `{status:"ERROR"}`**, so the existing 4xx/5xx brake (`noteHttpErrorFromResult`)
never fired — nothing blocked HTTP-200 failures. A second incident: the panel's 90s watchdog
declared *"assistant stopped responding"* during a long tool-argument generation (tool-call SSE
deltas broadcast no life signals), then the run visibly resumed.

**What changed:**

1. **Per-turn repeated-failure guard** (`noteToolFailure`, `repeatedFailureStopOrNull`, wired
   into `preflightCheckCall` + the post-flight section of the loop): every failed call (any
   `_error`/`success:false`, regardless of HTTP status) is recorded by a stable signature of
   (tool, args) and by (tool:action, normalized-error-family). Identical failing calls are
   refused from the 2nd attempt (3rd for transient errors); hints escalate from the 2nd
   same-family failure; the operation is hard-blocked for the turn after 4 same-family
   failures with instructions to give the user a final answer. A success by ANY other call
   re-allows one identical retry (prerequisite-fixed workflow). Blocked calls never reach the
   network.
2. **Budget-exhaustion summary** (end of `_runAgenticLoopInner`): on iteration-budget
   exhaustion the loop makes one final TOOL-FREE provider call that streams a real summary
   (what succeeded with IDs / what failed with exact errors / next step) instead of returning
   the dead-end "Reached maximum iterations" string (now only a last-resort fallback).
3. **Liveness heartbeat**: the keepalive interval now broadcasts `AI_HEARTBEAT` every 20s
   while a task runs; `AGENT_STATUS` runtime message returns `{alive, busy}`; both SSE parsers
   broadcast `Composing action… (~N tokens)` every 80 tool-arg deltas.
4. **Stream stall guard** (`readSseChunkWithStallGuard`): 120s of zero bytes mid-stream
   aborts the read instead of hanging forever; the loop transparently retries a stalled
   iteration up to 2× when nothing has streamed to the panel yet.
5. **Panel watchdog** (`sidepanel/panel.js`): `AI_HEARTBEAT` is a life signal; on timeout the
   watchdog first probes `AGENT_STATUS` — alive+busy re-arms silently; only a dead or
   restarted-idle worker surfaces the (reworded) error.

**Verification:** 27 unit checks on the extracted guard; 15-check E2E replaying the disaster
through the REAL `runAgenticLoop` against playground stable-2-43-0-1 (1 real execution instead
of ~48, streamed final summary); 8-check happy-path E2E (valid create unhindered, normal end,
probe answers, playground cleaned). `node --check` passes on both files.

**Scope of impact:** No tool logic changed. Successful calls and legitimate fix-then-retry
flows are unaffected (proven by the happy-path E2E + success-bypass unit checks). The guard
only refuses calls that repeat a recorded failure.

## 28. MCH-scenario fixes: stage-by-name rule actions, no phantom IDs after failed create, option-code PRVs + name→code literal mapping, empty-field numeric guards, PI name auto-disambiguation, verify actually reads rules (v2.8.2)

**Files:** `background.js`, `manifest.json`
**Type of change:** Bug fixes (tool-call reliability + program-rule correctness) + manual/KB updates

**Incident (2026-07-06, user's MCH tracker build on play stable-2-40-12):** two failed tool
calls during one build, plus three program-rule defects that survived a "verified" program:
(a) `create_program` bounced with *"ProgramRuleAction: ProgramStage cannot be null"* because
Rule 4's HIDE-STAGE action had no stage reference — the schema only accepted
`program_stage_id`, which cannot exist yet during create_program (stage UIDs are generated
client-side inside the very same call); (b) the failed create's response still exposed
`program_id`/`stage_ids` handles, so the model called `add_program_rules` against phantom
program `OuyEAzGOp5i` → 404; (c) Stage 2's infant fields (Infant Birth Weight, APGAR,
Neonatal Resuscitation) never showed even with outcome = *Live Birth* — the auto-created
`delivery_outcome` PRV had `useCodeForOptionSet:false` (yields the option **name**) while
the condition compared the **code** `'LIVE_BIRTH'`, so the hide-condition was always true
(NOT a custom-form limitation — verified live in Capture 2.40); (d) *Gestational Age* looked
broken while EDD worked — `V{event_date}` is empty until the user fills the Report date, so
`d2:weeksBetween(#{lmp}, V{event_date})` correctly fills only after that (EDD depends only on
LMP); (e) the APGAR `< 7` warning fired on a blank form (empty numeric coerces to 0).

**What changed:**

1. **Stage references by NAME in rule actions** — new `program_stage_name` param (schemas of
   `create_metadata` rules + `manage_program_rules` actions). `createFullProgram` resolves it
   against the stage names of the same call (original + collision-suffixed); `addProgramRules`
   and `_buildAndPostProgramRules` resolve against the program's stage displayNames; a stage
   name passed in `program_stage_id` also resolves. HIDEPROGRAMSTAGE/CREATEEVENT actions with
   no resolvable stage now fail at the pre-flight lint (with `valid_stage_names` /
   `valid_stages`) instead of bouncing the whole atomic import server-side. HIDESECTION inside
   create_program (no sections exist) is also refused with guidance.
2. **No phantom IDs after a failed create** — `createFullProgram` returns
   `program_id`/`stage_ids`/`data_element_ids`/… ONLY on success; failures now carry
   `nothing_created:true` plus an explicit "atomic import — nothing exists, re-issue
   create_program, do NOT call add_program_rules" hint. `addProgramRules`' 404 hint explains
   the failed-create-id case. KB_CREATE_PROGRAM_DETAILS states the same rule.
3. **Option-set PRVs resolve CODES everywhere** — `createFullProgram.pushDePrv` and
   `addProgramRules.pushDePrv` now set `useCodeForOptionSet:true` for option-set DEs (the
   manage_program_rules path already did). New shared `rewriteOptionLiteralsGeneric()` maps
   option **name** literals in conditions and ASSIGN data to their codes (reported as
   `condition_option_rewrites`) and flags literals matching neither name nor code
   (`condition_option_advisories`) in BOTH legacy paths; reused (pre-existing) option sets are
   fetched from the server so their real codes are used. `addProgramRules` also covers
   EXISTING option-backed PRVs: code-resolving ones join the rewrite; a name-resolving one
   compared to a literal is flagged.
4. **Empty-field numeric guard** — new `autoGuardNumericComparisons()` wraps bare
   `#{x} < n` / `<= n` atoms as `(d2:hasValue(#{x}) && #{x} < n)` in all three rule-creation
   paths (compositional under `&&`/`||`; conditions containing negation or an existing
   d2:hasValue guard for that variable are never touched). Reported as
   `auto_guarded_conditions`.
5. **Program-indicator NAME auto-disambiguation** — PI names are globally unique; re-running
   a scenario whose PI names already exist (even on another program) failed the create. Both
   `_buildAndPostProgramIndicator` (create) and createFullProgram's PI follow-up now probe
   name collisions and auto-suffix with the program short name (or UID shard), mirroring the
   stage-name convention; renames are reported (`name_auto_disambiguated` /
   `_indicator_renames`).
6. **`architect_metadata(verify)` actually reads rules** — `programs/{id}?fields=programRules[...]`
   returns an EMPTY collection on 2.40 even when rules exist (verified live), so verify was
   silently skipping every rule check ("1/1 verified" on a broken program). Rules + PRVs are
   now fetched via `programRules?filter=program.id:eq:` / `programRuleVariables?filter=…`.
   New `rule_advisories` + `integrity_checks.rule_quality_ok`: flags option-set PRVs with
   `useCodeForOptionSet:false` compared to quoted literals, and notes the HIDEPROGRAMSTAGE
   Capture-web semantics.
7. **KB/manual updates** (delivered via the two-tier manual gate):
   - HIDEPROGRAMSTAGE: use `program_stage_name` in create_program; in the NEW Capture web app
     it only disables adding events (stage card stays visible, button tooltip "You can't add
     any more … events") — legacy Tracker Capture/Android hide the stage tab; tell the user.
   - `V{event_date}` is empty until the Report date is filled — calculated fields appear then;
     explain instead of "fixing" the rule.
   - Custom forms × hide/show (KB_CUSTOM_FORMS_DETAILS): rules KEEP WORKING in custom stage
     forms (inputs unmount/remount dynamically, ASSIGN fills, warnings render inline), but the
     custom-HTML label row remains visible when its input is hidden (orphan label; default
     section forms hide the whole row) — proactively explain this trade-off to the user; do
     NOT claim hide/show is impossible with custom forms and do NOT script hiding in HTML.
   - Option-set bullet: codes are UPPER_SNAKE of the option name; auto-rewrites/advisories.

**DHIS2 quirks discovered (play stable-2-40-12, verified live in Capture 2.40 via browser):**
- Custom stage forms render fully in the new Capture app; HIDEFIELD removes/re-adds the input
  in place (label cell remains — a `<div>` mount point stays in the DOM, too fragile to
  target with CSS `:empty` tricks, so no auto-collapse is generated).
- HIDEPROGRAMSTAGE in new Capture = "can't add new events" (disabled + tooltip), card visible.
- `programs/{id}?fields=programRules[...]` → empty collection even when rules exist;
  `programRuleVariables[...]` as program fields works. Always use the filtered endpoints.
- Rule engine coerces empty numeric fields to 0 (`#{empty} < 7` is true); empty option-set
  values compared with `!=` are true (fields stay hidden until the trigger is chosen).
- Event status transition ACTIVE→SCHEDULE is refused (E1316).

**Verification:** 25-check harness suite (`executeTool` against play 2.40.12): pure-helper
units (guards, literal rewrite), original failure shape now a clean lint (no server call, no
leaked IDs), full MCH create with stage-by-name + name literals + bare `<` (all corrected
server-side: `useCodeForOptionSet:true`, `!= 'LIVE_BIRTH'`, stage resolved, condition
guarded), add_program_rules to existing program (existing-PRV literal rewrite), phantom-id
hint, verify advisories — ALL PASSED. Then a full-loop E2E with a real LLM
(Fireworks kimi-k2p6) running the user's complete MCH prompt (custom forms + hide/show kept):
**zero failed tool calls** (vs 2 in the incident + 3 PI name collisions in the first E2E run),
5 rules + 3 custom forms + 3 PIs created correctly, final answer explains the hide/show
behaviors to the user. Browser-verified on the user's own program: EDD + GA fill correctly
once Report date set; with the PRV fixed, selecting *Live Birth* shows the 3 infant inputs in
the custom form and *Stillbirth* re-hides them. All test metadata deleted from the playground.
`node --check` passes.

**Scope of impact:** create_program embedded rules, add_program_rules, manage_program_rules
create, manage_program_indicators create, architect verify, KB text. No wire-schema removals —
only additive params and result fields; existing correct calls behave identically (name→code
rewrite only ever converts a NAME literal to its CODE; guards skip negated/guarded conditions).

---

## 29. New-thread history & context reset — starting a new thread no longer continues the old task (v2.8.3)

**Files:** `background.js`, `sidepanel/panel.js`, `manifest.json`
**Detailed write-up:** `CHANGES_new_thread_reset.md`

**Type of change:** Bug fix (behavior) — critical

**The bug:** Opening a new thread (fresh side panel, possibly on a different DHIS2
server) did not erase the previous conversation. The model silently continued the
old task. Reproduction: create a tracker program on server A → open a completely
new panel/thread → ask to "complete a task" → the model resumes the old
tracker-program task from server A.

**Root cause:** The model's memory (`conversationHistory`) is persisted to
`chrome.storage.session` (`chatHistory`), which is scoped to the browser profile
and survives panel close/reopen, other windows, and service-worker restarts. But
the side panel never renders prior messages on load — a fresh panel always shows
the empty welcome screen, so it *looked* like a new thread while the background
still held the full old conversation. History was only cleared when the user
clicked "+", and even that left task-specific cached context
(`programMetadata`, `ouContext`, `visualizationContext`, `mapContext`,
`pageContext`, `lastFacilityOu`, `datasetContext`) intact.

**The fix (4 parts):**
1. `CLEAR_HISTORY` is now a full new-thread reset via `clearConversationState()`:
   wipes `conversationHistory`, `prefetchedIds`, `lastUserText`, and the
   task-specific `dhis2.*` caches (keeping the connection identity so reconnect is
   instant; the caches are re-fetched fresh by `initializeFromUrl` on the next
   init — "context fetched again").
2. `sidepanel/panel.js` `init()` sends `CLEAR_HISTORY` (awaited) **before**
   connecting, so every fresh panel = a new thread, and the fresh `INITIALIZE`
   re-fetches context cleanly.
3. Restoration race guard: a module-level `historyExplicitlyCleared` flag makes
   the cold-start restoration IIFE bail entirely if a reset raced it, so the old
   thread can't be resurrected on top of the cleared one. (Flag resets each cold
   start, so a genuine SW-restart mid-task still restores the *current* thread.)
4. Epoch guard: `conversationEpoch` is bumped on each reset; the agentic loop
   snapshots it at turn start and drops the turn at all four persistence sites if
   the epoch changed — so a straggling turn from the old thread (panel reopened /
   "+" clicked mid-generation) can't re-seed the new thread.

**Scope of impact:** New-thread lifecycle only. Normal in-thread multi-turn
conversation is unchanged (same-epoch turns persist as before); SW-restart
mid-task still restores the active thread. The connection to DHIS2 is preserved
across a reset — only conversational memory + task-specific context caches are
cleared.

**Verification:** `node --check` passes on both files. Standalone logic
simulation of both guards (restoration race + epoch drop) plus the
legitimate-restore and normal-turn paths — all assertions pass: old
conversation/context not resurrected after a racing reset; legitimate restore
still works when no reset raced; stale turn dropped and new thread stays empty;
normal turn still persists.

---

## 30. Fresh-instance creation no longer hits the guard walls — field names ≠ UIDs, consecutive HTTP-error stop, root OU on empty instance (v2.8.4)

**Files:** `background.js`, `manifest.json`
**Detailed write-up:** `CHANGES_fresh_instance_create.md`

**Type of change:** Bug fix (3 root causes) + small capability addition

**The report:** On a brand-new instance with zero metadata, asking the assistant to
create an OU hierarchy + tracked entity type + attributes "hit the wall" and it gave
up half-done. The anti-hallucination rule (no API calls for UIDs never seen in a
verified source) must stay, but a fresh instance where the user explicitly wants to
CREATE must not be blocked.

**Root causes (each verified live against the user's instance, 2.42.5.1):**

1. **Field names mistaken for hallucinated UIDs.** `DHIS_UID_RE` matches any 11-char
   alphanumeric token, and `extractUidsFromCallArgs` scanned the whole `path` including
   the `fields=id,displayName` query list. `displayName`/`lastUpdated` are 11-char
   camelCase, so every discovery call requesting them was refused with
   `unknown_uid_in_args` — fatal, since a fresh instance must run discovery.
   → `extractUidsFromCallArgs` now scans only the path **before `?`** and filters
   candidates through a new `RESERVED_UID_SHAPED_WORDS` denylist. Path-segment UIDs
   (`/programs/<uid>`) and explicit `*_id` args are still validated — guard intact.

2. **HTTP-error stop was cumulative, not consecutive.** The comment says "3 consecutive
   4xx," but the counter only reset at turn start. A legitimate build interleaves
   recoverable 409s with successful creates; the cumulative count hit 3 mid-build (after
   4 OUs + the TET were already created) and hard-stopped.
   → On every successful tool call the loop now resets `httpErrorCount`/`httpErrorHistory`.
   The identical-call and same-error-family guards still bound genuine retry loops.

3. **`manage_org_units` refused to create a root.** `createOrgUnit` hard-required
   `parent_id`, so on an empty instance the proper tool was unusable and the model fell
   back to raw metadata POSTs (into the E5002 parent-by-name wall).
   → When no `parent_id` is given, `createOrgUnit` checks the live OU count: if **zero**,
   it creates the first (root) OU (level 1, no parent); if any OU exists the old refusal
   stands (a 2nd root splits the hierarchy) with a clearer hint. Tool description + KB +
   TOOL_SUMMARIES updated to teach the fresh-instance top-down flow.

**DHIS2 quirks confirmed live and documented (code comments + write-up):** the metadata
importer resolves `parent` by **UID/code, never by name** (parent-by-name → E5002), so a
hierarchy must use pre-generated UIDs + `parent:{id}` in ONE payload; an option set imports
with its options in ONE payload when both carry UIDs and cross-reference; `trackedEntityType`
requires `shortName` on 2.42 (E4000).

**Scope of impact:** `extractUidsFromCallArgs` (pre-flight UID guard — now fewer false
refusals for ALL tools), the dispatch-loop HTTP-error counter (all multi-step flows benefit),
and `createOrgUnit` (adds root-on-empty; existing child creation unchanged). No tool
regressed; cross-tool effects are strictly improvements (the guard is more accurate).

**Verification:** `node --check` passes. UID-extraction unit cases: `?fields=id,displayName`
→ no UIDs, `programs/<uid>` → the real UID. Counter simulation of the exact transcript
sequence: old logic blocks `options create` (as it did live), new logic reaches it. Full
scenario committed end-to-end on the live instance (root country with NO parent + 3
descendants in one payload, Person TET, Sex option set + Male/Female, Full Name/DOB/Sex
attributes) with `ignored:0`, then every object deleted — instance returned to completely
empty. The stale objects the earlier failed run left behind (4 "Test" OUs + "Person" TET)
were also removed.

---

## 31. `create_program` no longer sends the literal word "Person" as a TrackedEntityType UID (v2.8.5)

**File:** `background.js`
**Function:** `createFullProgram`, around line 17308 (tracked-entity-type resolution block)
**Type of change:** Bug fix + schema/manual clarification

**Incident (2026-07-08):** repeated `create_program` failures building "Maternal and Child
Health (MCH) Program":
```
Validation failed with 1 error(s): Program: Invalid reference [Person] (TrackedEntityType)
on object Maternal and Child Health (MCH) Program [LcJWHOL5XMX] (Program) for association
`trackedEntityType`
```
Root cause: the model was passing the literal string `"Person"` as `tracked_entity_type_id`
(a NAME, not a UID). The old code trusted `args.tracked_entity_type_id` unconditionally
(`let tetId = args.tracked_entity_type_id;`) — whenever it was truthy, the auto-resolve-by-name
branch (`isTracker && !tetId`) was skipped entirely, so the raw word was written straight into
`program.trackedEntityType = { id: tetId }` and DHIS2 rejected the whole atomic import (per the
"ATOMIC — nothing created" contract, the model was also told never to retry with the same IDs,
so it just repeated the identical broken call).

**What changed:**
1. `createFullProgram` now VERIFIES that `tracked_entity_type_id` resolves to a real TET on
   the server before it is written into the payload — it never trusts the raw value:
   - UID-shaped (`hasUidShape`, `background.js:931`) → confirmed to exist via
     `GET trackedEntityTypes/<id>?fields=id`. A **hallucinated** UID-shaped token (the error the
     user saw included `LcJWHOL5XMX`) 404s here and falls through — it no longer reaches the
     server as an invalid reference.
   - Not a known UID → resolved as an exact type NAME via
     `trackedEntityTypes?filter=name:eq:<value>` (so the literal word `"Person"`,
     `"Household"`, etc. becomes its real UID).
   - Neither resolves → returns a `_error`/`_hint` pointing at
     `architect_metadata(action="check_existing", object_type="trackedEntityTypes")` and telling
     the model NOT to guess a UID — instead of letting the raw value bounce the atomic import.
   - Omitted → unchanged default: auto-resolve to the type named "Person" (`name:ilike:Person`).
   (`hasUidShape` — pure 11-char structural test — is used for the id-lookup gate rather than
   `isLikelyDhisUid` so a rare all-lowercase real UID is still probed as an id, not misread as a
   name.) This mirrors the existing `resolveExistingOptionSetRef` verify-by-id-then-name pattern.
2. Tool schema description for `tracked_entity_type_id` (`background.js:4167`) rewritten to
   state explicitly: prefer a real UID; a NAME is now resolved automatically; never invent a
   UID; check existence first for non-"Person" types via `architect_metadata(check_existing)`.
3. `KB_CREATE_PROGRAM_DETAILS` manual text (delivered on first `create_metadata` call) gained a
   bullet under "Input slots" repeating the same rule, so the instruction reaches the model at
   use-time, not just in the terse wire schema.

**Sibling-path audit (per user request — "even other tools when creating metadata"):** the
other create/add references were checked for the same "name written into `{id}`" failure mode
and found guarded: `add_stage`/`add_data_elements_to_stage`/`add_program_rules` load their
`program_id`/`stage_id` with a GET first (clean early error, not an atomic "Invalid reference"),
rule actions resolve DE/TEA/stage **names**→IDs, and `create_data_elements` verifies
`option_set_id`/`option_set_name`/`category_combo_name` against the server before use. Residual
lower-risk gaps left as noted follow-ups (values documented as UIDs and normally sourced from a
prior tool result, not a well-known word the model reaches for): `add_data_elements_to_stage`'s
`data_element_ids[]` and per-DE `category_combo_id` are still passed through unverified.

**Verification:** `node --check background.js` passes. Confirmed live against
`play.im.dhis2.org/stable-2-43-0-1`: `GET trackedEntityTypes/nEenWmSyUEp?fields=id` → `{"id":
"nEenWmSyUEp"}` (real UID accepted); `trackedEntityTypes?filter=name:eq:Person` → `nEenWmSyUEp`
(name resolved); `GET trackedEntityTypes/LcJWHOL5XMX` → HTTP 404 (hallucinated UID rejected,
falls through to the clean error); a nonexistent name → empty collection. No playground writes
were needed — this only changes value resolution before the payload is built, not the
payload/dependency-chain logic itself, which was already proven working in entries 25/28.

**Scope of impact:** Only the tracked-entity-type resolution step of `create_program` changes.
Calls that already passed a real UID behave identically; calls that omitted the field behave
identically (still defaults to "Person"). The only behavior change is for calls that passed a
non-UID string — previously a guaranteed atomic-import failure, now either resolved correctly
or rejected early with an actionable hint instead of a raw DHIS2 validation error. No other
tool touches this code path.

---

## 32. Follow-up: TET name resolution must not rely on the brittle `name:eq:` server filter (v2.8.6)

**File:** `background.js`
**Function:** `createFullProgram` (tracked-entity-type resolution block)
**Type of change:** Bug fix (the v2.8.5 fix's name path was too strict)

**Incident (immediately after shipping v2.8.5):** the *same* MCH build now failed with the
NEW error path instead:
```
Could not resolve tracked_entity_type_id="Person" to a TrackedEntityType on this server — it
is neither an existing UID nor an existing type name, so it cannot be used as trackedEntityType.id.
```
Root cause: v2.8.5 resolved a passed name with `trackedEntityTypes?filter=name:eq:<value>`.
That filter is **case-sensitive**, **exact**, and matches only the raw `name` property — NOT
the translated `displayName`. So on any instance where the Person type's `name` differs from
`"Person"` (different case, a trailing space, a translated/renamed `name`, or `name` ≠
`displayName`), the lookup returned empty and the tool hard-failed — even though a perfectly
usable Person type existed. (The previous *omitted-default* path had used the fuzzy
`name:ilike:Person`, which is why omitting the field worked but passing `"Person"` did not.)

**What changed:** the resolver no longer uses a server-side name filter at all. It now fetches
the full TET list once (`trackedEntityTypes?fields=id,name,displayName&paging=false`) and
matches **in JS**, which removes every server-filter quirk:
- UID-shaped input → accepted only if its id is present in the list (hallucinated UID → falls
  through, never reaches the server as an invalid reference).
- Name input → case-insensitive match on BOTH `name` and `displayName`, exact first, then a
  `contains` match (e.g. `"Person (client)"`).
- Unresolved but Person-ish (or omitted) → falls back to any type whose name/displayName
  matches `/person/i` — restoring the historical omitted-default leniency for the passed-name
  case too.
- Still nothing → error that now **lists the actual TrackedEntityTypes on the instance**
  (`_available_tracked_entity_types`) so the model can pick a real one, instead of a dead-end.
If the list fetch itself errors, that error is surfaced directly.

**Verification:** `node --check background.js` passes. The exact resolution logic was run in
Node against the LIVE TET list from `play.im.dhis2.org/stable-2-43-0-1` across 8 inputs:
`"Person"` → `nEenWmSyUEp` ✓ (the failing case), lowercase `"person"` ✓, `"person "` with a
trailing space ✓, omitted ✓, real UID `nEenWmSyUEp` ✓, other real type `"Building"` →
`EawlYwOO61R` ✓, hallucinated UID `LcJWHOL5XMX` → clean error ✓, nonexistent `"Zebra"` → clean
error ✓. No playground writes needed (pure pre-payload resolution).

**Scope of impact:** supersedes entry 31's name-resolution step only. Real-UID and omitted
calls are unchanged; the passed-name case is now resilient to case/whitespace/`displayName`
differences instead of hard-failing. No other tool touches this path.

---

## 33. Percent-encode `[`/`]` in query strings — self-hosted (Tomcat) DHIS2 no longer 400s on bracketed `fields`/`filter` (v2.8.7)

**Files:** `background.js`, `manifest.json`
**Functions:** new `encodeStrictQueryChars`; applied in `safeDhis2Fetch` (URL build) and `apiUrl`
**Type of change:** Bug fix (transport-level — fixes an entire class of failures on self-hosted instances)

**Incident (user's local instance `http://localhost:8081`, DHIS2 2.42.5.1 on Tomcat):** the MCH
build "completed but with many errors." Two distinct root causes were found by connecting to
that server and reproducing the exact calls:

1. **The custom-form step failed repeatedly** — `manage_custom_forms` (preview_html /
   set_stage_form) returned *"Could not load program stage eyjD4TwgOIk: DHIS2 API 400"*, even
   though the SAME stage loaded fine via the model's own `dhis2_query`. Reproduced with curl:
   ```
   GET /api/programStages/<id>.json?fields=id,displayName,programStageDataElements[dataElement[id]]
   → HTTP 400  Tomcat: "Invalid character found in the request target"
   GET (same, with %5B/%5D instead of [ ])                              → HTTP 200
   ```
   **Root cause:** DHIS2's nested-`fields` (`a[b[c]]`) and `filter=…:in:[..]` syntaxes contain
   `[` and `]`. A stock **Tomcat**-fronted DHIS2 enforces strict RFC 7230 and rejects those raw
   characters in the request target with 400. `play.dhis2.org` sits behind a relaxed proxy
   (nginx) that tolerates raw brackets — which is why every playground test passed and this was
   never caught. The chatbot's internal helpers (`safeDhis2Fetch` AND `apiUrl`/`dhis2Fetch`)
   built URLs with **raw** brackets; the model's manual `dhis2_query` happened to be
   URL-encoded, so it worked while the tool's own load didn't. This affected far more than
   custom forms: the program-context load (`apiUrl` program metadata + rules) was verified to
   400 on the same server too.

2. **TET "Person" failed to resolve** — this was the v2.8.5 brittle `name:eq:` filter; already
   fixed in entry 32 (v2.8.6) via the in-memory list match, and re-verified on this exact
   Tomcat server (its type is lowercase `"person"`, id `sCNHozES5tk`, which the v2.8.6
   case-insensitive matcher resolves — the v2.8.5 code could not).

**What changed:** new `encodeStrictQueryChars(query)` percent-encodes ONLY the characters Tomcat
rejects (`" < > [ \ ] ^ \` { | }` and whitespace). It is applied to the **query portion only**
of the URL in both DHIS2 URL builders — `safeDhis2Fetch` (every tool's internal fetch, incl.
write-via-tab, which receives the built URL) and `apiUrl` (every `dhis2Fetch` context load). It
deliberately never touches `%`, so an already-encoded query is not double-encoded, and legal
delimiters (`& = , : ;`) are preserved. `appendQueryParamsToPath` already encodes via
`URLSearchParams`, and the LLM-provider / Tavily / `system/info` / `programId=`-only fetches
carry no brackets, so no other builder needed changing.

**Verification (live, against the user's own Tomcat server + the playground):**
- Reproduced the 400 on raw brackets and 200 on encoded brackets, for BOTH the
  `programStages/<id>?fields=…[…]` stage load AND a heavy `apiUrl` program-metadata context
  load (`programs/<id>?fields=…programStages[…]…programRules[…]`): raw → 400, encoded → 200.
- Unit-tested `encodeStrictQueryChars`: nested `fields` brackets encoded; `filter=:in:[a b,c]`
  brackets + spaces encoded; no-bracket query unchanged; already-encoded (`%5B`) NOT
  double-encoded; `:` preserved.
- **Completed the user's original request end-to-end on the Tomcat server with ZERO errors**:
  re-ran the full `set_stage_form` sequence (bracketed meta load → JSON-Patch dataEntryForm
  update → `:owner` reload → full stage PUT with re-attached `program` + `formType=CUSTOM`) for
  all 3 MCH stages, applying blue-and-white custom forms. Every step returned HTTP 200; verified
  `formType=CUSTOM` with 8 / 7 / 5 bound inputs and blue/white styling on ANC / Delivery / PNC.
- **No regression on relaxed servers:** encoded `fields` brackets and an encoded `in:[..]`
  filter both return 200 on `play.im.dhis2.org/stable-2-43-0-1` (DHIS2 decodes `%5B`/`%5D`
  back to `[`/`]` identically).
- `node --check background.js` passes.

**Scope of impact:** transport-level and universally positive — every DHIS2 GET the extension
issues now works on strict (Tomcat) AND relaxed (nginx) front-ends. On relaxed servers behavior
is byte-for-byte identical (server decodes the escapes). No tool logic, schema, or result shape
changed; this only makes the requests spec-compliant. Fixes the custom-forms failure and the
broader context-load failures on self-hosted DHIS2 in one place.

## 34. Existing metadata is NEVER recreated — reuse guarantees, loud dedup probes, name-conflict self-healing, and a verb-targeted write-auth negation guard (v2.8.8)

**Files:** `background.js`, `manifest.json`
**Functions:** `createFullProgram`, `postMetadataPayload`, `classifyWriteAuthorization`,
`handleManageMetadata` (add_program_attributes), `growthChartScaffoldProgram`, `TOOLS` schema
(`program_attributes`), `TOOL_SUMMARIES.create_metadata`, `KB_CREATE_PROGRAM_DETAILS`
**Type of change:** Bug fixes + defense-in-depth (duplicate-prevention correctness)

**Incident (user's local Tomcat instance `http://localhost:8081`, 2026-07-10):** a simple
"Child health" tracker-program request produced a cascade of tool errors. The user was testing
the **v2.8.5 build** (predates the v2.8.7 bracket-encoding fix), so every query with raw `[ ]`
400'd on Tomcat. That single transport failure surfaced four distinct latent weaknesses, each
now fixed at the root so the class of failure cannot recur EVEN IF a probe fails again:

1. **Silent dedup-probe failures → duplicate creation attempts.** In `createFullProgram` the
   existing-object probes (`optionSets`/`dataElements`/`trackedEntityAttributes`
   `filter=name:in:[…]`) swallowed error envelopes (`resp?.X || []`), so a failed probe was
   indistinguishable from "nothing exists" and the tool tried to CREATE TEAs (`Full name`,
   `DoB`, `Sex`) that already existed — three atomic-import failures in a row.
   **Fix:** probe failures now ABORT create_program before any import (`phase: 'pre_check'`,
   `nothing_created: true`) with an explicit hint. Same loud-abort added to the
   `add_program_attributes` per-name probe and the growth-chart scaffold TEA probe.

2. **No self-healing on "already exists" name conflicts.** Even when a duplicate slips past
   the probes (race, comma-in-name splitting the `in:` filter, …), DHIS2's error carries BOTH
   UIDs (`… on object X [newUid] (Klass) already exists on object existingUid`).
   **Fix:** new `tryAutofixNameConflicts` inside `postMetadataPayload` — for classes where
   same-name means same-thing (TrackedEntityAttribute, DataElement, OptionSet,
   TrackedEntityType, CategoryOption, Category, CategoryCombo) it REMOVES our would-be
   duplicate from the payload, rewrites every reference from the pre-generated UID to the
   existing one, and retries once (VALIDATE and COMMIT paths, alongside the existing shortName
   auto-suffixer). ProgramStage/ProgramIndicator name conflicts get a rename-with-suffix
   instead (reuse would hijack another program's object). Results carry
   `_name_conflict_remaps` + `_recovery_note`; `createFullProgram` syncs its name→ID maps so
   the returned summary/ID handles point at the REAL reused objects.

3. **Case-variant duplicates were created silently.** DHIS2's unique-name constraint is
   case-SENSITIVE: requesting `DOB` when the server has `DoB` would "succeed" and pollute the
   instance with a near-duplicate.
   **Fix:** a second, case-insensitive reuse pass (`name:ilike:` + exact case-insensitive
   equality client-side) for any DE/TEA the exact-match probe missed. Non-fatal on probe error
   (layer 2 still catches the residue).

4. **The write-auth negation guard nuked legitimate authorization.** The user's reply
   "use these attributes that are already there, **don't recreate them, go ahead**" was
   REFUSED (`no explicit write authorization detected`) because ANY bare "don't" anywhere
   forced read_only, overriding the explicit "go ahead".
   **Fix:** `classifyWriteAuthorization` now strips only the verb phrase each negation
   directly precedes ("don't recreate them") before testing for write verbs, plus a hard
   refusal pattern for "no, don't / no thanks, leave it / no, just diagnose". 15-case unit
   suite covers the transcript phrase, pure negations, declines, problem reports, and
   constraint+affirmative mixes.

Also: `program_attributes` now accepts `id` (verified against the server pre-import; phantom
UIDs abort with `nothing_created`) so a known existing TEA can be pinned explicitly;
`required` relaxed to `['name']` (value_type only needed for genuinely new TEAs); the
schema description, `TOOL_SUMMARIES.create_metadata`, `KB_CREATE_PROGRAM_DETAILS`, and the
atomic-failure `_hint` all now state the invariant in MUST language: **existing attributes are
reused, never recreated, and never dodged via name variants**.

**Verification (all live):**
- `harness/test-child-health-scenario.js` against the user's Tomcat instance
  (localhost:8081, 20/20 PASS): one-call create_program reusing `Full name`/`Sex` exactly and
  `DOB`→existing `DoB` case-insensitively; server shows the program bound to the 3 existing
  UIDs with zero new TEAs; add_program_attributes loads the program (no 400) and skips an
  attribute already on the program; forced duplicate-"Sex" payload self-heals (duplicate NOT
  created, sibling DE in same payload created, remap recorded); auth-gate transcript phrase →
  broad, pure diagnosis → read_only; full cleanup verified, existing TEAs untouched.
- `harness/test-mixed-attrs-playground.js` on play 2.43 (9/9 PASS): reuse of existing
  "First name" + creation of a genuinely new TEA in the same call — creation still works.
- Regression: `test-tomcat-brackets.js` (7/7), `e2e-happy-path.js` (8/8), tool sweep
  byte-identical failures to the pre-change baseline (all 6 are stale test arg-shapes, not
  regressions).
- `node --check` passes for background.js and panel.js; manifest valid.

**Scope of impact:** create_metadata/create_program, manage_metadata(add_program_attributes),
growth-chart scaffold, every postMetadataPayload caller (shared self-healing — strictly
additive), and the per-turn write-auth gate (strictly more accurate). No result shapes
changed; existing success paths byte-identical.

## 35. Program-indicator deep test (MCH scenario): widget visibility, boundary correctness, real parser grammar (v2.8.9)

**Files:** `background.js`, `manifest.json`
**Functions:** `_buildAndPostProgramIndicator`, `executeManageProgramIndicators` (create/update/get/audit/bulk_fix/bulk_fix_expressions), `createFullProgram` (embedded program_indicators), `lintProgramIndicatorExpression`, `VALID_PI_D2_FUNCS`, `KB_PI_GRAMMAR`, `manage_program_indicators` schema
**Type of change:** Bug fixes + capability (found by driving the full MCH indicator→data→dashboard flow through the real tools)

**Scenario that exposed the defects (2026-07-10, play 2.42.5.1):** built the user's
"Maternal and Child Health (MCH) Program" out end-to-end with the extension's own tools —
12 WHO-ANC-DAK-derived complex program indicators, 5 shown in the Tracker Capture
"Indicators" widget, a 12-woman tracker cohort (12 enrollments, 67 events) entered via
dhis2_query tracker bundles, analytics run, and a 6-tile dashboard (COLUMN, LINE,
PIVOT_TABLE, SINGLE_VALUE, STACKED_COLUMN + text) via manage_dashboards. Three tool defects
surfaced and were fixed at the root:

1. **`displayInForm` was unsupported and silently wiped.** The indicator schema had no way
   to put an indicator in the right-side data-entry "Indicators" widget, and because the
   metadata import replaces the full object, ANY update/bulk_fix through the tool reset a
   widget-visible indicator back to hidden.
   **Fix:** new `indicator.display_in_form` field (create + update); `_buildAndPostProgramIndicator`
   always serializes `displayInForm`; update, bulk_fix and bulk_fix_expressions fetch and
   thread the existing flag through; `get` returns it. Round-trip proven on 2.42.5.1 before
   coding (probe import → GET displayInForm:true → delete).

2. **ENROLLMENT indicators were created with EVENT_DATE analytics boundaries** (hard-coded
   pair). Verified live consequences: each enrollment is counted in EVERY period containing
   one of its events (a first-trimester-booking indicator returned 58 with only 25
   enrollments in the program), and `d2:count()`-style filters see only same-period events —
   "women with 4+ ANC contacts" returned 0 forever.
   **Fix:** boundary target now follows the analytics type (ENROLLMENT_DATE for enrollment
   PIs, EVENT_DATE for event PIs) in BOTH `_buildAndPostProgramIndicator` and
   create_program's embedded-PI path; updating an indicator's analytics_type regenerates the
   pair; **audit** now flags existing ENROLLMENT PIs with EVENT_DATE-only boundaries.
   After delete+recreate through the fixed tool: 4+ANC 0→12, first-trimester 58→14, IFA
   44→20 (all ≤ 25 enrollments — sane).

3. **The d2-function whitelist matched the docs, not the parser.** The docs list floor/ceil/
   round/modulus/addDays/left/right/substring/split/concatenate/length/validatePattern/
   inOrgUnitGroup/lastEventDate/zScore* for PIs — the actual ANTLR parser on BOTH 2.42.5.1
   and 2.43.0-1 rejects every one of them ("Item d2:<fn>( not supported for this type of
   expression"); `d2:hasValue` parses in FILTERS only. The lint therefore passed expressions
   the server then bounced with a generic error (cost: 1 wasted RTT + vague hint), and the
   OUG{} hint recommended the equally-unsupported d2:inOrgUnitGroup.
   **Fix:** whitelist reduced to the 16 parser-verified functions; the documented-but-rejected
   set gets an instant local error with a targeted workaround (rounding → plain arithmetic +
   `decimals`; org-unit scoping → the visualization's ou dimension); hasValue-in-expression
   caught locally; KB_PI_GRAMMAR rewritten to the verified sets + a display_in_form section.

**Verification (all live on play 2.42.5.1 via the chrome-shim harness driving the real
executeTool):** `mch-pi-drive.js` 26/26 (12 complex PIs incl. d2:daysBetween first-trimester,
d2:count 4+ visits, d2:countIfValue IFA — with one model-style self-correction on a rejected
boolean literal; displayInForm exact per indicator; description-only update preserves the
widget flag), `mch-pi-retry.js` 3/3 (d2:floor now blocked locally with the decimals hint;
corrected gestational-age expression creates widget-visible), `mch-data-entry.js` 7/7 (91
tracker objects imported through dhis2_query bundle rewrite), `mch-fix-enrollment-pis.js`
13/13 (audit flags → delete → recreate → ENROLLMENT_DATE on server → analytics values sane),
`mch-dashboard.js` (dashboard ON7Mo5bJtd8: 6 tiles, 11 PI dimension items, add_items
non-destructive). Regressions: e2e-happy-path 8/8 (full agentic loop incl. PI create),
auth-gate unit suite 18/18, `node --check` clean.

**Scope of impact:** manage_program_indicators (all actions), create_program's embedded
program_indicators, PI lint + manuals. Event-type PI behavior unchanged except the new
always-serialized `displayInForm:false` default, which matches DHIS2's own default.

## 36. Growth-chart transcript autopsy: scoped "yes" authorization, growth dataStore guard, routing trigger, anti-"tool doesn't exist" refusals (v2.8.10)

**Files:** `background.js`, `manifest.json`
**Functions:** `classifyWriteAuthorization`, `requireWriteAuth`, dhis2_query guard chain,
`getContextualTools` (wantsGrowthChartIntent), `buildSystemPrompt` (wantsGrowthChartPrompt),
`resetConversationForNewThread` fields
**Type of change:** Bug fixes — write-gate design + tool routing (found via the user's
growth-chart transcript on localhost:8081, v2.8.7 build)

**The transcript, distilled (all reproduced live):**
1. "set up the child growth data store ID based of these data elements" → the growth-chart
   tool was never surfaced (intent regex needed chart/plugin words; "data store" wasn't a
   trigger), so the model treated it as a generic dataStore write and asked namespace/key.
2. The model then hand-wrote a config into an INVENTED namespace (`childGrowthPlugin`) with a
   made-up shape (including BMI/nutrition DEs the plugin never reads) via raw dhis2_query —
   nothing blocked it. The plugin only reads `captureGrowthChart/config`, so "it's not
   working" with no error anywhere.
3. The per-turn write refusal made the model conclude — and TELL the user, twice — that
   `manage_growth_chart_plugin` "does not exist in my environment".
4. Worst: after proposing the growth-chart configure and getting "yes", the model spent that
   authorization on `manage_metadata(delete dataElements/<BMI Z-score>)` + remove_from_stage
   — a destructive delete the user never asked for, unblocked because ANY bare "yes" granted
   turn-wide broad write access.

**Fixes:**
- **Scoped affirmations (gate redesign):** `requireWriteAuth` now RECORDS every refusal
  (`dhis2.lastRefusedWrite` = tool/action/turn). If the next turn is a BARE affirmation
  ("yes", "go ahead", "do it", …), `classifyWriteAuthorization` returns
  `scope:'scoped', tool:<the refused tool>` instead of broad: only that tool may write; any
  other gated write (including raw dhis2_query writes) is refused with "the user's bare
  'yes' authorizes ONLY <tool>(<action>) — call it now". The first matching call widens the
  scope to broad for the rest of the turn, so legitimate follow-up writes of the same plan
  still work. Affirmations with substantive content ("yes, and also delete X") and bare
  affirmations with no pending proposal stay broad (unchanged behavior). Proposal memory is
  turn-scoped (expires unless redeemed on the immediately-next turn) and cleared on new
  threads. Turn counting lives in `classifyWriteAuthorization` — the shared per-turn entry
  point of the agentic loop and the harness.
- **Growth dataStore guard:** dhis2_query now BLOCKS non-GET requests to any dataStore
  namespace matching /growth/i (DELETE of non-official junk namespaces stays allowed for
  cleanup) and redirects to manage_growth_chart_plugin with the canonical-namespace
  explanation.
- **Anti-hallucination refusal wording:** every gate refusal now states the tool "IS
  available and working — this is a per-turn authorization gate, NOT a missing tool", and
  instructs retrying THE SAME call after confirmation, never a substitute tool.
- **Routing trigger:** "growth" + "data store/datastore" now surfaces
  manage_growth_chart_plugin (tool selection AND the 3-line system-prompt routing stub). The
  lazy two-tier manual design is untouched — the stub stays decide-time-only; full usage
  docs still arrive via the first-call manual gate.
- **Instance repair (localhost:8081):** BMI Z-score restored to the Child Growth stage
  (sortOrder 7), junk `childGrowthPlugin` namespace deleted, canonical
  `captureGrowthChart/config` verified intact.

**Verification:** `test-growth-chart-flow.js` against localhost:8081 — 19/19: turn-1 phrasing
surfaces the tool + prompt stub; POST/PUT to invented AND official growth namespaces blocked
with redirect (junk-namespace DELETE still allowed); "choose the … plugin" stays read_only;
refusal wording includes availability note and records the proposal; bare "yes" → scoped;
the delete-BMI disaster call REFUSED; dhis2_query bypass REFUSED; approved configure runs and
widens scope; config canonical; BMI still in stage; no-proposal "go ahead" stays broad.
Regressions: auth-gate unit suite 18/18, child-health scenario 20/20 (localhost),
tomcat-brackets 7/7 (localhost), e2e-happy-path 8/8 (play 2.43). `node --check` clean.

**Scope of impact:** the write gate change affects ALL write tools uniformly and only in the
bare-affirmation-after-refusal case, where it strictly narrows (never widens) what a "yes"
can do. Guard + routing changes are additive.

---

## 37. v2.8.11 — Program-rule correctness: cross-turn UID memory, one-rule visibility doctrine (lint + audit), display-name token healing, in-place action updates

**Files:** `background.js`, `manifest.json` (2.8.10 → 2.8.11)
**Detailed write-up:** `CHANGES_program_rule_correctness.md`

Root-caused and fixed the three failure classes reported from the MCH (play 2.43) and TB
(localhost) sessions of 2026-07-11:

- **Cross-turn knownIds (`seedKnownIds`):** the verified-UID registry now also harvests
  `conversationHistory`, so objects the chatbot itself created/read in PRIOR turns pass the
  UID gate instead of being refused ("have not appeared in any verified source this turn")
  and forcing pointless re-list calls. Refusal text now also forbids interpreting the gate
  as evidence an object "is already gone" (observed live: the model told the user an orphaned
  action was deleted when its DELETE had merely been refused client-side).
- **In-place rule-action updates (`manage_program_rules` update):** a new actions array now
  REUSES the existing programRuleAction UIDs positionally, so a SHOWWARNING→DISPLAYTEXT swap
  updates the row in place — no new action row, no orphan, no post-import DELETE, no 409
  ("could not automatically delete the old action" is structurally impossible in the N→N
  case). Surplus-action deletes fall back to `metadata?importStrategy=DELETE` on 409.
- **Visibility-semantics lint (`lintRuleVisibilitySemantics` + helpers):** DHIS2 has NO
  "show" action — the TB program was found live with "Show X when Yes" rules carrying
  HIDEFIELD+SETMANDATORYFIELD on the same field under the positive condition, paired with
  complementary "Hide X when No" twins: fields hidden in EVERY case / hidden-and-mandatory
  (the un-selectable multi-select). All three shapes are now hard-refused at lint time in
  create_program, add_program_rules, manage_program_rules create AND update — including
  new-vs-EXISTING-rule twins — and `action=audit` reports them on existing programs as
  `cross_rule_issues` so diagnosis finds the true cause instead of inventing "DHIS2
  rendering issues". Manuals (KB_PROGRAM_RULE_SYNTAX, KB_CREATE_PROGRAM_DETAILS, both wire
  schemas) teach the one-rule doctrine explicitly.
- **Display-name token healing (`resolveRuleTokenBindings`):** tokens are sanitized before
  matching, so `A{Date of Birth}` resolves to the TEA "Date of Birth" and is auto-rewritten
  to `A{date_of_birth}` (reported as `rule_token_rewrites`) instead of refusing the whole
  create_program ("references unresolved variable(s)"). `A{}` on a data element heals to
  `#{}`; tokens matching an existing PRV's sanitized name rewrite onto that PRV.
- **Update-path token validation:** `manage_program_rules(action=update)` with a changed
  condition now resolves #{}/A{} tokens against the program (auto-creating PRVs, healing
  display names) and REFUSES unknown tokens — previously such an update saved a rule that
  silently never fires.
- **Instance repair (localhost:8081, TB program):** the five broken "Show …" twin rules
  deleted via the fixed tool path; the correct one-rule hide set remains; audit clean.
- **Program cascade delete (found during deep testing):** manage_metadata(delete, programs)
  used to 500 ("Transaction silently rolled back") while the program still had rules/PRVs —
  it now snapshots + deletes owned programIndicators/programRules/programRuleVariables
  child→parent first, reporting `cascade_deleted`.

**Verification:** unit suite 27/27 (lint + resolver, incl. the exact live TB rule shapes and
regression checks for legit hide/mandate-inverse pairs and HIDEALLFIELDS sugar); live E2E
through the real preflight+executeTool layer: localhost:8081 (2.42, Tomcat-strict URLs)
32/32 and play stable-2-43-0-1 28/28 — display-name-token create heals + PRV auto-created;
broken pair refused with NOTHING imported; twin-of-existing refused naming the existing rule;
audit flags the live TB contradictions; repair delete works; cross-turn history UID passes
the gate then write-auth asks + scoped "yes" updates FIRST TRY; action UID identical after
DISPLAYTEXT swap with exactly 1 action row server-side; update-path token heal + unknown-token
refusal; full ZZTEST cleanup verified on both servers. `node --check` clean on all scripts.

**Scope of impact:** knownIds change strictly WIDENS accepted UIDs (to what the model can
already see in its context) — hallucinated-UID protection is unchanged for genuinely unseen
IDs. The semantics lint only refuses combinations that are always wrong (hidden-in-every-case,
hidden-and-mandatory, duplicate twins). Token healing only rewrites when a unique match
exists; ambiguous/unknown tokens still refuse exactly as before.

---

## 38. v2.8.12 — xAI Grok provider preset + custom-provider fixes (URL normalization, host-permission grant, reasoning progress)

**Files:** `background.js`, `sidepanel/panel.js`, `sidepanel/panel.html`, `README.md`, `manifest.json`
**Type of change:** Modified (4 targeted fixes + 1 new provider preset)

### The issue

Connecting xAI Grok (`grok-4.5`) through the **Custom / Other** provider failed even with a
valid API key. Live-tested against `https://api.x.ai` (2026-07-12): the API itself is fully
OpenAI-compatible — streaming, `tools`/`tool_choice`, null-content assistant messages, and
multi-turn tool loops all work, and it sends `access-control-allow-origin: *`. The failures
were entirely on the extension side:

1. **Bare-domain base URL 404s.** `getChatCompletionsUrl('https://api.x.ai')` built
   `https://api.x.ai/chat/completions` (missing `/v1`) → HTTP 404 (verified live).
2. **Docs-copied endpoint URL 404s.** xAI's docs example uses the Responses API
   (`https://api.x.ai/v1/responses`); pasting that as Base URL built
   `…/v1/responses/chat/completions` → HTTP 404 "No handler found on route" (verified live).
3. **No host permission requested for provider origins.** Saving a provider config never
   called `chrome.permissions.request` for the API origin, so any custom endpoint whose API
   does NOT send permissive CORS headers is unreachable from the MV3 service worker (x.ai
   happens to send `*`; arbitrary custom endpoints often don't).
4. **Reasoning models look frozen.** grok-4.5 streams `delta.reasoning_content` before any
   `content`/`tool_calls`. The SSE loop ignored that field, so the panel showed no activity
   for the whole reasoning phase.

### The fixes

**`background.js` — `getChatCompletionsUrl` (~line 64):** strips a trailing `/responses`
segment (docs-copied Responses endpoint), and appends `/v1` when the URL has no path (bare
domain) before adding `/chat/completions`. Existing behaviors regression-tested — 11 URL
shapes verified (Ollama with/without `/v1`, Google bare + prefixed, OpenAI/Groq/OpenRouter,
x.ai ×4): all normalize correctly.

**`background.js` — SSE loop in `callFireworksStreaming` (~line 8055):** new
`delta.reasoning_content` handler broadcasts `Reasoning…` / `Reasoning… (N words)`
AI_THINKING labels (same cadence as the `<think>`-block path: first delta, then every 60).
Reasoning text is never added to the visible answer.

**`background.js` — `SAVE_PROVIDER_CONFIG` (~line 25786):** `grok` added to
`ALLOWED_PROVIDERS`.

**`sidepanel/panel.js` — `PROVIDER_PRESETS`:** new `grok` preset
(`https://api.x.ai/v1`, model `grok-4.5`, key hint `xai-...`).
**`sidepanel/panel.html`:** new "xAI Grok" option in the provider dropdown.

**`sidepanel/panel.js` — `saveSettings`:** on save, synchronously (within the click gesture)
calls `chrome.permissions.request` for the remote provider/vision origins
(`optional_host_permissions` already covers `https://*/*`). Already-granted origins resolve
silently; denial is non-fatal (CORS-friendly APIs keep working exactly as before).

**Verification:** `node --check` passes on both JS files; live x.ai API tests above; URL
normalization unit-tested (11/11 pass).

**Scope of impact:** No change for existing configured providers (all previous URL shapes
normalize identically). New: bare-domain and `/responses` base URLs now work, Grok is a
one-click preset, custom endpoints without CORS headers become reachable after the
permission grant, and reasoning-model streams show live progress.

---

## 39. v2.8.13 — create_program stops dead-looping on one bad rule (skip-and-continue + mechanical circuit breaker)

**File:** `background.js` (+ `manifest.json` version bump 2.8.12 → 2.8.13)
**Type of change:** Modified — `createFullProgram` rule-building path + the agentic loop

### The reported failure

A full TB tracker prompt (5 attributes, 3 stages, ~6 rules, 3 PIs) on **grok-4.5**
looped: `create_program` failed with `references unresolved variable(s):
A{date_of_birth} … Nothing was imported`, then the model re-sent the identical
call ~12 times (each `BLOCKED`), creating nothing. The user confirmed the SAME
prompt/model/instance worked at LLM **temperature 0.1 but not 0**.

### Root cause — two defects

1. **Trigger:** one unresolvable rule token made the WHOLE atomic create fail
   ("Nothing was imported") — the entire program was discarded over one rule.
2. **Amplifier:** the repeated-failure guard only *asks* the model to stop. At
   temperature 0 the model is deterministic (same history → same output), so it
   re-emitted the byte-identical blocked call until the 50-iteration budget was
   gone. 0.1's randomness merely let it stumble onto a self-consistent payload.

### Fixes

**A. Skip-and-continue (`createFullProgram`, ~line 18150 + ~18270 + ~18620).**
Each rule is built into local scratch; a rule that references an unresolved
variable / unresolvable stage / unresolvable section / broken boolean condition
is now SKIPPED and recorded, instead of aborting the whole import. Program +
stages + DEs + TEAs + all valid rules + indicators still import. A **successful**
result carries `_skipped_rules`, `_skipped_rules_warning`, and `_next_step`
(add them via `manage_program_rules`), so the model doesn't retry the create.
The cross-rule visibility-semantics lint stays a hard error (ambiguous which rule
to drop) but is bounded by fix B.

**B. Mechanical circuit breaker (agentic loop, ~line 25040 + ~25185).** The loop
counts per-tool guard blocks; after `TOOL_BLOCK_DISABLE_THRESHOLD` (3) a tool is
removed from the wire schema for the rest of the turn and a hard directive is
injected, so a deterministic model physically cannot re-emit the call and must
answer. Bounds ANY deterministic tool loop; legitimate fix-and-retry (different
signature) is never counted.

Panel: `create_metadata` summary now appends "(N rules skipped — need follow-up)";
a disabled tool shows "Stopped retrying … disabled for this turn".

### Verification

Offline, real code in a Node VM shim (no server): resolver unit test; skip E2E
(DOB present → created; DOB misnamed → bad rule skipped, program created); broken
condition skipped; fully-valid 3-rule program → all 3 created / 0 skipped;
circuit-breaker E2E through the real loop with a deterministic fake provider →
tool disabled after 3 blocks, loop ends at 6 calls (budget 50) with a final
answer. `node --check background.js` passes.

### Scope of impact

Valid programs are unchanged (0 false skips). Programs with a bad rule now import
(minus that rule) instead of failing wholesale. Deterministic retry loops are
mechanically bounded across all tools, not just create_program.

---

## 40. New Design — modular refactor of the background worker (6 modules) + two fixes

**Files:** `background.js` (now a loader), new `src/{core,registry,providers,tools-metadata,tools-programs,agent}.js`, new `scripts/verify.js`, `package.json`, `ARCHITECTURE.md`.
**Full detail:** see `CHANGES_modular_refactor.md`.

**Type of change:** Structural refactor (behaviour-preserving) + one deliberate bug fix + dead-code removal + tooling.

**What changed:**

1. **Split `background.js` (26,168 lines) into six focused modules** loaded in order via `importScripts()`. `background.js` is now a 40-line loader. The modules share one classic-worker global scope, so no `import`/`export` wiring and no build step. The concatenation of `src/*.js` in load order is **byte-for-byte identical** to the prior `background.js` — behaviour is unchanged by construction. Module map is in `ARCHITECTURE.md`.

2. **Fixed the duplicate `normalizeText()`** that hoisting made silently collide. The lowercase-only and the aggressive (strip-non-alphanumerics) variants are now `lowercaseText` and `normalizeSearchTokens`, both in `core.js`. This **restores** the `'sub-'` / `'sub-org'` triggers in `userExplicitlyWantsDescendants()` (e.g. "all sub-counties"), which the aggressive normalizer had been quietly disabling by turning hyphens into spaces. Other callers were repointed with behaviour preserved.

3. **Removed the dead `lineListingAssets.routerSource`** fetch/field (the router source was fetched on every load and never read). `LINE_LISTING_ROUTER_PATH` and the live embedded routing are unchanged; no model-facing text changed.

4. **Added `scripts/verify.js`** (`npm run verify`), a dependency-free check that `node --check`s every file, loads the six modules under a `chrome` shim, and asserts the safety-critical gates (write-auth, UID entropy, patient-data privacy path gate, the two normalizers, strict query encoding). Added a minimal `package.json` (no dependencies, no build) and `ARCHITECTURE.md`.

**Scope of impact:** No tool schema, prompt, DHIS2 request shape, or safety gate changed — except the intended `sub-` descendant-trigger restoration. The safety review's heavier recommendations (single tool registry, typed state stores, `Dhis2Client`, `panel.js` split, TypeScript) were deliberately deferred and are listed in `ARCHITECTURE.md`.

---

## 41. create_program correctness — zero-error TB tracker program (COMPLETEENROLLMENT, HIDEOPTION, stage sections, "continue" auth)

**Files:** `src/tools-programs.js`, `src/registry.js`, `src/core.js`.
**Full detail + playground evidence:** `CHANGES_create_program_correctness.md`.

**Type of change:** Correctness fixes to the create_program flow, proven on the live 2.43 playground.

**Context:** A real session creating the "Tuberculosis Case Surveillance and Treatment" tracker program hit a cascade of failed API calls (a 500/409 on an invalid rule action, repeated "Option cannot be null", missing visual sections). Each root cause was reproduced and fixed via a Node harness running the REAL `executeTool` against `https://play.im.dhis2.org/stable-2-43-0-1`; the full program now imports with **32 API calls, 0 errors** (10 rules, 3 indicators, 5 sections), and all test metadata was cleaned up.

**What changed:**

1. **Invalid program-rule action types can no longer 409 the whole atomic import.** `createFullProgram` now normalizes every action `type` through the new `normalizeRuleActionType()` (`VALID_PR_ACTION_TYPES` whitelist + `PR_ACTION_TYPE_ALIASES`): valid types pass; model-invented `COMPLETEENROLLMENT`/`CLOSEENROLLMENT`/… are **translated to a `SHOWWARNING` completion prompt** (DHIS2 has no complete-enrollment action); anything else is dropped. Adjustments are surfaced in a new `rule_action_fixes` result field. Previously `programRuleActionType: act.type` was passed through unchecked → Jackson enum-deserialization 500/409 that killed the entire import.

2. **HIDEOPTION resolves and binds the option UID.** The action loop resolves the target option from the option set built for `data_element_name` in this same call (exact name → code → forgiving match) and sets `programRuleAction.option`. Unresolvable → the rule is skipped cleanly. `src/registry.js` adds `option_name`/`option_code` to the rule-action schema. Fixes the repeated "Option cannot be null" validation failures.

3. **create_program builds visual stage sections.** Stages accept `sections: [{name, data_elements:[…]}]`; sections are emitted as a **top-level `programStageSections` collection** (stage references by id — nesting them fails with "Invalid reference (ProgramStageSection)"). `src/registry.js` adds `sections` to the stage schema. Previously sections could not be created at all.

4. **"continue" now authorizes writes.** Added `continue` to `WRITE_AUTH_BROAD_RE` and the bare-affirmation regex in `classifyWriteAuthorization()` (next to `proceed`), so the assistant's own suggested word ("Reply 'continue' and I will create…") no longer gets refused. Negation guard still neutralises "don't continue".

**Scope of impact:** Only the create_program / manage_program_rules build paths and the write-auth classifier changed. No other tool altered. The action-type guard and HIDEOPTION resolution make every rule-building path more robust (they can no longer emit an un-deserializable enum or an unbound HIDEOPTION). Not addressed (model behaviour, not a tool bug): the session's guessed icon-key 404s — the circuit breaker correctly stopped those; a create_program-side icon-keyword resolver is a noted follow-up.

**Verification:** Live playground reproduce-then-fix for each error; full TB program imports with 0 API errors; server read-back confirms 10/10 rules (incl. bound HIDEOPTION + translated completion), 3/3 indicators, 5/5 sections; playground left clean; `npm run verify` green.

---

## 42. Dashboard "replace a tile with a new (program-indicator) chart" — infinite-loop disaster fixed

**Reported:** 2026-07-13, `localhost:8081`. Asked to remove a dashboard tile and replace it with a
chart of "% male vs female enrolled in the program (you likely need to create an indicator)", the
model called the dashboard tool's `list` action ~45 times in a row — each succeeding — narrating
"I'll create the program indicators and update the dashboard" without ever issuing a create, until
it exhausted the 50-iteration budget. Full detail: `CHANGES_dashboard_indicator_loop_fix.md`.

**Root cause (four compounding defects):**
1. `manage_program_indicators` was never surfaced on the Dashboard app, so the model had no tool to
   create the enrollment-by-sex program indicator it needed (`create_metadata` can't add a PI to an
   existing program). The user's typos — "incdicator", "dahboard" — also defeated every keyword
   regex, so even aggregate `manage_indicators` was withheld.
2. An out-of-context tool call was dropped **silently** — no tool result, no feedback — so a temp-0
   model re-emitted the same invisible call forever.
3. The circuit breaker only fired on **failed** calls; the repeated `manage_dashboards(list)` calls
   all **succeeded**, so nothing stopped them.
4. `get_program_info` had no `program_id`/`program_name` param and dead-ended on "No program in
   context" on the Dashboard app.

**Fixes**
- **A — `src/registry.js`:** a dashboard/data-viz turn now also surfaces `manage_program_indicators`,
  `manage_indicators`, and `get_program_info` (the tools that create/inspect the metrics a chart
  plots). Typo-proof: keyed off the app, not the spelling of "indicator".
- **B — `src/agent.js`:** every `tool_call` now receives a `role:"tool"` result. Unknown tools
  (`_scope:'unknown_tool'`) and real-but-not-enabled tools (`_scope:'tool_not_enabled'`) return
  actionable feedback instead of vanishing. Not executed (respects deliberate safety boundaries like
  read-only diagnostic mode); keeps one result per call (Anthropic-safe).
- **C — `src/core.js` + `src/agent.js`:** new no-progress guard (`noteExecutedCall` /
  `noProgressStopOrNull`, wired into `preflightCheckCall`) counts identical **executed** calls and,
  after 3 identical no-progress runs, refuses further repeats and feeds the mechanical circuit
  breaker (`no_progress_repeat` scope) — disabling the tool so the loop cannot continue.
- **D — `src/registry.js` + `src/tools-metadata.js`:** `get_program_info` accepts `program_id` /
  `program_name` (resolved server-side) and works from any page.

**Verification:** `npm run verify` green with new assertions (no-progress guard behaviour; typo'd
report message surfaces the indicator tools; `get_program_info` schema exposes `program_id`/
`program_name`). Fresh-state loop simulation: the exact disaster now terminates at **iteration 7/50**
(3 executions → blocked → tool disabled at iter 6). Live `localhost:8081` check: program/attribute/
dashboard items match the report and DHIS2 validated the required PI pieces (`V{enrollment_count}`,
`A{WCffUc0Cp2j} == 'MALE'`), confirming the task is now completable end-to-end.

**Also fixed from the same report — 3 of 5 dashboard tiles rendered errors.** Root cause:
`create_visualization` typed every data element as the aggregate `DATA_ELEMENT` dimension without
checking `domainType`, so 3 tiles plotting **TRACKER**-domain data elements (Screening Method Used,
Screening Assessment Result, Treatment Intervention Type) were saved but error at render time.
Fix (`src/tools-metadata.js`): `resolveDataItemTypes` now reads `domainType` and marks tracker DEs
as `TRACKER_DATA_ELEMENT`; `buildVisualizationObject` and the map `create` path refuse them with a
"create a program indicator, then plot that" pointer. Confirmed live on `localhost:8081` that the
three broken UIDs are all `domainType: TRACKER`.

---

## 43. Enhancement workflow: modular-repo skill + live-DHIS2 tool harness

**Files:** `.claude/skills/dhis2-chatbot-performance-enhancement/SKILL.md` (rewritten),
`scripts/live-harness.js` (new), `package.json` (added `live` script), `scripts/verify.js`
(regression assertions added in #42).

The performance-enhancement skill still described the pre-refactor monolith (`background.js` TOOLS
array / dispatch). Rewrote it for the modular `src/*.js` layout and pointed it at the **New Design**
repo, and hardened the mandate to match the user's requirement: only ship improvements (tools /
security / design); never regress anything else; and before keeping ANY change, pass BOTH
`npm run verify` AND a **complex** live-DHIS2 task driven through the real `executeTool` with
**zero errors and zero failed API calls**, cleaning up every test object. Push to the New Design
repo only after a complete pass, on `enhance-performance`, never straight to `main`.

Added `scripts/live-harness.js`: loads the six modules in one VM scope (as the worker does) with a
basic-auth `fetch` shim, so `executeTool(name, args)` runs against a real instance (writes fall
back from `fetchViaTab` to a direct authenticated fetch; `dhis2.writeAuth='broad'`). It records
every HTTP call + status and exposes `summarize()` to tally failures. `npm run live` is a
connectivity smoke test; scenario scripts require it as a library. This is the concrete tool the
skill's Tier-2 protocol points at — it is intentionally NOT part of `npm run verify` (which stays
dependency- and network-free).

**Verification of the #42 fixes with this harness (localhost:8081, program mqAdJnBK2Ve):** a
complex flow — read program structure via `get_program_info(program_id)`; create male/female
enrollment program indicators (server-validated); build a PIE from them; confirm a TRACKER data
element is refused with no write; create a dashboard; `add_items`; `remove_item`; then delete
everything and confirm the instance is left as found — passed **11/11 steps with 0 failed API
calls** across 62 calls.

---

## 44. Complex-program robustness — weak-model recovery so an average LLM finishes with 0 failed API calls

**Files:** `src/tools-programs.js`, `src/core.js`, `src/agent.js`, `src/providers.js`.
Full detail in **`CHANGES_complex_program_robustness.md`**.

Root-caused from a real dead-loop: a very large prompt (the "Diabetes Care & Complications
Tracker" — 6 attributes, 4 stages, 46 DEs, ~20 option sets, 30 rules) on a custom
OpenAI-compatible provider (MiniMax). First `create_program` → `Validation failed with 304
error(s): … Missing required property `name``; then empty `create_metadata` calls (`Missing
required parameter: action`); the circuit breaker **disabled the tool**; the model then spun on
30+ `check_existing` reads and emitted a garbled tool call with leaked `]<]minimax[>[` tokens.

**Harness proof it was the model, not the tool:** the *correct* full payload imports via the real
`executeTool` with **67 API calls, 0 failed, 242 objects** in one atomic call. The guardrails were
turning a recoverable model glitch into an unrecoverable loop. Four fixes:

1. **`create_program` pre-validation** (`validateAndHealProgramInput`, `tools-programs.js`) — a
   zero-API-call pass BEFORE the import: auto-names unnamed rules / inline option sets, collects
   un-inferable gaps (DE/attr missing name or `value_type`, option set with no options) into one
   precise error, and flags a mostly-empty payload as *truncated → resend*. Turns a 304 atomic
   avalanche (3 failed calls + a 409) into one cheap, precise, non-disabling error.
2. **Malformed/empty/truncated calls never disable the tool** (`isIncompleteCallError` +
   non-disabling `incomplete_call_repeat` scope in `core.js`; circuit-breaker exclusion in
   `agent.js`) — the identical/family repeat is still refused, but with "resend the complete call"
   framing that does NOT count toward removing the tool. Genuinely doomed operations still disable.
3. **No-progress discovery-streak guard** (`isDiscoveryCall` / `discoveryStreakStopOrNull` in
   `core.js`; `consecutiveDiscoveryCalls` in `agent.js`) — closes the blind spot where 30+
   read-only calls with DIFFERENT args made no progress; after 12 consecutive reads with no write
   it points the model at the create call and resets on the next successful write.
4. **Recover corrupted streamed tool-call JSON** (`repairToolCallArguments` in `core.js`; used in
   `providers.js`; honest resend in `agent.js`) — replaces the silent `arguments = '{}'` fallback
   that was the root trigger. Strips leaked `]<]word[>[` tokens, balances truncated braces/strings,
   re-parses; unrecoverable → non-disabling "resend / split into smaller calls".

**Verified:** full 30-rule program imports with 0 failed calls; empty-name payload fails with 0
failed calls (was 3+409); heal path creates the auto-named rule (server read-back); the exact
`]<]minimax[>[` corruption is repaired and imports; integrated cascade simulation recovers (tool
never disabled, streak guard fires). `npm run verify` green; instance left exactly as found.

---

## 20. v2.8.15 — `manage_line_lists`: Line Listing authoring + EVENT_VISUALIZATION dashboard tiles

**Files:** `src/tools-linelists.js` (NEW, the tool), `src/registry.js` (schema, router, manual
gate, `KB_LINE_LISTS_DETAILS`, `wantsLineListIntent` selection), `src/tools-metadata.js`
(dispatch; `manage_dashboards` accepts `{type:"EVENT_VISUALIZATION", event_visualization_id}`
items in create_dashboard/add_items), `src/tools-programs.js` (legend-set reference check fixed:
`visualizations?filter=legend.set.id:…` — the old `legendSet.id` path 400s on 2.40+; line lists
now checked too), `background.js` (7th module), `src/agent.js` (progress label),
`scripts/scenario-line-lists.js` (NEW deep test). Details: `CHANGES_line_listing_tool.md`.

The tool authors the saved line lists of the Line Listing app (`/api/eventVisualizations`,
type LINE_LIST): EVENT / ENROLLMENT (cross-stage + repeated-event columns) / TRACKED_ENTITY
output, dimensions by UID or exact name with auto stage/option-code resolution, per-valueType
filter validation, legend wiring, sorting, and a pre-save analytics probe that proves the layout
runs (row_count + headers ONLY — never row-level values). Refuses the traps that silently break
line lists: division PIs (per-row zero denominator 409s the whole table), PI analyticsType ≠
output type, aggregationType NONE (invalid SQL), COUNT+d2:count (constant 1 per row — warns with
the exact SUM fix), repetition on non-repeatable stages, missing time/org-unit dimensions,
invented UIDs/option values, duplicate names.

**Verified live on DHIS2 2.42.5.1:** full senior-implementor TB package (2 row-safe PIs →
legend set → 3 line lists incl. repeated adherence columns [1,2,-1,0] and FIXED FILL legend →
dashboard with 3 EVENT_VISUALIZATION tiles → validate/update/delete-guard → cleanup) — final
scenario run **104 API calls, 0 failed, 38/38 assertions**; 8 negative paths refuse with zero
failing HTTP. Rendering verified visually in the Line Listing + Dashboard apps. `npm run verify`
green. Version 2.8.14 → 2.8.15.
