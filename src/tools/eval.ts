// npm run eval: run the real classifier (+ safety floor + state, i.e. `decide`, the agent's own
// path) on the eval set, several runs per item, and score the last step of each item.
// Costs real money (~$0.0003 per call with the default model; ~75 calls for 3 runs).
//
//   npm run eval                                  every item, 3 runs
//   npm run eval -- --runs 1 --only case-05,calm-gas
//   npm run eval -- --prompt classify.v1          an older prompt, to compare
//   LLM_MODEL=... LLM_PROVIDERS=any npm run eval  another model
//   npm run eval -- --reply                       also write the rung 5 messages for the last
//                                                 step and score them (claims, safety line)
//   npm run eval -- --set scenarios               another set: evals/scenarios.json (15 Nov)
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
import { REPLY_PROMPT, writeReply } from "../agent/reply.js";
import { safetyLine, speakFor } from "../agent/speak.js";
import { replyClaims, report, type ReplyResult, type RunResult } from "../eval/score.js";
import { EVAL_SETS, itemMessages, loadArchive, loadEvalSet, type EvalItem, type EvalSetName } from "../eval/set.js";
import { createTracer, fileSink } from "../trace.js";
import { startLangfuseTracing } from "../trace-langfuse.js";

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
const withReply = argv.includes("--reply");
const replyPrompt = loadPrompt(flag("reply-prompt") ?? REPLY_PROMPT);

const setName = (flag("set") ?? "cases") as EvalSetName;
if (!EVAL_SETS.includes(setName)) throw new Error(`--set must be one of ${EVAL_SETS.join(", ")}`);

const archive = loadArchive();
const items = loadEvalSet(setName).filter((i) => !only || only.includes(i.id));
if (items.length === 0) throw new Error(`no eval items match --only ${only?.join(",")}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runId = `eval-${stamp}`;
const tracePath = `traces/${runId}.jsonl`;
interface CallLine { kind: string; cost_usd?: number | null; latency_ms?: number; provider?: string; model?: string }
const calls: CallLine[] = [];
const langfuse = config.langfuse?.traces ? startLangfuseTracing(config.langfuse, { sessions: "run", environment: "eval" }) : null;
const tracer = createTracer(runId, fileSink(tracePath), ...(langfuse ? [langfuse.sink] : []), (line) => {
  const l = JSON.parse(line) as CallLine;
  if (l.kind === "llm.call") calls.push(l);
});
const llm = { apiKey: config.llm.apiKey, model: config.llm.model, providers: config.llm.providers };
const deps = { llm, prompt, tracer };
const writer = { llm, prompt: replyPrompt, tracer, emergencyNumber: config.emergencyNumber };

console.log(
  `eval: ${setName}, ${items.length} items x ${runs} runs | model ${config.llm.model} via ${config.llm.providers.join(",") || "any provider"} | prompt ${prompt.version}${withReply ? ` + ${replyPrompt.version}` : ""}\n`,
);

async function runOne(item: EvalItem, run: number): Promise<RunResult> {
  let current: CaseRecord | null = null;
  let floorOverrode = false;
  let invalid = false;
  let prev: CaseRecord | null = null;
  let last: Awaited<ReturnType<typeof decide>> | null = null;
  let lastMessage: ReturnType<typeof itemMessages>[number] | null = null;
  for (const m of itemMessages(item, archive, run)) {
    prev = current;
    last = await decide(deps, current, m, m.occurredAt, () => `eval_${item.id}_r${run}`);
    lastMessage = m;
    current = last.next;
    floorOverrode ||= last.overrides.length > 0;
    invalid ||= last.classification === null;
  }
  if (!last || !lastMessage) throw new Error(`eval ${item.id}: no messages`);
  // who gets a message at the last step: pure, so every run scores it; --reply also writes them
  const reporterName = itemMessages(item, archive, run)[0]?.actor.name ?? null;
  const recipients = speakFor(prev, last.next, lastMessage, reporterName);
  const replies: ReplyResult[] = [];
  if (withReply) {
    for (const recipient of recipients) {
      const w = await writeReply(writer, { recipient, case: last.next, safetyAdvice: last.safetyAdvice, incoming: lastMessage });
      const line = recipient.role === "tenant" ? safetyLine(last.next, config.emergencyNumber) : null;
      replies.push({
        to: recipient.to,
        role: recipient.role,
        reasons: recipient.reasons,
        source: w.source,
        claim: replyClaims(w.body),
        safetyExpected: line !== null,
        safetyPresent: line !== null && w.body.startsWith(line),
        words: w.body.split(/\s+/).length,
        body: w.body,
      });
    }
  }
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
    status: last.next.status,
    speak: recipients.map((x) => x.role).sort(),
    ...(withReply ? { replies } : {}),
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

const scoredExtra = r.items.some((x) => x.statusOk !== null || x.speakOk !== null);
const extra = (ok: number | null, runs: number, seen: Record<string, number>, w: number) =>
  (ok === null ? "-" : `${ok}/${runs} ${fmt(seen)}`).padEnd(w);
console.log(
  `${"item".padEnd(20)} ${"crit".padEnd(4)}  ${"urgency".padEnd(26)}  ${"next_step".padEnd(34)}  ` +
    `${scoredExtra ? `${"status".padEnd(22)}  ${"speak".padEnd(22)}  ` : ""}flags`,
);
for (const row of r.items) {
  const flags = [
    row.underRated ? `UNDER-RATED x${row.underRated}` : "",
    row.modelUnderRated && !row.underRated ? `floor saved x${row.modelUnderRated}` : "",
  ].filter(Boolean).join(", ");
  console.log(
    `${row.id.padEnd(20)} ${(row.critical ? "yes" : "").padEnd(4)}  ` +
      `${`${row.urgencyOk}/${row.runs} ${fmt(row.urgencies)}`.padEnd(26)}  ` +
      `${`${row.nextStepOk}/${row.runs} ${fmt(row.nextSteps)}`.padEnd(34)}  ` +
      `${scoredExtra ? `${extra(row.statusOk, row.runs, row.statuses, 22)}  ${extra(row.speakOk, row.runs, row.speaks, 22)}  ` : ""}${flags}`,
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
${t.statusRuns ? `status      ${t.statusOk}/${t.statusRuns} (${pct(t.statusOk, t.statusRuns)})\n` : ""}${t.speakRuns ? `speak       ${t.speakOk}/${t.speakRuns} (${pct(t.speakOk, t.speakRuns)}) the right people get a message, and nobody else\n` : ""}errors      ${errors.length}${errors.length ? `: ${errors.map((e) => `${e.item}#${e.run} ${e.error}`).join("; ")}` : ""}
calls       ${calls.length} via ${providers || "-"}, $${cost.toFixed(4)}, p50 ${p50} ms
traces      ${tracePath}`);
const replies = results.flatMap((x) => x.replies ?? []);
if (withReply) {
  const words = replies.map((x) => x.words).sort((a, b) => a - b);
  const expected = replies.filter((x) => x.safetyExpected);
  console.log(`replies     ${replies.length} written, ${replies.filter((x) => x.source === "template").length} fell back to the template
  claims    ${replies.filter((x) => x.claim).length} claim an action that did not happen
  safety    ${expected.filter((x) => x.safetyPresent).length}/${expected.length} emergency messages start with the safety line
  length    p50 ${words[Math.floor(words.length / 2)] ?? 0} words, max ${words.at(-1) ?? 0}`);
  for (const x of replies.filter((y) => y.claim)) console.log(`  CLAIM ${x.to}: ${x.body.replace(/\s+/g, " ").slice(0, 200)}`);
}

const slug = (s: string) => s.replace(/[^a-z0-9.-]+/gi, "_");
const reportPath = `evals/runs/${stamp}__${slug(config.llm.model)}__${prompt.name}${withReply ? `+${replyPrompt.name}` : ""}${setName === "cases" ? "" : `__${setName}`}.json`;
mkdirSync("evals/runs", { recursive: true });
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      model: config.llm.model,
      providers: config.llm.providers,
      served_by: providers,
      set: setName,
      prompt: prompt.version,
      ...(withReply ? { reply_prompt: replyPrompt.version } : {}),
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
await langfuse?.shutdown();
if (langfuse) console.log(`langfuse    session ${runId} (environment eval)`);
const replyFail = replies.some((x) => x.safetyExpected && !x.safetyPresent);
process.exitCode = errors.length ? 2 : t.underRated || replyFail ? 1 : 0;
