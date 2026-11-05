using System.Globalization;

namespace TelegramMCPTray.Core;

public enum ContactKind { Person, Bot, Group, Channel, Chat }

/// <summary>Which saved chats the Contacts tab shows: all, those Claude may listen to, or the rest.</summary>
public enum ListenFilter { All, On, Off }

/// <summary>What a listening session may do in a chat: not listen, listen with replies that ask first, listen without replying, or listen and reply.</summary>
public enum ListenRule { Off, AsksFirst, CantReply, Replies }

/// <summary>
/// The Contacts page: the chats saved in config.json and the words for each control. Same texts as
/// the menu bar app; the daemon does the editing (POST /ui/contacts), this only describes.
/// </summary>
public static class Contacts
{
    public const string Empty = "No saved chats yet. Approving the first message to a chat saves it.";

    /// <summary>A 404 from POST /ui/contacts, or no contacts in /ui/state. (No "(below)": the tray has no Restart button.)</summary>
    public const string OlderDaemon = "The daemon is older than this app. Restart it to edit contacts.";

    /// <summary>A 404 from POST /ui/contacts/page.</summary>
    public const string OlderDaemonForPaging = "The daemon is older than this app. Restart it to page from here.";

    public static string NoMatch(string query) => $"No saved chat matches “{query.Trim()}”";

    public static string Summary(int count, int listening) =>
        $"{count} saved chat{(count == 1 ? "" : "s")} · Claude may listen to {listening} · changes save to config.json at once";

    /// <summary>The Contacts tab's filter: every chat, or only those Claude may (or may not) listen to.</summary>
    public static IReadOnlyList<UiContact> FilterListening(IReadOnlyList<UiContact> contacts, ListenFilter filter) => filter switch
    {
        ListenFilter.On => contacts.Where(c => c.AutoReply).ToList(),
        ListenFilter.Off => contacts.Where(c => !c.AutoReply).ToList(),
        _ => contacts,
    };

    /// <summary>Instead of rows when the search and filter leave none.</summary>
    public static string NoneShown(string query, ListenFilter filter)
    {
        var q = query.Trim();
        return filter switch
        {
            ListenFilter.On => q.Length == 0 ? "Claude may listen to none of your chats. Switch one on to let it." : $"No chat Claude may listen to matches “{q}”",
            ListenFilter.Off => q.Length == 0 ? "Claude may listen to every saved chat." : $"No chat Claude can't listen to matches “{q}”",
            _ => NoMatch(q),
        };
    }

    /// <summary>
    /// What a listening session may do in this chat. Auto-reply on puts the chat on the autoReply list,
    /// so a session watching it replies without asking unless a blocked or requireApproval rule comes first.
    /// </summary>
    public static ListenRule Listening(UiContact c) => !c.AutoReply
        ? ListenRule.Off
        : c.SendMode switch
        {
            "requireApproval" => ListenRule.AsksFirst,
            "blocked" => ListenRule.CantReply,
            _ => ListenRule.Replies,
        };

    /// <summary>Under a chat's name next to its listen switch: what listening there comes to.</summary>
    public static string ListenCaption(UiContact c) => Listening(c) switch
    {
        ListenRule.Off => "Claude can't listen here",
        ListenRule.AsksFirst => "May listen; replies still ask you",
        ListenRule.CantReply => "May listen, but can't reply",
        _ => "May listen and reply without asking",
    };

    /// <summary>The flash after a listen switch: turning a chat's auto-reply on or off.</summary>
    public static string ListenFlash(bool on, string label) => on
        ? $"Claude may listen to {label} again."
        : $"Paused {label}: new messages there aren't passed to Claude.";

    /// <summary>
    /// The flash when the daemon refused one chat partway through: which chats had already been switched
    /// (they stay that way), then why it stopped.
    /// </summary>
    public static string ListenStopped(bool on, IReadOnlyList<string> done, string failure) => done.Count == 0
        ? failure
        : $"{(on ? "Resumed" : "Paused")} {And(done)}, then stopped. {failure}";

    static string And(IReadOnlyList<string> names) =>
        names.Count == 1 ? names[0] : $"{string.Join(", ", names.Take(names.Count - 1))} and {names[^1]}";

    /// <summary>The mode tag on a row. "none" means on no sending list, so defaultPolicy decides.</summary>
    public static Tag ModeTag(UiContact c, string? defaultPolicy) => c.SendMode switch
    {
        "autoSend" => new("always allow", TagKind.Good),
        "requireApproval" => new("ask every time", TagKind.Warn),
        "blocked" => new("blocked", TagKind.Bad),
        _ => defaultPolicy == "block" ? new("blocked by default", TagKind.Bad) : new("not set", TagKind.Muted),
    };

    /// <summary>Blocked by its own rule, or on no list while the default blocks: nothing is sent there, pages included.</summary>
    public static bool Blocked(UiContact c, string? defaultPolicy) =>
        c.SendMode == "blocked" || (c.SendMode == "none" && defaultPolicy == "block");

    public static Tag? PageFromTag(UiContact c) => c.PagesMe ? new("can page me", TagKind.Warn) : null;

    public static string Subtitle(UiContact c) =>
        string.Join(" · ", new[] { c.Name, c.Username is null ? null : "@" + c.Username }.Where(s => !string.IsNullOrEmpty(s)));

    /// <summary>What sending there does, then what a listening session may do.</summary>
    public static string Explanation(UiContact c, string? defaultPolicy)
    {
        var send = c.SendMode switch
        {
            "autoSend" => "Messages go out without asking.",
            "requireApproval" => "Every message waits for your approval.",
            "blocked" => "Nothing is ever sent here.",
            _ => defaultPolicy == "block"
                ? "On no list, so the default rule blocks it."
                : "On no list yet: the next message asks you, and you pick what happens after.",
        };
        var reply = Listening(c) switch
        {
            ListenRule.Off => "Sessions can't listen to this chat.",
            ListenRule.AsksFirst => "Sessions may listen here, but their replies still ask first.",
            ListenRule.CantReply => "Sessions may listen here, but can't reply.",
            _ => "Sessions may listen here and reply without asking while they do.",
        };
        if (!c.CanPage) return $"{send} {reply}";
        return $"{send} {reply} {(c.PagesMe ? "Their /page rings you." : "Their /page is ignored.")}";
    }

    public static string Details(UiContact c)
    {
        List<string> parts = [$"id {c.ChatId.ToString(CultureInfo.InvariantCulture)}"];
        if (c.TopicId is { } topic) parts.Add($"topic {topic.ToString(CultureInfo.InvariantCulture)}");
        if (c.Aliases.Count > 0) parts.Add($"aliases: {string.Join(", ", c.Aliases)}");
        if (c.SameChat.Count > 0) parts.Add($"same chat as {string.Join(", ", c.SameChat)}, so these rules apply to it too");
        if (!string.IsNullOrWhiteSpace(c.Notes)) parts.Add(c.Notes);
        return string.Join(" · ", parts);
    }

    /// <summary>Case-insensitive, over nickname, name, @username, id and aliases.</summary>
    public static IReadOnlyList<UiContact> Filter(IReadOnlyList<UiContact> contacts, string query)
    {
        var q = query.Trim();
        if (q.Length == 0) return contacts;
        bool Has(string? s) => s?.Contains(q, StringComparison.OrdinalIgnoreCase) == true;
        return contacts.Where(c =>
            Has(c.Nickname) || Has(c.Name) || (c.Username is not null && Has("@" + c.Username)) ||
            Has(c.ChatId.ToString(CultureInfo.InvariantCulture)) || c.Aliases.Any(Has)).ToList();
    }

    public static bool CanRename(UiContact c, string typed)
    {
        var t = typed.Trim();
        return t.Length > 0 && t != c.Nickname;
    }

    public static ContactKind Kind(UiContact c) => c.Type switch
    {
        "user" => ContactKind.Person,
        "bot" => ContactKind.Bot,
        "group" => ContactKind.Group,
        "channel" => ContactKind.Channel,
        _ => ContactKind.Chat,
    };
}
