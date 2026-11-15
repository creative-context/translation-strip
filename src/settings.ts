// settings.json in the app folder. Missing file or keys: haiku, send, no guide, no linter.
// The paths are the user's; code never holds a default path.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SETTINGS_FILE } from "./config";
import type { Mode, Model, Settings } from "./state";

export const MODELS: Model[] = ["haiku", "sonnet"];
export const MODES: Mode[] = ["send", "leave"];

function readRaw(file = SETTINGS_FILE): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const path = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function loadSettings(file = SETTINGS_FILE): Settings {
  const raw = readRaw(file);
  return {
    voiceGuide: path(raw.voiceGuide),
    linter: path(raw.linter),
    model: MODELS.includes(raw.model as Model) ? (raw.model as Model) : "haiku",
    mode: MODES.includes(raw.mode as Mode) ? (raw.mode as Mode) : "send",
  };
}

// Writes what changed, keeping every other key the file already has. A path of "" clears it.
// The server is the only writer: the app's menu sends its paths to POST /api/settings.
export type SettingsChange = { model?: Model; mode?: Mode; voiceGuide?: string; linter?: string };
export function saveSettings(change: SettingsChange, file = SETTINGS_FILE): Settings {
  const raw = readRaw(file);
  if (change.model) raw.model = change.model;
  if (change.mode) raw.mode = change.mode;
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
