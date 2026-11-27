// Putting the English into the chat open in Teams, in the order the spike proved by hand:
// bring Teams forward through Accessibility and confirm it there (it answers live), focus
// the message box, paste through a borrowed clipboard, check the box holds exactly that
// text, and only then press Return. No key is ever posted unless Teams is the front app
// at that moment, a draft already there is never deleted, and the clipboard is put back.
// The message goes only to the chat the strip showed: if Teams moved to another chat, nothing
// is pasted. The borrowed clipboard is marked transient and concealed, so clipboard managers
// that follow the nspasteboard.org markers don't record the message. After ⌘V the box is
// watched until it changes (Teams took the paste), and only then is the user's clipboard put
// back, and only if nothing else wrote to it meanwhile.

import AppKit
import ApplicationServices

struct SendOutcome {
    var ok: Bool
    var reason: String? = nil // the contract's reasons: "not-sent", "chat-changed", "no-paste", "which-box" and "unconfirmed" included
    var sent = false // Return was pressed, the box emptied and the message showed in the chat
    var pastes: Int? = nil // ⌘V presses (1 or 2); nil when the send stopped before the paste
    var boxMs: Int? = nil // from the first ⌘V until the box changed; nil when it didn't
    var raiseMs: Int? = nil // from asking Teams to come forward until it was front; nil when it already was, or never came
    var focusMs: Int? = nil // from asking the box for the cursor until it had it (0.15 s when it never said so)
    var postedMs: Int? = nil // from Return until the message showed in the chat (or the box emptied, with no list to read)
}

// What one send measured while it ran, across its two attempts. Numbers only, never text.
final class SendMeter {
    var pastes = 0
    var firstPaste: TimeInterval? // systemUptime at the first ⌘V
    var boxMs: Int?
    var hadList = false // the chat's message list could be read before Return
    var raiseMs: Int? // the first attempt's: from asking Teams forward until it was front, when it wasn't already
    var focusMs: Int? // the first attempt's: from asking the box for the cursor until it had it
    var postedMs: Int? // from Return until the send was confirmed
}

// The send's outcome line (the log): its start ("send: sent", "send: not sent (<reason>)", "send: left in
// the message box") and, after " · ", what was measured. A field not measured is left out. Never text,
// never a chat's name.
enum SendLog {
    struct Measured: Equatable {
        var pastes: Int? = nil
        var boxMs: Int? = nil
        var totalMs: Int? = nil
        var chars: Int? = nil
        var link: Bool? = nil
        var mode: String? = nil // "send" or "leave"
        var front: Bool? = nil // Teams was the front app when the send message came
        var raiseMs: Int? = nil // from asking Teams forward until it was front; left out when it already was
        var focusMs: Int? = nil // from asking the box for the cursor until it had it
        var postedMs: Int? = nil // from Return until the message showed in the chat
    }

    static func bucket(_ chars: Int) -> String {
        switch chars {
        case ..<100: return "under 100"
        case ..<500: return "100 to 499"
        case ..<2000: return "500 to 1,999"
        default: return "2,000 or more"
        }
    }

    static func hasLink(_ text: String) -> Bool {
        TeamsShape.link.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    static func suffix(_ m: Measured) -> String {
        var f: [String] = []
        if let n = m.pastes { f.append("pastes \(n)") }
        if let ms = m.boxMs { f.append("box \(ms) ms") }
        if let ms = m.totalMs { f.append("total \(ms) ms") }
        if let n = m.chars { f.append("\(bucket(n)) chars") }
        if let l = m.link { f.append("link \(l ? "yes" : "no")") }
        if let mode = m.mode { f.append(mode) }
        if let front = m.front { f.append("front \(front ? "yes" : "no")") }
        if let ms = m.raiseMs { f.append("raise \(ms) ms") }
        if let ms = m.focusMs { f.append("focus \(ms) ms") }
        if let ms = m.postedMs { f.append("posted \(ms) ms") }
        return f.isEmpty ? "" : " · " + f.joined(separator: ", ")
    }

    static func line(_ start: String, _ m: Measured) -> String { start + suffix(m) }

    // The line before the second paste, with how long after the first ⌘V the box was seen empty
    // (left out when it wasn't measured).
    static func pastingAgain(afterMs: Int?) -> String {
        "send: Teams emptied its box after the paste; pasting again" + (afterMs.map { " · after \($0) ms" } ?? "")
    }

    static func ms(since start: TimeInterval, now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Int {
        max(0, Int(((now - start) * 1000).rounded()))
    }
}

// After Return, with the box empty: what the empty box is worth. A chat with no message list before
// (a new chat) has nothing more to check, so it's sent, as before. A list that could be read before and
// can't be now can't confirm anything: "unconfirmed". A list there before and after: the message must
// show in it (Teams.postedAs).
enum SendConfirm {
    enum Step: Equatable { case ok, unconfirmed, check }
    static let listWait: TimeInterval = 1 // how long the list has to answer again after Return

    static func afterReturn(listBefore: Bool, listNow: Bool) -> Step {
        guard listBefore else { return .ok }
        return listNow ? .check : .unconfirmed
    }
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
    // Markers clipboard managers honor (nspasteboard.org): don't keep this, it's sensitive, and the
    // app put it there, not the user.
    static let markers: [NSPasteboard.PasteboardType] = ["org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType",
                                                         "org.nspasteboard.AutoGeneratedType"].map { NSPasteboard.PasteboardType($0) }
    // Returns the clipboard's changeCount once the text is on it: the shell's own.
    static func put(_ text: String) -> Int {
        let pb = NSPasteboard.general
        pb.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        for m in markers { item.setData(Data(), forType: m) }
        pb.writeObjects([item])
        return pb.changeCount
    }
    static var changeCount: Int { NSPasteboard.general.changeCount }
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

// The paste's decisions, as pure functions the Swift check runs.
enum PasteWatch {
    static let every: TimeInterval = 0.025 // how often the box is looked at after ⌘V (and after Return)
    static let focusMax: TimeInterval = 0.1 // how long the box has to say it has the cursor (about 0.15 s with the last look and focusSettle)
    static let focusSettle: TimeInterval = 0.03 // after it says so, before the paste
    static let limit: TimeInterval = 5 // how long Teams has to take the paste
    // While the box hasn't changed: when the shell first looks for Teams' box again (Teams may
    // have built it anew, so the one it holds answers no more or never changes), then how often.
    static let lookAfter: TimeInterval = 0.5
    static let lookEvery: TimeInterval = 1
    static let lateRestore: TimeInterval = 6 // after a paste Teams didn't take: when the user's clipboard comes back

    struct Decision: Equatable {
        var pasted: Bool // the box changed from what it held before ⌘V
        var restore: Bool // the user's clipboard goes back: the clipboard is still the shell's own
    }

    // `before` and `after` are the box's text (without its placeholder) before ⌘V and now;
    // `after` is nil when the box can't be read. `own` is the changeCount the shell left on
    // the clipboard, `now` the clipboard's changeCount at this moment.
    static func decide(before: String, after: String?, own: Int, now: Int) -> Decision {
        Decision(pasted: after.map { $0 != before } ?? false, restore: restores(own: own, now: now))
    }

    // The user's clipboard goes back only while the clipboard is still the one the shell left.
    static func restores(own: Int, now: Int) -> Bool { own == now }
}

// Whether a page's message may reach Teams: only from the main frame of the app's own page,
// served by the app's own server: the process that listens on the port (asked of the system,
// not of the server), checked against the server the keeper started or ServerKeeper.isAppServer
// with the app's bundle ID.
enum OwnServer {
    static func isOwn(pid: pid_t?, keeperPid: pid_t?, isAppServer: (pid_t) -> Bool) -> Bool {
        guard let pid, pid > 1 else { return false }
        if let keeperPid, keeperPid == pid { return true }
        return isAppServer(pid)
    }

    // nil: the send may go on; otherwise the reason the page gets.
    static func refusal(mainFrame: Bool, localOrigin: Bool, own: Bool) -> String? {
        mainFrame && localOrigin && own ? nil : "not-own-server"
    }
}

extension TeamsReader {
    // Runs on the Teams queue and blocks it for a few seconds at most. `log` never gets text.
    // The outcome carries what the send measured: its ⌘V presses and how long Teams took the first paste.
    func send(_ text: String, to chat: String?, leave: Bool, afterDraft: Bool, log: @escaping (String) -> Void) -> SendOutcome {
        let meter = SendMeter()
        var out = send(text, to: chat, leave: leave, afterDraft: afterDraft, log: log, meter: meter, attempt: 1)
        out.pastes = meter.pastes > 0 ? meter.pastes : nil
        out.boxMs = meter.boxMs
        out.raiseMs = meter.raiseMs
        out.focusMs = meter.focusMs
        out.postedMs = meter.postedMs
        return out
    }

    // attempt 2: Teams emptied its box after the first paste, before Return, and nothing was posted.
    private func send(_ text: String, to chat: String?, leave: Bool, afterDraft: Bool, log: @escaping (String) -> Void, meter: SendMeter, attempt: Int) -> SendOutcome {
        guard AXIsProcessTrusted() else { return SendOutcome(ok: false, reason: "no-access") }
        guard Teams.running() != nil else { return SendOutcome(ok: false, reason: "no-teams") }
        let context = read() // a fresh look at the window, the box and the draft
        // Two boxes (a channel with a reply open) and none with Teams' cursor: which one is the user's
        // to say, so nothing is pasted.
        if context.shape == "several" {
            log("send: more than one message box in Teams and none has the cursor; nothing pasted")
            return SendOutcome(ok: false, reason: "which-box")
        }
        guard context.open, let app, let window, var box = composer else {
            return SendOutcome(ok: false, reason: context.open ? "no-chat" : "no-teams")
        }
        if messages != nil { meter.hadList = true }
        // Still the chat the strip showed? Asked again right before the paste.
        let sameChat = { chat == nil || Teams.chatName(AX.str(window, kAXTitleAttribute)) == chat }
        guard sameChat() else {
            log("send: the chat in Teams changed; nothing pasted")
            return SendOutcome(ok: false, reason: "chat-changed")
        }
        let ph = placeholder
        // What the box holds, without the placeholder or a reply's quote (TeamsScan.boxValue).
        let live = self.live
        let value = { TeamsScan.boxValue(box, live).map { Teams.boxText($0, placeholder: ph) } }
        guard let before = value() else { return SendOutcome(ok: false, reason: "no-chat") }
        if !before.isEmpty && !afterDraft { return SendOutcome(ok: false, reason: "draft") }

        // Teams forward, confirmed through Accessibility.
        let isFront = { (AX.attr(app, kAXFrontmostAttribute) as? Bool) == true }
        let wasFront = attempt == 1 && isFront() // only measured: Teams is asked forward either way
        let asked = ProcessInfo.processInfo.systemUptime
        AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        guard wait(2, isFront) else {
            log("send: Teams didn't come forward")
            return SendOutcome(ok: false, reason: "not-front")
        }
        if attempt == 1, !wasFront { meter.raiseMs = SendLog.ms(since: asked) }
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

        // The cursor into the box: on until the box says it has it (and a moment more for Teams to
        // take it in), at most the 0.15 s this always waited before 0.16.0.
        let focusAsked = ProcessInfo.processInfo.systemUptime
        AXUIElementSetAttributeValue(box, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let hasCursor = { (AX.attr(box, kAXFocusedAttribute) as? Bool) == true }
        _ = wait(PasteWatch.focusMax, every: PasteWatch.every, hasCursor)
        Thread.sleep(forTimeInterval: PasteWatch.focusSettle)
        if attempt == 1 { meter.focusMs = SendLog.ms(since: focusAsked) }
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

        guard sameChat() else {
            log("send: the chat in Teams changed; nothing pasted")
            return SendOutcome(ok: false, reason: "chat-changed")
        }
        // Paste through the borrowed clipboard, wait until the box changes (Teams took it), then
        // put the user's clipboard back, unless something else wrote to it meanwhile.
        let beforePaste = value() ?? before
        let saved = DispatchQueue.main.sync { Clipboard.save() }
        let own = DispatchQueue.main.sync { Clipboard.put(text) }
        let posted = key(9, .maskCommand) // ⌘V
        if posted {
            meter.pastes += 1
            if meter.firstPaste == nil { meter.firstPaste = ProcessInfo.processInfo.systemUptime }
        }
        var decision = PasteWatch.Decision(pasted: false, restore: true)
        let start = Date()
        let until = start.addingTimeInterval(posted ? PasteWatch.limit : 0)
        var nextLook = start.addingTimeInterval(PasteWatch.lookAfter)
        var unreadable = false // the box didn't answer at the last look
        repeat {
            if posted { Thread.sleep(forTimeInterval: PasteWatch.every) }
            let now = DispatchQueue.main.sync { Clipboard.changeCount }
            let after = value()
            unreadable = after == nil
            decision = PasteWatch.decide(before: beforePaste, after: after, own: own, now: now)
            if posted, decision.pasted, meter.boxMs == nil, let first = meter.firstPaste {
                meter.boxMs = SendLog.ms(since: first)
            }
            // Still unchanged: Teams may have built its box anew. Look for it again, in the same
            // chat, and follow the new one when there's no doubt which it is.
            if posted, !decision.pasted, Date() >= nextLook {
                nextLook = Date().addingTimeInterval(PasteWatch.lookEvery)
                if sameChat() {
                    find(in: window)
                    if !several, let found = composer, !CFEqual(found, box) {
                        box = found
                        log("send: Teams built its message box anew during the paste; following the new one")
                    }
                }
            }
        } while posted && !decision.pasted && Date() < until
        if decision.pasted || !posted {
            let restored: Bool = DispatchQueue.main.sync {
                // Asked again on the main thread, right before writing, so a copy made a moment ago is kept.
                guard PasteWatch.restores(own: own, now: Clipboard.changeCount) else { return false }
                Clipboard.restore(saved)
                return true
            }
            if !restored { log("send: the clipboard changed during the paste; left as it is") }
        } else {
            // Teams hasn't taken the paste yet and may still: while it might, the clipboard keeps the
            // English (marked temporary and private), so a late paste puts the right text in the box,
            // never the user's own clipboard. The user's comes back a few seconds later, if untouched.
            DispatchQueue.main.asyncAfter(deadline: .now() + PasteWatch.lateRestore) {
                if PasteWatch.restores(own: own, now: Clipboard.changeCount) { Clipboard.restore(saved) }
                else { log("send: the clipboard changed after a paste Teams didn't take; left as it is") }
            }
        }
        guard posted else {
            log("send: Teams lost the front before the paste")
            return SendOutcome(ok: false, reason: "not-front")
        }
        guard decision.pasted else {
            log(unreadable ? "send: the message box couldn't be read after the paste; nothing pressed"
                           : "send: the message box didn't change after the paste; nothing pressed")
            return SendOutcome(ok: false, reason: "no-paste")
        }

        // The box must hold the text the user saw (after the draft, when asked): the same lines, or the
        // same words after Teams' own touch-ups, such as its autocorrect fixing a word (Teams.holds).
        let expected = addsToDraft ? before + "\n" + text : text
        var holds = value().map { Teams.holds($0, expected, placeholder: ph) } ?? false
        if !holds {
            Thread.sleep(forTimeInterval: 0.3)
            holds = value().map { Teams.holds($0, expected, placeholder: ph) } ?? false
        }
        guard holds else {
            log("send: the message box didn't hold the text; nothing pressed")
            return SendOutcome(ok: false, reason: "mismatch")
        }
        if leave { return SendOutcome(ok: true) }

        // The newest message of the user's own before Return, to tell the new one from it.
        let ownBefore = lastOwn()
        if messages != nil { meter.hadList = true }
        // A moment for Teams to take the paste in: Return right as the text shows has emptied the
        // box without posting it. Teams may touch up the text meanwhile (its autocorrect, a link's
        // preview), so the same check again.
        Thread.sleep(forTimeInterval: TeamsShape.pasteSettle)
        let settled = value()
        let seenAt = ProcessInfo.processInfo.systemUptime // when the box was seen as it is now (empty, for a second paste)
        guard settled.map({ Teams.holds($0, expected, placeholder: ph) }) == true else {
            // Teams has emptied its box on its own, right after a paste, without posting anything.
            // Unless the message is in the chat after all, paste once more; a second time, say so.
            if settled?.isEmpty == true {
                if let now = lastOwn(), Teams.postedAs(text, now.text), !(ownBefore.map { CFEqual($0.item, now.item) && $0.text == now.text } ?? false) {
                    return SendOutcome(ok: true, sent: true)
                }
                if attempt == 1, !leave {
                    log(SendLog.pastingAgain(afterMs: meter.firstPaste.map { SendLog.ms(since: $0, now: seenAt) }))
                    return send(text, to: chat, leave: leave, afterDraft: afterDraft, log: log, meter: meter, attempt: 2)
                }
                log("send: Teams emptied its box after the paste again; nothing pressed")
                return SendOutcome(ok: false, reason: "cleared")
            }
            log("send: the message box lost the text after the paste; nothing pressed")
            return SendOutcome(ok: false, reason: "mismatch")
        }
        let returnAt = ProcessInfo.processInfo.systemUptime
        guard key(36) else { // ⏎
            log("send: Teams lost the front before Return")
            return SendOutcome(ok: false, reason: "not-sent")
        }
        guard wait(2, { value()?.isEmpty == true }) else {
            log("send: the message box didn't empty after Return")
            return SendOutcome(ok: false, reason: "not-sent")
        }
        // An empty box isn't proof: Teams has emptied it without posting. The message must show in
        // the chat as the user's newest. With no message list before (a new chat), the empty box is all
        // there is; a list that could be read before and can't be now confirms nothing (SendConfirm).
        let listNow = meter.hadList && wait(SendConfirm.listWait, every: 0.05) { listReadable() }
        switch SendConfirm.afterReturn(listBefore: meter.hadList, listNow: listNow) {
        case .ok:
            meter.postedMs = SendLog.ms(since: returnAt)
            return SendOutcome(ok: true, sent: true)
        case .unconfirmed:
            log("send: the box emptied but the chat's messages couldn't be read to check")
            return SendOutcome(ok: false, reason: "unconfirmed")
        case .check: break
        }
        let shown = wait(TeamsShape.postedWait, every: 0.05) {   // the message list: read every 50 ms, as before
            guard let now = lastOwn() else { return false }
            if let b = ownBefore, CFEqual(b.item, now.item), b.text == now.text { return false }
            return Teams.postedAs(text, now.text)
        }
        if shown {
            meter.postedMs = SendLog.ms(since: returnAt)
            return SendOutcome(ok: true, sent: true)
        }
        log("send: the box emptied but the message didn't show in the chat")
        return SendOutcome(ok: false, reason: "not-posted")
    }

    // The user's newest message in the open chat, among the last few items: its element and text.
    // nil when there's none. A list Teams rebuilt (no items left) is looked for again.
    private func lastOwn() -> (item: AXUIElement, text: String)? {
        var items = messages.map { AX.children($0) } ?? []
        if items.isEmpty, let window, let list = TeamsScan.find(in: window, live).list {
            messages = list
            items = AX.children(list)
        }
        for item in items.suffix(TeamsShape.messagesBack).reversed() {
            if let m = TeamsScan.message(in: item, live), m.mine { return (item, m.text) }
        }
        return nil
    }

    // Whether the open chat's message list can be read now: the one held, while it has items, or one
    // found again in the window (then held).
    private func listReadable() -> Bool {
        if let list = messages, !AX.children(list).isEmpty { return true }
        guard let window, let list = TeamsScan.find(in: window, live).list else { return false }
        messages = list
        return true
    }

    private func wait(_ seconds: Double, every: Double = PasteWatch.every, _ done: () -> Bool) -> Bool {
        let until = Date().addingTimeInterval(seconds)
        while !done() {
            if Date() > until { return false }
            Thread.sleep(forTimeInterval: every)
        }
        return true
    }
}
