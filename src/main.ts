// The agent service. Rung 1: poll the world's events into the inbox and trace each one.
import { createApi } from "./api/client.js";
import { runLoop } from "./agent/loop.js";
import { loadConfig, maskToken } from "./config.js";
import { openSqliteStore } from "./store/sqlite.js";
import { createTracer, fileSink } from "./trace.js";

const config = loadConfig();
if (!config.token) {
  console.error("DWELLY_TOKEN is not set. For the fake world: npm run start:fake");
  process.exit(1);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const tracePath = `traces/${runId}.jsonl`;
const tracer = createTracer(runId, fileSink(tracePath), (line) => console.log(line));
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
});

await runLoop({
  api,
  store,
  tracer,
  intervalMs: config.pollIntervalMs,
  signal: stop.signal,
  // Rung 1 only reads: record what came in. Understanding it is rung 2.
  handle: async (event) => tracer.trace("event.received", { event_id: event.id, event }),
});
await store.close();
