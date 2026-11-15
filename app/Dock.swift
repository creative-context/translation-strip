// Where the strip goes. Two shapes: the strip right under Teams' main window, exactly as wide,
// its top edge on Teams' bottom edge; or a column beside it, 360 pt wide, exactly as tall as
// Teams and level with it. Pure math, so the check can try it with made-up screens.

import CoreGraphics

struct ScreenArea {
    var frame: CGRect // the screen, in AppKit's coordinates (bottom-left origin)
    var visible: CGRect // without the menu bar and the Dock
}

// The layout setting, kept in the app's preferences under "layout".
enum DockLayout: String, CaseIterable {
    case automatic, under, beside
}

// The shape the window takes.
enum DockShape: Equatable {
    case under, beside
}

enum Dock {
    static let height: CGFloat = 145
    static let firstWidth: CGFloat = 900
    static let columnWidth: CGFloat = 360

    // A top-left-origin rect (Accessibility, the window list) in AppKit's coordinates, which
    // count up from the bottom of the main screen (the one with the menu bar).
    static func appKit(_ r: CGRect, mainHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: mainHeight - r.maxY, width: r.width, height: r.height)
    }

    // The window's frame for a Teams window (top-left origin) and the layout setting.
    static func frame(for teams: CGRect, layout: DockLayout, screens: [ScreenArea], mainHeight: CGFloat) -> CGRect {
        switch shape(for: teams, layout: layout, screens: screens, mainHeight: mainHeight) {
        case .under: return frame(under: teams, screens: screens, mainHeight: mainHeight)
        case .beside: return frame(beside: teams, screens: screens, mainHeight: mainHeight)
        }
    }

    // Under and Beside force their shape. Automatic: under Teams when its screen's visible
    // frame has at least the strip's height free below Teams' window, else beside it. With
    // no screen to measure against, under, as before.
    static func shape(for teams: CGRect, layout: DockLayout, screens: [ScreenArea], mainHeight: CGFloat) -> DockShape {
        switch layout {
        case .under: return .under
        case .beside: return .beside
        case .automatic:
            let t = appKit(teams, mainHeight: mainHeight)
            guard let screen = screen(of: t, screens: screens) else { return .under }
            return t.minY - screen.visible.minY >= height ? .under : .beside
        }
    }

    // The strip's frame for a Teams window (top-left origin). With less than its height free
    // under Teams, it sits at the bottom of that screen's visible area instead.
    static func frame(under teams: CGRect, screens: [ScreenArea], mainHeight: CGFloat) -> CGRect {
        let t = appKit(teams, mainHeight: mainHeight)
        var y = t.minY - height
        if let screen = screen(of: t, screens: screens), y < screen.visible.minY { y = screen.visible.minY }
        return CGRect(x: t.minX, y: y, width: t.width, height: height)
    }

    // The column's frame for a Teams window (top-left origin): exactly as tall as Teams and
    // level with it, against Teams' right edge when the visible frame has the column's width
    // there, else against its left edge. With room on neither side, inside the visible frame
    // at Teams' right edge, over Teams.
    static func frame(beside teams: CGRect, screens: [ScreenArea], mainHeight: CGFloat) -> CGRect {
        let t = appKit(teams, mainHeight: mainHeight)
        let w = columnWidth
        var x = t.maxX
        if let v = screen(of: t, screens: screens)?.visible {
            if v.maxX - t.maxX >= w {
                x = t.maxX
            } else if t.minX - v.minX >= w {
                x = t.minX - w
            } else {
                x = max(v.minX, min(t.maxX, v.maxX) - w)
            }
        }
        return CGRect(x: x, y: t.minY, width: w, height: t.height)
    }

    // The first launch with Teams closed: the bottom of the main screen, 900 pt wide.
    static func firstFrame(main: ScreenArea) -> CGRect {
        let v = main.visible
        let w = min(firstWidth, v.width)
        return CGRect(x: v.midX - w / 2, y: v.minY, width: w, height: height)
    }

    // Teams' screen (Teams in AppKit's coordinates): the one under its bottom edge, else the
    // one it overlaps most.
    static func screen(of t: CGRect, screens: [ScreenArea]) -> ScreenArea? {
        let edge = CGPoint(x: t.midX, y: t.minY + 1) // just inside Teams' bottom edge
        return screens.first { $0.frame.contains(edge) }
            ?? screens.max { overlap($0.frame, t) < overlap($1.frame, t) }
    }

    private static func overlap(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let i = a.intersection(b)
        return i.isNull ? 0 : i.width * i.height
    }
}
