# dwelly-agent

An agent service for home repairs at Dwelly: it reads tenant messages, judges urgency, opens maintenance cases, books contractors and keeps people informed. Built for the Dwelly AI build session.

Status: **rung 1.** It reads the event feed into a durable inbox and traces each event. It does not act on them yet.

## Run
```sh
npm install
cp .env.example .env      # put the session token in DWELLY_TOKEN
npm run dev               # build + start
npm test                  # vitest
npm run typecheck         # src and tests
```

### Against the local fake world
```sh
(cd ../dwelly-fake-world && npm install && npm run dev)   # terminal 1
npm run build && npm run start:fake                       # terminal 2: uses .env + .env.fake
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
| `src/store/` | `Store` interface, SQLite adapter, portable `schema.sql`. |
| `src/api/client.ts` | Dwelly API client (fetch). |
| `src/llm.ts` | OpenRouter client (fetch). |
| `src/trace.ts` | JSONL traces. |
| `src/api/schema.d.ts` | Generated from `spec/openapi.json` (`npm run gen:types`). Do not edit. |
| `spec/openapi.json` | Spec snapshot, 11 Nov 2026 (`npm run fetch:spec` to refresh). |
| `data/history.json` | The 15-case archive, the answer key for the evals. |
| `test/` | vitest tests. |
| `AGENTS.md` | The brief for the coding agent. `CLAUDE.md` points to it. |
| `DECISIONS.md` | Each choice and why. |
