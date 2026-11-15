// npm run prompts: Langfuse is where prompts are edited; prompts/ is what the agent runs.
// Langfuse version N of prompt <name> is always the same text as prompts/<name>.vN.md.
//
//   npm run prompts -- status                     local files vs Langfuse, and the labels
//   npm run prompts -- pull classify              Langfuse 'production' -> prompts/classify.vN.md
//   npm run prompts -- pull classify --version 3  a given version
//   npm run prompts -- push classify.v2 [--label production]
//                                                 a local file -> Langfuse version 2 (refuses
//                                                 if Langfuse would number it differently)
//
// After a pull: switch CLASSIFY_PROMPT (src/agent/classify.ts), run npm run eval, commit both.
// The agent never reads Langfuse at runtime: a prompt change is a commit, and the evals stay
// comparable.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";
import { configureGlobalLogger, LogLevel } from "@langfuse/core";
import { loadConfig } from "../config.js";

// The SDK logs every 404 with a full stack; here a missing version is a normal answer, and
// any other error is rethrown and printed by this tool.
configureGlobalLogger({ level: LogLevel.NONE });

const cfg = loadConfig({ DWELLY_BASE_URL: "https://unused", ...process.env }).langfuse;
if (!cfg) throw new Error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set in .env");
const lf = new LangfuseClient({ publicKey: cfg.publicKey, secretKey: cfg.secretKey, baseUrl: cfg.baseUrl });

const DIR = "prompts";
const [cmd, target, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

/** Local prompt files: { classify: { 1: text, 2: text } }. */
function localPrompts(): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  for (const f of readdirSync(DIR)) {
    const m = /^([\w-]+)\.v(\d+)\.md$/.exec(f);
    if (!m?.[1] || !m[2]) continue;
    const versions = out.get(m[1]) ?? new Map<number, string>();
    versions.set(Number(m[2]), readFileSync(`${DIR}/${f}`, "utf8"));
    out.set(m[1], versions);
  }
  return out;
}

/** A Langfuse prompt version, or null if it does not exist. No cache: we compare text. */
async function remote(name: string, select: { version?: number; label?: string }) {
  try {
    return await lf.prompt.get(name, { ...select, type: "text", cacheTtlSeconds: 0 });
  } catch (err) {
    if (/not ?found|404/i.test(String(err instanceof Error ? err.message : err))) return null;
    throw err;
  }
}

async function status() {
  for (const [name, versions] of localPrompts()) {
    const production = await remote(name, { label: "production" });
    const latest = await remote(name, { label: "latest" });
    console.log(`${name}: Langfuse latest v${latest?.version ?? "-"}, production v${production?.version ?? "-"}`);
    for (const [v, text] of [...versions].sort((a, b) => a[0] - b[0])) {
      const r = await remote(name, { version: v });
      const state = !r ? "not in Langfuse" : r.prompt === text ? `same text, labels [${r.labels.join(", ")}]` : "DIFFERENT TEXT";
      console.log(`  ${DIR}/${name}.v${v}.md  ${state}`);
    }
  }
}

async function push(file: string) {
  const m = /^([\w-]+)\.v(\d+)$/.exec(file);
  if (!m?.[1] || !m[2]) throw new Error(`push wants <name>.v<N>, e.g. classify.v2 (got ${file})`);
  const [name, version] = [m[1], Number(m[2])];
  const text = readFileSync(`${DIR}/${name}.v${version}.md`, "utf8");
  const label = flag("label");

  const existing = await remote(name, { version });
  if (existing) {
    if (existing.prompt !== text) throw new Error(`Langfuse ${name} v${version} has different text: refusing to push`);
    console.log(`${name} v${version}: already in Langfuse with the same text`);
  } else {
    const latest = (await remote(name, { label: "latest" }))?.version ?? 0;
    if (latest !== version - 1) {
      throw new Error(`Langfuse would make this ${name} v${latest + 1}, not v${version}: push the versions in order`);
    }
    const created = await lf.prompt.create({ name, prompt: text, labels: [], commitMessage: `from ${DIR}/${name}.v${version}.md` });
    if (created.version !== version) throw new Error(`Langfuse created v${created.version}, expected v${version}`);
    console.log(`${name} v${version}: pushed`);
  }
  if (label) {
    await lf.prompt.update({ name, version, newLabels: [label] });
    console.log(`${name} v${version}: label '${label}'`);
  }
}

async function pull(name: string) {
  const v = flag("version");
  const r = await remote(name, v ? { version: Number(v) } : { label: flag("label") ?? "production" });
  if (!r) throw new Error(`Langfuse has no ${name} ${v ? `v${v}` : `with label ${flag("label") ?? "production"}`}`);
  const path = `${DIR}/${name}.v${r.version}.md`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== r.prompt) throw new Error(`${path} exists with different text: refusing to overwrite`);
    console.log(`${path}: already up to date (v${r.version}, labels [${r.labels.join(", ")}])`);
    return;
  }
  writeFileSync(path, r.prompt);
  console.log(`wrote ${path} (v${r.version}, labels [${r.labels.join(", ")}])`);
  console.log(`next: set CLASSIFY_PROMPT = "${name}.v${r.version}" in src/agent/classify.ts, run npm run eval, commit both`);
}

if (cmd === "status") await status();
else if (cmd === "push" && target) await push(target);
else if (cmd === "pull" && target) await pull(target);
else {
  console.error("usage: npm run prompts -- status | pull <name> [--label L | --version N] | push <name>.v<N> [--label L]");
  process.exitCode = 1;
}
