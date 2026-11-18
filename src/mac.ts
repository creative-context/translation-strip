// Translating on this Mac: the helper (the app's Contents/MacOS/translate-on-mac, Apple's
// Translation framework), as the fourth model and as the stand-in when Claude can't answer. It
// translates; it doesn't polish: no voice guide, no register, no adjust, no question.
//
// The server starts the helper on first need and keeps it, and talks to it in JSON lines: the
// helper's first line is { "ready": true } (or { "ready": false, "error": "mac" }, and it exits),
// then one reply line per request line, by id. It ends when its stdin closes. A helper that dies is
// started once more (a request it hadn't answered goes to the new one); dying again, it waits for
// the next request. Its stderr is never read, and logs never hold a message's text.
//
// The two fixes in code, on the helper's text only, are pure functions below: Translation turns a
// list's single line breaks into blank lines, and a paste skips the emoji Teams makes of a typed
// emoticon.
import type { Subprocess } from "bun";
import { MAC_START_MS, MAC_TIMEOUT_MS, macCommand } from "./config";
import { languageNamed } from "./languages";
import { fileThere } from "./settings";
import type { Status } from "./state";

export type MacAsk = { text: string; target: string; auto: boolean; last?: string; hint?: string };
export type MacOutcome =
  | { ok: true; text: string; language: string; from: "chat" | "target" }
  | { ok: false; error: "language"; source: string; language: string }
  | { ok: false; error: "mac" | "failed" };

const log = (words: string) => console.error(`${new Date().toISOString()} mac: ${words}`);

// A blank line: a line break, nothing but spaces, another line break.
const BLANK = /\n[^\S\n]*\n/;
// Blank lines the source didn't have come out of the translation: with none in the source, every
// run of blank lines becomes one line break. A source with blank lines keeps the text as it is.
export function dropAddedBlankLines(source: string, text: string): string {
  const t = text.replace(/\r\n?/g, "\n");
  if (BLANK.test(source.replace(/\r\n?/g, "\n"))) return t;
  return t.replace(/\n(?:[^\S\n]*\n)+/g, "\n");
}

// The emoticons Teams turns into emoji when they're typed (a paste skips that), standing alone:
// the start or a space before; a space, the end or . , ! ? after. So none inside a word or a link.
const EMOJI: Record<string, string> = { ":)": "🙂", ":-)": "🙂", ":D": "😄", ":-D": "😄", ";)": "😉", ";-)": "😉", ":(": "🙁", ":-(": "🙁" };
const EMOTICON = /(?<=^|\s)(?::-?\)|:-?D|;-?\)|:-?\()(?=$|[\s.,!?])/g;
export const emojiFor = (text: string) => text.replace(EMOTICON, (m) => EMOJI[m] ?? m);

// Both fixes, in order.
export const fixMacText = (source: string, text: string) => emojiFor(dropAddedBlankLines(source, text));

// The dictation locale's language, the helper's hint for a text too short to tell: "es" for "es-MX".
export const hintFor = (locale: string) => locale.split(/[-_]/)[0].toLowerCase();

// A language name from the helper: the strip's own name when it's one of them, else its own name, cut short.
const nameOf = (v: unknown) => (typeof v === "string" && v.trim() ? (languageNamed(v.trim()) ?? v.trim().slice(0, 40)) : null);

// What a reply line means for the request it answers. Anything that isn't a reply or the language
// error is failed.
export function outcomeOf(m: any, ask: Pick<MacAsk, "target" | "auto">): MacOutcome {
  if (m?.error === "language") {
    const source = nameOf(m.source);
    const language = nameOf(m.language);
    return source && language ? { ok: false, error: "language", source, language } : { ok: false, error: "failed" };
  }
  if (typeof m?.text === "string" && m.text.trim()) {
    return { ok: true, text: m.text.trim(), language: nameOf(m.language) ?? ask.target, from: ask.auto && m.from === "chat" ? "chat" : "target" };
  }
  return { ok: false, error: "failed" };
}

type Pending = { id: string; line: string; ask: MacAsk; resolve: (o: MacOutcome) => void; timer: ReturnType<typeof setTimeout> };

export class MacHelper {
  private proc: Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private ready = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, Pending>();
  private unable = false; // the helper said this Mac can't translate (or couldn't be started): until a restart
  private failed = false; // it died twice in a row: until the next request
  private restartedOnce = false; // it was started once more after dying, with no reply since

  constructor(private onChange: () => void = () => {}, private command: () => string = macCommand) {}

  private there() {
    return fileThere(this.command());
  }
  // The helper may answer: it's there and hasn't said it can't.
  available() {
    return !this.unable && this.there();
  }

  // For state.translator when the model is mac: starting until the helper says ready.
  status(): { status: Status; error: "mac" | "failed" | null } {
    if (this.unable || !this.there()) return { status: "error", error: "mac" };
    if (this.pending.size) return { status: "busy", error: null };
    if (this.failed) return { status: "error", error: "failed" };
    return { status: this.ready ? "ready" : "starting", error: null };
  }

  // Started ahead, when the mac model is chosen, so the state can say ready.
  ensure() {
    if (!this.proc && !this.failed && this.available()) this.start("mac chosen");
  }

  // One request. The caller sends one at a time.
  translate(ask: MacAsk): Promise<MacOutcome> {
    if (!this.available()) {
      this.changed();
      return Promise.resolve({ ok: false, error: "mac" });
    }
    if (!this.proc) {
      // A request always gets one start, after a helper that died twice too.
      this.failed = false;
      this.restartedOnce = false;
      this.start("request");
      if (!this.proc) return Promise.resolve({ ok: false, error: this.unable ? "mac" : "failed" });
    }
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const line = JSON.stringify({ id, text: ask.text, target: ask.target, auto: ask.auto, ...(ask.last ? { last: ask.last } : {}), ...(ask.hint ? { hint: ask.hint } : {}) }) + "\n";
    return new Promise<MacOutcome>((resolve) => {
      const timer = setTimeout(() => this.timedOut(id), MAC_TIMEOUT_MS);
      this.pending.set(id, { id, line, ask, resolve, timer });
      if (this.ready) this.write(line);
      this.changed();
    });
  }

  // Forgets that it said it can't or that it died, and stops it; the next need starts it again.
  restart() {
    this.stopProc();
    this.fail("failed");
    this.unable = false;
    this.failed = false;
    this.restartedOnce = false;
    this.changed();
  }

  // With the server.
  stop() {
    this.stopProc();
    this.fail("failed");
  }

  private start(reason: string) {
    this.ready = false;
    let p: Subprocess<"pipe", "pipe", "ignore">;
    try {
      p = Bun.spawn([this.command()], { stdin: "pipe", stdout: "pipe", stderr: "ignore" }) as any;
    } catch (e: any) {
      // There but not a program that starts (not executable, the wrong kind): this Mac can't, as far as the app goes.
      this.unable = true;
      log(`couldn't start the helper (${e?.code ?? "error"})`);
      this.fail("mac");
      this.changed();
      return;
    }
    this.proc = p;
    log(`helper started (${reason}, pid ${p.pid})`);
    this.startTimer = setTimeout(() => {
      if (this.proc !== p || this.ready) return;
      log(`the helper didn't say ready in ${Math.round(MAC_START_MS / 1000)} s; stopped`);
      this.stopProc();
      this.failed = true;
      this.fail("failed");
      this.changed();
    }, MAC_START_MS);
    this.read(p);
    p.exited.then((code) => this.exited(p, code));
    this.changed();
  }

  private async read(p: Subprocess<"pipe", "pipe", "ignore">) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of p.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line && this.proc === p) this.line(line);
        }
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
    if (!m || typeof m !== "object") return;
    if ("ready" in m) {
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
      if (m.ready === true) {
        this.ready = true;
        log("helper ready");
        for (const p of this.pending.values()) this.write(p.line); // a request sent while it started, or to the one that died
      } else {
        this.unable = true;
        log("the helper says this Mac can't translate");
        this.stopProc();
        this.fail("mac");
      }
      return this.changed();
    }
    const p = typeof m.id === "string" ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(p.id);
    clearTimeout(p.timer);
    this.restartedOnce = false;
    this.failed = false;
    const o = outcomeOf(m, p.ask);
    if (!o.ok) log(`reply: ${o.error}`);
    p.resolve(o);
    this.changed();
  }

  private write(line: string) {
    try {
      this.proc?.stdin.write(line);
      this.proc?.stdin.flush();
    } catch {
      // The helper is going away; its exit answers the request.
    }
  }

  private timedOut(id: string) {
    if (!this.pending.has(id)) return;
    log(`no reply in ${Math.round(MAC_TIMEOUT_MS / 1000)} s; stopped`);
    // Stuck: it goes, and the next request starts a fresh one.
    this.stopProc();
    this.fail("failed");
    this.changed();
  }

  // Ended without being asked to: started once more, and what it hadn't answered goes to the new one.
  private exited(p: Subprocess<"pipe", "pipe", "ignore">, code: number | null) {
    if (this.proc !== p) return; // stopped on purpose
    this.proc = null;
    this.ready = false;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.unable) return this.changed();
    if (!this.restartedOnce) {
      this.restartedOnce = true;
      log(`helper exited (code ${code}); starting it once more`);
      this.start("exited");
    } else {
      log(`helper exited again (code ${code}); not starting it until a request`);
      this.failed = true;
      this.fail("failed");
    }
    this.changed();
  }

  private stopProc() {
    const p = this.proc;
    this.proc = null;
    this.ready = false;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (!p) return;
    try {
      p.stdin.end();
    } catch {}
    try {
      p.kill();
    } catch {}
  }

  // Answers every request still waiting.
  private fail(error: "mac" | "failed") {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error });
    }
  }

  private changed() {
    try {
      this.onChange();
    } catch {}
  }
}
