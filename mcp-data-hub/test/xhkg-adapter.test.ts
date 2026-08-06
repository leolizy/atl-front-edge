import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { xhkgAdapter } from "../src/adapters/xhkg-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const stockVenueContext: VenueContext = {
  mic: "XHKG",
  instrument_category: "stock",
  profile_reference: "stock-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("xhkgAdapter", () => {
  describe("seam test — ingest pipeline", () => {
    it("parses the xhkg-sample fixture into correct normalized records", () => {
      const bytes = loadFixture("xhkg-sample.csv");
      const records = xhkgAdapter.parse(bytes, stockVenueContext);

      expect(records).toHaveLength(5);

      // 0005 — HSBC
      expect(records[0]).toMatchObject({
        venue_symbol: "0005",
        instrument_name: "HSBC Holdings plc",
        isin: "GB0005405286",
        currency: "HKD",
        asset_class: "stock",
        mic: "XHKG",
      });

      // 0700 — Tencent
      expect(records[1]).toMatchObject({
        venue_symbol: "0700",
        instrument_name: "Tencent Holdings Ltd",
        isin: "KYG875721634",
        currency: "HKD",
        asset_class: "stock",
        mic: "XHKG",
      });

      // 0941 — China Mobile
      expect(records[2]).toMatchObject({
        venue_symbol: "0941",
        instrument_name: "China Mobile Ltd",
        isin: "HK0941009539",
        currency: "HKD",
        asset_class: "stock",
        mic: "XHKG",
      });

      // 1299 — AIA
      expect(records[3]).toMatchObject({
        venue_symbol: "1299",
        instrument_name: "AIA Group Ltd",
        isin: "HK0000069689",
      });

      // 0388 — HKEX
      expect(records[4]).toMatchObject({
        venue_symbol: "0388",
        instrument_name: "Hong Kong Exchanges and Clearing Ltd",
        isin: "HK0388045442",
      });
    });

    it("produces records with empty attributes when no extra columns exist", () => {
      const bytes = loadFixture("xhkg-sample.csv");
      const records = xhkgAdapter.parse(bytes, stockVenueContext);

      for (const record of records) {
        expect(record.attributes).toEqual({});
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty array for an empty file", () => {
      const records = xhkgAdapter.parse(Buffer.from(""), stockVenueContext);
      expect(records).toEqual([]);
    });

    it("returns empty array for a header-only file (no data rows)", () => {
      const records = xhkgAdapter.parse(
        Buffer.from("symbol,name,isin,currency,mic,asset_class\n"),
        stockVenueContext
      );
      expect(records).toEqual([]);
    });

    it("throws when required columns are missing", () => {
      const csv = Buffer.from("symbol,isin,currency\n0005,GB0005405286,HKD\n");
      expect(() => xhkgAdapter.parse(csv, stockVenueContext)).toThrow(
        /missing required columns/
      );
    });

    it("throws when a data row has an empty required column", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class\n" +
          ",HSBC Holdings plc,GB0005405286,HKD,XHKG,stock\n"
      );
      expect(() => xhkgAdapter.parse(csv, stockVenueContext)).toThrow(
        /empty required column/
      );
    });

    it("skips blank lines between data rows", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class\n" +
          "0005,HSBC Holdings plc,GB0005405286,HKD,XHKG,stock\n" +
          "\n" +
          "0700,Tencent Holdings Ltd,KYG875721634,HKD,XHKG,stock\n"
      );
      const records = xhkgAdapter.parse(csv, stockVenueContext);
      expect(records).toHaveLength(2);
      expect(records[0].venue_symbol).toBe("0005");
      expect(records[1].venue_symbol).toBe("0700");
    });

    it("passes through extra columns as venue-specific attributes", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,board_lot,tick_size\n" +
          "0005,HSBC Holdings plc,GB0005405286,HKD,XHKG,stock,400,0.05\n"
      );
      const records = xhkgAdapter.parse(csv, stockVenueContext);
      expect(records).toHaveLength(1);
      expect(records[0].attributes).toEqual({
        board_lot: "400",
        tick_size: "0.05",
      });
    });

    it("handles trailing newline", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class\n" +
          "0005,HSBC Holdings plc,GB0005405286,HKD,XHKG,stock\n"
      );
      const records = xhkgAdapter.parse(csv, stockVenueContext);
      expect(records).toHaveLength(1);
    });
  });

  describe("NormalizedRecord shape", () => {
    it("every record has all required fields present", () => {
      const bytes = loadFixture("xhkg-sample.csv");
      const records = xhkgAdapter.parse(bytes, stockVenueContext);

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
