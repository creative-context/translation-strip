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

// Where Claude Code's installers put `claude`, besides the PATH: the native installer
// (~/.local/bin), its older local install (~/.claude/local), Homebrew on Apple silicon and on
// Intel, and a user npm prefix. An app opened from
// Finder gets only /usr/bin:/bin:/usr/sbin:/sbin, which has none of them.
const HOME = homedir();
export const TOOL_PATH = [...new Set([...(process.env.PATH ?? "").split(":").filter(Boolean),
  join(HOME, ".local/bin"), join(HOME, ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin", join(HOME, ".npm-global/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
// The claude command: STRIP_CLAUDE (tests use a stand-in), else `claude` on TOOL_PATH, looked up
// each time, so installing Claude Code while the app runs is enough. "claude" when it isn't there
// (starting it then fails with ENOENT, which the translator reports as "missing").
export const claudeCommand = () => process.env.STRIP_CLAUDE || Bun.which("claude", { PATH: TOOL_PATH }) || "claude";

export const TIMEOUT_MS = Number(process.env.STRIP_TIMEOUT_MS) || 45_000; // one request, then failed and a restart
// A request's first try waits this long before a fresh session tries once more (TIMEOUT_MS for that one).
// Long enough for a long message on any of the models; a stalled session gets its second try sooner.
export const FIRST_TRY_MS = Number(process.env.STRIP_FIRST_TRY_MS) || 20_000;
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

// The helper that translates on this Mac: STRIP_MAC (tests use a stand-in), else the app's own
// Contents/MacOS/translate-on-mac, two folders up from the bundled server's (Contents/Resources/server).
// Run by hand from the repo, it isn't there unless STRIP_MAC names it.
export const macCommand = () => process.env.STRIP_MAC || resolve(import.meta.dir, "../../MacOS/translate-on-mac");
// The helper's first line ({ "ready": … }) within this long, and each reply within this long: both
// well above what a translation takes.
export const MAC_START_MS = Number(process.env.STRIP_MAC_START_MS) || 10_000;
export const MAC_TIMEOUT_MS = Number(process.env.STRIP_MAC_TIMEOUT_MS) || 15_000;
