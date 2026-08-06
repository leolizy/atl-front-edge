import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { xnysAdapter } from "../src/adapters/xnys-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const stockVenueContext: VenueContext = {
  mic: "XNYS",
  instrument_category: "stock",
  profile_reference: "stock-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("xnysAdapter", () => {
  describe("seam test — ingest pipeline", () => {
    it("parses the xnys-sample fixture into correct normalized records", () => {
      const bytes = loadFixture("xnys-sample.csv");
      const records = xnysAdapter.parse(bytes, stockVenueContext);

      expect(records).toHaveLength(5);

      // AAPL — first row
      expect(records[0]).toMatchObject({
        venue_symbol: "AAPL",
        instrument_name: "Apple Inc.",
        isin: "US0378331005",
        currency: "USD",
        asset_class: "stock",
        mic: "XNYS",
      });

      // MSFT — second row
      expect(records[1]).toMatchObject({
        venue_symbol: "MSFT",
        instrument_name: "Microsoft Corporation",
        isin: "US5949181045",
        currency: "USD",
        asset_class: "stock",
        mic: "XNYS",
      });

      // JPM — third row
      expect(records[2]).toMatchObject({
        venue_symbol: "JPM",
        instrument_name: "JPMorgan Chase & Co.",
        isin: "US46625H1005",
        currency: "USD",
        asset_class: "stock",
        mic: "XNYS",
      });

      // XOM — fourth row
      expect(records[3]).toMatchObject({
        venue_symbol: "XOM",
        instrument_name: "Exxon Mobil Corporation",
        isin: "US30231G1022",
      });

      // WMT — fifth row
      expect(records[4]).toMatchObject({
        venue_symbol: "WMT",
        instrument_name: "Walmart Inc.",
        isin: "US9311421039",
      });
    });

    it("produces records with empty attributes when no extra columns exist", () => {
      const bytes = loadFixture("xnys-sample.csv");
      const records = xnysAdapter.parse(bytes, stockVenueContext);

      for (const record of records) {
        expect(record.attributes).toEqual({});
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty array for an empty file", () => {
      const records = xnysAdapter.parse(Buffer.from(""), stockVenueContext);
      expect(records).toEqual([]);
    });

    it("returns empty array for a header-only file (no data rows)", () => {
      const records = xnysAdapter.parse(
        Buffer.from("symbol,name,isin,currency,mic,asset_class\n"),
        stockVenueContext
      );
      expect(records).toEqual([]);
    });

    it("throws when required columns are missing", () => {
      const csv = Buffer.from("symbol,isin,currency\nAAPL,US0378331005,USD\n");
      expect(() => xnysAdapter.parse(csv, stockVenueContext)).toThrow(
        /missing required columns/
      );
    });

    it("throws when a data row has an empty required column", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class\n" +
          ",Apple Inc.,US0378331005,USD,XNYS,stock\n"
      );
      expect(() => xnysAdapter.parse(csv, stockVenueContext)).toThrow(
        /empty required column/
      );
    });

    it("skips blank lines between data rows", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class\n" +
          "AAPL,Apple Inc.,US0378331005,USD,XNYS,stock\n" +
          "\n" +
          "MSFT,Microsoft Corporation,US5949181045,USD,XNYS,stock\n"
      );
      const records = xnysAdapter.parse(csv, stockVenueContext);
      expect(records).toHaveLength(2);
      expect(records[0].venue_symbol).toBe("AAPL");
      expect(records[1].venue_symbol).toBe("MSFT");
    });

    it("passes through extra columns as venue-specific attributes", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,board_lot,tick_size\n" +
          "AAPL,Apple Inc.,US0378331005,USD,XNYS,stock,100,0.01\n"
      );
      const records = xnysAdapter.parse(csv, stockVenueContext);
      expect(records).toHaveLength(1);
      expect(records[0].attributes).toEqual({
        board_lot: "100",
        tick_size: "0.01",
      });
    });

    it("handles trailing newline", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class\n" +
          "AAPL,Apple Inc.,US0378331005,USD,XNYS,stock\n"
      );
      const records = xnysAdapter.parse(csv, stockVenueContext);
      expect(records).toHaveLength(1);
    });
  });

  describe("NormalizedRecord shape", () => {
    it("every record has all required fields present", () => {
      const bytes = loadFixture("xnys-sample.csv");
      const records = xnysAdapter.parse(bytes, stockVenueContext);

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
