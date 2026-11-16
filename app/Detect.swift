// The language of what the user is writing, guessed on the Mac by Apple's NaturalLanguage: the text
// never leaves the Mac, and nothing is kept. The page shows it in the input's footer.
import Foundation
import NaturalLanguage

enum DetectedLanguage {
    // The strip's own names for its languages (src/languages.ts); any other is named in itself.
    static let names: [String: String] = [
        "en": "English", "es": "Español", "pt": "Português", "fr": "Français", "de": "Deutsch", "it": "Italiano",
        "nl": "Nederlands", "pl": "Polski", "sv": "Svenska", "tr": "Türkçe", "ja": "日本語", "ko": "한국어", "zh": "中文",
    ]
    static let minLetters = 6 // fewer letters say too little
    static let minConfidence = 0.5 // below it, the text is too short or too mixed to name one language
    static let textLimit = 2000

    // A language's name in itself, for a code such as "es", "pt-BR" or "zh-Hans"; nil for none.
    static func name(code: String) -> String? {
        let base = String(code.split(whereSeparator: { $0 == "-" || $0 == "_" }).first ?? "").lowercased()
        guard !base.isEmpty, base != "und" else { return nil }
        if let n = names[base] { return n }
        guard let own = Locale(identifier: base).localizedString(forLanguageCode: base), !own.isEmpty else { return nil }
        return own.prefix(1).uppercased() + own.dropFirst()
    }

    // The language a text is mostly in, when that's clear; nil when it's too short or too mixed.
    static func of(_ text: String) -> String? {
        let letters = text.unicodeScalars.lazy.filter { CharacterSet.letters.contains($0) }.count
        guard letters >= minLetters else { return nil }
        let r = NLLanguageRecognizer()
        r.processString(String(text.prefix(textLimit)))
        guard let best = r.languageHypotheses(withMaximum: 1).max(by: { $0.value < $1.value }), best.value >= minConfidence else { return nil }
        return name(code: best.key.rawValue)
    }
}
