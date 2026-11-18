#!/bin/sh
# Compiles test/swift-check.swift with the shell's docking math, strip and column (Dock.swift), Teams helpers and
# tree walks (Teams.swift) and the send's decisions (Send.swift) into build/swift-check and runs
# it: one line per case, PASS or FAIL, exit 1 on a failure. It touches no window, no Teams, no
# clipboard and no Accessibility: only made-up frames, titles and trees. Dictation.swift comes along
# for its pure DictationLocales; nothing listens. MacPlan.swift brings the Mac translator's plan (which
# language from and to), with no Translation framework.
#
#   sh test/swift-check.sh

set -e
cd "$(dirname "$0")/.."
mkdir -p build
swiftc -swift-version 5 -framework AppKit -framework ApplicationServices -framework Speech -framework AVFoundation -framework NaturalLanguage \
  app/Dock.swift app/Teams.swift app/Send.swift app/Dictation.swift app/Detect.swift app/MacPlan.swift test/swift-check.swift \
  -o build/swift-check
./build/swift-check
