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
 * Generic JSON responses (non-Smile) go through the heuristic transform in transform.ts. No browser.*
 * access, no storage: config comes in over the window channel and status goes back the same way. In the
 * dev build it logs interesting requests to the page console (Discovery).
 */

import { ContentScriptContext, defineContentScript } from "#imports";
import { type GuaranteeStatus, PageMsg } from "@/lib/messaging";
import { onPageMessage, sendPageMessage } from "@/lib/messaging-page";
import {
  ALL_COUNTRY_AREA_VALUE,
  CITY_AREA_VALUE,
  CONTENT_MATCHES,
  GUARANTEE_MODE,
  isInterestingUrl,
  isSmileRestoreLocation,
  isSmileResultsUrl,
  matchEndpointRule,
  SMILE_AREA_FIELD,
  SMILE_CITY_FIELD,
  SMILE_SEARCH_PATH,
  SMILE_SORT_PATH,
  SMILE_SORT_VALUES,
  SMILE_SPECIALIZATION_FIELD,
  SMILE_SPECIALIZATION_SELECT_SELECTOR
} from "@/lib/targets";

import { searchConfigSchema, smileEnvelopeSchema } from "./schemas";
import { openInNewTab, waitForElement } from "./site-chrome";
import { DETAILS_CODE_ATTR, filterSmileEnvelope, MINT_CODE_ATTR, NO_DIARY_ROW_NOTE, SMILE_MARKER_ATTR } from "./smile";
import { createSmileAggregation, type MarkedSmileOutcome } from "./smile-aggregation";
import { createAvailabilityProbe } from "./smile-availability";
import {
  createTailoredClinicPage,
  emptyAvailabilityEnvelope,
  isAvailabilityUrl,
  tailoredBranchCode
} from "./smile-clinic-page";
import { createRowActions } from "./smile-row-actions";
import { createSmileSession } from "./smile-session";
import { applyGuarantee, type TransformResult } from "./transform";

export default defineContentScript({
  matches: [...CONTENT_MATCHES],
  runAt: "document_start",
  allFrames: true,
  world: "MAIN",
  main() {
    /**
     * WXT hands a MAIN-world script no context of its own (its `isValid` reads `browser.runtime`, which
     * does not exist out here), but the part that matters does not need one: the constructor announces
     * this script and aborts the older context of the same name. That is the whole generation handoff a
     * dev re-injection needs, done by the framework - so nothing below is registered any other way.
     */
    const ctx = new ContentScriptContext("clalit-interceptor");
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
      soonestFor: navCode => availability.soonestFor(navCode),
      slotsLinkFor: navCode => availability.slotsLinkFor(navCode)
    });
    const rowActions = createRowActions({
      session,
      slotsLinkFor: navCode => availability.slotsLinkFor(navCode),
      verdictFor: navCode => availability.verdictFor(navCode)
    });
    /**
     * The one thing a waiting retry cannot see in the DOM: the bridge's config landing. The city
     * arriving is a condition of the restore re-drive, so it announces itself here instead of being
     * noticed the next time something else happens to mutate the document.
     */
    const configListeners = new Set<() => void>();

    onPageMessage(PageMsg.Config, ({ data }) => {
      const parsed = searchConfigSchema.safeParse(data);
      if (!parsed.success) {
        return;
      }

      session.state.isEnabled = parsed.data.isEnabled;
      session.state.configCity = parsed.data.city;
      for (const listener of configListeners) {
        listener();
      }
    });

    function reportStatus({ city, resultsCount, inCityCount }: GuaranteeStatus) {
      sendPageMessage(PageMsg.Status, {
        city,
        resultsCount,
        inCityCount
      }).catch(() => {});
    }

    function logDiscovery({
      method,
      url,
      status,
      json
    }: {
      method: string;
      url: string;
      status: number;
      json: unknown;
    }) {
      if (import.meta.env.DEV && isInterestingUrl(url)) {
        console.log(`[clalit-city] ${method} ${url} → ${status}`, json);
      }
    }

    let renderCounter = 0;

    function isSmileAggregationTrigger(url: string) {
      return url.includes(SMILE_SEARCH_PATH) || url.includes(SMILE_SORT_PATH);
    }

    type UrlTransformResult = TransformResult & { smile?: MarkedSmileOutcome };
    interface UrlTransformInput {
      json: unknown;
      url: string;
      method: string;
    }

    function transformSmile(json: unknown) {
      const untouched: UrlTransformResult = {
        isTransformed: false,
        resultsCount: 0,
        inCityCount: 0,
        json
      };
      const city = session.city();
      // "מרפאות מכל הארץ" asks for the whole country; filtering that to one city would answer a
      // question the user did not ask, so every response of such a search is passed through as it came.
      if (!session.state.isEnabled || !city || !session.state.isCitySearch) {
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
      return isSmileResultsUrl(url)
        ? transformSmile(json)
        : transformJson({
            json,
            url,
            method
          });
    }

    ctx.addEventListener(
      document,
      "click",
      e => {
        const isModified = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
        if (!session.state.isEnabled || e.defaultPrevented || isModified) {
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

        const fallbackHref = elAnchor.getAttribute("href") ?? "";
        e.preventDefault();
        rowActions
          .openDetails({
            code: elAnchor.getAttribute(DETAILS_CODE_ATTR) ?? "",
            fallbackHref,
            note: NO_DIARY_ROW_NOTE
          })
          .catch(() => openInNewTab(fallbackHref));
      },
      { capture: true }
    );

    // ── Restore-document recovery (the "back" hole, docs §6d) ─────────────────
    // "Back" from a slots page is a DOCUMENT load (SmileClinic?isRestoreSearch=True): the server
    // renders the session's last search RAW into the page - no fetch/XHR runs, so the guarantee never
    // touches it, and the rendered rows are whatever Paging page the aggregation last fetched.
    //
    // Nothing is asked to search again. What the server rendered is the SAME fragment the network path
    // delivers - the site's own success handler is `container.html(envelope.data)`, so the container's
    // markup IS that envelope - and the guarantee is a pure string→string transform, so it runs on the
    // page where it stands. The aggregation then completes the city from the pages the session still
    // answers for, exactly as it does after an ordinary render.
    //
    // The restored specialization select is UNRELIABLE (observed 91 above a 92 session) - the session's
    // real specialization comes from the results header, matched against the select's own option labels.

    function restoredSessionSpecialization() {
      const headerText = document.querySelector("#am_diaries h2")?.textContent ?? "";
      const elSelect = document.querySelector<HTMLSelectElement>(SMILE_SPECIALIZATION_SELECT_SELECTOR);
      if (!headerText || !elSelect) {
        return null;
      }

      const elOption = [...elSelect.options].find(({ text }) => text.trim() && headerText.includes(text.trim()));
      return elOption?.value ?? null;
    }

    /** A search has run in this document: ours landing (the marked render), the user's own
     * (activeSearchCity is set at send time), or a prior generation's before a dev re-inject. */
    function isRestoreSettled() {
      return (
        !session.state.isEnabled ||
        Boolean(session.state.activeSearchCity) ||
        Boolean(document.querySelector(`#am_diaries[${SMILE_MARKER_ATTR}]`))
      );
    }

    /**
     * The element the site renders a search response into - `#am_diaries` is what the envelope carries,
     * so its parent is the container and the container's markup is the envelope's `data` verbatim.
     */
    function restoredListContainer() {
      return document.querySelector("#am_diaries")?.parentElement ?? null;
    }

    /**
     * The guarantee, applied to the markup already on the page. The same transform the network path
     * runs, given the same fragment, put back where it came from - which also means the marker, the
     * status report and the aggregation all behave exactly as they do after an ordinary render.
     */
    function guaranteeRenderedList() {
      const elContainer = restoredListContainer();
      if (!elContainer) {
        return;
      }

      const outcome = transformSmile({ data: elContainer.innerHTML });
      // The envelope's own shape, not `getSmileHtml`: that one doubles as "is this a Smile response at
      // all" by looking for a row in the markup, and a page whose every row belonged to another city
      // filters down to none - which is a correct result here, and the aggregation is about to fill it
      // from the rest of the session's pages.
      const parsed = smileEnvelopeSchema.safeParse(outcome.json);
      if (!outcome.smile || !parsed.success) {
        return;
      }

      elContainer.innerHTML = parsed.data.data;
      aggregation.finalize(outcome.smile).catch(() => {});
    }

    /**
     * The city, which is the one thing this cannot start without: it comes from the bridge reading the
     * restored search box, and filtering to an empty city would be filtering to nothing. The config
     * message announces itself (see `configListeners`), so this waits on that rather than on the next
     * thing to happen to touch the DOM.
     */
    function cityKnown() {
      if (session.city()) {
        return Promise.resolve();
      }

      return new Promise<void>(resolve => {
        function onConfig() {
          if (session.city()) {
            configListeners.delete(onConfig);
            resolve();
          }
        }

        configListeners.add(onConfig);
      });
    }

    /**
     * This script starts at `document_start` and has to - that is the only moment it can patch fetch and
     * XHR before the site's own code captures references to them - so the restored list it exists to
     * transform is not in the DOM yet. It waits for THAT rather than for a lifecycle milestone:
     * `waitForElement` returns at once when the element is already there (a dev re-injection, a late
     * evaluation) and otherwise on the mutation that adds it, so there is no readiness to track.
     *
     * The specialization select sits above the list in the same server-rendered document, so it is
     * parsed by the time this resolves.
     */
    async function recoverRestoredSearch() {
      await waitForElement({ selector: "#am_diaries" });
      // The session's own specialization, before anything asks it a question: the aggregation's sweep
      // and every appended row answer for the service the restored search was FOR, and the select on
      // this page is not that (docs §6d).
      const specialization = restoredSessionSpecialization();
      if (!specialization) {
        return;
      }

      session.state.activeSearchSpecialization = specialization;
      await cityKnown();

      if (isRestoreSettled()) {
        return;
      }

      guaranteeRenderedList();
    }

    if (isSmileRestoreLocation(window.location)) {
      recoverRestoredSearch().catch(() => {});
    }

    // ── A branch's own appointments page, borrowed (docs §12i) ─────────────────
    // "לכל התורים" on a branch Tamuz has no handle for lands on a REAL diary's slots page carrying the
    // branch's code in the hash. Here that page becomes the branch's: retitled, and its availability
    // calls answered with the site's own empty month, so nothing of the lender's is left to book.
    const tailoredClinicPage = createTailoredClinicPage(tailoredBranchCode(window.location.hash));
    if (tailoredClinicPage.isTailored) {
      tailoredClinicPage.tailor().catch(() => {});
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
      // Stood down (a newer generation started - see the ctx handoff below): the page may still hold
      // this function, so it answers as the native one would.
      const url = requestUrl(input);
      if (ctx.signal.aborted || !/json/i.test(response.headers.get("content-type") ?? "")) {
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
      const outcome =
        tailoredClinicPage.isTailored && isAvailabilityUrl(url)
          ? {
              isTransformed: true,
              resultsCount: 0,
              inCityCount: 0,
              json: emptyAvailabilityEnvelope()
            }
          : transformForUrl({
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
    const nativeOpen: (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => void = XHR.open;
    const nativeSend = XHR.send;
    const nativeText = Object.getOwnPropertyDescriptor(XHR, "responseText");
    const nativeResponse = Object.getOwnPropertyDescriptor(XHR, "response");

    interface XhrState {
      method: string;
      url: string;
      computed?: {
        text: string;
        json: unknown;
        isChanged: boolean;
        smile?: MarkedSmileOutcome;
      };
    }
    const xhrStates = new WeakMap<XMLHttpRequest, XhrState>();
    interface XhrContext {
      xhr: XMLHttpRequest;
      state: XhrState;
    }

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
      const outcome =
        tailoredClinicPage.isTailored && isAvailabilityUrl(url)
          ? {
              isTransformed: true,
              resultsCount: 0,
              inCityCount: 0,
              json: emptyAvailabilityEnvelope()
            }
          : transformForUrl({
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
      if (ctx.signal.aborted) {
        return nativeOpen.call(this, method, url, ...rest);
      }

      let targetUrl = String(url);
      // A "distance" sort must reference the user's location: rewrite the "distance from the searched
      // city" sort (4) to the site's own "distance from your home" sort (3). The link is also removed
      // from our filtered fragments; this covers renders that predate the guarantee.
      if (session.isActive() && session.city() && targetUrl.includes(SMILE_SORT_PATH)) {
        targetUrl = targetUrl.replace(
          `sortValue=${SMILE_SORT_VALUES.cityDistance}`,
          `sortValue=${SMILE_SORT_VALUES.homeDistance}`
        );
        session.state.activeSort = targetUrl.includes(`sortValue=${SMILE_SORT_VALUES.homeDistance}`)
          ? "home"
          : "soonest";
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
      if (ctx.signal.aborted) {
        return nativeSend.call(this, body);
      }

      const state = xhrStates.get(this);
      if (state) {
        defineResponseGetters({
          xhr: this,
          state
        });
      }

      let outgoing = body;
      if (state && session.state.isEnabled && typeof outgoing === "string" && state.url.includes(SMILE_SEARCH_PATH)) {
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

        // Which of the form's two radios this is. "מרפאות מכל הארץ" is a request for the whole country,
        // so the guarantee stands down for it entirely - see SmileSessionState.isCitySearch.
        session.state.isCitySearch = submitted.get(SMILE_AREA_FIELD) !== ALL_COUNTRY_AREA_VALUE;

        // City completeness: search the WHOLE country, then filter - the area subset can miss some of
        // the city's own clinics, and rows spliced from a second search would carry dead session GUIDs.
        if (session.city() && session.state.isCitySearch) {
          outgoing = outgoing.replace(
            `${SMILE_AREA_FIELD}=${CITY_AREA_VALUE}`,
            `${SMILE_AREA_FIELD}=${ALL_COUNTRY_AREA_VALUE}`
          );
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

    /**
     * Standing down is WXT's own handshake, not an invention of ours: every content script that starts
     * announces itself (`wxt:content-script-started`) and aborts the older ctx of the same name, which
     * is exactly what a dev re-injection produces. Everything above is hung on that ctx - the listeners
     * through `ctx.addEventListener`, the badge through `createShadowRootUi` - so the only thing left to
     * undo by hand is the pair of page globals this script patches. They go back as they were, and the
     * newer copy then patches a clean base instead of wrapping a stale wrapper.
     */
    ctx.onInvalidated(() => {
      window.fetch = nativeFetch;
      XHR.open = nativeOpen;
      XHR.send = nativeSend;
    });
  }
});
