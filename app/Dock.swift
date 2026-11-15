// Where the strip goes: right under Teams' main window, exactly as wide, its top edge on
// Teams' bottom edge. Pure math, so the check can try it with made-up screens.

import CoreGraphics

struct ScreenArea {
    var frame: CGRect // the screen, in AppKit's coordinates (bottom-left origin)
    var visible: CGRect // without the menu bar and the Dock
}

enum Dock {
    static let height: CGFloat = 145
    static let firstWidth: CGFloat = 900

    // A top-left-origin rect (Accessibility, the window list) in AppKit's coordinates, which
    // count up from the bottom of the main screen (the one with the menu bar).
    static func appKit(_ r: CGRect, mainHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: mainHeight - r.maxY, width: r.width, height: r.height)
    }

    // The strip's frame for a Teams window (top-left origin). With less than its height free
    // under Teams, it sits at the bottom of that screen's visible area instead.
    static func frame(under teams: CGRect, screens: [ScreenArea], mainHeight: CGFloat) -> CGRect {
        let t = appKit(teams, mainHeight: mainHeight)
        let edge = CGPoint(x: t.midX, y: t.minY + 1) // just inside Teams' bottom edge
        let screen = screens.first { $0.frame.contains(edge) }
            ?? screens.max { overlap($0.frame, t) < overlap($1.frame, t) }
        var y = t.minY - height
        if let screen, y < screen.visible.minY { y = screen.visible.minY }
        return CGRect(x: t.minX, y: y, width: t.width, height: height)
    }

    // The first launch with Teams closed: the bottom of the main screen, 900 pt wide.
    static func firstFrame(main: ScreenArea) -> CGRect {
        let v = main.visible
        let w = min(firstWidth, v.width)
        return CGRect(x: v.midX - w / 2, y: v.minY, width: w, height: height)
    }

    private static func overlap(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let i = a.intersection(b)
        return i.isNull ? 0 : i.width * i.height
    }
}
