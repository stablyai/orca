import type { PreloadApi } from '../../../../preload/api-types'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'

type GitApi = NonNullable<Partial<PreloadApi>['git']>

/** Branch listing and switching, split out to keep `web-git-api` within its line budget. */
export function createGitBranchApi(): Pick<GitApi, 'localBranches' | 'checkout' | 'createBranch'> {
  return {
    localBranches: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.localBranches', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    checkout: async ({ worktreePath, branch }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.checkout', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        branch
      })
    },
    createBranch: async ({ worktreePath, branch }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.createBranch', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        branch
      })
    }
  }
}
