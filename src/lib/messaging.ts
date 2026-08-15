/**
 * Message contracts, as @webext-core/messaging ProtocolMaps keyed by string enums.
 *
 * Two channels. The WINDOW channel (messaging-page.ts) joins the MAIN-world interceptor and the
 * ISOLATED bridge: the bridge reads the city from the page's search box and pushes it, the interceptor
 * reports back what it guaranteed so the badge can show it, and it asks for the user's position. The
 * same channel also carries the frame ⇄ top relay - the messenger's `sendMessage` takes the window to
 * post into, so a child frame addresses the top one with the protocol rather than around it. Those
 * three are one-way by nature: a reply cannot travel back across frames, so nothing awaits them. The
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

/** What a child frame tells the top frame about its own search, to drive the single badge up there. */
export interface FrameState {
  city: string;
  status: GuaranteeStatus | null;
}

export enum PageMsg {
  /** bridge → MAIN: the current search config to apply. */
  Config = "config",
  /** MAIN → bridge: the outcome of the last guarantee. */
  Status = "status",
  /** MAIN → bridge: where the user is, or null when there is no fix to be had. */
  Position = "position",
  /**
   * child frame → TOP frame: this frame's city and last outcome. The booking UI lives in an iframe, so
   * each frame runs its own bridge, but only the top one renders the badge.
   */
  FrameState = "frame-state",
  /** TOP frame → child frames: the session toggle, so every frame agrees on it. */
  Toggle = "toggle",
  /** child frame → TOP frame on init: "I just started - broadcast the toggle". */
  Hello = "hello",
  /**
   * The document is parsed. Sent by the `document_end` script in the same MAIN world, because the
   * interceptor starts at `document_start` and cannot read a DOM that does not exist yet.
   */
  DomReady = "dom-ready"
}

export type PageProtocol = {
  [PageMsg.Config]: (config: SearchConfig) => void;
  [PageMsg.Status]: (status: GuaranteeStatus) => void;
  [PageMsg.Position]: () => LatLng | null;
  [PageMsg.FrameState]: (state: FrameState) => void;
  [PageMsg.Toggle]: (isEnabled: boolean) => void;
  [PageMsg.Hello]: () => void;
  [PageMsg.DomReady]: () => void;
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
