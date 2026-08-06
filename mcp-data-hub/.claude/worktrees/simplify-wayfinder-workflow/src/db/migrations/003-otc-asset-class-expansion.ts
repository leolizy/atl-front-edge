import type { Migration } from "../migrator.js";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Idempotency helpers (same pattern as migration 002)
// ---------------------------------------------------------------------------

function sqlHas(db: Database.Database, table: string, token: string): boolean {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=? AND sql IS NOT NULL"
    )
    .get(table) as { sql: string } | undefined;
  return row !== undefined && row.sql.includes(token);
}

function saveIndexes(db: Database.Database, table: string): string[] {
  const rows = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL"
    )
    .all(table) as { sql: string }[];
  return rows.map((r) => r.sql);
}

function recreateInstruments(db: Database.Database): void {
  const indexes = saveIndexes(db, "instruments");

  db.exec(`
    CREATE TABLE instruments_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      mic             TEXT NOT NULL,
      venue_symbol    TEXT NOT NULL,
      asset_class     TEXT NOT NULL CHECK(asset_class IN ('stock', 'commodity_future', 'cash', 'loan', 'digital_asset', 'listed_derivative', 'interest_rate_derivative', 'credit_derivative', 'fx_derivative', 'equity_derivative')),
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

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export const migration003: Migration = {
  version: 3,
  name: "otc-asset-class-expansion",
  up(db): void {
    const needsExpansion =
      !sqlHas(db, "instruments", "'listed_derivative'") ||
      !sqlHas(db, "instruments", "'interest_rate_derivative'") ||
      !sqlHas(db, "instruments", "'credit_derivative'") ||
      !sqlHas(db, "instruments", "'fx_derivative'") ||
      !sqlHas(db, "instruments", "'equity_derivative'");

    if (!needsExpansion) return;

    db.transaction(() => {
      db.exec(`PRAGMA foreign_keys = OFF`);
      recreateInstruments(db);
      db.exec(`PRAGMA foreign_keys = ON`);
    })();
  },
};
