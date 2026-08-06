import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PoolStore } from "../src/db/pool-store.js";
import { DictionaryGenerator } from "../src/dictionary/dictionary-generator.js";
import type { DictEntry } from "../src/dictionary/dictionary-generator.js";

function createStore(): PoolStore {
  const store = new PoolStore({ dbPath: ":memory:", wal: false });
  store.migrate();
  return store;
}

describe("alias management and dictionary regeneration", () => {
  let store: PoolStore;
  let dict: DictionaryGenerator;

  beforeEach(() => {
    store = createStore();
    dict = new DictionaryGenerator(store);
    dict.regenerate();
  });

  afterEach(() => {
    store.close();
  });

  // ── Seed aliases ──────────────────────────────────────────────────────────

  describe("seedAliases", () => {
    it("inserts all seed aliases into the DB and cache", () => {
      dict.seedAliases();

      // Verify DB row count
      const row = store.db
        .prepare("SELECT COUNT(*) as cnt FROM aliases")
        .get() as { cnt: number };
      expect(row.cnt).toBe(12);
    });

    it("is idempotent — calling twice produces the same alias count", () => {
      dict.seedAliases();
      dict.seedAliases();

      const row = store.db
        .prepare("SELECT COUNT(*) as cnt FROM aliases")
        .get() as { cnt: number };
      expect(row.cnt).toBe(12);
    });
  });

  // ── Seed aliases resolve correctly ────────────────────────────────────────

  describe("seed alias resolution", () => {
    beforeEach(() => {
      dict.seedAliases();
    });

    it('resolves "ticker" → venue_symbol (extension)', () => {
      const result = dict.lookupTerm("ticker");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("venue_symbol");
      expect(result!.layer).toBe("ext");
    });

    it('resolves "board lot" → board_lot (extension)', () => {
      const result = dict.lookupTerm("board lot");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("board_lot");
      expect(result!.layer).toBe("ext");
    });

    it('resolves "exchange" → mic (extension)', () => {
      const result = dict.lookupTerm("exchange");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("mic");
      expect(result!.layer).toBe("ext");
    });

    it('resolves "name" → instrument_name (extension)', () => {
      const result = dict.lookupTerm("name");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("instrument_name");
      expect(result!.layer).toBe("ext");
    });

    it('resolves "sedol" → SEDOL (lineage)', () => {
      const result = dict.lookupTerm("sedol");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("sedol");
      expect(result!.layer).toBe("lineage");
      expect(result!.definition).toContain("SEDOL");
    });

    it('resolves "cusip" → CUSIP (lineage)', () => {
      const result = dict.lookupTerm("cusip");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("cusip");
      expect(result!.layer).toBe("lineage");
      expect(result!.definition).toContain("CUSIP");
    });

    it('resolves "figi" → FIGI (lineage)', () => {
      const result = dict.lookupTerm("figi");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("figi");
      expect(result!.layer).toBe("lineage");
      expect(result!.definition).toContain("FIGI");
    });

    it('resolves "isin" → isin (extension)', () => {
      const result = dict.lookupTerm("isin");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("isin");
      expect(result!.layer).toBe("ext");
      expect(result!.definition).toContain(
        "International Securities Identification Number"
      );
    });

    it('resolves "symbol" → venue_symbol (extension)', () => {
      const result = dict.lookupTerm("symbol");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("venue_symbol");
      expect(result!.layer).toBe("ext");
    });

    it('resolves "round lot" → board_lot (extension)', () => {
      const result = dict.lookupTerm("round lot");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("board_lot");
      expect(result!.layer).toBe("ext");
    });

    it('resolves "trading currency" → Currency (CDM type)', () => {
      // "currency" matches the CDM Currency type before the extension field
      const result = dict.lookupTerm("trading currency");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("Currency");
      expect(result!.layer).toBe("cdm");
    });

    it('resolves "mic code" → mic (extension)', () => {
      const result = dict.lookupTerm("mic code");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("mic");
      expect(result!.layer).toBe("ext");
    });
  });

  // ── addAlias CRUD ─────────────────────────────────────────────────────────

  describe("addAlias", () => {
    beforeEach(() => {
      dict.seedAliases();
    });

    it("adds a new alias and lookupTerm resolves it", () => {
      dict.addAlias("tick", "venue_symbol");

      const result = dict.lookupTerm("tick");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("venue_symbol");
      expect(result!.layer).toBe("ext");
    });

    it("alias persists in the DB after adding", () => {
      dict.addAlias("tick", "venue_symbol");

      const row = store.db
        .prepare("SELECT term, canonical_field FROM aliases WHERE term = ?")
        .get("tick") as { term: string; canonical_field: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.term).toBe("tick");
      expect(row!.canonical_field).toBe("venue_symbol");
    });

    it("updating an alias changes its resolution", () => {
      dict.addAlias("tick", "venue_symbol");
      // Verify first resolution
      expect(dict.lookupTerm("tick")!.match).toBe("venue_symbol");

      // Update same term to a different canonical field
      dict.addAlias("tick", "board_lot");

      const result = dict.lookupTerm("tick");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("board_lot");
      expect(result!.layer).toBe("ext");
    });

    it("case-insensitive alias lookup", () => {
      dict.addAlias("TICK", "venue_symbol");

      // Should resolve regardless of input case
      const result = dict.lookupTerm("tick");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("venue_symbol");
    });

    it("alias to a canonical field not in CDM/ext/lineage returns alias entry", () => {
      dict.addAlias("future-sym", "future_symbol");

      const result = dict.lookupTerm("future-sym");
      expect(result).not.toBeNull();
      expect(result!.layer).toBe("alias");
      expect(result!.match).toBe("future_symbol");
      expect(result!.definition).toContain("future-sym");
      expect(result!.definition).toContain("future_symbol");
    });
  });

  // ── Dictionary regeneration ───────────────────────────────────────────────

  describe("regenerate", () => {
    it("rebuilds the dictionary from DB aliases after seedAliases", () => {
      dict.seedAliases();

      // Simulate a fresh regenerate
      const dict2 = new DictionaryGenerator(store);
      dict2.regenerate();

      // All seed aliases should resolve after regenerate
      expect(dict2.lookupTerm("ticker")!.match).toBe("venue_symbol");
      expect(dict2.lookupTerm("sedol")!.match).toBe("sedol");
      expect(dict2.lookupTerm("cusip")!.match).toBe("cusip");
    });

    it("reflects alias changes after regenerate", () => {
      dict.seedAliases();

      // Add a new alias directly to the DB (bypassing addAlias)
      const now = new Date().toISOString();
      store.db
        .prepare(
          "INSERT OR REPLACE INTO aliases (term, canonical_field, layer, created_at) VALUES (?, ?, 'alias', ?)"
        )
        .run("myalias", "mic", now);

      // Regenerate so the cache picks it up
      dict.regenerate();

      const result = dict.lookupTerm("myalias");
      expect(result).not.toBeNull();
      expect(result!.match).toBe("mic");
      expect(result!.layer).toBe("ext");
    });

    it("regenerate clears stale aliases", () => {
      dict.seedAliases();

      // Add an alias in memory
      dict.addAlias("temp-alias", "mic");
      expect(dict.lookupTerm("temp-alias")).not.toBeNull();

      // Delete the alias from the DB directly
      store.db.prepare("DELETE FROM aliases WHERE term = ?").run("temp-alias");

      // Regenerate — the alias should be gone
      dict.regenerate();

      const result = dict.lookupTerm("temp-alias");
      expect(result).toBeNull();
    });

    it("regenerate does not lose CDM, extension, or lineage layers", () => {
      dict.seedAliases();
      dict.regenerate();

      // CDM type lookup still works
      expect(dict.lookupTerm("Product")).not.toBeNull();
      expect(dict.lookupTerm("Instrument")).not.toBeNull();

      // Extension field lookup still works
      expect(dict.lookupTerm("mic")).not.toBeNull();
      expect(dict.lookupTerm("board_lot")).not.toBeNull();

      // Lineage lookup still works
      expect(dict.lookupTerm("sedol")).not.toBeNull();
    });
  });

  // ── getAlias ──────────────────────────────────────────────────────────────

  describe("getAlias", () => {
    beforeEach(() => {
      dict.seedAliases();
    });

    it("returns the alias entry with correct fields", () => {
      const alias = dict.getAlias("ticker");
      expect(alias).not.toBeNull();
      expect(alias!.match).toBe("ticker");
      expect(alias!.layer).toBe("alias");
      expect(alias!.see_also).toContain("venue_symbol");
      expect(alias!.uri).toBe("dict://alias/ticker");
    });

    it("returns null for unknown alias", () => {
      expect(dict.getAlias("nonexistent")).toBeNull();
    });
  });

  // ── Search includes aliases ───────────────────────────────────────────────

  describe("search includes aliases", () => {
    beforeEach(() => {
      dict.seedAliases();
    });

    it("search_dictionary finds alias entries", () => {
      const result = dict.searchDictionary("ticker");
      expect(result.total).toBeGreaterThanOrEqual(1);

      const aliasEntry = result.results.find(
        (r) => r.layer === "alias" && r.match === "ticker"
      );
      expect(aliasEntry).toBeDefined();
      expect(aliasEntry!.see_also).toContain("venue_symbol");
    });

    it("search_dictionary finds newly added alias after regenerate", () => {
      dict.addAlias("custom-search-key", "currency");
      // Note: addAlias updates the in-memory cache, so search works immediately
      const result = dict.searchDictionary("custom-search-key");
      const aliasEntry = result.results.find(
        (r) => r.layer === "alias" && r.match === "custom-search-key"
      );
      expect(aliasEntry).toBeDefined();
      expect(aliasEntry!.see_also).toContain("currency");
    });
  });

  // ── Dictionary JSON output consistency ────────────────────────────────────

  describe("dictionary output consistency", () => {
    it("lookupTerm and getAlias/ggetCdmType/getExtension are consistent", () => {
      dict.seedAliases();

      // CDM: lookupTerm returns same match as getCdmType
      const lookupProduct = dict.lookupTerm("Product");
      const getProduct = dict.getCdmType("Product");
      expect(lookupProduct!.match).toBe(getProduct!.match);
      expect(lookupProduct!.definition).toBe(getProduct!.definition);

      // Ext: lookupTerm returns same match as getExtension
      const lookupMic = dict.lookupTerm("mic");
      const getMic = dict.getExtension("mic");
      expect(lookupMic!.match).toBe(getMic!.match);
      expect(lookupMic!.definition).toBe(getMic!.definition);

      // Alias: resolution is consistent
      const lookupTicker = dict.lookupTerm("ticker");
      const getTicker = dict.getAlias("ticker");
      // lookupTerm resolves through alias to the canonical entry
      // getAlias returns the alias record itself
      expect(getTicker!.match).toBe("ticker");
      expect(getTicker!.layer).toBe("alias");
      expect(getTicker!.see_also).toContain("venue_symbol");
      // The resolved lookup should match venue_symbol, not ticker
      expect(lookupTicker!.match).toBe("venue_symbol");
    });
  });
});
