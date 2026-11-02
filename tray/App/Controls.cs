using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
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
