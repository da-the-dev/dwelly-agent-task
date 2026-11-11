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
