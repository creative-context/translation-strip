// Records docs/demo-dark.gif and docs/demo-light.gif: how the strip is used, with made-up text. A simplified chat window sits
// on top (a generic chat, not any real app's look) and the strip is docked under it, as wide, as
// in the app. The story, with Auto on: in a chat in English you write in Spanish, ⏎ translates, ⌘⏎
// sends, and the message shows in the chat; then a chat in Portuguese, where you write in English and
// the same steps give Portuguese; then two more chats in English, one written in a mix of Spanish and
// English and one in Swahili. Frames are drawn in WebKit at 2x, one by one, and ffmpeg makes the GIFs at 880 px. The
// window's round corners sit on GitHub's page color: one GIF for its dark theme, one for its light
// theme (the README picks with <picture>), since a transparent GIF would weigh ten times as much.
// Starts its own page mock (port 4816) and answers the translations itself, so each one fits what
// you wrote. Needs Playwright (PLAYWRIGHT_DIR, by default the one in ../mac-app-design) and ffmpeg.
// Run from the repo: `bun docs/demo-gif.ts`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MOCK_PORT = 4816;
const BASE = `http://127.0.0.1:${MOCK_PORT}`;
const PW = process.env.PLAYWRIGHT_DIR ?? resolve(ROOT, "..", "mac-app-design", "node_modules", "playwright");
const { webkit } = await import(PW);

const W = 880, CHAT_H = 300, STRIP_H = 145;
// The chats, each with what you write and what comes out. Made up; the replies are the real
// translator's, with the example voice guide and Auto on.
const CHATS = [
  { id: "en", name: "Priya Raman", initials: "PR", color: "#3d5a80", language: "English",
    msgs: ["Morning! I'm back from the offsite.", "Anything you need from me this week?"],
    write: "¿Puedes revisar el presupuesto antes del jueves? Si hace falta, lo vemos en la llamada.",
    out: "Could you take a look at the budget before Thursday? If needed, we can go over it on the call." },
  { id: "pt", name: "Rafael Costa", initials: "RC", color: "#5a7d4f", language: "Português",
    msgs: ["Oi! Tudo bem por aí?", "Você consegue me mandar a apresentação até amanhã?"],
    write: "Sure, I will send it over today before 6 pm.",
    out: "Claro, vou mandar hoje antes das 6 da tarde." },
  { id: "mix", name: "Hannah Brooks", initials: "HB", color: "#6b4f8a", language: "English",
    msgs: ["How's the release looking?", "Can we still ship it today?"],
    write: "sí, ya hice el fix del login, nada más falta que pase el CI y hacemos el deploy en la tarde",
    out: "Yes, I finished the login fix. We just need CI to pass, and then we'll deploy this afternoon." },
  { id: "sw", name: "Omar Haddad", initials: "OH", color: "#8a6a3d", language: "English",
    msgs: ["Thanks for the numbers yesterday.", "When do you think the report will be ready?"],
    write: "Habari! Nimemaliza ripoti, nitaituma kesho asubuhi.",
    out: "Hi! I've finished the report, I'll send it tomorrow morning." },
];

// The scene: the chat window, the strip in a frame under it, and the key hint.
const SCENE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${BASE}/design-tokens.css"><link rel="stylesheet" href="${BASE}/design-base.css">
<style>
  html, body { margin: 0; background: transparent; width: ${W}px; height: ${CHAT_H + STRIP_H}px; overflow: hidden; }
  body { font-family: -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .win { position: absolute; left: 0; top: 0; width: ${W}px; height: ${CHAT_H}px; box-sizing: border-box; border-radius: 12px 12px 0 0;
    background: #17181b; overflow: hidden; }
  .chat { position: absolute; inset: 0; display: grid; grid-template-rows: 44px 1fr 56px; opacity: 0; transition: opacity 200ms ease-out; }
  .chat.on { opacity: 1; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 0 16px; background: #1d1e22; }
  .dots { display: flex; gap: 8px; margin-right: 10px; } .dots i { width: 12px; height: 12px; border-radius: 50%; background: #3a3b40; display: block; }
  .av { width: 26px; height: 26px; border-radius: 50%; background: #3d5a80; color: #e8eef6; font-size: 11px; font-weight: 600; display: grid; place-items: center; flex: none; }
  .name { color: #f2f3f5; font-size: 14px; font-weight: 600; }
  .msgs { padding: 14px 20px 6px; display: flex; flex-direction: column; justify-content: flex-end; gap: 10px; }
  .row { display: flex; gap: 10px; align-items: flex-start; } .row.me { justify-content: flex-end; }
  .meta { color: #9aa0a8; font-size: 11px; margin-bottom: 3px; }
  .bub { max-width: 560px; padding: 8px 12px; border-radius: 10px; font-size: 14px; line-height: 20px; color: #eceef1; background: #26282d; }
  .me .bub { background: #2a3f5c; }
  .me { opacity: 0; transform: translateY(8px); transition: opacity 260ms ease-out, transform 260ms ease-out; }
  .me.in { opacity: 1; transform: none; }
  .compose { margin: 8px 20px 14px; border-radius: 8px; background: #212227; color: #7d828a; font-size: 13px; display: flex; align-items: center; padding: 0 12px; }
  /* The strip, docked under the chat as in the app; together they read as one window with round corners. */
  .dock { position: absolute; left: 0; top: ${CHAT_H}px; width: ${W}px; height: ${STRIP_H}px; border-radius: 0 0 12px 12px; overflow: hidden; background: #0b0c0e; }
  iframe { display: block; width: ${W}px; height: ${STRIP_H}px; border: 0; }
  .hint { position: absolute; left: 50%; top: ${CHAT_H - 45}px; transform: translateX(-50%) scale(.96); opacity: 0;
    padding: 7px 14px; border-radius: 999px; background: rgba(250,250,252,.94); color: #111; font-size: 13px; font-weight: 600;
    box-shadow: 0 6px 20px rgba(0,0,0,.45); transition: opacity 160ms ease-out, transform 160ms ease-out; white-space: nowrap; }
  .hint.on { opacity: 1; transform: translateX(-50%) scale(1); }
  .hint kbd { font: inherit; margin-right: 6px; }
</style></head><body>
<div class="win">${CHATS.map((c, i) => `
  <div class="chat${i === 0 ? " on" : ""}" id="chat-${c.id}">
    <div class="bar"><div class="dots"><i></i><i></i><i></i></div><div class="av" style="background:${c.color}">${c.initials}</div><div class="name">${c.name}</div></div>
    <div class="msgs">
      <div class="row"><div class="av" style="background:${c.color}">${c.initials}</div><div><div class="meta">${c.name} · 10:38 AM</div><div class="bub">${c.msgs[0]}</div></div></div>
      <div class="row"><div class="av" style="visibility:hidden">${c.initials}</div><div><div class="bub">${c.msgs[1]}</div></div></div>
      <div class="row me" id="mine-${c.id}"><div><div class="meta" style="text-align:right">10:42 AM</div><div class="bub"></div></div></div>
    </div>
    <div class="compose">Type a message</div>
  </div>`).join("")}
</div>
<div class="dock"><iframe id="strip" src="${BASE}/"></iframe></div>
<div class="hint" id="hint"></div>
</body></html>`;

// Its own mock, with Auto on, so the page check's mock (4813) keeps its settings.
const mock = Bun.spawn(["bun", "test/page-mock.ts"], { cwd: ROOT, env: { ...process.env, STRIP_MOCK_PORT: String(MOCK_PORT) }, stdout: "ignore", stderr: "inherit" });
process.on("exit", () => mock.kill());
for (let i = 0; ; i++) {
  try { if ((await fetch(`${BASE}/api/state`)).ok) break; } catch {}
  if (i > 80) throw new Error(`the page mock didn't start on ${BASE}`);
  await Bun.sleep(100);
}
const set = await fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ auto: true, target: "English", languages: ["English", "Português"] }) });
if (!set.ok) throw new Error(`the mock refused the settings: ${set.status}`);

const browser = await webkit.launch();
const context = await browser.newContext({ viewport: { width: W, height: CHAT_H + STRIP_H }, deviceScaleFactor: 2, colorScheme: "dark", timezoneId: "UTC" });
await context.clock.setFixedTime(new Date("2026-03-03T10:42:00Z"));
// Each translation fits what you wrote: the chat's language, chosen by Auto.
let current = CHATS[0];
await context.route(`${BASE}/api/translate`, async (route: any) => {
  await new Promise((r) => setTimeout(r, 700));
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: current.out, language: current.language, from: "chat", lint: [] }) });
});
const page = await context.newPage();
await page.setContent(SCENE);
const frame = await (async () => {
  for (let i = 0; i < 50; i++) { const f = page.frames().find((x: any) => x.url().startsWith(BASE)); if (f) return f; await page.waitForTimeout(100); }
  throw new Error(`the strip's frame didn't load from ${BASE}`);
})();
await frame.waitForFunction("(() => { try { return !!srv && st.teams !== null; } catch (e) { return false; } })()");
await frame.addStyleTag({ content: "#preview { display: none !important; }" }); // the browser-only note isn't in the app
await frame.waitForTimeout(300);

const dir = mkdtempSync(join(tmpdir(), "strip-demo-"));
const THEMES = [{ name: "dark", bg: "#0d1117" }, { name: "light", bg: "#ffffff" }]; // GitHub's page colors
const frames: { file: string; ms: number }[] = []; // file has a {theme} slot
const snap = async (ms: number) => {
  const file = join(dir, `f${String(frames.length).padStart(4, "0")}-{theme}.png`);
  for (const t of THEMES) {
    await page.evaluate((bg: string) => { document.documentElement.style.background = bg; }, t.bg);
    await page.screenshot({ path: file.replace("{theme}", t.name) });
  }
  frames.push({ file, ms });
};
// Real time passes while frames are taken, so a wait records what animates meanwhile.
const record = async (total: number, every = 90) => { const t0 = Date.now(); while (Date.now() - t0 < total) await snap(every); };
// The key hint, given time to finish fading in or out before the next frame.
const hint = async (html: string) => {
  await page.evaluate((h: string) => { const e = document.getElementById("hint")!; if (h) e.innerHTML = h; e.classList.toggle("on", !!h); }, html);
  await page.waitForTimeout(220);
};
const stateIs = (s: string) => frame.evaluate(() => document.getElementById("strip")!.dataset.state).then((x: string) => x === s);
// Frames until the strip reaches a state, spread over a set time, so the GIF doesn't wait as long as the mock does.
const until = async (state: string, ms: number) => {
  const first = frames.length;
  while (!(await stateIs(state))) await snap(90);
  const n = frames.length - first;
  for (let i = first; i < frames.length; i++) frames[i].ms = Math.max(40, Math.round(ms / Math.max(1, n)));
};

// Teams opens a chat: the window shows it, and the strip hears about it as the app would tell it.
const openChat = async (c: (typeof CHATS)[number]) => {
  current = c;
  await page.evaluate((id: string) => { for (const e of document.querySelectorAll(".chat")) e.classList.toggle("on", e.id === `chat-${id}`); }, c.id);
  await frame.evaluate((c: any) => (window as any).strip.teams({ open: true, chat: c.name, from: c.name, last: c.msgs[1], draft: false, shape: "ok" }), c);
};
// One message, start to end: type it, ⏎, read the reply, ⌘⏎, and it shows in the chat.
const tell = async (c: (typeof CHATS)[number]) => {
  await frame.click("#es");
  await snap(250);
  for (let i = 2; i <= c.write.length; i += 2) { await frame.fill("#es", c.write.slice(0, i)); await snap(55); }
  await frame.fill("#es", c.write);
  await snap(600);

  await hint("<kbd>⏎</kbd>Translate");
  await snap(450);
  await frame.press("#es", "Enter");
  await snap(250);
  await hint("");
  await until("ready", 800);
  await snap(2000);

  await hint("<kbd>⌘⏎</kbd>Send");
  await snap(450);
  await frame.press("#es", "Meta+Enter");
  await snap(200);
  await hint("");
  await until("sent", 600);
  await page.evaluate((c: any) => { const m = document.getElementById(`mine-${c.id}`)!; m.querySelector(".bub")!.textContent = c.out; m.classList.add("in"); }, c);
  await record(400, 60);
};

await openChat(CHATS[0]);
await frame.waitForTimeout(300);
await snap(1200); // the chat, and the strip waiting
await tell(CHATS[0]);
for (const c of CHATS.slice(1)) {
  await snap(1600);
  await openChat(c);
  await record(300, 60);
  await snap(900);
  await tell(c);
}
await snap(2500);
await browser.close();

// The GIFs: each frame for its time, scaled to 880 px, one palette for the whole story.
for (const t of THEMES) {
  const at = (f: string) => f.replace("{theme}", t.name);
  const list = frames.map((f) => `file '${at(f.file)}'\nduration ${(f.ms / 1000).toFixed(3)}`).join("\n") + `\nfile '${at(frames.at(-1)!.file)}'\n`;
  writeFileSync(join(dir, `list-${t.name}.txt`), list);
  const out = join(ROOT, "docs", `demo-${t.name}.gif`);
  const ff = Bun.spawnSync(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", join(dir, `list-${t.name}.txt`), "-fps_mode", "vfr",
    "-vf", `scale=${W}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop", "0", out]);
  if (ff.exitCode !== 0) { console.error(String(ff.stderr)); process.exit(1); }
  console.log(`docs/demo-${t.name}.gif, ${frames.length} frames`);
}
rmSync(dir, { recursive: true, force: true });
