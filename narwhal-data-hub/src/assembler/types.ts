export type { NormalizedRecord } from "../adapters/types.js";

/** A single entry in the stock profile describing one CDM field to populate. */
export interface StockProfileField {
  /** Dotted CDM path. Terminal segments ending in "[]" indicate appending to an array. */
  cdm_path: string;
  /** Name of a field on NormalizedRecord to pull the value from. */
  source?: string;
  /** A literal value (used instead of source when the value is constant). */
  value?: string;
  /** Identifier scheme (e.g. "ISIN", "FIGI") — only meaningful for array-path fields. */
  scheme?: string;
  /**
   * Value type discriminator (default "string").
   * - "string": source lookup yields a string (default backward-compatible behavior)
   * - "number": source lookup yields a string parsed to a number
   * - "object": source lookup yields a JSON string parsed to an object
   */
  type?: "string" | "number" | "object";
}

/** The full stock profile declaration. */
export interface StockProfile {
  profile_name: string;
  asset_class: string;
  cdm_version: string;
  required_fields: StockProfileField[];
}

/** A CDM JSON document — an arbitrary nested object built by the assembler. */
export type CdmDocument = Record<string, unknown>;
