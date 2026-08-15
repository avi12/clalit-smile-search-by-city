/**
 * Pure text helpers, dependency-free so any context (incl. the MAIN-world interceptor) can import them
 * without pulling in the clinic dataset or DOM/chrome globals.
 */

/** Normalize a Hebrew place string for tolerant matching: drop geresh/quotes, collapse whitespace. */
export function normalizeCity(value: string) {
  return value.replaceAll(/["'׳״]/g, "").replaceAll(/\s+/g, " ").trim();
}

/** The chain every Smile branch is titled with - boilerplate in a name, a tiebreak between clinics. */
export const SMILE_CHAIN_NAME = "כללית סמייל";

/**
 * Words every Clalit clinic title carries - the chain, the centre type, the city - which say nothing
 * about WHICH clinic this is. Stripping them leaves the part a human would call the clinic's name.
 */
const CLINIC_TITLE_BOILERPLATE = [
  SMILE_CHAIN_NAME,
  "מרכז מומחים",
  "מרכז רפואי",
  "מרפאת שיניים",
  "מרפאת",
  "תל אביב יפו",
  "תל אביב",
  "תא"
];

/**
 * The clinic's own name inside a Clalit title: "מגדל המאה - כללית סמייל - תל אביב יפו" and
 * "מרכז מומחים מגדל המאה - תל אביב יפו" both reduce to "מגדל המאה". Used to line the branch directory
 * up with the visits list, whose titles come from a different Clalit system and rarely match verbatim.
 */
export function clinicNameCore(title: string) {
  let core = normalizeCity(title).replaceAll("-", " ");
  for (const word of CLINIC_TITLE_BOILERPLATE) {
    core = core.replaceAll(word, " ");
  }

  return core.replaceAll(/\s+/g, " ").trim();
}
