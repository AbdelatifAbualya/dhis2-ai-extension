# Section-safe stage edits — never wipe sections when adding/removing stage data elements

**Date:** 2026-07-20
**Branch:** New-Design
**Files:**
- `src/tools-programs.js` — `addDataElementsToExistingStage()`, `executeManageMetadata()` → `remove_from_stage`
- `src/registry.js` — `create_metadata` schema (`section_name`, `section_id`) + `KB_CREATE_PROGRAM_DETAILS` manual

## The bug

Asking the assistant to **add a data element to a stage** very commonly flipped the
stage form from **SECTION → DEFAULT** and **deleted every section**. Re-adding the
sections afterwards created them with **new UIDs**, so anything referencing the old
section ids (program rules, layout) broke. And because the add path took **no
backup**, the original sections were unrecoverable.

## Why it happened

`PUT /api/programStages/{id}` replaces the **entire** object. Both the add path and
the `remove_from_stage` path sent only:

```
name, program, sortOrder, repeatable, programStageDataElements
```

Omitting `formType` and `programStageSections` told DHIS2 to drop all sections and
reset the form to DEFAULT. The add path additionally never called the backup layer.

## The fix

### `add_data_elements_to_stage`
1. **Backup before mutating** — `ensureBackupOrBail` snapshots the stage + the
   target section first (same guarantee `remove_from_stage` already had).
   Bypass only with `skip_backup:true`.
2. **Preserve the form** — fetch and echo back `formType` + the existing
   `programStageSections` id-refs in the PUT. Sections are never deleted.
3. **Route the new field to the correct section** — new `section_name` /
   `section_id` params. The new DE is added to the chosen section (other DEs kept
   via a `:owner` fetch). One section → auto-used. Multiple sections and none
   named → the tool **STOPS** and returns the section list rather than orphaning
   the field or wiping sections. DEFAULT (non-sectioned) stages behave as before.

### `remove_from_stage`
Same `formType` + section-ref preservation, and it strips the removed DE from any
section that referenced it (a section may not point at a non-PSDE), backing up each
affected section too.

## Response additions
`form_type`, `sections_preserved`, `section_placement`, and a `backup` block.

## Model guidance
`create_metadata`'s first-call manual now states the action always backs up and
preserves sections, and that a multi-section SECTION stage requires `section_name`.

## Verification
- `npm run verify` — all pass.
- `test-add-de-sections.js` (sandboxed bundle, mocked `safeDhis2Fetch` + snapshot),
  4 cases / 31 checks all pass:
  - sectioned add preserves both sections + formType, routes the DE into the named
    section, backs up first (targeting stage + section);
  - ambiguous-section add performs ZERO writes and lists the sections;
  - DEFAULT stage still backs up and adds the DE;
  - `remove_from_stage` keeps the sectioned form and strips the DE from its section.
