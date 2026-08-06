import type Database from "better-sqlite3";

export interface SourceRow {
  id: number;
  mic: string;
  location: string;
  approver: string;
  approved_at: string;
  terms_note: string | null;
}

export interface ApproveResult {
  id: number;
  approved_at: string;
}

export class SourceRegistry {
  constructor(private db: Database.Database) {}

  /**
   * Approve a source — records who approved it, when, and an optional terms note.
   * Returns the new row id and the approval timestamp.
   */
  approve_source(
    mic: string,
    location: string,
    approver: string,
    terms_note?: string
  ): ApproveResult {
    const approved_at = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO sources (mic, location, approver, approved_at, terms_note)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(mic, location, approver, approved_at, terms_note ?? null);
    return { id: Number(result.lastInsertRowid), approved_at };
  }

  /**
   * List all approved sources, optionally filtered by MIC.
   * Returns the most recently approved sources first.
   */
  list_sources(mic?: string): SourceRow[] {
    if (mic) {
      return this.db
        .prepare(
          "SELECT * FROM sources WHERE mic = ? ORDER BY approved_at DESC"
        )
        .all(mic) as SourceRow[];
    }
    return this.db
      .prepare("SELECT * FROM sources ORDER BY approved_at DESC")
      .all() as SourceRow[];
  }

  /**
   * Returns true if the given location has been approved.
   * This is the hard precondition the fetcher will use before ingesting data.
   */
  is_approved(location: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sources WHERE location = ? LIMIT 1")
      .get(location);
    return row !== undefined;
  }
}
