import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { PRGroupKey } from '../../../../../../shared/workspace-view/workspace-pr-groups'
import type { SidebarPRGroupReader } from '../../../../../../shared/sidebar-list/row-types'
import {
  prGroupOfReviewFact,
  readWorkspaceReviewFact,
  type PRCacheView
} from '../../../../../../shared/sidebar-list/workspace-review-facts'

export function getPRGroupKey(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: PRCacheView | null
): PRGroupKey {
  return prGroupOfReviewFact(
    prCache ? readWorkspaceReviewFact(worktree, repoMap.get(worktree.repoId), prCache) : null
  )
}

/** The PR lane reader the shared builder takes, bound to the window's PR cache. */
export function createSidebarPRGroupReader(
  repoMap: Map<string, Repo>,
  prCache: PRCacheView | null
): SidebarPRGroupReader {
  return (worktree) => getPRGroupKey(worktree, repoMap, prCache)
}
