# Privacy Policy — DHIS2 AI Assistant

**Effective date:** 29 May 2026 · **Last updated:** 20 October 2026 (learning memory)
**Extension:** DHIS2 AI Assistant (Chrome extension)
**Contact:** abdelatif.abualya@gmail.com

This policy explains what data the DHIS2 AI Assistant browser extension ("the extension") handles, where that data goes, and what it does **not** do. The guiding principle is simple: **the developer does not collect, receive, store, sell, or share any of your data.** All data stays between your browser, the DHIS2 server you are already logged into, and the AI provider you choose to configure.

## The short version

- The developer operates **no servers** and **receives no data** from the extension. There is no analytics, tracking, advertising, or telemetry of any kind.
- The extension talks only to (1) **your own DHIS2 server**, using your existing browser login session, and (2) **the AI provider you configure** (by default a local model on your own machine).
- Your settings and API keys are stored **locally in your browser only**.
- The extension never collects or stores your DHIS2 username or password.

## What the extension accesses, and why

### Your DHIS2 session and data
The extension works on the DHIS2 instance you are already logged into. It authenticates using your **existing browser session (cookies)** — it never asks for, sees, or stores your DHIS2 username or password. It reads DHIS2 metadata and data (e.g. programs, data elements, analytics) and, when you explicitly ask it to, creates or updates DHIS2 configuration through the DHIS2 Web API on your behalf.

Host access to a DHIS2 server is requested **at the moment you first use the extension on that server**, through Chrome's standard one-time permission prompt for that specific site. The extension has no broad, all-sites access.

### Your questions and the data sent to your AI provider
To answer your questions, the extension sends your typed messages — together with relevant DHIS2 context and data needed to fulfil the request — to the **AI model provider you configure** in the settings:

- **Default (local):** a model running locally via [Ollama](https://ollama.com) on your own computer. In this configuration **no data leaves your machine.**
- **Optional (cloud):** any OpenAI-compatible provider you choose (e.g. OpenAI, Anthropic, Fireworks, Google, OpenRouter, Together, Groq, or a custom endpoint). If you select a cloud provider, the relevant prompt content and DHIS2 data are sent **directly from your browser to that provider's API** so it can generate a response. That data is handled under **that provider's own privacy policy and terms** — the developer of this extension is not an intermediary and never receives it.

You are in control of which provider is used. If you do not want any data to leave your machine, use the default local Ollama configuration.

### Optional web search (Browse Web)
If you enable the optional "Browse Web" tool and provide a [Tavily](https://tavily.com) API key, your search query is sent to the Tavily search API to retrieve results. This happens only when you explicitly use that feature, and only your search text is sent — never your DHIS2 session or server address.

### Local storage on your device
The extension uses Chrome's local storage to save, **only on your device**:

- your interface preferences (e.g. theme),
- your AI provider configuration (endpoint URL, model name, and any API key you enter),
- the current conversation state, so it survives the browser closing the extension's background worker,
- the **learning memory** (if switched on — see below).

This information is **never transmitted to the developer** and is removed if you remove the extension or clear its data.

### Learning memory
The optional learning memory (Settings → Learning memory, **on** by default, switchable off at any time) stores short **lessons about how DHIS2 and its API behave** — for example "a dashboard PUT wipes its tiles; add tiles with add_items", or "on this server the percent indicator type is called Percentage" — so the assistant does not repeat a mistake it has already solved. You can view, search, export, delete individual lessons, add your own notes, or clear everything from the same settings screen.

- Lessons are stored **only in this browser's local storage**. They are never written to your DHIS2 server and never sent to the developer. Lessons relevant to a request are included in the prompt sent to the AI provider you configured, like any other instructions.
- **Patient and personal data are never stored, enforced in code:** nothing is written to memory during any request that read or wrote individual tracker records or that ran on a patient's record page; automatically captured lessons contain only tool names, parameter *names*, configuration values (such as a value type or period type) and endpoint patterns — never record values; every lesson is scrubbed of identifiers (record/metadata IDs, e-mail addresses, phone and ID numbers, dates, search/filter values), and a lesson that still looks like information about a person is refused.
- Switching the memory off stops both learning and the use of stored lessons immediately; the stored lessons are kept until you clear them.

### Apps and plugins you ask the assistant to build

When you ask for a custom app, dashboard widget or Capture plugin, the code is written by the AI provider you configured and installed **on your own DHIS2 server** (through your logged-in session, like any other change). The app, its source code and anything it saves (in its own dataStore namespace) live on that server only — nothing is sent to the developer of this extension. Generated apps can only call the DHIS2 server they are installed on: code that sends data to another address, reads cookies or browser storage, or injects scripts is refused before installation, and an app may only save data when you approved it as a writing app.

When the assistant places a plugin on a dashboard or in the Capture app, it changes that server's configuration (the dashboard, or Capture's layout and form settings in the `capture` dataStore namespace), backs up the previous value on the same server first, and never reads patient records to do it. A Capture plugin reads the open record in **your** browser, with your own DHIS2 access; that data goes to the plugin on the page, not to the AI provider.

## Health and personal information

DHIS2 systems often contain health-related and personally identifiable information. This build is deliberately limited to reduce exposure of individual people's identities:

- **Patient identity lookup is disabled.** The extension has no feature to retrieve a tracked entity (patient) record, and it will not fetch a person's identifying attributes — such as name, age, or gender — even when a tracked-entity ID is present in the page URL. If you ask about "this person/patient," the assistant declines and offers program-level alternatives.
- **It primarily works with** metadata (programs, data elements, rules, indicators), aggregate analytics, and counts.
- **Some operational diagnostics may read enrollment- and event-level records** (for example, detecting abnormal enrollments reads enrollment dates, statuses, and event data values). Any such data needed to answer is processed only by the AI provider you have configured.

With the default **local Ollama** model, none of this data leaves your machine. Using a **cloud provider** means the data needed to answer is processed by that third party under their own policies. Choose your provider accordingly when working with sensitive data.

The developer never receives, stores, or has access to this data in any configuration.

## What the extension does NOT do

- It does **not** send any data to the developer or to any developer-controlled server (there are none).
- It does **not** include analytics, tracking pixels, advertising, or fingerprinting.
- It does **not** sell or transfer your data to third parties.
- It does **not** use your data for creditworthiness, lending, or any purpose unrelated to the extension's single purpose.
- It does **not** store your DHIS2 credentials.

## Permissions summary

| Permission | Why it is needed |
|------------|------------------|
| `sidePanel` | Display the chat assistant in the browser side panel. |
| `storage` | Save your settings and conversation locally on your device. |
| `scripting` | Run DHIS2 API write requests inside your active DHIS2 tab (so they use your session) and inject the lightweight URL-monitor on DHIS2 sites you have granted. |
| `tabs` | Read the active tab's URL to detect which DHIS2 server/page you are on. Page content is not read. |
| `webNavigation` | Detect in-app navigations in DHIS2 single-page apps to refresh page context. |
| Per-site host access | Granted by you at runtime, per DHIS2 server, to call that server's Web API with your session. |

## Changes to this policy

If this policy changes, the updated version will be published at this same URL with a new effective date.

## Contact

Questions about this policy or the extension's data handling: **abdelatif.abualya@gmail.com**
