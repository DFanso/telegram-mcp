using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>The Windows notification for each draft: when it appears and goes, what it says, what its buttons do.</summary>
public class ApprovalNoticesTests
{
    static readonly UiApproval Listed = Fixtures.DemoState().Approvals[0];
    static readonly UiApproval First = Fixtures.DemoState().Approvals[1];

    [Fact]
    public void New_drafts_get_a_notice_and_settled_ones_lose_it()
    {
        var (show, remove) = ApprovalNotices.Diff(new HashSet<string> { Listed.Id, "a_gone0000" }, [Listed, First]);

        Assert.Equal([First], show);
        Assert.Equal(["a_gone0000"], remove);
    }

    [Fact]
    public void Nothing_changes_when_the_same_drafts_wait()
    {
        var (show, remove) = ApprovalNotices.Diff(new HashSet<string> { Listed.Id }, [Listed]);

        Assert.Empty(show);
        Assert.Empty(remove);
    }

    [Fact]
    public void A_listed_chat_offers_approve_and_deny()
    {
        var n = ApprovalNotices.Content(Listed);

        Assert.Equal("Approve Telegram message?", n.Title);
        Assert.Equal("To Team QA [team-qa] · topic 42 (Team QA · id -1001234567890 · group · forum)", n.Subtitle);
        Assert.Equal(Listed.Text, n.Body);
        Assert.Equal([new NoticeButton("Approve", NoticeAction.Approve), new NoticeButton("Deny", NoticeAction.Deny)], n.Buttons);
    }

    [Fact]
    public void A_first_message_also_picks_what_happens_next_time()
    {
        var n = ApprovalNotices.Content(First);

        Assert.Equal("First message to Leonardo Silva (@leonardo_s): approve?", n.Title);
        Assert.Equal(
            [
                new NoticeButton("Approve, ask next time", NoticeAction.Approve),
                new NoticeButton("Approve, always allow", NoticeAction.AlwaysAllow),
                new NoticeButton("Deny", NoticeAction.Deny),
            ],
            n.Buttons);
    }

    [Theory]
    [InlineData(NoticeAction.Approve, true, "requireApproval")]
    [InlineData(NoticeAction.AlwaysAllow, true, "autoSend")]
    [InlineData(NoticeAction.Deny, false, null)]
    public void Each_button_is_a_decision(NoticeAction action, bool approve, string? remember)
    {
        Assert.Equal(new Decision(approve, remember), ApprovalNotices.DecisionFor(action));
    }
}
