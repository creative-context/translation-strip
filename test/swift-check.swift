// Checks of the shell's pure parts, with made-up screens, frames, titles and trees: where the strip
// docks (Dock.swift), how Teams' titles, headings and message box are read and how its window is
// walked for the box and the last message, on a made-up tree (Teams.swift), and the send's
// decisions: the paste watch, the outcome line, what an empty box after Return is worth and the own server (Send.swift), and which locales a dictation tries
// (DictationLocales, in Dictation.swift), and the Mac translator's plan: language codes, names, source and target
// (MacPlan.swift). Built and run by test/swift-check.sh. Prints one line per case; exits 1 when one fails. A case marked known is a
// behavior the check expects to change: it prints KNOWN while it's wrong and PASS once it's fixed.

import AppKit

var failures = 0
var known = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, known isKnown: Bool = false) {
    if got == want {
        print("PASS  \(name)")
    } else if isKnown {
        known += 1
        print("KNOWN \(name): got \(got), wanted \(want)")
    } else {
        failures += 1
        print("FAIL  \(name): got \(got), wanted \(want)")
    }
}

func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect { CGRect(x: x, y: y, width: w, height: h) }

@main
enum SwiftCheck {
    static func main() {
        docking()
        stripOrder()
        teams()
        tree()
        paste()
        sendLog()
        sendConfirm()
        teamsVersion()
        teamsCheck()
        ownServer()
        dictationLocales()
        macPlan()
        cues()
        print("\(failures == 0 ? "ok" : "FAILED"): \(failures) failed, \(known) known")
        exit(failures == 0 ? 0 : 1)
    }

    // The dictation's two cues: a third of a second of 16-bit mono WAV each, the start going up and the stop down.
    static func cues() {
        let up = Cue.wav([(659.3, 0, 0.06), (880, 0.075, 0.11)]), down = Cue.wav([(880, 0, 0.06), (659.3, 0.075, 0.11)])
        check("cue: a WAV header", String(decoding: up.prefix(4), as: UTF8.self) + String(decoding: up[8..<12], as: UTF8.self), "RIFFWAVE")
        check("cue: about a third of a second at 44.1 kHz", up.count, 44 + Int(44_100 * 0.34) * 2)
        check("cue: start and stop are different sounds", up == down, false)
        let peak = stride(from: 44, to: up.count - 1, by: 2).map { abs(Int(Int16(bitPattern: UInt16(up[$0]) | UInt16(up[$0 + 1]) << 8))) }.max() ?? 0
        check("cue: soft, never clipping (peak under half of full scale)", peak > 2_000 && peak < 16_384, true)
    }

    // Where the strip goes in the window stack: in front only with Teams or the strip in front;
    // with another app in front, just above Teams' window, so a Teams toast never brings it over that app.
    static func stripOrder() {
        func o(raise: Bool = false, moved: Bool = false, visible: Bool = true, front: Bool, id: CGWindowID? = 42) -> StripOrder {
            StripOrder.decide(raise: raise, moved: moved, visible: visible, front: front, teamsID: id)
        }
        check("order: nothing changed stays put", o(front: true), .keep)
        check("order: nothing changed stays put with Teams behind", o(front: false), .keep)
        check("order: Teams comes forward, the strip comes in front", o(raise: true, front: true), .front)
        check("order: a Teams notice with another app in front goes just above Teams", o(raise: true, front: false), .aboveTeams(42))
        check("order: Teams moved behind another app, above Teams only", o(moved: true, front: false), .aboveTeams(42))
        check("order: out of sight with Teams behind comes back above Teams", o(visible: false, front: false), .aboveTeams(42))
        check("order: out of sight with Teams in front comes in front", o(visible: false, front: true), .front)
        check("order: no window number and Teams behind, never over the other app", o(raise: true, front: false, id: nil), .keep)
        check("order: no window number and Teams in front still comes in front", o(raise: true, front: true, id: nil), .front)
    }

    // The Mac's own translator (translate-on-mac): the strip's names and codes, then which language a
    // request goes from and to. `fake` stands in for NaturalLanguage's clear-language rule, so the cases
    // don't hang on its model; a few at the end use the real one.
    static func macPlan() {
        check("mac: Español is es", MacLanguages.code(name: "Español"), "es")
        check("mac: 中文 is Simplified Chinese", MacLanguages.code(name: "中文"), "zh-Hans")
        check("mac: a name off the list has no code", MacLanguages.code(name: "Klingon"), String?.none)
        check("mac: every strip language has a code", MacLanguages.codes.count, 13)
        check("mac: pt-BR is Português", MacLanguages.stripName(code: "pt-BR"), "Português")
        check("mac: zh-Hant is 中文", MacLanguages.stripName(code: "zh-Hant"), "中文")
        check("mac: Icelandic isn't a strip language", MacLanguages.stripName(code: "is"), String?.none)
        check("mac: Icelandic is named in itself", MacLanguages.name(code: "is"), "Íslenska")
        check("mac: es-MX's language is es", MacLanguages.base("es-MX"), "es")

        let langs = ["Hola, ¿cómo vas con el reporte?": "es", "Tudo certo por aqui, obrigado!": "pt", "See you then.": "en", "Ég kem á morgun.": "is"]
        let fake: (String) -> String? = { langs[$0] }
        func plan(_ text: String, _ target: String = "English", auto: Bool = false, last: String? = nil, hint: String? = "es") -> MacPlan? {
            MacPlan.make(text: text, target: target, auto: auto, last: last, hint: hint, detect: fake)
        }
        check("mac plan: Spanish to the target", plan("Hola, ¿cómo vas con el reporte?"),
              MacPlan(source: "es", target: "en", language: "English", from: "target", same: false))
        check("mac plan: an unclear text takes the hint", plan("ok", hint: "pt")?.source, "pt")
        check("mac plan: the hint is a locale's language", plan("ok", hint: "es-MX")?.source, "es")
        check("mac plan: unclear with no hint can't be planned", plan("ok", hint: nil), MacPlan?.none)
        check("mac plan: unclear with und as the hint can't be planned", plan("ok", hint: "und"), MacPlan?.none)
        check("mac plan: a target off the list can't be planned", plan("Hola, ¿cómo vas con el reporte?", "Klingon"), MacPlan?.none)
        check("mac plan: Auto with a clear last message goes to its language",
              plan("Hola, ¿cómo vas con el reporte?", auto: true, last: "Tudo certo por aqui, obrigado!"),
              MacPlan(source: "es", target: "pt", language: "Português", from: "chat", same: false))
        check("mac plan: Auto with an unclear last message keeps the target",
              plan("Hola, ¿cómo vas con el reporte?", auto: true, last: "ok"),
              MacPlan(source: "es", target: "en", language: "English", from: "target", same: false))
        check("mac plan: Auto with a last message off the list keeps the target",
              plan("Hola, ¿cómo vas con el reporte?", auto: true, last: "Ég kem á morgun.")?.from, "target")
        check("mac plan: Auto off ignores the last message",
              plan("Hola, ¿cómo vas con el reporte?", auto: false, last: "Tudo certo por aqui, obrigado!")?.language, "English")
        check("mac plan: English to English comes back as it is", plan("See you then.")?.same, true)
        check("mac plan: Spanish to Spanish comes back as it is", plan("Hola, ¿cómo vas con el reporte?", "Español")?.same, true)
        check("mac plan: Portuguese in a chat in Portuguese comes back as it is",
              plan("Tudo certo por aqui, obrigado!", auto: true, last: "Tudo certo por aqui, obrigado!")?.same, true)
        check("mac plan: a source off the list is named in itself", plan("Ég kem á morgun.")?.sourceName, "Íslenska")
        // The real rule: NaturalLanguage, 6 letters and 50%.
        check("mac clear: Spanish", MacLanguages.clear("¿Puedes revisar el presupuesto antes del jueves? Si hace falta, lo vemos en la llamada."), "es")
        check("mac clear: Portuguese", MacLanguages.clear("Você consegue me mandar a apresentação até amanhã? Obrigado!"), "pt")
        check("mac clear: ok is too short", MacLanguages.clear("ok"), String?.none)
        check("mac clear: Chinese keeps its script", MacLanguages.clear("我明天上午把报告发给你，请有空的时候看一下。"), "zh-Hans")
        check("mac plan: real rule, Auto with a German last message",
              MacPlan.make(text: "Te mando la liga en un rato, ya quedó lista.", target: "English", auto: true,
                           last: "Kannst du mir bitte die Folien bis morgen schicken?", hint: "es")?.language, "Deutsch")
    }

    // The start message's locale, from Settings: the chosen one first, then its language's others; es-MX when missing.
    static func dictationLocales() {
        check("dictation: no locale is Mexican Spanish, then US and Spain", DictationLocales.candidates(nil), ["es-MX", "es-US", "es-ES"])
        check("dictation: es-ES first, then the other Spanish ones", DictationLocales.candidates("es-ES"), ["es-ES", "es-MX", "es-US"])
        check("dictation: en-GB, then en-US", DictationLocales.candidates("en-GB"), ["en-GB", "en-US"])
        check("dictation: pt-BR, then pt-PT", DictationLocales.candidates("pt-BR"), ["pt-BR", "pt-PT"])
        check("dictation: fr-FR alone", DictationLocales.candidates("fr-FR"), ["fr-FR"])
        check("dictation: an id outside the list is still tried", DictationLocales.candidates("es-AR"), ["es-AR", "es-MX", "es-US", "es-ES"])
        check("dictation: lower case and an underscore read as the id", DictationLocales.candidates("de_de"), ["de-DE"])
        check("dictation: an empty locale is es-MX", DictationLocales.candidates(""), ["es-MX", "es-US", "es-ES"])
        check("dictation: a malformed locale is es-MX", DictationLocales.candidates("spanish; rm"), ["es-MX", "es-US", "es-ES"])
        check("dictation: a language alone is es-MX", DictationLocales.candidates("en"), ["es-MX", "es-US", "es-ES"])
        check("dictation: the log names the language in English", DictationLocales.language("pt-BR"), "Portuguese")
    }

    // Made-up screens, in AppKit's coordinates (bottom-left origin). The main one is 1500 x 900,
    // with 40 pt of Dock at the bottom and 30 pt of menu bar at the top.
    static let mainScreen = ScreenArea(frame: rect(0, 0, 1500, 900), visible: rect(0, 40, 1500, 830))
    static let aboveScreen = ScreenArea(frame: rect(0, 900, 1500, 900), visible: rect(0, 900, 1500, 870)) // over the main one
    static let leftScreen = ScreenArea(frame: rect(-1200, 0, 1200, 900), visible: rect(-1200, 30, 1200, 840)) // to its left
    static let mainHeight: CGFloat = 900

    static func docking() {
        // Teams is given top-left, as Accessibility gives it; the strip comes back in AppKit's coordinates.
        check("appKit: a top-left rect flips to the bottom-left origin", Dock.appKit(rect(100, 50, 800, 500), mainHeight: mainHeight), rect(100, 350, 800, 500))

        // Room below Teams: its top edge on Teams' bottom edge, as wide as Teams, 145 pt high.
        let room = Dock.frame(under: rect(100, 50, 800, 500), screens: [mainScreen], mainHeight: mainHeight)
        check("frame: room below Teams, directly under it", room, rect(100, 205, 800, 145))
        check("frame: room below Teams, top edge on Teams' bottom edge", room.maxY, Dock.appKit(rect(100, 50, 800, 500), mainHeight: mainHeight).minY)
        check("frame: the height is 145 pt", Dock.height, 145)

        // No room: it sits on the bottom of the screen's visible area, over Teams.
        check("frame: no room, on the bottom of the visible area", Dock.frame(under: rect(100, 50, 800, 780), screens: [mainScreen], mainHeight: mainHeight), rect(100, 40, 800, 145))

        // Exactly 145 pt free (Teams' bottom edge 185 pt above the visible area's bottom, in AppKit's terms 40 + 145).
        let exact = Dock.frame(under: rect(100, 50, 800, 665), screens: [mainScreen], mainHeight: mainHeight)
        check("frame: exactly 145 pt free, fits with no overlap", exact, rect(100, 40, 800, 145))
        check("frame: exactly 145 pt free, top edge meets Teams' bottom edge", exact.maxY, 185)
        let oneLess = Dock.frame(under: rect(100, 50, 800, 666), screens: [mainScreen], mainHeight: mainHeight) // 144 pt free
        check("frame: 144 pt free, held at the bottom, overlapping Teams by 1 pt", [oneLess.minY, oneLess.maxY - 184], [40, 1])
        let oneMore = Dock.frame(under: rect(100, 50, 800, 664), screens: [mainScreen], mainHeight: mainHeight) // 146 pt free
        check("frame: 146 pt free, directly under Teams", oneMore, rect(100, 41, 800, 145))

        // Teams as wide as it is: x and width follow it, even past the screen.
        check("frame: x and width follow Teams", Dock.frame(under: rect(-20, 50, 1540, 500), screens: [mainScreen], mainHeight: mainHeight), rect(-20, 205, 1540, 145))

        // Teams on a screen above the main one (negative y in Accessibility's coordinates).
        check("frame: Teams on the screen above, room below it", Dock.frame(under: rect(200, -800, 800, 600), screens: [mainScreen, aboveScreen], mainHeight: mainHeight), rect(200, 955, 800, 145))
        check("frame: Teams on the screen above, no room: that screen's bottom, not the main one's", Dock.frame(under: rect(200, -800, 800, 780), screens: [mainScreen, aboveScreen], mainHeight: mainHeight), rect(200, 900, 800, 145))

        // Teams on a screen to the left of the main one (negative x).
        check("frame: Teams on the screen to the left, room below it", Dock.frame(under: rect(-1100, 50, 900, 500), screens: [mainScreen, leftScreen], mainHeight: mainHeight), rect(-1100, 205, 900, 145))
        check("frame: Teams on the screen to the left, no room: that screen's visible bottom", Dock.frame(under: rect(-1100, 50, 900, 700), screens: [mainScreen, leftScreen], mainHeight: mainHeight), rect(-1100, 30, 900, 145))

        // A window that straddles two screens docks on the one under its bottom edge; with the edge
        // in a gap between screens, on the one it overlaps most.
        let gapLeft = ScreenArea(frame: rect(-1200, 0, 1190, 900), visible: rect(-1200, 30, 1190, 840)) // a 10 pt gap before the main one
        check("frame: bottom edge in a gap between screens, the screen with the most overlap", Dock.frame(under: rect(-300, 50, 1000, 780), screens: [gapLeft, mainScreen], mainHeight: mainHeight).minY, 40)

        // No screens at all: nothing to hold it, so directly under Teams.
        check("frame: no screens, directly under Teams", Dock.frame(under: rect(100, 50, 800, 780), screens: [], mainHeight: mainHeight), rect(100, -75, 800, 145))

        // First launch, Teams closed: bottom middle of the main screen's visible area, 900 pt wide.
        check("firstFrame: 900 pt wide, centered, on the bottom of the visible area", Dock.firstFrame(main: mainScreen), rect(300, 40, 900, 145))
        let narrow = ScreenArea(frame: rect(0, 0, 700, 600), visible: rect(100, 40, 700, 530))
        check("firstFrame: on a screen narrower than 900 pt, as wide as the visible area", Dock.firstFrame(main: narrow), rect(100, 40, 700, 145))
        let exactly = ScreenArea(frame: rect(0, 0, 900, 600), visible: rect(0, 0, 900, 570))
        check("firstFrame: a visible area exactly 900 pt wide", Dock.firstFrame(main: exactly), rect(0, 0, 900, 145))

        vertical()
    }

    // The four sides (0.6.0), the layout setting and the sizes. Same made-up screens.
    static func vertical() {
        func shape(_ t: CGRect, _ l: DockLayout = .automatic, _ s: [ScreenArea] = [mainScreen], _ z: DockSize = DockSize()) -> DockShape {
            Dock.shape(for: t, layout: l, screens: s, mainHeight: mainHeight, size: z)
        }
        func frame(_ t: CGRect, _ l: DockLayout = .automatic, _ s: [ScreenArea] = [mainScreen], _ z: DockSize = DockSize()) -> CGRect {
            Dock.frame(for: t, layout: l, screens: s, mainHeight: mainHeight, size: z)
        }
        check("layout: the column is 360 pt wide until set", Dock.columnWidth, 360)
        check("layout: the settings' names", DockLayout.allCases.map(\.rawValue), ["automatic", "below", "above", "left", "right"])
        check("layout: 0.5's 'under' reads as below", DockLayout(saved: "under"), .below)
        check("layout: 0.5's 'beside' reads as right", DockLayout(saved: "beside"), .right)
        check("layout: an unknown name is no setting", DockLayout(saved: "sideways"), nil)

        // Room below: Automatic is the strip below Teams, exactly as frame(under:).
        let roomy = rect(100, 50, 800, 500)
        check("automatic: room below, below Teams", shape(roomy), .below)
        check("automatic: room below, the same frame as the strip's", frame(roomy), Dock.frame(under: roomy, screens: [mainScreen], mainHeight: mainHeight))
        check("automatic: exactly 145 pt below, still below", shape(rect(100, 50, 800, 665)), .below)
        check("automatic: 144 pt below, the right side", shape(rect(100, 50, 800, 666)), .right)

        // No room below, room on the right: against Teams' right edge, level with it, as tall.
        let tall = rect(100, 40, 800, 780) // AppKit: x 100…900, y 80…860
        let right = frame(tall)
        check("automatic: no room below, room on the right: a column against Teams' right edge", right, rect(900, 80, 360, 780))
        check("column: exactly Teams' height", right.height, Dock.appKit(tall, mainHeight: mainHeight).height)
        check("column: level with Teams, top and bottom", [right.minY, right.maxY], [Dock.appKit(tall, mainHeight: mainHeight).minY, Dock.appKit(tall, mainHeight: mainHeight).maxY])
        check("column: exactly 360 pt free on the right still fits there", frame(rect(340, 40, 800, 780)), rect(1140, 80, 360, 780))

        // Only room on the left: against Teams' left edge.
        check("automatic: 359 pt on the right, 400 on the left: the left side", shape(rect(400, 40, 741, 780)), .left)
        check("automatic: the column against Teams' left edge", frame(rect(400, 40, 741, 780)), rect(40, 80, 360, 780))
        check("column: exactly 360 pt on the left fits there", frame(rect(360, 40, 1000, 780)), rect(0, 80, 360, 780))

        // No room below or on either side, room above: the strip above Teams.
        let wideLow = rect(100, 400, 1300, 465) // AppKit: y 35…500, visible 40…870: 5 below, 370 above
        check("automatic: room only above: above Teams", shape(wideLow), .above)
        check("automatic: above, its bottom edge on Teams' top edge, as wide", frame(wideLow), rect(100, 500, 1300, 145))

        // Room nowhere: the right side, inside the visible frame, over Teams.
        check("automatic: no room anywhere: inside, at Teams' right edge", frame(rect(200, 40, 1100, 780)), rect(940, 80, 360, 780))
        check("automatic: Teams past the right edge, no room: at the visible frame's right edge", frame(rect(100, 40, 1500, 780)), rect(1140, 80, 360, 780))
        check("automatic: Teams filling the visible frame: the column inside it, as tall as Teams", frame(rect(0, 30, 1500, 830)), rect(1140, 40, 360, 830))

        // Teams on a screen above the main one: that screen's visible frame decides.
        let upTall = rect(200, -870, 800, 860) // AppKit: y 910…1770, 10 pt above that screen's visible bottom
        check("screen above: no room below on that screen, the right side", shape(upTall, .automatic, [mainScreen, aboveScreen]), .right)
        check("screen above: the column against Teams' right edge, level with it", frame(upTall, .automatic, [mainScreen, aboveScreen]), rect(1000, 910, 360, 860))
        check("screen above: room below on that screen, below", shape(rect(200, -800, 800, 600), .automatic, [mainScreen, aboveScreen]), .below)

        // Teams on a screen to the left of the main one (visible x -1200…0): the right edge there is 0, not the main screen's.
        let leftTall = rect(-1100, 40, 900, 800)
        check("left screen: 200 pt on its right, 100 on its left: inside at Teams' right edge", frame(leftTall, .automatic, [mainScreen, leftScreen]), rect(-560, 60, 360, 800))
        check("left screen: room on its right side within that screen", frame(rect(-1150, 40, 700, 800), .automatic, [mainScreen, leftScreen]), rect(-450, 60, 360, 800))
        check("left screen: only room on the left", frame(rect(-800, 40, 800, 800), .automatic, [mainScreen, leftScreen]), rect(-1160, 60, 360, 800))

        // Forced sides: each one is that side, with or without room.
        check("below: forced with no room below, the strip at the visible bottom", frame(tall, .below), Dock.frame(under: tall, screens: [mainScreen], mainHeight: mainHeight))
        check("above: forced, the strip's bottom edge on Teams' top edge, as wide", frame(rect(100, 300, 800, 400), .above), rect(100, 600, 800, 145))
        check("above: forced with no room above, at the visible top", frame(rect(100, 30, 800, 500), .above), rect(100, 725, 800, 145))
        check("right: forced with room below, the column on the right", frame(roomy, .right), rect(900, 350, 360, 500))
        check("right: forced, no room on the right, inside at Teams' right edge", frame(rect(700, 50, 800, 500), .right), rect(1140, 350, 360, 500))
        check("left: forced with room on the right, the column on the left", frame(rect(700, 50, 800, 500), .left), rect(340, 350, 360, 500))
        check("left: forced, no room on the left, inside at Teams' left edge", frame(roomy, .left), rect(100, 350, 360, 500))

        // Sizes: the user's height and width, inside their limits, and the room they need.
        let taller = DockSize(stripHeight: 220, columnWidth: 480)
        check("size: a taller strip below Teams", frame(roomy, .below, [mainScreen], taller), rect(100, 130, 800, 220))
        check("size: a wider column on the right", frame(roomy, .right, [mainScreen], taller), rect(900, 350, 480, 500))
        check("size: a wider column on the left grows away from Teams", frame(rect(700, 50, 800, 500), .left, [mainScreen], taller), rect(220, 350, 480, 500))
        check("size: automatic needs the taller strip's room below", shape(rect(100, 50, 800, 600), .automatic, [mainScreen], taller), .right)
        check("size: kept inside its limits", DockSize(stripHeight: 40, columnWidth: 2000).clamped, DockSize(stripHeight: 110, columnWidth: 640))
        check("drag: below, the bottom edge down 50 pt makes it 50 pt taller", Dock.resized(DockSize(), shape: .below, delta: CGPoint(x: 0, y: -50)).stripHeight, 195)
        check("drag: above, the top edge up 50 pt makes it 50 pt taller", Dock.resized(DockSize(), shape: .above, delta: CGPoint(x: 0, y: 50)).stripHeight, 195)
        check("drag: right, the right edge out 40 pt makes it 40 pt wider", Dock.resized(DockSize(), shape: .right, delta: CGPoint(x: 40, y: 0)).columnWidth, 400)
        check("drag: left, the left edge out 40 pt makes it 40 pt wider", Dock.resized(DockSize(), shape: .left, delta: CGPoint(x: -40, y: 0)).columnWidth, 400)
        check("drag: never past the limits", Dock.resized(DockSize(), shape: .below, delta: CGPoint(x: 0, y: -900)).stripHeight, 360)

        // No screens: Automatic stays below; Right goes against Teams' right edge.
        check("no screens: automatic, below", shape(tall, .automatic, []), .below)
        check("no screens: right, against Teams' right edge", frame(tall, .right, []), rect(900, 80, 360, 780))
    }

    static func teams() {
        // The chat's name, from "Chat | <chat name> | <org> | <account>".
        check("chatName: from a chat title", Teams.chatName("Chat | Project sync | Acme Org | Microsoft Teams"), "Project sync")
        check("chatName: the name's own spaces and symbols stay", Teams.chatName("Chat | Ana Ruiz (You) | Acme Org | Microsoft Teams"), "Ana Ruiz (You)")
        check("chatName: spaces around the name are trimmed", Teams.chatName("Chat |   Design review   | Acme Org"), "Design review")
        check("chatName: the app's name alone is no chat", Teams.chatName("Microsoft Teams"), String?.none)
        check("chatName: an empty title is no chat", Teams.chatName(""), String?.none)
        check("chatName: an empty name is no chat", Teams.chatName("Chat |  | Acme Org | Microsoft Teams"), String?.none)
        check("chatName: a title with a bar but no spaces around it is no chat", Teams.chatName("Chat|Project sync"), String?.none)
        check("chatName: another view's title is no chat", Teams.chatName("Calendar | Acme Org | Microsoft Teams"), String?.none)
        check("chatName: a pop-out chat window's title is no chat", Teams.chatName("Project sync | Acme Org | Microsoft Teams"), String?.none)
        check("chatName: a chat title with only the name", Teams.chatName("Chat | Project sync"), "Project sync")
        check("chatName: a chat named Chat in another view is no chat", Teams.chatName("Activity | Chat | Acme Org"), String?.none)
        check("isSelfChat: the user's own chat", Teams.isSelfChat("Chat | Ana Ruiz (You) | Acme Org"), true)
        check("isSelfChat: another chat", Teams.isSelfChat("Chat | Project sync | Acme Org"), false)

        // The author, from "<preview> by <author>".
        check("author: from a message heading", Teams.author(fromHeading: "Can you send the deck by Sam Lee"), "Sam Lee")
        check("author: the last ' by ' wins", Teams.author(fromHeading: "Lunch by the lake at noon by Sam Lee"), "Sam Lee")
        check("author: spaces around the name are trimmed", Teams.author(fromHeading: "Hello by   Sam Lee  "), "Sam Lee")
        check("author: a heading without ' by ' has none", Teams.author(fromHeading: "Yesterday"), String?.none)
        check("author: ' by ' with nothing after it has none", Teams.author(fromHeading: "Hello by    "), String?.none)

        // The message box: the placeholder is no draft.
        check("boxText: the placeholder alone is empty", Teams.boxText("Type a message"), "")
        check("boxText: the placeholder and its line break is empty", Teams.boxText("Type a message\n"), "")
        check("boxText: the placeholder with a non-breaking space is empty", Teams.boxText("Type\u{00A0}a message\r\n"), "")
        check("boxText: nothing is empty", Teams.boxText(""), "")
        check("boxText: only a non-breaking space is empty", Teams.boxText("\u{00A0}"), "")
        check("boxText: a real draft is kept", Teams.boxText("Can you send me the slides?"), "Can you send me the slides?")
        check("boxText: a draft that starts like the placeholder is kept", Teams.boxText("Type a message to Sam"), "Type a message to Sam")
        check("boxText: non-breaking spaces become plain spaces", Teams.boxText("Can\u{00A0}you\u{00A0}send it?"), "Can you send it?")
        check("boxText: line breaks become \\n", Teams.boxText("One\r\nTwo\rThree"), "One\nTwo\nThree")
        check("boxText: zero-width characters are dropped", Teams.boxText("Hel\u{200B}lo\u{FEFF}"), "Hello")
        check("boxText: a word joiner alone (an empty paragraph) is empty", Teams.boxText("\n\u{2060}"), "")

        // A reply's quote sits inside the box, as a card before the paragraphs, and the box's value
        // includes it in short: the box's text is the paragraphs' own.
        func quoteCard() -> Node {
            Node("AXGroup", classes: [TeamsShape.quoteClass], kids: [
                Node("AXGroup", desc: "Quoted message", kids: [
                    Node("AXStaticText", value: "Sam Lee"), Node("AXStaticText", value: "11/05/2026 10:12"),
                    Node("AXButton", desc: "Remove Reference"),
                    Node("AXGroup", kids: [Node("AXStaticText", value: "Can you send the deck before noon? I want to check the numbers first.")]),
                ]),
            ])
        }
        func paragraph(_ texts: String...) -> Node { Node("AXGroup", kids: texts.map { Node("AXStaticText", value: $0) }) }
        func quoteBox(_ paras: [Node], value: String) -> Node { Node("AXTextArea", id: "new-message-1", value: value, kids: [quoteCard()] + paras) }
        let shortQuote = "Sam Lee 11/05/2026 10:12 Can you send the deck before noon? I want to che\u{2026}\n"
        let plain = Node("AXTextArea", id: "new-message-1", value: "Can you send me the slides?", kids: [paragraph("Can you send me the slides?")])
        check("boxValue: no quote: the box's value", TeamsScan.boxValue(plain, FakeAX()), "Can you send me the slides?")
        check("boxValue: a quote alone is no draft", TeamsScan.boxValue(quoteBox([paragraph("\u{2060}")], value: shortQuote + "\u{2060}"), FakeAX()).map { Teams.boxText($0) }, "")
        check("boxValue: a quote and the user's text: the text only",
              TeamsScan.boxValue(quoteBox([paragraph("Sure, ", "sending it now.")], value: shortQuote + "Sure, sending it now."), FakeAX()).map { Teams.boxText($0) }, "Sure, sending it now.")
        check("boxValue: a quote and two paragraphs: one per line",
              TeamsScan.boxValue(quoteBox([paragraph("Sure."), paragraph("It's in the shared folder.")], value: shortQuote + "Sure.\nIt's in the shared folder."), FakeAX()).map { Teams.boxText($0) }, "Sure.\nIt's in the shared folder.")
        // The language of what's being written, on the Mac: named in itself, only when it's clear.
        check("detect: Spanish", DetectedLanguage.of("¿Puedes revisar el presupuesto antes del jueves? Si hace falta, lo vemos en la llamada."), "Español")
        check("detect: English", DetectedLanguage.of("Could you take a look at the budget before Thursday? We can go over it on the call."), "English")
        check("detect: Italian", DetectedLanguage.of("Ciao! Ho finito le slide per domani, ci dai un'occhiata stasera se hai tempo?"), "Italiano")
        check("detect: Portuguese", DetectedLanguage.of("Você consegue me mandar a apresentação até amanhã? Obrigado!"), "Português")
        check("detect: too short says nothing", DetectedLanguage.of("ok"), String?.none)
        check("detect: no letters says nothing", DetectedLanguage.of("12345 !!! 678"), String?.none)
        check("detect: a language off the list is named in itself", DetectedLanguage.name(code: "sw"), "Kiswahili")
        check("detect: a region or script is dropped", DetectedLanguage.name(code: "pt-BR"), "Português")
        check("detect: zh-Hans is 中文", DetectedLanguage.name(code: "zh-Hans"), "中文")
        check("detect: und is none", DetectedLanguage.name(code: "und"), String?.none)

        // A sent message, as the chat shows it: the same first 40 letters and digits are enough.
        check("postedAs: the same text", Teams.postedAs("Can you send me the slides?", "Can you send me the slides?"), true)
        check("postedAs: other spacing, punctuation and case", Teams.postedAs("Sure,  I'll send it\ntoday.", "sure i'll send it today"), true)
        check("postedAs: Teams adds a link's preview after it", Teams.postedAs("The notes are here: https://example.com/notes", "The notes are here: https://example.com/notes Example Notes - a shared page"), true)
        check("postedAs: another message isn't it", Teams.postedAs("Can you send me the slides?", "Thanks, see you then."), false)
        check("postedAs: an empty text never matches", Teams.postedAs("  ...  ", "Anything at all"), false)
        check("postedAs: Teams' autocorrect fixed a word", Teams.postedAs("Did you recieve the invoice?", "Did you receive the invoice?"), true)
        check("postedAs: a long message with one fixed word", Teams.postedAs("The plant order is packed and the van leaves at nine. Tell me when you recieve the boxes.", "The plant order is packed and the van leaves at nine. Tell me when you receive the boxes."), true)
        check("postedAs: a different short reply isn't it", Teams.postedAs("Sure, see you then.", "Sure, send it then."), false)
        check("postedAs: a box with only part of it isn't it", Teams.postedAs("Could you take a look at the budget before Thursday?", "Could you take"), false)
        check("holds: the same text", Teams.holds("Can you send it?", "Can you send it?"), true)
        check("holds: Teams' autocorrect fixed a word", Teams.holds("Did you receive the invoice?", "Did you recieve the invoice?"), true)
        check("holds: the text twice isn't it", Teams.holds("Can you send it today? Can you send it today?", "Can you send it today?"), false)
        check("holds: half of it isn't it", Teams.holds("Could you take a look", "Could you take a look at the budget before Thursday?"), false)
        check("holds: another text isn't it", Teams.holds("See you on Monday.", "Can you send it?"), false)
        check("postedAs: a reply after its quote", Teams.postedAs("Sure, sending it now.", "Sam Lee 11/05/2026 10:12 Can you send the deck before noon? Sure, sending it now."), true)
        // Teams shortens a long link in its box and in the chat: its start, then "…".
        let mapLink = "https://maps.example.com/place/Example+Bakery/@12.3456000,-45.6789000,3a,75y,90t/data=!3m8!1e2!3m6!1sAbCdEfGhIjKlMnOp0001!2e10!3e12!6shttps:%2F%2Fphotos.example.com%2Fp%2FAbCdEfGhIjKlMnOpQrStUvWxYz0123456789%3Dw203-h114-k-no!7i4032!8i2268?entry=ttu"
        let linkText = "Here's the place I mentioned.\n" + mapLink
        let shortBox = "Here's the place I mentioned.\nhttps://maps.example.com/place/Example+Bakery/@12.3456000,-45.6789000,3a,75y,90t/data=!3m8!1e2!3m6!…"
        check("unshortened: a shortened link gets its whole address back", Teams.unshortened(shortBox, from: linkText), linkText)
        check("unshortened: nothing shortened, nothing changes", Teams.unshortened("See https://example.com/a", from: "See https://example.com/a"), "See https://example.com/a")
        check("unshortened: a shortened link that starts no sent link stays", Teams.unshortened("See https://other.example.org/some/long/path…", from: linkText), "See https://other.example.org/some/long/path…")
        check("unshortened: a bare start matches nothing", Teams.unshortened("See https://…", from: linkText), "See https://…")
        check("unshortened: two links, each to its own", Teams.unshortened("First https://example.com/aaaaaaaaaa/b… then https://example.com/aaaaaaaaaa/c…", from: "First https://example.com/aaaaaaaaaa/bbbb then https://example.com/aaaaaaaaaa/cccc"), "First https://example.com/aaaaaaaaaa/bbbb then https://example.com/aaaaaaaaaa/cccc")
        check("unshortened: Teams shows the link decoded", Teams.unshortened("Market https://maps.example.com/place/Café+Corner/@12.34…", from: "Market https://maps.example.com/place/Caf%C3%A9+Corner/@12.3456,-45.6789,17z"), "Market https://maps.example.com/place/Caf%C3%A9+Corner/@12.3456,-45.6789,17z")
        check("holds: a box with the link shortened", Teams.holds(shortBox, linkText), true)
        check("holds: a shortened link with other words around it isn't it", Teams.holds("Another place entirely, much farther away and only open on weekends, so not the one I meant at all.\nhttps://maps.example.com/place/Example+Bakery/@12.3456000,-45.6789000,3a,75y,90t/data=!3m8!1e2!3m6!…", linkText), false)
        check("postedAs: the message in the chat with the link shortened", Teams.postedAs(linkText, shortBox), true)
        check("postedAs: a message that starts with a shortened link", Teams.postedAs(mapLink, "https://maps.example.com/place/Example+Bakery/@12.3456000,-45.6789000,3a,75y,90t/data=!3m8!1e2!3m6!…"), true)
        check("boxValue: a box that can't be read is nil", TeamsScan.boxValue(Node("AXTextArea", id: "new-message-1"), FakeAX()), String?.none)
        check("context: a quote alone isn't a draft",
              TeamsScan.context(title: "Chat | Sam Lee | Microsoft Teams", boxValue: TeamsScan.boxValue(quoteBox([paragraph("\u{2060}")], value: shortQuote + "\u{2060}"), FakeAX()), placeholder: "Type a message", hasList: true, from: nil, last: nil).draft, false)
        check("boxText: outer whitespace is trimmed, inner kept", Teams.boxText("  \n One  two \n"), "One  two")
        check("boxText: the box's own placeholder in another language is empty", Teams.boxText("Escribe un mensaje\n", placeholder: "Escribe un mensaje"), "")
        check("boxText: with another placeholder, the English one is a draft", Teams.boxText("Type a message", placeholder: "Escribe un mensaje"), "Type a message")
        check("boxText: an empty placeholder strips nothing", Teams.boxText("Hello", placeholder: ""), "Hello")

        // The same text, line by line.
        check("sameText: the same text", Teams.sameText("Can you send me the slides?", "Can you send me the slides?"), true)
        check("sameText: a non-breaking space equals a space", Teams.sameText("Can\u{00A0}you send it?", "Can you send it?"), true)
        check("sameText: spaces at line ends don't matter", Teams.sameText("One  \nTwo \n", "One\nTwo"), true)
        check("sameText: blank lines between paragraphs don't matter", Teams.sameText("One\n\nTwo", "One\nTwo"), true)
        check("sameText: line endings don't matter", Teams.sameText("One\r\nTwo", "One\nTwo"), true)
        check("sameText: the placeholder equals nothing", Teams.sameText("Type a message\n", ""), true)
        check("sameText: one word different is caught", Teams.sameText("Can you send me the slides?", "Can you send me the slide?"), false)
        check("sameText: one word added is caught", Teams.sameText("Can you send me the slides?", "Can you send me the slides today?"), false)
        check("sameText: a different case is caught", Teams.sameText("Thanks", "thanks"), false)
        check("sameText: a line break where a space was is caught", Teams.sameText("One Two", "One\nTwo"), false)
        check("sameText: a missing second line is caught", Teams.sameText("One\nTwo", "One"), false)
        check("sameText: a draft is not the placeholder", Teams.sameText("Hello", "Type a message"), false)
        check("sameText: the box's own placeholder equals nothing", Teams.sameText("Escribe un mensaje\n", "", placeholder: "Escribe un mensaje"), true)
    }

    // A made-up Teams window: a header, the message list (with a decoy text area inside a message,
    // which the walk must never reach), the message box, and the messages.
    static func chatWindow(box: Node? = Node("AXTextArea", id: "new-message-0a1b", desc: "Type a message", value: "Type a message\n"),
                           items: [Node]? = nil) -> (window: Node, box: Node?, list: Node) {
        let messages = items ?? [
            Node("AXHeading", title: "Can you send the deck by Sam Lee"),
            message("1", mine: false, text: "Can you send the deck before noon?", decoy: true),
            Node("AXHeading", title: "Sure by Ana Ruiz"),
            message("2", mine: true, text: "On it"),
        ]
        let list = Node("AXList", id: "chat-pane-list", kids: messages)
        let pane = Node("AXGroup", id: "message-pane-layout-a1", kids: [
            Node("AXGroup", desc: "Message List", kids: [Node("AXGroup", kids: [list])]),
            Node("AXGroup", kids: box.map { [Node("AXGroup", kids: [$0])] } ?? []),
        ])
        let window = Node("AXWindow", kids: [
            Node("AXGroup", id: "chat-header-x", kids: [Node("AXHeading", title: "Project sync")]),
            Node("AXGroup", kids: [Node("AXGroup", kids: [pane])]),
        ])
        return (window, box, list)
    }

    static func message(_ n: String, mine: Bool, text: String, decoy: Bool = false) -> Node {
        var kids = [Node("AXGroup", id: "content-\(n)", desc: text)]
        if decoy { kids.append(Node("AXTextArea", id: "new-message-decoy", desc: "Type a message", value: "")) }
        let body = Node("AXGroup", id: "message-body-\(n)", classes: [mine ? "fui-ChatMyMessage__body" : "fui-ChatMessage__body", "x1"], kids: kids)
        return Node("AXGroup", kids: [Node("AXGroup", id: "author-\(n)"), body])
    }

    static func tree() {
        let fake = FakeAX()
        let w = chatWindow()
        let found = TeamsScan.find(in: w.window, fake)
        check("find: the message box, by role and DOM id", found.box === w.box, true)
        check("find: the box's placeholder, from its description", found.placeholder, "Type a message")
        check("find: the message list, by DOM id", found.list === w.list, true)
        check("find: the walk never goes into the messages", fake.visited.contains { $0.id == "new-message-decoy" || $0.id.hasPrefix("content-") }, false)

        let spanish = Node("AXTextArea", id: "new-message-9z", desc: "Escribe un mensaje", value: "Escribe un mensaje\n")
        let s = TeamsScan.find(in: chatWindow(box: spanish).window, FakeAX())
        check("find: a box in another language is found by its id", s.box === spanish, true)
        check("find: and its own placeholder comes with it", s.placeholder, "Escribe un mensaje")
        let renamed = Node("AXTextArea", id: "composer-7", desc: "Type a message", value: "")
        check("find: a box with an unknown id isn't taken for its placeholder", TeamsScan.find(in: chatWindow(box: renamed).window, FakeAX()).box == nil, true)
        check("find: no box in the window", TeamsScan.find(in: chatWindow(box: nil).window, FakeAX()).box == nil, true)
        // Two boxes, as in a channel with a reply open: the one with Teams' cursor, or none.
        let post = Node("AXTextArea", id: "new-message-p1", desc: "Type a message", value: "Type a message\n")
        let reply = Node("AXTextArea", id: "new-message-r1", desc: "Reply", value: "Reply\n", focused: true)
        let two = Node("AXWindow", kids: [Node("AXGroup", kids: [post]), Node("AXGroup", kids: [reply])])
        let t = TeamsScan.find(in: two, FakeAX())
        check("find: two boxes are both counted", t.boxes, 2)
        check("find: of two boxes, the one with Teams' cursor", t.box === reply, true)
        check("find: and its own placeholder", t.placeholder, "Reply")
        check("find: two boxes with the cursor in one are not 'several'", t.several, false)
        let replyIdle = Node("AXTextArea", id: "new-message-r2", desc: "Reply", value: "Reply\n")
        let none = TeamsScan.find(in: Node("AXWindow", kids: [post, replyIdle]), FakeAX())
        check("find: two boxes and no cursor: no box", none.box == nil, true)
        check("find: two boxes and no cursor: several", none.several, true)
        check("find: one box is taken even without the cursor", TeamsScan.find(in: Node("AXWindow", kids: [post]), FakeAX()).box === post, true)
        check("context: several boxes and no cursor is shape several, with the chat",
              TeamsScan.context(title: "Chat | Ops sync | Acme Org | Microsoft Teams", boxValue: nil, placeholder: "", hasList: true, from: nil, last: nil, several: true),
              TeamsContext(open: true, chat: "Ops sync", from: nil, last: nil, draft: false, shape: "several"))
        let wide = Node("AXWindow", kids: (0..<9000).map { _ in Node("AXGroup") })
        check("find: the walk stops after 8,000 elements", TeamsScan.find(in: wide, FakeAX()).nodes, TeamsShape.walkLimit + 1)

        // The last message: someone else's if there is one, else the user's own.
        let items = { (n: Node) in n.kids }
        check("lastMessage: the other person's last message and its author", pair(TeamsScan.lastMessage(items: items(w.list), FakeAX())), pair(("Sam Lee", "Can you send the deck before noon?")))
        let mineOnly = [Node("AXHeading", title: "Hi by Ana Ruiz"), message("3", mine: true, text: "Hello there"),
                        Node("AXHeading", title: "Later by Ana Ruiz"), message("4", mine: true, text: "Still there?")]
        check("lastMessage: only the user's own: the last of them", pair(TeamsScan.lastMessage(items: mineOnly, FakeAX())), pair(("Ana Ruiz", "Still there?")))
        check("lastMessage: no heading before it: no author", pair(TeamsScan.lastMessage(items: [message("5", mine: false, text: "Ping")], FakeAX())), pair((nil, "Ping")))
        check("lastMessage: no messages", pair(TeamsScan.lastMessage(items: [], FakeAX())), pair((nil, nil)))
        let emptyBody = [message("6", mine: false, text: "Older one"), message("7", mine: false, text: "   ")]
        check("lastMessage: a message with no text is skipped", pair(TeamsScan.lastMessage(items: emptyBody, FakeAX())), pair((nil, "Older one")))
        let long = [message("8", mine: false, text: "Far back")] + (0..<16).map { message("m\($0)", mine: true, text: "Mine \($0)") }
        check("lastMessage: only the last 15 are looked at", pair(TeamsScan.lastMessage(items: long, FakeAX())), pair((nil, "Mine 15")))
        let longText = String(repeating: "a", count: 5000)
        check("lastMessage: the text is cut at 4,000 characters", TeamsScan.lastMessage(items: [message("9", mine: false, text: longText)], FakeAX()).last?.count, 4000)

        // What the page is told.
        let chatTitle = "Chat | Project sync | Acme Org | Microsoft Teams"
        let ok = TeamsScan.context(title: chatTitle, boxValue: "Type a message\n", placeholder: "Type a message", hasList: true, from: "Sam Lee", last: "Hi")
        check("context: a chat with an empty box", ok, TeamsContext(open: true, chat: "Project sync", from: "Sam Lee", last: "Hi", draft: false))
        check("context: a draft in the box", TeamsScan.context(title: chatTitle, boxValue: "Half a thought", placeholder: "Type a message", hasList: true, from: nil, last: nil).draft, true)
        check("context: a box holding its own placeholder in another language is no draft", TeamsScan.context(title: chatTitle, boxValue: "Escribe un mensaje\n", placeholder: "Escribe un mensaje", hasList: true, from: nil, last: nil).draft, false)
        let unknown = TeamsScan.context(title: chatTitle, boxValue: nil, placeholder: "Type a message", hasList: true, from: "Sam Lee", last: "Hi")
        check("context: a chat's window with no box is shape unknown", unknown, TeamsContext(open: true, chat: "Project sync", from: nil, last: nil, draft: false, shape: "unknown"))
        check("context: a message list with no box is shape unknown", TeamsScan.context(title: "Microsoft Teams", boxValue: nil, placeholder: "", hasList: true, from: nil, last: nil).shape, "unknown")
        check("context: another view with no box is no chat", TeamsScan.context(title: "Calendar | Acme Org | Microsoft Teams", boxValue: nil, placeholder: "", hasList: false, from: nil, last: nil), TeamsContext.noChat)
        check("context: a pop-out window with a box has no chat name", TeamsScan.context(title: "Project sync | Acme Org | Microsoft Teams", boxValue: "", placeholder: "Type a message", hasList: true, from: nil, last: nil).chat, String?.none)
        check("context: the page gets the shape", TeamsContext.noChat.page["shape"] as? String, "ok")
        check("context: the page gets an unknown shape", unknown.page["shape"] as? String, "unknown")
    }

    static func pair(_ p: (from: String?, last: String?)) -> [String] { [p.from ?? "nil", p.last ?? "nil"] }

    // After ⌘V: the box changed or not, and the clipboard still the shell's own or not.
    static func paste() {
        check("paste: the box changed, clipboard untouched: pasted, put back",
              PasteWatch.decide(before: "", after: "Can you send it?", own: 41, now: 41), PasteWatch.Decision(pasted: true, restore: true))
        check("paste: the box didn't change yet: not pasted",
              PasteWatch.decide(before: "", after: "", own: 41, now: 41), PasteWatch.Decision(pasted: false, restore: true))
        check("paste: the box can't be read: not pasted",
              PasteWatch.decide(before: "", after: nil, own: 41, now: 41), PasteWatch.Decision(pasted: false, restore: true))
        check("paste: the user copied something meanwhile: not put back",
              PasteWatch.decide(before: "", after: "Can you send it?", own: 41, now: 42), PasteWatch.Decision(pasted: true, restore: false))
        check("paste: never changed and the user copied: neither",
              PasteWatch.decide(before: "", after: "", own: 41, now: 43), PasteWatch.Decision(pasted: false, restore: false))
        check("paste: after a draft, the draft alone is no paste",
              PasteWatch.decide(before: "Half a thought", after: "Half a thought", own: 7, now: 7).pasted, false)
        check("paste: after a draft, more text is the paste",
              PasteWatch.decide(before: "Half a thought", after: "Half a thought\nCan you send it?", own: 7, now: 7).pasted, true)
        check("paste: restores only on the shell's own changeCount", [PasteWatch.restores(own: 5, now: 5), PasteWatch.restores(own: 5, now: 6)], [true, false])
        check("paste: watched every 50 ms for up to 5 s", [PasteWatch.every, PasteWatch.limit], [0.05, 5])
        check("paste: the box looked for again after 0.5 s, then every second", [PasteWatch.lookAfter, PasteWatch.lookEvery], [0.5, 1])
    }

    // The send's outcome line: its start, then what was measured, numbers only; a field not measured is left out.
    static func sendLog() {
        check("send log: under 100 chars", [SendLog.bucket(0), SendLog.bucket(1), SendLog.bucket(99)], ["under 100", "under 100", "under 100"])
        check("send log: 100 to 499 chars", [SendLog.bucket(100), SendLog.bucket(499)], ["100 to 499", "100 to 499"])
        check("send log: 500 to 1,999 chars", [SendLog.bucket(500), SendLog.bucket(1999)], ["500 to 1,999", "500 to 1,999"])
        check("send log: 2,000 or more chars", [SendLog.bucket(2000), SendLog.bucket(12000)], ["2,000 or more", "2,000 or more"])
        check("send log: the contract's example",
              SendLog.line("send: sent", SendLog.Measured(pastes: 1, boxMs: 85, totalMs: 1240, chars: 230, link: false, mode: "send")),
              "send: sent · pastes 1, box 85 ms, total 1240 ms, 100 to 499 chars, link no, send")
        check("send log: two pastes, a link, left in the box",
              SendLog.line("send: left in the message box", SendLog.Measured(pastes: 2, boxMs: 140, totalMs: 2310, chars: 40, link: true, mode: "leave")),
              "send: left in the message box · pastes 2, box 140 ms, total 2310 ms, under 100 chars, link yes, leave")
        check("send log: stopped before the paste, no pastes and no box",
              SendLog.line("send: not sent (chat-changed)", SendLog.Measured(totalMs: 310, chars: 650, link: false, mode: "send")),
              "send: not sent (chat-changed) · total 310 ms, 500 to 1,999 chars, link no, send")
        check("send log: pasted but the box never changed, no box",
              SendLog.line("send: not sent (no-paste)", SendLog.Measured(pastes: 1, totalMs: 5600, chars: 2400, link: false, mode: "send")),
              "send: not sent (no-paste) · pastes 1, total 5600 ms, 2,000 or more chars, link no, send")
        check("send log: nothing measured, the start alone", SendLog.line("send: sent", SendLog.Measured()), "send: sent")
        check("send log: a link", [SendLog.hasLink("The notes are at https://example.com/notes"), SendLog.hasLink("See www.example.org"), SendLog.hasLink("No link here.")], [true, true, false])
        check("send log: milliseconds, rounded, never below zero", [SendLog.ms(since: 10, now: 10.0854), SendLog.ms(since: 10, now: 9)], [85, 0])
        // Front and raise come after the mode; raise is left out when Teams already was front.
        check("send log: Teams not front, raised in 120 ms",
              SendLog.line("send: sent", SendLog.Measured(pastes: 1, boxMs: 85, totalMs: 1240, chars: 230, link: false, mode: "send", front: false, raiseMs: 120)),
              "send: sent · pastes 1, box 85 ms, total 1240 ms, 100 to 499 chars, link no, send, front no, raise 120 ms")
        check("send log: Teams already front, no raise",
              SendLog.line("send: left in the message box", SendLog.Measured(pastes: 1, boxMs: 60, totalMs: 900, chars: 40, link: false, mode: "leave", front: true)),
              "send: left in the message box · pastes 1, box 60 ms, total 900 ms, under 100 chars, link no, leave, front yes")
        check("send log: refused before Teams was asked, front only",
              SendLog.line("send: not sent (not-own-server)", SendLog.Measured(totalMs: 15, chars: 12, link: false, mode: "send", front: false)),
              "send: not sent (not-own-server) · total 15 ms, under 100 chars, link no, send, front no")
        check("send log: pasting again, after 430 ms", SendLog.pastingAgain(afterMs: 430),
              "send: Teams emptied its box after the paste; pasting again · after 430 ms")
        check("send log: pasting again, not measured", SendLog.pastingAgain(afterMs: nil),
              "send: Teams emptied its box after the paste; pasting again")
    }

    // After Return with the box empty: a new chat stays sent; a list that vanished is unconfirmed; a list
    // there before and after is checked for the message.
    static func sendConfirm() {
        check("confirm: a new chat (no list before) is sent", SendConfirm.afterReturn(listBefore: false, listNow: false), .ok)
        check("confirm: no list before, one now: still sent, as before", SendConfirm.afterReturn(listBefore: false, listNow: true), .ok)
        check("confirm: a list that vanished is unconfirmed", SendConfirm.afterReturn(listBefore: true, listNow: false), .unconfirmed)
        check("confirm: a list before and after is checked for the message", SendConfirm.afterReturn(listBefore: true, listNow: true), .check)
        check("confirm: the list has 1 s to answer again", SendConfirm.listWait, 1)
    }

    // The update check: the three anchors the send relies on, looked for on made-up trees, and when a look
    // gives the answer (at once when all are there; after a wait when one is missing).
    static func teamsCheck() {
        let chatTitle = "Chat | Project sync | Acme Org | Microsoft Teams"
        func look(_ title: String, _ window: Node) -> TeamsCheck.Anchors? { TeamsCheck.anchors(title: title, found: TeamsScan.find(in: window, FakeAX())) }
        let all = TeamsCheck.Anchors(box: true, list: true, title: true)
        check("teams check: a chat window today has all three", look(chatTitle, chatWindow().window), all)
        check("teams check: a renamed box is missing",
              look(chatTitle, chatWindow(box: Node("AXTextArea", id: "composer-7", desc: "Type a message", value: "")).window),
              TeamsCheck.Anchors(box: false, list: true, title: true))
        let renamedList = Node("AXWindow", kids: [Node("AXGroup", id: "message-pane-layout-a1", kids: [
            Node("AXList", id: "chat-pane-items", kids: [message("1", mine: false, text: "See you at three")]),
            Node("AXGroup", kids: [Node("AXTextArea", id: "new-message-0a1b", desc: "Type a message", value: "Type a message\n")]),
        ])])
        check("teams check: a renamed list is missing", look(chatTitle, renamedList), TeamsCheck.Anchors(box: true, list: false, title: true))
        check("teams check: a title it can't read is missing", look("Project sync | Acme Org | Microsoft Teams", chatWindow().window),
              TeamsCheck.Anchors(box: true, list: true, title: false))
        check("teams check: a box in another language still counts",
              look(chatTitle, chatWindow(box: Node("AXTextArea", id: "new-message-9z", desc: "Escribe un mensaje", value: "Escribe un mensaje\n")).window), all)
        let twoBoxes = Node("AXWindow", kids: [Node("AXGroup", id: "pane", kids: [
            Node("AXList", id: "chat-pane-list"),
            Node("AXTextArea", id: "new-message-p1", desc: "Type a message", value: "Type a message\n"),
            Node("AXTextArea", id: "new-message-r2", desc: "Reply", value: "Reply\n"),
        ])])
        check("teams check: two boxes and no cursor still have the box", look(chatTitle, twoBoxes), all)
        let noTree = Node("AXWindow", kids: [Node("AXGroup", kids: [Node("AXGroup")])])
        check("teams check: a chat title with the tree not up yet can't count", look(chatTitle, noTree), TeamsCheck.Anchors?.none)
        let calendar = Node("AXWindow", kids: [Node("AXGroup", id: "calendar-grid", kids: [Node("AXButton", id: "new-event")])])
        check("teams check: another view can't count", look("Calendar | Acme Org | Microsoft Teams", calendar), TeamsCheck.Anchors?.none)
        let allGone = Node("AXWindow", kids: [Node("AXGroup", id: "message-pane-v2", kids: [Node("AXTextArea", id: "composer-1")])])
        check("teams check: nothing it knows and no chat title can't count", look("Project sync | Acme Org | Microsoft Teams", allGone), TeamsCheck.Anchors?.none)
        check("teams check: the missing ones in words", TeamsCheck.Anchors(box: false, list: true, title: false).missing, ["message box", "chat title"])

        check("teams check: the log line, all there", TeamsCheck.line(all), "Teams check: box ok, list ok, title ok")
        check("teams check: the log line, one missing", TeamsCheck.line(TeamsCheck.Anchors(box: true, list: false, title: true)),
              "Teams check: box ok, list missing, title ok")
        check("teams check: ok and changed", [TeamsCheck.value(all), TeamsCheck.value(TeamsCheck.Anchors(box: false, list: true, title: true))], ["ok", "changed"])

        // When a look answers.
        let noList = TeamsCheck.Anchors(box: true, list: false, title: true)
        func answer(_ r: (pending: TeamsCheck.Pending?, answer: TeamsCheck.Anchors?)) -> TeamsCheck.Anchors? { r.answer }
        check("teams check: all three answer at once", answer(TeamsCheck.step(nil, all, now: 100)), all)
        check("teams check: a look that can't count answers nothing", TeamsCheck.step(nil, nil, now: 100).answer, TeamsCheck.Anchors?.none)
        check("teams check: a look that can't count ends a wait", TeamsCheck.step(TeamsCheck.Pending(since: 90, looks: 2), nil, now: 100).pending, TeamsCheck.Pending?.none)
        check("teams check: one missing waits", TeamsCheck.step(nil, noList, now: 100).pending, TeamsCheck.Pending(since: 100, looks: 1))
        check("teams check: still missing after 2 s, waits", TeamsCheck.step(TeamsCheck.Pending(since: 100, looks: 1), noList, now: 102).answer, TeamsCheck.Anchors?.none)
        check("teams check: three looks but under 10 s, waits", TeamsCheck.step(TeamsCheck.Pending(since: 100, looks: 2), noList, now: 109).answer, TeamsCheck.Anchors?.none)
        check("teams check: 10 s but two looks, waits", TeamsCheck.step(TeamsCheck.Pending(since: 100, looks: 1), noList, now: 130).answer, TeamsCheck.Anchors?.none)
        check("teams check: three looks over 10 s, changed", TeamsCheck.step(TeamsCheck.Pending(since: 100, looks: 2), noList, now: 110).answer, noList)
        check("teams check: built meanwhile, ok", TeamsCheck.step(TeamsCheck.Pending(since: 100, looks: 2), all, now: 104).answer, all)

        // What the page gets.
        var c = TeamsContext(open: true, chat: "Project sync", from: nil, last: nil, draft: false)
        check("teams check: before the check, null and no missing", [c.page["check"] is NSNull, c.page["missing"] == nil], [true, true])
        c.check = "changed"; c.missing = ["message list"]
        check("teams check: changed, with what's missing", [c.page["check"] as? String == "changed", (c.page["missing"] as? [String]) == ["message list"]], [true, true])
    }

    // "app: Teams <version>": at the first Teams found, then only when a new process has another version.
    static func teamsVersion() {
        check("teams version: the first one found is logged", Teams.versionLine("10.2.3", logged: nil), "Teams 10.2.3")
        check("teams version: the same version again isn't", Teams.versionLine("10.2.3", logged: "10.2.3"), String?.none)
        check("teams version: another version is", Teams.versionLine("10.4.0", logged: "10.2.3"), "Teams 10.4.0")
        check("teams version: unreadable is unknown", Teams.versionLine(nil, logged: nil), "Teams unknown")
        check("teams version: unknown twice is logged once", Teams.versionLine(nil, logged: "unknown"), String?.none)
        check("teams version: only letters, digits, dots, dashes and spaces", Teams.versionShown("1.2\n3; rm -rf"), "1.23 rm -rf")
        check("teams version: at most 40 characters", Teams.versionShown(String(repeating: "9", count: 60)).count, 40)
    }

    // The server answering on the port must be the app's own, and the message from its page's main frame.
    static func ownServer() {
        var asked: [pid_t] = []
        let appServers: Set<pid_t> = [4242]
        let isApp = { (pid: pid_t) -> Bool in asked.append(pid); return appServers.contains(pid) }
        check("own server: the keeper's own child", OwnServer.isOwn(pid: 900, keeperPid: 900, isAppServer: isApp), true)
        check("own server: the keeper's child needs no other look", asked, [])
        check("own server: a server inside an app with this bundle ID", OwnServer.isOwn(pid: 4242, keeperPid: 900, isAppServer: isApp), true)
        check("own server: a server run by hand", OwnServer.isOwn(pid: 5150, keeperPid: 900, isAppServer: isApp), false)
        check("own server: no keeper child, a hand-run server", OwnServer.isOwn(pid: 5150, keeperPid: nil, isAppServer: isApp), false)
        check("own server: no pid in /api/state", OwnServer.isOwn(pid: nil, keeperPid: 900, isAppServer: isApp), false)
        check("own server: pid 1 is never it", OwnServer.isOwn(pid: 1, keeperPid: 1, isAppServer: isApp), false)
        check("refusal: main frame, local origin, own server: sends", OwnServer.refusal(mainFrame: true, localOrigin: true, own: true), String?.none)
        check("refusal: not the app's own server", OwnServer.refusal(mainFrame: true, localOrigin: true, own: false), "not-own-server")
        check("refusal: a subframe", OwnServer.refusal(mainFrame: false, localOrigin: true, own: true), "not-own-server")
        check("refusal: another origin", OwnServer.refusal(mainFrame: true, localOrigin: false, own: true), "not-own-server")
    }
}

// A made-up accessibility element.
final class Node {
    let role: String
    let id: String
    let classes: [String]
    let desc: String
    let title: String
    let value: String?
    let focused: Bool
    let kids: [Node]
    init(_ role: String, id: String = "", classes: [String] = [], desc: String = "", title: String = "", value: String? = nil, focused: Bool = false, kids: [Node] = []) {
        self.role = role; self.id = id; self.classes = classes; self.desc = desc; self.title = title; self.value = value; self.focused = focused; self.kids = kids
    }
}

// The made-up tree behind the same protocol the live one uses. It remembers what was looked at.
final class FakeAX: AXReading {
    var visited: [Node] = []
    func attrs(_ e: Node, _ names: [String]) -> [Any?] {
        visited.append(e)
        return names.map { name -> Any? in
            switch name {
            case "AXRole": return e.role
            case "AXDOMIdentifier": return e.id.isEmpty ? nil : e.id
            case "AXDOMClassList": return e.classes
            case "AXDescription": return e.desc.isEmpty ? nil : e.desc
            case "AXTitle": return e.title.isEmpty ? nil : e.title
            case "AXValue": return e.value
            case "AXFocused": return e.focused
            case "AXChildren": return e.kids
            default: return nil
            }
        }
    }
    func same(_ a: Node, _ b: Node) -> Bool { a === b }
}
