import type { PreloadApi } from '../../../../preload/api-types'
import { toRuntimeWorktreeSelector } from '../../runtime/rpc/targets/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'

export const webGitOperationStateApi: Pick<
  PreloadApi['git'],
  'mutationInFlight' | 'rebaseOperation' | 'conflictOperation'
> = {
  mutationInFlight: async ({ worktreePath }) => {
    const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
    return callRuntimeResult('git.mutationInFlight', {
      worktree: toRuntimeWorktreeSelector(worktree.id)
    })
  },
  rebaseOperation: async ({ worktreePath }) => {
    const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
    return callRuntimeResult('git.rebaseOperation', {
      worktree: toRuntimeWorktreeSelector(worktree.id)
    })
  },
  conflictOperation: async ({ worktreePath }) => {
    const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
    return callRuntimeResult('git.conflictOperation', {
      worktree: toRuntimeWorktreeSelector(worktree.id)
    })
  }
}
