# e2e runs

One file per `npm run e2e`: the verdict, the checks and the story of each case, with the commit, model, prompts and cost. Commit each report. A failed check found here becomes a test or an eval item before it is fixed (AGENTS.md).

The fake world answers each of our messages with the actor's next archive line, then "Thanks, will do.". It does not read what we wrote. So a report shows that the mechanics work (cases, calls, who hears from us, the safety line), not that the conversation is good. The evals (`evals/runs/`) measure that.
