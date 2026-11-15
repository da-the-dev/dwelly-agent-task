# dwelly-agent

This service does the work of a property manager on a home repair at Dwelly. It reads the messages from tenants and landlords. It decides how urgent each problem is and what happens next. It opens and updates a maintenance case in Dwelly. It writes to the tenant and to the landlord. It was built for the Dwelly AI build session.

**Status, 16 Nov 2026: rungs 1, 2, 3 and 5 are built. Rung 4 is not started.** Tag: `v0.6`.

## What the agent does
The task is a ladder of 5 rungs. Each rung that is built has tests and traces.

| Rung | What | Status |
|---|---|---|
| 1 | Read the event feed into an inbox in the database. The cursor and the batch are saved in one transaction. | built |
| 2 | Classify each message with one LLM call: urgency, next step and safety advice. Safety rules in code can raise the urgency. They can never lower it. The result is a new version of our own case. | built |
| 3 | Open and update the case in Dwelly (`POST /cases`, `PATCH /cases/{id}`) through an outbox. The agent never sends a `POST` again if it may have reached Dwelly. | built |
| 4 | Choose a contractor and agree the work (work orders). | not started |
| 5 | Write to the tenant, and to a landlord who asks a question. | built |

Rung 5 in more detail:
- A second LLM call writes each message (prompt `prompts/reply.v2.md`).
- Code puts the safety line at the start of every tenant message in an open emergency: "If anyone is in danger, get to a safe place and call 999 now." The number comes from `EMERGENCY_NUMBER` (default `999`).
- The agent writes only when there is something new to say. A "thanks" that changes nothing gets no answer.
- A landlord or a contractor cannot lower the urgency or move the case (the role guard).
- After 5 messages in a row to one person with no change in the case, the agent stops and marks the case for review (the loop guard).
- If the writer fails, a plain template message goes instead. A message is never lost.

Known gaps (see `experiments/004-reply-v2-no-claims-in-progress.md`):
- In an open emergency, a tenant update with no question and no change gets no answer (`gas-update`, 0/3). This is the next fix.
- Some messages to cases that are not emergencies say "the emergency number above", and there is no number above.
- Some messages end with a sign-off ("Thanks, Dwelly"), although the prompt forbids it: 5 of 120 in experiment 004.
- The payload field names in `src/agent/message.ts` are not confirmed against the live world yet.

## Run
```sh
npm ci
cp .env.example .env      # set DWELLY_TOKEN and OPENROUTER_API_KEY; LANGFUSE_* is optional
npm run dev               # build, then start against the live world
npm test                  # unit tests (vitest)
npm run typecheck         # type check of src and test
```

Tools that call the real LLM (they cost money):
```sh
npm run try:classify -- case-05 case-04@6       # the classifier and the writer on archive cases
npm run eval -- --reply                         # the archive set: 24 items x 3 runs (~$0.02)
npm run eval -- --set scenarios --reply         # the scenario set: 20 items x 3 runs (~$0.02)
npm run eval -- --set scenarios --only gas-update --runs 3   # one item, fast
npm run e2e                                     # the agent against the fake world, then 12 checks (~$0.01)
```

Tools that cost nothing:
```sh
npm run story             # the newest agent trace, as one story per case
npm run prompts -- status # the files in prompts/ compared with Langfuse
```

### Live session runbook
1. Put the token in `.env` as `DWELLY_TOKEN`. Run `npm run dev`.
   - The state goes to `state/agent.db`.
   - The traces go to `traces/<run>.jsonl`, and to Langfuse (environment `agent-live`) unless `LANGFUSE_TRACES=off`.
2. Watch the traces: `tail -f traces/*.jsonl | jq -c '{kind, event_id, error}'`. Run `npm run story` to read them as one story per case.
3. `401 invalid_token`: the token is wrong, or a `DWELLY_*` variable in your shell overrides `.env`.
4. An `event.failed` line: the payload did not parse. Do these steps:
   1. Read the raw event: `sqlite3 state/agent.db "SELECT raw FROM inbox WHERE status='failed' LIMIT 1"`.
   2. Fix `src/agent/message.ts` and its test.
   3. Replay the failed events:
      ```sh
      sqlite3 state/agent.db "UPDATE inbox SET status='pending', error=NULL WHERE status='failed'"
      npm run dev
      ```
5. An `action.unknown` line: a `POST` may or may not have reached Dwelly. The agent does not send it again. A person must check. A message in an open emergency is the exception: the agent sends it one more time.
6. `session.ended` (403): the session is over. Reads still work. The agent sends nothing more.
7. A live failure becomes an eval item in `evals/scenarios.json`. Run it with `--only <id> --runs 3`, fix it, then run it again.

### Against the local fake world
The fake world is a local copy of the Dwelly API for tests (`../dwelly-fake-world`). The fastest way is `npm run e2e`: it starts the world and the agent, waits for the end of the run and checks the result. It writes a report to `e2e/runs/`.

To run the two parts by hand:
```sh
(cd ../dwelly-fake-world && npm install && SCENARIO=rung5 SPEED=10 npm run dev)   # terminal 1
rm -f state/fake.db*; npm run build && npm run start:fake                       # terminal 2
```
`start:fake` reads `.env` and `.env.fake`, and ignores any `DWELLY_*` variable in your shell. The state goes to `state/fake.db`. `curl -s localhost:8787/_admin/state` shows the cases and the messages that the world received.

The fake world keeps its events in memory. A restarted world counts the cursors from 0 again. Delete `state/fake.db*` each time you restart the world. If you do not, the agent waits for cursors above its saved cursor and misses the new events.

### Debugging in VS Code
Run and Debug (⇧⌘D) has these configurations (`.vscode/launch.json`). Put breakpoints in `src/*.ts`.
- **E2E: fake world + agent (fresh state)**: builds both, deletes `state/fake.db` and starts both in the debugger. Stop stops both.
- **Agent → fake world**: the agent only, with its saved state. Use it to test a restart.
- **Fake world**: the world only (scenario `smoke`).
- **Vitest: current file**: debugs the open test file.

## Evals and experiments
- `evals/cases.json`: the 15 archive cases, 1 archive turning point, 6 tone changes and 2 rung 5 items. The prompts were tuned on this set, so it measures fit.
- `evals/scenarios.json`: 20 scenarios written before any fix for them. They include new hazards, traps, and threads with landlord and contractor messages. This set measures new situations.
- `evals/runs/`: one committed report for each eval run.
- `experiments/CRITERIA.md`: what counts as a success and what counts as a failure. A hard failure (for example a missing safety line) makes a run FAIL. A missed target makes it BELOW TARGET.
- `experiments/NNN-*.md`: one write-up for each run that was used for a decision, judged against the criteria. Index: `experiments/README.md`.

## Layout
| Path | What |
|---|---|
| `src/main.ts` | The entry point: config, store, tracer and loop. |
| `src/agent/loop.ts` | The poll loop and the inbox transaction. |
| `src/agent/handle.ts` | The handler for one event: message → case → decision → messages → save the version and its outbox actions → traces. |
| `src/agent/decide.ts` | Rung 2 for one message: classify → safety floor → role guard → next case version. |
| `src/agent/classify.ts`, `src/agent/llm-call.ts` | The classify call, and the shared LLM call (zod check of the output, one retry, `llm.call` traces). |
| `src/agent/floor.ts` | The safety floor: hazard rules in code set a minimum urgency. |
| `src/agent/state.ts` | `status`, `waiting_on` and `outcome` from `next_step`. |
| `src/agent/actions.ts` | Rung 3: which `POST` and `PATCH /cases` calls a new case version needs. |
| `src/agent/speak.ts` | Rung 5: who gets a message and why, the loop guard, the safety line and the template. |
| `src/agent/reply.ts` | Rung 5: the writer (the second LLM call). |
| `src/agent/sender.ts` | Sends the outbox after each batch. 429 pauses and 403 stops. Messages never wait for case actions. |
| `src/agent/message.ts` | The payload adapter: the only code that knows the field names of an event. |
| `src/case.ts` | Our case model. A case changes as versions (`cases` and `case_versions`). |
| `prompts/` | One file for each prompt version. Current: `classify.v2.md`, `reply.v2.md`. |
| `src/tools/` | `npm run` tools: `eval`, `try:classify`, `prompts`, `story`, `e2e`, `llm:smoke`. |
| `src/eval/`, `evals/` | The eval sets, the scoring and the committed reports. |
| `src/e2e/`, `e2e/runs/` | The checks for `npm run e2e`, and its reports. |
| `src/story.ts` | Turns a trace into one story per case. |
| `experiments/` | The success criteria and the experiment write-ups. |
| `src/trace.ts`, `src/trace-langfuse.ts` | JSONL traces, and a copy of each trace line to Langfuse. The JSONL file is the record. |
| `src/store/` | The `Store` interface, the SQLite adapter and a portable `schema.sql`. |
| `src/api/client.ts` | The Dwelly API client: events, cases and messages. |
| `src/llm.ts` | The OpenRouter client. |
| `src/errors.ts` | `describeError`: one trace line with the full chain of causes. |
| `src/api/schema.d.ts` | Generated from `spec/openapi.json` (`npm run gen:types`). Do not edit it. |
| `spec/openapi.json` | The API spec, copied on 11 Nov 2026 (`npm run fetch:spec` gets it again). |
| `data/history.json` | The archive of 15 closed cases: the answer key for the evals. |
| `test/` | The unit tests (vitest). |
| `AGENTS.md` | The brief for a coding agent. `CLAUDE.md` points to it. |
| `DECISIONS.md` | Each decision and the reason for it. |
