using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>Fixtures/ui-state-demo.json is GET /ui/state from scripts/demo-daemon.ts.</summary>
public class JsonTests
{
    [Fact]
    public void Parses_what_the_demo_daemon_sends()
    {
        var s = Fixtures.DemoState();

        Assert.Equal("connected", s.Telegram.Phase);
        Assert.Equal("Me", s.Telegram.Me?.Name);
        Assert.Equal("me_user", s.Telegram.Me?.Username);
        Assert.Equal("\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ", s.Footer);
        Assert.Equal(2, s.Approvals.Count);
        Assert.Equal(2, s.Sessions.Count);
        Assert.Equal(3, s.Recent.Count);
    }

    [Fact]
    public void Parses_approvals()
    {
        var (listed, first) = (Fixtures.DemoState().Approvals[0], Fixtures.DemoState().Approvals[1]);

        Assert.StartsWith("a_", listed.Id);
        Assert.Equal("Team QA [team-qa] · topic 42", listed.To);
        Assert.False(listed.FirstTime);
        Assert.Equal("team-qa", listed.Nickname);
        Assert.Equal(new DateTimeOffset(2026, 11, 2, 8, 6, 23, 52, TimeSpan.Zero), listed.CreatedAt);
        Assert.Equal(listed.CreatedAt.AddMinutes(20), listed.ExpiresAt);

        Assert.True(first.FirstTime);
        Assert.Null(first.Nickname);
        Assert.Equal("leonardo", first.SuggestedNickname);
    }

    [Fact]
    public void Parses_sessions_and_watches()
    {
        var api = Fixtures.DemoState().Sessions[0];

        Assert.Equal("api-server · pid 4121", api.Label);
        Assert.True(api.Connected);
        var watch = Assert.Single(api.Watches);
        Assert.Equal(12, watch.ChatId);
        Assert.Equal("waiting for the staging link", watch.Note);
        Assert.Null(watch.FromLabel);
        Assert.Null(watch.TopicId);
    }

    [Fact]
    public void Parses_recent_sends()
    {
        var r = Fixtures.DemoState().Recent[0];

        Assert.Equal(10, r.ChatId);
        Assert.Equal("Leo Perera [leo]", r.ChatLabel);
        Assert.Equal("auto", r.Via);
        Assert.Equal("api-server · pid 4121", r.SessionLabel);
    }

    [Fact]
    public void A_daemon_without_contacts_leaves_them_null()
    {
        var s = Fixtures.DemoState();

        Assert.Null(s.Contacts);
        Assert.Null(s.DefaultPolicy);
    }

    [Fact]
    public void Parses_contacts_and_the_default_policy()
    {
        var s = Json.ParseState(Fixtures.WithContacts("""
            "defaultPolicy": "approve",
            "contacts": [{
              "nickname": "team-qa", "chatId": -1001234567890, "name": "Team QA", "username": null,
              "type": "group", "topicId": 42, "aliases": ["qa"], "notes": null,
              "sendMode": "requireApproval", "autoReply": false,
              "policy": "needs approval (requireApproval)", "sameChat": ["qa-team"]
            }]
            """));

        Assert.Equal("approve", s.DefaultPolicy);
        var c = Assert.Single(s.Contacts!);
        Assert.Equal("team-qa", c.Nickname);
        Assert.Equal(-1001234567890, c.ChatId);
        Assert.Equal(42, c.TopicId);
        Assert.Equal(["qa"], c.Aliases);
        Assert.Equal("requireApproval", c.SendMode);
        Assert.False(c.AutoReply);
        Assert.Equal(["qa-team"], c.SameChat);
    }
}
