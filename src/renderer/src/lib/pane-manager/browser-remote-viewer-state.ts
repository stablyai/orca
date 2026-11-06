import { useSyncExternalStore } from 'react'
import {
  getBrowserRemotelyViewedPageIds,
  getBrowserRemoteViewerSnapshot,
  hasRemoteViewerForAnyBrowserPage,
  subscribeBrowserRemoteViewerSnapshot
} from './browser-remote-viewer-store'

export {
  getBrowserRemotelyViewedPageIds,
  hasRemoteViewerForAnyBrowserPage,
  hydrateBrowserRemoteViewerPages,
  isBrowserPageRemotelyViewed,
  onBrowserRemoteViewerChange,
  setRemoteViewersForBrowserPage
} from './browser-remote-viewer-store'

function getServerSnapshot(): number {
  return 0
}

export function useBrowserRemoteViewerForAny(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  useSyncExternalStore(
    subscribeBrowserRemoteViewerSnapshot,
    getBrowserRemoteViewerSnapshot,
    getServerSnapshot
  )
  return hasRemoteViewerForAnyBrowserPage(browserPageIds)
}

export function useBrowserRemotelyViewedPageIds(
  browserPageIds: readonly (string | null | undefined)[]
): Set<string> {
  useSyncExternalStore(
    subscribeBrowserRemoteViewerSnapshot,
    getBrowserRemoteViewerSnapshot,
    getServerSnapshot
  )
  return getBrowserRemotelyViewedPageIds(browserPageIds)
}
