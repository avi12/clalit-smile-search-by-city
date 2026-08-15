/**
 * Zod schemas for every value that crosses a trust boundary into the extension: the window-channel
 * config/status payloads (bridge ⇄ MAIN), the frame-relay and dev-takeover window messages (which any
 * page script could forge), and the Smile JSON envelope from the network. Parsing at the edge means the
 * rest of the code works with already-validated shapes.
 *
 * Dependency-light (zod only) so the MAIN-world interceptor can import it.
 */

import { FRAME_RELAY_SOURCE, PAGE_NAMESPACE } from "./messaging";
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

// ── Frame ⇄ top relay (raw window.postMessage, so any page could forge it) ──────

const frameRelaySource = z.literal(FRAME_RELAY_SOURCE);

export const frameRelayMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    source: frameRelaySource,
    kind: z.literal("frame-state"),
    city: z.string(),
    status: guaranteeStatusSchema.nullable()
  }),
  z.object({
    source: frameRelaySource,
    kind: z.literal("toggle"),
    isEnabled: z.boolean()
  }),
  z.object({
    source: frameRelaySource,
    kind: z.literal("hello")
  })
]);

// ── Dev takeover ping (dev builds only) ─────────────────────────────────────────

export const devTakeoverMessageSchema = z.object({
  source: z.literal(`${PAGE_NAMESPACE}/dev-takeover`),
  script: z.enum(["bridge", "interceptor"]),
  token: z.string(),
  bornAt: z.number()
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
