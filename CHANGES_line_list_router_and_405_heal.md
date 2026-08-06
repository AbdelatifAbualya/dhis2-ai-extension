# v2.8.24 — the line-list tool that *looked* like a misroute, and two defects the deep test found

Three independent fixes, all triggered by one live report: after a working
"create a visualization and a dashboard" turn, the follow-up "now use line
listing instead" appeared to route to the wrong tool.

---

## 1. `manage_line_lists` was invisible to the side panel

**Files:** `sidepanel/panel.js`
**Reported:** 2026-08-02 (live transcript, MCH Dashboard Test)

### The symptom

The user asked for a line listing. The side panel rendered:

```
🔍  Querying DHIS2
    {"action":"create","name":"Live births & abortions by month…"} | Loaded usage manual
```

That reads as: *the router picked `dhis2_query` for a line-list job.* It is also
what the user reported — a tool-router bug.

### What was actually happening

The router was correct. Proof is in the same transcript: `dhis2_query` renders
with the label **"Querying DHIS2 API"**, and these cards said **"Querying
DHIS2"** — the *fallback* string. And `dhis2_query` is not a `MANUAL_TOOLS`
member, so it can never answer "Loaded usage manual". The tool executing was
`manage_line_lists` all along.

Confirmed mechanically by replaying the exact user turn through
`getContextualTools`:

| pageContext appType | `manage_line_lists` offered? |
|---|---|
| Dashboard | ✅ |
| Data Visualizer | ✅ |
| Maintenance | ✅ |
| Capture | ✅ |
| (none) | ✅ |

The bug was purely presentational, and entirely in `sidepanel/panel.js`:
`manage_line_lists` was missing from **both** lookup tables and had **no**
detail-formatter branch. All three fell through to generic fallbacks — one of
which was the string `'Querying DHIS2'`.

### The fix

- Added `manage_line_lists` to `iconMap` (`📋`) and to `toolLabels`
  (**"Building line lists"**).
- Added a detail-formatter branch so the card shows
  `create, "VPD case register", ENROLLMENT, program: aBc…, 7 column(s), 2 filter(s)`
  instead of a raw truncated JSON blob.
- Added a missing `resolve_option_codes` detail branch (found by the new guard
  below).
- **Changed the fallback label** from `'Querying DHIS2'` to a humanized version
  of the real tool name (`manage_line_lists` → `Manage line lists`). Naming a
  *specific* tool in the fallback is what turned a missing map entry into a
  false bug report. The fallback icon moved from 🔍 (identical to
  `dhis2_query`'s) to 🛠️ for the same reason.

### Why it can't drift again

`scripts/verify.js` now pins the panel to the router. `TOOL_ROUTER` is exposed
to the verifier and every routable tool must appear in `iconMap`, in
`toolLabels`, and in the detail chain:

```
Side-panel tool presentation:
  ✓ panel iconMap covers all 33 routable tools
  ✓ panel toolLabels covers all 33 routable tools
  ✓ panel detail formatter covers all 33 routable tools
```

Adding a tool to `TOOL_ROUTER` without teaching the panel to render it now
turns `npm run verify` red.

---

## 2. A stage the user called "repeatable" silently shipped one-event-only

**File:** `src/registry.js` (both stage schemas: `stages[]` for
`create_program`, `stage` for `add_stage`)
**Found by:** the deep test, turn 1

### The symptom

The turn-1 prompt said *Stage 2 "MCSR Treatment" (repeatable)*. The program
imported with that stage **non-repeatable**. The model only caught it because
it happened to self-verify afterwards, then spent two extra calls PATCHing
`repeatable: true` back on.

### Cause

The executor honors `stage.repeatable` correctly. The *schema* declared it as:

```js
repeatable: { type: 'boolean' },
```

— no description. `create_metadata` is a `MANUAL_TOOLS` member, so its wire
schema is slimmed and nested objects go through `schemaSkeleton()`, which
strips descriptions entirely. The full manual is rendered by
`renderParamDocs()`, which *does* recurse into nested items and print
descriptions — but with none to print, the manual line read:

```
- `repeatable` (boolean)
```

So neither tier ever connected the user's word "repeatable" to this field.

### The fix

Both schemas now carry an explicit, imperative description, which
`renderParamDocs()` surfaces in the manual the model is guaranteed to read
before its first real `create_metadata` call:

```
- `repeatable` (boolean): TRUE when this stage can hold MANY events per
  enrollment (follow-up visits, repeat lab tests, treatment courses). Defaults
  to false — so if the user described the stage as repeatable/recurring/"one
  per visit", you MUST pass repeatable:true HERE. Setting it afterwards needs a
  separate stage update.
```

### Docs were not enough — the mechanical half

A second live run with the improved manual **still** dropped the flag, and that
time the model never noticed: the wrong program shipped silently. So the fix
could not stay advisory.

A direct executor probe proved the tool itself was innocent — passing
`repeatable:true` reaches the wire intact:

```
captured programStages payload:
 [{ "name": "Probe Stage One", "repeatable": false },
  { "name": "Probe Stage Two", "repeatable": true  }]
```

The problem is that `repeatable` **defaults to false**, so an omitted flag is
byte-identical to a deliberate `false`. DHIS2 raises no error — it just refuses
the second event weeks later, in production.

`create_program`'s result now states the resolved value per stage and tells the
model to check it while the user's request is still in context
(`src/tools-programs.js`):

```
_stage_repeatability: "MCSR Case Detection: repeatable=false; MCSR Treatment: repeatable=false; …"
_verify_repeatability: "CHECK NOW against what the user asked for … fix it immediately with
   dhis2_query(path='programStages/<id>', method='PATCH', body:{repeatable:true}) — a PATCH is
   safe because it touches only that field (a PUT would wipe the stage's sections)."
```

The PATCH route in that hint is **verified working** against the live instance
(200, auto-backup taken, the stage's 4 data elements and `formType` untouched).
It is deliberately not `manage_metadata(action="update")` — that action does not
exist, and the first draft of this hint pointed at it until a live call returned
*"Unknown action: update"*.

**Result, live:** the model now goes `create_program` → `PATCH repeatable:true`
→ `verify`, with **no discovery call in between** — it reads the flag straight
out of its own tool result. Final state:

| Stage | repeatable | requested |
|---|---|---|
| MCSR Case Detection | false | ✅ |
| MCSR Treatment | **true** | ✅ |
| MCSR Day 28 Outcome | false | ✅ |

---

## 3. `GET /api/optionSets/A,B,C` → HTTP 405 (the multi-UID path heal)

**Files:** `src/core.js` (new `healMultiUidPath`), `src/tools-metadata.js`
(`dhis2_query` executor), `scripts/verify.js`
**Found by:** the deep test, turn 2

### The symptom

One failed API call in an otherwise clean turn:

```
→ dhis2_query {"path":"optionSets/qP6eFxS2QfQ,G26Oi8VjeXV,sSgEHRhCkjR?fields=id,displayName,options[code,name]"}
✗ DHIS2 API 405: Request method 'GET' is not supported
```

The model then recovered with three separate single-UID fetches — so four
round-trips, one of them a hard failure, for what is one query.

### Cause

`/{resource}/{id}` routes to DHIS2's single-object handler. A comma-separated
list is not a valid id, so Spring resolves the route differently and answers
**405**, not 404 — which reads like "wrong verb" rather than "wrong URL shape"
and gives the model nothing to correct against. Fetching several objects by id
requires the collection form: `?filter=id:in:[…]`.

This is the same class as the existing
`programIndicators/{expression|filter}/description` GET→POST heal a few lines
above: the intent is unambiguous, so run the correct request instead of
returning an error.

### The fix

New pure helper in `src/core.js`:

```js
healMultiUidPath('optionSets/qP6eFxS2QfQ,G26Oi8VjeXV,sSgEHRhCkjR?fields=id,displayName', 'GET')
// → 'optionSets?fields=id%2CdisplayName&filter=id%3Ain%3A%5BqP6eFxS2QfQ%2C…%5D&paging=false'
```

`dhis2_query` applies it to `safePath` before dispatch. Verified live against
`localhost:8081`: **HTTP 200, all 3 option sets in one call.**

Percent-encoding is deliberate — self-hosted Tomcat rejects raw `[` / `]` in a
query string (see `CHANGES_*` on strict URL handling), so the
`URLSearchParams` round-trip is what makes the healed URL portable.

### Guard rails

It fires only when **the comma list is the entire second path segment** and
**every token is a real 11-char DHIS2 UID**. `npm run verify` pins each
boundary:

| Input | Result |
|---|---|
| `optionSets/A,B,C?fields=id,displayName` | rewritten, fields + `paging=false` preserved |
| `optionSets/qP6eFxS2QfQ?fields=id` | untouched (single UID) |
| `dataValueSets/a,b?x=1` | untouched (not UIDs) |
| `programs/A,B/metadata` | untouched (sub-resource) |
| `optionSets/A,B` with `POST` | untouched (non-GET) |
| `dataElements/A,B?filter=name:like:x` | both filters kept |

---

## 4. "It finds the stage for a bit, then loses it"

**Files:** `src/agent.js` (3 sites), `scripts/scenario-sticky-context.js` (new),
`scripts/verify.js`
**Reported:** 2026-08-06 — *"the context for what program I am in and what stage
is not persistent; the chatbot finds it for a bit then loses it, so if I ask
what stage I am in, the chatbot doesn't know it"*

### Why v2.8.23's sticky-context fix wasn't enough

v2.8.23 added `carryStickyContext()` so a URL re-parse could not erase a
resolved program/stage. That logic is correct and still passes its tests. But it
only ever wrote to **memory**.

Chrome terminates the MV3 service worker after ~30 s idle and rebuilds `dhis2`
from `chrome.storage.session`. `pageContext` *is* in the persisted snapshot —
but three sites assigned it without calling `saveState()`:

| Site | What it holds that nothing else can recover |
|---|---|
| `DHIS2_STAGE_DETECTED` handler | the content script's DOM/URL stage detection — Capture's enrollment-dashboard URL carries **no** stageId, so no re-parse can rebuild it |
| `syncFromTab()` | the sticky carry applied on every tab/window focus change |
| chat-turn rebuild (`else` branch) | the sticky carry when neither app type nor org unit changed |

So the sequence the user saw was exactly:

1. Open a stage in Capture → detected → panel shows it. *"finds it for a bit"*
2. ~30 s idle → **worker terminated**.
3. Ask "what stage am I in?" → worker restarts, restores a snapshot that never
   received the stage → gone. *"then it loses it"*

The system prompt was never the problem: `buildSystemPrompt` already emits
**`Current Stage: <name> (<uid>)`** whenever `ctx.stageId` is set — it just kept
being unset.

### The fix

`saveState()` after each of the three assignments. The chat-turn rebuild gained
an explicit `else` branch so *every* path persists, not just the two org-unit
ones.

### Proof — `scripts/scenario-sticky-context.js` (`npm run sticky`)

Boots the **real** background bundle twice against one shared session store —
which is precisely what a worker restart is — and asserts the context survives:

```
Sticky page context across a service-worker restart:
  ✓ content script detection sets the stage in memory
  ✓ detected stage is written to chrome.storage.session
  ✓ stage survives the restart — "what stage am I in?" still answerable
  ✓ program survives the restart
```

The test was confirmed to actually catch the bug: with the new `saveState()`
removed it reports `persisted to session: (nothing saved)` →
`worker#2 after restart: undefined` → **FAIL**.

`npm run verify` additionally pins all three call sites structurally, so
re-introducing an in-memory-only `pageContext` write turns the health check red.

---

## Live acceptance

Model: `accounts/fireworks/models/deepseek-v4-flash-0731` (Fireworks), driven
through the **real** agentic loop (`scripts/llm-run.js` → `runAgenticLoop`)
against a live DHIS2 2.42 at `localhost:8081`.

Four-turn scenario, conversation persisted across turns, deliberately shaped
like the original report — build, then indicators, then dashboard, then *"do
the same thing but instead of a visualization, create a line listing … and add
it to the same dashboard"*.

See `changes.md` for the run totals.
