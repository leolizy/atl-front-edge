import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { xhkfAdapter } from "../src/adapters/xhkf-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const commodityVenueContext: VenueContext = {
  mic: "XHKF",
  instrument_category: "commodity_future",
  profile_reference: "commodity-future-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("xhkfAdapter", () => {
  describe("seam test — ingest pipeline", () => {
    it("parses the xhkf-sample fixture into correct normalized records", () => {
      const bytes = loadFixture("xhkf-sample.csv");
      const records = xhkfAdapter.parse(bytes, commodityVenueContext);

      expect(records).toHaveLength(5);

      // HSI — first row
      expect(records[0]).toMatchObject({
        venue_symbol: "HSI",
        instrument_name: "Hang Seng Index Future",
        isin: "HK0000001H35",
        currency: "HKD",
        asset_class: "commodity_future",
        mic: "XHKF",
      });
      expect(records[0].attributes).toMatchObject({
        contract_size: "50 x HSI",
        delivery_months: "H,M,U,Z",
        tick_value: "50",
      });

      // HHI — second row
      expect(records[1]).toMatchObject({
        venue_symbol: "HHI",
        instrument_name: "HSCEI Future",
        isin: "HK0000002H34",
        currency: "HKD",
        asset_class: "commodity_future",
        mic: "XHKF",
      });
      expect(records[1].attributes).toMatchObject({
        contract_size: "50 x HSCEI",
        delivery_months: "H,M,U,Z",
        tick_value: "50",
      });

      // MHI — third row
      expect(records[2]).toMatchObject({
        venue_symbol: "MHI",
        instrument_name: "Mini Hang Seng Index Future",
        isin: "HK0000003H33",
      });

      // CNH — fourth row
      expect(records[3]).toMatchObject({
        venue_symbol: "CNH",
        instrument_name: "CNH Futures",
        isin: "HK0000004H32",
      });

      // GLD — fifth row
      expect(records[4]).toMatchObject({
        venue_symbol: "GLD",
        instrument_name: "Gold Futures",
        isin: "HK0000005H31",
      });
    });

    it("produces records with commodity fields captured in attributes", () => {
      const bytes = loadFixture("xhkf-sample.csv");
      const records = xhkfAdapter.parse(bytes, commodityVenueContext);

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
      const records = xhkfAdapter.parse(Buffer.from(""), commodityVenueContext);
      expect(records).toEqual([]);
    });

    it("returns empty array for a header-only file (no data rows)", () => {
      const records = xhkfAdapter.parse(
        Buffer.from(
          "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n"
        ),
        commodityVenueContext
      );
      expect(records).toEqual([]);
    });

    it("throws when required columns are missing", () => {
      const csv = Buffer.from(
        "symbol,name,isin\nHSI,Hang Seng Index Future,HK0000001H35\n"
      );
      expect(() => xhkfAdapter.parse(csv, commodityVenueContext)).toThrow(
        /missing required columns/
      );
    });

    it("throws when a data row has an empty required column", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n" +
          ",Hang Seng Index Future,HK0000001H35,HKD,XHKF,commodity_future,50 x HSI,H,M,U,Z,50\n"
      );
      expect(() => xhkfAdapter.parse(csv, commodityVenueContext)).toThrow(
        /empty required column/
      );
    });

    it("skips blank lines between data rows", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n" +
          "HSI,Hang Seng Index Future,HK0000001H35,HKD,XHKF,commodity_future,50 x HSI,H,M,U,Z,50\n" +
          "\n" +
          "HHI,HSCEI Future,HK0000002H34,HKD,XHKF,commodity_future,50 x HSCEI,H,M,U,Z,50\n"
      );
      const records = xhkfAdapter.parse(csv, commodityVenueContext);
      expect(records).toHaveLength(2);
      expect(records[0].venue_symbol).toBe("HSI");
      expect(records[1].venue_symbol).toBe("HHI");
    });

    it("passes through extra columns as venue-specific attributes", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value,tick_size,exchange_fee\n" +
          'HSI,Hang Seng Index Future,HK0000001H35,HKD,XHKF,commodity_future,50 x HSI,"H,M,U,Z",50,1,10\n'
      );
      const records = xhkfAdapter.parse(csv, commodityVenueContext);
      expect(records).toHaveLength(1);
      expect(records[0].attributes).toMatchObject({
        contract_size: "50 x HSI",
        delivery_months: "H,M,U,Z",
        tick_value: "50",
        tick_size: "1",
        exchange_fee: "10",
      });
    });

    it("handles trailing newline", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n" +
          "HSI,Hang Seng Index Future,HK0000001H35,HKD,XHKF,commodity_future,50 x HSI,H,M,U,Z,50\n"
      );
      const records = xhkfAdapter.parse(csv, commodityVenueContext);
      expect(records).toHaveLength(1);
    });
  });

  describe("NormalizedRecord shape", () => {
    it("every record has all required fields present", () => {
      const bytes = loadFixture("xhkf-sample.csv");
      const records = xhkfAdapter.parse(bytes, commodityVenueContext);

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
