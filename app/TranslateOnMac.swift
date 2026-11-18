// translate-on-mac: the strip's translator on the Mac, with Apple's Translation framework. No
// Claude, no plan, no network. The server starts it and talks to it in JSON lines: one request on
// stdin, one reply on stdout (docs/contract.md, "Translating on this Mac"). It ends when stdin
// closes. It writes no file and keeps no text, and stderr never holds a message's text.
//
// Built by app/build.sh into the app as Contents/MacOS/translate-on-mac, with MacPlan.swift and
// Detect.swift. Translation is weak-linked: on macOS before 26 the program says so and exits.
import Foundation
import NaturalLanguage
import Translation

// One JSON line on stdout, written at once.
func reply(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes, .sortedKeys]) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

// A word on stderr, never a message's text.
func note(_ s: String) { FileHandle.standardError.write(Data("translate-on-mac: \(s)\n".utf8)) }

// stdin's lines, read on a thread of their own; the stream ends when stdin closes.
func inputLines() -> AsyncStream<String> {
    AsyncStream { cont in
        let t = Thread {
            while let line = readLine(strippingNewline: true) { cont.yield(line) }
            cont.finish()
        }
        t.start()
    }
}

@available(macOS 26.0, *)
@MainActor
final class MacTranslator {
    private var sessions: [String: TranslationSession] = [:] // one per pair, kept
    private let availability = LanguageAvailability()

    func handle(_ line: String) async {
        guard let data = line.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            reply(["error": "failed"])
            return
        }
        let id = req["id"] as? String ?? ""
        guard let text = req["text"] as? String, let target = req["target"] as? String,
              let plan = MacPlan.make(text: text, target: target, auto: req["auto"] as? Bool ?? false,
                                      last: req["last"] as? String, hint: req["hint"] as? String) else {
            reply(["id": id, "error": "failed"])
            return
        }
        if plan.same {
            reply(["id": id, "text": text, "language": plan.language, "from": plan.from])
            return
        }
        let source = Locale.Language(identifier: plan.source)
        let dest = Locale.Language(identifier: plan.target)
        let status = await availability.status(from: source, to: dest)
        guard status == .installed else {
            reply(["id": id, "error": "language", "source": plan.sourceName, "language": plan.language])
            return
        }
        let key = "\(plan.source)>\(plan.target)"
        let session = sessions[key] ?? TranslationSession(installedSource: source, target: dest)
        sessions[key] = session
        do {
            let r = try await session.translate(text)
            reply(["id": id, "text": r.targetText, "language": plan.language, "from": plan.from])
        } catch {
            sessions[key] = nil // a fresh one next time
            note("failed (\(type(of: error)))")
            reply(["id": id, "error": "failed"])
        }
    }
}

@main
enum TranslateOnMac {
    @MainActor static func main() async {
        guard #available(macOS 26.0, *), frameworkLoaded() else {
            reply(["ready": false, "error": "mac"])
            exit(0)
        }
        let translator = MacTranslator()
        reply(["ready": true])
        for await line in inputLines() where !line.trimmingCharacters(in: .whitespaces).isEmpty {
            await translator.handle(line)
        }
        exit(0)
    }

    // Whether the weak-linked Translation framework is there (it is on every macOS 26).
    static func frameworkLoaded() -> Bool {
        dlopen("/System/Library/Frameworks/Translation.framework/Translation", RTLD_NOLOAD) != nil
    }
}
