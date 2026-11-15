// Translation Strip: a strip docked in the gap right under the Teams window. The page
// (http://127.0.0.1:4810/, served by the app's own copy of the server) fills it; the shell
// keeps it under Teams as Teams moves, tells the page which chat is open, puts the English
// into that chat (Send.swift), dictates Spanish (Dictation.swift) and answers a global
// shortcut (Hotkey.swift). The bridge is in docs/contract.md, "Page ↔ shell".

import AppKit
import ApplicationServices
import WebKit

let appName = "Translation Strip"
let appBundleID = "com.creativecontext.TranslationStrip"
let port = 4810
let pageURL = URL(string: "http://127.0.0.1:\(port)/")!
let stateURL = URL(string: "http://127.0.0.1:\(port)/api/state")!
let stripCornerRadius: CGFloat = 10 // the page's --radius-raised, which its .strip uses

// The app folder, the same one the server uses: STRIP_DIR, else ~/.translation-strip.
let stripDir: URL = ProcessInfo.processInfo.environment["STRIP_DIR"].map { URL(fileURLWithPath: $0) }
    ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".translation-strip")

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

    // Teams: read on their own queue (the send shares it), docked from the main thread.
    let teamsQueue = DispatchQueue(label: "translation-strip.teams", qos: .userInitiated)
    let reader = TeamsReader()
    var published: TeamsContext? // what the page was last told
    var reading = false
    var nextRead = Date.distantPast
    var sending = false
    var teamsAX: AXUIElement? // Teams' app element, for its frame
    var observer: AXObserver?
    var observedPid: pid_t = 0
    var watchFailed = false // the observer couldn't be made for this Teams: the 1 s check alone

    let dictation = Dictation()
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
                                    bundleID: appBundleID, logStarts: true, ownWords: "this app's"))
        keeper.launch()
        buildMenu()
        buildWindow()

        dictation.log = { ShellLog.write($0) }
        dictation.onUpdate = { [weak self] state, text in
            var m: [String: Any] = ["state": state]
            if let text { m["text"] = text }
            self?.call("dictation", m)
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
                self.dock(raise: true)
                self.readTeams(now: true)
            }
        }
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
                     NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification] {
            ws.addObserver(forName: name, object: nil, queue: .main) { n in
                guard teamsNote(n) else { return }
                MainActor.assumeIsolated {
                    self.dock()
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
        if window.isVisible {
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
        }
        window.setFrame(savedFrame ?? Dock.firstFrame(main: screenAreas.first ?? ScreenArea(frame: .zero, visible: .zero)), display: false)
    }

    var screenAreas: [ScreenArea] { NSScreen.screens.map { ScreenArea(frame: $0.frame, visible: $0.visibleFrame) } }

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

    // Under Teams' main window, as wide as it. Out of sight while Teams' window isn't on
    // screen; where it last was while Teams isn't running. `raise` orders it in front of
    // other windows without activating the app.
    func dock(raise: Bool = false) {
        guard !NSApp.isHidden else { return }
        guard let teams = Teams.running() else {
            if observedPid != 0 { stopWatching() }
            if !window.isVisible { window.orderFrontRegardless() }
            return
        }
        if observedPid != teams.processIdentifier || (observer == nil && !watchFailed && AXIsProcessTrusted()) { watch(teams) }
        guard let w = Teams.window(of: teams, app: teamsAX), w.onScreen else {
            if window.isVisible { window.orderOut(nil) }
            return
        }
        let f = Dock.frame(under: w.frame, screens: screenAreas, mainHeight: NSScreen.screens.first?.frame.height ?? 0)
        let moved = !NSEqualRects(window.frame, f)
        if moved {
            window.setFrame(f, display: true)
            defaults.set(NSStringFromRect(f), forKey: "stripFrame")
        }
        if raise || moved || !window.isVisible { window.orderFrontRegardless() }
    }

    // An Accessibility observer on Teams: its windows moving, resizing, minimizing and coming back.
    func watch(_ teams: NSRunningApplication) {
        stopWatching()
        observedPid = teams.processIdentifier
        let app = AXUIElementCreateApplication(observedPid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        teamsAX = app
        guard AXIsProcessTrusted() else { return }
        let callback: AXObserverCallback = { _, _, notification, refcon in
            guard let refcon else { return }
            let me = Unmanaged<AppDelegate>.fromOpaque(refcon).takeUnretainedValue()
            let name = notification as String
            MainActor.assumeIsolated { me.teamsWindowChanged(name) }
        }
        var obs: AXObserver?
        guard AXObserverCreate(observedPid, callback, &obs) == .success, let obs else {
            ShellLog.write("couldn't watch Teams' window; checking once a second")
            watchFailed = true
            return
        }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for n in [kAXWindowMovedNotification, kAXWindowResizedNotification, kAXWindowMiniaturizedNotification,
                  kAXWindowDeminiaturizedNotification, kAXApplicationHiddenNotification, kAXApplicationShownNotification,
                  kAXMainWindowChangedNotification] {
            AXObserverAddNotification(obs, app, n as CFString, refcon)
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        observer = obs
    }

    func stopWatching() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil
        observedPid = 0
        watchFailed = false
        teamsAX = nil
    }

    func teamsWindowChanged(_ name: String) {
        let away = name == kAXWindowMiniaturizedNotification || name == kAXApplicationHiddenNotification
        dock(raise: !away)
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
        switch type {
        case "ready":
            pageReady = true
            published = nil
            sendAccess(force: true)
            readTeams(now: true)
        case "send":
            send(m)
        case "dictation":
            if (m["action"] as? String) == "start" { dictation.start() } else { dictation.stop() }
        case "open":
            open(m["what"] as? String ?? "")
        default:
            ShellLog.write("the page sent an unknown message: \(type.prefix(20))")
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
        sending = true
        let r = reader
        teamsQueue.async {
            let out = r.send(text, leave: leave, afterDraft: afterDraft, log: { ShellLog.write($0) })
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
                self.stopWatching() // watch again, now with the observer
                self.dock()
                self.sendAccess()
                self.readTeams(now: true)
            }
        }
    }

    // MARK: the shortcut

    // Teams forward first if its window is out of sight, then the strip under it, active,
    // with the Spanish field focused.
    func shortcutPressed() {
        if let teams = Teams.running(), !(Teams.window(of: teams, app: teamsAX)?.onScreen ?? false) {
            bringTeamsForward(teams)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.showStrip() }
        } else {
            showStrip()
        }
    }

    func bringTeamsForward(_ teams: NSRunningApplication) {
        teams.unhide()
        if AXIsProcessTrusted() {
            let app = teamsAX ?? AXUIElementCreateApplication(teams.processIdentifier)
            // A minimized main window comes back: the largest one.
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
        teams.activate()
    }

    func showStrip() {
        dock(raise: true)
        if !window.isVisible { window.orderFrontRegardless() }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
        call("focus", nil)
        readTeams(now: true)
    }

    // MARK: settings

    @objc func chooseGuide() {
        choose("voiceGuide", message: "The voice guide the translator follows.")
    }

    @objc func chooseLinter() {
        choose("linter", message: "The voice linter that checks each English reply.")
    }

    func choose(_ key: String, message: String) {
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
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            MainActor.assumeIsolated { self.writeSetting(key, url.path) }
        }
    }

    var settingsFile: URL { stripDir.appendingPathComponent("settings.json") }

    func readSettings() -> [String: Any] {
        guard let data = try? Data(contentsOf: settingsFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    // One key changed, every other key kept. The server reads the file again on its own.
    func writeSetting(_ key: String, _ value: String) {
        var raw = readSettings()
        raw[key] = value
        do {
            try FileManager.default.createDirectory(at: stripDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var data = try JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            data.append(0x0A)
            let tmp = stripDir.appendingPathComponent("settings.json.\(getpid()).tmp")
            try data.write(to: tmp)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
            guard rename(tmp.path, settingsFile.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
            ShellLog.write("settings: \(key) chosen")
        } catch {
            ShellLog.write("settings: couldn't save \(key) (\(error.localizedDescription))")
            let alert = NSAlert()
            alert.messageText = "Couldn't save the setting"
            alert.informativeText = "The settings file in the app folder couldn't be written."
            alert.runModal()
        }
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
            item("Choose Voice Guide…", #selector(chooseGuide), ""),
            item("Choose Voice Linter…", #selector(chooseLinter), ""),
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
