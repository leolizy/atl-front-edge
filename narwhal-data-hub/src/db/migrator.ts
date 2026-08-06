export interface Migration {
  version: number;
  name: string;
  up(db: import("better-sqlite3").Database): void;
}

export class Migrator {
  constructor(private db: import("better-sqlite3").Database) {}

  migrate(migrations: Migration[]): void {
    this.ensureMigrationTable();

    const applied = this.appliedVersions();
    const pending = migrations
      .filter((m) => !applied.has(m.version))
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      this.db.transaction(() => {
        migration.up(this.db);
        this.db
          .prepare(
            "INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)"
          )
          .run(migration.version, migration.name, new Date().toISOString());
      })();
    }
  }

  private ensureMigrationTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version   INTEGER PRIMARY KEY,
        name      TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  private appliedVersions(): Set<number> {
    const rows = this.db.prepare("SELECT version FROM migrations").all() as {
      version: number;
    }[];
    return new Set(rows.map((r) => r.version));
  }
}
