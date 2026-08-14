/**
 * Watching a branch until its diary opens. A branch with no diary in any service cannot be booked - but
 * the diary set moves during the day (docs §6c), so the only thing left is to keep looking, cheaply:
 * one service per tick, riding the city-distance sort so the searched city's own branches land on the
 * first page. Every tick ends by restoring the user's search, so the rows on screen keep live GUIDs.
 *
 * Session-only and tab-scoped: no storage, no background, and every watch dies with the document.
 */

import {
  NO_DIARY_SWEEP_NOTE,
  NOTE_ATTR,
  rowNavCode,
  scanEnvelopeForNavCode,
  SESSION_LOST_NOTE,
  setRowWatchState,
  setWatchControl,
  SMILE_ENVELOPE_STATUS,
  WATCH_ACTIVE_NOTE,
  WATCH_CODE_ATTR,
  WATCH_HIT_NOTE,
  WATCH_START_LABEL,
  WATCH_STOP_LABEL
} from "./smile";
import type { SmileSession } from "./smile-session";
import { SMILE_SORT_PATH, SMILE_SORT_VALUES } from "./targets";

const WATCH_INTERVAL_MS = 15 * 60_000;
const WATCH_MAX_TICKS = 16;

interface Watch {
  timer: ReturnType<typeof setTimeout>;
  ticks: number;
}

export function createBranchWatch({ session, isMintInFlight, onDiaryFound }: {
  session: SmileSession;
  /** A click-time sweep is already talking to the server; a tick would only fight it. */
  isMintInFlight: () => boolean;
  /** Which service listed the branch, so the next click mints in one search instead of three. */
  onDiaryFound: (found: {
    navCode: string;
    specialization: string;
  }) => void;
}) {
  const watches = new Map<string, Watch>();

  function isWatching(navCode: string): boolean {
    return watches.has(navCode);
  }

  function stopWatching(navCode: string) {
    const watch = watches.get(navCode);
    if (watch) {
      clearTimeout(watch.timer);
      watches.delete(navCode);
    }
  }

  function stopAll() {
    for (const watch of watches.values()) {
      clearTimeout(watch.timer);
    }

    watches.clear();
  }

  function watchedRow(navCode: string): Element | null {
    return [...document.querySelectorAll("li.diary")].find(elRow => rowNavCode(elRow) === navCode) ?? null;
  }

  function sayOnRow({ navCode, note, label }: {
    navCode: string;
    note: string;
    label: string;
  }) {
    const elRow = watchedRow(navCode);
    if (elRow) {
      setRowWatchState({
        elRow,
        note,
        label
      });
    }
  }

  /** Is this branch listed under `specialization` right now? Costs one search plus the first sorted page. */
  async function isBranchListed({ specialization, navCode }: {
    specialization: string;
    navCode: string;
  }): Promise<boolean> {
    const first = await session.search(specialization);
    if (session.trackEnvelopeStatus({
      json: first,
      specialization
    }) !== SMILE_ENVELOPE_STATUS.success) {
      return false;
    }

    const sorted = await session.fetchSessionJson({
      url: `${SMILE_SORT_PATH}?sortValue=${SMILE_SORT_VALUES.cityDistance}&sortDirection=1`
    });
    if (scanEnvelopeForNavCode({
      json: sorted,
      navCode
    }).actionLink) {
      return true;
    }

    // The city's own branches sit first, but a dense city can push them past page 1 - check one more.
    const second = await session.fetchSessionJson({ url: session.pagingUrl(2) });
    return scanEnvelopeForNavCode({
      json: second,
      navCode
    }).actionLink !== null;
  }

  async function runTick(navCode: string) {
    const watch = watches.get(navCode);
    if (!watch || !session.isActive() || !session.city()) {
      stopWatching(navCode);
      return;
    }

    const specializations = session.bookableSpecializations();
    if (!isMintInFlight() && specializations.length > 0) {
      const specialization = specializations[watch.ticks % specializations.length];
      const isListed = await isBranchListed({
        specialization,
        navCode
      }).catch(() => false);
      await session.restoreUserSearch().catch(() => {});

      if (session.state.isSessionLost) {
        sayOnRow({
          navCode,
          note: SESSION_LOST_NOTE,
          label: WATCH_START_LABEL
        });
        stopAll();
        return;
      }

      if (isListed) {
        onDiaryFound({
          navCode,
          specialization
        });
        stopWatching(navCode);
        sayOnRow({
          navCode,
          note: WATCH_HIT_NOTE,
          label: WATCH_START_LABEL
        });
        return;
      }
    }

    watch.ticks += 1;

    if (watch.ticks >= WATCH_MAX_TICKS) {
      stopWatching(navCode);
      return;
    }

    watch.timer = setTimeout(() => {
      runTick(navCode).catch(() => {});
    }, WATCH_INTERVAL_MS);
  }

  function startWatching(navCode: string) {
    stopWatching(navCode);
    watches.set(navCode, {
      timer: setTimeout(() => {
        runTick(navCode).catch(() => {});
      }, WATCH_INTERVAL_MS),
      ticks: 0
    });
  }

  /** The watch control's click: arm or cancel, and say which state the row is now in. */
  function toggle(navCode: string) {
    const isNowWatching = !isWatching(navCode);
    if (isNowWatching) {
      startWatching(navCode);
    } else {
      stopWatching(navCode);
    }

    sayOnRow({
      navCode,
      note: isNowWatching ? WATCH_ACTIVE_NOTE : NO_DIARY_SWEEP_NOTE,
      label: isNowWatching ? WATCH_STOP_LABEL : WATCH_START_LABEL
    });
  }

  /** Offer the watch for a branch with no diary - on its row, and inside its details lightbox. */
  function offer({ navCode, elDialog }: {
    navCode: string;
    elDialog?: Element | null;
  }) {
    if (!navCode) {
      return;
    }

    const elRow = watchedRow(navCode);
    const label = isWatching(navCode) ? WATCH_STOP_LABEL : WATCH_START_LABEL;
    const elActions = elRow?.querySelector(".pull-left");
    if (elActions) {
      setWatchControl({
        elHost: elActions,
        code: navCode,
        label,
        elButtonTemplate: elActions.querySelector("a")
      });
    }

    const elNote = elDialog?.querySelector(`[${NOTE_ATTR}]`);
    if (elNote) {
      setWatchControl({
        elHost: elNote,
        code: navCode,
        label
      });
    }
  }

  return {
    toggle,
    offer,
    attribute: WATCH_CODE_ATTR
  };
}
