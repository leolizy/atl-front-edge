import type Database from "better-sqlite3";
import type {
  StockProfile,
  StockProfileField,
  CdmDocument,
} from "../assembler/types.js";
import type { ValidationResult, ValidationFailure } from "./types.js";

/** Path segment suffix signalling array semantics (same convention as the assembler). */
const ARRAY_SUFFIX = "[]";

function isArrayPath(path: string): boolean {
  return path.endsWith(ARRAY_SUFFIX);
}

function arrayBasePath(path: string): string {
  return path.slice(0, -ARRAY_SUFFIX.length);
}

/** Retrieve a value at a dotted path from a nested object, returning undefined when any segment is missing. */
function getAtPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/** Check that a value is a non-empty string (the expected type for scalar profile fields). */
function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate a scalar field (non-array cdm_path).
 *
 * Dispatches by field.type:
 * - "string" (default): the CDM value must be a non-empty string (or literal match)
 * - "number": the CDM value must be a finite number
 * - "object": the CDM value must be a non-null object
 */
function validateScalarField(
  doc: CdmDocument,
  field: StockProfileField
): ValidationFailure | null {
  const val = getAtPath(doc, field.cdm_path);

  if (field.value !== undefined) {
    if (val !== field.value) {
      return {
        field: field.cdm_path,
        reason: `expected literal "${field.value}", got ${JSON.stringify(val)}`,
      };
    }
    return null;
  }

  // Type-aware validation: dispatch by field.type, default "string"
  if (field.type === "number") {
    if (typeof val !== "number" || Number.isNaN(val)) {
      return {
        field: field.cdm_path,
        reason: `expected a number, got ${typeof val}`,
      };
    }
    return null;
  }

  if (field.type === "object") {
    if (val === null || typeof val !== "object") {
      return {
        field: field.cdm_path,
        reason: `expected a non-null object, got ${typeof val}`,
      };
    }
    return null;
  }

  // Default: "string" — backward-compatible behavior
  if (field.source !== undefined) {
    if (!isNonEmptyString(val)) {
      return {
        field: field.cdm_path,
        reason: `required field sourced from "${field.source}" is missing or empty`,
      };
    }
    return null;
  }

  // No source, no value — just check presence
  if (val === undefined || val === null) {
    return {
      field: field.cdm_path,
      reason: `required field is missing`,
    };
  }

  return null;
}

/**
 * Validate an array-path field (cdm_path ending in `[]`).
 *
 * The document must contain an array at the base path, and the array must
 * include at least one entry whose `type` matches `field.scheme` and whose
 * `value` is a non-empty string.
 */
function validateArrayField(
  doc: CdmDocument,
  field: StockProfileField
): ValidationFailure | null {
  const base = arrayBasePath(field.cdm_path);
  const arr = getAtPath(doc, base);

  if (!Array.isArray(arr)) {
    return {
      field: field.cdm_path,
      reason: `expected array at "${base}", got ${typeof arr}`,
    };
  }

  if (arr.length === 0 && field.scheme) {
    return {
      field: field.cdm_path,
      reason: `no identifier found with scheme "${field.scheme}"`,
    };
  }

  // When a scheme is declared, look for a matching entry
  if (field.scheme) {
    const match = arr.find(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).type === field.scheme
    );

    if (!match) {
      return {
        field: field.cdm_path,
        reason: `no identifier found with scheme "${field.scheme}"`,
      };
    }

    const entryVal = (match as Record<string, unknown>).value;
    if (!isNonEmptyString(entryVal)) {
      return {
        field: field.cdm_path,
        reason: `identifier with scheme "${field.scheme}" has empty or missing value`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an assembled CDM document against a stock profile.
 *
 * Each required field in the profile is checked for presence and type correctness.
 * Array-path fields (ending in `[]`) require at least one matching identifier entry.
 * Scalar fields must be non-empty strings.
 */
export function validate(
  cdmDocument: CdmDocument,
  profile: StockProfile
): ValidationResult {
  const failures: ValidationFailure[] = [];

  for (const field of profile.required_fields) {
    if (isArrayPath(field.cdm_path)) {
      const failure = validateArrayField(cdmDocument, field);
      if (failure) failures.push(failure);
    } else {
      const failure = validateScalarField(cdmDocument, field);
      if (failure) failures.push(failure);
    }
  }

  return {
    valid: failures.length === 0,
    failures,
  };
}

/**
 * Insert a failed record into the quarantine table.
 *
 * The `rawRecord` is JSON-stringified and stored alongside the failure reasons.
 * The quarantine status defaults to `'pending'`.
 */
export function quarantineRecord(
  db: Database.Database,
  ingestRunId: number,
  recordIndex: number,
  rawRecord: unknown,
  failures: ValidationFailure[]
): void {
  const rawRecordJson = JSON.stringify(rawRecord);
  const failureReasons = JSON.stringify(failures.map((f) => f.reason));
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO quarantine
       (ingest_run_id, record_index, raw_record_json, failure_reasons, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  ).run(ingestRunId, recordIndex, rawRecordJson, failureReasons, createdAt);
}
