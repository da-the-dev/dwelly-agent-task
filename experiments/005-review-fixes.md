# 005: Review fixes (Phase 1) and `reply.v3`

| | |
|---|---|
| Date | 2026-11-16 01:40 to 02:03 (local) |
| Criteria | v1 |
| Kind | eval (`npm run eval -- --set scenarios --reply`, `npm run eval -- --reply`) and e2e (`npm run e2e`, scenario `rung5`) |
| Set | `scenarios` (no longer held out for the writer: 004 and this experiment tuned on it) and `cases` (fit) |
| Code | branch `review-fixes` at `35560a3` (plus the AGENTS.md edit, docs only) |
| Model | `deepseek/deepseek-v4.1-flash-1017`, DeepInfra fp8 (pinned) |
| Prompts | `classify.v2@ac3f84a93520` (no change); before `reply.v2@2e597f375b36`, after `reply.v3@36ba9d23bfb7` |
| Runs | 60 + 72 eval runs, 285 calls; 1 e2e run (16 events, 16 LLM calls) |
| Cost | $0.019 + $0.022 + $0.003; median call 952 ms / 938 ms |
| Evidence | `evals/runs/2026-11-15T21-40-07-364Z__…__classify.v2+reply.v3__scenarios.json`, `evals/runs/2026-11-15T21-50-02-778Z__…__classify.v2+reply.v3.json`, `e2e/runs/2026-11-15T22-01-24-689Z-rung5.md`; before: the reports of experiment 004 |

## Question
Two outside reviews (16 Nov) found rules that did not fit together. Phase 1 fixes the deterministic ones. Does the agent keep its results, and is the `gas-update` gap closed?

## Setup
Seven commits on `review-fixes`, each with its tests (181 → 189 unit tests):
1. **`needs_review` lifecycle.** The agent sets the flag and never clears it. An action found `unknown` after a crash now sets it.
2. **Loop guard.** A stopped message is kept as a `held` action, so the 7th message is stopped too. It used to go out.
3. **72 h join.** The window counts from the close, not from the last update.
4. **`OPEN_CASE_OUT_OF_SCOPE=false`.** A case kept only by us that becomes a repair gets its `POST`, not a lone `PATCH`.
5. **`gas-update`.** A new `speakFor` reason, `open_emergency`: in an open emergency, every tenant message gets an answer. `reply.v3` = `reply.v2` + one line for that reason. **This is the only change that can move the eval numbers.**
6. **Phone check.** It finds 8 or more digits whatever the separators (`0800-111-999` used to get through).
7. **Leftovers.** Langfuse names each generation after its prompt, the test-only schema wrapper is gone, and DECISIONS.md has a rung 5 section and a regex policy.

Classify did not change, so its numbers show only the run-to-run spread.

## Results against criteria v1
| Check | `scenarios` 004 | `scenarios` 005 | `cases` 004 | `cases` 005 |
|---|---|---|---|---|
| H1 critical under-rated | 0 | 0 | 0 | 0 |
| H2 safety line | 9/9 | **12/12** | 18/18 | 18/18 |
| H3 help claims (pattern, then each hit read) | 0 | 0 | 0 | 0 |
| H4 phone numbers | 0 | 0 | 0 | 0 |
| H5 role guard | 0 breaches | 0 breaches | n/a | n/a |
| T1 urgency | 57/60 (95 %) | 57/60 (95 %) | 72/72 | 72/72 |
| T2 next step | 57/60 (95 %) | 57/60 (95 %) | 72/72 | 72/72 |
| T3 status | 6/6 | 6/6 | n/a | n/a |
| T4 who gets a message | 21/24 (88 %) | **24/24 (100 %)** | n/a | n/a |
| T5 other claims | 0 | 0 | 0 | 0 |
| T6 sign-offs | 0/48 | 0/51 | 5/72 | 2/72 |
| T7 fallbacks / invalid | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| T8 median (max) words | 94 (149) | 90 (139) | 105 (157) | 95 (148) |

- **The pattern hits that are not claims.** In `cases` 005, the 4 hits are all "until … arrive(s)": "keep away until help arrives" (`case-01`), "turn it off until the plumber arrives" (`case-04`), and twice "until the police arrive" after a 999 call (`intruder-now`). By the criteria, none is a claim. The open question in `CRITERIA.md` is still open.
- **H3 and H4 are measured by patterns,** plus a read of each hit and of each emergency reply. So "0" means "0 found", not "0". The reviews showed that the patterns miss rewordings (Phase 2, step 7).
- **The 3 new `gas-update` replies** are 66–76 words. Each starts with the 999 line, thanks the tenant for getting out, and repeats the main safety step. One says the gas service "will attend to find and stop the leak" without "after you call". By the criteria this is not a help claim, but it is close.
- **"The emergency number above" with no number above** (004, finding 2): 4 replies in `scenarios` and 1 in `cases`. As expected, because Phase 2, step 5 fixes it.
- **e2e** (`rung5`, 102 s): all 12 fail-level checks pass, and the 2 warnings (held messages, needs review) are clear. The gas tenant's update (evt_21) now gets a message with reason `open_emergency`, and it starts with the 999 line. When the engineer capped the supply (evt_35), the urgency went down to medium with one `PATCH`, and the tenant's "thanks" got no message.

## Verdict
- **`scenarios`: PASS.** This is the first PASS: all hard checks and all targets are met. T1 is exactly at its limit (95 %). The set is no longer held out for the writer, so this PASS shows that the fix works, not that the writer generalises.
- **`cases`: BELOW TARGET**, because of T6 (2 sign-offs in 72; 5 in 004). Sign-offs come and go between runs. The fix is in code (a later step).
- No hard failure in any run. Keep `reply.v3` and the Phase 1 code.

## Findings
1. **`gas-update` is closed (agent).** Who gets a message: 21/24 → 24/24. It also works end to end.
2. **The floor matched a gas "leak" as a water escape (agent, regex; e2e evt_35).** "He found the leak straight away … capped the supply" fired the rule "water escape" (medium). It changed nothing this time, because the model also chose medium. It is one more example for Phase 2: the regex cannot tell a gas leak from a water leak.
3. **`smoke-alarm-chirp` and `locked-out` still fail 0/3,** as in 003 and 004. The smoke rule is a Phase 2 item. The `locked-out` expectation waits for the user's decision.
4. **A summary written from a fake-world answer that does not fit (fake world, e2e evt_28).** Leo's archive line "Tuesday morning is fine … See you then" made the classifier write "a visit is now arranged". No visit is arranged, because rung 4 is not built. This comes from the fake world's mismatched answer (002, finding 3), not from a real tenant.
5. **Sign-offs vary from run to run.** `cases`: 5 → 2 with no change aimed at them. Remove them in code.

## Next
1. The user reviews `review-fixes` and decides about the merge, the push and a tag.
2. The user pushes `reply.v3` to Langfuse: `npm run prompts -- push reply.v3 --label production`.
3. The user's decisions: the `locked-out` expectation; the "until … arrives" pattern.
4. After the live session: Phase 2 (`docs/phase2-perception-plan.md`).
