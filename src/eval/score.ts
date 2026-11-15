// Scoring for `npm run eval`. Pure: no LLM, no I/O, so `npm test` covers it.
import { urgencyRank, type CaseStatus, type NextStep, type Urgency } from "../case.js";
import type { EvalItem } from "./set.js";

/** What one run of one item produced (the last step of its thread). */
export interface RunResult {
  item: string;
  run: number;
  /** After the safety floor: what the agent would act on. */
  urgency: Urgency;
  nextStep: NextStep;
  /** The model's own answer, before the floor; null if its output stayed invalid. */
  modelUrgency: Urgency | null;
  modelNextStep: NextStep | null;
  /** The floor changed the model's answer (on any step of the thread). */
  floorOverrode: boolean;
  /** The model's output stayed invalid after its retry (on any step). */
  invalid: boolean;
  summary: string;
  why: string;
  /** The case status after the last step. */
  status: CaseStatus;
  /** The roles speakFor picks for a message at the last step (sorted; no LLM call). */
  speak: string[];
  /** --reply only: the messages the writer produced for the last step. */
  replies?: ReplyResult[];
}

export interface Score {
  urgencyOk: boolean;
  nextStepOk: boolean;
  /** A critical item (lowest accepted urgency high or emergency) rated below that: hard fail. */
  underRated: boolean;
  /** The model alone (before the floor) would have under-rated a critical item. */
  modelUnderRated: boolean;
  /** The summary says we asked, told or sent something, when no reply exists yet. */
  summaryClaim: boolean;
  /** null: the item has no expectation for it. */
  statusOk: boolean | null;
  speakOk: boolean | null;
}

const minUrgency = (us: Urgency[]): Urgency => us.reduce((a, b) => (urgencyRank(b) < urgencyRank(a) ? b : a));

export function isCritical(item: EvalItem): boolean {
  return urgencyRank(minUrgency(item.expect.urgency)) >= urgencyRank("high");
}

// "We have asked her to…", "the tenant has been told…", "advised to turn off…": the summary
// must record what happened, and at this point the agent has not replied to anyone.
const CLAIM =
  /\b(we|manager|agent)\s+(have\s+|has\s+)?(asked|told|advised|instructed|sent|booked|arranged)\b|\b(has|have|was|were)\s+been\s+(asked|told|advised|instructed)\b|\b(has|have)\s+been\s+(sent|booked|arranged)\b/i;

export function summaryClaims(summary: string): boolean {
  return CLAIM.test(summary);
}

// A message (rung 5) must not claim what only the world can confirm: before rung 4 nobody is
// booked, called or on the way. "We will arrange" is fine; "we've booked" is not.
// "Until the engineer arrives" (fake-world run, 15 Nov) promises that someone is coming.
// "We're checking whether your landlord holds a spare" (experiment 003): an action in progress
// that nothing in the case records (criteria v1, T5).
const REPLY_CLAIM =
  /\b(we|i)('re|'m|\s+are|\s+am)\s+(now\s+|currently\s+|already\s+)?(checking|asking|contacting|chasing|speaking (to|with)|getting in touch|liaising|looking into|finding out)\b|\b(we|i)('ve|\s+have|\s+has)?\s+(already\s+)?(called|phoned|rung|contacted|booked|arranged|dispatched|sent (an?|the|someone)|notified|informed|spoken to|reported)\b|\b(is|are) on (their|his|her|its|the) way\b|\b(has|have) been (dispatched|booked|called|arranged)\b|\buntil (the|an?|they|someone|help)\b[^.!?\n]{0,40}?\barrives?\b/i;

export function replyClaims(body: string): boolean {
  return REPLY_CLAIM.test(body);
}

/** One message the writer produced for an eval run (npm run eval -- --reply). */
export interface ReplyResult {
  to: string;
  role: string;
  reasons: string[];
  source: "model" | "template";
  /** The body claims an action that has not happened. */
  claim: boolean;
  /** An open emergency case and a tenant: the body must start with the safety line. */
  safetyExpected: boolean;
  safetyPresent: boolean;
  words: number;
  body: string;
}

export function score(item: EvalItem, r: RunResult): Score {
  const floor = minUrgency(item.expect.urgency);
  const critical = isCritical(item);
  return {
    urgencyOk: item.expect.urgency.includes(r.urgency),
    nextStepOk: item.expect.next_step.includes(r.nextStep),
    underRated: critical && urgencyRank(r.urgency) < urgencyRank(floor),
    modelUnderRated: critical && (r.modelUrgency === null || urgencyRank(r.modelUrgency) < urgencyRank(floor)),
    summaryClaim: summaryClaims(r.summary),
    statusOk: item.expect.status ? item.expect.status.includes(r.status) : null,
    speakOk: item.expect.speak ? sameSet(item.expect.speak, r.speak) : null,
  };
}

const sameSet = (a: string[], b: string[]) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export interface ItemReport {
  id: string;
  why: string;
  critical: boolean;
  runs: number;
  urgencyOk: number;
  nextStepOk: number;
  underRated: number;
  modelUnderRated: number;
  /** Values seen across runs, e.g. { medium: 2, high: 1 }. */
  urgencies: Record<string, number>;
  nextSteps: Record<string, number>;
  /** null when the item has no such expectation. */
  statusOk: number | null;
  speakOk: number | null;
  statuses: Record<string, number>;
  /** Who got a message, per run: "tenant+landlord", or "none". */
  speaks: Record<string, number>;
}

export interface Totals {
  runs: number;
  urgencyOk: number;
  nextStepOk: number;
  bothOk: number;
  /** Hard fails: a critical item rated below its floor. Must be 0. */
  underRated: number;
  /** How often the model alone would have under-rated: what the safety floor is carrying. */
  modelUnderRated: number;
  floorOverrode: number;
  invalid: number;
  summaryClaims: number;
  /** Runs of items that expect a status or a speak set, and how many matched. */
  statusRuns: number;
  statusOk: number;
  speakRuns: number;
  speakOk: number;
}

const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

export function report(items: EvalItem[], results: RunResult[]): { items: ItemReport[]; totals: Totals } {
  const totals: Totals = { runs: 0, urgencyOk: 0, nextStepOk: 0, bothOk: 0, underRated: 0, modelUnderRated: 0, floorOverrode: 0, invalid: 0, summaryClaims: 0,
    statusRuns: 0, statusOk: 0, speakRuns: 0, speakOk: 0 };
  const rows = items.map((item) => {
    const rs = results.filter((r) => r.item === item.id);
    const ss = rs.map((r) => score(item, r));
    const n = (f: (s: Score) => boolean) => ss.filter(f).length;
    totals.runs += rs.length;
    totals.urgencyOk += n((s) => s.urgencyOk);
    totals.nextStepOk += n((s) => s.nextStepOk);
    totals.bothOk += n((s) => s.urgencyOk && s.nextStepOk);
    totals.underRated += n((s) => s.underRated);
    totals.modelUnderRated += n((s) => s.modelUnderRated);
    totals.summaryClaims += n((s) => s.summaryClaim);
    totals.floorOverrode += rs.filter((r) => r.floorOverrode).length;
    totals.invalid += rs.filter((r) => r.invalid).length;
    const statusOk = item.expect.status ? n((s) => s.statusOk === true) : null;
    const speakOk = item.expect.speak ? n((s) => s.speakOk === true) : null;
    if (statusOk !== null) {
      totals.statusRuns += rs.length;
      totals.statusOk += statusOk;
    }
    if (speakOk !== null) {
      totals.speakRuns += rs.length;
      totals.speakOk += speakOk;
    }
    return {
      id: item.id,
      why: item.why,
      critical: isCritical(item),
      runs: rs.length,
      urgencyOk: n((s) => s.urgencyOk),
      nextStepOk: n((s) => s.nextStepOk),
      underRated: n((s) => s.underRated),
      modelUnderRated: n((s) => s.modelUnderRated),
      urgencies: count(rs.map((r) => r.urgency)),
      nextSteps: count(rs.map((r) => r.nextStep)),
      statusOk,
      speakOk,
      statuses: count(rs.map((r) => r.status)),
      speaks: count(rs.map((r) => (r.speak.length ? [...r.speak].sort().join("+") : "none"))),
    };
  });
  return { items: rows, totals };
}
