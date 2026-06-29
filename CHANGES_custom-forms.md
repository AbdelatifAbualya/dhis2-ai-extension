# Change Log — Custom Forms tool + 50-iteration agentic loop

Branch: `enhance-performance` → PR #3 into `main`
Manifest version: `2.1.8` → **`2.2.0`**
Tool count: **22 → 23**

This document records everything changed in this round of work, file by file, and the
live verification behind it. (The repo's running log is `changes.md`; this file is a
self-contained summary of this feature.)

---

## 1. New tool — `manage_custom_forms`

Authors **custom (HTML) data-entry forms** for **two** target types:

| Target | Pass | Renders in |
|--------|------|------------|
| dataSet | `dataset_id` | new Aggregate Data Entry app |
| tracker/event **program stage** | `program_stage_id` | new Capture app |

### Actions
- `get` — inspect the current form (formType, linked dataEntryForm id/name/style, parsed input ids, html preview).
- `preview_html` — auto-generate a clean table-based form skeleton from the target's data elements and **return it without saving**.
- `set_dataset_form` / `set_stage_form` — create/replace the form and flip `formType` to `CUSTOM`. Pass `html_code`, or omit it to auto-generate.
- `remove_form` — unlink the form and revert `formType` (DEFAULT/SECTION); optional `delete_form_object` to also delete the orphaned dataEntryForm.

Reuses the existing safety rails: per-turn **write-authorization gate** (`requireWriteAuth`),
**verify-before-modify 404 guard** (`verifyTargetExists`), and **auto-backup** before every
write (`ensureBackupOrBail`).

### Input-id binding (the only thing that makes a cell save)
- dataset cell: `<input id="<dataElementUID>-<categoryOptionComboUID>-val" title="" value="">`
- stage cell: `<input id="<programStageUID>-<dataElementUID>-val" title="" value="">`

Everything else in the HTML (tables, headings, narrative text) renders verbatim; the apps
swap the bound `<input>`s for native widgets.

### DHIS2 quirks encoded (discovered live on 2.43 — see §4)
1. A `dataEntryForm` **cannot be embedded inline**. Embedding `{name, htmlCode}` in a
   dataSet/programStage payload — via the `/api/metadata` importer **or** a direct object PUT —
   fails with **E5002 "Invalid reference (DataEntryForm)"**. The tool always `POST`s the form
   standalone to `/api/dataEntryForms` first, then references it by id.
2. **Linking to a program stage** drops the `program` reference on a PATCH or naive PUT
   ("Program stage must reference a program") because `GET ?fields=:owner` omits `program`.
   The tool does a full PUT that **re-attaches `program:{id}`** explicitly. Datasets link
   cleanly via PATCH.
3. A dataset custom form only accepts data entry when sharing is `rwrw----` (data write) **and**
   at least one org unit is assigned — surfaced as `_hints` (the fix stays with `manage_datasets`).

### Files touched
| File | Change |
|------|--------|
| `background.js` | New tool definition in the `TOOLS` array (after `manage_datasets`); `manage_custom_forms: true` in `TOOL_ROUTER`; dispatch in `executeTool`; ~430-line handler block (`executeManageCustomForms` + helpers: `buildCustomFormHtml`, `resolveCustomFormTarget`, `buildDatasetFormGroups`, `buildStageFormGroups`, `upsertDataEntryForm`, `getCustomForm`, `previewCustomFormHtml`, `setDatasetCustomForm`, `setStageCustomForm`, `removeCustomForm`); contextual selection in `getContextualTools` (dataset/tracker/form-design intent; stripped in read-only save-diagnosis; counted write-capable); a "Custom (HTML) Forms" KB block in `buildSystemPrompt`. |
| `sidepanel/panel.js` | 📝 icon in `iconMap`, "Designing custom form" in `toolLabels`, and a tool-card detail branch. |
| `README.md` | New row #23 in the tools table; a quirks bullet; tool-count and version references. |

---

## 2. Agentic loop cap raised 30 → 50

`background.js` — the main agentic loop changed from `for (let i = 0; i < 30; i++)` to
`for (let i = 0; i < 50; i++)`. Each pass is one think→tool-call→read-result cycle; the higher
cap lets longer multi-step authoring flows finish before the "Reached maximum iterations"
fallback triggers. No tool/prompt/response logic changed. README + `changes.md` updated.

---

## 3. Version + docs

- `manifest.json`: `2.1.8` → `2.2.0` (publish workflow only fires on `v*` tags, so this does not auto-publish).
- `README.md`: tool count 22 → 23, "up to 50 iterations", file-layout version note.
- `changes.md`: appended entries #3 (loop) and #4 (new tool).

---

## 4. Live verification (DHIS2 2.43 — play `stable-2-43-0-1`, admin/district)

Behaviour was confirmed end-to-end **before** writing the tool, and each API path the tool uses
was exercised:

- Created a custom **dataset** form (`POST /api/dataEntryForms` → `PATCH /api/dataSets/{id}` set
  `formType=CUSTOM` + `dataEntryForm`) → it rendered in Aggregate Data Entry, and a value typed
  into the custom cell **persisted** (`/api/dataValueSets` returned it).
- Created a custom **program-stage** form on a throwaway event program (`POST
  /api/dataEntryForms` → full `PUT /api/programStages/{id}` with `program:{id}` re-attached) →
  it rendered natively in Capture.
- Confirmed the **update path**: `PATCH /api/dataEntryForms/{id}` updates `htmlCode`/`style`.
- All test metadata was deleted afterward (one orphaned demo data value couldn't be removed once
  its dataset was gone — harmless on a self-resetting demo).

### Verification commands
```
node --check background.js          # pass
node --check sidepanel/panel.js     # pass
python3 -c "import json;json.load(open('manifest.json'))"   # valid
```
