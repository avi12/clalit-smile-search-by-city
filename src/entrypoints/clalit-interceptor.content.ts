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
  MINT_CODE_ATTR,
  MINT_NAVIGATE_NOTE,
  NO_DIARY_ROW_NOTE,
  NO_DIARY_SWEEP_NOTE,
  refreshRowActionLinks,
  rowClinicName,
  rowNavCode,
  scanEnvelopeForNavCode,
  setDialogNote,
  setHeaderCount,
  setLoaderNote,
  setRowDistanceLabel,
  SMILE_MARKER_ATTR,
  type SmileFilterOutcome,
  sweepStepNote,
  SYNTHETIC_ROW_ATTR
} from "../lib/smile";
import {
  CONTENT_MATCHES,
  GUARANTEE_MODE,
  isInterestingUrl,
  isSmileRestoreLocation,
  isSmileResultsUrl,
  matchEndpointRule,
  SITE_LOADER_SELECTOR,
  SMILE_AREA_FIELD,
  SMILE_CITY_FIELD,
  SMILE_DETAILS_DIALOG_SELECTOR,
  SMILE_PAGING_PATH,
  SMILE_SEARCH_BUTTON_SELECTOR,
  SMILE_SEARCH_PATH,
  SMILE_SORT_PATH,
  SMILE_SPECIALIZATION_CODES,
  SMILE_SPECIALIZATION_FIELD,
  SMILE_SPECIALIZATION_SELECT_SELECTOR
} from "../lib/targets";
import { applyGuarantee, type TransformResult } from "../lib/transform";
import { defineContentScript } from "#imports";

/** The Zimunet site bundle's own UI namespace — the MAIN world sees the page's globals. */
interface ZimunetPageUi {
  showDialog?: (selector: string, html: string) => void;
  showLoader?: () => void;
  hideLoader?: () => void;
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
      isEnabled: true,
      city: ""
    };
    // Dev re-injection: a newer generation flips this and the patches below become pass-throughs.
    let isSuperseded = false;
    if (import.meta.env.DEV) {
      installDevTakeover({
        script: "interceptor",
        onSuperseded() {
          isSuperseded = true;
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
      if (import.meta.env.DEV && !isSuperseded && isInterestingUrl(url)) {
        console.log(`[clalit-city] ${method} ${url} → ${status}`, json);
      }
    }

    // ── Smile clinic search (HTML fragments in a JSON envelope) ────────────────
    // The city the server session's result set was actually searched for — read from the outgoing
    // search request itself, so filtering never drifts from what's in the search box vs what was
    // submitted. Sort/paging calls inherit it (they operate on the same server session).
    let activeSearchCity = "";
    // The specialization the user's search submitted — the minting sweep tries it first, and it is
    // what a session restore re-runs after a failed sweep.
    let activeSearchSpec: string = SMILE_SPECIALIZATION_CODES[0];
    let renderCounter = 0;
    let aggregationRun = 0;
    let latestTemplateRowHtml = "";
    // The sort the server session currently applies. "home" (מרחק מהבית שלך) is hijacked: rows are
    // re-ranked by distance from the user's LIVE location (navigator.geolocation), falling back to the
    // server's home-distance order when the position is denied/unavailable.
    type SmileSort = "cityDistance" | "soonest" | "home";
    let activeSort: SmileSort = "cityDistance";
    let isSortDescending = false;

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
        isTransformed: false,
        resultsCount: 0,
        inCityCount: 0,
        json
      };
      const city = smileCity();
      if (isSuperseded || !config.isEnabled || !city) {
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
      // A real row of the CURRENT search — its ClinicDetailsByDiary link feeds the composed lightbox
      // (GUIDs die with the search session, so keep replacing this with the freshest render's row).
      if (templateRowHtml) {
        latestTemplateRowHtml = templateRowHtml;
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

    function transformForUrl({ json, url, method }: UrlTransformInput): UrlTransformResult {
      return isSmileResultsUrl(url) ? transformSmile(json) : transformJson({
        json,
        url,
        method
      });
    }

    /** GET/POST a /Zimunet/ endpoint with the PAGE's own session, bypassing our own patches. */
    async function fetchSessionJson({ url, body }: {
      url: string;
      body?: string;
    }): Promise<unknown> {
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

    /**
     * Poll for an element the SITE renders asynchronously (its own Ajax, or our filtered fragment).
     * `exclude` skips the one that was already there: the site HIDES a lightbox instead of removing it
     * (`z.hideAllLightboxes`) and prepends the new one, so a stale dialog can still match the selector.
     */
    async function waitForElement({ selector, exclude }: {
      selector: string;
      exclude?: Element | null;
    }): Promise<Element | null> {
      for (let attempt = 0; attempt < 25; attempt++) {
        const element = document.querySelector(selector);
        if (element && element !== exclude) {
          return element;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return null;
    }

    /** The site renders our filtered fragment asynchronously; wait for OUR marker to hit the DOM. */
    function waitForMarkedList(marker: string): Promise<Element | null> {
      return waitForElement({ selector: `#am_diaries[${SMILE_MARKER_ATTR}="${marker}"] ul` });
    }

    /**
     * City completeness: the first response is one server page of the (rewritten, all-country) result
     * set — fetch the remaining pages with the PAGE's own session and append the city's rows to the
     * live list, order preserved, deduped by clinic name (diary GUIDs change per search). Then, if the
     * distance sort is active, re-rank the finished list by the user's live location.
     */
    async function finalizeSmileResults(
      { marker, pageRowCount, totalDeclared, keptRowCount, templateRowHtml }: MarkedSmileOutcome
    ) {
      const run = ++aggregationRun;
      const city = smileCity();
      if (!city || !pageRowCount) {
        return;
      }

      const list = await waitForMarkedList(marker);
      if (!list) {
        return;
      }

      const totalPages = Math.ceil(totalDeclared / pageRowCount);
      const seenNames = new Set([...list.querySelectorAll("li.diary")].map(rowClinicName));
      let kept = keptRowCount;
      for (let page = 2; page <= totalPages; page++) {
        if (isSuperseded || run !== aggregationRun || !config.isEnabled) {
          return;
        }

        const envelope = await fetchSessionJson({ url: `${SMILE_PAGING_PATH}?pageNumber=${page}` }).catch(() => null);
        if (!envelope || isSuperseded || run !== aggregationRun) {
          return;
        }

        for (const { name, html } of extractCityRows({
          json: envelope,
          searchedCity: city
        })) {
          if (!seenNames.has(name)) {
            seenNames.add(name);
            list.insertAdjacentHTML("beforeend", html);
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
          resultsCount: totalDeclared,
          inCityCount: kept
        });
      }

      if (isSuperseded || run !== aggregationRun) {
        return;
      }

      // City completeness beyond Tamuz: branches with no bookable diary still belong in the list.
      const detailsByTitle = await getPastVisitDetails();
      if (isSuperseded || run !== aggregationRun) {
        return;
      }

      const added = appendMissingBranches({
        list,
        city,
        templateRowHtml,
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
          resultsCount: totalDeclared,
          inCityCount: kept
        });
      }

      if (activeSort === "home") {
        await reorderByLiveLocation({
          list,
          isDescending: isSortDescending
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
    function pageShowDialog({ html, note }: {
      html: string;
      note: string;
    }): boolean {
      const pageUi = window.z;
      if (typeof pageUi?.showDialog !== "function") {
        return false;
      }

      try {
        pageUi.showDialog(SMILE_DETAILS_DIALOG_SELECTOR, html);
      } catch {
        return false;
      }

      // showDialog prepends the dialog synchronously, so the note lands in the same frame as the open.
      const dialog = document.querySelector(SMILE_DETAILS_DIALOG_SELECTOR);
      if (dialog) {
        setDialogNote({
          dialog,
          text: note
        });
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
    async function openBranchDetails({ code, fallbackHref, note }: {
      code: string;
      fallbackHref: string;
      note: string;
    }) {
      const branch = SMILE_BRANCHES.find(candidate => candidate.code === code);
      const templateLink = detailsLinkFromRowHtml(latestTemplateRowHtml);
      if (!branch || !templateLink) {
        openDetailsFallback(fallbackHref);
        return;
      }

      const envelope = await fetchSessionJson({ url: templateLink }).catch(() => null);
      const parsed = smileEnvelopeSchema.safeParse(envelope);
      const fragment = parsed.success ? applyBranchToDetailsFragment({
        template: parsed.data.data,
        branch
      }) : null;
      if (isSuperseded || !fragment || !pageShowDialog({
        html: fragment,
        note
      })) {
        openDetailsFallback(fallbackHref);
      }
    }

    /**
     * The details view for a synthetic row, carrying `note` inside the lightbox: our composed fragment
     * when the branch has no GUID at all, or the site's OWN ClinicDetailsByVisit lightbox when the row
     * links a past visit there — same container either way, so the note lands in both.
     */
    async function openRowDetails({ row, note }: {
      row: Element | null;
      note: string;
    }) {
      const moreInfo = row?.querySelector<HTMLElement>(
        `a.pull-left[data-action-link], a.pull-left[${DETAILS_CODE_ATTR}]`
      );
      if (!moreInfo) {
        return;
      }

      const code = moreInfo.getAttribute(DETAILS_CODE_ATTR);
      if (code) {
        await openBranchDetails({
          code,
          fallbackHref: moreInfo.getAttribute("href") ?? "",
          note
        });
        return;
      }

      const stale = document.querySelector(SMILE_DETAILS_DIALOG_SELECTOR);
      moreInfo.click();
      const dialog = await waitForElement({
        selector: SMILE_DETAILS_DIALOG_SELECTOR,
        exclude: stale
      });
      if (dialog && !isSuperseded) {
        setDialogNote({
          dialog,
          text: note
        });
      }
    }

    // ── Click-time GUID minting (synthetic rows' "לכל התורים") ─────────────────
    // A diary GUID exists only inside the server session's LAST search, so it cannot be minted ahead
    // of time — a later search kills it (the slots page then errors, verified live). The only way to a
    // working "לכל התורים" for a branch the search omitted is to mint at click time: run NEW searches
    // until one lists the branch (the diary set fluctuates intraday, and a branch may hold a diary
    // under another specialization — the list of three is closed), then navigate immediately.

    function searchBody(spec: string): string {
      return [
        `${SMILE_SPECIALIZATION_FIELD}=${spec}`,
        `${SMILE_CITY_FIELD}=${encodeURIComponent(smileCity())}`,
        `${SMILE_AREA_FIELD}=0`
      ].join("&");
    }

    /** Runaway guard for the page scans (an all-country result set is ~10 pages today). */
    const MAX_MINT_PAGES = 30;

    function pagesOf({ totalDeclared, pageRowCount }: {
      totalDeclared: number;
      pageRowCount: number;
    }): number {
      return pageRowCount ? Math.min(Math.ceil(totalDeclared / pageRowCount), MAX_MINT_PAGES) : 0;
    }

    /** One NEW all-country search for a specialization, scanned page by page for the branch's link. */
    async function scanSearchForBranch({ spec, navCode }: {
      spec: string;
      navCode: string;
    }): Promise<string | null> {
      const first = await fetchSessionJson({
        url: SMILE_SEARCH_PATH,
        body: searchBody(spec)
      });
      let scan = scanEnvelopeForNavCode({
        json: first,
        navCode
      });
      // A row of the newest search — keeps the composed-lightbox template's GUID current.
      if (scan.firstRowHtml) {
        latestTemplateRowHtml = scan.firstRowHtml;
      }

      const totalPages = pagesOf(scan);
      for (let page = 2; !scan.actionLink && page <= totalPages; page++) {
        scan = scanEnvelopeForNavCode({
          json: await fetchSessionJson({ url: `${SMILE_PAGING_PATH}?pageNumber=${page}` }),
          navCode
        });
      }

      return scan.actionLink;
    }

    /** The parent document, or null when this frame is the top one / the parent is cross-origin. */
    function parentDocument(): Document | null {
      try {
        const { parent } = window;
        return parent === window ? null : parent.document;
      } catch {
        return null;
      }
    }

    /**
     * The site's loader lives in the TOP frame (z.showLoader → parent.StandbyScreenShow appends it to
     * the top document's body), so the sweep's caption goes into the parent document when there is one.
     */
    function captionLoader(text: string) {
      const loader =
        parentDocument()?.querySelector(SITE_LOADER_SELECTOR) ?? document.querySelector(SITE_LOADER_SELECTOR);
      if (loader) {
        setLoaderNote({
          loader,
          text
        });
      }
    }

    /** The site's own full-screen loader — cosmetic, so a missing/throwing z is never the caller's problem. */
    function setSiteLoader(isVisible: boolean) {
      try {
        const pageUi = window.z;
        if (isVisible) {
          pageUi?.showLoader?.();
        } else {
          pageUi?.hideLoader?.();
        }
      } catch { /* site chrome only */ }
    }

    /** Sweep the closed specialization list, the user's searched service first. */
    async function mintDiaryLink({ navCode, onStep }: {
      navCode: string;
      onStep: (progress: {
        step: number;
        total: number;
      }) => void;
    }): Promise<string | null> {
      const specs = [activeSearchSpec, ...SMILE_SPECIALIZATION_CODES.filter(code => code !== activeSearchSpec)];
      for (const [index, spec] of specs.entries()) {
        if (isSuperseded || !config.isEnabled) {
          return null;
        }

        onStep({
          step: index + 1,
          total: specs.length
        });
        try {
          const link = await scanSearchForBranch({
            spec,
            navCode
          });
          if (link) {
            return link;
          }
        } catch { /* one specialization failing must not end the sweep */ }
      }

      return null;
    }

    /**
     * After a failed sweep the session's last search is a foreign one and every displayed GUID is dead
     * (GUIDs churn per search). Re-run the user's own search to restore the session, then rewrite the
     * visible rows' slots/details links to the fresh GUIDs, page by page until every real row is healed.
     */
    async function restoreUserSearchSession() {
      const first = await fetchSessionJson({
        url: SMILE_SEARCH_PATH,
        body: searchBody(activeSearchSpec)
      });
      const scan = scanEnvelopeForNavCode({ json: first });
      if (scan.firstRowHtml) {
        latestTemplateRowHtml = scan.firstRowHtml;
      }

      const list = document.querySelector(`#am_diaries[${SMILE_MARKER_ATTR}] ul`);
      if (!list) {
        return;
      }

      const pending = new Set(
        [...list.querySelectorAll(`li.diary:not([${SYNTHETIC_ROW_ATTR}])`)].map(rowNavCode)
      );
      for (const code of refreshRowActionLinks({
        list,
        json: first
      })) {
        pending.delete(code);
      }

      const totalPages = pagesOf(scan);
      for (let page = 2; pending.size > 0 && page <= totalPages; page++) {
        const envelope = await fetchSessionJson({ url: `${SMILE_PAGING_PATH}?pageNumber=${page}` });
        for (const code of refreshRowActionLinks({
          list,
          json: envelope
        })) {
          pending.delete(code);
        }
      }
    }

    let isMintInFlight = false;

    /**
     * A synthetic row's "לכל התורים": mint a fresh GUID and navigate straight to its slots page (the
     * GUID dies with the next search, so navigation is immediate). When no specialization lists the
     * branch, restore the user's search session, heal the visible rows' links, and open the row's own
     * "מידע נוסף" instead — the honest phone/details view.
     */
    async function openBranchDiaries({ code, row }: {
      code: string;
      row: Element | null;
    }) {
      if (isMintInFlight || !smileCity()) {
        return;
      }

      isMintInFlight = true;
      setSiteLoader(true);
      try {
        const link = await mintDiaryLink({
          navCode: code,
          onStep: progress => captionLoader(sweepStepNote(progress))
        }).catch(() => null);
        if (link && !isSuperseded) {
          // Loader stays up while the iframe navigates away, exactly like the site's own button.
          captionLoader(MINT_NAVIGATE_NOTE);
          window.location.assign(link);
          return;
        }

        await restoreUserSearchSession().catch(() => {});
        setSiteLoader(false);
        await openRowDetails({
          row,
          note: NO_DIARY_SWEEP_NOTE
        }).catch(() => {});
      } finally {
        isMintInFlight = false;
      }
    }

    document.addEventListener("click", e => {
      const isModified = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
      if (isSuperseded || !config.isEnabled || e.defaultPrevented || isModified) {
        return;
      }

      const { target } = e;
      if (!(target instanceof Element)) {
        return;
      }

      const mintButton = target.closest(`a[${MINT_CODE_ATTR}]`);
      if (mintButton) {
        // The site's delegated handler binds by class/id, NOT by data-action-link — left alone it reads
        // the stripped attribute as undefined and navigates the iframe to /Zimunet/undefined (observed
        // live). Capture-phase + stopPropagation keeps the click ours alone.
        e.preventDefault();
        e.stopPropagation();
        openBranchDiaries({
          code: mintButton.getAttribute(MINT_CODE_ATTR) ?? "",
          row: mintButton.closest("li.diary")
        }).catch(() => {});
        return;
      }

      const anchor = target.closest(`a[${DETAILS_CODE_ATTR}]`);
      if (!anchor) {
        return;
      }

      const code = anchor.getAttribute(DETAILS_CODE_ATTR) ?? "";
      const fallbackHref = anchor.getAttribute("href") ?? "";
      e.preventDefault();
      openBranchDetails({
        code,
        fallbackHref,
        note: NO_DIARY_ROW_NOTE
      }).catch(() => openDetailsFallback(fallbackHref));
    }, true);

    // ── Restore-document recovery (the "back" hole, docs §6d) ─────────────────
    // "Back" from a slots page is a DOCUMENT load (SmileClinic?isRestoreSearch=True): the server
    // renders the session's last search RAW into the page — no fetch/XHR runs, so the guarantee never
    // touches it, and the rendered rows are whatever Paging page the aggregation last fetched. Recovery
    // re-drives that same search through the site's own form; the fresh XHR then flows through the
    // normal pipeline. The restored form's specialization select is UNRELIABLE (observed 91 above a 92
    // session) — the session's real specialization comes from the results header, matched against the
    // select's own option labels.

    function domReady(): Promise<void> {
      if (document.readyState !== "loading") {
        return Promise.resolve();
      }

      return new Promise(resolve => {
        document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
      });
    }

    function restoredSessionSpec(): string | null {
      const header = document.querySelector("#am_diaries h2")?.textContent ?? "";
      const select = document.querySelector<HTMLSelectElement>(SMILE_SPECIALIZATION_SELECT_SELECTOR);
      if (!header || !select) {
        return null;
      }

      const option = [...select.options].find(({ text }) => text.trim() && header.includes(text.trim()));
      return option?.value ?? null;
    }

    function redriveSearch(spec: string): void {
      const button = document.querySelector<HTMLInputElement>(SMILE_SEARCH_BUTTON_SELECTOR);
      if (!button) {
        return;
      }

      const select = document.querySelector<HTMLSelectElement>(SMILE_SPECIALIZATION_SELECT_SELECTOR);
      if (select && select.value !== spec) {
        select.value = spec;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }

      // Belt: until the site's own handler is bound, the submit button's default action would NATIVE-
      // submit the form (a document POST). The real search flow is always XHR, so preventing the
      // default keeps a too-early click harmless — the retry loop just tries again.
      button.closest("form")?.addEventListener("submit", e => e.preventDefault(), { once: true });
      button.click();
    }

    async function recoverRestoredSearch() {
      await domReady();
      const spec = restoredSessionSpec();
      if (!spec) {
        return;
      }

      for (let attempt = 0; attempt < 20; attempt++) {
        if (isSuperseded || !config.isEnabled) {
          return;
        }

        // Stop once a search has run in this document: ours landing (the marked render), the user's
        // own (activeSearchCity is set at send time), or a prior generation's before a dev re-inject.
        if (activeSearchCity || document.querySelector(`#am_diaries[${SMILE_MARKER_ATTR}]`)) {
          return;
        }

        // Re-drive only once BOTH are true: the city is known (the bridge has read it out of the
        // restored search box — searching before that would re-run the same unfiltered search we are
        // here to replace), and the site's bundle is up (before that the button is not an XHR search).
        if (smileCity() && document.readyState === "complete" && window.z) {
          redriveSearch(spec);
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    if (isSmileRestoreLocation(window.location)) {
      recoverRestoredSearch().catch(() => {});
    }

    // Past-visit clinic-details links (title → ClinicDetailsByVisit GUID), so a synthetic branch can open
    // the site's OWN clinic-details lightbox for a clinic the user has visited. Fetched once per page.
    let pastVisitDetails: Map<string, string> | null = null;
    async function getPastVisitDetails(): Promise<Map<string, string>> {
      if (pastVisitDetails) {
        return pastVisitDetails;
      }

      // No history / not reachable leaves the map empty — synthetic rows fall back to the nearme page.
      const html = await nativeFetch.call(window, "/Zimunet/", {
        headers: {
          "X-Requested-With": "XMLHttpRequest"
        },
        credentials: "same-origin"
      }).then(response => response.text()).catch(() => "");

      const map = new Map<string, string>();
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const anchor of doc.querySelectorAll("a.clinicDetails[data-action-link*=\"ClinicDetailsByVisit\"]")) {
        const guid = anchor.getAttribute("data-action-link")?.split("/").pop();
        const title = anchor.textContent?.trim();
        if (guid && title && !map.has(title)) {
          map.set(title, guid);
        }
      }

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
          ({ coords: { latitude, longitude } }) => {
            cachedPosition = {
              coords: [latitude, longitude],
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
    async function reorderByLiveLocation({ list, isDescending }: {
      list: Element;
      isDescending: boolean;
    }) {
      const position = await currentPosition();
      if (!position || isSuperseded) {
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
        const isFirstKnown = Number.isFinite(first.km);
        const isSecondKnown = Number.isFinite(second.km);
        if (isFirstKnown !== isSecondKnown) {
          return isFirstKnown ? -1 : 1;
        }

        let delta = 0;
        if (isFirstKnown) {
          delta = isDescending ? second.km - first.km : first.km - second.km;
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
      const { isEnabled, city } = config;
      if (isSuperseded || !isEnabled || !city.trim()) {
        return {
          isTransformed: false,
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
          isTransformed: false,
          resultsCount: 0,
          inCityCount: 0,
          json
        };
      }

      const result = applyGuarantee(json, {
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
      if (isSuperseded || !/json/i.test(response.headers.get("content-type") ?? "")) {
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
      if (!outcome.isTransformed) {
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
      const outcome = transformForUrl({
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
      if (!isSuperseded && config.isEnabled && smileCity() && targetUrl.includes(SMILE_SORT_PATH)) {
        targetUrl = targetUrl.replace("sortValue=4", "sortValue=3");
        activeSort = targetUrl.includes("sortValue=3") ? "home" : "soonest";
        isSortDescending = targetUrl.includes("sortDirection=2");
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
      const state = isSuperseded ? undefined : xhrStates.get(this);
      if (state) {
        defineResponseGetters({
          xhr: this,
          state
        });
      }

      let outgoing = body;
      if (state && !isSuperseded && config.isEnabled && typeof outgoing === "string" && state.url.includes(SMILE_SEARCH_PATH)) {
        // The submitted city and specialization are the authoritative ones for this server session.
        const submitted = new URLSearchParams(outgoing);
        const submittedCity = submitted.get(SMILE_CITY_FIELD)?.trim();
        if (submittedCity) {
          activeSearchCity = submittedCity;
        }

        const submittedSpec = submitted.get(SMILE_SPECIALIZATION_FIELD)?.trim();
        if (submittedSpec) {
          activeSearchSpec = submittedSpec;
        }

        // A fresh search resets the server session to its default order (distance from searched city).
        activeSort = "cityDistance";
        isSortDescending = false;

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
