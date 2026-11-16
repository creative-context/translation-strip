<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/demo-dark.gif">
    <img src="docs/demo-light.gif" alt="The strip at work under a simplified chat window, with made-up text and Auto on: in a chat in English, a Spanish message is typed, Return turns it into English and Command-Return sends it; then in a chat in Portuguese, the same steps give Portuguese" width="100%">
  </picture>
</p>

<h1 align="center">Translation Strip</h1>

<p align="center">
  A companion for your Teams:<br>
  write in any language, get English or the chat's language in your own voice, and send it with ⌘⏎.
</p>

<p align="center">
  <b>Version 0.8</b> · macOS 14 or later · For the new Microsoft Teams · Built with Swift and <a href="https://bun.sh">Bun</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.8.1-6FA6E8?labelColor=1A1D21" alt="Version 0.8.1">
  <img src="https://img.shields.io/badge/license-MIT-238551?labelColor=1A1D21" alt="MIT license">
  <img src="https://img.shields.io/badge/macOS-14%2B-8A8F98?labelColor=1A1D21" alt="macOS 14 or later">
  <img src="https://img.shields.io/badge/API_key-not_needed-6FA6E8?labelColor=1A1D21" alt="No API key needed">
</p>

<p align="center">
  <a href="#install"><b>Install</b></a> ·
  <a href="docs/guide.md"><b>Guide</b></a> ·
  <a href="docs/privacy.md"><b>Privacy</b></a> ·
  <a href="CHANGELOG.md"><b>Changelog</b></a>
</p>

Write the message the way it comes out: in Spanish or any other language, mixing languages, or as a rough draft. Press Return and the strip gives you the message in English or the language you chose, in the voice your guide describes. Press ⌘Return and it goes to the chat you have open in Teams, with no copying or pasting.

## Features

- **Your voice, not a word-for-word translation.** It adds nothing you didn't write: no greeting, thanks or closing line on its own.
- **Several languages.** Pick your language in Settings, or turn on Auto to write in the chat's language when it's clear. One voice guide serves them all.
- **Sends where you're looking.** ⌘⏎ puts the translation in the open chat and sends it only if that chat is still the one the strip shows.
- **Your Claude plan, no API key.** A hidden Claude Code session writes the translation, a fresh one for every message.
- **Your linter has the last word.** An error it finds gets fixed once before you see the translation.
- **Out of the way.** It docks on any side of Teams, follows it, and hides when Teams does.

## Examples

Made-up messages, run through the real translator with [the example voice guide](docs/voice-guide-example.md). With your own guide, the wording follows your voice.

| You write | The chat is in | You get |
|---|---|---|
| ¿Puedes revisar el presupuesto antes del jueves? Si hace falta, lo vemos en la llamada. | English | Could you please review the budget before Thursday? If needed, we can go over it on the call. |
| ya subí los cambios, ¿les das un review antes del merge? | English | I've already pushed the changes. Could you please review them before the merge? |
| Le comparto la propuesta actualizada. Quedo atento a sus comentarios. (Formal) | English | I'm sharing the updated proposal with you. I look forward to your comments. |
| Claro, te la mando hoy antes de las 6. | Português, with Auto on | Claro, te mando hoje antes das 6. |
| Sí, nos vemos el martes a las 10. | Français, with Auto on | Oui, on se voit mardi à 10h. |

## Requirements

macOS 14 or later, the new Microsoft Teams, [Bun](https://bun.sh), which runs the app's server, and [Claude Code](https://code.claude.com/docs/en/setup) signed in with a Claude plan that includes it (Pro, Max, Team or Enterprise). To build it yourself, the Xcode Command Line Tools too.

**Status:** 0.x. It reads Teams through Accessibility, so a Teams update can change what it finds.

## Install

1. **Connect Claude.** Install Claude Code in Terminal, then run `claude` once and sign in with your Claude account in the browser. The strip uses that sign-in, so there's no API key to paste.
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```
2. **Install Bun**, which runs the app's server:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```
3. **Install the app.** Download the zip from the [latest release](https://github.com/creative-context/translation-strip/releases/latest), unzip it and move Translation Strip to Applications. Apple hasn't checked it, so the first time macOS won't open it: go to System Settings › Privacy & Security and choose Open Anyway.
4. **Set it up.** Pick your voice guide in Settings (⌘,), and allow Accessibility when the strip asks.

To build it yourself, run `sh app/build.sh --install`. [The guide](docs/guide.md#install) has the details, including Homebrew.

## Use it

- **⏎** translates, **⇧⏎** starts a new line.
- **⌘⏎** sends to the open chat. **⌘K** adjusts the translation with a note. **⌘D** dictates, in the language you set.
- The language beside "To" says what the translation is in. **⌘,** opens Settings.
- **⌃⌥T** brings up the strip from any app.
- The gear picks what ⌘⏎ does, the model, the language to reply in and where the strip sits.

All the keys, the positions and how sending works are in [the guide](docs/guide.md).

## Your voice guide

A Markdown file that says how you sound: your registers, what you never write, and a few examples. Start from [the example](docs/voice-guide-example.md) or [write your own](docs/guide.md#write-your-voice-guide). An optional [voice linter](docs/guide.md#a-voice-linter-optional) checks every reply against it, in any language.

## Privacy

- The app and its server run on your Mac and listen on `127.0.0.1` only.
- What you write, your language settings, the open chat's name and its last message go to Claude through a fresh Claude Code session on your plan, and nowhere else.
- It keeps no message text: only your settings, with your notes per language, and a log of what happened.

The whole list is in [docs/privacy.md](docs/privacy.md).

## Uninstall

1. Quit Translation Strip and delete it from `~/Applications`.
2. Delete `~/.translation-strip` and its preferences: `defaults delete com.creativecontext.TranslationStrip`.
3. Remove it from System Settings › Privacy & Security › Accessibility.

## Develop

```bash
bun test                # the server's tests
bun test/page-check.ts  # every control of the page in WebKit
bun test/settings-check.ts  # every control of Settings in WebKit
sh app/build.sh         # build into build/
```

How it's built and every command: [docs/architecture.md](docs/architecture.md). The rules for changing the code: [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE).

> This is an independent project. It isn't made, endorsed or supported by Anthropic or Microsoft. Claude and Claude Code are trademarks of Anthropic, and Microsoft Teams is a trademark of Microsoft.
