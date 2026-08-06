# ADR-0005: Pipeline extensibility — fetcher injection, static profiles, and OTC sources

**Status:** Accepted
**Date:** 2026-08-03

## Context

The initial pipeline design assumed all data flowed through the same path: snapshot file → adapter → assembler → validator → delta → pool. This assumption broke at the first expansion beyond exchange-traded instruments:

1. **OTC derivatives** (ANNA DSB): records are ISIN-keyed (no MIC, no venue symbol), come from an API-backed source, and carry structured product terms (notional, rate, maturity, underlier) that don't fit the flat `NormalizedRecord` model.

2. **Static profiles** (Cash, Loan, DigitalAsset): have no exchange, no daily snapshot, no delisting concept. They are one-time reference data loads — hand-curated CDM mappings with no pipeline.

The question: does the pipeline architecture need a fundamental redesign, or can it stretch to cover these new shapes with targeted, local changes?

## Decision

**The existing pipeline architecture (adapter → assembler → validator → delta → pool) holds.** No new abstractions. Changes are local and additive:

### OTC derivatives

- **Adapter contract unchanged**: OTC adapters implement the same `parse(fileBytes, venueContext) -> NormalizedRecord[]` contract. ANNA DSB provides end-of-day file downloads — the existing `SnapshotFetcher` handles HTTP downloads, so no API-specific fetcher class is needed.
- **Synthetic MIC**: OTC records use a synthetic MIC (`"DSB"`) and ISIN as `venue_symbol`. The delta key `(mic, venue_symbol)` works naturally with `("DSB", ISIN)` — no `keyFn` parameterization needed at tracer-bullet depth.
- **Product terms in `attributes`**: structured fields (notional, rate, maturity, strike, underlier) go in the `attributes` bag. The assembler falls back to `attributes` when a field isn't found at the top level of the record.
- **Validator type discriminator**: profiles declare `"type": "number"` or `"type": "object"` for structured fields; the validator dispatches to appropriate checks instead of only string validation.
- **Extended `asset_class` CHECK constraint**: migration adds `interest_rate_derivative`, `credit_derivative`, `fx_derivative`, `equity_derivative`, `listed_derivative`.

### Static profiles

- **Direct load path**: static profiles bypass the pipeline entirely. A `loadStaticRecords()` function assembles, validates, and inserts directly into `instruments` with a synthetic `ingest_run` (outcome = `"static_load"`).
- **No delta**: static records have no before/after — they are one-time inserts with `effective_from` set and `effective_to IS NULL`.
- **Synthetic MIC**: profile name used as the `mic` column (`"cash-v1"`, `"loan-v1"`, `"digital-asset-v1"`).
- **Same assembler + validator**: static profiles use the same profile-driven assembler and validator as exchange-traded instruments.

### Assembler generalization

- `StockProfile` / `StockProfileField` renamed to `CdmProfile` / `CdmProfileField` — they were never stock-specific.
- `NormalizedRecord` unified: the adapter's `types.ts` is canonical; the assembler's duplicate definition is removed. The unified type has core identity fields + `attributes` bag + optional typed fields for specific instrument classes.
- Attribute fallback: `record.attributes?.[field.source] ?? record[field.source]` — adapters can put fields at top level or in the bag.

## Consequences

- **Nothing is torn down**: the existing pipeline stays intact for exchange-traded venues. New paths branch cleanly.
- **No factory, no strategy pattern, no base class hierarchy**: the fetcher is already an injected dependency; the pipeline already accepts it polymorphically.
- **OTC key decision deferred**: using `("DSB", ISIN)` as `(mic, venue_symbol)` works. If a future OTC source needs a genuinely different composite key (e.g., ISIN + strike + expiry for options), parameterize delta's key then — not now.
- **Static profiles are second-class**: they can't participate in delta, backfill, or the changes audit table. This is acceptable for reference data that doesn't change. If static data later needs versioning, promote it to a full pipeline source.

## Alternatives considered

- **Polymorphic `SnapshotFetcher` with `source_type` enum**: more invasive, adds a dispatch layer for what is currently one alternative. Rejected — the existing HTTP download path already covers DSB file downloads.
- **Static profiles through the full pipeline**: would require fake snapshots, fake deltas, and fake venues — more complexity than the direct-load path, with no benefit.
- **Separate assembler per instrument class**: rejected — the profile-driven assembler is already generic. Adding a new instrument class means adding a new profile, not a new assembler.
