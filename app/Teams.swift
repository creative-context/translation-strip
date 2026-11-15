// Reading Teams through Accessibility: where its main window is, the chat open in it, the
// message box and the last message. Nothing here is stored or logged: the reader keeps only
// the elements it found, so the next read is cheap, and the last answer it gave.
//
// What Teams shows (the new Teams, com.microsoft.teams2):
//   - the main window's title reads "Chat | <chat name> | <org> | <account>" in a chat;
//   - the message box is an AXTextArea described "Type a message", whose value is that
//     placeholder plus a line break while it's empty;
//   - the messages sit in a group described "Message List", under it the list itself (DOM id
//     "chat-pane-list"): a heading per message ("<preview> by <author>") and a group per
//     message whose body has the DOM id "message-body-<id>" (class fui-ChatMyMessage__body
//     for the user's own) and holds "content-<id>", described with the whole text.

import AppKit
import ApplicationServices

let teamsBundleID = "com.microsoft.teams2"

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

// What the page gets in window.strip.teams(...).
struct TeamsContext: Equatable {
    var open: Bool
    var chat: String?
    var from: String?
    var last: String?
    var draft: Bool

    static let closed = TeamsContext(open: false, chat: nil, from: nil, last: nil, draft: false)
    static let noChat = TeamsContext(open: true, chat: nil, from: nil, last: nil, draft: false)

    var page: [String: Any] {
        ["open": open, "chat": chat ?? NSNull(), "from": from ?? NSNull(), "last": last ?? NSNull(), "draft": draft]
    }
}

// Where Teams' main window is (top-left origin, as Accessibility and the window list give
// it) and whether it's on screen now: not minimized, not hidden, not on another Space.
struct TeamsWindow: Equatable {
    var frame: CGRect
    var onScreen: Bool
}

enum Teams {
    static func running() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: teamsBundleID).first { !$0.isTerminated }
    }

    // The largest normal window that isn't minimized, with its frame.
    static func mainWindow(_ app: AXUIElement) -> (element: AXUIElement, frame: CGRect)? {
        let windows = (AX.attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        var best: (element: AXUIElement, frame: CGRect)?
        for w in windows {
            let v = AX.attrs(w, [kAXSubroleAttribute, kAXMinimizedAttribute, kAXPositionAttribute, kAXSizeAttribute])
            guard (v[0] as? String) == kAXStandardWindowSubrole, (v[1] as? Bool) != true,
                  let p = AX.point(v[2]), let s = AX.size(v[3]), s.width > 0, s.height > 0 else { continue }
            let f = CGRect(origin: p, size: s)
            if best.map({ f.width * f.height > $0.frame.width * $0.frame.height }) ?? true { best = (w, f) }
        }
        return best
    }

    // Teams' windows on screen now, from the window list (bounds need no permission).
    static func onScreenFrames(pid: pid_t) -> [CGRect] {
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        return list.compactMap { w in
            guard (w[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
            return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        }
    }

    // The main window and whether it's on screen. With Accessibility, its frame comes from
    // there; without it (first run), the largest window in the window list stands in.
    // nil: no window (minimized, or none open).
    static func window(of teams: NSRunningApplication, app: AXUIElement?) -> TeamsWindow? {
        let shown = onScreenFrames(pid: teams.processIdentifier)
        if let app, AXIsProcessTrusted() {
            guard let main = mainWindow(app) else { return nil }
            let visible = !teams.isHidden && shown.contains { abs($0.minX - main.frame.minX) < 3 && abs($0.minY - main.frame.minY) < 3
                && abs($0.width - main.frame.width) < 3 && abs($0.height - main.frame.height) < 3 }
            return TeamsWindow(frame: main.frame, onScreen: visible)
        }
        guard let largest = shown.filter({ $0.width > 400 && $0.height > 300 }).max(by: { $0.width * $0.height < $1.width * $1.height }) else { return nil }
        return TeamsWindow(frame: largest, onScreen: !teams.isHidden)
    }

    // "Chat | <chat name> | <org> | <account>": the chat's name, or nil.
    static func chatName(_ title: String) -> String? {
        let parts = title.components(separatedBy: " | ")
        guard parts.count > 1 else { return nil }
        let name = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    // "<preview> by <author>": the author, or nil.
    static func author(fromHeading title: String) -> String? {
        guard let r = title.range(of: " by ", options: .backwards) else { return nil }
        let name = title[r.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    static let placeholder = "Type a message"

    // What the message box holds, without its placeholder, with plain spaces and line breaks
    // and no outer whitespace. "" when it's empty.
    static func boxText(_ value: String) -> String {
        var s = value.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{00A0}", with: " ")
        for invisible in ["\u{200B}", "\u{200C}", "\u{200D}", "\u{FEFF}"] { s = s.replacingOccurrences(of: invisible, with: "") }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return s == placeholder ? "" : s
    }

    // The same words in the same lines, whatever the spacing at line ends or between paragraphs.
    static func sameText(_ a: String, _ b: String) -> Bool {
        func lines(_ s: String) -> [String] {
            boxText(s).components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        return lines(a) == lines(b)
    }
}

// Reads Teams for the page. Used from one serial queue only (the app's Teams queue), which
// the send shares, so a read never runs in the middle of a send.
final class TeamsReader: @unchecked Sendable {
    // Teams builds its web content's accessibility tree only when asked: the app asks once
    // per Teams process. The read-only check doesn't.
    let asksForTree: Bool
    init(asksForTree: Bool = true) { self.asksForTree = asksForTree }

    var pid: pid_t = 0
    var app: AXUIElement?
    var window: AXUIElement?
    var title = ""
    var composer: AXUIElement?
    var messages: AXUIElement? // the list of messages ("chat-pane-list")
    private var lastKey: (count: Int, item: AXUIElement)?
    private var lastFound: (from: String?, last: String?) = (nil, nil)
    private(set) var readMs = 0.0 // how long the last read took
    private(set) var walkMs = 0.0 // how long the last search for the box and the list took
    private(set) var nodes = 0 // elements the last search looked at

    var isSelfChat: Bool { title.contains("(You)") }

    func reset() {
        pid = 0; app = nil
        forget()
    }

    private func forget() {
        window = nil; title = ""; composer = nil; messages = nil; lastKey = nil; lastFound = (nil, nil)
    }

    // The Teams process to read, from now on.
    func attach(_ teams: NSRunningApplication) {
        guard teams.processIdentifier != pid || app == nil else { return }
        reset()
        pid = teams.processIdentifier
        let a = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(a, 1.0)
        if asksForTree { AXUIElementSetAttributeValue(a, "AXManualAccessibility" as CFString, kCFBooleanTrue) }
        app = a
    }

    func read() -> TeamsContext {
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
        }
        var value = composer.flatMap { AX.attr($0, kAXValueAttribute) as? String }
        if value == nil, composer != nil { // the box went away: look again once
            find(in: main.element)
            value = composer.flatMap { AX.attr($0, kAXValueAttribute) as? String }
        }
        guard let value else { return .noChat }
        let (from, last) = lastMessage()
        return TeamsContext(open: true, chat: Teams.chatName(title), from: from, last: last, draft: !Teams.boxText(value).isEmpty)
    }

    // One walk of the window for the message box and the message list. The messages
    // themselves are skipped: the walk stops at the list.
    func find(in window: AXUIElement) {
        let start = DispatchTime.now()
        composer = nil
        messages = nil
        lastKey = nil
        nodes = 0
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        while let (e, depth) = stack.popLast() {
            nodes += 1
            if nodes > 8000 || (composer != nil && messages != nil) { break }
            let v = AX.attrs(e, [kAXRoleAttribute, kAXDescriptionAttribute, kAXChildrenAttribute])
            let role = v[0] as? String ?? ""
            let desc = v[1] as? String ?? ""
            if role == "AXTextArea" && desc == Teams.placeholder && composer == nil { composer = e; continue }
            if desc == "Message List" && messages == nil { messages = Self.list(in: e); continue }
            guard depth < 80, let kids = v[2] as? [AXUIElement] else { continue }
            for k in kids.reversed() { stack.append((k, depth + 1)) } // depth first, in order
        }
        walkMs = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e6
    }

    // The list itself, a few levels under "Message List".
    private static func list(in group: AXUIElement) -> AXUIElement? {
        var level = [group]
        for _ in 0..<8 {
            var next: [AXUIElement] = []
            for e in level {
                let v = AX.attrs(e, ["AXDOMIdentifier", kAXChildrenAttribute])
                if (v[0] as? String) == "chat-pane-list" { return e }
                next += (v[1] as? [AXUIElement]) ?? []
            }
            if next.isEmpty || next.count > 40 { return nil }
            level = next
        }
        return nil
    }

    // The last message from someone other than the user, else the last message: its author
    // and text. Looked at again only when the list changed.
    private func lastMessage() -> (from: String?, last: String?) {
        guard let list = messages else { return (nil, nil) }
        let items = AX.children(list)
        guard let lastItem = items.last else { return (nil, nil) }
        if let k = lastKey, k.count == items.count, CFEqual(k.item, lastItem) { return lastFound }
        var fallback: (from: String?, last: String?)?
        var found: (from: String?, last: String?)?
        var looked = 0
        var i = items.count - 1
        while i >= 0, looked < 15, found == nil {
            defer { i -= 1 }
            guard let m = Self.message(in: items[i]) else { continue }
            looked += 1
            var author: String?
            if i > 0 {
                let h = AX.attrs(items[i - 1], [kAXRoleAttribute, kAXTitleAttribute])
                if (h[0] as? String) == "AXHeading" { author = (h[1] as? String).flatMap(Teams.author(fromHeading:)) }
            }
            if !m.mine { found = (author, m.text) } else if fallback == nil { fallback = (author, m.text) }
        }
        lastFound = found ?? fallback ?? (nil, nil)
        lastKey = (items.count, lastItem)
        return lastFound
    }

    // A message's body: whether it's the user's own, and its whole text.
    private static func message(in item: AXUIElement) -> (mine: Bool, text: String)? {
        let v = AX.attrs(item, [kAXRoleAttribute, kAXChildrenAttribute])
        guard (v[0] as? String) == "AXGroup", let kids = v[1] as? [AXUIElement] else { return nil }
        for k in kids {
            let b = AX.attrs(k, ["AXDOMIdentifier", "AXDOMClassList", kAXChildrenAttribute])
            guard (b[0] as? String)?.hasPrefix("message-body-") == true else { continue }
            let classes = (b[1] as? [String]) ?? []
            let mine = classes.contains { $0.hasPrefix("fui-ChatMyMessage") }
            for c in (b[2] as? [AXUIElement]) ?? [] {
                let cv = AX.attrs(c, ["AXDOMIdentifier", kAXDescriptionAttribute])
                guard (cv[0] as? String)?.hasPrefix("content-") == true else { continue }
                let text = ((cv[1] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                return text.isEmpty ? nil : (mine, String(text.prefix(4000)))
            }
            return nil
        }
        return nil
    }
}
