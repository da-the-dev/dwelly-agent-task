# 004: `reply.v2`: no "we're checking"

| | |
|---|---|
| Date | 2026-11-15 23:03 to 23:52 (local) |
| Criteria | v1 (T5 measured with the wider `REPLY_CLAIM` from `ca89913`) |
| Kind | eval, before and after one prompt change: `npm run eval -- --reply` and `npm run eval -- --set scenarios --reply` |
| Set | `scenarios` (held out until this experiment) and `cases` (fit) |
| Code | branch `scenarios` at `ca89913` |
| Model | `deepseek/deepseek-v4.1-flash-1017`, DeepInfra fp8 (pinned) |
| Prompts | `classify.v2@ac3f84a93520`; before `reply.v1@77e4f463621e`, after `reply.v2@2e597f375b36` |
| Runs | after: 72 + 60 runs, 285 calls; extra v1 sample: 60 runs, 130 calls |
| Cost | after $0.041; extra v1 sample $0.018 |
| Evidence | before: the reports of 001 and 003, scored again with the new check; extra v1 sample `evals/runs/2026-11-15T19-03-15-128Z__…__classify.v2+reply.v1__scenarios.json`; after `evals/runs/2026-11-15T19-30-40-302Z__…__classify.v2+reply.v2.json` and `evals/runs/2026-11-15T19-43-13-970Z__…__classify.v2+reply.v2__scenarios.json` |

## Question
Experiment 003 found a T5 claim: "We're checking whether your landlord holds a spare" (`locked-out`). Nobody checks anything. Does one prompt rule stop the writer from saying that an action is in progress, with nothing else getting worse?

## Setup
- **The change** (`prompts/reply.v2.md`, one variable):
  - A new "Never" rule: never say that we are doing something right now ("we're checking", "we're asking your landlord"); write "we will check".
  - The `asked` rule now says "say that we do not know yet and that we will find out".
- **The measurement:** `REPLY_CLAIM` now also counts "we're / we are (now) checking / asking / contacting / chasing / speaking to / getting in touch / liaising / looking into / finding out". The v1 reports of 001 and 003 were scored again with it, at no cost, as the "before".
- **Classify is unchanged.** Its numbers repeat 001 and 003 and show the run-to-run spread only.
- **A mistake in the run order:** the first "after" run of `scenarios` (19:03 UTC) ran `node dist/tools/eval.js` directly, without a build, so it used `reply.v1`. Its report name and its `reply_prompt` field say v1, so it is valid, as a second v1 sample. `npm run eval` builds first; use it. The `scenarios` run with v2 was done again at 19:43 UTC.

## Results against criteria v1
The reply checks, for each run (H1, H5, T1 to T4 and T7-invalid do not depend on the writer, and they are the same as in 001 and 003):

| Check | `cases` v1 (001) | `cases` v2 | `scenarios` v1 (003) | `scenarios` v1, sample 2 | `scenarios` v2 |
|---|---|---|---|---|---|
| H2 safety line | 18/18 | 18/18 | 9/9 | 10/10 | 9/9 |
| H3 help claims (read by hand) | 0 | 0 | 0 | 0 | 0 |
| H4 phone numbers | 0 | 0 | 0 | 0 | 0 |
| `claims` regex hits | 4 | 4 | 1 | 1 | **0** |
| T5 other claims (read by hand) | 0 | 0 | **1** (`locked-out` r0) | **1** (`locked-out` r1: "I'm checking whether we hold one") | **0** |
| T6 sign-offs | 5/72 | 5/72 | 2/48 | 0/48 | 0/48 |
| T7 template fallbacks | 0 | 0 | 0 | 2/48 (4 %) | 0 |
| T8 median / max words | 101 / 137 | 105 / 157 | 98 / 147 | 98 / 142 | 94 / 149 |

- **Regex hits that are not claims:** all 4 hits in each `cases` run come from the "until … arrives" pattern, and each one describes a visit that the next step supports, or help after a 999 call. Examples with v2: "until a locksmith arrives" (`calm-door-lock`), "until the police arrive" (`intruder-now`), "until someone arrives" (`panicky-drip`). See the open question in `CRITERIA.md`.
- **The 2 fallbacks in v1 sample 2** (`elderly-no-heat` r2, `escalation` r0) were empty answers from the provider ("OpenRouter: no message content"), not a prompt problem.
- **`locked-out` with v2**, the sentence about the key in all 3 runs:
  - "We don't know yet whether the office holds a spare set for your flat — we will check and come back to you on that."
  - "we don't know yet whether one is available — we will find out and come back to you."
  - "we don't know yet whether we hold one for your flat, so we'll check and come back to you."

Verdicts:
- **`scenarios` v2:** BELOW TARGET, because of T4 (21/24, `gas-update`, no change from 003). T5 and T6 now pass.
- **`cases` v2:** BELOW TARGET, because of T6 (5/72 sign-offs, no change from 001).

There is no hard failure in any run.

## Verdict
**Keep `reply.v2`.** The T5 claim went away: v1 made it in 2 of 6 `locked-out` runs (both samples), and v2 in 0 of 3. With v2, no reply in 120 has a claim when read by hand. Nothing got worse: the safety line, help claims, fallbacks and length are the same. The sample is small, so "0 of 3" shows the direction, not a rate.

## Findings
1. **The rule works on its target (agent, writer).** All 3 `locked-out` replies now say "we don't know yet … we will check". This is the wording that the rule asks for.
2. **"The emergency number above" when there is no number above (agent, writer; new, not in criteria v1).** In every run, v1 and v2 alike, 2 to 5 replies to a case that is not an emergency say "use / call the emergency number above". Code adds that number only in an open emergency, so the reference points to nothing:
   - v1: `case-06`, `case-08`, `elderly-no-heat`, `injection`, `vague-boiler`;
   - v2: `calm-no-heat-cold`, `case-08`, `elderly-no-heat`, `injection`, `locked-out`, `vague-boiler`.

   Likely cause: the writer prompt allows "the emergency number above", but the writer cannot see if code will add the line. Proposed fix: `writerInput` passes `safety_line: true | false`, and the prompt allows the reference only when it is true. Proposed criteria v2 row: "a reply refers to text that is not in the message".
3. **Sign-offs did not change (agent, writer).** 5/72 on `cases` with both prompts, and 2, 0, 0 of 48 on `scenarios`. A prompt rule alone does not fix it. Code should remove a sign-off at the end (experiment 001, finding 1).
4. **The run order mistake (process).** Use `npm run eval`, which builds first. A direct `node dist/…` call can run an old prompt.
5. **The regex is now mostly noise on `cases`.** All 8 `cases` hits (4 per run) are "until … arrives" sentences that are not claims. That open question is the user's to decide.

## Next
None of this starts tonight.
1. The `gas-update` fix in `speakFor` (T4, still 0/3), the most serious open item.
2. Finding 2: `safety_line` in the writer input, then `reply.v3`.
3. Finding 3: remove sign-offs in code.
4. The user decides on the "until … arrives" pattern.
