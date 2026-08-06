# CDM version management

The narwhal data hub targets a specific version of the
[FINOS Common Domain Model (CDM)](https://www.finos.org/common-domain-model).
The version is pinned in a single place and flows through the assembler,
validator, dictionary, and profiles.

---

## Where the CDM version is pinned

**File:** `config/stock-profile.json` (and per-asset-class profiles)

Each profile declares a `cdm_version` field:

```json
{
  "profile_name": "stock-v1",
  "asset_class": "stock",
  "cdm_version": "5.0.0",
  "required_fields": [ ... ]
}
```

The `cdm_version` is a string following CDM release numbering (e.g. `"5.0.0"`).

### Profiles that carry the version

| Profile file                           | Asset class        | Current version |
| -------------------------------------- | ------------------ | --------------- |
| `config/stock-profile.json`            | `stock`            | `5.0.0`         |
| `config/commodity-future-profile.json` | `commodity_future` | `5.0.0`         |

Each profile also carries a `profile_name` (e.g. `"stock-v1"`) that acts as a
stable reference key -- the version is purely informational from the profile
name's perspective, but it signals to consumers which CDM release the field
paths and type names correspond to.

---

## How to upgrade the CDM version

### Step 1: Update profile configs

Change the `cdm_version` field in each profile file to the new version:

```diff
-  "cdm_version": "5.0.0",
+  "cdm_version": "6.0.0",
```

Do this for every profile in `config/`:

- `config/stock-profile.json`
- `config/commodity-future-profile.json`
- Any additional per-asset-class profiles.

### Step 2: Review profile field paths

Each `required_fields` entry references a `cdm_path` that corresponds to a
field in the CDM schema. When upgrading CDM versions, these paths may have
changed between releases. Review every `cdm_path` against the new CDM version's
schema:

| Profile field                     | Check                                                   |
| --------------------------------- | ------------------------------------------------------- |
| `instrument.identifiers[]`        | Still an array of `{ type, value }` objects?            |
| `instrument.name`                 | Still a scalar string field?                            |
| `instrument.currency`             | Still a scalar string field?                            |
| `instrument.type`                 | Valid values still include `Equity`, `CommodityFuture`? |
| `instrument.listing.mic`          | Path still intact?                                      |
| `instrument.listing.venue_symbol` | Path still intact?                                      |
| `instrument.attributes.*`         | Still the extension bag pattern?                        |

The actual CDM-to-profile mapping is done by the assembler
(`src/assembler/cdm-assembler.ts`) which traverses the `cdm_path` to construct
nested objects. If CDM paths have changed upstream, update the paths and the
assembler logic to match.

### Step 3: Update CDM type definitions

**File:** `config/cdm-types.json`

This file declares the CDM type names and definitions used by the dictionary
generator (layer 1 of the dictionary). After a CDM upgrade, update this file to
reflect any new, renamed, or removed types in the new release:

```json
{
  "cdm_version": "6.0.0",
  "types": [
    { "name": "Product", "definition": "...", "see_also": ["Instrument", ...] },
    { "name": "Instrument", "definition": "...", "see_also": ["Product", ...] },
    ...
  ]
}
```

### Step 4: Regenerate the dictionary

The dictionary generator (`src/dictionary/dictionary-generator.ts`) reads from
three config files on every `regenerate()` call:

| Layer | Source file                 | What it provides            |
| ----- | --------------------------- | --------------------------- |
| 1     | `config/cdm-types.json`     | CDM type definitions        |
| 2     | `config/extensions.json`    | Extension field definitions |
| 3     | `config/stock-profile.json` | Source-to-CDM field lineage |
| 4     | `aliases` table in SQLite   | Synonym aliases             |

After updating the CDM version, regenerate the dictionary to pick up the new
type definitions and any changed lineage:

```bash
# If using the MCP server, the dictionary regenerates on startup.
# To regenerate without restarting, trigger the regen-dictionary tool
# (if exposed by the MCP server), or restart the MCP server process.
```

The dictionary exposes its entries via `dict://` URIs:

- `dict://cdm/Instrument` -- CDM type lookup
- `dict://ext/board_lot` -- extension field lookup
- `dict://lineage/instrument.identifiers[]` -- source-to-CDM lineage
- `dict://alias/ticker` -- alias resolution

### Step 5: Update extension registry (if needed)

**File:** `config/extensions.json`

The extension registry declares fields that CDM does not model natively (board
lot, tick size, contract size, etc.). After a CDM upgrade, review whether any
extension fields are now covered by the CDM itself. If so, remove them from
extensions and add them to the profile's `required_fields` instead.

The `extensions_version` field in `config/extensions.json` is independent of
`cdm_version` and should be bumped whenever extension definitions change.

### Step 6: Run the test suite

```bash
npx vitest run
```

Key test files to watch:

- `test/cdm-assembler.test.ts` -- verifies CDM document assembly with current profiles
- `test/profile-validator.test.ts` -- verifies validation against current profiles
- `test/mcp-dictionary.test.ts` -- verifies dictionary generation and lookup

---

## What artifacts are affected by a CDM version change

| Artifact               | File(s)                                      | Impact                                           |
| ---------------------- | -------------------------------------------- | ------------------------------------------------ |
| CDM document shape     | `src/assembler/cdm-assembler.ts`             | Output JSON structure may change                 |
| Assembled CDM content  | `cdm_json` column in `instruments` table     | Existing rows retain old-version CDM JSON        |
| Profile field mappings | `config/*-profile.json`                      | `cdm_path` entries may need updating             |
| Profile validation     | `src/validator/profile-validator.ts`         | Field presence checks may need adjusting         |
| CDM type dictionary    | `config/cdm-types.json`                      | Type definitions must match new CDM release      |
| Dictionary URIs        | `dict://cdm/*`                               | Type names/definitions change                    |
| Dictionary lineage     | `dict://lineage/*`                           | Source-to-CDM path mappings may change           |
| Extension definitions  | `config/extensions.json`                     | Fields may become CDM-native                     |
| Content hash           | `content_hash` column in `instruments` table | Old hashes remain valid (computed from old JSON) |

**Important:** Upgrading the CDM version does **not** retroactively change
existing rows in the `instruments` table. Rows written under the old CDM version
retain their `cdm_json` and `content_hash` as-serialized. New ingests will use
the new profile and produce CDM JSON against the new version. Downstream
consumers reading `cdm_json` should check the profile's `cdm_version` to know
which schema to expect.

---

## Rollback

To revert a CDM version upgrade:

1. Restore all profile `cdm_version` fields to the previous value.
2. Restore `config/cdm-types.json` to the previous version.
3. Restore any changed `cdm_path` entries in profiles.
4. Regenerate the dictionary.
5. Run the test suite.

Newer rows written under the upgraded version will have CDM JSON matching the
newer schema. If rollback absolutely requires purging those rows, delete them
from the `instruments` table and re-process the affected ingests with the old
profile.
