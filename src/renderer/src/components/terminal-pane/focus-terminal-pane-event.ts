import type { FocusTerminalPaneDetail } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { resolveLeafIdForManager } from '@/lib/pane-manager/pane-key-resolution'

type FocusTerminalPaneEventDeps = {
  tabId: string
  manager: Pick<PaneManager, 'getNumericIdForLeaf' | 'getPanes' | 'setActivePane'> | null
  acknowledgeAgents: (paneKeys: string[]) => void
  surfaceStaleAgentRow: (tabId: string, leafId: string) => void
}

export function handleFocusTerminalPaneDetail(
  detail: FocusTerminalPaneDetail | undefined,
  { tabId, manager, acknowledgeAgents, surfaceStaleAgentRow }: FocusTerminalPaneEventDeps
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
  if (detail.ackPaneKeyOnSuccess) {
    acknowledgeAgents([detail.ackPaneKeyOnSuccess])
  }
}
