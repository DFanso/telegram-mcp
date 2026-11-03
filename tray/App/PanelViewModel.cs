using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Input;
using System.Windows.Threading;
using TelegramMCPTray.Core;

namespace TelegramMCPTray;

/// <summary>
/// Everything the panel shows, polled from the daemon every 2 s (which also tells the daemon to send
/// approvals here rather than to the Claude Code dialog). Lives on the UI thread.
/// </summary>
public sealed class PanelViewModel : Observable
{
    readonly DaemonApi _api;
    readonly Settings _settings;
    readonly DispatcherTimer _timer;
    readonly DispatcherTimer _flashTimer;
    readonly Dictionary<string, ApprovalVM> _approvals = [];
    readonly Dictionary<string, ContactVM> _contacts = [];
    string _sessionsKey = "", _recentKey = "";
    /// <summary>Recently sent chats the user clicked open, by chat id: kept when the rows are rebuilt.</summary>
    readonly HashSet<long> _openRecent = [];
    bool _polling;

    UiState? _state;
    bool _reachable;
    string? _problem;
    string? _flash;
    bool _flashOk = true;
    IReadOnlyList<Stat> _stats = [];
    bool _contactsPage;
    bool _awayPage, _awayLoaded, _awaySaving;
    bool _awayEnabled;
    string _awayFrom = "", _awayUntil = "", _awayMessage = "", _awayQuiet = "";
    /// <summary>What the daemon has saved as far as this page knows: the fields as loaded, then as last sent. Save diffs against it.</summary>
    (bool Enabled, string From, string Until, string Message, int Quiet)? _awaySaved;
    string _search = "";
    string? _openNickname;

    public PanelViewModel(DaemonApi api, Settings settings)
    {
        _api = api;
        _settings = settings;
        AvatarPhotos.Use(chatId => _api.AvatarAsync(chatId));
        _timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromSeconds(2) };
        _timer.Tick += async (_, _) => await PollAsync();
        _flashTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(6) };
        _flashTimer.Tick += (_, _) =>
        {
            _flashTimer.Stop();
            Flash = null;
        };
        ShowContacts = new Command(_ => ContactsPage = true);
        ShowMain = new Command(_ => ContactsPage = false);
        ShowAway = new Command(_ =>
        {
            ContactsPage = false;
            LoadAway();
            AwayPage = true;
        });
        SetAwayEnabled = new Command(p => _ = ToggleAwayAsync(p as string == "on"), _ => !_awaySaving && AwayShown);
        SaveAway = new Command(_ => _ = SaveAwayAsync(), _ => !_awaySaving && AwayError is null && AwayShown);
        ClearSearch = new Command(_ => Search = "");
        OpenRules = new Command(_ => OpenFile("config.json"));
        OpenLog = new Command(_ => OpenFile("daemon.log"));
        Quit = new Command(_ => QuitRequested?.Invoke());
        ToggleListening = Command.Async(p => p is WatchVM w ? ToggleListeningAsync(w) : Task.CompletedTask);
    }

    /// <summary>After every poll: the tray icon, tooltip and notifications follow.</summary>
    public event Action? Polled;
    public event Action? QuitRequested;

    public void Start()
    {
        _timer.Start();
        _ = PollAsync();
    }

    public UiState? State { get => _state; private set => Set(ref _state, value); }
    public bool Reachable { get => _reachable; private set => Set(ref _reachable, value); }
    public string? Problem { get => _problem; private set => Set(ref _problem, value); }

    public Status Header => Presenter.Header(State, Reachable);
    public bool ShowContent => Reachable && State is not null;
    public string? ShownProblem => ShowContent ? null : Problem;
    public string? ConfigError => ShowContent ? State?.ConfigError : null;

    /// <summary>Home's tiles: waiting, listening, contacts. Replaced only when a number changes, so the tiles aren't rebuilt every poll.</summary>
    public IReadOnlyList<Stat> Stats => _stats;

    public ObservableCollection<ApprovalVM> Approvals { get; } = [];
    public ObservableCollection<SessionVM> Listening { get; } = [];
    public ObservableCollection<RecentChatVM> Recent { get; } = [];
    public ObservableCollection<ContactVM> ContactRows { get; } = [];

    public string? ApprovalCount => Approvals.Count > 0 ? Approvals.Count.ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
    public bool NoApprovals => Approvals.Count == 0;
    public bool NoListening => Listening.Count == 0;
    public bool NoRecent => Recent.Count == 0;

    public string? Flash { get => _flash; private set => Set(ref _flash, value); }

    /// <summary>Whether the flash reports something that worked (a check) or didn't (a warning, in red).</summary>
    public bool FlashOk { get => _flashOk; private set => Set(ref _flashOk, value); }

    // ---- the Contacts page --------------------------------------------------------------

    /// <summary>Contacts when true, Home when false. Either way the Away page closes, so the menu and Ctrl+1 / Ctrl+2 always land where they say.</summary>
    public bool ContactsPage
    {
        get => _contactsPage;
        set
        {
            AwayPage = false;
            if (!Set(ref _contactsPage, value)) return;
            Raise(nameof(MainPage));
            if (!value) Search = "";
        }
    }

    public bool MainPage => !_contactsPage && !_awayPage;

    // ---- the Away page --------------------------------------------------------------------

    public bool AwayPage
    {
        get => _awayPage;
        private set
        {
            if (!Set(ref _awayPage, value)) return;
            Raise(nameof(MainPage));
        }
    }

    /// <summary>The daemon sent an away state, so the page can show its fields.</summary>
    public bool AwayShown => ShowContent && State?.Away is not null;

    /// <summary>Instead of the fields: a daemon too old to know about away.</summary>
    public string? AwayPlaceholder => ShowContent && State!.Away is null ? Away.OlderDaemon : null;

    public string? AwayStatus => State?.Away is { } a ? Away.Status(a) : null;

    /// <summary>"Away until 09:00" on the main page while replies can go out.</summary>
    public string? AwayBadge => ShowContent ? Away.Badge(State?.Away) : null;

    public bool AwayEnabled
    {
        get => _awayEnabled;
        set
        {
            if (!Set(ref _awayEnabled, value)) return;
            Raise(nameof(AwayDisabled));
        }
    }

    public bool AwayDisabled => !_awayEnabled;

    public string AwayFrom
    {
        get => _awayFrom;
        set => EditAway(ref _awayFrom, value);
    }

    public string AwayUntil
    {
        get => _awayUntil;
        set => EditAway(ref _awayUntil, value);
    }

    /// <summary>Quiet minutes as typed (a whole number, 0 to 1440).</summary>
    public string AwayQuiet
    {
        get => _awayQuiet;
        set => EditAway(ref _awayQuiet, value);
    }

    public string AwayMessage
    {
        get => _awayMessage;
        set
        {
            if (EditAway(ref _awayMessage, value)) Raise(nameof(AwayPreview));
        }
    }

    /// <summary>The first problem with what is typed, or null. Live, so Save stays off until it is fixed.</summary>
    public string? AwayError => Away.Check(_awayFrom.Trim(), _awayUntil.Trim(), _awayMessage, _awayQuiet);

    /// <summary>What the typed message would send. The daemon's own preview shows only the saved one.</summary>
    public string AwayPreview => Away.Preview(_awayMessage, State?.Telegram.Me?.Name, State?.Footer ?? "");

    /// <summary>Sets one of the typed fields. The caller's name goes to Set, or the box bound to it would never hear of the change.</summary>
    bool EditAway(ref string field, string? value, [CallerMemberName] string? name = null)
    {
        if (!Set(ref field, value ?? "", name)) return false;
        Raise(nameof(AwayError));
        CommandManager.InvalidateRequerySuggested();
        return true;
    }

    /// <summary>Fills the fields from the daemon's saved state. Only when the page opens and after a save: polling leaves them alone.</summary>
    void LoadAway()
    {
        if (State?.Away is not { } a) return;
        _awayLoaded = true;
        _awaySaved = (a.Enabled, a.From, a.Until, a.Message, a.QuietMinutes);
        AwayEnabled = a.Enabled;
        AwayFrom = a.From;
        AwayUntil = a.Until;
        AwayMessage = a.Message;
        AwayQuiet = a.QuietMinutes.ToString(CultureInfo.InvariantCulture);
        Raise(nameof(AwayPreview));
    }

    /// <summary>
    /// On/Off saves at once, on its own: hours and message still wait for Save, so a half-typed
    /// time never goes out with it. Shows the new state straight away and puts it back if the daemon says no.
    /// </summary>
    async Task ToggleAwayAsync(bool on)
    {
        if (_awaySaving || _awaySaved is null || on == _awayEnabled) return;
        var before = _awayEnabled;
        AwayEnabled = on;
        ActionResult r;
        _awaySaving = true;
        CommandManager.InvalidateRequerySuggested();
        try
        {
            r = await _api.SaveAwayAsync(new AwayChange(Enabled: on));
        }
        finally
        {
            _awaySaving = false;
            CommandManager.InvalidateRequerySuggested();
        }
        // Read the baseline after the await: the page may have reloaded it meanwhile.
        if (r.Ok && _awaySaved is { } saved) _awaySaved = saved with { Enabled = on };
        else AwayEnabled = before;
        ShowFlash(r.Text, r.Ok);
        await PollAsync();
    }

    /// <summary>Sends only what differs from what was loaded or last saved. After a save the fields stay as typed (trimmed).</summary>
    async Task SaveAwayAsync()
    {
        if (_awaySaved is not { } saved || AwayError is not null) return;
        // What goes out, captured before the await: typing during the round trip must not
        // become the new baseline, or that edit would look already saved.
        var typedFrom = _awayFrom;
        var typedUntil = _awayUntil;
        var typedQuiet = _awayQuiet;
        // AwayError is null, so the quiet minutes parse.
        var sent = (Enabled: _awayEnabled, From: typedFrom.Trim(), Until: typedUntil.Trim(), Message: _awayMessage, Quiet: Away.Quiet(typedQuiet)!.Value);
        var change = new AwayChange(
            sent.Enabled != saved.Enabled ? sent.Enabled : null,
            sent.From != saved.From ? sent.From : null,
            sent.Until != saved.Until ? sent.Until : null,
            sent.Message != saved.Message ? sent.Message : null,
            sent.Quiet != saved.Quiet ? sent.Quiet : null);
        if (change == new AwayChange())
        {
            ShowFlash("Nothing changed.");
            return;
        }
        ActionResult r;
        _awaySaving = true;
        CommandManager.InvalidateRequerySuggested();
        try
        {
            r = await _api.SaveAwayAsync(change);
        }
        finally
        {
            _awaySaving = false;
            CommandManager.InvalidateRequerySuggested();
        }
        if (r.Ok)
        {
            _awaySaved = sent;
            // Show the trimmed times, but only in fields left alone since the save started.
            if (_awayFrom == typedFrom) AwayFrom = sent.From;
            if (_awayUntil == typedUntil) AwayUntil = sent.Until;
            if (_awayQuiet == typedQuiet) AwayQuiet = sent.Quiet.ToString(CultureInfo.InvariantCulture);
        }
        ShowFlash(r.Text, r.Ok);
        await PollAsync();
    }

    public string Search
    {
        get => _search;
        set
        {
            if (!Set(ref _search, value ?? "")) return;
            Raise(nameof(SearchEmpty));
            SyncContacts();
        }
    }

    public bool SearchEmpty => _search.Length == 0;

    /// <summary>One contact row is open at a time.</summary>
    public string? OpenNickname
    {
        get => _openNickname;
        set
        {
            if (!Set(ref _openNickname, value)) return;
            foreach (var c in _contacts.Values) c.OpenChanged();
        }
    }

    public string ContactsSummary => Contacts.Summary(State?.Contacts?.Count ?? 0);

    /// <summary>Instead of rows: no contacts yet, none matching, or a daemon without the Contacts page.</summary>
    public string? ContactsPlaceholder =>
        !ShowContent ? null
        : State!.Contacts is null ? Contacts.OlderDaemon
        : State.Contacts.Count == 0 ? Contacts.Empty
        : ContactRows.Count == 0 ? Contacts.NoMatch(_search)
        : null;

    public string? WaitingBanner => Reachable && State is { Approvals.Count: > 0 } s ? Format.Waiting(s.Approvals.Count) : null;

    public ICommand ShowContacts { get; }
    public ICommand ShowAway { get; }
    public ICommand SetAwayEnabled { get; }
    public ICommand SaveAway { get; }
    public ICommand ShowMain { get; }
    public ICommand ClearSearch { get; }
    public ICommand OpenRules { get; }
    public ICommand OpenLog { get; }
    public ICommand Quit { get; }

    /// <summary>A listened chat's pause / resume button (Home → Listening).</summary>
    public ICommand ToggleListening { get; }

    // ---- talking to the daemon ------------------------------------------------------------

    public async Task PollAsync()
    {
        if (_polling) return;
        _polling = true;
        try
        {
            var r = await _api.PollAsync();
            Reachable = r.Reachable;
            Problem = r.Problem;
            if (r.State is { } s) State = s;
            Refresh();
            Polled?.Invoke();
        }
        finally
        {
            _polling = false;
        }
    }

    public async Task DecideAsync(ApprovalVM approval, Decision decision)
    {
        approval.Busy = true;
        var r = await _api.DecideAsync(approval.Id, decision);
        approval.Busy = false;
        ShowFlash(r.Text, r.Ok);
        await PollAsync();
    }

    /// <summary>Ack or snooze a page from the alarm window or its notification.</summary>
    public async Task PageAsync(string id, bool ack, int minutes)
    {
        var r = await _api.PageAsync(id, ack, minutes);
        ShowFlash(r.Text, r.Ok);
        await PollAsync();
    }

    /// <summary>From a notification button, which may outlive its row.</summary>
    public async Task DecideAsync(string id, Decision decision)
    {
        if (_approvals.TryGetValue(id, out var vm)) await DecideAsync(vm, decision);
        else
        {
            var r = await _api.DecideAsync(id, decision);
            ShowFlash(r.Text, r.Ok);
            await PollAsync();
        }
    }

    public async Task EditContactAsync(ContactVM contact, ContactChange change)
    {
        contact.Busy = true;
        var r = await _api.EditContactAsync(change);
        contact.Busy = false;
        // After a rename the row has a new name: keep it open.
        if (r.Ok && r.Nickname is { } now && OpenNickname == contact.Nickname) OpenNickname = now;
        ShowFlash(r.Text, r.Ok);
        await PollAsync();
    }

    /// <summary>The Page button: "/page &lt;reason&gt;" to that person. The reason box clears once it went out.</summary>
    public async Task PageContactAsync(ContactVM contact)
    {
        contact.Paging = true;
        var r = await _api.PageContactAsync(contact.Nickname, contact.PageReason);
        contact.Paging = false;
        if (r.Ok) contact.PageReason = "";
        ShowFlash(r.Text, r.Ok);
        await PollAsync();
    }

    /// <summary>
    /// Pause or resume listening to a chat by flipping its auto-reply: the daemon only passes a chat's
    /// messages to sessions while it is on, and the sessions keep their watches either way.
    /// </summary>
    async Task ToggleListeningAsync(WatchVM watch)
    {
        if (watch.Nickname is null) return;
        var r = await _api.EditContactAsync(new ContactChange(watch.Nickname, AutoReply: watch.Paused));
        ShowFlash(r.Ok ? (watch.Paused ? $"Listening to {watch.ChatLabel} again." : $"Paused listening to {watch.ChatLabel}.") : r.Text, r.Ok);
        await PollAsync();
    }

    void ToggleRecent(RecentChatVM row)
    {
        row.IsOpen = !row.IsOpen;
        if (row.IsOpen) _openRecent.Add(row.ChatId);
        else _openRecent.Remove(row.ChatId);
    }

    public void ShowFlash(string text, bool ok = true)
    {
        FlashOk = ok;
        Flash = text;
        _flashTimer.Stop();
        _flashTimer.Start();
    }

    // ---- keeping the lists in step ------------------------------------------------------

    void Refresh()
    {
        var now = DateTimeOffset.Now;
        var s = ShowContent ? State : null;

        IReadOnlyList<UiApproval> approvals = s?.Approvals ?? [];
        foreach (var gone in _approvals.Keys.Except(approvals.Select(a => a.Id)).ToList()) _approvals.Remove(gone);
        var rows = approvals.Select(a => _approvals.TryGetValue(a.Id, out var vm) ? vm : _approvals[a.Id] = new ApprovalVM(this, a)).ToList();
        foreach (var vm in rows) vm.Ago = Format.Ago(vm.Item.CreatedAt, now);
        ListSync.Apply(Approvals, rows);

        // Sessions and recent sends have nothing editable: rebuild them when they change (or a minute passes, for "ago").
        IReadOnlyList<UiSession> sessions = s is null ? [] : Presenter.Listening(s);
        // Each chat's pause button follows its contact's auto-reply, so that is part of the key too.
        var switches = sessions.SelectMany(x => x.Watches).Select(w => Presenter.ListeningSwitch(s!, w.ChatId)).Select(c => c is null ? "-" : $"{c.Nickname}:{c.AutoReply}");
        if (Changed(ref _sessionsKey, JsonSerializer.Serialize(sessions) + string.Join(",", switches)))
        {
            ListSync.Apply(Listening, sessions.Select(x => SessionVM.From(x, s!, ToggleListening)).ToList());
        }
        IReadOnlyList<RecentChat> recent = s is null ? [] : Presenter.RecentChats(s.Recent);
        if (Changed(ref _recentKey, JsonSerializer.Serialize(recent) + now.ToString("yyyyMMddHHmm", System.Globalization.CultureInfo.InvariantCulture)))
        {
            _openRecent.IntersectWith(recent.Select(c => c.ChatId));
            ListSync.Apply(Recent, recent.Select(c => RecentChatVM.From(c, s!.Footer, now, _openRecent.Contains(c.ChatId), ToggleRecent)).ToList());
        }

        IReadOnlyList<UiContact> contacts = s?.Contacts ?? [];
        foreach (var gone in _contacts.Keys.Except(contacts.Select(c => c.Nickname)).ToList()) _contacts.Remove(gone);
        foreach (var c in contacts)
        {
            if (_contacts.TryGetValue(c.Nickname, out var vm)) vm.Update(c, s!.DefaultPolicy);
            else _contacts[c.Nickname] = new ContactVM(this, c, s!.DefaultPolicy);
        }
        SyncContacts();

// The page was opened before the daemon answered: fill the fields once it does.
        if (_awayPage && !_awayLoaded) LoadAway();

        IReadOnlyList<Stat> stats = s is null ? [] : Presenter.Stats(s);
        if (!stats.SequenceEqual(_stats))
        {
            _stats = stats;
            Raise(nameof(Stats));
        }

        foreach (var name in new[]
                 {
                     nameof(Header), nameof(ShowContent), nameof(ShownProblem), nameof(ConfigError), nameof(ApprovalCount),
                     nameof(NoApprovals), nameof(NoListening), nameof(NoRecent), nameof(ContactsSummary), nameof(WaitingBanner),
                     nameof(AwayShown), nameof(AwayPlaceholder), nameof(AwayStatus), nameof(AwayBadge), nameof(AwayError), nameof(AwayPreview),
                 })
        {
            Raise(name);
        }
    }

    void SyncContacts()
    {
        var shown = Contacts.Filter(State?.Contacts ?? [], _search);
        ListSync.Apply(ContactRows, shown.Where(c => _contacts.ContainsKey(c.Nickname)).Select(c => _contacts[c.Nickname]).ToList());
        Raise(nameof(ContactsPlaceholder));
    }

    static bool Changed(ref string key, string now)
    {
        if (key == now) return false;
        key = now;
        return true;
    }

    void OpenFile(string name)
    {
        var path = Path.Combine(_settings.Home, name);
        if (!File.Exists(path))
        {
            ShowFlash($"There is no {name} in {_settings.Home} yet.", ok: false);
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // No app is set to open .json or .log files.
            Process.Start(new ProcessStartInfo("notepad.exe") { ArgumentList = { path } });
        }
    }
}
