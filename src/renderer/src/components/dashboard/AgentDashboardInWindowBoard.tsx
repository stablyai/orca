import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { revealDashboardAgent } from './reveal-dashboard-agent'
import { AgentKanbanBoard } from '../dashboard-popout/AgentKanbanBoard'
import type { AgentRevealArgs } from '../dashboard-popout/AgentTerminalDialog'
import { AgentDashboardSettingsMenu } from './AgentDashboardSettingsMenu'
import { useLiveDashboardSnapshot } from './useLiveDashboardSnapshot'

/** The in-window Agent Dashboard body. Mounted only while open so the live
 *  snapshot derivation stays off the hot path when the drawer is closed. */
export function AgentDashboardInWindowBoard({
  onClose,
  onMenuOpenChange,
  closeOnReveal = true
}: {
  onClose: () => void
  onMenuOpenChange: (open: boolean) => void
  closeOnReveal?: boolean
}): React.JSX.Element {
  const snapshot = useLiveDashboardSnapshot()

  // In-window ack/reveal act on the local store directly — the pop-out's IPC
  // relay is gated to the pop-out renderer and would reject calls from here.
  const handleAckAgent = useCallback((paneKey: string) => {
    useAppStore.getState().acknowledgeAgents([paneKey])
  }, [])
  const handleRevealAgent = useCallback(
    (args: AgentRevealArgs) => {
      revealDashboardAgent(args)
      if (closeOnReveal) {
        onClose()
      }
    },
    [closeOnReveal, onClose]
  )

  // Switching to pop-out from the board hands the surface over rather than
  // leaving an in-window board that the setting says should be a window.
  const handleSwitchToPopout = useCallback(() => {
    onClose()
    void window.api.dashboard.openPopout?.()
  }, [onClose])

  return (
    <AgentKanbanBoard
      snapshot={snapshot}
      // Why: bg-transparent lets the sheet's worktree-sidebar surface through
      // so the board reads as the same companion panel as the workspace board.
      containerClassName="h-full w-full bg-transparent"
      onAckAgent={handleAckAgent}
      onRevealAgent={handleRevealAgent}
      onClose={onClose}
      headerActions={
        <AgentDashboardSettingsMenu
          onSwitchToPopout={handleSwitchToPopout}
          onOpenChange={onMenuOpenChange}
        />
      }
    />
  )
}
