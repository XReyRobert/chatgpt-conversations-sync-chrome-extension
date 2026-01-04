function renderStatus(status) {
  if (!status) {
    return "No syncs yet.";
  }
  if (status.lastError) {
    return `Error: ${status.lastError}`;
  }
  if (status.lastSyncFinishedAt) {
    return `Last sync: ${status.lastSyncFinishedAt}`;
  }
  return "No syncs yet.";
}

function loadStatus() {
  chrome.runtime.sendMessage({ type: "get-status" }, (response) => {
    if (!response || !response.ok) {
      return;
    }
    document.getElementById("status").textContent = renderStatus(response.status);
  });
}

document.getElementById("syncNow").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "sync-now" }, () => {
    loadStatus();
  });
});

document.getElementById("openChatgpt").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://chatgpt.com/" });
});

loadStatus();
