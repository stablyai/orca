import { useAppStore } from '@/store'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

export function runProjectRemoval(target: {
  repoId: string
  displayName: string
  hostId?: ExecutionHostId
}): void {
  const state = useAppStore.getState()
  const repo = findRepoForHost(state.repos, target.repoId, {
    hostId: target.hostId,
    settings: state.settings
  })
  // VM recipes may destroy the environment and its files; always retain that warning.
  if (
    state.settings?.skipRemoveProjectConfirm &&
    repo &&
    !isRuntimeOwnedSshTargetId(repo.connectionId)
  ) {
    void state.removeProject(repo.id, {
      hostId: getRepoExecutionHostId(repo),
      errorFeedback: 'toast'
    })
    return
  }
  state.openModal('confirm-remove-folder', target)
}
