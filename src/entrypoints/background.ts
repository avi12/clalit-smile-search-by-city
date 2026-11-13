/**
 * The extension's only privileged context. It answers what only an extension API can answer, which is
 * two things: the user's position, and which tab a bridge is running in.
 *
 * A content script's navigator.geolocation is the PAGE's - gated by whatever the site was granted, and
 * silently empty when the user once refused Clalit. The extension has its own geolocation permission,
 * but only an extension context may spend it, so the fix is taken in an offscreen document (the one
 * documented use of `browser.offscreen`'s GEOLOCATION reason) and handed back over the runtime channel.
 *
 * The document is opened per read and closed again, and it REPORTS rather than being asked - there is
 * no moment where the background could message a document whose listeners are not up yet. Concurrent
 * askers (each frame's bridge) share one in-flight read instead of racing to open a second document,
 * which Chrome refuses.
 */

import { browser, defineBackground } from "#imports";
import { type LatLng } from "@/lib/geo";
import { RuntimeMsg } from "@/lib/messaging";
import { onRuntimeMessage } from "@/lib/messaging-runtime";

const OFFSCREEN_PATH = "/offscreen.html";
const OFFSCREEN_JUSTIFICATION =
  "Reads the user's location once per results list, to show how far each clinic is from them.";

export default defineBackground(() => {
  let inFlightRead: Promise<LatLng | null> | null = null;
  let reportFix: ((position: LatLng | null) => void) | null = null;

  onRuntimeMessage(RuntimeMsg.ReportPosition, ({ data }) => {
    reportFix?.(data);
  });

  async function openDocument() {
    try {
      await browser.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [browser.offscreen.Reason.GEOLOCATION],
        justification: OFFSCREEN_JUSTIFICATION
      });
      return true;
    } catch {
      return false;
    }
  }

  async function readPosition() {
    const reported = new Promise<LatLng | null>(resolve => {
      reportFix = resolve;
    });

    // Closing first makes the next document a fresh one: a leftover has already reported and would
    // never report again, and this way no read can wait on it.
    await browser.offscreen.closeDocument().catch(() => {});
    // A document that cannot be opened is the only way the report never comes - the document itself
    // always answers, fix or no fix, and its own getCurrentPosition timeout bounds how long that takes.
    const isOpen = await openDocument();

    // Best effort by contract: no document and no fix both mean "no distance line".
    const position = isOpen ? await reported : null;
    reportFix = null;
    await browser.offscreen.closeDocument().catch(() => {});
    return position;
  }

  function positionForAskers() {
    if (!inFlightRead) {
      inFlightRead = readPosition().finally(() => {
        inFlightRead = null;
      });
    }

    return inFlightRead;
  }

  onRuntimeMessage(RuntimeMsg.Position, () => positionForAskers());

  /**
   * The frame channel is a BroadcastChannel, which is scoped to the ORIGIN - so its name has to carry
   * the tab, or a second open Clalit tab would share it. A frame cannot see which tab it is in; the
   * message's sender can, and every frame of one tab gets the same answer.
   */
  onRuntimeMessage(RuntimeMsg.TabId, ({ sender }) => sender.tab?.id ?? null);
});
