using System;
using System.Linq;
using System.Threading;
using System.Windows;
using System.Windows.Threading;
using TelegramMCPTray.Core;

namespace TelegramMCPTray;

/// <summary>
/// The tray companion for the telegram-mcp daemon on Windows, like the macOS menu bar app: approve or
/// deny drafts, see which Claude sessions listen to which chats, what was sent, and edit saved chats.
///
///   TelegramMCPTray.exe [--home DIR] [--port N] [--secret-store file]   run (one copy per user)
///   TelegramMCPTray.exe --install [same options]   start at login with these options, then exit
///   TelegramMCPTray.exe --uninstall                stop starting at login, quit the running copy
///   TelegramMCPTray.exe --quit                     quit the running copy
/// </summary>
public partial class App : Application
{
    Mutex? _single;
    TrayController? _tray;

    static string UserProfile() =>
        Environment.GetEnvironmentVariable("USERPROFILE") is { Length: > 0 } p ? p : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var args = e.Args;
        var settings = Settings.Load(args, Environment.GetEnvironmentVariable, UserProfile());
        try
        {
            if (args.Contains("--install"))
            {
                Autostart.Install(settings);
                Shutdown(0);
                return;
            }
            if (args.Contains("--uninstall"))
            {
                Autostart.Uninstall();
                Shutdown(Instance.AskToQuit(TimeSpan.FromSeconds(5)) ? 0 : 1);
                return;
            }
            if (args.Contains("--quit"))
            {
                Shutdown(Instance.AskToQuit(TimeSpan.FromSeconds(5)) ? 0 : 1);
                return;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            Shutdown(1);
            return;
        }

        _single = Instance.TryOwn();
        if (_single is null)
        {
            Instance.AskToShow();
            Shutdown(0);
            return;
        }

        DispatcherUnhandledException += (_, ex) =>
        {
            // Keep the tray alive: a bug in one click shouldn't take approvals away.
            Log.Write($"unhandled: {ex.Exception}");
            ex.Handled = true;
        };
        Theme.Apply(Resources);
        _tray = new TrayController(settings);
        _tray.Exit += Quit;
        Instance.Listen(Dispatcher, _tray.ShowPanel, Quit);
        _tray.Start();
    }

    void Quit()
    {
        _tray?.Dispose();
        _tray = null;
        _single?.ReleaseMutex();
        _single?.Dispose();
        _single = null;
        Shutdown(0);
    }
}
