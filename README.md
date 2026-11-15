# dwelly-agent

An agent service for home repairs at Dwelly: it reads tenant messages, judges urgency, opens maintenance cases, books contractors and keeps people informed. Built for the Dwelly AI build session.

Status: **rung 3** (15 Nov 2026).

What the agent does:
- Reads the event feed into a durable inbox (at-least-once, cursor saved with the batch).
- Classifies each message (urgency, next step, safety advice) with one LLM call; a safety floor in code can raise the urgency, never lower it. The result is a new version of our own case.
- Opens and updates the case in Dwelly (`POST /cases`, `PATCH /cases/{id}`) through an outbox: a `POST` that may have happened is never sent twice.

What it does not do yet:
- Rung 4: no contractor, no work order.
- Rung 5: no message to the tenant or the landlord. What it would say is traced as `intent.message_tenant`.
- Every message goes through the tenant triage prompt, whatever the sender's role.

## Run
```sh
npm ci
cp .env.example .env      # DWELLY_TOKEN (live session), OPENROUTER_API_KEY; LANGFUSE_* optional
npm run dev               # build + start against the live world
npm test                  # vitest
npm run typecheck         # src and tests
npm run try:classify      # the classifier on 5 archive cases (real LLM calls, ~$0.002)
npm run eval              # 22 items x 3 runs, scored; report in evals/runs/ (~$0.012)
npm run prompts -- status # prompts/ files vs Langfuse
```

### Live session runbook
1. Put the token in `.env` as `DWELLY_TOKEN`. Run `npm run dev`. State goes to `state/agent.db`, traces to `traces/<run>.jsonl` (and to Langfuse, environment `agent-live`, unless `LANGFUSE_TRACES=off`).
2. Watch the traces: `tail -f traces/*.jsonl | jq -c '{kind, event_id, error}'`.
3. `401 invalid_token`: the token is wrong, or a `DWELLY_*` variable in your shell overrides `.env`.
4. An `event.failed` line means the payload did not parse. The payload field names in `src/agent/message.ts` are not confirmed against the live world. Read the raw event (`sqlite3 state/agent.db "SELECT raw FROM inbox WHERE status='failed' LIMIT 1"`), fix `message.ts` and its test, then replay:
   ```sh
   sqlite3 state/agent.db "UPDATE inbox SET status='pending', error=NULL WHERE status='failed'"
   npm run dev
   ```
5. An `action.unknown` line: a `POST /cases` may or may not have reached Dwelly. The agent does not send it again; a person checks.
6. `session.ended` (403): the session is over. Reads still work; nothing more is sent.

### Against the local fake world
```sh
(cd ../dwelly-fake-world && npm install && npm run dev)   # terminal 1
npm run build && npm run start:fake                       # terminal 2: .env + .env.fake; ignores DWELLY_* already in your shell
```
State: `state/fake.db` (SQLite). Traces: `traces/<run>.jsonl`.

All 15 archive openers, about 1 s apart (15 LLM calls, about $0.002):
```sh
(cd ../dwelly-fake-world && SCENARIO=archive SPEED=20 npm run dev)   # terminal 1
rm -f state/fake.db*; npm run build && npm run start:fake           # terminal 2
sqlite3 state/fake.db "SELECT property_id, version, urgency, next_step, status, waiting_on, why FROM case_versions ORDER BY property_id;"
```

The fake world keeps its events in memory, so a restarted world counts cursors from 0 again. Delete `state/fake.db*` whenever you restart it, or the agent waits for cursors above its saved one and misses the new events.

### Debugging in VS Code
Run and Debug (⇧⌘D) has these configs (`.vscode/launch.json`). Breakpoints go in `src/*.ts`.
- **E2E: fake world + agent (fresh state)**: builds both, wipes `state/fake.db`, starts both under the debugger. Stop stops both.
- **Agent → fake world**: the agent alone, keeping its state (use it to test restart and resume).
- **Fake world**: the world alone (scenario `smoke`).
- **Vitest: current file**: debug the open test file.

## Layout
| Path | What |
|---|---|
| `src/main.ts` | Entry point: config, store, tracer, loop. |
| `src/agent/loop.ts` | Poll loop + transactional inbox. |
| `src/agent/handle.ts` | The per-event handler: message → case → decide → save the version and its outbox actions → trace. |
| `src/agent/actions.ts` | Rung 3, pure: which `POST`/`PATCH /cases` calls a new case version needs. |
| `src/agent/sender.ts` | Rung 3: drains the outbox after each batch (429 pauses, 403 stops, an unknown `POST` is never re-sent). |
| `src/agent/decide.ts` | Rung 2 for one message: classify → safety floor → next case version. |
| `src/agent/classify.ts` | The one LLM call: prompt file, zod-validated output, one retry, `llm.call` traces. |
| `src/agent/floor.ts` | Safety floor: hazard rules in code set a minimum urgency. |
| `src/agent/state.ts` | `status` / `waiting_on` / `outcome` from `next_step`. |
| `src/agent/message.ts` | The payload adapter (the only code that knows its field names). |
| `src/case.ts` | Our case model; a case evolves as versions (`cases` + `case_versions`). |
| `prompts/` | Prompt files, one per version (`classify.v2.md` is current). |
| `src/tools/try-classify.ts` | Run the classifier on archive cases or replay a thread. |
| `src/tools/eval.ts`, `src/eval/`, `evals/` | `npm run eval`: the eval set, scoring (a critical item rated too low is a hard fail), committed reports. |
| `src/tools/prompts.ts` | `npm run prompts`: status / pull / push between `prompts/` and Langfuse. |
| `src/trace-langfuse.ts` | Second trace sink: every trace line to Langfuse (one trace per event). The JSONL file stays the record. |
| `src/store/` | `Store` interface, SQLite adapter, portable `schema.sql`. |
| `src/api/client.ts` | Dwelly API client (fetch): events, create and patch cases. |
| `src/llm.ts` | OpenRouter client (fetch). |
| `src/trace.ts` | JSONL traces. |
| `src/errors.ts` | `describeError`: one trace line with the cause chain (fetch hides it). |
| `src/api/schema.d.ts` | Generated from `spec/openapi.json` (`npm run gen:types`). Do not edit. |
| `spec/openapi.json` | Spec snapshot, 11 Nov 2026 (`npm run fetch:spec` to refresh). |
| `data/history.json` | The 15-case archive, the answer key for the evals. |
| `test/` | vitest tests. |
| `AGENTS.md` | The brief for the coding agent. `CLAUDE.md` points to it. |
| `DECISIONS.md` | Each choice and why. |
