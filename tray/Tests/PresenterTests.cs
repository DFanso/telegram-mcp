using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

public class PresenterTests
{
    static UiState WithPhase(string phase, Peer? me = null) =>
        Fixtures.DemoState() with { Telegram = new TelegramState(phase, me, null, 0) };

    [Fact]
    public void Header_when_the_daemon_is_unreachable()
    {
        Assert.Equal(new Status(StatusKind.Off, "Daemon not reachable"), Presenter.Header(null, reachable: false));
    }

    [Fact]
    public void Header_when_connected_names_the_account()
    {
        Assert.Equal(new Status(StatusKind.Good, "Connected as Me (@me_user)"), Presenter.Header(Fixtures.DemoState(), true));
        Assert.Equal("Connected as Me", Presenter.Header(WithPhase("connected", new Peer(1, "Me", null)), true).Text);
    }

    [Theory]
    [InlineData("connecting", StatusKind.Busy, "Reconnecting… (it retries on its own)")]
    [InlineData("starting", StatusKind.Busy, "Reconnecting… (it retries on its own)")]
    [InlineData("logged_out", StatusKind.Bad, "Logged out. Run tgmcp login")]
    [InlineData("no_credentials", StatusKind.Bad, "No API credentials. Run tgmcp login")]
    public void Header_for_each_phase(string phase, StatusKind kind, string text)
    {
        Assert.Equal(new Status(kind, text), Presenter.Header(WithPhase(phase), true));
    }

    [Fact]
    public void Recent_chats_group_sends_newest_chat_first()
    {
        // recent is newest first: leo, anna, leo.
        var chats = Presenter.RecentChats(Fixtures.DemoState().Recent);

        Assert.Equal([10L, 12L], chats.Select(c => c.ChatId));
        Assert.Equal("Leo Perera [leo]", chats[0].Label);
        Assert.Equal(2, chats[0].Messages.Count);
        Assert.Equal(Fixtures.DemoState().Recent[0], chats[0].Messages[0]);
    }

    [Fact]
    public void Recent_chats_keep_the_last_five()
    {
        var one = Fixtures.DemoState().Recent[0];
        var sends = Enumerable.Range(1, 7).Select(i => one with { ChatId = i, ChatLabel = $"chat {i}" }).ToList();

        Assert.Equal([1L, 2, 3, 4, 5], Presenter.RecentChats(sends).Select(c => c.ChatId));
    }

    [Fact]
    public void Listening_shows_only_sessions_with_watches()
    {
        var s = Fixtures.DemoState();
        var idle = s.Sessions[0] with { Id = "s_idle0000", Watches = [] };

        Assert.Equal(["s_api-serv", "s_web-app "], Presenter.Listening(s with { Sessions = [.. s.Sessions, idle] }).Select(x => x.Id));
    }

    [Fact]
    public void Session_tag_says_how_messages_reach_it()
    {
        var s = Fixtures.DemoState().Sessions[0];

        Assert.Equal(new Tag("session gone", TagKind.Muted), Presenter.SessionTag(s with { Connected = false, Channel = true }));
        Assert.Equal(new Tag("push", TagKind.Good), Presenter.SessionTag(s with { Channel = true }));
        Assert.Equal(new Tag("Monitor on", TagKind.Good), Presenter.SessionTag(s with { Monitors = 1 }));
        Assert.Equal(new Tag("Monitor off · 3 queued", TagKind.Warn), Presenter.SessionTag(s with { Pending = 3 }));
        Assert.Equal(new Tag("Monitor off", TagKind.Warn), Presenter.SessionTag(s));
    }

    [Fact]
    public void Icon_counts_waiting_drafts_and_fills_while_listening()
    {
        Assert.Equal(new IconState(Filled: true, Badge: "2"), Presenter.Icon(Fixtures.DemoState(), true));
    }

    [Fact]
    public void Icon_warns_when_unreachable_or_disconnected()
    {
        var quiet = Fixtures.DemoState() with { Approvals = [], Sessions = [] };

        Assert.Equal(new IconState(false, "!"), Presenter.Icon(null, false));
        Assert.Equal(new IconState(false, "!"), Presenter.Icon(quiet with { Telegram = new TelegramState("connecting", null, null, 1) }, true));
        Assert.Equal(new IconState(false, null), Presenter.Icon(quiet, true));
    }

    [Fact]
    public void Tooltip_puts_waiting_drafts_first()
    {
        Assert.Equal("Telegram MCP: 2 waiting for approval", Presenter.Tooltip(Fixtures.DemoState(), true, null));
        Assert.Equal("Telegram MCP: 1 waiting for approval",
            Presenter.Tooltip(Fixtures.DemoState() with { Approvals = [Fixtures.DemoState().Approvals[0]] }, true, null));
        Assert.Equal("Telegram MCP: Connected as Me (@me_user)",
            Presenter.Tooltip(Fixtures.DemoState() with { Approvals = [] }, true, null));
    }

    [Fact]
    public void Tooltip_shows_the_problem_and_fits_the_tray_limit()
    {
        Assert.Equal("Telegram MCP: no daemon", Presenter.Tooltip(null, false, "no daemon"));
        Assert.True(Presenter.Tooltip(null, false, new string('x', 300)).Length <= 127);
    }
}
