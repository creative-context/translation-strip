// The server end to end, on port 4811, with a temp STRIP_DIR, a stand-in `claude`
// (test/fake-claude.ts) and a stand-in linter (test/fake-lint.ts). Made-up messages only.
// Two servers, one after the other on the same port: the first for the everyday cases, the second
// (the last describe) with a short timeout, its own day and its own clock, so the limits show
// without slowing or disturbing the first. Pure parts (the stderr words, the reply's id, the port)
// are checked first, without a server.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classify, errorFor, stderrWord } from "../src/errors";
import { DICTATION, LANGUAGES } from "../src/languages";
import { dropAddedBlankLines, emojiFor, fixMacText, hintFor, macWaitMs, outcomeOf } from "../src/mac";
import { answerFor, parseReply, requestTurn, systemPrompt } from "../src/protocol";
import { addUsage, charsBucket, charsOf, claudeQuestionLine, claudeReplyLine, macReplyLine, usageOf } from "../src/reply-log";
import { checkChange, loadSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/state";
import { HIDDEN_FLAGS, helpNames, missingFlags, translatorArgs, translatorFlags } from "../src/translator";

const ROOT = resolve(import.meta.dir, "..");
// A shared build machine, like GitHub's Mac, can take many seconds to start each new translator
// session: every test gets 30 s, and every wait 20 s, so slowness alone never fails a test.
setDefaultTimeout(30000);
const PORT = 4811;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), "strip-test-"));
const GUIDE = join(DIR, "guide.md");
const GUIDE_TEXT = "Short sentences. Friendly, never stiff.\nNo exclamation marks in formal messages.\nSay thanks once.";
const SETTINGS = join(DIR, "settings.json");
const LAUNCHER = join(DIR, "claude");
const LIMIT_UNTIL = "2030-01-01T00:00:00.000Z";
const SECRET = "STDERR-SECRET-7f3a"; // the stand-in puts it in its stderr; it must never reach the log
const VERSION_WORDS = "claude 2.1.0 (Claude Code stand-in)";

let server: Subprocess;
let parent: Subprocess; // stands in for the app: the server stops when it's gone

const writeSettings = (s: object) => writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
const state = async () => (await fetch(`${BASE}/api/state`)).json() as Promise<any>;
const post = async (path: string, body: object = {}, headers: Record<string, string> = { "content-type": "application/json" }) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const starts = () => lines(join(DIR, "fake-starts.jsonl"));
const turns = () => lines(join(DIR, "fake-turns.jsonl"));
// A list of starts once it stops growing: a spare is spawned at once, but the stand-in writes its
// line a moment later, so a count taken too early would miss it.
async function settle(list: () => any[]) {
  let n = -1;
  for (;;) {
    const l = list();
    if (l.length === n) return l;
    n = l.length;
    await Bun.sleep(250);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(50);
  }
  // The end of the server's own log, so a failure on a build machine says what the server did.
  const tail = currentLog().split("\n").slice(-30).join("\n");
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}\n--- the server's log, last lines ---\n${tail}`);
}

// A server's output, read as it comes. Left unread, a pipe fills up (on a slow machine, which logs
// more) and the server stops at its next log line.
function collect(p: Subprocess<any, "pipe", "pipe">) {
  let text = "";
  const read = async (stream: ReadableStream) => {
    const dec = new TextDecoder();
    for await (const chunk of stream as any) text += dec.decode(chunk, { stream: true });
  };
  const done = Promise.all([read(p.stderr as ReadableStream), read(p.stdout as ReadableStream)]).then(() => {});
  return { text: () => text, done };
}
let currentLog = () => "";
// The server's `reply: …` lines (a time stamp, then "reply: "), without their time stamps.
const replyLines = () => currentLog().split("\n").filter((l) => /^\S+ reply: /.test(l)).map((l) => l.slice(l.indexOf(" ") + 1));
// Runs a request and returns the one reply line it added (and checks it added only one).
async function replyLineOf<T>(fn: () => Promise<T>): Promise<{ line: string; result: T }> {
  const n = replyLines().length;
  const result = await fn();
  const line = await until("the request's reply line", async () => replyLines()[n]);
  await Bun.sleep(150);
  expect(replyLines().length).toBe(n + 1);
  return { line, result };
}
// The stand-in's made-up counts (test/fake-claude.ts), once and twice (a fix turn or a second try that answered).
const USAGE_ONE = "in 12, out 23, cache read 6789, cache written 345";
const USAGE_TWO = "in 24, out 46, cache read 13578, cache written 690";
// A Claude reply line, with its time left open.
const claudeLine = (rest: string, model = "haiku") => new RegExp(`^reply: claude ${model} \\d+ ms · ${rest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
// Every reply line: these shapes and nothing else, so no text and no chat name can be in one.
const REPLY_SHAPE = /^reply: (claude [a-z]+ \d+ ms( · question| · (in \d+(, )?)?(out \d+(, )?)?(cache read \d+(, )?)?(cache written \d+)?( · )?lint \d+ errors · fix (kept|dropped|none) · tries [12]( · answered by [a-z]+)?)|mac \d+ ms · (under 100|100 to 499|500 to 1,999|2,000 or more) chars · lint \d+ errors( · stand-in for [a-z]+)?)$/;
const statusIs = (s: string) => until(`status ${s}`, async () => ((await state()).translator.status === s ? await state() : false));

beforeAll(async () => {
  writeFileSync(GUIDE, GUIDE_TEXT);
  writeSettings({ voiceGuide: GUIDE, linter: join(ROOT, "test/fake-lint.ts"), model: "haiku", mode: "send" });
  writeFileSync(LAUNCHER, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test/fake-claude.ts")}" "$@"\n`);
  chmodSync(LAUNCHER, 0o755);
  parent = Bun.spawn(["sleep", "600"]);
  server = Bun.spawn([process.execPath, join(ROOT, "server.ts")], {
    cwd: ROOT,
    env: { ...process.env, STRIP_PORT: String(PORT), STRIP_DIR: DIR, STRIP_CLAUDE: LAUNCHER, STRIP_PARENT_PID: String(parent.pid), CLAUDECODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  serverOut = collect(server as any);
  currentLog = serverOut.text;
});
let serverOut: ReturnType<typeof collect>;

afterAll(() => {
  try { server.kill(); } catch {}
  try { parent.kill(); } catch {}
  rmSync(DIR, { recursive: true, force: true });
});

describe("pure parts", () => {
  test("the reply line: numbers and fixed words, each count left out when not given", () => {
    expect(usageOf({ usage: { input_tokens: 12, cache_creation_input_tokens: 345, cache_read_input_tokens: 6789, output_tokens: 23, service_tier: "standard" } })).toEqual({ in: 12, out: 23, cacheRead: 6789, cacheWritten: 345 });
    expect(usageOf({ usage: { input_tokens: 5, output_tokens: "7", cache_read_input_tokens: -1 } })).toEqual({ in: 5 });
    expect(usageOf({ usage: {} })).toBeNull();
    expect(usageOf({ type: "result" })).toBeNull();
    expect(addUsage({ in: 1, out: 2 }, { in: 10, cacheRead: 5 })).toEqual({ in: 11, out: 2, cacheRead: 5 });
    expect(addUsage(null, { out: 3 })).toEqual({ out: 3 });
    expect(addUsage(undefined, null)).toBeNull();
    expect([0, 99, 100, 499, 500, 1999, 2000, 9000].map(charsBucket)).toEqual(["under 100", "under 100", "100 to 499", "100 to 499", "500 to 1,999", "500 to 1,999", "2,000 or more", "2,000 or more"]);
    expect(charsOf("¿ok? 🙂")).toBe(6);
    expect(claudeReplyLine({ model: "sonnet", ms: 1234.4, usage: { in: 12, out: 23, cacheRead: 6789, cacheWritten: 345 }, lintErrors: 0, fix: "none", tries: 1 })).toBe("reply: claude sonnet 1234 ms · in 12, out 23, cache read 6789, cache written 345 · lint 0 errors · fix none · tries 1");
    expect(claudeReplyLine({ model: "opus", ms: 900, usage: { in: 4, cacheWritten: 2 }, lintErrors: 1, fix: "dropped", tries: 2 })).toBe("reply: claude opus 900 ms · in 4, cache written 2 · lint 1 errors · fix dropped · tries 2");
    expect(claudeReplyLine({ model: "haiku", ms: 10, usage: null, lintErrors: 0, fix: "kept", tries: 1 })).toBe("reply: claude haiku 10 ms · lint 0 errors · fix kept · tries 1");
    expect(claudeReplyLine({ model: "opus", ms: 1500, usage: { out: 9 }, lintErrors: 0, fix: "none", tries: 1, answeredBy: "sonnet" })).toBe("reply: claude opus 1500 ms · out 9 · lint 0 errors · fix none · tries 1 · answered by sonnet");
    expect(claudeQuestionLine({ model: "haiku", ms: 812.6 })).toBe("reply: claude haiku 813 ms · question");
    expect(macReplyLine({ ms: 640, chars: 42, lintErrors: 0 })).toBe("reply: mac 640 ms · under 100 chars · lint 0 errors");
    expect(macReplyLine({ ms: 640, chars: 2400, lintErrors: 2, standIn: "offline" })).toBe("reply: mac 640 ms · 2,000 or more chars · lint 2 errors · stand-in for offline");
    for (const l of [claudeReplyLine({ model: "sonnet", ms: 1, usage: { out: 1 }, lintErrors: 0, fix: "none", tries: 1 }), claudeQuestionLine({ model: "opus", ms: 1 }), macReplyLine({ ms: 1, chars: 600, lintErrors: 0, standIn: "limit" })]) expect(l).toMatch(REPLY_SHAPE);
  });

  test("stderr says one word: login, update, offline, limit or unknown", () => {
    expect(stderrWord("Invalid API key · Please run /login")).toBe("login");
    expect(stderrWord("Not logged in. Run claude to log in.")).toBe("login");
    expect(stderrWord("OAuth token has expired")).toBe("login");
    expect(stderrWord("error: unknown option '--setting-sources'")).toBe("update");
    expect(stderrWord("error: unexpected argument '--tools' found")).toBe("update");
    expect(stderrWord("API Error: Connection error. getaddrinfo ENOTFOUND")).toBe("offline");
    expect(stderrWord("fetch failed: ECONNREFUSED")).toBe("offline");
    expect(stderrWord("Claude usage limit reached|1893456000")).toBe("limit");
    expect(stderrWord("You've hit your limit · resets 3pm")).toBe("limit");
    // Usage credits' words (Claude Code 2.1.323 and 2.1.328) and an API key's empty balance.
    expect(stderrWord("Your usage credits ran out")).toBe("limit");
    expect(stderrWord("This model needs usage credits, which are turned off")).toBe("limit");
    expect(stderrWord("Credit balance is too low")).toBe("limit");
    expect(classify("Usage credits are used up for this month", null)).toEqual({ error: "limit", until: null });
    expect(stderrWord("Segmentation fault")).toBe("unknown");
    expect(stderrWord("")).toBe("unknown");
    expect(errorFor("login")).toBe("login");
    expect(errorFor("update")).toBe("update");
    expect(errorFor("unknown")).toBe("failed");
    expect(classify("Invalid API key · Please run /login", null)).toEqual({ error: "login", until: null });
  });

  test("a reply counts only with the request's id", () => {
    expect(parseReply('{"id": "a1b2c3d4", "text": "See you at ten.", "language": "English", "from": "target"}', "a1b2c3d4")).toEqual({ text: "See you at ten.", language: "English", from: "target" });
    expect(parseReply('{"id": "a1b2c3d4", "question": "Which file?"}', "a1b2c3d4")).toEqual({ question: "Which file?" });
    expect(parseReply('{"id": "zzzzzzzz", "text": "See you at ten."}', "a1b2c3d4")).toBeNull();
    expect(parseReply('{"text": "See you at ten."}', "a1b2c3d4")).toBeNull(); // no id at all
    expect(parseReply('{"id": "a1b2c3d4", "text": "See you at ten."}', "a1b2c3d4")).toEqual({ text: "See you at ten.", language: null, from: null });
  });

  test("the turn carries the target, Auto and only non-empty notes, in the protocol's order", () => {
    const polish = requestTurn("a1b2c3d4", { task: "polish", text: "nos vemos a las diez", register: "normal", target: "English", auto: true });
    expect(JSON.parse(polish)).toEqual({ id: "a1b2c3d4", task: "polish", text: "nos vemos a las diez", register: "normal", target: "English", auto: true });
    const adjust = requestTurn("a1b2c3d4", { task: "adjust", text: "nos vemos", register: "formal", target: "Français", auto: false, notes: { Français: "Formal uses vous." }, context: { chat: "Launch plan", from: "Noor Haddad", last: "Ten works." }, current: "À dix heures.", note: "shorter" });
    expect(Object.keys(JSON.parse(adjust))).toEqual(["id", "task", "text", "register", "target", "auto", "notes", "context", "current", "note"]);
    expect(Object.keys(JSON.parse(requestTurn("a1b2c3d4", { task: "polish", text: "hola", register: "normal", target: "English", auto: false, notes: {} })))).not.toContain("notes");
  });

  test("a reply's language: one of the list, whatever its case; its own name otherwise; the target when missing. From chat only with Auto on", () => {
    const req = { target: "English", auto: true };
    expect(answerFor({ text: "Olá", language: "português", from: "chat" }, req)).toEqual({ text: "Olá", language: "Português", from: "chat" });
    expect(answerFor({ text: "Hej", language: "Dansk", from: "chat" }, req)).toEqual({ text: "Hej", language: "Dansk", from: "chat" });
    // The list's name, however the reply wrote it: no accents, in English, with a region.
    for (const said of ["Portuguese", "portugues", "Português (Brasil)", "PORTUGUÊS", "Brazilian Portuguese"]) expect(answerFor({ text: "Olá", language: said, from: "chat" }, req).language).toBe("Português");
    expect(answerFor({ text: "Hola", language: "Spanish", from: "chat" }, req).language).toBe("Español");
    expect(answerFor({ text: "Merci", language: "francais", from: "chat" }, req).language).toBe("Français");
    expect(answerFor({ text: "你好", language: "Chinese (Simplified)", from: "chat" }, req).language).toBe("中文");
    expect(answerFor({ text: "Hi", language: "English (US)", from: "chat" }, req).language).toBe("English");
    expect(answerFor({ text: "Hi", language: null, from: null }, req)).toEqual({ text: "Hi", language: "English", from: "target" });
    expect(answerFor({ text: "Olá", language: "Português", from: "chat" }, { target: "English", auto: false }).from).toBe("target");
    expect(answerFor({ text: "Hi", language: "English", from: "something" }, req).from).toBe("target");
  });

  test("the protocol names every language and keeps the add-nothing rule and the final check", () => {
    const p = systemPrompt("GUIDE-TEXT");
    for (const l of LANGUAGES) expect(p).toContain(l);
    expect(p).toContain("Add nothing the user didn't write");
    expect(p.indexOf("GUIDE-TEXT")).toBeLessThan(p.indexOf("# Before you reply"));
    expect(p.slice(p.indexOf("# Before you reply"))).toContain('confirm the message is in the language your "language" names');
  });

  test("settings.json read by hand: wrong values fall back, the target is always in the languages", () => {
    const f = join(mkdtempSync(join(tmpdir(), "strip-settings-")), "settings.json");
    expect(loadSettings(f)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(f).model).toBe("sonnet"); // a new install starts with Sonnet
    writeFileSync(f, JSON.stringify({ target: "Deutsch", auto: "yes", languages: ["English", "Klingon", "English", "Italiano"], notes: { Italiano: "  Informal uses tu. ", Klingon: "x", Deutsch: "", Polski: 3 }, dictation: "xx-XX" }));
    expect(loadSettings(f)).toMatchObject({ target: "Deutsch", auto: false, languages: ["English", "Italiano", "Deutsch"], notes: { Italiano: "Informal uses tu." }, dictation: "es-MX" });
    writeFileSync(f, JSON.stringify({ target: "中文", languages: LANGUAGES.slice(0, 8) }));
    const full = loadSettings(f).languages;
    expect(full.length).toBe(8);
    expect(full.at(-1)).toBe("中文");
  });

  test("a settings change: each key checked, the target kept in the languages, notes merged", () => {
    const now = { ...DEFAULT_SETTINGS, languages: ["English", "Español"], notes: { Español: "Formal uses usted." } };
    expect(checkChange({ target: "Español", auto: true, dictation: "pt-BR" }, now)).toEqual({ target: "Español", auto: true, dictation: "pt-BR" });
    expect(checkChange({ target: "Français" }, now)).toEqual({ target: "Français", languages: ["English", "Español", "Français"] });
    expect(checkChange({ languages: ["Español"] }, now)).toEqual({ languages: ["Español", "English"] }); // the target comes back
    expect(checkChange({ notes: { Español: "", Deutsch: "Formal uses Sie." } }, { ...now, languages: [...now.languages, "Deutsch"] })).toEqual({ notes: { Deutsch: "Formal uses Sie." } });
    // Notes belong to a language on the list: others aren't kept, and removing a language removes its notes.
    expect(checkChange({ notes: { Deutsch: "Formal uses Sie." } }, now)).toEqual({ notes: { Español: "Formal uses usted." } });
    expect(checkChange({ languages: ["English"] }, now)).toEqual({ languages: ["English"], notes: {} });
    expect(checkChange({ notes: { English: "x".repeat(600) + "   " } }, now)).not.toBeNull(); // the limit counts the trimmed text
    expect(checkChange({ notes: { Español: "   " } }, now)).toEqual({ notes: {} });
    for (const bad of [
      { target: "Klingon" }, { target: "english" }, { target: 3 },
      { auto: "true" }, { auto: 1 },
      { languages: [] }, { languages: "English" }, { languages: ["English", "English"] }, { languages: ["English", "Klingon"] }, { languages: [...LANGUAGES.slice(0, 9)] },
      { notes: [] }, { notes: "x" }, { notes: { Klingon: "x" } }, { notes: { English: 3 } }, { notes: { English: null } }, { notes: { English: "x".repeat(601) } },
      { dictation: "es" }, { dictation: "xx-XX" },
      { model: "gpt" }, { mode: "shout" },
    ]) expect(checkChange(bad, now)).toBeNull();
    expect(checkChange({ notes: { English: "x".repeat(600) } }, now)).not.toBeNull();
    // A ninth language, by way of a new target, breaks the 1 to 8 rule.
    expect(checkChange({ target: "中文" }, { ...now, languages: LANGUAGES.slice(0, 8) as unknown as string[] })).toBeNull();
    expect(DICTATION.map((d) => d.id)).toEqual(["es-MX", "es-US", "es-ES", "en-US", "en-GB", "pt-BR", "pt-PT", "fr-FR", "de-DE", "it-IT"]);
  });

  test("the mac model is a setting like the others", () => {
    expect(checkChange({ model: "mac" }, DEFAULT_SETTINGS)).toEqual({ model: "mac" });
    const f = join(mkdtempSync(join(tmpdir(), "strip-settings-")), "settings.json");
    writeFileSync(f, JSON.stringify({ model: "mac" }));
    expect(loadSettings(f).model).toBe("mac");
    writeFileSync(f, JSON.stringify({ model: "Mac" }));
    expect(loadSettings(f).model).toBe("sonnet");
  });

  test("the helper's text: blank lines come out only when the source had none", () => {
    const list = "To do tomorrow:\n\n- the slides\n\n- the budget";
    expect(dropAddedBlankLines("pendientes para mañana:\n- las slides\n- el presupuesto", list)).toBe("To do tomorrow:\n- the slides\n- the budget");
    expect(dropAddedBlankLines("pendientes:\n\n- las slides\n- el presupuesto", list)).toBe(list); // the source had one: kept as it is
    expect(dropAddedBlankLines("pendientes:\n  \n- las slides", list)).toBe(list); // a line of spaces is blank too
    expect(dropAddedBlankLines("una línea", "One line.\n \n\n\nAnother.")).toBe("One line.\nAnother.");
    expect(dropAddedBlankLines("a\r\nb", "A\r\n\r\nB")).toBe("A\nB");
    expect(dropAddedBlankLines("hola", "Hello")).toBe("Hello");
    // The wait for a reply grows with the text: Translation takes a few seconds per thousand characters.
    expect(macWaitMs(0)).toBe(15_000);
    expect(macWaitMs(4000)).toBe(55_000);
    expect(macWaitMs(8000)).toBe(95_000); // the longest text the server takes
  });

  test("the helper's text: each emoticon standing alone becomes Teams' emoji, none inside a link or a word", () => {
    expect(emojiFor(":) Thanks :-) see https://example.test/:D and a:)b ;) ok :(. Sure :D")).toBe("🙂 Thanks 🙂 see https://example.test/:D and a:)b 😉 ok 🙁. Sure 😄");
    for (const [typed, emoji] of [[":)", "🙂"], [":-)", "🙂"], [":D", "😄"], [":-D", "😄"], [";)", "😉"], [";-)", "😉"], [":(", "🙁"], [":-(", "🙁"]]) {
      expect(emojiFor(typed)).toBe(emoji);
      expect(emojiFor(`Done ${typed}`)).toBe(`Done ${emoji}`);
      for (const after of [".", ",", "!", "?", " ok", "\nNext"]) expect(emojiFor(`Done ${typed}${after}`)).toBe(`Done ${emoji}${after}`);
      expect(emojiFor(`Done\n${typed}`)).toBe(`Done\n${emoji}`); // a line's start
    }
    for (const left of ["x:)", "Done :)x", "Done :Dear", "(:)", "Done :))", "Done :D;", "https://example.test/a:)b", "http://example.test/:-D", "mailto:Dana", "12:30", "a;)"]) expect(emojiFor(left)).toBe(left);
    expect(fixMacText("ok\n- a\n- b", "Ok :)\n\n- a\n\n- b")).toBe("Ok 🙂\n- a\n- b");
  });

  test("the helper's hint and replies", () => {
    expect(hintFor("es-MX")).toBe("es");
    expect(hintFor("pt-BR")).toBe("pt");
    expect(hintFor("fr-FR")).toBe("fr");
    const ask = { target: "English", auto: true };
    expect(outcomeOf({ id: "a", text: " Olá ", language: "Português", from: "chat" }, ask)).toEqual({ ok: true, text: "Olá", language: "Português", from: "chat" });
    expect(outcomeOf({ id: "a", text: "Olá", language: "português", from: "chat" }, { target: "English", auto: false })).toEqual({ ok: true, text: "Olá", language: "Português", from: "target" });
    expect(outcomeOf({ id: "a", text: "Hi" }, ask)).toEqual({ ok: true, text: "Hi", language: "English", from: "target" });
    expect(outcomeOf({ id: "a", error: "language", source: "Español", language: "Íslenska" }, ask)).toEqual({ ok: false, error: "language", source: "Español", language: "Íslenska" });
    expect(outcomeOf({ id: "a", error: "language", source: "Español" }, ask)).toEqual({ ok: false, error: "failed" }); // never a made-up name
    expect(outcomeOf({ id: "a", error: "failed" }, ask)).toEqual({ ok: false, error: "failed" });
    expect(outcomeOf({ id: "a", text: "  " }, ask)).toEqual({ ok: false, error: "failed" });
  });

  test("the update check's flags: every flag translatorArgs passes, on any Claude model", () => {
    const flags = translatorFlags();
    for (const m of ["haiku", "sonnet", "opus"] as const) for (const a of translatorArgs(m).slice(1)) if (a.startsWith("-")) expect(flags).toContain(a);
    expect(flags).toContain("--fallback-model"); // Opus only, and still checked
    expect(flags).toContain("--effort");
    expect(flags).toContain("-p");
    expect(new Set(flags).size).toBe(flags.length);
    expect(flags.every((f) => /^--?[a-z]/.test(f))).toBe(true); // no values: not "", "stream-json" or "/dev/fd/3"
  });

  test("the update check reads a help: the names it shows, the hidden flags aside", () => {
    const help = "Usage: claude [options]\n\nOptions:\n  -p, --print                 Print response and exit\n  --model <model>             Model for the session\n  --tools <tools...>          Tools (\"\" for none)\n";
    expect([...helpNames(help)].sort()).toEqual(["--model", "--print", "--tools", "-p"]);
    expect(missingFlags(help, ["-p", "--model", "--tools"])).toEqual([]);
    expect(missingFlags(help, ["-p", "--model", "--effort", "--fallback-model"])).toEqual(["--effort", "--fallback-model"]);
    expect(HIDDEN_FLAGS.has("--system-prompt-file")).toBe(true); // hidden from Claude Code's help, so never counted missing
    expect(missingFlags(help, ["--system-prompt-file"])).toEqual([]);
    expect(missingFlags("", ["-p"])).toEqual(["-p"]);
    expect(missingFlags("--model-x and x--model", ["--model"])).toEqual(["--model"]); // only whole names count
  });

  test("opened from Finder (a short PATH), the server still finds claude where its installer puts it", async () => {
    const home = mkdtempSync(join(tmpdir(), "strip-test-home-"));
    try {
      mkdirSync(join(home, ".local/bin"), { recursive: true });
      writeFileSync(join(home, ".local/bin/claude"), "#!/bin/sh\n");
      chmodSync(join(home, ".local/bin/claude"), 0o755);
      const code = `const c = await import(${JSON.stringify(join(ROOT, "src/config.ts"))}); console.log(c.claudeCommand()); console.log(c.TOOL_PATH)`;
      const p = Bun.spawn([process.execPath, "-e", code], { env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe" });
      const [cmd, path] = (await new Response(p.stdout).text()).trim().split("\n");
      expect(cmd).toBe(join(home, ".local/bin/claude"));
      expect(path.split(":")).toEqual(expect.arrayContaining(["/usr/bin", join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("run by hand, the server's port is 4812, not the app's 4810", async () => {
    const p = Bun.spawn([process.execPath, "-e", `const c = await import(${JSON.stringify(join(ROOT, "src/config.ts"))}); console.log(c.PORT)`], { env: { ...process.env, STRIP_PORT: "" }, stdout: "pipe" });
    expect((await new Response(p.stdout).text()).trim()).toBe("4812");
  });
});

describe("Translation Strip server", () => {
  test("starts, then gets ready", async () => {
    const first = await until("the server", () => state());
    expect(["starting", "ready"]).toContain(first.translator.status);
    expect(first.server.version).toBe(require("../package.json").version);
    expect(first.settings).toEqual({ model: "haiku", mode: "send", target: "English", auto: false, languages: ["English"], notes: {}, dictation: "es-MX", files: { voiceGuide: "guide.md", linter: "fake-lint.ts" } });
    expect(first.options).toEqual({ languages: [...LANGUAGES], dictation: DICTATION.map((d) => ({ id: d.id, name: d.name })) });
    expect(JSON.stringify(first)).not.toContain(DIR); // no paths reach the page
    expect(JSON.stringify(first)).not.toContain(ROOT);
    const s = await statusIs("ready");
    expect(s.translator).toMatchObject({ error: null, model: "haiku", guide: "ok", linter: "ok" });
  });

  test("starts claude quietly, with the guide as its system prompt", async () => {
    const s = await until("the first start's line", async () => starts()[0]); // ready comes at spawn, the line a moment later
    expect(s.model).toBe("haiku");
    for (const flag of ["-p", "--input-format", "--output-format", "--verbose", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) expect(s.args).toContain(flag);
    expect(s.args[s.args.indexOf("--tools") + 1]).toBe("");
    expect(s.args[s.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(s.args.join(" ")).not.toContain("Short sentences"); // the guide is never on the command line
    expect(s.systemHasProtocol).toBe(true);
    expect(s.systemGuide).toBe(GUIDE_TEXT);
    expect(s.systemHasCheck).toBe(true); // the add-nothing check comes after the guide
    expect(s.disableClaudeMds).toBe("1");
    expect(s.inheritedSessionVar).toBeNull();
    expect(s.cwd.endsWith("/translator")).toBe(true);
  });

  test("polishes a message", async () => {
    const { line, result: r } = await replyLineOf(() => post("/api/translate", { text: "¿me mandas las slides antes de comer?", register: "normal", context: { chat: "Design review", from: "Sam Lee", last: "I'll share the deck later." } }));
    expect(line).toMatch(claudeLine(`${USAGE_ONE} · lint 0 errors · fix none · tries 1`));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: "Can you send me the slides before lunch?", language: "English", from: "target", lint: [], engine: "claude" });
    const f = await post("/api/translate", { text: "¿me mandas las slides antes de comer?", register: "formal" });
    expect(f.body.text).toBe("Could you please send me the slides before lunch?");
    expect(turns().at(-1)).toMatchObject({ target: "English", auto: false, notes: null });
  });

  test("each request goes to a new session, and the spare is ready for the next", async () => {
    await statusIs("ready");
    const n = (await settle(starts)).length;
    const spare = starts().at(-1).pid;
    const one = await post("/api/translate", { text: "MEMORY el reporte va el viernes", register: "normal", context: { chat: "Ops sync", from: "Kim Park", last: "When is it due?" } });
    expect(one.body.text).toBe("Turns seen: 1. Before: nothing");
    const t1 = turns().at(-1);
    expect(t1).toMatchObject({ pid: spare, task: "polish", turn: 1 });
    expect(t1.id).toMatch(/^[0-9a-f]{8}$/);
    // The next spare started on its own, and the used session is gone.
    await until("the next spare", async () => starts().length === n + 1);
    await until("the used session stopped", async () => !alive(spare));
    await statusIs("ready");
    const next = starts().at(-1).pid;
    expect(next).not.toBe(spare);
    const two = await post("/api/translate", { text: "MEMORY otra cosa para otro chat", register: "normal", context: { chat: "Budget", from: "Ana Ruiz", last: "Any news?" } });
    expect(two.body.text).toBe("Turns seen: 1. Before: nothing"); // nothing of the first request
    const t2 = turns().at(-1);
    expect(t2).toMatchObject({ pid: next, turn: 1 });
    expect(t2.id).not.toBe(t1.id);
  });

  test("a reply with another request's id gets one more try on a fresh session, and is failed when that one slips too", async () => {
    const before = turns().length;
    expect(await post("/api/translate", { text: "WRONGID ¿me mandas las slides?", register: "normal" })).toEqual({ status: 503, body: { error: "failed" } });
    expect(turns().length - before).toBe(2); // one more try, never a loop
    await statusIs("ready");
    expect((await post("/api/translate", { text: "¿me mandas las slides?" })).status).toBe(200);
  });

  test("a reply with another request's id, once: the fresh session's answer goes through", async () => {
    const { line, result: r } = await replyLineOf(() => post("/api/translate", { text: "WRONGID-ONCE ¿me mandas las slides?", register: "normal" }));
    expect(line).toMatch(claudeLine(`${USAGE_TWO} · lint 0 errors · fix none · tries 2`)); // the slip's turn counted too
    expect(r).toEqual({ status: 200, body: { text: "Can you send me the slides before lunch?", language: "English", from: "target", lint: [], engine: "claude" } });
    await statusIs("ready");
  });

  test("takes the reply's JSON even with words around it", async () => {
    const r = await post("/api/translate", { text: "CHATTY ¿me mandas las slides?", register: "normal" });
    expect(r.body.text).toBe("Can you send me the slides before lunch?");
  });

  test("a linter error gets one fix before the page sees it: an adjust whose note names the error", async () => {
    const before = turns().length;
    const { line, result: r } = await replyLineOf(() => post("/api/translate", { text: "KINDLY ¿me mandas las slides?", register: "normal" }));
    expect(line).toMatch(claudeLine(`${USAGE_TWO} · lint 0 errors · fix kept · tries 1`)); // the reply and its fix
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: "Could you send me the slides before lunch?", language: "English", from: "target", lint: [], engine: "claude" });
    const t = turns().slice(before);
    expect(t.map((x: any) => x.task)).toEqual(["polish", "adjust"]); // the fix ran on a fresh session of its own
    expect(t[0].pid).not.toBe(t[1].pid);
  });

  test("a fix that doesn't help: the first English goes back with the linter's findings", async () => {
    const before = turns().length;
    const { line, result: r } = await replyLineOf(() => post("/api/translate", { text: "KINDLY STUBBORN ¿me mandas las slides?", register: "normal" }));
    expect(line).toMatch(claudeLine(`${USAGE_TWO} · lint 1 errors · fix dropped · tries 1`));
    expect(r.status).toBe(200);
    expect(r.body.text).toBe("Could you kindly send me the slides before lunch?");
    expect(r.body.lint).toEqual([{ level: "error", message: "Sounds stiff: «kindly»" }]);
    expect(turns().length - before).toBe(2); // one fix, never a loop
  });

  test("asks a question when something important is unclear", async () => {
    const { line, result: r } = await replyLineOf(() => post("/api/translate", { text: "UNCLEAR mándame el reporte", register: "normal" }));
    expect(line).toMatch(/^reply: claude haiku \d+ ms · question$/);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ question: "Which report do you mean, the weekly one or the budget one?" });
  });

  test("adjusts the current text with a note", async () => {
    const { line, result: r } = await replyLineOf(() => post("/api/adjust", { text: "¿me mandas las slides?", current: "Can you send me the slides before lunch?", note: "add thanks", register: "normal", language: "English" }));
    expect(line).toMatch(claudeLine(`${USAGE_ONE} · lint 0 errors · fix none · tries 1`));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: "Can you send me the slides before lunch?, thanks!", language: "English", from: "target", lint: [], engine: "claude" });
    expect(turns().at(-1)).toMatchObject({ task: "adjust", target: "English", auto: false });
    expect(turns().at(-1).keys).not.toContain("english");
  });

  test("rejects bad requests", async () => {
    expect((await post("/api/translate", { text: "  " })).status).toBe(400);
    expect((await post("/api/adjust", { text: "hola", current: "Hi" })).status).toBe(400);
    expect((await post("/api/adjust", { text: "hola", english: "Hi", note: "shorter" })).status).toBe(400); // the old field name
    for (const target of ["Klingon", "english", 3, null, ""]) expect(await post("/api/translate", { text: "hola", target })).toEqual({ status: 400, body: { error: "target" } });
  });

  test("a result with no usage, or part of it: the reply line leaves out what Claude Code didn't give", async () => {
    const none = await replyLineOf(() => post("/api/translate", { text: "NOUSAGE ¿me mandas las slides?", register: "normal" }));
    expect(none.result.status).toBe(200);
    expect(none.line).toMatch(claudeLine("lint 0 errors · fix none · tries 1"));
    const part = await replyLineOf(() => post("/api/translate", { text: "PARTUSAGE ¿me mandas las slides?", register: "normal" }));
    expect(part.line).toMatch(claudeLine("in 12, out 23 · lint 0 errors · fix none · tries 1"));
    // An error answer and a rejected request add no reply line.
    const n = replyLines().length;
    expect((await post("/api/translate", { text: "  " })).status).toBe(400);
    expect((await post("/api/translate", { text: "LIMIT ¿me mandas las slides?", register: "normal" })).status).toBe(503);
    expect((await post("/api/translate", { text: "¿me mandas las slides?" })).status).toBe(200); // clears the limit
    await until("the next reply line", async () => replyLines().length === n + 1);
    expect(replyLines().at(-1)).toMatch(claudeLine(`${USAGE_ONE} · lint 0 errors · fix none · tries 1`));
  });

  test("one request at a time: a second one gets 409 busy", async () => {
    const slow = post("/api/translate", { text: "SLOW ¿me mandas las slides?", register: "normal" });
    await statusIs("busy");
    const second = await post("/api/translate", { text: "otra cosa", register: "normal" });
    expect(second).toEqual({ status: 409, body: { error: "busy" } });
    expect((await slow).status).toBe(200);
    await statusIs("ready");
  });

  test("the plan's limit, with until", async () => {
    const r = await post("/api/translate", { text: "LIMIT ¿me mandas las slides?", register: "normal" });
    expect(r).toEqual({ status: 503, body: { error: "limit", until: LIMIT_UNTIL } });
    const s = await state();
    expect(s.translator).toMatchObject({ status: "error", error: "limit", until: LIMIT_UNTIL });
    // The next one that goes through clears it.
    expect((await post("/api/translate", { text: "¿me mandas las slides?" })).status).toBe(200);
    expect((await state()).translator).toMatchObject({ status: "ready", error: null, until: null });
  });

  test("a crash gets one more try on a fresh session; when that one crashes too, the request fails and the translator restarts", async () => {
    const before = (await settle(starts)).length;
    const r = await post("/api/translate", { text: "CRASH ¿me mandas las slides?", register: "normal" });
    expect(r).toEqual({ status: 503, body: { error: "failed" } });
    await until("the second try's session and a new spare", async () => starts().length === before + 2);
    await statusIs("ready");
    expect((await post("/api/translate", { text: "¿me mandas las slides?" })).status).toBe(200);
  });

  test("a session that can't read its system prompt gets one more try on a fresh session, and the request goes through", async () => {
    await statusIs("ready");
    const before = (await settle(starts)).length;
    const { line, result: r } = await replyLineOf(() => post("/api/translate", { text: "PROMPT-ONCE ¿me mandas las slides?", register: "normal" }));
    expect(line).toMatch(claudeLine(`${USAGE_ONE} · lint 0 errors · fix none · tries 2`)); // the first session ended with no result
    expect(r.status).toBe(200);
    expect(r.body.text).toBeTruthy();
    await until("the second try's session and the next spare", async () => starts().length === before + 2);
    await statusIs("ready");
  });

  test("a session that ends with Claude Code's words says which: login, update, offline, limit", async () => {
    for (const [word, error] of [["LOGIN", "login"], ["UPDATE", "update"], ["OFFLINE", "offline"], ["LIMIT", "limit"]]) {
      await until("a spare", async () => ["ready", "error"].includes((await state()).translator.status));
      const before = (await settle(starts)).length;
      const r = await post("/api/translate", { text: `EXIT-${word} ¿me mandas las slides?`, register: "normal" });
      expect(r).toEqual({ status: 503, body: { error } });
      const s = await until(`error ${error}`, async () => ((await state()).translator.error === error ? await state() : false));
      expect(s.translator.status).toBe("error");
      if (error === "login" || error === "update") {
        await Bun.sleep(400);
        expect(starts().length).toBe(before); // a restart can't fix these: none until a request
      }
      // The next request that goes through clears it.
      expect((await post("/api/translate", { text: "¿me mandas las slides?" })).status).toBe(200);
      expect((await state()).translator).toMatchObject({ status: "ready", error: null });
    }
  });

  test("settings: the language keys are checked, written, sent to the page, and never restart the translator", async () => {
    await statusIs("ready");
    const before = (await settle(starts)).length;
    const r = await post("/api/settings", { target: "Español", auto: true, languages: ["English", "Français"], notes: { Français: "Formal uses vous." }, dictation: "fr-FR" });
    expect(r.status).toBe(200);
    const want = { target: "Español", auto: true, languages: ["English", "Français", "Español"], notes: { Français: "Formal uses vous." }, dictation: "fr-FR" };
    expect(r.body.settings).toMatchObject(want); // the target was added to the languages
    expect(JSON.parse(readFileSync(SETTINGS, "utf8"))).toMatchObject({ ...want, voiceGuide: GUIDE, model: "haiku" }); // the paths stay
    const s = await state();
    expect(s.settings).toMatchObject(want);
    expect(s.settings.files).toEqual({ voiceGuide: "guide.md", linter: "fake-lint.ts" }); // names only
    expect(JSON.stringify(s)).not.toContain(DIR);
    await Bun.sleep(400);
    expect(starts().length).toBe(before); // no restart: these go with each request

    // Anything outside the rules: 400 settings, and nothing written.
    const file = readFileSync(SETTINGS, "utf8");
    for (const bad of [{ target: "Klingon" }, { auto: "no" }, { languages: [] }, { languages: ["English", "English"] }, { languages: [...LANGUAGES.slice(0, 9)] }, { notes: { Klingon: "x" } }, { notes: { English: "x".repeat(601) } }, { notes: ["x"] }, { dictation: "en-AU" }, { target: "Deutsch", mode: "shout" }]) {
      expect(await post("/api/settings", bad)).toEqual({ status: 400, body: { error: "settings" } });
    }
    expect(readFileSync(SETTINGS, "utf8")).toBe(file);

    // A list without the target gets it back; "" removes a language's notes.
    expect((await post("/api/settings", { languages: ["Deutsch"] })).body.settings.languages).toEqual(["Deutsch", "Español"]);
    const cleared = await post("/api/settings", { notes: { Français: "" } });
    expect(cleared.body.settings.notes).toEqual({});
    expect(JSON.parse(readFileSync(SETTINGS, "utf8")).notes).toBeUndefined();

    const back = await post("/api/settings", { target: "English", auto: false, languages: ["English"], dictation: "es-MX" });
    expect(back.body.settings).toMatchObject({ target: "English", auto: false, languages: ["English"], notes: {}, dictation: "es-MX" });
    expect(starts().length).toBe(before);
  });

  test("Auto: the chat's language when its last message is clear, the target when it isn't; the notes go with each turn", async () => {
    expect((await post("/api/settings", { auto: true, languages: ["English", "Português"], notes: { Português: "Formal uses o senhor." } })).status).toBe(200);
    const pt = { chat: "Field trip", from: "Rui Costa", last: "PT: Pode mandar os slides?" };
    const a = await post("/api/translate", { text: "¿me mandas las slides antes de comer?", register: "normal", context: pt });
    expect(a.body).toEqual({ text: "[Português] Can you send me the slides before lunch?", language: "Português", from: "chat", lint: [], engine: "claude" });
    expect(turns().at(-1)).toMatchObject({ task: "polish", target: "English", auto: true, notes: { Português: "Formal uses o senhor." } });

    // No clear language in the chat: the target.
    const en = await post("/api/translate", { text: "¿me mandas las slides?", context: { chat: "Field trip", from: "Rui Costa", last: "Can you send them?" } });
    expect(en.body).toMatchObject({ language: "English", from: "target" });
    const none = await post("/api/translate", { text: "¿me mandas las slides?" });
    expect(none.body).toMatchObject({ text: "Can you send me the slides before lunch?", language: "English", from: "target" });

    // The one-time override: this request in that language, with Auto off; the settings stay.
    const once = await post("/api/translate", { text: "¿me mandas las slides?", context: pt, target: "English" });
    expect(once.body).toMatchObject({ text: "Can you send me the slides before lunch?", language: "English", from: "target" });
    expect(turns().at(-1)).toMatchObject({ target: "English", auto: false });
    expect((await state()).settings).toMatchObject({ target: "English", auto: true });

    // A reply that names its language in capitals reads as the list's name.
    expect((await post("/api/translate", { text: "SHOUTLANG ¿me mandas las slides?", context: pt })).body).toMatchObject({ language: "Português", from: "chat" });

    // Auto off: always the target, whatever the chat.
    expect((await post("/api/settings", { target: "Español", auto: false })).status).toBe(200);
    const es = await post("/api/translate", { text: "¿me mandas las slides?", context: pt });
    expect(es.body).toEqual({ text: "[Español] Can you send me the slides before lunch?", language: "Español", from: "target", lint: [], engine: "claude" });
    expect(turns().at(-1)).toMatchObject({ target: "Español", auto: false });
    const de = await post("/api/translate", { text: "¿me mandas las slides?", target: "Deutsch" });
    expect(de.body).toMatchObject({ text: "[Deutsch] Can you send me the slides before lunch?", language: "Deutsch", from: "target" });
    // A reply that names no language: the language it was asked for.
    expect((await post("/api/translate", { text: "NOLANG ¿me mandas las slides?" })).body).toMatchObject({ language: "Español", from: "target" });

    // No notes: the turn carries none.
    await post("/api/settings", { notes: { Português: "" } });
    await post("/api/translate", { text: "¿me mandas las slides?" });
    expect(turns().at(-1).keys).not.toContain("notes");
    await post("/api/settings", { target: "English", languages: ["English"] });
  }, 30000); // eleven requests, each on a fresh session: slow on a shared build machine

  test("an adjust keeps the current text's language, with Auto off", async () => {
    expect((await post("/api/settings", { auto: true })).status).toBe(200);
    const pt = { chat: "Field trip", from: "Rui Costa", last: "PT: Pode mandar os slides?" };
    const r = await post("/api/adjust", { text: "¿me mandas las slides?", current: "[Deutsch] Can you send me the slides.", note: "add thanks", register: "normal", context: pt, language: "Deutsch" });
    expect(r.body).toEqual({ text: "[Deutsch] Can you send me the slides, thanks!", language: "Deutsch", from: "target", lint: [], engine: "claude" });
    expect(turns().at(-1)).toMatchObject({ task: "adjust", target: "Deutsch", auto: false });
    // A language the list doesn't have is kept as its own name.
    expect((await post("/api/adjust", { text: "x", current: "Hej.", note: "add thanks", language: "Dansk" })).body).toMatchObject({ language: "Dansk", from: "target" });
    // No language given: the target.
    expect((await post("/api/adjust", { text: "x", current: "Hi.", note: "add thanks" })).body).toMatchObject({ language: "English", from: "target" });
  }, 30000);

  test("the linter's fix keeps the reply's language", async () => {
    const before = turns().length;
    const pt = { chat: "Field trip", from: "Rui Costa", last: "PT: Pode mandar os slides?" };
    const r = await post("/api/translate", { text: "KINDLY ¿me mandas las slides?", register: "normal", context: pt });
    expect(r.body).toEqual({ text: "[Português] Could you send me the slides before lunch?", language: "Português", from: "chat", lint: [], engine: "claude" });
    const t = turns().slice(before);
    expect(t.map((x: any) => x.task)).toEqual(["polish", "adjust"]);
    expect(t[1]).toMatchObject({ target: "Português", auto: false });
    expect((await post("/api/settings", { auto: false })).status).toBe(200);
  }, 30000);

  test("a POST needs JSON and the server's own Origin", async () => {
    const leave = JSON.stringify({ mode: "leave" });
    const raw = (headers: Record<string, string>) => fetch(`${BASE}/api/settings`, { method: "POST", headers, body: leave });
    for (const headers of [{ "content-type": "text/plain" }, {}, { "content-type": "application/x-www-form-urlencoded" }, { "content-type": "application/json", origin: "https://example.test" }, { "content-type": "application/json", origin: "http://127.0.0.1:4810" }, { "content-type": "application/json", origin: "null" }]) {
      const r = await raw(headers as Record<string, string>);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "forbidden" });
    }
    const t = await post("/api/translate", { text: "¿me mandas las slides?" }, { "content-type": "text/plain" });
    expect(t).toEqual({ status: 403, body: { error: "forbidden" } });
    expect((await state()).settings.mode).toBe("send"); // nothing changed
    expect(JSON.parse(readFileSync(SETTINGS, "utf8")).mode).toBe("send");
    // Its own page's Origin, either name, and no Origin at all, go through.
    for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]) expect((await post("/api/settings", {}, { "content-type": "application/json; charset=utf-8", origin })).status).toBe(200);
    expect((await post("/api/settings", {})).status).toBe(200);
  });

  test("settings: the paths are checked, and only the server writes them", async () => {
    const other = join(DIR, "other-guide.md");
    writeFileSync(other, "Plain words.\nNo filler.\nOne idea per line.");
    mkdirSync(join(DIR, "a-folder"), { recursive: true });
    for (const bad of ["guide.md", join(DIR, "missing.md"), join(DIR, "a-folder"), ` ${GUIDE}`, 42, null, ["x"], { p: GUIDE }]) {
      expect(await post("/api/settings", { voiceGuide: bad })).toEqual({ status: 400, body: { error: "path" } });
      expect(await post("/api/settings", { linter: bad })).toEqual({ status: 400, body: { error: "path" } });
    }
    expect(JSON.parse(readFileSync(SETTINGS, "utf8"))).toMatchObject({ voiceGuide: GUIDE }); // nothing written

    const before = (await settle(starts)).length;
    const r = await post("/api/settings", { voiceGuide: other });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ model: "haiku", mode: "send", files: { voiceGuide: "other-guide.md", linter: "fake-lint.ts" } });
    expect(JSON.stringify(r.body)).not.toContain(DIR); // no paths in the reply
    expect(JSON.parse(readFileSync(SETTINGS, "utf8"))).toMatchObject({ voiceGuide: other, model: "haiku", mode: "send" });
    await until("a spare with the other guide", async () => starts().length > before && starts().at(-1).systemGuide === "Plain words.\nNo filler.\nOne idea per line.");

    expect((await post("/api/settings", { linter: "" })).status).toBe(200); // "" clears it
    expect(JSON.parse(readFileSync(SETTINGS, "utf8")).linter).toBeUndefined();
    await until("linter missing", async () => (await state()).translator.linter === "missing");
    expect((await post("/api/settings", { voiceGuide: GUIDE, linter: join(ROOT, "test/fake-lint.ts") })).status).toBe(200);
    await until("linter ok", async () => (await state()).translator.linter === "ok");
    await until("a spare with the guide", async () => starts().at(-1).systemGuide === GUIDE_TEXT);
    await statusIs("ready");
    expect(JSON.stringify(await state())).not.toContain(DIR);
  }, 40000); // a slower Mac, like GitHub's, takes longer: each new spare may take more than 8 s there

  test("settings: writes the file, and a new model restarts the translator", async () => {
    const before = starts().length;
    const r = await post("/api/settings", { mode: "leave" });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ model: "haiku", mode: "leave" });
    expect(starts().length).toBe(before); // mode alone doesn't restart

    const m = await post("/api/settings", { model: "sonnet" });
    expect(m.body.settings).toMatchObject({ model: "sonnet", mode: "leave" });
    const file = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(file).toMatchObject({ model: "sonnet", mode: "leave", voiceGuide: GUIDE }); // the paths stay
    await until("a sonnet start", async () => starts().at(-1)?.model === "sonnet");
    const s = await statusIs("ready");
    expect(s.translator.model).toBe("sonnet");
    expect(s.settings).toMatchObject({ model: "sonnet", mode: "leave" });
    expect(starts().at(-1).args).not.toContain("--effort"); // Sonnet keeps Claude Code's default effort
    expect(starts().at(-1).args).not.toContain("--fallback-model"); // only Opus falls back

    // Opus runs at low effort.
    expect((await post("/api/settings", { model: "opus" })).body.settings).toMatchObject({ model: "opus", mode: "leave" });
    await until("an opus start", async () => starts().at(-1)?.model === "opus");
    const args = starts().at(-1).args;
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
    // Opus busy: Claude Code answers on Sonnet, and the reply line says so.
    expect(args[args.indexOf("--fallback-model") + 1]).toBe("sonnet");
    await statusIs("ready");
    const busy = await replyLineOf(() => post("/api/translate", { text: "BUSY slides", register: "normal" }));
    expect(busy.result.body.engine).toBe("claude");
    expect(busy.line).toMatch(/^reply: claude opus \d+ ms · .* · tries 1 · answered by sonnet$/);
    expect(busy.line).toMatch(REPLY_SHAPE);
    await statusIs("ready");
    expect((await post("/api/settings", { model: "sonnet" })).status).toBe(200);
    await until("a sonnet start again", async () => starts().at(-1)?.model === "sonnet");
    await statusIs("ready");

    expect((await post("/api/settings", { model: "gpt" })).status).toBe(400);
  });

  test("restart on request", async () => {
    const before = starts().length;
    expect(await post("/api/translator/restart")).toEqual({ status: 200, body: {} });
    await until("a new start", async () => starts().length === before + 1);
    await statusIs("ready");
  });

  // The update check (0.12.0): `claude --help` once per Claude Code version this server learns.
  const helps = () => lines(join(DIR, "fake-helps.jsonl"));
  const checkLine = (version: string, rest: string) => `translator: claude ${version} (Claude Code stand-in) check: ${rest}`;
  const checkIs = (c: string | null) => until(`check ${c}`, async () => ((await state()).translator.check === c ? await state() : false));
  const translates = async () => {
    const r = await post("/api/translate", { text: "¿me mandas las slides antes de comer?", register: "normal" });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe("Can you send me the slides before lunch?");
  };

  test("the update check: claude --help names every flag, check ok, once per version, in the state's shape", async () => {
    const s = await checkIs("ok");
    expect(Object.keys(s.translator).sort()).toEqual(["check", "error", "guide", "linter", "missing", "model", "status", "until"]);
    expect(s.translator.missing).toEqual([]);
    expect(currentLog()).toContain(checkLine("2.1.0", "ok"));
    const n = (await settle(helps)).length;
    expect(n).toBe(1); // once since the server started, through every request and restart so far
    await post("/api/translator/restart"); // asks the version again: the same one, so no new help
    await statusIs("ready");
    await Bun.sleep(500);
    expect(helps().length).toBe(n);
    expect((await state()).translator.check).toBe("ok");
    expect(currentLog().split(checkLine("2.1.0", "")).length - 1).toBe(1);
  });

  test("the update check: a new version whose help lacks flags is changed, with them, and translating goes on", async () => {
    writeFileSync(join(DIR, "fake-version"), "2.1.1 (Claude Code stand-in)");
    writeFileSync(join(DIR, "fake-help-drop"), "--fallback-model\n--strict-mcp-config\n");
    try {
      const n = helps().length;
      await post("/api/translator/restart");
      const s = await checkIs("changed");
      expect(s.translator.missing).toEqual(["--strict-mcp-config", "--fallback-model"]); // translatorArgs' order
      expect(currentLog()).toContain(checkLine("2.1.1", "lacks --strict-mcp-config, --fallback-model"));
      expect(helps().length).toBe(n + 1);
      await statusIs("ready"); // the check blocks nothing
      await translates();
      expect((await state()).translator).toMatchObject({ status: "ready", error: null, check: "changed", missing: ["--strict-mcp-config", "--fallback-model"] });
    } finally {
      rmSync(join(DIR, "fake-help-drop"), { force: true });
    }
  });

  test("the update check: a help that fails leaves the check unknown and blocks nothing; a version checked before keeps its result", async () => {
    writeFileSync(join(DIR, "fake-version"), "2.1.2 (Claude Code stand-in)");
    writeFileSync(join(DIR, "fake-help-fail"), "");
    try {
      const n = helps().length;
      await post("/api/translator/restart");
      await until("the help's failure in the log", async () => currentLog().includes(checkLine("2.1.2", "couldn't read its help")));
      const s = await checkIs(null);
      expect(s.translator.missing).toEqual([]);
      expect(helps().length).toBe(n + 1);
      await statusIs("ready");
      await translates();
      // Restarted on the same version, a help that failed is asked again.
      await post("/api/translator/restart");
      await until("a second help for 2.1.2", async () => helps().length === n + 2);
      await statusIs("ready");
    } finally {
      rmSync(join(DIR, "fake-help-fail"), { force: true });
      rmSync(join(DIR, "fake-version"), { force: true });
    }
    // Back on 2.1.0, checked earlier in this server's life: its result comes back with no new help.
    const n = (await settle(helps)).length;
    await post("/api/translator/restart");
    const s = await checkIs("ok");
    expect(s.translator.missing).toEqual([]);
    await Bun.sleep(300);
    expect(helps().length).toBe(n);
    await statusIs("ready");
  });

  test("no voice guide: the guide error", async () => {
    rmSync(GUIDE);
    await post("/api/translator/restart");
    const s = await statusIs("error");
    expect(s.translator).toMatchObject({ error: "guide", guide: "missing" });
    expect(await post("/api/translate", { text: "¿me mandas las slides?" })).toEqual({ status: 503, body: { error: "guide" } });

    writeFileSync(GUIDE, GUIDE_TEXT);
    await post("/api/translator/restart");
    expect((await statusIs("ready")).translator.guide).toBe("ok");
  });

  test("no linter: no findings, and the state says so", async () => {
    writeSettings({ voiceGuide: GUIDE, model: "sonnet", mode: "leave" });
    await until("linter missing", async () => (await state()).translator.linter === "missing");
    const r = await post("/api/translate", { text: "KINDLY ¿me mandas las slides?" });
    expect(r.body.lint).toEqual([]);
  });

  test("answers only its own host name", async () => {
    const r = await fetch(`${BASE}/api/state`, { headers: { host: "example.test" } });
    expect(r.status).toBe(403);
  });

  test("ends when the app is gone, and its log has words, never texts", async () => {
    parent.kill();
    const code = await Promise.race([server.exited, Bun.sleep(9000).then(() => "still running")]);
    expect(code).toBe(0);
    await Promise.race([serverOut.done, Bun.sleep(2000)]);
    const log = serverOut.text();
    expect(log).toContain(VERSION_WORDS);
    expect(log).toContain("session exited (code 1, login; claude 2.1.0 (Claude Code stand-in))");
    expect(log).toContain("update;");
    for (const never of [SECRET, "Invalid API key", "unknown option", "slides", "MEMORY", "Ops sync", "Kim Park"]) expect(log).not.toContain(never);
    // Every reply line has one of the shapes, numbers and fixed words only.
    const replies = log.split("\n").filter((l) => /^\S+ reply: /.test(l)).map((l) => l.slice(l.indexOf(" ") + 1));
    expect(replies.length).toBeGreaterThan(10);
    for (const l of replies) expect(l).toMatch(REPLY_SHAPE);
  }, 30000);
});

// The limits: the 45 s timeout (shortened), the restart cap, a spare Claude Code refuses at start, the
// restart on a new day (the day comes from a file the test changes) and after the Mac slept (the tick's
// clock comes from a file too). A second server, started when the first one has ended, so these don't
// change the first one's counts.
describe("Translation Strip server: its limits", () => {
  const DIR2 = mkdtempSync(join(tmpdir(), "strip-test-limits-"));
  const DAY = join(DIR2, "day.txt");
  const CLOCK = join(DIR2, "clock.txt");
  const TIMEOUT_MS = 1500; // the real one is 45 s
  const starts2 = () => lines(join(DIR2, "fake-starts.jsonl"));
  const normal = () => post("/api/translate", { text: "¿me mandas las slides antes de comer?", register: "normal" });
  let server2: Subprocess;
  let server2Out: ReturnType<typeof collect>;
  let parent2: Subprocess;

  beforeAll(async () => {
    writeFileSync(join(DIR2, "guide.md"), GUIDE_TEXT);
    writeFileSync(join(DIR2, "settings.json"), JSON.stringify({ voiceGuide: join(DIR2, "guide.md"), linter: join(ROOT, "test/fake-lint.ts"), model: "haiku", mode: "send" }));
    writeFileSync(join(DIR2, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test/fake-claude.ts")}" "$@"\n`);
    chmodSync(join(DIR2, "claude"), 0o755);
    writeFileSync(DAY, "Mon Jan 01 2029");
    writeFileSync(CLOCK, "0");
    // The first server has ended; if something still answers on the port, these tests would be talking to it.
    if (await fetch(`${BASE}/api/state`).then(() => true, () => false)) throw new Error(`something still answers on port ${PORT}`);
    parent2 = Bun.spawn(["sleep", "600"]);
    server2 = Bun.spawn([process.execPath, join(ROOT, "server.ts")], {
      cwd: ROOT,
      env: {
        ...process.env,
        STRIP_PORT: String(PORT),
        STRIP_DIR: DIR2,
        STRIP_CLAUDE: join(DIR2, "claude"),
        STRIP_PARENT_PID: String(parent2.pid),
        STRIP_TIMEOUT_MS: String(TIMEOUT_MS),
        STRIP_DAY_FILE: DAY,
        STRIP_CLOCK_FILE: CLOCK,
        CLAUDECODE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    server2Out = collect(server2 as any);
    currentLog = server2Out.text;
    await until("the second server's translator", async () => (await state()).translator.status === "ready");
  });

  afterAll(() => {
    try { server2.kill(); } catch {}
    try { parent2.kill(); } catch {}
    rmSync(DIR2, { recursive: true, force: true });
  });

  test("a request the stand-in never answers gets one more try, then ends as failed after the timeouts, and the translator restarts", async () => {
    const before = await settle(starts2);
    const hung = before.at(-1).pid;
    const t0 = Date.now();
    const r = await post("/api/translate", { text: "HANG ¿me mandas las slides?", register: "normal" });
    const took = Date.now() - t0;
    expect(r).toEqual({ status: 503, body: { error: "failed" } });
    expect(took).toBeGreaterThanOrEqual(2 * TIMEOUT_MS - 200); // both tries waited their timeout, not less
    expect(took).toBeLessThan(2 * TIMEOUT_MS + 3000);
    await until("the second try's session and a new spare", async () => starts2().length === before.length + 2);
    expect(starts2().at(-1).pid).not.toBe(hung);
    await until("the hung process stopped", async () => !alive(hung));
    await statusIs("ready");
    expect(starts2().length).toBe(before.length + 2); // one restart, not a loop
    expect((await normal()).status).toBe(200); // and it answers again
  });

  test("a first try that never answers gives way to a fresh session after its wait, and the request goes through", async () => {
    await statusIs("ready");
    const t0 = Date.now();
    const r = await post("/api/translate", { text: "HANG-ONCE ¿me mandas las slides?", register: "normal" });
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(TIMEOUT_MS - 100); // the first try waited its turn
    await statusIs("ready");
  });

  test("at most 5 restarts in 10 minutes, then an error until a request", async () => {
    await post("/api/translator/restart"); // forgets earlier failures
    await statusIs("ready");
    let n = (await settle(starts2)).length;
    for (let i = 1; i <= 5; i++) {
      expect(await post("/api/translate", { text: "CRASH ¿me mandas las slides?", register: "normal" })).toEqual({ status: 503, body: { error: "failed" } });
      // The second try's session (not a restart) and the restart after it.
      await until(`restart ${i}`, async () => starts2().length === n + 2);
      await statusIs("ready");
      expect((await normal()).status).toBe(200); // a good reply between them: not "twice in a row"
      await until(`the spare after reply ${i}`, async () => starts2().length === n + 3);
      n += 3;
      await statusIs("ready");
    }
    expect((await post("/api/translate", { text: "CRASH ¿me mandas las slides?", register: "normal" })).status).toBe(503);
    const s = await statusIs("error");
    expect(s.translator.error).toBe("failed");
    await Bun.sleep(500);
    expect(starts2().length).toBe(n + 1); // the sixth gets its second try, and isn't restarted after it
    expect((await normal()).status).toBe(200); // a request gets its try
    await statusIs("ready");
  }, 30000);

  test("Claude Code that refuses the app's options: update, and no restart loop", async () => {
    writeFileSync(join(DIR2, "fake-exit-at-start"), `error: unknown option '--disable-slash-commands' ${SECRET}`);
    const n = (await settle(starts2)).length;
    await post("/api/translator/restart");
    const s = await until("error update", async () => ((await state()).translator.error === "update" ? await state() : false));
    expect(s.translator.status).toBe("error");
    await Bun.sleep(600);
    expect(starts2().length).toBe(n + 1);
    expect(await normal()).toEqual({ status: 503, body: { error: "update" } }); // a request tries once more
    unlinkSync(join(DIR2, "fake-exit-at-start"));
    await post("/api/translator/restart");
    await statusIs("ready");
    expect((await normal()).status).toBe(200);
  });

  test("on a new day the next tick restarts the translator", async () => {
    await post("/api/translator/restart"); // a fresh start, so it knows today as the day file says
    await until("a ready translator", async () => (await state()).translator.status === "ready");
    const before = await settle(starts2);
    const old = before.at(-1).pid;
    writeFileSync(DAY, "Tue Jan 02 2029"); // the day changes; the tick that sees it (every 6 s) restarts
    await until("a start for the new day", async () => starts2().length === before.length + 1, 12000);
    expect(starts2().at(-1).pid).not.toBe(old);
    await until("the old process stopped", async () => !alive(old));
    await statusIs("ready");
    expect((await normal()).status).toBe(200);
  }, 30000);

  test("after the Mac sleeps (a gap between ticks) the spare is replaced, once", async () => {
    await statusIs("ready");
    const before = await settle(starts2);
    const old = before.at(-1).pid;
    writeFileSync(CLOCK, String(5 * 60_000)); // the clock jumps 5 minutes between two ticks
    await until("a start after the gap", async () => starts2().length === before.length + 1, 12000);
    expect(starts2().at(-1).pid).not.toBe(old);
    await until("the old spare stopped", async () => !alive(old));
    await statusIs("ready");
    await Bun.sleep(6500); // the next tick sees a normal gap
    expect(starts2().length).toBe(before.length + 1);
    expect((await normal()).status).toBe(200);
  }, 30000);

  test("no claude to start: the error says to install Claude Code, and a request starts it once it's there", async () => {
    const fake = join(DIR2, "claude"), away = join(DIR2, "claude-away");
    renameSync(fake, away);
    try {
      await post("/api/translator/restart");
      await until("the missing error", async () => (await state()).translator.error === "missing");
      expect(await normal()).toEqual({ status: 503, body: { error: "missing" } });
    } finally {
      renameSync(away, fake);
    }
    expect((await normal()).status).toBe(200);
  }, 30000);

  test("its log names the words and the version, never Claude Code's text", async () => {
    parent2.kill();
    await Promise.race([server2.exited, Bun.sleep(9000)]);
    await Promise.race([server2Out.done, Bun.sleep(2000)]);
    const log = server2Out.text();
    expect(log).toContain(VERSION_WORDS);
    expect(log).toContain("spare exited (code 1, update; claude 2.1.0 (Claude Code stand-in))");
    expect(log).toContain("5 restarts in 10 minutes");
    expect(log).toContain("woke");
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain("unknown option");
  }, 30000);
});

// Translating on this Mac: a third server, after the second has ended, with a stand-in helper
// (test/fake-mac.ts, pointed at with STRIP_MAC): first as the stand-in for a Claude model that can't
// answer, then as the mac model itself.
describe("Translation Strip server: translating on this Mac", () => {
  const DIR3 = mkdtempSync(join(tmpdir(), "strip-test-mac-"));
  const GUIDE3 = join(DIR3, "guide.md");
  const MAC = join(DIR3, "translate-on-mac");
  const CLAUDE3 = join(DIR3, "claude");
  const SLIDES = "Can you send me the slides before lunch?";
  const CHAT = { chat: "Ops sync", from: "Kim Park", last: "Any news?" };
  const PT = { chat: "Field trip", from: "Rui Costa", last: "PT: Pode mandar os slides?" };
  const starts3 = () => lines(join(DIR3, "fake-starts.jsonl"));
  const turns3 = () => lines(join(DIR3, "fake-turns.jsonl"));
  const macStarts = () => lines(join(DIR3, "fake-mac-starts.jsonl"));
  const macAsks = () => lines(join(DIR3, "fake-mac-requests.jsonl"));
  const ask = (text: string, more: object = {}) => post("/api/translate", { text, register: "normal", ...more });
  const settled = () => until("a settled translator", async () => ["ready", "error"].includes((await state()).translator.status));
  let server3: Subprocess;
  let server3Out: ReturnType<typeof collect>;
  let parent3: Subprocess;

  beforeAll(async () => {
    writeFileSync(GUIDE3, GUIDE_TEXT);
    writeFileSync(join(DIR3, "settings.json"), JSON.stringify({ voiceGuide: GUIDE3, linter: join(ROOT, "test/fake-lint.ts"), model: "haiku", mode: "send" }));
    writeFileSync(CLAUDE3, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test/fake-claude.ts")}" "$@"\n`);
    writeFileSync(MAC, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test/fake-mac.ts")}" "$@"\n`);
    chmodSync(CLAUDE3, 0o755);
    chmodSync(MAC, 0o755);
    if (await fetch(`${BASE}/api/state`).then(() => true, () => false)) throw new Error(`something still answers on port ${PORT}`);
    parent3 = Bun.spawn(["sleep", "600"]);
    server3 = Bun.spawn([process.execPath, join(ROOT, "server.ts")], {
      cwd: ROOT,
      env: { ...process.env, STRIP_PORT: String(PORT), STRIP_DIR: DIR3, STRIP_CLAUDE: CLAUDE3, STRIP_MAC: MAC, STRIP_PARENT_PID: String(parent3.pid), CLAUDECODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    server3Out = collect(server3 as any);
    currentLog = server3Out.text;
    await until("the third server's translator", async () => (await state()).translator.status === "ready");
  });

  afterAll(() => {
    try { server3.kill(); } catch {}
    try { parent3.kill(); } catch {}
    rmSync(DIR3, { recursive: true, force: true });
  });

  test("Claude's replies say engine claude, and the helper waits until it's needed", async () => {
    const r = await ask("¿me mandas las slides antes de comer?", { context: CHAT });
    expect(r).toEqual({ status: 200, body: { text: SLIDES, language: "English", from: "target", lint: [], engine: "claude" } });
    expect(macStarts().length).toBe(0);
  });

  test("a polish Claude can't answer is translated on the Mac, and the reply says why", async () => {
    for (const [word, error] of [["EXIT-OFFLINE", "offline"], ["EXIT-LOGIN", "login"], ["EXIT-UPDATE", "update"], ["CRASH", "failed"]]) {
      await settled();
      const claudeTurns = turns3().length;
      const { line, result: r } = await replyLineOf(() => ask(`${word} ¿me mandas las slides?`, { context: CHAT }));
      expect(r).toEqual({ status: 200, body: { text: SLIDES, language: "English", from: "target", lint: [], engine: "mac", fallback: error } });
      expect(line).toMatch(new RegExp(`^reply: mac \\d+ ms · under 100 chars · lint 0 errors · stand-in for ${error}$`));
      expect(turns3().length - claudeTurns).toBe(error === "failed" ? 2 : 1); // failed only after Claude's second try
      expect(macAsks().at(-1)).toMatchObject({ keys: ["id", "text", "target", "auto", "last", "hint"], target: "English", auto: false, last: "Any news?", hint: "es" });
    }
    expect(macStarts().length).toBe(1); // started on first need, then kept
    await settled();
    expect((await ask("¿me mandas las slides?")).body.engine).toBe("claude");
  }, 40000);

  test("no claude to start: the Mac stands in for missing", async () => {
    renameSync(CLAUDE3, `${CLAUDE3}-away`);
    try {
      await post("/api/translator/restart");
      await until("the missing error", async () => (await state()).translator.error === "missing");
      expect(await ask("¿me mandas las slides?")).toEqual({ status: 200, body: { text: SLIDES, language: "English", from: "target", lint: [], engine: "mac", fallback: "missing" } });
    } finally {
      renameSync(`${CLAUDE3}-away`, CLAUDE3);
    }
    await post("/api/translator/restart");
    await statusIs("ready");
  });

  test("the guide error and adjusts never fall back", async () => {
    const asked = macAsks().length;
    const adjust = await post("/api/adjust", { text: "EXIT-OFFLINE más corto", current: "Can you send me the slides?", note: "shorter", language: "English" });
    expect(adjust).toEqual({ status: 503, body: { error: "offline" } });
    rmSync(GUIDE3);
    try {
      await post("/api/translator/restart");
      await until("the guide error", async () => (await state()).translator.error === "guide");
      expect(await ask("¿me mandas las slides?")).toEqual({ status: 503, body: { error: "guide" } });
    } finally {
      writeFileSync(GUIDE3, GUIDE_TEXT);
    }
    expect(macAsks().length).toBe(asked);
    await post("/api/translator/restart");
    await statusIs("ready");
  });

  test("when the helper can't either, the Claude error goes back", async () => {
    await settled();
    expect(await ask("EXIT-OFFLINE MAC-FAIL ¿me mandas las slides?")).toEqual({ status: 503, body: { error: "offline" } });
    await settled();
    expect(await ask("EXIT-OFFLINE MAC-LANG ¿me mandas las slides?")).toEqual({ status: 503, body: { error: "offline" } });
    await settled();
  });

  test("busy while the Mac stands in", async () => {
    await settled();
    const slow = ask("EXIT-OFFLINE MAC-SLOW ¿me mandas las slides?");
    await statusIs("busy");
    expect(await ask("otra cosa")).toEqual({ status: 409, body: { error: "busy" } });
    expect((await slow).body).toMatchObject({ engine: "mac", fallback: "offline" });
    await settled();
  });

  test("the plan's limit falls back with until, and while until is ahead Claude is skipped", async () => {
    await post("/api/translator/restart");
    await statusIs("ready");
    const { line, result: r } = await replyLineOf(() => ask("LIMIT ¿me mandas las slides?"));
    expect(r).toEqual({ status: 200, body: { text: SLIDES, language: "English", from: "target", lint: [], engine: "mac", fallback: "limit", until: LIMIT_UNTIL } });
    expect(line).toMatch(/^reply: mac \d+ ms · under 100 chars · lint 0 errors · stand-in for limit$/);
    expect((await state()).translator).toMatchObject({ error: "limit", until: LIMIT_UNTIL });
    const claudeTurns = turns3().length;
    const asked = macAsks().length;
    expect(await ask("¿me mandas las slides?")).toEqual({ status: 200, body: { text: SLIDES, language: "English", from: "target", lint: [], engine: "mac", fallback: "limit", until: LIMIT_UNTIL } });
    expect(turns3().length).toBe(claudeTurns); // straight to the helper
    expect(macAsks().length).toBe(asked + 1);
    // The helper failing too: the limit, as before, still without asking Claude.
    expect(await ask("MAC-FAIL ¿me mandas las slides?")).toEqual({ status: 503, body: { error: "limit", until: LIMIT_UNTIL } });
    expect(turns3().length).toBe(claudeTurns);
    await post("/api/translator/restart"); // forgets the limit
    await statusIs("ready");
    expect((await ask("¿me mandas las slides?")).body.engine).toBe("claude");
  });

  test("the mac model: no Claude session runs, and the state follows the helper", async () => {
    await statusIs("ready");
    const before = await settle(starts3);
    const spare = before.at(-1).pid;
    const r = await post("/api/settings", { model: "mac" });
    expect(r.body.settings.model).toBe("mac");
    const s = await statusIs("ready");
    expect(s.translator).toMatchObject({ model: "mac", error: null, until: null });
    await until("the spare stopped", async () => !alive(spare));
    await Bun.sleep(400);
    expect(starts3().length).toBe(before.length);
  });

  test("the mac model: a translate goes to the helper with target, Auto, the last message and the hint", async () => {
    const claudeTurns = turns3().length;
    expect((await post("/api/settings", { auto: true, languages: ["English", "Português"] })).status).toBe(200);
    const a = await ask("¿me mandas las slides antes de comer?", { register: "formal", context: PT });
    expect(a).toEqual({ status: 200, body: { text: `[Português] ${SLIDES}`, language: "Português", from: "chat", lint: [], engine: "mac" } });
    expect(macAsks().at(-1)).toMatchObject({ keys: ["id", "text", "target", "auto", "last", "hint"], target: "English", auto: true, last: PT.last, hint: "es" });
    // The one-time override: Auto off.
    const once = await ask("¿me mandas las slides?", { context: PT, target: "Deutsch" });
    expect(once.body).toMatchObject({ text: `[Deutsch] ${SLIDES}`, language: "Deutsch", from: "target", engine: "mac" });
    expect(macAsks().at(-1)).toMatchObject({ target: "Deutsch", auto: false });
    // No context: no last message. The hint follows the dictation locale.
    expect((await post("/api/settings", { auto: false, dictation: "fr-FR" })).status).toBe(200);
    expect((await ask("tu peux m'envoyer les slides ?")).status).toBe(200);
    expect(macAsks().at(-1)).toMatchObject({ keys: ["id", "text", "target", "auto", "hint"], auto: false, hint: "fr" });
    expect((await post("/api/settings", { dictation: "es-MX", languages: ["English"] })).status).toBe(200);
    expect(turns3().length).toBe(claudeTurns); // never Claude
  });

  test("the mac model: the linter runs with no fix turn, and the two fixes apply", async () => {
    const claudeTurns = turns3().length;
    const asked = macAsks().length;
    const { line, result: k } = await replyLineOf(() => ask("MAC-KINDLY ¿me mandas las slides?"));
    expect(line).toMatch(/^reply: mac \d+ ms · under 100 chars · lint 1 errors$/); // the Mac chosen: no stand-in
    expect(k).toEqual({ status: 200, body: { text: "Could you kindly send me the slides before lunch?", language: "English", from: "target", lint: [{ level: "error", message: "Sounds stiff: «kindly»" }], engine: "mac" } });
    expect(macAsks().length).toBe(asked + 1);
    expect(turns3().length).toBe(claudeTurns);
    expect((await ask("MAC-LIST pendientes para mañana:\n- las slides\n- el presupuesto")).body.text).toBe("To do tomorrow:\n- the slides\n- the budget");
    expect((await ask("MAC-LIST pendientes para mañana:\n\n- las slides\n- el presupuesto")).body.text).toBe("To do tomorrow:\n\n- the slides\n\n- the budget");
    expect((await ask("MAC-SMILE gracias")).body.text).toBe("🙂 Thanks 🙂 see https://example.test/:D and a:)b 😉 ok 🙁. Sure 😄");
  });

  test("the mac model: adjust is 409 mac, a language not on this Mac is 503 with both names, a failure is failed", async () => {
    expect(await post("/api/adjust", { text: "¿me mandas las slides?", current: SLIDES, note: "shorter", language: "English" })).toEqual({ status: 409, body: { error: "mac" } });
    expect(await ask("MAC-LANG ¿me mandas las slides?")).toEqual({ status: 503, body: { error: "language", source: "Español", language: "Polski" } });
    expect(await ask("MAC-FAIL ¿me mandas las slides?")).toEqual({ status: 503, body: { error: "failed" } });
    await statusIs("ready");
  });

  test("the mac model: busy while it translates", async () => {
    const slow = ask("MAC-SLOW ¿me mandas las slides?");
    await statusIs("busy");
    expect(await ask("otra cosa")).toEqual({ status: 409, body: { error: "busy" } });
    expect((await slow).status).toBe(200);
    await statusIs("ready");
  });

  test("the helper is started once more when it dies; dying again, it waits for the next request", async () => {
    let n = macStarts().length;
    expect(await ask("MAC-DIE-ONCE ¿me mandas las slides?")).toEqual({ status: 200, body: { text: SLIDES, language: "English", from: "target", lint: [], engine: "mac" } });
    expect(macStarts().length).toBe(n + 1);
    n = macStarts().length;
    expect(await ask("MAC-DIE ¿me mandas las slides?")).toEqual({ status: 503, body: { error: "failed" } });
    expect(macStarts().length).toBe(n + 1); // once, not a loop
    expect((await statusIs("error")).translator.error).toBe("failed");
    await Bun.sleep(400);
    expect(macStarts().length).toBe(n + 1);
    expect((await ask("¿me mandas las slides?")).status).toBe(200); // a request starts it again
    await statusIs("ready");
  });

  test("a helper that says this Mac can't, or isn't there: error mac", async () => {
    writeFileSync(join(DIR3, "fake-mac-cant"), "");
    try {
      await post("/api/translator/restart");
      const s = await until("error mac", async () => ((await state()).translator.error === "mac" ? await state() : false));
      expect(s.translator.status).toBe("error");
      expect(await ask("¿me mandas las slides?")).toEqual({ status: 503, body: { error: "mac" } });
    } finally {
      unlinkSync(join(DIR3, "fake-mac-cant"));
    }
    await post("/api/translator/restart");
    await statusIs("ready");

    renameSync(MAC, `${MAC}-away`);
    try {
      await until("error mac, no helper", async () => (await state()).translator.error === "mac"); // the tick sees it
      expect(await ask("¿me mandas las slides?")).toEqual({ status: 503, body: { error: "mac" } });
      // A Claude model with no helper: the Claude error, as before.
      expect((await post("/api/settings", { model: "haiku" })).status).toBe(200);
      await statusIs("ready");
      await settled();
      expect(await ask("EXIT-OFFLINE ¿me mandas las slides?")).toEqual({ status: 503, body: { error: "offline" } });
    } finally {
      renameSync(`${MAC}-away`, MAC);
    }
  }, 30000);

  test("a Claude model chosen again starts Claude again", async () => {
    await settled();
    const n = (await settle(starts3)).length;
    expect((await post("/api/settings", { model: "mac" })).status).toBe(200);
    await statusIs("ready");
    expect((await post("/api/settings", { model: "sonnet" })).status).toBe(200);
    await until("a sonnet start", async () => starts3().length > n && starts3().at(-1).model === "sonnet");
    const s = await statusIs("ready");
    expect(s.translator.model).toBe("sonnet");
    expect((await ask("¿me mandas las slides?")).body.engine).toBe("claude");
  });

  test("its log says when the Mac stood in, never the text", async () => {
    parent3.kill();
    await Promise.race([server3.exited, Bun.sleep(9000)]);
    await Promise.race([server3Out.done, Bun.sleep(2000)]);
    const log = server3Out.text();
    for (const e of ["offline", "login", "update", "failed", "missing", "limit"]) expect(log).toContain(`translated on the Mac instead (${e})`);
    expect(log).toContain("helper exited (code 1); starting it once more");
    expect(log).toContain("helper exited again (code 1); not starting it until a request");
    expect(log).toContain("the helper says this Mac can't translate");
    expect(log).toContain("spare stopped (translating on this Mac");
    for (const never of [SECRET, "slides", "To do tomorrow", "Pode mandar", "kindly", "Any news", "Kim Park", "Polski", "Ops sync", "Field trip"]) expect(log).not.toContain(never);
    const replies = log.split("\n").filter((l) => /^\S+ reply: /.test(l)).map((l) => l.slice(l.indexOf(" ") + 1));
    expect(replies.some((l) => l.startsWith("reply: mac ") && !l.includes("stand-in"))).toBe(true);
    expect(replies.some((l) => l.includes("stand-in for "))).toBe(true);
    expect(replies.some((l) => l.startsWith("reply: claude "))).toBe(true);
    for (const l of replies) expect(l).toMatch(REPLY_SHAPE);
  }, 30000);
});
