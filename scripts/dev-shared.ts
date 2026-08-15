/**
 * Dev-server infrastructure. It builds the WXT development bundle (inline source maps), launches Chrome
 * with the extension sideloaded against a CLONED copy of your real Chrome profile (so the dev browser
 * carries your Clalit login yet never touches your real session), and hot-reloads on change.
 *
 * On a change it rebuilds and reloads the extension (web-ext over CDP); a `src/` change then has the
 * reloaded extension inject its own content scripts back into the open Clalit tabs, so the booking SPA
 * keeps its state, while a manifest-shaping change reloads those tabs outright. The CDP port it
 * launches is reused to drive the browser for verification (see scripts/verify-city-filter.ts).
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
  id?: string;
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

// A target listed by CDP can already be gone - a reloaded extension's service worker leaves its old
// socket behind, and connecting to it neither answers nor closes. Every evaluation is bounded.
const CDP_EVALUATE_TIMEOUT_MS = 3000;

/**
 * Evaluate an expression in a target's own context (a page's top-frame main world, or an extension's
 * service worker); resolves with its (by-value) result, awaiting a promise the expression returns, and
 * with `undefined` if the target does not answer.
 */
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
      clearTimeout(timer);
      websocket.close();
      resolvePromise(value);
    }

    const timer = setTimeout(() => settle(undefined), CDP_EVALUATE_TIMEOUT_MS);

    websocket.onopen = () =>
      websocket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression,
            returnByValue: true,
            awaitPromise: true
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
 * Re-injection runs INSIDE the extension, not over CDP's Runtime.evaluate.
 *
 * A rebuild reloads the extension, and a reload revokes every open tab's isolated world: the world
 * keeps running, but its `chrome.*` is gone ("Extension context invalidated"), so a bridge evaluated
 * back into it can no longer reach the background and the position silently answers null. Only the
 * extension itself can put a FRESH world into a live tab, so the extension is asked to inject its own
 * content scripts. The page is never reloaded (that would reset the Tamuz booking SPA to its home
 * screen), and the previous generation stands down over the dev-takeover channel (dev-takeover.ts).
 *
 * The expression reads the MANIFEST for what to inject, into which world and which tabs - the dev
 * server drives the injection but never restates the content-script list.
 */
const REINJECT_EXPRESSION = `(async () => {
  const isMainWorld = entry => entry.world === "MAIN";
  // MAIN first: the interceptor's patches must be in place before the bridge pushes config at it.
  const entries = [...chrome.runtime.getManifest().content_scripts]
    .sort((a, b) => Number(isMainWorld(b)) - Number(isMainWorld(a)));
  const tabs = await chrome.tabs.query({ url: [...new Set(entries.flatMap(entry => entry.matches))] });
  for (const entry of entries) {
    for (const tab of tabs) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: entry.all_frames === true },
        files: entry.js,
        world: isMainWorld(entry) ? "MAIN" : "ISOLATED",
        injectImmediately: true
      }).catch(() => {});
    }
  }
  return tabs.length;
})()`;

/**
 * Every unpacked extension's id, as the extensions manager itself knows them. `chrome.developerPrivate`
 * exists only on `chrome://extensions`, which is why that page is opened to ask - web-ext drives its own
 * reloads from exactly there, so the page is usually already open.
 */
function unpackedExtensionIdExpression(extensionName: string) {
  return `new Promise(resolve => {
    const developerPrivate = chrome.developerPrivate;
    if (!developerPrivate || !developerPrivate.getExtensionsInfo) { resolve(null); return; }
    developerPrivate.getExtensionsInfo(extensions => {
      const own = (extensions || []).find(extension =>
        extension.location === "UNPACKED" && extension.name === ${JSON.stringify(extensionName)});
      resolve(own ? own.id : null);
    });
  })`;
}

/** The extension's name, from the manifest that was just built - the id is looked up by it. */
function builtExtensionName() {
  const manifestPath = join(OUTPUT_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    return "";
  }

  const { name } = JSON.parse(readFileSync(manifestPath, "utf-8"));
  return typeof name === "string" ? name : "";
}

/** Ask the BROWSER endpoint (a page target cannot open targets) and hand back the reply's result. */
async function sendBrowserCommand({ cdpPort, method, params }: {
  cdpPort: number;
  method: string;
  params: object;
}) {
  const version = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(response => response.json())
    .catch(() => null);
  const websocketUrl: unknown = version?.webSocketDebuggerUrl;
  if (typeof websocketUrl !== "string") {
    return null;
  }

  return await new Promise<unknown>(resolvePromise => {
    const websocket = new WebSocket(websocketUrl);
    let settled = false;
    function settle(value: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      websocket.close();
      resolvePromise(value);
    }

    const timer = setTimeout(() => settle(null), CDP_EVALUATE_TIMEOUT_MS);
    websocket.onopen = () => websocket.send(
      JSON.stringify({
        id: 1,
        method,
        params
      })
    );
    websocket.onmessage = ({ data }) => {
      const message: {
        id?: number;
        result?: unknown;
      } = JSON.parse(String(data));
      if (message.id === 1) {
        settle(message.result ?? null);
      }
    };
    websocket.onerror = () => settle(null);
    websocket.onclose = () => settle(null);
  });
}

const TARGET_WAIT_ATTEMPTS = 20;
const TARGET_WAIT_DELAY_MS = 150;

/**
 * The page at `url`, opened in a minimized window of its own if it is not already there - minimized so
 * the dev browser's own window keeps focus while the injection runs behind it.
 */
async function targetForUrl({ cdpPort, url }: {
  cdpPort: number;
  url: string;
}) {
  async function findTarget() {
    return (await fetchCdpTargets(cdpPort))
      .find(target => target.url?.startsWith(url) && target.webSocketDebuggerUrl);
  }

  const existing = await findTarget();
  if (existing) {
    return existing;
  }

  await sendBrowserCommand({
    cdpPort,
    method: "Target.createTarget",
    params: {
      url,
      newWindow: true,
      windowState: "minimized"
    }
  });

  for (let attempt = 1; attempt <= TARGET_WAIT_ATTEMPTS; attempt++) {
    const opened = await findTarget();
    if (opened) {
      return opened;
    }

    await new Promise(resolvePromise => setTimeout(resolvePromise, TARGET_WAIT_DELAY_MS));
  }

  return undefined;
}

/**
 * The extension page the injection is run from. Chrome does NOT start an MV3 service worker just
 * because its extension reloaded - it waits for an event that never comes here - and a dormant worker
 * has no CDP target to talk to at all. An extension PAGE has the same `chrome.*`, and this one is the
 * extension's own offscreen document, which does nothing on load but read a position and report it.
 */
const EXTENSIONS_MANAGER_URL = "chrome://extensions";
const INJECTOR_PAGE_PATH = "/offscreen.html";
let injectorPageUrl: string | undefined;

async function injectorTarget(cdpPort: number) {
  if (!injectorPageUrl) {
    const elManager = await targetForUrl({
      cdpPort,
      url: EXTENSIONS_MANAGER_URL
    });
    const extensionId = elManager
      ? await evaluateOverCdp({
        websocketUrl: elManager.webSocketDebuggerUrl!,
        expression: unpackedExtensionIdExpression(builtExtensionName())
      })
      : null;
    if (typeof extensionId !== "string") {
      return undefined;
    }

    injectorPageUrl = `chrome-extension://${extensionId}${INJECTOR_PAGE_PATH}`;
  }

  return await targetForUrl({
    cdpPort,
    url: injectorPageUrl
  });
}

export async function reinjectContentScriptsOverCdp(cdpPort: number) {
  const target = await injectorTarget(cdpPort);
  const injectedTabCount = target
    ? await evaluateOverCdp({
      websocketUrl: target.webSocketDebuggerUrl!,
      expression: REINJECT_EXPRESSION
    })
    : null;
  // The next reload would kill this page anyway; closing it keeps one minimized window from becoming
  // one per rebuild, and the position read it does on load from happening again while it sits there.
  if (target?.id) {
    await sendBrowserCommand({
      cdpPort,
      method: "Target.closeTarget",
      params: {
        targetId: target.id
      }
    });
  }

  if (typeof injectedTabCount === "number") {
    return injectedTabCount;
  }

  logEvent("Re-inject: the extension did not answer - open tabs still run the previous build");
  return 0;
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
