// The agent service. Rung 1: poll the world's events into the inbox. Rung 2: classify each
// message into a version of our own case. Rung 3: queue and send POST / PATCH /cases from
// an outbox after each batch. Rung 5: messages to the tenant (and a landlord who asks), written
// by a second LLM call and sent through the same outbox.
import { createApi } from "./api/client.js";
import { CLASSIFY_PROMPT, loadPrompt } from "./agent/classify.js";
import { createHandler } from "./agent/handle.js";
import { REPLY_PROMPT } from "./agent/reply.js";
import { runLoop } from "./agent/loop.js";
import { createSender } from "./agent/sender.js";
import { loadConfig, maskToken, type Config } from "./config.js";
import { openSqliteStore } from "./store/sqlite.js";
import { createTracer, fileSink } from "./trace.js";
import { startLangfuseTracing } from "./trace-langfuse.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
if (!config.token) {
  console.error("DWELLY_TOKEN is not set. For the fake world: npm run start:fake");
  process.exit(1);
}
if (!config.llm.apiKey) {
  console.error("OPENROUTER_API_KEY is not set in .env: rung 2 needs it to classify messages.");
  process.exit(1);
}
const llm = { apiKey: config.llm.apiKey, model: config.llm.model, providers: config.llm.providers };
const prompt = loadPrompt(CLASSIFY_PROMPT);
const replyPrompt = loadPrompt(REPLY_PROMPT);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const tracePath = `traces/${runId}.jsonl`;
// Langfuse is a viewer only: the JSONL file is the record, and a Langfuse failure never stops the agent.
const langfuse = config.langfuse?.traces
  ? startLangfuseTracing(config.langfuse, {
      sessions: "case",
      environment: /^http:\/\/(127\.0\.0\.1|localhost)/.test(config.baseUrl) ? "agent-fake" : "agent-live",
    })
  : null;
const tracer = createTracer(runId, fileSink(tracePath), (line) => console.log(line), ...(langfuse ? [langfuse.sink] : []));
const store = openSqliteStore(config.stateDb);
const api = createApi({ baseUrl: config.baseUrl, token: config.token });

const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());

tracer.trace("run.start", {
  base_url: config.baseUrl,
  token: maskToken(config.token),
  state_db: config.stateDb,
  trace_file: tracePath,
  cursor: await store.getCursor(),
  model: config.llm.model,
  providers: config.llm.providers,
  prompt: prompt.version,
  reply_prompt: replyPrompt.version,
  emergency_number: config.emergencyNumber,
  open_case_out_of_scope: config.openCaseOutOfScope,
  langfuse: langfuse ? config.langfuse?.baseUrl : "off",
});

await runLoop({
  api,
  store,
  tracer,
  intervalMs: config.pollIntervalMs,
  signal: stop.signal,
  afterBatch: createSender({ api, store, tracer }).drain,
  // The raw event is in the inbox; the decision is in the case.version trace line.
  handle: createHandler({
    store,
    tracer,
    classify: { llm, prompt, tracer },
    writer: { llm, prompt: replyPrompt, tracer, emergencyNumber: config.emergencyNumber },
    openCaseOutOfScope: config.openCaseOutOfScope,
  }),
});
await store.close();
await langfuse?.shutdown();
