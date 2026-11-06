import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import type { WorktreeActivationOptions } from './worktree-activation-surface-selection'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import { resolveProjectPreferenceKey } from '../../../shared/project-preference-identity'
import { writePersonalProjectPreference } from '@/runtime/personal-project-order-client'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'

export function capturePersonalProjectOpening(
  state: AppState,
  repoId: string,
  worktreeId: string,
  options?: Pick<WorktreeActivationOptions, 'executionHostId' | 'navigationIntent'>
): ((activated: boolean, acknowledgement: Promise<boolean>) => void) | null {
  if (options?.navigationIntent !== 'user-open') {
    return null
  }
  const { setups } = getProjectHostSetupProjectionFromState(state)
  const projectKey = resolveProjectPreferenceKey(repoId, setups, options.executionHostId)
  const previousProjectKey = state.activeRepoId
    ? resolveProjectPreferenceKey(
        state.activeRepoId,
        setups,
        state.activeWorkspaceExecutionHostId ??
          getResolvedExecutionHostIdForWorktree(state, state.activeWorktreeId)
      )
    : null
  if (!projectKey || projectKey === previousProjectKey) {
    return null
  }
  return (activated, acknowledgement) => {
    if (!activated || useAppStore.getState().activeWorktreeId !== worktreeId) {
      return
    }
    void acknowledgement
      .then((accepted) =>
        accepted
          ? writePersonalProjectPreference('ui.recordProjectOpen', {
              projectKey,
              previousProjectKey
            })
          : undefined
      )
      .catch(console.error)
  }
}
