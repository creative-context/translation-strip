// Dictation in the language chosen in Settings (the start message's locale, Mexican Spanish when
// it has none), on this Mac only. On macOS 26 and later it uses the system's dictation model
// (DictationTranscriber): the chosen locale first, then the other locales of its language
// (DictationLocales), and asks macOS to download that model the first time. Older systems use
// the Speech recognizer on the Mac, when one is installed. Audio never leaves the Mac, and
// nothing heard is kept or logged.
//
// The microphone is read as Session Monitor reads it: a capture session on the input device,
// not an audio engine. An engine also runs the output device, and with a display or a virtual
// device as the output it either won't start or hears nothing. Two soft notes going up say the
// mic is listening, the same two going down that it stopped; the page passes the settings'
// choice with each start. A dictation stops by itself after 60 s, and after 4 s of no sound
// from the microphone it stops and says so.

import AVFoundation
import AppKit
import Speech

// Which locales to try for a dictation, in order: the chosen one, then the others of the same
// language the app offers (es-MX, es-US, es-ES; en-US, en-GB; pt-BR, pt-PT). A missing or
// malformed id means es-MX, as before 0.8.0. Pure, so the swift check can test it.
enum DictationLocales {
    static let fallback = "es-MX"
    // The ids Settings offers (src/languages.ts, DICTATION), in its order.
    static let known = ["es-MX", "es-US", "es-ES", "en-US", "en-GB", "pt-BR", "pt-PT", "fr-FR", "de-DE", "it-IT"]

    // "es-mx" or "es_MX" read as "es-MX"; anything that isn't a language and a region reads as nil.
    static func normalized(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let parts = raw.trimmingCharacters(in: .whitespaces).split(whereSeparator: { $0 == "-" || $0 == "_" })
        guard parts.count == 2, parts[0].count == 2, parts[1].count == 2,
              parts.allSatisfy({ $0.allSatisfy { $0.isASCII && $0.isLetter } }) else { return nil }
        return parts[0].lowercased() + "-" + parts[1].uppercased()
    }

    static func candidates(_ raw: String?) -> [String] {
        let chosen = normalized(raw) ?? fallback
        let language = chosen.prefix(2)
        return [chosen] + known.filter { $0 != chosen && $0.hasPrefix(language + "-") }
    }

    // The language's name for the log, never anything heard.
    static func language(_ id: String) -> String {
        Locale(identifier: "en").localizedString(forLanguageCode: String(id.prefix(2))) ?? String(id.prefix(2))
    }
}

@MainActor
final class Dictation {
    // state "on" | "off" | "denied" | "preparing" | "unavailable" | "silent" | "failed", and the whole transcript so far.
    var onUpdate: (_ state: String, _ text: String?) -> Void = { _, _ in }
    // While macOS downloads the dictation model: how much is done, from 0 to 1, in whole percents.
    var onProgress: (Double) -> Void = { _ in }
    // While listening, about 10 times a second: the microphone's level, 0 to 1.
    var onLevel: (Double) -> Void = { _ in }
    var log: (String) -> Void = { _ in }
    private var lastPercent = -1

    static let cap: TimeInterval = 60 // a dictation stops by itself after a minute
    static let silentAfter: TimeInterval = 4 // no sound at all for this long, and nothing heard: say so

    private var locales = DictationLocales.candidates(nil) // this dictation's, in order
    private var sounds = true // this dictation's start and stop cues

    // For the page's access message.
    static var microphone: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return SFSpeechRecognizer.authorizationStatus() == .denied || SFSpeechRecognizer.authorizationStatus() == .restricted ? "denied" : "granted"
        case .denied, .restricted: return "denied"
        default: return "unknown"
        }
    }

    private var text = ""
    private var running = false // listening
    private var starting = false // permission, the model's download or the start under way
    private var cancelled = false // stopped while starting
    private var ending = false

    // the microphone
    private var capture: AVCaptureSession?
    private var feeder: AudioFeeder?
    private var run = 0 // each microphone start gets a number; late callbacks from an older one are dropped
    private var lastSound = Date()
    private var level = 0.0
    private var lastLevel = Date.distantPast
    private var capTimer: Timer?
    private var silenceTimer: Timer?
    // For the log only, never words.
    private var buffers = 0, loudest = -160.0, startedAt = Date()

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

    // `locale`: the start message's, from Settings; es-MX when it has none. `sounds`: the cues.
    func start(locale: String? = nil, sounds: Bool = true) {
        guard !running, !starting else { return }
        locales = DictationLocales.candidates(locale)
        self.sounds = sounds
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
        if ending { return } // already stopping: the final words are on their way
        guard running else { return onUpdate("off", nil) }
        stopMic(cue: true)
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

    // MARK: the microphone

    // Starts reading the microphone into `sink`, on the audio queue. nil when it runs, else why not.
    private func startMic(_ sink: @escaping (CMSampleBuffer) -> Void) -> String? {
        guard let device = AVCaptureDevice.default(for: .audio) else { return "no microphone" }
        guard let input = try? AVCaptureDeviceInput(device: device) else { return "no microphone input" }
        let session = AVCaptureSession()
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [ // what the recognizers read best: 16 kHz mono, 16-bit
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsNonInterleaved: false,
        ]
        guard session.canAddInput(input), session.canAddOutput(output) else { return "microphone busy" }
        session.addInput(input)
        session.addOutput(output)
        run += 1
        let mine = run
        let feed = AudioFeeder(sink: sink) { [weak self] db in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.heard(db, run: mine) } }
        }
        output.setSampleBufferDelegate(feed, queue: AudioFeeder.queue)
        capture = session
        feeder = feed
        lastSound = Date()
        level = 0
        buffers = 0; loudest = -160; startedAt = Date()
        AudioFeeder.queue.async { session.startRunning() } // it blocks until the device runs
        silenceTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkSilence(run: mine) }
        }
        capTimer = Timer.scheduledTimer(withTimeInterval: Self.cap, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { if self?.run == mine { self?.stop() } }
        }
        return nil
    }

    // Listening from here on: the start cue, then the page's "on".
    private func listening(_ what: String) {
        starting = false
        running = true
        if sounds { Cue.play(Cue.start) }
        log("dictation: on (\(what), on this Mac)")
        onUpdate("on", "")
    }

    // The level in decibels, many times a second: -50 dB to 0 as 0 to 1, quick to rise, slow to
    // fall, and passed on to the page about 10 times a second.
    private func heard(_ db: Double, run mine: Int) {
        guard mine == run, running, !ending else { return }
        buffers += 1
        loudest = max(loudest, db)
        if db > -90 { lastSound = Date() } // a quiet room still hums; true silence is far below
        level = max(max(0, min(1, (db + 50) / 50)), level * 0.8)
        if Date().timeIntervalSince(lastLevel) >= 0.1 {
            lastLevel = Date()
            onLevel((level * 100).rounded() / 100)
        }
    }

    // A microphone that gives only silence (muted, or macOS holding it back) would leave the
    // strip listening for nothing.
    private func checkSilence(run mine: Int) {
        guard mine == run, running, !ending, text.isEmpty else { return }
        guard Date().timeIntervalSince(lastSound) > Self.silentAfter else { return }
        log("dictation: the microphone gave no sound for \(Int(Self.silentAfter)) s")
        drop("silent")
    }

    // The microphone off; the stop cue when it was listening and you (or the minute) stopped it.
    private func stopMic(cue: Bool) {
        capTimer?.invalidate()
        silenceTimer?.invalidate()
        capTimer = nil
        silenceTimer = nil
        guard let session = capture else { return }
        if running {
            log("dictation: mic off after \(Int(Date().timeIntervalSince(startedAt))) s: \(buffers) audio buffers, loudest \(Int(loudest)) dB, \(text.count) characters")
        }
        capture = nil
        feeder = nil
        run += 1
        if cue, sounds, running { Cue.play(Cue.done) }
        AudioFeeder.queue.async { session.stopRunning() } // after any start still on its way
    }

    // Everything off and nothing kept, then the page hears `state` (silent or failed).
    private func drop(_ state: String) {
        stopMic(cue: false)
        finishInput?()
        finishInput = nil
        resultsTask?.cancel()
        resultsTask = nil
        analyzer = nil
        finishLater?.cancel()
        finishLater = nil
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        running = false
        starting = false
        ending = false
        text = ""
        onUpdate(state, nil)
    }

    // MARK: macOS 26 and later: the system's dictation model

    @available(macOS 26.0, *)
    private func beginDictation() async {
        var found: Locale?
        for id in locales {
            if let l = await DictationTranscriber.supportedLocale(equivalentTo: Locale(identifier: id)) { found = l; break }
        }
        let name = DictationLocales.language(locales[0])
        guard let locale = found else { return unavailable("no \(name) dictation model for this Mac (\(locales.joined(separator: ", ")))") }
        let transcriber = DictationTranscriber(locale: locale, preset: .progressiveShortDictation)
        let id = locale.identifier(.bcp47)
        if !(await DictationTranscriber.installedLocales.contains { $0.identifier(.bcp47) == id }) {
            onUpdate("preparing", nil)
            log("dictation: getting the \(name) model (\(id))")
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
                return unavailable("couldn't get the \(name) model (\((error as NSError).domain) \((error as NSError).code))")
            }
            log("dictation: \(name) model ready (\(id))")
        }
        guard !cancelled else { starting = false; return }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            return unavailable("no audio format for the \(name) model")
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (stream, feed) = AsyncStream<AnalyzerInput>.makeStream()
        do {
            try await analyzer.start(inputSequence: stream)
        } catch {
            return unavailable("the \(name) model didn't start (\((error as NSError).domain) \((error as NSError).code))")
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

        if let why = startMic(Self.converting(to: format, into: feed)) {
            feed.finish()
            resultsTask?.cancel()
            resultsTask = nil
            starting = false
            log("dictation: the microphone didn't start (\(why))")
            return onUpdate("failed", nil)
        }
        self.analyzer = analyzer
        finishInput = { feed.finish() }
        listening(id)
    }

    // The microphone's buffers, converted to the model's format. Runs on the audio queue.
    @available(macOS 26.0, *)
    nonisolated private static func converting(to format: AVAudioFormat, into feed: AsyncStream<AnalyzerInput>.Continuation) -> (CMSampleBuffer) -> Void {
        let box = ConverterBox()
        return { sample in
            guard let pcm = AudioFeeder.pcm(sample) else { return }
            if box.converter == nil || box.from != pcm.format {
                box.converter = AVAudioConverter(from: pcm.format, to: format)
                box.from = pcm.format
            }
            guard let converter = box.converter else { return }
            let capacity = AVAudioFrameCount(Double(pcm.frameLength) * format.sampleRate / pcm.format.sampleRate) + 64
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
                return pcm
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

    // The first recognizer for this dictation's locales that works on this Mac without the network.
    private func pick() -> SFSpeechRecognizer? {
        for id in locales {
            guard let r = SFSpeechRecognizer(locale: Locale(identifier: id)) else { continue }
            if r.supportsOnDeviceRecognition && r.isAvailable { return r }
        }
        return nil
    }

    private func beginRecognizer() {
        guard let r = pick() else {
            return unavailable("no on-device \(DictationLocales.language(locales[0])) recognizer (\(locales.joined(separator: ", "))); add one in Keyboard settings, Dictation")
        }
        recognizer = r
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true // never sends audio anywhere
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        request = req
        if let why = startMic({ sample in req.appendAudioSampleBuffer(sample) }) {
            starting = false
            request = nil
            recognizer = nil
            log("dictation: the microphone didn't start (\(why))")
            return onUpdate("failed", nil)
        }
        text = ""
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
        listening(r.locale.identifier)
    }

    private func finish() {
        guard running else { return }
        finishLater?.cancel()
        finishLater = nil
        stopMic(cue: true) // the recognizer ended on its own: the mic goes off with its cue
        running = false
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        onUpdate("off", text)
    }
}

// Holds a buffer converter between calls on the audio queue, made again if the format changes.
private final class ConverterBox: @unchecked Sendable {
    var converter: AVAudioConverter?
    var from: AVAudioFormat?
}

// The capture session's delegate: each buffer to the recognizer, and its level to the strip.
final class AudioFeeder: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    static let queue = DispatchQueue(label: "dictation.audio")
    let sink: (CMSampleBuffer) -> Void
    let level: (Double) -> Void

    init(sink: @escaping (CMSampleBuffer) -> Void, level: @escaping (Double) -> Void) {
        self.sink = sink
        self.level = level
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        sink(sampleBuffer)
        let db = connection.audioChannels.map { Double($0.averagePowerLevel) }.max() ?? -160
        level(db.isFinite ? db : -160)
    }

    // A captured buffer as a PCM buffer in its own format.
    static func pcm(_ sample: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let desc = CMSampleBufferGetFormatDescription(sample) else { return nil }
        let format = AVAudioFormat(cmAudioFormatDescription: desc)
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
        guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        pcm.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList) == noErr else { return nil }
        return pcm
    }
}

// The dictation's two cues, as in Session Monitor: two soft notes going up (E5, then A5) when
// the mic starts listening, the same two going down when it stops, so you hear when to speak
// and that it took your words. Made here as tones, with no sound files, unless you set your own
// as Session Monitor allows: a file's path in the settings dictationStartSound and dictationStopSound
// (defaults write com.creativecontext.TranslationStrip dictationStartSound ~/Sounds/start.mp3).
@MainActor
enum Cue {
    static let madeStart = tone([(659.3, 0, 0.06), (880, 0.075, 0.11)])
    static let madeDone = tone([(880, 0, 0.06), (659.3, 0.075, 0.11)])
    static var start: NSSound? { own("dictationStartSound") ?? madeStart }
    static var done: NSSound? { own("dictationStopSound") ?? madeDone }

    // Your own sound for a cue, loaded once per file and kept, so it plays to the end.
    private static var loaded: [String: NSSound] = [:]
    private static func own(_ key: String) -> NSSound? {
        guard let set = UserDefaults.standard.string(forKey: key), !set.isEmpty else { return nil }
        let path = (set as NSString).expandingTildeInPath
        if let sound = loaded[path] { return sound }
        guard let sound = NSSound(contentsOfFile: path, byReference: false) else { return nil }
        loaded[path] = sound
        return sound
    }

    static func play(_ sound: NSSound?) {
        guard let sound else { return }
        sound.stop()
        sound.play()
    }

    // Each note: its pitch, when it starts and how fast it fades, a quick rise and a soft
    // overtone. 16-bit mono WAV in memory, about a third of a second, at -12 dB or so.
    static func tone(_ notes: [(Double, Double, Double)]) -> NSSound? {
        NSSound(data: wav(notes))
    }

    nonisolated static func wav(_ notes: [(Double, Double, Double)]) -> Data {
        let rate = 44_100.0
        var samples = [Double](repeating: 0, count: Int(rate * 0.34))
        for (pitch, at, fade) in notes {
            for i in Int(at * rate)..<samples.count {
                let t = Double(i) / rate - at
                let level = min(1, t / 0.005) * exp(-t / fade) * (i > samples.count - 400 ? Double(samples.count - i) / 400 : 1)
                samples[i] += 0.22 * level * (sin(2 * .pi * pitch * t) + 0.16 * sin(4 * .pi * pitch * t))
            }
        }
        var data = Data()
        func put(_ text: String) { data.append(contentsOf: Array(text.utf8)) }
        func put32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func put16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        put("RIFF"); put32(UInt32(36 + samples.count * 2)); put("WAVE")
        put("fmt "); put32(16); put16(1); put16(1); put32(44_100); put32(88_200); put16(2); put16(16)
        put("data"); put32(UInt32(samples.count * 2))
        for v in samples { put16(UInt16(bitPattern: Int16(max(-1, min(1, v)) * 32_767))) }
        return data
    }
}
