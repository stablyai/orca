import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { isTwinRepo, runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'
import { projectViewCacheKeyTarget } from '@/store/github/cache-identity'
import type { GitHubWorkItemProjectOrigin } from './github-work-item-identity'

// Route Project edits to the row’s repository; callers throw on failed IPC results for optimistic rollback.
export function getGitHubMutationTarget(
  repoId: string | null | undefined,
  projectOrigin: GitHubWorkItemProjectOrigin | undefined
): RuntimeClientTarget {
  // Why: even slug-addressed project-origin mutations must run on the backing repo's owner host when its id is known.
  const state = useAppStore.getState()
  const owner = runtimeTargetForRepoOwner(state, repoId)
  if (owner) {
    return owner
  }
  // Why: a twin is tracked on two hosts; only the row's own source may stand in for its owner.
  if (isTwinRepo(state, repoId) && !projectOrigin) {
    throw new Error(`No single host owns project ${repoId}.`)
  }
  // Untracked Project rows use their source host; other slug edits use local credentials, never the focused server.
  return projectOrigin ? projectViewCacheKeyTarget(projectOrigin.cacheKey) : { kind: 'local' }
}
