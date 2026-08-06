import type { Adapter } from "./adapter.js";
import type { NormalizedRecord, VenueContext } from "./types.js";

/**
 * ANNA DSB (Derivatives Service Bureau) adapter — OTC derivatives.
 *
 * Parses a DSB end-of-day archive JSON file into NormalizedRecord[].
 * DSB records are ISIN-keyed (no MIC, no venue symbol):
 * - `mic` = synthetic "DSB"
 * - `venue_symbol` = ISIN
 * - structured product terms stored in `attributes` as JSON-serialized strings
 *
 * Input JSON shape:
 *   { "records": [{ "isin": "...", "asset_class": "...", ... }] }
 *
 * Each record maps to one of four OTC branches:
 *   interest_rate_derivative, credit_derivative, fx_derivative, equity_derivative
 */
export const annaDsbAdapter: Adapter = {
  parse(fileBytes: Buffer, _venueContext: VenueContext): NormalizedRecord[] {
    const content = fileBytes.toString("utf-8").trim();
    if (content.length === 0) {
      return [];
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error("DSB adapter: failed to parse JSON input");
    }

    if (raw === null || typeof raw !== "object") {
      throw new Error("DSB adapter: expected a JSON object at the root");
    }

    const obj = raw as Record<string, unknown>;
    const recordsArr = obj.records;
    if (!Array.isArray(recordsArr)) {
      throw new Error("DSB adapter: expected a top-level 'records' array");
    }

    const records: NormalizedRecord[] = [];

    for (const item of recordsArr) {
      if (item === null || typeof item !== "object") {
        throw new Error(
          "DSB adapter: each element in 'records' must be an object"
        );
      }

      const rec = item as Record<string, unknown>;
      const isin = asString(rec.isin, "isin");
      const instrumentName = asString(rec.instrument_name, "instrument_name");
      const currency = asString(rec.currency, "currency");
      const assetClass = asString(rec.asset_class, "asset_class");

      // Flatten product_terms into the attributes bag (string values only)
      const attributes: Record<string, string> = {};
      const productTerms = rec.product_terms;
      if (productTerms !== null && typeof productTerms === "object") {
        for (const [key, val] of Object.entries(
          productTerms as Record<string, unknown>
        )) {
          attributes[key] = typeof val === "string" ? val : JSON.stringify(val);
        }
      }

      // Stash ISIN in attributes so profiles can source it
      attributes.isin = isin;

      records.push({
        venue_symbol: isin,
        isin,
        instrument_name: instrumentName,
        currency,
        asset_class: assetClass,
        mic: "DSB",
        attributes,
      });
    }

    return records;
  },
};

function asString(val: unknown, field: string): string {
  if (typeof val !== "string" || val.length === 0) {
    throw new Error(`DSB adapter: "${field}" must be a non-empty string`);
  }
  return val;
}
