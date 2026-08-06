import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { annaDsbAdapter } from "../src/adapters/anna-dsb-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const dsbVenueContext: VenueContext = {
  mic: "DSB",
  instrument_category: "interest_rate_derivative",
  profile_reference: "interest-rate-derivative-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("annaDsbAdapter", () => {
  describe("seam test — fixture parse", () => {
    it("parses the dsb-sample fixture into 4 normalized records", () => {
      const bytes = loadFixture("dsb-sample.json");
      const records = annaDsbAdapter.parse(bytes, dsbVenueContext);

      expect(records).toHaveLength(4);
    });

    it("maps each record to the correct OTC branch", () => {
      const bytes = loadFixture("dsb-sample.json");
      const records = annaDsbAdapter.parse(bytes, dsbVenueContext);

      const classes = records.map((r) => r.asset_class);
      expect(classes).toContain("interest_rate_derivative");
      expect(classes).toContain("credit_derivative");
      expect(classes).toContain("fx_derivative");
      expect(classes).toContain("equity_derivative");
    });

    it("uses ISIN as venue_symbol and 'DSB' as MIC", () => {
      const bytes = loadFixture("dsb-sample.json");
      const records = annaDsbAdapter.parse(bytes, dsbVenueContext);

      for (const record of records) {
        expect(record.mic).toBe("DSB");
        expect(record.venue_symbol).toBe(record.isin);
      }
    });

    it("populates structured product terms in attributes", () => {
      const bytes = loadFixture("dsb-sample.json");
      const records = annaDsbAdapter.parse(bytes, dsbVenueContext);

      const irs = records.find(
        (r) => r.asset_class === "interest_rate_derivative"
      );
      expect(irs).toBeTruthy();
      expect(irs!.attributes).toHaveProperty("notional_schedule");
      expect(irs!.attributes).toHaveProperty("fixed_rate");
      expect(irs!.attributes).toHaveProperty("floating_rate_reference");
      expect(irs!.attributes.fixed_rate).toBe("2.50");
    });

    it("captures all OTC branch-specific fields in attributes", () => {
      const bytes = loadFixture("dsb-sample.json");
      const records = annaDsbAdapter.parse(bytes, dsbVenueContext);

      const cds = records.find((r) => r.asset_class === "credit_derivative");
      expect(cds!.attributes).toHaveProperty("reference_entity");
      expect(cds!.attributes).toHaveProperty("cds_spread");
      expect(cds!.attributes).toHaveProperty("delivery_type");

      const fx = records.find((r) => r.asset_class === "fx_derivative");
      expect(fx!.attributes).toHaveProperty("put_call");
      expect(fx!.attributes).toHaveProperty("strike_rate");
      expect(fx!.attributes).toHaveProperty("settlement_type");

      const eq = records.find((r) => r.asset_class === "equity_derivative");
      expect(eq!.attributes).toHaveProperty("underlier_isin");
      expect(eq!.attributes).toHaveProperty("return_type");
    });

    it("stashes ISIN in attributes for profile source lookups", () => {
      const bytes = loadFixture("dsb-sample.json");
      const records = annaDsbAdapter.parse(bytes, dsbVenueContext);

      for (const record of records) {
        expect(record.attributes).toHaveProperty("isin");
        expect(record.attributes.isin).toBe(record.isin);
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty input", () => {
      const records = annaDsbAdapter.parse(Buffer.from(""), dsbVenueContext);
      expect(records).toEqual([]);
    });

    it("returns empty array for whitespace-only input", () => {
      const records = annaDsbAdapter.parse(
        Buffer.from("   \n  "),
        dsbVenueContext
      );
      expect(records).toEqual([]);
    });

    it("throws on invalid JSON", () => {
      expect(() =>
        annaDsbAdapter.parse(Buffer.from("not json"), dsbVenueContext)
      ).toThrow(/failed to parse JSON/);
    });

    it("throws when top-level is not an object", () => {
      expect(() =>
        annaDsbAdapter.parse(Buffer.from("[1, 2, 3]"), dsbVenueContext)
      ).toThrow(/expected a top-level 'records' array/);
    });

    it("throws when records is not an array", () => {
      expect(() =>
        annaDsbAdapter.parse(
          Buffer.from('{"records": "not-an-array"}'),
          dsbVenueContext
        )
      ).toThrow(/expected a top-level 'records' array/);
    });

    it("throws when a record entry is not an object", () => {
      expect(() =>
        annaDsbAdapter.parse(
          Buffer.from('{"records": ["not-an-object"]}'),
          dsbVenueContext
        )
      ).toThrow(/each element in 'records' must be an object/);
    });

    it("throws when a required field is missing", () => {
      expect(() =>
        annaDsbAdapter.parse(
          Buffer.from(
            '{"records": [{"isin": "XX123", "instrument_name": "Test", "currency": "USD"}]}'
          ),
          dsbVenueContext
        )
      ).toThrow(/must be a non-empty string/);
    });

    it("handles records with empty product_terms", () => {
      const bytes = Buffer.from(
        JSON.stringify({
          records: [
            {
              isin: "XX1234567890",
              asset_class: "equity_derivative",
              instrument_name: "Minimal Record",
              currency: "USD",
            },
          ],
        })
      );
      const records = annaDsbAdapter.parse(bytes, dsbVenueContext);
      expect(records).toHaveLength(1);
      expect(records[0].isin).toBe("XX1234567890");
      // attributes should still have isin but no product_terms
      expect(records[0].attributes).toHaveProperty("isin");
    });
  });

  describe("NormalizedRecord shape", () => {
    it("every record has all required top-level fields present", () => {
      const bytes = loadFixture("dsb-sample.json");
      const records = annaDsbAdapter.parse(bytes, dsbVenueContext);

      for (const record of records) {
        expect(record.venue_symbol).toBeTruthy();
        expect(record.isin).toBeTruthy();
        expect(record.instrument_name).toBeTruthy();
        expect(record.currency).toBeTruthy();
        expect(record.asset_class).toBeTruthy();
        expect(record.mic).toBe("DSB");
        expect(record.attributes).toBeDefined();
      }
    });
  });
});
