// Found in a live run: poll.error said only "fetch failed", which hid that the world was down.
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/client.js";
import { runLoop } from "../src/agent/loop.js";
import { describeError } from "../src/errors.js";
import { openSqliteStore } from "../src/store/sqlite.js";
import { createTracer } from "../src/trace.js";

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  await new Promise((r) => srv.close(r));
  return port;
}

describe("describeError", () => {
  it("keeps the cause that Node's fetch hides behind 'fetch failed'", async () => {
    const api = createApi({ baseUrl: `http://127.0.0.1:${await closedPort()}`, token: "t" });
    const err = await api.getEvents(0, 1).catch((e: unknown) => e);
    expect(describeError(err)).toMatch(/^fetch failed \| cause: .*ECONNREFUSED/);
  });

  it("unpacks an AggregateError (localhost resolves to ::1 and 127.0.0.1)", () => {
    const refused = (addr: string) => Object.assign(new Error(`connect ECONNREFUSED ${addr}`), { code: "ECONNREFUSED" });
    const agg = Object.assign(new AggregateError([refused("::1:8787"), refused("127.0.0.1:8787")], ""), { code: "ECONNREFUSED" });
    expect(describeError(new TypeError("fetch failed", { cause: agg }))).toBe(
      "fetch failed | cause: AggregateError: [ECONNREFUSED] (connect ECONNREFUSED ::1:8787; connect ECONNREFUSED 127.0.0.1:8787)",
    );
  });

  it("names timeouts and handles non-errors", () => {
    expect(describeError(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(
      "TimeoutError: The operation was aborted due to timeout",
    );
    expect(describeError("boom")).toBe("boom");
  });

  it("poll.error traces carry the cause when the world is down", async () => {
    const lines: Record<string, unknown>[] = [];
    const stop = new AbortController();
    const tracer = createTracer("test", (line) => {
      const rec = JSON.parse(line) as Record<string, unknown>;
      lines.push(rec);
      if (rec["kind"] === "poll.error") stop.abort();
    });
    const store = openSqliteStore(":memory:");
    const api = createApi({ baseUrl: `http://127.0.0.1:${await closedPort()}`, token: "t" });
    await runLoop({ api, store, tracer, handle: async () => {}, intervalMs: 10, signal: stop.signal });
    await store.close();
    expect(lines.find((l) => l["kind"] === "poll.error")?.["error"]).toMatch(/ECONNREFUSED/);
  });
});
