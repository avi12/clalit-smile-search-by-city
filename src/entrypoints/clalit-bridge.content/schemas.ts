/**
 * Zod schemas for everything the BRIDGE receives, and nothing else: a schema belongs to whoever reads
 * the value, not to whoever sends it. What arrives here is the interceptor's guarantee outcome over the
 * window channel, and the frame channel's broadcasts - which any same-origin script can post.
 *
 * Parsing at the edge means the rest of the bridge works with already-validated shapes.
 */

import { z } from "zod";

// ── Window channel: what the interceptor reports ───────────────────────────────

export const guaranteeStatusSchema = z.object({
  city: z.string(),
  resultsCount: z.number().int().nonnegative(),
  inCityCount: z.number().int().nonnegative()
});

// ── Frame channel: a BroadcastChannel any same-origin script can post on ────────

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
