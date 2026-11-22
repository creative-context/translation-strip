// Reading Teams through Accessibility: where its main window is, the chat open in it, the
// message box and the last message. Nothing here is stored or logged: the reader keeps only
// the elements it found, so the next read is cheap, and the last answer it gave.
//
// Every string and DOM identifier the shell relies on lives in TeamsShape, so a Teams update
// is one edit there. The tree walks (find, lastMessage) go through a small protocol,
// AXReading, so the Swift check can run them on a made-up tree.

import AppKit
import ApplicationServices

// What Teams shows (the new Teams, com.microsoft.teams2), as seen on 2026-11-15:
//   - a chat in the main window has the title "Chat | <chat name> | <org> | <account>"; other
//     views ("Calendar | …") and pop-out chat windows ("<chat name> | <org> | <account>") don't;
//   - the message box is an AXTextArea whose DOM id starts with "new-message-"; its description
//     is the placeholder ("Type a message" in English), and its value is that placeholder plus
//     a line break while it's empty;
//   - the messages are the children of the element with DOM id "chat-pane-list": a heading per
//     message ("<preview> by <author>") and a group per message whose body has the DOM id
//     "message-body-<id>" (class fui-ChatMyMessage__body for the user's own) and holds
//     "content-<id>", described with the whole text.
enum TeamsShape {
    static let bundleID = "com.microsoft.teams2"

    // Titles.
    static let titleSeparator = " | "
    static let chatView = "Chat" // the first part of a chat's window title
    static let selfMarker = "(You)" // the user's own chat with themself

    // The message box: found by role and DOM id. The placeholder is only stripped from its
    // value; the box's own description gives it, this one stands in when it gives none.
    static let boxRole = "AXTextArea"
    static let boxIDPrefix = "new-message-"
    static let placeholder = "Type a message"
    // A reply's quote: Teams puts it inside the box, as a card before the paragraphs, and the
    // box's value includes it in short.
    static let quoteClass = "card__react-wrapper"
    static let textRole = "AXStaticText"

    // The messages.
    static let listID = "chat-pane-list"
    static let headingRole = "AXHeading"
    static let messageRole = "AXGroup"
    static let bodyIDPrefix = "message-body-"
    static let myMessageClassPrefix = "fui-ChatMyMessage"
    static let contentIDPrefix = "content-"
    static let authorSeparator = " by " // "<preview> by <author>"

    // Links. Teams shows a long one, in the box and in the chat, as its start and an ellipsis
    // ("https://www.example.com/maps/place/…"); the link keeps the whole address. A shortened link
    // counts as a sent one only from this many characters, so a bare "https://…" matches nothing.
    static let ellipsis = "…"
    static let link = try! NSRegularExpression(pattern: #"(?:https?://|www\.)[^\s]+"#)
    static let shortLink = try! NSRegularExpression(pattern: #"(?:https?://|www\.)[^\s…]*…"#)
    static let shortLinkMin = 16

    // Accessibility attribute names Teams' web content answers to.
    static let domID = "AXDOMIdentifier"
    static let domClasses = "AXDOMClassList"

    // Teams builds its page's accessibility tree only when asked. AXEnhancedUserInterface is the
    // ask screen readers make: Teams answers "not implemented" and builds the tree anyway.
    // AXManualAccessibility is the older ask, which today's Teams doesn't support.
    static let treeAsks = ["AXEnhancedUserInterface", "AXManualAccessibility"]

    // Limits: a walk looks at 8,000 elements at most, 80 levels deep; the last message is
    // looked for among the last 15; a message's text is cut at 4,000 characters.
    static let walkLimit = 8000
    static let findAgain: TimeInterval = 1 // how often to search again while the box isn't found
    static let askAgain: TimeInterval = 5 // how often to ask for the tree again while the box isn't found
    static let postedWait: TimeInterval = 5 // how long a sent message has to show in the chat
    static let pasteSettle: TimeInterval = 0.4 // between the paste showing in the box and Return
    static let depthLimit = 80
    static let messagesBack = 15
    static let textLimit = 4000
}

let teamsBundleID = TeamsShape.bundleID

// Reading attributes of a tree, live (AXUIElement) or made up (the check's fixture).
protocol AXReading {
    associatedtype Element
    // The attributes asked, in order; one that's missing comes back nil. Children come back
    // as [Element].
    func attrs(_ e: Element, _ names: [String]) -> [Any?]
    func same(_ a: Element, _ b: Element) -> Bool
}

enum AX {
    static func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
    }
    static func str(_ e: AXUIElement, _ name: String) -> String { (attr(e, name) as? String) ?? "" }
    static func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

    // Several attributes in one round trip; one that's missing comes back nil.
    static func attrs(_ e: AXUIElement, _ names: [String]) -> [AnyObject?] {
        var out: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(e, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
              let values = out as? [AnyObject], values.count == names.count else { return names.map { _ in nil } }
        return values.map { v in
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
            return v
        }
    }

    static func point(_ v: AnyObject?) -> CGPoint? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }
    static func size(_ v: AnyObject?) -> CGSize? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }
}

// The live tree.
struct LiveAX: AXReading {
    func attrs(_ e: AXUIElement, _ names: [String]) -> [Any?] {
        AX.attrs(e, names).map { v -> Any? in
            guard let v else { return nil }
            if let kids = v as? [AXUIElement] { return kids }
            return v
        }
    }
    func same(_ a: AXUIElement, _ b: AXUIElement) -> Bool { CFEqual(a, b) }
}

// What the page gets in window.strip.teams(...).
struct TeamsContext: Equatable {
    var open: Bool
    var chat: String?
    var from: String?
    var last: String?
    var draft: Bool
    var shape = "ok" // "unknown": a Teams window whose message box can't be found; "several": more than one box (a channel with a reply open) and none has the cursor
    var check: String? = nil // the update check (TeamsCheck), once this Teams process was checked: "ok" or "changed"; nil before
    var missing: [String] = [] // with "changed": what's missing, in words ("message box", "message list", "chat title")

    static let closed = TeamsContext(open: false, chat: nil, from: nil, last: nil, draft: false)
    static let noChat = TeamsContext(open: true, chat: nil, from: nil, last: nil, draft: false)

    var page: [String: Any] {
        var p: [String: Any] = ["open": open, "chat": chat ?? NSNull(), "from": from ?? NSNull(), "last": last ?? NSNull(), "draft": draft, "shape": shape,
                                "check": check ?? NSNull()]
        if check != nil { p["missing"] = missing }
        return p
    }
}

// The update check: once per Teams process, when Teams shows a chat window with its tree up, whether
// the anchors the send relies on are still there: the message box (TeamsShape.boxIDPrefix), the message
// list (TeamsShape.listID) and a chat title it can read (Teams.chatName). Pure, so the Swift check runs
// it on made-up trees. It blocks nothing: the log and the page say it.
enum TeamsCheck {
    struct Anchors: Equatable {
        var box: Bool
        var list: Bool
        var title: Bool
        var ok: Bool { box && list && title }
        // What's missing, in the page's words.
        var missing: [String] {
            [(box, "message box"), (list, "message list"), (title, "chat title")].filter { !$0.0 }.map(\.1)
        }
    }

    // A look that shows something missing waits: Teams may still be building the view. It's the
    // answer once it has held this long, over this many looks; one with everything there answers at once.
    struct Pending: Equatable {
        var since: TimeInterval
        var looks: Int
    }
    static let settle: TimeInterval = 10
    static let looks = 3
    static let walkEvery: TimeInterval = 2 // while waiting, how often the window is walked again for the check

    // What one look at a window shows. nil when it can't count: the page's tree isn't up (no element
    // answered with a DOM id) or the window shows no chat by any of the three (another view, such as the
    // calendar).
    static func anchors(title: String, boxes: Int, hasList: Bool, domIDs: Int) -> Anchors? {
        let a = Anchors(box: boxes > 0, list: hasList, title: Teams.chatName(title) != nil)
        guard domIDs > 0, a.box || a.list || a.title else { return nil }
        return a
    }

    static func anchors<E>(title: String, found: TeamsScan.Found<E>) -> Anchors? {
        anchors(title: title, boxes: found.boxes, hasList: found.list != nil, domIDs: found.domIDs)
    }

    // One look: the new wait and, when the check is answered, its answer. A look that can't count
    // (nil) ends a wait, so a view switched away from starts over.
    static func step(_ pending: Pending?, _ seen: Anchors?, now: TimeInterval) -> (pending: Pending?, answer: Anchors?) {
        guard let seen else { return (nil, nil) }
        if seen.ok { return (nil, seen) }
        var p = pending ?? Pending(since: now, looks: 0)
        p.looks += 1
        if p.looks >= looks, now - p.since >= settle { return (nil, seen) }
        return (p, nil)
    }

    // The log's line (the log adds "app: ").
    static func line(_ a: Anchors) -> String {
        func w(_ b: Bool) -> String { b ? "ok" : "missing" }
        return "Teams check: box \(w(a.box)), list \(w(a.list)), title \(w(a.title))"
    }

    static func value(_ a: Anchors) -> String { a.ok ? "ok" : "changed" }
}

// Where Teams' main window is (top-left origin, as Accessibility and the window list give
// it) and whether it's on screen now: not minimized, not hidden, not on another Space.
struct TeamsWindow: Equatable {
    var frame: CGRect
    var onScreen: Bool
    var id: CGWindowID? = nil // its number in the window list, so the strip can be ordered just above it
}

enum Teams {
    static func running() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: TeamsShape.bundleID).first { !$0.isTerminated }
    }

    // The Teams bundle's short version, read from its Info.plist on disk each time (Bundle caches by
    // path, so an update in place would read as the old version). nil when it can't be read.
    static func version(of teams: NSRunningApplication) -> String? {
        guard let url = teams.bundleURL?.appendingPathComponent("Contents/Info.plist") else { return nil }
        return NSDictionary(contentsOf: url)?["CFBundleShortVersionString"] as? String
    }

    // The log's "app: Teams <version>" line: when the shell first finds Teams, and again when a new
    // Teams process has another version; nil when it's the version already logged. A version that
    // can't be read is "unknown"; one with anything but letters, digits, dots, dashes and spaces, or
    // longer than 40 characters, is cut to what fits.
    static func versionShown(_ version: String?) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".- "))
        let clean = String(String.UnicodeScalarView((version ?? "").unicodeScalars.filter { allowed.contains($0) && $0.isASCII }))
            .trimmingCharacters(in: .whitespaces)
        return clean.isEmpty ? "unknown" : String(clean.prefix(40))
    }

    static func versionLine(_ version: String?, logged: String?) -> String? {
        let shown = versionShown(version)
        return shown == logged ? nil : "Teams \(shown)" // the log adds "app: "
    }

    // The largest normal window that isn't minimized, with its frame.
    // Teams' main window, not a chat popped out of it: the window showing a chat view ("Chat | …")
    // first, then the one whose title has the most parts (the main window names its view, its item
    // and the app; a pop-out names fewer), then the largest.
    static func mainWindow(_ app: AXUIElement) -> (element: AXUIElement, frame: CGRect)? {
        let windows = (AX.attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        var best: (element: AXUIElement, frame: CGRect, rank: (Int, Int, CGFloat))?
        for w in windows {
            let v = AX.attrs(w, [kAXSubroleAttribute, kAXMinimizedAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXTitleAttribute])
            guard (v[0] as? String) == kAXStandardWindowSubrole, (v[1] as? Bool) != true,
                  let p = AX.point(v[2]), let s = AX.size(v[3]), s.width > 0, s.height > 0 else { continue }
            let f = CGRect(origin: p, size: s)
            let title = (v[4] as? String) ?? ""
            let rank = (chatName(title) != nil ? 1 : 0, title.components(separatedBy: " | ").count, f.width * f.height)
            if best.map({ rank > $0.rank }) ?? true { best = (w, f, rank) }
        }
        return best.map { ($0.element, $0.frame) }
    }

    // One of Teams' windows in the window list (bounds need no permission, and no call goes to Teams).
    struct Listed: Equatable {
        var id: CGWindowID
        var frame: CGRect
        var onScreen: Bool
    }

    private static func listed(_ w: [String: Any], pid: pid_t) -> Listed? {
        guard (w[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
              (w[kCGWindowLayer as String] as? Int) == 0,
              let id = (w[kCGWindowNumber as String] as? Int).map(CGWindowID.init),
              let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
        let frame = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        return Listed(id: id, frame: frame, onScreen: (w[kCGWindowIsOnscreen as String] as? Bool) == true)
    }

    // Teams' normal windows: on screen now only, or all of them (minimized and other Spaces too).
    static func listedWindows(pid: pid_t, onScreenOnly: Bool) -> [Listed] {
        let options: CGWindowListOption = onScreenOnly ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements]
        let list = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
        return list.compactMap { listed($0, pid: pid) }
    }

    // One window by its number; nil once it's closed.
    static func listedWindow(_ id: CGWindowID, pid: pid_t) -> Listed? {
        let list = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]]) ?? []
        return list.lazy.compactMap { listed($0, pid: pid) }.first { $0.id == id }
    }

    static func sameFrame(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) < 3 && abs(a.minY - b.minY) < 3 && abs(a.width - b.width) < 3 && abs(a.height - b.height) < 3
    }

    // The main window and whether it's on screen. With Accessibility, its frame comes from
    // there; without it (first run), the largest window in the window list stands in.
    // nil: no window (minimized, or none open).
    static func window(of teams: NSRunningApplication, app: AXUIElement?) -> TeamsWindow? {
        let shown = listedWindows(pid: teams.processIdentifier, onScreenOnly: true)
        if let app, AXIsProcessTrusted() {
            guard let main = mainWindow(app) else { return nil }
            let match = shown.first { sameFrame($0.frame, main.frame) }
            return TeamsWindow(frame: main.frame, onScreen: !teams.isHidden && match != nil, id: match?.id)
        }
        guard let largest = shown.filter({ $0.frame.width > 400 && $0.frame.height > 300 })
            .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { return nil }
        return TeamsWindow(frame: largest.frame, onScreen: !teams.isHidden, id: largest.id)
    }

    // "Chat | <chat name> | <org> | <account>": the chat's name. Any other title (another view,
    // a pop-out window, the app's name) has none.
    static func chatName(_ title: String) -> String? {
        let parts = title.components(separatedBy: TeamsShape.titleSeparator)
        guard parts.count > 1, parts[0].trimmingCharacters(in: .whitespaces) == TeamsShape.chatView else { return nil }
        let name = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    static func isSelfChat(_ title: String) -> Bool { title.contains(TeamsShape.selfMarker) }

    // "<preview> by <author>": the author, or nil.
    static func author(fromHeading title: String) -> String? {
        guard let r = title.range(of: TeamsShape.authorSeparator, options: .backwards) else { return nil }
        let name = title[r.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    // What the message box holds, without its placeholder, with plain spaces and line breaks
    // and no outer whitespace. "" when it's empty.
    static func boxText(_ value: String, placeholder: String = TeamsShape.placeholder) -> String {
        func plain(_ v: String) -> String {
            var s = v.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
                .replacingOccurrences(of: "\u{00A0}", with: " ")
            for invisible in ["\u{200B}", "\u{200C}", "\u{200D}", "\u{2060}", "\u{FEFF}"] { s = s.replacingOccurrences(of: invisible, with: "") }
            return s.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let s = plain(value)
        return !placeholder.isEmpty && s == plain(placeholder) ? "" : s
    }

    // The same words in the same lines, whatever the spacing at line ends or between paragraphs.
    static func sameText(_ a: String, _ b: String, placeholder: String = TeamsShape.placeholder) -> Bool {
        func lines(_ s: String) -> [String] {
            boxText(s, placeholder: placeholder).components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        return lines(a) == lines(b)
    }

    // Whether the message box holds the text that was pasted: the same lines, or, after Teams' own
    // touch-ups (its autocorrect, a link made a link), the same letters and digits within about one
    // in ten, and about as many of them (a paste that landed twice, or half of one, isn't it).
    static func holds(_ box: String, _ text: String, placeholder: String = TeamsShape.placeholder) -> Bool {
        let box = unshortened(box, from: text)
        if sameText(box, text, placeholder: placeholder) { return true }
        func count(_ s: String) -> Int { s.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.count }
        let n = count(text), m = count(boxText(box, placeholder: placeholder))
        guard n > 0, abs(m - n) <= max(2, n / 8) else { return false }
        return postedAs(text, boxText(box, placeholder: placeholder))
    }

    // Whether a box or a message in the chat holds the text just sent: its letters and digits (the
    // first 160), whatever the spacing, punctuation or case, anywhere in the message (a reply's quote
    // comes before it, a link's preview after), with about one in ten different (Teams' autocorrect
    // fixes a word).
    static func postedAs(_ sent: String, _ message: String) -> Bool {
        func key(_ s: String) -> [Unicode.Scalar] { s.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) } }
        let a = Array(key(sent).prefix(160))
        guard !a.isEmpty else { return false }
        let b = Array(key(unshortened(message, from: sent)).prefix(TeamsShape.textLimit))
        // Edits to turn `a` into some stretch of `b` (what comes before and after it is free).
        var row = Array(repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            var next = [i] + Array(repeating: 0, count: b.count)
            for j in 1...max(b.count, 1) where j <= b.count {
                next[j] = Swift.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
            row = next
        }
        let best = row.min() ?? a.count
        return best <= Swift.max(1, a.count / 10)
    }

    // Teams shortens a long link in its box and in the chat, a moment after the paste: the link's
    // start, then "…", while the link itself keeps the whole address. Each shortened link that is
    // the start of one of the sent text's links (with or without percent-encoding) gets that whole
    // link back, in order, so the box and the message compare with what was pasted.
    static func unshortened(_ shown: String, from sent: String) -> String {
        guard shown.contains(TeamsShape.ellipsis) else { return shown }
        let links = matches(TeamsShape.link, in: sent).map { (sent as NSString).substring(with: $0) }
        guard !links.isEmpty else { return shown }
        func plain(_ s: String) -> String { s.removingPercentEncoding ?? s }
        let ns = shown as NSString
        var swaps: [(NSRange, String)] = []
        var next = 0 // links before this one are taken
        for r in matches(TeamsShape.shortLink, in: shown) {
            let start = plain(String(ns.substring(with: r).dropLast()))
            guard start.count >= TeamsShape.shortLinkMin,
                  let i = links.indices.dropFirst(next).first(where: { plain(links[$0]).hasPrefix(start) || links[$0].hasPrefix(start) })
            else { continue }
            swaps.append((r, links[i]))
            next = i + 1
        }
        var out = shown
        for (r, link) in swaps.reversed() { out = (out as NSString).replacingCharacters(in: r, with: link) }
        return out
    }

    private static func matches(_ pattern: NSRegularExpression, in s: String) -> [NSRange] {
        pattern.matches(in: s, range: NSRange(location: 0, length: (s as NSString).length)).map(\.range)
    }
}

// The walks over a window's tree, on any AXReading: the live one or the check's made-up one.
enum TeamsScan {
    struct Found<E> {
        var box: E? // the one box to send to: the only one, or the one with Teams' cursor
        var placeholder: String? // the box's description
        var list: E?
        var nodes = 0
        var boxes = 0 // message boxes in the window (a channel with a reply open has two)
        var domIDs = 0 // elements that answered with a DOM id: 0 while Teams' page tree isn't up
        var several: Bool { boxes > 1 && box == nil } // more than one and none has the cursor
    }

    // One walk of the window for the message box and the message list, by role and DOM id.
    // The messages themselves are skipped: the walk doesn't go into the list.
    static func find<R: AXReading>(in window: R.Element, _ r: R) -> Found<R.Element> {
        var found = Found<R.Element>()
        var first: (box: R.Element, placeholder: String?)?
        var focused: (box: R.Element, placeholder: String?)?
        var stack: [(R.Element, Int)] = [(window, 0)]
        // Every box is counted (no stop at the first): with two, the message must go to the one
        // the user picked in Teams, never to whichever comes first.
        while let (e, depth) = stack.popLast() {
            found.nodes += 1
            if found.nodes > TeamsShape.walkLimit { break }
            let v = r.attrs(e, [kAXRoleAttribute, TeamsShape.domID, kAXDescriptionAttribute, kAXChildrenAttribute, kAXFocusedAttribute])
            let role = v[0] as? String ?? ""
            let id = v[1] as? String ?? ""
            if !id.isEmpty { found.domIDs += 1 }
            if role == TeamsShape.boxRole, id.hasPrefix(TeamsShape.boxIDPrefix) {
                found.boxes += 1
                let one = (box: e, placeholder: (v[2] as? String).flatMap { $0.isEmpty ? nil : $0 })
                if first == nil { first = one }
                if (v[4] as? Bool) == true, focused == nil { focused = one }
                continue
            }
            if id == TeamsShape.listID {
                if found.list == nil { found.list = e }
                continue
            }
            guard depth < TeamsShape.depthLimit, let kids = v[3] as? [R.Element] else { continue }
            for k in kids.reversed() { stack.append((k, depth + 1)) } // depth first, in order
        }
        let chosen = found.boxes == 1 ? first : focused
        found.box = chosen?.box
        found.placeholder = chosen?.placeholder
        return found
    }

    // The box's text, before the placeholder comes off (Teams.boxText): its value, or, when the box
    // holds a reply's quote, the text of its paragraphs after the quote, one per line, since the
    // value includes the quote too. nil when the box can't be read.
    static func boxValue<R: AXReading>(_ box: R.Element, _ r: R) -> String? {
        let v = r.attrs(box, [kAXValueAttribute, kAXChildrenAttribute])
        guard let value = v[0] as? String else { return nil }
        let kids = (v[1] as? [R.Element]) ?? []
        let isQuote = { (e: R.Element) in ((r.attrs(e, [TeamsShape.domClasses])[0] as? [String]) ?? []).contains(TeamsShape.quoteClass) }
        guard kids.contains(where: isQuote) else { return value }
        return kids.filter { !isQuote($0) }.map { text(in: $0, r) }.joined(separator: "\n")
    }

    // The static texts inside an element, in order, run together.
    static func text<R: AXReading>(in e: R.Element, _ r: R, depth: Int = 0) -> String {
        let v = r.attrs(e, [kAXRoleAttribute, kAXValueAttribute, kAXChildrenAttribute])
        if (v[0] as? String) == TeamsShape.textRole { return v[1] as? String ?? "" }
        guard depth < 20 else { return "" }
        return ((v[2] as? [R.Element]) ?? []).map { text(in: $0, r, depth: depth + 1) }.joined()
    }

    // The last message from someone other than the user, else the last message: its author
    // and text, from the list's items.
    static func lastMessage<R: AXReading>(items: [R.Element], _ r: R) -> (from: String?, last: String?) {
        var fallback: (from: String?, last: String?)?
        var i = items.count - 1
        var looked = 0
        while i >= 0, looked < TeamsShape.messagesBack {
            defer { i -= 1 }
            guard let m = message(in: items[i], r) else { continue }
            looked += 1
            var author: String?
            if i > 0 {
                let h = r.attrs(items[i - 1], [kAXRoleAttribute, kAXTitleAttribute])
                if (h[0] as? String) == TeamsShape.headingRole { author = (h[1] as? String).flatMap(Teams.author(fromHeading:)) }
            }
            if !m.mine { return (author, m.text) }
            if fallback == nil { fallback = (author, m.text) }
        }
        return fallback ?? (nil, nil)
    }

    // A message's body: whether it's the user's own, and its whole text.
    static func message<R: AXReading>(in item: R.Element, _ r: R) -> (mine: Bool, text: String)? {
        let v = r.attrs(item, [kAXRoleAttribute, kAXChildrenAttribute])
        guard (v[0] as? String) == TeamsShape.messageRole, let kids = v[1] as? [R.Element] else { return nil }
        for k in kids {
            let b = r.attrs(k, [TeamsShape.domID, TeamsShape.domClasses, kAXChildrenAttribute])
            guard (b[0] as? String)?.hasPrefix(TeamsShape.bodyIDPrefix) == true else { continue }
            let classes = (b[1] as? [String]) ?? []
            let mine = classes.contains { $0.hasPrefix(TeamsShape.myMessageClassPrefix) }
            for c in (b[2] as? [R.Element]) ?? [] {
                let cv = r.attrs(c, [TeamsShape.domID, kAXDescriptionAttribute])
                guard (cv[0] as? String)?.hasPrefix(TeamsShape.contentIDPrefix) == true else { continue }
                let text = ((cv[1] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                return text.isEmpty ? nil : (mine, String(text.prefix(TeamsShape.textLimit)))
            }
            return nil
        }
        return nil
    }

    // What the page is told for a window: its title, whether the walk found the box and the
    // list, and the box's value. A chat's window (or a message list) with no box is a shape
    // the shell doesn't know; any other window without one is no chat.
    static func context(title: String, boxValue: String?, placeholder: String, hasList: Bool,
                        from: String?, last: String?, several: Bool = false) -> TeamsContext {
        let chat = Teams.chatName(title)
        if several { return TeamsContext(open: true, chat: chat, from: nil, last: nil, draft: false, shape: "several") }
        guard let boxValue else {
            if chat != nil || hasList { return TeamsContext(open: true, chat: chat, from: nil, last: nil, draft: false, shape: "unknown") }
            return .noChat
        }
        return TeamsContext(open: true, chat: chat, from: from, last: last, draft: !Teams.boxText(boxValue, placeholder: placeholder).isEmpty)
    }
}

// Reads Teams for the page. Used from one serial queue only (the app's Teams queue), which
// the send shares, so a read never runs in the middle of a send.
final class TeamsReader: @unchecked Sendable {
    // Teams builds its web content's accessibility tree only when asked (TeamsShape.treeAsks):
    // the app asks when it finds Teams, and again every few seconds while the box isn't found,
    // since a Teams that just opened may not have its page up yet. The read-only check doesn't.
    let asksForTree: Bool
    var log: (String) -> Void = { _ in } // never gets text from Teams
    init(asksForTree: Bool = true) { self.asksForTree = asksForTree }

    let live = LiveAX()
    var pid: pid_t = 0
    var app: AXUIElement?
    var window: AXUIElement?
    var title = ""
    var composer: AXUIElement?
    var placeholder = TeamsShape.placeholder // the box's own, from its description
    var messages: AXUIElement? // the list of messages ("chat-pane-list")
    private var lastKey: (count: Int, item: AXUIElement)?
    private var lastFound: (from: String?, last: String?) = (nil, nil)
    private var unknownLogged: Set<String> = [] // windows and titles already logged without a box
    private var nextFind = Date.distantPast // the next search while the box isn't found yet, or while there are several
    private var nextAsk = Date.distantPast // the next ask for the tree while the box isn't found
    private(set) var boxes = 0 // message boxes the last search found
    private(set) var several = false // more than one, and none had Teams' cursor
    private(set) var readMs = 0.0 // how long the last read took
    private(set) var walkMs = 0.0 // how long the last search for the box and the list took
    private(set) var nodes = 0 // elements the last search looked at
    private(set) var domIDs = 0 // elements the last search found with a DOM id
    // The update check (TeamsCheck), once per Teams process: its answer, and the wait before one.
    private(set) var checked: TeamsCheck.Anchors?
    private var checkPending: TeamsCheck.Pending?
    private var nextCheckWalk = Date.distantPast

    var isSelfChat: Bool { Teams.isSelfChat(title) }

    func reset() {
        pid = 0; app = nil
        unknownLogged = []
        checked = nil; checkPending = nil; nextCheckWalk = .distantPast
        forget()
    }

    private func forget() {
        window = nil; title = ""; composer = nil; messages = nil; lastKey = nil; lastFound = (nil, nil); nextFind = .distantPast; boxes = 0; several = false
        placeholder = TeamsShape.placeholder
    }

    // The Teams process to read, from now on.
    func attach(_ teams: NSRunningApplication) {
        guard teams.processIdentifier != pid || app == nil else { return }
        reset()
        pid = teams.processIdentifier
        let a = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(a, 1.0)
        app = a
        askForTree()
    }

    // Asks Teams to build its page's accessibility tree, with each of TeamsShape.treeAsks. Teams
    // keeps it built until it quits, so asking again changes nothing once it's there.
    private func askForTree() {
        guard asksForTree, let app else { return }
        nextAsk = Date().addingTimeInterval(TeamsShape.askAgain)
        for name in TeamsShape.treeAsks { AXUIElementSetAttributeValue(app, name as CFString, kCFBooleanTrue) }
    }

    // What the box holds now, without its placeholder or a reply's quote; nil when it can't be read.
    func boxValue() -> String? {
        composer.flatMap { TeamsScan.boxValue($0, live) }.map { Teams.boxText($0, placeholder: placeholder) }
    }

    // What the page is told, with the update check's answer once there is one.
    func read() -> TeamsContext {
        var context = readNow()
        if let a = checked {
            context.check = TeamsCheck.value(a)
            context.missing = a.missing
        }
        return context
    }

    private func readNow() -> TeamsContext {
        let start = DispatchTime.now()
        defer { readMs = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e6 }
        guard AXIsProcessTrusted() else { return Teams.running() == nil ? .closed : .noChat }
        guard let teams = Teams.running() else { reset(); return .closed }
        attach(teams)
        guard let app, let main = Teams.mainWindow(app) else { forget(); return .noChat }
        let t = AX.str(main.element, kAXTitleAttribute)
        if window.map({ !CFEqual($0, main.element) }) ?? true || t != title {
            forget()
            window = main.element
            title = t
            find(in: main.element)
            nextFind = Date().addingTimeInterval(TeamsShape.findAgain)
        }
        var value = composer.flatMap { TeamsScan.boxValue($0, live) }
        // No box yet (Teams may still be building the view it just switched to, as when a channel
        // opens), the box went away, or there are several (the cursor may have moved to another):
        // search again, at most once a second.
        if value == nil || boxes > 1, Date() >= nextFind {
            nextFind = Date().addingTimeInterval(TeamsShape.findAgain)
            // With no box, the tree itself may be missing: ask for it again, every few seconds.
            if value == nil, Date() >= nextAsk { askForTree() }
            find(in: main.element)
            value = composer.flatMap { TeamsScan.boxValue($0, live) }
        }
        let (from, last) = value == nil ? (nil, nil) : lastMessage()
        let context = TeamsScan.context(title: title, boxValue: value, placeholder: placeholder, hasList: messages != nil, from: from, last: last, several: several)
        if context.shape == "unknown" {
            // Once per window and title; the log never gets the title itself.
            let key = "\(CFHash(main.element))|\(t.hashValue)"
            if unknownLogged.insert(key).inserted {
                log("teams: no message box in Teams' window after \(nodes) elements (Teams' shape changed?)")
            }
        }
        checkAnchors(main.element)
        return context
    }

    // One look for the update check, until this Teams process has its answer. The reader's own last walk
    // counts when it shows all three or can't count; when it shows something missing, it may be old (the
    // reader walks again only while the box is missing or there are several), so the check walks the
    // window itself, every few seconds, and only those walks count. Nothing the reader holds changes.
    private func checkAnchors(_ window: AXUIElement) {
        guard checked == nil, pid != 0 else { return }
        var seen = TeamsCheck.anchors(title: title, boxes: boxes, hasList: messages != nil, domIDs: domIDs)
        if let s = seen, !s.ok {
            guard Date() >= nextCheckWalk else { return }
            nextCheckWalk = Date().addingTimeInterval(TeamsCheck.walkEvery)
            seen = TeamsCheck.anchors(title: title, found: TeamsScan.find(in: window, live))
        }
        let (pending, answer) = TeamsCheck.step(checkPending, seen, now: ProcessInfo.processInfo.systemUptime)
        checkPending = pending
        if let answer {
            checked = answer
            log(TeamsCheck.line(answer))
        }
    }

    // One walk of the window for the message box and the message list.
    func find(in window: AXUIElement) {
        let start = DispatchTime.now()
        let found = TeamsScan.find(in: window, live)
        composer = found.box
        placeholder = found.placeholder ?? TeamsShape.placeholder
        messages = found.list
        boxes = found.boxes
        several = found.several
        lastKey = nil
        nodes = found.nodes
        domIDs = found.domIDs
        walkMs = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e6
    }

    // The last message (TeamsScan.lastMessage), looked at again only when the list changed.
    private func lastMessage() -> (from: String?, last: String?) {
        guard let list = messages else { return (nil, nil) }
        let items = AX.children(list)
        guard let lastItem = items.last else { return (nil, nil) }
        if let k = lastKey, k.count == items.count, CFEqual(k.item, lastItem) { return lastFound }
        lastFound = TeamsScan.lastMessage(items: items, live)
        lastKey = (items.count, lastItem)
        return lastFound
    }
}

// Follows Teams' main window for the docking, on the app's dock queue only. Accessibility
// says which window is the main one when something happened (a notification, Teams coming
// forward, its main window changing); between those, the window list follows that window by
// its number, with no call into Teams.
final class TeamsFollower: @unchecked Sendable {
    var notify: (String) -> Void = { _ in } // an Accessibility notification, on the main thread
    var log: (String) -> Void = { _ in }

    private(set) var pid: pid_t = 0
    private(set) var app: AXUIElement?
    private var observer: AXObserver?
    private var watchFailed = false
    private var windowID: CGWindowID?
    private var lastAX = Date.distantPast

    // Without an observer, Accessibility is asked again this often, in case the main window changed.
    static let refreshWithoutObserver: TimeInterval = 5

    func reset() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil
        watchFailed = false
        pid = 0
        app = nil
        windowID = nil
        lastAX = .distantPast
    }

    // Where Teams' main window is now. `ax`: ask Accessibility, not just the window list.
    func window(of teams: NSRunningApplication, ax: Bool) -> TeamsWindow? {
        if pid != teams.processIdentifier || app == nil {
            reset()
            pid = teams.processIdentifier
            let a = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(a, 0.5)
            app = a
        }
        guard AXIsProcessTrusted(), let app else {
            windowID = nil
            return Teams.window(of: teams, app: nil)
        }
        if observer == nil && !watchFailed { watch(app) }

        let stale = observer == nil && Date().timeIntervalSince(lastAX) > Self.refreshWithoutObserver
        if !ax, !stale, let id = windowID {
            if let w = Teams.listedWindow(id, pid: pid) {
                return TeamsWindow(frame: w.frame, onScreen: w.onScreen && !teams.isHidden, id: id)
            }
            windowID = nil // closed: ask Accessibility
        }

        lastAX = Date()
        guard let main = Teams.mainWindow(app) else {
            // Minimized or on its way out: keep following it while the window list still has it.
            if let id = windowID, let w = Teams.listedWindow(id, pid: pid) { return TeamsWindow(frame: w.frame, onScreen: false, id: id) }
            windowID = nil
            return nil
        }
        let all = Teams.listedWindows(pid: pid, onScreenOnly: false)
        let match = all.first { Teams.sameFrame($0.frame, main.frame) && $0.onScreen } ?? all.first { Teams.sameFrame($0.frame, main.frame) }
        windowID = match?.id // nil: ambiguous, so Accessibility again next time
        return TeamsWindow(frame: main.frame, onScreen: !teams.isHidden && (match?.onScreen ?? false), id: match?.id)
    }

    // An Accessibility observer on Teams: its windows moving, resizing, minimizing and coming
    // back, the app hidden or shown, and its main window changing. Delivered on the main run loop.
    private func watch(_ app: AXUIElement) {
        let callback: AXObserverCallback = { _, _, notification, refcon in
            guard let refcon else { return }
            let me = Unmanaged<TeamsFollower>.fromOpaque(refcon).takeUnretainedValue()
            me.notify(notification as String)
        }
        var obs: AXObserver?
        guard AXObserverCreate(pid, callback, &obs) == .success, let obs else {
            log("couldn't watch Teams' window; following it through the window list")
            watchFailed = true
            return
        }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for n in [kAXWindowMovedNotification, kAXWindowResizedNotification, kAXWindowMiniaturizedNotification,
                  kAXWindowDeminiaturizedNotification, kAXApplicationHiddenNotification, kAXApplicationShownNotification,
                  kAXMainWindowChangedNotification, kAXWindowCreatedNotification] {
            AXObserverAddNotification(obs, app, n as CFString, refcon)
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        observer = obs
    }

    // A minimized main window comes back (the largest one), when no normal one is open.
    func unminimize() {
        guard AXIsProcessTrusted(), let app else { return }
        let windows = (AX.attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        let minimized = windows.compactMap { w -> (AXUIElement, CGFloat)? in
            let v = AX.attrs(w, [kAXSubroleAttribute, kAXMinimizedAttribute, kAXSizeAttribute])
            guard (v[0] as? String) == kAXStandardWindowSubrole, (v[1] as? Bool) == true, let s = AX.size(v[2]) else { return nil }
            return (w, s.width * s.height)
        }.max { $0.1 < $1.1 }
        if let w = minimized?.0, Teams.mainWindow(app) == nil {
            AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        }
    }
}
