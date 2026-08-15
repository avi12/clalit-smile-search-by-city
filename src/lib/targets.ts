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
 * `e-services.clalit.co.il` is the Clalit "Tamuz" scheduler - where a Clalit Smile hygienist (שיננית)
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
 *   filter = keep ONLY that city's rows (strongest - "search by a city, get that city");
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

// ── The portal idle / session-timeout dialog (captured 2026-08-14 from the live top frame) ──────────
//
// A couple of minutes before it logs an idle session out, the Clalit portal shows an "יש פה מישהו?"
// dialog (`#pnlSessionExpiringInfo`, an AjaxControlToolkit ModalPopupExtender, `role="alertdialog"`) in
// the TOP frame with two buttons: "המשך" (continue → the portal's `clearLogOutTimer()` + a postback that
// reloads `RefreshSession.aspx`) and "יציאה" (exit → `logOut()`). Left alone it counts down and logs
// out, dropping the Tamuz search state. The DEV-SERVER keepalive (scripts/dev-shared.ts) clicks the
// site's OWN continue button, so the session refresh is the portal's, not ours. Dev tooling only - the
// shipped extension leaves the portal's idle policy alone.

/** The idle/session-expiring dialog panel (top frame). */
export const SESSION_TIMEOUT_DIALOG_SELECTOR = "#pnlSessionExpiringInfo";

/**
 * The "המשך" (continue) button, most-specific first: the exact master-page id, then a resilient fallback
 * (the panel's strong action button - the "יציאה" exit button carries `weakButton`, this one does not).
 */
export const SESSION_TIMEOUT_CONTINUE_SELECTORS = [
  "#ctl00_ctl00_LogOutTimeOut_btnMasterOk_lnkSubButton",
  `${SESSION_TIMEOUT_DIALOG_SELECTOR} a.online_blue_button:not(.weakButton)`
] as const;

/**
 * Never click the exit control by mistake. Matched against a button's id + class + text + onclick +
 * href, and only exit-unique markers qualify: the exit button's `weakButton` class, its `btnMasterExit`
 * id, and its "יציאה" text. A generic /logout/ would reject the CONTINUE button too - its id/href say
 * "LogOutTimeOut" and its onclick calls "clearLogOutTimeout" (verified live 14.08.2026; that exact bug
 * silently disabled the keepalive).
 */
export const SESSION_TIMEOUT_EXIT_HINT = /weakButton|btnMasterExit|יציאה/i;

// ── Request classification ─────────────────────────────────────────────────────

const INTERESTING_URL_PATTERN =
  /(appoint|schedul|tamuz|zimun|tor(?![a-z])|slot|available|availab|clinic|search|meeta|booking|calendar|shinanit|dental|dentist)/i;

export function isInterestingUrl(url: string) {
  return INTERESTING_URL_PATTERN.test(url);
}

// ── The Clalit Smile clinic search (captured 2026-08-14 from the live logged-in flow) ──────────────

/**
 * The Smile booking UI lives in the Tamuz iframe and talks XHR to /Zimunet/SmileClinic/*. Responses are
 * a JSON envelope `{ data, errorType, message }` where `data` is a SERVER-RENDERED HTML fragment:
 * `li.diary` rows (7 per page), an `h2` header ("נמצאו N תוצאות…"), sort links and a `nav#pager` - all
 * paged/sorted against a server-session result set, so row links (diary GUIDs) are only valid for the
 * session's LAST search. That is why the guarantee rewrites the outgoing search to all-country and
 * filters/aggregates the live responses instead of splicing rows from a second search in.
 */
const SMILE_CLINIC_PAGE_PATH = "/Zimunet/SmileClinic";
export const SMILE_SEARCH_PATH = `${SMILE_CLINIC_PAGE_PATH}/SearchSmileClinicsDiaries`;
export const SMILE_PAGING_PATH = `${SMILE_CLINIC_PAGE_PATH}/Paging`;
export const SMILE_SORT_PATH = `${SMILE_CLINIC_PAGE_PATH}/SortSmileDiaries`;

/**
 * "Back" from a slots page DOCUMENT-loads the clinic page with this flag, and the server re-renders the
 * session's last search RAW into it - no fetch/XHR runs, so the guarantee would never see it. The
 * interceptor detects this document and runs the guarantee over the markup itself, which is the same
 * fragment the network path carries (captured 2026-08-14, docs §6d).
 */
const SMILE_RESTORE_PARAM = "isRestoreSearch";

export function isSmileRestoreLocation({ pathname, search }: {
  pathname: string;
  search: string;
}) {
  return pathname === SMILE_CLINIC_PAGE_PATH &&
    (new URLSearchParams(search).get(SMILE_RESTORE_PARAM) ?? "").toLowerCase() === "true";
}

/**
 * The specialization select, read on a restore document to learn which service the restored session
 * searched for - its option labels are what the results header is matched against. The city box is
 * SEARCH_CITY_SELECTORS above. Nothing drives the form any more: the restore recovery transforms the
 * markup the server already rendered rather than asking the site to search again.
 */
export const SMILE_SPECIALIZATION_SELECT_SELECTOR = "select#SelectedSpecializationCode";

/**
 * The values the rendered sort links carry (`SortSmileDiaries?sortValue=X&sortDirection=Y`). The city
 * sort is what the watcher rides: it floats the searched city's own branches to the first page, so
 * "is this branch listed?" costs one search plus one page instead of the whole result set.
 */
export const SMILE_SORT_VALUES = {
  cityDistance: "4",
  soonest: "2",
  homeDistance: "3"
} as const;

/** The clinic-details lightbox - the site's own ClinicDetailsByVisit view and our composed one share it. */
export const SMILE_DETAILS_DIALOG_SELECTOR = "#clinicDetailsLightbox";

/**
 * The site's full-screen loader. `z.showLoader` inside the iframe delegates to the TOP frame's
 * `StandbyScreenShow`, which appends this div to the top document's body - so the minting sweep's
 * caption belongs in the PARENT document, not the booking iframe (captured 2026-08-14, docs §6c).
 */
export const SITE_LOADER_SELECTOR = "div.loader.lottie";

/**
 * Search-form field: which of the form's two radios was submitted. The guarantee only ever applies to
 * the city one - "מרפאות מכל הארץ" is a request the extension has no business narrowing.
 */
export const SMILE_AREA_FIELD = "IsShowClinicsFromAreaCity";
/** "מרפאות מאזור היישוב" - the city's own area, and the only search the guarantee touches. */
export const CITY_AREA_VALUE = "1";
/** "מרפאות מכל הארץ" - every clinic in the country, city filter and all. */
export const ALL_COUNTRY_AREA_VALUE = "0";

/** Search-form field: the site-canonical city its autocomplete committed. */
export const SMILE_CITY_FIELD = "SelectedCityName";

/** Search-form field: which dental service the search covers. */
export const SMILE_SPECIALIZATION_FIELD = "SelectedSpecializationCode";

/**
 * The site's CLOSED specialization list (its own form's options, re-verified live 2026-08-14):
 * 91 בדיקת רופא · 97 סתימה · 92 שיננית. A diary GUID is mintable only by a search, so a branch absent
 * from all three has no server entrance at all (docs §10b) - this list is what the click-time minting
 * sweep iterates.
 */
export const SMILE_SPECIALIZATION_CODES = ["92", "91", "97"] as const;

/** Any /Zimunet/SmileClinic/* call whose envelope carries the results fragment. */
export function isSmileResultsUrl(url: string) {
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
 * ACTIVE RULES - empty: the Tamuz appointment API sits behind Clalit login and couldn't be observed
 * without a session. Run the dev build, do a real hygienist search, read the captured request/response
 * in the page console, and add a rule. Until then the transform auto-detects the results array and
 * matches the city by name.
 */
const ENDPOINT_RULES: EndpointRule[] = [];

export function matchEndpointRule({ url, method }: {
  url: string;
  method: string;
}) {
  return ENDPOINT_RULES.find(
    rule => rule.urlPattern.test(url) && (rule.method === "*" || rule.method === method.toUpperCase())
  );
}
