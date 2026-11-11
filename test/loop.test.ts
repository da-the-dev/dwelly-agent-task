// Rung 1: no event is lost and none is handled twice, across restarts and crashes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Api } from "../src/api/client.js";
import type { WorldEvent } from "../src/api/types.js";
import { tick } from "../src/agent/loop.js";
import { openSqliteStore } from "../src/store/sqlite.js";
import { createTracer } from "../src/trace.js";

const ev = (cursor: number): WorldEvent => ({
  id: `evt_${cursor}`,
  cursor,
  type: "message.received",
  channel: "email",
  actor: { id: "tenant_04", role: "tenant", name: "Emma" },
  sim_ms: cursor * 1000,
  occurred_at: new Date(cursor * 1000).toISOString(),
  payload: { body: `message ${cursor}` },
});

/** A fake feed that behaves like the spec: strictly after `after`, gapped cursors, echo when empty. */
function feed(cursors: number[]) {
  const events = cursors.map(ev);
  const calls: number[] = [];
  const api: Api = {
    async getEvents(after, limit) {
      calls.push(after);
      const page = events.filter((e) => e.cursor > after).slice(0, limit);
      return { events: page, next_cursor: page.at(-1)?.cursor ?? after };
    },
  };
  return { api, events, calls };
}

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "dwelly-")), "agent.db");
const tracer = createTracer("test");

describe("rung 1: reading events", () => {
  it("handles every event once, in cursor order, with gaps in the cursors", async () => {
    const { api } = feed([3, 4, 9, 15]);
    const store = openSqliteStore(":memory:");
    const seen: string[] = [];
    const handle = async (e: WorldEvent) => void seen.push(e.id);
    await tick({ api, store, tracer, handle, batchSize: 2 });
    await tick({ api, store, tracer, handle, batchSize: 2 });
    await tick({ api, store, tracer, handle, batchSize: 2 });
    expect(seen).toEqual(["evt_3", "evt_4", "evt_9", "evt_15"]);
    expect(await store.getCursor()).toBe(15);
  });

  it("after a restart, resumes from the saved cursor: nothing again, nothing lost", async () => {
    const path = tmpDb();
    const { api, calls } = feed([2, 5, 7]);
    const seen: string[] = [];
    const handle = async (e: WorldEvent) => void seen.push(e.id);

    const first = openSqliteStore(path);
    await tick({ api, store: first, tracer, handle, batchSize: 2 });
    await first.close(); // process stops

    const second = openSqliteStore(path); // process starts again
    await tick({ api, store: second, tracer, handle, batchSize: 2 });
    await tick({ api, store: second, tracer, handle, batchSize: 2 });
    expect(seen).toEqual(["evt_2", "evt_5", "evt_7"]);
    expect(calls).toEqual([0, 5, 7]);
  });

  it("a crash during handling leaves the event pending; the next run handles it (at-least-once)", async () => {
    const path = tmpDb();
    const { api } = feed([1, 2]);
    const crashing = openSqliteStore(path);
    // Simulate the process dying inside the handler: the error escapes before mark().
    const dies = { ...crashing, mark: async () => { throw new Error("process died"); } };
    await expect(tick({ api, store: dies, tracer, handle: async () => {} })).rejects.toThrow("process died");
    await crashing.close();

    const restarted = openSqliteStore(path);
    const seen: string[] = [];
    await tick({ api, store: restarted, tracer, handle: async (e) => void seen.push(e.id) });
    expect(seen).toEqual(["evt_1", "evt_2"]); // re-handled from the inbox, not re-fetched
    expect(await restarted.getCursor()).toBe(2);
  });

  it("dedups an event the world sends twice", async () => {
    const store = openSqliteStore(":memory:");
    expect(await store.saveBatch([ev(1), ev(2)], 2)).toBe(2);
    expect(await store.saveBatch([ev(2)], 2)).toBe(0);
  });

  it("a failing handler marks the event failed and does not block the next one", async () => {
    const { api } = feed([1, 2]);
    const store = openSqliteStore(":memory:");
    const lines: string[] = [];
    const seen: string[] = [];
    await tick({
      api,
      store,
      tracer: createTracer("t", (l) => lines.push(l)),
      handle: async (e) => {
        if (e.id === "evt_1") throw new Error("bad payload");
        seen.push(e.id);
      },
    });
    expect(seen).toEqual(["evt_2"]);
    expect(await store.pending(10)).toEqual([]);
    expect(lines.map((l) => JSON.parse(l)).find((l) => l.kind === "event.failed")).toMatchObject({ event_id: "evt_1", error: "bad payload" });
  });

  it("does not move the cursor if storing the batch fails", async () => {
    const { api } = feed([1, 2]);
    const store = openSqliteStore(":memory:");
    const broken = { ...store, saveBatch: async () => { throw new Error("disk full"); } };
    await expect(tick({ api, store: broken, tracer, handle: async () => {} })).rejects.toThrow("disk full");
    expect(await store.getCursor()).toBe(0);
  });
});
