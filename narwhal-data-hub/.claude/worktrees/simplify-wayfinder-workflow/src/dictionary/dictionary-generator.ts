import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolStore } from "../db/pool-store.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface DictEntry {
  match: string; // canonical term used for key lookup
  layer: "cdm" | "ext" | "lineage" | "alias";
  definition: string;
  see_also: string[];
  uri: string;
}

export interface SearchResult {
  results: DictEntry[];
  total: number;
}

// ── Internal JSON shapes ──────────────────────────────────────────────────────

interface CdmTypesFile {
  cdm_version: string;
  types: { name: string; definition: string; see_also: string[] }[];
}

interface ExtensionsFile {
  extensions_version: string;
  fields: { name: string; description: string; see_also?: string[] }[];
}

interface StockProfileFile {
  required_fields: {
    cdm_path: string;
    source?: string;
    value?: string;
    scheme?: string;
  }[];
}

// ── Generator ─────────────────────────────────────────────────────────────────

/**
 * Generates a four-layer dictionary from single sources of truth:
 *   1. CDM type definitions   (config/cdm-types.json)
 *   2. Extension definitions   (config/extensions.json)
 *   3. Source→CDM lineage      (derived from config/stock-profile.json)
 *   4. Synonym aliases         (aliases table in SQLite)
 */
export class DictionaryGenerator {
  private cdmEntries: DictEntry[] = [];
  private extEntries: DictEntry[] = [];
  /** Lineage entries keyed by source field name — used for lookup_term & search. */
  private lineageBySource: Map<string, DictEntry> = new Map();
  /** Lineage entries grouped by CDM path — used for dict://lineage resources. */
  private lineageByCdmPath: Map<string, DictEntry[]> = new Map();
  /** In-memory alias cache: lowercased term → canonical_field. */
  private aliasCache: Map<string, { canonical_field: string }> = new Map();

  constructor(private store: PoolStore) {}

  // ── Regeneration ──────────────────────────────────────────────────────────

  /**
   * Reload the entire dictionary from all four layers.
   * Call at startup and whenever the underlying sources change.
   */
  regenerate(): void {
    const configDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "config"
    );

    // Layer 1 — CDM types
    const cdmRaw: CdmTypesFile = JSON.parse(
      readFileSync(resolve(configDir, "cdm-types.json"), "utf-8")
    );
    this.cdmEntries = cdmRaw.types.map((t) => ({
      match: t.name,
      layer: "cdm" as const,
      definition: t.definition,
      see_also: t.see_also,
      uri: `dict://cdm/${encodeURIComponent(t.name)}`,
    }));

    // Layer 2 — Extensions
    const extRaw: ExtensionsFile = JSON.parse(
      readFileSync(resolve(configDir, "extensions.json"), "utf-8")
    );
    this.extEntries = extRaw.fields.map((f) => ({
      match: f.name,
      layer: "ext" as const,
      definition: f.description,
      see_also: f.see_also ?? [],
      uri: `dict://ext/${encodeURIComponent(f.name)}`,
    }));

    // Layer 3 — Source→CDM lineage (from stock profile)
    const profile: StockProfileFile = JSON.parse(
      readFileSync(resolve(configDir, "stock-profile.json"), "utf-8")
    );
    this.lineageBySource.clear();
    this.lineageByCdmPath.clear();

    for (const field of profile.required_fields) {
      if (!field.source) continue; // skip literal-value fields

      const schemeNote = field.scheme ? ` with scheme '${field.scheme}'` : "";
      const entry: DictEntry = {
        match: field.source,
        layer: "lineage",
        definition: `Source field '${field.source}' maps to CDM path '${field.cdm_path}'${schemeNote}.`,
        see_also: [],
        uri: `dict://lineage/${encodeURIComponent(field.cdm_path)}`,
      };

      this.lineageBySource.set(field.source.toLowerCase(), entry);

      const existing = this.lineageByCdmPath.get(field.cdm_path) ?? [];
      existing.push(entry);
      this.lineageByCdmPath.set(field.cdm_path, existing);
    }

    // Layer 4 — Aliases
    this.loadAliases();
  }

  // ── Aliases ───────────────────────────────────────────────────────────────

  private loadAliases(): void {
    this.aliasCache.clear();
    const rows = this.store.db
      .prepare("SELECT term, canonical_field FROM aliases")
      .all() as { term: string; canonical_field: string }[];
    for (const row of rows) {
      this.aliasCache.set(row.term.toLowerCase(), {
        canonical_field: row.canonical_field,
      });
    }
  }

  /**
   * Insert seed aliases if the aliases table is empty.
   * Idempotent — safe to call every startup.
   */
  seedAliases(): void {
    const cnt = (
      this.store.db.prepare("SELECT COUNT(*) as cnt FROM aliases").get() as {
        cnt: number;
      }
    ).cnt;
    if (cnt > 0) return;

    const now = new Date().toISOString();
    const insert = this.store.db.prepare(
      "INSERT INTO aliases (term, canonical_field, layer, created_at) VALUES (?, ?, 'alias', ?)"
    );
    const seeds: [string, string][] = [
      ["ticker", "venue_symbol"],
      ["board lot", "board_lot"],
      ["exchange", "mic"],
      ["name", "instrument_name"],
      ["sedol", "SEDOL"],
      ["cusip", "CUSIP"],
      ["figi", "FIGI"],
      ["isin", "ISIN"],
      ["symbol", "venue_symbol"],
      ["round lot", "board_lot"],
      ["trading currency", "currency"],
      ["mic code", "mic"],
    ];

    const tx = this.store.db.transaction(() => {
      for (const [term, canonicalField] of seeds) {
        insert.run(term, canonicalField, now);
      }
    });
    tx();
    this.loadAliases();
  }

  /**
   * Add a new alias at runtime (e.g. from tool/API call).
   */
  addAlias(term: string, canonicalField: string): void {
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT OR REPLACE INTO aliases (term, canonical_field, layer, created_at) VALUES (?, ?, 'alias', ?)"
      )
      .run(term, canonicalField, now);
    this.aliasCache.set(term.toLowerCase(), {
      canonical_field: canonicalField,
    });
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  /**
   * Exact-match lookup across all four layers.
   *
   * Resolution order:
   *   1. Aliases → resolve to canonical field
   *   2. CDM types
   *   3. Extensions
   *   4. Lineage (source field)
   */
  lookupTerm(term: string): DictEntry | null {
    const normalized = term.toLowerCase().trim();
    if (!normalized) return null;

    // Step 1 — Alias expansion
    const alias = this.aliasCache.get(normalized);
    if (alias) {
      const resolved = this.lookupCanonical(alias.canonical_field);
      if (resolved) return resolved;

      // The alias resolves to a field not yet defined in CDM/ext/lineage —
      // return the alias itself as a dict entry.
      return {
        match: alias.canonical_field,
        layer: "alias",
        definition: `Alias '${term}' resolves to canonical field '${alias.canonical_field}'.`,
        see_also: [],
        uri: `dict://alias/${encodeURIComponent(term)}`,
      };
    }

    // Step 2 — CDM types
    const cdm = this.cdmEntries.find(
      (e) => e.match.toLowerCase() === normalized
    );
    if (cdm) return cdm;

    // Step 3 — Extensions
    const ext = this.extEntries.find(
      (e) => e.match.toLowerCase() === normalized
    );
    if (ext) return ext;

    // Step 4 — Lineage (source field)
    const lin = this.lineageBySource.get(normalized);
    if (lin) return lin;

    return null;
  }

  /**
   * Locate an entry by canonical field name across CDM, extension, and lineage layers.
   */
  private lookupCanonical(field: string): DictEntry | null {
    const normalized = field.toLowerCase();

    const cdm = this.cdmEntries.find(
      (e) => e.match.toLowerCase() === normalized
    );
    if (cdm) return cdm;

    const ext = this.extEntries.find(
      (e) => e.match.toLowerCase() === normalized
    );
    if (ext) return ext;

    const lin = this.lineageBySource.get(normalized);
    if (lin) return lin;

    return null;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Free-text search across all four dictionary layers.
   * Case-insensitive substring match on both term and definition.
   */
  searchDictionary(query: string): SearchResult {
    const q = query.toLowerCase().trim();
    if (!q) return { results: [], total: 0 };

    const all: DictEntry[] = [
      ...this.cdmEntries,
      ...this.extEntries,
      ...this.lineageBySource.values(),
    ];

    // Also include alias entries for search transparency
    for (const [term, info] of this.aliasCache) {
      all.push({
        match: term,
        layer: "alias" as const,
        definition: `Alias for canonical field '${info.canonical_field}'.`,
        see_also: [info.canonical_field],
        uri: `dict://alias/${encodeURIComponent(term)}`,
      });
    }

    const results = all.filter(
      (e) =>
        e.match.toLowerCase().includes(q) ||
        e.definition.toLowerCase().includes(q)
    );

    return { results, total: results.length };
  }

  // ── Resource accessors (by URI path component) ────────────────────────────

  getCdmType(name: string): DictEntry | null {
    return (
      this.cdmEntries.find(
        (e) => e.match.toLowerCase() === name.toLowerCase()
      ) ?? null
    );
  }

  getExtension(name: string): DictEntry | null {
    return (
      this.extEntries.find(
        (e) => e.match.toLowerCase() === name.toLowerCase()
      ) ?? null
    );
  }

  getAlias(term: string): DictEntry | null {
    const normalized = term.toLowerCase().trim();
    const info = this.aliasCache.get(normalized);
    if (!info) return null;
    return {
      match: term,
      layer: "alias",
      definition: `Alias '${term}' resolves to canonical field '${info.canonical_field}'.`,
      see_also: [info.canonical_field],
      uri: `dict://alias/${encodeURIComponent(term)}`,
    };
  }

  /**
   * Return all lineage entries for a given CDM path.
   * Multiple source fields can map to the same CDM path (e.g. multiple
   * identifiers all map to `instrument.identifiers[]`).
   */
  getLineage(cdmPath: string): DictEntry[] {
    return this.lineageByCdmPath.get(cdmPath) ?? [];
  }
}
