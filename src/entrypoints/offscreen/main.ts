/**
 * The one place navigator.geolocation is called. This document runs on the EXTENSION's own origin, so
 * the call is answered under the extension's geolocation permission - the site's own answer, granted or
 * refused, has nothing to do with it.
 *
 * It is opened for a single fix: read on load, report it, and the background closes the document. It
 * holds no state and is never asked anything, so it can never be messaged before it is listening.
 */

import { type LatLng, POSITION_MAX_AGE_MS, POSITION_TIMEOUT_MS } from "@/lib/geo";
import { RuntimeMsg } from "@/lib/messaging";
import { sendRuntimeMessage } from "@/lib/messaging-runtime";

/** Always settles: a refusal, an unavailable provider and the call's own timeout all come back null. */
function currentPosition() {
  return new Promise<LatLng | null>(resolve => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords: { latitude, longitude } }) => resolve([latitude, longitude]),
      () => resolve(null),
      {
        enableHighAccuracy: false,
        timeout: POSITION_TIMEOUT_MS,
        maximumAge: POSITION_MAX_AGE_MS
      }
    );
  });
}

// The background has nothing else to wait on, so this document answers even when it has nothing.
async function report() {
  const position = await currentPosition();
  await sendRuntimeMessage(RuntimeMsg.ReportPosition, position);
}

report().catch(() => {});
