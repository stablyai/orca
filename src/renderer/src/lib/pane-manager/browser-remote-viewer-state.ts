import { useSyncExternalStore } from 'react'

// Why: which host-owned pages a paired client is streaming. Separate from the driver store because
// watching and driving are independent: a desktop/web/CLI viewer takes no presence lock, but its
// page must still paint or Chromium stops producing the frames it subscribed to.

const remotelyViewedPageIds = new Set<string>()

type BrowserRemoteViewerChangeListener = (browserPageId: string) => void
const changeListeners = new Set<BrowserRemoteViewerChangeListener>()
const snapshotListeners = new Set<() => void>()
let version = 0

export function onBrowserRemoteViewerChange(
  listener: BrowserRemoteViewerChangeListener
): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function subscribe(listener: () => void): () => void {
  snapshotListeners.add(listener)
  return () => {
    snapshotListeners.delete(listener)
  }
}

function getSnapshot(): number {
  return version
}

function getServerSnapshot(): number {
  return 0
}

function notifyChange(browserPageId: string): void {
  version += 1
  for (const listener of changeListeners) {
    listener(browserPageId)
  }
  for (const listener of snapshotListeners) {
    listener()
  }
}

export function setRemoteViewersForBrowserPage(
  browserPageId: string,
  hasRemoteViewers: boolean
): void {
  if (hasRemoteViewers) {
    remotelyViewedPageIds.add(browserPageId)
  } else {
    remotelyViewedPageIds.delete(browserPageId)
  }
  notifyChange(browserPageId)
}

export function isBrowserPageRemotelyViewed(browserPageId: string): boolean {
  return remotelyViewedPageIds.has(browserPageId)
}

export function hasRemoteViewerForAnyBrowserPage(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  return browserPageIds.some((pageId) => Boolean(pageId && isBrowserPageRemotelyViewed(pageId)))
}

export function useBrowserRemoteViewerForAny(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return hasRemoteViewerForAnyBrowserPage(browserPageIds)
}

export function getBrowserRemotelyViewedPageIds(
  browserPageIds: readonly (string | null | undefined)[]
): Set<string> {
  const viewed = new Set<string>()
  for (const pageId of browserPageIds) {
    if (pageId && isBrowserPageRemotelyViewed(pageId)) {
      viewed.add(pageId)
    }
  }
  return viewed
}

export function useBrowserRemotelyViewedPageIds(
  browserPageIds: readonly (string | null | undefined)[]
): Set<string> {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return getBrowserRemotelyViewedPageIds(browserPageIds)
}

export function hydrateBrowserRemoteViewerPages(browserPageIds: readonly string[]): void {
  // Why: mirrors hydrateBrowserDrivers — panes can mount before hydration returns after a reload,
  // so every page that gained or lost the signal has to be notified, not just the new ones.
  const affectedPageIds = new Set(remotelyViewedPageIds)
  remotelyViewedPageIds.clear()
  for (const browserPageId of browserPageIds) {
    affectedPageIds.add(browserPageId)
    remotelyViewedPageIds.add(browserPageId)
  }
  for (const browserPageId of affectedPageIds) {
    notifyChange(browserPageId)
  }
}
