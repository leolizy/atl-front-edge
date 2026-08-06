import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { xsimAdapter } from "../src/adapters/xsim-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const commodityVenueContext: VenueContext = {
  mic: "XSIM",
  instrument_category: "commodity_future",
  profile_reference: "commodity-future-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("xsimAdapter", () => {
  describe("seam test — ingest pipeline", () => {
    it("parses the xsim-sample fixture into correct normalized records", () => {
      const bytes = loadFixture("xsim-sample.csv");
      const records = xsimAdapter.parse(bytes, commodityVenueContext);

      expect(records).toHaveLength(5);

      // NK — first row
      expect(records[0]).toMatchObject({
        venue_symbol: "NK",
        instrument_name: "Nikkei 225 Index Future",
        isin: "SG0000001X45",
        currency: "JPY",
        asset_class: "commodity_future",
        mic: "XSIM",
      });
      expect(records[0].attributes).toMatchObject({
        contract_size: "500 x Nikkei 225",
        delivery_months: "H,M,U,Z",
        tick_value: "2500",
      });

      // TW — second row
      expect(records[1]).toMatchObject({
        venue_symbol: "TW",
        instrument_name: "Taiwan Index Future",
        isin: "SG0000002X44",
        currency: "USD",
        asset_class: "commodity_future",
        mic: "XSIM",
      });
      expect(records[1].attributes).toMatchObject({
        contract_size: "40 x TAIEX",
        delivery_months: "H,M,U,Z",
        tick_value: "10",
      });

      // SIN — third row
      expect(records[2]).toMatchObject({
        venue_symbol: "SIN",
        instrument_name: "INR/USD Future",
        isin: "SG0000003X43",
      });

      // FEF — fourth row
      expect(records[3]).toMatchObject({
        venue_symbol: "FEF",
        instrument_name: "Iron Ore 62% Fe Future",
        isin: "SG0000004X42",
      });

      // RT — fifth row
      expect(records[4]).toMatchObject({
        venue_symbol: "RT",
        instrument_name: "SICOM RSS3 Rubber Future",
        isin: "SG0000005X41",
      });
    });

    it("produces records with commodity fields captured in attributes", () => {
      const bytes = loadFixture("xsim-sample.csv");
      const records = xsimAdapter.parse(bytes, commodityVenueContext);

      for (const record of records) {
        expect(record.attributes).toHaveProperty("contract_size");
        expect(record.attributes).toHaveProperty("delivery_months");
        expect(record.attributes).toHaveProperty("tick_value");
        expect(record.attributes.contract_size).toBeTruthy();
        expect(record.attributes.delivery_months).toBeTruthy();
        expect(record.attributes.tick_value).toBeTruthy();
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty array for an empty file", () => {
      const records = xsimAdapter.parse(Buffer.from(""), commodityVenueContext);
      expect(records).toEqual([]);
    });

    it("returns empty array for a header-only file (no data rows)", () => {
      const records = xsimAdapter.parse(
        Buffer.from(
          "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n"
        ),
        commodityVenueContext
      );
      expect(records).toEqual([]);
    });

    it("throws when required columns are missing", () => {
      const csv = Buffer.from(
        "symbol,name,isin\nNK,Nikkei 225 Index Future,SG0000001X45\n"
      );
      expect(() => xsimAdapter.parse(csv, commodityVenueContext)).toThrow(
        /missing required columns/
      );
    });

    it("throws when a data row has an empty required column", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n" +
          ",Nikkei 225 Index Future,SG0000001X45,JPY,XSIM,commodity_future,500 x Nikkei 225,H,M,U,Z,2500\n"
      );
      expect(() => xsimAdapter.parse(csv, commodityVenueContext)).toThrow(
        /empty required column/
      );
    });

    it("skips blank lines between data rows", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n" +
          "NK,Nikkei 225 Index Future,SG0000001X45,JPY,XSIM,commodity_future,500 x Nikkei 225,H,M,U,Z,2500\n" +
          "\n" +
          "TW,Taiwan Index Future,SG0000002X44,USD,XSIM,commodity_future,40 x TAIEX,H,M,U,Z,10\n"
      );
      const records = xsimAdapter.parse(csv, commodityVenueContext);
      expect(records).toHaveLength(2);
      expect(records[0].venue_symbol).toBe("NK");
      expect(records[1].venue_symbol).toBe("TW");
    });

    it("passes through extra columns as venue-specific attributes", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value,tick_size,exchange_fee\n" +
          'NK,Nikkei 225 Index Future,SG0000001X45,JPY,XSIM,commodity_future,500 x Nikkei 225,"H,M,U,Z",2500,5,500\n'
      );
      const records = xsimAdapter.parse(csv, commodityVenueContext);
      expect(records).toHaveLength(1);
      expect(records[0].attributes).toMatchObject({
        contract_size: "500 x Nikkei 225",
        delivery_months: "H,M,U,Z",
        tick_value: "2500",
        tick_size: "5",
        exchange_fee: "500",
      });
    });

    it("handles trailing newline", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n" +
          "NK,Nikkei 225 Index Future,SG0000001X45,JPY,XSIM,commodity_future,500 x Nikkei 225,H,M,U,Z,2500\n"
      );
      const records = xsimAdapter.parse(csv, commodityVenueContext);
      expect(records).toHaveLength(1);
    });
  });

  describe("NormalizedRecord shape", () => {
    it("every record has all required fields present", () => {
      const bytes = loadFixture("xsim-sample.csv");
      const records = xsimAdapter.parse(bytes, commodityVenueContext);

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
