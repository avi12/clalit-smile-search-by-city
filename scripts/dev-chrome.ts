/**
 * Chrome dev target: clone the user's real Chrome profile into ./user-profiles/chrome (so the dev
 * browser carries their Clalit login but is fully decoupled from their real session), then launch it
 * with the unpacked extension via web-ext-run, exposing a FIXED CDP port (CDP_PORT below) so
 * chrome-devtools-mcp can attach to this exact instance.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import webExtRun from "web-ext-run";

import { type BrowserTarget, cloneFile, logEvent, OUTPUT_DIR, START_URL, USER_PROFILES_DIR } from "./dev-shared";

// Fixed so the MCP / verification can always reach this instance. This is the single source of truth
// for the port, but .mcp.json cannot import it - when changing it, update .mcp.json's --browser-url to
// match. Not 9222: other apps (e.g. WebView2-embedded ones) commonly squat on that default.
export const CDP_PORT = 9223;
const DEFAULT_CHROMIUM_PROFILE_NAME = "Default";

// Files worth cloning so the dev browser is usable + carries the Clalit session.
const CHROMIUM_USERDATA_FILES = ["Local State"];
const CHROMIUM_DEFAULT_FILES = [
  "Preferences",
  "Secure Preferences",
  "Bookmarks",
  "Login Data",
  "Login Data For Account",
  "History",
  "Favicons",
  "Web Data",
  "Top Sites"
];
const CHROMIUM_DEFAULT_NETWORK_FILES = ["Cookies", "Network Persistent State", "TransportSecurity"];

const { LOCALAPPDATA = "" } = process.env;
const SOURCE_USER_DATA: Partial<Record<NodeJS.Platform, string>> = {
  win32: join(LOCALAPPDATA, "Google", "Chrome", "User Data"),
  darwin: join(homedir(), "Library", "Application Support", "Google", "Chrome"),
  linux: join(homedir(), ".config", "google-chrome")
};

// web-ext-run's CDP Extensions.loadUnpacked requires developer mode enabled in the cloned profile.
function ensureDeveloperMode(profileDir: string) {
  const preferencesPath = join(profileDir, "Default", "Preferences");
  mkdirSync(dirname(preferencesPath), { recursive: true });
  const preferences = existsSync(preferencesPath) ? JSON.parse(readFileSync(preferencesPath, "utf-8")) : {};
  const { extensions } = preferences;
  preferences.extensions = {
    ...extensions,
    ui: {
      ...extensions?.ui,
      developer_mode: true
    }
  };
  delete preferences.protection;
  writeFileSync(preferencesPath, JSON.stringify(preferences));
}

function setupChromiumProfile(profileDir: string) {
  const sentinel = join(profileDir, "Default", ".seeded");
  if (existsSync(sentinel)) {
    ensureDeveloperMode(profileDir);
    return profileDir;
  }

  const source = SOURCE_USER_DATA[platform()];
  const sourceProfileName = process.env.DEV_CHROME_SOURCE_PROFILE ?? DEFAULT_CHROMIUM_PROFILE_NAME;
  const sourceDefault = source && join(source, sourceProfileName);
  if (!sourceDefault || !existsSync(sourceDefault)) {
    mkdirSync(join(profileDir, "Default"), { recursive: true });
    writeFileSync(sentinel, "");
    return profileDir;
  }

  console.log(`Cloning Default profile from ${sourceDefault}...`);
  for (const file of CHROMIUM_USERDATA_FILES) {
    cloneFile({
      sourcePath: join(source, file),
      destinationPath: join(profileDir, file)
    });
  }

  const destinationDefault = join(profileDir, "Default");
  for (const file of CHROMIUM_DEFAULT_FILES) {
    cloneFile({
      sourcePath: join(sourceDefault, file),
      destinationPath: join(destinationDefault, file)
    });
  }

  for (const file of CHROMIUM_DEFAULT_NETWORK_FILES) {
    cloneFile({
      sourcePath: join(sourceDefault, "Network", file),
      destinationPath: join(destinationDefault, "Network", file)
    });
  }

  ensureDeveloperMode(profileDir);
  console.log("Profile setup complete.");
  writeFileSync(sentinel, "");
  return profileDir;
}

async function launch(profileDirectory: string) {
  const runner = await webExtRun.cmd.run(
    {
      target: "chromium",
      sourceDir: OUTPUT_DIR,
      startUrl: [START_URL],
      keepProfileChanges: true,
      chromiumProfile: profileDirectory,
      args: [
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${CDP_PORT}`,
        "--no-first-run",
        "--no-default-browser-check",
        `--profile-directory=${DEFAULT_CHROMIUM_PROFILE_NAME}`,
        "--disable-blink-features=AutomationControlled"
      ],
      noReload: true,
      noInput: true
    },
    { shouldExitProgram: false }
  );
  logEvent(`chrome-devtools-mcp can attach with --browser-url http://127.0.0.1:${CDP_PORT}`);
  return {
    runner,
    cdpPort: CDP_PORT
  };
}

export const chromeTarget: BrowserTarget = {
  name: "Chrome",
  outputDir: OUTPUT_DIR,
  setupProfile: () => setupChromiumProfile(join(USER_PROFILES_DIR, "chrome")),
  launch
};
