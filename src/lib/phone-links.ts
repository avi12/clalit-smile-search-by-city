/**
 * How a clinic's phone numbers are presented, in one place: the directory's raw strings turned into a
 * dialable number and a readable one, and the markup that renders them.
 *
 * A number here IS a link - tapping it dials, and for a branch with no online diary the phone is the
 * whole booking route - so it looks like one wherever it appears: the site's own link blue, underlined
 * (Avi, 2026-08-15). Nothing sets the colour: NOT overriding it is what leaves the site's own
 * `a { color: rgb(15,130,209) }` showing, so the number matches every other link around it. The
 * underline has to be inline, because that same rule set carries `text-decoration: none` and the site's
 * `.underline` class loses to it in this document.
 *
 * The markup is a Svelte component rather than DOM built by hand, so the thing that is easy to get
 * wrong - where the space between two numbers sits - is visible in a template instead of hidden in a
 * sequence of appendChild calls. All three surfaces mount the same component: the row's telephone slot,
 * the composed lightbox and the site's message box. The last two are serialized to HTML afterwards by
 * their callers, which works because mounting renders synchronously, into a detached node just as well
 * as into a live one.
 */

import PhoneLinks from "./PhoneLinks.svelte";
import { flushSync, mount } from "svelte";

export interface FormattedPhone {
  /** Digits only, for `tel:` - what the phone actually dials. */
  dial: string;
  /** What the row shows: "03-6316561", plus the directory's own "(1)"-style hint when it carries one. */
  display: string;
}

/**
 * The directory's phone strings are unformatted digit runs, sometimes with a trailing hint in
 * parentheses ("035272677 (1)"). Returns null for a string with no digits at all.
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
 * Render a branch's numbers into a telephone slot, replacing whatever it held.
 *
 * The slot is not always a node of the live page: the composed lightbox rewrites a fragment parsed by
 * DOMParser, so its telephone slot belongs to another document entirely. Svelte builds its nodes with
 * the live `document`, so they are rendered into a container of ours and then IMPORTED into whichever
 * document the slot belongs to - which is a no-op for the rows and the one thing that makes the parsed
 * fragment work. `flushSync` because both string surfaces read the slot's HTML on the very next line.
 */
export function renderPhoneLinks({ elContainer, phones }: {
  elContainer: Element;
  phones: string[];
}) {
  const elRendered = document.createElement("span");
  mount(PhoneLinks, {
    target: elRendered,
    props: {
      phones: phones.map(formatPhone).filter(phone => phone !== null)
    }
  });
  flushSync();

  const { ownerDocument } = elContainer;
  elContainer.textContent = "";
  for (const node of elRendered.childNodes) {
    elContainer.appendChild(ownerDocument.importNode(node, true));
  }
}
