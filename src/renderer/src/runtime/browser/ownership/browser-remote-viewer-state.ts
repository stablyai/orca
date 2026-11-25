import { useSyncExternalStore } from 'react'
import { recomputeOn } from '@/lib/recompute-on'
import {
  getBrowserRemotelyViewedPageIds,
  getBrowserRemoteViewerSnapshot,
  hasRemoteViewerForAnyBrowserPage,
  subscribeBrowserRemoteViewerSnapshot
} from './browser-remote-viewer-store'

function getServerSnapshot(): number {
  return 0
}

export function useBrowserRemoteViewerForAny(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  const storeVersion = useSyncExternalStore(
    subscribeBrowserRemoteViewerSnapshot,
    getBrowserRemoteViewerSnapshot,
    getServerSnapshot
  )
  return recomputeOn([storeVersion], () => hasRemoteViewerForAnyBrowserPage(browserPageIds))
}

export function useBrowserRemotelyViewedPageIds(
  browserPageIds: readonly (string | null | undefined)[]
): Set<string> {
  const storeVersion = useSyncExternalStore(
    subscribeBrowserRemoteViewerSnapshot,
    getBrowserRemoteViewerSnapshot,
    getServerSnapshot
  )
  return recomputeOn([storeVersion], () => getBrowserRemotelyViewedPageIds(browserPageIds))
}
