/**
 * City completeness, after the first response is on screen. The filtered fragment the page rendered is
 * only ONE server page of the (rewritten, all-country) result set, so the rest is fetched with the
 * page's own session and appended to that same list - order preserved, deduped by clinic name, because
 * diary GUIDs change per search and cannot identify a row across searches.
 *
 * Then the two things the server cannot do: branches it omits entirely are appended from the committed
 * directory (docs §10a), and a "distance" sort is re-ranked by the user's live position.
 */

import { SMILE_BRANCHES, type SmileBranch } from "./clinic-directory";
import { createLiveDistanceSort } from "./live-distance";
import { holdSiteLoader, waitForElement } from "./site-chrome";
import {
  applyBranchToRow,
  CHECKING_BRANCHES_NOTE,
  cityMatches,
  completingListNote,
  extractCityRows,
  rowClinicName,
  rowNavCode,
  setHeaderCount,
  SMILE_MARKER_ATTR,
  type SmileFilterOutcome,
  SYNTHETIC_ROW_ATTR
} from "./smile";
import type { SmileSession } from "./smile-session";
import type { GuaranteeStatus } from "@/lib/messaging";

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
/** The city's branches this render is missing - decided BEFORE anything is inserted, so their
 * bookability can be settled while the list still shows only what the server sent. */
function missingBranches({ elList, city }: {
  elList: Element;
  city: string;
}) {
  const seenCodes = new Set([...elList.querySelectorAll("li.diary")].map(rowNavCode));
  return SMILE_BRANCHES.filter(branch => !seenCodes.has(branch.code) && cityMatches({
    rowCity: branch.city,
    searchedCity: city
  }));
}

/**
 * The order the appended block gets. The server's rows keep the order the user's sort gave them, but
 * these have no key that sort can read - a branch with no diary has no soonest appointment - so they
 * used to land in the directory's own order, which is by clinic code and means nothing to anyone. Under
 * "earliest appointment" that put branches nothing can book above branches that can.
 *
 * So: what can be booked first, and within each group the one key these rows do have - how far away
 * they are, nearest first. An unsettled verdict keeps the site's own button, so it is grouped with the
 * bookable ones, exactly as it looks; branches with no known position keep directory order at the end.
 */
function byBookableThenDistance({ distances, bookabilityOf }: {
  distances: Map<string, number>;
  bookabilityOf: (navCode: string) => boolean | null;
}) {
  function rankOf(branch: SmileBranch) {
    return bookabilityOf(branch.code) === false ? 1 : 0;
  }

  function distanceOf(branch: SmileBranch) {
    return distances.get(branch.code) ?? Number.POSITIVE_INFINITY;
  }

  return (first: SmileBranch, second: SmileBranch) =>
    rankOf(first) - rankOf(second) || distanceOf(first) - distanceOf(second);
}

function appendMissingBranches({
  elList,
  branches,
  templateRowHtml,
  detailsByTitle,
  bookabilityOf,
  soonestOf,
  slotsLinkOf,
  distances
}: {
  elList: Element;
  branches: SmileBranch[];
  templateRowHtml: string;
  detailsByTitle: Map<string, string>;
  bookabilityOf: (navCode: string) => boolean | null;
  soonestOf: (navCode: string) => string | null;
  slotsLinkOf: (navCode: string) => string | null;
  distances: Map<string, number>;
}) {
  const elTemplate =
    elList.querySelector(`li.diary:not([${SYNTHETIC_ROW_ATTR}])`) ?? parseRowTemplate(templateRowHtml);
  if (!elTemplate) {
    return 0;
  }

  let added = 0;
  const ordered = [...branches].sort(
    byBookableThenDistance({
      distances,
      bookabilityOf
    })
  );
  for (const branch of ordered) {
    const elRowClone = elTemplate.cloneNode(true);
    if (!(elRowClone instanceof Element)) {
      continue;
    }

    applyBranchToRow({
      elRow: elRowClone,
      branch,
      detailsVisitGuid: detailsByTitle.get(branch.title) ?? null,
      isBookable: bookabilityOf(branch.code),
      soonestSlotDate: soonestOf(branch.code),
      slotsLink: slotsLinkOf(branch.code),
      distanceKm: distances.get(branch.code) ?? null
    });
    elList.appendChild(elRowClone);
    added += 1;
  }

  return added;
}

export function createSmileAggregation({
  session,
  nativeFetch,
  reportStatus,
  ensureVerdicts,
  bookabilityOf,
  soonestFor,
  slotsLinkFor
}: {
  session: SmileSession;
  nativeFetch: typeof fetch;
  reportStatus: (status: GuaranteeStatus) => void;
  /** Settle whether these branches can be booked at all, BEFORE their rows exist (docs §12h). */
  ensureVerdicts: (navCodes: string[]) => Promise<void>;
  /** What the probe knows about a branch, so the row is BUILT in that state and never repainted. */
  bookabilityOf: (navCode: string) => boolean | null;
  /** The soonest slot the probe saw for a branch, in the service the user searched. */
  soonestFor: (navCode: string) => string | null;
  /** And the page that books it, so the row's button is a link and the click waits for nothing. */
  slotsLinkFor: (navCode: string) => string | null;
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
    const response = await nativeFetch.call(window, "/Zimunet/", {
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      credentials: "same-origin"
    }).catch(() => null);
    const html = response ? await response.text().catch(() => "") : "";

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

  /**
   * Collect the rest of the result set into the rendered list, then complete and re-rank it - under the
   * site's own loader, because the site's loader comes down when ITS request is answered and everything
   * that makes the answer whole happens after that. A list that keeps growing with nothing to explain it
   * reads as a page still loading; this says so, and says which part is still running.
   */
  async function finalize({ marker, pageRowCount, totalDeclared, keptRowCount, templateRowHtml }: MarkedSmileOutcome) {
    const run = ++aggregationRun;
    const city = session.city();
    if (!city || !pageRowCount) {
      return;
    }

    function isStale() {
      return !session.isActive() || run !== aggregationRun;
    }

    // A newer render supersedes this one, so the wait ends with it rather than outliving it.
    const elList = await waitForElement({
      selector: `#am_diaries[${SMILE_MARKER_ATTR}="${marker}"] ul`,
      isAbandoned: isStale
    });
    if (!elList || isStale()) {
      return;
    }

    const totalPages = Math.ceil(totalDeclared / pageRowCount);
    const loader = holdSiteLoader(
      completingListNote({
        step: 1,
        total: totalPages
      })
    );
    try {
      await complete({
        elList,
        city,
        totalPages,
        keptRowCount,
        totalDeclared,
        templateRowHtml,
        isStale,
        loader
      });
    } finally {
      loader.release();
    }
  }

  /** Everything the first rendered page is missing, in the order the list needs it. */
  async function complete({ elList, city, totalPages, keptRowCount, totalDeclared, templateRowHtml, isStale, loader }: {
    elList: Element;
    city: string;
    totalPages: number;
    keptRowCount: number;
    totalDeclared: number;
    templateRowHtml: string;
    isStale: () => boolean;
    loader: { note: (text: string) => void };
  }) {
    const seenNames = new Set([...elList.querySelectorAll("li.diary")].map(rowClinicName));
    let kept = keptRowCount;
    for (let page = 2; page <= totalPages; page++) {
      if (isStale()) {
        return;
      }

      // A step IS a page here; the caption says "step" because the reader is counting clinics, not
      // Tamuz's pagination, and most of these pages carry none of theirs.
      loader.note(
        completingListNote({
          step: page,
          total: totalPages
        })
      );

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

    // Their bookability is settled BEFORE they are inserted - a row that appears in one colour and
    // changes to another a moment later is a row that lied once (docs §12h).
    loader.note(CHECKING_BRANCHES_NOTE);
    const branches = missingBranches({
      elList,
      city
    });
    await ensureVerdicts(branches.map(branch => branch.code));

    if (isStale()) {
      return;
    }

    // A server row always prints a distance; an appended one prints the live-location distance so the
    // list reads as one thing. Best effort - no position, no line, exactly as before.
    const distances = await liveDistance.distancesByNavCode(branches.map(branch => branch.code));
    if (isStale()) {
      return;
    }

    const added = appendMissingBranches({
      elList,
      branches,
      templateRowHtml,
      detailsByTitle,
      bookabilityOf,
      soonestOf: soonestFor,
      slotsLinkOf: slotsLinkFor,
      distances
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

    // One origin for the whole list: the position is already in hand from the line above, so the rows the
    // server rendered get the same "from where you are" number the appended ones were built with.
    await liveDistance.relabelRows(elList);

    if (isStale()) {
      return;
    }

    if (session.state.activeSort === "home") {
      await liveDistance.reorder({
        elList,
        isDescending: session.state.isSortDescending
      });
    }
  }

  return {
    finalize,
    visitGuidsByClinicTitle
  };
}
