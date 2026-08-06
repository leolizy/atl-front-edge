import type { Adapter } from "./adapter.js";
import { createCsvAdapter, type CsvVenueConfig } from "./csv-adapter.js";

// ---------------------------------------------------------------------------
// Per-venue configs
// ---------------------------------------------------------------------------

const SIMPLE_COLS: string[] = []; // 6 core columns only, no extras
const COMMODITY_COLS = ["contract_size", "delivery_months", "tick_value"];
const OPTION_COLS = [
  "strike_price",
  "expiration_date",
  "put_call",
  "underlier_isin",
  "option_style",
  "contract_multiplier",
];

/** All CSV venue configurations. */
const VENUE_CONFIGS: CsvVenueConfig[] = [
  // -- Simple (6 core only) ---------------------------------------------------
  { mic: "XNYS", requiredColumns: SIMPLE_COLS },
  { mic: "XDUB", requiredColumns: SIMPLE_COLS },
  { mic: "XHKG", requiredColumns: SIMPLE_COLS },
  { mic: "XSES", requiredColumns: SIMPLE_COLS },

  // -- Commodity (9: 6 core + 3 commodity-specific) ---------------------------
  { mic: "XCME", requiredColumns: COMMODITY_COLS, quoteAware: true },
  { mic: "XHKF", requiredColumns: COMMODITY_COLS, quoteAware: true },
  { mic: "XSIM", requiredColumns: COMMODITY_COLS, quoteAware: true },

  // -- Options (12: 6 core + 6 option-specific) -------------------------------
  {
    mic: "XCBO",
    requiredColumns: OPTION_COLS,
    quoteAware: true,
    topLevelExtraColumns: OPTION_COLS,
  },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Map of MIC → Adapter, built once from configs. */
export const ADAPTER_REGISTRY: Record<string, Adapter> = {};

for (const config of VENUE_CONFIGS) {
  ADAPTER_REGISTRY[config.mic] = createCsvAdapter(config);
}

// ---------------------------------------------------------------------------
// Legacy named exports — thin wrappers, kept for backward-compatible imports
// ---------------------------------------------------------------------------

/** @deprecated Use `ADAPTER_REGISTRY.XNYS` instead. */
export const xnysAdapter = ADAPTER_REGISTRY.XNYS!;
/** @deprecated Use `ADAPTER_REGISTRY.XDUB` instead. */
export const xdubAdapter = ADAPTER_REGISTRY.XDUB!;
/** @deprecated Use `ADAPTER_REGISTRY.XHKG` instead. */
export const xhkgAdapter = ADAPTER_REGISTRY.XHKG!;
/** @deprecated Use `ADAPTER_REGISTRY.XSES` instead. */
export const xsesAdapter = ADAPTER_REGISTRY.XSES!;
/** @deprecated Use `ADAPTER_REGISTRY.XCME` instead. */
export const xcmeAdapter = ADAPTER_REGISTRY.XCME!;
/** @deprecated Use `ADAPTER_REGISTRY.XHKF` instead. */
export const xhkfAdapter = ADAPTER_REGISTRY.XHKF!;
/** @deprecated Use `ADAPTER_REGISTRY.XSIM` instead. */
export const xsimAdapter = ADAPTER_REGISTRY.XSIM!;
/** @deprecated Use `ADAPTER_REGISTRY.XCBO` instead. */
export const xcboAdapter = ADAPTER_REGISTRY.XCBO!;
