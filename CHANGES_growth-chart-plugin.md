# Change Log — `manage_growth_chart_plugin` tool (WHO Capture Growth Chart setup)

Branch: `enhance-performance`
Manifest version: `2.3.0` → **`2.4.0`**
Tool count: **24 → 25**

Adds a tool to set up the **WHO Capture Growth Chart** plugin end to end. Repo:
<https://github.com/dev-otta/dhis2-who-growth-chart>. Docs:
<https://github.com/dev-otta/dhis2-who-growth-chart/blob/master/docs/using-capture-growth-charts.md>.

---

## 1. What the plugin needs (from the docs, confirmed on the playground)

To render WHO growth charts on a tracker program's **enrollment dashboard** in the new Capture app:

1. **The app installed** — App Hub "Capture Growth Chart", installed key `capture-growth-chart`,
   plugin served at `…/api/apps/capture-growth-chart/plugin.html`.
2. **A dataStore key** — namespace **`captureGrowthChart`**, key **`config`**:

```json
{
  "metadata": {
    "attributes": {
      "dateOfBirth": "<DATE attribute id>",
      "gender": "<gender/sex attribute id>",
      "firstName": "<attribute id>",
      "lastName": "<attribute id>",
      "femaleOptionCode": "<gender option code>",
      "maleOptionCode": "<gender option code>"
    },
    "dataElements": {
      "weight": "<DE id>",
      "height": "<DE id>",
      "headCircumference": "<DE id>"
    },
    "programStageForGrowthChart": { "<programId>": "<programStageId>" }
  },
  "settings": {
    "usePercentiles": false,
    "customReferences": false,
    "weightInGrams": false,
    "defaultIndicator": "wfa"
  }
}
```

   - `defaultIndicator` ∈ `wfa` (weight-for-age), `hcfa` (head-circ-for-age), `lhfa`
     (length/height-for-age), `wflh` (weight-for-length/height).
   - **All three data elements are mandatory** — if any is missing the chart does not display.
   - Optional country datasets go in a sibling key `customReferences`, enabled by
     `settings.customReferences = true`.
3. **The plugin widget added to the enrollment dashboard** — done via the Tracker Plugin
   Configurator app or Capture's "Add plugin" (paste the plugin source URL). This layout lives in
   the Capture-owned `dataStore/capture`; the tool does **not** write it (see §4).

---

## 2. New tool — `manage_growth_chart_plugin`

| Action | Does |
|--------|------|
| `status` | Reports whether the app is installed, the current `captureGrowthChart/config`, and which programs are configured (resolved to names). |
| `install` | Installs the plugin from the App Hub (`POST /api/appHub/{versionId}`, latest version whose min/max DHIS version brackets the server). Idempotent — no-op if already installed. |
| `scaffold_program` | Creates a ready-to-use growth-monitoring tracker program (Person TET, First/Last name + Gender[Male/Female option set] + Date-of-birth attributes, repeatable stage with Weight/Height/Head-circumference DEs) assigned to `org_unit_id`. Reuses standard demo attributes by exact name when present. |
| `configure` | For `program_id` (+ optional `program_stage_id`): auto-detects the DOB + gender attributes, the female/male option codes, and the weight/height/head-circumference DEs (or takes explicit `attribute_ids` / `data_element_ids` / `female_option_code` / `male_option_code`), validates the hard requirements, then writes/**merges** `captureGrowthChart/config`. Infers `weightInGrams` from the weight DE name. Returns a `dashboard_attach` block. |
| `remove` | Removes one program from the config (`program_id`), or deletes the whole key (`confirm_delete_all:true`). |

All write actions are gated by `requireWriteAuth`. `configure` merges into any existing config so
several programs can be configured side by side.

### Auto-detection heuristics (`configure`)
- `dateOfBirth`: program attribute, valueType `DATE`, name ~ `/date of birth|dob|birth/`.
- `gender`: attribute with an option set, name ~ `/gender|sex/`; female/male codes from option
  codes/names (`female` first to avoid the substring clash with `male`).
- `firstName` / `lastName`: optional, name ~ `/first name|given/` and `/last name|surname|family/`.
- `weight` / `height` / `headCircumference`: stage DEs ~ `/weight/`, `/height|length|stature/`,
  `/head circ|circumference|hc/`. If no stage is given, the stage containing the most of the three is chosen.
- `weightInGrams`: `true` when the weight DE name contains "(g)"/"gram" and not "(kg)"/"kilogram".

---

## 3. Files changed

| File | Change |
|------|--------|
| `background.js` | Tool definition before `manage_backups`; `manage_growth_chart_plugin: true` in `TOOL_ROUTER`; `wantsGrowthChartIntent` detection + selection in `getContextualTools`; dispatch in `callTool`; implementation `executeManageGrowthChartPlugin` + helpers (`gcReadConfig`/`gcWriteConfig`/`gcAppStatus`/`gcInstall`/`growthChartConfigure`/`growthChartScaffoldProgram`/`growthChartRemove`/`growthChartStatus`); `wantsGrowthChartPrompt` flag + a system-prompt KB section. |
| `sidepanel/panel.js` | Tool icon (📈), status label, args-detail renderer (action, program, stage, org unit). |
| `README.md` | Tool row 25; tool count 24 → 25 (two places); a known-quirks bullet. |
| `manifest.json` | `version` 2.3.0 → 2.4.0. |
| `changes.md` | Running-log entry #8. |

Purely additive — no existing tool's behaviour was modified.

---

## 4. Design decision — the tool does NOT auto-place the dashboard widget

The plugin only becomes *visible* once its widget is added to the enrollment dashboard. That layout
is stored in the **Capture-owned `dataStore/capture` namespace** with an internal, version-sensitive
schema, and this extension already treats `dataStore/capture/*` writes as dangerous (they can corrupt
the Capture app cache). Reverse-engineering that schema from minified bundles on the playground did
not converge reliably. Rather than risk a bad write, `configure` returns a `dashboard_attach` block
with the exact plugin source URL and the precise steps (Tracker Plugin Configurator, or Capture's
"Add plugin"). Everything that is safe and documented — install + metadata mapping — is fully
automated, which is the part that "must work without issues".

---

## 5. Playground verification (play `stable-2-43-0-1`, DHIS2 2.43.0.1)

1. **Docs** — read `using-capture-growth-charts.md` for the namespace/key/schema and requirements.
2. **Install** — plugin was not installed → `POST /api/appHub/742e72b1-1555-4c7f-aacc-dcf2e6329ce1`
   (v1.2.0) → **201**; `/api/apps` then lists `capture-growth-chart` with its `pluginLaunchUrl`.
3. **Program** — Child Programme lacked a DOB attribute + height/head-circ DEs, so created a clean
   tracker program **Growth Monitoring (Plugin Test)** (`bCdtzjLanGm`, stage `yb00SY11bGc`, 3 NUMBER
   DEs) reusing the demo First/Last/Gender/Date-of-birth attributes via one `/api/metadata` import.
   (Hit and fixed the "Data sharing is not enabled for DataElement" error — DEs use `rw------`,
   program/stage use `rwrw----`.)
4. **Config** — wrote `dataStore/captureGrowthChart/config` → **201**, read back intact.
5. **Data** — enrolled child `n8CBRSd3GyP` with 3 growth measurements (`/api/tracker`, 5 objects, 0 errors).
6. **Tool-path validation** — confirmed every call the tool makes works under the versioned
   `/api/43/` prefix `safeDhis2Fetch` builds (`apps.json`, `appHub/v2/apps`,
   `categoryCombos?filter=isDefault:eq:true`, `programs/{id}`), and that the auto-detection
   heuristics resolve the correct IDs on the test program (dob=`iESIqZ0R0R0`, gender=`cejWyOfXge6`
   with Female/Male codes, weight=`prpD74gstSP`, height=`PmQq3DvcF1O`, headCirc=`JScoCvMa9UM`,
   weightInGrams=false from "GC Weight (kg)").

**Not visually confirmed:** the rendered chart on the enrollment dashboard, because that requires
the widget placed on the dashboard (the manual/configurator step the tool guides) and the Capture UI
was not drivable in the automated session. The functional contract is verified end to end.

The test setup (installed plugin, program `bCdtzjLanGm`, config, enrolled child) was left in place on
the playground so it can be inspected.

`node --check background.js` and `node --check sidepanel/panel.js` both pass.
