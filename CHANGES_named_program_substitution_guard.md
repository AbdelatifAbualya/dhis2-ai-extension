# v2.8.17 — Named-program substitution guard

## The incident (live, 2026-07-19)

The user's prompt began:

> *"Using the **Integrated Pregnancy, Delivery and Postnatal Care Tracker**, create and
> save the following complex line-listing tables…"*

…followed by ten detailed line-listing specs and a dashboard.

That program **did not exist** on the DHIS2 instance. The assistant searched for it
(`programs?filter=displayName:ilike:Integrated Pregnancy` → 0 rows, and several
follow-up searches), then, instead of stopping, **inspected candidate programs, picked
the closest lookalike** — *"Maternal and Child Health (MCH) Program"* — and proceeded to
build the **entire request** on it:

- 6 legend sets
- 9 line listings (`manage_line_lists` create)
- a 7-tile dashboard

…and reported the missing-program fact only at the very bottom of a long summary. When
challenged, the model itself admitted the correct behavior was to **stop and ask** as
soon as the named program came back empty.

This is a data-integrity and trust failure: the user's clinical request was silently
executed against a program they never named.

## Root cause

Nothing in the pipeline treated **"the object the user named by name does not exist"**
as a hard stop. The write-authorization gate (`requireWriteAuth`) authorizes writes when
the user's message contains create/build verbs — which this message did — so every
`manage_line_lists(create)` call sailed through. The only signal that the wrong program
was in play (the empty search results) was advisory text the model was free to ignore.

## The fix

A **mechanical per-turn guard** that makes a failed *named* program lookup block writes
against a *different* program until the user resolves the ambiguity.

### 1. Arming — `noteMissingNamedTarget(objectType, nameFilter)` (`src/core.js`)

Called whenever a **name-filtered program search returns 0 rows**, from both:
- `search_metadata(object_type="programs", …)` — in `src/tools-metadata.js`
- raw `dhis2_query` GET on `programs?…filter=displayName|name:(i)like:…` — same file

It arms only for **specific** queries — normalized to ≥2 words, or one word ≥10 chars —
so generic probes like `ANC`, `MCH`, or `Maternal` never arm it (those legitimately
mean "show me candidates"). Capped at 5 armed targets/turn.

### 2. Disarming — `clearNamedTargetsFoundIn(displayNames)` (`src/core.js`)

Any program result set (search or raw query) whose returned display names **contain** an
armed query string disarms that target — the program existed under a variant spelling
after all, so no stop is warranted.

### 3. Blocking — `namedProgramSubstitutionStop(tool, action, programUid)` (`src/core.js`)

Called from the `executeTool` dispatcher **before** any program-bound write executes
(gated list in `PROGRAM_BOUND_WRITE_ACTIONS`):

| Tool | Actions |
|------|---------|
| `manage_line_lists` | create, update |
| `manage_program_rules` | create, update, bulk_fix_conditions |
| `manage_program_indicators` | create, update, bulk_fix, bulk_fix_expressions |
| `manage_program_notifications` | create, create_and_link |
| `create_metadata` | add_stage, add_data_elements_to_stage, add_program_rules |

It resolves the target program's name (cached per turn) and:
- If the name **matches** an armed missing target → the user's named program was created
  this turn (or found under a variant); **allow and disarm**. This keeps the legitimate
  *"named program doesn't exist → user says create it → build on the new one"* flow open.
- If the name does **not** match → return a `named_program_substitution_blocked` refusal
  telling the model to stop and ask the user whether to (a) create the missing program,
  (b) build on one specific existing program, or (c) stop.

Reads and non-program writes are never touched. If name resolution fails (404/network),
the guard defers to the tool's own error handling rather than blocking blindly.

### 4. State reset (`src/agent.js`)

`dhis2.missingNamedTargets` and `dhis2._namedTargetProgramNames` are reset at the top of
every agentic turn, alongside the other per-turn guard state. The block therefore forces
exactly **one** stop-and-ask; the user's next-turn decision proceeds normally.

### 5. Prompt doctrine (`src/registry.js`)

New core rule **10.9.3 — Named-target fidelity**: a named object that searches can't find
is a full stop, list the closest existing names, ask how to proceed, never "pick the
closest match" — with the explicit carve-out that an empty search is expected when the
user asked to *create* the object.

### 6. Empty-result hints (`src/tools-metadata.js`)

`search_metadata` and raw program searches now attach an `_hint` on empty name-filtered
results spelling out the stop-and-ask expectation, so even a model that slips past the
mechanical gate (e.g. via a tool not in the gated list) gets the message inline.

## Why both a gate and a prompt

The prompt rule handles the general case and educates the model. The mechanical gate is
the backstop for exactly the failure that happened: a model that has write authorization
and a plausible lookalike in hand will, under pressure to complete a big request, talk
itself into proceeding. The gate makes that specific substitution **impossible** without
the user's explicit go-ahead.

## Verification

`npm run verify` (green), with new regression tests:
- generic / wrong-object-type searches do **not** arm the guard (lookalike write allowed)
- a specific failed program search **arms** it → lookalike write is blocked with scope
  `named_program_substitution_blocked`
- a write on a program whose name **matches** the missing one passes **and disarms**
- a later variant-spelling match also disarms

The verify harness verdict was made async-aware (`setImmediate`) because the guard's
name-resolution path is a promise.

Version 2.8.16 → 2.8.17.
