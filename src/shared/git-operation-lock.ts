type GitOperationWaiter = {
  readonly priority: number
  readonly grant: () => void
}

/** Handed to the locked work: whether it holds the lane, and a way to outlive its own promise. */
export type GitOperationLease = {
  /** False when the bounded wait expired and the work runs without the lane. */
  readonly held: boolean
  /** Keeps the lane until `settled` settles too, e.g. a killed child that has not exited yet. */
  holdUntil(settled: Promise<unknown>): void
}

type GitOperationLane = {
  waiters: GitOperationWaiter[]
}

// A lane exists exactly while its lock is held; queued waiters are handed the lock directly.
const lanes = new Map<string, GitOperationLane>()

export type GitOperationLockOptions = {
  /** Higher runs first among queued waiters; equal priorities keep arrival order. */
  readonly priority?: number
  /** Stop waiting after this long and run without the lane; unset waits for as long as it takes. */
  readonly maxWaitMs?: number
}

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function enqueue(lane: GitOperationLane, waiter: GitOperationWaiter): void {
  const index = lane.waiters.findIndex((queued) => queued.priority < waiter.priority)
  if (index === -1) {
    lane.waiters.push(waiter)
  } else {
    lane.waiters.splice(index, 0, waiter)
  }
}

// Resolves true once the lane is held, or false when `maxWaitMs` expired first.
function acquire(
  key: string,
  signal: AbortSignal | undefined,
  priority: number,
  maxWaitMs: number | undefined
): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.reject(abortError())
  }
  const lane = lanes.get(key)
  if (!lane) {
    lanes.set(key, { waiters: [] })
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve, reject) => {
    let expiry: ReturnType<typeof setTimeout> | undefined
    const leave = (): void => {
      clearTimeout(expiry)
      signal?.removeEventListener('abort', onAbort)
      const index = lane.waiters.indexOf(waiter)
      if (index !== -1) {
        lane.waiters.splice(index, 1)
      }
    }
    const onAbort = (): void => {
      leave()
      reject(abortError())
    }
    const waiter: GitOperationWaiter = {
      priority,
      grant: () => {
        leave()
        resolve(true)
      }
    }
    enqueue(lane, waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (maxWaitMs !== undefined) {
      expiry = setTimeout(() => {
        leave()
        resolve(false)
      }, maxWaitMs)
    }
  })
}

function release(key: string): void {
  const lane = lanes.get(key)
  const next = lane?.waiters.shift()
  if (next) {
    next.grant()
    return
  }
  lanes.delete(key)
}

export async function runWithGitOperationLock<T>(
  key: string,
  signal: AbortSignal | undefined,
  run: (lease: GitOperationLease) => Promise<T>,
  options: GitOperationLockOptions = {}
): Promise<T> {
  const held = await acquire(key, signal, options.priority ?? 0, options.maxWaitMs)
  const holds: Promise<unknown>[] = []
  try {
    return await run({
      held,
      holdUntil: (settled) => {
        holds.push(settled)
      }
    })
  } finally {
    if (held) {
      if (holds.length === 0) {
        release(key)
      } else {
        void Promise.allSettled(holds).then(() => release(key))
      }
    }
  }
}

export function _gitOperationLockWaiterCountForTests(key: string): number {
  return lanes.get(key)?.waiters.length ?? 0
}

export function _gitOperationLockHeldForTests(key: string): boolean {
  return lanes.has(key)
}
