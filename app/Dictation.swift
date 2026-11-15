// Dictation in Spanish, on this Mac only. On macOS 26 and later it uses the system's dictation
// model (DictationTranscriber), Mexican Spanish first, then US and Spain Spanish, and asks
// macOS to download that model the first time. Older systems use the Speech recognizer on the
// Mac, when one is installed. Audio never leaves the Mac, and nothing heard is kept or logged.

import AVFoundation
import AppKit
import Speech

@MainActor
final class Dictation {
    // state "on" | "off" | "denied" | "preparing" | "unavailable", and the whole transcript so far.
    var onUpdate: (_ state: String, _ text: String?) -> Void = { _, _ in }
    // While macOS downloads the Spanish model: how much is done, from 0 to 1, in whole percents.
    var onProgress: (Double) -> Void = { _ in }
    var log: (String) -> Void = { _ in }
    private var lastPercent = -1

    static let locales = ["es-MX", "es-US", "es-ES"]

    // For the page's access message.
    static var microphone: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return SFSpeechRecognizer.authorizationStatus() == .denied || SFSpeechRecognizer.authorizationStatus() == .restricted ? "denied" : "granted"
        case .denied, .restricted: return "denied"
        default: return "unknown"
        }
    }

    private let engine = AVAudioEngine()
    private var text = ""
    private var running = false // listening
    private var starting = false // permission, the model's download or the start under way
    private var cancelled = false // stopped while starting
    private var ending = false
    private var tapped = false

    // macOS 26 and later
    private var analyzer: AnyObject? // SpeechAnalyzer
    private var finishInput: (() -> Void)?
    private var resultsTask: Task<Void, Never>?
    private var finalized = ""

    // older systems
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finishLater: DispatchWorkItem?

    func start() {
        guard !running, !starting else { return }
        starting = true
        cancelled = false
        authorize { ok in
            guard ok else {
                self.starting = false
                return self.onUpdate("denied", nil)
            }
            if #available(macOS 26.0, *) {
                Task { await self.beginDictation() }
            } else {
                self.beginRecognizer()
            }
        }
    }

    func stop() {
        if starting { // still getting the model or starting: listen to nothing
            cancelled = true
            starting = false
            return onUpdate("off", nil)
        }
        guard running else { return onUpdate("off", nil) }
        stopAudio()
        if finishInput != nil { return endDictation() }
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

    private func report(_ fraction: Double) {
        guard starting, !cancelled, fraction.isFinite else { return }
        let percent = min(99, max(0, Int(fraction * 100)))
        guard percent != lastPercent else { return }
        lastPercent = percent
        onProgress(Double(percent) / 100)
    }

    private func unavailable(_ why: String) {
        starting = false
        log("dictation: \(why)")
        onUpdate("unavailable", nil)
    }

    // MARK: macOS 26 and later: the system's dictation model

    @available(macOS 26.0, *)
    private func beginDictation() async {
        var found: Locale?
        for id in Self.locales {
            if let l = await DictationTranscriber.supportedLocale(equivalentTo: Locale(identifier: id)) { found = l; break }
        }
        guard let locale = found else { return unavailable("no Spanish dictation model for this Mac") }
        let transcriber = DictationTranscriber(locale: locale, preset: .progressiveShortDictation)
        let id = locale.identifier(.bcp47)
        if !(await DictationTranscriber.installedLocales.contains { $0.identifier(.bcp47) == id }) {
            onUpdate("preparing", nil)
            log("dictation: getting the Spanish model (\(id))")
            do {
                if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    // The download's progress, read twice a second and sent when the whole percent changes.
                    let progress = install.progress
                    lastPercent = -1
                    let watch = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                        MainActor.assumeIsolated { self?.report(progress.fractionCompleted) }
                    }
                    defer { watch.invalidate() }
                    try await install.downloadAndInstall()
                }
            } catch {
                return unavailable("couldn't get the Spanish model (\((error as NSError).domain) \((error as NSError).code))")
            }
            log("dictation: Spanish model ready")
        }
        guard !cancelled else { starting = false; return }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            return unavailable("no audio format for the Spanish model")
        }

        let input = engine.inputNode
        let mic = input.outputFormat(forBus: 0)
        guard mic.sampleRate > 0, mic.channelCount > 0, let converter = AVAudioConverter(from: mic, to: format) else {
            starting = false
            log("dictation: no microphone input")
            return onUpdate("off", nil)
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (stream, feed) = AsyncStream<AnalyzerInput>.makeStream()
        do {
            try await analyzer.start(inputSequence: stream)
        } catch {
            return unavailable("the Spanish model didn't start (\((error as NSError).domain) \((error as NSError).code))")
        }
        guard !cancelled else {
            feed.finish()
            starting = false
            return
        }

        text = ""
        finalized = ""
        resultsTask = Task { @MainActor [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self else { return }
                    let words = String(result.text.characters)
                    if result.isFinal {
                        self.finalized += words
                        self.text = self.finalized
                    } else {
                        self.text = self.finalized + words
                    }
                    if self.running { self.onUpdate("on", self.text) }
                }
            } catch {
                self?.log("dictation: recognition ended (\((error as NSError).domain) \((error as NSError).code))")
            }
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: mic, block: Self.converting(converter, to: format, from: mic, into: feed))
        tapped = true
        engine.prepare()
        do {
            try engine.start()
        } catch {
            stopAudio()
            feed.finish()
            resultsTask?.cancel()
            resultsTask = nil
            starting = false
            log("dictation: the microphone didn't start (\((error as NSError).domain) \((error as NSError).code))")
            return onUpdate("off", nil)
        }
        self.analyzer = analyzer
        finishInput = { feed.finish() }
        starting = false
        running = true
        log("dictation: on (\(id), on this Mac)")
        onUpdate("on", "")
    }

    // The microphone's buffers, converted to the model's format. Runs on the audio thread.
    @available(macOS 26.0, *)
    nonisolated private static func converting(_ converter: AVAudioConverter, to format: AVAudioFormat, from mic: AVAudioFormat,
                                               into feed: AsyncStream<AnalyzerInput>.Continuation) -> AVAudioNodeTapBlock {
        return { buffer, _ in
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / mic.sampleRate) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
            var given = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if given {
                    status.pointee = .noDataNow
                    return nil
                }
                given = true
                status.pointee = .haveData
                return buffer
            }
            if error == nil, out.frameLength > 0 { feed.yield(AnalyzerInput(buffer: out)) }
        }
    }

    // Stop listening, let the model finish what it heard, and send the final text, waiting
    // at most 1.4 s (the page waits 1.8 s).
    private func endDictation() {
        finishInput?()
        finishInput = nil
        ending = true
        let model = analyzer
        Task { @MainActor in
            if #available(macOS 26.0, *), let a = model as? SpeechAnalyzer { try? await a.finalizeAndFinishThroughEndOfInput() }
            await self.resultsTask?.value
            self.endedDictation()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { self.endedDictation() }
    }

    private func endedDictation() {
        guard ending else { return }
        ending = false
        running = false
        resultsTask?.cancel()
        resultsTask = nil
        analyzer = nil
        onUpdate("off", text)
    }

    // MARK: older systems: the Speech recognizer on the Mac

    // The first Spanish recognizer that works on this Mac without the network.
    private func pick() -> SFSpeechRecognizer? {
        for id in Self.locales {
            guard let r = SFSpeechRecognizer(locale: Locale(identifier: id)) else { continue }
            if r.supportsOnDeviceRecognition && r.isAvailable { return r }
        }
        return nil
    }

    private func beginRecognizer() {
        guard let r = pick() else {
            return unavailable("no on-device Spanish recognizer (\(Self.locales.joined(separator: ", "))); add one in Keyboard settings, Dictation")
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
            starting = false
            log("dictation: no microphone input")
            return onUpdate("off", nil)
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.appending(to: req))
        tapped = true
        engine.prepare()
        do {
            try engine.start()
        } catch {
            starting = false
            log("dictation: the microphone didn't start (\((error as NSError).domain) \((error as NSError).code))")
            stopAudio()
            return onUpdate("off", nil)
        }
        text = ""
        starting = false
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

    nonisolated private static func appending(to request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        return { buffer, _ in request.append(buffer) }
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

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
    }
}
