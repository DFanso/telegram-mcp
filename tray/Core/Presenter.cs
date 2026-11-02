namespace TelegramMCPTray.Core;

public enum StatusKind { Good, Busy, Bad, Off }

public sealed record Status(StatusKind Kind, string Text);

/// <summary>Good = green, Warn = orange, Bad = red, Info = blue, Muted = gray.</summary>
public enum TagKind { Good, Warn, Bad, Info, Muted }

public sealed record Tag(string Text, TagKind Kind);

/// <summary>The tray icon: a filled plane while a session listens, and a badge (count or "!").</summary>
public sealed record IconState(bool Filled, string? Badge);

/// <summary>A chat you sent to recently, with the messages sent there (newest first).</summary>
public sealed record RecentChat(long ChatId, string Label, IReadOnlyList<SentRecord> Messages);

/// <summary>What the panel and the tray icon say, worked out from the daemon's state.</summary>
public static class Presenter
{
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
        var waiting = reachable ? state?.Approvals.Count ?? 0 : 0;
        if (waiting > 0) return new(filled, Format.BadgeText(waiting));
        var healthy = reachable && state?.Telegram.Phase == "connected";
        return new(filled, healthy ? null : "!");
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
