# Experiments

This folder holds one write-up for each eval run or fake-world run that we use for a decision. Each write-up judges its results against the criteria in `CRITERIA.md`.

- `CRITERIA.md`: what counts as a success and what counts as a failure. It has hard failures (H), targets (T), information only (I), validity rules and the verdicts. It has a version number, and each write-up names the version that it uses.
- `TEMPLATE.md`: the form for a new write-up. Copy it, and keep its sections and its results table in the same order.
- `NNN-<slug>.md`: one write-up for each experiment, numbered in the order of the runs.

The raw evidence stays where it is: eval reports in `evals/runs/` (committed), traces in `traces/` (not committed). A write-up links to its report and copies the trace lines that it relies on.

## How to add an experiment
1. Run it, for example `npm run eval -- --set scenarios --reply`. Commit the report.
2. Copy `TEMPLATE.md` to the next number, for example `004-speak-emergency.md`.
3. Fill in the header, the question and the setup. Then fill in every row of the results table from the eval output. Read the replies for H3, T5 and T6, because those checks are not fully automated yet.
4. Give the verdict from the rules in `CRITERIA.md`. Then write the findings and the next steps.
5. Add a row to the index below.

A fix gets its own experiment: a run before the fix (usually the last write-up), then a run after it.

## Index
| # | Date | Experiment | Set | Criteria | Verdict | Decided by |
|---|---|---|---|---|---|---|
| [001](001-cases-reply-v1.md) | 15 Nov 18:10 | Archive set with the first writer | `cases` (fit) | v1 | BELOW TARGET | T6 sign-offs 5/72 |
| [002](002-fake-world-rung5.md) | 15 Nov 21:57 | End-to-end run on the fake world, rung 5 | fake world `rung5` | v1 | BELOW TARGET | T4 who gets a message 8/9 |
| [003](003-scenarios-baseline.md) | 15 Nov 22:24 | Scenario set, held-out baseline | `scenarios` (held out) | v1 | BELOW TARGET | T4 21/24, T5 1 claim, T6 sign-offs 2/48 |
| [004](004-reply-v2-no-claims-in-progress.md) | 15 Nov 23:03 | `reply.v2`: no "we're checking" (kept) | `scenarios` + `cases` | v1 | BELOW TARGET | `scenarios`: T4 21/24 (T5 now 0); `cases`: T6 5/72 |

There are no hard failures in 001–004. The earlier classify-only runs (11–15 Nov, before rung 5) are in `evals/runs/` and in `DECISIONS.md`. They have no write-up, because criteria v1 checks the replies too.
