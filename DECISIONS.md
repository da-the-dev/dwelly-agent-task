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
| Schema validator | zod v4, **added at rung 2** | One schema gives the runtime check of the LLM output, the TS type and the JSON Schema for structured output. Not installed until code uses it. | Hand-written guards |
| HTTP | global `fetch` | Built in. 8 endpoints do not need a client library. | axios / generated client |
| Config | `node --env-file=.env` | Built in. | dotenv |
| LLM gateway | OpenRouter | One key, many models: we can swap the model with `LLM_MODEL` and compare eval scores without code changes. | A direct provider API (one vendor, one SDK) |
| LLM client | plain `fetch` (`src/llm.ts`, ~100 lines) | One endpoint. We control the request (strict `json_schema`, `provider.require_parameters`) and the trace fields (served model, provider, tokens, cost, latency). | `openai` SDK pointed at OpenRouter: one more dependency for one call |
| Model (dev/eval) | `deepseek/deepseek-v4.1-flash-1017` | A dated snapshot, so eval runs are comparable (not a `~latest` alias). Cheapest option with structured outputs. Smoke call: ~$0.0003, 1.8 s. | Change it for the live run if the evals say so |
| Package manager | npm, exact versions | Ships with Node. Exact versions mean the clean clone on 17 Nov installs what was tested. | pnpm |

devDependencies: `typescript`, `@types/node`, `vitest`, `openapi-typescript`. Runtime dependencies: none (yet).

## Open: decide at the rung where it matters
- **State** (rung 1): where the cursor, the seen event ids and our case and work-order ids live. Remember that the API has no GET for cases.
- **Polling** (rung 1): loop and sleep interval; what happens after a crash, between "call made" and "state saved".
- **Model for the live session** (rung 2): keep DeepSeek flash or move up, decided by the eval scores. Cost per case to measure on the evals. Note: the smoke call used 375 completion tokens for a ~40-token answer (hidden reasoning tokens?). Check this before trusting the cost estimate.
- **Invalid LLM output** (rung 2): retry, fall back, or escalate to a human.
- **Left out on purpose**: (fill in as we go)
