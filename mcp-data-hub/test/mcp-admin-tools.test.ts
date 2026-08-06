import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PoolStore } from "../src/db/pool-store.js";
import { createMcpServer, startMcpServer } from "../src/mcp/server.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = resolve(
  resolve(fileURLToPath(import.meta.url), ".."),
  "fixtures"
);

function createSeededStore(): PoolStore {
  const store = new PoolStore({ dbPath: ":memory:", wal: false });
  store.migrate();
  return store;
}

/** Extract the JSON-parsed text content from a CallToolResult. */
function toolJson(result: CallToolResult): unknown {
  const text = result.content[0] as { type: "text"; text: string } | undefined;
  if (!text || text.type !== "text") {
    throw new Error("Expected text content in tool result");
  }
  try {
    return JSON.parse(text.text);
  } catch {
    // If the tool returned an error as plain text, surface the raw text
    throw new Error(
      `Tool returned non-JSON content: ${text.text.slice(0, 200)}`
    );
  }
}

describe("MCP admin tools", () => {
  let store: PoolStore;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let client: Client;

  beforeEach(() => {
    store = createSeededStore();
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // client may already be closed
    }
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  async function connectAndStart(): Promise<void> {
    await startMcpServer(store, serverTransport);
    await client.connect(clientTransport);
  }

  async function callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<CallToolResult> {
    return client.callTool({ name, arguments: args });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // approve_source
  // ──────────────────────────────────────────────────────────────────────────

  describe("approve_source", () => {
    it("approves a source and the source appears in list_sources", async () => {
      await connectAndStart();

      // Approve a source
      const approveResult = await callTool("approve_source", {
        mic: "XNYS",
        location: "file:///data/xnys-daily.csv",
        terms_note: "Daily end-of-day snapshot",
      });
      const approved = toolJson(approveResult) as {
        id: number;
        approved_at: string;
        mic: string;
        location: string;
      };
      expect(approved.mic).toBe("XNYS");
      expect(approved.location).toBe("file:///data/xnys-daily.csv");
      expect(approved.approved_at).toBeDefined();
      expect(approved.id).toBeGreaterThan(0);

      // Verify it appears in list_sources
      const listResult = await callTool("list_sources", { mic: "XNYS" });
      const sources = toolJson(listResult) as Array<{
        id: number;
        mic: string;
        location: string;
        approver: string;
        approved_at: string;
        terms_note: string | null;
      }>;
      expect(sources).toHaveLength(1);
      expect(sources[0].mic).toBe("XNYS");
      expect(sources[0].location).toBe("file:///data/xnys-daily.csv");
      expect(sources[0].approver).toBe("mcp-admin");
      expect(sources[0].terms_note).toBe("Daily end-of-day snapshot");
    });

    it("approves a source without terms_note", async () => {
      await connectAndStart();

      const result = await callTool("approve_source", {
        mic: "XHKG",
        location: "https://example.com/hkex.csv",
      });
      const approved = toolJson(result) as Record<string, unknown>;
      expect(approved.mic).toBe("XHKG");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // trigger_ingest
  // ──────────────────────────────────────────────────────────────────────────

  describe("trigger_ingest", () => {
    it("returns run summary with counts over seeded data", async () => {
      await connectAndStart();

      // Approve a source pointing to the XNYS sample CSV fixture
      await callTool("approve_source", {
        mic: "XNYS",
        location: `file://${FIXTURES_DIR}/xnys-sample.csv`,
      });

      // Trigger ingest for XNYS
      const result = await callTool("trigger_ingest", { mic: "XNYS" });
      const report = toolJson(result) as Record<string, unknown>;

      expect(report.venue).toBe("XNYS");
      expect(report.run_id).toBeGreaterThan(0);
      expect(report.records_total).toBeGreaterThan(0);
      // XNYS sample CSV lacks FIGI/CUSIP/SEDOL columns, so all records
      // fail profile validation and end up quarantined.
      expect(report.outcome).toBeOneOf(["success", "partial", "quarantined"]);
      expect(report.run_completed_at).toBeDefined();
    });

    it("returns error for unregistered MIC", async () => {
      await connectAndStart();

      const result = await callTool("trigger_ingest", { mic: "UNKNOWN" });
      const data = toolJson(result) as Record<string, unknown>;
      expect(data.error).toContain("No adapter registered");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // review_quarantine
  // ──────────────────────────────────────────────────────────────────────────

  describe("review_quarantine", () => {
    it("lists quarantined records with failure reasons", async () => {
      // Seed an ingest run and quarantine records directly
      const now = new Date().toISOString();
      store.db
        .prepare(
          `INSERT INTO ingest_runs (venue, records_total, outcome, run_started_at, run_completed_at)
           VALUES ('XNYS', 5, 'quarantined', ?, ?)`
        )
        .run(now, now);
      const runId = store.db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number };

      const rawRecord = JSON.stringify({
        venue_symbol: "BAD",
        isin: "",
        instrument_name: "",
        currency: "USD",
        asset_class: "stock",
        mic: "XNYS",
      });

      store.db
        .prepare(
          `INSERT INTO quarantine (ingest_run_id, record_index, raw_record_json, failure_reasons, created_at, status)
           VALUES (?, 0, ?, ?, ?, 'pending')`
        )
        .run(
          runId.id,
          rawRecord,
          JSON.stringify([
            'required field sourced from "isin" is missing or empty',
          ]),
          now
        );

      store.db
        .prepare(
          `INSERT INTO quarantine (ingest_run_id, record_index, raw_record_json, failure_reasons, created_at, status)
           VALUES (?, 1, ?, ?, ?, 'pending')`
        )
        .run(
          runId.id,
          JSON.stringify({
            venue_symbol: "MISSING_NAME",
            isin: "US1234567890",
            instrument_name: "",
            currency: "USD",
            asset_class: "stock",
            mic: "XNYS",
          }),
          JSON.stringify([
            'required field sourced from "instrument_name" is missing or empty',
          ]),
          now
        );

      await connectAndStart();

      const result = await callTool("review_quarantine");
      const data = toolJson(result) as {
        quarantine_records: Array<Record<string, unknown>>;
        total: number;
      };

      expect(data.total).toBe(2);
      expect(data.quarantine_records).toHaveLength(2);

      for (const record of data.quarantine_records) {
        expect(record.status).toBe("pending");
        expect(record.venue).toBe("XNYS");
        expect(record.failure_reasons).toBeDefined();
        expect(Array.isArray(record.failure_reasons)).toBe(true);
        expect(record.raw_record).toBeDefined();
        expect(typeof record.raw_record).toBe("object");
      }
    });

    it("filters by ingest_run_id", async () => {
      const now = new Date().toISOString();
      store.db
        .prepare(
          `INSERT INTO ingest_runs (venue, records_total, outcome, run_started_at, run_completed_at)
           VALUES ('XNYS', 3, 'quarantined', ?, ?)`
        )
        .run(now, now);
      const runId1 = store.db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number };

      store.db
        .prepare(
          `INSERT INTO ingest_runs (venue, records_total, outcome, run_started_at, run_completed_at)
           VALUES ('XNYS', 3, 'quarantined', ?, ?)`
        )
        .run(now, now);
      const runId2 = store.db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number };

      store.db
        .prepare(
          `INSERT INTO quarantine (ingest_run_id, record_index, raw_record_json, failure_reasons, created_at, status)
           VALUES (?, 0, '{}', '["reason1"]', ?, 'pending')`
        )
        .run(runId1.id, now);

      store.db
        .prepare(
          `INSERT INTO quarantine (ingest_run_id, record_index, raw_record_json, failure_reasons, created_at, status)
           VALUES (?, 0, '{}', '["reason2"]', ?, 'pending')`
        )
        .run(runId2.id, now);

      await connectAndStart();

      const result = await callTool("review_quarantine", {
        ingest_run_id: runId1.id,
      });
      const data = toolJson(result) as {
        quarantine_records: Array<Record<string, unknown>>;
        total: number;
      };

      expect(data.total).toBe(1);
      expect(data.quarantine_records[0].ingest_run_id).toBe(runId1.id);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // reprocess_quarantine
  // ──────────────────────────────────────────────────────────────────────────

  describe("reprocess_quarantine", () => {
    it("reprocesses a fixed record so it enters the pool", async () => {
      await connectAndStart();

      // Seed an ingest run
      const now = new Date().toISOString();
      store.db
        .prepare(
          `INSERT INTO ingest_runs (venue, records_total, outcome, run_started_at, run_completed_at)
           VALUES ('XNYS', 2, 'quarantined', ?, ?)`
        )
        .run(now, now);
      const runId = store.db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number };

      // Insert a quarantined record whose raw data is actually valid
      // (the quarantine might have been from a previous profile version)
      // Must include all four identifier schemes that the stock profile requires.
      const validRecord = {
        venue_symbol: "AAPL",
        isin: "US0378331005",
        figi: "BBG000B9XRY4",
        cusip: "037833100",
        sedol: "2046251",
        instrument_name: "Apple Inc.",
        currency: "USD",
        asset_class: "stock",
        mic: "XNYS",
      };

      store.db
        .prepare(
          `INSERT INTO quarantine (ingest_run_id, record_index, raw_record_json, failure_reasons, created_at, status)
           VALUES (?, 0, ?, ?, ?, 'pending')`
        )
        .run(
          runId.id,
          JSON.stringify(validRecord),
          JSON.stringify(["old failure reason — now fixed"]),
          now
        );
      const quarantineId = store.db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number };

      // Reprocess the quarantine record
      const result = await callTool("reprocess_quarantine", {
        quarantine_id: quarantineId.id,
      });
      const data = toolJson(result) as Record<string, unknown>;

      expect(data.status).toBe("reprocessed");
      expect(data.quarantine_id).toBe(quarantineId.id);
      const delta = data.delta as Record<string, unknown>;
      expect(delta.records_added).toBeGreaterThan(0);

      // Verify the quarantine status was updated in the DB
      const updatedRow = store.db
        .prepare("SELECT status FROM quarantine WHERE id = ?")
        .get(quarantineId.id) as { status: string };
      expect(updatedRow.status).toBe("reprocessed");

      // Verify the instrument entered the pool
      const instrument = store.db
        .prepare(
          "SELECT venue_symbol, mic FROM instruments WHERE venue_symbol = ? AND mic = ? AND recorded_to IS NULL"
        )
        .get("AAPL", "XNYS") as
        { venue_symbol: string; mic: string } | undefined;
      expect(instrument).toBeDefined();
      expect(instrument!.venue_symbol).toBe("AAPL");
    });

    it("returns failures when record is still invalid", async () => {
      await connectAndStart();

      const now = new Date().toISOString();
      store.db
        .prepare(
          `INSERT INTO ingest_runs (venue, records_total, outcome, run_started_at, run_completed_at)
           VALUES ('XNYS', 2, 'quarantined', ?, ?)`
        )
        .run(now, now);
      const runId = store.db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number };

      // Record with missing required field (empty instrument_name)
      const invalidRecord = {
        venue_symbol: "BAD",
        isin: "",
        instrument_name: "",
        currency: "USD",
        asset_class: "stock",
        mic: "XNYS",
      };

      store.db
        .prepare(
          `INSERT INTO quarantine (ingest_run_id, record_index, raw_record_json, failure_reasons, created_at, status)
           VALUES (?, 0, ?, ?, ?, 'pending')`
        )
        .run(
          runId.id,
          JSON.stringify(invalidRecord),
          JSON.stringify([
            'required field sourced from "isin" is missing or empty',
          ]),
          now
        );
      const quarantineId = store.db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number };

      const result = await callTool("reprocess_quarantine", {
        quarantine_id: quarantineId.id,
      });
      const data = toolJson(result) as Record<string, unknown>;

      expect(data.status).toBe("still_invalid");
      const failures = data.failures as Array<{
        field: string;
        reason: string;
      }>;
      expect(failures.length).toBeGreaterThan(0);
    });

    it("returns error for non-existent quarantine record", async () => {
      await connectAndStart();

      const result = await callTool("reprocess_quarantine", {
        quarantine_id: 999,
      });
      const data = toolJson(result) as Record<string, unknown>;
      expect(data.error).toContain("not found");
    });

    it("returns error for already-reprocessed record", async () => {
      await connectAndStart();

      const now = new Date().toISOString();
      store.db
        .prepare(
          `INSERT INTO ingest_runs (venue, records_total, outcome, run_started_at, run_completed_at)
           VALUES ('XNYS', 2, 'partial', ?, ?)`
        )
        .run(now, now);
      const runId = store.db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number };

      store.db
        .prepare(
          `INSERT INTO quarantine (ingest_run_id, record_index, raw_record_json, failure_reasons, created_at, status)
           VALUES (?, 0, '{}', '["reason"]', ?, 'reprocessed')`
        )
        .run(runId.id, now);
      const quarantineId = store.db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number };

      const result = await callTool("reprocess_quarantine", {
        quarantine_id: quarantineId.id,
      });
      const data = toolJson(result) as Record<string, unknown>;
      expect(data.error).toContain("already");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // update_alias
  // ──────────────────────────────────────────────────────────────────────────

  describe("update_alias", () => {
    it("creates an alias and lookup_term resolves it", async () => {
      await connectAndStart();

      // Add a new alias
      const updateResult = await callTool("update_alias", {
        term: "boardlot",
        canonical_field: "board_lot",
        layer: "alias",
      });
      const updateData = toolJson(updateResult) as Record<string, unknown>;
      expect(updateData.term).toBe("boardlot");
      expect(updateData.canonical_field).toBe("board_lot");
      expect(updateData.updated_at).toBeDefined();

      // Look up the alias — should resolve
      const lookupResult = await callTool("lookup_term", { term: "boardlot" });
      const lookupData = toolJson(lookupResult) as Record<string, unknown>;
      expect(lookupData.match).toBe("board_lot");
    });

    it("searches dictionary to find the alias after update", async () => {
      await connectAndStart();

      await callTool("update_alias", {
        term: "contractsz",
        canonical_field: "contract_size",
        layer: "alias",
      });

      const searchResult = await callTool("search_dictionary", {
        query: "contractsz",
      });
      const searchData = toolJson(searchResult) as {
        results: Array<Record<string, unknown>>;
        total: number;
      };
      expect(searchData.total).toBeGreaterThanOrEqual(1);
      const aliasEntry = searchData.results.find(
        (r) => r.layer === "alias" && r.match === "contractsz"
      );
      expect(aliasEntry).toBeDefined();
    });

    it("replaces an existing alias with the same term", async () => {
      await connectAndStart();

      // Create initial alias
      await callTool("update_alias", {
        term: "sym",
        canonical_field: "venue_symbol",
        layer: "alias",
      });

      // Replace it
      await callTool("update_alias", {
        term: "sym",
        canonical_field: "isin",
        layer: "alias",
      });

      // Verify the new resolution — "isin" resolves via lineage layer
      const lookupResult = await callTool("lookup_term", { term: "sym" });
      const lookupData = toolJson(lookupResult) as Record<string, unknown>;
      expect(lookupData.match).toBe("isin");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // regenerate_dictionary
  // ──────────────────────────────────────────────────────────────────────────

  describe("regenerate_dictionary", () => {
    it("regenerates the dictionary and reflects changes", async () => {
      await connectAndStart();

      // First, add an alias
      await callTool("update_alias", {
        term: "tickervalue",
        canonical_field: "venue_symbol",
        layer: "alias",
      });

      // Regenerate the dictionary
      const regenResult = await callTool("regenerate_dictionary");
      const regenData = toolJson(regenResult) as Record<string, unknown>;
      expect(regenData.status).toBe("regenerated");

      // The alias should still resolve after regeneration
      const lookupResult = await callTool("lookup_term", {
        term: "tickervalue",
      });
      const lookupData = toolJson(lookupResult) as Record<string, unknown>;
      expect(lookupData.match).toBe("venue_symbol");
    });

    it("can regenerate multiple times safely", async () => {
      await connectAndStart();

      const result1 = await callTool("regenerate_dictionary");
      const data1 = toolJson(result1) as Record<string, unknown>;
      expect(data1.status).toBe("regenerated");

      const result2 = await callTool("regenerate_dictionary");
      const data2 = toolJson(result2) as Record<string, unknown>;
      expect(data2.status).toBe("regenerated");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Tool listing — verify all admin tools are registered
  // ──────────────────────────────────────────────────────────────────────────

  describe("tool registration", () => {
    it("registers all six admin tools", async () => {
      await connectAndStart();

      const toolsResult = await client.listTools();
      const toolNames = toolsResult.tools.map((t) => t.name);

      expect(toolNames).toContain("approve_source");
      expect(toolNames).toContain("trigger_ingest");
      expect(toolNames).toContain("review_quarantine");
      expect(toolNames).toContain("reprocess_quarantine");
      expect(toolNames).toContain("update_alias");
      expect(toolNames).toContain("regenerate_dictionary");
    });
  });
});
