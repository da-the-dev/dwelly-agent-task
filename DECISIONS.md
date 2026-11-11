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

## Open: decide at the rung where it matters
- **Model for the live session** (rung 2): keep DeepSeek flash or move up, decided by the eval scores. Cost per case to measure on the evals. Note: the smoke call used 375 completion tokens for a ~40-token answer (hidden reasoning tokens?). Check this before trusting the cost estimate.
- **Invalid LLM output** (rung 2): retry, fall back, or escalate to a human.
- **Left out on purpose**: (fill in as we go)
