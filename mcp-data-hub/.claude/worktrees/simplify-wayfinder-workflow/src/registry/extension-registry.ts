import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtensionType = "string" | "number" | "integer";

export interface ExtensionField {
  name: string;
  type: ExtensionType;
  description: string;
  applicable_asset_classes: string[];
}

export interface ExtensionsConfig {
  extensions_version: string;
  fields: ExtensionField[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionsPath = path.resolve(__dirname, "../../config/extensions.json");

const REQUIRED_FIELDS = [
  "name",
  "type",
  "description",
  "applicable_asset_classes",
] as const;

const VALID_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
]);

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let _config: ExtensionsConfig | null = null;

// ---------------------------------------------------------------------------
// Validation (internal)
// ---------------------------------------------------------------------------

function validateConfig(raw: unknown): asserts raw is ExtensionsConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error("Extensions config must be a JSON object");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.extensions_version !== "string") {
    throw new Error("extensions_version must be a string");
  }

  if (!Array.isArray(obj.fields)) {
    throw new Error("fields must be an array");
  }

  if (obj.fields.length === 0) {
    throw new Error("fields array must not be empty");
  }

  const seen = new Set<string>();

  for (let i = 0; i < obj.fields.length; i++) {
    const field = obj.fields[i];

    if (field === null || typeof field !== "object") {
      throw new Error(`fields[${i}] must be an object`);
    }

    const f = field as Record<string, unknown>;

    // Required top-level keys
    for (const key of REQUIRED_FIELDS) {
      if (!(key in f)) {
        throw new Error(`fields[${i}] is missing required key "${key}"`);
      }
    }

    if (typeof f.name !== "string" || f.name.length === 0) {
      throw new Error(`fields[${i}].name must be a non-empty string`);
    }

    if (seen.has(f.name as string)) {
      throw new Error(`Duplicate extension name: "${f.name}"`);
    }
    seen.add(f.name as string);

    if (!VALID_TYPES.has(f.type as string)) {
      throw new Error(
        `fields[${i}].type must be one of: ${[...VALID_TYPES].join(", ")}`
      );
    }

    if (typeof f.description !== "string" || f.description.length === 0) {
      throw new Error(`fields[${i}].description must be a non-empty string`);
    }

    if (!Array.isArray(f.applicable_asset_classes)) {
      throw new Error(`fields[${i}].applicable_asset_classes must be an array`);
    }

    for (const ac of f.applicable_asset_classes as unknown[]) {
      if (typeof ac !== "string" || ac.length === 0) {
        throw new Error(
          `fields[${i}].applicable_asset_classes contains non-string value`
        );
      }
    }
  }
}

function loadConfig(): ExtensionsConfig {
  const raw = readFileSync(extensionsPath, "utf-8");
  const parsed = JSON.parse(raw);
  validateConfig(parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate the extensions config from the checked-in JSON file.
 * Results are cached — subsequent calls return the same validated config.
 */
export function loadExtensions(): ExtensionsConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Return a single extension definition by canonical name.
 * Returns undefined if not found.
 */
export function getExtension(name: string): ExtensionField | undefined {
  const cfg = loadExtensions();
  return cfg.fields.find((f) => f.name === name);
}

/**
 * List extension definitions, optionally filtered by asset class.
 * When an asset class is provided, only extensions whose
 * `applicable_asset_classes` array includes that class (or is empty,
 * meaning universal) are returned.
 */
export function listExtensions(assetClass?: string): ExtensionField[] {
  const cfg = loadExtensions();
  if (assetClass === undefined) {
    return [...cfg.fields];
  }
  return cfg.fields.filter(
    (f) =>
      f.applicable_asset_classes.length === 0 ||
      f.applicable_asset_classes.includes(assetClass)
  );
}

export interface ValidateResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a value against the declared type of an extension.
 * - string: value must be typeof "string"
 * - number: value must be typeof "number" (and not NaN)
 * - integer: value must be typeof "number", finite, and an integer (no fractional part)
 */
export function validateExtension(
  name: string,
  value: unknown
): ValidateResult {
  const ext = getExtension(name);
  if (!ext) {
    return { valid: false, error: `Unknown extension: "${name}"` };
  }

  switch (ext.type) {
    case "string": {
      if (typeof value !== "string") {
        return {
          valid: false,
          error: `Expected string for "${name}", got ${typeof value}`,
        };
      }
      return { valid: true };
    }

    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return {
          valid: false,
          error: `Expected number for "${name}", got ${typeof value}`,
        };
      }
      return { valid: true };
    }

    case "integer": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return {
          valid: false,
          error: `Expected integer for "${name}", got ${typeof value}`,
        };
      }
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        return {
          valid: false,
          error: `Expected integer for "${name}", got ${value}`,
        };
      }
      return { valid: true };
    }

    default:
      return { valid: false, error: `Unknown type for "${name}": ${ext.type}` };
  }
}
