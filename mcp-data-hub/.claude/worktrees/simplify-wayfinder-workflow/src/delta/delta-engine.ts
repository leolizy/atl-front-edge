import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  DeltaInputRecord,
  ActivePoolRecord,
  FilterColumns,
  ChangeEntry,
  DeltaResult,
  InstrumentRow,
} from "./types.js";

/**
 * DeltaEngine diffs an incoming snapshot against current pool state and
 * applies bitemporal adds, updates, and delistings. Every mutation is a
 * close-out-and-insert — never an in-place UPDATE on the data columns.
 */
export class DeltaEngine {
  constructor(private db: Database.Database) {}

  /**
   * Compute the SHA-256 content hash of a CDM JSON document.
   *
   * The JSON is canonicalised by recursively sorting keys before hashing
   * so that two semantically identical documents produce the same hash
   * regardless of key order.
   */
  computeHash(json: string): string {
    const obj = JSON.parse(json);
    const canonical = JSON.stringify(obj, sortedKeysReplacer);
    return createHash("sha256").update(canonical).digest("hex");
  }

  /**
   * Extract filter columns from a delta input record.
   *
   * These columns mirror the indexed columns on the instruments table and
   * enable fast lookups without scanning the full CDM JSON.
   */
  extractFilterColumns(record: DeltaInputRecord): FilterColumns {
    return {
      mic: record.mic,
      symbol: record.venue_symbol,
      isin: record.isin,
      asset_class: record.asset_class,
      currency: record.currency,
      effective_from: record.effective_from,
      effective_to: null,
    };
  }

  /**
   * Apply a delta: hash all incoming records, diff against the current pool
   * state for the given venue, and apply adds/updates/delistings inside a
   * single transaction. Changes are recorded in the `changes` table.
   *
   * @param records   Incoming normalised records from the pipeline.
   * @param venue     The MIC of the venue being processed.
   * @param ingestRunId  FK to the ingest_runs row for this pipeline execution.
   * @param effectiveDate  Business date for the delta run (defaults to today).
   * @param recordedAt     System timestamp for recorded_from/recorded_to (defaults to now).
   */
  applyDelta(
    records: DeltaInputRecord[],
    venue: string,
    ingestRunId: number,
    effectiveDate?: string,
    recordedAt?: string
  ): DeltaResult {
    const effDate = effectiveDate ?? todayISO();
    const recAt = recordedAt ?? new Date().toISOString();

    // Step 1: Hash all incoming records
    const incomingMap = new Map<
      string,
      DeltaInputRecord & { content_hash: string }
    >();
    for (const record of records) {
      const content_hash = this.computeHash(record.cdm_json);
      const key = makeKey(record.mic, record.venue_symbol);
      incomingMap.set(key, { ...record, content_hash });
    }

    // Step 2: Fetch current active pool state for the venue
    const active = this.getActiveRecords(venue);
    const activeByKey = new Map<string, ActivePoolRecord>();
    for (const row of active) {
      activeByKey.set(makeKey(row.mic, row.venue_symbol), row);
    }

    // Step 3: Diff within a transaction
    const result: DeltaResult = {
      records_added: 0,
      records_updated: 0,
      records_delisted: 0,
      changes: [],
    };

    const processedPoolKeys = new Set<string>();

    const transaction = this.db.transaction(() => {
      const insertStmt = this.db.prepare(
        `INSERT INTO instruments
           (mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
            effective_from, effective_to, recorded_from, recorded_to,
            source_id, ingest_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`
      );

      const closeOutStmt = this.db.prepare(
        `UPDATE instruments
           SET effective_to = ?, recorded_to = ?
         WHERE id = ?`
      );

      const changeStmt = this.db.prepare(
        `INSERT INTO changes
           (instrument_id, ingest_run_id, change_type, before_hash, after_hash, changed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );

      // Process each incoming record
      for (const [, record] of incomingMap) {
        const key = makeKey(record.mic, record.venue_symbol);
        processedPoolKeys.add(key);

        const existing = activeByKey.get(key);

        if (!existing) {
          // ADD: new record not in pool
          const insertResult = insertStmt.run(
            record.mic,
            record.venue_symbol,
            record.asset_class,
            record.currency,
            record.cdm_json,
            record.content_hash,
            record.effective_from,
            recAt,
            ingestRunId
          );
          const newId = Number(insertResult.lastInsertRowid);
          changeStmt.run(
            newId,
            ingestRunId,
            "add",
            null,
            record.content_hash,
            recAt
          );
          result.records_added++;
          result.changes.push({
            instrument_id: newId,
            ingest_run_id: ingestRunId,
            change_type: "add",
            before_hash: null,
            after_hash: record.content_hash,
          });
        } else if (existing.content_hash !== record.content_hash) {
          // UPDATE: same (mic, venue_symbol), different hash
          // 1. Close out the old row
          closeOutStmt.run(effDate, recAt, existing.id);
          // 2. Insert the new row
          const insertResult = insertStmt.run(
            record.mic,
            record.venue_symbol,
            record.asset_class,
            record.currency,
            record.cdm_json,
            record.content_hash,
            record.effective_from,
            recAt,
            ingestRunId
          );
          const newId = Number(insertResult.lastInsertRowid);
          changeStmt.run(
            newId,
            ingestRunId,
            "update",
            existing.content_hash,
            record.content_hash,
            recAt
          );
          result.records_updated++;
          result.changes.push({
            instrument_id: newId,
            ingest_run_id: ingestRunId,
            change_type: "update",
            before_hash: existing.content_hash,
            after_hash: record.content_hash,
          });
        }
        // else: NO CHANGE (hash matches) — skip
      }

      // DELIST: active pool records not present in the incoming snapshot
      for (const [key, existing] of activeByKey) {
        if (!processedPoolKeys.has(key)) {
          closeOutStmt.run(effDate, recAt, existing.id);
          changeStmt.run(
            existing.id,
            ingestRunId,
            "delist",
            existing.content_hash,
            null,
            recAt
          );
          result.records_delisted++;
          result.changes.push({
            instrument_id: existing.id,
            ingest_run_id: ingestRunId,
            change_type: "delist",
            before_hash: existing.content_hash,
            after_hash: null,
          });
        }
      }
    });

    transaction();
    return result;
  }

  /**
   * Return all currently-active (recorded_to IS NULL) instrument rows for a venue.
   */
  getActiveRecords(venue: string): ActivePoolRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, mic, venue_symbol, content_hash
         FROM instruments
         WHERE mic = ? AND recorded_to IS NULL
         ORDER BY venue_symbol`
      )
      .all(venue) as ActivePoolRecord[];
    return rows;
  }

  /**
   * Return instrument rows that are effective as of the given business date
   * and are current in system time (recorded_to IS NULL).
   *
   * A row is effective at `asOf` when:
   *   effective_from <= asOf  AND  (effective_to IS NULL OR effective_to > asOf)
   */
  queryEffectiveAsOf(venue: string, asOf: string): InstrumentRow[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM instruments
         WHERE mic = ?
           AND effective_from <= ?
           AND (effective_to IS NULL OR effective_to > ?)
           AND recorded_to IS NULL
         ORDER BY venue_symbol`
      )
      .all(venue, asOf, asOf) as InstrumentRow[];
    return rows;
  }

  /**
   * Return all instrument rows (all system-time versions) for a venue.
   * Useful for inspecting the full bitemporal history in tests.
   */
  getAllRows(venue: string): InstrumentRow[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM instruments
         WHERE mic = ?
         ORDER BY venue_symbol, recorded_from`
      )
      .all(venue) as InstrumentRow[];
    return rows;
  }
}

/** Build a stable lookup key from MIC and venue symbol. */
function makeKey(mic: string, venue_symbol: string): string {
  return `${mic}::${venue_symbol}`;
}

/**
 * JSON.stringify replacer that recursively sorts object keys.
 * Produces canonical JSON regardless of insertion order.
 */
function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      )
    );
  }
  return value;
}

/** Return today's date as YYYY-MM-DD. */
function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear().toString();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
