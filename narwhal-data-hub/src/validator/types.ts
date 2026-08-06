/** A single validation failure describing what went wrong. */
export interface ValidationFailure {
  /** The CDM path (from the profile) that failed validation. */
  field: string;
  /** Human-readable reason for the failure. */
  reason: string;
}

/** Result of validating a CDM document against a profile. */
export interface ValidationResult {
  /** True when the document passes all checks. */
  valid: boolean;
  /** List of failures (empty when valid). */
  failures: ValidationFailure[];
}
