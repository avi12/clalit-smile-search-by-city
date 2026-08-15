/**
 * Which of the appended branches can actually be booked right now, decided BEFORE the user clicks.
 *
 * A synthetic row means "the searched service has no diary here" - it does not mean the branch is
 * unbookable: the same clinic often has a diary under another Smile service, which is exactly what the
 * click-time sweep goes looking for. Only asking the other services can tell the two apart, so this runs
 * that question once per rendered list, cheaply: one search per remaining service, re-sorted by distance
 * from the searched city so the city's own branches sit on the first pages (docs §6c).
 *
 * Every search here is a FOREIGN search - it replaces what the session holds and kills the displayed
 * rows' GUIDs - so the probe restores the user's own search before it marks anything, exactly like a
 * watch tick. Verdicts are cached for a few minutes because a sort re-renders the list (and re-runs the
 * aggregation) without changing which branches have diaries.
 */

import type { SmileSession } from "./smile-session";

/** The diary set moves during the day (docs §6c), so a verdict is a snapshot with a short life. */
const VERDICT_TTL_MS = 5 * 60_000;

export function createAvailabilityProbe({ session, isMintInFlight, onDiaryFound, now = Date.now }: {
  session: SmileSession;
  /** A click-time sweep is already talking to the server; probing now would only fight it. */
  isMintInFlight: () => boolean;
  /** Which service listed a branch, so a later click mints in one search instead of three. */
  onDiaryFound: (found: {
    navCode: string;
    specialization: string;
  }) => void;
  now?: () => number;
}) {
  const verdicts = new Map<string, {
    isBookable: boolean;
    decidedAt: number;
  }>();

  function verdictFor(navCode: string) {
    const verdict = verdicts.get(navCode);
    if (!verdict || now() - verdict.decidedAt > VERDICT_TTL_MS) {
      return null;
    }

    return verdict.isBookable;
  }

  function remember({ navCode, isBookable }: {
    navCode: string;
    isBookable: boolean;
  }) {
    verdicts.set(navCode, {
      isBookable,
      decidedAt: now()
    });
  }

  /**
   * Ask every service the session still believes in, stopping as soon as every branch is accounted for.
   * The service the user searched is skipped: these rows exist precisely because it did not list them.
   */
  async function probe(navCodes: Set<string>) {
    const pending = new Set(navCodes);
    const specializations = session.bookableSpecializations()
      .filter(code => code !== session.state.activeSearchSpecialization);

    for (const specialization of specializations) {
      if (pending.size === 0 || !session.isActive() || isMintInFlight()) {
        break;
      }

      const listed = await session.listedNavCodes({
        specialization,
        navCodes: pending
      }).catch(() => new Set<string>());
      for (const navCode of listed) {
        pending.delete(navCode);
        remember({
          navCode,
          isBookable: true
        });
        onDiaryFound({
          navCode,
          specialization
        });
      }
    }

    for (const navCode of pending) {
      remember({
        navCode,
        isBookable: false
      });
    }

    await session.restoreUserSearch().catch(() => {});
  }

  /**
   * Settle every branch whose verdict is unknown or stale, so the caller can build rows that already
   * carry their answer. Cached verdicts make a re-render (a sort, say) cost nothing.
   */
  async function ensureVerdicts(navCodes: string[]) {
    const unknown = new Set(navCodes.filter(navCode => navCode && verdictFor(navCode) === null));
    if (unknown.size === 0 || isMintInFlight() || !session.isActive()) {
      return;
    }

    await probe(unknown);
  }

  return {
    ensureVerdicts,
    verdictFor
  };
}
