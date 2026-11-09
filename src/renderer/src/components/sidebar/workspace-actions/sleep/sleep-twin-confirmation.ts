import type { AppState } from '@/store/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { collectHostTwinPurgeScopes } from '@/store/slices/worktrees/teardown/host-twin-purge-scopes'

type SleepWorktreeRef = Pick<Worktree, 'id' | 'hostId' | 'runtimeOwnerEnvironmentId'>

/** Sleeping a workspace ID also sleeps its host twins; collect the additional hosts for confirmation. */
function collectTwinHostsAlsoSlept(
  state: AppState,
  worktrees: readonly SleepWorktreeRef[]
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

/** Sleep now, or confirm first when host twins the user didn't pick would sleep too. */
export function requestWorkspaceSleep(args: {
  state: AppState
  openModal: AppState['openModal']
  worktrees: readonly SleepWorktreeRef[]
  sleep: (worktreeIds: string[]) => void
}): void {
  const worktreeIds = args.worktrees.map((worktree) => worktree.id)
  // Why confirm: a twin's copies share one id, so this also sleeps copies the user didn't pick.
  const hostIds = collectTwinHostsAlsoSlept(args.state, args.worktrees)
  if (hostIds.length > 0) {
    args.openModal('confirm-sleep-twin', { worktreeIds, hostIds })
    return
  }
  args.sleep(worktreeIds)
}
