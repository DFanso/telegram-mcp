using System;
using System.Runtime.InteropServices;
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
///
/// It stays anchored to the tray corner as its content grows or shrinks (opening Contacts, opening
/// a contact, a long draft on hover): every move or resize goes through WM_WINDOWPOSCHANGING, which
/// puts it back in that corner. With a bottom taskbar it grows upward, never past the taskbar.
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
        var hwnd = new WindowInteropHelper(this).Handle;
        Native.RoundCorners(hwnd);
        HwndSource.FromHwnd(hwnd)?.AddHook(Anchor);
    }

    /// <summary>
    /// Rewrites every move or resize so the panel lands in the tray corner. WPF's SizeToContent
    /// grows the window from its top-left, and SizeChanged comes before the window has its new
    /// size, so moving it from there left a grown panel hanging past the taskbar.
    /// </summary>
    IntPtr Anchor(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != Native.WmWindowPosChanging || _workArea.IsEmpty) return IntPtr.Zero;
        var pos = Marshal.PtrToStructure<Native.WindowPos>(lParam);
        int w = pos.Cx, h = pos.Cy;
        if ((pos.Flags & Native.SwpNoSize) != 0)
        {
            if (!Native.GetWindowRect(hwnd, out var r)) return IntPtr.Zero;
            w = r.Right - r.Left;
            h = r.Bottom - r.Top;
        }
        (pos.X, pos.Y) = Place(w, h);
        pos.Flags &= ~Native.SwpNoMove;
        Marshal.StructureToPtr(pos, lParam, false);
        return IntPtr.Zero;
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

    /// <summary>Moves the panel into the tray corner at its current size (Anchor does the placing).</summary>
    void Reposition()
    {
        if (_workArea.IsEmpty) return;
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero || !Native.GetWindowRect(hwnd, out var r)) return;
        var (x, y) = Place(r.Right - r.Left, r.Bottom - r.Top);
        Native.SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0,
            Native.SwpNoSize | Native.SwpNoZOrder | Native.SwpNoActivate);
    }

    /// <summary>Top-left corner, in physical pixels, for a panel this big next to the tray.</summary>
    (int X, int Y) Place(int w, int h)
    {
        int gap = (int)Math.Round(Gap * Scale);
        var wa = _workArea;
        var (x, y) = _edge switch
        {
            Edge.Top => (wa.Right - w - gap, wa.Top + gap),
            Edge.Left => (wa.Left + gap, wa.Bottom - h - gap),
            _ => (wa.Right - w - gap, wa.Bottom - h - gap),
        };
        return (x, Math.Max(wa.Top + gap, y));
    }
}
