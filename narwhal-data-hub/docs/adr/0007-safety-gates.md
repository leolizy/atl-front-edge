# ADR-0007: Per-venue safety gates with all-or-nothing quarantine

**Status:** Accepted
**Date:** 2026-08-03

## Context

Ingest pipelines process external data — and external data is unreliable. A malformed snapshot (garbled file, wrong format), a venue migration that changes column layout, or a data feed error could corrupt the pool by inserting bad records or delisting valid ones en masse. The pool is the source of truth for downstream consumers; corruption there propagates everywhere.

The risk is asymmetric: a false negative (failing to load good data) is a delay — fixable by retry. A false positive (loading bad data) is corruption — requires pool rollback or manual repair. The gates should err toward quarantine.

## Decision

**Two per-venue safety gates, both must pass for the run to apply. If either trips, the entire run is quarantined — zero pool mutations.**

### Gates

| Gate             | What it measures                                      | Default threshold |
| ---------------- | ----------------------------------------------------- | ----------------- |
| Parse-error rate | `parse_failures / total_records`                      | 0.10 (10%)        |
| Mass-change rate | `(adds + updates + delistings) / active_pool_records` | 0.25 (25%)        |

### Behavior

- Both gates must PASS for the run to apply to the pool.
- If either gate trips: the run is recorded with `outcome = "quarantined"`, the trip reason in `error_message`, and **zero pool mutations** (never partial application).
- Thresholds are **per-venue configurable** with operator overrides; defaults ship in venue config.
- Gates run **after validation but before delta apply** — the pipeline validates all records first (producing a quarantine count), then checks gates before committing to the pool.

### Rationale for defaults

- **10% parse-error rate**: a single digit error rate is normal (one bad row in a hundred). Above 10% suggests a systemic issue — format change, wrong file, or corrupted download.
- **25% mass-change rate**: reference data is slow-changing. 1-5% churn per day is normal (new listings, a few delistings). 25% suggests a venue migration, index rebalance, or data feed error. The threshold is deliberately loose — it catches catastrophes, not normal churn.

## Consequences

- **Pool integrity**: a corrupt snapshot cannot partially damage the pool. The run is either fully applied or fully rejected.
- **False-positive quarantine risk**: a legitimate venue migration (e.g., index rebalance changing 40% of constituents) would trip the mass-change gate. The operator can override the threshold for that venue + that run. This is manual by design — a human should confirm a mass change is legitimate before it hits the pool.
- **No partial application**: even if 99% of records are valid, a tripped gate quarantines them all. This is deliberate — partial loads produce inconsistent state (some records updated, some not) that is harder to reason about than a clean retry.
- **Per-venue isolation**: a gate trip for XNYS never affects XHKG. Each venue's pipeline run is independent.

## Alternatives considered

- **Partial application (apply valid records, skip bad ones)**: simpler per-run, but produces inconsistent pool state. If half the records update and half don't, the pool no longer represents any real point in time. Rejected.
- **Single global gate**: one threshold for all venues. Rejected — a 25% mass-change rate is normal for a venue with 10 instruments (2-3 changes) but catastrophic for one with 5000. Per-venue thresholds are necessary.
- **Adaptive thresholds**: machine-learned from historical churn patterns. Overengineered for v1 — static defaults with operator override cover the cases that matter.
- **More gate types** (per-field validation rate, duplicate rate, etc.): can be added later as new gate functions in the same pattern. The current two cover the highest-signal failure modes.
