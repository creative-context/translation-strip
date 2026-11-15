// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the
// tests. It speaks the same stream-json as Claude Code 2.1 (the shapes seen in real runs: a
// system init on each turn, assistant messages with text blocks, a rate_limit_event, a result)
// and answers by content, with made-up English and the request's id:
//   "UNCLEAR" → a question; "LIMIT" → the usage-limit error with a reset time; "CRASH" → exits;
//   "SLOW" → answers after 1.5 s; "HANG" → never answers (the server's timeout ends it); "KINDLY" → English the stand-in linter flags;
//   "CHATTY" → the JSON object with words around it; "WRONGID" → a reply carrying another id;
//   "MEMORY" → English that says how many turns this process has seen and the texts before this one;
//   "EXIT-LOGIN", "EXIT-UPDATE", "EXIT-OFFLINE", "EXIT-LIMIT" → made-up Claude Code words on stderr, then exits 1;
//   an adjust whose note names «kindly» (the server's linter fix) → the English without "kindly", or unchanged with "STUBBORN";
//   "PROMPT-ONCE" → the first session that sees it can't read its system prompt (Claude Code's words on stderr)
//   and exits 1, and the next one answers; "HANG-ONCE" → the first never answers, the next one does;
//   "WRONGID-ONCE" → the first answers with another request's id, the next one answers right.
// `--version` prints a made-up version. Each start appends a line to $STRIP_DIR/fake-starts.jsonl with
// what it was started with, and each turn a line to fake-turns.jsonl (its pid, task, id and turn number).
// When $STRIP_DIR/fake-exit-at-start exists, a start prints its text on stderr and exits 1 at once.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const DIR = process.env.STRIP_DIR ?? ".";
if (args.includes("--version")) {
  console.log("2.1.0 (Claude Code stand-in)");
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
    systemHasProtocol: system.includes('"english":') && system.includes('Copy it, unchanged, into your reply'),
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
const assistant = (text: string) => out({ type: "assistant", message: { model: `claude-${model}-test`, id: `msg_${Date.now()}`, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: null }, parent_tool_use_id: null, session_id: session, uuid: crypto.randomUUID() });
const result = (text: string, isError = false) => out({ type: "result", subtype: "success", is_error: isError, duration_ms: 20, duration_api_ms: 10, num_turns: 1, result: text, stop_reason: "end_turn", session_id: session, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, uuid: crypto.randomUUID() });
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
  appendFileSync(join(DIR, "fake-turns.jsonl"), JSON.stringify({ pid: process.pid, task: req.task ?? null, id: req.id ?? null, turn: turns }) + "\n");
  const before = [...seen];
  seen.push(text);
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
      const wrong = JSON.stringify({ id: "zzzzzzzz", english: "Can you send me the slides before lunch?" });
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
  if (text.includes("UNCLEAR")) reply = JSON.stringify({ id, question: "Which report do you mean, the weekly one or the budget one?" });
  // The server's linter fix: an adjust whose note names «kindly» drops the word, unless the text says STUBBORN.
  else if (req.task === "adjust" && /«kindly»/.test(String(req.note))) reply = JSON.stringify({ id, english: text.includes("STUBBORN") ? String(req.english) : String(req.english).replace(/\bkindly /i, "") });
  else if (req.task === "adjust") reply = JSON.stringify({ id, english: `${String(req.english).replace(/[.!]$/, "")}, thanks!` });
  else if (text.includes("KINDLY")) reply = JSON.stringify({ id, english: "Could you kindly send me the slides before lunch?" });
  else if (text.includes("MEMORY")) reply = JSON.stringify({ id, english: `Turns seen: ${turns}. Before: ${before.join(" / ") || "nothing"}` });
  else reply = JSON.stringify({ id, english: req.register === "formal" ? "Could you please send me the slides before lunch?" : "Can you send me the slides before lunch?" });
  if (text.includes("CHATTY")) reply = `Here it is:\n${reply}\nHope that helps.`;
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
