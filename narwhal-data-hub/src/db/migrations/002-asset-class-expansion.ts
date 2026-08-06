import type { Migration } from "../migrator.js";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Idempotency helpers
// ---------------------------------------------------------------------------

/** Return true when the DDL for `table` already contains `token`. */
function sqlHas(db: Database.Database, table: string, token: string): boolean {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=? AND sql IS NOT NULL"
    )
    .get(table) as { sql: string } | undefined;
  return row !== undefined && row.sql.includes(token);
}

/** Save and return all CREATE INDEX statements for a table. */
function saveIndexes(db: Database.Database, table: string): string[] {
  const rows = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL"
    )
    .all(table) as { sql: string }[];
  return rows.map((r) => r.sql);
}

// ---------------------------------------------------------------------------
// Table recreation helpers
// ---------------------------------------------------------------------------

function recreateInstruments(db: Database.Database): void {
  const indexes = saveIndexes(db, "instruments");

  db.exec(`
    CREATE TABLE instruments_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      mic             TEXT NOT NULL,
      venue_symbol    TEXT NOT NULL,
      asset_class     TEXT NOT NULL CHECK(asset_class IN ('stock', 'commodity_future', 'cash', 'loan', 'digital_asset')),
      currency        TEXT NOT NULL,
      cdm_json        TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      effective_from  TEXT NOT NULL,
      effective_to    TEXT,
      recorded_from   TEXT NOT NULL,
      recorded_to     TEXT,
      source_id       INTEGER REFERENCES sources(id),
      ingest_run_id   INTEGER REFERENCES ingest_runs(id)
    )
  `);

  db.exec(`INSERT INTO instruments_new SELECT * FROM instruments`);
  db.exec(`DROP TABLE instruments`);
  db.exec(`ALTER TABLE instruments_new RENAME TO instruments`);

  for (const sql of indexes) {
    db.exec(sql);
  }
}

function recreateIngestRuns(db: Database.Database): void {
  const indexes = saveIndexes(db, "ingest_runs");

  db.exec(`
    CREATE TABLE ingest_runs_new (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      venue               TEXT NOT NULL,
      window_start        TEXT,
      window_end          TEXT,
      file_hash           TEXT,
      file_name           TEXT,
      records_total       INTEGER NOT NULL DEFAULT 0,
      records_added       INTEGER NOT NULL DEFAULT 0,
      records_updated     INTEGER NOT NULL DEFAULT 0,
      records_delisted    INTEGER NOT NULL DEFAULT 0,
      records_quarantined INTEGER NOT NULL DEFAULT 0,
      outcome             TEXT NOT NULL CHECK(outcome IN ('success', 'partial', 'quarantined', 'failed', 'unavailable', 'static_load')),
      error_message       TEXT,
      run_started_at      TEXT NOT NULL,
      run_completed_at    TEXT
    )
  `);

  db.exec(`INSERT INTO ingest_runs_new SELECT * FROM ingest_runs`);
  db.exec(`DROP TABLE ingest_runs`);
  db.exec(`ALTER TABLE ingest_runs_new RENAME TO ingest_runs`);

  for (const sql of indexes) {
    db.exec(sql);
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export const migration002: Migration = {
  version: 2,
  name: "asset-class-expansion",
  up(db): void {
    const needInstruments =
      !sqlHas(db, "instruments", "'cash'") ||
      !sqlHas(db, "instruments", "'loan'") ||
      !sqlHas(db, "instruments", "'digital_asset'");

    const needIngestRuns = !sqlHas(db, "ingest_runs", "'static_load'");

    if (!needInstruments && !needIngestRuns) return;

    db.transaction(() => {
      db.exec(`PRAGMA foreign_keys = OFF`);

      if (needInstruments) recreateInstruments(db);
      if (needIngestRuns) recreateIngestRuns(db);

      db.exec(`PRAGMA foreign_keys = ON`);
    })();
  },
};
