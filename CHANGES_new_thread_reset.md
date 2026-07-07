# New-thread history & context reset (v2.8.3)

## The bug

Starting a new thread did **not** erase the previous conversation, so the model
silently continued an old task — even across servers.

Reproduction the user hit:

1. On DHIS2 server **A**, ask the assistant to create a tracker program (it does).
2. Open a **completely new panel / new thread** (possibly pointed at server **B**).
3. Ask it to "complete a task" → the model resumes the **old tracker-program task
   from server A** instead of treating this as a fresh request.

## Root cause

The model's memory lives in the background service worker as
`conversationHistory`, and is persisted to `chrome.storage.session`
(`chatHistory`). `chrome.storage.session` is scoped to the **browser profile**
and survives:

- side-panel close/reopen,
- opening the panel in another window,
- service-worker restarts.

But the side panel **never renders prior messages on load** — a fresh panel
always shows the empty welcome screen. So the panel *looked* empty while the
background still held the full old conversation. History was only ever cleared
when the user explicitly clicked **"+"** (`CLEAR_HISTORY`), and even that clear:

- left task-specific cached DHIS2 context intact (`programMetadata`,
  `ouContext`, `visualizationContext`, `mapContext`, `pageContext`,
  `lastFacilityOu`, `datasetContext`), and
- only reset `conversationHistory` + `prefetchedIds`.

Result: a "new" panel/thread inherited the old task, and the first message the
user sent was appended to the old history (`messages = [system,
...conversationHistory, userMsg]`), so the model continued the old task.

## The fix

A new thread now means a new thread — always, everywhere.

### 1. `CLEAR_HISTORY` is a full new-thread reset — `background.js`

New `clearConversationState()` wipes **all** conversational memory *and* the
task-specific cached context, then persists the cleared state:

```
conversationHistory = []; prefetchedIds = { viz:null, map:null }; lastUserText = '';
dhis2.programMetadata = dhis2.programRulesCount = dhis2.ouContext =
  dhis2.visualizationContext = dhis2.mapContext = dhis2.datasetContext =
  dhis2.lastFacilityOu = null;
dhis2.pageContext = {};
dhis2.knownIds = dhis2.knownIcons = dhis2.recentCreations = null; dhis2.knownIdsSeedSize = 0;
```

It deliberately **keeps the connection identity** (`baseUrl`, `apiVersion`,
`systemInfo`, `connected`, `ouMaxLevel`, `metadataAuditSupport`) so reconnecting
is instant; the nulled caches above are re-fetched fresh by `initializeFromUrl`
on the next `INITIALIZE`/`CHAT_MESSAGE` — satisfying "context must be fetched
again."

The `CLEAR_HISTORY` message handler now calls this and responds when done.

### 2. Every fresh panel performs the reset before connecting — `sidepanel/panel.js`

`init()` now sends `CLEAR_HISTORY` (awaited) **before** `connectOrPromptGrant()`.
Because the panel never restored the visible conversation on load anyway, every
fresh panel already looked like a new thread to the user — now the model's hidden
memory matches. Doing it before connect means the subsequent `INITIALIZE`
re-fetches context cleanly.

### 3. Restoration race guard — `background.js`

On a cold service-worker start, an async IIFE rehydrates `chatHistory` and the
`dhis2` snapshot from session storage. If a new-thread reset fired while that
`get()` was in flight, the restore could resurrect the old thread on top of the
freshly-cleared one. A module-level `historyExplicitlyCleared` flag now makes the
restore **bail entirely** once a reset has run in this SW lifetime. (The flag is
module-scoped, so it resets to `false` on the next cold start — a genuine
SW-restart mid-task still restores the *current* thread from storage.)

### 4. Epoch guard against a straggling turn — `background.js`

If a generation from the **old** thread is still running when the reset happens
(panel reopened / "+" clicked mid-generation), its turn-end
`conversationHistory.push(...)` would re-seed the new thread with the old task.
A module-level `conversationEpoch` is bumped on every reset; the agentic loop
snapshots it at turn start (`turnEpoch`) and **drops the turn** at every
persistence site if the epoch changed:

```
if (turnEpoch !== conversationEpoch) return { text: '', charts, streamed: false, aborted: true };
conversationHistory.push(...turnHist);
```

All four persistence sites in `_runAgenticLoopInner` (empty-response bail, normal
completion, budget-exhaustion summary) are guarded.

## Behavior after the fix

- Click **"+"** → conversation + task context wiped; next message starts clean.
- Open a **new panel / new thread** (same or different server) → old task is gone;
  context is re-fetched from the active tab.
- **Same-instance** new thread → also wiped (the reset is unconditional on panel
  open).
- SW dies mid-task with the panel still open → the *current* thread is correctly
  restored (only a genuine new-thread action wipes it).

## Verification

- `node --check background.js` and `node --check sidepanel/panel.js` pass.
- Standalone logic simulation of the two guards (restoration race + epoch drop)
  plus the legitimate-restore and normal-turn paths — all assertions pass:
  - old conversation & context NOT resurrected after a racing reset,
  - legitimate restore still works when no reset raced,
  - stale turn dropped; new thread stays empty,
  - normal turn still persists.

## Files changed

- `background.js` — `historyExplicitlyCleared` + `conversationEpoch` flags,
  `clearConversationState()`, restoration guard, `CLEAR_HISTORY` handler, four
  epoch-guarded persistence sites.
- `sidepanel/panel.js` — `init()` sends `CLEAR_HISTORY` before connecting.
- `manifest.json` — version `2.8.2` → `2.8.3`.
