/**
 * Zod schemas for everything the INTERCEPTOR receives, and nothing else: a schema belongs to whoever
 * reads the value, not to whoever sends it. What arrives here is the bridge's search config and its
 * answer to a position request (both over the window channel, where a page script could answer instead)
 * and the Smile envelope off the network.
 *
 * Parsing at the edge means the rest of the MAIN world works with already-validated shapes. Zod is the
 * only import, which is what lets a MAIN-world script - no `browser.*` at all - take it.
 */

import { z } from "zod";

// ── Window channel: what the bridge pushes ─────────────────────────────────────

export const searchConfigSchema = z.object({
  isEnabled: z.boolean(),
  city: z.string()
});

/**
 * The answer to a position request. It reaches the MAIN world over window.postMessage, so a page script
 * could answer instead of the bridge - a bad shape is treated exactly like "no fix".
 */
export const positionAnswerSchema = z.tuple([
  z.number().min(-90).max(90),
  z.number().min(-180).max(180)
]).nullable();

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
