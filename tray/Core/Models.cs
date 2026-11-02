using System.Text.Json;

namespace TelegramMCPTray.Core;

// What the daemon sends on GET /ui/state (src/shared/protocol.ts, UiState).

public sealed record Peer(long Id, string Name, string? Username);

public sealed record TelegramState(string Phase, Peer? Me, string? LastError, int Reconnects);

public sealed record WatchSpec(string Id, long ChatId, string ChatLabel, string? FromLabel, long? TopicId, string? Note);

public sealed record UiSession(
    string Id, string Label, bool Connected, bool Channel, int Monitors, int Pending, IReadOnlyList<WatchSpec> Watches);

public sealed record UiApproval(
    string Id, string To, string Detail, string Text, string Reason, string SessionLabel,
    DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt, bool FirstTime, string? Nickname, string SuggestedNickname);

public sealed record SentRecord(
    DateTimeOffset At, long ChatId, string ChatLabel, string Text, long MessageId, string Via, string? SessionLabel);

/// <summary>A saved chat and the rules that apply to it (the Contacts page).</summary>
public sealed record UiContact(
    string Nickname, long ChatId, string? Name, string? Username, string? Type, long? TopicId,
    IReadOnlyList<string> Aliases, string? Notes,
    /// <summary>"autoSend" | "requireApproval" | "blocked" | "none"</summary>
    string SendMode, bool AutoReply, string Policy, IReadOnlyList<string> SameChat);

public sealed record UiState(
    TelegramState Telegram, string? ConfigError, string Footer,
    IReadOnlyList<UiApproval> Approvals, IReadOnlyList<UiSession> Sessions, IReadOnlyList<SentRecord> Recent,
    /// <summary>Null from a daemon older than the Contacts page.</summary>
    IReadOnlyList<UiContact>? Contacts = null, string? DefaultPolicy = null);

public static class Json
{
    /// <summary>camelCase names; fields this app doesn't know are skipped, missing ones are null.</summary>
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    public static UiState ParseState(string json) =>
        JsonSerializer.Deserialize<UiState>(json, Options) ?? throw new JsonException("GET /ui/state returned null");
}
