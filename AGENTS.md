# Instructions for AI agents working on this repository

This is **Translation Strip** (working name): a Mac app that sits in the gap under the Teams window. The user writes a message in Spanish (or mixed, or rough English), presses ⏎, and gets English ready to send, polished in their own voice: the meaning, never a literal translation. ⌘⏎ sends it to the chat open in Teams. Everything runs on the user's Mac; the polishing is done by a hidden Claude Code session on the user's own Claude plan.

## Layout

- `src/server-kit.ts`, `app/ShellKit.swift` and `kit.json`: the server's life and the shell's shared parts, vendored from the family's `mac-app-kit` (`bun ../mac-app-kit/tools/vendor.ts .`). Never edit them.
- `public/design-*.css`, `public/design-icons.js` and `public/design.json`: the family's design system, vendored from `mac-app-design` (`bun ../mac-app-design/tools/vendor.ts public`). Never edit them. A new token, component or icon goes into `mac-app-design` first.
- `server.ts` and `src/`: the Bun server. It keeps the hidden translator session alive, answers the page's requests and runs the voice linter. `docs/contract.md` is the contract between the server, the page and the native shell. `docs/guide.md` is the user's manual, `docs/privacy.md` the whole privacy contract and `docs/architecture.md` how it's built and every command. `docs/demo-gif.ts` records the README's `docs/demo.gif`: a simplified chat window (a generic chat, not any real app's look) with the strip docked under it, made-up text, typed, translated and sent. It needs the page mock, Playwright and ffmpeg; record it again when the strip's look changes.
- `public/index.html`: the strip's page: its layout, the DOM, the events and the bridge. `public/strip-state.js`: the page's state, its transitions and what it shows, as plain functions with no DOM.
- `app/`: the native shell (Swift): the window docked under Teams, sending to Teams through Accessibility, dictation, the global shortcut.
- `test/`: tests with a stand-in `claude` command and a stand-in linter, in temp folders. `server.test.ts` also runs servers with a short timeout and their own clock (`STRIP_TIMEOUT_MS`, `STRIP_DAY_FILE`, `STRIP_CLOCK_FILE`, which only tests set). `state.test.ts` tests the page's state in `public/strip-state.js` with tables of cases. `swift-check.swift` checks `app/Dock.swift` and `app/Teams.swift`.

## Commands

```bash
bun test                   # the server and the vendored-files check, port 4811
bun test test/vendored.test.ts  # the kit's and the design system's files weren't edited
sh test/swift-check.sh     # the docking math and the Teams helpers, with made-up frames (needs swiftc)
bun test/page-mock.ts      # port 4813, the page with canned replies and a stand-in Teams
bun test/page-check.ts     # every control of the page in WebKit, with the page mock running
bun server.ts              # port 4812 (the app runs its own on 4810)
sh app/build.sh --install  # build, copy to ~/Applications, reopen
```

## Rules

- **Polish, never translate word for word, and add nothing.** The user's text sets what the message says: no greeting, name, "yes", thanks, sign-off or extra line they didn't write (the rule and its check live in `src/protocol.ts`). The translator follows the user's voice guide for how it sounds, read at runtime from the path in the local settings. The app keeps no tone rules of its own and never copies the guide's content into any file, log or test. A tone change goes into the guide.
- **Privacy is a contract.** Read and send only what `docs/privacy.md` lists, and update it with any new read. The other person's last message is read from the Teams window for context, sent to the translator as quoted data, and never stored. Logs never hold message text. Tests never touch the user's data: they point `STRIP_DIR` and `STRIP_CLAUDE` at temp folders and stand-ins.
- **The README stays short,** like a normal Mac app README: the name and one line, the animation, short feature bullets, requirements, install, a few lines of use, privacy in three points, uninstall, develop, license. New features and how-tos go to `docs/guide.md`, every read and every thing kept to `docs/privacy.md`, the architecture and commands to `docs/architecture.md`; the README links them and never repeats them.
- **One network path, and it isn't ours:** the hidden Claude Code session connects as Claude Code always does. The app sends nothing of its own.
- **Sending is guarded.** The shell never posts a key unless Teams is the front app, never sends if the message box doesn't hold exactly the text the user saw, and never deletes a draft that was already there.
- **No personal data in the repo.** Made-up chats and messages only, no home paths, no names of real people or projects. Teams and Outlook are named only where the app has to find them.
- **Interface copy in American English, plain and short:** no questions, no tone, nothing that repeats what a control already says. Sentence case. Text reaches 4.5:1 on its surface; Reduce Motion keeps only color fades.
- **The server ends with its app and survives its own errors.** It exits when `STRIP_PARENT_PID` is gone and with code 3 when the port is taken. Wrap new timers in `safe()`.

## Releasing

1. Bump `CFBundleShortVersionString` and `CFBundleVersion` in `app/Info.plist`, `package.json`, the README's version badge, and add a `## x.y.z` section to `CHANGELOG.md`.
2. Commit and push (the privacy scan runs on both).
3. Publish the release on that commit, with its CHANGELOG section as the notes: `gh release create vx.y.z --target <commit> --title vx.y.z --notes-file <notes>`.
4. The Release workflow (`.github/workflows/release.yml`) tests it on macOS, checks that `Info.plist` matches the tag, builds the universal app signed ad hoc and attaches `Translation-Strip-x.y.z.zip`. Check that the zip is on the release.
5. Never move or delete a published tag. A fix is a new patch version.
