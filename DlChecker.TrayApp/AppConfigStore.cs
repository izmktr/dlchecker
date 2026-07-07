using System.Text.Json;

namespace DlChecker.TrayApp;

internal sealed class AppConfig
{
    public string MonitoredFolder { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        "Downloads");

    public int ApiPort { get; set; } = 48762;
}

internal static class AppConfigStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private static string ConfigDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "DlChecker");

    private static string ConfigPath => Path.Combine(ConfigDirectory, "config.json");

    public static AppConfig Load()
    {
        try
        {
            if (!File.Exists(ConfigPath))
            {
                var config = new AppConfig();
                Save(config);
                return config;
            }

            var json = File.ReadAllText(ConfigPath);
            var loaded = JsonSerializer.Deserialize<AppConfig>(json, JsonOptions);
            if (loaded is null)
            {
                return new AppConfig();
            }

            if (string.IsNullOrWhiteSpace(loaded.MonitoredFolder))
            {
                loaded.MonitoredFolder = new AppConfig().MonitoredFolder;
            }

            if (loaded.ApiPort is < 1 or > 65535)
            {
                loaded.ApiPort = 48762;
            }

            return loaded;
        }
        catch
        {
            return new AppConfig();
        }
    }

    public static void Save(AppConfig config)
    {
        Directory.CreateDirectory(ConfigDirectory);
        var json = JsonSerializer.Serialize(config, JsonOptions);
        File.WriteAllText(ConfigPath, json);
    }
}