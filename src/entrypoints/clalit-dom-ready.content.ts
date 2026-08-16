/**
 * The page's own lifecycle, delivered by the browser.
 *
 * The interceptor has to start at `document_start` - that is the only moment it can patch `fetch` and
 * XMLHttpRequest before the site's scripts capture references to them - and two of its jobs need a DOM
 * that does not exist yet at that point. It used to work the moment out for itself, branching on
 * `document.readyState` and otherwise waiting for `DOMContentLoaded`; the branch was there because a dev
 * re-injection lands on a document that has long since fired that event, and an event cannot be caught
 * after the fact.
 *
 * `runAt` has no such problem: the browser runs this script when the document is parsed, whichever way
 * the script got there, so the milestone is announced rather than deduced. That is the whole of this
 * entrypoint - one message on the window channel, in the MAIN world the interceptor listens in.
 *
 * It registers nothing and holds nothing, so there is no context to hang it on and nothing for a
 * superseded generation to stand down.
 */

import { PageMsg } from "@/lib/messaging";
import { sendPageMessage } from "@/lib/messaging-page";
import { CONTENT_MATCHES } from "@/lib/targets";
import { defineContentScript } from "#imports";

export default defineContentScript({
  matches: [...CONTENT_MATCHES],
  runAt: "document_end",
  allFrames: true,
  world: "MAIN",
  main() {
    sendPageMessage(PageMsg.DomReady, undefined).catch(() => {});
  }
});
