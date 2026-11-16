// The shared state the page sees, and the version that bumps on each change.
import { basename } from "node:path";
import { DICTATION, LANGUAGES } from "./languages";

export type Model = "haiku" | "sonnet" | "opus";
export type Mode = "send" | "leave";
export type TranslatorError = "login" | "update" | "offline" | "limit" | "guide" | "missing" | "failed";
export type Status = "starting" | "ready" | "busy" | "error";

// notes: each language's own notes, only non-empty ones, keyed by the language's name.
export type Settings = {
  voiceGuide: string | null;
  linter: string | null;
  model: Model;
  mode: Mode;
  target: string;
  auto: boolean;
  languages: string[];
  notes: Record<string, string>;
  dictation: string;
};

export const DEFAULT_SETTINGS: Settings = { voiceGuide: null, linter: null, model: "haiku", mode: "send", target: "English", auto: false, languages: ["English"], notes: {}, dictation: "es-MX" };

export const state = {
  translator: {
    status: "starting" as Status,
    error: null as TranslatorError | null,
    until: null as string | null,
    model: "haiku" as Model,
    guide: "missing" as "ok" | "missing",
    linter: "missing" as "ok" | "missing",
  },
  settings: { ...DEFAULT_SETTINGS } as Settings,
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

// The settings the page and Settings see: never a path, only the guide's and the linter's file names.
export function publicSettings(s: Settings = state.settings) {
  return {
    model: s.model,
    mode: s.mode,
    target: s.target,
    auto: s.auto,
    languages: [...s.languages],
    notes: { ...s.notes },
    dictation: s.dictation,
    files: { voiceGuide: s.voiceGuide ? basename(s.voiceGuide) : null, linter: s.linter ? basename(s.linter) : null },
  };
}

// The choices Settings and the menu offer.
const OPTIONS = { languages: [...LANGUAGES], dictation: DICTATION.map((d) => ({ id: d.id, name: d.name })) };

// What the page gets: never the paths in the settings.
export function snapshot() {
  return {
    now: Date.now(),
    translator: { ...state.translator },
    settings: publicSettings(),
    options: OPTIONS,
  };
}
