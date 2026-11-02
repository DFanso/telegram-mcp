using System.Collections.ObjectModel;

namespace TelegramMCPTray.Core;

public static class ListSync
{
    /// <summary>
    /// Makes <paramref name="target"/> hold exactly <paramref name="desired"/> (by reference), in
    /// order, with as few changes as it takes. Items that stay keep their place in the UI.
    /// </summary>
    public static void Apply<T>(IList<T> target, IReadOnlyList<T> desired) where T : class
    {
        var keep = new HashSet<T>(desired, ReferenceEqualityComparer.Instance);
        for (var i = target.Count - 1; i >= 0; i--)
        {
            if (!keep.Contains(target[i])) target.RemoveAt(i);
        }
        for (var i = 0; i < desired.Count; i++)
        {
            if (i < target.Count && ReferenceEquals(target[i], desired[i])) continue;
            var at = -1;
            for (var j = i + 1; j < target.Count; j++)
            {
                if (ReferenceEquals(target[j], desired[i])) { at = j; break; }
            }
            if (at < 0) target.Insert(i, desired[i]);
            else if (target is ObservableCollection<T> list) list.Move(at, i);
            else
            {
                target.RemoveAt(at);
                target.Insert(i, desired[i]);
            }
        }
    }
}
