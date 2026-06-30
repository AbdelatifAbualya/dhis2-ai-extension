# `manage_option_sets` — DHIS2 Option Set lifecycle management

Adds a dedicated tool for managing **option sets** — the reusable, ordered pick-lists
(drop-downs) of `{ code, name }` options that data elements and tracked-entity attributes
reference to constrain input to a fixed set of choices (e.g. *HIV Result:
Positive / Negative / Inconclusive*). `code` is the value stored in data; `name` is the
label shown to users.

## Why

Before this change the chatbot could only:
- create an option set **inline** as part of a *new* data element (`create_metadata`), or
- **convert** (`manage_metadata` → `convert_value_type`) or **delete** (`manage_metadata`) one.

There was **no way** to create a *standalone* option set, **add / remove / reorder** the
options on an existing set, or **rename / retype** a set. `manage_option_sets` closes that
gap and becomes the owner of the standalone option-set lifecycle.

## Actions

| action | what it does |
| --- | --- |
| `list` | Paginated option-set list (`name_filter`, `value_type` filters), with option counts. Read-only. |
| `get` | One option set with its options in display order. Read-only. |
| `create` | New standalone set + options, imported atomically (VALIDATE → COMMIT). `value_type` validated against the DHIS2 enum (defaults to `TEXT`); option codes required and de-duplicated. Supports `dry_run_only`. |
| `add_options` | Append new options to an existing set; rejects codes that collide with existing ones. |
| `remove_options` | Delete options by `option_codes[]` or `option_ids[]` (deletes the Option objects, which auto-detach). Refuses to remove the last remaining option. |
| `reorder_options` | Set display order from `order[]` (codes or UIDs); must cover every current option exactly once. |
| `update` | Patch the set's OWN fields (`name` / `code` / `description` / `value_type`) only — never membership. |
| `delete` | Remove the whole set + its options; refuses with the exact blockers if any data element or TEA still uses it. |

`update` / `add_options` / `remove_options` / `reorder_options` / `delete` each auto-snapshot
a backup first (restore via `manage_backups`).

## Examples

```text
"Create an HIV Result option set with Positive/Negative/Inconclusive"
  → create option_set:{ name:"HIV Result", value_type:"TEXT",
       options:[{code:"POS",name:"Positive"},{code:"NEG",name:"Negative"},{code:"INC",name:"Inconclusive"}] }

"Add a 'Refused' choice to that set"
  → add_options option_set_id:"<id>", options:[{code:"REF",name:"Refused"}]

"Put Negative before Positive"
  → reorder_options option_set_id:"<id>", order:["NEG","POS","INC"]

"Remove the Inconclusive option"
  → remove_options option_set_id:"<id>", option_codes:["INC"]
```

## Relationship to existing tools

- To create an option set as part of a **new data element** in one shot, keep using
  `create_metadata`'s inline `option_set` field.
- To **convert** a set to `MULTI_TEXT` (multi-select) and cascade the change to every DE/TEA
  using it, use `manage_metadata(action=convert_value_type)`.
- `manage_option_sets` owns the **standalone** option-set CRUD that those paths don't cover.

## Safety & wiring

- Wired through every layer: `TOOLS` → `TOOL_ROUTER` → `executeTool` dispatch → handler →
  `getContextualTools` (surfaced only on an explicit, false-positive-free option-set intent;
  added to `writeCapableNames` and to the save-error read-only strip) → `buildSystemPrompt`
  KB block → `panel.js` icon / label / detail.
- Reuses existing shared helpers unchanged (`postMetadataPayload`, `ensureBackupOrBail`,
  `checkMetadataReferences`, `requireWriteAuth`, `verifyTargetExists`, `generateDhis2Uid`,
  `buildDeletionHint`, `safeDhis2Fetch`).

## Verification

Every action's exact API path/payload was proven on the DHIS2 2.43 playground
(`stable-2-43-0-1`) **before** the code was written — atomic create, add, reorder
(sortOrder), remove (direct option DELETE auto-detaches), `:owner`-merge update, and
reference-checked delete — with a `name:like:ZZAITEST` sweep confirming **zero residue**.
`node --check` passes on both files; the intent battery has zero false positives.
