import type { PreloadApi } from '../../../../preload/api-types'
import { callRuntimeResult } from './web-runtime-calls'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'

export function createGitCommitActionsApi(): Pick<PreloadApi['git'], 'cherryPick' | 'revert'> {
  return {
    cherryPick: async ({ worktreePath, commitId }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.cherryPick', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        commitId
      })
    },
    revert: async ({ worktreePath, commitId }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.revert', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        commitId
      })
    }
  }
}
