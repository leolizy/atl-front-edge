// Adapter contract
export type { Adapter } from "./adapter.js";

// Core types
export type { NormalizedRecord, VenueContext } from "./types.js";

// Adapter registry — single source of truth for all venue adapters
export { ADAPTER_REGISTRY } from "./venue-registry.js";
export { createCsvAdapter } from "./csv-adapter.js";
export type { CsvVenueConfig } from "./csv-adapter.js";

// Named re-exports — backward compatible
export {
  xnysAdapter,
  xdubAdapter,
  xhkgAdapter,
  xsesAdapter,
  xcmeAdapter,
  xhkfAdapter,
  xsimAdapter,
  xcboAdapter,
} from "./venue-registry.js";

// Non-CSV adapters
export { annaDsbAdapter } from "./anna-dsb-adapter.js";
