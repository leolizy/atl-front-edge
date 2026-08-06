import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Migrator } from "../src/db/migrator.js";
import { migration001, migration002 } from "../src/db/index.js";
import { assemble } from "../src/assembler/cdm-assembler.js";
import { validate } from "../src/validator/profile-validator.js";
import { loadStaticRecords } from "../src/static/load-static.js";
import type {
  StockProfile,
  NormalizedRecord,
  CdmDocument,
} from "../src/assembler/types.js";
import type { ValidationResult } from "../src/validator/types.js";

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const cashProfile: StockProfile = {
  profile_name: "cash-v1",
  asset_class: "cash",
  cdm_version: "5.0.0",
  required_fields: [
    { cdm_path: "product.type", value: "Cash" },
    { cdm_path: "product.name", source: "instrument_name" },
    { cdm_path: "product.currency", source: "currency" },
    { cdm_path: "product.cash.fixedDeposit.amount", source: "deposit_amount" },
    { cdm_path: "product.cash.fixedDeposit.currency", source: "currency" },
    {
      cdm_path: "product.cash.fixedDeposit.maturityDate",
      source: "maturity_date",
    },
    { cdm_path: "product.cash.fixedDeposit.fixedRate", source: "fixed_rate" },
    {
      cdm_path: "product.cash.fixedDeposit.depositType",
      source: "deposit_type",
    },
  ],
};

const loanProfile: StockProfile = {
  profile_name: "loan-v1",
  asset_class: "loan",
  cdm_version: "5.0.0",
  required_fields: [
    { cdm_path: "product.type", value: "Loan" },
    { cdm_path: "product.name", source: "instrument_name" },
    { cdm_path: "product.currency", source: "currency" },
    { cdm_path: "product.loan.notionalAmount", source: "notional_amount" },
    { cdm_path: "product.loan.notionalCurrency", source: "currency" },
    { cdm_path: "product.loan.maturityDate", source: "maturity_date" },
    { cdm_path: "product.loan.interestRate", source: "interest_rate" },
    { cdm_path: "product.loan.borrowerType", source: "borrower_type" },
    { cdm_path: "product.loan.facilityType", source: "facility_type" },
  ],
};

const digitalAssetProfile: StockProfile = {
  profile_name: "digital-asset-v1",
  asset_class: "digital_asset",
  cdm_version: "5.0.0",
  required_fields: [
    { cdm_path: "product.type", value: "DigitalAsset" },
    { cdm_path: "product.name", source: "instrument_name" },
    { cdm_path: "product.currency", source: "currency" },
    { cdm_path: "product.digitalAsset.ticker", source: "ticker" },
    { cdm_path: "product.digitalAsset.blockchain", source: "blockchain" },
    {
      cdm_path: "product.digitalAsset.decimalPlaces",
      source: "decimal_places",
    },
    { cdm_path: "product.digitalAsset.assetType", source: "asset_type" },
  ],
};

// ---------------------------------------------------------------------------
// Sample records
// ---------------------------------------------------------------------------

const cashRecord: Record<string, string> = {
  mic: "cash-v1",
  venue_symbol: "FIXED-DEPOSIT-USD-1M",
  asset_class: "cash",
  currency: "USD",
  instrument_name: "USD Fixed Deposit 1Y",
  deposit_amount: "10000000",
  maturity_date: "2027-06-15",
  fixed_rate: "4.5",
  deposit_type: "TERM",
};

const loanRecord: Record<string, string> = {
  mic: "loan-v1",
  venue_symbol: "CORP-LOAN-FAC-500M",
  asset_class: "loan",
  currency: "USD",
  instrument_name: "Corporate Loan Facility",
  notional_amount: "500000000",
  maturity_date: "2029-03-01",
  interest_rate: "5.75",
  borrower_type: "CORPORATE",
  facility_type: "TERM_LOAN",
};

const digitalAssetRecord: Record<string, string> = {
  mic: "digital-asset-v1",
  venue_symbol: "BTC",
  asset_class: "digital_asset",
  currency: "USD",
  instrument_name: "Bitcoin",
  ticker: "BTC",
  blockchain: "BITCOIN",
  decimal_places: "8",
  asset_type: "CRYPTOCURRENCY",
};

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function runMigrations(db: Database.Database): void {
  new Migrator(db).migrate([migration001, migration002]);
}

// ---------------------------------------------------------------------------
// Assembly tests
// ---------------------------------------------------------------------------

describe("static profiles: assembly", () => {
  describe("cash profile", () => {
    it("assembles a fixed deposit record into a CDM document", () => {
      const doc = assemble(
        cashRecord as unknown as NormalizedRecord,
        cashProfile
      );

      expect(doc).toEqual({
        product: {
          type: "Cash",
          name: "USD Fixed Deposit 1Y",
          currency: "USD",
          cash: {
            fixedDeposit: {
              amount: "10000000",
              currency: "USD",
              maturityDate: "2027-06-15",
              fixedRate: "4.5",
              depositType: "TERM",
            },
          },
        },
      });
    });

    it("sets the product type literal from the profile", () => {
      const doc = assemble(
        cashRecord as unknown as NormalizedRecord,
        cashProfile
      );
      expect((doc.product as Record<string, unknown>).type).toBe("Cash");
    });
  });

  describe("loan profile", () => {
    it("assembles a corporate loan record into a CDM document", () => {
      const doc = assemble(
        loanRecord as unknown as NormalizedRecord,
        loanProfile
      );

      expect(doc).toEqual({
        product: {
          type: "Loan",
          name: "Corporate Loan Facility",
          currency: "USD",
          loan: {
            notionalAmount: "500000000",
            notionalCurrency: "USD",
            maturityDate: "2029-03-01",
            interestRate: "5.75",
            borrowerType: "CORPORATE",
            facilityType: "TERM_LOAN",
          },
        },
      });
    });
  });

  describe("digital asset profile", () => {
    it("assembles a Bitcoin record into a CDM document", () => {
      const doc = assemble(
        digitalAssetRecord as unknown as NormalizedRecord,
        digitalAssetProfile
      );

      expect(doc).toEqual({
        product: {
          type: "DigitalAsset",
          name: "Bitcoin",
          currency: "USD",
          digitalAsset: {
            ticker: "BTC",
            blockchain: "BITCOIN",
            decimalPlaces: "8",
            assetType: "CRYPTOCURRENCY",
          },
        },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("static profiles: validation", () => {
  describe("cash profile", () => {
    it("validates a fully assembled fixed deposit document", () => {
      const doc = assemble(
        cashRecord as unknown as NormalizedRecord,
        cashProfile
      );
      const result: ValidationResult = validate(doc, cashProfile);
      expect(result.valid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("fails when a required field is missing", () => {
      const doc: CdmDocument = {
        product: {
          type: "Cash",
          name: "Test",
          currency: "USD",
          cash: {
            fixedDeposit: {
              // missing: amount, maturityDate, fixedRate, depositType
              currency: "USD",
            },
          },
        },
      };
      const result = validate(doc, cashProfile);
      expect(result.valid).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });

    it("fails when the product type literal is wrong", () => {
      const doc: CdmDocument = {
        product: {
          type: "Bond",
          name: "Test",
          currency: "USD",
          cash: {
            fixedDeposit: {
              amount: "10000000",
              currency: "USD",
              maturityDate: "2027-06-15",
              fixedRate: "4.5",
              depositType: "TERM",
            },
          },
        },
      };
      const result = validate(doc, cashProfile);
      expect(result.valid).toBe(false);
      const typeFail = result.failures.find((f) => f.field === "product.type");
      expect(typeFail).toBeDefined();
      expect(typeFail!.reason).toContain("Cash");
    });
  });

  describe("loan profile", () => {
    it("validates a fully assembled loan document", () => {
      const doc = assemble(
        loanRecord as unknown as NormalizedRecord,
        loanProfile
      );
      const result = validate(doc, loanProfile);
      expect(result.valid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("fails when the product type literal is wrong", () => {
      const doc: CdmDocument = {
        product: {
          type: "Cash",
          name: "Test",
          currency: "USD",
          loan: {
            notionalAmount: "500000000",
            notionalCurrency: "USD",
            maturityDate: "2029-03-01",
            interestRate: "5.75",
            borrowerType: "CORPORATE",
            facilityType: "TERM_LOAN",
          },
        },
      };
      const result = validate(doc, loanProfile);
      expect(result.valid).toBe(false);
      const typeFail = result.failures.find((f) => f.field === "product.type");
      expect(typeFail).toBeDefined();
      expect(typeFail!.reason).toContain("Loan");
    });
  });

  describe("digital asset profile", () => {
    it("validates a fully assembled digital asset document", () => {
      const doc = assemble(
        digitalAssetRecord as unknown as NormalizedRecord,
        digitalAssetProfile
      );
      const result = validate(doc, digitalAssetProfile);
      expect(result.valid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("fails when the product type literal is wrong", () => {
      const doc: CdmDocument = {
        product: {
          type: "Equity",
          name: "Test",
          currency: "USD",
          digitalAsset: {
            ticker: "BTC",
            blockchain: "BITCOIN",
            decimalPlaces: "8",
            assetType: "CRYPTOCURRENCY",
          },
        },
      };
      const result = validate(doc, digitalAssetProfile);
      expect(result.valid).toBe(false);
      const typeFail = result.failures.find((f) => f.field === "product.type");
      expect(typeFail).toBeDefined();
      expect(typeFail!.reason).toContain("DigitalAsset");
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: loadStaticRecords
// ---------------------------------------------------------------------------

describe("static profiles: loadStaticRecords()", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("cash", () => {
    it("loads a fixed deposit record into the instruments table", () => {
      loadStaticRecords(db, cashProfile, [cashRecord], "2026-06-01");

      const rows = db
        .prepare(
          "SELECT * FROM instruments WHERE mic = 'cash-v1' AND recorded_to IS NULL"
        )
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);

      const row = rows[0];
      expect(row.mic).toBe("cash-v1");
      expect(row.venue_symbol).toBe("FIXED-DEPOSIT-USD-1M");
      expect(row.asset_class).toBe("cash");
      expect(row.currency).toBe("USD");
      expect(row.effective_from).toBe("2026-06-01");
      expect(row.effective_to).toBeNull();
      expect(row.recorded_to).toBeNull();
      expect(row.content_hash).toBeTruthy();

      const cdm = JSON.parse(row.cdm_json as string);
      expect(cdm.product.type).toBe("Cash");
      expect(cdm.product.cash.fixedDeposit.amount).toBe("10000000");
      expect(cdm.product.cash.fixedDeposit.fixedRate).toBe("4.5");
    });

    it("creates a synthetic ingest_run with static_load outcome", () => {
      loadStaticRecords(db, cashProfile, [cashRecord], "2026-06-01");

      const runs = db
        .prepare("SELECT * FROM ingest_runs WHERE venue = 'cash-v1'")
        .all() as Record<string, unknown>[];
      expect(runs).toHaveLength(1);

      const run = runs[0];
      expect(run.outcome).toBe("static_load");
      expect(run.records_total).toBe(1);
      expect(run.records_added).toBe(1);
      expect(run.records_quarantined).toBe(0);
      expect(run.records_updated).toBe(0);
      expect(run.records_delisted).toBe(0);
    });

    it("links the instrument row to the ingest_run", () => {
      loadStaticRecords(db, cashProfile, [cashRecord], "2026-06-01");

      const row = db
        .prepare(
          "SELECT i.ingest_run_id, r.outcome " +
            "FROM instruments i JOIN ingest_runs r ON i.ingest_run_id = r.id " +
            "WHERE i.mic = 'cash-v1'"
        )
        .get() as { ingest_run_id: number; outcome: string };
      expect(row.outcome).toBe("static_load");
    });
  });

  describe("loan", () => {
    it("loads a corporate loan record into the instruments table", () => {
      loadStaticRecords(db, loanProfile, [loanRecord], "2026-01-15");

      const rows = db
        .prepare(
          "SELECT * FROM instruments WHERE mic = 'loan-v1' AND recorded_to IS NULL"
        )
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);

      const cdm = JSON.parse(rows[0].cdm_json as string);
      expect(cdm.product.type).toBe("Loan");
      expect(cdm.product.loan.notionalAmount).toBe("500000000");
      expect(cdm.product.loan.interestRate).toBe("5.75");
      expect(cdm.product.loan.borrowerType).toBe("CORPORATE");
    });
  });

  describe("digital asset", () => {
    it("loads a Bitcoin record into the instruments table", () => {
      loadStaticRecords(
        db,
        digitalAssetProfile,
        [digitalAssetRecord],
        "2026-06-01"
      );

      const rows = db
        .prepare(
          "SELECT * FROM instruments WHERE mic = 'digital-asset-v1' AND recorded_to IS NULL"
        )
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);

      const cdm = JSON.parse(rows[0].cdm_json as string);
      expect(cdm.product.type).toBe("DigitalAsset");
      expect(cdm.product.digitalAsset.ticker).toBe("BTC");
      expect(cdm.product.digitalAsset.blockchain).toBe("BITCOIN");
      expect(cdm.product.digitalAsset.decimalPlaces).toBe("8");
    });
  });

  describe("multiple records per profile", () => {
    it("loads multiple records in a single call", () => {
      const record2: Record<string, string> = {
        ...cashRecord,
        venue_symbol: "FIXED-DEPOSIT-USD-2M",
        deposit_amount: "20000000",
        instrument_name: "USD Fixed Deposit 2Y",
      };

      loadStaticRecords(db, cashProfile, [cashRecord, record2], "2026-06-01");

      const rows = db
        .prepare(
          "SELECT * FROM instruments WHERE mic = 'cash-v1' AND recorded_to IS NULL ORDER BY venue_symbol"
        )
        .all() as Record<string, unknown>[];

      expect(rows).toHaveLength(2);
      expect(rows[0].venue_symbol).toBe("FIXED-DEPOSIT-USD-1M");
      expect(rows[1].venue_symbol).toBe("FIXED-DEPOSIT-USD-2M");

      const run = db
        .prepare("SELECT * FROM ingest_runs WHERE venue = 'cash-v1'")
        .get() as Record<string, unknown>;
      expect(run.records_total).toBe(2);
      expect(run.records_added).toBe(2);
    });
  });

  describe("error handling", () => {
    it("throws when a record fails validation", () => {
      const badRecord = {
        ...cashRecord,
        deposit_amount: undefined, // missing required field
      };

      expect(() => {
        loadStaticRecords(db, cashProfile, [badRecord], "2026-06-01");
      }).toThrow(/validation failed/i);
    });

    it("throws with failure details in the error message", () => {
      const badRecord = {
        ...cashRecord,
        fixed_rate: "", // empty string fails validation
      };

      expect(() => {
        loadStaticRecords(db, cashProfile, [badRecord], "2026-06-01");
      }).toThrow(/product\.cash\.fixedDeposit\.fixedRate/);
    });
  });

  describe("bitemporal columns", () => {
    it("sets effective_from to the provided date", () => {
      loadStaticRecords(db, cashProfile, [cashRecord], "2025-12-01");

      const row = db
        .prepare(
          "SELECT effective_from FROM instruments WHERE mic = 'cash-v1' AND recorded_to IS NULL"
        )
        .get() as { effective_from: string };
      expect(row.effective_from).toBe("2025-12-01");
    });

    it("leaves effective_to and recorded_to as NULL", () => {
      loadStaticRecords(db, cashProfile, [cashRecord], "2026-06-01");

      const row = db
        .prepare(
          "SELECT effective_to, recorded_to FROM instruments WHERE mic = 'cash-v1' AND recorded_to IS NULL"
        )
        .get() as { effective_to: null; recorded_to: null };
      expect(row.effective_to).toBeNull();
      expect(row.recorded_to).toBeNull();
    });

    it("sets recorded_from to a non-null timestamp", () => {
      loadStaticRecords(db, cashProfile, [cashRecord], "2026-06-01");

      const row = db
        .prepare(
          "SELECT recorded_from FROM instruments WHERE mic = 'cash-v1' AND recorded_to IS NULL"
        )
        .get() as { recorded_from: string };
      expect(row.recorded_from).toBeTruthy();
      // Must be valid ISO 8601
      expect(() => new Date(row.recorded_from)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Migration: CHECK constraint expansion
// ---------------------------------------------------------------------------

describe("static profiles: migration 002", () => {
  it("accepts 'cash' in the asset_class column after migration", () => {
    const db = createDb();
    new Migrator(db).migrate([migration001, migration002]);

    expect(() => {
      db.prepare(
        "INSERT INTO instruments (mic, venue_symbol, asset_class, currency, cdm_json, content_hash, effective_from, recorded_from) " +
          "VALUES ('cash-v1', 'X', 'cash', 'USD', '{}', 'x', '2026-01-01', ?)"
      ).run(new Date().toISOString());
    }).not.toThrow();

    db.close();
  });

  it("accepts 'loan' in the asset_class column after migration", () => {
    const db = createDb();
    new Migrator(db).migrate([migration001, migration002]);

    expect(() => {
      db.prepare(
        "INSERT INTO instruments (mic, venue_symbol, asset_class, currency, cdm_json, content_hash, effective_from, recorded_from) " +
          "VALUES ('loan-v1', 'Y', 'loan', 'USD', '{}', 'x', '2026-01-01', ?)"
      ).run(new Date().toISOString());
    }).not.toThrow();

    db.close();
  });

  it("accepts 'digital_asset' in the asset_class column after migration", () => {
    const db = createDb();
    new Migrator(db).migrate([migration001, migration002]);

    expect(() => {
      db.prepare(
        "INSERT INTO instruments (mic, venue_symbol, asset_class, currency, cdm_json, content_hash, effective_from, recorded_from) " +
          "VALUES ('da-v1', 'Z', 'digital_asset', 'USD', '{}', 'x', '2026-01-01', ?)"
      ).run(new Date().toISOString());
    }).not.toThrow();

    db.close();
  });

  it("accepts 'static_load' in the ingest_runs outcome column", () => {
    const db = createDb();
    new Migrator(db).migrate([migration001, migration002]);

    expect(() => {
      db.prepare(
        "INSERT INTO ingest_runs (venue, records_total, records_added, outcome, run_started_at, run_completed_at) " +
          "VALUES ('test', 1, 1, 'static_load', ?, ?)"
      ).run(new Date().toISOString(), new Date().toISOString());
    }).not.toThrow();

    db.close();
  });

  it("still rejects unknown asset classes after migration", () => {
    const db = createDb();
    new Migrator(db).migrate([migration001, migration002]);

    expect(() => {
      db.prepare(
        "INSERT INTO instruments (mic, venue_symbol, asset_class, currency, cdm_json, content_hash, effective_from, recorded_from) " +
          "VALUES ('X', 'B', 'bonds', 'USD', '{}', 'x', '2026-01-01', ?)"
      ).run(new Date().toISOString());
    }).toThrow(/CHECK constraint/);

    db.close();
  });

  it("still rejects unknown ingest outcomes after migration", () => {
    const db = createDb();
    new Migrator(db).migrate([migration001, migration002]);

    expect(() => {
      db.prepare(
        "INSERT INTO ingest_runs (venue, records_total, records_added, outcome, run_started_at, run_completed_at) " +
          "VALUES ('test', 1, 1, 'unknown_outcome', ?, ?)"
      ).run(new Date().toISOString(), new Date().toISOString());
    }).toThrow(/CHECK constraint/);

    db.close();
  });

  it("preserves existing stock records across migration", () => {
    const db = createDb();
    new Migrator(db).migrate([migration001]);

    // Insert a stock record before migration 002
    db.prepare(
      "INSERT INTO instruments (mic, venue_symbol, asset_class, currency, cdm_json, content_hash, effective_from, recorded_from) " +
        "VALUES ('XNYS', 'AAPL', 'stock', 'USD', '{}', 'abc', '2026-01-01', ?)"
    ).run(new Date().toISOString());

    // Run migration 002
    new Migrator(db).migrate([migration001, migration002]);

    // Stock record should still exist
    const row = db
      .prepare(
        "SELECT * FROM instruments WHERE mic = 'XNYS' AND venue_symbol = 'AAPL'"
      )
      .get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.asset_class).toBe("stock");

    db.close();
  });

  it("preserves existing ingest runs across migration", () => {
    const db = createDb();
    new Migrator(db).migrate([migration001]);

    db.prepare(
      "INSERT INTO ingest_runs (venue, records_total, records_added, outcome, run_started_at, run_completed_at) " +
        "VALUES ('XNYS', 10, 5, 'success', ?, ?)"
    ).run(new Date().toISOString(), new Date().toISOString());

    new Migrator(db).migrate([migration001, migration002]);

    const run = db
      .prepare("SELECT * FROM ingest_runs WHERE venue = 'XNYS'")
      .get() as Record<string, unknown>;
    expect(run).toBeTruthy();
    expect(run.outcome).toBe("success");
    expect(run.records_total).toBe(10);

    db.close();
  });

  it("is idempotent — running migration 002 twice does not fail", () => {
    const db = createDb();
    new Migrator(db).migrate([migration001, migration002]);

    // Second run should be a no-op (migrator skips already-applied versions)
    expect(() => {
      new Migrator(db).migrate([migration001, migration002]);
    }).not.toThrow();

    db.close();
  });
});
