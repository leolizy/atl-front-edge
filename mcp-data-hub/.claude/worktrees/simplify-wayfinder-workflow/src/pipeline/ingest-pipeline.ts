import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { SnapshotFetcher } from "../sources/snapshot-fetcher.js";
import type { SnapshotResult } from "../sources/snapshot-fetcher.js";
import { DeltaEngine } from "../delta/delta-engine.js";
import type { DeltaInputRecord, ActivePoolRecord } from "../delta/types.js";
import { assemble } from "../assembler/cdm-assembler.js";
import { validate, quarantineRecord } from "../validator/profile-validator.js";
import type {
  Adapter,
  VenueContext,
  NormalizedRecord,
} from "../adapters/index.js";
import type { StockProfile } from "../assembler/types.js";
import type { PipelineOptions, IngestRunReport } from "./types.js";
import {
  checkParseErrorRate,
  checkMassChangeRate,
  applySafetyGates,
  type SafetyGateCheck,
} from "./safety-gates.js";
import { OpenFigiEnricher } from "../enrichment/openfigi-enricher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return today's date as YYYY-MM-DD. */
function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear().toString();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Compute SHA-256 hex digest of a buffer. */
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build a stable lookup key from MIC and venue symbol (same convention as delta engine). */
function poolKey(mic: string, symbol: string): string {
  return `${mic}::${symbol}`;
}

/**
 * Estimate how many pool records would change if we applied the given delta
 * records against the current active pool state.
 *
 * Returns { adds, updates, delistings } counts without modifying the pool.
 */
function estimateMassChanges(
  incoming: DeltaInputRecord[],
  activePool: ActivePoolRecord[],
  computeHash: (json: string) => string
): { adds: number; updates: number; delistings: number } {
  const incomingMap = new Map<string, string>();
  for (const rec of incoming) {
    const key = poolKey(rec.mic, rec.venue_symbol);
    incomingMap.set(key, computeHash(rec.cdm_json));
  }

  const activeMap = new Map<string, ActivePoolRecord>();
  for (const row of activePool) {
    activeMap.set(poolKey(row.mic, row.venue_symbol), row);
  }

  let adds = 0;
  let updates = 0;
  let delistings = 0;
  const seenPoolKeys = new Set<string>();

  for (const [key, hash] of incomingMap) {
    seenPoolKeys.add(key);
    const existing = activeMap.get(key);
    if (!existing) {
      adds++;
    } else if (existing.content_hash !== hash) {
      updates++;
    }
  }

  for (const key of activeMap.keys()) {
    if (!seenPoolKeys.has(key)) {
      delistings++;
    }
  }

  return { adds, updates, delistings };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class IngestPipeline {
  constructor(
    private db: Database.Database,
    private snapshotFetcher: SnapshotFetcher,
    private deltaEngine: DeltaEngine,
    private enricher?: OpenFigiEnricher
  ) {}

  /**
   * Execute the full ingest pipeline for a single venue.
   *
   * Flow: fetch (or read from disk) -> parse -> assemble -> validate ->
   *       diff against pool -> apply delta -> enrich -> record run.
   *
   * @param options  Venue, optional file path, optional effective date.
   * @param adapter  The venue adapter responsible for parsing the snapshot.
   * @param profile  The CDM stock profile for assembly and validation.
   */
  async runIngest(
    options: PipelineOptions,
    adapter: Adapter,
    profile: StockProfile
  ): Promise<IngestRunReport> {
    const runStartedAt = new Date().toISOString();
    const venue = options.venue;

    // -- Step 1: Insert the ingest_runs row (counts start at zero) ----------
    const insertRun = this.db.prepare(
      `INSERT INTO ingest_runs
         (venue, window_start, window_end, file_hash, file_name,
          records_total, records_added, records_updated, records_delisted,
          records_quarantined, outcome, run_started_at)
       VALUES (?, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 'success', ?)`
    );
    const runResult = insertRun.run(venue, runStartedAt);
    const ingestRunId = Number(runResult.lastInsertRowid);

    // -- Step 2: Obtain file bytes + metadata -------------------------------
    let bytes: Buffer;
    let fileName: string;
    let fileHash: string;

    if (options.filePath) {
      // Backfill / testing mode: read directly from disk
      try {
        const data = await readFile(options.filePath);
        bytes = Buffer.from(data);
        fileName = path.basename(options.filePath);
        fileHash = sha256(bytes);
      } catch {
        return this.finalizeRun(ingestRunId, venue, runStartedAt, {
          records_total: 0,
          records_added: 0,
          records_updated: 0,
          records_delisted: 0,
          records_quarantined: 0,
          outcome: "unavailable",
          file_name: null,
          file_hash: null,
          error_message: `File not found: ${options.filePath}`,
        });
      }
    } else {
      // Production mode: fetch from approved sources
      const snapshot: SnapshotResult = await this.snapshotFetcher.fetch(venue);
      if (!snapshot.available) {
        return this.finalizeRun(ingestRunId, venue, runStartedAt, {
          records_total: 0,
          records_added: 0,
          records_updated: 0,
          records_delisted: 0,
          records_quarantined: 0,
          outcome: "unavailable",
          file_name: null,
          file_hash: null,
          error_message: snapshot.reason,
        });
      }
      bytes = snapshot.bytes;
      fileName = snapshot.metadata.file_name;
      fileHash = snapshot.metadata.file_hash;
    }

    // -- Step 3: Parse via the venue adapter --------------------------------
    let records: NormalizedRecord[];
    try {
      const venueContext: VenueContext = {
        mic: venue,
        instrument_category: profile.asset_class,
        profile_reference: profile.profile_name,
      };
      records = adapter.parse(bytes, venueContext);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.finalizeRun(ingestRunId, venue, runStartedAt, {
        records_total: 0,
        records_added: 0,
        records_updated: 0,
        records_delisted: 0,
        records_quarantined: 0,
        outcome: "failed",
        file_name: fileName,
        file_hash: fileHash,
        error_message: `Parse error: ${message}`,
      });
    }

    // -- Step 4: Assemble, validate, and quarantine per record --------------
    const deltaRecords: DeltaInputRecord[] = [];
    let quarantinedCount = 0;

    const effectiveDate = options.effectiveDate ?? todayISO();

    for (let i = 0; i < records.length; i++) {
      const record = records[i];

      // Assemble into CDM JSON
      const cdmDoc = assemble(record, profile);

      // Validate against the profile
      const validationResult = validate(cdmDoc, profile);

      if (!validationResult.valid) {
        // Quarantine the failed record
        quarantineRecord(
          this.db,
          ingestRunId,
          i,
          record,
          validationResult.failures
        );
        quarantinedCount++;
        continue;
      }

      // Build the delta input record
      const cdmJson = JSON.stringify(cdmDoc);
      deltaRecords.push({
        mic: record.mic,
        venue_symbol: record.venue_symbol,
        isin: record.isin,
        instrument_name: record.instrument_name,
        currency: record.currency,
        asset_class: record.asset_class,
        cdm_json: cdmJson,
        effective_from: effectiveDate,
        attributes: record.attributes,
      });
    }

    // -- Step 5: Safety gates ------------------------------------------------
    // Run gate checks BEFORE applying the delta so a quarantine has zero
    // pool mutations.

    const gates: SafetyGateCheck[] = [];

    // Parse-error gate
    gates.push({
      name: "parse_error_rate",
      result: checkParseErrorRate(quarantinedCount, records.length),
    });

    // Mass-change gate: estimate changes by diffing against active pool
    const activePool = this.deltaEngine.getActiveRecords(venue);
    const massEstimate = estimateMassChanges(deltaRecords, activePool, (json) =>
      this.deltaEngine.computeHash(json)
    );
    const estimatedChanges =
      massEstimate.adds + massEstimate.updates + massEstimate.delistings;
    gates.push({
      name: "mass_change",
      result: checkMassChangeRate(estimatedChanges, activePool.length),
    });

    const gateResult = applySafetyGates(gates);
    if (gateResult.status === "quarantined") {
      return this.finalizeRun(ingestRunId, venue, runStartedAt, {
        records_total: records.length,
        records_added: 0,
        records_updated: 0,
        records_delisted: 0,
        records_quarantined: quarantinedCount,
        outcome: "quarantined",
        file_name: fileName,
        file_hash: fileHash,
        error_message: gateResult.reason ?? null,
      });
    }

    // -- Step 6: Diff against pool and apply delta --------------------------
    const deltaResult = this.deltaEngine.applyDelta(
      deltaRecords,
      venue,
      ingestRunId,
      effectiveDate,
      runStartedAt
    );

    // -- Step 7: Enrichment (OpenFIGI cross-reference) -----------------------
    // Best-effort: enrichment failures are logged but never block the run.
    if (this.enricher) {
      try {
        this.enricher.enrich(venue);
      } catch {
        // Swallow — enrichment is non-blocking.
      }
    }

    // -- Step 8: Determine outcome and finalize -----------------------------
    let outcome: IngestRunReport["outcome"];
    if (quarantinedCount === records.length && records.length > 0) {
      outcome = "quarantined";
    } else if (quarantinedCount > 0) {
      outcome = "partial";
    } else {
      outcome = "success";
    }

    return this.finalizeRun(ingestRunId, venue, runStartedAt, {
      records_total: records.length,
      records_added: deltaResult.records_added,
      records_updated: deltaResult.records_updated,
      records_delisted: deltaResult.records_delisted,
      records_quarantined: quarantinedCount,
      outcome,
      file_name: fileName,
      file_hash: fileHash,
      error_message: null,
    });
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Update the ingest_runs row with final counts and outcome, then return
   * the assembled report.
   */
  private finalizeRun(
    ingestRunId: number,
    venue: string,
    runStartedAt: string,
    params: {
      records_total: number;
      records_added: number;
      records_updated: number;
      records_delisted: number;
      records_quarantined: number;
      outcome: IngestRunReport["outcome"];
      file_name: string | null;
      file_hash: string | null;
      error_message: string | null;
    }
  ): IngestRunReport {
    const runCompletedAt = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE ingest_runs
           SET file_hash = ?,
               file_name = ?,
               records_total = ?,
               records_added = ?,
               records_updated = ?,
               records_delisted = ?,
               records_quarantined = ?,
               outcome = ?,
               error_message = ?,
               run_completed_at = ?
         WHERE id = ?`
      )
      .run(
        params.file_hash,
        params.file_name,
        params.records_total,
        params.records_added,
        params.records_updated,
        params.records_delisted,
        params.records_quarantined,
        params.outcome,
        params.error_message,
        runCompletedAt,
        ingestRunId
      );

    return {
      run_id: ingestRunId,
      venue,
      file_name: params.file_name,
      file_hash: params.file_hash,
      records_total: params.records_total,
      records_added: params.records_added,
      records_updated: params.records_updated,
      records_delisted: params.records_delisted,
      records_quarantined: params.records_quarantined,
      outcome: params.outcome,
      error_message: params.error_message,
      run_started_at: runStartedAt,
      run_completed_at: runCompletedAt,
    };
  }
}
