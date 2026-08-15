/**
 * The city guarantee for the Clalit Smile clinic search, whose results arrive as a SERVER-RENDERED
 * HTML fragment inside a JSON envelope (shape captured in targets.ts). The interceptor rewrites the
 * outgoing search to all-country, and these transforms then keep ONLY the searched city's rows in each
 * response - order preserved, so the site's chosen sort is respected - while the interceptor aggregates
 * the remaining server pages into the same list (see clalit-interceptor.content.ts).
 *
 * Runs in the page's MAIN world, so DOMParser is available. Pure string→string: nothing here touches
 * the live document.
 */

import type { SmileBranch } from "./clinic-directory";
import { smileEnvelopeSchema, smileEnvelopeStatusSchema } from "./schemas";

/** The envelope's `errorType` values, from the site's own `z.ErrorType` (docs 12a). */
export const SMILE_ENVELOPE_STATUS = {
  success: 0,
  information: 1,
  authorization: 2,
  application: 3
} as const;

/** The status of a /Zimunet/SmileClinic/* envelope, or null when it carries none. */
export function envelopeStatus(json: unknown) {
  const parsed = smileEnvelopeStatusSchema.safeParse(json);
  return parsed.success ? parsed.data.errorType : null;
}

/** The results fragment out of a /Zimunet/SmileClinic/* envelope, or null if this isn't one. */
export function getSmileHtml(json: unknown) {
  const parsed = smileEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }

  const { data } = parsed.data;
  return data.includes("diary") ? data : null;
}

const ADDRESS_PREFIX = "כתובת:";
/** The site's own soonest-slot line ("מועד התור הפנוי הקרוב ביותר: …") - matched, never re-authored. */
const SOONEST_SLOT_PREFIX = "מועד התור";
/** The site's own inline-link class - the underline an anchor gets when it is meant to look like one. */
const SITE_UNDERLINE_CLASS = "underline";

/**
 * A row's city = the last comma-segment of its "כתובת: …" line (some addresses are city-only). The
 * site already renders the clinic's canonical city here - the exact same string its city autocomplete
 * produces for the search box - so it compares 1:1 against the searched city with no normalization.
 */
export function rowCityName(elRow: Element) {
  const address =
    [...elRow.querySelectorAll(".clinicDetails")]
      .map(elDetail => elDetail.textContent?.trim() ?? "")
      .find(text => text.startsWith(ADDRESS_PREFIX))
      ?.slice(ADDRESS_PREFIX.length) ?? "";
  return address.split(",").pop()?.trim() ?? "";
}

/** Clinic display name - the stable identity for dedup (diary GUIDs change per search session). */
export function rowClinicName(elRow: Element) {
  return elRow.querySelector("a.clinicDetails")?.textContent?.trim() ?? "";
}

/**
 * Exact match against the site's OWN canonical city. `searchedCity` is `SelectedCityName` - the value
 * Clalit's autocomplete committed when the user picked a city in the search box - and `rowCity` is the
 * same canonical string the server rendered into the row, so equality is authoritative. No fuzzy
 * normalization: the site is the single source of truth for what a city is called.
 */
export function cityMatches({ rowCity, searchedCity }: {
  rowCity: string;
  searchedCity: string;
}) {
  return rowCity.trim() !== "" && rowCity.trim() === searchedCity.trim();
}

const NAV_CODE_PATTERN = /\/nav\/(\d+)/;

/** The clinic's nearme code from the row's "הצגת מפה" link - the key into CLINIC_COORDS. */
export function rowNavCode(elRow: Element) {
  const href = elRow.querySelector("a.mapLocationLink")?.getAttribute("href") ?? "";
  return NAV_CODE_PATTERN.exec(href)?.[1] ?? "";
}

/** What the distance sort really means under the guarantee: distance from the user's LIVE location. */
export const LIVE_DISTANCE_SORT_LABEL = "מרחק ממיקומך";

/** Rewrite a live row's server-computed "מרחק מהבית שלך" line with the live-location distance. */
export function setRowDistanceLabel({ elRow, km }: {
  elRow: Element;
  km: number;
}) {
  const text = `${LIVE_DISTANCE_SORT_LABEL}: ${km.toFixed(2)} ק"מ`;
  const elLabel = [...elRow.querySelectorAll(".clinicDetails")].find(elDetail => elDetail.textContent?.includes("מרחק"));
  if (elLabel) {
    elLabel.textContent = text;
    return;
  }

  // Synthetic branch rows have no server distance line - add one.
  const elContainer = elRow.querySelector(".pull-right");
  if (elContainer) {
    const elLine = elContainer.ownerDocument.createElement("div");
    elLine.className = "clinicDetails";
    elLine.textContent = text;
    elContainer.appendChild(elLine);
  }
}

// ── Synthetic branch rows (city completeness beyond Tamuz) ─────────────────────

/** Marks rows the extension added from the branch directory (no bookable diary in Tamuz). */
export const SYNTHETIC_ROW_ATTR = "data-clalit-city-synthetic";

/** Marks "מידע נוסף" anchors that open the composed clinic-details lightbox (value = branch code). */
export const DETAILS_CODE_ATTR = "data-clalit-city-details-code";

/**
 * Marks a synthetic row's "לכל התורים" button (value = branch code). The row has no diary GUID - one
 * only exists inside the server session's LAST search - so the interceptor's click handler mints a
 * fresh GUID on demand (a specialization sweep of new searches) and navigates to it (docs §6c).
 */
export const MINT_CODE_ATTR = "data-clalit-city-mint-code";

const CLINIC_DETAILS_BY_VISIT = "/Zimunet/ClinicDoctor/ClinicDetailsByVisit/";
const NEARME_NAV = "https://nearme.clalit.co.il/nav/";

/** Clalit's own page for a clinic - the row's map link, and the last-resort target of "מידע נוסף". */
export function nearmeHref(code: string) {
  return `${NEARME_NAV}${code}`;
}

const CENTRAL_BOOKING_PHONE = "*2700";

/** Marks every note the extension adds (row, lightbox, loader) so a second one replaces it, never stacks. */
export const NOTE_ATTR = "data-clalit-city-note";

const CALL_INSTEAD = "ניתן להתקשר למרפאה או למוקד";

/** On a synthetic row: this search's service has no online diary for the branch. */
export const NO_DIARY_ROW_NOTE = `אין יומן מקוון לשירות זה - ${CALL_INSTEAD}`;

/** After a click-time check found no diary for the SEARCHED service - on the row and in its lightbox. */
export const NO_DIARY_SWEEP_NOTE = `בדקנו עכשיו ואין יומן מקוון לשירות שביקשתם בסניף זה - ${CALL_INSTEAD}`;

/** On the loader once the check hits: the iframe is about to navigate to the branch's slots page. */
export const MINT_NAVIGATE_NOTE = "נמצא יומן - פותחים את התורים";

/** On the loader while the branch's own appointments page (a borrowed shell) is opening. */
export const BRANCH_PAGE_NOTE = "פותחים את דף התורים של הסניף";

/** On a row nothing can be booked at in the searched service - the only claim this row ever makes. */
export const NO_SERVICE_ROW_NOTE = `אין כרגע יומן מקוון לשירות שביקשתם בסניף זה - ${CALL_INSTEAD}`;

/** In the site's own message box, after a click found no page to open for the branch. */
const NO_ONLINE_DIARY_MESSAGE =
  "בדקנו עכשיו ואין יומן מקוון לשירות שביקשתם בסניף זה, ולכן אין דף תורים לפתוח.";
const CALL_TO_BOOK = "לקביעת תור:";
const OR_CENTRAL_LINE = "או במוקד";

/** On the loader while the click re-asks the SEARCHED service whether a diary has opened since. */
export const MINT_CHECK_NOTE = "בודקים אם נפתח יומן מקוון לשירות שביקשתם בסניף";

/**
 * On the loader while the city's list is being completed. The site's own search is answered by its first
 * page; everything that makes the answer WHOLE - the rest of the server's pages, the branches it omits,
 * the distances - runs after that, and a list that grows under the user's eyes with nothing to explain
 * it reads as a page that has not finished loading.
 */
export function completingListNote({ page, total }: {
  page: number;
  total: number;
}) {
  return `משלימים את רשימת המרפאות בעיר - עמוד ${page} מתוך ${total}`;
}

/** On the loader while the appended branches' bookability is settled, before any row is inserted. */
export const CHECKING_BRANCHES_NOTE = "בודקים אילו סניפים בעיר ניתן לזמן";

/** Retext a row's note in place, keeping the *2700 hotline link the note was built with. */
export function setRowNote({ elRow, text }: {
  elRow: Element;
  text: string;
}) {
  const elNote = elRow.querySelector(`[${NOTE_ATTR}]`);
  if (!elNote) {
    return;
  }

  const elHotline = elNote.querySelector("a");
  elNote.textContent = `${text} `;

  if (elHotline) {
    elNote.appendChild(elHotline);
  }
}

/**
 * The site paints every row button in its own teal; a branch nothing can open right now gets a red one
 * instead, so the list says "not bookable" before the click rather than after it. Inline styles, because
 * the MAIN world must not add stylesheets to a page it does not own - and the site has no red variant.
 */
const UNAVAILABLE_BUTTON_STYLE = {
  // Every site button IS an 86x24 slice of css/images/wideButton.png - the rounded corners and the
  // vertical gradient are pixels, not CSS (border-radius computes to 0). So a colour alone renders
  // underneath the image and changes nothing, and dropping the image alone squares the button off next
  // to "מידע נוסף". This repaints the same shape in red: the sprite's own 3px corners and its
  // top-to-bottom darkening, both sampled from the PNG itself - its alpha corner is a quarter circle of
  // radius 5, its face runs rgb(3,102,176) → rgb(1,86,149).
  backgroundImage: "linear-gradient(to bottom, #c22a21, #9e211a)",
  backgroundColor: "#b3261e",
  borderRadius: "5px",
  color: "#ffffff"
};

/** What a red button promises when hovered - the same sentence the row's note carries. */
export const UNAVAILABLE_BUTTON_TITLE = "אין כרגע תור מקוון לשירות שביקשתם בסניף זה";

/** Tint (or clear) a synthetic row's "לכל התורים" button by whether anything can be opened for it. */
export function setRowBookable({ elRow, isBookable, title }: {
  elRow: Element;
  isBookable: boolean;
  /** The button's hover text while it is red - back to the site's own when it is bookable again. */
  title: string;
}) {
  const elButton = elRow.querySelector<HTMLElement>(`[${MINT_CODE_ATTR}]`);
  if (!elButton) {
    return;
  }

  for (const [property, value] of Object.entries(UNAVAILABLE_BUTTON_STYLE)) {
    elButton.style.setProperty(toCssProperty(property), isBookable ? "" : value);
  }

  elButton.setAttribute("title", isBookable ? elButton.textContent?.trim() ?? title : title);
}

function toCssProperty(camelCase: string) {
  return camelCase.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

/**
 * Directory phones come without the leading 0 ("36316561") - render like the site ("03-6316561").
 * A parenthesized IVR hint like "077-8012222 (1)" stays visible but its digit is never dialed.
 */
export function formatPhone(raw: string) {
  const hintStart = raw.indexOf("(");
  const digits = (hintStart === -1 ? raw : raw.slice(0, hintStart)).replace(/\D/g, "");
  if (!digits) {
    return null;
  }

  const withZero = digits.startsWith("0") ? digits : `0${digits}`;
  const areaLength = withZero.startsWith("05") || withZero.startsWith("07") ? 3 : 2;
  const display = `${withZero.slice(0, areaLength)}-${withZero.slice(areaLength)}`;
  const hint = hintStart === -1 ? "" : raw.slice(hintStart).trim();
  return {
    dial: withZero,
    display: hint ? `${display} ${hint}` : display
  };
}

/**
 * Render directory phones as tel: links into a telephone slot (the row, the lightbox and the message
 * box share this).
 *
 * A number in a ROW is text, not an offer: the server prints its own as plain `<span>`s in the row's
 * colour, so a blue underlined link there is the one thing on an appended row that shouts "added". The
 * link stays - for these branches the phone IS the booking route - it just stops announcing itself,
 * taking the row's own colour by inheritance rather than a colour of ours. It does announce itself while
 * you are ON it: the browser already turns the cursor into a pointer there, and an underline for exactly
 * that moment answers it instead of leaving the cursor as an unexplained hint (Avi, 2026-08-15). Where
 * the number IS the offer (the site's message box: "call the clinic or *2700"), it is styled as the
 * link it is.
 */
function appendPhoneLinks({ elContainer, phones, isCallToAction = false }: {
  elContainer: Element;
  phones: string[];
  isCallToAction?: boolean;
}) {
  const { ownerDocument } = elContainer;
  elContainer.textContent = "";
  for (const phone of phones) {
    const formatted = formatPhone(phone);
    if (!formatted) {
      continue;
    }

    const elLink = ownerDocument.createElement("a");
    if (isCallToAction) {
      // The site's own inline-link class (anchors already inherit its color; this adds the underline).
      elLink.className = SITE_UNDERLINE_CLASS;
    } else {
      elLink.style.color = "inherit";
      // Put on and taken off again: the row stays the server's until the pointer (or the keyboard) is on
      // the number, which is when the underline is the answer rather than noise. Inline rather than the
      // site's own class, because `a, a:visited, a:hover { text-decoration: none }` is live in this
      // document and the class loses to it - only an inline rule reliably wins.
      for (const [enter, leave] of [["mouseenter", "mouseleave"], ["focus", "blur"]] as const) {
        elLink.addEventListener(enter, () => elLink.style.setProperty("text-decoration", "underline"));
        elLink.addEventListener(leave, () => elLink.style.removeProperty("text-decoration"));
      }
    }

    elLink.setAttribute("href", `tel:${formatted.dial}`);
    // dir=ltr keeps digits and a "(1)" hint in reading order inside the RTL layout.
    elLink.setAttribute("dir", "ltr");
    elLink.textContent = `${formatted.display} `;
    elContainer.appendChild(elLink);
  }
}

/** The "no online diary" note, in the site's own row/details text style, ending in the *2700 hotline. */
export function buildHotlineNote({ ownerDocument, text }: {
  ownerDocument: Document;
  text: string;
}) {
  const elNote = ownerDocument.createElement("div");
  elNote.className = "clinicDetails";
  elNote.setAttribute(NOTE_ATTR, "1");
  elNote.textContent = `${text} `;
  const elHotline = ownerDocument.createElement("a");
  elHotline.className = "underline";
  elHotline.setAttribute("href", `tel:${CENTRAL_BOOKING_PHONE}`);
  // dir=ltr keeps "*2700" from flipping to "2700*" inside the RTL note.
  elHotline.setAttribute("dir", "ltr");
  elHotline.textContent = CENTRAL_BOOKING_PHONE;
  elNote.appendChild(elHotline);
  return elNote;
}

/**
 * What the site's own message box says when the click found nothing to open: the clinic, the reason and
 * the two ways to book it by phone. Built from the branch directory, in the site's own message markup.
 */
export function buildUnavailableMessageHtml(branch: SmileBranch) {
  const elMessage = document.createElement("div");
  const elTitle = document.createElement("h2");
  elTitle.textContent = branch.title;
  elMessage.appendChild(elTitle);

  const elReason = document.createElement("p");
  elReason.textContent = NO_ONLINE_DIARY_MESSAGE;
  elMessage.appendChild(elReason);

  const elPhones = document.createElement("p");
  elPhones.appendChild(document.createTextNode(`${CALL_TO_BOOK} `));
  // appendPhoneLinks empties whatever it is given, so the numbers get a slot of their own.
  const elNumbers = document.createElement("span");
  appendPhoneLinks({
    elContainer: elNumbers,
    phones: branch.phones,
    isCallToAction: true
  });
  elPhones.appendChild(elNumbers);
  // A leading NBSP: the tel: link's own trailing space collapses at the element boundary, so without it
  // the number and the next word render glued together ("03-5235676או במוקד").
  elPhones.appendChild(document.createTextNode(` ${OR_CENTRAL_LINE} `));
  const elHotline = document.createElement("a");
  elHotline.className = "underline";
  elHotline.setAttribute("href", `tel:${CENTRAL_BOOKING_PHONE}`);
  elHotline.setAttribute("dir", "ltr");
  elHotline.textContent = CENTRAL_BOOKING_PHONE;
  elPhones.appendChild(elHotline);
  elMessage.appendChild(elPhones);

  return elMessage.innerHTML;
}

/**
 * Fill the row's soonest-slot line, or remove it. The LABEL is the lender row's own - the site decides
 * how that line reads - and the date is always the SEARCHED service's, so it needs no qualifier: a row
 * that cannot be booked for what the user asked for shows no date at all.
 */
function setSoonestSlotLine({ elLine, soonestSlotDate }: {
  elLine: Element;
  soonestSlotDate: string | null;
}) {
  if (!soonestSlotDate) {
    elLine.remove();
    return;
  }

  const [label] = (elLine.textContent ?? "").split(":");
  elLine.textContent = `${label.trim()}: ${soonestSlotDate}`;
}

export interface BranchRowInput {
  /** A cloned REAL server row (li.diary) to repurpose - never markup we authored. */
  elRow: Element;
  branch: SmileBranch;
  /** A past visit at this branch → the site's native clinic-details lightbox; null → nearme page. */
  detailsVisitGuid: string | null;
  /** Live distance to the branch, so the row carries the same distance line every server row carries. */
  distanceKm: number | null;
  /**
   * What the availability probe already knows about this branch (docs §12h). The row is BUILT in that
   * state - a red button and its reason are part of the markup that gets inserted, never a repaint a
   * frame later. `null` = not asked yet, which for a row the search omitted means "not bookable yet".
   */
  isBookable: boolean | null;
  /**
   * The soonest slot for this branch IN THE SEARCHED SERVICE - the only date this row may carry. A
   * branch with a diary in some other service is not this row's business: the page such a date belongs
   * to books a different appointment than the one the user came here for.
   */
  soonestSlotDate: string | null;
  /**
   * This branch's slots page as the sweep's own row carried it, when the sweep found one. It belongs to
   * the search the session still holds, so the button can just be the site's own link and the click
   * costs nothing; `null` leaves the button to click-time minting.
   */
  slotsLink: string | null;
}

/**
 * Turn a CLONED server row into a synthetic branch row (a branch the search has no diary for). We edit
 * the site's own element structure rather than build markup: rewrite clinic name / address / phones /
 * map, fill or drop the slot date, drop the booking button when there is nothing to book, point
 * "מידע נוסף" at the site's native clinic-details lightbox when the user has a visit here
 * (ClinicDetailsByVisit) or the official nearme page otherwise, and make the phone a tel: link.
 */
export function applyBranchToRow({
  elRow,
  branch,
  detailsVisitGuid,
  isBookable,
  distanceKm,
  soonestSlotDate,
  slotsLink
}: BranchRowInput) {
  const { code, title, street, city, phones } = branch;
  elRow.setAttribute(SYNTHETIC_ROW_ATTR, "1");
  const detailsHref = detailsVisitGuid ? `${CLINIC_DETAILS_BY_VISIT}${detailsVisitGuid}` : null;
  const nearme = nearmeHref(code);

  // Both the clinic-name link and the "מידע נוסף" button are a.clinicDetails. With a past visit here,
  // keep them native (site's delegated handler fetches ClinicDetailsByVisit → lightbox); otherwise turn
  // them into a plain nearme link so the site never tries to Ajax-fetch a cross-origin href.
  for (const elAnchor of elRow.querySelectorAll("a.clinicDetails")) {
    const isMoreInfoButton = elAnchor.classList.contains("pull-left");
    elAnchor.textContent = isMoreInfoButton ? "מידע נוסף" : title;
    elAnchor.setAttribute("title", isMoreInfoButton ? "מידע נוסף" : title);

    if (detailsHref) {
      elAnchor.setAttribute("data-action-link", detailsHref);
    } else {
      // No GUID exists for this branch, so the site's own Ajax handler must not fire (it would choke on
      // a cross-origin href). The interceptor's delegated click handler opens the composed lightbox via
      // DETAILS_CODE_ATTR instead; the nearme href stays as the new-tab/middle-click/failure fallback.
      elAnchor.classList.remove("clinicDetails");
      elAnchor.removeAttribute("data-action-link");
      elAnchor.setAttribute("href", nearme);
      elAnchor.setAttribute("target", "_blank");
      elAnchor.setAttribute("rel", "noopener");
      elAnchor.setAttribute(DETAILS_CODE_ATTR, code);
    }
  }

  // Address, and drop lines that only make sense for a real diary (soonest-slot date, server distance).
  const address = street ? `${street}, ${city}` : city;
  for (const elDetail of elRow.querySelectorAll(".clinicDetails")) {
    const text = elDetail.textContent?.trim() ?? "";
    if (text.startsWith(ADDRESS_PREFIX)) {
      elDetail.textContent = `${ADDRESS_PREFIX} ${address}`;
    } else if (text.startsWith(SOONEST_SLOT_PREFIX)) {
      // The site's own label, kept verbatim and told which service the date belongs to. With no date to
      // put there the line goes, rather than standing with the lender row's own.
      setSoonestSlotLine({
        elLine: elDetail,
        soonestSlotDate
      });
    } else if (text.includes("מרחק") && distanceKm === null) {
      // A distance line we cannot fill would leave the lender row's own number standing.
      elDetail.remove();
    }
  }

  // Phones as tel: links, reusing the row's own telephone slot.
  const elTelephone = elRow.querySelector(".clinicTelephone");
  if (elTelephone) {
    appendPhoneLinks({
      elContainer: elTelephone,
      phones
    });
  }

  // The sweep that settled this branch's verdict also came back with the link its row carried, so a
  // bookable branch gets a NORMAL "לכל התורים": the site's own delegated handler opens it, with no
  // round trip of ours between the click and the page. Without a link there is nothing to point at -
  // strip data-action-link (that attribute is what fires the site's handler) and mark the button for
  // the interceptor's click-time minting instead.
  const elDiaryButton = elRow.querySelector("#CreateVisitButton, a.diaryButton");
  if (elDiaryButton && slotsLink) {
    elDiaryButton.setAttribute("data-action-link", slotsLink);
    elDiaryButton.removeAttribute(MINT_CODE_ATTR);
  } else if (elDiaryButton) {
    elDiaryButton.removeAttribute("data-action-link");
    elDiaryButton.setAttribute(MINT_CODE_ATTR, code);
  }

  // Repoint the map link at this branch. The row carries no note of ours: it has to read like a row the
  // server rendered, so the reason for a red button lives on the button's own title and behind
  // "מידע נוסף" instead (Avi, 2026-08-15).
  elRow.querySelector("a.mapLocationLink")?.setAttribute("href", nearme);

  if (distanceKm !== null) {
    setRowDistanceLabel({
      elRow,
      km: distanceKm
    });
  }

  // Red is a claim - "no Smile service lists this branch". Only the probe can make it; an unsettled row
  // keeps the site's own button and says the milder thing its note already says.
  setRowBookable({
    elRow,
    isBookable: isBookable !== false,
    title: UNAVAILABLE_BUTTON_TITLE
  });
}

/**
 * Put the reason INSIDE the clinic-details lightbox - the row's own note is hidden behind the dialog
 * while it is open, and after a failed minting sweep that dialog IS the answer to "לכל התורים". Works
 * on the site's native ClinicDetailsByVisit view and on our composed fragment alike: both are the same
 * container (targets.ts SMILE_DETAILS_DIALOG_SELECTOR).
 */
export function setDialogNote({ elDialog, text }: {
  elDialog: Element;
  text: string;
}) {
  for (const elStale of elDialog.querySelectorAll(`[${NOTE_ATTR}]`)) {
    elStale.remove();
  }

  const { ownerDocument } = elDialog;
  const elNoteHost = elDialog.querySelector(".css_NoPaddingCell.clinicDetails") ?? elDialog.querySelector("div.content") ?? elDialog;
  elNoteHost.prepend(
    buildHotlineNote({
      ownerDocument,
      text
    })
  );
}

// The loader is a full-screen fixed flex box holding ONLY the animation, so the caption is absolutely
// positioned under it - the site's own element and layout stay untouched, and hiding the loader removes
// the whole div, caption included.
const LOADER_NOTE_STYLE = {
  position: "absolute",
  top: "50%",
  left: "0",
  right: "0",
  margin: "85px auto 0",
  width: "fit-content",
  maxWidth: "80%",
  padding: "10px 20px",
  borderRadius: "999px",
  background: "#fff",
  boxShadow: "0 2px 10px rgba(6, 28, 63, 0.15)",
  fontSize: "17px",
  textAlign: "center",
  direction: "rtl"
};

/** Caption the site's own loader so the sweep's multi-second wait says what it is doing. */
export function setLoaderNote({ elLoader, text }: {
  elLoader: Element;
  text: string;
}) {
  const elExisting = elLoader.querySelector<HTMLElement>(`[${NOTE_ATTR}]`);
  if (elExisting) {
    elExisting.textContent = text;
    return;
  }

  const elNote = elLoader.ownerDocument.createElement("div");
  elNote.setAttribute(NOTE_ATTR, "1");
  Object.assign(elNote.style, LOADER_NOTE_STYLE);
  elNote.textContent = text;
  elLoader.appendChild(elNote);
}

// ── Composed clinic-details lightbox (branches with no GUID of any kind) ───────

const RECEPTION_DAY_LETTERS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

function formatMinutes(total: number) {
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Rewrite a `<span class="title">label</span> value` line's value, keeping the label span. */
function setLabeledLine({ elLine, elValue }: {
  elLine: Element;
  elValue: string;
}) {
  const elLabel = elLine.querySelector("span.title");
  if (!elLabel) {
    return;
  }

  elLine.textContent = "";
  elLine.appendChild(elLabel);
  elLine.appendChild(elLine.ownerDocument.createTextNode(` ${elValue}`));
}

/** The accessibility list: the directory's labels, or drop the line when the branch has none. */
function applyAccessibilityLine({ elLine, labels }: {
  elLine: Element;
  labels: string[];
}) {
  const elItems = [...elLine.children].find(child => !child.classList.contains("clinicAccessibilty"));
  if (labels.length === 0 || !elItems) {
    elLine.remove();
    return;
  }

  const { ownerDocument } = elLine;
  elItems.textContent = "";
  for (const elLabel of labels) {
    const elItem = ownerDocument.createElement("div");
    elItem.textContent = elLabel;
    elItems.appendChild(elItem);
  }
}

/** Lines we cannot source honestly for a branch the server never described. */
const UNSOURCED_DETAIL_LINE = /פקס:|אוטובוסים:|הערות:/;

/** One `<div>` line of the details cell, rewritten for the branch (or removed). */
function applyBranchToDetailLine({ elLine, branch }: {
  elLine: Element;
  branch: SmileBranch;
}) {
  const { street, city, phones, accessibility } = branch;
  const text = elLine.textContent ?? "";
  if (text.includes("כתובת:")) {
    setLabeledLine({
      elLine,
      elValue: street ? `${street}, ${city}` : city
    });
    return;
  }

  if (text.includes("טלפון:")) {
    const elTelephone = elLine.querySelector(".clinicTelephone");
    if (elTelephone) {
      appendPhoneLinks({
        elContainer: elTelephone,
        phones
      });
    }

    return;
  }

  if (elLine.querySelector(".clinicAccessibilty")) {
    applyAccessibilityLine({
      elLine,
      labels: accessibility
    });
    return;
  }

  if (UNSOURCED_DETAIL_LINE.test(text) || elLine.classList.contains("divClinicRemarksList")) {
    elLine.remove();
  }
}

/** Rebuild the reception-hours table from the directory's [day, start, end] triples. */
function rebuildHoursTable({ elTable, hours }: {
  elTable: Element;
  hours: SmileBranch["hours"];
}) {
  const { ownerDocument } = elTable;
  const byDay = new Map(hours.map(([day, start, end]) => [
    day,
    `מ ${formatMinutes(start)} עד ${formatMinutes(end)}`
  ]));
  elTable.textContent = "";
  for (const [day, letter] of RECEPTION_DAY_LETTERS.entries()) {
    const elSeparatorRow = ownerDocument.createElement("tr");
    const elSeparatorCell = ownerDocument.createElement("td");
    elSeparatorCell.setAttribute("colspan", "2");
    elSeparatorCell.className = "separator";
    elSeparatorRow.appendChild(elSeparatorCell);
    elTable.appendChild(elSeparatorRow);

    const elRow = ownerDocument.createElement("tr");
    const elHeader = ownerDocument.createElement("td");
    elHeader.className = "header";
    elHeader.textContent = letter;
    const elValue = ownerDocument.createElement("td");
    elValue.textContent = byDay.get(day) ?? "";
    // The site's empty remark div is load-bearing: its 210px width is what holds the value column
    // open (the CSS gives td.header width:100%, which otherwise crushes the hours to a word a line).
    const elRemark = ownerDocument.createElement("div");
    elRemark.className = "clinicDetailsReceptionRemark";
    elRemark.setAttribute("title", "");
    elValue.appendChild(elRemark);
    elRow.appendChild(elHeader);
    elRow.appendChild(elValue);
    elTable.appendChild(elRow);
  }
}

/** The ClinicDetailsByDiary action link of a real server row's HTML - the details-template source. */
export function detailsLinkFromRowHtml(html: string) {
  if (!html) {
    return null;
  }

  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  return parsedDocument.querySelector("a[data-action-link*=\"ClinicDetailsByDiary\"]")?.getAttribute("data-action-link") ?? null;
}

/**
 * A REAL row's slots-page link, which is the shell a branch with no diary of its own borrows: the site's
 * own appointments page, retitled to that branch and emptied of the other clinic's availability
 * (smile-clinic-page.ts). Like every GUID here it belongs to the session's LAST search.
 */
export function slotsLinkFromRowHtml(html: string) {
  if (!html) {
    return null;
  }

  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  return parsedDocument.querySelector(SLOTS_LINK_SELECTOR)?.getAttribute("data-action-link") ?? null;
}

/**
 * Compose the clinic-details lightbox fragment for a branch with no GUID: take a REAL clinic's
 * fragment (fetched via ClinicDetailsByDiary on a current-search row) as the template - the site's own
 * markup - and rewrite name / map / address / phones from the directory, rebuild the hours table and
 * accessibility list from the same public dataset the site uses, and drop the lines we cannot source
 * honestly (fax, buses, notes, per-clinic remarks). Returns null when the template isn't a details
 * fragment (e.g. a stale-GUID empty envelope).
 */
export function applyBranchToDetailsFragment({ template, branch }: {
  template: string;
  branch: SmileBranch;
}) {
  const parsedDocument = new DOMParser().parseFromString(template, "text/html");
  if (!parsedDocument.querySelector(".css_Table")) {
    return null;
  }

  const { title, code, hours } = branch;
  const elNameLabel = [...parsedDocument.querySelectorAll(".css_Cell span.title")].find(span => span.textContent?.includes("מרפאה"));
  if (elNameLabel?.parentElement) {
    setLabeledLine({
      elLine: elNameLabel.parentElement,
      elValue: title
    });
  }

  parsedDocument.querySelector("a.mapLocationLink")?.setAttribute("href", `${NEARME_NAV}${code}`);

  for (const elLine of parsedDocument.querySelector(".css_NoPaddingCell.clinicDetails")?.querySelectorAll(":scope > div") ?? []) {
    applyBranchToDetailLine({
      elLine,
      branch
    });
  }

  const elHoursTable = parsedDocument.querySelector("#receptionHours");
  if (!elHoursTable) {
    return parsedDocument.body.innerHTML;
  }

  if (hours.length === 0) {
    parsedDocument.querySelector(".receptionHoursHeader")?.remove();
    elHoursTable.remove();
    return parsedDocument.body.innerHTML;
  }

  rebuildHoursTable({
    elTable: elHoursTable,
    hours
  });
  return parsedDocument.body.innerHTML;
}

/** Replace an element's text while keeping child elements (the sort links carry an icon <i>). */
function replaceTextNode({ elTarget, text }: {
  elTarget: Element;
  text: string;
}) {
  for (const node of elTarget.childNodes) {
    if (node.nodeType === 3 && node.textContent?.trim()) {
      node.textContent = text;
      return;
    }
  }
}

/** Rewrite the "נמצאו N" count in a results header (the aggregator bumps it as pages stream in). */
export function setHeaderCount({ elHeader, count }: {
  elHeader: Element;
  count: number;
}) {
  elHeader.textContent = (elHeader.textContent ?? "").replace(/נמצאו\s+\d+/, `נמצאו ${count}`);
}

function readDeclaredTotal(parsedDocument: Document) {
  const match = parsedDocument.querySelector("h2")?.textContent?.match(/נמצאו\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

export interface SmileFilterOutcome {
  isChanged: boolean;
  json: unknown;
  /** N from the "נמצאו N תוצאות" header - the size of the server's full (all-country) result set. */
  totalDeclared: number;
  /** Rows this page carried before filtering - the server's page size. */
  pageRowCount: number;
  keptRowCount: number;
  /** outerHTML of a real server row (pre-filter), so synthetic branch rows clone the site's own markup. */
  templateRowHtml: string;
}

/** Attribute the aggregator uses to recognize OUR render of the list in the live document. */
export const SMILE_MARKER_ATTR = "data-clalit-city-marker";

/**
 * Filter one results envelope to the searched city. Also removes the pager (the aggregator flattens
 * every server page into this one list) and the "מרחק מהיישוב שחיפשת" sort - a distance sort must
 * reference the USER's location, and the remaining "מרחק מהבית שלך" is exactly that.
 */
export function filterSmileEnvelope(
  { json, searchedCity, marker }: {
    json: unknown;
    searchedCity: string;
    marker?: string;
  }
) {
  const untouched: SmileFilterOutcome = {
    isChanged: false,
    json,
    totalDeclared: 0,
    pageRowCount: 0,
    keptRowCount: 0,
    templateRowHtml: ""
  };
  const html = getSmileHtml(json);
  if (!html || !searchedCity.trim()) {
    return untouched;
  }

  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  const elRows = [...parsedDocument.querySelectorAll("li.diary")];
  const templateRowHtml = elRows[0]?.outerHTML ?? "";
  const totalDeclared = readDeclaredTotal(parsedDocument);
  let keptRowCount = 0;
  for (const elRow of elRows) {
    if (cityMatches({
      rowCity: rowCityName(elRow),
      searchedCity
    })) {
      keptRowCount += 1;
    } else {
      elRow.remove();
    }
  }

  for (const pager of parsedDocument.querySelectorAll("#pager")) {
    pager.remove();
  }

  parsedDocument.querySelector("a[data-action-link*=\"sortValue=4\"]")?.closest("h3")?.remove();

  // The remaining distance sort is hijacked to rank by the user's live location, so label it truthfully.
  const elHomeSortLink = parsedDocument.querySelector("a[data-action-link*=\"sortValue=3\"]");
  if (elHomeSortLink) {
    replaceTextNode({
      elTarget: elHomeSortLink,
      text: LIVE_DISTANCE_SORT_LABEL
    });
    elHomeSortLink.setAttribute("title", LIVE_DISTANCE_SORT_LABEL);
  }

  const elHeader = parsedDocument.querySelector("h2");
  if (elHeader?.textContent) {
    elHeader.textContent = elHeader.textContent.replace(/באזור:.*$/, `בעיר: ${searchedCity.trim()}`);
    setHeaderCount({
      elHeader,
      count: keptRowCount
    });
  }

  if (marker) {
    parsedDocument.querySelector("#am_diaries")?.setAttribute(SMILE_MARKER_ATTR, marker);
  }

  const parsed = smileEnvelopeSchema.safeParse(json);
  const envelope = {
    ...(parsed.success ? parsed.data : {}),
    data: parsedDocument.body.innerHTML
  };
  return {
    isChanged: true,
    json: envelope,
    totalDeclared,
    pageRowCount: elRows.length,
    keptRowCount,
    templateRowHtml
  };
}

// ── Click-time GUID minting (synthetic rows' "לכל התורים") ─────────────────────

/** Where a diary GUID becomes a page: the slots page every real row's "לכל התורים" points at. */
export const SMILE_SLOTS_PATH = "/AvailableVisit/Smile/";

const SLOTS_LINK_SELECTOR = `a[data-action-link*="${SMILE_SLOTS_PATH}"]`;
const DETAILS_LINK_SELECTOR = "a[data-action-link*=\"ClinicDetailsByDiary\"]";

export interface SmileEnvelopeScan {
  /** The branch's fresh "לכל התורים" link (slots page, /AvailableVisit/Smile/{guid}) - null if absent. */
  actionLink: string | null;
  totalDeclared: number;
  pageRowCount: number;
  /** A real row of THIS search - its ClinicDetailsByDiary GUID is current while the search is last. */
  firstRowHtml: string;
}

/** Scan one results envelope for a branch (by nav code) and its fresh slots link. */
export function scanEnvelopeForNavCode({ json, navCode }: {
  json: unknown;
  /** Omit to read only the page metadata (totals + template row). */
  navCode?: string;
}) {
  const html = getSmileHtml(json);
  if (!html) {
    return {
      actionLink: null,
      totalDeclared: 0,
      pageRowCount: 0,
      firstRowHtml: ""
    };
  }

  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  const elRows = [...parsedDocument.querySelectorAll("li.diary")];
  const match = navCode ? elRows.find(elRow => rowNavCode(elRow) === navCode) : undefined;
  return {
    actionLink: match?.querySelector(SLOTS_LINK_SELECTOR)?.getAttribute("data-action-link") ?? null,
    totalDeclared: readDeclaredTotal(parsedDocument),
    pageRowCount: elRows.length,
    firstRowHtml: elRows[0]?.outerHTML ?? ""
  };
}

/** The date a row prints on the site's own soonest-slot line, or "" when it carries none. */
export function rowSoonestSlot(elRow: Element) {
  const elLine = [...elRow.querySelectorAll(".clinicDetails")]
    .find(elDetail => elDetail.textContent?.trim().startsWith(SOONEST_SLOT_PREFIX));
  return elLine?.textContent?.split(":").slice(1).join(":").trim() ?? "";
}

/** What one search's own row says about a branch: when it can be booked, and the page that books it. */
export interface ListedBranchRow {
  /** The soonest slot the row printed, or "" when it printed none. */
  soonest: string;
  /** That row's slots page, GUID and all - valid exactly as long as this search is the session's. */
  slotsLink: string | null;
}

/**
 * Which of these branches one results envelope lists, what each one's row said, and the link it
 * carried - the batch question the single scan cannot answer. The date and the link come back with the
 * verdict because the row that proves a branch IS bookable is the only place either of them exists.
 */
export function listedRowsInEnvelope({ json, navCodes }: {
  json: unknown;
  navCodes: Iterable<string>;
}) {
  const wanted = new Set(navCodes);
  const found = new Map<string, ListedBranchRow>();
  const html = getSmileHtml(json);
  if (!html || wanted.size === 0) {
    return found;
  }

  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  for (const elRow of parsedDocument.querySelectorAll("li.diary")) {
    const code = rowNavCode(elRow);
    if (wanted.has(code)) {
      found.set(code, {
        soonest: rowSoonestSlot(elRow),
        slotsLink: elRow.querySelector(SLOTS_LINK_SELECTOR)?.getAttribute("data-action-link") ?? null
      });
    }
  }

  return found;
}

/**
 * Heal the LIVE list after a minting sweep: every new search re-mints the session's GUIDs, so the
 * displayed real rows' slots/details links are dead. Given an envelope of the restored (re-run) user
 * search, rewrite matching rows' action links to the fresh GUIDs. Returns the nav codes refreshed.
 */
export function refreshRowActionLinks({ elList, json }: {
  elList: Element;
  json: unknown;
}) {
  const html = getSmileHtml(json);
  if (!html) {
    return [];
  }

  const liveRowsByNavCode = new Map<string, Element>();
  for (const elRow of elList.querySelectorAll(`li.diary:not([${SYNTHETIC_ROW_ATTR}])`)) {
    liveRowsByNavCode.set(rowNavCode(elRow), elRow);
  }

  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  const refreshed: string[] = [];
  for (const elFreshRow of parsedDocument.querySelectorAll("li.diary")) {
    const elLiveRow = liveRowsByNavCode.get(rowNavCode(elFreshRow));
    if (!elLiveRow) {
      continue;
    }

    for (const selector of [SLOTS_LINK_SELECTOR, DETAILS_LINK_SELECTOR]) {
      const freshLink = elFreshRow.querySelector(selector)?.getAttribute("data-action-link");
      if (freshLink) {
        elLiveRow.querySelector(selector)?.setAttribute("data-action-link", freshLink);
      }
    }

    refreshed.push(rowNavCode(elFreshRow));
  }

  return refreshed;
}

export interface SmileCityRow {
  name: string;
  html: string;
}

/** The searched city's rows from a paging envelope, order preserved, as append-ready HTML. */
export function extractCityRows({ json, searchedCity }: {
  json: unknown;
  searchedCity: string;
}) {
  const html = getSmileHtml(json);
  if (!html) {
    return [];
  }

  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  return [...parsedDocument.querySelectorAll("li.diary")]
    .filter(elRow => cityMatches({
      rowCity: rowCityName(elRow),
      searchedCity
    }))
    .map(elRow => ({
      name: rowClinicName(elRow),
      html: elRow.outerHTML
    }));
}
