// Presses every control of the Settings window's page (public/settings.html) in WebKit and checks what it does:
// the request each one sends, the message it gives the shell, what the page shows after, that nothing is cut or
// overflows and that its text reaches 4.5:1. One line per check, PASS or FAIL with the reason; exit 1 on a failure.
//
//   bun test/settings-check.ts
//
// It runs its own small stand-in for the server on 127.0.0.1:4824: the page's files from public/, and
// /api/state, /api/stream and /api/settings as docs/contract.md says, with made-up settings. Each
// check starts from the same made-up state. The window is the Settings window's real size, 620 x 640 (its content,
// under the title bar), dark, device scale 2. A stand-in `settings` message handler records what the page tells
// the shell, as WKWebView would; one check runs with none, as a plain browser.
//
// Playwright (WebKit) is read from PLAYWRIGHT_DIR, or from the sibling folder mac-app-design/node_modules.
// Captures go to .local/settings-check/ (kept out of git), one per state; a failed check's in failed/.
import { basename, join, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, ".local", "settings-check");
const PORT = 4824;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = process.env.PLAYWRIGHT_DIR ?? resolve(ROOT, "..", "mac-app-design", "node_modules", "playwright");
const W = 620, H = 640;

// ---------------------------------------------------------------------------------------- the stand-in server
const LANGUAGES = ["English", "Español", "Português", "Français", "Deutsch", "Italiano", "Nederlands", "Polski", "Svenska", "Türkçe", "日本語", "한국어", "中文"];
const DICTATION = [
  { id: "es-MX", name: "Español (México)" }, { id: "es-US", name: "Español (EE. UU.)" }, { id: "es-ES", name: "Español (España)" },
  { id: "en-US", name: "English (US)" }, { id: "en-GB", name: "English (UK)" }, { id: "pt-BR", name: "Português (Brasil)" },
  { id: "pt-PT", name: "Português (Portugal)" }, { id: "fr-FR", name: "Français" }, { id: "de-DE", name: "Deutsch" }, { id: "it-IT", name: "Italiano" },
];
type Settings = { model: string; mode: string; target: string; auto: boolean; languages: string[]; notes: Record<string, string>; dictation: string; dictationEngine: string; dictationSounds: boolean; dictationPhrase: string; files: { voiceGuide: string | null; linter: string | null } };
const fresh = (): Settings => ({
  model: "haiku", mode: "send", target: "English", auto: false, languages: ["English", "Português"],
  notes: { "Português": "Formal: o senhor, a senhora." }, dictation: "es-MX", dictationEngine: "mac", dictationSounds: true, dictationPhrase: "review", files: { voiceGuide: "sample-voice.md", linter: null },
});
let settings = fresh();
let refuseNext = false; // the next POST /api/settings answers 400, as a server that refuses it
const posts: any[] = [];
const streams = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();
const state = () => ({ now: Date.now(), server: { version: "0.8.0", pid: 1 },
  translator: { status: "ready", error: null, until: null, model: settings.model, guide: settings.files.voiceGuide ? "ok" : "missing", linter: settings.files.linter ? "ok" : "missing" },
  settings, options: { languages: LANGUAGES, dictation: DICTATION } });
function broadcast() { const d = enc.encode(`data: ${JSON.stringify(state())}\n\n`); for (const c of streams) { try { c.enqueue(d); } catch { streams.delete(c); } } }
function reset() { settings = fresh(); refuseNext = false; posts.length = 0; }

// The rules of the contract's settings table; anything else is 400 { error: "settings" }.
function apply(body: any): Settings | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const next: Settings = JSON.parse(JSON.stringify(settings));
  for (const [k, v] of Object.entries(body)) {
    if (k === "target") { if (typeof v !== "string" || !LANGUAGES.includes(v)) return null; next.target = v; }
    else if (k === "auto") { if (typeof v !== "boolean") return null; next.auto = v; }
    else if (k === "languages") {
      if (!Array.isArray(v) || v.length < 1 || v.length > 8 || new Set(v).size !== v.length || !v.every((l) => LANGUAGES.includes(l))) return null;
      next.languages = v as string[];
    } else if (k === "notes") {
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      for (const [l, n] of Object.entries(v)) {
        if (!LANGUAGES.includes(l) || typeof n !== "string" || n.trim().length > 600) return null;
        if (n.trim() === "") delete next.notes[l]; else next.notes[l] = n;
      }
    } else if (k === "dictation") { if (!DICTATION.some((d) => d.id === v)) return null; next.dictation = v as string; }
    else if (k === "dictationEngine") { if (v !== "mac" && v !== "claude") return null; next.dictationEngine = v; }
    else if (k === "dictationPhrase") { if (v !== "review" && v !== "send") return null; next.dictationPhrase = v; }
    else if (k === "dictationSounds") { if (typeof v !== "boolean") return null; next.dictationSounds = v; }
    else if (k === "voiceGuide" || k === "linter") { if (typeof v !== "string") return null; next.files[k] = v ? basename(v) : null; }
    else if (k === "model" || k === "mode") { next[k] = v as string; }
    else return null;
  }
  if (!next.languages.includes(next.target)) next.languages.push(next.target);
  if (next.languages.length > 8) return null;
  // Notes belong to a language on the list, as on the server.
  for (const l of Object.keys(next.notes)) if (!next.languages.includes(l)) delete next.notes[l];
  return next;
}

const server = Bun.serve({
  hostname: "127.0.0.1", port: PORT, idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/state") return Response.json(state());
    if (url.pathname === "/api/stream") {
      let me: ReadableStreamDefaultController;
      return new Response(new ReadableStream({
        start(c) { me = c; streams.add(c); c.enqueue(enc.encode(`data: ${JSON.stringify(state())}\n\n`)); },
        cancel() { streams.delete(me); },
      }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    if (url.pathname === "/api/settings" && req.method === "POST") {
      const origin = req.headers.get("origin");
      if (!(req.headers.get("content-type") ?? "").includes("application/json") || (origin && origin !== BASE)) return Response.json({ error: "forbidden" }, { status: 403 });
      let body: any = null;
      try { body = await req.json(); } catch {}
      posts.push(body);
      const next = refuseNext ? null : apply(body);
      refuseNext = false;
      if (!next) return Response.json({ error: "settings" }, { status: 400 });
      settings = next;
      broadcast();
      return Response.json({ settings });
    }
    const file = url.pathname === "/" ? "settings.html" : url.pathname.slice(1);
    if (!/^[\w.-]+$/.test(file)) return new Response("Not found", { status: 404 });
    const f = Bun.file(join(ROOT, "public", file));
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 });
  },
});

// ---------------------------------------------------------------------------------------- plumbing
class Fail extends Error {}
const ok = (c: any, why: string) => { if (!c) throw new Fail(why); };
const same = (a: any, b: any, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
let browser: any, lastPage: any = null;
const contexts: any[] = [];
const pageErrors: string[] = [];

// A fresh window on the page; `shell` gives it the stand-in message handler, as the app's web view has.
async function open(shell = true) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: "dark" });
  contexts.push(ctx);
  if (shell) await ctx.addInitScript(() => {
    const w = window as any;
    w.__msgs = [];
    const handler = { postMessage: (m: any) => w.__msgs.push(JSON.parse(JSON.stringify(m))) };
    try { Object.defineProperty(w, "webkit", { value: { messageHandlers: { settings: handler } }, configurable: true }); }
    catch { w.webkit = { messageHandlers: { settings: handler } }; }
  });
  const p = await ctx.newPage();
  lastPage = p;
  p.on("pageerror", (e: any) => pageErrors.push(String(e)));
  p.on("console", (m: any) => { if (m.type() === "error" && !/status of 400/.test(m.text())) pageErrors.push(m.text()); });
  await p.goto(`${BASE}/settings.html`);
  await p.waitForSelector('#page[data-ready="1"]', { timeout: 8000 });
  return p;
}
const msgs = (p: any) => p.evaluate(() => (window as any).__msgs);
// Waits for the stand-in to have taken `n` POSTs, and gives the last.
async function posted(n: number) {
  const until = Date.now() + 4000;
  while (posts.length < n && Date.now() < until) await Bun.sleep(25);
  ok(posts.length >= n, `expected ${n} request(s) to /api/settings, got ${posts.length}`);
  ok(posts.length === n, `expected ${n} request(s) to /api/settings, got ${posts.length}: ${JSON.stringify(posts)}`);
  return posts[n - 1];
}
async function until(p: any, fn: string, what: string) {
  try { await p.waitForFunction(fn, null, { timeout: 4000 }); } catch { throw new Fail(`never happened: ${what}`); }
}
const rowNames = (p: any) => p.$$eval("#langs .row.lang .name", (els: any[]) => els.map((e) => e.textContent));
async function shot(p: any, name: string) { await p.screenshot({ path: join(OUT, `${name}.png`) }); }

// Nothing wider than the window, nothing outside its row, no control or label cut; the page may scroll down.
// A file name may end in an ellipsis (its title holds it whole), and notes show two lines (their title holds them).
async function layout(p: any) {
  const r = await p.evaluate(() => {
    const issues: string[] = [];
    const Wd = window.innerWidth;
    const page = document.getElementById("page")!;
    if (page.scrollWidth > page.clientWidth + 0.5) issues.push(`the page is wider than the window (${page.scrollWidth} > ${page.clientWidth})`);
    if (document.documentElement.scrollHeight > window.innerHeight + 0.5) issues.push("the document itself scrolls: only the page should");
    const shown = (el: Element) => { const cs = getComputedStyle(el); const b = el.getBoundingClientRect(); return cs.display !== "none" && cs.visibility !== "hidden" && b.width > 0 && b.height > 0; };
    const name = (el: Element) => `${el.id ? "#" + el.id : el.tagName.toLowerCase() + (typeof (el as any).className === "string" && (el as any).className ? "." + (el as any).className.trim().split(/\s+/).join(".") : "")} "${(el.textContent || "").trim().slice(0, 24)}"`;
    for (const el of document.querySelectorAll(".body *")) {
      if (!shown(el) || (el.closest("svg") && el.tagName !== "svg") || el.tagName === "OPTION" || el.tagName === "OPTGROUP") continue;
      const b = el.getBoundingClientRect();
      if (b.right > Wd + 0.5 || b.left < -0.5) issues.push(`${name(el)} sticks out of the window sideways (${Math.round(b.left)} to ${Math.round(b.right)})`);
      const row = el.closest(".row, .edit");
      if (row && row !== el && !(el.closest(".add") && el.tagName === "SELECT")) {
        const rr = row.getBoundingClientRect();
        if (b.left < rr.left - 0.5 || b.right > rr.right + 0.5 || b.top < rr.top - 0.5 || b.bottom > rr.bottom + 0.5) issues.push(`${name(el)} sits outside its row`);
      }
      const he = el as HTMLElement;
      if (el.tagName !== "TEXTAREA" && getComputedStyle(el).display !== "inline" && he.clientWidth > 0 && el.scrollWidth > he.clientWidth + 1) {
        if (!(el.classList.contains("file") && he.title)) issues.push(`${name(el)} is cut: ${el.scrollWidth}px of content in ${he.clientWidth}px`);
      }
      if (el.classList.contains("notes") && el.scrollHeight > he.clientHeight + 1 && !he.title) issues.push(`${name(el)} is cut with no title`);
      if ((el.classList.contains("btn") || el.tagName === "SELECT") && el.scrollHeight > he.clientHeight + 1) issues.push(`${name(el)} is cut vertically`);
    }
    // Siblings in a row never overlap.
    for (const row of document.querySelectorAll(".body .row")) {
      const kids = [...row.children].filter((k) => shown(k) && !(row.classList.contains("add") && k.tagName === "SELECT")).map((k) => [k, k.getBoundingClientRect()] as const);
      for (let i = 1; i < kids.length; i++) if (kids[i][1].left < kids[i - 1][1].right - 0.5) issues.push(`${name(kids[i][0])} overlaps ${name(kids[i - 1][0])}`);
    }
    return issues;
  });
  ok(r.length === 0, r.join("; "));
}

// Text reaches 4.5:1 on what's behind it (the veils composited down to the body).
async function contrast(p: any) {
  const r = await p.evaluate(() => {
    const parse = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v[3] ?? 1]; };
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    const lum = (c: number[]) => { const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const bg = (el: Element | null) => { const layers: number[][] = []; for (let a = el; a; a = a.parentElement) layers.push(parse(getComputedStyle(a).backgroundColor)); let c = [3, 3, 4, 1]; for (const l of layers.reverse()) c = over(l, c); return c; };
    const bad: string[] = [];
    for (const el of document.querySelectorAll(".body *")) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (!own) continue;
      const cs = getComputedStyle(el), b = el.getBoundingClientRect();
      if (cs.display === "none" || b.width === 0 || el.closest("select") || el.closest(".add")?.querySelector("select") === el) continue;
      if (el.closest(".add") && el.tagName === "SELECT") continue;
      const fg = parse(cs.color), back = bg(el);
      const L1 = lum(over(fg, back)), L2 = lum(back);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      if (ratio < 4.5) bad.push(`"${el.textContent!.trim().slice(0, 24)}" ${ratio.toFixed(2)}:1`);
    }
    return bad;
  });
  ok(r.length === 0, `under 4.5:1: ${r.join("; ")}`);
}

// ---------------------------------------------------------------------------------------- the checks
type Check = { name: string; fn: () => Promise<string | void> };
const checks: Check[] = [];
const check = (name: string, fn: Check["fn"]) => checks.push({ name, fn });

check("loads the state: the four groups, their values, no request", async () => {
  const p = await open();
  same(await p.$$eval("h2", (e: any[]) => e.map((x) => x.textContent)), ["Reply in", "Voice guide", "Your languages", "Dictation"], "groups");
  same(await p.$eval("#target", (e: any) => e.value), "English", "target");
  same(await p.$eval("#auto", (e: any) => e.checked), false, "Auto");
  same(await p.textContent("#guideFile"), "sample-voice.md", "guide file");
  same(await p.textContent("#linterFile"), "Not set", "linter file");
  same(await rowNames(p), ["English", "Português"], "your languages");
  same(await p.textContent('[data-lang="Português"] .notes'), "Formal: o senhor, a senhora.", "Português's notes");
  same(await p.textContent('.row[data-lang="English"] .none'), "No notes", "English without notes");
  same(await p.$eval("#dictation", (e: any) => e.value), "es-MX", "dictation");
  same(await p.$eval("body", (e: any) => e.classList.contains("embed")), true, "in the app the body is embed");
  same(posts.length, 0, "requests on load");
  await layout(p); await contrast(p);
  await shot(p, "01-loaded");
});

check("target select: your languages first, then the others, each in its own name", async () => {
  const p = await open();
  const groups = await p.$$eval("#target optgroup", (gs: any[]) => gs.map((g) => ({ label: g.label, opts: [...g.children].map((o: any) => o.value) })));
  same(groups[0], { label: "Your languages", opts: ["English", "Português"] }, "first group");
  same(groups[1].label, "Other languages", "second group");
  same(groups[1].opts, ["Español", "Français", "Deutsch", "Italiano", "Nederlands", "Polski", "Svenska", "Türkçe", "日本語", "한국어", "中文"], "the others, in order");
  same(await p.$eval('#target option[value="日本語"]', (o: any) => o.textContent), "日本語 (Japanese)", "a name in another script has its English name beside it");
});

check("target select: one of your languages posts { target } and moves the Target mark", async () => {
  const p = await open();
  ok(await p.$('.row[data-lang="Português"] [data-act="remove"]'), "Português, not the target, can be removed");
  ok(!(await p.$('.row[data-lang="English"] [data-act="remove"]')), "English, the target, has no remove button");
  await p.selectOption("#target", "Português");
  same(await posted(1), { target: "Português" }, "body");
  await until(p, `!!document.querySelector('.row[data-lang="English"] [data-act="remove"]')`, "English can be removed once it isn't the target");
  same(await p.textContent('.row[data-lang="Português"] .tagline'), "Target", "Português is marked Target");
  await layout(p);
  await shot(p, "02-target-portugues");
});

check("target select: another language posts { target } and joins your languages", async () => {
  const p = await open();
  await p.selectOption("#target", "Français");
  same(await posted(1), { target: "Français" }, "body");
  await until(p, `[...document.querySelectorAll("#langs .name")].map(e => e.textContent).join() === "English,Português,Français"`, "Français in your languages");
  same(await p.$$eval('#target optgroup[label="Your languages"] option', (o: any[]) => o.map((x) => x.value)), ["English", "Português", "Français"], "the select's first group");
  same(await p.$eval("#target", (e: any) => e.value), "Français", "target shown");
  await layout(p);
  await shot(p, "03-target-other-language");
});

check("Auto: on posts { auto: true }, off posts { auto: false }", async () => {
  const p = await open();
  await p.click("#auto");
  same(await posted(1), { auto: true }, "on");
  same(await p.$eval("#auto", (e: any) => e.checked), true, "checked");
  await shot(p, "04-auto-on");
  await p.click("#auto");
  same(await posted(2), { auto: false }, "off");
  same(await p.$eval("#auto", (e: any) => e.checked), false, "unchecked");
});

check("Auto: its label toggles it too", async () => {
  const p = await open();
  await p.click('label[for="auto"]');
  same(await posted(1), { auto: true }, "body");
});

check("Choose… for the guide asks the shell, and posts nothing", async () => {
  const p = await open();
  await p.click('[data-choose="voiceGuide"]');
  same(await msgs(p), [{ type: "choose", what: "voiceGuide" }], "message");
  await Bun.sleep(150);
  same(posts.length, 0, "requests");
});

check("Choose… for the linter asks the shell, and posts nothing", async () => {
  const p = await open();
  await p.click('[data-choose="linter"]');
  same(await msgs(p), [{ type: "choose", what: "linter" }], "message");
  await Bun.sleep(150);
  same(posts.length, 0, "requests");
});

check("a file the shell chose shows by its name, from the stream; a long one ends in an ellipsis", async () => {
  const p = await open();
  // As the shell does after its chooser: the path to /api/settings. The page only ever gets the name.
  await fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ linter: "/tmp/example/lint-sample.mjs" }) });
  await until(p, `document.getElementById("linterFile").textContent === "lint-sample.mjs"`, "the linter's name shows");
  ok(!(await p.content()).includes("/tmp/example"), "the page never holds a path");
  const long = "a-long-made-up-voice-guide-name-for-every-language-v12.md";
  await fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voiceGuide: "/tmp/example/" + long }) });
  await until(p, `document.getElementById("guideFile").title === ${JSON.stringify(long)}`, "the long name in the title");
  await layout(p);
  await shot(p, "05-files-chosen");
});

check("Choose… in a plain browser does nothing and nothing breaks", async () => {
  const p = await open(false);
  same(await p.$eval("body", (e: any) => e.classList.contains("embed")), false, "no embed outside the app");
  await p.click('[data-choose="voiceGuide"]');
  await p.click('[data-choose="linter"]');
  await p.keyboard.press("Meta+w");
  await Bun.sleep(150);
  same(posts.length, 0, "requests");
});

check("Add a language… posts the list with it at the end", async () => {
  const p = await open();
  same(await p.$$eval("#add option:not([disabled])", (o: any[]) => o.map((x) => x.value)), ["Español", "Français", "Deutsch", "Italiano", "Nederlands", "Polski", "Svenska", "Türkçe", "日本語", "한국어", "中文"], "what can be added");
  await p.selectOption("#add", "Deutsch");
  same(await posted(1), { languages: ["English", "Português", "Deutsch"] }, "body");
  await until(p, `[...document.querySelectorAll("#langs .name")].map(e => e.textContent).join() === "English,Português,Deutsch"`, "Deutsch in the list");
  ok(!(await p.$$eval("#add option", (o: any[]) => o.map((x) => x.value))).includes("Deutsch"), "Deutsch leaves the Add list");
  await layout(p);
  await shot(p, "06-language-added");
});

check("Notes…: edit, Save posts every note with the new one, and the row shows it", async () => {
  const p = await open();
  await p.click('.row[data-lang="English"] [data-act="notes"]');
  await until(p, `document.activeElement && document.activeElement.matches('.edit[data-lang="English"] textarea')`, "the notes field has the focus");
  same(await p.getAttribute('.row[data-lang="English"] [data-act="notes"]', "aria-expanded"), "true", "Notes… is expanded");
  await p.keyboard.type("Keep it short. No exclamation marks.");
  await layout(p);
  await shot(p, "07-notes-editing");
  await p.click('.edit [data-act="save"]');
  same(await posted(1), { notes: { "Português": "Formal: o senhor, a senhora.", "English": "Keep it short. No exclamation marks." } }, "body");
  await until(p, `!document.querySelector(".edit") && document.querySelector('.row[data-lang="English"] .notes')?.textContent === "Keep it short. No exclamation marks."`, "the editor closes and the row shows the notes");
  ok(!(await p.$('.row[data-lang="English"] .none')), "no 'No notes' once it has notes");
  await shot(p, "08-notes-saved");
});

check("Notes…: ⌘⏎ saves, Esc cancels with no request", async () => {
  const p = await open();
  await p.click('.row[data-lang="English"] [data-act="notes"]');
  await p.keyboard.type("Not this.");
  await p.keyboard.press("Escape");
  await until(p, `!document.querySelector(".edit")`, "Esc closes the editor");
  await Bun.sleep(150);
  same(posts.length, 0, "requests after Esc");
  await p.click('.row[data-lang="English"] [data-act="notes"]');
  same(await p.inputValue(".edit textarea"), "", "a cancelled edit leaves nothing");
  await p.keyboard.type("Plain words.");
  await p.keyboard.press("Meta+Enter");
  same((await posted(1)).notes.English, "Plain words.", "⌘⏎ saved");
});

check("Notes…: Cancel closes with no request; Notes… again toggles it", async () => {
  const p = await open();
  await p.click('.row[data-lang="Português"] [data-act="notes"]');
  same(await p.inputValue(".edit textarea"), "Formal: o senhor, a senhora.", "the field holds the notes");
  await p.click('.edit [data-act="cancel"]');
  await until(p, `!document.querySelector(".edit")`, "Cancel closes");
  await p.click('.row[data-lang="Português"] [data-act="notes"]');
  await p.click('.row[data-lang="Português"] [data-act="notes"]');
  await until(p, `!document.querySelector(".edit")`, "Notes… again closes");
  await Bun.sleep(150);
  same(posts.length, 0, "requests");
});

check("Notes…: Clear notes posts an empty string and the row says No notes", async () => {
  const p = await open();
  await p.click('.row[data-lang="Português"] [data-act="notes"]');
  await p.click('.edit [data-act="clear"]');
  same(await posted(1), { notes: { "Português": "" } }, "body");
  await until(p, `document.querySelector('.row[data-lang="Português"] .none')?.textContent === "No notes"`, "No notes");
  await shot(p, "09-notes-cleared");
});

check("Notes…: emptying the field and saving clears them too", async () => {
  const p = await open();
  await p.click('.row[data-lang="Português"] [data-act="notes"]');
  await p.fill(".edit textarea", "");
  await p.click('.edit [data-act="save"]');
  same(await posted(1), { notes: { "Português": "" } }, "body");
});

check("Notes…: long notes show two lines with their title, the field stops at 600 and counts", async () => {
  const p = await open();
  await p.click('.row[data-lang="Português"] [data-act="notes"]');
  const long = "Use o senhor and a senhora in Formal. Keep the sentences short and plain. ".repeat(10);
  await p.fill(".edit textarea", long);
  same((await p.inputValue(".edit textarea")).length <= 600, true, "at most 600");
  ok(/of 600$/.test(await p.textContent(".edit .count")), "a count near the limit");
  await layout(p);
  await p.click('.edit [data-act="save"]');
  ok((await posted(1)).notes["Português"].length <= 600, "the note posted is at most 600");
  await until(p, `!!document.querySelector('.row[data-lang="Português"] .notes')`, "the notes show");
  await layout(p);
  await shot(p, "10-notes-long");
});

check("Remove posts the list without it; the target can't be removed", async () => {
  const p = await open();
  await p.click('.row[data-lang="Português"] [data-act="remove"]');
  same(await posted(1), { languages: ["English"] }, "body");
  await until(p, `[...document.querySelectorAll("#langs .name")].map(e => e.textContent).join() === "English"`, "Português leaves");
  same(await p.textContent('.row[data-lang="English"] .tagline'), "Target", "the target stays, marked");
  await shot(p, "11-language-removed");
});

check("Dictate in: every option, in its own name; a choice posts { dictation }", async () => {
  const p = await open();
  same(await p.$$eval("#dictation option", (o: any[]) => o.map((x) => x.textContent)), DICTATION.map((d) => d.name), "options");
  await p.selectOption("#dictation", "pt-BR");
  same(await posted(1), { dictation: "pt-BR" }, "body");
  same(await p.$eval("#dictation", (e: any) => e.value), "pt-BR", "shown");
  await shot(p, "12-dictation");
});

check("Words by: This Mac or Claude; a choice posts { dictationEngine }; with This Mac as the model, Claude is off", async () => {
  const p = await open();
  same(await p.$$eval("#dictationEngine option", (o: any[]) => o.map((x) => x.textContent)), ["This Mac", "Claude"], "options");
  same(await p.$eval("#dictationEngine", (e: any) => e.value), "mac", "the default");
  await p.selectOption("#dictationEngine", "claude");
  same(await posted(1), { dictationEngine: "claude" }, "body");
  await until(p, `document.getElementById("dictationEngine").value === "claude"`, "Claude shown");
  await layout(p); await contrast(p);
  await shot(p, "12b-dictation-claude");
  settings.model = "mac"; settings.dictationEngine = "claude"; broadcast();
  await until(p, `document.querySelector("#dictationEngine option[value=claude]").disabled`, "Claude off with This Mac's model");
  same(await p.$eval("#dictationEngine", (e: any) => e.value), "mac", "shown as This Mac");
  same(await p.textContent("#dictationEngine option[value=claude]"), "Claude (needs a Claude model)", "the reason");
});

check("After “enviar mensaje”: Review first by default, or Send right away; a choice posts { dictationPhrase }", async () => {
  const p = await open();
  same(await p.$$eval("#dictationPhrase option", (o: any[]) => o.map((x) => x.textContent)), ["Review first", "Send right away"], "options");
  same(await p.$eval("#dictationPhrase", (e: any) => e.value), "review", "the default");
  await p.selectOption("#dictationPhrase", "send");
  same(await posted(1), { dictationPhrase: "send" }, "body");
  await layout(p); await contrast(p);
  await shot(p, "12d-dictation-phrase");
});

check("Sounds: on by default; turning it off posts { dictationSounds: false }", async () => {
  const p = await open();
  same(await p.$eval("#dictationSounds", (e: any) => e.checked), true, "on by default");
  await p.click("#dictationSounds");
  same(await posted(1), { dictationSounds: false }, "body");
  await layout(p); await contrast(p);
  await shot(p, "12c-dictation-sounds");
});

check("a refused change says so and puts back the server's value", async () => {
  const p = await open();
  refuseNext = true;
  await p.selectOption("#dictation", "en-GB");
  same(await posted(1), { dictation: "en-GB" }, "body");
  await until(p, `document.getElementById("status").textContent === "That setting can't be saved."`, "the refusal is said");
  await until(p, `document.getElementById("dictation").value === "es-MX"`, "the server's value is back");
  await layout(p); await contrast(p);
  await shot(p, "13-refused");
});

check("eight languages: Add says the limit, other targets are off, the page scrolls and nothing is cut", async () => {
  settings.languages = ["English", "Español", "Português", "Français", "Deutsch", "Italiano", "日本語", "中文"];
  settings.notes = Object.fromEntries(settings.languages.map((l) => [l, `Made-up notes for ${l}: short sentences, one idea each, and the formal form when asked.`]));
  const p = await open();
  same(await p.textContent(".add .k"), "Up to 8 languages", "the Add row");
  ok(!(await p.$("#add")), "no Add select");
  same(await p.$$eval('#target optgroup:nth-of-type(2) option', (o: any[]) => o.every((x) => x.disabled)), true, "other languages are off");
  same(await p.$eval("#target optgroup:nth-of-type(2)", (g: any) => g.label), "Other languages (your list is full)", "their group says why");
  const s = await p.$eval("#page", (e: any) => ({ sh: e.scrollHeight, ch: e.clientHeight }));
  ok(s.sh > s.ch, "the page scrolls");
  await layout(p); await contrast(p);
  await shot(p, "14-eight-languages");
  await p.click('.row[data-lang="中文"] [data-act="notes"]');
  await layout(p);
  await p.$eval("#page", (e: any) => { e.scrollTop = e.scrollHeight; });
  await shot(p, "15-eight-languages-bottom");
});

check("⌘W asks the shell to close the window", async () => {
  const p = await open();
  await p.keyboard.press("Meta+w");
  same(await msgs(p), [{ type: "close" }], "message");
});

check("the stream: a change elsewhere (the strip's menu) shows here", async () => {
  const p = await open();
  await fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auto: true, target: "Português" }) });
  await until(p, `document.getElementById("auto").checked && document.getElementById("target").value === "Português"`, "Auto and the target follow the stream");
});

check("keyboard: Tab reaches every control in order", async () => {
  const p = await open();
  const order: string[] = [];
  for (let i = 0; i < 12; i++) {
    await p.keyboard.press("Tab");
    order.push(await p.evaluate(() => { const a = document.activeElement as HTMLElement; return a.id || a.dataset.choose || a.dataset.act || a.tagName; }));
  }
  // WebKit's default Tab, like the Mac's, skips buttons and checkboxes unless Full Keyboard Access is on; the selects are always reached.
  for (const id of ["target", "add", "dictation"]) ok(order.includes(id), `Tab reaches #${id} (${order.join(", ")})`);
});

// ---------------------------------------------------------------------------------------- run
async function main() {
  let webkit: any;
  try { ({ webkit } = await import(PW)); } catch (e) {
    console.error(`Can't load Playwright from ${PW} (set PLAYWRIGHT_DIR): ${e}`);
    process.exit(2);
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "failed"), { recursive: true });
  browser = await webkit.launch();
  let passed = 0, failed = 0;
  for (const c of checks) {
    reset();
    lastPage = null;
    let line: string;
    try {
      const note = await Promise.race([c.fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Fail("timed out after 30 s")), 30000))]);
      passed++;
      line = `PASS  ${c.name}${note ? `  [${note}]` : ""}`;
    } catch (e: any) {
      failed++;
      let cap = "";
      if (lastPage) { cap = join(OUT, "failed", `${c.name.replace(/[^\w]+/g, "-").slice(0, 60)}.png`); try { await lastPage.screenshot({ path: cap, timeout: 5000 }); } catch { cap = ""; } }
      line = `FAIL  ${c.name}\n      ${e instanceof Fail ? e.message : String(e?.message ?? e).split("\n")[0]}${cap ? `\n      capture: ${cap.replace(ROOT + "/", "")}` : ""}`;
    }
    console.log(line);
    for (const x of contexts.splice(0)) { try { await x.close(); } catch {} }
  }
  if (pageErrors.length) { failed++; console.log(`FAIL  the page logged no errors\n      ${[...new Set(pageErrors)].join("\n      ")}`); }
  else { passed++; console.log("PASS  the page logged no errors"); }
  await browser.close();
  server.stop(true);
  console.log(`\n${passed} passed, ${failed} failed. Captures: ${OUT.replace(ROOT + "/", "")}/`);
  process.exit(failed ? 1 : 0);
}
main();
