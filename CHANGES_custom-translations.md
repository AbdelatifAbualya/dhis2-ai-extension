# Change Log — `manage_custom_translations` tool (DHIS2 2.43 custom-translations feature)

Branch: `enhance-performance`
Manifest version: `2.2.0` → **`2.3.0`**
Tool count: **23 → 24**

This document records everything changed to add the custom-translations tool, plus the live
playground verification behind it. (The repo's running log is `changes.md`; this file is a
self-contained summary of this feature.)

---

## 1. The feature

DHIS2 2.43 ships an **experimental "custom translations"** capability that lets you translate or
re-label any app's UI strings **entirely from the dataStore — no app source-code changes**. It
uses one dataStore namespace, `custom-translations`, with two cooperating key types:

| Key | Shape | Purpose |
|-----|-------|---------|
| `controller` | `{ "<appSlug>": ["<locale>", ...] }` | Registry. Tells each app which apps/locales have custom translations. **If a pair isn't listed here, the app never loads it.** |
| `<slug>__<locale>` (double underscore) | `{ "<exact source string>": "<replacement>" }` | The actual map, e.g. `capture__ar`. |

At startup the app reads `controller`, and for each registered app+locale matching the active UI
locale it loads `<slug>__<locale>` and swaps each matching source string at render time.

Two equivalent uses (the feature is a literal source→target string map):
- **Translate** — locale is a different language (`capture__ar`): English source → Arabic value.
- **Re-label in the same language** — locale is the language already shown (`capture__en`):
  e.g. `"Report data"` → `"Submit report"`.

---

## 2. New tool — `manage_custom_translations`

### Actions
- `list` — show the namespace: the `controller` registry + all translation keys (parsed into app/locale).
- `get` — read the `controller` (omit app/locale) **or** one translation map (pass `app` + `locale`).
  Warns when an app/locale is registered but its key is missing, or a key exists but isn't registered.
- `set` — create/update translations for `app` + `locale`. Writes the `<slug>__<locale>` key **and**
  registers the pair in `controller` in one call. Merges into the existing map by default; pass
  `replace:true` to overwrite the whole map.
- `remove` — delete an `app` + `locale` map (key + `controller` de-registration), or pass
  `keys:[...]` to drop only specific source strings.

### Parameters
`action` (required), `app` (slug, lowercased automatically), `locale` (trimmed; casing preserved
for region locales like `pt_BR`), `translations` (object of string→string for `set`), `replace`
(bool, `set`), `keys` (string[], `remove`).

### Safety / guardrails
- **Version-gated to DHIS2 2.43+** (`customTranslationsVersionGate`) — refuses with a clear message
  on older servers where the apps don't read the namespace.
- **`requireWriteAuth`** gates `set` and `remove` (consistent with every other destructive tool).
- **`controller` always kept in sync** so you can't write a key the app will silently ignore.
- **Inline rollback** — dataStore keys are *not* covered by `manage_backups` (which restores
  metadata via `/api/metadata`), so `set`/`remove` return `previous_value` and
  `previous_controller` in the response for manual recovery.
- Writes go through `safeDhis2Fetch`; POST-create with PUT-on-409 fallback for upserts.

---

## 3. Files changed

| File | Change |
|------|--------|
| `background.js` | Tool definition added before `manage_backups`; `manage_custom_translations: true` in `TOOL_ROUTER`; `wantsTranslationIntent` detection + selection in `getContextualTools`; dispatch in `callTool`; implementation `executeManageCustomTranslations` + helpers (`customTranslationsVersionGate`, `ctFetchController`, `ctUpsertKey`, `ctWriteController`, `listCustomTranslations`, `getCustomTranslations`, `setCustomTranslations`, `removeCustomTranslations`); `wantsTranslationPrompt` flag + a "DHIS2 Custom Translations" system-prompt KB section. |
| `sidepanel/panel.js` | Tool icon (🌐), status label ("Managing custom translations"), and args-detail renderer (action, app, locale, string count). |
| `README.md` | Tool table row 24; tool count 23 → 24 (two places); a known-quirks bullet documenting the namespace contract. |
| `manifest.json` | `version` 2.2.0 → 2.3.0. |
| `changes.md` | Running-log entry #7. |

No existing tool's behaviour was modified — this is purely additive.

---

## 4. Playground verification (play `stable-2-43-0-1`, DHIS2 `2.43.0.1`)

1. **DataStore write contract** — created via the dataStore API:
   - `custom-translations/controller = { "capture": ["ar"] }` → **201 Created**
   - `custom-translations/capture__ar = { "Get started with Capture app": "...", ... }` → **201 Created**
2. **App consumption** — set the user UI locale to `ar` and loaded the Capture app. The network
   trace showed the **app itself** issuing:
   - `GET /api/dataStore/custom-translations/controller` → **200**
   - `GET /api/dataStore/custom-translations/capture__ar` → **200**

   This confirms the namespace name, the `controller` registry, and the `<slug>__<locale>`
   (double-underscore, lowercased slug) key format that the tool writes.
3. **Key format from source** — the Capture bundle (`main-CiArLA10.js`) builds the key with the
   template `` `${slug}__${locale}` `` and lowercases the slug — matching the tool.

**Rendering confirmed:** the Capture app renders the translated strings in the live app (verified by
the user in the open tab). The automated screenshots taken during this session missed the swap
because they hit a PWA-cached / mid-reload state; separately, clearing the service-worker cache
mid-test briefly broke the ephemeral instance's `/apps/*` routing (self-heals on instance reset).
Neither affected the tool — the full datastore read/write contract is verified end-to-end.

`node --check background.js` and `node --check sidepanel/panel.js` both pass.
