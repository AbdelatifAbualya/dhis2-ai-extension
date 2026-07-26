# v2.8.22 — The silent mid-task stall + the "Allergy Details" 409

**Trigger:** a live W4W Clinic build (8 stages, ~30 rules, 12 attributes,
2026-07-26). The chatbot ran its discovery calls, streamed *"Creating the
program shell with registration attributes and Form 1 first, then adding the
remaining stages."* — and then nothing, forever. No error, no failed call, no
spinner recovery, nothing on the server. A reproduction of the same prompt
through `scripts/llm-run.js` (Fireworks `glm-5p2`) separately surfaced one
failed API call: a 409 at `importMode=VALIDATE` on an `add_program_rules`
batch.

## 1. Silent task abandonment on a text-only reply (`src/agent.js`)

The agentic loop treated **any** non-empty assistant text without tool calls as
the final answer and ended the turn. Two failure shapes ride that exit:

- **`finish_reason='length'`** — the reply was cut by the output token limit
  *after* the visible text but *before* the first tool-call delta streamed.
  The empty-response guard (v2.8.16) only covered the case where the *entire*
  budget went to reasoning; when announcement text made it out first, the cut
  response was accepted as a finished answer.
- **Announcement-only replies** — a weak/fast model states what it is about to
  do and stops without emitting the call ("Creating the program shell …, then
  adding the remaining stages."). The turn ends, the panel goes idle, and the
  user reads it as the extension hanging — nothing was created and there is no
  error to see, because to the loop nothing went wrong.

**Fix:** a bounded unfinished-turn guard in the final-text path. If the reply
was cut by the token limit, or (mid-task only — at least one tool call already
happened this turn) the text matches `looksLikeUnfinishedAnnouncement()`, the
loop pushes a corrective system message and continues instead of returning:
re-plan is forbidden, the next tool call must be emitted now, and for large
programs the split guidance (shell + first stage, then `add_stage`, then rule
batches) is repeated. Capped at 3 nudges per turn — a false positive costs one
extra round trip, after which the text is accepted as the final answer.

`looksLikeUnfinishedAnnouncement()` (new, `src/core.js`) is deliberately
conservative: replies that ask the user a question are never flagged, replies
over 2000 chars are reports rather than announcements, and only future-intent
phrasing near the end fires — a sentence starting with an action gerund
("Creating…", "Now adding…") or a first-person promise ("I'll create…",
"let me add…").

## 2. Rule actions shipped without their target (`src/tools-programs.js`)

`add_program_rules` resolved action targets with an **exact-key** lookup:
`deNameToId[act.data_element_name]`. The model wrote `"Allergy Details"`; the
data element had been created as `"Allergy details"`. The lookup missed, and —
because nothing required the target to exist — the HIDEFIELD action was posted
with **no `dataElement` at all**. DHIS2 rejected the whole batch at VALIDATE:
`ProgramRuleAction: DataElement or TrackedEntityAttribute cannot be null` —
the run's one failed API call. The same exact-match pattern sat in the
`create_program` embedded-rules path, where the import is atomic and a single
targetless action would kill the entire program build.

**Fixes (both rule-building paths):**

- **Loose canonical-name resolution** — `resolveLooseNameKey()` +
  `canonicalizeActionTargetNames()` rewrite the action's name fields onto the
  canonical map keys before any lookup: exact key, then case/whitespace-folded
  match, then unique prefix/contains. Ambiguity resolves to nothing — never a
  guess between two candidates. Every rewrite is reported in the tool result
  (`outcome: 'target name resolved'`).
- **Missing-target fail-fast** — `actionMissingFieldTarget()`: HIDEFIELD /
  SETMANDATORYFIELD / HIDEOPTION / SHOW-/HIDEOPTIONGROUP with neither a
  `dataElement` nor a `trackedEntityAttribute`, ASSIGN with no target and no
  `content` variable, HIDEOPTION without its `option`, and option-group
  actions without their `optionGroup` are refused **client-side** (create path:
  the rule is skipped and reported, consistent with its skip-and-continue
  doctrine; add path: lint refusal with `closest_matches` so the model fixes
  the name in one retry). A payload the server would 409 can no longer be
  sent.
- `add_program_rules` now honors explicit `option_id` / `option_group_id`
  pass-throughs (UID-shape-checked), which the fail-fast hint points to —
  HIDEOPTION via this path previously *always* died at VALIDATE with
  `Option cannot be null`.

## Verification

- `npm run verify` — all green, including new regressions: announcement
  detection (live W4W string flagged; past-tense summaries, questions, long
  reports not flagged), loose-name resolution (case/whitespace drift resolves,
  ambiguity does not), and the missing-target matrix per action type.
- Live acceptance (`scripts/llm-run.js`, Fireworks `glm-5p2`,
  `http://localhost:8081`, the original W4W Clinic prompt end-to-end):
  **200 DHIS2 calls, 0 failed; 14 provider calls; 0 tool errors or lint
  refusals** — program shell + 10 attributes + all 8 stages + 26 program
  rules built and summarized in one conversation turn (the pre-fix run of the
  same prompt had 1 failed API call and 3 refusal round-trips).
- Targeted live scenario on the fixed path itself (direct `executeTool`,
  `create_metadata(action=add_program_rules)` against the built program):
  a HIDEFIELD written as `"ALLERGY DETAILS"` resolves to the DE
  `"Allergy details"`, imports cleanly, and the created action carries the
  resolved `dataElement` on read-back; a genuinely unknown target is refused
  client-side (phase `lint`, no POST issued); cleanup deletes the test rule.
  17 API calls in the build phase, **0 failed**, instance left as found.
