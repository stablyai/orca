import type { FocusTerminalPaneDetail } from '@/constants/terminal'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { resolveLeafIdForManager } from '@/lib/pane-manager/pane-key-resolution'
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
  revealPane?: (paneId: number) => void
}

/** Collapses a sibling expanded over the target: it keeps the target display:none even once active. */
export function collapseExpandedSibling(
  targetPaneId: number,
  expandedPaneId: number | null,
  toggleExpandPane: (paneId: number) => void
): void {
  if (expandedPaneId !== null && expandedPaneId !== targetPaneId) {
    toggleExpandPane(expandedPaneId)
  }
}

export function handleFocusTerminalPaneDetail(
  detail: FocusTerminalPaneDetail | undefined,
  {
    tabId,
    manager,
    acknowledgeAgents,
    surfaceStaleAgentRow,
    scrollToBottomIfOutputSinceLastView,
    revealPane
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
  revealPane?.(resolution.numericPaneId)
  manager.setActivePane(resolution.numericPaneId, { focus: true })
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
