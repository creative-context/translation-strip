// The server end to end, on port 4811, with a temp STRIP_DIR, a stand-in `claude`
// (test/fake-claude.ts) and a stand-in linter (test/fake-lint.ts). Made-up messages only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PORT = 4811;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), "strip-test-"));
const GUIDE = join(DIR, "guide.md");
const GUIDE_TEXT = "Short sentences. Friendly, never stiff.\nNo exclamation marks in formal messages.\nSay thanks once.";
const SETTINGS = join(DIR, "settings.json");
const LAUNCHER = join(DIR, "claude");
const LIMIT_UNTIL = "2030-01-01T00:00:00.000Z";

let server: Subprocess;
let parent: Subprocess; // stands in for the app: the server stops when it's gone

const writeSettings = (s: object) => writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
const state = async () => (await fetch(`${BASE}/api/state`)).json() as Promise<any>;
const post = async (path: string, body: object = {}) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const starts = () =>
  existsSync(join(DIR, "fake-starts.jsonl"))
    ? readFileSync(join(DIR, "fake-starts.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}
const statusIs = (s: string) => until(`status ${s}`, async () => ((await state()).translator.status === s ? await state() : false));

beforeAll(async () => {
  writeFileSync(GUIDE, GUIDE_TEXT);
  writeSettings({ voiceGuide: GUIDE, linter: join(ROOT, "test/fake-lint.ts"), model: "haiku", mode: "send" });
  writeFileSync(LAUNCHER, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test/fake-claude.ts")}" "$@"\n`);
  chmodSync(LAUNCHER, 0o755);
  parent = Bun.spawn(["sleep", "600"]);
  server = Bun.spawn([process.execPath, join(ROOT, "server.ts")], {
    cwd: ROOT,
    env: { ...process.env, STRIP_PORT: String(PORT), STRIP_DIR: DIR, STRIP_CLAUDE: LAUNCHER, STRIP_PARENT_PID: String(parent.pid), CLAUDECODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
});

afterAll(() => {
  try { server.kill(); } catch {}
  try { parent.kill(); } catch {}
  rmSync(DIR, { recursive: true, force: true });
});

describe("Translation Strip server", () => {
  test("starts, then gets ready", async () => {
    const first = await until("the server", () => state());
    expect(["starting", "ready"]).toContain(first.translator.status);
    expect(first.server.version).toBe(require("../package.json").version);
    expect(first.settings).toEqual({ model: "haiku", mode: "send" });
    expect(JSON.stringify(first)).not.toContain(DIR); // no paths reach the page
    const s = await statusIs("ready");
    expect(s.translator).toMatchObject({ error: null, model: "haiku", guide: "ok", linter: "ok" });
  });

  test("starts claude quietly, with the guide as its system prompt", () => {
    const s = starts()[0];
    expect(s.model).toBe("haiku");
    for (const flag of ["-p", "--input-format", "--output-format", "--verbose", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) expect(s.args).toContain(flag);
    expect(s.args[s.args.indexOf("--tools") + 1]).toBe("");
    expect(s.args[s.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(s.args.join(" ")).not.toContain("Short sentences"); // the guide is never on the command line
    expect(s.systemHasProtocol).toBe(true);
    expect(s.systemGuide).toBe(GUIDE_TEXT);
    expect(s.systemHasCheck).toBe(true); // the add-nothing check comes after the guide
    expect(s.disableClaudeMds).toBe("1");
    expect(s.inheritedSessionVar).toBeNull();
    expect(s.cwd.endsWith("/translator")).toBe(true);
  });

  test("polishes a message", async () => {
    const r = await post("/api/translate", { text: "¿me mandas las slides antes de comer?", register: "normal", context: { chat: "Design review", from: "Sam Lee", last: "I'll share the deck later." } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ english: "Can you send me the slides before lunch?", lint: [] });
    const f = await post("/api/translate", { text: "¿me mandas las slides antes de comer?", register: "formal" });
    expect(f.body.english).toBe("Could you please send me the slides before lunch?");
  });

  test("takes the reply's JSON even with words around it", async () => {
    const r = await post("/api/translate", { text: "CHATTY ¿me mandas las slides?", register: "normal" });
    expect(r.body.english).toBe("Can you send me the slides before lunch?");
  });

  test("returns the linter's findings", async () => {
    const r = await post("/api/translate", { text: "KINDLY ¿me mandas las slides?", register: "normal" });
    expect(r.status).toBe(200);
    expect(r.body.english).toContain("kindly");
    expect(r.body.lint).toEqual([{ level: "error", message: "Sounds stiff: «kindly»" }]);
  });

  test("asks a question when something important is unclear", async () => {
    const r = await post("/api/translate", { text: "UNCLEAR mándame el reporte", register: "normal" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ question: "Which report do you mean, the weekly one or the budget one?" });
  });

  test("adjusts the English with a note", async () => {
    const r = await post("/api/adjust", { text: "¿me mandas las slides?", english: "Can you send me the slides before lunch?", note: "add thanks", register: "normal" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ english: "Can you send me the slides before lunch?, thanks!", lint: [] });
  });

  test("rejects bad requests", async () => {
    expect((await post("/api/translate", { text: "  " })).status).toBe(400);
    expect((await post("/api/adjust", { text: "hola", english: "Hi" })).status).toBe(400);
  });

  test("one request at a time: a second one gets 409 busy", async () => {
    const slow = post("/api/translate", { text: "SLOW ¿me mandas las slides?", register: "normal" });
    await statusIs("busy");
    const second = await post("/api/translate", { text: "otra cosa", register: "normal" });
    expect(second).toEqual({ status: 409, body: { error: "busy" } });
    expect((await slow).status).toBe(200);
    await statusIs("ready");
  });

  test("the plan's limit, with until", async () => {
    const r = await post("/api/translate", { text: "LIMIT ¿me mandas las slides?", register: "normal" });
    expect(r).toEqual({ status: 503, body: { error: "limit", until: LIMIT_UNTIL } });
    const s = await state();
    expect(s.translator).toMatchObject({ status: "error", error: "limit", until: LIMIT_UNTIL });
    // The next one that goes through clears it.
    expect((await post("/api/translate", { text: "¿me mandas las slides?" })).status).toBe(200);
    expect((await state()).translator).toMatchObject({ status: "ready", error: null, until: null });
  });

  test("a crash fails the request, and the translator restarts", async () => {
    const before = starts().length;
    const r = await post("/api/translate", { text: "CRASH ¿me mandas las slides?", register: "normal" });
    expect(r).toEqual({ status: 503, body: { error: "failed" } });
    await statusIs("ready");
    expect(starts().length).toBe(before + 1);
    expect((await post("/api/translate", { text: "¿me mandas las slides?" })).status).toBe(200);
  });

  test("settings: writes the file, and a new model restarts the translator", async () => {
    const before = starts().length;
    const r = await post("/api/settings", { mode: "leave" });
    expect(r).toEqual({ status: 200, body: { settings: { model: "haiku", mode: "leave" } } });
    expect(starts().length).toBe(before); // mode alone doesn't restart

    const m = await post("/api/settings", { model: "sonnet" });
    expect(m.body.settings).toEqual({ model: "sonnet", mode: "leave" });
    const file = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(file).toMatchObject({ model: "sonnet", mode: "leave", voiceGuide: GUIDE }); // the paths stay
    await until("a sonnet start", async () => starts().at(-1)?.model === "sonnet");
    const s = await statusIs("ready");
    expect(s.translator.model).toBe("sonnet");
    expect(s.settings).toEqual({ model: "sonnet", mode: "leave" });

    expect((await post("/api/settings", { model: "gpt" })).status).toBe(400);
  });

  test("restart on request", async () => {
    const before = starts().length;
    expect(await post("/api/translator/restart")).toEqual({ status: 200, body: {} });
    await until("a new start", async () => starts().length === before + 1);
    await statusIs("ready");
  });

  test("no voice guide: the guide error", async () => {
    rmSync(GUIDE);
    await post("/api/translator/restart");
    const s = await statusIs("error");
    expect(s.translator).toMatchObject({ error: "guide", guide: "missing" });
    expect(await post("/api/translate", { text: "¿me mandas las slides?" })).toEqual({ status: 503, body: { error: "guide" } });

    writeFileSync(GUIDE, GUIDE_TEXT);
    await post("/api/translator/restart");
    expect((await statusIs("ready")).translator.guide).toBe("ok");
  });

  test("no linter: no findings, and the state says so", async () => {
    writeSettings({ voiceGuide: GUIDE, model: "sonnet", mode: "leave" });
    await until("linter missing", async () => (await state()).translator.linter === "missing");
    const r = await post("/api/translate", { text: "KINDLY ¿me mandas las slides?" });
    expect(r.body.lint).toEqual([]);
  });

  test("answers only its own host name", async () => {
    const r = await fetch(`${BASE}/api/state`, { headers: { host: "example.test" } });
    expect(r.status).toBe(403);
  });

  test("ends when the app is gone", async () => {
    parent.kill();
    const code = await Promise.race([server.exited, Bun.sleep(9000).then(() => "still running")]);
    expect(code).toBe(0);
  }, 12000);
});
