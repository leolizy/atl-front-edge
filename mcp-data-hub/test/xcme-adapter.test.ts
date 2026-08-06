import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { xcmeAdapter } from "../src/adapters/xcme-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const commodityVenueContext: VenueContext = {
  mic: "XCME",
  instrument_category: "commodity_future",
  profile_reference: "commodity-future-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("xcmeAdapter", () => {
  describe("seam test — ingest pipeline", () => {
    it("parses the xcme-sample fixture into correct normalized records", () => {
      const bytes = loadFixture("xcme-sample.csv");
      const records = xcmeAdapter.parse(bytes, commodityVenueContext);

      expect(records).toHaveLength(5);

      // ES — first row
      expect(records[0]).toMatchObject({
        venue_symbol: "ES",
        instrument_name: "E-Mini S&P 500 Future",
        isin: "US25875P1066",
        currency: "USD",
        asset_class: "commodity_future",
        mic: "XCME",
      });
      expect(records[0].attributes).toMatchObject({
        contract_size: "50xS&P 500 Index",
        delivery_months: "H,M,U,Z",
        tick_value: "12.50",
      });

      // CL — second row
      expect(records[1]).toMatchObject({
        venue_symbol: "CL",
        instrument_name: "Crude Oil Future",
        isin: "US12573R1095",
        currency: "USD",
        asset_class: "commodity_future",
        mic: "XCME",
      });
      expect(records[1].attributes).toMatchObject({
        contract_size: "1000 barrels",
        delivery_months: "F,G,H,J,K,M,N,Q,U,V,X,Z",
        tick_value: "10.00",
      });

      // GC — third row
      expect(records[2]).toMatchObject({
        venue_symbol: "GC",
        instrument_name: "Gold Future",
        isin: "US65000C1053",
      });

      // ZC — fourth row
      expect(records[3]).toMatchObject({
        venue_symbol: "ZC",
        instrument_name: "Corn Future",
        isin: "US12573P1093",
      });

      // 6E — fifth row
      expect(records[4]).toMatchObject({
        venue_symbol: "6E",
        instrument_name: "Euro FX Future",
        isin: "US13494R1032",
      });
    });

    it("produces records with commodity fields captured in attributes", () => {
      const bytes = loadFixture("xcme-sample.csv");
      const records = xcmeAdapter.parse(bytes, commodityVenueContext);

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
      const records = xcmeAdapter.parse(Buffer.from(""), commodityVenueContext);
      expect(records).toEqual([]);
    });

    it("returns empty array for a header-only file (no data rows)", () => {
      const records = xcmeAdapter.parse(
        Buffer.from(
          "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n"
        ),
        commodityVenueContext
      );
      expect(records).toEqual([]);
    });

    it("throws when required columns are missing", () => {
      const csv = Buffer.from(
        "symbol,name,isin\nES,E-Mini S&P 500 Future,US25875P1066\n"
      );
      expect(() => xcmeAdapter.parse(csv, commodityVenueContext)).toThrow(
        /missing required columns/
      );
    });

    it("throws when a data row has an empty required column", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n" +
          ",E-Mini S&P 500 Future,US25875P1066,USD,XCME,commodity_future,50xS&P 500 Index,H,M,U,Z,12.50\n"
      );
      expect(() => xcmeAdapter.parse(csv, commodityVenueContext)).toThrow(
        /empty required column/
      );
    });

    it("skips blank lines between data rows", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n" +
          "ES,E-Mini S&P 500 Future,US25875P1066,USD,XCME,commodity_future,50xS&P 500 Index,H,M,U,Z,12.50\n" +
          "\n" +
          "CL,Crude Oil Future,US12573R1095,USD,XCME,commodity_future,1000 barrels,F,G,H,J,K,M,N,Q,U,V,X,Z,10.00\n"
      );
      const records = xcmeAdapter.parse(csv, commodityVenueContext);
      expect(records).toHaveLength(2);
      expect(records[0].venue_symbol).toBe("ES");
      expect(records[1].venue_symbol).toBe("CL");
    });

    it("passes through extra columns as venue-specific attributes", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value,tick_size,exchange_fee\n" +
          'ES,E-Mini S&P 500 Future,US25875P1066,USD,XCME,commodity_future,50xS&P 500 Index,"H,M,U,Z",12.50,0.25,1.18\n'
      );
      const records = xcmeAdapter.parse(csv, commodityVenueContext);
      expect(records).toHaveLength(1);
      expect(records[0].attributes).toMatchObject({
        contract_size: "50xS&P 500 Index",
        delivery_months: "H,M,U,Z",
        tick_value: "12.50",
        tick_size: "0.25",
        exchange_fee: "1.18",
      });
    });

    it("handles trailing newline", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,contract_size,delivery_months,tick_value\n" +
          "ES,E-Mini S&P 500 Future,US25875P1066,USD,XCME,commodity_future,50xS&P 500 Index,H,M,U,Z,12.50\n"
      );
      const records = xcmeAdapter.parse(csv, commodityVenueContext);
      expect(records).toHaveLength(1);
    });
  });

  describe("NormalizedRecord shape", () => {
    it("every record has all required fields present", () => {
      const bytes = loadFixture("xcme-sample.csv");
      const records = xcmeAdapter.parse(bytes, commodityVenueContext);

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
