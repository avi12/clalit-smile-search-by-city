/**
 * Dev-only "takeover" channel. The dev server re-injects freshly built content scripts into LIVE pages
 * over CDP (a page reload would reset the Tamuz booking SPA back to its home screen), so every
 * (re)injected generation announces itself on the window with a unique token; older generations of the
 * SAME script hear a foreign token and stand down — remove their UI and become pass-throughs. True
 * un-patching isn't possible once the page holds references, but an inert wrapper is behaviorally
 * identical.
 *
 * window.postMessage crosses JS worlds (MAIN ⇄ ISOLATED) on the same window, so a re-injected copy
 * running in a different world still supersedes the original. Callers gate on import.meta.env.DEV, so
 * none of this exists in a store build.
 */

import { PAGE_NAMESPACE } from "./messaging";
import { devTakeoverMessageSchema } from "./schemas";

export const DEV_TAKEOVER_SOURCE = `${PAGE_NAMESPACE}/dev-takeover`;

type TakeoverScript = "bridge" | "interceptor";

/** Announce this generation of `script` and invoke `onSuperseded` when a newer one announces itself. */
export function installDevTakeover(
  { script, onSuperseded }: {
    script: TakeoverScript;
    onSuperseded: () => void;
  }
): void {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.addEventListener("message", event => {
    const parsed = devTakeoverMessageSchema.safeParse(event.data);
    if (parsed.success && parsed.data.script === script && parsed.data.token !== token) {
      onSuperseded();
    }
  });
  window.postMessage({
    source: DEV_TAKEOVER_SOURCE,
    script,
    token
  }, "*");
}
