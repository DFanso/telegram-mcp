using System.Text.RegularExpressions;

namespace TelegramMCPTray.Core;

/// <summary>
/// The Away page: the words for the away auto-reply state and the same checks the daemon makes
/// (src/shared/away.ts), so a mistake is caught before the call. The daemon does the saving.
/// </summary>
public static class Away
{
    /// <summary>A 404 from POST /ui/away, or no away in /ui/state.</summary>
    public const string OlderDaemon = "The daemon is older than this app. Restart it to set away hours.";

    public const int MessageMax = 1000;

    static readonly Regex TimeRe = new(@"^([01][0-9]|2[0-3]):[0-5][0-9]\z", RegexOptions.CultureInvariant);

    public static string Status(UiAway a) =>
        !a.Enabled ? "Off" : a.Active ? $"Away now, until {a.Until}" : $"Starts at {a.From}";

    /// <summary>The line for the Status page while a reply could go out; null otherwise.</summary>
    public static string? Badge(UiAway? a) => a is { Enabled: true, Active: true } ? $"Away until {a.Until}" : null;

    public static bool IsTime(string s) => TimeRe.IsMatch(s);

    /// <summary>The first problem, in the daemon's words, or null when the three fields are fine.</summary>
    public static string? Check(string from, string until, string message)
    {
        if (!IsTime(from)) return "from must be a time like 18:00";
        if (!IsTime(until)) return "until must be a time like 18:00";
        if (from == until) return "From and until can't be the same time.";
        if (message.Trim() == "") return "The message can't be empty.";
        if (message.Length > MessageMax) return $"The message is too long ({MessageMax} characters at most).";
        return null;
    }
}
