// The languages a reply can be written in, each in its own name, and the dictation locales.
// The page, Settings and the translator's protocol all use these exact names.
export const LANGUAGES = ["English", "Español", "Português", "Français", "Deutsch", "Italiano", "Nederlands", "Polski", "Svenska", "Türkçe", "日本語", "한국어", "中文"] as const;
export type Language = (typeof LANGUAGES)[number];
export const isLanguage = (v: unknown): v is Language => typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);

// A language name as a reply may write it: one of LANGUAGES in any case, with or without accents,
// in English ("Portuguese"), with a region ("Português (Brasil)") or another word ("Brazilian
// Portuguese"). The list's own name, or null.
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const OTHER_NAMES: Record<string, Language> = {
  spanish: "Español", castellano: "Español", portuguese: "Português", french: "Français", german: "Deutsch",
  italian: "Italiano", dutch: "Nederlands", polish: "Polski", swedish: "Svenska", turkish: "Türkçe",
  japanese: "日本語", korean: "한국어", chinese: "中文", mandarin: "中文",
};
export function languageNamed(name: string): Language | null {
  const whole = fold(name);
  for (const key of [whole, ...whole.split(/[^\p{L}]+/u).filter(Boolean)]) {
    const own = LANGUAGES.find((l) => fold(l) === key);
    if (own) return own;
    if (Object.hasOwn(OTHER_NAMES, key)) return OTHER_NAMES[key];
  }
  return null;
}

export const DICTATION = [
  { id: "es-MX", name: "Español (México)" },
  { id: "es-US", name: "Español (EE. UU.)" },
  { id: "es-ES", name: "Español (España)" },
  { id: "en-US", name: "English (US)" },
  { id: "en-GB", name: "English (UK)" },
  { id: "pt-BR", name: "Português (Brasil)" },
  { id: "pt-PT", name: "Português (Portugal)" },
  { id: "fr-FR", name: "Français" },
  { id: "de-DE", name: "Deutsch" },
  { id: "it-IT", name: "Italiano" },
] as const;
export const isDictation = (v: unknown): v is string => typeof v === "string" && DICTATION.some((d) => d.id === v);

export const MAX_LANGUAGES = 8; // "Your languages": 1 to 8
export const MAX_NOTE = 600; // characters in one language's notes
