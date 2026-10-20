import { useEffect } from 'react'
import { isPairedWebClientWindow } from './desktop-window-chrome'
import { createBrowserUuid } from './browser-uuid'

/**
 * Tells main the list mounted, so main's sleeping retention starts cold as the
 * window's does. A paired web client's list is its own view and never resets the host's.
 */
export function useSidebarListSession(): void {
  useEffect(() => {
    if (isPairedWebClientWindow()) {
      return
    }
    void window.api.runtime
      .call({ method: 'sidebarSession.begin', params: { sessionId: createBrowserUuid() } })
      .catch(() => {})
  }, [])
}
