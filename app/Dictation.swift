// Dictation in Spanish, on this Mac only: the Speech framework with on-device recognition
// (es-MX, else es-US, else es-ES), fed from the microphone. Audio never leaves the Mac, and
// nothing heard is kept or logged.

import AVFoundation
import AppKit
import Speech

@MainActor
final class Dictation {
    // state "on" | "off" | "denied", and the whole transcript so far.
    var onUpdate: (_ state: String, _ text: String?) -> Void = { _, _ in }
    var log: (String) -> Void = { _ in }

    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var text = ""
    private var running = false
    private var tapped = false
    private var finishLater: DispatchWorkItem?

    static let locales = ["es-MX", "es-US", "es-ES"]

    // For the page's access message.
    static var microphone: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return SFSpeechRecognizer.authorizationStatus() == .denied || SFSpeechRecognizer.authorizationStatus() == .restricted ? "denied" : "granted"
        case .denied, .restricted: return "denied"
        default: return "unknown"
        }
    }

    func start() {
        guard !running else { return }
        authorize { ok in
            guard ok else { return self.onUpdate("denied", nil) }
            self.begin()
        }
    }

    func stop() {
        guard running else { return onUpdate("off", nil) }
        stopAudio()
        request?.endAudio()
        // The final result usually comes at once; don't wait for it forever.
        let item = DispatchWorkItem { [weak self] in self?.finish() }
        finishLater = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: item)
    }

    // The microphone, then speech recognition, asking for each the first time.
    private func authorize(_ done: @escaping @MainActor (Bool) -> Void) {
        let speech = {
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized: done(true)
            case .notDetermined:
                SFSpeechRecognizer.requestAuthorization { status in
                    DispatchQueue.main.async { done(status == .authorized) }
                }
            default: done(false)
            }
        }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: speech()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async { granted ? speech() : done(false) }
            }
        default: done(false)
        }
    }

    // The first Spanish recognizer that works on this Mac without the network.
    private func pick() -> SFSpeechRecognizer? {
        for id in Self.locales {
            guard let r = SFSpeechRecognizer(locale: Locale(identifier: id)) else { continue }
            if r.supportsOnDeviceRecognition && r.isAvailable { return r }
        }
        return nil
    }

    private func begin() {
        guard let r = pick() else {
            log("dictation: no on-device Spanish recognizer (\(Self.locales.joined(separator: ", "))); add one in Keyboard settings, Dictation")
            return onUpdate("off", nil)
        }
        recognizer = r
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true // never sends audio anywhere
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        request = req

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            log("dictation: no microphone input")
            return onUpdate("off", nil)
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
        tapped = true
        engine.prepare()
        do {
            try engine.start()
        } catch {
            log("dictation: the microphone didn't start (\((error as NSError).domain) \((error as NSError).code))")
            stopAudio()
            return onUpdate("off", nil)
        }
        text = ""
        running = true
        task = r.recognitionTask(with: req) { [weak self] result, error in
            let words = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let failed = error.map { ($0 as NSError).domain + " " + String(($0 as NSError).code) }
            DispatchQueue.main.async {
                guard let self, self.running else { return }
                if let words { self.text = words }
                if final || failed != nil {
                    if let failed, words == nil { self.log("dictation: recognition ended (\(failed))") }
                    self.finish()
                } else if words != nil {
                    self.onUpdate("on", self.text)
                }
            }
        }
        log("dictation: on (\(r.locale.identifier), on this Mac)")
        onUpdate("on", "")
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
    }

    private func finish() {
        guard running else { return }
        running = false
        finishLater?.cancel()
        finishLater = nil
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        onUpdate("off", text)
    }
}
