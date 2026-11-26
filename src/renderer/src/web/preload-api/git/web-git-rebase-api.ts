import type { ContinueRebaseResult } from '../../../../../shared/git/status/git-status-types'
import type { PreloadApi } from '../../../../../preload/api-types'
import { callRuntimeResult } from '../../runtime/client/web-runtime-calls'
import { toRuntimeWorktreeSelector } from '../../../runtime/rpc/targets/runtime-worktree-selector'
import { resolveRuntimeWorktreeByPath } from '../workspaces/web-runtime-worktree-catalog'

export function createWebGitRebaseApi(): Pick<
  PreloadApi['git'],
  'abortRebase' | 'continueRebase' | 'rebaseAutoStash'
> {
  return {
    abortRebase: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.abortRebase', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    continueRebase: async ({ worktreePath, action, expected }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      // Same budget as the desktop runtime client: one step can run hooks and rewrite many commits.
      return callRuntimeResult<ContinueRebaseResult>(
        'git.continueRebase',
        {
          worktree: toRuntimeWorktreeSelector(worktree.id),
          action,
          ...(expected ? { expected } : {})
        },
        120_000
      )
    },
    rebaseAutoStash: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      const result = await callRuntimeResult<{ autoStash: boolean }>('git.rebaseAutoStash', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
      return result.autoStash
    }
  }
}
