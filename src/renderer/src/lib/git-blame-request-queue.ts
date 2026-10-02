import type { GitBlameResult } from '../../../shared/git-blame'

const MAX_CONCURRENT_BLAME_REQUESTS = 2

type QueuedBlameRequest = {
  run: () => Promise<GitBlameResult>
  resolve: (result: GitBlameResult | null) => void
  reject: (error: unknown) => void
}

const pending: QueuedBlameRequest[] = []
let active = 0

function pump(): void {
  while (active < MAX_CONCURRENT_BLAME_REQUESTS) {
    // Why: FIFO so a still-mounted pane can't starve; panes scrolled past cancel their queued request on unmount.
    const next = pending.shift()
    if (!next) {
      return
    }
    active += 1
    next
      .run()
      .then(next.resolve, next.reject)
      .finally(() => {
        active -= 1
        pump()
      })
  }
}

// Why: whole-file blame is heavy git work; bound how many run at once so many mounted diff panes cannot pile them up.
export function enqueueGitBlameRequest(run: () => Promise<GitBlameResult>): {
  promise: Promise<GitBlameResult | null>
  cancel: () => void
  promote: () => void
} {
  let request!: QueuedBlameRequest
  const promise = new Promise<GitBlameResult | null>((resolve, reject) => {
    request = { run, resolve, reject }
  })
  pending.push(request)
  pump()
  return {
    promise,
    // Why: only a request that has not started can be dropped; a running git command is not abortable here.
    cancel: () => {
      const index = pending.indexOf(request)
      if (index !== -1) {
        pending.splice(index, 1)
        request.resolve(null)
      }
    },
    // Why: the pane the user focuses should not wait behind other mounted panes; no-op once started.
    promote: () => {
      const index = pending.indexOf(request)
      if (index > 0) {
        pending.splice(index, 1)
        pending.unshift(request)
      }
    }
  }
}
