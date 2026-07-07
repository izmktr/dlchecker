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

## API 例

```powershell
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:48762/health"

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:48762/match" -ContentType "application/json" -Body '{"query":"sample file","topN":5}'

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:48762/ingest" -ContentType "application/json" -Body '{"url":"https://example.com/file.zip","title":"file.zip"}'
```