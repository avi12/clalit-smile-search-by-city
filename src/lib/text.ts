/**
 * Pure text helpers, dependency-free so any context (incl. the MAIN-world interceptor) can import them
 * without pulling in the clinic dataset or DOM/chrome globals.
 */

/** Normalize a Hebrew place string for tolerant matching: drop geresh/quotes, collapse whitespace. */
export function normalizeCity(value: string) {
  return value.replaceAll(/["'׳״]/g, "").replaceAll(/\s+/g, " ").trim();
}
