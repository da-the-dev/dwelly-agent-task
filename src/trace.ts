// One JSON line per thing the agent observes or decides. The traces are how we answer
// "why did it do that?" in the session, so every line carries the run id and the event id
// it belongs to. Written synchronously: a crash must not lose the line that explains it.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TraceSink = (line: string) => void;

export interface Tracer {
  readonly runId: string;
  trace(kind: string, data?: Record<string, unknown>): void;
}

export function fileSink(path: string): TraceSink {
  mkdirSync(dirname(path), { recursive: true });
  return (line) => appendFileSync(path, line + "\n");
}

export function createTracer(runId: string, ...sinks: TraceSink[]): Tracer {
  return {
    runId,
    trace(kind, data = {}) {
      const line = JSON.stringify({ ts: new Date().toISOString(), run: runId, kind, ...data });
      for (const sink of sinks) sink(line);
    },
  };
}
