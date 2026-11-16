# Privacy

The app and its server run on your Mac, and the server listens on `127.0.0.1` only. The only thing that leaves your Mac is what the hidden session sends to Claude. The server starts Claude Code's own `claude` command, from your PATH or where Claude Code installs to (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`), with Claude Code's own sign-in.

## What goes to Claude

Through the hidden Claude Code session on your plan:

- What you write, the register and, for Adjust, the current reply and your note.
- Your language settings: the target language, whether Auto is on and, if you wrote any, your notes for each language (the text you typed in Settings). The notes go with every request, and only the ones you filled in.
- For context, the open chat's name, the author of its last message and that message. The session treats it as quoted text and never follows instructions in it. With Auto on, it reads that message to see which language it's in, and nothing more is kept about it.
- Your voice guide's text, as the session's instructions. The app reads it from your file when the session starts and never writes it anywhere: it reaches the session through a pipe in memory. The pipe's name shows in `~/.translation-strip/translator` for an instant and holds nothing.

Every message goes to a fresh session, so none of them sees what you wrote before, to whom, or what they wrote you.

Claude Code adds its own context, as it does in any session, such as details about your Mac and your account's email. The session runs with no tools, no MCP servers, no hooks and none of your settings or memory files, and it keeps no transcript.

## What it reads from Teams

Through Accessibility, about once a second while the strip is on screen: the window's position and size, its title for the chat's name, the message box to spot a draft and check what was pasted, the latest messages in the open chat for context, and, right after a send, whether your message showed up there. It stores none of it.

Teams shows its page to Accessibility only when an app asks, so the strip asks the way a screen reader does: when it finds Teams, and every few seconds while it can't see the message box. Teams keeps its page visible to Accessibility until it quits.

## The clipboard and the microphone

To paste, the app borrows the clipboard for a moment and puts back what was there once Teams has taken the paste, unless you copied something else meanwhile. It marks what it puts there as temporary and private, so clipboard managers that respect those marks don't keep your message.

As you write, the app asks Apple's NaturalLanguage, on your Mac, which language your text is in, and shows the answer in the strip. The text goes nowhere else for this, and the app keeps neither the text nor the answer.

The microphone listens only while you dictate. Apple's dictation model turns what you say into text on your Mac, in the language you chose in Settings (Mexican Spanish unless you pick another), and the audio never leaves it. The first time for each language, macOS downloads that model from Apple.

## What it keeps

In `~/.translation-strip`:

- `settings.json`: the paths of your guide and linter, the model, what ⌘⏎ does, your target language, whether Auto is on, your languages, your notes for each language (the text you typed) and the dictation language. It holds no chat names and no per-chat languages.
- `server.log`: when the server and the translator started, errors, and outcomes such as "send: not sent (mismatch)". It never holds message text or chat names.
- `translator/`: the hidden session's working folder. The app never reads anything back from it.

The app's preferences keep where the strip last sat and where the Settings window was. For the linter, each reply goes to a temporary file that the app deletes right after.

## What it sends on its own

Nothing. The hidden session connects to Anthropic the way Claude Code always does.
