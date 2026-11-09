# The rules file

The user controls sending through `~/.config/telegram-mcp/config.json`. Edits apply as soon as the file is saved. A broken edit keeps the last good version and shows up in `tgmcp status`. Agents can read the rules with `telegram_get_rules`, but only the user can change them.

```jsonc
{
  "guides": ["Free-text rules every session sees when it connects."],
  "footer": "\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ",        // added to every message, once
  "defaultPolicy": "approve",                // chats on no list: "approve" or "block"
  "rules": {
    "blocked":         [5550001111],         // never send
    "requireApproval": ["team-qa"],          // always ask the user first
    "autoSend":        ["me", "@someone"],   // send without asking
    "autoReply":       ["leo"]               // sessions may watch these chats and reply without asking
  },
  "chats": {
    "leo": { "id": 123456789, "username": "leo_example", "name": "Leo Perera", "aliases": ["leonard"] },
    "team-qa": { "id": -1001234567890, "name": "Team QA", "topicId": 42 }
  }
}
```

## Lists

Each list takes a nickname, an `@username`, a numeric id, or `"me"`. If a chat is on more than one list, the safer one wins:

blocked > requireApproval > autoSend > autoReply > defaultPolicy

## The first message to a new chat

A chat on neither `autoSend` nor `requireApproval` always needs approval. The approval also asks what should happen next time: **Always allow** puts the chat on `autoSend`, and **Ask every time** puts it on `requireApproval`. Approving also saves the chat under `chats` with a suggested nickname.

## Where approvals happen

The first of these that's available:

1. **The menu bar app (macOS) or tray app (Windows).** The draft shows there and as a notification, with Approve / Deny.
2. **The agent's own dialog**, showing the exact recipient and text.
3. **In the chat.** The tool returns an approval id, and the agent must ask the user before calling `telegram_confirm_send`. A first message approved this way always saves the chat as "ask every time".

Nothing is sent unless the user accepts. Drafts expire after 20 minutes, and the rules are checked again at send time. Edits and deletes ask the same way.

## Changing rules without editing the file

The menu bar or tray app's **Contacts** page lists every saved chat. There the user can rename a chat, choose **Always allow**, **Ask every time** or **Blocked**, turn **Listen** (autoReply) on or off, and choose who can page them. Each change saves to `config.json` at once.

## Nicknames

Only exact matches resolve: a nickname, an alias, a saved full name, a username or an id. A near match is refused with suggestions, never picked. Before every send the daemon checks that the saved id still has the saved username, and refuses if either has changed. Agents can add, update and remove nicknames (`telegram_save_chat`, `telegram_remove_chat`), but can't repoint or remove a nickname that the rules use.
