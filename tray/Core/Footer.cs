using System.Text;

namespace TelegramMCPTray.Core;

/// <summary>How the footer sits under a message: after a blank line, on the next line, or on the same line.</summary>
public enum FooterSpacing { BlankLine, NewLine, SameLine }

/// <summary>Letter styles Telegram shows as plain text (Unicode look-alikes), so they survive any client.</summary>
public enum FooterStyle { Plain, SmallCaps, Bold, Italic, Mono }

/// <summary>
/// The Footer tab: the footer split into its spacing and its words, the letter styles, and the same
/// checks the daemon makes (src/shared/footer.ts). The daemon does the saving.
/// </summary>
public static class Footer
{
    public const int Max = 300;
    public const string Default = "\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ";
    public const string OlderDaemon = "The daemon is older than this app. Restart it to edit the footer here.";

    /// <summary>The message the preview puts the footer under.</summary>
    public const string Sample = "Sure, I'll send it over tonight.";

    /// <summary>Ready-made footers to start from.</summary>
    public static readonly IReadOnlyList<string> Ideas =
    [
        "✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ",
        "🤖 Sent by my assistant",
        "— sent with Claude",
        "⚡ ᴀᴜᴛᴏ-ʀᴇᴘʟʏ",
    ];

    /// <summary>The leading line breaks, and the words after them.</summary>
    public static (FooterSpacing Spacing, string Body) Split(string footer)
    {
        var body = footer.TrimStart('\r', '\n', ' ', '\t');
        var lead = footer[..(footer.Length - body.Length)].Replace("\r", "", StringComparison.Ordinal);
        var breaks = lead.Count(c => c == '\n');
        return (breaks >= 2 ? FooterSpacing.BlankLine : breaks == 1 ? FooterSpacing.NewLine : FooterSpacing.SameLine, body.TrimEnd());
    }

    public static string Compose(FooterSpacing spacing, string body) => spacing switch
    {
        FooterSpacing.BlankLine => "\n\n",
        FooterSpacing.NewLine => "\n",
        _ => " ",
    } + body.Trim();

    /// <summary>The first problem with the words as typed, or null.</summary>
    public static string? Check(string body)
    {
        // The daemon's footerProblem (src/shared/footer.ts) makes the same checks.
        var text = body.Replace("\r\n", "\n", StringComparison.Ordinal).Trim();
        if (text.Any(c => (c < ' ' && c != '\n') || c is >= '\u007f' and <= '\u009f')) return "Remove the control characters.";
        if (text.Any(c => c is '؜' or '‎' or '‏' or (>= '‪' and <= '‮') or (>= '⁦' and <= '⁩')))
            return "Remove the text direction marks.";
        if (text.All(c => char.IsWhiteSpace(c) || c is '­' or '᠎' or (>= '​' and <= '‍') or '⁠' or '﻿'))
            return "Write something, or switch the footer off.";
        if (text.Length + 2 > Max) return $"The footer is too long ({Max - 2} characters at most).";
        return null;
    }

    /// <summary>What a message would look like with this footer (withFooter in src/shared/policy.ts).</summary>
    public static string Preview(string message, string footer) => Away.Preview(message, null, footer);

    // ---- letter styles ---------------------------------------------------------------------

    const string SmallCapsLetters = "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ";

    /// <summary>First code points of A, a and 0 in each mathematical alphabet (no digits: -1).</summary>
    static readonly Dictionary<FooterStyle, (int Upper, int Lower, int Digit)> Alphabets = new()
    {
        [FooterStyle.Bold] = (0x1D5D4, 0x1D5EE, 0x1D7EC), // sans-serif bold
        [FooterStyle.Italic] = (0x1D608, 0x1D622, -1), // sans-serif italic
        [FooterStyle.Mono] = (0x1D670, 0x1D68A, 0x1D7F6), // monospace
    };

    static readonly Dictionary<int, char> ToPlain = BuildPlain();

    static Dictionary<int, char> BuildPlain()
    {
        var map = new Dictionary<int, char>();
        for (var i = 0; i < 26; i++)
        {
            if (SmallCapsLetters[i] is var sc && sc != (char)('a' + i)) map[sc] = (char)('a' + i);
            foreach (var (upper, lower, _) in Alphabets.Values)
            {
                map[upper + i] = (char)('A' + i);
                map[lower + i] = (char)('a' + i);
            }
        }
        foreach (var (_, _, digit) in Alphabets.Values)
            if (digit >= 0)
                for (var i = 0; i < 10; i++) map[digit + i] = (char)('0' + i);
        return map;
    }

    /// <summary>Back to ordinary letters, whatever style they were in.</summary>
    public static string Plain(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var r in text.EnumerateRunes())
        {
            if (ToPlain.TryGetValue(r.Value, out var c)) sb.Append(c);
            else sb.Append(r.ToString());
        }
        return sb.ToString();
    }

    /// <summary>The text in another style. Emoji, punctuation and other scripts stay as they are.</summary>
    public static string Restyle(string text, FooterStyle style)
    {
        var plain = Plain(text);
        if (style == FooterStyle.Plain) return plain;
        var sb = new StringBuilder(plain.Length * 2);
        foreach (var r in plain.EnumerateRunes())
        {
            var v = r.Value;
            if (style == FooterStyle.SmallCaps)
            {
                sb.Append(v is >= 'a' and <= 'z' ? SmallCapsLetters[v - 'a'] : r.ToString());
                continue;
            }
            var (upper, lower, digit) = Alphabets[style];
            var mapped = v switch
            {
                >= 'A' and <= 'Z' => upper + (v - 'A'),
                >= 'a' and <= 'z' => lower + (v - 'a'),
                >= '0' and <= '9' when digit >= 0 => digit + (v - '0'),
                _ => -1,
            };
            sb.Append(mapped >= 0 ? char.ConvertFromUtf32(mapped) : r.ToString());
        }
        return sb.ToString();
    }

    /// <summary>The style most of its letters are in, for highlighting the chip.</summary>
    public static FooterStyle Detect(string text)
    {
        var counts = new Dictionary<FooterStyle, int>();
        foreach (var r in text.EnumerateRunes())
        {
            var style = r.Value switch
            {
                _ when SmallCapsLetters.Contains(r.ToString(), StringComparison.Ordinal) && r.Value is not ('s' or 'x') => FooterStyle.SmallCaps,
                _ when In(r.Value, FooterStyle.Bold) => FooterStyle.Bold,
                _ when In(r.Value, FooterStyle.Italic) => FooterStyle.Italic,
                _ when In(r.Value, FooterStyle.Mono) => FooterStyle.Mono,
                >= 'A' and <= 'Z' or >= 'a' and <= 'z' => FooterStyle.Plain,
                _ => (FooterStyle?)null,
            };
            if (style is { } s) counts[s] = counts.GetValueOrDefault(s) + 1;
        }
        return counts.Count == 0 ? FooterStyle.Plain : counts.MaxBy(kv => kv.Value).Key;
    }

    static bool In(int v, FooterStyle style)
    {
        var (upper, lower, digit) = Alphabets[style];
        return v >= upper && v < upper + 26 || v >= lower && v < lower + 26 || digit >= 0 && v >= digit && v < digit + 10;
    }

    public static string StyleLabel(FooterStyle s) => s switch
    {
        FooterStyle.Plain => "Plain",
        FooterStyle.SmallCaps => Restyle("small caps", FooterStyle.SmallCaps),
        FooterStyle.Bold => Restyle("Bold", FooterStyle.Bold),
        FooterStyle.Italic => Restyle("Italic", FooterStyle.Italic),
        _ => Restyle("Mono", FooterStyle.Mono),
    };
}
