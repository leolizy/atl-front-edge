import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { xdubAdapter } from "../src/adapters/xdub-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const bondVenueContext: VenueContext = {
  mic: "XDUB",
  instrument_category: "debt",
  profile_reference: "debt-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("xdubAdapter", () => {
  describe("seam test — ingest pipeline", () => {
    it("parses the xdub-sample fixture into correct normalized records", () => {
      const bytes = loadFixture("xdub-sample.csv");
      const records = xdubAdapter.parse(bytes, bondVenueContext);

      expect(records).toHaveLength(5);

      // IE0001 — Irish Government Bond 2031 (government)
      expect(records[0]).toMatchObject({
        venue_symbol: "IE0001",
        instrument_name: "Irish Government Bond 5.40% Mar 2031",
        isin: "IE00B4S3JD47",
        currency: "EUR",
        asset_class: "bond",
        mic: "XDUB",
      });
      expect(records[0].attributes).toMatchObject({
        coupon_rate: "5.40",
        maturity_date: "2031-03-13",
        issue_date: "2010-03-18",
        face_value: "1000",
        bond_type: "government",
      });

      // IE0002 — Irish Government Bond 2037 (government)
      expect(records[1]).toMatchObject({
        venue_symbol: "IE0002",
        instrument_name: "Irish Government Bond 2.00% Feb 2037",
        isin: "IE00BV8C9418",
        currency: "EUR",
        asset_class: "bond",
        mic: "XDUB",
      });
      expect(records[1].attributes).toMatchObject({
        coupon_rate: "2.00",
        maturity_date: "2037-02-18",
        bond_type: "government",
      });

      // CRH01 — Corporate bond
      expect(records[2]).toMatchObject({
        venue_symbol: "CRH01",
        instrument_name: "CRH PLC 3.125% Apr 2030",
        isin: "XS2154321001",
        currency: "EUR",
        asset_class: "bond",
        mic: "XDUB",
      });
      expect(records[2].attributes).toMatchObject({
        coupon_rate: "3.125",
        bond_type: "corporate",
      });

      // EIB01 — Agency bond
      expect(records[3]).toMatchObject({
        venue_symbol: "EIB01",
        instrument_name: "EIB Sustainability Bond 1.50% Jan 2032",
        isin: "XS1954321500",
      });
      expect(records[3].attributes).toMatchObject({
        bond_type: "agency",
        face_value: "100000",
      });

      // IE00TB — Treasury Bill (stretch: non-bond debt instrument)
      expect(records[4]).toMatchObject({
        venue_symbol: "IE00TB",
        instrument_name: "Irish Treasury Bill 0% Jun 2027",
        isin: "IE00B4TV0C68",
        currency: "EUR",
        asset_class: "bill",
        mic: "XDUB",
      });
      expect(records[4].attributes).toMatchObject({
        coupon_rate: "0",
        maturity_date: "2027-06-15",
        bond_type: "bill",
      });
    });

    it("produces records with bond-specific fields in attributes", () => {
      const bytes = loadFixture("xdub-sample.csv");
      const records = xdubAdapter.parse(bytes, bondVenueContext);

      for (const record of records) {
        expect(record.attributes).toHaveProperty("coupon_rate");
        expect(record.attributes).toHaveProperty("maturity_date");
        expect(record.attributes).toHaveProperty("issue_date");
        expect(record.attributes).toHaveProperty("face_value");
        expect(record.attributes).toHaveProperty("bond_type");
        expect(record.attributes.coupon_rate).toBeTruthy();
        expect(record.attributes.maturity_date).toBeTruthy();
        expect(record.attributes.bond_type).toBeTruthy();
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty array for an empty file", () => {
      const records = xdubAdapter.parse(Buffer.from(""), bondVenueContext);
      expect(records).toEqual([]);
    });

    it("returns empty array for a header-only file (no data rows)", () => {
      const records = xdubAdapter.parse(
        Buffer.from(
          "symbol,name,isin,currency,mic,asset_class,coupon_rate,maturity_date,issue_date,face_value,bond_type\n"
        ),
        bondVenueContext
      );
      expect(records).toEqual([]);
    });

    it("throws when required columns are missing", () => {
      const csv = Buffer.from("symbol,name,isin\nIE0001,Bond,IE00B4S3JD47\n");
      expect(() => xdubAdapter.parse(csv, bondVenueContext)).toThrow(
        /missing required columns/
      );
    });

    it("throws when a data row has an empty required column", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,coupon_rate,maturity_date,issue_date,face_value,bond_type\n" +
          ",Bond,IE00B4S3JD47,EUR,XDUB,bond,5.40,2031-03-13,2010-03-18,1000,government\n"
      );
      expect(() => xdubAdapter.parse(csv, bondVenueContext)).toThrow(
        /empty required column/
      );
    });

    it("skips blank lines between data rows", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,coupon_rate,maturity_date,issue_date,face_value,bond_type\n" +
          "IE0001,Irish Gov Bond 2031,IE00B4S3JD47,EUR,XDUB,bond,5.40,2031-03-13,2010-03-18,1000,government\n" +
          "\n" +
          "IE0002,Irish Gov Bond 2037,IE00BV8C9418,EUR,XDUB,bond,2.00,2037-02-18,2015-02-13,1000,government\n"
      );
      const records = xdubAdapter.parse(csv, bondVenueContext);
      expect(records).toHaveLength(2);
      expect(records[0].venue_symbol).toBe("IE0001");
      expect(records[1].venue_symbol).toBe("IE0002");
    });

    it("passes through extra columns as venue-specific attributes", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,coupon_rate,maturity_date,issue_date,face_value,bond_type,ytm,rating\n" +
          "IE0001,Irish Gov Bond 2031,IE00B4S3JD47,EUR,XDUB,bond,5.40,2031-03-13,2010-03-18,1000,government,3.82,AA\n"
      );
      const records = xdubAdapter.parse(csv, bondVenueContext);
      expect(records).toHaveLength(1);
      expect(records[0].attributes).toMatchObject({
        coupon_rate: "5.40",
        maturity_date: "2031-03-13",
        bond_type: "government",
        ytm: "3.82",
        rating: "AA",
      });
    });

    it("handles trailing newline", () => {
      const csv = Buffer.from(
        "symbol,name,isin,currency,mic,asset_class,coupon_rate,maturity_date,issue_date,face_value,bond_type\n" +
          "IE0001,Irish Gov Bond 2031,IE00B4S3JD47,EUR,XDUB,bond,5.40,2031-03-13,2010-03-18,1000,government\n"
      );
      const records = xdubAdapter.parse(csv, bondVenueContext);
      expect(records).toHaveLength(1);
    });
  });

  describe("NormalizedRecord shape", () => {
    it("every record has all required fields present", () => {
      const bytes = loadFixture("xdub-sample.csv");
      const records = xdubAdapter.parse(bytes, bondVenueContext);

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
