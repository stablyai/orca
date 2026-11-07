import type { PreloadApi } from '../../../../preload/api-types'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'
import { callRuntimeResult } from './web-runtime-calls'

export function createGitHistoryApi(): Pick<PreloadApi['git'], 'history' | 'refs'> {
  return {
    refs: async ({ worktreePath, query }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.refs', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        query
      })
    },
    history: async ({ worktreePath, limit, baseRef, branchOnly, skip, refs, historyToken }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.history', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        limit,
        baseRef,
        branchOnly,
        refs,
        historyToken,
        skip
      })
    }
  }
}
