/**
 * City completeness, after the first response is on screen. The filtered fragment the page rendered is
 * only ONE server page of the (rewritten, all-country) result set, so the rest is fetched with the
 * page's own session and appended to that same list - order preserved, deduped by clinic name, because
 * diary GUIDs change per search and cannot identify a row across searches.
 *
 * Then the two things the server cannot do: branches it omits entirely are appended from the committed
 * directory (docs §10a), and a "distance" sort is re-ranked by the user's live position.
 */

import { SMILE_BRANCHES } from "./clinic-directory";
import { createLiveDistanceSort } from "./live-distance";
import type { GuaranteeStatus } from "./messaging";
import { waitForElement } from "./site-chrome";
import {
  applyBranchToRow,
  cityMatches,
  extractCityRows,
  rowClinicName,
  rowNavCode,
  setHeaderCount,
  SMILE_MARKER_ATTR,
  type SmileFilterOutcome,
  SYNTHETIC_ROW_ATTR
} from "./smile";
import type { SmileSession } from "./smile-session";

/** A filtered render of ours, tagged so the aggregator can find that exact list in the live document. */
export type MarkedSmileOutcome = SmileFilterOutcome & { marker: string };

/** Parse a real row's outerHTML into a live-document element to clone (site markup, not ours). */
function parseRowTemplate(html: string) {
  if (!html) {
    return null;
  }

  const elTemplate = document.createElement("template");
  elTemplate.innerHTML = html;
  return elTemplate.content.firstElementChild;
}

/**
 * Append the searched city's Smile branches the search omits. Each row is a CLONE of a real server row
 * (never markup we authored - see applyBranchToRow), repurposed for the branch; "מידע נוסף" opens the
 * site's native clinic-details lightbox when the user has a visit there.
 */
function appendMissingBranches({ elList, city, templateRowHtml, detailsByTitle, bookabilityOf }: {
  elList: Element;
  city: string;
  templateRowHtml: string;
  detailsByTitle: Map<string, string>;
  bookabilityOf: (navCode: string) => boolean | null;
}) {
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
      detailsVisitGuid: detailsByTitle.get(branch.title) ?? null,
      isBookable: bookabilityOf(branch.code)
    });
    elList.appendChild(elRowClone);
    added += 1;
  }

  return added;
}

export function createSmileAggregation({ session, nativeFetch, reportStatus, markAvailability, bookabilityOf }: {
  session: SmileSession;
  nativeFetch: typeof fetch;
  reportStatus: (status: GuaranteeStatus) => void;
  /** Decide which appended branches can be booked at all, and say so on their rows (docs §12h). */
  markAvailability: (elRows: Element[], navCodeOf: (elRow: Element) => string) => Promise<void>;
  /** What the probe already knows about a branch, so the row is BUILT in that state, not repainted. */
  bookabilityOf: (navCode: string) => boolean | null;
}) {
  const liveDistance = createLiveDistanceSort(() => session.isActive());
  let aggregationRun = 0;
  let pastVisitDetails: Map<string, string> | null = null;

  /**
   * Past-visit clinic-details links (title -> ClinicDetailsByVisit GUID), so a synthetic branch can open
   * the site's OWN lightbox - and its own appointments page - for a clinic the user has visited. The
   * handles rotate with every render of the visits list, so callers that navigate ask for a refresh.
   */
  async function visitGuidsByClinicTitle({ isRefreshed = false } = {}) {
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

  function setHeader({ elList, count }: {
    elList: Element;
    count: number;
  }) {
    const elHeader = elList.closest("#am_diaries")?.querySelector("h2");
    if (elHeader) {
      setHeaderCount({
        elHeader,
        count
      });
    }
  }

  /** Collect the rest of the result set into the rendered list, then complete and re-rank it. */
  async function finalize({ marker, pageRowCount, totalDeclared, keptRowCount, templateRowHtml }: MarkedSmileOutcome) {
    const run = ++aggregationRun;
    const city = session.city();
    if (!city || !pageRowCount) {
      return;
    }

    const elList = await waitForElement({ selector: `#am_diaries[${SMILE_MARKER_ATTR}="${marker}"] ul` });
    if (!elList) {
      return;
    }

    function isStale() {
      return !session.isActive() || run !== aggregationRun;
    }

    const totalPages = Math.ceil(totalDeclared / pageRowCount);
    const seenNames = new Set([...elList.querySelectorAll("li.diary")].map(rowClinicName));
    let kept = keptRowCount;
    for (let page = 2; page <= totalPages; page++) {
      if (isStale()) {
        return;
      }

      const envelope = await session.fetchSessionJson({ url: session.pagingUrl(page) }).catch(() => null);
      if (!envelope || isStale()) {
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

      setHeader({
        elList,
        count: kept
      });
      reportStatus({
        city,
        resultsCount: totalDeclared,
        inCityCount: kept
      });
    }

    if (isStale()) {
      return;
    }

    // City completeness beyond Tamuz: branches with no bookable diary still belong in the list.
    const detailsByTitle = await visitGuidsByClinicTitle();
    if (isStale()) {
      return;
    }

    const added = appendMissingBranches({
      elList,
      city,
      templateRowHtml,
      detailsByTitle,
      bookabilityOf
    });
    if (added) {
      kept += added;
      setHeader({
        elList,
        count: kept
      });
      reportStatus({
        city,
        resultsCount: totalDeclared,
        inCityCount: kept
      });
    }

    if (session.state.activeSort === "home") {
      await liveDistance.reorder({
        elList,
        isDescending: session.state.isSortDescending
      });
    }

    if (isStale()) {
      return;
    }

    // Last, because it runs FOREIGN searches: the list is already complete and ranked on screen, and the
    // probe restores the user's search before it marks anything.
    await markAvailability([...elList.querySelectorAll(`li.diary[${SYNTHETIC_ROW_ATTR}]`)], rowNavCode);
  }

  return {
    finalize,
    visitGuidsByClinicTitle
  };
}
