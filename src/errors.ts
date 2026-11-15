// Tells apart the errors the page shows: login, update, offline, limit (with until when Claude
// Code gives a reset time) and failed. Reads Claude Code's own error text (a turn's error result,
// or the first 2 KB of a session's stderr, held in memory only), never the user's message.
import type { TranslatorError } from "./state";

// What the stream's last rate_limit_event said, for the turn in progress.
export type RateLimit = { status?: string; resetsAt?: number } | null;

const LIMIT = /hit your (?:[\w' ]{0,40} )?limit|usage limit|limit reached|rate.?limit(?:ed)?\b|out of (?:extra )?usage|quota/i;
const OFFLINE = /connection (?:error|refused|reset|closed)|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|unable to connect|socket hang up|offline|internet/i;

// Claude Code isn't signed in, or its login ran out.
const LOGIN = /not (?:logged|signed) in|please run \/login|run `?claude`? (?:\/)?login|invalid api key|(?:oauth|access) token (?:has )?(?:expired|revoked)|authentication[_ ](?:error|failed)|unauthori[sz]ed/i;
// Claude Code refused the app's options: a flag renamed or removed by an update.
const UPDATE = /unknown (?:option|argument|flag)|unrecognized (?:option|argument)|unexpected argument|invalid (?:option|argument)|error: option|too many arguments|requires? (?:a )?newer|please (?:update|upgrade)/i;

export function classify(text: string, rl: RateLimit): { error: TranslatorError; until: string | null } {
  const rejected = rl?.status === "rejected";
  if (rejected || LIMIT.test(text)) return { error: "limit", until: untilFrom(text, rejected ? rl : null) };
  if (LOGIN.test(text)) return { error: "login", until: null };
  if (OFFLINE.test(text)) return { error: "offline", until: null };
  return { error: "failed", until: null };
}

// One word for what a session's stderr says. Only this word reaches the log, never the text.
export type StderrWord = "login" | "update" | "offline" | "limit" | "unknown";
export function stderrWord(text: string): StderrWord {
  if (!text.trim()) return "unknown";
  if (LOGIN.test(text)) return "login";
  if (UPDATE.test(text)) return "update";
  if (LIMIT.test(text)) return "limit";
  if (OFFLINE.test(text)) return "offline";
  return "unknown";
}

// The error the page sees for a stderr word.
export const errorFor = (w: StderrWord): TranslatorError => (w === "unknown" ? "failed" : w);

// The reset time as ISO: from the rate_limit_event (seconds since 1970), or the older
// "…usage limit reached|<seconds>" form.
function untilFrom(text: string, rl: RateLimit): string | null {
  const secs = rl?.resetsAt ?? Number(text.match(/\|(\d{10})\b/)?.[1] ?? 0);
  if (!secs || !Number.isFinite(secs)) return null;
  const ms = secs > 1e12 ? secs : secs * 1000;
  return new Date(ms).toISOString();
}
