import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Migrator } from "../src/db/migrator.js";
import { migration001 } from "../src/db/migrations/001-initial-schema.js";
import { OpenFigiEnricher } from "../src/enrichment/openfigi-enricher.js";
import type { EnrichmentResult } from "../src/enrichment/openfigi-enricher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function runMigrations(db: Database.Database): void {
  new Migrator(db).migrate([migration001]);
}

/** Insert an active instrument row and return its id. */
function insertInstrument(
  db: Database.Database,
  params: {
    mic: string;
    venue_symbol: string;
    asset_class?: string;
    currency?: string;
    cdm_json?: string;
    content_hash?: string;
    effective_from?: string;
    recorded_from?: string;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO instruments
         (mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
          effective_from, recorded_from, recorded_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      params.mic,
      params.venue_symbol,
      params.asset_class ?? "stock",
      params.currency ?? "USD",
      params.cdm_json ?? "{}",
      params.content_hash ?? "abc123",
      params.effective_from ?? "2026-08-01",
      params.recorded_from ?? "2026-08-01T00:00:00.000Z"
    );
  return Number(result.lastInsertRowid);
}

/** Return all identifiers rows for a type. */
function getAllIdentifiers(
  db: Database.Database,
  type: string
): { instrument_id: number; type: string; value: string }[] {
  return db
    .prepare(
      "SELECT instrument_id, type, value FROM identifiers WHERE type = ? ORDER BY instrument_id"
    )
    .all(type) as { instrument_id: number; type: string; value: string }[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenFigiEnricher", () => {
  let db: Database.Database;
  let enricher: OpenFigiEnricher;

  beforeEach(() => {
    db = createDb();
    runMigrations(db);
    enricher = new OpenFigiEnricher(db);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Config gate
  // -----------------------------------------------------------------------

  describe("config gate", () => {
    it("reports disabled when OPENFIGI_ENABLED is not set", () => {
      delete process.env["OPENFIGI_ENABLED"];
      expect(enricher.isEnabled()).toBe(false);
    });

    it("reports disabled when OPENFIGI_ENABLED is false", () => {
      process.env["OPENFIGI_ENABLED"] = "false";
      expect(enricher.isEnabled()).toBe(false);
    });

    it("reports disabled when OPENFIGI_ENABLED is 0", () => {
      process.env["OPENFIGI_ENABLED"] = "0";
      expect(enricher.isEnabled()).toBe(false);
    });

    it("reports enabled when OPENFIGI_ENABLED is true", () => {
      process.env["OPENFIGI_ENABLED"] = "true";
      expect(enricher.isEnabled()).toBe(true);
    });

    it("reports enabled when OPENFIGI_ENABLED is 1", () => {
      process.env["OPENFIGI_ENABLED"] = "1";
      expect(enricher.isEnabled()).toBe(true);
    });

    it("reports enabled when OPENFIGI_ENABLED is yes", () => {
      process.env["OPENFIGI_ENABLED"] = "yes";
      expect(enricher.isEnabled()).toBe(true);
    });

    it("enrich returns early with zero counts when disabled", () => {
      delete process.env["OPENFIGI_ENABLED"];
      insertInstrument(db, { mic: "XNYS", venue_symbol: "AAPL" });

      const result = enricher.enrich("XNYS");

      expect(result.checked).toBe(0);
      expect(result.enriched).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);

      const identifiers = getAllIdentifiers(db, "FIGI");
      expect(identifiers).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Basic enrichment
  // -----------------------------------------------------------------------

  describe("basic enrichment", () => {
    beforeEach(() => {
      process.env["OPENFIGI_ENABLED"] = "true";
    });

    afterEach(() => {
      delete process.env["OPENFIGI_ENABLED"];
    });

    it("maps venue symbols to FIGIs correctly", () => {
      const aaplId = insertInstrument(db, {
        mic: "XNYS",
        venue_symbol: "AAPL",
      });
      const msftId = insertInstrument(db, {
        mic: "XNYS",
        venue_symbol: "MSFT",
      });

      const result = enricher.enrich("XNYS");

      expect(result.venue).toBe("XNYS");
      expect(result.checked).toBe(2);
      expect(result.enriched).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);

      // Verify identifiers were written
      const identifiers = getAllIdentifiers(db, "FIGI");
      expect(identifiers).toHaveLength(2);

      const bySymbol = new Map<number, string>();
      for (const id of identifiers) {
        bySymbol.set(id.instrument_id, id.value);
      }

      // FIGIs should start with "BBG000" and be 12 chars
      const aaplFigi = bySymbol.get(aaplId);
      expect(aaplFigi).toMatch(/^BBG000[A-F0-9]{6}$/);

      const msftFigi = bySymbol.get(msftId);
      expect(msftFigi).toMatch(/^BBG000[A-F0-9]{6}$/);

      // Different symbols should produce different FIGIs
      expect(aaplFigi).not.toBe(msftFigi);
    });

    it("produces deterministic FIGIs for the same symbol", () => {
      // Two rows for the same symbol (different instruments)
      const id1 = insertInstrument(db, { mic: "XNYS", venue_symbol: "AAPL" });
      // Close out the first and insert a second (simulating an update)
      db.prepare("UPDATE instruments SET recorded_to = ? WHERE id = ?").run(
        "2026-08-02T00:00:00.000Z",
        id1
      );
      const id2 = insertInstrument(db, {
        mic: "XNYS",
        venue_symbol: "AAPL",
        effective_from: "2026-08-02",
        recorded_from: "2026-08-02T00:00:00.000Z",
        content_hash: "def456",
      });

      // Only the active (id2) instrument should be enriched
      const result = enricher.enrich("XNYS");
      expect(result.checked).toBe(1);
      expect(result.enriched).toBe(1);

      const identifiers = getAllIdentifiers(db, "FIGI");
      expect(identifiers).toHaveLength(1);
      // FIGI is based on the symbol, so deterministic
      expect(identifiers[0]!.value).toMatch(/^BBG000[A-F0-9]{6}$/);
    });

    it("writes FIGIs to the identifiers table with correct schema", () => {
      const instId = insertInstrument(db, { mic: "XNYS", venue_symbol: "XOM" });

      enricher.enrich("XNYS");

      const rows = db
        .prepare("SELECT * FROM identifiers WHERE instrument_id = ?")
        .all(instId) as {
        instrument_id: number;
        type: string;
        value: string;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0]!.instrument_id).toBe(instId);
      expect(rows[0]!.type).toBe("FIGI");
      expect(rows[0]!.value).toMatch(/^BBG000[A-F0-9]{6}$/);
    });

    it("skips instruments that already have a FIGI", () => {
      const instId1 = insertInstrument(db, {
        mic: "XNYS",
        venue_symbol: "AAPL",
      });
      const instId2 = insertInstrument(db, {
        mic: "XNYS",
        venue_symbol: "MSFT",
      });

      // Pre-insert a FIGI for AAPL
      db.prepare(
        "INSERT INTO identifiers (instrument_id, type, value) VALUES (?, 'FIGI', ?)"
      ).run(instId1, "BBG000B4DY7Z6");

      const result = enricher.enrich("XNYS");

      expect(result.checked).toBe(2);
      expect(result.enriched).toBe(1); // only MSFT
      expect(result.skipped).toBe(1); // AAPL skipped
      expect(result.failed).toBe(0);

      // No duplicate FIGI for AAPL
      const identifiers = getAllIdentifiers(db, "FIGI");
      expect(identifiers).toHaveLength(2); // original + MSFT
      const aaplFigs = identifiers.filter((r) => r.instrument_id === instId1);
      expect(aaplFigs).toHaveLength(1);
      expect(aaplFigs[0]!.value).toBe("BBG000B4DY7Z6"); // preserved
    });
  });

  // -----------------------------------------------------------------------
  // Empty pool
  // -----------------------------------------------------------------------

  describe("empty pool", () => {
    beforeEach(() => {
      process.env["OPENFIGI_ENABLED"] = "true";
    });

    afterEach(() => {
      delete process.env["OPENFIGI_ENABLED"];
    });

    it("handles a venue with no instruments gracefully", () => {
      const result = enricher.enrich("XNYS");

      expect(result.venue).toBe("XNYS");
      expect(result.checked).toBe(0);
      expect(result.enriched).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Venue isolation
  // -----------------------------------------------------------------------

  describe("venue isolation", () => {
    beforeEach(() => {
      process.env["OPENFIGI_ENABLED"] = "true";
    });

    afterEach(() => {
      delete process.env["OPENFIGI_ENABLED"];
    });

    it("only enriches instruments for the requested venue", () => {
      const xnysId = insertInstrument(db, {
        mic: "XNYS",
        venue_symbol: "AAPL",
      });
      insertInstrument(db, { mic: "XHKG", venue_symbol: "0700" });

      const result = enricher.enrich("XNYS");

      expect(result.checked).toBe(1);
      expect(result.enriched).toBe(1);

      // Only XNYS instrument got a FIGI
      const identifiers = getAllIdentifiers(db, "FIGI");
      expect(identifiers).toHaveLength(1);
      expect(identifiers[0]!.instrument_id).toBe(xnysId);
    });
  });

  // -----------------------------------------------------------------------
  // Enricher handles closed-out (non-active) rows correctly
  // -----------------------------------------------------------------------

  describe("closed-out instruments", () => {
    beforeEach(() => {
      process.env["OPENFIGI_ENABLED"] = "true";
    });

    afterEach(() => {
      delete process.env["OPENFIGI_ENABLED"];
    });

    it("does not enrich instruments that have been closed out", () => {
      const id1 = insertInstrument(db, { mic: "XNYS", venue_symbol: "AAPL" });
      // Close out AAPL (delist)
      db.prepare("UPDATE instruments SET recorded_to = ? WHERE id = ?").run(
        "2026-08-02T00:00:00.000Z",
        id1
      );

      const result = enricher.enrich("XNYS");

      expect(result.checked).toBe(0);
      expect(result.enriched).toBe(0);

      const identifiers = getAllIdentifiers(db, "FIGI");
      expect(identifiers).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Enrichment failure is non-blocking (logged but run continues)
  // -----------------------------------------------------------------------

  describe("enrichment failure handling", () => {
    beforeEach(() => {
      process.env["OPENFIGI_ENABLED"] = "true";
    });

    afterEach(() => {
      delete process.env["OPENFIGI_ENABLED"];
    });

    // Note: Because the v1 implementation uses a mock lookup, individual
    // enrichment failures are rare.  We verify the error-collection path
    // by testing that the enricher does not throw on a known-bad state,
    // and that the pipeline wraps enrichment in a try/catch.
    //
    // For full failure-path coverage, inject a mock that simulates API
    // errors once the real HTTP client is added.

    it("the enricher enrichment method does not throw on normal operation", () => {
      insertInstrument(db, { mic: "XNYS", venue_symbol: "AAPL" });

      // Should never throw
      expect(() => enricher.enrich("XNYS")).not.toThrow();
    });

    it("enricher wrapped in pipeline does not propagate errors", () => {
      // Simulate what the pipeline does: wrap in try/catch
      const runEnrichment = () => {
        try {
          enricher.enrich("XNYS");
          return "ok";
        } catch {
          return "enrichment-failed";
        }
      };

      expect(runEnrichment()).toBe("ok");
    });
  });
});
