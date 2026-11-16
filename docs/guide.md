# Using Translation Strip

The README has the short version. This is the whole of it.

## Install

### Connect Claude

The strip writes through Claude Code on your own Claude plan (Pro, Max, Team or Enterprise), with Claude Code's own sign-in. There's no API key and no account in the app.

1. Install Claude Code in Terminal with its installer, or with Homebrew:
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```
   ```bash
   brew install --cask claude-code
   ```
2. Run `claude` once and sign in with your Claude account in the browser it opens. Then you can quit it.

The app finds `claude` where these installers put it (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`), even when you open the app from Finder. If it can't, the strip says "Install Claude Code"; once it's installed, Try again starts it. If it says "Sign in to Claude Code", run `claude` in Terminal and sign in again. [Claude Code's setup page](https://code.claude.com/docs/en/setup) has the other ways to install it.

### Download it

1. Download `Translation-Strip-<version>.zip` from the [latest release](https://github.com/creative-context/translation-strip/releases/latest) and unzip it.
2. Move Translation Strip to Applications and open it. Apple hasn't checked the app, so the first time macOS won't open it: go to System Settings › Privacy & Security and choose Open Anyway.
3. Make sure [Bun](https://bun.sh) is installed (`curl -fsSL https://bun.sh/install | bash`, or `brew install oven-sh/bun/bun`): the app runs its server with it.
4. Continue with step 2 below.

A downloaded build is signed ad hoc, so after each update you allow Accessibility again.

### Build it

1. Build the app and install it in `~/Applications`:
   ```bash
   sh app/build.sh --install
   ```
2. Open Settings (⌘, or Settings… in the app menu) and use Choose… beside Guide to pick your guide, a Markdown file that describes how you write ([how to write one](#write-your-voice-guide)). The Linter beside it is optional ([what it does](#a-voice-linter-optional)). While you're there, set [your languages](#languages).
3. Allow Accessibility when the strip asks. The app needs it to put the message in Teams and to see which chat is open.

macOS ties the Accessibility permission to the app's signature. If your keychain has a code-signing identity named "Translation Strip Local Signing", `build.sh` signs with it and the permission stays after a rebuild. Without one, `build.sh` signs ad hoc and you allow each new build again.

## Where the strip sits

The strip docks under the Teams window, as wide as it, and moves with it. When there's no room under Teams, it becomes a column beside Teams, as tall as its window, with the reply on top and what you wrote below. Position in the strip's settings menu (the gear), or Layout in the app menu, picks Automatic or a side: below, above, left or right of Teams. Drag the strip's outer edge to make it taller, or the column's to make it wider, and the app remembers the size. The strip steps out of the way when Teams is minimized, hidden or on another desktop.

## Keys

| Key | What it does |
|---|---|
| ⏎ | Translate |
| ⇧⏎ | New line |
| ⌘⏎ | Send to the open chat |
| ⌘K | Adjust the reply with a note, in any language. Undo puts it back |
| ⌘D | Dictate, in the language chosen in Settings |
| ⌘, | Open Settings |
| Esc | Clear |
| ⌃⌥T | From any app, bring up the strip ready to type |

## The settings menu

Normal and Formal pick the register, as your guide describes them. The settings menu (the gear) sets what ⌘⏎ does (send, or put the message in Teams without sending), picks the model (Haiku, Sonnet or Opus, which runs at low effort), picks the language to reply in ([Reply in](#languages)), sets where the strip sits, opens your guide and restarts the translator. The language, the guide, the linter and dictation are set once in Settings.

## Languages

The strip writes in the language you choose, not only English. You write in any language, in a mix, or as a rough draft: the message box says so.

- **Target.** In Settings, Reply in › Target language is what replies are written in. It starts as English. Your languages come first in the list, then the rest: English, Español, Português, Français, Deutsch, Italiano, Nederlands, Polski, Svenska, Türkçe, 日本語, 한국어 and 中文. Each is named in its own language.
- **Auto.** With Auto on, the reply is in the language of the other person's last message in the open chat, when that's clear. When it isn't (no messages yet, none from them, or a mix of languages), it's in your target. Auto reads only that one message, and nothing about it is kept.
- **Your languages.** A short list in Settings, from one to eight, that feeds the menu's Reply in row. Your target is always on it: choosing a target that isn't there adds it, and you can remove any other. Add a language… opens the rest.
- **Notes per language.** Each language on your list can have a few lines of its own, up to 600 characters, for what your guide can't say for it, such as which form of "you" Formal uses. Notes… opens them in place; they apply only to replies in that language. They're optional, and removing a language removes its notes.
- **Reply in, in the gear.** Auto, then one button per language on your list, with your target pressed. A click changes the setting at once. In a strip narrower than 720 px, Position leaves this menu to make room; it stays in the app menu's Layout.
- **The language button.** Beside "To <chat>" the strip shows the language of the reply on show: `Auto · Português` when Auto chose it, just `English` when it didn't. Point at it for how it was chosen. When the reply isn't in your target, click it once to write the same message in your target instead. That click is for this message only: your settings don't change, the button then names the target, and switching Normal and Formal keeps it until you write something new.
- **Adjust keeps the language.** An adjust, and the linter's one fix, write in the language the reply already has.
- **Dictation.** Settings › Dictation › Dictate in picks the language ⌘D listens in: Español (México), (EE. UU.) or (España), English (US) or (UK), Português (Brasil) or (Portugal), Français, Deutsch or Italiano. It starts as Español (México). If this Mac has no model for the choice, the app tries the other regions of the same language. The first time, macOS downloads the model; the strip says "Getting dictation ready…" meanwhile, and "Dictation in <name> isn't available on this Mac" if there isn't one.

Example: with Auto on and a last message from Priya Raman in Português, a reply to your Spanish comes out in Português and the button reads `Auto · Português`. Click it to get the same message in your target, English by default.

## How it sends

The app brings Teams forward, pastes the reply into the message box, checks that the box holds exactly that text and then presses Return. It never presses a key while Teams isn't in front, and it sends only if Teams still has open the chat the strip shows next to Send. If you switch chats after translating, the strip says "Written for <name>" and won't send until you translate again or go back to that chat. If the box already has a draft, it stops and lets you add the message after it. A quote you're replying to isn't a draft: the message goes under it. If Teams changes the text as it's pasted, for example into a list, the message stays in the box unsent.

To send something as it is, with no translation, type it in the reply box while the strip is empty: it goes to the chat open in Teams, as you wrote it.

## Write your voice guide

The guide is a Markdown file that tells the hidden session how you sound. One guide serves every language. It shapes how the reply sounds, never what it says: the strip adds nothing you didn't write, even where your guide describes greetings or sign-offs for emails. A rule in the guide about one language applies only to replies in that language, so say which language a rule is for (for example "In Português, never …"); a rule that names none applies to all of them. What your guide can't cover for one language goes in that language's [notes](#languages) in Settings. The app only reads the file, and a new session picks up your changes on its own.

1. Create a Markdown file anywhere on your Mac, for example `~/Documents/my-voice.md`. Or copy [`voice-guide-example.md`](voice-guide-example.md) and change it.
2. Say in a sentence or two how you sound. For example: "Warm and to the point. Plain words, short paragraphs, the occasional emoji."
3. Describe your two registers, since the strip has Normal and Formal: how each one sounds and when you use it.
4. List what you never write: words, phrases and punctuation, for example "per my last email", "circle back" or a row of exclamation marks. Before it answers, the strip rereads its reply against this list, in Formal too.
5. Add a few examples of what you write and what should come out, with one or two for each language you'll reply in:

   | You write | It comes out |
   |---|---|
   | ¿Me pasas el reporte cuando puedas? | Could you send me the report when you get a chance? |
   | Perdón, no llego a la de las 3, ¿la movemos? | Sorry, I can't make the 3 o'clock. Can we move it? |
   | ¿Me pasas el reporte cuando puedas? (to a chat in Português) | Você pode me enviar o relatório quando puder? |

6. Note the names and terms that stay as they are: your products, acronyms and people's names.
7. In Settings (⌘,), use Choose… beside Guide and pick the file.

A quick way to start: give Claude a handful of messages you've sent and ask it to draft a guide with these parts. Then read it and fix whatever doesn't sound like you.

## A voice linter (optional)

A linter checks each reply, in any language, against your guide's rules with plain patterns, to catch what slips through. The app runs it as `bun <linter> <file> --todo`, where `<file>` holds the reply, and reads one finding per line:

```
<file>:<line> error [<id>] <message>
<file>:<line> warning [<id>] <message>
```

It exits with 0 when it found no errors and 1 when it did. When it finds an error, the app asks the translator for one fix, in the reply's own language, before you see the reply, and keeps the fix only if it's better. A warning shows above the reply. Pick it in Settings (⌘,), with Choose… beside Linter.
