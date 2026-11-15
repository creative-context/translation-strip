// The shared state the page sees, and the version that bumps on each change.
export type Model = "haiku" | "sonnet" | "opus";
export type Mode = "send" | "leave";
export type TranslatorError = "login" | "update" | "offline" | "limit" | "guide" | "failed";
export type Status = "starting" | "ready" | "busy" | "error";

export type Settings = { voiceGuide: string | null; linter: string | null; model: Model; mode: Mode };

export const state = {
  translator: {
    status: "starting" as Status,
    error: null as TranslatorError | null,
    until: null as string | null,
    model: "haiku" as Model,
    guide: "missing" as "ok" | "missing",
    linter: "missing" as "ok" | "missing",
  },
  settings: { voiceGuide: null, linter: null, model: "haiku", mode: "send" } as Settings,
  version: 0,
};

let onChange: () => void = () => {};
export function onBump(fn: () => void) {
  onChange = fn;
}

// Marks the state changed, so the stream sends it.
export function bump() {
  state.version++;
  try {
    onChange();
  } catch {}
}

// What the page gets: never the paths in the settings.
export function snapshot() {
  return {
    now: Date.now(),
    translator: { ...state.translator },
    settings: { model: state.settings.model, mode: state.settings.mode },
  };
}
