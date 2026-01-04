# AGENTS.md

This file documents project-specific instructions for coding agents.

## Scope

- This is a Chrome MV3 extension that syncs ChatGPT chats to a local folder.
- Do not add a native messaging host or external companion service.
- Keep all new text ASCII unless there is a clear reason to add Unicode.

## Key files

- `manifest.json`: permissions, content scripts, options page.
- `background.js`: sync orchestration, alarms, and sync state.
- `content.js`: UI, File System Access API writes, and ChatGPT API calls.
- `options.html`, `options.css`, `options.js`: options UI and local index viewer.
- `SPECIFICATIONS.md`: authoritative behavior and constraints.

## Sync behavior rules

- Conversation list API limit must be <= 100.
- Listing uses `order=updated` and streams pages while conversation bodies download.
- Full inventory runs when there is no prior state, delete-removed is enabled, or the last full inventory is older than 24h.
- Partial runs stop once listing reaches chats older than the newest known update time.
- Resume uses `inventoryCursor` from `chrome.storage.local` and only advances when a page is fully processed.
- Conversation files are written via the File System Access API from the content script.

## UI placement

- The in-page widget must live in the non-scrollable section of the left sidebar, just below the account section.
- The widget must fit the sidebar width and avoid overlaying the chat list.

## Storage

- Folder handle is stored in IndexedDB for `chatgpt.com` origin.
- Sync state and options live in `chrome.storage.local`.
- Local files and `index.json` live in the user-selected folder.

## Manual test flow

1. Load unpacked extension in `chrome://extensions`.
2. Open `https://chatgpt.com/` and click Sync now.
3. Confirm files appear in the chosen folder and `index.json` updates.
4. Open options page and verify the local index list updates.

## Documentation updates

- Update `README.md` and `SPECIFICATIONS.md` when behavior changes.
