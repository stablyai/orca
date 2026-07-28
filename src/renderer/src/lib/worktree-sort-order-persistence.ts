import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'
import { splitWorktreeSortOrderByHost } from './worktree-sort-order-host-split'

export async function persistWorktreeSortOrderByHost(
  state: WorktreeRuntimeOwnerState,
  orderedIds: readonly string[]
): Promise<boolean> {
  try {
    const writes = splitWorktreeSortOrderByHost(state, orderedIds).map((group) => {
      const parsed = parseExecutionHostId(group.hostId)
      if (parsed?.kind === 'runtime') {
        return callRuntimeRpc(
          { kind: 'environment', environmentId: parsed.environmentId },
          'worktree.persistSortOrder',
          { orderedIds: group.orderedIds },
          { timeoutMs: 15_000 }
        )
      }
      return window.api.worktrees.persistSortOrder({ orderedIds: group.orderedIds })
    })
    const results = await Promise.allSettled(writes)
    return results.every((result) => result.status === 'fulfilled')
  } catch {
    return false
  }
}
