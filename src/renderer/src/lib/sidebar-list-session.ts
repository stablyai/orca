import { useEffect, useRef } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import type { WorkspaceSortBy } from '../../../shared/workspace-view/workspace-row-sort'
import { isPairedWebClientWindow } from './desktop-window-chrome'
import { createBrowserUuid } from './browser-uuid'
import {
  clearWindowSidebarTemporalReadout,
  recordWindowSortOrder
} from './sidebar-shadow/window-sidebar-temporal-readout'

/**
 * Switch point. Tells main the list mounted, so main's Smart latch and sleeping retention start
 * cold as the window's do, and records the window's order for the shadow check. A paired web
 * client's list is its own view and never resets the host's.
 */
export function useSidebarListSession(sortBy: WorkspaceSortBy, sortedIds: readonly string[]): void {
  const sessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!ORCA_SIDEBAR_INPUTS_IS_MAIN || isPairedWebClientWindow()) {
      return
    }
    const sessionId = createBrowserUuid()
    sessionIdRef.current = sessionId
    void window.api.runtime
      .call({ method: 'sidebarSession.begin', params: { sessionId } })
      .catch(() => {})
    return () => clearWindowSidebarTemporalReadout(sessionId)
  }, [])
  useEffect(() => {
    if (ORCA_SIDEBAR_INPUTS_IS_MAIN && sessionIdRef.current) {
      recordWindowSortOrder(sessionIdRef.current, sortBy, sortedIds)
    }
  }, [sortBy, sortedIds])
}
