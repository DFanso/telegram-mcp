using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>TELEGRAM_MCP_SECRET_STORE=file: the token is a plain file in the home folder.</summary>
public sealed class FileTokenSourceTests : IDisposable
{
    readonly string _dir = Directory.CreateTempSubdirectory("tgmcp-token-").FullName;
    string TokenPath => Path.Combine(_dir, "token");

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void Reads_the_token_without_its_newline()
    {
        File.WriteAllText(TokenPath, "abc123\n");

        Assert.Equal("abc123", new FileTokenSource(TokenPath).Read().Token);
    }

    [Fact]
    public void A_missing_file_asks_again_soon()
    {
        var r = new FileTokenSource(TokenPath).Read();

        Assert.Null(r.Token);
        Assert.Equal("No token yet. Has the daemon run once? Start it with tgmcp daemon.", r.Problem);
        Assert.Equal(TimeSpan.FromSeconds(2), r.RetryAfter);
    }

    [Fact]
    public void An_empty_file_is_no_token()
    {
        File.WriteAllText(TokenPath, "  \n");

        Assert.Null(new FileTokenSource(TokenPath).Read().Token);
    }
}
