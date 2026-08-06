import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import type { SourceRegistry } from "../../sources/source-registry.js";
import type { IngestPipeline } from "../../pipeline/ingest-pipeline.js";
import type { DictionaryGenerator } from "../../dictionary/dictionary-generator.js";
import type { Adapter } from "../../adapters/adapter.js";
import type { StockProfile } from "../../assembler/types.js";
import { assemble } from "../../assembler/cdm-assembler.js";
import { validate } from "../../validator/profile-validator.js";
import { DeltaEngine } from "../../delta/delta-engine.js";

/**
 * Register all admin-facing MCP tools on the given server.
 *
 * Tools:
 *   - approve_source(mic, location, terms_note?)
 *   - trigger_ingest(mic)
 *   - review_quarantine(ingest_run_id?)
 *   - reprocess_quarantine(quarantine_id)
 *   - update_alias(term, canonical_field, layer)
 *   - regenerate_dictionary()
 */
export function registerAdminTools(
  server: McpServer,
  db: Database.Database,
  sourceRegistry: SourceRegistry,
  pipeline: IngestPipeline,
  dict: DictionaryGenerator,
  adapters: Record<string, Adapter>,
  profile: StockProfile
): void {
  //
  // approve_source
  //
  server.registerTool(
    "approve_source",
    {
      description:
        "Approve a data source location for a given MIC. Records the approval with a timestamp so the fetcher will recognise it as trusted.",
      inputSchema: {
        mic: z
          .string()
          .describe("ISO 10383 MIC of the venue (e.g. XNYS, XHKG)"),
        location: z
          .string()
          .describe(
            "Source location URL (file://, http://, or https://). The fetcher will only pull from approved locations."
          ),
        terms_note: z
          .string()
          .optional()
          .describe("Optional free-text note about terms of use"),
      },
    },
    async (args) => {
      const result = sourceRegistry.approve_source(
        args.mic,
        args.location,
        "mcp-admin",
        args.terms_note
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
              approved_at: result.approved_at,
              mic: args.mic,
              location: args.location,
            }),
          },
        ],
      };
    }
  );

  //
  // trigger_ingest
  //
  server.registerTool(
    "trigger_ingest",
    {
      description:
        "Trigger an ingest pipeline run for a single venue. Runs the full pipeline (fetch -> parse -> assemble -> validate -> delta) and returns a run summary with counts.",
      inputSchema: {
        mic: z.string().describe("Venue MIC to ingest (e.g. XNYS, XHKG)"),
      },
    },
    async (args) => {
      const adapter = adapters[args.mic];
      if (!adapter) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `No adapter registered for MIC '${args.mic}'`,
              }),
            },
          ],
          isError: true as const,
        };
      }

      const report = await pipeline.runIngest(
        { venue: args.mic },
        adapter,
        profile
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(report),
          },
        ],
      };
    }
  );

  //
  // review_quarantine
  //
  server.registerTool(
    "review_quarantine",
    {
      description:
        "List quarantined records with failure reasons. Optionally filter by ingest run id.",
      inputSchema: {
        ingest_run_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Filter to a specific ingest run. If omitted, returns all pending quarantined records."
          ),
      },
    },
    async (args) => {
      let rows: unknown[];
      if (args.ingest_run_id) {
        rows = db
          .prepare(
            `SELECT q.id, q.ingest_run_id, q.record_index, q.raw_record_json,
                    q.failure_reasons, q.created_at, q.status,
                    ir.venue
             FROM quarantine q
             JOIN ingest_runs ir ON ir.id = q.ingest_run_id
             WHERE q.ingest_run_id = @ingest_run_id
             ORDER BY q.id`
          )
          .all({ ingest_run_id: args.ingest_run_id });
      } else {
        rows = db
          .prepare(
            `SELECT q.id, q.ingest_run_id, q.record_index, q.raw_record_json,
                    q.failure_reasons, q.created_at, q.status,
                    ir.venue
             FROM quarantine q
             JOIN ingest_runs ir ON ir.id = q.ingest_run_id
             WHERE q.status = 'pending'
             ORDER BY q.id`
          )
          .all();
      }

      const parsed = (rows as Array<Record<string, unknown>>).map((row) => ({
        ...row,
        raw_record: JSON.parse(row.raw_record_json as string),
        failure_reasons: JSON.parse(row.failure_reasons as string),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              quarantine_records: parsed,
              total: parsed.length,
            }),
          },
        ],
      };
    }
  );

  //
  // reprocess_quarantine
  //
  server.registerTool(
    "reprocess_quarantine",
    {
      description:
        "Re-validate a quarantined record against the current stock profile. If it passes, feeds the record into the delta engine and updates the quarantine status to 'reprocessed'. Returns the validation result and, if successful, the delta change entry.",
      inputSchema: {
        quarantine_id: z
          .number()
          .int()
          .positive()
          .describe("The id of the quarantine record to reprocess"),
      },
    },
    async (args) => {
      const row = db
        .prepare(
          `SELECT q.id, q.ingest_run_id, q.record_index, q.raw_record_json,
                  q.failure_reasons, q.created_at, q.status
           FROM quarantine q
           WHERE q.id = @quarantine_id`
        )
        .get({ quarantine_id: args.quarantine_id }) as
        | {
            id: number;
            ingest_run_id: number;
            record_index: number;
            raw_record_json: string;
            failure_reasons: string;
            created_at: string;
            status: string;
          }
        | undefined;

      if (!row) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Quarantine record ${args.quarantine_id} not found`,
              }),
            },
          ],
          isError: true as const,
        };
      }

      if (row.status !== "pending") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Quarantine record ${args.quarantine_id} is already '${row.status}'`,
              }),
            },
          ],
          isError: true as const,
        };
      }

      // Parse the raw record
      let rawRecord: Record<string, unknown>;
      try {
        rawRecord = JSON.parse(row.raw_record_json);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to parse raw_record_json for quarantine ${args.quarantine_id}`,
              }),
            },
          ],
          isError: true as const,
        };
      }

      // Assemble into CDM document
      const cdmDoc = assemble(rawRecord as any, profile);

      // Validate against the current profile
      const validationResult = validate(cdmDoc, profile);

      if (!validationResult.valid) {
        // Still invalid — update failure reasons
        const newReasons = JSON.stringify(
          validationResult.failures.map((f) => f.reason)
        );
        db.prepare(
          `UPDATE quarantine SET failure_reasons = ?, status = 'pending'
           WHERE id = ?`
        ).run(newReasons, args.quarantine_id);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                quarantine_id: args.quarantine_id,
                status: "still_invalid",
                failures: validationResult.failures,
              }),
            },
          ],
        };
      }

      // Record passes — feed into delta engine
      const deltaEngine = new DeltaEngine(db);
      const effectiveDate = new Date().toISOString().slice(0, 10);
      const cdmJson = JSON.stringify(cdmDoc);

      // Create a new ingest_run for the reprocessing
      const runStartedAt = new Date().toISOString();
      const insertRun = db.prepare(
        `INSERT INTO ingest_runs
           (venue, window_start, window_end, file_hash, file_name,
            records_total, records_added, records_updated, records_delisted,
            records_quarantined, outcome, run_started_at)
         VALUES (?, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 'success', ?)`
      );
      const runResult = insertRun.run(
        (rawRecord.mic as string) ?? "unknown",
        runStartedAt
      );
      const newIngestRunId = Number(runResult.lastInsertRowid);

      const deltaResult = deltaEngine.applyDelta(
        [
          {
            mic: (rawRecord.mic as string) ?? "unknown",
            venue_symbol: (rawRecord.venue_symbol as string) ?? "",
            isin: (rawRecord.isin as string) ?? "",
            instrument_name: (rawRecord.instrument_name as string) ?? "",
            currency: (rawRecord.currency as string) ?? "",
            asset_class: (rawRecord.asset_class as string) ?? "stock",
            cdm_json: cdmJson,
            effective_from: effectiveDate,
            attributes: (rawRecord.attributes as Record<string, string>) ?? {},
          },
        ],
        (rawRecord.mic as string) ?? "unknown",
        newIngestRunId,
        effectiveDate,
        runStartedAt
      );

      // Finalize the ingest run
      const runCompletedAt = new Date().toISOString();
      db.prepare(
        `UPDATE ingest_runs
           SET records_total = ?,
               records_added = ?,
               records_updated = ?,
               records_delisted = ?,
               records_quarantined = ?,
               outcome = ?,
               run_completed_at = ?
         WHERE id = ?`
      ).run(
        1,
        deltaResult.records_added || 1,
        deltaResult.records_updated,
        deltaResult.records_delisted,
        0,
        "success",
        runCompletedAt,
        newIngestRunId
      );

      // Update quarantine status
      db.prepare(
        `UPDATE quarantine SET status = 'reprocessed' WHERE id = ?`
      ).run(args.quarantine_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              quarantine_id: args.quarantine_id,
              status: "reprocessed",
              ingest_run_id: newIngestRunId,
              delta: {
                records_added: deltaResult.records_added,
                records_updated: deltaResult.records_updated,
                records_delisted: deltaResult.records_delisted,
                changes: deltaResult.changes,
              },
            }),
          },
        ],
      };
    }
  );

  //
  // update_alias
  //
  server.registerTool(
    "update_alias",
    {
      description:
        "Add or update an alias in the dictionary. Maps a term to a canonical field in the specified layer. After updating, the dictionary cache is regenerated so lookup_term resolves the new alias.",
      inputSchema: {
        term: z.string().describe("The alias term to add or update"),
        canonical_field: z
          .string()
          .describe("The canonical field name this alias resolves to"),
        layer: z
          .enum(["cdm", "ext", "lineage", "alias"])
          .describe("Dictionary layer for this alias"),
      },
    },
    async (args) => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT OR REPLACE INTO aliases (term, canonical_field, layer, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(args.term, args.canonical_field, args.layer, now);

      // Reload the dictionary so the alias cache picks up the change
      dict.regenerate();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              term: args.term,
              canonical_field: args.canonical_field,
              layer: args.layer,
              updated_at: now,
            }),
          },
        ],
      };
    }
  );

  //
  // regenerate_dictionary
  //
  server.registerTool(
    "regenerate_dictionary",
    {
      description:
        "Regenerate the entire dictionary from all four source layers (CDM types, extensions, lineage, and aliases). Use after adding aliases or updating config files.",
      inputSchema: {},
    },
    async () => {
      dict.regenerate();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "regenerated",
              message:
                "Dictionary regenerated from CDM types, extensions, lineage, and aliases.",
            }),
          },
        ],
      };
    }
  );
}
