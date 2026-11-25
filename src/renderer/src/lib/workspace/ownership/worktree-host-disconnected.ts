import {
  isDisconnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/hosts/connections/runtime-host-connection-state'
import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'

/** Whether the paired server a worktree lives on is disconnected, as its card's mark shows. */
export function isWorktreeHostDisconnected(
  state: AppState,
  statuses: RuntimeStatuses,
  worktreeId: string
): boolean {
  const host = parseExecutionHostId(getExecutionHostIdForWorktree(state, worktreeId))
  return (
    host?.kind === 'runtime' &&
    isDisconnectedRuntimeHostState(
      runtimeHostConnectionStateForEntry(statuses.get(host.environmentId))
    )
  )
}
