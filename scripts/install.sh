#!/bin/sh
# Installs tgmcp __VERSION__ from its GitHub release (macOS and Linux):
#   curl --proto '=https' --tlsv1.2 -LsSf https://github.com/__REPO__/releases/download/v__VERSION__/tgmcp-installer.sh | sh
#
# tgmcp goes to ~/.local/bin (TGMCP_INSTALL_DIR to change it). On macOS the menu bar app goes to
# ~/Applications (TGMCP_APP_DIR). Every download is checked against its published SHA-256.
# TGMCP_DOWNLOAD_URL fetches the files from somewhere else (the release workflow tests with it).
set -eu

VERSION="__VERSION__"
REPO="__REPO__"
INSTALL_DIR="${TGMCP_INSTALL_DIR:-$HOME/.local/bin}"
APP_DIR="${TGMCP_APP_DIR:-$HOME/Applications}"
APP_NAME="Telegram MCP.app"

say() { printf '%s\n' "$*"; }
fail() { printf 'tgmcp installer: %s\n' "$*" >&2; exit 1; }

if [ -n "${TGMCP_DOWNLOAD_URL:-}" ]; then
  BASE="$TGMCP_DOWNLOAD_URL"
  fetch() { curl -fLsS "$1" -o "$2"; }
else
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
  fetch() { curl --proto '=https' --tlsv1.2 -fLsS "$1" -o "$2"; }
fi

command -v curl >/dev/null 2>&1 || fail "needs curl"
command -v tar >/dev/null 2>&1 || fail "needs tar"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=apple-darwin ;;
  Linux) os=unknown-linux-gnu ;;
  *) fail "no build for $os. On Windows, use tgmcp-installer.ps1." ;;
esac
case "$arch" in
  arm64 | aarch64) arch=aarch64 ;;
  x86_64 | amd64) arch=x86_64 ;;
  *) fail "no build for the $arch CPU" ;;
esac
# A shell running under Rosetta on Apple Silicon says x86_64: install the native build.
if [ "$os" = apple-darwin ] && [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=aarch64
fi
name="tgmcp-$arch-$os"

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "needs sha256sum or shasum to check the download"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading tgmcp $VERSION ($arch-$os)"
fetch "$BASE/$name.tar.xz" "$tmp/$name.tar.xz" || fail "download failed: $BASE/$name.tar.xz"
fetch "$BASE/$name.tar.xz.sha256" "$tmp/$name.tar.xz.sha256" || fail "download failed: $BASE/$name.tar.xz.sha256"
expected=$(cut -d ' ' -f 1 <"$tmp/$name.tar.xz.sha256")
actual=$(sha256 "$tmp/$name.tar.xz")
[ "$expected" = "$actual" ] || fail "checksum mismatch for $name.tar.xz (expected $expected, got $actual)"
tar -xJf "$tmp/$name.tar.xz" -C "$tmp"

mkdir -p "$INSTALL_DIR"
# Copy, then rename over the old one: a running daemon keeps its old file until it restarts.
cp "$tmp/$name/tgmcp" "$INSTALL_DIR/.tgmcp.new"
chmod 755 "$INSTALL_DIR/.tgmcp.new"
mv -f "$INSTALL_DIR/.tgmcp.new" "$INSTALL_DIR/tgmcp"
say "Installed $INSTALL_DIR/tgmcp"

if [ -d "$tmp/$name/$APP_NAME" ]; then
  mkdir -p "$APP_DIR"
  rm -rf "$APP_DIR/$APP_NAME.new"
  cp -R "$tmp/$name/$APP_NAME" "$APP_DIR/$APP_NAME.new"
  rm -rf "$APP_DIR/$APP_NAME"
  mv "$APP_DIR/$APP_NAME.new" "$APP_DIR/$APP_NAME"
  say "Installed $APP_DIR/$APP_NAME"
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac

say ""
if [ "$on_path" = 0 ]; then
  say "$INSTALL_DIR is not on your PATH. Add this to your shell profile (~/.zshrc, ~/.bashrc):"
  say "  export PATH=\"$INSTALL_DIR:\$PATH\""
  say ""
fi
if [ "$os" = apple-darwin ]; then
  say "First time:"
  say "  tgmcp install    # the daemon, started now and at every login"
  say "  tgmcp login      # your Telegram account"
  say "  tgmcp menubar    # the menu bar app"
  say "  tgmcp mcp-add    # prints the command that adds it to Claude Code"
  say ""
  say "Upgrading? Run \`tgmcp install && tgmcp menubar\` to restart both on $VERSION."
  say "macOS may ask once whether tgmcp and \"Telegram MCP\" may use the \"telegram-mcp\" Keychain item: choose Always Allow."
else
  say "Next: \`tgmcp login\`, then run \`tgmcp daemon\` (from a systemd user service to keep it running),"
  say "and \`tgmcp mcp-add\` prints the command that adds it to Claude Code."
fi
