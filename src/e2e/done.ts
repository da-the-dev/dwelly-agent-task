// When is an e2e run over? Found in the first e2e run (15 Nov): "the agent printed nothing for
// 8 s" alone stopped the agent in the middle of an 18 s LLM call, and the world's last two
// answers were never read. Quiet output is not idle: the work must also be finished.
import type { Action } from "../action.js";
import type { InboxStatus } from "../store/store.js";

export interface Progress {
  msSinceOutput: number;
  quietMs: number;
  inbox: Record<InboxStatus, number>;
  actions: Pick<Action, "status">[];
}

/** null when the run is over; else why it is not. */
export function notOverBecause(p: Progress): string | null {
  if (p.inbox.pending > 0) return `${p.inbox.pending} events not handled yet`;
  const waiting = p.actions.filter((a) => a.status === "pending" || a.status === "sending").length;
  if (waiting > 0) return `${waiting} calls not sent yet`;
  // A world answer comes 5 s of sim time after our message; quietMs is longer than that.
  if (p.msSinceOutput < p.quietMs) return "the agent printed something recently";
  return null;
}
