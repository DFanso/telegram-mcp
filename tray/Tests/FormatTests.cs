using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

public class FormatTests
{
    static readonly DateTimeOffset Now = new(2026, 11, 2, 8, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(0, "now")]
    [InlineData(59, "now")]
    [InlineData(60, "1m")]
    [InlineData(59 * 60 + 59, "59m")]
    [InlineData(3600, "1h")]
    [InlineData(23 * 3600, "23h")]
    [InlineData(86400, "1d")]
    [InlineData(3 * 86400 + 5, "3d")]
    [InlineData(-30, "now")] // a clock a little ahead
    public void Ago_is_short(int secondsAgo, string expected)
    {
        Assert.Equal(expected, Format.Ago(Now.AddSeconds(-secondsAgo), Now));
    }

    [Theory]
    [InlineData(1, "1")]
    [InlineData(99, "99")]
    [InlineData(100, "99+")]
    public void Badge_caps_at_99(int n, string expected)
    {
        Assert.Equal(expected, Format.BadgeText(n));
    }

    const string Footer = "\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ";

    [Fact]
    public void Strip_footer_removes_it_from_the_end()
    {
        Assert.Equal("Deployed v2.3", Format.StripFooter("Deployed v2.3" + Footer, Footer));
    }

    [Fact]
    public void Strip_footer_leaves_a_message_without_it()
    {
        Assert.Equal("Deployed v2.3", Format.StripFooter("  Deployed v2.3\n", Footer));
    }

    [Fact]
    public void Strip_footer_with_no_footer_configured_only_trims()
    {
        Assert.Equal("hi", Format.StripFooter("hi\n\n", ""));
    }

    [Theory]
    [InlineData("auto", "auto-sent")]
    [InlineData("away", "away reply")]
    [InlineData("menubar", "approved in the tray")]
    [InlineData("dialog", "approved in the dialog")]
    [InlineData("chat", "approved in chat")]
    public void Via_says_how_it_was_approved(string via, string expected)
    {
        Assert.Equal(expected, Format.ViaLabel(via));
    }

    [Theory]
    [InlineData("Leo Gavin", "LG")]
    [InlineData("leo", "L")]
    [InlineData("team-qa", "TQ")]
    [InlineData("@anna_k", "AK")]
    [InlineData("Ruchira and Ruchira", "RR")]
    [InlineData("✨ Zuse Gaming Club", "ZC")]
    [InlineData("✨", "?")]
    [InlineData("", "?")]
    [InlineData("Leo Perera [leo]", "LP")]
    [InlineData("Anna [anna k]", "A")]
    [InlineData("[leo]", "L")]
    public void Initials_are_one_or_two_letters(string name, string expected)
    {
        Assert.Equal(expected, Format.Initials(name));
    }

    [Fact]
    public void Avatar_colour_is_stable_and_in_range()
    {
        var a = Format.AvatarIndex("leo", 8);
        Assert.Equal(a, Format.AvatarIndex("LEO", 8));
        Assert.InRange(a, 0, 7);
        Assert.True(Enumerable.Range(0, 50).Select(i => Format.AvatarIndex($"chat{i}", 8)).Distinct().Count() >= 6); // spread out
    }

    [Fact]
    public void A_long_draft_runs_past_four_lines()
    {
        Assert.False(Format.IsLongDraft("hi"));
        Assert.False(Format.IsLongDraft(new string('x', 220)));          // 4 lines of 55
        Assert.True(Format.IsLongDraft(new string('x', 221)));           // a 5th line
        Assert.False(Format.IsLongDraft("a\nb\nc\nd"));                 // 4 short lines
        Assert.True(Format.IsLongDraft("a\nb\nc\nd\ne"));              // 5 short lines
        Assert.True(Format.IsLongDraft("a\n\n\n" + new string('x', 60))); // blank lines count, and a wrapped one is 2
    }
}
