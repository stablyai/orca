import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import { collectLeafIdsInOrder } from '../terminal-layout-leaf-ids'

// Main can give a remounted pane the same PTY, so disposal alone does not make it ownerless.
export function shouldRetainDisposedPaneSpawn(
  state: Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId' | 'deleteStateByWorktreeId'>,
  worktreeId: string,
  tabId: string,
  leafId: string,
  executionHostId?: ExecutionHostId
): boolean {
  const deleteState =
    (executionHostId
      ? state.deleteStateByWorktreeId?.[composeWorktreeHostIdentity(executionHostId, worktreeId)]
      : undefined) ?? state.deleteStateByWorktreeId?.[worktreeId]
  if (
    deleteState?.isDeleting &&
    (!deleteState.executionHostId || deleteState.executionHostId === executionHostId)
  ) {
    return false
  }
  const tabPresent = Object.values(state.tabsByWorktree).some((tabs) =>
    tabs.some((tab) => tab.id === tabId)
  )
  if (!tabPresent) {
    return false
  }
  // A new single-pane tab has no layout root until its first pane binds.
  const root = state.terminalLayoutsByTabId[tabId]?.root
  return !root || collectLeafIdsInOrder(root).includes(leafId)
}
