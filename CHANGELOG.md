# Changelog

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
