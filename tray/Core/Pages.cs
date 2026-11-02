namespace TelegramMCPTray.Core;

/// <summary>What the alarm needs from the pages in /ui/state, kept here so it can be tested off Windows.</summary>
public static class Pages
{
    public static IReadOnlyList<UiPage> Ringing(IReadOnlyList<UiPage>? pages) =>
        pages is null ? [] : pages.Where(p => p.Ringing).ToList();

    /// <summary>Opens the message in Telegram: users by id, supergroups through t.me/c, basic groups by chat id.</summary>
    public static Uri? MessageUri(long? chatId, long? messageId)
    {
        if (chatId is not { } c || messageId is not { } m) return null;
        if (c > 0) return new Uri($"tg://openmessage?user_id={c}&message_id={m}");
        if (c <= -1_000_000_000_000) return new Uri($"https://t.me/c/{-c - 1_000_000_000_000}/{m}");
        return new Uri($"tg://openmessage?chat_id={-c}&message_id={m}");
    }

    /// <summary>
    /// Your own alarm sound: alarm.wav in the home folder (the sound player plays WAV only), else
    /// null for the built-in beep. Looked up on each new page, so a new file needs no restart.
    /// </summary>
    public static string? CustomAlarm(string home)
    {
        var path = Path.Combine(home, "alarm.wav");
        return File.Exists(path) ? path : null;
    }

    /// <summary>The pager beep as a WAV: three short high tones and a low one, then a pause, for looping.</summary>
    public static byte[] AlarmWav()
    {
        const int rate = 44_100;
        var samples = new List<short>();
        void Tone(double hz, double seconds)
        {
            var n = (int)(rate * seconds);
            for (var i = 0; i < n; i++)
            {
                var fade = Math.Min(1, Math.Min(i / 300.0, (n - i) / 300.0));
                samples.Add((short)(Math.Sin(2 * Math.PI * hz * i / rate) * fade * 0.85 * short.MaxValue));
            }
        }
        void Silence(double seconds) => samples.AddRange(Enumerable.Repeat((short)0, (int)(rate * seconds)));
        for (var k = 0; k < 3; k++) { Tone(988, 0.12); Silence(0.05); }
        Tone(740, 0.3);
        Silence(0.5);

        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        var bytes = samples.Count * 2;
        w.Write("RIFF"u8); w.Write(36 + bytes); w.Write("WAVEfmt "u8);
        w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(rate); w.Write(rate * 2); w.Write((short)2); w.Write((short)16);
        w.Write("data"u8); w.Write(bytes);
        foreach (var s in samples) w.Write(s);
        w.Flush();
        return ms.ToArray();
    }
}
