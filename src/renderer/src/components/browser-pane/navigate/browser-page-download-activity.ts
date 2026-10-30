// Track beyond pane unmount: hidden-page eviction unregisters guests and cancels downloads, so active downloads veto it until main reports completion.
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

/** Install once per surface host; clear on teardown because every guest is destroyed and stale entries would block eviction. */
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
