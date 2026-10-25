import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeSortOrderUpdate } from '../../../shared/worktree/sort-order-update'

type WorktreeRename = {
  oldWorktreeId: string
  newWorktreeId: string
}

type WorktreeChangeOwner = {
  forceLocalOwner?: boolean
  executionHostId?: ExecutionHostId
  sortOrderOnly?: boolean
  sortOrders?: WorktreeSortOrderUpdate[]
  // Connection the values were published on; a patch from another connection refetches instead.
  sortOrderFence?: string
}

type WorktreeChangeEvent = {
  repoId: string
  renamed?: WorktreeRename
  // Why: set on local worktrees:changed while a remote runtime is active, so the
  // refresh pins to the local host instead of dropping the event (see useIpcEvents).
  forceLocalOwner?: boolean
  executionHostId?: ExecutionHostId
  sortOrderOnly?: boolean
  sortOrders?: WorktreeSortOrderUpdate[]
  sortOrderFence?: string
}

type WorktreeChangeRefreshHandler = (
  repoId: string,
  renamed?: WorktreeRename,
  options?: WorktreeChangeOwner
) => Promise<void>

type QueuedWorktreeChange = WorktreeChangeOwner & { renamed?: WorktreeRename }

type RepoRefreshState = {
  running: boolean
  queue: QueuedWorktreeChange[]
}

export type WorktreeChangeRefreshQueue = {
  dispose: () => void
  enqueue: (event: WorktreeChangeEvent) => void
}

function mergeSortOrders(
  earlier: readonly WorktreeSortOrderUpdate[],
  later: readonly WorktreeSortOrderUpdate[]
): WorktreeSortOrderUpdate[] {
  const byId = new Map(earlier.map((entry) => [entry.worktreeId, entry]))
  for (const entry of later) {
    byId.set(entry.worktreeId, entry)
  }
  return [...byId.values()]
}

export function createWorktreeChangeRefreshQueue(
  handler: WorktreeChangeRefreshHandler
): WorktreeChangeRefreshQueue {
  const states = new Map<string, RepoRefreshState>()
  let disposed = false

  const drain = async (repoId: string, state: RepoRefreshState): Promise<void> => {
    state.running = true
    try {
      while (!disposed && state.queue.length > 0) {
        const next = state.queue.shift()
        try {
          await handler(repoId, next?.renamed, {
            forceLocalOwner: next?.forceLocalOwner,
            ...(next?.executionHostId ? { executionHostId: next.executionHostId } : {}),
            ...(next?.sortOrderOnly === true ? { sortOrderOnly: true } : {}),
            ...(next?.sortOrderOnly === true && next.sortOrders
              ? { sortOrders: next.sortOrders, sortOrderFence: next.sortOrderFence }
              : {})
          })
        } catch (error) {
          console.error('Failed to refresh changed worktrees:', error)
        }
      }
    } finally {
      state.running = false
      if (disposed || state.queue.length === 0) {
        states.delete(repoId)
      } else {
        void drain(repoId, state)
      }
    }
  }

  return {
    dispose() {
      disposed = true
      states.clear()
    },

    enqueue(event) {
      if (disposed) {
        return
      }
      let state = states.get(event.repoId)
      if (!state) {
        state = { running: false, queue: [] }
        states.set(event.repoId, state)
      }

      if (event.renamed) {
        state.queue.push({
          renamed: event.renamed,
          forceLocalOwner: event.forceLocalOwner,
          executionHostId: event.executionHostId
        })
      } else {
        const lastQueued = state.queue.at(-1)
        // Why: Windows/OneDrive can emit a burst for one checkout change. Keep a
        // trailing refresh, but do not fan out adjacent identical repo scans.
        // A differing forceLocalOwner is not identical — keep it as its own scan
        // so a local-pinned refresh is never coalesced into a runtime-routed one.
        if (
          !lastQueued ||
          lastQueued.renamed !== undefined ||
          Boolean(lastQueued.forceLocalOwner) !== Boolean(event.forceLocalOwner) ||
          lastQueued.executionHostId !== event.executionHostId
        ) {
          state.queue.push({
            forceLocalOwner: event.forceLocalOwner,
            executionHostId: event.executionHostId,
            ...(event.sortOrderOnly === true ? { sortOrderOnly: true } : {}),
            ...(event.sortOrderOnly === true && event.sortOrders
              ? { sortOrders: event.sortOrders, sortOrderFence: event.sortOrderFence }
              : {})
          })
        } else if (event.sortOrderOnly !== true) {
          // An order save cannot erase an adjacent structural refresh.
          delete lastQueued.sortOrderOnly
          delete lastQueued.sortOrders
          delete lastQueued.sortOrderFence
        } else if (lastQueued.sortOrders) {
          if (event.sortOrders && event.sortOrderFence === lastQueued.sortOrderFence) {
            lastQueued.sortOrders = mergeSortOrders(lastQueued.sortOrders, event.sortOrders)
          } else {
            // Values missing or from another connection: the refetch reads current ones.
            delete lastQueued.sortOrders
            delete lastQueued.sortOrderFence
          }
        }
      }

      if (!state.running) {
        void drain(event.repoId, state)
      }
    }
  }
}
