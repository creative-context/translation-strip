// Draws the app icon at 1024 px in the family's style: a near-black tile with the strip's two
// boxes side by side, the Spanish on a white veil and the English ready in blue, with its Send.
//
//   swift app/make-icon.swift build/icon-1024.png

import AppKit

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"

func hex(_ v: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
            blue: CGFloat(v & 0xFF) / 255, alpha: alpha)
}
let blue: UInt32 = 0x2D72D2

func rr(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat, _ c: NSColor) {
    c.setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: y, width: w, height: h), xRadius: r, yRadius: r).fill()
}

func draw(_ body: () -> Void) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // Tile on the macOS icon grid: 824 px inside the 1024 canvas.
    let tile = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 185, yRadius: 185)
    hex(0x0B0C0E).setFill(); tile.fill()
    hex(0xFFFFFF, 0.08).setStroke(); tile.lineWidth = 4; tile.stroke()
    body()
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
}

// A · The strip: its two boxes side by side, Spanish on a veil, English ready in blue.
draw {
    let y: CGFloat = 352, h: CGFloat = 320, w: CGFloat = 316
    rr(180, y, w, h, 56, hex(0xFFFFFF, 0.10))
    for (i, lw) in [236, 196, 132].enumerated() { rr(220, y + h - 84 - CGFloat(i) * 62, CGFloat(lw), 30, 15, hex(0xFFFFFF, 0.42)) }
    rr(528, y, w, h, 56, hex(blue, 0.30))
    for (i, lw) in [236, 172].enumerated() { rr(568, y + h - 84 - CGFloat(i) * 62, CGFloat(lw), 30, 15, hex(0xFFFFFF, 0.92)) }
    rr(684, y + 36, 120, 50, 25, hex(blue))
}
