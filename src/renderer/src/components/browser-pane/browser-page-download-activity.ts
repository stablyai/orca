// Why module-level: download UI state is pane-local and BrowserPane unmounts
// while its worktree is hidden, but guest-budget eviction must know which
// hidden pages are still writing downloads — main treats a guest unregister as
// a tab close and cancels their active downloads (browser-manager
// unregisterGuest), so eviction has to skip those pages until they finish.
const pageIdByActiveDownloadId = new Map<string, string>()
const activeDownloadCountByPageId = new Map<string, number>()

export function hasActiveBrowserPageDownload(browserPageId: string): boolean {
  return (activeDownloadCountByPageId.get(browserPageId) ?? 0) > 0
}

function trackDownloadStarted(downloadId: string, browserPageId: string): void {
  if (pageIdByActiveDownloadId.has(downloadId)) {
    return
  }
  pageIdByActiveDownloadId.set(downloadId, browserPageId)
  activeDownloadCountByPageId.set(
    browserPageId,
    (activeDownloadCountByPageId.get(browserPageId) ?? 0) + 1
  )
}

function trackDownloadFinished(downloadId: string): void {
  const browserPageId = pageIdByActiveDownloadId.get(downloadId)
  if (browserPageId === undefined) {
    return
  }
  pageIdByActiveDownloadId.delete(downloadId)
  const remaining = (activeDownloadCountByPageId.get(browserPageId) ?? 1) - 1
  if (remaining <= 0) {
    activeDownloadCountByPageId.delete(browserPageId)
  } else {
    activeDownloadCountByPageId.set(browserPageId, remaining)
  }
}

/** App-lifetime tracking; install once from the surface host (Terminal). The
 *  cleanup clears tracked state — a host unmount tears down every guest, so
 *  stale entries must not veto eviction after a remount. */
export function installBrowserPageDownloadActivityTracking(): () => void {
  const removeRequested = window.api.browser.onDownloadRequested((event) => {
    trackDownloadStarted(event.downloadId, event.browserPageId)
  })
  const removeFinished = window.api.browser.onDownloadFinished((event) => {
    trackDownloadFinished(event.downloadId)
  })
  return () => {
    removeRequested()
    removeFinished()
    pageIdByActiveDownloadId.clear()
    activeDownloadCountByPageId.clear()
  }
}
