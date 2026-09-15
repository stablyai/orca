import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'

export function showBlockedWorktreeDelete(
  target: Pick<Worktree, 'id' | 'hostId' | 'displayName'>,
  cyclic = false
): void {
  const error = cyclic
    ? translate(
        'worktree.delete.conflictingDependencies',
        'Not deleted because workspace nesting conflicts with folder containment. Unnest these workspaces and retry.'
      )
    : translate(
        'worktree.delete.blockedByChild',
        'Not deleted because a child workspace changed or could not be deleted.'
      )
  const key = target.hostId ? getWorktreeHostIdentity(target) : target.id
  useAppStore.setState((state) => ({
    deleteStateByWorktreeId: {
      ...state.deleteStateByWorktreeId,
      [key]: {
        isDeleting: false,
        error,
        canForceDelete: false,
        forceDeleteReason: null,
        ...(target.hostId ? { executionHostId: target.hostId } : {})
      }
    }
  }))
  showDeleteWorktreeFailureToast({
    error,
    canForceDelete: false,
    forceDeleteReason: null,
    worktreeId: target.id,
    identityKey: key,
    worktreeName: target.displayName,
    showViewChanges: false,
    canWaiveArchiveHook: false,
    onDeleteAnyway: () => {},
    onViewChanges: () => {},
    onForceDelete: () => {}
  })
}

export function clearWorktreeDeleteTargetState(target: Pick<Worktree, 'id' | 'hostId'>): void {
  const state = useAppStore.getState()
  if (target.hostId) {
    state.clearWorktreeDeleteState(target.id, target.hostId)
  } else {
    state.clearWorktreeDeleteState(target.id)
  }
}
