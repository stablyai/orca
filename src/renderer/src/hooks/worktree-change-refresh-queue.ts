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
  overflowedDefault: boolean
  overflowedLocal: boolean
}

export const WORKTREE_REFRESH_MAX_REPO_STATES = 1024
export const WORKTREE_REFRESH_MAX_QUEUED_PER_REPO = 4096
export const WORKTREE_REFRESH_MAX_QUEUED_TOTAL = 16_384

export type WorktreeChangeRefreshQueue = {
  dispose: () => void
  enqueue: (event: WorktreeChangeEvent) => void
}

export function createWorktreeChangeRefreshQueue(
  handler: WorktreeChangeRefreshHandler,
  options?: {
    maxRepoStates?: number
    maxQueuedPerRepo?: number
    maxQueuedTotal?: number
  }
): WorktreeChangeRefreshQueue {
  const states = new Map<string, RepoRefreshState>()
  const maxRepoStates = options?.maxRepoStates ?? WORKTREE_REFRESH_MAX_REPO_STATES
  const maxQueuedPerRepo = options?.maxQueuedPerRepo ?? WORKTREE_REFRESH_MAX_QUEUED_PER_REPO
  const maxQueuedTotal = options?.maxQueuedTotal ?? WORKTREE_REFRESH_MAX_QUEUED_TOTAL
  let queuedCount = 0
  let disposed = false

  const drain = async (repoId: string, state: RepoRefreshState): Promise<void> => {
    state.running = true
    try {
      while (
        !disposed &&
        (state.queue.length > 0 || state.overflowedDefault || state.overflowedLocal)
      ) {
        const next = state.queue.shift()
        let overflowForceLocalOwner: boolean | undefined
        if (next) {
          queuedCount = Math.max(0, queuedCount - 1)
        } else if (state.overflowedDefault) {
          state.overflowedDefault = false
        } else {
          state.overflowedLocal = false
          overflowForceLocalOwner = true
        }
        try {
          // Why: one full refresh per owner route converges changes shed during extreme bursts.
          await handler(repoId, next?.renamed, {
            forceLocalOwner: next?.forceLocalOwner ?? overflowForceLocalOwner
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
      queuedCount = 0
    },

    enqueue(event) {
      if (disposed) {
        return
      }
      let state = states.get(event.repoId)
      if (!state) {
        if (states.size >= maxRepoStates) {
          return
        }
        state = {
          running: false,
          queue: [],
          overflowedDefault: false,
          overflowedLocal: false
        }
        states.set(event.repoId, state)
      }

      if (state.queue.length >= maxQueuedPerRepo || queuedCount >= maxQueuedTotal) {
        if (event.forceLocalOwner) {
          state.overflowedLocal = true
        } else {
          state.overflowedDefault = true
        }
        if (!state.running) {
          void drain(event.repoId, state)
        }
        return
      }

      if (event.renamed) {
        state.queue.push({ renamed: event.renamed, forceLocalOwner: event.forceLocalOwner })
        queuedCount += 1
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
          queuedCount += 1
        }
      }

      if (!state.running) {
        void drain(event.repoId, state)
      }
    }
  }
}
