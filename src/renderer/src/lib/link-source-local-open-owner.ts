import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { HttpLinkSourceOwner } from './http-link-routing'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

/** The host that owns a link's source document, for the local-open guard. */
export function getLinkSourceLocalOpenOwner(
  state: WorktreeRuntimeOwnerState,
  sourceOwner: HttpLinkSourceOwner,
  worktreeId: string | null | undefined
): ExecutionHostId | 'unresolved' {
  switch (sourceOwner.kind) {
    case 'runtime':
      return toRuntimeExecutionHostId(sourceOwner.runtimeEnvironmentId)
    case 'ssh':
      return toSshExecutionHostId(sourceOwner.connectionId)
    case 'unknown':
      return 'unresolved'
    case 'local':
      // No connection can also mean runtime-owned; require catalog proof before opening the path locally.
      return worktreeId
        ? (getResolvedExecutionHostIdForWorktree(state, worktreeId) ?? 'unresolved')
        : 'local'
  }
}
