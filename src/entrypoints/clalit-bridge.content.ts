/**
 * ISOLATED bridge. It reads the city out of the site's search box and pushes it (plus a session on/off)
 * to the MAIN interceptor over the window channel. Runs in ALL frames — the Tamuz booking UI lives in
 * an iframe — and each frame feeds its own MAIN interceptor. The status badge renders only in the top
 * frame: child frames relay their {city, status} up and receive the toggle back (see FrameRelayMessage).
 * No storage, no runtime messaging — the searched city is the only "setting".
 */

import { installDevTakeover } from "../lib/dev-takeover";
import {
  FRAME_RELAY_SOURCE,
  type FrameRelayMessage,
  type GuaranteeStatus,
  PageMsg,
  type SearchConfig
} from "../lib/messaging";
import { onPageMessage, sendPageMessage } from "../lib/messaging-page";
import { frameRelayMessageSchema, guaranteeStatusSchema } from "../lib/schemas";
import { mountStatusBadge } from "../lib/status-badge";
import { CONTENT_MATCHES, isTargetHost, SEARCH_CITY_HINT, SEARCH_CITY_SELECTORS } from "../lib/targets";
import { defineContentScript } from "#imports";

export default defineContentScript({
  matches: [...CONTENT_MATCHES],
  runAt: "document_start",
  allFrames: true,
  main() {
    const isTopFrame = window.self === window.top;
    let enabled = true; // session-only; resets to on each load (a guarantee tool defaults to guarding)
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
      ? mountStatusBadge(() => {
        setEnabled(!enabled);
        broadcastToggle(window.self);
      })
      : null;

    // Dev re-injection: a newer generation flips this; every handler below then ignores its events.
    let superseded = false;
    if (import.meta.env.DEV) {
      installDevTakeover({
        script: "bridge",
        onSuperseded() {
          superseded = true;
          badge?.destroy();
        }
      });
    }

    function setEnabled(next: boolean) {
      enabled = next;
      pushConfig();
      refreshBadge();
    }

    /** Top → every descendant frame (indexed access + length are cross-origin-safe). */
    function broadcastToggle(win: Window) {
      for (let i = 0; i < win.length; i++) {
        const child: Window = win[i];
        postRelay({
          target: child,
          message: {
            source: FRAME_RELAY_SOURCE,
            kind: "toggle",
            enabled
          }
        });
        try {
          broadcastToggle(child);
        } catch { /* inaccessible frame subtree */ }
      }
    }

    function refreshBadge() {
      badge?.update({
        enabled,
        city: city || frameCity,
        status: frameStatus ?? lastStatus
      });
    }

    function pushConfig() {
      const config: SearchConfig = {
        enabled,
        city
      };
      sendPageMessage(PageMsg.Config, config).catch(() => {});
    }

    onPageMessage(PageMsg.Status, ({ data }) => {
      const parsed = guaranteeStatusSchema.safeParse(data);
      if (superseded || !parsed.success) {
        return;
      }

      lastStatus = parsed.data;
      refreshBadge();
      relayStateToTop();
    });

    // ── Frame ⇄ top relay ──────────────────────────────────────────────────────
    /**
     * Frame relay events always come from windows; rule out the port/worker sources by elimination —
     * `instanceof Window` would be false for a CROSS-ORIGIN child frame (its proxy's prototype is
     * null), and top and child frames may sit on different Clalit hosts.
     */
    function isWindowSource(source: MessageEventSource | null): source is Window {
      return source !== null && !(source instanceof MessagePort) && !(source instanceof ServiceWorker);
    }

    function isClalitOrigin(origin: string): boolean {
      try {
        return isTargetHost(new URL(origin).hostname);
      } catch {
        return false;
      }
    }

    window.addEventListener("message", event => {
      const parsed = frameRelayMessageSchema.safeParse(event.data);
      if (superseded || !parsed.success || !isClalitOrigin(event.origin)) {
        return;
      }

      const message = parsed.data;
      if (message.kind === "frame-state" && isTopFrame) {
        frameCity = message.city;
        frameStatus = message.status;
        refreshBadge();
      } else if (message.kind === "hello" && isTopFrame && isWindowSource(event.source)) {
        postRelay({
          target: event.source,
          message: {
            source: FRAME_RELAY_SOURCE,
            kind: "toggle",
            enabled
          }
        });
      } else if (message.kind === "toggle" && !isTopFrame) {
        setEnabled(message.enabled);
        relayStateToTop();
      }
    });

    // ── Read the searched city out of the site's search box ────────────────────
    function isSearchInput(input: HTMLInputElement): boolean {
      if (SEARCH_CITY_SELECTORS.some(selector => input.matches(selector))) {
        return true;
      }

      const haystack = `${input.placeholder} ${input.getAttribute("aria-label") ?? ""} ${input.name} ${input.id}`;
      return SEARCH_CITY_HINT.test(haystack);
    }

    function findSearchInput(): HTMLInputElement | null {
      return [...document.querySelectorAll<HTMLInputElement>("input")].find(isSearchInput) ?? null;
    }

    let debounce: ReturnType<typeof setTimeout> | undefined;
    function setCity(next: string) {
      const trimmed = next.trim();
      if (trimmed === city) {
        return;
      }

      city = trimmed;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        pushConfig();
        refreshBadge();
        relayStateToTop();
      }, 150);
    }

    for (const type of ["input", "change"] as const) {
      document.addEventListener(type, event => {
        const target = event.target;
        if (!superseded && target instanceof HTMLInputElement && isSearchInput(target)) {
          setCity(target.value);
        }
      }, true);
    }

    // Initial read once the input exists (it may carry a value from the URL / a prior search).
    function initialScan() {
      const input = findSearchInput();
      if (input) {
        city = input.value.trim();
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
