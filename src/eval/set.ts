// The eval sets (evals/cases.json, evals/scenarios.json) and how their items become messages
// for `decide`. Shared by `npm run eval` and `npm run try:classify`, so both replay the archive
// the same way.
//
// An item is one of:
//   archive  an archive case's first tenant message, or its thread up to messages[upTo]
//   text     one tenant message
//   thread   hand-written turns from the tenant, the landlord or a contractor; the first turn
//            is the tenant who reports it (the reporter). Scored on the last turn.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { HistoryCase, HistoryCasesResponse } from "../api/types.js";
import { CASE_STATUSES, NEXT_STEPS, URGENCIES } from "../case.js";
import type { IncomingMessage } from "../agent/message.js";

const Expect = z.strictObject({
  urgency: z.array(z.enum(URGENCIES)).min(1),
  next_step: z.array(z.enum(NEXT_STEPS)).min(1),
  /** The case status after the last step. Not scored when absent. */
  status: z.array(z.enum(CASE_STATUSES)).min(1).optional(),
  /** The exact set of roles that get a message at the last step (speakFor); [] = nobody. */
  speak: z.array(z.enum(["tenant", "landlord", "contractor"])).optional(),
});

const ROLES = ["tenant", "landlord", "contractor"] as const;
const Turn = z.strictObject({ role: z.enum(ROLES), text: z.string().min(1), name: z.string().optional() });

const Item = z.union([
  z.strictObject({ id: z.string(), archive: z.string(), upTo: z.number().int().min(0).optional(), expect: Expect, why: z.string() }),
  z.strictObject({ id: z.string(), text: z.string().min(1), expect: Expect, why: z.string() }),
  z.strictObject({
    id: z.string(),
    thread: z.array(Turn).min(1).refine((t) => t[0]?.role === "tenant", "a thread starts with the tenant who reports it"),
    expect: Expect,
    why: z.string(),
  }),
]);
export type EvalItem = z.infer<typeof Item>;

const EvalSet = z.object({ items: z.array(Item).min(1) });

/** The eval sets in evals/: `cases` (the default, scored since 11 Nov) and `scenarios` (15 Nov). */
export const EVAL_SETS = ["cases", "scenarios"] as const;
export type EvalSetName = (typeof EVAL_SETS)[number];

/** evals/ and data/ sit two levels up from both src/eval/ and dist/eval/. */
const repoFile = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

export function loadEvalSet(set: EvalSetName = "cases"): EvalItem[] {
  const items = EvalSet.parse(JSON.parse(repoFile(`evals/${set}.json`))).items;
  const ids = items.map((i) => i.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`evals/${set}.json: duplicate id ${dup}`);
  return items;
}

export function loadArchive(): HistoryCase[] {
  return (JSON.parse(repoFile("data/history.json")) as HistoryCasesResponse).cases;
}

/** Indices of every message not written by the manager, up to and including `last`. */
export function threadUpTo(c: HistoryCase, last: number): number[] {
  return c.messages.flatMap((m, i) => (i <= last && m.from !== "manager" ? [i] : []));
}

/** One archive message as the agent would receive it. */
export function archiveMessage(c: HistoryCase, i: number, eventId = `${c.id}#${i}`): IncomingMessage {
  const m = c.messages[i];
  if (!m) throw new Error(`${c.id} has no messages[${i}]`);
  return {
    eventId,
    text: m.body,
    subject: null,
    actor: { id: `${m.from}:${m.name}`, role: m.from, name: m.name },
    propertyId: c.property.id,
    caseRef: null,
    occurredAt: m.sent_at,
  };
}

/** The messages an item feeds to `decide`, in order; the last one is scored. */
const EVAL_NAMES = { tenant: "Sam Taylor", landlord: "Ms Patel", contractor: "Dave Hughes" } as const;
const EVAL_START = Date.parse("2026-11-15T19:00:00.000Z");

export function itemMessages(item: EvalItem, archive: HistoryCase[], run = 0): IncomingMessage[] {
  if ("thread" in item) {
    // one minute between turns, so the case's time stamps keep their order
    return item.thread.map((t, i) => ({
      eventId: `${item.id}#${i}#r${run}`,
      text: t.text,
      subject: null,
      actor: { id: `${t.role}:eval`, role: t.role, name: t.name ?? EVAL_NAMES[t.role] },
      propertyId: "prop_eval",
      caseRef: null,
      occurredAt: new Date(EVAL_START + i * 60_000).toISOString(),
    }));
  }
  if ("text" in item) {
    return [{
      eventId: `${item.id}#r${run}`,
      text: item.text,
      subject: null,
      actor: { id: "tenant:eval", role: "tenant", name: "Sam" },
      propertyId: "prop_eval",
      caseRef: null,
      occurredAt: "2026-11-15T19:00:00.000Z",
    }];
  }
  const c = archive.find((x) => x.id === item.archive);
  if (!c) throw new Error(`eval ${item.id}: no archive case ${item.archive}`);
  const steps = item.upTo === undefined ? [c.messages.findIndex((m) => m.from === "tenant")] : threadUpTo(c, item.upTo);
  return steps.map((i) => archiveMessage(c, i, `${c.id}#${i}#r${run}`));
}
