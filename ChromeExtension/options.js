const DEFAULT_ENDPOINT = "http://127.0.0.1:48762/ingest";

async function init() {
  const { endpoint, enabled } = await chrome.storage.sync.get(["endpoint", "enabled"]);
  document.getElementById("endpoint").value = endpoint || DEFAULT_ENDPOINT;
  document.getElementById("enabled").checked = enabled !== false;
}

async function save() {
  const endpoint = document.getElementById("endpoint").value.trim() || DEFAULT_ENDPOINT;
  const enabled = document.getElementById("enabled").checked;

  await chrome.storage.sync.set({ endpoint, enabled });
  const status = document.getElementById("status");
  status.textContent = "保存しました";
  setTimeout(() => {
    status.textContent = "";
  }, 1000);
}

document.getElementById("save").addEventListener("click", save);
init();
