import { useLayoutEffect } from 'react'
import { WORKSPACE_LIST_REGION_ID } from './app-rail-layout'

// Set when a rail page hid the list while focus was inside it; the shell's focus recovery takes it.
let listFocusLostToRailPage = false

export function takeRailPageListFocusLoss(): boolean {
  const lost = listFocusLostToRailPage
  listFocusLostToRailPage = false
  return lost
}

/**
 * When a rail page hides the list (zero width, inert), focus inside it has nowhere to go. Record that for the shell's
 * focus recovery and release it now, rather than leave it on a node the user can no longer see or reach.
 */
export function useRailPageListFocusRelease(hiddenByRailPage: boolean): void {
  useLayoutEffect(() => {
    if (!hiddenByRailPage) {
      return
    }
    const shell = document.getElementById(WORKSPACE_LIST_REGION_ID)
    const active = document.activeElement
    if (shell && active instanceof HTMLElement && shell.contains(active)) {
      listFocusLostToRailPage = true
      active.blur()
    }
  }, [hiddenByRailPage])
}
