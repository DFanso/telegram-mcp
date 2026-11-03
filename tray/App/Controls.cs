using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;

namespace TelegramMCPTray;

/// <summary>A capsule button (see Styles.xaml): Approve, Deny, the Contacts choices.</summary>
public sealed class PillButton : Button
{
    public static readonly DependencyProperty TintProperty =
        DependencyProperty.Register(nameof(Tint), typeof(Brush), typeof(PillButton));

    public static readonly DependencyProperty FilledProperty =
        DependencyProperty.Register(nameof(Filled), typeof(bool), typeof(PillButton), new PropertyMetadata(false));

    public static readonly DependencyProperty ChoiceProperty =
        DependencyProperty.Register(nameof(Choice), typeof(bool), typeof(PillButton), new PropertyMetadata(false));

    public Brush Tint { get => (Brush)GetValue(TintProperty); set => SetValue(TintProperty, value); }

    public bool Filled { get => (bool)GetValue(FilledProperty); set => SetValue(FilledProperty, value); }

    /// <summary>One of a set of choices: not filled reads as neutral grey rather than tinted.</summary>
    public bool Choice { get => (bool)GetValue(ChoiceProperty); set => SetValue(ChoiceProperty, value); }
}

/// <summary>
/// A Lucide outline icon by name (Icons.xaml), drawn in the inherited Foreground at any size:
/// <c>&lt;local:SvgIcon Kind="send" Width="14" /&gt;</c>. Kind can be bound ("chevron-up"...).
/// </summary>
public sealed class SvgIcon : FrameworkElement
{
    public static readonly DependencyProperty KindProperty = DependencyProperty.Register(
        nameof(Kind), typeof(string), typeof(SvgIcon),
        new FrameworkPropertyMetadata(null, FrameworkPropertyMetadataOptions.AffectsRender, (d, _) => ((SvgIcon)d)._geometry = null));

    public static readonly DependencyProperty ForegroundProperty =
        TextElement.ForegroundProperty.AddOwner(typeof(SvgIcon),
            new FrameworkPropertyMetadata(Brushes.Gray, FrameworkPropertyMetadataOptions.Inherits | FrameworkPropertyMetadataOptions.AffectsRender));

    /// <summary>The stroke on Lucide's 24-unit grid; 2 is Lucide's own weight.</summary>
    public static readonly DependencyProperty StrokeWeightProperty = DependencyProperty.Register(
        nameof(StrokeWeight), typeof(double), typeof(SvgIcon), new FrameworkPropertyMetadata(2.0, FrameworkPropertyMetadataOptions.AffectsRender));

    Geometry? _geometry;

    static SvgIcon()
    {
        WidthProperty.OverrideMetadata(typeof(SvgIcon), new FrameworkPropertyMetadata(16.0));
        HeightProperty.OverrideMetadata(typeof(SvgIcon), new FrameworkPropertyMetadata(16.0));
        VerticalAlignmentProperty.OverrideMetadata(typeof(SvgIcon), new FrameworkPropertyMetadata(VerticalAlignment.Center));
        SnapsToDevicePixelsProperty.OverrideMetadata(typeof(SvgIcon), new FrameworkPropertyMetadata(false));
    }

    public string? Kind { get => (string?)GetValue(KindProperty); set => SetValue(KindProperty, value); }
    public Brush Foreground { get => (Brush)GetValue(ForegroundProperty); set => SetValue(ForegroundProperty, value); }
    public double StrokeWeight { get => (double)GetValue(StrokeWeightProperty); set => SetValue(StrokeWeightProperty, value); }

    protected override Size MeasureOverride(Size available) => new(
        double.IsNaN(Width) ? 16 : Width, double.IsNaN(Height) ? 16 : Height);

    protected override void OnRender(DrawingContext dc)
    {
        if (Kind is null) return;
        _geometry ??= TryFindResource("icon." + Kind) as Geometry;
        if (_geometry is null) return;
        var scale = Math.Min(ActualWidth, ActualHeight) / 24;
        if (scale <= 0) return;
        var pen = new Pen(Foreground, StrokeWeight) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round, LineJoin = PenLineJoin.Round };
        dc.PushTransform(new TranslateTransform((ActualWidth - 24 * scale) / 2, (ActualHeight - 24 * scale) / 2));
        dc.PushTransform(new ScaleTransform(scale, scale));
        dc.DrawGeometry(null, pen, _geometry);
        dc.Pop();
        dc.Pop();
    }
}

/// <summary>Collapsed when true: the opposite of BooleanToVisibilityConverter.</summary>
public sealed class BoolToCollapsedConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) =>
        value is true ? Visibility.Collapsed : Visibility.Visible;

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

/// <summary>Collapsed for null or an empty string, visible otherwise.</summary>
public sealed class NullToCollapsedConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture) =>
        value is null || value is string { Length: 0 } ? Visibility.Collapsed : Visibility.Visible;

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

public abstract class Observable : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (Equals(field, value)) return false;
        field = value;
        Raise(name);
        return true;
    }

    protected void Raise([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

public sealed class Command(Action<object?> run, Func<object?, bool>? canRun = null) : ICommand
{
    public static Command Async(Func<Task> run) => new(_ => _ = run());

    public static Command Async(Func<object?, Task> run) => new(p => _ = run(p));

    public event EventHandler? CanExecuteChanged
    {
        add => CommandManager.RequerySuggested += value;
        remove => CommandManager.RequerySuggested -= value;
    }

    public bool CanExecute(object? parameter) => canRun?.Invoke(parameter) ?? true;

    public void Execute(object? parameter) => run(parameter);
}
