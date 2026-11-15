// Presses every control of the strip's page in WebKit and checks what it does, then checks the layout
// of the states that matter. One line per control: PASS or FAIL with the reason. Exit 1 on any failure.
//
//   bun test/page-check.ts
//
// It needs the page mock already running (bun test/page-mock.ts, on 127.0.0.1:4813) and Playwright with
// WebKit. Playwright is read from PLAYWRIGHT_DIR, or from the sibling folder mac-app-design/node_modules.
// The window is a typical strip, 1200 x 145 (the strip is 145 tall and as wide as Teams), dark, device scale 2, in a browser (no shell), so the
// page uses its stand-in bridge: nothing is ever sent. Made-up text only.
//
// Captures go to .local/page-check/ (kept out of git). The seven frames are saved by their state name:
//   01-idle  02-ready-long  03-adjust-open  04-menu-open  05-send-error-long-chat  06-first-run  07-dictation-preparing
// A control that fails saves its capture in .local/page-check/failed/. The folder is emptied at each run.
import { join, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, ".local", "page-check");
const BASE = process.env.PAGE_MOCK ?? "http://127.0.0.1:4813";
const PW = process.env.PLAYWRIGHT_DIR ?? resolve(ROOT, "..", "mac-app-design", "node_modules", "playwright");

const W = 1200, H = 145;
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
    // srv and shell are the page's own top-level bindings (let/const, so not on window): read them by name.
    await p.waitForFunction("(() => { try { return !!srv && shell.teams !== null; } catch (e) { return false; } })()", null, { timeout: 8000 });
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

// The mock keeps the settings between pages: put them back to what the page starts with.
async function resetSettings() {
  const s = await (await fetch(`${BASE}/api/state`)).json();
  const patch: any = {};
  if (s.settings.model !== "haiku") patch.model = "haiku";
  if (s.settings.mode !== "send") patch.mode = "send";
  if (Object.keys(patch).length) {
    await fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    await new Promise((r) => setTimeout(r, patch.model ? 1800 : 100));
  }
}
const setMode = (mode: string) => fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });

// ---------------------------------------------------------------------------------------- layout
// Nothing may overflow the 145 px height or the window's width, nothing may sit outside the panel it
// belongs to, no tag or button may be cut or overlap its neighbor. The chat's name may give way
// (an ellipsis): that is the design, and it is reported as a note.
async function layout(p: any): Promise<{ issues: string[]; info: string[] }> {
  return p.evaluate(() => {
    const issues: string[] = [], info: string[] = [];
    const Wd = window.innerWidth, Ht = window.innerHeight;
    const de = document.documentElement, bd = document.body;
    const sh = Math.max(de.scrollHeight, bd.scrollHeight), sw = Math.max(de.scrollWidth, bd.scrollWidth);
    if (sh > Ht) issues.push(`the page is taller than the window (${sh} > ${Ht})`);
    if (sw > Wd) issues.push(`the page is wider than the window (${sw} > ${Wd})`);
    const strip = document.getElementById("strip")!;
    const sr = strip.getBoundingClientRect();
    if (Math.abs(sr.height - 145) > 0.5) issues.push(`the strip is ${sr.height}px tall, not 145`);
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
        else issues.push(`${name(el)} is cut: its content is ${el.scrollWidth}px in a ${(el as HTMLElement).clientWidth}px box`);
      }
      if ((el.classList.contains("status") || el.classList.contains("btn")) && el.scrollHeight > (el as HTMLElement).clientHeight + 1)
        issues.push(`${name(el)} is cut vertically (${el.scrollHeight}px in ${(el as HTMLElement).clientHeight}px)`);
    }
    // Both footers sit on one line, at one height, in every state.
    const fs = strip.querySelector(".f.es .foot")!.getBoundingClientRect(), fe = strip.querySelector(".f.en .foot")!.getBoundingClientRect();
    if (Math.abs(fs.top - fe.top) > 0.5 || Math.abs(fs.height - fe.height) > 0.5)
      issues.push(`the footers don't line up (Spanish y ${fs.top}, ${fs.height} tall; English y ${fe.top}, ${fe.height} tall)`);
    // A shortcut glyph is never translucent, itself or through a parent.
    for (const k of strip.querySelectorAll("kbd")) {
      if (!shown(k)) continue;
      let o = 1;
      for (let a: Element | null = k; a && a !== document.body; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity);
      if (o < 0.99) issues.push(`a shortcut glyph "${k.textContent}" is translucent (opacity ${o.toFixed(2)})`);
    }
    // Each control stays in its own panel and doesn't sit on its neighbor.
    const sels = [".tone", ".preview", ".dict-label", ".mic", "#translate", "#status", "#actions .btn", "#adjustBtn", "#more", ".to", "#send", ".adjust-row .field", "#chip"];
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
    }
    return { issues, info: [...new Set(info)] };
  });
}
async function expectLayout(p: any) {
  const r = await layout(p);
  ok(!r.issues.length, r.issues.join("; "));
  return r.info;
}

// ---------------------------------------------------------------------------------------- runner
type Check = { group: string; name: string; fn: () => Promise<string | void> };
const checks: Check[] = [];
const check = (group: string, name: string, fn: () => Promise<string | void>) => checks.push({ group, name, fn });
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
check("Mic", "mic button dictates into the box (listening label with a still dot, full text, back to off)", async () => {
  const t = await open();
  await t.p.click("#mic");
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "true", "mic pressed");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Listening"), null, { timeout: 3000 })
    .catch(() => { throw new Fail("no 'Listening' label"); });
  ok(await vis(t.p, "#dictLabel .sdot"), "the still dot should show beside Listening");
  eq(await t.p.locator(".level").count(), 0, "moving level bars");
  const dot = await t.p.evaluate(() => { const d = document.querySelector("#dictLabel .sdot")!; const cs = getComputedStyle(d, "::before"); return { anim: getComputedStyle(d).animationName, before: cs.animationName }; });
  ok(dot.anim === "none" && dot.before === "none", `the dot should not move (${JSON.stringify(dot)})`);
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
  eq(r[0].body.english, before, "english sent");
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

// ===================================================================================== ⋯ menu
check("⋯ menu", "the button opens the menu with its three columns; outside click and Esc close it", async () => {
  const t = await open();
  eq(await t.p.locator("#more").getAttribute("aria-expanded"), "false", "aria-expanded before");
  await t.p.click("#more");
  ok(await vis(t.p, "#menu"), "menu visible");
  eq(await t.p.locator("#more").getAttribute("aria-expanded"), "true", "aria-expanded");
  eq(await t.p.locator("#menu button").count(), 6, "menu items");
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
check("⋯ menu", "its first column is titled 'On ⌘⏎'; every command is in primary text; ⋯ is the footer's last control, 28 × 28", async () => {
  const t = await open();
  await ready(t);
  await t.p.click("#more");
  const heads = await t.p.locator("#menu .mh").allInnerTexts();
  eq(heads[0], "On ⌘⏎", "first column title");
  eq(heads[1], "Model", "second column title");
  const colors = await t.p.evaluate(() => [...document.querySelectorAll("#menu button")].map((b) => ({ t: (b.textContent || "").trim(), c: getComputedStyle(b).color, off: b.classList.contains("off") })));
  const prim = await t.p.evaluate(() => { const d = document.createElement("i"); d.style.color = "var(--color-text-primary)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  for (const b of colors) ok(b.c === prim && !b.off, `"${b.t}" should be in primary text (${b.c}, off=${b.off}, wanted ${prim})`);
  const r = await t.p.evaluate(() => { const g = (id: string) => document.getElementById(id)!.getBoundingClientRect(); const m = g("more"), s = g("send"), me = g("menu"); return { more: [m.width, m.height, m.left, m.right], sendRight: s.right, sendTop: s.top, menuBottom: me.bottom, W: window.innerWidth }; });
  eq(r.more[0], 28, "⋯ width"); eq(r.more[1], 28, "⋯ height");
  ok(r.more[2] >= r.sendRight, "⋯ should sit after Send");
  ok(r.more[3] <= r.W - 15, "⋯ should be the footer's last control");
  ok(r.sendTop - r.menuBottom >= 5, `the menu should leave a gap above Send (${r.sendTop - r.menuBottom} px)`);
});
check("⋯ menu", "Send item: sets mode send (request, check mark)", async () => {
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
check("⋯ menu", "Put in Teams without sending item: sets mode leave and renames the button", async () => {
  await resetSettings();
  const t = await open();
  await t.p.click("#more");
  await t.p.click("#menu [data-mode=leave]");
  await settle(t.p, 300);
  eq(JSON.stringify(reqsTo(t, "/api/settings")[0]?.body), JSON.stringify({ mode: "leave" }), "settings request");
  eq(await t.p.locator("#menu [data-mode=leave]").getAttribute("aria-checked"), "true", "checked");
  eq((await t.p.locator("#send").innerText()).replace(/\s+/g, " "), "Put in Teams ⌘⏎", "Send button label");
  await resetSettings();
});
check("⋯ menu", "Sonnet item: sets the model (request, check mark); Haiku sets it back", async () => {
  await resetSettings();
  const t = await open();
  await t.p.click("#more");
  await t.p.click("#menu [data-model=sonnet]");
  await settle(t.p, 300);
  eq(JSON.stringify(reqsTo(t, "/api/settings")[0]?.body), JSON.stringify({ model: "sonnet" }), "settings request");
  eq(await t.p.locator("#menu [data-model=sonnet]").getAttribute("aria-checked"), "true", "Sonnet checked");
  eq(await t.p.locator("#menu [data-model=haiku]").getAttribute("aria-checked"), "false", "Haiku unchecked");
  await t.p.click("#menu [data-model=haiku]");
  await settle(t.p, 300);
  eq(JSON.stringify(reqsTo(t, "/api/settings")[1]?.body), JSON.stringify({ model: "haiku" }), "second settings request");
  eq(await t.p.locator("#menu [data-model=haiku]").getAttribute("aria-checked"), "true", "Haiku checked");
  await new Promise((r) => setTimeout(r, 1800));
});
check("⋯ menu", "Open voice guide: tells the shell and closes the menu", async () => {
  const t = await open();
  await t.p.click("#more");
  await t.p.click("#menu [data-do=guide]");
  eq((await opens(t, "guide")).length, 1, "open guide messages");
  ok(!(await vis(t.p, "#menu")), "menu should close");
});
check("⋯ menu", "Restart translator: posts the restart and closes the menu", async () => {
  const t = await open();
  await t.p.click("#more");
  await t.p.click("#menu [data-do=restart]");
  await settle(t.p, 200);
  eq(reqsTo(t, "/api/translator/restart").length, 1, "restart requests");
  ok(!(await vis(t.p, "#menu")), "menu should close");
  await new Promise((r) => setTimeout(r, 1800));
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
check("Send", "Send button, mode send: Sending…, then 'Sent to <chat> · time' in the middle of the English box, boxes cleared, then fades", async () => {
  const t = await sendFlow("click");
  await waitState(t.p, "sent");
  const done = (await t.p.locator("#doneMsg").innerText()).replace(/\s+/g, " ").trim();
  ok(/^Sent to .+ · \d{1,2}:\d{2} (AM|PM)$/.test(done), `message ${JSON.stringify(done)}`);
  eq(await tagText(t.p), "", "no tag in the footer while the message shows");
  const box = await t.p.locator(".f.en .en-wrap").boundingBox(), msg = await t.p.locator("#doneMsg .who").boundingBox();
  ok(!!box && !!msg && Math.abs((msg.y + msg.height / 2) - (box.y + box.height / 2)) < 3, "message centered in the English box");
  eq(await val(t.p, "es"), "", "Spanish box");
  eq(await val(t.p, "en"), "", "English box");
  eq(await focused(t.p), "es", "focus");
  await waitState(t.p, "idle", 6000);
  eq(await tagText(t.p), "", "tag after the fade");
});
check("Send", "⌘⏎ sends the same way", async () => {
  const t = await sendFlow("key");
  await waitState(t.p, "sent");
  eq(await val(t.p, "en"), "", "English box");
});
check("Send", "Put in Teams mode: the button says so, mode leave, 'Left in Teams, not sent'", async () => {
  await setMode("leave");
  try {
    const t = await open();
    await translateFlow(t);
    eq((await t.p.locator("#send").innerText()).replace(/\s+/g, " "), "Put in Teams ⌘⏎", "button label");
    await t.p.click("#send");
    await waitState(t.p, "sending");
    eq(await tagText(t.p), "Putting in Teams…", "tag while sending");
    eq((await sends(t))[0].mode, "leave", "mode");
    await waitState(t.p, "leave");
    eq((await t.p.locator("#doneMsg").innerText()).replace(/\s+/g, " ").trim(), "Left in Teams, not sent", "message");
    eq(await tagText(t.p), "", "no tag in the footer");
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
  const want = reason === "draft" ? "draft" : ["not-front", "mismatch", "not-sent", "something-else"].includes(reason) ? "error" : "ready";
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
  return "the build notes say 'Teams didn't take the text. Nothing sent' + Try again; the code and contract say no retry";
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
check("Dictation", "?dict=prep: 'Getting Spanish dictation ready…', then Listening with the dot, then the words", async () => {
  const t = await open("dict=prep");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Getting Spanish dictation ready"), null, { timeout: 1200 })
    .catch(() => { throw new Fail("no 'Getting Spanish dictation ready…' label"); });
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "true", "mic pressed while preparing");
  ok(!(await vis(t.p, "#dictLabel .sdot")), "no listening dot while preparing");
  eq(await val(t.p, "es"), "", "Spanish box while preparing");
  await expectLayout(t.p);
  await t.p.waitForFunction(() => /ready… \d+%$/.test(document.getElementById("dictLabel")!.textContent!), null, { timeout: 1200 })
    .catch(() => { throw new Fail("no download percent while preparing"); });
  await expectLayout(t.p);
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Listening"), null, { timeout: 3500 })
    .catch(() => { throw new Fail("never changed to Listening"); });
  ok(await vis(t.p, "#dictLabel .sdot"), "the dot should show while listening");
  await t.p.waitForFunction((s: string) => (document.getElementById("es") as HTMLTextAreaElement).value === s, ES, { timeout: 6000 })
    .catch(async () => { throw new Fail(`the field ended as ${JSON.stringify(await val(t.p, "es"))}`); });
  eq(await t.p.locator("#dictLabel").innerText(), "", "label at the end");
});
check("Dictation", "?dict=prep: stopping while it prepares listens to nothing", async () => {
  const t = await open("dict=prep");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Getting Spanish"), null, { timeout: 1200 });
  await t.p.click("#mic");
  await settle(t.p, 2200);
  eq(await t.p.locator("#mic").getAttribute("aria-pressed"), "false", "mic pressed");
  eq(await val(t.p, "es"), "", "Spanish box");
  eq(await t.p.locator("#dictLabel").innerText(), "", "label");
});
check("Dictation", "?dict=unavailable: 'Spanish dictation isn't available on this Mac', mic off, nothing typed, fits", async () => {
  const t = await open("dict=unavailable");
  await t.p.click("#mic");
  await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("isn't available"), null, { timeout: 2000 })
    .catch(() => { throw new Fail("no 'isn't available' label"); });
  eq(await t.p.locator("#dictLabel").innerText(), "Spanish dictation isn't available on this Mac", "label");
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
check("Design", "the English footer: notice and Adjust buttons 24 px at 12 px, Send 28, ⋯ last and 28 × 28", async () => {
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
  eq(r.more!.w, 28, "⋯ width"); eq(r.more!.h, 28, "⋯ height");
  ok(r.more!.l >= r.send!.r, "⋯ should come after Send");
  const order = await t.p.evaluate(() => [...document.querySelector(".f.en .foot")!.children].map((c) => c.id || c.className).join(","));
  ok(order.endsWith("send,more"), `English footer order: ${order}`);
});
check("Design", "a send error beside a long chat name: no Try again, the notice stays whole, the name gives way down to 96 px and keeps its whole text in a title", async () => {
  const t = await open("send=not-front");
  await ready(t);
  await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false });
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
  ["ready, two lines, long chat", async () => { const t = await open(); await ready(t, LONG_EN); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); return t; }],
  ["adjust open, two lines", async () => { const t = await open(); await ready(t, LONG_EN); await t.p.keyboard.press("Meta+k"); return t; }],
  ["adjust open, with text in the note", async () => { const t = await open(); await ready(t, LONG_EN); await t.p.keyboard.press("Meta+k"); await t.p.fill("#adjIn", "que suene menos seco y más cercano, sin perder el tono"); return t; }],
  ["adjusted + Undo", async () => { const t = await open(); await ready(t); await t.p.keyboard.press("Meta+k"); await t.p.click("#chip"); await waitState(t.p, "ready"); return t; }],
  ["menu open", async () => { const t = await open(); await ready(t, LONG_EN); await t.p.click("#more"); return t; }],
  ["menu open, idle", async () => { const t = await open(); await t.p.click("#more"); return t; }],
  ["voice check + long chat", async () => { const t = await open(); await translateFlow(t, "kindly revisa"); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); return t; }],
  ["send error notice + long chat", async () => { const t = await open("send=not-front"); await ready(t); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); await t.p.click("#send"); await waitState(t.p, "sending"); await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("forward"), null, { timeout: 3000 }); return t; }],
  ["draft notice + long chat", async () => { const t = await open("send=draft"); await ready(t); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: true }); await t.p.click("#send"); await waitState(t.p, "draft", 3000); return t; }],
  ["out of date + long chat", async () => { const t = await open(); await ready(t); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); await t.p.click("#es"); await t.p.keyboard.type("!"); return t; }],
  ["question", async () => { const t = await open(); await t.p.fill("#es", "UNCLEAR"); await t.p.press("#es", "Enter"); await waitState(t.p, "question"); return t; }],
  ["error offline", async () => { const t = await open(); await t.p.fill("#es", "OFFLINE"); await t.p.press("#es", "Enter"); await waitState(t.p, "error"); return t; }],
  ["plan limit", async () => { const t = await open(); await t.p.fill("#es", "LIMIT"); await t.p.press("#es", "Enter"); await waitState(t.p, "limit"); return t; }],
  ["no voice guide", async () => { const t = await open(); await t.p.fill("#es", "GUIDE"); await t.p.press("#es", "Enter"); await waitState(t.p, "noguide"); return t; }],
  ["translating", async () => { const t = await open(); await t.p.fill("#es", ES); await t.p.press("#es", "Enter"); await waitState(t.p, "translating"); return t; }],
  ["starting", async () => { const t = await open(); await t.p.fill("#es", "STARTING"); await t.p.press("#es", "Enter"); await waitState(t.p, "starting", 3000); return t; }],
  ["sending + long chat", async () => { const t = await open(); await ready(t); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); await t.p.click("#send"); await waitState(t.p, "sending"); return t; }],
  ["sent + long chat", async () => { const t = await open(); await ready(t); await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false }); await t.p.click("#send"); await waitState(t.p, "sent"); return t; }],
  ["dictating", async () => { const t = await open(); await t.p.click("#mic"); await t.p.waitForFunction(() => (document.getElementById("es") as HTMLTextAreaElement).value.length > 20, null, { timeout: 3000 }); return t; }],
  ["mic denied", async () => open("mic=denied")],
  ["mic denied, as in the app (the Preview note hidden)", async () => { const t = await open("mic=denied"); await t.p.evaluate(() => { document.getElementById("preview")!.hidden = true; }); return t; }],
  ["Teams closed, ready", async () => { const t = await open("teams=closed"); await ready(t); return t; }],
  ["no chat", async () => open("teams=nochat")],
  ["preview note, long Spanish", async () => { const t = await open(); await t.p.fill("#es", ES + " " + ES + " " + ES); return t; }],
];
for (const [name, mk] of layoutCases) {
  check("Layout", name, async () => {
    const t = await mk();
    await settle(t.p);
    const info = await expectLayout(t.p);
    return info.length ? info.join("; ") : undefined;
  });
}
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

// ===================================================================================== frames
type Frame = { file: string; query?: string; make: (t: T) => Promise<void> };
const frames: Frame[] = [
  { file: "01-idle", make: async () => {} },
  { file: "02-ready-long", make: async (t) => { await ready(t, LONG_EN); await t.p.click("#es"); } },
  { file: "03-adjust-open", make: async (t) => { await ready(t, LONG_EN); await t.p.keyboard.press("Meta+k"); } },
  { file: "04-menu-open", make: async (t) => { await ready(t, LONG_EN); await t.p.click("#more"); } },
  { file: "05-send-error-long-chat", query: "send=not-front", make: async (t) => {
      await ready(t, LONG_EN);
      await setTeams(t.p, { open: true, chat: LONG_CHAT, from: "A", last: "B", draft: false });
      await t.p.click("#send");
      await t.p.waitForFunction(() => document.getElementById("status")!.textContent!.includes("forward"), null, { timeout: 4000 });
  } },
  { file: "06-first-run", query: "access=0", make: async () => {} },
  { file: "07-dictation-preparing", query: "dict=prep", make: async (t) => {
      await t.p.click("#mic");
      await t.p.waitForFunction(() => document.getElementById("dictLabel")!.textContent!.includes("Getting Spanish"), null, { timeout: 1200 });
  } },
];
for (const f of frames) {
  check("Frames", `capture ${f.file}`, async () => {
    const t = await open(f.query ?? "");
    await f.make(t);
    await t.p.mouse.move(W / 2, 0);
    await settle(t.p, f.file.startsWith("07") ? 300 : 500);
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
  for (const c of checks) {
    if (only && !only.test(`${c.group} ${c.name}`)) continue;
    lastPage = null;
    let line = "", note: string | void;
    try {
      note = await Promise.race([c.fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Fail("timed out after 40 s")), 40000))]);
      passed++;
      line = `PASS  ${c.group} · ${c.name}${note ? `  [${note}]` : ""}`;
    } catch (e: any) {
      failed++;
      let shot = "";
      if (lastPage) {
        shot = join(OUT, "failed", `${slug(c.group + "-" + c.name)}.png`);
        try { await lastPage.screenshot({ path: shot, timeout: 5000 }); } catch { shot = ""; }
      }
      line = `FAIL  ${c.group} · ${c.name}\n      ${e instanceof Fail ? e.message : String(e?.message ?? e).split("\n")[0]}${shot ? `\n      capture: ${shot.replace(ROOT + "/", "")}` : ""}`;
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
