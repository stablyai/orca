import { useSyncExternalStore } from 'react'
import { recomputeOn } from '@/lib/recompute-on'
import {
  getBrowserAutomationVisibilitySnapshot,
  getBrowserAutomationVisiblePageIds,
  isBrowserAutomationVisible,
  subscribeBrowserAutomationVisibilitySnapshot
} from './browser-automation-visibility-store'

function getServerSnapshot(): number {
  return 0
}

export function useBrowserAutomationVisibilityForAny(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  const storeVersion = useSyncExternalStore(
    subscribeBrowserAutomationVisibilitySnapshot,
    getBrowserAutomationVisibilitySnapshot,
    getServerSnapshot
  )
  return recomputeOn([storeVersion], () =>
    browserPageIds.some((pageId) => Boolean(pageId && isBrowserAutomationVisible(pageId)))
  )
}

export function useBrowserAutomationVisiblePageIds(browserPageIds: readonly string[]): Set<string> {
  const storeVersion = useSyncExternalStore(
    subscribeBrowserAutomationVisibilitySnapshot,
    getBrowserAutomationVisibilitySnapshot,
    getServerSnapshot
  )
  return recomputeOn([storeVersion], () => getBrowserAutomationVisiblePageIds(browserPageIds))
}
