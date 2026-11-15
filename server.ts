// Translation Strip's local server: keeps the hidden translator session alive, answers the page
// and runs the voice linter. Its life (the host check, exit 3, stopping with the app, the state
// stream) comes from the family's kit. It starts only when run.
import { isAbsolute } from "node:path";
import pkg from "./package.json";
import { clock, PARENT_ENV, PORT, PUBLIC_DIR } from "./src/config";
import { lint } from "./src/lint";
import type { Context, Register, Request as Ask } from "./src/protocol";
import { createServer } from "./src/server-kit";
import { fileThere, loadSettings, MODELS, MODES, saveSettings, settingsStamp } from "./src/settings";
import { bump, onBump, snapshot, state, type Mode, type Model } from "./src/state";
import { Translator } from "./src/translator";

const VERSION = process.env.STRIP_VERSION || pkg.version; // the app says its own version; run by hand, package.json's

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const translator = new Translator(() => state.settings, { now: clock });

let stamp = 0;
// Reads settings.json into the state. Returns what changed that the translator cares about.
function readSettings() {
  stamp = settingsStamp();
  const before = state.settings;
  const s = loadSettings();
  state.settings = s;
  const linter = fileThere(s.linter) ? "ok" : "missing";
  if (state.translator.linter !== linter || before.model !== s.model || before.mode !== s.mode) {
    state.translator.linter = linter;
    bump();
  }
  return { model: before.model !== s.model, guide: before.voiceGuide !== s.voiceGuide };
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

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// A polish or an adjust, start to finish: the translator, then the linter. English the linter
// finds an error in gets one fix before the page sees it: an adjust whose note names the errors.
// The fix is kept only when it has fewer errors; else the first English goes back with its
// findings, as before. Warnings are left alone (the guide says they depend on the message).
async function run(r: Ask) {
  if (translator.busy()) return json({ error: "busy" }, 409);
  const out = await translator.request(r);
  if (!out.ok) return json(out.until ? { error: out.error, until: out.until } : { error: out.error }, 503);
  if ("question" in out.reply) return json({ question: out.reply.question });
  if (!("english" in out.reply)) return json({ error: "failed" }, 503);
  let english = out.reply.english;
  let l = await lint(english, state.settings.linter);
  const linter = l.ok ? "ok" : "missing";
  if (state.translator.linter !== linter) {
    state.translator.linter = linter;
    bump();
  }
  const errors = l.lint.filter((f) => f.level === "error");
  if (errors.length && !translator.busy()) {
    const note = `The user's voice guide rules this out, so change only it and keep everything else as it is: ${errors.map((f) => f.message).join(" / ")}`;
    const fix = await translator.request({ task: "adjust", text: r.text, english, note, register: r.register, ...(r.context ? { context: r.context } : {}) });
    if (fix.ok && "english" in fix.reply) {
      const l2 = await lint(fix.reply.english, state.settings.linter);
      const left = l2.lint.filter((f) => f.level === "error").length;
      const kept = left < errors.length;
      if (kept) { english = fix.reply.english; l = l2; }
      fixLog(`${errors.length} linter error${errors.length === 1 ? "" : "s"} in the reply; a fix ${kept ? `kept (${left} left)` : "didn't help, the first reply goes back"}`);
    } else fixLog(`${errors.length} linter error${errors.length === 1 ? "" : "s"} in the reply; the fix got no English, the first reply goes back`);
  }
  return json({ english, lint: l.lint });
}
// Counts only, never the text.
const fixLog = (words: string) => console.error(`${new Date().toISOString()} lint: ${words}`);

async function routes(req: Request, url: URL): Promise<Response | undefined> {
  const post = req.method === "POST";
  if (post && !postAllowed(req)) return json({ error: "forbidden" }, 403);
  if (!url.pathname.startsWith("/api/")) return undefined;

  if (url.pathname === "/api/translate" && post) {
    const b = await body(req);
    const text = str(b?.text).trim();
    if (!text) return json({ error: "text" }, 400);
    return run({ task: "polish", text, register: register(b.register), ...(context(b.context) ? { context: context(b.context) } : {}) });
  }

  if (url.pathname === "/api/adjust" && post) {
    const b = await body(req);
    const text = str(b?.text).trim();
    const english = str(b?.english).trim();
    const note = str(b?.note, 2000).trim();
    if (!english || !note) return json({ error: "text" }, 400);
    return run({ task: "adjust", text, english, note, register: register(b.register), ...(context(b.context) ? { context: context(b.context) } : {}) });
  }

  if (url.pathname === "/api/settings" && post) {
    const b = await body(req);
    if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "settings" }, 400);
    const model = b.model as Model | undefined;
    const mode = b.mode as Mode | undefined;
    if ((model !== undefined && !MODELS.includes(model)) || (mode !== undefined && !MODES.includes(mode))) return json({ error: "settings" }, 400);
    const voiceGuide = pathSetting(b.voiceGuide);
    const linter = pathSetting(b.linter);
    if (voiceGuide === null || linter === null) return json({ error: "path" }, 400);
    // The only writer of settings.json: the page's choices and the paths the app's menu sends.
    saveSettings({ model, mode, voiceGuide, linter });
    const changed = readSettings();
    if (changed.model || changed.guide) translator.restartWhenIdle(changed.model ? "model changed" : "guide setting changed");
    else translator.refresh();
    return json({ settings: { model: state.settings.model, mode: state.settings.mode } });
  }

  if (url.pathname === "/api/translator/restart" && post) {
    readSettings();
    translator.restart("asked");
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
  },
  stop: () => translator.kill(),
  ticks: [
    // settings.json edited by hand, the guide file, a new day, a Mac that slept.
    [2, "settings", () => {
      if (settingsStamp() === stamp) return translator.tick();
      const changed = readSettings();
      if (changed.model || changed.guide) translator.restartWhenIdle(changed.model ? "model changed" : "guide setting changed");
      else translator.refresh();
    }],
  ],
  startedWords: () => `model ${state.settings.model}`,
});

onBump(() => server.broadcast());

if (import.meta.main) server.start();
