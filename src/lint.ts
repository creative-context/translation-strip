// The voice linter: after every reply, in any language, write it to a temp file, run
// `bun <linter> <file> --todo`, delete the file, and return the findings.
// No linter set, or it fails: no findings, and the state says the linter is missing.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINT_TIMEOUT_MS } from "./config";
import { fileThere } from "./settings";

export type Finding = { level: "error" | "warning"; message: string };
export type LintResult = { lint: Finding[]; ok: boolean };

// The bun that runs this server, so the linter runs even without bun on the PATH.
const BUN = /(^|\/)bun(-debug)?$/.test(process.execPath) ? process.execPath : "bun";

export async function lint(english: string, linter: string | null): Promise<LintResult> {
  if (!linter || !fileThere(linter)) return { lint: [], ok: false };
  const dir = mkdtempSync(join(tmpdir(), "strip-lint-"));
  const file = join(dir, "message.txt");
  try {
    writeFileSync(file, english + "\n", { mode: 0o600 });
    const p = Bun.spawn([BUN, linter, file, "--todo"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, NO_COLOR: "1" } });
    const timer = setTimeout(() => p.kill(), LINT_TIMEOUT_MS);
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    // 0 clean, 1 errors found; anything else (2 usage, a crash, killed) is a failure.
    if (code !== 0 && code !== 1) return { lint: [], ok: false };
    return { lint: parseFindings(out), ok: true };
  } catch {
    return { lint: [], ok: false };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

// One finding per "<file>:<line> <level> [<id>] <message>" line; the indented context lines and
// the closing count are skipped. "aviso" is the linter's word for a warning.
export function parseFindings(out: string): Finding[] {
  const found: Finding[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\S.*?:\d+ (error|aviso|warning) \[[^\]]*\] (.+)$/);
    if (m) found.push({ level: m[1] === "error" ? "error" : "warning", message: m[2].trim() });
  }
  return found;
}
