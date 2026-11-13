/**
 * The Smile server session as the extension sees it: what the last search was, which services still
 * answer, and every call that talks to /Zimunet/SmileClinic with the PAGE's own credentials.
 *
 * It exists because that session is ONE shared, mutable thing (docs §6): every search re-mints the
 * GUIDs the visible rows carry, sort and paging operate on the last search only, a service that answers
 * `errorType: 3` has nothing to give, and enough failures in a row make the scheduler drop the session
 * altogether (docs §12a). The interceptor, the availability sweep, the row actions and the details
 * lightbox all read and write this one object rather than keeping their own copies.
 *
 * MAIN-world only and chrome-free. `fetchSessionJson` is handed the page's UNPATCHED fetch so our own
 * transforms never see these calls.
 */

import {
  SMILE_AREA_FIELD,
  SMILE_CITY_FIELD,
  SMILE_PAGING_PATH,
  SMILE_SEARCH_PATH,
  SMILE_SPECIALIZATION_CODES,
  SMILE_SPECIALIZATION_FIELD
} from "@/lib/targets";

import {
  envelopeStatus,
  type ListedBranchRow,
  listedRowsInEnvelope,
  refreshRowActionLinks,
  rowNavCode,
  scanEnvelopeForNavCode,
  SMILE_ENVELOPE_STATUS,
  SMILE_MARKER_ATTR,
  SYNTHETIC_ROW_ATTR
} from "./smile";

/** Which order the server session currently applies to the result set. */
type SmileSort = "cityDistance" | "soonest" | "home";

/** Runaway guard for the page scans (an all-country result set is ~10 pages today). */
const MAX_SCAN_PAGES = 30;

interface SmileSessionState {
  isEnabled: boolean;
  configCity: string;
  isSessionLost: boolean;
  activeSearchCity: string;
  activeSearchSpecialization: string;
  isCitySearch: boolean;
  latestTemplateRowHtml: string;
  activeSort: SmileSort;
  isSortDescending: boolean;
}

export function createSmileSession(nativeFetch: typeof fetch) {
  const emptySpecializations = new Set<string>();
  const state: SmileSessionState = {
    /** Pushed by the bridge: the city in the site's search box and the session-only on/off toggle. */
    isEnabled: true,
    configCity: "",
    /** The scheduler dropped us (errorType 2) - only a page reload gets a session back. */
    isSessionLost: false,
    /** What the SUBMITTED search asked for, which is what sort and paging operate on. */
    activeSearchCity: "",
    activeSearchSpecialization: SMILE_SPECIALIZATION_CODES[0].toString(),
    /**
     * Which of the form's two radios the user submitted: "מרפאות מאזור היישוב" (the city) or
     * "מרפאות מכל הארץ". The guarantee exists to make the FIRST one mean the city and all of it; the
     * second one is a request for the whole country, and narrowing that to one city is not a guarantee
     * but a contradiction - so it is left alone, rows, pager, sorts and all.
     */
    isCitySearch: true,
    /** A real row of the current search - its ClinicDetailsByDiary GUID feeds the composed lightbox. */
    latestTemplateRowHtml: "",
    activeSort: "cityDistance",
    isSortDescending: false
  };

  /** The city the session's result set was actually searched for, falling back to the search box. */
  function city() {
    return (state.activeSearchCity || state.configCity).trim();
  }

  /** Nothing may run when the toggle is off or the scheduler dropped the session. */
  function isActive() {
    return state.isEnabled && !state.isSessionLost;
  }

  /** GET/POST a /Zimunet/ endpoint with the PAGE's own session, bypassing our own patches. */
  async function fetchSessionJson({ url, body }: { url: string; body?: string }) {
    const headers: Record<string, string> = {
      "X-Requested-With": "XMLHttpRequest"
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    }

    const response = await nativeFetch.call(window, url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body,
      credentials: "same-origin"
    });
    return await response.json();
  }

  /** An all-country search body for one service, in the city the session is guaranteeing. */
  function searchBody(specialization: string) {
    return [
      `${SMILE_SPECIALIZATION_FIELD}=${specialization}`,
      `${SMILE_CITY_FIELD}=${encodeURIComponent(city())}`,
      `${SMILE_AREA_FIELD}=0`
    ].join("&");
  }

  /** Read a search envelope's status, remembering an empty service and a lost session. */
  function trackEnvelopeStatus({ json, specialization }: { json: unknown; specialization?: string }) {
    const status = envelopeStatus(json);
    if (status === SMILE_ENVELOPE_STATUS.AUTHORIZATION) {
      state.isSessionLost = true;
    }

    if (status === SMILE_ENVELOPE_STATUS.APPLICATION && specialization) {
      emptySpecializations.add(specialization);
    }

    return status;
  }

  /** The services still worth asking - one that answered `errorType: 3` never will this session. */
  function bookableSpecializations() {
    return SMILE_SPECIALIZATION_CODES.filter(code => !emptySpecializations.has(code));
  }

  function isSpecializationEmpty(specialization: string) {
    return emptySpecializations.has(specialization);
  }

  function pagesOf({ totalDeclared, pageRowCount }: { totalDeclared: number; pageRowCount: number }) {
    return pageRowCount ? Math.min(Math.ceil(totalDeclared / pageRowCount), MAX_SCAN_PAGES) : 0;
  }

  function pagingUrl(page: number) {
    return `${SMILE_PAGING_PATH}?pageNumber=${page}`;
  }

  /** Run a NEW all-country search for one service and hand back its first envelope. */
  async function search(specialization: string) {
    return await fetchSessionJson({
      url: SMILE_SEARCH_PATH,
      body: searchBody(specialization)
    });
  }

  /**
   * ONE fresh search for a service, read to the end: which of these branches it lists right now, what
   * each one's row said, and - from the very same envelopes - the displayed real rows healed onto this
   * search's GUIDs.
   *
   * The healing is why there is no restore afterwards, and that is the whole point. The old sweep threw
   * its search away and re-ran the user's one to undo it, which cost a second search and left every
   * appended row without a handle, so each click had to mint one and wait ~3 s for it. Here the sweep's
   * search BECOMES the session's search - it asks the same thing the user's rewritten search asks (this
   * city, this service, all-country) - and everything on screen is made to belong to it: real rows by
   * healing, appended rows by taking the link out of the row that proves them bookable. A click then
   * needs no server round trip at all.
   *
   * Pages are walked one at a time on purpose: the scheduler serialises a session's calls, so ten
   * parallel page fetches measured 656 ms against 161 ms sequential (2026-08-15).
   */
  async function sweepListedBranches({
    specialization,
    navCodes
  }: {
    specialization: string;
    navCodes: Iterable<string>;
  }) {
    const wanted = new Set(navCodes);
    const found = new Map<string, ListedBranchRow>();
    const first = await search(specialization);
    if (
      trackEnvelopeStatus({
        json: first,
        specialization
      }) !== SMILE_ENVELOPE_STATUS.SUCCESS
    ) {
      return found;
    }

    const scan = scanEnvelopeForNavCode({ json: first });
    if (scan.firstRowHtml) {
      state.latestTemplateRowHtml = scan.firstRowHtml;
    }

    const elList = document.querySelector(`#am_diaries[${SMILE_MARKER_ATTR}] ul`);
    const pendingRows = new Set(
      elList ? [...elList.querySelectorAll(`li.diary:not([${SYNTHETIC_ROW_ATTR}])`)].map(rowNavCode) : []
    );

    function readEnvelope(json: unknown) {
      for (const [code, row] of listedRowsInEnvelope({
        json,
        navCodes: wanted
      })) {
        found.set(code, row);
      }

      if (elList) {
        for (const code of refreshRowActionLinks({
          elList,
          json
        })) {
          pendingRows.delete(code);
        }
      }
    }

    readEnvelope(first);

    const totalPages = pagesOf(scan);
    for (let page = 2; (found.size < wanted.size || pendingRows.size > 0) && page <= totalPages; page++) {
      readEnvelope(await fetchSessionJson({ url: pagingUrl(page) }));
    }

    return found;
  }

  /**
   * After a foreign search the session's last result set is not the user's and every displayed GUID is
   * dead. Re-run the user's own search, then rewrite the visible rows' slots/details links to the fresh
   * GUIDs, page by page until every real row is healed.
   */
  async function restoreUserSearch() {
    const first = await search(state.activeSearchSpecialization);
    if (trackEnvelopeStatus({ json: first }) !== SMILE_ENVELOPE_STATUS.SUCCESS) {
      return;
    }

    const scan = scanEnvelopeForNavCode({ json: first });
    if (scan.firstRowHtml) {
      state.latestTemplateRowHtml = scan.firstRowHtml;
    }

    const elList = document.querySelector(`#am_diaries[${SMILE_MARKER_ATTR}] ul`);
    if (!elList) {
      return;
    }

    const pending = new Set([...elList.querySelectorAll(`li.diary:not([${SYNTHETIC_ROW_ATTR}])`)].map(rowNavCode));
    for (const code of refreshRowActionLinks({
      elList,
      json: first
    })) {
      pending.delete(code);
    }

    const totalPages = pagesOf(scan);
    for (let page = 2; pending.size > 0 && page <= totalPages; page++) {
      const envelope = await fetchSessionJson({ url: pagingUrl(page) });
      for (const code of refreshRowActionLinks({
        elList,
        json: envelope
      })) {
        pending.delete(code);
      }
    }
  }

  return {
    state,
    city,
    isActive,
    fetchSessionJson,
    searchBody,
    search,
    trackEnvelopeStatus,
    bookableSpecializations,
    isSpecializationEmpty,
    pagesOf,
    pagingUrl,
    sweepListedBranches,
    restoreUserSearch
  };
}

export type SmileSession = ReturnType<typeof createSmileSession>;
