/**
 * Message contracts, as @webext-core/messaging ProtocolMaps keyed by string enums.
 *
 * Two channels. The WINDOW channel (messaging-page.ts) joins the MAIN-world interceptor and the
 * ISOLATED bridge: the bridge reads the city from the page's search box and pushes it, the interceptor
 * reports back what it guaranteed so the badge can show it, and it asks for the user's position. The
 * RUNTIME channel (messaging-runtime.ts) is how that position is actually obtained - the bridge asks
 * the background, which reads it in the extension's OWN offscreen document, so the answer belongs to
 * the extension's geolocation permission rather than to whatever the site was granted. No storage is
 * involved in either.
 *
 * This module is pure types + the enums + the namespace constant, so any context can import it.
 */

import type { LatLng } from "./geo";

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
  Status = "status",
  /** MAIN → bridge: where the user is, or null when there is no fix to be had. */
  Position = "position"
}

export type PageProtocol = {
  [PageMsg.Config]: (config: SearchConfig) => void;
  [PageMsg.Status]: (status: GuaranteeStatus) => void;
  [PageMsg.Position]: () => LatLng | null;
};

export enum RuntimeMsg {
  /** bridge → background: the user's position, read in the extension's own context. */
  Position = "position",
  /** offscreen document → background: the fix it was opened to take (null = none to be had). */
  ReportPosition = "report-position"
}

export type RuntimeProtocol = {
  [RuntimeMsg.Position]: () => LatLng | null;
  [RuntimeMsg.ReportPosition]: (position: LatLng | null) => void;
};
