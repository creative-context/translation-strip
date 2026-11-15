// Putting the English into the chat open in Teams, in the order the spike proved by hand:
// bring Teams forward through Accessibility and confirm it there (it answers live), focus
// the message box, paste through a borrowed clipboard, check the box holds exactly that
// text, and only then press Return. No key is ever posted unless Teams is the front app
// at that moment, a draft already there is never deleted, and the clipboard is put back.

import AppKit
import ApplicationServices

struct SendOutcome {
    var ok: Bool
    var reason: String? = nil // the contract's reasons, plus "not-sent"
    var sent = false // Return was pressed and the box emptied
}

// The user's clipboard, every item and every type, to put back exactly.
enum Clipboard {
    static func save() -> [[NSPasteboard.PasteboardType: Data]] {
        (NSPasteboard.general.pasteboardItems ?? []).map { item in
            var d: [NSPasteboard.PasteboardType: Data] = [:]
            for t in item.types { if let data = item.data(forType: t) { d[t] = data } }
            return d
        }
    }
    static func put(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }
    static func restore(_ saved: [[NSPasteboard.PasteboardType: Data]]) {
        let pb = NSPasteboard.general
        pb.clearContents()
        let items: [NSPasteboardItem] = saved.map { d in
            let it = NSPasteboardItem()
            for (t, data) in d { it.setData(data, forType: t) }
            return it
        }
        if !items.isEmpty { pb.writeObjects(items) }
    }
}

extension TeamsReader {
    // Runs on the Teams queue and blocks it for a few seconds at most. `log` never gets text.
    func send(_ text: String, leave: Bool, afterDraft: Bool, log: (String) -> Void) -> SendOutcome {
        guard AXIsProcessTrusted() else { return SendOutcome(ok: false, reason: "no-access") }
        guard Teams.running() != nil else { return SendOutcome(ok: false, reason: "no-teams") }
        let context = read() // a fresh look at the window, the box and the draft
        guard context.open, let app, let window, let box = composer else {
            return SendOutcome(ok: false, reason: context.open ? "no-chat" : "no-teams")
        }
        let value = { (AX.attr(box, kAXValueAttribute) as? String).map(Teams.boxText) }
        guard let before = value() else { return SendOutcome(ok: false, reason: "no-chat") }
        if !before.isEmpty && !afterDraft { return SendOutcome(ok: false, reason: "draft") }

        // Teams forward, confirmed through Accessibility.
        let isFront = { (AX.attr(app, kAXFrontmostAttribute) as? Bool) == true }
        AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        guard wait(2, isFront) else {
            log("send: Teams didn't come forward")
            return SendOutcome(ok: false, reason: "not-front")
        }
        // A key, only while Teams is the front app.
        func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) -> Bool {
            guard isFront() else { return false }
            let src = CGEventSource(stateID: .combinedSessionState)
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return false }
            down.flags = flags
            up.flags = flags
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            return true
        }

        AXUIElementSetAttributeValue(box, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        Thread.sleep(forTimeInterval: 0.15)
        let addsToDraft = afterDraft && !before.isEmpty
        if addsToDraft {
            // The caret to the end of the draft, then a new line.
            let length = ((AX.attr(box, kAXValueAttribute) as? String) ?? "") as NSString
            var range = CFRange(location: length.length, length: 0)
            let moved = AXValueCreate(.cfRange, &range).map {
                AXUIElementSetAttributeValue(box, kAXSelectedTextRangeAttribute as CFString, $0) == .success
            } ?? false
            if !moved, !key(125, .maskCommand) { return SendOutcome(ok: false, reason: "not-front") } // ⌘↓
            Thread.sleep(forTimeInterval: 0.05)
            guard key(36, .maskShift) else { return SendOutcome(ok: false, reason: "not-front") } // ⇧⏎
            Thread.sleep(forTimeInterval: 0.1)
        }

        // Paste through the borrowed clipboard, then put the user's back.
        let saved = DispatchQueue.main.sync { Clipboard.save() }
        DispatchQueue.main.sync { Clipboard.put(text) }
        let pasted = key(9, .maskCommand) // ⌘V
        Thread.sleep(forTimeInterval: 0.4)
        DispatchQueue.main.sync { Clipboard.restore(saved) }
        guard pasted else {
            log("send: Teams lost the front before the paste")
            return SendOutcome(ok: false, reason: "not-front")
        }

        // The box must hold exactly the text the user saw (after the draft, when asked).
        let expected = addsToDraft ? before + "\n" + text : text
        var holds = value().map { Teams.sameText($0, expected) } ?? false
        if !holds {
            Thread.sleep(forTimeInterval: 0.3)
            holds = value().map { Teams.sameText($0, expected) } ?? false
        }
        guard holds else {
            log("send: the message box didn't hold the text; nothing pressed")
            return SendOutcome(ok: false, reason: "mismatch")
        }
        if leave { return SendOutcome(ok: true) }

        guard key(36) else { // ⏎
            log("send: Teams lost the front before Return")
            return SendOutcome(ok: false, reason: "not-sent")
        }
        if wait(2, { value()?.isEmpty == true }) { return SendOutcome(ok: true, sent: true) }
        log("send: the message box didn't empty after Return")
        return SendOutcome(ok: false, reason: "not-sent")
    }

    private func wait(_ seconds: Double, _ done: () -> Bool) -> Bool {
        let until = Date().addingTimeInterval(seconds)
        while !done() {
            if Date() > until { return false }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return true
    }
}
