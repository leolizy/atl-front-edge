# ADR-0003: profile validation over raw CDM

**Status:** Accepted
**Date:** 2026-08-02

## Context

The FINOS CDM schemas define the full model with many mandatory fields. Venue files cannot satisfy every mandatory CDM field — exchange reference files simply don't carry all the data the CDM models. Validating venue records directly against raw CDM schemas would reject every record.

## Decision

**Declared CDM profiles per instrument category** (stock, commodity future): versioned declarations of exactly which CDM types/fields the pool commits to populate, plus extension fields. Ingest validates against the profile; failures are quarantined with reasons. Raw-CDM validation is explicitly rejected.

## Consequences

- The pool publishes only what it can actually populate from venue files.
- Profiles are the contract between adapters (what they must produce) and the pool (what it guarantees to store).
- Adding a new field requires updating the profile, the adapter, and the CDM assembler — a deliberate, coordinated change.
- Downstream consumers know exactly what coverage to expect.
- Extension fields (MIC, board lot, tick size, etc.) have a defined home in the extension registry rather than being silently absent.

## Alternatives considered

- **Validate against raw CDM, relax constraints**: fighting the schema tooling; profiles are explicit and versioned.
- **No validation — trust the adapters**: adapter bugs would silently corrupt the pool. Quarantine catches them at the boundary.
