/**
 * Window messaging channel (MAIN-world interceptor ⇄ ISOLATED bridge), via @webext-core/messaging/page.
 * Uses window.postMessage under a fixed namespace - the only channel available to a MAIN-world script,
 * which has no browser.* extension APIs. Both worlds import this same module so the namespace matches.
 */

import { PAGE_NAMESPACE, type PageProtocol } from "./messaging";
import { defineWindowMessaging } from "@webext-core/messaging/page";

export const {
  sendMessage: sendPageMessage,
  onMessage: onPageMessage,
  /**
   * Dev only: a superseded generation has to go SILENT, not merely inert. A request is answered by the
   * first listener that replies, so a stood-down copy replying "nothing" would beat the live copy's
   * real answer - which is how a whole feature can quietly die after a re-injection.
   */
  removeAllListeners: removeAllPageListeners
} = defineWindowMessaging<PageProtocol>({ namespace: PAGE_NAMESPACE });
