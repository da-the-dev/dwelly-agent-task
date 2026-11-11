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

**Current rung: 0 (scaffold).** Next: rung 1.

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

## Stack rules
- Node.js + TypeScript only. `tsc` builds to `dist/`. Tests run with vitest.
- **No new dependency** without a line in `DECISIONS.md` that says why, and what the built-in option was. Prefer Node built-ins: `fetch`, `node:fs`, `--env-file`.
- Use the spec types from `src/api/types.ts`. Do not write your own copies of API shapes.
- LLM calls go through `src/llm.ts` (OpenRouter, plain `fetch`). The model comes from config (`LLM_MODEL`); never hard-code one elsewhere. Unit tests use a fake `fetch`; only `npm run llm:smoke` and evals call the real API, because they cost money.
- No `any`. At a trust boundary (an API response, an LLM output) use `unknown` and validate it.

## Working rules
- Each rung gets a test. A bug found in a live run becomes a test or an eval case before it is fixed.
- Each decision the agent makes writes **one JSON trace line**: the input, what was decided and why, the API call and its result. We must be able to explain any action from the traces alone.
- Before you say "done": `npm run typecheck && npm test`. Paste the result.
- Small commits, one rung or one fix each. Do not commit `.env`, `state/` or `traces/`.
- Do not delete or "clean up" harness files: `AGENTS.md`, `CLAUDE.md`, `DECISIONS.md`, `.claude/`. They are part of the result.
- If something in the spec or the world is unclear, say so and ask. Do not invent behaviour.
