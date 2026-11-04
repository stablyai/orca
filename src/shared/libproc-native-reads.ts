import {
  DEADLINE_PASSED,
  createSettleNotifier,
  monotonicNow,
  type Settled
} from './deadline-settle-notifier'
import type { LibprocAddon, LibprocProcessRow, LibprocQuery } from './libproc-addon'

type NativeRead = {
  /** Creation order; once submitted, a read serves only callers registered before it was created. */
  sequence: number
  /** Submission waits a microtask so callers registered in the same turn share one worker. */
  readonly submitted: boolean
  wait: (deadline: number) => Promise<Settled<LibprocProcessRow[] | null> | typeof DEADLINE_PASSED>
}

// Identical fresh reads share one worker; each caller still races its own deadline, so a stalled pool times them all out.
const sharedReads = new Map<string, NativeRead>()
let nextSequence = 0
let outstandingReads = 0
// Workers queued behind a saturated libuv pool would otherwise pile up one per poll.
const MAX_OUTSTANDING_READS = 8
const slotWaiters = new Set<() => void>()
// A pool pinned at the cap past a caller's whole deadline is stalled: hand callers back to ps for a while.
const STALLED_POOL_COOL_DOWN_MS = 30_000
let unhealthyUntil = Number.NEGATIVE_INFINITY
// Set when the cap outlived a caller's deadline; cleared once any read settles.
let poolStalled = false

export function isNativeReaderHealthy(): boolean {
  return monotonicNow() >= unhealthyUntil
}

/** Register a request: only reads submitted from now on may serve it, so an earlier poll's abandoned read
 * (whose exited pids may since be reused, and which teardown would signal) never does. Clock-free. */
export function registerNativeRequest(): number {
  return nextSequence
}

function submitRead(addon: LibprocAddon, query: LibprocQuery, key: string): NativeRead {
  const submission = { submitted: false }
  const pending = new Promise<LibprocProcessRow[] | null>((resolve, reject) => {
    queueMicrotask(() => {
      submission.submitted = true
      try {
        addon.readProcessTable(query).then(resolve, reject)
      } catch (error) {
        reject(error)
      }
    })
  })
  const read: NativeRead = {
    sequence: nextSequence++,
    get submitted() {
      return submission.submitted
    },
    wait: createSettleNotifier(pending)
  }
  outstandingReads += 1
  sharedReads.set(key, read)
  const release = (): void => {
    outstandingReads -= 1
    poolStalled = false
    if (sharedReads.get(key) === read) {
      sharedReads.delete(key)
    }
    for (const waiter of slotWaiters) {
      waiter()
    }
    slotWaiters.clear()
  }
  pending.then(release, release)
  return read
}

function waitForSlot(deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const waiter = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    slotWaiters.add(waiter)
    const timer = setTimeout(
      () => {
        slotWaiters.delete(waiter)
        resolve(false)
      },
      Math.max(0, deadline - monotonicNow())
    )
  })
}

/** Rows from a read submitted after `registeredSequence` (null: -t named no terminal); 'stalled' sends the caller to ps. */
export async function readFreshNativeTable(
  addon: LibprocAddon,
  query: LibprocQuery,
  registeredSequence: number,
  deadline: number
): Promise<LibprocProcessRow[] | null | typeof DEADLINE_PASSED | 'stalled'> {
  const key = JSON.stringify(query)
  for (;;) {
    const shared = sharedReads.get(key)
    let read: NativeRead
    if (shared && (!shared.submitted || shared.sequence >= registeredSequence)) {
      read = shared
    } else if (outstandingReads < MAX_OUTSTANDING_READS) {
      read = submitRead(addon, query, key)
    } else if (poolStalled) {
      // Cool-down over but the stalled reads still hold the cap: no caller should wait its timeout to learn that.
      unhealthyUntil = monotonicNow() + STALLED_POOL_COOL_DOWN_MS
      return 'stalled'
    } else {
      // Queue behind the cap (a startup-restore burst) instead of bursting ps.
      if (!(await waitForSlot(deadline))) {
        if (outstandingReads >= MAX_OUTSTANDING_READS) {
          poolStalled = true
          unhealthyUntil = monotonicNow() + STALLED_POOL_COOL_DOWN_MS
          console.warn('[process-table] libuv pool stalled; using ps for 30s')
          return 'stalled'
        }
        return DEADLINE_PASSED
      }
      continue
    }
    const settled = await read.wait(deadline)
    if (settled === DEADLINE_PASSED) {
      return DEADLINE_PASSED
    }
    if (!settled.ok) {
      throw settled.error
    }
    return settled.value
  }
}

export function nativeReadWaitersForTests(): number {
  return slotWaiters.size
}

export function resetNativeReadsForTests(): void {
  sharedReads.clear()
  slotWaiters.clear()
  outstandingReads = 0
  poolStalled = false
  unhealthyUntil = Number.NEGATIVE_INFINITY
}
