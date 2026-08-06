# CONTEXT.md — narwhal data hub

Domain glossary and architectural context. Maintained by `/domain-modeling` (driven by `/grill-with-docs` and `/improve-codebase-architecture`).

## Glossary

- **Pool** — the bitemporal SQLite store holding all CDM-structured instrument records. Single writer (pipeline), multiple readers (MCP server, downstream systems).
- **CDM** (Common Domain Model) — FINOS CDM, the canonical financial instrument data model. Consumed as a versioned JSON Schema dependency; pinned at build time.
- **Venue** — a trading venue identified by ISO 10383 MIC. v1 covers six: `XNYS`, `XHKG`, `XSES` (stocks); `XCME`, `XHKF`, `XSIM` (commodity futures).
- **MIC** (Market Identifier Code) — ISO 10383 four-character venue identifier. The authoritative identity for venue-native records.
- **Adapter** — a per-venue parser implementing the contract `parse(fileBytes, venueContext) -> normalizedVenueRecords[]`. Isolates venue file-format quirks; fetching is a separate module.
- **Profile** — a declared subset of CDM types/fields the pool commits to populate, per instrument category (stock, commodity future). Ingest validates against the profile, not raw CDM schemas.
- **Extension** — a venue/listing attribute CDM does not model natively (board lot, tick size, trading hours, contract specs). Held in an extension registry; never smuggled into CDM types.
- **Dictionary** — four-layer generated artifact: (1) CDM Rosetta definitions verbatim, (2) extension definitions, (3) source→CDM lineage, (4) synonym aliases. Humans edit registries; dictionary is always generated.
- **Bitemporal** — every record carries `effective_from`/`effective_to` (business time) and `recorded_from`/`recorded_to` (system time). Status is derived, never stored as a mutable flag.
- **Delta** — snapshot diff: content-hash each normalized record, diff against pool state, auto-apply adds/updates/delistings with full audit rows.
- **Quarantine** — records that fail profile validation are held in a quarantine table with failure reasons; never published to the pool.
- **Safety gate** — per-venue thresholds (parse-error rate, mass-change fraction) that quarantine an entire run when tripped.
- **Approved source** — an exchange file location explicitly approved by the operator (approver, timestamp, terms note). The fetcher refuses unapproved locations.
- **MCP** (Model Context Protocol) — the transport layer for agent access. Read tools for resolution/query/dictionary; admin tools for operator control. Transport: stdio.
- **Ingest run** — one execution of the pipeline for one venue: fetch → parse → assemble → validate → diff → apply. Recorded with venue, window, file hash, counts, outcome.

## Architecture decisions

See `docs/adr/` for formal records. Key decisions:

- [ADR-0001](docs/adr/0001-sqlite-bitemporal-hybrid-storage.md) — SQLite with bitemporal hybrid storage (relational spine + CDM JSON + filter columns)
- [ADR-0002](docs/adr/0002-venue-adapter-contract.md) — One adapter per venue; venue-native identity is authoritative
- [ADR-0003](docs/adr/0003-profile-validation-over-raw-cdm.md) — Profile validation against declared subsets, not raw CDM schemas
- [ADR-0004](docs/adr/0004-delta-engine-content-hash-diff.md) — Content-hash snapshot diffing with close-out-and-insert bitemporal writes
- [ADR-0005](docs/adr/0005-pipeline-extensibility.md) — Pipeline extensibility: fetcher injection, static profiles, OTC sources
- [ADR-0006](docs/adr/0006-dictionary-system.md) — Four-layer dictionary with registry-driven generation
- [ADR-0007](docs/adr/0007-safety-gates.md) — Per-venue safety gates with all-or-nothing quarantine

Operational decisions (not formalized as ADRs):

- Scheduling: system cron invokes ingest CLI; MCP server never owns scheduling.
- OpenFIGI is enrichment/cross-ref only, config-gated.
