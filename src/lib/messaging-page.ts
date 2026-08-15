/**
 * Window messaging channel (MAIN-world interceptor ⇄ ISOLATED bridge), via @webext-core/messaging/page.
 * Uses window.postMessage under a fixed namespace - the only channel available to a MAIN-world script,
 * which has no browser.* extension APIs. Both worlds import this same module so the namespace matches.
 *
 * ONE frame's two worlds, and nothing wider: a message here never leaves the window it was posted on,
 * and every send has someone to answer it. Frame ⇄ frame is the frame channel (messaging-frames.ts).
 */

import { PAGE_NAMESPACE, type PageProtocol } from "./messaging";
import { defineWindowMessaging } from "@webext-core/messaging/page";

export const {
  sendMessage: sendPageMessage,
  onMessage: onPageMessage
} = defineWindowMessaging<PageProtocol>({ namespace: PAGE_NAMESPACE });
