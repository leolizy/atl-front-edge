import type { NormalizedRecord, VenueContext } from "./types.js";

/**
 * Adapter contract for venue snapshot parsers.
 *
 * Every venue adapter exports a single `parse` function conforming to this
 * signature.  Adapters are **pure** — they receive raw file bytes and context
 * and return normalized records.  All I/O (fetching, filesystem reads) is
 * handled by the caller.
 */
export interface Adapter {
  /**
   * Parse a venue snapshot file into zero or more normalized instrument records.
   *
   * @param fileBytes  Raw bytes of the venue snapshot file.
   * @param venueContext  Context carrying MIC, instrument category, and profile reference.
   * @returns  Array of normalized records (empty if the file contained no rows).
   */
  parse(fileBytes: Buffer, venueContext: VenueContext): NormalizedRecord[];
}
