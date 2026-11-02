#!/bin/bash
# Builds "Telegram MCP.app" (menu bar only) into menubar/build/ and prints its path.
# For releases: ARCHS="arm64 x86_64" builds a universal app, OUT=<dir> builds it there instead,
# and VERSION=<x.y.z> sets the app's version (package.json's by default).
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' ../package.json)}"
ARCHS="${ARCHS:-$(uname -m)}"
OUT="${OUT:-build}"
APP="$OUT/Telegram MCP.app"
BIN="$APP/Contents/MacOS/TelegramMCPBar"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
if [ -n "${VERSION:-}" ]; then
  plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
fi
slices=()
for arch in $ARCHS; do
  swiftc -O -swift-version 5 -parse-as-library \
    -target "$arch-apple-macos14.0" \
    -o "$BIN-$arch" TelegramMCPBar.swift
  slices+=("$BIN-$arch")
done
if [ "${#slices[@]}" -eq 1 ]; then
  mv "${slices[0]}" "$BIN"
else
  lipo -create -output "$BIN" "${slices[@]}"
  rm -f "${slices[@]}"
fi
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "$(cd "$OUT" && pwd)/Telegram MCP.app"
