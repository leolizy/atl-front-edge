import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register all MCP prompts on the given server.
 *
 * Prompts:
 *   - identify_instrument   — multi-strategy instrument resolution guide
 *   - what_changed_recently — ingest freshness → recent changes → change detail
 */
export function registerPrompts(server: McpServer): void {
  // ── identify_instrument ──────────────────────────────────────────────────

  server.registerPrompt(
    "identify_instrument",
    {
      title: "Identify an Instrument",
      description:
        "Guide for resolving an instrument identity through multiple strategies: try ISIN first, then venue symbol + MIC, then free-text search. Explains how to read the response (confidence, alternatives, provenance) and suggests follow-up queries (changes, dictionary lookups).",
    },
    async () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "You are identifying a financial instrument. Follow this multi-strategy workflow:",
                "",
                "## Step 1 — Determine the query type",
                "",
                "If you have an identifier, map it to a `query_type`:",
                "- 12-character alphanumeric string → `isin`",
                "- 4-8 character alphanumeric (starts with 'G' or 'B') → `figi`",
                "- 9-character alphanumeric → `cusip`",
                "- 7-character alphanumeric → `sedol`",
                "- Format `MIC:SYMBOL` (e.g., `XNYS:MSFT`) → `venue_symbol`",
                "- Everything else → `free_text`",
                "",
                "## Step 2 — Call resolve_instrument",
                "",
                "Call the `resolve_instrument` tool with the query and the appropriate `query_type`.",
                'Example: `resolve_instrument({ query: "US0378331005", query_type: "isin" })`',
                'Example: `resolve_instrument({ query: "XNYS:MSFT", query_type: "venue_symbol" })`',
                'Example: `resolve_instrument({ query: "Microsoft", query_type: "free_text" })`',
                "",
                "## Step 3 — Read the response",
                "",
                "The response contains:",
                "- **match**: the top result with the instrument's full CDM record (mic, venue_symbol, asset_class, currency, status, provenance, etc.) and a **confidence** score between 0.0–1.0.",
                "  - 1.0 = exact match by ISIN/FIGI/CUSIP/SEDOL or MIC:symbol.",
                "  - 0.55–0.95 = fuzzy free-text match on venue_symbol.",
                "  - 0.3 = partial identifier match (suggestion).",
                "- **alternatives**: other matching instruments (for free-text search), each with its own confidence score. Always present alternatives to the user when confidence < 1.0.",
                "- **suggestions**: instruments found via partial identifier match when no direct match exists.",
                "- **provenance**: source name, source location, approver, ingest run ID, and recorded-at timestamp — use this to assess data trustworthiness.",
                "",
                "If no match is found, the response will contain `match: null` and possibly `suggestions`. Try a broader free-text search or check with `search_dictionary` for alias expansion.",
                "",
                "## Step 4 — Follow-up queries",
                "",
                "Once you have a confirmed instrument:",
                "- Use `get_instrument({ mic, symbol })` to retrieve the full CDM record with provenance.",
                "- Use the `instrument://{mic}/{symbol}` resource to get the raw CDM JSON document. Add `?as_of=YYYY-MM-DD` for a historical version.",
                "- Use `lookup_term({ term })` to expand any unfamiliar field names via the dictionary (aliases, CDM types, extensions, lineage).",
                "- Use `list_changes({ venue })` to see the change history for that instrument's venue.",
                "- Use `search_dictionary({ query })` to explore related terms when the instrument has unusual attributes.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  // ── what_changed_recently ────────────────────────────────────────────────

  server.registerPrompt(
    "what_changed_recently",
    {
      title: "What Changed Recently",
      description:
        "Guide for checking data freshness and recent changes: start by checking ingest status per venue, then list recent changes, then drill into a specific change for full before/after CDM snapshots.",
    },
    async () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "You are investigating what changed recently in the instrument data pool. Follow this workflow:",
                "",
                "## Step 1 — Check ingest freshness",
                "",
                "Call `get_ingest_status()` to see the state of every venue:",
                "- **last_success_at**: when data was last successfully ingested.",
                '- **freshness**: human-readable estimate (e.g., "recent", "3h ago", "2d ago", "never ingested").',
                "- **last_outcome**: success, failure, or partial.",
                "- **record counts**: total, added, updated, delisted, quarantined — for the most recent run.",
                "- **last_ingest_run_id**: the run ID you can use to filter changes later.",
                "",
                'If a venue shows `freshness: "never ingested"`, skip it — there are no changes to inspect.',
                "If freshness is stale (more than 24h), alert the user that data may be out of date.",
                "",
                'Optionally filter to a single venue: `get_ingest_status({ venue: "XNYS" })`.',
                "",
                "## Step 2 — List recent changes",
                "",
                "Call `list_changes()` to see recent instrument changes across all venues. Refine with filters:",
                '- `venue`: MIC code (e.g., `"XNYS"`)',
                '- `date_from` / `date_to`: ISO 8601 range (e.g., `"2026-07-01T00:00:00Z"`)',
                '- `change_type`: `"add"`, `"update"`, or `"delist"`',
                "- `limit` / `offset`: pagination (default 100, max 500)",
                "",
                "The response includes `changes[]` (each with id, instrument_id, change_type, before_hash, after_hash, changed_at, venue, mic, venue_symbol) and a `total` count.",
                "",
                "## Step 3 — Inspect a specific change",
                "",
                "Pick a change ID from step 2 and call `get_change({ change_id })` to see:",
                "- **before_cdm_json** / **after_cdm_json**: the full CDM document snapshots before and after the change.",
                "- **current_cdm_json**: the instrument's current CDM document (may differ from after_cdm_json if further changes occurred).",
                "- **ingest metadata**: venue, window_start, window_end, outcome, run started/completed timestamps.",
                "- **instrument identity**: mic, venue_symbol, asset_class, currency, content hash.",
                "",
                "Compare before/after CDM snapshots to understand exactly what changed in the instrument record.",
                "",
                "## Step 4 — Follow-up",
                "",
                "After inspecting changes:",
                '- Use `search_instruments({ mic, status: "delisted" })` to find all delisted instruments on a venue.',
                "- Use `get_instrument({ mic, symbol })` to retrieve the latest version of an affected instrument.",
                "- Use `list_sources()` to check which data sources feed the venue.",
                "- Cross-reference `get_change` timestamps with `get_ingest_status` run times to confirm the ingest run that introduced the change.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );
}
