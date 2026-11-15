// Print a run's trace as one story per case. Reads a file only: no LLM, no world, no cost.
//
//   npm run story                                   the newest agent run in traces/
//   npm run story -- traces/2026-11-15T17-57-58-513Z.jsonl
//   npm run story -- --case d9da8c3d --full         one case, texts not cut
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStory, parseTrace, renderStory } from "../story.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const caseFilter = value("--case");
const path = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--case") ?? newestRun("traces");

if (!path) {
  console.error("No agent trace in traces/. Run the agent first (npm run start:fake or npm run e2e).");
  process.exit(1);
}
const { lines, badLines } = parseTrace(readFileSync(path, "utf8"));
console.log(`trace ${path}`);
console.log(renderStory(buildStory(lines, badLines), { full: flag("--full"), ...(caseFilter ? { caseFilter } : {}) }));

/** The newest agent run: eval-, try- and other tool traces are not agent runs. */
function newestRun(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const runs = names.filter((n) => /^\d{4}-\d\d-\d\dT.*\.jsonl$/.test(n)).sort();
  const last = runs[runs.length - 1];
  return last ? join(dir, last) : undefined;
}
