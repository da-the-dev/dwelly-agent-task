// npm run eval: run the real classifier (+ safety floor + state, i.e. `decide`, the agent's own
// path) on the eval set, several runs per item, and score the last step of each item.
// Costs real money (~$0.0003 per call with the default model; ~75 calls for 3 runs).
//
//   npm run eval                                  every item, 3 runs
//   npm run eval -- --runs 1 --only case-05,calm-gas
//   npm run eval -- --prompt classify.v1          an older prompt, to compare
//   LLM_MODEL=... LLM_PROVIDERS=any npm run eval  another model
//
// Writes the llm.call traces to traces/eval-<time>.jsonl and a report to
// evals/runs/<time>__<model>__<prompt>.json (committed: the evidence for model and prompt
// choices). Exit code 1 if any critical item was under-rated (a hard fail), 2 on errors.
import { mkdirSync, writeFileSync } from "node:fs";
import { CLASSIFY_PROMPT, loadPrompt } from "../agent/classify.js";
import { decide } from "../agent/decide.js";
import type { CaseRecord } from "../case.js";
import { loadConfig } from "../config.js";
import { describeError } from "../errors.js";
import { report, type RunResult } from "../eval/score.js";
import { itemMessages, loadArchive, loadEvalSet, type EvalItem } from "../eval/set.js";
import { createTracer, fileSink } from "../trace.js";

const config = loadConfig();
if (!config.llm.apiKey) throw new Error("OPENROUTER_API_KEY is not set in .env");

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const runs = Number(flag("runs") ?? 3);
// One call at a time by default: with 4 in parallel the pinned provider queued them (p50
// 1.1 s -> 16 s on 15 Nov), so the run took longer in total and the latency figure was wrong.
const concurrency = Number(flag("concurrency") ?? 1);
const only = flag("only")?.split(",");
const prompt = loadPrompt(flag("prompt") ?? CLASSIFY_PROMPT);

const archive = loadArchive();
const items = loadEvalSet().filter((i) => !only || only.includes(i.id));
if (items.length === 0) throw new Error(`no eval items match --only ${only?.join(",")}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runId = `eval-${stamp}`;
const tracePath = `traces/${runId}.jsonl`;
interface CallLine { kind: string; cost_usd?: number | null; latency_ms?: number; provider?: string; model?: string }
const calls: CallLine[] = [];
const tracer = createTracer(runId, fileSink(tracePath), (line) => {
  const l = JSON.parse(line) as CallLine;
  if (l.kind === "llm.call") calls.push(l);
});
const deps = { llm: { apiKey: config.llm.apiKey, model: config.llm.model, providers: config.llm.providers }, prompt, tracer };

console.log(
  `eval: ${items.length} items x ${runs} runs | model ${config.llm.model} via ${config.llm.providers.join(",") || "any provider"} | prompt ${prompt.version}\n`,
);

async function runOne(item: EvalItem, run: number): Promise<RunResult> {
  let current: CaseRecord | null = null;
  let floorOverrode = false;
  let invalid = false;
  let last: Awaited<ReturnType<typeof decide>> | null = null;
  for (const m of itemMessages(item, archive, run)) {
    last = await decide(deps, current, m, m.occurredAt, () => `eval_${item.id}_r${run}`);
    current = last.next;
    floorOverrode ||= last.overrides.length > 0;
    invalid ||= last.classification === null;
  }
  if (!last) throw new Error(`eval ${item.id}: no messages`);
  return {
    item: item.id,
    run,
    urgency: last.next.urgency,
    nextStep: last.next.nextStep,
    modelUrgency: last.classification?.urgency ?? null,
    modelNextStep: last.classification?.next_step ?? null,
    floorOverrode,
    invalid,
    summary: last.next.summary,
    why: last.why,
  };
}

// A pool: items x runs, `concurrency` at a time (--concurrency N).
const tasks = items.flatMap((item) => Array.from({ length: runs }, (_, run) => ({ item, run })));
const results: RunResult[] = [];
const errors: { item: string; run: number; error: string }[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      if (!t) break;
      try {
        results.push(await runOne(t.item, t.run));
      } catch (err) {
        errors.push({ item: t.item.id, run: t.run, error: describeError(err) });
      }
      process.stdout.write(".");
    }
  }),
);
process.stdout.write("\n\n");

const r = report(items, results);
const fmt = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k}${v > 1 ? `x${v}` : ""}`).join(" ");
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");

console.log(`${"item".padEnd(18)} ${"crit".padEnd(4)}  ${"urgency".padEnd(26)}  ${"next_step".padEnd(34)}  flags`);
for (const row of r.items) {
  const flags = [
    row.underRated ? `UNDER-RATED x${row.underRated}` : "",
    row.modelUnderRated && !row.underRated ? `floor saved x${row.modelUnderRated}` : "",
  ].filter(Boolean).join(", ");
  console.log(
    `${row.id.padEnd(18)} ${(row.critical ? "yes" : "").padEnd(4)}  ` +
      `${`${row.urgencyOk}/${row.runs} ${fmt(row.urgencies)}`.padEnd(26)}  ` +
      `${`${row.nextStepOk}/${row.runs} ${fmt(row.nextSteps)}`.padEnd(34)}  ${flags}`,
  );
}

const t = r.totals;
const cost = calls.reduce((s, c) => s + (c.cost_usd ?? 0), 0);
const lat = calls.map((c) => c.latency_ms ?? 0).sort((a, b) => a - b);
const p50 = lat[Math.floor(lat.length / 2)] ?? 0;
const providers = [...new Set(calls.map((c) => c.provider))].join(", ");
console.log(`
urgency     ${t.urgencyOk}/${t.runs} (${pct(t.urgencyOk, t.runs)})
next_step   ${t.nextStepOk}/${t.runs} (${pct(t.nextStepOk, t.runs)})
both        ${t.bothOk}/${t.runs} (${pct(t.bothOk, t.runs)})
HARD FAILS  ${t.underRated} (critical item under-rated after the floor)
floor       raised the model on ${t.floorOverrode} runs; the model alone under-rated a critical item ${t.modelUnderRated} times
invalid     ${t.invalid} runs fell back to needs_review
summary     ${t.summaryClaims} runs claim an action that did not happen
errors      ${errors.length}${errors.length ? `: ${errors.map((e) => `${e.item}#${e.run} ${e.error}`).join("; ")}` : ""}
calls       ${calls.length} via ${providers || "-"}, $${cost.toFixed(4)}, p50 ${p50} ms
traces      ${tracePath}`);

const slug = (s: string) => s.replace(/[^a-z0-9.-]+/gi, "_");
const reportPath = `evals/runs/${stamp}__${slug(config.llm.model)}__${prompt.name}.json`;
mkdirSync("evals/runs", { recursive: true });
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      model: config.llm.model,
      providers: config.llm.providers,
      served_by: providers,
      prompt: prompt.version,
      runs,
      cost_usd: Number(cost.toFixed(5)),
      p50_latency_ms: p50,
      totals: t,
      errors,
      items: r.items,
      results: results.sort((a, b) => a.item.localeCompare(b.item) || a.run - b.run),
    },
    null,
    2,
  ) + "\n",
);
console.log(`report      ${reportPath}`);
process.exitCode = errors.length ? 2 : t.underRated ? 1 : 0;
