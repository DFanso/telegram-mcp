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
    [InlineData("menubar", "approved in the tray")]
    [InlineData("dialog", "approved in the dialog")]
    [InlineData("chat", "approved in chat")]
    public void Via_says_how_it_was_approved(string via, string expected)
    {
        Assert.Equal(expected, Format.ViaLabel(via));
    }
}
