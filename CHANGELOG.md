# Changelog

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
