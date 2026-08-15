/**
 * What a synthetic row's two buttons do. Both exist because Tamuz keys everything on handles that only
 * it can mint (docs §12a): a diary GUID lives inside the session's LAST search, a visit GUID inside the
 * visits list, and a clinic code opens nothing at all.
 *
 * "לכל התורים" opens a page belonging to THAT clinic and nothing else: it mints at click time - new
 * searches until one lists the branch, then straight to its slots page - and falls back to the branch's
 * own appointments page when a past visit there keys one. When neither handle exists no such page exists
 * either (docs §12f), so the click answers in the site's own message box and repaints the row, rather
 * than navigating somewhere that is not this clinic's.
 *
 * "מידע נוסף" composes the site's own lightbox for a branch the server will not describe, from a REAL
 * row of the current search; a stale template just means "re-run the user's search and compose again".
 */

import { SMILE_BRANCHES, type SmileBranch } from "./clinic-directory";
import { smileEnvelopeSchema } from "./schemas";
import {
  captionLoader,
  openInNewTab,
  setSiteLoader,
  showDetailsDialog,
  showSiteMessage
} from "./site-chrome";
import {
  applyBranchToDetailsFragment,
  BRANCH_PAGE_NOTE,
  buildUnavailableMessageHtml,
  detailsLinkFromRowHtml,
  MINT_CHECK_NOTE,
  MINT_NAVIGATE_NOTE,
  rowNavCode,
  scanEnvelopeForNavCode,
  setRowBookable,
  slotsLinkFromRowHtml,
  SMILE_ENVELOPE_STATUS,
  SMILE_SLOTS_PATH,
  SYNTHETIC_ROW_ATTR,
  UNAVAILABLE_BUTTON_TITLE
} from "./smile";
import { TAILORED_BRANCH_HASH } from "./smile-clinic-page";
import type { SmileSession } from "./smile-session";

export function createRowActions({ session, slotsLinkFor, verdictFor }: {
  session: SmileSession;
  /** The branch's slots page as the availability sweep saw it, while that sweep is still the session's. */
  slotsLinkFor: (navCode: string) => string | null;
  /** What the sweep decided about the branch, or null once that answer is too old to act on. */
  verdictFor: (navCode: string) => boolean | null;
}) {
  let isMintInFlight = false;

  function branchByCode(code: string) {
    return SMILE_BRANCHES.find(candidate => candidate.code === code);
  }

  /** The branch's lightbox fragment, composed from a real row of the CURRENT search session. */
  async function composeDetailsFragment(branch: SmileBranch) {
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

  /** "מידע נוסף" for a branch the server will not describe: the site's own lightbox, composed. */
  async function openDetails({ code, fallbackHref, note, onComposed }: {
    code: string;
    fallbackHref: string;
    note: string;
    /** Runs once the fragment is in hand - the caller's cue to drop a loader the dialog would sit under. */
    onComposed?: () => void;
  }) {
    const branch = branchByCode(code);
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
    onComposed?.();

    if (session.state.isSuperseded || !fragment || !showDetailsDialog({
      html: fragment,
      note
    })) {
      openInNewTab(fallbackHref);
    }
  }

  /** One NEW all-country search for a service, scanned page by page for the branch's link. */
  async function scanSearchForBranch({ specialization, navCode }: {
    specialization: string;
    navCode: string;
  }) {
    const first = await session.search(specialization);
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
        json: await session.fetchSessionJson({ url: session.pagingUrl(page) }),
        navCode
      });
    }

    return scan.actionLink;
  }

  /**
   * A diary for this branch in the SERVICE THE USER SEARCHED, minted fresh - the diary set moves during
   * the day, so a branch the search omitted may have one by the time the button is clicked. No other
   * service is asked: its slots page books a different appointment than the row promises.
   */
  async function mintDiaryLink(navCode: string) {
    const specialization = session.state.activeSearchSpecialization;
    if (!session.isActive() || session.isSpecializationEmpty(specialization)) {
      return null;
    }

    return await scanSearchForBranch({
      specialization,
      navCode
    }).catch(() => null);
  }

  /**
   * A slots link off the LIVE list, which restoreUserSearch has just healed - the one page we know for
   * certain still opens. The remembered template row is the fallback: it can be a row of the sweep's own
   * search, and those GUIDs died the moment the user's search was restored (a dead one renders a page
   * with no clinic on it at all, which is what a borrowed page must never become).
   */
  function liveSlotsLink() {
    return [...document.querySelectorAll(`li.diary:not([${SYNTHETIC_ROW_ATTR}]) a[data-action-link]`)]
      .map(elLink => elLink.getAttribute("data-action-link") ?? "")
      .find(link => link.includes(SMILE_SLOTS_PATH)) ?? null;
  }

  /**
   * The sweep just proved there is nothing to open. Repaint the row so it stays said, and answer the
   * click itself in the site's own message box - a click that changes nothing on screen reads as a
   * broken button, which is exactly what it looked like before this.
   */
  function sayUnbookable(code: string) {
    const elRow = [...document.querySelectorAll("li.diary")].find(elCandidate => rowNavCode(elCandidate) === code);
    if (elRow) {
      setRowBookable({
        elRow,
        isBookable: false,
        title: UNAVAILABLE_BUTTON_TITLE
      });
    }

    const branch = branchByCode(code);
    if (branch) {
      showSiteMessage(buildUnavailableMessageHtml(branch));
    }
  }

  /**
   * A synthetic row's "לכל התורים": the clinic's own appointments page, or nothing at all.
   *
   * The sweep that settled this row's colour already asked the searched service about this branch, and
   * its search is still the session's - so what it learned is still true and still openable. That makes
   * both answers immediate: a branch it listed hands over its own slots link (that row is not even
   * handled here - it carries a plain data-action-link), and a branch it did not list can borrow a live
   * row's page right away, because those rows were healed onto the same search. Only an unsettled
   * branch - no verdict, or one old enough to have gone stale - is worth a click-time sweep of its own.
   */
  async function openDiaries(code: string) {
    if (isMintInFlight || !session.city()) {
      return;
    }

    const knownLink = slotsLinkFor(code);
    if (knownLink) {
      window.location.assign(knownLink);
      return;
    }

    const isKnownUnbookable = verdictFor(code) === false;
    const borrowable = isKnownUnbookable ? liveSlotsLink() : null;
    if (borrowable) {
      window.location.assign(`${borrowable}${TAILORED_BRANCH_HASH}${code}`);
      return;
    }

    isMintInFlight = true;
    setSiteLoader(true);
    try {
      captionLoader(MINT_CHECK_NOTE);
      const link = await mintDiaryLink(code);
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

      // No page of the SEARCHED service exists for this branch, and a page of another service is not
      // what the row promised - a past visit's own appointments page carries that visit's profession
      // (docs §12g), so it is not offered either. The row borrows the site's own appointments page:
      // a REAL diary's slots page carries the branch's code in its hash, and smile-clinic-page.ts
      // retitles it and answers its availability calls with the site's own empty month (docs §12i).
      const borrowedPage = liveSlotsLink() ?? slotsLinkFromRowHtml(session.state.latestTemplateRowHtml);
      if (borrowedPage) {
        captionLoader(BRANCH_PAGE_NOTE);
        window.location.assign(`${borrowedPage}${TAILORED_BRANCH_HASH}${code}`);
        return;
      }

      // No real row in this search means no page to borrow - say it in the site's own message box.
      setSiteLoader(false);
      sayUnbookable(code);
    } finally {
      isMintInFlight = false;
    }
  }

  return {
    openDetails,
    openDiaries,
    isMintInFlight: () => isMintInFlight
  };
}
