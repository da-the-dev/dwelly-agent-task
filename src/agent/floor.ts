// Safety floor: a MINIMUM urgency set by code from hazard words, whatever the model says.
// The model may raise urgency above the floor, never lower it below.
//
// Why code and not the prompt: the rules are the cases where being wrong is dangerous
// (archive 01, 05, 06, 08, 12). Code is deterministic, unit-tested for free, and survives a
// prompt rewrite or a model swap. It is NOT the fallback for invalid model output; that is
// the classifier's retry-then-needs_review path.
//
// The rules over-fire on purpose: rating a drip "medium" too early is cheap, missing a gas
// leak is not. A small negation guard skips "no leaks anywhere" and "nothing is leaking".
import { urgencyRank, type NextStep, type Urgency } from "../case.js";

export interface FloorRule {
  name: string;
  urgency: Urgency;
  /** The case belongs to someone else's emergency line (gas network), not a contractor. */
  external?: boolean;
  /** Every pattern must match somewhere in the message (not necessarily the same sentence). */
  all: RegExp[];
}

const WATER = /\b(leak(s|ing|ed)?|pour(s|ing)?|flood(s|ing|ed)?|gushing|water (is )?(coming|pouring|dripping|running) (through|in|down))\b/i;
const ELECTRICS = /\b(light fittings?|light switch(es)?|ceiling lights?|lights|light ?bulbs?|sockets?|electrics?|electrical|fuse ?box|consumer unit|wiring)\b/i;
const NO_HEAT = /\b(no (heating|hot water)|boiler (has )?(died|dead|stopped|broken|packed up|not working)|heating (has )?(stopped|died|not working|broken))\b/i;
const COLD = /\b(minus|freezing|below zero|sub-zero|frost|snow|cold outside|bitterly cold)\b/i;

export const FLOOR_RULES: FloorRule[] = [
  { name: "gas smell", urgency: "emergency", external: true, all: [/\b(smell(s|ing)? of gas|gas (smell|leak)|smell gas|eggy smell|rotten eggs?)\b/i] },
  { name: "carbon monoxide", urgency: "emergency", external: true, all: [/\b(carbon monoxide|co alarm)\b/i] },
  { name: "water near electrics", urgency: "emergency", all: [WATER, ELECTRICS] },
  { name: "smoke, sparks or burning smell", urgency: "high", all: [/\b(smoke|smoking|sparks?|sparking|burning smell|smell of burning|hot plastic|melting|scorch(ed|ing)?|fire)\b/i] },
  { name: "water reaching another flat", urgency: "high", all: [/\b(coming from upstairs|from (the )?(flat|floor) above|flat (below|downstairs)|stain on (my|the) (kitchen |bathroom )?ceiling)\b/i] },
  { name: "no heating or hot water in the cold", urgency: "high", all: [NO_HEAT, COLD] },
  { name: "home cannot be locked", urgency: "high", all: [/\b(won'?t lock|can'?t lock|cannot lock|doesn'?t lock|unable to lock|won'?t close|can'?t close|broken (front )?door|door (is )?broken)\b/i] },
  { name: "no heating or hot water", urgency: "medium", all: [NO_HEAT] },
  { name: "water escape", urgency: "medium", all: [WATER] },
];

export interface Floor {
  urgency: Urgency | null;
  external: boolean;
  /** Names of the rules that fired; empty when none did. */
  rules: string[];
}

// "No leaks anywhere", "nothing is leaking", "without any smell of gas": skip that match.
// Checked within the match's own sentence.
const NEGATION = /\b(no|not|nothing|without|never|isn'?t|aren'?t)\s+(\w+\s+){0,2}$/i;

function matchesSentence(sentence: string, re: RegExp): boolean {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of sentence.matchAll(global)) {
    if (!NEGATION.test(sentence.slice(0, m.index))) return true;
  }
  return false;
}

export function safetyFloor(text: string): Floor {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const anywhere = (re: RegExp) => sentences.some((s) => matchesSentence(s, re));
  const fired = FLOOR_RULES.filter((r) => r.all.every(anywhere));
  if (fired.length === 0) return { urgency: null, external: false, rules: [] };
  const top = fired.reduce((a, b) => (urgencyRank(b.urgency) > urgencyRank(a.urgency) ? b : a));
  return { urgency: top.urgency, external: fired.some((r) => r.external), rules: fired.map((r) => r.name) };
}

export interface Decision {
  urgency: Urgency;
  nextStep: NextStep;
  why: string;
}

/** Raise the model's decision to the floor. Returns what changed, for the trace. */
export function applyFloor(d: Decision, floor: Floor): { decision: Decision; overrides: string[] } {
  const overrides: string[] = [];
  let { urgency, nextStep, why } = d;
  if (floor.urgency && urgencyRank(floor.urgency) > urgencyRank(urgency)) {
    overrides.push(`urgency ${urgency} -> ${floor.urgency}`);
    urgency = floor.urgency;
  }
  if (floor.external && nextStep !== "external") {
    overrides.push(`next_step ${nextStep} -> external`);
    nextStep = "external";
  }
  if (overrides.length) why = `${why} [safety floor: ${floor.rules.join(", ")}]`;
  return { decision: { urgency, nextStep, why }, overrides };
}
