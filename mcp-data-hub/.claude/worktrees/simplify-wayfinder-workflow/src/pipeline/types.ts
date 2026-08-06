/** Options for a single ingest pipeline run. */
export interface PipelineOptions {
  /** Venue MIC to process (e.g. "XNYS"). */
  venue: string;
  /**
   * Optional local file path for backfill / testing.
   * When provided, the pipeline reads from disk instead of invoking the fetcher.
   */
  filePath?: string;
  /**
   * Business date for the delta run (YYYY-MM-DD). Defaults to today.
   * Records whose venue data carries a future effective date keep that date
   * — this is the "as of" date for the overall run.
   */
  effectiveDate?: string;
}

/** Complete report returned after a single ingest pipeline execution. */
export interface IngestRunReport {
  /** Row id of the ingest_runs record written for this execution. */
  run_id: number;
  /** Venue MIC that was processed. */
  venue: string;
  /** File name that was ingested (null when unavailable). */
  file_name: string | null;
  /** SHA-256 hex digest of the ingested file bytes (null when unavailable). */
  file_hash: string | null;
  /** Total number of normalized records found in the snapshot. */
  records_total: number;
  /** Number of new instruments added to the pool. */
  records_added: number;
  /** Number of existing instruments whose CDM content changed. */
  records_updated: number;
  /** Number of previously-active instruments delisted in this run. */
  records_delisted: number;
  /** Number of records that failed profile validation and were quarantined. */
  records_quarantined: number;
  /** Final outcome of the run. */
  outcome: "success" | "partial" | "quarantined" | "failed" | "unavailable";
  /** Error message when outcome is "failed". */
  error_message: string | null;
  /** ISO-8601 timestamp of when the run started. */
  run_started_at: string;
  /** ISO-8601 timestamp of when the run completed (null if still running). */
  run_completed_at: string | null;
}
