using System;
using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;
using Windows.UI.ViewManagement;

namespace TelegramMCPTray;

/// <summary>Follows Windows: light or dark apps for the panel, light or dark taskbar for the icon, and the accent colour.</summary>
static class Theme
{
    const string Personalize = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    static bool Light(string value, bool fallback)
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
    public static bool AppsDark => !Light("AppsUseLightTheme", true);

    /// <summary>"Choose your default Windows mode": the taskbar the tray icon sits on.</summary>
    public static bool TaskbarDark => !Light("SystemUsesLightTheme", false);

    static Color Accent(bool dark)
    {
        try
        {
            var ui = new UISettings();
            // The lighter shade reads better on a dark panel, the darker one on a light panel.
            var c = ui.GetColorValue(dark ? UIColorType.AccentLight2 : UIColorType.AccentDark1);
            return Color.FromArgb(c.A, c.R, c.G, c.B);
        }
        catch (Exception)
        {
            return dark ? Color.FromRgb(0x4C, 0xC2, 0xFF) : Color.FromRgb(0x00, 0x5F, 0xB8);
        }
    }

    static SolidColorBrush Brush(uint argb)
    {
        var b = new SolidColorBrush(Color.FromArgb((byte)(argb >> 24), (byte)(argb >> 16), (byte)(argb >> 8), (byte)argb));
        b.Freeze();
        return b;
    }

    public static void Apply(ResourceDictionary res)
    {
        var dark = AppsDark;
        void Put(string key, uint argb) => res[key] = Brush(argb);

        if (dark)
        {
            Put("PanelBg", 0xFF2B2B2B);
            Put("PanelBorder", 0xFF404040);
            Put("Fg", 0xFFFFFFFF);
            Put("Fg2", 0xFFC8C8C8);
            Put("Fg3", 0xFF8B8B8B);
            Put("Subtle", 0x0DFFFFFF);
            Put("Subtle2", 0x17FFFFFF);
            Put("Divider", 0x1FFFFFFF);
            Put("Green", 0xFF3FB950);
            Put("Orange", 0xFFF7840C);
            Put("Red", 0xFFF85149);
            Put("Blue", 0xFF4C9AFF);
        }
        else
        {
            Put("PanelBg", 0xFFF9F9F9);
            Put("PanelBorder", 0xFFD9D9D9);
            Put("Fg", 0xFF1B1B1B);
            Put("Fg2", 0xFF5C5C5C);
            Put("Fg3", 0xFF8A8A8A);
            Put("Subtle", 0x0A000000);
            Put("Subtle2", 0x12000000);
            Put("Divider", 0x1A000000);
            Put("Green", 0xFF1A7F37);
            Put("Orange", 0xFFD9640C);
            Put("Red", 0xFFCF222E);
            Put("Blue", 0xFF0969DA);
        }
        Put("Gray", 0xFF8B8B8B);
        Put("Yellow", 0xFFE3B341);
        var accent = new SolidColorBrush(Accent(dark));
        accent.Freeze();
        res["Accent"] = accent;
    }
}
