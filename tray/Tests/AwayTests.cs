using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>The Away page words and checks (same words as the daemon's src/shared/away.ts).</summary>
public class AwayTests
{
    static UiAway A(bool enabled = true, bool active = false) =>
        new(enabled, "18:00", "09:00", "m", 30, active, null, "p");

    [Fact]
    public void Status_says_off_away_now_or_when_it_starts()
    {
        Assert.Equal("Off", Away.Status(A(enabled: false)));
        Assert.Equal("Away now, until 09:00", Away.Status(A(active: true)));
        Assert.Equal("Starts at 18:00", Away.Status(A()));
    }

    [Fact]
    public void Badge_shows_only_while_away()
    {
        Assert.Equal("Away until 09:00", Away.Badge(A(active: true)));
        Assert.Null(Away.Badge(A()));
        Assert.Null(Away.Badge(A(enabled: false)));
        Assert.Null(Away.Badge(null));
    }

    [Theory]
    [InlineData("18:00", true)]
    [InlineData("00:00", true)]
    [InlineData("23:59", true)]
    [InlineData("24:00", false)]
    [InlineData("9:00", false)]
    [InlineData("18:60", false)]
    [InlineData("18:00\n", false)]
    [InlineData("", false)]
    public void IsTime_is_24_hour_hh_mm(string s, bool expected) => Assert.Equal(expected, Away.IsTime(s));

    [Fact]
    public void Check_returns_the_daemons_words()
    {
        Assert.Null(Away.Check("18:00", "09:00", "hi"));
        Assert.Equal("from must be a time like 18:00", Away.Check("6pm", "09:00", "hi"));
        Assert.Equal("until must be a time like 18:00", Away.Check("18:00", "9", "hi"));
        Assert.Equal("From and until can't be the same time.", Away.Check("18:00", "18:00", "hi"));
        Assert.Equal("The message can't be empty.", Away.Check("18:00", "09:00", "  "));
        Assert.Null(Away.Check("18:00", "09:00", new string('x', 1000)));
        Assert.Equal("The message is too long (1000 characters at most).", Away.Check("18:00", "09:00", new string('x', 1001)));
    }
}
