# Changes — Modular refactor of the background service worker

This change set turns the single 26,168-line `background.js` into a thin loader
plus six focused modules, fixes two real defects found during the refactor, and
adds a dependency-free verification script. It is the initial "New Design" pass:
**behaviour is preserved** except for one deliberate, documented bug fix.

Baseline: `v2.8.13` (`background.js`, 26,168 lines). Every step below was checked
with `node --check` and a shim-loaded smoke test; the safety gates are asserted
by `scripts/verify.js`.

---

## 1. Split `background.js` into six modules (mechanical, byte-identical)

**Files:** `background.js` (now a 40-line loader) + new `src/core.js`,
`src/registry.js`, `src/providers.js`, `src/tools-metadata.js`,
`src/tools-programs.js`, `src/agent.js`.

**Type of change:** Pure code move. No behaviour change.

**What changed:** the worker body was sliced into six contiguous ranges at
top-level function boundaries and moved into `src/`. `background.js` now only
calls `importScripts()` on those six files, in the original order.

| Module | Original lines | Responsibility |
| --- | --- | --- |
| `src/core.js` | 1–3529 | config · state · safety gates · DHIS2 transport & backups · context/init |
| `src/registry.js` | 3530–7771 | tool schemas · KB · manuals · tool selection · system prompt |
| `src/providers.js` | 7772–9732 | LLM streaming · image · web search · read helpers · privacy gate |
| `src/tools-metadata.js` | 9733–16510 | `executeTool` + standard metadata tools |
| `src/tools-programs.js` | 16511–24492 | program-authoring tools · plugins · standalone |
| `src/agent.js` | 24493–26168 | agentic loop · feedback · keepalive · message router + listeners |

**Why it is safe:** the modules share one classic-worker global scope
(`importScripts`, not ES modules), so no `import`/`export` wiring was needed and
no shared-global access changed. The concatenation of `src/*.js` in load order is
**byte-for-byte identical** to the prior `background.js` (verified with `cmp`
against the committed baseline). Running six contiguous slices through
`importScripts` is semantically the same as running the original single script.

**Manifest:** unchanged — the service worker is still `background.js`, still a
classic (non-module) worker, which is required for `importScripts`.

---

## 2. Fix: the duplicate `normalizeText()` that silently broke the "sub-" trigger

**Files:** `src/core.js`, `src/providers.js`
**Type of change:** Bug fix (one deliberate behaviour change) + rename.

**Before:** `background.js` declared `normalizeText()` **twice** — once near the
top (lowercase only) and once ~8,000 lines down (lowercase **+ replace every
non-alphanumeric run with a space + trim**). Function hoisting made the second,
aggressive version win everywhere.

**The concrete bug:** `userExplicitlyWantsDescendants()` lists `'sub-'` and
`'sub-org'` among the phrases that mean "the user wants org-unit descendants".
But the winning normalizer turned every hyphen into a space *before* that
substring check, so those two triggers could never match. Phrasings like
"counts for **all sub-counties**" silently failed to expand to descendants.

**After:** the two behaviours are now distinct, named for purpose, and both live
in `core.js`:

- `lowercaseText(v)` — lowercase only (preserves hyphens/punctuation).
- `normalizeSearchTokens(input)` — lowercase + collapse non-alphanumerics + trim
  (for tokenized keyword search).

Callers updated:

- `userExplicitlyWantsDescendants` → `lowercaseText` — **restores** the `sub-` /
  `sub-org` triggers. *(This is the one intended behaviour change.)*
- `isVisualizationValueQuestion` → `normalizeSearchTokens` — behaviour preserved
  (it previously used the aggressive normalizer; its keys are unaffected).
- `tokenize` → `normalizeSearchTokens` — behaviour preserved.

The `normalizeText` name no longer exists; `scripts/verify.js` asserts it is gone
and that both replacements behave correctly, so the collision cannot silently
return.

---

## 3. Cleanup: stop fetching the unused line-listing router source

**File:** `src/core.js`
**Type of change:** Dead-code removal. No behaviour change.

`ensureLineListingAssetsLoaded()` fetched `line-listing/dhis2_extension_router.js`
on every asset load and stored its text in `lineListingAssets.routerSource` — a
field that was **never read** anywhere. Removed the fetch and the field (one
fewer network round trip per load).

`LINE_LISTING_ROUTER_PATH` is **kept**: the live routing is the embedded
`LINE_LISTING_KEYWORD_ROUTES` + `routeLineListingBlocks()`, and the router path is
still surfaced to the model as a source reference (in the system prompt and the
`get_line_listing_guide` result), so no model-facing text changed. Fully
de-duplicating the external router file is listed as a follow-up in
`ARCHITECTURE.md`.

---

## 4. Add `scripts/verify.js`, `package.json`, `ARCHITECTURE.md`

**Files:** new `scripts/verify.js`, `package.json`, `ARCHITECTURE.md`.
**Type of change:** New tooling/docs. Does not ship in the extension runtime.

- **`scripts/verify.js`** — dependency-free (`npm run verify`). It `node --check`s
  every runtime file, loads the six modules in `importScripts` order under a
  minimal `chrome` shim (proving the split is internally consistent), and asserts
  the safety-critical pure functions: write authorization (broad vs read-only,
  bare-yes), UID entropy recognition, patient-data path gate, the two text
  normalizers, strict query encoding, and UID generation.
- **`package.json`** — no dependencies; just the `verify`/`check` scripts and a
  Node engine floor. There is still no build step.
- **`ARCHITECTURE.md`** — the module map, the `importScripts` rationale, the list
  of safety gates, a step-by-step "adding a tool" guide (honest about the
  parallel registries), and the deferred report items.

---

## What was intentionally NOT done

Per the maintainability review, but deferred to keep this pass safe and
behaviour-preserving (see `ARCHITECTURE.md → Deferred`): a single declarative
tool registry, typed state stores, an injected `Dhis2Client`, splitting
`panel.js`, and any TypeScript/bundler adoption. These are the recommended next
steps; the single tool registry is the highest-value one.
