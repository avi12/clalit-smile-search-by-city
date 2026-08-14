/**
 * What a synthetic row's two buttons do. Both exist because Tamuz keys everything on handles that only
 * it can mint (docs §12a): a diary GUID lives inside the session's LAST search, a visit GUID inside the
 * visits list, and a clinic code opens nothing at all.
 *
 * "לכל התורים" therefore mints at click time - new searches until one lists the branch, then straight to
 * its slots page - and when nothing lists it, falls through to the branch's own appointments page (a
 * past visit keys one) or the service's appointments page. It never ends on a dead end.
 *
 * "מידע נוסף" composes the site's own lightbox for a branch the server will not describe, from a REAL
 * row of the current search; a stale template just means "re-run the user's search and compose again".
 */

import { SMILE_BRANCHES, type SmileBranch } from "./clinic-directory";
import { smileEnvelopeSchema } from "./schemas";
import { captionLoader, openInNewTab, setSiteLoader, showDetailsDialog } from "./site-chrome";
import {
  applyBranchToDetailsFragment,
  detailsLinkFromRowHtml,
  MINT_NAVIGATE_NOTE,
  NO_DIARY_REDIRECT_NOTE,
  scanEnvelopeForNavCode,
  SMILE_ENVELOPE_STATUS,
  sweepStepNote,
  VISIT_APPOINTMENTS_NOTE
} from "./smile";
import type { SmileSession } from "./smile-session";
import { SMILE_APPOINTMENTS_PATH, SMILE_DETAILS_DIALOG_SELECTOR, VISIT_APPOINTMENTS_PATH } from "./targets";

export function createRowActions({ session, visitGuidsByClinicTitle, knownSpecializationByNavCode, offerWatch }: {
  session: SmileSession;
  visitGuidsByClinicTitle: (options?: { isRefreshed?: boolean }) => Promise<Map<string, string>>;
  /** Filled by the watcher: the service that listed a branch, so the next sweep tries it first. */
  knownSpecializationByNavCode: Map<string, string>;
  offerWatch: (offer: {
    navCode: string;
    elDialog?: Element | null;
  }) => void;
}) {
  let isMintInFlight = false;

  function branchByCode(code: string): SmileBranch | undefined {
    return SMILE_BRANCHES.find(candidate => candidate.code === code);
  }

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

  /** "מידע נוסף" for a branch the server will not describe: the site's own lightbox, composed. */
  async function openDetails({ code, fallbackHref, note }: {
    code: string;
    fallbackHref: string;
    note: string;
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
    if (session.state.isSuperseded || !fragment || !showDetailsDialog({
      html: fragment,
      note
    })) {
      openInNewTab(fallbackHref);
      return;
    }

    offerWatch({
      navCode: branch.code,
      elDialog: document.querySelector(SMILE_DETAILS_DIALOG_SELECTOR)
    });
  }

  /** One NEW all-country search for a service, scanned page by page for the branch's link. */
  async function scanSearchForBranch({ specialization, navCode }: {
    specialization: string;
    navCode: string;
  }): Promise<string | null> {
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

  /** Sweep the services worth asking, the one that listed this branch before (or was searched) first. */
  async function mintDiaryLink({ navCode, onStep }: {
    navCode: string;
    onStep: (progress: {
      step: number;
      total: number;
    }) => void;
  }): Promise<string | null> {
    const preferred = [knownSpecializationByNavCode.get(navCode), session.state.activeSearchSpecialization]
      .filter((code): code is string => code !== undefined && !session.isSpecializationEmpty(code));
    const otherCodes = session.bookableSpecializations().filter(code => !preferred.includes(code));
    const specializations = [...new Set([...preferred, ...otherCodes])];
    for (const [i, specialization] of specializations.entries()) {
      if (!session.isActive()) {
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
      } catch { /* one service failing must not end the sweep */ }
    }

    return null;
  }

  /**
   * The branch's own appointments page needs a visit handle, so a branch is only reachable that way once
   * the user has been treated there. The handles rotate with every render of the visits list, so this
   * always reads a fresh one rather than the map cached for the details lightbox.
   */
  async function pastVisitGuidFor(code: string): Promise<string | null> {
    const branch = branchByCode(code);
    if (!branch) {
      return null;
    }

    const detailsByTitle = await visitGuidsByClinicTitle({ isRefreshed: true }).catch(() => null);
    return detailsByTitle?.get(branch.title) ?? null;
  }

  /** A synthetic row's "לכל התורים": mint and navigate, or land on the best appointments page there is. */
  async function openDiaries(code: string) {
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

  return {
    openDetails,
    openDiaries,
    isMintInFlight: () => isMintInFlight
  };
}
