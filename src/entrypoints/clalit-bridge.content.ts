/**
 * ISOLATED bridge. It reads the city out of the site's search box and pushes it (plus a session on/off)
 * to the MAIN interceptor over the window channel. Runs in ALL frames - the Tamuz booking UI lives in
 * an iframe - and each frame feeds its own MAIN interceptor. The status badge renders only in the top
 * frame: child frames relay their {city, status} up and receive the toggle back (see FrameRelayMessage).
 * No storage - the searched city is the only "setting". Its one privileged errand is the user's
 * position: the MAIN world asks, and the background answers from the extension's offscreen document.
 */

import { installDevTakeover } from "../lib/dev-takeover";
import {
  FRAME_RELAY_SOURCE,
  type FrameRelayMessage,
  type GuaranteeStatus,
  PageMsg,
  RuntimeMsg,
  type SearchConfig
} from "../lib/messaging";
import { onPageMessage, removeAllPageListeners, sendPageMessage } from "../lib/messaging-page";
import { sendRuntimeMessage } from "../lib/messaging-runtime";
import { frameRelayMessageSchema, guaranteeStatusSchema } from "../lib/schemas";
import { mountStatusBadge } from "../lib/status-badge.svelte";
import { CONTENT_MATCHES, isTargetHost, SEARCH_CITY_HINT, SEARCH_CITY_SELECTORS } from "../lib/targets";
import { defineContentScript } from "#imports";

export default defineContentScript({
  matches: [...CONTENT_MATCHES],
  runAt: "document_start",
  allFrames: true,
  main(ctx) {
    const isTopFrame = window.self === window.top;
    let isEnabled = true; // session-only; resets to on each load (a guarantee tool defaults to guarding)
    let city = "";
    let lastStatus: GuaranteeStatus | null = null;
    // Top frame only: the latest state relayed up from a child frame (where the real search box lives).
    let frameCity = "";
    let frameStatus: GuaranteeStatus | null = null;

    // The payload is only the typed city + result counts, so "*" is fine as target origin (top and
    // child may sit on different Clalit hosts); INCOMING relay messages are origin-checked instead.
    function postRelay({ target, message }: {
      target: Window | null;
      message: FrameRelayMessage;
    }) {
      target?.postMessage(message, "*");
    }

    function relayStateToTop() {
      if (!isTopFrame) {
        postRelay({
          target: window.top,
          message: {
            source: FRAME_RELAY_SOURCE,
            kind: "frame-state",
            city,
            status: lastStatus
          }
        });
      }
    }

    const badge = isTopFrame
      ? mountStatusBadge(ctx, () => {
        setEnabled(!isEnabled);
        broadcastToggle(window.self);
      })
      : null;

    // Dev re-injection: a newer generation flips this; every handler below then ignores its events.
    let isSuperseded = false;
    if (import.meta.env.DEV) {
      installDevTakeover({
        script: "bridge",
        onSuperseded() {
          isSuperseded = true;
          badge?.destroy();
          removeAllPageListeners();
        }
      });
    }

    function setEnabled(isNextEnabled: boolean) {
      isEnabled = isNextEnabled;
      pushConfig();
      refreshBadge();
    }

    /** Top → every descendant frame (indexed access + length are cross-origin-safe). */
    function broadcastToggle(parentFrame: Window) {
      for (let i = 0; i < parentFrame.length; i++) {
        const childFrame: Window = parentFrame[i];
        postRelay({
          target: childFrame,
          message: {
            source: FRAME_RELAY_SOURCE,
            kind: "toggle",
            isEnabled
          }
        });
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
      sendPageMessage(PageMsg.Config, config).catch(() => {});
    }

    onPageMessage(PageMsg.Status, ({ data }) => {
      const parsed = guaranteeStatusSchema.safeParse(data);
      if (isSuperseded || !parsed.success) {
        return;
      }

      lastStatus = parsed.data;
      refreshBadge();
      relayStateToTop();
    });

    /**
     * The MAIN world cannot read a position (no chrome.*) and must not depend on what the SITE was
     * granted, so it asks here and the background reads it in the extension's own offscreen document.
     */
    onPageMessage(PageMsg.Position, () => {
      if (isSuperseded) {
        return null;
      }

      return sendRuntimeMessage(RuntimeMsg.Position, undefined).catch(() => null);
    });

    // ── Frame ⇄ top relay ──────────────────────────────────────────────────────
    /**
     * Frame relay events always come from windows; rule out the port/worker sources by elimination -
     * `instanceof Window` would be false for a CROSS-ORIGIN child frame (its proxy's prototype is
     * null), and top and child frames may sit on different Clalit hosts.
     */
    function isWindowSource(source: MessageEventSource | null): source is Window {
      return source !== null && !(source instanceof MessagePort) && !(source instanceof ServiceWorker);
    }

    function isClalitOrigin(origin: string) {
      try {
        return isTargetHost(new URL(origin).hostname);
      } catch {
        return false;
      }
    }

    window.addEventListener("message", ({ data, origin, source }) => {
      const parsed = frameRelayMessageSchema.safeParse(data);
      if (isSuperseded || !parsed.success || !isClalitOrigin(origin)) {
        return;
      }

      const message = parsed.data;
      if (message.kind === "frame-state" && isTopFrame) {
        frameCity = message.city;
        frameStatus = message.status;
        refreshBadge();
      } else if (message.kind === "hello" && isTopFrame && isWindowSource(source)) {
        postRelay({
          target: source,
          message: {
            source: FRAME_RELAY_SOURCE,
            kind: "toggle",
            isEnabled
          }
        });
      } else if (message.kind === "toggle" && !isTopFrame) {
        setEnabled(message.isEnabled);
        relayStateToTop();
      }
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

    let cityDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    function setCity(nextCity: string) {
      const trimmedCity = nextCity.trim();
      if (trimmedCity === city) {
        return;
      }

      city = trimmedCity;
      clearTimeout(cityDebounceTimer);
      cityDebounceTimer = setTimeout(() => {
        pushConfig();
        refreshBadge();
        relayStateToTop();
      }, 150);
    }

    for (const eventType of ["input", "change"] as const) {
      document.addEventListener(eventType, ({ target }) => {
        if (!isSuperseded && target instanceof HTMLInputElement && isSearchInput(target)) {
          setCity(target.value);
        }
      }, true);
    }

    // Initial read once the input exists (it may carry a value from the URL / a prior search).
    function initialScan() {
      const elInput = findSearchInput();
      if (elInput) {
        city = elInput.value.trim();
      }

      pushConfig();
      refreshBadge();

      if (!isTopFrame) {
        postRelay({
          target: window.top,
          message: {
            source: FRAME_RELAY_SOURCE,
            kind: "hello"
          }
        });
        relayStateToTop();
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initialScan, { once: true });
    } else {
      initialScan();
    }
  }
});
