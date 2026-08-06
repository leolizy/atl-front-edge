import type { Adapter } from "./adapter.js";
import type { NormalizedRecord, VenueContext } from "./types.js";
import { splitCSVLine } from "./csv-utils.js";

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

/** Configuration for a CSV venue adapter. */
export interface CsvVenueConfig {
  /** MIC code used in error messages and as default `mic` field value. */
  mic: string;
  /**
   * All required CSV columns, in any order.
   * The header must contain every column listed here.
   */
  requiredColumns: string[];
  /**
   * If true, use `splitCSVLine` to handle quoted fields.
   * Default (false) uses `line.split(",")`.
   */
  quoteAware?: boolean;
  /**
   * If set, values from these columns are also written as top-level
   * `NormalizedRecord` fields (e.g. `strike_price` → `record.strike_price`).
   * By default all extra columns are written only to `attributes`.
   */
  topLevelExtraColumns?: string[];
}

// ---------------------------------------------------------------------------
// Core columns always mapped from CSV → NormalizedRecord
// ---------------------------------------------------------------------------
const CORE_COLUMNS = [
  "symbol",
  "name",
  "isin",
  "currency",
  "mic",
  "asset_class",
] as const;

type CoreField = (typeof CORE_COLUMNS)[number];

const CORE_TO_RECORD: Record<CoreField, keyof NormalizedRecord> = {
  symbol: "venue_symbol",
  name: "instrument_name",
  isin: "isin",
  currency: "currency",
  mic: "mic",
  asset_class: "asset_class",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CSV adapter from a venue config.
 *
 * The adapter validates that every column in `requiredColumns` is present in
 * the CSV header. The six core columns (symbol, name, isin, currency, mic,
 * asset_class) are always required and mapped to `NormalizedRecord` fields.
 * Any remaining columns are captured in `attributes`.
 *
 * When `topLevelExtraColumns` is set, those column values are also written
 * as top-level `NormalizedRecord` fields (in addition to `attributes`).
 */
export function createCsvAdapter(config: CsvVenueConfig): Adapter {
  const allRequired = [...CORE_COLUMNS, ...config.requiredColumns];
  const topLevelSet = new Set(config.topLevelExtraColumns ?? []);
  const splitter = config.quoteAware
    ? (line: string) => splitCSVLine(line)
    : (line: string) => line.split(",").map((c) => c.trim());

  return {
    parse(fileBytes: Buffer, _venueContext: VenueContext): NormalizedRecord[] {
      const content = fileBytes.toString("utf-8").trim();
      if (content.length === 0) return [];

      const lines = content.split("\n");
      if (lines.length < 2) return []; // header only

      const header = splitter(lines[0]!).map((h) => h.toLowerCase());
      const allRequiredLower = allRequired.map((c) => c.toLowerCase());

      // Validate all required columns are present.
      const missing = allRequiredLower.filter((c) => !header.includes(c));
      if (missing.length > 0) {
        throw new Error(
          `${config.mic} adapter: missing required columns: ${missing.join(", ")}`
        );
      }

      // Build index map for required columns.
      const idxMap = new Map<string, number>();
      for (const col of allRequiredLower) {
        idxMap.set(col, header.indexOf(col));
      }

      const records: NormalizedRecord[] = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!.trimEnd();
        if (line.length === 0) continue;

        const cols = splitter(line);

        // Extract core fields.
        const venue_symbol = cols[idxMap.get("symbol")!] ?? "";
        const instrument_name = cols[idxMap.get("name")!] ?? "";
        const isin = cols[idxMap.get("isin")!] ?? "";
        const currency = cols[idxMap.get("currency")!] ?? "";
        const mic = cols[idxMap.get("mic")!] ?? "";
        const asset_class = cols[idxMap.get("asset_class")!] ?? "";

        if (
          !venue_symbol ||
          !instrument_name ||
          !isin ||
          !currency ||
          !mic ||
          !asset_class
        ) {
          throw new Error(
            `${config.mic} adapter: row ${i + 1} has empty required column(s)`
          );
        }

        // Collect attributes — everything beyond core columns.
        const attributes: Record<string, string> = {};
        const requiredIdxSet = new Set(idxMap.values());
        for (let c = 0; c < cols.length; c++) {
          if (!requiredIdxSet.has(c)) {
            attributes[header[c] ?? `col_${c}`] = cols[c] ?? "";
          }
        }

        // Always include the extra required columns in attributes too.
        for (const col of config.requiredColumns) {
          const idx = idxMap.get(col.toLowerCase());
          if (idx !== undefined) {
            attributes[col] = cols[idx] ?? "";
          }
        }

        const record: NormalizedRecord = {
          venue_symbol,
          instrument_name,
          isin,
          currency,
          asset_class,
          mic,
          attributes,
        };

        // Populate top-level extra fields (e.g., option-specific).
        for (const col of config.topLevelExtraColumns ?? []) {
          const idx = idxMap.get(col.toLowerCase());
          if (idx !== undefined) {
            (record as unknown as Record<string, string>)[col] =
              cols[idx] ?? "";
          }
        }

        records.push(record);
      }

      return records;
    },
  };
}
