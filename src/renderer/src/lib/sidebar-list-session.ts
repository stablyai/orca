import { useEffect } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { isPairedWebClientWindow } from './desktop-window-chrome'
import { createBrowserUuid } from './browser-uuid'

/** List mount resets this main runtime’s sleeping retention; paired clients own independent lists and must never reset the host’s. */
export function useSidebarListSession(): void {
  useEffect(() => {
    if (!ORCA_SIDEBAR_INPUTS_IS_MAIN || isPairedWebClientWindow()) {
      return
    }
    void window.api.runtime
      .call({ method: 'sidebarSession.begin', params: { sessionId: createBrowserUuid() } })
      .catch(() => {})
  }, [])
}
