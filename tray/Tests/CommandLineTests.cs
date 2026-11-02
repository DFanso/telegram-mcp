using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>The Run key's command line, quoted so Windows hands the app back the same arguments.</summary>
public class CommandLineTests
{
    [Theory]
    [InlineData("--port", "--port")]
    [InlineData(@"C:\Users\Ann Lee\.config\telegram-mcp", @"""C:\Users\Ann Lee\.config\telegram-mcp""")]
    [InlineData("", @"""""")]
    [InlineData(@"say ""hi""", @"""say \""hi\""""")]
    [InlineData(@"C:\dir with space\", @"""C:\dir with space\\""")]
    [InlineData(@"C:\plain\", @"C:\plain\")]
    public void Quotes_only_what_needs_it(string arg, string expected)
    {
        Assert.Equal(expected, CommandLine.Quote(arg));
    }

    [Fact]
    public void Joins_the_program_and_its_arguments()
    {
        Assert.Equal(@"""C:\Program Files\T\TelegramMCPTray.exe"" --home ""C:\Users\Ann Lee\x"" --port 47901",
            CommandLine.Join(@"C:\Program Files\T\TelegramMCPTray.exe", ["--home", @"C:\Users\Ann Lee\x", "--port", "47901"]));
    }
}
