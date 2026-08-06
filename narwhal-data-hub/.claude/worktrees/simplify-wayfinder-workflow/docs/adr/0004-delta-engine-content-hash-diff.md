# ADR-0004: Content-hash snapshot diffing with close-out-and-insert bitemporal writes

**Status:** Accepted
**Date:** 2026-08-03

## Context

The pool store must detect what changed between daily venue snapshots and record every mutation with full auditability. A naive approach — drop and reload — loses history. An upsert approach loses the audit trail of _when_ a record changed and _what_ the prior values were. The pool must answer both "what was active on date X" (business time) and "when did we learn that fact Y was true" (system time).

Venues publish daily snapshots, not change feeds. Each snapshot is a full current-state file. The pipeline must diff the incoming snapshot against what's already in the pool and apply only the diffs — without ever mutating a row in place.

## Decision

**Content-hash every incoming CDM document (SHA-256 of canonical JSON), diff against the current active pool state, and auto-apply adds/updates/delistings with close-out-and-insert bitemporal writes.**

### Delta rules

| Condition                                       | Action                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| New hash not in pool                            | **Add** — insert with new surrogate PK, `effective_from` = today                             |
| Hash matches existing active record             | **No-op** — idempotent re-runs produce zero changes                                          |
| Existing active record has no match in snapshot | **Delist** — close out `effective_to` = today                                                |
| Same `(MIC, venue_symbol)` but different hash   | **Update** — close out old row (`recorded_to` = now), insert new row (`recorded_from` = now) |

### Mutation discipline

Every mutation is **close-out-and-insert**, never an in-place UPDATE. When a record changes:

1. Close the old row: SET `effective_to` = change_date, `recorded_to` = now
2. Insert a new row: `effective_from` = change_date, `recorded_from` = now, `recorded_to` = NULL

Status (`announced`, `active`, `suspended`, `delisted`) is **derived** from effective dates relative to the query's `as_of` — never stored as a mutable flag.

### Atomicity

The entire diff + apply runs in a single SQLite transaction. If any step fails, the pool is unchanged. A `changes` audit table records every mutation with before/after content hashes, change type, and timestamps.

### Identity key

Default: `(mic, venue_symbol)` — venue-native identity is authoritative (ADR-0002). The key is parameterizable via a `keyFn` callback for sources with different identity models (e.g., OTC records keyed by ISIN).

## Consequences

- **Full audit trail**: every state transition is recorded in the `changes` table and recoverable from bitemporal rows.
- **Idempotent**: re-running the same snapshot produces zero changes — safe for retry and recovery.
- **Historical queries**: `queryEffectiveAsOf(asOf)` returns correct state for any past business date by filtering `effective_from <= asOf AND effective_to > asOf` against current system-time rows (`recorded_to IS NULL`).
- **Space grows monotonically**: every change adds a row. Acceptable for reference data (low churn); a future archival strategy may be needed for high-churn sources.
- **Content-hash dependency**: canonical JSON serialization must be deterministic (sorted keys). Non-deterministic serialization would produce false-positive changes.
- **Duplicate handling within a single snapshot**: last record wins (Map overwrite by key), producing a single ADD. Duplicates across venues are harmless (different MIC).

## Alternatives considered

- **Drop and reload**: simplest, but loses all history and can't answer "what was active on date X."
- **Mutable upsert with status flags**: simpler writes, but `SET status = 'delisted'` overwrites history — can't distinguish "delisted Tuesday" from "delisted Wednesday" after the fact.
- **Change feed from venue**: ideal but unavailable — venues publish snapshots, not feeds.
- **Row-level diff by comparing every column**: fragile — adding a column to the schema breaks the diff. Content-hash is invariant to schema changes.
