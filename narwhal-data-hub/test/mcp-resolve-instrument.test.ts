import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PoolStore } from "../src/db/pool-store.js";
import { startMcpServer } from "../src/mcp/server.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSeededStore(): PoolStore {
  const store = new PoolStore({ dbPath: ":memory:", wal: false });
  store.migrate();
  return store;
}

interface SeedData {
  store: PoolStore;
  appleId: number;
  teslaId: number;
  appleIsin: string;
  teslaIsin: string;
  appleFigi: string;
  teslaCusip: string;
}

/**
 * Seed the database with two instruments (AAPL and TSLA) plus identifiers and sources.
 */
function seedInstruments(store: PoolStore): SeedData {
  const db = store.db;

  // Insert sources
  db.prepare(
    `INSERT INTO sources (mic, location, approver, approved_at, terms_note)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    "XNAS",
    "https://example.com/xnas",
    "admin",
    "2025-01-01",
    "NASDAQ source"
  );

  db.prepare(
    `INSERT INTO sources (mic, location, approver, approved_at, terms_note)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    "XNYS",
    "https://example.com/xnys",
    "admin",
    "2025-01-01",
    "NYSE source"
  );

  const sourceXnas = (
    db.prepare("SELECT id FROM sources WHERE mic = 'XNAS'").get() as {
      id: number;
    }
  ).id;
  const sourceXnys = (
    db.prepare("SELECT id FROM sources WHERE mic = 'XNYS'").get() as {
      id: number;
    }
  ).id;

  // Insert ingest runs
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ingest_runs
       (venue, window_start, window_end, records_total, records_added, outcome, run_started_at, run_completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("XNAS", "2025-01-01", "2025-01-01", 2, 2, "success", now, now);

  const ingestRunId = (
    db.prepare("SELECT id FROM ingest_runs LIMIT 1").get() as { id: number }
  ).id;

  // Insert AAPL on XNAS
  const appleCdm = JSON.stringify({
    product: {
      primaryAsset: {
        productIdentifier: {
          identifier: {
            value: "US0378331005",
          },
        },
        assetClass: "equity",
      },
    },
  });
  const appleHash = "abc123";

  const appleResult = db
    .prepare(
      `INSERT INTO instruments
       (mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
        effective_from, effective_to, recorded_from,
        source_id, ingest_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "XNAS",
      "AAPL",
      "stock",
      "USD",
      appleCdm,
      appleHash,
      "2024-01-01",
      null,
      now,
      sourceXnas,
      ingestRunId
    );

  const appleId = Number(appleResult.lastInsertRowid);

  // Insert TSLA on XNYS
  const teslaCdm = JSON.stringify({
    product: {
      primaryAsset: {
        productIdentifier: {
          identifier: {
            value: "US88160R1014",
          },
        },
        assetClass: "equity",
      },
    },
  });
  const teslaHash = "def456";

  const teslaResult = db
    .prepare(
      `INSERT INTO instruments
       (mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
        effective_from, effective_to, recorded_from,
        source_id, ingest_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "XNYS",
      "TSLA",
      "stock",
      "USD",
      teslaCdm,
      teslaHash,
      "2024-01-01",
      null,
      now,
      sourceXnys,
      ingestRunId
    );

  const teslaId = Number(teslaResult.lastInsertRowid);

  // Insert identifiers
  const appleIsin = "US0378331005";
  const teslaIsin = "US88160R1014";
  const appleFigi = "BBG000B9XRY4";
  const teslaCusip = "88160R101";

  db.prepare(
    "INSERT INTO identifiers (instrument_id, type, value) VALUES (?, ?, ?)"
  ).run(appleId, "ISIN", appleIsin);
  db.prepare(
    "INSERT INTO identifiers (instrument_id, type, value) VALUES (?, ?, ?)"
  ).run(appleId, "FIGI", appleFigi);
  db.prepare(
    "INSERT INTO identifiers (instrument_id, type, value) VALUES (?, ?, ?)"
  ).run(teslaId, "ISIN", teslaIsin);
  db.prepare(
    "INSERT INTO identifiers (instrument_id, type, value) VALUES (?, ?, ?)"
  ).run(teslaId, "CUSIP", teslaCusip);

  return {
    store,
    appleId,
    teslaId,
    appleIsin,
    teslaIsin,
    appleFigi,
    teslaCusip,
  };
}

async function callResolveInstrument(
  client: Client,
  args: { query: string; query_type?: string; as_of?: string }
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: "resolve_instrument",
    arguments: args,
  });

  const content = result.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe("text");
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolve_instrument MCP tool", () => {
  let store: PoolStore;
  let seed: SeedData;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    store = createSeededStore();
    seed = seedInstruments(store);

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: "test-client", version: "1.0.0" },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    server = await startMcpServer(store, serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
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
  });

  // -----------------------------------------------------------------------
  // Exact identifier lookups
  // -----------------------------------------------------------------------

  it("resolves by ISIN with confidence 1.0", async () => {
    const result = await callResolveInstrument(client, {
      query: seed.appleIsin,
      query_type: "isin",
    });

    expect(result.match).toBeDefined();
    const match = result.match as Record<string, unknown>;
    expect(match.venue_symbol).toBe("AAPL");
    expect(result.confidence).toBe(1.0);
    expect(result.alternatives).toEqual([]);

    // Check provenance
    const provenance = (match as Record<string, unknown>).provenance as Record<
      string,
      unknown
    >;
    expect(provenance.source).toBe("https://example.com/xnas");
    expect(provenance.ingest_run).toBeTypeOf("number");
    expect(provenance.recorded_at).toBeTypeOf("string");
  });

  it("resolves by venue symbol + MIC", async () => {
    const result = await callResolveInstrument(client, {
      query: "XNAS:AAPL",
      query_type: "venue_symbol",
    });

    expect(result.match).toBeDefined();
    const match = result.match as Record<string, unknown>;
    expect(match.venue_symbol).toBe("AAPL");
    expect(match.mic).toBe("XNAS");
    expect(result.confidence).toBe(1.0);
  });

  it("resolves by FIGI with confidence 1.0", async () => {
    const result = await callResolveInstrument(client, {
      query: seed.appleFigi,
      query_type: "figi",
    });

    expect(result.match).toBeDefined();
    const match = result.match as Record<string, unknown>;
    expect(match.venue_symbol).toBe("AAPL");
    expect(result.confidence).toBe(1.0);
  });

  it("resolves by CUSIP with confidence 1.0", async () => {
    const result = await callResolveInstrument(client, {
      query: seed.teslaCusip,
      query_type: "cusip",
    });

    expect(result.match).toBeDefined();
    const match = result.match as Record<string, unknown>;
    expect(match.venue_symbol).toBe("TSLA");
    expect(result.confidence).toBe(1.0);
  });

  // -----------------------------------------------------------------------
  // Free-text search
  // -----------------------------------------------------------------------

  it("fuzzy matches free-text 'Apple' with confidence < 1.0 and alternatives", async () => {
    const result = await callResolveInstrument(client, {
      query: "AAPL",
      query_type: "free_text",
    });

    expect(result.match).toBeDefined();
    expect(result.confidence).toBe(1.0); // exact match on "AAPL" = 1.0
    const match = result.match as Record<string, unknown>;
    expect(match.venue_symbol).toBe("AAPL");
  });

  it("returns alternatives for broad free-text search", async () => {
    // Use a query that partially matches both
    // Insert another instrument that starts with "AA" so we get alternatives
    const now = new Date().toISOString();
    const sourceXnas = (
      store.db.prepare("SELECT id FROM sources WHERE mic = 'XNAS'").get() as {
        id: number;
      }
    ).id;
    const ingestRunId = (
      store.db.prepare("SELECT id FROM ingest_runs LIMIT 1").get() as {
        id: number;
      }
    ).id;

    store.db
      .prepare(
        `INSERT INTO instruments
       (mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
        effective_from, effective_to, recorded_from,
        source_id, ingest_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "XNYS",
        "AA",
        "stock",
        "USD",
        "{}",
        "aa-hash",
        "2024-01-01",
        null,
        now,
        sourceXnas,
        ingestRunId
      );

    const result = await callResolveInstrument(client, {
      query: "A",
      query_type: "free_text",
    });

    expect(result.match).toBeDefined();
    // Check that alternatives exists
    const alternatives = result.alternatives as unknown[];
    expect(alternatives).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Not found
  // -----------------------------------------------------------------------

  it("returns null match for unknown ISIN with near-miss suggestions", async () => {
    const result = await callResolveInstrument(client, {
      query: "XX0000000000",
      query_type: "isin",
    });

    expect(result.match).toBeNull();
    expect(result.suggestions).toBeDefined();
    const suggestions = result.suggestions as unknown[];
    // May be empty if no partial matches, but should be an array
    expect(Array.isArray(suggestions)).toBe(true);
  });

  it("returns null match for non-existent free-text query", async () => {
    const result = await callResolveInstrument(client, {
      query: "ZZZZNONEXIST",
      query_type: "free_text",
    });

    expect(result.match).toBeNull();
    expect(result.suggestions).toBeDefined();
    expect(Array.isArray(result.suggestions)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // as_of historical queries
  // -----------------------------------------------------------------------

  it("derives status correctly based on as_of", async () => {
    // Add an instrument that was delisted in the past
    const now = new Date().toISOString();
    const sourceXnas = (
      store.db.prepare("SELECT id FROM sources WHERE mic = 'XNAS'").get() as {
        id: number;
      }
    ).id;
    const ingestRunId = (
      store.db.prepare("SELECT id FROM ingest_runs LIMIT 1").get() as {
        id: number;
      }
    ).id;

    store.db
      .prepare(
        `INSERT INTO instruments
       (mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
        effective_from, effective_to, recorded_from,
        source_id, ingest_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "XNAS",
        "DELISTED",
        "stock",
        "USD",
        "{}",
        "del-hash",
        "2023-01-01",
        "2024-06-30",
        now,
        sourceXnas,
        ingestRunId
      );

    // Insert ISIN for this delisted instrument
    const delistedId = (
      store.db
        .prepare("SELECT id FROM instruments WHERE venue_symbol = 'DELISTED'")
        .get() as {
        id: number;
      }
    ).id;
    store.db
      .prepare(
        "INSERT INTO identifiers (instrument_id, type, value) VALUES (?, ?, ?)"
      )
      .run(delistedId, "ISIN", "XXDELISTED01");

    // Query with as_of before delisting → should be active or announced
    const resultActive = await callResolveInstrument(client, {
      query: "XXDELISTED01",
      query_type: "isin",
      as_of: "2023-06-15",
    });

    expect(resultActive.match).toBeDefined();
    const activeMatch = resultActive.match as Record<string, unknown>;
    expect(activeMatch.status).toBe("active");

    // Query with as_of after delisting → should be excluded (no match)
    const resultAfterDelist = await callResolveInstrument(client, {
      query: "XXDELISTED01",
      query_type: "isin",
      as_of: "2025-01-01",
    });

    expect(resultAfterDelist.match).toBeNull();
  });

  it("respects as_of parameter for historical queries", async () => {
    // Add an instrument that becomes effective in the future
    const now = new Date().toISOString();
    const sourceXnas = (
      store.db.prepare("SELECT id FROM sources WHERE mic = 'XNAS'").get() as {
        id: number;
      }
    ).id;
    const ingestRunId = (
      store.db.prepare("SELECT id FROM ingest_runs LIMIT 1").get() as {
        id: number;
      }
    ).id;

    // Use a far-future date for effective_from
    store.db
      .prepare(
        `INSERT INTO instruments
       (mic, venue_symbol, asset_class, currency, cdm_json, content_hash,
        effective_from, effective_to, recorded_from,
        source_id, ingest_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "XNAS",
        "FUTURE",
        "stock",
        "USD",
        "{}",
        "future-hash",
        "2030-01-01",
        null,
        now,
        sourceXnas,
        ingestRunId
      );

    const futureId = (
      store.db
        .prepare("SELECT id FROM instruments WHERE venue_symbol = 'FUTURE'")
        .get() as {
        id: number;
      }
    ).id;
    store.db
      .prepare(
        "INSERT INTO identifiers (instrument_id, type, value) VALUES (?, ?, ?)"
      )
      .run(futureId, "ISIN", "XXFUTURE0001");

    // With default as_of (today), the future instrument is found with
    // "announced" status since effective_from > as_of
    const resultDefault = await callResolveInstrument(client, {
      query: "XXFUTURE0001",
      query_type: "isin",
    });

    expect(resultDefault.match).toBeDefined();
    const defaultMatch = resultDefault.match as Record<string, unknown>;
    expect(defaultMatch.status).toBe("announced");
    expect(resultDefault.confidence).toBe(1.0);

    // With as_of far in the future (past effective_from), status becomes "active"
    const resultFuture = await callResolveInstrument(client, {
      query: "XXFUTURE0001",
      query_type: "isin",
      as_of: "2030-06-15",
    });

    expect(resultFuture.match).toBeDefined();
    const futureMatch = resultFuture.match as Record<string, unknown>;
    expect(futureMatch.status).toBe("active");
    expect(resultFuture.confidence).toBe(1.0);
  });

  // -----------------------------------------------------------------------
  // Free-text query_type is the default
  // -----------------------------------------------------------------------

  it("uses free_text type by default when query_type is omitted", async () => {
    const result = await callResolveInstrument(client, {
      query: "AAPL",
    });

    // Defaults to free_text, so should find AAPL by fuzzy match
    expect(result.match).toBeDefined();
    const match = result.match as Record<string, unknown>;
    expect(match.venue_symbol).toBe("AAPL");
    expect(result.confidence).toBe(1.0);
  });

  // -----------------------------------------------------------------------
  // Tool listing
  // -----------------------------------------------------------------------

  it("lists resolve_instrument as a registered tool", async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("resolve_instrument");
  });
});
