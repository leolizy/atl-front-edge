import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { SourceRegistry } from "../sources/source-registry.js";
import { SnapshotFetcher } from "../sources/snapshot-fetcher.js";
import { DeltaEngine } from "../delta/delta-engine.js";
import { IngestPipeline } from "../pipeline/ingest-pipeline.js";
import { ADAPTER_REGISTRY } from "../adapters/index.js";
import { annaDsbAdapter } from "../adapters/anna-dsb-adapter.js";
import type { Adapter } from "../adapters/adapter.js";
import type { StockProfile } from "../assembler/types.js";

const DEFAULT_DB_PATH = "./data/pool.db";
const DEFAULT_PROFILE_PATH = "./config/stock-profile.json";

/** Map of supported venue MIC codes to their adapters. */
const ADAPTERS: Record<string, Adapter> = {
  ...ADAPTER_REGISTRY,
  DSB: annaDsbAdapter,
};

export interface IngestCliOptions {
  dbPath: string;
  profilePath: string;
  mic: string;
  filePath?: string;
  effectiveDate?: string;
}

export function parseIngestArgs(argv: string[]): IngestCliOptions | null {
  const result: IngestCliOptions = {
    dbPath: DEFAULT_DB_PATH,
    profilePath: DEFAULT_PROFILE_PATH,
    mic: "",
  };

  let i = 0;
  // Skip "ingest" subcommand
  while (i < argv.length && argv[i] !== "ingest") i++;
  if (i >= argv.length) return null;
  i++; // past "ingest"

  // First positional arg is the MIC
  if (i < argv.length && !argv[i].startsWith("--")) {
    result.mic = argv[i];
    i++;
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--file" && i + 1 < argv.length) {
      result.filePath = argv[i + 1];
      i += 2;
    } else if (arg === "--db" && i + 1 < argv.length) {
      result.dbPath = argv[i + 1];
      i += 2;
    } else if (arg === "--profile" && i + 1 < argv.length) {
      result.profilePath = argv[i + 1];
      i += 2;
    } else if (arg === "--as-of" && i + 1 < argv.length) {
      result.effectiveDate = argv[i + 1];
      i += 2;
    } else if (arg === "--effective-date" && i + 1 < argv.length) {
      result.effectiveDate = argv[i + 1];
      i += 2;
    } else {
      i++;
    }
  }

  if (!result.mic) {
    return null;
  }

  return result;
}

export function printIngestUsage(): void {
  console.error(
    [
      "Usage:",
      "  npx narwhal ingest <mic> [--file <path>] [--as-of <date>] [--effective-date <date>] [--db <path>] [--profile <path>]",
      "",
      "Options:",
      "  --file <path>              Process a historical snapshot file (backfill mode)",
      "  --as-of <date>             Business date for the run (YYYY-MM-DD, default: today)",
      "  --effective-date <date>    Alias for --as-of",
      "  --db <path>                Path to SQLite database (default: ./data/pool.db)",
      "  --profile <path>           Path to profile JSON (default: ./config/stock-profile.json)",
    ].join("\n")
  );
}

function loadProfile(profilePath: string): StockProfile {
  const raw = readFileSync(resolve(profilePath), "utf-8");
  return JSON.parse(raw) as StockProfile;
}

export async function runIngest(
  db: Database.Database,
  options: IngestCliOptions
): Promise<void> {
  const mic = options.mic.toUpperCase();
  const adapter = ADAPTERS[mic];

  if (!adapter) {
    console.error(
      `Error: No adapter registered for venue "${mic}". Supported venues: ${Object.keys(ADAPTERS).join(", ")}`
    );
    process.exit(1);
  }

  const sourceRegistry = new SourceRegistry(db);
  const fetcher = new SnapshotFetcher(sourceRegistry);
  const deltaEngine = new DeltaEngine(db);
  const profile = loadProfile(options.profilePath);

  const pipeline = new IngestPipeline(db, fetcher, deltaEngine);

  const report = await pipeline.runIngest(
    {
      venue: mic,
      filePath: options.filePath,
      effectiveDate: options.effectiveDate,
    },
    adapter,
    profile
  );

  console.log(JSON.stringify(report, null, 2));
}
