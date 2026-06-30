# New tool: `manage_legend_sets` (DHIS2 legend sets — colour-coded value bands)

**Version:** 2.4.4 → 2.4.5
**Branch:** `enhance-performance`
**Type:** Added — new tool, purely additive (no existing behaviour changed).

## Why

DHIS2 *legend sets* turn raw numbers into a traffic-light / heat-map scale: an
ordered list of colour **bands** (e.g. ANC coverage shaded red 0–50, amber 50–80,
green 80–100) that data elements, indicators, visualisations and maps reference for
their colouring. The extension could already *read* legend sets (inside
`get_map_details`) but had **no way to author them** — no create, no band edits, no
rename, no delete. `manage_legend_sets` closes that gap and rounds out the
analytics-styling story alongside the existing read-only map/visualisation tools.

## What it does

Seven actions:

| Action | Purpose |
| --- | --- |
| `list` | Paginated legend-set list (optional name filter). Read-only. |
| `get` | One set with its bands in value order; warns about any overlaps. Read-only. |
| `create` | New set + bands, atomic VALIDATE→COMMIT. Explicit `legends[]` **or** `auto_bands`. |
| `add_legends` | Append bands to an existing set (unique names enforced). |
| `remove_legends` | Drop bands by name or UID; refuses to remove the last band. |
| `update` | Patch the set's own fields (name / code) only — never the bands. |
| `delete` | Remove the whole set (legends cascade); reference-checked. |

### Bands and ranges
- Each band is `{ name, startValue, endValue, color? }`.
- Ranges are **half-open `[startValue, endValue)`**: `endValue` must be `> startValue`,
  and one band's `endValue` may equal the next band's `startValue` without overlapping.
- `color` is an optional 6-digit hex; `"rrggbb"`/`"#rrggbb"` are canonicalised to `#RRGGBB`.
- **Overlaps are warned about, never blocked** — this mirrors DHIS2's own server, which
  accepts overlapping/gapped bands.

### `auto_bands` generator
`create` with `auto_bands:{ start, end, count }` generates `count` equal-width,
contiguous, gap-free bands spanning `start`→`end`, default-coloured on a red→amber→green
(low→high) ramp. Endpoints are pinned exactly so floating-point drift never leaves a gap.
`auto_bands.colors` / `auto_bands.names` (length must equal `count`) override the defaults.

```
"Make a coverage legend, red→green, 0 to 100 in 5 bands"
 → create legend_set:{ name:"Coverage 0–100" }, auto_bands:{ start:0, end:100, count:5 }
```

## Safety rails (all reused, none modified)
- **Write-auth gate** on every mutating action (`requireWriteAuth`).
- **Auto-backup before every mutation** (`ensureBackupOrBail`); the `:owner` snapshot
  includes the embedded legends, so restore via `manage_backups` is complete.
- **Existence check** before update/delete (`verifyTargetExists`).
- **Reference-checked delete** — a new `legendSets` branch in `checkMetadataReferences`
  blocks deletion (with the exact blockers) when any data element, indicator,
  visualisation or map still uses the set, using **distinct ref keys** so it never
  collides with the option-set reference logic.
- **Atomic import** via the shared `postMetadataPayload` (VALIDATE then COMMIT).

## Wiring (every layer)
`TOOLS` array → `TOOL_ROUTER` → `executeTool` dispatch → `executeManageLegendSets`
handler → `getContextualTools` (surfaced only on `wantsLegendSetIntent`; added to
`writeCapableNames`; added to the save-error read-only strip list) →
`buildSystemPrompt` (Legend Sets KB gated on `wantsLegendSetPrompt`) → `sidepanel/panel.js`
(iconMap `🎨`, toolLabels, detail renderer).

## Verification (playground `stable-2-43-0-1`, DHIS2 2.43)
Proven by curl with the tool's exact paths/payloads:
- Atomic create (legends embedded) — VALIDATE OK → COMMIT OK; read-back matched.
- Colour confirmed **optional** (band with no colour → `color:null`).
- `add_legends` via `:owner` re-import grew 3→4 bands.
- `remove_legends` via shrunk `:owner` re-import **deleted** the dropped band with no
  orphan (no standalone `/api/legends` collection in 2.43 — confirmed 404).
- `update` PUT `:owner` rename OK.
- `delete` via `metadata?importStrategy=DELETE` → `deleted:1` (legends cascade).
- Overlap deliberately introduced → VALIDATE still OK (so the tool warns, not blocks).
- All four delete reference filters validated against a real in-use legend set.
- `auto_bands` unit-tested in Node (contiguous, endpoints exact, ramp, colour override
  + bad-colour rejection).
- `name:like:ZZAITEST` + `code:like:ZZAITEST` sweep → **zero residue**.
- `node --check` passes for both files; intent battery (22 phrases) → zero false positives.

## No regression
Strictly additive. The only diff deletions are a one-line `writeCapableNames` reflow and
the version bump. Shared code is touched only by adding mutually-exclusive branches
(`checkMetadataReferences`, `buildDeletionHint`) that leave every existing path
byte-identical. The new contextual intent only *adds* the tool on genuine legend-set
turns and never crowds or removes another tool.
