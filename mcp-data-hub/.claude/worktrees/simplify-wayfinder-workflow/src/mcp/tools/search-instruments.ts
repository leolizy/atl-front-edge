import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type BetterSqlite3 from "better-sqlite3";
type Database = BetterSqlite3.Database;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive status from effective dates relative to an as_of date. */
function deriveStatus(
  effectiveFrom: string,
  effectiveTo: string | null,
  asOf: string
): "announced" | "active" | "delisted" {
  if (effectiveFrom > asOf) return "announced";
  if (effectiveTo !== null && effectiveTo <= asOf) return "delisted";
  return "active";
}

/** today's date in YYYY-MM-DD (UTC). */
function todayStr(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/** Parse a CDM JSON text column into an object. */
function parseCdmJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Extract per-field lineage from the CDM JSON (if the adapter stored it). */
function extractLineage(cdm: unknown): unknown {
  if (
    cdm &&
    typeof cdm === "object" &&
    "_lineage" in (cdm as Record<string, unknown>)
  ) {
    return (cdm as Record<string, unknown>)._lineage;
  }
  return {};
}

/** Shape of an instrument row returned from SQLite joins. */
interface InstrumentRow {
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
  source_id: number;
  ingest_run_id: number;
  source_location?: string;
  source_approver?: string;
  ingest_file_hash?: string;
  ingest_started_at?: string;
}

/** Shape of a single search-result instrument. */
interface InstrumentResult {
  mic: string;
  venue_symbol: string;
  asset_class: string;
  currency: string;
  status: "announced" | "active" | "delisted";
  cdm_json: unknown;
  content_hash: string;
  effective_from: string;
  effective_to: string | null;
  recorded_from: string;
  provenance: {
    source_name: string;
    source_location: string | null;
    source_approver: string | null;
    ingest_run_id: number;
    recorded_at: string;
  };
  lineage: unknown;
}

/** Build a result object from a DB row + derived status. */
function toInstrumentResult(
  row: InstrumentRow,
  status: "announced" | "active" | "delisted"
): InstrumentResult {
  const cdm = parseCdmJson(row.cdm_json);
  return {
    mic: row.mic,
    venue_symbol: row.venue_symbol,
    asset_class: row.asset_class,
    currency: row.currency,
    status,
    cdm_json: cdm,
    content_hash: row.content_hash,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    recorded_from: row.recorded_from,
    provenance: {
      source_name: row.source_location ?? `source-${row.source_id}`,
      source_location: row.source_location ?? null,
      source_approver: row.source_approver ?? null,
      ingest_run_id: row.ingest_run_id,
      recorded_at: row.recorded_from,
    },
    lineage: extractLineage(cdm),
  };
}

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

/** Base JOIN that fetches instruments with source + ingest_run provenance. */
const INSTRUMENT_SELECT = `
SELECT
  i.id,
  i.mic,
  i.venue_symbol,
  i.asset_class,
  i.currency,
  i.cdm_json,
  i.content_hash,
  i.effective_from,
  i.effective_to,
  i.recorded_from,
  i.recorded_to,
  i.source_id,
  i.ingest_run_id,
  s.location   AS source_location,
  s.approver   AS source_approver,
  ir.file_hash AS ingest_file_hash,
  ir.run_started_at AS ingest_started_at
FROM instruments i
JOIN sources s   ON i.source_id = s.id
JOIN ingest_runs ir ON i.ingest_run_id = ir.id
`;

// ---------------------------------------------------------------------------
// registerSearchInstrumentsTool
// ---------------------------------------------------------------------------

export function registerSearchInstrumentsTool(
  server: McpServer,
  db: Database
): void {
  server.registerTool(
    "search_instruments",
    {
      description:
        "Search instruments in the pool with filters (MIC, asset class, currency, status, symbol pattern). " +
        "Status is derived from effective_from/effective_to relative to as_of date.",
      inputSchema: {
        mic: z.string().optional().describe("MIC code of the exchange"),
        asset_class: z
          .enum(["stock", "commodity_future"])
          .optional()
          .describe("Asset class filter"),
        currency: z.string().optional().describe("ISO 4217 currency code"),
        status: z
          .enum(["announced", "active", "delisted"])
          .optional()
          .describe("Derived status relative to as_of"),
        symbol_pattern: z
          .string()
          .optional()
          .describe("SQL LIKE pattern for venue_symbol"),
        as_of: z
          .string()
          .optional()
          .describe(
            "Business date (YYYY-MM-DD) for status derivation; defaults to today"
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Max results to return"),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Offset for pagination"),
      },
    },
    async (args) => {
      const asOf = args.as_of ?? todayStr();

      // Build WHERE clauses and named-parameter bindings
      const whereFragments: string[] = ["i.recorded_to IS NULL"];
      const params: Record<string, string | number | null> = { as_of: asOf };

      if (args.mic !== undefined) {
        whereFragments.push("i.mic = @mic");
        params.mic = args.mic;
      }
      if (args.asset_class !== undefined) {
        whereFragments.push("i.asset_class = @asset_class");
        params.asset_class = args.asset_class;
      }
      if (args.currency !== undefined) {
        whereFragments.push("i.currency = @currency");
        params.currency = args.currency;
      }
      if (args.symbol_pattern !== undefined) {
        whereFragments.push("i.venue_symbol LIKE @symbol_pattern");
        params.symbol_pattern = args.symbol_pattern;
      }

      const whereClause = whereFragments.join(" AND ");

      // Status filter via derived column (subquery)
      const statusFilter =
        args.status !== undefined ? " AND derived.status = @status" : "";
      if (args.status !== undefined) {
        params.status = args.status;
      }

      const countSql = `
        SELECT COUNT(*) as total FROM (
          SELECT 1,
            CASE
              WHEN i.effective_from > @as_of THEN 'announced'
              WHEN i.effective_to IS NOT NULL AND i.effective_to <= @as_of THEN 'delisted'
              ELSE 'active'
            END as status
          FROM instruments i
          WHERE ${whereClause}
        ) derived
        WHERE 1=1 ${statusFilter}
      `;

      const searchSql = `
        SELECT * FROM (
          SELECT i.*, s.location AS source_location, s.approver AS source_approver,
                 ir.file_hash AS ingest_file_hash, ir.run_started_at AS ingest_started_at,
            CASE
              WHEN i.effective_from > @as_of THEN 'announced'
              WHEN i.effective_to IS NOT NULL AND i.effective_to <= @as_of THEN 'delisted'
              ELSE 'active'
            END as status
          FROM instruments i
          JOIN sources s ON i.source_id = s.id
          JOIN ingest_runs ir ON i.ingest_run_id = ir.id
          WHERE ${whereClause}
        ) derived
        WHERE 1=1 ${statusFilter}
        ORDER BY derived.mic, derived.venue_symbol
        LIMIT @limit OFFSET @offset
      `;

      params.limit = args.limit;
      params.offset = args.offset;

      const { total } = db.prepare(countSql).get(params) as { total: number };
      const rows = db.prepare(searchSql).all(params) as (InstrumentRow & {
        status: "announced" | "active" | "delisted";
      })[];

      const results = rows.map((row) => toInstrumentResult(row, row.status));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ results, total }, null, 2),
          },
        ],
      };
    }
  );
}

// ---------------------------------------------------------------------------
// registerGetInstrumentTool
// ---------------------------------------------------------------------------

export function registerGetInstrumentTool(
  server: McpServer,
  db: Database
): void {
  server.registerTool(
    "get_instrument",
    {
      description:
        "Retrieve a single instrument by MIC and venue symbol with full CDM record and provenance.",
      inputSchema: {
        mic: z.string().describe("MIC code of the exchange"),
        symbol: z.string().describe("Venue-specific symbol"),
        as_of: z
          .string()
          .optional()
          .describe(
            "Business date (YYYY-MM-DD) to retrieve the version effective at that time"
          ),
      },
    },
    async (args) => {
      const asOf = args.as_of ?? todayStr();

      const sql = `
        ${INSTRUMENT_SELECT}
        WHERE i.recorded_to IS NULL
          AND i.mic = ?
          AND i.venue_symbol = ?
          AND (i.effective_from <= ? AND (i.effective_to IS NULL OR i.effective_to > ?))
        ORDER BY i.effective_from DESC
        LIMIT 1
      `;

      const row = db.prepare(sql).get(args.mic, args.symbol, asOf, asOf) as
        InstrumentRow | undefined;

      if (!row) {
        // Try without the effective-date filter as a fallback (latest known version)
        const fallbackSql = `
          ${INSTRUMENT_SELECT}
          WHERE i.recorded_to IS NULL
            AND i.mic = ?
            AND i.venue_symbol = ?
          ORDER BY i.effective_from DESC
          LIMIT 1
        `;
        const fallbackRow = db
          .prepare(fallbackSql)
          .get(args.mic, args.symbol) as InstrumentRow | undefined;

        if (!fallbackRow) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Instrument not found: ${args.mic}:${args.symbol}`,
                }),
              },
            ],
          };
        }

        const status = deriveStatus(
          fallbackRow.effective_from,
          fallbackRow.effective_to,
          todayStr()
        );
        const result = toInstrumentResult(fallbackRow, status);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...result,
                  note: "No version effective at requested as_of; returning latest recorded version.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const status = deriveStatus(
        row.effective_from,
        row.effective_to,
        todayStr()
      );
      const result = toInstrumentResult(row, status);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}

// ---------------------------------------------------------------------------
// registerInstrumentResource
// ---------------------------------------------------------------------------

export function registerInstrumentResource(
  server: McpServer,
  db: Database
): void {
  server.registerResource(
    "instrument",
    new ResourceTemplate("instrument://{mic}/{symbol}", { list: undefined }),
    {
      description:
        "CDM JSON document for a single instrument, identified by MIC and venue symbol. " +
        "Supports optional ?as_of=YYYY-MM-DD query parameter.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const mic = variables.mic as string;
      const symbol = variables.symbol as string;
      const asOf = uri.searchParams.get("as_of") || todayStr();

      const sql = `
        SELECT i.cdm_json
        FROM instruments i
        WHERE i.recorded_to IS NULL
          AND i.mic = ?
          AND i.venue_symbol = ?
          AND (i.effective_from <= ? AND (i.effective_to IS NULL OR i.effective_to > ?))
        ORDER BY i.effective_from DESC
        LIMIT 1
      `;

      const row = db.prepare(sql).get(mic, symbol, asOf, asOf) as
        { cdm_json: string } | undefined;

      if (!row) {
        // Fallback to latest known version
        const fallbackSql = `
          SELECT i.cdm_json
          FROM instruments i
          WHERE i.recorded_to IS NULL
            AND i.mic = ?
            AND i.venue_symbol = ?
          ORDER BY i.effective_from DESC
          LIMIT 1
        `;
        const fallbackRow = db.prepare(fallbackSql).get(mic, symbol) as
          { cdm_json: string } | undefined;

        if (!fallbackRow) {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({
                  error: `Instrument not found: ${mic}:${symbol}`,
                }),
              },
            ],
          };
        }

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: fallbackRow.cdm_json,
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: row.cdm_json,
          },
        ],
      };
    }
  );
}
