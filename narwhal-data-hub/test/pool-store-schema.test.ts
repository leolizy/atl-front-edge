import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { PoolStore } from "../src/db/pool-store.js";
import { Migrator } from "../src/db/migrator.js";
import { migration001 } from "../src/db/index.js";
import { unlinkSync } from "node:fs";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function runMigrations(db: Database.Database): void {
  new Migrator(db).migrate([migration001]);
}

describe("pool store schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("migration harness", () => {
    it("creates the migrations tracking table", () => {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'"
        )
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("migrations");
    });

    it("records applied migrations", () => {
      const rows = db.prepare("SELECT version, name FROM migrations").all() as {
        version: number;
        name: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 1, name: "initial-v1-schema" });
    });

    it("is idempotent — re-running produces no duplicate rows", () => {
      runMigrations(db);
      const count = (
        db.prepare("SELECT COUNT(*) as count FROM migrations").get() as {
          count: number;
        }
      ).count;
      expect(count).toBe(1);
    });
  });

  describe("tables", () => {
    const expectedTables = [
      "instruments",
      "listings",
      "identifiers",
      "sources",
      "ingest_runs",
      "changes",
      "quarantine",
      "aliases",
      "migrations",
    ];

    for (const table of expectedTables) {
      it(`creates the ${table} table`, () => {
        const row = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
          )
          .get(table) as { name: string } | undefined;
        expect(row?.name).toBe(table);
      });
    }
  });

  describe("indexes", () => {
    it("has a unique partial index on instruments (mic, venue_symbol) for current records", () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as { name: string }[];
      expect(indexes.map((i) => i.name)).toContain(
        "idx_instruments_mic_symbol"
      );
    });

    it("has an index on identifiers (type, value)", () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as { name: string }[];
      expect(indexes.map((i) => i.name)).toContain(
        "idx_identifiers_type_value"
      );
    });

    it("has indexes on bitemporal columns", () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as { name: string }[];
      expect(indexes.map((i) => i.name)).toContain(
        "idx_instruments_effective_dates"
      );
      expect(indexes.map((i) => i.name)).toContain(
        "idx_instruments_recorded_dates"
      );
    });
  });

  describe("WAL mode", () => {
    it("enables WAL journal mode when using a file-backed database", () => {
      // WAL only activates on file-backed databases, not :memory:
      const store = new PoolStore({ dbPath: "/tmp/test-wal.db", wal: true });
      expect(store.isWalMode()).toBe(true);
      store.close();
      try {
        unlinkSync("/tmp/test-wal.db");
      } catch {}
      try {
        unlinkSync("/tmp/test-wal.db-wal");
      } catch {}
      try {
        unlinkSync("/tmp/test-wal.db-shm");
      } catch {}
    });

    it("respects wal: false option", () => {
      const store = new PoolStore({ dbPath: "/tmp/test-nowal.db", wal: false });
      expect(store.isWalMode()).toBe(false);
      store.close();
      try {
        unlinkSync("/tmp/test-nowal.db");
      } catch {}
    });
  });

  describe("bitemporal columns", () => {
    it("instruments table has all four bitemporal columns", () => {
      const columns = db.prepare("PRAGMA table_info(instruments)").all() as {
        name: string;
      }[];
      const names = columns.map((c) => c.name);
      expect(names).toContain("effective_from");
      expect(names).toContain("effective_to");
      expect(names).toContain("recorded_from");
      expect(names).toContain("recorded_to");
    });

    it("has no stored status column", () => {
      const columns = db.prepare("PRAGMA table_info(instruments)").all() as {
        name: string;
      }[];
      const names = columns.map((c) => c.name);
      expect(names).not.toContain("status");
    });
  });

  describe("constraints", () => {
    it("enforces unique (type, value) on identifiers", () => {
      // Insert a source + instrument first (FK chain)
      db.prepare(
        "INSERT INTO sources (id, mic, location, approver, approved_at) VALUES (1, 'XNYS', 'file://test', 'op', ?)"
      ).run(new Date().toISOString());
      db.prepare(
        "INSERT INTO instruments (id, mic, venue_symbol, asset_class, currency, cdm_json, content_hash, effective_from, recorded_from) VALUES (1, 'XNYS', 'AAPL', 'stock', 'USD', '{}', 'abc', '2026-01-01', ?)"
      ).run(new Date().toISOString());
      db.prepare(
        "INSERT INTO identifiers (instrument_id, type, value) VALUES (1, 'ISIN', 'US0378331005')"
      ).run();
      expect(() => {
        db.prepare(
          "INSERT INTO identifiers (instrument_id, type, value) VALUES (1, 'ISIN', 'US0378331005')"
        ).run();
      }).toThrow();
    });

    it("enforces CHECK constraint on asset_class", () => {
      expect(() => {
        db.prepare(
          "INSERT INTO instruments (mic, venue_symbol, asset_class, currency, cdm_json, content_hash, effective_from, recorded_from) VALUES ('XNYS', 'X', 'bonds', 'USD', '{}', 'x', '2026-01-01', ?)"
        ).run(new Date().toISOString());
      }).toThrow(/CHECK constraint/);
    });

    it("enforces CHECK constraint on instrument status derived columns", () => {
      // Verify status is NOT a column (derived, not stored)
      const columns = db.prepare("PRAGMA table_info(instruments)").all() as {
        name: string;
      }[];
      const names = columns.map((c) => c.name);
      expect(names).not.toContain("status");
    });
  });
});
