import { useLayoutEffect } from 'react'
import { useAppStore } from '@/store/index'
import { selectRailPageHidesWorkspaceList, WORKSPACE_LIST_REGION_ID } from './app-rail-layout'

// Set when a rail page removed the list rows while one of them held focus; the shell's focus recovery takes it.
let listFocusLostToRailPage = false

export function takeRailPageListFocusLoss(): boolean {
  const lost = listFocusLostToRailPage
  listFocusLostToRailPage = false
  return lost
}

/**
 * Mount as the first child of the list rows. Its layout cleanup runs before the rows' nodes leave the DOM, so it can
 * still see whether focus was inside them when a rail page collapses the list.
 */
export function RailPageListFocusProbe(): null {
  useLayoutEffect(() => {
    return () => {
      // Why: looked up at cleanup, not captured at mount; on the list's first mount this effect runs before the
      // shell's ref is attached. The shell outlives its rows, so it is still in the DOM here.
      const shell = document.getElementById(WORKSPACE_LIST_REGION_ID)
      const active = document.activeElement
      if (
        shell &&
        active instanceof Node &&
        shell.contains(active) &&
        selectRailPageHidesWorkspaceList(useAppStore.getState())
      ) {
        listFocusLostToRailPage = true
      }
    }
  }, [])
  return null
}
