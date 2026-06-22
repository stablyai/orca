type WorktreeRename = {
  oldWorktreeId: string
  newWorktreeId: string
}

type WorktreeChangeEvent = {
  repoId: string
  renamed?: WorktreeRename
}

type WorktreeChangeRefreshHandler = (repoId: string, renamed?: WorktreeRename) => Promise<void>

type QueuedWorktreeChange = {
  renamed?: WorktreeRename
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
          await handler(repoId, next?.renamed)
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
        state.queue.push({ renamed: event.renamed })
      } else {
        const lastQueued = state.queue.at(-1)
        // Why: Windows/OneDrive can emit a burst for one checkout change. Keep a
        // trailing refresh, but do not fan out adjacent identical repo scans.
        if (!lastQueued || lastQueued.renamed !== undefined) {
          state.queue.push({})
        }
      }

      if (!state.running) {
        void drain(event.repoId, state)
      }
    }
  }
}
