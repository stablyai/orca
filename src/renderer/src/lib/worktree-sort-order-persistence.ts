import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import { splitWorktreeSortOrderByHost } from './worktree-sort-order-host-split'

function ignoreSortOrderPersistenceFailure(promise: Promise<unknown>): void {
  void promise.catch(() => {
    // Best-effort sort persistence must not turn SSH disconnects into unhandled crash diagnostics.
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
          { orderedIds: group.orderedIds, hostIds: group.rowHostIds },
          { timeoutMs: 15_000 }
        )
      )
      continue
    }

    ignoreSortOrderPersistenceFailure(
      window.api.worktrees.persistSortOrder({
        orderedIds: group.orderedIds,
        hostIds: group.rowHostIds
      })
    )
  }
}
