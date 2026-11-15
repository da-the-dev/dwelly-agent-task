# AGENTS.md: brief for the coding agent

This file is the brief for any coding agent that works in this repo (Claude Code reads it through `CLAUDE.md`). Keep it short and keep it true. Update it when a rung changes the rules.

## The task
Dwelly manages rented homes. Build a service that does the property manager's work on a repair:
1. Read the incoming messages (`GET /events`).
2. Understand the problem and its urgency.
3. Create a maintenance case (`POST /cases`, `PATCH /cases/{id}`).
4. Pick a contractor and agree the work (`POST/PATCH /work-orders`).
5. Keep the tenant and the landlord informed (`POST /actors/{id}/messages`).

It is a ladder. A working lower rung with tests and traces is worth more than a higher rung held together with tape.

**Current rung: 3 (create the case in Dwelly), built and merged 15 Nov.** Every `message.received` becomes a version of our own case (`src/agent/handle.ts`) plus the `POST`/`PATCH /cases` calls it needs, queued in an outbox and sent after each batch (`src/agent/sender.ts`). What rung 5 would say is traced as `intent.message_tenant`. Next: rung 4 (contractor and work order).

## Sources of truth
- `spec/openapi.json`: the API. The world validates requests with it. Do not guess fields; read the spec.
- `src/api/schema.d.ts`: generated from the spec. Never edit it by hand. Run `npm run gen:types`.
- `data/history.json`: 15 closed cases. It is the answer key for urgency, trade and handover. Read it before you change the classification.
- `DECISIONS.md`: one line for each choice and the reason for it.

## API facts that are easy to miss
- Event cursors only increase, with **gaps**. Always send back `next_cursor`. Never use `cursor + 1`.
- There is **no GET for cases or work orders**. We keep the ids we created in our own state.
- `POST /cases` is **not idempotent**. A retry after a timeout can make a second case. Record the intent before the call.
- Opening a case already tells the landlord. Do not send them a message only to announce it.
- A work order is how the contractor gets the job. Its answer arrives later as `work_order.accepted` / `work_order.declined` events. A decline is normal: choose another contractor.
- Write the agreed slot with `PATCH /work-orders/{id}`. A contractor confirms only once a slot is on their accepted order.
- `PATCH /work-orders` with `landlord_approved` is our **record** of an approval. It does not ask the landlord.
- `429` = too many world-changing calls in one minute (reads are not limited). `403` = the session ended (reads still work).
- Every message gets a reply in the event feed.
- The spec's `servers` entry says `http://`. Use `https://`.

## Architecture (keep it this way unless DECISIONS.md says otherwise)
- `src/agent/loop.ts`: transactional inbox. Fetch, then store the batch and the cursor in one transaction, then handle pending events. Delivery is at-least-once, so **every handler that changes the world must be idempotent**.
- `src/store/`: state goes only through the async `Store` interface. SQL must run on SQLite and Postgres both.
- `src/trace.ts`: every decision is one `tracer.trace(kind, {...})` line with the `event_id` it belongs to.
- `src/agent/handle.ts`: the handler the loop calls per event. A message → find its case (payload case ref, else the open case at the property, else new) → `decide` → save the version and its outbox actions → trace `case.version`, `action.queued` and `intent.message_tenant`. An event that already produced a version is skipped before the LLM call (at-least-once delivery).
- `src/agent/actions.ts` + `actions` table: rung 3's outbox. `actionsFor(prev, next)` (pure) decides the calls; the handler saves them in the same transaction as the version. Never call a world-changing endpoint from the handler.
- `src/agent/sender.ts`: drains the outbox after each batch. Marks `sending` before the call. A POST that may have happened (timeout, network, 5xx) is `unknown` and is never sent again; a PATCH is retried. 429 pauses, 403 stops sending.
- `src/agent/decide.ts`: rung 2's decision for one message: classify (one LLM call) → safety floor → state. It takes the case's latest version and returns the next one; the caller saves it.
- `src/case.ts` + `cases` / `case_versions`: a case evolves as versions. The classifier sees only the latest version and the new message (Markov), so the `summary` must carry what matters. Never add a column to `cases` without adding it to `case_versions`.
- `src/agent/floor.ts`: the safety floor is code, not prompt. The model may raise urgency above it, never lower it. A new hazard rule needs an archive or trap test in `test/floor.test.ts`.
- `src/agent/message.ts`: the only code that knows the payload's field names.
- `prompts/`: one file per prompt version; the agent reads only these. Prompts are edited in Langfuse: `npm run prompts -- pull classify` writes `prompts/classify.vN.md` (Langfuse version N = file vN), then switch `CLASSIFY_PROMPT`, run `npm run eval`, commit. A file written by hand goes up with `npm run prompts -- push classify.vN`. Keep old versions so runs can be compared.
- `src/trace-langfuse.ts`: a second trace sink that sends every trace line to Langfuse (one trace per event, session = case). A viewer only: the JSONL file is the record, and a Langfuse failure must never stop the agent. Off without `LANGFUSE_*` keys or with `LANGFUSE_TRACES=off`.

## Running
- Evals (cost money, ~$0.012 a full run): `npm run eval`. Options: `--runs 1 --only case-05,calm-gas`, `--prompt classify.v1`, `LLM_MODEL=... LLM_PROVIDERS=any`. Read the table, then commit the report in `evals/runs/`. Change the prompt or the model only with an eval run before and after. A bug found live becomes an item in `evals/cases.json`.
- Classifier on real archive cases, to read the full output by eye: `npm run try:classify -- case-05 case-04@6` (`@6` replays the thread up to `messages[6]`).
- Prompts: `npm run prompts -- status` (files vs Langfuse), `pull classify [--version N]`, `push classify.vN [--label production]`.
- Traces in Langfuse (https://cloud.langfuse.com): filter by environment `agent-fake`, `agent-live`, `eval` or `try`; a session is one case.
- Unit tests: `npm test`. End to end: start `../dwelly-fake-world` (`npm run dev` there), then `npm run build && npm run start:fake` here. Inspect `traces/*.jsonl` and `state/fake.db`. The 15 archive openers in ~15 s: `SCENARIO=archive SPEED=20 node dist/main.js` in the fake world; its `GET /_admin/state` lists the cases it received.

## Stack rules
- Node.js + TypeScript only. `tsc` builds to `dist/`. Tests run with vitest.
- Use the spec types from `src/api/types.ts`. Do not write your own copies of API shapes.
- LLM calls go through `src/llm.ts` (OpenRouter, plain `fetch`). The model comes from config (`LLM_MODEL`); never hard-code one elsewhere. The provider is pinned (`LLM_PROVIDERS`, default `deepinfra/fp8`) so runs are comparable. Unit tests use a fake `fetch`; only `npm run llm:smoke` and evals call the real API, because they cost money.
- No `any`. At a trust boundary (an API response, an LLM output) use `unknown` and validate it.

## Working rules
- Each rung gets a test. A bug found in a live run becomes a test or an eval case before it is fixed.
- Each decision the agent makes writes **one JSON trace line**: the input, what was decided and why, the API call and its result. We must be able to explain any action from the traces alone.
- Before you say "done": `npm run typecheck && npm test`. Paste the result.
- Small commits, one rung or one fix each. Do not commit `.env`, `state/` or `traces/`.
- Do not delete or "clean up" harness files: `AGENTS.md`, `CLAUDE.md`, `DECISIONS.md`, `.claude/`. They are part of the result.
- If something in the spec or the world is unclear, say so and ask. Do not invent behaviour.
