/**
 * Dev-server infrastructure. It builds the WXT development bundle (inline source maps), launches Chrome
 * with the extension sideloaded against a CLONED copy of your real Chrome profile (so the dev browser
 * carries your Clalit login yet never touches your real session), and hot-reloads on change.
 *
 * On a change it rebuilds, reloads the extension (web-ext over CDP) and reloads the open Clalit tabs so
 * the new content scripts inject. The CDP port it launches is reused to drive the browser for
 * verification (see scripts/verify-city-filter.ts).
 *
 * Must run via tsx (Node), not Bun - web-ext-run waits for the browser's debug port to start listening,
 * which depends on Node's child_process socket handling.
 */

import {
  SESSION_TIMEOUT_CONTINUE_SELECTORS,
  SESSION_TIMEOUT_DIALOG_SELECTOR,
  SESSION_TIMEOUT_EXIT_HINT,
  TARGET_HOSTS
} from "../src/lib/targets";
import chokidar from "chokidar";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { inspect } from "node:util";
import webExtRun from "web-ext-run";
import { consoleStream as webExtConsoleStream } from "web-ext-run/util/logger";
import { build } from "wxt";

// ── Dev log ────────────────────────────────────────────────────────────────────
export const DEV_LOG_DIR = resolve(import.meta.dirname, "..", ".dev-logs");
const DEV_LOG_MAX_BYTES = 1_000_000;
const DEV_LOG_MAX_ENTRY_CHARS = 2000;
let devLogPath: string | undefined;
let devLogPrevPath: string | undefined;
let devLogBytes = 0;

function rotateDevLog() {
  if (!devLogPath || !devLogPrevPath) {
    return;
  }

  try {
    renameSync(devLogPath, devLogPrevPath);
  } catch { /* prev locked - truncate below instead */ }
  writeFileSync(devLogPath, "");
  devLogBytes = 0;
}

function appendToDevLog({ level, args }: {
  level: string;
  args: unknown[];
}) {
  if (!devLogPath) {
    return;
  }

  let text = args
    .map(arg => typeof arg === "string" ? arg : inspect(arg, {
      depth: 2,
      breakLength: 120
    }))
    .join(" ");
  if (text.length > DEV_LOG_MAX_ENTRY_CHARS) {
    text = `${text.slice(0, DEV_LOG_MAX_ENTRY_CHARS)} ...[truncated]`;
  }

  const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;
  try {
    if (devLogBytes + line.length > DEV_LOG_MAX_BYTES) {
      rotateDevLog();
    }

    appendFileSync(devLogPath, line);
    devLogBytes += line.length;
  } catch { /* logging must never take the dev server down */ }
}

function initDevLog() {
  mkdirSync(DEV_LOG_DIR, { recursive: true });
  devLogPath = join(DEV_LOG_DIR, "dev.log");
  devLogPrevPath = join(DEV_LOG_DIR, "dev.prev.log");

  if (existsSync(devLogPath)) {
    try {
      renameSync(devLogPath, devLogPrevPath);
    } catch { /* prev locked - truncate below wins */ }
  }

  writeFileSync(devLogPath, "");
  devLogBytes = 0;

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      appendToDevLog({
        level,
        args
      });
    };
  }
}

export function logEvent(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export function installProcessDiagnostics() {
  process.on("exit", code => logEvent(`Process exiting with code ${code}`));
  process.on("uncaughtException", (error, origin) => {
    if (error instanceof Error && "code" in error && error.code === "EPIPE") {
      process.exit(1);
    }

    logEvent(`uncaughtException (${origin}) - kept alive:`);
    console.error(error);
  });
  process.on("unhandledRejection", reason => {
    const isViteWatcherEbusy =
      reason instanceof Error && "code" in reason && reason.code === "EBUSY" &&
      "syscall" in reason && reason.syscall === "watch";
    if (isViteWatcherEbusy) {
      return;
    }

    logEvent("unhandledRejection - kept alive:");
    console.error(reason);
  });
}

export async function findFreeTcpPort(startPort: number) {
  const MAX_PROBES = 50;
  for (let port = startPort; port < startPort + MAX_PROBES; port++) {
    const isAvailable = await new Promise<boolean>(resolvePromise => {
      const server = createServer();
      server.once("error", () => resolvePromise(false));
      server.once("listening", () => server.close(() => resolvePromise(true)));
      server.listen(port, "127.0.0.1");
    });
    if (isAvailable) {
      return port;
    }
  }

  return startPort;
}

export function cloneFile({ sourcePath, destinationPath }: {
  sourcePath: string;
  destinationPath: string;
}) {
  if (!existsSync(sourcePath)) {
    return;
  }

  mkdirSync(dirname(destinationPath), { recursive: true });
  try {
    cpSync(sourcePath, destinationPath);
  } catch (error) {
    // A running source browser holds some profile files open (Cookies, History) - skip the locked file
    // and clone the rest; only tolerate lock errors, rethrow the rest.
    if (!/EBUSY|EPERM/.test(String(error))) {
      throw error;
    }

    logEvent(`Skipped locked profile file (source browser running?): ${basename(sourcePath)}`);
  }
}

// ── Paths & build ───────────────────────────────────────────────────────────────
export const PROJECT_ROOT = resolve(import.meta.dirname, "..");
export const USER_PROFILES_DIR = resolve(PROJECT_ROOT, "user-profiles");
const OUTPUT_DIR_NAME = "chrome-mv3-dev";
export const OUTPUT_DIR = resolve(PROJECT_ROOT, ".output", OUTPUT_DIR_NAME);
/**
 * Built bundles re-injected into live pages on rebuild - interceptor first, so its patches are in
 * place before the bridge pushes config. Names follow the entrypoint file names.
 *
 * Each one goes back into the world it is declared for. The interceptor is MAIN-world by design; the
 * bridge must land in the EXTENSION's own isolated world, because it now talks to the background
 * (the position), and a copy evaluated in MAIN has no chrome.* to talk with.
 */
const CONTENT_SCRIPT_BUNDLES = [
  {
    path: join(OUTPUT_DIR, "content-scripts", "clalit-interceptor.js"),
    isMainWorld: true
  },
  {
    path: join(OUTPUT_DIR, "content-scripts", "clalit-bridge.js"),
    isMainWorld: false
  }
];
// Open on the public clinic search; log in to e-services.clalit.co.il from here for the real booking flow.
export const START_URL = "https://www.clalitsmile.co.il/search?t=clinics&k=citySearch";
const REBUILD_DEBOUNCE_MS = 500;

function wxtEnvFiles() {
  return [".env", ".env.local", ".env.development", ".env.development.local"];
}

async function buildExtension() {
  process.env.WXT_INLINE_SOURCEMAPS = "1";
  await build({
    root: PROJECT_ROOT,
    browser: "chrome",
    mode: "development",
    manifestVersion: 3,
    outDirTemplate: OUTPUT_DIR_NAME
  });
}

const TRANSIENT_FS_ERROR_PATTERN = /EPERM|EBUSY/;
const BUILD_RETRY_DELAY_MS = 300;
const MAX_BUILD_ATTEMPTS = 3;

async function runBuildWithFsRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await buildExtension();
      return;
    } catch (error) {
      if (!TRANSIENT_FS_ERROR_PATTERN.test(String(error)) || attempt >= MAX_BUILD_ATTEMPTS) {
        throw error;
      }

      logEvent(`Build hit a transient file lock (attempt ${attempt}/${MAX_BUILD_ATTEMPTS}) - retrying`);
      await new Promise(resolvePromise => setTimeout(resolvePromise, BUILD_RETRY_DELAY_MS));
    }
  }
}

// ── CDP helpers ───────────────────────────────────────────────────────────────
export type CdpTarget = {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

export async function fetchCdpTargets(cdpPort: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets: CdpTarget[] = await response.json();
    return targets;
  } catch {
    return [];
  }
}

/** Evaluate an expression in a page target's top-frame main world; resolves with its (by-value) result. */
function evaluateOverCdp({ websocketUrl, expression }: {
  websocketUrl: string;
  expression: string;
}) {
  return new Promise<unknown>(resolvePromise => {
    const websocket = new WebSocket(websocketUrl);
    let settled = false;
    function settle(value: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      websocket.close();
      resolvePromise(value);
    }

    websocket.onopen = () =>
      websocket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression,
            returnByValue: true
          }
        })
      );
    websocket.onmessage = ({ data }) => {
      const message: {
        id?: number;
        result?: {
          result?: { value?: unknown };
        };
      } = JSON.parse(String(data));
      if (message.id === 1) {
        settle(message.result?.result?.value);
      }
    };
    websocket.onerror = () => settle(undefined);
    websocket.onclose = () => settle(undefined);
  });
}

export function isTargetTabUrl(url: string | undefined) {
  return Boolean(url) && TARGET_HOSTS.some(host => url!.includes(host));
}

export async function reloadTargetTabsOverCdp(cdpPort: number) {
  const tabs = (await fetchCdpTargets(cdpPort))
    .filter(({ type, url, webSocketDebuggerUrl }) => type === "page" && isTargetTabUrl(url) && webSocketDebuggerUrl);
  await Promise.all(
    tabs.map(({ webSocketDebuggerUrl }) => evaluateOverCdp({
      websocketUrl: webSocketDebuggerUrl!,
      expression: "location.reload()"
    }))
  );
}

// ── Session keepalive ───────────────────────────────────────────────────────────
//
// A long dev/reverse-engineering session leaves the browser idle while we work, so the portal's
// "יש פה מישהו?" dialog counts down and logs the session out (dropping the Tamuz search + our login).
// This is the ONLY keepalive - the shipped extension deliberately leaves the portal's idle policy
// alone, so the dev server holds the CDP connection and polls the top frame, clicking the site's own
// "המשך" (continue) button. Selectors are the SSOT ones from targets.ts; only the few lines of click
// glue are restated here as a CDP-eval string (a live DOM module can't be serialized to eval).

const SESSION_KEEPALIVE_INTERVAL_MS = 30_000;

function sessionKeepaliveExpression() {
  const dialogSelector = JSON.stringify(SESSION_TIMEOUT_DIALOG_SELECTOR);
  const continueSelectors = JSON.stringify([...SESSION_TIMEOUT_CONTINUE_SELECTORS]);
  const exitSource = JSON.stringify(SESSION_TIMEOUT_EXIT_HINT.source);
  const exitFlags = JSON.stringify(SESSION_TIMEOUT_EXIT_HINT.flags);
  return `(() => {
    const dialog = document.querySelector(${dialogSelector});
    if (!dialog || dialog.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(dialog);
    if (style.display === "none" || style.visibility === "hidden" || dialog.getBoundingClientRect().height === 0) {
      return false;
    }
    const exitHint = new RegExp(${exitSource}, ${exitFlags});
    for (const selector of ${continueSelectors}) {
      const button = dialog.querySelector(selector) || document.querySelector(selector);
      if (!button) continue;
      const signature = button.id + " " + button.className + " " + (button.textContent || "") + " " +
        (button.getAttribute("onclick") || "") + " " + (button.getAttribute("href") || "");
      if (!exitHint.test(signature)) { button.click(); return true; }
    }
    return false;
  })()`;
}

async function pollSessionKeepalive(cdpPort: number) {
  const tabs = (await fetchCdpTargets(cdpPort))
    .filter(({ type, url, webSocketDebuggerUrl }) => type === "page" && isTargetTabUrl(url) && webSocketDebuggerUrl);
  const expression = sessionKeepaliveExpression();
  for (const { webSocketDebuggerUrl } of tabs) {
    const clicked = await evaluateOverCdp({
      websocketUrl: webSocketDebuggerUrl!,
      expression
    });
    if (clicked === true) {
      logEvent("Session keepalive: clicked the portal 'המשך' on the idle dialog to hold the session");
    }
  }
}

export function startSessionKeepalive(cdpPort: number) {
  const timer = setInterval(() => {
    pollSessionKeepalive(cdpPort).catch(() => {});
  }, SESSION_KEEPALIVE_INTERVAL_MS);
  timer.unref();
  return timer;
}

/**
 * Evaluate the freshly built content-script bundles in every Clalit frame of one page target WITHOUT
 * reloading it (a reload resets the Tamuz booking SPA to its home screen, losing the search state).
 * The bundles' dev-takeover channel makes the previously injected generation stand down (see
 * src/lib/dev-takeover.ts). Both bundles are chrome-free, so evaluating them in each frame's main
 * world is equivalent to a real injection.
 */
function reinjectIntoTarget({ websocketUrl, bundles, extensionName }: {
  websocketUrl: string;
  bundles: {
    source: string;
    isMainWorld: boolean;
  }[];
  extensionName: string;
}) {
  return new Promise<void>(resolvePromise => {
    const websocket = new WebSocket(websocketUrl);
    const mainWorldContexts: number[] = [];
    // Latest context per frame: a frame that has been re-injected before carries stale worlds too.
    const extensionWorldContexts = new Map<string, number>();
    const pendingEvaluations = new Set<number>();
    let nextId = 1;
    let enableId = 0;

    function finish() {
      clearTimeout(timer);
      websocket.close();
      resolvePromise();
    }

    const timer = setTimeout(finish, 5000);

    function send({ method, params }: {
      method: string;
      params?: object;
    }) {
      const id = nextId++;
      websocket.send(
        JSON.stringify({
          id,
          method,
          params
        })
      );
      return id;
    }

    websocket.onopen = () => {
      enableId = send({ method: "Runtime.enable" });
    };
    websocket.onmessage = ({ data }) => {
      const { id, method, params }: {
        id?: number;
        method?: string;
        params?: {
          context?: {
            id: number;
            origin: string;
            name?: string;
            auxData?: {
              isDefault?: boolean;
              frameId?: string;
            };
          };
        };
      } = JSON.parse(String(data));
      if (method === "Runtime.executionContextCreated") {
        const context = params?.context;
        const { auxData, name } = context ?? {};
        if (context && auxData?.isDefault && isTargetTabUrl(context.origin)) {
          mainWorldContexts.push(context.id);
        } else if (context && auxData?.frameId && name === extensionName) {
          // Highest id wins, not last replayed: a frame can carry a stale extension world whose
          // chrome.* is already invalidated, and contexts are replayed in no guaranteed order.
          const known = extensionWorldContexts.get(auxData.frameId) ?? 0;
          extensionWorldContexts.set(auxData.frameId, Math.max(known, context.id));
        }

        return;
      }

      if (id === enableId) {
        // Pre-existing contexts are replayed before the enable ack, so the lists are complete here.
        // A frame with no extension world (the content scripts never ran there) still gets the bridge
        // in MAIN - a badge without the position beats no bridge at all.
        const isolatedContexts = [...extensionWorldContexts.values()];
        for (const { source, isMainWorld } of bundles) {
          const contexts = isMainWorld || !isolatedContexts.length ? mainWorldContexts : isolatedContexts;
          for (const contextId of contexts) {
            pendingEvaluations.add(
              send({
                method: "Runtime.evaluate",
                params: {
                  expression: source,
                  contextId
                }
              })
            );
          }
        }

        if (!pendingEvaluations.size) {
          finish();
        }

        return;
      }

      if (id !== undefined && pendingEvaluations.delete(id) && !pendingEvaluations.size) {
        finish();
      }
    };
    websocket.onerror = () => finish();
  });
}

/** Chrome names an extension's content-script world after the extension - the built manifest owns it. */
function builtExtensionName() {
  const manifestPath = join(OUTPUT_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    return "";
  }

  const { name } = JSON.parse(readFileSync(manifestPath, "utf-8"));
  return typeof name === "string" ? name : "";
}

export async function reinjectContentScriptsOverCdp(cdpPort: number) {
  const bundles = CONTENT_SCRIPT_BUNDLES.filter(({ path }) => existsSync(path)).map(({ path, isMainWorld }) => ({
    source: readFileSync(path, "utf-8"),
    isMainWorld
  }));
  if (bundles.length < CONTENT_SCRIPT_BUNDLES.length) {
    logEvent("Re-inject: some built bundles are missing - did the build output move?");
  }

  const extensionName = builtExtensionName();
  const tabs = (await fetchCdpTargets(cdpPort))
    .filter(({ type, url, webSocketDebuggerUrl }) => type === "page" && isTargetTabUrl(url) && webSocketDebuggerUrl);
  await Promise.all(
    tabs.map(({ webSocketDebuggerUrl }) => reinjectIntoTarget({
      websocketUrl: webSocketDebuggerUrl!,
      bundles,
      extensionName
    }))
  );
  return tabs.length;
}

// ── Browser target ──────────────────────────────────────────────────────────────
export type WebExtRunner = Awaited<ReturnType<typeof webExtRun.cmd.run>>;

export type BrowserTarget = {
  name: string;
  outputDir: string;
  setupProfile: () => string;
  launch: (profileDirectory: string) => Promise<{
    runner: WebExtRunner;
    cdpPort: number;
  }>;
};

function suppressWebExtInfoLogs() {
  const WARN_LOG_LEVEL = 40;
  webExtConsoleStream.write = ({ level, msg: message }) => {
    if (level >= WARN_LOG_LEVEL) {
      console.warn(message);
    }
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
export async function runDevServer(target: BrowserTarget) {
  process.chdir(PROJECT_ROOT);
  initDevLog();

  const profileDirectory = target.setupProfile();

  console.log("Building extension (development + inline source maps)...");
  await runBuildWithFsRetry();
  console.log("Build complete.\n");

  suppressWebExtInfoLogs();
  const { runner, cdpPort } = await target.launch(profileDirectory);
  logEvent(`${target.name} launched with extension sideloaded (CDP on 127.0.0.1:${cdpPort}).`);
  startSessionKeepalive(cdpPort);
  console.log("Watching for file changes...\n");

  let isRebuilding = false;
  let pendingChange: string | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;

  async function rebuildAndReload(filePath: string) {
    const startedAt = Date.now();
    logEvent(`Change detected: ${filePath} - rebuilding`);
    try {
      await runBuildWithFsRetry();
      await runner.reloadAllExtensions();

      // src changes re-inject into live pages (keeps SPA state); manifest-shaping files (wxt.config,
      // .env) change what the browser must load fresh, so those still reload the open tabs.
      if (filePath.startsWith("src")) {
        const tabCount = await reinjectContentScriptsOverCdp(cdpPort);
        logEvent(`Re-injected into ${tabCount} tab(s) (${Date.now() - startedAt}ms) - page state kept`);
      } else {
        await reloadTargetTabsOverCdp(cdpPort);
        logEvent(`Reloaded (${Date.now() - startedAt}ms) - extension + open Clalit tabs`);
      }
    } catch (error) {
      logEvent("Rebuild failed:");
      console.error(error);
    }
  }

  async function drainPendingRebuild() {
    if (isRebuilding) {
      return;
    }

    isRebuilding = true;
    while (pendingChange !== undefined) {
      const filePath = pendingChange;
      pendingChange = undefined;
      await rebuildAndReload(filePath);
    }
    isRebuilding = false;
  }

  function scheduleRebuild(filePath: string) {
    pendingChange = filePath;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      drainPendingRebuild().catch(() => {});
    }, REBUILD_DEBOUNCE_MS);
  }

  const watcher = chokidar.watch(["src", "wxt.config.ts", ...wxtEnvFiles()], {
    cwd: PROJECT_ROOT.replaceAll("\\", "/"),
    ignoreInitial: true,
    usePolling: true,
    interval: 500
  });
  watcher.on("error", error => {
    logEvent("Watcher error:");
    console.error(error);
  });
  watcher.on("all", (_event, filePath) => scheduleRebuild(filePath));

  let isExiting = false;
  async function exit() {
    if (isExiting) {
      return;
    }

    isExiting = true;
    logEvent("Shutting down - closing watcher and browser");
    setTimeout(() => process.exit(0), 3000).unref();
    await watcher.close().catch(() => {});
    await runner.exit().catch(() => {});
    process.exit(0);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logEvent(`Received ${signal}`);
      exit().catch(() => {});
    });
  }

  runner.registerCleanup(() => {
    logEvent(`${target.name} closed (web-ext cleanup fired)`);
    exit().catch(() => {});
  });

  await new Promise(() => {});
}
