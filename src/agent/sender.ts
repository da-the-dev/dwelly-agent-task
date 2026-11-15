// Rung 3: works through the outbox after each batch of events. Each action is marked
// `sending` (committed) BEFORE its HTTP call, so a crash mid-call is visible on restart.
//
// What happens after each call:
//   2xx                           sent. A POST's Dwelly id is saved as a new case version
//                                 (cause_kind = action), in the same transaction.
//   429                           back to pending; pause sending for a while.
//   403 (session ended)           back to pending; stop sending for this run.
//   401                           back to pending; stop this drain (the poll shows the cause).
//   other 4xx                     failed: our request is wrong. The case gets needs_review.
//   5xx / timeout / network / bad body:
//     POST                        unknown: it may have created a case, and POST is not
//                                 idempotent, so it is never sent again. needs_review.
//     PATCH                       back to pending: PATCH is idempotent, retry next drain.
//
// A case's actions go in order: a PATCH waits until the case's POST is sent (it needs the
// Dwelly id), and nothing after an unknown or failed action goes out without a person.
import { ApiError, type Api } from "../api/client.js";
import type { Action } from "../action.js";
import { changedFields, type CaseRecord, type CaseVersion } from "../case.js";
import { describeError } from "../errors.js";
import type { Store } from "../store/store.js";
import type { Tracer } from "../trace.js";

export interface SenderDeps {
  api: Pick<Api, "createCase" | "patchCase">;
  store: Store;
  tracer: Tracer;
  now?: () => string;
  /** ms clock for the 429 pause; injectable for tests. */
  clock?: () => number;
  /** How long to stop sending after a 429. The spec's limit is per minute. */
  rateLimitPauseMs?: number;
  batchSize?: number;
}

export interface DrainResult {
  sent: number;
  failed: number;
  unknown: number;
  deferred: number;
  /** Actions not tried because an earlier action of their case is not sent yet. */
  waiting: number;
}

export interface Sender {
  drain(): Promise<DrainResult>;
}

type Outcome =
  | { to: "failed"; reason: string }
  | { to: "unknown"; reason: string }
  | { to: "pending"; reason: string; stop: "pause" | "session" | "drain" | null };

/** What an error from the world means for this action. */
export function outcomeOf(err: unknown, kind: Action["kind"]): Outcome {
  const reason = describeError(err);
  if (err instanceof ApiError && err.status < 500) {
    if (err.status === 429) return { to: "pending", reason, stop: "pause" };
    if (err.status === 403) return { to: "pending", reason, stop: "session" };
    if (err.status === 401) return { to: "pending", reason, stop: "drain" };
    return { to: "failed", reason };
  }
  // The server may have acted on it: a 5xx, a timeout, a dropped connection, or a 2xx whose
  // body we could not read.
  return kind === "case_open" ? { to: "unknown", reason } : { to: "pending", reason, stop: "drain" };
}

export function createSender(deps: SenderDeps): Sender {
  const { api, store, tracer } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const clock = deps.clock ?? Date.now;
  const pauseMs = deps.rateLimitPauseMs ?? 20_000;
  const batchSize = deps.batchSize ?? 50;
  let recovered = false;
  let sessionEnded = false;
  let pausedUntil = 0;

  /** The case's next version, caused by one of our actions. */
  function versionAfter(c: CaseRecord, change: Partial<CaseRecord>, a: Action, why: string): CaseVersion {
    const next: CaseRecord = { ...c, ...change, version: c.version + 1, updatedAt: now() };
    return { ...next, causeKind: "action", causeId: a.id, changed: changedFields(c, next), why };
  }

  const base = (a: Action) => ({ event_id: a.eventId, case_id: a.caseId, action_id: a.id, action: a.kind });

  return {
    async drain() {
      const r: DrainResult = { sent: 0, failed: 0, unknown: 0, deferred: 0, waiting: 0 };
      if (!recovered) {
        for (const a of await store.recoverSending()) {
          tracer.trace("action.recovered", { ...base(a), to: a.kind === "case_open" ? "unknown" : "pending" });
        }
        recovered = true;
      }
      if (sessionEnded || clock() < pausedUntil) return r;

      const blocked = new Set<string>();
      for (const a of await store.pendingActions(batchSize)) {
        if (blocked.has(a.caseId)) {
          r.waiting++;
          continue;
        }
        const earlier = (await store.actionsForCase(a.caseId)).filter(
          (x) => x.caseVersion < a.caseVersion || (x.caseVersion === a.caseVersion && x.seq < a.seq),
        );
        const c = await store.getCase(a.caseId);
        if (!c) throw new Error(`action ${a.id}: no case ${a.caseId}`);
        if (earlier.some((x) => x.status !== "sent") || (a.kind === "case_patch" && !c.dwellyCaseId)) {
          blocked.add(a.caseId);
          r.waiting++;
          continue;
        }

        await store.markAction(a.id, { status: "sending", attempt: true });
        try {
          if (a.kind === "case_open") {
            const created = await api.createCase(a.body);
            const v = versionAfter(c, { dwellyCaseId: created.id }, a, `POST /cases created ${created.id}`);
            await store.markAction(a.id, { status: "sent", resultId: created.id, sentAt: now() }, v);
            tracer.trace("action.sent", { ...base(a), body: a.body, dwelly_case_id: created.id, version: v.version });
          } else {
            await api.patchCase(c.dwellyCaseId as string, a.body);
            await store.markAction(a.id, { status: "sent", sentAt: now() });
            tracer.trace("action.sent", { ...base(a), body: a.body, dwelly_case_id: c.dwellyCaseId });
          }
          r.sent++;
        } catch (err) {
          const o = outcomeOf(err, a.kind);
          const http = err instanceof ApiError ? err.status : null;
          if (o.to === "pending") {
            await store.markAction(a.id, { status: "pending", error: o.reason });
            tracer.trace("action.deferred", { ...base(a), http_status: http, error: o.reason, stop: o.stop });
            r.deferred++;
            if (o.stop === "pause") pausedUntil = clock() + pauseMs;
            if (o.stop === "session") {
              sessionEnded = true;
              tracer.trace("session.ended", { ...base(a), note: "403: no more world-changing calls this run; reads go on" });
            }
            if (o.stop) break;
            continue;
          }
          // failed / unknown: a person should look. The case says so.
          const why = `${a.kind} ${o.to}: ${o.reason}`.slice(0, 500);
          const v = versionAfter(c, { needsReview: true }, a, why);
          await store.markAction(a.id, { status: o.to, error: o.reason }, v);
          tracer.trace(`action.${o.to}`, { ...base(a), body: a.body, http_status: http, error: o.reason, needs_review: true });
          r[o.to]++;
          blocked.add(a.caseId);
        }
      }
      return r;
    },
  };
}
