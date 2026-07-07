const DEFAULT_ENDPOINT = "http://127.0.0.1:48762/ingest";
const DEFAULT_ENABLED = true;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(["endpoint", "enabled"]);
  if (!current.endpoint) {
    await chrome.storage.sync.set({ endpoint: DEFAULT_ENDPOINT });
  }
  if (typeof current.enabled !== "boolean") {
    await chrome.storage.sync.set({ enabled: DEFAULT_ENABLED });
  }
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  if (!tab || !tab.url || !tab.title) {
    return;
  }

  if (!/^https?:\/\//i.test(tab.url)) {
    return;
  }

  const { enabled, endpoint } = await chrome.storage.sync.get(["enabled", "endpoint"]);
  if (enabled === false) {
    return;
  }

  const payload = {
    url: tab.url,
    title: tab.title,
    query: pickQuery(tab.title, tab.url),
    topN: 5
  };

  const targetEndpoint = endpoint || DEFAULT_ENDPOINT;
  try {
    await fetch(targetEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (_error) {
    // Local app may be stopped; ignore to keep extension quiet.
  }
});

function pickQuery(title, url) {
  const byTitle = sanitize(title);
  if (byTitle.length > 0) {
    return byTitle;
  }

  try {
    const parsed = new URL(url);
    const lastPath = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return sanitize(lastPath);
  } catch (_error) {
    return sanitize(url);
  }
}

function sanitize(input) {
  return String(input || "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[(){}【】「」\-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
