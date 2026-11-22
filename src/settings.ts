// settings.json in the app folder. Missing file or keys: sonnet, send, no guide, no linter, target
// English, Auto off, your languages English, no notes, dictation es-MX. The paths are the user's;
// code never holds a default path.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SETTINGS_FILE } from "./config";
import { isDictation, isLanguage, MAX_LANGUAGES, MAX_NOTE } from "./languages";
import { DEFAULT_SETTINGS, type DictationEngine, type DictationPhrase, type Mode, type Model, type Settings } from "./state";

export const MODELS: Model[] = ["haiku", "sonnet", "opus", "mac"];
export const MODES: Mode[] = ["send", "leave"];
export const DICTATION_ENGINES: DictationEngine[] = ["mac", "claude"];
export const DICTATION_PHRASES: DictationPhrase[] = ["review", "send"];

function readRaw(file = SETTINGS_FILE): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const path = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// The target always in the list: added at the end when missing (in place of the last one when the list is full).
function withTarget(languages: string[], target: string) {
  if (languages.includes(target)) return languages;
  return [...languages.slice(0, MAX_LANGUAGES - 1), target];
}

// A file edited by hand is read as far as it goes: what's wrong falls back to its default.
export function loadSettings(file = SETTINGS_FILE): Settings {
  const raw = readRaw(file);
  const target = isLanguage(raw.target) ? raw.target : DEFAULT_SETTINGS.target;
  const listed = Array.isArray(raw.languages) ? [...new Set(raw.languages.filter(isLanguage))].slice(0, MAX_LANGUAGES) : [];
  const notes: Record<string, string> = {};
  if (plainObject(raw.notes)) {
    for (const [k, v] of Object.entries(raw.notes)) if (isLanguage(k) && typeof v === "string" && v.trim()) notes[k] = v.trim().slice(0, MAX_NOTE);
  }
  return {
    voiceGuide: path(raw.voiceGuide),
    linter: path(raw.linter),
    model: MODELS.includes(raw.model as Model) ? (raw.model as Model) : DEFAULT_SETTINGS.model,
    mode: MODES.includes(raw.mode as Mode) ? (raw.mode as Mode) : DEFAULT_SETTINGS.mode,
    target,
    auto: raw.auto === true,
    languages: withTarget(listed, target),
    notes,
    dictation: isDictation(raw.dictation) ? raw.dictation : DEFAULT_SETTINGS.dictation,
    dictationEngine: DICTATION_ENGINES.includes(raw.dictationEngine as DictationEngine) ? (raw.dictationEngine as DictationEngine) : DEFAULT_SETTINGS.dictationEngine,
    dictationSounds: raw.dictationSounds !== false,
    dictationPhrase: DICTATION_PHRASES.includes(raw.dictationPhrase as DictationPhrase) ? (raw.dictationPhrase as DictationPhrase) : DEFAULT_SETTINGS.dictationPhrase,
  };
}

// What a POST to /api/settings may change besides the paths. `notes` here is the whole set after the merge.
export type SettingsChange = {
  model?: Model;
  mode?: Mode;
  voiceGuide?: string;
  linter?: string;
  target?: string;
  auto?: boolean;
  languages?: string[];
  notes?: Record<string, string>;
  dictation?: string;
  dictationEngine?: DictationEngine;
  dictationSounds?: boolean;
  dictationPhrase?: DictationPhrase;
};

// Checks a POST's keys other than the paths against the rules, given the settings now. null: one
// of them breaks a rule (400 settings). The target always ends up in the languages: a new target
// that isn't there is added at the end, and a list that leaves the target out gets it back; past
// 8 languages, that's a broken rule too. `notes` merges: a language's notes replace its old ones,
// and "" (or only spaces) removes them; notes are kept only for languages on the list.
export function checkChange(b: Record<string, unknown>, now: Settings): Omit<SettingsChange, "voiceGuide" | "linter"> | null {
  const c: Omit<SettingsChange, "voiceGuide" | "linter"> = {};
  if (b.model !== undefined) {
    if (!MODELS.includes(b.model as Model)) return null;
    c.model = b.model as Model;
  }
  if (b.mode !== undefined) {
    if (!MODES.includes(b.mode as Mode)) return null;
    c.mode = b.mode as Mode;
  }
  if (b.target !== undefined) {
    if (!isLanguage(b.target)) return null;
    c.target = b.target;
  }
  if (b.auto !== undefined) {
    if (typeof b.auto !== "boolean") return null;
    c.auto = b.auto;
  }
  if (b.languages !== undefined) {
    const l = b.languages;
    if (!Array.isArray(l) || l.length < 1 || l.length > MAX_LANGUAGES || !l.every(isLanguage) || new Set(l).size !== l.length) return null;
    c.languages = [...l];
  }
  if (b.notes !== undefined) {
    if (!plainObject(b.notes)) return null;
    const notes = { ...now.notes };
    for (const [k, v] of Object.entries(b.notes)) {
      if (!isLanguage(k) || typeof v !== "string" || v.trim().length > MAX_NOTE) return null;
      if (v.trim()) notes[k] = v.trim();
      else delete notes[k];
    }
    c.notes = notes;
  }
  if (b.dictation !== undefined) {
    if (!isDictation(b.dictation)) return null;
    c.dictation = b.dictation;
  }
  if (b.dictationEngine !== undefined) {
    if (!DICTATION_ENGINES.includes(b.dictationEngine as DictationEngine)) return null;
    c.dictationEngine = b.dictationEngine as DictationEngine;
  }
  if (b.dictationSounds !== undefined) {
    if (typeof b.dictationSounds !== "boolean") return null;
    c.dictationSounds = b.dictationSounds;
  }
  if (b.dictationPhrase !== undefined) {
    if (!DICTATION_PHRASES.includes(b.dictationPhrase as DictationPhrase)) return null;
    c.dictationPhrase = b.dictationPhrase as DictationPhrase;
  }
  if (c.target !== undefined || c.languages !== undefined) {
    const target = c.target ?? now.target;
    const languages = c.languages ?? now.languages;
    if (!languages.includes(target)) {
      if (languages.length >= MAX_LANGUAGES) return null;
      c.languages = [...languages, target];
    }
  }
  // Notes belong to a language on the list: removing a language removes its notes too.
  if (c.notes !== undefined || c.languages !== undefined) {
    const languages = c.languages ?? now.languages;
    const notes = c.notes ?? now.notes;
    const kept = Object.fromEntries(Object.entries(notes).filter(([k]) => languages.includes(k)));
    if (c.notes !== undefined || Object.keys(kept).length !== Object.keys(notes).length) c.notes = kept;
  }
  return c;
}

// Writes what changed, keeping every other key the file already has. A path of "" clears it.
// The server is the only writer: the app's menu and Settings send their choices to POST /api/settings.
export function saveSettings(change: SettingsChange, file = SETTINGS_FILE): Settings {
  const raw = readRaw(file);
  for (const k of ["model", "mode", "target", "auto", "languages", "dictation", "dictationEngine", "dictationSounds", "dictationPhrase"] as const) if (change[k] !== undefined) raw[k] = change[k];
  if (change.notes !== undefined) {
    if (Object.keys(change.notes).length) raw.notes = change.notes;
    else delete raw.notes;
  }
  for (const k of ["voiceGuide", "linter"] as const) {
    const v = change[k];
    if (v === undefined) continue;
    if (v === "") delete raw[k];
    else raw[k] = v;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return loadSettings(file);
}

// The file's modification time, to notice an edit made outside the server.
export function settingsStamp(file = SETTINGS_FILE): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export const fileThere = (p: string | null) => {
  if (!p) return false;
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

