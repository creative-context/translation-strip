// Folders, the port and the time limits. Read once, when imported: nothing here starts anything.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const PUBLIC_DIR = join(ROOT, "public");

// The app folder: ~/.translation-strip, or STRIP_DIR (tests and the demo always set it).
export const STRIP_DIR = process.env.STRIP_DIR || join(homedir(), ".translation-strip");
export const SETTINGS_FILE = join(STRIP_DIR, "settings.json");
export const TRANSLATOR_DIR = join(STRIP_DIR, "translator"); // the hidden session's working folder

export const PORT = Number(process.env.STRIP_PORT) || 4810;
export const PARENT_ENV = "STRIP_PARENT_PID";

// The claude command: STRIP_CLAUDE (tests use a stand-in), or `claude` from the PATH.
export const CLAUDE = process.env.STRIP_CLAUDE || "claude";

export const TIMEOUT_MS = Number(process.env.STRIP_TIMEOUT_MS) || 45_000; // one request, then failed and a restart
export const MAX_MESSAGES = 50; // a fresh session after this many requests
export const LINT_TIMEOUT_MS = 10_000;
