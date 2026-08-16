/**
 * Zod schemas for every value that crosses a trust boundary into the extension: the window-channel
 * config/status payloads (bridge ⇄ MAIN), the frame-channel broadcasts (which any same-origin script
 * could forge), and the Smile JSON envelope from the network. Parsing at the edge means the rest of the
 * code works with already-validated shapes.
 *
 * Dependency-light (zod only) so the MAIN-world interceptor can import it.
 */

import { z } from "zod";

// ── Window channel: bridge ⇄ MAIN ──────────────────────────────────────────────

export const searchConfigSchema = z.object({
  isEnabled: z.boolean(),
  city: z.string()
});

export const guaranteeStatusSchema = z.object({
  city: z.string(),
  resultsCount: z.number().int().nonnegative(),
  inCityCount: z.number().int().nonnegative()
});

/**
 * The answer to a position request. It reaches the MAIN world over window.postMessage, so a page script
 * could answer instead of the bridge - a bad shape is treated exactly like "no fix".
 */
export const positionAnswerSchema = z.tuple([
  z.number().min(-90).max(90),
  z.number().min(-180).max(180)
]).nullable();

// ── Frame ⇄ frame channel (a BroadcastChannel any same-origin script can post on) ─

/**
 * The relay envelope, and all the channel itself knows: an unrecognised `type` simply finds no handler,
 * and the payload is parsed by whichever handler owns that type. `data` is OPTIONAL because a message
 * can carry nothing at all (`Hello` does) - zod counts a bare `z.unknown()` as a required key, so
 * without this a payload-free broadcast would be dropped as malformed.
 */
export const frameMessageSchema = z.object({
  type: z.string(),
  data: z.unknown().optional()
});

export const frameStateSchema = z.object({
  city: z.string(),
  status: guaranteeStatusSchema.nullable()
});

// ── Smile network envelope ──────────────────────────────────────────────────────

/**
 * The envelope's own status: 0 Success, 1 Information, 2 Authorization (the scheduler session is gone),
 * 3 Application (this search has nothing to return). Read separately from the fragment schema because a
 * failed envelope carries no `data` at all.
 */
export const smileEnvelopeStatusSchema = z.object({
  errorType: z.number()
});

/** The /Zimunet/SmileClinic/* response: a server-rendered HTML fragment in `data`. */
export const smileEnvelopeSchema = z.object({
  data: z.string(),
  errorType: z.unknown().optional(),
  message: z.unknown().optional()
});
