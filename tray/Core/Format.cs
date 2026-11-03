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

    /// <summary>
    /// One or two letters for an avatar: "Leo Gavin" → "LG", "team-qa" → "TQ", "@anna_k" → "AK",
    /// "leo" → "L". Emoji and symbols are skipped; nothing usable gives "?". A label's trailing
    /// " [nickname]" is not part of the name: "Leo Perera [leo]" → "LP", not "LL" (as in the menu bar app).
    /// </summary>
    public static string Initials(string name)
    {
        var open = name.LastIndexOf(" [", StringComparison.Ordinal);
        if (name.EndsWith(']') && open > 0) name = name[..open];
        var words = name.Split([' ', '-', '_', '.', '@', '(', ')'], StringSplitOptions.RemoveEmptyEntries)
            .Select(w => w.FirstOrDefault(char.IsLetterOrDigit))
            .Where(c => c != default)
            .ToList();
        if (words.Count == 0) return "?";
        var first = char.ToUpper(words[0], CultureInfo.InvariantCulture).ToString();
        return words.Count == 1 ? first : first + char.ToUpper(words[^1], CultureInfo.InvariantCulture);
    }

    /// <summary>Which of <paramref name="colours"/> an avatar gets: the same name always gets the same one.</summary>
    public static int AvatarIndex(string name, int colours)
    {
        uint h = 2166136261; // FNV-1a: string.GetHashCode changes from run to run
        foreach (var c in name.ToLowerInvariant())
        {
            h ^= c;
            h *= 16777619;
        }
        return (int)(h % (uint)colours);
    }

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
