import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";

/**
 * Hardcoded venue catalog for v1.
 * TODO(ticket-22): promote to database table once onboarding workflow solidifies.
 */
const VENUES = [
  {
    mic: "XNYS",
    name: "NYSE (New York Stock Exchange)",
    asset_class: "stock",
    notes: "US equities, end-of-day snapshots",
  },
  {
    mic: "XHKG",
    name: "HKEX (Hong Kong Exchange)",
    asset_class: "stock",
    notes: "HK equities, end-of-day snapshots",
  },
  {
    mic: "XSES",
    name: "SGX (Singapore Exchange)",
    asset_class: "stock",
    notes: "SG equities, end-of-day snapshots",
  },
  {
    mic: "XCME",
    name: "CME (Chicago Mercantile Exchange)",
    asset_class: "commodity_future",
    notes: "US commodity futures, settlement prices",
  },
  {
    mic: "XHKF",
    name: "HKEX Derivatives",
    asset_class: "commodity_future",
    notes: "HK commodity futures, settlement prices",
  },
  {
    mic: "XSIM",
    name: "SGX Derivatives",
    asset_class: "commodity_future",
    notes: "SG commodity futures, settlement prices",
  },
] as const;

/**
 * Registers all changes/ingest/venue operational MCP tools on the given server.
 * Follows the composable pattern: callers provide both server and db.
 */
export function registerChangesOperations(
  server: McpServer,
  db: Database.Database
): void {
  //
  // list_changes
  //
  server.registerTool(
    "list_changes",
    {
      description:
        "List instrument changes with optional filtering by venue, date range, and change type. Returns changes with instrument identity, change type, before/after content hashes, timestamp, and ingest run id.",
      inputSchema: {
        venue: z
          .string()
          .optional()
          .describe("Filter by venue MIC (e.g. XNYS, XHKG)"),
        date_from: z
          .string()
          .optional()
          .describe("Start of changed_at range (ISO 8601, inclusive)"),
        date_to: z
          .string()
          .optional()
          .describe("End of changed_at range (ISO 8601, inclusive)"),
        change_type: z
          .enum(["add", "update", "delist"])
          .optional()
          .describe("Filter by change type"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(100)
          .describe("Max results (1-500, default 100)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Pagination offset (default 0)"),
      },
    },
    async (args) => {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (args.venue) {
        conditions.push("ir.venue = @venue");
        params.venue = args.venue;
      }
      if (args.date_from) {
        conditions.push("ch.changed_at >= @date_from");
        params.date_from = args.date_from;
      }
      if (args.date_to) {
        conditions.push("ch.changed_at <= @date_to");
        params.date_to = args.date_to;
      }
      if (args.change_type) {
        conditions.push("ch.change_type = @change_type");
        params.change_type = args.change_type;
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const countRow = db
        .prepare(
          `SELECT COUNT(*) as total
           FROM changes ch
           JOIN ingest_runs ir ON ir.id = ch.ingest_run_id
           ${where}`
        )
        .get(params) as { total: number };

      params.limit = args.limit;
      params.offset = args.offset;

      const rows = db
        .prepare(
          `SELECT
             ch.id,
             ch.instrument_id,
             ch.ingest_run_id,
             ch.change_type,
             ch.before_hash,
             ch.after_hash,
             ch.changed_at,
             ir.venue,
             i.mic,
             i.venue_symbol,
             i.asset_class,
             i.currency,
             i.content_hash AS current_hash
           FROM changes ch
           JOIN ingest_runs ir ON ir.id = ch.ingest_run_id
           LEFT JOIN instruments i ON i.id = ch.instrument_id
           ${where}
           ORDER BY ch.changed_at DESC, ch.id DESC
           LIMIT @limit OFFSET @offset`
        )
        .all(params);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ changes: rows, total: countRow.total }),
          },
        ],
      };
    }
  );

  //
  // get_change
  //
  server.registerTool(
    "get_change",
    {
      description:
        "Get full change detail including before/after CDM document snapshots for a specific change by id.",
      inputSchema: {
        change_id: z.number().int().positive().describe("The change record id"),
      },
    },
    async (args) => {
      const change = db
        .prepare(
          `SELECT
             ch.id,
             ch.instrument_id,
             ch.ingest_run_id,
             ch.change_type,
             ch.before_hash,
             ch.after_hash,
             ch.changed_at,
             ir.venue,
             ir.window_start,
             ir.window_end,
             ir.outcome AS ingest_outcome,
             ir.run_started_at,
             ir.run_completed_at,
             i.mic,
             i.venue_symbol,
             i.asset_class,
             i.currency,
             i.cdm_json AS current_cdm_json,
             i.content_hash AS current_content_hash
           FROM changes ch
           JOIN ingest_runs ir ON ir.id = ch.ingest_run_id
           LEFT JOIN instruments i ON i.id = ch.instrument_id
           WHERE ch.id = @change_id`
        )
        .get({ change_id: args.change_id });

      if (!change) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Change ${args.change_id} not found`,
              }),
            },
          ],
          isError: true as const,
        };
      }

      // Look up prior instrument version if we have a before_hash
      let beforeCdmJson: string | null = null;
      const row = change as Record<string, unknown>;
      if (row.before_hash) {
        const prior = db
          .prepare(
            `SELECT cdm_json FROM instruments
             WHERE content_hash = @before_hash
             ORDER BY recorded_from DESC
             LIMIT 1`
          )
          .get({ before_hash: row.before_hash }) as
          { cdm_json: string } | undefined;
        beforeCdmJson = prior?.cdm_json ?? null;
      }

      // Look up the instrument version matching after_hash
      let afterCdmJson: string | null = null;
      if (row.after_hash) {
        const after = db
          .prepare(
            `SELECT cdm_json FROM instruments
             WHERE content_hash = @after_hash
             ORDER BY recorded_from DESC
             LIMIT 1`
          )
          .get({ after_hash: row.after_hash }) as
          { cdm_json: string } | undefined;
        afterCdmJson = after?.cdm_json ?? null;
      }

      // For the current instrument CDM
      const currentCdmJson = (row.current_cdm_json as string) ?? null;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...row,
              before_cdm_json: beforeCdmJson ? JSON.parse(beforeCdmJson) : null,
              after_cdm_json: afterCdmJson ? JSON.parse(afterCdmJson) : null,
              current_cdm_json: currentCdmJson
                ? JSON.parse(currentCdmJson)
                : null,
            }),
          },
        ],
      };
    }
  );

  //
  // get_ingest_status
  //
  server.registerTool(
    "get_ingest_status",
    {
      description:
        "Get per-venue ingest status: last successful run time, last run outcome, record counts, and freshness estimate.",
      inputSchema: {
        venue: z
          .string()
          .optional()
          .describe(
            "Filter to a specific venue MIC (e.g. XNYS). If omitted, returns all venues."
          ),
      },
    },
    async (args) => {
      const baseQuery = `
        SELECT
          ir.venue,
          MAX(CASE WHEN ir.outcome = 'success' THEN ir.run_completed_at END) AS last_success_at,
          last_run.outcome AS last_outcome,
          last_run.records_total AS last_records_total,
          last_run.records_added AS last_records_added,
          last_run.records_updated AS last_records_updated,
          last_run.records_delisted AS last_records_delisted,
          last_run.records_quarantined AS last_records_quarantined,
          last_run.run_started_at AS last_run_started_at,
          last_run.run_completed_at AS last_run_completed_at,
          last_run.id AS last_ingest_run_id,
          COUNT(ir.id) AS total_runs
        FROM ingest_runs ir
        JOIN (
          SELECT venue, id, outcome, records_total, records_added, records_updated,
                 records_delisted, records_quarantined, run_started_at, run_completed_at
          FROM ingest_runs
          WHERE id IN (SELECT MAX(id) FROM ingest_runs GROUP BY venue)
        ) last_run ON last_run.venue = ir.venue`;

      const groupClause = ` GROUP BY ir.venue ORDER BY ir.venue`;

      let rows: unknown[];
      if (args.venue) {
        rows = db
          .prepare(`${baseQuery} WHERE ir.venue = @venue${groupClause}`)
          .all({ venue: args.venue });
      } else {
        rows = db.prepare(`${baseQuery}${groupClause}`).all();
      }

      // Calculate freshness: time since last successful run
      const now = new Date().toISOString();
      const statuses = (rows as Array<Record<string, unknown>>).map((row) => {
        const lastSuccess = row.last_success_at as string | null;
        let freshness: string | null = null;
        if (lastSuccess) {
          const diffMs = Date.now() - new Date(lastSuccess).getTime();
          const diffHours = Math.round(diffMs / (1000 * 60 * 60));
          if (diffHours < 1) {
            freshness = "recent (< 1 hour ago)";
          } else if (diffHours < 24) {
            freshness = `${diffHours}h ago`;
          } else {
            const days = Math.round(diffHours / 24);
            freshness = `${days}d ago`;
          }
        } else {
          freshness = "never ingested";
        }

        return {
          ...row,
          freshness,
          checked_at: now,
        };
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(statuses) }],
      };
    }
  );

  //
  // list_venues
  //
  server.registerTool(
    "list_venues",
    {
      description:
        "List all six known trading venues with MIC, name, asset class, and coverage notes. Hardcoded catalog for v1.",
      inputSchema: {},
    },
    async () => {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(VENUES) }],
      };
    }
  );

  //
  // list_sources
  //
  server.registerTool(
    "list_sources",
    {
      description:
        "List approved data sources from the source registry, with approval metadata. Optionally filter by MIC.",
      inputSchema: {
        mic: z
          .string()
          .optional()
          .describe(
            "Filter by MIC (e.g. XNYS). If omitted, returns all approved sources."
          ),
      },
    },
    async (args) => {
      let rows: unknown[];
      if (args.mic) {
        rows = db
          .prepare(
            `SELECT id, mic, location, approver, approved_at, terms_note
             FROM sources
             WHERE mic = @mic
             ORDER BY approved_at DESC`
          )
          .all({ mic: args.mic });
      } else {
        rows = db
          .prepare(
            `SELECT id, mic, location, approver, approved_at, terms_note
             FROM sources
             ORDER BY mic, approved_at DESC`
          )
          .all();
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows) }],
      };
    }
  );
}
