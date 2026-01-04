const DB_NAME = "chatgpt-local-sync";
const STORE_NAME = "handles";
const HANDLE_KEY = "root";
const PROGRESS_THROTTLE_MS = 500;
const MAX_PARTIAL_AGE_MS = 24 * 60 * 60 * 1000;

let cachedHandle = null;
let syncInProgress = false;
let lastProgressSentAt = 0;
let uiState = null;
let cachedAccessToken = null;
let cachedAccessTokenAt = 0;
let cachedGlobalStatus = null;
let folderAccessState = "unknown";

function escapeYaml(value) {
  return String(value).replace(/"/g, "\\\"").replace(/\n/g, " ");
}

function formatTimestamp(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString();
}

function formatCount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function toEpochSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getMaxKnownUpdateTime(knownConversations) {
  let maxTime = 0;
  if (!knownConversations) {
    return maxTime;
  }
  for (const value of Object.values(knownConversations)) {
    if (typeof value === "number" && value > maxTime) {
      maxTime = value;
    }
  }
  return maxTime;
}

function shouldForceFullInventory(options, knownConversations, lastFullInventoryAt) {
  if (!knownConversations || Object.keys(knownConversations).length === 0) {
    return true;
  }
  if (options && options.deleteRemoved) {
    return true;
  }
  if (!lastFullInventoryAt) {
    return true;
  }
  const lastFull = Date.parse(lastFullInventoryAt);
  if (!Number.isFinite(lastFull)) {
    return true;
  }
  return Date.now() - lastFull > MAX_PARTIAL_AGE_MS;
}

function getResumeOffset(inventoryCursor) {
  if (!inventoryCursor || !Number.isFinite(inventoryCursor.offset)) {
    return 0;
  }
  if (inventoryCursor.updatedAt) {
    const updatedAt = Date.parse(inventoryCursor.updatedAt);
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt > MAX_PARTIAL_AGE_MS) {
      return 0;
    }
  }
  return inventoryCursor.offset;
}

function clampParallelFetch(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return 3;
  }
  return Math.min(10, Math.max(1, parsed));
}

function getProgressTarget(processed, total, listComplete) {
  if (listComplete) {
    return total;
  }
  if (!total) {
    return processed ? processed + 1 : 0;
  }
  return Math.max(total, processed + 1);
}

async function runWithConcurrency(tasks, limit) {
  if (!tasks.length) {
    return;
  }
  const concurrency = Math.max(1, limit);
  let index = 0;
  const executing = new Set();

  const enqueue = async () => {
    while (index < tasks.length && executing.size < concurrency) {
      const taskPromise = tasks[index++]();
      executing.add(taskPromise);
      taskPromise.finally(() => executing.delete(taskPromise));
    }
    if (executing.size === 0) {
      return;
    }
    await Promise.race(executing);
    return enqueue();
  };

  await enqueue();
  await Promise.allSettled(executing);
}

function formatPart(part) {
  if (typeof part === "string") {
    return part;
  }
  if (part && typeof part === "object") {
    if (typeof part.text === "string") {
      return part.text;
    }
    if (typeof part.caption === "string") {
      return part.caption;
    }
    return JSON.stringify(part);
  }
  return String(part);
}

function renderContent(content) {
  if (!content) {
    return "";
  }
  if (Array.isArray(content.parts)) {
    return content.parts.map(formatPart).join("\n");
  }
  if (typeof content.text === "string") {
    return content.text;
  }
  return JSON.stringify(content);
}

function extractMessages(conversation) {
  const mapping = conversation.mapping || {};
  const messages = [];
  let nodeId = conversation.current_node;
  const nodes = [];

  while (nodeId) {
    const node = mapping[nodeId];
    if (!node) {
      break;
    }
    nodes.push(node);
    nodeId = node.parent;
  }

  nodes.reverse();

  for (const node of nodes) {
    const message = node.message;
    if (!message || !message.content) {
      continue;
    }
    const role = message.author && message.author.role ? message.author.role : "unknown";
    const content = renderContent(message.content).trim();
    if (!content) {
      continue;
    }

    messages.push({
      id: message.id || "",
      role,
      content,
      create_time: message.create_time || 0,
      update_time: message.update_time || 0,
      metadata: message.metadata || null
    });
  }

  return messages;
}

function toMarkdown(conversation, messages, overrideUpdateTime) {
  const conversationId = conversation.id || conversation.conversation_id || "";
  const title = conversation.title || "Untitled";
  const createTime = formatTimestamp(toEpochSeconds(conversation.create_time));
  const updateTimeSeconds = Number.isFinite(overrideUpdateTime)
    ? overrideUpdateTime
    : toEpochSeconds(conversation.update_time);
  const updateTime = formatTimestamp(updateTimeSeconds);
  const url = conversationId ? `https://chatgpt.com/c/${conversationId}` : "";

  let output = "---\n";
  output += `id: \"${escapeYaml(conversationId)}\"\n`;
  output += `title: \"${escapeYaml(title)}\"\n`;
  output += `create_time: \"${createTime}\"\n`;
  output += `update_time: \"${updateTime}\"\n`;
  output += `source: \"chatgpt.com\"\n`;
  if (url) {
    output += `url: \"${escapeYaml(url)}\"\n`;
  }
  output += "---\n\n";
  output += `# ${title}\n`;

  for (const message of messages) {
    const roleTitle = message.role ? message.role.toUpperCase() : "UNKNOWN";
    const timestamp = formatTimestamp(message.create_time);
    output += "\n";
    output += `## ${roleTitle}\n`;
    if (timestamp) {
      output += `${timestamp}\n\n`;
    } else {
      output += "\n";
    }
    output += `${message.content}\n`;
  }

  return output;
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now - cachedAccessTokenAt < 5 * 60 * 1000) {
    return cachedAccessToken;
  }

  try {
    const response = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
      headers: {
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const token = data && data.accessToken ? data.accessToken : null;
    if (token) {
      cachedAccessToken = token;
      cachedAccessTokenAt = now;
    }
    return token;
  } catch (err) {
    return null;
  }
}

async function fetchJson(url, accessToken) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let response;

  try {
    response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
      },
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

function normalizeConversationList(data) {
  if (!data || typeof data !== "object") {
    return { items: [], total: 0 };
  }
  const items =
    (Array.isArray(data.items) && data.items) ||
    (Array.isArray(data.conversations) && data.conversations) ||
    (Array.isArray(data.data) && data.data) ||
    [];
  const total = Number.isFinite(data.total) ? data.total : items.length;
  return { items, total };
}

async function fetchConversationPage(accessToken, offset, limit) {
  const limits = [limit, 100, 50].filter((value, index, self) => self.indexOf(value) === index);
  let lastError;

  for (const candidate of limits) {
    try {
      const data = await fetchJson(
        `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${candidate}&order=updated`,
        accessToken
      );
      const list = normalizeConversationList(data);
      const items = list.items || [];
      const total = Number.isFinite(data.total) ? data.total : items.length;
      const hasMoreFlag = typeof data.has_more === "boolean" ? data.has_more : null;
      let pageMinUpdate = 0;
      for (const item of items) {
        const itemUpdate = toEpochSeconds(item.update_time) || toEpochSeconds(item.create_time);
        if (!pageMinUpdate || itemUpdate < pageMinUpdate) {
          pageMinUpdate = itemUpdate;
        }
      }
      const hasMore =
        typeof hasMoreFlag === "boolean"
          ? hasMoreFlag
          : Number.isFinite(total)
            ? offset + items.length < total
            : items.length >= candidate;

      return {
        items,
        total,
        hasMore,
        limit: candidate,
        pageMinUpdate
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Failed to fetch conversations");
}

async function fetchConversation(id, accessToken) {
  return fetchJson(`https://chatgpt.com/backend-api/conversation/${id}`, accessToken);
}

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStoredHandle() {
  if (cachedHandle) {
    return cachedHandle;
  }

  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(HANDLE_KEY);
    request.onsuccess = () => {
      cachedHandle = request.result || null;
      resolve(cachedHandle);
    };
    request.onerror = () => reject(request.error);
  });
}

async function setStoredHandle(handle) {
  const db = await openHandleDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(handle, HANDLE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  cachedHandle = handle;
  await chrome.storage.local.set({ folderLabel: handle.name || "Selected folder" });
}

async function ensureHandle() {
  const handle = await getStoredHandle();
  if (!handle) {
    const error = new Error("No folder selected");
    error.code = "no-folder";
    throw error;
  }
  const permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    const error = new Error("Folder permission required");
    error.code = "permission";
    throw error;
  }
  return handle;
}

async function ensureHandleWithPrompt() {
  let handle = await getStoredHandle();
  if (!handle) {
    if (typeof window.showDirectoryPicker !== "function") {
      const error = new Error("File system access is not available in this browser.");
      error.code = "no-fsa";
      throw error;
    }
    handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await setStoredHandle(handle);
  }

  let permission = "prompt";
  if (typeof handle.queryPermission === "function") {
    permission = await handle.queryPermission({ mode: "readwrite" });
  }
  if (permission !== "granted" && typeof handle.requestPermission === "function") {
    permission = await handle.requestPermission({ mode: "readwrite" });
  }

  if (permission !== "granted") {
    const error = new Error("Folder permission denied");
    error.code = "permission";
    throw error;
  }

  return handle;
}

async function refreshFolderStatus() {
  try {
    const handle = await getStoredHandle();
    if (!handle) {
      folderAccessState = "no-folder";
      updateFolderLabel("No folder selected");
      updateStatus("Select a folder to sync.");
      updateProgress(0, 0, false);
      return;
    }
    const label = handle.name || "Selected folder";
    updateFolderLabel(label);
    chrome.storage.local.set({ folderLabel: label });
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      folderAccessState = "permission";
      updateStatus("Folder access required.");
      updateProgress(0, 0, false);
    } else {
      folderAccessState = "ok";
      applyGlobalStatus(cachedGlobalStatus);
    }
  } catch (err) {
    folderAccessState = "unavailable";
    updateStatus("Folder status unavailable.");
    updateProgress(0, 0, false);
  }
}

async function writeFile(rootHandle, relativePath, content) {
  const parts = relativePath.split("/").filter(Boolean);
  let dir = rootHandle;

  for (let i = 0; i < parts.length - 1; i += 1) {
    dir = await dir.getDirectoryHandle(parts[i], { create: true });
  }

  const fileName = parts[parts.length - 1];
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function deleteFile(rootHandle, relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  let dir = rootHandle;

  for (let i = 0; i < parts.length - 1; i += 1) {
    try {
      dir = await dir.getDirectoryHandle(parts[i], { create: false });
    } catch (err) {
      if (err && err.name === "NotFoundError") {
        return;
      }
      throw err;
    }
  }

  const fileName = parts[parts.length - 1];
  try {
    await dir.removeEntry(fileName);
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      return;
    }
    throw err;
  }
}

async function writeConversation(rootHandle, options, conversation, messages, markdown, updateTimeOverride) {
  const id = conversation.id || conversation.conversation_id;
  if (!id) {
    throw new Error("Missing conversation id");
  }
  const createTimeSeconds = toEpochSeconds(conversation.create_time);
  const conversationUpdateSeconds = toEpochSeconds(conversation.update_time);
  const updateTimeSeconds = Number.isFinite(updateTimeOverride)
    ? updateTimeOverride
    : conversationUpdateSeconds;
  const meta = {
    id,
    title: conversation.title || "",
    create_time: createTimeSeconds,
    update_time: updateTimeSeconds,
    url: `https://chatgpt.com/c/${id}`,
    source: "chatgpt.com"
  };

  if (options.includeJson) {
    const payload = {
      meta,
      messages,
      raw: conversation
    };
    await writeFile(rootHandle, `conversations/${id}.json`, JSON.stringify(payload, null, 2));
  }

  if (options.includeMarkdown && markdown) {
    await writeFile(rootHandle, `conversations/${id}.md`, markdown);
  }
}

async function deleteConversation(rootHandle, options, id) {
  if (options.includeJson) {
    await deleteFile(rootHandle, `conversations/${id}.json`);
  }
  if (options.includeMarkdown) {
    await deleteFile(rootHandle, `conversations/${id}.md`);
  }
}

async function writeIndex(rootHandle, indexSource) {
  const entries = Array.isArray(indexSource)
    ? indexSource
    : indexSource instanceof Map
      ? Array.from(indexSource.values())
      : Object.values(indexSource || {});
  entries.sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
  const payload = {
    generated_at: new Date().toISOString(),
    count: entries.length,
    conversations: entries
  };
  await writeFile(rootHandle, "index.json", JSON.stringify(payload, null, 2));
}

async function readIndex(rootHandle) {
  try {
    const fileHandle = await rootHandle.getFileHandle("index.json", { create: false });
    const file = await fileHandle.getFile();
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload || !Array.isArray(payload.conversations)) {
      return null;
    }
    const conversations = {};
    const meta = {};
    for (const entry of payload.conversations) {
      if (!entry || !entry.id) {
        continue;
      }
      const parsedUpdate = Number.parseFloat(entry.update_time);
      const updateTime = Number.isFinite(parsedUpdate) ? parsedUpdate : 0;
      const parsedCreate = Number.parseFloat(entry.create_time);
      const createTime = Number.isFinite(parsedCreate) ? parsedCreate : 0;
      conversations[entry.id] = updateTime;
      meta[entry.id] = {
        id: entry.id,
        title: entry.title || "",
        create_time: createTime,
        update_time: updateTime
      };
    }
    return { conversations, meta };
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      return null;
    }
    return null;
  }
}

function mergeKnownState(knownConversations, knownMeta, indexState) {
  const mergedConversations = { ...(knownConversations || {}) };
  const mergedMeta = { ...(knownMeta || {}) };

  if (!indexState) {
    return { conversations: mergedConversations, meta: mergedMeta };
  }

  const indexConversations = indexState.conversations || {};
  const indexMeta = indexState.meta || {};

  for (const [id, updateTime] of Object.entries(indexConversations)) {
    const existing = mergedConversations[id] || 0;
    mergedConversations[id] = Math.max(existing, updateTime || 0);
  }

  for (const [id, meta] of Object.entries(indexMeta)) {
    if (!meta || !id) {
      continue;
    }
    const current = mergedMeta[id];
    if (!current) {
      mergedMeta[id] = meta;
      continue;
    }
    const currentTime = current.update_time || 0;
    const nextTime = meta.update_time || 0;
    if (nextTime >= currentTime) {
      mergedMeta[id] = {
        ...current,
        ...meta,
        update_time: Math.max(currentTime, nextTime)
      };
    }
  }

  return { conversations: mergedConversations, meta: mergedMeta };
}

function updateStatus(text) {
  if (!uiState) {
    return;
  }
  uiState.status.textContent = text;
}

function updateFolderLabel(label) {
  if (!uiState) {
    return;
  }
  uiState.folder.textContent = label;
}

function isGlobalSyncing(status) {
  if (!status) {
    return false;
  }
  if (status.progress && status.progress.total) {
    return true;
  }
  const startedAt = status.lastSyncStartedAt ? Date.parse(status.lastSyncStartedAt) : NaN;
  if (!Number.isFinite(startedAt)) {
    return false;
  }
  const finishedAt = status.lastSyncFinishedAt ? Date.parse(status.lastSyncFinishedAt) : NaN;
  return !Number.isFinite(finishedAt) || finishedAt < startedAt;
}

function setIndicator(state, title) {
  if (!uiState || !uiState.indicator) {
    return;
  }
  uiState.indicator.classList.remove("idle", "ok", "error", "syncing");
  uiState.indicator.classList.add(state);
  uiState.indicator.title = title;
}

function applyGlobalStatus(status) {
  cachedGlobalStatus = status || null;
  const syncing = syncInProgress || isGlobalSyncing(status);
  if (syncing) {
    const progress = status && status.progress ? status.progress : null;
    const title = progress && progress.total
      ? `Syncing: ${formatCount(progress.processed || 0)} / ${formatCount(progress.total)}`
      : "Syncing";
    setIndicator("syncing", title);
  } else if (status && status.lastError) {
    setIndicator("error", status.lastError);
  } else if (status && status.lastSyncFinishedAt) {
    setIndicator("ok", `Synced: ${status.lastSyncFinishedAt}`);
  } else {
    setIndicator("idle", "Idle");
  }

  if (syncInProgress || !uiState) {
    return;
  }
  if (folderAccessState !== "ok") {
    return;
  }

  if (syncing) {
    const progress = status && status.progress ? status.progress : null;
    updateStatus(progress && progress.status ? progress.status : "Syncing...");
    if (progress && progress.total) {
      updateProgress(progress.processed || 0, progress.total || 0, true);
    }
    return;
  }

  if (status && status.lastError) {
    updateStatus(`Error: ${status.lastError}`);
  } else if (status && status.lastSyncSummary) {
    const summary = status.lastSyncSummary;
    updateStatus(
      `Last sync: ${summary.updated || 0} updated, ${summary.skipped || 0} unchanged, ${summary.errors || 0} errors.`
    );
  } else {
    updateStatus("Idle");
  }
  updateProgress(0, 0, false);
}

function isExpanded() {
  return !!(uiState && uiState.container && uiState.container.dataset.expanded === "true");
}

function setExpanded(expanded, persist) {
  if (!uiState) {
    return;
  }
  uiState.container.dataset.expanded = expanded ? "true" : "false";
  if (uiState.toggle) {
    uiState.toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  }
  if (persist) {
    try {
      chrome.storage.local.set({ widgetExpanded: expanded });
    } catch (err) {
      // Ignore storage errors.
    }
  }
}

function updateProgress(processed, total, allowComplete) {
  if (!uiState) {
    return;
  }
  if (!total) {
    uiState.progressFill.style.width = "0%";
    uiState.progressText.textContent = "";
    return;
  }
  const percent = Math.floor((processed / total) * 100);
  const clamped = allowComplete ? Math.min(100, percent) : Math.min(99, percent);
  uiState.progressFill.style.width = `${clamped}%`;
  uiState.progressText.textContent = `${formatCount(processed)} / ${formatCount(total)}`;
}

function setSyncing(isSyncing) {
  syncInProgress = isSyncing;
  if (!uiState) {
    return;
  }
  uiState.syncButton.disabled = isSyncing;
  uiState.container.dataset.syncing = isSyncing ? "true" : "false";
  applyGlobalStatus(cachedGlobalStatus);
}

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch (err) {
    // Ignore if the port is already disconnected.
  }
}

function maybeSendProgress(port, processed, total, cursor, force) {
  const now = Date.now();
  if (!force && now - lastProgressSentAt < PROGRESS_THROTTLE_MS) {
    return;
  }
  lastProgressSentAt = now;
  safePost(port, {
    type: "sync-progress",
    processed,
    total,
    status: "Syncing",
    ...(cursor ? { cursor } : {})
  });
}

async function runSync(
  port,
  options,
  knownConversations,
  knownMeta,
  lastFullInventoryAt,
  inventoryCursor
) {
  if (syncInProgress) {
    updateStatus("Sync already in progress.");
    safePost(port, { type: "sync-error", error: "Sync already in progress." });
    return;
  }

  setSyncing(true);
  updateStatus("Starting sync...");
  updateProgress(0, 0);

  let rootHandle;
  try {
    rootHandle = await ensureHandle();
  } catch (err) {
    if (err.code === "no-folder") {
      updateStatus("Select a folder to sync.");
      safePost(port, { type: "sync-requires-folder" });
    } else {
      updateStatus("Grant folder access to sync.");
      safePost(port, { type: "sync-permission-required" });
    }
    setSyncing(false);
    return;
  }

  try {
    const indexState = await readIndex(rootHandle);
    if (indexState) {
      const merged = mergeKnownState(knownConversations, knownMeta, indexState);
      knownConversations = merged.conversations;
      knownMeta = merged.meta;
    }

    const accessToken = await getAccessToken();
    const forceFullInventory = shouldForceFullInventory(
      options,
      knownConversations,
      lastFullInventoryAt
    );
    const resumeOffset = forceFullInventory ? getResumeOffset(inventoryCursor) : 0;
    const stopAfterTime = forceFullInventory ? null : getMaxKnownUpdateTime(knownConversations);
    updateStatus("Loading conversations...");
    safePost(port, {
      type: "sync-mode",
      fullInventory: forceFullInventory,
      resumeOffset,
      limit: 100
    });
    let processed = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let didFullInventory = forceFullInventory;
    let listedCount = 0;
    let totalHint = 0;
    let offset = resumeOffset;
    let limit = 100;
    let pageCount = 0;
    const maxPages = 200;
    let listComplete = false;

    const metaMap = { ...(knownMeta || {}) };
    const currentIds = new Set();
    const parallelLimit = clampParallelFetch(options.maxParallelFetch);
    const progressTotal = () => Math.max(totalHint || 0, listedCount || 0);

    updateProgress(0, 0, false);
    maybeSendProgress(port, 0, 0);

    const pageStates = [];
    let nextCursorIndex = 0;
    const queue = [];
    const queueWaiters = [];
    let listingDone = false;
    let pendingFetches = 0;

    const maybeAdvanceCursor = () => {
      if (!forceFullInventory) {
        return;
      }
      while (pageStates[nextCursorIndex] && pageStates[nextCursorIndex].done) {
        const state = pageStates[nextCursorIndex];
        const target = getProgressTarget(processed, progressTotal(), listComplete);
        maybeSendProgress(
          port,
          processed,
          target,
          { offset: state.nextOffset, limit: state.limit },
          true
        );
        nextCursorIndex += 1;
      }
    };

    const markPageItemDone = (pageIndex) => {
      const state = pageStates[pageIndex];
      if (!state || state.done) {
        return;
      }
      state.remaining -= 1;
      if (state.remaining <= 0) {
        state.done = true;
        maybeAdvanceCursor();
      }
    };

    const enqueueItem = (item, pageIndex) => {
      const payload = { item, pageIndex };
      pendingFetches += 1;
      if (queueWaiters.length) {
        const resolve = queueWaiters.shift();
        resolve(payload);
      } else {
        queue.push(payload);
      }
    };

    const dequeueItem = () => {
      if (queue.length) {
        return Promise.resolve(queue.shift());
      }
      if (listingDone) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => queueWaiters.push(resolve));
    };

    const processItem = async (item, pageIndex) => {
      const id = item.id;
      const updateTime = toEpochSeconds(item.update_time) || toEpochSeconds(item.create_time);
      try {
        const conversation = await fetchConversation(id, accessToken);
        const messages = extractMessages(conversation);
        const conversationUpdate = toEpochSeconds(conversation && conversation.update_time);
        const metaUpdateTime = Math.max(updateTime, conversationUpdate);
        const markdown = options.includeMarkdown ? toMarkdown(conversation, messages, metaUpdateTime) : "";
        const createTimeSeconds =
          toEpochSeconds(conversation.create_time) || toEpochSeconds(item.create_time);
        metaMap[id] = {
          id,
          title: conversation.title || item.title || "",
          create_time: createTimeSeconds,
          update_time: metaUpdateTime
        };

        await writeConversation(rootHandle, options, conversation, messages, markdown, metaUpdateTime);

        safePost(port, {
          type: "conversation",
          id,
          title: conversation.title || item.title || "",
          create_time: createTimeSeconds,
          update_time: metaUpdateTime
        });
        updatedCount += 1;
      } catch (err) {
        errorCount += 1;
        safePost(port, {
          type: "conversation-error",
          id,
          error: err.message
        });
      } finally {
        pendingFetches = Math.max(0, pendingFetches - 1);
        processed += 1;
        const target = getProgressTarget(processed, progressTotal(), listComplete);
        updateProgress(processed, target, listComplete);
        maybeSendProgress(port, processed, target);
        markPageItemDone(pageIndex);
      }
    };

    const workers = Array.from({ length: parallelLimit }, async () => {
      for (;;) {
        const payload = await dequeueItem();
        if (!payload) {
          return;
        }
        await processItem(payload.item, payload.pageIndex);
      }
    });

    let pagePromise = fetchConversationPage(accessToken, offset, limit);

    while (pagePromise) {
      const page = await pagePromise;
      limit = page.limit;
      const items = page.items || [];
      if (!items.length) {
        if (!listedCount) {
          updateStatus("No conversations returned. Check login and chat history.");
          didFullInventory = false;
        }
        break;
      }

      listedCount += items.length;
      if (Number.isFinite(page.total) && page.total > totalHint) {
        totalHint = page.total;
      }
      updateStatus("Loading conversations...");
      const target = getProgressTarget(processed, progressTotal(), listComplete);
      updateProgress(processed, target, listComplete);
      maybeSendProgress(port, processed, target);

      const pageIndex = pageCount;
      pageCount += 1;
      if (pageCount > maxPages) {
        didFullInventory = false;
        break;
      }

      const nextOffset = offset + items.length;
      pageStates[pageIndex] = {
        remaining: items.length,
        nextOffset,
        limit,
        done: false
      };
      const stopForTime = stopAfterTime && page.pageMinUpdate && page.pageMinUpdate <= stopAfterTime;
      if (stopForTime) {
        didFullInventory = false;
      }

      const shouldContinue =
        !stopForTime && (page.hasMore || items.length >= limit);
      const nextPagePromise = shouldContinue
        ? fetchConversationPage(accessToken, nextOffset, limit)
        : null;

      for (const item of items) {
        const id = item.id;
        const updateTime = toEpochSeconds(item.update_time) || toEpochSeconds(item.create_time);
        const knownTime = Number.isFinite(knownConversations[id]) ? knownConversations[id] : 0;

        currentIds.add(id);
        const createTimeSeconds =
          toEpochSeconds(item.create_time) ||
          (metaMap[id] ? toEpochSeconds(metaMap[id].create_time) : 0);
        const existingMetaUpdate = metaMap[id] ? toEpochSeconds(metaMap[id].update_time) : 0;
        const mergedUpdateTime = Math.max(updateTime, knownTime, existingMetaUpdate);
        metaMap[id] = {
          id,
          title: item.title || (metaMap[id] && metaMap[id].title) || "",
          create_time: createTimeSeconds,
          update_time: mergedUpdateTime
        };

        if (updateTime <= knownTime) {
          processed += 1;
          skippedCount += 1;
          const target = getProgressTarget(processed, progressTotal(), listComplete);
          updateProgress(processed, target, listComplete);
          maybeSendProgress(port, processed, target);
          safePost(port, {
            type: "conversation-skip",
            id,
            title: item.title || "",
            create_time: createTimeSeconds,
            update_time: mergedUpdateTime
          });
          markPageItemDone(pageIndex);
          continue;
        }

        enqueueItem(item, pageIndex);
      }

      offset = nextOffset;
      pagePromise = nextPagePromise;
      if (!pagePromise) {
        break;
      }
    }
    listComplete = true;
    listingDone = true;
    if (pendingFetches > 0) {
      updateStatus("Writing conversations...");
    }
    while (queueWaiters.length) {
      const resolve = queueWaiters.shift();
      resolve(null);
    }

    await Promise.all(workers);

    if (didFullInventory) {
      const removed = Object.keys(metaMap).filter((id) => !currentIds.has(id));
      for (const id of removed) {
        delete metaMap[id];
        if (options.deleteRemoved) {
          try {
            await deleteConversation(rootHandle, options, id);
          } catch (err) {
            errorCount += 1;
          }
        }
      }
    } else if (options.deleteRemoved) {
      updateStatus("Skipping deletions until full inventory.");
    }

    await writeIndex(rootHandle, metaMap);

    const finalTotal = didFullInventory ? progressTotal() || processed : processed;
    updateProgress(finalTotal, finalTotal, true);
    updateStatus(`Sync complete: ${updatedCount} updated, ${skippedCount} unchanged.`);

    safePost(port, {
      type: "sync-complete",
      total: finalTotal,
      updated: updatedCount,
      skipped: skippedCount,
      errors: errorCount,
      fullInventory: didFullInventory,
      inventoryCount: Object.keys(metaMap).length
    });
  } catch (err) {
    updateStatus(`Sync failed: ${err.message}`);
    safePost(port, { type: "sync-error", error: err.message });
  } finally {
    setSyncing(false);
  }
}

function isSidebarCandidate(element) {
  if (!element) {
    return false;
  }
  if (element.querySelector('[data-testid="chat-history"]')) {
    return true;
  }
  if (element.querySelector('a[href^="/c/"]')) {
    return true;
  }
  if (element.querySelector('a[href^="https://chatgpt.com/c/"]')) {
    return true;
  }
  return false;
}

function findSidebarRoot() {
  const selectors = [
    '[data-testid="sidebar"]',
    '[data-testid="chat-history"]',
    'nav[aria-label="Chat history"]',
    'nav[role="navigation"]',
    'aside',
    'nav'
  ];

  for (const selector of selectors) {
    const candidate = document.querySelector(selector);
    if (isSidebarCandidate(candidate)) {
      return candidate;
    }
  }

  const navs = Array.from(document.querySelectorAll('nav'));
  for (const nav of navs) {
    if (isSidebarCandidate(nav)) {
      return nav;
    }
  }

  return null;
}

function findSidebarAnchor(sidebar) {
  if (!sidebar) {
    return null;
  }
  const selectors = [
    '[data-testid="accounts-profile-button"]',
    '[data-testid="user-menu"]',
    '[data-testid="profile-button"]',
    'button[aria-label*="account" i]',
    'button[aria-label*="profile" i]',
    'button[aria-label*="user" i]'
  ];
  for (const selector of selectors) {
    const anchor = sidebar.querySelector(selector);
    if (anchor) {
      return anchor;
    }
  }
  return null;
}

function findAccountButton(sidebar) {
  if (!sidebar) {
    return null;
  }
  return sidebar.querySelector('[data-testid="accounts-profile-button"]');
}

function findInsertParent(anchor, sidebar) {
  let parent = anchor.parentElement;
  while (parent && parent !== sidebar && isScrollable(parent)) {
    parent = parent.parentElement;
  }
  return parent || anchor.parentElement;
}

function findInsertAfter(anchor, insertParent) {
  let node = anchor;
  while (node && node.parentElement && node.parentElement !== insertParent) {
    node = node.parentElement;
  }
  return node;
}

function isScrollable(element) {
  if (!element) {
    return false;
  }
  const style = window.getComputedStyle(element);
  const overflowY = style.overflowY || style.overflow;
  if (overflowY !== "auto" && overflowY !== "scroll") {
    return false;
  }
  return element.scrollHeight > element.clientHeight + 4;
}

function findScrollableList(sidebar) {
  if (!sidebar) {
    return null;
  }
  const elements = Array.from(sidebar.querySelectorAll("*"));
  for (const element of elements) {
    if (!isScrollable(element)) {
      continue;
    }
    if (
      element.querySelector('a[href^="/c/"]') ||
      element.querySelector('a[href^="https://chatgpt.com/c/"]') ||
      element.querySelector('[data-testid="chat-history"]')
    ) {
      return element;
    }
  }
  return elements.find((element) => isScrollable(element)) || null;
}

function mountUi() {
  if (!uiState) {
    return false;
  }
  const sidebar = findSidebarRoot();
  if (!sidebar) {
    uiState.container.style.display = "none";
    return false;
  }
  const accountButton = findAccountButton(sidebar);
  const anchor = accountButton || findSidebarAnchor(sidebar);
  const scrollable = findScrollableList(sidebar);
  uiState.container.style.display = "block";
  uiState.container.dataset.location = "sidebar";
  uiState.container.style.margin = "8px 0 12px";
  uiState.container.style.padding = "0 12px";
  uiState.container.style.position = "relative";

  if (anchor) {
    const insertParent = findInsertParent(anchor, sidebar);
    if (insertParent) {
      const insertAfter = findInsertAfter(anchor, insertParent);
      insertParent.insertBefore(uiState.container, insertAfter.nextSibling);
      return true;
    }
  }

  if (scrollable && scrollable.parentElement) {
    sidebar.insertBefore(uiState.container, scrollable);
    return true;
  }
  sidebar.appendChild(uiState.container);
  return true;
}

function createUi() {
  if (uiState) {
    return;
  }

  const container = document.createElement("div");
  container.id = "chatgpt-sync-widget";
  container.style.display = "none";
  container.style.width = "100%";
  container.style.boxSizing = "border-box";
  container.dataset.expanded = "false";

  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        display: block;
        width: 100%;
        box-sizing: border-box;
      }
      :host([data-expanded="false"]) .details {
        display: none;
      }
      .panel {
        width: 100%;
        background: #121212;
        color: #f5f5f5;
        border-radius: 12px;
        padding: 10px;
        border: 1px solid #2b2b2b;
        box-shadow: none;
        display: grid;
        gap: 10px;
        box-sizing: border-box;
      }
      .title {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.2px;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        cursor: pointer;
        user-select: none;
      }
      .header:focus-visible {
        outline: 2px solid rgba(247, 183, 51, 0.9);
        outline-offset: 3px;
        border-radius: 10px;
      }
      .header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .indicator {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: #5c5c5c;
        flex: 0 0 auto;
        box-sizing: border-box;
      }
      .indicator.ok {
        background: #3ddc84;
      }
      .indicator.error {
        background: #ff4d4f;
      }
      .indicator.syncing {
        background: transparent;
        border: 2px solid #f7b733;
        border-right-color: transparent;
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .icon {
        border: none;
        background: transparent;
        color: #bdbdbd;
        cursor: pointer;
        padding: 2px;
        display: grid;
        place-items: center;
      }
      .icon svg {
        width: 16px;
        height: 16px;
      }
      .icon:hover {
        color: #f5f5f5;
      }
      .folder {
        font-size: 11px;
        color: #bdbdbd;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .folder-prefix {
        font-size: 10px;
        color: #7d7d7d;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-right: 6px;
      }
      .status {
        font-size: 11px;
        color: #e0e0e0;
        min-height: 16px;
      }
      .bar {
        background: #262626;
        border-radius: 999px;
        height: 6px;
        overflow: hidden;
      }
      .bar-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #ff6b35, #f7b733);
        transition: width 0.2s ease;
      }
      .progress-text {
        font-size: 10px;
        color: #9e9e9e;
      }
      .details {
        display: grid;
        gap: 10px;
      }
      .actions {
        display: grid;
        gap: 6px;
      }
      button {
        border: none;
        border-radius: 8px;
        padding: 6px 8px;
        font-size: 11px;
        cursor: pointer;
        background: #f5f5f5;
        color: #111;
      }
      button.secondary {
        background: #2a2a2a;
        color: #f5f5f5;
      }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    </style>
    <div class="panel">
      <div class="header" id="toggle" role="button" tabindex="0" aria-expanded="false">
        <div class="title">ChatGPT Local Sync</div>
        <div class="header-actions">
          <span class="indicator idle" id="indicator" aria-label="Sync status" title="Idle"></span>
          <button class="icon" id="options" aria-label="Open options" title="Open options">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Zm9.4 2.4-.9-.3a7.7 7.7 0 0 0-.6-1.5l.5-.8a1 1 0 0 0-.1-1.3l-1.6-1.6a1 1 0 0 0-1.3-.1l-.8.5a7.7 7.7 0 0 0-1.5-.6l-.3-.9a1 1 0 0 0-1-.7h-2.2a1 1 0 0 0-1 .7l-.3.9a7.7 7.7 0 0 0-1.5.6l-.8-.5a1 1 0 0 0-1.3.1L3.6 7.4a1 1 0 0 0-.1 1.3l.5.8a7.7 7.7 0 0 0-.6 1.5l-.9.3a1 1 0 0 0-.7 1v2.2c0 .4.3.8.7 1l.9.3a7.7 7.7 0 0 0 .6 1.5l-.5.8a1 1 0 0 0 .1 1.3l1.6 1.6a1 1 0 0 0 1.3.1l.8-.5a7.7 7.7 0 0 0 1.5.6l.3.9a1 1 0 0 0 1 .7h2.2a1 1 0 0 0 1-.7l.3-.9a7.7 7.7 0 0 0 1.5-.6l.8.5a1 1 0 0 0 1.3-.1l1.6-1.6a1 1 0 0 0 .1-1.3l-.5-.8a7.7 7.7 0 0 0 .6-1.5l.9-.3a1 1 0 0 0 .7-1v-2.2a1 1 0 0 0-.7-1Z" fill="currentColor"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="details">
        <div class="folder"><span class="folder-prefix">Folder</span><span id="folder">No folder selected</span></div>
        <div class="status" id="status">Idle</div>
        <div class="bar"><div class="bar-fill" id="bar"></div></div>
        <div class="progress-text" id="progress"></div>
        <div class="actions">
          <button id="sync">Sync now</button>
        </div>
      </div>
    </div>
  `;

  document.documentElement.appendChild(container);

  uiState = {
    container,
    status: shadow.getElementById("status"),
    folder: shadow.getElementById("folder"),
    progressFill: shadow.getElementById("bar"),
    progressText: shadow.getElementById("progress"),
    syncButton: shadow.getElementById("sync"),
    optionsButton: shadow.getElementById("options"),
    toggle: shadow.getElementById("toggle"),
    indicator: shadow.getElementById("indicator")
  };

  if (uiState.toggle) {
    const toggle = () => {
      setExpanded(!isExpanded(), true);
    };
    uiState.toggle.addEventListener("click", toggle);
    uiState.toggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  }

  uiState.syncButton.addEventListener("click", () => {
    updateStatus("Sync requested...");
    updateProgress(0, 0);
    ensureHandleWithPrompt()
      .then(() => {
        refreshFolderStatus();
        chrome.runtime.sendMessage({ type: "sync-now" }, () => {
          if (chrome.runtime.lastError) {
            updateStatus("Unable to reach the extension background.");
          }
        });
      })
      .catch((err) => {
        if (err && err.code === "no-fsa") {
          updateStatus(err.message);
        } else if (err && err.name === "AbortError") {
          updateStatus("Folder selection cancelled.");
        } else if (err && err.code === "permission") {
          updateStatus("Folder access denied.");
        } else {
          updateStatus("Unable to access the folder.");
        }
      });
  });

  uiState.optionsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    chrome.runtime.sendMessage({ type: "open-options" });
  });

  chrome.storage.local.get(["folderLabel", "widgetExpanded", "status"], (result) => {
    setExpanded(result && result.widgetExpanded === true, false);
    if (result && result.folderLabel) {
      updateFolderLabel(result.folderLabel);
    }
    if (result && result.status) {
      applyGlobalStatus(result.status);
    } else {
      applyGlobalStatus(null);
    }
  });

  mountUi();

  const observer = new MutationObserver(() => {
    if (!uiState.container.isConnected || uiState.container.style.display === "none") {
      mountUi();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

createUi();
refreshFolderStatus();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (changes.folderLabel) {
    updateFolderLabel(changes.folderLabel.newValue || "No folder selected");
  }
  if (changes.widgetExpanded) {
    setExpanded(changes.widgetExpanded.newValue === true, false);
  }
  if (changes.status) {
    applyGlobalStatus(changes.status.newValue || null);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sync") {
    return;
  }

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "start-sync") {
      return;
    }

    const options = msg.options || {};
    const knownConversations = msg.knownConversations || {};
    const knownMeta = msg.knownMeta || {};
    const lastFullInventoryAt = msg.lastFullInventoryAt || null;
    const inventoryCursor = msg.inventoryCursor || null;
    runSync(port, options, knownConversations, knownMeta, lastFullInventoryAt, inventoryCursor);
  });
});
