// The hidden translator: one Claude Code process kept alive, fed stream-json turns on stdin and
// read as stream-json on stdout. It runs with no tools, no MCP servers, no settings files (so no
// hooks and no plugins of the user's), no CLAUDE.md or auto-memory and no saved session, so it
// carries only what the server gives it: the protocol and the voice guide as its system prompt.
// The system prompt goes in on file descriptor 3, so the guide's text is never on a command line
// or in a file. Logs say what happened, never a message's text.
import type { Subprocess } from "bun";
import { close, mkdirSync, readFileSync, statSync, write } from "node:fs";
import { CLAUDE, MAX_MESSAGES, TIMEOUT_MS, TRANSLATOR_DIR } from "./config";
import { classify, type RateLimit } from "./errors";
import { parseReply, systemPrompt, userTurn, WARMUP, type Reply, type Request } from "./protocol";
import { fileThere } from "./settings";
import { bump, state, type Model, type TranslatorError } from "./state";

export type Outcome = { ok: true; reply: Reply } | { ok: false; error: TranslatorError; until?: string | null; aborted?: true };

type Turn = { kind: "warmup" | "request"; text: string[]; resolve: (o: Outcome) => void; timer: ReturnType<typeof setTimeout> | null };

const log = (words: string) => console.error(`${new Date().toISOString()} translator: ${words}`);
const today = () => new Date().toDateString();

// Claude Code's own session variables, which a server started from inside a session would pass
// on: without them the translator starts as a plain `claude -p` on the user's own login.
const INHERITED = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_)/;
export function translatorEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !INHERITED.test(k)) env[k] = v;
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

export function translatorArgs(model: Model): string[] {
  return [
    CLAUDE, "-p",
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", model,
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

export class Translator {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private gen = 0; // bumps on each start, so a stale process's exit is ignored
  private queue: Turn[] = [];
  private messages = 0;
  private crashes = 0; // in a row, without a good turn between them
  private day = "";
  private guideStamp = 0;
  private rateLimit: RateLimit = null;
  private restartWanted = false;
  private error: { error: TranslatorError; until: string | null } | null = null;
  model: Model = "haiku";
  guidePath: string | null = null;

  constructor(private settings: () => { voiceGuide: string | null; model: Model }) {}

  busy() {
    return this.queue.some((t) => t.kind === "request");
  }

  alive() {
    return this.proc !== null;
  }

  // Starts a fresh process: reads the guide now and holds it in memory only.
  start(reason: string) {
    this.kill();
    const s = this.settings();
    this.model = s.model;
    this.guidePath = s.voiceGuide;
    this.rateLimit = null;
    this.messages = 0;
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
    const gen = ++this.gen;
    try {
      mkdirSync(TRANSLATOR_DIR, { recursive: true });
      this.proc = Bun.spawn(translatorArgs(this.model), {
        cwd: TRANSLATOR_DIR,
        env: translatorEnv(),
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      }) as any;
    } catch (e: any) {
      this.proc = null;
      this.setError({ error: "failed", until: null });
      log(`couldn't start claude (${e?.code ?? "error"})`);
      return;
    }
    const p = this.proc!;
    const fd3 = (p as any).stdio?.[3];
    if (typeof fd3 === "number") feed(fd3, systemPrompt(guide));
    log(`started (${this.model}, ${reason}, pid ${p.pid})`);
    this.read(p, gen);
    this.drain(p.stderr);
    p.exited.then((code) => this.exited(gen, code));
    this.send({ kind: "warmup", text: [], resolve: (o) => this.warmed(o), timer: null }, WARMUP);
  }

  // Stops the process; turns still waiting get `failed`.
  kill() {
    const p = this.proc;
    this.proc = null;
    this.gen++;
    this.failAll();
    if (p) {
      try {
        p.kill();
      } catch {}
    }
    this.refresh();
  }

  restart(reason: string) {
    this.crashes = 0;
    this.restartWanted = false;
    this.error = null;
    this.start(reason);
  }

  // A restart that waits for the request in progress, when there is one.
  restartWhenIdle(reason: string) {
    if (this.busy()) {
      this.restartWanted = true;
      return;
    }
    this.restart(reason);
  }

  // One request. The caller checks busy() first.
  async request(req: Request): Promise<Outcome> {
    if (!this.proc) {
      this.crashes = 0;
      this.start("request");
      if (!this.proc) return { ok: false, error: this.error?.error ?? "failed", until: this.error?.until ?? null };
    }
    this.messages++;
    const outcome = await new Promise<Outcome>((resolve) => this.send({ kind: "request", text: [], resolve, timer: null }, JSON.stringify(req)));
    if (outcome.ok) {
      this.crashes = 0;
      this.setError(null);
    } else if (outcome.error !== "failed") {
      this.setError({ error: outcome.error, until: outcome.until ?? null });
    }
    if (this.restartWanted) this.restart("settings changed");
    else if (this.messages >= MAX_MESSAGES) this.restart(`${MAX_MESSAGES} messages`);
    this.refresh();
    return outcome;
  }

  // The clock's part: a fresh session on a new day, or when the guide file changed.
  tick() {
    if (!this.proc || this.queue.length) return;
    if (this.day !== today()) return this.restart("new day");
    if (this.guidePath && fileThere(this.guidePath)) {
      try {
        if (statSync(this.guidePath).mtimeMs !== this.guideStamp) this.restart("guide changed");
      } catch {}
    }
  }

  private send(turn: Turn, content: string) {
    const p = this.proc;
    if (!p) return turn.resolve({ ok: false, error: "failed" });
    turn.timer = setTimeout(() => this.timedOut(turn), TIMEOUT_MS);
    this.queue.push(turn);
    this.refresh();
    try {
      p.stdin.write(userTurn(content));
      p.stdin.flush();
    } catch {
      // The process is going away; its exit fails the turn.
    }
  }

  private timedOut(turn: Turn) {
    if (!this.queue.includes(turn)) return;
    log(`no reply in ${Math.round(TIMEOUT_MS / 1000)} s; restarting`);
    this.queue = this.queue.filter((t) => t !== turn);
    turn.resolve({ ok: false, error: "failed", aborted: true });
    this.crashes++;
    if (this.crashes > 1) {
      this.kill();
      this.setError({ error: "failed", until: null });
    } else this.start("timeout");
  }

  private warmed(o: Outcome) {
    if (!o.ok && o.aborted) return; // the process went away; whoever stopped it decides what's next
    if (o.ok) {
      this.crashes = 0;
      if (this.error?.error !== "guide") this.setError(null);
      log("ready");
    } else {
      this.setError({ error: o.error, until: o.until ?? null });
      log(`warm-up failed: ${o.error}`);
    }
    this.refresh();
  }

  private async read(p: Subprocess<"pipe", "pipe", "pipe">, gen: number) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of p.stdout) {
        if (gen !== this.gen) return;
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this.line(line);
        }
      }
    } catch {}
  }

  private async drain(stream: ReadableStream<Uint8Array>) {
    try {
      for await (const _ of stream) {
      }
    } catch {}
  }

  private line(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const head = this.queue[0];
    if (m.type === "rate_limit_event") {
      this.rateLimit = { status: m.rate_limit_info?.status, resetsAt: Number(m.rate_limit_info?.resetsAt) || undefined };
      return;
    }
    if (m.type === "assistant" && head) {
      for (const c of m.message?.content ?? []) if (c?.type === "text" && typeof c.text === "string") head.text.push(c.text);
      return;
    }
    if (m.type !== "result" || !head) return;
    this.queue.shift();
    if (head.timer) clearTimeout(head.timer);
    const text = typeof m.result === "string" && m.result ? m.result : head.text.join("\n");
    const isError = m.is_error === true || (m.subtype && m.subtype !== "success");
    const rl = this.rateLimit;
    this.rateLimit = null;
    const reply = isError ? null : parseReply(text);
    if (reply) head.resolve({ ok: true, reply });
    else if (!isError && head.kind === "warmup") head.resolve({ ok: true, reply: { ready: true } });
    else {
      const errText = [text, ...(Array.isArray(m.errors) ? m.errors.map(String) : [])].join(" ");
      const c = isError || rl?.status === "rejected" ? classify(errText, rl) : { error: "failed" as const, until: null };
      log(`turn failed: ${c.error}${isError ? "" : " (no JSON reply)"}`);
      head.resolve({ ok: false, error: c.error, until: c.until });
    }
    this.refresh();
  }

  private exited(gen: number, code: number | null) {
    if (gen !== this.gen) return; // stopped on purpose, or an older process
    this.proc = null;
    this.gen++;
    this.failAll();
    this.crashes++;
    log(`exited (code ${code}); ${this.crashes > 1 ? "not restarting" : "restarting once"}`);
    if (this.crashes > 1) {
      this.setError({ error: "failed", until: null });
      this.refresh();
    } else this.start("crash");
  }

  private failAll() {
    const q = this.queue;
    this.queue = [];
    for (const t of q) {
      if (t.timer) clearTimeout(t.timer);
      t.resolve({ ok: false, error: "failed", aborted: true });
    }
  }

  private setError(e: { error: TranslatorError; until: string | null } | null) {
    this.error = e;
    this.refresh();
  }

  // Puts the translator's part of the state in order, and bumps it when something changed.
  refresh() {
    const t = state.translator;
    const status = this.busy() ? "busy" : this.error ? "error" : this.queue.length || !this.proc ? "starting" : "ready";
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
