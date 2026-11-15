// Found while adding rung 3: a trace field named `kind` replaced the line's kind.
import { describe, expect, it } from "vitest";
import { createTracer } from "../src/trace.js";

describe("tracer", () => {
  it("a data field cannot hide the line's own ts, run or kind", () => {
    const lines: Record<string, unknown>[] = [];
    createTracer("r1", (l) => lines.push(JSON.parse(l))).trace("action.queued", { kind: "case_open", run: "x", n: 1 });
    expect(lines[0]).toMatchObject({ run: "r1", kind: "action.queued", n: 1 });
    expect(Object.keys(lines[0] ?? {}).slice(0, 3)).toEqual(["ts", "run", "kind"]);
  });
});
