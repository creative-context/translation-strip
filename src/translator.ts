// The hidden translator: a fresh Claude Code session for every request, so no request ever sees an
// earlier one's text, chat or last message. One spare session is kept started ahead (spawned, the
// system prompt fed in, no turn yet); a request takes it, gets its one reply, and the session is
// stopped; the next spare starts right away in the background. Measured (notes, 2026-11-15): the
// first reply on an idle spare is as fast as a warm one, so a spare gets no warm-up turn.
//
// Each session runs with no tools, no MCP servers, no settings files (so no hooks and no plugins
// of the user's), no CLAUDE.md or auto-memory and no saved session, so it carries only what the
// server gives it: the protocol and the voice guide as its system prompt. The system prompt goes
// in on file descriptor 3, so the guide's text is never on a command line or in a file. Each
// session's stderr is held in memory (the first 2 KB) only to name why it ended, in one word.
// Logs say what happened, never a message's text or what Claude Code printed.
//
// A session that exits or stalls before it answers, for no reason a second session would hit too
// (not the login, an update, the network or the plan's limit), gets one more try on a fresh session
// before the request fails. Seen in testing (2026-11-15): now and then a session exits at its first
// turn with "Error reading system prompt file: EACCES … /dev/fd/3", only inside the server, never
// when the same spawn runs on its own; a fresh session answers.
import type { Subprocess } from "bun";
import { close, mkdirSync, readFileSync, statSync, write } from "node:fs";
import { claudeCommand, DAY_FILE, FIRST_TRY_MS, MAX_RESTARTS, RESTART_WINDOW_MS, SLEEP_GAP_MS, STDERR_KEEP, TIMEOUT_MS, TOOL_PATH, TRANSLATOR_DIR } from "./config";
import { classify, errorFor, stderrWord, type RateLimit } from "./errors";
import { parseReply, requestId, requestTurn, systemPrompt, userTurn, type Reply, type Request } from "./protocol";
import { fileThere } from "./settings";
import { bump, state, type Model, type TranslatorError } from "./state";

// aborted: the session ended before it answered; stopped: on purpose (a restart, the server stopping);
// unusable: it answered, but with no JSON reply or another request's id (a slip a fresh session doesn't repeat).
export type Outcome = { ok: true; reply: Reply } | { ok: false; error: TranslatorError; until?: string | null; aborted?: true; stopped?: true; unusable?: true };

// ms: how long this try waits; retry: a failure of this try is tried once more, so it doesn't restart the translator itself.
type Turn = { id: string; text: string[]; resolve: (o: Outcome) => void; timer: ReturnType<typeof setTimeout> | null; ms: number; retry: boolean };
type Session = {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  pid: number;
  model: Model;
  err: string; // the first STDERR_KEEP bytes of stderr, in memory only
  turn: Turn | null;
  rateLimit: RateLimit;
  retried: boolean; // Claude Code said it was retrying the API during the turn
  retired: boolean; // stopped on purpose, or already ended: its exit means nothing more
  stderrDone: Promise<void>;
};

const log = (words: string) => console.error(`${new Date().toISOString()} translator: ${words}`);
function today() {
  if (DAY_FILE) {
    try {
      const d = readFileSync(DAY_FILE, "utf8").trim();
      if (d) return d;
    } catch {}
  }
  return new Date().toDateString();
}

// Claude Code's own session variables, which a server started from inside a session would pass
// on: without them the translator starts as a plain `claude -p` on the user's own login.
const INHERITED = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_)/;
export function translatorEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !INHERITED.test(k)) env[k] = v;
  env.PATH = TOOL_PATH; // the places Claude Code installs to, for an app opened from Finder
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

// Opus runs at low effort. Tested on made-up messages (2026-11-15): the same English as at its
// default effort and at high, and as fast or faster (high thinks more often and is slower in its
// slowest replies). Haiku and Sonnet keep Claude Code's default.
const EFFORT: Partial<Record<Model, string>> = { opus: "low" };

export function translatorArgs(model: Model): string[] {
  return [
    claudeCommand(), "-p",
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", model,
    ...(EFFORT[model] ? ["--effort", EFFORT[model]!] : []),
    "--system-prompt-file", "/dev/fd/3",
    "--tools", "", "--strict-mcp-config", "--setting-sources", "",
    "--disable-slash-commands", "--no-session-persistence",
  ];
}

// Writes all of `text` to a pipe's fd without blocking the server, then closes it.
function feed(fd: number, text: string) {
  const buf = Buffer.from(text);
  let off = 0;
  const next = () => {
    if (off >= buf.length) return close(fd, () => {});
    write(fd, buf, off, buf.length - off, null, (err, n) => {
      if (err) return close(fd, () => {});
      off += n;
      next();
    });
  };
  next();
}

// `claude --version`'s first line, cut to something safe for the log.
const versionWords = (out: string) => (out.split("\n")[0] ?? "").replace(/[^\w .()+-]/g, "").trim().slice(0, 40) || "unknown";

export type TranslatorOptions = { now?: () => number };

export class Translator {
  private spare: Session | null = null;
  private active: Session | null = null;
  private crashes = 0; // failures in a row (an exit or a timeout) without a good reply between them
  private restarts: number[] = []; // when each start after a failure happened, for the cap
  private day = "";
  private guideStamp = 0;
  private lastTick = 0;
  private error: { error: TranslatorError; until: string | null } | null = null;
  private version: string | null = null;
  private versionAsked = false;
  private now: () => number;
  model: Model = "haiku";
  guidePath: string | null = null;

  constructor(private settings: () => { voiceGuide: string | null; model: Model }, opts: TranslatorOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  busy() {
    return this.active !== null;
  }

  // Starts a fresh spare, replacing the one there is: reads the guide now and holds it in memory only.
  // The session answering a request, if any, is left alone.
  start(reason: string) {
    this.askVersion();
    this.retire(this.spare);
    this.spare = null;
    const s = this.settings();
    this.model = s.model;
    this.guidePath = s.voiceGuide;
    this.day = today();
    let guide: string;
    try {
      if (!fileThere(s.voiceGuide)) throw new Error("no guide");
      guide = readFileSync(s.voiceGuide!, "utf8");
      this.guideStamp = statSync(s.voiceGuide!).mtimeMs;
    } catch {
      this.guideStamp = 0;
      this.setError({ error: "guide", until: null });
      log("no voice guide; not started");
      return;
    }
    if (this.error?.error === "guide") this.error = null;
    let proc: Subprocess<"pipe", "pipe", "pipe">;
    try {
      mkdirSync(TRANSLATOR_DIR, { recursive: true });
      proc = Bun.spawn(translatorArgs(this.model), {
        cwd: TRANSLATOR_DIR,
        env: translatorEnv(),
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      }) as any;
    } catch (e: any) {
      // ENOENT: there's no claude to start, so Claude Code isn't installed (or not where it installs to).
      this.setError({ error: e?.code === "ENOENT" ? "missing" : "failed", until: null });
      log(`couldn't start claude (${e?.code ?? "error"})`);
      return;
    }
    const session: Session = { proc, pid: proc.pid, model: this.model, err: "", turn: null, rateLimit: null, retried: false, retired: false, stderrDone: Promise.resolve() };
    this.spare = session;
    const fd3 = (proc as any).stdio?.[3];
    if (typeof fd3 === "number") feed(fd3, systemPrompt(guide));
    log(`spare started (${this.model}, ${reason}, pid ${proc.pid})`);
    this.read(session);
    session.stderrDone = this.keepStderr(session);
    proc.exited.then((code) => this.exited(session, code));
    this.refresh();
  }

  // Stops every session; a request waiting for its reply gets `failed`.
  kill() {
    const a = this.active;
    this.active = null;
    this.retire(this.spare);
    this.spare = null;
    if (a) {
      this.retire(a);
      this.end(a, { ok: false, error: "failed", aborted: true, stopped: true });
    }
    this.refresh();
  }

  // A fresh start, asked for (the menu's Restart): stops everything, forgets past failures.
  restart(reason: string) {
    this.kill();
    this.crashes = 0;
    this.restarts = [];
    this.error = null;
    this.start(reason);
  }

  // A new spare for new settings. A request in progress keeps its session and finishes.
  restartWhenIdle(reason: string) {
    this.crashes = 0;
    if (this.error?.error !== "limit") this.error = null;
    this.start(reason);
  }

  // One request, on its own session. The caller checks busy() first. A first try that ends without
  // an answer for a reason a fresh session can fix (it exited, stalled, or answered with no JSON or
  // another request's id) gets one more, on a fresh session.
  async request(req: Request): Promise<Outcome> {
    const first = await this.attempt(req, Math.min(FIRST_TRY_MS, TIMEOUT_MS), true);
    if (first.ok || !(first.aborted || first.unusable) || first.stopped || first.error !== "failed") return first;
    log("no answer from that session; trying once more on a fresh one");
    return this.attempt(req, TIMEOUT_MS, false);
  }

  private async attempt(req: Request, ms: number, retry: boolean): Promise<Outcome> {
    if (!this.spare || this.spare.retired) {
      if (retry) this.crashes = 0; // a request always gets one try, past the cap too
      this.start(retry ? "request" : "retry");
      if (!this.spare) return { ok: false, error: this.error?.error ?? "failed", until: this.error?.until ?? null };
    }
    const s = this.spare!;
    this.spare = null;
    this.active = s;
    const id = requestId();
    const outcome = await new Promise<Outcome>((resolve) => {
      const turn: Turn = { id, text: [], resolve, timer: null, ms, retry };
      turn.timer = setTimeout(() => this.timedOut(s), ms);
      s.turn = turn;
      this.refresh();
      try {
        s.proc.stdin.write(userTurn(requestTurn(id, req)));
        s.proc.stdin.flush();
      } catch {
        // The process is going away; its exit fails the turn.
      }
    });
    if (outcome.ok) {
      this.crashes = 0;
      this.setError(null);
    } else if (!outcome.aborted && outcome.error !== "failed") {
      this.setError({ error: outcome.error, until: outcome.until ?? null });
    }
    if (!outcome.aborted) {
      // The reply came: this session is done. The next request gets a fresh one.
      if (this.active === s) this.active = null;
      this.retire(s);
      if (!this.spare) this.start("next");
    }
    this.refresh();
    return outcome;
  }

  // The clock's part: a fresh spare after the Mac slept, on a new day, or when the guide file changed.
  tick() {
    const now = this.now();
    const slept = this.lastTick > 0 && now - this.lastTick > SLEEP_GAP_MS;
    this.lastTick = now;
    if (!this.spare) return;
    if (slept) return this.start("woke");
    if (this.day !== today()) return this.start("new day");
    if (this.guidePath && fileThere(this.guidePath)) {
      try {
        if (statSync(this.guidePath).mtimeMs !== this.guideStamp) this.start("guide changed");
      } catch {}
    }
  }

  // After a failure: a new spare, unless failures came twice in a row, the last one said what a
  // restart can't fix, or MAX_RESTARTS already happened in RESTART_WINDOW_MS.
  private recover(reason: string, failure: TranslatorError) {
    this.crashes++;
    if (failure === "login" || failure === "update") {
      this.setError({ error: failure, until: null });
      log(`${reason}: ${failure}; not restarting until a request or a restart`);
      return;
    }
    if (failure !== "failed") this.setError({ error: failure, until: null });
    if (this.spare) return;
    if (this.crashes > 1) {
      if (failure === "failed") this.setError({ error: "failed", until: null });
      log(`${reason} twice in a row; not restarting until a request or a restart`);
      return;
    }
    const now = this.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.setError({ error: "failed", until: null });
      log(`${MAX_RESTARTS} restarts in ${Math.round(RESTART_WINDOW_MS / 60_000)} minutes; not restarting until a request or a restart`);
      return;
    }
    this.restarts.push(now);
    this.start(reason);
  }

  private timedOut(s: Session) {
    if (this.active !== s || !s.turn || s.retired) return;
    const word = stderrWord(s.err);
    const error: TranslatorError = s.retried || word === "offline" ? "offline" : "failed";
    const retry = s.turn.retry && error === "failed";
    log(`no reply in ${Math.round(s.turn.ms / 1000)} s (${error}; claude ${this.version ?? "unknown"}); ${retry ? "trying again" : "restarting"}`);
    this.active = null;
    this.retire(s);
    this.end(s, { ok: false, error, aborted: true });
    if (!retry) this.recover("timeout", error); // else the request's second try starts its own session
    this.refresh();
  }

  private async read(s: Session) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of s.proc.stdout) {
        if (s.retired) return;
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this.line(s, line);
        }
      }
    } catch {}
  }

  // Keeps the first STDERR_KEEP bytes of stderr in memory and drops the rest.
  private async keepStderr(s: Session): Promise<void> {
    const dec = new TextDecoder();
    try {
      for await (const chunk of s.proc.stderr) {
        if (s.err.length < STDERR_KEEP) s.err = (s.err + dec.decode(chunk, { stream: true })).slice(0, STDERR_KEEP);
      }
    } catch {}
  }

  private line(s: Session, line: string) {
    if (s.retired || this.active !== s || !s.turn) return;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const turn = s.turn;
    if (m.type === "rate_limit_event") {
      s.rateLimit = { status: m.rate_limit_info?.status, resetsAt: Number(m.rate_limit_info?.resetsAt) || undefined };
      return;
    }
    if (m.type === "system" && typeof m.subtype === "string" && /retry/i.test(m.subtype)) {
      s.retried = true;
      return;
    }
    if (m.type === "assistant") {
      for (const c of m.message?.content ?? []) if (c?.type === "text" && typeof c.text === "string") turn.text.push(c.text);
      return;
    }
    if (m.type !== "result") return;
    const text = typeof m.result === "string" && m.result ? m.result : turn.text.join("\n");
    const isError = m.is_error === true || (m.subtype && m.subtype !== "success");
    const rl = s.rateLimit;
    const reply = isError ? null : parseReply(text, turn.id);
    if (reply) return this.end(s, { ok: true, reply });
    const errText = [text, ...(Array.isArray(m.errors) ? m.errors.map(String) : [])].join(" ");
    const c = isError || rl?.status === "rejected" ? classify(errText, rl) : { error: "failed" as const, until: null };
    const why = isError ? "" : parseReply(text) ? " (a reply with another id)" : " (no JSON reply)";
    log(`turn failed: ${c.error}${why}`);
    this.end(s, { ok: false, error: c.error, until: c.until, ...(isError ? {} : { unusable: true as const }) });
  }

  // A session ended without being asked to: names why in one word from its stderr (read to its
  // end first, briefly), fails its turn if it had one, and recovers.
  private async exited(s: Session, code: number | null) {
    if (s.retired) return;
    s.retired = true;
    await Promise.race([s.stderrDone, Bun.sleep(300)]);
    const word = stderrWord(s.err);
    s.err = "";
    const error = errorFor(word);
    log(`${s.turn ? "session" : "spare"} exited (code ${code}, ${word}; claude ${this.version ?? "unknown"})`);
    if (this.active !== s && this.spare !== s) return; // stopped meanwhile: whoever did it decides what's next
    if (this.spare === s) this.spare = null;
    if (this.active === s) this.active = null;
    const retry = !!s.turn?.retry && error === "failed";
    this.end(s, { ok: false, error, aborted: true });
    if (!retry) this.recover("exit", error); // else the request's second try starts its own session
    this.refresh();
  }

  // Answers a session's turn once.
  private end(s: Session, o: Outcome) {
    const t = s.turn;
    if (!t) return;
    s.turn = null;
    if (t.timer) clearTimeout(t.timer);
    t.resolve(o);
  }

  private retire(s: Session | null) {
    if (!s || s.retired) return;
    s.retired = true;
    s.err = "";
    try {
      s.proc.kill();
    } catch {}
  }

  // `claude --version`, once, for the log lines that say why a session ended.
  private askVersion() {
    if (this.versionAsked) return;
    this.versionAsked = true;
    try {
      const p = Bun.spawn([claudeCommand(), "--version"], { cwd: versionCwd(), env: translatorEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => p.kill(), 10_000);
      new Response(p.stdout).text().then(
        (out) => {
          clearTimeout(timer);
          this.version = versionWords(out);
          log(`claude ${this.version}`);
        },
        () => clearTimeout(timer),
      );
    } catch {
      this.version = "unknown";
    }
  }

  private setError(e: { error: TranslatorError; until: string | null } | null) {
    this.error = e;
    this.refresh();
  }

  // Puts the translator's part of the state in order, and bumps it when something changed.
  refresh() {
    const t = state.translator;
    const status = this.busy() ? "busy" : this.error ? "error" : this.spare ? "ready" : "starting";
    const next = {
      status,
      error: this.busy() ? null : (this.error?.error ?? null),
      until: this.busy() ? null : (this.error?.until ?? null),
      model: this.model,
      guide: fileThere(this.settings().voiceGuide) ? "ok" : "missing",
    } as const;
    if (t.status !== next.status || t.error !== next.error || t.until !== next.until || t.model !== next.model || t.guide !== next.guide) {
      Object.assign(t, next);
      bump();
    }
  }
}

// The translator's folder (made if needed), else the server's own: where `claude --version` runs.
function versionCwd() {
  try {
    mkdirSync(TRANSLATOR_DIR, { recursive: true });
    return TRANSLATOR_DIR;
  } catch {
    return undefined;
  }
}
