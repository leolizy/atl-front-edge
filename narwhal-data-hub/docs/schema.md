# Schema reference

The narwhal data hub stores instrument reference data in a SQLite database
(typically `./data/pool.db`). The database uses WAL journal mode and enforces
foreign keys. Every data mutation is a close-out-and-insert -- rows are never
mutated in place on their data columns.

This document is written for downstream systems that read the database directly.
It lists every table, column, index, and constraint.

---

## Table: `migrations`

Schema versioning table, managed by the migrator (`src/db/migrator.ts`).

| Column       | Type    | Constraints | Description                     |
| ------------ | ------- | ----------- | ------------------------------- |
| `version`    | INTEGER | PRIMARY KEY | Migration number                |
| `name`       | TEXT    | NOT NULL    | Human-readable migration label  |
| `applied_at` | TEXT    | NOT NULL    | ISO 8601 timestamp when applied |

---

## Table: `instruments`

The core instrument pool. Every row is a **version** of an instrument at a point
in time. Updates close out the old row (set `recorded_to` + `effective_to`) and
insert a new one. Deletions close out the old row with no replacement.

| Column           | Type    | Constraints                                      | Description                                               |
| ---------------- | ------- | ------------------------------------------------ | --------------------------------------------------------- |
| `id`             | INTEGER | PRIMARY KEY AUTOINCREMENT                        | Surrogate row id                                          |
| `mic`            | TEXT    | NOT NULL                                         | ISO 10383 Market Identifier Code (e.g. "XNYS")            |
| `venue_symbol`   | TEXT    | NOT NULL                                         | Venue-native ticker / symbol                              |
| `asset_class`    | TEXT    | NOT NULL, CHECK(`'stock'`, `'commodity_future'`) | Broad instrument category                                 |
| `currency`       | TEXT    | NOT NULL                                         | ISO 4217 currency code (e.g. "USD")                       |
| `cdm_json`       | TEXT    | NOT NULL                                         | Full CDM JSON document (canonical key order)              |
| `content_hash`   | TEXT    | NOT NULL                                         | SHA-256 of canonical `cdm_json`                           |
| `effective_from` | TEXT    | NOT NULL                                         | Business date the row takes effect (YYYY-MM-DD)           |
| `effective_to`   | TEXT    |                                                  | Business date the row stops being true (null = open)      |
| `recorded_from`  | TEXT    | NOT NULL                                         | System time when this row was written (ISO 8601)          |
| `recorded_to`    | TEXT    |                                                  | System time when this row was superseded (null = current) |
| `source_id`      | INTEGER | REFERENCES `sources(id)`                         | FK to the approved source that provided this data         |
| `ingest_run_id`  | INTEGER | REFERENCES `ingest_runs(id)`                     | FK to the pipeline run that wrote this row                |

### Bitemporal columns

The `instruments` table uses a **bitemporal model** with two independent time axes:

| Axis              | Columns                          | Meaning                                             |
| ----------------- | -------------------------------- | --------------------------------------------------- |
| **Business time** | `effective_from`, `effective_to` | When the fact is/was true in the real world         |
| **System time**   | `recorded_from`, `recorded_to`   | When the system learned about (and stored) the fact |

A row is **current in system time** when `recorded_to IS NULL` -- this is the
version the system currently believes is true. A row is **active on business
date D** when `effective_from <= D AND (effective_to IS NULL OR effective_to > D)`.

The "current active" row for an instrument is the one with `recorded_to IS NULL`
and an `effective_from/effective_to` window that covers today.

**Every mutation** (add, update, delist) follows the same pattern:

1. Close out the existing active row: set `effective_to` and `recorded_to`.
2. For adds and updates, insert a new row with fresh `effective_from` and `recorded_from`.
3. For delistings, no new row is inserted -- the instrument simply ceases.

### Status derivation

Instrument status is **derived at query time** from the effective-date window
relative to a query's `as_of` date. It is never stored as a mutable flag.

| Condition                                            | Status      |
| ---------------------------------------------------- | ----------- |
| `effective_from <= as_of AND effective_to IS NULL`   | `active`    |
| `effective_from > as_of`                             | `announced` |
| `effective_to IS NOT NULL AND effective_to <= as_of` | `delisted`  |

The delta engine's `queryEffectiveAsOf(venue, asOf)` method in
`src/delta/delta-engine.ts` implements this logic.

### Identity and uniqueness

- **Surrogate PK**: `id` (autoincrement).
- **Business key**: `(mic, venue_symbol)` -- guaranteed unique among currently-active
  rows by the partial unique index `idx_instruments_mic_symbol`.
- **Content dedup**: `content_hash` -- two rows with the same `(mic, venue_symbol)`
  and same hash are considered identical; the delta engine skips them.

---

## Table: `listings`

Venue-specific listing attributes that CDM does not model natively (board lot,
tick size, trading hours). One row per instrument.

| Column              | Type    | Constraints                            | Description                             |
| ------------------- | ------- | -------------------------------------- | --------------------------------------- |
| `id`                | INTEGER | PRIMARY KEY AUTOINCREMENT              | Surrogate row id                        |
| `instrument_id`     | INTEGER | NOT NULL, REFERENCES `instruments(id)` | FK to parent instrument                 |
| `mic`               | TEXT    | NOT NULL                               | MIC of the listing venue                |
| `board_lot`         | INTEGER |                                        | Minimum shares per order (round lot)    |
| `tick_size`         | REAL    |                                        | Minimum price increment                 |
| `trading_hours`     | TEXT    |                                        | Scheduled trading session times         |
| `contract_size`     | REAL    |                                        | Deliverable quantity per contract       |
| `delivery_months`   | TEXT    |                                        | Contract delivery month codes           |
| `tick_value`        | REAL    |                                        | Monetary value of one tick per contract |
| `settlement_method` | TEXT    |                                        | "physical" or "cash"                    |

---

## Table: `identifiers`

Cross-reference table for vendor/external instrument identifiers. An instrument
can have multiple identifiers of different types.

| Column          | Type    | Constraints                                               | Description             |
| --------------- | ------- | --------------------------------------------------------- | ----------------------- |
| `id`            | INTEGER | PRIMARY KEY AUTOINCREMENT                                 | Surrogate row id        |
| `instrument_id` | INTEGER | NOT NULL, REFERENCES `instruments(id)`                    | FK to parent instrument |
| `type`          | TEXT    | NOT NULL, CHECK(`'ISIN'`, `'FIGI'`, `'CUSIP'`, `'SEDOL'`) | Identifier scheme       |
| `value`         | TEXT    | NOT NULL                                                  | Identifier value        |

Unique constraint: `UNIQUE(type, value)` -- a given `(scheme, value)` pair can
only belong to one instrument.

---

## Table: `sources`

Approved source registry. The snapshot fetcher refuses any location not listed
here. Sources must be approved via the CLI admin tool before data can be fetched.

| Column        | Type    | Constraints               | Description                         |
| ------------- | ------- | ------------------------- | ----------------------------------- |
| `id`          | INTEGER | PRIMARY KEY AUTOINCREMENT | Surrogate row id                    |
| `mic`         | TEXT    | NOT NULL                  | ISO 10383 MIC of the venue          |
| `location`    | TEXT    | NOT NULL                  | URL or file path to the data source |
| `approver`    | TEXT    | NOT NULL                  | Username of the person who approved |
| `approved_at` | TEXT    | NOT NULL                  | ISO 8601 timestamp of approval      |
| `terms_note`  | TEXT    |                           | Optional free-text note about terms |

---

## Table: `ingest_runs`

Every pipeline execution is recorded as a row in this table. The row is created
at the start of the run and updated at completion with final counts and outcome.

| Column                | Type    | Constraints                                                                             | Description                            |
| --------------------- | ------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| `id`                  | INTEGER | PRIMARY KEY AUTOINCREMENT                                                               | Surrogate row id                       |
| `venue`               | TEXT    | NOT NULL                                                                                | MIC of the venue processed             |
| `window_start`        | TEXT    |                                                                                         | Start of the snapshot window           |
| `window_end`          | TEXT    |                                                                                         | End of the snapshot window             |
| `file_hash`           | TEXT    |                                                                                         | SHA-256 of ingested file bytes         |
| `file_name`           | TEXT    |                                                                                         | Name of the ingested file              |
| `records_total`       | INTEGER | NOT NULL DEFAULT 0                                                                      | Records found in the snapshot          |
| `records_added`       | INTEGER | NOT NULL DEFAULT 0                                                                      | New instruments added to pool          |
| `records_updated`     | INTEGER | NOT NULL DEFAULT 0                                                                      | Existing instruments updated           |
| `records_delisted`    | INTEGER | NOT NULL DEFAULT 0                                                                      | Previously-active instruments delisted |
| `records_quarantined` | INTEGER | NOT NULL DEFAULT 0                                                                      | Records that failed validation         |
| `outcome`             | TEXT    | NOT NULL, CHECK(`'success'`, `'partial'`, `'quarantined'`, `'failed'`, `'unavailable'`) | Final run outcome                      |
| `error_message`       | TEXT    |                                                                                         | Error detail when outcome is `failed`  |
| `run_started_at`      | TEXT    | NOT NULL                                                                                | ISO 8601 when run started              |
| `run_completed_at`    | TEXT    |                                                                                         | ISO 8601 when run completed            |

### Outcome values

| Outcome       | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `success`     | All records parsed, validated, and applied with no failures      |
| `partial`     | Some records applied; some quarantined (validation failures)     |
| `quarantined` | Entire run quarantined -- safety gate tripped, zero mutations    |
| `failed`      | Parse error or other fatal error; no mutations applied           |
| `unavailable` | Snapshot could not be fetched (no approved source or all failed) |

---

## Table: `changes`

Change audit trail. One row per instrument-level change per ingest run. Records
the transition from `before_hash` to `after_hash` for audit and replay.

| Column          | Type    | Constraints                                      | Description                          |
| --------------- | ------- | ------------------------------------------------ | ------------------------------------ |
| `id`            | INTEGER | PRIMARY KEY AUTOINCREMENT                        | Surrogate row id                     |
| `instrument_id` | INTEGER | REFERENCES `instruments(id)`                     | FK to the instrument that changed    |
| `ingest_run_id` | INTEGER | NOT NULL, REFERENCES `ingest_runs(id)`           | FK to the run that caused the change |
| `change_type`   | TEXT    | NOT NULL, CHECK(`'add'`, `'update'`, `'delist'`) | Type of mutation                     |
| `before_hash`   | TEXT    |                                                  | `content_hash` before the change     |
| `after_hash`    | TEXT    |                                                  | `content_hash` after the change      |
| `changed_at`    | TEXT    | NOT NULL                                         | ISO 8601 when the change occurred    |

### Change type semantics

| Type     | `before_hash` | `after_hash` | Meaning                                             |
| -------- | ------------- | ------------ | --------------------------------------------------- |
| `add`    | NULL          | hash         | New instrument appeared in a snapshot               |
| `update` | old hash      | new hash     | Instrument's CDM content changed                    |
| `delist` | old hash      | NULL         | Instrument was in the pool but absent from snapshot |

---

## Table: `quarantine`

Records that failed profile validation are stored here, never published to the
`instruments` table. The `status` column tracks whether a record has been
reprocessed or dismissed.

| Column            | Type    | Constraints                                                                      | Description                             |
| ----------------- | ------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| `id`              | INTEGER | PRIMARY KEY AUTOINCREMENT                                                        | Surrogate row id                        |
| `ingest_run_id`   | INTEGER | NOT NULL, REFERENCES `ingest_runs(id)`                                           | FK to the run that produced this record |
| `record_index`    | INTEGER | NOT NULL                                                                         | Zero-based index of record in snapshot  |
| `raw_record_json` | TEXT    | NOT NULL                                                                         | Full raw record as JSON string          |
| `failure_reasons` | TEXT    | NOT NULL                                                                         | JSON array of failure reason strings    |
| `created_at`      | TEXT    | NOT NULL                                                                         | ISO 8601 when quarantined               |
| `status`          | TEXT    | NOT NULL DEFAULT `'pending'`, CHECK(`'pending'`, `'reprocessed'`, `'dismissed'`) | Resolution status                       |

---

## Table: `aliases`

Synonym aliases for dictionary lookup (dictionary layer 4). Maps user-facing
terms to canonical field names. Used by the `DictionaryGenerator`
(`src/dictionary/dictionary-generator.ts`) to resolve free-text queries.

| Column            | Type    | Constraints                                               | Description                    |
| ----------------- | ------- | --------------------------------------------------------- | ------------------------------ |
| `id`              | INTEGER | PRIMARY KEY AUTOINCREMENT                                 | Surrogate row id               |
| `term`            | TEXT    | NOT NULL UNIQUE                                           | User-facing synonym            |
| `canonical_field` | TEXT    | NOT NULL                                                  | Canonical field name mapped to |
| `layer`           | TEXT    | NOT NULL, CHECK(`'cdm'`, `'ext'`, `'lineage'`, `'alias'`) | Dictionary layer               |
| `created_at`      | TEXT    | NOT NULL                                                  | ISO 8601 when created          |

### Seed aliases

The dictionary generator seeds four default aliases on first startup:

| Term        | Canonical field   |
| ----------- | ----------------- |
| `ticker`    | `venue_symbol`    |
| `board lot` | `board_lot`       |
| `exchange`  | `mic`             |
| `name`      | `instrument_name` |

---

## Indexes

| Index name                        | Table         | Columns                                             | Partial?                    | Purpose                                                 |
| --------------------------------- | ------------- | --------------------------------------------------- | --------------------------- | ------------------------------------------------------- |
| `idx_instruments_mic_symbol`      | `instruments` | `(mic, venue_symbol)`                               | `WHERE recorded_to IS NULL` | Primary lookup: find current instrument by MIC + symbol |
| `idx_identifiers_type_value`      | `identifiers` | `(type, value)`                                     | No                          | Look up instrument by ISIN/FIGI/CUSIP/SEDOL             |
| `idx_instruments_effective_dates` | `instruments` | `(mic, venue_symbol, effective_from, effective_to)` | No                          | Bitemporal as-of queries by business date               |
| `idx_instruments_recorded_dates`  | `instruments` | `(recorded_from, recorded_to)`                      | No                          | System-time range scans                                 |
| `idx_instruments_asset_class`     | `instruments` | `(asset_class, mic)`                                | No                          | Filter instruments by asset class + venue               |
| `idx_instruments_currency`        | `instruments` | `(currency)`                                        | No                          | Filter instruments by trading currency                  |
| `idx_instruments_ingest_run`      | `instruments` | `(ingest_run_id)`                                   | No                          | Walk from ingest run to its instrument rows             |
| `idx_changes_ingest_run`          | `changes`     | `(ingest_run_id)`                                   | No                          | Walk from ingest run to its change entries              |
| `idx_changes_type_date`           | `changes`     | `(change_type, changed_at)`                         | No                          | Query changes by type over time                         |
| `idx_quarantine_run`              | `quarantine`  | `(ingest_run_id)`                                   | No                          | Walk from ingest run to its quarantined records         |
| `idx_listings_instrument`         | `listings`    | `(instrument_id)`                                   | No                          | Walk from instrument to its listing attributes          |
| `idx_identifiers_instrument`      | `identifiers` | `(instrument_id)`                                   | No                          | Walk from instrument to its identifiers                 |
| `idx_sources_mic`                 | `sources`     | `(mic)`                                             | No                          | Look up approved sources for a venue                    |

The **partial unique index** `idx_instruments_mic_symbol` is the most important
index. It guarantees that at most one active (system-time-current) row exists
for any `(MIC, venue_symbol)` pair while leaving historical rows unbounded.

---

## Foreign key relationships

```
sources(id)
  └── instruments(source_id)         -- which source provided this data

ingest_runs(id)
  ├── instruments(ingest_run_id)     -- which run wrote this row
  ├── changes(ingest_run_id)         -- which run caused this change
  └── quarantine(ingest_run_id)      -- which run produced this quarantine

instruments(id)
  ├── listings(instrument_id)        -- listing attributes for this instrument
  ├── identifiers(instrument_id)     -- external identifiers for this instrument
  └── changes(instrument_id)         -- change history for this instrument
```

All foreign keys are declarative (`REFERENCES`) and enforced by the database
(`PRAGMA foreign_keys = ON`).

---

## Migration file reference

The schema is defined in `src/db/migrations/001-initial-schema.ts`. Each
migration exports a `Migration` object implementing the interface in
`src/db/migrator.ts`:

```typescript
export interface Migration {
  version: number;
  name: string;
  up(db: import("better-sqlite3").Database): void;
}
```

Migrations are applied in version order by the `Migrator` class. Already-applied
versions are tracked in the `migrations` table and skipped on subsequent runs.
The `up()` function runs inside a transaction per migration.

To add a new migration:

1. Create `src/db/migrations/NNN-short-name.ts` with a version higher than all existing ones.
2. Export a `Migration` object with the DDL in its `up()` function.
3. Import and add it to the migration list in all call sites that invoke `migrator.migrate([...])`.

Current call sites that reference the migration list:

- `src/cli/narwhal.ts` (CLI entry point)
- `src/cli/source-cli.ts` (source admin tool)
- `src/cli/ingest-cli.ts` (ingest CLI)
- `src/db/pool-store.ts` (PoolStore class)
