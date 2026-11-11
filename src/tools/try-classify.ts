// Run the real classifier (+ safety floor + state) on archive cases, to inspect by eye.
// Costs real money (~$0.0005 per call with the default model).
//
//   npm run try:classify -- case-05 case-11          first tenant message of each case
//   npm run try:classify -- case-04@6                replay the thread up to messages[6]:
//                                                    every non-manager message, in order,
//                                                    each one seeing the state the last left
// Writes the llm.call traces to traces/try-<time>.jsonl and prints one block per step.
import { readFileSync } from "node:fs";
import type { HistoryCase, HistoryCasesResponse } from "../api/types.js";
import type { CaseRecord } from "../case.js";
import { loadConfig } from "../config.js";
import { CLASSIFY_PROMPT, loadPrompt } from "../agent/classify.js";
import { decide } from "../agent/decide.js";
import type { IncomingMessage } from "../agent/message.js";
import { createTracer, fileSink } from "../trace.js";

const config = loadConfig();
if (!config.llm.apiKey) throw new Error("OPENROUTER_API_KEY is not set in .env");

const archive = (JSON.parse(readFileSync("data/history.json", "utf8")) as HistoryCasesResponse).cases;
const runId = `try-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const tracePath = `traces/${runId}.jsonl`;
const tracer = createTracer(runId, fileSink(tracePath));
// --prompt classify.v1 runs an older prompt, to compare versions on the same cases.
const argv = process.argv.slice(2);
const promptAt = argv.indexOf("--prompt");
const prompt = loadPrompt(promptAt >= 0 ? argv.splice(promptAt, 2)[1] ?? CLASSIFY_PROMPT : CLASSIFY_PROMPT);
const deps = { llm: { apiKey: config.llm.apiKey, model: config.llm.model, providers: config.llm.providers }, prompt, tracer };

const args = argv;
const specs = args.length ? args : ["case-05", "case-11", "case-03", "case-14", "case-04@6"];

console.log(`model ${config.llm.model} via ${config.llm.providers.join(",") || "any provider"}, prompt ${prompt.version}, traces ${tracePath}\n`);

for (const spec of specs) {
  const [id, upTo] = spec.split("@");
  const c = archive.find((x) => x.id === id);
  if (!c) throw new Error(`no archive case ${id}`);
  const steps = upTo === undefined ? [c.messages.findIndex((m) => m.from === "tenant")] : threadUpTo(c, Number(upTo));

  console.log(`=== ${c.id} | archive: ${c.classification.urgency} | ${c.title}`);
  let current: CaseRecord | null = null;
  for (const i of steps) {
    const m = c.messages[i];
    if (!m) continue;
    const message: IncomingMessage = {
      eventId: `${c.id}#${i}`,
      text: m.body,
      subject: null,
      actor: { id: `${m.from}:${m.name}`, role: m.from, name: m.name },
      propertyId: c.property.id,
      caseRef: null,
      occurredAt: m.sent_at,
    };
    const r = await decide(deps, current, message, m.sent_at, () => `try_${c.id}`);
    current = r.next;
    const n = r.next;
    console.log(`--- v${n.version} messages[${i}] from ${m.from} (${m.name})`);
    console.log(`  text:      ${m.body.slice(0, 160)}${m.body.length > 160 ? "…" : ""}`);
    console.log(`  floor:     ${r.floor.urgency ?? "-"}${r.floor.rules.length ? ` (${r.floor.rules.join(", ")})` : ""}`);
    console.log(`  model:     ${r.classification ? `${r.classification.urgency} / ${r.classification.next_step}` : "INVALID -> fallback"}  (attempts ${r.attempts})`);
    console.log(`  final:     ${n.urgency} / ${n.nextStep}  status ${n.status}, waiting on ${n.waitingOn}${n.outcome ? `, outcome ${n.outcome}` : ""}${r.overrides.length ? `  overrides: ${r.overrides.join("; ")}` : ""}`);
    console.log(`  why:       ${r.why}`);
    console.log(`  safety:    ${r.safetyAdvice ?? "-"}`);
    console.log(`  questions: ${n.openQuestions.length ? n.openQuestions.join(" | ") : "-"}`);
    console.log(`  title:     ${n.title}`);
    console.log(`  summary:   ${n.summary}`);
  }
  console.log();
}

const calls = readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cost_usd?: number | null; latency_ms?: number; provider?: string });
const cost = calls.reduce((s, l) => s + (l.cost_usd ?? 0), 0);
const served = [...new Set(calls.map((l) => l.provider))].join(", ");
console.log(`${calls.length} LLM calls via ${served}, $${cost.toFixed(5)}, avg ${Math.round(calls.reduce((s, l) => s + (l.latency_ms ?? 0), 0) / calls.length)} ms`);

/** Indices of every message not written by the manager, up to and including `last`. */
function threadUpTo(c: HistoryCase, last: number): number[] {
  return c.messages.flatMap((m, i) => (i <= last && m.from !== "manager" ? [i] : []));
}
