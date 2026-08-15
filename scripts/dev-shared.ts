/**
 * Dev-server infrastructure. It builds the WXT development bundle (inline source maps), launches Chrome
 * with the extension sideloaded against a CLONED copy of your real Chrome profile (so the dev browser
 * carries your Clalit login yet never touches your real session), and hot-reloads on change.
 *
 * On a `src/` change it rebuilds and EVALUATES the fresh bundles straight into the open Clalit tabs over
 * CDP, so the booking SPA keeps its state and the extension is never reloaded - a reload would revoke
 * every open tab's isolated world. A reload is reserved for what Chrome caches and only a reload
 * refreshes (the manifest, the background worker, the offscreen document), and it takes those tabs with
 * it. The CDP port it launches is a fixed one, so a devtools client can attach to the same browser.
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
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { inspect } from "node:util";
import webExtRun from "web-ext-run";
import { consoleStream as webExtConsoleStream } from "web-ext-run/util/logger";
import { build } from "wxt";

// ── Dev log ────────────────────────────────────────────────────────────────────
const DEV_LOG_DIR = resolve(import.meta.dirname, "..", ".dev-logs");
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
const PROJECT_ROOT = resolve(import.meta.dirname, "..");
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
type CdpTarget = {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

async function fetchCdpTargets(cdpPort: number) {
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

function isTargetTabUrl(url: string | undefined) {
  return Boolean(url) && TARGET_HOSTS.some(host => url!.includes(host));
}

async function reloadTargetTabsOverCdp(cdpPort: number) {
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

function startSessionKeepalive(cdpPort: number) {
  const timer = setInterval(() => {
    pollSessionKeepalive(cdpPort).catch(() => {});
  }, SESSION_KEEPALIVE_INTERVAL_MS);
  timer.unref();
  return timer;
}

/**
 * Re-injection is the dev server's own job, over CDP, and the extension knows nothing about it.
 *
 * The freshly built bundles are evaluated into every Clalit frame of a live page - the interceptor into
 * the frame's MAIN world, the bridge into the EXTENSION's own isolated world, because it talks to the
 * background for the position and a copy in MAIN has no `chrome.*` to talk with. The page is never
 * reloaded (that would reset the Tamuz booking SPA to its home screen) and the previous generation
 * stands down over the dev-takeover channel (src/lib/dev-takeover.ts).
 *
 * This only works while those isolated worlds are ALIVE, which is why the extension is no longer
 * reloaded on every rebuild: an extension reload revokes every open tab's world (`chrome.runtime.id`
 * gone, "Extension context invalidated") and Chrome will not make a new one without a navigation. So a
 * reload is reserved for the builds that actually need it - see `reloadFingerprint`.
 */
const CONTENT_SCRIPT_BUNDLES = [
  {
    path: join(OUTPUT_DIR, "content-scripts", "clalit-interceptor.js"),
    isMainWorld: true
  },
  {
    path: join(OUTPUT_DIR, "content-scripts", "clalit-bridge.js"),
    isMainWorld: false
  },
  // ORDER MATTERS, and only here: this one announces that the document is parsed, and the interceptor
  // above is what listens for it. Evaluated in array order over the one CDP session, so the listener is
  // registered before the announcement - which is also how the browser orders them, document_start
  // before document_end.
  {
    path: join(OUTPUT_DIR, "content-scripts", "clalit-dom-ready.js"),
    isMainWorld: true
  }
];

/** Stamped on a tab's MAIN world by every injection, so a tab that missed one can be spotted. */
const BUILD_STAMP_PROPERTY = "__clalitCityDevBuild";

// Standing the previous generation down is NOT the dev server's business, and it is not the extension's
// own invention either: WXT's ContentScriptContext already announces every content script that starts
// and aborts the older one of the same name (`wxt:content-script-started`). The content scripts hang
// their listeners, their patches and their UI on that ctx, so evaluating a fresh bundle here is all the
// handoff there is - see src/entrypoints/*.content.ts.

/** The extension's name, which is also what Chrome names its content-script world. */
function builtExtensionName() {
  const manifestPath = join(OUTPUT_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    return "";
  }

  const { name } = JSON.parse(readFileSync(manifestPath, "utf-8"));
  return typeof name === "string" ? name : "";
}

/**
 * What Chrome holds a cached copy of and only a reload can refresh: the manifest, the background worker
 * and the offscreen document. Content-script files are NOT in here - those are what the injection
 * replaces - so an ordinary `src/` change never costs the page its state.
 */
function reloadFingerprint() {
  const watched = ["manifest.json", "background.js", "offscreen.html"];
  return watched
    .map(name => {
      const path = join(OUTPUT_DIR, name);
      return existsSync(path) ? createHash("sha1").update(readFileSync(path)).digest("hex") : "";
    })
    .join("-");
}

/** A build's identity, for the stamp: two bundles' content and nothing else. */
function bundleFingerprint(sources: string[]) {
  return createHash("sha1").update(sources.join("\n")).digest("hex").slice(0, 12);
}

/**
 * The extension page the injection is run from. Chrome does NOT start an MV3 service worker just
 * because its extension reloaded - it waits for an event that never comes here - and a dormant worker
 * has no CDP target to talk to at all. An extension PAGE has the same `chrome.*`, and this one is the
 * extension's own offscreen document, which does nothing on load but read a position and report it.
 */
/**
 * Evaluate the built bundles in every Clalit frame of one page target, each into the world it is
 * declared for, and stamp the tab with the build it now runs.
 */
function injectIntoTarget({ websocketUrl, bundles, extensionName }: {
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
    // Latest context per frame: a frame that has been injected into before carries stale worlds too.
    const extensionWorldContexts = new Map<string, number>();
    const pendingEvaluations = new Set<number>();
    let nextId = 1;
    let enableId = 0;

    function finish() {
      clearTimeout(timer);
      websocket.close();
      resolvePromise();
    }

    const timer = setTimeout(finish, CDP_EVALUATE_TIMEOUT_MS);

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
          // Highest id wins, not last replayed: contexts are replayed in no guaranteed order.
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

/**
 * Inject, then stamp the tab with the build it now runs - through the SAME top-frame world the stamp is
 * later read from, so "is this tab current?" is asked and answered in one place. A navigation wipes it,
 * which is exactly what makes a reloaded tab (running Chrome's cached content scripts) detectable.
 */
async function injectAndStamp({ websocketUrl, bundles, extensionName, buildId }: {
  websocketUrl: string;
  bundles: {
    source: string;
    isMainWorld: boolean;
  }[];
  extensionName: string;
  buildId: string;
}) {
  await injectIntoTarget({
    websocketUrl,
    bundles,
    extensionName
  });
  await evaluateOverCdp({
    websocketUrl,
    expression: `window.${BUILD_STAMP_PROPERTY} = ${JSON.stringify(buildId)}`
  });
}

function builtBundles() {
  const bundles = CONTENT_SCRIPT_BUNDLES
    .filter(({ path }) => existsSync(path))
    .map(({ path, isMainWorld }) => ({
      source: readFileSync(path, "utf-8"),
      isMainWorld
    }));
  if (bundles.length < CONTENT_SCRIPT_BUNDLES.length) {
    logEvent("Inject: some built bundles are missing - did the build output move?");
  }

  return bundles;
}

async function reinjectContentScriptsOverCdp(cdpPort: number) {
  const bundles = builtBundles();
  const buildId = bundleFingerprint(bundles.map(({ source }) => source));
  const extensionName = builtExtensionName();
  const tabs = (await fetchCdpTargets(cdpPort))
    .filter(({ type, url, webSocketDebuggerUrl }) => type === "page" && isTargetTabUrl(url) && webSocketDebuggerUrl);
  await Promise.all(
    tabs.map(({ webSocketDebuggerUrl }) => injectAndStamp({
      websocketUrl: webSocketDebuggerUrl!,
      bundles,
      extensionName,
      buildId
    }))
  );
  return tabs.length;
}

// ── Keeping every tab on the current build ────────────────────────────────────
//
// The extension is deliberately not reloaded on a content-script change, so what Chrome injects on its
// own - into a tab the user reloads, or a Clalit tab opened later - is the copy it cached when the
// extension was loaded, which goes stale the moment anything is rebuilt. The dev server closes that gap
// itself: it asks each Clalit tab which build it is stamped with, and injects into the ones that are
// behind. A tab that just reloaded therefore runs the current code within one tick, without anyone
// having to touch chrome://extensions.

const INJECTION_RECONCILE_INTERVAL_MS = 3000;

async function reconcileInjections(cdpPort: number) {
  const bundles = builtBundles();
  const buildId = bundleFingerprint(bundles.map(({ source }) => source));
  const extensionName = builtExtensionName();
  const tabs = (await fetchCdpTargets(cdpPort))
    .filter(({ type, url, webSocketDebuggerUrl }) => type === "page" && isTargetTabUrl(url) && webSocketDebuggerUrl);
  for (const { webSocketDebuggerUrl } of tabs) {
    const stamp = await evaluateOverCdp({
      websocketUrl: webSocketDebuggerUrl!,
      expression: `window.${BUILD_STAMP_PROPERTY} ?? null`
    });
    if (stamp === buildId) {
      continue;
    }

    await injectAndStamp({
      websocketUrl: webSocketDebuggerUrl!,
      bundles,
      extensionName,
      buildId
    });
    logEvent("Injected the current build into a tab that was running Chrome's cached copy");
  }
}

function startInjectionReconcile(cdpPort: number) {
  const timer = setInterval(() => {
    reconcileInjections(cdpPort).catch(() => {});
  }, INJECTION_RECONCILE_INTERVAL_MS);
  timer.unref();
  return timer;
}

// ── Browser target ──────────────────────────────────────────────────────────────
type WebExtRunner = Awaited<ReturnType<typeof webExtRun.cmd.run>>;

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
  startInjectionReconcile(cdpPort);
  console.log("Watching for file changes...\n");

  let isRebuilding = false;
  let pendingChange: string | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;

  let loadedFingerprint = reloadFingerprint();

  /**
   * A content-script change is injected and the page keeps its state; a change to what Chrome holds a
   * CACHED copy of - the manifest, the background worker, the offscreen document - is the only thing
   * that costs an extension reload, and a reload costs the open tabs (it revokes their worlds, so they
   * are reloaded too rather than left with a bridge that cannot reach the background).
   */
  async function rebuildAndReload(filePath: string) {
    const startedAt = Date.now();
    logEvent(`Change detected: ${filePath} - rebuilding`);
    try {
      await runBuildWithFsRetry();
      const fingerprint = reloadFingerprint();
      const isReloadNeeded = fingerprint !== loadedFingerprint;
      loadedFingerprint = fingerprint;

      if (isReloadNeeded) {
        await runner.reloadAllExtensions();
        await reloadTargetTabsOverCdp(cdpPort);
        logEvent(`Reloaded (${Date.now() - startedAt}ms) - manifest/background changed, so tabs reload too`);
        return;
      }

      const tabCount = await reinjectContentScriptsOverCdp(cdpPort);
      logEvent(`Injected into ${tabCount} tab(s) (${Date.now() - startedAt}ms) - page state kept`);
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
