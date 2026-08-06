import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Migrator } from "../src/db/migrator.js";
import { migration001 } from "../src/db/index.js";
import { SourceRegistry } from "../src/sources/source-registry.js";
import type { SourceRow } from "../src/sources/source-registry.js";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function runMigrations(db: Database.Database): void {
  new Migrator(db).migrate([migration001]);
}

describe("SourceRegistry", () => {
  let db: Database.Database;
  let registry: SourceRegistry;

  beforeEach(() => {
    db = createDb();
    runMigrations(db);
    registry = new SourceRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("approve_source", () => {
    it("approves a source and records id, timestamp, and all fields", () => {
      const result = registry.approve_source(
        "XNYS",
        "file://data/xnys.csv",
        "alice",
        "approved per terms v1"
      );

      expect(result.id).toBeGreaterThan(0);
      expect(result.approved_at).toBeTruthy();

      const rows = db
        .prepare("SELECT * FROM sources WHERE id = ?")
        .all(result.id) as SourceRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.id,
        mic: "XNYS",
        location: "file://data/xnys.csv",
        approver: "alice",
        approved_at: result.approved_at,
        terms_note: "approved per terms v1",
      });
    });

    it("approves a source with no terms note", () => {
      const result = registry.approve_source(
        "XCHI",
        "file://data/xchi.csv",
        "bob"
      );

      expect(result.id).toBeGreaterThan(0);
      const rows = db
        .prepare("SELECT * FROM sources WHERE id = ?")
        .all(result.id) as SourceRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0].terms_note).toBeNull();
    });

    it("returns a different id for each approval", () => {
      const r1 = registry.approve_source(
        "XNYS",
        "file://data/xnys.csv",
        "alice"
      );
      const r2 = registry.approve_source(
        "XCHI",
        "file://data/xchi.csv",
        "alice"
      );

      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe("list_sources", () => {
    it("returns empty array when no sources are approved", () => {
      const sources = registry.list_sources();
      expect(sources).toEqual([]);
    });

    it("returns all approved sources ordered by most recent first", async () => {
      registry.approve_source("XNYS", "file://data/xnys.csv", "alice");
      // Small delay to ensure distinct timestamps for ordering
      await new Promise((r) => setTimeout(r, 2));
      const later = registry.approve_source(
        "XCHI",
        "file://data/xchi.csv",
        "bob"
      );

      const sources = registry.list_sources();
      expect(sources).toHaveLength(2);
      // Later approval should appear first due to ORDER BY approved_at DESC
      expect(sources[0].id).toBe(later.id);
    });

    it("filters by MIC when provided", () => {
      registry.approve_source("XNYS", "file://data/xnys.csv", "alice");
      registry.approve_source("XCHI", "file://data/xchi.csv", "bob");
      registry.approve_source("XNYS", "file://data/xnys2.csv", "alice");

      const xnysSources = registry.list_sources("XNYS");
      expect(xnysSources).toHaveLength(2);
      for (const s of xnysSources) {
        expect(s.mic).toBe("XNYS");
      }

      const xchiSources = registry.list_sources("XCHI");
      expect(xchiSources).toHaveLength(1);
      expect(xchiSources[0].mic).toBe("XCHI");

      const nonexistent = registry.list_sources("XXXX");
      expect(nonexistent).toEqual([]);
    });
  });

  describe("is_approved", () => {
    it("returns false for an unknown location", () => {
      expect(registry.is_approved("file://data/unknown.csv")).toBe(false);
    });

    it("returns true for an approved location", () => {
      registry.approve_source("XNYS", "file://data/xnys.csv", "alice");
      expect(registry.is_approved("file://data/xnys.csv")).toBe(true);
    });

    it("returns false for a location that differs from the approved one", () => {
      registry.approve_source("XNYS", "file://data/xnys.csv", "alice");
      expect(registry.is_approved("file://data/xnys2.csv")).toBe(false);
    });

    it("returns true for a location approved by a different approver", () => {
      registry.approve_source("XNYS", "file://data/xnys.csv", "alice");
      registry.approve_source("XCHI", "file://data/xnys.csv", "bob");

      expect(registry.is_approved("file://data/xnys.csv")).toBe(true);
    });
  });

  describe("seam test: approve -> list -> is_approved round-trip", () => {
    it("approve a source, verify it appears in list, verify is_approved returns true for it and false for unknown", () => {
      // Approve
      const result = registry.approve_source(
        "XNYS",
        "file://data/xnys.csv",
        "operator",
        "test approval"
      );
      expect(result.id).toBeGreaterThan(0);

      // Verify in list
      const sources = registry.list_sources();
      expect(sources).toHaveLength(1);
      expect(sources[0].mic).toBe("XNYS");
      expect(sources[0].location).toBe("file://data/xnys.csv");
      expect(sources[0].approver).toBe("operator");
      expect(sources[0].terms_note).toBe("test approval");

      // Verify is_approved
      expect(registry.is_approved("file://data/xnys.csv")).toBe(true);
      expect(registry.is_approved("file://data/unknown.csv")).toBe(false);
    });
  });
});
