type GitOperationWaiter = {
  priority: boolean
  start: () => void
}

type GitOperationLane = {
  waiters: GitOperationWaiter[]
}

// A lane exists while its key is held; `waiters` are the callers queued behind the holder.
const lanes = new Map<string, GitOperationLane>()

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function enqueue(lane: GitOperationLane, waiter: GitOperationWaiter): void {
  if (!waiter.priority) {
    lane.waiters.push(waiter)
    return
  }
  // Priority callers go ahead of queued ordinary ones but stay FIFO among themselves.
  const firstOrdinary = lane.waiters.findIndex((queued) => !queued.priority)
  if (firstOrdinary === -1) {
    lane.waiters.push(waiter)
  } else {
    lane.waiters.splice(firstOrdinary, 0, waiter)
  }
}

async function acquire(
  key: string,
  signal: AbortSignal | undefined,
  priority: boolean
): Promise<void> {
  if (signal?.aborted) {
    throw abortError()
  }
  const lane = lanes.get(key)
  if (!lane) {
    lanes.set(key, { waiters: [] })
    return
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: GitOperationWaiter = {
      priority,
      start: () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
    }
    const onAbort = (): void => {
      const index = lane.waiters.indexOf(waiter)
      if (index !== -1) {
        lane.waiters.splice(index, 1)
      }
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    enqueue(lane, waiter)
  })
}

function release(key: string): void {
  const lane = lanes.get(key)
  const next = lane?.waiters.shift()
  if (next) {
    next.start()
  } else {
    lanes.delete(key)
  }
}

/**
 * Runs `run` while holding `key`. A `priority` caller (interactive git the user is waiting on)
 * is queued ahead of ordinary callers, but never interrupts the one already running.
 */
export async function runWithGitOperationLock<T>(
  key: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  options: { priority?: boolean } = {}
): Promise<T> {
  await acquire(key, signal, options.priority === true)
  try {
    return await run()
  } finally {
    release(key)
  }
}
