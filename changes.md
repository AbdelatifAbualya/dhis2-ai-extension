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

**Files:** `background.js`, `sidepanel/panel.js`, `manifest.json` (2.6.6 → 2.6.7). See `CHANGES_dashboards.md` for the full writeup.

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

**Files:** `background.js`, `README.md`, `manifest.json` (2.6.7 → 2.6.8). See `CHANGES_e2e-audit-2026-07.md` for the full audit story (WHO-ANC-DAK program built end-to-end on play 2.42.5.1 through the real tool layer).

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
