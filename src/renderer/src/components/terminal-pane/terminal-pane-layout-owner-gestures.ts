import type { PaneManager, PaneManagerOptions } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { layoutFrameTerminalTab } from '@/runtime/layout-frame-terminal-panes'
import { samePanesIgnoringRatios } from '../../../../shared/workspace-layout/terminal-pane-tree'
import {
  allSplitRatios,
  changedSplitRatios,
  withPaneSplitRatios,
  type SplitRatioIntent
} from '../../../../shared/workspace-layout/split-ratio-intents'

/** Send in-tab moves to main and draw its frame; send changed divider ratios after drag, preserving their optimistic rendering until accepted/refused. */
export function layoutOwnerPaneGestures(pane: {
  worktreeId: string
  tabId: string
  managerRef: { current: PaneManager | null }
  /** False while a restore owns the layout; the drawn ratios are then not the user's. */
  shouldPersistLayout: () => boolean
}): Pick<PaneManagerOptions, 'takePaneDrop' | 'onDividerRatiosCommitted'> {
  const { worktreeId, tabId } = pane
  /** Ratios sent and not yet answered: main applies them in order, after its frame's. */
  const inFlight = new Set<SplitRatioIntent[]>()
  const saveRatios = (): void => {
    // Why the store: the gesture's own persist has just written the window's tree there.
    const root = useAppStore.getState().terminalLayoutsByTabId[tabId]?.root
    const ratios =
      root && pane.shouldPersistLayout() ? dividersMoved(worktreeId, tabId, root, inFlight) : []
    if (ratios.length > 0) {
      const answered = (): void => {
        inFlight.delete(ratios)
      }
      inFlight.add(ratios)
      const sent = sendLayoutCommandToOwner(
        worktreeId,
        { type: 'setPaneRatios', tabId, ratios },
        // A refusal (main's panes moved on) releases the tab's hold: its frame redraws main's ratios.
        { apply: answered, asToday: answered, refused: answered }
      )
      if (!sent) {
        answered()
      }
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
      return sendLayoutCommandToOwner(
        worktreeId,
        { type: 'movePane', tabId, leafId, targetLeafId, side: zone },
        // A refusal left main's tree, which frames draw, as it was: the window keeps its shape.
        { apply: () => {}, asToday: move, refused: () => {} }
      )
    },
    onDividerRatiosCommitted: saveRatios
  }
}

/** Compare against framed ratios plus in-flight changes so dragging back to the frame’s value still sends; earlier requests hold the tab. */
function dividersMoved(
  worktreeId: string,
  tabId: string,
  root: TerminalPaneLayoutNode,
  inFlight: ReadonlySet<SplitRatioIntent[]>
): SplitRatioIntent[] {
  const mainRoot = layoutFrameTerminalTab(worktreeId, tabId)?.terminal?.root
  if (!mainRoot) {
    return allSplitRatios(root)
  }
  let expected = mainRoot
  for (const ratios of inFlight) {
    expected = withPaneSplitRatios(expected, ratios) ?? expected
  }
  // Main's panes moved on since this window drew them; its frame redraws them with their ratios.
  return samePanesIgnoringRatios(expected, root) ? changedSplitRatios(expected, root) : []
}
