import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Configuration is intentionally tiny and dependency-free. Values already supplied by
// the process always win; local env files are only a convenience for development.
const root = resolve(process.env.INIT_CWD ?? process.cwd());
const explicitlyConfigured = process.env.SIGNALGRID_ENV_FILE?.trim();
// An explicit private file or local `.env` always wins. The checked-in
// `.env.example` is a copyable template, never an implicit secret source.
// Keep the old public-template name as a compatibility fallback for older
// working copies that have not yet been refreshed.
const candidates = [explicitlyConfigured ? resolve(root, explicitlyConfigured) : null, resolve(root, ".env"), resolve(root, ".env.public.example"), resolve(root, "../../.env")].filter((path): path is string => Boolean(path));
const envPath = candidates.find(existsSync);
if (envPath) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = value.replace(/^(['"])(.*)\1$/, "$2");
  }
}

