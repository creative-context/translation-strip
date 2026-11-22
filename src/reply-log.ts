// The server's one log line per answered request, `reply: …`: numbers and fixed words only, never a
// message's text, a language note or a chat's name. Pure functions, so the tests check every shape.
//
// Claude: `reply: claude <model> <ms> ms · in <n>, out <n>, cache read <n>, cache written <n> · lint <n> errors · fix kept|dropped|none · tries <n>`,
// the token counts from the turns' `result` messages (`usage`), each left out when Claude Code didn't
// give it (and the whole part when it gave none), and ` · answered by <model>` when the fallback model
// wrote the reply (Opus busy, Sonnet answered); a question: `reply: claude <model> <ms> ms · question`.
// Mac: `reply: mac <ms> ms · <bucket> chars · lint <n> errors`, with ` · stand-in for <error>` when it
// stood in for Claude.

// Token counts, summed over every turn the request took (a second try, the linter's fix).
export type Usage = { in?: number; out?: number; cacheRead?: number; cacheWritten?: number };

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

// The counts in a stream-json `result` message's `usage` (the API's own names), or null when it has none.
export function usageOf(m: any): Usage | null {
  const u = m?.usage;
  if (!u || typeof u !== "object") return null;
  const out: Usage = {};
  const pairs: [keyof Usage, unknown][] = [["in", u.input_tokens], ["out", u.output_tokens], ["cacheRead", u.cache_read_input_tokens], ["cacheWritten", u.cache_creation_input_tokens]];
  for (const [k, v] of pairs) {
    const n = count(v);
    if (n !== undefined) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

// Two turns' counts together: a count either one gave, summed; null when neither gave any.
export function addUsage(a: Usage | null | undefined, b: Usage | null | undefined): Usage | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const out: Usage = {};
  for (const k of ["in", "out", "cacheRead", "cacheWritten"] as const) {
    if (a[k] !== undefined || b[k] !== undefined) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  }
  return out;
}

// A text's length as one of four buckets, the same the shell's send line uses.
export function charsBucket(chars: number): string {
  if (chars < 100) return "under 100";
  if (chars < 500) return "100 to 499";
  if (chars < 2000) return "500 to 1,999";
  return "2,000 or more";
}

// A text's length in characters (code points), never the text.
export const charsOf = (text: string) => [...text].length;

const ms = (n: number) => `${Math.max(0, Math.round(n))} ms`;

// A model name is one word the server chose (haiku, sonnet, opus); anything else is cut to safe letters.
const word = (s: string) => s.replace(/[^\w.-]/g, "").slice(0, 40) || "unknown";

function usageWords(u: Usage | null | undefined): string | null {
  if (!u) return null;
  const parts = [
    u.in !== undefined ? `in ${u.in}` : null,
    u.out !== undefined ? `out ${u.out}` : null,
    u.cacheRead !== undefined ? `cache read ${u.cacheRead}` : null,
    u.cacheWritten !== undefined ? `cache written ${u.cacheWritten}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export type Fix = "kept" | "dropped" | "none";

export function claudeReplyLine(x: { model: string; ms: number; usage?: Usage | null; lintErrors: number; fix: Fix; tries: number; answeredBy?: string | null }): string {
  const u = usageWords(x.usage);
  return [`reply: claude ${word(x.model)} ${ms(x.ms)}`, ...(u ? [u] : []), `lint ${x.lintErrors} errors`, `fix ${x.fix}`, `tries ${x.tries}`, ...(x.answeredBy ? [`answered by ${word(x.answeredBy)}`] : [])].join(" · ");
}

export function claudeQuestionLine(x: { model: string; ms: number }): string {
  return `reply: claude ${word(x.model)} ${ms(x.ms)} · question`;
}

export function macReplyLine(x: { ms: number; chars: number; lintErrors: number; standIn?: string | null }): string {
  return [`reply: mac ${ms(x.ms)}`, `${charsBucket(x.chars)} chars`, `lint ${x.lintErrors} errors`, ...(x.standIn ? [`stand-in for ${word(x.standIn)}`] : [])].join(" · ");
}
