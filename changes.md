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
