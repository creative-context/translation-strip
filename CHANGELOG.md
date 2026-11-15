# Changelog

## 0.7.2

- The README opens with an animation of the strip at work under a simplified chat window: a message typed in Spanish, translated with ⏎ and sent with ⌘⏎. It says what the app is in one line, a companion for your Teams.
- The README has the steps to write your voice guide, with made-up examples, and what a voice linter has to print.

## 0.7.1

- The settings menu has no empty row on top: what ⌘⏎ does is a row of buttons too (Send, Put in Teams), beside Model and Position, each with its label on the left. The menu is narrower and its commands sit level with the first row.
- The README has the family's layout: a centered header with the version and badges, a screenshot of the strip with made-up text, an Overview, and sections for AI assistants and the license.

## 0.7.0

- The strip's settings menu has Position: Auto, ↓, ↑, ← and →, so you can move the strip without the menu bar. The app menu's Layout and this row stay in step.
- The menu's button is a gear, since the menu holds settings. It was ⋯.
- A failed translation shows its notice and Try again in the middle of the English box, where "Sent to" shows.
- Under a narrow Teams window the footers give way in steps instead of overlapping: the shortcut hints first, then Adjust's word (the pencil stays), then the notice's words, then the chat's name. Normal and Formal step aside only while a dictation notice needs the room.
- A translation whose hidden session closes or stalls before answering, or answers in a form the app can't use, gets one more try on a fresh session, after 20 seconds at most instead of 45, so you no longer see "Couldn't translate" for it.
- Opus joins Haiku and Sonnet in the settings menu, at low effort (in tests it wrote as well as at its default or high effort, and as fast). Model and Position share one column, each a row of buttons, so the menu stays as tall as before.
- When your voice linter finds an error in the English, the app asks for one fix before showing it, and keeps the fix only if it's better. Warnings still just show.
- In a strip dragged shorter than 140 pt, the settings menu opens beside the gear instead of past the top edge.
- Before it answers, the translator rereads its English against everything your guide says never to write, in the formal register too, and keeps your words where they point at something ("that", "the minimum") instead of swapping in a number or name from the chat.

## 0.6.0

- The strip goes on any side of Teams: Layout in the app menu has Automatic, Below Teams, Above Teams, Left of Teams and Right of Teams. Automatic tries below, then right, then left, then above.
- Drag the strip's outer edge to set its height, from 110 to 360 pt, or the column's to set its width, from 300 to 640 pt. The side next to Teams holds still, and the app remembers the size.

## 0.5.2

- With two message boxes in Teams, as in a channel with a reply open, the strip sends to the one with Teams' cursor. If neither has it, the strip says "Click the box in Teams first" and pastes nothing, so a reply never lands as a new post.

## 0.5.1

- Fix: when Teams takes a moment to build a view, as it does when a channel opens, the strip no longer stays on "Can't find Teams' message box". It looks again every second until the box is there. Channels live in Teams' Chat view, so the strip sends to them like any chat.

## 0.5.0

- A column beside Teams for when there's no room under it: as tall as Teams' window, on its right edge or else its left, with the English on top and your Spanish below. Layout in the app menu picks Automatic, Under Teams or Beside Teams.
- A translation out of date, or one written for another chat, now shows in red like an error, since Send stays off until you translate again.
- If Teams takes the paste late, your clipboard can no longer end up in its message box: the app keeps the English on the clipboard a few seconds more and puts yours back after.
- The app checks which process really listens on its port before it sends, instead of asking the server, so a slow server no longer reads as someone else's.
- Shorter notices: "Teams didn't take it. Not sent" and "Not the app's own page. Not sent".

## 0.4.0

- Every message goes to a fresh Claude Code session, so none of them sees what you wrote before, to whom, or what they wrote you. The next session is always started ahead, and replies stay as fast as before.
- If you switch chats after translating, the strip says "Written for <name>" and Send stays off until you translate again or go back to that chat.
- The clipboard comes back only once Teams has taken the paste, and only if you didn't copy something else meanwhile. If Teams never takes it, the strip says "Teams didn't take the text. Nothing sent".
- When Claude Code needs you, the strip says so: "Sign in to Claude Code" or "Claude Code needs an update". The translator stops after 5 restarts in 10 minutes instead of retrying forever, and starts fresh after the Mac sleeps.
- The local server takes requests only from the app's own page, and the app sends only for its own server. Run by hand, the server uses port 4812.
- The app reads Teams in the background, so the strip doesn't freeze when Teams does, and if Teams changes its layout the strip says "Can't find Teams' message box".
- The strip docks under Teams' main window, not under a chat popped out of it, and only a chat view counts as a chat.
- The voice guide and linter paths go through the server, the only one that writes the settings file.
- Tests: the page's state has its own tests, the vendored kit and design files are checked against their manifests, and a Swift check covers the docking and reading Teams.

## 0.3.0

- ⌘⏎ sends only to the chat shown next to Send. If Teams switched to another chat, nothing is pasted and the strip says "Chat changed. Not sent".
- The clipboard the app borrows to paste is marked temporary and private, so clipboard managers that respect those marks don't keep your messages.
- The translation keeps @mentions, names, links, email addresses, emoji, code, numbers and line breaks exactly as you wrote them.
- An app icon: the strip's two boxes side by side, the Spanish on a veil and the English ready in blue.
- Both rows of controls line up, and Send no longer moves when Adjust opens. Each box fits four whole lines.
- Translate is a button that's always there, at the end of the Spanish row, so the mic stays put. ⋯ comes last, after Send.
- A send that fails turns the English box red. Send is the retry, so the notices no longer add their own Try again, and the chat's name stays readable beside them.
- The shortcuts on Send and Adjust read clearly, and you can see which box has the keyboard.
- In the ⋯ menu, Open voice guide and Restart translator no longer look disabled, and the first column is titled "On ⌘⏎".
- After a send, the English box says "Sent to <chat> · <time>" in its middle, where the English was, instead of a small tag at the bottom.
- A notice stays whole beside a long chat name: the name gives way first and shows in full on hover. The draft notice now says "Teams has a draft".
- More room between the text and the controls, Adjust set apart from "To <chat>" and Send, filled buttons for Undo and Cancel, three control heights, and the menu's column titles lined up with their items.
- While listening, the strip shows a still dot instead of moving bars.
- The first-run notice sits on a veil the size of the two boxes.
- The first time you dictate, the strip shows how far along macOS is with its Spanish model.

## 0.2.1

- Fix: the mic did nothing when the Mac had no Spanish recognizer installed. On macOS 26 and later, dictation now uses the system's dictation model in Mexican Spanish, and the first time macOS downloads it while the strip says "Getting Spanish dictation ready…". If there's no Spanish model, the strip says "Spanish dictation isn't available on this Mac".
- The strip is back on the family's near-black background, the same as Session Monitor's window, with the boxes as veils on it.

## 0.2.0

- The strip is now a Mac app. It docks under the Teams window, as wide as it, and moves with it, and it steps out of the way when Teams is minimized, hidden or on another desktop.
- ⌘⏎ puts the English in the chat open in Teams and sends it. The app brings Teams forward, checks that the box holds exactly that text before it presses Return, never deletes a draft and puts your clipboard back after pasting. If Teams changes the text, the message stays in the box unsent.
- The translation gets the open chat's name and the other person's last message as context.
- Dictation in Spanish with ⌘D or the mic, on your Mac.
- ⌃⌥T brings up the strip from any app.
- Choose Voice Guide… and Choose Voice Linter… in the app menu.
- The translation adds nothing you didn't write: no greeting, name, "yes", thanks or closing line.
- The strip has a new layout: the Spanish side holds Normal and Formal, the mic and Translate, and the English side holds Adjust, the ⋯ menu, the chat's name and Send. The boxes stand apart by tone with no lines, and the English side lifts once there's English.
- `build.sh` signs with a local identity when the keychain has one, so the Accessibility permission stays after a rebuild.

## 0.1.0

- The server and the strip's page: you write in Spanish, press Return and get English in your voice from a hidden Claude Code session on your plan, with Adjust and Undo, Normal and Formal, and your linter on every reply.
- In a browser the page is a preview: it shows a made-up chat and sends nothing.
