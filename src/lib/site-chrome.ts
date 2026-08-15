/**
 * The PAGE's own chrome, reused instead of building our own: the Zimunet bundle's `window.z` UI
 * (loader, lightbox) plus the DOM waits that go with it. MAIN-world only - `z` is a page global, so the
 * ISOLATED bridge can never see it - and every call here is cosmetic: a missing or throwing `z` is the
 * site's business, never the caller's.
 */

import { setDialogNote, setLoaderNote } from "./smile";
import { SITE_LOADER_SELECTOR, SMILE_DETAILS_DIALOG_SELECTOR } from "./targets";

/** The Zimunet site bundle's own UI namespace - the MAIN world sees the page's globals. */
interface ZimunetPageUi {
  showDialog?: (selector: string, html: string) => void;
  /** The site's own message box: it unwraps `{ data }` into `#messageView` through `showDialog`. */
  showMessage?: (message: { data: string }) => void;
  showLoader?: () => void;
  hideLoader?: () => void;
}

declare global {
  interface Window {
    z?: ZimunetPageUi;
  }
}

/**
 * Poll for an element the SITE renders asynchronously (its own Ajax, or our filtered fragment).
 * `exclude` skips the one that was already there: the site HIDES a lightbox instead of removing it
 * (`z.hideAllLightboxes`) and prepends the new one, so a stale dialog can still match the selector.
 */
export async function waitForElement({ selector, exclude }: {
  selector: string;
  exclude?: Element | null;
}) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const elMatch = document.querySelector(selector);
    if (elMatch && elMatch !== exclude) {
      return elMatch;
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return null;
}

/** The parent document, or null when this frame is the top one / the parent is cross-origin. */
export function parentDocument() {
  try {
    const { parent } = window;
    return parent === window ? null : parent.document;
  } catch {
    return null;
  }
}

/**
 * The site's loader lives in the TOP frame (z.showLoader -> parent.StandbyScreenShow appends it to the
 * top document's body), so a caption goes into the parent document when there is one.
 */
export function captionLoader(text: string) {
  const elLoader =
    parentDocument()?.querySelector(SITE_LOADER_SELECTOR) ?? document.querySelector(SITE_LOADER_SELECTOR);
  if (elLoader) {
    setLoaderNote({
      elLoader,
      text
    });
  }
}

/** The site's own full-screen loader - cosmetic, so a missing/throwing z is never the caller's problem. */
export function setSiteLoader(isVisible: boolean) {
  try {
    const pageUi = window.z;
    if (isVisible) {
      pageUi?.showLoader?.();
    } else {
      pageUi?.hideLoader?.();
    }
  } catch { /* site chrome only */ }
}

/** Call the page's own z.showDialog with a fragment - the exact call the site's handlers make. */
export function showDetailsDialog({ html, note }: {
  html: string;
  note: string;
}) {
  const pageUi = window.z;
  if (typeof pageUi?.showDialog !== "function") {
    return false;
  }

  try {
    pageUi.showDialog(SMILE_DETAILS_DIALOG_SELECTOR, html);
  } catch {
    return false;
  }

  // showDialog prepends the dialog synchronously, so the note lands in the same frame as the open.
  const elDialog = document.querySelector(SMILE_DETAILS_DIALOG_SELECTOR);
  if (elDialog) {
    setDialogNote({
      elDialog,
      text: note
    });
  }

  return true;
}

/**
 * The site's OWN message box (`#messageView`), which is how Zimunet answers every "this cannot be done
 * online" - so a click that reaches no page says so in the page's own voice instead of leaving the user
 * looking at an unchanged list.
 */
export function showSiteMessage(html: string) {
  const pageUi = window.z;
  if (typeof pageUi?.showMessage !== "function") {
    return false;
  }

  try {
    pageUi.showMessage({ data: html });
  } catch {
    return false;
  }

  return true;
}

/** A branch with no lightbox to compose falls back to its official clinic page in a new tab. */
export function openInNewTab(href: string) {
  if (href) {
    window.open(href, "_blank", "noopener");
  }
}
