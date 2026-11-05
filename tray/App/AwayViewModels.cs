using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using TelegramMCPTray.Core;

namespace TelegramMCPTray;

/// <summary>A choice in a segmented row (a wait, a repeat): its label, and whether it's the one picked.</summary>
public sealed class ChoiceVM(string label, int value, string tip) : Observable
{
    bool _on;
    public string Label { get; } = label;
    public int Value { get; } = value;
    public string Tip { get; } = tip;
    public bool On { get => _on; set => Set(ref _on, value); }
}

/// <summary>A weekday chip on a schedule: M T W T F S S.</summary>
public sealed class DayChipVM(int day, ICommand toggle) : Observable
{
    bool _on;
    public int Day { get; } = day;
    public string Letter { get; } = Away.DayLetter(day);
    public string Name { get; } = Away.DayName(day);
    public bool On { get => _on; set => Set(ref _on, value); }
    public ICommand Toggle { get; } = toggle;
}

/// <summary>A starting point under "Add a schedule".</summary>
public sealed class TemplateVM(ScheduleTemplate t, ICommand pick)
{
    public string Label => t.Label;
    public string Tip => $"{t.From}–{t.Until}, {Away.DaysText(t.Days).ToLowerInvariant()}{(Away.DatesText(t.StartDate, t.EndDate) is { } d ? $", {d}" : "")}";
    public ScheduleTemplate Template => t;
    public ICommand Pick { get; } = pick;
}

/// <summary>
/// One away schedule on the Away tab: a row (colour, name, hours, days, its switch) that opens into an
/// editor. Edits stay here until Save; the switch and Delete save at once. A new schedule lives only
/// here until its first Save.
/// </summary>
public sealed class ScheduleVM : Observable
{
    /// <summary>The colours schedules are drawn in, by their place in the list.</summary>
    static readonly string[] Palette = ["Orange", "Blue", "Green", "Accent", "Yellow", "Red"];

    readonly PanelViewModel _panel;
    UiAwaySchedule? _saved;
    string _name = "", _from = "09:00", _until = "17:00", _message = "";
    readonly HashSet<int> _days = [];
    DateTime? _startDate, _endDate;
    bool _dated, _enabled = true, _open, _busy, _confirmDelete;
    int _delay, _repeat, _index;

    public ScheduleVM(PanelViewModel panel, UiAwaySchedule? saved, ScheduleTemplate? template, string id)
    {
        _panel = panel;
        Id = id;
        foreach (var d in Away.WeekOrder) Days.Add(new DayChipVM(d, new Command(_ => ToggleDay(d))));
        foreach (var s in Away.Delays) DelayChoices.Add(new ChoiceVM(Away.DelayChip(s), s, s == 0 ? "Reply as soon as a message comes in" : $"Wait {Away.DelayChip(s)}: if you read a chat or send something meanwhile, nothing goes out"));
        foreach (var m in Away.Repeats) RepeatChoices.Add(new ChoiceVM(Away.RepeatChip(m), m, Away.RepeatText(m)));

        Toggle = new Command(_ => IsOpen = !IsOpen);
        ToggleEnabled = new Command(_ => _ = _panel.SetScheduleEnabledAsync(this, !Enabled), _ => !_busy);
        SetDays = new Command(p => ApplyDays(p switch { "weekdays" => Away.Weekdays, "weekends" => Away.Weekends, _ => Away.AllDays }));
        SetDated = new Command(p => Dated = p is "dates");
        SetDelay = new Command(p => { if (p is ChoiceVM c) Delay = c.Value; });
        SetRepeat = new Command(p => { if (p is ChoiceVM c) Repeat = c.Value; });
        InsertName = new Command(_ => Message = Message.TrimEnd() + (Message.Length == 0 ? "" : " ") + "{name}");
        Save = new Command(_ => _ = _panel.SaveScheduleAsync(this), _ => !_busy && Error is null && (Dirty || IsNew));
        Discard = new Command(_ => DiscardEdits());
        Delete = new Command(_ =>
        {
            if (IsNew)
            {
                _panel.DropNewSchedule(this);
                return;
            }
            if (!ConfirmDelete)
            {
                ConfirmDelete = true;
                return;
            }
            _ = _panel.DeleteScheduleAsync(this);
        }, _ => !_busy);

        if (saved is not null) Update(saved, force: true);
        else if (template is not null) FromTemplate(template);
    }

    public string Id { get; }
    public bool IsNew => _saved is null;
    public UiAwaySchedule? Saved => _saved;

    // ---- the row ---------------------------------------------------------------------------

    /// <summary>Its place in the list, which picks its colour.</summary>
    public int Index
    {
        get => _index;
        set
        {
            if (Set(ref _index, value)) Raise(nameof(Color));
        }
    }

    public Brush Color => Application.Current.TryFindResource(Palette[_index % Palette.Length]) as Brush ?? Brushes.Orange;
    public string Icon => Away.IsNight(_saved?.From ?? _from, _saved?.Until ?? _until) ? "moon" : "sun";
    public string Title => IsNew ? (_name.Trim() == "" ? "New schedule" : _name.Trim()) : _saved!.Name;

    /// <summary>"08:00 – 21:00 · Every day · waits 30 s" from what is saved (a new one: as typed).</summary>
    public string Summary
    {
        get
        {
            var s = _saved;
            var times = $"{s?.From ?? _from} – {s?.Until ?? _until}";
            var days = Away.DaysText(s?.Days ?? _days.ToList());
            var dates = Away.DatesText(Away.ParseDate(s?.StartDate) ?? DateOnly(_startDate, s is null), Away.ParseDate(s?.EndDate) ?? DateOnly(_endDate, s is null));
            var wait = Away.DelayText(s?.DelaySeconds ?? _delay);
            return dates is null ? $"{times} · {days} · {wait}" : $"{times} · {days} · {dates} · {wait}";
        }
    }

    static DateOnly? DateOnly(DateTime? d, bool use) => use && d is { } x ? System.DateOnly.FromDateTime(x) : null;

    /// <summary>Replying right now.</summary>
    public bool Active => _saved?.Active == true && _panel.AwayOnNow;
    public bool Enabled => _saved?.Enabled ?? _enabled;
    public string EnabledName => $"{Title} on or off";
    public string EnabledTip => Enabled ? $"Switch {Title} off (saves at once)" : $"Switch {Title} on (saves at once)";

    public bool IsOpen
    {
        get => _open;
        set
        {
            if (!Set(ref _open, value)) return;
            Raise(nameof(Chevron));
            if (!value) ConfirmDelete = false;
        }
    }

    public string Chevron => _open ? "chevron-up" : "chevron-down";

    public bool Busy
    {
        get => _busy;
        set
        {
            if (!Set(ref _busy, value)) return;
            Raise(nameof(Idle));
            CommandManager.InvalidateRequerySuggested();
        }
    }

    public bool Idle => !_busy;

    // ---- the editor ------------------------------------------------------------------------

    public string Name { get => _name; set => Edit(ref _name, value ?? ""); }
    public string From { get => _from; set => Edit(ref _from, value ?? ""); }
    public string Until { get => _until; set => Edit(ref _until, value ?? ""); }

    public string Message
    {
        get => _message;
        set
        {
            if (Edit(ref _message, value ?? "")) Raise(nameof(Preview));
        }
    }

    public ObservableCollection<DayChipVM> Days { get; } = [];
    public ObservableCollection<ChoiceVM> DelayChoices { get; } = [];
    public ObservableCollection<ChoiceVM> RepeatChoices { get; } = [];

    /// <summary>Every quarter hour (and the saved time when it's between them), for the two pickers.</summary>
    public IReadOnlyList<string> FromOptions => Away.TimeOptions(_from);
    public IReadOnlyList<string> UntilOptions => Away.TimeOptions(_until);

    /// <summary>"Runs past midnight, until 08:00 the next day." when it does.</summary>
    public string? Overnight => Away.IsTime(_from) && Away.IsTime(_until) && string.CompareOrdinal(_from, _until) > 0
        ? $"Runs past midnight, until {_until} the next morning. It counts as the day it starts."
        : null;

    /// <summary>Only between two dates (else every week).</summary>
    public bool Dated
    {
        get => _dated;
        set
        {
            if (!Set(ref _dated, value)) return;
            if (value && _startDate is null)
            {
                _startDate = DateTime.Today;
                _endDate = DateTime.Today.AddDays(6);
                Raise(nameof(StartDate));
                Raise(nameof(EndDate));
            }
            Raise(nameof(Weekly));
            Changed();
        }
    }

    public bool Weekly => !_dated;

    public DateTime? StartDate
    {
        get => _startDate;
        set
        {
            if (Set(ref _startDate, value)) Changed();
        }
    }

    public DateTime? EndDate
    {
        get => _endDate;
        set
        {
            if (Set(ref _endDate, value)) Changed();
        }
    }

    public int Delay
    {
        get => _delay;
        set
        {
            if (!Set(ref _delay, value)) return;
            foreach (var c in DelayChoices) c.On = c.Value == value;
            Raise(nameof(DelayHint));
            Changed();
        }
    }

    public string DelayHint => _delay == 0
        ? "The reply goes out as soon as a message comes in."
        : $"Waits {Away.DelayChip(_delay)} first. If you read any chat or send a message on Telegram meanwhile, on any device, nothing goes out.";

    public int Repeat
    {
        get => _repeat;
        set
        {
            if (!Set(ref _repeat, value)) return;
            foreach (var c in RepeatChoices) c.On = c.Value == value;
            Raise(nameof(RepeatHint));
            Changed();
        }
    }

    public string RepeatHint => Away.RepeatText(_repeat);

    public string Counter => $"{_message.Length} / {Away.MessageMax}";

    /// <summary>What it would send, footer included.</summary>
    public string Preview => Away.Preview(_message, _panel.State?.Telegram.Me?.Name, _panel.State?.Footer ?? "");

    public string? Error => Away.CheckSchedule(_name, _from, _until, _days, _dated ? DateOnly(_startDate, true) : null, _dated ? DateOnly(_endDate, true) : null, _message);

    /// <summary>Something typed differs from what is saved.</summary>
    public bool Dirty
    {
        get
        {
            if (_saved is null) return true;
            var typed = Data();
            var saved = _saved.ToData();
            // Records compare lists by reference: compare the days apart.
            return !typed.Days.SequenceEqual(saved.Days) || typed with { Days = saved.Days } != saved;
        }
    }

    public string SaveLabel => IsNew ? "Add schedule" : "Save";

    /// <summary>Delete asks once: the button turns into "Delete for good?".</summary>
    public bool ConfirmDelete
    {
        get => _confirmDelete;
        set
        {
            if (Set(ref _confirmDelete, value)) Raise(nameof(DeleteLabel));
        }
    }

    public string DeleteLabel => IsNew ? "Cancel" : _confirmDelete ? "Delete for good?" : "Delete";

    public ICommand Toggle { get; }
    public ICommand ToggleEnabled { get; }
    public ICommand SetDays { get; }
    public ICommand SetDated { get; }
    public ICommand SetDelay { get; }
    public ICommand SetRepeat { get; }
    public ICommand InsertName { get; }
    public ICommand Save { get; }
    public ICommand Discard { get; }
    public ICommand Delete { get; }

    /// <summary>What Save sends: the fields as typed (name trimmed), on or off as saved.</summary>
    public ScheduleData Data() => new(
        Id, _name.Trim(), Enabled, _from, _until, Away.AllDays.Where(_days.Contains).ToList(),
        _dated ? Away.FormatDate(DateOnly(_startDate, true)) : null, _dated ? Away.FormatDate(DateOnly(_endDate, true)) : null,
        _delay, _repeat, _message);

    void ToggleDay(int day)
    {
        if (!_days.Remove(day)) _days.Add(day);
        SyncDays();
        Changed();
    }

    void ApplyDays(IEnumerable<int> days)
    {
        _days.Clear();
        _days.UnionWith(days);
        SyncDays();
        Changed();
    }

    void SyncDays()
    {
        foreach (var c in Days) c.On = _days.Contains(c.Day);
    }

    bool Edit(ref string field, string value, [System.Runtime.CompilerServices.CallerMemberName] string? name = null)
    {
        if (!Set(ref field, value, name)) return false;
        Changed();
        return true;
    }

    /// <summary>After any edit: the derived words, the error and Save follow.</summary>
    void Changed()
    {
        foreach (var n in new[] { nameof(Error), nameof(Dirty), nameof(Counter), nameof(Overnight), nameof(Preview) }) Raise(n);
        if (IsNew)
        {
            Raise(nameof(Title));
            Raise(nameof(Summary));
            Raise(nameof(Icon));
        }
        CommandManager.InvalidateRequerySuggested();
    }

    void FromTemplate(ScheduleTemplate t)
    {
        _name = t.Name;
        _from = t.From;
        _until = t.Until;
        _message = t.Message;
        _days.Clear();
        _days.UnionWith(t.Days);
        _dated = t.StartDate is not null || t.EndDate is not null;
        _startDate = t.StartDate?.ToDateTime(TimeOnly.MinValue);
        _endDate = t.EndDate?.ToDateTime(TimeOnly.MinValue);
        _delay = t.DelaySeconds;
        _repeat = t.RepeatMinutes;
        RaiseAll();
    }

    /// <summary>
    /// A poll brought the saved schedule. The fields follow it unless something is typed and not saved
    /// (or `force`: after a save, or when the row is first made).
    /// </summary>
    public void Update(UiAwaySchedule s, bool force = false)
    {
        var typing = !force && _saved is not null && Dirty;
        _saved = s;
        if (!typing)
        {
            _name = s.Name;
            _from = s.From;
            _until = s.Until;
            _message = s.Message;
            _days.Clear();
            _days.UnionWith(s.Days);
            _startDate = Away.ParseDate(s.StartDate)?.ToDateTime(TimeOnly.MinValue);
            _endDate = Away.ParseDate(s.EndDate)?.ToDateTime(TimeOnly.MinValue);
            _dated = _startDate is not null || _endDate is not null;
            _delay = s.DelaySeconds;
            _repeat = s.RepeatMinutes;
        }
        _enabled = s.Enabled;
        RaiseAll();
    }

    void DiscardEdits()
    {
        if (_saved is { } s) Update(s, force: true);
        IsOpen = false;
    }

    public void RaiseAll()
    {
        SyncDays();
        foreach (var c in DelayChoices) c.On = c.Value == _delay;
        foreach (var c in RepeatChoices) c.On = c.Value == _repeat;
        foreach (var n in new[]
                 {
                     nameof(Name), nameof(From), nameof(Until), nameof(Message), nameof(Dated), nameof(Weekly), nameof(StartDate), nameof(EndDate),
                     nameof(Delay), nameof(Repeat), nameof(DelayHint), nameof(RepeatHint), nameof(Counter), nameof(Preview), nameof(Error), nameof(Dirty),
                     nameof(Title), nameof(Summary), nameof(Icon), nameof(Active), nameof(Enabled), nameof(EnabledName), nameof(EnabledTip),
                     nameof(FromOptions), nameof(UntilOptions), nameof(Overnight), nameof(SaveLabel), nameof(DeleteLabel), nameof(IsNew),
                 })
        {
            Raise(n);
        }
        CommandManager.InvalidateRequerySuggested();
    }

    /// <summary>The footer or your name changed: the preview follows.</summary>
    public void RefreshPreview()
    {
        Raise(nameof(Preview));
        Raise(nameof(Active));
    }
}
