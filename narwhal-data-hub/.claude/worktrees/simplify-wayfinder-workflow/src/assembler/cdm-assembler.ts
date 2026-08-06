import type { NormalizedRecord, StockProfile, CdmDocument } from "./types.js";

/** Path segment suffix that signals "append to array" semantics. */
const ARRAY_SUFFIX = "[]";

/**
 * Return true when a profile-field's cdm_path ends with `[]`.
 * Those fields are collected into an array rather than set as a scalar.
 */
function isArrayPath(path: string): boolean {
  return path.endsWith(ARRAY_SUFFIX);
}

/** Strip the trailing `[]` to get the true key path for an array field. */
function arrayBasePath(path: string): string {
  return path.slice(0, -ARRAY_SUFFIX.length);
}

/** Set a value at a dotted path inside a nested object, creating intermediate objects as needed. */
function setAtPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      !(part in current) ||
      typeof current[part] !== "object" ||
      current[part] === null
    ) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

/** Append a value to an array at a dotted path, creating intermediate objects / arrays as needed. */
function appendToArrayAtPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (i === parts.length - 1) {
      // Terminal — ensure it's an array and push
      if (!Array.isArray(current[part])) {
        current[part] = [];
      }
      (current[part] as unknown[]).push(value);
    } else {
      if (
        !(part in current) ||
        typeof current[part] !== "object" ||
        current[part] === null
      ) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
  }
}

/**
 * Assemble a CDM JSON document from a normalised venue record using the declared stock profile.
 *
 * - Every field listed in the profile is populated (either from the record or from its literal value).
 * - Fields on the record that are NOT in the profile are silently skipped.
 * - Identifier fields (cdm_path ending in `[]`) are appended to an array as `{ type, value }` objects.
 * - Optional source fields that are absent on the record are skipped.
 */
export function assemble(
  record: NormalizedRecord,
  profile: StockProfile
): CdmDocument {
  const doc: CdmDocument = {};

  for (const field of profile.required_fields) {
    // Determine the value to set
    let resolvedValue: unknown;

    if (field.value !== undefined) {
      // Literal / constant value declared in the profile
      resolvedValue = field.value;
    } else if (field.source !== undefined) {
      // Pull from the normalised record; try top-level first, then attributes bag
      // ponytail: one-line fallback avoids a whole resolver abstraction
      const recAny = record as unknown as Record<string, unknown>;
      const attrs = recAny.attributes as Record<string, unknown> | undefined;
      const sourceVal = attrs?.[field.source] ?? recAny[field.source];
      if (sourceVal === undefined || sourceVal === null) {
        continue;
      }
      // Type conversion: "number" → parseFloat, "object" → JSON.parse
      if (field.type === "number") {
        const n = typeof sourceVal === "number" ? sourceVal : Number(sourceVal);
        if (Number.isNaN(n)) continue;
        resolvedValue = n;
      } else if (field.type === "object") {
        if (typeof sourceVal === "object") {
          resolvedValue = sourceVal;
        } else if (typeof sourceVal === "string") {
          try {
            resolvedValue = JSON.parse(sourceVal);
          } catch {
            continue;
          }
        } else {
          continue;
        }
      } else {
        resolvedValue = sourceVal;
      }
    } else {
      // Neither value nor source — nothing to populate
      continue;
    }

    if (isArrayPath(field.cdm_path)) {
      // Identifier-style: append { type, value } to an array
      const base = arrayBasePath(field.cdm_path);
      const element: Record<string, unknown> = {
        value: resolvedValue,
      };
      if (field.scheme) {
        element.type = field.scheme;
      }
      appendToArrayAtPath(doc, base, element);
    } else {
      // Scalar path: set directly
      setAtPath(doc, field.cdm_path, resolvedValue);
    }
  }

  return doc;
}
