// Translation Strip: a strip docked in the gap right under the Teams window, or a column beside
// it when there's no room below (the Layout setting, Dock.swift). The page
// (http://127.0.0.1:4810/, served by the app's own copy of the server) fills it; the shell
// keeps it with Teams as Teams moves, tells the page which chat is open, puts the English
// into that chat (Send.swift), dictates in the language chosen in Settings (Dictation.swift),
// answers a global shortcut (Hotkey.swift) and opens the Settings window (SettingsWindow.swift).
// The bridge is in docs/contract.md, "Page ↔ shell".

import AppKit
import ApplicationServices
import WebKit

let appName = "Translation Strip"
let appBundleID = "com.creativecontext.TranslationStrip"
let port = 4810
let pageURL = URL(string: "http://127.0.0.1:\(port)/")!
let stateURL = URL(string: "http://127.0.0.1:\(port)/api/state")!
let settingsURL = URL(string: "http://127.0.0.1:\(port)/api/settings")!
let settingsPageURL = URL(string: "http://127.0.0.1:\(port)/settings.html")!
let pageOrigin = "http://127.0.0.1:\(port)" // the Origin the server takes POSTs from
let stripCornerRadius: CGFloat = 10 // the page's --radius-raised, which its .strip uses

// The app folder, the same one the server uses: STRIP_DIR, else ~/.translation-strip.
let stripDir: URL = ProcessInfo.processInfo.environment["STRIP_DIR"].map { URL(fileURLWithPath: $0) }
    ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".translation-strip")

// The strip's outer edge: a band the user drags to set the strip's height (below or above Teams)
// or the column's width (left or right of it). Anywhere else, clicks go through to the page.
final class EdgeResizer: NSView {
    static let band: CGFloat = 6
    var shape: DockShape = .below {
        didSet { if shape != oldValue { window?.invalidateCursorRects(for: self) } }
    }
    var onStart: () -> Void = {}
    var onDrag: (CGPoint) -> Void = { _ in } // how far the pointer went since the press, up and right positive
    var onEnd: () -> Void = {}
    private(set) var dragging = false
    private var pressedAt = CGPoint.zero

    var edge: NSRect {
        let b = bounds, w = Self.band
        switch shape {
        case .below: return NSRect(x: 0, y: 0, width: b.width, height: w)
        case .above: return NSRect(x: 0, y: b.height - w, width: b.width, height: w)
        case .right: return NSRect(x: b.width - w, y: 0, width: w, height: b.height)
        case .left: return NSRect(x: 0, y: 0, width: w, height: b.height)
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        edge.contains(convert(point, from: superview)) ? self : nil
    }
    override func resetCursorRects() {
        addCursorRect(edge, cursor: shape.isColumn ? .resizeLeftRight : .resizeUpDown)
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    // Where the event happened, on the screen: from the event itself (the window may have moved
    // or grown since the press, and the event says where it was then).
    private func onScreen(_ event: NSEvent) -> CGPoint {
        event.window?.convertPoint(toScreen: event.locationInWindow) ?? NSEvent.mouseLocation
    }
    override func mouseDown(with event: NSEvent) {
        dragging = true
        pressedAt = onScreen(event)
        onStart()
    }
    override func mouseDragged(with event: NSEvent) {
        let now = onScreen(event)
        onDrag(CGPoint(x: now.x - pressedAt.x, y: now.y - pressedAt.y))
    }
    override func mouseUp(with event: NSEvent) {
        dragging = false
        onEnd()
    }
}

// Borderless, and still able to take the keyboard so the page's fields work.
final class StripWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let defaults = UserDefaults.standard
    var window: StripWindow!
    var web: PageView!
    var keeper: ServerKeeper!
    var pageReady = false // the page said ready; it has window.strip

    // Teams: read on their own queue (the send shares it), followed for the docking on another;
    // the main thread only moves and orders the window.
    let teamsQueue = DispatchQueue(label: "translation-strip.teams", qos: .userInitiated)
    let dockQueue = DispatchQueue(label: "translation-strip.dock", qos: .userInitiated)
    let reader = TeamsReader()
    let follower = TeamsFollower() // used on dockQueue only
    var published: TeamsContext? // what the page was last told
    var reading = false
    var nextRead = Date.distantPast
    var sending = false
    var docking = false // a dock is being worked out on dockQueue
    var dockAgain = false // and another was asked for meanwhile
    var dockRaise = false
    var dockAX = false
    var dockShow = false
    var firstPlace = true // the strip's first placement at launch also makes it active
    var followedPid: pid_t = 0
    var layoutMenu: NSMenu? // the app menu's Layout submenu
    let resizer = EdgeResizer() // the strip's outer edge, to drag
    var resizeStart: (size: DockSize, frame: NSRect)?
    var resizedTo: DockSize?

    // The server answering on the port: whether it's this app's own, by pid.
    var checkedServers: [pid_t: Bool] = [:]

    let dictation = Dictation()
    let settingsWindow = SettingsWindow(url: settingsPageURL, port: port)
    let shortcut = GlobalShortcut()
    var lastAccess: (accessibility: Bool, microphone: String)?
    var accessTimer: Timer?
    var promptedAccess = false

    var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        ShellLog.appName = appName
        ShellLog.path = stripDir.appendingPathComponent("server.log").path
        ShellLog.rotate = true
        keeper = ServerKeeper(.init(port: port, version: version, versionEnv: "STRIP_VERSION", parentEnv: "STRIP_PARENT_PID",
                                    portEnv: "STRIP_PORT", bundleID: appBundleID, logStarts: true, ownWords: "this app's"))
        keeper.launch()
        buildMenu()
        buildWindow()
        reader.log = { ShellLog.write($0) }
        follower.log = { ShellLog.write($0) }
        follower.notify = { [weak self] name in
            MainActor.assumeIsolated { self?.teamsWindowChanged(name) }
        }

        dictation.log = { ShellLog.write($0) }
        dictation.onUpdate = { [weak self] state, text in
            var m: [String: Any] = ["state": state]
            if let text { m["text"] = text }
            self?.call("dictation", m)
        }
        dictation.onProgress = { [weak self] fraction in
            self?.call("dictation", ["state": "preparing", "progress": fraction])
        }
        settingsWindow.log = { ShellLog.write($0) }
        settingsWindow.onChoose = { [weak self] what, w in
            if what == "linter" { self?.chooseLinter(sheet: w) } else { self?.chooseGuide(sheet: w) }
        }
        GlobalShortcut.pressed = { [weak self] in self?.shortcutPressed() }
        if let why = shortcut.register() { ShellLog.write("shortcut: \(why)") }

        let ws = NSWorkspace.shared.notificationCenter
        let teamsNote = { (n: Notification) -> Bool in
            (n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier == teamsBundleID
        }
        ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { n in
            guard teamsNote(n) else { return }
            MainActor.assumeIsolated {
                self.dock(raise: true, ax: true)
                self.readTeams(now: true)
            }
        }
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
                     NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification] {
            ws.addObserver(forName: name, object: nil, queue: .main) { n in
                guard teamsNote(n) else { return }
                MainActor.assumeIsolated {
                    self.dock(ax: true)
                    self.readTeams(now: true)
                }
            }
        }
        ws.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { self.dock() }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { self.dock() }
        }
        // The fallback for everything the notifications miss, and the context once a second.
        let tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            MainActor.assumeIsolated {
                self.dock()
                self.readTeams()
            }
        }
        tick.tolerance = 0.2

        dock()
        if window.isVisible { // Teams isn't running: the strip is out already (with Teams, place() does this)
            firstPlace = false
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
        }
        loadWhenReady()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { _ = self.checkRequirements() }
        if !AXIsProcessTrusted() { ShellLog.write("Accessibility not granted yet") }
    }

    func applicationWillTerminate(_ notification: Notification) {
        keeper.terminate()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showStrip()
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // Permission may have changed in System Settings while the app was in the background.
    func applicationDidBecomeActive(_ notification: Notification) {
        sendAccess()
    }

    // MARK: the window

    func buildWindow() {
        window = StripWindow(contentRect: NSRect(x: 0, y: 0, width: Dock.firstWidth, height: Dock.height),
                             styleMask: [.borderless], backing: .buffered, defer: false)
        window.title = appName
        window.level = .normal // never floating: it's ordered in front of Teams, not above everything
        // A window of its own under Teams: rounded corners and the system's shadow, like Teams' window
        // above it. The page draws the strip's surface; the corners outside it stay clear.
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovable = false
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.collectionBehavior = [.canJoinAllSpaces] // it follows Teams to any Space, and steps out when Teams isn't there
        window.appearance = NSAppearance(named: .darkAqua) // the page is dark only
        window.delegate = self

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "strip")
        web = PageView(frame: .zero, configuration: config)
        web.titlebarHeight = 0 // no drag area: the strip follows Teams
        web.setValue(false, forKey: "drawsBackground")
        web.allowsMagnification = false
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        if let content = window.contentView {
            content.wantsLayer = true
            content.layer?.cornerRadius = stripCornerRadius
            content.layer?.cornerCurve = .continuous
            content.layer?.masksToBounds = true
            web.frame = content.bounds
            content.addSubview(web)
            // The outer edge, over the page's 8 pt margin: drag it to set the strip's height or the
            // column's width.
            resizer.frame = content.bounds
            resizer.autoresizingMask = [.width, .height]
            resizer.onStart = { [weak self] in self?.resizeStarted() }
            resizer.onDrag = { [weak self] delta in self?.resizeDragged(delta) }
            resizer.onEnd = { [weak self] in self?.resizeEnded() }
            content.addSubview(resizer)
        }
        window.setFrame(savedFrame ?? Dock.firstFrame(main: screenAreas.first ?? ScreenArea(frame: .zero, visible: .zero)), display: false)
    }

    var screenAreas: [ScreenArea] { NSScreen.screens.map { ScreenArea(frame: $0.frame, visible: $0.visibleFrame) } }

    // The layout setting: automatic (the default), or below, above, left or right of Teams.
    var layout: DockLayout {
        get { defaults.string(forKey: "layout").flatMap(DockLayout.init(saved:)) ?? .automatic }
        set { defaults.set(newValue.rawValue, forKey: "layout") }
    }

    // The strip's height and the column's width, as the user last dragged them.
    var dockSize: DockSize {
        get {
            let h = defaults.double(forKey: "stripHeight"), w = defaults.double(forKey: "columnWidth")
            return DockSize(stripHeight: h > 0 ? CGFloat(h) : Dock.height, columnWidth: w > 0 ? CGFloat(w) : Dock.columnWidth).clamped
        }
        set {
            defaults.set(Double(newValue.stripHeight), forKey: "stripHeight")
            defaults.set(Double(newValue.columnWidth), forKey: "columnWidth")
        }
    }

    // The last place the strip was docked, if it's still on a screen.

    var savedFrame: NSRect? {
        guard let s = defaults.string(forKey: "stripFrame") else { return nil }
        let r = NSRectFromString(s)
        guard r.width > 100, r.height > 0, NSScreen.screens.contains(where: { $0.frame.intersects(r) }) else { return nil }
        return r
    }

    func windowDidBecomeKey(_ notification: Notification) {
        readTeams(now: true)
    }

    // MARK: docking

    // Under Teams' main window, as wide as it, or a column beside it, as tall as it: the layout
    // setting and the room around Teams decide (Dock.frame(for:)). Out of sight while Teams' window isn't on
    // screen; where it last was while Teams isn't running. `raise` orders it in front of
    // other windows without activating the app; `ax` asks Accessibility which window is
    // Teams' main one (otherwise the window list follows the one it was); `show` keeps the
    // strip out even when Teams' window isn't on screen (the shortcut). Worked out on
    // dockQueue; only the frame and the ordering change here, on the main thread.
    func dock(raise: Bool = false, ax: Bool = false, show: Bool = false) {
        dockRaise = dockRaise || raise
        dockAX = dockAX || ax
        dockShow = dockShow || show
        guard !docking else { dockAgain = true; return }
        guard !resizer.dragging else { return } // the user is dragging its edge: it docks again after
        guard !NSApp.isHidden else { dockRaise = false; dockAX = false; dockShow = false; return }
        let raise = dockRaise, ax = dockAX, show = dockShow
        dockRaise = false
        dockAX = false
        dockShow = false
        let teams = Teams.running()
        if teams == nil && followedPid != 0 {
            followedPid = 0
            let f = follower
            dockQueue.async { f.reset() }
        }
        guard let teams else {
            if !window.isVisible { window.orderFrontRegardless() }
            return
        }
        followedPid = teams.processIdentifier
        docking = true
        let screens = screenAreas
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        let layout = self.layout
        let size = self.dockSize
        let f = follower
        dockQueue.async {
            let w = f.window(of: teams, ax: ax)
            let shape = w.map { Dock.shape(for: $0.frame, layout: layout, screens: screens, mainHeight: mainHeight, size: size) }
            let frame = w.flatMap { t in t.onScreen ? shape.map { Dock.frame($0, teams: t.frame, screens: screens, mainHeight: mainHeight, size: size) } : nil }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if let shape { self.resizer.shape = shape }
                    self.place(frame, raise: raise, show: show)
                    self.docking = false
                    if self.dockAgain {
                        self.dockAgain = false
                        self.dock()
                    }
                }
            }
        }
    }

    // Dragging the outer edge: the window follows the pointer, with the side next to Teams held
    // where it is; the new measure is kept when the drag ends, and the strip docks again.
    func resizeStarted() {
        resizeStart = (dockSize, window.frame)
        resizedTo = nil
    }

    func resizeDragged(_ delta: CGPoint) {
        guard let start = resizeStart else { return }
        let s = Dock.resized(start.size, shape: resizer.shape, delta: delta)
        var f = start.frame
        switch resizer.shape {
        case .below: f.size.height = s.stripHeight; f.origin.y = start.frame.maxY - s.stripHeight
        case .above: f.size.height = s.stripHeight
        case .right: f.size.width = s.columnWidth
        case .left: f.size.width = s.columnWidth; f.origin.x = start.frame.maxX - s.columnWidth
        }
        window.setFrame(f, display: true, animate: false)
        resizedTo = s
    }

    func resizeEnded() {
        if let s = resizedTo {
            dockSize = s
            ShellLog.write(resizer.shape.isColumn ? "size: column \(Int(s.columnWidth)) pt wide" : "size: strip \(Int(s.stripHeight)) pt tall")
        }
        resizeStart = nil
        resizedTo = nil
        dock()
    }

    // nil: Teams' window isn't on screen, so the strip steps out (unless `show`).
    func place(_ f: NSRect?, raise: Bool, show: Bool) {
        guard !NSApp.isHidden else { return }
        let first = firstPlace
        firstPlace = false
        guard let f else {
            if window.isVisible && !show { window.orderOut(nil) }
            return
        }
        let moved = !NSEqualRects(window.frame, f)
        if moved { // one setFrame, origin and size together, so a change of shape doesn't flicker
            window.setFrame(f, display: true, animate: false)
            defaults.set(NSStringFromRect(f), forKey: "stripFrame")
        }
        if raise || moved || !window.isVisible { window.orderFrontRegardless() }
        if first {
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
        }
    }

    // An Accessibility notification from Teams (TeamsFollower's observer), on the main thread.
    func teamsWindowChanged(_ name: String) {
        let away = name == kAXWindowMiniaturizedNotification || name == kAXApplicationHiddenNotification
        dock(raise: !away, ax: true)
        if !away { readTeams(now: true) }
    }

    // MARK: Teams context

    // Reads Teams on its queue and tells the page when something changed. A slow read
    // (over 50 ms) spaces the next ones out.
    func readTeams(now: Bool = false) {
        guard pageReady, window.isVisible || now, !reading, now || Date() >= nextRead else { return }
        reading = true
        let r = reader
        teamsQueue.async {
            let context = r.read()
            let ms = r.readMs
            DispatchQueue.main.async {
                self.reading = false
                self.nextRead = ms > 50 ? Date().addingTimeInterval(min(5, ms / 50)) : .distantPast
                self.publish(context)
            }
        }
    }

    func publish(_ c: TeamsContext) {
        guard c != published else { return }
        published = c
        call("teams", c.page)
    }

    // MARK: the page

    // Load the page once the server answers.
    func loadWhenReady() {
        var req = URLRequest(url: stateURL)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                if ok {
                    self.web.load(URLRequest(url: pageURL))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.loadWhenReady() }
                }
            }
        }.resume()
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageReady = false
    }

    // The shadow follows what is drawn, so it is measured again once the page has drawn the strip.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.window.invalidateShadow() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.loadWhenReady() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageReady = false
        loadWhenReady()
    }

    // The web view stays on the local page; nothing else loads in it.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let local = url.absoluteString == "about:blank" || (url.scheme == "http" && url.host == "127.0.0.1" && url.port == port)
        if !local { ShellLog.write("blocked a navigation away from the local page") }
        decisionHandler(local ? .allow : .cancel)
    }

    // window.strip.<fn>(arg), once the page has said it's ready.
    func call(_ fn: String, _ arg: Any?) {
        guard pageReady else { return }
        var js = "window.strip && window.strip.\(fn)("
        if let arg, let data = try? JSONSerialization.data(withJSONObject: arg, options: [.fragmentsAllowed]),
           let json = String(data: data, encoding: .utf8) { js += json }
        js += ")"
        web.evaluateJavaScript(js, completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let type = m["type"] as? String else { return }
        let mainFrame = message.frameInfo.isMainFrame
        let origin = message.frameInfo.securityOrigin
        let localOrigin = origin.protocol == "http" && origin.host == "127.0.0.1" && origin.port == port
        guard mainFrame && localOrigin else {
            ShellLog.write("ignored a message that isn't from the local page's main frame")
            if type == "send" { call("sent", ["ok": false, "reason": "not-own-server"]) }
            return
        }
        switch type {
        case "ready":
            pageReady = true
            published = nil
            sendAccess(force: true)
            call("layout", ["value": layout.rawValue])
            readTeams(now: true)
            checkServer { own in
                if !own { ShellLog.write("the server on port \(port) isn't this app's own; nothing will be sent") }
            }
        case "send":
            checkServer { own in
                if let reason = OwnServer.refusal(mainFrame: mainFrame, localOrigin: localOrigin, own: own) {
                    ShellLog.write("send: not sent (\(reason))")
                    return self.call("sent", ["ok": false, "reason": reason])
                }
                self.send(m)
            }
        case "layout":
            if let l = (m["value"] as? String).flatMap(DockLayout.init(rawValue:)) { setLayout(l) }
        case "dictation":
            if (m["action"] as? String) == "start" { dictation.start(locale: m["locale"] as? String) } else { dictation.stop() }
        case "open":
            open(m["what"] as? String ?? "")
        case "detect":
            // The language of what's being written, guessed on the Mac; the text isn't kept or logged.
            let language = DetectedLanguage.of(m["text"] as? String ?? "")
            call("detected", ["language": language as Any? ?? NSNull(), "seq": m["seq"] ?? NSNull()])
        default:
            ShellLog.write("the page sent an unknown message: \(type.prefix(20))")
        }
    }

    // Whether the server on the port is this app's own: the process listening on it, asked of the
    // system (lsof), not of the server, so a slow or hostile server can't answer for itself. It
    // must be the one the keeper started or, checked with ServerKeeper.isAppServer, a server
    // inside an app with this bundle ID. Asked when the page says ready and before each send; the
    // answer for a pid is kept.
    func checkServer(_ done: @escaping @MainActor (Bool) -> Void) {
        let keeperPid = keeper.process?.processIdentifier
        let port = port
        let known = checkedServers
        DispatchQueue.global(qos: .userInitiated).async {
            let pid = ServerKeeper.portHolder(port)
            let own = pid.flatMap { known[$0] } ?? OwnServer.isOwn(pid: pid, keeperPid: keeperPid) { ServerKeeper.isAppServer($0, bundleID: appBundleID) }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if let pid { self.checkedServers[pid] = own }
                    else { ShellLog.write("couldn't tell which process listens on port \(port)") }
                    done(own)
                }
            }
        }
    }

    func sendAccess(force: Bool = false) {
        let a = (accessibility: AXIsProcessTrusted(), microphone: Dictation.microphone)
        guard force || lastAccess.map({ $0.accessibility != a.accessibility || $0.microphone != a.microphone }) ?? true else { return }
        lastAccess = a
        call("access", ["accessibility": a.accessibility, "microphone": a.microphone])
    }

    // MARK: sending

    func send(_ m: [String: Any]) {
        guard !sending else { return ShellLog.write("send: one is already in progress") }
        let text = (m["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return call("sent", ["ok": false]) }
        let leave = (m["mode"] as? String) == "leave"
        let afterDraft = (m["afterDraft"] as? Bool) == true
        // The chat the strip showed when the user pressed Send: the message goes there or nowhere.
        let chat = (m["chat"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        sending = true
        let r = reader
        teamsQueue.async {
            let out = r.send(text, to: chat, leave: leave, afterDraft: afterDraft, log: { ShellLog.write($0) })
            DispatchQueue.main.async {
                self.sending = false
                ShellLog.write(out.ok ? (leave ? "send: left in the message box" : "send: sent") : "send: not sent (\(out.reason ?? "unknown"))")
                var reply: [String: Any] = ["ok": out.ok]
                if let reason = out.reason { reply["reason"] = reason }
                self.call("sent", reply)
                // Back to the strip, ready for the next message; a message left in the box
                // keeps Teams in front.
                if !(leave && out.ok) {
                    NSApp.activate()
                    self.window.makeKeyAndOrderFront(nil)
                    self.call("focus", nil)
                }
                self.readTeams(now: true)
            }
        }
    }

    // MARK: opening things

    func open(_ what: String) {
        switch what {
        case "teams":
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: teamsBundleID) else {
                return ShellLog.write("Teams isn't installed")
            }
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
        case "accessibility":
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
            if !promptedAccess {
                promptedAccess = true
                _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
            }
            waitForAccess()
        case "microphone":
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
        case "guide":
            chooseGuide()
        default:
            ShellLog.write("the page asked to open something unknown")
        }
    }

    // Once a second until Accessibility is granted, then the page hears it.
    func waitForAccess() {
        guard accessTimer == nil else { return }
        accessTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            MainActor.assumeIsolated {
                guard AXIsProcessTrusted() else { return }
                self.accessTimer?.invalidate()
                self.accessTimer = nil
                ShellLog.write("Accessibility granted")
                let f = self.follower
                self.dockQueue.async { f.reset() } // follow again, now with the observer
                self.dock(ax: true)
                self.sendAccess()
                self.readTeams(now: true)
            }
        }
    }

    // MARK: the shortcut

    // Teams forward first if its window is out of sight, then the strip under it, active,
    // with the Spanish field focused. Teams is looked at on dockQueue.
    func shortcutPressed() {
        guard let teams = Teams.running() else { return showStrip() }
        let f = follower
        dockQueue.async {
            let away = !(f.window(of: teams, ax: true)?.onScreen ?? false)
            if away { f.unminimize() } // a minimized main window comes back
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard away else { return self.showStrip() }
                    teams.unhide()
                    teams.activate()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.showStrip() }
                }
            }
        }
    }

    func showStrip() {
        dock(raise: true, ax: true, show: true)
        if !window.isVisible { window.orderFrontRegardless() }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
        call("focus", nil)
        readTeams(now: true)
    }

    // MARK: settings

    @objc func openSettings() { settingsWindow.show() }

    // From the Settings page (a sheet on its window) or the strip's "open guide" (a panel of its own).
    func chooseGuide(sheet: NSWindow? = nil) {
        choose("voiceGuide", message: "The voice guide the translator follows, for every language.", sheet: sheet)
    }

    func chooseLinter(sheet: NSWindow? = nil) {
        choose("linter", message: "The voice linter that checks each reply.", sheet: sheet)
    }

    func choose(_ key: String, message: String, sheet: NSWindow? = nil) {
        NSApp.activate()
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = message
        panel.prompt = "Choose"
        if let current = readSettings()[key] as? String, !current.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: current).deletingLastPathComponent()
        }
        let done = { (response: NSApplication.ModalResponse) in
            guard response == .OK, let url = panel.url else { return }
            MainActor.assumeIsolated { self.postSetting(key, url.path) }
        }
        if let sheet, sheet.isVisible { panel.beginSheetModal(for: sheet, completionHandler: done) } else { panel.begin(completionHandler: done) }
    }

    // The app folder's settings.json, read only for the chooser's starting folder: the server
    // is its one writer.
    func readSettings() -> [String: Any] {
        let file = stripDir.appendingPathComponent("settings.json")
        guard let data = try? Data(contentsOf: file),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    // The chosen path goes to the server (POST /api/settings), which checks it, writes the
    // file and restarts the translator. Only to this app's own server.
    func postSetting(_ key: String, _ path: String) {
        checkServer { own in
            guard own else {
                ShellLog.write("settings: \(key) not saved (the server isn't this app's own)")
                return self.settingFailed("The app's server isn't the one answering. Quit the app and open it again.")
            }
            var req = URLRequest(url: settingsURL)
            req.httpMethod = "POST"
            req.timeoutInterval = 5
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue(pageOrigin, forHTTPHeaderField: "Origin")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [key: path])
            URLSession.shared.dataTask(with: req) { data, response, _ in
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let error = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["error"] as? String
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        if status == 200 { return ShellLog.write("settings: \(key) chosen") }
                        ShellLog.write("settings: \(key) not saved (\(status == 0 ? "no answer" : "\(status) \(error ?? "")"))")
                        self.settingFailed(error == "path" ? "That file can't be used. Choose another one."
                                                           : "The app's server didn't save it. Try again in a moment.")
                    }
                }
            }.resume()
        }
    }

    func settingFailed(_ why: String) {
        let alert = NSAlert()
        alert.messageText = "Couldn't save the setting"
        alert.informativeText = why
        alert.runModal()
    }

    // MARK: menus

    func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        if let action, responds(to: action) { i.target = self }
        return i
    }

    // No item takes ⌘⏎, ⌘D, ⌘K, ⌘W or Esc: the page owns those.
    func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.items = [
            item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            item("Settings…", #selector(openSettings), ","),
            .separator(),
            layoutItem(),
            .separator(),
            item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"),
            .separator(),
            item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
        ]

        // No target: the commands go to whatever has the focus, the page's fields.
        let editMenu = NSMenu(title: "Edit")
        editMenu.items = [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ]

        let windowMenu = NSMenu(title: "Window")
        windowMenu.items = [item("Show Strip", #selector(showStripFromMenu), "t", [.control, .option])]

        for (title, menu) in [(appName, appMenu), ("Edit", editMenu), ("Window", windowMenu)] {
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            top.submenu = menu
            main.addItem(top)
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    @objc func showStripFromMenu() { shortcutPressed() }

    // "Layout" in the app menu: Automatic, Under Teams and Beside Teams as radio items, a check
    // on the current one.
    func layoutItem() -> NSMenuItem {
        let menu = NSMenu(title: "Layout")
        let titles: [DockLayout: String] = [.automatic: "Automatic", .below: "Below Teams", .above: "Above Teams",
                                            .left: "Left of Teams", .right: "Right of Teams"]
        for l in DockLayout.allCases {
            let i = item(titles[l] ?? l.rawValue, #selector(chooseLayout(_:)), "")
            i.representedObject = l.rawValue
            menu.addItem(i)
        }
        let top = NSMenuItem(title: "Layout", action: nil, keyEquivalent: "")
        top.submenu = menu
        layoutMenu = menu
        updateLayoutMenu()
        return top
    }

    func updateLayoutMenu() {
        let current = layout.rawValue
        for i in layoutMenu?.items ?? [] { i.state = (i.representedObject as? String) == current ? .on : .off }
    }

    @objc func chooseLayout(_ sender: NSMenuItem) {
        guard let l = (sender.representedObject as? String).flatMap(DockLayout.init(rawValue:)) else { return }
        setLayout(l)
    }

    // From the Layout menu or the page's settings menu: keep it, check it in the menu, tell the page, dock.
    func setLayout(_ l: DockLayout) {
        guard l != layout else { return call("layout", ["value": l.rawValue]) }
        layout = l
        updateLayoutMenu()
        call("layout", ["value": l.rawValue])
        ShellLog.write("layout: \(l.rawValue)")
        dock()
    }

    // MARK: requirements

    // Bun runs the server and the server travels inside the app: without them nothing works.
    func checkRequirements() -> Bool {
        var missing: [String] = []
        if ServerKeeper.bunPath == nil { missing.append("Bun runs the app's local server. Install it from bun.sh.") }
        if ServerKeeper.serverDir == nil { missing.append("The server files are missing from the app. Build it again.") }
        guard !missing.isEmpty else { return false }
        ShellLog.write("can't start: \(ServerKeeper.bunPath == nil ? "no bun" : "no server files")")
        NSApp.activate()
        let alert = NSAlert()
        alert.messageText = "\(appName) can't start"
        alert.informativeText = missing.joined(separator: "\n\n") + "\n\nThen open the app again."
        alert.addButton(withTitle: "OK")
        alert.runModal()
        return true
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular) // a Dock icon and Cmd-Tab, like any app
    app.run()
}
