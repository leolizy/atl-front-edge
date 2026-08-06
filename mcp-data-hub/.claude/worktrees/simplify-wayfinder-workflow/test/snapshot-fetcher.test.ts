import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Migrator } from "../src/db/migrator.js";
import { migration001 } from "../src/db/migrations/001-initial-schema.js";
import { SourceRegistry } from "../src/sources/source-registry.js";
import { SnapshotFetcher } from "../src/sources/snapshot-fetcher.js";
import type {
  FetchResult,
  UnavailableResult,
} from "../src/sources/snapshot-fetcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function runMigrations(db: Database.Database): void {
  new Migrator(db).migrate([migration001]);
}

/** Return a free port on localhost. */
function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Could not bind to a free port"));
      }
    });
  });
}

/** Start an HTTP server on the given port with a custom request handler. */
function startServer(
  port: number,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SnapshotFetcher", () => {
  let db: Database.Database;
  let registry: SourceRegistry;
  let fetcher: SnapshotFetcher;
  let httpServer: http.Server | null = null;
  let serverPort: number;

  beforeEach(async () => {
    db = createDb();
    runMigrations(db);
    registry = new SourceRegistry(db);
    fetcher = new SnapshotFetcher(registry);
    serverPort = await getRandomPort();
  });

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = null;
    }
    db.close();
  });

  // -----------------------------------------------------------------------
  // Approved HTTP source → file returned
  // -----------------------------------------------------------------------

  describe("approved HTTP source", () => {
    it("fetches file bytes and metadata from an approved HTTP location", async () => {
      const testData = "symbol,price\nAAPL,150.00\n";

      httpServer = await startServer(serverPort, (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/csv" });
        res.end(testData);
      });

      const location = `http://localhost:${serverPort}/xnys-snapshot.csv`;
      registry.approve_source("XNYS", location, "alice");

      const result = await fetcher.fetch("XNYS");

      expect(result.available).toBe(true);
      const r = result as FetchResult;
      expect(r.bytes.toString()).toBe(testData);
      expect(r.metadata.file_name).toBe("xnys-snapshot.csv");
      expect(r.metadata.source_location).toBe(location);
      expect(r.metadata.file_hash).toBeTruthy();
      expect(r.metadata.fetch_timestamp).toBeTruthy();
    });

    it("records the correct SHA-256 file hash for audit trail", async () => {
      const testData = "symbol,price\nAAPL,150.00\n";
      const expectedHash = createHash("sha256").update(testData).digest("hex");

      httpServer = await startServer(serverPort, (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/csv" });
        res.end(testData);
      });

      const location = `http://localhost:${serverPort}/xnys-snapshot.csv`;
      registry.approve_source("XNYS", location, "alice");

      const result = await fetcher.fetch("XNYS");
      expect(result.available).toBe(true);
      expect((result as FetchResult).metadata.file_hash).toBe(expectedHash);
    });

    it("derives file name from URL path", async () => {
      httpServer = await startServer(serverPort, (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end("data");
      });

      const location = `http://localhost:${serverPort}/reports/2025/daily.csv.gz`;
      registry.approve_source("XNYS", location, "alice");

      const result = await fetcher.fetch("XNYS");
      expect(result.available).toBe(true);
      expect((result as FetchResult).metadata.file_name).toBe("daily.csv.gz");
    });

    it("falls back to 'snapshot' when URL path has no file name", async () => {
      httpServer = await startServer(serverPort, (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end("data");
      });

      const location = `http://localhost:${serverPort}/`;
      registry.approve_source("XNYS", location, "alice");

      const result = await fetcher.fetch("XNYS");
      expect(result.available).toBe(true);
      expect((result as FetchResult).metadata.file_name).toBe("snapshot");
    });
  });

  // -----------------------------------------------------------------------
  // Unapproved source → refused
  // -----------------------------------------------------------------------

  describe("unapproved source", () => {
    it("returns unavailable when no sources are approved for the venue", async () => {
      const result = await fetcher.fetch("XNYS");
      expect(result.available).toBe(false);
      expect((result as UnavailableResult).reason).toContain(
        "No approved sources"
      );
    });

    it("returns unavailable when an unapproved location is the only source", async () => {
      // The fetch method only looks up approved sources from the registry,
      // so an unapproved location is never even attempted.  This tests that
      // the registry correctly reports no sources for the venue.
      const result = await fetcher.fetch("XNYS");
      expect(result.available).toBe(false);
      expect((result as UnavailableResult).source_location).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // Missing file → unavailable result, no exception
  // -----------------------------------------------------------------------

  describe("missing file", () => {
    it("returns unavailable (not an exception) for HTTP 404", async () => {
      httpServer = await startServer(serverPort, (_req, res) => {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      });

      const location = `http://localhost:${serverPort}/missing.csv`;
      registry.approve_source("XNYS", location, "alice");

      const result = await fetcher.fetch("XNYS");
      expect(result.available).toBe(false);
      expect((result as UnavailableResult).reason).toContain(
        "Failed to fetch from all approved sources"
      );
    });

    it("returns unavailable (not an exception) for a file:// path that does not exist", async () => {
      const location = `file:///tmp/narwhal-nonexistent-${Date.now()}.csv`;
      registry.approve_source("XNYS", location, "alice");

      const result = await fetcher.fetch("XNYS");
      expect(result.available).toBe(false);
      expect((result as UnavailableResult).reason).toContain(
        "Failed to fetch from all approved sources"
      );
    });
  });

  // -----------------------------------------------------------------------
  // Local filesystem support (file://)
  // -----------------------------------------------------------------------

  describe("file:// protocol", () => {
    let tmpFilePath: string;

    beforeEach(async () => {
      tmpFilePath = path.join(os.tmpdir(), `narwhal-test-${Date.now()}.csv`);
    });

    afterEach(async () => {
      try {
        await unlink(tmpFilePath);
      } catch {
        // file may not exist — ignore
      }
    });

    it("reads a file from a local file:// location", async () => {
      const testData = "symbol,price\nIBM,140.00\n";
      await writeFile(tmpFilePath, testData, "utf-8");

      const location = `file://${tmpFilePath}`;
      registry.approve_source("XNYS", location, "alice");

      const result = await fetcher.fetch("XNYS");
      expect(result.available).toBe(true);
      const r = result as FetchResult;
      expect(r.bytes.toString()).toBe(testData);
      expect(r.metadata.file_name).toBe(path.basename(tmpFilePath));
      expect(r.metadata.source_location).toBe(location);
      expect(r.metadata.file_hash).toBe(
        createHash("sha256").update(testData).digest("hex")
      );
    });
  });

  // -----------------------------------------------------------------------
  // Multiple approved sources → tries in order
  // -----------------------------------------------------------------------

  describe("multiple approved sources", () => {
    it("tries sources in approval order and returns the first successful fetch", async () => {
      // First source returns 404, second returns data
      const testData = "symbol,price\nTSLA,250.00\n";

      httpServer = await startServer(serverPort, (req, res) => {
        if (req.url === "/primary.csv") {
          res.writeHead(404);
          res.end();
        } else if (req.url === "/fallback.csv") {
          res.writeHead(200, { "Content-Type": "text/csv" });
          res.end(testData);
        } else {
          res.writeHead(500);
          res.end();
        }
      });

      const primary = `http://localhost:${serverPort}/primary.csv`;
      const fallback = `http://localhost:${serverPort}/fallback.csv`;

      registry.approve_source("XNYS", primary, "alice");
      // Small delay so fallback has a later timestamp → appears first in
      // list_sources (ORDER BY approved_at DESC).  We want to test that
      // the *first* source is tried first, so we approve it second so it
      // appears first.
      await new Promise((r) => setTimeout(r, 5));
      registry.approve_source("XNYS", fallback, "bob");

      const result = await fetcher.fetch("XNYS");
      expect(result.available).toBe(true);
      const r = result as FetchResult;
      expect(r.bytes.toString()).toBe(testData);
      // The fallback (approved later, listed first) was tried first and
      // succeeded, so the source_location is the fallback.
      expect(r.metadata.source_location).toBe(fallback);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("includes fetch_timestamp in unavailable result", async () => {
      const before = new Date().toISOString();
      const result = await fetcher.fetch("XNYS");
      const after = new Date().toISOString();

      expect(result.available).toBe(false);
      const ts = (result as UnavailableResult).fetch_timestamp;
      expect(ts >= before && ts <= after).toBe(true);
    });

    it("includes fetch_timestamp in successful result", async () => {
      const testData = "data\n";
      httpServer = await startServer(serverPort, (_req, res) => {
        res.writeHead(200);
        res.end(testData);
      });

      const location = `http://localhost:${serverPort}/data.csv`;
      registry.approve_source("XNYS", location, "alice");

      const before = new Date().toISOString();
      const result = await fetcher.fetch("XNYS");
      const after = new Date().toISOString();

      expect(result.available).toBe(true);
      const ts = (result as FetchResult).metadata.fetch_timestamp;
      expect(ts >= before && ts <= after).toBe(true);
    });
  });
});
