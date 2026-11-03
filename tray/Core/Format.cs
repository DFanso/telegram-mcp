using System.Globalization;

namespace TelegramMCPTray.Core;

public static class Format
{
    /// <summary>"now", "5m", "2h", "3d".</summary>
    public static string Ago(DateTimeOffset at, DateTimeOffset now)
    {
        var s = (long)(now - at).TotalSeconds;
        if (s < 60) return "now";
        if (s < 3600) return $"{s / 60}m";
        if (s < 86400) return $"{s / 3600}h";
        return $"{s / 86400}d";
    }

    public static string Waiting(int n) => $"{n} waiting for approval";

    public static string BadgeText(int n) => n > 99 ? "99+" : n.ToString(CultureInfo.InvariantCulture);

    /// <summary>The message without the footer, for the recent list (approval cards show the exact text).</summary>
    public static string StripFooter(string text, string footer)
    {
        var mark = footer.Trim();
        var t = text.Trim();
        return mark.Length == 0 || !t.EndsWith(mark, StringComparison.Ordinal) ? t : t[..^mark.Length].Trim();
    }

    /// <summary>
    /// Whether a draft runs past the 4 lines an approval card shows (about 55 characters a line), so
    /// the card offers Show all. Same rule as the menu bar app. Nothing opens on hover.
    /// </summary>
    public static bool IsLongDraft(string text) =>
        text.Split('\n').Sum(line => Math.Max(1, (line.Length + 54) / 55)) > 4;

    /// <summary>How a sent message was let through. The daemon calls the tray (like the menu bar) "menubar".</summary>
    public static string ViaLabel(string via) => via switch
    {
        "auto" => "auto-sent",
        "away" => "away reply",
        "menubar" => "approved in the tray",
        "dialog" => "approved in the dialog",
        _ => "approved in chat",
    };
}
