#!/bin/sh
# Builds "Translation Strip.app" into build/. The app carries its own copy of the server and
# the page, so it runs from anywhere. Needs only the Xcode command line tools (swiftc) and Bun.
#
#   sh app/build.sh            build
#   sh app/build.sh --install  build, copy to ~/Applications and open it
#
# Signing: with a code-signing identity named "Translation Strip Local Signing" in the keychain
# (a self-signed certificate made on this Mac), the Accessibility grant survives rebuilds.
# Without one the app is signed ad hoc, and each rebuild has to be allowed again in System
# Settings, Privacy & Security, Accessibility.

set -e
cd "$(dirname "$0")/.."
NAME="Translation Strip"
APP="build/$NAME.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Universal: one build for Apple silicon and one for Intel, joined with lipo.
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos14.0" \
    -framework AppKit -framework WebKit -framework Carbon -framework Speech -framework AVFoundation \
    app/main.swift app/Teams.swift app/Dock.swift app/Send.swift app/Dictation.swift app/Hotkey.swift app/ShellKit.swift \
    -o "build/TranslationStrip-$arch"
done
lipo -create build/TranslationStrip-arm64 build/TranslationStrip-x86_64 \
  -output "$APP/Contents/MacOS/TranslationStrip"

cp app/Info.plist "$APP/Contents/Info.plist"

# The server, bundled into one server.js, in Resources/server. Bundled, it finds the page one
# folder up (src/config.ts: the folder above its own, then public/), so public/ goes in Resources.
SERVER="$APP/Contents/Resources/server"
mkdir -p "$SERVER"
bun build server.ts --target=bun --outfile "$SERVER/server.js" >/dev/null
cp -R public "$APP/Contents/Resources/"

# Signed with a local identity when the keychain has one, so macOS sees every build as the same
# app and the Accessibility grant survives a rebuild. Otherwise ad hoc, and each build has to be
# allowed again.
IDENTITY="Translation Strip Local Signing"
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
  codesign --force --sign "$IDENTITY" "$APP" >/dev/null 2>&1
else
  codesign --force --sign - "$APP" >/dev/null
fi
echo "Built $APP"

if [ "$1" = "--install" ]; then
  DEST="$HOME/Applications/$NAME.app"
  # Quit the running copy and wait until it is really gone; opening it again too
  # soon fails while macOS still has the old one registered.
  osascript -e "tell application \"$NAME\" to quit" >/dev/null 2>&1 || true
  i=0
  while pgrep -f 'TranslationStrip$' >/dev/null && [ $i -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
  sleep 1
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  echo "Installed $DEST"
  i=0
  until open "$DEST" 2>/dev/null || [ $i -ge 5 ]; do sleep 1; i=$((i + 1)); done
  echo "Opened $NAME"
fi
