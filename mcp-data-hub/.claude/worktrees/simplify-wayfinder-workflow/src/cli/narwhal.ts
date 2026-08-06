#!/usr/bin/env node

import Database from "better-sqlite3";
import { Migrator } from "../db/migrator.js";
import { migration001 } from "../db/migrations/001-initial-schema.js";
import { migration002 } from "../db/migrations/002-asset-class-expansion.js";
import { migration003 } from "../db/migrations/003-otc-asset-class-expansion.js";
import { parseIngestArgs, printIngestUsage, runIngest } from "./ingest-cli.js";
import { main as sourceMain } from "./source-cli.js";

const DEFAULT_DB_PATH = "./data/pool.db";

function setupDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  new Migrator(db).migrate([migration001, migration002, migration003]);
  return db;
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  npx narwhal source approve <mic> <location> [--note <note>] [--db <path>]",
      "  npx narwhal source list [--mic <mic>] [--db <path>]",
      "  npx narwhal ingest <mic> [--file <path>] [--db <path>] [--profile <path>]",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    printUsage();
    process.exit(1);
  }

  const subcommand = argv[0];

  if (subcommand === "source") {
    // Delegate to source-cli which has its own arg parsing and main()
    sourceMain(["node", "narwhal", ...argv]);
    return;
  }

  if (subcommand === "ingest") {
    const opts = parseIngestArgs(argv);
    if (!opts) {
      printIngestUsage();
      process.exit(1);
    }

    const db = setupDb(opts.dbPath);
    try {
      await runIngest(db, opts);
    } finally {
      db.close();
    }
    return;
  }

  console.error(`Unknown command: ${subcommand}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
