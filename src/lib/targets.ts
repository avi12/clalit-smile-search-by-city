/**
 * Single source of truth for WHERE the extension operates, HOW to find the search box, and WHICH
 * network calls it treats as appointment searches.
 *
 * Dependency-free at runtime (only a type import) so it can be imported from both the runtime and
 * wxt.config.ts at build time.
 */

import type { GuaranteeMode } from "./messaging";

// ── Hosts ────────────────────────────────────────────────────────────────────

/**
 * `e-services.clalit.co.il` is the Clalit "Tamuz" scheduler — where a Clalit Smile hygienist (שיננית)
 * booking actually happens (behind login), and the only surface that sorts appointment slots by
 * distance vs. time. `clalitsmile.co.il` is the marketing site (its `/search` is a plain directory).
 */
export const TARGET_HOSTS = ["e-services.clalit.co.il", "www.clalitsmile.co.il", "clalitsmile.co.il"] as const;

export const CONTENT_MATCHES = [
  "https://e-services.clalit.co.il/*",
  "https://www.clalitsmile.co.il/*",
  "https://clalitsmile.co.il/*"
] as const;

/** `host_permissions` for the manifest (kept identical to the matches so access can never drift). */
export const HOST_PERMISSIONS = [...CONTENT_MATCHES];

// ── The guarantee ──────────────────────────────────────────────────────────────

/**
 * How to guarantee the searched city:
 *   filter = keep ONLY that city's rows (strongest — "search by a city, get that city");
 *   boost  = float that city's rows to the top, keep the rest.
 * Either way the site's own row order is preserved WITHIN each group, so the distance-vs-time sort the
 * user chose on the site is respected automatically (we never re-sort).
 */
export const GUARANTEE_MODE: GuaranteeMode = "filter";

// ── Finding the search box ──────────────────────────────────────────────────────

/**
 * CSS selectors for the site's city/location search input, most specific first. Captured from the live
 * Smile booking form (inside the Tamuz iframe); the bridge falls back to the hint below elsewhere.
 */
export const SEARCH_CITY_SELECTORS: string[] = ["input#SelectedCityName"];

/** Fallback: an input whose placeholder / aria-label / name hints it's a city / location search. */
export const SEARCH_CITY_HINT = /(עיר|יישוב|ישוב|כתובת|מיקום|חיפוש|city|town|address|location|search)/i;

// ── Request classification ─────────────────────────────────────────────────────

const INTERESTING_URL_PATTERN =
  /(appoint|schedul|tamuz|zimun|tor(?![a-z])|slot|available|availab|clinic|search|meeta|booking|calendar|shinanit|dental|dentist)/i;

export function isInterestingUrl(url: string): boolean {
  return INTERESTING_URL_PATTERN.test(url);
}

export function isTargetHost(hostname: string): boolean {
  return TARGET_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
}

// ── The Clalit Smile clinic search (captured 2026-08-14 from the live logged-in flow) ──────────────

/**
 * The Smile booking UI lives in the Tamuz iframe and talks XHR to /Zimunet/SmileClinic/*. Responses are
 * a JSON envelope `{ data, errorType, message }` where `data` is a SERVER-RENDERED HTML fragment:
 * `li.diary` rows (7 per page), an `h2` header ("נמצאו N תוצאות…"), sort links and a `nav#pager` — all
 * paged/sorted against a server-session result set, so row links (diary GUIDs) are only valid for the
 * session's LAST search. That is why the guarantee rewrites the outgoing search to all-country and
 * filters/aggregates the live responses instead of splicing rows from a second search in.
 */
export const SMILE_SEARCH_PATH = "/Zimunet/SmileClinic/SearchSmileClinicsDiaries";
export const SMILE_PAGING_PATH = "/Zimunet/SmileClinic/Paging";
export const SMILE_SORT_PATH = "/Zimunet/SmileClinic/SortSmileDiaries";

/** Search-form field: "1" = clinics from the searched city's area, "0" = the whole country. */
export const SMILE_AREA_FIELD = "IsShowClinicsFromAreaCity";

/** Any /Zimunet/SmileClinic/* call whose envelope carries the results fragment. */
export function isSmileResultsUrl(url: string): boolean {
  return [SMILE_SEARCH_PATH, SMILE_PAGING_PATH, SMILE_SORT_PATH].some(path => url.includes(path));
}

// ── Endpoint rules (filled in after a real capture) ────────────────────────────

/**
 * A precise rule for one appointment-search endpoint. Discovery mode (dev build → page console) reveals
 * the real URL and response shape; encode it here and the transform reads exact fields instead of
 * heuristics. Field paths are dot-paths into a single row object (e.g. "clinic.city").
 */
export interface EndpointRule {
  id: string;
  urlPattern: RegExp;
  method: "GET" | "POST" | "*";
  /** Dot-path to the results array in the response ("" = auto-detect the largest array of objects). */
  resultsPath: string;
  /** Where the city lives on each row, for matching against the searched city. */
  fields: {
    city?: string;
    clinicName?: string;
  };
}

/**
 * ACTIVE RULES — empty: the Tamuz appointment API sits behind Clalit login and couldn't be observed
 * without a session. Run the dev build, do a real hygienist search, read the captured request/response
 * in the page console, and add a rule. Until then the transform auto-detects the results array and
 * matches the city by name.
 */
export const ENDPOINT_RULES: EndpointRule[] = [];

export function matchEndpointRule({ url, method }: {
  url: string;
  method: string;
}): EndpointRule | undefined {
  return ENDPOINT_RULES.find(
    rule => rule.urlPattern.test(url) && (rule.method === "*" || rule.method === method.toUpperCase())
  );
}
