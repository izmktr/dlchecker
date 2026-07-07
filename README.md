# dlchecker

ページの URL/タイトルからダウンロード済みファイルを照合するツールです。

- Windows タスクトレイ常駐アプリ
- Chrome 拡張

## 構成

- `DlChecker.TrayApp`: フォルダ監視 + 一致度検索 API
- `ChromeExtension`: ページ読込完了時にローカル API へメタデータ送信

## タスクトレイ常駐アプリ

### 機能

- 起動時に監視フォルダ配下を全スキャン
- `FileSystemWatcher` で新規/削除/リネームを反映
- ローカル HTTP API を公開
	- `GET /health`
	- `POST /match` (クエリ文字列で照合)
	- `POST /ingest` (URL/タイトルを受けて照合)

### 実行

```powershell
dotnet build .\DlChecker.sln
dotnet run --project .\DlChecker.TrayApp\DlChecker.TrayApp.csproj
```

### Release ビルド

```powershell
dotnet build .\DlChecker.sln -c Release
```

### 配布用 Publish

自己完結版 (配布先に .NET ランタイム不要、単一 exe):

```powershell
dotnet publish .\DlChecker.TrayApp\DlChecker.TrayApp.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true
```

ランタイム依存版 (配布先に .NET 8 ランタイムが必要):

```powershell
dotnet publish .\DlChecker.TrayApp\DlChecker.TrayApp.csproj -c Release -r win-x64 --self-contained false
```

Publish 出力先:

- `.\DlChecker.TrayApp\bin\Release\net8.0-windows\win-x64\publish\`

注意:

- 常駐アプリ起動中は exe がロックされる場合があるため、Publish 前にタスクトレイから終了してください。

デフォルト設定:

- 監視フォルダ: `%USERPROFILE%\Downloads`
- API: `http://127.0.0.1:48762`

設定ファイルは `%APPDATA%\DlChecker\config.json` に保存されます。

## Chrome 拡張

### 読み込み方法

1. Chrome で `chrome://extensions` を開く
2. 「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」から `ChromeExtension` フォルダを選択

### 動作

- タブの読み込み完了時、`url` と `title` を抽出して `POST /ingest` へ送信
- 送信先 URL は拡張のオプション画面で変更可能
- ポップアップの「現在タブで照合」を押すと、その時点のタブ情報で `POST /ingest` を実行し、結果をポップアップに表示
- 自動チェックが実行済みのタブでは、ポップアップを開いた時点で最新の自動チェック結果を表示
- オプション画面で「自動照合対象 URL 一覧」を改行区切りで設定可能
- オプション画面で一致しきい値を設定可能 (0-100)
- 自動照合対象に一致したページのみ判定し、最大スコアがしきい値以上なら拡張アイコンに赤い `!`、未満なら緑の `✓` を表示
- 緑の `✓` が表示されているタブは、ダウンロード完了イベントで再照合され、しきい値を超えた時点で赤い `!` に切り替え
- 自動照合対象 URL に一致しないページではアイコン表示は変更しない

## API 例

```powershell
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:48762/health"

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:48762/match" -ContentType "application/json" -Body '{"query":"sample file","topN":5}'

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:48762/ingest" -ContentType "application/json" -Body '{"url":"https://example.com/file.zip","title":"file.zip"}'
```