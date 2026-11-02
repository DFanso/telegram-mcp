using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Toolkit.Uwp.Notifications;
using TelegramMCPTray.Core;

namespace TelegramMCPTray;

/// <summary>
/// A Windows notification for each draft, with the panel's choices as buttons, so a draft can be
/// decided without opening the panel. Each is tagged with its draft id and taken down once the
/// draft is decided anywhere.
/// </summary>
sealed class Toasts(Uri? logo)
{
    const string Group = "approvals";
    readonly HashSet<string> _shown = [];

    /// <summary>A button was clicked (draft id, what to do), or the notification itself (action null: open the panel).</summary>
    public event Action<string, NoticeAction?>? Activated;

    public void Listen()
    {
        ToastNotificationManagerCompat.OnActivated += e =>
        {
            var args = ToastArguments.Parse(e.Argument);
            if (!args.TryGetValue("approval", out var id)) return;
            NoticeAction? action = args.TryGetValue("action", out var a) && Enum.TryParse<NoticeAction>(a, out var parsed) ? parsed : null;
            Activated?.Invoke(id, action);
        };
    }

    /// <summary>Call with the drafts waiting after each successful poll.</summary>
    public void Update(IReadOnlyList<UiApproval> waiting)
    {
        var (show, remove) = ApprovalNotices.Diff(_shown, waiting);
        foreach (var id in remove)
        {
            Remove(id);
            _shown.Remove(id);
        }
        foreach (var a in show)
        {
            Show(a);
            _shown.Add(a.Id);
        }
    }

    void Show(UiApproval a)
    {
        var n = ApprovalNotices.Content(a);
        var toast = new ToastContentBuilder()
            .AddArgument("approval", a.Id)
            .AddText(n.Title)
            .AddText(n.Subtitle, hintMaxLines: 1)
            .AddText(n.Body);
        if (logo is not null) toast.AddAppLogoOverride(logo, ToastGenericAppLogoCrop.Circle);
        foreach (var b in n.Buttons)
        {
            toast.AddButton(new ToastButton()
                .SetContent(b.Label)
                .AddArgument("approval", a.Id)
                .AddArgument("action", b.Action.ToString())
                .SetBackgroundActivation());
        }
        Safely(() => toast.Show(t =>
        {
            t.Tag = a.Id;
            t.Group = Group;
        }));
    }

    public static void Remove(string id) => Safely(() => ToastNotificationManagerCompat.History.Remove(id, Group));

    /// <summary>On quit: no buttons left behind that would start the app again.</summary>
    public static void Clear() => Safely(ToastNotificationManagerCompat.History.Clear);

    /// <summary>Notifications are a convenience: if Windows refuses (turned off, Focus assist), the panel still works.</summary>
    internal static void Safely(Action act)
    {
        try
        {
            act();
        }
        catch (Exception e) when (e is COMException or InvalidOperationException or UnauthorizedAccessException)
        {
            Log.Write($"notification: {e.Message}");
        }
    }
}
