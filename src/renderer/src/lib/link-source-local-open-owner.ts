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
      // Why: a runtime workspace without a nested SSH target also reports no connection, so only
      // the catalog row proves the document is on this computer.
      return worktreeId
        ? (getResolvedExecutionHostIdForWorktree(state, worktreeId) ?? 'unresolved')
        : 'local'
  }
}
