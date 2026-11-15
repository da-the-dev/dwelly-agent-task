# Phase 2: move perception from regex to the model

Status: **planned, not started.** This is a separate piece of work, after the live session (Tue 17 Nov 2026). Phase 1 (the deterministic fixes from the same reviews) is on the branch `review-fixes`.

## Why
On 16 Nov two outside code reviews tested the agent's text rules with simple rewording. The rules break:

| Rule | Where | Fails on |
|---|---|---|
| Safety floor (regex) | `src/agent/floor.ts` | "I can smell natural gas" (no match); "There is no doubt I smell gas" (read as a negation); "The smoke alarm needs a new battery. No smoke" (high); "small leak under the sink. The bedroom lights work normally" (emergency); "The gas smell has gone. The engineer confirmed everything is safe." (stays emergency and external) |
| "They asked us something" = the text has a `?` | `asks()` in `src/agent/speak.ts` | "Please confirm the appointment time." gets no answer when the case does not change |
| New open questions = exact string compare | `speakFor` in `src/agent/speak.ts` | "Is the floor wet?" → "Is there water on the floor?" counts as new, so the tenant gets a message with nothing new |
| Claim check in the eval (regex) | `replyClaims` in `src/eval/score.ts` | Misses "We’ve booked" (curly apostrophe) and "Your appointment is confirmed"; flags "No one is on their way" |

The user's rule (16 Nov): a regex on free text does not generalise. **The model extracts structured facts, and code applies fixed rules to them.** A pattern may still check the format of our own output (for example the phone check). It never does perception.

## The plan
1. **`classify.v3` with structured facts.** New fields in the classify output:
   - `hazards_present`: a list from a fixed set (gas, carbon_monoxide, water_near_electrics, fire_smoke_sparks, water_into_other_flat, no_heat_in_cold, cannot_lock, no_heat, water_escape). A hazard that the message says is resolved is not present.
   - `asks_question`: the message asks us something or asks us to do something.
   - `new_question`: our open questions now include one that we did not ask before.
   - `same_problem`: the message is about the problem of the case we gave it (null when there is no case).
2. **The floor becomes rules over the model's facts** (user decision, 16 Nov). A table in code maps each hazard to a minimum urgency, and gas and CO also force `external`. The regex rules run **only when the model's answer is invalid**, as a fallback. This fixes the "gas smell has gone", "smoke alarm", "natural gas" and "lights work normally" cases. The cost: if the model misses a hazard, code no longer catches it. The paraphrase set (step 6) measures that.
3. **Linking by `same_problem`.** Today a tenant's message joins the open case at the property, or a case closed less than 72 h ago, whatever it is about. With `same_problem: false`, the agent starts a new case and classifies the message again with `case: null`.
4. **`speakFor` reads `asks_question` and `new_question`** instead of `?` and an exact string match.
5. **`reply.v4`.** The writer input gets `safety_line: true | false`. The prompt allows "the emergency number above" only when it is true (experiment 004, finding 2: 2–5 replies per run refer to a number that is not there).
6. **A paraphrase eval set**, `evals/paraphrase.json`. Items have a `group`; every item in a group has the same meaning with other punctuation, synonyms, word order, negation, a resolved hazard or an unrelated fault. Start with the reviewers' examples above. The report shows, for each group, whether all items got the same decision.
7. **An LLM claim judge** for the eval (`prompts/judge-claims.v1.md`). For each reply it returns the claims and their type (help claim or other claim). Check it against about 30 replies labelled by hand before it is trusted. The regex becomes a cheap pre-filter only.
8. **Eval through the handler**, with an in-memory store, so that the evals also cover case linking, the loop guard and the 72 h join. Today the eval calls `decide` and `speakFor` directly and skips them.
9. **Criteria v2** (`experiments/CRITERIA.md`):
   - say that `evals/scenarios.json` is no longer held out for the writer (experiment 004 tuned `reply.v2` on it);
   - add a new held-out set that nobody reads during tuning;
   - add the row "a reply refers to text that is not in the message".
10. **Known debt, not planned:** the case fields are listed in 6 places (the interface, two tables, `CASE_COLS`, `caseValues`, the reverse mapping and the changed-fields list).

## Order and checks
- Steps 1–4 are one change (`classify.v3`): an eval run before and after it on `cases`, `scenarios` and the new paraphrase set, plus an experiment write-up.
- Step 5 is a separate change (`reply.v4`), with its own runs.
- Steps 6 and 7 come first, so the "before" run of step 1 already measures what step 1 must fix.
