import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { WorldEvent } from "../api/types.js";
import type { CaseRecord, CaseVersion } from "../case.js";
import type { Actor, InboxStatus, Store } from "./store.js";

// Resolves to <repo>/src/store/schema.sql both from dist/store/ (built) and src/store/ (vitest).
const SCHEMA = readFileSync(new URL("../../src/store/schema.sql", import.meta.url), "utf8");

// Columns shared by cases and case_versions, in one order, so the two stay in step.
const CASE_COLS = [
  "dwelly_case_id", "property_id", "reporter", "status", "waiting_on", "outcome", "urgency", "next_step",
  "contractor_id", "title", "summary", "open_questions", "needs_review", "created_at", "updated_at",
] as const;

type Row = Record<string, SQLInputValue>;

function caseValues(c: CaseRecord): SQLInputValue[] {
  return [
    c.dwellyCaseId, c.propertyId, c.reporter, c.status, c.waitingOn, c.outcome, c.urgency, c.nextStep,
    c.contractorId, c.title, c.summary, JSON.stringify(c.openQuestions), c.needsReview ? 1 : 0,
    c.createdAt, c.updatedAt,
  ];
}

function toCase(r: Row, version: number): CaseRecord {
  const s = (k: string) => (r[k] == null ? null : String(r[k]));
  return {
    id: String(r["id"] ?? r["case_id"]),
    dwellyCaseId: s("dwelly_case_id"),
    propertyId: s("property_id"),
    reporter: s("reporter"),
    status: String(r["status"]) as CaseRecord["status"],
    waitingOn: String(r["waiting_on"]) as CaseRecord["waitingOn"],
    outcome: s("outcome") as CaseRecord["outcome"],
    urgency: String(r["urgency"]) as CaseRecord["urgency"],
    nextStep: String(r["next_step"]) as CaseRecord["nextStep"],
    contractorId: s("contractor_id"),
    title: String(r["title"]),
    summary: String(r["summary"]),
    openQuestions: JSON.parse(String(r["open_questions"])) as string[],
    needsReview: Number(r["needs_review"]) === 1,
    version,
    createdAt: String(r["created_at"]),
    updatedAt: String(r["updated_at"]),
  };
}

function toVersion(r: Row): CaseVersion {
  return {
    ...toCase(r, Number(r["version"])),
    causeKind: String(r["cause_kind"]) as CaseVersion["causeKind"],
    causeId: String(r["cause_id"]),
    changed: String(r["changed"]) ? String(r["changed"]).split(",") : [],
    why: String(r["why"]),
  };
}

/** path ":memory:" for tests. */
export function openSqliteStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);

  const getCursor = db.prepare("SELECT value FROM event_cursor WHERE id = 1");
  const setCursor = db.prepare(
    "INSERT INTO event_cursor (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value",
  );
  const insert = db.prepare(
    "INSERT INTO inbox (id, cursor, type, raw, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
  );
  const pending = db.prepare("SELECT raw FROM inbox WHERE status = 'pending' ORDER BY cursor LIMIT ?");
  const mark = db.prepare("UPDATE inbox SET status = ?, error = ?, processed_at = ? WHERE id = ?");

  const upsertActor = db.prepare(
    `INSERT INTO actors (id, role, name, property_id, first_event) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET role = excluded.role, name = excluded.name,
       property_id = COALESCE(excluded.property_id, actors.property_id)`,
  );
  const getActor = db.prepare("SELECT id, role, name, property_id FROM actors WHERE id = ?");
  const getCase = db.prepare("SELECT * FROM cases WHERE id = ?");
  const findOpenCase = db.prepare(
    `SELECT * FROM cases WHERE property_id = ? AND status NOT IN ('resolved', 'closed')
     ORDER BY updated_at DESC LIMIT 1`,
  );
  const insertVersion = db.prepare(
    `INSERT INTO case_versions (case_id, version, cause_kind, cause_id, changed, why, ${CASE_COLS.join(", ")})
     VALUES (${Array(6 + CASE_COLS.length).fill("?").join(", ")})
     ON CONFLICT (case_id, cause_id) DO NOTHING`,
  );
  const upsertCase = db.prepare(
    `INSERT INTO cases (id, version, ${CASE_COLS.join(", ")})
     VALUES (${Array(2 + CASE_COLS.length).fill("?").join(", ")})
     ON CONFLICT (id) DO UPDATE SET version = excluded.version,
       ${CASE_COLS.map((c) => `${c} = excluded.${c}`).join(", ")}`,
  );
  const history = db.prepare("SELECT * FROM case_versions WHERE case_id = ? ORDER BY version");
  const byDwellyId = db.prepare("SELECT * FROM cases WHERE dwelly_case_id = ?");
  const byCause = db.prepare("SELECT case_id FROM case_versions WHERE cause_id = ? LIMIT 1");

  return {
    async getCursor() {
      const row = getCursor.get() as { value: number } | undefined;
      return row ? Number(row.value) : 0;
    },
    async saveBatch(events: WorldEvent[], nextCursor: number) {
      const now = new Date().toISOString();
      let inserted = 0;
      db.exec("BEGIN");
      try {
        for (const e of events) {
          inserted += Number(insert.run(e.id, e.cursor, e.type, JSON.stringify(e), now).changes);
        }
        setCursor.run(nextCursor);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return inserted;
    },
    async pending(limit: number) {
      return (pending.all(limit) as { raw: string }[]).map((r) => JSON.parse(r.raw) as WorldEvent);
    },
    async mark(eventId: string, status: Exclude<InboxStatus, "pending">, error?: string) {
      mark.run(status, error ?? null, new Date().toISOString(), eventId);
    },

    async upsertActor(a: Actor, eventId: string) {
      upsertActor.run(a.id, a.role, a.name, a.propertyId, eventId);
    },
    async getActor(id: string) {
      const r = getActor.get(id) as Row | undefined;
      if (!r) return null;
      const propertyId = r["property_id"];
      return { id: String(r["id"]), role: String(r["role"]), name: String(r["name"]), propertyId: propertyId == null ? null : String(propertyId) };
    },
    async getCase(id: string) {
      const r = getCase.get(id) as Row | undefined;
      return r ? toCase(r, Number(r["version"])) : null;
    },
    async findOpenCase(propertyId: string) {
      const r = findOpenCase.get(propertyId) as Row | undefined;
      return r ? toCase(r, Number(r["version"])) : null;
    },
    async findCaseByDwellyId(dwellyCaseId: string) {
      const r = byDwellyId.get(dwellyCaseId) as Row | undefined;
      return r ? toCase(r, Number(r["version"])) : null;
    },
    async caseForCause(causeId: string) {
      const r = byCause.get(causeId) as Row | undefined;
      return r ? String(r["case_id"]) : null;
    },
    async saveCaseVersion(v: CaseVersion) {
      db.exec("BEGIN");
      try {
        const applied =
          Number(insertVersion.run(v.id, v.version, v.causeKind, v.causeId, v.changed.join(","), v.why, ...caseValues(v)).changes) === 1;
        if (applied) upsertCase.run(v.id, v.version, ...caseValues(v));
        db.exec("COMMIT");
        return { applied };
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async caseHistory(caseId: string) {
      return (history.all(caseId) as Row[]).map(toVersion);
    },

    async close() {
      db.close();
    },
  };
}
