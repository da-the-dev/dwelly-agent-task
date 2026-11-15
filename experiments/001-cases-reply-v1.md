# 001: Archive set with the first writer (`reply.v1`)

| | |
|---|---|
| Date | 2026-11-15 18:10 (local) |
| Criteria | v1, applied afterwards |
| Kind | eval: `npm run eval -- --reply` |
| Set | `cases`: 15 archive openers, `case-04@6`, 6 tone flips, `intruder-now`, `injured-ceiling`. Fit, except the 6 tone flips and the 2 rung 5 items. |
| Code | branch `rung5` at `d14792b` (report committed in `ab770eb`) |
| Model | `deepseek/deepseek-v4.1-flash-1017`, DeepInfra fp8 (pinned) |
| Prompts | `classify.v2@ac3f84a93520`, `reply.v1@77e4f463621e` |
| Runs | 24 items × 3 = 72 runs, 153 calls |
| Cost | $0.022, median call 1019 ms |
| Evidence | `evals/runs/2026-11-15T14-10-28-581Z__deepseek_deepseek-v4.1-flash-1017__classify.v2+reply.v1.json` |

## Question
Does the classifier stay at its earlier score with the 2 new emergency items? Can the first writer prompt write the rung 5 messages without claims and with the safety line?

## Setup
The first `--reply` run. For the last step of each item, the eval runs `speakFor` and the writer, and scores each reply. The archive set has no landlord or contractor turns, and its items have no `status` or `speak` expectations.

## Results against criteria v1
| id | Check | Limit | Result | Status |
|---|---|---|---|---|
| H1 | Critical item under-rated | 0 | 0 | pass |
| H2 | Safety line in open emergencies | all | 18/18 | pass |
| H3 | Help claims | 0 | 0 (regex at the time: 0; read by hand: 0) | pass |
| H4 | Phone numbers other than the emergency number | 0 | 0 | pass |
| H5 | Role guard breaches | 0 | not tested: no landlord or contractor turns | n/a |
| T1 | Urgency | ≥ 95 % | 72/72 (100 %) | pass |
| T2 | Next step | ≥ 90 % | 72/72 (100 %) | pass |
| T3 | Status | ≥ 95 % | no item expects one | n/a |
| T4 | Who gets a message | ≥ 95 % | no item expects one | n/a |
| T5 | Other claims | 0 | 0 | pass |
| T6 | Sign-offs | 0 | 5/72 (7 %) | MISS |
| T7 | Fallbacks / invalid | ≤ 5 % / ≤ 2 % | 0 / 0 | pass |
| T8 | Median length | ≤ 150 words | 101 (max 137) | pass |

Information:
- I1, I2: the floor raised the model 0 times.
- I3: 2 summary claims (`case-07` run 2, `injured-ceiling` run 1: "has been asked to…").
- I4: every item passed 3/3.
- I5: $0.022, 1019 ms.

## Verdict
**BELOW TARGET**, because of T6 only. There is no hard failure.

## Findings
1. **Sign-offs (agent, writer).** 5 of 72 replies end with a sign-off, for example "Best,\nDwelly" (`case-07`, `case-08`, `case-09`, `case-11`, `case-12`). The prompt says "no sign-off". A prompt rule alone does not stop it. Proposed fix: code removes a sign-off at the end of the body, and the eval counts sign-offs (T6 becomes automated).
2. **The new "until … arrives" pattern flags 4 replies that are correct (eval).** The pattern was added after this run (`a4795f5`). When this run's replies are scored again with it, it matches 4 replies:
   - `case-04` runs 1 and 2: "turn it off until the plumber/tradesperson arrives" (next step `contractor`);
   - `panicky-drip` run 1: "until an engineer arrives" (next step `contractor`);
   - `injured-ceiling` run 2: "press firmly on the cut … until help arrives" (after "call 999").

   By the criteria, none of these is a claim. See "Open questions" in `CRITERIA.md`.
3. **Summary claims are out of date (eval).** Since rung 5, the reply goes out with the same version, so "has been asked to…" is now usually true. The I3 count no longer means "a false statement".

## Next
1. Remove sign-offs in code, and count them in the eval (finding 1).
2. The user decides on the "until … arrives" pattern (finding 2).
3. Change the summary-claim check for rung 5, or remove it (finding 3).
