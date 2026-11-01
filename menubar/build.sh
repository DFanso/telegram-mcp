#!/bin/bash
# Builds "Telegram MCP.app" (menu bar only) into menubar/build/ and prints its path.
set -euo pipefail
cd "$(dirname "$0")"
APP="build/Telegram MCP.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macos14.0" \
  -o "$APP/Contents/MacOS/TelegramMCPBar" TelegramMCPBar.swift
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "$PWD/$APP"
