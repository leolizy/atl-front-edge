import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PoolStore } from "../src/db/pool-store.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerChangesOperations } from "../src/mcp/tools/changes-operations.js";

/**
 * Test scaffolding: creates an in-memory store, migrates it, registers changes
 * operations, creates paired transports, and connects a client. Returns the
 * server, client, and store so tests can seed data and call tools.
 *
 * We create the McpServer directly (not via createMcpServer) so the empty-list
 * handlers don't conflict with the McpServer's internal tool-registration
 * wiring.
 */
async function setup() {
  const store = new PoolStore({ dbPath: ":memory:", wal: false });
  store.migrate();

  const server = new McpServer(
    { name: "narwhal-test", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
    }
  );

  // Register only the changes-operations tools for this test module
  registerChangesOperations(server, store.db);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
    }
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { store, server, client };
}

async function teardown(client: Client, server: McpServer, store: PoolStore) {
  try {
    await client.close();
  } catch {
    // already closed
  }
  try {
    await server.close();
  } catch {
    // already closed
  }
  try {
    store.close();
  } catch {
    // already closed
  }
}

/**
 * Call a tool by name via the MCP client and return parsed JSON.
 */
async function callTool(
  client: Client,
  name: string,
  args?: Record<string, unknown>
): Promise<unknown> {
  const result = (await client.callTool({
    name,
    arguments: args ?? {},
  })) as CallToolResult;

  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error(`Tool ${name} returned no text content`);
  }
  return JSON.parse(textContent.text);
}

describe("changes-operations tools", () => {
  let store: PoolStore;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    const s = await setup();
    store = s.store;
    server = s.server;
    client = s.client;
  });

  afterEach(async () => {
    await teardown(client, server, store);
  });

  describe("list_venues", () => {
    it("returns all six venues", async () => {
      const result = (await callTool(client, "list_venues")) as Array<{
        mic: string;
        name: string;
        asset_class: string;
        notes: string;
      }>;

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(6);

      const mics = result.map((v) => v.mic);
      expect(mics).toContain("XNYS");
      expect(mics).toContain("XHKG");
      expect(mics).toContain("XSES");
      expect(mics).toContain("XCME");
      expect(mics).toContain("XHKF");
      expect(mics).toContain("XSIM");

      // Every venue has required fields
      for (const venue of result) {
        expect(venue).toHaveProperty("mic");
        expect(venue).toHaveProperty("name");
        expect(venue).toHaveProperty("asset_class");
        expect(venue).toHaveProperty("notes");
        expect(["stock", "commodity_future"]).toContain(venue.asset_class);
      }
    });
  });

  describe("list_sources", () => {
    it("returns empty when no sources exist", async () => {
      const result = await callTool(client, "list_sources");
      expect(result).toEqual([]);
    });

    it("returns approved sources with approval metadata", async () => {
      store.db
        .prepare(
          `INSERT INTO sources (mic, location, approver, approved_at, terms_note)
           VALUES
             ('XNYS', 'https://data-feed.xnys.example/v1', 'admin@narwhal.io', '2025-01-15T10:00:00Z', 'Standard license'),
             ('XHKG', 'https://data-feed.xhkg.example/v1', 'admin@narwhal.io', '2025-02-01T09:00:00Z', NULL),
             ('XSES', 'https://data-feed.xses.example/v1', 'ops@narwhal.io', '2025-03-10T14:30:00Z', 'Vendor agreement v2')`
        )
        .run();

      const result = (await callTool(client, "list_sources")) as Array<{
        id: number;
        mic: string;
        location: string;
        approver: string;
        approved_at: string;
        terms_note: string | null;
      }>;

      expect(result).toHaveLength(3);

      for (const source of result) {
        expect(source).toHaveProperty("id");
        expect(source).toHaveProperty("mic");
        expect(source).toHaveProperty("location");
        expect(source).toHaveProperty("approver");
        expect(source).toHaveProperty("approved_at");
      }
    });

    it("filters sources by MIC", async () => {
      store.db
        .prepare(
          `INSERT INTO sources (mic, location, approver, approved_at, terms_note)
           VALUES
             ('XNYS', 'https://data-feed.xnys.example/v1', 'admin@narwhal.io', '2025-01-15T10:00:00Z', 'License'),
             ('XHKG', 'https://data-feed.xhkg.example/v1', 'admin@narwhal.io', '2025-02-01T09:00:00Z', NULL)`
        )
        .run();

      const result = (await callTool(client, "list_sources", {
        mic: "XNYS",
      })) as Array<Record<string, unknown>>;
      expect(result).toHaveLength(1);
      expect(result[0].mic).toBe("XNYS");
      expect(result[0].location).toBe("https://data-feed.xnys.example/v1");
    });
  });

  describe("get_ingest_status", () => {
    it("returns empty array when no ingest runs exist", async () => {
      const result = await callTool(client, "get_ingest_status");
      expect(result).toEqual([]);
    });

    it("shows correct last run time and outcome per venue", async () => {
      store.db
        .prepare(
          `INSERT INTO ingest_runs (venue, window_start, window_end, records_total, records_added, records_updated,
            records_delisted, records_quarantined, outcome, run_started_at, run_completed_at)
           VALUES
             ('XNYS', '2025-06-01', '2025-06-01', 100, 5, 10, 2, 0, 'success',
              '2025-06-01T08:00:00Z', '2025-06-01T08:05:00Z'),
             ('XNYS', '2025-06-02', '2025-06-02', 102, 3, 8, 1, 0, 'success',
              '2025-06-02T08:00:00Z', '2025-06-02T08:04:00Z'),
             ('XHKG', '2025-06-02', '2025-06-02', 50, 50, 0, 0, 0, 'partial',
              '2025-06-02T09:00:00Z', '2025-06-02T09:03:00Z')`
        )
        .run();

      const result = (await callTool(client, "get_ingest_status")) as Array<
        Record<string, unknown>
      >;

      expect(result).toHaveLength(2); // XNYS + XHKG

      // Sort by venue for deterministic assertion
      result.sort((a, b) => String(a.venue).localeCompare(String(b.venue)));

      // XHKG — last run was partial
      const xhkg = result.find((r) => r.venue === "XHKG");
      expect(xhkg).toBeDefined();
      expect(xhkg!.last_outcome).toBe("partial");
      expect(xhkg!.last_records_total).toBe(50);
      expect(xhkg!.last_records_added).toBe(50);
      expect(xhkg!.last_success_at).toBeNull(); // never succeeded
      expect(xhkg!.freshness).toBe("never ingested");

      // XNYS — last run was success
      const xnys = result.find((r) => r.venue === "XNYS");
      expect(xnys).toBeDefined();
      expect(xnys!.last_outcome).toBe("success");
      expect(xnys!.last_records_total).toBe(102);
      expect(xnys!.last_records_added).toBe(3);
      expect(xnys!.total_runs).toBe(2);
      expect(xnys!.last_success_at).toBe("2025-06-02T08:04:00Z");
      expect(xnys!.freshness).toBeDefined();
    });

    it("filters ingest status by venue", async () => {
      store.db
        .prepare(
          `INSERT INTO ingest_runs (venue, window_start, window_end, records_total, records_added, records_updated,
            records_delisted, records_quarantined, outcome, run_started_at, run_completed_at)
           VALUES
             ('XNYS', '2025-06-01', '2025-06-01', 100, 5, 10, 2, 0, 'success',
              '2025-06-01T08:00:00Z', '2025-06-01T08:05:00Z'),
             ('XHKG', '2025-06-01', '2025-06-01', 50, 50, 0, 0, 0, 'success',
              '2025-06-01T09:00:00Z', '2025-06-01T09:03:00Z')`
        )
        .run();

      const result = (await callTool(client, "get_ingest_status", {
        venue: "XNYS",
      })) as Array<Record<string, unknown>>;
      expect(result).toHaveLength(1);
      expect(result[0].venue).toBe("XNYS");
    });
  });

  describe("list_changes", () => {
    function seedChangeData() {
      // Insert sources (needed for FK on instruments)
      store.db
        .prepare(
          `INSERT INTO sources (mic, location, approver, approved_at, terms_note)
           VALUES ('XNYS', 'https://feed.example/xnys', 'admin@narwhal.io', '2025-01-01T00:00:00Z', 'N/A')`
        )
        .run();

      // Insert two ingest runs
      store.db
        .prepare(
          `INSERT INTO ingest_runs (venue, records_total, records_added, records_updated, records_delisted,
            records_quarantined, outcome, run_started_at, run_completed_at)
           VALUES
             ('XNYS', 3, 2, 1, 0, 0, 'success', '2025-06-01T08:00:00Z', '2025-06-01T08:05:00Z'),
             ('XHKG', 2, 1, 0, 0, 1, 'partial', '2025-06-02T09:00:00Z', '2025-06-02T09:03:00Z')`
        )
        .run();

      // Insert instruments (bitemporal: close old versions so recorded_to NULL is unique)
      store.db
        .prepare(
          `INSERT INTO instruments (id, mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
            effective_from, recorded_from, recorded_to, source_id, ingest_run_id)
           VALUES
             (1, 'XNYS', 'AAPL', 'stock', 'USD', '{"productType":"Equity","identifier":"AAPL"}', 'hash_aapl_v1',
              '2025-06-01', '2025-06-01T08:01:00Z', '2025-06-01T08:02:00Z', 1, 1),
             (2, 'XNYS', 'MSFT', 'stock', 'USD', '{"productType":"Equity","identifier":"MSFT"}', 'hash_msft_v1',
              '2025-06-01', '2025-06-01T08:01:00Z', NULL, 1, 1),
             (3, 'XNYS', 'AAPL', 'stock', 'USD', '{"productType":"Equity","identifier":"AAPL","updated":true}',
              'hash_aapl_v2', '2025-06-02', '2025-06-01T08:02:00Z', NULL, 1, 1),
             (4, 'XHKG', '0700', 'stock', 'HKD', '{"productType":"Equity","identifier":"00700"}', 'hash_0700_v1',
              '2025-06-02', '2025-06-02T09:01:00Z', NULL, 1, 2)`
        )
        .run();

      // Insert changes
      store.db
        .prepare(
          `INSERT INTO changes (instrument_id, ingest_run_id, change_type, before_hash, after_hash, changed_at)
           VALUES
             (1, 1, 'add', NULL, 'hash_aapl_v1', '2025-06-01T08:01:00Z'),
             (2, 1, 'add', NULL, 'hash_msft_v1', '2025-06-01T08:01:00Z'),
             (3, 1, 'update', 'hash_aapl_v1', 'hash_aapl_v2', '2025-06-01T08:02:00Z'),
             (4, 2, 'add', NULL, 'hash_0700_v1', '2025-06-02T09:01:00Z')`
        )
        .run();
    }

    it("lists all changes", async () => {
      seedChangeData();

      const result = (await callTool(client, "list_changes")) as {
        changes: Array<Record<string, unknown>>;
        total: number;
      };

      expect(result.total).toBe(4);
      expect(result.changes).toHaveLength(4);
    });

    it("filters by venue", async () => {
      seedChangeData();

      const result = (await callTool(client, "list_changes", {
        venue: "XHKG",
      })) as {
        changes: Array<Record<string, unknown>>;
        total: number;
      };

      expect(result.total).toBe(1);
      expect(result.changes[0].venue).toBe("XHKG");
      expect(result.changes[0].change_type).toBe("add");
    });

    it("filters by date range", async () => {
      seedChangeData();

      const result = (await callTool(client, "list_changes", {
        date_from: "2025-06-02T00:00:00Z",
        date_to: "2025-06-02T23:59:59Z",
      })) as { changes: Array<Record<string, unknown>>; total: number };

      expect(result.total).toBe(1);
      expect(result.changes[0].change_type).toBe("add");
      expect(result.changes[0].venue).toBe("XHKG");
    });

    it("filters by change_type", async () => {
      seedChangeData();

      const result = (await callTool(client, "list_changes", {
        change_type: "update",
      })) as {
        changes: Array<Record<string, unknown>>;
        total: number;
      };

      expect(result.total).toBe(1);
      expect(result.changes[0].change_type).toBe("update");
    });

    it("supports pagination with limit and offset", async () => {
      seedChangeData();

      const page1 = (await callTool(client, "list_changes", {
        limit: 2,
        offset: 0,
      })) as {
        changes: Array<Record<string, unknown>>;
        total: number;
      };

      expect(page1.total).toBe(4);
      expect(page1.changes).toHaveLength(2);

      const page2 = (await callTool(client, "list_changes", {
        limit: 2,
        offset: 2,
      })) as {
        changes: Array<Record<string, unknown>>;
        total: number;
      };

      expect(page2.changes).toHaveLength(2);

      // No overlap between pages
      const page1Ids = page1.changes.map((c) => c.id);
      const page2Ids = page2.changes.map((c) => c.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });

    it("returns changes with instrument identity, change type, and before/after hashes", async () => {
      seedChangeData();

      const result = (await callTool(client, "list_changes")) as {
        changes: Array<Record<string, unknown>>;
        total: number;
      };

      const updateChange = result.changes.find(
        (c) => c.change_type === "update"
      );
      expect(updateChange).toBeDefined();
      expect(updateChange!.before_hash).toBe("hash_aapl_v1");
      expect(updateChange!.after_hash).toBe("hash_aapl_v2");
      expect(updateChange!.mic).toBe("XNYS");
      expect(updateChange!.venue_symbol).toBe("AAPL");
      expect(updateChange!.ingest_run_id).toBe(1);
      expect(updateChange!.changed_at).toBeDefined();
    });
  });

  describe("get_change", () => {
    function seedChangeDetailData() {
      store.db
        .prepare(
          `INSERT INTO sources (mic, location, approver, approved_at, terms_note)
           VALUES ('XNYS', 'https://feed.example/xnys', 'admin@narwhal.io', '2025-01-01T00:00:00Z', 'N/A')`
        )
        .run();

      store.db
        .prepare(
          `INSERT INTO ingest_runs (id, venue, records_total, records_added, records_updated, records_delisted,
            records_quarantined, outcome, run_started_at, run_completed_at)
           VALUES (1, 'XNYS', 100, 5, 10, 2, 0, 'success', '2025-06-01T08:00:00Z', '2025-06-01T08:05:00Z')`
        )
        .run();

      // Insert original version (closed: superseded by the update)
      store.db
        .prepare(
          `INSERT INTO instruments (id, mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
            effective_from, recorded_from, recorded_to, source_id, ingest_run_id)
           VALUES (1, 'XNYS', 'AAPL', 'stock', 'USD',
            '{"productType":"Equity","identifier":"AAPL","name":"Apple Inc"}', 'hash_aapl_v1',
            '2025-06-01', '2025-06-01T08:01:00Z', '2025-06-02T08:01:00Z', 1, 1)`
        )
        .run();

      // Insert updated version (current: recorded_to is NULL)
      store.db
        .prepare(
          `INSERT INTO instruments (id, mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
            effective_from, recorded_from, recorded_to, source_id, ingest_run_id)
           VALUES (2, 'XNYS', 'AAPL', 'stock', 'USD',
            '{"productType":"Equity","identifier":"AAPL","name":"Apple Inc","marketCap":"3T"}', 'hash_aapl_v2',
            '2025-06-02', '2025-06-02T08:01:00Z', NULL, 1, 1)`
        )
        .run();

      // Insert the change
      store.db
        .prepare(
          `INSERT INTO changes (id, instrument_id, ingest_run_id, change_type, before_hash, after_hash, changed_at)
           VALUES (1, 1, 1, 'update', 'hash_aapl_v1', 'hash_aapl_v2', '2025-06-02T08:01:00Z')`
        )
        .run();
    }

    it("returns full change detail with before/after CDM snapshots", async () => {
      seedChangeDetailData();

      const result = (await callTool(client, "get_change", {
        change_id: 1,
      })) as Record<string, unknown>;

      expect(result.id).toBe(1);
      expect(result.change_type).toBe("update");
      expect(result.before_hash).toBe("hash_aapl_v1");
      expect(result.after_hash).toBe("hash_aapl_v2");
      expect(result.venue).toBe("XNYS");
      expect(result.mic).toBe("XNYS");
      expect(result.venue_symbol).toBe("AAPL");
      expect(result.asset_class).toBe("stock");
      expect(result.changed_at).toBeDefined();

      // Check CDM snapshots
      expect(result.before_cdm_json).toBeDefined();
      const beforeCdm = result.before_cdm_json as Record<string, unknown>;
      expect(beforeCdm.productType).toBe("Equity");
      expect(beforeCdm.identifier).toBe("AAPL");

      expect(result.after_cdm_json).toBeDefined();
      const afterCdm = result.after_cdm_json as Record<string, unknown>;
      expect(afterCdm.productType).toBe("Equity");
      expect(afterCdm.marketCap).toBe("3T");

      // Current CDM is the instrument referenced by the change (the version being updated from)
      expect(result.current_cdm_json).toBeDefined();
      const currentCdm = result.current_cdm_json as Record<string, unknown>;
      expect(currentCdm.productType).toBe("Equity");
      expect(currentCdm.name).toBe("Apple Inc");
    });

    it("returns error for non-existent change_id", async () => {
      const result = (await callTool(client, "get_change", {
        change_id: 9999,
      })) as Record<string, unknown>;
      expect(result.error).toBeDefined();
      expect(result.error).toContain("9999");
    });

    it("handles 'add' change_type where before_hash is null", async () => {
      // Insert a fresh add scenario
      store.db
        .prepare(
          `INSERT INTO sources (mic, location, approver, approved_at)
           VALUES ('XNYS', 'https://feed.example/xnys', 'admin@narwhal.io', '2025-01-01T00:00:00Z')`
        )
        .run();

      store.db
        .prepare(
          `INSERT INTO ingest_runs (id, venue, records_total, records_added, records_updated, records_delisted,
            records_quarantined, outcome, run_started_at, run_completed_at)
           VALUES (1, 'XNYS', 1, 1, 0, 0, 0, 'success', '2025-06-01T08:00:00Z', '2025-06-01T08:05:00Z')`
        )
        .run();

      store.db
        .prepare(
          `INSERT INTO instruments (id, mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
            effective_from, recorded_from, source_id, ingest_run_id)
           VALUES (1, 'XNYS', 'TSLA', 'stock', 'USD',
            '{"productType":"Equity","identifier":"TSLA"}', 'hash_tsla_v1',
            '2025-06-01', '2025-06-01T08:01:00Z', 1, 1)`
        )
        .run();

      store.db
        .prepare(
          `INSERT INTO changes (id, instrument_id, ingest_run_id, change_type, before_hash, after_hash, changed_at)
           VALUES (1, 1, 1, 'add', NULL, 'hash_tsla_v1', '2025-06-01T08:01:00Z')`
        )
        .run();

      const result = (await callTool(client, "get_change", {
        change_id: 1,
      })) as Record<string, unknown>;

      expect(result.change_type).toBe("add");
      expect(result.before_hash).toBeNull();
      expect(result.before_cdm_json).toBeNull();
      expect(result.after_cdm_json).toBeDefined();
    });
  });

  describe("tool discovery", () => {
    it("all five tools are listed", async () => {
      const tools = await client.listTools();
      expect(tools.tools).toBeDefined();
      const names = tools.tools.map((t) => t.name);

      expect(names).toContain("list_changes");
      expect(names).toContain("get_change");
      expect(names).toContain("get_ingest_status");
      expect(names).toContain("list_venues");
      expect(names).toContain("list_sources");
    });
  });
});
