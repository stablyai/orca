import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { applyWorktreeUpdates, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { applyDetectedWorktreeUpdates } from '../listing/detected-worktree-meta'
import { persistWorktreeMeta } from './worktree-meta-persist'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'
import { settingsForWorktreeOwner } from '../listing/worktree-owner-settings'

export function createUpdateWorktreesMeta(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreesMeta'] {
  return async (updatesByWorktreeId) => {
    if (updatesByWorktreeId.size === 0) {
      return
    }

    set((s) => {
      let nextWorktrees = s.worktreesByRepo
      let nextDetectedWorktrees = s.detectedWorktreesByRepo
      for (const [worktreeId, updates] of updatesByWorktreeId) {
        nextWorktrees = applyWorktreeUpdates(nextWorktrees, worktreeId, updates)
        nextDetectedWorktrees = applyDetectedWorktreeUpdates(
          nextDetectedWorktrees,
          worktreeId,
          updates
        )
      }
      return nextWorktrees === s.worktreesByRepo &&
        nextDetectedWorktrees === s.detectedWorktreesByRepo
        ? {}
        : {
            ...(nextWorktrees !== s.worktreesByRepo
              ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
              : {}),
            ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
              ? { detectedWorktreesByRepo: nextDetectedWorktrees }
              : {})
          }
    })

    await Promise.all(
      Array.from(updatesByWorktreeId, async ([worktreeId, updates]) => {
        try {
          await persistWorktreeMeta(
            settingsForWorktreeOwner(get(), worktreeId),
            worktreeId,
            updates
          )
        } catch (err) {
          if (isRuntimeSelectorNotFoundError(err)) {
            void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
            return
          }
          console.error('Failed to update worktree meta:', err)
          void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        }
      })
    )
  }
}
