const DEFAULT_ENDPOINT = "http://127.0.0.1:48762/ingest";
const DEFAULT_ENABLED = true;
const DEFAULT_THRESHOLD = 80;
const GREEN_WATCH_TABS_KEY = "greenWatchTabs";

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(["endpoint", "enabled", "threshold", "targetUrls"]);
  if (!current.endpoint) {
    await chrome.storage.sync.set({ endpoint: DEFAULT_ENDPOINT });
  }
  if (typeof current.enabled !== "boolean") {
    await chrome.storage.sync.set({ enabled: DEFAULT_ENABLED });
  }
  if (!Number.isFinite(current.threshold)) {
    await chrome.storage.sync.set({ threshold: DEFAULT_THRESHOLD });
  }
  if (typeof current.targetUrls !== "string") {
    await chrome.storage.sync.set({ targetUrls: "" });
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
    await removeGreenWatchTab(tab.id);
    return;
  }

  const { enabled, endpoint, threshold, targetUrls } = await chrome.storage.sync.get([
    "enabled",
    "endpoint",
    "threshold",
    "targetUrls"
  ]);

  if (enabled === false) {
    await removeGreenWatchTab(tab.id);
    return;
  }

  const matchedRule = findMatchedTargetRule(tab.url, targetUrls);
  if (!matchedRule) {
    await removeGreenWatchTab(tab.id);
    return;
  }

  const payload = {
    url: tab.url,
    title: tab.title,
    query: pickQuery(tab.title, tab.url, matchedRule.removeTokens),
    topN: 5
  };

  try {
    const result = await postIngest(payload, endpoint || DEFAULT_ENDPOINT);
    const normalizedThreshold = normalizeThreshold(threshold);
    const hasHighMatch = await updateActionByResult(tab.id, result, normalizedThreshold);
    await updateGreenWatchState(tab.id, {
      endpoint: endpoint || DEFAULT_ENDPOINT,
      threshold: normalizedThreshold,
      payload,
      hasHighMatch
    });
    await saveLastResultForTab(tab.id, result, "auto");
  } catch (_error) {
    // Local app may be stopped; ignore to keep extension quiet.
  }
});

chrome.downloads.onChanged.addListener(async (downloadDelta) => {
  if (!downloadDelta?.state || downloadDelta.state.current !== "complete") {
    return;
  }

  const filePathOrUrl = await resolveDownloadFileName(downloadDelta.id);
  const fileName = extractFileNameFromPath(filePathOrUrl);

  await recheckGreenWatchTabs(fileName);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove(tabResultKey(tabId));
  await removeGreenWatchTab(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "dlchecker:runCurrentTab") {
    runCurrentTabIngest(message.query)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "Unknown error"
        });
      });

    return true;
  }

  if (message.type === "dlchecker:getCurrentTabLastResult") {
    getCurrentTabLastResult()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          found: false,
          error: error?.message || "Unknown error"
        });
      });

    return true;
  }

  return false;
});

async function runCurrentTabIngest(manualQuery = "") {
  const tab = await getCurrentActiveTab();
  if (!tab || !tab.url || !tab.title) {
    return {
      ok: false,
      error: "現在のタブ情報を取得できませんでした"
    };
  }

  if (!/^https?:\/\//i.test(tab.url)) {
    return {
      ok: false,
      error: "http/https のページで実行してください"
    };
  }

  const { enabled, endpoint } = await chrome.storage.sync.get(["enabled", "endpoint"]);
  if (enabled === false) {
    return {
      ok: false,
      error: "拡張連携が無効です"
    };
  }

  const normalizedManualQuery = typeof manualQuery === "string" ? manualQuery.trim() : "";

  const payload = {
    url: tab.url,
    title: tab.title,
    query: normalizedManualQuery || pickQuery(tab.title, tab.url),
    topN: 5
  };

  const threshold = normalizeThreshold((await chrome.storage.sync.get(["threshold"]))?.threshold);
  const result = await postIngest(payload, endpoint || DEFAULT_ENDPOINT);
  const hasHighMatch = await updateActionByResult(tab.id, result, threshold);
  await updateGreenWatchState(tab.id, {
    endpoint: endpoint || DEFAULT_ENDPOINT,
    threshold,
    payload,
    hasHighMatch
  });
  await saveLastResultForTab(tab.id, result, "manual");
  return result;
}

async function getCurrentTabLastResult() {
  const tab = await getCurrentActiveTab();
  if (!tab || !Number.isInteger(tab.id)) {
    return { found: false };
  }

  const key = tabResultKey(tab.id);
  const data = await chrome.storage.session.get([key]);
  const record = data[key];
  if (!record) {
    return { found: false };
  }

  return {
    found: true,
    source: record.source,
    timestamp: record.timestamp,
    result: record.result
  };
}

async function getCurrentActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function tabResultKey(tabId) {
  return `lastResultTab_${tabId}`;
}

function greenWatchTabKey(tabId) {
  return String(tabId);
}

async function saveLastResultForTab(tabId, result, source) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  await chrome.storage.session.set({
    [tabResultKey(tabId)]: {
      source,
      timestamp: Date.now(),
      result
    }
  });
}

async function getGreenWatchTabs() {
  const data = await chrome.storage.session.get([GREEN_WATCH_TABS_KEY]);
  const tabs = data[GREEN_WATCH_TABS_KEY];
  if (!tabs || typeof tabs !== "object") {
    return {};
  }

  return tabs;
}

async function setGreenWatchTabs(tabs) {
  await chrome.storage.session.set({
    [GREEN_WATCH_TABS_KEY]: tabs
  });
}

async function updateGreenWatchState(tabId, options) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  const tabs = await getGreenWatchTabs();
  const key = greenWatchTabKey(tabId);

  if (options.hasHighMatch) {
    delete tabs[key];
  } else {
    tabs[key] = {
      endpoint: options.endpoint,
      threshold: options.threshold,
      payload: options.payload
    };
  }

  await setGreenWatchTabs(tabs);
}

async function removeGreenWatchTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  const tabs = await getGreenWatchTabs();
  const key = greenWatchTabKey(tabId);
  if (!(key in tabs)) {
    return;
  }

  delete tabs[key];
  await setGreenWatchTabs(tabs);
}

async function recheckGreenWatchTabs(downloadedFileName = "") {
  const tabs = await getGreenWatchTabs();
  const keys = Object.keys(tabs);
  const effectiveDownloadedFileName = downloadedFileName;

  if (keys.length === 0) {
    return;
  }

  if (!effectiveDownloadedFileName) {
    return;
  }

  for (const key of keys) {
    const tabId = Number.parseInt(key, 10);
    if (!Number.isInteger(tabId)) {
      delete tabs[key];
      continue;
    }

    const watch = tabs[key];
    if (!watch?.payload || !watch?.endpoint) {
      delete tabs[key];
      continue;
    }

    try {
      await chrome.tabs.get(tabId);
    } catch (_error) {
      delete tabs[key];
      continue;
    }

    try {
      const threshold = normalizeThreshold(watch.threshold);
      const originalQuery = String(watch.payload?.query || "");
      const metrics = computeMatchMetrics(originalQuery, effectiveDownloadedFileName);
      const hasHighMatch = await updateActionByScore(tabId, metrics.score, threshold);

      if (hasHighMatch) {
        await saveLastResultForTab(
          tabId,
          buildDownloadResultPayload(originalQuery, effectiveDownloadedFileName, metrics),
          "download");
      }

      if (hasHighMatch) {
        delete tabs[key];
      }
    } catch (_error) {
      // Keep watch registration and retry on next completed download.
    }
  }

  await setGreenWatchTabs(tabs);
}

async function postIngest(payload, endpoint) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  let body = null;
  try {
    body = await response.json();
  } catch (_error) {
    body = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: body?.error || `HTTP ${response.status}`,
      endpoint,
      payload
    };
  }

  return {
    ok: true,
    status: response.status,
    endpoint,
    payload,
    response: body
  };
}

async function resolveDownloadFileName(downloadId) {
  if (!Number.isFinite(downloadId)) {
    return "";
  }

  try {
    const items = await chrome.downloads.search({ id: downloadId, limit: 1 });
    const item = items?.[0];
    return item?.filename || item?.finalUrl || "";
  } catch (_error) {
    return "";
  }
}

function extractFileNameFromPath(pathOrUrl) {
  const value = String(pathOrUrl || "");
  if (!value) {
    return "";
  }

  const replaced = value.replace(/\\/g, "/");
  const lastSegment = replaced.split("/").filter(Boolean).pop() || "";
  try {
    return decodeURIComponent(lastSegment);
  } catch (_error) {
    return lastSegment;
  }
}

function buildDownloadResultPayload(query, downloadedFileName, metrics) {
  return {
    ok: true,
    status: 200,
    payload: {
      query,
      title: downloadedFileName,
      url: ""
    },
    response: {
      query,
      count: 1,
      results: [
        {
          fileName: downloadedFileName,
          fullPath: "",
          matchCount: metrics.matchCount,
          score: metrics.score
        }
      ]
    }
  };
}

function computeMatchMetrics(query, downloadedFileName) {
  const normalizedQuery = normalizeMatchToken(query);
  const normalizedFileName = normalizeMatchToken(downloadedFileName);
  if (!normalizedQuery || !normalizedFileName) {
    return { matchCount: 0, score: 0 };
  }

  const matchCount = longestCommonSubsequenceLength(normalizedQuery, normalizedFileName);
  const denominator = normalizedFileName.length;
  const score = denominator === 0
    ? 0
    : Math.max(0, Math.min(100, Math.round((matchCount / denominator) * 100)));

  return { matchCount, score };
}

function normalizeMatchToken(input) {
  const fileName = extractFileNameFromPath(String(input || ""));
  const stem = fileName.replace(/\.[^./\\]+$/, "");
  return stem.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function longestCommonSubsequenceLength(a, b) {
  if (!a || !b) {
    return 0;
  }

  const previous = new Uint16Array(b.length + 1);
  const current = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
      } else {
        current[j] = Math.max(current[j - 1], previous[j]);
      }
    }

    previous.set(current);
    current.fill(0);
  }

  return previous[b.length];
}

async function updateActionByScore(tabId, score, threshold) {
  if (!Number.isInteger(tabId)) {
    return false;
  }

  if (score >= threshold) {
    await chrome.action.setBadgeText({ tabId, text: "!" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
    await chrome.action.setTitle({ tabId, title: `DlChecker: 一致候補あり (max ${score})` });
    return true;
  }

  await chrome.action.setBadgeText({ tabId, text: "✓" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#188038" });
  await chrome.action.setTitle({ tabId, title: `DlChecker: 一致候補なし (max ${Math.max(0, score)})` });
  return false;
}

function pickQuery(title, url, removeTokens = []) {
  const byTitle = sanitize(title, removeTokens);
  if (byTitle.length > 0) {
    return byTitle;
  }

  try {
    const parsed = new URL(url);
    const lastPath = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return sanitize(lastPath, removeTokens);
  } catch (_error) {
    return sanitize(url, removeTokens);
  }
}

function sanitize(input, removeTokens = []) {
  let text = String(input || "");

  for (const token of normalizeRemoveTokens(removeTokens)) {
    const tokenPattern = new RegExp(escapeRegExp(token), "gi");
    text = text.replace(tokenPattern, " ");
  }

  return text
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[(){}【】「」\-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRemoveTokens(removeTokens) {
  if (!Array.isArray(removeTokens)) {
    return [];
  }

  return removeTokens
    .map((token) => String(token || "").trim())
    .filter((token) => token.length > 0);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeThreshold(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_THRESHOLD;
  }

  return Math.min(100, Math.max(0, Number(value)));
}

function splitTargetUrls(targetUrls) {
  if (typeof targetUrls !== "string") {
    return [];
  }

  return targetUrls
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseTargetRules(targetUrls) {
  return splitTargetUrls(targetUrls).map((line) => {
    const separatorIndex = line.indexOf("|");
    if (separatorIndex < 0) {
      return {
        pattern: line,
        removeTokens: []
      };
    }

    const pattern = line.slice(0, separatorIndex).trim();
    const removePart = line.slice(separatorIndex + 1).trim();
    const removeTokens = removePart
      .split(/[，,]/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    return {
      pattern,
      removeTokens
    };
  }).filter((rule) => rule.pattern.length > 0);
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexText = `^${escaped.replace(/\*/g, ".*")}$`;
  return new RegExp(regexText, "i");
}

function isTargetUrl(url, targetUrls) {
  return Boolean(findMatchedTargetRule(url, targetUrls));
}

function isUrlPatternMatch(url, target) {
  if (target.includes("*")) {
    return wildcardToRegExp(target).test(url);
  }

  if (/^https?:\/\//i.test(target)) {
    return url.startsWith(target);
  }

  return url.includes(target);
}

function findMatchedTargetRule(url, targetUrls) {
  const rules = parseTargetRules(targetUrls);
  if (rules.length === 0) {
    return null;
  }

  for (const rule of rules) {
    if (isUrlPatternMatch(url, rule.pattern)) {
      return rule;
    }
  }

  return null;
}

async function updateActionByResult(tabId, result, threshold) {
  if (!Number.isInteger(tabId)) {
    return false;
  }

  const scores = extractScores(result);
  const maxScore = scores.length > 0 ? Math.max(...scores) : -1;
  if (maxScore >= threshold) {
    await chrome.action.setBadgeText({ tabId, text: "!" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
    await chrome.action.setTitle({ tabId, title: `DlChecker: 一致候補あり (max ${maxScore})` });
    return true;
  }

  await chrome.action.setBadgeText({ tabId, text: "✓" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#188038" });
  await chrome.action.setTitle({ tabId, title: `DlChecker: 一致候補なし (max ${Math.max(0, maxScore)})` });
  return false;
}

function extractScores(result) {
  if (!result || !result.ok) {
    return [];
  }

  const response = result.response || {};
  const values = Array.isArray(response.results) ? response.results : [];
  return values
    .map((item) => Number(item?.score))
    .filter((score) => Number.isFinite(score));
}
