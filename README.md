<p align="center">
  <img src="docs/social-preview.svg" width="100%" alt="telegram-mcp: let Claude use your Telegram, and send only what you allow. One always-on Telegram daemon, shared by every Claude Code session.">
</p>

# telegram-mcp

Telegram for Claude Code, through **one always-on daemon** instead of a Telegram connection per session.

```
Claude session A ─┐ stdio                                   
Claude session B ─┼─ tgmcp mcp (thin proxy, no Telegram) ── WebSocket ──► tgmcp daemon ──► Telegram
Claude session C ─┘                                          127.0.0.1      (launchd, KeepAlive)
```

- **The daemon** (`tgmcp daemon`) runs under launchd, starts at login, and is restarted if it ever exits. It holds the only Telegram connection (your user account, via [mtcute](https://mtcute.dev)), reads the rules file, and keeps every session's watches.
- **The proxy** (`tgmcp mcp`) is what Claude Code launches for each session. It has no Telegram connection. It forwards tool calls to the daemon, and if the daemon restarts it reconnects by itself and restores the session's watches. It never exits over daemon trouble, so Claude Code never marks the server "failed" and you never have to `/mcp reconnect`.

## Staying connected without a human

- mtcute reconnects dropped sockets by itself.
- A watchdog pings Telegram every 30 s and rebuilds the client when two pings fail, when it has been stuck "connecting" for 90 s, or straight after the Mac wakes from sleep. Rebuilds retry forever, backing off up to a minute.
- Messages that arrive while the connection is down are caught up after it reconnects (mtcute's update gap recovery), and each one is delivered only once.
- A tool call made during a reconnect waits up to ~25 s for the connection instead of failing.
- If the daemon process dies, launchd restarts it within 5 s. The proxies reconnect and re-register their watches.
- Only a revoked or missing login stops it, because that needs you: `tgmcp login`.

## Setup

Install a prebuilt binary. On macOS and Linux it goes into `~/.local/bin`, and on macOS the menu bar app goes into `~/Applications`. On Windows, `tgmcp.exe` and the tray app go into `%LOCALAPPDATA%\Programs\tgmcp`, which is added to your PATH:

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/iddhi-sulakshana/telegram-mcp/releases/latest/download/tgmcp-installer.sh | sh
```

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/iddhi-sulakshana/telegram-mcp/releases/latest/download/tgmcp-installer.ps1 | iex"
```

or run it from a checkout with [Bun](https://bun.sh): `bun install && bun link` puts `tgmcp` on your PATH (or use `bun run src/cli.ts …`). Then:

```sh
tgmcp install                     # launchd agent: starts the daemon now and at every login
tgmcp login                       # in a terminal: api_id/api_hash (if not saved yet), phone, code, 2FA
                                  # (tgmcp login --credentials to enter api_id/api_hash again)
tgmcp menubar                     # menu bar app (macOS) or tray app (Windows): approvals, listening sessions, recent sends, contacts (starts at login)
tgmcp mcp-add                     # prints the `claude mcp add` command for your paths
tgmcp status
```

`tgmcp install` (the launchd agent) is macOS-only. On Linux, run `tgmcp daemon` from a systemd user service (or any way that keeps it running). On Windows, keep `tgmcp daemon` running in a terminal. `tgmcp menubar` starts the menu bar app on macOS and the [tray app](#tray-app-windows) on Windows. Everything else works the same.

**Upgrading** a release: run the installer again, then `tgmcp install && tgmcp menubar` to restart both on the new version. Each new version is a new program to macOS, so it asks once more whether tgmcp and "Telegram MCP" may use the "telegram-mcp" Keychain item: choose **Always Allow**. **Moving from a checkout to a release**: `tgmcp install` points the launchd agent at whichever `tgmcp` runs it, so check `which tgmcp` (a `bun link` in `~/.bun/bin` may come first on your PATH), then run `tgmcp install`, `tgmcp menubar` and `tgmcp mcp-add` again. Your config, login and secrets stay where they are.

`tgmcp call <tool> '<json>'` runs any tool as a one-off session, e.g. `tgmcp call telegram_get_rules`.

API credentials come from `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` if set, otherwise the OS keystore (`tgmcp login` saves them there). Get them at https://my.telegram.org → API development tools.

## Secrets

Nothing secret is kept in a plain file. Three secrets go to the operating system's keystore through `Bun.secrets`, under the service `telegram-mcp`: the login Keychain on macOS, Credential Manager on Windows, and the Secret Service (GNOME Keyring, KWallet, via libsecret) on Linux.

| Secret | What it is |
| --- | --- |
| `session-key` | Encrypts the Telegram auth key inside `session.db` (AES-256-GCM) |
| `token` | Shared secret for the local API, so web pages and other users can't talk to the daemon |
| `credentials` | api_id / api_hash |

**Why the session key matters.** A Telegram auth key *is* your login: whoever copies it is you, with no code and no 2FA asked. `session.db` still holds the peer cache and update state, but its auth key rows are sealed with `session-key`. A copy of the folder alone (a backup, a synced dotfiles repo, a stolen disk image, or an infostealer that grabs `~/.config`) doesn't give anyone your account.

**What it doesn't stop.** Code that runs as you and asks the keystore can still get the secrets. On macOS the Keychain only hands them silently to the app that created them, which is the `bun` binary, so any script you run with `bun` could read them. On Linux and Windows any process in your session can. The keystore protects the secrets at rest. It doesn't sandbox your own account.

**Upgrading from an older version.** On its first start the daemon moves `token` and `credentials.json` into the keystore, checks they read back, and deletes the files. It seals the auth key in `session.db` and scrubs the old copy (secure delete, `VACUUM`, WAL truncated). The token value stays the same, so the Monitor URLs of running sessions keep working. Proxies and the menu bar app started before the upgrade still look for the file: run `/mcp` → reconnect in open Claude sessions and `tgmcp menubar` once. The unsealed key may still sit in older backups. To retire it, end the session in Telegram (Settings → Devices) and run `tgmcp login` again.

**The menu bar app** reads the token from the Keychain itself. The first time, and again after each rebuild (`tgmcp menubar`), macOS asks whether "TelegramMCPBar" may use the "telegram-mcp" item: choose **Always Allow**.

**No keystore?** On a machine without one (a headless Linux box, say), set `TELEGRAM_MCP_SECRET_STORE=file` for the daemon, the proxies and the CLI. The secrets then go to `token`, `credentials.json` and `session.key` in the home folder, mode 0600. There is no automatic fallback: if the keystore fails, the error says so instead of quietly writing files. `tgmcp status` shows where the secrets are and warns about leftover plain files.

## Files

All in `~/.config/telegram-mcp/` (folder mode 0700; override with `TELEGRAM_MCP_HOME`):

| File | What |
| --- | --- |
| `config.json` | The rules file (below). Edits apply as soon as you save. A broken edit keeps the last good version and shows up in `tgmcp status`. |
| `session.db` | mtcute's session: peer cache, update state, and the auth key sealed with `session-key` |
| `daemon.log` | The daemon log (`tgmcp logs`) |
| `recent.json` | The last 20 sent messages (shown in the menu bar) |
| `avatars/` | Small (160×160) profile photos for the menu bar and tray avatars, `<chat id>.jpg` (or `.none` when the chat has none) |
| `token`, `credentials.json`, `session.key` | Only with `TELEGRAM_MCP_SECRET_STORE=file` |

The daemon listens on `127.0.0.1:47823` (`TELEGRAM_MCP_PORT`).

Downloads go to `~/Downloads/telegram-mcp/<chat>/` (`TELEGRAM_MCP_DOWNLOADS`), named `<message id>-<file name>`.

## The rules file

```jsonc
{
  "guides": ["Free-text rules every session sees when it connects."],
  "footer": "\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ",        // appended to every message, once
  "defaultPolicy": "approve",                // chats in no list: "approve" or "block"
  "rules": {
    "blocked":         [5550001111],         // never send
    "requireApproval": ["team-qa"],          // always ask you first ("Ask every time")
    "autoSend":        ["me", "@someone"],   // send without asking ("Always allow")
    "autoReply":       ["leo"]               // sessions may listen to these chats and reply without asking
  },
  "chats": {
    "leo": { "id": 123456789, "username": "leo_example", "name": "Leo Perera", "aliases": ["leonard"] },
    "team-qa": { "id": -1001234567890, "name": "Team QA", "topicId": 42 }
  }
}
```

**Lists** take a nickname, an `@username`, a numeric id, or `"me"`. If a chat is on more than one list, the safer list wins: blocked > requireApproval > autoSend > autoReply > defaultPolicy. `blocked` matches the raw id, so `5550001111` also blocks `-1005550001111`.

**/reply** hands one chat to the session that called `telegram_answer_reply`, for two hours or until `/reply stop`. Typing `/reply` in that chat counts as your approval, so the session's replies there go out without asking even when the chat is on `requireApproval`; `blocked` still refuses, and files still ask. Only a `/reply` you type on your phone or desktop counts: messages the daemon sent itself are ignored, and Claude cannot send a message that starts with `/reply`, formatted or not.

**autoReply** chats are the ones Claude sessions may listen to. A session subscribes with `telegram_watch` and stays subscribed until it says stop. Every incoming message from that chat goes to every subscribed session, and each one decides how to reply (the auto reply happens on the Claude side). While subscribed, a session's replies to that chat go out without approval, unless the chat is also on `requireApproval` or `blocked`.

**Files to a watched chat always ask**, even when the chat is on `autoSend`. While a session watches a chat it acts on what people there write, so "send me that file" may be their request, not yours. Text replies still follow the lists. Files to an `autoSend` chat that the session isn't watching go out without asking. Taking a chat off the list stops delivery at once.

**First message to a new chat.** A chat that is on neither `autoSend` nor `requireApproval` always needs approval. The approval also asks what should happen next time:
- **Always allow** puts it on `autoSend`.
- **Ask every time** puts it on `requireApproval`.

Approving also saves the chat under `chats`, with a suggested nickname you can edit: the first name, else the username, else the full name. From then on the chat follows that list. Only you put chats on the lists, through an approval or the menu bar's [Contacts page](#contacts); sessions can't.

**Approval** happens in the first place available:
1. The **menu bar app**, when it's running. The draft appears there and as a notification. Both offer Approve / Deny, or Deny / Ask every time / Always allow for a new chat. The Claude tool call waits for your click: Claude Code backgrounds it after 2 minutes, and the result arrives when you decide.
2. A **Claude Code dialog** showing the exact recipient and text, plus the next-time choice and nickname for a new chat.
3. **In chat**: the tool returns an approval id. The model must ask you before it calls `telegram_confirm_send`. Here the model's word is the only check, so this path is narrower: it can't confirm a draft that is waiting in the menu bar app (even after Claude Code backgrounds the call), and a first message approved here always saves the chat as "ask every time". Only you can make a chat "always allow", in the menu bar's Contacts page, an approval there, the dialog, or `config.json`.

Nothing is sent unless you accept. Drafts expire after 20 minutes. The rules are checked again at send time.

**Nicknames** (`chats`) let "send to leo" mean exactly one person. Only exact matches resolve: a nickname, an alias, a saved full name, a username or an id. A near match like "leon" is refused with suggestions, never picked. Before every send the daemon checks that the saved id still has the saved username. If either has changed, it refuses until the entry is re-saved. Sessions can add, update and remove nicknames (`telegram_save_chat`, `telegram_remove_chat`). They cannot change `rules`, `footer` or `guides`, and they cannot repoint, create or remove a name that the rules use: only you can, by editing the file or renaming it on the [Contacts page](#contacts).

## Tools

| Tool | |
| --- | --- |
| `telegram_status` | connection, account, config errors, this session's watches |
| `telegram_get_rules` | guides, footer, lists, saved nicknames |
| `telegram_list_chats` | recent chats with unread counts and what sending there would do; filter by kind (`type`: private, groups, channels, bots), sort by `recent` / `unread` / `name`, and `categorize` under a heading per kind |
| `telegram_search_chats` | find a person or group to save |
| `telegram_read_messages` | read a chat or forum topic |
| `telegram_send_message` | send, following the rules |
| `telegram_delete_message` | delete a message this session sent recently, for everyone in the chat; same limits as edit (its own messages only, where sending needs no approval), logged, can't be undone |
| `telegram_edit_message` | change the text of a text message this session sent recently (chat and message id); only where sending needs no approval, since the chat sees the new text. Never another session's message, yours (the Page button's included), the pager's or an away reply. The footer is added again, Recently sent shows it as edited and keeps the original, and `daemon.log` has a line for each edit |
| `telegram_send_file` | send a local file with a caption, following the same rules (but see files to watched chats, above); credentials and this tool's own files are always refused |
| `telegram_send_sticker` | re-send a sticker someone posted (by chat and message id), following the same rules; stickers take no caption, so no footer |
| `telegram_page` | page the user for something that needs a human now: the desktop rings until they ack, and the phone gets a push (see [Pages](#pages)) |
| `telegram_answer_reply` | make this session answer `/reply`: type `/reply` (or `/reply <what to say>`) in any chat from your own account and that chat is handed to the session; `/reply stop` takes it back |
| `telegram_message_readers` | whether one of your own messages has been read: in a private chat whether the other person did, in a group of up to 100 people who did and when (about a week); only what Telegram shows, read-only |
| `telegram_download_media` | save a message's file, photo, video or voice note and return the path |
| `telegram_confirm_send` / `telegram_cancel_send` | approval fallback for clients without dialogs |
| `telegram_save_chat` / `telegram_remove_chat` | manage nicknames |
| `telegram_watch` / `telegram_unwatch` | subscribe to an autoReply chat (optionally one sender, one topic) |
| `telegram_get_events` | collect watched messages nobody pushed yet |
| `telegram_mark_read` | mark a chat read |

## Watching ("tell me when Leo replies")

`telegram_watch` subscribes the session to a chat on the autoReply list until it calls `telegram_unwatch` or ends. Each new incoming message reaches every subscribed session once, by the first of these that is available to that session:

1. **Monitor** (the default): `telegram_watch` returns a `ws://127.0.0.1…/events?session=…&key=…` URL, and Claude opens its Monitor tool on it. The key opens that one session's stream and nothing else, so the URL (which Claude Code keeps in its transcripts) never carries the token. Each message becomes a notification in the session. A Monitor stops after 30 minutes, or when the daemon restarts. Claude is told to restart it straight away with the same URL whenever it ends while watches are active (`telegram_status` shows the URL again). Nothing is lost in between, because messages queue up and are flushed when the Monitor reconnects.
2. **Channel push** (optional: `tgmcp mcp --channel`, plus `claude --dangerously-load-development-channels server:<name>`): messages appear in the session by themselves as `<channel>` events, with no Monitor needed. This uses Claude Code's channels research preview.
3. **Queue**: `telegram_get_events` drains it. Every other tool result also mentions when messages are waiting.

A session's watches outlive a daemon restart, because the proxy re-sends them. They also outlive a proxy blip for 5 minutes. They end when the Claude session ends.

## Pages

A page is for something that needs you now: production down, a blocker someone is waiting on, "call me". The menu bar app (macOS) or the tray app (Windows) plays a looping alarm and opens a window above everything, and it keeps ringing until you press **Ack** or **Snooze** (15 minutes or an hour). With a pager bot, your phone gets the page as a push too, with the same buttons. An Ack anywhere stops it everywhere.

Only the daemon decides what pages, from the `paging` section of the rules file:

```jsonc
"paging": {
  "pageFrom": [5550001111],          // numeric user ids whose "/page <reason>" pages you (a username can change hands)
  "vip": ["team-qa"],                // chats where a keyword alone pages you
  "keywords": ["urgent", "down", "prod", "asap"],
  "retryMinutes": 5, "tries": 3,     // phone retries while nobody acks
  "perSenderMinutes": 10             // at most one page per sender in this window
}
```

- **`/page <reason>`** from someone on `pageFrom` pages you. Anyone else's `/page` is ignored, and so is your own.
- **A keyword** (as a whole word) pages you only in a `vip` chat. Elsewhere, "urgent" pages no one.
- **Claude** can page you with `telegram_page`, under the same rate limit.

On the [Contacts page](#contacts), **Can page me** puts a person on `pageFrom` (by their user id) or takes them off, and **Page** sends them `/page <reason>` from your account. It rings them if you're on *their* `pageFrom`, and you get their daemon's replies in that chat.

**Your own alarm sound.** Put `alarm.mp3` (or `.m4a`, `.wav`, `.aiff`, `.caf`) in the home folder and the menu bar app plays it instead of the built-in beep. The tray app plays `alarm.wav` (its sound player takes WAV only). Both look for the file on each new page, so no restart is needed, and both fall back to the beep if the file is missing or unreadable. To make a WAV from an MP3: `ffmpeg -i alarm.mp3 alarm.wav`.

The sender gets fixed replies, never text Claude wrote and never their own reason echoed back: "Paging Leo now. I'll tell you when they've seen it.", "Leo saw it.", and, if nobody acks after the last try on the phone, "Leo hasn't seen it yet. Try calling." The desktop keeps ringing after that. A page only ever notifies you; its reason is shown as text and nothing in it is acted on. Every page, retry, ack and snooze is written to `pages.jsonl` in the home folder (without the reason). Pages live in the daemon's memory, so a restart drops the ones still ringing.

**The phone.** Messages from your own account don't buzz your phone, so pages reach it through a bot of your own:

1. Make one with [@BotFather](https://t.me/BotFather) (`/newbot`), then run `tgmcp page setup` and paste its token. It goes to the keystore.
2. Open the bot, press **Start**, and keep that chat unmuted, or the phone won't buzz.
3. `tgmcp restart`, then `tgmcp page test` to hear the alarm, check the volume and try Ack.

The bot only messages the account you're logged in as, and ignores button presses from anyone else.

## Away auto-reply

When you're off for the night, friends who write get one reply saying so. It's **off by default**. Turn it on and it answers during the hours you set (6pm to 9am unless you change it, in the laptop's local time; the start is included and the end is not):

> Chamodh is off the grid for the night and will get back to you tomorrow. If something's on fire, call them 🔥

`{name}` becomes your first name, and the footer is added as with any message. The reply goes out plain (not as a reply to their message) and without approval. The rules, so it never gets in the way:

- Only private chats with people: not groups, bots, Saved Messages, or Telegram's service and support accounts.
- Only chats whose rules allow a message without asking: never a **Blocked** or **Ask every time** chat, nor a chat that isn't saved when `defaultPolicy` is `"block"`. (Like the pager's fixed replies: nobody is there to approve it.)
- Once per chat per night, and at most 20 replies a night in all, so a wave of messages from strangers doesn't look like spam from your account. A restart in the middle of the night doesn't reset either.
- Only while it's still away hours: a message from 08:58 that the laptop picks up at 09:05 gets nothing.
- Not for 30 minutes after anything was sent from your account in that chat, whether you typed it or Claude sent it (`quietMinutes`; 0 turns this off). The Page button's message and the away reply itself don't count.
- Not while a Claude session is handling the chat (watching it, or after `/reply`).
- Not to someone who is paging you, or whose page is still waiting.
- Only for messages less than 10 minutes old, so catching up after the laptop sleeps doesn't send night-time replies in the morning.

Change it from the Away page of the menu bar app (macOS) or the Away tab of the tray app (Windows), with `tgmcp away`, or in `config.json`:

```
tgmcp away                          # show the settings and the reply text
tgmcp away on | off
tgmcp away hours 19:00 08:30        # from, until (24-hour HH:MM; they can't be equal)
tgmcp away message "{name} is away until tomorrow."   # at most 1000 characters
tgmcp away quiet 60
```

```jsonc
"away": {
  "enabled": true, "from": "18:00", "until": "09:00",
  "message": "{name} is away until tomorrow.", "quietMinutes": 30
}
```

An away reply shows under Recently sent as "away reply". No MCP tool can change these settings, so sessions can't turn it on or rewrite the message; only you can, through the file, the CLI, the menu bar app or the tray (`POST /ui/away` with the token).

## Menu bar app

`tgmcp menubar` builds `menubar/build/Telegram MCP.app` (SwiftUI, no Dock icon) and starts it at login. Choosing Quit keeps it closed until your next login. The panel has the tray app's look (smoked glass with frosted cards, following light or dark mode, [Lucide](https://lucide.dev) icons) and three tabs:

- The header shows the connection as a status pill (green connected, yellow reconnecting, red logged out, grey offline) with the whole of your name, on two lines if it needs them, plus **Rules** and **Log** buttons.
- **Home** has three tiles, **Waiting**, **Listening** and **Sent**. Each shows a count and a word ("needs you", "2 sessions", "1 paused"), and the one you click is the section shown below them, so the panel stays short. A new draft switches back to Waiting.
  - **Waiting for approval**: the exact text, recipient, "Asked by …" and the reason on separate lines, and when it was asked ("just now", "5m ago"), with Deny / **Send**. A new chat says it's the first message, gets an editable nickname, and offers **Send, ask next time** / **Send, always allow** instead.
  - **Listening now**: each session watching chats, whether its Monitor is connected, and a **switch on each chat** to pause or resume listening there. A session watching several saved chats also gets an **all** switch. A switch is the chat's auto-reply: off, the daemon stops passing that chat's messages to every session at once (the watches stay, so switching it back on resumes them). Under it, **Chats Claude may listen to** lists your saved chats, each with its switch, so you can choose who Claude may watch without opening Contacts.
  - **Recently sent**: the last 5 chats you sent to. Click a chat to see its messages, when they went, how they were approved, and from which session; click again to close it.
- **Contacts**: every saved chat, to change its rules without editing `config.json`. See [Contacts](#contacts).
- **Away**: the [away auto-reply](#away-auto-reply). The switch saves at once; the hours, quiet minutes and message save with **Save** (⌘S), with a preview of the reply. It says whether it's away now and until when. While it is, the tab shows a green dot and Home shows a line saying so.

Avatars show each chat's Telegram profile photo, with initials (or a glyph for groups, channels and bots) until it loads and when there's none. See [Avatars](#avatars).

Results flash under the header: a green check when it worked, a red warning when it didn't (VoiceOver reads them out). Esc clears a search, then closes the panel; ⌘1 to ⌘3 switch tabs and ⌘F searches contacts.

<p>
  <img src="docs/menubar-approvals.png" width="370" alt="The menu bar panel's Home tab: the status pill, the Home, Contacts and Away tabs, the Waiting, Listening and Sent tiles, and two drafts waiting for approval (one to a saved group with Deny and Send, one to a new chat with Send, ask next time and Send, always allow)">
  <img src="docs/menubar-history.png" width="370" alt="Home with the Sent tile picked: recently sent, expanded, each chat listing the messages sent there, when, how they were approved and from which session">
</p>

Each new draft also posts a notification, so you can decide without opening the panel. Its **Options** menu has the same choices as the panel: **Send** / **Deny** for a chat that is already on a list, and **Send, ask next time** / **Send, always allow** / **Deny** for the first message to a new chat.

<img src="docs/notification-options.png" width="384" alt="Two draft notifications; the Options menu of a first message to a new chat shows Approve, ask next time; Approve, always allow; and Deny">

A long draft shows its first 4 lines: click it (or **Show all**) to see all of it. Nothing in the panel opens on hover. The panel never runs past the bottom of the screen: when a long draft (or many of them) would, the middle scrolls and the header and footer stay put.

The menu bar icon is the app's paper plane in the same colours as the status pill (blue when connected), with a green dot while a session listens and a badge: the number of drafts waiting on amber, or "!" when the daemon or Telegram is down. `tgmcp menubar uninstall` removes it.

### Contacts

**Contacts** lists every saved chat (`chats` in the rules file) with tags for how it's set up. Search by nickname, name, @username or id, and filter to **All**, **Listening** (Claude may listen) or **Not listening**. In the menu bar app each row has a **Listen** switch, which is the chat's auto-reply (below), so you can choose who Claude may listen to without opening the chat. Click a chat to change the rest. An open chat says what happens there in plain words first:

- **Nickname**: type a new one and press Rename. Rules that used the old name are rewritten to the new one, so the chat keeps its lists. A name that already means another chat is refused, and so is a name the rules mention that matches no chat yet (taking it would quietly put this chat on those lists). One of the chat's own aliases can become its nickname.
- **When Claude sends a message here**: **Always allow** (`autoSend`), **Ask every time** (`requireApproval`) or **Blocked** (`blocked`). The chat ends up on exactly that list: every other entry that means the same chat is taken out of the other two, whether it's a nickname, an alias, an id, an @username or `"me"`. A chat on none of them shows as *not set*.
- **Auto-reply** (the **Listen** switch in the menu bar app): **On** puts it on `autoReply`, so sessions may watch it and reply without asking. **Off** takes out every entry that means the chat, and sessions watching it stop getting its messages at once. The text under the buttons says when the sending rule overrides this (Ask every time still asks; Blocked still refuses).
- **Can page me** (people only, not groups, bots or yourself): **On** puts their user id on `paging.pageFrom`, so their `/page <reason>` rings you (see [Pages](#pages)). **Off** takes it out. The row gets a *can page me* tag.
- **Page *nickname***: type a reason (or none) and press **Page** or Return. The daemon sends `/page <reason>` to that person from your account, as one line of at most 200 characters and without the footer, since everything after `/page` is their reason. It shows under Recently sent. A chat whose sending rule blocks it (Blocked, or on no list with `defaultPolicy: "block"`) is refused.

Each click saves to `config.json` at once, the same way an approval does: the file is read fresh first, so a hand edit made a moment ago is kept, and a broken file is reported, never overwritten. A click that changes nothing writes nothing. Each change is noted in `daemon.log`. Rules are per chat, so if two nicknames point to the same chat, changing one changes both; the details line under the buttons names the other.

<img src="docs/menubar-contacts.png" width="370" alt="The Contacts tab: search, the All, Listening and Not listening filter, four saved chats with their tags and Listen switches, and Team QA opened with its explanation, the sending choices (Ask every time selected) and its nickname">

This page is the menu bar's own: it goes through the daemon's local API with the token (`POST /ui/contacts` and `POST /ui/contacts/page`, like approvals). No MCP tool offers the same, so sessions still can't change the rules through the server.

### Avatars

In both apps the avatars on Home's cards, in Contacts and on a page's alarm window show the chat's real Telegram profile photo. The daemon fetches the small (160×160) photo the first time an app asks for it (`GET /ui/avatars/<chat id>`, with the token, like `/ui/state`), keeps it in `avatars/` in the home folder, and fetches it again at most once a day. Each app asks once per chat when the avatar first shows and again every 6 hours, never on each poll. Only chats the panel shows (saved chats, drafts, watched chats, recent sends and pages) are fetched. A chat with no photo, or one that hides it from you, keeps its initials, and so does every avatar while Telegram can't be reached. The demo daemon and the screenshots use made-up gradient pictures, never real photos.

## Tray app (Windows)

On Windows, `tgmcp menubar` starts the tray app and sets it to start at login. Settings → Apps → Startup lists it as "Telegram MCP".

- **From a release**, it uses the prebuilt `TelegramMCPTray.exe` that the installer put next to `tgmcp.exe`. It's self-contained, so it needs no .NET. Set `TELEGRAM_MCP_TRAY_APP` to use one somewhere else.
- **From a checkout**, it first builds `tray/build/TelegramMCPTray.exe` (C#/WPF), which needs the [.NET SDK 10](https://dotnet.microsoft.com/download).

It is the menu bar app's counterpart:

- **The tray icon** is the paper plane from `docs/icon.svg`, coloured by status: blue when connected, yellow while it reconnects, red when logged out, grey when the daemon can't be reached. A green dot means a session is listening. The amber badge is the number of drafts waiting for you, and `!` means something is wrong. Hover it for a summary.
- **Click it for the panel**, a frosted-glass flyout (acrylic on Windows 11, following light or dark mode) with three tabs. **Home** shows the connection as a status pill, three tiles (Waiting, Listening, Contacts), then cards for **Waiting for approval** (who asked and why, with Send / Deny; a new chat says it's the first message, gets a nickname box, and offers Deny / **Send, ask next time** / **Send, always allow**), **Listening now**, and **Recently sent** (click a chat to see its messages). Each empty card says what would show up there. As in the menu bar app, a long draft and a recent chat open on click, never on hover. Results flash under the header: a green check when it worked, red when it didn't. Esc clears a search, then closes the panel; Ctrl+1 to Ctrl+3 switch tabs, Ctrl+F searches contacts, and Tab reaches every button, with a focus ring.
- **Contacts** (the second tab) is the same page as the menu bar's (see [Contacts](#contacts) above): rename a saved chat, choose what happens when Claude sends there, turn auto-reply on or off, choose who can page you, and page someone.
- **Away** (the third tab) turns the [away auto-reply](#away-auto-reply) on or off (that saves at once), sets the hours, the quiet minutes and the message (those save with **Save**), and previews the reply with your footer. While replies can go out, the tab shows a green dot and Home says until when. Ctrl+3 opens it.
- **A Windows notification** for each draft has the same choices as buttons. Click the notification itself to open the panel.

Right-click the icon for Open, Contacts, Rules, Log and Quit. Quit keeps it closed until your next login. `tgmcp menubar uninstall` quits it and stops it starting at login.

The icons in the panel are [Lucide](https://lucide.dev) (ISC license), drawn from `tray/App/Icons.xaml`.

It reads the daemon's token from Windows Credential Manager (the `telegram-mcp/token` entry the daemon keeps there), or from the `token` file with `TELEGRAM_MCP_SECRET_STORE=file`. It talks only to 127.0.0.1. Problems it can't show in the panel go to `%LOCALAPPDATA%\TelegramMCPTray\tray.log`.

Nothing supervises the daemon on Windows yet (`tgmcp install` is launchd-only), so keep `tgmcp daemon` running in a terminal. For the same reason the panel has no Restart button.

## Development

```sh
bun test          # unit tests + an end-to-end test that spawns the real proxy against a daemon with a fake Telegram
bun run typecheck
bun scripts/demo-daemon.ts      # daemon with a fake Telegram and sample state, for working on the menu bar app
dotnet run --project tray/Tests # the tray app's logic, and its client against a demo daemon (.NET SDK 10; runs on any OS)
```

The screenshots above come from the demo daemon, rendered offscreen by the app itself:

```sh
APP="menubar/build/Telegram MCP.app/Contents/MacOS/TelegramMCPBar"
export TELEGRAM_MCP_HOME=/tmp/tgmcp-demo TELEGRAM_MCP_PORT=47901 TELEGRAM_MCP_SECRET_STORE=file SNAPSHOT_DARK=1
"$APP" --snapshot docs/menubar-approvals.png
SNAPSHOT_SECTION=sent SNAPSHOT_EXPAND=recent SNAPSHOT_SCREEN_HEIGHT=4000 "$APP" --snapshot docs/menubar-history.png   # SNAPSHOT_EXPAND: 1, approvals or recent
SNAPSHOT_PAGE=contacts SNAPSHOT_OPEN=team-qa "$APP" --snapshot docs/menubar-contacts.png    # SNAPSHOT_OPEN: a nickname to open
SNAPSHOT_PAGE=away "$APP" --snapshot /tmp/menubar-away.png
SNAPSHOT_SECTION=listening "$APP" --snapshot /tmp/menubar-listening.png                      # SNAPSHOT_SECTION: listening or sent (Home)
"$APP" --icons /tmp/menubar-icons.png                                                        # every menu bar icon state
```

### Releasing

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml), like key-vault-for-llm's:

1. Set the new version in `package.json` and add a `## <version>` section at the top of [CHANGELOG.md](CHANGELOG.md). It becomes the release's "What's new".
2. Merge that to `main`, then tag it and push the tag:
   ```sh
   git tag v1.2.3 && git push origin v1.2.3
   ```

The workflow runs the tests and `bun scripts/release.ts`. That builds `tgmcp` for Apple Silicon and Intel macOS, x64 and ARM64 Linux, and x64 Windows (`bun build --compile`, so no Bun is needed to run it), plus a universal menu bar app for the macOS archives. It writes a SHA-256 checksum for every file, and the two installers with the version filled in. Each build is then installed with its own installer on its own platform, and the daemon is started there. Only if all of that passes is the GitHub release published. A tag that doesn't match `package.json`, or a version without a CHANGELOG section, stops the build. A tag with a suffix (`v1.3.0-rc.1`) is published as a prerelease. Pull requests that touch these files run the same build and install checks without publishing.

To build locally (the cross-compile downloads Bun for each platform into Bun's install cache):

```sh
bun scripts/release.ts --out /tmp/tgmcp-dist                                # every platform
bun scripts/release.ts --out /tmp/tgmcp-dist --targets aarch64-apple-darwin  # just one
```

## License

MIT. See [LICENSE](LICENSE).
