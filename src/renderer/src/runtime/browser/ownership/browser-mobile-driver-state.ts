import { useSyncExternalStore } from 'react'
import { recomputeOn } from '@/lib/recompute-on'
import type { RuntimeTerminalDriverState } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  getBrowserDriverSnapshot,
  getBrowserMobileDrivenPageIds,
  getDriverForBrowserPage,
  hasMobileDriverForAnyBrowserPage,
  IDLE_BROWSER_DRIVER,
  subscribeBrowserDriverSnapshot
} from './browser-mobile-driver-store'

function getServerSnapshot(): number {
  return 0
}

export function useBrowserDriverForPage(
  browserPageId: string | null | undefined
): RuntimeTerminalDriverState {
  const storeVersion = useSyncExternalStore(
    subscribeBrowserDriverSnapshot,
    getBrowserDriverSnapshot,
    getServerSnapshot
  )
  return recomputeOn([storeVersion], () =>
    browserPageId ? getDriverForBrowserPage(browserPageId) : IDLE_BROWSER_DRIVER
  )
}

export function useBrowserMobileDriverForAny(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  const storeVersion = useSyncExternalStore(
    subscribeBrowserDriverSnapshot,
    getBrowserDriverSnapshot,
    getServerSnapshot
  )
  return recomputeOn([storeVersion], () => hasMobileDriverForAnyBrowserPage(browserPageIds))
}

export function useBrowserMobileDrivenPageIds(
  browserPageIds: readonly (string | null | undefined)[]
): Set<string> {
  const storeVersion = useSyncExternalStore(
    subscribeBrowserDriverSnapshot,
    getBrowserDriverSnapshot,
    getServerSnapshot
  )
  return recomputeOn([storeVersion], () => getBrowserMobileDrivenPageIds(browserPageIds))
}
