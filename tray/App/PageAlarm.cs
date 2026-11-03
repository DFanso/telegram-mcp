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
    HashSet<string> _shown = [];
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
                else ShowWindow(null, bringForward: true);
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
            _shown.Clear();
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
        var fresh = Pages.HasNew(_shown, ringing);
        _shown = ringing.Select(p => p.Id).ToHashSet();
        ShowWindow(ringing, bringForward: fresh);
    }

    /// <summary>
    /// Keeps the window's pages current; only a new page (or a click on the toast) brings it forward.
    /// A window you closed stays closed until then: the sound and the toast keep going.
    /// </summary>
    void ShowWindow(IReadOnlyList<UiPage>? ringing, bool bringForward)
    {
        _window ??= new PageWindow(this);
        if (ringing is not null) _window.Refresh(ringing);
        if (!bringForward) return;
        _window.Show();
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
            .AddButton(new ToastButton().SetContent("Snooze 1h").AddArgument("page", p.Id).AddArgument("do", "s60").SetBackgroundActivation());
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

/// <summary>
/// The window that stays on top while a page rings. An ordinary window, so it paints the opaque
/// Surface colour (the panel's tints are see-through, made for acrylic) and uses the panel's pills.
/// </summary>
sealed class PageWindow : Window
{
    readonly PageAlarm _alarm;
    readonly StackPanel _list = new() { Margin = new Thickness(20) };
    string _signature = "";

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
        SetResourceReference(BackgroundProperty, "Surface");
        SetResourceReference(ForegroundProperty, "Fg");
        SetResourceReference(FontFamilyProperty, "UiFont");
        FontSize = 13;
        SourceInitialized += (_, _) => Native.DarkTitleBar(new System.Windows.Interop.WindowInteropHelper(this).Handle, Theme.AppsDark);
        // Closing only hides it: the page keeps ringing until it is acked or snoozed.
        Closing += (_, e) =>
        {
            e.Cancel = true;
            Hide();
        };
    }

    /// <summary>Rebuilds the cards only when the pages changed, so a poll never resets a button mid-click.</summary>
    public void Refresh(IReadOnlyList<UiPage> ringing)
    {
        var signature = Pages.Signature(ringing);
        if (signature == _signature) return;
        _signature = signature;
        _list.Children.Clear();
        var title = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 14) };
        var bell = new SvgIcon { Kind = "bell-ring", Width = 22, Height = 22, Margin = new Thickness(0, 0, 10, 0) };
        bell.SetResourceReference(SvgIcon.ForegroundProperty, "Red");
        title.Children.Add(bell);
        var heading = new TextBlock
        {
            Text = ringing.Count > 1 ? $"{ringing.Count} pages" : "Page",
            FontSize = 20,
            FontWeight = FontWeights.SemiBold,
            VerticalAlignment = VerticalAlignment.Center,
        };
        heading.SetResourceReference(TextBlock.ForegroundProperty, "Red");
        title.Children.Add(heading);
        _list.Children.Add(title);
        foreach (var p in ringing) _list.Children.Add(Card(p));
    }

    UIElement Card(UiPage p)
    {
        var card = new StackPanel();
        var border = new Border { Child = card, CornerRadius = new CornerRadius(14), Padding = new Thickness(14), Margin = new Thickness(0, 0, 0, 12), BorderThickness = new Thickness(1) };
        border.SetResourceReference(Border.BackgroundProperty, "Subtle2");
        border.SetResourceReference(Border.BorderBrushProperty, "CardBorder");
        card.Children.Add(new TextBlock { Text = p.From, FontWeight = FontWeights.SemiBold, FontSize = 15 });
        if (p.Chat is { } chat)
        {
            var c = new TextBlock { Text = chat, FontSize = 12 };
            c.SetResourceReference(TextBlock.ForegroundProperty, "Fg3");
            card.Children.Add(c);
        }
        card.Children.Add(new TextBlock
        {
            Text = string.IsNullOrEmpty(p.Reason) ? "No reason given" : p.Reason,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 8, 0, 8),
            FontSize = 14,
        });
        if (p.State == "unanswered")
        {
            var warn = new TextBlock
            {
                Text = "Not acked on the phone either; the sender was told to call.",
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 8),
                FontSize = 12,
            };
            warn.SetResourceReference(TextBlock.ForegroundProperty, "Orange");
            card.Children.Add(warn);
        }
        var buttons = new WrapPanel();
        buttons.Children.Add(Btn("Ack", "RedFill", () => _alarm.Press(p.Id, true, 0), filled: true));
        buttons.Children.Add(Btn("Snooze 15m", "Orange", () => _alarm.Press(p.Id, false, 15)));
        buttons.Children.Add(Btn("Snooze 1h", "Orange", () => _alarm.Press(p.Id, false, 60)));
        if (Pages.MessageUri(p.ChatId, p.MessageId) is { } uri)
        {
            buttons.Children.Add(Btn("Open message", "Blue", () => Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true })));
        }
        card.Children.Add(buttons);
        return border;
    }

    static PillButton Btn(string text, string tint, Action click, bool filled = false)
    {
        var b = new PillButton { Content = text, Filled = filled, Margin = new Thickness(0, 4, 8, 0), IsDefault = filled };
        b.SetResourceReference(PillButton.TintProperty, tint);
        b.Click += (_, _) => click();
        return b;
    }
}
