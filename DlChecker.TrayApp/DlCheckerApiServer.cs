using System.Net;
using System.Text;
using System.Text.Json;

namespace DlChecker.TrayApp;

internal sealed class DlCheckerApiServer : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    private readonly FileIndexService _fileIndexService;
    private readonly HttpListener _listener;
    private readonly CancellationTokenSource _cts = new();
    private Task? _serverTask;

    public DlCheckerApiServer(FileIndexService fileIndexService, int port)
    {
        _fileIndexService = fileIndexService;
        Port = port;
        _listener = new HttpListener();
        _listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
    }

    public int Port { get; }

    public void Start()
    {
        _listener.Start();
        _serverTask = Task.Run(() => RunLoop(_cts.Token));
    }

    public void Dispose()
    {
        _cts.Cancel();
        try
        {
            _listener.Stop();
        }
        catch
        {
            // Ignore shutdown errors.
        }

        _listener.Close();
    }

    private async Task RunLoop(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            HttpListenerContext? context = null;
            try
            {
                context = await _listener.GetContextAsync();
                _ = Task.Run(() => Handle(context), token);
            }
            catch when (token.IsCancellationRequested)
            {
                return;
            }
            catch
            {
                if (context is not null)
                {
                    context.Response.StatusCode = 500;
                    context.Response.Close();
                }
            }
        }
    }

    private async Task Handle(HttpListenerContext context)
    {
        try
        {
            AddCorsHeaders(context.Response);

            if (context.Request.HttpMethod == "OPTIONS")
            {
                context.Response.StatusCode = 204;
                context.Response.Close();
                return;
            }

            var path = context.Request.Url?.AbsolutePath ?? "/";
            if (path.Equals("/health", StringComparison.OrdinalIgnoreCase) &&
                context.Request.HttpMethod == "GET")
            {
                await WriteJson(context.Response, new
                {
                    status = "ok",
                    monitoredFolder = _fileIndexService.MonitoredFolder,
                    fileCount = _fileIndexService.FileCount,
                    port = Port
                });
                return;
            }

            if (path.Equals("/match", StringComparison.OrdinalIgnoreCase) &&
                context.Request.HttpMethod == "POST")
            {
                var request = await ReadJson<MatchRequest>(context.Request);
                if (request is null || string.IsNullOrWhiteSpace(request.Query))
                {
                    context.Response.StatusCode = 400;
                    await WriteJson(context.Response, new { error = "query is required" });
                    return;
                }

                var results = _fileIndexService.Match(request.Query, request.TopN ?? 5);
                await WriteJson(context.Response, new
                {
                    query = request.Query,
                    count = results.Count,
                    results
                });
                return;
            }

            if (path.Equals("/ingest", StringComparison.OrdinalIgnoreCase) &&
                context.Request.HttpMethod == "POST")
            {
                var request = await ReadJson<IngestRequest>(context.Request);
                if (request is null)
                {
                    context.Response.StatusCode = 400;
                    await WriteJson(context.Response, new { error = "body is required" });
                    return;
                }

                var query = BuildQuery(request);
                if (string.IsNullOrWhiteSpace(query))
                {
                    context.Response.StatusCode = 400;
                    await WriteJson(context.Response, new { error = "title or url is required" });
                    return;
                }

                var results = _fileIndexService.Match(query, request.TopN ?? 5);
                await WriteJson(context.Response, new
                {
                    query,
                    request.Url,
                    request.Title,
                    count = results.Count,
                    results
                });
                return;
            }

            context.Response.StatusCode = 404;
            await WriteJson(context.Response, new { error = "not found" });
        }
        catch
        {
            if (context.Response.OutputStream.CanWrite)
            {
                context.Response.StatusCode = 500;
                await WriteJson(context.Response, new { error = "internal server error" });
            }
        }
        finally
        {
            context.Response.Close();
        }
    }

    private static string BuildQuery(IngestRequest request)
    {
        if (!string.IsNullOrWhiteSpace(request.Query))
        {
            return request.Query;
        }

        if (!string.IsNullOrWhiteSpace(request.Title))
        {
            return request.Title;
        }

        if (Uri.TryCreate(request.Url, UriKind.Absolute, out var uri))
        {
            return Path.GetFileName(uri.AbsolutePath);
        }

        return request.Url ?? string.Empty;
    }

    private static void AddCorsHeaders(HttpListenerResponse response)
    {
        response.Headers.Add("Access-Control-Allow-Origin", "*");
        response.Headers.Add("Access-Control-Allow-Headers", "content-type");
        response.Headers.Add("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }

    private static async Task<T?> ReadJson<T>(HttpListenerRequest request)
    {
        using var stream = request.InputStream;
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var body = await reader.ReadToEndAsync();
        if (string.IsNullOrWhiteSpace(body))
        {
            return default;
        }

        return JsonSerializer.Deserialize<T>(body, JsonOptions);
    }

    private static async Task WriteJson(HttpListenerResponse response, object payload)
    {
        response.ContentType = "application/json; charset=utf-8";
        var json = JsonSerializer.Serialize(payload, JsonOptions);
        var bytes = Encoding.UTF8.GetBytes(json);
        response.ContentLength64 = bytes.Length;
        await response.OutputStream.WriteAsync(bytes);
    }
}

internal sealed class MatchRequest
{
    public string Query { get; set; } = string.Empty;
    public int? TopN { get; set; }
}

internal sealed class IngestRequest
{
    public string? Url { get; set; }
    public string? Title { get; set; }
    public string? Query { get; set; }
    public int? TopN { get; set; }
}