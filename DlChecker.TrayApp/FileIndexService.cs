using System.Collections.Concurrent;
using System.Text;

namespace DlChecker.TrayApp;

internal sealed class FileIndexService : IDisposable
{
    private readonly ConcurrentDictionary<string, IndexedFile> _files = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _sync = new();
    private FileSystemWatcher? _watcher;

    public FileIndexService(string rootFolder)
    {
        MonitoredFolder = EnsureFolder(rootFolder);
        SetupWatcher(MonitoredFolder);
    }

    public string MonitoredFolder { get; private set; }

    public int FileCount => _files.Count;

    public void InitialScan()
    {
        var root = MonitoredFolder;
        if (!Directory.Exists(root))
        {
            Directory.CreateDirectory(root);
        }

        var latest = new Dictionary<string, IndexedFile>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            latest[path] = BuildFile(path);
        }

        _files.Clear();
        foreach (var pair in latest)
        {
            _files[pair.Key] = pair.Value;
        }
    }

    public void ChangeRootFolder(string newRoot)
    {
        lock (_sync)
        {
            MonitoredFolder = EnsureFolder(newRoot);
            SetupWatcher(MonitoredFolder);
            InitialScan();
        }
    }

    public IReadOnlyList<MatchResult> Match(string query, int topN)
    {
        var normalizedQuery = Normalize(query);
        if (string.IsNullOrWhiteSpace(normalizedQuery))
        {
            return Array.Empty<MatchResult>();
        }

        topN = Math.Clamp(topN, 1, 20);

        return _files.Values
            .Select(file => new MatchResult(
                file.FileName,
                file.FullPath,
                ComputeScore(normalizedQuery, file.NormalizedName)))
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.FileName, StringComparer.OrdinalIgnoreCase)
            .Take(topN)
            .ToList();
    }

    public void Dispose()
    {
        _watcher?.Dispose();
    }

    private static string EnsureFolder(string rootFolder)
    {
        if (string.IsNullOrWhiteSpace(rootFolder))
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Downloads");
        }

        return Path.GetFullPath(rootFolder);
    }

    private void SetupWatcher(string root)
    {
        _watcher?.Dispose();
        Directory.CreateDirectory(root);

        _watcher = new FileSystemWatcher(root)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.CreationTime
        };

        _watcher.Created += (_, e) => OnCreated(e.FullPath);
        _watcher.Renamed += (_, e) => OnRenamed(e.OldFullPath, e.FullPath);
        _watcher.Deleted += (_, e) => OnDeleted(e.FullPath);
        _watcher.EnableRaisingEvents = true;
    }

    private void OnCreated(string path)
    {
        if (Directory.Exists(path) || !File.Exists(path))
        {
            return;
        }

        _files[path] = BuildFile(path);
    }

    private void OnRenamed(string oldPath, string newPath)
    {
        _files.TryRemove(oldPath, out _);
        if (File.Exists(newPath))
        {
            _files[newPath] = BuildFile(newPath);
        }
    }

    private void OnDeleted(string path)
    {
        _files.TryRemove(path, out _);
    }

    private static IndexedFile BuildFile(string path)
    {
        var fileName = Path.GetFileName(path);
        return new IndexedFile(fileName, path, Normalize(fileName));
    }

    private static int ComputeScore(string normalizedQuery, string normalizedFileName)
    {
        if (normalizedQuery == normalizedFileName)
        {
            return 100;
        }

        if (normalizedFileName.Contains(normalizedQuery, StringComparison.Ordinal))
        {
            return 95;
        }

        var distance = Levenshtein(normalizedQuery, normalizedFileName);
        var maxLen = Math.Max(normalizedQuery.Length, normalizedFileName.Length);
        if (maxLen == 0)
        {
            return 0;
        }

        var similarity = 1.0 - ((double)distance / maxLen);
        var score = (int)Math.Round(similarity * 100, MidpointRounding.AwayFromZero);
        return Math.Clamp(score, 0, 100);
    }

    private static int Levenshtein(string a, string b)
    {
        if (a.Length == 0)
        {
            return b.Length;
        }

        if (b.Length == 0)
        {
            return a.Length;
        }

        var previous = new int[b.Length + 1];
        var current = new int[b.Length + 1];

        for (var j = 0; j <= b.Length; j++)
        {
            previous[j] = j;
        }

        for (var i = 1; i <= a.Length; i++)
        {
            current[0] = i;
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                current[j] = Math.Min(
                    Math.Min(current[j - 1] + 1, previous[j] + 1),
                    previous[j - 1] + cost);
            }

            (previous, current) = (current, previous);
        }

        return previous[b.Length];
    }

    private static string Normalize(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return string.Empty;
        }

        var withoutExtension = Path.GetFileNameWithoutExtension(input);
        var sb = new StringBuilder(withoutExtension.Length);
        foreach (var ch in withoutExtension.ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(ch))
            {
                sb.Append(ch);
            }
        }

        return sb.ToString();
    }
}

internal sealed record IndexedFile(string FileName, string FullPath, string NormalizedName);

internal sealed record MatchResult(string FileName, string FullPath, int Score);