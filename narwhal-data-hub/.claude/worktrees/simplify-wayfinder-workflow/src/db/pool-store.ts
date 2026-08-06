import Database from "better-sqlite3";
import { Migrator } from "./migrator.js";
import { migration001 } from "./migrations/001-initial-schema.js";
import { migration002 } from "./migrations/002-asset-class-expansion.js";
import { migration003 } from "./migrations/003-otc-asset-class-expansion.js";

export interface PoolStoreOptions {
  /** Path to the SQLite database file. Use ":memory:" for testing. */
  dbPath: string;
  /** Enable WAL mode (default: true). */
  wal?: boolean;
}

export class PoolStore {
  readonly db: Database.Database;
  private migrator: Migrator;

  constructor(options: PoolStoreOptions) {
    this.db = new Database(options.dbPath);

    if (options.wal !== false) {
      this.db.pragma("journal_mode = WAL");
    }
    this.db.pragma("foreign_keys = ON");

    this.migrator = new Migrator(this.db);
  }

  /** Run all pending migrations. Safe to call multiple times — no-op if up to date. */
  migrate(): void {
    this.migrator.migrate([migration001, migration002, migration003]);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  /** Returns true if WAL mode is enabled. */
  isWalMode(): boolean {
    const row = this.db.pragma("journal_mode") as { journal_mode: string }[];
    return row[0]?.journal_mode === "wal";
  }
}
