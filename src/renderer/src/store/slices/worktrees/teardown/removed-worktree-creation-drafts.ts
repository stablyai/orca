import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { worktreeIdentityKey } from '../../../../../../shared/worktree/id'
import type { AppState } from '../../../types'
import type { WorktreePurgeTarget } from './worktree-purge-target'
import { omitRecordKeys } from './record-key-omission'

type CreationState = Pick<AppState, 'pendingWorktreeCreations' | 'activePendingCreationId'>

export function pruneRemovedWorktreeCreationDrafts(
  state: CreationState,
  targets: readonly WorktreePurgeTarget[]
): Partial<CreationState> {
  const entries = Object.values(state.pendingWorktreeCreations ?? {})
  if (entries.length === 0) {
    return {}
  }
  const removedIds = new Set<string>()
  const removedHostKeys = new Set<string>()
  for (const { id, hostId } of targets) {
    const key = worktreeIdentityKey(id)
    if (hostId) {
      removedHostKeys.add(composeWorktreeHostIdentity(hostId, key))
    } else {
      removedIds.add(key)
    }
  }
  const removedCreations = new Set<string>()
  for (const entry of entries) {
    if (entry.startupDraftDeferred && entry.worktreeId !== undefined) {
      const id = worktreeIdentityKey(entry.worktreeId)
      const hostId =
        entry.request.executionHostId ??
        entry.request.workspaceRunContext?.hostId ??
        LOCAL_EXECUTION_HOST_ID
      if (removedIds.has(id) || removedHostKeys.has(composeWorktreeHostIdentity(hostId, id))) {
        removedCreations.add(entry.creationId)
      }
    }
  }
  if (!removedCreations.size) {
    return {}
  }
  return {
    pendingWorktreeCreations: omitRecordKeys(state.pendingWorktreeCreations, removedCreations),
    ...(state.activePendingCreationId && removedCreations.has(state.activePendingCreationId)
      ? { activePendingCreationId: null }
      : {})
  }
}
