// Translation Strip's local server: keeps the hidden translator session alive (or, with the mac
// model, the helper that translates on this Mac), answers the page and runs the voice linter. Its life (the host check, exit 3, stopping with the app, the state
// stream) comes from the family's kit. It starts only when run.
import { isAbsolute } from "node:path";
import pkg from "./package.json";
import { clock, PARENT_ENV, PORT, PUBLIC_DIR } from "./src/config";
import { lint } from "./src/lint";
import { fixMacText, hintFor, MacHelper, type MacOutcome } from "./src/mac";
import { dictationLanguage, isLanguage } from "./src/languages";
import { answerFor, type Context, type Register, type Request as Ask } from "./src/protocol";
import { addUsage, charsOf, claudeQuestionLine, claudeReplyLine, macReplyLine, type Fix } from "./src/reply-log";
import { createServer } from "./src/server-kit";
import { checkChange, fileThere, loadSettings, saveSettings, settingsStamp } from "./src/settings";
import { bump, onBump, publicSettings, snapshot, state, type TranslatorError } from "./src/state";
import { Translator } from "./src/translator";

const VERSION = process.env.STRIP_VERSION || pkg.version; // the app says its own version; run by hand, package.json's

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// A request in progress, on Claude or on the Mac: one at a time.
let working = false;
export const mac = new MacHelper(() => translator.refresh());
export const translator = new Translator(() => state.settings, { now: clock, mac: () => mac.status(), working: () => working });

let stamp = 0;
// Reads settings.json into the state. Returns what changed that the translator cares about.
function readSettings() {
  stamp = settingsStamp();
  const before = state.settings;
  const s = loadSettings();
  state.settings = s;
  const linter = fileThere(s.linter) ? "ok" : "missing";
  if (state.translator.linter !== linter || JSON.stringify(publicSettings(before)) !== JSON.stringify(publicSettings(s))) {
    state.translator.linter = linter;
    bump();
  }
  return { model: before.model !== s.model, guide: before.voiceGuide !== s.voiceGuide };
}

// After settings.json was read: a new spare for a new model or guide (none with mac, whose helper is
// started ahead so the state can say ready).
function settingsChanged(changed: { model: boolean; guide: boolean }) {
  if (changed.model || changed.guide) translator.restartWhenIdle(changed.model ? "model changed" : "guide setting changed");
  else translator.refresh();
  if (state.settings.model === "mac") mac.ensure();
}

// A POST comes from the app's own page or not at all: JSON (so a browser asks first, and the server
// never says yes to another site), and an Origin, when there is one, of this server's own address.
const OWN_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
export function postAllowed(req: Request) {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(type)) return false;
  const origin = req.headers.get("origin");
  return origin === null || OWN_ORIGINS.has(origin);
}

// A path setting: an absolute path to a file that's there, or "" to clear it. undefined: not given.
// null: not valid.
function pathSetting(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return null;
  if (v === "") return "";
  if (v.length > 4096 || v !== v.trim() || v.includes("\0") || !isAbsolute(v) || !fileThere(v)) return null;
  return v;
}

const str = (v: unknown, max = 8000) => (typeof v === "string" ? v.slice(0, max) : "");
function context(v: any): Context | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c: Context = {};
  for (const k of ["chat", "from", "last"] as const) if (typeof v[k] === "string" && v[k].trim()) c[k] = v[k].slice(0, 4000);
  return Object.keys(c).length ? c : undefined;
}
const register = (v: unknown): Register => (v === "formal" ? "formal" : "normal");
// The notes the turn carries: only non-empty ones (the settings keep no others) for languages on the
// list, and none at all when there are none.
function notes() {
  const n = Object.fromEntries(Object.entries(state.settings.notes).filter(([k]) => state.settings.languages.includes(k)));
  return Object.keys(n).length ? { notes: n } : {};
}

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// The linter's state, from its last run.
function linterSeen(ok: boolean) {
  const linter = ok ? "ok" : "missing";
  if (state.translator.linter !== linter) {
    state.translator.linter = linter;
    bump();
  }
}

// One request on the helper, with the request's target and Auto, the chat's last message and the
// dictation locale's language as the hint.
function onMac(r: Ask): Promise<MacOutcome> {
  return mac.translate({ text: r.text, target: r.target, auto: r.auto, ...(r.context?.last ? { last: r.context.last } : {}), hint: hintFor(state.settings.dictation) });
}

// The one log line per answered request: numbers and fixed words, never a text (src/reply-log.ts).
const replyLog = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
const errorCount = (findings: { level: string }[]) => findings.filter((f) => f.level === "error").length;
// How long since the request reached the server.
const since = (t0: number) => performance.now() - t0;

// A reply from the helper: the two fixes on its text, then the linter, with no fix turn.
async function macReply(r: Ask, m: Extract<MacOutcome, { ok: true }>, t0: number, extra: { fallback?: string; until?: string | null } = {}) {
  const text = fixMacText(r.text, m.text);
  const l = await lint(text, state.settings.linter);
  linterSeen(l.ok);
  replyLog(macReplyLine({ ms: since(t0), chars: charsOf(text), lintErrors: errorCount(l.lint), standIn: extra.fallback }));
  return json({ text, language: m.language, from: m.from, lint: l.lint, engine: "mac", ...extra });
}

// The Claude errors the helper stands in for, on a polish. guide, busy and adjusts never fall back.
const STAND_IN = new Set<TranslatorError>(["offline", "limit", "login", "update", "missing", "failed"]);
const standInLog = (error: string) => console.error(`${new Date().toISOString()} translated on the Mac instead (${error})`);
const claudeError = (error: string, until?: string | null) => json(until ? { error, until } : { error }, 503);

// A request, one at a time, start to finish. The state says busy all along, on the helper too.
// t0: when the request reached the server (performance.now()), for the log's time.
async function run(r: Ask, t0: number) {
  if (r.task === "adjust" && state.settings.model === "mac") return json({ error: "mac" }, 409);
  if (working || translator.busy()) return json({ error: "busy" }, 409);
  working = true;
  translator.refresh();
  try {
    return state.settings.model === "mac" ? await runMac(r, t0) : await runClaude(r, t0);
  } finally {
    working = false;
    translator.refresh();
  }
}

// The mac model: the helper, the fixes and the linter. It translates; it doesn't polish or adjust.
async function runMac(r: Ask, t0: number) {
  const m = await onMac(r);
  if (m.ok) return macReply(r, m, t0);
  if (m.error === "language") return json({ error: "language", source: m.source, language: m.language }, 503);
  return json({ error: m.error }, 503);
}

// A Claude model: the translator, then the linter, in any language. A polish Claude can't answer
// (offline, the limit, signed out, an update, not installed, or failed twice) is translated on the
// Mac instead, when the helper can; a limit whose reset time is still ahead goes straight there.
// A reply the linter finds an error in gets one fix before the page sees it: an adjust whose note
// names the errors, in the reply's own language (Auto off), so the fix keeps the language. The fix
// is kept only when it has fewer errors; else the first reply goes back with its findings, as before.
// Warnings are left alone (the guide says they depend on the message).
async function runClaude(r: Ask, t0: number) {
  const model = state.settings.model;
  const until = translator.limitUntil();
  if (r.task === "polish" && until && Date.parse(until) > clock() && mac.available()) {
    const m = await onMac(r);
    if (m.ok) {
      standInLog("limit");
      return macReply(r, m, t0, { fallback: "limit", until });
    }
    return claudeError("limit", until);
  }
  const out = await translator.request(r);
  if (!out.ok) {
    if (r.task === "polish" && !out.stopped && STAND_IN.has(out.error) && mac.available()) {
      const m = await onMac(r);
      if (m.ok) {
        standInLog(out.error);
        return macReply(r, m, t0, { fallback: out.error, ...(out.error === "limit" && out.until ? { until: out.until } : {}) });
      }
    }
    return claudeError(out.error, out.until);
  }
  if ("question" in out.reply) {
    replyLog(claudeQuestionLine({ model, ms: since(t0) }));
    return json({ question: out.reply.question });
  }
  const { language, from } = answerFor(out.reply, r);
  let text = out.reply.text;
  let l = await lint(text, state.settings.linter);
  linterSeen(l.ok);
  const errors = l.lint.filter((f) => f.level === "error");
  let usage = out.usage ?? null;
  let fix: Fix = "none";
  if (errors.length && !translator.busy()) {
    const note = `The user's voice guide rules this out, so change only it and keep everything else as it is: ${errors.map((f) => f.message).join(" / ")}`;
    const fixed = await translator.request({ task: "adjust", text: r.text, current: text, note, register: r.register, target: language, auto: false, ...(r.notes ? { notes: r.notes } : {}), ...(r.context ? { context: r.context } : {}) });
    usage = addUsage(usage, fixed.usage);
    fix = "dropped";
    if (fixed.ok && "text" in fixed.reply) {
      const l2 = await lint(fixed.reply.text, state.settings.linter);
      const left = l2.lint.filter((f) => f.level === "error").length;
      const kept = left < errors.length;
      if (kept) { text = fixed.reply.text; l = l2; fix = "kept"; }
      fixLog(`${errors.length} linter error${errors.length === 1 ? "" : "s"} in the reply; a fix ${kept ? `kept (${left} left)` : "didn't help, the first reply goes back"}`);
    } else fixLog(`${errors.length} linter error${errors.length === 1 ? "" : "s"} in the reply; the fix got no message, the first reply goes back`);
  }
  replyLog(claudeReplyLine({ model, ms: since(t0), usage, lintErrors: errorCount(l.lint), fix, tries: out.tries ?? 1, answeredBy: out.answeredBy }));
  return json({ text, language, from, lint: l.lint, engine: "claude" });
}
// Counts only, never the text.
const fixLog = (words: string) => console.error(`${new Date().toISOString()} lint: ${words}`);

async function routes(req: Request, url: URL): Promise<Response | undefined> {
  const post = req.method === "POST";
  if (post && !postAllowed(req)) return json({ error: "forbidden" }, 403);
  if (!url.pathname.startsWith("/api/")) return undefined;

  const t0 = performance.now(); // the request reached the server
  if (url.pathname === "/api/translate" && post) {
    const b = await body(req);
    const text = str(b?.text).trim();
    if (!text) return json({ error: "text" }, 400);
    // target, when given, is a one-time override: this request writes in it, with Auto off.
    if (b.target !== undefined && !isLanguage(b.target)) return json({ error: "target" }, 400);
    const lang = b.target !== undefined ? { target: b.target as string, auto: false } : { target: state.settings.target, auto: state.settings.auto };
    return run({ task: "polish", text, register: register(b.register), ...lang, ...notes(), ...(context(b.context) ? { context: context(b.context) } : {}) }, t0);
  }

  if (url.pathname === "/api/adjust" && post) {
    const b = await body(req);
    const text = str(b?.text).trim();
    const current = str(b?.current).trim();
    const note = str(b?.note, 2000).trim();
    if (!current || !note) return json({ error: "text" }, 400);
    // An adjust keeps the current text's language: the target is that language, Auto off.
    const language = str(b?.language, 40).trim() || state.settings.target;
    return run({ task: "adjust", text, current, note, register: register(b.register), target: language, auto: false, ...notes(), ...(context(b.context) ? { context: context(b.context) } : {}) }, t0);
  }

  // Settings › Dictation › Claude: what this Mac heard, back with the words it misheard fixed, by the
  // translator (its model, one request on its own session). Only the text goes, as for a translation;
  // the log gets the time only. The page keeps the Mac's words on any error.
  if (url.pathname === "/api/fix" && post) {
    const b = await body(req);
    const text = str(b?.text, 4000).trim();
    if (!text) return json({ error: "text" }, 400);
    if (state.settings.model === "mac") return json({ error: "mac" }, 409);
    if (working || translator.busy()) return json({ error: "busy" }, 409);
    working = true;
    translator.refresh();
    try {
      const out = await translator.request({ task: "fix", text, register: "normal", target: dictationLanguage(str(b?.locale, 10)), auto: false });
      if (!out.ok) return claudeError(out.error, out.until);
      if (!("text" in out.reply)) return json({ error: "failed" }, 503);
      console.error(`${new Date().toISOString()} dictation: checked by Claude in ${Math.round(since(t0))} ms`);
      return json({ text: out.reply.text });
    } finally {
      working = false;
      translator.refresh();
    }
  }

  if (url.pathname === "/api/settings" && post) {
    const b = await body(req);
    if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "settings" }, 400);
    const change = checkChange(b, state.settings);
    if (!change) return json({ error: "settings" }, 400);
    const voiceGuide = pathSetting(b.voiceGuide);
    const linter = pathSetting(b.linter);
    if (voiceGuide === null || linter === null) return json({ error: "path" }, 400);
    // The only writer of settings.json: the page's and Settings' choices and the paths the app sends.
    // The language keys go with each request, so they never restart the translator.
    saveSettings({ ...change, voiceGuide, linter });
    settingsChanged(readSettings());
    return json({ settings: publicSettings() });
  }

  if (url.pathname === "/api/translator/restart" && post) {
    readSettings();
    mac.restart();
    translator.restart("asked");
    if (state.settings.model === "mac") mac.ensure();
    return json({});
  }

  return json({ error: "not found" }, 404);
}

export const server = createServer({
  name: "Translation Strip",
  port: PORT,
  publicDir: PUBLIC_DIR,
  parentEnv: PARENT_ENV,
  serverVersion: VERSION,
  state: () => JSON.stringify({ ...snapshot(), server: { version: VERSION, pid: process.pid } }),
  stateVersion: () => state.version,
  routes,
  noStore: true,
  typed: true,
  start: () => {
    readSettings();
    translator.start("server start");
    if (state.settings.model === "mac") mac.ensure();
  },
  stop: () => {
    translator.kill();
    mac.stop();
  },
  ticks: [
    // settings.json edited by hand, the guide file, a new day, a Mac that slept.
    // With mac, the helper's file may come or go: the state follows.
    [2, "settings", () => {
      if (settingsStamp() === stamp) {
        if (state.settings.model === "mac") translator.refresh();
        return translator.tick();
      }
      settingsChanged(readSettings());
    }],
  ],
  startedWords: () => `model ${state.settings.model}`,
});

onBump(() => server.broadcast());

if (import.meta.main) server.start();
