using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Media;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Toolkit.Uwp.Notifications;
using TelegramMCPTray.Core;
using Button = System.Windows.Controls.Button;
using Orientation = System.Windows.Controls.Orientation;

namespace TelegramMCPTray;

/// <summary>
/// The on-call alarm. While a page rings: a looping tone the app plays itself (a notification's
/// sound can be turned off, and Focus assist mutes it), an alarm toast that stays up and loops,
/// and a window above everything with Ack / Snooze. It stops once the page is acked or snoozed
/// here, in the menu bar or on the phone.
/// </summary>
sealed class PageAlarm
{
    const string Group = "pages";
    readonly string _home;
    SoundPlayer _sound = new(new MemoryStream(Pages.AlarmWav()));
    readonly HashSet<string> _toasts = [];
    PageWindow? _window;
    bool _playing;

    public PageAlarm(string home) => _home = home;

    /// <summary>alarm.wav in the home folder if there is one, else the built-in beep.</summary>
    SoundPlayer Sound()
    {
        if (Pages.CustomAlarm(_home) is { } path)
        {
            try
            {
                var custom = new SoundPlayer(path);
                custom.Load();
                return custom;
            }
            catch (Exception e) when (e is IOException or InvalidOperationException or UnauthorizedAccessException) { }
        }
        return new SoundPlayer(new MemoryStream(Pages.AlarmWav()));
    }

    /// <summary>Ack (minutes null) or snooze a page.</summary>
    public event Action<string, bool, int>? Act;

    public void Listen()
    {
        ToastNotificationManagerCompat.OnActivated += e =>
        {
            var args = ToastArguments.Parse(e.Argument);
            if (!args.TryGetValue("page", out var id)) return;
            var what = args.TryGetValue("do", out var d) ? d : "";
            System.Windows.Application.Current.Dispatcher.InvokeAsync(() =>
            {
                if (what == "ack") Act?.Invoke(id, true, 0);
                else if (what is "s15" or "s60") Act?.Invoke(id, false, what == "s60" ? 60 : 15);
                else ShowWindow(null);
            });
        };
    }

    /// <summary>Call after each poll with the pages that should ring.</summary>
    public void Update(IReadOnlyList<UiPage> ringing)
    {
        foreach (var gone in _toasts.Where(id => ringing.All(p => p.Id != id)).ToList())
        {
            Toasts.Safely(() => ToastNotificationManagerCompat.History.Remove(gone, Group));
            _toasts.Remove(gone);
        }
        if (ringing.Count == 0)
        {
            if (_playing) _sound.Stop();
            _playing = false;
            _window?.Hide();
            return;
        }
        if (!_playing)
        {
            _sound.Dispose();
            _sound = Sound();
            _sound.PlayLooping();
            _playing = true;
        }
        foreach (var p in ringing.Where(p => _toasts.Add(p.Id))) ShowToast(p);
        ShowWindow(ringing);
    }

    void ShowWindow(IReadOnlyList<UiPage>? ringing)
    {
        _window ??= new PageWindow(this);
        if (ringing is not null) _window.Show(ringing);
        else _window.Show();
        _window.Topmost = true;
        _window.Activate();
    }

    internal void Press(string id, bool ack, int minutes) => Act?.Invoke(id, ack, minutes);

    static void ShowToast(UiPage p)
    {
        var toast = new ToastContentBuilder()
            .SetToastScenario(ToastScenario.Alarm)
            .AddArgument("page", p.Id)
            .AddText($"Page from {p.From}")
            .AddText(p.Chat ?? "", hintMaxLines: 1)
            .AddText(string.IsNullOrEmpty(p.Reason) ? "No reason given" : p.Reason)
            .AddAudio(new Uri("ms-winsoundevent:Notification.Looping.Alarm"), loop: true)
            .AddButton(new ToastButton().SetContent("Ack").AddArgument("page", p.Id).AddArgument("do", "ack").SetBackgroundActivation())
            .AddButton(new ToastButton().SetContent("Snooze 15m").AddArgument("page", p.Id).AddArgument("do", "s15").SetBackgroundActivation())
            .AddButton(new ToastButton().SetContent("1h").AddArgument("page", p.Id).AddArgument("do", "s60").SetBackgroundActivation());
        Toasts.Safely(() => toast.Show(t =>
        {
            t.Tag = p.Id;
            t.Group = Group;
        }));
    }

    public void Stop()
    {
        _sound.Stop();
        _window?.Close();
        Toasts.Safely(() => ToastNotificationManagerCompat.History.RemoveGroup(Group));
    }
}

/// <summary>The window that stays on top while a page rings.</summary>
sealed class PageWindow : Window
{
    readonly PageAlarm _alarm;
    readonly StackPanel _list = new() { Margin = new Thickness(18) };

    public PageWindow(PageAlarm alarm)
    {
        _alarm = alarm;
        Title = "Page";
        Width = 440;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        ResizeMode = ResizeMode.NoResize;
        Topmost = true;
        ShowInTaskbar = true;
        Content = _list;
        SetResourceReference(BackgroundProperty, "PanelBg");
        SetResourceReference(ForegroundProperty, "Fg");
        // Closing only hides it: the page keeps ringing until it is acked or snoozed.
        Closing += (_, e) =>
        {
            e.Cancel = true;
            Hide();
        };
    }

    public void Show(IReadOnlyList<UiPage> ringing)
    {
        _list.Children.Clear();
        _list.Children.Add(new TextBlock
        {
            Text = ringing.Count > 1 ? $"{ringing.Count} pages" : "Page",
            FontSize = 18,
            FontWeight = FontWeights.Bold,
            Foreground = Brushes.Crimson,
            Margin = new Thickness(0, 0, 0, 10),
        });
        foreach (var p in ringing) _list.Children.Add(Card(p));
        Show();
    }

    UIElement Card(UiPage p)
    {
        var card = new StackPanel { Margin = new Thickness(0, 0, 0, 12) };
        card.Children.Add(new TextBlock { Text = p.From, FontWeight = FontWeights.SemiBold, FontSize = 14 });
        if (p.Chat is { } chat) card.Children.Add(new TextBlock { Text = chat, Opacity = 0.7 });
        card.Children.Add(new TextBlock
        {
            Text = string.IsNullOrEmpty(p.Reason) ? "No reason given" : p.Reason,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 6, 0, 6),
            FontSize = 13,
        });
        if (p.State == "unanswered")
        {
            card.Children.Add(new TextBlock
            {
                Text = "Not acked on the phone either; the sender was told to call.",
                Foreground = Brushes.DarkOrange,
                Margin = new Thickness(0, 0, 0, 6),
            });
        }
        var buttons = new StackPanel { Orientation = Orientation.Horizontal };
        buttons.Children.Add(Btn("Ack", () => _alarm.Press(p.Id, true, 0), primary: true));
        buttons.Children.Add(Btn("Snooze 15m", () => _alarm.Press(p.Id, false, 15)));
        buttons.Children.Add(Btn("1h", () => _alarm.Press(p.Id, false, 60)));
        if (Pages.MessageUri(p.ChatId, p.MessageId) is { } uri)
        {
            buttons.Children.Add(Btn("Open message", () => Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true })));
        }
        card.Children.Add(buttons);
        return card;
    }

    static Button Btn(string text, Action click, bool primary = false)
    {
        var b = new Button { Content = text, Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(0, 0, 8, 0), IsDefault = primary };
        if (primary)
        {
            b.Background = Brushes.Crimson;
            b.Foreground = Brushes.White;
        }
        b.Click += (_, _) => click();
        return b;
    }
}
