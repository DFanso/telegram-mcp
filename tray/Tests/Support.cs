using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

static class Fixtures
{
    static readonly string DemoJson = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "ui-state-demo.json"));

    public static UiState DemoState() => Json.ParseState(DemoJson);

    /// <summary>The demo state with extra top-level fields (written as JSON members) spliced in.</summary>
    public static string WithContacts(string members) => DemoJson.TrimEnd().TrimEnd('}') + "," + members + "}";
}

/// <summary>A token source that counts its reads.</summary>
sealed class FakeTokens(params TokenRead[] reads) : ITokenSource
{
    public int Reads { get; private set; }

    public TokenRead Read() => reads[Math.Min(Reads++, reads.Length - 1)];
}

sealed class ManualTime(DateTimeOffset start) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = start;

    public override DateTimeOffset GetUtcNow() => Now;
}

/// <summary>The network under DaemonApi: records each request and answers from a queue.</summary>
sealed class StubHandler : HttpMessageHandler
{
    readonly Queue<Func<HttpResponseMessage>> _answers = new();
    public List<(HttpMethod Method, Uri Uri, string? Auth, string? Body)> Requests { get; } = [];

    public StubHandler Answer(HttpStatusCode code, string body)
    {
        _answers.Enqueue(() => new HttpResponseMessage(code) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        return this;
    }

    public StubHandler Refuse()
    {
        _answers.Enqueue(() => throw new HttpRequestException("Connection refused", new SocketException((int)SocketError.ConnectionRefused)));
        return this;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var body = req.Content is null ? null : await req.Content.ReadAsStringAsync(ct);
        Requests.Add((req.Method, req.RequestUri!, req.Headers.Authorization?.ToString(), body));
        return _answers.Dequeue()();
    }
}

/// <summary>
/// scripts/demo-daemon.ts (a daemon with a fake Telegram) on a free port and its own home, so it
/// never touches /tmp/tgmcp-demo or port 47901 that someone working on the menu bar may be using.
/// </summary>
public sealed class DemoDaemon : IAsyncLifetime
{
    Process? _process;
    public int Port { get; } = FreePort();
    public string Home { get; } = Path.Combine(Path.GetTempPath(), $"tgmcp-tray-test-{Guid.NewGuid():N}");

    static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    static string RepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "scripts", "demo-daemon.ts"))) return dir.FullName;
        }
        throw new InvalidOperationException("Could not find the repository (scripts/demo-daemon.ts) above the test binaries.");
    }

    public async ValueTask InitializeAsync()
    {
        var psi = new ProcessStartInfo("bun", ["scripts/demo-daemon.ts"])
        {
            WorkingDirectory = RepoRoot(),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment["DEMO_PORT"] = Port.ToString();
        psi.Environment["DEMO_HOME"] = Home;
        _process = Process.Start(psi) ?? throw new InvalidOperationException("bun did not start");
        var line = await _process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(30));
        if (line?.StartsWith("demo daemon on") != true)
        {
            throw new InvalidOperationException($"The demo daemon did not start: {await _process.StandardError.ReadToEndAsync()}");
        }
    }

    public ValueTask DisposeAsync()
    {
        if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true);
        _process?.Dispose();
        try { Directory.Delete(Home, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        return ValueTask.CompletedTask;
    }
}
