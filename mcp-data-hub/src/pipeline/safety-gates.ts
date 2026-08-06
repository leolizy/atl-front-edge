/**
 * Safety gates for the ingest pipeline.
 *
 * Two gates are checked before applying a delta:
 * 1. Parse-error rate: fraction of records that failed validation.
 * 2. Mass-change rate: fraction of pool records that would change (adds +
 *    updates + delistings) relative to the current active pool.
 *
 * Both must pass; failing either quarantines the entire run with zero pool
 * mutations.
 */

// ---------------------------------------------------------------------------
// Default thresholds (overridable per venue)
// ---------------------------------------------------------------------------

export const DEFAULT_PARSE_ERROR_THRESHOLD = 0.1;
export const DEFAULT_MASS_CHANGE_THRESHOLD = 0.25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single gate check. */
export interface GateResult {
  passed: boolean;
  /** Human-readable reason when the gate trips. */
  reason?: string;
}

/** A named gate + its result, used by {@link applySafetyGates}. */
export interface SafetyGateCheck {
  name: string;
  result: GateResult;
}

/** Final aggregated result from {@link applySafetyGates}. */
export interface SafetyGatesResult {
  status: "ok" | "quarantined";
  /** Concatenated trip reason when status is "quarantined". */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Gate checks
// ---------------------------------------------------------------------------

/**
 * Check whether the parse-error (validation-failure) rate exceeds the
 * configured threshold.
 *
 * @param failures  Number of records that failed validation.
 * @param total     Total number of records in the snapshot.
 * @param threshold Maximum acceptable failure rate (default 0.10).
 */
export function checkParseErrorRate(
  failures: number,
  total: number,
  threshold: number = DEFAULT_PARSE_ERROR_THRESHOLD
): GateResult {
  if (total === 0) return { passed: true };
  const rate = failures / total;
  if (rate > threshold) {
    return {
      passed: false,
      reason: `Parse error rate ${(rate * 100).toFixed(1)}% exceeds threshold ${(threshold * 100).toFixed(0)}% (${failures}/${total})`,
    };
  }
  return { passed: true };
}

/**
 * Check whether the mass-change fraction exceeds the configured threshold.
 *
 * "Mass change" is defined as (adds + updates + delistings) — the total
 * number of pool records that would be touched by this delta — divided by
 * the current active pool size.
 *
 * @param changes    Expected number of changed pool records (adds + updates + delistings).
 * @param poolTotal  Current active pool record count.
 * @param threshold  Maximum acceptable change rate (default 0.25).
 */
export function checkMassChangeRate(
  changes: number,
  poolTotal: number,
  threshold: number = DEFAULT_MASS_CHANGE_THRESHOLD
): GateResult {
  if (poolTotal === 0) return { passed: true };
  const rate = changes / poolTotal;
  if (rate > threshold) {
    return {
      passed: false,
      reason: `Mass change rate ${(rate * 100).toFixed(1)}% exceeds threshold ${(threshold * 100).toFixed(0)}% (${changes}/${poolTotal})`,
    };
  }
  return { passed: true };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Evaluate a set of named gate checks.  Returns "ok" when every gate passes;
 * "quarantined" + the first trip reason otherwise.
 */
export function applySafetyGates(gates: SafetyGateCheck[]): SafetyGatesResult {
  for (const gate of gates) {
    if (!gate.result.passed) {
      return {
        status: "quarantined",
        reason: `${gate.name}: ${gate.result.reason}`,
      };
    }
  }
  return { status: "ok" };
}
