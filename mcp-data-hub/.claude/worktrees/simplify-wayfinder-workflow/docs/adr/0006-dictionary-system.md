# ADR-0006: Four-layer dictionary with registry-driven generation

**Status:** Accepted
**Date:** 2026-08-03

## Context

Agents and operators querying the pool need to understand: what CDM types exist, what extension fields narwhal adds, where each field came from (source→CDM lineage), and what synonyms are in use ("ticker" vs "venue_symbol"). This knowledge exists across multiple artifacts — CDM Rosetta definitions, extension registry JSON, adapter-emitted lineage, and an alias table — with no unified query surface.

The dictionary must stay in sync with its sources. Manual maintenance (editing the dictionary directly) would drift from the registries. The registries are the source of truth — the dictionary must be a generated artifact.

## Decision

**Four-layer dictionary, generated from single sources of truth, regenerated on any source change.**

### Layers (in lookup priority order)

| Layer              | Source of truth                                | Content                                                    | Read/write                                   |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| 1. Aliases         | SQLite `aliases` table                         | Synonym → canonical term (e.g., "ticker" → "venue_symbol") | Admin tools can add aliases at runtime       |
| 2. CDM definitions | `config/cdm-types.json` (pinned release)       | Verbatim CDM Rosetta type definitions with URIs            | Read-only                                    |
| 3. Extensions      | `config/extensions.json` (checked-in registry) | narwhal-specific fields: MIC, board lot, tick size, etc.   | Human edits registry; dictionary regenerated |
| 4. Lineage         | Adapter-emitted source→CDL mappings            | Which venue file column maps to which CDM path             | Accumulated from adapters at build time      |

### Lookup order

Aliases first: if the queried term matches a synonym, resolve to the canonical term and continue the search. Then CDM types → extensions → lineage. If a term exists in multiple layers (e.g., "isin" is both an extension and a lineage source), the higher-priority layer wins.

### Generation

`DictionaryGenerator.regenerate()` reads all four sources and produces a complete, consistent dictionary artifact. This is called at server creation time and automatically on any change to CDM config, extension registry, or alias table. The dictionary is never hand-edited.

### MCP surface

- `lookup_term(term)` — exact match with alias expansion, returns `{ match, layer, definition, see_also, uri }`
- `search_dictionary(query)` — case-insensitive substring search across all layers
- Resources: `dict://cdm/{type}`, `dict://ext/{field}`, `dict://lineage/{path}`, `dict://alias/{term}`

## Consequences

- **Single query surface**: agents and operators ask one system instead of navigating four artifacts.
- **No drift**: dictionary always reflects its sources because it's always generated, never edited.
- **Safe defaults**: alias seeds ("ticker"→"venue_symbol", "board lot"→"board_lot", "exchange"→"mic", "name"→"instrument_name") are inserted idempotently on first startup.
- **CDM definitions are frozen**: pinned to a specific CDM release. Upgrading the CDM version requires updating `config/cdm-types.json` and regenerating.
- **Lineage is build-time**: if an adapter changes its field mapping, the lineage rebuilds on next regeneration. No runtime lineage from individual ingest runs (that's a future enhancement).

## Alternatives considered

- **Hand-edited dictionary**: simpler tooling, but drifts from sources. Rejected — the whole point is that the dictionary is authoritative because it mirrors the registries.
- **Single flat dictionary**: loses the provenance of each entry (is this a CDM definition or a narwhal extension?). The four-layer structure preserves provenance.
- **Runtime lineage from ingest runs**: richer (shows which fields were actually populated vs declared), but adds complexity. Deferred — build-time lineage from adapter declarations covers the 80% case.
