/**
 * Keep the Tamuz session alive by answering the portal's idle dialog.
 *
 * A couple of minutes before it logs an idle session out, the Clalit portal pops "יש פה מישהו?"
 * (`#pnlSessionExpiringInfo`) in the top frame; ignored, it counts down and logs out, dropping the whole
 * Tamuz search state. This watches for that dialog and clicks the site's OWN "המשך" (continue) button —
 * which runs the portal's `clearLogOutTimer()` and reloads `RefreshSession.aspx`. We reuse the site's
 * session refresh rather than reimplementing a keepalive ping. Top frame only (see targets.ts).
 */

import {
  SESSION_TIMEOUT_CONTINUE_SELECTORS,
  SESSION_TIMEOUT_DIALOG_SELECTOR,
  SESSION_TIMEOUT_EXIT_HINT
} from "./targets";

function isVisible(element: Element): boolean {
  if (element.getAttribute("aria-hidden") === "true") {
    return false;
  }

  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  return element.getBoundingClientRect().height > 0;
}

/** The panel's continue control, guarded so a markup change can never make us click "יציאה" (exit). */
function findContinueButton(dialog: Element): HTMLElement | null {
  for (const selector of SESSION_TIMEOUT_CONTINUE_SELECTORS) {
    const candidate = dialog.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector);
    if (!candidate) {
      continue;
    }

    const signature = `${candidate.textContent ?? ""} ${candidate.getAttribute("onclick") ?? ""} ${candidate.getAttribute("href") ?? ""}`;
    if (!SESSION_TIMEOUT_EXIT_HINT.test(signature)) {
      return candidate;
    }
  }

  return null;
}

export function installSessionKeepalive({ isActive }: {
  isActive: () => boolean;
}) {
  let scheduled = false;

  function dismiss() {
    scheduled = false;

    if (!isActive()) {
      return;
    }

    const dialog = document.querySelector(SESSION_TIMEOUT_DIALOG_SELECTOR);
    if (!dialog || !isVisible(dialog)) {
      return;
    }

    findContinueButton(dialog)?.click();
  }

  function schedule() {
    if (scheduled) {
      return;
    }

    scheduled = true;
    setTimeout(dismiss, 200);
  }

  // The dialog is shown by toggling an existing panel's style/aria-hidden and by inserting the modal
  // background, so watch both childList and the visibility attributes. The top frame's DOM is quiet
  // (the churning search results live in a separate iframe document), so a subtree observer is cheap.
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden", "style", "class"]
  });

  dismiss();

  return {
    destroy() {
      observer.disconnect();
    }
  };
}
