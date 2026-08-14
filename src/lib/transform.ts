/**
 * The city guarantee. Given a parsed appointment-search response and the searched city, keep only that
 * city's rows (filter) or float them to the top (boost).
 *
 * It deliberately PRESERVES the site's row order within each group - the response already came back
 * sorted by the distance-vs-time option the user picked, so not re-sorting is exactly what "respect the
 * sort" means. Pure and dependency-light so the MAIN-world interceptor can import it.
 */

import type { GuaranteeMode } from "./messaging";
import type { EndpointRule } from "./targets";
import { normalizeCity } from "./text";

export interface TransformInput {
  city: string;
  guaranteeMode: GuaranteeMode;
  rule?: EndpointRule;
}

export interface TransformResult {
  isTransformed: boolean;
  resultsCount: number;
  inCityCount: number;
  json: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function getByPath({ source, path }: {
  source: unknown;
  path: string;
}): unknown {
  if (!path) {
    return undefined;
  }

  return path.split(".").reduce<unknown>((node, key) => {
    if (isRecord(node)) {
      return node[key];
    }

    return undefined;
  }, source);
}

function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.some(item => item !== null && typeof item === "object");
}

/**
 * Locate the array most likely to be the list of appointment/slot rows: the largest array of objects.
 * Returned so callers can mutate it IN PLACE (splice) - the only way to affect a top-level-array
 * response, whose reference the page already holds.
 */
function findResultsArray(root: unknown): Record<string, unknown>[] | undefined {
  let best: Record<string, unknown>[] | undefined;
  const seen = new Set<unknown>();

  function visit(node: unknown): void {
    if (!node || typeof node !== "object" || seen.has(node)) {
      return;
    }

    seen.add(node);

    if (Array.isArray(node)) {
      if (isObjectArray(node) && (!best || node.length > best.length)) {
        best = node;
      }

      node.forEach(visit);
      return;
    }

    if (isRecord(node)) {
      for (const value of Object.values(node)) {
        visit(value);
      }
    }
  }

  visit(root);
  return best;
}

function collectStrings({ row, depth = 0 }: {
  row: Record<string, unknown>;
  depth?: number;
}): string[] {
  if (depth > 2) {
    return [];
  }

  const collected: string[] = [];
  for (const value of Object.values(row)) {
    if (typeof value === "string") {
      collected.push(value);
    } else if (typeof value === "number") {
      collected.push(String(value));
    } else if (isRecord(value)) {
      collected.push(
        ...collectStrings({
          row: value,
          depth: depth + 1
        })
      );
    }
  }

  return collected;
}

function rowInCity(
  { row, needle, rule }: {
    row: Record<string, unknown>;
    needle: string;
    rule?: EndpointRule;
  }
): boolean {
  if (rule) {
    // Precise rule: trust only its named fields.
    for (const path of [rule.fields.city, rule.fields.clinicName]) {
      if (path) {
        const text = normalizeCity(
          String(
            getByPath({
              source: row,
              path
            }) ?? ""
          )
        );
        if (text && (text.includes(needle) || needle.includes(text))) {
          return true;
        }
      }
    }

    return false;
  }

  // Heuristic: any string on the row contains the searched city.
  return collectStrings({ row }).some(text => normalizeCity(text).includes(needle));
}

export function applyGuarantee(json: unknown, { city, guaranteeMode, rule }: TransformInput): TransformResult {
  const untouched: TransformResult = {
    isTransformed: false,
    resultsCount: 0,
    inCityCount: 0,
    json
  };
  const needle = normalizeCity(city);
  if (!needle) {
    return untouched;
  }

  let resultRows: Record<string, unknown>[] | undefined;
  if (rule?.resultsPath) {
    const located = getByPath({
      source: json,
      path: rule.resultsPath
    });
    if (isObjectArray(located)) {
      resultRows = located;
    }
  }

  resultRows ??= findResultsArray(json);

  if (!resultRows) {
    return untouched;
  }

  const resultsCount = resultRows.length;
  const inCity: Record<string, unknown>[] = [];
  const others: Record<string, unknown>[] = [];
  for (const row of resultRows) {
    (rowInCity({
      row,
      needle,
      rule
    }) ? inCity : others).push(row);
  }

  // Order preserved within each group → the site's distance/time sort is respected.
  const nextRows = guaranteeMode === "filter" ? inCity : [...inCity, ...others];
  resultRows.splice(0, resultRows.length, ...nextRows);

  return {
    isTransformed: true,
    resultsCount,
    inCityCount: inCity.length,
    json
  };
}
