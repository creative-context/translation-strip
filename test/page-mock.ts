// A stand-in server for trying the page before the real one is joined: it serves public/ on
// 127.0.0.1:4813 and answers the contract's routes with canned replies. Made-up text only.
//
//   bun test/page-mock.ts
//
// What the Spanish text can say to make it answer differently (case doesn't matter):
//   UNCLEAR   a question instead of a polish        OFFLINE   error "offline"      LIMIT   error "limit" (until in 2 h)
//   GUIDE     error "guide"                          FAILED    error "failed"       BUSY    409 busy twice, then a polish
//   kindly    a polish with a voice-check finding    STARTING  the translator starts again (3 s) before it answers
//   LOGIN     error "login" (Claude Code isn't signed in)      UPDATE    error "update" (Claude Code needs an update)
// Adjust notes: "corto" or "short" gives a shorter English; "UNCLEAR" a question; "OFFLINE" and the others as above.
// The page's own preview flags (in the URL, for the stand-in Teams): ?shape=unknown (Teams' message box can't be found), ?shape=several (two boxes, none with the cursor),
// ?send=no-paste or ?send=not-own-server (and the other send reasons), ?teams=closed|nochat, ?draft=1, ?access=0, ?mic=denied.
import { join } from "node:path";

const PORT = 4813;
const PUBLIC = join(import.meta.dir, "..", "public");
const DELAY = 700;

type Settings = { model: "haiku" | "sonnet" | "opus"; mode: "send" | "leave" };
const settings: Settings = { model: "haiku", mode: "send" };
const translator = { status: "ready" as "starting" | "ready" | "busy" | "error", error: null as string | null, until: null as string | null, guide: "ok", linter: "ok" };
let version = 0;
const busyCount = new Map<string, number>();

function state() {
  return JSON.stringify({
    now: Date.now(),
    server: { version: "mock", pid: process.pid },
    translator: { ...translator, model: settings.model },
    settings,
  });
}

// ---- the state stream: same shape as the kit's (a state, then a ping every 9 s)
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
function broadcast() {
  version++;
  const msg = enc.encode(`data: ${state()}\n\n`);
  for (const c of clients) {
    try { c.enqueue(msg); } catch { clients.delete(c); }
  }
}
setInterval(() => {
  for (const c of clients) {
    try { c.enqueue(enc.encode("event: ping\ndata: {}\n\n")); } catch { clients.delete(c); }
  }
}, 9000);

function restart(ms: number) {
  translator.status = "starting";
  broadcast();
  setTimeout(() => { translator.status = "ready"; broadcast(); }, ms);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function waitReady() {
  while (translator.status === "starting") await sleep(100);
}

// What the text asks for, or null for a plain polish.
async function trigger(text: string): Promise<Response | null> {
  const t = text.toLowerCase();
  if (t.includes("unclear")) return json({ question: "This Thursday or next week's?" });
  if (t.includes("offline")) return json({ error: "offline" }, 503);
  if (t.includes("limit")) return json({ error: "limit", until: new Date(Date.now() + 2 * 3600_000).toISOString() }, 503);
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

const POLISH = {
  normal: "Could you take a look at the budget before Thursday? If needed, we can go over it on the call.",
  formal: "Would you be able to review the budget before Thursday? If necessary, we can discuss it during the call.",
};
const lintFor = (english: string, text: string) =>
  /kindly/i.test(text) || /kindly/i.test(english) ? [{ level: "warning", message: "\"Kindly\" sounds stiff" }] : [];

async function translate(body: any) {
  const text = String(body?.text ?? "");
  if (/starting/i.test(text) && translator.status !== "starting") restart(3000);
  await waitReady();
  const hit = await trigger(text);
  if (hit) return hit;
  await sleep(DELAY);
  const register = body?.register === "formal" ? "formal" : "normal";
  const english = /kindly/i.test(text) ? "Kindly review the budget before Thursday." : POLISH[register];
  return json({ english, lint: lintFor(english, text) });
}

async function adjust(body: any) {
  const note = String(body?.note ?? "");
  const english = String(body?.english ?? "");
  const text = String(body?.text ?? "");
  const hit = await trigger(note);
  if (hit) return hit;
  await sleep(DELAY);
  const out = /cort|short|breve/i.test(note) ? "Can you check the budget before Thursday? We can cover it on the call." : `${english.replace(/ \(adjusted\)$/, "")} (adjusted)`;
  return json({ english: out, lint: lintFor(out, text) });
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    if (!new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]).has(req.headers.get("host") ?? "")) return new Response("Forbidden", { status: 403 });
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/api/state") return new Response(state(), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (p === "/api/stream") {
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) { ctrl = c; clients.add(c); c.enqueue(enc.encode(`data: ${state()}\n\n`)); },
          cancel() { clients.delete(ctrl); },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    }
    if (req.method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch {}
      if (p === "/api/translate") return translate(body);
      if (p === "/api/adjust") return adjust(body);
      if (p === "/api/settings") {
        if (body?.model === "haiku" || body?.model === "sonnet" || body?.model === "opus") {
          const changed = body.model !== settings.model;
          settings.model = body.model;
          if (changed) restart(1500);
        }
        if (body?.mode === "send" || body?.mode === "leave") settings.mode = body.mode;
        broadcast();
        return json({ settings });
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
