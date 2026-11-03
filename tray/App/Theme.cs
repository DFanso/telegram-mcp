using System;
using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;

namespace TelegramMCPTray;

/// <summary>
/// The panel's look: a smoked-glass panel (Windows 11's acrylic behind a warm tint) with frosted
/// cards and one orange accent, in a light and a dark variant that follow "Choose your default app
/// mode". Where acrylic isn't available (Windows 10, transparency effects off) the same tints are
/// drawn opaque, so the panel looks the same minus the blur.
/// </summary>
static class Theme
{
    const string Personalize = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    static bool Flag(string value, bool fallback)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(Personalize);
            return key?.GetValue(value) is int v ? v != 0 : fallback;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException)
        {
            return fallback;
        }
    }

    /// <summary>Settings > Personalization > Colors > "Choose your default app mode".</summary>
    public static bool AppsDark => !Flag("AppsUseLightTheme", true);

    /// <summary>"Choose your default Windows mode": the taskbar the tray icon sits on.</summary>
    public static bool TaskbarDark => !Flag("SystemUsesLightTheme", false);

    /// <summary>
    /// Acrylic behind the panel: Windows 11 22H2 (build 22621) or later, with "Transparency effects"
    /// on. Set to false when the window couldn't get it, so the tints are drawn opaque instead.
    /// </summary>
    public static bool Translucent { get; set; } =
        Environment.OSVersion.Version.Build >= 22621 && Flag("EnableTransparency", true);

    static Color C(uint argb) => Color.FromArgb((byte)(argb >> 24), (byte)(argb >> 16), (byte)(argb >> 8), (byte)argb);

    static SolidColorBrush Brush(uint argb)
    {
        var b = new SolidColorBrush(C(argb));
        b.Freeze();
        return b;
    }

    /// <summary>The panel's warm smoke, top to bottom. Translucent over acrylic, opaque otherwise.</summary>
    static LinearGradientBrush Smoke(uint top, uint bottom, bool translucent)
    {
        uint Alpha(uint c) => translucent ? c : c | 0xFF000000;
        var b = new LinearGradientBrush(C(Alpha(top)), C(Alpha(bottom)), new Point(0, 0), new Point(0.35, 1));
        b.Freeze();
        return b;
    }

    /// <summary>
    /// Every colour used for text is at least 4.5:1 (WCAG AA) against a card in its theme, and against
    /// the faint wash of a chip in its own colour; status colours double as text, so they're checked
    /// as text.
    /// </summary>
    public static void Apply(ResourceDictionary res)
    {
        var dark = AppsDark;
        void Put(string key, uint argb) => res[key] = Brush(argb);

        if (dark)
        {
            res["PanelBg"] = Smoke(0xC83A3532, 0xD8262322, Translucent);
            Put("PanelBorder", 0x33FFFFFF);
            Put("Surface", 0xFF2B2725); // an ordinary window (the page alarm): opaque, no acrylic
            Put("Fg", 0xFFF7F5F3);
            Put("Fg2", 0xFFC9C3BE);
            Put("Fg3", 0xFFB8B1AC);
            Put("Card", 0x14FFFFFF);
            Put("CardBorder", 0x1CFFFFFF);
            Put("CardHover", 0x1FFFFFFF);
            Put("Subtle", 0x0FFFFFFF);
            Put("Subtle2", 0x1AFFFFFF);
            Put("Divider", 0x1AFFFFFF);
            Put("Accent", 0xFFFF8A63);
            Put("AccentSoft", 0x2EFF6A3D);
            Put("Green", 0xFF5BE3A0);   // online, active, allowed
            Put("Orange", 0xFFFFBE4D);  // pending: waiting for you, ask every time
            Put("Yellow", 0xFFF5D547);  // reconnecting
            Put("Red", 0xFFFFB0B0);     // logged out, blocked, errors
            Put("Blue", 0xFF7CCBF7);    // listening, auto-reply (the icon's Telegram blue)
            Put("Gray", 0xFFC2BBB6);    // offline, idle, not set
            Washes(res, 0x26);
            Put("AccentFill", 0xFFE0501F); // white on it: 4.8:1
        }
        else
        {
            res["PanelBg"] = Smoke(0xD9F6F2EE, 0xE6ECE7E2, Translucent);
            Put("PanelBorder", 0x26000000);
            Put("Surface", 0xFFF6F2EE);
            Put("Fg", 0xFF1E1A17);
            Put("Fg2", 0xFF5B544F);
            Put("Fg3", 0xFF6B635D);
            Put("Card", 0x8CFFFFFF);
            Put("CardBorder", 0x14000000);
            Put("CardHover", 0xCCFFFFFF);
            Put("Subtle", 0x0A000000);
            Put("Subtle2", 0x12000000);
            Put("Divider", 0x14000000);
            Put("Accent", 0xFFC23A12);
            Put("AccentSoft", 0x24EE4F22);
            Put("Green", 0xFF0F6B37);
            Put("Orange", 0xFF8A5200);
            Put("Yellow", 0xFF7A6200);
            Put("Red", 0xFFA61F15);
            Put("Blue", 0xFF0D5C99);
            Put("Gray", 0xFF5F5852);
            Washes(res, 0x22);
            Put("AccentFill", 0xFFC93C14); // white on it: 5.1:1
        }
        Put("OnAccent", 0xFFFFFFFF);
        // Solid fills behind white text (Send, Always allow, the chosen segment...): each at least
        // 4.5:1 with white, so filled buttons pass WCAG AA in both themes.
        Put("GreenFill", 0xFF157A41);
        Put("OrangeFill", 0xFFA85A00);
        Put("RedFill", 0xFFC42B2B);
        Put("BlueFill", 0xFF1565A8);
        Put("GrayFill", 0xFF6B6560);
        var brand = new LinearGradientBrush(C(0xFF37AEE2), C(0xFF1B92D1), new Point(0, 0), new Point(1, 1));
        brand.Freeze();
        res["Brand"] = brand;
    }

    /// <summary>
    /// A faint fill of each status colour, for pills and banners ("GreenWash" behind "Connected"),
    /// and a stronger edge for the card of a draft waiting for you.
    /// </summary>
    static void Washes(ResourceDictionary res, byte alpha)
    {
        foreach (var name in new[] { "Green", "Orange", "Yellow", "Red", "Blue", "Gray" })
        {
            var c = ((SolidColorBrush)res[name]).Color;
            var wash = new SolidColorBrush(Color.FromArgb(alpha, c.R, c.G, c.B));
            wash.Freeze();
            res[name == "Orange" ? "PendingWash" : name + "Wash"] = wash;
        }
        var o = ((SolidColorBrush)res["Orange"]).Color;
        var edge = new SolidColorBrush(Color.FromArgb(0x66, o.R, o.G, o.B));
        edge.Freeze();
        res["PendingEdge"] = edge;
    }

    /// <summary>The status colours for the tray icon (System.Drawing), the same on both taskbars.</summary>
    public static class Status
    {
        public static readonly System.Drawing.Color Brand = System.Drawing.Color.FromArgb(0x2A, 0xA3, 0xE0);
        public static readonly System.Drawing.Color Offline = System.Drawing.Color.FromArgb(0x8E, 0x8E, 0x93);
        public static readonly System.Drawing.Color Online = System.Drawing.Color.FromArgb(0x2F, 0xC9, 0x7A);
        public static readonly System.Drawing.Color Pending = System.Drawing.Color.FromArgb(0xFF, 0xA8, 0x14);
        public static readonly System.Drawing.Color Reconnecting = System.Drawing.Color.FromArgb(0xF0, 0xC4, 0x1B);
        public static readonly System.Drawing.Color Error = System.Drawing.Color.FromArgb(0xE5, 0x3E, 0x3E);
    }

    /// <summary>Avatar colours, picked by name (see Format.AvatarIndex). Mid-tones that read on both themes.</summary>
    public static readonly Brush[] Avatars =
    [
        Brush(0xFFFF6A3D), Brush(0xFF4CC75A), Brush(0xFF62AEFF), Brush(0xFFFFAA3B),
        Brush(0xFFB57BFF), Brush(0xFF2EC4B6), Brush(0xFFFF5F8F), Brush(0xFF8D8A85),
    ];
}
