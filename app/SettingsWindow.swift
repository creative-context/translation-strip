// The Settings window (Translation Strip › Settings…, ⌘,): a standard titled Mac window with a
// web view on the server's /settings.html. The page reads /api/state and its stream and writes
// /api/settings itself; it talks to the shell only through its own `settings` message handler:
// { type: "choose", what: "voiceGuide" | "linter" } opens the file chooser (onChoose), and
// { type: "close" } closes the window. One window, made on first use and kept; it remembers its
// frame. The bridge is in docs/contract.md.

import AppKit
import WebKit

@MainActor
final class SettingsWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    static let width: CGFloat = 620 // the page's layout is drawn for this width
    static let height: CGFloat = 640 // the first height; the user can make it taller or shorter
    static let minHeight: CGFloat = 420

    let url: URL
    let port: Int
    var onChoose: (_ what: String, _ window: NSWindow) -> Void = { _, _ in }
    var log: (String) -> Void = { _ in }
    private(set) var window: NSWindow?
    private var web: WKWebView?
    private var retry: DispatchWorkItem?

    init(url: URL, port: Int) {
        self.url = url
        self.port = port
    }

    func show() {
        let w = window ?? build()
        if web?.url == nil { load() }
        NSApp.activate()
        w.makeKeyAndOrderFront(nil)
    }

    func close() { window?.performClose(nil) }

    private func build() -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: Self.height),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = "Settings"
        w.isReleasedWhenClosed = false
        w.appearance = NSAppearance(named: .darkAqua) // the page is dark only
        w.backgroundColor = NSColor(srgbRed: 3 / 255, green: 3 / 255, blue: 4 / 255, alpha: 1) // the page's body, so nothing flashes
        w.collectionBehavior = [.fullScreenNone]
        // A fixed width, the height the user's: the page scrolls when its languages don't fit.
        w.contentMinSize = NSSize(width: Self.width, height: Self.minHeight)
        w.contentMaxSize = NSSize(width: Self.width, height: 4000)
        w.delegate = self

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "settings")
        let v = WKWebView(frame: w.contentView?.bounds ?? .zero, configuration: config)
        v.setValue(false, forKey: "drawsBackground")
        v.allowsMagnification = false
        v.navigationDelegate = self
        v.autoresizingMask = [.width, .height]
        w.contentView?.addSubview(v)
        web = v

        // Where the user last left it; centered the first time.
        if !w.setFrameUsingName("Settings") { w.center() }
        w.setFrameAutosaveName("Settings")
        window = w
        return w
    }

    private func load() {
        retry?.cancel()
        web?.load(URLRequest(url: url))
    }

    // The server may not be up yet, or restarting: try again while the window is open.
    private func loadLater() {
        retry?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.window?.isVisible == true else { return }
            self.load()
        }
        retry = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: item)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadLater()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        load()
    }

    // The web view stays on the local page; nothing else loads in it.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let u = navigationAction.request.url else { return decisionHandler(.cancel) }
        let local = u.absoluteString == "about:blank" || (u.scheme == "http" && u.host == "127.0.0.1" && u.port == port)
        if !local { log("settings: blocked a navigation away from the local page") }
        decisionHandler(local ? .allow : .cancel)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let type = m["type"] as? String else { return }
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "http", origin.host == "127.0.0.1", origin.port == port else {
            return log("settings: ignored a message that isn't from the local page's main frame")
        }
        switch type {
        case "choose":
            let what = m["what"] as? String ?? ""
            guard what == "voiceGuide" || what == "linter", let w = window else {
                return log("settings: the page asked to choose something unknown")
            }
            onChoose(what, w)
        case "close":
            close()
        default:
            log("settings: the page sent an unknown message: \(type.prefix(20))")
        }
    }
}
