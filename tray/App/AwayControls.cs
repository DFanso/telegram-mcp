using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;

namespace TelegramMCPTray;

/// <summary>One schedule's row on the day timeline: its colour, the parts of today it covers, whether it's on.</summary>
public sealed record TimelineLane(Brush Color, IReadOnlyList<(double Start, double End)> Spans, bool Enabled, string Name);

/// <summary>
/// Today at a glance on the Away tab: a thin track per schedule with the hours it covers, a line at
/// the current time, and 0–6–12–18–24 under it. Drawn, not templated, so it stays light.
/// </summary>
public sealed class DayTimeline : FrameworkElement
{
    public static readonly DependencyProperty LanesProperty = DependencyProperty.Register(
        nameof(Lanes), typeof(IReadOnlyList<TimelineLane>), typeof(DayTimeline),
        new FrameworkPropertyMetadata(Array.Empty<TimelineLane>(), FrameworkPropertyMetadataOptions.AffectsMeasure | FrameworkPropertyMetadataOptions.AffectsRender));

    /// <summary>Where now is, as a fraction of the day.</summary>
    public static readonly DependencyProperty NowProperty = DependencyProperty.Register(
        nameof(Now), typeof(double), typeof(DayTimeline), new FrameworkPropertyMetadata(0.0, FrameworkPropertyMetadataOptions.AffectsRender));

    public IReadOnlyList<TimelineLane> Lanes { get => (IReadOnlyList<TimelineLane>)GetValue(LanesProperty); set => SetValue(LanesProperty, value); }
    public double Now { get => (double)GetValue(NowProperty); set => SetValue(NowProperty, value); }

    const double Lane = 6, Gap = 5, Labels = 16;

    double TracksHeight => Math.Max(1, Lanes.Count) * (Lane + Gap) - Gap;

    protected override Size MeasureOverride(Size available) =>
        new(double.IsInfinity(available.Width) ? 300 : available.Width, TracksHeight + Labels + 4);

    Brush Res(string key, Brush fallback) => TryFindResource(key) as Brush ?? fallback;

    protected override void OnRender(DrawingContext dc)
    {
        var w = ActualWidth;
        if (w <= 0) return;
        var track = Res("Subtle2", Brushes.DimGray);
        var fg = Res("Fg", Brushes.White);
        var fg3 = Res("Fg3", Brushes.Gray);
        var lanes = Lanes.Count == 0 ? [new TimelineLane(track, [], false, "")] : Lanes;
        for (var i = 0; i < lanes.Count; i++)
        {
            var y = i * (Lane + Gap);
            dc.DrawRoundedRectangle(track, null, new Rect(0, y, w, Lane), Lane / 2, Lane / 2);
            var l = lanes[i];
            foreach (var (a, b) in l.Spans)
            {
                dc.PushOpacity(l.Enabled ? 1 : 0.35);
                dc.DrawRoundedRectangle(l.Color, null, new Rect(a * w, y, Math.Max(2, (b - a) * w), Lane), Lane / 2, Lane / 2);
                dc.Pop();
            }
        }

        // Now: a line through the tracks with a dot on top.
        var x = Math.Clamp(Now, 0, 1) * w;
        dc.DrawLine(new Pen(fg, 1.5), new Point(x, -2), new Point(x, TracksHeight + 2));
        dc.DrawEllipse(fg, null, new Point(x, -2), 2.5, 2.5);

        var dpi = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        var face = new Typeface(new FontFamily("Segoe UI Variable Text, Segoe UI"), FontStyles.Normal, FontWeights.Normal, FontStretches.Normal);
        for (var h = 0; h <= 24; h += 6)
        {
            var text = new FormattedText(h == 24 ? "24" : $"{h:00}:00", CultureInfo.InvariantCulture, FlowDirection.LeftToRight, face, 9.5, fg3, dpi);
            var tx = h == 0 ? 0 : h == 24 ? w - text.Width : h / 24.0 * w - text.Width / 2;
            dc.DrawText(text, new Point(tx, TracksHeight + 4));
        }
    }
}

/// <summary>
/// A date field: a capsule showing the date (or a hint), which opens a small month calendar drawn in
/// the panel's own colours. SelectedDate binds two-way.
/// </summary>
public sealed class DateField : Control
{
    public static readonly DependencyProperty SelectedDateProperty = DependencyProperty.Register(
        nameof(SelectedDate), typeof(DateTime?), typeof(DateField),
        new FrameworkPropertyMetadata(null, FrameworkPropertyMetadataOptions.BindsTwoWayByDefault, (d, _) => ((DateField)d).Sync()));

    public static readonly DependencyProperty HintProperty = DependencyProperty.Register(
        nameof(Hint), typeof(string), typeof(DateField), new PropertyMetadata("Pick a date", (d, _) => ((DateField)d).Sync()));

    public DateTime? SelectedDate { get => (DateTime?)GetValue(SelectedDateProperty); set => SetValue(SelectedDateProperty, value); }
    public string Hint { get => (string)GetValue(HintProperty); set => SetValue(HintProperty, value); }

    readonly Button _button;
    readonly TextBlock _label;
    readonly Popup _popup;
    readonly TextBlock _month;
    readonly UniformGrid _grid;
    DateTime _shown = DateTime.Today;

    public DateField()
    {
        Focusable = false;
        _label = new TextBlock { VerticalAlignment = VerticalAlignment.Center, FontSize = 12 };
        var icon = new SvgIcon { Kind = "calendar", Width = 14, Height = 14, Margin = new Thickness(0, 0, 7, 0) };
        icon.SetResourceReference(SvgIcon.ForegroundProperty, "Fg2");
        var content = new StackPanel { Orientation = Orientation.Horizontal, Children = { icon, _label } };
        var face = new Border { CornerRadius = new CornerRadius(15), Padding = new Thickness(11, 6, 12, 6), Child = content, MinWidth = 120 };
        face.SetResourceReference(Border.BackgroundProperty, "Subtle2");
        _button = new Button { Style = (Style)FindResource("Flat"), Content = face, HorizontalContentAlignment = HorizontalAlignment.Left };
        _button.Click += (_, _) => Open();

        _month = new TextBlock { FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        var head = new DockPanel { Margin = new Thickness(0, 0, 0, 6) };
        var prev = NavButton("chevron-left", "Previous month", -1);
        var next = NavButton("chevron-right", "Next month", 1);
        DockPanel.SetDock(prev, Dock.Left);
        DockPanel.SetDock(next, Dock.Right);
        head.Children.Add(prev);
        head.Children.Add(next);
        head.Children.Add(_month);

        var names = new UniformGrid { Columns = 7, Margin = new Thickness(0, 0, 0, 2) };
        foreach (var d in new[] { "Mo", "Tu", "We", "Th", "Fr", "Sa", "Su" })
        {
            var t = new TextBlock { Text = d, FontSize = 10, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 2, 0, 2) };
            t.SetResourceReference(TextBlock.ForegroundProperty, "Fg3");
            names.Children.Add(t);
        }
        _grid = new UniformGrid { Columns = 7, Rows = 6 };
        var clear = new Button { Style = (Style)FindResource("Flat"), HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(4, 8, 0, 0) };
        var clearText = new TextBlock { Text = "Today", FontSize = 11, FontWeight = FontWeights.SemiBold };
        clearText.SetResourceReference(TextBlock.ForegroundProperty, "Accent");
        clear.Content = clearText;
        clear.Click += (_, _) => Pick(DateTime.Today);

        var panel = new StackPanel { Children = { head, names, _grid, clear } };
        var card = new Border
        {
            CornerRadius = new CornerRadius(14), Padding = new Thickness(10), BorderThickness = new Thickness(1), Width = 236, Child = panel,
            Effect = new System.Windows.Media.Effects.DropShadowEffect { BlurRadius = 18, ShadowDepth = 4, Opacity = 0.35 },
            Margin = new Thickness(6),
        };
        card.SetResourceReference(Border.BackgroundProperty, "Surface");
        card.SetResourceReference(Border.BorderBrushProperty, "CardBorder");
        card.SetResourceReference(TextElement.ForegroundProperty, "Fg");
        _popup = new Popup
        {
            Child = card, StaysOpen = false, AllowsTransparency = true, PlacementTarget = _button, Placement = PlacementMode.Bottom,
            PopupAnimation = PopupAnimation.Fade,
        };
        _popup.KeyDown += (_, e) =>
        {
            if (e.Key != Key.Escape) return;
            _popup.IsOpen = false;
            e.Handled = true;
        };
        AddVisualChild(_button);
        AddLogicalChild(_popup);
        Sync();
    }

    Button NavButton(string icon, string name, int months)
    {
        var glyph = new SvgIcon { Kind = icon, Width = 14, Height = 14, Margin = new Thickness(6, 2, 6, 2) };
        glyph.SetResourceReference(SvgIcon.ForegroundProperty, "Fg2");
        var b = new Button { Style = (Style)FindResource("Flat"), Content = glyph, HorizontalContentAlignment = HorizontalAlignment.Center };
        System.Windows.Automation.AutomationProperties.SetName(b, name);
        b.Click += (_, _) =>
        {
            _shown = _shown.AddMonths(months);
            Fill();
        };
        return b;
    }

    protected override int VisualChildrenCount => 1;
    protected override Visual GetVisualChild(int index) => _button;

    protected override Size MeasureOverride(Size constraint)
    {
        _button.Measure(constraint);
        return _button.DesiredSize;
    }

    protected override Size ArrangeOverride(Size arrangeBounds)
    {
        _button.Arrange(new Rect(arrangeBounds));
        return arrangeBounds;
    }

    void Sync()
    {
        _label.Text = SelectedDate?.ToString("ddd d MMM yyyy", CultureInfo.InvariantCulture) ?? Hint;
        _label.SetResourceReference(TextBlock.ForegroundProperty, SelectedDate is null ? "Fg3" : "Fg");
        System.Windows.Automation.AutomationProperties.SetName(_button, $"{Hint}: {_label.Text}");
    }

    void Open()
    {
        _shown = new DateTime((SelectedDate ?? DateTime.Today).Year, (SelectedDate ?? DateTime.Today).Month, 1);
        Fill();
        _popup.IsOpen = true;
    }

    void Pick(DateTime day)
    {
        SelectedDate = day.Date;
        _popup.IsOpen = false;
        _button.Focus();
    }

    /// <summary>Six weeks from the Monday on or before the 1st.</summary>
    void Fill()
    {
        _month.Text = _shown.ToString("MMMM yyyy", CultureInfo.InvariantCulture);
        _grid.Children.Clear();
        var first = new DateTime(_shown.Year, _shown.Month, 1);
        var start = first.AddDays(-(((int)first.DayOfWeek + 6) % 7));
        for (var i = 0; i < 42; i++)
        {
            var day = start.AddDays(i);
            var selected = SelectedDate?.Date == day;
            var text = new TextBlock { Text = day.Day.ToString(CultureInfo.InvariantCulture), FontSize = 11, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            text.SetResourceReference(TextBlock.ForegroundProperty, selected ? "OnAccent" : day.Month == _shown.Month ? "Fg" : "Fg3");
            if (day == DateTime.Today) text.FontWeight = FontWeights.Bold;
            var cell = new Border { Width = 28, Height = 26, CornerRadius = new CornerRadius(13), Child = text, Background = Brushes.Transparent };
            if (selected) cell.SetResourceReference(Border.BackgroundProperty, "AccentFill");
            else if (day == DateTime.Today) cell.SetResourceReference(Border.BorderBrushProperty, "Accent");
            cell.BorderThickness = new Thickness(day == DateTime.Today && !selected ? 1 : 0);
            var b = new Button { Style = (Style)FindResource("Flat"), Content = cell, HorizontalContentAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 1, 0, 1) };
            System.Windows.Automation.AutomationProperties.SetName(b, day.ToString("dddd d MMMM yyyy", CultureInfo.InvariantCulture));
            b.Click += (_, _) => Pick(day);
            _grid.Children.Add(b);
        }
    }
}
