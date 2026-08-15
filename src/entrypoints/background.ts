/**
 * The extension's only privileged context, and it exists for ONE thing: the user's position.
 *
 * A content script's navigator.geolocation is the PAGE's - gated by whatever the site was granted, and
 * silently empty when the user once refused Clalit. The extension has its own geolocation permission,
 * but only an extension context may spend it, so the fix is taken in an offscreen document (the one
 * documented use of `chrome.offscreen`'s GEOLOCATION reason) and handed back over the runtime channel.
 *
 * The document is opened per read and closed again, and it REPORTS rather than being asked - there is
 * no moment where the background could message a document whose listeners are not up yet. Concurrent
 * askers (each frame's bridge) share one in-flight read instead of racing to open a second document,
 * which Chrome refuses.
 */

import { type LatLng } from "../lib/geo";
import { RuntimeMsg } from "../lib/messaging";
import { onRuntimeMessage } from "../lib/messaging-runtime";
import { defineBackground } from "#imports";

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
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.GEOLOCATION],
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
    await chrome.offscreen.closeDocument().catch(() => {});
    // A document that cannot be opened is the only way the report never comes - the document itself
    // always answers, fix or no fix, and its own getCurrentPosition timeout bounds how long that takes.
    const isOpen = await openDocument();

    // Best effort by contract: no document and no fix both mean "no distance line".
    const position = isOpen ? await reported : null;
    reportFix = null;
    await chrome.offscreen.closeDocument().catch(() => {});
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
});
