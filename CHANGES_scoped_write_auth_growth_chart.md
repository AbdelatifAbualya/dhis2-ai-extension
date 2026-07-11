# v2.8.10 — Scoped "yes" authorization + growth-chart routing/guard fixes

## The transcript (localhost:8081, v2.8.7 build)

A user asked to *"set up the child growth data store ID based of these data elements"* with
the Capture Growth Chart plugin installed. What followed exposed four systemic defects:

| # | What happened | Root cause |
|---|---------------|-----------|
| 1 | The chatbot never used `manage_growth_chart_plugin` on the first ask — it asked for a generic namespace/key instead | Intent trigger required chart/plugin words; "growth … data store" didn't match, so the tool was never surfaced |
| 2 | It hand-wrote configs into an invented `childGrowthPlugin` namespace with a made-up shape (BMI, nutrition flags) via raw `dhis2_query` — the plugin reads only `captureGrowthChart/config`, so nothing worked and nothing errored | No guard on dataStore writes to plugin-owned namespaces |
| 3 | It told the user, twice, that "I genuinely do not have a manage_growth_chart_plugin tool" | The write-gate refusal text never said the tool exists — the model rationalized the refusal as a missing function |
| 4 | After the user's bare **"yes"** to the proposed growth-chart configure, it **deleted the BMI Z-score data element and removed it from the stage** — never requested | Any bare "yes" granted turn-wide broad write access, spendable on ANY tool |

## Fixes (background.js)

1. **Scoped affirmations — write-gate redesign.** Every refusal now records the proposed
   `{tool, action, turn}`. A bare affirmation on the very next turn ("yes", "go ahead",
   "do it"…) yields `scope:'scoped'`: **only the proposed tool may write**; anything else —
   including raw `dhis2_query` writes and unrelated deletes — is refused with
   *"the user's bare 'yes' authorizes ONLY <tool>(<action>)"*. The first matching call widens
   scope to broad for the rest of the turn (follow-up writes of the same plan still work).
   Affirmations with extra content, and bare affirmations with no pending proposal, behave
   exactly as before. Proposal memory expires after one turn and on new threads.
2. **Growth dataStore guard.** `dhis2_query` blocks non-GET requests on any dataStore
   namespace matching `/growth/i` and redirects to `manage_growth_chart_plugin`
   (DELETE of non-official junk namespaces stays allowed for cleanup).
3. **Anti-hallucination refusals.** Refusal text now explicitly says the tool **IS available
   and working** — a per-turn gate, not a missing function — and demands the SAME call be
   retried after confirmation, never a substitute.
4. **Routing.** "growth" + "data store/datastore" now surfaces the tool and its 3-line
   system-prompt routing stub. The lazy two-tier manual design is untouched: the stub is
   decide-time routing only; the full manual still arrives via the first-call gate.

## Instance repair (localhost:8081)

BMI Z-score is back in the Child Growth stage, the junk `childGrowthPlugin` namespace is
deleted, and the canonical `captureGrowthChart/config` (weight/height/head-circumference +
DOB/gender/first-name, wfa default) is verified intact.

## Verification

`test-growth-chart-flow.js` (localhost:8081) 19/19 — replays the whole transcript: routing,
guards, refusal wording, scoped "yes" refusing the delete-BMI call and the dhis2_query
bypass, approved configure succeeding, scope widening, server state canonical.
Regressions: auth-gate 18/18 · child-health scenario 20/20 · tomcat-brackets 7/7 ·
e2e-happy-path 8/8 · `node --check` clean.
