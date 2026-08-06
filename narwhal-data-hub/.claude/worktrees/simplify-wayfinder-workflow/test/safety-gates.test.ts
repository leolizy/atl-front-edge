import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { Migrator } from "../src/db/migrator.js";
import { migration001 } from "../src/db/migrations/001-initial-schema.js";
import { SourceRegistry } from "../src/sources/source-registry.js";
import { SnapshotFetcher } from "../src/sources/snapshot-fetcher.js";
import { DeltaEngine } from "../src/delta/delta-engine.js";
import { IngestPipeline } from "../src/pipeline/ingest-pipeline.js";
import {
  checkParseErrorRate,
  checkMassChangeRate,
  applySafetyGates,
  DEFAULT_PARSE_ERROR_THRESHOLD,
  DEFAULT_MASS_CHANGE_THRESHOLD,
  type SafetyGateCheck,
} from "../src/pipeline/safety-gates.js";
import type { Adapter } from "../src/adapters/adapter.js";
import type { NormalizedRecord, VenueContext } from "../src/adapters/types.js";
import type { StockProfile } from "../src/assembler/types.js";
import type { InstrumentRow } from "../src/delta/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function getIngestRun(
  db: Database.Database,
  runId: number
): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM ingest_runs WHERE id = ?").get(runId) as
    Record<string, unknown> | undefined;
}

/** Create a mock adapter that returns the given records from parse(). */
function createMockAdapter(records: NormalizedRecord[]): Adapter {
  return {
    parse(_fileBytes: Buffer, _venueContext: VenueContext): NormalizedRecord[] {
      return records;
    },
  };
}

/** Build a valid normalized record stub. */
function makeRecord(
  symbol: string,
  overrides?: Partial<NormalizedRecord>
): NormalizedRecord {
  return {
    mic: "XNYS",
    venue_symbol: symbol,
    asset_class: "stock",
    currency: "USD",
    instrument_name: `Instrument ${symbol}`,
    isin: `ISIN${symbol.padStart(8, "0")}`,
    ...overrides,
  };
}

/** Build a record that will fail validation (empty ISIN). */
function makeBadRecord(symbol: string): NormalizedRecord {
  return makeRecord(symbol, { isin: "" });
}

// ---------------------------------------------------------------------------
// Unit tests — gate functions
// ---------------------------------------------------------------------------

describe("checkParseErrorRate", () => {
  it("passes when the error rate is below the threshold", () => {
    const result = checkParseErrorRate(1, 20); // 5%
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("fails when the error rate exceeds the threshold", () => {
    const result = checkParseErrorRate(3, 20); // 15% > 10%
    expect(result.passed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("15.0%");
    expect(result.reason).toContain("10%");
    expect(result.reason).toContain("3/20");
  });

  it("passes when the error rate equals the threshold", () => {
    const result = checkParseErrorRate(2, 20); // 10%
    expect(result.passed).toBe(true);
  });

  it("passes for zero total records (divide-by-zero guard)", () => {
    const result = checkParseErrorRate(0, 0);
    expect(result.passed).toBe(true);
  });

  it("respects a custom threshold", () => {
    const result = checkParseErrorRate(3, 20, 0.2); // 15% < 20%
    expect(result.passed).toBe(true);

    const result2 = checkParseErrorRate(3, 20, 0.05); // 15% > 5%
    expect(result2.passed).toBe(false);
  });

  it("fails when 50% of records have parse errors (threshold 10%)", () => {
    const result = checkParseErrorRate(5, 10); // 50% > 10%
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("50.0%");
    expect(result.reason).toContain("5/10");
  });
});

describe("checkMassChangeRate", () => {
  it("passes when the change rate is below the threshold", () => {
    const result = checkMassChangeRate(2, 20); // 10%
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("fails when the change rate exceeds the threshold", () => {
    const result = checkMassChangeRate(6, 20); // 30% > 25%
    expect(result.passed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("30.0%");
    expect(result.reason).toContain("25%");
    expect(result.reason).toContain("6/20");
  });

  it("passes when the change rate equals the threshold", () => {
    const result = checkMassChangeRate(5, 20); // 25%
    expect(result.passed).toBe(true);
  });

  it("passes for zero pool records (divide-by-zero guard)", () => {
    const result = checkMassChangeRate(10, 0);
    expect(result.passed).toBe(true);
  });

  it("respects a custom threshold", () => {
    const result = checkMassChangeRate(6, 20, 0.4); // 30% < 40%
    expect(result.passed).toBe(true);

    const result2 = checkMassChangeRate(6, 20, 0.2); // 30% > 20%
    expect(result2.passed).toBe(false);
  });

  it("fails when 40% of pool would change (threshold 25%)", () => {
    const result = checkMassChangeRate(4, 10); // 40% > 25%
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("40.0%");
    expect(result.reason).toContain("4/10");
  });
});

describe("applySafetyGates", () => {
  it("returns ok when all gates pass", () => {
    const gates: SafetyGateCheck[] = [
      { name: "parse_error_rate", result: { passed: true } },
      { name: "mass_change", result: { passed: true } },
    ];
    const result = applySafetyGates(gates);
    expect(result.status).toBe("ok");
    expect(result.reason).toBeUndefined();
  });

  it("returns quarantined when the first gate fails", () => {
    const gates: SafetyGateCheck[] = [
      {
        name: "parse_error_rate",
        result: { passed: false, reason: "50% > 10%" },
      },
      { name: "mass_change", result: { passed: true } },
    ];
    const result = applySafetyGates(gates);
    expect(result.status).toBe("quarantined");
    expect(result.reason).toBe("parse_error_rate: 50% > 10%");
  });

  it("returns quarantined when a later gate fails", () => {
    const gates: SafetyGateCheck[] = [
      { name: "parse_error_rate", result: { passed: true } },
      {
        name: "mass_change",
        result: { passed: false, reason: "40% > 25%" },
      },
    ];
    const result = applySafetyGates(gates);
    expect(result.status).toBe("quarantined");
    expect(result.reason).toBe("mass_change: 40% > 25%");
  });

  it("returns ok for an empty gate list", () => {
    const result = applySafetyGates([]);
    expect(result.status).toBe("ok");
  });
});

describe("default thresholds", () => {
  it("has expected default parse error threshold", () => {
    expect(DEFAULT_PARSE_ERROR_THRESHOLD).toBe(0.1);
  });

  it("has expected default mass change threshold", () => {
    expect(DEFAULT_MASS_CHANGE_THRESHOLD).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — pipeline with safety gates
// ---------------------------------------------------------------------------

describe("IngestPipeline safety gates", () => {
  let db: Database.Database;
  let sourceRegistry: SourceRegistry;
  let fetcher: SnapshotFetcher;
  let deltaEngine: DeltaEngine;
  let pipeline: IngestPipeline;

  beforeEach(() => {
    db = createDb();
    runMigrations(db);
    sourceRegistry = new SourceRegistry(db);
    fetcher = new SnapshotFetcher(sourceRegistry);
    deltaEngine = new DeltaEngine(db);
    pipeline = new IngestPipeline(db, fetcher, deltaEngine);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Parse-error rate gate
  // -----------------------------------------------------------------------

  describe("parse-error rate gate", () => {
    it("quarantines the run when 50% of records fail validation (threshold 10%)", async () => {
      // 2 good, 2 bad = 50% error rate > 10% threshold
      const records: NormalizedRecord[] = [
        makeRecord("A"),
        makeBadRecord("B"),
        makeRecord("C"),
        makeBadRecord("D"),
      ];
      const mockAdapter = createMockAdapter(records);

      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        mockAdapter,
        stockProfile
      );

      expect(report.outcome).toBe("quarantined");
      expect(report.error_message).toBeDefined();
      expect(report.error_message).toContain("parse_error_rate");
      expect(report.error_message).toContain("50.0%");
      expect(report.error_message).toContain("2/4");
      expect(report.records_total).toBe(4);
      expect(report.records_quarantined).toBe(2);

      // Zero pool mutations — the delta was never applied
      expect(report.records_added).toBe(0);
      expect(report.records_updated).toBe(0);
      expect(report.records_delisted).toBe(0);

      const instruments = getAllInstruments(db, "XNYS");
      expect(instruments).toHaveLength(0);

      // Run record has the trip reason
      const run = getIngestRun(db, report.run_id);
      expect(run!.outcome).toBe("quarantined");
      expect(run!.error_message).toContain("parse_error_rate");
    });

    it("does not trip the gate when error rate is within threshold", async () => {
      // 1 bad out of 10 = 10% ≤ 10% threshold
      const records: NormalizedRecord[] = [
        ...Array.from({ length: 9 }, (_, i) => makeRecord(`S${i}`)),
        makeBadRecord("BAD"),
      ];
      const mockAdapter = createMockAdapter(records);

      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        mockAdapter,
        stockProfile
      );

      expect(report.outcome).toBe("partial"); // partial because 1 quarantined
      expect(report.records_added).toBe(9);
      expect(report.records_quarantined).toBe(1);

      const instruments = getAllInstruments(db, "XNYS");
      expect(instruments).toHaveLength(9);
    });
  });

  // -----------------------------------------------------------------------
  // Mass-change rate gate
  // -----------------------------------------------------------------------

  describe("mass-change rate gate", () => {
    it("quarantines the run when 60% of pool records would change (threshold 25%)", async () => {
      // Step 1: Seed the pool with 10 records
      const seedRecords: NormalizedRecord[] = Array.from(
        { length: 10 },
        (_, i) => makeRecord(`SEED${i}`)
      );
      const seedAdapter = createMockAdapter(seedRecords);

      const seedReport = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        seedAdapter,
        stockProfile
      );
      expect(seedReport.outcome).toBe("success");
      expect(seedReport.records_added).toBe(10);

      // Step 2: Ingest a snapshot that keeps only 4 of 10 pool records.
      // 6 records are delisted → 6/10 = 60% > 25% threshold.
      const newRecords: NormalizedRecord[] = [
        makeRecord("SEED0"),
        makeRecord("SEED1"),
        makeRecord("SEED2"),
        makeRecord("SEED3"),
      ];
      // SEED4–SEED9 are NOT in the new snapshot → 6 delistings

      const mockAdapter = createMockAdapter(newRecords);

      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-02",
        },
        mockAdapter,
        stockProfile
      );

      expect(report.outcome).toBe("quarantined");
      expect(report.error_message).toBeDefined();
      expect(report.error_message).toContain("mass_change");
      expect(report.error_message).toContain("60.0%");
      expect(report.error_message).toContain("6/10");

      // Zero pool mutations — delta never applied
      expect(report.records_added).toBe(0);
      expect(report.records_updated).toBe(0);
      expect(report.records_delisted).toBe(0);

      // Pool still has 10 original records
      const instruments = getAllInstruments(db, "XNYS");
      const activeCount = instruments.filter(
        (r) => r.recorded_to === null
      ).length;
      expect(activeCount).toBe(10);

      // Run record has the trip reason
      const run = getIngestRun(db, report.run_id);
      expect(run!.outcome).toBe("quarantined");
      expect(run!.error_message).toContain("mass_change");
    });

    it("does not trip the gate when mass change is within threshold", async () => {
      // Seed the pool with 10 records
      const seedRecords: NormalizedRecord[] = Array.from(
        { length: 10 },
        (_, i) => makeRecord(`SEED${i}`)
      );
      const seedAdapter = createMockAdapter(seedRecords);

      const seedReport = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        seedAdapter,
        stockProfile
      );
      expect(seedReport.outcome).toBe("success");

      // Ingest identical records — 0% change
      const mockAdapter = createMockAdapter(seedRecords);

      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-02",
        },
        mockAdapter,
        stockProfile
      );

      expect(report.outcome).toBe("success");
      expect(report.records_added).toBe(0);
      expect(report.records_updated).toBe(0);
      expect(report.records_delisted).toBe(0);
    });

    it("does not trip the mass-change gate on an empty pool (first run)", async () => {
      const records: NormalizedRecord[] = [
        makeRecord("A"),
        makeRecord("B"),
        makeRecord("C"),
        makeRecord("D"),
        makeRecord("E"),
      ];
      const mockAdapter = createMockAdapter(records);

      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        mockAdapter,
        stockProfile
      );

      // Empty pool → mass-change gate passes (poolTotal=0 guard)
      expect(report.outcome).toBe("success");
      expect(report.records_added).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // Within thresholds — normal processing
  // -----------------------------------------------------------------------

  describe("within thresholds", () => {
    it("applies delta normally when both gates pass", async () => {
      // Seed 10 records
      const seedRecords: NormalizedRecord[] = Array.from(
        { length: 10 },
        (_, i) => makeRecord(`SEED${i}`)
      );
      const seedAdapter = createMockAdapter(seedRecords);

      await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        seedAdapter,
        stockProfile
      );

      // Next run: same 9 records + 1 new, 1 delisted = 2/10 = 20% change ≤ 25%
      const nextRecords: NormalizedRecord[] = [
        ...Array.from({ length: 9 }, (_, i) => makeRecord(`SEED${i}`)),
        makeRecord("NEW1"), // 1 add, 1 delist = 2 changes / 10 = 20%
      ];
      const nextAdapter = createMockAdapter(nextRecords);

      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-02",
        },
        nextAdapter,
        stockProfile
      );

      // 0 parse errors + 20% mass change — both gates pass
      expect(report.outcome).toBe("success");
      expect(report.records_added).toBe(1);
      expect(report.records_delisted).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Trip reason in run record
  // -----------------------------------------------------------------------

  describe("trip reason in run record", () => {
    it("records the parse-error trip reason in ingest_runs.error_message", async () => {
      const records: NormalizedRecord[] = [
        makeBadRecord("B1"),
        makeBadRecord("B2"),
        makeBadRecord("B3"),
      ];
      const mockAdapter = createMockAdapter(records);

      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        mockAdapter,
        stockProfile
      );

      expect(report.outcome).toBe("quarantined");
      expect(report.error_message).toContain("parse_error_rate");

      const run = getIngestRun(db, report.run_id);
      expect(run!.error_message).toContain("parse_error_rate");
      expect(run!.error_message).toContain("100.0%");
      expect(run!.error_message).toContain("3/3");
    });

    it("records the mass-change trip reason in ingest_runs.error_message", async () => {
      // Seed 10 records
      const seedRecords: NormalizedRecord[] = Array.from(
        { length: 10 },
        (_, i) => makeRecord(`SEED${i}`)
      );
      const seedAdapter = createMockAdapter(seedRecords);
      await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-01",
        },
        seedAdapter,
        stockProfile
      );

      // New snapshot: only 2 records → 8 delistings = 80% change > 25%
      const nextRecords: NormalizedRecord[] = [
        makeRecord("SEED0"),
        makeRecord("SEED1"),
      ];
      const nextAdapter = createMockAdapter(nextRecords);

      const report = await pipeline.runIngest(
        {
          venue: "XNYS",
          filePath: fixturePath("xnys-sample.csv"),
          effectiveDate: "2026-08-02",
        },
        nextAdapter,
        stockProfile
      );

      expect(report.outcome).toBe("quarantined");
      expect(report.error_message).toContain("mass_change");

      const run = getIngestRun(db, report.run_id);
      expect(run!.error_message).toContain("mass_change");
      expect(run!.error_message).toContain("80.0%");
      expect(run!.error_message).toContain("8/10");
    });
  });
});
