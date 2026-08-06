import type { Migration } from "../migrator.js";

export const migration001: Migration = {
  version: 1,
  name: "initial-v1-schema",
  up(db): void {
    db.exec(`
      -- Core instrument pool: every row is a version, never mutated in-place
      CREATE TABLE instruments (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        mic             TEXT NOT NULL,
        venue_symbol    TEXT NOT NULL,
        asset_class     TEXT NOT NULL CHECK(asset_class IN ('stock', 'commodity_future')),
        currency        TEXT NOT NULL,
        cdm_json        TEXT NOT NULL,  -- full CDM JSON document
        content_hash    TEXT NOT NULL,  -- SHA-256 of canonical CDM JSON
        -- bitemporal columns
        effective_from  TEXT NOT NULL,  -- business date (YYYY-MM-DD)
        effective_to    TEXT,           -- null = open-ended (still active in business time)
        recorded_from   TEXT NOT NULL,  -- system time when this row was written (ISO 8601)
        recorded_to     TEXT,           -- null = current system version
        -- provenance
        source_id       INTEGER REFERENCES sources(id),
        ingest_run_id   INTEGER REFERENCES ingest_runs(id)
      );

      -- Per-instrument listing attributes that CDM does not model natively
      CREATE TABLE listings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument_id   INTEGER NOT NULL REFERENCES instruments(id),
        mic             TEXT NOT NULL,
        board_lot       INTEGER,
        tick_size       REAL,
        trading_hours   TEXT,
        contract_size   REAL,
        delivery_months TEXT,
        tick_value      REAL,
        settlement_method TEXT
      );

      -- Cross-reference table for vendor/external identifiers
      CREATE TABLE identifiers (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument_id   INTEGER NOT NULL REFERENCES instruments(id),
        type            TEXT NOT NULL CHECK(type IN ('ISIN', 'FIGI', 'CUSIP', 'SEDOL')),
        value           TEXT NOT NULL,
        UNIQUE(type, value)
      );

      -- Approved source registry — the fetcher refuses anything not listed here
      CREATE TABLE sources (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        mic             TEXT NOT NULL,
        location        TEXT NOT NULL,
        approver        TEXT NOT NULL,
        approved_at     TEXT NOT NULL,
        terms_note      TEXT
      );

      -- Every pipeline execution recorded
      CREATE TABLE ingest_runs (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        venue               TEXT NOT NULL,
        window_start        TEXT,
        window_end          TEXT,
        file_hash           TEXT,
        file_name           TEXT,
        records_total       INTEGER NOT NULL DEFAULT 0,
        records_added       INTEGER NOT NULL DEFAULT 0,
        records_updated     INTEGER NOT NULL DEFAULT 0,
        records_delisted    INTEGER NOT NULL DEFAULT 0,
        records_quarantined INTEGER NOT NULL DEFAULT 0,
        outcome             TEXT NOT NULL CHECK(outcome IN ('success', 'partial', 'quarantined', 'failed', 'unavailable')),
        error_message       TEXT,
        run_started_at      TEXT NOT NULL,
        run_completed_at    TEXT
      );

      -- Change audit trail — one row per instrument-level change per run
      CREATE TABLE changes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument_id   INTEGER REFERENCES instruments(id),
        ingest_run_id   INTEGER NOT NULL REFERENCES ingest_runs(id),
        change_type     TEXT NOT NULL CHECK(change_type IN ('add', 'update', 'delist')),
        before_hash     TEXT,
        after_hash      TEXT,
        changed_at      TEXT NOT NULL
      );

      -- Records that failed profile validation — quarantined, never published
      CREATE TABLE quarantine (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ingest_run_id   INTEGER NOT NULL REFERENCES ingest_runs(id),
        record_index    INTEGER NOT NULL,
        raw_record_json TEXT NOT NULL,
        failure_reasons TEXT NOT NULL,  -- JSON array of reason strings
        created_at      TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'reprocessed', 'dismissed'))
      );

      -- Synonym aliases for dictionary lookup (layer 4 of the dictionary)
      CREATE TABLE aliases (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        term            TEXT NOT NULL UNIQUE,
        canonical_field TEXT NOT NULL,
        layer           TEXT NOT NULL CHECK(layer IN ('cdm', 'ext', 'lineage', 'alias')),
        created_at      TEXT NOT NULL
      );

      -- Indexes for common query patterns

      -- Primary lookup: MIC + venue symbol
      CREATE UNIQUE INDEX idx_instruments_mic_symbol
        ON instruments(mic, venue_symbol)
        WHERE recorded_to IS NULL;

      -- Identifier lookups
      CREATE INDEX idx_identifiers_type_value
        ON identifiers(type, value);

      -- Bitemporal as_of queries
      CREATE INDEX idx_instruments_effective_dates
        ON instruments(mic, venue_symbol, effective_from, effective_to);

      CREATE INDEX idx_instruments_recorded_dates
        ON instruments(recorded_from, recorded_to);

      -- Search by asset class, currency
      CREATE INDEX idx_instruments_asset_class
        ON instruments(asset_class, mic);

      CREATE INDEX idx_instruments_currency
        ON instruments(currency);

      -- Foreign key walk
      CREATE INDEX idx_instruments_ingest_run
        ON instruments(ingest_run_id);

      CREATE INDEX idx_changes_ingest_run
        ON changes(ingest_run_id);

      CREATE INDEX idx_changes_type_date
        ON changes(change_type, changed_at);

      CREATE INDEX idx_quarantine_run
        ON quarantine(ingest_run_id);

      CREATE INDEX idx_listings_instrument
        ON listings(instrument_id);

      CREATE INDEX idx_identifiers_instrument
        ON identifiers(instrument_id);

      CREATE INDEX idx_sources_mic
        ON sources(mic);
    `);
  },
};
