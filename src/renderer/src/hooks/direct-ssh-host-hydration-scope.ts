import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { resolveDirectSshTargetScope } from '../lib/direct-ssh-target-scope'
import type { AppState } from '../store/types'

export function directSshHostHydrationScope(
  state: AppState,
  authority: DirectSshAuthority,
  catalogRevision: number
) {
  return resolveDirectSshTargetScope({
    targetId: authority.targetId,
    catalogRevision,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  })
}
