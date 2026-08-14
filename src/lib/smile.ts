/**
 * The city guarantee for the Clalit Smile clinic search, whose results arrive as a SERVER-RENDERED
 * HTML fragment inside a JSON envelope (shape captured in targets.ts). The interceptor rewrites the
 * outgoing search to all-country, and these transforms then keep ONLY the searched city's rows in each
 * response — order preserved, so the site's chosen sort is respected — while the interceptor aggregates
 * the remaining server pages into the same list (see clalit-interceptor.content.ts).
 *
 * Runs in the page's MAIN world, so DOMParser is available. Pure string→string: nothing here touches
 * the live document.
 */

import type { SmileBranch } from "./clinic-directory";
import { smileEnvelopeSchema } from "./schemas";

/** The results fragment out of a /Zimunet/SmileClinic/* envelope, or null if this isn't one. */
export function getSmileHtml(json: unknown): string | null {
  const parsed = smileEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }

  const { data } = parsed.data;
  return data.includes("diary") ? data : null;
}

const ADDRESS_PREFIX = "כתובת:";

/**
 * A row's city = the last comma-segment of its "כתובת: …" line (some addresses are city-only). The
 * site already renders the clinic's canonical city here — the exact same string its city autocomplete
 * produces for the search box — so it compares 1:1 against the searched city with no normalization.
 */
export function rowCityName(row: Element): string {
  const address =
    [...row.querySelectorAll(".clinicDetails")]
      .map(element => element.textContent?.trim() ?? "")
      .find(text => text.startsWith(ADDRESS_PREFIX))
      ?.slice(ADDRESS_PREFIX.length) ?? "";
  return address.split(",").pop()?.trim() ?? "";
}

/** Clinic display name — the stable identity for dedup (diary GUIDs change per search session). */
export function rowClinicName(row: Element): string {
  return row.querySelector("a.clinicDetails")?.textContent?.trim() ?? "";
}

/**
 * Exact match against the site's OWN canonical city. `searchedCity` is `SelectedCityName` — the value
 * Clalit's autocomplete committed when the user picked a city in the search box — and `rowCity` is the
 * same canonical string the server rendered into the row, so equality is authoritative. No fuzzy
 * normalization: the site is the single source of truth for what a city is called.
 */
export function cityMatches({ rowCity, searchedCity }: {
  rowCity: string;
  searchedCity: string;
}): boolean {
  return rowCity.trim() !== "" && rowCity.trim() === searchedCity.trim();
}

const NAV_CODE_PATTERN = /\/nav\/(\d+)/;

/** The clinic's nearme code from the row's "הצגת מפה" link — the key into CLINIC_COORDS. */
export function rowNavCode(row: Element): string {
  const href = row.querySelector("a.mapLocationLink")?.getAttribute("href") ?? "";
  return NAV_CODE_PATTERN.exec(href)?.[1] ?? "";
}

/** What the distance sort really means under the guarantee: distance from the user's LIVE location. */
export const LIVE_DISTANCE_SORT_LABEL = "מרחק ממיקומך";

/** Rewrite a live row's server-computed "מרחק מהבית שלך" line with the live-location distance. */
export function setRowDistanceLabel({ row, km }: {
  row: Element;
  km: number;
}): void {
  const text = `${LIVE_DISTANCE_SORT_LABEL}: ${km.toFixed(2)} ק"מ`;
  const label = [...row.querySelectorAll(".clinicDetails")].find(element => element.textContent?.includes("מרחק"));
  if (label) {
    label.textContent = text;
    return;
  }

  // Synthetic branch rows have no server distance line — add one.
  const container = row.querySelector(".pull-right");
  if (container) {
    const line = container.ownerDocument.createElement("div");
    line.className = "clinicDetails";
    line.textContent = text;
    container.appendChild(line);
  }
}

// ── Synthetic branch rows (city completeness beyond Tamuz) ─────────────────────

/** Marks rows the extension added from the branch directory (no bookable diary in Tamuz). */
export const SYNTHETIC_ROW_ATTR = "data-clalit-city-synthetic";

/** Marks "מידע נוסף" anchors that open the composed clinic-details lightbox (value = branch code). */
export const DETAILS_CODE_ATTR = "data-clalit-city-details-code";

/**
 * Marks a synthetic row's "לכל התורים" button (value = branch code). The row has no diary GUID — one
 * only exists inside the server session's LAST search — so the interceptor's click handler mints a
 * fresh GUID on demand (a specialization sweep of new searches) and navigates to it (docs §6c).
 */
export const MINT_CODE_ATTR = "data-clalit-city-mint-code";

const CLINIC_DETAILS_BY_VISIT = "/Zimunet/ClinicDoctor/ClinicDetailsByVisit/";
const NEARME_NAV = "https://nearme.clalit.co.il/nav/";
const CENTRAL_BOOKING_PHONE = "*2700";

/** Marks every note the extension adds (row, lightbox, loader) so a second one replaces it, never stacks. */
export const NOTE_ATTR = "data-clalit-city-note";

const CALL_INSTEAD = "ניתן להתקשר למרפאה או למוקד";

/** On a synthetic row: this search's service has no online diary for the branch. */
export const NO_DIARY_ROW_NOTE = `אין יומן מקוון לשירות זה — ${CALL_INSTEAD}`;

/** In the fallback lightbox: the click-time sweep just checked every service and found none (docs §6c). */
export const NO_DIARY_SWEEP_NOTE = `בדקנו עכשיו את כל שירותי כללית סמייל ואין יומן מקוון לסניף זה — ${CALL_INSTEAD}`;

/** On the loader once the sweep hits: the iframe is about to navigate to the branch's slots page. */
export const MINT_NAVIGATE_NOTE = "נמצא יומן — פותחים את התורים";

/** On the loader during the sweep — the wait is one fresh search per service, so say which one. */
export function sweepStepNote({ step, total }: {
  step: number;
  total: number;
}): string {
  return `בודקים אם יש יומן מקוון לסניף — שירות ${step} מתוך ${total}`;
}

/**
 * Directory phones come without the leading 0 ("36316561") — render like the site ("03-6316561").
 * A parenthesized IVR hint like "077-8012222 (1)" stays visible but its digit is never dialed.
 */
function formatPhone(raw: string) {
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

/** Render directory phones as tel: links into a telephone slot (the row and the lightbox share this). */
function appendPhoneLinks({ container, phones }: {
  container: Element;
  phones: string[];
}) {
  const { ownerDocument } = container;
  container.textContent = "";
  for (const phone of phones) {
    const formatted = formatPhone(phone);
    if (!formatted) {
      continue;
    }

    const link = ownerDocument.createElement("a");
    // The site's own inline-link class (anchors already inherit its color; this adds the underline).
    link.className = "underline";
    link.setAttribute("href", `tel:${formatted.dial}`);
    // dir=ltr keeps digits and a "(1)" hint in reading order inside the RTL layout.
    link.setAttribute("dir", "ltr");
    link.textContent = `${formatted.display} `;
    container.appendChild(link);
  }
}

/** The "no online diary" note, in the site's own row/details text style, ending in the *2700 hotline. */
function buildHotlineNote({ ownerDocument, text }: {
  ownerDocument: Document;
  text: string;
}) {
  const note = ownerDocument.createElement("div");
  note.className = "clinicDetails";
  note.setAttribute(NOTE_ATTR, "1");
  note.textContent = `${text} `;
  const hotline = ownerDocument.createElement("a");
  hotline.className = "underline";
  hotline.setAttribute("href", `tel:${CENTRAL_BOOKING_PHONE}`);
  // dir=ltr keeps "*2700" from flipping to "2700*" inside the RTL note.
  hotline.setAttribute("dir", "ltr");
  hotline.textContent = CENTRAL_BOOKING_PHONE;
  note.appendChild(hotline);
  return note;
}

export interface BranchRowInput {
  /** A cloned REAL server row (li.diary) to repurpose — never markup we authored. */
  row: Element;
  branch: SmileBranch;
  /** A past visit at this branch → the site's native clinic-details lightbox; null → nearme page. */
  detailsVisitGuid: string | null;
}

/**
 * Turn a CLONED server row into a synthetic branch row (a branch the search has no diary for). We edit
 * the site's own element structure rather than build markup: rewrite clinic name / address / phones /
 * map, drop the slot date and the booking button (there is nothing to book), point "מידע נוסף" at the
 * site's native clinic-details lightbox when the user has a visit here (ClinicDetailsByVisit) or the
 * official nearme page otherwise, and make the phone a tel: link.
 */
export function applyBranchToRow({ row, branch, detailsVisitGuid }: BranchRowInput): void {
  const { code, title, street, city, phones } = branch;
  const { ownerDocument } = row;
  row.setAttribute(SYNTHETIC_ROW_ATTR, "1");
  const detailsHref = detailsVisitGuid ? `${CLINIC_DETAILS_BY_VISIT}${detailsVisitGuid}` : null;
  const nearme = `${NEARME_NAV}${code}`;

  // Both the clinic-name link and the "מידע נוסף" button are a.clinicDetails. With a past visit here,
  // keep them native (site's delegated handler fetches ClinicDetailsByVisit → lightbox); otherwise turn
  // them into a plain nearme link so the site never tries to Ajax-fetch a cross-origin href.
  for (const anchor of row.querySelectorAll("a.clinicDetails")) {
    const isMoreInfoButton = anchor.classList.contains("pull-left");
    anchor.textContent = isMoreInfoButton ? "מידע נוסף" : title;
    anchor.setAttribute("title", isMoreInfoButton ? "מידע נוסף" : title);

    if (detailsHref) {
      anchor.setAttribute("data-action-link", detailsHref);
    } else {
      // No GUID exists for this branch, so the site's own Ajax handler must not fire (it would choke on
      // a cross-origin href). The interceptor's delegated click handler opens the composed lightbox via
      // DETAILS_CODE_ATTR instead; the nearme href stays as the new-tab/middle-click/failure fallback.
      anchor.classList.remove("clinicDetails");
      anchor.removeAttribute("data-action-link");
      anchor.setAttribute("href", nearme);
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener");
      anchor.setAttribute(DETAILS_CODE_ATTR, code);
    }
  }

  // Address, and drop lines that only make sense for a real diary (soonest-slot date, server distance).
  const address = street ? `${street}, ${city}` : city;
  for (const detail of row.querySelectorAll(".clinicDetails")) {
    const text = detail.textContent?.trim() ?? "";
    if (text.startsWith(ADDRESS_PREFIX)) {
      detail.textContent = `${ADDRESS_PREFIX} ${address}`;
    } else if (text.startsWith("מועד התור") || text.includes("מרחק")) {
      detail.remove();
    }
  }

  // Phones as tel: links, reusing the row's own telephone slot.
  const telephone = row.querySelector(".clinicTelephone");
  if (telephone) {
    appendPhoneLinks({
      container: telephone,
      phones
    });
  }

  // No diary GUID exists YET for this branch — keep the native "לכל התורים" button but strip its
  // data-action-link (the site's delegated handler only fires on that attribute) and mark it for the
  // interceptor's click-time GUID minting instead. The diary set fluctuates intraday, so a diary may
  // exist by the time the user clicks even though the search omitted this branch.
  const diaryButton = row.querySelector("#CreateVisitButton, a.diaryButton");
  if (diaryButton) {
    diaryButton.removeAttribute("data-action-link");
    diaryButton.setAttribute(MINT_CODE_ATTR, code);
  }

  // Repoint the map link at this branch, and add the "no online diary" note with the central hotline.
  row.querySelector("a.mapLocationLink")?.setAttribute("href", nearme);
  row.querySelector(".pull-right")?.appendChild(
    buildHotlineNote({
      ownerDocument,
      text: NO_DIARY_ROW_NOTE
    })
  );
}

/**
 * Put the reason INSIDE the clinic-details lightbox — the row's own note is hidden behind the dialog
 * while it is open, and after a failed minting sweep that dialog IS the answer to "לכל התורים". Works
 * on the site's native ClinicDetailsByVisit view and on our composed fragment alike: both are the same
 * container (targets.ts SMILE_DETAILS_DIALOG_SELECTOR).
 */
export function setDialogNote({ dialog, text }: {
  dialog: Element;
  text: string;
}): void {
  for (const stale of dialog.querySelectorAll(`[${NOTE_ATTR}]`)) {
    stale.remove();
  }

  const { ownerDocument } = dialog;
  const host = dialog.querySelector(".css_NoPaddingCell.clinicDetails") ?? dialog.querySelector("div.content") ?? dialog;
  host.prepend(
    buildHotlineNote({
      ownerDocument,
      text
    })
  );
}

// The loader is a full-screen fixed flex box holding ONLY the animation, so the caption is absolutely
// positioned under it — the site's own element and layout stay untouched, and hiding the loader removes
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
export function setLoaderNote({ loader, text }: {
  loader: Element;
  text: string;
}): void {
  const existing = loader.querySelector<HTMLElement>(`[${NOTE_ATTR}]`);
  if (existing) {
    existing.textContent = text;
    return;
  }

  const note = loader.ownerDocument.createElement("div");
  note.setAttribute(NOTE_ATTR, "1");
  Object.assign(note.style, LOADER_NOTE_STYLE);
  note.textContent = text;
  loader.appendChild(note);
}

// ── Composed clinic-details lightbox (branches with no GUID of any kind) ───────

const RECEPTION_DAY_LETTERS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

function formatMinutes(total: number): string {
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Rewrite a `<span class="title">label</span> value` line's value, keeping the label span. */
function setLabeledLine({ line, value }: {
  line: Element;
  value: string;
}): void {
  const label = line.querySelector("span.title");
  if (!label) {
    return;
  }

  line.textContent = "";
  line.appendChild(label);
  line.appendChild(line.ownerDocument.createTextNode(` ${value}`));
}

/** The accessibility list: the directory's labels, or drop the line when the branch has none. */
function applyAccessibilityLine({ line, labels }: {
  line: Element;
  labels: string[];
}): void {
  const items = [...line.children].find(child => !child.classList.contains("clinicAccessibilty"));
  if (labels.length === 0 || !items) {
    line.remove();
    return;
  }

  const { ownerDocument } = line;
  items.textContent = "";
  for (const label of labels) {
    const item = ownerDocument.createElement("div");
    item.textContent = label;
    items.appendChild(item);
  }
}

/** Lines we cannot source honestly for a branch the server never described. */
const UNSOURCED_DETAIL_LINE = /פקס:|אוטובוסים:|הערות:/;

/** One `<div>` line of the details cell, rewritten for the branch (or removed). */
function applyBranchToDetailLine({ line, branch }: {
  line: Element;
  branch: SmileBranch;
}): void {
  const { street, city, phones, accessibility } = branch;
  const text = line.textContent ?? "";
  if (text.includes("כתובת:")) {
    setLabeledLine({
      line,
      value: street ? `${street}, ${city}` : city
    });
    return;
  }

  if (text.includes("טלפון:")) {
    const telephone = line.querySelector(".clinicTelephone");
    if (telephone) {
      appendPhoneLinks({
        container: telephone,
        phones
      });
    }

    return;
  }

  if (line.querySelector(".clinicAccessibilty")) {
    applyAccessibilityLine({
      line,
      labels: accessibility
    });
    return;
  }

  if (UNSOURCED_DETAIL_LINE.test(text) || line.classList.contains("divClinicRemarksList")) {
    line.remove();
  }
}

/** Rebuild the reception-hours table from the directory's [day, start, end] triples. */
function rebuildHoursTable({ table, hours }: {
  table: Element;
  hours: SmileBranch["hours"];
}): void {
  const { ownerDocument } = table;
  const byDay = new Map(hours.map(([day, start, end]) => [
    day,
    `מ ${formatMinutes(start)} עד ${formatMinutes(end)}`
  ]));
  table.textContent = "";
  for (const [day, letter] of RECEPTION_DAY_LETTERS.entries()) {
    const separatorRow = ownerDocument.createElement("tr");
    const separatorCell = ownerDocument.createElement("td");
    separatorCell.setAttribute("colspan", "2");
    separatorCell.className = "separator";
    separatorRow.appendChild(separatorCell);
    table.appendChild(separatorRow);

    const row = ownerDocument.createElement("tr");
    const header = ownerDocument.createElement("td");
    header.className = "header";
    header.textContent = letter;
    const value = ownerDocument.createElement("td");
    value.textContent = byDay.get(day) ?? "";
    // The site's empty remark div is load-bearing: its 210px width is what holds the value column
    // open (the CSS gives td.header width:100%, which otherwise crushes the hours to a word a line).
    const remark = ownerDocument.createElement("div");
    remark.className = "clinicDetailsReceptionRemark";
    remark.setAttribute("title", "");
    value.appendChild(remark);
    row.appendChild(header);
    row.appendChild(value);
    table.appendChild(row);
  }
}

/** The ClinicDetailsByDiary action link of a real server row's HTML — the details-template source. */
export function detailsLinkFromRowHtml(html: string): string | null {
  if (!html) {
    return null;
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector("a[data-action-link*=\"ClinicDetailsByDiary\"]")?.getAttribute("data-action-link") ?? null;
}

/**
 * Compose the clinic-details lightbox fragment for a branch with no GUID: take a REAL clinic's
 * fragment (fetched via ClinicDetailsByDiary on a current-search row) as the template — the site's own
 * markup — and rewrite name / map / address / phones from the directory, rebuild the hours table and
 * accessibility list from the same public dataset the site uses, and drop the lines we cannot source
 * honestly (fax, buses, notes, per-clinic remarks). Returns null when the template isn't a details
 * fragment (e.g. a stale-GUID empty envelope).
 */
export function applyBranchToDetailsFragment({ template, branch }: {
  template: string;
  branch: SmileBranch;
}): string | null {
  const doc = new DOMParser().parseFromString(template, "text/html");
  if (!doc.querySelector(".css_Table")) {
    return null;
  }

  const { title, code, hours } = branch;
  const nameLabel = [...doc.querySelectorAll(".css_Cell span.title")].find(span => span.textContent?.includes("מרפאה"));
  if (nameLabel?.parentElement) {
    setLabeledLine({
      line: nameLabel.parentElement,
      value: title
    });
  }

  doc.querySelector("a.mapLocationLink")?.setAttribute("href", `${NEARME_NAV}${code}`);

  for (const line of doc.querySelector(".css_NoPaddingCell.clinicDetails")?.querySelectorAll(":scope > div") ?? []) {
    applyBranchToDetailLine({
      line,
      branch
    });
  }

  const hoursTable = doc.querySelector("#receptionHours");
  if (!hoursTable) {
    return doc.body.innerHTML;
  }

  if (hours.length === 0) {
    doc.querySelector(".receptionHoursHeader")?.remove();
    hoursTable.remove();
    return doc.body.innerHTML;
  }

  rebuildHoursTable({
    table: hoursTable,
    hours
  });
  return doc.body.innerHTML;
}

/** Replace an element's text while keeping child elements (the sort links carry an icon <i>). */
function replaceTextNode({ element, text }: {
  element: Element;
  text: string;
}): void {
  for (const node of element.childNodes) {
    if (node.nodeType === 3 && node.textContent?.trim()) {
      node.textContent = text;
      return;
    }
  }
}

/** Rewrite the "נמצאו N" count in a results header (the aggregator bumps it as pages stream in). */
export function setHeaderCount({ header, count }: {
  header: Element;
  count: number;
}): void {
  header.textContent = (header.textContent ?? "").replace(/נמצאו\s+\d+/, `נמצאו ${count}`);
}

function readDeclaredTotal(doc: Document): number {
  const match = doc.querySelector("h2")?.textContent?.match(/נמצאו\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

export interface SmileFilterOutcome {
  isChanged: boolean;
  json: unknown;
  /** N from the "נמצאו N תוצאות" header — the size of the server's full (all-country) result set. */
  totalDeclared: number;
  /** Rows this page carried before filtering — the server's page size. */
  pageRowCount: number;
  keptRowCount: number;
  /** outerHTML of a real server row (pre-filter), so synthetic branch rows clone the site's own markup. */
  templateRowHtml: string;
}

/** Attribute the aggregator uses to recognize OUR render of the list in the live document. */
export const SMILE_MARKER_ATTR = "data-clalit-city-marker";

/**
 * Filter one results envelope to the searched city. Also removes the pager (the aggregator flattens
 * every server page into this one list) and the "מרחק מהיישוב שחיפשת" sort — a distance sort must
 * reference the USER's location, and the remaining "מרחק מהבית שלך" is exactly that.
 */
export function filterSmileEnvelope(
  { json, searchedCity, marker }: {
    json: unknown;
    searchedCity: string;
    marker?: string;
  }
): SmileFilterOutcome {
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

  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = [...doc.querySelectorAll("li.diary")];
  const templateRowHtml = rows[0]?.outerHTML ?? "";
  const totalDeclared = readDeclaredTotal(doc);
  let keptRowCount = 0;
  for (const row of rows) {
    if (cityMatches({
      rowCity: rowCityName(row),
      searchedCity
    })) {
      keptRowCount += 1;
    } else {
      row.remove();
    }
  }

  for (const pager of doc.querySelectorAll("#pager")) {
    pager.remove();
  }

  doc.querySelector("a[data-action-link*=\"sortValue=4\"]")?.closest("h3")?.remove();

  // The remaining distance sort is hijacked to rank by the user's live location, so label it truthfully.
  const homeSortLink = doc.querySelector("a[data-action-link*=\"sortValue=3\"]");
  if (homeSortLink) {
    replaceTextNode({
      element: homeSortLink,
      text: LIVE_DISTANCE_SORT_LABEL
    });
    homeSortLink.setAttribute("title", LIVE_DISTANCE_SORT_LABEL);
  }

  const header = doc.querySelector("h2");
  if (header?.textContent) {
    header.textContent = header.textContent.replace(/באזור:.*$/, `בעיר: ${searchedCity.trim()}`);
    setHeaderCount({
      header,
      count: keptRowCount
    });
  }

  if (marker) {
    doc.querySelector("#am_diaries")?.setAttribute(SMILE_MARKER_ATTR, marker);
  }

  const parsed = smileEnvelopeSchema.safeParse(json);
  const envelope = {
    ...(parsed.success ? parsed.data : {}),
    data: doc.body.innerHTML
  };
  return {
    isChanged: true,
    json: envelope,
    totalDeclared,
    pageRowCount: rows.length,
    keptRowCount,
    templateRowHtml
  };
}

// ── Click-time GUID minting (synthetic rows' "לכל התורים") ─────────────────────

const SLOTS_LINK_SELECTOR = "a[data-action-link*=\"/AvailableVisit/Smile/\"]";
const DETAILS_LINK_SELECTOR = "a[data-action-link*=\"ClinicDetailsByDiary\"]";

export interface SmileEnvelopeScan {
  /** The branch's fresh "לכל התורים" link (slots page, /AvailableVisit/Smile/{guid}) — null if absent. */
  actionLink: string | null;
  totalDeclared: number;
  pageRowCount: number;
  /** A real row of THIS search — its ClinicDetailsByDiary GUID is current while the search is last. */
  firstRowHtml: string;
}

/** Scan one results envelope for a branch (by nav code) and its fresh slots link. */
export function scanEnvelopeForNavCode({ json, navCode }: {
  json: unknown;
  /** Omit to read only the page metadata (totals + template row). */
  navCode?: string;
}): SmileEnvelopeScan {
  const html = getSmileHtml(json);
  if (!html) {
    return {
      actionLink: null,
      totalDeclared: 0,
      pageRowCount: 0,
      firstRowHtml: ""
    };
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = [...doc.querySelectorAll("li.diary")];
  const match = navCode ? rows.find(row => rowNavCode(row) === navCode) : undefined;
  return {
    actionLink: match?.querySelector(SLOTS_LINK_SELECTOR)?.getAttribute("data-action-link") ?? null,
    totalDeclared: readDeclaredTotal(doc),
    pageRowCount: rows.length,
    firstRowHtml: rows[0]?.outerHTML ?? ""
  };
}

/**
 * Heal the LIVE list after a minting sweep: every new search re-mints the session's GUIDs, so the
 * displayed real rows' slots/details links are dead. Given an envelope of the restored (re-run) user
 * search, rewrite matching rows' action links to the fresh GUIDs. Returns the nav codes refreshed.
 */
export function refreshRowActionLinks({ list, json }: {
  list: Element;
  json: unknown;
}): string[] {
  const html = getSmileHtml(json);
  if (!html) {
    return [];
  }

  const liveByCode = new Map<string, Element>();
  for (const row of list.querySelectorAll(`li.diary:not([${SYNTHETIC_ROW_ATTR}])`)) {
    liveByCode.set(rowNavCode(row), row);
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const refreshed: string[] = [];
  for (const freshRow of doc.querySelectorAll("li.diary")) {
    const liveRow = liveByCode.get(rowNavCode(freshRow));
    if (!liveRow) {
      continue;
    }

    for (const selector of [SLOTS_LINK_SELECTOR, DETAILS_LINK_SELECTOR]) {
      const freshLink = freshRow.querySelector(selector)?.getAttribute("data-action-link");
      if (freshLink) {
        liveRow.querySelector(selector)?.setAttribute("data-action-link", freshLink);
      }
    }

    refreshed.push(rowNavCode(freshRow));
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
}): SmileCityRow[] {
  const html = getSmileHtml(json);
  if (!html) {
    return [];
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("li.diary")]
    .filter(row => cityMatches({
      rowCity: rowCityName(row),
      searchedCity
    }))
    .map(row => ({
      name: rowClinicName(row),
      html: row.outerHTML
    }));
}
