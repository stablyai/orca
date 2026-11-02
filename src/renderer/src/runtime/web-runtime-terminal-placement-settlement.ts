import { insertUnifiedTabAfterAnchor } from '../lib/unified-tab-anchor-insertion'
import { useAppStore } from '../store'
import {
  forgetWebSessionTerminalPlacement,
  webTerminalPlacementParentTabId
} from './web-session-terminal-placement'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'

/** The tab here holding a mirrored terminal, found by what it holds (its id is this client's own). */
function tabHoldingTerminal(worktreeId: string, terminalId: string) {
  return (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.contentType === 'terminal' && tab.entityId === terminalId
  )
}

/** Snapshots key mirrored terminals by the parent tab, so an unknown `parent::leaf` anchor resolves to its parent. */
function anchorUnifiedTabId(worktreeId: string, afterTabId: string): string {
  const known = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
    (tab) => tab.id === afterTabId
  )
  if (known || !isWebTerminalSurfaceTabId(afterTabId)) {
    return afterTabId
  }
  const parent = toWebTerminalSurfaceTabId(
    webTerminalPlacementParentTabId(toHostSessionTabId(afterTabId))
  )
  return tabHoldingTerminal(worktreeId, parent)?.id ?? parent
}

/** Settle the placement once the mirrored tab exists (bounded poll), then consume the record. */
export async function settleWebRuntimeTerminalPlacement(
  environmentId: string,
  worktreeId: string,
  hostTabId: string,
  placement: { groupId?: string; afterTabId?: string; activate: boolean }
): Promise<void> {
  const findTab = () => tabHoldingTerminal(worktreeId, toWebTerminalSurfaceTabId(hostTabId))
  try {
    const deadline = Date.now() + 10_000
    while (!findTab() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const tab = findTab()
    if (!tab) {
      return
    }
    const anchorId = placement.afterTabId
      ? anchorUnifiedTabId(worktreeId, placement.afterTabId)
      : undefined
    const state = useAppStore.getState()
    const groups = state.groupsByWorktree[worktreeId] ?? []
    // Requested group can close during create; use the anchor’s group as caller placement.
    const targetGroup =
      groups.find((group) => group.id === placement.groupId) ??
      (anchorId === undefined
        ? undefined
        : groups.find((group) => group.tabOrder.includes(anchorId)))
    if (!targetGroup) {
      return
    }
    if (tab.groupId !== targetGroup.id) {
      // Snapshot may beat placement recording; repair through the same client-owned move as user drags.
      state.moveUnifiedTabToGroup(tab.id, targetGroup.id, {
        activate: placement.activate,
        recordInteraction: false
      })
    }
    if (anchorId) {
      // The create caller owns this insertion; subsequent host snapshots preserve client order.
      insertUnifiedTabAfterAnchor(worktreeId, tab.id, anchorId)
    }
  } finally {
    forgetWebSessionTerminalPlacement({ environmentId, worktreeId, hostTabId })
  }
}
