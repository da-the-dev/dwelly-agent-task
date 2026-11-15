// Rung 1: read the events. Transactional inbox:
//   1. GET /events?after=<cursor>
//   2. store the batch + the new cursor in one transaction (dedup by event id)
//   3. process pending inbox events oldest first, marking each done or failed
// A crash between 1 and 2 re-fetches the same batch (cursor not moved). A crash during 3
// leaves the event pending, so it is processed again on restart: at-least-once.
import type { WorldEvent } from "../api/types.js";
import type { Api } from "../api/client.js";
import type { Store } from "../store/store.js";
import type { Tracer } from "../trace.js";
import { describeError } from "../errors.js";

export type EventHandler = (event: WorldEvent) => Promise<void>;

export interface LoopDeps {
  /** The loop only reads the feed; world-changing calls go through the sender. */
  api: Pick<Api, "getEvents">;
  store: Store;
  tracer: Tracer;
  handle: EventHandler;
  batchSize?: number;
}

export interface TickResult {
  fetched: number;
  inserted: number;
  processed: number;
  /** The page was full: more events are probably waiting, poll again without sleeping. */
  full: boolean;
}

export async function tick({ api, store, tracer, handle, batchSize = 100 }: LoopDeps): Promise<TickResult> {
  const after = await store.getCursor();
  const res = await api.getEvents(after, batchSize);
  const inserted = await store.saveBatch(res.events, res.next_cursor);
  if (res.events.length > 0) {
    tracer.trace("poll", { after, next_cursor: res.next_cursor, fetched: res.events.length, inserted });
  }

  let processed = 0;
  for (const event of await store.pending(batchSize)) {
    try {
      await handle(event);
      await store.mark(event.id, "done");
    } catch (err) {
      // A poison event must not block the queue: record it and move on. Failed events stay
      // in the inbox for inspection and replay.
      const message = describeError(err);
      await store.mark(event.id, "failed", message);
      tracer.trace("event.failed", { event_id: event.id, error: message });
    }
    processed++;
  }
  return { fetched: res.events.length, inserted, processed, full: res.events.length === batchSize };
}

export async function runLoop(deps: LoopDeps & { intervalMs: number; signal: AbortSignal }): Promise<void> {
  const { tracer, intervalMs, signal } = deps;
  let failures = 0;
  while (!signal.aborted) {
    let wait = intervalMs;
    try {
      const r = await tick(deps);
      failures = 0;
      if (r.full) wait = 0;
    } catch (err) {
      // Network blip, 5xx, or a malformed body: back off exponentially, capped at 30 s.
      failures++;
      wait = Math.min(intervalMs * 2 ** failures, 30_000);
      tracer.trace("poll.error", { error: describeError(err), failures, retry_in_ms: wait });
    }
    await sleep(wait, signal);
  }
  tracer.trace("loop.stopped");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}
