import type { WorktreeSortOrderPatch } from '../../store/slices/worktrees/listing/worktree-sort-order-patch'

// Hosts publish one order event per repo; one window turns a burst into one store commit.
export const WORKTREE_SORT_ORDER_BATCH_WINDOW_MS = 32

export type WorktreeSortOrderBatchOutcome = 'applied' | 'refetch' | 'disposed'

type PendingPatch = WorktreeSortOrderPatch & {
  isCurrent: () => boolean
  resolve: (outcome: WorktreeSortOrderBatchOutcome) => void
}

export type WorktreeSortOrderPublicationBatch = {
  /** Resolves after the flush; 'refetch' means the values went stale and the caller must reread the repo. */
  submit: (
    patch: WorktreeSortOrderPatch & { isCurrent: () => boolean }
  ) => Promise<WorktreeSortOrderBatchOutcome>
  dispose: () => void
}

export function createWorktreeSortOrderPublicationBatch(
  apply: (patches: readonly WorktreeSortOrderPatch[]) => void,
  windowMs = WORKTREE_SORT_ORDER_BATCH_WINDOW_MS
): WorktreeSortOrderPublicationBatch {
  let pending: PendingPatch[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = (): void => {
    timer = null
    const batch = pending
    pending = []
    // Re-check at flush: a reconnect or listing change during the window invalidates the published values.
    const current = batch.filter((entry) => entry.isCurrent())
    try {
      if (current.length > 0) {
        apply(current)
      }
    } catch (error) {
      console.error('Failed to apply worktree order updates:', error)
      for (const entry of batch) {
        entry.resolve('refetch')
      }
      return
    }
    for (const entry of batch) {
      entry.resolve(current.includes(entry) ? 'applied' : 'refetch')
    }
  }

  return {
    submit(patch) {
      if (disposed) {
        return Promise.resolve('disposed')
      }
      return new Promise((resolve) => {
        pending.push({ ...patch, resolve })
        // Fixed from the first entry, so a steady stream cannot postpone the flush.
        timer ??= setTimeout(flush, windowMs)
      })
    },
    dispose() {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      const batch = pending
      pending = []
      for (const entry of batch) {
        entry.resolve('disposed')
      }
    }
  }
}
