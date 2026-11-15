// Scoring for `npm run eval`. Pure: no LLM, no I/O, so `npm test` covers it.
import { urgencyRank, type NextStep, type Urgency } from "../case.js";
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

export function score(item: EvalItem, r: RunResult): Score {
  const floor = minUrgency(item.expect.urgency);
  const critical = isCritical(item);
  return {
    urgencyOk: item.expect.urgency.includes(r.urgency),
    nextStepOk: item.expect.next_step.includes(r.nextStep),
    underRated: critical && urgencyRank(r.urgency) < urgencyRank(floor),
    modelUnderRated: critical && (r.modelUrgency === null || urgencyRank(r.modelUrgency) < urgencyRank(floor)),
    summaryClaim: summaryClaims(r.summary),
  };
}

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
}

const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

export function report(items: EvalItem[], results: RunResult[]): { items: ItemReport[]; totals: Totals } {
  const totals: Totals = { runs: 0, urgencyOk: 0, nextStepOk: 0, bothOk: 0, underRated: 0, modelUnderRated: 0, floorOverrode: 0, invalid: 0, summaryClaims: 0 };
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
    };
  });
  return { items: rows, totals };
}
