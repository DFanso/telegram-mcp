using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using TelegramMCPTray.Core;
using ComFileTime = System.Runtime.InteropServices.ComTypes.FILETIME;

namespace TelegramMCPTray;

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    struct Credential
    {
        public int Flags;
        public int Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public ComFileTime LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    const int CredTypeGeneric = 1;
    const int ErrorNotFound = 1168;

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr buffer);

    /// <summary>A generic credential's secret, as UTF-8 text (how Bun.secrets stores it). Null if there is none.</summary>
    public static string? ReadGenericCredential(string target, out int error)
    {
        error = 0;
        if (!CredRead(target, CredTypeGeneric, 0, out var ptr))
        {
            error = Marshal.GetLastWin32Error();
            return null;
        }
        try
        {
            var cred = Marshal.PtrToStructure<Credential>(ptr);
            var bytes = new byte[cred.CredentialBlobSize];
            if (bytes.Length > 0) Marshal.Copy(cred.CredentialBlob, bytes, 0, bytes.Length);
            return Encoding.UTF8.GetString(bytes);
        }
        finally
        {
            CredFree(ptr);
        }
    }

    public static bool IsNotFound(int error) => error == ErrorNotFound;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr icon);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    public const uint SwpNoSize = 0x0001, SwpNoMove = 0x0002, SwpNoZOrder = 0x0004, SwpNoActivate = 0x0010;

    public const int WmWindowPosChanging = 0x0046;

    /// <summary>WM_WINDOWPOSCHANGING's lParam: where the window is about to go, and how big it is about to be.</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct WindowPos
    {
        public IntPtr Hwnd, InsertAfter;
        public int X, Y, Cx, Cy;
        public uint Flags;
    }

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>Windows 11 rounds the panel's corners like its own flyouts; Windows 10 ignores this.</summary>
    public static void RoundCorners(IntPtr hwnd)
    {
        const int DwmwaWindowCornerPreference = 33, DwmwcpRound = 2;
        var round = DwmwcpRound;
        _ = DwmSetWindowAttribute(hwnd, DwmwaWindowCornerPreference, ref round, sizeof(int));
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Margins
    {
        public int Left, Right, Top, Bottom;
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);

    /// <summary>
    /// Windows 11 22H2+: acrylic (the "transient window" backdrop flyouts use) behind the whole
    /// window, in the app's light or dark mode. The window has to paint a transparent background for
    /// it to show. False when Windows refused, so the caller can paint an opaque background instead.
    /// </summary>
    public static bool Acrylic(IntPtr hwnd, bool dark)
    {
        const int DwmwaUseImmersiveDarkMode = 20, DwmwaSystemBackdropType = 38, DwmsbtTransientWindow = 3;
        var on = dark ? 1 : 0;
        _ = DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref on, sizeof(int));
        var all = new Margins { Left = -1, Right = -1, Top = -1, Bottom = -1 };
        if (DwmExtendFrameIntoClientArea(hwnd, ref all) != 0) return false;
        var backdrop = DwmsbtTransientWindow;
        return DwmSetWindowAttribute(hwnd, DwmwaSystemBackdropType, ref backdrop, sizeof(int)) == 0;
    }
}

/// <summary>
/// The token in Windows Credential Manager, where the daemon keeps it through Bun.secrets: a
/// generic credential named "telegram-mcp/token" (see Settings.TokenTarget). Reading it never asks
/// the user anything, unlike the macOS Keychain.
/// </summary>
sealed class CredentialTokenSource(string target) : ITokenSource
{
    public TokenRead Read()
    {
        var value = Native.ReadGenericCredential(target, out var error);
        if (value is null)
        {
            return Native.IsNotFound(error)
                ? new(null, TokenRead.NoTokenYet, TimeSpan.FromSeconds(2))
                : new(null, $"Could not read the token from Windows Credential Manager ({target}): {new Win32Exception(error).Message}",
                    TimeSpan.FromSeconds(10));
        }
        var token = value.Trim();
        return token.Length > 0 ? new(token, null, TimeSpan.Zero) : new(null, TokenRead.NoTokenYet, TimeSpan.FromSeconds(2));
    }
}
