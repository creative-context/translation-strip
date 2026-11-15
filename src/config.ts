// Folders, the port and the time limits. Read once, when imported: nothing here starts anything.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const PUBLIC_DIR = join(ROOT, "public");

// The app folder: ~/.translation-strip, or STRIP_DIR (tests and the demo always set it).
export const STRIP_DIR = process.env.STRIP_DIR || join(homedir(), ".translation-strip");
export const SETTINGS_FILE = join(STRIP_DIR, "settings.json");
export const TRANSLATOR_DIR = join(STRIP_DIR, "translator"); // the hidden session's working folder

// The app passes STRIP_PORT=4810; run by hand, the server uses 4812, so it never answers in the app's place.
export const PORT = Number(process.env.STRIP_PORT) || 4812;
export const PARENT_ENV = "STRIP_PARENT_PID";

// The claude command: STRIP_CLAUDE (tests use a stand-in), or `claude` from the PATH.
export const CLAUDE = process.env.STRIP_CLAUDE || "claude";

export const TIMEOUT_MS = Number(process.env.STRIP_TIMEOUT_MS) || 45_000; // one request, then failed and a restart
export const STDERR_KEEP = 2048; // bytes of each session's stderr held in memory, to classify an exit
export const MAX_RESTARTS = 5; // restarts after a failure, within RESTART_WINDOW_MS; past that, error until a request
export const RESTART_WINDOW_MS = 10 * 60_000;
export const SLEEP_GAP_MS = 30_000; // more than this between ticks: the Mac slept, so the spare is replaced
// The day the translator thinks it is, for tests: the text of this file, when STRIP_DAY_FILE is set and the file
// has something in it. Otherwise the real date, as always.
export const DAY_FILE = process.env.STRIP_DAY_FILE || "";
// The clock the tick reads, for tests: the real time plus the milliseconds written in this file, when
// STRIP_CLOCK_FILE is set and the file holds a number. Otherwise the real time.
export const CLOCK_FILE = process.env.STRIP_CLOCK_FILE || "";
export function clock(): number {
  if (CLOCK_FILE) {
    try {
      const n = Number(readFileSync(CLOCK_FILE, "utf8").trim());
      if (Number.isFinite(n)) return Date.now() + n;
    } catch {}
  }
  return Date.now();
}
export const LINT_TIMEOUT_MS = 10_000;
