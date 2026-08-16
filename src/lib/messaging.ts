/**
 * Message contracts, as @webext-core/messaging ProtocolMaps keyed by string enums.
 *
 * Three channels, one contract module. The WINDOW channel (messaging-page.ts) joins the MAIN-world
 * interceptor and the ISOLATED bridge within ONE frame: the bridge reads the city from the page's
 * search box and pushes it, the interceptor reports back what it guaranteed so the badge can show it,
 * and it asks for the user's position. The FRAME channel (messaging-frames.ts) joins the bridges of a
 * tab to each other, so the one badge in the top frame shows what the frame holding the search box
 * found; it is a BroadcastChannel, so its messages are one-way and have no sender to answer. The
 * RUNTIME channel (messaging-runtime.ts) is the only way to an extension API: it obtains the user's
 * position - the bridge asks the background, which reads it in the extension's OWN offscreen document,
 * so the answer belongs to the extension's geolocation permission rather than to whatever the site was
 * granted - and it answers which tab a bridge is in, which is what scopes the frame channel. No storage
 * is involved in any of them.
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

/** What a frame tells the other frames of its tab about its own search, to drive the single badge. */
export interface FrameState {
  city: string;
  status: GuaranteeStatus | null;
}

/**
 * The frame channel carries a broadcast, so there is no sender to answer and no return value to name -
 * a frame message is a type and a payload, and that is the whole shape of it.
 */
export enum FrameMsg {
  /**
   * the frame holding the search box → the top frame: its city and last outcome. The booking UI lives
   * in an iframe, so every frame runs its own bridge while only the top one renders the badge.
   */
  State = "frame-state",
  /** the top frame → every other frame: the session toggle, so the whole tab agrees on it. */
  Toggle = "toggle",
  /** any frame on init → the top frame: "I just joined - broadcast the toggle". */
  Hello = "hello"
}

export type FrameProtocol = {
  [FrameMsg.State]: FrameState;
  [FrameMsg.Toggle]: boolean;
  [FrameMsg.Hello]: undefined;
};

export enum RuntimeMsg {
  /** bridge → background: the user's position, read in the extension's own context. */
  Position = "position",
  /** offscreen document → background: the fix it was opened to take (null = none to be had). */
  ReportPosition = "report-position",
  /** bridge → background: which tab this frame is in - the scope of its frame channel. */
  TabId = "tab-id"
}

export type RuntimeProtocol = {
  [RuntimeMsg.Position]: () => LatLng | null;
  [RuntimeMsg.ReportPosition]: (position: LatLng | null) => void;
  [RuntimeMsg.TabId]: () => number | null;
};
