using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
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
    bool _polling;

    UiState? _state;
    bool _reachable;
    string? _problem;
    string? _flash;
    bool _contactsPage;
    string _search = "";
    string? _openNickname;

    public PanelViewModel(DaemonApi api, Settings settings)
    {
        _api = api;
        _settings = settings;
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
        ClearSearch = new Command(_ => Search = "");
        OpenRules = new Command(_ => OpenFile("config.json"));
        OpenLog = new Command(_ => OpenFile("daemon.log"));
        Quit = new Command(_ => QuitRequested?.Invoke());
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

    public ObservableCollection<ApprovalVM> Approvals { get; } = [];
    public ObservableCollection<SessionVM> Listening { get; } = [];
    public ObservableCollection<RecentChatVM> Recent { get; } = [];
    public ObservableCollection<ContactVM> ContactRows { get; } = [];

    public string? ApprovalCount => Approvals.Count > 0 ? Approvals.Count.ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
    public bool NoApprovals => Approvals.Count == 0;
    public bool NoListening => Listening.Count == 0;
    public bool NoRecent => Recent.Count == 0;

    public string? Flash { get => _flash; private set => Set(ref _flash, value); }

    // ---- the Contacts page --------------------------------------------------------------

    public bool ContactsPage
    {
        get => _contactsPage;
        set
        {
            if (!Set(ref _contactsPage, value)) return;
            Raise(nameof(MainPage));
            if (!value) Search = "";
        }
    }

    public bool MainPage => !_contactsPage;

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
    public ICommand ShowMain { get; }
    public ICommand ClearSearch { get; }
    public ICommand OpenRules { get; }
    public ICommand OpenLog { get; }
    public ICommand Quit { get; }

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
        ShowFlash(r.Text);
        await PollAsync();
    }

    /// <summary>Ack or snooze a page from the alarm window or its notification.</summary>
    public async Task PageAsync(string id, bool ack, int minutes)
    {
        ShowFlash((await _api.PageAsync(id, ack, minutes)).Text);
        await PollAsync();
    }

    /// <summary>From a notification button, which may outlive its row.</summary>
    public async Task DecideAsync(string id, Decision decision)
    {
        if (_approvals.TryGetValue(id, out var vm)) await DecideAsync(vm, decision);
        else
        {
            ShowFlash((await _api.DecideAsync(id, decision)).Text);
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
        ShowFlash(r.Text);
        await PollAsync();
    }

    /// <summary>The Page button: "/page &lt;reason&gt;" to that person. The reason box clears once it went out.</summary>
    public async Task PageContactAsync(ContactVM contact)
    {
        contact.Paging = true;
        var r = await _api.PageContactAsync(contact.Nickname, contact.PageReason);
        contact.Paging = false;
        if (r.Ok) contact.PageReason = "";
        ShowFlash(r.Text);
        await PollAsync();
    }

    public void ShowFlash(string text)
    {
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
        if (Changed(ref _sessionsKey, JsonSerializer.Serialize(sessions)))
        {
            ListSync.Apply(Listening, sessions.Select(SessionVM.From).ToList());
        }
        IReadOnlyList<RecentChat> recent = s is null ? [] : Presenter.RecentChats(s.Recent);
        if (Changed(ref _recentKey, JsonSerializer.Serialize(recent) + now.ToString("yyyyMMddHHmm", System.Globalization.CultureInfo.InvariantCulture)))
        {
            ListSync.Apply(Recent, recent.Select(c => RecentChatVM.From(c, s!.Footer, now)).ToList());
        }

        IReadOnlyList<UiContact> contacts = s?.Contacts ?? [];
        foreach (var gone in _contacts.Keys.Except(contacts.Select(c => c.Nickname)).ToList()) _contacts.Remove(gone);
        foreach (var c in contacts)
        {
            if (_contacts.TryGetValue(c.Nickname, out var vm)) vm.Update(c, s!.DefaultPolicy);
            else _contacts[c.Nickname] = new ContactVM(this, c, s!.DefaultPolicy);
        }
        SyncContacts();

        foreach (var name in new[]
                 {
                     nameof(Header), nameof(ShowContent), nameof(ShownProblem), nameof(ConfigError), nameof(ApprovalCount),
                     nameof(NoApprovals), nameof(NoListening), nameof(NoRecent), nameof(ContactsSummary), nameof(WaitingBanner),
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
            ShowFlash($"There is no {name} in {_settings.Home} yet.");
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
