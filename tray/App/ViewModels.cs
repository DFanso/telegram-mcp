using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Windows.Input;
using TelegramMCPTray.Core;

namespace TelegramMCPTray;

/// <summary>A draft waiting for approval. Kept across polls, so a nickname being typed survives.</summary>
public sealed class ApprovalVM : Observable
{
    readonly PanelViewModel _panel;
    string _nick;
    string _ago = "";
    bool _busy;

    public ApprovalVM(PanelViewModel panel, UiApproval item)
    {
        _panel = panel;
        Item = item;
        _nick = item.SuggestedNickname;
        Deny = Command.Async(() => _panel.DecideAsync(this, new Decision(false)));
        Approve = Command.Async(() => _panel.DecideAsync(this, new Decision(true)));
        AskEveryTime = Command.Async(() => _panel.DecideAsync(this, new Decision(true, "requireApproval", Nick)));
        AlwaysAllow = Command.Async(() => _panel.DecideAsync(this, new Decision(true, "autoSend", Nick)));
    }

    public UiApproval Item { get; }
    public string Id => Item.Id;
    public string To => Item.To;
    public string Text => Item.Text;
    public string Detail => Item.Detail;
    public string ReasonLine => $"{Item.Reason} · {Item.SessionLabel}";
    public bool FirstTime => Item.FirstTime;
    /// <summary>First message to a chat that has no nickname yet: the nickname box shows.</summary>
    public bool AsksNickname => Item.FirstTime && Item.Nickname is null;
    public bool HasNickname => Item.FirstTime && Item.Nickname is not null;
    public string? ExistingNickname => Item.Nickname;

    public string Nick { get => _nick; set => Set(ref _nick, value); }
    public string Ago { get => _ago; set => Set(ref _ago, value); }

    public bool Busy
    {
        get => _busy;
        set
        {
            if (Set(ref _busy, value)) Raise(nameof(Idle));
        }
    }

    public bool Idle => !_busy;

    public ICommand Deny { get; }
    public ICommand Approve { get; }
    public ICommand AskEveryTime { get; }
    public ICommand AlwaysAllow { get; }
}

public sealed record WatchVM(string ChatLabel, string? From, string? Topic, string Tooltip);

/// <summary>A Claude session listening to chats.</summary>
public sealed record SessionVM(string Label, Tag Tag, IReadOnlyList<WatchVM> Watches)
{
    public static SessionVM From(UiSession s) => new(
        s.Label,
        Presenter.SessionTag(s),
        s.Watches.Select(w => new WatchVM(
            w.ChatLabel,
            w.FromLabel is null ? null : $"from {w.FromLabel}",
            w.TopicId is null ? null : $"topic {w.TopicId}",
            w.Note ?? w.ChatLabel)).ToList());
}

public sealed record RecentMessageVM(string Body, string Meta);

/// <summary>A chat sent to lately; hovering it shows the last three messages.</summary>
public sealed record RecentChatVM(string Label, string? Count, string Ago, IReadOnlyList<RecentMessageVM> Messages)
{
    public static RecentChatVM From(RecentChat c, string footer, DateTimeOffset now) => new(
        c.Label,
        c.Messages.Count > 1 ? c.Messages.Count.ToString(System.Globalization.CultureInfo.InvariantCulture) : null,
        Format.Ago(c.Messages[0].At, now),
        c.Messages.Take(3).Select(m => new RecentMessageVM(
            Format.StripFooter(m.Text, footer),
            $"{Format.Ago(m.At, now)} · {Format.ViaLabel(m.Via)}{(m.SessionLabel is null ? "" : $" · {m.SessionLabel}")}")).ToList());
}

/// <summary>A saved chat on the Contacts page. Updated in place, so the open row and a half-typed name survive polls.</summary>
public sealed class ContactVM : Observable
{
    readonly PanelViewModel _panel;
    UiContact _c;
    string? _defaultPolicy;
    string _renameText;
    bool _busy;

    public ContactVM(PanelViewModel panel, UiContact contact, string? defaultPolicy)
    {
        _panel = panel;
        _c = contact;
        _defaultPolicy = defaultPolicy;
        _renameText = contact.Nickname;
        Toggle = new Command(_ => _panel.OpenNickname = IsOpen ? null : Nickname);
        Rename = new Command(_ => _ = Edit(new ContactChange(Nickname, Rename: RenameText.Trim())), _ => CanRename);
        SetMode = new Command(p => { if (p is string mode && mode != _c.SendMode) _ = Edit(new ContactChange(Nickname, SendMode: mode)); });
        SetAutoReply = new Command(p =>
        {
            var on = p is "on";
            if (on != _c.AutoReply) _ = Edit(new ContactChange(Nickname, AutoReply: on));
        });
    }

    System.Threading.Tasks.Task Edit(ContactChange change) => _panel.EditContactAsync(this, change);

    public void Update(UiContact contact, string? defaultPolicy)
    {
        // Records compare their lists by reference, and every poll brings new lists: compare the JSON.
        if (defaultPolicy == _defaultPolicy && JsonSerializer.Serialize(contact) == JsonSerializer.Serialize(_c)) return;
        _c = contact;
        _defaultPolicy = defaultPolicy;
        Raise(string.Empty); // every property
    }

    public string Nickname => _c.Nickname;
    public string Subtitle => Contacts.Subtitle(_c);
    public ContactKind Kind => Contacts.Kind(_c);
    public string KindGlyph => Kind switch
    {
        ContactKind.Person => "",
        ContactKind.Bot => "",
        ContactKind.Group => "",
        ContactKind.Channel => "",
        _ => "",
    };
    public Tag? AutoReplyTag => Contacts.AutoReplyTag(_c);
    public Tag ModeTag => Contacts.ModeTag(_c, _defaultPolicy);
    public string Explanation => Contacts.Explanation(_c, _defaultPolicy);
    public string Details => Contacts.Details(_c);

    public bool IsAutoSend => _c.SendMode == "autoSend";
    public bool IsAsk => _c.SendMode == "requireApproval";
    public bool IsBlocked => _c.SendMode == "blocked";
    public bool ReplyOn => _c.AutoReply;
    public bool ReplyOff => !_c.AutoReply;

    public bool IsOpen => _panel.OpenNickname == Nickname;
    public string Chevron => IsOpen ? "" : "";
    internal void OpenChanged()
    {
        Raise(nameof(IsOpen));
        Raise(nameof(Chevron));
    }

    public string RenameText
    {
        get => _renameText;
        set
        {
            if (Set(ref _renameText, value)) Raise(nameof(CanRename));
        }
    }

    public bool CanRename => !_busy && Contacts.CanRename(_c, _renameText);

    public bool Busy
    {
        get => _busy;
        set
        {
            if (!Set(ref _busy, value)) return;
            Raise(nameof(Idle));
            Raise(nameof(CanRename));
            CommandManager.InvalidateRequerySuggested(); // Rename's enabled state
        }
    }

    public bool Idle => !_busy;

    public ICommand Toggle { get; }
    public ICommand Rename { get; }
    public ICommand SetMode { get; }
    public ICommand SetAutoReply { get; }
}
