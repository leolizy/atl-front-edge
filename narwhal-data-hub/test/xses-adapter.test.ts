import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { xsesAdapter } from "../src/adapters/xses-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const stockVenueContext: VenueContext = {
  mic: "XSES",
  instrument_category: "stock",
  profile_reference: "stock-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("xsesAdapter", () => {
  describe("seam test — ingest pipeline", () => {
    it("parses the xses-sample fixture into correct normalized records", () => {
      const bytes = loadFixture("xses-sample.csv");
      const records = xsesAdapter.parse(bytes, stockVenueContext);

      expect(records).toHaveLength(5);

      // D05 — DBS
      expect(records[0]).toMatchObject({
        venue_symbol: "D05",
        instrument_name: "DBS Group Holdings Ltd",
        isin: "SG1L01001701",
        currency: "SGD",
        asset_class: "stock",
        mic: "XSES",
      });

      // O39 — OCBC
      expect(records[1]).toMatchObject({
        venue_symbol: "O39",
        instrument_name: "Oversea-Chinese Banking Corp Ltd",
        isin: "SG1S04926220",
        currency: "SGD",
        asset_class: "stock",
        mic: "XSES",
      });

      // U11 — UOB
      expect(records[2]).toMatchObject({
        venue_symbol: "U11",
        instrument_name: "United Overseas Bank Ltd",
        isin: "SG1M31001969",
        currency: "SGD",
        asset_class: "stock",
        mic: "XSES",
      });

      // Z74 — Singtel
      expect(records[3]).toMatchObject({
        venue_symbol: "Z74",
        instrument_name: "Singapore Telecommunications Ltd",
        isin: "SG1T75931496",
      });

      // C52 — ComfortDelGro
      expect(records[4]).toMatchObject({
        venue_symbol: "C52",
        instrument_name: "ComfortDelGro Corporation Ltd",
        isin: "SG1N31909426",
      });
    });

    it("produces records with empty attributes when no extra columns exist", () => {
      const bytes = loadFixture("xses-sample.csv");
      const records = xsesAdapter.parse(bytes, stockVenueContext);

      for (const record of records) {
        expect(record.attributes).toEqual({});
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty array for an empty file", () => {
      const records = xsesAdapter.parse(Buffer.from(""), stockVenueContext);
      expect(records).toEqual([]);
    });

    it("returns empty array for a header-only file (no data rows)", () => {
      const records = xsesAdapter.parse(
        Buffer.from("symbol,name,isin,currency,mic,asset_class\n"),
        stockVenueContext
      );
      expect(records).toEqual([]);
    });

    it("throws when required columns are missing", () => {
      const csv = Buffer.from("symbol,isin,currency\nD05,SG1L01001701,SGD\n");
      expect(() => xsesAdapter.parse(csv, stockVenueContext)).toThrow(
        /missing required columns/
      );
    });

    it("throws when a data row has an empty required column", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class\n" +
          ",DBS Group Holdings Ltd,SG1L01001701,SGD,XSES,stock\n"
      );
      expect(() => xsesAdapter.parse(csv, stockVenueContext)).toThrow(
        /empty required column/
      );
    });

    it("skips blank lines between data rows", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class\n" +
          "D05,DBS Group Holdings Ltd,SG1L01001701,SGD,XSES,stock\n" +
          "\n" +
          "O39,Oversea-Chinese Banking Corp Ltd,SG1S04926220,SGD,XSES,stock\n"
      );
      const records = xsesAdapter.parse(csv, stockVenueContext);
      expect(records).toHaveLength(2);
      expect(records[0].venue_symbol).toBe("D05");
      expect(records[1].venue_symbol).toBe("O39");
    });

    it("passes through extra columns as venue-specific attributes", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,board_lot,tick_size\n" +
          "D05,DBS Group Holdings Ltd,SG1L01001701,SGD,XSES,stock,100,0.01\n"
      );
      const records = xsesAdapter.parse(csv, stockVenueContext);
      expect(records).toHaveLength(1);
      expect(records[0].attributes).toEqual({
        board_lot: "100",
        tick_size: "0.01",
      });
    });

    it("handles trailing newline", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class\n" +
          "D05,DBS Group Holdings Ltd,SG1L01001701,SGD,XSES,stock\n"
      );
      const records = xsesAdapter.parse(csv, stockVenueContext);
      expect(records).toHaveLength(1);
    });
  });

  describe("NormalizedRecord shape", () => {
    it("every record has all required fields present", () => {
      const bytes = loadFixture("xses-sample.csv");
      const records = xsesAdapter.parse(bytes, stockVenueContext);

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
