---
name: dhis2-chatbot-performance-enhancement
description: Rules and workflow for improving the DHIS2 AI Assistant Chrome extension in this repo — adding or changing tools, abilities, prompts, or the agentic loop. Use whenever the task is to enhance, extend, fix, or add a feature/tool to this extension (background.js / sidepanel / line-listing), or when asked to "make the chatbot better". Enforces: verify the chatbot still works perfectly, never regress another tool (only improve them), and test every change against the DHIS2 playground BEFORE reflecting it into the tools.
---

# DHIS2 Chatbot Performance Enhancement

We are continuously improving this chatbot — the **DHIS2 AI Assistant** Chrome extension
(MV3) — and committing changes to this repo. Every change must make the extension better and
must never make it worse. Treat the rules below as hard requirements, not suggestions.

## Non-negotiable rules

1. **The chatbot must work perfectly after every change.** A change is not "done" until you
   have verified the behavior end-to-end, not just that the file parses. The bar is **zero
   errors in normal use** — no 409s, no failed/repeated API calls, no error-then-retry loops.
   If the chatbot would emit an API call that returns an error, that is a bug to fix at the
   root, not to paper over.

2. **Never regress another tool. Interactions may only IMPROVE other tools.** A new tool or
   ability MUST NOT affect any existing tool negatively. If the new work needs to interact
   with, share logic with, or change other tools, the ONLY acceptable outcome is that those
   other tools become *better* (more correct, more robust, fewer errors). If you cannot do it
   without risking a regression, stop and surface the trade-off — do not ship the regression.

3. **Test against the DHIS2 playground FIRST — before reflecting logic into the tools.** For
   anything that builds, reads, or mutates DHIS2 metadata/data, prove the exact API sequence
   works on a live instance before (or while) writing the tool code. The tool's logic must be
   a faithful mirror of a sequence you have *seen succeed*. Never implement from assumption.

4. **Document every change.** Append a numbered entry to `changes.md` (file, function,
   before→after, what it does, why, scope, verification) and, for a sizeable feature, add a
   dedicated `CHANGES_<feature>.md`. See the saved memory `document-extension-changes`.

5. **Don't push to `main`.** Work on the `enhance-performance` branch and open/extend a PR.
   Commit/push only when the user asks (or when completing a PR the user is already driving).

## Playground testing protocol

- Instance: latest **2.43** — `https://play.im.dhis2.org/stable-2-43-0-1` (login `admin` /
  `district`). Fallback if it 503s/restarts: `https://play.im.dhis2.org/dev-2-43`. Playground
  instances reset nightly and can briefly return 503 while restarting — wait and retry, or
  switch instance; they are shared demo servers.
- Prefer driving the API directly via `fetch(..., {credentials:'include'})` in the page
  context (reliable, fast). Use the app UI to confirm what the *user* sees — e.g. a form
  renders AND a value saves/persists, a program opens in Capture, etc.
- For writes, run `?importMode=VALIDATE&atomicMode=ALL` first, then `COMMIT`. **But know that
  VALIDATE cannot catch database-level constraints** (e.g. the per-option-set unique-code
  constraint) — those only surface at COMMIT. So uniqueness/validity must be guaranteed
  client-side, by construction.
- **Pre-generate UIDs for any bundle whose objects reference each other** (program ↔ stages ↔
  data elements ↔ attributes ↔ option sets ↔ options; dataSet ↔ sections ↔ dataEntryForm).
  Posting such a bundle with no `id`s fails with `E5002 Invalid reference`: DHIS2 will mint a
  UID for each id-less object but cannot wire the references. Omitting `id` is only safe for a
  standalone, unreferenced object. Use `/api/system/id` or `generateDhis2Uid()`.
- **Clean up** every test object you create on the playground when done (delete program →
  stages/forms cascade; then DEs, option sets, options, etc.). Verify nothing is left behind.
- Note real DHIS2 quirks you discover in code comments + `changes.md` so they are never
  re-derived.

## How a tool is wired (touch ALL of these for a new tool)

`background.js`: `TOOLS` array (definition + rich description — the single source of truth) →
`TOOL_ROUTER` → `executeTool` dispatch → handler function(s) → `getContextualTools()` (surface
it only in the right context; strip it in read-only save-diagnosis mode; add to
`writeCapableNames` if it writes) → `buildSystemPrompt()` routing STUB when relevant.
`sidepanel/panel.js`: `iconMap`, `toolLabels`, and the tool-card `detail` branch.

**Two-tier tool docs (v2.8.0+):** write-capable tools additionally need a `MANUAL_TOOLS` entry,
a `TOOL_SUMMARIES` routing description (what/when + "NEVER via dhis2_query" invariants), and —
if there is deep how-to KB — a `MANUAL_EXTRAS` entry. Their full docs are delivered lazily by
the first-call manual gate (`buildManualGateResult` in the agentic loop), NOT via the system
prompt: put use-time instructions in the tool description / `MANUAL_EXTRAS`, and only 2–5-line
decide-time routing stubs in `buildSystemPrompt`. Read tools keep full wire definitions. See
`CHANGES_lazy_tool_manuals.md`.

Reuse the existing safety rails — do NOT reinvent them:
`requireWriteAuth` (per-turn write gate), `verifyTargetExists` (404 guard),
`ensureBackupOrBail` (auto-backup before destructive writes), `postMetadataPayload`
(VALIDATE→COMMIT with shortName auto-fix), `safeDhis2Fetch` (write-via-tab, content-type
handling, json-patch auto-wrap), `generateDhis2Uid`, `normalizeAccessString`, `clampShortName`,
`recordRecentCreation`/`lookupRecentCreation`.

## Pre-flight / definition-of-done checklist

- [ ] Proven on the playground: the exact API sequence committed with **zero errors**.
- [ ] New/changed tool does not regress any other tool; any cross-tool interaction makes the
      other tool better.
- [ ] Safety rails reused (write-auth gate, verify-before-modify, auto-backup) where the tool writes.
- [ ] Wired through every layer (TOOLS → router → dispatch → contextual selection → system
      prompt → panel.js icon/label/detail).
- [ ] `node --check background.js` and `node --check sidepanel/panel.js` pass; `manifest.json`
      valid JSON; version bumped if it's a feature.
- [ ] Test metadata cleaned up from the playground.
- [ ] `changes.md` (+ `CHANGES_<feature>.md` for big features) updated.
- [ ] Committed to `enhance-performance` / the PR — not `main`.
