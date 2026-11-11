# Decisions to defend

One line for each choice: what, why, and what the other option was. "The agent picked it" is not a reason.

## Stack (v0.1, 11 Nov)
| Choice | Pick | Why | Other option |
|---|---|---|---|
| Runtime | Node ≥ 24 (dev on 26 LTS) | Required by Dwelly. 24+ has `fetch` and `--env-file` built in. | — |
| TS execution | `tsc` → `dist/`, `node dist/main.js` | What runs is plain JS with no loader at runtime. Full TS syntax. The build is also the type check. | Node native type stripping (no build, but erasable syntax only); `tsx` (one more dependency) |
| TypeScript version | 5.9.3, pinned | `openapi-typescript` needs the TS 5 compiler API (peer `^5.x`). TS 7 (the native port) has no such API. | TS 7: faster `tsc`, but it breaks type generation |
| Test runner | vitest | Compiles TS itself, so tests do not need a build. Watch mode and readable diffs. | `node:test`: zero dependencies, but with native type stripping our `./x.js` imports (required by the `tsc` build) do not resolve to `.ts` files, so tests would need a build first |
| API types | `openapi-typescript` (dev only) | Types are generated from the spec that the world validates with, so they cannot drift. Erased at build: zero runtime cost. | Hand-written types or zod schemas: they can drift |
| Schema validator | zod 4.6.7 (pinned; added at rung 2, the first code that needs it) | One schema gives the runtime check of the LLM output, the TS type, and (`z.toJSONSchema`) the strict JSON Schema we send as `response_format`, so the three cannot drift. `z.strictObject` emits `additionalProperties: false` with every key required, which strict mode needs. The only runtime dependency. | Hand-written guards plus a hand-written JSON Schema (two copies of one shape) |
| HTTP | global `fetch` | Built in. 8 endpoints do not need a client library. | axios / generated client |
| Config | `node --env-file=.env` | Built in. | dotenv |
| LLM gateway | OpenRouter | One key, many models: we can swap the model with `LLM_MODEL` and compare eval scores without code changes. | A direct provider API (one vendor, one SDK) |
| LLM client | plain `fetch` (`src/llm.ts`, ~100 lines) | One endpoint. We control the request (strict `json_schema`, `provider.require_parameters`) and the trace fields (served model, provider, tokens, cost, latency). | `openai` SDK pointed at OpenRouter: one more dependency for one call |
| Model (dev/eval) | `deepseek/deepseek-v4.1-flash-1017` | A dated snapshot, so eval runs are comparable (not a `~latest` alias). Cheapest option with structured outputs. Smoke call: ~$0.0003, 1.8 s. | Change it for the live run if the evals say so |
| LLM provider (11 Nov) | Pinned: OpenRouter endpoint `deepinfra/fp8`, `allow_fallbacks: false` (`LLM_PROVIDERS`, `any` unpins) | Unpinned, our first 8 calls went to 5 providers with different quantizations (fp4, mxfp4, fp8, unknown), so two runs of the same eval were not comparing like with like. DeepInfra fp8 standard tier: a stated quantization, strict structured outputs, $0.098 / $0.294 per 1M tokens; the first pinned run was cheaper and faster than the unpinned one. The cost: if DeepInfra is down, calls fail instead of moving elsewhere (add a second endpoint to the list for the live session if needed). | Cheaper `flex` tiers (lower priority, can be preempted); fp4 endpoints (cheaper, more quantization loss); DeepSeek's own endpoint (no strict `json_schema`) |
| Package manager | npm, exact versions | Ships with Node. Exact versions mean the clean clone on 17 Nov installs what was tested. | pnpm |

devDependencies: `typescript`, `@types/node`, `vitest`, `openapi-typescript`. Runtime dependencies: `zod`.

## Rung 1: reading events (11 Nov)
| Choice | Pick | Why | Other option |
|---|---|---|---|
| State store | SQLite through `node:sqlite`, behind an async `Store` interface (`src/store/`) | Built into Node: no dependency. Transactions let us save the batch and the cursor together. The interface is async and the SQL is portable (`ON CONFLICT`), so a Postgres adapter (`pg`) can replace it for dev/stage/prod without touching callers. Same idea as LangGraph's SqliteSaver / PostgresSaver. | JSON file (no transactions); in memory (a restart re-reads everything and duplicates cases); an ORM such as Kysely or Drizzle (one query layer for both databases, but a dependency for ~6 queries) |
| Delivery pattern | Transactional inbox: fetch → store batch + cursor in one transaction → process pending events → mark done/failed | A crash before the commit re-fetches the batch (the cursor did not move). A crash during processing leaves the event pending, and it runs again after a restart. **At-least-once**, so any handler that changes the world must be idempotent (rung 3: record the intent before `POST /cases`). | Advance the cursor after processing (a slow LLM call holds up the feed and one bad event blocks everything) |
| Poison events | Mark `failed` with the error, trace it, move on | One bad event must not stop the feed. Failed events stay in the inbox for inspection and replay. | Retry forever (blocks the queue) |
| Loop | `while` + sleep (2 s, `POLL_INTERVAL_MS`). Poll again straight away when a page is full. Exponential backoff on errors, capped at 30 s. Stops cleanly on SIGINT/SIGTERM. | One process, no overlapping ticks, easy to read in the traces. | `setInterval` (ticks overlap when a poll is slow) |
| Traces | One JSONL file per run in `traces/`, plus stdout. Synchronous append. | `grep`/`jq`-able in the session. The sync write means the line that explains a crash is on disk. | A logging library (pino): faster, but one more dependency |
| Fake-world state | A separate DB (`state/fake.db`) via `.env.fake` | Fake runs never mix with the real session's state. | — |

## Rung 2: understand the problem (11 Nov)
Design worked out on a diagram first (`../dwelly-history-eda/diagram/`), from a read of the 15 archive cases.

| Choice | Pick | Why | Other option |
|---|---|---|---|
| LLM calls per message | One: classify (`src/agent/classify.ts`) | Which case a message belongs to comes from the payload (case ref, else the open case at the property): a rule, not a model. One call is one prompt, one schema, one eval to tune. | A second "link" call (new problem / update / chit-chat). Dropped while we assume the payload carries what we need; Dwelly was asked on 11 Nov |
| Payload shape | One adapter, `readMessage` (`src/agent/message.ts`) | `Event.payload` is an open object in the spec. Only this file knows the field names; unknown shapes fail loudly with the payload keys in the trace. | Reading `payload.body` wherever it is needed |
| Case state | `cases` (latest) + append-only `case_versions` (same real columns), `actors` | Markov: the latest version is all the classifier sees, so `summary` and `open_questions` carry the memory. History is for review and debugging with plain SQL. A version for every event on a case, even with no change; `UNIQUE (case_id, cause_id)` makes a redelivered event a no-op. | An urgency log + facts table (more tables, same information); JSON snapshots (`json_extract` by hand is clumsy); full event sourcing (most code to explain) |
| Status | Three fields set by code from `next_step`: `status` (Dwelly's own enum), `waiting_on`, `outcome` | `status` can be PATCHed as is; `waiting_on` says who has the next move (follow-ups when people go quiet). The model never sets them. | One detailed enum (grows every rung, needs mapping to Dwelly's) |
| Trade | Not stored; `contractor_id` instead (rung 4) | Rung 4 works out the trade from the summary when it picks. | A `trade` column |
| Safety floor | Code rules set a minimum urgency (`src/agent/floor.ts`); the model may raise, never lower | The dangerous cases (gas, water + electrics, burning smell, unsecured home, no heat in the cold, water into another flat) must not depend on a prompt or a model. Deterministic, unit-tested on the archive for free. Over-fires on purpose. | Rules only in the prompt |
| Invalid model output | Retry once with the zod error; still invalid: `needs_review`, urgency = max(previous, floor, medium) | A bad answer is usually fixed by showing the model the error. After that a person should look; the urgency never drops on a failure. | Fail the event (no record); retry forever |
| Prompts | Files in `prompts/`, versioned by git; the version is name + content hash, on every `llm.call` trace | Separate from code, reviewable in diffs, any edit is visible in the traces. Old versions stay to compare (`try:classify --prompt classify.v1`). | A prompt server (Langfuse, Phoenix): a runtime dependency on a server for the session |
| LLM call records | In the traces (`llm.call`: input, raw output, parsed, prompt version, provider, tokens, cost), no table | One place to look; a viewer (Phoenix) can read them later. | A `classifications` table |
| Out-of-scope cases | `OPEN_CASE_OUT_OF_SCOPE` config (planned with the handler) | Opening a case tells the landlord; the archive records them anyway. | Hard-coded |

## Open: decide at the rung where it matters
- **Model for the live session**: keep DeepSeek flash or move up, decided by the eval scores. First runs: ~$0.0003 and ~0.9 s per classify call on DeepInfra fp8.
- **Closing on the first message**: `log_only` / `out_of_scope` close the case at once, so a reply from the tenant starts a new case. Revisit with rung 5 (stay open until we have replied?).
- **Summary claims actions**: the model sometimes writes "she has been asked to…" before any reply exists. Prompt v2 reduced it; an eval check should catch the rest.
- **Left out on purpose**: (fill in as we go)
