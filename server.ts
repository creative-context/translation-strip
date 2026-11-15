// Translation Strip's local server: keeps the hidden translator session alive, answers the page
// and runs the voice linter. Its life (the host check, exit 3, stopping with the app, the state
// stream) comes from the family's kit. It starts only when run.
import pkg from "./package.json";
import { PARENT_ENV, PORT, PUBLIC_DIR } from "./src/config";
import { lint } from "./src/lint";
import type { Context, Register, Request as Ask } from "./src/protocol";
import { createServer } from "./src/server-kit";
import { fileThere, loadSettings, MODELS, MODES, saveSettings, settingsStamp } from "./src/settings";
import { bump, onBump, snapshot, state, type Mode, type Model } from "./src/state";
import { Translator } from "./src/translator";

const VERSION = process.env.STRIP_VERSION || pkg.version; // the app says its own version; run by hand, package.json's

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const translator = new Translator(() => state.settings);

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

// A polish or an adjust, start to finish: the translator, then the linter.
async function run(r: Ask) {
  if (translator.busy()) return json({ error: "busy" }, 409);
  const out = await translator.request(r);
  if (!out.ok) return json(out.until ? { error: out.error, until: out.until } : { error: out.error }, 503);
  if ("question" in out.reply) return json({ question: out.reply.question });
  if (!("english" in out.reply)) return json({ error: "failed" }, 503);
  const l = await lint(out.reply.english, state.settings.linter);
  const linter = l.ok ? "ok" : "missing";
  if (state.translator.linter !== linter) {
    state.translator.linter = linter;
    bump();
  }
  return json({ english: out.reply.english, lint: l.lint });
}

async function routes(req: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/")) return undefined;
  const post = req.method === "POST";

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
    const model = b?.model as Model | undefined;
    const mode = b?.mode as Mode | undefined;
    if ((model !== undefined && !MODELS.includes(model)) || (mode !== undefined && !MODES.includes(mode))) return json({ error: "settings" }, 400);
    saveSettings({ model, mode });
    const changed = readSettings();
    if (changed.model) translator.restartWhenIdle("model changed");
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
    // settings.json edited outside the server (the app's menu), the guide file, a new day.
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
