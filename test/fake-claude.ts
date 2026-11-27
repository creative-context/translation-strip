// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the
// tests. It speaks the same stream-json as Claude Code 2.1 (the shapes seen in real runs: a
// system init on each turn, assistant messages with text blocks, a rate_limit_event, a result)
// and answers by content, with made-up text and the request's id, in the reply's shape
// { id, text, language, from }. The language is the turn's target ("from": "target"), except that
// with "auto" on and a context whose last message starts "PT:" it is "Português" ("from": "chat").
// Text in a language other than English is the made-up English with "[<language>] " in front.
// The markers:
//   "UNCLEAR" → a question; "LIMIT" → the usage-limit error with a reset time; "CRASH" → exits;
//   "SLOW" → answers after 1.5 s; "HANG" → never answers (the server's timeout ends it); "KINDLY" → English the stand-in linter flags;
//   "CHATTY" → the JSON object with words around it; "WRONGID" → a reply carrying another id;
//   "NOLANG" → a reply that names no language; "SHOUTLANG" → names it in capitals ("PORTUGUÊS");
//   "MEMORY" → English that says how many turns this process has seen and the texts before this one;
//   "EXIT-LOGIN", "EXIT-UPDATE", "EXIT-OFFLINE", "EXIT-LIMIT" → made-up Claude Code words on stderr, then exits 1;
//   an adjust whose note names «kindly» (the server's linter fix) → the current text without "kindly", or unchanged with "STUBBORN";
//   "PROMPT-ONCE" → the first session that sees it can't read its system prompt (Claude Code's words on stderr)
//   and exits 1, and the next one answers; "HANG-ONCE" → the first never answers, the next one does;
//   "WRONGID-ONCE" → the first answers with another request's id, the next one answers right;
//   "BUSY" → with --fallback-model, the reply comes from that model (its assistant message names it), as when the main one is busy;
//   "NOUSAGE" → a result with no usage; "PARTUSAGE" → a usage with only the input and output counts;
//   "TRICKLE" → the reply streams slowly (20 ms between pieces); "ESCAPES" → a reply with a line break, quotes,
//   a backslash, an accent and an emoji, every character past ASCII written as a \u escape, streamed one
//   character at a time, so every escape is split across pieces.
// With --include-partial-messages, each reply also streams before its assistant message, as Claude Code does:
// stream_event lines (message_start, content_block_start, content_block_delta with text_delta pieces of 1 to
// 7 characters, content_block_stop, message_stop).
// Every other result carries made-up token counts in `usage` (the API's names, as Claude Code 2.1 gives
// them) and in `modelUsage`: USAGE below.
// `--version` prints a made-up version, or the text of $STRIP_DIR/fake-version when it exists.
// `--help` prints a made-up help in commander's shape that names every flag the translator passes,
// except `--system-prompt-file`, which Claude Code hides from its help too; each flag named on a line of
// $STRIP_DIR/fake-help-drop is left out, and when $STRIP_DIR/fake-help-fail exists it prints nothing
// and exits 1. Each `--help` appends a line to fake-helps.jsonl. Each start appends a line to $STRIP_DIR/fake-starts.jsonl with
// what it was started with, and each turn a line to fake-turns.jsonl (its pid, task, id, turn number, target, auto, notes and the keys it carried).
// When $STRIP_DIR/fake-exit-at-start exists, a start prints its text on stderr and exits 1 at once.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const DIR = process.env.STRIP_DIR ?? ".";
const fileText = (name: string) => (existsSync(join(DIR, name)) ? readFileSync(join(DIR, name), "utf8").trim() : null);
if (args.includes("--version")) {
  console.log(fileText("fake-version") || "2.1.0 (Claude Code stand-in)");
  process.exit(0);
}
if (args.includes("--help")) {
  appendFileSync(join(DIR, "fake-helps.jsonl"), JSON.stringify({ pid: process.pid }) + "\n");
  if (existsSync(join(DIR, "fake-help-fail"))) {
    process.stderr.write("error: something went wrong\n");
    process.exit(1);
  }
  const drop = new Set((fileText("fake-help-drop") ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  const OPTIONS: [string, string][] = [
    ["-d, --debug [filter]", "Enable debug mode"],
    ["--verbose", "Override verbose mode setting from config"],
    ["--include-partial-messages", "Include partial message chunks as they arrive (only with --print and stream-json)"],
    ["-p, --print", "Print response and exit (useful for pipes)"],
    ["--output-format <format>", 'Output format (only works with --print): "text", "json", or "stream-json"'],
    ["--input-format <format>", 'Input format (only works with --print): "text" or "stream-json"'],
    ["--strict-mcp-config", "Only use MCP servers from --mcp-config"],
    ["--setting-sources <sources>", "Comma-separated list of setting sources to load"],
    ["--tools <tools...>", "The built-in tools to make available"],
    ["--model <model>", "Model for the current session"],
    ["--fallback-model <model>", "Models to fall back to when the main model is busy or unavailable"],
    ["--effort <level>", "Effort level for the current session (low, medium, high, xhigh, max)"],
    ["--disable-slash-commands", "Disable all skills"],
    ["--no-session-persistence", "Disable session persistence"],
    ["-v, --version", "Output the version number"],
    ["-h, --help", "Display help for command"],
  ];
  const named = (spec: string) => spec.match(/--?[A-Za-z][\w-]*/g) ?? [];
  const lines = OPTIONS.filter(([spec]) => !named(spec).some((f) => drop.has(f))).map(([spec, what]) => `  ${spec.padEnd(32)}${what}`);
  console.log(["Usage: claude [options] [command] [prompt]", "", "Made-up help for the tests.", "", "Options:", ...lines].join("\n"));
  process.exit(0);
}
// A marker the tests look for in the server's log: it must never be there.
const SECRET = "STDERR-SECRET-7f3a";
const STDERR: Record<string, string> = {
  LOGIN: `Invalid API key · Please run /login ${SECRET}`,
  UPDATE: `error: unknown option '--strict-mcp-config' ${SECRET}`,
  OFFLINE: `API Error: Connection error. getaddrinfo ENOTFOUND ${SECRET}`,
  LIMIT: `Claude usage limit reached ${SECRET}`,
};
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const model = arg("--model") ?? "default";
const session = crypto.randomUUID();

let system = "";
const file = arg("--system-prompt-file");
try {
  if (file) system = readFileSync(file, "utf8");
} catch {}

appendFileSync(
  join(DIR, "fake-starts.jsonl"),
  JSON.stringify({
    pid: process.pid,
    model,
    cwd: process.cwd(),
    args: args.filter((a) => a !== system),
    systemHasProtocol: system.includes('"language":') && system.includes('Copy it, unchanged, into your reply'),
    systemGuide: system.split("# The user's voice guide")[1]?.split("# Before you reply")[0].trim() ?? null,
    systemHasCheck: system.includes("# Before you reply"),
    disableClaudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null,
    inheritedSessionVar: process.env.CLAUDECODE ?? null,
  }) + "\n",
);

if (existsSync(join(DIR, "fake-exit-at-start"))) {
  process.stderr.write(readFileSync(join(DIR, "fake-exit-at-start"), "utf8") + "\n");
  process.exit(1);
}

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const init = () => out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: session, tools: [], mcp_servers: [], model: `claude-${model}-test`, permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.0", uuid: crypto.randomUUID() });
const fallback = arg("--fallback-model");
let speaking = model; // the model this turn's assistant messages name
const partials = args.includes("--include-partial-messages");
const event = (e: unknown) => out({ type: "stream_event", event: e, session_id: session, parent_tool_use_id: null, uuid: crypto.randomUUID() });
// The reply in pieces, as Claude Code streams it with --include-partial-messages. size: each piece's length
// (by default 1 to 7 characters, in a fixed pattern); ms: the wait between pieces.
async function stream(text: string, ms = 0, size?: number) {
  if (!partials) return;
  event({ type: "message_start", message: { model: `claude-${speaking}-test`, id: `msg_${Date.now()}`, type: "message", role: "assistant", content: [] } });
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0, k = 0; i < text.length; k++) {
    const n = size ?? 1 + ((k * 3) % 7);
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + n) } });
    i += n;
    if (ms) await Bun.sleep(ms);
  }
  event({ type: "content_block_stop", index: 0 });
  event({ type: "message_stop" });
}
const assistant = (text: string) => out({ type: "assistant", message: { model: `claude-${speaking}-test`, id: `msg_${Date.now()}`, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: null }, parent_tool_use_id: null, session_id: session, uuid: crypto.randomUUID() });
// Made-up token counts, the same on every turn, so the tests can check the sums.
const USAGE = { input_tokens: 12, cache_creation_input_tokens: 345, cache_read_input_tokens: 6789, output_tokens: 23 };
let usage: Record<string, number> | null = USAGE; // this turn's, set by its markers
const result = (text: string, isError = false) =>
  out({
    type: "result", subtype: "success", is_error: isError, duration_ms: 20, duration_api_ms: 10, num_turns: 1, result: text, stop_reason: "end_turn", session_id: session, total_cost_usd: 0,
    ...(usage ? { usage: { ...usage, server_tool_use: { web_search_requests: 0 }, service_tier: "standard" } } : {}),
    ...(usage ? { modelUsage: { [`claude-${model}-test`]: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadInputTokens: usage.cache_read_input_tokens ?? 0, cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0, costUSD: 0 } } } : {}),
    uuid: crypto.randomUUID(),
  });
const rateLimit = (status: string, resetsAt: number) => out({ type: "rate_limit_event", rate_limit_info: { status, resetsAt, rateLimitType: "five_hour" }, uuid: crypto.randomUUID(), session_id: session });

const LIMIT_RESETS_AT = 1893456000; // 2030-01-01T00:00:00Z

let turns = 0;
const seen: string[] = [];

async function turn(content: string) {
  let req: any = {};
  try {
    req = JSON.parse(content);
  } catch {}
  const text: string = req.text ?? "";
  turns++;
  appendFileSync(join(DIR, "fake-turns.jsonl"), JSON.stringify({ pid: process.pid, task: req.task ?? null, id: req.id ?? null, turn: turns, target: req.target ?? null, auto: req.auto ?? null, notes: req.notes ?? null, keys: Object.keys(req) }) + "\n");
  const before = [...seen];
  seen.push(text);
  usage = text.includes("NOUSAGE") ? null : text.includes("PARTUSAGE") ? { input_tokens: USAGE.input_tokens, output_tokens: USAGE.output_tokens } : USAGE;
  speaking = text.includes("BUSY") && fallback ? fallback : model;
  init();
  const exit = text.match(/EXIT-(LOGIN|UPDATE|OFFLINE|LIMIT)/);
  if (exit) {
    process.stderr.write(STDERR[exit[1]] + "\n");
    await Bun.sleep(20);
    process.exit(1);
  }
  // The -ONCE words: a marker in $STRIP_DIR says the first session already met this text.
  const once = text.match(/(PROMPT|HANG|WRONGID)-ONCE/);
  if (once && !existsSync(join(DIR, `fake-once-${once[1]}`))) {
    appendFileSync(join(DIR, `fake-once-${once[1]}`), "1");
    if (once[1] === "HANG") return new Promise<void>(() => {});
    if (once[1] === "WRONGID") {
      const wrong = JSON.stringify({ id: "zzzzzzzz", text: "Can you send me the slides before lunch?", language: "English", from: "target" });
      await stream(wrong);
      assistant(wrong);
      return result(wrong);
    }
    process.stderr.write("Error reading system prompt file: EACCES: permission denied, open '/dev/fd/3'\n");
    await Bun.sleep(20);
    process.exit(1);
  }
  if (text.includes("CRASH")) process.exit(1);
  if (!once && text.includes("HANG")) return new Promise<void>(() => {});
  if (text.includes("SLOW")) await Bun.sleep(1500);
  else await Bun.sleep(30);
  if (text.includes("LIMIT")) {
    rateLimit("rejected", LIMIT_RESETS_AT);
    assistant("You've hit your limit · resets 3pm");
    return result("You've hit your limit · resets 3pm", true);
  }
  let reply: string;
  const id = text.includes("WRONGID") && !once ? "zzzzzzzz" : req.id;
  const fromChat = req.task !== "adjust" && req.auto === true && /^PT:/.test(String(req.context?.last ?? ""));
  const language: string = fromChat ? "Português" : String(req.target ?? "English");
  const from = fromChat ? "chat" : "target";
  const inLanguage = (english: string) => (language === "English" ? english : `[${language}] ${english}`);
  const answer = (message: string) => JSON.stringify({ id, text: message, ...(text.includes("NOLANG") ? {} : { language: text.includes("SHOUTLANG") ? language.toUpperCase() : language }), from });
  const current = String(req.current ?? "");
  if (text.includes("UNCLEAR")) reply = JSON.stringify({ id, question: "Which report do you mean, the weekly one or the budget one?" });
  // The server's linter fix: an adjust whose note names «kindly» drops the word, unless the text says STUBBORN.
  else if (req.task === "adjust" && /«kindly»/.test(String(req.note))) reply = answer(text.includes("STUBBORN") ? current : current.replace(/\bkindly /i, ""));
  else if (req.task === "adjust") reply = answer(`${current.replace(/[.!]$/, "")}, thanks!`);
  // Dictation checked by Claude: the words it misheard ("pre su puesto") fixed, the rest as heard.
  else if (req.task === "fix") reply = answer(text.replace(/\bpre su puesto\b/g, "presupuesto"));
  else if (text.includes("KINDLY")) reply = answer(inLanguage("Could you kindly send me the slides before lunch?"));
  else if (text.includes("MEMORY")) reply = answer(`Turns seen: ${turns}. Before: ${before.join(" / ") || "nothing"}`);
  else if (text.includes("ESCAPES")) reply = answer("First line\nShe said \"fine\" \\ café 😀 done").replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  else reply = answer(inLanguage(req.register === "formal" ? "Could you please send me the slides before lunch?" : "Can you send me the slides before lunch?"));
  if (text.includes("CHATTY")) reply = `Here it is:\n${reply}\nHope that helps.`;
  await stream(reply, text.includes("TRICKLE") ? 20 : 0, text.includes("ESCAPES") ? 1 : undefined);
  assistant(reply);
  rateLimit("allowed", LIMIT_RESETS_AT);
  result(reply);
}

// One turn at a time, in order, like the real CLI.
const dec = new TextDecoder();
let buf = "";
let chain = Promise.resolve();
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m?.type !== "user") continue;
    const content = typeof m.message?.content === "string" ? m.message.content : (m.message?.content?.[0]?.text ?? "");
    chain = chain.then(() => turn(content));
  }
}
await chain;
