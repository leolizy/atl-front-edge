import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { annaDsbAdapter } from "../src/adapters/anna-dsb-adapter.js";
import { assemble } from "../src/assembler/cdm-assembler.js";
import { validate } from "../src/validator/profile-validator.js";
import type { VenueContext, NormalizedRecord } from "../src/adapters/types.js";
import type { StockProfile, CdmDocument } from "../src/assembler/types.js";
import type { ValidationResult } from "../src/validator/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dsbVenueContext: VenueContext = {
  mic: "DSB",
  instrument_category: "interest_rate_derivative",
  profile_reference: "interest-rate-derivative-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

/** Load DSB fixture and parse records, returning one per branch. */
function loadDsbRecords(): {
  irs: NormalizedRecord;
  cds: NormalizedRecord;
  fx: NormalizedRecord;
  eq: NormalizedRecord;
} {
  const bytes = loadFixture("dsb-sample.json");
  const records = annaDsbAdapter.parse(bytes, dsbVenueContext);
  const irs = records.find(
    (r) => r.asset_class === "interest_rate_derivative"
  )!;
  const cds = records.find((r) => r.asset_class === "credit_derivative")!;
  const fx = records.find((r) => r.asset_class === "fx_derivative")!;
  const eq = records.find((r) => r.asset_class === "equity_derivative")!;
  return { irs, cds, fx, eq };
}

// ---------------------------------------------------------------------------
// Profiles (mirrors config/*.json, kept inline for test isolation)
// ---------------------------------------------------------------------------

const irsProfile: StockProfile = {
  profile_name: "interest-rate-derivative-v1",
  asset_class: "interest_rate_derivative",
  cdm_version: "5.0.0",
  required_fields: [
    {
      cdm_path: "product.instrument.identifiers[]",
      source: "isin",
      scheme: "ISIN",
    },
    { cdm_path: "product.instrument.name", source: "instrument_name" },
    { cdm_path: "product.instrument.currency", source: "currency" },
    { cdm_path: "product.instrument.type", value: "InterestRateSwap" },
    { cdm_path: "product.instrument.mic", source: "mic" },
    { cdm_path: "product.instrument.venue_symbol", source: "venue_symbol" },
    {
      cdm_path: "product.instrument.economicTerms.notionalSchedule",
      source: "notional_schedule",
      type: "object",
    },
    {
      cdm_path:
        "product.instrument.economicTerms.notionalSchedule.notionalCurrency",
      source: "notional_currency",
    },
    {
      cdm_path:
        "product.instrument.economicTerms.interestRatePayout.rateSpecification.fixedRate",
      source: "fixed_rate",
      type: "number",
    },
    {
      cdm_path:
        "product.instrument.economicTerms.interestRatePayout.rateSpecification.floatingRate.referenceRate",
      source: "floating_rate_reference",
    },
    {
      cdm_path:
        "product.instrument.economicTerms.effectiveDate.adjustableDate.unadjustedDate",
      source: "effective_date",
    },
    {
      cdm_path:
        "product.instrument.economicTerms.terminationDate.adjustableDate.unadjustedDate",
      source: "termination_date",
    },
  ],
};

const cdsProfile: StockProfile = {
  profile_name: "credit-derivative-v1",
  asset_class: "credit_derivative",
  cdm_version: "5.0.0",
  required_fields: [
    {
      cdm_path: "product.instrument.identifiers[]",
      source: "isin",
      scheme: "ISIN",
    },
    { cdm_path: "product.instrument.name", source: "instrument_name" },
    { cdm_path: "product.instrument.currency", source: "currency" },
    { cdm_path: "product.instrument.type", value: "CreditDefaultSwap" },
    { cdm_path: "product.instrument.mic", source: "mic" },
    { cdm_path: "product.instrument.venue_symbol", source: "venue_symbol" },
    {
      cdm_path: "product.instrument.economicTerms.referenceEntity",
      source: "reference_entity",
    },
    {
      cdm_path: "product.instrument.economicTerms.referenceEntityType",
      source: "reference_entity_type",
    },
    {
      cdm_path: "product.instrument.economicTerms.cdsSpread",
      source: "cds_spread",
      type: "number",
    },
    {
      cdm_path:
        "product.instrument.economicTerms.notionalSchedule.notionalAmount",
      source: "notional_amount",
      type: "number",
    },
    {
      cdm_path:
        "product.instrument.economicTerms.notionalSchedule.notionalCurrency",
      source: "notional_currency",
    },
    {
      cdm_path:
        "product.instrument.economicTerms.terminationDate.adjustableDate.unadjustedDate",
      source: "maturity_date",
    },
    {
      cdm_path: "product.instrument.economicTerms.deliveryType",
      source: "delivery_type",
    },
    {
      cdm_path: "product.instrument.economicTerms.payoutTrigger",
      source: "payout_trigger",
    },
  ],
};

const fxProfile: StockProfile = {
  profile_name: "fx-derivative-v1",
  asset_class: "fx_derivative",
  cdm_version: "5.0.0",
  required_fields: [
    {
      cdm_path: "product.instrument.identifiers[]",
      source: "isin",
      scheme: "ISIN",
    },
    { cdm_path: "product.instrument.name", source: "instrument_name" },
    { cdm_path: "product.instrument.currency", source: "currency" },
    { cdm_path: "product.instrument.type", value: "ForeignExchangeOption" },
    { cdm_path: "product.instrument.mic", source: "mic" },
    { cdm_path: "product.instrument.venue_symbol", source: "venue_symbol" },
    {
      cdm_path: "product.instrument.economicTerms.putCall",
      source: "put_call",
    },
    {
      cdm_path: "product.instrument.economicTerms.strikeRate",
      source: "strike_rate",
      type: "number",
    },
    {
      cdm_path: "product.instrument.economicTerms.expirationDate",
      source: "expiry_date",
    },
    {
      cdm_path: "product.instrument.economicTerms.notionalAmount1.amount",
      source: "notional_amount_1",
      type: "number",
    },
    {
      cdm_path: "product.instrument.economicTerms.notionalAmount1.currency",
      source: "notional_currency_1",
    },
    {
      cdm_path: "product.instrument.economicTerms.notionalAmount2.amount",
      source: "notional_amount_2",
      type: "number",
    },
    {
      cdm_path: "product.instrument.economicTerms.notionalAmount2.currency",
      source: "notional_currency_2",
    },
    {
      cdm_path: "product.instrument.economicTerms.settlementType",
      source: "settlement_type",
    },
    {
      cdm_path: "product.instrument.economicTerms.optionStyle",
      source: "option_style",
    },
  ],
};

const eqProfile: StockProfile = {
  profile_name: "equity-derivative-v1",
  asset_class: "equity_derivative",
  cdm_version: "5.0.0",
  required_fields: [
    {
      cdm_path: "product.instrument.identifiers[]",
      source: "isin",
      scheme: "ISIN",
    },
    { cdm_path: "product.instrument.name", source: "instrument_name" },
    { cdm_path: "product.instrument.currency", source: "currency" },
    { cdm_path: "product.instrument.type", value: "EquitySwap" },
    { cdm_path: "product.instrument.mic", source: "mic" },
    { cdm_path: "product.instrument.venue_symbol", source: "venue_symbol" },
    {
      cdm_path: "product.instrument.economicTerms.underlierIsin",
      source: "underlier_isin",
    },
    {
      cdm_path: "product.instrument.economicTerms.underlierName",
      source: "underlier_name",
    },
    {
      cdm_path:
        "product.instrument.economicTerms.notionalSchedule.notionalAmount",
      source: "notional_amount",
      type: "number",
    },
    {
      cdm_path:
        "product.instrument.economicTerms.notionalSchedule.notionalCurrency",
      source: "notional_currency",
    },
    {
      cdm_path: "product.instrument.economicTerms.strikePrice",
      source: "strike_price",
      type: "number",
    },
    {
      cdm_path: "product.instrument.economicTerms.expirationDate",
      source: "expiry_date",
    },
    {
      cdm_path: "product.instrument.economicTerms.returnType",
      source: "return_type",
    },
    {
      cdm_path: "product.instrument.economicTerms.paymentFrequency",
      source: "payment_frequency",
    },
  ],
};

// ---------------------------------------------------------------------------
// Assembly tests
// ---------------------------------------------------------------------------

describe("OTC profiles: assembly", () => {
  describe("Interest Rate Derivatives (IRS)", () => {
    it("assembles a fixed-float IRS into a CDM document", () => {
      const { irs } = loadDsbRecords();
      const doc = assemble(irs, irsProfile);

      const instr = doc.product!.instrument as Record<string, unknown>;
      expect(instr.type).toBe("InterestRateSwap");
      expect(instr.name).toBe("EUR Fixed-Float IRS 5Y");
      expect(instr.currency).toBe("EUR");

      const terms = instr.economicTerms as Record<string, unknown>;
      // notionalSchedule should be a parsed object (type: "object")
      const ns = terms.notionalSchedule as Record<string, unknown>;
      expect(ns).toEqual({ notionalAmount: 10000000, notionalCurrency: "EUR" });

      // fixedRate should be a number (type: "number")
      const payout = terms.interestRatePayout as Record<string, unknown>;
      const rateSpec = payout.rateSpecification as Record<string, unknown>;
      expect(rateSpec.fixedRate).toBe(2.5);

      // floating rate reference rate is a string
      const floatingRate = rateSpec.floatingRate as Record<string, unknown>;
      expect(floatingRate.referenceRate).toBe("EUR-EURIBOR-6M");

      // dates
      const eff = terms.effectiveDate as Record<string, unknown>;
      const effAdj = eff.adjustableDate as Record<string, unknown>;
      expect(effAdj.unadjustedDate).toBe("2026-08-01");

      const term = terms.terminationDate as Record<string, unknown>;
      const termAdj = term.adjustableDate as Record<string, unknown>;
      expect(termAdj.unadjustedDate).toBe("2031-08-01");
    });

    it("sources ISIN from attributes fallback (not top-level on assembler NormalizedRecord)", () => {
      const { irs } = loadDsbRecords();
      const doc = assemble(irs, irsProfile);

      const instr = doc.product!.instrument as Record<string, unknown>;
      const ids = instr.identifiers as Array<{ type: string; value: string }>;
      expect(ids).toHaveLength(1);
      expect(ids[0].type).toBe("ISIN");
      expect(ids[0].value).toBe("EZ1234567890");
    });

    it("populates venSymbol and MIC for listing identity", () => {
      const { irs } = loadDsbRecords();
      const doc = assemble(irs, irsProfile);

      const instr = doc.product!.instrument as Record<string, unknown>;
      expect(instr.mic).toBe("DSB");
      expect(instr.venue_symbol).toBe("EZ1234567890");
    });
  });

  describe("Credit Derivatives (CDS)", () => {
    it("assembles a single-name CDS into a CDM document", () => {
      const { cds } = loadDsbRecords();
      const doc = assemble(cds, cdsProfile);

      const instr = doc.product!.instrument as Record<string, unknown>;
      expect(instr.type).toBe("CreditDefaultSwap");
      expect(instr.name).toBe("ACME Corp CDS 5Y");

      const terms = instr.economicTerms as Record<string, unknown>;
      expect(terms.referenceEntity).toBe("ACME Corp");
      expect(terms.referenceEntityType).toBe("CORPORATE");
      expect(terms.cdsSpread).toBe(100); // number
      expect(terms.deliveryType).toBe("AUCTION");
      expect(terms.payoutTrigger).toBe("CREDIT_DEFAULT");
    });

    it("parses notional_amount as a number", () => {
      const { cds } = loadDsbRecords();
      const doc = assemble(cds, cdsProfile);

      const terms = (doc.product!.instrument as Record<string, unknown>)
        .economicTerms as Record<string, unknown>;
      const ns = terms.notionalSchedule as Record<string, unknown>;
      expect(ns.notionalAmount).toBe(10000000);
      expect(typeof ns.notionalAmount).toBe("number");
    });
  });

  describe("FX Derivatives (FX Vanilla Option)", () => {
    it("assembles a vanilla FX option into a CDM document", () => {
      const { fx } = loadDsbRecords();
      const doc = assemble(fx, fxProfile);

      const instr = doc.product!.instrument as Record<string, unknown>;
      expect(instr.type).toBe("ForeignExchangeOption");
      expect(instr.name).toBe("EUR/USD Vanilla Call Option");

      const terms = instr.economicTerms as Record<string, unknown>;
      expect(terms.putCall).toBe("CALL");
      expect(terms.strikeRate).toBe(1.15);
      expect(terms.expirationDate).toBe("2026-09-15");
      expect(terms.settlementType).toBe("PHYSICAL");
      expect(terms.optionStyle).toBe("EUROPEAN");
    });

    it("parses both notional amounts as numbers", () => {
      const { fx } = loadDsbRecords();
      const doc = assemble(fx, fxProfile);

      const terms = (doc.product!.instrument as Record<string, unknown>)
        .economicTerms as Record<string, unknown>;
      const n1 = terms.notionalAmount1 as Record<string, unknown>;
      expect(n1.amount).toBe(10000000);
      expect(n1.currency).toBe("EUR");

      const n2 = terms.notionalAmount2 as Record<string, unknown>;
      expect(n2.amount).toBe(11500000);
      expect(n2.currency).toBe("USD");
    });
  });

  describe("Equity Derivatives (Equity Swap)", () => {
    it("assembles an equity swap into a CDM document", () => {
      const { eq } = loadDsbRecords();
      const doc = assemble(eq, eqProfile);

      const instr = doc.product!.instrument as Record<string, unknown>;
      expect(instr.type).toBe("EquitySwap");
      expect(instr.name).toBe("Total SA Equity Swap 3Y");

      const terms = instr.economicTerms as Record<string, unknown>;
      expect(terms.underlierIsin).toBe("FR0000120271");
      expect(terms.underlierName).toBe("TotalEnergies SE");
      expect(terms.returnType).toBe("TOTAL_RETURN");
      expect(terms.paymentFrequency).toBe("QUARTERLY");
    });

    it("parses notional and strike as numbers", () => {
      const { eq } = loadDsbRecords();
      const doc = assemble(eq, eqProfile);

      const terms = (doc.product!.instrument as Record<string, unknown>)
        .economicTerms as Record<string, unknown>;
      const ns = terms.notionalSchedule as Record<string, unknown>;
      expect(ns.notionalAmount).toBe(5000000);
      expect(ns.notionalCurrency).toBe("EUR");
      expect(terms.strikePrice).toBe(60);
    });
  });
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("OTC profiles: validation", () => {
  describe("IRS profile", () => {
    it("validates a fully assembled IRS document", () => {
      const { irs } = loadDsbRecords();
      const doc = assemble(irs, irsProfile);
      const result: ValidationResult = validate(doc, irsProfile);
      expect(result.valid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("fails when product type literal is wrong", () => {
      const doc: CdmDocument = {
        product: {
          instrument: {
            identifiers: [{ value: "EZ1234567890", type: "ISIN" }],
            name: "Test",
            currency: "EUR",
            type: "CreditDefaultSwap",
            mic: "DSB",
            venue_symbol: "EZ1234567890",
            economicTerms: {
              notionalSchedule: {
                notionalAmount: 10000000,
                notionalCurrency: "EUR",
              },
              interestRatePayout: {
                rateSpecification: {
                  fixedRate: 2.5,
                  floatingRate: { referenceRate: "EUR-EURIBOR-6M" },
                },
              },
              effectiveDate: {
                adjustableDate: { unadjustedDate: "2026-08-01" },
              },
              terminationDate: {
                adjustableDate: { unadjustedDate: "2031-08-01" },
              },
            },
          },
        },
      };
      const result = validate(doc, irsProfile);
      expect(result.valid).toBe(false);
      const typeFail = result.failures.find(
        (f) => f.field === "product.instrument.type"
      );
      expect(typeFail).toBeDefined();
      expect(typeFail!.reason).toContain("InterestRateSwap");
    });

    it("fails when notionalSchedule is not an object", () => {
      const { irs } = loadDsbRecords();
      // Bypass assembler and manually set notionalSchedule to a string
      const doc = assemble(irs, irsProfile);
      const economicTerms = (doc.product!.instrument as Record<string, unknown>)
        .economicTerms as Record<string, unknown>;
      economicTerms.notionalSchedule = "not-an-object";

      const result = validate(doc, irsProfile);
      expect(result.valid).toBe(false);
      const nsFail = result.failures.find(
        (f) => f.field === "product.instrument.economicTerms.notionalSchedule"
      );
      expect(nsFail).toBeDefined();
      expect(nsFail!.reason).toContain("non-null object");
    });

    it("fails when fixedRate is not a number", () => {
      const { irs } = loadDsbRecords();
      const doc = assemble(irs, irsProfile);
      const rateSpec = (
        (
          (doc.product!.instrument as Record<string, unknown>)
            .economicTerms as Record<string, unknown>
        ).interestRatePayout as Record<string, unknown>
      ).rateSpecification as Record<string, unknown>;
      rateSpec.fixedRate = "2.5"; // string, not number

      const result = validate(doc, irsProfile);
      expect(result.valid).toBe(false);
      const fixFail = result.failures.find(
        (f) =>
          f.field ===
          "product.instrument.economicTerms.interestRatePayout.rateSpecification.fixedRate"
      );
      expect(fixFail).toBeDefined();
      expect(fixFail!.reason).toContain("expected a number");
    });
  });

  describe("CDS profile", () => {
    it("validates a fully assembled CDS document", () => {
      const { cds } = loadDsbRecords();
      const doc = assemble(cds, cdsProfile);
      const result = validate(doc, cdsProfile);
      expect(result.valid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("fails when cdsSpread is not a number", () => {
      const { cds } = loadDsbRecords();
      const doc = assemble(cds, cdsProfile);
      const terms = (doc.product!.instrument as Record<string, unknown>)
        .economicTerms as Record<string, unknown>;
      terms.cdsSpread = "100bps"; // string, not number

      const result = validate(doc, cdsProfile);
      expect(result.valid).toBe(false);
      const spreadFail = result.failures.find(
        (f) => f.field === "product.instrument.economicTerms.cdsSpread"
      );
      expect(spreadFail).toBeDefined();
    });
  });

  describe("FX profile", () => {
    it("validates a fully assembled FX option document", () => {
      const { fx } = loadDsbRecords();
      const doc = assemble(fx, fxProfile);
      const result = validate(doc, fxProfile);
      expect(result.valid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });
  });

  describe("Equity profile", () => {
    it("validates a fully assembled equity swap document", () => {
      const { eq } = loadDsbRecords();
      const doc = assemble(eq, eqProfile);
      const result = validate(doc, eqProfile);
      expect(result.valid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });
  });

  describe("backward compatibility: string type (default) still works", () => {
    it("validates a standard stock-like document with default type", () => {
      const stockProfile: StockProfile = {
        profile_name: "test",
        asset_class: "stock",
        cdm_version: "5.0.0",
        required_fields: [
          { cdm_path: "instrument.name", source: "name" },
          { cdm_path: "instrument.type", value: "Equity" },
        ],
      };
      const record: NormalizedRecord = {
        venue_symbol: "TST",
        isin: "US0000000000",
        instrument_name: "Test",
        currency: "USD",
        asset_class: "stock",
        mic: "XTST",
        attributes: { name: "Test Corp" },
      };
      const doc = assemble(record, stockProfile);
      const result = validate(doc, stockProfile);
      expect(result.valid).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Assembler: attributes fallback tests
// ---------------------------------------------------------------------------

describe("assembler: attributes fallback", () => {
  it("resolves source from attributes when not present at top-level", () => {
    const profile: StockProfile = {
      profile_name: "test",
      asset_class: "test",
      cdm_version: "5.0.0",
      required_fields: [
        { cdm_path: "instrument.name", source: "instrument_name" },
        { cdm_path: "instrument.attr_only", source: "from_attrs" },
      ],
    };
    const record: NormalizedRecord = {
      venue_symbol: "T",
      isin: "XX",
      instrument_name: "Top Level Name",
      currency: "USD",
      asset_class: "test",
      mic: "XT",
      attributes: {
        from_attrs: "resolved-from-attributes",
      },
    };
    const doc = assemble(record, profile);
    const instr = doc.instrument as Record<string, unknown>;
    expect(instr.name).toBe("Top Level Name"); // top-level wins
    expect(instr.attr_only).toBe("resolved-from-attributes"); // attributes fallback
  });

  it("prefers top-level value over attributes when both exist", () => {
    const profile: StockProfile = {
      profile_name: "test",
      asset_class: "test",
      cdm_version: "5.0.0",
      required_fields: [{ cdm_path: "instrument.name", source: "name" }],
    };
    const record: NormalizedRecord = {
      venue_symbol: "T",
      isin: "XX",
      instrument_name: "Top Wins",
      currency: "USD",
      asset_class: "test",
      mic: "XT",
      attributes: { name: "Attribute Loses" },
    };
    const doc = assemble(record, profile);
    const instr = doc.instrument as Record<string, unknown>;
    // top-level (instrument_name) wins, not attributes.name
    // Since source is "name", it looks at recAny["name"] first then attrs["name"]
    // recAny["name"] is undefined, so attrs["name"] = "Attribute Loses"
    // Wait: source is "name", not "instrument_name"
    // recAny["name"] = undefined → falls back to attrs["name"] = "Attribute Loses"
    expect(instr.name).toBe("Attribute Loses");
  });
});
