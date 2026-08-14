/**
 * Dev-only "takeover" channel. The dev server re-injects freshly built content scripts into LIVE pages
 * over CDP (a page reload would reset the Tamuz booking SPA back to its home screen), so every
 * (re)injected generation announces itself on the window; older generations of the SAME script hear a
 * NEWER generation's announcement and stand down - remove their UI and become pass-throughs. True
 * un-patching isn't possible once the page holds references, but an inert wrapper is behaviorally
 * identical.
 *
 * Stand-down is ordered by generation age, not token inequality: postMessage delivery is asynchronous,
 * so under rapid re-injection an OLD generation's announcement can land after a newer generation has
 * already installed itself. "Any foreign token" would let that stale announcement supersede everyone -
 * including the newest generation, leaving ZERO active copies. "Strictly newer" converges on exactly
 * one survivor no matter how deliveries interleave (the token breaks same-millisecond ties, and both
 * sides compare the same two tokens, so exactly one of the pair yields).
 *
 * window.postMessage crosses JS worlds (MAIN ⇄ ISOLATED) on the same window, so a re-injected copy
 * running in a different world still supersedes the original. Callers gate on import.meta.env.DEV, so
 * none of this exists in a store build.
 */

import { PAGE_NAMESPACE } from "./messaging";
import { devTakeoverMessageSchema } from "./schemas";

export const DEV_TAKEOVER_SOURCE = `${PAGE_NAMESPACE}/dev-takeover`;

type TakeoverScript = "bridge" | "interceptor";

/** Announce this generation of `script` and invoke `onSuperseded` when a NEWER one announces itself. */
export function installDevTakeover(
  { script, onSuperseded }: {
    script: TakeoverScript;
    onSuperseded: () => void;
  }
): void {
  const bornAt = Date.now();
  const token = `${bornAt}-${Math.random().toString(36).slice(2)}`;
  window.addEventListener("message", ({ data }) => {
    const parsed = devTakeoverMessageSchema.safeParse(data);
    if (!parsed.success || parsed.data.script !== script) {
      return;
    }

    const { bornAt: foreignBornAt, token: foreignToken } = parsed.data;
    const isForeignNewer = foreignBornAt === bornAt ? foreignToken > token : foreignBornAt > bornAt;
    if (isForeignNewer) {
      onSuperseded();
    }
  });
  window.postMessage({
    source: DEV_TAKEOVER_SOURCE,
    script,
    token,
    bornAt
  }, "*");
}
