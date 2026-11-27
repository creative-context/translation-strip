// A stand-in server for trying the page before the real one is joined: it serves public/ on
// 127.0.0.1:4813 (STRIP_MOCK_PORT changes it) and answers the contract's routes with canned replies.
// Made-up text only.
//
//   bun test/page-mock.ts
//
// Languages: with Auto on, a reply follows the stand-in chat's last message when it's clearly in one
// language (the page's ?chat=pt gives a Portuguese one; the default is English; ?chat=new has none, so
// the target); a request's `target` writes in it with Auto off. Replies exist in English, Português,
// Español and Français; any other language gets the English text, named as that language.
//
// What the Spanish text can say to make it answer differently (case doesn't matter):
//   UNCLEAR   a question instead of a polish        OFFLINE   error "offline"      LIMIT   error "limit" (until in 2 h)
//   GUIDE     error "guide"                          FAILED    error "failed"       BUSY    409 busy twice, then a polish
//   kindly    a polish with a voice-check finding    STARTING  the translator starts again (3 s) before it answers
//   LOGIN     error "login" (Claude Code isn't signed in)      UPDATE    error "update" (Claude Code needs an update)
//   NOCLAUDE  error "missing" (Claude Code isn't installed, or not where it installs to)
//   SLOW      a long English streamed slowly (a word every 120 ms, about 4 s), whose final reply drops a word, as the linter's fix would
//   ASKLATE   English words stream for about a second, then the answer is a question
// Adjust notes: "corto" or "short" gives a shorter English; "UNCLEAR" a question; "OFFLINE" and the others as above; SLOW as above.
// Streaming: a page that asks for it (Accept: application/x-ndjson) gets a translate's or an adjust's English as the server
// sends it, { "partial": "<the words so far>" } lines, then { "status", "body" }. The usual reply's words start at 60 % of its
// 700 ms and are all there by its end, so "Translating…" still shows first; a question or an error doesn't stream.
// This Mac's Translation (the model "mac"): the page's URL picks it, read from each request's Referer, so one page can
// try it while the others don't: ?model=mac answers as the Mac (engine "mac", no register, adjust refused with 409 mac),
// ?fallback=<error> as the Mac standing in for Claude after that error (offline, limit, login, update, missing, failed).
// Choosing Mac in the menu does the same for every page. On the Mac, the text can say:
//   NOMAC     error "mac" (this Mac can't translate)    NOTONMAC   error "language" (Español to 日本語 isn't on this Mac)
// The update check (0.12.0): ?claude=changed answers as a server whose Claude Code check found flags missing
// (translator.check "changed", with made-up flags in translator.missing); the state says check null otherwise, as
// before the check has run. The page's ?check=changed is the stand-in Teams' side of it.
// The page's own preview flags (in the URL, for the stand-in Teams): ?shape=unknown (Teams' message box can't be found), ?shape=several (two boxes, none with the cursor),
// ?send=no-paste or ?send=not-own-server (and the other send reasons), ?teams=closed|nochat, ?draft=1, ?access=0, ?mic=denied.
import { join } from "node:path";

const PORT = Number(process.env.STRIP_MOCK_PORT) || 4813;
const PUBLIC = join(import.meta.dir, "..", "public");
const DELAY = 700;

const LANGUAGES = ["English", "Español", "Português", "Français", "Deutsch", "Italiano", "Nederlands", "Polski", "Svenska", "Türkçe", "日本語", "한국어", "中文"];
const DICTATION = [
  { id: "es-MX", name: "Español (México)" }, { id: "es-US", name: "Español (EE. UU.)" }, { id: "es-ES", name: "Español (España)" },
  { id: "en-US", name: "English (US)" }, { id: "en-GB", name: "English (UK)" }, { id: "pt-BR", name: "Português (Brasil)" },
  { id: "pt-PT", name: "Português (Portugal)" }, { id: "fr-FR", name: "Français" }, { id: "de-DE", name: "Deutsch" }, { id: "it-IT", name: "Italiano" },
];
type Settings = { model: "haiku" | "sonnet" | "opus" | "mac"; mode: "send" | "leave"; target: string; auto: boolean; languages: string[]; notes: Record<string, string>; dictation: string };
// The mock starts with two languages, so the menu's Reply in row has a choice (the app's default is English alone).
const MOCK_DEFAULTS: Settings = { model: "sonnet", mode: "send", target: "English", auto: false, languages: ["English", "Português"], notes: {}, dictation: "es-MX", dictationEngine: "mac", dictationSounds: true, dictationPhrase: "review" };
const settings: Settings = structuredClone(MOCK_DEFAULTS);
const translator = { status: "ready" as "starting" | "ready" | "busy" | "error", error: null as string | null, until: null as string | null, guide: "ok", linter: "ok" };
let version = 0;
const busyCount = new Map<string, number>();

// The settings as the state carries them: with the guide's and the linter's file names (made up), never a path.
const fullSettings = () => ({ ...settings, files: { voiceGuide: "voice-guide.md", linter: "voice-lint.mjs" } });

// The page's ?model=mac and ?fallback=<error>, from the Referer of its requests (the page's own address).
type Flags = { model: string | null; fallback: string | null; claude?: string | null };
function flagsOf(req: Request): Flags {
  try {
    const u = new URL(req.headers.get("referer") ?? "");
    return { model: u.searchParams.get("model"), fallback: u.searchParams.get("fallback"), claude: u.searchParams.get("claude") };
  } catch { return { model: null, fallback: null }; }
}
const NO_FLAGS: Flags = { model: null, fallback: null };
// The Claude Code check, as the page's URL asks for it.
const checkFor = (f: Flags) => (f.claude === "changed" ? { check: "changed", missing: ["--input-format", "--strict-mcp-config"] } : { check: null });
const modelFor = (f: Flags) => (f.model === "mac" ? "mac" : settings.model);

function state(f: Flags = NO_FLAGS) {
  return JSON.stringify({
    now: Date.now(),
    server: { version: "mock", pid: process.pid },
    translator: { ...translator, ...checkFor(f), model: modelFor(f) },
    settings: { ...fullSettings(), model: modelFor(f) },
    options: { languages: LANGUAGES, dictation: DICTATION },
  });
}

// ---- the state stream: same shape as the kit's (a state, then a ping every 9 s)
const clients = new Map<ReadableStreamDefaultController<Uint8Array>, Flags>();
const enc = new TextEncoder();
function broadcast() {
  version++;
  for (const [c, f] of clients) {
    try { c.enqueue(enc.encode(`data: ${state(f)}\n\n`)); } catch { clients.delete(c); }
  }
}
setInterval(() => {
  for (const c of clients.keys()) {
    try { c.enqueue(enc.encode("event: ping\ndata: {}\n\n")); } catch { clients.delete(c); }
  }
}, 9000);

function restart(ms: number) {
  translator.status = "starting";
  broadcast();
  setTimeout(() => { translator.status = "ready"; broadcast(); }, ms);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SLOW_STREAMED = "I went through the budget this morning and found two lines that really don't add up, so could we go over them together on Thursday's call before it goes out?";
const SLOW_FINAL = SLOW_STREAMED.replace("really ", "");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A Claude reply, after `ms`. A page that asks for a stream gets its English word by word: nothing for `quiet` ms, then the
// words spread over the rest (or `every` ms apart, for SLOW), then the final line. `words`: the English that streams, when it
// differs from the final reply's (SLOW, ASKLATE).
type Pace = { ms: number; quiet?: number; every?: number; words?: string };
function claudeReply(req: Request, body: any, pace: Pace): Response | Promise<Response> {
  const shown: string = pace.words ?? (typeof body.text === "string" ? body.text : "");
  if (!/application\/x-ndjson/.test(req.headers.get("accept") ?? "") || !shown) return sleep(pace.ms).then(() => json(body));
  const parts = shown.split(/(?<= )/);
  const quiet = pace.quiet ?? Math.round(pace.ms * 0.6);
  const every = pace.every ?? Math.max(10, Math.floor((pace.ms - quiet) / parts.length));
  return new Response(new ReadableStream<Uint8Array>({
    async start(c) {
      const line = (o: unknown) => { try { c.enqueue(enc.encode(JSON.stringify(o) + "\n")); return true; } catch { return false; } };
      await sleep(quiet);
      let sofar = "";
      for (const p of parts) {
        sofar += p;
        if (!line({ partial: sofar.trim() })) return;
        await sleep(every);
      }
      line({ status: 200, body });
      try { c.close(); } catch {}
    },
  }), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

async function waitReady() {
  while (translator.status === "starting") await sleep(100);
}

// What the text asks for, or null for a plain polish.
async function trigger(text: string): Promise<Response | null> {
  const t = text.toLowerCase();
  if (t.includes("unclear")) return json({ question: "This Thursday or next week's?" });
  if (t.includes("offline")) return json({ error: "offline" }, 503);
  if (t.includes("limit")) return json({ error: "limit", until: new Date(Date.now() + 2 * 3600_000).toISOString() }, 503);
  if (t.includes("noclaude")) return json({ error: "missing" }, 503);
  if (t.includes("login")) return json({ error: "login" }, 503);
  if (t.includes("update")) return json({ error: "update" }, 503);
  if (t.includes("guide")) return json({ error: "guide" }, 503);
  if (t.includes("failed")) return json({ error: "failed" }, 503);
  if (t.includes("busy")) {
    const n = (busyCount.get(t) ?? 0) + 1;
    busyCount.set(t, n);
    if (n <= 2) return json({ error: "busy" }, 409);
    busyCount.delete(t);
  }
  return null;
}

const POLISH: Record<string, { normal: string; formal: string; shorter: string }> = {
  English: {
    normal: "Could you take a look at the budget before Thursday? If needed, we can go over it on the call.",
    formal: "Would you be able to review the budget before Thursday? If necessary, we can discuss it during the call.",
    shorter: "Can you check the budget before Thursday? We can cover it on the call.",
  },
  "Português": {
    normal: "Você consegue dar uma olhada no orçamento antes de quinta? Se precisar, vemos na chamada.",
    formal: "O senhor poderia revisar o orçamento antes de quinta-feira? Se necessário, podemos conversar na chamada.",
    shorter: "Consegue ver o orçamento até quinta? Falamos na chamada.",
  },
  "Español": {
    normal: "¿Puedes revisar el presupuesto antes del jueves? Si hace falta, lo vemos en la llamada.",
    formal: "¿Podría revisar el presupuesto antes del jueves? Si es necesario, lo vemos en la llamada.",
    shorter: "¿Revisas el presupuesto antes del jueves? Lo vemos en la llamada.",
  },
  "Français": {
    normal: "Tu peux jeter un œil au budget avant jeudi ? Si besoin, on en parle pendant l'appel.",
    formal: "Pourriez-vous examiner le budget avant jeudi ? Si nécessaire, nous en parlerons pendant l'appel.",
    shorter: "Tu regardes le budget avant jeudi ? On en parle à l'appel.",
  },
};
const polishIn = (language: string) => POLISH[language] ?? POLISH.English;
// The language a last message is clearly in, or null: a few made-up markers per language are enough here.
function chatLanguage(last: unknown): string | null {
  const t = typeof last === "string" ? last.toLowerCase() : "";
  if (!t.trim()) return null;
  if (/você|ção|ã|õ|obrigad/.test(t)) return "Português";
  if (/vous|merci|peux|ç|è|ê/.test(t)) return "Français";
  if (/[¿¡ñ]|puedes|gracias/.test(t)) return "Español";
  if (/\b(the|you|could|please|thanks|send)\b/.test(t)) return "English";
  return null;
}
const lintFor = (english: string, text: string) =>
  /kindly/i.test(text) || /kindly/i.test(english) ? [{ level: "warning", message: "\"Kindly\" sounds stiff" }] : [];

// This Mac's Translation: the text in the language, as Translation gives it (no register, no question, no guide).
// fallback: the Claude error it stands in for, when it does.
async function onMac(body: any, fallback: string | null) {
  const text = String(body?.text ?? "");
  if (/notonmac/i.test(text)) return json({ error: "language", source: "Español", language: "日本語" }, 503);
  if (/nomac/i.test(text)) return json({ error: "mac" }, 503);
  await sleep(DELAY / 2);
  const override = typeof body?.target === "string" ? body.target : null;
  if (override !== null && !LANGUAGES.includes(override)) return json({ error: "target" }, 400);
  const fromChat = override === null && settings.auto ? chatLanguage(body?.context?.last) : null;
  const language = override ?? fromChat ?? settings.target;
  const out = /kindly/i.test(text) ? "Kindly review the budget before Thursday." : polishIn(language).normal;
  const reply: any = { text: out, language, from: fromChat ? "chat" : "target", lint: lintFor(out, text), engine: "mac" };
  if (fallback) {
    reply.fallback = fallback;
    if (fallback === "limit") reply.until = new Date(Date.now() + 2 * 3600_000).toISOString();
  }
  return json(reply);
}

async function translate(req: Request, body: any, flags: Flags = NO_FLAGS) {
  const text = String(body?.text ?? "");
  if (modelFor(flags) === "mac") return onMac(body, null);
  if (flags.fallback) return onMac(body, flags.fallback);
  if (/starting/i.test(text) && translator.status !== "starting") restart(3000);
  await waitReady();
  const hit = await trigger(text);
  if (hit) return hit;
  if (/asklate/i.test(text)) return claudeReply(req, { question: "This Thursday or next week's?" }, { ms: 1200, quiet: 200, every: 90, words: EN_SLOW_ASK });
  if (/slow/i.test(text)) return claudeReply(req, { text: SLOW_FINAL, language: settings.target, from: "target", lint: [], engine: "claude" }, { ms: 4000, quiet: 300, every: 120, words: SLOW_STREAMED });
  const register = body?.register === "formal" ? "formal" : "normal";
  // A one-time target writes in it with Auto off; else Auto follows the chat when it's clear.
  const override = typeof body?.target === "string" ? body.target : null;
  if (override !== null && !LANGUAGES.includes(override)) return json({ error: "target" }, 400);
  const fromChat = override === null && settings.auto ? chatLanguage(body?.context?.last) : null;
  const language = override ?? fromChat ?? settings.target;
  const out = /kindly/i.test(text) ? "Kindly review the budget before Thursday." : polishIn(language)[register];
  return claudeReply(req, { text: out, language, from: fromChat ? "chat" : "target", lint: lintFor(out, text), engine: "claude" }, { ms: DELAY });
}
const EN_SLOW_ASK = "Could you take a look at the budget before";

// POST /api/fix: Claude checking dictated words. The made-up misheard "pre su puesto" comes back fixed after a
// moment; words with FIXFAIL answer 503 offline, so the page keeps the Mac's words.
async function fix(body: any, flags: Flags = NO_FLAGS) {
  if (modelFor(flags) === "mac") return json({ error: "mac" }, 409);
  const text = String(body?.text ?? "").trim();
  if (!text) return json({ error: "text" }, 400);
  await Bun.sleep(500);
  if (text.includes("FIXFAIL")) return json({ error: "offline" }, 503);
  return json({ text: text.replace(/\bpre su puesto\b/g, "presupuesto") });
}

async function adjust(req: Request, body: any, flags: Flags = NO_FLAGS) {
  if (modelFor(flags) === "mac") return json({ error: "mac" }, 409);
  const note = String(body?.note ?? "");
  const current = String(body?.current ?? "");
  const text = String(body?.text ?? "");
  // An adjust keeps the current text's language.
  const language = LANGUAGES.includes(body?.language) ? body.language : settings.target;
  const hit = await trigger(note);
  if (hit) return hit;
  if (/slow/i.test(note)) return claudeReply(req, { text: SLOW_FINAL, language, from: "target", lint: [], engine: "claude" }, { ms: 4000, quiet: 300, every: 120, words: SLOW_STREAMED });
  const out = /cort|short|breve/i.test(note) ? polishIn(language).shorter : `${current.replace(/ \(adjusted\)$/, "")} (adjusted)`;
  return claudeReply(req, { text: out, language, from: "target", lint: lintFor(out, text), engine: "claude" }, { ms: DELAY });
}

// POST /api/settings, with the contract's rules: anything outside them is 400 { error: "settings" } and changes nothing.
function applySettings(body: any): boolean {
  const next = structuredClone(settings);
  const has = (k: string) => body && Object.prototype.hasOwnProperty.call(body, k);
  if (has("model")) { if (!["haiku", "sonnet", "opus", "mac"].includes(body.model)) return false; next.model = body.model; }
  if (has("mode")) { if (!["send", "leave"].includes(body.mode)) return false; next.mode = body.mode; }
  if (has("target")) { if (!LANGUAGES.includes(body.target)) return false; next.target = body.target; }
  if (has("auto")) { if (typeof body.auto !== "boolean") return false; next.auto = body.auto; }
  if (has("languages")) {
    const l = body.languages;
    if (!Array.isArray(l) || l.length < 1 || l.length > 8 || new Set(l).size !== l.length || !l.every((x: any) => LANGUAGES.includes(x))) return false;
    next.languages = [...l];
  }
  if (has("notes")) {
    const n = body.notes;
    if (!n || typeof n !== "object" || Array.isArray(n)) return false;
    for (const [k, v] of Object.entries(n)) {
      if (!LANGUAGES.includes(k) || typeof v !== "string" || v.trim().length > 600) return false;
      if (v === "") delete next.notes[k]; else next.notes[k] = v;
    }
  }
  if (has("dictation")) { if (!DICTATION.some((d) => d.id === body.dictation)) return false; next.dictation = body.dictation; }
  if (has("dictationEngine")) { if (!["mac", "claude"].includes(body.dictationEngine)) return false; next.dictationEngine = body.dictationEngine; }
  if (has("dictationPhrase")) { if (!["review", "send"].includes(body.dictationPhrase)) return false; next.dictationPhrase = body.dictationPhrase; }
  if (has("dictationSounds")) { if (typeof body.dictationSounds !== "boolean") return false; next.dictationSounds = body.dictationSounds; }
  // A target that isn't one of your languages joins them; with eight already, the server refuses it.
  if (!next.languages.includes(next.target)) { if (next.languages.length >= 8) return false; next.languages = [...next.languages, next.target]; }
  // Notes belong to a language on the list, as on the server.
  for (const k of Object.keys(next.notes)) if (!next.languages.includes(k)) delete next.notes[k];
  const restart = next.model !== settings.model;
  Object.assign(settings, next);
  if (restart) restartSoon();
  return true;
}
const restartSoon = () => restart(1500);

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    if (!new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]).has(req.headers.get("host") ?? "")) return new Response("Forbidden", { status: 403 });
    const url = new URL(req.url);
    const p = url.pathname;

    const flags = flagsOf(req);
    if (p === "/api/state") return new Response(state(flags), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (p === "/api/stream") {
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) { ctrl = c; clients.set(c, flags); c.enqueue(enc.encode(`data: ${state(flags)}\n\n`)); },
          cancel() { clients.delete(ctrl); },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    }
    if (req.method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch {}
      if (p === "/api/translate") return translate(req, body, flags);
      if (p === "/api/adjust") return adjust(req, body, flags);
      if (p === "/api/fix") return fix(body, flags);
      if (p === "/api/settings") {
        if (!applySettings(body)) return json({ error: "settings" }, 400);
        broadcast();
        return json({ settings: { ...fullSettings(), model: modelFor(flags) } });
      }
      if (p === "/api/translator/restart") { restart(1500); return json({}); }
      return json({ error: "not found" }, 404);
    }

    const file = p === "/" ? "index.html" : p.slice(1);
    if (!/^[\w.-]+$/.test(file)) return new Response("Not found", { status: 404 });
    const f = Bun.file(join(PUBLIC, file));
    if (!(await f.exists())) return new Response("Not found", { status: 404 });
    const ext = file.split(".").pop() ?? "";
    const types: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css" };
    return new Response(f, { headers: { "content-type": types[ext] ?? "application/octet-stream", "cache-control": "no-store" } });
  },
});
console.log(`page mock on http://127.0.0.1:${PORT}  (canned replies; nothing real is called)`);
