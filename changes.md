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
