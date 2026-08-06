# narwhal data hub — v1 Spec

**Status:** ready-for-agent (label not applied — no issue tracker configured; spec published to repo root per user direction)
**Date:** 2026-08-02
**Origin:** Produced via `/to-spec` from a confirmed grilling-session decision record.

## Problem Statement

An agent (or a human working through an agent) that needs financial instrument reference data for listed instruments across US, Hong Kong, and Singapore venues has no local, trusted, standards-shaped source. Every question — "what exactly is this instrument?", "what are its trading attributes?", "what changed this week?", "what does this field name mean?" — requires ad-hoc lookups against inconsistent web sources, with no common structure, no history, no provenance, and no machine-readable dictionary. Anything built on top (research agents, risk tooling, downstream systems) re-solves reference data from scratch each time, and there is no way to ask what the instrument universe looked like on a past — or announced future — date.

## Solution

**narwhal data hub**: a local MCP server that maintains a bitemporal, FINOS CDM-structured product data pool for listed instruments on six venues identified by MIC — stocks: `XNYS`, `XHKG`, `XSES`; commodities: `XCME`, `XHKF`, `XSIM`. The pool is fed daily from exchange-native files (the source of truth, each explicitly approved by the operator) with automatic delta detection and a full audit trail. Records are validated at ingest against declared per-category CDM profiles; failures are quarantined, never published. A four-layer standard dictionary — CDM definitions verbatim, extension fields, source→CDM lineage, and synonym aliases — is generated from single sources of truth and served to both agents (via MCP) and systems (as JSON). Agents resolve identifiers or descriptions into canonical CDM records, query the universe as of any business date, inspect changes and provenance, and ground themselves in the dictionary; the operator runs the pipeline via cron and a small set of MCP admin tools.

## User Stories

### Agent — resolution and query

1. As an agent, I want to resolve an instrument by ISIN, so that I get its canonical CDM-structured record.
2. As an agent, I want to resolve an instrument by venue symbol + MIC, so that venue-native identity works as a first-class lookup.
3. As an agent, I want to resolve an instrument by FIGI, CUSIP, or SEDOL, so that vendor identifiers cross-reference into the pool.
4. As an agent, I want to resolve an instrument from a free-text description, so that I get best matches with confidence and alternatives when the user gives me something ambiguous.
5. As an agent, I want a clear not-found result with near-miss suggestions, so that I can recover instead of hallucinating a record.
6. As an agent, I want to get an instrument as of a past business date, so that historical questions are answered from the pool, not from memory.
7. As an agent, I want to get an instrument as of a future business date, so that announced listings/delistings are visible before they go live.
8. As an agent, I want instrument status (announced, active, suspended, delisted) derived from effective dates, so that I never read a stale mutable flag.
9. As an agent, I want to search instruments by MIC, asset class, currency, and status, so that I can enumerate slices of the universe.
10. As an agent, I want every record to carry provenance (source, ingest run, recorded timestamp), so that I can tell the user where a fact came from.
11. As an agent, I want per-field lineage (source file column → CDM path), so that I can explain or debug a specific attribute's origin.
12. As an agent, I want to list changes by venue, date range, and change type, so that "what changed this week?" is one call.
13. As an agent, I want each change to carry before/after content hashes, so that the audit trail is verifiable.
14. As an agent, I want to check per-venue ingest freshness before answering, so that I can caveat answers when a venue's data is stale.

### Agent — dictionary

15. As an agent, I want to look up any CDM type's verbatim definition, attributes, and cardinalities, so that I use the model correctly.
16. As an agent, I want extension field definitions (MIC, board lot, tick size, trading hours), so that non-CDM-native attributes are equally well defined.
17. As an agent, I want to look up terms by synonym or alias ("ticker", "board lot"), so that user language maps to canonical fields.
18. As an agent, I want dictionary records addressable by stable URIs, so that I can cite definitions precisely.
19. As an agent, I want to list the venues in the pool with their MICs and per-venue coverage notes, so that I know the universe's boundaries.

### Operator — sources and pipeline control

20. As the operator, I want to approve each source explicitly (recording who, when, and a terms note) before any ingest from it, so that nothing enters the pool from an unapproved origin.
21. As the operator, I want to list approved sources and their approval metadata, so that governance is inspectable.
22. As the operator, I want venues configured declaratively (MIC, adapter, schedule, thresholds), so that pipeline behavior is configuration, not code edits.
23. As the operator, I want daily cron to run each venue's ingest in its publication window without my intervention, so that the pool stays fresh by default.
24. As the operator, I want to trigger an ad-hoc ingest for one venue via an MCP admin tool, so that I don't context-switch to a terminal.
25. As the operator, I want a daily summary report (adds, updates, delistings, quarantines per venue), so that one glance tells me what the pipeline did.
26. As the operator, I want a missing or unavailable venue file to leave prior state intact and appear in the summary, so that a bad morning doesn't corrupt the pool.
27. As the operator, I want run-level safety gates (parse-error rate, mass-change threshold) to quarantine a whole run with an explanation, so that a malformed file never partially applies.
28. As the operator, I want to review quarantined records with their failure reasons via an admin tool, so that validation failures are visible and actionable.
29. As the operator, I want to reprocess quarantined records after fixing the cause, so that recovery is a deliberate act.
30. As the operator, I want re-running the same file to be idempotent (zero changes), so that retries and cron overlaps are safe.
31. As the operator, I want to backfill a venue from a historical snapshot, so that the pool can be bootstrapped or repaired.
32. As the operator, I want backup to be a single-file copy, so that disaster recovery is trivial.
33. As the operator, I want to add dictionary aliases via an admin tool, so that agent grounding improves as I notice gaps.

### Pipeline — daily job behavior

34. As the pipeline, I want to fetch each venue's snapshot only from its approved source location, so that governance is enforced mechanically.
35. As the pipeline, I want one adapter per venue that parses the venue's file into normalized records, so that venue quirks are isolated.
36. As the pipeline, I want each normalized record assembled into a CDM JSON document per the declared profile for its instrument category, so that storage is standards-shaped.
37. As the pipeline, I want each document validated against the profile before publish, so that non-conformant records never enter the pool.
38. As the pipeline, I want filter columns (MIC, symbol, ISIN, asset class, currency, status dates) extracted from each document, so that queries don't scan JSON.
39. As the pipeline, I want to content-hash each record and diff today's snapshot against the pool, so that deltas are computed from full snapshots.
40. As the pipeline, I want adds, updates, and delistings auto-applied with close-out-and-insert bitemporal writes, so that history is never destroyed.
41. As the pipeline, I want future-dated effectiveness from venue notices captured as future-effective records, so that announced changes are queryable before go-live.
42. As the pipeline, I want every ingest run recorded (venue, window, file hash, counts, outcome), so that the audit trail covers the pipeline itself.
43. As the pipeline, I want OpenFIGI cross-references refreshed as enrichment where configured, so that vendor identifiers accumulate without blocking the core flow.

### Downstream systems

44. As a downstream system, I want to read the pool directly from the SQLite database with a documented schema, so that I don't need MCP to consume data.
45. As a downstream system, I want the dictionary as JSON records with stable URIs, so that definitions are machine-consumable identically to agents.
46. As a downstream system, I want schema migrations to be versioned and explicit, so that upgrades are predictable.

### Maintenance and evolution

47. As the maintainer, I want venue #7 to require only a new adapter plus a config entry, so that expansion is cheap.
48. As the maintainer, I want the CDM release pinned as a versioned dependency and upgraded deliberately, so that the standard never shifts under the pool.
49. As the maintainer, I want the dictionary regenerated whenever CDM, profiles, extensions, or aliases change, so that it never drifts from what the pipeline does.

## Implementation Decisions

### Architecture and modules

- **Extend the existing reference skeleton** (`finos-cdm-mcp-server` TypeScript MCP server): keep its MCP plumbing and resource/tool patterns; replace its hand-picked static catalog with the real CDM release. The `CdmDataSource` seam is re-implemented against the pooled store.
- **Modules**: snapshot fetcher; six venue adapters; CDM assembler; profile validator; delta engine; pool store (SQLite); dictionary generator; MCP server (tools, resources, prompts); admin CLI (used by cron and by the admin tools); OpenFIGI enrichment module (optional, config-gated).
- **Official FINOS CDM release consumed as a versioned dependency** via its JSON Schema / generated TypeScript artifacts (no Java in the environment). Exact release version pinned at build time.
- **Venue/listing attributes that CDM does not model natively** (MIC, board lot, tick size, trading hours, contract specs) are **documented extensions** held in an extension registry — never silently smuggled into CDM types.

### Identity and storage

- **SQLite** via better-sqlite3, WAL mode. One writer (the pipeline), a handful of readers (MCP server, downstream systems).
- **Hybrid shape**: relational spine + full CDM JSON document per record + extracted filter columns. Spine tables: instruments, listings, identifiers (cross-ref), sources, ingest_runs, changes, quarantine, aliases.
- **Identity**: surrogate primary keys; unique constraint on `(MIC, venue symbol)`; ISIN/FIGI/CUSIP/SEDOL live in the cross-ref table — venue-native identity is authoritative because exchange-native files are the source of truth.
- **True bitemporality** on every record. The following column set encodes the decision precisely:

  ```
  effective_from  -- business date the fact takes effect (may be future, from venue notices)
  effective_to    -- business date the fact stops being true (null = open-ended)
  recorded_from   -- when the pipeline wrote this row
  recorded_to     -- when this row was superseded (null = current system version)
  ```

  Status (`announced` / `active` / `suspended` / `delisted`) is **derived** from these columns relative to the query's `as_of` business date — never stored as a mutable flag. All query surfaces accept `as_of` (default: today).

### Sources and delta

- **Exchange-native daily files are the source of truth** — one adapter per venue: `XNYS`, `XHKG`, `XSES`, `XCME`, `XHKF`, `XSIM`. OpenFIGI is enrichment/cross-reference only, config-gated.
- **Source approval is a hard precondition**: the fetcher refuses any location not present in the approved-sources registry (which records approver, timestamp, and terms note).
- **Delta = snapshot diff**: venue files are full snapshots; the pipeline content-hashes each normalized record and diffs against pool state. Adds/updates/delistings auto-apply with full audit rows.
- **Safety gates quarantine the whole run** (never partial application) when parse-error rate or mass-change fraction exceeds per-venue thresholds; the trip reason appears in the daily summary.
- **Scheduling**: system cron invokes the ingest CLI per venue in that venue's publication window. The MCP server never owns scheduling. Exact windows set at build time.

### Adapter contract

- One interface isolates all venue quirks; venue #7 = new adapter + config entry, no core changes. The contract, which encodes the seam precisely:

  ```
  parse(fileBytes, venueContext) -> normalizedVenueRecords[]
  ```

  The venue context carries the MIC, instrument category (stock / commodity future), and profile reference. Fetching is a separate module so adapters stay pure and fixture-testable.

### Validation and dictionary

- **Declared CDM profiles per instrument category** (stock, commodity future): versioned declarations of exactly which CDM types/fields the pool commits to populate, plus extension fields. Ingest validates against the profile; failures are quarantined with reasons and surfaced in the run summary. Raw-CDM validation is explicitly rejected — venue files cannot satisfy every mandatory CDM field.
- **Dictionary: four layers, all generated build artifacts**, each from a single source of truth — (1) CDM Rosetta definitions verbatim from the pinned release; (2) extension definitions from the extension registry; (3) source→CDM lineage emitted by the adapters; (4) synonym aliases from the alias map. Humans edit registries, never dictionary output. Records carry stable `dict://` URIs; JSON for systems, markdown rendering for humans.

### MCP surface

- **Transport: stdio** (local server; systems consume via the DB, not MCP).
- **Read tools**: `resolve_instrument` (identifier or free-text description → canonical CDM record, with confidence and alternatives), `search_instruments` (structured filters incl. `as_of`), `get_instrument`, `list_changes`, `get_change`, `lookup_term` / `search_dictionary` (alias-expanding, across all four layers), `get_ingest_status`, `list_venues`, `list_sources`.
- **Admin tools**: `approve_source`, `trigger_ingest`, `review_quarantine`, `reprocess_quarantine`, `update_alias`, `regenerate_dictionary`.
- **Resources**: `instrument://{mic}/{symbol}` (with `as_of`), `dict://cdm/...`, `dict://ext/...`, `dict://profile/...`, `dict://alias/...`, plus operational reports (ingest runs, daily summaries, change feeds).
- **Prompts**: keep the skeleton's model-navigation prompts, re-backed by the real CDM release; add workflows for "identify this instrument" and "what changed recently".

### Deferred to build time (facts, not decisions)

- Exact CDM release version to pin.
- Per-venue file format recon and the per-venue effective-date coverage matrix (venues expose advance dates unevenly; coverage is documented, not faked).
- Fuzzy-match strategy and confidence scoring for `resolve_instrument`.
- Cron window times per venue publication schedule.
- Parse-error and mass-change threshold defaults per venue.

## Testing Decisions

- **What makes a good test**: asserts external behavior at a seam, never implementation details; hermetic (no network, no cron, no wall-clock dependence — business dates injected); fixtures are minimal captured samples of real venue files stored in the repo.
- **Seam 1 — ingest pipeline (CLI entrypoint)**: fixture file in → assert resulting database state: instrument records and their bitemporal columns, changes rows, quarantine entries with reasons, and the run report. Covers all six adapters, CDM assembly, profile validation, delta engine, and bitemporal writes through one seam. Idempotency (re-run = zero changes), safety-gate trips, missing-file handling, and future-dated notices are all exercised here.
- **Seam 2 — MCP server (stdio protocol)**: server started over a seeded test database; an MCP test client drives tool calls and resource reads; assert responses — resolution by each identifier type, fuzzy not-found behavior, `as_of` queries, dictionary lookups with alias expansion, admin tool effects, provenance fields.
- **Module-level tests** only where seam coverage is genuinely awkward: delta-diff edge cases (hash collisions in ordering, rename-vs-delete+add disambiguation) and bitemporal `as_of` resolution (boundary dates, future-effective records, superseded system versions).
- **Prior art**: none — greenfield repo. The skeleton's module layout is the structural reference; its static-catalog test approach does not survive the move to a real CDM release.

## Out of Scope

- OTC derivatives and ANNA DSB sourcing (a natural later phase; CDM fit is strongest there, but v1 is venue-bounded listed instruments).
- Venues beyond the six listed MICs.
- Real-time data, pricing, quotes, ticks; corporate actions processing beyond reference attributes; the CDM event/lifecycle model; trade capture.
- Multi-user, authentication, and network transport (HTTP/SSE) for MCP.
- Postgres or any client-server database.
- Validation against raw CDM schemas (replaced by declared profiles).
- Redistribution or republication of licensed venue data — the pool is local-only.
- Any GUI.

## Further Notes

- **MIC precision**: `XHKF` (HKEX futures arm) and `XSIM` (SGX derivatives) are used for the commodity side rather than reusing the securities MICs `XHKG`/`XSES` — the derivatives MICs are the correct ISO 10383 identifiers for those markets.
- **Licensing**: each venue file carries its own terms; the approved-sources registry records a terms note at approval time. The pool is local-only and republishes nothing.
- **Issue tracker**: `setup-matt-pocock-skills` was not completed (redirected to spec-first). Tracker config, triage labels, and domain-doc layout can be added later by finishing that skill; until then this spec is the repo's seed document.
- The decision record underlying this spec was produced interactively (grilling session, 2026-08-02); every decision above was confirmed by the operator.
