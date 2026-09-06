import { useAppStore } from '../store'
import {
  forgetWebSessionTerminalPlacement,
  webTerminalPlacementParentTabId
} from './web-session-terminal-placement'
import { toHostSessionTabId, toWebTerminalSurfaceTabId } from './web-terminal-surface-id'

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
    const state = useAppStore.getState()
    const anchorId = placement.afterTabId
      ? ((state.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (item) => item.id === placement.afterTabId
        )?.id ??
        toWebTerminalSurfaceTabId(
          webTerminalPlacementParentTabId(toHostSessionTabId(placement.afterTabId))
        ))
      : undefined
    const targetGroup = (state.groupsByWorktree[worktreeId] ?? []).find((group) =>
      placement.groupId
        ? group.id === placement.groupId
        : anchorId && group.tabOrder.includes(anchorId)
    )
    if (tab && targetGroup && tab.groupId !== targetGroup.id) {
      // Why: a snapshot can adopt the tab before the record exists (the publication races the
      // RPC response); repair through the same client-owned move a user drag takes.
      state.moveUnifiedTabToGroup(unifiedTabId, targetGroup.id, {
        activate: placement.activate,
        recordInteraction: false
      })
    }
    if (tab && targetGroup && anchorId && anchorId !== unifiedTabId) {
      const current = useAppStore.getState()
      const group = current.groupsByWorktree[worktreeId]?.find((item) => item.id === targetGroup.id)
      if (group?.tabOrder.includes(unifiedTabId) && group.tabOrder.includes(anchorId)) {
        const order = group.tabOrder.filter((id) => id !== unifiedTabId)
        order.splice(order.indexOf(anchorId) + 1, 0, unifiedTabId)
        // The create caller owns this insertion; subsequent host snapshots preserve client order.
        current.reorderUnifiedTabs(group.id, order, { recordInteraction: false })
      }
    }
  } finally {
    forgetWebSessionTerminalPlacement({ environmentId, worktreeId, hostTabId })
  }
}
