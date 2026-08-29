import type { Repo } from '../../../../shared/repo-types'
import { getDefaultProjectsCloneParent } from '../../../../shared/clone-destination'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'

// File cleanup is offered only for repos Orca itself cloned locally into the
// default clone parent; the main process re-checks the same rules before
// trashing anything, this is purely which menu item to show.
export function isClonedRepoCleanupEligible(
  repo: Repo,
  workspaceDir: string | null | undefined
): boolean {
  if (repo.projectHostSetupMethod !== 'cloned') {
    return false
  }
  if (repo.connectionId != null || (repo.executionHostId && repo.executionHostId !== 'local')) {
    return false
  }
  const cloneParent = getDefaultProjectsCloneParent(workspaceDir ?? '')
  if (!cloneParent) {
    return false
  }
  return relativePathInsideRoot(cloneParent, repo.path) !== null
}
