// End to end: the real agent (dist/main.js, real LLM) against the local fake world, then
// checks on what happened. One command, one report.
//
//   npm run e2e                                  scenario rung5 (3 cases with threads, ~$0.01)
//   npm run e2e -- --scenario archive            all 15 archive openers (~$0.05)
//   npm run e2e -- --speed 20 --quiet 8 --timeout 600
//
// 1. start ../dwelly-fake-world (its dist/main.js) on E2E_PORT (8788), so a dev world on 8787 can stay
// 2. start the agent with a fresh database (state/e2e-<run>.db) and explicit world settings
// 3. the run is over when every event is handled, every call is sent, and the agent then
//    prints nothing for --quiet seconds (scaled by speed): src/e2e/done.ts
// 4. stop the agent (SIGTERM), read the world's /_admin/state, stop the world
// 5. print the story and the checks; write e2e/runs/<run>-<scenario>.md; exit 1 on a failed check
//
// Exit codes: 0 all fail-level checks pass, 1 a check failed, 2 the run itself could not happen.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import { checkRun, failed, renderChecks, WorldState } from "../e2e/checks.js";
import { notOverBecause } from "../e2e/done.js";
import { openSqliteStore } from "../store/sqlite.js";
import { buildStory, parseTrace, renderStory, type TraceLine } from "../story.js";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const scenario = opt("scenario", "rung5");
const speed = Number(opt("speed", "20"));
// The world's longest gap is an archive opener every 20 s of sim time: wait 160 s of sim time,
// and never less than 8 s of real time.
const quietMs = Number(opt("quiet", "0")) * 1000 || Math.max(8_000, 160_000 / speed);
const timeoutMs = Number(opt("timeout", "600")) * 1000;
const port = Number(process.env["E2E_PORT"] ?? 8788);
const token = "fake-token";
const world = `http://127.0.0.1:${port}`;
const runId = `e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const stateDb = `state/${runId}.db`;

class RunError extends Error {}
const children: ChildProcess[] = [];
const stopAll = () => children.forEach((c) => c.exitCode === null && c.kill("SIGTERM"));
process.once("SIGINT", () => (stopAll(), process.exit(130)));

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`e2e: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
} finally {
  stopAll();
}

async function main(): Promise<number> {
  const config = loadConfig();
  const worldDir = findFakeWorld();
  if (await answers(`${world}/_admin/state`)) throw new RunError(`port ${port} is in use already: stop that process or set E2E_PORT`);
  if (!existsSync("dist/main.js")) throw new RunError("dist/main.js is missing: run npm run build");

  console.log(`e2e ${runId}: scenario ${scenario}, speed ${speed}x, world ${worldDir}, quiet ${quietMs / 1000} s`);
  const fake = start("world", spawn(process.execPath, ["dist/main.js"], {
    cwd: worldDir,
    env: { ...process.env, PORT: String(port), FAKE_TOKEN: token, SCENARIO: scenario, SPEED: String(speed) },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  await waitFor(() => answers(`${world}/_admin/state`), 10_000, "the fake world did not start");

  const started = Date.now();
  // Explicit settings win over .env and over the shell (a DWELLY_BASE_URL set in the terminal
  // once pointed a "fake" run at the live server).
  const agent = start("agent", spawn(process.execPath, ["--env-file=.env", "dist/main.js"], {
    env: { ...process.env, DWELLY_BASE_URL: world, DWELLY_TOKEN: token, STATE_DB: stateDb, POLL_INTERVAL_MS: "300" },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  let tracePath: string | null = null;
  let lastOutput = Date.now();
  let stopped = false;
  createInterface({ input: agent.stdout! }).on("line", (raw) => {
    lastOutput = Date.now();
    const l = tryJson(raw);
    if (!l) return;
    if (l.kind === "run.start" && typeof l["trace_file"] === "string") tracePath = l["trace_file"];
    if (l.kind === "loop.stopped") stopped = true;
    progress(l);
  });

  const agentExit = new Promise<number | null>((res) => agent.once("exit", (code) => res(code)));
  // Over = quiet output AND no unfinished work in the agent's database (src/e2e/done.ts).
  // A second connection only reads; the agent writes in WAL mode, so reads never block it.
  await waitFor(async () => tracePath !== null, 30_000, "the agent printed no run.start line");
  const watch = openSqliteStore(stateDb);
  let lastWhy: string | null = null;
  const isOver = async () => {
    const why = notOverBecause({
      msSinceOutput: Date.now() - lastOutput, quietMs, inbox: await watch.inboxCounts(), actions: await watch.allActions(),
    });
    if (why && why !== lastWhy && !why.startsWith("the agent printed")) console.log(`  … waiting: ${why}`);
    lastWhy = why;
    return why === null;
  };
  const outcome = await Promise.race([
    waitFor(isOver, timeoutMs, "timeout").then(() => "over" as const),
    agentExit.then((code) => `exited ${code}` as const),
  ])
    .catch((err: unknown) => (err instanceof RunError ? "timeout" : Promise.reject(err)))
    .finally(() => watch.close());
  if (outcome !== "over") {
    throw new RunError(outcome === "timeout" ? `the run was not over after ${timeoutMs / 1000} s (${lastWhy})` : `the agent ${outcome} before the run was over`);
  }

  agent.kill("SIGTERM");
  const code = await Promise.race([agentExit, new Promise<"hung">((res) => setTimeout(() => res("hung"), 20_000))]);
  if (code === "hung") {
    agent.kill("SIGKILL");
    throw new RunError("the agent did not stop within 20 s of SIGTERM");
  }
  const seconds = Math.round((Date.now() - started) / 1000);

  const worldState = WorldState.parse(await (await fetch(`${world}/_admin/state`)).json());
  fake.kill("SIGTERM");
  if (!tracePath) throw new RunError("the agent printed no run.start line");

  const store = openSqliteStore(stateDb);
  const [cases, actions, inbox] = await Promise.all([store.allCases(), store.allActions(), store.inboxCounts()]);
  await store.close();

  const { lines, badLines } = parseTrace(readFileSync(tracePath, "utf8"));
  const story = buildStory(lines, badLines);
  const checks = checkRun({ world: worldState, cases, actions, inbox, story, emergencyNumber: config.emergencyNumber });
  const cost = lines.filter((l) => l.kind === "llm.call").reduce((s, l) => s + (typeof l["cost_usd"] === "number" ? l["cost_usd"] : 0), 0);
  const llmCalls = lines.filter((l) => l.kind === "llm.call").length;

  const storyText = renderStory(story);
  const checksText = renderChecks(checks);
  const bad = failed(checks);
  const verdict = bad.length ? `FAIL: ${bad.length} check${bad.length > 1 ? "s" : ""} failed` : "PASS";
  const facts = [
    `scenario ${scenario} · speed ${speed}x · ${seconds} s · ${llmCalls} LLM calls · $${cost.toFixed(4)}${stopped ? "" : " · no loop.stopped line"}`,
    `commit ${commit()} · trace ${tracePath} · state ${stateDb}`,
  ];

  console.log(`\n${storyText}\n\n═══ CHECKS\n${checksText}\n\n${verdict}\n${facts.join("\n")}`);

  const report = `e2e/runs/${runId.slice(4)}-${scenario}.md`;
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(
    report,
    [
      `# e2e ${scenario}: ${verdict}`,
      "",
      ...facts.map((f) => `- ${f}`),
      "",
      "Written by `npm run e2e`. The fake world does not read our messages (each answer is the actor's next archive line, then \"Thanks, will do.\"), so this tests the mechanics, not the quality of what we say.",
      "",
      "## Checks",
      "```",
      checksText,
      "```",
      "",
      "## Story",
      "```",
      storyText,
      "```",
      "",
    ].join("\n"),
  );
  console.log(`report ${report}`);
  return bad.length ? 1 : 0;
}

/** ../dwelly-fake-world next to this repo; from a worktree, next to the main checkout. */
function findFakeWorld(): string {
  const fromEnv = process.env["FAKE_WORLD_DIR"];
  const candidates = fromEnv ? [resolve(fromEnv)] : [];
  for (let dir = process.cwd(); dirname(dir) !== dir; dir = dirname(dir)) candidates.push(join(dirname(dir), "dwelly-fake-world"));
  const found = candidates.find((d) => existsSync(join(d, "package.json")));
  if (!found) throw new RunError("no dwelly-fake-world next to this repo: set FAKE_WORLD_DIR");
  if (!existsSync(join(found, "dist/main.js"))) throw new RunError(`${found}/dist/main.js is missing: run npm run build there`);
  return found;
}

function start(name: string, child: ChildProcess): ChildProcess {
  children.push(child);
  createInterface({ input: child.stderr! }).on("line", (l) => console.error(`[${name}] ${l}`));
  return child;
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(ok: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new RunError(what);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function tryJson(raw: string): TraceLine | null {
  return parseTrace(raw).lines[0] ?? null;
}

/** One short line per decision and per problem, so a long run shows it is alive. */
function progress(l: TraceLine) {
  const s = (k: string) => (typeof l[k] === "string" ? (l[k] as string) : "?");
  const id = s("case_id").replace(/^case_/, "").slice(0, 8);
  if (l.kind === "case.version") console.log(`  ${s("event_id")} ${s("from")} → case ${id} v${String(l["version"])} ${s("urgency")} · ${s("status")}`);
  else if (l.kind === "action.sent") console.log(`  ${s("event_id")}   ${s("action")} sent`);
  else if (/^action\.(failed|unknown|deferred)$|^event\.failed$|^poll\.error$|^send\.error$|^session\.ended$/.test(l.kind)) {
    console.log(`  ! ${l.kind} ${s("event_id")} ${s("error")}`);
  }
}

function commit(): string {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    return dirty ? `${head} + uncommitted changes` : head;
  } catch {
    return "?";
  }
}
