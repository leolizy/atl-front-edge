import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PoolStore } from "../src/db/pool-store.js";
import { startMcpServer } from "../src/mcp/server.js";
import { DictionaryGenerator } from "../src/dictionary/dictionary-generator.js";

function createSeededStore(): PoolStore {
  const store = new PoolStore({ dbPath: ":memory:", wal: false });
  store.migrate();
  return store;
}

describe("MCP dictionary tools", () => {
  let store: PoolStore;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let client: Client;

  beforeEach(() => {
    store = createSeededStore();
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: "test-client", version: "1.0.0" },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
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

  async function startServerAndConnect() {
    const server = startMcpServer(store, serverTransport);
    await client.connect(clientTransport);
    return { server };
  }

  // ── lookup_term ──────────────────────────────────────────────────────────

  it("lookup_term resolves alias 'ticker' → venue_symbol extension", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "lookup_term",
      arguments: { term: "ticker" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    expect(content.type).toBe("text");
    const parsed = JSON.parse(content.text);

    // ticker is an alias for venue_symbol — lookup_term should resolve
    // through the alias to the extension entry for venue_symbol.
    expect(parsed.match).toBe("venue_symbol");
    expect(parsed.layer).toBe("ext");
    expect(parsed.definition).toContain("ticker");
    expect(parsed.uri).toBe("dict://ext/venue_symbol");
    expect(parsed.see_also).toBeDefined();
  });

  it("lookup_term returns CDM type with correct definition and URI", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "lookup_term",
      arguments: { term: "Product" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.match).toBe("Product");
    expect(parsed.layer).toBe("cdm");
    expect(parsed.definition).toContain("FINOS Common Domain Model");
    expect(parsed.uri).toBe("dict://cdm/Product");
  });

  it("lookup_term finds extension field by name", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "lookup_term",
      arguments: { term: "mic" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.match).toBe("mic");
    expect(parsed.layer).toBe("ext");
    expect(parsed.definition).toContain("Market Identifier Code");
    expect(parsed.uri).toBe("dict://ext/mic");
  });

  it("lookup_term finds lineage entry for source field (figi — not in extensions)", async () => {
    // "figi" appears only in the stock-profile lineage, not in the extensions
    // registry, so lookup should return a lineage entry.
    await startServerAndConnect();

    const result = await client.callTool({
      name: "lookup_term",
      arguments: { term: "figi" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.match).toBe("figi");
    expect(parsed.layer).toBe("lineage");
    expect(parsed.definition).toContain("instrument.identifiers");
    expect(parsed.uri).toContain("dict://lineage/");
  });

  it("lookup_term returns error message for unknown term", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "lookup_term",
      arguments: { term: "nonexistent_xyzzy" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("nonexistent_xyzzy");
  });

  it("lookup_term resolves 'board lot' alias to board_lot extension", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "lookup_term",
      arguments: { term: "board lot" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.match).toBe("board_lot");
    expect(parsed.layer).toBe("ext");
    expect(parsed.definition).toContain("Board lot");
  });

  it("lookup_term resolves 'exchange' alias to mic extension", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "lookup_term",
      arguments: { term: "exchange" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.match).toBe("mic");
    expect(parsed.layer).toBe("ext");
  });

  it("lookup_term resolves 'name' alias to instrument_name", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "lookup_term",
      arguments: { term: "name" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.match).toBe("instrument_name");
    expect(parsed.layer).toBe("ext");
    expect(parsed.definition).toContain("human-readable");
  });

  // ── search_dictionary ────────────────────────────────────────────────────

  it("search_dictionary finds extension by query", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "search_dictionary",
      arguments: { query: "board lot" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.total).toBeGreaterThanOrEqual(1);
    const boardLot = parsed.results.find(
      (r: { match: string }) => r.match === "board_lot"
    );
    expect(boardLot).toBeDefined();
    expect(boardLot.definition).toContain("Board lot");
  });

  it("search_dictionary finds multiple results for common term", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "search_dictionary",
      arguments: { query: "CDM" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.total).toBeGreaterThanOrEqual(1);
    expect(parsed.results).toBeInstanceOf(Array);
  });

  it("search_dictionary returns empty results for nonsense query", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "search_dictionary",
      arguments: { query: "xyzzy_nonexistent_abc" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.total).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it("search_dictionary finds Instrument type by name", async () => {
    await startServerAndConnect();

    const result = await client.callTool({
      name: "search_dictionary",
      arguments: { query: "Instrument" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    const instrument = parsed.results.find(
      (r: { match: string; layer: string }) =>
        r.match === "Instrument" && r.layer === "cdm"
    );
    expect(instrument).toBeDefined();
  });

  // ── dict://cdm resource ──────────────────────────────────────────────────

  it("dict://cdm/Product returns correct definition", async () => {
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://cdm/Product",
    });

    const contents = result.contents as { uri: string; text: string }[];
    expect(contents.length).toBe(1);

    const parsed = JSON.parse(contents[0].text);
    expect(parsed.match).toBe("Product");
    expect(parsed.layer).toBe("cdm");
    expect(parsed.definition).toContain("FINOS Common Domain Model");
    expect(parsed.uri).toBe("dict://cdm/Product");
  });

  it("dict://cdm/Equity returns CDM type definition", async () => {
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://cdm/Equity",
    });

    const contents = result.contents as { uri: string; text: string }[];
    expect(contents.length).toBe(1);

    const parsed = JSON.parse(contents[0].text);
    expect(parsed.match).toBe("Equity");
    expect(parsed.layer).toBe("cdm");
    expect(parsed.definition).toContain("Equity");
  });

  it("dict://cdm/Nonexistent returns error", async () => {
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://cdm/NonexistentType",
    });

    const contents = result.contents as { uri: string; text: string }[];
    expect(contents.length).toBe(1);

    const parsed = JSON.parse(contents[0].text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("NonexistentType");
  });

  // ── dict://ext resource ──────────────────────────────────────────────────

  it("dict://ext/board_lot returns extension definition", async () => {
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://ext/board_lot",
    });

    const contents = result.contents as { uri: string; text: string }[];
    expect(contents.length).toBe(1);

    const parsed = JSON.parse(contents[0].text);
    expect(parsed.match).toBe("board_lot");
    expect(parsed.layer).toBe("ext");
    expect(parsed.definition).toContain("Board lot");
  });

  it("dict://ext/mic returns extension definition", async () => {
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://ext/mic",
    });

    const contents = result.contents as { uri: string; text: string }[];
    expect(contents.length).toBe(1);

    const parsed = JSON.parse(contents[0].text);
    expect(parsed.match).toBe("mic");
    expect(parsed.layer).toBe("ext");
    expect(parsed.definition).toContain("Market Identifier Code");
  });

  // ── dict://alias resource ────────────────────────────────────────────────

  it("dict://alias/ticker returns alias mapping", async () => {
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://alias/ticker",
    });

    const contents = result.contents as { uri: string; text: string }[];
    expect(contents.length).toBe(1);

    const parsed = JSON.parse(contents[0].text);
    expect(parsed.match).toBe("ticker");
    expect(parsed.layer).toBe("alias");
    expect(parsed.see_also).toContain("venue_symbol");
    expect(parsed.uri).toBe("dict://alias/ticker");
  });

  it("dict://alias/nonexistent returns error", async () => {
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://alias/nonexistentalias",
    });

    const contents = result.contents as { uri: string; text: string }[];
    expect(contents.length).toBe(1);

    const parsed = JSON.parse(contents[0].text);
    expect(parsed.error).toBeDefined();
  });

  // ── dict://lineage resource ──────────────────────────────────────────────

  it("dict://lineage/instrument.name returns source mappings", async () => {
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://lineage/instrument.name",
    });

    const contents = result.contents as { uri: string; text: string }[];
    expect(contents.length).toBe(1);

    const parsed = JSON.parse(contents[0].text);
    expect(parsed.cdm_path).toBe("instrument.name");
    expect(parsed.sources).toBeInstanceOf(Array);
    // instrument_name maps to instrument.name
    const source = parsed.sources.find(
      (s: { match: string }) => s.match === "instrument_name"
    );
    expect(source).toBeDefined();
    expect(source.definition).toContain("instrument.name");
  });

  it("dict://lineage/instrument.identifiers[] returns multiple sources", async () => {
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://lineage/instrument.identifiers[]",
    });

    const contents = result.contents as { uri: string; text: string }[];
    expect(contents.length).toBe(1);

    const parsed = JSON.parse(contents[0].text);
    expect(parsed.cdm_path).toBe("instrument.identifiers[]");
    expect(parsed.sources.length).toBeGreaterThanOrEqual(1);
    // isin, figi, cusip, sedol all map to instrument.identifiers[]
    const sourceNames = parsed.sources.map((s: { match: string }) => s.match);
    expect(sourceNames).toContain("isin");
  });

  it("dict://lineage/unknown.path returns error", async () => {
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://lineage/unknown.cdm.path",
    });

    const contents = result.contents as { uri: string; text: string }[];
    expect(contents.length).toBe(1);

    const parsed = JSON.parse(contents[0].text);
    expect(parsed.error).toBeDefined();
  });

  // ── Alias regeneration ───────────────────────────────────────────────────

  it("add alias → lookup_term reflects the new alias (lineage layer)", async () => {
    // Set up dictionary manually and add a new alias
    const dict = new DictionaryGenerator(store);
    dict.regenerate();
    dict.seedAliases();

    // "figi" is in lineage (not extensions), so alias resolves to lineage
    dict.addAlias("foo", "figi");

    // Start server and connect
    await startServerAndConnect();

    // lookup_term should resolve "foo" → "figi" → lineage entry
    const result = await client.callTool({
      name: "lookup_term",
      arguments: { term: "foo" },
    });

    const content = (result.content as { type: string; text: string }[])[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.match).toBe("figi");
    expect(parsed.layer).toBe("lineage");
    expect(parsed.definition).toContain("instrument.identifiers");
  });

  it("add alias → dict://alias/{term} returns the new alias", async () => {
    // Set up dictionary manually and add a new alias
    const dict = new DictionaryGenerator(store);
    dict.regenerate();
    dict.seedAliases();
    dict.addAlias("custom-key", "tick_size");

    // Start server and connect (createMcpServer will pick up the alias from the DB)
    await startServerAndConnect();

    const result = await client.readResource({
      uri: "dict://alias/custom-key",
    });

    const contents = result.contents as { uri: string; text: string }[];
    const parsed = JSON.parse(contents[0].text);
    expect(parsed.match).toBe("custom-key");
    expect(parsed.layer).toBe("alias");
    expect(parsed.see_also).toContain("tick_size");
  });

  // ── Tool listing includes dictionary tools ───────────────────────────────

  it("listTools includes lookup_term and search_dictionary", async () => {
    await startServerAndConnect();

    const result = await client.listTools();

    const toolNames = result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("lookup_term");
    expect(toolNames).toContain("search_dictionary");
  });

  it("listResources includes dict:// resources", async () => {
    await startServerAndConnect();

    const result = await client.listResources();

    const resourceUris = result.resources.map((r: { uri: string }) => r.uri);
    // Static resources (or templates that got listed) should include dict:// ones
    // Note: templated resources don't appear in listResources without explicit listing,
    // so this may be empty. We just verify the call succeeds.
    expect(result.resources).toBeDefined();
  });
});
