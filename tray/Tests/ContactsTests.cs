using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>The Contacts page: the saved chats and what each control says (same words as the menu bar).</summary>
public class ContactsTests
{
    static UiContact C(
        string nickname = "team-qa", string sendMode = "requireApproval", bool autoReply = false,
        string? name = "Team QA", string? username = null, string? type = "group", long chatId = -1001234567890,
        long? topicId = null, string[]? aliases = null, string? notes = null, string[]? sameChat = null) =>
        new(nickname, chatId, name, username, type, topicId, aliases ?? [], notes, sendMode, autoReply, "policy", sameChat ?? []);

    [Theory]
    [InlineData("autoSend", "approve", "always allow", TagKind.Good)]
    [InlineData("requireApproval", "approve", "ask every time", TagKind.Warn)]
    [InlineData("blocked", "approve", "blocked", TagKind.Bad)]
    [InlineData("none", "approve", "not set", TagKind.Muted)]
    [InlineData("none", "block", "blocked by default", TagKind.Bad)]
    public void Mode_tag(string mode, string defaultPolicy, string text, TagKind kind)
    {
        Assert.Equal(new Tag(text, kind), Contacts.ModeTag(C(sendMode: mode), defaultPolicy));
    }

    [Fact]
    public void Auto_reply_tag_only_when_on()
    {
        Assert.Equal(new Tag("auto-reply", TagKind.Info), Contacts.AutoReplyTag(C(autoReply: true)));
        Assert.Null(Contacts.AutoReplyTag(C(autoReply: false)));
    }

    [Theory]
    [InlineData("Anna K", "anna_k", "Anna K · @anna_k")]
    [InlineData("Team QA", null, "Team QA")]
    [InlineData(null, "bot_x", "@bot_x")]
    [InlineData(null, null, "")]
    public void Subtitle_is_name_and_username(string? name, string? username, string expected)
    {
        Assert.Equal(expected, Contacts.Subtitle(C(name: name, username: username)));
    }

    [Theory]
    [InlineData("autoSend", true, "approve", "Messages go out without asking. Sessions may listen here and reply without asking while they do.")]
    [InlineData("autoSend", false, "approve", "Messages go out without asking. Sessions can't listen to this chat.")]
    [InlineData("requireApproval", false, "approve", "Every message waits for your approval. Sessions can't listen to this chat.")]
    [InlineData("requireApproval", true, "approve", "Every message waits for your approval. Sessions may listen here, but their replies still ask first.")]
    [InlineData("blocked", true, "approve", "Nothing is ever sent here. Sessions may listen here, but can't reply.")]
    [InlineData("none", false, "approve", "On no list yet: the next message asks you, and you pick what happens after. Sessions can't listen to this chat.")]
    [InlineData("none", true, "block", "On no list, so the default rule blocks it. Sessions may listen here and reply without asking while they do.")]
    public void Explanation_says_what_sending_and_replying_do(string mode, bool autoReply, string defaultPolicy, string expected)
    {
        Assert.Equal(expected, Contacts.Explanation(C(sendMode: mode, autoReply: autoReply), defaultPolicy));
    }

    [Fact]
    public void Details_list_what_is_known()
    {
        var full = C(topicId: 42, aliases: ["qa", "testers"], sameChat: ["qa-team"], notes: "QA topic");

        Assert.Equal("id -1001234567890 · topic 42 · aliases: qa, testers · same chat as qa-team, so these rules apply to it too · QA topic",
            Contacts.Details(full));
        Assert.Equal("id 10", Contacts.Details(C(chatId: 10)));
        Assert.Equal("id 10 · same chat as a, b, so these rules apply to it too", Contacts.Details(C(chatId: 10, sameChat: ["a", "b"])));
    }

    [Theory]
    [InlineData("TEAM", "team-qa")]
    [InlineData("anna k", "anna")]
    [InlineData("@anna_", "anna")]
    [InlineData("-100123", "team-qa")]
    [InlineData("testers", "team-qa")]
    public void Search_matches_nickname_name_username_id_and_aliases(string query, string expected)
    {
        UiContact[] all = [C(aliases: ["testers"]), C("anna", "autoSend", name: "Anna K", username: "anna_k", type: "user", chatId: 12)];

        Assert.Equal([expected], Contacts.Filter(all, query).Select(c => c.Nickname));
    }

    [Fact]
    public void Empty_search_shows_everyone()
    {
        UiContact[] all = [C("a"), C("b")];

        Assert.Equal(2, Contacts.Filter(all, "  ").Count);
    }

    [Fact]
    public void Summary_counts_saved_chats()
    {
        Assert.Equal("1 saved chat · changes save to config.json at once", Contacts.Summary(1));
        Assert.Equal("4 saved chats · changes save to config.json at once", Contacts.Summary(4));
    }

    [Theory]
    [InlineData("qa", true)]
    [InlineData(" team-qa ", false)]
    [InlineData("   ", false)]
    public void Rename_needs_a_different_name(string typed, bool expected)
    {
        Assert.Equal(expected, Contacts.CanRename(C(), typed));
    }

    [Theory]
    [InlineData("user", ContactKind.Person)]
    [InlineData("bot", ContactKind.Bot)]
    [InlineData("group", ContactKind.Group)]
    [InlineData("channel", ContactKind.Channel)]
    [InlineData(null, ContactKind.Chat)]
    public void Kind_picks_the_row_icon(string? type, ContactKind expected)
    {
        Assert.Equal(expected, Contacts.Kind(C(type: type)));
    }

    [Fact]
    public void Placeholders()
    {
        Assert.Equal("No saved chats yet. Approving the first message to a chat saves it.", Contacts.Empty);
        Assert.Equal("No saved chat matches “zed”", Contacts.NoMatch("zed"));
        Assert.Equal("The daemon is older than this app. Restart it to edit contacts.", Contacts.OlderDaemon);
        Assert.Equal("2 waiting for approval", Format.Waiting(2));
    }

    static UiContact Person(bool? pageable, bool? pageFrom) =>
        new("leo", 1188107983, "Leo F", "dfansoo", "user", null, [], null, "autoSend", false, "policy", [], pageable, pageFrom);

    [Theory]
    [InlineData("blocked", "approve", true)]
    [InlineData("none", "block", true)]
    [InlineData("none", "approve", false)]
    [InlineData("autoSend", "block", false)]
    [InlineData("requireApproval", "block", false)]
    public void Blocked_counts_the_default_rule(string mode, string defaultPolicy, bool blocked)
    {
        Assert.Equal(blocked, Contacts.Blocked(C(sendMode: mode), defaultPolicy));
    }

    [Fact]
    public void Can_page_me_tag_only_when_on()
    {
        Assert.Equal(new Tag("can page me", TagKind.Warn), Contacts.PageFromTag(Person(true, true)));
        Assert.Null(Contacts.PageFromTag(Person(true, false)));
        Assert.Null(Contacts.PageFromTag(Person(null, null))); // an older daemon
    }

    [Fact]
    public void Explanation_says_whether_their_page_rings_for_people_only()
    {
        Assert.EndsWith("Their /page rings you.", Contacts.Explanation(Person(true, true), "approve"));
        Assert.EndsWith("Their /page is ignored.", Contacts.Explanation(Person(true, false), "approve"));
        Assert.DoesNotContain("/page", Contacts.Explanation(C(), "approve")); // a group
        Assert.DoesNotContain("/page", Contacts.Explanation(Person(null, null), "approve"));
    }
}
