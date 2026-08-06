import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InstrumentRow {
  id: number;
  mic: string;
  venue_symbol: string;
  asset_class: string;
  currency: string;
  cdm_json: string;
  content_hash: string;
  effective_from: string;
  effective_to: string | null;
  recorded_from: string;
  recorded_to: string | null;
  source_id: number | null;
  ingest_run_id: number | null;
  source_location?: string | null;
}

interface InstrumentResult {
  id: number;
  mic: string;
  venue_symbol: string;
  asset_class: string;
  currency: string;
  cdm_json: string;
  content_hash: string;
  effective_from: string;
  effective_to: string | null;
  status: string;
  provenance: {
    source: string | null;
    ingest_run: number | null;
    recorded_at: string;
  };
}

interface QueryResult {
  instrument: InstrumentResult;
  confidence: number;
  identifiers: IdentifierInfo[];
}

interface IdentifierInfo {
  type: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveStatus(
  effectiveFrom: string,
  effectiveTo: string | null,
  asOf: string
): string {
  if (effectiveFrom > asOf) return "announced";
  if (effectiveTo !== null && effectiveTo <= asOf) return "delisted";
  return "active";
}

function toInstrumentResult(
  row: InstrumentRow,
  asOf: string,
  identifiers: IdentifierInfo[]
): InstrumentResult {
  return {
    id: row.id,
    mic: row.mic,
    venue_symbol: row.venue_symbol,
    asset_class: row.asset_class,
    currency: row.currency,
    cdm_json: row.cdm_json,
    content_hash: row.content_hash,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    status: deriveStatus(row.effective_from, row.effective_to, asOf),
    provenance: {
      source: row.source_location ?? null,
      ingest_run: row.ingest_run_id,
      recorded_at: row.recorded_from,
    },
  };
}

function getIdentifiers(
  db: Database.Database,
  instrumentId: number
): IdentifierInfo[] {
  const rows = db
    .prepare("SELECT type, value FROM identifiers WHERE instrument_id = ?")
    .all(instrumentId) as { type: string; value: string }[];
  return rows.map((r) => ({ type: r.type, value: r.value }));
}

/**
 * Score a venue_symbol against a free-text query.
 * Returns a number between 0.0 and 1.0, or 0 if no match.
 */
function fuzzyScore(symbol: string, query: string): number {
  const sym = symbol;
  const q = query;
  const symLower = sym.toLowerCase();
  const qLower = q.toLowerCase();

  if (sym === q) return 1.0;
  if (symLower === qLower) return 0.95;
  if (symLower.startsWith(qLower)) return 0.85;
  if (qLower.length >= 3 && symLower.includes(qLower)) return 0.7;
  if (qLower.length < 3 && symLower.includes(qLower)) return 0.55;
  return 0;
}

// ---------------------------------------------------------------------------
// Query implementations
// ---------------------------------------------------------------------------

const BASE_QUERY = `
  SELECT i.*, s.location AS source_location
  FROM instruments i
  LEFT JOIN sources s ON i.source_id = s.id
  WHERE i.recorded_to IS NULL
    AND (i.effective_to IS NULL OR i.effective_to > @asOf)
`;

function resolveByIsin(
  db: Database.Database,
  query: string,
  asOf: string
): QueryResult | null {
  const row = db
    .prepare(
      `SELECT i.*, s.location AS source_location
       FROM identifiers id
       JOIN instruments i ON id.instrument_id = i.id
       LEFT JOIN sources s ON i.source_id = s.id
       WHERE id.type = 'ISIN'
         AND id.value = @query
         AND i.recorded_to IS NULL
         AND (i.effective_to IS NULL OR i.effective_to > @asOf)`
    )
    .get({ query, asOf }) as InstrumentRow | undefined;

  if (!row) return null;

  const identifiers = getIdentifiers(db, row.id);
  return {
    instrument: toInstrumentResult(row, asOf, identifiers),
    confidence: 1.0,
    identifiers,
  };
}

function resolveByVenueSymbol(
  db: Database.Database,
  query: string,
  asOf: string
): QueryResult | null {
  // query format: "MIC:SYMBOL"
  const colonIdx = query.indexOf(":");
  if (colonIdx === -1) return null;

  const mic = query.slice(0, colonIdx).toUpperCase();
  const symbol = query.slice(colonIdx + 1);

  const row = db
    .prepare(
      `SELECT i.*, s.location AS source_location
       FROM instruments i
       LEFT JOIN sources s ON i.source_id = s.id
       WHERE i.mic = @mic
         AND i.venue_symbol = @symbol
         AND i.recorded_to IS NULL
         AND (i.effective_to IS NULL OR i.effective_to > @asOf)`
    )
    .get({ mic, symbol, asOf }) as InstrumentRow | undefined;

  if (!row) return null;

  const identifiers = getIdentifiers(db, row.id);
  return {
    instrument: toInstrumentResult(row, asOf, identifiers),
    confidence: 1.0,
    identifiers,
  };
}

function resolveByIdentifier(
  db: Database.Database,
  idType: string,
  value: string,
  asOf: string
): QueryResult | null {
  const row = db
    .prepare(
      `SELECT i.*, s.location AS source_location
       FROM identifiers id
       JOIN instruments i ON id.instrument_id = i.id
       LEFT JOIN sources s ON i.source_id = s.id
       WHERE id.type = @idType
         AND id.value = @value
         AND i.recorded_to IS NULL
         AND (i.effective_to IS NULL OR i.effective_to > @asOf)`
    )
    .get({ idType, value, asOf }) as InstrumentRow | undefined;

  if (!row) return null;

  const identifiers = getIdentifiers(db, row.id);
  return {
    instrument: toInstrumentResult(row, asOf, identifiers),
    confidence: 1.0,
    identifiers,
  };
}

function freeTextSearch(
  db: Database.Database,
  query: string,
  asOf: string
): { matches: QueryResult[]; suggestions: QueryResult[] } {
  // Fetch all active instruments for the given as_of date
  const rows = db
    .prepare(
      `SELECT i.*, s.location AS source_location
       FROM instruments i
       LEFT JOIN sources s ON i.source_id = s.id
       WHERE i.recorded_to IS NULL
         AND (i.effective_to IS NULL OR i.effective_to > @asOf)`
    )
    .all({ asOf }) as InstrumentRow[];

  // Score each row against the query
  const scored: { row: InstrumentRow; score: number }[] = [];
  for (const row of rows) {
    const score = fuzzyScore(row.venue_symbol, query);
    if (score > 0) {
      scored.push({ row, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const results: QueryResult[] = scored.map((s) => {
    const identifiers = getIdentifiers(db, s.row.id);
    return {
      instrument: toInstrumentResult(s.row, asOf, identifiers),
      confidence: s.score,
      identifiers,
    };
  });

  // If no direct matches, try identifier-based suggestions
  if (results.length === 0) {
    const suggestions = findSuggestionsByIdentifier(db, query, asOf);
    return { matches: [], suggestions };
  }

  return { matches: results, suggestions: [] };
}

function findSuggestionsByIdentifier(
  db: Database.Database,
  query: string,
  asOf: string
): QueryResult[] {
  // Try partial match on identifier values
  const rows = db
    .prepare(
      `SELECT DISTINCT i.*, s.location AS source_location
       FROM identifiers id
       JOIN instruments i ON id.instrument_id = i.id
       LEFT JOIN sources s ON i.source_id = s.id
       WHERE id.value LIKE @likeQuery
         AND i.recorded_to IS NULL
         AND (i.effective_to IS NULL OR i.effective_to > @asOf)
       LIMIT 5`
    )
    .all({ likeQuery: `%${query}%`, asOf }) as InstrumentRow[];

  return rows.map((row) => {
    const identifiers = getIdentifiers(db, row.id);
    return {
      instrument: toInstrumentResult(row, asOf, identifiers),
      confidence: 0.3,
      identifiers,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the `resolve_instrument` MCP tool on the given server.
 *
 * The tool resolves an instrument by ISIN, FIGI, CUSIP, SEDOL, venue symbol
 * + MIC, or free-text search. Returns the canonical CDM record with a
 * confidence score, alternatives, and provenance.
 */
export function registerResolveInstrumentTool(
  server: McpServer,
  db: Database.Database
): void {
  server.registerTool(
    "resolve_instrument",
    {
      description:
        "Resolve an instrument by ISIN, FIGI, CUSIP, SEDOL, venue symbol + MIC (format: MIC:symbol), or free-text search. Returns the canonical CDM record with confidence score, alternatives, and provenance.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "The search query — ISIN, FIGI, CUSIP, SEDOL, MIC:symbol, or free-text"
          ),
        query_type: z
          .enum(["isin", "venue_symbol", "figi", "cusip", "sedol", "free_text"])
          .optional()
          .default("free_text")
          .describe(
            "Type of query: isin, venue_symbol, figi, cusip, sedol, or free_text (default)"
          ),
        as_of: z
          .string()
          .optional()
          .describe(
            "Business date in YYYY-MM-DD format for historical queries. Defaults to today."
          ),
      },
    },
    async ({ query, query_type, as_of }) => {
      const effectiveAsOf = as_of ?? new Date().toISOString().slice(0, 10);

      let result: QueryResult | null = null;
      let alternatives: QueryResult[] = [];
      let suggestions: QueryResult[] = [];

      switch (query_type) {
        case "isin":
          result = resolveByIsin(db, query, effectiveAsOf);
          break;
        case "venue_symbol":
          result = resolveByVenueSymbol(db, query, effectiveAsOf);
          break;
        case "figi":
          result = resolveByIdentifier(db, "FIGI", query, effectiveAsOf);
          break;
        case "cusip":
          result = resolveByIdentifier(db, "CUSIP", query, effectiveAsOf);
          break;
        case "sedol":
          result = resolveByIdentifier(db, "SEDOL", query, effectiveAsOf);
          break;
        case "free_text":
        default: {
          const { matches, suggestions: suggs } = freeTextSearch(
            db,
            query,
            effectiveAsOf
          );
          if (matches.length > 0) {
            result = matches[0];
            alternatives = matches.slice(1);
          }
          suggestions = suggs;
          break;
        }
      }

      if (result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                match: result.instrument,
                confidence: result.confidence,
                alternatives: alternatives.map((a) => ({
                  instrument: a.instrument,
                  confidence: a.confidence,
                })),
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              match: null,
              suggestions: suggestions.map((s) => ({
                instrument: s.instrument,
                confidence: s.confidence,
              })),
            }),
          },
        ],
      };
    }
  );
}
