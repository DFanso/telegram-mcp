using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>Against the real daemon (with a fake Telegram): needs bun on the PATH.</summary>
public class DemoDaemonTests(DemoDaemon demo) : IClassFixture<DemoDaemon>
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    DaemonApi Api() => new(new HttpClient(), demo.Port, new FileTokenSource(Path.Combine(demo.Home, "token")));

    [Fact]
    public async Task Approving_a_draft_sends_it()
    {
        var api = Api();
        var before = (await api.PollAsync(Ct)).State!;
        var draft = before.Approvals.Single(a => !a.FirstTime);

        var r = await api.DecideAsync(draft.Id, new Decision(true), Ct);
        var after = (await api.PollAsync(Ct)).State!;

        Assert.True(r.Ok, r.Text);
        Assert.StartsWith("Approved", r.Text);
        Assert.DoesNotContain(after.Approvals, a => a.Id == draft.Id);
        Assert.Equal("menubar", after.Recent[0].Via);
        Assert.Equal(draft.To, after.Recent[0].ChatLabel);
    }

    [Fact]
    public async Task Approving_a_first_message_saves_the_chat_under_the_nickname()
    {
        var api = Api();
        var draft = (await api.PollAsync(Ct)).State!.Approvals.Single(a => a.FirstTime);

        var r = await api.DecideAsync(draft.Id, new Decision(true, "autoSend", "leonardo-s"), Ct);

        Assert.True(r.Ok, r.Text);
        Assert.Contains("Saved as \"leonardo-s\"", r.Text);
        Assert.Contains("whitelisted", r.Text);
    }

    [Fact]
    public async Task A_wrong_port_is_reported_as_no_daemon()
    {
        var r = await new DaemonApi(new HttpClient(), 1, new FileTokenSource(Path.Combine(demo.Home, "token"))).PollAsync(Ct);

        Assert.Equal("The daemon is not running. Start it with tgmcp daemon.", r.Problem);
    }
}
