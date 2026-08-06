import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { Migrator } from "../src/db/migrator.js";
import { migration001 } from "../src/db/index.js";
import { SourceRegistry } from "../src/sources/source-registry.js";
import { SnapshotFetcher } from "../src/sources/snapshot-fetcher.js";
import { DeltaEngine } from "../src/delta/delta-engine.js";
import { IngestPipeline } from "../src/pipeline/ingest-pipeline.js";
import { xnysAdapter } from "../src/adapters/xnys-adapter.js";
import type { Adapter } from "../src/adapters/adapter.js";
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

/** Return all instrument rows for a venue (all system-time versions). */
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

/**
 * Build a CSV string with `count` XNYS instrument records plus a header.
 * Each record has a distinct symbol (STK00, STK01, ...), ISIN, and name.
 */
function makeCsv(count: number): string {
  const lines = ["symbol,name,isin,currency,mic,asset_class"];
  for (let i = 0; i < count; i++) {
    const sym = `STK${String(i).padStart(2, "0")}`;
    const isin = `US${sym.padStart(10, "0")}`;
    lines.push(`${sym},Instrument ${sym},${isin},USD,XNYS,stock`);
  }
  return lines.join("\n");
}

/**
 * Build a CSV that is identical to the one returned by `makeCsv(count)` except
 * that the instrument at `index` has its name replaced with `newName`.
 */
function makeCsvWithNameChange(
  count: number,
  index: number,
  newName: string
): string {
  const lines = ["symbol,name,isin,currency,mic,asset_class"];
  for (let i = 0; i < count; i++) {
    const sym = `STK${String(i).padStart(2, "0")}`;
    const isin = `US${sym.padStart(10, "0")}`;
    const name = i === index ? newName : `Instrument ${sym}`;
    lines.push(`${sym},${name},${isin},USD,XNYS,stock`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfill support", () => {
  let db: Database.Database;
  let deltaEngine: DeltaEngine;
  let pipeline: IngestPipeline;
  let adapter: Adapter;

  beforeEach(() => {
    db = createDb();
    runMigrations(db);
    const sourceRegistry = new SourceRegistry(db);
    const fetcher = new SnapshotFetcher(sourceRegistry);
    deltaEngine = new DeltaEngine(db);
    pipeline = new IngestPipeline(db, fetcher, deltaEngine);
    adapter = xnysAdapter;
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Backfill historical date
  // -----------------------------------------------------------------------

  it("backfill with --as-of 2024-01-01 writes effective_from = 2024-01-01", async () => {
    const report = await pipeline.runIngest(
      {
        venue: "XNYS",
        filePath: fixturePath("xnys-sample.csv"),
        effectiveDate: "2024-01-01",
      },
      adapter,
      stockProfile
    );

    expect(report.records_added).toBe(5);
    expect(report.outcome).toBe("success");

    const instruments = getAllInstruments(db, "XNYS");
    expect(instruments).toHaveLength(5);

    for (const inst of instruments) {
      expect(inst.effective_from).toBe("2024-01-01");
    }
  });

  // -----------------------------------------------------------------------
  // Query as_of
  // -----------------------------------------------------------------------

  it("query as_of 2024-06-01 returns backfilled records", async () => {
    await pipeline.runIngest(
      {
        venue: "XNYS",
        filePath: fixturePath("xnys-sample.csv"),
        effectiveDate: "2024-01-01",
      },
      adapter,
      stockProfile
    );

    const rows = deltaEngine.queryEffectiveAsOf("XNYS", "2024-06-01");
    expect(rows).toHaveLength(5);

    const symbols = rows.map((r) => r.venue_symbol).sort();
    expect(symbols).toEqual(["AAPL", "JPM", "MSFT", "WMT", "XOM"]);
  });

  it("query as_of before effective date returns empty", async () => {
    await pipeline.runIngest(
      {
        venue: "XNYS",
        filePath: fixturePath("xnys-sample.csv"),
        effectiveDate: "2024-01-01",
      },
      adapter,
      stockProfile
    );

    const rows = deltaEngine.queryEffectiveAsOf("XNYS", "2023-12-31");
    expect(rows).toHaveLength(0);
  });

  it("query asof exact effective date returns records", async () => {
    await pipeline.runIngest(
      {
        venue: "XNYS",
        filePath: fixturePath("xnys-sample.csv"),
        effectiveDate: "2024-01-01",
      },
      adapter,
      stockProfile
    );

    const rows = deltaEngine.queryEffectiveAsOf("XNYS", "2024-01-01");
    expect(rows).toHaveLength(5);
  });

  // -----------------------------------------------------------------------
  // Backfill + normal daily run
  // -----------------------------------------------------------------------

  it("backfill then normal daily run diffs correctly", async () => {
    // We backfill 10 records to keep the mass-change rate under 25%
    // (1 add + 1 update = 2 changes / 10 pool = 20% < 25%).
    const BACKFILL_COUNT = 10;

    const backfillCsv = makeCsv(BACKFILL_COUNT);
    const backfillPath = `/tmp/narwhal-backfill-${Date.now()}.csv`;
    writeFileSync(backfillPath, backfillCsv, "utf-8");

    try {
      // Step 1: Backfill at 2024-01-01
      const r1 = await pipeline.runIngest(
        { venue: "XNYS", filePath: backfillPath, effectiveDate: "2024-01-01" },
        adapter,
        stockProfile
      );
      expect(r1.records_added).toBe(BACKFILL_COUNT);
      expect(r1.outcome).toBe("success");

      // Step 2: Daily run at 2026-08-02 with 11 records:
      // all 10 existing + 1 new (STK99), and STK00's name changed.
      const dailyCsv = makeCsvWithNameChange(
        BACKFILL_COUNT + 1,
        0,
        "Instrument STK00 - Renamed"
      );
      const dailyPath = `/tmp/narwhal-daily-${Date.now()}.csv`;
      writeFileSync(dailyPath, dailyCsv, "utf-8");

      try {
        const r2 = await pipeline.runIngest(
          { venue: "XNYS", filePath: dailyPath, effectiveDate: "2026-08-02" },
          adapter,
          stockProfile
        );
        expect(r2.outcome).toBe("success");
        expect(r2.records_added).toBe(1); // STK99 is new
        expect(r2.records_updated).toBe(1); // STK00 name changed
        expect(r2.records_delisted).toBe(0);

        // Active records at 2026-08-02: all 11
        const active = deltaEngine.getActiveRecords("XNYS");
        expect(active).toHaveLength(BACKFILL_COUNT + 1);

        // The old STK00 version is now closed out in system time, so
        // queryEffectiveAsOf only sees 9 of the original 10 backfill rows.
        // Use getAllRows to look at the full bitemporal history.
        const historical = deltaEngine.queryEffectiveAsOf("XNYS", "2024-06-01");
        expect(historical).toHaveLength(BACKFILL_COUNT - 1);

        const allRows = deltaEngine.getAllRows("XNYS");
        // Backfilled 10 + 1 add + 1 update close-out = 12 total rows
        expect(allRows).toHaveLength(12);

        // Find the old STK00 row (recorded_to IS NOT NULL, with original name)
        const oldStk00 = allRows.find(
          (r) => r.venue_symbol === "STK00" && r.recorded_to !== null
        );
        expect(oldStk00).toBeDefined();
        expect(oldStk00!.cdm_json).toContain("Instrument STK00");
        expect(oldStk00!.cdm_json).not.toContain("Renamed");
        expect(oldStk00!.effective_from).toBe("2024-01-01");
        expect(oldStk00!.effective_to).toBe("2026-08-02");

        // The new STK00 row has the renamed instrument
        const newStk00 = allRows.find(
          (r) => r.venue_symbol === "STK00" && r.recorded_to === null
        );
        expect(newStk00).toBeDefined();
        expect(newStk00!.cdm_json).toContain("Renamed");
        expect(newStk00!.effective_from).toBe("2026-08-02");
      } finally {
        try {
          unlinkSync(dailyPath);
        } catch {
          /* ok */
        }
      }
    } finally {
      try {
        unlinkSync(backfillPath);
      } catch {
        /* ok */
      }
    }
  });

  it("backfill then daily run with delisting diffs correctly", async () => {
    // Use 10 records so 2 delistings = 20% < 25% mass-change threshold.
    const BACKFILL_COUNT = 10;

    const backfillCsv = makeCsv(BACKFILL_COUNT);
    const backfillPath = `/tmp/narwhal-backfill-${Date.now()}.csv`;
    writeFileSync(backfillPath, backfillCsv, "utf-8");

    try {
      // Step 1: Backfill at 2024-01-01
      const r1 = await pipeline.runIngest(
        { venue: "XNYS", filePath: backfillPath, effectiveDate: "2024-01-01" },
        adapter,
        stockProfile
      );
      expect(r1.records_added).toBe(BACKFILL_COUNT);

      // Step 2: Daily run at 2026-08-02 with only 8 records (remove STK08 and STK09)
      const dailyCsv = makeCsv(BACKFILL_COUNT - 2);
      const dailyPath = `/tmp/narwhal-daily-${Date.now()}.csv`;
      writeFileSync(dailyPath, dailyCsv, "utf-8");

      try {
        const r2 = await pipeline.runIngest(
          { venue: "XNYS", filePath: dailyPath, effectiveDate: "2026-08-02" },
          adapter,
          stockProfile
        );
        expect(r2.outcome).toBe("success");
        expect(r2.records_delisted).toBe(2); // STK08, STK09

        // Active records at 2026-08-02: only 8
        const active = deltaEngine.getActiveRecords("XNYS");
        expect(active).toHaveLength(BACKFILL_COUNT - 2);

        // Delisted records are closed out in system time, so
        // queryEffectiveAsOf (which filters recorded_to IS NULL) only
        // sees the 8 non-delisted records.
        const historical = deltaEngine.queryEffectiveAsOf("XNYS", "2024-06-01");
        expect(historical).toHaveLength(BACKFILL_COUNT - 2);

        // The full bitemporal history shows all 10 rows (close-outs are UPDATES not INSERTs)
        const allRows = deltaEngine.getAllRows("XNYS");
        expect(allRows).toHaveLength(BACKFILL_COUNT);

        // Verify STK08 has a closed-out row with effective_to set
        const stk08Closed = allRows.find(
          (r) => r.venue_symbol === "STK08" && r.recorded_to !== null
        );
        expect(stk08Closed).toBeDefined();
        expect(stk08Closed!.effective_from).toBe("2024-01-01");
        expect(stk08Closed!.effective_to).toBe("2026-08-02");

        // Future query shows only 8 (delistings took effect)
        const future = deltaEngine.queryEffectiveAsOf("XNYS", "2026-09-01");
        expect(future).toHaveLength(BACKFILL_COUNT - 2);

        // Verify delisted symbols are absent from the future view
        const futureSymbols = future.map((r) => r.venue_symbol);
        expect(futureSymbols).not.toContain("STK08");
        expect(futureSymbols).not.toContain("STK09");
      } finally {
        try {
          unlinkSync(dailyPath);
        } catch {
          /* ok */
        }
      }
    } finally {
      try {
        unlinkSync(backfillPath);
      } catch {
        /* ok */
      }
    }
  });

  // -----------------------------------------------------------------------
  // Backfill idempotency
  // -----------------------------------------------------------------------

  it("backfill same file twice is idempotent", async () => {
    const filePath = fixturePath("xnys-sample.csv");

    const r1 = await pipeline.runIngest(
      { venue: "XNYS", filePath, effectiveDate: "2024-01-01" },
      adapter,
      stockProfile
    );
    expect(r1.records_added).toBe(5);
    expect(r1.outcome).toBe("success");

    const r2 = await pipeline.runIngest(
      { venue: "XNYS", filePath, effectiveDate: "2024-01-01" },
      adapter,
      stockProfile
    );
    expect(r2.records_added).toBe(0);
    expect(r2.records_updated).toBe(0);
    expect(r2.records_delisted).toBe(0);
    expect(r2.outcome).toBe("success");

    const instruments = getAllInstruments(db, "XNYS");
    expect(instruments).toHaveLength(5);
  });

  // -----------------------------------------------------------------------
  // Multiple backfills for different dates
  // -----------------------------------------------------------------------

  it("multiple backfills for different dates build bitemporal history", async () => {
    const filePath = fixturePath("xnys-sample.csv");

    // Backfill 1: 2024-01-01
    await pipeline.runIngest(
      { venue: "XNYS", filePath, effectiveDate: "2024-01-01" },
      adapter,
      stockProfile
    );

    // Backfill 2: 2024-06-01 (same content — no changes)
    const r2 = await pipeline.runIngest(
      { venue: "XNYS", filePath, effectiveDate: "2024-06-01" },
      adapter,
      stockProfile
    );
    expect(r2.records_added).toBe(0);
    expect(r2.records_updated).toBe(0);
    expect(r2.records_delisted).toBe(0);

    expect(deltaEngine.queryEffectiveAsOf("XNYS", "2024-02-01")).toHaveLength(
      5
    );
    expect(deltaEngine.queryEffectiveAsOf("XNYS", "2024-07-01")).toHaveLength(
      5
    );
  });
});
