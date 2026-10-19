// Why module-level: download UI state is pane-local and BrowserPane unmounts
// while its worktree is hidden, but guest-budget eviction must know which
// hidden pages are still writing downloads — main treats a guest unregister as
// a tab close and cancels their active downloads (browser-manager
// unregisterGuest), so eviction has to skip those pages until they finish.
// Main ends every download it tracks, so start and finish bound the veto.
const browserPageIdByDownloadId = new Map<string, string>()
const activeDownloadCountByPageId = new Map<string, number>()

export function hasActiveBrowserPageDownload(browserPageId: string): boolean {
  return (activeDownloadCountByPageId.get(browserPageId) ?? 0) > 0
}

function adjustActiveDownloadCount(
  browserPageId: string,
  delta: 1 | -1,
  onEvictionVetoChange: () => void
): void {
  const count = (activeDownloadCountByPageId.get(browserPageId) ?? 0) + delta
  if (count <= 0) {
    activeDownloadCountByPageId.delete(browserPageId)
  } else {
    activeDownloadCountByPageId.set(browserPageId, count)
  }
  onEvictionVetoChange()
}

function trackDownloadStarted(
  downloadId: string,
  browserPageId: string,
  onEvictionVetoChange: () => void
): void {
  if (browserPageIdByDownloadId.has(downloadId)) {
    return
  }
  browserPageIdByDownloadId.set(downloadId, browserPageId)
  adjustActiveDownloadCount(browserPageId, 1, onEvictionVetoChange)
}

function trackDownloadFinished(downloadId: string, onEvictionVetoChange: () => void): void {
  const browserPageId = browserPageIdByDownloadId.get(downloadId)
  if (browserPageId === undefined) {
    return
  }
  browserPageIdByDownloadId.delete(downloadId)
  adjustActiveDownloadCount(browserPageId, -1, onEvictionVetoChange)
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
  const removeFinished = window.api.browser.onDownloadFinished((event) => {
    trackDownloadFinished(event.downloadId, onEvictionVetoChange)
  })
  return () => {
    removeRequested()
    removeFinished()
    browserPageIdByDownloadId.clear()
    activeDownloadCountByPageId.clear()
  }
}
