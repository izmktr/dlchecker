const runButton = document.getElementById("run");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");

runButton.addEventListener("click", runIngestForCurrentTab);
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
  setStatus("実行中...");
  resultEl.textContent = "現在のタブ情報を送信しています。";

  try {
    const result = await chrome.runtime.sendMessage({ type: "dlchecker:runCurrentTab" });
    renderResult(result, { source: "manual", timestamp: Date.now() });
  } catch (error) {
    setStatus("失敗", true);
    resultEl.textContent = error?.message || "実行に失敗しました";
  } finally {
    runButton.disabled = false;
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
  const sourceLabel = meta.source === "auto" ? "自動チェック" : "手動チェック";
  const timeText = formatTime(meta.timestamp);

  const header = [
    `<div><strong>種別:</strong> ${escapeHtml(sourceLabel)}</div>`,
    `<div><strong>時刻:</strong> ${escapeHtml(timeText)}</div>`,
    `<div><strong>Query:</strong> ${escapeHtml(apiRes.query || result.payload?.query || "")}</div>`,
    `<div><strong>件数:</strong> ${list.length}</div>`
  ];

  if (top.length === 0) {
    resultEl.innerHTML = `${header.join("")}<div class="small">候補なし</div>`;
    return;
  }

  const items = top
    .map((item) => {
      const name = escapeHtml(item.fileName || "(no name)");
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

function formatTime(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "-";
  }

  return new Date(timestamp).toLocaleString("ja-JP");
}
