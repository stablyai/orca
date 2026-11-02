import type { PaneManager, PaneManagerOptions } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'

/**
 * A layout-owner build's pane gestures: an in-tab drop moves the pane once main has answered, and
 * not when main refuses; a divider's new ratios, already drawn while dragging, are saved by main
 * when the drag ends.
 */
export function layoutOwnerPaneGestures(pane: {
  worktreeId: string
  tabId: string
  managerRef: { current: PaneManager | null }
  /** False while a restore owns the layout; the drawn ratios are then not the user's. */
  shouldPersistLayout: () => boolean
}): Pick<PaneManagerOptions, 'takePaneDrop' | 'onDividerRatiosCommitted'> {
  const { worktreeId, tabId } = pane
  // Why: main holds the moved tree before this window does, so ratios sent meanwhile are refused;
  // they wait for the window's move and go then.
  let movesInFlight = 0
  let ratiosWaiting = false
  const saveRatios = (): void => {
    if (movesInFlight > 0) {
      ratiosWaiting = true
      return
    }
    ratiosWaiting = false
    // Why the store: the gesture's own persist has just written the window's tree there.
    const root = useAppStore.getState().terminalLayoutsByTabId[tabId]?.root
    if (root && pane.shouldPersistLayout()) {
      const keep = (): void => {}
      sendLayoutCommandToOwner(
        worktreeId,
        { type: 'setPaneRatios', tabId, root },
        { apply: keep, asToday: keep }
      )
    }
  }
  return {
    takePaneDrop: ({ sourcePaneId, targetPaneId, zone }, move) => {
      const manager = pane.managerRef.current
      const leafId = manager?.getLeafId(sourcePaneId)
      const targetLeafId = manager?.getLeafId(targetPaneId)
      if (!leafId || !targetLeafId) {
        return false
      }
      const settle = (moveHere: boolean): void => {
        try {
          if (moveHere) {
            move()
          }
        } finally {
          movesInFlight -= 1
          if (movesInFlight === 0 && ratiosWaiting) {
            saveRatios()
          }
        }
      }
      const taken = sendLayoutCommandToOwner(
        worktreeId,
        { type: 'movePane', tabId, leafId, targetLeafId, side: zone },
        {
          apply: () => settle(true),
          asToday: () => settle(true),
          // Main's tree did not change, and frames draw main's tree: the window keeps its shape.
          refused: () => settle(false)
        }
      )
      if (taken) {
        movesInFlight += 1
      }
      return taken
    },
    onDividerRatiosCommitted: saveRatios
  }
}
