import type { GitCommitActionResult } from '../../../../shared/git/commands/git-commit-action'
import type { PreloadApi } from '../../../../preload/api-types'
import { callRuntimeResult } from './web-runtime-calls'
import { toRuntimeWorktreeSelector } from '../../runtime/rpc/targets/runtime-worktree-selector'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'

export function createGitCommitActionsApi(): Pick<
  PreloadApi['git'],
  'createBranch' | 'cherryPick' | 'revert' | 'sequencerAbort' | 'sequencerContinue'
> {
  return {
    createBranch: async ({ worktreePath, name, startPoint }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.createBranch', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        name,
        startPoint
      })
    },
    sequencerContinue: async ({ worktreePath, operation }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      const result = await callRuntimeResult<GitCommitActionResult | { ok: boolean }>(
        'git.sequencerContinue',
        {
          worktree: toRuntimeWorktreeSelector(worktree.id),
          operation
        }
      )
      return typeof result === 'object' && result !== null && 'outcome' in result
        ? result
        : undefined
    },
    sequencerAbort: async ({ worktreePath, operation }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.sequencerAbort', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        operation
      })
    },
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
