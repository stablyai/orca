import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
export function createMarkWorktreesDeleting(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['markWorktreesDeleting'] {
  return (worktreeIds) => {
    if (worktreeIds.length === 0) {
      return
    }
    set((s) => {
      const nextDeleteState = { ...s.deleteStateByWorktreeId }
      let changed = false
      for (const worktreeId of new Set(worktreeIds)) {
        const current = nextDeleteState[worktreeId]
        // Phase-aware: a queued row must still be promoted to deleting.
        if (
          current?.isDeleting &&
          current.phase === 'deleting' &&
          current.error === null &&
          !current.canForceDelete
        ) {
          continue
        }
        nextDeleteState[worktreeId] = {
          isDeleting: true,
          phase: 'deleting',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
        changed = true
      }
      return changed ? { deleteStateByWorktreeId: nextDeleteState } : {}
    })
  }
}

export function createMarkWorktreesQueuedForDeletion(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['markWorktreesQueuedForDeletion'] {
  return (worktreeIds) => {
    if (worktreeIds.length === 0) {
      return
    }
    set((s) => {
      const nextDeleteState = { ...s.deleteStateByWorktreeId }
      let changed = false
      for (const worktreeId of new Set(worktreeIds)) {
        const current = nextDeleteState[worktreeId]
        if (current?.isDeleting && current.error === null && !current.canForceDelete) {
          continue
        }
        nextDeleteState[worktreeId] = {
          isDeleting: true,
          phase: 'queued',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
        changed = true
      }
      return changed ? { deleteStateByWorktreeId: nextDeleteState } : {}
    })
  }
}

export function createClearWorktreeDeleteState(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['clearWorktreeDeleteState'] {
  return (worktreeId) => {
    set((s) => {
      if (!s.deleteStateByWorktreeId[worktreeId]) {
        return {}
      }
      const next = { ...s.deleteStateByWorktreeId }
      delete next[worktreeId]
      return { deleteStateByWorktreeId: next }
    })
  }
}
