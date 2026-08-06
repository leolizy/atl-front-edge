# ADR-0001: SQLite with bitemporal hybrid storage

**Status:** Accepted
**Date:** 2026-08-02

## Context

narwhal data hub needs local, single-machine storage for CDM-structured instrument reference data. The pool is written by one pipeline process and read by an MCP server and occasional downstream systems. Records must support historical queries ("as of any business date") and full auditability ("when did we learn this, and from what source").

## Decision

**SQLite via better-sqlite3, WAL mode.** Hybrid shape: relational spine (instruments, listings, identifiers, sources, ingest_runs, changes, quarantine, aliases) + full CDM JSON document per record + extracted filter columns for query performance.

**True bitemporality** on every record with four columns:

```
effective_from  -- business date the fact takes effect
effective_to    -- business date the fact stops being true (null = open-ended)
recorded_from   -- when the pipeline wrote this row
recorded_to     -- when this row was superseded (null = current system version)
```

Status (`announced` / `active` / `suspended` / `delisted`) is **derived** from effective dates relative to the query's `as_of` — never stored as a mutable flag.

**Identity**: surrogate PKs; unique constraint on `(MIC, venue symbol)`; ISIN/FIGI/CUSIP/SEDOL in a cross-ref table. Venue-native identity is authoritative.

## Consequences

- Single-file backup and disaster recovery is trivial.
- WAL mode allows concurrent reads during pipeline writes.
- JSON documents keep CDM fidelity without exploding the relational schema.
- Extracted filter columns avoid full JSON scans for common queries.
- Bitemporal writes (close-out-and-insert) are more complex than upserts but preserve full history.
- Not suitable for multi-writer or high-concurrency scenarios (explicitly out of scope).

## Alternatives considered

- **PostgreSQL**: better concurrency and richer query surface, but adds operational complexity (server, backups, upgrades) disproportionate to a single-machine local pool. Explicitly out of scope for v1.
- **Pure JSON file store**: trivial backup but no query capability without loading everything into memory.
- **Mutable flags for status**: simpler writes but loses history and can't answer "what was active on date X".
