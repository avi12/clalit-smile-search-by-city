/**
 * Runtime (chrome) messaging channel, via @webext-core/messaging. It exists for exactly one thing: the
 * user's position, which only an EXTENSION context may read under the extension's own geolocation
 * permission. bridge → background → offscreen document, and the fix travels back the same way.
 *
 * The MAIN world can never import this - it has no browser.* at all (that is what the window channel in
 * messaging-page.ts is for).
 */

import { defineExtensionMessaging } from "@webext-core/messaging";

import { type RuntimeProtocol } from "./messaging";

export const { sendMessage: sendRuntimeMessage, onMessage: onRuntimeMessage } =
  defineExtensionMessaging<RuntimeProtocol>();
