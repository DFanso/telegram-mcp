using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Media;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
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

    /// <summary>The window's acrylic follows the app mode (light/dark), like the panel's.</summary>
    public void ApplyBackdrop() => _window?.ApplyBackdrop();

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
/// The window that stays on top while a page rings, in the panel's look: borderless smoked glass
/// (acrylic where Windows has it), frosted cards, the panel's pills and Lucide icons, and the same
/// layout as the menu bar's alarm. Drag it anywhere; the close button or Esc only hides it.
/// </summary>
sealed class PageWindow : Window
{
    /// <summary>More than this and the rest wait behind "+N more", as on the Mac: it has to fit a laptop screen.</summary>
    const int MaxCards = 3;

    readonly PageAlarm _alarm;
    readonly StackPanel _list = new() { Margin = new Thickness(18) };
    readonly List<(TextBlock Text, DateTimeOffset At)> _agos = [];
    readonly DispatcherTimer _tick = new() { Interval = TimeSpan.FromSeconds(30) };
    string _signature = "";

    public PageWindow(PageAlarm alarm)
    {
        _alarm = alarm;
        Title = "Page";
        Width = 420;
        SizeToContent = SizeToContent.Height;
        MaxHeight = Math.Max(320, SystemParameters.WorkArea.Height - 40);
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        Topmost = true;
        ShowInTaskbar = true;
        UseLayoutRounding = true;
        SetResourceReference(BackgroundProperty, "PanelBg");
        SetResourceReference(ForegroundProperty, "Fg");
        SetResourceReference(FontFamilyProperty, "UiFont");
        FontSize = 12;

        var frame = new Border
        {
            BorderThickness = new Thickness(1),
            Child = new ScrollViewer { Content = _list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Focusable = false },
        };
        frame.SetResourceReference(Border.BorderBrushProperty, "PanelBorder");
        Content = frame;

        SourceInitialized += (_, _) =>
        {
            Native.RoundCorners(new WindowInteropHelper(this).Handle);
            Glass.Apply(this);
        };
        // No title bar: drag it from anywhere that isn't a button.
        MouseLeftButtonDown += (_, e) =>
        {
            if (e.ButtonState == MouseButtonState.Pressed) DragMove();
        };
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key != Key.Escape) return;
            Hide();
            e.Handled = true;
        };
        // "5m ago" keeps counting while the window is up.
        _tick.Tick += (_, _) => UpdateAgo();
        IsVisibleChanged += (_, _) =>
        {
            if (IsVisible)
            {
                UpdateAgo();
                _tick.Start();
            }
            else _tick.Stop();
        };
        // Closing only hides it: the page keeps ringing until it is acked or snoozed.
        Closing += (_, e) =>
        {
            e.Cancel = true;
            Hide();
        };
    }

    /// <summary>Acrylic again after the app mode (light/dark) changes.</summary>
    public void ApplyBackdrop() => Glass.Apply(this);

    void UpdateAgo()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var (text, at) in _agos) text.Text = ApprovalVM.AgoWords(Format.Ago(at, now));
    }

    /// <summary>Rebuilds the cards only when the pages changed, so a poll never resets a button mid-click.</summary>
    public void Refresh(IReadOnlyList<UiPage> ringing)
    {
        var signature = Pages.Signature(ringing);
        if (signature == _signature) return;
        _signature = signature;
        _list.Children.Clear();
        _agos.Clear();
        _list.Children.Add(Header(ringing.Count));
        foreach (var p in ringing.Take(MaxCards)) _list.Children.Add(Card(p));
        if (ringing.Count > MaxCards)
        {
            var more = new TextBlock { Text = $"+{ringing.Count - MaxCards} more: ack these to see them", FontSize = 11, Margin = new Thickness(2, 0, 0, 0) };
            more.SetResourceReference(TextBlock.ForegroundProperty, "Fg2");
            _list.Children.Add(more);
        }
        UpdateAgo();
    }

    /// <summary>A bell in a soft red disc, "Page" / "N pages", what it means, and a close button.</summary>
    UIElement Header(int count)
    {
        var grid = new Grid { Margin = new Thickness(0, 0, 0, 12) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var disc = new Border { Width = 42, Height = 42, CornerRadius = new CornerRadius(21), Margin = new Thickness(0, 0, 12, 0), VerticalAlignment = VerticalAlignment.Top };
        disc.SetResourceReference(Border.BackgroundProperty, "RedWash");
        var bell = new SvgIcon { Kind = "bell-ring", Width = 20, Height = 20 };
        bell.SetResourceReference(SvgIcon.ForegroundProperty, "Red");
        disc.Child = bell;
        grid.Children.Add(disc);

        var words = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        var title = new TextBlock { Text = count > 1 ? $"{count} pages" : "Page", FontSize = 17, FontWeight = FontWeights.Bold };
        title.SetResourceReference(TextBlock.FontFamilyProperty, "DisplayFont");
        words.Children.Add(title);
        var sub = new TextBlock { Text = "Someone needs you now. It rings until you ack or snooze it.", FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 0) };
        sub.SetResourceReference(TextBlock.ForegroundProperty, "Fg2");
        words.Children.Add(sub);
        Grid.SetColumn(words, 1);
        grid.Children.Add(words);

        var close = new Button
        {
            Content = new SvgIcon { Kind = "x", Width = 14, Height = 14 },
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(8, 0, -6, 0),
            ToolTip = "Hide (it keeps ringing until acked or snoozed)",
        };
        close.SetResourceReference(StyleProperty, "IconButton");
        AutomationProperties.SetName(close, "Hide the page window");
        close.Click += (_, _) => Hide();
        Grid.SetColumn(close, 2);
        grid.Children.Add(close);
        return grid;
    }

    /// <summary>One page: who and when, the reason, a warning if it went unanswered, then Ack / Snooze / Open.</summary>
    UIElement Card(UiPage p)
    {
        var card = new StackPanel();
        var border = new Border { Child = card, CornerRadius = new CornerRadius(14), Padding = new Thickness(12), Margin = new Thickness(0, 0, 0, 12), BorderThickness = new Thickness(1) };
        border.SetResourceReference(Border.BackgroundProperty, "RedWash");
        border.BorderBrush = Edge("Red");

        // Who paged, with their avatar (the chat's photo once loaded, else initials), and how long ago.
        var who = new Grid();
        who.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        who.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        who.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        who.Children.Add(AvatarView(Avatar.For(p.From, p.ChatId)));
        var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        names.Children.Add(new TextBlock { Text = p.From, FontWeight = FontWeights.SemiBold, FontSize = 13, TextTrimming = TextTrimming.CharacterEllipsis });
        if (p.Chat is { } chat)
        {
            var c = new TextBlock { Text = chat, FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis };
            c.SetResourceReference(TextBlock.ForegroundProperty, "Fg3");
            names.Children.Add(c);
        }
        Grid.SetColumn(names, 1);
        who.Children.Add(names);
        var when = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(6, 2, 0, 0) };
        var clock = new SvgIcon { Kind = "clock", Width = 12, Height = 12, Margin = new Thickness(0, 0, 4, 0) };
        clock.SetResourceReference(SvgIcon.ForegroundProperty, "Fg3");
        when.Children.Add(clock);
        var ago = new TextBlock { FontSize = 11 };
        ago.SetResourceReference(TextBlock.ForegroundProperty, "Fg3");
        _agos.Add((ago, p.CreatedAt));
        when.Children.Add(ago);
        Grid.SetColumn(when, 2);
        who.Children.Add(when);
        card.Children.Add(who);

        // The reason, on a frosted inset like a draft's text on the panel.
        var empty = string.IsNullOrEmpty(p.Reason);
        var reason = new TextBlock { Text = empty ? "No reason given" : p.Reason, TextWrapping = TextWrapping.Wrap, FontSize = 13 };
        reason.SetResourceReference(TextBlock.ForegroundProperty, empty ? "Fg3" : "Fg");
        var inset = new Border { Child = reason, CornerRadius = new CornerRadius(10), Padding = new Thickness(10, 8, 10, 8), Margin = new Thickness(0, 10, 0, 0) };
        inset.SetResourceReference(Border.BackgroundProperty, "Subtle2");
        card.Children.Add(inset);

        if (p.State == "unanswered")
        {
            var warn = new DockPanel { Margin = new Thickness(0, 10, 0, 0) };
            var icon = new SvgIcon { Kind = "triangle-alert", Width = 13, Height = 13, Margin = new Thickness(0, 1, 6, 0), VerticalAlignment = VerticalAlignment.Top };
            icon.SetResourceReference(SvgIcon.ForegroundProperty, "Orange");
            DockPanel.SetDock(icon, Dock.Left);
            warn.Children.Add(icon);
            var text = new TextBlock { Text = "Not acked on the phone either; the sender was told to call.", TextWrapping = TextWrapping.Wrap, FontSize = 11 };
            text.SetResourceReference(TextBlock.ForegroundProperty, "Orange");
            warn.Children.Add(text);
            card.Children.Add(warn);
        }

        // Ack / Snooze 15m / 1h on the left, Open on the right, as on the Mac.
        var buttons = new DockPanel { Margin = new Thickness(0, 10, 0, 0), LastChildFill = false };
        if (Pages.MessageUri(p.ChatId, p.MessageId) is { } uri)
        {
            var label = new StackPanel { Orientation = Orientation.Horizontal };
            label.Children.Add(new SvgIcon { Kind = "external-link", Width = 12, Height = 12, Margin = new Thickness(0, 0, 5, 0) });
            label.Children.Add(new TextBlock { Text = "Open" });
            var open = Btn(label, "Accent", () => Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true }));
            open.ToolTip = "Open the message in Telegram";
            open.Margin = new Thickness(0);
            AutomationProperties.SetName(open, "Open the message in Telegram");
            DockPanel.SetDock(open, Dock.Right);
            buttons.Children.Add(open);
        }
        var ack = Btn("Ack", "RedFill", () => _alarm.Press(p.Id, true, 0), filled: true);
        ack.ToolTip = "Stop the alarm everywhere: here, in the menu bar and on the phone";
        var snooze = Btn("Snooze 15m", "Fg2", () => _alarm.Press(p.Id, false, 15));
        var hour = Btn("1h", "Fg2", () => _alarm.Press(p.Id, false, 60));
        AutomationProperties.SetName(hour, "Snooze 1 hour");
        foreach (var b in new[] { ack, snooze, hour })
        {
            DockPanel.SetDock(b, Dock.Left);
            buttons.Children.Add(b);
        }
        card.Children.Add(buttons);
        return border;
    }

    /// <summary>A status colour at 35%, for a card's edge (the Mac's red.opacity(0.35)).</summary>
    Brush Edge(string key)
    {
        var c = TryFindResource(key) is SolidColorBrush b ? b.Color : Colors.IndianRed;
        var edge = new SolidColorBrush(Color.FromArgb(0x59, c.R, c.G, c.B));
        edge.Freeze();
        return edge;
    }

    /// <summary>The panel's avatar template, in code: this window doesn't share the panel's resources.</summary>
    static FrameworkElement AvatarView(Avatar a)
    {
        var grid = new Grid { Width = 34, Height = 34, Margin = new Thickness(0, 0, 10, 0), VerticalAlignment = VerticalAlignment.Top };
        grid.Children.Add(new System.Windows.Shapes.Ellipse { Fill = a.Fill });
        grid.Children.Add(new TextBlock
        {
            Text = a.Initials,
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Foreground = Brushes.White,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        });
        if (a.Photo is { } photo)
        {
            var brush = new ImageBrush { Stretch = Stretch.UniformToFill };
            System.Windows.Data.BindingOperations.SetBinding(brush, ImageBrush.ImageSourceProperty, new System.Windows.Data.Binding(nameof(AvatarPhoto.Image)) { Source = photo });
            var image = new System.Windows.Shapes.Ellipse { Fill = brush };
            image.SetBinding(VisibilityProperty, new System.Windows.Data.Binding(nameof(AvatarPhoto.HasImage))
            {
                Source = photo,
                Converter = new BooleanToVisibilityConverter(),
            });
            grid.Children.Add(image);
        }
        var ring = new SolidColorBrush(Color.FromArgb(0x33, 0xFF, 0xFF, 0xFF));
        ring.Freeze();
        grid.Children.Add(new System.Windows.Shapes.Ellipse { Stroke = ring, StrokeThickness = 1 });
        return grid;
    }

    static PillButton Btn(object content, string tint, Action click, bool filled = false)
    {
        var b = new PillButton { Content = content, Filled = filled, Margin = new Thickness(0, 0, 8, 0), IsDefault = filled };
        b.SetResourceReference(PillButton.TintProperty, tint);
        b.Click += (_, _) => click();
        return b;
    }
}
