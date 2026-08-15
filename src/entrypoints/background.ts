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

import { type LatLng, POSITION_TIMEOUT_MS } from "../lib/geo";
import { RuntimeMsg } from "../lib/messaging";
import { onRuntimeMessage } from "../lib/messaging-runtime";
import { defineBackground } from "#imports";

const OFFSCREEN_PATH = "/offscreen.html";
const OFFSCREEN_JUSTIFICATION =
  "Reads the user's location once per results list, to show how far each clinic is from them.";
/** The fix's own timeout, plus room for the document to load and report. */
const READ_TIMEOUT_MS = POSITION_TIMEOUT_MS + 2000;

export default defineBackground(() => {
  let inFlightRead: Promise<LatLng | null> | null = null;
  let reportFix: ((position: LatLng | null) => void) | null = null;

  onRuntimeMessage(RuntimeMsg.ReportPosition, ({ data }) => {
    reportFix?.(data);
  });

  async function readPosition() {
    const reported = new Promise<LatLng | null>(resolve => {
      reportFix = resolve;
    });
    const gaveUp = new Promise<null>(resolve => {
      setTimeout(() => resolve(null), READ_TIMEOUT_MS);
    });

    // Closing first makes the next document a fresh one: a leftover has already reported and would
    // never report again, and this way no read can wait on it.
    await chrome.offscreen.closeDocument().catch(() => {});
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.GEOLOCATION],
      justification: OFFSCREEN_JUSTIFICATION
    }).catch(() => {});

    // Best effort by contract: no document, no answer or no fix all mean "no distance line".
    const position = await Promise.race([reported, gaveUp]);
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
