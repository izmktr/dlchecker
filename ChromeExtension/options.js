const DEFAULT_ENDPOINT = "http://127.0.0.1:48762/ingest";
const DEFAULT_THRESHOLD = 80;

async function init() {
  const { endpoint, enabled, threshold, targetUrls } = await chrome.storage.sync.get([
    "endpoint",
    "enabled",
    "threshold",
    "targetUrls"
  ]);
  document.getElementById("endpoint").value = endpoint || DEFAULT_ENDPOINT;
  document.getElementById("enabled").checked = enabled !== false;
  document.getElementById("threshold").value = Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD;
  document.getElementById("targetUrls").value = targetUrls || "";
}

async function save() {
  const endpoint = document.getElementById("endpoint").value.trim() || DEFAULT_ENDPOINT;
  const enabled = document.getElementById("enabled").checked;
  const thresholdRaw = Number.parseInt(document.getElementById("threshold").value, 10);
  const threshold = Number.isFinite(thresholdRaw) ? Math.min(100, Math.max(0, thresholdRaw)) : DEFAULT_THRESHOLD;
  const targetUrls = document.getElementById("targetUrls").value;

  await chrome.storage.sync.set({ endpoint, enabled, threshold, targetUrls });
  const status = document.getElementById("status");
  status.textContent = "保存しました";
  setTimeout(() => {
    status.textContent = "";
  }, 1000);
}

document.getElementById("save").addEventListener("click", save);
init();
