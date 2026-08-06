import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PoolStore } from "../src/db/pool-store.js";
import { createMcpServer } from "../src/mcp/server.js";

function createSeededStore(): PoolStore {
  const store = new PoolStore({ dbPath: ":memory:", wal: false });
  store.migrate();
  return store;
}

describe("MCP prompts", () => {
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

  it("list_prompts returns both prompts with correct descriptions", async () => {
    const server = createMcpServer(store);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.listPrompts();
    expect(result.prompts).toBeDefined();
    expect(Array.isArray(result.prompts)).toBe(true);

    const promptNames = result.prompts.map((p) => p.name);
    expect(promptNames).toContain("identify_instrument");
    expect(promptNames).toContain("what_changed_recently");

    const identifyPrompt = result.prompts.find(
      (p) => p.name === "identify_instrument"
    );
    expect(identifyPrompt).toBeDefined();
    expect(identifyPrompt!.description).toBeDefined();
    expect(identifyPrompt!.description).toContain("ISIN");

    const changesPrompt = result.prompts.find(
      (p) => p.name === "what_changed_recently"
    );
    expect(changesPrompt).toBeDefined();
    expect(changesPrompt!.description).toBeDefined();
    expect(changesPrompt!.description).toContain("ingest");

    await client.close();
    await server.close();
  });

  it("get_prompt('identify_instrument') references resolve_instrument and search_instruments", async () => {
    const server = createMcpServer(store);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.getPrompt({
      name: "identify_instrument",
      arguments: {},
    });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);

    // The prompt should be a user-role message with text content
    const msg = result.messages[0];
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");

    const text = msg.content.text as string;
    expect(text).toContain("resolve_instrument");
    expect(text).toContain("search_dictionary");

    await client.close();
    await server.close();
  });

  it("get_prompt('what_changed_recently') references get_ingest_status and list_changes", async () => {
    const server = createMcpServer(store);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.getPrompt({
      name: "what_changed_recently",
      arguments: {},
    });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);

    const msg = result.messages[0];
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");

    const text = msg.content.text as string;
    expect(text).toContain("get_ingest_status");
    expect(text).toContain("list_changes");

    await client.close();
    await server.close();
  });

  it("prompts are discoverable alongside tools and resources", async () => {
    const server = createMcpServer(store);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Tools still work
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);
    expect(toolNames).toContain("resolve_instrument");

    // Resources still work
    const resourcesResult = await client.listResources();
    expect(Array.isArray(resourcesResult.resources)).toBe(true);

    // Prompts work
    const promptsResult = await client.listPrompts();
    expect(promptsResult.prompts.length).toBe(2);

    await client.close();
    await server.close();
  });
});
