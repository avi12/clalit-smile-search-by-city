/**
 * ISOLATED bridge. It reads the city out of the site's search box and pushes it (plus a session on/off)
 * to the MAIN interceptor over the window channel. Runs in ALL frames - the Tamuz booking UI lives in
 * an iframe - and each frame feeds its own MAIN interceptor. The status badge renders only in the top
 * frame: child frames relay their {city, status} up the SAME window channel (its `sendMessage` takes the
 * window to post into) and receive the toggle back that way.
 * No storage - the searched city is the only "setting". Its one privileged errand is the user's
 * position: the MAIN world asks, and the background answers from the extension's offscreen document.
 */

import { type GuaranteeStatus, PageMsg, RuntimeMsg, type SearchConfig } from "../lib/messaging";
import { onPageMessage, postPageMessage, sendPageMessage } from "../lib/messaging-page";
import { sendRuntimeMessage } from "../lib/messaging-runtime";
import { frameStateSchema, guaranteeStatusSchema } from "../lib/schemas";
import { mountStatusBadge } from "../lib/status-badge.svelte";
import { CONTENT_MATCHES, SEARCH_CITY_HINT, SEARCH_CITY_SELECTORS } from "../lib/targets";
import { defineContentScript } from "#imports";

export default defineContentScript({
  matches: [...CONTENT_MATCHES],
  allFrames: true,
  main(ctx) {
    const isTopFrame = window.self === window.top;
    let isEnabled = true; // session-only; resets to on each load (a guarantee tool defaults to guarding)
    let city = "";
    let lastStatus: GuaranteeStatus | null = null;
    // Top frame only: the latest state relayed up from a child frame (where the real search box lives).
    let frameCity = "";
    let frameStatus: GuaranteeStatus | null = null;

    /**
     * What this frame's badge would show, handed up to the frame that actually renders one. The city
     * here is display text; the city the guarantee acts on comes from this frame's own search box and
     * from the submitted request body. `postPageMessage` is the cross-frame send - see the channel.
     *
     * Only the frame holding the search box speaks. The page carries several same-origin frames besides
     * the booking one - it keeps the session alive in a frame of its own, and the accessibility widget
     * has another - and each runs a bridge of this script. They have no search box and so no city, and
     * the top frame keeps ONE relayed state, so letting them relay means whichever spoke last decides
     * what the badge says: the booking frame's city, or an empty one that reads as "type a city".
     */
    function relayStateToTop() {
      const topFrame = window.top;
      const isSearchBoxFrame = Boolean(findSearchInput());
      if (isTopFrame || !topFrame || !isSearchBoxFrame) {
        return;
      }

      postPageMessage(PageMsg.FrameState, {
        city,
        status: lastStatus
      }, topFrame);
    }

    const badge = isTopFrame
      ? mountStatusBadge(ctx, () => {
        setEnabled(!isEnabled);
        broadcastToggle(window.self);
      })
      : null;

    function setEnabled(isNextEnabled: boolean) {
      isEnabled = isNextEnabled;
      pushConfig();
      refreshBadge();
    }

    /** Top → every descendant frame (indexed access + length are cross-origin-safe). */
    function broadcastToggle(parentFrame: Window) {
      for (let i = 0; i < parentFrame.length; i++) {
        const childFrame: Window = parentFrame[i];
        postPageMessage(PageMsg.Toggle, isEnabled, childFrame);
        try {
          broadcastToggle(childFrame);
        } catch { /* inaccessible frame subtree */ }
      }
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
      relayStateToTop();
    });

    /**
     * The MAIN world cannot read a position (no browser.*) and must not depend on what the SITE was
     * granted, so it asks here and the background reads it in the extension's own offscreen document.
     */
    onPageMessage(PageMsg.Position, () =>
      sendRuntimeMessage(RuntimeMsg.Position, undefined).catch(() => null));

    // ── Frame ⇄ top relay, on the same channel as everything else ──────────────
    onPageMessage(PageMsg.FrameState, ({ data }) => {
      const parsed = frameStateSchema.safeParse(data);
      if (!isTopFrame || !parsed.success) {
        return;
      }

      frameCity = parsed.data.city;
      frameStatus = parsed.data.status;
      refreshBadge();
    });

    // A child that just started asks for the toggle; the answer goes to every frame, because a reply
    // cannot travel back to the one that asked.
    onPageMessage(PageMsg.Hello, () => {
      if (isTopFrame) {
        broadcastToggle(window.self);
      }
    });

    onPageMessage(PageMsg.Toggle, ({ data }) => {
      if (isTopFrame || typeof data !== "boolean") {
        return;
      }

      setEnabled(data);
      relayStateToTop();
    });

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
      relayStateToTop();
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
      announceToOtherFrames();
    }

    /**
     * The frames come up in whatever order the page loads them - at `document_idle` the booking iframe's
     * bridge can be running before the top frame's - so whichever starts first announces itself and the
     * other answers, and the relay ends up complete from either side.
     *
     * From the top the announcement IS the toggle: a child that already scanned answers it with its
     * state, which is the city this badge prints. From a child it is "hello", which the top answers with
     * that same toggle.
     */
    function announceToOtherFrames() {
      if (isTopFrame) {
        broadcastToggle(window.self);
        return;
      }

      const topFrame = window.top;
      if (topFrame) {
        postPageMessage(PageMsg.Hello, undefined, topFrame);
        relayStateToTop();
      }
    }

    initialScan();
  }
});
