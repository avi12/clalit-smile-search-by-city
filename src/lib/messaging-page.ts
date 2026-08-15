/**
 * Window messaging channel (MAIN-world interceptor ⇄ ISOLATED bridge), via @webext-core/messaging/page.
 * Uses window.postMessage under a fixed namespace - the only channel available to a MAIN-world script,
 * which has no browser.* extension APIs. Both worlds import this same module so the namespace matches.
 */

import { PAGE_NAMESPACE, type PageProtocol } from "./messaging";
import { defineWindowMessaging } from "@webext-core/messaging/page";

export const {
  sendMessage: sendPageMessage,
  onMessage: onPageMessage
} = defineWindowMessaging<PageProtocol>({ namespace: PAGE_NAMESPACE });
