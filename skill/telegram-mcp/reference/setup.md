# Setting up telegram-mcp

telegram-mcp is free and open source (MIT): https://github.com/iddhi-sulakshana/telegram-mcp

Go through these steps with the user. Show each command before you run it. The installer downloads and runs a script from GitHub, so ask the user before running it. Steps that ask for their phone number, login code or passwords must happen in the user's own terminal, never in the chat.

## What it touches

- **Network:** the installer downloads release files from github.com. The daemon connects to Telegram's servers. Everything else stays on the machine: the daemon listens only on `127.0.0.1:47823`.
- **Files:** `~/.config/telegram-mcp/` (rules file, session, log), and downloads in `~/Downloads/telegram-mcp/`.
- **Secrets:** the Telegram session key, the local API token and the api_id/api_hash go to the operating system's keystore (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux), not to plain files.

## 1. Install

macOS and Linux (installs `tgmcp` into `~/.local/bin`, and on macOS the menu bar app into `~/Applications`):

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/iddhi-sulakshana/telegram-mcp/releases/latest/download/tgmcp-installer.sh | sh
```

Windows (installs into `%LOCALAPPDATA%\Programs\tgmcp` and adds it to PATH):

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/iddhi-sulakshana/telegram-mcp/releases/latest/download/tgmcp-installer.ps1 | iex"
```

From source instead, with Bun: clone the repo, then `bun install && bun link`.

## 2. Get Telegram API credentials

The user signs in at https://my.telegram.org, opens **API development tools**, and creates an app. They need the `api_id` and `api_hash`. They type these into `tgmcp login` in the next step; they never paste them into the chat.

## 3. Start the daemon and log in

```sh
tgmcp install    # macOS: starts the daemon now and at every login (launchd)
tgmcp login      # in the user's terminal: api_id/api_hash, phone, code, 2FA
tgmcp menubar    # menu bar app (macOS) or tray app (Windows), where approvals show up
```

- **Linux:** run `tgmcp daemon` from a systemd user service, or anything else that keeps it running.
- **Windows:** keep `tgmcp daemon` running in a terminal.

## 4. Add it to the agent

```sh
tgmcp mcp-add    # prints the `claude mcp add` command for this machine
```

Run the printed command, then restart the agent session or reconnect its MCP servers. Other MCP agents take the same command (`tgmcp mcp`) as a stdio server.

## 5. Check

```sh
tgmcp status
```

In the agent, `telegram_status` should now show the account.

## Upgrading

Run the installer again, then `tgmcp install && tgmcp menubar` to restart both on the new version. On macOS, each new version asks once whether tgmcp may use the "telegram-mcp" Keychain item: choose **Always Allow**.
