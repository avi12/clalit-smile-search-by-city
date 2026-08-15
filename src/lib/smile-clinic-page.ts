/**
 * The appointments page for a branch Tamuz has no diary for.
 *
 * Every Tamuz page is keyed by a handle the server mints (docs §12f), so a branch the search never lists
 * has no page of its own - yet "לכל התורים" has to land somewhere that belongs to THAT clinic. So the row
 * borrows the site's own appointments page: it navigates to a REAL diary's slots page (a row of the
 * current search) with the branch's code in the URL hash, and this module retitles that page to the
 * branch and empties it of the other clinic's availability.
 *
 * Emptying is not invented markup: the site itself answers a month with no slots with
 * `{ data: "<div class=clear-fix noAvailableQueuesNotFound>…אין תורים פנויים בחודש הזה…" }` (captured
 * from `GetMonthlyAvailableVisit`, docs §12i), and that is exactly what the availability calls are
 * answered with here - so the page shows Clalit's own empty state, and no slot can ever be clicked.
 */

import { SMILE_BRANCHES } from "./clinic-directory";
import type { SmileBranch } from "./clinic-directory";
import { setSiteLoader } from "./site-chrome";
import { buildHotlineNote, formatPhone, NO_SERVICE_ROW_NOTE, SMILE_ENVELOPE_STATUS } from "./smile";

declare global {
  interface Window {
    /** The page's own jQuery - the datepicker is its widget, so only it can move the calendar. */
    jQuery?: (selector: string) => {
      datepicker?: (method: string, value?: unknown) => void;
    } | null;
  }
}

/** Names the branch a borrowed slots page is being shown for - a hash, so the server never sees it. */
export const TAILORED_BRANCH_HASH = "#clalit-city-clinic=";

/** The branch code in a slots-page URL, or "" when this page is the site's own. */
export function tailoredBranchCode(hash: string) {
  return hash.startsWith(TAILORED_BRANCH_HASH) ? hash.slice(TAILORED_BRANCH_HASH.length) : "";
}

/** The site's own "no appointments this month" answer, verbatim (docs §12i). */
const EMPTY_MONTH_HTML = "<div class=\"clear-fix noAvailableQueuesNotFound\">" +
  "<header class=\"margin-right bottom-border\">אין תורים פנויים בחודש הזה</header>" +
  "<div id=\"error-panel\" class=\"margin-right\"><p>לא קיימים תורים פנויים.</p></div>" +
  "</div>";

/** The site's own labels inside the page's clinic line - what follows each is this branch's. */
const ADDRESS_LABEL = "כתובת:";
const PHONE_LABEL = "טלפון:";

/** The directory's phones, formatted the way the site prints them ("36316561" -> "03-6316561"). */
function branchPhones(branch: SmileBranch) {
  return branch.phones.map(phone => formatPhone(phone)?.display).filter(Boolean).join(" ");
}

const CLINIC_TITLE_SELECTOR = "#availableVisitClinicTitle";
const CLINIC_LINK_SELECTOR = "#availableVisitsClinicDetails";
const DATEPICKER_SELECTOR = "#datepicker-wrapper";
const DATEPICKER_SELECTOR_INNER = "#datepicker";
const FILTERS_SELECTOR = "#filter-wrapper";
const SLOTS_SELECTOR = ".day-part, .noAvailableQueuesNotFound, header.margin-right";

const MONTHLY_PATH = "/AvailableVisit/GetMonthlyAvailableVisit";
const DAILY_PATH = "/AvailableVisit/GetDailyAvailableVisit";

/** Is this one of the two availability calls the slots page makes for its diary? */
export function isAvailabilityUrl(url: string) {
  return url.includes(MONTHLY_PATH) || url.includes(DAILY_PATH);
}

/**
 * What those calls answer with on a borrowed page, in the site's OWN "nothing to show" form.
 *
 * `z.AvailableVisits` branches on the envelope's status (docs §12i): `Success` means `data` is the full
 * object and the handler walks it - `data.dailyVisits`, `data.availableDays`, and
 * `data.familyDoctorProfessions[1].filterCounter` - while `Information` means `data` is a plain HTML
 * string, which it drops into the queues container before clearing `availableDays`. Answering `Success`
 * with anything less than the whole object throws inside that walk, and the throw takes the success
 * handler down with it - including the line where `z.Ajax` lowers the loader it raised, which is the
 * spinner that never stops. So the answer here is the one the server itself gives for an empty month.
 */
export function emptyAvailabilityEnvelope() {
  return {
    data: EMPTY_MONTH_HTML,
    errorType: SMILE_ENVELOPE_STATUS.information,
    message: null
  };
}

export function createTailoredClinicPage(code: string) {
  const branch = SMILE_BRANCHES.find(candidate => candidate.code === code);

  /** "תור למרפאה: {clinic}, כתובת: {address}, טלפון: {phone}" - the page's own line, for this branch. */
  function retitle() {
    const elTitle = document.querySelector(CLINIC_TITLE_SELECTOR);
    const elLink = document.querySelector(CLINIC_LINK_SELECTOR);
    if (!branch || !elTitle || !elLink) {
      return;
    }

    elLink.textContent = branch.title;
    elLink.setAttribute("title", branch.title);
    elLink.setAttribute("data-clinic-code", branch.code);
    // ClinicDetailsByParams answers for the SESSION's clinic (docs §12), which is the borrowed one - so
    // the site's own details handler must not fire here.
    elLink.removeAttribute("data-action-link");
    elLink.classList.remove("clinicDetails");

    // The line is text nodes around the link, each already carrying the site's own "כתובת:"/"טלפון:"
    // label and its own comma separator - so only what follows the label is rewritten.
    const address = branch.street ? `${branch.street}, ${branch.city}` : branch.city;
    for (const node of elTitle.childNodes) {
      const text = node.nodeType === Node.TEXT_NODE ? node.textContent ?? "" : "";
      if (text.includes(ADDRESS_LABEL)) {
        node.textContent = text.slice(0, text.indexOf(ADDRESS_LABEL) + ADDRESS_LABEL.length) + ` ${address}`;
      } else if (text.includes(PHONE_LABEL)) {
        node.textContent = text.slice(0, text.indexOf(PHONE_LABEL) + PHONE_LABEL.length) + ` ${branchPhones(branch)}`;
      }
    }
  }

  /** The borrowed diary's own slots, replaced by the site's empty state before anything can be clicked. */
  function emptyTheDiary() {
    const elSlots = [...document.querySelectorAll(SLOTS_SELECTOR)];
    const elHost = elSlots[0]?.parentElement;
    if (!elHost) {
      return;
    }

    for (const elSlot of elSlots) {
      elSlot.remove();
    }

    elHost.insertAdjacentHTML("afterbegin", EMPTY_MONTH_HTML);
  }

  /**
   * The lender's own filters go: the hour/gender lists mean nothing without slots, and the name list is
   * the OTHER clinic's hygienist - the one identity leak a retitled page must not keep.
   */
  function dropLenderFilters() {
    document.querySelector(FILTERS_SELECTOR)?.remove();
  }

  /**
   * The datepicker opens on the lender's first available month (January 2027 for a diary that far out),
   * which reads as this branch's. The site's own jQuery UI instance is asked for today instead.
   */
  function resetToThisMonth() {
    const today = new Date();
    try {
      // Both calls are needed: the site pins the view to its diary's first free month through
      // defaultDate/minDate, and only then does setDate move the calendar (verified in the live page).
      const elDatepicker = window.jQuery?.(DATEPICKER_SELECTOR_INNER);
      elDatepicker?.datepicker?.("option", {
        defaultDate: today,
        minDate: null
      });
      elDatepicker?.datepicker?.("setDate", today);
    } catch { /* the calendar is the site's; a refusal is cosmetic */ }
  }

  /** The other clinic's available days stay visible but stop being clickable - nothing here is bookable. */
  function disableDays() {
    for (const elDay of document.querySelectorAll(`${DATEPICKER_SELECTOR} a.ui-state-default`)) {
      const elDisabled = elDay.ownerDocument.createElement("span");
      elDisabled.className = "ui-state-default ui-state-disabled";
      elDisabled.textContent = elDay.textContent;
      elDay.replaceWith(elDisabled);
    }
  }

  /** Why the page is empty, in the same words the row carried - with the clinic's phones and *2700. */
  function addNote() {
    const elTitle = document.querySelector(CLINIC_TITLE_SELECTOR);
    if (!branch || !elTitle || elTitle.querySelector("[data-clalit-city-note]")) {
      return;
    }

    elTitle.appendChild(
      buildHotlineNote({
        ownerDocument: document,
        text: NO_SERVICE_ROW_NOTE
      })
    );
  }

  function apply() {
    if (!branch) {
      return;
    }

    retitle();
    emptyTheDiary();
    dropLenderFilters();
    resetToThisMonth();
    disableDays();
    addNote();
    // The click left the site's loader up while the iframe navigated (that is the site's own pattern);
    // this page is the destination, so it comes down here.
    setSiteLoader(false);
  }

  /** The datepicker re-renders on every month change, so each new month is disabled the same way. */
  function watchDatepicker() {
    const elDatepicker = document.querySelector(DATEPICKER_SELECTOR);
    if (!elDatepicker) {
      return;
    }

    new MutationObserver(() => disableDays()).observe(elDatepicker, {
      childList: true,
      subtree: true
    });
  }

  return {
    isTailored: branch !== undefined,
    apply,
    watchDatepicker
  };
}
