/**
 * MAIN-world interceptor — runs in the PAGE's own JS context (world: "MAIN", document_start) so it can
 * patch `window.fetch` and `XMLHttpRequest` before the site's scripts capture references to them.
 *
 * Two guarantees (see docs/reverse-engineering.md):
 *   1. City completeness — a Smile clinic search shows ALL of the searched city's clinics and ONLY
 *      them: the outgoing search is rewritten from "area" to "all country" (so the server session holds
 *      the full set and every row link stays valid), each response is filtered to the city, and the
 *      remaining server pages are aggregated into the one visible list.
 *   2. A "distance" sort references the USER's location — the "distance from the searched city" sort is
 *      removed/rewritten to the site's own "מרחק מהבית שלך" sort.
 *
 * Generic JSON responses (non-Smile) go through the heuristic transform in transform.ts. No chrome.*
 * access, no storage: config comes in over the window channel and status goes back the same way. In the
 * dev build it logs interesting requests to the page console (Discovery).
 */

import { DENTAL_CLINIC_COORDS, SMILE_BRANCHES } from "../lib/clinic-directory";
import { installDevTakeover } from "../lib/dev-takeover";
import { haversineKm, type LatLng } from "../lib/geo";
import { type GuaranteeStatus, PageMsg, type SearchConfig } from "../lib/messaging";
import { onPageMessage, sendPageMessage } from "../lib/messaging-page";
import { searchConfigSchema, smileEnvelopeSchema } from "../lib/schemas";
import {
  applyBranchToDetailsFragment,
  applyBranchToRow,
  cityMatches,
  DETAILS_CODE_ATTR,
  detailsLinkFromRowHtml,
  extractCityRows,
  filterSmileEnvelope,
  rowClinicName,
  rowNavCode,
  setHeaderCount,
  setRowDistanceLabel,
  SMILE_MARKER_ATTR,
  type SmileFilterOutcome,
  SYNTHETIC_ROW_ATTR
} from "../lib/smile";
import {
  CONTENT_MATCHES,
  GUARANTEE_MODE,
  isInterestingUrl,
  isSmileResultsUrl,
  matchEndpointRule,
  SMILE_AREA_FIELD,
  SMILE_PAGING_PATH,
  SMILE_SEARCH_PATH,
  SMILE_SORT_PATH
} from "../lib/targets";
import { applyGuarantee, type TransformResult } from "../lib/transform";
import { defineContentScript } from "#imports";

/** The Zimunet site bundle's own UI namespace — the MAIN world sees the page's globals. */
interface ZimunetPageUi {
  showDialog?: (selector: string, html: string) => void;
}

declare global {
  interface Window {
    z?: ZimunetPageUi;
  }
}

export default defineContentScript({
  matches: [...CONTENT_MATCHES],
  runAt: "document_start",
  allFrames: true,
  world: "MAIN",
  main() {
    // Default enabled with no city: idle until the bridge reports what's in the search box.
    let config: SearchConfig = {
      enabled: true,
      city: ""
    };
    // Dev re-injection: a newer generation flips this and the patches below become pass-throughs.
    let superseded = false;
    if (import.meta.env.DEV) {
      installDevTakeover({
        script: "interceptor",
        onSuperseded() {
          superseded = true;
        }
      });
    }

    onPageMessage(PageMsg.Config, ({ data }) => {
      const parsed = searchConfigSchema.safeParse(data);
      if (parsed.success) {
        config = parsed.data;
      }
    });

    function reportStatus({ city, resultsCount, inCityCount }: GuaranteeStatus) {
      sendPageMessage(PageMsg.Status, {
        city,
        resultsCount,
        inCityCount
      }).catch(() => {});
    }

    function logDiscovery(
      { method, url, status, json }: {
        method: string;
        url: string;
        status: number;
        json: unknown;
      }
    ) {
      if (import.meta.env.DEV && !superseded && isInterestingUrl(url)) {
        console.log(`[clalit-city] ${method} ${url} → ${status}`, json);
      }
    }

    // ── Smile clinic search (HTML fragments in a JSON envelope) ────────────────
    // The city the server session's result set was actually searched for — read from the outgoing
    // search request itself, so filtering never drifts from what's in the search box vs what was
    // submitted. Sort/paging calls inherit it (they operate on the same server session).
    let activeSearchCity = "";
    let renderCounter = 0;
    let aggregationRun = 0;
    let latestTemplateRowHtml = "";
    // The sort the server session currently applies. "home" (מרחק מהבית שלך) is hijacked: rows are
    // re-ranked by distance from the user's LIVE location (navigator.geolocation), falling back to the
    // server's home-distance order when the position is denied/unavailable.
    type SmileSort = "cityDistance" | "soonest" | "home";
    let activeSort: SmileSort = "cityDistance";
    let sortDescending = false;

    function smileCity(): string {
      return (activeSearchCity || config.city).trim();
    }

    function isSmileAggregationTrigger(url: string): boolean {
      return url.includes(SMILE_SEARCH_PATH) || url.includes(SMILE_SORT_PATH);
    }

    type MarkedSmileOutcome = SmileFilterOutcome & { marker: string };
    type UrlTransformResult = TransformResult & { smile?: MarkedSmileOutcome };
    type UrlTransformInput = {
      json: unknown;
      url: string;
      method: string;
    };

    function transformSmile(json: unknown): UrlTransformResult {
      const untouched: UrlTransformResult = {
        transformed: false,
        resultsCount: 0,
        inCityCount: 0,
        json
      };
      const city = smileCity();
      if (superseded || !config.enabled || !city) {
        return untouched;
      }

      const marker = String(++renderCounter);
      const outcome = filterSmileEnvelope({
        json,
        searchedCity: city,
        marker
      });
      if (!outcome.changed) {
        return untouched;
      }

      // A real row of the CURRENT search — its ClinicDetailsByDiary link feeds the composed lightbox
      // (GUIDs die with the search session, so keep replacing this with the freshest render's row).
      if (outcome.templateRowHtml) {
        latestTemplateRowHtml = outcome.templateRowHtml;
      }

      reportStatus({
        city,
        resultsCount: outcome.totalDeclared,
        inCityCount: outcome.keptRowCount
      });
      return {
        transformed: true,
        resultsCount: outcome.totalDeclared,
        inCityCount: outcome.keptRowCount,
        json: outcome.json,
        smile: {
          ...outcome,
          marker
        }
      };
    }

    function transformForUrl({ json, url, method }: UrlTransformInput): UrlTransformResult {
      return isSmileResultsUrl(url) ? transformSmile(json) : transformJson({
        json,
        url,
        method
      });
    }

    /** The site renders our filtered fragment asynchronously; wait for OUR marker to hit the DOM. */
    async function waitForMarkedList(marker: string): Promise<Element | null> {
      for (let attempt = 0; attempt < 25; attempt++) {
        const list = document.querySelector(`#am_diaries[${SMILE_MARKER_ATTR}="${marker}"] ul`);
        if (list) {
          return list;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return null;
    }

    /**
     * City completeness: the first response is one server page of the (rewritten, all-country) result
     * set — fetch the remaining pages with the PAGE's own session and append the city's rows to the
     * live list, order preserved, deduped by clinic name (diary GUIDs change per search). Then, if the
     * distance sort is active, re-rank the finished list by the user's live location.
     */
    async function finalizeSmileResults(first: MarkedSmileOutcome) {
      const run = ++aggregationRun;
      const city = smileCity();
      if (!city || !first.pageRowCount) {
        return;
      }

      const list = await waitForMarkedList(first.marker);
      if (!list) {
        return;
      }

      const totalPages = Math.ceil(first.totalDeclared / first.pageRowCount);
      const seenNames = new Set([...list.querySelectorAll("li.diary")].map(rowClinicName));
      let kept = first.keptRowCount;
      for (let page = 2; page <= totalPages; page++) {
        if (superseded || run !== aggregationRun || !config.enabled) {
          return;
        }

        let envelope: unknown;
        try {
          const response = await nativeFetch.call(window, `${SMILE_PAGING_PATH}?pageNumber=${page}`, {
            headers: {
              "X-Requested-With": "XMLHttpRequest"
            },
            credentials: "same-origin"
          });
          envelope = await response.json();
        } catch {
          return;
        }

        if (superseded || run !== aggregationRun) {
          return;
        }

        for (const row of extractCityRows({
          json: envelope,
          searchedCity: city
        })) {
          if (!seenNames.has(row.name)) {
            seenNames.add(row.name);
            list.insertAdjacentHTML("beforeend", row.html);
            kept += 1;
          }
        }

        const header = list.closest("#am_diaries")?.querySelector("h2");
        if (header) {
          setHeaderCount({
            header,
            count: kept
          });
        }

        reportStatus({
          city,
          resultsCount: first.totalDeclared,
          inCityCount: kept
        });
      }

      if (superseded || run !== aggregationRun) {
        return;
      }

      // City completeness beyond Tamuz: branches with no bookable diary still belong in the list.
      const detailsByTitle = await getPastVisitDetails();
      if (superseded || run !== aggregationRun) {
        return;
      }

      const added = appendMissingBranches({
        list,
        city,
        templateRowHtml: first.templateRowHtml,
        detailsByTitle
      });
      if (added) {
        kept += added;
        const header = list.closest("#am_diaries")?.querySelector("h2");
        if (header) {
          setHeaderCount({
            header,
            count: kept
          });
        }

        reportStatus({
          city,
          resultsCount: first.totalDeclared,
          inCityCount: kept
        });
      }

      if (activeSort === "home") {
        await reorderByLiveLocation({
          list,
          descending: sortDescending
        });
      }
    }

    /** Parse a real row's outerHTML into a live-document element to clone (site markup, not ours). */
    function parseRowTemplate(html: string): Element | null {
      if (!html) {
        return null;
      }

      const template = document.createElement("template");
      template.innerHTML = html;
      return template.content.firstElementChild;
    }

    interface AppendBranchesInput {
      list: Element;
      city: string;
      templateRowHtml: string;
      detailsByTitle: Map<string, string>;
    }

    /**
     * Append the searched city's Smile branches the search omits. Each row is a CLONE of a real server
     * row (never markup we authored — see applyBranchToRow), repurposed for the branch; "מידע נוסף"
     * opens the site's native clinic-details lightbox when the user has a visit there.
     */
    function appendMissingBranches({ list, city, templateRowHtml, detailsByTitle }: AppendBranchesInput): number {
      const seenCodes = new Set([...list.querySelectorAll("li.diary")].map(rowNavCode));
      const template =
        list.querySelector(`li.diary:not([${SYNTHETIC_ROW_ATTR}])`) ?? parseRowTemplate(templateRowHtml);
      if (!template) {
        return 0;
      }

      let added = 0;
      for (const branch of SMILE_BRANCHES) {
        if (seenCodes.has(branch.code) || !cityMatches({
          rowCity: branch.city,
          searchedCity: city
        })) {
          continue;
        }

        const clone = template.cloneNode(true);
        if (!(clone instanceof Element)) {
          continue;
        }

        applyBranchToRow({
          row: clone,
          branch,
          detailsVisitGuid: detailsByTitle.get(branch.title) ?? null
        });
        list.appendChild(clone);
        added += 1;
      }

      return added;
    }

    // ── Composed clinic-details lightbox (no-GUID branches) ────────────────────
    /** Call the page's own z.showDialog with a fragment — the exact call the site's handlers make. */
    function pageShowDialog(html: string): boolean {
      const pageUi = window.z;
      if (typeof pageUi?.showDialog !== "function") {
        return false;
      }

      try {
        pageUi.showDialog("#clinicDetailsLightbox", html);
      } catch {
        return false;
      }

      return true;
    }

    function openDetailsFallback(href: string) {
      if (href) {
        window.open(href, "_blank", "noopener");
      }
    }

    /**
     * "מידע נוסף" for a branch with no GUID of any kind: fetch a REAL current-search row's details
     * fragment (ClinicDetailsByDiary — the only endpoints that serve the lightbox are GUID- or
     * session-bound, see docs/reverse-engineering.md §10b), recompose it for this branch from the
     * committed directory, and open it in the site's own lightbox. Any failure falls back to the
     * anchor's nearme href in a new tab.
     */
    async function openBranchDetails({ code, fallbackHref }: {
      code: string;
      fallbackHref: string;
    }) {
      const branch = SMILE_BRANCHES.find(candidate => candidate.code === code);
      const templateLink = detailsLinkFromRowHtml(latestTemplateRowHtml);
      if (!branch || !templateLink) {
        openDetailsFallback(fallbackHref);
        return;
      }

      let fragment: string | null = null;
      try {
        const response = await nativeFetch.call(window, templateLink, {
          headers: {
            "X-Requested-With": "XMLHttpRequest"
          },
          credentials: "same-origin"
        });
        const envelope: unknown = await response.json();
        const parsed = smileEnvelopeSchema.safeParse(envelope);
        fragment = parsed.success ? applyBranchToDetailsFragment({
          template: parsed.data.data,
          branch
        }) : null;
      } catch {
        fragment = null;
      }

      if (superseded || !fragment || !pageShowDialog(fragment)) {
        openDetailsFallback(fallbackHref);
      }
    }

    document.addEventListener("click", event => {
      const modified = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
      if (superseded || !config.enabled || event.defaultPrevented || modified) {
        return;
      }

      if (!(event.target instanceof Element)) {
        return;
      }

      const anchor = event.target.closest(`a[${DETAILS_CODE_ATTR}]`);
      if (!anchor) {
        return;
      }

      const code = anchor.getAttribute(DETAILS_CODE_ATTR) ?? "";
      const fallbackHref = anchor.getAttribute("href") ?? "";
      event.preventDefault();
      openBranchDetails({
        code,
        fallbackHref
      }).catch(() => openDetailsFallback(fallbackHref));
    });

    // Past-visit clinic-details links (title → ClinicDetailsByVisit GUID), so a synthetic branch can open
    // the site's OWN clinic-details lightbox for a clinic the user has visited. Fetched once per page.
    let pastVisitDetails: Map<string, string> | null = null;
    async function getPastVisitDetails(): Promise<Map<string, string>> {
      if (pastVisitDetails) {
        return pastVisitDetails;
      }

      const map = new Map<string, string>();
      try {
        const response = await nativeFetch.call(window, "/Zimunet/", {
          headers: {
            "X-Requested-With": "XMLHttpRequest"
          },
          credentials: "same-origin"
        });
        const doc = new DOMParser().parseFromString(await response.text(), "text/html");
        for (const anchor of doc.querySelectorAll("a.clinicDetails[data-action-link*=\"ClinicDetailsByVisit\"]")) {
          const guid = anchor.getAttribute("data-action-link")?.split("/").pop();
          const title = anchor.textContent?.trim();
          if (guid && title && !map.has(title)) {
            map.set(title, guid);
          }
        }
      } catch { /* no history / not reachable — synthetic rows fall back to the nearme page */ }

      pastVisitDetails = map;
      return map;
    }

    // ── Live-location distance sort (the "hijack") ─────────────────────────────
    let cachedPosition: {
      coords: LatLng;
      fetchedAt: number;
    } | null = null;
    const POSITION_MAX_AGE_MS = 120_000;

    function currentPosition(): Promise<LatLng | null> {
      if (cachedPosition && Date.now() - cachedPosition.fetchedAt < POSITION_MAX_AGE_MS) {
        return Promise.resolve(cachedPosition.coords);
      }

      return new Promise(resolve => {
        if (!("geolocation" in navigator)) {
          resolve(null);
          return;
        }

        navigator.geolocation.getCurrentPosition(
          position => {
            cachedPosition = {
              coords: [position.coords.latitude, position.coords.longitude],
              fetchedAt: Date.now()
            };
            resolve(cachedPosition.coords);
          },
          () => resolve(null),
          {
            enableHighAccuracy: false,
            timeout: 8000,
            maximumAge: POSITION_MAX_AGE_MS
          }
        );
      });
    }

    /**
     * Stable re-rank of the finished list by great-circle distance from the user's live position
     * (clinic coordinates come from the committed nearme dataset — no runtime network). Rows without
     * known coordinates keep their server order at the end; a denied position leaves the list as-is.
     */
    async function reorderByLiveLocation({ list, descending }: {
      list: Element;
      descending: boolean;
    }) {
      const position = await currentPosition();
      if (!position || superseded) {
        return;
      }

      const ranked = [...list.querySelectorAll("li.diary")].map((row, index) => {
        const coords = DENTAL_CLINIC_COORDS[rowNavCode(row)];
        return {
          row,
          index,
          km: coords ? haversineKm({
            from: position,
            to: coords
          }) : Number.POSITIVE_INFINITY
        };
      });
      ranked.sort((first, second) => {
        const firstKnown = Number.isFinite(first.km);
        const secondKnown = Number.isFinite(second.km);
        if (firstKnown !== secondKnown) {
          return firstKnown ? -1 : 1;
        }

        let delta = 0;
        if (firstKnown) {
          delta = descending ? second.km - first.km : first.km - second.km;
        }

        return delta || first.index - second.index;
      });
      for (const { row, km } of ranked) {
        list.appendChild(row);

        if (Number.isFinite(km)) {
          setRowDistanceLabel({
            row,
            km
          });
        }
      }
    }

    // ── Generic JSON transform (non-Smile endpoints) ───────────────────────────
    function transformJson({ json, url, method }: UrlTransformInput): TransformResult {
      if (superseded || !config.enabled || !config.city.trim()) {
        return {
          transformed: false,
          resultsCount: 0,
          inCityCount: 0,
          json
        };
      }

      const rule = matchEndpointRule({
        url,
        method
      });
      if (!rule && !isInterestingUrl(url)) {
        return {
          transformed: false,
          resultsCount: 0,
          inCityCount: 0,
          json
        };
      }

      const result = applyGuarantee(json, {
        city: config.city,
        guaranteeMode: GUARANTEE_MODE,
        rule
      });
      if (result.transformed) {
        reportStatus({
          city: config.city,
          resultsCount: result.resultsCount,
          inCityCount: result.inCityCount
        });
      }

      return result;
    }

    // ── fetch ────────────────────────────────────────────────────────────────
    function requestUrl(input: RequestInfo | URL): string {
      if (typeof input === "string") {
        return input;
      }

      if (input instanceof URL) {
        return input.href;
      }

      return input.url;
    }

    const nativeFetch = window.fetch;
    window.fetch = async function patchedFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const response = await nativeFetch.call(this, input, init);
      const url = requestUrl(input);
      if (superseded || !/json/i.test(response.headers.get("content-type") ?? "")) {
        return response;
      }

      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      let json: unknown;
      try {
        json = JSON.parse(await response.clone().text());
      } catch {
        return response;
      }

      logDiscovery({
        method,
        url,
        status: response.status,
        json
      });
      const outcome = transformForUrl({
        json,
        url,
        method
      });
      if (!outcome.transformed) {
        return response;
      }

      if (outcome.smile && isSmileAggregationTrigger(url)) {
        finalizeSmileResults(outcome.smile).catch(() => {});
      }

      // Rebuild from the original headers but drop content-encoding/length: the body is now plain
      // (already-decoded) JSON, so a leftover `gzip`/stale length would corrupt how the page reads it.
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(JSON.stringify(outcome.json), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    };

    // ── XMLHttpRequest ─────────────────────────────────────────────────────────
    // Patch by redefining responseText/response as own-getters on each instance in open(), so the page
    // reads OUR (possibly transformed) body no matter the order of its own handlers. send() is patched
    // too: it rewrites the Smile search body (area → all country) and hooks aggregation onto load.
    const XHR = XMLHttpRequest.prototype;
    // Widened to a rest-args signature (open's first overload satisfies it) so the patch below can
    // forward the page's EXACT argument list — open(m, u) and open(m, u, undefined) differ natively.
    const nativeOpen: (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => void =
      XHR.open;
    const nativeSend = XHR.send;
    const nativeText = Object.getOwnPropertyDescriptor(XHR, "responseText");
    const nativeResponse = Object.getOwnPropertyDescriptor(XHR, "response");

    type XhrState = {
      method: string;
      url: string;
      computed?: {
        text: string;
        json: unknown;
        changed: boolean;
        smile?: MarkedSmileOutcome;
      };
    };
    const xhrStates = new WeakMap<XMLHttpRequest, XhrState>();
    type XhrContext = {
      xhr: XMLHttpRequest;
      state: XhrState;
    };

    function computeXhr({ xhr, state }: XhrContext) {
      if (state.computed || xhr.readyState !== 4) {
        return state.computed;
      }

      // Read the raw payload per responseType: reading responseText when responseType is "json" throws
      // InvalidStateError, so for "json" take the already-parsed object from `response` instead.
      let rawText = "";
      let json: unknown;
      try {
        if (xhr.responseType === "json") {
          json = nativeResponse?.get?.call(xhr);
        } else {
          rawText = String(nativeText?.get?.call(xhr) ?? "");
          json = JSON.parse(rawText);
        }
      } catch {
        state.computed = {
          text: rawText,
          json: undefined,
          changed: false
        };
        return state.computed;
      }

      if (json === null || typeof json !== "object") {
        state.computed = {
          text: rawText,
          json,
          changed: false
        };
        return state.computed;
      }

      logDiscovery({
        method: state.method,
        url: state.url,
        status: xhr.status,
        json
      });
      const outcome = transformForUrl({
        json,
        url: state.url,
        method: state.method
      });
      state.computed = {
        text: outcome.transformed ? JSON.stringify(outcome.json) : rawText,
        json: outcome.transformed ? outcome.json : json,
        changed: outcome.transformed,
        smile: outcome.smile
      };
      return state.computed;
    }

    XHR.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      let targetUrl = String(url);
      // A "distance" sort must reference the user's location: rewrite the "distance from the searched
      // city" sort (4) to the site's own "distance from your home" sort (3). The link is also removed
      // from our filtered fragments; this covers renders that predate the guarantee.
      if (!superseded && config.enabled && smileCity() && targetUrl.includes(SMILE_SORT_PATH)) {
        targetUrl = targetUrl.replace("sortValue=4", "sortValue=3");
        activeSort = targetUrl.includes("sortValue=3") ? "home" : "soonest";
        sortDescending = targetUrl.includes("sortDirection=2");
      }

      const state: XhrState = {
        method: String(method).toUpperCase(),
        url: targetUrl
      };
      xhrStates.set(this, state);

      return nativeOpen.call(this, method, targetUrl, ...rest);
    };

    /**
     * Defined from send(), NOT open(): generations of this patch stack (dev re-injection wraps the
     * previous patch), and inside the stacked open() chain the OLDEST generation's defineProperty runs
     * last and would clobber the active one's. Only the newest generation defines getters here (older
     * ones are superseded and skip), so the active transform always wins.
     */
    function defineResponseGetters({ xhr, state }: XhrContext) {
      Object.defineProperty(xhr, "responseText", {
        configurable: true,
        get(this: XMLHttpRequest) {
          // Only "" / "text" responseTypes expose responseText; for others defer to native (which
          // throws InvalidStateError, exactly as the page expects).
          if (this.responseType !== "" && this.responseType !== "text") {
            return nativeText?.get?.call(this);
          }

          const computed = computeXhr({
            xhr: this,
            state
          });
          return computed && this.readyState === 4 ? computed.text : String(nativeText?.get?.call(this) ?? "");
        }
      });

      Object.defineProperty(xhr, "response", {
        configurable: true,
        get(this: XMLHttpRequest) {
          if (this.responseType !== "" && this.responseType !== "text" && this.responseType !== "json") {
            return nativeResponse?.get?.call(this);
          }

          const computed = computeXhr({
            xhr: this,
            state
          });
          if (!computed || this.readyState !== 4) {
            return nativeResponse?.get?.call(this);
          }

          return this.responseType === "json" ? computed.json : computed.text;
        }
      });
    }

    XHR.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const state = superseded ? undefined : xhrStates.get(this);
      if (state) {
        defineResponseGetters({
          xhr: this,
          state
        });
      }

      let outgoing = body;
      if (state && !superseded && config.enabled && typeof outgoing === "string" && state.url.includes(SMILE_SEARCH_PATH)) {
        // The submitted city is the authoritative one for this search's server session.
        const submittedCity = new URLSearchParams(outgoing).get("SelectedCityName")?.trim();
        if (submittedCity) {
          activeSearchCity = submittedCity;
        }

        // A fresh search resets the server session to its default order (distance from searched city).
        activeSort = "cityDistance";
        sortDescending = false;

        // City completeness: search the WHOLE country, then filter — the area subset can miss some of
        // the city's own clinics, and rows spliced from a second search would carry dead session GUIDs.
        if (smileCity()) {
          outgoing = outgoing.replace(`${SMILE_AREA_FIELD}=1`, `${SMILE_AREA_FIELD}=0`);
        }
      }

      if (state && isSmileAggregationTrigger(state.url)) {
        this.addEventListener("load", () => {
          const computed = computeXhr({
            xhr: this,
            state
          });
          if (computed?.smile) {
            finalizeSmileResults(computed.smile).catch(() => {});
          }
        });
      }

      return nativeSend.call(this, outgoing);
    };
  }
});
