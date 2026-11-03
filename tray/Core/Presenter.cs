namespace TelegramMCPTray.Core;

public enum StatusKind { Good, Busy, Bad, Off }

public sealed record Status(StatusKind Kind, string Text);

/// <summary>Good = green, Warn = orange, Bad = red, Info = blue, Muted = gray.</summary>
public enum TagKind { Good, Warn, Bad, Info, Muted }

public sealed record Tag(string Text, TagKind Kind);

/// <summary>
/// The tray icon: the plane coloured by <paramref name="Health"/> (blue online, yellow reconnecting,
/// red logged out, grey offline), a green dot while a session listens (<paramref name="Filled"/>),
/// and a badge: the count of drafts waiting, or "!".
/// </summary>
public sealed record IconState(bool Filled, string? Badge, StatusKind Health = StatusKind.Good);

/// <summary>A chat you sent to recently, with the messages sent there (newest first).</summary>
public sealed record RecentChat(long ChatId, string Label, IReadOnlyList<SentRecord> Messages);

/// <summary>A tile at the top of Home: "Waiting 2 · needs you".</summary>
public sealed record Stat(string Label, string Value, Tag Chip);

/// <summary>What the panel and the tray icon say, worked out from the daemon's state.</summary>
public static class Presenter
{
    /// <summary>
    /// Home's three tiles: drafts waiting, chats being listened to, saved chats. The chip says in a
    /// word whether that needs you ("needs you", "idle"...).
    /// </summary>
    public static IReadOnlyList<Stat> Stats(UiState state)
    {
        var waiting = state.Approvals.Count;
        var sessions = Listening(state);
        var chats = sessions.SelectMany(s => s.Watches).Select(w => w.ChatId).Distinct().Count();
        var connected = sessions.Count(s => s.Connected);
        var contacts = state.Contacts;
        var replying = contacts?.Count(c => c.AutoReply) ?? 0;
        return
        [
            new("Waiting", Count(waiting), waiting > 0 ? new("needs you", TagKind.Warn) : new("all clear", TagKind.Good)),
            new("Listening", Count(chats), connected > 0
                ? new($"{connected} session{(connected == 1 ? "" : "s")}", TagKind.Good)
                : new(sessions.Count > 0 ? "session gone" : "idle", TagKind.Muted)),
            new("Contacts", contacts is null ? "–" : Count(contacts.Count), replying > 0
                ? new($"{replying} auto-reply", TagKind.Info)
                : new("saved", TagKind.Muted)),
        ];
    }

    static string Count(int n) => n.ToString(System.Globalization.CultureInfo.InvariantCulture);

    public static Status Header(UiState? state, bool reachable)
    {
        var phase = reachable ? state?.Telegram.Phase ?? "" : "unreachable";
        var me = state?.Telegram.Me;
        return phase switch
        {
            "connected" => new(StatusKind.Good, $"Connected as {me?.Name ?? "?"}{(me?.Username is { } u ? $" (@{u})" : "")}"),
            "connecting" or "starting" => new(StatusKind.Busy, "Reconnecting… (it retries on its own)"),
            "logged_out" => new(StatusKind.Bad, "Logged out. Run tgmcp login"),
            "no_credentials" => new(StatusKind.Bad, "No API credentials. Run tgmcp login"),
            _ => new(StatusKind.Off, "Daemon not reachable"),
        };
    }

    /// <summary>The last five chats sent to; <paramref name="recent"/> is newest first.</summary>
    public static IReadOnlyList<RecentChat> RecentChats(IReadOnlyList<SentRecord> recent) =>
        recent.GroupBy(r => r.ChatId) // keeps first-seen order, so the newest chat leads
            .Take(5)
            .Select(g => new RecentChat(g.Key, g.First().ChatLabel, g.ToList()))
            .ToList();

    public static IReadOnlyList<UiSession> Listening(UiState state) => state.Sessions.Where(s => s.Watches.Count > 0).ToList();

    /// <summary>
    /// The saved chat a watch listens to. Its auto-reply switch is what lets the daemon pass that chat's
    /// messages to sessions, so turning it off pauses listening (the watch stays) and on resumes it.
    /// Null when the chat isn't saved, or the daemon is older than the Contacts page.
    /// </summary>
    public static UiContact? ListeningSwitch(UiState state, long chatId) =>
        state.Contacts?.FirstOrDefault(c => c.ChatId == chatId);

    public static Tag SessionTag(UiSession s)
    {
        if (!s.Connected) return new("session gone", TagKind.Muted);
        if (s.Channel) return new("push", TagKind.Good);
        if (s.Monitors > 0) return new("Monitor on", TagKind.Good);
        return new(s.Pending > 0 ? $"Monitor off · {s.Pending} queued" : "Monitor off", TagKind.Warn);
    }

    /// <summary>
    /// The count of drafts waiting, else "!" when the daemon or Telegram is down. Unreachable shows
    /// "!" even with drafts from the last good poll: those can't be decided until it's back.
    /// </summary>
    public static IconState Icon(UiState? state, bool reachable)
    {
        var filled = state is not null && Listening(state).Count > 0;
        var health = Header(state, reachable).Kind;
        var waiting = reachable ? state?.Approvals.Count ?? 0 : 0;
        if (waiting > 0) return new(filled, Format.BadgeText(waiting), health);
        return new(filled, health == StatusKind.Good ? null : "!", health);
    }

    /// <summary>The tray tooltip; Windows cuts it at 127 characters.</summary>
    public static string Tooltip(UiState? state, bool reachable, string? problem)
    {
        var body = !reachable || state is null
            ? problem ?? Header(null, false).Text
            : state.Approvals.Count > 0
                ? Format.Waiting(state.Approvals.Count)
                : Header(state, true).Text;
        var text = $"Telegram MCP: {body}";
        return text.Length <= 127 ? text : text[..126] + "…";
    }
}
