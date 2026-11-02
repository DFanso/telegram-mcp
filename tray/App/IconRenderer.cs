using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Linq;
using TelegramMCPTray.Core;

namespace TelegramMCPTray;

/// <summary>
/// Draws the tray icon like the menu bar's: a paper plane (outline, or filled while a session
/// listens) with a small badge on its lower-right corner, the count of drafts waiting or "!". A
/// clear ring separates the badge from the plane. The plane is white on a dark taskbar, near-black
/// on a light one.
/// </summary>
static class IconRenderer
{
    const string Send = "", SendFill = "";

    static readonly string? IconFamily = new[] { "Segoe Fluent Icons", "Segoe MDL2 Assets" }
        .FirstOrDefault(name => FontFamily.Families.Any(f => f.Name == name));

    /// <summary>An HICON-backed icon; the caller destroys its handle (Native.DestroyIcon) when replacing it.</summary>
    public static Icon Render(IconState state, bool darkTaskbar, int size)
    {
        using var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);
            var fg = darkTaskbar ? Color.White : Color.FromArgb(0x1B, 0x1B, 0x1B);
            using (var plane = Plane(state.Filled, new RectangleF(size * 0.04f, size * 0.04f, size * 0.92f, size * 0.92f)))
            using (var brush = new SolidBrush(fg))
            {
                g.FillPath(brush, plane);
            }
            if (state.Badge is { } badge) DrawBadge(g, badge, size);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    /// <summary>The plane glyph scaled to fit <paramref name="box"/>; a drawn plane if the icon font is missing.</summary>
    static GraphicsPath Plane(bool filled, RectangleF box)
    {
        var path = new GraphicsPath();
        if (IconFamily is not null)
        {
            using var family = new FontFamily(IconFamily);
            path.AddString(filled ? SendFill : Send, family, (int)FontStyle.Regular, 100, PointF.Empty, StringFormat.GenericTypographic);
        }
        else
        {
            // A plain paper plane pointing right: the body, with a notch for the fold.
            path.AddPolygon(new PointF[] { new(0, 0), new(100, 50), new(0, 100), new(18, 50) });
        }
        var b = path.GetBounds();
        var scale = Math.Min(box.Width / b.Width, box.Height / b.Height);
        using var m = new Matrix();
        m.Translate(box.X + (box.Width - b.Width * scale) / 2, box.Y + (box.Height - b.Height * scale) / 2);
        m.Scale(scale, scale);
        m.Translate(-b.X, -b.Y);
        path.Transform(m);
        return path;
    }

    static void DrawBadge(Graphics g, string text, int size)
    {
        var height = MathF.Round(size * 0.58f);
        using var font = new Font("Segoe UI", height * 0.72f, FontStyle.Bold, GraphicsUnit.Pixel);
        var textSize = g.MeasureString(text, font, PointF.Empty, StringFormat.GenericTypographic);
        var width = Math.Min(size, Math.Max(height, textSize.Width + height * 0.45f));
        var pill = new RectangleF(size - width, size - height, width, height);
        var ring = Math.Max(1f, size / 16f);

        // Knock a clear gap around the badge, then draw it.
        var oldMode = g.CompositingMode;
        g.CompositingMode = CompositingMode.SourceCopy;
        using (var gap = Capsule(RectangleF.Inflate(pill, ring, ring)))
        using (var clear = new SolidBrush(Color.Transparent))
        {
            g.FillPath(clear, gap);
        }
        g.CompositingMode = oldMode;

        var color = text == "!" ? Color.FromArgb(0xCA, 0x50, 0x10) : Color.FromArgb(0xD1, 0x34, 0x38);
        using (var shape = Capsule(pill))
        using (var fill = new SolidBrush(color))
        {
            g.FillPath(fill, shape);
        }
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        using var white = new SolidBrush(Color.White);
        using var center = new StringFormat(StringFormat.GenericTypographic) { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString(text, font, white, new RectangleF(pill.X, pill.Y + height * 0.03f, pill.Width, pill.Height), center);
    }

    static GraphicsPath Capsule(RectangleF r)
    {
        var d = Math.Min(r.Width, r.Height);
        var p = new GraphicsPath();
        p.AddArc(r.X, r.Y, d, d, 90, 180);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 180);
        p.CloseFigure();
        return p;
    }

    /// <summary>
    /// The picture on each approval notification: the filled plane, white on the accent colour, saved
    /// once under %LOCALAPPDATA%\TelegramMCPTray. Null if it can't be written (the notification then has none).
    /// </summary>
    public static Uri? NotificationLogo(System.Windows.Media.Color accent)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TelegramMCPTray");
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, "logo.png");
            const int size = 96;
            using var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.FromArgb(accent.A, accent.R, accent.G, accent.B));
                using var plane = Plane(true, new RectangleF(size * 0.24f, size * 0.24f, size * 0.52f, size * 0.52f));
                g.FillPath(Brushes.White, plane);
            }
            bmp.Save(file, ImageFormat.Png);
            return new Uri(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Runtime.InteropServices.ExternalException)
        {
            return null;
        }
    }
}
