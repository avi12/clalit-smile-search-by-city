/**
 * Dev server entry. Builds the WXT development bundle (inline source maps), launches Chrome with the
 * extension sideloaded against a clone of your real profile, and hot-reloads on save. The browser
 * exposes a fixed CDP port (CDP_PORT in dev-chrome.ts, mirrored in .mcp.json) so chrome-devtools-mcp
 * can drive this exact instance.
 *
 * Must run via tsx (Node), not Bun.
 *
 * Usage: tsx scripts/dev.ts   (or `pnpm ext:dev`)
 */

import { chromeTarget } from "./dev-chrome";
import { installProcessDiagnostics, logEvent, runDevServer } from "./dev-shared";

installProcessDiagnostics();

runDevServer(chromeTarget).catch(error => {
  logEvent("Fatal error in runDevServer():");
  console.error(error);
  process.exit(1);
});
