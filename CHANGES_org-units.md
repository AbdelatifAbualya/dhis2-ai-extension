# Feature — `manage_org_units`: DHIS2 organisation-unit hierarchy CRUD

## Summary

Adds a first-class tool for authoring the **organisation-unit hierarchy** — the tree of
countries / districts / chiefdoms / facilities that every program, dataset, data value and
enrollment in DHIS2 is attached to. Before this, the chatbot could *read* org units but had no
dedicated way to create, rename, move (re-parent), or delete one; the only path was hand-rolled
`/api/metadata` bodies via `dhis2_query`, with none of the safety rails the other manage_* tools
provide.

## Actions

| action | what it does |
| ------ | ------------ |
| `list`   | Paginated list with optional `name_filter`, `level`, `parent_id` filters. Returns id, name, level, path, parent, child count, opening/closed dates. |
| `get`    | One unit in full: parent (id/name/level), child count, dates, description/comment, contact info (address, email, phone, contact person, url), feature type, access. |
| `create` | New child unit under a parent. Requires `org_unit.name`, `org_unit.parent_id`, `org_unit.opening_date`. |
| `update` | Patch any field and/or **move** the unit by supplying a new `parent_id`. Auto-backup first. |
| `delete` | Remove a **childless leaf** unit. Auto-backup first; DHIS2 blocks units still holding data. |

## Why it is correct and safe

### `level` and `path` are derived, never set
A unit's `level` and `path` are computed by DHIS2 from its parent. The tool passes only
`parent: { id }` and lets the server derive the rest. A child of a level-3 chiefdom becomes
level 4 with `path = parentPath + "/" + newId` automatically. The tool description and KB make
this explicit so the model never tries to set or "fix" level/path by hand.

### create — parent verified up-front
`createOrgUnit` GETs the parent first: a missing parent returns a clear 404 with a hint to look
it up via `list` / `search_metadata`, and the success result reports the derived level. The
import still goes through the shared `postMetadataPayload` VALIDATE-then-COMMIT path, which is the
backstop for a reference that disappears between the probe and the commit (E5002). Dates accept
`YYYY-MM-DD` (normalized to the full ISO form) and are validated before any write.

### update / move — cycle guard before any mutation
Supplying `org_unit.parent_id` on update re-parents the unit (and DHIS2 recomputes level/path for
the whole subtree). Before snapshotting or writing, the tool:
- rejects setting a unit as its own parent,
- GETs the target parent and rejects a move **under the unit's own descendant** (detected by
  checking whether the target's `path` contains the unit's id) — preventing a hierarchy cycle.

Only then does it `ensureBackupOrBail` and PUT the `:owner` object.

### delete — children check + exact blocking reason
A non-leaf unit is refused up-front with its child count and instructions to re-parent or delete
the children bottom-up first (this also avoids snapshotting a node that can't be removed). For a
leaf, the tool takes a backup, deletes via `metadata?importStrategy=DELETE&atomicMode=ALL`, and if
DHIS2 still reports `deleted:0` it surfaces the precise `errorReports` message (E4030 "associated
with another object", captured data values, program/dataset assignment, user org-unit scope)
instead of a generic failure.

## Wiring (every layer)

`TOOLS` array → `TOOL_ROUTER` → `executeTool` dispatch → `executeManageOrgUnits` / `createOrgUnit`
→ `getContextualTools` (gated on a conservative `wantsOrgUnitIntent`; adds `search_metadata`;
added to `writeCapableNames` and to the save-diagnosis read-only strip) → `buildSystemPrompt`
(Org-Unit KB gated on `wantsOrgUnitPrompt`) → `sidepanel/panel.js` (iconMap `🏢`, toolLabels,
detail renderer).

## No-regression notes

- **Purely additive.** No shared helper was modified — the tool only *calls* `safeDhis2Fetch`,
  `requireWriteAuth`, `verifyTargetExists`, `ensureBackupOrBail`, `checkMetadataReferences`,
  `buildDeletionHint`, `postMetadataPayload`, `generateDhis2Uid` with their existing signatures.
- **Conservative routing.** A 25-phrase test confirms all 13 org-unit phrasings trigger the tool
  and all 12 unrelated analytics phrasings do **not** (zero false positives), so existing tools
  are never crowded or mis-routed. `organisationUnits` is already a `backupableType`, so the
  backup/restore machinery supports the tool with no change.

## Verification (DHIS2 2.43 playground, `stable-2-43-0-1`)

- create under a level-3 chiefdom → level auto-derived to 4, path auto-derived ✓
- bad parent → E5002 "Invalid reference" rejected ✓
- rename + closedDate via `:owner` PUT ✓
- re-parent a child between two parents → path/level recomputed for the moved node ✓
- parent-with-children delete blocked (E4030) ✓
- clean leaf delete (`deleted:1`) → read-back 404 ✓
- every test object removed; name sweep shows zero residue ✓
- `node --check` passes for both files; 25-case intent test passes ✓
