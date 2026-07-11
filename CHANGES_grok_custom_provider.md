# v2.8.12 — xAI Grok provider + custom-provider connection fixes

**Date:** 2026-07-12
**Branch:** `enhance-performance`
**Files:** `background.js`, `sidepanel/panel.js`, `sidepanel/panel.html`, `README.md`, `manifest.json`

## Problem

Connecting xAI Grok (`grok-4.5`) via the **Custom / Other** provider failed even with a valid
API key. Live diagnosis against `https://api.x.ai` (with the user's key) showed the API is
fully OpenAI-compatible — chat/completions, SSE streaming, `tools` + `tool_choice: auto`,
null-content assistant messages, and multi-turn tool loops all succeed, and CORS is
`access-control-allow-origin: *`. Every failure was in the extension:

| # | Failure | Evidence |
|---|---------|----------|
| 1 | Bare-domain base URL → `https://api.x.ai/chat/completions` (no `/v1`) | live HTTP 404 |
| 2 | Docs-copied `…/v1/responses` base URL → `…/v1/responses/chat/completions` | live HTTP 404 "No handler found on route" |
| 3 | No `chrome.permissions.request` for provider origins on save | custom endpoints without permissive CORS unreachable from the MV3 worker |
| 4 | `delta.reasoning_content` ignored in the SSE loop | panel shows zero activity during grok-4.5's reasoning phase |

Note: `grok-4.5` is a real model on `/v1/models` (aliases `grok-4.5-latest`,
`grok-build-latest`); other text models offered: `grok-4.20` reasoning/non-reasoning/multi-agent,
`grok-4.3`, `grok-build-0.1` (`grok-code-fast-1`).

## Fixes

1. **`getChatCompletionsUrl` normalization** (`background.js`): strip trailing `/responses`;
   append `/v1` to bare-domain URLs (no path) before `/chat/completions`. 11 URL shapes
   unit-tested, including all pre-existing provider presets — zero behavior change for them.
2. **Reasoning progress** (`background.js` SSE loop): `delta.reasoning_content` now drives
   `Reasoning…` / `Reasoning… (N words)` AI_THINKING broadcasts (first delta, then every 60),
   mirroring the `<think>`-block cadence. Reasoning text never enters the visible answer.
3. **Grok preset**: `PROVIDER_PRESETS.grok = { url: 'https://api.x.ai/v1', model: 'grok-4.5',
   keyHint: 'xai-...' }` (`panel.js`), "xAI Grok" `<option>` (`panel.html`), `grok` added to
   `ALLOWED_PROVIDERS` in `SAVE_PROVIDER_CONFIG` (`background.js`).
4. **Host-permission grant on save** (`panel.js` `saveSettings`): synchronously within the
   Save click gesture, request `chrome.permissions.request({ origins: [<api origin>/*,
   <vision origin>/*] })` for remote (non-local) URLs. Granted origins persist; already-granted
   resolve silently; denial is non-fatal.

## Verification

- `node --check background.js` / `node --check sidepanel/panel.js` pass.
- Live x.ai: models list, non-stream completion, extension-shaped stream (temperature 0.2,
  max_tokens 16384, top_p 1, tools) → standard OpenAI tool_call deltas + `finish_reason:
  "tool_calls"`; multi-turn tool-result round-trip answers correctly.
- URL normalization: 11/11 cases pass (x.ai ×4, Ollama ×2, Google ×2, OpenAI, Groq, OpenRouter).
