// Where the strip goes. Four sides of Teams' main window: below or above it, a strip exactly as
// wide as Teams; left or right of it, a column exactly as tall as Teams and level with it. The
// other measure (the strip's height, the column's width) is the user's, within limits. Pure
// math, so the check can try it with made-up screens.

import CoreGraphics

struct ScreenArea {
    var frame: CGRect // the screen, in AppKit's coordinates (bottom-left origin)
    var visible: CGRect // without the menu bar and the Dock
}

// The layout setting, kept in the app's preferences under "layout".
enum DockLayout: String, CaseIterable {
    case automatic, below, above, left, right

    // What the preferences hold, including the names 0.5 saved ("under" and "beside").
    init?(saved: String) {
        switch saved {
        case "under": self = .below
        case "beside": self = .right
        default: self.init(rawValue: saved)
        }
    }
}

// The side the window takes.
enum DockShape: Equatable {
    case below, above, left, right
    var isColumn: Bool { self == .left || self == .right }
}

// The measures the user sets by dragging the strip's outer edge.
struct DockSize: Equatable {
    var stripHeight: CGFloat = Dock.height
    var columnWidth: CGFloat = Dock.columnWidth

    // Kept inside the limits, whatever the preferences hold.
    var clamped: DockSize {
        DockSize(stripHeight: min(max(stripHeight, Dock.heights.lowerBound), Dock.heights.upperBound),
                 columnWidth: min(max(columnWidth, Dock.widths.lowerBound), Dock.widths.upperBound))
    }
}

enum Dock {
    static let height: CGFloat = 145 // the strip's height, until the user sets another
    static let firstWidth: CGFloat = 900
    static let columnWidth: CGFloat = 360 // the column's width, until the user sets another
    static let heights: ClosedRange<CGFloat> = 110...360
    static let widths: ClosedRange<CGFloat> = 300...640

    // A top-left-origin rect (Accessibility, the window list) in AppKit's coordinates, which
    // count up from the bottom of the main screen (the one with the menu bar).
    static func appKit(_ r: CGRect, mainHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: mainHeight - r.maxY, width: r.width, height: r.height)
    }

    // The window's frame for a Teams window (top-left origin), the layout setting and the sizes.
    static func frame(for teams: CGRect, layout: DockLayout, screens: [ScreenArea], mainHeight: CGFloat,
                      size: DockSize = DockSize()) -> CGRect {
        frame(shape(for: teams, layout: layout, screens: screens, mainHeight: mainHeight, size: size),
              teams: teams, screens: screens, mainHeight: mainHeight, size: size)
    }

    static func frame(_ shape: DockShape, teams: CGRect, screens: [ScreenArea], mainHeight: CGFloat,
                      size: DockSize = DockSize()) -> CGRect {
        let s = size.clamped
        switch shape {
        case .below: return frame(under: teams, screens: screens, mainHeight: mainHeight, height: s.stripHeight)
        case .above: return frame(above: teams, screens: screens, mainHeight: mainHeight, height: s.stripHeight)
        case .left: return frame(left: teams, screens: screens, mainHeight: mainHeight, width: s.columnWidth)
        case .right: return frame(right: teams, screens: screens, mainHeight: mainHeight, width: s.columnWidth)
        }
    }

    // A forced side is that side. Automatic: below Teams when its screen's visible frame has the
    // strip's height free there; else the right side, else the left, when the column's width
    // fits; else above, when the strip's height fits; else the right side, inside the visible
    // frame, over Teams. With no screen to measure against, below.
    static func shape(for teams: CGRect, layout: DockLayout, screens: [ScreenArea], mainHeight: CGFloat,
                      size: DockSize = DockSize()) -> DockShape {
        switch layout {
        case .below: return .below
        case .above: return .above
        case .left: return .left
        case .right: return .right
        case .automatic:
            let s = size.clamped
            let t = appKit(teams, mainHeight: mainHeight)
            guard let v = screen(of: t, screens: screens)?.visible else { return .below }
            if t.minY - v.minY >= s.stripHeight { return .below }
            if v.maxX - t.maxX >= s.columnWidth { return .right }
            if t.minX - v.minX >= s.columnWidth { return .left }
            if v.maxY - t.maxY >= s.stripHeight { return .above }
            return .right
        }
    }

    // Below Teams, exactly as wide, its top edge on Teams' bottom edge. With less than its height
    // free there, it sits at the bottom of that screen's visible area instead.
    static func frame(under teams: CGRect, screens: [ScreenArea], mainHeight: CGFloat, height h: CGFloat = height) -> CGRect {
        let t = appKit(teams, mainHeight: mainHeight)
        var y = t.minY - h
        if let screen = screen(of: t, screens: screens), y < screen.visible.minY { y = screen.visible.minY }
        return CGRect(x: t.minX, y: y, width: t.width, height: h)
    }

    // Above Teams, exactly as wide, its bottom edge on Teams' top edge. With less than its height
    // free there, it sits at the top of that screen's visible area instead.
    static func frame(above teams: CGRect, screens: [ScreenArea], mainHeight: CGFloat, height h: CGFloat = height) -> CGRect {
        let t = appKit(teams, mainHeight: mainHeight)
        var y = t.maxY
        if let screen = screen(of: t, screens: screens), y + h > screen.visible.maxY { y = screen.visible.maxY - h }
        return CGRect(x: t.minX, y: y, width: t.width, height: h)
    }

    // Right of Teams, exactly as tall and level with it. With less than its width free there,
    // inside the visible frame at Teams' right edge, over Teams.
    static func frame(right teams: CGRect, screens: [ScreenArea], mainHeight: CGFloat, width w: CGFloat = columnWidth) -> CGRect {
        let t = appKit(teams, mainHeight: mainHeight)
        var x = t.maxX
        if let v = screen(of: t, screens: screens)?.visible, v.maxX - t.maxX < w {
            x = max(v.minX, min(t.maxX, v.maxX) - w)
        }
        return CGRect(x: x, y: t.minY, width: w, height: t.height)
    }

    // Left of Teams, exactly as tall and level with it. With less than its width free there,
    // inside the visible frame at Teams' left edge, over Teams.
    static func frame(left teams: CGRect, screens: [ScreenArea], mainHeight: CGFloat, width w: CGFloat = columnWidth) -> CGRect {
        let t = appKit(teams, mainHeight: mainHeight)
        var x = t.minX - w
        if let v = screen(of: t, screens: screens)?.visible, t.minX - v.minX < w {
            x = min(v.maxX - w, max(t.minX, v.minX))
        }
        return CGRect(x: x, y: t.minY, width: w, height: t.height)
    }

    // A drag of the outer edge by `delta` points (screen coordinates, up and right positive): the
    // new measure, kept inside its limits. Below: the bottom edge goes down to grow; above: the
    // top edge goes up; right: the right edge goes right; left: the left edge goes left.
    static func resized(_ size: DockSize, shape: DockShape, delta: CGPoint) -> DockSize {
        var s = size
        switch shape {
        case .below: s.stripHeight -= delta.y
        case .above: s.stripHeight += delta.y
        case .right: s.columnWidth += delta.x
        case .left: s.columnWidth -= delta.x
        }
        return s.clamped
    }

    // The first launch with Teams closed: the bottom of the main screen, 900 pt wide.
    static func firstFrame(main: ScreenArea, height h: CGFloat = height) -> CGRect {
        let v = main.visible
        let w = min(firstWidth, v.width)
        return CGRect(x: v.midX - w / 2, y: v.minY, width: w, height: h)
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

// Where the strip goes in the stack of windows when it's placed. It rides with Teams: in front of
// everything only while Teams or the strip itself is the front app; with another app in front, just
// above Teams' own window, so whatever covers Teams covers the strip too. Teams' notices (a toast,
// a pop-up, a window moved) come while it sits behind other apps, and must not bring the strip over them.
enum StripOrder: Equatable {
    case keep // stays where it is in the stack
    case front // orderFrontRegardless
    case aboveTeams(CGWindowID) // order(.above, relativeTo:)

    static func decide(raise: Bool, moved: Bool, visible: Bool, front: Bool, teamsID: CGWindowID?) -> StripOrder {
        guard raise || moved || !visible else { return .keep }
        if front { return .front }
        if let teamsID { return .aboveTeams(teamsID) }
        return .keep // no window number to go above: it comes out with Teams instead of over another app
    }
}
