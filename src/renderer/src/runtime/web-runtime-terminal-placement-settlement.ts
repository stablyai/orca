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
} from './web-terminal-surface-id'

/** Snapshots key mirrored terminals by the parent tab, so an unknown `parent::leaf` anchor resolves to its parent. */
function anchorUnifiedTabId(worktreeId: string, afterTabId: string): string {
  const known = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
    (tab) => tab.id === afterTabId
  )
  return known || !isWebTerminalSurfaceTabId(afterTabId)
    ? afterTabId
    : toWebTerminalSurfaceTabId(webTerminalPlacementParentTabId(toHostSessionTabId(afterTabId)))
}

/** Settle the placement once the mirrored tab exists (bounded poll), then consume the record. */
export async function settleWebRuntimeTerminalPlacement(
  environmentId: string,
  worktreeId: string,
  hostTabId: string,
  placement: { groupId?: string; afterTabId?: string; activate: boolean }
): Promise<void> {
  const unifiedTabId = toWebTerminalSurfaceTabId(hostTabId)
  const findTab = () =>
    (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.id === unifiedTabId
    )
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
    // Why: the requested group can be closed while the mirrored tab is still in flight; the
    // anchor's own group still expresses where the caller asked for this terminal.
    const targetGroup =
      groups.find((group) => group.id === placement.groupId) ??
      (anchorId === undefined
        ? undefined
        : groups.find((group) => group.tabOrder.includes(anchorId)))
    if (!targetGroup) {
      return
    }
    if (tab.groupId !== targetGroup.id) {
      // Why: a snapshot can adopt the tab before the record exists (the publication races the
      // RPC response); repair through the same client-owned move a user drag takes.
      state.moveUnifiedTabToGroup(unifiedTabId, targetGroup.id, {
        activate: placement.activate,
        recordInteraction: false
      })
    }
    if (anchorId) {
      // The create caller owns this insertion; subsequent host snapshots preserve client order.
      insertUnifiedTabAfterAnchor(worktreeId, unifiedTabId, anchorId)
    }
  } finally {
    forgetWebSessionTerminalPlacement({ environmentId, worktreeId, hostTabId })
  }
}
