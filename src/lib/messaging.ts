/**
 * Message contracts, as an @webext-core/messaging ProtocolMap keyed by a string enum.
 *
 * There is only ONE channel now: the window channel between the MAIN-world interceptor and the
 * ISOLATED bridge (see messaging-page.ts). The bridge reads the city from the page's search box and
 * pushes it here; the interceptor reports back what it guaranteed so the badge can show it. No runtime
 * (chrome) messaging and no storage are involved.
 *
 * This module is pure types + the enum + the namespace constant, so any context can import it.
 */

export type GuaranteeMode = "filter" | "boost";

/** Pushed bridge → MAIN. `city` is whatever the user typed into the site's search box (empty = idle). */
export interface SearchConfig {
  isEnabled: boolean;
  city: string;
}

/** Reported MAIN → bridge after a guarantee runs, for the status badge. */
export interface GuaranteeStatus {
  city: string;
  resultsCount: number;
  inCityCount: number;
}

export const PAGE_NAMESPACE = "clalit-city-ext/v1";

/**
 * Marker for the frame ⇄ top relay. The booking UI lives inside an iframe (Tamuz), so each frame runs
 * its own bridge+interceptor pair, but only the top frame renders the badge: child frames relay their
 * {city, status} up with raw window.postMessage (the window channel above never crosses frames) and
 * receive the enabled/disabled toggle back the same way.
 */
export const FRAME_RELAY_SOURCE = `${PAGE_NAMESPACE}/frame-relay`;

export type FrameRelayMessage =
  /** child → top: the child frame's current search state (drives the top badge). */
  | {
    source: typeof FRAME_RELAY_SOURCE;
    kind: "frame-state";
    city: string;
    status: GuaranteeStatus | null;
  }
  /** top → child: the session toggle (also the reply to `hello`). */
  | {
    source: typeof FRAME_RELAY_SOURCE;
    kind: "toggle";
    isEnabled: boolean;
  }
  /** child → top on init: request the current toggle state. */
  | {
    source: typeof FRAME_RELAY_SOURCE;
    kind: "hello";
  };

export enum PageMsg {
  /** bridge → MAIN: the current search config to apply. */
  Config = "config",
  /** MAIN → bridge: the outcome of the last guarantee. */
  Status = "status"
}

export type PageProtocol = {
  [PageMsg.Config]: (config: SearchConfig) => void;
  [PageMsg.Status]: (status: GuaranteeStatus) => void;
};
