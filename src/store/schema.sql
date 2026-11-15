-- Agent state. Written to run on both SQLite and Postgres: no SQLite-only types,
-- ON CONFLICT instead of INSERT OR IGNORE, TEXT timestamps in ISO 8601.

-- Single-row table: where we are in GET /events.
CREATE TABLE IF NOT EXISTS event_cursor (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  value  BIGINT  NOT NULL
);

-- Transactional inbox: every event we fetched, stored in the same transaction as the cursor.
-- status: pending -> done | failed. A crash mid-processing leaves it pending (at-least-once).
CREATE TABLE IF NOT EXISTS inbox (
  id           TEXT    PRIMARY KEY,   -- event id from the world, e.g. evt_42
  cursor       BIGINT  NOT NULL,
  type         TEXT    NOT NULL,
  raw          TEXT    NOT NULL,      -- the event as JSON, exactly as received
  status       TEXT    NOT NULL DEFAULT 'pending',
  error        TEXT,
  received_at  TEXT    NOT NULL,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox (status, cursor);

-- People we have heard from. The API has no actor directory, so we learn them from events
-- (a stand-in for the user database a real deployment would have).
CREATE TABLE IF NOT EXISTS actors (
  id           TEXT PRIMARY KEY,      -- actor.id from the event
  role         TEXT NOT NULL,         -- tenant | landlord | contractor | ...
  name         TEXT NOT NULL,
  property_id  TEXT,                  -- from the message payload, when it has one
  first_event  TEXT NOT NULL          -- inbox.id where we first saw them
);

-- Our view of each case: the LATEST version, one row per case. History is in case_versions.
-- Enums are kept as TEXT; the allowed values live in src/case.ts.
CREATE TABLE IF NOT EXISTS cases (
  id              TEXT    PRIMARY KEY,  -- ours, case_<uuid>
  dwelly_case_id  TEXT,                 -- null until POST /cases succeeds (rung 3)
  property_id     TEXT,
  reporter        TEXT,                 -- actors.id
  status          TEXT    NOT NULL,     -- Dwelly's Case.status: open|in_progress|resolved|closed
  waiting_on      TEXT    NOT NULL,     -- tenant|landlord|contractor|external|none
  outcome         TEXT,                 -- set on close
  urgency         TEXT    NOT NULL,     -- low|medium|high|emergency
  next_step       TEXT    NOT NULL,
  contractor_id   TEXT,                 -- null until rung 4 assigns one
  title           TEXT    NOT NULL,
  summary         TEXT    NOT NULL,     -- the case's memory, rewritten each version
  open_questions  TEXT    NOT NULL,     -- JSON array of strings
  needs_review    INTEGER NOT NULL,     -- 1: the model's output stayed invalid
  version         INTEGER NOT NULL,     -- = latest case_versions.version
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_property ON cases (property_id, status);

-- Append-only history: every event that touches a case writes a version, even when nothing
-- changes. Same columns as cases, plus why the version exists.
-- UNIQUE (case_id, cause_id): a redelivered event (at-least-once) cannot apply twice.
CREATE TABLE IF NOT EXISTS case_versions (
  case_id         TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  cause_kind      TEXT    NOT NULL,     -- event | action
  cause_id        TEXT    NOT NULL,     -- inbox.id, or our own action id
  changed         TEXT    NOT NULL,     -- comma-separated field names, e.g. urgency,next_step
  why             TEXT    NOT NULL,     -- the model's reason, or the safety rule that fired
  dwelly_case_id  TEXT,
  property_id     TEXT,
  reporter        TEXT,
  status          TEXT    NOT NULL,
  waiting_on      TEXT    NOT NULL,
  outcome         TEXT,
  urgency         TEXT    NOT NULL,
  next_step       TEXT    NOT NULL,
  contractor_id   TEXT,
  title           TEXT    NOT NULL,
  summary         TEXT    NOT NULL,
  open_questions  TEXT    NOT NULL,
  needs_review    INTEGER NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,     -- when this version was written
  PRIMARY KEY (case_id, version),
  UNIQUE (case_id, cause_id)
);

-- Outbox (rung 3): world-changing calls we decided to make, written in the SAME transaction
-- as the case version that caused them, before any HTTP call. POST /cases is not idempotent,
-- so a row left in 'sending' after a crash means "outcome unknown", not "send again".
-- Order within a case: (case_version, seq). The Dwelly id of a case lives on the case.
CREATE TABLE IF NOT EXISTS actions (
  id            TEXT    PRIMARY KEY,   -- act_<uuid>; the cause_id of the version a 201 writes
  case_id       TEXT    NOT NULL,      -- cases.id
  case_version  INTEGER NOT NULL,      -- the version that queued it
  seq           INTEGER NOT NULL,      -- position among that version's actions
  event_id      TEXT    NOT NULL,      -- inbox.id that caused it
  kind          TEXT    NOT NULL,      -- case_open | case_patch | msg_send
  body          TEXT    NOT NULL,      -- JSON request body (CaseCreate / CasePatch)
  status        TEXT    NOT NULL,      -- pending | sending | sent | unknown | failed | held (loop guard)
  attempts      INTEGER NOT NULL,
  result_id     TEXT,                  -- Dwelly case id from a 201
  error         TEXT,
  created_at    TEXT    NOT NULL,
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS actions_status ON actions (status, created_at);
CREATE INDEX IF NOT EXISTS actions_case ON actions (case_id, case_version, seq);
