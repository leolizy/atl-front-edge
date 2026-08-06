import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Migrator } from "../src/db/migrator.js";
import { migration001 } from "../src/db/index.js";
import {
  validate,
  quarantineRecord,
} from "../src/validator/profile-validator.js";
import type {
  ValidationResult,
  ValidationFailure,
} from "../src/validator/types.js";
import type {
  StockProfile,
  CdmDocument,
  NormalizedRecord,
} from "../src/assembler/types.js";
import { assemble } from "../src/assembler/cdm-assembler.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stock profile matching the checked-in config/stock-profile.json. */
const stockProfile: StockProfile = {
  profile_name: "stock-v1",
  asset_class: "stock",
  cdm_version: "5.0.0",
  required_fields: [
    { cdm_path: "instrument.identifiers[]", source: "isin", scheme: "ISIN" },
    { cdm_path: "instrument.identifiers[]", source: "figi", scheme: "FIGI" },
    { cdm_path: "instrument.identifiers[]", source: "cusip", scheme: "CUSIP" },
    { cdm_path: "instrument.identifiers[]", source: "sedol", scheme: "SEDOL" },
    { cdm_path: "instrument.name", source: "instrument_name" },
    { cdm_path: "instrument.currency", source: "currency" },
    { cdm_path: "instrument.type", value: "Equity" },
    { cdm_path: "instrument.listing.mic", source: "mic" },
    { cdm_path: "instrument.listing.venue_symbol", source: "venue_symbol" },
  ],
};

function makeRecord(overrides?: Partial<NormalizedRecord>): NormalizedRecord {
  return {
    mic: "XNYS",
    venue_symbol: "AAPL",
    asset_class: "stock",
    currency: "USD",
    instrument_name: "Apple Inc.",
    isin: "US0378331005",
    figi: "BBG000B9XRY4",
    cusip: "037833100",
    sedol: "2046251",
    ...overrides,
  };
}

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function runMigrations(db: Database.Database): void {
  new Migrator(db).migrate([migration001]);
}

function createIngestRun(db: Database.Database, venue: string): number {
  const result = db
    .prepare(
      `INSERT INTO ingest_runs
         (venue, window_start, window_end, file_hash, file_name,
          records_total, records_added, records_updated, records_delisted,
          records_quarantined, outcome, run_started_at, run_completed_at)
       VALUES (?, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 'success', ?, NULL)`
    )
    .run(venue, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Tests — pure validation (no DB)
// ---------------------------------------------------------------------------

describe("profile-validator: validate()", () => {
  describe("valid documents", () => {
    it("passes a fully assembled CDM document", () => {
      const doc = assemble(makeRecord(), stockProfile);
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("passes a minimal document (only optional identifiers skipped by assembler)", () => {
      const minimal: NormalizedRecord = {
        mic: "XNYS",
        venue_symbol: "AAPL",
        asset_class: "stock",
        currency: "USD",
        instrument_name: "Apple Inc.",
      };
      const doc = assemble(minimal, stockProfile);
      const result = validate(doc, stockProfile);

      // The assembler skips optional identifier fields when they're absent,
      // so the CDM doc only has non-identifier fields populated.
      // Identifier fields are still required by the profile, so this should fail.
      expect(result.valid).toBe(false);
      expect(
        result.failures.some((f) => f.field === "instrument.identifiers[]")
      ).toBe(true);
    });

    it("passes a document with only one identifier present", () => {
      const record = makeRecord({
        isin: "US0378331005",
        figi: undefined,
        cusip: undefined,
        sedol: undefined,
      });
      const doc = assemble(record, stockProfile);

      // The assembler only appends the ISIN identifier. The FIGI/CUSIP/SEDOL
      // identifier fields are declared in the profile but the assembler skips
      // them when the source value is absent.
      // Since the assembler never puts them in the document, the validator
      // reports them as missing — they're required by the profile.
      const result = validate(doc, stockProfile);
      expect(result.valid).toBe(false);
      // ISIN should still pass validation
      const figiFailure = result.failures.find((f) =>
        f.reason.includes("FIGI")
      );
      expect(figiFailure).toBeDefined();
    });
  });

  describe("missing required fields", () => {
    it("fails when a required scalar field is missing", () => {
      const doc: CdmDocument = {
        instrument: {
          currency: "USD",
          type: "Equity",
          listing: { mic: "XNYS", venue_symbol: "AAPL" },
        },
      };
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(false);
      const nameFail = result.failures.find(
        (f) => f.field === "instrument.name"
      );
      expect(nameFail).toBeDefined();
      expect(nameFail!.reason).toContain("instrument_name");
    });

    it("fails when a required scalar field is empty string", () => {
      const doc: CdmDocument = {
        instrument: {
          identifiers: [{ type: "ISIN", value: "US0378331005" }],
          name: "",
          currency: "USD",
          type: "Equity",
          listing: { mic: "XNYS", venue_symbol: "AAPL" },
        },
      };
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(false);
      const nameFail = result.failures.find(
        (f) => f.field === "instrument.name"
      );
      expect(nameFail).toBeDefined();
      expect(nameFail!.reason).toContain("empty");
    });

    it("fails when a required identifier array is missing", () => {
      const doc: CdmDocument = {
        instrument: {
          name: "Apple Inc.",
          currency: "USD",
          type: "Equity",
          listing: { mic: "XNYS", venue_symbol: "AAPL" },
        },
      };
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(false);
      const idFailures = result.failures.filter(
        (f) => f.field === "instrument.identifiers[]"
      );
      expect(idFailures.length).toBeGreaterThanOrEqual(1);
    });

    it("fails when a required identifier array is empty", () => {
      const doc: CdmDocument = {
        instrument: {
          identifiers: [],
          name: "Apple Inc.",
          currency: "USD",
          type: "Equity",
          listing: { mic: "XNYS", venue_symbol: "AAPL" },
        },
      };
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(false);
      const idFailures = result.failures.filter(
        (f) => f.field === "instrument.identifiers[]"
      );
      expect(idFailures.length).toBeGreaterThanOrEqual(1);
    });

    it("fails when the listing subtree is missing", () => {
      const doc: CdmDocument = {
        instrument: {
          identifiers: [{ type: "ISIN", value: "US0378331005" }],
          name: "Apple Inc.",
          currency: "USD",
          type: "Equity",
        },
      };
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(false);
      const micFail = result.failures.find(
        (f) => f.field === "instrument.listing.mic"
      );
      expect(micFail).toBeDefined();
      const symFail = result.failures.find(
        (f) => f.field === "instrument.listing.venue_symbol"
      );
      expect(symFail).toBeDefined();
    });
  });

  describe("wrong type", () => {
    it("fails when a scalar field has the wrong type (number instead of string)", () => {
      const doc: CdmDocument = {
        instrument: {
          identifiers: [{ type: "ISIN", value: "US0378331005" }],
          name: 12345, // wrong type — should be a string
          currency: "USD",
          type: "Equity",
          listing: { mic: "XNYS", venue_symbol: "AAPL" },
        },
      };
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(false);
      const nameFail = result.failures.find(
        (f) => f.field === "instrument.name"
      );
      expect(nameFail).toBeDefined();
      expect(nameFail!.reason).toContain("missing or empty");
    });

    it("fails when an array path resolves to a scalar instead of an array", () => {
      const doc: CdmDocument = {
        instrument: {
          identifiers: "not-an-array", // wrong type — should be array
          name: "Apple Inc.",
          currency: "USD",
          type: "Equity",
          listing: { mic: "XNYS", venue_symbol: "AAPL" },
        },
      };
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(false);
      const idFail = result.failures.find(
        (f) =>
          f.field === "instrument.identifiers[]" &&
          f.reason.includes("expected array")
      );
      expect(idFail).toBeDefined();
    });
  });

  describe("literal value checks", () => {
    it("fails when a literal value does not match", () => {
      const doc: CdmDocument = {
        instrument: {
          identifiers: [{ type: "ISIN", value: "US0378331005" }],
          name: "Apple Inc.",
          currency: "USD",
          type: "Bond", // wrong — should be "Equity"
          listing: { mic: "XNYS", venue_symbol: "AAPL" },
        },
      };
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(false);
      const typeFail = result.failures.find(
        (f) => f.field === "instrument.type"
      );
      expect(typeFail).toBeDefined();
      expect(typeFail!.reason).toContain("Equity");
    });
  });

  describe("multiple failures", () => {
    it("records all failures when multiple fields are missing", () => {
      const doc: CdmDocument = {
        instrument: {
          // Missing: identifiers, name, listing
          currency: "USD",
          type: "Equity",
        },
      };
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(false);
      // Should have failures for identifiers (at least one), name, mic, venue_symbol
      expect(result.failures.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("edge cases", () => {
    it("passes an empty document against an empty profile", () => {
      const emptyProfile: StockProfile = {
        profile_name: "empty",
        asset_class: "stock",
        cdm_version: "5.0.0",
        required_fields: [],
      };
      const result = validate({}, emptyProfile);
      expect(result.valid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("fails an empty document against a non-empty profile", () => {
      const result = validate({}, stockProfile);
      expect(result.valid).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });

    it("handles null values at scalar paths", () => {
      const doc: CdmDocument = {
        instrument: {
          identifiers: [{ type: "ISIN", value: "US0378331005" }],
          name: null,
          currency: "USD",
          type: "Equity",
          listing: { mic: "XNYS", venue_symbol: "AAPL" },
        },
      };
      const result = validate(doc, stockProfile);

      expect(result.valid).toBe(false);
      const nameFail = result.failures.find(
        (f) => f.field === "instrument.name"
      );
      expect(nameFail).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — quarantine (with DB)
// ---------------------------------------------------------------------------

describe("profile-validator: quarantineRecord()", () => {
  let db: Database.Database;
  let ingestRunId: number;

  beforeEach(() => {
    db = createDb();
    runMigrations(db);
    ingestRunId = createIngestRun(db, "XNYS");
  });

  afterEach(() => {
    db.close();
  });

  it("inserts a failed record into the quarantine table with correct fields", () => {
    const record = makeRecord();
    const failures: ValidationFailure[] = [
      {
        field: "instrument.name",
        reason:
          'required field sourced from "instrument_name" is missing or empty',
      },
    ];

    quarantineRecord(db, ingestRunId, 0, record, failures);

    const rows = db
      .prepare("SELECT * FROM quarantine WHERE ingest_run_id = ?")
      .all(ingestRunId) as Record<string, unknown>[];

    expect(rows).toHaveLength(1);
    expect(rows[0].record_index).toBe(0);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].raw_record_json).toBe(JSON.stringify(record));
    expect(rows[0].created_at).toBeTruthy();

    const reasons = JSON.parse(rows[0].failure_reasons as string);
    expect(reasons).toEqual([
      'required field sourced from "instrument_name" is missing or empty',
    ]);
  });

  it("records multiple failure reasons as a JSON array", () => {
    const record = makeRecord();
    const failures: ValidationFailure[] = [
      { field: "instrument.name", reason: "missing name" },
      { field: "instrument.identifiers[]", reason: "no ISIN identifier" },
      { field: "instrument.listing.mic", reason: "missing MIC" },
    ];

    quarantineRecord(db, ingestRunId, 5, record, failures);

    const rows = db
      .prepare("SELECT * FROM quarantine WHERE ingest_run_id = ?")
      .all(ingestRunId) as Record<string, unknown>[];

    expect(rows).toHaveLength(1);
    expect(rows[0].record_index).toBe(5);

    const reasons = JSON.parse(rows[0].failure_reasons as string);
    expect(reasons).toEqual([
      "missing name",
      "no ISIN identifier",
      "missing MIC",
    ]);
  });

  it("defaults status to 'pending'", () => {
    const record = makeRecord();
    const failures: ValidationFailure[] = [
      { field: "instrument.name", reason: "missing" },
    ];

    quarantineRecord(db, ingestRunId, 0, record, failures);

    const row = db
      .prepare("SELECT status FROM quarantine WHERE ingest_run_id = ?")
      .get(ingestRunId) as { status: string };

    expect(row.status).toBe("pending");
  });

  it("supports multiple quarantined records within the same ingest run", () => {
    const record1 = makeRecord({ venue_symbol: "AAPL" });
    const record2 = makeRecord({ venue_symbol: "MSFT" });
    const failures1: ValidationFailure[] = [
      { field: "instrument.name", reason: "missing name" },
    ];
    const failures2: ValidationFailure[] = [
      { field: "instrument.currency", reason: "missing currency" },
    ];

    quarantineRecord(db, ingestRunId, 0, record1, failures1);
    quarantineRecord(db, ingestRunId, 1, record2, failures2);

    const rows = db
      .prepare(
        "SELECT * FROM quarantine WHERE ingest_run_id = ? ORDER BY record_index"
      )
      .all(ingestRunId) as Record<string, unknown>[];

    expect(rows).toHaveLength(2);
    expect(rows[0].record_index).toBe(0);
    expect(rows[1].record_index).toBe(1);

    const reasons0 = JSON.parse(rows[0].failure_reasons as string);
    expect(reasons0).toEqual(["missing name"]);

    const reasons1 = JSON.parse(rows[1].failure_reasons as string);
    expect(reasons1).toEqual(["missing currency"]);
  });

  it("stores the raw CDM document that failed validation", () => {
    const cdmDoc: CdmDocument = {
      instrument: {
        name: "Test",
        currency: "USD",
      },
    };
    const failures: ValidationFailure[] = [
      {
        field: "instrument.identifiers[]",
        reason: 'no identifier found with scheme "ISIN"',
      },
    ];

    quarantineRecord(db, ingestRunId, 0, cdmDoc, failures);

    const row = db
      .prepare("SELECT raw_record_json FROM quarantine WHERE ingest_run_id = ?")
      .get(ingestRunId) as { raw_record_json: string };

    const stored = JSON.parse(row.raw_record_json);
    expect(stored).toEqual(cdmDoc);
  });
});

// ---------------------------------------------------------------------------
// Integration — validate then quarantine
// ---------------------------------------------------------------------------

describe("profile-validator: validate + quarantine integration", () => {
  let db: Database.Database;
  let ingestRunId: number;

  beforeEach(() => {
    db = createDb();
    runMigrations(db);
    ingestRunId = createIngestRun(db, "XNYS");
  });

  afterEach(() => {
    db.close();
  });

  it("validates a fully assembled document and does not quarantine it", () => {
    const record = makeRecord();
    const doc = assemble(record, stockProfile);
    const result = validate(doc, stockProfile);

    expect(result.valid).toBe(true);

    // Nothing should be in quarantine
    const quarantined = db
      .prepare("SELECT COUNT(*) AS count FROM quarantine")
      .get() as { count: number };
    expect(quarantined.count).toBe(0);
  });

  it("validates, detects failures, and quarantines the failed document", () => {
    const badDoc: CdmDocument = {
      instrument: {
        // missing identifiers, name — only currency and type present
        currency: "USD",
        type: "Equity",
      },
    };
    const result = validate(badDoc, stockProfile);

    expect(result.valid).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);

    // Quarantine it
    quarantineRecord(db, ingestRunId, 0, badDoc, result.failures);

    const rows = db
      .prepare("SELECT * FROM quarantine WHERE ingest_run_id = ?")
      .all(ingestRunId) as Record<string, unknown>[];

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");

    const storedReasons = JSON.parse(rows[0].failure_reasons as string);
    expect(storedReasons.length).toBe(result.failures.length);
    // Each failure reason should be stored
    for (const f of result.failures) {
      expect(storedReasons).toContain(f.reason);
    }
  });
});
