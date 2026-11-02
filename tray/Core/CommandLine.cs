using System.Text;

namespace TelegramMCPTray.Core;

/// <summary>Windows command lines, quoted the way CommandLineToArgvW (and .NET) split them back.</summary>
public static class CommandLine
{
    public static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny([' ', '\t', '"']) < 0) return arg;
        var sb = new StringBuilder("\"");
        var slashes = 0;
        foreach (var ch in arg)
        {
            if (ch == '\\')
            {
                slashes++;
                continue;
            }
            // Backslashes count only before a quote: double them there, and escape the quote.
            sb.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
            slashes = 0;
            sb.Append(ch);
        }
        return sb.Append('\\', slashes * 2).Append('"').ToString();
    }

    public static string Join(string program, IEnumerable<string> args) =>
        string.Join(" ", args.Prepend(program).Select(Quote));
}
