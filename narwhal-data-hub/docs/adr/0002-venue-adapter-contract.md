# ADR-0002: venue-adapter-contract

**Status:** Accepted
**Date:** 2026-08-02

## Context

Six venues across three jurisdictions, each publishing instrument reference data in its own file format. Venue #7 (and beyond) should require only a new adapter + config entry, never core changes.

## Decision

**One adapter per venue** implementing a single contract:

```
parse(fileBytes, venueContext) -> normalizedVenueRecords[]
```

Where `venueContext` carries the MIC, instrument category (stock / commodity future), and profile reference.

Fetching is a **separate module** — adapters are pure parsers, fixture-testable without network access.

## Consequences

- Venue quirks are isolated; core pipeline code never grows per-venue conditionals.
- Adapters are testable with captured fixture files stored in the repo.
- Adding venue #7 = one new adapter class + one config entry + fixture file.
- The normalized record shape must be rich enough to feed CDM assembly for both stocks and commodity futures — designing that shape is deferred to build time.

## Alternatives considered

- **Config-driven mapping** (e.g., YAML column mappings): works for columnar/CSV formats but breaks for hierarchical, fixed-width, or multi-section venue files. A code adapter handles anything the venue throws at us.
- **Adapter-as-plugin (dynamic loading)**: overengineered for six venues. Static registration compiles safely and keeps deployment simple.
