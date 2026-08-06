# Adding a venue (venue expansion guide)

This guide walks through adding venue #7 (or any new venue) to the narwhal data
hub. Each step references actual file paths from the codebase, and the example
code mirrors the existing XNYS (NYSE) adapter to keep things concrete.

By the end of this guide, the new venue will be ingested end-to-end:
fetch -> parse -> assemble CDM -> validate -> write to pool -> audit trail.

---

## Prerequisites

- A working local checkout of this repository.
- Node.js >= 18, dependencies installed (`npm install`).
- The database initialized: `npx narwhal source list` (creates `./data/pool.db` if absent).
- The venue's MIC code (ISO 10383, e.g. `"XNYS"`, `"XHKG"`, `"XCME"`).
- A sample data file from the venue (CSV or whatever format the venue publishes).

---

## Step 1: Add the MIC to the adapter registry

**File:** `src/cli/ingest-cli.ts`

The ingest CLI holds a static `ADAPTERS` map that routes MIC codes to adapter
implementations. Add an entry for your new venue.

```typescript
import { xnysAdapter } from "../adapters/xnys-adapter.js";
// Add your new import:
import { xnewAdapter } from "../adapters/xnew-adapter.js";

const ADAPTERS: Record<string, Adapter> = {
  XNYS: xnysAdapter,
  XNEW: xnewAdapter, // <-- add this line
};
```

If the new venue has a different profile (e.g. commodity futures), you will pass
`--profile` at the CLI. The default profile path is `./config/stock-profile.json`.

---

## Step 2: Write the new adapter

**Files to create:** `src/adapters/xnew-adapter.ts`
**Files to update:** `src/adapters/index.ts`
**Reference:** `src/adapters/xnys-adapter.ts` (stock example), `src/adapters/xcme-adapter.ts` (commodity example)

Every adapter implements the `Adapter` contract defined in `src/adapters/adapter.ts`:

```typescript
export interface Adapter {
  parse(fileBytes: Buffer, venueContext: VenueContext): NormalizedRecord[];
}
```

The `VenueContext` (from `src/adapters/types.ts`) carries:

- `mic` -- the venue MIC (e.g. `"XNEW"`)
- `instrument_category` -- asset class (e.g. `"stock"`, `"commodity_future"`)
- `profile_reference` -- profile name (e.g. `"stock-v1"`)

The adapter must return an array of `NormalizedRecord` objects:

```typescript
export interface NormalizedRecord {
  venue_symbol: string; // Ticker on this venue
  isin: string; // ISO 6166 ISIN
  instrument_name: string; // Human-readable name
  currency: string; // ISO 4217
  asset_class: string; // "stock" or "commodity_future"
  mic: string; // Venue MIC
  attributes: Record<string, string>; // Venue-specific extras
}
```

### Minimal adapter example (CSV format)

```typescript
// src/adapters/xnew-adapter.ts
import type { Adapter } from "./adapter.js";
import type { NormalizedRecord, VenueContext } from "./types.js";

export const xnewAdapter: Adapter = {
  parse(fileBytes: Buffer, venueContext: VenueContext): NormalizedRecord[] {
    const content = fileBytes.toString("utf-8").trim();
    if (content.length === 0) return [];

    const lines = content.split("\n");
    if (lines.length < 2) return []; // header only

    const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
    const symbolIdx = header.indexOf("symbol");
    const nameIdx = header.indexOf("name");
    const isinIdx = header.indexOf("isin");
    const currencyIdx = header.indexOf("currency");
    const micIdx = header.indexOf("mic");
    const assetClassIdx = header.indexOf("asset_class");

    // Validate required columns
    const missing: string[] = [];
    if (symbolIdx === -1) missing.push("symbol");
    if (nameIdx === -1) missing.push("name");
    if (isinIdx === -1) missing.push("isin");
    if (currencyIdx === -1) missing.push("currency");
    if (micIdx === -1) missing.push("mic");
    if (assetClassIdx === -1) missing.push("asset_class");
    if (missing.length > 0) {
      throw new Error(
        `XNEW adapter: missing required columns: ${missing.join(", ")}`
      );
    }

    const records: NormalizedRecord[] = [];
    const coreIndices = new Set([
      symbolIdx,
      nameIdx,
      isinIdx,
      currencyIdx,
      micIdx,
      assetClassIdx,
    ]);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!.trimEnd();
      if (line.length === 0) continue;

      const cols = line.split(",").map((c) => c.trim());
      const symbol = cols[symbolIdx];
      const name = cols[nameIdx];
      const isin = cols[isinIdx];
      const currency = cols[currencyIdx];
      const mic = cols[micIdx];
      const assetClass = cols[assetClassIdx];

      if (!symbol || !name || !isin || !currency || !mic || !assetClass) {
        throw new Error(
          `XNEW adapter: row ${i + 1} has empty required column(s)`
        );
      }

      // Capture extra columns as attributes
      const attributes: Record<string, string> = {};
      for (let c = 0; c < cols.length; c++) {
        if (!coreIndices.has(c)) {
          attributes[header[c] ?? `col_${c}`] = cols[c] ?? "";
        }
      }

      records.push({
        venue_symbol: symbol,
        instrument_name: name,
        isin,
        currency,
        asset_class: assetClass,
        mic,
        attributes,
      });
    }

    return records;
  },
};
```

### Register the adapter in the barrel export

```typescript
// src/adapters/index.ts -- add:
export { xnewAdapter } from "./xnew-adapter.js";
```

---

## Step 3: Capture a fixture file

**Directory:** `test/fixtures/`

Create a small sample CSV file with real-looking (but safe for tests) data.
Existing fixtures for reference:

- `test/fixtures/xnys-sample.csv` -- 5 stock symbols
- `test/fixtures/xcme-sample.csv` -- 5 commodity futures with extra columns

**Minimal fixture** (`test/fixtures/xnew-sample.csv`):

```
symbol,name,isin,currency,mic,asset_class
ABC,Alpha Beta Corp,US1234567890,USD,XNEW,stock
XYZ,XYZ Holdings,US0987654321,USD,XNEW,stock
```

**Write the adapter test** (`test/xnew-adapter.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { xnewAdapter } from "../src/adapters/xnew-adapter.js";
import type { VenueContext } from "../src/adapters/types.js";

const venueContext: VenueContext = {
  mic: "XNEW",
  instrument_category: "stock",
  profile_reference: "stock-v1",
};

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(__dirname, "fixtures", name));
}

describe("xnewAdapter", () => {
  it("parses the xnew-sample fixture", () => {
    const bytes = loadFixture("xnew-sample.csv");
    const records = xnewAdapter.parse(bytes, venueContext);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      venue_symbol: "ABC",
      instrument_name: "Alpha Beta Corp",
      isin: "US1234567890",
      currency: "USD",
      asset_class: "stock",
      mic: "XNEW",
    });
  });

  it("returns empty array for empty file", () => {
    expect(xnewAdapter.parse(Buffer.from(""), venueContext)).toEqual([]);
  });

  it("throws when required columns are missing", () => {
    const csv = Buffer.from("symbol,isin\nABC,US1234567890\n");
    expect(() => xnewAdapter.parse(csv, venueContext)).toThrow(
      /missing required columns/
    );
  });
});
```

Run the tests:

```bash
npx vitest run test/xnew-adapter.test.ts
```

---

## Step 4: Define profile + extensions (only if new asset class)

**If the venue uses an existing asset class** (`stock` or `commodity_future`),
skip this step. The existing profiles (`config/stock-profile.json`,
`config/commodity-future-profile.json`) already cover the field mappings.

**If the venue introduces a new asset class** (e.g. "bond", "fund"):

### 4a. Create a new profile

**File:** `config/<class>-profile.json`

```json
{
  "profile_name": "bond-v1",
  "asset_class": "bond",
  "cdm_version": "5.0.0",
  "required_fields": [
    {
      "cdm_path": "instrument.identifiers[]",
      "source": "isin",
      "scheme": "ISIN"
    },
    { "cdm_path": "instrument.name", "source": "instrument_name" },
    { "cdm_path": "instrument.currency", "source": "currency" },
    { "cdm_path": "instrument.type", "value": "Bond" },
    { "cdm_path": "instrument.listing.mic", "source": "mic" },
    { "cdm_path": "instrument.listing.venue_symbol", "source": "venue_symbol" }
  ]
}
```

The `cdm_path` entries tell the CDM assembler (`src/assembler/cdm-assembler.ts`)
where to place each value in the output document. Fields with a `value` (instead
of `source`) are literal constants -- e.g. `"value": "Bond"` hard-codes the
instrument type. Fields with `cdm_path` ending in `[]` are collected into
identifier arrays.

### 4b. Add new extensions (if needed)

**File:** `config/extensions.json`

If the new asset class needs extension fields not already declared, add them to
the `fields` array. Each extension declares a name, type (`"string"`, `"number"`,
or `"integer"`), description, and `applicable_asset_classes`.

The extension registry (`src/registry/extension-registry.ts`) validates the
config at load time and rejects duplicates.

### 4c. Update the migration CHECK constraint

**File:** `src/db/migrations/001-initial-schema.ts`

The `asset_class` column on `instruments` has a CHECK constraint:

```sql
CHECK(asset_class IN ('stock', 'commodity_future'))
```

A new asset class requires a new migration to widen this constraint:

```sql
-- In a new migration file (e.g., 002-add-bond-class):
ALTER TABLE instruments RENAME TO instruments_old;
CREATE TABLE instruments ( ... same schema, CHECK includes 'bond' ... );
INSERT INTO instruments SELECT * FROM instruments_old;
DROP TABLE instruments_old;
```

---

## Step 5: Approve the source

The snapshot fetcher (`src/sources/snapshot-fetcher.ts`) refuses to fetch from
any location that has not been approved in the `sources` table. Use the CLI
admin tool to approve:

```bash
npx narwhal source approve XNEW https://example.com/snapshots/xnew-daily.csv
npx narwhal source approve XNEW file:///data/snapshots/xnew-daily.csv --note "Local mirror for testing"
```

Verify the approval:

```bash
npx narwhal source list --mic XNEW
```

This calls `SourceRegistry.approve_source()` in `src/sources/source-registry.ts`,
which inserts a row into the `sources` table with the approver (taken from the
`USER` environment variable), timestamp, and optional terms note.

---

## Step 6: Run backfill (if historical data exists)

**CLI command:**

```bash
npx narwhal ingest XNEW --file /data/backfill/xnew-2026-01-01.csv --effective-date 2026-01-01
```

The `--file` flag bypasses the fetcher and reads directly from disk -- this is
how historical backfill works. The `--effective-date` sets the business date for
the run, which becomes the `effective_from` date on all resulting instrument
rows.

For multiple historical snapshots, iterate over files in date order:

```bash
for f in /data/backfill/xnew-2026-*.csv; do
  date=$(basename "$f" | sed 's/xnew-\(.*\)\.csv/\1/')
  npx narwhal ingest XNEW --file "$f" --effective-date "$date"
done
```

**What happens during ingest** (pipeline flow in `src/pipeline/ingest-pipeline.ts`):

1. Read file bytes (from disk in backfill mode; from source in production mode).
2. Parse via the adapter -> `NormalizedRecord[]`.
3. Assemble each record into CDM JSON via `assemble()` in `src/assembler/cdm-assembler.ts`.
4. Validate each CDM document against the profile via `validate()` in `src/validator/profile-validator.ts`.
5. Failed records are quarantined in the `quarantine` table.
6. The delta engine (`src/delta/delta-engine.ts`) diffs accepted records against current pool state and applies adds/updates/delistings.
7. Safety gates check parse-error rate (>10%) and mass-change rate (>25%).

**Review the backfill results:**

```bash
# Check the ingest run
sqlite3 ./data/pool.db "SELECT id, outcome, records_added, records_updated, records_total FROM ingest_runs WHERE venue='XNEW' ORDER BY id DESC LIMIT 5;"

# Check instruments were added
sqlite3 ./data/pool.db "SELECT mic, venue_symbol, instrument_name, effective_from FROM instruments WHERE mic='XNEW' AND recorded_to IS NULL;"

# Check for quarantined records
sqlite3 ./data/pool.db "SELECT id, record_index, failure_reasons FROM quarantine WHERE ingest_run_id IN (SELECT id FROM ingest_runs WHERE venue='XNEW');"
```

---

## Step 7: Add to cron schedule

**What to schedule:** the production ingest command (without `--file`):

```bash
npx narwhal ingest XNEW
```

This command uses the snapshot fetcher to pull the latest snapshot from approved
sources. The fetcher iterates through approved source locations (most-recently-
approved first) and returns the first successful fetch.

**Example crontab entry** (runs daily at 02:00 UTC):

```
0 2 * * * cd /opt/narwhal-data-hub && npx narwhal ingest XNEW >> /var/log/narwhal/xnew.log 2>&1
```

**Before adding to cron**, test a production fetch manually (after approving a
source in Step 5 and ensuring a snapshot is available at the approved location):

```bash
npx narwhal ingest XNEW
```

**Monitor the run** by checking the `ingest_runs` table:

```bash
sqlite3 ./data/pool.db "SELECT id, outcome, records_added, records_updated, records_delisted, records_quarantined, run_completed_at FROM ingest_runs WHERE venue='XNEW' ORDER BY id DESC LIMIT 3;"
```

### Ingest run outcomes to watch for

| Outcome       | Action                                                          |
| ------------- | --------------------------------------------------------------- |
| `success`     | No action needed.                                               |
| `partial`     | Check the `quarantine` table for failed records.                |
| `quarantined` | A safety gate tripped. Review the `error_message` on the run.   |
| `failed`      | Adapter parse error or file unreadable. Fix and re-run.         |
| `unavailable` | The fetcher could not reach any approved source. Check network. |

---

## Quick reference: files touched when adding a venue

| File                              | Action                                     |
| --------------------------------- | ------------------------------------------ |
| `src/adapters/xnew-adapter.ts`    | **Create** -- new adapter implementation   |
| `src/adapters/index.ts`           | **Edit** -- add re-export                  |
| `src/cli/ingest-cli.ts`           | **Edit** -- add to `ADAPTERS` map          |
| `test/fixtures/xnew-sample.csv`   | **Create** -- test fixture                 |
| `test/xnew-adapter.test.ts`       | **Create** -- adapter tests                |
| `config/<class>-profile.json`     | **Create** -- only if new asset class      |
| `config/extensions.json`          | **Edit** -- only if new extension fields   |
| `src/db/migrations/NNN-<name>.ts` | **Create** -- only if schema change needed |
| `sources` table (via CLI)         | **Insert** -- approve the source           |
| Cron / scheduler config           | **Edit** -- add daily ingest command       |
