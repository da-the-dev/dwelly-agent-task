// What must be true after a run against the fake world, checked from three records that do
// not share code: the world's own state (GET /_admin/state), our database, and our trace.
// Pure: npm run e2e collects the inputs, this decides pass or fail.
//
// The fake world does not read our messages (each answer is the actor's next archive line,
// then "Thanks, will do."). So these checks test the mechanics, not the quality of what we
// say. The evals test the quality.
import { z } from "zod";
import type { Action } from "../action.js";
import type { CaseRecord } from "../case.js";
import { isClosed, LOOP_LIMIT, safetyLine } from "../agent/speak.js";
import type { InboxStatus } from "../store/store.js";
import type { RunStory } from "../story.js";

/** The parts of GET /_admin/state the checks use. Anything else in it is ignored. */
export const WorldState = z.object({
  scenario: z.string(),
  cases: z.array(z.object({ id: z.string(), property_id: z.string().nullable(), urgency: z.string(), status: z.string() })),
  work_orders: z.array(z.unknown()),
  outbox: z.array(z.object({ to: z.object({ id: z.string(), role: z.string() }), message: z.object({ body: z.string() }) })),
  log: z.array(z.object({ method: z.string(), path: z.string(), status: z.number(), response: z.unknown() })),
});
export type WorldState = z.infer<typeof WorldState>;

export type Level = "fail" | "warn" | "info";

export interface Check {
  name: string;
  level: Level;
  ok: boolean;
  detail: string;
}

export interface RunInputs {
  world: WorldState;
  cases: CaseRecord[];
  actions: Action[];
  inbox: Record<InboxStatus, number>;
  story: RunStory;
  emergencyNumber: string;
}

const list = (xs: string[], max = 5) => (xs.length > max ? `${xs.slice(0, max).join("; ")}; +${xs.length - max} more` : xs.join("; "));
const short = (id: string) => id.replace(/^case_/, "").slice(0, 8);

export function checkRun(r: RunInputs): Check[] {
  const out: Check[] = [];
  const check = (name: string, level: Level, bad: string[], good: string) =>
    out.push({ name, level, ok: bad.length === 0, detail: bad.length ? list(bad) : good });

  // 0. The run did something at all: a broken start must not pass as "no failures".
  check("the agent handled at least one message", "fail", r.cases.length ? [] : ["no case in our database"], `${r.cases.length} cases`);

  // 1. Every event was handled.
  check(
    "no inbox event left pending or failed",
    "fail",
    [r.inbox.pending ? `${r.inbox.pending} pending` : "", r.inbox.failed ? `${r.inbox.failed} failed` : ""].filter(Boolean),
    `${r.inbox.done} events done`,
  );

  // 2. Every call we queued was made and answered.
  // A message held by the loop guard is not an unsent call: a person decides (check 11b).
  const notSent = r.actions.filter((a) => a.status !== "sent" && a.status !== "held");
  check(
    "every queued call was sent",
    "fail",
    notSent.map((a) => `${a.kind} ${a.status} on ${short(a.caseId)}${a.error ? ` (${a.error})` : ""}`),
    `${r.actions.length} sent`,
  );

  // 3. The world accepted every request (it validates bodies against the spec).
  const rejected = r.world.log.filter((l) => l.status >= 400);
  check(
    "the world rejected none of our requests",
    "fail",
    rejected.map((l) => `${l.method} ${l.path} → ${l.status} ${JSON.stringify(l.response).slice(0, 120)}`),
    `${r.world.log.length} requests, all 2xx`,
  );

  // 4. No duplicate case: POST /cases is not idempotent.
  const perProperty = new Map<string, number>();
  for (const c of r.world.cases) perProperty.set(c.property_id ?? "(none)", (perProperty.get(c.property_id ?? "(none)") ?? 0) + 1);
  check(
    "at most one Dwelly case per property",
    "fail",
    [...perProperty].filter(([, n]) => n > 1).map(([p, n]) => `${p}: ${n} cases`),
    `${r.world.cases.length} cases on ${perProperty.size} properties`,
  );

  // 5. Our cases and the world's cases match one to one. A case may skip POST /cases only
  //    for a recorded reason (out of scope): the trace's action.skipped note.
  const ours = new Set(r.cases.map((c) => c.dwellyCaseId).filter((x): x is string => !!x));
  const theirs = new Set(r.world.cases.map((c) => c.id));
  const skipped = new Set(r.story.cases.filter((c) => c.turns.some((t) => t.notes.some((n) => n.startsWith("case_open skipped")))).map((c) => c.caseId));
  check(
    "our cases and the world's cases match one to one",
    "fail",
    [
      ...r.cases.filter((c) => !c.dwellyCaseId && !skipped.has(c.id)).map((c) => `ours ${short(c.id)} has no Dwelly case`),
      ...[...theirs].filter((id) => !ours.has(id)).map((id) => `world case ${id.slice(0, 8)} is not in our database`),
      ...[...ours].filter((id) => !theirs.has(id)).map((id) => `our Dwelly id ${id.slice(0, 8)} is not in the world`),
    ],
    `${ours.size} matched${skipped.size ? `, ${skipped.size} not opened on purpose (out of scope)` : ""}`,
  );

  // 6. Every message we sent reached the world.
  const sentMessages = r.actions.filter((a) => a.kind === "msg_send" && a.status === "sent").length;
  check(
    "the world received every message we sent",
    "fail",
    sentMessages === r.world.outbox.length ? [] : [`we sent ${sentMessages}, the world has ${r.world.outbox.length}`],
    `${sentMessages} messages`,
  );

  // 7. Every tenant who reported a problem heard from us.
  const messaged = new Set(r.world.outbox.map((m) => m.to.id));
  check(
    "every reporter got at least one message",
    "fail",
    r.cases.filter((c) => c.reporter && !messaged.has(c.reporter)).map((c) => `${c.reporter} on ${short(c.id)} "${c.title}"`),
    `${new Set(r.cases.map((c) => c.reporter)).size} reporters`,
  );

  // 8. On an open emergency, every message to the tenant starts with the safety line. The
  //    message comes from our database; the case's state when we wrote it, from the trace.
  const line = safetyLine({ urgency: "emergency", status: "open" }, r.emergencyNumber);
  const turnOf = new Map(r.story.cases.flatMap((c) => c.turns.map((t) => [`${c.caseId} ${t.eventId}`, t] as const)));
  const missingSafety: string[] = [];
  let emergencyMessages = 0;
  for (const a of r.actions) {
    if (a.kind !== "msg_send" || a.status === "held") continue;
    const t = turnOf.get(`${a.caseId} ${a.eventId}`);
    const reporter = r.cases.find((c) => c.id === a.caseId)?.reporter;
    const openEmergency = t?.urgency === "emergency" && t.status !== "closed" && t.status !== "resolved";
    if (!openEmergency || a.body.to !== reporter) continue;
    emergencyMessages++;
    if (!line || !a.body.body.startsWith(line)) missingSafety.push(`${a.eventId} to ${a.body.to}`);
  }
  check("emergency messages to the tenant start with the safety line", "fail", missingSafety, `${emergencyMessages} emergency messages`);

  // 9. A landlord hears from us only when they asked: POST /cases already tells them.
  const landlords = new Set(r.world.outbox.filter((m) => m.to.role === "landlord").map((m) => m.to.id));
  const unasked = r.story.cases.flatMap((c) =>
    c.turns.flatMap((t) =>
      t.actions
        .filter((a) => a.action === "msg_send" && a.to !== null && landlords.has(a.to) && !a.reasons.includes("asked"))
        .map((a) => `${t.eventId} to ${a.to} [${a.reasons.join(", ")}]`),
    ),
  );
  check("a landlord got a message only when they asked", "fail", unasked, `${landlords.size} landlords messaged`);

  // 10. No ping-pong.
  const perActor = new Map<string, number>();
  for (const m of r.world.outbox) perActor.set(m.to.id, (perActor.get(m.to.id) ?? 0) + 1);
  check(
    `no actor got more than ${LOOP_LIMIT} messages`,
    "warn",
    [...perActor].filter(([, n]) => n > LOOP_LIMIT).map(([id, n]) => `${id}: ${n}`),
    `most to one actor: ${Math.max(0, ...perActor.values())}`,
  );

  // 11. Cases a person must look at.
  check(
    "no case needs review",
    "warn",
    r.cases.filter((c) => c.needsReview).map((c) => `${short(c.id)} "${c.title}"`),
    "none",
  );

  // 11b. Messages the loop guard held: never written, never sent.
  check(
    "no message held by the loop guard",
    "warn",
    r.actions.filter((a) => a.status === "held").map((a) => `${a.eventId} to ${a.kind === "msg_send" ? a.body.to : "?"} on ${short(a.caseId)}`),
    "none",
  );

  // 12. What the run did not cover, so a pass is not read as more than it is.
  const ignored = r.story.other.filter((l) => l.kind === "event.ignored").length;
  const open = r.cases.filter((c) => !isClosed(c)).length;
  out.push({
    name: "not covered",
    level: "info",
    ok: true,
    detail: `${ignored} events ignored (case.created/updated echoes); ${r.world.work_orders.length} work orders (rung 4 is not built); ${open} cases still open`,
  });
  return out;
}

export const failed = (checks: Check[]) => checks.filter((c) => c.level === "fail" && !c.ok);

export function renderChecks(checks: Check[]): string {
  const mark = (c: Check) => (c.ok ? (c.level === "info" ? "ℹ" : "✓") : c.level === "fail" ? "✗ FAIL" : "⚠ WARN");
  return checks.map((c) => `${mark(c).padEnd(7)} ${c.name}: ${c.detail}`).join("\n");
}
