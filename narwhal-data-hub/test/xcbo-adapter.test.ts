import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { xcboAdapter } from "../src/adapters/xcbo-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const listedDerivativeVenueContext: VenueContext = {
  mic: "XCBO",
  instrument_category: "listed_derivative",
  profile_reference: "listed-derivative-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("xcboAdapter", () => {
  describe("seam test — ingest pipeline", () => {
    it("parses the xcbo-sample fixture into correct normalized records", () => {
      const bytes = loadFixture("xcbo-sample.csv");
      const records = xcboAdapter.parse(bytes, listedDerivativeVenueContext);

      expect(records).toHaveLength(5);

      // SPY 600 Call
      expect(records[0]).toMatchObject({
        venue_symbol: "SPY251219C00600000",
        instrument_name: "SPY Dec 2025 600 Call",
        isin: "US78462FZC96",
        currency: "USD",
        asset_class: "listed_derivative",
        mic: "XCBO",
        strike_price: "600.00",
        expiration_date: "2025-12-19",
        put_call: "call",
        underlier_isin: "US78462F1030",
        option_style: "american",
        contract_multiplier: "100",
      });

      // SPY 550 Put
      expect(records[1]).toMatchObject({
        venue_symbol: "SPY251219P00550000",
        instrument_name: "SPY Dec 2025 550 Put",
        isin: "US78462FZD79",
        put_call: "put",
        strike_price: "550.00",
      });

      // QQQ 450 Call
      expect(records[2]).toMatchObject({
        venue_symbol: "QQQ260619C00450000",
        instrument_name: "QQQ Jun 2026 450 Call",
        isin: "US46090EZK15",
        put_call: "call",
        strike_price: "450.00",
        underlier_isin: "US46090E1038",
      });

      // AAPL 200 Put
      expect(records[3]).toMatchObject({
        venue_symbol: "AAPL260117P00200000",
        isin: "US037833KX12",
        put_call: "put",
        strike_price: "200.00",
        underlier_isin: "US0378331005",
      });

      // SPX 5500 Call (index option, no underlier ISIN)
      expect(records[4]).toMatchObject({
        venue_symbol: "SPX251231C05500000",
        isin: "US78462FZE52",
        put_call: "call",
        strike_price: "5500.00",
        option_style: "european",
      });
    });

    it("populates option-specific fields in attributes bag", () => {
      const bytes = loadFixture("xcbo-sample.csv");
      const records = xcboAdapter.parse(bytes, listedDerivativeVenueContext);

      for (const record of records) {
        expect(record.attributes).toHaveProperty("strike_price");
        expect(record.attributes).toHaveProperty("expiration_date");
        expect(record.attributes).toHaveProperty("put_call");
        expect(record.attributes).toHaveProperty("underlier_isin");
        expect(record.attributes).toHaveProperty("option_style");
        expect(record.attributes).toHaveProperty("contract_multiplier");
        expect(record.attributes.strike_price).toBeTruthy();
        expect(record.attributes.expiration_date).toBeTruthy();
        expect(record.attributes.put_call).toBeTruthy();
        expect(record.attributes.option_style).toBeTruthy();
        expect(record.attributes.contract_multiplier).toBeTruthy();
        // underlier_isin is optional (index options lack it)
      }
    });

    it("populates option-specific top-level fields on every record", () => {
      const bytes = loadFixture("xcbo-sample.csv");
      const records = xcboAdapter.parse(bytes, listedDerivativeVenueContext);

      for (const record of records) {
        expect(record.strike_price).toBeTruthy();
        expect(record.expiration_date).toBeTruthy();
        expect(record.put_call).toBeTruthy();
        expect(record.option_style).toBeTruthy();
        expect(record.contract_multiplier).toBeTruthy();
        // underlier_isin is optional (index options lack it)
        expect(record).toHaveProperty("underlier_isin");
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty array for an empty file", () => {
      const records = xcboAdapter.parse(
        Buffer.from(""),
        listedDerivativeVenueContext
      );
      expect(records).toEqual([]);
    });

    it("returns empty array for a header-only file (no data rows)", () => {
      const records = xcboAdapter.parse(
        Buffer.from(
          "symbol,name,isin,currency,mic,asset_class,strike_price,expiration_date,put_call,underlier_isin,option_style,contract_multiplier\n"
        ),
        listedDerivativeVenueContext
      );
      expect(records).toEqual([]);
    });

    it("throws when required columns are missing", () => {
      const csv = Buffer.from(
        "symbol,name,isin\nSPY251219C00600000,SPY Dec 2025 600 Call,US78462FZC96\n"
      );
      expect(() =>
        xcboAdapter.parse(csv, listedDerivativeVenueContext)
      ).toThrow(/missing required columns/);
    });

    it("throws when a data row has an empty required column", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,strike_price,expiration_date,put_call,underlier_isin,option_style,contract_multiplier\n" +
          ",SPY Dec 2025 600 Call,US78462FZC96,USD,XCBO,listed_derivative,600.00,2025-12-19,call,US78462F1030,american,100\n"
      );
      expect(() =>
        xcboAdapter.parse(csv, listedDerivativeVenueContext)
      ).toThrow(/empty required column/);
    });

    it("skips blank lines between data rows", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,strike_price,expiration_date,put_call,underlier_isin,option_style,contract_multiplier\n" +
          "SPY251219C00600000,SPY Dec 2025 600 Call,US78462FZC96,USD,XCBO,listed_derivative,600.00,2025-12-19,call,US78462F1030,american,100\n" +
          "\n" +
          "SPY251219P00550000,SPY Dec 2025 550 Put,US78462FZD79,USD,XCBO,listed_derivative,550.00,2025-12-19,put,US78462F1030,american,100\n"
      );
      const records = xcboAdapter.parse(csv, listedDerivativeVenueContext);
      expect(records).toHaveLength(2);
      expect(records[0].venue_symbol).toBe("SPY251219C00600000");
      expect(records[1].venue_symbol).toBe("SPY251219P00550000");
    });

    it("handles trailing newline", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,strike_price,expiration_date,put_call,underlier_isin,option_style,contract_multiplier\n" +
          "SPY251219C00600000,SPY Dec 2025 600 Call,US78462FZC96,USD,XCBO,listed_derivative,600.00,2025-12-19,call,US78462F1030,american,100\n"
      );
      const records = xcboAdapter.parse(csv, listedDerivativeVenueContext);
      expect(records).toHaveLength(1);
    });

    it("passes through extra columns as venue-specific attributes", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,strike_price,expiration_date,put_call,underlier_isin,option_style,contract_multiplier,exchange_fee\n" +
          "SPY251219C00600000,SPY Dec 2025 600 Call,US78462FZC96,USD,XCBO,listed_derivative,600.00,2025-12-19,call,US78462F1030,american,100,0.65\n"
      );
      const records = xcboAdapter.parse(csv, listedDerivativeVenueContext);
      expect(records).toHaveLength(1);
      expect(records[0].attributes).toMatchObject({
        strike_price: "600.00",
        exchange_fee: "0.65",
      });
    });
  });

  describe("NormalizedRecord shape", () => {
    it("every record has all required fields present", () => {
      const bytes = loadFixture("xcbo-sample.csv");
      const records = xcboAdapter.parse(bytes, listedDerivativeVenueContext);

      const requiredFields: (keyof (typeof records)[0])[] = [
        "venue_symbol",
        "isin",
        "instrument_name",
        "currency",
        "asset_class",
        "mic",
        "attributes",
      ];

      for (const record of records) {
        for (const field of requiredFields) {
          expect(record[field], `field "${field}" missing`).toBeDefined();
        }
      }
    });
  });
});
