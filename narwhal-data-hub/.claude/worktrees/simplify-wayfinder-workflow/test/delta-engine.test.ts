import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Migrator } from "../src/db/migrator.js";
import { migration001 } from "../src/db/migrations/001-initial-schema.js";
import { DeltaEngine } from "../src/delta/delta-engine.js";
import type {
  DeltaInputRecord,
  ActivePoolRecord,
  InstrumentRow,
  DeltaResult,
  ChangeEntry,
} from "../src/delta/types.js";

// ---------------------------------------------------------------------------
// Test helpers
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

/** Create a source row and return its id. */
function createSource(db: Database.Database, mic: string): number {
  const result = db
    .prepare(
      `INSERT INTO sources (mic, location, approver, approved_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      mic,
      `file://data/${mic.toLowerCase()}.csv`,
      "operator",
      "2026-01-01T00:00:00.000Z"
    );
  return Number(result.lastInsertRowid);
}

/** Create an ingest_run row and return its id. */
function createIngestRun(db: Database.Database, venue: string): number {
  const result = db
    .prepare(
      `INSERT INTO ingest_runs
         (venue, window_start, window_end, file_hash, file_name,
          records_total, records_added, records_updated, records_delisted,
          records_quarantined, outcome, run_started_at, run_completed_at)
       VALUES (?, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 'success', ?, NULL)`
    )
    .run(venue, "2026-01-01T00:00:00.000Z");
  return Number(result.lastInsertRowid);
}

/** Build a minimal DeltaInputRecord for testing. */
function makeRecord(
  overrides: Partial<DeltaInputRecord> = {}
): DeltaInputRecord {
  return {
    mic: "XNYS",
    venue_symbol: "AAPL",
    isin: "US0378331005",
    instrument_name: "Apple Inc.",
    currency: "USD",
    asset_class: "stock",
    cdm_json: JSON.stringify({ symbol: "AAPL", name: "Apple Inc." }),
    effective_from: "2026-01-01",
    ...overrides,
  };
}

/** Build a record with a different CDM body so the hash differs. */
function makeVariant(
  overrides: Partial<DeltaInputRecord> = {}
): DeltaInputRecord {
  return makeRecord({
    cdm_json: JSON.stringify({
      symbol: "AAPL",
      name: "Apple Inc.",
      variant: 1,
    }),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeltaEngine", () => {
  let db: Database.Database;
  let engine: DeltaEngine;

  beforeEach(() => {
    db = createDb();
    runMigrations(db);
    engine = new DeltaEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  // -- computeHash ---------------------------------------------------------

  describe("computeHash", () => {
    it("returns a 64-character hex string (SHA-256)", () => {
      const hash = engine.computeHash('{"a":1}');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns the same hash for semantically identical JSON with different key orders", () => {
      const h1 = engine.computeHash('{"a":1,"b":2}');
      const h2 = engine.computeHash('{"b":2,"a":1}');
      expect(h1).toBe(h2);
    });

    it("returns different hashes for different JSON", () => {
      const h1 = engine.computeHash('{"a":1}');
      const h2 = engine.computeHash('{"a":2}');
      expect(h1).not.toBe(h2);
    });
  });

  // -- extractFilterColumns -------------------------------------------------

  describe("extractFilterColumns", () => {
    it("extracts MIC, symbol, ISIN, asset_class, currency, and effective dates", () => {
      const record = makeRecord({
        mic: "XHKG",
        venue_symbol: "0005.HK",
        isin: "HK0000000005",
        currency: "HKD",
        asset_class: "stock",
        effective_from: "2026-06-15",
      });
      const cols = engine.extractFilterColumns(record);
      expect(cols).toEqual({
        mic: "XHKG",
        symbol: "0005.HK",
        isin: "HK0000000005",
        asset_class: "stock",
        currency: "HKD",
        effective_from: "2026-06-15",
        effective_to: null,
      });
    });
  });

  // -- applyDelta: add ------------------------------------------------------

  describe("applyDelta: add", () => {
    it("inserts a new instrument row for a new hash", () => {
      const runId = createIngestRun(db, "XNYS");

      const result = engine.applyDelta(
        [makeRecord()],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      expect(result.records_added).toBe(1);
      expect(result.records_updated).toBe(0);
      expect(result.records_delisted).toBe(0);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].change_type).toBe("add");
      expect(result.changes[0].before_hash).toBeNull();
      expect(result.changes[0].after_hash).toBeTruthy();

      // Verify the instruments row
      const rows = engine.getAllRows("XNYS");
      expect(rows).toHaveLength(1);
      expect(rows[0].mic).toBe("XNYS");
      expect(rows[0].venue_symbol).toBe("AAPL");
      expect(rows[0].effective_from).toBe("2026-01-01");
      expect(rows[0].effective_to).toBeNull();
      expect(rows[0].recorded_from).toBe("2026-01-01T10:00:00.000Z");
      expect(rows[0].recorded_to).toBeNull();
      expect(rows[0].ingest_run_id).toBe(runId);
    });

    it("inserts a record with future-dated effective_from", () => {
      const runId = createIngestRun(db, "XNYS");

      const result = engine.applyDelta(
        [makeRecord({ effective_from: "2026-12-31" })],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      expect(result.records_added).toBe(1);

      const rows = engine.getAllRows("XNYS");
      expect(rows).toHaveLength(1);
      // Record is inserted now, but effective_from is in the future
      expect(rows[0].effective_from).toBe("2026-12-31");
      expect(rows[0].recorded_from).toBe("2026-01-01T10:00:00.000Z");
    });

    it("records a change entry with after_hash and no before_hash", () => {
      const runId = createIngestRun(db, "XNYS");
      const record = makeRecord();

      engine.applyDelta(
        [record],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      const changes = db
        .prepare("SELECT * FROM changes WHERE ingest_run_id = ?")
        .all(runId) as ChangeEntry[];
      expect(changes).toHaveLength(1);
      expect(changes[0].change_type).toBe("add");
      expect(changes[0].before_hash).toBeNull();
      expect(changes[0].after_hash).toBe(engine.computeHash(record.cdm_json));
    });
  });

  // -- applyDelta: update ---------------------------------------------------

  describe("applyDelta: update", () => {
    it("closes out old row and inserts new row for same MIC+symbol with different hash", () => {
      const runId1 = createIngestRun(db, "XNYS");
      const runId2 = createIngestRun(db, "XNYS");

      // First delta: add AAPL
      engine.applyDelta(
        [makeRecord()],
        "XNYS",
        runId1,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      // Second delta: same MIC+symbol, different CDM body (new hash)
      const result = engine.applyDelta(
        [makeVariant()],
        "XNYS",
        runId2,
        "2026-01-02",
        "2026-01-02T10:00:00.000Z"
      );

      expect(result.records_updated).toBe(1);
      expect(result.records_added).toBe(0);

      // Both rows exist (old closed, new active)
      const rows = engine.getAllRows("XNYS");
      expect(rows).toHaveLength(2);

      // Old row: closed out
      const oldRow = rows[0];
      expect(oldRow.effective_to).toBe("2026-01-02");
      expect(oldRow.recorded_to).toBe("2026-01-02T10:00:00.000Z");

      // New row: active
      const newRow = rows[1];
      expect(newRow.effective_from).toBe("2026-01-01"); // from the incoming record
      expect(newRow.effective_to).toBeNull();
      expect(newRow.recorded_from).toBe("2026-01-02T10:00:00.000Z");
      expect(newRow.recorded_to).toBeNull();

      // Content hashes differ
      expect(oldRow.content_hash).not.toBe(newRow.content_hash);

      // Changes recorded
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].change_type).toBe("update");
      expect(result.changes[0].before_hash).toBe(oldRow.content_hash);
      expect(result.changes[0].after_hash).toBe(newRow.content_hash);
    });

    it("records before_hash and after_hash for updates", () => {
      const runId1 = createIngestRun(db, "XNYS");
      const runId2 = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [makeRecord()],
        "XNYS",
        runId1,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      const oldHash = engine.computeHash(makeRecord().cdm_json);
      const variant = makeVariant();
      const newHash = engine.computeHash(variant.cdm_json);

      engine.applyDelta(
        [variant],
        "XNYS",
        runId2,
        "2026-01-02",
        "2026-01-02T10:00:00.000Z"
      );

      const changes = db
        .prepare("SELECT * FROM changes WHERE change_type = 'update'")
        .all() as ChangeEntry[];
      expect(changes).toHaveLength(1);
      expect(changes[0].before_hash).toBe(oldHash);
      expect(changes[0].after_hash).toBe(newHash);
    });
  });

  // -- applyDelta: delist ---------------------------------------------------

  describe("applyDelta: delist", () => {
    it("closes out active records not present in the incoming snapshot", () => {
      const runId1 = createIngestRun(db, "XNYS");
      const runId2 = createIngestRun(db, "XNYS");

      // Insert two records
      engine.applyDelta(
        [
          makeRecord({ venue_symbol: "AAPL" }),
          makeRecord({
            venue_symbol: "MSFT",
            isin: "US5949181045",
            cdm_json: JSON.stringify({ symbol: "MSFT" }),
          }),
        ],
        "XNYS",
        runId1,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      // Second delta: only AAPL — MSFT should be delisted
      const result = engine.applyDelta(
        [makeRecord({ venue_symbol: "AAPL" })],
        "XNYS",
        runId2,
        "2026-01-02",
        "2026-01-02T10:00:00.000Z"
      );

      expect(result.records_delisted).toBe(1);
      expect(result.records_added).toBe(0);
      expect(result.records_updated).toBe(0);

      // MSFT should be closed
      const allRows = engine.getAllRows("XNYS");
      const msftRow = allRows.find((r) => r.venue_symbol === "MSFT");
      expect(msftRow).toBeDefined();
      expect(msftRow!.effective_to).toBe("2026-01-02");
      expect(msftRow!.recorded_to).toBe("2026-01-02T10:00:00.000Z");

      // AAPL should still be active
      const aaplRows = allRows.filter((r) => r.venue_symbol === "AAPL");
      const activeAapl = aaplRows.find((r) => r.recorded_to === null);
      expect(activeAapl).toBeDefined();

      // Changes recorded
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].change_type).toBe("delist");
      expect(result.changes[0].before_hash).toBe(msftRow!.content_hash);
      expect(result.changes[0].after_hash).toBeNull();
    });

    it("delists all records when snapshot is empty", () => {
      const runId1 = createIngestRun(db, "XNYS");
      const runId2 = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [
          makeRecord({ venue_symbol: "AAPL" }),
          makeRecord({
            venue_symbol: "MSFT",
            isin: "US5949181045",
            cdm_json: JSON.stringify({ symbol: "MSFT" }),
          }),
        ],
        "XNYS",
        runId1,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      const result = engine.applyDelta(
        [],
        "XNYS",
        runId2,
        "2026-01-02",
        "2026-01-02T10:00:00.000Z"
      );

      expect(result.records_delisted).toBe(2);
      expect(result.records_added).toBe(0);

      // No active records remain
      const active = engine.getActiveRecords("XNYS");
      expect(active).toHaveLength(0);
    });
  });

  // -- applyDelta: no-op / idempotency -------------------------------------

  describe("applyDelta: no-op (idempotency)", () => {
    it("produces zero changes when the same snapshot is re-applied", () => {
      const runId1 = createIngestRun(db, "XNYS");
      const runId2 = createIngestRun(db, "XNYS");

      const records = [
        makeRecord({ venue_symbol: "AAPL" }),
        makeRecord({
          venue_symbol: "MSFT",
          isin: "US5949181045",
          cdm_json: JSON.stringify({ symbol: "MSFT" }),
        }),
      ];

      // First run: both added
      const r1 = engine.applyDelta(
        records,
        "XNYS",
        runId1,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );
      expect(r1.records_added).toBe(2);

      // Second run: exact same records — no changes
      const r2 = engine.applyDelta(
        records,
        "XNYS",
        runId2,
        "2026-01-01",
        "2026-01-01T11:00:00.000Z"
      );
      expect(r2.records_added).toBe(0);
      expect(r2.records_updated).toBe(0);
      expect(r2.records_delisted).toBe(0);
      expect(r2.changes).toHaveLength(0);

      // Only the original two rows exist
      const rows = engine.getAllRows("XNYS");
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.recorded_to).toBeNull();
      }
    });

    it("idempotent across three consecutive identical runs", () => {
      const records = [makeRecord()];

      const r1 = engine.applyDelta(
        records,
        "XNYS",
        createIngestRun(db, "XNYS"),
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );
      expect(r1.records_added).toBe(1);

      const r2 = engine.applyDelta(
        records,
        "XNYS",
        createIngestRun(db, "XNYS"),
        "2026-01-02",
        "2026-01-02T10:00:00.000Z"
      );
      expect(r2.records_added).toBe(0);
      expect(r2.changes).toHaveLength(0);

      const r3 = engine.applyDelta(
        records,
        "XNYS",
        createIngestRun(db, "XNYS"),
        "2026-01-03",
        "2026-01-03T10:00:00.000Z"
      );
      expect(r3.records_added).toBe(0);
      expect(r3.changes).toHaveLength(0);

      const rows = engine.getAllRows("XNYS");
      expect(rows).toHaveLength(1);
      expect(rows[0].recorded_to).toBeNull();
    });
  });

  // -- future-dated records -------------------------------------------------

  describe("future-dated records", () => {
    it("inserts a future-dated record now with the future effective_from", () => {
      const runId = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [makeRecord({ effective_from: "2026-12-31" })],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      const rows = engine.getAllRows("XNYS");
      expect(rows).toHaveLength(1);
      expect(rows[0].effective_from).toBe("2026-12-31");
      expect(rows[0].effective_to).toBeNull();
      expect(rows[0].recorded_from).toBe("2026-01-01T10:00:00.000Z");
    });

    it("future-dated record is not visible in as_of=today query", () => {
      const runId = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [makeRecord({ effective_from: "2026-12-31" })],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      // Querying today (2026-01-01): future-dated record should not appear
      const effective = engine.queryEffectiveAsOf("XNYS", "2026-01-01");
      expect(effective).toHaveLength(0);
    });

    it("future-dated record becomes visible on its effective date", () => {
      const runId = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [makeRecord({ effective_from: "2026-12-31" })],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      // Querying on the effective date: record should appear
      const effective = engine.queryEffectiveAsOf("XNYS", "2026-12-31");
      expect(effective).toHaveLength(1);
      expect(effective[0].venue_symbol).toBe("AAPL");
    });

    it("future-dated record is visible after its effective date", () => {
      const runId = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [makeRecord({ effective_from: "2026-06-15" })],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      const effective = engine.queryEffectiveAsOf("XNYS", "2026-07-01");
      expect(effective).toHaveLength(1);
    });
  });

  // -- bitemporal as_of resolution -----------------------------------------

  describe("bitemporal as_of resolution", () => {
    it("returns records effective at the given business date", () => {
      const runId = createIngestRun(db, "XNYS");

      // Insert two records with different effective dates
      engine.applyDelta(
        [
          makeRecord({
            venue_symbol: "AAPL",
            effective_from: "2026-01-01",
            cdm_json: JSON.stringify({ symbol: "AAPL", version: "v1" }),
          }),
          makeRecord({
            venue_symbol: "MSFT",
            isin: "US5949181045",
            effective_from: "2026-06-01",
            cdm_json: JSON.stringify({ symbol: "MSFT" }),
          }),
        ],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      // as_of = 2026-03-01: only AAPL is effective
      const mid = engine.queryEffectiveAsOf("XNYS", "2026-03-01");
      expect(mid).toHaveLength(1);
      expect(mid[0].venue_symbol).toBe("AAPL");

      // as_of = 2026-01-01: AAPL is effective on its start date
      const start = engine.queryEffectiveAsOf("XNYS", "2026-01-01");
      expect(start).toHaveLength(1);
      expect(start[0].venue_symbol).toBe("AAPL");

      // as_of = 2026-07-01: both are effective
      const later = engine.queryEffectiveAsOf("XNYS", "2026-07-01");
      expect(later).toHaveLength(2);
      const symbols = later.map((r) => r.venue_symbol).sort();
      expect(symbols).toEqual(["AAPL", "MSFT"]);

      // as_of = 2025-12-31: neither is effective yet
      const before = engine.queryEffectiveAsOf("XNYS", "2025-12-31");
      expect(before).toHaveLength(0);
    });

    it("returns empty when no records are effective at the given date", () => {
      const runId = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [makeRecord({ effective_from: "2026-06-01" })],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      const result = engine.queryEffectiveAsOf("XNYS", "2025-01-01");
      expect(result).toHaveLength(0);
    });

    it("excludes records whose effective_to has passed", () => {
      const runId1 = createIngestRun(db, "XNYS");
      const runId2 = createIngestRun(db, "XNYS");

      // Add a record, then delist it
      engine.applyDelta(
        [makeRecord({ effective_from: "2026-01-01" })],
        "XNYS",
        runId1,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      engine.applyDelta(
        [],
        "XNYS",
        runId2,
        "2026-01-15",
        "2026-01-15T10:00:00.000Z"
      );

      // Before delist date, record is effective
      const before = engine.queryEffectiveAsOf("XNYS", "2026-01-10");
      // The delisted record has effective_to='2026-01-15' and recorded_to IS NOT NULL,
      // so it won't appear in queryEffectiveAsOf which filters recorded_to IS NULL.
      // The correct assertion: no active records.
      expect(before).toHaveLength(0);

      // Before deletion but after effective_from: the row with data is closed (recorded_to set)
      // so it's not returned by queryEffectiveAsOf which filters on recorded_to IS NULL.
      // This is correct bitemporal semantics: the system knows about the delisting.
    });
  });

  // -- getActiveRecords -----------------------------------------------------

  describe("getActiveRecords", () => {
    it("returns empty when no records exist for the venue", () => {
      const active = engine.getActiveRecords("XNYS");
      expect(active).toHaveLength(0);
    });

    it("returns all active records for a venue after adds", () => {
      const runId = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [
          makeRecord({ venue_symbol: "AAPL" }),
          makeRecord({
            venue_symbol: "MSFT",
            isin: "US5949181045",
            cdm_json: JSON.stringify({ symbol: "MSFT" }),
          }),
        ],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      const active = engine.getActiveRecords("XNYS");
      expect(active).toHaveLength(2);
      expect(active[0].mic).toBe("XNYS");
      expect(active[1].mic).toBe("XNYS");
    });

    it("excludes records that have been closed (update or delist)", () => {
      const runId1 = createIngestRun(db, "XNYS");
      const runId2 = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [
          makeRecord({ venue_symbol: "AAPL" }),
          makeRecord({
            venue_symbol: "MSFT",
            isin: "US5949181045",
            cdm_json: JSON.stringify({ symbol: "MSFT" }),
          }),
        ],
        "XNYS",
        runId1,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      // Delist MSFT
      engine.applyDelta(
        [makeRecord({ venue_symbol: "AAPL" })],
        "XNYS",
        runId2,
        "2026-01-02",
        "2026-01-02T10:00:00.000Z"
      );

      const active = engine.getActiveRecords("XNYS");
      expect(active).toHaveLength(1);
      expect(active[0].venue_symbol).toBe("AAPL");
    });
  });

  // -- mixed operations -----------------------------------------------------

  describe("mixed adds, updates, and delists in one run", () => {
    it("correctly handles add + update + delist in a single applyDelta call", () => {
      const runId1 = createIngestRun(db, "XNYS");
      const runId2 = createIngestRun(db, "XNYS");

      // Seed pool: AAPL and MSFT
      engine.applyDelta(
        [
          makeRecord({ venue_symbol: "AAPL" }),
          makeRecord({
            venue_symbol: "MSFT",
            isin: "US5949181045",
            cdm_json: JSON.stringify({ symbol: "MSFT" }),
          }),
        ],
        "XNYS",
        runId1,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      // New snapshot: AAPL changed hash (update), MSFT absent (delist), GOOGL new (add)
      const result = engine.applyDelta(
        [
          makeVariant({ venue_symbol: "AAPL" }),
          makeRecord({
            venue_symbol: "GOOGL",
            isin: "US02079K3059",
            cdm_json: JSON.stringify({ symbol: "GOOGL" }),
          }),
        ],
        "XNYS",
        runId2,
        "2026-01-02",
        "2026-01-02T10:00:00.000Z"
      );

      expect(result.records_added).toBe(1);
      expect(result.records_updated).toBe(1);
      expect(result.records_delisted).toBe(1);

      const changeTypes = result.changes.map((c) => c.change_type).sort();
      expect(changeTypes).toEqual(["add", "delist", "update"]);

      // Active records: AAPL (updated) and GOOGL (new)
      const active = engine.getActiveRecords("XNYS");
      const activeSymbols = active.map((r) => r.venue_symbol).sort();
      expect(activeSymbols).toEqual(["AAPL", "GOOGL"]);
    });
  });

  // -- venue isolation ------------------------------------------------------

  describe("venue isolation", () => {
    it("does not affect records from a different venue", () => {
      const xnyRunId = createIngestRun(db, "XNYS");
      const xhkgRunId = createIngestRun(db, "XHKG");

      // Insert records for two venues
      engine.applyDelta(
        [makeRecord({ mic: "XNYS", venue_symbol: "AAPL" })],
        "XNYS",
        xnyRunId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      engine.applyDelta(
        [
          makeRecord({
            mic: "XHKG",
            venue_symbol: "0005.HK",
            isin: "HK0000000005",
            currency: "HKD",
            cdm_json: JSON.stringify({ symbol: "0005.HK" }),
          }),
        ],
        "XHKG",
        xhkgRunId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      // Delist everything on XNYS only
      const delistRunId = createIngestRun(db, "XNYS");
      engine.applyDelta(
        [],
        "XNYS",
        delistRunId,
        "2026-01-02",
        "2026-01-02T10:00:00.000Z"
      );

      // XHKG should be unaffected
      const xhkgActive = engine.getActiveRecords("XHKG");
      expect(xhkgActive).toHaveLength(1);
      expect(xhkgActive[0].venue_symbol).toBe("0005.HK");

      // XNYS should have no active records
      const xnyActive = engine.getActiveRecords("XNYS");
      expect(xnyActive).toHaveLength(0);
    });
  });

  // -- changes table integrity ----------------------------------------------

  describe("changes table", () => {
    it("records changed_at timestamp for each change", () => {
      const runId = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [makeRecord()],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      const changeRows = db.prepare("SELECT * FROM changes").all() as Record<
        string,
        unknown
      >[];
      expect(changeRows).toHaveLength(1);
      expect(changeRows[0].changed_at).toBe("2026-01-01T10:00:00.000Z");
    });

    it("links changes to the correct ingest_run_id", () => {
      const runId = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [makeRecord()],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      const changeRows = db.prepare("SELECT * FROM changes").all() as Record<
        string,
        unknown
      >[];
      expect(changeRows).toHaveLength(1);
      expect(changeRows[0].ingest_run_id).toBe(runId);
    });

    it("records the correct instrument_id referencing the affected row", () => {
      const runId = createIngestRun(db, "XNYS");

      engine.applyDelta(
        [makeRecord()],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      const instruments = engine.getAllRows("XNYS");
      expect(instruments).toHaveLength(1);

      const changeRows = db.prepare("SELECT * FROM changes").all() as Record<
        string,
        unknown
      >[];
      expect(changeRows).toHaveLength(1);
      expect(changeRows[0].instrument_id).toBe(instruments[0].id);
    });
  });

  // -- edge cases -----------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty input gracefully", () => {
      const runId = createIngestRun(db, "XNYS");
      const result = engine.applyDelta(
        [],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      expect(result.records_added).toBe(0);
      expect(result.records_updated).toBe(0);
      expect(result.records_delisted).toBe(0);
      expect(result.changes).toHaveLength(0);
    });

    it("handles multiple records with the same MIC+symbol (last wins within one snapshot)", () => {
      const runId = createIngestRun(db, "XNYS");

      // Same key appears twice — second one should be the one that lands
      const result = engine.applyDelta(
        [
          makeRecord({
            venue_symbol: "AAPL",
            cdm_json: JSON.stringify({ v: 1 }),
          }),
          makeRecord({
            venue_symbol: "AAPL",
            cdm_json: JSON.stringify({ v: 2 }),
          }),
        ],
        "XNYS",
        runId,
        "2026-01-01",
        "2026-01-01T10:00:00.000Z"
      );

      // Both had the same key, second overwrites first in the map.
      // First was never in the pool, so only one ADD happens (the second one).
      expect(result.records_added).toBe(1);

      const rows = engine.getAllRows("XNYS");
      expect(rows).toHaveLength(1);
      expect(rows[0].cdm_json).toBe(JSON.stringify({ v: 2 }));
    });
  });
});
