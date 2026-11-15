// Checks of the shell's pure parts, with made-up screens, frames, titles and trees: where the strip
// docks (Dock.swift), how Teams' titles, headings and message box are read and how its window is
// walked for the box and the last message, on a made-up tree (Teams.swift), and the send's
// decisions: the paste watch and the own server (Send.swift). Built and run by test/swift-check.sh. Prints one line per case; exits 1 when one fails. A case marked known is a
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
        teams()
        tree()
        paste()
        ownServer()
        print("\(failures == 0 ? "ok" : "FAILED"): \(failures) failed, \(known) known")
        exit(failures == 0 ? 0 : 1)
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
        check("paste: watched every 50 ms for up to 1.5 s", [PasteWatch.every, PasteWatch.limit], [0.05, 1.5])
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
