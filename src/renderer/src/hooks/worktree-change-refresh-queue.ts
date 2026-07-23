type WorktreeRename = {
  oldWorktreeId: string
  newWorktreeId: string
}

type WorktreeChangeEvent = {
  repoId: string
  renamed?: WorktreeRename
  // Why: set on local worktrees:changed while a remote runtime is active, so the
  // refresh pins to the local host instead of dropping the event (see useIpcEvents).
  forceLocalOwner?: boolean
}

type WorktreeChangeRefreshHandler = (
  repoId: string,
  renamed?: WorktreeRename,
  options?: { forceLocalOwner?: boolean }
) => Promise<void>

type QueuedWorktreeChange = {
  renamed?: WorktreeRename
  forceLocalOwner?: boolean
}

type RepoRefreshState = {
  running: boolean
  queue: QueuedWorktreeChange[]
}

export type WorktreeChangeRefreshQueue = {
  dispose: () => void
  enqueue: (event: WorktreeChangeEvent) => void
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
          await handler(repoId, next?.renamed, { forceLocalOwner: next?.forceLocalOwner })
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
        state.queue.push({ renamed: event.renamed, forceLocalOwner: event.forceLocalOwner })
      } else {
        const lastQueued = state.queue.at(-1)
        // Why: Windows/OneDrive can emit a burst for one checkout change. Keep a
        // trailing refresh, but do not fan out adjacent identical repo scans.
        // A differing forceLocalOwner is not identical — keep it as its own scan
        // so a local-pinned refresh is never coalesced into a runtime-routed one.
        if (
          !lastQueued ||
          lastQueued.renamed !== undefined ||
          Boolean(lastQueued.forceLocalOwner) !== Boolean(event.forceLocalOwner)
        ) {
          state.queue.push({ forceLocalOwner: event.forceLocalOwner })
        }
      }

      if (!state.running) {
        void drain(event.repoId, state)
      }
    }
  }
}
