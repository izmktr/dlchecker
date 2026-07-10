const runButton = document.getElementById("run");
const queryInput = document.getElementById("query");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");

runButton.addEventListener("click", runIngestForCurrentTab);
queryInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runIngestForCurrentTab();
  }
});
loadLastResult();

async function loadLastResult() {
  try {
    const stored = await chrome.runtime.sendMessage({ type: "dlchecker:getCurrentTabLastResult" });
    if (!stored || !stored.found || !stored.result) {
      setStatus("待機中");
      resultEl.textContent = "まだ実行していません。";
      return;
    }

    renderResult(stored.result, {
      source: stored.source,
      timestamp: stored.timestamp
    });
  } catch (error) {
    setStatus("失敗", true);
    resultEl.textContent = error?.message || "前回結果の取得に失敗しました";
  }
}

async function runIngestForCurrentTab() {
  runButton.disabled = true;
  if (queryInput) {
    queryInput.disabled = true;
  }
  setStatus("実行中...");
  resultEl.textContent = "現在のタブ情報を送信しています。";

  try {
    const manualQuery = queryInput?.value?.trim() || "";
    const result = await chrome.runtime.sendMessage({
      type: "dlchecker:runCurrentTab",
      query: manualQuery
    });
    renderResult(result, { source: "manual", timestamp: Date.now() });
  } catch (error) {
    setStatus("失敗", true);
    resultEl.textContent = error?.message || "実行に失敗しました";
  } finally {
    runButton.disabled = false;
    if (queryInput) {
      queryInput.disabled = false;
    }
  }
}

function renderResult(result, meta = {}) {
  if (!result) {
    setStatus("失敗", true);
    resultEl.textContent = "レスポンスがありません";
    return;
  }

  if (!result.ok) {
    setStatus("失敗", true);
    const endpoint = result.endpoint ? `送信先: ${escapeHtml(result.endpoint)}\n` : "";
    const status = result.status ? `HTTP: ${result.status}\n` : "";
    const error = result.error || "不明なエラー";
    resultEl.textContent = `${endpoint}${status}エラー: ${error}`;
    return;
  }

  setStatus("成功");

  const apiRes = result.response || {};
  const list = Array.isArray(apiRes.results) ? apiRes.results : [];
  const top = list.slice(0, 5);
  const sourceLabel = getSourceLabel(meta.source);
  const timeText = formatTime(meta.timestamp);
  const queryText = String(apiRes.query || result.payload?.query || "");

  const header = [
    `<div><strong>種別:</strong> ${escapeHtml(sourceLabel)}</div>`,
    `<div><strong>時刻:</strong> ${escapeHtml(timeText)}</div>`,
    `<div><strong>Query:</strong> ${escapeHtml(queryText)}</div>`,
    `<div><strong>件数:</strong> ${list.length}</div>`
  ];

  if (top.length === 0) {
    resultEl.innerHTML = `${header.join("")}<div class="small">候補なし</div>`;
    return;
  }

  const items = top
    .map((item) => {
      const name = highlightFileName(item.fileName || "(no name)", queryText);
      const score = Number.isFinite(item.score) ? item.score : "-";
      const path = escapeHtml(item.fullPath || "");
      return `<li class="item"><div><strong>${name}</strong> (${score})</div><div>${path}</div></li>`;
    })
    .join("");

  resultEl.innerHTML = `${header.join("")}<ol class="list">${items}</ol>`;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#b3261e" : "#1e8e3e";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightMatch(text, query) {
  const safeText = String(text ?? "");
  const safeQuery = normalizeForMatch(query);
  if (!safeQuery) {
    return escapeHtml(safeText);
  }

  const normalizedMap = buildNormalizedMap(safeText);
  const normalizedText = normalizedMap.normalized;
  if (!normalizedText) {
    return escapeHtml(safeText);
  }

  const matchedPositions = findLcsMatchPositions(normalizedText, safeQuery, normalizedMap.positions);
  const highlightRanges = buildHighlightRanges(matchedPositions);
  if (highlightRanges.length === 0) {
    return escapeHtml(safeText);
  }

  let html = "";
  let cursor = 0;

  for (const [start, end] of highlightRanges) {
    if (cursor < start) {
      html += escapeHtml(safeText.slice(cursor, start));
    }

    html += `<span class="match-highlight">${escapeHtml(safeText.slice(start, end))}</span>`;
    cursor = end;
  }

  if (cursor < safeText.length) {
    html += escapeHtml(safeText.slice(cursor));
  }

  return html;
}

function highlightFileName(fileName, query) {
  const safeName = String(fileName ?? "");
  const lastDotIndex = safeName.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return highlightMatch(safeName, query);
  }

  const stem = safeName.slice(0, lastDotIndex);
  const extension = safeName.slice(lastDotIndex);
  return `${highlightMatch(stem, query)}${escapeHtml(extension)}`;
}

function normalizeForMatch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function buildNormalizedMap(text) {
  let normalized = "";
  const positions = [];

  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    const lowered = ch.toLowerCase();
    if (/[^\p{L}\p{N}]/u.test(ch)) {
      continue;
    }

    normalized += lowered;
    positions.push(index);
  }

  return { normalized, positions };
}

function findLcsMatchPositions(normalizedText, normalizedQuery, positions) {
  const rows = normalizedText.length;
  const cols = normalizedQuery.length;
  if (rows === 0 || cols === 0) {
    return [];
  }

  const dp = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= cols; j++) {
      if (normalizedText[i - 1] === normalizedQuery[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const matchedPositions = [];
  let i = rows;
  let j = cols;
  while (i > 0 && j > 0) {
    if (normalizedText[i - 1] === normalizedQuery[j - 1]) {
      matchedPositions.push(positions[i - 1]);
      i--;
      j--;
      continue;
    }

    if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matchedPositions.reverse();
}

function buildHighlightRanges(matchedPositions) {
  if (matchedPositions.length === 0) {
    return [];
  }

  const ranges = [];
  let start = matchedPositions[0];
  let previous = matchedPositions[0];

  for (let index = 1; index < matchedPositions.length; index++) {
    const current = matchedPositions[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }

    if (previous - start + 1 >= 3) {
      ranges.push([start, previous + 1]);
    }

    start = current;
    previous = current;
  }

  if (previous - start + 1 >= 3) {
    ranges.push([start, previous + 1]);
  }

  return ranges;
}

function formatTime(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "-";
  }

  return new Date(timestamp).toLocaleString("ja-JP");
}

function getSourceLabel(source) {
  if (source === "auto") {
    return "自動チェック";
  }

  if (source === "download") {
    return "ダウンロード監視";
  }

  return "手動チェック";
}
