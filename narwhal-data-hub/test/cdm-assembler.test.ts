import { describe, it, expect } from "vitest";
import { assemble } from "../src/assembler/cdm-assembler.js";
import type {
  NormalizedRecord,
  StockProfile,
  CdmDocument,
} from "../src/assembler/types.js";

/** A stock profile matching the checked-in config/stock-profile.json. */
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
    ...overrides,
  };
}

describe("cdm-assembler", () => {
  it("assembles a fully-populated record into a CDM document", () => {
    const record = makeRecord();
    const doc = assemble(record, stockProfile);

    expect(doc).toEqual({
      instrument: {
        identifiers: [
          { value: "US0378331005", type: "ISIN" },
          { value: "BBG000B9XRY4", type: "FIGI" },
        ],
        name: "Apple Inc.",
        currency: "USD",
        type: "Equity",
        listing: {
          mic: "XNYS",
          venue_symbol: "AAPL",
        },
      },
    });
  });

  it("sets literal values from the profile", () => {
    const record = makeRecord();
    const doc = assemble(record, stockProfile);

    expect((doc.instrument as Record<string, unknown>).type).toBe("Equity");
  });

  it("skips profile-declared fields that are absent from the record", () => {
    const record = makeRecord({
      isin: undefined,
      figi: undefined,
      cusip: undefined,
      sedol: undefined,
    });
    const doc = assemble(record, stockProfile);

    const instr = doc.instrument as Record<string, unknown>;
    expect(instr.identifiers).toBeUndefined();
    expect(instr.name).toBe("Apple Inc.");
    expect(instr.currency).toBe("USD");
  });

  it("skips record fields not declared in the profile", () => {
    const record = makeRecord({
      board_lot: 100,
      tick_size: 0.01,
    });
    const doc = assemble(record, stockProfile);

    // board_lot and tick_size should not leak into the CDM document
    const instr = doc.instrument as Record<string, unknown>;
    expect(instr).not.toHaveProperty("board_lot");
    expect(instr).not.toHaveProperty("tick_size");

    // The listing subtree should only contain profile-declared fields
    const listing = instr.listing as Record<string, unknown>;
    expect(listing).toEqual({
      mic: "XNYS",
      venue_symbol: "AAPL",
    });
  });

  it("handles a minimal record with only required fields", () => {
    const minimal: NormalizedRecord = {
      mic: "XNYS",
      venue_symbol: "AAPL",
      asset_class: "stock",
      currency: "USD",
      instrument_name: "Apple Inc.",
    };
    const doc = assemble(minimal, stockProfile);

    const instr = doc.instrument as Record<string, unknown>;
    expect(instr.identifiers).toBeUndefined();
    expect(instr.name).toBe("Apple Inc.");
    expect(instr.currency).toBe("USD");
    expect(instr.type).toBe("Equity");
  });

  it("returns an empty document for an empty profile", () => {
    const emptyProfile: StockProfile = {
      profile_name: "empty",
      asset_class: "stock",
      cdm_version: "5.0.0",
      required_fields: [],
    };
    const doc = assemble(makeRecord(), emptyProfile);
    expect(doc).toEqual({});
  });

  it("only appends identifiers that exist on the record", () => {
    const record = makeRecord({
      isin: "US0378331005",
      figi: undefined,
      cusip: undefined,
      sedol: undefined,
    });
    const doc = assemble(record, stockProfile);

    const instr = doc.instrument as Record<string, unknown>;
    expect(instr.identifiers).toEqual([
      { value: "US0378331005", type: "ISIN" },
    ]);
  });

  it("handles identifier field without a scheme", () => {
    const profile: StockProfile = {
      profile_name: "test",
      asset_class: "stock",
      cdm_version: "5.0.0",
      required_fields: [
        { cdm_path: "instrument.identifiers[]", source: "isin" },
      ],
    };
    const doc = assemble(makeRecord({ isin: "US0378331005" }), profile);

    const instr = doc.instrument as Record<string, unknown>;
    expect(instr.identifiers).toEqual([{ value: "US0378331005" }]);
  });

  it("sets deeply nested scalar paths", () => {
    const profile: StockProfile = {
      profile_name: "test",
      asset_class: "stock",
      cdm_version: "5.0.0",
      required_fields: [{ cdm_path: "a.b.c.d.e", source: "currency" }],
    };
    const doc = assemble(makeRecord(), profile);
    expect(doc).toEqual({ a: { b: { c: { d: { e: "USD" } } } } });
  });
});
