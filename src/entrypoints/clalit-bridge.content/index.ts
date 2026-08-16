/**
 * ISOLATED bridge. It reads the city out of the site's search box and pushes it (plus a session on/off)
 * to the MAIN interceptor over the window channel. Runs in ALL frames - the Tamuz booking UI lives in
 * an iframe - and each frame feeds its own MAIN interceptor. The status badge renders only in the top
 * frame: the frame holding the search box broadcasts its {city, status} on the tab's frame channel and
 * receives the toggle back the same way.
 * No storage - the searched city is the only "setting". Its privileged errands are both the
 * background's: the user's position, which the MAIN world asks for, and this tab's id, which is what
 * scopes the frame channel to one tab.
 */

import { openFrameChannel } from "./messaging-frames";
import { frameStateSchema, guaranteeStatusSchema } from "./schemas";
import { mountStatusBadge } from "./status-badge.svelte";
import {
  FrameMsg,
  type GuaranteeStatus,
  PageMsg,
  RuntimeMsg,
  type SearchConfig
} from "@/lib/messaging";
import { onPageMessage, sendPageMessage } from "@/lib/messaging-page";
import { sendRuntimeMessage } from "@/lib/messaging-runtime";
import { CONTENT_MATCHES, SEARCH_CITY_HINT, SEARCH_CITY_SELECTORS } from "@/lib/targets";
import { defineContentScript } from "#imports";

export default defineContentScript({
  matches: [...CONTENT_MATCHES],
  allFrames: true,
  async main(ctx) {
    const isTopFrame = window.self === window.top;
    let isEnabled = true; // session-only; resets to on each load (a guarantee tool defaults to guarding)
    let city = "";
    let lastStatus: GuaranteeStatus | null = null;
    let frames: ReturnType<typeof openFrameChannel> | null = null;
    // Top frame only: the latest state broadcast by the frame where the real search box lives.
    let frameCity = "";
    let frameStatus: GuaranteeStatus | null = null;

    /**
     * What this frame's badge would show, handed to the frame that actually renders one. The city here
     * is display text; the city the guarantee acts on comes from this frame's own search box and from
     * the submitted request body.
     *
     * Only the frame holding the search box speaks. The search box is two frames down - the booking
     * iframe loads a page that frames the scheduler itself - and the page keeps a session-refresh frame
     * of its own beside them, so THREE frames here match and run a bridge while only the innermost has
     * a city. The top frame keeps ONE broadcast state, so letting them all speak means whichever spoke
     * last decides what the badge says: the searched city, or an empty one reading "type a city".
     */
    function broadcastState() {
      const isSearchBoxFrame = Boolean(findSearchInput());
      if (isTopFrame || !isSearchBoxFrame) {
        return;
      }

      frames?.post(FrameMsg.State, {
        city,
        status: lastStatus
      });
    }

    const badge = isTopFrame
      ? mountStatusBadge(ctx, () => {
        setEnabled(!isEnabled);
        broadcastToggle();
      })
      : null;

    function setEnabled(isNextEnabled: boolean) {
      isEnabled = isNextEnabled;
      pushConfig();
      refreshBadge();
    }

    /** Top → every other frame of the tab, in one message and with no frame tree to walk. */
    function broadcastToggle() {
      frames?.post(FrameMsg.Toggle, isEnabled);
    }

    function refreshBadge() {
      badge?.update({
        isEnabled,
        city: city || frameCity,
        status: frameStatus ?? lastStatus
      });
    }

    function pushConfig() {
      const config: SearchConfig = {
        isEnabled,
        city
      };
      sendPageMessage(PageMsg.Config, config).catch(() => { });
    }

    onPageMessage(PageMsg.Status, ({ data }) => {
      const parsed = guaranteeStatusSchema.safeParse(data);
      if (!parsed.success) {
        return;
      }

      lastStatus = parsed.data;
      refreshBadge();
      broadcastState();
    });

    /**
     * The MAIN world cannot read a position (no browser.*) and must not depend on what the SITE was
     * granted, so it asks here and the background reads it in the extension's own offscreen document.
     */
    onPageMessage(PageMsg.Position, () =>
      sendRuntimeMessage(RuntimeMsg.Position, undefined).catch(() => null));

    // ── The tab's frame channel ────────────────────────────────────────────────

    /**
     * Opened once the background says which tab this is, because the channel's name has to carry the
     * tab - see messaging-frames.ts. Without an answer there is no relay at all, which is the same
     * thing that happens today whenever the extension context is gone: each frame still guarantees its
     * own search, and only the badge's caption goes without.
     */
    async function openFrames() {
      const tabId = await sendRuntimeMessage(RuntimeMsg.TabId, undefined).catch(() => null);
      if (tabId === null) {
        return;
      }

      // That await outlives a dev generation being stood down, and a channel opened after this script's
      // own `onInvalidated` already ran would answer forever for a script that is gone.
      if (!ctx.isValid) {
        return;
      }

      const channel = openFrameChannel(tabId);
      frames = channel;
      ctx.onInvalidated(() => channel.close());

      channel.on(FrameMsg.State, data => {
        const parsed = frameStateSchema.safeParse(data);
        if (!isTopFrame || !parsed.success) {
          return;
        }

        frameCity = parsed.data.city;
        frameStatus = parsed.data.status;
        refreshBadge();
      });

      // A frame that just joined asks for the toggle; the answer goes to the whole tab, because a
      // broadcast has no one to answer.
      channel.on(FrameMsg.Hello, () => {
        if (isTopFrame) {
          broadcastToggle();
        }
      });

      channel.on(FrameMsg.Toggle, data => {
        if (isTopFrame || typeof data !== "boolean") {
          return;
        }

        setEnabled(data);
        broadcastState();
      });

      announceToOtherFrames();
    }

    /**
     * The frames come up in whatever order the page loads them - at `document_idle` the booking iframe's
     * bridge can be running before the top frame's - so whichever joins the channel first announces
     * itself and the other answers, and the relay ends up complete from either side.
     *
     * From the top the announcement IS the toggle: a frame that already scanned answers it with its
     * state, which is the city this badge prints. From any other frame it is "hello", which the top
     * answers with that same toggle.
     */
    function announceToOtherFrames() {
      if (isTopFrame) {
        broadcastToggle();
        return;
      }

      frames?.post(FrameMsg.Hello, undefined);
      broadcastState();
    }

    // ── Read the searched city out of the site's search box ────────────────────
    function isSearchInput(elInput: HTMLInputElement) {
      if (SEARCH_CITY_SELECTORS.some(selector => elInput.matches(selector))) {
        return true;
      }

      const haystack = `${elInput.placeholder} ${elInput.getAttribute("aria-label") ?? ""} ${elInput.name} ${elInput.id}`;
      return SEARCH_CITY_HINT.test(haystack);
    }

    function findSearchInput() {
      return [...document.querySelectorAll<HTMLInputElement>("input")].find(isSearchInput) ?? null;
    }

    // Pushed on the keystroke that changes it, not on a timer: the work is one postMessage to the same
    // window, and a debounce here only ever meant "the city might be stale for another 150 ms".
    function setCity(nextCity: string) {
      const trimmedCity = nextCity.trim();
      if (trimmedCity === city) {
        return;
      }

      city = trimmedCity;
      pushConfig();
      refreshBadge();
      broadcastState();
    }

    for (const eventType of ["input", "change"] as const) {
      ctx.addEventListener(document, eventType, ({ target }) => {
        if (target instanceof HTMLInputElement && isSearchInput(target)) {
          setCity(target.value);
        }
      }, { capture: true });
    }

    // Initial read: the input exists by now (it may carry a value from the URL / a prior search).
    // `document_idle` is what makes that true without a readyState branch - the script runs on a parsed
    // document, whether Chrome injected it on the page's own load or the dev loop evaluated it into an
    // already-loaded one. Nothing here needs to be earlier: the one thing that does, the interceptor's
    // restore recovery, waits on the config message this pushes rather than on when it ran.
    function initialScan() {
      const elInput = findSearchInput();
      if (elInput) {
        city = elInput.value.trim();
      }

      pushConfig();
      refreshBadge();
    }

    initialScan();
    await openFrames();
  }
});
