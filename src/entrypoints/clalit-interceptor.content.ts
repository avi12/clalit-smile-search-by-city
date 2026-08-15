/**
 * MAIN-world interceptor - runs in the PAGE's own JS context (world: "MAIN", document_start) so it can
 * patch `window.fetch` and `XMLHttpRequest` before the site's scripts capture references to them.
 *
 * Two guarantees (see docs/reverse-engineering.md):
 *   1. City completeness - a Smile clinic search shows ALL of the searched city's clinics and ONLY
 *      them: the outgoing search is rewritten from "area" to "all country" (so the server session holds
 *      the full set and every row link stays valid), each response is filtered to the city, and the
 *      remaining server pages are aggregated into the one visible list.
 *   2. A "distance" sort references the USER's location - the "distance from the searched city" sort is
 *      removed/rewritten to the site's own "מרחק מהבית שלך" sort.
 *
 * Generic JSON responses (non-Smile) go through the heuristic transform in transform.ts. No chrome.*
 * access, no storage: config comes in over the window channel and status goes back the same way. In the
 * dev build it logs interesting requests to the page console (Discovery).
 */

import { installDevTakeover } from "../lib/dev-takeover";
import { type GuaranteeStatus, PageMsg } from "../lib/messaging";
import { onPageMessage, removeAllPageListeners, sendPageMessage } from "../lib/messaging-page";
import { searchConfigSchema } from "../lib/schemas";
import { openInNewTab } from "../lib/site-chrome";
import {
  DETAILS_CODE_ATTR,
  filterSmileEnvelope,
  MINT_CODE_ATTR,
  NO_DIARY_ROW_NOTE,
  SMILE_MARKER_ATTR
} from "../lib/smile";
import { createSmileAggregation, type MarkedSmileOutcome } from "../lib/smile-aggregation";
import { createAvailabilityProbe } from "../lib/smile-availability";
import {
  createTailoredClinicPage,
  emptyAvailabilityEnvelope,
  isAvailabilityUrl,
  tailoredBranchCode
} from "../lib/smile-clinic-page";
import { createRowActions } from "../lib/smile-row-actions";
import { createSmileSession } from "../lib/smile-session";
import {
  CONTENT_MATCHES,
  GUARANTEE_MODE,
  isInterestingUrl,
  isSmileRestoreLocation,
  isSmileResultsUrl,
  matchEndpointRule,
  SMILE_AREA_FIELD,
  SMILE_CITY_FIELD,
  SMILE_SEARCH_BUTTON_SELECTOR,
  SMILE_SEARCH_PATH,
  SMILE_SORT_PATH,
  SMILE_SORT_VALUES,
  SMILE_SPECIALIZATION_FIELD,
  SMILE_SPECIALIZATION_SELECT_SELECTOR
} from "../lib/targets";
import { applyGuarantee, type TransformResult } from "../lib/transform";
import { defineContentScript } from "#imports";

export default defineContentScript({
  matches: [...CONTENT_MATCHES],
  runAt: "document_start",
  allFrames: true,
  world: "MAIN",
  main() {
    // The page's UNPATCHED fetch, captured before the patches below - the session's own calls must not
    // flow through our transforms.
    const nativeFetch = window.fetch;
    // One shared view of the server session: what was searched, which services answer, whether we are
    // still the active generation. Everything else in this file reads and writes it.
    const session = createSmileSession(nativeFetch);
    const availability = createAvailabilityProbe({
      session,
      isMintInFlight: () => rowActions.isMintInFlight()
    });
    const aggregation = createSmileAggregation({
      session,
      nativeFetch,
      reportStatus,
      ensureVerdicts: navCodes => availability.ensureVerdicts(navCodes),
      bookabilityOf: navCode => availability.verdictFor(navCode),
      soonestFor: navCode => availability.soonestFor(navCode)
    });
    const rowActions = createRowActions({ session });
    if (import.meta.env.DEV) {
      installDevTakeover({
        script: "interceptor",
        onSuperseded() {
          session.state.isSuperseded = true;
          removeAllPageListeners();
        }
      });
    }

    onPageMessage(PageMsg.Config, ({ data }) => {
      const parsed = searchConfigSchema.safeParse(data);
      if (parsed.success) {
        session.state.isEnabled = parsed.data.isEnabled;
        session.state.configCity = parsed.data.city;
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
      if (import.meta.env.DEV && !session.state.isSuperseded && isInterestingUrl(url)) {
        console.log(`[clalit-city] ${method} ${url} → ${status}`, json);
      }
    }

    let renderCounter = 0;

    function isSmileAggregationTrigger(url: string) {
      return url.includes(SMILE_SEARCH_PATH) || url.includes(SMILE_SORT_PATH);
    }

    type UrlTransformResult = TransformResult & { smile?: MarkedSmileOutcome };
    type UrlTransformInput = {
      json: unknown;
      url: string;
      method: string;
    };

    function transformSmile(json: unknown) {
      const untouched: UrlTransformResult = {
        isTransformed: false,
        resultsCount: 0,
        inCityCount: 0,
        json
      };
      const city = session.city();
      if (session.state.isSuperseded || !session.state.isEnabled || !city) {
        return untouched;
      }

      const marker = String(++renderCounter);
      const outcome = filterSmileEnvelope({
        json,
        searchedCity: city,
        marker
      });
      if (!outcome.isChanged) {
        return untouched;
      }

      const { templateRowHtml, totalDeclared, keptRowCount } = outcome;
      // A real row of the CURRENT search - its ClinicDetailsByDiary link feeds the composed lightbox
      // (GUIDs die with the search session, so keep replacing this with the freshest render's row).
      if (templateRowHtml) {
        session.state.latestTemplateRowHtml = templateRowHtml;
      }

      reportStatus({
        city,
        resultsCount: totalDeclared,
        inCityCount: keptRowCount
      });
      return {
        isTransformed: true,
        resultsCount: totalDeclared,
        inCityCount: keptRowCount,
        json: outcome.json,
        smile: {
          ...outcome,
          marker
        }
      };
    }

    function transformForUrl({ json, url, method }: UrlTransformInput) {
      return isSmileResultsUrl(url) ? transformSmile(json) : transformJson({
        json,
        url,
        method
      });
    }

    document.addEventListener("click", e => {
      const isModified = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
      if (session.state.isSuperseded || !session.state.isEnabled || e.defaultPrevented || isModified) {
        return;
      }

      const { target } = e;
      if (!(target instanceof Element)) {
        return;
      }

      const elMintButton = target.closest(`a[${MINT_CODE_ATTR}]`);
      if (elMintButton) {
        // The site's delegated handler binds by class/id, NOT by data-action-link - left alone it reads
        // the stripped attribute as undefined and navigates the iframe to /Zimunet/undefined (observed
        // live). Capture-phase + stopPropagation keeps the click ours alone.
        e.preventDefault();
        e.stopPropagation();
        rowActions.openDiaries(elMintButton.getAttribute(MINT_CODE_ATTR) ?? "").catch(() => {});
        return;
      }

      const elAnchor = target.closest(`a[${DETAILS_CODE_ATTR}]`);
      if (!elAnchor) {
        return;
      }

      const code = elAnchor.getAttribute(DETAILS_CODE_ATTR) ?? "";
      const fallbackHref = elAnchor.getAttribute("href") ?? "";
      e.preventDefault();
      rowActions.openDetails({
        code,
        fallbackHref,
        note: NO_DIARY_ROW_NOTE
      }).catch(() => openInNewTab(fallbackHref));
    }, true);

    // ── Restore-document recovery (the "back" hole, docs §6d) ─────────────────
    // "Back" from a slots page is a DOCUMENT load (SmileClinic?isRestoreSearch=True): the server
    // renders the session's last search RAW into the page - no fetch/XHR runs, so the guarantee never
    // touches it, and the rendered rows are whatever Paging page the aggregation last fetched. Recovery
    // re-drives that same search through the site's own form; the fresh XHR then flows through the
    // normal pipeline. The restored form's specialization select is UNRELIABLE (observed 91 above a 92
    // session) - the session's real specialization comes from the results header, matched against the
    // select's own option labels.

    function domReady() {
      if (document.readyState !== "loading") {
        return Promise.resolve();
      }

      return new Promise<void>(resolve => {
        document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
      });
    }

    function restoredSessionSpecialization() {
      const headerText = document.querySelector("#am_diaries h2")?.textContent ?? "";
      const elSelect = document.querySelector<HTMLSelectElement>(SMILE_SPECIALIZATION_SELECT_SELECTOR);
      if (!headerText || !elSelect) {
        return null;
      }

      const elOption = [...elSelect.options].find(({ text }) => text.trim() && headerText.includes(text.trim()));
      return elOption?.value ?? null;
    }

    function redriveSearch(specialization: string) {
      const elSearchButton = document.querySelector<HTMLInputElement>(SMILE_SEARCH_BUTTON_SELECTOR);
      if (!elSearchButton) {
        return;
      }

      const elSelect = document.querySelector<HTMLSelectElement>(SMILE_SPECIALIZATION_SELECT_SELECTOR);
      if (elSelect && elSelect.value !== specialization) {
        elSelect.value = specialization;
        elSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }

      // Belt: until the site's own handler is bound, the submit button's default action would NATIVE-
      // submit the form (a document POST). The real search flow is always XHR, so preventing the
      // default keeps a too-early click harmless - the retry loop just tries again.
      elSearchButton.closest("form")?.addEventListener("submit", e => e.preventDefault(), { once: true });
      elSearchButton.click();
    }

    /** A search has run in this document: ours landing (the marked render), the user's own
     * (activeSearchCity is set at send time), or a prior generation's before a dev re-inject. */
    function isRestoreSettled() {
      return session.state.isSuperseded || !session.state.isEnabled ||
        Boolean(session.state.activeSearchCity) || Boolean(document.querySelector(`#am_diaries[${SMILE_MARKER_ATTR}]`));
    }

    /** Re-drive only once BOTH are true: the city is known (the bridge has read it out of the restored
     * search box - searching before that would re-run the same unfiltered search we are here to
     * replace), and the site's bundle is up (before that the button is not an XHR search). */
    function isRestoreReady() {
      return Boolean(session.city()) && document.readyState === "complete" && Boolean(window.z);
    }

    /**
     * Both conditions are things the PAGE does, so the page says when to look again: its own load event,
     * and every DOM change the bundle and the bridge make on their way in.
     */
    function redriveWhenReady(specialization: string) {
      return new Promise<void>(resolve => {
        const observer = new MutationObserver(attempt);

        function stop() {
          observer.disconnect();
          window.removeEventListener("load", attempt);
          resolve();
        }

        function attempt() {
          if (isRestoreSettled()) {
            stop();
            return;
          }

          if (isRestoreReady()) {
            redriveSearch(specialization);
            stop();
          }
        }

        window.addEventListener("load", attempt);
        observer.observe(document, {
          childList: true,
          subtree: true
        });
        attempt();
      });
    }

    async function recoverRestoredSearch() {
      await domReady();
      const specialization = restoredSessionSpecialization();
      if (specialization) {
        await redriveWhenReady(specialization);
      }
    }

    if (isSmileRestoreLocation(window.location)) {
      recoverRestoredSearch().catch(() => {});
    }

    // ── A branch's own appointments page, borrowed (docs §12i) ─────────────────
    // "לכל התורים" on a branch Tamuz has no handle for lands on a REAL diary's slots page carrying the
    // branch's code in the hash. Here that page becomes the branch's: retitled, and its availability
    // calls answered with the site's own empty month, so nothing of the lender's is left to book.
    const tailoredClinicPage = createTailoredClinicPage(tailoredBranchCode(window.location.hash));

    async function tailorClinicPage() {
      await domReady();
      tailoredClinicPage.apply();
      tailoredClinicPage.watchDatepicker();
    }

    if (tailoredClinicPage.isTailored) {
      tailorClinicPage().catch(() => {});
    }

    // ── Generic JSON transform (non-Smile endpoints) ───────────────────────────
    function transformJson({ json, url, method }: UrlTransformInput) {
      const city = session.state.configCity;
      // Typed here rather than on the signature: it is what makes this share ONE shape with
      // transformSmile, so the union transformForUrl returns still carries `smile`.
      const untouched: UrlTransformResult = {
        isTransformed: false,
        resultsCount: 0,
        inCityCount: 0,
        json
      };
      if (!session.isActive() || !city.trim()) {
        return untouched;
      }

      const rule = matchEndpointRule({
        url,
        method
      });
      if (!rule && !isInterestingUrl(url)) {
        return untouched;
      }

      const result: UrlTransformResult = applyGuarantee(json, {
        city,
        guaranteeMode: GUARANTEE_MODE,
        rule
      });
      if (result.isTransformed) {
        reportStatus({
          city,
          resultsCount: result.resultsCount,
          inCityCount: result.inCityCount
        });
      }

      return result;
    }

    // ── fetch ────────────────────────────────────────────────────────────────
    function requestUrl(input: RequestInfo | URL) {
      if (typeof input === "string") {
        return input;
      }

      if (input instanceof URL) {
        return input.href;
      }

      return input.url;
    }

    window.fetch = async function patchedFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const response = await nativeFetch.call(this, input, init);
      const url = requestUrl(input);
      if (session.state.isSuperseded || !/json/i.test(response.headers.get("content-type") ?? "")) {
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
      const outcome = tailoredClinicPage.isTailored && isAvailabilityUrl(url) ? {
        isTransformed: true,
        resultsCount: 0,
        inCityCount: 0,
        json: emptyAvailabilityEnvelope()
      } : transformForUrl({
        json,
        url,
        method
      });
      if (!outcome.isTransformed) {
        return response;
      }

      if (outcome.smile && isSmileAggregationTrigger(url)) {
        aggregation.finalize(outcome.smile).catch(() => {});
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
    // forward the page's EXACT argument list - open(m, u) and open(m, u, undefined) differ natively.
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
        isChanged: boolean;
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
          isChanged: false
        };
        return state.computed;
      }

      if (json === null || typeof json !== "object") {
        state.computed = {
          text: rawText,
          json,
          isChanged: false
        };
        return state.computed;
      }

      const { method, url } = state;
      logDiscovery({
        method,
        url,
        status: xhr.status,
        json
      });
      const outcome = tailoredClinicPage.isTailored && isAvailabilityUrl(url) ? {
        isTransformed: true,
        resultsCount: 0,
        inCityCount: 0,
        json: emptyAvailabilityEnvelope()
      } : transformForUrl({
        json,
        url,
        method
      });
      state.computed = {
        text: outcome.isTransformed ? JSON.stringify(outcome.json) : rawText,
        json: outcome.isTransformed ? outcome.json : json,
        isChanged: outcome.isTransformed,
        smile: outcome.smile
      };
      return state.computed;
    }

    XHR.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      let targetUrl = String(url);
      // A "distance" sort must reference the user's location: rewrite the "distance from the searched
      // city" sort (4) to the site's own "distance from your home" sort (3). The link is also removed
      // from our filtered fragments; this covers renders that predate the guarantee.
      if (session.isActive() && session.city() && targetUrl.includes(SMILE_SORT_PATH)) {
        targetUrl = targetUrl.replace(
          `sortValue=${SMILE_SORT_VALUES.cityDistance}`,
          `sortValue=${SMILE_SORT_VALUES.homeDistance}`
        );
        session.state.activeSort = targetUrl.includes(`sortValue=${SMILE_SORT_VALUES.homeDistance}`) ? "home" : "soonest";
        session.state.isSortDescending = targetUrl.includes("sortDirection=2");
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
      const state = session.state.isSuperseded ? undefined : xhrStates.get(this);
      if (state) {
        defineResponseGetters({
          xhr: this,
          state
        });
      }

      let outgoing = body;
      if (state && !session.state.isSuperseded && session.state.isEnabled && typeof outgoing === "string" && state.url.includes(SMILE_SEARCH_PATH)) {
        // The submitted city and specialization are the authoritative ones for this server session.
        const submitted = new URLSearchParams(outgoing);
        const submittedCity = submitted.get(SMILE_CITY_FIELD)?.trim();
        if (submittedCity) {
          session.state.activeSearchCity = submittedCity;
        }

        const submittedSpecialization = submitted.get(SMILE_SPECIALIZATION_FIELD)?.trim();
        if (submittedSpecialization) {
          session.state.activeSearchSpecialization = submittedSpecialization;
        }

        // A fresh search resets the server session to its default order (distance from searched city).
        session.state.activeSort = "cityDistance";
        session.state.isSortDescending = false;

        // City completeness: search the WHOLE country, then filter - the area subset can miss some of
        // the city's own clinics, and rows spliced from a second search would carry dead session GUIDs.
        if (session.city()) {
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
            aggregation.finalize(computed.smile).catch(() => {});
          }
        });
      }

      return nativeSend.call(this, outgoing);
    };
  }
});
