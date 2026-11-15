// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the
// tests. It speaks the same stream-json as Claude Code 2.1 (the shapes seen in real runs: a
// system init on each turn, assistant messages with text blocks, a rate_limit_event, a result)
// and answers by content, with made-up English:
//   "UNCLEAR" → a question; "LIMIT" → the usage-limit error with a reset time; "CRASH" → exits;
//   "SLOW" → answers after 1.5 s; "KINDLY" → English the stand-in linter flags;
//   "CHATTY" → the JSON object with words around it.
// Each start appends a line to $STRIP_DIR/fake-starts.jsonl with what it was started with.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
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
  join(process.env.STRIP_DIR ?? ".", "fake-starts.jsonl"),
  JSON.stringify({
    pid: process.pid,
    model,
    cwd: process.cwd(),
    args: args.filter((a) => a !== system),
    systemHasProtocol: system.includes('{"english":'),
    systemGuide: system.split("# The user's voice guide")[1]?.split("# Before you reply")[0].trim() ?? null,
    systemHasCheck: system.includes("# Before you reply"),
    disableClaudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null,
    inheritedSessionVar: process.env.CLAUDECODE ?? null,
  }) + "\n",
);

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const init = () => out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: session, tools: [], mcp_servers: [], model: `claude-${model}-test`, permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.0", uuid: crypto.randomUUID() });
const assistant = (text: string) => out({ type: "assistant", message: { model: `claude-${model}-test`, id: `msg_${Date.now()}`, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: null }, parent_tool_use_id: null, session_id: session, uuid: crypto.randomUUID() });
const result = (text: string, isError = false) => out({ type: "result", subtype: "success", is_error: isError, duration_ms: 20, duration_api_ms: 10, num_turns: 1, result: text, stop_reason: "end_turn", session_id: session, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, uuid: crypto.randomUUID() });
const rateLimit = (status: string, resetsAt: number) => out({ type: "rate_limit_event", rate_limit_info: { status, resetsAt, rateLimitType: "five_hour" }, uuid: crypto.randomUUID(), session_id: session });

const LIMIT_RESETS_AT = 1893456000; // 2030-01-01T00:00:00Z

async function turn(content: string) {
  let req: any = {};
  try {
    req = JSON.parse(content);
  } catch {}
  const text: string = req.text ?? "";
  init();
  if (req.task === "ready") {
    await Bun.sleep(Number(process.env.FAKE_WARMUP_MS ?? 300));
    assistant('{"ready": true}');
    rateLimit("allowed", LIMIT_RESETS_AT);
    return result('{"ready": true}');
  }
  if (text.includes("CRASH")) process.exit(1);
  if (text.includes("SLOW")) await Bun.sleep(1500);
  else await Bun.sleep(30);
  if (text.includes("LIMIT")) {
    rateLimit("rejected", LIMIT_RESETS_AT);
    assistant("You've hit your limit · resets 3pm");
    return result("You've hit your limit · resets 3pm", true);
  }
  let reply: string;
  if (text.includes("UNCLEAR")) reply = JSON.stringify({ question: "Which report do you mean, the weekly one or the budget one?" });
  else if (req.task === "adjust") reply = JSON.stringify({ english: `${String(req.english).replace(/[.!]$/, "")}, thanks!` });
  else if (text.includes("KINDLY")) reply = JSON.stringify({ english: "Could you kindly send me the slides before lunch?" });
  else reply = JSON.stringify({ english: req.register === "formal" ? "Could you please send me the slides before lunch?" : "Can you send me the slides before lunch?" });
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
