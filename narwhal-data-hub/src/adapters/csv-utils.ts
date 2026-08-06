/**
 * Split a single CSV line into columns, respecting double-quoted fields.
 * Strips surrounding whitespace from unquoted values and removes quotes
 * from quoted values.
 */
export function splitCSVLine(line: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cols.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cols.push(current.trim());
  return cols;
}
