# dwelly-agent

An agent service for home repairs at Dwelly: it reads tenant messages, judges urgency, opens maintenance cases, books contractors and keeps people informed. Built for the Dwelly AI build session.

Status: **rung 2, in progress.** It reads the event feed into a durable inbox and traces each event. The rung 2 classifier (urgency, next step, safety advice, as versions of our own case) works on archive cases (`npm run try:classify`) but is not wired into the loop yet.

## Run
```sh
npm install
cp .env.example .env      # put the session token in DWELLY_TOKEN
npm run dev               # build + start
npm test                  # vitest
npm run typecheck         # src and tests
npm run try:classify      # the classifier on 5 archive cases (real LLM calls, ~$0.002)
```

### Against the local fake world
```sh
(cd ../dwelly-fake-world && npm install && npm run dev)   # terminal 1
npm run build && npm run start:fake                       # terminal 2: .env + .env.fake; ignores DWELLY_* already in your shell
```
State: `state/fake.db` (SQLite). Traces: `traces/<run>.jsonl`.

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
| `src/agent/decide.ts` | Rung 2 for one message: classify → safety floor → next case version. |
| `src/agent/classify.ts` | The one LLM call: prompt file, zod-validated output, one retry, `llm.call` traces. |
| `src/agent/floor.ts` | Safety floor: hazard rules in code set a minimum urgency. |
| `src/agent/state.ts` | `status` / `waiting_on` / `outcome` from `next_step`. |
| `src/agent/message.ts` | The payload adapter (the only code that knows its field names). |
| `src/case.ts` | Our case model; a case evolves as versions (`cases` + `case_versions`). |
| `prompts/` | Prompt files, one per version (`classify.v2.md` is current). |
| `src/tools/try-classify.ts` | Run the classifier on archive cases or replay a thread. |
| `src/store/` | `Store` interface, SQLite adapter, portable `schema.sql`. |
| `src/api/client.ts` | Dwelly API client (fetch). |
| `src/llm.ts` | OpenRouter client (fetch). |
| `src/trace.ts` | JSONL traces. |
| `src/errors.ts` | `describeError`: one trace line with the cause chain (fetch hides it). |
| `src/api/schema.d.ts` | Generated from `spec/openapi.json` (`npm run gen:types`). Do not edit. |
| `spec/openapi.json` | Spec snapshot, 11 Nov 2026 (`npm run fetch:spec` to refresh). |
| `data/history.json` | The 15-case archive, the answer key for the evals. |
| `test/` | vitest tests. |
| `AGENTS.md` | The brief for the coding agent. `CLAUDE.md` points to it. |
| `DECISIONS.md` | Each choice and why. |
