import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { authorityKey } from '../../../../../shared/execution-host/host-authority'
import { resolveOwner } from './resolve-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

/**
 * The one host this app's records name as the workspace's owner, for a tab saved before tabs carried
 * a host. A twin the user selected and the routing default are not ownership evidence: null instead.
 */
export function recordedWorkspaceOwner(
  state: WorktreeRuntimeOwnerState,
  workspaceId: string
): ExecutionHostId | null {
  const owner = resolveOwner(
    {
      ...state,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      restoredRuntimeHostIdByWorkspaceSessionKey: undefined
    },
    { workspaceId }
  )
  return owner.kind === 'resolved'
    ? (parseExecutionHostId(authorityKey(owner.owner))?.id ?? null)
    : null
}

/** Whether the workspace's chats saved without a host are this app's; asked at most once. */
export function hostlessChatsAreLocal(
  state: WorktreeRuntimeOwnerState,
  workspaceId: string
): () => boolean {
  let local: boolean | undefined
  return () => (local ??= recordedWorkspaceOwner(state, workspaceId) === LOCAL_EXECUTION_HOST_ID)
}
