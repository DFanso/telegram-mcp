using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Windows.Input;
using System.Windows.Media;
using TelegramMCPTray.Core;

namespace TelegramMCPTray;

/// <summary>
/// A round avatar: the chat's Telegram profile photo once it has loaded, and until then (or when
/// it has none) initials on a colour picked by name, the same name always the same colour.
/// </summary>
public sealed record Avatar(string Initials, Brush Fill, AvatarPhoto? Photo)
{
    public static Avatar For(string name, long? chatId = null) =>
        new(Format.Initials(name), Theme.Avatars[Format.AvatarIndex(name, Theme.Avatars.Length)],
            chatId is { } id ? AvatarPhotos.For(id) : null);
}

/// <summary>One chat's photo. Null until it loads, and stays null when the chat has none.</summary>
public sealed class AvatarPhoto : Observable
{
    ImageSource? _image;
    public ImageSource? Image { get => _image; internal set { if (Set(ref _image, value)) Raise(nameof(HasImage)); } }
    public bool HasImage => _image is not null;
    internal DateTimeOffset LoadedAt { get; set; } = DateTimeOffset.MinValue;
    internal bool Loading { get; set; }
}

/// <summary>
/// The panel's photo cache: each chat's photo is asked for once when its avatar first shows (the
/// daemon fetches it from Telegram and keeps it on disk), and again at most every 6 hours, never per poll.
/// </summary>
public static class AvatarPhotos
{
    static readonly TimeSpan Refresh = TimeSpan.FromHours(6);
    static readonly Dictionary<long, AvatarPhoto> Photos = [];
    static Func<long, System.Threading.Tasks.Task<byte[]?>>? _load;

    /// <summary>Set once by the panel: how to get a photo's bytes from the daemon.</summary>
    public static void Use(Func<long, System.Threading.Tasks.Task<byte[]?>> load) => _load = load;

    public static AvatarPhoto For(long chatId)
    {
        if (!Photos.TryGetValue(chatId, out var photo)) Photos[chatId] = photo = new AvatarPhoto();
        if (_load is { } load && !photo.Loading && DateTimeOffset.UtcNow - photo.LoadedAt > Refresh) _ = LoadAsync(chatId, photo, load);
        return photo;
    }

    static async System.Threading.Tasks.Task LoadAsync(long chatId, AvatarPhoto photo, Func<long, System.Threading.Tasks.Task<byte[]?>> load)
    {
        photo.Loading = true;
        try
        {
            var bytes = await load(chatId);
            photo.LoadedAt = DateTimeOffset.UtcNow;
            // No photo, or the daemon couldn't be reached: keep what's shown (the old photo or the initials).
            if (bytes is null) return;
            photo.Image = Decode(bytes) ?? photo.Image;
        }
        catch
        {
            photo.LoadedAt = DateTimeOffset.UtcNow;
        }
        finally
        {
            photo.Loading = false;
        }
    }

    /// <summary>Decoded at 2× the 34 px avatar, so it stays sharp at 200% scaling and small in memory.</summary>
    static ImageSource? Decode(byte[] bytes)
    {
        try
        {
            var image = new System.Windows.Media.Imaging.BitmapImage();
            image.BeginInit();
            image.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
            image.DecodePixelWidth = 68;
            image.StreamSource = new System.IO.MemoryStream(bytes);
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch
        {
            return null; // not a picture WPF can read: the initials stay
        }
    }
}

/// <summary>A draft waiting for approval. Kept across polls, so a nickname being typed survives.</summary>
public sealed class ApprovalVM : Observable
{
    readonly PanelViewModel _panel;
    string _nick;
    string _ago = "";
    bool _busy;
    bool _expanded;

    public ApprovalVM(PanelViewModel panel, UiApproval item)
    {
        _panel = panel;
        Item = item;
        _nick = item.SuggestedNickname;
        Deny = Command.Async(() => _panel.DecideAsync(this, new Decision(false)));
        Approve = Command.Async(() => _panel.DecideAsync(this, new Decision(true)));
        AskEveryTime = Command.Async(() => _panel.DecideAsync(this, new Decision(true, "requireApproval", Nick)));
        AlwaysAllow = Command.Async(() => _panel.DecideAsync(this, new Decision(true, "autoSend", Nick)));
        ToggleText = new Command(_ => { if (IsLong) Expanded = !Expanded; });
    }

    public UiApproval Item { get; }
    public string Id => Item.Id;
    public string To => Item.To;
    public Avatar Avatar => Avatar.For(Item.Nickname ?? Item.To, Item.ChatId);
    public string Text => Item.Text;
    public string Detail => Item.Detail;
    public string ReasonLine => $"{Item.Reason} · {Item.SessionLabel}";
    /// <summary>Why it waits for you, as the daemon puts it ("this chat is on the requireApproval list").</summary>
    public string Reason => Item.Reason;
    /// <summary>"Asked by api-server · pid 4121": which Claude session wants to send it.</summary>
    public string AskedBy => $"Asked by {Item.SessionLabel}";
    public bool FirstTime => Item.FirstTime;
    /// <summary>First message to a chat that has no nickname yet: the nickname box shows.</summary>
    public bool AsksNickname => Item.FirstTime && Item.Nickname is null;
    public bool HasNickname => Item.FirstTime && Item.Nickname is not null;
    public string? ExistingNickname => Item.Nickname;

    public string Nick { get => _nick; set => Set(ref _nick, value); }

    /// <summary>A draft longer than the card's 4 lines: clicking it (or Show all) opens it. Nothing opens on hover.</summary>
    public bool IsLong => Format.IsLongDraft(Item.Text);

    public bool Expanded
    {
        get => _expanded;
        set
        {
            if (Set(ref _expanded, value)) Raise(nameof(ExpandLabel));
        }
    }

    public string ExpandLabel => _expanded ? "Show less" : "Show all";
    public string Ago
    {
        get => _ago;
        set
        {
            if (Set(ref _ago, value)) Raise(nameof(AgoText));
        }
    }

    /// <summary>"just now", "5m ago".</summary>
    public string AgoText => AgoWords(_ago);

    internal static string AgoWords(string ago) => ago == "now" ? "just now" : $"{ago} ago";

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
    public ICommand ToggleText { get; }
}

/// <summary>
/// A chat a session listens to. <see cref="Nickname"/>: its saved name, whose auto-reply switch pauses
/// and resumes listening (null when the chat isn't saved, so there is no button).
/// </summary>
public sealed record WatchVM(string ChatLabel, string? From, string? Topic, string Tooltip, string? Nickname, bool Paused, ICommand Toggle)
{
    public bool CanToggle => Nickname is not null;
    public string ToggleIcon => Paused ? "play" : "pause";
    public string ToggleName => Paused ? $"Resume listening to {ChatLabel}" : $"Pause listening to {ChatLabel}";
    public string ToggleTip => Paused
        ? $"Resume: {ChatLabel}'s messages reach Claude again (turns auto-reply back on)"
        : $"Pause: stop passing {ChatLabel}'s messages to Claude (turns auto-reply off; the watch stays)";
}

/// <summary>A Claude session listening to chats.</summary>
public sealed record SessionVM(string Label, Tag Tag, IReadOnlyList<WatchVM> Watches)
{
    public static SessionVM From(UiSession s, UiState state, ICommand toggle) => new(
        s.Label,
        Presenter.SessionTag(s),
        s.Watches.Select(w =>
        {
            var contact = Presenter.ListeningSwitch(state, w.ChatId);
            var paused = contact is { AutoReply: false };
            return new WatchVM(
                w.ChatLabel,
                w.FromLabel is null ? null : $"from {w.FromLabel}",
                w.TopicId is null ? null : $"topic {w.TopicId}",
                paused ? $"{w.Note ?? w.ChatLabel} (paused)" : w.Note ?? w.ChatLabel,
                contact?.Nickname,
                paused,
                toggle);
        }).ToList());
}

public sealed record RecentMessageVM(string Body, string Meta);

/// <summary>
/// A chat sent to lately; clicking it shows (or hides) the last three messages. Rebuilt when the
/// list changes, so the panel keeps which chats are open (<see cref="PanelViewModel"/>).
/// </summary>
public sealed class RecentChatVM : Observable
{
    bool _open;

    RecentChatVM(long chatId, string label, string? count, string ago, IReadOnlyList<RecentMessageVM> messages, bool open, Action<RecentChatVM> toggle)
    {
        ChatId = chatId;
        Label = label;
        Count = count;
        Ago = ago;
        Messages = messages;
        _open = open;
        Toggle = new Command(_ => toggle(this));
    }

    public static RecentChatVM From(RecentChat c, string footer, DateTimeOffset now, bool open, Action<RecentChatVM> toggle) => new(
        c.ChatId,
        c.Label,
        c.Messages.Count > 1 ? c.Messages.Count.ToString(System.Globalization.CultureInfo.InvariantCulture) : null,
        Format.Ago(c.Messages[0].At, now),
        c.Messages.Take(3).Select(m => new RecentMessageVM(
            Format.StripFooter(m.Text, footer),
            $"{Format.Ago(m.At, now)} · {Format.ViaLabel(m.Via)}{(m.SessionLabel is null ? "" : $" · {m.SessionLabel}")}{(m.Edited is null ? "" : $" · edited {Format.Ago(m.Edited.At, now)}")}")).ToList(),
        open,
        toggle);

    public long ChatId { get; }
    public string Label { get; }
    public Avatar Avatar => Avatar.For(Label, ChatId);
    /// <summary>"3 messages · 5m": how many were sent there lately, and when the last one went.</summary>
    public string Summary => $"{(Count is null ? "1 message" : $"{Count} messages")} · last sent {ApprovalVM.AgoWords(Ago)}";
    public string? Count { get; }
    public string Ago { get; }
    public IReadOnlyList<RecentMessageVM> Messages { get; }

    public bool IsOpen
    {
        get => _open;
        set
        {
            if (Set(ref _open, value)) Raise(nameof(Chevron));
        }
    }

    public string Chevron => _open ? "chevron-up" : "chevron-down";
    public ICommand Toggle { get; }
}

/// <summary>A saved chat on the Contacts page. Updated in place, so the open row and a half-typed name survive polls.</summary>
public sealed class ContactVM : Observable
{
    readonly PanelViewModel _panel;
    UiContact _c;
    string? _defaultPolicy;
    string _renameText;
    string _pageReason = "";
    bool _busy;
    bool _paging;

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
        SetPageFrom = new Command(p =>
        {
            var on = p is "on";
            if (on != _c.PagesMe) _ = Edit(new ContactChange(Nickname, PageFrom: on));
        });
        SendPage = new Command(_ => _ = _panel.PageContactAsync(this), _ => CanSendPage);
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
    public Avatar Avatar => Avatar.For(_c.Name ?? _c.Nickname, _c.ChatId);
    /// <summary>Groups, channels and bots get a glyph on their avatar instead of initials.</summary>
    public bool ShowsGlyph => Kind is ContactKind.Group or ContactKind.Channel or ContactKind.Bot;
    public string Subtitle => Contacts.Subtitle(_c);
    public ContactKind Kind => Contacts.Kind(_c);
    /// <summary>The Lucide icon on a group's, channel's or bot's avatar.</summary>
    public string KindIcon => Kind switch
    {
        ContactKind.Bot => "bot",
        ContactKind.Group => "users",
        ContactKind.Channel => "megaphone",
        ContactKind.Person => "user",
        _ => "message-circle",
    };
    public Tag? AutoReplyTag => Contacts.AutoReplyTag(_c);
    public Tag? PageFromTag => Contacts.PageFromTag(_c);
    public Tag ModeTag => Contacts.ModeTag(_c, _defaultPolicy);
    public string Explanation => Contacts.Explanation(_c, _defaultPolicy);
    public string Details => Contacts.Details(_c);

    public bool IsAutoSend => _c.SendMode == "autoSend";
    public bool IsAsk => _c.SendMode == "requireApproval";
    public bool IsBlocked => _c.SendMode == "blocked";
    public bool ReplyOn => _c.AutoReply;
    public bool ReplyOff => !_c.AutoReply;

    /// <summary>A person: the "Can page me" choice and the Page button show.</summary>
    public bool CanPage => _c.CanPage;
    public bool PageOn => _c.PagesMe;
    public bool PageOff => !_c.PagesMe;
    public string PageTitle => $"Page {_c.Nickname}";

    public string PageReason { get => _pageReason; set => Set(ref _pageReason, value); }

    public bool Paging
    {
        get => _paging;
        set
        {
            if (!Set(ref _paging, value)) return;
            Raise(nameof(PageButtonText));
            CommandManager.InvalidateRequerySuggested(); // the Page button's enabled state
        }
    }

    public string PageButtonText => _paging ? "Paging…" : "Page";
    bool CanSendPage => !_paging && !Contacts.Blocked(_c, _defaultPolicy);

    public bool IsOpen => _panel.OpenNickname == Nickname;
    public string Chevron => IsOpen ? "chevron-up" : "chevron-down";
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
    public ICommand SetPageFrom { get; }
    public ICommand SendPage { get; }
}
