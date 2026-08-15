/**
 * Window messaging channel (MAIN-world interceptor ⇄ ISOLATED bridge), via @webext-core/messaging/page.
 * Uses window.postMessage under a fixed namespace - the only channel available to a MAIN-world script,
 * which has no browser.* extension APIs. Both worlds import this same module so the namespace matches.
 */

import { PAGE_NAMESPACE, type PageProtocol } from "./messaging";
import type { GetDataType } from "@webext-core/messaging";
import { defineWindowMessaging } from "@webext-core/messaging/page";

export const {
  sendMessage: sendPageMessage,
  onMessage: onPageMessage
} = defineWindowMessaging<PageProtocol>({ namespace: PAGE_NAMESPACE });

/**
 * The same channel, addressed at ANOTHER frame: the messenger's send takes the window to post into,
 * so a frame talks to a frame with the protocol rather than around it.
 *
 * Sending across frames is one-way and cannot be anything else - the receiver answers by posting the
 * response on ITS OWN window, which the sender never sees, so the promise the messenger hands back
 * stays pending forever. There is nothing to wait for, and this is the one place that knows it: a
 * caller sends and carries straight on, which is also what lets a broadcast reach every frame instead
 * of stopping at the first.
 *
 * "*" as the target origin because the frames may sit on different Clalit hosts, and what crosses is
 * the badge's caption - display text, never anything the guarantee acts on.
 */
export function postPageMessage<TType extends keyof PageProtocol>(
  type: TType,
  data: GetDataType<PageProtocol[TType]>,
  targetWindow: Window
) {
  sendPageMessage(type, data, "*", targetWindow).catch(() => {});
}
