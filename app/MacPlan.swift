// What the Mac's own translator (translate-on-mac, app/TranslateOnMac.swift) does with a request,
// worked out with no Translation framework: which language the text is in, which one it goes to,
// and the strip's names for both. Pure, so test/swift-check.swift can check it.
import Foundation
import NaturalLanguage

enum MacLanguages {
    // The strip's languages (src/languages.ts) and the language codes the Translation framework
    // takes for them. 中文 is Simplified Chinese, the script the strip's 中文 means.
    static let codes: [(name: String, code: String)] = [
        ("English", "en"), ("Español", "es"), ("Português", "pt"), ("Français", "fr"), ("Deutsch", "de"),
        ("Italiano", "it"), ("Nederlands", "nl"), ("Polski", "pl"), ("Svenska", "sv"), ("Türkçe", "tr"),
        ("日本語", "ja"), ("한국어", "ko"), ("中文", "zh-Hans"),
    ]

    // The code for one of the strip's names ("Español" → "es"); nil for any other name.
    static func code(name: String) -> String? { codes.first { $0.name == name }?.code }

    // The strip's name for a code, when it's one of its languages ("pt-BR" → "Português"); nil otherwise.
    static func stripName(code: String) -> String? {
        let b = base(code)
        return codes.first { base($0.code) == b }?.name
    }

    // A code's language alone, lowercased: "es-MX" → "es", "zh_Hans" → "zh"; "" for none.
    static func base(_ code: String) -> String {
        String(code.split(whereSeparator: { $0 == "-" || $0 == "_" }).first ?? "").lowercased()
    }

    // The name a reply or an error uses: the strip's name, or the language's name in itself.
    static func name(code: String) -> String { DetectedLanguage.name(code: code) ?? code }

    // The language a text is clearly in, as NaturalLanguage's code ("es", "zh-Hans"), by the rule the
    // strip's "Detected" uses (DetectedLanguage): 6 letters at least and 50% confidence; nil otherwise.
    static func clear(_ text: String) -> String? {
        let letters = text.unicodeScalars.lazy.filter { CharacterSet.letters.contains($0) }.count
        guard letters >= DetectedLanguage.minLetters else { return nil }
        let r = NLLanguageRecognizer()
        r.processString(String(text.prefix(DetectedLanguage.textLimit)))
        guard let best = r.languageHypotheses(withMaximum: 1).max(by: { $0.value < $1.value }),
              best.value >= DetectedLanguage.minConfidence, best.key != .undetermined else { return nil }
        return best.key.rawValue
    }
}

// One request's plan: from which language to which, and what the reply will say about it.
struct MacPlan: Equatable {
    var source: String // a language code, as NaturalLanguage or the hint gives it
    var target: String // a language code the Translation framework takes
    var language: String // the target in the strip's names
    var from: String // "target" (Settings' target) or "chat" (Auto, from the other person's last message)
    var same: Bool // source and target are one language: the text comes back as it is

    var sourceName: String { MacLanguages.name(code: source) }

    // The plan for a request, or nil when it can't be made (a target that isn't one of the strip's
    // languages, or a text whose language isn't clear with no hint to fall back on).
    // `detect` is the clear-language rule; the checks pass their own.
    static func make(text: String, target: String, auto: Bool, last: String?, hint: String?,
                     detect: (String) -> String? = MacLanguages.clear) -> MacPlan? {
        guard var targetCode = MacLanguages.code(name: target) else { return nil }
        var language = target
        var from = "target"
        if auto, let last, let lastCode = detect(last), let name = MacLanguages.stripName(code: lastCode),
           let code = MacLanguages.code(name: name) {
            targetCode = code
            language = name
            from = "chat"
        }
        let hintCode = hint.map(MacLanguages.base).flatMap { $0.isEmpty || $0 == "und" ? nil : $0 }
        guard let source = detect(text) ?? hintCode else { return nil }
        let same = MacLanguages.base(source) == MacLanguages.base(targetCode)
        return MacPlan(source: source, target: targetCode, language: language, from: from, same: same)
    }
}
