import Database from "better-sqlite3";
import { Migrator } from "../db/migrator.js";
import { migration001, migration002, migration003 } from "../db/index.js";
import { SourceRegistry } from "../sources/source-registry.js";

const DEFAULT_DB_PATH = "./data/pool.db";

function parseArgs(argv: string[]): {
  dbPath: string;
  subcommand: string | null;
  args: string[];
  note?: string;
  mic?: string;
} {
  const result: {
    dbPath: string;
    subcommand: string | null;
    args: string[];
    note?: string;
    mic?: string;
  } = {
    dbPath: DEFAULT_DB_PATH,
    subcommand: null,
    args: [],
  };

  let i = 2; // skip node and script path
  // Look for source subcommand group
  if (i < argv.length && argv[i] === "source") {
    i++;
    if (i < argv.length) {
      result.subcommand = argv[i];
      i++;
    }
  } else if (i < argv.length) {
    result.subcommand = argv[i];
    i++;
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--db" && i + 1 < argv.length) {
      result.dbPath = argv[i + 1];
      i += 2;
    } else if (arg === "--note" && i + 1 < argv.length) {
      result.note = argv[i + 1];
      i += 2;
    } else if (arg === "--mic" && i + 1 < argv.length) {
      result.mic = argv[i + 1];
      i += 2;
    } else {
      result.args.push(arg);
      i++;
    }
  }

  return result;
}

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
    ].join("\n")
  );
}

export function runApprove(
  db: Database.Database,
  mic: string,
  location: string,
  approver: string,
  note?: string
): void {
  const registry = new SourceRegistry(db);
  const result = registry.approve_source(mic, location, approver, note);
  console.log(
    JSON.stringify({
      id: result.id,
      mic,
      location,
      approver,
      approved_at: result.approved_at,
      terms_note: note ?? null,
    })
  );
}

export function runList(db: Database.Database, mic?: string): void {
  const registry = new SourceRegistry(db);
  const sources = registry.list_sources(mic);
  if (sources.length === 0) {
    console.log("[]");
    return;
  }
  console.log(JSON.stringify(sources, null, 2));
}

export function main(argv: string[] = process.argv): void {
  const { dbPath, subcommand, args, note, mic } = parseArgs(argv);

  if (!subcommand || (subcommand !== "approve" && subcommand !== "list")) {
    printUsage();
    process.exit(1);
  }

  const db = setupDb(dbPath);

  try {
    if (subcommand === "approve") {
      if (args.length < 2) {
        console.error("Error: approve requires <mic> and <location>");
        printUsage();
        process.exit(1);
      }
      const approver = process.env.USER || process.env.USERNAME || "operator";
      runApprove(db, args[0], args[1], approver, note);
    } else if (subcommand === "list") {
      runList(db, mic);
    }
  } finally {
    db.close();
  }
}

// Allow direct execution
if (
  process.argv[1]?.endsWith("source-cli.js") ||
  process.argv[1]?.endsWith("source-cli.ts")
) {
  main();
}
