// Why module-level: download UI state is pane-local and BrowserPane unmounts
// while its worktree is hidden, but guest-budget eviction must know which
// hidden pages are still writing downloads — main treats a guest unregister as
// a tab close and cancels their active downloads (browser-manager
// unregisterGuest), so eviction has to skip those pages until they finish.
type TrackedDownload = { browserPageId: string; active: boolean }

const trackedDownloadsById = new Map<string, TrackedDownload>()
const activeDownloadCountByPageId = new Map<string, number>()

export function hasActiveBrowserPageDownload(browserPageId: string): boolean {
  return (activeDownloadCountByPageId.get(browserPageId) ?? 0) > 0
}

function setDownloadActive(
  download: TrackedDownload,
  active: boolean,
  onEvictionVetoChange: () => void
): void {
  if (download.active === active) {
    return
  }
  download.active = active
  const count = (activeDownloadCountByPageId.get(download.browserPageId) ?? 0) + (active ? 1 : -1)
  if (count <= 0) {
    activeDownloadCountByPageId.delete(download.browserPageId)
  } else {
    activeDownloadCountByPageId.set(download.browserPageId, count)
  }
  onEvictionVetoChange()
}

function trackDownloadStarted(
  downloadId: string,
  browserPageId: string,
  onEvictionVetoChange: () => void
): void {
  if (trackedDownloadsById.has(downloadId)) {
    return
  }
  const download: TrackedDownload = { browserPageId, active: false }
  trackedDownloadsById.set(downloadId, download)
  setDownloadActive(download, true, onEvictionVetoChange)
}

// Why: an interrupted-resumable download never fires Chromium's 'done' (no
// finished event), and Orca has no resume path — without this transition the
// veto would outlive the download for the whole session. A resumed download
// re-actives on its next 'progressing' tick, restoring the veto.
function trackDownloadProgress(
  downloadId: string,
  state: 'progressing' | 'interrupted' | null,
  onEvictionVetoChange: () => void
): void {
  const download = trackedDownloadsById.get(downloadId)
  if (!download || state === null) {
    return
  }
  setDownloadActive(download, state === 'progressing', onEvictionVetoChange)
}

function trackDownloadFinished(downloadId: string, onEvictionVetoChange: () => void): void {
  const download = trackedDownloadsById.get(downloadId)
  if (!download) {
    return
  }
  setDownloadActive(download, false, onEvictionVetoChange)
  trackedDownloadsById.delete(downloadId)
}

/** App-lifetime tracking; install once from the surface host (Terminal). The
 *  cleanup clears tracked state — a host unmount tears down every guest, so
 *  stale entries must not veto eviction after a remount. */
export function installBrowserPageDownloadActivityTracking(
  onEvictionVetoChange: () => void = () => {}
): () => void {
  const removeRequested = window.api.browser.onDownloadRequested((event) => {
    trackDownloadStarted(event.downloadId, event.browserPageId, onEvictionVetoChange)
  })
  const removeProgress = window.api.browser.onDownloadProgress((event) => {
    trackDownloadProgress(event.downloadId, event.state, onEvictionVetoChange)
  })
  const removeFinished = window.api.browser.onDownloadFinished((event) => {
    trackDownloadFinished(event.downloadId, onEvictionVetoChange)
  })
  return () => {
    removeRequested()
    removeProgress()
    removeFinished()
    trackedDownloadsById.clear()
    activeDownloadCountByPageId.clear()
  }
}
