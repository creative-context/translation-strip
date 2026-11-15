// Tells apart the errors the page shows: offline, limit (with until when Claude Code gives a
// reset time) and failed. Reads Claude Code's own error text, never the user's message.
import type { TranslatorError } from "./state";

// What the stream's last rate_limit_event said, for the turn in progress.
export type RateLimit = { status?: string; resetsAt?: number } | null;

const LIMIT = /hit your (?:[\w' ]{0,40} )?limit|usage limit|limit reached|rate.?limit(?:ed)?\b|out of (?:extra )?usage|quota/i;
const OFFLINE = /connection (?:error|refused|reset|closed)|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|unable to connect|socket hang up|offline|internet/i;

export function classify(text: string, rl: RateLimit): { error: TranslatorError; until: string | null } {
  const rejected = rl?.status === "rejected";
  if (rejected || LIMIT.test(text)) return { error: "limit", until: untilFrom(text, rejected ? rl : null) };
  if (OFFLINE.test(text)) return { error: "offline", until: null };
  return { error: "failed", until: null };
}

// The reset time as ISO: from the rate_limit_event (seconds since 1970), or the older
// "…usage limit reached|<seconds>" form.
function untilFrom(text: string, rl: RateLimit): string | null {
  const secs = rl?.resetsAt ?? Number(text.match(/\|(\d{10})\b/)?.[1] ?? 0);
  if (!secs || !Number.isFinite(secs)) return null;
  const ms = secs > 1e12 ? secs : secs * 1000;
  return new Date(ms).toISOString();
}
