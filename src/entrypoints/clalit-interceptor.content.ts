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

import { DENTAL_CLINIC_COORDS, SMILE_BRANCHES, type SmileBranch } from "../lib/clinic-directory";
import { installDevTakeover } from "../lib/dev-takeover";
import { haversineKm, type LatLng } from "../lib/geo";
import { type GuaranteeStatus, PageMsg } from "../lib/messaging";
import { onPageMessage, sendPageMessage } from "../lib/messaging-page";
import { searchConfigSchema, smileEnvelopeSchema } from "../lib/schemas";
import {
  captionLoader,
  openInNewTab,
  setSiteLoader,
  showDetailsDialog,
  waitForElement
} from "../lib/site-chrome";
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
  NO_DIARY_REDIRECT_NOTE,
  NO_DIARY_ROW_NOTE,
  rowClinicName,
  rowNavCode,
  scanEnvelopeForNavCode,
  setHeaderCount,
  setRowDistanceLabel,
  SMILE_ENVELOPE_STATUS,
  SMILE_MARKER_ATTR,
  type SmileFilterOutcome,
  sweepStepNote,
  SYNTHETIC_ROW_ATTR,
  VISIT_APPOINTMENTS_NOTE,
  WATCH_CODE_ATTR
} from "../lib/smile";
import { createSmileSession } from "../lib/smile-session";
import { createBranchWatch } from "../lib/smile-watch";
import {
  CONTENT_MATCHES,
  GUARANTEE_MODE,
  isInterestingUrl,
  isSmileRestoreLocation,
  isSmileResultsUrl,
  matchEndpointRule,
  SMILE_APPOINTMENTS_PATH,
  SMILE_AREA_FIELD,
  SMILE_CITY_FIELD,
  SMILE_DETAILS_DIALOG_SELECTOR,
  SMILE_PAGING_PATH,
  SMILE_SEARCH_BUTTON_SELECTOR,
  SMILE_SEARCH_PATH,
  SMILE_SORT_PATH,
  SMILE_SORT_VALUES,
  SMILE_SPECIALIZATION_FIELD,
  SMILE_SPECIALIZATION_SELECT_SELECTOR,
  VISIT_APPOINTMENTS_PATH
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
    // A branch whose diary opened while it was being watched: remember the service that listed it, so
    // the next click sweeps that one FIRST and reaches the slots page in one search instead of three.
    const knownSpecializationByNavCode = new Map<string, string>();
    const branchWatch = createBranchWatch({
      session,
      isMintInFlight: () => isMintInFlight,
      onDiaryFound({ navCode, specialization }) {
        knownSpecializationByNavCode.set(navCode, specialization);
      }
    });
    if (import.meta.env.DEV) {
      installDevTakeover({
        script: "interceptor",
        onSuperseded() {
          session.state.isSuperseded = true;
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
    let aggregationRun = 0;

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

    function transformForUrl({ json, url, method }: UrlTransformInput): UrlTransformResult {
      return isSmileResultsUrl(url) ? transformSmile(json) : transformJson({
        json,
        url,
        method
      });
    }

    /** The site renders our filtered fragment asynchronously; wait for OUR marker to hit the DOM. */
    function waitForMarkedList(marker: string): Promise<Element | null> {
      return waitForElement({ selector: `#am_diaries[${SMILE_MARKER_ATTR}="${marker}"] ul` });
    }

    /**
     * City completeness: the first response is one server page of the (rewritten, all-country) result
     * set - fetch the remaining pages with the PAGE's own session and append the city's rows to the
     * live list, order preserved, deduped by clinic name (diary GUIDs change per search). Then, if the
     * distance sort is active, re-rank the finished list by the user's live location.
     */
    async function finalizeSmileResults(
      { marker, pageRowCount, totalDeclared, keptRowCount, templateRowHtml }: MarkedSmileOutcome
    ) {
      const run = ++aggregationRun;
      const city = session.city();
      if (!city || !pageRowCount) {
        return;
      }

      const elList = await waitForMarkedList(marker);
      if (!elList) {
        return;
      }

      const totalPages = Math.ceil(totalDeclared / pageRowCount);
      const seenNames = new Set([...elList.querySelectorAll("li.diary")].map(rowClinicName));
      let kept = keptRowCount;
      for (let page = 2; page <= totalPages; page++) {
        if (session.state.isSuperseded || run !== aggregationRun || !session.state.isEnabled) {
          return;
        }

        const envelope = await session.fetchSessionJson({ url: `${SMILE_PAGING_PATH}?pageNumber=${page}` }).catch(() => null);
        if (!envelope || session.state.isSuperseded || run !== aggregationRun) {
          return;
        }

        for (const { name, html } of extractCityRows({
          json: envelope,
          searchedCity: city
        })) {
          if (!seenNames.has(name)) {
            seenNames.add(name);
            elList.insertAdjacentHTML("beforeend", html);
            kept += 1;
          }
        }

        const elHeader = elList.closest("#am_diaries")?.querySelector("h2");
        if (elHeader) {
          setHeaderCount({
            elHeader,
            count: kept
          });
        }

        reportStatus({
          city,
          resultsCount: totalDeclared,
          inCityCount: kept
        });
      }

      if (session.state.isSuperseded || run !== aggregationRun) {
        return;
      }

      // City completeness beyond Tamuz: branches with no bookable diary still belong in the list.
      const detailsByTitle = await getPastVisitDetails();
      if (session.state.isSuperseded || run !== aggregationRun) {
        return;
      }

      const added = appendMissingBranches({
        elList,
        city,
        templateRowHtml,
        detailsByTitle
      });
      if (added) {
        kept += added;
        const elHeader = elList.closest("#am_diaries")?.querySelector("h2");
        if (elHeader) {
          setHeaderCount({
            elHeader,
            count: kept
          });
        }

        reportStatus({
          city,
          resultsCount: totalDeclared,
          inCityCount: kept
        });
      }

      if (session.state.activeSort === "home") {
        await reorderByLiveLocation({
          elList,
          isDescending: session.state.isSortDescending
        });
      }
    }

    /** Parse a real row's outerHTML into a live-document element to clone (site markup, not ours). */
    function parseRowTemplate(html: string): Element | null {
      if (!html) {
        return null;
      }

      const elTemplate = document.createElement("template");
      elTemplate.innerHTML = html;
      return elTemplate.content.firstElementChild;
    }

    interface AppendBranchesInput {
      elList: Element;
      city: string;
      templateRowHtml: string;
      detailsByTitle: Map<string, string>;
    }

    /**
     * Append the searched city's Smile branches the search omits. Each row is a CLONE of a real server
     * row (never markup we authored - see applyBranchToRow), repurposed for the branch; "מידע נוסף"
     * opens the site's native clinic-details lightbox when the user has a visit there.
     */
    function appendMissingBranches({ elList, city, templateRowHtml, detailsByTitle }: AppendBranchesInput): number {
      const seenCodes = new Set([...elList.querySelectorAll("li.diary")].map(rowNavCode));
      const elTemplate =
        elList.querySelector(`li.diary:not([${SYNTHETIC_ROW_ATTR}])`) ?? parseRowTemplate(templateRowHtml);
      if (!elTemplate) {
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

        const elRowClone = elTemplate.cloneNode(true);
        if (!(elRowClone instanceof Element)) {
          continue;
        }

        applyBranchToRow({
          elRow: elRowClone,
          branch,
          detailsVisitGuid: detailsByTitle.get(branch.title) ?? null
        });
        elList.appendChild(elRowClone);
        added += 1;
      }

      return added;
    }

    // ── Composed clinic-details lightbox (no-GUID branches) ────────────────────
    /**
     * "מידע נוסף" for a branch with no GUID of any kind: fetch a REAL current-search row's details
     * fragment (ClinicDetailsByDiary - the only endpoints that serve the lightbox are GUID- or
     * session-bound, see docs/reverse-engineering.md §10b), recompose it for this branch from the
     * committed directory, and open it in the site's own lightbox. Any failure falls back to the
     * anchor's nearme href in a new tab.
     */
    /** The branch's lightbox fragment, composed from a real row of the CURRENT search session. */
    async function composeDetailsFragment(branch: SmileBranch): Promise<string | null> {
      const templateLink = detailsLinkFromRowHtml(session.state.latestTemplateRowHtml);
      if (!templateLink) {
        return null;
      }

      const envelope = await session.fetchSessionJson({ url: templateLink }).catch(() => null);
      const parsed = smileEnvelopeSchema.safeParse(envelope);
      return parsed.success ? applyBranchToDetailsFragment({
        template: parsed.data.data,
        branch
      }) : null;
    }

    async function openBranchDetails({ code, fallbackHref, note }: {
      code: string;
      fallbackHref: string;
      note: string;
    }) {
      const branch = SMILE_BRANCHES.find(candidate => candidate.code === code);
      if (!branch) {
        openInNewTab(fallbackHref);
        return;
      }

      // Every search re-mints the session's GUIDs - ours, the watcher's, or the user's own - so a dead
      // template link means "stale", not "impossible": re-run the user's search once and compose again,
      // otherwise the row would open the nearme page in a new tab instead of the lightbox.
      const fragment = await composeDetailsFragment(branch) ?? await (async () => {
        await session.restoreUserSearch().catch(() => {});
        return composeDetailsFragment(branch);
      })();
      if (session.state.isSuperseded || !fragment || !showDetailsDialog({
        html: fragment,
        note
      })) {
        openInNewTab(fallbackHref);
        return;
      }

      branchWatch.offer({
        navCode: branch.code,
        elDialog: document.querySelector(SMILE_DETAILS_DIALOG_SELECTOR)
      });
    }

    // ── Click-time GUID minting (synthetic rows' "לכל התורים") ─────────────────
    // A diary GUID exists only inside the server session's LAST search, so it cannot be minted ahead
    // of time - a later search kills it (the slots page then errors, verified live). The only way to a
    // working "לכל התורים" for a branch the search omitted is to mint at click time: run NEW searches
    // until one lists the branch (the diary set fluctuates intraday, and a branch may hold a diary
    // under another specialization - the list of three is closed), then navigate immediately.

    /** One NEW all-country search for a specialization, scanned page by page for the branch's link. */
    async function scanSearchForBranch({ specialization, navCode }: {
      specialization: string;
      navCode: string;
    }): Promise<string | null> {
      const first = await session.fetchSessionJson({
        url: SMILE_SEARCH_PATH,
        body: session.searchBody(specialization)
      });
      if (session.trackEnvelopeStatus({
        json: first,
        specialization
      }) !== SMILE_ENVELOPE_STATUS.success) {
        return null;
      }

      let scan = scanEnvelopeForNavCode({
        json: first,
        navCode
      });
      // A row of the newest search - keeps the composed-lightbox template's GUID current.
      if (scan.firstRowHtml) {
        session.state.latestTemplateRowHtml = scan.firstRowHtml;
      }

      const totalPages = session.pagesOf(scan);
      for (let page = 2; !scan.actionLink && page <= totalPages; page++) {
        scan = scanEnvelopeForNavCode({
          json: await session.fetchSessionJson({ url: `${SMILE_PAGING_PATH}?pageNumber=${page}` }),
          navCode
        });
      }

      return scan.actionLink;
    }

    /** Sweep the closed specialization list, the user's searched service first. */
    async function mintDiaryLink({ navCode, onStep }: {
      navCode: string;
      onStep: (progress: {
        step: number;
        total: number;
      }) => void;
    }): Promise<string | null> {
      const preferred = [knownSpecializationByNavCode.get(navCode), session.state.activeSearchSpecialization].filter(
        (code): code is string => code !== undefined && !session.isSpecializationEmpty(code)
      );
      const otherCodes = session.bookableSpecializations().filter(code => !preferred.includes(code));
      const specializations = [...new Set([...preferred, ...otherCodes])];
      for (const [i, specialization] of specializations.entries()) {
        if (session.state.isSuperseded || !session.state.isEnabled || session.state.isSessionLost) {
          return null;
        }

        onStep({
          step: i + 1,
          total: specializations.length
        });
        try {
          const link = await scanSearchForBranch({
            specialization,
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
     * The branch's own appointments page needs a visit handle, so a branch is only reachable this way
     * once the user has been treated there. The handles rotate with every render of the visits list, so
     * this always reads a fresh one rather than the map cached for the details lightbox.
     */
    async function pastVisitGuidFor(code: string): Promise<string | null> {
      const branch = SMILE_BRANCHES.find(candidate => candidate.code === code);
      if (!branch) {
        return null;
      }

      const detailsByTitle = await getPastVisitDetails({ isRefreshed: true }).catch(() => null);
      return detailsByTitle?.get(branch.title) ?? null;
    }

    let isMintInFlight = false;

    /**
     * A synthetic row's "לכל התורים": mint a fresh GUID and navigate straight to its slots page (the
     * GUID dies with the next search, so navigation is immediate). When no specialization lists the
     * branch, restore the user's search session, heal the visible rows' links, and open the row's own
     * "מידע נוסף" instead - the honest phone/details view.
     */
    async function openBranchDiaries(code: string) {
      if (isMintInFlight || !session.city()) {
        return;
      }

      isMintInFlight = true;
      setSiteLoader(true);
      try {
        const link = await mintDiaryLink({
          navCode: code,
          onStep: progress => captionLoader(sweepStepNote(progress))
        }).catch(() => null);
        if (link && !session.state.isSuperseded) {
          // Loader stays up while the iframe navigates away, exactly like the site's own button.
          captionLoader(MINT_NAVIGATE_NOTE);
          window.location.assign(link);
          return;
        }

        await session.restoreUserSearch().catch(() => {});

        if (session.state.isSuperseded) {
          return;
        }

        // The branch's own appointments page when a past visit keys one, and the service's appointments
        // page when nothing does - the button always lands in the booking flow, never on a dead end.
        const visitGuid = await pastVisitGuidFor(code);
        captionLoader(visitGuid ? VISIT_APPOINTMENTS_NOTE : NO_DIARY_REDIRECT_NOTE);
        window.location.assign(visitGuid ? `${VISIT_APPOINTMENTS_PATH}${visitGuid}` : SMILE_APPOINTMENTS_PATH);
      } finally {
        isMintInFlight = false;
      }
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

      const elWatchControl = target.closest(`[${WATCH_CODE_ATTR}]`);
      if (elWatchControl) {
        e.preventDefault();
        e.stopPropagation();
        branchWatch.toggle(elWatchControl.getAttribute(WATCH_CODE_ATTR) ?? "");
        return;
      }

      const elMintButton = target.closest(`a[${MINT_CODE_ATTR}]`);
      if (elMintButton) {
        // The site's delegated handler binds by class/id, NOT by data-action-link - left alone it reads
        // the stripped attribute as undefined and navigates the iframe to /Zimunet/undefined (observed
        // live). Capture-phase + stopPropagation keeps the click ours alone.
        e.preventDefault();
        e.stopPropagation();
        openBranchDiaries(elMintButton.getAttribute(MINT_CODE_ATTR) ?? "").catch(() => {});
        return;
      }

      const elAnchor = target.closest(`a[${DETAILS_CODE_ATTR}]`);
      if (!elAnchor) {
        return;
      }

      const code = elAnchor.getAttribute(DETAILS_CODE_ATTR) ?? "";
      const fallbackHref = elAnchor.getAttribute("href") ?? "";
      e.preventDefault();
      openBranchDetails({
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

    function domReady(): Promise<void> {
      if (document.readyState !== "loading") {
        return Promise.resolve();
      }

      return new Promise(resolve => {
        document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
      });
    }

    function restoredSessionSpecialization(): string | null {
      const headerText = document.querySelector("#am_diaries h2")?.textContent ?? "";
      const elSelect = document.querySelector<HTMLSelectElement>(SMILE_SPECIALIZATION_SELECT_SELECTOR);
      if (!headerText || !elSelect) {
        return null;
      }

      const elOption = [...elSelect.options].find(({ text }) => text.trim() && headerText.includes(text.trim()));
      return elOption?.value ?? null;
    }

    function redriveSearch(specialization: string): void {
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

    async function recoverRestoredSearch() {
      await domReady();
      const specialization = restoredSessionSpecialization();
      if (!specialization) {
        return;
      }

      for (let attempt = 0; attempt < 20; attempt++) {
        if (session.state.isSuperseded || !session.state.isEnabled) {
          return;
        }

        // Stop once a search has run in this document: ours landing (the marked render), the user's
        // own (session.state.activeSearchCity is set at send time), or a prior generation's before a dev re-inject.
        if (session.state.activeSearchCity || document.querySelector(`#am_diaries[${SMILE_MARKER_ATTR}]`)) {
          return;
        }

        // Re-drive only once BOTH are true: the city is known (the bridge has read it out of the
        // restored search box - searching before that would re-run the same unfiltered search we are
        // here to replace), and the site's bundle is up (before that the button is not an XHR search).
        if (session.city() && document.readyState === "complete" && window.z) {
          redriveSearch(specialization);
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
    async function getPastVisitDetails({ isRefreshed = false } = {}): Promise<Map<string, string>> {
      if (pastVisitDetails && !isRefreshed) {
        return pastVisitDetails;
      }

      // No history / not reachable leaves the map empty - synthetic rows fall back to the nearme page.
      const html = await nativeFetch.call(window, "/Zimunet/", {
        headers: {
          "X-Requested-With": "XMLHttpRequest"
        },
        credentials: "same-origin"
      }).then(response => response.text()).catch(() => "");

      const map = new Map<string, string>();
      const parsedDocument = new DOMParser().parseFromString(html, "text/html");
      for (const elAnchor of parsedDocument.querySelectorAll("a.clinicDetails[data-action-link*=\"ClinicDetailsByVisit\"]")) {
        const guid = elAnchor.getAttribute("data-action-link")?.split("/").pop();
        const title = elAnchor.textContent?.trim();
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
     * (clinic coordinates come from the committed nearme dataset - no runtime network). Rows without
     * known coordinates keep their server order at the end; a denied position leaves the list as-is.
     */
    async function reorderByLiveLocation({ elList, isDescending }: {
      elList: Element;
      isDescending: boolean;
    }) {
      const position = await currentPosition();
      if (!position || session.state.isSuperseded) {
        return;
      }

      const ranked = [...elList.querySelectorAll("li.diary")].map((elRow, i) => {
        const coords = DENTAL_CLINIC_COORDS[rowNavCode(elRow)];
        return {
          elRow,
          iRow: i,
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

        return delta || first.iRow - second.iRow;
      });
      for (const { elRow, km } of ranked) {
        elList.appendChild(elRow);

        if (Number.isFinite(km)) {
          setRowDistanceLabel({
            elRow,
            km
          });
        }
      }
    }

    // ── Generic JSON transform (non-Smile endpoints) ───────────────────────────
    function transformJson({ json, url, method }: UrlTransformInput): TransformResult {
      const city = session.state.configCity;
      if (!session.isActive() || !city.trim()) {
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
            finalizeSmileResults(computed.smile).catch(() => {});
          }
        });
      }

      return nativeSend.call(this, outgoing);
    };
  }
});
