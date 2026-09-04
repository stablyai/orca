import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { normalizeWorkspaceColorTag } from '../../../../../../shared/workspace-color-tag'
import type { WorktreeSlice } from '../../worktree-helpers'
import { applyWorktreeUpdates, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById,
  findPinnedWorktreeRow,
  type WorktreeMetaRowPin
} from '../listing/detected-worktree-meta'

type FailedPersistRecoveryArgs = {
  get: WorktreeSliceGet
  set: WorktreeSliceSet
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
  enriched: Partial<WorktreeMeta>
  /** The row's color immediately before the optimistic apply. */
  priorColorTag: string | null
  pin: WorktreeMetaRowPin | undefined
  recoveryFetchOptions: Parameters<WorktreeSlice['fetchWorktrees']>[1]
}

/**
 * Recovery after a failed metadata write. Why await and roll back: a write that failed because its
 * host is away usually cannot refresh either, and fetchWorktrees then just returns false. Left
 * alone, the optimistic color would stay on the card after the picker has already reported the
 * failure. Scoped to colorTag: it is the field this path exists for; other fields keep their
 * existing semantics.
 */
export function createFailedPersistRecovery(args: FailedPersistRecoveryArgs): () => Promise<void> {
  return async () => {
    const recovery = args
      .get()
      .fetchWorktrees(getRepoIdFromWorktreeId(args.worktreeId), args.recoveryFetchOptions)
      .catch(() => false)
    // Why branch first: only a color write needs to know whether the refresh happened, because
    // only it rolls back locally. Every other field keeps its original background reconciliation
    // instead of waiting out a second remote-listing timeout before reporting its own failure.
    if (!('colorTag' in args.enriched)) {
      void recovery
      return
    }
    if (await recovery) {
      return
    }
    const optimistic = normalizeWorkspaceColorTag(args.enriched.colorTag)
    args.set((s) => {
      // Why check first: the row may have taken a newer color while this write was failing (another
      // assignment, or a peer's change that a refresh delivered). That color did not belong to this
      // write and must not be rolled back with it.
      const row =
        findPinnedWorktreeRow(s, args.worktreeId, args.executionHostId, args.pin) ??
        findKnownWorktreeById(s, args.worktreeId, args.executionHostId)
      if (!row || normalizeWorkspaceColorTag(row.colorTag) !== optimistic) {
        return {}
      }
      // Why the row's id: a rename can land while the write is failing, and the reducers match ids
      // exactly; rolling back under the id the write started with would then revert nothing.
      const rollbackId = row.id
      return {
        worktreesByRepo: applyWorktreeUpdates(
          s.worktreesByRepo,
          rollbackId,
          { colorTag: args.priorColorTag },
          args.executionHostId,
          args.pin?.identityKey,
          args.pin?.runtimeOwnerEnvironmentId
        ),
        detectedWorktreesByRepo: applyDetectedWorktreeUpdates(
          s.detectedWorktreesByRepo,
          rollbackId,
          { colorTag: args.priorColorTag },
          args.executionHostId,
          args.pin?.identityKey,
          args.pin?.runtimeOwnerEnvironmentId
        )
      }
    })
  }
}
