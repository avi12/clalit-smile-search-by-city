/**
 * Loads the development-mode dotenv cascade into process.env before dev script modules initialise.
 * WXT loads env for wxt.config.ts automatically; tsx does not.
 *
 * process.loadEnvFile does NOT overwrite a var that is already set, so load highest-priority FIRST to
 * mirror Vite/WXT development precedence (.env.development.local > .env.development > .env.local > .env).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
for (const file of [".env.development.local", ".env.development", ".env.local", ".env"]) {
  const path = resolve(ROOT, file);
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

function parseEnvFile(path: string) {
  const entries: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    const isCommentOrBlank = !line || line.startsWith("#");
    const equalsIndex = line.indexOf("=");
    if (isCommentOrBlank || equalsIndex === -1) {
      continue;
    }

    entries[line.slice(0, equalsIndex).trim()] = line.slice(equalsIndex + 1).trim();
  }
  return entries;
}

/** Re-read the dev dotenv cascade and OVERWRITE process.env so an edited value reaches the next rebuild. */
export function reloadDevEnv() {
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    const path = resolve(ROOT, file);
    if (existsSync(path)) {
      Object.assign(process.env, parseEnvFile(path));
    }
  }
}
