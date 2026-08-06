import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PoolStore } from "../src/db/pool-store.js";
import { createMcpServer, startMcpServer } from "../src/mcp/server.js";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function createSeededStore(): PoolStore {
  const store = new PoolStore({ dbPath: ":memory:", wal: false });
  store.migrate();

  // Insert a source
  store.db.exec(`
    INSERT INTO sources (id, mic, location, approver, approved_at) VALUES
      (1, 'XNYS', 'https://example.com/xnys', 'alice', '2025-01-01T00:00:00Z'),
      (2, 'XHKG', 'https://example.com/xhkg', 'bob',   '2025-01-01T00:00:00Z');
  `);

  // Insert ingest runs
  store.db.exec(`
    INSERT INTO ingest_runs (id, venue, window_start, window_end, file_hash, records_total, outcome, run_started_at, run_completed_at) VALUES
      (1, 'XNYS', '2025-01-01', '2025-01-01', 'abc123', 10, 'success', '2025-01-01T12:00:00Z', '2025-01-01T12:05:00Z'),
      (2, 'XHKG', '2025-01-01', '2025-01-01', 'def456',  5, 'success', '2025-01-01T12:00:00Z', '2025-01-01T12:03:00Z');
  `);

  // Insert instruments with various effective dates for testing status derivation
  // todayStr will be computed at test time, so we use explicit dates
  // STATUS when as_of = '2025-06-15':
  //   AAPL: effective_from 2025-01-01 → active (effective_from <= as_of, effective_to NULL)
  //   MSFT: effective_from 2026-08-15 → announced (effective_from > as_of)
  //   GOOGL: effective_from 2024-01-01, effective_to 2025-12-31 → delisted (effective_to <= as_of)
  //   TSLA: effective_from 2025-06-01 → active
  //   BABA: effective_from 2025-03-01 (XHKG) → active
  //   NVDA: effective_from 2025-04-01, effective_to 2025-05-31 → delisted (with as_of=2025-06-15)
  //   META: effective_from 2025-07-01 → announced (with as_of=2025-06-15)

  store.db.exec(`
    INSERT INTO instruments (id, mic, venue_symbol, asset_class, currency, cdm_json, content_hash, effective_from, effective_to, recorded_from, source_id, ingest_run_id) VALUES
      (1, 'XNYS', 'AAPL',  'stock', 'USD', '{"isin":"US0378331005","name":"Apple Inc.","_lineage":{"isin":"col_ISIN"}}',      'h1', '2025-01-01', NULL,         '2025-01-01T12:00:00Z', 1, 1),
      (2, 'XNYS', 'MSFT',  'stock', 'USD', '{"isin":"US5949181045","name":"Microsoft Corp."}',                                 'h2', '2026-08-15', NULL,         '2025-06-01T12:00:00Z', 1, 1),
      (3, 'XNYS', 'GOOGL', 'stock', 'USD', '{"isin":"US02079K3059","name":"Alphabet Inc."}',                                  'h3', '2024-01-01', '2025-12-31', '2025-01-01T12:00:00Z', 1, 1),
      (4, 'XNYS', 'TSLA',  'stock', 'USD', '{"isin":"US88160R1014","name":"Tesla Inc."}',                                     'h4', '2025-06-01', NULL,         '2025-06-01T12:00:00Z', 1, 1),
      (5, 'XHKG', 'BABA',  'stock', 'HKD', '{"isin":"US01609W1027","name":"Alibaba Group"}',                                  'h5', '2025-03-01', NULL,         '2025-03-01T12:00:00Z', 2, 2),
      (6, 'XNYS', 'NVDA',  'stock', 'USD', '{"isin":"US67066G1040","name":"NVIDIA Corp.","_lineage":{"isin":"col_ISIN_V2"}}', 'h6', '2025-04-01', '2025-05-31', '2025-04-01T12:00:00Z', 1, 1),
      (7, 'XNYS', 'META',  'stock', 'USD', '{"isin":"US30303M1027","name":"Meta Platforms"}',                                  'h7', '2025-07-01', NULL,         '2025-06-15T12:00:00Z', 1, 1);
  `);

  return store;
}

// A fixed as_of date for deterministic testing
const AS_OF = "2025-06-15";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("search_instruments", () => {
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
      /* ok */
    }
    try {
      store.close();
    } catch {
      /* ok */
    }
  });

  async function connect() {
    const server = await startMcpServer(store, serverTransport);
    await client.connect(clientTransport);
    return server;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const textContent = result.content?.find(
      (c: { type: string }) => c.type === "text"
    ) as { type: "text"; text: string } | undefined;
    return textContent ? JSON.parse(textContent.text) : null;
  }

  it("searches all instruments when no filters given", async () => {
    const server = await connect();

    const data = await callTool("search_instruments", { as_of: AS_OF });

    expect(data.total).toBe(7);
    expect(data.results).toHaveLength(7);

    await client.close();
    await server.close();
  });

  it("filters by MIC", async () => {
    const server = await connect();

    const data = await callTool("search_instruments", {
      mic: "XHKG",
      as_of: AS_OF,
    });

    expect(data.total).toBe(1);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].venue_symbol).toBe("BABA");
    expect(data.results[0].mic).toBe("XHKG");

    await client.close();
    await server.close();
  });

  it("filters by asset_class", async () => {
    const server = await connect();

    const data = await callTool("search_instruments", {
      asset_class: "stock",
      as_of: AS_OF,
    });

    // All 7 are stocks
    expect(data.total).toBe(7);

    await client.close();
    await server.close();
  });

  it("filters by currency", async () => {
    const server = await connect();

    const data = await callTool("search_instruments", {
      currency: "HKD",
      as_of: AS_OF,
    });

    expect(data.total).toBe(1);
    expect(data.results[0].currency).toBe("HKD");
    expect(data.results[0].venue_symbol).toBe("BABA");

    await client.close();
    await server.close();
  });

  it("filters by symbol_pattern", async () => {
    const server = await connect();

    const data = await callTool("search_instruments", {
      symbol_pattern: "A%",
      as_of: AS_OF,
    });

    const symbols = data.results.map(
      (r: { venue_symbol: string }) => r.venue_symbol
    );
    expect(symbols).toContain("AAPL");
    expect(symbols).not.toContain("MSFT");

    await client.close();
    await server.close();
  });

  it("filters by status=active", async () => {
    const server = await connect();

    // at AS_OF=2025-06-15, active: AAPL, GOOGL (delisted 2025-12-31 but still active now), TSLA, BABA
    const data = await callTool("search_instruments", {
      status: "active",
      as_of: AS_OF,
    });

    expect(data.total).toBe(4);
    const symbols = data.results.map(
      (r: { venue_symbol: string }) => r.venue_symbol
    );
    expect(symbols.sort()).toEqual(["AAPL", "BABA", "GOOGL", "TSLA"]);

    await client.close();
    await server.close();
  });

  it("filters by status=announced", async () => {
    const server = await connect();

    // at AS_OF=2025-06-15, announced: MSFT (effective_from 2026-08-15 > as_of), META (effective_from 2025-07-01 > as_of)
    const data = await callTool("search_instruments", {
      status: "announced",
      as_of: AS_OF,
    });

    expect(data.total).toBe(2);
    const symbols = data.results.map(
      (r: { venue_symbol: string }) => r.venue_symbol
    );
    expect(symbols.sort()).toEqual(["META", "MSFT"]);

    await client.close();
    await server.close();
  });

  it("filters by status=delisted", async () => {
    const server = await connect();

    // at AS_OF=2025-06-15, delisted: GOOGL (effective_to 2025-12-31 ... wait, 2025-12-31 > 2025-06-15, so GOOGL is ACTIVE at that point)
    // Wait, GOOGL effective_to 2025-12-31 means it's active until end of 2025.
    // NVDA effective_to 2025-05-31 at as_of 2025-06-15 → delisted!
    const data = await callTool("search_instruments", {
      status: "delisted",
      as_of: AS_OF,
    });

    expect(data.total).toBe(1);
    expect(data.results[0].venue_symbol).toBe("NVDA");

    await client.close();
    await server.close();
  });

  it("derives status correctly for future-effective records as announced", async () => {
    const server = await connect();

    // MSFT has effective_from=2026-08-15, so with as_of=2025-06-15 it should be "announced"
    const data = await callTool("search_instruments", {
      mic: "XNYS",
      as_of: AS_OF,
    });

    const msft = data.results.find(
      (r: { venue_symbol: string }) => r.venue_symbol === "MSFT"
    );
    expect(msft).toBeDefined();
    expect(msft.status).toBe("announced");
    expect(msft.effective_from).toBe("2026-08-15");

    const aapl = data.results.find(
      (r: { venue_symbol: string }) => r.venue_symbol === "AAPL"
    );
    expect(aapl).toBeDefined();
    expect(aapl.status).toBe("active");

    await client.close();
    await server.close();
  });

  it("supports pagination (limit + offset)", async () => {
    const server = await connect();

    const page1 = await callTool("search_instruments", {
      as_of: AS_OF,
      limit: 3,
      offset: 0,
    });
    expect(page1.results).toHaveLength(3);
    expect(page1.total).toBe(7);

    const page2 = await callTool("search_instruments", {
      as_of: AS_OF,
      limit: 3,
      offset: 3,
    });
    expect(page2.results).toHaveLength(3);

    const page3 = await callTool("search_instruments", {
      as_of: AS_OF,
      limit: 3,
      offset: 6,
    });
    expect(page3.results).toHaveLength(1);

    // No overlap between pages
    const allSymbols = [
      ...page1.results.map((r: { venue_symbol: string }) => r.venue_symbol),
      ...page2.results.map((r: { venue_symbol: string }) => r.venue_symbol),
      ...page3.results.map((r: { venue_symbol: string }) => r.venue_symbol),
    ];
    expect(new Set(allSymbols).size).toBe(7);

    await client.close();
    await server.close();
  });

  it("includes provenance fields in each result", async () => {
    const server = await connect();

    const data = await callTool("search_instruments", {
      mic: "XNYS",
      as_of: AS_OF,
    });
    const aapl = data.results.find(
      (r: { venue_symbol: string }) => r.venue_symbol === "AAPL"
    );

    expect(aapl).toBeDefined();
    expect(aapl.provenance).toBeDefined();
    expect(aapl.provenance.source_name).toBeDefined();
    expect(aapl.provenance.source_location).toBeDefined();
    expect(aapl.provenance.ingest_run_id).toBe(1);
    expect(aapl.provenance.recorded_at).toBeDefined();
    expect(aapl.content_hash).toBe("h1");
    expect(aapl.cdm_json).toBeDefined();

    await client.close();
    await server.close();
  });

  it("includes per-field lineage when stored in CDM JSON", async () => {
    const server = await connect();

    const data = await callTool("search_instruments", {
      mic: "XNYS",
      as_of: AS_OF,
    });

    const aapl = data.results.find(
      (r: { venue_symbol: string }) => r.venue_symbol === "AAPL"
    );
    expect(aapl.lineage).toEqual({ isin: "col_ISIN" });

    const nvda = data.results.find(
      (r: { venue_symbol: string }) => r.venue_symbol === "NVDA"
    );
    expect(nvda.lineage).toEqual({ isin: "col_ISIN_V2" });

    const msft = data.results.find(
      (r: { venue_symbol: string }) => r.venue_symbol === "MSFT"
    );
    // MSFT has no _lineage in CDM JSON
    expect(msft.lineage).toEqual({});

    await client.close();
    await server.close();
  });

  it("derives announced → active → delisted status transitions correctly", async () => {
    const server = await connect();

    // NVDA: effective_from=2025-04-01, effective_to=2025-05-31
    // as_of=2025-03-15 → announced (effective_from > as_of)
    const dataAnnounced = await callTool("search_instruments", {
      mic: "XNYS",
      as_of: "2025-03-15",
    });
    const nvdaA = dataAnnounced.results.find(
      (r: { venue_symbol: string }) => r.venue_symbol === "NVDA"
    );
    expect(nvdaA.status).toBe("announced");

    // as_of=2025-04-15 → active (effective_from <= as_of, effective_to > as_of)
    const dataActive = await callTool("search_instruments", {
      mic: "XNYS",
      as_of: "2025-04-15",
    });
    const nvdaB = dataActive.results.find(
      (r: { venue_symbol: string }) => r.venue_symbol === "NVDA"
    );
    expect(nvdaB.status).toBe("active");

    // as_of=2025-06-15 → delisted (effective_to <= as_of)
    const dataDelisted = await callTool("search_instruments", {
      mic: "XNYS",
      as_of: "2025-06-15",
    });
    const nvdaC = dataDelisted.results.find(
      (r: { venue_symbol: string }) => r.venue_symbol === "NVDA"
    );
    expect(nvdaC.status).toBe("delisted");

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// get_instrument tests
// ---------------------------------------------------------------------------

describe("get_instrument", () => {
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
      /* ok */
    }
    try {
      store.close();
    } catch {
      /* ok */
    }
  });

  async function connect() {
    const server = await startMcpServer(store, serverTransport);
    await client.connect(clientTransport);
    return server;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const textContent = result.content?.find(
      (c: { type: string }) => c.type === "text"
    ) as { type: "text"; text: string } | undefined;
    return textContent ? JSON.parse(textContent.text) : null;
  }

  it("returns a single instrument by MIC and symbol", async () => {
    const server = await connect();

    const data = await callTool("get_instrument", {
      mic: "XNYS",
      symbol: "AAPL",
    });

    expect(data).toBeDefined();
    expect(data.mic).toBe("XNYS");
    expect(data.venue_symbol).toBe("AAPL");
    expect(data.cdm_json).toBeDefined();
    expect(data.cdm_json.name).toBe("Apple Inc.");
    expect(data.provenance).toBeDefined();

    await client.close();
    await server.close();
  });

  it("returns error for nonexistent instrument", async () => {
    const server = await connect();

    const data = await callTool("get_instrument", {
      mic: "XNYS",
      symbol: "NONEXISTENT",
    });

    expect(data.error).toBeDefined();
    expect(data.error).toContain("not found");

    await client.close();
    await server.close();
  });

  it("returns instrument effective at given as_of", async () => {
    const server = await connect();

    // AAPL at as_of=2025-06-01 should be active
    const data = await callTool("get_instrument", {
      mic: "XNYS",
      symbol: "AAPL",
      as_of: "2025-06-01",
    });

    expect(data).toBeDefined();
    expect(data.venue_symbol).toBe("AAPL");
    expect(data.status).toBe("active");

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// instrument:// resource tests
// ---------------------------------------------------------------------------

describe("instrument:// resource", () => {
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
      /* ok */
    }
    try {
      store.close();
    } catch {
      /* ok */
    }
  });

  async function connect() {
    const server = await startMcpServer(store, serverTransport);
    await client.connect(clientTransport);
    return server;
  }

  async function readResource(uri: string) {
    const result = await client.readResource({ uri });
    const contents = result.contents as {
      uri: string;
      mimeType: string;
      text: string;
    }[];
    return contents[0];
  }

  it("returns CDM JSON for a valid instrument", async () => {
    const server = await connect();

    const content = await readResource("instrument://XNYS/AAPL");

    expect(content).toBeDefined();
    expect(content.mimeType).toBe("application/json");

    const parsed = JSON.parse(content.text);
    expect(parsed.isin).toBe("US0378331005");
    expect(parsed.name).toBe("Apple Inc.");

    await client.close();
    await server.close();
  });

  it("returns CDM JSON via get_instrument with as_of parameter", async () => {
    // The as_of query parameter on instrument:// URIs is not supported
    // by MCP's strict URI-template matching. Use get_instrument tool instead.
    const server = await connect();

    const result = await client.callTool({
      name: "get_instrument",
      arguments: { mic: "XNYS", symbol: "AAPL", as_of: "2025-06-01" },
    });
    const textContent = result.content?.find(
      (c: { type: string }) => c.type === "text"
    ) as { type: "text"; text: string } | undefined;
    const data = textContent ? JSON.parse(textContent.text) : null;

    expect(data).toBeDefined();
    expect(data.cdm_json).toBeDefined();
    expect(data.cdm_json.isin).toBe("US0378331005");

    await client.close();
    await server.close();
  });

  it("returns error JSON for nonexistent instrument", async () => {
    const server = await connect();

    const content = await readResource("instrument://XNYS/NONEXISTENT");

    expect(content).toBeDefined();
    const parsed = JSON.parse(content.text);
    expect(parsed.error).toContain("not found");

    await client.close();
    await server.close();
  });
});
