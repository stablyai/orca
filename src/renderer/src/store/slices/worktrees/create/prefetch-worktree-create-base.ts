import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import { runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'

export function createPrefetchWorktreeCreateBase(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['prefetchWorktreeCreateBase'] {
  return async (repoId, baseBranch) => {
    try {
      const target = runtimeTargetForRepoOwner(get(), repoId)
      if (!target) {
        return
      }
      if (target.kind === 'local') {
        await window.api.worktrees.prefetchCreateBase({
          repoId,
          ...(baseBranch ? { baseBranch } : {})
        })
        return
      }
      await callRuntimeRpc(
        target,
        'worktree.prefetchCreateBase',
        { repo: repoId, ...(baseBranch ? { baseBranch } : {}) },
        { timeoutMs: 30_000 }
      )
    } catch {
      // Why: prefetch is only a latency hedge; the create path awaits the same refresh and owns error reporting.
    }
  }
}
