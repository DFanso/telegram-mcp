using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Threading;
using Microsoft.Win32;
using TelegramMCPTray.Core;

namespace TelegramMCPTray;

/// <summary>
/// One tray app per user session. A second launch asks the running one to open its panel;
/// `--quit` asks it to quit (the CLI uses that before rebuilding, since a running exe can't be replaced).
/// </summary>
static class Instance
{
    const string MutexName = @"Local\TelegramMCPTray";
    const string ShowEvent = @"Local\TelegramMCPTray.Show";
    const string QuitEvent = @"Local\TelegramMCPTray.Quit";

    static EventWaitHandle? _show, _quit;

    /// <summary>Null when another copy is already running.</summary>
    public static Mutex? TryOwn()
    {
        var m = new Mutex(true, MutexName, out var created);
        if (created) return m;
        m.Dispose();
        return null;
    }

    public static void Listen(Dispatcher ui, Action onShow, Action onQuit)
    {
        _show = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEvent);
        _quit = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEvent);
        ThreadPool.RegisterWaitForSingleObject(_show, (_, _) => ui.InvokeAsync(onShow), null, Timeout.Infinite, false);
        ThreadPool.RegisterWaitForSingleObject(_quit, (_, _) => ui.InvokeAsync(onQuit), null, Timeout.Infinite, true);
    }

    public static void AskToShow() => Signal(ShowEvent);

    /// <summary>Asks a running copy to quit and waits for it to be gone. True if none is left.</summary>
    public static bool AskToQuit(TimeSpan wait)
    {
        Signal(QuitEvent);
        var until = DateTime.UtcNow + wait;
        while (DateTime.UtcNow < until)
        {
            if (!Mutex.TryOpenExisting(MutexName, out var m)) return true;
            m.Dispose();
            Thread.Sleep(100);
        }
        return false;
    }

    static void Signal(string name)
    {
        if (!EventWaitHandle.TryOpenExisting(name, out var e)) return;
        e.Set();
        e.Dispose();
    }
}

/// <summary>Start at login: a value under HKCU\...\Run (what Settings > Apps > Startup lists, and can turn off).</summary>
static class Autostart
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    /// <summary>Also in src/tray.ts (uninstall when the exe is gone).</summary>
    const string ValueName = "TelegramMCPTray";

    public static void Install(Settings settings)
    {
        var exe = Environment.ProcessPath ?? throw new InvalidOperationException("Can't tell where this app is.");
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        key.SetValue(ValueName, CommandLine.Join(exe, settings.LaunchArgs()));
    }

    public static void Uninstall()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        key?.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}

/// <summary>%LOCALAPPDATA%\TelegramMCPTray\tray.log: what went wrong, for a GUI app with no console.</summary>
static class Log
{
    static readonly string Path = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TelegramMCPTray", "tray.log");

    public static void Write(string line)
    {
        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            if (File.Exists(Path) && new FileInfo(Path).Length > 1_000_000)
            {
                File.WriteAllLines(Path, File.ReadLines(Path).TakeLast(1000));
            }
            File.AppendAllText(Path, $"{DateTimeOffset.Now:O} {line}{Environment.NewLine}");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Nowhere left to say it.
        }
    }
}
