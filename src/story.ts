// A run's trace, read back as one story per case: the message in, what we decided and why,
// the calls we queued and what happened to them, and the replies we wrote (or that we wrote
// none). Pure: no I/O. `npm run story` and `npm run e2e` print it.
//
// The trace file is the record; this is only a view of it. Each line is untrusted JSON, so
// every field is read as `unknown` and checked.

export interface TraceLine {
  ts: string;
  kind: string;
  [key: string]: unknown;
}

export interface MessageIn {
  from: string | null;
  role: string | null;
  name: string | null;
  subject: string | null;
  text: string | null;
}

export interface ActionView {
  id: string;
  /** msg_send | case_open | case_patch */
  action: string;
  to: string | null;
  reasons: string[];
  body: unknown;
  /** sent | deferred | failed | unknown | recovered, in trace order, with details. */
  outcomes: { kind: string; detail: string }[];
}

export interface Turn {
  eventId: string;
  ts: string;
  message: MessageIn;
  version: number | null;
  applied: boolean;
  linkedBy: string | null;
  urgency: string | null;
  nextStep: string | null;
  status: string | null;
  waitingOn: string | null;
  changed: string[];
  why: string | null;
  floor: string[];
  roleGuard: boolean;
  needsReview: boolean;
  actions: ActionView[];
  /** Other lines about this event on this case: loop guard, skipped POST, duplicate delivery. */
  notes: string[];
}

export interface CaseStory {
  caseId: string;
  title: string | null;
  propertyId: string | null;
  turns: Turn[];
}

export interface RunStory {
  run: TraceLine | null;
  cases: CaseStory[];
  /** Lines that belong to no case: ignored events, unlinked messages, errors. */
  other: TraceLine[];
  counts: Record<string, number>;
  badLines: number;
}

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" ? x : null);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** One TraceLine per valid JSONL line; a line that is not an object with a string kind is counted, not kept. */
export function parseTrace(jsonl: string): { lines: TraceLine[]; badLines: number } {
  const lines: TraceLine[] = [];
  let badLines = 0;
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      badLines++;
      continue;
    }
    if (isObj(v) && typeof v["kind"] === "string") lines.push({ ...v, kind: v["kind"], ts: str(v["ts"]) ?? "" });
    else badLines++;
  }
  return { lines, badLines };
}

/** Traces written before case.version carried the text: take it from the classify call's input. */
function messageFromLlmCall(line: TraceLine): MessageIn | null {
  if (!str(line["prompt"])?.startsWith("classify")) return null;
  const input = line["input"];
  if (!Array.isArray(input)) return null;
  const last: unknown = input[input.length - 1];
  const content = isObj(last) ? str(last["content"]) : null;
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    const m = isObj(parsed) ? parsed["message"] : null;
    if (!isObj(m)) return null;
    return { from: null, role: str(m["from"]), name: str(m["name"]), subject: str(m["subject"]), text: str(m["text"]) };
  } catch {
    return null;
  }
}

const OUTCOMES = new Set(["action.sent", "action.deferred", "action.failed", "action.unknown", "action.recovered"]);
const RUN_LEVEL = new Set(["event.ignored", "message.unlinked", "event.failed", "poll.error", "send.error", "session.ended"]);

function outcomeDetail(l: TraceLine): string {
  const parts: string[] = [];
  const dwelly = str(l["dwelly_case_id"]);
  if (dwelly) parts.push(`dwelly ${dwelly}`);
  const version = num(l["version"]);
  if (version !== null) parts.push(`v${version}`);
  const http = num(l["http_status"]);
  if (http !== null) parts.push(`HTTP ${http}`);
  const error = str(l["error"]);
  if (error) parts.push(error);
  return parts.join(" · ");
}

export function buildStory(lines: TraceLine[], badLines = 0): RunStory {
  const sorted = [...lines].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const counts: Record<string, number> = {};
  const fallback = new Map<string, MessageIn>();
  const cases = new Map<string, CaseStory>();
  const turns = new Map<string, Turn>(); // key: case_id + event_id
  const actions = new Map<string, ActionView>();
  const other: TraceLine[] = [];
  let run: TraceLine | null = null;

  const caseOf = (id: string): CaseStory => {
    let c = cases.get(id);
    if (!c) cases.set(id, (c = { caseId: id, title: null, propertyId: null, turns: [] }));
    return c;
  };
  const turnOf = (caseId: string, eventId: string, ts: string): Turn => {
    const key = `${caseId}\u0000${eventId}`;
    let t = turns.get(key);
    if (!t) {
      t = {
        eventId, ts, message: fallback.get(eventId) ?? { from: null, role: null, name: null, subject: null, text: null },
        version: null, applied: true, linkedBy: null, urgency: null, nextStep: null, status: null, waitingOn: null,
        changed: [], why: null, floor: [], roleGuard: false, needsReview: false, actions: [], notes: [],
      };
      turns.set(key, t);
      caseOf(caseId).turns.push(t);
    }
    return t;
  };

  for (const l of sorted) {
    counts[l.kind] = (counts[l.kind] ?? 0) + 1;
    const caseId = str(l["case_id"]);
    const eventId = str(l["event_id"]) ?? "?";

    if (l.kind === "run.start") {
      run ??= l;
      continue;
    }
    if (l.kind === "llm.call") {
      const m = messageFromLlmCall(l);
      if (m && !fallback.has(eventId)) fallback.set(eventId, m);
      continue;
    }
    if (RUN_LEVEL.has(l.kind) || (!caseId && (OUTCOMES.has(l.kind) || l.kind.startsWith("action.")))) {
      other.push(l);
      continue;
    }
    if (!caseId) continue; // poll, loop.stopped and other bookkeeping

    if (l.kind === "case.version") {
      const t = turnOf(caseId, eventId, l.ts);
      const c = caseOf(caseId);
      c.title = str(l["title"]) ?? c.title;
      c.propertyId = str(l["property_id"]) ?? c.propertyId;
      const text = str(l["text"]);
      if (text !== null) {
        t.message = { from: str(l["from"]), role: str(l["role"]), name: str(l["name"]), subject: str(l["subject"]), text };
      } else {
        t.message = { ...t.message, from: str(l["from"]) };
      }
      t.version = num(l["version"]);
      t.applied = l["applied"] !== false;
      t.linkedBy = str(l["linked_by"]);
      t.urgency = str(l["urgency"]);
      t.nextStep = str(l["next_step"]);
      t.status = str(l["status"]);
      t.waitingOn = str(l["waiting_on"]);
      t.changed = strs(l["changed"]);
      t.why = str(l["why"]);
      t.floor = strs(l["floor"]);
      t.roleGuard = l["role_guard"] === true;
      t.needsReview = l["needs_review"] === true;
      continue;
    }
    if (l.kind === "action.queued") {
      const id = str(l["action_id"]) ?? `?${actions.size}`;
      const a: ActionView = {
        id, action: str(l["action"]) ?? "?", to: str(l["to"]), reasons: strs(l["reasons"]), body: l["body"], outcomes: [],
      };
      actions.set(id, a);
      turnOf(caseId, eventId, l.ts).actions.push(a);
      continue;
    }
    if (OUTCOMES.has(l.kind)) {
      const id = str(l["action_id"]) ?? "?";
      let a = actions.get(id);
      if (!a) {
        // Queued in an earlier run (the sender recovered it): show it where it belongs.
        a = { id, action: str(l["action"]) ?? "?", to: str(l["to"]), reasons: [], body: l["body"], outcomes: [] };
        actions.set(id, a);
        turnOf(caseId, eventId, l.ts).actions.push(a);
      }
      a.outcomes.push({ kind: l.kind.slice("action.".length), detail: outcomeDetail(l) });
      continue;
    }
    if (l.kind === "speak.loop_guard") {
      turnOf(caseId, eventId, l.ts).notes.push(`loop guard: no message to ${str(l["to"]) ?? "?"} (${strs(l["reasons"]).join(", ")}); needs review`);
      continue;
    }
    if (l.kind === "action.skipped") {
      turnOf(caseId, eventId, l.ts).notes.push(`${str(l["action"]) ?? "?"} skipped: ${str(l["reason"]) ?? "?"}`);
      continue;
    }
    if (l.kind === "event.duplicate") {
      turnOf(caseId, eventId, l.ts).notes.push("delivered again: skipped (already a version of this case)");
      continue;
    }
    other.push(l);
  }

  return { run, cases: [...cases.values()], other, counts, badLines };
}

// ---------- rendering ----------

export interface RenderOptions {
  /** Do not cut message texts. */
  full?: boolean;
  /** Show only cases whose id starts with this (with or without "case_"). */
  caseFilter?: string;
  /** Default 300. */
  maxText?: number;
}

const shortCase = (id: string) => id.replace(/^case_/, "").slice(0, 8);
const time = (ts: string) => ts.slice(11, 19);

function quote(text: string, indent: string, o: RenderOptions): string {
  if (o.full) return text.split("\n").map((l) => `${indent}│ ${l}`).join("\n");
  const flat = text.replace(/\s+/g, " ").trim();
  const max = o.maxText ?? 300;
  return `${indent}"${flat.length > max ? flat.slice(0, max) + "…" : flat}"`;
}

function actionLine(a: ActionView, i: string, o: RenderOptions): string[] {
  const result = a.outcomes.length
    ? a.outcomes.map((x) => (x.kind === "sent" ? "sent ✓" : x.kind.toUpperCase() + " ✗") + (x.detail ? ` (${x.detail})` : "")).join(" → ")
    : "NOT SENT (no outcome in this trace)";
  const body = isObj(a.body) ? a.body : {};
  if (a.action === "msg_send") {
    const out = [`${i}→ message to ${a.to ?? "?"}${a.reasons.length ? ` [${a.reasons.join(", ")}]` : ""}: ${result}`];
    const text = str(body["body"]);
    if (text) out.push(quote(text, i + "    ", o));
    return out;
  }
  if (a.action === "case_open") return [`${i}→ POST /cases (${str(body["urgency"]) ?? "?"}): ${result}`];
  if (a.action === "case_patch") {
    const fields = Object.entries(body).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
    return [`${i}→ PATCH /cases ${fields}: ${result}`];
  }
  return [`${i}→ ${a.action}: ${result}`];
}

function turnLines(t: Turn, o: RenderOptions): string[] {
  const i = "     ";
  const m = t.message;
  const who = [m.role, m.from, m.name ? `(${m.name})` : null].filter(Boolean).join(" ");
  const out = [`  [${t.eventId}] ${time(t.ts)}  IN from ${who || "?"}${m.subject ? ` · subject "${m.subject}"` : ""}`];
  out.push(m.text !== null ? quote(m.text, i, o) : `${i}(message text not in this trace)`);
  if (t.version !== null) {
    const link = t.linkedBy === "new" ? "new case" : `joined case (${t.linkedBy ?? "?"})`;
    out.push(`${i}→ v${t.version} ${link}${t.applied ? "" : " NOT APPLIED"}: urgency ${t.urgency} · next ${t.nextStep} · status ${t.status} · waiting on ${t.waitingOn}`);
    const flags = [
      t.floor.length ? `safety floor: ${t.floor.join(", ")}` : null,
      t.roleGuard ? "role guard: next step and state kept" : null,
      t.needsReview ? "NEEDS REVIEW" : null,
      t.version > 1 && t.changed.length ? `changed: ${t.changed.join(", ")}` : null,
    ].filter(Boolean);
    if (flags.length) out.push(`${i}  ${flags.join(" · ")}`);
    if (t.why) out.push(`${i}  why: ${t.why}`);
  }
  for (const a of t.actions) out.push(...actionLine(a, i, o));
  if (t.version !== null && !t.actions.some((a) => a.action === "msg_send")) out.push(`${i}→ no reply`);
  for (const n of t.notes) out.push(`${i}! ${n}`);
  return out;
}

export function summarize(s: RunStory): string[] {
  const c = (k: string) => s.counts[k] ?? 0;
  const run = s.run;
  const out: string[] = [];
  if (run) {
    out.push(
      `RUN ${str(run["run"]) ?? "?"}  model ${str(run["model"]) ?? "?"}  prompts ${str(run["prompt"]) ?? "?"}, ${str(run["reply_prompt"]) ?? "?"}  world ${str(run["base_url"]) ?? "?"}`,
    );
  }
  out.push(
    `messages handled ${c("case.version")} · ignored events ${c("event.ignored")} · unlinked ${c("message.unlinked")} · failed events ${c("event.failed")}`,
    `actions queued ${c("action.queued")} · sent ${c("action.sent")} · deferred ${c("action.deferred")} · failed ${c("action.failed")} · unknown ${c("action.unknown")}`,
    `cases ${s.cases.length}${s.badLines ? ` · ${s.badLines} unreadable trace lines` : ""}`,
  );
  return out;
}

export function renderStory(s: RunStory, o: RenderOptions = {}): string {
  const out = summarize(s);
  const filter = o.caseFilter?.replace(/^case_/, "");
  const cases = filter ? s.cases.filter((c) => c.caseId.replace(/^case_/, "").startsWith(filter)) : s.cases;
  for (const c of cases) {
    const last = [...c.turns].reverse().find((t) => t.version !== null);
    const now = last ? `now ${last.urgency} · ${last.status} · waiting on ${last.waitingOn} (v${last.version})` : "";
    out.push("", `═══ CASE ${shortCase(c.caseId)}  "${c.title ?? "?"}"  ${c.propertyId ?? ""}  ${now}`.trimEnd());
    for (const t of c.turns) out.push(...turnLines(t, o));
  }
  if (!filter && s.other.length) {
    out.push("", "═══ NOT ON A CASE");
    const ignored = new Map<string, number>();
    for (const l of s.other) {
      if (l.kind === "event.ignored") {
        const key = `${str(l["type"]) ?? "?"}: ${str(l["reason"]) ?? "?"}`;
        ignored.set(key, (ignored.get(key) ?? 0) + 1);
        continue;
      }
      const id = str(l["event_id"]);
      const detail = str(l["error"]) ?? str(l["note"]) ?? str(l["text"]) ?? "";
      out.push(`  ${time(l.ts)} ${l.kind}${id ? ` [${id}]` : ""}${str(l["from"]) ? ` from ${str(l["from"])}` : ""}: ${detail.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    for (const [k, n] of ignored) out.push(`  ignored ×${n}  ${k}`);
  }
  return out.join("\n");
}
