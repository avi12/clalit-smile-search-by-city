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
  enabled: z.boolean(),
  city: z.string()
});

export const guaranteeStatusSchema = z.object({
  city: z.string(),
  resultsCount: z.number().int().nonnegative(),
  inCityCount: z.number().int().nonnegative()
});

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
    enabled: z.boolean()
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
  token: z.string()
});

// ── Smile network envelope ──────────────────────────────────────────────────────

/** The /Zimunet/SmileClinic/* response: a server-rendered HTML fragment in `data`. */
export const smileEnvelopeSchema = z.object({
  data: z.string(),
  errorType: z.unknown().optional(),
  message: z.unknown().optional()
});
