/** A single instrument record arriving from the pipeline for delta processing. */
export interface DeltaInputRecord {
  mic: string;
  venue_symbol: string;
  isin: string;
  instrument_name: string;
  currency: string;
  asset_class: string;
  /** Full CDM JSON document as a string (will be hashed). */
  cdm_json: string;
  /** Business date the record takes effect (YYYY-MM-DD, may be future-dated). */
  effective_from: string;
  /** Arbitrary venue-specific attributes passed through to the pool. */
  attributes?: Record<string, string>;
}

/** A currently-active (recorded_to IS NULL) instrument row from the pool. */
export interface ActivePoolRecord {
  id: number;
  mic: string;
  venue_symbol: string;
  content_hash: string;
}

/** Filter columns extracted from a record for indexed query performance. */
export interface FilterColumns {
  mic: string;
  symbol: string;
  isin: string;
  asset_class: string;
  currency: string;
  effective_from: string;
  effective_to: string | null;
}

/** A single change audit entry written to the changes table. */
export interface ChangeEntry {
  instrument_id: number;
  ingest_run_id: number;
  change_type: "add" | "update" | "delist";
  before_hash: string | null;
  after_hash: string | null;
}

/** Result returned by DeltaEngine.applyDelta(). */
export interface DeltaResult {
  records_added: number;
  records_updated: number;
  records_delisted: number;
  changes: ChangeEntry[];
}

/** A full instrument row as returned by query methods. */
export interface InstrumentRow {
  id: number;
  mic: string;
  venue_symbol: string;
  asset_class: string;
  currency: string;
  cdm_json: string;
  content_hash: string;
  effective_from: string;
  effective_to: string | null;
  recorded_from: string;
  recorded_to: string | null;
  source_id: number | null;
  ingest_run_id: number | null;
}
