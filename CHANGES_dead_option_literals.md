# Dead option-literal hardening (rule conditions & ASSIGN)

## Symptom
"Many program rules are not working" after building a large program that
**reuses** existing option sets. The rules import cleanly, the deep audit passes
(it validates condition *syntax*), yet in Capture many rules never fire and some
ASSIGNs never stick.

## Root cause
`rewriteOptionLiteralsGeneric()` maps option **names** in rule conditions /
ASSIGN data to the option **code** the PRV resolves (`useCodeForOptionSet=true`).
When a literal matched neither a code nor an exact (case-folded) option **name**,
the old code:

- left the comparison **unchanged** (so `#{var} == 'Some Value'` stays dead —
  the value isn't a real code, so it can never match), and
- pushed only a soft `condition_option_advisories` string.

The dead rule then **shipped silently**. This is invisible to the audit and to
the user until they test each rule by hand. Common triggers: a reused set whose
option **wording** differs slightly from the requested wording, punctuation
variants (`'1+'` vs `'1 +'`), or a value the model invented that isn't in the set.

## Fix (`src/tools-programs.js`)
1. **Normalized matching** in `rewriteOptionLiteralsGeneric`: before giving up,
   the literal and every option name/code are compared on a tolerant key
   (case-folded, every run of non-alphanumerics collapsed to a single space).
   `'1 +'` now resolves to the option coded/named `'1+'`; stray case/spacing no
   longer produces a dead rule. Normalized rewrites are noted in
   `condition_option_rewrites` as `(normalized match)`.
2. **Loud, structured reporting** of the genuinely-unmatchable case: a new
   `deadLiterals` return array records `{rule, variable, literal, valid_codes}`
   (or `{assign:true, literal, valid_codes}`). Both callers — `create_program`
   and `add_program_rules` — surface it in the result as:
   - `dead_option_literals`: the list, and
   - `dead_option_literals_action`: an imperative instruction to fix each literal
     to a valid option code via `manage_program_rules`, warning that the behaviour
     will otherwise silently not work.

The soft `condition_option_advisories` text is kept for backward compatibility;
`dead_option_literals` is the new machine-actionable signal so a dead rule can no
longer ship unnoticed.

## Not changed
- Option-set **reuse** already required the existing set to contain every
  requested option (superset guard, present in BOTH `create_program` and
  `add_stage`) — that half was already correct and is untouched.
- `useCodeForOptionSet=true` on option-set PRVs — already correct.

## Verification
- `npm run verify` — all checks pass.
- Standalone functional test (`scratchpad/test-rewrite.js`): exact-code untouched,
  exact-name→code, normalized `'1 +'`→`ONE_PLUS`, invalid literal reported dead
  (not rewritten), ASSIGN name→code, invalid ASSIGN reported dead. 10/10 pass.
