// Presses every control of the strip's page in WebKit and checks what it does, then checks the layout
// of the states that matter. One line per control: PASS or FAIL with the reason. Exit 1 on any failure.
//
//   bun test/page-check.ts
//
// It needs the page mock already running (bun test/page-mock.ts, on 127.0.0.1:4813, or PAGE_MOCK=<its address>
// with the mock on STRIP_MOCK_PORT) and Playwright with WebKit. Playwright is read from PLAYWRIGHT_DIR, or from the sibling folder mac-app-design/node_modules.
// The window is a typical strip, 1200 x 145 (the strip is 145 tall and as wide as Teams), dark, device scale 2, in a browser (no shell), so the
// page uses its stand-in bridge: nothing is ever sent. Made-up text only.
//
// Then the column pass: the same controls pressed again in the strip's second shape, a window taller than wide
// (360 x 900), with its layout checked, and checks and frames only the column has.
//
// Captures go to .local/page-check/ (kept out of git). The eight frames are saved by their state name:
//   01-idle  02-ready-long  03-adjust-open  04-menu-open  05-send-error-long-chat  06-first-run  07-dictation-preparing  08-written-for
//   09-auto-portuguese  10-menu-narrow
// and this Mac's Translation (0.9.0), each at a typical strip's size (1200 x 145) and narrow (640 x 145):
//   11-menu-mac  12-mac-reply  13-fallback  14-error-mac  15-error-language   (named <frame>-1200 and <frame>-640)
// and the six quick fixes (0.10.0), at the same two sizes:
//   16-menu-settings  17-fallback-retry  18-unconfirmed  19-idle-placeholder   (named <frame>-1200 and <frame>-640)
// and the recent messages and the update checks (0.12.0), at the same two sizes:
//   20-menu-recent  21-restored  22-teams-changed  23-claude-changed   (named <frame>-1200 and <frame>-640)
// and the mic as Session Monitor's (0.13.0), at the same two sizes:
//   24-mic-idle  25-listening  26-armed  27-mic-silent  28-claude-checking   (named <frame>-1200 and <frame>-640)
// and the column's seven (360 x 900, dark, scale 2; no dictation frame: its label is the strip's):
//   v01-idle  v02-ready  v03-sent  v04-send-error-long-chat  v05-adjust-open  v06-menu-open  v07-first-run  v08-menu-mac
// A control that fails saves its capture in .local/page-check/failed/. The folder is emptied at each run.
import { join, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, ".local", "page-check");
const BASE = process.env.PAGE_MOCK ?? "http://127.0.0.1:4813";
const PW = process.env.PLAYWRIGHT_DIR ?? resolve(ROOT, "..", "mac-app-design", "node_modules", "playwright");

// The window: the strip under Teams (1200 x 145) or the column beside it (360 x 900). The column pass sets it for its checks.
let W = 1200, H = 145;
const ROW = { w: 1200, h: 145 }, COL = { w: 360, h: 900 }, NARROW = { w: 640, h: 145 }; // NARROW: under a narrow Teams window
const ES = "¿Puedes revisar el presupuesto antes del jueves? Si hace falta, lo vemos en la llamada.";
const EN_NORMAL = "Could you take a look at the budget before Thursday?";
const EN_FORMAL = "Would you be able to review the budget before Thursday?";
const LAST = "Could you send me the budget numbers before Thursday?";
const LONG_CHAT = "Castellanos Moreira, Valentina Sofía";
const LONG_EN = "I went through the budget this morning and found two lines that don't add up. Can we go over them together on Thursday's call?";

// ---------------------------------------------------------------------------------------- plumbing
let browser: any;
type T = { p: any; reqs: { path: string; body: any }[]; msgs: () => Promise<any[]> };
const contexts: any[] = [];
let lastPage: any = null;
const pageErrors: string[] = [];

async function open(query = "", wait = true): Promise<T> {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: "dark" });
  contexts.push(ctx);
  const p = await ctx.newPage();
  lastPage = p;
  const reqs: T["reqs"] = [];
  p.on("request", (r: any) => {
    const u = new URL(r.url());
    if (r.method() === "POST" && u.pathname.startsWith("/api/")) {
      let body: any = null;
      try { body = JSON.parse(r.postData() ?? "null"); } catch {}
      reqs.push({ path: u.pathname, body });
    }
  });
  p.on("pageerror", (e: any) => pageErrors.push(String(e)));
  // The 409 and 503 answers are the mock's canned replies for BUSY, OFFLINE, LIMIT, GUIDE and FAILED: expected.
  p.on("console", (m: any) => { if (m.type() === "error" && !/status of (409|503)/.test(m.text())) pageErrors.push(m.text()); });
  await p.goto(`${BASE}/${query ? "?" + query : ""}`);
  if (wait) {
    // srv and st are the page's own top-level bindings (let/const, so not on window): read them by name.
    await p.waitForFunction("(() => { try { return !!srv && st.teams !== null; } catch (e) { return false; } })()", null, { timeout: 8000 });
    // Record what the page tells the shell (the stand-in bridge answers as before).
    await p.evaluate(() => {
      const w = window as any;
      w.__msgs = [];
      const orig = w.standIn;
      w.standIn = (m: any) => { w.__msgs.push(JSON.parse(JSON.stringify(m))); return orig(m); };
    });
  }
  return { p, reqs, msgs: () => p.evaluate(() => (window as any).__msgs) };
}

class Fail extends Error {}
const ok = (c: any, why: string) => { if (!c) throw new Fail(why); };
const eq = (a: any, b: any, what: string) => ok(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const has = (s: string, sub: string, what: string) => ok(String(s).includes(sub), `${what}: expected to contain ${JSON.stringify(sub)}, got ${JSON.stringify(s)}`);

const state = (p: any) => p.evaluate(() => document.getElementById("strip")!.dataset.state);
const waitState = (p: any, s: string, timeout = 8000) =>
  p.waitForFunction((s: string) => document.getElementById("strip")!.dataset.state === s, s, { timeout })
    .catch(async () => { throw new Fail(`state never became "${s}" (it is "${await state(p)}")`); });
const tagText = (p: any) => p.locator("#status").innerText();
const val = (p: any, id: string) => p.inputValue("#" + id);
const vis = (p: any, sel: string) => p.locator(sel).first().isVisible();
const focused = (p: any) => p.evaluate(() => (document.activeElement as HTMLElement)?.id || document.activeElement?.tagName);
const reqsTo = (t: T, path: string) => t.reqs.filter((r) => r.path === path);
const sends = async (t: T) => (await t.msgs()).filter((m) => m.type === "send");
const opens = async (t: T, what: string) => (await t.msgs()).filter((m) => m.type === "open" && m.what === what);
const settle = (p: any, ms = 350) => p.waitForTimeout(ms);
const actionLabels = (p: any) => p.locator("#actions button").allInnerTexts();
const setTeams = (p: any, m: any) => p.evaluate((m: any) => (window as any).strip.teams(m), m);

async function translateFlow(t: T, text = ES) {
  await t.p.click("#es");
  await t.p.fill("#es", text);
  await t.p.press("#es", "Enter");
  await waitState(t.p, "ready");
}

// The mock keeps the settings between pages: put them back to what the page starts with (the mock's
// defaults: English the target, Auto off, English and Português as your languages, dictation in es-MX).
const MOCK_LANGS = ["English", "Português"];
async function resetSettings() {
  const s = await (await fetch(`${BASE}/api/state`)).json();
  const patch: any = {};
  if (s.settings.model !== "sonnet") patch.model = "sonnet";
  if (s.settings.mode !== "send") patch.mode = "send";
  if (s.settings.target !== "English") patch.target = "English";
  if (s.settings.auto !== false) patch.auto = false;
  if (JSON.stringify(s.settings.languages) !== JSON.stringify(MOCK_LANGS)) patch.languages = MOCK_LANGS;
  if (s.settings.dictation !== "es-MX") patch.dictation = "es-MX";
  if (s.settings.dictationEngine !== "mac") patch.dictationEngine = "mac";
  if (s.settings.dictationSounds !== true) patch.dictationSounds = true;
  if (s.settings.dictationPhrase !== "review") patch.dictationPhrase = "review";
  if (Object.keys(patch).length) {
    await fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    await new Promise((r) => setTimeout(r, patch.model ? 1800 : 100));
  }
}
const setMode = (mode: string) => fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
const putSettings = async (patch: any) => {
  const r = await fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (r.status !== 200) throw new Fail(`the mock refused ${JSON.stringify(patch)} (${r.status})`);
};

// ---------------------------------------------------------------------------------------- layout
// Nothing may overflow the 145 px height or the window's width, nothing may sit outside the panel it
// belongs to, no tag or button may be cut or overlap its neighbor. The chat's name may give way
// (an ellipsis): that is the design, and it is reported as a note.
async function layout(p: any): Promise<{ issues: string[]; info: string[] }> {
  return p.evaluate((col: boolean) => {
    const issues: string[] = [], info: string[] = [];
    const Wd = window.innerWidth, Ht = window.innerHeight;
    const de = document.documentElement, bd = document.body;
    const sh = Math.max(de.scrollHeight, bd.scrollHeight), sw = Math.max(de.scrollWidth, bd.scrollWidth);
    if (sh > Ht) issues.push(`the page is taller than the window (${sh} > ${Ht})`);
    if (sw > Wd) issues.push(`the page is wider than the window (${sw} > ${Wd})`);
    const strip = document.getElementById("strip")!;
    const sr = strip.getBoundingClientRect();
    if (Math.abs(sr.height - (col ? Ht : 145)) > 0.5) issues.push(`the strip is ${sr.height}px tall, not ${col ? Ht : 145}`);
    if (Math.abs(sr.width - Wd) > 0.5) issues.push(`the strip is ${sr.width}px wide, not ${Wd}`);
    const shown = (el: Element) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const name = (el: Element) => {
      const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
      const cls = typeof (el as any).className === "string" && (el as any).className.trim() ? "." + (el as any).className.trim().split(/\s+/).join(".") : "";
      return `${el.id ? "#" + el.id : el.tagName.toLowerCase() + cls}${t ? ` "${t}"` : ""}`;
    };
    for (const el of strip.querySelectorAll("*")) {
      if (!shown(el) || el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
      // What shows is the box clipped by every ancestor that clips (the chat's name, cut by its ellipsis, is not "outside").
      const b = el.getBoundingClientRect();
      const r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const o = getComputedStyle(a);
        if (o.overflowX === "visible" && o.overflowY === "visible") continue;
        const ar = a.getBoundingClientRect();
        r.left = Math.max(r.left, ar.left); r.top = Math.max(r.top, ar.top); r.right = Math.min(r.right, ar.right); r.bottom = Math.min(r.bottom, ar.bottom);
      }
      if (r.right <= r.left || r.bottom <= r.top) continue;
      if (r.right > Wd + 0.5 || r.left < -0.5 || r.bottom > Ht + 0.5 || r.top < -0.5)
        issues.push(`${name(el)} sticks out of the window (${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)})`);
      const cs = getComputedStyle(el);
      const tag = el.tagName;
      if (tag !== "TEXTAREA" && tag !== "INPUT" && cs.display !== "inline" && (el as HTMLElement).clientWidth > 0 && el.scrollWidth > (el as HTMLElement).clientWidth + 1) {
        if (el.classList.contains("to")) info.push(`the chat's name is shortened with an ellipsis, to ${(el as HTMLElement).clientWidth}px`);
        else if (el.parentElement?.classList.contains("status")) info.push(`the notice's words end in an ellipsis (${(el as HTMLElement).clientWidth} of ${el.scrollWidth}px; its title holds them whole)`);
        else if (el.classList.contains("who") && (el as HTMLElement).title) info.push(`the sent message's name ends in an ellipsis (its title holds it)`);
        // The menu's Recent row scrolls sideways when its buttons are more than the menu's width, as Reply in does.
        else if (el.id === "recentBtns") info.push(`the Recent row scrolls sideways (${(el as HTMLElement).clientWidth} of ${el.scrollWidth}px)`);
        else if ((el.classList.contains("dw") || el.classList.contains("preview")) && (el.closest("[title]") as HTMLElement | null)?.title)
          info.push(`the ${el.classList.contains("dw") ? "dictation label" : "preview note"} ends in an ellipsis (${(el as HTMLElement).clientWidth} of ${el.scrollWidth}px; its title holds the words)`);
        else issues.push(`${name(el)} is cut: its content is ${el.scrollWidth}px in a ${(el as HTMLElement).clientWidth}px box`);
      }
      if ((el.classList.contains("status") || el.classList.contains("btn")) && el.scrollHeight > (el as HTMLElement).clientHeight + 1)
        issues.push(`${name(el)} is cut vertically (${el.scrollHeight}px in ${(el as HTMLElement).clientHeight}px)`);
    }
    // Both footers sit on one line, at one height, in every state.
    const fs = strip.querySelector(".f.es .foot")!.getBoundingClientRect(), fe = strip.querySelector(".f.en .foot")!.getBoundingClientRect();
    if (!col && (Math.abs(fs.top - fe.top) > 0.5 || Math.abs(fs.height - fe.height) > 0.5))
      issues.push(`the footers don't line up (Spanish y ${fs.top}, ${fs.height} tall; English y ${fe.top}, ${fe.height} tall)`);
    if (col) {
      // The column: the English module on top, the Spanish below, each half the height, both whole inside the window,
      // each footer inside its own module, and the English footer in two rows (the notice and Adjust, then the name, Send and the gear).
      const en = strip.querySelector(".f.en")!.getBoundingClientRect(), es = strip.querySelector(".f.es")!.getBoundingClientRect();
      if (en.bottom > es.top + 0.5) issues.push(`the English module isn't above the Spanish one (English ends at ${en.bottom}, Spanish starts at ${es.top})`);
      if (Math.abs(en.height - es.height) > 1) issues.push(`the modules aren't the same height (English ${en.height}, Spanish ${es.height})`);
      if (Math.abs(en.left - es.left) > 0.5 || Math.abs(en.width - es.width) > 0.5) issues.push("the modules aren't the same width");
      for (const [k, foot, mod] of [["English", fe, en], ["Spanish", fs, es]] as [string, DOMRect, DOMRect][])
        if (foot.left < mod.left - 0.5 || foot.right > mod.right + 0.5 || foot.top < mod.top - 0.5 || foot.bottom > mod.bottom + 0.5) issues.push(`the ${k} footer leaves its module`);
      const r = (sel: string) => { const e = strip.querySelector(sel); return e && shown(e) ? e.getBoundingClientRect() : null; };
      // (the notice row only when it's in the footer: a failed translation's sits in the module's middle)
      const to = r(".to"), send = r("#send"), more = r("#more"), adj = r("#adjustBtn"), tagrow = r(".foot > #tagrow");
      if (send && more && Math.abs(send.top - more.top) > 4) issues.push("Send and the gear aren't on one row");
      if (to && send && Math.abs(to.top + to.height / 2 - (send.top + send.height / 2)) > 1) issues.push("the chat's name isn't on Send's row");
      for (const top of [adj, tagrow]) if (top && send && top.bottom > send.top + 0.5) issues.push("the notice or Adjust isn't above Send's row");
      if (adj && tagrow && Math.abs(adj.top + adj.height / 2 - (tagrow.top + tagrow.height / 2)) > 3) issues.push("the notice and Adjust aren't on one row");
      if (adj && Math.abs(adj.left - fe.left) > 0.5) issues.push("Adjust doesn't open the footer at its left edge");
    }
    // A shortcut glyph is never translucent, itself or through a parent.
    for (const k of strip.querySelectorAll("kbd")) {
      if (!shown(k)) continue;
      let o = 1;
      for (let a: Element | null = k; a && a !== document.body; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity);
      if (o < 0.99) issues.push(`a shortcut glyph "${k.textContent}" is translucent (opacity ${o.toFixed(2)})`);
    }
    // Each control stays in its own panel and doesn't sit on its neighbor.
    const sels = [".tone", ".preview", ".dict-label", ".mic", "#translate", "#status", "#actions .btn", "#adjustBtn", "#more", "#lang", ".to", "#send", ".adjust-row .field", "#chip"];
    const items: Element[] = [];
    for (const s of sels) for (const el of strip.querySelectorAll(s)) if (shown(el)) items.push(el);
    for (const el of items) {
      const f = el.closest(".f");
      if (!f) continue;
      const a = el.getBoundingClientRect(), b = f.getBoundingClientRect();
      if (a.left < b.left - 0.5 || a.right > b.right + 0.5 || a.top < b.top - 0.5 || a.bottom > b.bottom + 0.5)
        issues.push(`${name(el)} leaves its panel`);
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 1 && h > 1) issues.push(`${name(items[i])} overlaps ${name(items[j])}`);
    }
    const menu = document.getElementById("menu")!;
    if (menu.classList.contains("open")) {
      const m = menu.getBoundingClientRect();
      if (m.left < -0.5 || m.right > Wd + 0.5 || m.top < -0.5 || m.bottom > Ht + 0.5)
        issues.push(`the menu sticks out of the window (${Math.round(m.left)},${Math.round(m.top)} to ${Math.round(m.right)},${Math.round(m.bottom)})`);
      const g = document.getElementById("more")!.getBoundingClientRect();
      if (!(m.right <= g.left || m.bottom <= g.top || m.left >= g.right || m.top >= g.bottom)) issues.push("the menu covers the gear");
      for (const e of menu.querySelectorAll("button, .pl")) if (shown(e) && e.scrollWidth > (e as HTMLElement).clientWidth + 1) issues.push(`${name(e)} is cut in the menu`);
      if (col) {
        const en = strip.querySelector(".f.en")!.getBoundingClientRect();
        if (m.left < en.left - 0.5 || m.right > en.right + 0.5 || m.top < en.top - 0.5 || m.bottom > en.bottom + 0.5) issues.push("the menu isn't over the English module");
        const cs = menu.querySelectorAll(".col");
        for (let i = 1; i < cs.length; i++) { const a = cs[i - 1].getBoundingClientRect(), b = cs[i].getBoundingClientRect(); if (b.top < a.bottom - 0.5 || Math.abs(a.left - b.left) > 0.5) issues.push("the menu's groups aren't stacked in one column"); }
        if (menu.scrollHeight > menu.clientHeight + 1) issues.push("the menu's groups are cut");
      }
    }
    return { issues, info: [...new Set(info)] };
  }, W < H);
}
async function expectLayout(p: any) {
  const r = await layout(p);
  ok(!r.issues.length, r.issues.join("; "));
  return r.info;
}

// ---------------------------------------------------------------------------------------- runner
type Check = { group: string; name: string; fn: () => Promise<string | void>; mode: "row" | "col" | "narrow" };
const checks: Check[] = [];
// check(): written for the strip under Teams (1200 x 145); the functional groups run again in the column (below).
// colCheck(): only for the column (360 x 900).
const check = (group: string, name: string, fn: () => Promise<string | void>) => checks.push({ group, name, fn, mode: "row" });
const colCheck = (group: string, name: string, fn: () => Promise<string | void>) => checks.push({ group, name, fn, mode: "col" });
// narrowCheck(): only for a narrow strip (640 x 145). The Layout states run there too (below).
const narrowCheck = (group: string, name: string, fn: () => Promise<string | void>) => checks.push({ group, name, fn, mode: "narrow" });
// The column pass presses the same controls in a 360 x 900 window and checks its layout. The groups that are only
// about the strip's own geometry (Design, Page) and the checks that read its row's shape don't repeat.
const COLUMN_GROUPS = new Set(["Keys", "Normal / Formal", "Mic", "Adjust", "Settings menu", "Send", "Send reasons", "Teams", "First run", "Replies", "Translate button", "Dictation", "Layout", "Language", "This Mac", "Recent", "Update check"]);
const ROW_ONLY: RegExp[] = [/its two columns/, /^the settings are four labeled rows/, /^a long message scrolls inside its box/, /^a short strip/];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

// ===================================================================================== typing and keys
check("Keys", "typing fills the Spanish box; Send and Adjust stay off", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.keyboard.type("Hola, necesito el reporte");
  eq(await val(t.p, "es"), "Hola, necesito el reporte", "Spanish box");
  eq(await state(t.p), "idle", "state");
  has(await t.p.locator("#translate").innerText(), "Translate", "Translate button");
  ok(await t.p.locator("#translate").isEnabled(), "Translate should be on once there is text");
  ok(await t.p.locator("#send").isDisabled(), "Send should be disabled before there is English");
  ok(!(await vis(t.p, "#adjustBtn")), "Adjust should be hidden before there is English");
  eq(reqsTo(t, "/api/translate").length, 0, "translate requests while typing");
});
check("Keys", "⏎ translates (request, busy, English, context)", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", ES);
  await t.p.press("#es", "Enter");
  await waitState(t.p, "translating");
  ok(await vis(t.p, ".busy"), "the busy line should show while translating");
  has(await t.p.locator("#busyText").innerText(), "Translating", "busy text");
  await waitState(t.p, "ready");
  const r = reqsTo(t, "/api/translate");
  eq(r.length, 1, "translate requests");
  eq(r[0].body.text, ES, "request text");
  eq(r[0].body.register, "normal", "request register");
  eq(r[0].body.context?.chat, "Priya Raman", "request context chat");
  eq(r[0].body.context?.last, LAST, "request context last message");
  has(await val(t.p, "en"), EN_NORMAL, "English");
  eq(await val(t.p, "es"), ES, "Spanish stays");
  ok(await t.p.locator("#send").isEnabled(), "Send should be enabled");
  ok(await vis(t.p, "#adjustBtn"), "Adjust should show");
  eq(await tagText(t.p), "", "tag when nothing needs you");
});
check("Keys", "⏎ on an empty or blank box does nothing", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.press("#es", "Enter");
  await t.p.fill("#es", "   ");
  await t.p.press("#es", "Enter");
  await settle(t.p, 200);
  eq(reqsTo(t, "/api/translate").length, 0, "translate requests");
  eq(await state(t.p), "idle", "state");
});
check("Keys", "⇧⏎ adds a line and doesn't translate", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.keyboard.type("uno");
  await t.p.keyboard.press("Shift+Enter");
  await t.p.keyboard.type("dos");
  eq(await val(t.p, "es"), "uno\ndos", "Spanish box");
  await settle(t.p, 200);
  eq(reqsTo(t, "/api/translate").length, 0, "translate requests");
  eq(await state(t.p), "idle", "state");
});
check("Keys", "⌥⏎ adds a line too and doesn't translate", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.keyboard.type("uno");
  await t.p.keyboard.press("Alt+Enter");
  await t.p.keyboard.type("dos");
  eq(await val(t.p, "es"), "uno\ndos", "Spanish box");
  await settle(t.p, 200);
  eq(reqsTo(t, "/api/translate").length, 0, "translate requests");
  eq(await state(t.p), "idle", "state");
});
check("Keys", "Esc clears everything and returns to the Spanish box", async () => {
  const t = await open();
  await translateFlow(t);
  await t.p.keyboard.press("Escape");
  eq(await val(t.p, "es"), "", "Spanish box");
  eq(await val(t.p, "en"), "", "English box");
  eq(await state(t.p), "idle", "state");
  eq(await focused(t.p), "es", "focus");
});
check("Keys", "Esc while translating drops the answer", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", ES);
  await t.p.press("#es", "Enter");
  await waitState(t.p, "translating");
  await t.p.keyboard.press("Escape");
  await t.p.waitForTimeout(1200);
  eq(await state(t.p), "idle", "state after the late answer");
  eq(await val(t.p, "en"), "", "English box");
});
check("Keys", "editing the Spanish after a translation marks it out of date, and undoing the edit brings it back", async () => {
  const t = await open();
  await translateFlow(t);
  await t.p.click("#es");
  await t.p.keyboard.press("End");
  await t.p.keyboard.type("!");
  eq(await state(t.p), "stale", "state");
  eq(await tagText(t.p), "Translation out of date", "tag");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off while out of date");
  ok(await t.p.locator("#translate").isEnabled(), "Translate should be on while the translation is out of date");
  await t.p.keyboard.press("Backspace");
  eq(await state(t.p), "ready", "state after removing the edit");
  ok(await t.p.locator("#send").isEnabled(), "Send should be back");
  await t.p.keyboard.type("!");
  await t.p.keyboard.press("Enter");
  await waitState(t.p, "ready");
  eq(reqsTo(t, "/api/translate").length, 2, "translate requests");
});
check("Keys", "editing the English by hand keeps Send on", async () => {
  const t = await open();
  await translateFlow(t);
  await t.p.fill("#en", "Could you check the budget by Thursday?");
  eq(await state(t.p), "ready", "state");
  ok(await t.p.locator("#send").isEnabled(), "Send should stay on");
});

// ===================================================================================== Normal / Formal
check("Normal / Formal", "Normal is on at the start; Formal switches it with no request on an empty box", async () => {
  const t = await open();
  eq(await t.p.locator("#tone [data-register=normal]").getAttribute("aria-pressed"), "true", "Normal pressed");
  eq(await t.p.locator("#tone [data-register=formal]").getAttribute("aria-pressed"), "false", "Formal pressed");
  await t.p.click("#tone [data-register=formal]");
  eq(await t.p.locator("#tone [data-register=formal]").getAttribute("aria-pressed"), "true", "Formal pressed after click");
  eq(await t.p.locator("#tone [data-register=normal]").getAttribute("aria-pressed"), "false", "Normal pressed after click");
  await settle(t.p, 200);
  eq(t.reqs.length, 0, "requests");
});
check("Normal / Formal", "Formal then Normal after a translation: the page asks again in the new register", async () => {
  const t = await open();
  await translateFlow(t);
  await t.p.click("#tone [data-register=formal]");
  await waitState(t.p, "translating");
  await waitState(t.p, "ready");
  has(await val(t.p, "en"), EN_FORMAL, "formal English");
  await t.p.click("#tone [data-register=normal]");
  await waitState(t.p, "translating");
  await waitState(t.p, "ready");
  has(await val(t.p, "en"), EN_NORMAL, "normal English");
  const r = reqsTo(t, "/api/translate");
  eq(r.map((x) => x.body.register).join(","), "normal,formal,normal", "registers asked");
  return "the brief expected 'out of date'; the page re-translates at once instead (setRegister)";
});
check("Normal / Formal", "Formal while translating drops the first answer", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", ES);
  await t.p.press("#es", "Enter");
  await waitState(t.p, "translating");
  await t.p.click("#tone [data-register=formal]");
  await waitState(t.p, "ready");
  has(await val(t.p, "en"), EN_FORMAL, "English");
  eq(reqsTo(t, "/api/translate").map((x) => x.body.register).join(","), "normal,formal", "registers asked");
});

// ===================================================================================== mic
check("Mic", "the mic is Session Monitor's chip: 24 x 22, a fill that shows it can be pressed, lit white while listening", async () => {
  const t = await open();
  const look = () => t.p.evaluate(() => { const m = document.getElementById("mic")!, r = m.getBoundingClientRect(), cs = getComputedStyle(m), i = m.querySelector("svg")!.getBoundingClientRect();
    return { w: r.width, h: r.height, radius: cs.borderRadius, bg: cs.backgroundColor, color: cs.color, icon: i.width }; });
  const off = await look();
  eq(`${off.w}x${off.h}`, "24x22", "size");
  eq(off.radius, "6px", "corners (the design system's element radius)");
  eq(off.bg, "rgba(255, 255, 255, 0.15)", "fill at rest");
  eq(off.icon, 14, "icon size");
  await t.p.click("#mic");
  await settle(t.p, 250);
  const on = await look();
  eq(on.bg, "rgb(247, 248, 248)", "fill while listening");
  eq(on.color, "rgb(13, 14, 16)", "icon while listening");
  await t.p.click("#mic");
});
check("Mic", "mic button dictates into the box (listening label with five bars that follow the voice, full text, back to off)", async () => {
  const t = await open();
  await t.p.click("#mic");
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "true", "mic pressed");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Listening"), null, { timeout: 3000 })
    .catch(() => { throw new Fail("no 'Listening' label"); });
  eq(await t.p.locator("#dictLabel .wave i").count(), 5, "bars beside Listening");
  has(await t.p.locator("#dictLabel").innerText(), "End with “enviar mensaje” to translate", "the closing phrase's hint");
  await t.p.waitForFunction(() => [...document.querySelectorAll("#dictLabel .wave i")].some((b) => Number((b as HTMLElement).style.getPropertyValue("--h")) > 0.3), null, { timeout: 2000 })
    .catch(() => { throw new Fail("the bars never rose with the level"); });
  ok((await t.msgs()).some((m) => m.type === "dictation" && m.action === "start"), "the shell was not told to start");
  await t.p.waitForFunction((s: string) => (document.getElementById("es") as HTMLTextAreaElement).value === s, ES, { timeout: 6000 })
    .catch(async () => { throw new Fail(`the field ended as ${JSON.stringify(await val(t.p, "es"))}`); });
  await t.p.waitForFunction(() => document.getElementById("mic")!.getAttribute("aria-pressed") === "false", null, { timeout: 3000 })
    .catch(() => { throw new Fail("the mic stayed on after the final text"); });
  eq(await t.p.locator("#dictLabel").innerText(), "", "label at the end");
});
check("Mic", "⌘D starts dictation", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.keyboard.press("Meta+d");
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "true", "mic pressed");
  await t.p.waitForFunction(() => (document.getElementById("es") as HTMLTextAreaElement).value.length > 5, null, { timeout: 3000 })
    .catch(() => { throw new Fail("no text came in"); });
});
check("Mic", "pressing the mic again stops it and keeps what was said", async () => {
  const t = await open();
  await t.p.click("#mic");
  await t.p.waitForFunction(() => (document.getElementById("es") as HTMLTextAreaElement).value.length > 5, null, { timeout: 3000 });
  await t.p.click("#mic");
  await settle(t.p, 300);
  ok((await t.msgs()).some((m) => m.type === "dictation" && m.action === "stop"), "the shell was not told to stop");
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "false", "mic pressed");
  const v = await val(t.p, "es");
  ok(v.length > 5 && ES.startsWith(v), `kept text should be the start of the sentence, got ${JSON.stringify(v)}`);
  await settle(t.p, 500);
  eq(await val(t.p, "es"), v, "text after waiting");
});
check("Mic", "⏎ while dictating stops it and translates what was said", async () => {
  const t = await open();
  await t.p.click("#mic");
  await t.p.waitForFunction(() => (document.getElementById("es") as HTMLTextAreaElement).value.length > 10, null, { timeout: 3000 });
  await t.p.press("#es", "Enter");
  await waitState(t.p, "ready", 10000);
  const r = reqsTo(t, "/api/translate");
  eq(r.length, 1, "translate requests");
  ok(r[0].body.text.length > 5 && ES.startsWith(r[0].body.text), `request text ${JSON.stringify(r[0].body.text)}`);
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "false", "mic pressed");
});
check("Mic", "dictation adds after text already in the box", async () => {
  const t = await open();
  await t.p.fill("#es", "Antes:");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => (document.getElementById("es") as HTMLTextAreaElement).value.length > 12, null, { timeout: 3000 });
  ok((await val(t.p, "es")).startsWith("Antes: "), `box is ${JSON.stringify(await val(t.p, "es"))}`);
  await t.p.click("#mic");
});
check("Mic", "?mic=denied shows 'Microphone not allowed' and Open Settings; the mic starts nothing", async () => {
  const t = await open("mic=denied");
  has(await t.p.locator("#dictLabel").innerText(), "Microphone not allowed", "label");
  ok(await vis(t.p, "#dictLabel [data-act=mic-settings]"), "Open Settings should show");
  await t.p.click("#mic");
  await t.p.keyboard.press("Meta+d");
  await settle(t.p, 300);
  ok(!(await t.msgs()).some((m) => m.type === "dictation"), "the page asked the shell to dictate anyway");
  eq(await val(t.p, "es"), "", "Spanish box");
  await t.p.click("#dictLabel [data-act=mic-settings]");
  eq((await opens(t, "microphone")).length, 1, "open microphone messages");
});

check("Mic", "ending with “enviar mensaje” and a pause stops the mic, leaves the phrase out and translates; the English waits", async () => {
  const t = await open("dict=phrase");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Translating… Keep talking"), null, { timeout: 5000 })
    .catch(async () => { throw new Fail(`never armed; label ${JSON.stringify(await t.p.locator("#dictLabel").innerText())}`); });
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "true", "still listening while armed");
  await waitState(t.p, "ready", 10000);
  const r = reqsTo(t, "/api/translate");
  eq(r.length, 1, "translate requests");
  eq(r[0].body.text, ES, "what was translated (without the phrase)");
  eq(await val(t.p, "es"), ES, "the Spanish box");
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "false", "mic after");
  eq((await t.msgs()).filter((m) => m.type === "send").length, 0, "sends to Teams");
});
check("Mic", "Words by Claude: when the mic stops, 'Claude is checking what you said…', then the misheard words are fixed in the box", async () => {
  try {
  await putSettings({ dictationEngine: "claude" });
  const t = await open("dict=misheard");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Claude is checking what you said"), null, { timeout: 6000 })
    .catch(async () => { throw new Fail(`never checked; label ${JSON.stringify(await t.p.locator("#dictLabel").innerText())}`); });
  has(await val(t.p, "es"), "pre su puesto", "what this Mac heard, while Claude checks");
  ok(await t.p.locator("#translate").isDisabled(), "Translate should wait for the check");
  await t.p.waitForFunction((s: string) => (document.getElementById("es") as HTMLTextAreaElement).value === s, ES, { timeout: 4000 })
    .catch(async () => { throw new Fail(`the box ended as ${JSON.stringify(await val(t.p, "es"))}`); });
  eq(reqsTo(t, "/api/fix").length, 1, "fix requests");
  eq(JSON.stringify(reqsTo(t, "/api/fix")[0].body), JSON.stringify({ text: ES.replace("presupuesto", "pre su puesto"), locale: "es-MX" }), "what went to Claude");
  eq(await t.p.locator("#dictLabel").innerText(), "", "label at the end");
  } finally { await resetSettings(); }
});
check("Mic", "Words by Claude: ⏎ while dictating stops, Claude fixes the words, then it translates the fixed ones", async () => {
  try {
  await putSettings({ dictationEngine: "claude" });
  const t = await open("dict=misheard");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => (document.getElementById("es") as HTMLTextAreaElement).value.includes("pre su puesto"), null, { timeout: 4000 });
  await t.p.press("#es", "Enter");
  await waitState(t.p, "ready", 10000);
  eq(reqsTo(t, "/api/fix").length, 1, "fix requests");
  const r = reqsTo(t, "/api/translate");
  eq(r.length, 1, "translate requests");
  ok(!r[0].body.text.includes("pre su puesto") && r[0].body.text.includes("presupuesto"), `translated ${JSON.stringify(r[0].body.text)}`);
  } finally { await resetSettings(); }
});
check("Mic", "Words by This Mac (the default): nothing goes to Claude after dictating", async () => {
  const t = await open("dict=misheard");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("mic")!.getAttribute("aria-pressed") === "false", null, { timeout: 6000 });
  await settle(t.p, 700);
  eq(reqsTo(t, "/api/fix").length, 0, "fix requests");
  has(await val(t.p, "es"), "pre su puesto", "the box keeps what this Mac heard");
});
check("Mic", "After the phrase: Send right away translates, then sends to the open chat as ⌘⏎ does", async () => {
  try {
  await putSettings({ dictationPhrase: "send" });
  const t = await open("dict=phrase");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Sending… Keep talking"), null, { timeout: 5000 })
    .catch(async () => { throw new Fail(`never armed to send; label ${JSON.stringify(await t.p.locator("#dictLabel").innerText())}`); });
  await t.p.waitForFunction(() => document.getElementById("strip")!.dataset.state === "sent", null, { timeout: 10000 })
    .catch(async () => { throw new Fail(`never sent; state ${await t.p.evaluate(() => document.getElementById("strip")!.dataset.state)}`); });
  eq(reqsTo(t, "/api/translate").length, 1, "translate requests");
  eq((await sends(t)).length, 1, "sends");
  ok(String((await sends(t))[0].text).startsWith(EN_NORMAL), `what was sent: ${JSON.stringify((await sends(t))[0].text)}`);
  } finally { await resetSettings(); }
});
check("Mic", "Esc while armed drops it: nothing is translated", async () => {
  const t = await open("dict=phrase");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Translating…"), null, { timeout: 5000 });
  await t.p.keyboard.press("Escape");
  await settle(t.p, 1600);
  eq(reqsTo(t, "/api/translate").length, 0, "translate requests");
  eq(await val(t.p, "es"), "", "the Spanish box");
});
check("Mic", "?dict=silent: a microphone with no sound ends listening with a note", async () => {
  const t = await open("dict=silent");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("gives no sound"), null, { timeout: 3000 })
    .catch(() => { throw new Fail("no note about the silent microphone"); });
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "false", "mic after");
});
check("Mic", "the start message carries the settings' sounds choice", async () => {
  const t = await open();
  await t.p.click("#mic");
  eq((await t.msgs()).find((m: any) => m.type === "dictation" && m.action === "start")?.sounds, true, "sounds by default");
  await t.p.click("#mic");
});

// ===================================================================================== Adjust
check("Adjust", "Adjust is hidden before English, and ⌘K does nothing then", async () => {
  const t = await open();
  ok(!(await vis(t.p, "#adjustBtn")), "Adjust visible too early");
  await t.p.click("#es");
  await t.p.keyboard.press("Meta+k");
  eq(await t.p.locator("#strip").getAttribute("data-adjust"), "", "adjust open");
});
check("Adjust", "Adjust button opens the note row with focus", async () => {
  const t = await open();
  await translateFlow(t);
  await t.p.click("#adjustBtn");
  eq(await t.p.locator("#strip").getAttribute("data-adjust"), "open", "adjust open");
  ok(await vis(t.p, "#adjIn"), "note field visible");
  eq(await focused(t.p), "adjIn", "focus");
  ok(await vis(t.p, "#chip"), "Shorter chip visible");
  eq(await t.p.locator("#chip").innerText(), "Shorter", "chip label");
  ok(!(await vis(t.p, "#tagrow")), "tag row should give way to the note row");
});
check("Adjust", "⌘K opens it", async () => {
  const t = await open();
  await translateFlow(t);
  await t.p.keyboard.press("Meta+k");
  eq(await t.p.locator("#strip").getAttribute("data-adjust"), "open", "adjust open");
  eq(await focused(t.p), "adjIn", "focus");
});
check("Adjust", "note + ⏎ adjusts (request, Adjusting…, new English, Adjusted tag, Undo)", async () => {
  const t = await open();
  await translateFlow(t);
  const before = await val(t.p, "en");
  await t.p.keyboard.press("Meta+k");
  await t.p.fill("#adjIn", "más formal");
  await t.p.press("#adjIn", "Enter");
  await waitState(t.p, "adjusting");
  eq(await tagText(t.p), "Adjusting…", "tag while adjusting");
  await waitState(t.p, "ready");
  const r = reqsTo(t, "/api/adjust");
  eq(r.length, 1, "adjust requests");
  eq(r[0].body.note, "más formal", "note");
  eq(r[0].body.text, ES, "text");
  eq(r[0].body.current, before, "the current text sent");
  eq(r[0].body.language, "English", "the current text's language sent");
  ok(!("english" in r[0].body), "the old field 'english' is gone");
  has(await val(t.p, "en"), "(adjusted)", "English");
  eq(await t.p.locator("#strip").getAttribute("data-adjust"), "", "adjust still open");
  eq(await tagText(t.p), "Adjusted", "tag");
  eq(await actionLabels(t.p).then((a: string[]) => a.join(",")), "Undo", "buttons");
  eq(await focused(t.p), "es", "focus");
});
check("Adjust", "an empty note + ⏎ does nothing and keeps the row open", async () => {
  const t = await open();
  await translateFlow(t);
  await t.p.keyboard.press("Meta+k");
  await t.p.press("#adjIn", "Enter");
  await settle(t.p, 250);
  eq(reqsTo(t, "/api/adjust").length, 0, "adjust requests");
  eq(await t.p.locator("#strip").getAttribute("data-adjust"), "open", "adjust open");
});
check("Adjust", "Shorter chip adjusts with 'más corto'", async () => {
  const t = await open();
  await translateFlow(t);
  await t.p.keyboard.press("Meta+k");
  await t.p.click("#chip");
  await waitState(t.p, "ready");
  const r = reqsTo(t, "/api/adjust");
  eq(r.length, 1, "adjust requests");
  eq(r[0].body.note, "más corto", "note");
  has(await val(t.p, "en"), "Can you check the budget", "English");
  eq(await tagText(t.p), "Adjusted", "tag");
});
check("Adjust", "Undo brings the English back and drops the Adjusted tag", async () => {
  const t = await open();
  await translateFlow(t);
  const before = await val(t.p, "en");
  await t.p.keyboard.press("Meta+k");
  await t.p.click("#chip");
  await waitState(t.p, "ready");
  await t.p.click("#actions [data-act=undo]");
  eq(await val(t.p, "en"), before, "English after Undo");
  eq(await tagText(t.p), "", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await focused(t.p), "es", "focus");
});
check("Adjust", "Esc closes the note row only; the next Esc clears", async () => {
  const t = await open();
  await translateFlow(t);
  await t.p.keyboard.press("Meta+k");
  await t.p.keyboard.press("Escape");
  eq(await t.p.locator("#strip").getAttribute("data-adjust"), "", "adjust open");
  eq(await focused(t.p), "es", "focus");
  ok((await val(t.p, "en")).length > 0, "English was cleared by the first Esc");
  eq(await state(t.p), "ready", "state");
  await t.p.keyboard.press("Escape");
  eq(await state(t.p), "idle", "state after the second Esc");
});
check("Adjust", "an adjust that fails keeps the English, says so, and Try again asks again", async () => {
  const t = await open();
  await translateFlow(t);
  const before = await val(t.p, "en");
  await t.p.keyboard.press("Meta+k");
  await t.p.fill("#adjIn", "OFFLINE");
  await t.p.press("#adjIn", "Enter");
  await waitState(t.p, "error");   // a notice of kind error gives the red box; the English stays
  await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("reach"), null, { timeout: 3000 });
  eq(await tagText(t.p), "Can't reach Claude", "tag");
  eq(await val(t.p, "en"), before, "English kept");
  eq((await actionLabels(t.p)).join(","), "Try again", "buttons");
  await t.p.click("#actions [data-act=retry-adjust]");
  await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("reach"), null, { timeout: 4000 });
  const r = reqsTo(t, "/api/adjust");
  eq(r.length, 2, "adjust requests");
  eq(r[1].body.note, "OFFLINE", "second note");
});
check("Adjust", "an adjust that asks a question shows it as a tag over the kept English", async () => {
  const t = await open();
  await translateFlow(t);
  const before = await val(t.p, "en");
  await t.p.keyboard.press("Meta+k");
  await t.p.fill("#adjIn", "UNCLEAR");
  await t.p.press("#adjIn", "Enter");
  await waitState(t.p, "ready");
  await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("Thursday"), null, { timeout: 3000 });
  eq(await tagText(t.p), "This Thursday or next week's?", "tag");
  has(await t.p.locator("#status").getAttribute("class") ?? "", "s-asks", "tag kind");
  eq(await val(t.p, "en"), before, "English kept");
});

// ===================================================================================== Settings menu
check("Settings menu", "the button opens the menu with its two columns; outside click and Esc close it", async () => {
  const t = await open();
  eq(await t.p.locator("#more").getAttribute("aria-expanded"), "false", "aria-expanded before");
  await t.p.click("#more");
  ok(await vis(t.p, "#menu"), "menu visible");
  eq(await t.p.locator("#more").getAttribute("aria-expanded"), "true", "aria-expanded");
  eq(await t.p.locator("#menu button").count(), 17, "menu items (2 + 4 + Auto and 2 languages + 5 + 3 commands)");
  await t.p.click("#es", { position: { x: 100, y: 20 } });
  ok(!(await vis(t.p, "#menu")), "outside click should close the menu");
  await t.p.fill("#es", "texto");
  await t.p.click("#more");
  await t.p.keyboard.press("Escape");
  ok(!(await vis(t.p, "#menu")), "Esc should close the menu");
  eq(await val(t.p, "es"), "texto", "Esc must not clear the text when it only closes the menu");
  await t.p.click("#more");
  await t.p.click("#more");
  ok(!(await vis(t.p, "#menu")), "a second click on the button should close it");
});
check("Settings menu", "the settings are four labeled rows in a 2 × 2 grid (On ⌘⏎ and Model, then Reply in and Position) with no title row above them; every command and each row's chosen option are in primary text, the options not chosen in secondary text; the gear is the footer's last control, 28 × 28", async () => {
  const t = await open();
  await ready(t);
  await t.p.click("#more");
  // (Recent, the fifth row, is there only with recent messages: see "Recent" below.)
  eq((await t.p.locator("#menu .prow:not(.recentrow) .pl").allInnerTexts()).join(", "), "On ⌘⏎, Model, Reply in, Position", "the rows' labels");
  ok(!(await vis(t.p, "#recentRow")), "no Recent row with no recent messages");
  const g = await t.p.evaluate(() => [...document.querySelectorAll("#menu .prow:not(.recentrow)")].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; }));
  ok(g[0][1] === g[1][1] && g[2][1] === g[3][1] && g[2][1] > g[0][1], `two rows of two: ${JSON.stringify(g)}`);
  ok(g[0][0] === g[2][0] && g[1][0] === g[3][0] && g[1][0] > g[0][0], `two columns: ${JSON.stringify(g)}`);
  eq(await t.p.locator("#menu .mh").count(), 0, "title rows");
  const tops = await t.p.evaluate(() => [document.querySelector("#menu .prow")!, document.querySelector("#menu [data-do]")!].map((e) => Math.round(e.getBoundingClientRect().top)));
  ok(Math.abs(tops[0] - tops[1]) <= 2, `the first row and the first command should start on one line (${tops.join(", ")})`);
  const colors = await t.p.evaluate(() => [...document.querySelectorAll("#menu button")].map((b) => ({ t: (b.textContent || "").trim(), c: getComputedStyle(b).color, off: b.classList.contains("off"), option: !!b.closest(".posrow"), chosen: b.getAttribute("aria-checked") === "true" })));
  const token = (name: string) => t.p.evaluate((n) => { const d = document.createElement("i"); d.style.color = `var(${n})`; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }, name);
  const prim = await token("--color-text-primary"), sec = await token("--color-text-secondary");
  for (const b of colors) {
    const want = b.option && !b.chosen ? sec : prim;
    ok(b.c === want && !b.off, `"${b.t}" should be in ${want === prim ? "primary" : "secondary"} text (${b.c}, off=${b.off}, wanted ${want})`);
  }
  const chosenPerRow = await t.p.evaluate(() => [...document.querySelectorAll("#menu .posrow:not(.recent)")].map((r) => r.querySelectorAll('button[aria-checked="true"]').length));
  ok(chosenPerRow.length === 4 && chosenPerRow.every((n) => n >= 1), `a chosen option in each row (${chosenPerRow.join(", ")})`);
  const r = await t.p.evaluate(() => { const g = (id: string) => document.getElementById(id)!.getBoundingClientRect(); const m = g("more"), s = g("send"), me = g("menu"); return { more: [m.width, m.height, m.left, m.right], sendRight: s.right, sendTop: s.top, menuBottom: me.bottom, W: window.innerWidth }; });
  eq(r.more[0], 28, "gear width"); eq(r.more[1], 28, "gear height");
  ok(r.more[2] >= r.sendRight, "the gear should sit after Send");
  ok(r.more[3] <= r.W - 15, "the gear should be the footer's last control");
  ok(r.sendTop - r.menuBottom >= 5, `the menu should leave a gap above Send (${r.sendTop - r.menuBottom} px)`);
});
check("Settings menu", "Send item: sets mode send (request, check mark)", async () => {
  await setMode("leave");
  const t = await open();
  await t.p.click("#more");
  eq(await t.p.locator("#menu [data-mode=leave]").getAttribute("aria-checked"), "true", "Put in Teams checked at the start");
  await t.p.click("#menu [data-mode=send]");
  await settle(t.p, 300);
  eq(JSON.stringify(reqsTo(t, "/api/settings")[0]?.body), JSON.stringify({ mode: "send" }), "settings request");
  eq(await t.p.locator("#menu [data-mode=send]").getAttribute("aria-checked"), "true", "Send checked");
  eq(await t.p.locator("#menu [data-mode=leave]").getAttribute("aria-checked"), "false", "Put in Teams unchecked");
  eq((await t.p.locator("#send").innerText()).replace(/\s+/g, " "), "Send ⌘⏎", "Send button label");
});
check("Settings menu", "Put in Teams item (its title says 'without sending'): sets mode leave and renames the button", async () => {
  await resetSettings();
  const t = await open();
  await t.p.click("#more");
  await t.p.click("#menu [data-mode=leave]");
  await settle(t.p, 300);
  eq(JSON.stringify(reqsTo(t, "/api/settings")[0]?.body), JSON.stringify({ mode: "leave" }), "settings request");
  eq(await t.p.locator("#menu [data-mode=leave]").getAttribute("aria-checked"), "true", "checked");
  eq(await t.p.locator("#menu [data-mode=leave]").getAttribute("title"), "Put in Teams without sending", "its title");
  eq((await t.p.locator("#send").innerText()).replace(/\s+/g, " "), "Put in Teams ⌘⏎", "Send button label");
  await resetSettings();
});
check("Settings menu", "Model: Mac, Haiku, Sonnet and Opus in one row; Sonnet to start; Haiku, Opus and Mac set the model (request, pressed); Sonnet sets it back", async () => {
  await resetSettings();
  const t = await open();
  await t.p.click("#more");
  eq(await t.p.locator("#menu [data-model=sonnet]").getAttribute("aria-checked"), "true", "Sonnet checked to start");
  await t.p.click("#menu [data-model=haiku]");
  await settle(t.p, 300);
  eq(JSON.stringify(reqsTo(t, "/api/settings")[0]?.body), JSON.stringify({ model: "haiku" }), "settings request");
  eq(await t.p.locator("#menu [data-model=haiku]").getAttribute("aria-checked"), "true", "Haiku checked");
  eq(await t.p.locator("#menu [data-model=sonnet]").getAttribute("aria-checked"), "false", "Sonnet unchecked");
  await t.p.click("#menu [data-model=opus]");
  await settle(t.p, 300);
  eq(JSON.stringify(reqsTo(t, "/api/settings")[1]?.body), JSON.stringify({ model: "opus" }), "second settings request");
  eq(await t.p.locator("#menu [data-model=opus]").getAttribute("aria-checked"), "true", "Opus checked");
  eq(await t.p.locator("#menu [data-model=haiku]").getAttribute("aria-checked"), "false", "Haiku unchecked");
  const tops = await t.p.locator("#menu [data-model]").evaluateAll((bs: any[]) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
  ok(tops.length === 4 && new Set(tops).size === 1, `one row of four: ${tops.join(", ")}`);
  eq((await t.p.locator("#menu [data-model]").allInnerTexts()).join(", "), "Mac, Haiku, Sonnet, Opus", "the models, in order");
  eq(await t.p.locator("#menu [data-model=mac]").getAttribute("title"), "Translates on this Mac, without your voice guide", "Mac's title");
  await t.p.click("#menu [data-model=mac]");
  await settle(t.p, 300);
  eq(JSON.stringify(reqsTo(t, "/api/settings")[2]?.body), JSON.stringify({ model: "mac" }), "Mac's settings request");
  eq(await t.p.locator("#menu [data-model=mac]").getAttribute("aria-checked"), "true", "Mac checked");
  eq(await t.p.locator("#menu [data-model=opus]").getAttribute("aria-checked"), "false", "Opus unchecked");
  await expectLayout(t.p);
  await t.p.click("#menu [data-model=sonnet]");
  await settle(t.p, 300);
  eq(JSON.stringify(reqsTo(t, "/api/settings")[3]?.body), JSON.stringify({ model: "sonnet" }), "fourth settings request");
  eq(await t.p.locator("#menu [data-model=sonnet]").getAttribute("aria-checked"), "true", "Sonnet checked");
  await new Promise((r) => setTimeout(r, 1800));
});
check("Settings menu", "a short strip (110 pt, the least the edge drag allows): the menu opens left of the gear, whole and inside the window, and the gear still closes it", async () => {
  for (const w of [1200, 640]) {
    const t = await open();
    await t.p.setViewportSize({ width: w, height: 110 });
    await settle(t.p, 150);
    await t.p.click("#more");
    const r = await t.p.evaluate(() => {
      const m = document.getElementById("menu")!.getBoundingClientRect(), g = document.getElementById("more")!.getBoundingClientRect();
      const cut = [...document.querySelectorAll("#menu button, #menu .pl, #menu .mh")].filter((e) => e.scrollWidth > (e as HTMLElement).clientWidth + 1).map((e) => e.textContent!.trim());
      return { l: m.left, t: m.top, r: m.right, b: m.bottom, W: innerWidth, H: innerHeight, covers: !(m.right <= g.left || m.bottom <= g.top || m.left >= g.right || m.top >= g.bottom), cut };
    });
    ok(r.l >= 0 && r.t >= 0 && r.r <= r.W && r.b <= r.H, `${w} wide: the menu leaves the window (${Math.round(r.l)},${Math.round(r.t)} to ${Math.round(r.r)},${Math.round(r.b)})`);
    ok(!r.covers, `${w} wide: the menu covers the gear`);
    eq(r.cut.length, 0, `${w} wide: cut in the menu: ${r.cut.join(", ")}`);
    await t.p.click("#more");
    ok(!(await vis(t.p, "#menu")), `${w} wide: the gear should close the menu`);
  }
});
check("Settings menu", "Open voice guide: tells the shell and closes the menu", async () => {
  const t = await open();
  await t.p.click("#more");
  await t.p.click("#menu [data-do=guide]");
  eq((await opens(t, "guide")).length, 1, "open guide messages");
  ok(!(await vis(t.p, "#menu")), "menu should close");
});
check("Settings menu", "Restart translator: posts the restart and closes the menu", async () => {
  const t = await open();
  await t.p.click("#more");
  await t.p.click("#menu [data-do=restart]");
  await settle(t.p, 200);
  eq(reqsTo(t, "/api/translator/restart").length, 1, "restart requests");
  ok(!(await vis(t.p, "#menu")), "menu should close");
  await new Promise((r) => setTimeout(r, 1800));
});


// ===================================================================================== the language (0.8.0)
// The mock writes in the target, or with Auto on in the stand-in chat's language when it's clear: ?chat=pt gives a
// Portuguese last message, ?chat=new a chat with none. Every check here puts the settings back (the runner does too).
const PT_NORMAL = "Você consegue dar uma olhada no orçamento antes de quinta?";
const langOf = (p: any) => p.evaluate(() => {
  const b = document.getElementById("lang")!;
  const shown = !b.hidden && getComputedStyle(b).display !== "none";
  return { shown, text: (b.textContent || "").replace(/\s+/g, " ").trim(), visibleText: (b as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
    title: b.title, disabled: b.getAttribute("aria-disabled"), auto: !(b.querySelector(".auto") as HTMLElement).hidden, lang: document.getElementById("langName")!.lang };
});
check("Language", "Auto off: the button before 'To' names the target, 'English', titled 'Your target language.'; a click asks nothing", async () => {
  const t = await open();
  ok(!(await langOf(t.p)).shown, "no language button before a translation");
  await ready(t);
  const l = await langOf(t.p);
  ok(l.shown, "the language button should show");
  eq(l.visibleText, "English", "its words");
  ok(!l.auto, "no 'Auto ·' with Auto off");
  eq(l.title, "Your target language.", "its title");
  eq(l.disabled, "true", "a click has nothing to switch");
  const order = await t.p.evaluate(() => [...document.querySelector(".f.en .foot")!.children].map((c) => c.id || c.className.split(" ")[0]).join(","));
  has(order, "lang,to,send,more", "the footer's order");
  await t.p.click("#lang", { force: true });   // aria-disabled: Playwright would wait for it to turn on
  await settle(t.p, 250);
  eq(reqsTo(t, "/api/translate").length, 1, "translate requests after the click");
  eq(await state(t.p), "ready", "state");
  await expectLayout(t.p);
});
check("Language", "Auto on, the chat in Portuguese (?chat=pt): 'Auto · Português' titled with the person and the target, the text in Portuguese", async () => {
  await putSettings({ auto: true });
  try {
    const t = await open("chat=pt");
    await ready(t);
    const l = await langOf(t.p);
    eq(l.visibleText, "Auto · Português", "its words");
    eq(l.title, "The language of Priya Raman's last message. Click to send this one in English.", "its title");
    eq(l.disabled, "false", "it can switch to the target");
    eq(l.lang, "pt", "the name's lang");
    has(await val(t.p, "en"), PT_NORMAL, "the translation");
    eq(await t.p.locator("#en").getAttribute("lang"), "pt", "the box's lang");
    eq(reqsTo(t, "/api/translate")[0].body.target, undefined, "no one-time target on a plain translation");
    await expectLayout(t.p);
  } finally { await resetSettings(); }
});
check("Language", "a click on it translates the same Spanish again with the one-time target; the button then says the target and Auto stays on", async () => {
  await putSettings({ auto: true });
  try {
    const t = await open("chat=pt");
    await ready(t);
    await t.p.click("#lang");
    await waitState(t.p, "translating");
    await waitState(t.p, "ready");
    const r = reqsTo(t, "/api/translate");
    eq(r.length, 2, "translate requests");
    eq(r[1].body.target, "English", "the one-time target");
    eq(r[1].body.text, ES, "the same Spanish");
    has(await val(t.p, "en"), EN_NORMAL, "the translation in English");
    const l = await langOf(t.p);
    eq(l.visibleText, "English", "its words after the click");
    eq(l.title, "Your target language.", "its title after the click");
    eq(l.disabled, "true", "nothing left to switch");
    eq(reqsTo(t, "/api/settings").length, 0, "the click changes no setting");
    eq((await (await fetch(`${BASE}/api/state`)).json()).settings.auto, true, "Auto stays on");
    // The next translation follows the chat again.
    await t.p.click("#es"); await t.p.keyboard.press("End"); await t.p.keyboard.type(" Gracias.");
    await t.p.keyboard.press("Enter");
    await waitState(t.p, "ready");
    eq(reqsTo(t, "/api/translate")[2].body.target, undefined, "the next request has no one-time target");
    eq((await langOf(t.p)).visibleText, "Auto · Português", "the next translation follows the chat");
  } finally { await resetSettings(); }
});
check("Language", "Auto on, a chat with no message (?chat=new): 'Auto · English', titled 'The chat has no clear language, so your target.'", async () => {
  await putSettings({ auto: true });
  try {
    const t = await open("chat=new");
    await ready(t);
    const l = await langOf(t.p);
    eq(l.visibleText, "Auto · English", "its words");
    eq(l.title, "The chat has no clear language, so your target.", "its title");
    eq(l.disabled, "true", "it's already the target");
    await expectLayout(t.p);
  } finally { await resetSettings(); }
});
check("Language", "Auto on, the chat in English: 'Auto · English', titled with the person's last message and no click", async () => {
  await putSettings({ auto: true });
  try {
    const t = await open();
    await ready(t);
    const l = await langOf(t.p);
    eq(l.visibleText, "Auto · English", "its words");
    eq(l.title, "The language of Priya Raman's last message.", "its title");
    eq(l.disabled, "true", "it's already the target");
  } finally { await resetSettings(); }
});
check("Language", "a new target: the placeholder is its name, the box is named 'Translation', and an English text can be sent in it with one click", async () => {
  try {
    const t = await open();
    eq(await t.p.locator("#en").getAttribute("placeholder"), "English", "placeholder");
    eq(await t.p.locator("#en").getAttribute("aria-label"), "Translation", "accessible name");
    await ready(t);
    await t.p.click("#more");
    await t.p.click('#menu [data-target="Português"]');
    await settle(t.p, 300);
    await t.p.keyboard.press("Escape");
    eq(await t.p.locator("#en").getAttribute("placeholder"), "Português", "placeholder after the target changed");
    const l = await langOf(t.p);
    eq(l.visibleText, "English", "the translation on show is still English");
    eq(l.title, "Click to send this one in Português.", "its title");
    eq(l.disabled, "false", "it can switch");
    await t.p.click("#lang");
    await waitState(t.p, "translating");
    await waitState(t.p, "ready");
    eq(reqsTo(t, "/api/translate")[1].body.target, "Português", "the one-time target");
    eq((await langOf(t.p)).visibleText, "Português", "its words after the click");
    await t.p.keyboard.press("Escape");
    eq(await val(t.p, "en"), "", "Esc clears");
    ok(!(await langOf(t.p)).shown, "and the language button leaves");
  } finally { await resetSettings(); }
});
check("Language", "an adjust sends the current text and its language, and the button keeps 'Auto · Português'", async () => {
  await putSettings({ auto: true });
  try {
    const t = await open("chat=pt");
    await ready(t);
    const before = await val(t.p, "en");
    await t.p.keyboard.press("Meta+k");
    await t.p.click("#chip");
    await waitState(t.p, "adjusting");
    eq((await langOf(t.p)).visibleText, "Auto · Português", "the button while adjusting");
    await waitState(t.p, "ready");
    const r = reqsTo(t, "/api/adjust");
    eq(r[0].body.current, before, "the current text");
    eq(r[0].body.language, "Português", "its language");
    has(await val(t.p, "en"), "Consegue ver o orçamento", "the shorter Portuguese");
    eq((await langOf(t.p)).visibleText, "Auto · Português", "the button after the adjust");
  } finally { await resetSettings(); }
});
check("Language", "the button stays while sending and leaves with the sent message", async () => {
  const t = await open();
  await ready(t);
  await t.p.click("#send");
  await waitState(t.p, "sending");
  ok((await langOf(t.p)).shown, "it shows while sending");
  await waitState(t.p, "sent");
  ok(!(await langOf(t.p)).shown, "it leaves with the sent message");
});
check("Settings menu", "Reply in: Auto, a thin line, then your languages, the target pressed; Auto posts { auto }, a language posts { target }", async () => {
  try {
    const t = await open();
    await t.p.click("#more");
    const row = await t.p.evaluate(() => {
      const r = document.querySelector("#menu [data-auto]")!.closest(".posrow")!;
      return [...r.querySelectorAll("button, .sep")].map((e) => ({ role: e.getAttribute("role"), text: (e.textContent || "").trim(), checked: e.getAttribute("aria-checked"), sep: e.classList.contains("sep"), w: e.getBoundingClientRect().width, top: Math.round(e.getBoundingClientRect().top) }));
    });
    eq(row.map((b) => b.sep ? "|" : b.text).join(" "), "Auto | English Português", "the row");
    eq(row[0].role, "menuitemcheckbox", "Auto's role");
    eq(row[0].checked, "false", "Auto off at the start");
    ok(row[1].w === 1, `the divider is thin (${row[1].w} px)`);
    eq(row.slice(2).map((b) => `${b.role}:${b.checked}`).join(" "), "menuitemradio:true menuitemradio:false", "the languages, the target pressed");
    ok(new Set(row.map((b) => b.top)).size <= 2, "one row");
    eq(await t.p.locator('#menu [data-target="Português"]').getAttribute("lang"), "pt", "a language button's lang");
    await t.p.click("#menu [data-auto]");
    await settle(t.p, 300);
    eq(JSON.stringify(reqsTo(t, "/api/settings")[0]?.body), JSON.stringify({ auto: true }), "Auto's request");
    eq(await t.p.locator("#menu [data-auto]").getAttribute("aria-checked"), "true", "Auto pressed");
    await t.p.click("#menu [data-auto]");
    await settle(t.p, 300);
    eq(JSON.stringify(reqsTo(t, "/api/settings")[1]?.body), JSON.stringify({ auto: false }), "Auto off again");
    eq(await t.p.locator("#menu [data-auto]").getAttribute("aria-checked"), "false", "Auto not pressed");
    await t.p.click('#menu [data-target="Português"]');
    await settle(t.p, 300);
    eq(JSON.stringify(reqsTo(t, "/api/settings")[2]?.body), JSON.stringify({ target: "Português" }), "a language's request");
    eq(await t.p.locator('#menu [data-target="Português"]').getAttribute("aria-checked"), "true", "Português pressed");
    eq(await t.p.locator('#menu [data-target="English"]').getAttribute("aria-checked"), "false", "English no longer pressed");
    ok(await vis(t.p, "#menu"), "the menu stays open");
    await expectLayout(t.p);
    // Your languages come from Settings: a third one shows as a third button.
    await putSettings({ languages: ["English", "Português", "Français"] });
    await t.p.waitForFunction(() => document.querySelectorAll("#menu [data-target]").length === 3, null, { timeout: 3000 }).catch(() => { throw new Fail("a third language didn't show"); });
    await expectLayout(t.p);
  } finally { await resetSettings(); }
});
check("Settings menu", "eight languages: the menu stays inside the window, clear of the gear, with every language reachable, at 145 and 110 tall", async () => {
  await putSettings({ languages: ["English", "Português", "Español", "Français", "Deutsch", "Italiano", "Nederlands", "日本語"] });
  try {
    for (const [w, h] of [[1200, 145], [1200, 110], [640, 145], [640, 110]]) {
      const t = await open();
      await t.p.setViewportSize({ width: w, height: h });
      await settle(t.p, 150);
      await t.p.click("#more");
      const r = await t.p.evaluate(() => {
        const m = document.getElementById("menu")!.getBoundingClientRect(), g = document.getElementById("more")!.getBoundingClientRect();
        const row = document.querySelector("#menu [data-auto]")!.closest(".posrow") as HTMLElement;
        const last = [...document.querySelectorAll("#menu [data-target]")].pop() as HTMLElement;
        row.scrollLeft = row.scrollWidth;
        const lr = last.getBoundingClientRect(), rr = row.getBoundingClientRect();
        return { l: m.left, t: m.top, r: m.right, b: m.bottom, W: innerWidth, H: innerHeight, covers: !(m.right <= g.left || m.bottom <= g.top || m.left >= g.right || m.top >= g.bottom),
          reach: lr.left >= rr.left - 0.5 && lr.right <= rr.right + 0.5 && lr.right <= m.right };
      });
      ok(r.l >= 0 && r.t >= 0 && r.r <= r.W && r.b <= r.H, `${w} × ${h}: the menu leaves the window (${Math.round(r.l)},${Math.round(r.t)} to ${Math.round(r.r)},${Math.round(r.b)})`);
      ok(!r.covers, `${w} × ${h}: the menu covers the gear`);
      ok(r.reach, `${w} × ${h}: the last language can't be reached`);
      await t.p.click('#menu [data-target="日本語"]');
      await settle(t.p, 250);
      eq(await t.p.locator('#menu [data-target="日本語"]').getAttribute("aria-checked"), "true", `${w} × ${h}: the last language pressed`);
      await putSettings({ target: "English" });
      for (const x of contexts.splice(0)) { try { await x.close(); } catch {} }
    }
  } finally { await resetSettings(); }
});
narrowCheck("Settings menu", "under 720 wide, Position leaves the menu: On ⌘⏎, Model and Reply in stack in one column beside the commands; at 720 it's back", async () => {
  const t = await open();
  await ready(t, LONG_EN);
  await t.p.click("#more");
  await settle(t.p, 150);
  ok(!(await vis(t.p, "#menu [data-layout]")), "Position should leave the menu");
  eq((await t.p.locator("#menu .pl").evaluateAll((ls: any[]) => ls.filter((l) => l.getBoundingClientRect().width > 0).map((l) => l.textContent))).join(", "), "On ⌘⏎, Model, Reply in", "the rows");
  const g = await t.p.evaluate(() => [...document.querySelectorAll("#menu .prow")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; }));
  ok(g.length === 3 && g.every((x) => x[0] === g[0][0]) && g[0][1] < g[1][1] && g[1][1] < g[2][1], `one column of three: ${JSON.stringify(g)}`);
  const cmd = await rect(t.p, "#menu [data-do=guide]"), prefs = await rect(t.p, "#menu .col.prefs");
  ok(cmd.l >= prefs.r, "the commands sit beside the settings");
  await expectLayout(t.p);
  await t.p.setViewportSize({ width: 720, height: 145 });
  await settle(t.p, 150);
  ok(await vis(t.p, "#menu [data-layout]"), "at 720 Position is back");
  await expectLayout(t.p);
  await t.p.setViewportSize({ width: 719, height: 110 });
  await settle(t.p, 150);
  ok(!(await vis(t.p, "#menu [data-layout]")), "at 719 × 110 Position leaves too");
  const m = await rect(t.p, "#menu"), gear = await rect(t.p, "#more");
  ok(m.l >= 0 && m.t >= 0 && m.r <= 719 && m.b <= 110, `at 719 × 110 the menu leaves the window (${JSON.stringify(m)})`);
  ok(m.r <= gear.l || m.b <= gear.t, "at 719 × 110 the menu covers the gear");
});
narrowCheck("Language", "the language button gives way after the hints and Adjust's word: 'Auto ·' leaves before the chat's name drops below 96 px", async () => {
  await putSettings({ auto: true });
  try {
    const t = await open("chat=pt");
    await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT, last: "Você consegue revisar o orçamento até quinta?" });
    await ready(t);
    await settle(t.p, 150);
    let fit = await t.p.evaluate(() => document.getElementById("strip")!.dataset.fit);
    const l = await langOf(t.p);
    ok(l.shown, "the language button shows");
    const to = await t.p.evaluate(() => document.getElementById("to")!.clientWidth);
    ok(to >= 96 || /\blang\b/.test(fit), `the name went below 96 px (${to}) before the button gave way (${fit})`);
    if (/\bname\b/.test(fit)) ok(/keys pencil lang/.test(fit), `the steps' order: ${fit}`);
    await expectLayout(t.p);
    // A long notice too: the steps keep their order, and the language's name stays.
    await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT, last: "Você consegue revisar o orçamento até quinta?", shape: "several" });
    await settle(t.p, 150);
    fit = await t.p.evaluate(() => document.getElementById("strip")!.dataset.fit);
    has(fit, "keys pencil lang", "steps with a notice");
    eq((await langOf(t.p)).visibleText, "Português", "the name stays when 'Auto ·' leaves");
    eq((await langOf(t.p)).title, "The language of Priya Raman's last message. Click to send this one in English.", "its title keeps the words");
    await expectLayout(t.p);
    return `steps: ${fit}`;
  } finally { await resetSettings(); }
});
check("Mic", "the dictation start message carries the settings' locale (es-MX, then pt-BR)", async () => {
  try {
    let t = await open();
    await t.p.click("#mic");
    await settle(t.p, 100);
    eq((await t.msgs()).find((m: any) => m.type === "dictation" && m.action === "start")?.locale, "es-MX", "the default locale");
    await t.p.click("#mic");
    await putSettings({ dictation: "pt-BR" });
    t = await open();
    await t.p.click("#mic");
    await settle(t.p, 100);
    eq((await t.msgs()).find((m: any) => m.type === "dictation" && m.action === "start")?.locale, "pt-BR", "the settings' locale");
    await t.p.click("#mic");
  } finally { await resetSettings(); }
});

// ===================================================================================== the language written in
const detectedText = (p: any) => p.evaluate(() => { const d = document.getElementById("detected")!; return d.hidden || d.offsetWidth === 0 ? "" : (d.textContent ?? "").replace(/\s+/g, " ").trim(); });
const detectedName = (p: any) => p.evaluate(() => document.querySelector("#detected b")?.textContent ?? "");
check("Detect", "the language of what you write shows before the mic as 'Detected · <language>', named in itself; short, empty or dictating, nothing", async () => {
  const t = await open();
  eq(await detectedText(t.p), "", "nothing before typing");
  await t.p.click("#es");
  await t.p.keyboard.type("¿Puedes revisar el presupuesto antes del jueves?");
  await t.p.waitForFunction(() => document.querySelector("#detected b")?.textContent === "Español", null, { timeout: 3000 });
  eq(await detectedText(t.p), "Detected · Español", "Spanish, said as detected");
  eq(await t.p.evaluate(() => getComputedStyle(document.querySelector("#detected b")!).fontWeight !== getComputedStyle(document.querySelector("#detected .word")!).fontWeight), true, "the language stands out from 'Detected ·'");
  has(await t.p.locator("#detected").getAttribute("title"), "Español", "its title");
  await t.p.fill("#es", "");
  await t.p.keyboard.type("Could you take a look at the budget before Thursday?");
  await t.p.waitForFunction(() => document.querySelector("#detected b")?.textContent === "English", null, { timeout: 3000 });
  await t.p.fill("#es", "ok");
  await t.p.dispatchEvent("#es", "input");
  await settle(t.p, 600);
  eq(await detectedText(t.p), "", "too short");
  await t.p.fill("#es", "");
  await t.p.dispatchEvent("#es", "input");
  await settle(t.p, 300);
  eq(await detectedText(t.p), "", "empty");
  await t.p.click("#mic");
  await settle(t.p, 900);
  eq(await detectedText(t.p), "", "hidden while dictating");
});
narrowCheck("Narrow", "'Detected · ' leaves first, then the language, before Normal and Formal, when the input footer is short of room, and nothing overflows", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.keyboard.type("¿Puedes revisar el presupuesto antes del jueves? Si hace falta, lo vemos en la llamada.");
  await settle(t.p, 700);
  await expectLayout(t.p);
});

// ===================================================================================== Send
check("Send", "Send is off before there is English", async () => {
  const t = await open();
  ok(await t.p.locator("#send").isDisabled(), "Send should be disabled");
  await t.p.fill("#es", ES);
  ok(await t.p.locator("#send").isDisabled(), "Send should stay disabled with only Spanish");
  await t.p.keyboard.press("Meta+Enter");
  await settle(t.p, 200);
  eq((await sends(t)).length, 0, "send messages");
});
check("Send", "in an empty strip, what you type in the English box is the message: Send turns on and sends it to the open chat; emptying it turns Send off", async () => {
  const t = await open();
  eq(await t.p.evaluate(() => (document.getElementById("en") as HTMLTextAreaElement).readOnly), false, "the empty English box takes typing");
  await t.p.click("#en");
  await t.p.keyboard.type("Running five minutes late, start without me.");
  await waitState(t.p, "ready");
  ok(!(await t.p.locator("#send").isDisabled()), "Send should be on");
  eq((await t.p.locator("#lang").innerText()).trim(), "English", "the language button names the target");
  await t.p.keyboard.press("Meta+a");
  await t.p.keyboard.press("Backspace");
  await waitState(t.p, "idle");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off again");
  await t.p.keyboard.type("On my way.");
  await waitState(t.p, "ready");
  await t.p.keyboard.press("Meta+Enter");
  await waitState(t.p, "sending");
  const s = await sends(t);
  eq(s.length, 1, "send messages");
  eq(s[0].text, "On my way.", "sent text");
  ok(!!s[0].chat, "the send names the open chat");
  await waitState(t.p, "sent");
});
check("Send", "while dictating, the empty English box stays read-only", async () => {
  const t = await open();
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("strip")!.dataset.dict === "on" || (document.getElementById("es") as HTMLTextAreaElement).value.length > 0, null, { timeout: 3000 });
  eq(await t.p.evaluate(() => (document.getElementById("en") as HTMLTextAreaElement).readOnly), true, "read-only while dictating");
});
async function sendFlow(how: "click" | "key", query = "") {
  const t = await open(query);
  await translateFlow(t);
  const english = await val(t.p, "en");
  if (how === "click") await t.p.click("#send"); else await t.p.keyboard.press("Meta+Enter");
  await waitState(t.p, "sending");
  eq(await tagText(t.p), "Sending…", "tag while sending");
  const s = await sends(t);
  eq(s.length, 1, "send messages");
  eq(s[0].text, english, "sent text");
  eq(s[0].mode, "send", "mode");
  return t;
}
check("Send", "Send button, mode send: Sending…, then, once the message shows in the chat, both boxes empty and 'Sent · time' shows in the footer (To names the chat; the title says it too), in green with a check, for 3 s", async () => {
  const t = await sendFlow("click");
  const english = await val(t.p, "en");
  await waitState(t.p, "sent");
  const done = (await tagText(t.p)).replace(/\s+/g, " ").trim();
  ok(/^Sent · \d{1,2}:\d{2} (AM|PM)$/.test(done), `footer tag ${JSON.stringify(done)}`);
  ok(/^Sent to .+ at \d{1,2}:\d{2} (AM|PM)$/.test((await t.p.locator("#status").getAttribute("title")) ?? ""), "the title says to whom");
  eq(await t.p.evaluate(() => document.getElementById("status")!.className), "status tag s-done", "the tag's kind");
  ok(await t.p.evaluate(() => !!document.querySelector("#status .ico svg")), "the tag has its check");
  ok(await t.p.evaluate(() => { const w = document.querySelector("#status > span:last-child") as HTMLElement; return w.scrollWidth <= w.clientWidth + 1; }), "the tag shows whole");
  eq(await val(t.p, "en"), "", "the English box empties once it's in the chat");
  eq(await val(t.p, "es"), "", "Spanish box");
  eq(await focused(t.p), "es", "focus");
  ok(await t.p.locator("#send").isDisabled(), "Send is off: it was sent");
  await t.p.waitForFunction(() => document.getElementById("strip")!.dataset.fading === "yes", null, { timeout: 5000 });
  eq(await t.p.evaluate(() => getComputedStyle(document.getElementById("tagrow")!).transitionProperty), "opacity", "the tag fades out, not just vanishes");
  await waitState(t.p, "idle", 3000);
  eq(await tagText(t.p), "", "the tag is gone after 3 s");
  ok(await t.p.evaluate(() => !document.getElementById("strip")!.dataset.fading), "the fade is over");
});
check("Send", "⌘⏎ sends the same way", async () => {
  const t = await sendFlow("key");
  await waitState(t.p, "sent");
  eq(await val(t.p, "en"), "", "the English box empties");
});
check("Send", "Put in Teams mode: the button says so, mode leave, 'Left in Teams, not sent'", async () => {
  await setMode("leave");
  try {
    const t = await open();
    await translateFlow(t);
    eq((await t.p.locator("#send").textContent()).replace(/\s+/g, " ").trim(), "Put in Teams ⌘⏎", "button label");
    // The hint may leave only as the footer's first give-way step (in the column, beside the language and the name).
    if (!(await vis(t.p, "#send kbd"))) has(await t.p.evaluate(() => document.getElementById("strip")!.dataset.fit), "keys", "the hint left as a fit step");
    await t.p.click("#send");
    await waitState(t.p, "sending");
    eq(await tagText(t.p), "Putting in Teams…", "tag while sending");
    eq((await sends(t))[0].mode, "leave", "mode");
    await waitState(t.p, "leave");
    eq(await tagText(t.p), "Left in Teams, not sent", "footer tag");
    eq(await val(t.p, "en"), "", "the English box empties");
    eq(await val(t.p, "es"), "", "Spanish box");
  } finally { await resetSettings(); }
});
check("Send", "Send is off with Teams closed, and ⌘⏎ sends nothing", async () => {
  const t = await open("teams=closed");
  await translateFlow(t);
  ok(await t.p.locator("#send").isDisabled(), "Send should be disabled");
  await t.p.keyboard.press("Meta+Enter");
  await settle(t.p, 200);
  eq((await sends(t)).length, 0, "send messages");
});
check("Send", "Send is off with no chat open, and ⌘⏎ sends nothing", async () => {
  const t = await open("teams=nochat");
  await translateFlow(t);
  ok(await t.p.locator("#send").isDisabled(), "Send should be disabled");
  await t.p.keyboard.press("Meta+Enter");
  await settle(t.p, 200);
  eq((await sends(t)).length, 0, "send messages");
});
check("Send", "the context isn't sent when there is no chat", async () => {
  const t = await open("teams=nochat");
  await translateFlow(t);
  eq(reqsTo(t, "/api/translate")[0].body.context, undefined, "context");
});
check("Send", "no answer from the shell for 20 s: 'Teams didn't answer. Check the chat'", async () => {
  const t = await open();
  await translateFlow(t);
  await t.p.evaluate(() => { (window as any).standIn = (m: any) => { (window as any).__msgs.push(m); }; });
  await t.p.click("#send");
  await waitState(t.p, "sending");
  await t.p.waitForTimeout(21000);
  eq(await tagText(t.p), "Teams didn't answer. Check the chat", "tag");
  eq(await state(t.p), "error", "state (a notice of kind error gives the red box)");
  ok(await t.p.locator("#send").isEnabled(), "Send should be back");
});

// every reason the shell can give
async function failedSend(reason: string) {
  const t = await open(`send=${reason}`);
  await translateFlow(t);
  await t.p.click("#send");
  const want = reason === "draft" ? "draft" : ["not-front", "mismatch", "not-sent", "not-posted", "unconfirmed", "cleared", "no-paste", "not-own-server", "something-else"].includes(reason) ? "error" : "ready";
  await waitState(t.p, want, 4000).catch(() => {});
  await t.p.waitForTimeout(1100);
  return t;
}
check("Send reasons", "the send names the chat the strip shows; chat-changed: red, 'Chat changed. Not sent', no retry", async () => {
  const t = await open("send=chat-changed");
  await translateFlow(t);
  const shown = (await t.p.locator("#chat").innerText()).trim();
  await t.p.click("#send");
  await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("Chat changed"), null, { timeout: 3000 });
  const sent = (await sends(t))[0];
  eq(sent.chat, shown, "chat in the send message");
  eq(await tagText(t.p), "Chat changed. Not sent", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await state(t.p), "error", "state");
  ok((await val(t.p, "en")).length > 0, "the English stays");
});
check("Send reasons", "draft: tag, Add after draft and Cancel", async () => {
  const t = await failedSend("draft");
  eq(await state(t.p), "draft", "state");
  eq(await tagText(t.p), "Teams has a draft", "tag");
  eq((await actionLabels(t.p)).join(","), "Add after draft,Cancel", "buttons");
});
check("Send reasons", "draft → Add after draft sends with afterDraft", async () => {
  const t = await failedSend("draft");
  await t.p.click("#actions [data-act=add]");
  await waitState(t.p, "sending");
  const s = await sends(t);
  eq(s.length, 2, "send messages");
  eq(s[1].afterDraft, true, "afterDraft");
  await waitState(t.p, "sent");
});
check("Send reasons", "draft → Cancel goes back to ready with the text kept", async () => {
  const t = await failedSend("draft");
  const en = await val(t.p, "en");
  await t.p.click("#actions [data-act=cancel]");
  eq(await state(t.p), "ready", "state");
  eq(await val(t.p, "en"), en, "English kept");
  eq(await val(t.p, "es"), ES, "Spanish kept");
  ok(await t.p.locator("#send").isEnabled(), "Send should be on");
  eq(await tagText(t.p), "", "tag");
});
check("Send reasons", "no-teams: 'Teams isn't open' and Open Teams asks the shell", async () => {
  const t = await failedSend("no-teams");
  eq(await tagText(t.p), "Teams isn't open", "tag");
  eq((await actionLabels(t.p)).join(","), "Open Teams", "buttons");
  await t.p.click("#actions [data-act=open-teams]");
  eq((await opens(t, "teams")).length, 1, "open teams messages");
  ok((await val(t.p, "en")).length > 0, "English was lost");
});
check("Send reasons", "no-chat: 'No chat open in Teams'", async () => {
  const t = await failedSend("no-chat");
  eq(await tagText(t.p), "No chat open in Teams", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
});
check("Send reasons", "not-front: 'Teams didn't come forward', no Try again, red box; Send is the retry", async () => {
  const t = await failedSend("not-front");
  eq(await tagText(t.p), "Teams didn't come forward", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await state(t.p), "error", "state");
  ok(await t.p.locator("#send").isEnabled(), "Send should be on to try again");
  await t.p.click("#send");
  await waitState(t.p, "sending");
  eq((await sends(t)).length, 2, "send messages");
  await t.p.waitForTimeout(1100);
  eq(await tagText(t.p), "Teams didn't come forward", "tag after the second try");
});
check("Send reasons", "mismatch: 'Teams changed it. Not sent', no retry button", async () => {
  const t = await failedSend("mismatch");
  eq(await tagText(t.p), "Teams changed it. Not sent", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await state(t.p), "error", "state");
  return "the build notes say 'Teams didn't take it. Not sent' + Try again; the code and contract say no retry";
});
check("Send", "not in the chat: Teams emptied its box but the message never showed; the English stays, the notice says to check the chat, and Send works again", async () => {
  const t = await failedSend("not-posted");
  eq(await state(t.p), "error", "state");
  eq(await tagText(t.p), "Not in the chat. Check it", "notice");
  ok(await t.p.evaluate(() => { const w = document.querySelector("#status > span:last-child") as HTMLElement; return !!w && w.scrollWidth <= w.clientWidth + 1; }), "the notice shows whole, not cut off");
  ok(await t.p.evaluate(() => !!document.querySelector("#status .ico svg") && !document.querySelector("#status .sdot")), "an error tag has its exclamation in a circle, not a dot");
  ok((await val(t.p, "en")).length > 0, "the English should stay in the box");
  ok(!(await t.p.locator("#send").isDisabled()), "Send should be on");
});
check("Send reasons", "not-sent: 'In Teams' box, not sent'", async () => {
  const t = await failedSend("not-sent");
  eq(await tagText(t.p), "In Teams' box, not sent", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await state(t.p), "error", "state");
});
check("Send reasons", "an unknown reason: 'Couldn't send', no Try again, red box", async () => {
  const t = await failedSend("something-else");
  eq(await tagText(t.p), "Couldn't send", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await state(t.p), "error", "state");
});
check("Send reasons", "no-access: the first-run cover comes up", async () => {
  const t = await failedSend("no-access");
  eq(await t.p.locator("#strip").getAttribute("data-access"), "no", "data-access");
  ok(await vis(t.p, ".cover"), "cover visible");
});

check("Send reasons", "no-paste: 'Teams didn't take it. Not sent', no retry button, red box, the text stays", async () => {
  const t = await failedSend("no-paste");
  eq(await tagText(t.p), "Teams didn't take it. Not sent", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await state(t.p), "error", "state");
  ok((await val(t.p, "en")).length > 0, "the English stays");
  ok(await t.p.locator("#send").isEnabled(), "Send should be on to try again");
});
check("Send reasons", "not-own-server: 'Not the app's own page. Not sent', no retry button, red box", async () => {
  const t = await failedSend("not-own-server");
  eq(await tagText(t.p), "Not the app's own page. Not sent", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await state(t.p), "error", "state");
  ok((await val(t.p, "en")).length > 0, "the English stays");
});
check("Send reasons", "no-paste marks the English as a possible leftover: Teams may take the paste late, and that text is ours", async () => {
  const t = await open("send=no-paste");
  await translateFlow(t);
  await t.p.click("#send");
  await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("Not sent"), null, { timeout: 3000 });
  ok(await t.p.evaluate(() => (st as any).leftover !== null && (st as any).leftover === (st as any).lastText), "the English should be marked as a possible leftover after no-paste");
});

// ===================================================================================== Teams
check("Teams", "Teams closed: tag, Open Teams, no chat name", async () => {
  const t = await open("teams=closed");
  eq(await tagText(t.p), "Teams isn't open", "tag");
  eq((await actionLabels(t.p)).join(","), "Open Teams", "buttons");
  ok(!(await vis(t.p, "#to")), "the 'To' chat name should be hidden");
  await t.p.click("#actions [data-act=open-teams]");
  eq((await opens(t, "teams")).length, 1, "open teams messages");
});
check("Teams", "no chat open: tag, no button, no chat name", async () => {
  const t = await open("teams=nochat");
  eq(await tagText(t.p), "No chat open in Teams", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  ok(!(await vis(t.p, "#to")), "the 'To' chat name should be hidden");
});
check("Teams", "chat open: 'To <chat>' shows beside Send", async () => {
  const t = await open();
  has(await t.p.locator("#to").innerText(), "Priya Raman", "To label");
  eq(await tagText(t.p), "", "tag");
});
check("Teams", "Teams closes while a translation is ready: tag appears, Send goes off", async () => {
  const t = await open();
  await translateFlow(t);
  await setTeams(t.p, { open: false, chat: null, from: null, last: null, draft: false });
  eq(await tagText(t.p), "Teams isn't open", "tag");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off");
  await setTeams(t.p, { open: true, chat: "Priya Raman", from: "Priya Raman", last: LAST, draft: false });
  eq(await tagText(t.p), "", "tag after Teams is back");
  ok(await t.p.locator("#send").isEnabled(), "Send should be back");
});

const DANIEL_TEAMS = { open: true, chat: "Daniel Okafor", from: "Daniel Okafor", last: "Thanks, see you then.", draft: false, shape: "ok" };
const PRIYA_TEAMS = { open: true, chat: "Priya Raman", from: "Priya Raman", last: LAST, draft: false, shape: "ok" };
check("Settings menu", "Position: five buttons in one row, Auto pressed; a choice goes to the shell and shows pressed", async () => {
  const t = await open();
  await t.p.click("#more");
  const labels = await t.p.locator("#menu [data-layout]").evaluateAll((bs: any[]) => bs.map(b => b.getAttribute("aria-label")));
  eq(labels.join(" | "), "Automatic | Below Teams | Above Teams | Left of Teams | Right of Teams", "the buttons");
  eq(await t.p.locator('[data-layout="automatic"]').getAttribute("aria-checked"), "true", "Auto pressed");
  const tops = await t.p.locator("#menu [data-layout]").evaluateAll((bs: any[]) => bs.map(b => Math.round(b.getBoundingClientRect().top)));
  ok(new Set(tops).size === 1, `one row: ${tops.join(", ")}`);
  await t.p.click('[data-layout="left"]');
  await settle(t.p, 150);
  const msgs = (await t.msgs()).filter((m: any) => m.type === "layout");
  eq(msgs.length, 1, "layout messages");
  eq(msgs[0].value, "left", "the value sent");
  eq(await t.p.locator('[data-layout="left"]').getAttribute("aria-checked"), "true", "← pressed");
  eq(await t.p.locator('[data-layout="automatic"]').getAttribute("aria-checked"), "false", "Auto no longer pressed");
  await expectLayout(t.p);
});
check("Teams", "two boxes and no cursor (?shape=several): orange 'Click the box in Teams first', the chat shown, Send off after a translation", async () => {
  const t = await open("shape=several");
  await translateFlow(t);
  eq(await tagText(t.p), "Click the box in Teams first", "tag");
  eq(await t.p.locator("#status").getAttribute("class"), "status tag s-needs", "tag class (orange)");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  ok(await vis(t.p, "#to"), "the 'To' chat name should show");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off");
  await t.p.keyboard.press("Meta+Enter");
  await settle(t.p, 200);
  eq((await sends(t)).length, 0, "send messages");
});
check("Send reasons", "which-box: orange 'Click the box in Teams first', no button, the text stays, Send on again", async () => {
  const t = await failedSend("which-box");
  eq(await tagText(t.p), "Click the box in Teams first", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  ok((await val(t.p, "en")).length > 0, "the English stays");
  ok(await t.p.locator("#send").isEnabled(), "Send should be on");
});
check("Teams", "box not found (?shape=unknown): red notice, no chat name, no button; Send stays off after a translation", async () => {
  const t = await open("shape=unknown");
  eq(await tagText(t.p), "Can't find Teams' message box", "tag");
  eq(await t.p.locator("#status").getAttribute("class"), "status tag s-error", "tag class (red)");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  ok(!(await vis(t.p, "#to")), "the 'To' chat name should be hidden");
  eq(await t.p.locator("#strip").getAttribute("data-teams"), "unknown", "data-teams");
  await translateFlow(t);
  eq(await tagText(t.p), "Can't find Teams' message box", "tag over a ready translation");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off");
  await t.p.keyboard.press("Meta+Enter");
  await settle(t.p, 200);
  eq((await sends(t)).length, 0, "send messages");
  await setTeams(t.p, PRIYA_TEAMS);
  eq(await tagText(t.p), "", "tag once the box is found");
  ok(await t.p.locator("#send").isEnabled(), "Send should be back");
});
check("Teams", "box not found while a translation is ready: the notice wins over a voice finding, and Send goes off", async () => {
  const t = await open();
  await translateFlow(t, "kindly revisa");
  eq(await tagText(t.p), "\"Kindly\" sounds stiff", "voice finding");
  await setTeams(t.p, { ...PRIYA_TEAMS, shape: "unknown" });
  eq(await tagText(t.p), "Can't find Teams' message box", "tag");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off");
});
check("Teams", "the chat changes while the English is ready: red 'Written for <chat>' and a red box, Send and Adjust off, ⌘⏎ and ⌘K do nothing", async () => {
  const t = await open();
  await translateFlow(t);
  await setTeams(t.p, DANIEL_TEAMS);
  eq(await tagText(t.p), "Written for Priya Raman", "tag");
  eq(await t.p.locator("#status").getAttribute("class"), "status tag s-error", "tag class (red)");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await state(t.p), "written", "state (the red box)");
  has(await t.p.locator("#to").innerText(), "Daniel Okafor", "To label shows the chat that is open");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off");
  ok(!(await vis(t.p, "#adjustBtn")), "Adjust should be hidden");
  await t.p.keyboard.press("Meta+Enter");
  await t.p.keyboard.press("Meta+k");
  await settle(t.p, 200);
  eq((await sends(t)).length, 0, "send messages");
  eq(await t.p.locator("#strip").getAttribute("data-adjust"), "", "adjust row");
  ok(await t.p.locator("#translate").isEnabled(), "Translate should be on");
  has(await val(t.p, "en"), EN_NORMAL, "the English stays");
});
check("Teams", "back in that chat: the tag goes and Send is on again, sending to it", async () => {
  const t = await open();
  await translateFlow(t);
  await setTeams(t.p, DANIEL_TEAMS);
  await setTeams(t.p, PRIYA_TEAMS);
  eq(await tagText(t.p), "", "tag");
  ok(await t.p.locator("#send").isEnabled(), "Send should be on");
  ok(await vis(t.p, "#adjustBtn"), "Adjust should show");
  await t.p.click("#send");
  await waitState(t.p, "sending");
  eq((await sends(t))[0].chat, "Priya Raman", "chat in the send message");
});
check("Teams", "translating again (⏎) in the other chat: asks with that chat, the tag goes, Send goes to it", async () => {
  const t = await open();
  await translateFlow(t);
  await setTeams(t.p, DANIEL_TEAMS);
  await t.p.click("#es");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "translating");
  await waitState(t.p, "ready");
  const r = reqsTo(t, "/api/translate");
  eq(r.length, 2, "translate requests");
  eq(r[1].body.context?.chat, "Daniel Okafor", "context chat of the second request");
  eq(await tagText(t.p), "", "tag");
  ok(await t.p.locator("#send").isEnabled(), "Send should be on");
  await t.p.click("#send");
  await waitState(t.p, "sending");
  eq((await sends(t))[0].chat, "Daniel Okafor", "chat in the send message");
});
check("Teams", "the chat changes while it is translating: the tag shows when the English comes", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", ES);
  await t.p.press("#es", "Enter");
  await waitState(t.p, "translating");
  await setTeams(t.p, DANIEL_TEAMS);
  await waitState(t.p, "written");
  eq(await tagText(t.p), "Written for Priya Raman", "tag");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off");
});
check("Teams", "the chat closes (no chat) and comes back as another one: the notice for no chat first, then the tag", async () => {
  const t = await open();
  await translateFlow(t);
  await setTeams(t.p, { open: true, chat: null, from: null, last: null, draft: false, shape: "ok" });
  eq(await tagText(t.p), "No chat open in Teams", "tag with no chat");
  await setTeams(t.p, DANIEL_TEAMS);
  eq(await tagText(t.p), "Written for Priya Raman", "tag in the other chat");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off");
});
check("Teams", "a draft question in the other chat shows the tag, with no Add after draft", async () => {
  const t = await open("send=draft");
  await translateFlow(t);
  await t.p.click("#send");
  await waitState(t.p, "draft", 3000);
  await setTeams(t.p, DANIEL_TEAMS);
  eq(await tagText(t.p), "Written for Priya Raman", "tag");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  await setTeams(t.p, PRIYA_TEAMS);
  eq(await tagText(t.p), "Teams has a draft", "tag back in that chat");
  eq((await actionLabels(t.p)).join(","), "Add after draft,Cancel", "buttons");
});
check("Teams", "the Spanish edited while the chat is another one: out of date comes first", async () => {
  const t = await open();
  await translateFlow(t);
  await setTeams(t.p, DANIEL_TEAMS);
  await t.p.click("#es");
  await t.p.keyboard.press("End");
  await t.p.keyboard.type("!");
  eq(await tagText(t.p), "Translation out of date", "tag");
});

// ===================================================================================== first run
check("First run", "cover: sentence, button, fields locked; the button asks the shell", async () => {
  const t = await open("access=0");
  ok(await vis(t.p, ".cover"), "cover visible");
  has(await t.p.locator(".cover").innerText(), "Allow Accessibility to send messages in Teams.", "cover text");
  eq(await t.p.locator("#accessBtn").innerText(), "Open System Settings", "button label");
  ok(await t.p.evaluate(() => (document.getElementById("fields") as any).inert), "fields should be inert");
  await t.p.click("#accessBtn");
  eq((await opens(t, "accessibility")).length, 1, "open accessibility messages");
});
check("First run", "the cover goes away when Accessibility is allowed", async () => {
  const t = await open("access=0");
  await t.p.evaluate(() => (window as any).strip.access({ accessibility: true, microphone: "unknown" }));
  ok(!(await vis(t.p, ".cover")), "cover should be gone");
  ok(!(await t.p.evaluate(() => (document.getElementById("fields") as any).inert)), "fields should work again");
});

// ===================================================================================== replies
check("Replies", "UNCLEAR: asks a question (orange text in the English box), Send off, retry works", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", "UNCLEAR el jueves");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "question");
  eq(await tagText(t.p), "Asks you", "tag");
  eq(await val(t.p, "en"), "This Thursday or next week's?", "English box shows the question");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off on a question");
  ok(!(await vis(t.p, "#adjustBtn")), "Adjust should be off on a question");
  ok(await t.p.locator("#translate").isEnabled(), "Translate should be on after a question");
  await t.p.fill("#es", "El jueves de esta semana");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "ready");
  ok((await val(t.p, "en")).length > 0, "no English after answering");
});
check("Replies", "OFFLINE: 'Can't reach Claude' with Try again, which asks again", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", "OFFLINE revisa esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "error");
  eq(await tagText(t.p), "Can't reach Claude", "tag");
  eq((await actionLabels(t.p)).join(","), "Try again", "buttons");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off");
  await t.p.click("#actions [data-act=retry]");
  await waitState(t.p, "translating").catch(() => {});
  await waitState(t.p, "error");
  eq(reqsTo(t, "/api/translate").length, 2, "translate requests");
});
check("Replies", "FAILED: 'Couldn't translate' with Try again", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", "FAILED esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "error");
  eq(await tagText(t.p), "Couldn't translate", "tag");
  eq((await actionLabels(t.p)).join(","), "Try again", "buttons");
});
check("Replies", "LIMIT: plan limit tag with the time, no button", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", "LIMIT esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "limit");
  ok(/^Plan limit reached until .*\d:\d\d (AM|PM)$/.test(await tagText(t.p)), `tag ${JSON.stringify(await tagText(t.p))}`);
  eq((await actionLabels(t.p)).length, 0, "buttons");
});
check("Replies", "GUIDE: 'Voice guide not set' and Open guide settings asks the shell", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", "GUIDE esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "noguide");
  eq(await tagText(t.p), "Voice guide not set", "tag");
  eq((await actionLabels(t.p)).join(","), "Open guide settings", "buttons");
  await t.p.click("#actions [data-act=guide]");
  eq((await opens(t, "guide")).length, 1, "open guide messages");
});
check("Replies", "LOGIN: 'Sign in to Claude Code' in gray, Try again asks again", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", "LOGIN esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "login");
  eq(await tagText(t.p), "Sign in to Claude Code", "tag");
  eq(await t.p.locator("#status").getAttribute("class"), "status tag s-idle", "tag class (gray)");
  eq((await actionLabels(t.p)).join(","), "Try again", "buttons");
  await t.p.click("#actions [data-act=retry]");
  // The mock answers LOGIN at once, so "translating" may be over before it's seen: wait for the second request.
  for (let i = 0; i < 40 && reqsTo(t, "/api/translate").length < 2; i++) await settle(t.p, 100);
  await waitState(t.p, "login");
  eq(reqsTo(t, "/api/translate").length, 2, "translate requests");
});
check("Replies", "NOCLAUDE: 'Install Claude Code' in gray, Try again asks again", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", "NOCLAUDE esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "login");
  eq(await tagText(t.p), "Install Claude Code", "tag");
  eq(await t.p.locator("#status").getAttribute("class"), "status tag s-idle", "tag class (gray)");
  eq((await actionLabels(t.p)).join(","), "Try again", "buttons");
  await t.p.click("#actions [data-act=retry]");
  // The mock answers at once, so "translating" may be over before it's seen: wait for the second request.
  for (let i = 0; i < 40 && reqsTo(t, "/api/translate").length < 2; i++) await settle(t.p, 100);
  await waitState(t.p, "login");
  eq(reqsTo(t, "/api/translate").length, 2, "translate requests");
});
check("Replies", "UPDATE: 'Claude Code needs an update' in gray, Try again asks again", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", "UPDATE esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "update");
  eq(await tagText(t.p), "Claude Code needs an update", "tag");
  eq(await t.p.locator("#status").getAttribute("class"), "status tag s-idle", "tag class (gray)");
  eq((await actionLabels(t.p)).join(","), "Try again", "buttons");
  await t.p.click("#actions [data-act=retry]");
  // The mock answers UPDATE at once, so "translating" may be over before it's seen: wait for the second request.
  for (let i = 0; i < 40 && reqsTo(t, "/api/translate").length < 2; i++) await settle(t.p, 100);
  await waitState(t.p, "update");
  eq(reqsTo(t, "/api/translate").length, 2, "translate requests");
});
check("Replies", "LOGIN and UPDATE in an adjust: the notice over the English, with Try again (adjust again)", async () => {
  for (const [word, text] of [["LOGIN", "Sign in to Claude Code"], ["UPDATE", "Claude Code needs an update"]]) {
    const t = await open();
    await translateFlow(t);
    await t.p.keyboard.press("Meta+k");
    await t.p.fill("#adjIn", `${word} nota`);
    await t.p.press("#adjIn", "Enter");
    await t.p.waitForFunction((x: string) => document.getElementById("status")!.textContent!.includes(x), text, { timeout: 4000 });
    eq(await state(t.p), "ready", `${word}: state`);
    has(await val(t.p, "en"), EN_NORMAL, `${word}: the English stays`);
    eq((await actionLabels(t.p)).join(","), "Try again", `${word}: buttons`);
    await t.p.click("#actions [data-act=retry-adjust]");
    await t.p.waitForFunction((x: string) => document.getElementById("status")!.textContent!.includes(x), text, { timeout: 4000 });
    eq(reqsTo(t, "/api/adjust").length, 2, `${word}: adjust requests`);
    for (const x of contexts.splice(0)) { try { await x.close(); } catch {} }
  }
});
check("Replies", "BUSY: the page waits and asks again until it gets an answer", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", "BUSY revisa esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "ready", 12000);
  eq(reqsTo(t, "/api/translate").length, 3, "translate requests");
});
check("Replies", "STARTING: 'Starting translator…' until it is ready", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.fill("#es", "STARTING revisa esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "starting", 3000);
  has(await t.p.locator("#busyText").innerText(), "Starting translator", "busy text");
  await waitState(t.p, "ready", 8000);
});
check("Replies", "kindly: a voice-check finding shows as an orange tag with Send still on", async () => {
  const t = await open();
  await translateFlow(t, "kindly revisa el presupuesto");
  eq(await tagText(t.p), "\"Kindly\" sounds stiff", "tag");
  has(await t.p.locator("#status").getAttribute("class") ?? "", "s-needs", "tag kind");
  eq(await t.p.locator("#status").getAttribute("title"), "\"Kindly\" sounds stiff", "tooltip");
  ok(await t.p.locator("#send").isEnabled(), "Send should stay on");
  ok(await vis(t.p, "#adjustBtn"), "Adjust should show beside the tag");
});
check("Replies", "editing the English clears the voice-check tag", async () => {
  const t = await open();
  await translateFlow(t, "kindly revisa el presupuesto");
  await t.p.fill("#en", "Please review the budget before Thursday.");
  eq(await tagText(t.p), "", "tag");
});

// ===================================================================================== Translate button
check("Translate button", "always there at the end of the Spanish footer: off when empty, on with text, translates on click", async () => {
  const t = await open();
  const b = t.p.locator("#translate");
  eq((await b.innerText()).replace(/\s+/g, " "), "Translate ⏎", "label");
  ok(await b.isDisabled(), "off while the field is empty");
  const isLast = await t.p.evaluate(() => { const foot = document.querySelector(".f.es .foot")!; return foot.lastElementChild!.id; });
  eq(isLast, "translate", "last control in the Spanish footer");
  await t.p.fill("#es", "   ");
  ok(await b.isDisabled(), "off while the field only has spaces");
  await t.p.fill("#es", ES);
  ok(await b.isEnabled(), "on with text");
  await b.click();
  await waitState(t.p, "translating");
  await waitState(t.p, "ready");
  const r = reqsTo(t, "/api/translate");
  eq(r.length, 1, "translate requests");
  eq(r[0].body.text, ES, "request text");
  has(await val(t.p, "en"), EN_NORMAL, "English");
  eq(await focused(t.p), "es", "focus goes back to the Spanish field");
  ok(await b.isEnabled(), "still on once there is English (it translates again)");
});
check("Translate button", "off while sending; on again when the send fails", async () => {
  const t = await open("send=not-front");
  await translateFlow(t);
  await t.p.click("#send");
  await waitState(t.p, "sending");
  ok(await t.p.locator("#translate").isDisabled(), "off while sending");
  await waitState(t.p, "error");
  ok(await t.p.locator("#translate").isEnabled(), "on again after the failed send");
});
check("Translate button", "the mic stays at one x in idle, typing, translating, ready and sending", async () => {
  const t = await open();
  const mx = () => t.p.evaluate(() => Math.round(document.getElementById("mic")!.getBoundingClientRect().left * 10) / 10);
  const seen: number[] = [await mx()];
  await t.p.fill("#es", ES); seen.push(await mx());
  await t.p.press("#es", "Enter"); await waitState(t.p, "translating"); seen.push(await mx());
  await waitState(t.p, "ready"); seen.push(await mx());
  await t.p.click("#send"); await waitState(t.p, "sending"); seen.push(await mx());
  await waitState(t.p, "sent"); seen.push(await mx());
  ok(seen.every((x) => x === seen[0]), `the mic moved: ${seen.join(", ")}`);
});
check("Translate button", "pressing it while dictating stops the mic and translates what was said", async () => {
  const t = await open();
  await t.p.click("#mic");
  await t.p.waitForFunction(() => (document.getElementById("es") as HTMLTextAreaElement).value.length > 10, null, { timeout: 3000 });
  await t.p.click("#translate");
  await waitState(t.p, "ready", 10000);
  const r = reqsTo(t, "/api/translate");
  eq(r.length, 1, "translate requests");
  ok(ES.startsWith(r[0].body.text), `request text ${JSON.stringify(r[0].body.text)}`);
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "false", "mic pressed");
});

// ===================================================================================== dictation states
check("Dictation", "?dict=prep: 'Getting dictation ready…', then Listening with the bars, then the words", async () => {
  const t = await open("dict=prep");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Getting dictation ready"), null, { timeout: 1200 })
    .catch(() => { throw new Fail("no 'Getting dictation ready…' label"); });
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "true", "mic pressed while preparing");
  ok(!(await vis(t.p, "#dictLabel .wave")), "no bars while preparing");
  eq(await val(t.p, "es"), "", "Spanish box while preparing");
  await expectLayout(t.p);
  await t.p.waitForFunction(() => /ready… \d+%$/.test(document.getElementById("dictLabel")!.textContent!), null, { timeout: 1200 })
    .catch(() => { throw new Fail("no download percent while preparing"); });
  await expectLayout(t.p);
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Listening"), null, { timeout: 3500 })
    .catch(() => { throw new Fail("never changed to Listening"); });
  ok(await vis(t.p, "#dictLabel .wave"), "the bars should show while listening");
  await t.p.waitForFunction((s: string) => (document.getElementById("es") as HTMLTextAreaElement).value === s, ES, { timeout: 6000 })
    .catch(async () => { throw new Fail(`the field ended as ${JSON.stringify(await val(t.p, "es"))}`); });
  eq(await t.p.locator("#dictLabel").innerText(), "", "label at the end");
});
check("Dictation", "?dict=prep: stopping while it prepares listens to nothing", async () => {
  const t = await open("dict=prep");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Getting dictation"), null, { timeout: 1200 });
  await t.p.click("#mic");
  await settle(t.p, 2200);
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "false", "mic pressed");
  eq(await val(t.p, "es"), "", "Spanish box");
  eq(await t.p.locator("#dictLabel").innerText(), "", "label");
});
check("Dictation", "?dict=unavailable: 'Dictation in Español (México) isn't available on this Mac', mic off, nothing typed, fits", async () => {
  const t = await open("dict=unavailable");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("isn't available"), null, { timeout: 2000 })
    .catch(() => { throw new Fail("no 'isn't available' label"); });
  eq(await t.p.locator("#dictLabel").innerText(), "Dictation in Español (México) isn't available on this Mac", "label");
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "false", "mic pressed");
  eq(await val(t.p, "es"), "", "Spanish box");
  await settle(t.p);
  await expectLayout(t.p);
});

// ===================================================================================== the design critique's changes
const boxes = (p: any) => p.evaluate(() => {
  const h = (id: string) => document.getElementById(id)!.getBoundingClientRect().height;
  const cs = getComputedStyle(document.getElementById("es")!);
  return { es: h("es"), en: h("en"), lh: cs.lineHeight, font: cs.fontSize };
});
check("Design", "both text boxes show four whole 20 px lines (80 px); the English shows 50 with Adjust open", async () => {
  const t = await open();
  let b = await boxes(t.p);
  eq(b.es, 80, "Spanish box (idle)"); eq(b.en, 80, "English box (idle)"); eq(b.lh, "20px", "line height"); eq(b.font, "14px", "font size");
  await ready(t, LONG_EN);
  b = await boxes(t.p);
  eq(b.es, 80, "Spanish box (ready)"); eq(b.en, 80, "English box (ready)");
  await t.p.keyboard.press("Meta+k");
  b = await boxes(t.p);
  eq(b.es, 80, "Spanish box (adjust open)"); eq(b.en, 50, "English box (adjust open)");
  await t.p.keyboard.press("Escape");
  await t.p.fill("#en", Array.from({ length: 4 }, (_, i) => `Line ${i + 1}`).join("\n"));
  const lines = await t.p.evaluate(() => { const e = document.getElementById("en") as HTMLTextAreaElement; return { sh: e.scrollHeight, ch: e.clientHeight }; });
  ok(lines.sh <= lines.ch, `four lines should fit with no scroll (${lines.sh} in ${lines.ch})`);
});
check("Design", "the footers line up with and without English, with Adjust open, with a notice and with the menu", async () => {
  const foot = (t: T) => t.p.evaluate(() => ["es", "en"].map((k) => { const r = document.querySelector(`.f.${k} .foot`)!.getBoundingClientRect(); return [r.top, r.height]; }));
  const t = await open();
  const seen: string[] = [JSON.stringify(await foot(t))];
  await ready(t); seen.push(JSON.stringify(await foot(t)));
  await t.p.keyboard.press("Meta+k"); seen.push(JSON.stringify(await foot(t)));
  await t.p.keyboard.press("Escape");
  await t.p.click("#more"); seen.push(JSON.stringify(await foot(t)));
  const [a] = seen;
  const [es, en] = JSON.parse(a);
  eq(es[0], en[0], "idle: footers' y"); eq(es[0], 101, "footers' y"); eq(es[1], 28, "footer height");
  ok(seen.every((x) => x === a), `a footer moved between states: ${seen.join(" | ")}`);
});
check("Design", "shortcut glyphs are fully opaque on Adjust, Shorter, Send and Translate", async () => {
  const t = await open();
  await ready(t);
  await t.p.keyboard.press("Meta+k");
  const r = await t.p.evaluate(() => [...document.querySelectorAll("kbd")].map((k) => {
    let o = 1; for (let a: Element | null = k; a && a !== document.body; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity);
    const rect = k.getBoundingClientRect();
    return { t: k.textContent, o, shown: rect.width > 0 };
  }));
  ok(r.filter((x) => x.shown).length >= 2, `kbd shown: ${JSON.stringify(r)}`);
  for (const x of r.filter((x) => x.shown)) ok(x.o >= 0.99, `"${x.t}" has opacity ${x.o}`);
  await t.p.keyboard.press("Escape");
  const a = await t.p.evaluate(() => [...document.querySelectorAll(".adjust-btn kbd, .send kbd, #translate kbd")].map((k) => getComputedStyle(k).opacity));
  ok(a.length === 3 && a.every((o) => o === "1"), `opacity of the kbd in Adjust, Send, Translate: ${a.join(",")}`);
});
check("Design", "an error notice gives the English box the red surface, the same as a failed translation", async () => {
  const bg = (t: T) => t.p.evaluate(() => getComputedStyle(document.querySelector(".f.en")!).backgroundColor);
  const t1 = await open("send=not-front");
  await translateFlow(t1);
  const readyBg = await bg(t1);
  await t1.p.click("#send");
  await waitState(t1.p, "error");
  await settle(t1.p, 500);
  const sendErr = await bg(t1);
  const t2 = await open();
  await t2.p.fill("#es", "OFFLINE");
  await t2.p.press("#es", "Enter");
  await waitState(t2.p, "error");
  await settle(t2.p, 500);
  const transErr = await bg(t2);
  ok(sendErr !== readyBg, `the box didn't change from ready (${readyBg})`);
  eq(sendErr, transErr, "send-error surface against translate-error surface");
  // And a notice that is not an error doesn't turn it red.
  const t3 = await open("send=no-chat");
  await translateFlow(t3);
  await t3.p.click("#send");
  await t3.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("No chat"), null, { timeout: 3000 });
  await settle(t3.p, 500);
  eq(await state(t3.p), "ready", "state for a gray notice");
});
check("Design", "the caret is the accent, and the ready English box takes a focus tone like the Spanish box", async () => {
  const t = await open();
  const accent = await t.p.evaluate(() => { const d = document.createElement("i"); d.style.color = "var(--color-text-accent)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  const carets = await t.p.evaluate(() => ["es", "en"].map((id) => getComputedStyle(document.getElementById(id)!).caretColor));
  eq(carets[0], accent, "Spanish caret"); eq(carets[1], accent, "English caret");
  await ready(t);
  await t.p.keyboard.press("Meta+k");
  eq(await t.p.evaluate(() => getComputedStyle(document.getElementById("adjIn")!).caretColor), accent, "note field caret");
  await t.p.keyboard.press("Escape");
  const bg = () => t.p.evaluate(() => getComputedStyle(document.querySelector(".f.en")!).backgroundColor);
  await t.p.click("#es"); await settle(t.p, 400);
  const off = await bg();
  await t.p.click("#en"); await settle(t.p, 400);
  const on = await bg();
  ok(on !== off, `the focused English box has the same surface as the unfocused one (${on})`);
  await t.p.click("#es"); await settle(t.p, 400);
  eq(await bg(), off, "English surface after focus leaves");
});
check("Design", "the chat's name keeps 16 px from Send and the language button 16 px from 'To'; Adjust opens the reply's footer at the left, as Normal and Formal open the other one, with the notice after it; with a long chat too", async () => {
  for (const chat of ["Priya Raman", LONG_CHAT]) {
    const t = await open();
    await setTeams(t.p, { ...PRIYA_TEAMS, chat });
    await ready(t);
    await settle(t.p, 150);
    const g = await t.p.evaluate(() => { const r = (id: string) => document.getElementById(id)!.getBoundingClientRect(); return { toSend: r("send").left - r("to").right, langTo: r("to").left - r("lang").right, adjIn: r("adjustBtn").left - (document.querySelector(".f.en") as HTMLElement).getBoundingClientRect().left, segIn: (document.querySelector(".f.es .pseg") as HTMLElement).getBoundingClientRect().left - (document.querySelector(".f.es") as HTMLElement).getBoundingClientRect().left, adjLang: r("lang").left - r("adjustBtn").right }; });
    ok(Math.abs(g.toSend - 16) <= 0.5, `${chat}: the name is ${g.toSend} px from Send, not 16`);
    ok(Math.abs(g.langTo - 16) <= 0.5, `${chat}: the language is ${g.langTo} px from 'To', not 16`);
    ok(Math.abs(g.adjIn - g.segIn) <= 0.5, `${chat}: Adjust is ${g.adjIn} px into its module, Normal and Formal ${g.segIn}`);
    ok(g.adjLang > 24, `${chat}: Adjust should sit apart from the language, at the left (${g.adjLang} px between them)`);
  }
});
check("Design", "the English footer: notice and Adjust buttons 24 px at 12 px, Send 28, the gear last and 28 × 28", async () => {
  const t = await open("teams=closed");
  await translateFlow(t);
  const r = await t.p.evaluate(() => {
    const g = (sel: string) => { const e = document.querySelector(sel) as HTMLElement | null; if (!e) return null; const r = e.getBoundingClientRect(); return { h: r.height, w: r.width, l: r.left, r: r.right, fs: getComputedStyle(e).fontSize }; };
    return { open: g("#actions .btn"), adj: g("#adjustBtn"), send: g("#send"), more: g("#more"), tag: g("#status") };
  });
  ok(r.open && r.adj && r.send && r.more, `a control is missing: ${JSON.stringify(r)}`);
  eq(r.open!.h, 24, "Open Teams height"); eq(r.open!.fs, "12px", "Open Teams font");
  eq(r.adj!.h, 24, "Adjust height"); eq(r.adj!.fs, "12px", "Adjust font");
  eq(r.send!.h, 28, "Send height");
  eq(r.more!.w, 28, "gear width"); eq(r.more!.h, 28, "gear height");
  ok(r.more!.l >= r.send!.r, "the gear should come after Send");
  const order = await t.p.evaluate(() => [...document.querySelector(".f.en .foot")!.children].map((c) => c.id || c.className).join(","));
  ok(order.endsWith("send,more"), `English footer order: ${order}`);
});
check("Design", "a send error beside a long chat name: no Try again, the notice stays whole, the name gives way down to 96 px and keeps its whole text in a title", async () => {
  const t = await open("send=not-front");
  await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false });
  await ready(t);
  const fullName = await t.p.locator("#to").innerText();
  await t.p.click("#send");
  await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("forward"), null, { timeout: 3000 });
  await settle(t.p);
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await state(t.p), "error", "state");
  eq(await t.p.locator("#status").getAttribute("title"), "Teams didn't come forward", "tag title");
  const m = await t.p.evaluate(() => { const to = document.getElementById("to")!, st = document.querySelector("#status > span:not(.sdot)") as HTMLElement; const r = st.getBoundingClientRect(); return { to: to.clientWidth, toFull: to.scrollWidth, tag: r.width, tagFull: st.scrollWidth, text: to.textContent }; });
  ok(m.tag + 0.01 >= m.tagFull, `the notice's words are cut: ${m.tag.toFixed(2)} of ${m.tagFull}px`);
  ok(m.to >= 96, `the chat's name is squeezed below 96px: ${m.to}px`);
  eq(await t.p.locator("#to").getAttribute("title"), LONG_CHAT, "the whole name on hover");
  has(fullName, "Castellanos Moreira", "name");
  await expectLayout(t.p);
  return `name ${m.to} of ${m.toFull} px, notice ${m.tag} of ${m.tagFull} px`;
});
check("Design", "first run: one veil the size of the two boxes, with the sentence at the message text's x; the fields are hidden", async () => {
  const t = await open("access=0");
  const r = await t.p.evaluate(() => {
    const c = document.querySelector(".cover")!.getBoundingClientRect(), s = document.querySelector(".cover span")!.getBoundingClientRect();
    const f1 = document.querySelector(".f.es")!.getBoundingClientRect(), f2 = document.querySelector(".f.en")!.getBoundingClientRect();
    return { c: [c.left, c.top, c.right, c.bottom], span: s.left, boxes: [f1.left, f1.top, f2.right, f1.bottom], fields: getComputedStyle(document.getElementById("fields")!).visibility, bg: getComputedStyle(document.querySelector(".cover")!).backgroundColor, es: document.getElementById("es")!.getBoundingClientRect().left };
  });
  eq(r.c.join(","), r.boxes.join(","), "the veil against the two boxes");
  eq(r.span, r.es, "sentence x against message text x");
  eq(r.fields, "hidden", "fields visibility");
  ok(r.bg !== "rgba(0, 0, 0, 0)", "the veil has a color");
});
check("Design", "the Preview note gives way while the dictation label shows (microphone denied)", async () => {
  const t = await open("mic=denied");
  ok(!(await vis(t.p, "#preview")), "the Preview note should be hidden beside 'Microphone not allowed'");
  const t2 = await open();
  ok(await vis(t2.p, "#preview"), "the Preview note should show when the label is empty");
  await t2.p.click("#mic");
  await t2.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Listening"), null, { timeout: 3000 });
  ok(!(await vis(t2.p, "#preview")), "the Preview note should be hidden while listening");
});

// ===================================================================================== layout
async function ready(t: T, en?: string) {
  await translateFlow(t);
  if (en) await t.p.fill("#en", en);
}
const layoutCases: [string, () => Promise<T>][] = [
  ["idle", async () => open()],
  ["ready, short", async () => { const t = await open(); await ready(t); return t; }],
  ["ready, two lines", async () => { const t = await open(); await ready(t, LONG_EN); return t; }],
  ["ready, two lines, long chat", async () => { const t = await open(); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); await ready(t, LONG_EN); return t; }],
  ["adjust open, two lines", async () => { const t = await open(); await ready(t, LONG_EN); await t.p.keyboard.press("Meta+k"); return t; }],
  ["adjust open, with text in the note", async () => { const t = await open(); await ready(t, LONG_EN); await t.p.keyboard.press("Meta+k"); await t.p.fill("#adjIn", "que suene menos seco y más cercano, sin perder el tono"); return t; }],
  ["adjusted + Undo", async () => { const t = await open(); await ready(t); await t.p.keyboard.press("Meta+k"); await t.p.click("#chip"); await waitState(t.p, "ready"); return t; }],
  ["menu open", async () => { const t = await open(); await ready(t, LONG_EN); await t.p.click("#more"); return t; }],
  ["menu open, idle", async () => { const t = await open(); await t.p.click("#more"); return t; }],
  ["voice check + long chat", async () => { const t = await open(); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); await translateFlow(t, "kindly revisa"); return t; }],
  ["send error notice + long chat", async () => { const t = await open("send=not-front"); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); await ready(t); await t.p.click("#send"); await waitState(t.p, "sending"); await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("forward"), null, { timeout: 3000 }); return t; }],
  ["draft notice + long chat", async () => { const t = await open("send=draft"); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: true }); await ready(t); await t.p.click("#send"); await waitState(t.p, "draft", 3000); return t; }],
  ["out of date + long chat", async () => { const t = await open(); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); await ready(t); await t.p.click("#es"); await t.p.keyboard.type("!"); return t; }],
  ["question", async () => { const t = await open(); await t.p.fill("#es", "UNCLEAR"); await t.p.press("#es", "Enter"); await waitState(t.p, "question"); return t; }],
  ["error offline", async () => { const t = await open(); await t.p.fill("#es", "OFFLINE"); await t.p.press("#es", "Enter"); await waitState(t.p, "error"); return t; }],
  ["plan limit", async () => { const t = await open(); await t.p.fill("#es", "LIMIT"); await t.p.press("#es", "Enter"); await waitState(t.p, "limit"); return t; }],
  ["no voice guide", async () => { const t = await open(); await t.p.fill("#es", "GUIDE"); await t.p.press("#es", "Enter"); await waitState(t.p, "noguide"); return t; }],
  ["translating", async () => { const t = await open(); await t.p.fill("#es", ES); await t.p.press("#es", "Enter"); await waitState(t.p, "translating"); return t; }],
  ["starting", async () => { const t = await open(); await t.p.fill("#es", "STARTING"); await t.p.press("#es", "Enter"); await waitState(t.p, "starting", 3000); return t; }],
  ["sending + long chat", async () => { const t = await open(); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); await ready(t); await t.p.click("#send"); await waitState(t.p, "sending"); return t; }],
  ["sent + long chat", async () => { const t = await open(); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); await ready(t); await t.p.click("#send"); await waitState(t.p, "sent"); return t; }],
  ["dictating", async () => { const t = await open(); await t.p.click("#mic"); await t.p.waitForFunction(() => (document.getElementById("es") as HTMLTextAreaElement).value.length > 20, null, { timeout: 3000 }); return t; }],
  ["mic denied", async () => open("mic=denied")],
  ["mic denied, as in the app (the Preview note hidden)", async () => { const t = await open("mic=denied"); await t.p.evaluate(() => { document.getElementById("preview")!.hidden = true; }); return t; }],
  ["Teams closed, ready", async () => { const t = await open("teams=closed"); await ready(t); return t; }],
  ["written for another chat", async () => { const t = await open(); await ready(t, LONG_EN); await setTeams(t.p, DANIEL_TEAMS); return t; }],
  ["written for a long chat, in another chat with a long name", async () => { const t = await open(); await t.p.evaluate((c: string) => (window as any).strip.teams({ open: true, chat: c, from: "A", last: "B", draft: false, shape: "ok" }), LONG_CHAT); await t.p.fill("#es", ES); await t.p.press("#es", "Enter"); await waitState(t.p, "ready"); await setTeams(t.p, { ...DANIEL_TEAMS, chat: "Okonkwo-Fitzgerald, Bartholomew Jr." }); return t; }],
  ["box not found, ready", async () => { const t = await open("shape=unknown"); await ready(t); return t; }],
  ["box not found, idle", async () => open("shape=unknown")],
  ["sign in", async () => { const t = await open(); await t.p.fill("#es", "LOGIN"); await t.p.press("#es", "Enter"); await waitState(t.p, "login"); return t; }],
  ["install claude", async () => { const t = await open(); await t.p.fill("#es", "NOCLAUDE"); await t.p.press("#es", "Enter"); await waitState(t.p, "login"); return t; }],
  ["needs an update", async () => { const t = await open(); await t.p.fill("#es", "UPDATE"); await t.p.press("#es", "Enter"); await waitState(t.p, "update"); return t; }],
  ["no-paste notice + long chat", async () => { const t = await open("send=no-paste"); await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT }); await ready(t); await t.p.click("#send"); await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("Not sent"), null, { timeout: 3000 }); return t; }],
  ["not-own-server notice + long chat", async () => { const t = await open("send=not-own-server"); await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT }); await ready(t); await t.p.click("#send"); await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("Not sent"), null, { timeout: 3000 }); return t; }],
  ["no chat", async () => open("teams=nochat")],
  ["preview note, long Spanish", async () => { const t = await open(); await t.p.fill("#es", ES + " " + ES + " " + ES); return t; }],
  ["Auto in Portuguese + long chat", async () => { await putSettings({ auto: true }); const t = await open("chat=pt"); await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT, last: "Você consegue revisar o orçamento até quinta?" }); await ready(t, LONG_EN); return t; }],
  ["Auto in Portuguese, a send error notice", async () => { await putSettings({ auto: true }); const t = await open("chat=pt&send=not-front"); await ready(t); await t.p.click("#send"); await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("forward"), null, { timeout: 3000 }); return t; }],
  ["menu open, Auto on, three languages", async () => { await putSettings({ auto: true, languages: ["English", "Português", "Français"] }); const t = await open(); await ready(t); await t.p.click("#more"); return t; }],
  // This Mac's Translation (0.9.0).
  ["menu open, Mac chosen", async () => { const t = await open("model=mac"); await ready(t, LONG_EN); await t.p.click("#more"); return t; }],
  ["a Mac reply + long chat (Adjust off)", async () => { const t = await open("model=mac"); await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT }); await ready(t, LONG_EN); return t; }],
  ["a stand-in reply + long chat", async () => { const t = await open("fallback=offline"); await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT }); await ready(t, LONG_EN); return t; }],
  ["a stand-in reply, Auto in Portuguese + long chat", async () => { await putSettings({ auto: true }); const t = await open("fallback=limit&chat=pt"); await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT, last: "Você consegue revisar o orçamento até quinta?" }); await ready(t, LONG_EN); return t; }],
  ["an unconfirmed send + long chat", async () => { const t = await open("send=unconfirmed"); await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT }); await ready(t, LONG_EN); await t.p.click("#send"); await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("Not confirmed"), null, { timeout: 3000 }); return t; }],
  ["menu open, Auto in Portuguese, a stand-in", async () => { await putSettings({ auto: true }); const t = await open("fallback=offline&chat=pt"); await ready(t, LONG_EN); await t.p.click("#more"); return t; }],
  ["a stand-in reply with a voice finding", async () => { const t = await open("fallback=login"); await translateFlow(t, "kindly revisa"); return t; }],
  ["can't translate on this Mac", async () => { const t = await open("model=mac"); await t.p.fill("#es", "NOMAC"); await t.p.press("#es", "Enter"); await waitState(t.p, "mac"); return t; }],
  ["the language isn't on this Mac", async () => { const t = await open("model=mac"); await t.p.fill("#es", "NOTONMAC"); await t.p.press("#es", "Enter"); await waitState(t.p, "language"); return t; }],
  // Recent messages and the update checks (0.12.0).
  ["menu open, five recent", async () => { const t = await open(); await keepRecent(t, RECENT_EN); await t.p.click("#more"); return t; }],
  ["a recent message brought back + long chat", async () => { const t = await open(); await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT }); await keepRecent(t, [LONG_EN]); await t.p.keyboard.press("Meta+z"); await waitState(t.p, "ready"); return t; }],
  ["Teams changed, idle + long chat", async () => { const t = await open(); await setTeams(t.p, { ...TEAMS_CHANGED, chat: LONG_CHAT }); return t; }],
  ["Claude Code changed, idle, with written text", async () => { const t = await open(); await setClaudeCheck(t.p, CLAUDE_MISSING); await t.p.fill("#es", ES); return t; }],
];
const LAYOUT_CASES = new Set(layoutCases.map(([n]) => n));
for (const [name, mk] of layoutCases) {
  check("Layout", name, async () => {
    try {
      const t = await mk();
      await settle(t.p);
      const info = await expectLayout(t.p);
      return info.length ? info.join("; ") : undefined;
    } finally { await resetSettings(); }
  });
}
// The translation can be copied in every state that shows it, as in the app: body.embed turns
// selection off for the page, and the box is read-only in every state but Ready.
for (const [name, mk] of layoutCases) {
  check("Copy", `${name}: the translation can be selected and copied in the app`, async () => {
    try {
      const t = await mk();
      await settle(t.p);
      const shown = await t.p.evaluate(() => {
        document.body.classList.add("embed");
        const en = document.getElementById("en") as HTMLTextAreaElement;
        const r = en.getBoundingClientRect();
        return getComputedStyle(en).visibility === "visible" && r.width > 0 && en.value.trim().length > 0;
      });
      if (!shown) return "no translation shown in this state";
      // An open menu covers the English's first line since it has three commands (0.10.0): it closes first, as a click outside it would.
      let closed = "";
      if (await vis(t.p, "#menu")) { await t.p.keyboard.press("Escape"); closed = "the menu closed first"; }
      const box = (await t.p.locator("#en").boundingBox())!;
      const picked = () => t.p.evaluate(() => { const en = document.getElementById("en") as HTMLTextAreaElement; return en.value.slice(en.selectionStart, en.selectionEnd); });
      // A few points along the first line, so one lands on a word rather than a space.
      let word = "";
      for (const x of [24, 12, 40, 60, 90]) {
        await t.p.mouse.dblclick(box.x + x, box.y + 12);
        word = await picked();
        if (/\w/.test(word)) break;
      }
      ok(/\w/.test(word), `a double-click should select a word, selected ${JSON.stringify(word)}`);
      await t.p.mouse.move(box.x + 4, box.y + 12);
      await t.p.mouse.down();
      await t.p.mouse.move(box.x + 160, box.y + 12, { steps: 8 });
      await t.p.mouse.up();
      const dragged = await picked();
      ok(dragged.length > word.length, `a drag should select more than a word, selected ${JSON.stringify(dragged)}`);
      await t.p.evaluate(() => { (window as any).__copied = null; document.addEventListener("copy", () => { const en = document.getElementById("en") as HTMLTextAreaElement; (window as any).__copied = en.value.slice(en.selectionStart, en.selectionEnd); }, { once: true }); });
      await t.p.keyboard.press("Meta+c");
      eq(await t.p.evaluate(() => (window as any).__copied), dragged, "⌘C copies the selection");
      return closed || undefined;
    } finally { await resetSettings(); }
  });
}

// A failed translation leaves the English box empty: its notice and button take the box's middle,
// where "Sent to …" shows (in the row, the text area above the footer; in the column, the whole module).
check("Replies", "a failed translation: the notice and Try again sit in the footer, like every notice; the Spanish stays", async () => {
  const t = await open();
  await t.p.fill("#es", "FAILED esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "error");
  await settle(t.p, 150);
  ok(await t.p.evaluate(() => document.getElementById("tagrow")!.parentElement!.classList.contains("foot")), "the notice row should be in the footer");
  eq(await tagText(t.p), "Couldn't translate", "tag");
  eq((await actionLabels(t.p)).join(", "), "Try again", "buttons");
  eq(await val(t.p, "es"), "FAILED esto", "the Spanish stays");
  ok(await vis(t.p, "#to") && await vis(t.p, "#send") && await vis(t.p, "#more"), "the footer keeps To, Send and the gear");
  await expectLayout(t.p);
  await t.p.click("#more");
  ok(await vis(t.p, "#menu"), "the gear should open the menu");
  await t.p.keyboard.press("Escape");
});
check("Design", "a wide strip takes no steps: at 1200, idle, ready and a long chat keep every shortcut hint, Adjust's word and the name", async () => {
  const t = await open();
  eq(await t.p.evaluate(() => document.getElementById("strip")!.dataset.fit), "", "steps when idle");
  await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT });
  await ready(t);
  await settle(t.p, 150);
  eq(await t.p.evaluate(() => document.getElementById("strip")!.dataset.fit), "", "steps when ready with a long chat");
  ok(await vis(t.p, "#adjustBtn .lbl") && await vis(t.p, "#send kbd") && await vis(t.p, "#translate kbd"), "Adjust's word and the hints should show");
});
narrowCheck("Narrow", "ready: the footers give way in steps and everything still shows: Adjust's pencil, To <name>, Send and the gear", async () => {
  const t = await open();
  await ready(t);
  await settle(t.p, 150);
  const fit = await t.p.evaluate(() => document.getElementById("strip")!.dataset.fit);
  has(fit, "keys", "steps");
  ok(!/noname|nonotice|tone/.test(fit), `a short chat shouldn't need the last steps (${fit})`);
  for (const sel of ["#adjustBtn", "#pencil", "#to", "#send", "#more", ".tone"]) ok(await vis(t.p, sel), `${sel} should show`);
  ok(!(await vis(t.p, "#send kbd")), "the shortcut hints should leave first");
  await expectLayout(t.p);
});
narrowCheck("Narrow", "a draft: Add after draft and Cancel stay whole beside Send and the gear; the notice's words and the name give way", async () => {
  const t = await open("send=draft");
  await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: true });
  await ready(t);
  await t.p.click("#send");
  await waitState(t.p, "draft", 3000);
  await settle(t.p, 150);
  eq((await actionLabels(t.p)).join(", "), "Add after draft, Cancel", "buttons");
  const cut = await t.p.evaluate(() => [...document.querySelectorAll("#actions .btn, #send, #more")].filter((b) => b.scrollWidth > (b as HTMLElement).clientWidth + 1 || b.getBoundingClientRect().right > window.innerWidth).map((b) => b.textContent));
  eq(cut.length, 0, `cut or outside: ${cut.join(", ")}`);
  ok(await t.p.evaluate(() => !!document.getElementById("status")!.title), "the notice's words stay in its title");
  await expectLayout(t.p);
});
narrowCheck("Narrow", "microphone denied: Open Settings stays whole; Normal and Formal step aside only while the label needs the room", async () => {
  const t0 = await open();
  ok(await vis(t0.p, ".tone"), "Normal and Formal should show when there's no label");
  const t = await open("mic=denied");
  await settle(t.p, 150);
  ok(await vis(t.p, "#dictLabel [data-act=mic-settings]"), "Open Settings should show");
  ok(await t.p.evaluate(() => { const b = document.querySelector("#dictLabel [data-act=mic-settings]")!; return b.scrollWidth <= (b as HTMLElement).clientWidth + 1; }), "Open Settings shouldn't be cut");
  eq(await t.p.locator("#dictLabel").getAttribute("title"), "Microphone not allowed", "the label's words in its title");
  await expectLayout(t.p);
});
narrowCheck("Narrow", "after a send, 'Sent · time' stays whole in a short footer; the chat's name gives way first", async () => {
  const t = await open();
  await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false });
  await ready(t);
  await t.p.click("#send");
  await waitState(t.p, "sent");
  await settle(t.p, 300);
  const txt = (await tagText(t.p)).replace(/\s+/g, " ").trim();
  ok(/^Sent · \d{1,2}:\d{2} (AM|PM)$/.test(txt), `tag ${JSON.stringify(txt)}`);
  ok(await t.p.evaluate(() => { const w = document.querySelector("#status > span:last-child") as HTMLElement; return w.scrollWidth <= w.clientWidth + 1; }), "the tag shows whole");
  await expectLayout(t.p);
});
narrowCheck("Narrow", "a failed translation: the notice and Try again in the footer, whole", async () => {
  const t = await open();
  await t.p.fill("#es", "OFFLINE esto");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "error");
  await settle(t.p, 150);
  ok(await t.p.evaluate(() => document.getElementById("tagrow")!.parentElement!.classList.contains("foot")), "the notice should be in the footer");
  eq((await actionLabels(t.p)).join(", "), "Try again", "buttons");
  await expectLayout(t.p);
});

check("Layout", "a long message scrolls inside its box and the strip keeps its size", async () => {
  const t = await open();
  await ready(t);
  const many = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a made-up message about the budget.`).join("\n");
  await t.p.fill("#en", many);
  await t.p.fill("#es", many);
  await settle(t.p);
  const m = await t.p.evaluate(() => {
    const en = document.getElementById("en")!, es = document.getElementById("es")!;
    return { enScrolls: en.scrollHeight > en.clientHeight, esScrolls: es.scrollHeight > es.clientHeight, enOverflow: getComputedStyle(en).overflowY, esOverflow: getComputedStyle(es).overflowY };
  });
  ok(m.enScrolls && m.esScrolls, "the boxes should scroll");
  ok(m.enOverflow === "auto" && m.esOverflow === "auto", "the boxes should have overflow auto");
  await expectLayout(t.p);
});
check("Layout", "the English box can be read and edited by keyboard in every state it is editable", async () => {
  const t = await open();
  await ready(t);
  await t.p.click("#en");
  eq(await focused(t.p), "en", "focus");
  eq(await t.p.locator("#en").evaluate((e: any) => e.readOnly), false, "readOnly");
});
check("Page", "no script errors or console errors in any run", async () => {
  ok(!pageErrors.length, `${pageErrors.length} error(s): ${[...new Set(pageErrors)].slice(0, 3).join(" | ")}`);
});


// ===================================================================================== this Mac's Translation (0.9.0)
// The model "mac" (the page's ?model=mac, read by the mock from each request's Referer) and the stand-in (?fallback=<error>).
const offColor = (p: any) => p.evaluate(() => { const d = document.createElement("i"); d.style.color = "var(--color-text-disabled)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
// The tag's words against what's behind them, every surface composited down to the page: the contrast ratio.
const tagContrast = (p: any) => p.evaluate(() => {
  const rgba = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const words = document.querySelector("#status > span:last-child") as HTMLElement;
  const layers: any[] = [];
  for (let e: HTMLElement | null = words; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c.a > 0) layers.push(c); }
  let bg = { r: 0, g: 0, b: 0 };   // under it all, the page's own dark
  for (const l of layers.reverse()) bg = { r: l.r * l.a + bg.r * (1 - l.a), g: l.g * l.a + bg.g * (1 - l.a), b: l.b * l.a + bg.b * (1 - l.a) };
  const fg0 = rgba(getComputedStyle(words).color), fg = { r: fg0.r * fg0.a + bg.r * (1 - fg0.a), g: fg0.g * fg0.a + bg.g * (1 - fg0.a), b: fg0.b * fg0.a + bg.b * (1 - fg0.a) };
  const lum = (c: any) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
});
check("This Mac", "Mac chosen: Normal and Formal are off with their title, a click changes nothing; Translate still works, with no register asked of it", async () => {
  const t = await open("model=mac");
  for (const r of ["normal", "formal"]) {
    const b = t.p.locator(`#tone [data-register=${r}]`);
    eq(await b.getAttribute("aria-disabled"), "true", `${r} aria-disabled`);
    eq(await b.getAttribute("title"), "Formal needs Haiku, Sonnet or Opus", `${r}'s title`);
    eq(await b.evaluate((e: any) => getComputedStyle(e).color), await offColor(t.p), `${r} in the off color`);
  }
  // (force: Playwright won't click what is aria-disabled, and the page must ignore the click itself)
  await t.p.click("#tone [data-register=formal]", { force: true });
  eq(await t.p.locator("#tone [data-register=formal]").getAttribute("aria-pressed"), "false", "Formal stays unpressed");
  await translateFlow(t);
  has(await val(t.p, "en"), EN_NORMAL, "the Mac's translation");
  eq(reqsTo(t, "/api/translate").length, 1, "one translate request");
  await t.p.click("#tone [data-register=formal]", { force: true });
  await settle(t.p, 300);
  eq(reqsTo(t, "/api/translate").length, 1, "Formal asks nothing again");
  const t2 = await open();
  eq(await t2.p.locator("#tone [data-register=formal]").getAttribute("aria-disabled"), null, "with Sonnet, Formal is on");
});
check("This Mac", "a Mac reply: Adjust shows but is off, with its title; a click and ⌘K open nothing and ask nothing; Send still sends", async () => {
  const t = await open("model=mac");
  await translateFlow(t);
  ok(await vis(t.p, "#adjustBtn"), "Adjust should show");
  eq(await t.p.locator("#adjustBtn").getAttribute("aria-disabled"), "true", "Adjust aria-disabled");
  eq(await t.p.locator("#adjustBtn").getAttribute("title"), "Adjust needs Haiku, Sonnet or Opus", "Adjust's title");
  eq(await t.p.locator("#adjustBtn").evaluate((e: any) => getComputedStyle(e).color), await offColor(t.p), "Adjust in the off color");
  await t.p.click("#adjustBtn", { force: true });
  await t.p.keyboard.press("Meta+k");
  await settle(t.p, 200);
  ok(!(await vis(t.p, ".adjust-row")), "the note row should stay closed");
  eq(reqsTo(t, "/api/adjust").length, 0, "adjust requests");
  eq(await t.p.locator("#status").innerText(), "", "a plain Mac reply has no tag");
  ok(await t.p.locator("#send").isEnabled(), "Send should be on");
  await t.p.click("#send");
  await waitState(t.p, "sent");
  // After the send, a Claude model's reply has its Adjust back.
  const t2 = await open();
  await translateFlow(t2);
  eq(await t2.p.locator("#adjustBtn").getAttribute("aria-disabled"), "false", "Adjust on with Sonnet");
  eq(await t2.p.locator("#adjustBtn").getAttribute("title"), "Adjust ⌘K", "Adjust's own title");
});
check("This Mac", "a Mac reply's language button still writes it in the target, once", async () => {
  await putSettings({ auto: true });
  try {
    const t = await open("model=mac&chat=pt");
    await translateFlow(t);
    eq(await t.p.locator("#langName").innerText(), "Português", "the chat's language");
    eq(await t.p.locator("#lang").getAttribute("aria-disabled"), "false", "the button works");
    await t.p.click("#lang");
    await waitState(t.p, "ready");
    await t.p.waitForFunction(() => document.getElementById("langName")!.textContent === "English", null, { timeout: 3000 });
    eq(reqsTo(t, "/api/translate")[1]?.body?.target, "English", "the one-time target");
    has(await val(t.p, "en"), EN_NORMAL, "the English");
  } finally { await resetSettings(); }
});
const FALLBACKS: [string, string | RegExp][] = [
  ["offline", "Claude couldn't be reached, so this Mac translated it, without your voice guide."],
  ["limit", /^Claude's plan limit was reached until (\w{3} )?\d{1,2}:\d{2}\s?[AP]M, so this Mac translated it, without your voice guide\.$/],
  ["login", "Claude Code isn't signed in, so this Mac translated it, without your voice guide."],
  ["update", "Claude Code needs an update, so this Mac translated it, without your voice guide."],
  ["missing", "Claude Code isn't installed, so this Mac translated it, without your voice guide."],
  ["failed", "Claude didn't answer, so this Mac translated it, without your voice guide."],
];
for (const [why, title] of FALLBACKS) {
  check("This Mac", `a stand-in after ${why}: a gray "Translated on this Mac" tag with the still dot, its title says why; Adjust off, Send on`, async () => {
    const t = await open(`fallback=${why}`);
    await translateFlow(t);
    eq(await tagText(t.p), "Translated on this Mac", "the tag");
    const tag = await t.p.evaluate(() => { const s = document.getElementById("status")!; return { cls: s.className, title: s.title, dot: !!s.querySelector(".sdot") }; });
    ok(/\bs-info\b/.test(tag.cls) && /\bs-idle\b/.test(tag.cls), `the tag's kind: ${tag.cls}`);
    ok(tag.dot, "the still dot");
    if (typeof title === "string") eq(tag.title, title, "the tag's title"); else ok(title.test(tag.title), `the tag's title: ${JSON.stringify(tag.title)}`);
    const c = await tagContrast(t.p);
    ok(c >= 4.5, `the tag's words reach ${c.toFixed(2)}:1, under 4.5:1`);
    eq(await state(t.p), "ready", "data-state");
    eq((await actionLabels(t.p)).join(","), why === "limit" ? "" : "Try Claude again", "the tag's buttons (none while the plan limit lasts)");
    eq(await t.p.locator("#adjustBtn").getAttribute("aria-disabled"), "true", "Adjust off");
    ok(await t.p.locator("#send").isEnabled(), "Send on");
    eq(await t.p.locator("#tone [data-register=formal]").getAttribute("aria-disabled"), null, "Normal and Formal stay on: the model is still Claude's");
    return `contrast ${c.toFixed(2)}:1`;
  });
}
check("This Mac", "a stand-in with a voice finding: the stand-in's tag stays, the finding joins its title", async () => {
  const t = await open("fallback=offline");
  await translateFlow(t, "kindly revisa");
  eq(await tagText(t.p), "Translated on this Mac", "the tag");
  eq(await t.p.locator("#status").getAttribute("title"), "Claude couldn't be reached, so this Mac translated it, without your voice guide.\n\"Kindly\" sounds stiff", "the title");
});
check("This Mac", "Can't translate on this Mac: a gray tag with its title, no button; Translate stays on", async () => {
  const t = await open("model=mac");
  await t.p.fill("#es", "NOMAC");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "mac");
  eq(await tagText(t.p), "Can't translate on this Mac", "the tag");
  eq(await t.p.locator("#status").getAttribute("title"), "Needs macOS 26 or later.", "the title");
  ok(/\bs-idle\b/.test(await t.p.locator("#status").getAttribute("class")), "a gray tag");
  eq((await actionLabels(t.p)).join(","), "", "no buttons");
  ok(await t.p.locator("#translate").isEnabled(), "Translate on");
});
check("This Mac", "a language that isn't on this Mac: '<source> to <language> isn't on this Mac' with its title, and Try again asks again", async () => {
  const t = await open("model=mac");
  await t.p.fill("#es", "NOTONMAC");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "language");
  eq(await tagText(t.p), "Español to 日本語 isn't on this Mac", "the tag");
  eq(await t.p.locator("#status").getAttribute("title"), "Download it in System Settings, General, Language & Region, Translation Languages.", "the title");
  eq((await actionLabels(t.p)).join(","), "Try again", "buttons");
  await t.p.click("#actions button");
  await waitState(t.p, "language");
  eq(reqsTo(t, "/api/translate").length, 2, "Try again asks again");
});
check("This Mac", "a Claude error in the server's state doesn't keep Translate off, and an empty strip says nothing of it", async () => {
  const t = await open();
  for (const error of ["offline", "limit", "login", "update", "missing", "failed"]) {
    await t.p.evaluate((error: string) => { (0, eval)(`srv = Object.assign({}, srv, { translator: Object.assign({}, srv.translator, { status: "error", error: ${JSON.stringify(error)} }) }); paint();`); }, error);
    await t.p.fill("#es", "");
    eq(await t.p.locator("#status").innerText(), "", `${error}: no tag on an empty strip`);
    await t.p.fill("#es", ES);
    ok(await t.p.locator("#translate").isEnabled(), `${error}: Translate on`);
  }
  await t.p.press("#es", "Enter");
  await waitState(t.p, "ready");
});

// ===================================================================================== six quick fixes (0.10.0)
// Text against what's behind it, every surface composited down to the page: the contrast ratio of `sel`.
const contrastOf = (p: any, sel: string, placeholder = false) => p.evaluate(([sel, ph]: [string, boolean]) => {
  const rgba = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const el = document.querySelector(sel) as HTMLElement;
  const layers: any[] = [];
  for (let e: HTMLElement | null = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c.a > 0) layers.push(c); }
  let bg = { r: 0, g: 0, b: 0 };
  for (const l of layers.reverse()) bg = { r: l.r * l.a + bg.r * (1 - l.a), g: l.g * l.a + bg.g * (1 - l.a), b: l.b * l.a + bg.b * (1 - l.a) };
  const fg0 = rgba(getComputedStyle(el, ph ? "::placeholder" : null).color), fg = { r: fg0.r * fg0.a + bg.r * (1 - fg0.a), g: fg0.g * fg0.a + bg.g * (1 - fg0.a), b: fg0.b * fg0.a + bg.b * (1 - fg0.a) };
  const lum = (c: any) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}, [sel, placeholder]);
const notConfirmedTitle = "Teams emptied its box, but the strip couldn't see the chat to check the message is there.";

check("Settings menu", "the gear is named 'Options'; its third command, 'Settings…' with ⌘, at its right in secondary text, posts open settings and closes the menu", async () => {
  const t = await open();
  eq(await t.p.locator("#more").getAttribute("aria-label"), "Options", "the gear's label");
  eq(await t.p.locator("#more").getAttribute("title"), "Options", "the gear's title");
  await t.p.click("#more");
  eq((await t.p.locator("#menu [data-do]").evaluateAll((bs: any[]) => bs.map((b) => b.dataset.do))).join(","), "guide,restart,settings", "the commands, in order");
  const item = t.p.locator("#menu [data-do=settings]");
  eq(await item.getAttribute("role"), "menuitem", "its role");
  eq((await item.innerText()).replace(/\s+/g, " ").trim(), "Settings… ⌘,", "its words");
  eq(await item.locator("kbd").innerText(), "⌘,", "the shortcut beside it");
  const r = await t.p.evaluate(() => {
    const b = document.querySelector("#menu [data-do=settings]") as HTMLElement, k = b.querySelector("kbd")!;
    const br = b.getBoundingClientRect(), kr = k.getBoundingClientRect(), d = document.createElement("i");
    d.style.color = "var(--color-text-secondary)"; document.body.append(d); const sec = getComputedStyle(d).color; d.remove();
    return { right: br.right - kr.right, color: getComputedStyle(k).color, sec, cut: b.scrollWidth > b.clientWidth + 1, h: br.height };
  });
  ok(r.right <= 9, `⌘, should sit at the item's right end (${r.right} px from it)`);
  eq(r.color, r.sec, "⌘, in secondary text");
  ok(!r.cut, "the item shouldn't be cut");
  const c = await contrastOf(t.p, "#menu [data-do=settings] kbd");
  ok(c >= 4.5, `⌘, reaches ${c.toFixed(2)}:1, under 4.5:1`);
  await expectLayout(t.p);
  await item.click();
  eq((await opens(t, "settings")).length, 1, "open settings messages");
  ok(!(await vis(t.p, "#menu")), "the menu should close");
  eq(await t.p.locator("#more").getAttribute("aria-expanded"), "false", "aria-expanded after");
  // From the keyboard too: the menu's items are buttons, so Return on it does the same.
  await t.p.click("#more");
  await t.p.focus("#menu [data-do=settings]");
  await t.p.keyboard.press("Enter");
  eq((await opens(t, "settings")).length, 2, "open settings messages after Return");
  ok(!(await vis(t.p, "#menu")), "the menu should close again");
  return `⌘, at ${c.toFixed(2)}:1`;
});
check("Send reasons", "unconfirmed: 'Not confirmed. Check the chat' with its title, no button, red box; both texts stay and Send works again", async () => {
  const t = await failedSend("unconfirmed");
  eq(await tagText(t.p), "Not confirmed. Check the chat", "tag");
  eq(await t.p.locator("#status").getAttribute("title"), notConfirmedTitle, "its title");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  eq(await state(t.p), "error", "state");
  ok(await t.p.evaluate(() => !!document.querySelector("#status .ico svg")), "an error tag has its icon");
  eq(await val(t.p, "es"), ES, "the Spanish stays");
  ok((await val(t.p, "en")).length > 0, "the English stays");
  const c = await contrastOf(t.p, "#status > span:last-child");
  ok(c >= 4.5, `the notice reaches ${c.toFixed(2)}:1, under 4.5:1`);
  await expectLayout(t.p);
  ok(await t.p.locator("#send").isEnabled(), "Send should be on");
  await t.p.click("#send");
  await waitState(t.p, "sending");
  eq((await sends(t)).length, 2, "send messages");
  return `contrast ${c.toFixed(2)}:1`;
});
check("This Mac", "Try Claude again on a stand-in: the same request again; while Claude still can't, the Mac stands in again; once it can, Claude's reply drops the tag and Adjust is back", async () => {
  const t = await open("fallback=offline");
  await translateFlow(t);
  eq(await tagText(t.p), "Translated on this Mac", "the tag");
  eq((await actionLabels(t.p)).join(","), "Try Claude again", "the tag's button");
  ok(await t.p.evaluate(() => { const b = document.querySelector("#actions [data-act=retry-claude]") as HTMLElement; return b.classList.contains("btn") && b.classList.contains("small"); }), "the design system's small button");
  await t.p.click("#actions [data-act=retry-claude]");
  await t.p.waitForFunction(() => document.getElementById("strip")!.dataset.state === "translating" || document.querySelectorAll("#actions button").length === 1, null, { timeout: 3000 }).catch(() => {});
  await waitState(t.p, "ready");
  await settle(t.p, 200);
  let rs = reqsTo(t, "/api/translate");
  eq(rs.length, 2, "translate requests after the first click");
  eq(JSON.stringify(rs[1].body), JSON.stringify(rs[0].body), "the same request again (no target, no flag)");
  eq(await tagText(t.p), "Translated on this Mac", "the Mac stood in again");
  eq((await actionLabels(t.p)).join(","), "Try Claude again", "the button stays");
  // Claude is back: the next answer is Claude's (the mock would stand in again for this page's ?fallback).
  const CLAUDE_EN = "Could you look over the budget before Thursday? We can go through it on the call.";
  await t.p.route("**/api/translate", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: CLAUDE_EN, language: "English", from: "target", lint: [], engine: "claude" }) }));
  await t.p.click("#actions [data-act=retry-claude]");
  await t.p.waitForFunction((x: string) => (document.getElementById("en") as HTMLTextAreaElement).value === x, CLAUDE_EN, { timeout: 4000 }).catch(() => { throw new Fail("Claude's reply never showed"); });
  rs = reqsTo(t, "/api/translate");
  eq(rs.length, 3, "translate requests");
  eq(JSON.stringify(rs[2].body), JSON.stringify(rs[0].body), "the same request a third time");
  eq(await state(t.p), "ready", "state");
  eq(await tagText(t.p), "", "no stand-in tag");
  eq((await actionLabels(t.p)).length, 0, "no button");
  eq(await t.p.locator("#adjustBtn").getAttribute("aria-disabled"), "false", "Adjust on");
});
check("This Mac", "no Try Claude again after the plan limit, nor once Mac is the model chosen", async () => {
  const t = await open("fallback=limit");
  await translateFlow(t);
  eq(await tagText(t.p), "Translated on this Mac", "the tag after the limit");
  eq((await actionLabels(t.p)).length, 0, "no button while the limit lasts");
  const t2 = await open("fallback=offline");
  await translateFlow(t2);
  eq((await actionLabels(t2.p)).join(","), "Try Claude again", "the button");
  await t2.p.evaluate(() => { (0, eval)(`srv = Object.assign({}, srv, { settings: Object.assign({}, srv.settings, { model: "mac" }) }); paint();`); });
  eq((await actionLabels(t2.p)).length, 0, "no button once Mac is chosen");
});
narrowCheck("This Mac", "a stand-in at 640: Try Claude again stays whole beside the language, To, Send and the gear; the notice's words give way", async () => {
  const t = await open("fallback=offline");
  await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT });
  await ready(t, LONG_EN);
  await settle(t.p, 150);
  const cut = await t.p.evaluate(() => [...document.querySelectorAll("#actions .btn, #send, #more")].filter((b) => b.scrollWidth > (b as HTMLElement).clientWidth + 1 || b.getBoundingClientRect().right > window.innerWidth).map((b) => b.textContent));
  eq(cut.length, 0, `cut or outside: ${cut.join(", ")}`);
  ok(await vis(t.p, "#actions [data-act=retry-claude]"), "Try Claude again should show");
  eq(await t.p.locator("#status").getAttribute("title"), "Claude couldn't be reached, so this Mac translated it, without your voice guide.", "the tag's title keeps its words");
  await expectLayout(t.p);
  return `steps: ${await t.p.evaluate(() => document.getElementById("strip")!.dataset.fit)}`;
});
narrowCheck("Language", "a language button that does nothing (Auto off, the reply in the target) leaves before the notice's words shorten", async () => {
  const t = await open("send=not-front");
  await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT });
  await ready(t, LONG_EN);
  eq((await langOf(t.p)).disabled, "true", "the button does nothing");
  await t.p.click("#send");
  await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("forward"), null, { timeout: 4000 });
  await settle(t.p, 150);
  const fit: string = await t.p.evaluate(() => document.getElementById("strip")!.dataset.fit);
  const steps = fit.split(" ");
  ok(steps.includes("nolang"), `the language button should leave (steps: ${fit})`);
  ok(!(await langOf(t.p)).shown, "the language button is gone");
  for (const later of ["name", "noname", "nonotice"]) if (steps.includes(later)) ok(steps.indexOf("nolang") < steps.indexOf(later), `it should leave before ${later} (steps: ${fit})`);
  const words = await t.p.evaluate(() => { const w = document.querySelector("#status > span:last-child") as HTMLElement; return { whole: w.scrollWidth <= w.clientWidth + 1, shown: w.getBoundingClientRect().width > 0 }; });
  ok(words.shown, "the notice's words show");
  await expectLayout(t.p);
  return `steps: ${fit}; the notice's words ${words.whole ? "whole" : "end in an ellipsis"}`;
});
narrowCheck("Language", "a language button that can be clicked keeps today's steps: it stays while the notice's words shorten", async () => {
  await putSettings({ target: "Português" });
  try {
    const t = await open();
    await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT });
    await ready(t);
    await putSettings({ target: "English" });
    await t.p.waitForFunction(() => document.getElementById("lang")!.getAttribute("aria-disabled") === "false", null, { timeout: 3000 }).catch(() => { throw new Fail("the Portuguese reply's button never turned clickable"); });
    await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT, shape: "several" });   // a notice: "Click the box in Teams first"
    await settle(t.p, 150);
    eq(await tagText(t.p), "Click the box in Teams first", "the notice");
    const fit: string = await t.p.evaluate(() => document.getElementById("strip")!.dataset.fit);
    const steps = fit.split(" ");
    if (steps.includes("nolang")) ok(steps.includes("noname") && steps.indexOf("nolang") > steps.indexOf("noname"), `a clickable button should leave only after the name (steps: ${fit})`);
    else ok((await langOf(t.p)).shown, "the button stays");
    await expectLayout(t.p);
    return `steps: ${fit}`;
  } finally { await resetSettings(); }
});
check("Replies", "a voice finding's tag has Fix it, which asks for an adjust naming the finding and changing only it", async () => {
  const t = await open();
  await translateFlow(t, "kindly revisa");
  const fix = t.p.locator('#actions [data-act="fix-voice"]');
  eq(await fix.innerText(), "Fix it", "the button");
  const before = reqsTo(t, "/api/adjust").length;
  await fix.click();
  await settle(t.p, 600);
  const asked = reqsTo(t, "/api/adjust").slice(before);
  eq(asked.length, 1, "one adjust asked");
  ok(String(asked[0]?.body?.note).includes("\"Kindly\" sounds stiff") && String(asked[0]?.body?.note).startsWith("The user's voice guide rules this out"), `the note names the finding (${asked[0]?.body?.note})`);
  await expectLayout(t.p);
});
check("Replies", "the empty reply box shows the target's name, in secondary text at 4.5:1, on one line; its name stays 'Translation'", async () => {
  const t = await open();
  eq(await t.p.locator("#en").getAttribute("placeholder"), "English", "placeholder");
  eq(await t.p.locator("#en").getAttribute("aria-label"), "Translation", "accessible name");
  const c = await contrastOf(t.p, "#en", true);
  ok(c >= 4.5, `the placeholder reaches ${c.toFixed(2)}:1, under 4.5:1`);
  const fits = await t.p.evaluate(() => {
    const e = document.getElementById("en") as HTMLTextAreaElement, cs = getComputedStyle(e), m = document.createElement("span");
    m.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font}`; m.textContent = e.placeholder; document.body.append(m);
    const w = m.getBoundingClientRect().width; m.remove();
    return { w, box: e.clientWidth };
  });
  ok(fits.w <= fits.box, `the placeholder should fit one line (${Math.round(fits.w)} in ${fits.box} px)`);
  // What you type there is the message: Send turns on.
  await t.p.fill("#en", "See you on the call.");
  ok(await t.p.locator("#send").isEnabled(), "Send on with typed text");
  return `contrast ${c.toFixed(2)}:1; ${Math.round(fits.w)} of ${fits.box} px`;
});

// ===================================================================================== recent messages and the update checks (0.12.0)
// Replies left in the strip's memory: five made-up ones, the oldest first.
const RECENT_EN = ["The numbers look right to me now, thanks for checking.", "Sure", "Thanks, that works for me.", "Can we move the call to Friday afternoon?", LONG_EN];
// Their buttons' words, newest first: the reply's first words, about 24 characters, then "…".
const RECENT_LABELS = ["I went through the…", "Can we move the call to…", "Thanks, that works for…", "Sure", "The numbers look right…"];
// Each reply translated, set in the reply box, then cleared with Esc (the last one sent instead, with sendLast).
async function keepRecent(t: T, replies: string[], sendLast = false) {
  for (let i = 0; i < replies.length; i++) {
    await translateFlow(t, `${ES} ${i + 1}`);
    await t.p.fill("#en", replies[i]);
    if (sendLast && i === replies.length - 1) { await t.p.click("#send"); await waitState(t.p, "sent"); }
    else { await t.p.keyboard.press("Escape"); await waitState(t.p, "idle"); }
  }
}
// What the page keeps (st is its own top-level binding) and the Recent row's buttons.
const recentList = (p: any): Promise<string[]> => p.evaluate("st.recent.map((r) => r.en)");
const recentButtons = (p: any) => p.locator("#recentBtns button").evaluateAll((bs: any[]) => bs.map((b) => ({ text: b.textContent, title: b.title, role: b.getAttribute("role") })));
const TEAMS_CHANGED = { ...PRIYA_TEAMS, check: "changed", missing: ["box"] };
const CLAUDE_MISSING = ["--input-format", "--strict-mcp-config"];
// The server's Claude Code check, as /api/state would carry it (the page mock on 4813 may predate its ?claude=changed).
const setClaudeCheck = (p: any, missing: string[]) =>
  p.evaluate(`(() => { srv = Object.assign({}, srv, { translator: Object.assign({}, srv.translator, { check: "changed", missing: ${JSON.stringify(missing)} }) }); paint(); })()`);
const CLOCK = /^\d{1,2}:\d{2}\s[AP]M$/;

check("Recent", "Esc with a reply keeps it; ⌘Z with both boxes empty brings it back in its boxes, ready for its chat, and it leaves the list", async () => {
  const t = await open();
  await keepRecent(t, ["See you on the call."]);
  eq(await val(t.p, "en"), "", "Esc emptied the reply box");
  eq((await recentList(t.p)).join("|"), "See you on the call.", "kept");
  await t.p.keyboard.press("Meta+z");
  await waitState(t.p, "ready");
  eq(await val(t.p, "es"), `${ES} 1`, "the written text is back");
  eq(await val(t.p, "en"), "See you on the call.", "the reply is back");
  eq(await t.p.locator("#chat").innerText(), "Priya Raman", "To");
  ok(await t.p.locator("#send").isEnabled(), "Send should be on");
  eq(await focused(t.p), "es", "focus");
  eq((await recentList(t.p)).length, 0, "it left the list");
  eq(reqsTo(t, "/api/translate").length, 1, "nothing asked of the server again");
  await t.p.keyboard.press("Meta+Enter");
  await waitState(t.p, "sent");
  eq((await sends(t)).map((m) => m.text).join("|"), "See you on the call.", "⌘⏎ sends what came back");
  eq((await recentList(t.p)).join("|"), "See you on the call.", "the send keeps it again");
});
check("Recent", "⌘Z with text in a box is the box's own undo: nothing comes back, and the list keeps it", async () => {
  const t = await open();
  await keepRecent(t, ["See you on the call."]);
  await t.p.click("#es");
  await t.p.keyboard.type("Hola");
  await t.p.keyboard.press("Meta+z");
  await settle(t.p, 200);
  // (What WebKit's own undo does to the boxes is its business: the recent message didn't come back, so it stays listed.)
  ok((await val(t.p, "en")) !== "See you on the call.", "the recent reply doesn't come back");
  eq((await recentList(t.p)).length, 1, "the list keeps it");
});
check("Recent", "the Options menu: no Recent row with an empty list; after a confirmed send, one button with the reply's first words, 'Sent to <chat> at <time>' its title; a click brings it back and closes the menu", async () => {
  const t = await open();
  await t.p.click("#more");
  ok(!(await vis(t.p, "#recentRow")), "no Recent row with an empty list");
  eq(await t.p.locator("#menu button").count(), 17, "menu items");
  await t.p.keyboard.press("Escape");
  await keepRecent(t, [LONG_EN], true);
  await t.p.click("#more");
  ok(await vis(t.p, "#recentRow"), "the Recent row");
  eq(await t.p.locator("#recentLabel").innerText(), "Recent", "its label");
  const b = await recentButtons(t.p);
  eq(b.length, 1, "buttons");
  eq(b[0].text, "I went through the…", "its words");
  eq(b[0].role, "menuitem", "its role");
  ok(/^Sent to Priya Raman at /.test(b[0].title) && CLOCK.test(b[0].title.replace(/^Sent to Priya Raman at /, "")), `its title: ${b[0].title}`);
  const c = await contrastOf(t.p, "#recentBtns button");
  ok(c >= 4.5, `the button reaches ${c.toFixed(2)}:1, under 4.5:1`);
  await expectLayout(t.p);
  await t.p.click("#recentBtns button");
  ok(!(await vis(t.p, "#menu")), "the menu closes");
  await waitState(t.p, "ready");
  eq(await val(t.p, "en"), LONG_EN, "the reply is back");
  eq(await val(t.p, "es"), `${ES} 1`, "the written text is back");
  await t.p.click("#more");
  ok(!(await vis(t.p, "#recentRow")), "it left the list, so the row is gone");
  eq((await sends(t)).length, 1, "one send, nothing more");
  return `contrast ${c.toFixed(2)}:1`;
});
check("Recent", "five at most, newest first: a sixth drops the oldest; the row fits the menu and every button can be reached; nothing goes to the server or the shell", async () => {
  const t = await open();
  await keepRecent(t, ["The first one, gone by the end.", ...RECENT_EN]);
  await t.p.click("#more");
  const b = await recentButtons(t.p);
  eq(b.map((x: any) => x.text).join(" | "), RECENT_LABELS.join(" | "), "the buttons, newest first");
  ok(b.every((x: any) => /^Cleared at /.test(x.title)), `their titles: ${b.map((x: any) => x.title).join(", ")}`);
  await expectLayout(t.p);
  await t.p.locator("#recentBtns button").last().click();
  ok(!(await vis(t.p, "#menu")), "the menu closes");
  await waitState(t.p, "ready");
  eq(await val(t.p, "en"), RECENT_EN[0], "the oldest of the five came back");
  eq(reqsTo(t, "/api/translate").length, 6, "the six translations are all the server heard");
  eq(t.reqs.filter((r) => r.path !== "/api/translate").length, 0, "no other request");
  eq((await t.msgs()).filter((m) => !["detect"].includes(m.type)).length, 0, "nothing told to the shell but the language checks");
});
check("Recent", "a click with a reply on show keeps that one first, as Esc would", async () => {
  const t = await open();
  await keepRecent(t, ["See you on the call."]);
  await translateFlow(t, "Otro mensaje");
  await t.p.fill("#en", "A different reply.");
  await t.p.click("#more");
  await t.p.click("#recentBtns button");
  await waitState(t.p, "ready");
  eq(await val(t.p, "en"), "See you on the call.", "the picked one is back");
  eq((await recentList(t.p)).join("|"), "A different reply.", "the one on show was kept");
});
check("Recent", "one written for another chat comes back as Written for it, with Send off", async () => {
  const t = await open();
  await keepRecent(t, ["See you on the call."]);
  await setTeams(t.p, DANIEL_TEAMS);
  await t.p.keyboard.press("Meta+z");
  await waitState(t.p, "written");
  eq(await tagText(t.p), "Written for Priya Raman", "tag");
  ok(await t.p.locator("#send").isDisabled(), "Send should be off");
  await expectLayout(t.p);
});
check("Recent", "a reload forgets them", async () => {
  const t = await open();
  await keepRecent(t, ["See you on the call."]);
  await t.p.reload();
  await t.p.waitForFunction("(() => { try { return !!srv && st.teams !== null; } catch (e) { return false; } })()", null, { timeout: 8000 });
  await t.p.keyboard.press("Meta+z");
  await settle(t.p, 200);
  eq(await val(t.p, "en"), "", "nothing comes back");
  await t.p.click("#more");
  ok(!(await vis(t.p, "#recentRow")), "no Recent row");
});
narrowCheck("Recent", "under 720 wide, with Recent the menu opens left of the gear, whole and inside the window, and every recent button can be reached; at 110 tall it scrolls inside the window", async () => {
  const t = await open();
  await keepRecent(t, RECENT_EN);
  for (const h of [145, 110]) {
    await t.p.setViewportSize({ width: 640, height: h });
    await t.p.click("#more");
    await settle(t.p, 150);
    const m = await rect(t.p, "#menu"), gear = await rect(t.p, "#more");
    ok(m.l >= 0 && m.t >= 0 && m.r <= 640 && m.b <= h, `640 × ${h}: the menu leaves the window (${JSON.stringify(m)})`);
    ok(m.r <= gear.l || m.b <= gear.t, `640 × ${h}: the menu covers the gear`);
    const cut = await t.p.evaluate(() => [...document.querySelectorAll("#menu button, #menu .pl")].filter((e) => e.getBoundingClientRect().width > 0 && e.scrollWidth > (e as HTMLElement).clientWidth + 1).map((e) => e.textContent!.trim()));
    eq(cut.length, 0, `640 × ${h}: cut in the menu: ${cut.join(", ")}`);
    if (h === 145) await expectLayout(t.p);
    const oldest = (await recentList(t.p)).pop();
    await t.p.locator("#recentBtns button").last().click();
    await waitState(t.p, "ready");
    eq(await val(t.p, "en"), oldest, `640 × ${h}: the last button brought back the oldest`);
    await t.p.keyboard.press("Escape");
    await waitState(t.p, "idle");
  }
});

colCheck("Recent", "in the column, Recent is the settings' last row, its label in line with the others and the commands, the menu whole over the English module", async () => {
  const t = await open();
  await keepRecent(t, RECENT_EN);
  await t.p.click("#more");
  eq((await t.p.locator("#menu .pl").allInnerTexts()).join(", "), "On ⌘⏎, Model, Reply in, Position, Recent", "the settings' rows");
  const lefts = await t.p.evaluate(() => [...document.querySelectorAll("#menu .pl, #menu [data-do]")].map((e) => { const rg = document.createRange(); rg.selectNodeContents(e); return Math.round(rg.getBoundingClientRect().left); }));
  ok(new Set(lefts).size === 1, `the labels and the commands should start in one line: ${lefts.join(", ")}`);
  const row = await rect(t.p, "#recentRow"), pos = await rect(t.p, "#menu .prow.position"), cmd = await rect(t.p, "#menu [data-do=guide]");
  ok(row.t >= pos.b && row.b <= cmd.t, `Recent should sit after Position, before the commands (${JSON.stringify([pos, row, cmd])})`);
  await expectLayout(t.p);
});
check("Update check", "Teams changed: while idle, an orange tag 'Teams changed. Sending may fail' with what moved in its title, at 4.5:1; gone once there's a reply, and Send still works", async () => {
  const t = await open();
  await setTeams(t.p, { ...PRIYA_TEAMS, check: "changed", missing: ["box", "list"] });
  eq(await tagText(t.p), "Teams changed. Sending may fail", "tag");
  eq(await t.p.locator("#status").getAttribute("title"), "This version of Teams moved something the strip reads: the message box and the message list. Sends may stop; the strip needs an update.", "its title");
  ok(await t.p.evaluate(() => document.getElementById("status")!.classList.contains("s-needs")), "orange (s-needs)");
  eq((await actionLabels(t.p)).length, 0, "buttons");
  const c = await contrastOf(t.p, "#status > span:last-child");
  ok(c >= 4.5, `the tag reaches ${c.toFixed(2)}:1, under 4.5:1`);
  await expectLayout(t.p);
  await translateFlow(t);
  eq(await tagText(t.p), "", "no tag over a reply");
  ok(await t.p.locator("#send").isEnabled(), "Send should be on");
  await setTeams(t.p, { ...PRIYA_TEAMS, check: "ok" });
  await t.p.keyboard.press("Escape");
  eq(await tagText(t.p), "", "checked ok: no tag");
  // The browser preview's flag shows it too.
  const t2 = await open("check=changed");
  eq(await tagText(t2.p), "Teams changed. Sending may fail", "?check=changed");
  return `contrast ${c.toFixed(2)}:1`;
});
check("Update check", "Claude Code changed: while idle, the orange tag 'Claude Code changed. The strip may fail', the missing flags in its title; none with this Mac's model", async () => {
  const t = await open();
  await setClaudeCheck(t.p, CLAUDE_MISSING);
  eq(await tagText(t.p), "Claude Code changed. The strip may fail", "tag");
  eq(await t.p.locator("#status").getAttribute("title"), "This version of Claude Code lacks --input-format and --strict-mcp-config, which the strip passes. Translations may fail; the strip needs an update.", "its title");
  ok(await t.p.evaluate(() => document.getElementById("status")!.classList.contains("s-needs")), "orange (s-needs)");
  const c = await contrastOf(t.p, "#status > span:last-child");
  ok(c >= 4.5, `the tag reaches ${c.toFixed(2)}:1, under 4.5:1`);
  await expectLayout(t.p);
  await translateFlow(t);
  eq(await tagText(t.p), "", "no tag over a reply");
  const t2 = await open("model=mac");
  await setClaudeCheck(t2.p, CLAUDE_MISSING);
  eq(await tagText(t2.p), "", "no tag with this Mac's model");
  return `contrast ${c.toFixed(2)}:1`;
});

// ===================================================================================== frames
type Frame = { file: string; query?: string; size?: { w: number; h: number }; before?: () => Promise<unknown>; make: (t: T) => Promise<void> };
const frames: Frame[] = [
  { file: "01-idle", make: async () => {} },
  { file: "02-ready-long", make: async (t) => { await ready(t, LONG_EN); await t.p.click("#es"); } },
  { file: "03-adjust-open", make: async (t) => { await ready(t, LONG_EN); await t.p.keyboard.press("Meta+k"); } },
  { file: "04-menu-open", make: async (t) => { await ready(t, LONG_EN); await t.p.click("#more"); } },
  { file: "05-send-error-long-chat", query: "send=not-front", make: async (t) => {
      await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false });
      await ready(t, LONG_EN);
      await t.p.click("#send");
      await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("forward"), null, { timeout: 4000 });
  } },
  { file: "06-first-run", query: "access=0", make: async () => {} },
  { file: "07-dictation-preparing", query: "dict=prep", make: async (t) => {
      await t.p.click("#mic");
      await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Getting dictation"), null, { timeout: 1200 });
  } },
  { file: "08-written-for", make: async (t) => { await ready(t, LONG_EN); await setTeams(t.p, DANIEL_TEAMS); } },
  { file: "09-auto-portuguese", query: "chat=pt", before: () => putSettings({ auto: true }), make: async (t) => { await ready(t); } },
  { file: "10-menu-narrow", size: { w: 640, h: 145 }, before: () => putSettings({ auto: true }), make: async (t) => { await ready(t, LONG_EN); await t.p.click("#more"); } },
];
// This Mac's Translation, at the strip's real size under Teams and narrow.
const macFrames: Frame[] = [
  { file: "11-menu-mac", query: "model=mac", make: async (t) => { await ready(t, LONG_EN); await t.p.click("#more"); } },
  { file: "12-mac-reply", query: "model=mac", make: async (t) => { await ready(t); await t.p.click("#es"); } },
  { file: "13-fallback", query: "fallback=offline", make: async (t) => { await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false, shape: "ok" }); await ready(t, LONG_EN); await t.p.click("#es"); } },
  { file: "14-error-mac", query: "model=mac", make: async (t) => { await t.p.fill("#es", "NOMAC"); await t.p.press("#es", "Enter"); await waitState(t.p, "mac"); } },
  { file: "15-error-language", query: "model=mac", make: async (t) => { await t.p.fill("#es", "NOTONMAC"); await t.p.press("#es", "Enter"); await waitState(t.p, "language"); } },
];
// The six quick fixes (0.10.0), at the same two sizes.
const quickFrames: Frame[] = [
  { file: "16-menu-settings", make: async (t) => { await ready(t, LONG_EN); await t.p.click("#more"); await t.p.hover("#menu [data-do=settings]"); } },
  { file: "17-fallback-retry", query: "fallback=offline", make: async (t) => { await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT }); await ready(t, LONG_EN); await t.p.click("#es"); } },
  { file: "18-unconfirmed", query: "send=unconfirmed", make: async (t) => {
      await setTeams(t.p, { ...PRIYA_TEAMS, chat: LONG_CHAT });
      await ready(t, LONG_EN);
      await t.p.click("#send");
      await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("Not confirmed"), null, { timeout: 4000 });
  } },
  { file: "19-idle-placeholder", make: async (t) => { await t.p.click("#es"); } },
];
// The recent messages and the update checks (0.12.0), at the same two sizes.
const nextFrames: Frame[] = [
  { file: "20-menu-recent", make: async (t) => { await keepRecent(t, RECENT_EN); await t.p.click("#more"); } },
  { file: "21-restored", make: async (t) => { await keepRecent(t, [LONG_EN]); await t.p.keyboard.press("Meta+z"); await waitState(t.p, "ready"); } },
  { file: "22-teams-changed", make: async (t) => { await setTeams(t.p, TEAMS_CHANGED); await t.p.click("#es"); } },
  { file: "23-claude-changed", make: async (t) => { await setClaudeCheck(t.p, CLAUDE_MISSING); await t.p.click("#es"); } },
];
// The mic as Session Monitor's (0.13.0), at the same two sizes.
const micFrames: Frame[] = [
  { file: "24-mic-idle", make: async (t) => { await t.p.hover("#mic"); } },
  { file: "25-listening", make: async (t) => {
      await t.p.click("#mic");
      await t.p.waitForFunction(() => (document.getElementById("es") as HTMLTextAreaElement).value.length > 20, null, { timeout: 3000 });
      await t.p.evaluate(() => (window as any).strip.dictLevel(0.6));
  } },
  { file: "26-armed", query: "dict=phrase", make: async (t) => {
      await t.p.click("#mic");
      await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Translating…"), null, { timeout: 5000 });
  } },
  { file: "28-claude-checking", query: "dict=misheard", before: () => putSettings({ dictationEngine: "claude" }), make: async (t) => {
      await t.p.click("#mic");
      await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Claude is checking"), null, { timeout: 6000 });
  } },
  { file: "27-mic-silent", query: "dict=silent", make: async (t) => {
      await t.p.click("#mic");
      await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("gives no sound"), null, { timeout: 3000 });
  } },
];
for (const f of [...macFrames, ...quickFrames, ...nextFrames, ...micFrames]) for (const w of [1200, 640]) frames.push({ ...f, file: `${f.file}-${w}`, size: { w, h: 145 } });
for (const f of frames) {
  check("Frames", `capture ${f.file}`, async () => {
    if (f.before) await f.before();
    if (f.size) ({ w: W, h: H } = f.size);
    try {
    const t = await open(f.query ?? "");
    await f.make(t);
    if (!f.file.startsWith("16")) await t.p.mouse.move(W / 2, 0);   // (16 keeps the pointer on Settings…)
    await settle(t.p, f.file.startsWith("07") ? 300 : 500);
    await t.p.screenshot({ path: join(OUT, `${f.file}.png`) });
    const r = await layout(t.p);
    ok(!r.issues.length, r.issues.join("; "));
    return r.info.length ? r.info.join("; ") : undefined;
    } finally { if (f.before) await resetSettings(); }
  });
}

// ===================================================================================== the column (360 x 900)
// The strip's second shape, beside Teams: the window is taller than wide. Each check below is only for the column;
// the functional groups above run again in it (see COLUMN_GROUPS).
const rect = (p: any, sel: string) => p.evaluate((sel: string) => {
  const e = document.querySelector(sel); if (!e) return null;
  const cs = getComputedStyle(e), r = e.getBoundingClientRect();
  if (cs.display === "none" || r.width === 0 && r.height === 0) return null;
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}, sel);
const enBoxH = (p: any) => p.evaluate(() => document.getElementById("en")!.getBoundingClientRect().height);
const asInApp = (p: any) => p.evaluate(() => { document.getElementById("preview")!.hidden = true; });

colCheck("Column", "the English module is on top and the Spanish below, each half the window's height, with the strip filling it", async () => {
  const t = await open();
  const en = await rect(t.p, ".f.en"), es = await rect(t.p, ".f.es"), strip = await rect(t.p, "#strip");
  eq(strip.w, 360, "strip width"); eq(strip.h, 900, "strip height");
  eq(en.t, 8, "English module top"); eq(es.b, 892, "Spanish module bottom");
  eq(en.h, 438, "English module height"); eq(es.h, 438, "Spanish module height");
  eq(es.t - en.b, 8, "the gap between the modules");
  eq(en.w, 344, "module width"); eq(en.l, 8, "module x");
  // Tab goes Spanish, then English; the English sits above it.
  const order = await t.p.evaluate(() => [...document.querySelectorAll(".fields > .f")].map((f) => f.classList.contains("en") ? "en" : "es").join(","));
  eq(order, "es,en", "DOM order (the page's tab order)");
  await expectLayout(t.p);
});
colCheck("Column", "the same page follows its window: wide and short is the strip, tall and narrow is the column", async () => {
  const t = await open();
  const row = await t.p.evaluate(() => { const e = document.querySelector(".f.en")!.getBoundingClientRect(), s = document.querySelector(".f.es")!.getBoundingClientRect(); return { enRight: e.left >= s.right - 0.5, h: document.getElementById("strip")!.getBoundingClientRect().height }; });
  ok(!row.enRight, "in a column window the English isn't beside the Spanish");
  await t.p.setViewportSize({ width: ROW.w, height: ROW.h });
  await settle(t.p, 150);
  const wide = await t.p.evaluate(() => { const e = document.querySelector(".f.en")!.getBoundingClientRect(), s = document.querySelector(".f.es")!.getBoundingClientRect(); return { beside: e.left >= s.right - 0.5, h: document.getElementById("strip")!.getBoundingClientRect().height }; });
  ok(wide.beside, "in a wide window the English sits beside the Spanish");
  eq(wide.h, 145, "the strip's height in a wide window");
  await t.p.setViewportSize({ width: COL.w, height: COL.h });
  await settle(t.p, 150);
  eq((await rect(t.p, "#strip")).h, 900, "the strip's height back in the column");
  await expectLayout(t.p);
});
colCheck("Column", "the English footer has two rows: the notice and Adjust, then 'To <chat>', Send (28) and the gear (28 × 28)", async () => {
  const t = await open();
  await ready(t, LONG_EN);
  const a = await rect(t.p, "#adjustBtn"), to = await rect(t.p, "#to"), send = await rect(t.p, "#send"), more = await rect(t.p, "#more"), foot = await rect(t.p, ".f.en .foot"), mod = await rect(t.p, ".f.en");
  ok(a && to && send && more, "a control is missing");
  eq(a.h, 24, "Adjust height"); eq(send.h, 28, "Send height"); eq(more.w, 28, "gear width"); eq(more.h, 28, "gear height");
  ok(a.b <= send.t, "Adjust is above Send's row");
  ok(to.r <= send.l && send.r <= more.l, "the second row runs To, Send, the gear");
  eq(Math.round(send.cy), Math.round(more.cy), "Send and the gear on one line");
  eq(Math.round(to.cy), Math.round(send.cy), "the name on Send's line");
  ok(Math.abs(a.l - foot.l) <= 0.5, `Adjust opens the footer at its left (${a.l} against ${foot.l})`);
  eq(foot.h, 56, "the footer's height (28 + 28)");
  eq(mod.b - foot.b, 8, "the footer's distance from the module's bottom");
  eq(await t.p.locator("#adjustBtn").evaluate((e: any) => getComputedStyle(e).fontSize), "12px", "Adjust font");
  await expectLayout(t.p);
});
colCheck("Column", "the English text doesn't move when a notice comes, and Adjust takes the footer's first row for its note", async () => {
  const t = await open("send=not-front");
  const h0 = await enBoxH(t.p);
  await ready(t, LONG_EN);
  const h1 = await enBoxH(t.p);
  eq(h1, h0, "text height after the English is ready");
  await t.p.click("#send");
  await waitState(t.p, "error");
  await settle(t.p, 400);
  eq(await enBoxH(t.p), h0, "text height with a notice");
  const foot0 = await rect(t.p, ".f.en .foot");
  await t.p.click("#es");
  await t.p.keyboard.type("!");
  eq(await state(t.p), "stale", "state");
  eq((await rect(t.p, ".f.en .foot")).t, foot0.t, "the footer's y with another notice");
  const t2 = await open();
  await ready(t2, LONG_EN);
  const f0 = await rect(t2.p, ".f.en .foot");
  await t2.p.keyboard.press("Meta+k");
  ok(await vis(t2.p, "#adjIn"), "the note field shows");
  const f1 = await rect(t2.p, ".f.en .foot"), row = await rect(t2.p, ".adjust-row");
  eq(f1.h, 28, "the footer with Adjust open is one row");
  ok(row.b <= f1.t, "the note row sits above the footer");
  ok(f1.t > f0.t, "the footer is lower, the note row sits above it");
  ok((await enBoxH(t2.p)) >= 300, "the English text still has most of the module");
  await expectLayout(t2.p);
});
colCheck("Column", "the Spanish footer is today's row: Normal / Formal, the mic, Translate; the Preview note takes a row of its own above it", async () => {
  const t = await open();
  const foot = await rect(t.p, ".f.es .foot"), mod = await rect(t.p, ".f.es"), note = await rect(t.p, "#preview");
  ok(note, "the preview note shows in a browser");
  ok(note.b <= (await rect(t.p, "#translate")).t, "the preview note is above the footer's row");
  await asInApp(t.p);
  const tone = await rect(t.p, "#tone"), mic = await rect(t.p, "#mic"), tr = await rect(t.p, "#translate"), f2 = await rect(t.p, ".f.es .foot");
  eq(f2.h, 28, "the Spanish footer's height, as in the app");
  eq(mod.b - f2.b, 8, "the footer's distance from the module's bottom");
  ok(tone.r <= mic.l && mic.r <= tr.l, "the row runs Normal / Formal, mic, Translate");
  eq(Math.round(mic.cy), Math.round(tr.cy), "the mic and Translate on one line");
  eq(mic.w, 24, "mic width (Session Monitor's chip)"); eq(tr.h, 28, "Translate height");
  ok(foot.h > f2.h, "the note adds a row");
});
colCheck("Column", "'Sent · time' sits in the English footer, and the gear still works", async () => {
  const t = await open();
  await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false });
  await ready(t);
  await t.p.click("#send");
  await waitState(t.p, "sent");
  await settle(t.p, 400);
  ok((await tagText(t.p)).startsWith("Sent ·"), "the footer says it was sent");
  await expectLayout(t.p);
  await t.p.click("#more");
  ok(await vis(t.p, "#menu"), "the gear opens the menu while the message shows");
});
colCheck("Column", "'Left in Teams, not sent' sits in the footer too", async () => {
  await setMode("leave");
  const t = await open();
  await ready(t);
  await t.p.click("#send");
  await waitState(t.p, "leave");
  await settle(t.p, 400);
  eq(await tagText(t.p), "Left in Teams, not sent", "footer tag");
  await resetSettings();
});
colCheck("Column", "the settings menu stacks its two groups in one column over the English module, above its footer, inside the window", async () => {
  const t = await open();
  await ready(t, LONG_EN);
  await t.p.click("#more");
  const m = await rect(t.p, "#menu"), mod = await rect(t.p, ".f.en"), foot = await rect(t.p, ".f.en .foot");
  ok(m.l >= mod.l && m.r <= mod.r && m.t >= mod.t && m.b <= foot.t, `the menu isn't over the English module, above its footer (${JSON.stringify(m)})`);
  const cols = await t.p.evaluate(() => [...document.querySelectorAll("#menu .col")].map((c) => { const r = c.getBoundingClientRect(); return [r.left, r.top, r.bottom]; }));
  eq(cols.length, 2, "groups");
  ok(cols.every((c, i) => c[0] === cols[0][0] && (i === 0 || c[1] >= cols[i - 1][2])), `the groups aren't stacked: ${JSON.stringify(cols)}`);
  eq((await t.p.locator("#menu .prow:not(.recentrow) .pl").allInnerTexts()).join(", "), "On ⌘⏎, Model, Reply in, Position", "the settings' rows");
  const lefts = await t.p.evaluate(() => [...document.querySelectorAll("#menu .prow:not([hidden]) .pl, #menu [data-do]")].map((e) => { const rg = document.createRange(); rg.selectNodeContents(e); return Math.round(rg.getBoundingClientRect().left); }));
  ok(new Set(lefts).size === 1, `the labels and the commands should start in one line: ${lefts.join(", ")}`);
  const dividers = await t.p.evaluate(() => [...document.querySelectorAll("#menu hr")].map((h) => { const r = h.getBoundingClientRect(); return [r.width, r.height]; }));
  ok(dividers.length === 1 && dividers.every(([w, h]) => w > 100 && h === 1), `the divider should run across: ${JSON.stringify(dividers)}`);
  eq(await t.p.locator("#menu button").count(), 17, "items (2 + 4 + Auto and 2 languages + 5 + 3 commands)");
  await expectLayout(t.p);
  await t.p.click("#menu [data-mode=leave]");
  await settle(t.p, 250);
  eq(await t.p.locator("#menu [data-mode=leave]").getAttribute("aria-checked"), "true", "Put in Teams checked");
  await t.p.keyboard.press("Escape");
  ok(!(await vis(t.p, "#menu")), "Esc closes it");
  await resetSettings();
});
colCheck("Column", "the menu stays inside a shorter column too (360 x 520)", async () => {
  const t = await open();
  await t.p.setViewportSize({ width: 360, height: 520 });
  await ready(t, LONG_EN);
  await t.p.click("#more");
  await settle(t.p, 200);
  const m = await rect(t.p, "#menu"), mod = await rect(t.p, ".f.en");
  ok(m.t >= mod.t - 0.5 && m.b <= mod.b && m.b <= 520, `the menu leaves the window (${JSON.stringify(m)})`);
  const reach = await t.p.evaluate(() => { const me = document.getElementById("menu")!; return { sh: me.scrollHeight, ch: me.clientHeight, oy: getComputedStyle(me).overflowY }; });
  ok(reach.sh <= reach.ch + 1 || reach.oy === "auto", "a menu that doesn't fit scrolls");
});
colCheck("Column", "the dictation label takes the row above the Spanish footer, and the mic stays where it is", async () => {
  const t = await open();
  await asInApp(t.p);
  const mic0 = await rect(t.p, "#mic");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Listening"), null, { timeout: 3000 });
  const label = await rect(t.p, "#dictLabel"), mic1 = await rect(t.p, "#mic"), mod = await rect(t.p, ".f.es");
  ok(label.b <= mic1.t, "the label is above the mic's row");
  eq(mic1.t - mic0.t, 0, "the mic's y while listening (the label grows the footer upward)");
  ok(label.l >= mod.l && label.r <= mod.r, "the label is inside the module");
  await expectLayout(t.p);
  for (const q of ["dict=prep", "dict=unavailable", "mic=denied"]) {
    const t2 = await open(q);
    await asInApp(t2.p);
    if (q === "mic=denied") ok(await vis(t2.p, "#dictLabel .btn"), "Open Settings shows");
    else { await t2.p.click("#mic"); await t2.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.length > 5, null, { timeout: 2000 }); }
    await settle(t2.p, 250);
    const l = await rect(t2.p, "#dictLabel"), m = await rect(t2.p, ".f.es");
    ok(l && l.l >= m.l && l.r <= m.r, `the label ${q} sits inside the module`);
    const full = await t2.p.evaluate(() => { const e = document.getElementById("dictLabel")!; return e.scrollWidth <= e.clientWidth + 1; });
    ok(full, `the label ${q} isn't cut`);
    await expectLayout(t2.p);
  }
});
colCheck("Column", "first run: one veil over both modules, the sentence over its button, the fields hidden and locked", async () => {
  const t = await open("access=0");
  const c = await rect(t.p, ".cover"), span = await rect(t.p, ".cover span"), btn = await rect(t.p, "#accessBtn"), en = await rect(t.p, ".f.en"), es = await rect(t.p, ".f.es");
  eq([c.l, c.t, c.r, c.b].join(","), [en.l, en.t, en.r, es.b].join(","), "the veil against the two modules");
  ok(span.b <= btn.t, "the sentence is above the button");
  eq(span.l, (await rect(t.p, "#es")).l, "the sentence at the message text's x");
  ok(span.r <= c.r && btn.r <= c.r, "the sentence and button stay inside the veil");
  eq(await t.p.locator("#fields").evaluate((e: any) => getComputedStyle(e).visibility), "hidden", "fields visibility");
  await expectLayout(t.p);
  const msgs0 = (await t.msgs()).length;
  await t.p.click("#accessBtn");
  eq((await opens(t, "accessibility")).length, 1, "the button asks the shell");
  ok((await t.msgs()).length > msgs0, "a message went out");
});
colCheck("Column", "a send error beside a long chat name: the notice on the first row, the name giving way on the second", async () => {
  const t = await open("send=not-front");
  await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false });
  await ready(t, LONG_EN);
  await t.p.click("#send");
  await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("forward"), null, { timeout: 3000 });
  await settle(t.p);
  const m = await t.p.evaluate(() => { const to = document.getElementById("to")!, w = document.querySelector("#status > span:not(.sdot)") as HTMLElement; return { to: to.clientWidth, toFull: to.scrollWidth, tag: w.clientWidth, tagFull: w.scrollWidth }; });
  ok(m.tag + 0.01 >= m.tagFull, `the notice's words are cut: ${m.tag} of ${m.tagFull}px`);
  ok(m.to >= 96, `the name is below 96px: ${m.to}`);
  const tag = await rect(t.p, "#status"), send = await rect(t.p, "#send"), adj = await rect(t.p, "#adjustBtn");
  ok(tag.b <= send.t, "the notice is above Send's row");
  ok(adj.t < send.t, "Adjust on the first row");
  await expectLayout(t.p);
  return `name ${m.to} of ${m.toFull} px, notice ${m.tag} of ${m.tagFull} px`;
});
colCheck("Column", "the longest notices: whole beside Adjust, or shortened with their title; never over a neighbor", async () => {
  const notes: string[] = [];
  const t = await open("send=no-paste");
  await ready(t, LONG_EN);
  await t.p.click("#send");
  await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("Not sent"), null, { timeout: 3000 });
  await settle(t.p);
  const m = await t.p.evaluate(() => { const w = document.querySelector("#status > span:not(.sdot)") as HTMLElement; return { tag: w.clientWidth, tagFull: w.scrollWidth, title: document.getElementById("status")!.title }; });
  if (m.tag + 0.01 < m.tagFull) { has(m.title, "Teams didn't take it", "the title holds the whole words"); notes.push(`no-paste notice ${m.tag} of ${m.tagFull} px`); }
  await expectLayout(t.p);
  const t2 = await open("send=draft");
  await setTeams(t2.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: true });
  await ready(t2, LONG_EN);
  await t2.p.click("#send");
  await waitState(t2.p, "draft", 3000);
  await settle(t2.p);
  eq((await actionLabels(t2.p)).join(","), "Add after draft,Cancel", "the draft's buttons");
  await expectLayout(t2.p);
  return notes.join("; ") || undefined;
});
colCheck("Column", "typing and translating in the column: the English comes in on top while the Spanish stays below", async () => {
  const t = await open();
  await t.p.click("#es");
  await t.p.keyboard.type("Hola, necesito el reporte");
  await t.p.press("#es", "Enter");
  await waitState(t.p, "ready");
  const en = await rect(t.p, "#en"), es = await rect(t.p, "#es");
  ok(en.b < es.t, "the English text is above the Spanish");
  eq(await val(t.p, "es"), "Hola, necesito el reporte", "Spanish stays");
  ok((await val(t.p, "en")).length > 10, "English came in");
  await t.p.click("#en");
  eq(await focused(t.p), "en", "the English can be focused and edited");
});
colCheck("Column", "a long message scrolls inside its module in both boxes; a short window keeps every control", async () => {
  const t = await open();
  await ready(t);
  const many = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a made-up message about the budget.`).join("\n");
  await t.p.fill("#en", many);
  await t.p.fill("#es", many);
  await settle(t.p);
  const m = await t.p.evaluate(() => { const en = document.getElementById("en")!, es = document.getElementById("es")!; return { en: en.scrollHeight > en.clientHeight, es: es.scrollHeight > es.clientHeight, enH: en.clientHeight, esH: es.clientHeight }; });
  ok(m.en && m.es, "both boxes scroll");
  ok(m.enH >= 300 && m.esH >= 300, `the boxes are tall (${m.enH}, ${m.esH})`);
  await expectLayout(t.p);
  await t.p.setViewportSize({ width: 360, height: 420 });
  await settle(t.p, 200);
  await expectLayout(t.p);
});

// Frames of the column, 360 x 900, dark, scale 2 (kept in .local/page-check/ with the strip's, named v01 to v07).
const colFrames: Frame[] = [
  { file: "v01-idle", make: async () => {} },
  { file: "v02-ready", make: async (t) => { await ready(t, LONG_EN); await t.p.click("#es"); } },
  { file: "v03-sent", make: async (t) => { await ready(t, LONG_EN); await t.p.click("#send"); await waitState(t.p, "sent"); } },
  { file: "v04-send-error-long-chat", query: "send=not-front", make: async (t) => {
      await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false });
      await ready(t, LONG_EN);
      await t.p.click("#send");
      await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("forward"), null, { timeout: 4000 });
  } },
  { file: "v05-adjust-open", make: async (t) => { await ready(t, LONG_EN); await t.p.keyboard.press("Meta+k"); } },
  { file: "v06-menu-open", make: async (t) => { await ready(t, LONG_EN); await t.p.click("#more"); } },
  { file: "v07-first-run", query: "access=0", make: async () => {} },
  { file: "v08-menu-mac", query: "model=mac", make: async (t) => { await ready(t, LONG_EN); await t.p.click("#more"); } },
];
for (const f of colFrames) {
  colCheck("Frames", `capture ${f.file}`, async () => {
    const t = await open(f.query ?? "");
    await f.make(t);
    await t.p.mouse.move(W / 2, 0);
    await settle(t.p, 500);
    await t.p.screenshot({ path: join(OUT, `${f.file}.png`) });
    const r = await layout(t.p);
    ok(!r.issues.length, r.issues.join("; "));
    return r.info.length ? r.info.join("; ") : undefined;
  });
}

// ---------------------------------------------------------------------------------------- go
async function main() {
  try {
    const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    console.error(`The page mock isn't answering on ${BASE}. Start it with: bun test/page-mock.ts`);
    process.exit(2);
  }
  let chromium: any;
  try { ({ webkit: chromium } = await import(PW)); } catch (e) {
    console.error(`Can't load Playwright from ${PW} (set PLAYWRIGHT_DIR): ${e}`);
    process.exit(2);
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "failed"), { recursive: true });
  browser = await chromium.launch();
  await resetSettings();
  let failed = 0, passed = 0;
  const only = process.argv[2] ? new RegExp(process.argv[2], "i") : null;
  // The strip's own checks, then the functional groups again in the column, then the column's own, the page's errors last.
  type Run = Check & { label: string };
  const runs: Run[] = [];
  const column = (c: Check) => c.mode === "row" && COLUMN_GROUPS.has(c.group) && !ROW_ONLY.some((re) => re.test(c.name));
  for (const c of checks) if (c.mode === "row" && c.group !== "Page") runs.push({ ...c, label: c.group });
  for (const c of checks) if (column(c)) runs.push({ ...c, mode: "col", label: `${c.group} (column)` });
  for (const c of checks) if (c.mode === "col") runs.push({ ...c, label: `${c.group} (column)` });
  for (const c of checks) if (c.mode === "row" && c.group === "Layout" && LAYOUT_CASES.has(c.name)) runs.push({ ...c, mode: "narrow", label: "Layout (640 wide)" });
  for (const c of checks) if (c.mode === "narrow") runs.push({ ...c, label: `${c.group} (640 wide)` });
  for (const c of checks) if (c.group === "Page") runs.push({ ...c, label: c.group });
  for (const c of runs) {
    if (only && !only.test(`${c.label} ${c.name}`)) continue;
    ({ w: W, h: H } = c.mode === "col" ? COL : c.mode === "narrow" ? NARROW : ROW);
    lastPage = null;
    let line = "", note: string | void;
    try {
      note = await Promise.race([c.fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Fail("timed out after 40 s")), 40000))]);
      passed++;
      line = `PASS  ${c.label} · ${c.name}${note ? `  [${note}]` : ""}`;
    } catch (e: any) {
      failed++;
      let shot = "";
      if (lastPage) {
        shot = join(OUT, "failed", `${slug(c.label + "-" + c.name)}.png`);
        try { await lastPage.screenshot({ path: shot, timeout: 5000 }); } catch { shot = ""; }
      }
      line = `FAIL  ${c.label} · ${c.name}\n      ${e instanceof Fail ? e.message : String(e?.message ?? e).split("\n")[0]}${shot ? `\n      capture: ${shot.replace(ROOT + "/", "")}` : ""}`;
    }
    console.log(line);
    for (const x of contexts.splice(0)) { try { await x.close(); } catch {} }
  }
  await resetSettings();
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed. Captures: ${OUT.replace(ROOT + "/", "")}/`);
  process.exit(failed ? 1 : 0);
}
await main();
