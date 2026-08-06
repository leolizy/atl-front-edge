import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceRegistry } from "./source-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FetchMetadata {
  /** File name extracted from the source location path. */
  file_name: string;
  /** ISO-8601 timestamp of when the fetch completed. */
  fetch_timestamp: string;
  /** SHA-256 hex digest of the file bytes (audit trail). */
  file_hash: string;
  /** The approved source location that was fetched. */
  source_location: string;
}

export interface FetchResult {
  available: true;
  /** Raw file bytes. */
  bytes: Buffer;
  metadata: FetchMetadata;
}

export interface UnavailableResult {
  available: false;
  /** Human-readable reason the snapshot could not be fetched. */
  reason: string;
  /** Source location(s) that were attempted (empty if no approved sources exist). */
  source_location: string;
  /** ISO-8601 timestamp of when the fetch attempt was made. */
  fetch_timestamp: string;
}

export type SnapshotResult = FetchResult | UnavailableResult;

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

export class SnapshotFetcher {
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly sourceRegistry: SourceRegistry,
    defaultTimeoutMs = 30_000
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Fetch the latest snapshot for a venue from its approved sources.
   *
   * Iterates through every approved source for the given MIC (most-recently-
   * approved first) and returns the first successful fetch.  If no approved
   * sources exist, or every source fails, an {@link UnavailableResult} is
   * returned — the caller treats this as a no-op, not an error.
   *
   * @param venue_mic  The MIC of the venue to fetch a snapshot for.
   * @param timeoutMs  Optional per-call timeout override (ms).
   */
  async fetch(venue_mic: string, timeoutMs?: number): Promise<SnapshotResult> {
    const sources = this.sourceRegistry.list_sources(venue_mic);

    if (sources.length === 0) {
      return {
        available: false,
        reason: `No approved sources for venue ${venue_mic}`,
        source_location: "",
        fetch_timestamp: new Date().toISOString(),
      };
    }

    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    for (const source of sources) {
      try {
        return await this.fetchFromLocation(source.location, timeout);
      } catch {
        // Try the next approved source
        continue;
      }
    }

    return {
      available: false,
      reason: `Failed to fetch from all approved sources for venue ${venue_mic}`,
      source_location: sources.map((s) => s.location).join(", "),
      fetch_timestamp: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Fetch a single snapshot from a specific location.
   *
   * Refuses unapproved locations as a hard precondition.  Supports:
   * - `http://` / `https://` — standard HTTP GET
   * - `file://`            — local filesystem read
   */
  private async fetchFromLocation(
    location: string,
    timeoutMs: number
  ): Promise<FetchResult> {
    // Hard precondition — never fetch from an unapproved location
    if (!this.sourceRegistry.is_approved(location)) {
      throw new Error(
        `Source location "${location}" is not approved — refusing to fetch`
      );
    }

    const url = new URL(location);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let bytes: Buffer;
      let fileName: string;

      if (url.protocol === "file:") {
        const filePath = fileURLToPath(url);
        const data = await readFile(filePath);
        bytes = Buffer.from(data);
        fileName = path.basename(filePath);
      } else if (url.protocol === "http:" || url.protocol === "https:") {
        const response = await fetch(location, {
          signal: controller.signal,
        });

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(`File not found at ${location}`);
          }
          throw new Error(
            `HTTP ${response.status} fetching ${location}: ${response.statusText}`
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        bytes = Buffer.from(arrayBuffer);

        // Derive a file name from the URL path; fall back to "snapshot"
        fileName = path.basename(url.pathname) || "snapshot";
      } else {
        throw new Error(`Unsupported protocol: ${url.protocol}`);
      }

      const fileHash = createHash("sha256").update(bytes).digest("hex");

      return {
        available: true,
        bytes,
        metadata: {
          file_name: fileName,
          fetch_timestamp: new Date().toISOString(),
          file_hash: fileHash,
          source_location: location,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
