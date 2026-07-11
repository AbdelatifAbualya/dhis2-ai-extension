# v2.8.11 — Program-rule correctness overhaul

Fixes for the three failure classes reported on 2026-07-11 from live sessions on
`play.im.dhis2.org/stable-2-43-0-1` (MCH program) and localhost:8081 (TB program).

## 1. Reported: "a program rule it created a turn before didn't appear in context"

**Symptom (MCH transcript):** every call referencing rule `g8bVjSmjx9m` or action
`xlX3E7asf16` opened with `Refused: … UID(s) that have not appeared in any verified source
this turn`, even though the chatbot itself had created/mentioned those objects one turn
earlier. Each turn burned an extra `list` round-trip; worse, when the DELETE of the orphaned
action was refused three times, the model concluded — and told the user — that the action
"is already gone", which was a fabrication.

**Root cause:** `seedKnownIds()` rebuilt the verified-UID registry every turn from the user
message, page context, inspect snapshot and cached program/OU/viz metadata — but never from
`conversationHistory`. Anything the model could literally see in its own context from prior
turns (its own creations included) was treated as a hallucination.

**Fix (`background.js` — `seedKnownIds`):** harvest `conversationHistory` into the seed.
Verified-source invariant is now "any UID visible in the model's context window". The
refusal `_hint` additionally forbids presenting the client-side gate as evidence about
server state ("never tell the user the object is already gone / deleted"). The
system-prompt "Verify-before-call" section documents history as verified source #5.

## 2. Reported: 409 "could not automatically delete the old SHOWWARNING action" + orphan

**Root cause:** `manage_program_rules(action=update)` generated NEW UIDs for every action in
a replacement array, imported the rule pointing at the new rows, then raw-DELETEd the old
rows — which can 409 right after the import, leaving orphaned `programRuleAction` rows.

**Fix:** replacement actions now REUSE the old action UIDs positionally; the metadata import
(mergeMode REPLACE) updates each row in place. An N→N action change (the overwhelmingly
common case, e.g. SHOWWARNING→DISPLAYTEXT) creates no orphan and issues no DELETE at all.
When the new array is shorter, surplus rows are deleted with a
`metadata?importStrategy=DELETE` fallback if the raw DELETE errors.

Verified live on both servers: after the DISPLAYTEXT swap the rule has exactly one action
row server-side and its UID is IDENTICAL to the pre-update SHOWWARNING action's UID.

## 3. Reported: two rules for one task; multi-select field un-selectable; "DHIS2 rendering issue" lie

**What was actually on the TB program (fetched live before the fix):**

| Rule | Condition | Actions |
|---|---|---|
| Hide Primary Symptoms when … is No | `!hasValue ∥ != true` | HIDEFIELD(Primary Symptoms) |
| **Show Primary Symptoms when … is Yes** | `== true` | **SETMANDATORYFIELD + HIDEFIELD (same field!)** |
| Hide Treatment Enrollment when Not Tb | `== 'NOT_TB'` | HIDEPROGRAMSTAGE |
| **Show Treatment Enrollment when not Not Tb** | `!= 'NOT_TB'` | **HIDEPROGRAMSTAGE (same stage!)** |

…plus the same pattern for GeneXpert Result, Side Effects list, and Treatment Regimen/DOT.
Selecting "Yes" simultaneously HID the multi-select and made it MANDATORY — that is why
options could not be chosen. The stage pair hid the Treatment Enrollment stage in EVERY case.

**Root cause:** the model does not know DHIS2 has no SHOW action, and nothing in the tool
layer stopped it. These rule sets import with zero server errors and fail only in front of
the health worker.

**Fixes:**
- `lintRuleVisibilitySemantics()` (+ `_prCoreCondition`, `_prConditionsComplementary`,
  `_prNormalizeRuleForLint`): hard lint-refusal of (a) HIDE + SETMANDATORYFIELD on the same
  target in one rule, (b) two rules hiding the same target under complementary conditions
  (batch-internal AND against the program's EXISTING rules), (c) duplicate hide twins,
  (d) rules named "Show/Display/Reveal/Unhide X" whose action hides X. Wired into:
  create_program, add_program_rules, manage_program_rules create + update.
- `manage_program_rules(action=audit)` now returns the same findings for existing programs
  as `cross_rule_issues`, so "field shows but can't be used" diagnosis surfaces the true
  cause. The manual explicitly forbids blaming "DHIS2 rendering issues" without audit
  evidence.
- Manuals + wire schemas teach the doctrine: visibility = ONE hide rule (condition = the
  HIDE case); mandatory-when-visible = separate SETMANDATORYFIELD-only rule.
- **Localhost TB program repaired** through the fixed tool path: the five "Show …" rules
  deleted; the correct hide rules remain; audit clean. The multi-selects now appear when
  their trigger is Yes and are fully selectable.

## 4. Reported: recurring `A{Date of Birth} … unresolved variable(s)` create_program failures

**Root cause:** `resolveRuleTokenBindings()` compared the raw token against sanitized DE/TEA
names — `Date of Birth` ≠ `date_of_birth`, so a token spelled as a display name never
matched even when the TEA was defined in the SAME request. (The manage_program_rules create
path already sanitized; create_program and add_program_rules did not.)

**Fix:** tokens are sanitized before matching and auto-rewritten to canonical form in the
condition and action `data` (`A{Date of Birth}` → `A{date_of_birth}`), reported as
`rule_token_rewrites`. `A{}` tokens that name a data element heal to `#{}`. Tokens matching
an existing PRV's sanitized name rewrite onto the actual PRV name. Genuinely unknown or
ambiguous tokens refuse exactly as before. The update path now runs the same resolution on
changed conditions (previously it saved rules that silently never fire) and refuses unknown
tokens.

## Verification (all through the real preflight + executeTool layer)

- Unit suite 27/27 — includes the byte-exact live TB rule shapes, regression checks that a
  legit hide rule + inverse-condition SETMANDATORYFIELD pair passes, and that the
  HIDEALLFIELDS auto-paired mandate sibling passes.
- Live E2E localhost:8081 (2.42, Tomcat strict-URL) 32/32 and play stable-2-43-0-1 (2.43)
  28/28: token-heal create, refused broken pair (nothing imported — verified), refused
  twin-of-existing, audit findings on the live breakage, repair deletes, cross-turn UID from
  history → write-auth ask → scoped "yes" → FIRST-TRY update, in-place action UID reuse
  (1 action row, same UID), update-path token heal + unknown-token refusal, full ZZTEST
  cleanup on both servers.
- `node --check` clean: background.js, sidepanel/panel.js, content.js; manifest valid.

Harness: rebuilt per `playground-tool-harness` memory (chrome-shim + `__harness.turn` /
`endTurn` / `call`), now also simulating cross-turn history persistence.
