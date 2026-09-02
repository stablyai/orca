import { useAppStore } from '../store'
import { forgetWebSessionTerminalPlacement } from './web-session-terminal-placement'
import { toWebTerminalSurfaceTabId } from './web-terminal-surface-id'

/** Settle the placement once the mirrored tab exists (bounded poll), then consume the record. */
export async function settleWebRuntimeTerminalPlacement(
  environmentId: string,
  worktreeId: string,
  hostTabId: string,
  placement: { groupId: string; activate: boolean }
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
    const targetGroupExists = (state.groupsByWorktree[worktreeId] ?? []).some(
      (group) => group.id === placement.groupId
    )
    if (tab && targetGroupExists && tab.groupId !== placement.groupId) {
      // Why: a snapshot can adopt the tab before the record exists (the publication races the
      // RPC response); repair through the same client-owned move a user drag takes.
      state.moveUnifiedTabToGroup(unifiedTabId, placement.groupId, {
        activate: placement.activate,
        recordInteraction: false
      })
    }
  } finally {
    forgetWebSessionTerminalPlacement({ environmentId, worktreeId, hostTabId })
  }
}
