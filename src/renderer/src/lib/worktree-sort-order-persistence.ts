import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'
import { splitWorktreeSortOrderByHost } from './worktree-sort-order-host-split'

function ignoreSortOrderPersistenceFailure(promise: Promise<unknown>): void {
  void promise.catch(() => {
    // Why: sort-order restore is best-effort; SSH disconnects during smart sort
    // must not surface as unhandled rejections that pollute crash diagnostics.
  })
}

export function persistWorktreeSortOrderByHost(
  state: WorktreeRuntimeOwnerState,
  orderedIds: readonly string[]
): void {
  for (const group of splitWorktreeSortOrderByHost(state, orderedIds)) {
    const parsed = parseExecutionHostId(group.hostId)
    if (parsed?.kind === 'runtime') {
      ignoreSortOrderPersistenceFailure(
        callRuntimeRpc(
          { kind: 'environment', environmentId: parsed.environmentId },
          'worktree.persistSortOrder',
          { orderedIds: group.orderedIds },
          { timeoutMs: 15_000 }
        )
      )
      continue
    }

    ignoreSortOrderPersistenceFailure(
      window.api.worktrees.persistSortOrder({ orderedIds: group.orderedIds })
    )
  }
}
