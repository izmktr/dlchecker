using System.Text;

namespace DlChecker.TrayApp;

internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly NotifyIcon _notifyIcon;
    private readonly FileIndexService _fileIndexService;
    private readonly DlCheckerApiServer _apiServer;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _folderItem;

    public TrayApplicationContext()
    {
        var config = AppConfigStore.Load();
        _fileIndexService = new FileIndexService(config.MonitoredFolder);
        _fileIndexService.InitialScan();

        _apiServer = new DlCheckerApiServer(_fileIndexService, config.ApiPort);
        _apiServer.Start();

        _statusItem = new ToolStripMenuItem();
        _folderItem = new ToolStripMenuItem();

        var scanNowItem = new ToolStripMenuItem("今すぐ再スキャン", null, (_, _) => ForceScan());
        var chooseFolderItem = new ToolStripMenuItem("監視フォルダを変更", null, (_, _) => ChooseFolder());
        var openFolderItem = new ToolStripMenuItem("監視フォルダを開く", null, (_, _) => OpenFolder());
        var exitItem = new ToolStripMenuItem("終了", null, (_, _) => ExitThread());

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(_folderItem);
        menu.Items.Add(scanNowItem);
        menu.Items.Add(chooseFolderItem);
        menu.Items.Add(openFolderItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        _notifyIcon = new NotifyIcon
        {
            Text = "DlChecker",
            Icon = SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = true
        };

        _notifyIcon.DoubleClick += (_, _) => ShowStatusBalloon();
        UpdateMenuText();
        ShowStatusBalloon();
    }

    protected override void ExitThreadCore()
    {
        _apiServer.Dispose();
        _fileIndexService.Dispose();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        base.ExitThreadCore();
    }

    private void ForceScan()
    {
        _fileIndexService.InitialScan();
        UpdateMenuText();
        _notifyIcon.ShowBalloonTip(1500, "DlChecker", "再スキャンを実行しました", ToolTipIcon.Info);
    }

    private void ChooseFolder()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "監視したいフォルダを選択してください",
            InitialDirectory = _fileIndexService.MonitoredFolder,
            UseDescriptionForTitle = true
        };

        if (dialog.ShowDialog() != DialogResult.OK)
        {
            return;
        }

        _fileIndexService.ChangeRootFolder(dialog.SelectedPath);
        AppConfigStore.Save(new AppConfig
        {
            MonitoredFolder = dialog.SelectedPath,
            ApiPort = _apiServer.Port
        });

        UpdateMenuText();
        _notifyIcon.ShowBalloonTip(1500, "DlChecker", "監視フォルダを更新しました", ToolTipIcon.Info);
    }

    private void OpenFolder()
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = _fileIndexService.MonitoredFolder,
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            _notifyIcon.ShowBalloonTip(1500, "DlChecker", ex.Message, ToolTipIcon.Error);
        }
    }

    private void UpdateMenuText()
    {
        _statusItem.Text = $"監視ファイル数: {_fileIndexService.FileCount}";
        _statusItem.Enabled = false;
        _folderItem.Text = $"監視先: {_fileIndexService.MonitoredFolder}";
        _folderItem.Enabled = false;
    }

    private void ShowStatusBalloon()
    {
        var message = new StringBuilder();
        message.AppendLine($"監視ファイル数: {_fileIndexService.FileCount}");
        message.Append($"API: http://127.0.0.1:{_apiServer.Port}");
        _notifyIcon.ShowBalloonTip(2000, "DlChecker 起動中", message.ToString(), ToolTipIcon.Info);
    }
}