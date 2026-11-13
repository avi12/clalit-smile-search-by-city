/**
 * Release artifacts for a Chrome-only extension: the store-ready zip and a signed .crx for anyone who
 * installs it by hand.
 *
 * The CRX is packed by Chrome itself (`--pack-extension`), because Chrome's own packer is the only
 * thing guaranteed to agree with the browser that has to load it. The signing key IS the extension's
 * identity - the same key must sign every release or the CRX installs as a different extension - so it
 * lives outside the repo (`keys/` is gitignored) and is pointed at by `CHROME_CRX_PRIVATE_KEY_PATH`.
 * With no key at that path, one is generated there on the first run and must then be kept.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

interface PackageJson {
  version: string;
}

const REPO_ROOT = resolve(import.meta.dirname, "..");
const ARTIFACTS_DIR = resolve(REPO_ROOT, ".output");
const CHROME_BUILD_DIR = resolve(ARTIFACTS_DIR, "chrome-mv3");
const DEFAULT_KEY_PATH = resolve(REPO_ROOT, "keys", "chrome.pem");

try {
  process.loadEnvFile();
} catch {
  // .env is optional - the key path falls back to keys/chrome.pem
}

const { version }: PackageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));
const zipPath = resolve(ARTIFACTS_DIR, `clalit-smile-search-by-city-${version}-chrome.zip`);
const crxPath = resolve(ARTIFACTS_DIR, `clalit-smile-search-by-city-${version}-chrome.crx`);
const keyPath = process.env.CHROME_CRX_PRIVATE_KEY_PATH ?? DEFAULT_KEY_PATH;

buildAndZip();
packCrx();

console.log("Release artifacts:");
console.log(`  ${zipPath}`);
console.log(`  ${crxPath}`);

function buildAndZip() {
  runPnpm(["ext:build"]);
  runPnpm(["ext:zip"]);
  assertArtifact({ path: zipPath, label: "Chrome zip" });
}

/**
 * Chrome writes `<dir>.crx` beside the build directory, and - when it had to generate the key - a
 * `<dir>.pem` next to it, which is the one file that must not be lost between releases.
 */
function packCrx() {
  const chromeBinary = findChromeBinary();
  if (!chromeBinary) {
    fail("Could not locate a Chrome binary to pack the .crx; set CHROME_BIN");
  }

  if (!existsSync(CHROME_BUILD_DIR)) {
    fail(`Chrome build not found at ${CHROME_BUILD_DIR}`);
  }

  const isExistingKey = existsSync(keyPath);
  if (!isExistingKey) {
    console.log(`No signing key at ${keyPath} - Chrome will generate one. KEEP IT: it is this extension's identity.`);
    mkdirSync(dirname(keyPath), { recursive: true });
  }

  const result = spawnSync(
    chromeBinary,
    [
      `--pack-extension=${CHROME_BUILD_DIR}`,
      ...(isExistingKey ? [`--pack-extension-key=${keyPath}`] : []),
      "--no-message-box"
    ],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    fail("Chrome --pack-extension failed");
  }

  const generatedKeyPath = `${CHROME_BUILD_DIR}.pem`;
  if (!isExistingKey && existsSync(generatedKeyPath)) {
    renameSync(generatedKeyPath, keyPath);
    console.log(`Signing key written to ${keyPath}`);
  }

  const packedCrxPath = `${CHROME_BUILD_DIR}.crx`;
  assertArtifact({ path: packedCrxPath, label: "packed Chrome CRX" });
  copyFileSync(packedCrxPath, crxPath);
  assertArtifact({ path: crxPath, label: "Chrome CRX" });
}

function findChromeBinary() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }

  return chromeCandidatesFor(process.platform).find(path => existsSync(path)) ?? null;
}

function chromeCandidatesFor(platform: NodeJS.Platform) {
  if (platform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ];
  }

  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }

  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
}

function runPnpm(args: string[]) {
  const result = spawnSync("pnpm", args, {
    stdio: "inherit",
    shell: true
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function assertArtifact({ path, label }: { path: string; label: string }) {
  if (!existsSync(path)) {
    fail(`${label} not found at ${basename(path)}`);
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
