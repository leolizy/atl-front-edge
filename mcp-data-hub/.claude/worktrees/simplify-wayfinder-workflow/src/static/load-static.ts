import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { StockProfile, NormalizedRecord } from "../assembler/types.js";
import { assemble } from "../assembler/cdm-assembler.js";
import { validate } from "../validator/profile-validator.js";
import type { ValidationResult } from "../validator/types.js";

// ---------------------------------------------------------------------------
// loadStaticRecords
// ---------------------------------------------------------------------------

/**
 * Direct-load one or more static records into the pool.
 *
 * Static profiles bypass the pipeline, delta, and fetcher. Each record is
 * assembled and validated against the profile, then inserted directly into the
 * `instruments` table with a synthetic ingest run (outcome `"static_load"`).
 * Validation failures throw immediately.
 *
 * Bitemporal: `effective_from = effectiveDate`, `effective_to IS NULL`,
 * `recorded_from = now()`, `recorded_to IS NULL`.
 *
 * @param db             Active SQLite connection (WAL mode, FK enabled).
 * @param profile        The CDM profile governing assembly and validation.
 * @param records        Static data records (keys match profile `source` fields).
 * @param effectiveDate  Business date (YYYY-MM-DD) for bitemporal writes.
 */
export function loadStaticRecords(
  db: Database.Database,
  profile: StockProfile,
  records: Record<string, unknown>[],
  effectiveDate: string
): void {
  const mic = profile.profile_name; // synthetic MIC
  const runStartedAt = new Date().toISOString();
  const recordedAt = runStartedAt;

  // -- Synthetic ingest run --------------------------------------------------
  const runResult = db
    .prepare(
      `INSERT INTO ingest_runs
         (venue, records_total, records_added, outcome, run_started_at, run_completed_at)
       VALUES (?, ?, ?, 'static_load', ?, ?)`
    )
    .run(mic, records.length, records.length, runStartedAt, runStartedAt);
  const ingestRunId = Number(runResult.lastInsertRowid);

  // -- Per-record: assemble → validate → insert ------------------------------
  const insertStmt = db.prepare(
    `INSERT INTO instruments
       (mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
        effective_from, effective_to, recorded_from, recorded_to, ingest_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`
  );

  for (const record of records) {
    // Assemble
    const cdmDoc = assemble(record as unknown as NormalizedRecord, profile);

    // Validate — throw on failure so caller can decide quarantine strategy
    const validationResult: ValidationResult = validate(cdmDoc, profile);
    if (!validationResult.valid) {
      const detail = JSON.stringify(validationResult.failures, null, 2);
      throw new Error(
        `Static record validation failed for profile "${profile.profile_name}": ${detail}`
      );
    }

    const cdmJson = JSON.stringify(cdmDoc);
    const contentHash = createHash("sha256").update(cdmJson).digest("hex");

    const venueSymbol =
      (record.venue_symbol as string) ||
      `static-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    insertStmt.run(
      mic,
      venueSymbol,
      profile.asset_class,
      (record.currency as string) || "USD",
      cdmJson,
      contentHash,
      effectiveDate,
      recordedAt,
      ingestRunId
    );
  }
}
