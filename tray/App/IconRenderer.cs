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
/// Draws the tray icon: the app's paper plane (docs/icon.svg) in a colour that says how things are
/// (Telegram blue online, yellow reconnecting, red logged out, grey offline), a green dot on its
/// upper-right while a session listens, and a badge on its lower-right: the count of drafts waiting
/// (amber, they need you) or "!". A clear ring separates the dot and badge from the plane. The
/// colours read on both a light and a dark taskbar.
/// </summary>
static class IconRenderer
{
    /// <summary>The plane from docs/icon.svg, on its 100×100 box; flattened once into polygons for System.Drawing.</summary>
    static readonly PointF[][] PlaneFigures = Flatten(
        "M88.723,12.142C76.419,17.238,23.661,39.091,9.084,45.047c-9.776,3.815-4.053,7.392-4.053,7.392s8.345,2.861,15.499,5.007" +
        "c7.153,2.146,10.968-0.238,10.968-0.238l33.62-22.652c11.922-8.107,9.061-1.431,6.199,1.431c-6.199,6.2-16.452,15.975-25.036,23.844" +
        "c-3.815,3.338-1.908,6.199-0.238,7.63c6.199,5.246,23.129,15.976,24.082,16.691c5.037,3.566,14.945,8.699,16.452-2.146" +
        "c0,0,5.961-37.435,5.961-37.435c1.908-12.637,3.815-24.321,4.053-27.659C97.307,8.804,88.723,12.142,88.723,12.142z");

    static PointF[][] Flatten(string data)
    {
        var geometry = System.Windows.Media.Geometry.Parse(data).GetFlattenedPathGeometry(0.05, System.Windows.Media.ToleranceType.Absolute);
        return geometry.Figures.Select(f =>
        {
            var pts = new System.Collections.Generic.List<PointF> { new((float)f.StartPoint.X, (float)f.StartPoint.Y) };
            foreach (var seg in f.Segments)
            {
                if (seg is System.Windows.Media.PolyLineSegment poly) pts.AddRange(poly.Points.Select(p => new PointF((float)p.X, (float)p.Y)));
                else if (seg is System.Windows.Media.LineSegment line) pts.Add(new((float)line.Point.X, (float)line.Point.Y));
            }
            return pts.ToArray();
        }).ToArray();
    }

    static Color PlaneColour(StatusKind health) => health switch
    {
        StatusKind.Good => Theme.Status.Brand,
        StatusKind.Busy => Theme.Status.Reconnecting,
        StatusKind.Bad => Theme.Status.Error,
        _ => Theme.Status.Offline,
    };

    /// <summary>An HICON-backed icon; the caller destroys its handle (Native.DestroyIcon) when replacing it.</summary>
    public static Icon Render(IconState state, bool darkTaskbar, int size)
    {
        using var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);
            using (var plane = Plane(new RectangleF(0, size * 0.04f, size * 0.98f, size * 0.92f)))
            using (var brush = new SolidBrush(PlaneColour(state.Health)))
            {
                g.FillPath(brush, plane);
            }
            if (state.Filled) DrawDot(g, size);
            if (state.Badge is { } badge) DrawBadge(g, badge, state.Health, size);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    /// <summary>The plane scaled to fit <paramref name="box"/>.</summary>
    static GraphicsPath Plane(RectangleF box)
    {
        var path = new GraphicsPath(FillMode.Winding);
        foreach (var figure in PlaneFigures) path.AddPolygon(figure);
        var b = path.GetBounds();
        var scale = Math.Min(box.Width / b.Width, box.Height / b.Height);
        using var m = new Matrix();
        m.Translate(box.X + (box.Width - b.Width * scale) / 2, box.Y + (box.Height - b.Height * scale) / 2);
        m.Scale(scale, scale);
        m.Translate(-b.X, -b.Y);
        path.Transform(m);
        return path;
    }

    /// <summary>Cuts a clear gap the shape of <paramref name="shape"/> grown by <paramref name="ring"/>.</summary>
    static void Knockout(Graphics g, RectangleF shape, float ring, bool round)
    {
        var oldMode = g.CompositingMode;
        g.CompositingMode = CompositingMode.SourceCopy;
        var r = RectangleF.Inflate(shape, ring, ring);
        using (var gap = round ? Circle(r) : Capsule(r))
        using (var clear = new SolidBrush(Color.Transparent))
        {
            g.FillPath(clear, gap);
        }
        g.CompositingMode = oldMode;
    }

    /// <summary>A session is listening: a green dot, top right.</summary>
    static void DrawDot(Graphics g, int size)
    {
        var d = MathF.Max(4, MathF.Round(size * 0.34f));
        var dot = new RectangleF(size - d, 0, d, d);
        Knockout(g, dot, Math.Max(1f, size / 16f), round: true);
        using var shape = Circle(dot);
        using var fill = new SolidBrush(Theme.Status.Online);
        g.FillPath(fill, shape);
    }

    static void DrawBadge(Graphics g, string text, StatusKind health, int size)
    {
        var height = MathF.Round(size * 0.58f);
        using var font = new Font("Segoe UI", height * 0.72f, FontStyle.Bold, GraphicsUnit.Pixel);
        var textSize = g.MeasureString(text, font, PointF.Empty, StringFormat.GenericTypographic);
        var width = Math.Min(size, Math.Max(height, textSize.Width + height * 0.45f));
        var pill = new RectangleF(size - width, size - height, width, height);
        Knockout(g, pill, Math.Max(1f, size / 16f), round: false);

        // A count: drafts waiting for you (amber, dark text). "!": something's wrong, in its colour.
        var pending = text != "!";
        var color = pending ? Theme.Status.Pending : health == StatusKind.Busy ? Theme.Status.Reconnecting : Theme.Status.Error;
        using (var shape = Capsule(pill))
        using (var fill = new SolidBrush(color))
        {
            g.FillPath(fill, shape);
        }
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        using var ink = new SolidBrush(pending || health == StatusKind.Busy ? Color.FromArgb(0x1E, 0x1A, 0x17) : Color.White);
        using var center = new StringFormat(StringFormat.GenericTypographic) { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString(text, font, ink, new RectangleF(pill.X, pill.Y + height * 0.03f, pill.Width, pill.Height), center);
    }

    static GraphicsPath Circle(RectangleF r)
    {
        var p = new GraphicsPath();
        p.AddEllipse(r);
        return p;
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
    /// The picture on each approval notification: the white plane on a Telegram-blue disc, saved once
    /// under %LOCALAPPDATA%\TelegramMCPTray. Null if it can't be written (the notification then has none).
    /// </summary>
    public static Uri? NotificationLogo()
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TelegramMCPTray");
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, "logo.png");
            using var bmp = Logo(96);
            bmp.Save(file, ImageFormat.Png);
            return new Uri(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Runtime.InteropServices.ExternalException)
        {
            return null;
        }
    }

    /// <summary>The app logo: the white plane on a blue disc, <paramref name="size"/> pixels square.</summary>
    public static Bitmap Logo(int size)
    {
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.Clear(Color.Transparent);
        using (var disc = new LinearGradientBrush(new RectangleF(0, 0, size, size), Color.FromArgb(0x37, 0xAE, 0xE2), Color.FromArgb(0x1B, 0x92, 0xD1), 45f))
        {
            g.FillEllipse(disc, 0, 0, size - 1, size - 1);
        }
        using var plane = Plane(new RectangleF(size * 0.2f, size * 0.24f, size * 0.56f, size * 0.52f));
        g.FillPath(Brushes.White, plane);
        return bmp;
    }
}
