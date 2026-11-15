// Rungs 3 and 5: works through the outbox after each batch of events. Each action is marked
// `sending` (committed) BEFORE its HTTP call, so a crash mid-call is visible on restart.
//
// What happens after each call:
//   2xx                           sent. A POST /cases's Dwelly id is saved as a new case
//                                 version (cause_kind = action), in the same transaction.
//   429                           back to pending; pause sending for a while.
//   403 (session ended)           back to pending; stop sending for this run.
//   401                           back to pending; stop this drain (the poll shows the cause).
//   other 4xx                     failed: our request is wrong (or, for a message, the actor
//                                 is unknown). The case gets needs_review.
//   5xx / timeout / network / bad body:
//     POST /cases                 unknown: it may have created a case, and POST is not
//                                 idempotent, so it is never sent again. needs_review.
//     PATCH                       back to pending: PATCH is idempotent, retry next drain.
//     message, emergency case     back to pending ONCE (a second safety text costs less
//                                 than none); after that, unknown.
//     message, otherwise          unknown, never re-sent. needs_review.
//
// Case actions go in order: a PATCH waits until the case's POST is sent (it needs the
// Dwelly id), and nothing after an unknown or failed case action goes out without a person.
// A message (msg_send) needs no Dwelly id, so it never waits for a case action, and a
// failed message does not hold back the next one.
import { ApiError, type Api } from "../api/client.js";
import type { Action } from "../action.js";
import { changedFields, type CaseRecord, type CaseVersion } from "../case.js";
import { describeError } from "../errors.js";
import type { Store } from "../store/store.js";
import type { Tracer } from "../trace.js";

export interface SenderDeps {
  api: Pick<Api, "createCase" | "patchCase" | "sendMessage">;
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

/**
 * What an error from the world means for this action. `resend`: a message that may or may
 * not have been delivered is sent again (an emergency message's one re-send).
 */
export function outcomeOf(err: unknown, kind: Action["kind"], resend = false): Outcome {
  const reason = describeError(err);
  if (err instanceof ApiError && err.status < 500) {
    if (err.status === 429) return { to: "pending", reason, stop: "pause" };
    if (err.status === 403) return { to: "pending", reason, stop: "session" };
    if (err.status === 401) return { to: "pending", reason, stop: "drain" };
    return { to: "failed", reason };
  }
  // The server may have acted on it: a 5xx, a timeout, a dropped connection, or a 2xx whose
  // body we could not read.
  if (kind === "case_patch" || resend) return { to: "pending", reason, stop: "drain" };
  return { to: "unknown", reason };
}

/** A message gets one re-send when its case is an emergency: at most two attempts in all. */
export function mayResend(a: Action, c: CaseRecord): boolean {
  return a.kind === "msg_send" && c.urgency === "emergency" && a.attempts < 2;
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
          let to = a.kind === "case_patch" ? "pending" : "unknown";
          const c = to === "unknown" ? await store.getCase(a.caseId) : null;
          // a.attempts already counts the interrupted call
          if (c && mayResend(a, c)) {
            await store.markAction(a.id, { status: "pending" });
            to = "pending";
          }
          if (c && to === "unknown") {
            // Same rule as an unknown result in a drain: a person must look (review, 16 Nov).
            const reason = `${a.kind} unknown: interrupted mid-call (process stopped)`;
            await store.markAction(a.id, { status: "unknown", error: "interrupted mid-call (process stopped)" }, versionAfter(c, { needsReview: true }, a, reason));
            tracer.trace("action.recovered", { ...base(a), to, needs_review: true, review_reason: reason });
          } else {
            tracer.trace("action.recovered", { ...base(a), to });
          }
        }
        recovered = true;
      }
      if (sessionEnded || clock() < pausedUntil) return r;

      const blocked = new Set<string>();
      for (const a of await store.pendingActions(batchSize)) {
        const isMessage = a.kind === "msg_send";
        if (!isMessage && blocked.has(a.caseId)) {
          r.waiting++;
          continue;
        }
        const c = await store.getCase(a.caseId);
        if (!c) throw new Error(`action ${a.id}: no case ${a.caseId}`);
        if (!isMessage) {
          const earlier = (await store.actionsForCase(a.caseId)).filter(
            (x) => x.kind !== "msg_send" && (x.caseVersion < a.caseVersion || (x.caseVersion === a.caseVersion && x.seq < a.seq)),
          );
          if (earlier.some((x) => x.status !== "sent") || (a.kind === "case_patch" && !c.dwellyCaseId)) {
            blocked.add(a.caseId);
            r.waiting++;
            continue;
          }
        }

        await store.markAction(a.id, { status: "sending", attempt: true });
        try {
          if (a.kind === "case_open") {
            const created = await api.createCase(a.body);
            const v = versionAfter(c, { dwellyCaseId: created.id }, a, `POST /cases created ${created.id}`);
            await store.markAction(a.id, { status: "sent", resultId: created.id, sentAt: now() }, v);
            tracer.trace("action.sent", { ...base(a), body: a.body, dwelly_case_id: created.id, version: v.version });
          } else if (a.kind === "msg_send") {
            const { to, ...message } = a.body;
            await api.sendMessage(to, message);
            await store.markAction(a.id, { status: "sent", sentAt: now() });
            tracer.trace("action.sent", { ...base(a), to, body: message });
          } else {
            await api.patchCase(c.dwellyCaseId as string, a.body);
            await store.markAction(a.id, { status: "sent", sentAt: now() });
            tracer.trace("action.sent", { ...base(a), body: a.body, dwelly_case_id: c.dwellyCaseId });
          }
          r.sent++;
        } catch (err) {
          // `a` was read before this attempt was counted
          const o = outcomeOf(err, a.kind, mayResend({ ...a, attempts: a.attempts + 1 }, c));
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
          tracer.trace(`action.${o.to}`, { ...base(a), body: a.body, http_status: http, error: o.reason, needs_review: true, review_reason: why });
          r[o.to]++;
          if (!isMessage) blocked.add(a.caseId);
        }
      }
      return r;
    },
  };
}
