# Fix: no more CORS console error when switching to a not-signed-in DHIS2 instance

**Date:** 2026-07-20
**Type:** Bug fix (noisy console error on instance switch)

## The report

After switching from one DHIS2 instance to another, opening the extension logged a
red error in the service-worker console (seen on the `chrome://extensions` page):

```
Access to fetch at 'http://hmis.moh.ps/tr-family-migration/dhis-web-login/'
(redirected from 'https://hmis.moh.ps/tr-family-migration/api/42/programs/vj5cpA2OOfZ?fields=...')
from origin 'chrome-extension://fondadnkddnccohboebfcmaghdnmlbno'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is
present on the requested resource.
```

## Root cause

The instance the user had just switched to had **no authenticated session yet**.
DHIS2 answers any API request without a valid session with a **302 redirect to
`/dhis-web-login/`**.

The browser's default `fetch()` mode is `redirect: 'follow'`, so it chased the 302
into the login page. That login page is same-origin *with DHIS2* but cross-origin
*with the extension* (`chrome-extension://…`), and it carries no
`Access-Control-Allow-Origin` header — so the browser blocked the followed
response and logged a CORS error. Critically, that error is emitted by the browser
**before** our JavaScript ever gets the result, so the existing `try/catch` around
the context load could not suppress it.

`initializeFromUrl`'s `/api/system/info` probe already dodged this by using
`redirect: 'manual'`, but the general transport helpers did not — so the very next
context-load call (`programs/{id}?fields=…`) reintroduced the error.

## The fix

Every DHIS2 fetch issued from the **service-worker context** now uses
`redirect: 'manual'`. With manual mode, an unauthenticated 302 comes back as an
**opaque redirect** (`resp.type === 'opaqueredirect'`, `resp.status === 0`) that we
detect *before* the browser follows it. Because the login page is never fetched,
no CORS error is ever logged. Each call then resolves cleanly instead:

| Helper | Behaviour on opaque redirect |
|---|---|
| `dhis2Fetch` (`src/core.js`) | throws `DHIS2_NOT_SIGNED_IN_MSG` — swallowed by `initializeFromUrl`'s context-load `try/catch` as a quiet `console.warn`, not a red error |
| `safeDhis2Fetch` direct fetch (`src/core.js`) | returns `{ _error: DHIS2_NOT_SIGNED_IN_MSG, _status: 401, _not_signed_in: true }` |
| `safeDhis2Fetch` DELETE-retry POST (`src/core.js`) | inherits `redirect: 'manual'` |
| `validateProgramRuleCondition` (`src/tools-programs.js`) | returns the same clean `_not_signed_in` error |
| `validateProgramIndicatorExpression` (`src/tools-programs.js`) | returns the same clean `_not_signed_in` error |

A single shared sentinel message was added in `src/core.js`:

```js
const DHIS2_NOT_SIGNED_IN_MSG =
  'Not signed in to this DHIS2 instance. Log in to this server in the browser tab, then try again.';
```

(Top-level `const` in `core.js`, which loads first via `importScripts`, so it is
visible to `tools-programs.js` — same pattern as `BULK_DELETE_SOFT_CAP`.)

## Why this is safe

- **Writes routed through the active DHIS2 tab (`fetchViaTab`) are untouched** —
  they run in the page's own same-origin context, where a login redirect never
  produces an extension CORS error.
- **Legitimate DHIS2 metadata GETs return `200` directly and never 3xx**, so
  `redirect: 'manual'` changes nothing for authenticated traffic. The only 3xx a
  DHIS2 API request normally produces is the auth redirect we now want to catch.
- The previous failure mode (CORS `TypeError` caught by the outer
  `catch → { _error: 'Fetch failed: …' }`) is strictly worse: it logged the console
  error *and* produced a vaguer message. The new path produces neither.

## Verification

- `npm run verify` — all checks pass.
- `node --check` clean on `src/core.js` and `src/tools-programs.js`.
