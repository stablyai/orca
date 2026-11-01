import type { AppState } from '@/store/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { collectHostTwinPurgeScopes } from '@/store/slices/worktrees/teardown/host-twin-worktree-purge'

/** Sleeping a workspace ID also sleeps its host twins; collect the additional hosts for confirmation. */
export function collectTwinHostsAlsoSlept(
  state: AppState,
  worktrees: readonly Pick<Worktree, 'id' | 'hostId' | 'runtimeOwnerEnvironmentId'>[]
): ExecutionHostId[] {
  // Why: an unstamped row is this app's copy, as the listing and the purge read it.
  const targets = worktrees.map((worktree) =>
    hostWorktreeTarget({
      id: worktree.id,
      hostId:
        worktree.hostId ??
        (worktree.runtimeOwnerEnvironmentId
          ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
          : LOCAL_EXECUTION_HOST_ID)
    })
  )
  const alsoSlept = new Set<ExecutionHostId>()
  for (const twins of collectHostTwinPurgeScopes(state, targets).values()) {
    for (const hostIds of twins.values()) {
      for (const hostId of hostIds) {
        alsoSlept.add(hostId)
      }
    }
  }
  return [...alsoSlept]
}
