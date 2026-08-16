/**
 * Where the user is, as seen from the MAIN world. The MAIN world has no browser.* and the SITE's own
 * geolocation permission is not ours to rely on, so nothing is read here: the bridge is asked, and it
 * gets the fix from the extension's own offscreen document (docs: messaging.ts).
 *
 * Best effort by contract - a refusal, a timeout, no bridge listening, or a forged answer all come back
 * as null, and every caller already treats null as "print no distance".
 */

import { positionAnswerSchema } from "./schemas";
import { PageMsg } from "@/lib/messaging";
import { sendPageMessage } from "@/lib/messaging-page";

export async function requestPosition() {
  const answer = await sendPageMessage(PageMsg.Position, undefined).catch(() => null);
  const parsed = positionAnswerSchema.safeParse(answer);
  return parsed.success ? parsed.data : null;
}
