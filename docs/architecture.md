# How it works

1. The server (`server.ts` and `src/`, Bun) gives each request a fresh Claude Code session with your guide as its instructions, keeping the next one started so replies stay fast. It answers the page one request at a time, runs the linter on each reply, and takes requests only from the app's own page.
2. The page (`public/index.html`, with its state in `public/strip-state.js`) is the strip itself. Its tokens, components and icons come from the family's design system, `mac-app-design`, vendored next to it.
3. The app (`app/`, Swift) holds the window under Teams, sending through Accessibility, reading the open chat, dictation in the chosen language and the shortcut, and opens the Settings window. It runs its own copy of the server and stops it when it quits. Its shared parts come from the family's app kit, `mac-app-kit`.

Settings is a second page, `public/settings.html`, shown in its own window (`app/SettingsWindow.swift`, a web view on the server's `/settings.html`, opened with ⌘,). It reads `/api/state` and its stream and writes `POST /api/settings`; it asks the shell only to open the guide's and the linter's file choosers and to close the window. `src/languages.ts` holds the one list of languages and dictation locales that the server's checks, the translator's protocol, the page and Settings all use.

[`contract.md`](contract.md) is the contract between the server, the page and the shell.

## Develop

```bash
bun test                   # the server's tests and the vendored-files check, port 4811
bun test test/vendored.test.ts  # the vendored files weren't edited
sh test/swift-check.sh     # the docking math, the Teams helpers and the dictation locales (needs the Xcode command line tools)
bun test/page-mock.ts      # the page with canned replies, port 4813
bun test/page-check.ts     # every control of the page in WebKit (needs the page mock and Playwright)
bun test/settings-check.ts # every control of the Settings page in WebKit, with its own stand-in server on port 4824 (needs Playwright)
bun server.ts              # the server on port 4812: in a browser, a preview that sends nothing
sh app/build.sh            # build into build/
sh app/build.sh --install  # build, copy to ~/Applications and open it
```

`bun docs/demo-gif.ts` records `docs/demo-dark.gif` and `docs/demo-light.gif`, one for each GitHub theme, from its own page mock, with made-up text in four chats, with Auto on: Spanish into English, English into Portuguese, a mix of Spanish and English into English, and Icelandic into English (it needs Playwright and ffmpeg).

The tests use a stand-in `claude` and a stand-in linter in temporary folders, so they never touch your data.
