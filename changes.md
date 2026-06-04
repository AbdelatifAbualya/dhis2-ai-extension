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
