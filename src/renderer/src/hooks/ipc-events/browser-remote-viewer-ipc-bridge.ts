import {
  hydrateBrowserRemoteViewerPages,
  setRemoteViewersForBrowserPage
} from '../../lib/pane-manager/browser-remote-viewer-state'

/** Local guests also render remote workspaces, so their viewer state follows this desktop's IPC. */
export function registerBrowserRemoteViewerIpcBridge(): () => void {
  let disposed = false
  let hydrated = false
  const pending = new Map<string, boolean>()
  const unsubscribe = window.api.runtime.onBrowserRemoteViewersChanged?.((event) => {
    if (!hydrated) {
      pending.set(event.browserPageId, event.hasRemoteViewers)
      if (pending.size > 300) {
        pending.delete(pending.keys().next().value!)
      }
      return
    }
    setRemoteViewersForBrowserPage(event.browserPageId, event.hasRemoteViewers)
  })
  const settle = (pages: string[]): void => {
    if (disposed) {
      return
    }
    hydrateBrowserRemoteViewerPages(pages)
    for (const [page, viewed] of pending) {
      setRemoteViewersForBrowserPage(page, viewed)
    }
    pending.clear()
    hydrated = true
  }
  void (window.api.runtime.getBrowserRemoteViewerPages?.() ?? Promise.resolve([])).then(
    settle,
    () => settle([])
  )
  return () => {
    disposed = true
    pending.clear()
    unsubscribe?.()
  }
}
