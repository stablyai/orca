import { useEffect } from 'react'
import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { handleFocusTerminalPaneDetail } from './focus-terminal-pane-event'
import { surfaceStaleAgentRow } from '../../agent-status/stale-agent-row'
import { useAppStore } from '@/store'

export function useTerminalPaneFocusEvent({
  tabId,
  managerRef,
  scheduleFollowOutputIfNeeded,
  toggleExpandPane
}: {
  tabId: string
  managerRef: React.RefObject<PaneManager | null>
  scheduleFollowOutputIfNeeded: (paneId: number) => void
  toggleExpandPane: (paneId: number) => void
}): void {
  useEffect(() => {
    const onFocusPane = (event: Event): void => {
      const detail = (event as CustomEvent<FocusTerminalPaneDetail | undefined>).detail
      handleFocusTerminalPaneDetail(detail, {
        tabId,
        manager: managerRef.current,
        acknowledgeAgents: (paneKeys) => useAppStore.getState().acknowledgeAgents(paneKeys),
        surfaceStaleAgentRow,
        scrollToBottomIfOutputSinceLastView: scheduleFollowOutputIfNeeded,
        expandedLeafId: useAppStore.getState().terminalLayoutsByTabId[tabId]?.expandedLeafId,
        toggleExpandPane
      })
    }
    window.addEventListener(FOCUS_TERMINAL_PANE_EVENT, onFocusPane)
    return () => window.removeEventListener(FOCUS_TERMINAL_PANE_EVENT, onFocusPane)
    // toggleExpandPane only reads refs, like the expand listener above, so it is not re-subscribed on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, managerRef, scheduleFollowOutputIfNeeded])
}
