// The global shortcut that brings the strip forward and focuses the Spanish field:
// Control-Option-T, through Carbon's RegisterEventHotKey (no Accessibility needed).

import AppKit
import Carbon.HIToolbox

@MainActor
final class GlobalShortcut {
    static let keyCode = UInt32(kVK_ANSI_T)
    static let modifiers = UInt32(controlKey | optionKey)
    static let words = "Control-Option-T"
    static let signature: OSType = 0x5453_5452 // "TSTR"

    nonisolated(unsafe) static var pressed: (@MainActor () -> Void)?
    private var ref: EventHotKeyRef?

    init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var id = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard status == noErr, id.signature == GlobalShortcut.signature else { return OSStatus(eventNotHandledErr) }
            DispatchQueue.main.async { MainActor.assumeIsolated { GlobalShortcut.pressed?() } }
            return noErr
        }, 1, &spec, nil, nil)
    }

    // nil when it worked, else why not, in plain words.
    func register() -> String? {
        guard ref == nil else { return nil }
        var newRef: EventHotKeyRef?
        let status = RegisterEventHotKey(Self.keyCode, Self.modifiers, EventHotKeyID(signature: Self.signature, id: 1),
                                         GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &newRef)
        guard status == noErr, let newRef else {
            return status == OSStatus(eventHotKeyExistsErr) ? "\(Self.words) is used by another app" : "\(Self.words) couldn't be used (\(status))"
        }
        ref = newRef
        return nil
    }
}
