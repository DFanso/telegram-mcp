using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>The Footer tab: spacing, letter styles and checks (the daemon's src/shared/footer.ts).</summary>
public class FooterTests
{
    [Theory]
    [InlineData("\n\n✨ sent", FooterSpacing.BlankLine, "✨ sent")]
    [InlineData("\r\n\r\n— me", FooterSpacing.BlankLine, "— me")]
    [InlineData("\nme", FooterSpacing.NewLine, "me")]
    [InlineData(" me ", FooterSpacing.SameLine, "me")]
    [InlineData("me", FooterSpacing.SameLine, "me")]
    public void Split_finds_the_spacing_and_the_words(string footer, FooterSpacing spacing, string body) =>
        Assert.Equal((spacing, body), Footer.Split(footer));

    [Fact]
    public void Compose_puts_them_back()
    {
        Assert.Equal("\n\nme", Footer.Compose(FooterSpacing.BlankLine, " me "));
        Assert.Equal("\nme", Footer.Compose(FooterSpacing.NewLine, "me"));
        Assert.Equal(" me", Footer.Compose(FooterSpacing.SameLine, "me"));
        Assert.Equal(Footer.Default, Footer.Compose(Footer.Split(Footer.Default).Spacing, Footer.Split(Footer.Default).Body));
    }

    [Fact]
    public void Check_wants_some_words_and_not_too_many()
    {
        Assert.Null(Footer.Check("me"));
        Assert.Equal("Write something, or switch the footer off.", Footer.Check("  "));
        Assert.Null(Footer.Check(new string('x', 298)));
        Assert.Equal("The footer is too long (298 characters at most).", Footer.Check(new string('x', 299)));
    }

    [Fact]
    public void Check_refuses_what_the_daemon_refuses()
    {
        Assert.Equal("Remove the control characters.", Footer.Check("hi\u0007"));
        Assert.Equal("Remove the text direction marks.", Footer.Check("‮evil"));
        Assert.Equal("Write something, or switch the footer off.", Footer.Check("​‍﻿ "));
        Assert.Null(Footer.Check("line one\r\nline two"));
        Assert.Null(Footer.Check("👨‍👩‍👧 ස්තූතියි"));
    }

    [Fact]
    public void Restyle_changes_letters_and_digits_and_leaves_the_rest()
    {
        Assert.Equal("✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ", Footer.Restyle("✨ sent via claude", FooterStyle.SmallCaps));
        Assert.Equal("𝗦𝗲𝗻𝘁 𝟮𝘅 🤖", Footer.Restyle("Sent 2x 🤖", FooterStyle.Bold));
        Assert.Equal("𝘚𝘦𝘯𝘵 2", Footer.Restyle("Sent 2", FooterStyle.Italic));
        Assert.Equal("𝚂𝚎𝚗𝚝 𝟸", Footer.Restyle("Sent 2", FooterStyle.Mono));
        // From one style to another, and back to plain.
        Assert.Equal("𝗦𝗲𝗻𝘁", Footer.Restyle(Footer.Restyle("Sent", FooterStyle.Mono), FooterStyle.Bold));
        Assert.Equal("Sent via claude 2", Footer.Restyle("𝗦𝗲𝗻𝘁 ᴠɪᴀ 𝚌𝚕𝚊𝚞𝚍𝚎 𝟮", FooterStyle.Plain));
    }

    [Fact]
    public void Detect_picks_the_style_most_letters_are_in()
    {
        Assert.Equal(FooterStyle.SmallCaps, Footer.Detect(Footer.Split(Footer.Default).Body));
        Assert.Equal(FooterStyle.Bold, Footer.Detect("𝗦𝗲𝗻𝘁 by"));
        Assert.Equal(FooterStyle.Plain, Footer.Detect("Sent by me"));
        Assert.Equal(FooterStyle.Plain, Footer.Detect("✨ 🤖"));
        Assert.Equal(FooterStyle.Mono, Footer.Detect(Footer.Restyle("monospace", FooterStyle.Mono)));
    }

    [Fact]
    public void Preview_adds_the_footer_once()
    {
        Assert.Equal("Hi\n\n— me", Footer.Preview("Hi", "\n\n— me"));
        Assert.Equal("Hi — me", Footer.Preview("Hi", " — me"));
    }

    [Fact]
    public void The_ideas_pass_the_check() => Assert.All(Footer.Ideas, i => Assert.Null(Footer.Check(i)));
}
