/**
 * Whether an appended branch can be booked FOR THE SERVICE THE USER SEARCHED, decided before they click.
 *
 * The row exists because that service's search did not list the branch - but the diary set moves during
 * the day (docs §6c), so the question is worth asking once more with a fresh search: a diary opened
 * minutes ago is exactly the case the user's own search cannot know about. Nothing else counts. A diary
 * under ANOTHER Smile service is not this row's business: its slots page books a different appointment
 * than the one the user came here for, and offering it reads as a hygienist search answering with a
 * dentist's calendar.
 *
 * The search this runs is a FOREIGN search - it replaces what the session holds and kills the displayed
 * rows' GUIDs - so the probe restores the user's own search before it marks anything. Verdicts are
 * cached for a few minutes because a sort re-renders the list (and re-runs the aggregation) without
 * changing which branches have diaries.
 */

import type { SmileSession } from "./smile-session";

/** The diary set moves during the day (docs §6c), so a verdict is a snapshot with a short life. */
const VERDICT_TTL_MS = 5 * 60_000;

export function createAvailabilityProbe({ session, isMintInFlight, now = Date.now }: {
  session: SmileSession;
  /** A click-time check is already talking to the server; probing now would only fight it. */
  isMintInFlight: () => boolean;
  now?: () => number;
}) {
  const verdicts = new Map<string, {
    isBookable: boolean;
    decidedAt: number;
    /** The row that proved it bookable is the only place its soonest slot exists for us. */
    soonest: string | null;
  }>();

  function liveVerdict(navCode: string) {
    const verdict = verdicts.get(navCode);
    return verdict && now() - verdict.decidedAt <= VERDICT_TTL_MS ? verdict : null;
  }

  function verdictFor(navCode: string) {
    return liveVerdict(navCode)?.isBookable ?? null;
  }

  /** The branch's soonest slot in the searched service, as the row that listed it printed it. */
  function soonestFor(navCode: string) {
    return liveVerdict(navCode)?.soonest ?? null;
  }

  function remember({ navCode, isBookable, soonest = null }: {
    navCode: string;
    isBookable: boolean;
    soonest?: string | null;
  }) {
    verdicts.set(navCode, {
      isBookable,
      soonest,
      decidedAt: now()
    });
  }

  /** Ask the searched service, once, whether it lists these branches now. */
  async function probe(navCodes: Set<string>) {
    const specialization = session.state.activeSearchSpecialization;
    const listed = session.isSpecializationEmpty(specialization)
      ? new Map<string, string>()
      : await session.listedBranches({
        specialization,
        navCodes
      }).catch(() => new Map<string, string>());

    for (const navCode of navCodes) {
      remember({
        navCode,
        isBookable: listed.has(navCode),
        soonest: listed.get(navCode) || null
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
    verdictFor,
    soonestFor
  };
}
