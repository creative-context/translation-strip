// A stand-in for the app's translate-on-mac helper, for the tests: the same JSON lines (the first
// one { "ready": true }, then one reply per request, by id), with made-up text. It answers in the
// request's target ("from": "target"), except that with "auto" on and a "last" that starts "PT:" it
// answers in Português ("from": "chat"). Text in a language other than English is the made-up
// English with "[<language>] " in front. The markers:
//   "MAC-LANG" → the language error (Español to Polski isn't on this Mac); "MAC-FAIL" → { error: "failed" };
//   "MAC-SLOW" → answers after 1.5 s; "MAC-KINDLY" → text the stand-in linter flags;
//   "MAC-LIST" → a list with the blank lines Translation adds; "MAC-SMILE" → emoticons, in a link and in a word too;
//   "MAC-DIE" → exits without answering; "MAC-DIE-ONCE" → the first helper that sees it exits, the next one answers.
// Each start appends a line to $STRIP_DIR/fake-mac-starts.jsonl, and each request a line to
// fake-mac-requests.jsonl (its pid, keys, target, auto, last and hint). When $STRIP_DIR/fake-mac-cant
// exists, it says it can't and exits.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.STRIP_DIR ?? ".";
const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
appendFileSync(join(DIR, "fake-mac-starts.jsonl"), JSON.stringify({ pid: process.pid }) + "\n");
if (existsSync(join(DIR, "fake-mac-cant"))) {
  out({ ready: false, error: "mac" });
  process.exit(0);
}
out({ ready: true });

async function answer(req: any) {
  const text = String(req.text ?? "");
  appendFileSync(join(DIR, "fake-mac-requests.jsonl"), JSON.stringify({ pid: process.pid, keys: Object.keys(req), target: req.target ?? null, auto: req.auto ?? null, last: req.last ?? null, hint: req.hint ?? null }) + "\n");
  const once = join(DIR, "fake-mac-died-once");
  if (text.includes("MAC-DIE-ONCE")) {
    if (!existsSync(once)) {
      appendFileSync(once, "1");
      process.exit(1);
    }
  } else if (text.includes("MAC-DIE")) process.exit(1);
  if (text.includes("MAC-SLOW")) await Bun.sleep(1500);
  if (text.includes("MAC-LANG")) return out({ id: req.id, error: "language", source: "Español", language: "Polski" });
  if (text.includes("MAC-FAIL")) return out({ id: req.id, error: "failed" });
  const fromChat = req.auto === true && /^PT:/.test(String(req.last ?? ""));
  const language = fromChat ? "Português" : String(req.target ?? "English");
  const inLanguage = (english: string) => (language === "English" ? english : `[${language}] ${english}`);
  let reply = "Can you send me the slides before lunch?";
  if (text.includes("MAC-KINDLY")) reply = "Could you kindly send me the slides before lunch?";
  if (text.includes("MAC-LIST")) reply = "To do tomorrow:\n\n- the slides\n\n- the budget";
  if (text.includes("MAC-SMILE")) reply = ":) Thanks :-) see https://example.test/:D and a:)b ;) ok :(. Sure :D";
  out({ id: req.id, text: inLanguage(reply), language, from: fromChat ? "chat" : "target" });
}

const dec = new TextDecoder();
let buf = "";
let chain = Promise.resolve();
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    chain = chain.then(() => answer(req));
  }
}
await chain;
