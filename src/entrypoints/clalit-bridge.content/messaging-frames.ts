/**
 * Frame ⇄ frame channel (bridge ⇄ bridge, one tab), on a BroadcastChannel.
 *
 * Every bridge of the tab joins one channel and speaks into it, so there is no window to address: the
 * `window.length` enumeration, the recursive descent into subtrees, the `"*"` target origin and the
 * promise that could never settle are all gone with the addressing. A BroadcastChannel message reaches
 * every OTHER channel object of the same name and never the sender's own, which is what a broadcast
 * wanted in the first place.
 *
 * The name carries the TAB, because a BroadcastChannel is scoped to the ORIGIN: an unscoped one would
 * also reach a second open Clalit tab, whose search-box frame would relay ITS city into this tab's
 * badge - the one failure this extension exists to prevent. The tab id comes from the background, the
 * only context that can see it, which is why this module is ISOLATED-world only.
 *
 * A same-origin page script can post here too, so a message is validated on arrival like every other
 * boundary. The envelope is all this module knows; what the payload means belongs to the caller's own
 * schema.
 */

import { frameMessageSchema } from "./schemas";
import { type FrameMsg, type FrameProtocol, PAGE_NAMESPACE } from "@/lib/messaging";

export function openFrameChannel(tabId: number) {
  const channel = new BroadcastChannel(`${PAGE_NAMESPACE}/frames/${tabId}`);
  const handlers = new Map<string, (data: unknown) => void>();

  /**
   * `onmessage`, and it has to be: in a content script's ISOLATED world a BroadcastChannel registered
   * with `addEventListener("message", …)` never fires - not even for a message posted by a second
   * channel of the same script, in the same world, in the same tick - while the same object's
   * `postMessage` is delivered normally. Verified live 16.08.2026 (docs "Gotchas"), and the reason
   * this is not the usual `ctx.addEventListener`: the event never arrives to hang off a context.
   */
  channel.onmessage = ({ data }) => {
    const parsed = frameMessageSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }

    handlers.get(parsed.data.type)?.(parsed.data.data);
  };

  return {
    /** To every other frame of this tab. Nothing answers a broadcast, so there is nothing to await. */
    post<TType extends FrameMsg>(type: TType, data: FrameProtocol[TType]) {
      channel.postMessage({
        type,
        data
      });
    },
    /** One handler per type; it is handed the raw payload to parse with the schema that owns it. */
    on(type: FrameMsg, handler: (data: unknown) => void) {
      handlers.set(type, handler);
    },
    /** Stands this generation's channel down without touching anyone else's (see `ctx.onInvalidated`). */
    close() {
      channel.close();
    }
  };
}
