using System;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Screen = System.Windows.Forms.Screen;

namespace TelegramMCPTray;

/// <summary>
/// The panel, shown like a Windows flyout: next to the tray (whichever edge the taskbar is on),
/// on top, gone when you click elsewhere or press Esc. At most as tall as the screen: the middle
/// scrolls. Positions are worked out in physical pixels, so mixed-DPI monitors line up.
/// </summary>
public partial class PanelWindow : Window
{
    enum Edge { Bottom, Top, Left, Right }

    System.Drawing.Rectangle _workArea;
    Edge _edge;
    const double Gap = 12;

    public PanelWindow()
    {
        InitializeComponent();
        Deactivated += (_, _) => HidePanel();
        SizeChanged += (_, _) => Reposition();
        DpiChanged += (_, _) =>
        {
            FitHeight();
            Reposition();
        };
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) HidePanel();
        };
    }

    /// <summary>When the panel last went away (a tray click right after shouldn't reopen it).</summary>
    public DateTime LastHidden { get; private set; }

    double Scale => VisualTreeHelper.GetDpi(this).DpiScaleY;

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        Native.RoundCorners(new WindowInteropHelper(this).Handle);
    }

    public void ShowNearTray()
    {
        var screen = Screen.FromPoint(System.Windows.Forms.Cursor.Position);
        _workArea = screen.WorkingArea;
        var bounds = screen.Bounds;
        _edge = _workArea.Bottom < bounds.Bottom ? Edge.Bottom
            : _workArea.Top > bounds.Top ? Edge.Top
            : _workArea.Left > bounds.Left ? Edge.Left
            : _workArea.Right < bounds.Right ? Edge.Right
            : Edge.Bottom; // an auto-hidden taskbar: assume the bottom

        // Lay it out and place it while still hidden, so it doesn't flash somewhere else first.
        new WindowInteropHelper(this).EnsureHandle();
        FitHeight();
        UpdateLayout();
        Reposition();
        Show();
        Activate();
        Native.SetForegroundWindow(new WindowInteropHelper(this).Handle);
        Dispatcher.InvokeAsync(Reposition, DispatcherPriority.Loaded);
    }

    public void HidePanel()
    {
        if (!IsVisible) return;
        Hide();
        LastHidden = DateTime.UtcNow;
    }

    void FitHeight() => MaxHeight = Math.Max(300, _workArea.Height / Scale - 2 * Gap);

    void Reposition()
    {
        if (_workArea.IsEmpty) return;
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero || !Native.GetWindowRect(hwnd, out var r)) return;
        int w = r.Right - r.Left, h = r.Bottom - r.Top, gap = (int)Math.Round(Gap * Scale);
        var wa = _workArea;
        var (x, y) = _edge switch
        {
            Edge.Top => (wa.Right - w - gap, wa.Top + gap),
            Edge.Left => (wa.Left + gap, wa.Bottom - h - gap),
            _ => (wa.Right - w - gap, wa.Bottom - h - gap),
        };
        Native.SetWindowPos(hwnd, IntPtr.Zero, x, Math.Max(wa.Top + gap, y), 0, 0,
            Native.SwpNoSize | Native.SwpNoZOrder | Native.SwpNoActivate);
    }
}
