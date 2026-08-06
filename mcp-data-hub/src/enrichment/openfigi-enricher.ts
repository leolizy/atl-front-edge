import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Summary returned by OpenFigiEnricher.enrich(). */
export interface EnrichmentResult {
  /** Venue MIC that was processed. */
  venue: string;
  /** Number of instruments that were checked. */
  checked: number;
  /** Number of FIGI identifiers successfully written. */
  enriched: number;
  /** Number of instruments that already had a FIGI (skipped). */
  skipped: number;
  /** Number of enrichment attempts that failed (non-blocking). */
  failed: number;
  /** Error messages from failed enrichments. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Enricher
// ---------------------------------------------------------------------------

/**
 * OpenFIGI cross-reference enrichment.
 *
 * Runs after the core delta pipeline completes. Maps (venue_symbol, MIC) pairs
 * to FIGI identifiers via a mock OpenFIGI API (v1) and writes the results into
 * the `identifiers` cross-ref table.
 *
 * Enrichment is best-effort: individual failures are logged but never block the
 * pipeline. The module is gated behind the `OPENFIGI_ENABLED` environment
 * variable (or config toggle).
 */
export class OpenFigiEnricher {
  constructor(private db: Database.Database) {}

  /**
   * Check whether enrichment is enabled via the config gate.
   *
   * The gate reads the `OPENFIGI_ENABLED` environment variable.  Any
   * truthy value (`"true"`, `"1"`, `"yes"`) enables enrichment.
   */
  isEnabled(): boolean {
    const raw = process.env["OPENFIGI_ENABLED"];
    if (raw === undefined) return false;
    const lower = raw.trim().toLowerCase();
    return lower === "true" || lower === "1" || lower === "yes";
  }

  /**
   * Run enrichment for all active instruments at a venue.
   *
   * For each active instrument that does not already have a FIGI identifier,
   * calls the mock OpenFIGI API to produce a plausible FIGI and writes it to
   * the `identifiers` table.
   *
   * @param venue  The MIC of the venue to enrich (e.g. "XNYS").
   * @returns      Summary of the enrichment run.
   */
  enrich(venue: string): EnrichmentResult {
    const result: EnrichmentResult = {
      venue,
      checked: 0,
      enriched: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    if (!this.isEnabled()) {
      return result;
    }

    // Fetch all active instruments for the venue
    const instruments = this.getActiveInstruments(venue);
    result.checked = instruments.length;

    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO identifiers (instrument_id, type, value)
       VALUES (?, 'FIGI', ?)`
    );

    for (const row of instruments) {
      // Skip instruments that already have a FIGI entry
      if (this.hasFigi(row.instrument_id)) {
        result.skipped++;
        continue;
      }

      try {
        const figi = this.mockLookup(row.venue_symbol, row.mic);
        insertStmt.run(row.instrument_id, figi);
        result.enriched++;
      } catch (err) {
        result.failed++;
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(
          `FIGI enrichment failed for ${row.mic}:${row.venue_symbol} (instrument_id=${row.instrument_id}): ${message}`
        );
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Return active instrument rows for a venue. */
  private getActiveInstruments(
    venue: string
  ): { instrument_id: number; venue_symbol: string; mic: string }[] {
    const rows = this.db
      .prepare(
        `SELECT id AS instrument_id, venue_symbol, mic
         FROM instruments
         WHERE mic = ? AND recorded_to IS NULL
         ORDER BY venue_symbol`
      )
      .all(venue) as {
      instrument_id: number;
      venue_symbol: string;
      mic: string;
    }[];
    return rows;
  }

  /** Check whether an instrument already has a FIGI identifier. */
  private hasFigi(instrumentId: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM identifiers
         WHERE instrument_id = ? AND type = 'FIGI'
         LIMIT 1`
      )
      .get(instrumentId);
    return row !== undefined;
  }

  /**
   * Mock OpenFIGI lookup.
   *
   * In v1 this produces a deterministic, plausible FIGI from the venue symbol
   * and MIC.  The pattern is "BBG000" + first 6 hex chars of SHA-256(symbol).
   *
   * Replace with a real OpenFIGI API call in a future version.
   */
  private mockLookup(venueSymbol: string, _mic: string): string {
    // Simulate network latency
    const hash = createHash("sha256").update(venueSymbol).digest("hex");
    return `BBG000${hash.substring(0, 6).toUpperCase()}`;
  }
}
