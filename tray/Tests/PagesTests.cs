using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

public class PagesTests
{
    static UiPage Page(string id, string state) =>
        new(id, "command", state, "Anna", "Anna", 12, 7, "prod is down", DateTimeOffset.UnixEpoch, null);

    [Fact]
    public void Snoozed_pages_do_not_ring()
    {
        var ringing = Pages.Ringing([Page("pg_1", "ringing"), Page("pg_2", "snoozed"), Page("pg_3", "unanswered")]);
        Assert.Equal(["pg_1", "pg_3"], ringing.Select(p => p.Id));
        Assert.Empty(Pages.Ringing(null));
    }

    [Fact]
    public void Message_links()
    {
        Assert.Equal("tg://openmessage?user_id=12&message_id=7", Pages.MessageUri(12, 7)!.OriginalString);
        Assert.Equal("https://t.me/c/1234567890/9", Pages.MessageUri(-1001234567890, 9)!.ToString());
        Assert.Equal("tg://openmessage?chat_id=5025527257&message_id=3", Pages.MessageUri(-5025527257, 3)!.OriginalString);
        Assert.Null(Pages.MessageUri(12, null));
    }

    [Fact]
    public void The_alarm_is_a_valid_wav()
    {
        var wav = Pages.AlarmWav();
        Assert.Equal("RIFF"u8.ToArray(), wav[..4]);
        Assert.Equal("WAVE"u8.ToArray(), wav[8..12]);
        Assert.Equal(wav.Length - 8, BitConverter.ToInt32(wav, 4));
        Assert.Equal(44_100, BitConverter.ToInt32(wav, 24));
    }

    [Fact]
    public void Parses_pages_and_older_daemons()
    {
        const string json = """
        {"telegram":{"phase":"connected","me":null,"lastError":null,"reconnects":0},"configError":null,"footer":"",
         "approvals":[],"sessions":[],"recent":[],
         "pages":[{"id":"pg_a1","source":"claude","state":"unanswered","from":"Claude (kyc)","chat":null,"chatId":null,
                   "messageId":null,"reason":"KYC 500s","createdAt":"2026-11-02T10:00:00.000Z","snoozedUntil":null}]}
        """;
        var page = Json.ParseState(json).Pages![0];
        Assert.Equal("pg_a1", page.Id);
        Assert.True(page.Ringing);
        Assert.Null(Fixtures.DemoState().Pages);
    }
}
