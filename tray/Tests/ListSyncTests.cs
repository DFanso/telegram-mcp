using System.Collections.ObjectModel;
using System.Collections.Specialized;
using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>
/// The panel's lists are updated in place every poll, so a row keeps its state (a nickname being
/// typed, an open contact) and the list only changes where the daemon's data did.
/// </summary>
public class ListSyncTests
{
    sealed class Row(string key) { public string Key { get; } = key; }

    static ObservableCollection<Row> Rows(params string[] keys) => new(keys.Select(k => new Row(k)));

    [Fact]
    public void Ends_with_the_desired_items_in_order()
    {
        var target = Rows("a", "b", "c");
        var d = new Row("d");
        Row[] desired = [target[2], d, target[0]];

        ListSync.Apply(target, desired);

        Assert.Equal(desired, target);
    }

    [Fact]
    public void Keeps_the_same_instances()
    {
        var target = Rows("a", "b");
        var b = target[1];

        ListSync.Apply(target, [b]);

        Assert.Same(b, Assert.Single(target));
    }

    [Fact]
    public void An_unchanged_list_raises_no_change()
    {
        var target = Rows("a", "b");
        var changes = 0;
        target.CollectionChanged += (_, _) => changes++;

        ListSync.Apply(target, [.. target]);

        Assert.Equal(0, changes);
    }

    [Fact]
    public void One_new_item_is_one_insert()
    {
        var target = Rows("a", "b");
        var events = new List<NotifyCollectionChangedAction>();
        target.CollectionChanged += (_, e) => events.Add(e.Action);

        ListSync.Apply(target, [target[0], new Row("x"), target[1]]);

        Assert.Equal([NotifyCollectionChangedAction.Add], events);
    }
}
