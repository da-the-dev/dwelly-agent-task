# dwelly-agent

An agent service for home repairs at Dwelly: it reads tenant messages, judges urgency, opens maintenance cases, books contractors and keeps people informed. Built for the Dwelly AI build session.

Status: **v0.1 scaffold.** No agent logic yet.

## Run
```sh
npm install
cp .env.example .env      # put the session token in DWELLY_TOKEN
npm run dev               # build + start
npm test                  # vitest
npm run typecheck         # src and tests
```

## Layout
| Path | What |
|---|---|
| `src/` | The service. `main.ts` is the entry. |
| `src/api/schema.d.ts` | Generated from `spec/openapi.json` (`npm run gen:types`). Do not edit. |
| `spec/openapi.json` | Spec snapshot, 11 Nov 2026 (`npm run fetch:spec` to refresh). |
| `data/history.json` | The 15-case archive, the answer key for the evals. |
| `test/` | vitest tests. |
| `AGENTS.md` | The brief for the coding agent. `CLAUDE.md` points to it. |
| `DECISIONS.md` | Each choice and why. |
