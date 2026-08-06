import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { Migrator } from "../src/db/migrator.js";
import { migration001 } from "../src/db/index.js";
import { SourceRegistry } from "../src/sources/source-registry.js";
import { SnapshotFetcher } from "../src/sources/snapshot-fetcher.js";
import { DeltaEngine } from "../src/delta/delta-engine.js";
import { IngestPipeline } from "../src/pipeline/ingest-pipeline.js";
import { xnysAdapter } from "../src/adapters/xnys-adapter.js";
import type { Adapter } from "../src/adapters/adapter.js";
import type { NormalizedRecord, VenueContext } from "../src/adapters/types.js";
import type { StockProfile } from "../src/assembler/types.js";
import type { IngestRunReport } from "../src/pipeline/types.js";
import type { InstrumentRow } from "../src/delta/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * XNYS-appropriate stock profile.
 *
 * The XNYS CSV snapshot only provides ISIN as an identifier.  FIGI, CUSIP,
 * and SEDOL are not present on the normalized records produced by the XNYS
 * adapter, so the profile must not require them — otherwise every record
 * would fail validation.
 */
const stockProfile: StockProfile = {
  profile_name: "stock-v1",
  asset_class: "stock",
  cdm_version: "5.0.0",
  required_fields: [
    { cdm_path: "instrument.identifiers[]", source: "isin", scheme: "ISIN" },
    { cdm_path: "instrument.name", source: "instrument_name" },
    { cdm_path: "instrument.currency", source: "currency" },
    { cdm_path: "instrument.type", value: "Equity" },
    { cdm_path: "instrument.listing.mic", source: "mic" },
    { cdm_path: "instrument.listing.venue_symbol", source: "venue_symbol" },
  ],
};

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function runMigrations(db: Database.Database): void {
  new Migrator(db).migrate([migration001]);
}

function fixturePath(name: string): string {
  return resolve(__dirname, "fixtures", name);
}

/** Approve a source for the given venue at a file:// location. */
function approveFileSource(
  registry: SourceRegistry,
  mic: string,
  filePath: string
): void {
  const location = `file://${filePath}`;
  registry.approve_source(mic, location, "operator");
}

/** Return all instrument rows for a venue (active and closed). */
function getAllInstruments(
  db: Database.Database,
  venue: string
): InstrumentRow[] {
  return db
    .prepare(
      `SELECT *
       FROM instruments
       WHERE mic = ?
       ORDER BY venue_symbol, recorded_from`
    )
    .all(venue) as InstrumentRow[];
}

/** Return the ingest_runs row for a given run id. */
function getIngestRun(
  db: Database.Database,
  runId: number
): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM ingest_runs WHERE id = ?").get(runId) as
    Record<string, unknown> | undefined;
}

/** Count quarantine rows for a given run. */
function countQuarantine(db: Database.Database, runId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM quarantine WHERE ingest_run_id = ?")
    .get(runId) as { cnt: number };
  return row.cnt;
}

/** Count change rows for a given run. */
function countChanges(db: Database.Database, runId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM changes WHERE ingest_run_id = ?")
    .get(runId) as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IngestPipeline", () => {
  let db: Database.Database;
  let sourceRegistry: SourceRegistry;
  let fetcher: SnapshotFetcher;
  let deltaEngine: DeltaEngine;
  let pipeline: IngestPipeline;
  let adapter: Adapter;

  beforeEach(() => {
    db = createDb();
    runMigrations(db);
    sourceRegistry = new SourceRegistry(db);
    fetcher = new SnapshotFetcher(sourceRegistry);
    deltaEngine = new DeltaEngine(db);
    pipeline = new IngestPipeline(db, fetcher, deltaEngine);
    adapter = xnysAdapter;
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Full pipeline run with fixture
  // -----------------------------------------------------------------------

  describe("full pipeline run with fixture", () => {
    it("processes the XNYS sample fixture and produces correct counts", async () => {
      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        adapter,
        stockProfile
      );

      // Report assertions
      expect(report.venue).toBe("XNYS");
      expect(report.file_name).toBe("xnys-sample.csv");
      expect(report.file_hash).toHaveLength(64);
      expect(report.records_total).toBe(5);
      expect(report.records_added).toBe(5);
      expect(report.records_updated).toBe(0);
      expect(report.records_delisted).toBe(0);
      expect(report.records_quarantined).toBe(0);
      expect(report.outcome).toBe("success");
      expect(report.error_message).toBeNull();
      expect(report.run_completed_at).toBeTruthy();

      // Verify ingest_runs table was updated correctly
      const run = getIngestRun(db, report.run_id);
      expect(run).toBeDefined();
      expect(run!.venue).toBe("XNYS");
      expect(run!.records_total).toBe(5);
      expect(run!.records_added).toBe(5);
      expect(run!.records_updated).toBe(0);
      expect(run!.records_delisted).toBe(0);
      expect(run!.records_quarantined).toBe(0);
      expect(run!.outcome).toBe("success");
      expect(run!.file_hash).toBe(report.file_hash);
      expect(run!.file_name).toBe("xnys-sample.csv");
      expect(run!.run_completed_at).toBeTruthy();

      // Verify instruments were inserted
      const instruments = getAllInstruments(db, "XNYS");
      expect(instruments).toHaveLength(5);

      const symbols = instruments.map((r) => r.venue_symbol).sort();
      expect(symbols).toEqual(["AAPL", "JPM", "MSFT", "WMT", "XOM"]);

      // Each instrument should have the right metadata
      for (const inst of instruments) {
        expect(inst.mic).toBe("XNYS");
        expect(inst.asset_class).toBe("stock");
        expect(inst.currency).toBe("USD");
        expect(inst.recorded_to).toBeNull();
        expect(inst.effective_from).toBe("2026-08-01");
        expect(inst.effective_to).toBeNull();
        expect(inst.ingest_run_id).toBe(report.run_id);
        expect(inst.content_hash).toHaveLength(64);
        // CDM JSON should contain the instrument type
        expect(inst.cdm_json).toContain('"Equity"');
      }

      // Verify change entries
      const changeCount = countChanges(db, report.run_id);
      expect(changeCount).toBe(5);

      const changes = db
        .prepare("SELECT * FROM changes WHERE ingest_run_id = ?")
        .all(report.run_id) as { change_type: string }[];
      for (const ch of changes) {
        expect(ch.change_type).toBe("add");
      }
    });

    it("instruments have correct CDM JSON content", async () => {
      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        adapter,
        stockProfile
      );

      const instruments = getAllInstruments(db, "XNYS");

      // AAPL
      const aapl = instruments.find((r) => r.venue_symbol === "AAPL");
      expect(aapl).toBeDefined();
      const aaplDoc = JSON.parse(aapl!.cdm_json);
      expect(aaplDoc.instrument.name).toBe("Apple Inc.");
      expect(aaplDoc.instrument.currency).toBe("USD");
      expect(aaplDoc.instrument.type).toBe("Equity");
      expect(aaplDoc.instrument.listing.mic).toBe("XNYS");
      expect(aaplDoc.instrument.listing.venue_symbol).toBe("AAPL");
      expect(aaplDoc.instrument.identifiers).toContainEqual({
        value: "US0378331005",
        type: "ISIN",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------

  describe("idempotency", () => {
    it("re-running the same file produces zero changes", async () => {
      const filePath = fixturePath("xnys-sample.csv");

      // First run
      const report1 = await pipeline.runIngest(
        { venue: "XNYS", filePath, effectiveDate: "2026-08-01" },
        adapter,
        stockProfile
      );
      expect(report1.records_added).toBe(5);
      expect(report1.outcome).toBe("success");

      // Second run: same file, same effective date
      const report2 = await pipeline.runIngest(
        { venue: "XNYS", filePath, effectiveDate: "2026-08-01" },
        adapter,
        stockProfile
      );

      // Nothing changed
      expect(report2.records_total).toBe(5);
      expect(report2.records_added).toBe(0);
      expect(report2.records_updated).toBe(0);
      expect(report2.records_delisted).toBe(0);
      expect(report2.records_quarantined).toBe(0);
      expect(report2.outcome).toBe("success");

      // Run record shows zero counts
      const run2 = getIngestRun(db, report2.run_id);
      expect(run2!.records_added).toBe(0);
      expect(run2!.records_updated).toBe(0);
      expect(run2!.records_delisted).toBe(0);

      // No new instrument rows (still just 5)
      const instruments = getAllInstruments(db, "XNYS");
      expect(instruments).toHaveLength(5);

      // No additional change entries for run 2
      const changes2 = countChanges(db, report2.run_id);
      expect(changes2).toBe(0);
    });

    it("idempotent across three identical runs", async () => {
      const filePath = fixturePath("xnys-sample.csv");

      // Run 1
      const r1 = await pipeline.runIngest(
        { venue: "XNYS", filePath, effectiveDate: "2026-08-01" },
        adapter,
        stockProfile
      );
      expect(r1.records_added).toBe(5);

      // Run 2
      const r2 = await pipeline.runIngest(
        { venue: "XNYS", filePath, effectiveDate: "2026-08-01" },
        adapter,
        stockProfile
      );
      expect(r2.records_added).toBe(0);
      expect(r2.records_updated).toBe(0);
      expect(r2.records_delisted).toBe(0);

      // Run 3
      const r3 = await pipeline.runIngest(
        { venue: "XNYS", filePath, effectiveDate: "2026-08-01" },
        adapter,
        stockProfile
      );
      expect(r3.records_added).toBe(0);
      expect(r3.records_updated).toBe(0);
      expect(r3.records_delisted).toBe(0);

      // Still only 5 instrument rows
      const instruments = getAllInstruments(db, "XNYS");
      expect(instruments).toHaveLength(5);
    });

    it("re-running with different effective date still produces no delta changes", async () => {
      const filePath = fixturePath("xnys-sample.csv");

      // First run
      const r1 = await pipeline.runIngest(
        { venue: "XNYS", filePath, effectiveDate: "2026-08-01" },
        adapter,
        stockProfile
      );
      expect(r1.records_added).toBe(5);

      // Second run with a different effective date but same CDM content
      const r2 = await pipeline.runIngest(
        { venue: "XNYS", filePath, effectiveDate: "2026-08-02" },
        adapter,
        stockProfile
      );
      // Still no changes because the CDM hashes match
      expect(r2.records_added).toBe(0);
      expect(r2.records_updated).toBe(0);
      expect(r2.records_delisted).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Missing file
  // -----------------------------------------------------------------------

  describe("missing file", () => {
    it("returns unavailable outcome and leaves prior state intact", async () => {
      // First: seed the pool with a successful run
      const seedReport = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        adapter,
        stockProfile
      );
      expect(seedReport.outcome).toBe("success");
      expect(seedReport.records_added).toBe(5);

      // Snapshot of pool state before missing-file attempt
      const instrumentsBefore = getAllInstruments(db, "XNYS");
      expect(instrumentsBefore).toHaveLength(5);

      // Now try to ingest a non-existent file
      const missingReport = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: "/tmp/narwhal-nonexistent-file-99999.csv",
          effectiveDate: "2026-08-02",
        },
        adapter,
        stockProfile
      );

      expect(missingReport.outcome).toBe("unavailable");
      expect(missingReport.file_name).toBeNull();
      expect(missingReport.file_hash).toBeNull();
      expect(missingReport.error_message).toContain("File not found");
      expect(missingReport.records_total).toBe(0);
      expect(missingReport.records_added).toBe(0);

      // Run record recorded as unavailable
      const run = getIngestRun(db, missingReport.run_id);
      expect(run!.outcome).toBe("unavailable");
      expect(run!.error_message).toContain("File not found");

      // Prior state is intact
      const instrumentsAfter = getAllInstruments(db, "XNYS");
      expect(instrumentsAfter).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(instrumentsAfter[i].id).toBe(instrumentsBefore[i].id);
        expect(instrumentsAfter[i].content_hash).toBe(
          instrumentsBefore[i].content_hash
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // Delisting
  // -----------------------------------------------------------------------

  describe("delisting", () => {
    it("delists records that are absent from a subsequent snapshot", async () => {
      // Seed: 5 records
      const r1 = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        adapter,
        stockProfile
      );
      expect(r1.records_added).toBe(5);

      // Write a smaller fixture with 4 records (AAPL, MSFT, JPM, XOM).
      // WMT should be delisted. 1 delist / 5 pool = 20% — within mass-change gate.
      const smallCsv = [
        "symbol,name,isin,currency,mic,asset_class",
        "AAPL,Apple Inc.,US0378331005,USD,XNYS,stock",
        "MSFT,Microsoft Corporation,US5949181045,USD,XNYS,stock",
        "JPM,JPMorgan Chase & Co.,US46625H1005,USD,XNYS,stock",
        "XOM,Exxon Mobil Corporation,US30231G1022,USD,XNYS,stock",
      ].join("\n");

      const tmpPath = `/tmp/narwhal-test-delist-${Date.now()}.csv`;
      writeFileSync(tmpPath, smallCsv, "utf-8");

      try {
        const r3 = await pipeline.runIngest(
          { venue: "XNYS", filePath: tmpPath, effectiveDate: "2026-08-03" },
          adapter,
          stockProfile
        );

        expect(r3.records_total).toBe(4);
        expect(r3.records_added).toBe(0);
        expect(r3.records_updated).toBe(0);
        expect(r3.records_delisted).toBe(1); // WMT delisted
        expect(r3.outcome).toBe("success");

        // Active records: AAPL, MSFT, JPM, XOM
        const active = deltaEngine.getActiveRecords("XNYS");
        const activeSymbols = active.map((r) => r.venue_symbol).sort();
        expect(activeSymbols).toEqual(["AAPL", "JPM", "MSFT", "XOM"]);
      } finally {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ok */
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // Quarantine (mock adapter — XNYS adapter rejects bad rows at parse time)
  // -----------------------------------------------------------------------

  describe("quarantine", () => {
    /**
     * Mock adapter that returns records with configurable missing fields.
     * The pipeline will assemble these, fail validation on the ISIN check,
     * and quarantine them — exercising the quarantine path.
     */
    function createMockAdapter(records: NormalizedRecord[]): Adapter {
      return {
        parse(
          _fileBytes: Buffer,
          _venueContext: VenueContext
        ): NormalizedRecord[] {
          return records;
        },
      };
    }

    it("quarantines records that fail profile validation", async () => {
      function makeGoodRecord(symbol: string): NormalizedRecord {
        return {
          venue_symbol: symbol,
          isin: `ISIN${symbol.padStart(8, "0")}`,
          instrument_name: `Instrument ${symbol}`,
          currency: "USD",
          asset_class: "stock",
          mic: "XNYS",
          attributes: {},
        };
      }

      const goodRecords: NormalizedRecord[] = Array.from(
        { length: 10 },
        (_, i) => makeGoodRecord(`GOOD${i}`)
      );

      const badRecord: NormalizedRecord = {
        venue_symbol: "BAD",
        isin: "", // empty ISIN — will fail assembler (skipped by assembler) and then fail validation
        instrument_name: "Bad Instrument",
        currency: "USD",
        asset_class: "stock",
        mic: "XNYS",
        attributes: {},
      };

      // 11 records total: 10 good, 1 bad → 1/11 ≈ 9.1% parse error rate < 10% gate
      const mockAdapter = createMockAdapter([...goodRecords, badRecord]);

      // Use filePath so the pipeline reads from disk; the mock adapter
      // ignores file bytes and returns its configured records instead.
      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        mockAdapter,
        stockProfile
      );

      expect(report.records_total).toBe(11);
      expect(report.records_added).toBe(10); // 10 good records
      expect(report.records_quarantined).toBe(1); // BAD
      expect(report.outcome).toBe("partial");

      // Verify quarantine row
      const qCount = countQuarantine(db, report.run_id);
      expect(qCount).toBe(1);

      const qRows = db
        .prepare("SELECT * FROM quarantine WHERE ingest_run_id = ?")
        .all(report.run_id) as {
        record_index: number;
        failure_reasons: string;
      }[];
      expect(qRows).toHaveLength(1);
      expect(qRows[0].record_index).toBe(10); // last record (0-indexed)

      // Verify the failure reason mentions ISIN
      const reasons = JSON.parse(qRows[0].failure_reasons) as string[];
      expect(reasons.some((r) => r.toLowerCase().includes("isin"))).toBe(true);

      // 10 instruments in the pool
      const instruments = getAllInstruments(db, "XNYS");
      expect(instruments).toHaveLength(10);
      expect(instruments[0].venue_symbol).toBe("GOOD0");
    });

    it("marks outcome as quarantined when all records fail", async () => {
      const badRecords: NormalizedRecord[] = [
        {
          venue_symbol: "A",
          isin: "",
          instrument_name: "Name A",
          currency: "USD",
          asset_class: "stock",
          mic: "XNYS",
          attributes: {},
        },
        {
          venue_symbol: "B",
          isin: "",
          instrument_name: "Name B",
          currency: "USD",
          asset_class: "stock",
          mic: "XNYS",
          attributes: {},
        },
      ];

      const mockAdapter = createMockAdapter(badRecords);

      // Use filePath so the pipeline reads from disk; the mock adapter
      // ignores file bytes and returns its configured records instead.
      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        mockAdapter,
        stockProfile
      );

      expect(report.records_total).toBe(2);
      expect(report.records_added).toBe(0);
      expect(report.records_quarantined).toBe(2);
      expect(report.outcome).toBe("quarantined");

      // Zero instruments in pool
      const instruments = getAllInstruments(db, "XNYS");
      expect(instruments).toHaveLength(0);

      // Two quarantine rows
      const qCount = countQuarantine(db, report.run_id);
      expect(qCount).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Fetch mode (unavailable when no sources are approved)
  // -----------------------------------------------------------------------

  describe("fetch mode", () => {
    it("returns unavailable when no approved sources exist for the venue", async () => {
      // No source approved — fetch returns unavailable
      const report = await pipeline.runIngest(
        { venue: "XNYS", effectiveDate: "2026-08-01" },
        adapter,
        stockProfile
      );

      expect(report.outcome).toBe("unavailable");
      expect(report.file_name).toBeNull();
      expect(report.file_hash).toBeNull();
      expect(report.error_message).toContain("No approved sources");

      // Run recorded as unavailable
      const run = getIngestRun(db, report.run_id);
      expect(run!.outcome).toBe("unavailable");
    });

    it("fetches from approved source when available", async () => {
      // Approve a source pointing to the fixture file
      approveFileSource(sourceRegistry, "XNYS", fixturePath("xnys-sample.csv"));

      const report = await pipeline.runIngest(
        { venue: "XNYS", effectiveDate: "2026-08-01" },
        adapter,
        stockProfile
      );

      expect(report.outcome).toBe("success");
      expect(report.records_added).toBe(5);
      expect(report.file_name).toBe("xnys-sample.csv");
      expect(report.file_hash).toHaveLength(64);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles an empty CSV file (header only, no data rows)", async () => {
      const emptyCsv = "symbol,name,isin,currency,mic,asset_class\n";
      const tmpPath = `/tmp/narwhal-test-empty-${Date.now()}.csv`;
      writeFileSync(tmpPath, emptyCsv, "utf-8");

      try {
        const report = await pipeline.runIngest(
          { venue: "XNYS", filePath: tmpPath, effectiveDate: "2026-08-01" },
          adapter,
          stockProfile
        );

        expect(report.records_total).toBe(0);
        expect(report.records_added).toBe(0);
        expect(report.records_quarantined).toBe(0);
        expect(report.outcome).toBe("success");

        const instruments = getAllInstruments(db, "XNYS");
        expect(instruments).toHaveLength(0);
      } finally {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ok */
        }
      }
    });

    it("writes correct effective_from date to instruments", async () => {
      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-12-15",
        },
        adapter,
        stockProfile
      );

      expect(report.records_added).toBe(5);

      const instruments = getAllInstruments(db, "XNYS");
      for (const inst of instruments) {
        expect(inst.effective_from).toBe("2026-12-15");
      }
    });

    it("computes and stores the correct file hash", async () => {
      const filePath = fixturePath("xnys-sample.csv");
      const fileBytes = readFileSync(filePath);
      const expectedHash = createHash("sha256").update(fileBytes).digest("hex");

      const report = await pipeline.runIngest(
        { venue: "XNYS", filePath, effectiveDate: "2026-08-01" },
        adapter,
        stockProfile
      );

      expect(report.file_hash).toBe(expectedHash);

      // Verify stored in ingest_runs
      const run = getIngestRun(db, report.run_id);
      expect(run!.file_hash).toBe(expectedHash);
    });
  });
});
