using System.Collections.Concurrent;
using System.Text;

namespace DlChecker.TrayApp;

internal sealed class FileIndexService : IDisposable
{
    private readonly ConcurrentDictionary<string, IndexedFile> _files = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _sync = new();
    private readonly List<FileSystemWatcher> _watchers = new();
    private List<LinkMapping> _linkMappings = new();

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
        foreach (var path in EnumerateFilesSkippingReparse(root))
        {
            var canonicalPath = CanonicalizePath(path);
            latest[canonicalPath] = BuildFile(canonicalPath);
        }

        foreach (var mapping in _linkMappings)
        {
            if (!Directory.Exists(mapping.TargetRoot))
            {
                continue;
            }

            foreach (var path in Directory.EnumerateFiles(mapping.TargetRoot, "*", SearchOption.AllDirectories))
            {
                var canonicalPath = CanonicalizePath(path);
                latest[canonicalPath] = BuildFile(canonicalPath);
            }
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

    private const int MinMatchScore = 70;

    public IReadOnlyList<MatchResult> Match(string query, int topN)
    {
        var normalizedQuery = Normalize(query);
        if (string.IsNullOrWhiteSpace(normalizedQuery))
        {
            return Array.Empty<MatchResult>();
        }

        topN = Math.Clamp(topN, 1, 20);

        return _files.Values
            .Select(file =>
            {
                var matchCount = LongestCommonSubsequenceLength(normalizedQuery, file.NormalizedName);
                return new MatchResult(
                    file.FileName,
                    file.FullPath,
                    matchCount,
                    ComputeScore(matchCount, file.NormalizedName.Length));
            })
            .Where(x => x.Score >= MinMatchScore)
            .OrderByDescending(x => x.FileName.Length)
            .ThenByDescending(x => x.Score)
            .ThenBy(x => x.FileName, StringComparer.OrdinalIgnoreCase)
            .Take(topN)
            .ToList();
    }

    public void Dispose()
    {
        DisposeWatchers();
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
        DisposeWatchers();

        var watchInfo = BuildWatchInfo(root);
        _linkMappings = watchInfo.LinkMappings;

        foreach (var watchRoot in watchInfo.WatchRoots)
        {
            CreateWatcher(watchRoot);
        }
    }

    private void CreateWatcher(string root)
    {
        Directory.CreateDirectory(root);

        var watcher = new FileSystemWatcher(root)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.CreationTime
        };

        watcher.Created += (_, e) => OnCreated(e.FullPath);
        watcher.Renamed += (_, e) => OnRenamed(e.OldFullPath, e.FullPath);
        watcher.Deleted += (_, e) => OnDeleted(e.FullPath);
        watcher.EnableRaisingEvents = true;
        _watchers.Add(watcher);
    }

    private void DisposeWatchers()
    {
        foreach (var watcher in _watchers)
        {
            watcher.Dispose();
        }

        _watchers.Clear();
    }

    private static WatchInfo BuildWatchInfo(string root)
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            Path.GetFullPath(root)
        };
        var mappings = new List<LinkMapping>();

        if (!Directory.Exists(root))
        {
            return new WatchInfo(roots.ToList(), mappings);
        }

        foreach (var directory in Directory.EnumerateDirectories(root, "*", SearchOption.AllDirectories))
        {
            if (!TryResolveLinkTarget(directory, out var resolvedTarget))
            {
                continue;
            }

            var linkRoot = Path.GetFullPath(directory);
            var targetRoot = Path.GetFullPath(resolvedTarget);
            mappings.Add(new LinkMapping(linkRoot, targetRoot));
            roots.Add(targetRoot);
        }

        // Longer link roots should be matched first when canonicalizing.
        mappings = mappings
            .OrderByDescending(x => x.LinkRoot.Length)
            .ToList();

        return new WatchInfo(roots.ToList(), mappings);
    }

    private static bool TryResolveLinkTarget(string path, out string resolvedTarget)
    {
        resolvedTarget = string.Empty;

        try
        {
            var info = new DirectoryInfo(path);
            if ((info.Attributes & FileAttributes.ReparsePoint) == 0)
            {
                return false;
            }

            var target = info.ResolveLinkTarget(true);
            if (target is null || !target.Exists)
            {
                return false;
            }

            resolvedTarget = Path.GetFullPath(target.FullName);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private IEnumerable<string> EnumerateFilesSkippingReparse(string root)
    {
        var stack = new Stack<string>();
        stack.Push(root);

        while (stack.Count > 0)
        {
            var current = stack.Pop();

            IEnumerable<string> files;
            try
            {
                files = Directory.EnumerateFiles(current, "*", SearchOption.TopDirectoryOnly);
            }
            catch
            {
                continue;
            }

            foreach (var file in files)
            {
                yield return file;
            }

            IEnumerable<string> dirs;
            try
            {
                dirs = Directory.EnumerateDirectories(current, "*", SearchOption.TopDirectoryOnly);
            }
            catch
            {
                continue;
            }

            foreach (var dir in dirs)
            {
                if (IsReparseDirectory(dir))
                {
                    continue;
                }

                stack.Push(dir);
            }
        }
    }

    private static bool IsReparseDirectory(string path)
    {
        try
        {
            var attr = File.GetAttributes(path);
            return (attr & FileAttributes.ReparsePoint) != 0;
        }
        catch
        {
            return false;
        }
    }

    private string CanonicalizePath(string path)
    {
        var fullPath = Path.GetFullPath(path);
        foreach (var mapping in _linkMappings)
        {
            if (!fullPath.StartsWith(mapping.LinkRoot, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var nextCharIndex = mapping.LinkRoot.Length;
            if (fullPath.Length > nextCharIndex)
            {
                var separator = fullPath[nextCharIndex];
                if (separator != Path.DirectorySeparatorChar && separator != Path.AltDirectorySeparatorChar)
                {
                    continue;
                }
            }

            var suffix = fullPath.Length == mapping.LinkRoot.Length
                ? string.Empty
                : fullPath[mapping.LinkRoot.Length..];
            return Path.GetFullPath($"{mapping.TargetRoot}{suffix}");
        }

        return fullPath;
    }

    private void OnCreated(string path)
    {
        var canonicalPath = CanonicalizePath(path);
        if (Directory.Exists(canonicalPath) || !File.Exists(canonicalPath))
        {
            return;
        }

        _files[canonicalPath] = BuildFile(canonicalPath);
    }

    private void OnRenamed(string oldPath, string newPath)
    {
        var oldCanonicalPath = CanonicalizePath(oldPath);
        var newCanonicalPath = CanonicalizePath(newPath);

        _files.TryRemove(oldCanonicalPath, out _);
        if (File.Exists(newCanonicalPath))
        {
            _files[newCanonicalPath] = BuildFile(newCanonicalPath);
        }
    }

    private void OnDeleted(string path)
    {
        var canonicalPath = CanonicalizePath(path);
        _files.TryRemove(canonicalPath, out _);
    }

    private static IndexedFile BuildFile(string path)
    {
        var fileName = Path.GetFileName(path);
        return new IndexedFile(fileName, path, Normalize(fileName));
    }

    private static int ComputeScore(int matchCount, int denominator)
    {
        if (denominator == 0)
        {
            return 0;
        }

        var ratio = (double)matchCount / denominator;
        var score = (int)Math.Round(ratio * 100, MidpointRounding.AwayFromZero);
        return Math.Clamp(score, 0, 100);
    }

    private static int LongestCommonSubsequenceLength(string a, string b)
    {
        if (a.Length == 0 || b.Length == 0)
        {
            return 0;
        }

        var previous = new int[b.Length + 1];
        var current = new int[b.Length + 1];

        for (var i = 1; i <= a.Length; i++)
        {
            for (var j = 1; j <= b.Length; j++)
            {
                if (a[i - 1] == b[j - 1])
                {
                    current[j] = previous[j - 1] + 1;
                }
                else
                {
                    current[j] = Math.Max(current[j - 1], previous[j]);
                }
            }

            (previous, current) = (current, previous);
            Array.Clear(current, 0, current.Length);
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

internal sealed record MatchResult(string FileName, string FullPath, int MatchCount, int Score);

internal sealed record LinkMapping(string LinkRoot, string TargetRoot);

internal sealed record WatchInfo(IReadOnlyList<string> WatchRoots, List<LinkMapping> LinkMappings);