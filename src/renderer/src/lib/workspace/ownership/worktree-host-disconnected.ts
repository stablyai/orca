import {
  isDisconnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/hosts/connections/runtime-host-connection-state'
import type { AppState } from '@/store/types'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'

/** Whether the paired server a worktree lives on is disconnected, as its card's mark shows. */
export function isWorktreeHostDisconnected(state: AppState, worktreeId: string): boolean {
  const host = parseExecutionHostId(getExecutionHostIdForWorktree(state, worktreeId))
  return (
    host?.kind === 'runtime' &&
    isDisconnectedRuntimeHostState(
      runtimeHostConnectionStateForEntry(state.runtimeStatusByEnvironmentId.get(host.environmentId))
    )
  )
}
