import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { consumePendingPaneFocus } from '@/lib/pending-pane-focus'
import { useAppStore } from '@/store'
import { handleFocusTerminalPaneDetail } from './focus-terminal-pane-event'
import { surfaceStaleAgentRow } from './stale-agent-row'

// Why: activateTabAndFocusPane may dispatch before a cold-parked pane mounts
// its listener (hidden worktree, SSH connect gate); the parked detail is
// consumed here. The lifecycle effect that creates managerRef.current runs
// before this one, so the manager and its replayed panes already exist.
export function useConsumePendingPaneFocus({
  tabId,
  managerRef,
  scheduleFollowOutputIfNeeded
}: {
  tabId: string
  managerRef: React.RefObject<PaneManager | null>
  scheduleFollowOutputIfNeeded?: (paneId: number) => void
}): void {
  useEffect(() => {
    const parked = consumePendingPaneFocus(tabId)
    if (!parked) {
      return
    }
    handleFocusTerminalPaneDetail(parked, {
      tabId,
      manager: managerRef.current,
      acknowledgeAgents: (paneKeys) => useAppStore.getState().acknowledgeAgents(paneKeys),
      surfaceStaleAgentRow,
      scrollToBottomIfOutputSinceLastView: scheduleFollowOutputIfNeeded
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])
}
