function formatStatus(status) {
  if (!status) {
    return "No sync activity yet.";
  }
  const lines = [];
  if (status.lastSyncStartedAt) {
    lines.push(`Last sync started: ${status.lastSyncStartedAt}`);
  }
  if (status.lastSyncFinishedAt) {
    lines.push(`Last sync finished: ${status.lastSyncFinishedAt}`);
  }
  if (status.lastSyncReason) {
    lines.push(`Reason: ${status.lastSyncReason}`);
  }
  if (status.lastSyncSummary) {
    const summary = status.lastSyncSummary;
    lines.push(
      `Summary: ${summary.updated || 0} updated, ${summary.skipped || 0} unchanged, ${summary.errors || 0} errors, ${summary.total || 0} total.`
    );
  }
  if (status.progress && status.progress.total) {
    const progress = status.progress;
    const label = progress.status ? `${progress.status} ` : "";
    lines.push(`Progress: ${label}${progress.processed || 0} / ${progress.total}`);
  }
  if (status.lastError) {
    lines.push(`Error: ${status.lastError}`);
  }
  return lines.length ? lines.join("\n") : "No sync activity yet.";
}

function formatIso(value) {
  if (!value) {
    return "Unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString();
}

function formatEpochSeconds(value) {
  if (!value) {
    return "Unknown";
  }
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds)) {
    return "Unknown";
  }
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString();
}

function formatCount(value) {
  return String(value || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function readOptions() {
  return {
    syncIntervalMinutes: Number.parseInt(
      document.getElementById("syncInterval").value,
      10
    ),
    maxParallelFetch: Number.parseInt(
      document.getElementById("parallelFetches").value,
      10
    ),
    includeJson: document.getElementById("includeJson").checked,
    includeMarkdown: document.getElementById("includeMarkdown").checked,
    deleteRemoved: document.getElementById("deleteRemoved").checked
  };
}

function applyOptions(options) {
  document.getElementById("syncInterval").value = options.syncIntervalMinutes || 10;
  document.getElementById("parallelFetches").value = options.maxParallelFetch || 3;
  document.getElementById("includeJson").checked = options.includeJson !== false;
  document.getElementById("includeMarkdown").checked = options.includeMarkdown !== false;
  document.getElementById("deleteRemoved").checked = options.deleteRemoved === true;
}

let indexEntries = [];
let indexTotal = 0;
let latestSyncState = null;
let indexRenderTimer = null;
let filterTimer = null;

function buildIndexEntries(syncState) {
  const metaMap = (syncState && syncState.meta) || {};
  const convMap = (syncState && syncState.conversations) || {};
  const runMap = (syncState && syncState.lastRun) || {};
  const ids = new Set([
    ...Object.keys(metaMap),
    ...Object.keys(convMap)
  ]);

  const entries = [];
  for (const id of ids) {
    const meta = metaMap[id] || {};
    const updateTime = meta.update_time || convMap[id] || 0;
    const run = runMap[id] || null;
    entries.push({
      id,
      title: meta.title || "(untitled)",
      create_time: meta.create_time || 0,
      update_time: updateTime,
      status: run && run.status ? run.status : "unknown",
      lastSyncAt: run && run.at ? run.at : "",
      lastError: run && run.error ? run.error : ""
    });
  }
  return entries;
}

function updateIndexMeta(syncState, entries) {
  const meta = [];
  const total = entries.length;
  const lastFull = syncState && syncState.lastFullInventoryAt
    ? formatIso(syncState.lastFullInventoryAt)
    : "Never";
  const inProgress = syncState && syncState.inventoryInProgress ? "Yes" : "No";
  const cursor = syncState && syncState.inventoryCursor
    ? `Offset ${syncState.inventoryCursor.offset || 0} (updated ${formatIso(syncState.inventoryCursor.updatedAt)})`
    : "None";

  const statusCounts = entries.reduce((acc, entry) => {
    const key = entry.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  meta.push(`Indexed conversations: ${formatCount(total)}`);
  meta.push(`Last full inventory: ${lastFull}`);
  meta.push(`Inventory in progress: ${inProgress}`);
  meta.push(`Resume cursor: ${cursor}`);
  meta.push(
    `Last run statuses: ${formatCount(statusCounts.updated || 0)} updated, ${formatCount(statusCounts.unchanged || 0)} unchanged, ${formatCount(statusCounts.error || 0)} error, ${formatCount(statusCounts.unknown || 0)} unknown.`
  );

  document.getElementById("indexMeta").textContent = meta.join("\n");
}

function sortEntries(entries, sortMode) {
  const sorted = [...entries];
  switch (sortMode) {
    case "updated-asc":
      sorted.sort((a, b) => (a.update_time || 0) - (b.update_time || 0));
      break;
    case "title-asc":
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "title-desc":
      sorted.sort((a, b) => b.title.localeCompare(a.title));
      break;
    case "updated-desc":
    default:
      sorted.sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
      break;
  }
  return sorted;
}

function renderIndexList(entries) {
  const list = document.getElementById("indexList");
  list.textContent = "";

  const header = document.createElement("div");
  header.className = "index-row head";
  header.innerHTML = `
    <div>Title</div>
    <div>Status</div>
    <div>Updated</div>
    <div>Last Sync</div>
  `;
  list.appendChild(header);

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "index-empty";
    empty.textContent = "No conversations indexed yet.";
    list.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "index-row";

    const titleCell = document.createElement("div");
    const title = document.createElement("div");
    title.className = "index-title";
    title.textContent = entry.title || "(untitled)";
    const subtitle = document.createElement("div");
    subtitle.className = "index-id";
    subtitle.textContent = entry.id;
    titleCell.appendChild(title);
    titleCell.appendChild(subtitle);

    const statusCell = document.createElement("div");
    const pill = document.createElement("span");
    const status = entry.status || "unknown";
    pill.className = `status-pill status-${status}`;
    pill.textContent = status;
    statusCell.appendChild(pill);

    const updatedCell = document.createElement("div");
    updatedCell.textContent = formatEpochSeconds(entry.update_time);

    const syncCell = document.createElement("div");
    syncCell.textContent = entry.lastSyncAt ? formatIso(entry.lastSyncAt) : "Not synced";
    if (entry.lastError) {
      syncCell.title = entry.lastError;
    }

    row.appendChild(titleCell);
    row.appendChild(statusCell);
    row.appendChild(updatedCell);
    row.appendChild(syncCell);
    fragment.appendChild(row);
  }
  list.appendChild(fragment);
}

function applyIndexFilters() {
  const searchValue = document.getElementById("indexSearch").value.trim().toLowerCase();
  const statusValue = document.getElementById("indexStatus").value;
  const sortValue = document.getElementById("indexSort").value;

  let filtered = indexEntries;
  if (searchValue) {
    filtered = filtered.filter((entry) => {
      return (
        entry.title.toLowerCase().includes(searchValue) ||
        entry.id.toLowerCase().includes(searchValue)
      );
    });
  }
  if (statusValue !== "all") {
    filtered = filtered.filter((entry) => (entry.status || "unknown") === statusValue);
  }

  filtered = sortEntries(filtered, sortValue);
  document.getElementById("indexCount").textContent = `Showing ${formatCount(filtered.length)} of ${formatCount(indexTotal)} conversations.`;
  renderIndexList(filtered);
}

function scheduleFilterApply() {
  if (filterTimer) {
    clearTimeout(filterTimer);
  }
  filterTimer = setTimeout(() => {
    applyIndexFilters();
  }, 150);
}

function refreshIndex() {
  chrome.storage.local.get(["syncState"], (result) => {
    const syncState = result && result.syncState ? result.syncState : {};
    indexEntries = buildIndexEntries(syncState);
    indexTotal = indexEntries.length;
    latestSyncState = syncState;
    updateIndexMeta(syncState, indexEntries);
    applyIndexFilters();
  });
}

function loadStatus() {
  chrome.runtime.sendMessage({ type: "get-status" }, (response) => {
    if (!response || !response.ok) {
      return;
    }
    applyOptions(response.options);
    document.getElementById("status").textContent = formatStatus(response.status);
  });

  chrome.storage.local.get(["folderLabel"], (result) => {
    const label = result && result.folderLabel ? result.folderLabel : "No folder selected";
    document.getElementById("folderLabel").textContent = label;
  });
}

document.getElementById("save").addEventListener("click", () => {
  const options = readOptions();
  chrome.runtime.sendMessage({ type: "update-options", options }, () => {
    loadStatus();
  });
});

document.getElementById("syncNow").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "sync-now" }, () => {
    loadStatus();
  });
});

document.getElementById("openChatgpt").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://chatgpt.com/" });
});

document.getElementById("refreshIndex").addEventListener("click", () => {
  refreshIndex();
});

document.getElementById("reInventory").addEventListener("click", () => {
  const confirmed = window.confirm(
    "Re-inventory will restart a full conversation listing from the beginning. This can take a while for large accounts. Continue?"
  );
  if (!confirmed) {
    return;
  }
  chrome.runtime.sendMessage({ type: "force-full-inventory" }, (response) => {
    if (response && response.ok === false && response.error) {
      window.alert(response.error);
      return;
    }
    loadStatus();
    refreshIndex();
  });
});

document.getElementById("indexSearch").addEventListener("input", () => {
  scheduleFilterApply();
});

document.getElementById("indexStatus").addEventListener("change", () => {
  applyIndexFilters();
});

document.getElementById("indexSort").addEventListener("change", () => {
  applyIndexFilters();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.folderLabel) {
    return;
  }
  const value = changes.folderLabel.newValue || "No folder selected";
  document.getElementById("folderLabel").textContent = value;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.status) {
    return;
  }
  document.getElementById("status").textContent = formatStatus(changes.status.newValue);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.syncState) {
    return;
  }
  latestSyncState = changes.syncState.newValue || {};
  if (indexRenderTimer) {
    return;
  }
  indexRenderTimer = setTimeout(() => {
    indexRenderTimer = null;
    indexEntries = buildIndexEntries(latestSyncState || {});
    indexTotal = indexEntries.length;
    updateIndexMeta(latestSyncState || {}, indexEntries);
    applyIndexFilters();
  }, 500);
});

loadStatus();
refreshIndex();
