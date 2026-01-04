const DEFAULT_OPTIONS = {
  syncIntervalMinutes: 10,
  includeMarkdown: true,
  includeJson: true,
  deleteRemoved: false,
  maxParallelFetch: 3
};

const STORAGE_KEYS = {
  options: "options",
  status: "status",
  syncState: "syncState"
};

const SYNC_ALARM = "chatgpt-sync-alarm";

let syncInProgress = false;

function nowIso() {
  return new Date().toISOString();
}

async function getFromStorage(key, fallback) {
  const result = await chrome.storage.local.get(key);
  if (result && Object.prototype.hasOwnProperty.call(result, key)) {
    return result[key];
  }
  return fallback;
}

async function setInStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function getOptions() {
  const stored = await getFromStorage(STORAGE_KEYS.options, {});
  return normalizeOptions({ ...DEFAULT_OPTIONS, ...stored });
}

function normalizeOptions(options) {
  const minutes = Number.parseInt(options.syncIntervalMinutes, 10);
  const syncIntervalMinutes =
    Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_OPTIONS.syncIntervalMinutes;
  const parallelRaw = Number.parseInt(options.maxParallelFetch, 10);
  const maxParallelFetch = Number.isFinite(parallelRaw)
    ? Math.min(10, Math.max(1, parallelRaw))
    : DEFAULT_OPTIONS.maxParallelFetch;
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    syncIntervalMinutes,
    maxParallelFetch,
    includeJson: options.includeJson !== false,
    includeMarkdown: options.includeMarkdown !== false,
    deleteRemoved: options.deleteRemoved === true
  };
}

async function setStatus(partial) {
  const current = await getFromStorage(STORAGE_KEYS.status, {});
  await setInStorage(STORAGE_KEYS.status, { ...current, ...partial });
}

async function getSyncState() {
  return await getFromStorage(STORAGE_KEYS.syncState, {
    conversations: {},
    meta: {},
    lastRun: {},
    lastFullInventoryAt: null,
    inventoryCursor: null,
    inventoryInProgress: false
  });
}

async function setSyncState(state) {
  try {
    await setInStorage(STORAGE_KEYS.syncState, state);
  } catch (err) {
    console.warn("Failed to persist full sync state, retrying with a smaller payload.");
    const slim = {
      conversations: state.conversations || {},
      meta: {},
      lastRun: {},
      lastFullInventoryAt: state.lastFullInventoryAt || null,
      inventoryCursor: state.inventoryCursor || null,
      inventoryInProgress: state.inventoryInProgress === true
    };
    try {
      await setInStorage(STORAGE_KEYS.syncState, slim);
    } catch (inner) {
      console.warn("Failed to persist slim sync state.");
    }
  }
}

async function ensureDefaults() {
  const options = await getFromStorage(STORAGE_KEYS.options, null);
  if (!options) {
    await setInStorage(STORAGE_KEYS.options, { ...DEFAULT_OPTIONS });
  }
}

function scheduleSync(minutes) {
  chrome.alarms.clear(SYNC_ALARM, () => {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: minutes });
  });
}

async function runSync(reason, preferredTabId) {
  if (syncInProgress) {
    return;
  }
  syncInProgress = true;

  const options = await getOptions();
  await setStatus({
    lastSyncStartedAt: nowIso(),
    lastSyncReason: reason,
    lastError: null,
    progress: null
  });

  try {
    let tabId = null;
    if (preferredTabId) {
      try {
        const tab = await chrome.tabs.get(preferredTabId);
        if (tab && typeof tab.url === "string" && tab.url.startsWith("https://chatgpt.com/")) {
          tabId = tab.id;
        }
      } catch (err) {
        tabId = null;
      }
    }

    if (!tabId) {
      const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
      if (tabs.length) {
        tabId = tabs[0].id;
      }
    }

    if (!tabId) {
      await setStatus({
        lastError: "No ChatGPT tab open",
        lastSyncFinishedAt: nowIso(),
        progress: null
      });
      return;
    }
    const syncState = await getSyncState();
    const knownConversations = syncState.conversations || {};
    const knownMeta = syncState.meta || {};
    const knownRun = syncState.lastRun || {};
    const lastFullInventoryAt = syncState.lastFullInventoryAt || null;
    const inventoryCursor = syncState.inventoryCursor || null;

    const indexMap = new Map();
    const nextState = {
      conversations: { ...knownConversations },
      meta: { ...knownMeta },
      lastRun: { ...knownRun },
      lastFullInventoryAt,
      inventoryCursor,
      inventoryInProgress: syncState.inventoryInProgress === true
    };
    const currentIds = new Set();
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let totalCount = 0;

    const syncPromise = new Promise((resolve, reject) => {
      const port = chrome.tabs.connect(tabId, { name: "sync" });
      let fullInventoryMode = false;
      let checkpointCount = 0;
      let lastCheckpointAt = Date.now();
      const CHECKPOINT_MIN_MESSAGES = 50;
      const CHECKPOINT_MIN_MS = 15000;

      const maybeCheckpoint = (force) => {
        const now = Date.now();
        if (
          !force &&
          checkpointCount < CHECKPOINT_MIN_MESSAGES &&
          now - lastCheckpointAt < CHECKPOINT_MIN_MS
        ) {
          return;
        }
        checkpointCount = 0;
        lastCheckpointAt = now;
        setSyncState({ ...nextState }).catch(() => {});
      };

      const timeout = setTimeout(() => {
        port.disconnect();
        reject(new Error("Sync timed out"));
      }, 5 * 60 * 1000);

      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        setSyncState({ ...nextState }).catch(() => {});
      });

      port.onMessage.addListener((msg) => {
        if (!msg || !msg.type) {
          return;
        }

        if (msg.type === "sync-progress") {
          totalCount = msg.total || totalCount;
          setStatus({
            progress: {
              processed: msg.processed || 0,
              total: msg.total || totalCount,
              status: msg.status || ""
            }
          });
          if (fullInventoryMode && msg.cursor) {
            nextState.inventoryCursor = {
              offset: msg.cursor.offset || 0,
              limit: msg.cursor.limit || null,
              updatedAt: nowIso()
            };
            nextState.inventoryInProgress = true;
            checkpointCount += 1;
            maybeCheckpoint(false);
          }
        }

        if (msg.type === "conversation") {
          currentIds.add(msg.id);
          const existingRaw = nextState.conversations[msg.id];
          const existingTime = Number.isFinite(existingRaw) ? existingRaw : 0;
          const messageRaw = msg.update_time;
          const messageParsed =
            typeof messageRaw === "string" ? Number.parseFloat(messageRaw) : messageRaw;
          const messageTime = Number.isFinite(messageParsed) ? messageParsed : 0;
          const nextTime = Math.max(existingTime, messageTime);
          nextState.conversations[msg.id] = nextTime;
          nextState.meta[msg.id] = {
            id: msg.id,
            title: msg.title || "",
            create_time: msg.create_time || 0,
            update_time: nextTime
          };
          nextState.lastRun[msg.id] = {
            status: "updated",
            update_time: nextTime,
            at: nowIso()
          };
          indexMap.set(msg.id, {
            id: msg.id,
            title: msg.title || "",
            create_time: msg.create_time || 0,
            update_time: msg.update_time || 0
          });
          updatedCount += 1;
          checkpointCount += 1;
          maybeCheckpoint(false);
        }

        if (msg.type === "conversation-skip") {
          currentIds.add(msg.id);
          const existingRaw = nextState.conversations[msg.id];
          const existingTime = Number.isFinite(existingRaw) ? existingRaw : 0;
          const messageRaw = msg.update_time;
          const messageParsed =
            typeof messageRaw === "string" ? Number.parseFloat(messageRaw) : messageRaw;
          const messageTime = Number.isFinite(messageParsed) ? messageParsed : 0;
          const nextTime = Math.max(existingTime, messageTime);
          nextState.conversations[msg.id] = nextTime;
          nextState.meta[msg.id] = {
            id: msg.id,
            title: msg.title || "",
            create_time: msg.create_time || 0,
            update_time: nextTime
          };
          nextState.lastRun[msg.id] = {
            status: "unchanged",
            update_time: nextTime,
            at: nowIso()
          };
          indexMap.set(msg.id, {
            id: msg.id,
            title: msg.title || "",
            create_time: msg.create_time || 0,
            update_time: msg.update_time || 0
          });
          skippedCount += 1;
          checkpointCount += 1;
          maybeCheckpoint(false);
        }

        if (msg.type === "conversation-error") {
          if (msg.id) {
            currentIds.add(msg.id);
            nextState.lastRun[msg.id] = {
              status: "error",
              update_time: nextState.conversations[msg.id] || 0,
              at: nowIso(),
              error: msg.error || "Unknown error"
            };
          }
          errorCount += 1;
          checkpointCount += 1;
          maybeCheckpoint(false);
        }

        if (msg.type === "sync-mode") {
          fullInventoryMode = msg.fullInventory === true;
          if (fullInventoryMode) {
            nextState.inventoryCursor = {
              offset: msg.resumeOffset || 0,
              limit: msg.limit || null,
              updatedAt: nowIso()
            };
            nextState.inventoryInProgress = true;
          } else {
            nextState.inventoryCursor = null;
            nextState.inventoryInProgress = false;
          }
          maybeCheckpoint(true);
        }


        if (msg.type === "sync-requires-folder") {
          clearTimeout(timeout);
          port.disconnect();
          reject(new Error("Select a sync folder in the ChatGPT tab."));
        }

        if (msg.type === "sync-permission-required") {
          clearTimeout(timeout);
          port.disconnect();
          reject(new Error("Folder permission required. Re-grant access in the ChatGPT tab."));
        }

        if (msg.type === "sync-complete") {
          clearTimeout(timeout);
          port.disconnect();

          if (msg.total) {
            totalCount = msg.total;
          }
          if (Number.isFinite(msg.inventoryCount)) {
            totalCount = msg.inventoryCount;
          }
          if (Number.isFinite(msg.errors)) {
            errorCount = msg.errors;
          }
          if (Number.isFinite(msg.updated)) {
            updatedCount = msg.updated;
          }
          if (Number.isFinite(msg.skipped)) {
            skippedCount = msg.skipped;
          }
          if (msg.fullInventory) {
            const prunedConversations = {};
            const prunedMeta = {};
            const prunedLastRun = {};
            for (const id of currentIds) {
              if (Object.prototype.hasOwnProperty.call(nextState.conversations, id)) {
                prunedConversations[id] = nextState.conversations[id];
              }
              if (Object.prototype.hasOwnProperty.call(nextState.meta, id)) {
                prunedMeta[id] = nextState.meta[id];
              }
              if (Object.prototype.hasOwnProperty.call(nextState.lastRun, id)) {
                prunedLastRun[id] = nextState.lastRun[id];
              }
            }
            nextState.conversations = prunedConversations;
            nextState.meta = prunedMeta;
            nextState.lastRun = prunedLastRun;
            nextState.lastFullInventoryAt = nowIso();
            nextState.inventoryCursor = null;
            nextState.inventoryInProgress = false;
          } else if (fullInventoryMode) {
            nextState.inventoryInProgress = true;
          } else {
            nextState.inventoryCursor = null;
            nextState.inventoryInProgress = false;
          }

          setSyncState(nextState).then(() => {
            setStatus({
              lastSyncFinishedAt: nowIso(),
              lastSyncSummary: {
                updated: updatedCount,
                skipped: skippedCount,
                errors: errorCount,
                total: totalCount || indexMap.size
              },
              progress: null
            }).then(resolve);
          });
        }

        if (msg.type === "sync-error") {
          clearTimeout(timeout);
          port.disconnect();
          reject(new Error(msg.error || "Sync error"));
        }
      });

      port.postMessage({
        type: "start-sync",
        options,
        knownConversations,
        knownMeta,
        lastFullInventoryAt,
        inventoryCursor
      });
    });

    await syncPromise;
  } catch (err) {
    await setStatus({ lastError: err.message, lastSyncFinishedAt: nowIso(), progress: null });
  } finally {
    syncInProgress = false;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  const options = await getOptions();
  scheduleSync(options.syncIntervalMinutes);
});

chrome.runtime.onStartup.addListener(async () => {
  const options = await getOptions();
  scheduleSync(options.syncIntervalMinutes);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    runSync("alarm");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "sync-now") {
    const preferredTabId = sender && sender.tab ? sender.tab.id : null;
    runSync("manual", preferredTabId);
    sendResponse({ ok: true });
  }

  if (message && message.type === "open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }

  if (message && message.type === "update-options") {
    const normalized = normalizeOptions(message.options || {});
    setInStorage(STORAGE_KEYS.options, normalized).then(() => {
      scheduleSync(normalized.syncIntervalMinutes);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message && message.type === "force-full-inventory") {
    (async () => {
      if (syncInProgress) {
        sendResponse({ ok: false, error: "Sync already in progress." });
        return;
      }
      const current = await getSyncState();
      const next = {
        ...current,
        lastFullInventoryAt: null,
        inventoryCursor: null,
        inventoryInProgress: false
      };
      await setSyncState(next);
      const preferredTabId = sender && sender.tab ? sender.tab.id : null;
      runSync("manual-full-inventory", preferredTabId);
      sendResponse({ ok: true });
    })().catch((err) => {
      sendResponse({ ok: false, error: err.message || "Unable to restart inventory." });
    });
    return true;
  }

  if (message && message.type === "get-status") {
    Promise.all([getOptions(), getFromStorage(STORAGE_KEYS.status, {})]).then(
      ([options, status]) => {
        sendResponse({ ok: true, options, status });
      }
    );
    return true;
  }

  return false;
});
