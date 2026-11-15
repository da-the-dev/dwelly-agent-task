# 002: End-to-end run on the fake world, rung 5

| | |
|---|---|
| Date | 2026-11-15 21:57 (local) |
| Criteria | v1, applied afterwards |
| Kind | fake-world run: the whole agent (inbox, handler, outbox, sender) against `../dwelly-fake-world` |
| Set | fake-world scenario `rung5` (`SCENARIO=rung5 SPEED=10`): openers from archive cases 05, 03 and 07, a landlord question at 30 s, and an answer from the actor 5 s after each message we send |
| Code | agent: branch `rung5` at `b4f60a3`; fake world: branch `rung5` at `83c7d3e` |
| Model | `deepseek/deepseek-v4.1-flash-1017`, DeepInfra fp8 (pinned) |
| Prompts | `classify.v2@ac3f84a93520`, `reply.v1@77e4f463621e` |
| Runs | 1 run: 14 events (9 messages, 5 `case.*` events), 14 LLM calls |
| Cost | $0.0028 |
| Evidence | `traces/2026-11-15T17-57-58-513Z.jsonl` (not committed; the lines that matter are copied below), `GET /_admin/state` of the fake world |

## Question
Does rung 5 work end to end? In particular:
- Does the gas message start with the 999 line?
- Does a "thanks" get no message?
- Does the landlord's question get one answer?
- Does an answer after a close note join the closed case?

## Setup
The fake world was started first, then `npm run start:fake`. The agent handled all 14 events in 85 s, from 17:57:58 to 17:59:21. After that the world had nothing more to send.

This is not a scored eval. The fake world has no expected answers. A person compared each message with the criteria. There is one run only, so I4 (stability) has no data.

## Results against criteria v1
| id | Check | Limit | Result | Status |
|---|---|---|---|---|
| H1 | Critical item under-rated | 0 | The gas report was `emergency` / `external`. | pass |
| H2 | Safety line in open emergencies | all | 1/1: "If anyone is in danger, get to a safe place and call 999 now." | pass |
| H3 | Help claims | 0 | 0. The current regex matches 1 sentence: "Keep others away from the hall until the engineer arrives". Read by hand, it is not a claim: the same reply says the gas emergency service handles it and asks the tenant to call the number now. | pass |
| H4 | Phone numbers other than the emergency number | 0 | 0 | pass |
| H5 | Role guard breaches | 0 | 0. Both landlord messages (evt_10, evt_30) kept the next step and the state ("role guard (landlord)"). | pass |
| T1 | Urgency | ≥ 95 % | 3/3 openers, read by hand (case-05 emergency, case-03 low, case-07 medium) | pass |
| T2 | Next step | ≥ 90 % | 3/3 (external, need_info then log_only, contractor) | pass |
| T3 | Status | ≥ 95 % | 1/1: the scuff case closed after the photos | pass |
| T4 | Who gets a message | ≥ 95 % | 8/9 (89 %). See finding 1. | MISS |
| T5 | Other claims | 0 | 0 | pass |
| T6 | Sign-offs | 0 | 0/5 | pass |
| T7 | Fallbacks / invalid | ≤ 5 % / ≤ 2 % | 0 / 0 | pass |
| T8 | Median length | ≤ 150 words | 97 (85 to 110) | pass |

Who got a message, for each incoming message:

| Event | From | Text, in short | Expected | Got |
|---|---|---|---|---|
| evt_1 | tenant_06 | strong gas smell in the hall | tenant | tenant (with the 999 line) |
| evt_5 | tenant_11 | scuffs and a hairline crack | tenant | tenant (3 questions) |
| evt_8 | tenant_05 | dead fan in a windowless bathroom | tenant | tenant |
| evt_10 | landlord_05 | "Is it something the tenant caused? And what is it likely to cost?" | landlord | landlord |
| evt_21 | tenant_06 | "Front door is propped open and I'm out on the pavement…" | tenant (open emergency) | **nobody** |
| evt_25 | tenant_11 | photos, "I'll have a go myself" | tenant (close note) | tenant |
| evt_28 | tenant_05 | "Tuesday morning is fine… See you then." | nobody | nobody |
| evt_30 | landlord_05 | "Thanks for keeping me posted." | nobody | nobody |
| evt_35 | tenant_11 | "Thanks, will do." (joined the closed case, `recent_closed_case`) | nobody | nobody |

All 10 outbox actions were `sent` (5 `msg_send`, 3 `case_open`, 2 `case_patch`). No action was `failed` or `unknown`.

## Verdict
**BELOW TARGET**, because of T4 only. There is no hard failure.

## Findings
1. **The gas tenant's update got no message (agent, `speakFor`).** In an open emergency, the tenant wrote that they were outside. The case did not change and the message had no question, so `speakFor` sent nothing. On 15 Nov the user decided that every tenant message in an open emergency gets an answer. Proposed fix: a new reason in `src/agent/speak.ts` for an open emergency. The loop guard still stops it at 5 messages in a row. Scenario `gas-update` in experiment 003 now checks this.
2. **I changed my view on "until the engineer arrives" (criteria).** After this run, I called it a weak claim, and the claim check now counts it. Criteria v1 defines a claim more exactly, and by that definition this sentence is not a claim. See "Open questions" in `CRITERIA.md`.
3. **One fake-world answer does not fit (fake world).** The fake world answers with the next archive message, so Leo agreed to "Tuesday morning", but the agent offered no time. The agent sent nothing back, which is correct. Rung 4 (contractor and time slots) will make the answers fit.

## Next
1. The `speakFor` change for open emergencies, then experiment 003 again (finding 1).
2. The user decides on the "until … arrives" pattern (finding 2).
