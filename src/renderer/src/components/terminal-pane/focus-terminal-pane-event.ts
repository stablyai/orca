import type { FocusTerminalPaneDetail } from '@/constants/terminal'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { resolveLeafIdForManager } from '@/lib/pane-manager/pane-key-resolution'
import { clearPendingPaneFocus } from '@/lib/pending-pane-focus'
import { flashFocusedPaneRim } from './focused-pane-rim-flash'

type FocusTerminalPaneManager = {
  getNumericIdForLeaf(leafId: string): number | null
  getPanes(): Pick<ManagedPane, 'id' | 'leafId' | 'container'>[]
  setActivePane(paneId: number, opts?: { focus?: boolean }): void
}

type FocusTerminalPaneEventDeps = {
  tabId: string
  manager: FocusTerminalPaneManager | null
  acknowledgeAgents: (paneKeys: string[]) => void
  surfaceStaleAgentRow: (tabId: string, leafId: string) => void
  scrollToBottomIfOutputSinceLastView?: (paneId: number) => void
}

export function handleFocusTerminalPaneDetail(
  detail: FocusTerminalPaneDetail | undefined,
  {
    tabId,
    manager,
    acknowledgeAgents,
    surfaceStaleAgentRow,
    scrollToBottomIfOutputSinceLastView
  }: FocusTerminalPaneEventDeps
): void {
  if (!detail?.tabId || detail.tabId !== tabId) {
    return
  }
  if (!manager || !detail.leafId) {
    return
  }
  const resolution = resolveLeafIdForManager(
    tabId,
    detail.leafId,
    manager,
    detail.ackPaneKeyOnSuccess ?? null
  )
  if (resolution.status !== 'resolved') {
    // Why: stale pane keys must fail closed instead of focusing a sibling pane.
    if (resolution.leafId) {
      surfaceStaleAgentRow(tabId, resolution.leafId)
    }
    return
  }
  manager.setActivePane(resolution.numericPaneId, { focus: true })
  // Why: the live listener handled it; drop any parked copy so a pane mounting
  // late does not re-fire the same focus.
  clearPendingPaneFocus(tabId)
  if (detail.scrollToBottomIfOutputSinceLastView) {
    scrollToBottomIfOutputSinceLastView?.(resolution.numericPaneId)
  }
  if (detail.flashFocusedPane) {
    const pane = manager.getPanes().find((candidate) => candidate.id === resolution.numericPaneId)
    if (pane) {
      flashFocusedPaneRim(pane.container)
    }
  }
  if (detail.ackPaneKeyOnSuccess) {
    acknowledgeAgents([detail.ackPaneKeyOnSuccess])
  }
}
