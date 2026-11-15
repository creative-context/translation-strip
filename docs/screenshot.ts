// Draws docs/screenshot.png: the strip with a translation ready, made-up text, in WebKit at 2x.
// Needs the page mock running (`bun test/page-mock.ts`, port 4813) and Playwright (PLAYWRIGHT_DIR,
// by default the one in ../mac-app-design). Run from the repo: `bun docs/screenshot.ts`.
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BASE = process.env.PAGE_MOCK ?? "http://127.0.0.1:4813";
const PW = process.env.PLAYWRIGHT_DIR ?? resolve(ROOT, "..", "mac-app-design", "node_modules", "playwright");
const { webkit } = await import(PW);

const ES = "¿Puedes revisar el presupuesto antes del jueves? Si hace falta, lo vemos en la llamada.";
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 145 }, deviceScaleFactor: 2, colorScheme: "dark" });
await page.goto(`${BASE}/`);
await page.waitForFunction("(() => { try { return !!srv && st.teams !== null; } catch (e) { return false; } })()");
// The note that says the browser preview sends nothing isn't in the app.
await page.addStyleTag({ content: "#preview { display: none !important; }" });
await page.click("#es");
await page.fill("#es", ES);
await page.press("#es", "Enter");
await page.waitForFunction(() => document.getElementById("strip")!.dataset.state === "ready");
await page.click("#es");
await page.waitForTimeout(400);
await page.screenshot({ path: join(ROOT, "docs", "screenshot.png") });
await browser.close();
console.log("docs/screenshot.png");
