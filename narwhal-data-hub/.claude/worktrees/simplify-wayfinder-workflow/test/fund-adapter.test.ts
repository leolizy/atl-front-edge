import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { xnysAdapter } from "../src/adapters/xnys-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const fundVenueContext: VenueContext = {
  mic: "XNYS",
  instrument_category: "fund",
  profile_reference: "fund-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("fund adapter (XNYS ETF/mutual fund)", () => {
  describe("seam test — ETF/fund parse via XNYS adapter", () => {
    it("parses the xnys-etf-sample fixture into correct normalized records", () => {
      const bytes = loadFixture("xnys-etf-sample.csv");
      const records = xnysAdapter.parse(bytes, fundVenueContext);

      expect(records).toHaveLength(5);

      // SPY — ETF (passive, tracks S&P 500)
      expect(records[0]).toMatchObject({
        venue_symbol: "SPY",
        instrument_name: "SPDR S&P 500 ETF Trust",
        isin: "US78462F1030",
        currency: "USD",
        asset_class: "fund",
        mic: "XNYS",
      });
      expect(records[0].attributes).toMatchObject({
        fund_type: "etf",
        expense_ratio: "0.0945",
        underlying_index: "S&P 500 Index",
        management_style: "passive",
      });

      // QQQ — ETF (passive, tracks Nasdaq-100)
      expect(records[1]).toMatchObject({
        venue_symbol: "QQQ",
        instrument_name: "Invesco QQQ Trust",
        isin: "US46090E1038",
        currency: "USD",
        asset_class: "fund",
        mic: "XNYS",
      });
      expect(records[1].attributes).toMatchObject({
        fund_type: "etf",
        expense_ratio: "0.20",
        underlying_index: "Nasdaq-100 Index",
        management_style: "passive",
      });

      // IWM — ETF (passive, tracks Russell 2000)
      expect(records[2]).toMatchObject({
        venue_symbol: "IWM",
        instrument_name: "iShares Russell 2000 ETF",
        isin: "US4642876555",
      });
      expect(records[2].attributes).toMatchObject({
        fund_type: "etf",
        expense_ratio: "0.19",
        underlying_index: "Russell 2000 Index",
        management_style: "passive",
      });

      // FKIDX — mutual fund (active, no index)
      expect(records[3]).toMatchObject({
        venue_symbol: "FKIDX",
        instrument_name: "Fidelity International Discovery Fund",
        isin: "US3163892047",
        currency: "USD",
        asset_class: "fund",
        mic: "XNYS",
      });
      expect(records[3].attributes).toMatchObject({
        fund_type: "mutual_fund",
        expense_ratio: "0.99",
        underlying_index: "",
        management_style: "active",
      });

      // CEF01 — closed-end fund (active)
      expect(records[4]).toMatchObject({
        venue_symbol: "CEF01",
        instrument_name: "Adams Diversified Equity Fund",
        isin: "US0062121043",
        currency: "USD",
        asset_class: "fund",
        mic: "XNYS",
      });
      expect(records[4].attributes).toMatchObject({
        fund_type: "closed_end",
        expense_ratio: "0.59",
        management_style: "active",
      });
    });

    it("produces records with fund-specific fields in attributes", () => {
      const bytes = loadFixture("xnys-etf-sample.csv");
      const records = xnysAdapter.parse(bytes, fundVenueContext);

      for (const record of records) {
        expect(record.attributes).toHaveProperty("fund_type");
        expect(record.attributes).toHaveProperty("expense_ratio");
        expect(record.attributes).toHaveProperty("underlying_index");
        expect(record.attributes).toHaveProperty("management_style");
        expect(record.attributes.fund_type).toBeTruthy();
        expect(record.attributes.management_style).toBeTruthy();
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty array for an empty file", () => {
      const records = xnysAdapter.parse(Buffer.from(""), fundVenueContext);
      expect(records).toEqual([]);
    });

    it("returns empty array for a header-only file (no data rows)", () => {
      const records = xnysAdapter.parse(
        Buffer.from(
          "symbol,name,isin,currency,mic,asset_class,fund_type,expense_ratio,underlying_index,management_style\n"
        ),
        fundVenueContext
      );
      expect(records).toEqual([]);
    });

    it("throws when required columns are missing", () => {
      const csv = Buffer.from("symbol,name,isin\nSPY,ETF,US78462F1030\n");
      expect(() => xnysAdapter.parse(csv, fundVenueContext)).toThrow(
        /missing required columns/
      );
    });

    it("throws when a data row has an empty required column", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,fund_type,expense_ratio,underlying_index,management_style\n" +
          ",SPDR S&P 500 ETF,US78462F1030,USD,XNYS,fund,etf,0.0945,S&P 500 Index,passive\n"
      );
      expect(() => xnysAdapter.parse(csv, fundVenueContext)).toThrow(
        /empty required column/
      );
    });

    it("skips blank lines between data rows", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,fund_type,expense_ratio,underlying_index,management_style\n" +
          "SPY,SPDR S&P 500 ETF Trust,US78462F1030,USD,XNYS,fund,etf,0.0945,S&P 500 Index,passive\n" +
          "\n" +
          "QQQ,Invesco QQQ Trust,US46090E1038,USD,XNYS,fund,etf,0.20,Nasdaq-100 Index,passive\n"
      );
      const records = xnysAdapter.parse(csv, fundVenueContext);
      expect(records).toHaveLength(2);
      expect(records[0].venue_symbol).toBe("SPY");
      expect(records[1].venue_symbol).toBe("QQQ");
    });

    it("passes through extra columns as venue-specific attributes", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,fund_type,expense_ratio,underlying_index,management_style,inception_date,aum\n" +
          "SPY,SPDR S&P 500 ETF Trust,US78462F1030,USD,XNYS,fund,etf,0.0945,S&P 500 Index,passive,1993-01-22,500B\n"
      );
      const records = xnysAdapter.parse(csv, fundVenueContext);
      expect(records).toHaveLength(1);
      expect(records[0].attributes).toMatchObject({
        fund_type: "etf",
        expense_ratio: "0.0945",
        underlying_index: "S&P 500 Index",
        management_style: "passive",
        inception_date: "1993-01-22",
        aum: "500B",
      });
    });

    it("handles trailing newline", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,fund_type,expense_ratio,underlying_index,management_style\n" +
          "SPY,SPDR S&P 500 ETF Trust,US78462F1030,USD,XNYS,fund,etf,0.0945,S&P 500 Index,passive\n"
      );
      const records = xnysAdapter.parse(csv, fundVenueContext);
      expect(records).toHaveLength(1);
    });
  });

  describe("NormalizedRecord shape", () => {
    it("every record has all required fields present", () => {
      const bytes = loadFixture("xnys-etf-sample.csv");
      const records = xnysAdapter.parse(bytes, fundVenueContext);

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
