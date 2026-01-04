# Specifications

## Goals

- Sync all ChatGPT conversations to a local folder on macOS using the File System Access API.
- Avoid any native messaging host or companion app.
- Provide clear in-page status and an options page for configuration and inspection.
- Support incremental sync to avoid re-downloading unchanged conversations.

## Non-goals

- Cross-browser support beyond Chrome-based browsers with File System Access API.
- Server-side storage, cloud syncing, or multi-device state sharing.
- Background-only sync without an open ChatGPT tab.

## Architecture

- Chrome MV3 extension with:
  - `background.js` service worker for orchestration and scheduling.
  - `content.js` injected into `https://chatgpt.com/*` for UI, API calls, and disk I/O.
  - Options page for settings and index inspection.
- No native host, no external services.

## Data flow

1. Content script requests ChatGPT session token via `https://chatgpt.com/api/auth/session`.
2. Conversation list is fetched from `https://chatgpt.com/backend-api/conversations` using `order=updated` and `limit<=100`.
3. Conversation detail is fetched per ID from `https://chatgpt.com/backend-api/conversation/<id>`.
4. Files are written using the File System Access API into the user-selected folder.
5. Sync progress and results are reported to the background service worker.

## Local storage

- IndexedDB (`chatgpt-local-sync`): stores the folder handle for the selected sync folder.
- `chrome.storage.local`:
  - `options`: user configuration.
  - `status`: last sync status and progress.
  - `syncState`:
    - `conversations`: map of id -> update_time.
    - `meta`: map of id -> { title, create_time, update_time }.
    - `lastRun`: map of id -> { status, update_time, at, error? }.
    - `lastFullInventoryAt`: ISO timestamp.
    - `inventoryCursor`: { offset, limit, updatedAt }.
    - `inventoryInProgress`: boolean.
- Local folder output:
  - `index.json`: complete metadata index.
  - `conversations/<id>.json` and `conversations/<id>.md`.

## Sync algorithm

### Full inventory

A full inventory run is forced when:

- No known conversations exist in storage.
- The delete-removed option is enabled.
- The last full inventory is older than 24 hours.

Full inventory behavior:

- Fetches pages from `order=updated` until exhaustion or `maxPages` threshold.
- Deletes local files for conversations that are no longer present when delete-removed is enabled.
- Updates `lastFullInventoryAt` on success.

### Partial inventory

- Uses the max known `update_time` and stops listing when the page minimum `update_time` is older or equal.
- Does not delete local files, even if delete-removed is enabled (deletions require full inventory).

### Listing and fetching

- Listing is sequential and keeps moving while conversation bodies are fetched in parallel.
- The conversation list `limit` is capped at 100 due to API constraints.
- Conversation details are fetched with a configurable parallelism (default 3, range 1-10).
- The canonical `update_time` stored locally is `max(list_item.update_time, conversation.update_time)` to avoid re-downloading due to timestamp mismatches.

### Resume and checkpointing

- Resume uses `inventoryCursor` stored in `chrome.storage.local`.
- Cursor only advances when a page is fully processed.
- Background state is checkpointed during sync to reduce loss on interruption.

## Progress and status

- Progress bar uses a dynamic target based on total hint and listed count.
- Progress is capped at 99 percent until listing is complete, then reaches 100 percent.
- Status values:
  - `updated`: conversation was fetched and written.
  - `unchanged`: conversation was skipped based on update time.
  - `error`: an error occurred for that conversation.
  - `unknown`: no status yet.

## UI requirements

### In-page widget

- Rendered inside the left sidebar, below the account section in the non-scrollable area.
- Fits the sidebar width and does not overlap the scrollable chat list.
- Collapsed by default (title bar only); clicking the title bar expands to the full view.
- Title bar indicator shows sync state (spinner while syncing, green when synced).
- Expanded view displays status, progress bar, and a single Sync now button.
- Gear icon opens the options page.
- If no folder is selected, clicking Sync now prompts for folder access.

### Options page

- Shows sync status and last sync summary.
- Shows the local index list with filtering and sorting.
- Displays inventory metadata and resume cursor details.
- Re-inventory button clears inventory cursor and forces a full inventory from offset 0.

## File formats

### JSON

- Includes `meta`, `messages`, and raw payload.

### Markdown

- Includes YAML front matter and a rendered transcript.

## Permissions

- `storage`, `tabs`, `alarms`, `unlimitedStorage`.
- `host_permissions`: `https://chatgpt.com/*`.

## Limitations

- Sync only runs when a ChatGPT tab is open.
- The ChatGPT web API is undocumented and may change.
- File System Access API requires explicit user permission.
