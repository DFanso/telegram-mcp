# Changelog

Each release's section here becomes its "What's new" on GitHub. Add the next one as
`## <version>` before tagging (see [Releasing](README.md#releasing)).

## 1.0.0

The first release, with prebuilt binaries for macOS, Linux and Windows, the menu bar app for macOS and the tray app for Windows.

- **One always-on daemon** holds the only Telegram connection (your user account). Every Claude Code session talks to it through a thin MCP proxy, so sessions never fight over the login and never need `/mcp reconnect`. It reconnects by itself, catches up on missed messages, and `tgmcp install` keeps it running under launchd.
- **Rules file**: chats can be blocked, need approval, send without asking, or allow auto-replies, and nicknames make "send to leo" mean exactly one person. A first message to a new chat always asks, and your answer decides what happens next time.
- **Approvals** in the menu bar app (with notification actions), a Claude Code dialog, or in chat. Nothing goes out unless you accept.
- **Menu bar app**: approvals, which sessions are listening to which chats, the chats you last sent to, and a **Contacts** page to change each saved chat's nickname, sending rule and auto-reply without editing `config.json` (#3).
- **Windows tray app**, the menu bar app's counterpart, with the same panel, Contacts page and notifications (#4). The Windows release includes it as one self-contained exe next to `tgmcp.exe`, so it needs no .NET; `tgmcp menubar` starts it.
- **Watching**: `telegram_watch` pushes a chat's new messages into one or more sessions (Monitor, channel push or a queue) so they can reply while they listen.
- **Files**: `telegram_send_file` sends a local file under the same rules, and files to a chat a session is watching always ask (#1). `telegram_download_media` saves a message's attachment.
- **Secrets in the OS keystore**: the API token and api_hash live in the Keychain (Credential Manager, Secret Service), and the Telegram auth key in `session.db` is sealed with a key kept there.
- **Text keeps its leading spaces**, so indented messages arrive as written (#2).
- **`tgmcp version`**, and release builds that run without Bun or a checkout: `tgmcp install`, `tgmcp menubar` and `tgmcp mcp-add` use the installed binary and app.
