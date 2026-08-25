/**
 * Number input helpers.
 *
 * Extracted from App.tsx so the accounts and projects panels parse
 * typed input exactly the way the pot editors always have. The
 * distinction that matters is between an in-progress typing state
 * ("-", ".", "") and a finished number: the first must not be
 * committed to the database, the second must.
 */

export function valueToInput(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Returns null while the string is still mid-typing rather than coercing to 0. */
export function parseDraftNumber(raw: string): number | null {
  const normalised = raw.replace(",", ".").trim();

  if (
    normalised === "" ||
    normalised === "-" ||
    normalised === "." ||
    normalised === "-."
  ) {
    return null;
  }

  const parsed = Number(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}

export function finaliseNumber(raw: string): number {
  return parseDraftNumber(raw) ?? 0;
}
