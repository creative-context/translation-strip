# Using Translation Strip

The README has the short version. This is the whole of it.

## Install

### Download it

1. Download `Translation-Strip-<version>.zip` from the [latest release](https://github.com/creative-context/translation-strip/releases/latest) and unzip it.
2. Move Translation Strip to Applications and open it. Apple hasn't checked the app, so the first time macOS won't open it: go to System Settings › Privacy & Security and choose Open Anyway.
3. Make sure [Bun](https://bun.sh) is installed: the app runs its server with it.
4. Continue with step 2 below.

A downloaded build is signed ad hoc, so after each update you allow Accessibility again.

### Build it

1. Build the app and install it in `~/Applications`:
   ```bash
   sh app/build.sh --install
   ```
2. From the app menu, use Choose Voice Guide… to pick your guide, a Markdown file that describes how you write ([how to write one](#write-your-voice-guide)). Choose Voice Linter… is optional ([what it does](#a-voice-linter-optional)).
3. Allow Accessibility when the strip asks. The app needs it to put the message in Teams and to see which chat is open.

macOS ties the Accessibility permission to the app's signature. If your keychain has a code-signing identity named "Translation Strip Local Signing", `build.sh` signs with it and the permission stays after a rebuild. Without one, `build.sh` signs ad hoc and you allow each new build again.

## Where the strip sits

The strip docks under the Teams window, as wide as it, and moves with it. When there's no room under Teams, it becomes a column beside Teams, as tall as its window, with the English on top and your Spanish below. Position in the strip's settings menu (the gear), or Layout in the app menu, picks Automatic or a side: below, above, left or right of Teams. Drag the strip's outer edge to make it taller, or the column's to make it wider, and the app remembers the size. The strip steps out of the way when Teams is minimized, hidden or on another desktop.

## Keys

| Key | What it does |
|---|---|
| ⏎ | Translate |
| ⇧⏎ | New line |
| ⌘⏎ | Send to the open chat |
| ⌘K | Adjust the English with a note, in Spanish or English. Undo puts it back |
| ⌘D | Dictate in Spanish |
| Esc | Clear |
| ⌃⌥T | From any app, bring up the strip ready to type |

## The settings menu

Normal and Formal pick the register, as your guide describes them. The settings menu (the gear) sets what ⌘⏎ does (send, or put the message in Teams without sending), picks the model (Haiku, Sonnet or Opus, which runs at low effort), opens your guide and restarts the translator.

## How it sends

The app brings Teams forward, pastes the English into the message box, checks that the box holds exactly that text and then presses Return. It never presses a key while Teams isn't in front, and it sends only if Teams still has open the chat the strip shows next to Send. If you switch chats after translating, the strip says "Written for <name>" and won't send until you translate again or go back to that chat. If the box already has a draft, it stops and lets you add the message after it. If Teams changes the text as it's pasted, for example into a list, the message stays in the box unsent.

## Write your voice guide

The guide is a Markdown file that tells the hidden session how you sound in English. It shapes how the English sounds, never what it says: the strip adds nothing you didn't write, even where your guide describes greetings or sign-offs for emails. The app only reads the file, and a new session picks up your changes on its own.

1. Create a Markdown file anywhere on your Mac, for example `~/Documents/my-voice.md`. Or copy [`voice-guide-example.md`](voice-guide-example.md) and change it.
2. Say in a sentence or two how you sound. For example: "Warm and to the point. Plain words, short paragraphs, the occasional emoji."
3. Describe your two registers, since the strip has Normal and Formal: how each one sounds and when you use it.
4. List what you never write: words, phrases and punctuation, for example "per my last email", "circle back" or a row of exclamation marks. Before it answers, the strip rereads its English against this list, in Formal too.
5. Add a few examples of what you write and what should come out:

   | You write | It comes out |
   |---|---|
   | ¿Me pasas el reporte cuando puedas? | Could you send me the report when you get a chance? |
   | Perdón, no llego a la de las 3, ¿la movemos? | Sorry, I can't make the 3 o'clock. Can we move it? |

6. Note the names and terms that stay as they are: your products, acronyms and people's names.
7. From the app menu, use Choose Voice Guide… and pick the file.

A quick way to start: give Claude a handful of messages you've sent in English and ask it to draft a guide with these parts. Then read it and fix whatever doesn't sound like you.

## A voice linter (optional)

A linter checks each reply against your guide's rules with plain patterns, to catch what slips through. The app runs it as `bun <linter> <file> --todo`, where `<file>` holds the English, and reads one finding per line:

```
<file>:<line> error [<id>] <message>
<file>:<line> warning [<id>] <message>
```

It exits with 0 when it found no errors and 1 when it did. When it finds an error, the app asks the translator for one fix before you see the English, and keeps the fix only if it's better. A warning shows above the English. Pick it with Choose Voice Linter… in the app menu.
