import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { PoolStore } from "../db/pool-store.js";
import { DictionaryGenerator } from "../dictionary/dictionary-generator.js";
import { SourceRegistry } from "../sources/source-registry.js";
import { SnapshotFetcher } from "../sources/snapshot-fetcher.js";
import { DeltaEngine } from "../delta/delta-engine.js";
import { IngestPipeline } from "../pipeline/ingest-pipeline.js";
import { ADAPTER_REGISTRY } from "../adapters/index.js";
import type { Adapter } from "../adapters/adapter.js";
import type { StockProfile } from "../assembler/types.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerPrompts } from "./prompts.js";
import { registerChangesOperations } from "./tools/changes-operations.js";
import { registerDictionary } from "./tools/dictionary-tools.js";
import { registerAdminTools } from "./tools/admin-tools.js";
import { registerResolveInstrumentTool } from "./tools/resolve-instrument.js";
import {
  registerSearchInstrumentsTool,
  registerGetInstrumentTool,
  registerInstrumentResource,
} from "./tools/search-instruments.js";

/** Adapters keyed by venue MIC. */
const VENUE_ADAPTERS: Record<string, Adapter> = { ...ADAPTER_REGISTRY };

/** Load the stock profile from config. */
function loadStockProfile(): StockProfile {
  const configDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "config"
  );
  return JSON.parse(
    readFileSync(resolve(configDir, "stock-profile.json"), "utf-8")
  ) as StockProfile;
}

/**
 * Creates a configured McpServer with all tools, resources, and prompts
 * registered.  Admin tools (ticket 18) are wired in alongside everything
 * from earlier tickets.
 */
export function createMcpServer(_store: PoolStore): McpServer {
  const server = new McpServer(
    {
      name: "narwhal-data-hub",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
      },
      instructions:
        "Narwhal Data Hub — local MCP server for bitemporal, FINOS CDM-structured product data pool.",
    }
  );

  //
  // Tool registration scaffold
  // Pattern: server.registerTool(name, config, handler)
  //

  // Ticket 10: resolve_instrument — resolve by ISIN, FIGI, CUSIP, SEDOL,
  // venue symbol + MIC, or free-text search.
  registerResolveInstrumentTool(server, _store.db);

  // Ticket 11: search_instruments, get_instrument, instrument:// resource
  registerSearchInstrumentsTool(server, _store.db);
  registerGetInstrumentTool(server, _store.db);
  registerInstrumentResource(server, _store.db);

  // Dictionary — regenerate from configs and seed initial aliases
  const dict = new DictionaryGenerator(_store);
  dict.regenerate();
  dict.seedAliases();

  // Ticket 13: Dictionary tools + resources (lookup_term, search_dictionary, dict:// resources)
  registerDictionary(server, dict);

  // Ticket 12: Changes, ingest status, and operational tools
  registerChangesOperations(server, _store.db);

  // Ticket 14: MCP prompts (identify_instrument, what_changed_recently)
  registerPrompts(server);

  // Ticket 18: Admin tools (approve_source, trigger_ingest, review_quarantine,
  //            reprocess_quarantine, update_alias, regenerate_dictionary)
  const sourceRegistry = new SourceRegistry(_store.db);
  const snapshotFetcher = new SnapshotFetcher(sourceRegistry);
  const deltaEngine = new DeltaEngine(_store.db);
  const pipeline = new IngestPipeline(_store.db, snapshotFetcher, deltaEngine);
  const profile = loadStockProfile();

  registerAdminTools(
    server,
    _store.db,
    sourceRegistry,
    pipeline,
    dict,
    VENUE_ADAPTERS,
    profile
  );

  return server;
}

/**
 * Start the MCP server with the given transport and database store.
 * Handles the full lifecycle: connect to transport, then close DB on shutdown.
 */
export async function startMcpServer(
  store: PoolStore,
  transport: Transport
): Promise<McpServer> {
  const server = createMcpServer(store);

  // Close the database connection when the transport closes
  transport.onclose = () => {
    store.close();
  };

  await server.connect(transport);

  return server;
}

/**
 * Convenience: create + start server over stdio transport.
 * This is the production entry point.
 */
export async function startStdioServer(store: PoolStore): Promise<McpServer> {
  const transport = new StdioServerTransport();
  return startMcpServer(store, transport);
}
